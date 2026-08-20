# 09 — 只剩一条维护提醒,口径收紧成「段字段更新」

**What to build:** 全项目只剩**一条**段维护提醒:会话连续 20 个 turn 没有更新
过任何段的任何**字段**时,在 UserPromptSubmit 通道上提醒一次。票 02 刚加进
`remember` 回执的那条 20-turn 提醒撤掉,回执退回只陈述 turn 计数这一事实。

**Ruling base:** [S15069/T1062]——用户在三个选项里选了「把会话侧那条的口径也收
紧成段字段更新,然后只留一条」。追认票 13 的判断:提醒要送达每个会话,回执只送
达正在写那个段的人,而那正是不需要被提醒的人。

**Blocked by:** 02(已完成并验收)。

**Status:** ready-for-agent

## Pinned decisions

- **撤掉票 02 在 `formatMaintenanceCadence` 里加的 `>= 20` 分支**,回执退回只报
  turn 计数、不带任何后缀。
- `src/shared/segment-cadence.ts` 的 `MAINTENANCE_NUDGE_AT_OR_ABOVE_TURNS` 撤掉
  后**该模块再无消费者**(已核实:全仓仅 `src/mcp/remember.ts:57` 一处 import)
  → 整个模块删除。存活的阈值是 `hooks/note-reminder.ts` 的
  `REMEMBER_REMINDER_INTERVAL_TURNS = 20`,一个 20,一个家。
- **时钟的拨回条件收紧。** `src/mcp/remember.ts` 现在对**六个动词中任何一个**成
  功后都调 `touchSessionRememberActivity`(约 923 行)。改为只有**写了段字段**
  的调用才拨回。
- **哪些动词算「写了段字段」——本票的裁决,照做不要重判:**
  - 算:字段写入动词(当前是 `append`/`replace`;票 05 之后是 `write`/`edit`)
    ,以及 `create`——它落下 title 与 seed 的 goal,确实写了字段。
  - 不算:`attach`、`close`、`assign`。它们分别是挂靠、生命周期与归属操作,一
    个段字段都没动,而用户的原话是「从来没更新过段的任何字段」。
  - `create` 若不拨回,新建者会在建段后很快被提醒,那是噪音;若拨回,建了段却
    从不维护的人仍会在 20 turn 后被提醒——这正是票 13 要的效果。
- 参数错误的调用仍然不拨回时钟(现行行为,别改)。
- 随改动订正两处已过时的文档注释:`SessionRecord.lastRememberTurnId` 的
  「(any verb…)」,与 `touchSessionRememberActivity` 的
  「once per successful verb (any of the six, not just the field-writing
  ones)」。它们现在会说反话。

## Acceptance criteria

- [ ] `remember` 回执不再带任何维护提醒后缀,只陈述 turn 计数。
- [ ] `attach` / `close` / `assign` 成功后**不**拨回时钟:先写一次字段,再连做
      这三个动词,时钟仍以那次字段写入为准。
- [ ] `create` 与字段写入动词成功后**拨回**时钟。
- [ ] 会话连续 20 个 turn 无段字段更新后,UserPromptSubmit 通道出现提醒;不足
      20 turn 时不出现。
- [ ] `src/shared/segment-cadence.ts` 已删除且无残留 import。
- [ ] 两处文档注释与新行为一致。
- [ ] typecheck 干净;全套绿,只余既定的陈旧包守卫红。

## Ground rules

- NO git write commands。报出改动文件清单,主会话提交。
- 不碰 `~/.claude-mnemo/`、`plugin/scripts/`、版本号、`src/worker/`。
- 不要自行重建 bundle。
- 自己文件之外的瞬时红:窄范围重跑,绝不回滚工作树。
