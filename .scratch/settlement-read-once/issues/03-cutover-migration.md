# 03 — Cutover: the 98 tag-less members of named tasks receive their tag

**What to build:** after cutover, every member of a NAMED task carries that task's tag on the turn, idempotently and once; unnamed tasks' rows stay exactly as they are — frozen, readable, never extended — and the roster still shows `(unnamed)`. Spec D5.

**Blocked by:** 02.

**Status:** LANDED

- [x] A receipt-guarded one-shot in `initializeSchema` (the `migration_receipts` idiom, double-checked outside and inside the write transaction) that, through the ticket-02 primitive, adds the task tag to every member turn of a named task that lacks it. Production (read-only, 2026-09-02): 98 such members; 0 foreign-task conflicts. Report before/after counts on a clone and elapsed.
- [x] Unnamed tasks (66; 185 members) untouched: assert row counts before/after are identical for them.
- [x] Idempotent: a second open changes nothing and writes no second receipt.
- [x] Fixtures: a named task with tag-less members gains the tags; an unnamed task keeps its rows; a member already tagged is untouched.

## Constraints

- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY. Measure on a `cp -c` clone of the scratchpad copy.
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean` in the shared tree. Restore from your own `cp` copies, md5-verified.
- Explicit pathspecs on every `git add`. No raw control bytes in source. `grep -c anthropic-ai plugin/scripts/worker.cjs` stays `0`.
- Every teaching sentence added or removed is pinned by a test a mutation drives red. At least three mutation probes of your own, RED, md5-restored.
- [x] `npx tsc --noEmit` clean (excludes `tests/`; typecheck new tests separately); full `bun test` once (account for every delta against the baseline in your brief); `npm run build`; stale-bundle and release-artifacts guards green; `git diff --check` clean. Do NOT bump any version and do NOT push.

---

## Report (LANDED)

**Branch** `worktree-agent-aa33fcabc640cf61b`, fast-forwarded from `main` at
`3de2e897` (post ticket-02, "build(read-once): rebuild bundles after ticket
02").

Baseline reproduced before any edit: **4780 pass / 0 fail / 263 files**.
Final: **4786 pass / 0 fail / 264 files** (+6 tests, +1 file — all in the new
`tests/db/membership-cutover-migration.test.ts`). Every delta accounted for.

### What shipped

`cutoverNamedTaskMembershipTags` (`src/db/schema.ts`), called as the LAST line
of `initializeSchema` — strictly after every `segments.tags`/`turns.tags`
rebuild above it (`retireTopicRegistry`, `runLaneRegistryMigration`,
`runLaneModelV12EdgeMigration`, `runSegmentOneTagMigration`), since it reads
those columns in their final shape and writes through the ticket-02
primitive, which only exists once that shape is settled.

Receipt-guarded (`MEMBERSHIP_CUTOVER_RECEIPT =
"settlement-read-once-membership-cutover"`), checked outside and inside the
write transaction — the `retireUntenantedSegmentContentFromSearch` idiom.
Query: every `segment_members` row of a segment carrying its own tag
(`json_array_length(s.tags) >= 1` — a NAMED task; unnamed tasks are
structurally excluded from the query, never merely skipped by a guard) whose
turn's stored `tags` does not already include that task's tag. For each
candidate:

1. **Already tagged** → not even counted as a candidate, untouched.
2. **Foreign-task conflict** — the turn's stored tags already carry a
   DIFFERENT named task's own tag (checked with `loadSegmentTagIndex`, the
   same map the settlement batch tag write uses for the identical question) →
   refused and named in the receipt's `conflicts[]`, nothing written. This
   guards a real hazard: left to the primitive alone, `derivedTarget` resolves
   to the FIRST segment tag the array names, which could silently re-home
   `segment_members` to the wrong task.
3. **Clean** → one `writeMembershipTags(db, { operation: "normal", writes:
   [{turnId, tags: [...existing, taskTag]}], writer:
   MEMBERSHIP_CUTOVER_MIGRATION_WRITER, nowEpoch })` call, PER TURN (not one
   batched call for the whole sweep) — deliberate: the primitive is
   all-or-nothing over its whole `writes` array, and candidates are
   independent (each already owns its `segment_members` row; adding the tag
   only ever confirms it), so batching would buy nothing and risks one bad row
   blocking the other ninety-seven.

Reserved writer id `MEMBERSHIP_CUTOVER_MIGRATION_WRITER =
"migration:membership-cutover"` (`src/db/schema.ts`), the same discipline
`LANE_MERGE_WRITER`/`COMPACT_REPAIR_WRITER` use in `write-gate.ts`.

### Acceptance boxes

- **Receipt-guarded one-shot, through the primitive** — `cutoverNamedTaskMembershipTags` in `src/db/schema.ts`; test "a member of a NAMED task whose turn lacks the tag gains it".
- **Unnamed tasks untouched** — test "an unnamed task's members keep their rows, untouched" asserts `segment_members` row counts AND `turns.tags` byte-identical before/after, and no field stamp appears.
- **Idempotent** — test "idempotent: a second open changes nothing and writes no second receipt" asserts one receipt row, identical payload, identical tags/stamp across two `initializeSchema` calls.
- **Fixtures** — all four named in the ticket, plus an "empty corpus" case and the foreign-task-conflict case.

### Clone measurement

`cp -c` from the scratchpad copy, md5-verified before and after (never
touched `copy.db` itself):

```
MD5 copy.db      = b22c5df1073f0157359caf7dc9318abd
MD5 cutover.db    = b22c5df1073f0157359caf7dc9318abd   (immediately after the -c clone)
```

Measured with a throwaway script calling `initializeSchema(db)` directly and
timing that one call (script was not committed):

| metric | before | after |
|---|---|---|
| tag-less members of named tasks | **98** | **0** |
| members of unnamed tasks | **185** | **185** (unchanged) |
| named tasks | 4 | 4 |
| foreign-task conflicts | — | **0** |

Receipt payload: `{"candidates":98,"tagged":98,"conflicts":[]}`.

Elapsed: the COLD run (first `initializeSchema` call on this clone, which
also settles every other still-pending migration on it) measured **3531 ms**.
A second, WARM `initializeSchema` call on the now-fully-migrated clone
measured **24 ms**, isolating this migration's own increment at roughly
**~3.5 s** on the 2.28 GB / 14k-turn production-sized database — dominated by
disk I/O against cold OS page cache across the 98 individual
`writeMembershipTags` calls (each running `frozenOwnerSegmentIds` and
`findMembershipLaneStrandings`, both indexed queries but touching different
pages of a large file for the first time), not an algorithmic cost. This is a
ONE-TIME cost, receipt-guarded, paid once by whichever hook process happens
to be first to open the upgraded binary against the production database —
reported honestly rather than claimed "single-digit ms" the way the
set-based idioms this ticket's docstring cites are; this migration is
deliberately NOT set-based (see "per turn, not one batched call" above), and
that tradeoff is the reason.

### Mutation probes (3, all RED, `src/db/schema.ts` md5-restored between each: `ac4f7c80998be9279f6c3733362de5ea`)

1. **Migration also tags unnamed tasks' members** — dropped the `WHERE
   json_array_length(s.tags) >= 1` filter and defaulted a null task tag to
   `"(unnamed)"` instead of skipping. RED: "an unnamed task's members keep
   their rows, untouched" — `storedTags(turnA)` went from `[]` to
   `["(unnamed)"]`.
2. **Receipt not written** — commented out the `writeMigrationReceipt` call.
   RED: 6 of 6 tests failed (every test that reads the receipt, plus the
   idempotency and empty-corpus tests, which now re-run the sweep on every
   open).
3. **An already-tagged member gets re-written** — removed the
   `turnTags.includes(taskTag)` skip. RED: "a member already carrying the
   task tag is untouched — no re-stamp" — `storedTags` went from
   `["ship-it"]` to `["ship-it","ship-it"]` (a duplicate).

### Guards

`npx tsc --noEmit` (src, excludes `tests/`): clean. New test typechecked
under a temporary `tsconfig.test-check.json` (extends the project config,
`rootDir: "."`, includes `src/**/*` plus the one new test file) — clean, then
deleted; not committed. Full `bun test`: **4786 pass / 0 fail / 264 files**.
`npm run build` clean; `tests/shared/release-artifacts.test.ts`: 11/11 pass
(stale-bundle guard included). `git diff --check`: clean. No control bytes in
the diff (`grep -P` scan over the three changed/added files: none).
`grep -c anthropic-ai plugin/scripts/worker.cjs` = `0`. No version bump, no
push.

### Shared-file hunks

`src/db/schema.ts` — three hunks only:
1. Two import lines added (`writeMembershipTags` folded into the existing
   `from "./segments"` import; a new `loadSegmentTagIndex` import from
   `./turn-tag-gate`).
2. One new call line at the very end of `initializeSchema`, with a 6-line
   ordering comment, immediately after the pre-existing
   `ensureMemoryEdgesPruneStampsRelations(db);` (ticket 00's own last line —
   untouched).
3. One new block (consts + `cutoverNamedTaskMembershipTags`) inserted between
   `ensureMemoryEdgesPruneStampsRelations`'s definition and
   `runLaneModelV12EdgeMigration`'s — nothing in either of those two
   pre-existing functions was touched.

No other file under `src/` or `tests/` was touched by this ticket.
`plugin/scripts/*.cjs` were rebuilt by `npm run build` but NOT staged/committed
per instructions.

### Nothing false at HEAD; nothing UNVERIFIED

Every acceptance box, every guard command, and every measurement above was
run in this worktree and its literal output is what is reported.
