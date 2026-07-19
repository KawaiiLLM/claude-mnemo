# 02 — Bounded stall escalation (resume → fresh → skip)

**What to build:** A repeatedly-stalling extraction turn stops looping forever and burning cache. Today a stall abort is classified as a connection error and routed onto the unbounded "retry on every turn-stop, resume the same session" path, so a session that always stalls re-resumes and cold-recreates its whole transcript prefix indefinitely (the root cause of the 2026-07-19 cost spike). Give genuine extraction stalls a bounded, durable escalation: 1st stall → suspend and retry by resume; 2nd stall → suspend and retry with a brand-new session (no resume); 3rd stall → mark the turn extraction-failed and skip it. Real network/quota failures keep their existing unbounded retry — they are not stalls.

**Blocked by:** 01 (the escalation must trigger on true stalls, not the old false positives; both touch the same watchdog / flush-catch region).

**Status:** ready-for-agent

- [ ] Extraction stalls use their OWN abort reason/class — the diary agent also uses `stall-watchdog`, so do NOT globally reclassify it; only the extraction flush path escalates, and the classifier's connection/deterministic/blocked semantics for everything else are unchanged.
- [ ] A durable per-turn stall counter is added (schema change: a new column on `turns` or `pending_queue`) that survives suspension, batch rebuild, and worker restart — the in-memory `BatchEntry.attempts` cannot be reused (it resets to 0 on suspension and counts deterministic delivery failures, a different concern).
- [ ] Escalation state machine (from spec prototype): `stallAttempts += 1`; 1 → suspend(nextMode=resume); 2 → suspend(nextMode=forceFresh); ≥3 → mark turn failed + skip. The stall counter is independent of the deterministic-delivery `attempts`; two delivery errors plus one stall must NOT terminalize a turn.
- [ ] `forceFresh` is reachable from the suspend→resume path: the suspension record carries a stable next-retry mode (resume vs forceFresh) and the work identity, consulted before the first send after resume. On mode=forceFresh the resumed flush cold-starts a new session instead of resuming `lastAgentSessionId`.
- [ ] Backoff applies between stall retries and is gated on BOTH a new turn-stop AND elapsed backoff (a new turn-stop must not bypass the backoff for a re-stalling flush).
- [ ] Merged batches (one flush covering several turns) attribute the stall to the correct turn(s); the counter's ownership is well-defined for that case.
- [ ] A turn that stalls three times is marked failed and skipped (queue unblocked), never looped a fourth time.
- [ ] Real connection-class and blocked-class errors retain their current behavior (unbounded retry / billing gate); only extraction stalls take the bounded path.
- [ ] The diary agent's stall/retry behavior is verified unchanged after the classifier split.
- [ ] Tests cover: durable counter surviving a simulated suspension and a simulated worker restart; resume-vs-fresh construction asserted on the fake query session at attempts 1/2; skip at attempt 3; no collision with deterministic delivery attempts; merged-batch ownership.
- [ ] `bun test`, `tsc`, `bun run build` green. Read-only git. No version bump, no `.cjs` hand-edit, no touching live `~/.claude-mnemo` data. Any schema migration must be forward-safe against an existing DB.
