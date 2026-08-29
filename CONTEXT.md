# claude-mnemo

Persistent memory for Claude Code sessions: an episodic layer of recorded turns and
a semantic layer of task containers, maintained by the agents that do the work.
Vocabulary pinned by the 2026-08-17 task redesign, the 2026-08-19
edge-ownership redesign, the 2026-08-20 edge-mechanism revision, the
2026-08-21/22 flow-relations and indexes amendments (ADR-0001…0012), the
2026-08-22 lane-model redesign (`.scratch/rubric-v10/`, ruled; ships with v10 —
until that release the CODE still speaks the flow-era semantics), and the
2026-08-23 milestone-election redesign (`.scratch/milestone-election/`,
shipped — a lane-first structural election replaces effGrade-based
milestone selection wholesale), and the 2026-08-29 staged-settlement redesign
(`.scratch/staged-settlement/`, ADR-0014 — settlement splits into a topic pass
and an edge pass, and turns carry a `topic:` subject word).

## Language

### Memory model

**Turn note**:
The episodic record of one conversation turn: its conclusion, the expansion of that
conclusion, and any lesson.
_Avoid_: extraction, summary

**Task**:
The long-lived semantic container, accumulating across sessions.
Addressed by `E<n>`. Its tags are hand-curated identity — set at creation,
edited deliberately, required of every member — never derived; its type
stays derived from members. Task tags gate membership and NEVER join
lane identity.
_Avoid_: arc (for this concept), derived task tags (retired — the
frequency mush carried no identity)

**Topic registry** — _retired_:
The task-grouping registry (a `topics` table plus `segments.topic_id`). Two
mechanisms were recording one kind of information — a mechanism-level synonym
split — so its role collapsed into tags: the theme a topic named is just a tag
on the task. Its schema migration folded every stored name into a bare tag, and
those folded words stay bare — nothing resurrects them.
_Avoid_: "topic" unqualified (the word now names the turn-level subject word
below, which is a different thing that took the same namespace back)

**Topic word (`topic:<word>`)**:
One free word saying what a turn is ABOUT, carried in the turn's own `tags`
under the `topic:` namespace. Written live by the main agent, one per turn, and
supplied as backfill by settlement's first pass. Raw material, not taxonomy:
open vocabulary, drift between neighbouring turns expected and cheap,
consolidation is the topic pass's job and never the writer's. Refused rather
than normalized when malformed, refused when any hyphen-separated token is a
phase word (the orthogonality law: `type` is the phase axis, a subject that
carries its own phase stops being true when the work moves on). PERMANENT: a
whole-set `tags` write that omits an existing one is refused naming it, and the
only removal path is settlement's explicit correction form. Never membership,
never an edge side, never injected and never scored.
_Avoid_: topic tag, topic registry (the retired table above)

**Arc** (also **episode**):
One bounded span of activity inside a Task's history.
_Avoid_: Task (for this concept)

**Session**:
The episodic container for one conversation. Carries no semantic memory.
_Avoid_: task (a session is a slice of one or more tasks)

**Summary layer**:
The Task fields written for outsiders browsing it.

