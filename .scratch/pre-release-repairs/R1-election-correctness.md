# R1 — Election correctness cluster (peer findings #1 #5 #6 #7 #12 #14a)

**#1 (P1) External endpoints must not be candidates, and must carry real
metadata.** getRelationEdgesAmongTurns reads OR-scoped edges; the election
core then treats EVERY edge endpoint as a node: externals can occupy stage-1
budget slots, seed the tier-③ elected boundary, and enter the lane reduction
with fabricated `[0, id]` orders. Two pinned counterexamples:
(a) window {T1 (writes untagged indexes = release), T2, T3}, budget 2;
external T90/T91 each `indexes T3` → today elects {T1, T3}; correct is
{T1, T2} (externals are not candidates, and tier ③ seeds only from ELECTED
candidates).
(b) window member T2 declares lane {x}; external LATER T99 re-declares; with
T99's fake `[0,99]` order the reduction wrongly keeps T2 as terminus —
with T99's REAL order, T2's declaration is superseded (T2 loses its tier-2
seat; T99, external, gets none).
Fix: the core separates GRAPH nodes from ELIGIBLE candidates — candidates
are exactly the supplied `turns[]`; edge-only endpoints join
reduction/in-degree but never seat and never define the elected boundary.
The adapters load real order (+ epoch, + segment where the reduction needs
it) for external endpoints instead of letting the `[0,id]` fallback engage.

**#6 (P2) Cross-session later-wins uses the tuple, not event time.** The
segment event order is `createdAtEpoch` (segment-card.ts precedent), but the
election's rank tie-break compares `[sessionId, promptNumber]` tuples across
sessions — the exact "tuple-order trap" report 4c already avoids. Pinned
counterexample: same segment, S1/T1 epoch=200 vs S2/T1 epoch=100, budget 1 —
today the EARLIER event wins on the bigger session id. Fix: the rank
comparator (and any reduction-order use across sessions) falls back to
`createdAtEpoch` for cross-session pairs, mirroring 4c; adapters supply the
epochs.

**#7 (P2) The corrector tier's second clause is dead in production.** The
core honors citers-of-rolled-back via its rolledBackOf input, but the
adapters never populate it: live SQL excludes rolled-back turns AND edges
touching them. Pinned counterexample: T1 rolled back, T2 `verifies T1` →
production tiers T2 at ⑤, contract says ④. Fix: adapters fetch the
rolled-back-citer facts separately (rolled-back turns as non-candidate graph
info or a citer-id set) and feed the core.

**#5 (P2) E-view lacks the min(pageSize, 30) clamp** the S-view applies —
40 edgeless members at pageSize=40 return 40 kept; ruled budget is 30. Fix
the E-view path + the mnemo-timeline SKILL.md sentence still teaching
pageSize as an uncapped admission knob.

**#12 (P3) Retirement guard honesty**: add the E-view grade-permutation
behavioral test (currently S-view only) and downgrade the guard file's
comment from "equivalent reimplementation would be caught" to what the
blacklist actually guarantees.

**#14a (P3) Comment overclaims**: lane-interpretation.ts's "a later override
can only hit the max declaration" note is too strong (override of a
non-terminus, continuation/fork-open are legal counterexamples) — fix the
prose; sweep timeline.ts for leftover "lexicographic edge-signal"/
getTurnEdgeSignals comments and stale test titles.

**Territory**: src/shared/milestone-election.ts, src/db/memory-edges.ts,
src/mcp/timeline.ts, src/shared/lane-interpretation.ts (comment + any
order-fallback seam), their test files, plugin/skills/mnemo-timeline/SKILL.md.
NOT lane-checker*/console-* (sibling workers). Golden nine must stay green —
a change there is STOP-AND-REPORT.

**Status:** done (6fc134b; mutation-verified: eligibility filter → 1 red, epoch fallback → 2 red, citer query → 2 red S+E, E-view clamp → 1 red; golden nine untouched)

- [ ] Both #1 counterexamples pinned as tests and green post-fix; golden nine
      unchanged
- [ ] #6 epoch fallback pinned with the cross-session counterexample
- [ ] #7 pinned: a citer of a rolled-back turn tiers ④ through BOTH real
      adapters
- [ ] #5 clamp + SKILL.md; #12 E-view permutation; #14a comments — each with
      its own check
- [ ] Targeted suites + typecheck green; control-byte scan clean
