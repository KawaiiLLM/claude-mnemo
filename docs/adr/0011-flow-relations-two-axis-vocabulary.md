# ADR-0011 — Two axes, eight words, three stances: flow relations replace the nine-cell grammar's word-choice law

**Status:** accepted · 2026-08-21 · source: S15069 T1198–T1209 (peer session S21460
T93–T112 holds the per-round derivations) · spec: `.scratch/flow-relations/spec.md`
(also carries the measured evidence)

**Superseded in part** (ADR-0012, 2026-08-22, [S15069/T1228]–[T1241],
`.scratch/indexes-rescope/spec.md`): `collects` is renamed `indexes` and
widened to same-phase aggregation on BOTH layers, so read every `collects`
below as `indexes` with its terminus + own-branch conditions dropped —
including decision 1's table row, decision 2's dead-branch sentence, and P3's
transparency clause, which renames with the word and keeps its scope. Two
rulings are overturned outright and marked at their own sections: decision 4
(the release ritual) and P1's "exactly one graph fact" clause. Everything
else — both axes, the eight words, the three stances, flow/settlement
derivation, and `grounds` as cross-phase-only — stands.

## Context

ADR-0010 keyed every relation word off one axis — phase alone (evidence /
decision / delivery) — and filled all nine phase-pair cells. Phase is real
but it is not the only axis relations live on: they also live on LAYER, the
aggregation a relation crosses (decision flow → ticket → release). `encodes`
was a cross-layer word (a delivery turn citing the decision work it carried)
welded onto a cross-phase cell by coincidence, and cross-layer-same-phase
relations — a release citing the commit it shipped — had no home under a
phase-only grammar.

The one-axis grammar's failure was measurable, not theoretical, on the full
T900–T1001 rebuild graph and the production DB (read-only):

