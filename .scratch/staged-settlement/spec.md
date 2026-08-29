# Staged Settlement — spec (Rev 5)

Status: ready-for-agent
Authority: user rulings [S15069/T1984] [S15069/T1985] [S15069/T1989] [S15069/T1992]
[S15069/T1993] [S15069/T1994] [S15069/T1995] [S15069/T1996] [S15069/T1998].
Feasibility evidence: blind stage-1 simulation [S15069/T1988], fixtures in
`fixtures/`. Review history: round 1 (ten findings, incl. this spec's own
dream-law retry import), round 2 (five P0: ownership tuple, snapshots,
removed-side-citer closure, topic grammar contract, per-member homeless),
round 3 (four P0: post-hoc transition truth, the exhaustive token set,
homeless schema coherence, the membership snapshot); round 4 (four P0: the
era-visible snapshot deadlock, the E3 repairability hole in the widened gate
— the peer correcting its own prior E3 reading, verified against source —
the SQLite NULL-key trap, and the homed-supersession activeness bug). Every
peer source claim verified before adoption.

## Problem Statement

Settlement judges three questions of different natural scopes inside one long
agent run: what each turn did (turn scope), which topic lines run through the
window (window scope), and how a landing relates to its basis (pair scope).
Lane formation — a window-scope judgment — happens at the exhausted tail of a
turn-scope grind, with legacy informal words sitting in view as vocabulary
decoys. The measured result on the S18993 resettlement campaign: four
phase/activity-sliced lanes (`san11-ticket-implementation`,
`san11-live-demo-ops`, `san11-ui-interaction-research`, a 174-member
`san11-mapc-terrain-research` blob) that horizontally shred the vertical lines
edges exist to trace. A ruling settled the purpose: edges exist so a landing
can be traced back to the decisions and designs it rests on, and a lane is one
such traceable line [S15069/T1984]. The current flow makes that outcome
unlikely by construction; a blind same-tier simulation in a clean window-scope
context produced zero phase-sliced groupings on the same data [S15069/T1988].

Secondary diseases with the same root: candidate ledgers die with the context
(crash retries restart from zero); a window holding genuine links but no legal
container would deadlock an armed connectivity gate [S15069/T1979]; tagged
edges collide with pre-existing bare drafts pair by pair instead of being
reconciled wholesale.

## Solution

Split the work by natural scope, with durable artifacts as the interfaces.

- **Live (main agent, per turn)**: alongside the existing note fields, the
  main agent writes one free **topic word** in the `topic:` namespace — "what
  this turn is about" in a word. Raw material, not taxonomy: no closed
  vocabulary, drift across turns is expected and cheap (stage 1 consolidates).
  The word is **permanent** [S15069/T1995]; the standing schema migration that
  strips the retired `topic:` namespace is itself retired (see grammar).
- **Settlement stage 1 — the topic pass (window scope)**: audits notes/type
  (the existing turn-local duty), supplies missing topic words (backfill),
  drafts ALL topic lines of the window from topic words + notes, then observes
  the task's existing lanes: an existing lane is reused **only for a
  synonym** — near-affinity does not attract; a **sub-topic stays an
  independent lane**; missing lanes are created; a group with no legal task
  container is disposed **homeless**, recorded durably per member. Lane tags
  are written onto members under the final-projection rule. Ends in the
  **stage transition** — one fenced, non-terminal transaction.
- **Settlement stage 2 — the edge pass (lane/pair scope)**: works ONLY the
  snapshots the transition persisted (worklist + writable set + lane-member
  snapshots); for each listed lane, reads its members as a coherent thread and
  writes in-lane edges; one crossing pass for legitimate cross-lane edges;
  reconciles pre-existing bare drafts per pair and discharges removed-side
  debts. All heavy gates run at this terminal commit, which alone writes
  `done`, the cursor advance, the era grant and the final metrics. The commit
  report carries the **shape numbers** (v1); edge shape audits the partition,
  never sources it [S15069/T1993].
- **Lane-count pressure** [S15069/T1998]: settlement is NEVER constrained by
  the lane threshold. At/over 50 declared lanes on a task, every message in
  sessions attached to that task receives an injected reminder; the MAIN
  agent proposes merge plans to the user via AskUserQuestion and never
  consolidates on its own.

