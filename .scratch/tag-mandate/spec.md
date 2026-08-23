# The tag mandate: extends/narrows must name their lane, and legality gets an enforcement ladder

**Rulings:** S15069/T1412 (mandate proposed and assessed), S15069/T1415 (branch
definition v3, error/warning split, commit gate; two clarifications answered:
branch direction = SUPERSET, error set = all five classes).

## Problem Statement

The settlement pipeline has never produced a single lane: every lane in the
database is hand-made fixture work (T900-1001). The T1-100 re-settlement wrote
47 edges — all untagged — because nothing in the grammar ever REQUIRES a lane
to exist, teaching lives only in optional prose, and the checker reports
everything as ignorable facts. Meanwhile continuation relationships
(extends/narrows chains) are latent lanes the graph never names.

## Solution

Three moves, one ladder:

1. **The mandate (grammar):** `extends` and `narrows` lose their untagged
   form. They are the only two words whose semantics IS continuation of a
   line of work — using either means naming the line. The other six words
   keep their legitimate bare uses (override = global repudiation, consume =
   use, indexes = free aggregation, grounds = dependency, verifies/refutes =
   testimony).
2. **The error/warning split (checker):** the checker's findings divide into
   ERRORS — states the grammar forbids — and WARNINGS — the three principles'
   aspirational facts (connectivity, minimality, time-order, undeclared
   lanes). Errors are still reported, never write-blocked mid-flight.
3. **The commit gate (settlement):** the settlement `commit` tool runs the
   legality check over the window's scope and REFUSES to commit while any
   error anchored in the window's writable range remains, naming the
   offending rows and rules. The agent repairs (retag / retract / re-type)
   and retries. Stock cleans itself window by window; no bulk migration.

## Rubric text (the constitution)

- **Mandate sentence:** the Relations section's "Same-phase words MAY carry
  lane tags, none must" becomes: extends/narrows MUST carry lane tags —
  continuation names its line; override/consume/indexes MAY; cross-phase
  words never do.
- **Lane shape:** a lane has exactly ONE start and ONE end (single-source,
  single-sink DAG). Diamonds — parallel paths that re-merge — remain valid
  expression; dangling parallel heads/tails are illegal. Any node may serve
  as the start or end of MULTIPLE lanes.
- **Branch definition v3 (ruled, superset direction):** lane B is a BRANCH
  of lane A when B's start is a node inside A and B's tags are a PROPER
  SUPERSET of A's tags (inherit the whole set, add a word). Inheriting the
  exact set is a REOPEN, not a branch. The machine still knows only exact
  sets; parenthood is narration.
- **Cross-lane correction idiom:** a turn in lane {a} correcting lane {b}'s
  result opens (or joins) a branch rooted at the corrected node — the citing
  turn carries b plus the branch word, the edge carries the branch's set.
  Correcting a lane's result is an event OF that lane's family, recorded as
  such.
- **Identity uniqueness (peer round, T1424):** within one segment, one exact
  edge-tag set names ONE lane; it may not name disconnected components or
  components in different phases. A turn merely carrying those nouns is not
  thereby a lane member — membership comes from the tagged-edge DAG.
- **Whole-lane phase (peer round, T1424):** a lane selects one phase p; every
  member node carries at least one type in p. Edge-local legality under "any
  pairing" does not permit p to change along the chain — a multi-type middle
  node never launders a phase switch.

## Error classes (ruled: all five in the first batch)

