# 01 — A settled pre-era turn appears in its task's member reads

**What to build:** a task whose work predates the era cutoff shows that work.
`timeline(id="E70", view="milestones")` returns more than the turn that created
the task, because the 604 members settlement already re-annotated under v12 stop
being filtered out before the election runs.

**Blocked by:** None — can start immediately.

**Status:** resolved — landed as `4e980b8`, every criterion below re-checked verbatim by its worker

## Why

`chronologicalSegmentMembers` drops every member whose `created_at_epoch` is below
the cutoff. E70 has 605 members and 1 above it, so its milestone view seats exactly
one node. The cutoff is a proxy for "annotated by the retired extraction subagent";
a backfill invalidates that proxy, and E70's members are 100% v12 `type` vocabulary
with v12 edges and lane tags. See `../spec.md`.

## Decisions (settled — implement as given)

1. **`isSegmentEra` does not change.** It answers three different questions across
   13 call sites; only member visibility moves. See the spec's table.
2. **A new narrower predicate** beside it in `src/segment-era.ts`, reading the turn's
   creation epoch, its grant epoch and the cutoff — plus a SQL-fragment sibling for
   the query sites, so the two forms cannot drift apart.
3. **A nullable epoch column on `turns`** (not a boolean), added via
   `addColumnIfMissing`, with the one-time backfill guarded by that call's return
   value — the `ensureForkLineageColumns` pattern in `src/db/schema.ts`.
4. **Retroactive seed = the settlement job ledger**: turns inside a
   `note_settlement_jobs` row with `status='done'` and `updated_at_epoch >= cutoff`.
   Report the actual count; do not assert the 1090 measured on 2026-08-27.
5. **Exactly three read sites change** — `computeSegmentMemberFacetCounts`
   (`db/segments.ts`), `rankSegmentMembers` and the session-spine member query
   (`db/segment-rank.ts`). Every other era site stays, with its reason recorded.
   **Amended on delivery:** three FUNCTIONS, four SQL clauses. The session-spine
   query carries two era comparisons — the outer member filter and the sub-select
   choosing which segments appear — and the worker changed both, proving the
   necessity by mutation: widening only the outer leaves a segment whose members are
   all grant-only off the spine entirely, while its own inline counts already include
   those turns. Flagged rather than silently resolved, and accepted.

## Acceptance criteria

- [x] A pre-era turn WITH a grant appears in its segment's member read; the same turn
      WITHOUT one does not. Both directions asserted — one alone proves nothing.
- [x] `isSegmentEra` answers identically before and after, pinned by its own test.
      This is the guard that stops the narrow predicate becoming the wide one.
- [x] Note promotion (`mcp/note.ts`, `worker/note-settlement-turn-facade.ts`) and
      extraction liveness (`db/turn-completion.ts`, `db/recover-stranded.ts`) are
      unchanged for a granted pre-era turn, asserted rather than assumed.
- [x] The migration is idempotent — running it twice grants the same set — and its
      receipt states how many turns it granted.
- [x] Every era call site in the codebase is enumerated in the report, each marked
      changed or unchanged WITH its reason. The orphan-anchor query, `hasEraTurns`,
      `recall.ts`'s session-era checks and `liveSegmentWhereClause` (which gates on
      the SEGMENT's own `created_at_epoch`) are expected to be unchanged.
- [x] Report `timeline(id="E70", view="milestones")` before and after against a COPY
      of production, never production itself, and state E60's candidate-pool change.
- [x] Every new test mutation-verified: name the observable that must differ, assert
      the mutation's needle matched and PRINT that it applied, confirm red, restore
      from a backup taken AFTER the implementation lands, confirm green. Report the
      mutation and the catching test for each.
- [x] `npx tsc --noEmit` clean, `node scripts/build.js` succeeds, `bun test` green;
      report the number and account for the change.

## Out of scope

Writing grants at settlement time — that is ticket 02. This ticket's forward
behaviour is whatever the migration leaves; nothing new earns a grant yet.

## Notes

The production database is READ-ONLY from this work: `sqlite3 -readonly` for every
measurement, and any migration rehearsal runs against a copy under `/tmp`. Do not
run the migration against `~/.claude-mnemo/`.
