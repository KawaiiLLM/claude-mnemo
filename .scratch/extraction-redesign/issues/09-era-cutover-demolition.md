# 09 — era 转正：主 agent 笔记成为正式记录

**What to build:** 切换的第一阶段（spec D4/D11/D12，裁决 27）。设定 era cutoff epoch；此后创建的 turn，其 title/content/insight 由 note 工具直接写成正式 turn 记录并走新 status 生命周期，提取 subagent 不再为这些 turn 产出笔记。cutoff 之前的 turn 一切照旧——旧管线独占其状态流转，只读不回填，影子期存量不转正。本阶段只动 turn 笔记这一条写路：obs 摘要、per-session summary agent、结算、评分器全部原样留着，回退方式是把 `eraCutoffEpoch` 置回 null。

**Blocked by:** None——07（结算调用）与 08（渲染层）已合入 main。

**Status:** done（未发版；`eraCutoffEpoch` 仍为 null，切换需另行设值）

- [x] era 判定按 turn 的 `created_at_epoch` 与 cutoff 比较，会话可跨代；判定只有一个实现，读写两侧共用
- [x] era 内 turn 的 note 调用写 turns.title/content/insight 并推进 status，写入与影子表留痕在同一事务（影子期存量与对照数据不动）
- [x] era 内 turn 不再进入提取 agent 的 turn 笔记产出路径；era 外 turn 的提取零变化 —— 闸门落在写回口（`handleTurnRemember`）：批次仍带 era turn（obs 摘要与 required-id 契约属票 14/15），但它写的任何东西都不落库
- [x] era 内无笔记的 turn 保持 pending/skipped，不由任何 LLM 兜底（裁决 27）；泄压阀补写照旧生效
- [x] cutoff 之前 turn 的渲染、状态流转、评分回归测试保绿
- [x] `eraCutoffEpoch` 置 null 时全库行为与本票前完全一致（回退测试）
- [x] 全量测试绿（1795 pass / 0 fail，重新 build 后）

**实现注记：**

- status 分两级推进：note 写在本轮进行中 → `provisional`（`extracted` 在多处被读作「本 turn 已结束」，其中 PostToolUse 捕获会因此丢掉本轮剩余的 observation）；turn 结束时提取侧的闸门按「行上有没有记录」结算为 `extracted` / `skipped`。迟到的笔记（泄压阀）直接落 `extracted`。
- 票 15 拆除提取 agent 时必须补一个机械结算器：现在把 era turn 从 `provisional`/`active` 收口到终态的，正是被闸住的那次 `remember(T…)` 调用。