| # | State | Notes |
|---|---|---|
| E1 | untagged extends/narrows rows | new ones refused at the write gate; stock repairs at settlement |
| E2 | out-of-vocabulary relation words (e.g. frozen `supersedes`) | already partitioned out of graph computation; now classed error |
| E3 | out-of-vocabulary or EMPTY turn types | exemptions carry over: compact markers, legally-skipped turns; rolled-back turns are not nodes |
| E4 | subset-invariant stock violations (edge tag absent from an endpoint's tags) | can arise from later tag edits; write gate already refuses fresh ones |
| E5 | lane shape: a lane (same segment, exact tag set) with >1 source or >1 sink | disjoint same-set chains auto-join into one lane and become illegal — component emergence hardened into a constraint; repair = retag one chain (fork properly) or bridge/merge |

Warnings (unchanged reports, reclassified): reachability/connectivity,
component entanglement, minimality (interfaces/bypass, path counts),
time-order violations, undeclared lanes, terminus citedness.

## Anchoring and repairability (the deadlock guard)

Every error instance anchors at a turn: an edge error at its CITING turn, a
type error at the turn itself, an E5 shape error at the violating extra
source/sink node. The commit gate counts ONLY instances anchored inside the
window's writable scope (window ∪ DECLARED lookback — see the pull
architecture's immutable writable set) — an error anchored outside blocks
its OWN window, never this one. This keeps every commit
refusal repairable by the agent it refuses: retag, retract and re-type are
all within its writable power. Without this scoping, one bad out-of-window
edge pins a window on a permanently failing commit — the terminal-state trap
(see the burned window_start precedent, S15069/T1410).

## Write gate

The edge validator refuses a tagless extends/narrows at write time, for every
writer (main agent, settlement — one rule, no carve-outs). The rejection
message is the teacher: it names the mandate and the subset invariant
("extends/narrows carry a lane: tag the edge; both endpoints carry the tag").
No graph-state checks at the write gate — legality-of-state lives in the
checker/commit ladder (preserves the indexes-amendment ruling that retired
graph-state write rejections).

## Settlement surface

- **PULL architecture (ruled S15069/T1452):** the pushed window rendering
  RETIRES. The settlement prompt defines the turn RANGE (window ∪ lookback,
  the writable scope) and the duties; the agent reads content itself via
  its own recall/timeline calls — the same way the T1-100 production
  campaign's agent worked. Consequences, all simplifications:
  - Read-grant licensing unifies onto the agent's own recalls (the special
    "rendered-in-full licenses the write" channel retires with the
    rendering; one grant rule for every writer).
  - **The writable set is IMMUTABLE and declared (peer round, T1455):**
    settlement computes the exact writable turn-id set BEFORE the run —
    window + declared lookback — and lists it in the prompt. Recalling a
    turn outside it grants reading only, never writing; the commit gate
    judges error anchors against this SAME immutable set. The declared
    lookback must at least close over the external endpoints of every
    in-scope anchored edge, or repairing an untagged extends/narrows could
    require tagging an endpoint the agent cannot write — the deadlock the
    anchoring rule exists to prevent.
  - **Coverage contract (peer round, T1455) — checklist Step 0:** before
    lane construction, the agent pages through EVERY turn of the writable
    set — metadata/tags/type, content sufficient to judge, and relations;
    a truncated read is continued, never skipped. `timeline` navigates but
    never substitutes for the exhaustive recall and grants nothing. PUSH
    guaranteed whole-window visibility implicitly; without this step PULL
    re-opens the trial's thread-blindness failure. Test-pinned at minimum;
    a commit-visible coverage receipt is the harder option if drift shows.
  - The prompt keeps: rubric, duties, the writable set, roster pointer,
    commit contract. Segment cards and turn content are recalled on demand.
  - HARD DEPENDENCY: edge-read-surface ticket 01 must land first AND meet
    this completeness bar (peer round, T1455): incoming + outgoing edges,
    relation word, canonical exact tag set, counterpart address, direction,
    legacy/out-of-vocabulary rows all visible; pagination and byte caps
    never silently drop edges; and the settlement SDK agent's tool
    allowlist verifiably includes recall. Ticket 01's acceptance is judged
    against this bar. Under pull, the read surface is the agent's ONLY
    view of existing edges — today it renders none.
  - Cost shape flips from one big cacheable prompt to on-demand reads;
    campaign evidence says this is affordable (100 turns ≈ 132 small
    calls), and real windows are half that size.
- **The settlement prompt rewrite is authored by the main agent personally
  (user ruling T1452), never delegated to a worker.**
- **The mandate reaches every teaching surface (ruled T1452), with the
  assertion/retraction split (peer round, T1455):** NEW extends/narrows
  ASSERTIONS are tagged-form-only — taught on the note tool's
  extends/narrows `.describe()` lines (shared zod objects — main agent and
  settlement facade inherit together). `retractExtends`/`retractNarrows`
  KEEP accepting bare addresses: legacy untagged rows must stay deletable,
  and a shared describe rewrite must not caption the retraction mirrors.
  The teaching-surface set, enumerated and acceptance-checked as a whole:
  rubric text, assertion describes, settlement checklist/prompt, skill
  docs, and the write-gate rejection message; plus a guard (test or grep)
  that no surface still shows a bare extends/narrows assertion example.
- The prompt's edges bullet gains the `{turn, tags}` entry form (today it
  teaches only bare addresses — root cause #1 of the zero-lane result) and
  one sentence for the mandate.
