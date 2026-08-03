Verdict: `ready-for-agent` is premature.

## Previous blocker resolution

| Rev-1 blocker | Status | Rev-2 verification |
|---|---|---|
| 1. Settlement has no executable or durable protocol | **Partially resolved** | §A now supplies session-local K/H, a cursor, tail settlement, batch writes, a run record, and timeline/recall access. It still does not define a durable job lifecycle, unique boundary key, cursor-advance transaction, or legal model output/write transport; current worker messages are only turn/session work and prohibit arbitrary revisits (`src/worker/query-session.ts:358-365`, `src/worker/query-session.ts:394-412`). |
| 2. `cites` has no storage, migration, or write contract | **Partially resolved** | §B chooses an edge table, relation vocabulary, validation, and an era fallback, but does not give the strict `cites` element shape, append-vs-replace semantics, explicit-empty provenance, or atomicity with the turn update/regrade. Current `remember` schema is strict (`src/mcp/definitions.ts:28-70`) and current writes are separate (`src/mcp/remember.ts:325-348`). |
| 3. `effGrade` and retention precedence are undefined | **Resolved** | §C:78-86 provides the requested truth table and ordered victim → corrector → always-keep → spine → pull-in → budget algorithm. Implementers must honor the parenthetical victim guard so step 2 does not undo step 1. |
| 4. Compact markers lack durable identity/collision policy | **Resolved** | §F:116-121 adds a persisted unique boundary UUID, transcript-order claiming, numbering, and transactional occupied-promptId conversion. The exact conversion mutation is a new major finding below. |
| 5. Companion ticket leaves the data model undecided | **Resolved** | Ticket Rev 2:8-18 locks immutable `sessions.transcript_path`, preserves latest-cwd `project`, defines NULL fallback and candidate handling, and names migration/reader tests. This is compatible with current latest-cwd upsert behavior (`src/db/sessions.ts:74-104`). |

Of the previous 18 majors, 11 are fully resolved and 7 remain partial; the material residuals are included below rather than treated as closed merely because Rev 2 mentions them.

## New findings

### 1. Blocker — settlement still has no crash-safe executable state machine

- **Spec section:** §A:55-60; Testing:130.
- **Code evidence:** The durable queue type only admits `obs | turn-stop | diary`, and only diary has a uniqueness constraint (`src/db/pending-queue.ts:5-20`; `src/db/schema.ts:106-122`). The drain routes every non-`obs` item as a turn-stop (`src/worker/server.ts:2535-2572`). The agent accepts only remember/recall and its message contract forbids revisiting arbitrary earlier records (`src/mcp/definitions.ts:72-75`; `src/worker/query-session.ts:340-365`). Rev 2 never defines a settlement job row/status, `UNIQUE(session,boundary)`, the settlement message/output schema, or whether `lastSettledBoundary` advances on enqueue or successful commit. Advancing on enqueue can lose failed work; advancing on completion permits duplicate jobs unless uniqueness is separate, and the claimed single transaction does not explicitly include the cursor.
- **Suggested resolution:** Specify a `settlement_jobs` lifecycle with a unique `(session_id,boundary)`, frozen input boundary, claim/retry states, an exact agent message/output or tool schema, and one success transaction that writes grades, derived backlinks, run summary, and cursor.

### 2. Major — settlement boundary and SessionEnd tail identity are ambiguous

- **Spec section:** §A:56-58; §F:120.
- **Code evidence:** A batch can finish several turns before cadence is checked; current server builds one ordinary batch from all mini-turns and passes only the latest prompt number (`src/worker/server.ts:1814-1863`). Rev 2 does not say whether a jump from 49 to 151 creates boundaries 50/100/150 or only 150, nor whether a delayed boundary-50 job reads turns 1-50 or the then-current trailing tail. It also does not say whether an exact-K SessionEnd or a repeated no-activity SessionEnd adds a distinct tail job. The current activity gate is “any new turn id since run start” (`src/db/session-run.ts:16-34`) while SessionEnd always requests a worker flush (`src/hooks/handlers/session-end.ts:56-80`).
- **Suggested resolution:** Enumerate every crossed K boundary, define each cohort as the terminal rows ending at that boundary, and enqueue a tail only when the pre-repair activity snapshot is true and terminal count exceeds the last successful boundary, using the same unique job identity.

### 3. Major — the cites-era predicate cannot represent explicit empty citations reliably

- **Spec section:** §B:67-71; Testing:131.
- **Code evidence:** Turns persist creation/update epochs but no citation-schema provenance (`src/db/schema.ts:39-73`). An active turn created before the deployment epoch may first be extracted after deployment (`src/mcp/remember.ts:282-337`); an explicit `cites: []` produces no edge and is indistinguishable from legacy absence, so a created-at-era predicate incorrectly re-enables inline fallback. Rev 2 never names which epoch column defines “era after.”
- **Suggested resolution:** Persist a per-turn `citations_recorded`/schema-version marker atomically with every post-migration remember, and use it—not creation time alone—to distinguish authoritative empty from legacy absent.

