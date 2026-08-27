# 01 — A draft edge cannot pass `lane_check` or commit

**What to build:** an edge that has never been judged blocks the settlement window
that covers it, exactly as error class E6 already says it does. Today the most
undecided edges in the database are the only ones the checker cannot see, so a
window commits with its debt intact and nothing anywhere reports it.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

## Why

`S15440/T550 -> T548` (edge row 574) has `relation=''`, both side tags `''`, and
zero rows in `memory_edge_side_tags`. Job 114 covered both endpoints, wrote two
fresh `consume` edges on T550 the same night, and committed with row 574 untouched.

The agent never saw it. `db/lane-checker-load.ts` loads edges two ways and this row
fails both:

1. **By lane tag** — phase 3 widens through `memory_edge_side_tags`. A row with no
   settled side has no index rows, so it is not there.
2. **By relation** — the stance stock pass calls
   `loadEdgesByRelationTouching(db, seedTurnIds, [...STANCE_RELATIONS])`, and
   `STANCE_RELATIONS` is a subset of the seven words. `''` matches none.

Both conditions come from one cause, so they never fail apart: no relation means no
word to match, and an edge that never got a relation never got tags either.

E6's own contract is *"a DRAFT edge: EITHER side carries the `''` sentinel … commit
refuses while one remains."* It is structurally blind to the draftiest edges there
are.

Measured DB-wide:

```
total edges                                        4270
  relation = ''                                    1967
  relation = '' AND no side-tag rows (invisible)    1967   ← 100% overlap
  has a relation but one side empty (E6 catches)     772
```

**46% of the edge table is invisible to the tool that judges edges.**

This also corrects an earlier reading: 93 stale edges were found sitting on turns
settlement had revisited the same night, and that was interpreted as settlement
writing beside stale rows instead of reconciling them. It was not negligence — those
rows were not on its desk.

## Decisions (settled — implement as given)

1. **The loader gains a third path**: stock edges with `relation=''` between the
   scope's own seed turns load unconditionally. The shape already exists — the
   stance stock pass is "load unconditionally by seed turn", filtered by a word list
   these rows have no word for.
2. **E6 then does its existing job.** No change to the error class, its message, or
   the commit gate's treatment of it. The ruling is "draft edges must not pass
   `lane_check` or commit" and that is already what E6 says; this ticket only lets it
   see them.
3. **Law 8 still applies.** The new path joins both endpoints against `turns` with
   `liveTurnSql`, like every other edge query in that file. A skipped or rolled-back
   endpoint must not drag a draft edge into the projection — the module header warns
   that any load path bypassing `liveTurnSql` re-admits skipped turns as errors that
   block a window on rows the agent is never shown.

## The risk this ticket must close

Making 1967 rows visible makes them **blocking**. Before declaring done, establish
that a window cannot become permanently unpassable:

- A draft edge whose other endpoint lies outside the run's writable set — can the
  agent resolve it at all? If not, the window blocks forever on a row it may not
  touch. Determine whether the writable set's closure over in-scope edges' external
  endpoints already covers this, and if it does not, say so plainly and stop rather
  than shipping a deadlock.
- Report how many of the 1967 fall into that category.

## Acceptance criteria

- [ ] A draft edge (`relation=''`, both sides `''`) between two in-scope live turns
      appears in the `lane_check` projection and is reported as E6.
- [ ] A commit attempt over a window containing such a row is REFUSED, naming the row.
- [ ] The same row with one endpoint skipped or rolled back does NOT enter the
      projection — law 8 holds, asserted rather than assumed.
- [ ] A draft edge is loaded once, not duplicated, when it is also reachable another
      way; the edge map's dedupe covers it.
- [ ] The deadlock question above is answered with a number and a verdict.
- [ ] Every new test mutation-verified: name the observable that must differ, assert
      the mutation's needle matched and PRINT that it applied, confirm red, restore
      from a backup taken AFTER the implementation lands, confirm green.
- [ ] `npx tsc --noEmit` clean, `node scripts/build.js` succeeds (or is skipped with
      the reason stated, if a sibling worker is mid-edit), `bun test` green; report
      the number and account for the change.

## Out of scope

Judging or retracting the 1967 existing rows — this ticket makes them visible and
blocking, it does not clear them. Clearing is settlement's own work, one window at a
time, and it is the point.

## Notes

Production database read-only; `sqlite3 -readonly` for every measurement.
