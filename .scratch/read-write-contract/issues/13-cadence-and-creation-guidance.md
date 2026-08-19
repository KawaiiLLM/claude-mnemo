# 13 — 节奏统一与建段指导

**What to build:** 所有会话每 20 turn 收到一次 remember 检查提醒(不分有无挂靠);建段判断原则入 rubric;remember 工具描述补时机。

规范:spec「节奏与建段指导」节([S15069/T978] 裁决)。

- **统一提醒**:UserPromptSubmit 通道渲染一行 remember 检查提醒,计数=自上次 remember 调用起 20 turn;note 积压 >5 的 backlog-relief 行为保持(阈值核对为 5,不符则调)。段卡片头的 `MAINTENANCE_CADENCE` nudge 后缀退役(职能并入统一提醒;`segment-cadence.ts` 常量随消费者处置)。
- **rubric v2→v3**,增「建段」节(正式文本,verbatim 入 `MEMORY_RUBRIC_TEXT`):
  - 琐碎、短时闲聊等组不成可命名工作流的 turn 无须建段;无归属是合法状态
  - 需要建段时,先查 roster 有无合适的已有段——挂靠优先于新建
  - 无合适段才新建;以任务实际形状命名,开场臆测的名字会锚定错误
  哈希守卫/双渲染自动跟随,单一家园 grep 守卫保持绿。
- **remember 描述**补时机行(20 轮提醒到达时检查归属/Working State/是否建段挂靠),判断原则指向 rubric,不复述。

**Blocked by:** 11(definitions.ts 领地)。

**Status:** done

- [x] 零挂靠会话第 20 turn 收到 remember 提醒(构造性测试);挂靠会话同样
- [x] 卡片头 nudge 无功能性残留(grep)
- [x] rubric v3 双渲染字节同一、grep 守卫绿;建段三条 verbatim
- [x] remember 描述含时机行且不复述判断

## Implementation record

**Mechanism.** "自上次 remember 调用起" needed a session-scoped fact no
existing table carried — `create`/`close`/`assign` never even attribute a
caller session on their own write paths, so there was nothing to derive it
from. Added one nullable column, `sessions.last_remember_epoch` (schema.ts,
CREATE TABLE + `ensureSessionLastRememberEpochColumn` migration; excluded from
`upsertSession`'s UPDATE SET list so a routine upsert can never clobber it,
same treatment `parent_session_id`/`lineage_status` already get), plus a
dedicated setter `touchSessionRememberActivity` (db/sessions.ts).
`mcp/remember.ts`'s `rememberTool` entry point stamps it after ANY successful
verb (not a `Parameter error:` rejection). `hooks/handlers/session-init.ts`
reads it back (falling back to `session.createdAtEpoch - 1` when never
called — the `-1` matters: `createdAtEpoch` is set from the SAME `now()` call
as the session's own first turn, so without it the fallback would put turn 1
on the wrong side of `countTurnsSince`'s strict `>` and undercount every
never-called session by one turn) and renders `hooks/note-reminder.ts`'s new
`renderRememberReminder` on the UserPromptSubmit channel, gated by
`isRememberReminderDue` — periodic (fires at 20, 40, 60, ... turns since the
marker), not sticky-until-resolved like the note backlog relief.

**Card nudge.** `MAINTENANCE_CADENCE.nudgeAtOrAbove` retired from
`mcp/segment-card.ts`'s header; the bare "maintenance N turns ago" fact
stays. `segment-cadence.ts` now exports one scalar, `TOO_SOON_UNDER_TURNS`
(renamed from `MAINTENANCE_CADENCE.tooSoonUnder`) — its one remaining
consumer, `remember.ts`'s too-soon receipt, updated to match.

**Rubric.** v2→v3: appended `## 建段` with the ticket's three lines verbatim,
after `## 归属`. `remember`'s tool description carries the one timing line
("20-turn reminder: check membership, Working State, whether to create or
attach — judgment lives in the Memory Rubric, not here"), trimmed hard to
land at 399/400 estimated tokens (the pre-existing cap).

**Note backlog threshold.** Verified, not adjusted: `NOTE_RELIEF_PENDING_THRESHOLD`
= 5 already (note-reminder.ts:32); gate is `owed.length >= NOTE_RELIEF_PENDING_THRESHOLD`
(session-init.ts). Matches the ticket's "阈值核对为 5" — no change needed.

## Judgment calls

1. **New schema column, not pure derivation.** The territory note allowed
   touching db/ "beyond what a reminder counter genuinely needs" — judged
   that deriving "any verb" from existing tables (write_gate_stamps only
   covers append/replace; create/close/assign carry no caller-session
   attribution anywhere) was structurally impossible, not just inconvenient,
   so a new column was the genuinely-needed minimum.
2. **Periodic (mod 20), not sticky-until-resolved.** Read "每 20 turn 一次"
   as "once per 20-turn window" (fires at 20/40/60/…) rather than the note
   backlog relief's "re-renders every prompt until resolved" — a lighter
   touch for a periodic check versus a standing, actionable debt. Flagged as
   the one place this ticket's wording was open to either reading.
3. **A `Parameter error:` call does not reset the clock.** Detected success
   via the existing `Parameter error:` text-prefix convention every handler
   already shares (no new discriminated-result type introduced).
4. **Reminder line wording is terse and self-contained** ("see the remember
   tool description for what to check") rather than echoing the rubric's
   three concerns inline, keeping the single-home discipline symmetric with
   `remember`'s own description.
