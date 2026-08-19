# 04 — 触发与窗口重定标

**What to build:** 结算窗口变为 [25,50];compact/sessionend 不再触发;前序注入与窗口等量且 prompt 统一渲染;backfill 无前序、上限 100。

规范:spec「触发与窗口」([S15069/T963] 裁决)。

- 门槛 25 个连续已定型 turn;单次窗口上限 50(攒 60 → 切 50 留 10)。
- **唯一自动触发=turn-stop 规划**:compact/sessionend 的触发路径降级移除(理由入码注:结算读库不读活上下文);残余搭车通道保持、只挂 turn-stop;era 开关不动。
- 已接受后果(入码注/测试):会话终止时不足 25 的尾巴不结算。
- 前序注入数量=本窗口 turn 数;**prompt 删「Preceding turns (context only)/Window turns (settle exactly these)」两节结构,统一渲染统一语义**——窗口边界只是作业记账。reviewableTurnIds 机制保留(=全部渲染 turn),门落地(05)后被授权吸收。
- backfill(手动 /settle):无前序注入,单次上限 100 turn。
- 领地:规划层+结算 context/prompt;**不碰写 facade/staging**(05 领地)。

**Blocked by:** None — can start immediately.

**Status:** done

- [x] 24 个 turn 不成窗、25 成窗、60 切 50 留 10
- [x] compact/sessionend 事件不再产生作业(既有对应测试改写)
- [x] prompt 无两节之分,前序=窗口等量;25 窗渲 50 个 turn(25+25)
- [x] backfill 无前序、101 个被拒或截到 100(择一,报文说明)

## Implementation record

**Source changes:**