## User Stories

1. As the memory system's user, I want lanes to be topic lines I can trace a landing backward through, so that "how did this ship and on what basis" is answerable inside one lane.
2. As the user, I want lane names that stay true across a line's whole life, so that a line moving from research into delivery never invalidates its own name.
3. As the main agent, I want to record what a turn is about in one free word at write time, so that the author's in-the-moment knowledge is captured instead of reconstructed.
4. As the main agent, I want the topic word exempt from the closed tag vocabulary, so that recording a topic never requires opening a container or asking anyone.
5. As a future reader, I want topic words retained permanently — surviving lane reorganizations AND schema reopens — so that the turn's original subject stays searchable.
6. As the settlement agent, I want to judge the window's topic lines in a context whose only job is that judgment, so that phase-slicing temptations of sequential grind don't shape lane identity.
7. As the settlement agent, I want existing lanes to attract only synonyms, so that a legacy word's mere existence never pulls new work into an old taxonomy.
8. As the settlement agent, I want sub-topics to stand as independent lanes, so that fine structure survives and consolidation stays a later, explicit, user-ruled merge.
9. As the settlement agent, I want homeless dispositions recorded per member, so that partially-overlapping later judgments supersede exactly the members they cover.
10. As the stage-2 agent, I want my worklist, writable set and lane memberships frozen by the transition, so that my duties, my authority and my graph's vertices are read, never re-derived.
11. As the stage-2 agent, I want to read every fact I write on myself, so that no grant earned by another context authorizes my pen.
12. As the stage-2 agent, I want authority over the citers of edges my own stage 1 made illegal, so that the job that created a debt is the job that can discharge it.
13. As the scheduler, I want a post-hoc truth rule for stage-1 dispatches, so that a transition that landed but whose verdict was lost still flows into stage 2 without a false failure.
14. As the operator, I want each stage to resume from its own durable boundary under the standing retry law, so that a crash never resends finished judgment work.
15. As the operator, I want the stop hook to resume a broken stage chain, so that recovery is event-driven with no polling loop.
16. As the user, I want lane-count pressure surfaced to me as merge proposals, so that consolidation stays my call and never a background rewrite.
17. As a future maintainer, I want the arming of phase connectivity to read the per-member homeless view, so that orphan phases are exempt by record instead of deadlocking the gate — while E6 stays undiminished.
18. As the user, I want the S18993 campaign's diseased output kept as the before-picture, so that the redesign's acceptance is a measured before/after on real data.

## Implementation Decisions

### State machine and ownership (rounds 2-3)

- `note_settlement_jobs` gains a `stage` column (`topics` → `edges`) and every
  stage transition takes the next value of a **monotonic transition sequence**
  (single global counter; also the authority for homeless ownership below).
  The **ownership tuple is `(job, claimGeneration, stage)`** — the write
  fence, the heartbeat, the stop-hook probe and the scheduler all check the
  full tuple. The generation does NOT bump at the transition; a stale stage-1
  context's writes assert `stage='topics'` and fail against `'edges'`.
