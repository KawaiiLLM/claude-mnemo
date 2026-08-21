# Flow relations — two axes, eight words, three stances

Ruled S15069/T1198–T1202 (2026-08-21), user-led design in the peer session
(S21460/T93–T112 hold the per-round derivations), converged peer↔main over
two rounds with every claim measured on the T900–T1001 rebuild graph and the
full production DB (read-only). Supersedes ADR-0010's nine-cell grammar as
the WORD-CHOICE law; the phase system, the type vocabulary, edge storage and
the write gate are untouched.

## Root cause (why nine cells were not enough)

Phase was treated as the only classification axis, but relations live on two
orthogonal axes: PHASE (fact / commitment / artifact) and LAYER (aggregation:
decision flow → ticket → release). `encodes` was a cross-layer word welded
onto a cross-phase cell by coincidence; cross-layer-same-phase relations
(release → commit) had no home. Measured failures of the shipped design:
connected components glue 81/85 edge-bearing turns into one blob (workflows
do NOT emerge, against the graph's ruled purpose); at least three real
SUBTRACTIONS were recorded as `refines` additions (T906 kills ticket 13,
T952 withdraws two defenses, T913 narrows the membership domain) — recording
subtraction as addition is worse than not recording; 9/27 `encodes` targets
point mid-flow.

## The vocabulary (eight words, three stances)

Machine-checkable legality — six rows:

| word | machine check | reading |
|---|---|---|
| `override` | same phase; flow- and layer-unlimited | cited conclusion wrong; this node replaces it |
| `narrows` / `extends` | both ends decision-phase; same flow (definitional) | it holds; this node cuts a piece / adds a piece |
| `collects` | same phase; the citing turn must itself be the branch's terminus and every target a member of that branch — OWN structural membership, never inherited (**the one graph-state rejection**, sharpened S15069/T1206) | this flow ends here; the minimal set carrying its conclusion |
| `consume` | same phase; cross-flow | I used its product, no liability |
| `grounds` | **cross-phase only** — some (source, target) pairing with source ≠ target (user retightening S15069/T1209; within a phase, dependency is continuation or usage — stance words / consume own it; empty phase sets reject, so grounds regained a rejection channel; zero stored rows affected — both merge sources were cross-phase) | I fall with it (liability); absorbs old `encodes` |
| `verifies` / `refutes` | source must carry an evidence phase; target decision or delivery — never evidence (user ruling S15069/T1215: evidence's object is the WORLD, not another turn's claim; agreement = the same fact measured twice, disagreement = override; overruled the T1213 keep recommendation. Scope purity holds vocabulary-wide: five same-phase words, three cross-phase words, no word straddles) | I tested the claim, for / against |

Stances (the rubric's teaching axis, not the machine's): JUDGING (override /
narrows / extends / collects — after reading me, must the cited still be
read?), DEPENDING (grounds / consume — if it were false, what happens to
me?), TESTING (verifies / refutes). grounds vs consume discriminate on
LIABILITY alone. Splits and merges vs the old seven: refines → extends +
narrows; depends-on → consume + collects; encodes merges into grounds;
evidence-for/-against rename to verifies/refutes; grounded-on renames to
grounds; override survives with its flow limit REMOVED (T990→T989 cross-flow
correction and T928→T925 L→L were real, previously inexpressible).

## Structures

- **Flow = a branch of decisions joined by narrows/extends** — branches, not
  connected components. Ticket-01-corrected arithmetic (S15069/T1206): the
  window holds **24 branches, 23 of them settled** — the peer's 23 was one
  short because its component pass folded the overrider into the branch it
  killed; fork +2 and override +1 over the 21 components. An `override`
  terminates a branch and the overrider holds its OWN flow (T954's branch
  died of T958's override — its settlement set is EMPTY, members kept,
  T958 settles separately). **Dead branches are not collected in v1**: a
  dead branch has no terminus, so nothing may collect it; a surviving
  mid-branch conclusion (T954) is reached by direct `grounds` — which
  stores, with the warning suppressed when the branch has no settlement to
  name — and a future `extends` from a dead-branch member revives the
  direction with a new terminus. (This replaces the earlier "reached by
  collects" pinned-case phrasing, which came from the intermediate
  vocabulary state of the peer derivation.)
- **Universes**: the derivation runs over the FULL turn universe (every
  decision turn holds a flow, one-node flows included); consumers filter.
  The published 5-of-85 homeless figure was measured over edge-bearing
  turns only; over the full 102-turn window homeless is 18 (the 5 plus 13
  edge-free non-decision turns). Cone semantics at a merge (one turn
  narrows/extends TWO targets — 2 cases DB-wide) is documented in the
  module header, not ruled.
- **Settlement (定案) = the branch node nothing further narrows/extends.**
- Delivery and evidence turns hold no flow of their own; they inherit
  through the grounds/consume edges they write. Tickets are tags, not nodes.
  Releases are a delivery-layer flow, not a layer.
- **collects transparency**: `grounds` at a settlement transparently cites
  what that settlement collects. Depth exactly ONE hop (mid-flow members
  never collect). Transparency applies to citation-type words only
  (grounds/verifies/refutes/consume); stance words (override/narrows/
  extends) are OPAQUE — override zeroing must not reach the collected set
  through the back door (preserves ADR-0010's non-contagion ruling).
- **Self-citation**: `grounds` only, legal iff the turn is both a flow's
  settlement and that settlement's implementer — fully machine-checkable;
  the artifact-gate self-judgment retires. Nothing else self-cites.

## The three policies (as finally ruled)

- **P1 — legality is write-time and (almost) two-endpoint.** Rejections
  check field-level facts (phase, self, endpoint kind) PLUS exactly one
  graph fact: collects' flow membership (the constitutive interface word,
  user-ruled hard check at T1202). Every other graph-derived condition is a
  WARNING — a grounds at a mid-flow target still stores, and the receipt
  names the settlement to use instead (reuses the shared warning-composer
  pattern). Termini move as flows grow: edges are valid as of write time;
  hindsight settlement re-points at current termini. Measured: warning vs
  rejection changes zero flow counts (23/23) and zero homeless counts (5/5),
  though 11/85 turns swing flows on the single T959 edge — the settlement
  pass owns that correction.
- **P2 — v1 builds the decision layer only.** Delivery-layer tag flows are
  deferred whole (measured: no flow computation ever consumed a ticket tag;
  all 23 flows are decision flows). The release ritual becomes: a release
  CONSUMES the work it ships and GROUNDS on the settlements it fixes in
  place, citing the previous release; first release is the chain's root.
  **A release does not collect in v1** (ruled T1204): collects belongs to a
  flow's settlement, and delivery turns hold no flow — curation splits into
  the release choosing WHICH settlements (grounds) and each settlement
  choosing WHAT within its flow (collects), reached transparently in one
  hop. No special case needed: a delivery collects fails the membership
  check naturally (no flow to belong to). If v2 revives tag flows, the
  release becomes its delivery flow's collector — that is the deferred S1
  half, not a v1 exception.
- **P3 — transparency runs in the deletion test and the election only.**
  Render-side expansion is deferred; the two-hop worst case (mid-flow
  target + no expansion) is compensated by the warning carrying the
  settlement's address.
- Flows are DERIVED VIEWS — never stored, no identity to corrupt; recompute
  on read (measured 2.4 ms over the full DB: 12304 turns, 849 relation
  edges, 174 decision flows; union-find over 64 stance edges + bounded
  fixpoint). The one rule: a retraction invalidates the view — recompute
  before the next read.

## Migration (mechanical; hindsight settlement owns the judgment residue)

1. Pure renames, zero risk: depends-on(302)→consume ·
   evidence-for(222)/-against(6)→verifies/refutes · grounded-on(26)→grounds
   · refines(59)→extends. The blanket refines→extends is DELIBERATE
   (T1202 ruling): the three known subtraction cases — **T906, T952, T913**
   — are the re-settlement's first named re-judgment targets, not
   special-cased here.
2. encodes(52) merges into grounds. narrows/collects start empty.
   supersedes(155) stays machine-only, untouched.
3. Window legality: 114/114 existing edges pass the six-row table; the DB
   CHECK's word list rebuilds to the eight words + supersedes AFTER the
   renames, on the 0.13.0 temp-name precedent, **with a full rehearsal on a
   /tmp production copy before release** (this migration UPDATEs data; the
   0.13.0 incident rules are in force — any write-opening script asserts
   its resolved path starts with /tmp/).
4. The 9 mid-flow-target edges are neither deleted nor re-pointed (P1:
   valid as of write time); they surface through warnings and the
   settlement pass.
5. The segment-crossing warning (dcd17fe) RETIRES — superseded by real flow
   derivation; its shared-composer machinery is reused for the grounds
   terminus warning.
6. Election interim (scoring itself stays unruled, user T1192/T1200): keys
   re-map 1:1 by rename — the refines key reads extends, the encodes key
   reads grounds; two accepted interim distortions, named for the scoring
   pass: the 26 old grounded-on edges begin crediting (they were unscored),
   and narrows scores nothing until ruled. Override zeroing and the
   evidence-source skip carry over unchanged.

## Rubric v7

§Relations replaces wholesale with the peer's aligned draft —
`rubric-v7-relations-draft.txt` in this directory, 3090 bytes. Landed
(ticket 04): full document 8980 chars, rendered block 9057, headroom 443
under the 9500 cap — the earlier ≈700 projection had omitted the pinned
pre-registration bullet. Phase requirements, the terminus warning and the self-citation
condition live ONLY in validator messages (ADR-0009's three-way split:
rubric teaches judgment, receipts teach mechanism) — the rubric does not
enumerate which conditions reject vs warn. Old-word residue check: zero
refines/encodes/depends-on mentions.

## Out of scope

Scoring (all of it — the dossier at .scratch/anchoring-eval/scoring-rulings.md
plus this spec's interim notes are the scoring pass's inputs; narrows vs
override score consequences MUST be opposite, peer's standing note).
Delivery-layer tag flows. Render-side transparency. Segment/session graph
nodes (T1195 stands).