- `src/db/note-settlement.ts` — constants renamed/added: `NOTE_SETTLEMENT_WINDOW_THRESHOLD_TURNS=25` (replaces `NOTE_SETTLEMENT_CONSECUTIVE_TURNS`), `NOTE_SETTLEMENT_WINDOW_CAP_TURNS=50`, `NOTE_SETTLEMENT_BACKFILL_MAX_TURNS=100`; `NOTE_SETTLEMENT_MIN_WINDOW_TURNS=20` kept, narrowed to residual-only use (its compact/sessionend consumers are gone). `planNoteSettlementWindows` loses its `trigger` parameter — it only ever plans `consecutive` now, and `NoteSettlementWindowPlan.triggerType` is pinned to the literal `"consecutive"` (compile-time fact, matching the existing residual/backfill-exclusion idiom). New window-cutting loop: `while (remaining >= threshold) cut min(cap, remaining)` — this is what produces "60 → cut 50, leave 10" directly. `getCompactBoundaryPromptNumber` (dead, fed only the removed compact branch) and `enqueueSessionEndNoteSettlementWindow` (dead, sessionend's synchronous freeze) are deleted outright. `insertJob` gained a `backfill_too_large` guard (new `NoteSettlementInsertRefusal` member), checked alongside `inverted_range` since both are range-shape guards independent of DB state.
- `src/worker/note-settlement.ts` — `NoteSettlementScheduler.onCompact` removed from the interface and implementation; `runTrigger` no longer takes a trigger parameter and its `triggered` gate drops the `trigger === "compact"` unconditional branch (turn-stop is now the sole entry, gated purely on `plans.length > 0`). `leakDueSessions` mechanism itself is unchanged; only its call sites move (see server.ts).
- `src/worker/server.ts` — `runNoteSettlementTrigger` drops its trigger parameter (always turn-stop). `handleCompact` no longer calls the settlement trigger or the leak — compact's other duties (subagent detection, `updateCompactAnchor`, queue drain) are untouched, since `last_compact_turn` still feeds `mcp/timeline.ts`. `finishSession` no longer calls the leak either (ticket's "残余搭车通道保持、只挂 turn-stop" — the leak now rides turn-stop exclusively, not compact or finish/flush). `MANUAL_SETTLE_REFUSAL_STATUS`/`_MESSAGE` gained `backfill_too_large` → 400.
- `src/hooks/handlers/session-end.ts` — the synchronous `enqueueSessionEndNoteSettlementWindow` call and its gating (`eraCutoffEpoch`/`settlementEnabled` deps, `loadSettlementEnabled`) removed outright as dead code.
- `src/worker/note-settlement-context.ts` — `NOTE_SETTLEMENT_PRIOR_TURNS` (fixed 50) constant deleted; `priorTurns` option now defaults to `job.windowEnd - job.windowStart + 1`. `priorTurnsRendering: string` (bare `formatTurnCollapsed` text) replaced by `priorTurns: NoteSettlementWindowTurn[]` — same rich shape as `windowTurns`, built in ONE pass over the combined prior+window turn records so the gap-seconds signal carries continuously across the boundary. `windowTurns` itself is UNCHANGED in meaning (still exactly this job's own window) because `note-settlement-dispatch.ts` and the facades (out of territory) read `context.windowTurns.length` for their own empty-window check and metrics — only additive changes were made there.
- `src/worker/note-settlement-prompt.ts` — the "## Preceding turns (context only)" / "## Window turns (settle exactly these)" two-section split replaced by one "## Turns" section rendering `[...context.priorTurns, ...context.windowTurns]` through the same `renderWindowTurn`. The model resolves "which turns are this window's own" from the job header line's `S<n>/T<start>-T<end>` range, not a body-level split.

**Judgment calls (flagged, not silently decided):**

1. **Backfill cap: reject-over-100, not clamp.** Ticket left this open ("择一,报文说明"). Chose reject: a clamped window would settle less than what the operator's receipt implies, and every other refusal in this module (`inverted_range`, `below_era_floor`, ...) is already reject-style — clamping would be the only silent-truncation case in the set.
2. **`planNoteSettlementWindows`/`planAndEnqueueNoteSettlementWindows` lost their `trigger` parameter entirely** rather than keeping it narrowed to a single legal value. Since only `"consecutive"` can ever be requested post-ticket, a parameter with one legal value was pure ceremony; removing it is a larger diff than strictly required but matches the ticket's "唯一自动触发" framing at the type level.
3. **Generic `insertJob`/`enqueueNoteSettlementWindows` plumbing left untouched** (still accepts any `NoteSettlementTrigger`, including `"compact"`/`"sessionend"` as literal labels) — several tests use these as convenient "some other trigger type" stand-ins to exercise disjointness/UNIQUE-key behavior that has nothing to do with automatic derivation. Left alone since the DB vocabulary itself is schema (out of territory) and still legally holds these values for historical rows.
4. **Prompt unification renders lookback turns through the SAME annotated renderer as window turns** (facts line, notes, insight) rather than only merging the section heading. The ticket's own wording ("统一渲染、统一可纠") reads as full parity, and the alternative (merge headings but keep prior turns plain-text) would leave a second, quieter form of the two-class split alive.
5. **Residual scan's own floor (`NOTE_SETTLEMENT_MIN_WINDOW_TURNS=20`) left untouched**, not retuned to 25. Ticket says residual is unaffected ("残余通道保持"); the floor is a distinct "worth an inference" judgment, not the turn-stop threshold.

**Test suite:** rewrote/replaced compact- and sessionend-trigger tests across `tests/db/note-settlement-backfill.test.ts`, `tests/hooks/session-end.test.ts`, `tests/worker/note-settlement.test.ts`, `tests/worker/note-settlement-prompt.test.ts`, `tests/worker/note-settlement-call.test.ts`, `tests/worker/server.note-settlement-triggers.test.ts`, `tests/worker/server.settle-backfill.test.ts`, `tests/worker/server.stale-build.test.ts`. Several residual-retry tests that used to lean on `onCompact`'s "always triggers even with an empty window" property were rewritten to seed a genuinely fresh window before each subsequent `onTurnStop` call, preserving the same invariants (backoff blocks early retry, shared per-trigger budget) through the one remaining trigger.
