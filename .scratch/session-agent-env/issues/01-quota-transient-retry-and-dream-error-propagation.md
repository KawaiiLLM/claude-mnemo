# 01 — Quota/transient classification + dream error propagation + secret sanitizer

**What to build:** A memory agent whose turns are NOT silently dropped when its account hits a quota, rate limit, or transient server failure — instead the turn is suspended and retried on the next turn-stop, exactly like a network error today. A hard-blocked (billing/credit-exhausted) account retains its work but stops respawning every turn-stop. The dream agent's rate-limit/billing/server errors reach the classifier intact instead of being flattened into a generic string error. And any credential a remote gateway echoes back inside an error body never lands in the logs or SQLite.

See `../spec.md` → "Quota / usage-limit failures reuse the connection path", "Dream error propagation", "Secrets — an error-string sanitizer" for the full rationale.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] A streamed/thrown `429`, `529`, `408`, `409`, retryable `5xx`, `assistant.error === "rate_limit"`/`"server_error"`, or nested `rate_limit_error`/`overloaded_error` classifies as **transient** and routes through the existing 0.6.2 suspend + event-driven-retry chain (retried on the next turn-stop), not finalized `terminal failed`.
- [ ] `400`, `401`, `403`, `404`, `413`, invalid-model/invalid-request stay **deterministic** (401/403 must NOT become transient — no permanent retry loop on a bad credential). A business-deterministic `409`, if it exists, is excluded by `error.type`.
- [ ] A `billing_error` / credit-exhausted account classifies as **blocked**: the work is retained (not dropped) but held behind an in-memory blocked flag with a long floor so it does NOT respawn on every turn-stop; a fresh env capture clears the flag. After a worker restart the flag is lost and the account is re-attempted at most once (accepted).
- [ ] Classification traverses `error.status`, `error.type`, `error.error.type`, response body, and headers — not only `.cause`.
- [ ] Retry backoff uses the stream's normalized `retryInMs` when present, else a parsed `Retry-After` (integer seconds OR HTTP-date, clamped), else the default connection backoff. The suspension floor remains in memory (a restart re-attempts — accepted).
- [ ] The dream SDK query stops discarding non-`result` messages on failure: it collects the highest-priority stream error and throws a **typed** error preserving `status`, `type`, and retry metadata, which the dream runtime then classifies (so a dream `429`/`billing_error` is no longer mis-seen as deterministic). Dream retry stays date-keyed in `diary_day_state` as today — no per-session retry schema is added.
- [ ] A single shared sanitizer guards both the logger and any persisted error string: it value-replaces the sensitive values in the current env snapshot and structurally strips URL userinfo / `authorization` / `cookie` / custom-header values, persisting a stable `type`/`status`/`request-id` instead of the full remote body.
- [ ] Tests drive from the SDK message stream (not hand-built error objects): table-driven real error shapes → transient/deterministic/blocked; a token + proxy password injected into an error body appears in neither the logger sink nor SQLite; `retryInMs` beats `Retry-After` beats default; `billing_error` does not respawn per turn-stop.
- [ ] `bunx tsc --noEmit` passes; `bun test` does not regress vs baseline (the single stale-bundle-guard failure is the expected baseline).

## Constraints

- Do NOT run any git command; only edit files.
- Do NOT bump the version or rebuild `plugin/scripts/*.cjs`.
- Do NOT touch live data under `~/.claude-mnemo`.
