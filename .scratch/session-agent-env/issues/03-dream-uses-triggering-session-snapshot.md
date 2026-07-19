# 03 — Dream uses the triggering session's env snapshot

**What to build:** The nightly dream agent runs on the account of the live session that triggered it, instead of the worker's frozen first-spawn env — so it uses a currently-available account rather than stalling when one fixed account is exhausted. When that session's env is no longer available, the dream falls back to the sanitized operational baseline (which, having no auth, surfaces the unavailability rather than running on a wrong account).

See `../spec.md` → "Dream agent env — triggering session's snapshot (best-effort)" for the full rationale.

**Blocked by:** 02 (per-session in-memory env registry). Also rides on the dream-turn-gated-trigger change (`.scratch/dream-turn-gated-trigger/`, ticket 01) that makes the dream fire from a session's turn-stop.

**Status:** ready-for-agent

- [ ] When the global diary drain decides to run the dream, it snapshots the currently-registered env of the session whose turn-stop triggered that drain, and the dream agent spawns with that snapshot.
- [ ] The snapshot is best-effort and in memory: if the triggering session's env is unavailable (session ended, entry cleared), the dream falls back to the sanitized operational baseline — no structured completion-record persistence, no dedicated-override tier.
- [ ] A claudex-triggered dream resolving `opus` through claudex's own env is accepted (availability beats determinism); a dream that cannot obtain any triggering env surfaces the unavailability rather than silently running on a wrong account.
- [ ] `dream-job` / `diary-runtime` job logic, staging, and the commit transaction are NOT changed — only which env the dream spawns with.
- [ ] Tests at the worker-core seam: a dream fired by session A's turn-stop spawns with A's snapshot; when A's entry is cleared before spawn, the dream falls back to the baseline.
- [ ] `bunx tsc --noEmit` passes; `bun test` does not regress vs baseline (the single stale-bundle-guard failure is the expected baseline).

## Constraints

- Do NOT run any git command; only edit files.
- Do NOT bump the version or rebuild `plugin/scripts/*.cjs`.
- Do NOT touch live data under `~/.claude-mnemo`.
