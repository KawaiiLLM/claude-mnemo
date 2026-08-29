# 01 — `topic:` words land, are guarded, and survive forever

**What to build:** the whole `topic:` grammar from spec Rev 5 (§`topic:` grammar — one closed contract). A main agent (or settlement) writes one free `topic:` word onto a turn; it is admitted past the closed tag vocabulary, is never injected or scored, survives a schema reopen, and is protected from every silent destruction path. Phase-bearing words are refused at write time by a machine-decidable predicate.

**Blocked by:** None — can start immediately.

**Status:** resolved — 3999040, 18 files explicit-pathspec, 49 new tests, 15 mutations (one initially-green needle re-pinned before acceptance). Reviewer re-ran all five owned test files (307 tests, 0 fail) + tsc. ADJUDICATIONS: the ticket's "56-token" label was the REVIEWER'S miscount — the spec list is 67 tokens and the worker verified its constant equals the spec token-for-token programmatically; retireTopic as a top-level retract-register parameter accepted; the facade TEST file edit accepted (it tests a retired-topic face; src/worker untouched); the teaching-surface sentinel narrowing accepted with its rationale. HANDOFFS: rubric CONCEPTS-half contradiction + settlement topic-correction wiring -> ticket 06; tag-stripping shim rename/delete -> ticket 08. Cross-swallowed lanes.ts edit (landed inside 4eef88a) noted: content correct, attribution mixed, no loss.

## File territory (BOTH ways)

- YOURS: `src/db/turn-tag-gate.ts`, `src/db/schema.ts` (the `stripRetiredTopicTagNamespace` removal and nothing else in the init chain), the main-agent Memory Rubric constant (locate it; the SessionStart-injected action half), `src/mcp/note.ts` tag teaching if it states namespace rejection, every other face a grep for retired-`topic:` rejection finds (enumerate them in your report), and their test files.
- NOT YOURS: `src/db/note-settlement.ts`, `src/worker/*` (ticket 03 is live in them NOW), any new tables (ticket 02), injection-reminder code (ticket 09). If a needed change lands in a file above, STOP and report instead of editing.

## Acceptance criteria

- [x] A live `note` write carrying `topic:<word>` lands for the main agent and for settlement; the closed-vocabulary check does not apply to the prefix; recall's `tag:` filter matches it; nothing injects or scores it.
- [x] `stripRetiredTopicTagNamespace` is deleted from the `initializeSchema` chain; a stored `topic:` word survives a full re-run of `initializeSchema` (test proves it); historical already-stripped words stay bare — no resurrection code.
- [x] Phase-token predicate: payload tokenized on `-`; any token in the spec's CLOSED 56-token list (copy it VERBATIM from spec Rev 5 — changing it is a spec revision) refuses, naming the token and the orthogonality law. `topic:widget-implement` refused; `topic:visual-design` refused; `topic:map-extraction` accepted.
- [x] Canonical-form refusal boundary: mechanically derivable unique repairs (case, NFC, trim, hyphen placement) show the derived candidate; non-derivable input (illegal charset, CJK, symbols) shows the canonical pattern and the offending characters, and NEVER fabricates a candidate.
- [x] Writing a `topic:` word the turn already carries is a success no-op, receipted as already-present.
- [x] Preservation invariant: a whole-set `tags` write whose replacement set omits an existing `topic:` entry is REFUSED naming it, for every writer. An explicit removal form exists (design the minimal mechanism consistent with the note tool's mode conventions; report your design) — silent omission is never removal.
- [x] A `topic:` word never qualifies as an edge side tag and never creates lane/task membership (test the side-declaration path refuses it).
- [x] The main-agent rubric teaches the topic-word duty (one word per turn, what it is for) and its orthogonality clause; the injected block stays under the injection char cap — measure and report the new size.
- [x] `npx tsc --noEmit` clean; owned test files green during work; full `bun test` once at the end — account for every delta from the baseline you measured at start.

## Notes

Production DB at `~/.claude-mnemo/` strictly read-only. Mutation discipline per repo standing law: implement first, back up AFTER implementing, needle-assert + PRINT the mutation applied, red, md5-identical restore, green. Do not tick these boxes — report per-item; the reviewer ticks. Stage explicit paths only (siblings share the tree); never `git restore`/`checkout` anything. Any `Bin` line in `git diff --stat` on a `.ts` file is a hard stop. Do NOT rebuild bundles (`node scripts/build.js`) — integration ticket 08 owns that. Scan touched files for control bytes with python, not grep.