**Working State**:
The Task fields a resuming session needs to continue it.
_Avoid_: working set (that's the attached tasks), summary

**Attachment (挂靠)**:
A session's reference to a task as loaded working memory. Not a lifecycle object.
_Avoid_: binding, subscription

**Membership**:
A turn's belonging to a task, decided by the turn's content and gated by
the task's tags: a member must carry ALL of them, the task-level twin
of the edge subset invariant — a turn lacking one is refused with the gap
named, never co-written. Assignable at note time toward a task the
session has attached; `remember` assigns in batch. New assignments only;
pre-gate memberships stand until the backfill retro-tags them.
_Avoid_: attachment (sessions attach; turns are members)

**Homeless turn (无归属)**:
A turn belonging to no task. Legal — noise stays out of the semantic layer.

**Homeless disposition**:
The durable, per-MEMBER record of a group of turns the topic pass judged to
form one line with nowhere legal to live — a lane exists inside a task and that
pass may not open one. A group record is immutable (same key and fingerprint is
a no-op; a different fingerprint is refused, never updated). A turn's ACTIVE
disposition is the outcome of its highest-transition-sequence EVENT, not of the
newest group covering it: a later pass that homes the turn ends its homeless
state outright, and one that regroups it points at the successor. That
event-reduction is implemented once and is the sole entry point for every
consumer, so a partially-overlapping later judgment supersedes exactly the
members it covers and no more.
_Avoid_: "homeless group is the unit" (retired — a homed supersession creates
no covering group, so a group-level rule would leave the stale record active
forever)

**Roster (花名册)**:
The injected, paginated list of live tasks (title and tags, most recently
active first) that makes attachment and creation read-before-write.

**Proposal**:
Settlement's text-only suggestion that homeless turns form a new task. Never a
database object, never auto-adopted.

### Judging

**Settlement**:
The asynchronous hindsight pass over a finished window of turns (50), holding the
main agent's full write authority inside its range — note prose, type, tags,
membership (creation and cross-task reassignment included), and edges (check,
mint, retract) — plus exactly one extra tool, commit. Judges by the same Memory
Rubric text the main agent reads; corrects the explicit, leaves the doubtful; a
window with nothing to correct completes empty-handed. Runs as TWO passes in
one claim (see below).
_Avoid_: "never a first writer" (retired — a backfill rebuilds edges from zero),
"one call, one window" (retired — the topic pass and the edge pass are two
contexts)

**Topic pass (stage 1)**:
Settlement's first pass, working at WINDOW scope. Audits each turn's own record,
supplies missing topic words, drafts every topic line the window holds, maps
those lines onto the task's existing lanes (a SYNONYM attracts; near-affinity
does not, and a sub-topic stays its own lane), creates the lanes the rest need,
and disposes the rest homeless. Writes the final lane projection under
replacement semantics — a lane word it does not assign is REMOVED. It cannot
reach `commit`, and that is a property of its TOOLSET rather than of its
prompt.

**Edge pass (stage 2)**:
Settlement's second pass, working at lane and pair scope. Reads the transition's
three frozen snapshots and re-derives nothing: writes in-lane edges thread by
thread, one crossing pass, reconciles pre-existing bare drafts, discharges
removed-side debts, retracts homeless-motivated edges with an audit row. Owns
the terminal commit alone — `done`, the cursor advance, the era grant, the final
metrics and the session narrative all land there and nowhere earlier.

**Stage transition**:
The single fenced write transaction between the two passes: stage-1 metrics, the
three snapshots (the writable set with each id's provenance, the ordered
`(task, lane)` worklist with its removed-side debts, and the per-lane member
snapshots), the homeless records, `stage='edges'`, and the next transition
sequence value. NON-TERMINAL — the job stays `claimed` under the SAME claim
generation, so the ownership tuple is `(job, generation, stage)` and a stale
stage-1 context asserting `topics` is refused by the stage alone. The ROW is
authoritative and the dispatch's verdict advisory: a transition that landed but
whose verdict was lost still flows into stage 2 with no attempt spent, and a
dispatch REPORTING a transition the row never took is a deterministic failure.
_Avoid_: "the transition completes the job" (it writes none of done, cursor,
era grant or final metrics)

**Transition sequence**:
A single global monotonic counter, taken inside the transition transaction only
after its fence has passed. It orders stage transitions across jobs and is the
authority for homeless supersession, because job ids are NOT time — overlapping
backfills and manual queues commit out of id order. Read off the job row, never
re-derived as a `MAX()`: jobs cascade-delete with their sessions, so a maximum
would re-issue values.

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
A standalone turn→turn relation declaration, decoupled from note prose. An
edge assertion's identity is (citing, cited, relation, immutable lane-tag
set): one pair/relation legally holds several rows — an untagged row, an {A}
row and a {B} row are independent facts, and two singleton rows are never the
merged {A,B} row; restatement and retraction operate on whole rows, sets are
never unioned. A pair may carry several relations when each states a fact the
others cannot derive (the deletion test); either writer may hard-delete a
wrong one. Written under the citing turn's write authority — the cited turn
need not have been read. Self-edges are illegal by default; see Self-citation.

