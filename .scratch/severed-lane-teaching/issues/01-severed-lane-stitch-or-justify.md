# 01 — A settlement that writes into a SEVERED lane stitches it or says why not

**What to build:** the settlement agent stops walking past connectivity warnings.
Before `commit`, for every lane THIS WINDOW wrote a member or an edge into, if
`lane_check`'s Report 2 shows that lane SEVERED within the scope view, the agent
either writes a stitching edge (where a genuine use-relation exists) or states in
the commit report why the components are legitimately separate. "lane_check clean"
may no longer mean "I read the errors and skipped the warnings".

**Blocked by:** None — can start immediately.

**Status:** resolved — landed as `6723743`; every criterion below re-checked per-item from the worker's report, spot-verified (prompt wording present in the block-B region, both touched test files 110/0, tree clean)

## Why

Job 121 (S15440 T726-775, the first production run of the 0.22.0 prompt) reported
"lane_check clean" while rp-harness stood SEVERED inside its own scope view: the
window's M10V2 thread (T739-765) and the effort-audit thread (T766-775, correctly
wired back to already-settled T646/T650) never touched. A real stitching edge
existed — T766's full text UPHOLDS T765's cost-parity conclusion ("so cost parity
conclusion stands"), a textbook `verifies` — and was found by hand afterwards
[S15069/T1851][S15069/T1852]. The checker is not at fault: Report 2 rendered the
severance, but every Report-2 finding is a WARNING by design (ticket 11: a lane
legitimately grows in pieces mid-work, so connectivity never blocks), and the
prompt teaches the agent how to repair ERRORS while saying nothing about what a
warning obliges. The agent did the rational thing with what it was taught.

User ruling 2026-08-27: teaching only, the minimal cut — no checker change, no new
gate [S15069/T1853].

## Decisions (settled — implement as given)

1. **Teaching only.** No change to `lane-checker.ts`, no new error class, no new
   commit-gate condition. Report 2's WARNING classification stands.
2. **The obligation is scoped to lanes this window TOUCHED** — wrote a member into
   or wrote an edge into. A lane that is severed entirely outside the writable set
   is not this window's debt.
3. **Stitch only on a genuine use-relation.** The rubric's edge semantics are
   unchanged: adjacency is not use, and a chronology bridge invented to silence a
   warning is worse than the warning. The honest fallback is one sentence in the
   commit report naming the components and why they stand apart. (Job 121 half-had
   this: "an effort/cost-audit sub-thread crossing to T646/T650" — the amendment
   makes that sentence an obligation rather than an accident, and makes the agent
   LOOK for the stitch before writing it.)
4. **Placement: the existing commit-preparation teaching**, beside where the
   prompt already tells the agent to run `lane_check` and repair what it names —
   not a new step, not a new tool.
5. **The full-text rule rides along.** The stitch decision requires the candidate
   turns' content read TO THE END — the 766→765 word was misjudged `narrows` from
   a truncated read and corrected to `verifies` only on the full text. The prompt
   already teaches truncation recovery for the read gate; one clause extends it to
   edge-word judgment.

## Acceptance criteria

- [x] The rendered settlement prompt contains the new instruction; quote the final
      wording in the report.
- [x] The verbatim-integration guard still passes: if the touched text lies inside
      the block-B region, the change is a REGISTERED `.replace()` amendment
      (`expect(amended).not.toBe(body)` proving it applied); if outside, state so.
- [x] Any test archiving the affected prompt text verbatim is updated together
      with it, and any test holding its own copy of the text also compares that
      copy to the authority (standing constraint [S15069/T1721]).
- [x] No new refusal path exists: a commit with a SEVERED touched lane and no
      justification sentence still commits. Asserted, so decision 1 cannot drift
      into a gate.
- [x] Every new test mutation-verified: name the observable that must differ,
      assert the mutation's needle matched and PRINT that it applied, confirm red,
      restore from a backup taken AFTER the implementation lands, confirm green.
- [x] `npx tsc --noEmit` clean, `node scripts/build.js` succeeds, `bun test`
      green; report the number and account for the change.

## Out of scope

Changing Report 2's computation or classification; distinguishing edge-connected
islands from tag-only singleton members in the checker (real, separate question —
E70's rp-harness reports 24 islands of which 16 are zero-edge singletons, so the
island count overstates thread severance; a candidate refinement, not this
ticket); any retroactive stitching campaign over E70's remaining islands.

## Notes

Production database read-only from this work (`sqlite3 -readonly`). The evidence
window (job 121, S15440) must not be re-settled by this ticket.
