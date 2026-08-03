Verdict: fix first — not safe to commit.

## Blocker

None found beyond the major contract/concurrency defects below. The byte-level newline arithmetic, partial-line hold, rewind-to-boundary calculation, and production transaction placement are internally coherent on the normal append-only path.

## Major findings

### 1. Occupied-promptId conversion is still the pre-amendment disposition

- **Spec:** `.scratch/arc-spine-redesign/spec.md:120` requires compact metadata tags after clearing, outgoing citation pruning with `cites_recorded=1`, and preservation of incoming edges.
- **Code:** `src/hooks/capture-repair.ts:154-205` clears `tags` to `NULL`, accepts only `(boundaryUuid, nowEpoch)` so it cannot rebuild the metadata tags, never deletes `turn_citations`, and never sets `cites_recorded=1`. The caller at `:268` invokes this path for the occupied ordinary turn.
- **Impact:** converted rows lose the `compact:pre_tokens=...` / `compact:trigger=...` rendering data. A pre-existing extracted row with `cites_recorded=1` keeps its outgoing edges, so phantom citations remain in settlement in-degree; a row with `0` is not converted to the authoritative-empty state.
- **Follow-up hazard:** pass boundary metadata only to the conversion branch; in the same outer transaction set the two tags, `cites_recorded=1`, and `DELETE ... WHERE citing_turn_id = ?`. Do not delete incoming rows (`cited_turn_id = ?`), which are provenance.
- **Test evidence:** `tests/hooks/capture-repairs.test.ts:315-361` asserts the obsolete `tags: []`, seeds `citesRecorded: true`, and never creates/asserts outgoing or incoming citation edges.

### 2. A converted marker can be mutated by the later Stop backfill

- **Code:** conversion deliberately preserves `user_prompt` (`src/hooks/capture-repair.ts:160-183`), but `src/hooks/backfill.ts:27-72` treats every turn with a non-null `userPrompt` and falsy `assistantResponse` as backfillable; it has no `type='compact'`/terminal exclusion. `src/hooks/handlers/stop.ts:134-145` passes all session turns into that function, and `src/db/turns.ts:585-600` writes `assistant_response`, `assistant_transcript`, and `tool_call_count`.
- **Impact:** an occupied ordinary turn converted to `type='compact'` can receive an empty/derived assistant response and tool count on the next Stop, violating the full-column conversion contract and “后续提取不覆盖 marker”. Inserted/adopted markers avoid this only because their `user_prompt` is normally NULL; the conversion branch preserves it by specification.
- **Fix direction:** make the backfill candidate predicate explicitly exclude compact markers (or add an equivalent immutable marker guard) while retaining the required preserved `user_prompt`.

### 3. The 400ms SessionEnd repair guard is not a 400ms work budget

- **Code:** `src/hooks/handlers/session-end.ts:96-107` passes `SESSION_END_REPAIR_BUDGET_MS` to `runHookWriteTransaction`, but `src/db/database.ts:141-165` checks that budget only after a `SQLITE_BUSY` failure, between retries. It does not time-limit the transaction body, the file scan, or the SQL loop. The hook database is configured with an 800ms busy timeout in `src/hooks/hook-command.ts:50,117`, and the production hook timeout is 2s in `plugin/hooks/hooks.json:48-56`.
- **Impact:** a busy SQLite call can already consume more than 400ms before the wrapper observes the error; 500 long JSONL lines plus the repair transaction and the subsequent orphan-finalization transaction can also exceed the 2s SessionEnd window. The best-effort repair can therefore starve the cleanup it is explicitly subordinate to.
- **Fix direction:** use a real deadline/deadline-aware scanner and transaction seam, or ensure the repair connection’s busy/read/write work cannot consume the reserved cleanup budget; test a blocked DB and an intentionally slow repair.

### 4. SessionEnd’s boolean snapshot does not fence a concurrent new turn

- **Code:** `src/hooks/handlers/session-end.ts:75-78` snapshots only `hasNewTurnSinceSessionRunStart`, then performs scan/repair, and at `:129-135` calls `getOrphanTurns` without a turn-id cutoff. `src/db/orphan-turns.ts:18-43` selects every active, response-less, unqueued turn in the session.
- **Impact:** if UserPromptSubmit commits a new active turn after the snapshot but before `getOrphanTurns`, SessionEnd can mark that still-live turn skipped. Conversely, if the snapshot is false just before a concurrent prompt commits, this SessionEnd does no orphan pass. The newly inserted repair work widens the race window compared with the old two-query path.
- **Fix direction:** snapshot a concrete maximum turn id/orphan id set under the same coordination boundary and finalize only that snapshot, or serialize SessionEnd against UserPromptSubmit for the session.

