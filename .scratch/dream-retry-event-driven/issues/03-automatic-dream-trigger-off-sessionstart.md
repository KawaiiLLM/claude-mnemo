# 03 — Move the automatic dream trigger off SessionStart onto end-events

**What to build:** Opening a Claude session no longer enqueues or runs an automatic dream. Today the dream backlog reconcile (which enumerates due content-days and enqueues them) runs in the SessionStart Context hook, firing once per new session regardless of activity — the wrong signal (a "beginning" event driving work about past activity, at per-session frequency). Move it onto the same end-of-activity drain path (turn-stop / session-end / compact) that already carries extraction flush and the dream retry drain, so a day the worker owes is picked up on the first end-event after it becomes complete, with no catch-up gap.

**Blocked by:** 01 (no logical dependency, but the new reconcile seam sits in `diary-runtime.ts` beside 01's resurrection wiring; sequence after 01 to avoid conflicting edits). If run under worktree isolation this could go in parallel with 01.

**Status:** ready-for-agent

- [ ] A new runtime-owned seam `reconcileDreamBacklog(nowEpoch): Promise<void>` on `DiaryRuntime` orchestrates the automatic backlog reconcile: it runs `initializeBootstrap`, reads the last-successful marker via the store it already owns, applies the trigger-hour gate, and calls the unchanged `DiaryStateStore.reconcileBacklog`.
- [ ] The SessionStart Context hook no longer calls `reconcileBacklog` or `initializeBootstrap`; it no longer enqueues or triggers any automatic dream. (SessionStart's own env capture / run marker is left untouched.)
- [ ] The bootstrap responsibility is carried by the new seam. NB `initializeBootstrap` is currently invoked only from SessionStart and from `POST /dream` — NOT from worker startup — so removing the SessionStart call must not assume bootstrap happens elsewhere.
- [ ] `reconcileDreamBacklog` is invoked from the end-event drain path (turn-stop / session-end / compact), before the diary drain and after extraction has drained — the same `scanAndDrainGlobalQueue` → drain sequence that already carries the retry drain.
- [ ] The trigger-hour gate lives inside the seam so a still-open content-day is not enqueued prematurely; the 02 completeness gate is the backstop.
- [ ] reconcile stays cheap/idempotent (INSERT-ON-CONFLICT enqueue + terminal demotion, no attempt reset) and never re-grants budget to a terminal day, so running it on every end-event is safe.
- [ ] Manual `POST /dream` is unchanged.
- [ ] Tests: `tests/hooks/context.diary.test.ts` (SessionStart with a due day enqueues nothing; env/marker capture not asserted away); `tests/worker/server.test.ts` (an end-event runs `reconcileDreamBacklog` after the trigger hour and a complete due day is enqueued + drained; the seam does its own bootstrap with no prior `initializeBootstrap`; a day completing after SessionStart is picked up on the next end-event).
- [ ] `bun test`, `tsc`, `bun run build` green. Read-only git. No version bump, no `.cjs` hand-edit, no touching live `~/.claude-mnemo` data.
