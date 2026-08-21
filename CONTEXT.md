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

**Relation vocabulary (eight words, three stances)**:
Eight relation words, checked by phase (evidence/decision/delivery, as
above) and — for override alone — unrestricted across flow and layer.
Three stances group them by what they ask of the cited turn: JUDGING
(override, narrows, extends, collects) — after reading me, must the cited
still be read? DEPENDING (grounds, consume) — if the cited were false, what
happens to me? TESTING (verifies, refutes) — did I test the claim, for or
against? override replaces a wrong conclusion (same phase; not limited to
one flow or layer) and terminates the cited branch — the overrider holds
its own flow. narrows and extends hold within one decision-phase flow (both
ends decision-phase, definitional) — a piece is cut / a piece is added,
never strung together by time order alone. collects names a flow's own
minimal set: the citing turn must itself be the point in its branch nothing
further narrows or extends, and every target must be a member of that same
branch — never inherited from elsewhere (the one condition checked against
graph state, not just field facts). grounds is cross-phase ONLY — within
one phase, dependency is continuation (narrows/extends) or usage (consume),
never grounds; it absorbed the old encodes. consume is same-phase,
cross-flow: I used its product, no liability if it falls. verifies and
refutes require the citing turn to carry an evidence phase and the cited a
decision or delivery phase — never evidence: a verdict's object is a claim,
and evidence's own object is the world (two measurements that agree are the
same fact twice; one that disagrees is override). Every same-phase word is
strictly same-phase, every cross-phase word strictly cross-phase — no word
straddles the two scopes.
_Avoid_: nine-cell grammar, per-word phase table, refines/encodes/
depends-on/grounded-on/evidence-for/evidence-against (retired — refines
split into narrows+extends, depends-on split into consume+collects, encodes
merged into grounds, evidence-for/-against renamed verifies/refutes,
grounded-on renamed grounds)

**Flow**:
A branch of decisions joined by narrows/extends edges — not a connected
component, and not stored: a derived view, recomputed on read, invalidated
by any retraction. A flow's settlement is the branch node nothing further
narrows or extends (a different sense of "settlement" than the asynchronous
Judging pass above). override terminates a branch — the overrider holds its
own flow rather than joining the branch it killed; a dead branch has no
terminus, so nothing may collect it, though a surviving mid-branch
conclusion is still reachable directly, by grounds. Delivery and evidence
turns hold no flow of their own — they inherit through the grounds/consume
edges they write. Segments never enter the graph as relation nodes: a flow
is the emergent subgraph a segment's member turns carve among themselves,
the segment stays their container.
_Avoid_: workflow as a stored or explicitly named object, connected
components as the flow definition (retired — a flow is branch topology via
narrows/extends, not graph connectivity)

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
The ritual every release turn performs: consume the work it ships, ground
on the settlements it fixes in place, and cite the previous release when
one exists — the first release is the chain's legal root. A release does
not collect: collects belongs to a flow's own settlement, and a delivery
turn holds no flow of its own to collect within. Curation splits in two
instead — the release chooses WHICH settlements (grounds), each settlement
chooses WHAT within its own flow (collects) — reached transparently in the
one hop grounds already crosses. A delivery turn attempting collects fails
the membership check naturally, with no flow to belong to.
_Avoid_: depends-on/encodes (retired — a release ships via consume, fixes
rulings in place via grounds), a release collecting (rejected for v1 — a
delivery turn has no flow to collect within)

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