### 4. Major — `remember.cites` lacks an exact mutation and transaction contract

- **Spec section:** §B:67-73.
- **Code evidence:** The strict public schema has no `cites` shape (`src/mcp/definitions.ts:28-70`). A streamed turn must be remembered repeatedly and ordinary fields merge (`src/worker/query-session.ts:419-440`), but Rev 2 does not say whether later `cites` replaces, appends to, or can delete the prior edge set. Current turn update and nested regrade already occur as separate writes (`src/mcp/remember.ts:325-348`), so failure between turn and edges can publish inconsistent causal state.
- **Suggested resolution:** Lock `cites` to a strict element schema such as `{id, relation}`, define omitted/present-empty/present-nonempty semantics for resends and slices, and transact the turn, complete edge-set mutation, and retained nested regrade together.

### 5. Major — citation referential and cross-session semantics are incomplete

- **Spec section:** §B:67-74; §C:84-85.
- **Code evidence:** The proposed DDL does not require either id to `REFERENCES turns(id) ON DELETE CASCADE`, although turns are deleted by session cascade (`src/db/schema.ts:39-42`) and the database enables foreign-key enforcement (`src/db/database.ts:65-68`). Cross-session edges are writable, yet only victim demotion is explicitly limited to same-session; confirmation by in-degree and ↳ pull-in remain ambiguous. Current rendering rejects cross-session and non-predecessor citations (`src/mcp/timeline.ts:1578-1589`).
- **Suggested resolution:** Add cascading foreign keys and state separately whether foreign edges contribute to confirmation, supersession, and rendering; if they are provenance-only, exclude them from all three session-local algorithms.

### 6. Major — occupied-promptId re-typing can corrupt a real queued turn

- **Spec section:** §F:118-119.
- **Code evidence:** UserPromptSubmit creates an active ordinary turn (`src/hooks/handlers/session-init.ts:103-116`), which can own observations and pending turn-stop work (`src/db/schema.ts:82-113`). “Change that turn to compact” does not define status/title/content/tags/grade/assistant payload changes or retirement of its observations/queue items, so later extraction can overwrite the marker. It also conflicts with “every marker gets current MAX+1”: preserving the occupied row keeps its existing prompt number, while renumbering changes ordering under `UNIQUE(session_id,prompt_number)` (`src/db/schema.ts:39-74`). The following link-only byte-preservation rule does not clarify whether it applies to this conversion.
- **Suggested resolution:** Scope MAX+1 to inserted markers, state that converted rows preserve their prompt number, enumerate every overwritten/preserved column, and atomically retire or migrate associated observations and queue work before marking the row terminal compact.

### 7. Major — the 100-token unit and 2500-token global caps are not enforceable

- **Spec section:** §D:100-102.
- **Code evidence:** A unit must retain its title line and every assigned ↳ title, but structured `cites` has no cardinality/display cap. Enough antecedents can make the title-only unit exceed 100 tokens, where desc truncation cannot help. Likewise, enough non-removable always-keep title units can exceed 2500. Current rendering explicitly caps displayed references at two (`src/mcp/timeline.ts:76-84`; `src/mcp/timeline.ts:1595-1602`), but Rev 2 neither preserves nor replaces that rule.
- **Suggested resolution:** Define a deterministic per-unit arrow cap and overflow marker, then specify the final degradation behavior when a protected title-only set still exceeds either hard cap.

### 8. Major — shared antecedent ownership becomes invalid after its owner is dropped

- **Spec section:** §D:101; Testing:128.
- **Code evidence:** Rev 2 assigns a shared antecedent once to the earliest citer, then independently removes low-scoring units. If that owner is removed while a later citer survives, the causal row disappears; the test list names this case but supplies no required outcome. Current injection samples already-selected parent milestones without re-homing references (`src/hooks/milestone-injection.ts:90-137`).
- **Suggested resolution:** Recompute each shared antecedent’s owner over the retained citer set after every removal, choosing the earliest retained citer with the existing stable tie order.

### 9. Major — incremental cursor semantics can lose a partial line or strand final work

- **Spec section:** §F:116-120.
- **Code evidence:** The current parser reads and splits the whole file (`src/hooks/handlers/session-init.ts:63-76` via the transcript parser); Rev 2 introduces only a line-number cursor. It does not say whether the cursor remains before an incomplete final line or advances past it, nor how a line cursor enforces the 5MB seek bound without rescanning. SessionEnd reads at most 500 lines, but unlike UserPromptSubmit its remainder has no guaranteed later event, so missed boundaries can remain permanently unclaimed.
- **Suggested resolution:** Persist byte offset plus last fully committed line, never advance past a partial record, and enqueue durable deferred continuation (or explicitly define next-resume recovery and its completeness limit) for a truncated SessionEnd scan.

### 10. Major — ordinary link reconciliation still lacks a complete candidate/conflict rule