**Relation vocabulary (seven words, no phase axis)**:
Seven relation words, each saying what the cited node's main result becomes
in light of this node. A word is never checked against either end's phase —
lane-model v12 retired phase pairing from the write gate after measuring it:
with the multi-phase escape hatch open exactly ONE live hand-written edge in
the database was illegal, and 51% were illegal without it, so the hatch was
carrying the axis. verifies — this turn's own result supports the cited
claim; override — the cited main result is overturned, WITHDRAWN or REPLACED
(one word for disproof, retraction, abandonment and replacement alike, so a
check that came out against the cited claim is an override, not a separate
verdict word); narrows — part of it no longer applies, this node corrects;
extends — it still applies, this node adds; grounds — I fall with it (where
a lane has an independent spec turn, the spec carries the grounds and
artifacts consume the spec; without one, each artifact grounds the decision
directly); consume — I used its product, no liability if it falls; indexes —
this node converges a stage and stands for the nodes it points at, readers
reaching them through it (an indexed target is never also consumed by an
untagged edge — indexes subsumes consume there, as extends does). Every word
may carry lane tags and none must (see Interpretation principle).
_Avoid_: three stances (indexes holds its own job now), the four-job
grouping, decision-only narrows/extends, nine-cell grammar, per-word phase
table, a type requirement on verifies, a separate disproof word (merged
into override), refines/encodes/collects/depends-on/grounded-on/
evidence-for/evidence-against (retired words — see ADR-0010…0012 for the
renames)

**Interpretation principle (统一解读)**:
An edge's TWO ENDS each name a lane — the citing end the lane this turn
writes FROM, the cited end the lane the cited turn sits in. The relation is
read across them: the same tag on both ends is ONE lane spanning the edge,
two different tags a legal CROSSING, and the same word under two different
Tasks a crossing too. An end left empty is UNSETTLED, which makes the edge
a DRAFT — accepted when written, refused at commit (E6). Only `indexes`
acts on lane state, and it acts on the CITING end's lane alone. The other
six words change neither the cited node's validity nor any lane's state: an
overridden node stays valid, and its lane keeps whatever state its own
membership gives it.
_Avoid_: "tagged edge" / "untagged edge" as a property of the whole edge,
an override that revokes standing in a lane or repudiates a conclusion
globally, validity that is lane-relative for one kind of kill and
turn-global for another — all retired with v10/v11's set-valued tags
(lane-model-v12)

**Lane**:
A separable, sustainable sub-task under a Task, DECLARED via `remember`
(the lane tier of `create`) rather than derived from graph structure. Its
identity is `(task, ONE tag)` — a single tag, unique within its task, never
a set; the same tag name under two different Tasks is two different lanes.
A member is any turn whose own tags carry the lane's tag; a lane may
legitimately have zero or one member (provisional, not yet grown). A lane
has NO STATE: it is its members and the edges claiming it, and nothing in
the system says whether the work will continue. Lanes are not phase-local: a decision→delivery
arc may be ONE lane, continued across that boundary by any tagged edge;
cross-task tagged edges are legal and warned (the boundary and the workline
disagree somewhere). The system core identifies no lane, no 起点, no 终点
— interpretation lives in the rubric and is encoded once, in the checker.
Tasks never enter the graph as relation nodes: a lane is the subgraph its
tagged edges carve, the Task stays the container. A lane NAME is a SUBJECT and
nothing else: a name whose hyphen-separated tokens include a phase word is
refused at every entry point that mints one — the topic pass's `create` and the
main agent's `retag` at both container tiers — because a subject carrying its
own phase stops being true the moment the work moves on. The predicate governs
NEW names only; names already declared stay grandfathered, and renaming one
AWAY from its phase word is the repair.
_Avoid_: phase/activity-sliced lane names (`…-research`, `…-implementation`),
exact tag SET as identity, forking (adding a tag to a parent's set
to branch a lane), reopening by inheriting a tag set, "single-node lanes do
not exist" — all retired with v10/v11's DAG-derived, set-based model
(lane-model-v12); open/closed as a property of a lane, a lane's terminus,
`latestMember` — all retired with lane state itself
(lane-state-retirement ticket 01); flow (retired — the decision-only branch
topology derived from narrows/extends), workflow as a stored object,
connected components as the lane definition

