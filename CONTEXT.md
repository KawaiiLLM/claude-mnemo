# claude-mnemo

Persistent memory for Claude Code sessions: an episodic layer of recorded turns and
a semantic layer of task containers, maintained by the agents that do the work.
Vocabulary pinned by the 2026-08-17 segment redesign, the 2026-08-19
edge-ownership redesign, the 2026-08-20 edge-mechanism revision, the
2026-08-21/22 flow-relations and indexes amendments (ADR-0001…0012), the
2026-08-22 lane-model redesign (`.scratch/rubric-v10/`, ruled; ships with v10 —
until that release the CODE still speaks the flow-era semantics), and the
2026-08-23 milestone-election redesign (`.scratch/milestone-election/`,
shipped — a lane-first structural election replaces effGrade-based
milestone selection wholesale).

## Language

### Memory model

**Turn note**:
The episodic record of one conversation turn: its conclusion, the expansion of that
conclusion, and any lesson.
_Avoid_: extraction, summary

**Segment**:
The long-lived semantic container for one task, accumulating across sessions.
Addressed by `E<n>`. Its tags are hand-curated identity — set at creation,
edited deliberately, required of every member — never derived; its type
stays derived from members. Segment tags gate membership and NEVER join
lane identity.
_Avoid_: arc (for this concept), derived segment tags (retired — the
frequency mush carried no identity)

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
A turn's belonging to a segment, decided by the turn's content and gated by
the segment's tags: a member must carry ALL of them, the segment-level twin
of the edge subset invariant — a turn lacking one is refused with the gap
named, never co-written. Assignable at note time toward a segment the
session has attached; `remember` assigns in batch. New assignments only;
pre-gate memberships stand until the backfill retro-tags them.
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
A standalone turn→turn relation declaration, decoupled from note prose. An
edge assertion's identity is (citing, cited, relation, immutable lane-tag
set): one pair/relation legally holds several rows — an untagged row, an {A}
row and a {B} row are independent facts, and two singleton rows are never the
merged {A,B} row; restatement and retraction operate on whole rows, sets are
never unioned. A pair may carry several relations when each states a fact the
others cannot derive (the deletion test); either writer may hard-delete a
wrong one. Written under the citing turn's write authority — the cited turn
need not have been read. Self-edges are illegal by default; see Self-citation.

**Relation vocabulary (eight words, four jobs)**:
Eight relation words, checked by phase (evidence/decision/delivery). Four
jobs sort them by what they ask of the cited turn: JUDGING (override,
narrows, extends) — after reading me, must the cited still be read?
AGGREGATING (indexes) — which nodes do I stand for? DEPENDING (grounds,
consume) — if the cited were false, what happens to me? TESTING (verifies,
refutes) — did I test the claim, for or against? The same-phase words:
override — the cited's main result no longer applies, this node fully
replaces it; narrows — part of it no longer applies, this node corrects;
extends — it still applies, this node adds; consume — I used its product,
no liability if it falls; indexes — this node represents a set of
same-phase nodes and readers reach them through it (an indexed target is
never also consumed — indexes subsumes consume on that pair, as extends
does). The cross-phase words: grounds — I fall with it (where a lane has an
independent delivery-phase spec turn, the spec carries the grounds and
artifacts consume the spec; without one, each artifact grounds the decision
directly); verifies/refutes — the citing turn must carry an evidence phase
and the cited a decision or delivery phase, never evidence (a verdict's
object is a claim; evidence's own object is the world). Every same-phase
word may carry lane tags, none must (see Interpretation principle);
cross-phase words never do, since lanes are phase-local. narrows/extends
are same-phase like their siblings — the decision-only cage was a fossil of
the pre-unification flow definition and retired with it.
_Avoid_: three stances (indexes holds its own job now), decision-only
narrows/extends, nine-cell grammar, per-word phase table, refines/encodes/
collects/depends-on/grounded-on/evidence-for/evidence-against (retired
words — see ADR-0010…0012 for the renames)

**Interpretation principle (统一解读)**:
A tagged edge acts on a LANE; an untagged edge acts on the cited TURN
itself. Uniform across all words, no special cases: a tagged override
revokes the victim's standing in that lane while an untagged override
repudiates its conclusion globally; a tagged indexes declares that lane's
convergence while an untagged indexes is free aggregation (a release
indexing the artifacts it ships). Validity is therefore lane-relative for
tagged kills and turn-global for untagged ones.

**Lane**:
A separable subworkflow inside ONE phase, under a segment. Its identity is
its exact tag SET, scoped to the segment — the machine treats every
distinct set as an independent lane — taking the form of a DAG of tagged
edges over AT LEAST TWO nodes; every node's own tags must contain the
lane's tags. **Single-node lanes do not exist** (upholding v10's
isolated-product rule; the once-floated self-indexes closure clause was
withdrawn): an isolated single-turn product needs no tag, joins no lane,
and still competes for milestone election through in-degree and release
indexing. A lane may start from another lane's node: adding a tag to the
parent's set FORKS a new branch; inheriting the parent's exact tag set
REOPENS a closed lane — the machine knows only exact sets, parenthood is
narration read off tag composition, never stored hierarchy. Lanes never
cross phases; cross-segment tagged edges are legal and warned (the
boundary and the workline disagree somewhere). The system core identifies
no lane, no 起点, no 终点 — interpretation lives in the rubric and is
encoded once, in the checker. Segments never enter the graph as relation
nodes: a lane is the subgraph its tagged edges carve, the segment stays
the container.
_Avoid_: flow (retired — the decision-only branch topology derived from
narrows/extends; superseded by tag-identified lanes across all phases),
workflow as a stored object, connected components as the lane definition,
single-node lanes (retired 2026-08-23 — see Lane state)

