# ADR-0012 — One aggregation word across both layers: `indexes`, phase-only checks, and the thinner release

**Status:** accepted · 2026-08-22 · source: S15069 T1228–T1241 (peer audit at
T1238, eight findings; dispositions inline) · spec:
`.scratch/indexes-rescope/spec.md` (carries every ruling address and the
measured evidence) · amends ADR-0011 (decision 4 and P1's one-hard-check
clause, both marked superseded in place)

## Context

ADR-0011 put relations on two axes — phase and layer — but then split the
AGGREGATION job by node type. `collects` was fenced to a decision flow's own
settlement [S15069/T1204], and the release, the very case that motivated the
layer axis, was left on `consume` plus a fan of `grounds`. `consume` reads
usage, not representation: it says "I used its product", which is not what a
release says about the commits it ships.

The fence was measurably expensive at the release, not just inelegant:

- **The ritual re-derived, at release time, what the artifact layer already
  recorded.** T998's ritual edges span up to ~90 turns: eight `grounds` to
  decision settlements. Five of the eight are transitively reachable in ≤3
  hops through the consumed artifacts' own `grounds` chains. Of the three
  gaps, two dissolve under this amendment's reading (T990's ruling and its
  artifact share one dual-phase turn; T913 is reached through its in-branch
  members T910/T912) and exactly one — T906 — is a genuine MISSING
  artifact-side `grounds`. That last case is the point: the model converts a
  release-time global re-derivation into local, detectable debt.
- **Writing them was laborious.** T1222's re-point pass demonstrated the write
  cost directly, and the deletion test does not defend the edges it produced.
- **The cross-layer-same-phase cell had no word at all** (release → the commit
  it shipped), so it was parked on `consume` by default rather than by ruling.

The user's framing [S15069/T1231] is the actual root: behavior should EMERGE
from one clean semantic rather than be legislated per node type. Two words
doing one job in two neighborhoods is the same failure ADR-0010 retired seven
per-word phase tables for, one level up.

The turn-graph page (`/tmp/turn-graph/`) is what made the defect visible — the
release's long grounds arcs are legible as arcs before they are legible as a
rule.

## Decision

### 1. `collects` renames to `indexes`; its semantics widen to same-phase aggregation

One sentence, no scenario legislation: *this node gathers and represents these
same-phase nodes carrying its effective content; readers reach them through
it.* A decision settlement indexes the members of its branch that carry its
conclusion; a release indexes the delivery artifacts it ships. Same word,
reached naturally by any aggregation point on either layer — nothing in the
word knows what kind of node is using it.

`indexes` also joins the flow-INHERITANCE set (`grounds`/`consume`/`indexes`):
a release that indexes its artifacts instead of consuming them must still
reach the flows it ships. The transparency `collects` carried (P3: the
deletion test and, once scoring resumes, the election read a settlement's
members through it) renames with the word, scope unchanged.

Scope purity holds after the widening: five strictly same-phase words
(`override`, `narrows`, `extends`, `indexes`, `consume`), three strictly
cross-phase (`grounds`, `verifies`, `refutes`), no straddlers.

### 2. Machine checks retreat to phase; self-`grounds` is the vocabulary's one graph-state gate

`indexes` is checked for same-phase and nothing else [S15069/T1232]. ADR-0011's
terminus + own-branch hard rejection — the citing turn must be its branch's
terminus, every target a member of that same branch — RETIRES, and with it the
dead-branch guard and the `isFlowSettlement`/`isOwnFlowMember` write-gate
wiring on this path. Membership and terminus drift become judgment, owned by
settlement review rather than by a write-time refusal.

The self-citation gate is unchanged and is now the ONLY condition in the
vocabulary that consults graph state: `grounds` may self-cite iff the turn is
both a flow's settlement and that settlement's own implementer (peer finding 8
caught an earlier "zero graph state" phrasing that would have contradicted it).
`indexes` still refuses a self target.

The retreat also drops a real implementation cost: the whole-call-rollback
trial that kept settlement `collects`-blind (T1227 cause 3) existed to make the
membership gate survivable inside a batched call. Nothing is left to roll back.

### 3. Release ritual v3: a release indexes what it ships and grounds on nothing

A release `indexes` the delivery artifacts it ships, and `consume`s the
previous release — lineage is usage, not representation, so the chain keeps its
word and the first release stays the chain's legal root. A release writes NO
`grounds` to decision settlements: the decision linkage is reached transitively
through the artifacts, which already carry it (to-spec transcription and
implementation turns ground on the rulings they carry).

ADR-0011's curation split half-reverses. Release-chooses-WHICH-settlements
dies. Settlement-chooses-WHAT — now spoken as `indexes` — survives untouched.

