# 02 — Settlement thresholds move into config; out-of-range enqueues are refused

**What to build:** the operator tunes settlement without touching code: the
settlement subagent's model, the automatic window range [threshold, cap], and
the manual backfill cap all live in `~/.claude-mnemo/config.json`. A window
outside the configured range is REFUSED at enqueue with a named reason — never
silently clamped.

**User ruling ([S15069/T1017]):** 这一类阈值整理成 config,方便调整;超出范围的
直接拒绝入队. Lookback (前序) is deliberately NOT a knob in this ticket — its
decoupling from window size is still pending the anchoring-eval verdict.

**Blocked by:** 01 (landed, d397746).

**Status:** ready-for-agent

## Pinned decisions

1. New `MnemoConfig` fields, defaults preserving current behavior exactly:
   - `noteSettlementModel` — default `"claude-sonnet-5"`; validated against the
     existing `KNOWN_DREAM_AGENT_MODELS` vocabulary (no rename; generalize
     `resolveDreamAgentModel` into a shared `resolveAgentModel(fieldName,
     value, fallback, logger)` used by both model fields).
   - `noteSettlementThresholdTurns` — default 25, clamp [1, 500].
   - `noteSettlementCapTurns` — default 50, clamp [1, 500]; coherence pass
     AFTER clamping: cap < threshold → warn + raise cap to threshold.
   - `noteSettlementBackfillMaxTurns` — default 100, clamp [1, 10000].
2. One home per number: `DEFAULT_NOTE_SETTLEMENT_{THRESHOLD_TURNS,CAP_TURNS,BACKFILL_MAX_TURNS,MODEL}`
   in `shared/config.ts`; the existing exports
   (`NOTE_SETTLEMENT_WINDOW_THRESHOLD_TURNS`/`NOTE_SETTLEMENT_WINDOW_CAP_TURNS`/
   `NOTE_SETTLEMENT_BACKFILL_MAX_TURNS` in db/note-settlement.ts,
   `NOTE_SETTLEMENT_MODEL` in worker/note-settlement-dispatch.ts) become
   re-exports of those defaults so every current import path stays valid —
   zero churn in unrelated files. Verify import direction db→shared introduces
   no cycle (shared/config imports only segment-era today).
3. Consumption wiring (deps override always wins over config — tests rely on it):
   - Scheduler (`worker/note-settlement.ts` `windowOptions`):
     `deps.thresholdTurns ?? config.noteSettlementThresholdTurns`, same for cap.
   - `settleBackfillWindow` (server.ts core): pass
     `{ allowPreEra, maxTurns: config.noteSettlementBackfillMaxTurns }` through
     `enqueueBackfillNoteSettlementJob` → `insertJob`, whose backfill_too_large
     check reads `options.maxTurns ?? NOTE_SETTLEMENT_BACKFILL_MAX_TURNS`.
   - Dispatch model: wire `config.noteSettlementModel` at the assembly site
     (server.ts ~1791 `createNoteSettlementDispatch`) — config flows as an
     object, never `loadConfig()` from inside the dispatch module.
   - `MANUAL_SETTLE_REFUSAL_MESSAGE.backfill_too_large` no longer interpolates
     the constant (it can lie once configured): name the config key instead —
     "window spans more than the configured backfill cap
     (noteSettlementBackfillMaxTurns); narrow the range and re-run".
4. Reject, never clamp, on the request path: an over-cap `/settle` window is
   refused (existing reject-over-100 judgment, now config-driven). The residual
   scan's `minWindowTurns` is OUT of scope — untouched.

## Acceptance criteria

- [ ] Config `{"noteSettlementThresholdTurns":5}` makes the consecutive
      trigger fire at 6 decided turns with windowEnd 5 (scheduler test, config
      only, no deps override) — and a deps override still beats config.
- [ ] Config `{"noteSettlementBackfillMaxTurns":10}` → `/settle` window of 11
      refused `backfill_too_large`, 10 accepted (endpoint test).
- [ ] Config `{"noteSettlementModel":"claude-haiku-4-5"}` reaches the dispatch
      request's `model` (test at whatever seam the assembly exposes; factory
      unit acceptable).
- [ ] Config junk values (strings, negatives, cap<threshold, unknown model)
      normalize to defaults/coherence with a warn, per existing clampConfig
      idiom (shared config test file).
- [ ] Full `bun test` green except the pre-existing stale-bundle guard red
      (source ahead of bundles — expected until release rebuild, not yours).
- [ ] `bun run typecheck` green.

## Ground rules for the executing agent

- NO git write commands of any kind (commit/stash/checkout/restore included).
  Report the changed-file list; the main session commits. If a transient red
  appears outside your territory: re-run that one file narrowly and re-read
  your own diff — never revert or clean the tree.
- Never touch `~/.claude-mnemo/` (production data/config) or `plugin/scripts/`
  bundles; never run `scripts/build.js`; no version bumps.
- Follow the file's existing comment density and idiom; config field docs in
  the style of the dream-agent fields.
