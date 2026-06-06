# Hook DB write contention + ESM module-type warning fix

**Status:** approved design, plan pending
**Date:** 2026-06-06
**Scope:** Stop / PostToolUse / **SessionStart** hook DB transactions (all three
fire on the synchronous hook path and share the read-then-write contention) +
`plugin/scripts` packaging. No schema change, no behavior change to *what* is
written.

## Motivation

A concurrent session emitted, from a Stop hook:

```
Stop hook error: Failed with non-blocking status code:
(node:73624) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of
…/claude-mnemo/0.2.26/scripts/bun-runner.js is not specified … Reparsing as ES
module … To eliminate this warning, add "type": "module" to /Users/<u>/package.json.
[HOOK] database is locked
```

Two independent defects: a misleading ESM warning (A), and a real
write-contention failure (B) that silently rolls back a Stop hook's DB work.

## Root cause

### B — `database is locked` is `SQLITE_BUSY_SNAPSHOT`, which `busy_timeout` cannot retry

`busy_timeout = 5000` and WAL are already set (`database.ts:27,32`), yet the lock
still fails — because this is the *snapshot* conflict, not the *lock-wait* one:

- The Stop handler wraps a **read-then-write** body in `db.transaction(() => …)`
  (`stop.ts:125`). bun:sqlite runs that as **`BEGIN DEFERRED`**.
