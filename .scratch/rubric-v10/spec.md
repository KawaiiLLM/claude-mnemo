# Spec: rubric v10 — the lane model (concepts over legislation)

Status: ready-for-agent
Feature slug: rubric-v10
Companion: `draft-lane-model.md` (rev 6, the ruled concept text — the spec's source of truth for semantics; its migration section carries the 15 concrete decisions)
Provenance: user rulings T1277–T1295 (S15069), two measurements (override-joins simulation, tag-intersection rejection), peer round 1 (16 findings; emergence overclaims for release ritual and canonical carrier CONCEDED and re-legislated as explicit axioms; F2/F3/F9/F13 closed by the T1295 rulings; F5/F10 dissolved by the tag-only model).

## Problem Statement

The memory rubric's §Relations has grown by patches into procedural legislation: a
separate reach-rules block, a two-pass procedure, a release ritual, a canonical-route
law — each a corollary written as a statute. Lane (workflow) identity is
machine-derivable only for the decision phase and only through narrows/extends, a
fossil of the pre-unification flow definition; corrections shatter lanes into dead
branches; settlements close by silence, so aggregation edges are never written
forward (measured: settlement wrote zero collects/indexes across nine jobs); the
three graph principles live outside the rubric as manual lints with no generative
role. The user wants concepts defined once and desired graph shapes to emerge, with
tags carrying lane identity — a premise measurement confirmed cannot be derived from
existing tags (44% unique, 40% empty on real edges).

## Solution

Replace §Relations' concept and procedure layers with the lane model, anchored on
ONE interpretation principle: a tagged edge acts on a LANE, an untagged edge acts
on the cited TURN itself — uniform across all words, no special cases. Lanes are
phase-local subworkflows identified by exact tag sets scoped to the segment;
closure is declared explicitly by a tagged indexes edge; a tagged override
continues the victim's lane while an untagged one repudiates the turn's conclusion
globally; the three principles become a fact-reporting check tool; two irreducible
conventions remain as explicit axioms; everything else the old procedure
legislated is either a derivation from the concepts or deleted.

## User Stories

1. As the main agent writing a note, I want each relation word to state its meaning and reach in one line, so that I pick words by semantics instead of consulting a procedure.
2. As the main agent, I want to tag a stance/consume edge with its lane, so that convergence points shared by several lanes stay distinguishable.
3. As the main agent, I want an edge tag that is not a subset of both endpoint turns' tags to be rejected with a receipt naming the missing tag, so that lane membership stays an honest consequence of how turns were actually tagged.
4. As the main agent closing a piece of work, I want to declare convergence by indexing the lane's core valid nodes, so that closure is an explicit act instead of silence.
5. As a release author, I want indexes to stay tag-free, so that shipping artifacts across many lanes carries no lane bookkeeping.
6. As the settlement agent, I want the check tool's findings to enter my existing supply/correct judgment as candidates, so that the graph converges without the main agent hand-writing every closure and without the tool becoming a write obligation.
7. As a reviewer, I want reachability checked mechanically at settlement/review time, so that stranded nodes surface as debt instead of staying invisible.
8. As a reviewer, I want component integrity and minimality as advisory feedback only, so that aspirations never block a legal write.
9. As a reader navigating recall/timeline/graph, I want corrections to continue their lane, so that one line of work reads as one lane with its dead nodes marked, not as fragments.
10. As a reader, I want to reach a whole lane through its terminus (or query its tag), so that citing the representative suffices.
11. As a writer on a forked task, I want the child branch to add a finer tag over the parent's, so that lane hierarchy needs no new mechanism.
12. As a writer at a true merge, I want to carry both lanes' tags forward, so that inseparable-from-here-on is expressed by tag composition.
13. As the validator, I want the taggable word set and phase domains enforced at write time, so that structural legality never depends on later review.
14. As a composite (multi-phase, multi-lane) turn, I want any legal phase pairing to legalize my edge, so that merged steps are not over-analyzed.
15. As the migration operator, I want existing indexes edges untouched and delivery chains to keep their consume words, so that the backfill is tagging and declaring, not re-judging.
16. As the scoring layer, I want curation credit to keep counting grounds ∪ indexes targets, so that aggregation keeps its weight through the model change.
17. As a future session, I want adoption/validity to stay an unstored dynamic judgment anchored on delivery-side citation, so that no registry rots.
18. As the rubric's guard tests, I want the reach/taggability rules parsed from the rubric text itself, so that text and validator cannot drift apart silently.

## Implementation Decisions

**Rubric text (v10).** English; structure: concepts (lane, parent/child lanes, edge
tags, 起点/终点, valid node, valid lane, composite node) → eight words with reach and
taggability inline → three principles with their enforcement layer named in place →
two axioms → judgment-vocabulary list (明显可分离 / 核心 / 被采纳 / 天然汇 / 主要vs部分结果).
The silent-truncation injection cap stays the binding budget; the guard suite keeps
parsing rules out of the rendered text and asserting them against the validator,
including vocabulary exhaustiveness. Refusal/warning mechanics live in the note
tool describes, not the rubric (segment-fields precedent).

**Vocabulary and validator.** narrows/extends phase domain widens from
decision-only to same-phase (the decision-only cage retires with its dead premise);
every same-phase word (override/narrows/extends/consume/indexes) MAY carry lane
tags, none must; cross-phase words never do (lanes are phase-local — derived, not
legislated). A tagged indexes edge is that lane's convergence declaration; an
untagged indexes edge is free aggregation and never closes a lane. An untagged
stance edge is a legal free connection with meaning (an untagged override says
"you are wrong and I do not inherit your lane"). verifies/refutes keep the
evidence-source requirement. Composite nodes: any legal phase pairing legalizes the
edge. The self-citation gate validates against the post-transaction graph (a call
may declare a terminus and self-cite in one legal sequence); self-cites are formal
(connectivity-serving, no substantive semantics) and are excluded from adoption
evidence.

**Edge tag storage and write gate.** An edge assertion is (citing, cited, relation,
immutable canonical tag set) with a surrogate row id; the tag set joins the
uniqueness key, so one pair/relation legally holds several rows — an untagged free
row, an {A} row and a {B} row are independent facts, and two singleton rows are
NOT the merged-lane {A,B} row. Restatement and retraction operate on whole rows;
sets are never unioned across rows. Write gate: tags only on same-phase words, and
the SUBSET INVARIANT — every edge tag must already exist on both endpoint turns'
tags; violation rejects with a receipt naming the missing tag, and there is NO
automatic co-write (the forward flow satisfies the invariant naturally because a
lane member's note carries its lane tag; historical gaps are the migration's to
fill under its own authority). Tag renames preflight a collision report (a rename
that collapses {A,B} into {B} is a human ruling, not a dedupe), then rewrite node
tags and edge tag sets in one exclusive transaction.

**Lane derivation (deriveFlows v2).** A lane is identified by its tag SET, scoped
to the segment: the same tag set inside one segment is one lane, across segments a
different lane. Membership comes from being an endpoint of that lane's tagged
edges — node tags alone never establish membership. Fork children add a finer tag
over the parent's ({P}→{P,c1}); merged continuations carry both sides' tags, the
union being the merged lane's identity ({A}+{B}→{A,B}). To the machine every exact
set is an independent lane; parent/child/merge is HUMAN NARRATION read off the tag
sets (the check tool may offer subset-based grouping as a view, with no
semantics). A single-node lane carries no tag and no machinery; it is consumed
cross-phase directly and is exempt from the valid-lane necessary condition.
Decision-phase cone derivation is replaced by exact-set subgraph derivation across
all phases. Validity is LANE-RELATIVE, per the interpretation principle: a tagged
override revokes the victim's standing in that lane only; an untagged override
repudiates the turn's conclusion globally — every lane whose current terminus it
was loses its terminus; an override under a different tag is another lane's act
and touches this lane not at all. ALL lane events — declarations, overrides,
structural continuations — reduce in one order, the citing turn's position (never
edge write time); the latest declaration is the terminus, and continuing past a
declaration is normal life (the next declaration supersedes it; no intermediate
marker exists). A reopened or repudiated lane is revivable by any later member's
fresh declaration. Cross-segment tagged edges are LEGAL and warn — the boundary
and the workline disagree somewhere, which is the tool's business to surface, not
the write gate's to prevent. Merges are legal shapes, not anomalies. (Simulated on
the corpus: override joining kills no settlement and merges nothing spuriously;
dead branches 4→0.)