**Convergence declaration (阶段性收敛)**:
An `indexes` edge says the CITING turn closed out a stretch of work and
cites the batch of nodes that genuinely produced that ONE result — one
`/to-spec` run, one release. It is a fact about a TURN, asked and answered
inside a settlement window: did this turn wrap something up. A lane
converges as often as it has phases, so several of its members may each
declare one and none of them supersedes another. A single cited node means
the phase was cut too fine — `lane_check` reports it as a WARNING and no
write path refuses on it, because the count is a per-turn aggregate while
the rows are written one at a time. Convergence never happens by silence.
_Avoid_: "the lane's terminus" (there is no single seat — a latest-wins
reduction over declarations, retired with lane state); closing/reopening a
lane; an `indexes` "declaring the lane its tail names"; an override
unseating anything; a single-target index refused at any gate
(lane-state-retirement ticket 01)

**Adoption (采纳)**:
Whether a lane's outcome was taken up — a dynamic human judgment, never
stored. Strongest evidence: an EXTERNAL node citing a turn that declared an
`index` in this lane (self-citations never count) — a convergence exists to
be picked up. The checker measures none of this: the closed-terminus
citedness line that once did went with lane state
(lane-state-retirement ticket 01), so adoption is read, not reported.
_Avoid_: "valid lane" as this concept's name (retired 2026-08-23); "an
adopted lane is CLOSED" as a necessary condition — there is no closed

**Milestone election**:
The lane-first structural selection `timeline`'s `milestones` view runs
(`shared/milestone-election.ts`), replacing the retired effGrade/
always-keep chain wholesale — see Election (差额选举) above, a different,
unrelated retired mechanism from the settlement side. Five steps: (1)
candidacy exclusion — a rolled-back or skipped turn, or any node carrying
an `override` in-edge in ANY tag state, leaves candidacy
entirely; (2) five identity tiers, lexicographic, highest wins — ①
UNSETTLED-`indexes` writers, an `indexes` edge with BOTH side tags empty
(cross-lane aggregation — releases), ② NOBODY — its "a CLOSED lane's
terminus and nothing else" rule lost its input with lane state, and the tier
is deliberately left empty until lane-state-retirement ticket 02 rules its
replacement rather than given a stand-in that would hide that ticket's
effect, ③ nodes indexed by an ELECTED tier-①/② node
(a two-stage fill — only the budget-bounded winners of ①/② seed this
tier), ④ correctors (override writers, citers of a reversed turn), ⑤
everything else; (3) within a tier, positive in-degree
(`narrows`/`extends`/`consume`/`indexes`/`grounds`/`verifies`, self-edges
included) breaks ties, then out-degree, then the LATER turn; (4) the
renderer's own budget applies unchanged, and an edgeless window degrades
to recent-N — every candidate lands in tier ⑤ at zero degree, so the
later-turn tiebreak alone decides, which IS recency; (5) elected rows
render in TIME order, never score order, and a row's `↳` line lists only
its cited turns that are THEMSELVES elected (non-exclusive — an elected
antecedent can also render as its own row).
_Avoid_: effGrade-based selection, the always-keep chain (endpoints ∪
correctors ∪ reversed ∪ era-G4), era gating as a candidacy signal — all
retired 2026-08-23; a second tier-② seat for an open lane's last declarer,
and the "closed-valid" qualifier on the terminus seat — both deleted with
valid/invalid (lane-model-v12 ticket 04); the `closed-terminus` tier reason
itself, deleted with lane state (lane-state-retirement ticket 01)