### 4. The canonical cross-phase route, and the precondition that bounds it

When a lane has a spec — an independent to-spec/transcription turn — THE spec
carries the `grounds` into the decision flow, and implementation artifacts
reach the decision through it (artifact —`consume`→ spec —`grounds`→ decision)
[S15069/T1236]. One route per flow across the decision→delivery seam:
minimality applied exactly where the two layers touch.

**Precondition** (peer finding 1, production-measured): the route exists only
when the lane has an INDEPENDENT delivery-phase spec turn. Where design and
spec-writing merged into ONE turn — the T900 shape, `design+ops` — artifacts
KEEP their direct `grounds`. A mechanical re-route there is phase-illegal
(`consume` is same-phase, and a pure-delivery artifact cannot consume a
pure-decision turn) and degenerates into self-grounds. The T936→T910 and
T946→T912 class stays direct; re-routing is per-case at review, never in bulk.

### 5. Minimality is NAVIGATION, not entailment — with an invalidation-review counterpart

An edge is redundant, and may be deleted, when a canonical route already makes
its targets FINDABLE. The graph never claims liability composes along a route:
`consume`∘`grounds` does not entail `grounds`, and `indexes` does not entail
`consume` [S15069/T1241, resolving peer finding 2].

The concrete dedup this licenses: an indexed target is never also consumed —
`indexes` subsumes `consume` on that pair exactly as `extends` already does.

The counterpart that keeps navigation-minimality honest is the
**invalidation-review protocol**: when a decision is overridden or an edge
retracted, review expands the candidate taint set along reverse `grounds` and
the canonical seams (consume-into-spec, indexes membership), then judges each
candidate BY CONTENT. No automatic contagion — ADR-0010's non-contagion ruling
is unchanged, and retraction and re-judgment remain acts of judgment written
back as edges.

ROUTE multiplicity is what gets minimized. KIND multiplicity on one pair stays
legal whenever each relation states a fact the others cannot derive
(`override`+`refutes`, the T1072 precedent).

### 6. The node set: rolled-back is deleted, skipped is dormant

A rewound turn (`was_rolled_back`) is DELETED: never a node, never an edge
endpoint, never in an invariant or the visualization, permanently.

`status='skipped'` is NOT deletion (peer finding 5). It is a reversible
lifecycle floor — a late note promotes the turn back to `extracted`, and this
amendment's own source turns sat skipped while their notes were pending.
Skipped turns are DORMANT: absent while skipped, restored WHOLE — stored edges
included, no re-judgment — the moment they are promoted.

One shared predicate serves every read side (`src/db/turn-liveness.ts`), which
is also the bug fix: flows and citations filtered nothing at all, and
edge-signals filtered half of one half (`was_rolled_back` on the citing turn
only).

### 7. Three graph invariants — review-time LINTS, with manual executors in v1

The words are local grammar; these are the graph-level properties the grammar
should make EMERGE [S15069/T1234, T1236]. They are never write-time gates and
never a license to invent edges.

1. **Reachability.** Every effective node reaches its OWN workflow's terminal —
   a settlement, a release, an operational closure. Not every lane ships; ops
   and research lanes legally end at a settlement. Exempt: deleted/dormant
   nodes, overridden victims, and dead-branch members (the override that killed
   the branch IS its closure — peer finding 4). Traversal reads AGAINST the
   stored direction: from a terminal, expand backward over
   narrows/extends/grounds/consume/indexes; `override` joins nothing, since the
   overrider holds its own flow. An unreachable effective node is review DEBT,
   queued for judgment — live example: T915's rewind contracts shaped the view
   spec with no edge into it.
2. **Component emergence.** After cutting fork roots, terminals, and
   no-liability weak ties, distinct workflows should appear as distinct
   connected components. The canonical-seam `consume` (one whose target itself
   writes `grounds`; machine-detectable, lane-internal by decision 4) counts as
   a STRONG tie and is NOT cut — peer finding 3: cutting it would shred every
   compliant lane into spec/artifact islands.
3. **Navigation minimality** (decision 5): no edge whose targets a canonical
   route already reaches.

Their three lints — unreachable effective nodes, cross-lane glue edges,
derivable redundant edges — belong to the backfill review and the graph page.
In v1 they have HUMAN executors: not settlement's job, and deliberately not in
the rubric [S15069/T1238, triaging peer finding 6].

### 8. `indexes` scores into the curation key

