# 04 — Reclassify the checklist: what blocks, what informs

**What to build:** the taxonomy itself. Every check carries one class decided by one rule, both surfaces print the same class for the same finding, and a warning stops reading like an obligation.

**Blocked by:** 03 — one evaluator must exist before its findings can be reclassified once.

**Status:** ready-for-agent

Spec: `.scratch/settlement-gate-taxonomy/spec.md` — "The classification rule" governs; the rule and the table are FROZEN from it.

- [ ] The rule, in the code, as the single place a class is decided: BLOCKING ERROR = a hard post-state invariant of this stage is violated AND the finding anchors in this run's judgment set AND the run has a bounded, legal, honest repair. Three conditions, one predicate, no per-check special cases.
- [ ] E6 and E4 stay blocking errors. **E3 becomes a stage-2 WARNING** — printed as one, gated as one; the commit gate's hand-written "beyond authority" carve-out disappears because the rule now covers it (fixture: the carve-out's removal changes no verdict).
- [ ] **Fractures become warnings.** `commit` no longer refuses over a lane disposition; the existing `warnings` channel on the receipt carries them, and a successful commit reports the count and the stitch target. Fixture: a run touching a severed lane commits successfully and the warning rides the receipt.
- [ ] The section header that calls warnings "aspirations, never enforced" becomes TRUE — nothing under it blocks anything.
- [ ] **A phantom fracture must not be REPORTED either.** Ticket 01 proved the fractures job 166 was blocked on do not exist in the lane's real topology; demoting them to warnings would keep printing findings about a graph that is not there. This criterion is discharged by ticket 02's loader fix — assert it here from the reader's side: a lane whose edges were not widened produces no fracture line at all.
- [ ] **The `lane_check` call must not contradict itself.** Ticket 01's fourth finding: the report-2 connectivity section IS scope-filtered (`lane-checker-render.ts:919`) while the LANE DISPOSITION block appended below it (`note-settlement-sdk-query.ts:2020`) re-runs the gate UNFILTERED, so one call prints "this lane is fine" above "this lane owes a disposition". That is the disagreement job 166's abandonment note named. One filter, both halves.
- [ ] Warning wording cuts action-inducement, verbatim from the spec: `WARNING — informational; does not block commit. Do not call justify or delay commit. Add a stitch only if a truthful relation is already supported by the material you are processing.`
- [ ] The settlement prompt's own description of the gates is updated to match — a run taught the old contract will still behave under it.
- [ ] `npx tsc --noEmit` clean; touched suites green; full `bun test` once; bundles rebuilt, stale-bundle guard green.