- **Spec section:** §F:119.
- **Code evidence:** Exact prompt text plus “unclaimed candidate order” does not define eligibility across sidechains, rollbacks, edited/resubmitted drafts, or an ordinary candidate whose promptId is already owned. Current backfill matches by prompt number/latest pending and skips populated responses (`src/hooks/backfill.ts:27-72`), while its update path silently drops a conflicting promptId and rewrites payload fields (`src/db/turns.ts:541-585`).
- **Suggested resolution:** Define the candidate population and transcript-order pairing for sidechains/rollbacks/edits, plus an explicit log/skip outcome for every uniqueness conflict, before calling the link-only API.

### 11. Major — the rule-turn exemption is not a predicate over the actual schema

- **Spec section:** §B:74.
- **Code evidence:** `rule_events.event_kind` is open text with implemented values including `proposed` and `judgment`; judgments carry free-form labels and optional status adjustments (`src/db/schema.ts:166-187`; `src/rules/dream-write-tools.ts:393-402`; `src/rules/dream-write-tools.ts:448-478`). “Proposal/adoption-class event” therefore does not identify concrete rows, and a proposal event created by the shown path does not itself set `turn_ref`.
- **Suggested resolution:** List exact qualifying `event_kind`/label/status-transition combinations and which event in a proposal→hit→judgment chain must carry the parsed turn reference.

### 12. Major — the companion repair is not a crash-safe one-time migration

- **Spec section:** Companion ticket:8-12, 16-19.
- **Code evidence:** The additive column and reader fallback are straightforward using the existing initializer pattern (`src/db/schema.ts:338-355`, `src/db/schema.ts:396-419`), and current derivations are exactly in recall, timeline, context, and worker repair (`src/mcp/recall.ts:311-330`, `src/mcp/recall.ts:417-442`, `src/mcp/timeline.ts:1731-1733`, `src/hooks/handlers/context.ts:177-197`, `src/worker/server.ts:1160-1174`). But the ticket gives no execution marker or transaction boundary: running repair only when `ALTER TABLE` occurs loses it after a crash between ALTER and scan; running it at every initialization rescans zero-match NULL rows forever. The immutable write also must cover the SessionStart registration path, not only UserPromptSubmit (`src/hooks/handlers/context.ts:334-348`; `src/hooks/handlers/session-init.ts:76-86`).
- **Suggested resolution:** Define a resumable, versioned repair ledger with claimed/completed state and auditable per-row outcomes; use first-non-NULL `transcript_path` writes at every hook registration while retaining `project = excluded.project`.

### 13. Major — the promised legacy citation grammar is still not literal enough to implement

- **Spec section:** §B:69-71; Testing:131.
- **Code evidence:** Rev 2 names single/list/range/annotated categories but gives no accepted strings, delimiters, or malformed-boundary behavior. The current parser accepts only repeated exact `[T<n>]` tokens (`src/mcp/timeline.ts:1517-1542`), while the write path also brackets some bare references (`src/mcp/remember.ts:268-331`). Different plausible “comma list” and “annotation” grammars will produce different graphs.
- **Suggested resolution:** Put the exact grammar in the spec with positive/negative examples and expected expanded DB-id arrays, including cap behavior across mixed forms.

### 14. Minor — token arithmetic names neither the correct estimator nor a consistent mean

- **Spec section:** Arithmetic:27; §D:100-102.
- **Code evidence:** Title ~10 plus desc ~50 already exceeds the claimed ~50-token mean before labels and the expected 0.68 arrow rows. The current injection’s deterministic estimator is `estimateDiaryTokens` (`src/hooks/milestone-injection.ts:3`, `src/hooks/milestone-injection.ts:199-216`), whose Han/other-codepoint formula is in `src/diary/domain.ts:80-85`; “existing estimator” should name it. K=50/H=100, minimum 30, and G3 >15% are otherwise consistent: normal windows overlap by 50 and the discrete trigger is 5/30, 8/50, or 16/100.
- **Suggested resolution:** Name `estimateDiaryTokens`, clarify whether ~50 describes content, a row, or a unit, and update the expected unit mean without changing the otherwise coherent K/H/calibration thresholds.

### 15. Minor — companion multi-match repair lacks a stable equal-mtime tie-break

- **Spec section:** Companion ticket:12.
- **Code evidence:** The shared resolver derives under the Claude transcript root (`src/shared/paths.ts:23-33`), but “newest mtime” can tie and filesystem traversal order is not a deterministic selector.
- **Suggested resolution:** Define the root explicitly and sort by `(mtime DESC, normalized absolute path ASC)`, logging all candidates and the chosen path.

## Summary

- Rev 2 substantially improves the design, but two of five prior blockers remain only partial.
- Eleven prior majors are closed; seven retain implementer-significant ambiguity.
- Settlement still lacks the durable job, authorization, output, uniqueness, and cursor-commit protocol needed for safe retries.
- Citation empty-state/write semantics and compact re-typing can publish or later overwrite incorrect state.
- Unit/global budgets are not hard caps until arrow/protected overflow behavior is defined.
- K=50, H=100, min=30, and the >15% G3 deviation threshold are internally coherent.
- The companion immutable-path/latest-cwd model is implementable; its repair lifecycle is not yet crash-safe or truly one-time.
