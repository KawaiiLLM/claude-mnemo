# ADR-0013 — Lanes have no state: `index` declares a phase, and an index node seats on its own account

**Status:** accepted · 2026-08-27 · source: S15069 T1809–T1837 (survey at
T1811, rulings at T1812/T1815/T1829, sort-key measurement at T1835) · spec:
`.scratch/lane-state-retirement/spec.md` (carries the rulings, the survey and
the reserved question) · amends ADR-0012 (its `indexes` semantics widen again;
nothing else in it moves)

## Context

`indexes` was used **once in 819 edges**. That is not a labelling habit — it is
the criterion working exactly as written.

ADR-0012 gave `indexes` its aggregation meaning; the lane model then attached a
graph state to it. `closed` was DERIVED as "the lane's newest member is its
terminus", so an `indexes` edge declared the whole LANE converged. On a
340-turn lane that makes only the final member eligible, and only if that
member happens to be a wrap-up rather than an interruption.

The settlement prompt asked for exactly that:

> **4. DECLARE CONVERGENCE.** Only a candidate disposed CONVERGED writes a
> TAGGED `indexes` … Work merely stopping, a batch ending, or an existing
> declaration is never closure evidence … and **leaving a lane honestly OPEN is
> normal life.**

Two things were measured before anything was changed.

- **An Opus survey walked all 605 turns of task E70 across its four lanes,
  classifying every convergence candidate under both readings.** Whole-lane
  convergence yields **2 candidates, both from one turn**. Phase convergence —
  a design settled, an implementation landed, a batch verified — yields **40**.
  Two lanes honestly returned nothing under the strict reading, and the survey
  said so rather than filling a quota.
- **The one existing `indexes` edge fails its own criterion.** T136→T121's spec
  was superseded four times afterwards. The shipped prompt emitted under one
  reading while asking for another.

The distinction `closed`/`open` was also undecidable where it had to be
decided. Settlement sees one 50-turn window plus a lookback; "this lane will
never continue" is precisely the absence a bounded window cannot observe. And
no reader needed the answer: nothing downstream did anything with `open` that
`closed` would not have done equally well.

A false start is part of this record. The empty milestone view of E70 was
first blamed on this problem. It was not: an era filter had already emptied the
candidate pool before the election ran (605 members, 1 past the cutoff), which
is ADR-adjacent work of its own. This decision stands on the 1-in-819 rate and
the survey, not on that symptom.

## Decision

### 1. Lane state is deleted, not reinterpreted

Neither reading is chosen. `closed` as "at rest" and `closed` as "finished
forever" both go, along with `LaneClosure`, `deriveLaneStates`,
`laneClosureClaim`, `LaneDeclaration`, `Lane.declaration` and
`Lane.latestMember`. A lane is its members and the edges claiming it. Nothing
in the system claims to know whether work will continue, because nothing in the
system can.

The rubric's adjacent clause **被 override 的节点依然有效** survives. It is a
separate law and decision 3 depends on it.

### 2. `index` means what the concepts text always said: 阶段性收敛

One sentence: *this turn closed out a stretch of work, and cites the batch that
genuinely produced that ONE result.* One `/to-spec` run, one release.

A single cited node means the phase was cut too fine. That is a `lane_check`
**warning, never a write refusal** — it is a per-turn aggregate while rows are
written one at a time, so a write-time refusal would reject an unfinished
batch, and the ruling's own words were diagnostic ("说明太细了"), not
prohibitive.

A lane may converge many times. An earlier declaration neither blocks nor
substitutes for a later one, and a later member contradicts nothing.

### 3. Election tier ② seats a node that DECLARED an index

The qualification moves from the lane to the node: `closed-terminus` becomes
`declares-index`, and a node seats whether or not its lane ran on afterwards.

**No override gate.** A node with an incoming `override` still qualifies.
Decision 1's surviving clause says an overridden node stays valid, and version
progression means every version is superseded by its successor — a gate there
would delete precisely the version landings a milestone most needs. This was
proposed, implemented in a draft, and withdrawn on the user's objection at
T1815.

### 4. The within-tier sort key does NOT change

Raised as the obvious follow-on and rejected on measurement (T1835). It stays
in-degree desc → out-degree desc → later time/id. See Alternatives.

## Alternatives considered, and why they lost

**Keep `closed`, pick one reading.** Offered as the original question. Rejected
because the two readings are indistinguishable from inside a bounded window,
and no reader consumed the difference. Keeping either would have preserved the
whole cost of the concept for none of its value.

**Two concepts: a phase `index` plus a separate closure declaration.** Rejected
on conceptual integrity: a new word's cost is not itself but its interaction
surface with all seven existing ones, and the closure derivation already
self-corrects — a later member reopens a lane automatically — so the second
word buys nothing the first does not already survive.