**Checks, layered.** Write-time hard rejection ONLY for clear illegality: phase
domains, tag legality (word taggability + the subset invariant), and the self-gate
(validated post-transaction). Everything else belongs to the CHECKER — a
read-only advisory tool, the one place interpretation is encoded, whose input is
a turn range (session or segment view) or a batch of named lanes, and whose
output is exactly FOUR reports: (1) per-lane basic statistics — tag set, segment,
phase, member and dead-node counts, edge counts by word, declaration presence,
latest lane event; (2) each involved lane's member component count within the
SEGMENT-GLOBAL graph (stance + consume + grounds, undirected — aggregation and
testimony never enter, per the ruled domains) — 1 is healthy,
more means the lane's members are severed (principle 1), with representative
members per island; (3) whether one connected component holds several lanes'
members (principle 2 — shared fork roots and merge nodes annotated as designed
shapes, whole-lane entanglement surfaced for judgment); (4) three blocks, per the
T1343 re-aim of principle 3: (a) inter-lane interfaces — per lane pair, the
edge count and how many land on a non-terminus member of a declared cited lane
(bypass; few interfaces and zero bypass are the aspiration); (b) start-to-terminus
path counts — same-phase over the lane's structural edges, and again with
cross-phase citations folded in (two lanes citing across phases counted as one)
— reported as facts with no target; counts above 1 list the fork/join points;
(c) time-order violations — an edge whose citing turn does not postdate its
cited turn (same-session by prompt order, cross-session by wall-clock,
self-citation exempt) breaks the in-lane DAG guarantee and is listed verbatim.
Multi-start lanes sum per-start counts; an undeclared lane is marked in report 1
and skipped in report 4's path block. The tool
reports numbers and names, NEVER candidate edges; the range only decides which
lanes are reported, projection widens to each lane's full live edges, and
partial coverage is declared rather than passed off as absence. Adoption
judgment stays the caller's. The text digraph rendering is human/CLI-only;
agents receive the numeric reports. A scan never rolls back a write, rejects a
declaration, or aborts settlement.