- A DEFERRED transaction takes a read snapshot on its first read, then tries to
  upgrade to a write lock on its first write. If **another connection committed a
  write in between** (the worker extracting, or another session's hook), the
  upgrade fails immediately with `SQLITE_BUSY_SNAPSHOT`. **`busy_timeout` does not
  apply to this** — it only governs waiting for a held lock, not a stale-snapshot
  upgrade. Hence "locked" despite the 5 s timeout.
- The error is caught at `hook-command.ts:150-154`, logged `[HOOK] database is
  locked`, and returns the non-blocking exit code. The **entire** Stop
  transaction rolls back: backfill, invalidation, lineage relink, ancestor
  recovery, and turn-stop enqueue all revert for that event. No permanent loss
  (the next SessionStart `recoverStrandedTurns` re-enqueues), but it is a
  degraded, noisy path. `post-tool-use.ts:62`, `pending-queue.ts:91`,
  `lineage.ts:341`, `subagent-filter.ts:167` share the DEFERRED RMW shape.

**Aggravating factor:** the Stop transaction does **up to four full transcript
file reads + parses inside the lock window** —
`backfillFromTranscript → parseReplayTranscript` (`backfill.ts:22`),
`applyInvalidation → detectInterruptedPromptIds` + `detectRollbackTopology`
(`invalidation.ts:343-344`), and `relinkSessionLineage → resolveSessionLineage →
readAllTranscriptEntries` (`lineage.ts:239`). On a `/goal`-sized transcript
(megabytes of JSONL) this widens the snapshot window enormously, making the
mid-transaction conflict far more likely.

### A — `MODULE_TYPELESS_PACKAGE_JSON`

`plugin/scripts/bun-runner.js` is ESM (`import …`, `import.meta.url`, top-level
`await`), but `plugin/scripts/` ships no `package.json`. Node, invoked as `node
…/scripts/bun-runner.js`, walks up, finds no `type` until `~/package.json`, warns,
and reparses as ESM (a per-invocation perf hit on every hook). The warning's
advice — add `"type": "module"` to `~/package.json` — must **not** be followed:
it would reinterpret every `.js` under the user's home as ESM.

## Goals

- Stop hook DB writes no longer fail with `SQLITE_BUSY_SNAPSHOT` under concurrent
  writers; residual lock-wait contention is retried, not surfaced.
- No transcript file I/O inside any write transaction (the clean approach):
  parse once, outside; the transaction does only cheap DB reads + writes.
- The ESM warning is gone without touching the user's `~/package.json`.

## Non-goals

- No change to *what* the hooks persist, nor to extraction/recovery semantics.
- No schema change.
- No change to the read paths (`recall`, `timeline`, MCP server).
- Not a rewrite of the transcript parsers — only *where* they are called moves.

## Decisions

### D1 — Move transcript *file I/O* out of the transaction; keep DB-dependent computation in, in order

The expensive thing is the **file read + JSON parse** (megabytes of JSONL), not
the DB work. So hoist **only the file I/O** out; the DB-dependent computation
stays **inside** the transaction, in its current order, fed the preloaded
entries. This is the correction to the earlier "compute everything outside"
sketch — which was wrong, because the in-transaction order is load-bearing:

> `backfillFromTranscript` writes `turns.content_prompt_id` (`turns.ts:407`),
> and **both** `applyInvalidation` (matches turns by `contentPromptId`) **and**
> `relinkSessionLineage` ownership queries (`lineage.ts:47,67`) read
> `content_prompt_id`. Resolving lineage/invalidation *before* backfill would
> read stale (un-backfilled) ids → wrong result. Order must stay
> backfill → invalidate → relink.

**Outside the transaction** (file I/O only): one
`entries = readAllTranscriptEntries(transcriptPath)` pass, plus the pure parses
that read only the file:

- `parsedTurns: ParsedReplayTurn[]` (`parseReplayTranscript`, for backfill),
- invalidation sets `{ interruptedPromptIds, rolledBackPromptIds,
  replacementByPromptId }` (`detectInterruptedPromptIds` / `detectRollbackTopology`),
- the raw `entries` themselves (lineage needs DB + entries, resolved inside).

**Inside the transaction** (DB only, unchanged order), each helper now takes
preloaded data instead of a path, so it does **no file I/O**:

- `backfillFromTranscript(db, pendingTurns, undefined, lastAssistantMessage,
  parsedTurns)` — already accepts `transcriptTurns?` (`backfill.ts:13`); pass it,
  the in-helper `parseReplayTranscript` is skipped.
- `applyInvalidation(db, sessionId, invalidationSets, epoch)` — accept the
  precomputed sets (split out a pure `computeInvalidationSets(entries)` that runs
  outside); the apply (turn matching by `contentPromptId` + writes) stays inside,
  after backfill.
- `relinkSessionLineage(db, sessionId, entries, epoch)` — resolution stays inside
  (it reads post-backfill `content_prompt_id`) but consumes preloaded `entries`
  instead of re-reading: `resolveSessionLineageFromEntries(db, sessionId,
  entries)`. **`resolveViaLogicalParent` (the zero-overlap fallback, `lineage.ts:292
  → 195`) must take `entries` too** — today it does a *second*
  `readAllTranscriptEntries`, so a single pass only holds if the fallback is
  threaded the same entries.
- `detectAndCleanSubagentTurns` (`stop.ts:210`, SessionStart
  `session-init.ts:68`) — has a worker-compact caller (`server.ts:1733`) that still
  passes a path, and it parses from the path internally (`subagent-filter.ts:153,159`).
  So **keep the path-taking wrapper** for that non-hook caller and add a
  parsed-entries variant `detectAndCleanSubagentTurnsFromParsed(db, sessionId,
  entries, epoch)` for foreground hooks. Stop and SessionStart call the parsed
  variant **inside** their `runHookWriteTransaction` body (D3/D5); the wrapper
  becomes `read entries → call the parsed variant` for standalone/worker use. Do
  not change the shared signature out from under the non-hook caller.

**Reads that decide the write set must move *inside* the transaction.** Today
`orphanTurns = getOrphanTurns(...)` runs **before** the transaction (`stop.ts:123`)
and its query carries a `NOT EXISTS (… pending_queue …)` guard; the body then
enqueues per result (`stop.ts:168`). With the read outside the write lock, a
concurrent hook can enqueue between the read and our enqueue → the same orphan is
queued twice (a TOCTOU race the IMMEDIATE lock is meant to close). So
`getOrphanTurns` (and any analogous "select-then-write" read, e.g. the
`hasTurnStopTask` guard, already inside) executes **inside** the IMMEDIATE
transaction, on the write-locked snapshot. Pure control-flow reads that do not
gate a write — `getSession`, `getLatestTurn` — may stay outside (their movement
is a separate, optional call).

The transaction body is then: `getOrphanTurns` (orphan selection) → backfill
UPDATEs → invalidation UPDATEs → lineage writes → `recoverStrandedAncestors`
(cheap indexed DB reads + enqueues) → orphan/turn UPDATEs → `enqueueQueueItem` →
`upsertSession` (D3) → subagent cleanup. Lock-hold drops from "megabytes of JSONL
parse" to sub-millisecond; **no `*.jsonl` read occurs inside any transaction.**

### D2 — Short `IMMEDIATE` write transaction, retry on `SQLITE_BUSY`

Add one shared helper in `src/db/database.ts`:

```ts
export function runWriteTransaction<T>(db: Database, fn: () => T, attempts = 3): T {
  const txn = db.transaction(fn);            // bun:sqlite: base call is DEFERRED
  for (let i = 0; ; i++) {
    try { return txn.immediate(); }          // BEGIN IMMEDIATE; return fn's value verbatim
    catch (err) {
      if (i >= attempts - 1 || !isSqliteBusy(err)) throw err;
      // brief deterministic backoff; no Date.now/Math.random in hot path
    }
  }
}
```

It is **generic and value-returning** — `pending-queue.ts`'s claim transaction
returns `PendingQueueItem | null` and its caller depends on that
(`pending-queue.ts:147,154`); a `void` helper would break it. `txn.immediate()`
returns whatever `fn` returns, passed straight through.

- `txn.immediate()` issues `BEGIN IMMEDIATE`, taking the write lock at the start.
  There is no read-then-upgrade, so `SQLITE_BUSY_SNAPSHOT` cannot occur; a
  concurrent writer instead makes us **wait** on the lock under `busy_timeout`
  (5 s) — the case `busy_timeout` is actually for.
- `isSqliteBusy(err)` matches `SQLITE_BUSY` / `SQLITE_BUSY_SNAPSHOT` (message or
  code). The retry covers the rare residual "lock still held": roll back and
  re-run on a fresh snapshot. With D1 making the body sub-ms, retries should be
  near-zero in practice.

**D2a — bounded wait on the synchronous hook path.** A hook is **synchronous**:
`hook-command` `await`s the handler before returning (`hook-command.ts:139,147`),
so the user's turn blocks for the whole write. With the global `busy_timeout =
5000` (`database.ts:32`), `attempts = 3` is a worst case of **~15 s** of blocking
— *worse* than today's fail-fast. That is unacceptable for the foreground path.

So hooks use a dedicated **`runHookWriteTransaction`** with a **bounded total
budget** (target ≈ **2–3 s**), not the generic `attempts = 3 × 5 s`:

- Lower the **per-attempt** wait for hook connections — set `PRAGMA busy_timeout`
  to ~**800 ms** on hook DB connections (the worker/MCP keep 5 s) — and cap by
  *total elapsed*, not a fixed attempt count. Plumbing is explicit: extend
  `createDatabase(path?, { busyTimeoutMs = 5000 })`; `hook-command.ts:36` calls it
  with `{ busyTimeoutMs: 800 }`, while worker/MCP call sites keep the default.
- **On budget exhaustion, fall through to the existing non-blocking path**: log
  `[HOOK] …` and return `HOOK_NON_BLOCKING_EXIT_CODE`; the next SessionStart
  `recoverStrandedTurns` re-extracts. I.e. bounded blocking → graceful degrade to
  the *self-healing* path, rather than a 15 s hang. Post-D1 the body is sub-ms, so
  the budget is effectively never approached; the cap just bounds the pathological
  tail.

`runWriteTransaction` (generic, 5 s × 3) stays for the **worker** and other
non-foreground writers, where a longer wait is fine.

### D3 — Apply the helper to the other DEFERRED read-modify-write transactions

Replace the bare `db.transaction(fn)()` call sites. **Foreground hook** sites use
the bounded **`runHookWriteTransaction`** (D2a) — `stop.ts:125`,
`post-tool-use.ts:62`, and SessionStart (D5). **Non-foreground** sites use the
generic `runWriteTransaction` (5 s × 3) — `subagent-filter.ts:167` (worker),
`lineage.ts:341` / `pending-queue.ts:91` when called outside a hook. Pure-insert
transactions with no prior read gain nothing from IMMEDIATE but lose nothing;
routing them through the two helpers keeps the policy in one place.

**The Stop handler's writes must *all* be inside one such transaction**, or the
goal ("lock-wait retried, not surfaced") is false. Today `upsertSession`
(`stop.ts:197`, which writes `sessions` + `indexSessionToFTS`, `sessions.ts:74,144`)
and `detectAndCleanSubagentTurns` (`stop.ts:210`) run **after** the main
transaction as bare writes — a BUSY there still bubbles to
`[HOOK] …` (`hook-command.ts:150`). Fold both into the single Stop
`runHookWriteTransaction` body (D1 lists them last in the body). They are pure DB
writes (subagent cleanup, once threaded the preloaded entries, does no file I/O),
so folding them in is safe and brings them under the same IMMEDIATE-lock +
bounded retry.

**Do not double-wrap.** A helper invoked **inside** the Stop `runHookWriteTransaction`
(e.g. `relinkSessionLineage`, which has its own `db.transaction` at
`lineage.ts:341`) must **not** re-wrap in another transaction helper. Two options, both
correct: (a) inline its writes (drop the inner `db.transaction`) since the outer
IMMEDIATE already provides atomicity; or (b) leave the inner `db.transaction` —
bun:sqlite nests it as a **savepoint** within the outer IMMEDIATE (verified: an
outer `.immediate()` enclosing an inner `.immediate()` commits cleanly), so on an
outer retry the whole body re-runs. Prefer (a) for the Stop path to keep one lock
scope; reserve `runWriteTransaction` wrapping for the **standalone** call sites
(`lineage.ts:341` when called outside Stop, `subagent-filter.ts:167` from the
worker, `pending-queue.ts:91`). `post-tool-use.ts:62` is a foreground hook and
uses `runHookWriteTransaction`, not the generic helper.

### D5 — SessionStart shares the hole; bring its write set under the same path

SessionStart is also a synchronous hook that does read-then-write and routes
failures through the same `[HOOK] …` non-blocking path (`hook-command.ts:150`):
`upsertSession` (`session-init.ts:50`), `applyInvalidation` (`:62`, which parses
the transcript), `detectAndCleanSubagentTurns` (`:68`, inner transaction in
`subagent-filter.ts:167`), `getMaxPromptNumber` (`:76`, the read that decides the
INSERT key), and `createPendingTurn` (`:83`, INSERT at `:22`). A BUSY there
silently drops session-init writes (e.g. the session's first turn isn't created),
and leaving `getMaxPromptNumber` outside the IMMEDIATE lock leaves a TOCTOU race
against `UNIQUE(session_id, prompt_number)` (`schema.ts:60`). This is the same
defect class as the observed Stop failure, so leaving it out would contradict
this fix's title.

Apply the **same pattern** to SessionStart's minimal write set:

- Parse the transcript **once outside** the transaction (for `applyInvalidation`'s
  sets, subagent matching, and the fallback prompt count), per D1 — no file I/O
  inside. Split/extend `countUserPromptsInTranscript` so the count can be computed
  from preloaded entries instead of re-reading.
- Wrap `upsertSession` + `applyInvalidation`(apply) +
  `detectAndCleanSubagentTurnsFromParsed` + `getMaxPromptNumber` +
  `createPendingTurn` in **one `runHookWriteTransaction`** (D2a bounded budget —
  SessionStart is foreground). The final `promptNumber` decision happens **inside**
  the IMMEDIATE transaction: use DB max when present, else the precomputed
  transcript prompt count + 1.
- **Stay synchronous** — do not async-ify SessionStart to dodge the wait; the
  bounded budget + graceful degrade (D2a) is the latency contract.

Lower-frequency than Stop/PostToolUse, but the fix is the same helper at near-zero
marginal cost, and it closes the analogous race.

### D4 — Make `bun-runner.js`'s module type explicit (ship a package.json)

Add `plugin/scripts/package.json`:

```json
{ "type": "module" }
```

- `plugin/scripts/` contains exactly one `.js` (`bun-runner.js`, which **is**
  ESM); the four build outputs are `.cjs` and are CommonJS by extension
  regardless of the nearest `type`. So this is collision-free.
- `scripts/build.js` writes only the `.cjs` files into the directory and never
  cleans it (`build.js:38-59`), so the file survives rebuilds.
- It ships inside `plugin/` (marketplace `source: "./plugin"`), so the installed
  copy carries it and Node resolves `type` locally — the user's `~/package.json`
  is never touched.

## Test strategy

- **`runWriteTransaction`** (unit): a body that throws a non-BUSY error
  propagates (no retry); a simulated `SQLITE_BUSY` succeeds on retry; exceeding
  `attempts` rethrows; the body runs under `immediate`; **the helper returns the
  body's value** (a body returning an object is returned verbatim — guards the
  generic queue-claim path).
- **concurrency regression** (integration, real file DB not `:memory:`): the lock
  must be **held and released from a separate process / `Worker`** — bun:sqlite's
  transaction API is synchronous, so connection A's IMMEDIATE wait blocks the JS
  thread and a same-thread `setTimeout` to release B would never fire. Two
  variants: (a) a child process holds a write, releases after a delay, and the
  parent's `runWriteTransaction` (connection A) waits-then-commits; (b) a
  **fail-fast control** with a tiny `busy_timeout` shows DEFERRED → `SQLITE_BUSY`
  while `runWriteTransaction`'s retry recovers. At minimum ship (b) plus the
  simulated-BUSY unit test; (a) if the harness supports a child holder.
- **orphan dedup under concurrency** (unit/integration): with `getOrphanTurns`
  moved inside the IMMEDIATE transaction, an orphan turn is enqueued **once** even
  when a competing enqueue lands between selection and write — the read+enqueue is
  atomic under the write lock (guards the TOCTOU fix).
- **`detectAndCleanSubagentTurns` callers** (unit): the path-taking wrapper still
  works for SessionStart / worker-compact callers; the new
  `…FromParsed` variant produces identical results given the same transcript;
  changing one does not break the other.
- **in-txn order preserved** (unit): after a Stop over a fixture where backfill
  sets `content_prompt_id`, the in-transaction `applyInvalidation` and lineage
  resolution observe the **backfilled** ids (i.e. they run after backfill, not on
  stale ids). A fixture where pre-backfill ids would give a different lineage
  parent than post-backfill ids pins the ordering.
- **single transcript read** (unit): inject a `readAllTranscriptEntries` /
  `parseReplayTranscript` spy; assert each file read happens **before** the
  transaction opens and the total file-read count is the expected small constant
  — in particular the lineage zero-overlap fallback (`resolveViaLogicalParent`)
  does **not** trigger a second read.
- **all Stop writes are inside the transaction** (unit): a simulated BUSY raised
  during the `upsertSession` / subagent-cleanup phase is retried, not surfaced as
  `[HOOK] …`.
- **bounded hook budget** (unit): `runHookWriteTransaction` caps total elapsed at
  the budget (uses the lower hook `busy_timeout`); on persistent BUSY it stops
  within budget and the handler returns the non-blocking exit code + `[HOOK]` log
  (graceful degrade), rather than blocking for `5 s × 3`. A clock injection /
  short busy_timeout makes this deterministic. A DB factory test proves
  `createDatabase(..., { busyTimeoutMs: 800 })` is used by `hook-command` while
  worker/MCP connections keep the 5 s default.
- **SessionStart write set** (integration): SessionStart's
  `upsertSession`+invalidation+subagent cleanup+`getMaxPromptNumber`+
  `createPendingTurn` commit under one `runHookWriteTransaction` with the
  transcript parsed outside; a held lock makes it wait-then-commit within budget;
  behavior parity vs the pre-refactor rows.
- **SessionStart prompt-number race** (integration): two concurrent SessionStart
  handlers for the same session cannot both choose the same next prompt number;
  the `getMaxPromptNumber` read and `createPendingTurn` insert are atomic under
  the IMMEDIATE lock.
- **behavior parity**: Stop handler over a fixture transcript produces the same
  turn/observation/lineage/queue/session rows as before the refactor (golden
  compare).
- **D4**: `plugin/scripts/package.json` exists with `{"type":"module"}`; a smoke
  run of `node plugin/scripts/bun-runner.js` emits no `MODULE_TYPELESS_PACKAGE_JSON`
  warning on stderr.

## Acceptance

- Under two concurrent writers on a real WAL DB, the Stop handler's **entire**
  write set (main body + `upsertSession` + subagent cleanup) commits (waiting if
  needed) instead of logging `[HOOK] database is locked`; the DEFERRED control
  still fails.
- **SessionStart**'s write set (`upsertSession` + invalidation + subagent cleanup
  + `getMaxPromptNumber` + `createPendingTurn`) is under the same bounded hook
  transaction (D5); a BUSY there is retried within budget, not surfaced, and the
  prompt-number read/insert is atomic.
- **Foreground hooks block for at most the bounded budget (~2–3 s), then degrade**
  to the non-blocking `[HOOK]` + resume-recovery path — never the ~15 s worst case
  of `5 s × 3` (D2a).
- No transcript file read occurs inside any write transaction; the per-hook file
  read happens once, before the transaction (lineage fallback included).
- In-transaction order (backfill → invalidate → relink) is preserved, so
  invalidation/lineage read backfilled `content_prompt_id`.
- `node plugin/scripts/bun-runner.js …` produces no module-type warning.
- `bun test` green; `bun run typecheck` clean.

## Rollout

- This is a **bug hotfix** and should ship before the timeline-view feature.
  Bump 0.2.26 → **0.2.27** across `package.json`,
  `plugin/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  (4 fields, per `project_version_bump_three_places`); `node scripts/build.js`;
  reload.
- **Version coordination:** the timeline-view spec
  (`2026-06-06-timeline-view-enum.md`) already reserves **0.2.28** and ships after
  this hotfix's 0.2.27.
