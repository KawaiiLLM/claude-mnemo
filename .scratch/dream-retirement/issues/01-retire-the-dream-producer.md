# 01 — Retire the dream. The producer goes; nothing that reads is touched.

**What to build:** the nightly dream/diary/persona agent leaves the product. Only the PRODUCER is removed — every reader and every injection surface is left exactly as it is, so that nothing about the persona has to be decided now (user ruling S15069/T2323: 以后再弄，现在不考虑什么人格).

**Blocked by:** None. Do not start while another ticket is mid-flight in this working tree — it rebuilds bundles.

**Status:** DONE (2026-09-01)

## Why

Every dream output has been frozen since **2026-08-08 12:13** — `diary/INDEX.md`, the day files, `memory/archive.md` and `memory/user-profile.md`. Today is 2026-09-01: **24 days, zero output**, while `reconcileDreamBacklog` and `dreamAgentHour` remain wired in `server.ts`. It is scheduled and produces nothing, and nobody noticed — a 24-day natural experiment on its value, which is better evidence than any argument for or against it.

Settlement covers the overlapping half: lane impressions do container-level narrative compression, written by the agent that actually runs.

## The key property: this changes nothing observable

The injection surfaces read FILES ON DISK. Those files stopped changing 24 days ago, so today's injected bytes already are the post-retirement bytes. Removing the producer is observationally a no-op — which is exactly why the persona question can be deferred rather than answered.

- [x] Remove the producer: `diary-runtime.ts`, `diary-sdk-query.ts`, `dream-job.ts`, `dream-staging.ts`, `dream-agent-tools.ts`, `diary-material.ts`, and the scheduling in `server.ts` (`reconcileDreamBacklog`, the `dreamAgentHour` boundary).
- [x] **Do NOT touch any reader or injection path.** The persona block and the diary index keep rendering from whatever is on disk. No decision about the persona is made in this ticket.
- [x] **Do NOT touch the files** under `~/.claude-mnemo/diary/`, `~/.claude-mnemo/memory/` or `~/.claude-mnemo/persona/`. They are the user's data; whether to clear them is a separate call they have not made.
- [x] `diary_state` and `diary_day_state` go INERT — no reads, no writes, `CREATE TABLE` stays in schema.ts. Same pattern this codebase has now used for the disposition ledger and the justify tables; dropping is irreversible and buys nothing.
- [x] **`worker.cjs` contains ZERO SDK package-name bytes** and `MODEL_SUBPROCESS_ENTRY_POINTS` shrinks to `[]`. The release-artifacts guard pins both. This is the ticket's most valuable side effect: the dream was the last in-process model call, and its removal makes "the worker core holds no model client" a guarded invariant instead of an aspiration.
- [x] `.scratch/claim-monitor-repair/issues/03-dream-is-the-last-in-process-model-call.md` is marked DISSOLVED, not implemented — its entire reason for existing was containing this SDK path, and deleting the path is the stronger fix. Say so in that file.
- [x] Report what the removal frees on the injection side: the diary index shared a 2000-token budget with RecentSessions.
- [x] `npx tsc --noEmit` clean; touched suites green; full `bun test` once; bundles rebuilt, stale-bundle guard green; `git diff --check` clean.

## Outcome (2026-09-01)

**Deleted (9 source files).** The 6 the ticket names, plus `diary-agent-runner.ts`
and `diary-agent-tools.ts` — nothing outside the cluster imported either, and
`diary-agent-tools.ts` held one of the two worker-side `@anthropic-ai` imports,
so leaving it would have left dead code carrying the exact byte the ticket is
trying to remove. Plus `db/diary-state.ts`, which is forced by "the tables go
INERT": it is the only module that reads or writes them.

**`worker.cjs` SDK bytes: 1 → 0. `MODEL_SUBPROCESS_ENTRY_POINTS`: `["src/worker/diary-runtime.ts"]` → `[]`.**
Both pinned. The source walk is now exemption-free; the byte-level half is a new
release-artifacts test that also asserts `settlement-child.cjs` still CONTAINS
the string, so the detector is proven to fire rather than trivially passing.

**The injection-side accounting is not what this ticket assumed.** It asks what
the removal frees, "the diary index shared a 2000-token budget with
RecentSessions". Answer: **nothing, now.** That slot was already dead before this
ticket — `renderSessionStartRecentSessionsInjection` (and with it
`renderSessionStartDiaryIndex`, `SESSION_INJECTION_TOKEN_BUDGET` = 2000 and its
`DIARY_INDEX_INJECTION_TOKEN_BUDGET` = 1000 sub-cap) has had no `src/` caller
since RecentSessions was retired at an earlier ticket, which
`tests/hooks/context.diary.test.ts` already documented. The 2000 tokens were
freed then. What remains live is `PROFILE_INJECTION_TOKEN_BUDGET` = 2000 for the
persona block alone, and this ticket does not touch a byte of it — which is the
whole point: the injected bytes today are the injected bytes tomorrow.

**Left standing deliberately** (reported, not fixed): `src/rules/dream-read-tools.ts`,
`dream-write-tools.ts`, `sidecar-ingest.ts` and `trigger-index.ts` lost their only
caller with `dream-job.ts` and are now unreferenced. They are the RULES
subsystem's surface, not the dream's, and one of its readers is live
(`pretooluse-dispatcher.ts` still reads `trigger-index.json` at hook time — the
file's producer is gone, so it will serve whatever is on disk, frozen, exactly
like the diary). Retiring the rules subsystem is a product call this ticket was
not given. Same reasoning for `src/shared/config.ts`, which is untouched:
`dreamAgentTimeZone`/`dreamAgentHour` are LOAD-BEARING (they are the content-day
boundary the stranded-turn repair derives its dates from, `server.ts` →
`turn-liveness.ts`) and keep their historical names because they are a persisted
user config surface; `dreamAgentEnabled`, `dreamAgentModel`,
`dreamAgentMaxThinkingTokens`, `dreamAgentTimeoutMs`,
`dreamAgentIdleWatchdogMs` and `dreamAgentBacklogLimit` are now inert.
`KNOWN_DREAM_AGENT_MODELS`/`DreamAgentModel` must NOT be deleted with the dream
— `noteSettlementModel` is typed from them.

**One safety finding.** `db/pending-queue.ts`'s generic claim excludes
`kind != 'diary'`. That clause is now vacuous for new rows but must STAY: a
production database can still hold orphaned `diary` rows, and removing it would
let the generic drain claim and retire them as if they were `obs`/`turn-stop`
work.
