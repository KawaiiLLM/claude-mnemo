# 04 — 里程碑独立注入 hook 与降级渲染

**What to build:** 第四条 SessionStart hook 输出当前会话的里程碑时间线，在 2000-token 预算内按固定顺序降级，溢出给 `timeline()` 指针；无会话内历史时静默。

**Blocked by:** None — can start immediately.（等级融合前按现行计分渲染，03 完成后自动升级。）

**Status:** implemented

## 设计决定（见 ../spec.md「里程碑层」）

1. hooks.json 新增第四条 SessionStart command（如 `context milestones`），matcher 与其余三条一致（全量 source，按 source 的输出分流由票 05 统一实现；本票先保证 handler 在无 turn 时静默 `{continue: true}`，startup/clear 自然为空）。
2. handler 只读 DB（复用三路拆分中 persona/experience 的纯读 handler 先例：无副作用、无数据目录创建；但本 handler 需要 DB 读取——只读查询，不做任何写事务）。
3. 渲染预算 2000（estimateDiaryTokens），降级按固定顺序逐级尝试直至放下：
   1. 去掉 shape signals 块；
   2. 去掉 ↳ 伤亡行；
   3. prompt 截断 80 → 50；
   4. 均匀减少保留 turn 数（**不**砍最旧的天——砍旧天会把「大局」退化为「近期细节」，与状态层重复）。
4. 溢出处给 `timeline(id="S<n>")` 指针，提示 agent 细节自查。
5. 建议以新模块包装既有 timeline 渲染（传参／后处理），尽量少改 `src/mcp/timeline.ts` 本体，避免与票 03 的计分改动冲突。

## 关键文件

- `plugin/hooks/hooks.json`、`src/hooks/hook-command.ts` — hook 注册与分发（三路拆分先例）
- `src/hooks/handlers/context.ts` — handler
- `src/mcp/session-output.ts`、`src/mcp/timeline.ts` — 现行 timeline 渲染入口（`renderTimeline`、`buildContextTimelineView`）
- `tests/hooks/`、`tests/mcp/` — 先例

## 约束

- 不执行任何 git 命令；只编辑文件。
- 不做版本号变更、不重建 plugin/scripts/*.cjs（stale-bundle 守卫 1 fail 是预期基线）。
- 不触碰 ~/.claude-mnemo 下的任何线上数据。
- `bunx tsc --noEmit` 通过；`bun test` 相对基线（928 pass / 1 fail）不回退。

## Acceptance criteria

- [x] 第四条 hook 注册并可分发；输出为当前会话里程碑时间线
- [x] 超长会话输出 ≤2000 token；降级顺序可测（每级单独触发的构造用例）
- [x] 溢出时含 `timeline()` 指针；无 turn 时静默 `{continue: true}`
- [x] handler 无任何 DB 写；既有测试不回退

## Comments

- 新增独立 `src/hooks/milestone-injection.ts` 包装现有 timeline query/render：以完整里程碑选择为输入，依次尝试完整输出、去 shape signals、去 `↳` 行、prompt cap 80→50、均匀减少保留 turn；均匀减量始终保留最旧日代表，避免退化成近期明细。
- 新增纯读 `SessionStart:milestones` handler。生产命令路径只在 DB 已存在时以 SQLite `readonly: true, create: false` 打开，不初始化 schema、不创建数据目录；无 session、无 turn 或读取失败均静默返回 `{continue: true}`。
- 第四条 `context milestones` 已加入 `hooks.json` 全量 matcher，并在 `hook-command.ts` 中独立分发。溢出输出包含 `timeline(id="S<n>")`，指针计入 2000-token 预算。
- 验证：票 04 专属 hook/渲染/注册测试 15 pass / 0 fail；真实 120-turn 长会话断言 ≤2000 token、保留最旧 T1、含 timeline 指针且 `total_changes()` 不变；`bunx tsc --noEmit` 通过。
- 与票 02 的泳道边界：未修改 `src/mcp/session-output.ts` 字段渲染，也未修改其中现存 timeline 嵌入；该旧嵌入需由票 02 解耦，否则 resume/compact 在并行分支完全合并前可能暂时重复展示时间线。
- 约束性偏差：按要求未重建 `plugin/scripts/*.cjs`，所以 stale-bundle 守卫继续保留预期 1 fail；`timeline.ts` 本体零修改。整组回归一度见到 9 个票 02/03 并行中间态失败（字段渲染、grade 必填、旧 timeline 嵌入断言），未越界修改，最终全量回归待并行改动收敛后复跑。
- code review 补强：包装层现在不依赖现有 renderer 是否消费 `promptCap`，会对真实 milestone 主行强制执行 80/50 label cap；均匀裁剪后同步重算日组的 `keptCount/promptLo/promptHi`。Standards 与 Spec 复核均确认 finding 已关闭。
- 最终本泳道联合回归为 46 pass / 0 fail。最终全量为 942 pass / 4 fail：预期 stale-bundle 1 fail，另 3 fail 来自并行票 03 的 grade 必填测试夹具；最终 `bunx tsc --noEmit` 的 6 个错误均位于并行票 02 的 `src/mcp/session-output.ts`。这些未越界修复。