### 5. The persisted cursor update is not monotonic despite claiming to be

- **Code:** `src/db/sessions.ts:312-329` documents a monotonic guard but executes an unconditional `SET scan_cursor_byte_offset = ?, scan_cursor_line = ?`. `src/hooks/capture-repair.ts:569-574` writes the scan result, while `src/hooks/handlers/session-init.ts:90-98` and `src/hooks/handlers/session-end.ts:75-107` read/scan before their write transaction.
- **Impact:** concurrent UserPromptSubmit/SessionEnd calls can commit an older scan result after a newer one. UUID idempotence prevents duplicate markers, but the high-water mark regresses, causing repeated bounded scans and making line numbers dependent on stale file snapshots; this can turn the intended 10s/2s budgets into repeated work. The fork-safe `(session_id, uuid)` uniqueness at `src/db/schema.ts:553-567` is correct, but it does not protect the cursor.
- **Fix direction:** make cursor advancement a compare-and-set/max operation keyed to the observed cursor, with an explicit transactional rewind only for the pending-boundary case; add concurrent stale-writer coverage.

### 6. The incremental path no longer has the parser’s UUID-deduplication semantics

- **Code:** `src/shared/transcript-parser.ts:319-342` keeps the existing UUID merge behavior for `readAllTranscriptEntries`, but `src/hooks/transcript-scan.ts:169-171` feeds `parseTranscriptLineWindow` directly, which only parses physical lines (`src/shared/transcript-parser.ts:286-316`). `collectCompactBoundaryClaims` and `collectLinkCandidates` then consume the first raw occurrence (`src/hooks/capture-repair.ts:87-130,333-363`).
- **Impact:** replay-appended duplicate snapshots—an existing parser behavior covered at `tests/shared/transcript-parser.test.ts:557-664`—can make a boundary’s metadata stale/missing or anchor a link to the replay occurrence rather than the merged first line. The normal whole-file consumers remain equivalent (the full suite passes), but the new repair path is not equivalent on the same transcript shapes.
- **Fix direction:** apply bounded UUID merge state to the repair window, including a deliberate policy for duplicates crossing cursor windows, while preserving the first physical line number and latest payload fields.

### 7. UserPromptSubmit’s actual transcript work is still unbounded by the new 5MB/5000-line repair cap

- **Code:** `src/hooks/handlers/session-init.ts:73-83` still calls `readAllTranscriptEntries`, `computeInvalidationSets`, and `parseReplayTranscript` over the entire file before `src/hooks/handlers/session-init.ts:90-98` performs the incremental scan. The old full-file parser is preserved, but the new cap applies only to the second read.
- **Impact:** large transcripts still incur full-file I/O, parsing, replay construction, and invalidation work on every UserPromptSubmit, plus a second read. A 5MB repair cap therefore does not bound the hook’s real latency/memory within its 10s contract and can prevent the repair from being reached or committed.
- **Fix direction:** either explicitly budget the pre-existing full-file path separately or make the capture repair share a bounded parser/read result without weakening existing invalidation semantics.

### 8. The scanner deliberately breaks the stated 5MB upper bound for a long no-newline record

- **Code:** `src/hooks/transcript-scan.ts:114-125` initially reads at most `maxBytes`, then, when that buffer contains no newline, rereads `remaining` bytes in full. A single oversized or unterminated JSONL record can therefore allocate/read the entire tail.
- **Impact:** this can turn the stated 5MB bound into an unbounded read and defeat both UserPromptSubmit and SessionEnd latency protection. It also makes a malformed long tail an easy resource hazard.
- **Fix direction:** retain the cursor before the record and defer it, or use a separately bounded oversized-record policy with an explicit log; do not silently replace the cap with `remaining`.

## Minor findings

### 9. File replacement recovery detects shrinkage only, not same-size/larger rewrites

