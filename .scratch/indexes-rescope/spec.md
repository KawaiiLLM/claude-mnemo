# indexes — the aggregation word spans both layers (flow-relations amendment)

Ruled S15069/T1228–T1241 (2026-08-22), user-led, with the turn-graph page as the
instrument that made the defect visible; peer-audited at T1238 (eight findings:
four absorbed as wording, two ruled at T1240/T1241, two adapted — dispositions
inline). Amends `.scratch/flow-relations/spec.md`
(word-choice law) and ADR-0011 decision 4; ADR-0012 rides the implementation
batch. Everything not named here is unchanged.

## Root cause (why the release's long arcs were wrong)

- T998's ritual edges span up to ~90 turns: eight `grounds` to decision
  settlements re-derived AT THE RELEASE what the artifact layer had already
  recorded — laborious at write time (the T1222 re-point proved it) and
  redundant under the deletion test. Measured: 5 of 8 are transitively
  derivable through the consumed artifacts' own grounds chains (≤3 hops); of
  the three gaps, two dissolve under the new reading (T990's ruling and
  artifact share one dual-phase turn; T913 is reached via in-branch members
  T910/T912) and one (T906) is a missing artifact-side `grounds` — which this
  model converts from release-time global re-derivation into local,
  detectable debt.
- The cross-layer-same-phase cell (release→commit) — the cell that motivated
  the layer axis in the first place — was parked on `consume`, which reads
  usage, not representation. `collects` had the right semantics but was
  fenced to decision-flow termini by T1204's v1 split.

## The law (deltas only)

1. **`collects` renames to `indexes`; semantics = same-phase aggregation.**
   One sentence, no scenario legislation (user T1231: emergence over
   node-type rules): *this node gathers and represents these same-phase
   nodes carrying its effective content; readers reach them through it.* A
   decision settlement indexes its branch's carrying members; a release
   indexes the delivery artifacts it ships — the same word, reached
   naturally by any aggregation point.
