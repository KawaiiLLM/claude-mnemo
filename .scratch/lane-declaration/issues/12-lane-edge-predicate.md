# 12 — A lane's own graph is defined by its tag, not by a list of relation words

**What to build:** every lane-shaped question — membership, component, path, chain — asks "does this edge carry THIS lane's tag", not "is this relation word in some set". Adding the three cross-phase words to three string sets does not work: the checker treats `grounds` as an external bridge and `timeline` filters it out of chains, so a lane made of tagged `grounds` edges renders severed while untagged cross-phase edges would start polluting components.

**Blocked by:** 03 (shipped).

**Status:** ready-for-agent

Peer finding P1-7. Spec Rev 3, D2's last paragraph.

- [ ] An edge-level predicate replaces the relation-set membership test in the lane's own graph: an edge belongs to lane X's DAG/path/chain exactly when it carries X's tag, whatever the word is.
- [ ] The EXTERNAL structure keeps its own domain: untagged cross-phase edges remain the citedness/fold facts they always were, and must not leak into a lane's component or path reports.
- [ ] `LANE_COMPONENT_RELATIONS`, `LANE_PATH_RELATIONS`, `LANE_CHAIN_RELATIONS` and the SQL loader are all re-derived from that predicate rather than extended by three strings. Name in the report every place that changed and every place you decided must NOT change.
- [ ] `indexes` still does not participate in connectivity (rubric: 「indexes 不参与连通性计算」), and that exclusion survives the rewrite.
- [ ] Failure case to pin: a lane whose ONLY edges are `T2 --grounds{x}--> T1` and a `verifies{x}` renders as one connected two-member lane with a path, in both the checker's reports and the timeline lane chain — today it renders severed or single-node.
- [ ] The timeline lane chain admits a tagged cross-phase edge as an ordinary hop (arrow choice is yours to state and pin).

**File ownership:** `src/shared/lane-checker.ts`, `src/shared/lane-interpretation.ts`, `src/db/lane-checker-load.ts`, `src/mcp/timeline.ts`, and their tests. NOT `src/shared/milestone-election.ts` or `src/worker/console-*` (ticket 11, parallel), NOT `src/mcp/note.ts` / `remember.ts` / `definitions.ts` (ticket 02, later).
