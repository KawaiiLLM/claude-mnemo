# Memory Rubric v10 — TRIAL CUT r2 (tag-mandate amendments + peer-round sentences)

Amendments vs production (hash 01578cdba777), per spec .scratch/tag-mandate/spec.md:
1. extends/narrows MUST carry lane tags (the mandate).
2. Lane shape: single source, single sink; branch definition v3 (superset).
3. Cross-lane correction idiom.
Everything else is the production text verbatim.

---

## Fields

Turn note — three fields, three jobs:
- title   — the INDEX. One sentence saying what this turn is doing.
- content — the CONCLUSIONS. Every useful decision this turn produced.
- insight — REUSABLE experience, still true once this turn is forgotten.

type — a closed vocabulary, one meaning per word: discuss, research, measure,
design, correction, implement, refactor, fix, delegate, review, ops.
Phases: evidence = research/measure · decision = design/discuss/correction ·
delivery = the rest. A multi-type turn's phase is a SET — an edge is legal
when any pairing is.

tags — nouns, naming things: project first, then subsystem/artifact; activity
words belong to type. Lowercase-hyphenated; reuse existing tags first.

## Relations (turn→turn; recorded from the citing turn toward the cited)

THE INTERPRETATION PRINCIPLE: a tagged edge acts on a LANE; an untagged edge
acts on the cited turn itself. Every word shares this one reading — there are
no special cases.

A LANE is a separable sub-workflow inside one phase, under a segment,
identified by an exact SET of tags scoped to that segment: a DAG of tagged
edges over AT LEAST TWO nodes, every node's own tags containing the lane's.
A lane has exactly ONE start and ONE end — a single-source, single-sink DAG.
Diamonds (parallel paths that re-merge) are valid expression; dangling
parallel heads or tails are illegal. Any node may serve as the start or end
of MULTIPLE lanes. Lanes never cross phases; only cross-phase relations
connect lanes of different phases.

IDENTITY UNIQUENESS: within one segment, one exact edge-tag set names ONE
lane; it may not name disconnected components or components in different
phases. A turn merely carrying those nouns is not thereby a lane member —
membership comes from the tagged-edge DAG.
WHOLE-LANE PHASE: a lane selects one phase p; every member node carries at
least one type in p. Edge-local legality under "any pairing" does not
permit p to change along the chain — a multi-type middle node never
launders a phase switch.

BRANCHING: lane B is a BRANCH of lane A when B's start is a node inside A
and B's tags are a PROPER SUPERSET of A's tags — inherit the whole set, add
a word. Inheriting the exact set REOPENS a closed lane instead; the machine
knows only exact sets, parenthood is narration. Correcting another lane's
result is done by OPENING (or joining) A BRANCH rooted at the corrected
node: the citing turn takes the corrected lane's tags plus the branch word,
and the edge carries the branch's set.

A lane's tag set is as SMALL as discrimination allows, and the segment's own
tags never join it — they gate membership, not lanes. An isolated
single-turn product needs no tag and joins no lane, and is still cited
cross-phase as usual.

Eight words. extends and narrows MUST carry lane tags — continuation names
its line; override/consume/indexes MAY carry them; cross-phase words never
do:
· override — the cited's main result no longer applies; this node fully
  replaces it. Tagged: an in-lane correction — the lane reopens until a
  fresh declaration. Untagged: a global repudiation of the conclusion.
· narrows  — part of the cited's result no longer applies; this node
  corrects it. ALWAYS TAGGED: the correction is an event of the named lane
  (open a branch for a cross-lane correction, per the branching rule).
· extends  — the cited's result still applies; this node expands or
  supplements it. ALWAYS TAGGED: supplementing a line means being on it.
· consume  — this node used its product and does not answer for it.
· indexes  — convergence, aggregation, indexing: this node stands as the
  representative. Tagged: declares that lane CONVERGED — this node is its
  terminus and indexes the lane's core valid nodes. Untagged: free
  aggregation (a release indexing the artifacts it ships). An indexed node
  is never also consumed, unless both edges carry lane tags.
· grounds  — this node stands or falls with the cited.
· verifies / refutes — a check result produced this turn, for / against the
  cited conclusion; the source must carry an evidence phase.

Convergence never happens by silence: when a lane converges, its terminus
declares it with a TAGGED indexes. The latest declaration wins; continuing
past one is normal life. A lane whose LATEST node is its declared terminus
is CLOSED — VALID while any of its indexed core lives, INVALID once all are
dead; unconverged lanes honestly stay OPEN.
SUBSET INVARIANT: every tag on an edge must already exist on both endpoint
turns' tags — a violation is refused, naming the gap.

A self-citation is a formal edge serving connectivity alone. A skipped or
rewound turn is not a node; a globally-overridden turn is a dead node that
stays in the graph carrying the correction's story. Delete an edge found
false and rewrite as needed — retraction and re-judgment are acts of
judgment, never tidying.

Three principles — aspirations the checker reports as facts:
· Reachability — a lane's members hang together, and a valid lane's
  terminus is cited from other phases, relaying to delivery.
· Component emergence — distinct lanes come out as distinct components.
· Minimality — lanes meet through few edges aimed at each other's termini;
  in-lane edges point to the past; path counts are facts, never targets.

## Segments

A turn belongs to the task segment its content serves — at most one. A
segment's tags are hand-curated identity; lane tags are separate and never
include them. All T1-100 turns in this window are members of E60
(claude-mnemo standing container).
