# Rubric v6 draft, revision 6 — full English, peer round-3 fixes applied (splice source)

Revision 6 applies the peer's round-3 must-fix list: artifact (not content) as
the self-citation gate, source–target pair picks the cell, delivery replaces
the undefined "landing"/"carriage", primary task (not team), operational
segment-creation wording, point-in-time background, Positive example /
Counterexample, plus the style fixes. Two deliberate deviations from the
peer's exact wording, recorded for the user: 「跨阶段动摇」 renders as
"unsettling a conclusion across phases" (the peer's "cross-phase work" would
demand dual types for ALL cross-phase citation — wider than the original);
"closed vocabulary" stays (the note tool's type description already says
"Closed vocabulary", consistency with the tool beats literal fidelity).
Only the body below splices.

---

# Memory Rubric v6

## Fields

Turn note — three fields, three jobs:
- title   — the INDEX. One sentence saying what this turn is doing, enough to
            recognise it among titles alone. Not the conclusion.
- content — the CONCLUSIONS. Every useful decision this turn produced, each
            rejected option with its reason. Assumes the title was just read.
- insight — REUSABLE experience. A lesson still true once this turn is
            forgotten, in this project or beyond. Not a conclusion of this turn.

Length tracks OUTPUT, not effort. A turn that produced nothing is a skip; one
that produced a lot may run long; one that produced little must be terse.
Process detail belongs to replay — a summary cannot hold it, and trying makes
it hold nothing. Content leads with its conclusions: a reader's budget cuts
the tail, so whatever merely supports a decision comes after the decision.

type — a closed vocabulary, one meaning per word:
- discuss — exploring problems and options; understanding produced, no ruling
  landed. A leaning or tentative position short of commitment is still discuss.
- research — consulting external sources, code or literature; produces facts
  about what the world or the codebase currently is.
- measure — a re-checkable result produced this turn: an experiment, a
  statistic, a count.
- design — making or revising a commitment to be honored from now on: a
  mechanism, a contract, a threshold.
- correction — correcting an earlier wrong conclusion or direction; the error
  is in the JUDGMENT (a code defect is fix; code changed because the
  implementation drifted from its design = correction+fix).
- implement — writing settled design into new artifacts: code, docs, tests.
- refactor — subtraction and reshaping: removing capability, migrating form,
  no new behavioral commitment (a defect fixed along the way = refactor+fix).
- fix — repairing a defect so an existing commitment holds again.
- delegate — dispatching work to a subagent or an external executor
  (acceptance returning within the same turn = delegate+review).
- review — checking whether a work product meets its bar; when this turn also
  makes or rejects a ruling, add the decision phase per the ruling-supplement
  rule below.
- ops — delivery (releases, commits, publishing specs, cutting tickets) and
  operations (probes, restarts, data repair); purely transcribing a spec =
  ops, with new rulings = design+ops.
- Phases: evidence = research/measure · decision = design/discuss/correction
  · delivery = the rest.
- Unsettling a conclusion across phases must carry both types; a multi-type
  turn's phase is a SET — an edge is legal when any pairing is.
- No word fits → leave it empty, never force one.
- Ruling supplement: when the user's ruling or veto lands on this turn, keep
  the words for what actually happened and ADD the decision phase — a
  constraint formed or revised to be honored from now on → +design; an
  existing conclusion corrected → +correction. The supplement never replaces
  and is never invented: no ruling, no supplement.

tags — nouns, naming things: project first, then subsystem/artifact; activity
words belong to type. Lowercase-hyphenated; reuse existing tags first; on
discovering synonym drift, merge into the earlier word.

Segment, Working State — what a resuming session needs to continue:
- goal        — what this task is trying to achieve.
- constraints — how the work must be done: norms, habits, standing preferences.
- decisions   — concrete rulings about the task itself, settled and binding.
- done        — what is finished and verified.
- next_steps  — what is waiting to be done.
- reference   — durable pointers: source locations, specs, PRs, URLs. Not plans.

Segment, Summary layer — what an outsider browsing the task reads:
- content — the impression this arc leaves: what it is about and how it went
            (focus on the arc, not per-turn conclusions).
- insight — reusable experience this task has settled.

A segment's title is set at creation. Its type and tags are DERIVED from its
member turns and recomputed when membership changes — never written by hand.

