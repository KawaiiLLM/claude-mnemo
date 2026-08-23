# 01 — Thinking budget becomes a config knob for the settlement and dream agents

**Ruling (S15069/T1433-T1435):** add the missing thinking-strength
configuration; model choice is already configurable, thinking is not.

**What to build:** two config keys in `~/.claude-mnemo/config.json`,
mirroring the existing per-agent model keys:

- `noteSettlementMaxThinkingTokens` — thinking budget for the settlement
  agent's SDK query.
- `dreamAgentMaxThinkingTokens` — same for the nightly dream agent.

Semantics:
- Value: positive integer = passed through as the SDK query's
  `maxThinkingTokens` option; absent or `null` = option omitted entirely,
  model default applies (exactly today's behavior — the default MUST be
  null so an unconfigured install changes nothing).
- Invalid values (non-integer, zero, negative, non-numeric strings) warn
  with the field name and fall back to null — same resolver style as
  `resolveAgentModel`, one shared resolver for both keys so they cannot
  drift.
- Config is read at worker spawn like every other key; no reload semantics
  beyond the worker's own short life.

**Blocked by:** None — can start immediately.

**Status:** done (mutation-verified: resolver boundary >0→>=0 → 2 red; unconditional spread both sites → 4 red absence pins)

- [ ] Config parse pins: valid integer lands; absent/null yields null;
      invalid warns naming the exact key and falls back to null — both keys
- [ ] Passthrough pins in both SDK query tests: when configured, the query
      options carry `maxThinkingTokens` with the configured value; when
      null, the options object carries NO such key (absence asserted, not
      undefined-valued presence)
- [ ] Verify the SDK option name against the installed
      `@anthropic-ai/claude-agent-sdk` before wiring — if the SDK spells it
      differently, follow the SDK and note the spelling in the config
      field's doc comment
- [ ] Typecheck + targeted suites green; control-byte scan on touched files
