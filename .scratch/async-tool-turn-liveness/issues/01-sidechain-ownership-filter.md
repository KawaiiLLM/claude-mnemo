# 01 — Sidechain ownership filter

**What to build:** Child-agent tool activity stops being written into root-session turns. The Claude Code hook adapter normalizes the payload's `agent_id` into an optional `agentId` field (absent = root-thread event, present = child-agent sidechain event; per Claude Code source, `agent_id` presence — never `agent_type`, which can be set on the main thread by the `--agent` flag — is the discriminator). The PostToolUse handler then enforces two rules: (a) an event carrying `agentId` is a no-op *before* any session or latest-turn lookup — no observation insert, no queue row, no worker wake; (b) a root event (no `agentId`) attaches only to the latest `active` or `provisional` root turn — if the latest turn is terminal (`extracted`/`skipped`/`failed`/`undone`) or no turn exists, the handler performs a non-blocking no-op with a bounded structured diagnostic (session/turn identifiers + reason code, no tool payloads) and never reopens a terminal turn.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [x] Adapter tests: a subagent-shaped payload normalizes with `agentId` set; a root payload leaves `agentId` absent; raw payload remains available unchanged.
- [x] Handler tests: child payload → success result, zero observations, zero queue rows, zero worker-wake async work; root payload → observation recorded exactly as today.
- [x] Handler tests: root payload with latest turn in each terminal status → no-op, turn status unchanged, no observation; root payload with `active` and with `provisional` latest turn → observation attached.
- [x] Ownership depends only on `agentId` presence — no tool-name or timing heuristic anywhere in the decision path; Agent/Bash/SendMessage launches at top level remain recorded.
- [x] Full test suite passes.