**Lane checker (校验器)**:
The one place interpretation is encoded — a read-only advisory tool that
guides settlement toward edge completeness. Given a turn range (session or
task view) or named lanes, it reports four things: per-lane basic stats;
each lane's member component count within the task-global graph (1 is
healthy — principle 1); whether one component holds several lanes'
members (principle 2); and a three-block fourth report: inter-lane
interface counts with terminus-bypass edges (few and zero are the
aspiration — principle 3), start-to-terminus path counts as untargeted
facts, and time-order violations (an edge citing the future; the in-lane
DAG guarantee). It reports numbers and
names, never candidate edges; findings enter settlement's existing
judgment, and partial coverage is declared, never silently passed off as
absence. The text digraph rendering is for humans at the CLI; agents get
the numbers.

**Live turn (deleted / dormant)**:
Which turns are graph nodes at all, under one shared predicate every read
side consumes. A rewound turn (`was_rolled_back`) is DELETED — permanently
never a node, never an edge endpoint, never in a signal or the
visualization. A `status='skipped'` turn is DORMANT, not deleted: skipping
is a reversible lifecycle floor, so the turn is absent while skipped and
restored WHOLE — its stored edges included, no re-judgment — the moment a
late note promotes it back. Everything else is live.
_Avoid_: treating skipped as deletion, per-read-side liveness filters

**Multi-phase turn (复合节点)**:
A turn whose type set spans more than one phase, or that serves several
lanes at once. Phase legality is loose by design: any legal pairing
legalizes the edge, merged steps are not over-analyzed per phase. When two
of a turn's phases each legitimately earn an edge toward the same target,
both are written.

**Self-citation**:
A turn citing itself — a formal, connectivity-serving edge with no
substantive meaning, allowed for the composite node that both closes a
lane and implements that closure. Validated against the post-transaction
graph (one call may declare the terminus and self-cite in a legal
sequence); excluded from adoption evidence. Nothing else self-cites.
_Avoid_: the retired structural settlement-plus-implementer gate checked
against the pre-write graph

**text-ref**:
Best-effort extraction of turn addresses from prose — a display hint only, never
a relation substrate. Persists as the pair's bare row, which lives and dies with
the prose that names it; relation rows never do.
_Avoid_: upgrading (the retired path from bare pair to relation)

**Release chain (发布链)**:
An explicit AXIOM (peer review proved it underivable from the three
principles): a release indexes the delivery artifacts it ships — untagged
free aggregation, lane-independent — and consumes the previous release when
one exists, the first being the chain's legal root. A release writes NO
grounds to decision settlements: the decision linkage is transitive through
the artifacts, which already ground on the rulings they carry, so a gap
there is a missing artifact-side edge to repair rather than something for
the release to re-derive.
_Avoid_: depends-on/encodes (retired), a release grounding on the
settlements it fixes (retired), presenting the ritual as emergent from the
principles (conceded — it is minimal explicit legislation)

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
turn field, a bigger `pageBudget` for a task card's rows, and a
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
A turn's position in a task's chronological render. Selection-only: attaching an
earlier turn later shifts every ordinal after it.
_Avoid_: citing an ordinal

### Tools

**note**:
The main agent's episodic write surface (记录): turn notes. The session's title and
content belong to settlement.

**remember**:
The main agent's semantic write surface (记住): task creation, attachment, and
field maintenance.
_Avoid_: the retired 0.x remember (merged into note)

**Write mode (write/edit)**:
The one vocabulary both write surfaces share. `write` replaces a field whole;
`edit` swaps an exactly-matched span inside it, rejecting a miss or an ambiguous
match rather than guessing.
_Avoid_: overwrite, append, replace (the two retired vocabularies it replaces)

**Tag**:
A noun naming a thing — the project first, then subsystems or artifacts. Carries
the theme the retired topic registry once held, and doubles as the lane label
vocabulary under the SUBSET INVARIANT: every lane tag on an edge must already
exist on both endpoint turns' tags — a violation rejects with a receipt naming
the gap, nothing is co-written (the forward flow satisfies it naturally, since a
lane member's note carries its lane tag; historical gaps belong to the
migration). A lane's tag set is as small as discrimination allows, and a
task's own tags never join it — most relations live inside one task, so
they discriminate nothing there; they gate membership instead. Activities
belong to `type`, never to tags.
_Avoid_: activity-suffixed hybrids (`task-design`), a separate lane-tag
namespace or store (rejected — edge tags are a subset of ordinary turn tags)
