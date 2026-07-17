# 05 — 注入矩阵与第三条 hook 内容置换

**What to build:** 四条 SessionStart hook 按 source 分流（startup/clear 注入画像 + 近期会话/日记索引；resume/compact 注入全部四条）；第三条 hook 内容从 experience + 日记索引置换为 Recent Sessions + 日记索引；sessions hook 收缩为纯状态层输出。

**Blocked by:** 02 — 状态层收缩；04 — 里程碑独立注入 hook。

**Status:** implemented

## 设计决定（见 ../spec.md「注入矩阵」）

1. 注入矩阵：

   | source | 状态层 | 里程碑 | 画像 | 近期会话+日记索引 |
   |---|---|---|---|---|
   | startup / clear | – | – | ✓ | ✓ |
   | resume / compact | ✓ | ✓ | ✓ | ✓ |

2. matcher 保持全量（startup|resume|clear|compact），分流在 handler 内按 `input.source` 做——「不注入」不等于「不运行」：sessions hook 的副作用（session 建行、markSessionRunStart、recoverStrandedTurns、diary bootstrap/reconcile）在所有 source 下照常执行，仅输出内容受矩阵约束。
3. sessions hook 输出收缩为 header + 状态层（Current Session），Recent Sessions 移出。
4. 第三条 hook 内容置换为 Recent Sessions + 日记索引：Recent Sessions 溢出指针指向裸 `recall()`（修复现状指向 `recall(id="S<n>")` 的错位）；日记索引保持 recent-first 与既有子上限语义；合并预算 2000。
5. experience.md 退出注入；dream agent 对它的维护、以及 diary/persona 其余行为一律不变。第三条 hook 为此需要 DB 读取（Recent Sessions），从纯读文件 handler 变为只读 DB handler——不做任何写事务。
6. 空内容行为沿用三路拆分先例：读不到内容时静默 `{continue: true}`。

## 关键文件

- `src/hooks/handlers/context.ts`、`src/hooks/hook-command.ts` — 分流与装配
- `plugin/hooks/hooks.json` — 四条注册
- `src/diary/persona-render.ts` — 预算渲染
- `tests/hooks/context.diary.test.ts`、`tests/hooks/context.test.ts`、`tests/hooks/session-end.test.ts` — 三路拆分与 glance 门控回归先例

## 约束

- 不执行任何 git 命令；只编辑文件。
- 不做版本号变更、不重建 plugin/scripts/*.cjs（stale-bundle 守卫 1 fail 是预期基线）。
- 不触碰 ~/.claude-mnemo 下的任何线上数据。
- `bunx tsc --noEmit` 通过；`bun test` 相对基线（928 pass / 1 fail）不回退。

## Acceptance criteria

- [x] 四种 source 各自的注入组合与矩阵一致（逐 source 断言有/无）
- [x] sessions 副作用在全部四种 source 下恰好执行一次（含 startup/clear 不输出状态层时）
- [x] 第三条 hook 含 Recent Sessions + 日记索引、不含 experience 内容；溢出指针为裸 `recall()`
- [x] sessions hook 输出不再含 Recent Sessions
- [x] 各条注入均 ≤ 各自预算；既有测试不回退

## Comments

- 四条 SessionStart handler 已按 `input.source` 分流：startup/clear 的 sessions 与 milestones 静默，resume/compact 输出 header + Current Session 与独立 milestones；persona、Recent Sessions + 日记索引在四种 source 下均照常读取。`plugin/hooks/hooks.json` 保持全量 matcher，第三条命令由 `context experience` 改为 `context recent`。
- sessions handler 的建行、stranded-turn recovery、run-state 与 diary bootstrap/reconcile 均位于输出门控之外；四 source 矩阵测试逐一断言 turn-stop 队列、`session_run_state`、bootstrap/reconcile 各一次。compact 若已有 run-state 会保留原起始边界，避免同一次 Claude run 的 SessionEnd glance 门控漏掉 compact 前新 turn；缺 marker 时仍补建。
- sessions 输出已移除 Recent Sessions，只保留 header + bounded 状态层。第三条 handler 以只读 DB 查询 Recent Sessions，并与 recent-first 日记索引合并在 2000-token 预算内；日记索引仍有 1000-token 子上限，Recent Sessions 溢出目标为裸 `recall()`，查询前后 `total_changes()` 不变。
- experience 注入路由与专用 renderer 已移除，测试用 sentinel 证明其内容不进入第三条；`DreamMemoryStore`、dream agent 的 experience.md 读写/维护链路未修改。README 的 SessionStart 说明同步为 source-aware 矩阵。
- 验证：本票相关 SessionEnd + hook/render 回归 53 pass / 0 fail；最终全量 `bun test` 为 956 pass / 1 fail（相对给定 951 pass 基线新增 5 条矩阵测试），唯一失败为按约束未重建 `plugin/scripts/*.cjs` 的 stale-bundle 守卫；`bunx tsc --noEmit` 通过。
- 偏差：未执行任何 git 命令，未改版本号，未重建 `plugin/scripts/*.cjs`，未访问 `~/.claude-mnemo`。除为关闭文档契约漂移而同步 README 外，无范围偏差。
- 调用方验收备注（覆盖全部六票）：自跑 `bunx tsc --noEmit` 通过、全量 `bun test` 956 pass / 1 fail（唯一失败为 stale-bundle 预期守卫）。抽查确认：计分融合最小化且结构层零改动、remember 等级校验与 regrade 约束正确、校准块措辞与间隔正确、里程碑 hook 只读且降级逐级实现、指针去重按 sectionDisplayPaths 语义落地、注入矩阵路由与副作用门控正确。接受的偏差：第三条命令改名 `context recent`（语义更准）；compact 时 run-state marker 缺失才补建、已有则保留起始边界（修正 glance 门控的潜在漏洞）；README 同步。票 03 的 0.2.38 私有 dump 重验因历史 turn 等级全 NULL（完整回退、选择结果不变，已有单测断言）改为部署后观察真实打分质量。
