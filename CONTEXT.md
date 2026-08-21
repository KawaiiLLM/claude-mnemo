# claude-mnemo

Persistent memory for Claude Code sessions: an episodic layer of recorded turns and
a semantic layer of task containers, maintained by the agents that do the work.
Vocabulary pinned by the 2026-08-17 segment redesign, the 2026-08-19
edge-ownership redesign and the 2026-08-20 edge-mechanism revision
(ADR-0001…0009).

## Language

### Memory model

**Turn note**:
The episodic record of one conversation turn: its conclusion, the expansion of that
conclusion, and any lesson.
_Avoid_: extraction, summary

**Segment**:
The long-lived semantic container for one task lane, accumulating across sessions.
Addressed by `E<n>`.
_Avoid_: arc (for this concept)

**Topic** — _retired_:
The segment-grouping registry. Two mechanisms were recording one kind of
information — a mechanism-level synonym split — so its role collapsed into tags:
the theme a topic named is just a tag on the segment.

**Arc** (also **episode**):
One bounded span of a task's activity inside a segment's history.
_Avoid_: segment (for this concept)

**Session**:
The episodic container for one conversation. Carries no semantic memory.
_Avoid_: task (a session is a slice of one or more tasks)

**Summary layer**:
The segment fields written for outsiders browsing the task.

