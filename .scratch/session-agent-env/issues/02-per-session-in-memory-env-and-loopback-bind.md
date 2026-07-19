# 02 — Per-session in-memory env + loopback bind

**What to build:** Each session's memory agent runs with THAT session's own account/endpoint/proxy — captured when the session starts, held only in worker memory, and applied when the agent spawns — instead of the worker's frozen first-spawn env. The spawned agent no longer inherits unrelated worker secrets (`GITHUB_TOKEN`, `AWS_*`); it gets only a minimal operational baseline plus the session's captured subset. A session whose env has not yet been captured leaves its queued work un-extracted rather than running it on a guessed account. And the worker binds loopback so the newly credential-bearing capture endpoint is not exposed to the LAN.

See `../spec.md` → "Env capture", "Agent env — BUILT from an allowlist", "Presence-gated extraction", "Worker crash recovery", "Security — bind loopback" for the full rationale.

**Blocked by:** None — can start immediately (independent of 01).

**Status:** ready-for-agent

- [ ] The worker's Bun server binds `127.0.0.1` (not the default `0.0.0.0`). This lands FIRST — the capture endpoint must never accept credentials on a LAN-reachable socket.
- [ ] The spawned agent env is BUILT, not inherited: a minimal operational allowlist (`HOME`, `PATH`, temp, `LANG`/`LC_*`, cert config, and the like) + the captured session subset + mnemo overrides. `GITHUB_TOKEN`, `AWS_*`, and the worker's own auth do NOT reach the agent.
- [ ] The captured session subset carries: whatever auth the session has (`ANTHROPIC_AUTH_TOKEN` and/or `ANTHROPIC_API_KEY` and/or `CLAUDE_CODE_OAUTH_TOKEN`, both carried verbatim when both present, no invented precedence); `ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS`, `NODE_EXTRA_CA_CERTS`; `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`; all 8 proxy variants (`http_proxy`/`https_proxy`/`all_proxy`/`no_proxy` × both cases, conflicting cases preserved exactly).
- [ ] `ANTHROPIC_MODEL` and effort vars (`CLAUDE_CODE_EFFORT_LEVEL` …) are excluded even when the source session set them (regression test: source sets `ANTHROPIC_MODEL`, assert the explicit `--model` still wins).
- [ ] The captured env is held in an in-memory registry keyed by session: captured at SessionStart (keyed by `content_session_id`, associated to the DB id once it exists), refreshed on each trigger POST (last capture wins), and cleared when the session ends. A capture that differs from the running query's env recycles that session's query before its next unit of work.
- [ ] Exactly one SessionStart handler performs the capture, as a side POST that does NOT convert the context-returning hook to async-only (memory injection must still be returned). The capture POST carries the session identity + the curated subset and only that subset.
- [ ] When the worker is down, the hook (still alive) starts it and hands the same captured env over once the worker is ready, before the flush — no separate `CLAUDE_MNEMO_FLUSH_SESSION_ID`-only path.
- [ ] Presence-gated extraction: the worker extracts a session's queued row ONLY when that session's env is registered in memory; otherwise the row is left queued and picked up once the capture arrives. A session with no registered env never gets a guessed-auth agent.
- [ ] Worker crash recovery is by re-announce, not persistence: a still-alive session re-announces its env on its next turn-stop; orphaned work from an already-ended session stays queued and ages out. No SQLite env persistence, no generation numbers, no worker-incarnation tracking.
- [ ] Wire the billing blocked-state clear: ticket 01 exposed `clearBlockedSession()` (tested in isolation) but left it without a production caller. The env-capture path here MUST call it when a fresh env capture arrives for a session, so a re-authenticated/rotated account clears its `blocked` flag (spec US 15).
- [ ] Tests (pure-function env construction; worker-core spawn seam; hook payload): operational-allowlist keys survive while `GITHUB_TOKEN`/`AWS_*`/worker-auth do not reach the agent; session A spawns with A's env and B with B's; a row whose session lacks a registered env is left un-extracted until it registers; a session-stop clears the entry; dual-auth carried verbatim; API-key-only source keeps its key; the server binds `127.0.0.1`.
- [ ] `bunx tsc --noEmit` passes; `bun test` does not regress vs baseline (the single stale-bundle-guard failure is the expected baseline).

## Notes

- Confirm the exact env-var spelling the live prototype exercised (`ANTHROPIC_DEFAULT_OPUS_MODEL` vs a shorthand) before coding.

## Constraints

- Do NOT run any git command; only edit files.
- Do NOT bump the version or rebuild `plugin/scripts/*.cjs`.
- Do NOT touch live data under `~/.claude-mnemo`.
