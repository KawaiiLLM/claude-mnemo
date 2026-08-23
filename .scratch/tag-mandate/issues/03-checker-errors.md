# 03 — The checker splits ERROR from WARNING and computes the first four error classes

**What to build:** the lane checker's findings divide into ERRORS (states
the grammar forbids) and WARNINGS (the three principles' facts, i.e. every
existing report reclassified). Errors get their own block on both surfaces
(CLI digraph and the settlement lane_check text; the console's
laneCheckText inherits automatically). Spec: `.scratch/tag-mandate/spec.md`
sections "Error classes" (E1-E4 only — E5 is ticket 04) and "Anchoring and
repairability".

- E1 untagged extends/narrows rows; E2 out-of-vocabulary relation words;
  E3 out-of-vocabulary or EMPTY turn types (compact markers and
  legally-skipped turns EXEMPT, rolled-back turns are not nodes); E4
  subset-invariant violations (an edge tag absent from an endpoint's tags).
- Every error instance carries its ANCHOR: an edge error anchors at its
  citing turn, a type error at the turn itself. The anchor is data in the
  checker result (the commit gate, ticket 05, filters by it) and prose in
  the renders.
- Existing reports 1-4 and the vocabulary-conformance facts reorganize
  under the warning/error split without changing their computations —
  reclassification, not rewrite.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Unit fixtures per class, each with an in-scope and out-of-scope
      anchor variant; exemption fixtures (compact, legal skip)
- [ ] Golden T900-1001 fixture reports ZERO errors (it conforms — any
      discrepancy is STOP-AND-REPORT, never a golden adjustment)
- [ ] Both render surfaces show the errors block distinctly from warnings;
      existing report content otherwise byte-stable where unaffected
- [ ] NOTE: the live T1-100 zero-error check is the DELEGATOR's acceptance
      step against production — this ticket never touches `~/.claude-mnemo`
- [ ] Load-bearing properties declared for mutation acceptance