**Convergence declaration (收敛宣告 / 终点)**:
A tagged indexes edge closing its lane: the declaring member becomes the
lane's terminus and indexes the lane's core valid nodes. Convergence never
happens by silence. All lane events — declarations, overrides, structural
continuations — reduce in one order, the citing turn's position; the latest
declaration is the terminus, and continuing past one is normal life (the
next declaration supersedes it, no intermediate marker). A terminus
overridden under the lane's own tag reopens that lane, terminus-less until
a fresh declaration; repudiated by an untagged override, every lane it
currently closes loses its terminus. A repudiated or reopened lane is
revivable by any later member's fresh declaration.

**Lane state (closed/open, valid/invalid)**:
Whether a lane's LATEST node is its declared terminus — CLOSED — or not —
OPEN, including a reopened lane pre-redeclaration and a lane that kept
living past its own declaration (a narrows/extends continuation with no
re-declaration is open, not closed, even though a terminus still exists).
A closed lane is VALID while at least one of the terminus's own declared
core members is living, INVALID once the whole indexed core is dead — the
abandonment ritual is repudiate-then-declare: override the wrong
conclusions, then declare closure indexing the dead core, so the terminus
still carries the story. A fizzled lane with no product and nothing to
bury stays OPEN forever — convergence never happened, and undeclared is
the honest state; no machinery marks it. An open lane's `lastDeclarer` is
the citingId of its most recent tagged-`indexes` edge; `null` iff the lane
was never declared at all ("open, no declarer, no seat").
_Avoid_: "valid lane" as a synonym for adopted (see Adoption) — validity
here is a mechanized read of the terminus's own declared core, never
whether the outside took the lane's outcome up

**Adoption (采纳)**:
Whether a lane's outcome was taken up — a dynamic human judgment, never
stored. Strongest evidence: an EXTERNAL delivery node citing the lane's
terminus (self-citations never count). Necessary condition on the graph,
reported by the checker and never enforced: an adopted lane is CLOSED (a
declared terminus exists to cite) — single-node lanes no longer exist, so
the old exemption clause is gone with them.
_Avoid_: "valid lane" as this concept's name (retired 2026-08-23 — `valid`
now names the Lane state entry's mechanized concept, not adoption)

**Milestone election**:
The lane-first structural selection `timeline`'s `milestones` view runs
(`shared/milestone-election.ts`), replacing the retired effGrade/
always-keep chain wholesale — see Election (差额选举) above, a different,
unrelated retired mechanism from the settlement side. Five steps: (1)
candidacy exclusion — a rolled-back or skipped turn, or any node carrying
an `override`/`refutes` in-edge in ANY tag state, leaves candidacy
entirely; (2) five identity tiers, lexicographic, highest wins — ①
untagged-`indexes` writers (releases), ② a closed-valid lane's terminus or
an open lane's last declarer, ③ nodes indexed by an ELECTED tier-①/② node
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
retired 2026-08-23

**Lane checker (校验器)**:
The one place interpretation is encoded — a read-only advisory tool that
guides settlement toward edge completeness. Given a turn range (session or
segment view) or named lanes, it reports four things: per-lane basic stats;
each lane's member component count within the segment-global graph (1 is
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
the theme the retired topic registry once held, and doubles as the lane label
vocabulary under the SUBSET INVARIANT: every lane tag on an edge must already
exist on both endpoint turns' tags — a violation rejects with a receipt naming
the gap, nothing is co-written (the forward flow satisfies it naturally, since a
lane member's note carries its lane tag; historical gaps belong to the
migration). A lane's tag set is as small as discrimination allows, and a
segment's own tags never join it — most relations live inside one segment, so
they discriminate nothing there; they gate membership instead. Activities
belong to `type`, never to tags.
_Avoid_: activity-suffixed hybrids (`segment-design`), a separate lane-tag
namespace or store (rejected — edge tags are a subset of ordinary turn tags)