- **No workflow emergence.** Connected components glued 81 of 85
  edge-bearing turns into a single blob — against the graph's ruled purpose
  of carving emergent sub-workflows (ADR-0010's own closing framing).
- **Subtraction recorded as addition.** At least three real subtractions —
  T906 killing ticket 13, T952 withdrawing two defenses, T913 narrowing a
  membership domain — were stored as `refines` additions. Recording a
  subtraction as an addition is worse than not recording it: it actively
  misdirects a future reader.
- **Drift at the seams.** 9 of 27 `encodes` edges pointed mid-flow rather
  than at a settled conclusion — `encodes` was carrying two jobs at once
  (cross-layer carriage and cross-phase footing) under one word, so neither
  job's legality could be checked on its own.

## Decision

### 1. Two axes — phase (unchanged) and layer (new) — eight words, three stances

Relations are now checked on phase (ADR-0010's phase system, untouched) AND
layer. ADR-0010's seven words become eight, organized into three stances —
JUDGING (after reading me, must the cited still be read?), DEPENDING (if the
cited were false, what happens to me?), TESTING (did I test the claim, for or
against?):

| word | stance | machine check |
|---|---|---|
| `override` | JUDGING | same phase; flow- and layer-unlimited — the cited conclusion is wrong, this node replaces it, and terminates the cited branch |
| `narrows` / `extends` | JUDGING | both ends decision-phase, same flow (definitional) — a piece is cut / a piece is added |
| `collects` | JUDGING | same phase; the citing turn must itself be its branch's terminus, every target its OWN branch's member — never inherited (the one graph-state rejection) |
| `grounds` | DEPENDING | cross-phase ONLY — within one phase, dependency is continuation (narrows/extends) or usage (consume); absorbs the old `encodes` |
| `consume` | DEPENDING | same phase, flow-indifferent — I used its product, no liability (cross-flow is the typical shape; a same-flow consume is normally subsumed by `extends` under the deletion test — rubric v7's wording is authoritative, S15069/T1217) |
| `verifies` / `refutes` | TESTING | source must carry an evidence phase; target decision or delivery, never evidence — a verdict's object is a claim of another kind, not the world evidence itself measures (S15069/T1215; agreement between measurements is the same fact twice, disagreement is `override`) |

Splits and merges from ADR-0010's seven: `refines` → `extends` + `narrows`;
`depends-on` → `consume` + `collects`; `encodes` merges into `grounds`;
`evidence-for`/`-against` rename to `verifies`/`refutes`; `grounded-on`
renames to `grounds`; `override` survives with its flow limit REMOVED — two
previously-inexpressible corrections (T990→T989 cross-flow, T928→T925
cross-layer) motivated the removal.

`grounds` was retightened to cross-phase-only, at user correction
[S15069/T1209]: the first vocabulary draft left it phase-unrestricted, which
would have let a same-phase dependency claim liability that `narrows` /
`extends` / `consume` already state more precisely, and would have removed
the empty-phase-set rejection channel `grounds` needs to reject nonsense
edges. The retightening changed zero stored rows — both edge classes that
feed `grounds` (renamed `grounded-on`, merged `encodes`) were already
cross-phase in every existing row.

### 2. Flow and settlement replace connected components

A **flow** is a branch of decisions joined by `narrows`/`extends` edges —
not a connected component, and not stored: a derived view, recomputed on
read, invalidated by any retraction. A flow's **settlement** is the branch
node nothing further narrows or extends. `override` terminates a branch —
the overrider holds its OWN flow rather than joining the branch it killed
(T954's branch died to T958's override: T954's flow settles empty-handed,
membership intact; T958 settles separately). A dead branch has no terminus,
so nothing may `collect` it; a surviving mid-branch conclusion is still
reachable directly, by `grounds` — which stores, with the warning that would
normally name a settlement suppressed when there is none to name.

Ticket-01's first arithmetic pass under-counted: 21 connected components
become **24 branches, 23 settled**, once the overrider is correctly split
into its own flow instead of folded into the branch it killed — fork +2,
override +1 over the 21 components (corrected [S15069/T1206]).

Delivery and evidence turns hold no flow of their own — they inherit
through the `grounds`/`consume` edges they write. Segments still never
enter the graph as relation nodes; ADR-0010's [S15069/T1195] ruling stands
unchanged: a flow is the emergent subgraph a segment's member turns carve
among themselves, the segment stays their container.

### 3. Self-citation narrows to `grounds` at settlement + implementer

ADR-0010's cross-phase self-citation gate — legal when a turn's own phase
set spans both a word's source and target phase, gated by an
"independently exhibitable artifact" judgment call — retires. Self-citation
is now `grounds` only, legal iff the citing turn is BOTH a flow's settlement
and that settlement's own implementer: two structural facts, no content
judgment. Nothing else self-cites.

### 4. The release ritual: consume + grounds, no collect in v1

> _Superseded (ADR-0012, 2026-08-22):_ ritual v3 replaces this whole section.
> A release now `indexes` the artifacts it ships and writes NO `grounds` to
> decision settlements — the decision linkage is reached transitively through
> the artifacts, measured on T998 (5 of 8 grounds already derivable in ≤3
> hops; two of the three gaps dissolve, one was a genuine artifact-side
> missing edge). The release chain stays `consume`. The curation split below
> half-reverses: release-chooses-WHICH dies, settlement-chooses-WHAT survives
> as `indexes`. The premise that a delivery turn "holds no flow of its own to
> collect within" is what the widened word retires — aggregation is a
> same-phase act, not a flow-membership one.

A release turn `consume`s the work it ships and `grounds` on the settlements
it fixes in place, citing the previous release; the first release is the
chain's legal root. **A release does not collect in v1** [S15069/T1204]:
`collects` belongs to a flow's own settlement, and a delivery turn holds no
flow of its own to collect within. Curation splits in two instead — the
release chooses WHICH settlements (`grounds`), each settlement chooses WHAT
within its own flow (`collects`) — reached transparently in the one hop
`grounds` already crosses. No special case was needed: a delivery turn
attempting `collects` fails the membership check naturally, since it has no
flow to belong to. If a future release revives delivery-layer tag flows, the
release becomes that flow's collector — the deferred half of this policy,
not a v1 exception.

### 5. The three policies, named

- **P1 — legality is write-time and (almost) two-endpoint.** Rejections
  check field-level facts (phase, self, endpoint kind) plus exactly one
  graph fact: `collects`' own-branch membership, the vocabulary's
  constitutive interface word [S15069/T1202]. Every other graph-derived
  condition warns instead of rejecting — a `grounds` at a mid-flow target
  still stores, and the receipt names the settlement to use instead; edges
  are valid as of write time, and hindsight settlement re-points the warning
  at current termini as flows grow.
  _Superseded in part (ADR-0012, 2026-08-22):_ the "exactly one graph fact"
  clause now names a DIFFERENT fact. `collects`'/`indexes`' own-branch
  membership check retires [S15069/T1232] — `indexes` is checked for
  same-phase and nothing else — and the self-`grounds` settlement+implementer
  condition (decision 3) becomes the vocabulary's one graph-state rejection.
  The rest of P1 is unchanged: legality stays write-time, everything else
  warns, and edges stay valid as of write time.
- **P2 — v1 builds the decision layer only.** Delivery-layer tag flows are
  deferred whole (§Alternatives); the release ritual (decision 4) is the
  decision layer's only delivery-facing mechanism in v1.
- **P3 — transparency runs in the deletion test and the election only.**
  `collects` transparently names what a settlement's citation set covers,
  exactly one hop deep, for the rubric's deletion test and (once scoring
  resumes) the election. Render-side expansion is deferred; the two-hop
  worst case (mid-flow target, no expansion) is compensated by the warning
  carrying the settlement's address.

## Alternatives considered, and why they lost

- **Patch the nine cells per gap** (ADR-0010's own status quo, one more
  round). Rejected for the reason ADR-0010 gave for retiring the seven
  per-word tables in the first place: a per-cell patch fixes the one gap it
  targets while the interaction surface stays global. The measured failures
  (81/85 blob, subtraction-as-addition, 9/27 mid-flow drift) are symptoms of
  a missing axis, not of any one cell being wrong — patching cells cannot
  add an axis.
- **A hard rejection on every graph-derived condition** (reject any edge
  that fails a graph-state check, not just field-level facts). Rejected:
  measured to change zero flow counts (23/23) and zero homeless counts
  (5/5) against the softer warn-and-store policy (P1), while costing real
  data — 9 `encodes`/`grounds` edges that legitimately point mid-flow.
  `collects`' own-membership check is the one exception kept as a hard
  rejection, because it is the vocabulary's constitutive interface word.
- **Stored flows** (materializing flow membership as a table instead of
  deriving it on read). Rejected: flows have no identity to corrupt and
  recompute in 2.4 ms over the full DB (12304 turns, 849 edges, 174 decision
  flows) — storage would add a second write path with nothing to keep it
  correct against.
- **Delivery-layer tag flows now** (tickets carrying their own flow
  membership in v1). Deferred whole: measured zero flow computations ever
  consumed a ticket tag on the rebuild graph — all 23 flows are decision
  flows. Building the layer before anything reads it is speculative
  complexity against the project's YAGNI stance.
- **`grounds` phase-unrestricted** (the initial vocabulary draft). Retightened
  same-day at user correction [S15069/T1209] — see decision 1.

## Consequences

- **ADR-0010's word-choice law is superseded; its phase system is not.** The
  phase vocabulary (evidence / decision / delivery), standalone edges
  (ADR-0009), and the non-contagion ruling (`override` does not cascade to
  descendants) all survive unchanged — only the mapping from phase to a
  relation word, and the nine-cell shape itself, are replaced by the
  six-row law above.
- **Scoring stays out of scope.** As under ADR-0010, legality and worth
  remain split: which edges may exist is ruled here, what a legal edge
  counts for is not. The migration's interim key remap (spec §Migration
  item 6: the `refines` key reads `extends`, the `encodes` key reads
  `grounds`) is an accepted stopgap, not a scoring ruling.
- **The migration is data-preserving.** All 114/114 existing edges pass the
  new six-row table under the renames; nothing is deleted or re-pointed —
  the 9 mid-flow-target edges surface through warnings and the settlement
  pass instead.

## Open items

- Scoring (all of it): an out-degree key, `override`'s victim treatment, and
  `grounds` as an election key all wait for the scoring-trio redesign on the
  backfilled graph — unchanged from ADR-0009/0010's open item, now
  inherited here.
- Render-side transparency for `collects` (P3's deferred half).
- Delivery-layer tag flows (decision 4's deferred half; P2's deferred half):
  v2 territory.