**Axioms (explicit, not emergent — peer-proven undeliverable from the principles).**
A release consumes the previous release; the first is the chain's root. A
decision's cross-phase uptake prefers its spec turn as the carrier when a separate
spec turn exists; other artifacts consume the carrier; WITHOUT a spec turn each
artifact grounds the decision directly. Judgment-executed.

**Adoption.** Valid-lane status is a dynamic judgment, never stored; the strongest
evidence is whether an EXTERNAL delivery node cites the lane's terminus —
self-citations never count.

**Segment tags and note-time membership (ticket 07).** A segment's tags become
hand-curated identity: set at creation, edited deliberately, no longer derived
(type derivation stays). Membership is gated by them — the segment-level twin of
the subset invariant: a turn must carry all the segment's tags to be assigned,
rejection names the gap, nothing is co-written; new assignments only, existing
memberships grandfathered until the backfill. The note tool gains a membership
parameter scoped to segments the session has attached; remember's assign remains
the batch surface. Segment tags never join lane identity, and a lane's tag set is
as small as discrimination allows — most relations live inside one segment, where
its tags discriminate nothing.

**Settlement agent (v2 duty).** The settlement prompt gains the four-report
checker and may run it over its window's lanes after its own first-pass
judgment; what the reports show enters the agent's EXISTING
supply/correct/propose judgment — a severed lane or a missing declaration
becomes a candidate correction, never an automatic write obligation. No new
procedural frame beyond handing it the tool; this resolves the deferred
operationalization.

**Migration.** Fifteen concrete decisions live in the draft's migration section
(rev 6): edge assertions gain surrogate ids and immutable canonical tag sets in
the uniqueness key (multi-row per pair/relation legal; a tag index table serves
queries only, never semantics); the subset invariant replaces every co-write (the
migration retro-tags member turns under its OWN authority before writing edge
rows); rename migrations preflight a collision report for a human ruling, then
rewrite node tags and edge tag sets in one exclusive transaction; existing
untagged same-phase edges enter a judgment queue with a DURABLE per-segment
disposition row written in the same transaction as the judgment (crash-safe,
never re-judged); lane tag minting per segment before backfilling (measured: half
the window's lanes share no common member tag); convergence declarations
backfilled at settled lanes (70 in the reference window hold 7); existing
untagged indexes edges stand as free aggregation retroactively; all lane events
ordered by turn position; segment-batched resumable idempotent backfill with a
before/after recall-visibility diff (lane tags entering turns.tags is a designed
visibility change, reported for human review). Downstream surfaces: flow
derivation consumers, self-grounds gate, mid-flow warning receipts, timeline/graph
rendering, edge-signal scoring (curation key unchanged: grounds ∪ indexes),
settlement writer, migration guards, test baselines. Rehearse the schema migration
twice on a /tmp production copy before release, per standing practice.

## Testing Decisions

Good tests here assert external behavior at existing seams: the rendered rubric
text (guard tests parse rules from it and check the validator agrees — the
established pattern), the note write path (edge writes accepted/refused with the
right receipts), and the pure derivation functions (lane subgraphs, terminus
resolution, override-joins) fed corpus-shaped fixtures. The law-8 read-side
checklist file continues to enumerate every user-visible surface. Migration tests
assert the rename/backfill preserves row counts and integrity on a copied
production DB. The two simulation scripts remain evidence artifacts, not tests.
Verification of any delegated implementation follows the standing rule: mutate the
property the worker declared load-bearing.

## Out of Scope

- Automating the advisory lints (component integrity, minimality) beyond feedback
  rendering; minimality is permanently non-blocking by ruling.
- Any registry or stored state for lane adoption.
- The scoring/eval pass on the rebuilt graph (separate queued work).
- Persona/diary/dream surfaces.
- Historical re-judgment of relation words themselves (the backfill tags and
  declares; it does not re-litigate word choices except where the widened phase
  domains legalize previously-forced substitutes).

## Further Notes

Three peer rounds so far: round 1 (Codex, rev 3, 16 findings), round 2 (Codex,
rev 4, #17–27), round 3 (the local mnemo-review Claude session, rev 5, #28–39).
Each round's P1s were closed by explicit user rulings (T1295, T1300, T1304) and
the surviving text is rev 6; a round 4 on rev 6 + this spec precedes cutting
implementation tickets. The measurement scripts live under /tmp/turn-graph/. The
injection cap is a silent slicer: any rubric growth must re-verify headroom
against the rendered, untruncated constant — round 3 measured the v9 §Relations
slice at ~3.8K chars with ~38 spare, so the v10 rubric text must shed all
migration/tool/mechanics detail to fit (its layering list is the cutting guide).