**Gate index candidacy on "no incoming `override`".** Drafted, then withdrawn:
it contradicts standing rubric law, and structurally it deletes every version
but the last, since every version is overridden by its successor. The measured
cost of the gate was 2 of 40 candidates — both version landings.

**Lead tier ② with out-degree.** The surface statistic was damning: across 70
live tier-2 candidates in-degree is {0:30, 1:29, 2:10, 5:1} while out-degree
spreads 1–10, and of 64 adjacent boundaries in-degree decides 3, out-degree 17,
order/id 44. It still lost, on three findings from a seated-set comparison
against a production copy:

1. Of 11 live segments, only E60 has tier①+tier② candidates (11+60) above the
   admission cap of 30. In the five other segments holding tier-2 candidates
   the key **cannot** move a seat — arithmetic, not luck. The reach of a global
   algorithm change is one segment.
2. On E60 it moves 6 seats in and 6 out, and both sets read as legitimate
   milestones. Entrants have in-degree 0 with high out-degree (releases, ticket
   splits); leavers have in-degree 1–2 (user rulings, golden-sample decisions).
   That is a taste swap from "who is cited a lot" to "who cites a lot", not a
   quality fix.
3. `rankCompare` is ONE comparator shared by every tier with no tier branch, so
   a global swap also reorders tier-④ correctors and silently reseats E70. Any
   future attempt must first make the key tier-aware — which turns "adjust a
   sort order" into "give the comparator tier semantics".

Revisit when more segments exceed the cap, not before.

## Consequences

- **ADR-0012's `indexes` semantics widen; the rest of it stands.** Its
  aggregation reading, the same-phase check and the release ritual are
  unchanged. What changes is that aggregation no longer carries a graph state.
- **The emission window opens by roughly 20×** on the surveyed corpus: 2
  strict candidates become 40 phase candidates on one task. Production
  `indexes` edges have since grown from 1 to 222 across 82 citing turns.
- **Six render surfaces lost their basis and were each re-specified, not
  patched.** The checker's `declaration: closed (terminus …)` line is removed
  whole; report 2's closed-terminus citedness line goes in both directions; the
  console's lane strip collapses to one group with a member count; `timeline`'s
  `◎` marker is removed rather than re-pointed, since the chain already renders
  `=>` for an `indexes` hop and `◎` was the redundant half of that pair.
- **The golden nine returns to its pre-change list**
  `[922,929,939,946,981,984,990,998,1001]`, and that is explainable rather than
  lucky: on that fixture every former lane terminus had itself written an
  `indexes` edge, so the lane rule and the node rule elect the same people for
  different reasons. The six that leave drop to `indexed-by-elected` at ranks
  13–22 without falling out of the pool.
- **A paging fixture's premise broke silently.** Removing one line per lane
  from reports 1 and 2 dropped an unpaged render from >100K to 89K chars, which
  quietly falsified the `> WORKER_TOOL_RESULT_MAX_CHARS` premise four paging
  tests stand on — they stayed green while testing nothing. `LANE_COUNT` was
  raised 150 → 250. Any future deletion from those reports must re-check it.
- **The rubric's injected concepts block shrinks** to 2669 chars against a 9500
  ceiling, with a new hash; both hashes are computed at runtime, so no literal
  needed updating, but the `.scratch` verbatim archive is a load-bearing test
  input and was amended in the same batch.
- **The settlement prompt's step-1 triage word changed too.** `OPEN` named a
  state that no longer exists, so uncertainty now reads `STILL RUNNING`, and
  the bullet states out loud that the three dispositions describe the candidate
  rather than the lane — a rename alone would have let the reader rebuild the
  retired concept behind the new label.
- **Nothing is live until a plugin update and reload.** The production `turns`
  table still shows zero era columns at the time of writing.

## Open items

- **The within-tier key stays under review, not closed forever.** E60 is the
  first segment whose candidates exceed the admission cap; it will not be the
  last, and the evidence base grows with the `indexes` corpus.
- **`lane_check`'s too-fine warning has no production baseline yet.** On the
  golden corpus six index declarations cite exactly one node (T901, T906, T915,
  T946, T990, T1001). Whether that rate holds at scale is unmeasured.
- **Bare prose-reference rows remain invisible to the lane graph by design**,
  gated by `me.relation IS NOT NULL` at six loader sites plus the writable-set
  closure. A ticket to make them blocking was withdrawn after measurement
  showed it would deadlock 838 anchor turns across 20 sessions; making them
  merely VISIBLE, on the warning side, is still open and unspecified. See
  `.scratch/draft-edge-visibility/`, kept as the record of that false premise.
