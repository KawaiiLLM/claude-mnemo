# Per-session agent env + tier-alias models

**Status:** draft

> Design deliberately kept to an in-memory, single-user, localhost model. The round-2/round-3 Codex machinery (SQLite-persisted `env_generation`/`env_revision`, worker-incarnation restart recovery, durable retry floor, per-env workers) was reviewed at a multi-tenant-service rigor that does not apply here. We accept ONE tradeoff instead — see "The one accepted degradation" — and that collapses the distributed complexity.

## Problem Statement

There is ONE memory worker per `~/.claude-mnemo`, but the user runs many concurrent Claude Code sessions with different API configs — official-account sessions, `claudex` sessions routed through a proxy (`ANTHROPIC_BASE_URL=cli.moedb.moe:9443`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_DEFAULT_OPUS_MODEL=gpt-5.6-sol`, reachable only via the local mihomo proxy), and VPS `anon` sessions (`ANTHROPIC_API_KEY` + `BASE_URL=172.17.0.1:8317` over the docker bridge, no proxy).

Today every memory agent the worker spawns inherits the WORKER's own `process.env` (via `buildIsolatedEnv`, which copies `process.env` minus only `ANTHROPIC_API_KEY` and `CLAUDECODE`), frozen at whatever session first spawned the worker. Consequences:

- A session's own extraction/grading may run against the WRONG account/endpoint/model — a claudex session's turns extracted through the official account, or vice-versa; a stale value (the `proxy.moedb.moe` dead-domain incident) lingers because it was the first spawner's env.
- Models are pinned to literal version IDs (`claude-sonnet-5` for extraction; `claude-opus-4-8` default for dream), so every model release needs a code bump and the pinned ID ignores a session's own routing.
- Because the worker is started with the caller's FULL env, unrelated secrets (`GITHUB_TOKEN`, `AWS_*`, …) are carried into every spawned agent — a pre-existing leak.

## Solution

Record each session's env in memory at startup; spawn that session's extraction agent with the same env. Plus request tier aliases (`opus`/`sonnet`) so a session's own env resolves the model. Concretely:

1. **In-memory per-session env registry.** Capture a curated env subset when a session starts (and refresh it if it changes), keyed by session, held only in worker memory. Spawn that session's agent from it. When the session stops, the entry clears.
2. **Tier aliases, not literal IDs.** mnemo requests `opus`/`sonnet`; the spawned subprocess resolves the alias from the session's own `ANTHROPIC_DEFAULT_*_MODEL`. No code bump on model releases; the alias tracks the session's routing.
3. **Agent env is BUILT, not inherited.** The agent env = a minimal operational allowlist + the captured session subset + mnemo overrides — NOT the worker's full `process.env`. This is what closes the `GITHUB_TOKEN`/stale-env leak.

The dream agent is cross-session and uses the env of the session that triggered it (best-effort snapshot).

### The one accepted degradation

The registry is in-memory by design (secrets never touch disk). So a worker crash loses it. Recovery is NOT from a persisted record — it is:

- **Session still alive after restart** → its next turn-stop hook (running inside the live session, reading its env) re-announces the env automatically. Self-heals.
- **Session already ended before restart** → no live process to re-announce; that orphaned queued work has no env. It stays queued (never extracted on a guessed account) and ages out if the session never returns.

We ACCEPT that a crash + an already-ended session can lose a small amount of orphaned extraction. For a single-user local memory system this is far cheaper than the persistence/sequencing machinery it would take to avoid. This one decision is what makes the whole design simple.

## User Stories

1. As a user running a claudex session, I want its turns extracted through claudex's own account/endpoint, so that extraction bills and routes where that session does.
2. As a user running an official session alongside claudex, I want each session's memory agent to use its own account, so that they do not cross-contaminate.
3. As a user, I want `opus`/`sonnet` requested as tier aliases, so that a model release needs no mnemo code bump.
4. As a user, I want a claudex session's `opus` to resolve to its `ANTHROPIC_DEFAULT_OPUS_MODEL` (e.g. `gpt-5.6-sol`) via its own env, so that its extraction runs where that session runs.
5. As a user, I never want the worker's frozen first-spawn env (a dead `proxy.moedb.moe`, a stale CA) applied to a later session's agent.
6. As a claudex user, I want the proxy env carried so the agent can reach `cli.moedb.moe:9443`.
7. As a user, I want the spawned agent to NOT inherit unrelated worker secrets (`GITHUB_TOKEN`, `AWS_*`), so that only the operational baseline + the session's own auth reach it.
8. As a user, I want secrets kept in memory and never written to SQLite or logs — INCLUDING when echoed inside an error body.
9. As a user whose session authenticates with `ANTHROPIC_API_KEY` (anon / an official API-key account), I want that source's agent to still authenticate.
10. As a maintainer, I want memory curation NOT to inherit a session's reasoning-effort setting.
11. As a user, I want `--model opus/sonnet` to stay authoritative over any inherited `ANTHROPIC_MODEL`.
12. As a maintainer, I want a session with no captured env to leave its queued work UN-extracted (waiting for re-announce), rather than run it on a guessed account.
13. As a user, I want the worker to bind loopback only, so that adding credential-bearing endpoints does not expose tokens to other LAN hosts.
14. As a user whose account hits a quota / rate limit, I want the affected turns suspended and retried on the next turn-stop, not finalized failed and dropped.
15. As a user whose account is hard-blocked (billing / credit exhausted), I want the work retained and NOT respawned on every turn-stop.
16. As a user, I want the dream to run on the triggering session's account, so that it uses a currently-available account instead of stalling.

## Implementation Decisions

### Env capture — in-memory registry, keyed by session

- **Capture a curated subset** in the hook (which runs inside the CC session process and can read its env), delivered on the trigger POST with the session's identity, held in a worker in-memory map keyed by session. Refresh on each trigger POST (last capture wins); when a capture differs from the running query's env, recycle that session's query before its next unit so the change takes effect.
- **Clears on session stop.** When the session ends, the entry is dropped (nothing to persist).
- **SessionStart capture detail:** a new session has no numeric DB id until its first `UserPromptSubmit`; capture keyed by `content_session_id` and associate once the DB row exists. Exactly ONE SessionStart handler performs the capture, and it must NOT convert the context-returning hook to async-only (that would suppress memory injection) — capture as a side POST.
- **Offline path:** when the worker is down, the hook already spawns it; the hook is alive at that moment, so it hands the captured env over on the same POST once the worker is ready, before the flush. (No separate `CLAUDE_MNEMO_FLUSH_SESSION_ID` semantics.)

### Agent env — BUILT from an allowlist, not the worker's full env

The agent env is assembled, not inherited:

1. **Minimal operational allowlist** from the worker env — only non-secret runtime keys the subprocess needs: `HOME`, `PATH`, `TMPDIR`/temp, `LANG`/`LC_*`, `SSL_CERT_*` / cert config, and the like. NOT arbitrary secrets, NOT `GITHUB_TOKEN`/`AWS_*`, NOT the worker's own auth.
2. **The captured session subset** (below).
3. **mnemo overrides** (`CLAUDE_CODE_ENTRYPOINT`, cache-TTL flags, `CLAUDECODE` as today).

**Captured session subset:**

- Auth: whatever the session actually has — `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`. No conditional strip (the baseline carries no auth to begin with). If a session sets both `AUTH_TOKEN` and `API_KEY`, carry both verbatim; do not invent precedence.
- Endpoint: `ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS`, `NODE_EXTRA_CA_CERTS`.
- Tier resolution: `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`.
- Proxy — all 8 variants: `http_proxy`/`https_proxy`/`all_proxy`/`no_proxy` in both cases, carried exactly (conflicting cases preserved, not normalized).

**Excluded:** `ANTHROPIC_MODEL` (mnemo passes `--model`; add a conflict regression test) and effort vars (`CLAUDE_CODE_EFFORT_LEVEL` …). Excluding effort means "use the subprocess default," not "a mnemo-chosen effort" — the benefit is only insulation from a session's low effort.

**Fallback:** a session with no registry entry does NOT get a guessed-auth agent; its work waits un-extracted (US 12). Because the operational allowlist carries no auth, there is no wrong-account extraction and no leak by construction.

**Naming to confirm:** the whitelist uses the full CC var names (`ANTHROPIC_DEFAULT_OPUS_MODEL`); the Problem Statement's `DEFAULT_OPUS_MODEL` is shorthand. Confirm the exact spelling the live prototype used before coding.

### Presence-gated extraction — the simple rule replacing sequence numbers

The hook commits the queue row to SQLite before it notifies the worker, and a drain triggered by another session could reach the row first. Instead of monotonic generation numbers, one rule: **the worker extracts a session's queued row ONLY when that session's env is registered in memory; otherwise it leaves the row queued.** The window (row committed, capture POST milliseconds behind) self-heals — the env arrives and the next drain picks it up; and SessionStart capture normally precedes any turn-stop row anyway. A mid-session env change applying to an already-queued in-flight row is NOT guaranteed (a refinement we decline).

### Worker crash recovery — re-announce, not persistence

Covered under "The one accepted degradation": live sessions re-announce on their next turn-stop; orphaned already-ended-session work waits and ages out. No SQLite env persistence, no worker-incarnation tracking, no generation gate to reconcile.

### Security — bind loopback

The worker's Bun server specifies no hostname and thus binds `0.0.0.0` (LAN-reachable) today. Since the capture POST now carries tokens / API keys / proxy creds, the server MUST bind `127.0.0.1`. This is a precondition of the env ticket, not optional. (The loopback hop is then plaintext-accepted.)

### Secrets — in-memory only, plus an error-string sanitizer

The captured env lives only in the in-memory registry; never SQLite, on-disk state, or logs. The dream writes `error.message` to SQLite and a remote gateway may echo `authorization` / custom headers / a proxy URL with userinfo inside the body — field-name redaction cannot clean a value already in a string. A single shared sanitizer guards logs and the persisted error: value-level replacement of the current snapshot's sensitive values + structural stripping of URL userinfo / `authorization` / `cookie` / header values; persist a stable `type`/`status`/`request-id`, not the full body.

### Quota / usage-limit failures reuse the connection path (in-memory)

- Today any thrown error with a numeric `status` is `deterministic`, so a 429/quota/529 burns the retry budget and is finalized `terminal failed` + dequeued — lost. The same outage streamed as `system/api_error` / `assistant/server_error` is already `connection`.
- **A transient / deterministic / blocked matrix**, before the generic `status → deterministic` fallthrough:
  - **Transient** (existing 0.6.2 suspend + event-driven retry on the next turn-stop): 408, 409, 429, 529, retryable 5xx; assistant-stream `rate_limit` / `server_error`; nested `rate_limit_error` / `overloaded_error`. (If a business-deterministic 409 exists, exclude it by `error.type`.)
  - **Deterministic** (unchanged): 400, 401, 403, 404, 413, invalid-model/request. Keep 401/403 deterministic.
  - **Blocked** (billing / credit exhausted): retain the work but do NOT respawn every turn-stop — hold an IN-MEMORY blocked flag with a long floor; a fresh capture clears it. On a worker restart the flag is lost and the account is re-attempted ONCE — accepted (bounded by restart frequency, not a spin loop).
- **Signal traversal:** match `error.status`, `error.type`, `error.error.type`, body, and headers — not only `.cause`. Retry metadata priority: the stream's normalized `retryInMs` → `Retry-After` (seconds or HTTP-date) → default backoff. The suspension floor stays in memory (restart re-attempts — accepted).
- **Dream error propagation:** `createDiarySdkQuery` today discards non-`result` messages and throws a string `Error`, so a dream 429/billing is mis-seen as deterministic. It must collect the highest-priority stream error and throw a typed wrapper preserving `status`/`type`/retry metadata, which `diary-runtime` then classifies. (Dream retry stays date-keyed in `diary_day_state` as today — no per-session retry schema.)

### Tier-alias models

- Extraction requests `sonnet`; dream requests `opus`. The config allowlist gains `opus`/`sonnet`/`haiku`; literal IDs stay valid (opt-in pinning); alias is the default.
- **Context-window handling is inherited — no work.** The agent runs as a CC subprocess with its own auto-compaction enabled (mnemo already re-primes on the unsolicited `compact_boundary`); that subprocess owns window identification (`[1m]` / known-model table / 200k default) plus the reactive `model_context_window_exceeded` backstop. mnemo's flat-100K worker `/compact` fires first for any realistic window. Aliases add no compaction risk.

### Dream agent env — triggering session's snapshot (best-effort)

- The dream uses the env of the session whose turn-stop triggered the global diary drain (ticket 01 machinery). Availability beats determinism: that session just produced a turn, so its account works.
- **Best-effort snapshot, in memory.** When the drain decides to run the dream, snapshot the triggering session's currently-registered env. If it is unavailable (session ended, env cleared), fall back to the sanitized operational baseline (which, having no auth, means the dream cannot run — surfaced, not silently wrong). No structured completion-record persistence, no dedicated-override tier (see Out of Scope).

## Testing Decisions

- **Seam 1 — agent-env construction (pure function).** Given a worker env + a captured subset, assert: operational allowlist keys survive; `GITHUB_TOKEN`/`AWS_*`/worker auth do NOT reach the agent; the captured subset applies (8 proxy variants case-exact, `DEFAULT_*_MODEL`, `BASE_URL`, `CUSTOM_HEADERS`, `NODE_EXTRA_CA_CERTS`, auth); `ANTHROPIC_MODEL`/effort excluded even when the source set them; dual-auth carried verbatim; API-key-only source keeps its key.
- **Seam 2 — registry + presence-gate + spawn wiring.** At the worker-core / `main()` seam (injected spawn/query, injectable clock): A spawns with A's env, B with B's; a row whose session has NO registered env is left un-extracted until the env registers (presence gate); a session-stop clears the entry; the dream spawn uses the triggering session's snapshot.
- **Seam 3 — hook payload + loopback.** The capture POST carries the curated subset + session identity and only that; SessionStart still returns injected context; the worker binds `127.0.0.1`.
- **Seam 4 — classification + error handling (from the SDK stream).** Table-drive real shapes (408/409/429/529/retryable-5xx, `assistant.error` union incl. `billing_error`, nested `.error.type`) → transient/deterministic/blocked; 401/403 stay deterministic; the dream stream yields a typed error, not a string; `retryInMs` beats `Retry-After` beats default; `billing_error` holds an in-memory blocked flag without per-turn respawn.
- **Seam 5 — secret sanitizer.** Inject a token + proxy password into an error body; assert neither the logger sink nor SQLite contains the value; a stable `type`/`status`/`request-id` is persisted instead.
- Good tests assert external behaviour, never timer/internal wiring.

## Out of Scope

- **Any on-disk persistence of env or per-session retry state**, monotonic `env_generation`/`env_revision`, worker-incarnation restart recovery — deliberately excluded by the accepted-degradation decision.
- **Per-env worker processes** (the round-3 rearchitecture) — not needed once we accept in-memory + degradation.
- Cross-provider data-boundary / consent policy for the dream.
- A dedicated dream-env override (needs a secret-source schema).
- Encrypting the loopback hook→worker hop.
- Any change to which sessions trigger extraction, or to the 0.6.3 grading rubric.
- A mnemo-chosen fixed reasoning effort.

## Ticket Breakdown

- **T1 — Quota/transient classification + dream error propagation + secret sanitizer.** The transient/deterministic/blocked matrix (408/409/429/529/retryable-5xx, `.error.type`/body/header traversal); in-memory blocked flag; retry metadata with `retryInMs` priority (in-memory floor); `diary-sdk-query` typed-error propagation; the shared value-level secret sanitizer for logs + persisted error. **Blocked by:** none.
- **T2 — Per-session in-memory env + loopback bind.** The built agent env (operational allowlist + captured subset + overrides, NOT worker full env); in-memory registry keyed by session with SessionStart/refresh/clear-on-stop; the capture POST (session identity, non-suppressing SessionStart, offline-path handover); presence-gated extraction; query recycle on env change; bind `127.0.0.1`. **Blocked by:** none (independent of T1).
- **T3 — Dream uses triggering-session snapshot.** Best-effort in-memory snapshot of the triggering session's env at dream-drain time; baseline fallback. **Blocked by:** T2 (registry) — rides on dream-turn-gated ticket 01's trigger.
- **T4 — Tier aliases (extraction + dream).** `opus`/`sonnet`/`haiku` in the allowlist, alias by default. **Blocked by:** T2 AND T3 (else dream resolves `opus` through the frozen worker env). No context-window work.

Cross-ticket integration coverage: A-env → 429 suspension → retry still uses A on the next turn-stop; simultaneous A/B sessions each extract on their own env; a session with no env leaves work queued; a crash + live session re-announces; secrets never reach SQLite or logs.

## Further Notes

- **Why coupled:** aliases resolve from env; without per-session env, `opus`/`sonnet` resolve per the one frozen session — half-broken. Ship together.
- **Prototype facts (verified this session):** claudex uses `ANTHROPIC_AUTH_TOKEN`; `opus`→`gpt-5.6-sol` resolves from a bare alias + the DEFAULT-OPUS var with NO `CUSTOM_MODEL_OPTION`; claudex→CPA is proxy-only (direct 000 / proxy 200); anon uses `ANTHROPIC_API_KEY` + `BASE_URL=172.17.0.1:8317` over the docker bridge.
- **Design stance:** Codex's round-2/3 mechanisms were correct FOR a multi-tenant durable service; this is single-user localhost in-memory, so the accepted-degradation YAGNI is the right call, not those mechanisms. One mechanism (in-memory registry + presence gate + re-announce), not a quilt.
- **Standing constraints:** never run git; no version bump; do not rebuild `plugin/scripts/*.cjs`; do not touch live `~/.claude-mnemo` data.