Being indexed CREDITS the target [S15069/T1240], continuing the T1171
encodes-curation lineage: `indexes` is a scored relation, and `indexes`
in-degree joins the curation key beside `grounds` in-degree. A settlement's
carried members and a release's shipped artifacts gain the signal that the old
release-grounds fan used to confer. Every other key — override zeroing, extends
excess, recency — is untouched and stays with the pending scoring pass.

## Alternatives considered, and why they lost

- **Keep `collects` fenced to decision termini** (ADR-0011 decision 4's status
  quo, one more round). Rejected: it leaves the cross-layer-same-phase cell
  wordless, so the release keeps paying the measured re-derivation cost above,
  and it keeps aggregation legislated per node type — which is precisely the
  shape the two-axis grammar was supposed to end. A fence that has to name
  which node types may aggregate is a rule where a semantic should be.
- **Rename to `call`** (the alternative surface word). Rejected on reading, not
  on taste: `call`'s dominant reading in a codebase is INVOCATION, which is a
  usage stance — the opposite of the representation stance aggregation takes —
  and every teaching surface in this project already spends the word "call" on
  tool invocation. The word would have to be defended against its own context
  at every occurrence.
- **Widen the word but keep the terminus + own-branch hard check** (widen the
  scope, keep the gate). Rejected: the check cannot survive the widening on its
  own terms — a release holds no flow, so the gate would need a per-node-type
  exception, reintroducing the legislation the rename removes. It also keeps
  paying T1227 cause 3's rollback machinery for a condition that review can
  judge better, since terminus drift is a hindsight fact and the gate ran at
  write time.
- **Stored entailment for minimality** (the peer's option under finding 2):
  keep the direct liability edges alongside the canonical route, so the graph
  stores what a route would otherwise have to entail. Rejected [S15069/T1241]
  in favor of navigation + the invalidation-review protocol: storing both makes
  every lane carry the route AND its shortcut, which is exactly the redundancy
  the release measurement condemned, and the honest problem it solves —
  invalidation reaching the right nodes — is a review question, answered by
  expanding candidates and judging by content rather than by pre-storing the
  answer.
- **Make the three invariants settlement's job, or rubric text** (peer finding
  6's fuller reading). Deferred, not adopted, as division of labor
  [S15069/T1238]: settlement judges a 50-turn window, the invariants are
  global properties of a lane; putting them in the rubric would spend injection
  budget on checks the judging pass cannot perform. A settlement candidate
  surface — rendered termini, shipped-artifact sets — is v2.

## Consequences

- **ADR-0011's decision 4 and P1's one-hard-check clause are superseded; the
  rest of ADR-0011 stands.** Both axes, the eight words, the three stances, the
  flow/settlement derivation, and the cross-phase-only `grounds` are unchanged.
- **The data migration is a pure rename.** 18 stored `collects` rows become
  `indexes` and the CHECK constraint is rebuilt to the new word list, rehearsed
  twice on a /tmp copy of the production DB (18→18, 3073 rows in and out,
  second run a no-op). The staleness probe keys on the OLD word still being
  present in stored DDL, never on the new word's absence — the 0.14 sequencing
  lesson.
- **A hand pass is owed after reload**, and it is judgment, not code: re-judge
  the four release turns T998/T1001/T1150/T1218 (retract grounds-to-settlements,
  re-speak consumed work as `indexes`), write the missing artifact-side
  `grounds` where the transitive check exposes a T906-class gap, and re-route
  artifact-grounds ONLY where decision 4's precondition holds.
- **The milestone diff must be quantified, not assumed** (peer finding 7, ruled
  [S15069/T1240]): the release-grounds retraction subtracts curation in-degree
  where the same batch's `indexes` credit adds it, and the batch verification
  reports the net.
- **The graph page loses nodes it used to draw.** On the T900–T1201 window, 23
  of 302 turns leave (16 deleted, 7 dormant) and no edge loses an endpoint.

## Open items

- **The three lints have no machine executor.** v1 runs them by hand over the
  graph page; a settlement candidate surface is v2.
- **Component emergence needs re-measurement on the REWRITTEN graph.** The
  40-component figure on T900–T1201 is an old-law reference: it predates ritual
  v3, and the release's apparent confluence there was largely the old ritual's
  grounds fan.
- **T915-class unreachable effective nodes** are queued as review debt, not
  auto-repaired.
- **Scoring beyond `indexes`' participation** — weights, `narrows`'
  consequence, the override victim's treatment — stays with the scoring pass
  (inherited from ADR-0009/0010/0011).
- **Delivery-layer tag flows** remain v2 (ADR-0011 decision 4's deferred half,
  unchanged by this amendment).
- **The soft-assertion tie-breaker for hedged stance pairs** is unruled;
  empirical cases T1010 and T1101.