- The prompt names the commit contract: commit refuses while in-scope errors
  remain, listing them; `lane_check` stays optional but is the cheap way to
  see the list before commit.
- Commit refusal is not an attempt failure by itself; attempts exhaust only
  on the existing failure paths. The refusal payload lists row ids, rules,
  and anchors.
- **Checklist repairs from the trial's peer round (T1424 — these fix the
  trial's two root causes: stock-repair scope capture and circular
  convergence):**
  1. Step 1 (thread discovery) closes with: discover threads from turn
     content and explicit predecessor language INDEPENDENTLY of existing
     edge stock — a missing edge is work to add, never evidence the thread
     is absent.
  2. Before wiring any edge, judge the CITED CLAIM first: still fully valid
     and added-to = extends; partially withdrawn or bounded = narrows; main
     result replaced = override; merely used = consume. Shared topic,
     temporal adjacency and keeping-a-single-sink are NOT extends evidence.
  3. After identifying a lane, complete its continuation along same-phase
     optional words (override/consume/indexes) too — never truncate the
     lane at the mandatory extends/narrows stock boundary.
  4. Step 5 (convergence) judges from CONTENT, not from existing indexes
     edges: explicit resolved/locked/converged language, completed
     verification, a release, downstream adoption are the evidence to
     check; being the latest node or work merely stopping stays
     insufficient. (The trial declared zero of six lanes; the peer found
     five should close — the worker had used the absence of the fact it was
     supposed to produce as proof the fact was absent.)
  5. Scope self-question before reusing a noun as a lane tag: does this
     exact tag set name the SAME sub-result on both endpoints, and only one
     connected component in one phase? If not, narrow the tag instead of
     riding the topic noun (the trial's dream-agent lane needed model-routing).

## User Stories

1. As the main agent, I want a tagless extends refused with a teaching
   message, so that the correct tagged form is one retry away.
2. As the settlement agent, I want commit to name every in-scope illegal row,
   so that repairing them is mechanical, not archaeology.
3. As the settlement agent, I want out-of-scope errors excluded from my
   commit verdict, so that my window can always converge.
4. As a settlement window over ancient stock, I want untagged extends/narrows
   to force lane construction, so that backfilled history grows real lanes.
5. As the election, I want lanes only where continuation actually exists, so
   that tier-② seats reflect real converged work.
6. As the checker's reader (CLI or console), I want errors visually distinct
   from warnings, so that "must fix" and "should consider" never blur.
7. As a rubric reader, I want the branch definition to state the superset
   direction and the reopen distinction, so that fork/reopen/branch are one
   consistent family.
8. As a writer correcting another lane's conclusion, I want the branch idiom
   documented, so that cross-lane narrows has one canonical shape.
9. As a future release, I want the enforcement ladder (gate → checker error →
   commit) stated once, so that no later feature re-invents a fourth gate.
10. As the user, I want disjoint same-tag chains flagged as one illegal lane,
    so that accidental tag reuse surfaces instead of silently merging lines.

## Implementation Decisions

- Validator change in the shared edge-legality layer both write paths already
  use; the refusal copies the existing rejection-message style.
- Checker: findings gain an `errors` block beside existing reports; existing
  fact blocks reclassify (vocabulary-conformance facts → E2/E3), new
  computations for E1/E4/E5. Both surfaces (CLI digraph, settlement
  lane_check text, console laneCheckText) carry the split.
- Commit gate implements in the settlement commit handler via the same
  loadLaneCheckScope→checkLanes pass the lane_check tool uses — one
  projection, no second semantics.
- Rubric text edits stay within the 9500 budget; guard tests updated.
- Skill docs (mnemo skills) update in the same release (stale-teacher
  constraint).
- Election untouched: it reads lanes as derived; cleaner lanes feed it
  without code change.

## Testing Decisions

- Validator: red on tagless extends/narrows, green tagged; all other words'
  bare forms still pass.
- Checker: unit fixtures per error class (E1-E5), each with an in-scope and
  out-of-scope anchor variant; exemption fixtures (compact, legal skip).
  Golden T900-1001: expect zero errors (the fixture conforms) — any
  discrepancy is STOP-AND-REPORT.
- Commit gate: a window with one in-scope error refuses commit naming it;
  repair then commit succeeds; the same error anchored out-of-scope commits
  clean. Prior art: note-settlement-sdk-query.test.ts's real-handler
  discipline.
- E5: disjoint same-set chains → two sources flagged; diamond fixture → clean.

## Out of Scope

- Bulk stock migration (windows repair as they settle; already-committed
  windows re-enter only via future re-settles or manual campaigns).
- Election/timeline changes.
- Console UI treatment beyond the laneCheckText already shipping.
- Consume-dodge drift (extends is now expensive, consume free): observational
  only — sharper rubric wording on the extends/consume boundary rides along,
  no mechanism.

## Production-campaign amendments (T1440-T1451 — the REAL annotation's lessons)

The T1-100 real annotation (Opus via live tools, two peer rounds, zero
retractions in round 2) surfaced lessons the trials could not. Each lands in
exactly one home:

**Rubric (law — the rubric text ticket must budget for these):**
- R1 *Dead node = global override only, stated:* a TAGGED override's victim
  stays a globally live node. Live does NOT automatically make it a closed
  lane's valid core — the terminus may index the victim ONLY when the
  victim still carries content the terminus's result preserves and
  represents (T32 indexes T31 because T31's spec body survives, revised,
  inside T32 — a content judgment, never a mechanical workaround for the
  self-indexes bar).
- R2 *The consume/grounds phase law the gate already enforces:* `consume`
  expresses SAME-phase use only; `grounds` expresses CROSS-phase
  dependency — the general law, not an evidence→decision special case (the
  validator enforces it; the rubric text currently reads the opposite way).
- R3 *Completion vs correction, the extends/narrows boundary sentence:* "a
  blocker satisfied by doing the work is completion (extends), not a
  correction of the blocking judgment (narrows); narrows requires part of
  the cited CLAIM to be withdrawn" (peer's T60→T54 / T65→T63 ruling).
- R4 *The phase-split idiom, named:* one real arc running decision→delivery
  is TWO lanes (one per phase) hinged by untagged inter-phase `grounds`;
  `consume` may serve as the delivery seam ONLY where multi-type endpoints
  give it a same-phase pairing — it is never a cross-phase relation. The
  grade-hierarchy + task-causality-grading pattern; the most repeated
  friction of the campaign, so a named idiom beats rediscovery.

**Settlement checklist (procedure):**
- C1 *Pure status turns stay laneless; propositions decide:* a turn that
  only records state or polls (watchdog armed, backgrounded) joins no lane
  and never serves as semantic glue. But an ops turn that PROPOSES, ADOPTS
  or CORRECTS a reusable proposition joins the lane for that proposition —
  T45 entered the watchdog lane exactly because its content restated the
  "reliable pattern" claim, which T48 then narrowed. The test is the
  proposition, not the turn's ops surface.
- C2 *Convergence = open questions closed:* a thread whose own flagged
  unknowns stay unaddressed remains OPEN no matter how it tails off
  (skillopt); explicit resolved/converged language, completed verification,
  release, or downstream adoption close it. There is NO primary-source
  threshold — the test is whether the thread's own questions got answered.
- C3 *Mechanics:* retract + tagged re-add compose reliably in one call
  (~30 production uses); relation-only calls need no prose; write member
  tags before edges.

## Trial record (T1417-T1424)

A Sonnet subagent (production settlement model) re-annotated T1-100 under
the amended rubric + improved checklist (.scratch/tag-mandate/trial/).
Mechanical validation: fully green (0 untagged extends/narrows, 0 subset
violations, 6/6 lanes single-source single-sink) — the mandate provably
turns the production model from zero lanes to six. Peer review (T1424):
annotation quality FAILS — thread discovery captured by stock-repair scope
(skillopt, hook-injection/trajectory-data and four back-half workflows
missed), 8 of 16 edge-word judgments wrong (mostly extends that should be
narrows — the cited claim was partially withdrawn), five of six lanes
should have been DECLARED closed (circular convergence logic), one lane
scope too wide (dream-agent → model-routing). Both spec amendments above
and the five checklist repairs come from this round. The trial artifacts
stay as reference fixtures; its output was never written to production.

## Further Notes

- First live stock case: S15069 T1408→T1407 narrows, written untagged minutes
  before the ruling — its window's settlement is the mechanism's first
  end-to-end dogfood.
- First forward-written lanes under the mandate: {tag-mandate} (T1411→T1412→
  T1415→T1417, with T1420/T1421 continuing) and {write-gate} (T1422→T1423),
  this design line's own lanes.
