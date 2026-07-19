# 01 — Real-activity stall watchdog

**What to build:** The extraction stall-watchdog stops killing flushes that are slow but making progress, and reliably reclaims flushes that have genuinely gone silent. Today the watchdog reads a timestamp frozen at send-start (`lastPushAt`), so it fires on time-to-first-recognized-progress and false-positives on any flush that takes >30s to emit its first substantive output. Replace that with a sliding "last agent activity" window: the watchdog aborts only after the extraction agent has produced NO streamed output for the configured threshold.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] A dedicated "last agent activity" timestamp advances on every streamed unit from the extraction agent: partial and whole assistant text, `mcp__mnemo__remember` and `recall` tool use, tool results, and thinking / tool-progress events.
- [ ] `api_error` (and other error-only) events do NOT advance the activity timestamp — a watchdog fed by error events must still be able to fire (this was the 2026-07-18 failure mode).
- [ ] Partial-assistant-message stream events are enabled and parsed at the SDK query boundary (`query-session.ts`), so a single long text generation registers activity before the whole message assembles.
- [ ] The stall predicate becomes "an in-flight extraction request exists AND now − lastActivity > stallThresholdMs"; the frozen send-start timestamp is no longer used for stall detection (it may remain for keepalive/cache-TTL use).
- [ ] `stallThresholdMs` is configurable (default 60s). With the ~10s watchdog sweep cadence, effective detection lands in the 60–70s band; tests assert the band, not an exact 60s.
- [ ] A flush that keeps emitting output every <threshold seconds past the old 30s limit is NOT aborted.
- [ ] A flush silent for > threshold after having emitted some output IS aborted (proves the window is sliding, not a to-first-progress gate).
- [ ] The diary agent's own watchdog behavior is unchanged by this ticket.
- [ ] Existing watchdog tests still pass; new tests drive the fake query session with partial-stream and api_error events via the injected clock (prior art: the `abortStalledSessions` direct-clock tests).
- [ ] `bun test`, `tsc`, and `bun run build` are green. Read-only git (no add/commit/checkout/stash/reset). Do NOT bump version, do NOT rebuild `plugin/scripts/*.cjs` beyond what `bun run build` produces for verification, do NOT touch live data under `~/.claude-mnemo`.
