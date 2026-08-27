# Lane state retires; an index node seats on its own account

**Status:** ready-for-agent
**Ruled:** 2026-08-27, [S15069/T1812]

## Problem Statement

`index` is used once in 819 edges. That is not a labelling habit — it is what the
criterion permits.

An `index` edge declares the **whole lane** converged, and `closed` is derived as
"the lane's newest member is its terminus". On a 340-turn lane, every mid-lane node
has work after it, so only the lane's final member can ever qualify — and only if
that member happens to be a genuine wrap-up rather than an interruption. A survey of
E70's 605 turns found exactly ONE turn meeting it. The single existing `index` edge
(T136→T121) fails the same criterion: its SPEC was superseded four times afterwards.
The shipped settlement prompt emits under one reading and asks for another.

Read the same turns for **phase** convergence instead — a design settled, an
implementation landed, a batch verified — and the same survey yields 40 candidates
across four lanes.

The distinction `closed`/`open` is what forces the narrow reading, and it earns
nothing: "this lane is at rest" and "this lane is finished forever" cannot be told
apart from inside a bounded window, and no reader needs them told apart.

## Solution

Retire lane state entirely. Neither the 静止 reading nor the 终结 reading is chosen;
both go. A lane is a set of members and the edges claiming it, with no state.

`index` then means what the concepts rubric already said — 阶段性收敛 — and the
milestone election seats an index-declaring node on its own account rather than on
the accident of being its lane's newest member.

## User Stories

1. As settlement, I want the convergence question scoped to what my window can answer, so
   that I can answer it instead of declining 818 times out of 819.
2. As someone reading a task's milestones, I want each phase's wrap-up seated, so that a
   600-turn task is not represented by whichever node happened to be last.
3. As someone reading a lane, I want no state badge that claims to know whether the work
   will ever continue, since nothing in the system can know that.
4. As a maintainer, I want one vocabulary rather than two — the concepts text and the
   settlement procedure saying the same thing about `index`.
5. As settlement, I want the granularity rule stated: an index citing a single node means
   the phase was cut too fine, so I can tell a phase from a step.
6. As an operator, I want a too-fine index surfaced as a `lane_check` warning rather than a
   write refusal, since it is a per-turn aggregate and refusing the first row of a batch
   would kill a write that is not yet finished.
7. As someone whose work iterates through versions, I want each version landing seated, so
   the milestone does not skip a major node just because a later version superseded it.
8. As a maintainer, I want "被 override 的节点依然有效" to keep holding, so that supersession
   never silently disqualifies a node from anything.

## Implementation Decisions

1. **Lane state is deleted, not reinterpreted.** `LaneClosure`, `deriveLaneStates`
   and `laneClosureClaim` (`src/shared/lane-interpretation.ts`) go; the checker's
   three-state line collapses to what remains; the rubric's `open`/`closed` bullets
   and the sentence "七个词里只有 index 参与 open / closed 的判定" go with them. The
   neighbouring clause "被 override 的节点依然有效" **stays** — it is a separate law
   and it is load-bearing (see decision 5).
2. **Election tier ② is re-based on the node, not the lane.** Its qualification
   becomes "this node declares an `index`", replacing `closed-terminus`. Tier ③
   (nodes an elected tier-①/② node indexed) is unchanged in rule; its population
   grows because tier ② does.
3. **`index` = the batch of nodes that genuinely contributed to ONE phase result.**
   The user's own calibration: one `/to-spec` run, one release. A single cited node
   means the phase was cut too fine.
4. **Too-fine is a `lane_check` WARNING, not a write gate.** It is a per-turn
   aggregate — "how many nodes did this turn index" — and the rows are written one at
   a time, so a write-time refusal would reject an unfinished batch. It is also a
   diagnosis in the ruling's own words ("说明太细了"), not a prohibition.
5. **No override gate on index candidacy.** An earlier draft disqualified a candidate
   with an incoming `override`; it was withdrawn, because the rubric already says a
   node overridden stays valid, and because version progression means every version
   node is overridden by its successor — the gate would delete precisely the nodes
   the user named as most necessary.
6. **The settlement prompt's step 4 is rewritten** to ask the local question. Its
   coupling principle "一条 closed 泳道的终点,应该被外部节点引用" is re-expressed
   without lane state.
7. **Rendering follows**: the console's lane state and `timeline`'s `◎` terminus
   marker lose their basis and are re-specified or removed.

## Open — NOT settled, do not implement

**The within-tier sort key for tier ②.** With lane state gone, tier ② can hold tens
of nodes against a budget of ~30. The current within-tier key is in-degree desc, then
out-degree desc, then later time. In-degree was measured unusable on this data —
range 1–6, with 89% of 761 cited nodes tied at 1 or 2 — while an index node's natural
signal is out-degree, how large a batch it converges, which currently ranks third.
Leading tier ② with out-degree is the obvious candidate and has NOT been ruled.
Ticket 02 must not change the key; raise it with measurements instead.

## Testing Decisions

Test the observable — which nodes an election seats and at which tier, and what the
checker reports — never the shape of a deleted type.

The highest seam is `electMilestones` itself for tier behaviour, and the checker's
rendered report for the warning. Prior art: the golden-nine election fixtures from
the milestone-election batch, and the existing lane-checker report tests.

Required:

- A node declaring `index` seats at tier ② **even when its lane has later members** —
  this is the whole point, and a fixture where the lane continues is the only version
  of the test that proves it.
- A node with an incoming `override` still qualifies, pinning decision 5.
- The too-fine warning fires on a single-target index and stays silent at two.
- The deletions are real: a test asserting the retired symbols are gone, in the style
  of the existing `lane-model-v12-deletions` test.
- Every new test mutation-verified, with the observable named before the mutation is
  accepted.

## Out of Scope

- The within-tier key (see Open above).
- Writing E70's 38 surveyed index edges — that needs a write channel, which is
  `.scratch/main-agent-edge-capability/` and separately ticketed.
- The era-grant work at `.scratch/era-grant-by-settlement/` — that fixes why E70's
  milestone is empty; this fixes why `index` is unused. Neither blocks the other.

## Further Notes

E70's milestone emptiness was FIRST misdiagnosed as this problem. It was not: the era
filter had already emptied the candidate pool before the election ran. This spec
stands on its own evidence — the 1-in-819 usage rate and the survey — and not on that
symptom.
