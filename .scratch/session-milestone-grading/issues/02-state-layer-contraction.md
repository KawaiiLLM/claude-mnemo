# 02 — 状态层收缩与渲染态 2000 硬校验

**What to build:** session 摘要收缩为「状态层」：只保留对下一步工作最有用的部分，写入时按注入渲染态硬校验 2000 token，超限失败并让 summary agent 自行重裁；注入渲染不再做标题展开、字段序以状态优先。

**Blocked by:** None — can start immediately.

**Status:** implemented

## 设计决定（见 ../spec.md「状态层」）

1. summary agent 提示词字段语义收缩：content 为一句弧线概述；decision 仅保留仍然生效的决策；done 仅记录近期、对 next 工作可能有用的细粒度完成事项；历史成果与已完结决策授权丢弃——沉淀由里程碑层承担（timeline 计分与摘要解耦，剪枝不产生双删，可在提示词中说明以消除 agent 的保留倾向）。
2. 写入 handler 硬校验：按**注入渲染态**计量（estimateDiaryTokens），>2000 则写入失败，返回各字段 token 明细，agent 据此剪枝重写。机制复用 commitNight 硬上限 + check_budget 的先例。
3. 状态层注入渲染：保留 `[T<n>]` 引用坐标但**不做标题展开**（展开使体积膨胀 2–2.5 倍，标题展开是里程碑层职能）；字段序调整为 content → current → next → decision → done → reference，使兜底截断先砍历史而非状态。
4. 渲染防线：硬校验只约束新写入，存量超限会话续接时注入仍须 ≤2000，渲染端预算兜底保留。
5. 其他消费方（recall 展开、worker prior 上下文）的渲染行为不在本票范围，仅注入路径改变；若共享渲染函数，为注入路径提供变体而非改动共享行为。

## 关键文件

- `src/worker/query-session.ts`、`src/worker/processors.ts` — summary agent 提示词与写入校验（两处指引重复，保持同步）
- `src/mcp/session-output.ts` — Current Session 渲染（`resolveTurnPointers` 标题展开在此路径移除）
- `src/hooks/handlers/context.ts` — 注入装配
- `tests/hooks/context.diary.test.ts`、`tests/worker/` — 先例

## 约束

- 不执行任何 git 命令（不 commit、不 branch、不 stash）；只编辑文件。
- 不做版本号变更、不重建 plugin/scripts/*.cjs（stale-bundle 守卫 1 fail 是预期基线）。
- 不触碰 ~/.claude-mnemo 下的任何线上数据。
- `bunx tsc --noEmit` 通过；`bun test` 相对基线（928 pass / 1 fail）不回退。

## Acceptance criteria

- [x] 渲染态超 2000 的摘要写入失败，错误信息含各字段 token 明细；重裁后写入成功
- [x] 状态层注入渲染无 `[T]` 标题展开，字段序为 content → current → next → decision → done → reference
- [x] 存量超限会话（未经硬校验的旧数据）注入渲染仍 ≤2000
- [x] summary agent 提示词含收缩语义与「剪枝安全」说明
- [x] recall／worker prior 路径行为不变；既有测试不回退

## Comments

- 复核并保留前序线程成果：`query-session.ts` 与 `processors.ts` 的 summary 字段收缩语义已同步；`remember.ts` 已按真实状态注入形态用 `estimateDiaryTokens` 做 2000-token 写前硬校验，失败响应列出 title/content/current/next_steps/decision/done/reference/total，拒绝写入后可重裁重试。
- `session-output.ts` 的状态渲染顺序固定为 content → current → next → decision → done → reference；注入读取原始 session 字段，保留裸 `[T<n>]`，不再使用 context 层已展开的标题坐标。
- 按票 04 的泳道边界拆出 `renderCurrentSessionStateOutput`：SessionStart context 只调用 bounded state 变体，不再查询/渲染 timeline；原 `renderCurrentSessionOutput` 保留给 worker re-prime，继续输出旧的摘要 + timeline，确保 worker prior 行为不变。
- 修复存量兜底优先级：先以未截短的 content/current/next 尝试丢弃 decision/done/reference，只有状态前缀自身也超过 2000 才压缩状态字段；任何兜底均保留唯一 `recall(id="S<n>")` 指针，空标题仍显示 `(untitled session)`。
- 定向验证：`tests/mcp/session-output.test.ts`、`tests/mcp/remember.test.ts`、`tests/hooks/context.test.ts`、`tests/worker/processors.test.ts`、`tests/worker/query-session.test.ts` 共 116 pass / 0 fail；另含 worker server 的 prior 路径回归。全量 `bun test` 为 951 pass / 1 fail，唯一失败是按约束未重建 bundle 的 stale-bundle 守卫；`bunx tsc --noEmit` 通过。
- 偏差：为完成注入/worker 双入口解耦，最小修改了 `src/hooks/handlers/context.ts`（仅切换状态渲染函数调用）与 `src/worker/server.ts`（保持原 worker prior 渲染入口，行为不变）；按约束未重建 `plugin/scripts/*.cjs`。