- **Code:** `src/hooks/transcript-scan.ts:97-103` restarts only when `cursor.byteOffset > fileSize`. A replacement with the same or larger size is treated as the old append-only file and scanning starts in the middle of the new bytes.
- **Impact:** if transcript replacement/rewriting is a supported crash-recovery case, malformed partial JSON can be skipped and later physical line numbers can be committed against the wrong file. The current shrink test (`tests/hooks/capture-repairs.test.ts:652-667`) does not cover this case. If transcripts are guaranteed append-only, document that assumption rather than implying general replacement recovery in the comment.

### 10. Link-only occupied-id logging is incomplete

- **Code:** `src/hooks/capture-repair.ts:481-508` checks `ownedPromptIds` only after finding a matching NULL-link turn. An occupied candidate with no matching NULL-link text is silently ignored, although §F:121 says occupied promptIds are skipped and logged.
- **Impact:** the DB remains safe, but diagnostics cannot account for every occupied candidate and the acceptance logging contract is incomplete.

### 11. The conversion test is not a current full-row/edge assertion

- **Code:** `tests/hooks/capture-repairs.test.ts:283-410` checks many scalar columns and the FTS deletion, but expects pre-amendment tags, does not seed outgoing/incoming citations, does not assert `cites_recorded` transitions from 0 to 1, and never runs a subsequent Stop against the converted row.
- **Required additions:** assert every preserve/set/clear column against the amended list, compact tags from boundary metadata, outgoing-edge deletion with incoming-edge preservation, authoritative-empty citation behavior, and post-conversion Stop immutability.

### 12. Cursor crash/concurrency and SessionEnd repair-throw paths have no adequate seam

- **Code:** the cursor tests at `tests/hooks/capture-repairs.test.ts:571-675` simulate a successful cursor reset, not a transaction failure between claim/link/cursor writes. The SessionEnd tests at `:728-835` cover normal repair and truncation but never force `runCaptureRepair` to throw; `SessionEndHandlerDependencies` at `src/hooks/handlers/session-end.ts:29-37` has no capture-runner injection.
- **Suggested seam:** inject `captureRepairRunner` (defaulting to `runCaptureRepair`) and use a transaction runner that throws after the repair body; assert rollback of claims/links/cursor, orphan cleanup still runs, the handler returns `continue: true`, and later re-entry repairs the same window. Add two concurrent stale-cursor writers, UTF-8/multibyte lines, exact 5MB/oversized records, and forked sessions sharing one transcript.

### 13. The PostCompact registration matrix is under-asserted

- **Code:** `plugin/hooks/hooks.json` correctly removes the registration, and `tests/hooks/capture-repairs.test.ts:838-856` checks the obsolete argv does not route. `tests/hooks/plugin-config.test.ts:5-25` asserts the SessionStart list but does not assert PostCompact absence, and `tests/hooks/claude-code-adapter.test.ts:5-15` does not assert that a PostCompact payload is rejected.
- **Impact:** a future config/adapter reintroduction could pass the current focused assertions despite the ticket’s “整体移除” requirement. This is test coverage only; the current source matrix itself is consistent.

## Clean checks

- Production claim → convert/adopt → link → cursor writes are inside the UserPromptSubmit outer transaction (`src/hooks/handlers/session-init.ts:100-159`) or the SessionEnd repair transaction (`src/hooks/handlers/session-end.ts:97-107`); a crash before commit should roll back all of them. The direct exported helper is intentionally caller-owned (`src/hooks/capture-repair.ts:543-548`), so the tests’ transaction-free `runCaptureRepair` calls do not prove that production invariant.
- Link-only updates use `COALESCE` on only `content_prompt_id` and `transcript_line_start` (`src/hooks/capture-repair.ts:420-428`); no byte-preservation defect was found on that path.
- The removed PostCompact handler/routing/type/config changes are consistent with the ticket, and existing consumers of the whole-file parser passed the full suite.

## Summary

- Conversion is not ready: current §F tag and citation rules are absent, and a converted row remains backfillable.
- SessionEnd’s repair guard is retry-budgeted rather than wall-clock bounded; its orphan gate races concurrent prompt creation.
- Cursor writes regress under concurrent hooks; the fork-scoped UUID uniqueness itself is correct.
- The incremental reader bypasses UUID merge semantics and can exceed the 5MB cap for a long record.
- Existing whole-file SessionInit work means the new repair cap does not cap actual hook work.
- Full suite: 1290 pass / 0 fail; typecheck and diff check pass, but the missing adversarial tests leave the above risks unclosed.
