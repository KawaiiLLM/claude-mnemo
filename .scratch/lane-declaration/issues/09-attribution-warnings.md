# 09 — The checker pressures attribution instead of mandating tags

**What to build:** with the per-edge tag mandate gone, the checker is what keeps lanes from either disappearing or multiplying. It reports two facts — never refuses — and settlement reads them as its own workload.

**Blocked by:** 03.

**Status:** done

Rulings: [S15069/T1547], [S15069/T1548].

- [x] **Unattributed cluster warning:** a cluster of **4 or more** turns that carry no lane tag AND are connected to each other by untagged edges is reported, naming its turns. Three or fewer is silence — a short exchange is not a workflow.
- [x] The judgment domain is that cluster, NOT the graph's connected component [S15069/T1553]: `LANE_COMPONENT_RELATIONS` includes `grounds`, so on a mature segment nearly everything hangs off something tagged (one measured component holds 77 turns) and a component-level rule would never fire.
- [x] An untagged `indexes` EXCUSES only the members it actually aggregates; the rest of the cluster is re-evaluated as an induced subgraph and still warns if 4+ remain (peer P1-9 — otherwise a release indexing two artifacts silences a 100-turn orphan cluster, and a legal 4-turn one-off that ships a single artifact warns forever).
- [x] "Carrying no lane tag" means: this turn is not an endpoint of ANY edge carrying a lane tag declared in its segment. A turn's own noun tags are NOT membership (peer P1-8) — that reading produces silent false negatives for exactly the turns the rubric admits but no edge ever joined.
- [x] Name the relation domain of the "connected by untagged edges" test explicitly, so an evidence line joined only by `verifies`/`refutes` does not appear and disappear with the set chosen.
- [x] The retired per-component acceptance bullet is DELETED, not left beside the new one: "a component with ONE tagged member is silent" contradicts the cluster rule and no implementation can satisfy both (peer P1-10). Its replacement pins the opposite: a tagged member elsewhere in the component does not excuse an unattributed cluster inside it.
- [x] **Proliferation warning:** a segment whose declared lane count exceeds **max(1, 0.05 × its member turn count)** is reported with both numbers. The 0.05 is the user's ruling; the `max(1, …)` is peer P2-12 — without it a 19-turn segment's single legitimate lane warns forever and falls silent at 20 turns.
- [x] The count is a per-SEGMENT fact and must come from the registry and the membership table, never inferred from whatever projection a window happened to load (peer P1-11): the same segment currently yields different verdicts from a 4-turn settlement window and a 100-turn one. State where the loader supplies it.
- [x] Both are WARNINGS in the existing report vocabulary, never errors, and neither blocks a commit.
- [x] `lane_check` prints both, so settlement sees its own attribution debt in the same surface it already reads.
- [x] Tests: a 3-turn unattributed cluster is silent and a 4-turn one warns (the boundary, both sides); a segment at exactly the ratio is silent and one over it warns; a tagged member ELSEWHERE in the same component does NOT excuse an unattributed cluster inside it; an untagged `indexes` aggregating two members of a six-turn cluster leaves four unexcused and still warns; a `max(1, …)` segment (19 turns, one lane) is silent.