**Working State**:
The segment fields a resuming session needs to continue the task.
_Avoid_: working set (that's the attached segments), summary

**Attachment (挂靠)**:
A session's reference to a segment as loaded working memory. Not a lifecycle object.
_Avoid_: binding, subscription

**Membership**:
A turn's belonging to a segment, decided by the turn's content.
_Avoid_: attachment (sessions attach; turns are members)

**Homeless turn (无归属)**:
A turn belonging to no segment. Legal — noise stays out of the semantic layer.

**Roster (花名册)**:
The injected, paginated list of live segments (title and tags, most recently
active first) that makes attachment and creation read-before-write.

**Proposal**:
Settlement's text-only suggestion that homeless turns form a new segment. Never a
database object, never auto-adopted.

### Judging

**Settlement**:
The asynchronous hindsight pass over a finished window of turns (50), holding the
main agent's full write authority inside its range — note prose, type, tags,
membership (creation and cross-segment reassignment included), and edges (check,
mint, retract) — plus exactly one extra tool, commit. Judges by the same Memory
Rubric text the main agent reads; corrects the explicit, leaves the doubtful; a
window with nothing to correct completes empty-handed.
_Avoid_: "never a first writer" (retired — a backfill rebuilds edges from zero)

**Backfill (补结算)**:
Operator-triggered settlement over an already-covered or pre-watermark range,
rebuilding its edges from zero. At a plugin update nothing auto-settles: every
turn already finished at that moment is manual-only territory.

**Election (差额选举)** — _retired_:
The competitive three-tier ranking settlement once ran. Machinery deleted
(edge-ownership redesign); old grades stay stored and readable, old-era turns exit
milestone rendering.
_Avoid_: grading, scoring (the legacy absolute 0–4 semantics)

**ops (type word)**:
Delivery (release, commit, publishing a spec or tickets) plus operations (health
probes, restarts, data repair). Pure spec transcription is ops; carrying a new
ruling too makes it design+ops.

**Citation floor**:
The rule that a summary-layer claim exists only with a turn citation.

**Era**:
A semantics boundary in stored data; reads never mix the two sides.

### Citation graph

**Edge (关系边)**:
A standalone turn→turn relation declaration, decoupled from note prose. A pair
may carry several relations when each states a fact the others cannot derive
(the deletion test); either writer may hard-delete a wrong one. Written under
the citing turn's write authority — the cited turn need not have been read.
Self-edges are illegal by default; see Self-citation for the one narrow
exception.

**Relation grammar (nine-cell)**:
The two reading rules that pick a relation word for any turn→turn edge, keyed
by phase — evidence (research/measure), decision (design/discuss/correction),
delivery (everything else; a multi-type turn's phase is the SET of its types'
phases). Same phase (the diagonal) — a guarantee ladder, strongest to weakest:
override (the cited conclusion is wrong; this node replaces it), refines (the
cited conclusion is right; this node improves, supplements or extends it
without replacing it — refinement chains fork, one direction per origin,
never strung together by time order), depends-on (guarantees only logical
dependency: this node builds on the cited node's completion, no workflow or
correctness claim). Cross phase — the word is fixed by the SOURCE turn's
phase, never the target's: an evidence source speaks
evidence-for/evidence-against (a verdict — this node tested that claim), a
decision source speaks grounded-on (footing — if the cited decision were
false, this node falls), a delivery source speaks encodes (this delivery
carries the cited node; naming is curation, the minimal set worth
exhibiting).
_Avoid_: per-word phase table (retired — one grammar picks the word for every
cell, not a hand-carved exception list per word)

**Workflow (工作流)**:
A separable, nameable subtask chain. Scopes the override/refines stance pair
alone: both ends of such an edge must serve the same workflow, or the edge
downgrades to depends-on. depends-on and the cross-phase words are
indifferent to workflow. Workflows are emergent — subgraphs the relation
edges carve out among a segment's member turns, never stored objects. The
segment is the whole task's memory; the relation graph is its interior
structure. Segments never enter the graph as relation nodes.
_Avoid_: reifying workflows; segment-level relation edges

**Multi-phase turn**:
A turn whose type set spans more than one phase. Each phase judges its own
edge toward a target independently; when two of a turn's phases each
legitimately earn an edge toward the same target, both are written — two true
statements from two different halves of one turn, not an ambiguity to
resolve.

**Self-citation**:
A turn citing itself with a cross-phase word — legal only when the turn's own
phase set contains both the word's source phase and a legal target phase for
it, and only when that half carries the other half's core ruling or key
verification as an independently exhibitable artifact (restating is not
carrying). A single-phase turn can never self-cite; the diagonal words
(override/refines/depends-on) never self-cite for anyone — same phase against
yourself states nothing.
_Avoid_: self-loop ban (retired as a blanket rule — narrowed to single-phase
turns and the diagonal words)

**text-ref**:
Best-effort extraction of turn addresses from prose — a display hint only, never
a relation substrate. Persists as the pair's bare row, which lives and dies with
the prose that names it; relation rows never do.
_Avoid_: upgrading (the retired path from bare pair to relation)

**Release chain (发布链)**:
The ritual every release turn performs: depends-on the work it ships, encodes
the rulings and key verifications it fixes in place, and cites the previous
release when one exists. The first release is the chain's legal root.

### Write gate

**Read grant (读授权)**:
A writer's license to write an entity, earned by that entity's content actually
being rendered to it — a recall/timeline call, or an injected block that carries
the content. A pointer line naming an entity is not a render of it.
Entity-level: one appearance licenses every field.
_Avoid_: lock (nothing is held; it's a license check at write time)

**Complete read (完整读)**:
A render that delivered one field untruncated. Writing a field whole over content
ANOTHER writer put there requires one; editing a matched span inside it never
does, and neither does an empty field or content you wrote yourself — the
difference between the two write modes is this read requirement, nothing else.
Which read delivers a field whole is surface-specific: a bigger `turn` cap for a
turn field, a bigger `pageBudget` for a segment card's rows, and a
metadata-selecting recall for a turn's type/tags (a plain recall shows neither).

**Stale (失效)**:
A field another writer touched after the grant; writing it again requires a fresh
read, in either write mode. Error messages distinguish stale from never-granted.

**Writer (写者)**:
The identity a write is attributed to — the caller session for agents, its own
identity for settlement. A field whose last writer is the caller is always
writable (writing is reading).

### Addressing

**Turn address (`S<n>/T<m>`)**:
The only legal citation form for a turn — stable, render-independent.

**Ordinal T (`E31/T3`)**:
A turn's position in a segment's chronological render. Selection-only: attaching an
earlier turn later shifts every ordinal after it.
_Avoid_: citing an ordinal

### Tools

**note**:
The main agent's episodic write surface (记录): turn notes. The session's title and
content belong to settlement.

**remember**:
The main agent's semantic write surface (记住): segment creation, attachment, and
field maintenance.
_Avoid_: the retired 0.x remember (merged into note)

**Write mode (write/edit)**:
The one vocabulary both write surfaces share. `write` replaces a field whole;
`edit` swaps an exactly-matched span inside it, rejecting a miss or an ambiguous
match rather than guessing.
_Avoid_: overwrite, append, replace (the two retired vocabularies it replaces)

**Tag**:
A noun naming a thing — the project first, then subsystems or artifacts. Carries
the theme the retired topic registry once held. Activities belong to `type`,
never to tags.
_Avoid_: activity-suffixed hybrids (`segment-design`)
