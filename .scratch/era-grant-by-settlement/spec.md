# Settlement grants era eligibility

**Status:** ready-for-agent
**Ruled:** 2026-08-27, [S15069/T1817] (approach) and [S15069/T1818] (grant population)

## Problem Statement

A task whose work predates the era cutoff shows almost nothing in its milestone
view, however much real work it holds and however thoroughly that work has been
re-annotated under the current model.

E70 (`action-as-cosplay`) is the live case. 605 member turns, 818 two-sided v12
edges, four declared lanes, and a milestone view that seats exactly ONE node —
the turn where the user opened the task. Measured cause:

```
era cutoff = 1786427403 (2026-08-11 13:50)
E70: 605 members, 1 at or after the cutoff
```

`chronologicalSegmentMembers(db, segment, eraCutoffEpoch)` drops the other 604
before the milestone election ever runs. The election, the relation vocabulary
and the `indexes` usage rate — the places the symptom was first blamed on — are
all downstream of a filter that already emptied the candidate pool.

The cutoff is a **proxy**: it stands for "this turn was annotated by the retired
extraction subagent, under semantics that must not be mixed with the current
model's". `turns.created_at_epoch` approximates that, and for a turn nobody has
touched since, the approximation is exact.

A backfill breaks it. Settlement re-annotated E70's 604 pre-era turns on
2026-08-27 under lane-model v12, and the result is measurable: **889 `type`
values across those members, 100% drawn from the v12 closed vocabulary, zero
legacy words** (no `discovery`/`change`/`decision`/`feature`/`bugfix`). They
carry v12 edges and v12 lane tags. Nothing about them is legacy except their
birthday — and the proxy reads only the birthday.

The failure is silent. The task card reports 605 members; the milestone view
seats 1; nothing anywhere says why.

## Solution

Let the writer that actually knows say so. When settlement processes a window
under the current model, the turns in that window earn an **era grant** — a
durable per-turn fact recorded beside the turn. Member reads honour
`created_at_epoch >= cutoff` OR a grant.

Retroactively, the grants are seeded from the settlement job ledger, which is
the surviving record of which windows the current model has processed:

```
pre-era turns covered by a done, post-cutoff settlement job: 1090
  E70  604      E60  367      unowned  119
```

## User Stories

1. As someone reading a task card for a task whose work predates the era, I want its
   milestone view to seat the turns that actually carry the work, so that the view
   reflects the task rather than the date the container was created.
2. As someone who has just backfilled a session's settlement, I want that work to take
   effect on what I can read, so that a completed backfill is not silently inert.
3. As someone reading `timeline(id="E70", view="milestones")`, I want more than the
   task-creation turn, so that 604 turns of work are not represented by their own
   administrative preamble.
4. As an operator, I want the number of turns a settlement granted era eligibility to
   appear in its metrics line, so that a grant is never a write with no receipt.
5. As an operator, I want the one-time migration to state how many turns it granted,
   so that I can check the figure against the ledger rather than trust it.
6. As a maintainer, I want note promotion to keep behaving exactly as it does today for
   pre-era turns, so that widening member visibility does not silently change which
   turns get a promoted note record.
7. As a maintainer, I want extraction and stranded-turn recovery to keep behaving exactly
   as they do today, so that 1090 old turns are not swept back into a live pipeline.
8. As a maintainer, I want every existing era call site listed and individually ruled on,
   so that "the era gate" is never treated as one decision when it is three.
9. As someone reading E60's injected milestone block, I want to be told that its candidate
   pool grew by 367 turns, so that a changed block is an expected consequence and not a
   regression to investigate.
10. As a maintainer, I want a test that fails if `isSegmentEra` starts answering differently,
    so that the narrow predicate cannot quietly become the wide one.
11. As someone re-running a settlement over an already-granted window, I want the grant to be
    idempotent, so that a re-run neither duplicates nor revokes.
12. As a maintainer, I want the grant to be a recorded epoch rather than a boolean, so that
    "when did this turn become current" is answerable later.

## Implementation Decisions

1. **`isSegmentEra` DOES NOT CHANGE.** It has 13 call sites across 8 modules and
   answers three different questions:

   | question | sites |
   |---|---|
   | ① record shape — does a note promote onto `turns` | `mcp/note.ts`, `worker/note-settlement-turn-facade.ts` |
   | ② member visibility — does this turn appear in member reads | `db/segments.ts`, `db/segment-rank.ts` |
   | ③ extraction liveness — does the pipeline touch it | `db/turn-completion.ts`, `db/recover-stranded.ts` |

   Only ② moves. Widening the shared predicate would flip note promotion and
   extraction for 1090 old turns as an unannounced side effect.