- The **stage transition** is ONE fenced write transaction: stage-1 outcome
  metrics + the three persisted snapshots (below) + per-member homeless
  records + `stage='edges'` + the transition sequence value. The job REMAINS
  `claimed`. It does NOT set `done`, advance the cursor, grant era visibility
  or write final metrics — all four are exclusive to stage 2's terminal
  commit (today's CAS + same-transaction era-grant shape, unchanged).
- The scheduler learns a **transition verdict** distinct from done/failed: a
  stage-1 dispatch returning it launches stage 2 immediately in the same
  drain — no completion, no failure record, no re-claim, no attempt spend.
- **Post-hoc truth rule** (round 3): on EVERY stage-1 dispatch return —
  verdict, failure, or throw — the scheduler re-reads the job row first. If
  the same `(job, generation)` is still `claimed` and the stage has advanced
  from this dispatch's `topics` to `edges`, the dispatch outcome is
  DISCARDED and stage 2 launches immediately under the `edges` tuple: no
  failure accounting, no reclaim, no attempt spend. A generation or status
  mismatch is preemption as today; stage still `topics` means the outcome is
  handled as reported — with ONE amendment ticket 03 surfaced: a dispatch
  REPORTING a transition while the row never advanced is recorded as a
  deterministic failure ("reported a transition that never landed"), never a
  chain and never a completion — the row is authoritative, the verdict
  advisory. This mirrors the existing "payload committed then threw"
  reconciliation.
- Stop-hook recovery: a `claimed` job with a dead heartbeat is reclaimed
  under the standing reclaim law (a reclaim is a new claim and spends an
  attempt); the recorded `stage` decides where the new claimant resumes.

### Retry law (round 1, unchanged)

Inherited verbatim from standing law: `deterministic` failures spend
attempts, total 1+1=2, exhaustion goes `abandoned` with a debt row;
`transient` (network/connection/SQLITE_BUSY) refunds the attempt, uncapped,
event-driven re-trigger. Attempts count at the JOB level; the stage decides
only the resume point.

### Identity and authorization (rounds 1-2)

Read grants, field completeness, relation grants and lane-read receipts are
**stage-scoped** (keyed on the full ownership tuple); stage 2 authorizes
every write with its own reads. The `lane_run_touches` ledger stays
**job-scoped** (its reclaim-inheritance design is exactly why).

### Persisted snapshots (rounds 2-3)

The transition transaction persists THREE job-owned snapshots; stage 2 and
every retry of it READ these and re-derive nothing:

1. **The exact writable turn-id set**, each id classified by provenance
   (window / lookback / closure / removed-side-citer).
2. **The ordered stage-2 worklist**: every `(task, lane)` the final
   projection touched or should link within — including synonym-reused lanes
   with zero stage-1 mutations — plus the removed-side debt list (edge id,
   removed lane, citing turn).
3. **Per-worklist-lane member snapshots** (rounds 3-4; wording per ticket
   04's accepted reading): each worklist lane's member set = **the job's own
   final-projection members drawn from the whole WRITABLE SET (window ∪
   lookback ∪ closure — `removed-side-citer` ids excluded, their relation-only
   authority cannot have laned anything), REGARDLESS of era** ∪ **the
   historical members already era-visible at transition time**. Era-visibility alone must not define the
   set: a pre-era backfill's freshly-laned window members have no grant until
   the terminal commit (the grant stays terminal — moving it earlier would
   publish half-settled windows), so an era-visible snapshot would freeze a
   vertex set missing every new member, the T1964 deadlock shape again.
   These pre-era window members are visible to stage 2 through the job-owned
   snapshot and direct S/T reads only; global visibility still lands at the
   terminal commit. These snapshots are the shape numbers' graph vertices and
   the denominator of member counts.

### Stage-1 final projection (rounds 1-3)

- Grouping is per TASK (lane identity is `(task, tag)`); a turn's task comes
  from its task tag; stage 1 never creates or attaches tasks.
- A member's final `tags` = its task tag + assigned lanes + ALL `topic:`
  entries. **Replacement semantics**: lane words the projection does not
  assign are REMOVED.
- **Removed-side-citer closure**: in the SAME transition transaction, every
  edge whose side tag references a lane the projection removed from an
  in-window cited endpoint is enumerated; each such edge's CITING turn joins
  the writable set with provenance `removed-side-citer`, authorizing
  **relation writes only** on that turn (note fields stay out of reach).
  REJECTED alternatives: endpoint-side-only repair rights (rewrites E4's
  anchor law); deferring the removal until a window owns the citer (the
  diseased word survives indefinitely).
- **Per-provenance gate filter** (round 4, replacing round 3's "deliberate
  widening" — which was WRONG: E3 is an empty/out-of-vocabulary turn TYPE
  anchored at the turn itself, not relation grammar, so a relation-only
  authority could never discharge it and the widened gate manufactured an
  unresolvable terminal state). The terminal gate blocks per provenance,
  following "blocks only what its owner can repair": for window / lookback /
  closure members, E3, E4 and E6 anchored there all block as today; for a
  turn whose ONLY provenance is `removed-side-citer`, E4 and E6 anchored
  there block (relation grammar, repairable with its relation-only
  authority) and E3 does NOT — the type debt belongs to whichever window
  owns that turn's fields. A turn holding both provenances takes the union
  of authorities and blocks on all three. This is not a debt-id scoping
  concept; it is the existing repairability principle applied per provenance
  class.

### `topic:` grammar — one closed contract, one ticket (rounds 2-3)

- **The migration dies**: `stripRetiredTopicTagNamespace` is deleted from the
  `initializeSchema` chain in the same release that admits `topic:` writes.
  Historical words it already stripped stay bare — no resurrection.
- **Canonical form**: `topic:` + payload in the lane-tag charset (lowercase
  a-z, 0-9, `-`, no leading/trailing hyphen), NFC, non-empty. Non-canonical
  input is **REFUSED, never silently normalized**, matching the lane-tag
  precedent — and the refusal's display has a boundary (round 4): when the
  repair is mechanically derivable and unique (case folding, NFC, whitespace
  trim, hyphen placement), the refusal shows the derived candidate; when it
  is not (illegal charset, CJK, arbitrary symbols — any repair would be a
  new judgment), it shows the canonical pattern and the offending
  characters, and NEVER fabricates a candidate. Writing a topic word the turn already
  carries is a **success no-op**, receipted as already-present — not an
  error, not a duplicate row.
- **Cardinality**: stored 0..N per turn, exact strings unique. The live duty
  teaches exactly ONE word per turn; stage 1 may add (compound turns,
  backfill).
- **Phase-token predicate**, machine-decidable: tokenize the payload on `-`;
  REFUSE if any token is in the following CLOSED set (this list IS the
  contract — the ticket copies it verbatim, and changing it is a spec
  revision, not an implementation choice):

  discuss, discussion, discussions, discussing, discussed,
  research, researches, researching, researched,
  measure, measures, measuring, measured, measurement, measurements,
  design, designs, designing, designed,
  correction, corrections, correct, corrects, correcting, corrected,
  implement, implements, implementing, implemented, implementation,
  implementations,
  refactor, refactors, refactoring, refactored,
  fix, fixes, fixing, fixed, bugfix, bugfixes, hotfix, hotfixes,
  delegate, delegates, delegating, delegated, delegation,
  review, reviews, reviewing, reviewed, reviewer, reviewers,
  ops, op, operation, operations,
  verify, verifies, verifying, verified, verification,
  test, tests, testing, tested

  Construction rule, stated so the boundary is inspectable: the eleven type
  words, their English inflections, and the verify/test families this
  corpus's own titles use as phase markers. DELIBERATELY EXCLUDED: words
  like delivery, release, audit, debug — they are not type words, and in
  meta-projects (this one included) they can be legitimate SUBJECTS;
  banning them would overreach the orthogonality law into topic space.
  Refusal names the offending token and the law [S15069/T1996]. Known cost:
  occasional false positives (`visual-design`) are refused with reason and
  rewritten (`visual-direction`); the fixture's `s11bin-editor-verification`
  is the canonical refused example.
- **Preservation invariant**: a whole-set `tags` write missing an existing
  `topic:` entry is refused naming it — for every writer. The only removal
  path is stage 1's explicit correction form (name old and new in one call).
- **Never an edge side, never membership**: the edge-side vocabulary remains
  declared lane tags only; E4's presence check is necessary, not sufficient.
  The ticket enumerates ALL faces that today reject the retired namespace
  and unlocks them in one change.

### Homeless record (rounds 2-3)

- **Group identity**: `homeless_groups(id, job_id, task_scope_id INTEGER NOT
  NULL, canonical_label, member_fingerprint, reason, transition_seq,
  created_at)` — `task_scope_id` is the task's id, or **0 for taskless**,
  NEVER NULL: SQLite's UNIQUE treats two NULLs as distinct, so a nullable
  column in the key would let duplicate taskless rows through the very
  conflict clause meant to stop them. Unique key `(job_id, task_scope_id,
  canonical_label)`. Members in `homeless_members(group_id, turn_id)`.
  Upsert semantics under immutable records: same key + same fingerprint =
  no-op; same key + DIFFERENT fingerprint or reason = REFUSED (an immutable
  record is never updated; after a successful transition the stage is
  `edges`, so this path is additionally unreachable — both stated, the
  refusal as the mechanism, the unreachability as the invariant).
- **The active view reduces EVENTS, not groups** (round 4): two event kinds
  exist for a turn — group-membership creation (result: homeless under that
  group) and supersession (result: `homed` → NO active homeless state, or
  `regrouped` → the successor group). A turn's active disposition is the
  result of its highest-`transition_seq` event; job ids are never time
  (overlapping backfills and manual queues commit out of id order). The
  round-3 "highest covering GROUP" rule is retracted: a homed supersession
  creates no covering group, so under that rule the stale homeless record
  would have stayed active forever and the future connectivity exemption
  would wrongly excuse a homed turn. This active-view reduction is
  implemented ONCE (SQL view or pure function) and is the SOLE entry point
  for every consumer — stage 2 and the future arming ticket alike.
- **Supersession is member-row level**: a mapping table
  `homeless_supersessions(old_group_id, turn_id, successor_kind
  homed|regrouped, successor_group_id NULLABLE, transition_seq)` — written by
  the superseding transition, one row per member it covers, so one old
  group's members may point at different successors. Consistency
  constraints: at most one live successor per `(old_group_id, turn_id)`;
  all mappings for one turn written by one transition must agree on the
  outcome (one homed/successor result per turn per transition). A
  `regrouped` row's successor is a group created by the SAME transition_seq.
  Group records are immutable; there is no update path.
- **Retraction audit** (round 3 P1): a stage-2 retraction motivated by a
  homeless record writes an audit row carrying the deleted relation row's
  FULL composite identity — edge row id, citing kind/id, cited kind/id,
  relation word, tail tag, head tag — plus cause (group id), job and epoch,
  in the same transaction as the deletion. When deleting the last relation
  restores a bare citation row, the audit row records "relation retracted,
  bare restored".
- Consumers: stage 2 (retract-with-cause), the future connectivity-arming
  ticket (per-member exemption view). **NOT an E6 exemption**: the terminal
  commit still requires E6-clean.

### Lane threshold (USER RULING [S15069/T1998])

Exact threshold 50 declared lanes per task; settlement unconstrained at any
count; at/over threshold, attached sessions get a per-message injected
reminder and the main agent proposes merges via AskUserQuestion; consolidation
executes only on the user's answer.

### Shape numbers v1 (rounds 2-3, identity fixed)

Computed at stage-2 commit time, scoped to the persisted worklist. Graph
vertices = the transition's per-lane member snapshot; a member with no edge
is its own component. The edge set is the **induced subgraph on the frozen
vertices**: an in-lane shape edge counts iff BOTH endpoint ids are in that
lane's frozen member snapshot AND both sides resolve to that `(task, lane)`
(drafts excluded); a cross-lane count requires the two endpoints in the two
lanes' respective frozen snapshots. A member added concurrently after the
transition is invisible to the numbers by definition — same-named lanes in
other tasks and concurrent membership writes cannot move them. Reported per
worklist lane: snapshot member count and WEAK connected-component count;
per unordered worklist-lane pair: cross-edge counts grouped by relation
word. No thresholds, no candidate labels, no persistence.

### Teaching

- The main-agent rubric gains the topic-word duty (a taught field — voluntary
  write rates measure zero) and its orthogonality clause.
- Stage-1 teaching carries the lane criterion in five sentences: the purpose
  preamble (trace a landing to its basis), topic identity across phases,
  orthogonality (type = phase axis, tag = topic axis [S15069/T1996]),
  synonym-only reuse, finer-over-coarser with user-ruled merge as the repair.
  No granularity clause, no type-composition test, no workflow-specific
  vocabulary [S15069/T1989].
- Stage-2 teaching covers relation words, the snapshot contract, draft
  reconciliation, debt discharge and the gates. Session narrative (session
  title/content) writes at stage 2's commit.

## Testing Decisions

- Primary seam: the existing settlement SDK-query seam
  (`tests/worker/note-settlement-sdk-query.test.ts`) — both stages drive
  through the same facade; no new seam. Scheduler behavior (transition
  verdict, post-hoc truth rule, same-drain chaining, stage resume, stop-hook
  pickup, tuple fencing) tests at the job-table seam as the dream-retry
  suite did.
- Good tests assert external behavior — what a transition/commit wrote and
  refused — never prompt wording. Mutation discipline per standing
  constraints.
- **Simulation evidence is scoped**: the blind fixture pair
  (`fixtures/blind-sim-input-t151-250.md` / `blind-sim-output-t151-250.md`)
  evidences stage-1 grouping feasibility on a clean notes-only window.
  Metrics for that window: **zero phase-SLICED groupings** and the UI line's
  research→spec→tickets arc in ONE group. Naming is judged by the Rev-4
  phase-token predicate, under which the fixture's
  `s11bin-editor-verification` is a KNOWN FAILURE, annotated as such.
- **End-to-end probes** (seam-level): roster+decoy; homeless lifecycle
  (create / partial-overlap supersede per member via the mapping table /
  retract-with-cause audit row incl. bare-restored); stage recovery (kill
  between transition and stage 2 → post-hoc truth rule fires, no attempt
  spent; kill mid-stage-1 → reclaim spends an attempt and re-runs topics);
  lost-verdict simulation (transition lands, dispatch throws — scheduler
  discards the failure and launches stage 2); tuple fencing; topic
  preservation invariant; non-canonical topic refusal (derivable case shows
  the candidate, non-derivable shows pattern + offending chars); duplicate
  topic no-op receipt; migration retirement (a `topic:` word survives a
  schema reopen); removed-side-citer discharge with the per-provenance gate
  (a manufactured E4 plus an unrelated E6 on the citer both block until
  repaired, while an unrelated E3 on the same relation-only citer does NOT
  block this job); pre-era snapshot visibility (an `allow_pre_era` window's
  transition snapshot contains freshly-laned pre-era members, ordinary lane
  recall does NOT show them before the terminal commit, and does after);
  homed supersession terminates homeless (active view returns nothing for a
  homed turn; partial overlap re-disposes only covered members).
- **S18993 corpus comparison is a MANUAL release gate**: after landing, wipe
  the diseased lanes, re-run the same windows under the new flow, and the
  USER reads the resulting lane set against the title-derived vertical
  answer [S15069/T1986]; no phase/activity lanes, six vertical lines
  recognizable, naming variance and finer splits acceptable [S15069/T1989].

## Out of Scope

- Arming phase connectivity (its own ticket; consumes the per-member
  homeless view).
- Graph-derived lane partition (rejected as source [S15069/T1993]); promoting
  shape numbers to split/merge candidates (needs history).
- Election, console, and injection-surface changes beyond the threshold
  reminder.
- Retroactive renaming of existing lanes that would fail the phase-token
  predicate (e.g. E60's `release-verification`) — the predicate governs new
  writes; legacy cleanup is the user's merge/retag call.
- S21682 and other sessions' backfill campaigns.
- The revoked 0.25.1 teaching-sentence patch (superseded by this redesign).

## Further Notes

- **Reviewer's implementation guardrails** (READY verdict, round 5 — not
  design questions, but ticket-level constraints): (1) the current provenance
  helper is a mutually-exclusive three-way — the new model needs a permission
  UNION for ordinary + removed-side, never a reuse of the old shape; (2) the
  current lane checker live-widens membership — the grammar gate may keep
  that, but shape numbers take their own snapshot-induced projection; (3) the
  phase-token predicate is shared into stage-1's lane create/retag entry
  points, not wired to the `topic:` write face alone (existing lanes stay
  grandfathered per Out of Scope).

- The blind simulation protocol (notes-only input, same-tier model, criteria
  taught but answers withheld) is the template for pre-release validation of
  stage-1 teaching changes.
- Jobs 135-138 of the old-flow campaign may still be finishing; their output
  enriches the before-picture and must not be repaired by hand before the
  new-flow acceptance run.
