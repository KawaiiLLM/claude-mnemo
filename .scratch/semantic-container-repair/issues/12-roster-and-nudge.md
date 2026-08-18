# 12 — 花名册补 type，维护提醒改挂到时钟

**What to build:** 花名册每行补上 type 频次；20 轮维护提醒从写操作的回执改挂到会话侧。

**偏差一：花名册砍掉了挂靠判据的一半。**
- 用户裁决 T819：「段的 type/tags 字段应该是自动聚合所属 turn 的 type/tags，按频次排序，**注入时给出所有段的 title 和 type/tags**，方便挂靠」。
- `src/hooks/session-composition.ts:205-217` 计算了 `facets`（含 type 与 tags 两半），只渲染 `facets.tags.slice(0, 3)`，`facets.type` 算完丢弃。段卡片渲染了 type（`segment-card.ts:347-353`），唯独真正用于挂靠决策的花名册没有。
- 同处 `:151` 把花名册截到 40 个段，而裁决说的是「所有段」。

**偏差二：提醒的触发器装反了。**
- 用户裁决 T825：「提醒距离上次的 turn 数，如果不足 10 就更新／**每 20 轮还没更新，提醒一次**，但不强制」。前半是写时收据，后半是时钟。
- `src/mcp/remember.ts:200-212` 把两者都做成 `remember` 写操作的**返回值**；`src/mcp/definitions.ts:82` 明写「20+ turns without a touch draws a nudge **on the next write**」。全仓无第二条 nudge 通道。
- 净效果：只有正在维护段的人会被提醒去维护段；一个 20 轮没碰过段的会话，恰恰永远收不到这条提醒。
- 现成的挂载点：段块 header 已经算出了 `maintenance N turns ago`（`segment-card.ts`）。

**Blocked by:** None

**Status:** done (2026-08-18; roster half by worker, nudge half by main agent)

- [x] 花名册每行渲染 type 频次与 tags 频次
- [x] tags 上限按预算裁剪，不再是固定 3 个
- [x] 20 轮提醒出现在会话侧（段块 header 或 note 收据），不依赖用户先写 remember
- [x] 「不足 10 轮」的过度维护提示仍留在写回执上，两者分开

**实现记录（花名册半，2026-08-18）：** `src/hooks/session-composition.ts` 的 `renderSegmentRoster`。`type`
用 `computeSegmentMemberFacetCounts` 已算好的 `facets.type`（此前算完即弃），渲染方式复用
`segment-card.ts` 的 glyph+word+count 惯例，不加预算上限（闭合词表，天然有界，见 `MEMORY_TYPES`）。`tags`
从 `facets.tags.slice(0, 3)` 改为新写的 `budgetedFacetText`（token 预算贪心取，首项必进，其余按
`ROSTER_TAG_FACET_BUDGET_TOKENS = 20` 停止取用），复用 `mcp/format.ts` 的 `truncateLines`「首项必留、
其余按预算」惯例而非另造规则。`ROSTER_TITLE_TRUNCATE`（标题字符截断）与 `:151` 一带的花名册段数上限 40
均未动——不在票 12 或票 08 的字面范围内，属另一渲染面/另一裁决（T819 的「所有段」与现有 40 段截断的张力
留给用户裁决，未擅自改，见报告）。20 轮维护提醒（`mcp/remember.ts`/`mcp/definitions.ts`）按指示完全未碰。
测试：`tests/hooks/session-composition.test.ts`（新增 describe 块
`renderSegmentRoster: type/tag facets (ticket 12)`）。

**实现记录（提醒半，2026-08-18）：** 20 轮提醒挂到段卡片 header（`segment-card.ts` 的
`maintenance N turns ago` 行，≥20 追加 `— consider a maintenance pass`）——该 header 在
SessionStart 段块与 recall 里渲染，零 `remember` 调用也能看见；`remember` 回执的 ≥20 分支删除，
「不足 10 轮」过度维护提示原地保留。`MAINTENANCE_CADENCE` 迁至 `src/shared/segment-cadence.ts`
（remember 已 import segment-card，反向引用会成环）。顺带修票 14 #10：`maintenanceTurnsAgo`
从跨会话求和改为取最大值，使数字与 10/20 阈值同单位可比。工具描述（`definitions.ts`）改述提醒
所在地，且守住 380 token 预算。