2. **Machine check: same-phase only** (user T1232: "只检查是否同相位，其他
   关系类似"). T1202's terminus + own-branch hard rejection RETIRES —
   `indexes` carries NO graph-state gate; the self-grounds
   settlement+implementer condition (law 6) remains the vocabulary's ONE
   graph-state rejection (peer finding 8: the earlier zero-graph-state
   phrasing contradicted law 6). Membership and terminus drift become
   judgment, owned by settlement review. Consequences:
   the dead-branch guard and the `isFlowSettlement`/`isOwnFlowMember`
   write-gate wiring leave the indexes path (the flows module stays for
   derivation-side readers); the whole-call-rollback trial cost that helped
   keep settlement collects-blind (T1227 cause 3) drops with it.
3. **Dedup by derivability**: an indexed target is never also consumed —
   `indexes` subsumes `consume` on the pair, exactly as `extends` already
   subsumes it (user: 已经 indexes 收编了就不需要再 consume 了，追求最小连通).
   A NAVIGATION dedup, not an entailment claim — see invariant 3.
4. **Release ritual v3**: a release `indexes` the artifacts it ships and
   writes NO `grounds` to decision settlements — the decision linkage is
   transitive (artifact —grounds→ ruling: to-spec transcription and
   implementation turns already carry it; measured above). The release chain
   (citing the previous release) stays `consume` — lineage is usage, not
   representation. T1204's curation split half-reverses: release-chooses-
   WHICH-settlements dies; settlement-chooses-WHAT (now via indexes)
   survives untouched.
5. `consume` itself is UNCHANGED (same-phase, no liability — procedural
   chains keep it); `grounds` remains the only cross-phase dependency word;
   `verifies`/`refutes` and the stance trio untouched. Scope purity holds:
   five same-phase words (override/narrows/extends/indexes/consume), three
   cross-phase (grounds/verifies/refutes), no straddlers.
6. **Self-citation unchanged**: `grounds` at settlement+implementer only;
   `indexes` still refuses a self target.
7. **Canonical cross-phase route** (user T1236): when a lane has a spec — a
   to-spec/transcription turn — THE spec carries the `grounds` to the
   decision flow; implementation artifacts reach the decision through it
   (artifact —consume→ spec —grounds→ decision). An artifact writes
   `grounds` directly only when no spec exists. One route per flow across
   the decision→delivery seam: minimality applied exactly where the two
   layers touch. PRECONDITION (peer finding 1, production-measured): the
   route exists only when the lane has an INDEPENDENT delivery-phase spec
   turn. When design and spec-writing merged into one turn (the T900
   shape, design+ops), artifacts KEEP their direct `grounds` — a
   mechanical re-route there is phase-illegal (consume is same-phase; a
   pure-delivery artifact cannot consume a pure-decision turn) and
   degrades into self-grounds.
8. **Node set** (user T1236; scoped at peer finding 5): rewound
   (`was_rolled_back`) turns are DELETED — never in the graph, its
   invariants, or the visualization. `status='skipped'` is NOT deletion:
   it is a reversible lifecycle floor (a late note promotes the turn back
   to `extracted` — the amendment's own source turns sat [skipped] while
   their notes were pending). Skipped turns are DORMANT: absent while
   skipped, returning whole on promotion. One shared deleted/dormant
   predicate serves every read side.

## Graph invariants (the global acceptance layer, ruled T1234/T1236)

The words are local grammar; these three are the graph-level acceptance
criteria the grammar should make EMERGE — review-time lints, never
write-time gates, never a license to invent edges:

1. **Reachability**: every effective node (noted, not deleted/dormant per
   law 8, not an overridden victim, not a dead-branch member — the
   override that killed the branch IS its closure, peer finding 4) reaches
   its OWN workflow's terminal — a settlement, a release, an operational
   closure. Not every lane ships; ops/research lanes legally end at a
   settlement. An unreachable effective node is review DEBT (live example:
   T915's rewind contracts shaped the view spec with no edge into it),
   queued for judgment. Traversal projection (peer finding 4): read
   AGAINST the stored direction — from a terminal, expand backward over
   narrows/extends/grounds/consume/indexes; `override` joins nothing (the
   overrider's flow stays its own).
2. **Component emergence**: after cutting fork roots, terminals, and
   no-liability weak ties — consume EXCEPT the canonical-seam consume (one
   whose target itself writes `grounds`; machine-detectable, lane-internal
   by law 7 — peer finding 3: cutting seam consume would shred every
   compliant lane into spec/artifact islands) — distinct workflows appear
   as distinct connected components. Measured on the OLD-law graph
   T900–T1201 (reference only — it predates ritual v3; the acceptance
   measurement re-runs on the rewritten graph): 40 components, the top
   ones cleanly nameable (read-write contract 12, rubric landing 10, topic
   retirement 8, edge-poverty experiments 7…) plus one 27-node macro-arc to
   audit. The release's apparent confluence was largely the OLD ritual's
   grounds fan (user T1236) — under ritual v3 + the canonical route it
   thins to an indexes face over shipped lanes.
3. **Minimality is about NAVIGATION, not entailment** (ruled T1241,
   resolving peer finding 2): an edge is deleted as redundant when a
   canonical route already makes its targets FINDABLE — the graph never
   claims liability composes along a route (consume∘grounds does not
   entail grounds; indexes does not entail consume). The counterpart is
   the **invalidation-review protocol**: when a decision is overridden or
   an edge retracted, review expands the candidate taint set along
   reverse `grounds` and the canonical seams (consume-into-spec, indexes
   membership), then judges each candidate BY CONTENT — no automatic
   contagion (ADR-0010's non-contagion ruling, unchanged; retraction and
   re-judgment remain acts of judgment written back as edges). ROUTE
   multiplicity is minimized; KIND multiplicity on one pair stays legal
   when each relation states an independent fact (override+refutes, T1072
   precedent).

Together: 1 is recall, 3 is precision, 2 is the modularity that makes both
checkable lane by lane. Their three lints — unreachable effective nodes,
cross-lane glue edges, derivable redundant edges — belong to the backfill
review and the graph page.

## Flow derivation

- `indexes` joins the INHERITANCE set (citing inherits the cited turns'
  flows, reverse of edge direction): a release that indexes artifacts
  instead of consuming them must keep reaching the flows it ships. Stance
  words stay opaque; `collects`-transparency (P3: deletion test + election
  read members through the settlement) renames with the word, scope
  unchanged.

## Migration (small; stored rows all post-era)

1. Mechanical: 18 `collects` rows → `indexes` (the count kept moving while
   this spec was drafted — the amendment session wrote four more; the
   rehearsal measured 18→18 and ADR-0012 records that figure); CHECK word
   swap (rebuild-and-
   copy precedent, rehearse on a /tmp production copy — the 0.13.0 incident
   rules are in force for any data-UPDATE migration); note params
   `collects`/`retractCollects` → `indexes`/`retractIndexes`; validator
   phase table (indexes: same-phase, no graph check); **indexes SCORES**
   (ruled T1240: aggregation credits its TARGETS, the T1171
   encodes-curation lineage — `RELATION_IS_SCORED.indexes = true`, indexes
   in-degree joins the curation key beside grounds in-degree in
   edge-signals); rubric v8 §Relations (budget the edit — v7 holds 443
   chars headroom; the three lints stay OUT of the rubric, see Out of
   scope); definitions describes; settlement prompt follows EDGE_RELATIONS
   automatically. The CHECK swap's staleness probe keys on the OLD word
   `collects` still present — never on the new word's absence (0.14
   sequencing-bug lesson).
2. By hand after reload (valid-as-of-write-time, NOT a code migration):
   re-judge the four release turns T998/T1001/T1150/T1218 — retract
   grounds-to-settlements, re-speak consumed work as `indexes`; write the
   missing artifact-side `grounds` where the transitive check exposes a
   T906-class gap; re-route artifact-grounds ONLY where law 7's
   precondition holds (an independent delivery-phase spec turn) — the
   T936→T910 / T946→T912 class stays direct grounds (merged design+spec
   lane; re-route is phase-illegal there) — per-case at review, never in
   bulk. Batch verification QUANTIFIES the milestone diff from the
   release-grounds retraction against the same-batch indexes credit and
   reports it (peer finding 7, ruled T1240).
3. One shared deleted/dormant predicate for every graph read side —
   `db/flows.ts`, `db/citations.ts`, `db/edge-signals.ts` currently filter
   inconsistently — implementing law 8.
4. The turn-graph page regenerates with the new word and drops
   deleted/dormant nodes (law 8).

## Out of scope

Scoring EXCEPT indexes' participation (ruled T1240; weights, narrows'
consequence, override-victim treatment stay with the scoring pass).
Settlement's indexes operationalization — RULED for v1 as division of
labor (T1238 triage of peer finding 6): the three lints and the indexes
re-judgment belong to hand passes and the graph page, not to settlement
and not to the rubric; a settlement candidate surface (rendered termini,
shipped-artifact sets) is v2. Delivery-layer tag flows (still v2). The
soft-assertion tie-breaker for hedged stance pairs (unruled; empirical
cases T1010, T1101).
