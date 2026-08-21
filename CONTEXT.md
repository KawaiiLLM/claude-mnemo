# claude-mnemo

Persistent memory for Claude Code sessions: an episodic layer of recorded turns and
a semantic layer of task containers, maintained by the agents that do the work.
Vocabulary pinned by the 2026-08-17 segment redesign, the 2026-08-19
edge-ownership redesign, the 2026-08-20 edge-mechanism revision and the
2026-08-21/22 flow-relations and indexes amendments (ADR-0001…0012).

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

**Relation vocabulary (eight words, three stances)**:
Eight relation words, checked by phase (evidence/decision/delivery, as
above) and — for override alone — unrestricted across flow and layer.
Three stances group them by what they ask of the cited turn: JUDGING
(override, narrows, extends, indexes) — after reading me, must the cited
still be read? DEPENDING (grounds, consume) — if the cited were false, what
happens to me? TESTING (verifies, refutes) — did I test the claim, for or
against? override replaces a wrong conclusion (same phase; not limited to
one flow or layer) and terminates the cited branch — the overrider holds
its own flow. narrows and extends hold within one decision-phase flow (both
ends decision-phase, definitional) — a piece is cut / a piece is added,
never strung together by time order alone. indexes is same-phase
aggregation on either layer: this node gathers and represents the
same-phase nodes carrying its effective content, and readers reach them
through it — a decision settlement indexes its branch's carrying members, a
release indexes the artifacts it ships. It is checked for same phase and
nothing else; an indexed target is never also consumed (indexes subsumes
consume on that pair, as extends already does). grounds is cross-phase ONLY
— within one phase, dependency is continuation (narrows/extends) or usage
(consume), never grounds; it absorbed the old encodes. Where a lane has an
independent delivery-phase spec turn, THE spec carries the grounds and the
implementation artifacts reach the decision through it (artifact —consume→
spec —grounds→ decision); where design and spec-writing merged into one
turn, artifacts ground directly — re-routing there would be phase-illegal.
consume is same-phase, cross-flow: I used its product, no liability if it
falls. verifies and refutes require the citing turn to carry an evidence
phase and the cited a decision or delivery phase — never evidence: a
verdict's object is a claim, and evidence's own object is the world (two
measurements that agree are the same fact twice; one that disagrees is
override). Every same-phase word is strictly same-phase, every cross-phase
word strictly cross-phase — no word straddles the two scopes. Only ONE
condition in the whole vocabulary is checked against graph state rather
than field facts, and it belongs to grounds (see Self-citation); every
other graph-derived condition warns, or is left to settlement review.
_Avoid_: nine-cell grammar, per-word phase table, refines/encodes/collects/
depends-on/grounded-on/evidence-for/evidence-against (retired — refines
split into narrows+extends, depends-on split into consume+indexes, collects
renamed indexes and widened from a decision flow's own terminus to
aggregation on either layer, encodes merged into grounds, evidence-for/
-against renamed verifies/refutes, grounded-on renamed grounds)

**Flow**:
A branch of decisions joined by narrows/extends edges — not a connected
component, and not stored: a derived view, recomputed on read, invalidated
by any retraction. A flow's settlement is the branch node nothing further
narrows or extends (a different sense of "settlement" than the asynchronous
Judging pass above). override terminates a branch — the overrider holds its
own flow rather than joining the branch it killed; a dead branch has no
terminus, and no write-time gate enforces that any more — whether a dead
branch's members may still be indexed is a judgment settlement review owns,
and a surviving mid-branch conclusion stays reachable directly, by grounds.
Delivery and evidence turns hold no flow of their own — they inherit
through the grounds/consume/indexes edges they write, which is how a
release reaches the lanes it ships. Segments never enter the graph as relation nodes: a flow
is the emergent subgraph a segment's member turns carve among themselves,
the segment stays their container.
_Avoid_: workflow as a stored or explicitly named object, connected
components as the flow definition (retired — a flow is branch topology via
narrows/extends, not graph connectivity)

**Live turn (deleted / dormant)**:
Which turns are graph nodes at all, under one shared predicate every read
side consumes. A rewound turn (`was_rolled_back`) is DELETED — permanently
never a node, never an edge endpoint, never in a signal or the
visualization. A `status='skipped'` turn is DORMANT, not deleted: skipping
is a reversible lifecycle floor, so the turn is absent while skipped and
restored WHOLE — its stored edges included, no re-judgment — the moment a
late note promotes it back. Everything else is live.
_Avoid_: treating skipped as deletion, per-read-side liveness filters

**Multi-phase turn**:
A turn whose type set spans more than one phase. Each phase judges its own
edge toward a target independently, under that phase's own row in the
relation vocabulary; when two of a turn's phases each legitimately earn an
edge toward the same target, both are written — two true statements from
two different halves of one turn, not an ambiguity to resolve.

**Self-citation**:
A turn citing itself — grounds only, legal iff the turn is both a flow's
settlement (the point nothing further narrows or extends it) and that
settlement's own implementer. Fully machine-checkable: two structural
facts, no content judgment call. Nothing else self-cites.
_Avoid_: cross-phase self-citation gated by an "independently exhibitable
artifact" (retired — self-citation narrows to grounds at settlement plus
implementer, checked structurally instead of by content)

**text-ref**:
Best-effort extraction of turn addresses from prose — a display hint only, never
a relation substrate. Persists as the pair's bare row, which lives and dies with
the prose that names it; relation rows never do.
_Avoid_: upgrading (the retired path from bare pair to relation)

**Release chain (发布链)**:
The ritual every release turn performs: index the delivery artifacts it
ships, and consume the previous release when one exists — the first release
is the chain's legal root. Lineage is usage, not representation, which is
why the chain itself stays consume. A release writes NO grounds to decision
settlements: the decision linkage is transitive through the artifacts,
which already ground on the rulings they carry, so a gap there is a missing
artifact-side edge to repair rather than something for the release to
re-derive. Curation is no longer split: the release chooses nothing about
which settlements matter, each settlement chooses WHAT within its own flow
(indexes), and the release's own choice is only which artifacts shipped.
_Avoid_: depends-on/encodes (retired — a release ships via indexes and
chains via consume), a release grounding on the settlements it fixes
(retired — release-time re-derivation of what the artifact layer already
recorded)

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