2. **A new, narrower predicate** lives beside `isSegmentEra` in `src/segment-era.ts`
   and is the only thing that reads the grant. It takes the turn's creation epoch,
   the turn's grant epoch and the cutoff. A SQL-fragment sibling serves the query
   sites, so the two forms cannot drift.

3. **The grant is a nullable epoch column on `turns`**, not a boolean — the question
   "when did this turn become current" stays answerable. NULL means never granted.
   Added through the established `addColumnIfMissing` idiom, with the one-time
   backfill guarded by that call's own return value (the `ensureForkLineageColumns`
   pattern).

4. **Grant population = window COVERAGE, not turns reviewed** (ruled [S15069/T1818]).
   Semantics: "this turn's window was processed by settlement under the current
   model." An agent's decision not to write a note on a particular turn is its own
   legitimate judgment and must not leave that turn permanently invisible. Coverage
   is also the only population the retroactive seed can reconstruct — `turnsReviewed`
   survives as a count, never per turn — so one rule serves both directions.

5. **Retroactive seed = the settlement job ledger**: turns whose `(session_id,
   prompt_number)` falls inside a `note_settlement_jobs` row with `status='done'`
   and `updated_at_epoch >= cutoff`. Expected population 1090 at time of writing;
   the migration reports its own actual count rather than asserting this one.

6. **Forward grants are written in settlement's commit path**, in the same
   transaction as the commit, and are idempotent (a re-run over a granted window
   neither duplicates nor revokes). The count reaches the operator through the
   existing `[claude-mnemo] note-settlement` metrics line, as its own field.

7. **Member-read sites that change** — the three that gate a turn's appearance in a
   segment's own membership:
   - `db/segments.ts` `computeSegmentMemberFacetCounts`
   - `db/segment-rank.ts` `rankSegmentMembers` (the one feeding
     `chronologicalSegmentMembers`, and therefore the milestone view)
   - `db/segment-rank.ts` the session-spine member query

   Every other era site is left alone **and the reason recorded** — including the
   orphan-anchor query (its subject is turns with no membership at all), the
   session-level `hasEraTurns`, `recall.ts`'s session-era checks, and
   `liveSegmentWhereClause`, which gates on the SEGMENT's `created_at_epoch` and is
   a different question entirely.

8. **E60's milestone block will change** — its candidate pool grows from 1345 to
   1712. This is the same rule applied consistently, not a side effect, but it
   alters what gets injected at every SessionStart and must be stated in the
   release note rather than discovered.

## Testing Decisions

A good test here pins the OBSERVABLE — which turns a member read returns, and what
the migration and metrics report — never the shape of the predicate.

The highest useful seam is the member read itself (`rankSegmentMembers` /
`chronologicalSegmentMembers`), because that is what the milestone view, the segment
card and recall all funnel through; one seam covers all three surfaces. Prior art:
the existing era-scoping tests around `rankSegmentMembers`, and
`tests/db/schema.*` for migration receipts.

Required:

- A pre-era turn WITH a grant appears in its segment's member read; the same turn
  WITHOUT one does not. Both directions, or the test proves nothing.
- **A guard that `isSegmentEra` answers identically before and after** — this is the
  test that stops the narrow predicate from becoming the wide one.
- Note promotion and extraction liveness for a granted pre-era turn are unchanged.
- The migration is idempotent: running it twice grants the same set, and its receipt
  reports the count.
- A settlement commit over a pre-era window grants exactly the window's turns, and a
  second commit over the same window changes nothing.
- Every new test is mutation-verified: name the observable that must differ, assert
  the mutation's needle matched and PRINT that it applied, confirm red, restore from
  a backup taken AFTER the implementation lands, confirm green.

## Out of Scope

- Moving or reinterpreting the era cutoff itself.
- The `indexes` candidate set surveyed in [S15069/T1811] and the milestone election
  changes ruled in [S15069/T1812] — related work, separately ticketed, and NOT a
  prerequisite either way.
- Any change to note promotion, extraction, recall's session-era checks or the
  segment roster's own era gate.
- Backfilling grants for turns no settlement job ever covered.

## Further Notes

The production database is read-only from a session. Every measurement quoted here
came from `sqlite3 -readonly`; nothing in this spec authorises a direct write to
`~/.claude-mnemo/`.

The diagnosis that produced this spec was wrong twice before it was right — first
blaming the `indexes` usage rate, then a subagent blaming a stale membership
snapshot. Both were downstream of the era filter. The lesson worth keeping: when a
view is empty, check what its candidate pool contains before theorising about how
it ranks.
