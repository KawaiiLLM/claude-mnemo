# 05 — Interpretation core and the four-report checker

**What to build:** a pure read-only module — the ONE place the lane interpretation is encoded. Input: a turn range (session or segment view) or named lanes (segment + exact tag set); projection widens to each involved lane's full live edges regardless of range. Pipeline: lane enumeration by (segment, exact tag set); event reduction in citing-turn order (tagged declarations, tagged in-lane overrides, untagged global kills) to current terminus / reopened / repudiated state. Output: exactly FOUR reports — (1) per-lane stats (tag set, segment, phase, members with dead nodes separate, edge counts by word, declaration presence, latest event); (2) member component count within the segment-global all-words undirected graph, representatives per island (principle 1, healthy = 1); (3) components holding several lanes' members, with designed shapes (shared fork roots, merge nodes) annotated (principle 2); (4) start-to-terminus path counts, same-phase over lane structural edges, then again with cross-phase citations folded in — multi-start sums, undeclared lanes skipped and marked (principle 3). Never candidate edges; partial coverage declared. Golden scenario fixtures pin the interpretation three ways (validator, checker, rubric-required outcomes): coexisting untagged/{A}/{B}/{A,B} rows, tagged lane-local vs untagged global override, other-tag indifference, declaration/override/continuation turn-order reduction, self-cite exclusion from uptake, single-node exemption, cross-segment dual appearance.

**Blocked by:** 01 — Edge tag-set storage.

**Golden corpus:** `.scratch/rubric-v10/fixtures/t900-1001-lane-sim.json` — the real
T900-1001 window reinterpreted under the lane model by hand judgment (12 lanes, 48
tagged edges, 7 simulated declarations flagged `simulated`, minted member tags).

**Report domains (T1300/T1321/T1323):** three distinct participations, per word.
Reports 2/3 build their graph from stance + consume + grounds — indexes
(aggregation) and verifies/refutes (testimony adjudicates, it does not join)
never enter component analysis. Report 4 counts NODE paths (parallel relations
on one pair are one route, the T1241 precedent) over the lane's tagged
stance/consume edges. The cross-phase side splits by word: grounds citations
fold in AND count toward path multiplicity; verifies/refutes citations
PARTICIPATE as cited-ness facts and coupling display (data: release termini's
only cross-phase citations are verifies — excluding them orphans every delivery
lane forever) but never add to path counts (duplicate probes are legal fact
multiplicity). Expected values on the corpus: every declared lane has component
count 1 and path count 1 (grounds-folded included); {write-gate} reports
undeclared/reopened; report 3 yields exactly two multi-lane components; release
termini show testimony citations without grounds. Pin these as the golden
assertions.

**Status:** ready-for-agent

- [ ] The four reports compute correctly on the golden fixtures; every fixture scenario has an asserted expected outcome.
- [ ] Range input never truncates a lane's projection; a lane partially outside the range is reported whole with coverage declared.
- [ ] Path counting matches hand-computed values on a fixture with a fork, a merge, and one cross-phase fold.
- [ ] The module performs no writes and imports no write-path code.
- [ ] Mutation check: breaking turn-order reduction (using edge write time) fails a fixture.