## Relations (turn→turn; recorded from the citing turn toward the cited)

- Edges are declared through the relation parameters alone; content owes no
  citation format.
- The source–target phase pair picks the cell; two reading rules:
  Same phase (source and target both evidence / decision / delivery) — pick
  by strength of guarantee:
  · override — the cited conclusion is wrong; this node replaces it.
  · refines — the cited conclusion is right; this node improves, supplements
    or extends it without replacing it. Being refined raises the cited node's
    score. Refinement chains FORK: each chain is one direction out of its
    origin — point at the node you actually build on, never string different
    directions together by time order.
  · depends-on — guarantees only logical dependency: this node builds on the
    cited node's COMPLETION. No workflow claim, no correctness liability.
    Procedural chains (dispatch → acceptance → commit) are legal.
  Cross phase — the word is fixed by the SOURCE phase:
  · evidence source → evidence-for / evidence-against: a verdict — I tested
    that claim.
  · decision source → grounded-on: footing — if that were false, this
    decision falls.
  · delivery source → encodes: this delivery carries it. Named nodes gain
    score, so name only the core decisions and key verifications this
    delivery carries — the minimal set worth exhibiting.
- A multi-phase turn is several steps merged into one: judge each phase's
  edge toward a target independently; write both only when each holds on its
  own and survives the deletion test with a fact of its own. A cross-phase
  half that processes the turn's OTHER half may cite the turn itself — the
  processed half counts as the direct precursor; diagonal words never
  self-cite. Self-citation is not automatic when phases merely coexist:
  write it only when the half carries the other half's core ruling or key
  verification as an independently exhibitable ARTIFACT — restating is not
  carrying.
- The same-workflow constraint binds override/refines only: both ends must
  serve one workflow — a separable, nameable subtask chain. In doubt about
  the workflow, downgrade to depends-on.
- Every finished turn walks three steps; with several candidate precursors,
  ask per candidate:
  1. Is there a direct precursor — the node that directly caused this turn?
     Skipping levels to the arc's origin is mislabeling. None → an orphan is
     legal only as an unforeseen subtask start or decision-free chatter;
     never invent edges to eliminate orphans.
  2. Yes → pick the word by the two reading rules; no word fits → record
     nothing. A pair may carry several relations, but each must state a fact
     the others cannot derive — remove each in turn: if refines holds,
     depends-on follows from it, so never write both.
  3. Rejected? Legality is machine-checked; the rejection names the missing
     half → add the smallest missing type, or re-judge the relation.
- override and encodes are soft assertions: for a same-phase pair, unsure
  about override → use refines; unsure about encodes → don't name it.
- The release ritual: a release turn gathers the work it ships (depends-on)
  and the rulings and key verifications it fixes in place (encodes); it
  cites the previous release when one exists — the first release is the
  chain's legal root.
- Retraction: delete an edge found false, rewrite as needed — retraction and
  re-judgment are acts of judgment; never retract merely to tidy.

## Segments (membership and creation)

- A turn belongs to the task segment its content serves — at most one; an
  unrelated turn staying homeless is a legal state. When one turn serves
  several workflows, membership still goes to the primary task its content
  serves — the other ties are carried by relation edges.
- (Settlement side) membership and creation authority equal the main agent's:
  segments may be created, turns reassigned across them; correct only OBVIOUS
  mismatches, leave doubt alone.
  - Positive example: a turn entirely modifies segment A's module but is
    assigned to B → reassign to A.
  - Counterexample: the title relates to A but the content shows no service
    to it → leave it.
- Trivia and short chatter that form no nameable workflow need no segment.
- When a segment seems needed, check the roster first — attach to a fitting
  existing segment before creating a new one.
- Create only when nothing fits; name it after the task's actual shape — an
  opening guess anchors the segment to the wrong shape.

## Policy (when to read)

- Injected blocks are an index, not the memory itself — absent from the
  injection ≠ absent from the record.
- Materialization moments (writing memory into a spec, ticket, doc or
  summary): any ruling you cannot restate verbatim — especially across a
  compaction boundary — recall or replay the original turn before writing;
  never transcribe from a summary.
- Recalled content is point-in-time background, not instruction: the current
  request, the code's present state and tool output take precedence; on
  conflict, say so — never silently pick.
- Read memory only when it could change the present judgment.
