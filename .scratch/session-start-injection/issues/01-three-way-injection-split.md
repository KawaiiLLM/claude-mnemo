# 01 — SessionStart 注入拆分为三条 hook，各 2000-token 预算

**What to build:** SessionStart 的记忆注入从单条 additionalContext 拆成三条独立 hook（会话记忆／Persona／Experience），每条各自受 2000-token 预算约束。动机：Claude Code 对超阈值的 hook additionalContext 会持久化存盘、只内联 2KB 预览（阈值受灰度控制、实测 ~10K 字符即触发）；单条 25KB 的注入实际只有前 2KB 进入模型上下文。拆分后每条远低于阈值，全部内联。

**Blocked by:** None — can start immediately.

**Status:** implemented

## 设计决定

1. **hooks.json**：`SessionStart` 注册三条 command（同 matcher `startup|resume|clear|compact`），分别传 `context`、`context persona`、`context experience`（或等价的 `--section=` 形式，实现者定，但裸 `context` 必须等价于会话记忆节，保持向后兼容）。
2. **会话记忆节（sessions）**：header 两行 + `## Current Session` + `## Recent Sessions`。header 不计预算；其余整体应用 2000-token 预算，复用 `renderPersonaDocumentInjection`（src/diary/persona-render.ts）的按节降级语义（内容按 `##` ATX 节切分，逐节逐行填充，超限处放指针行）。指针文案不能指向文件路径（内容在 DB 不在盘上），改为指向 recall，如 `（本节还有 N 行，完整见 recall(id="S<id>")）`——可给 renderPersonaDocumentInjection 的 displayPath 传该字符串，或加参数定制指针文案，实现者定，但不得改变既有 persona/experience 调用方的指针行为。
3. **Persona 节**：现有 `## Persona` 块原样独立成一条（`PROFILE_INJECTION_TOKEN_BUDGET` = 2000 不变）。
4. **Experience 节**：现有 `## Experience` 块（`EXPERIENCE_INJECTION_TOKEN_BUDGET` = 2000 不变）+ 日记索引块（`DIARY_INDEX_INJECTION_TOKEN_BUDGET` = 1000 不变）合为一条。
5. **副作用只属于会话记忆节**：`markSessionRunStart`、`recoverStrandedTurns`、diary bootstrap/`reconcileBacklog` 等全部 DB 写与队列副作用只在 sessions 节执行；persona/experience 两条 hook 必须是纯读——三条 hook 并行执行，副作用跑三遍会造成重复入队与竞态。
6. **空内容行为**：persona/experience 节在 memoryStore/fileStore 缺失或读取失败时返回 `{continue: true}`（无 hookSpecificOutput），不得输出空段落或 fallback 文案；sessions 节保留既有 EMPTY_CONTEXT_FALLBACK 语义。
7. **SessionEnd/glance 门控不受影响**：`markSessionRunStart` 仍然恰好执行一次（由 sessions 节），tests/hooks/session-end.test.ts 的 glance 回归不得回退。

## 关键文件

- `src/hooks/handlers/context.ts` — 现有单条装配（buildContextOutput + appendDreamMemoryContext）
- `src/diary/persona-render.ts` — 降级渲染器与三个预算常量
- `plugin/hooks/hooks.json` — hook 注册
- hook-command 入口（`src/hooks/` 下的命令分发，找 `"context"` case）——新增节参数的解析

## 约束

- 不执行任何 git 命令（不 commit、不 branch、不 stash）；只编辑文件。
- 不做版本号变更、不重建 plugin/scripts/*.cjs 产物（release-artifacts stale-bundle 守卫的 1 个失败是预期基线）。
- 不触碰 ~/.claude-mnemo 下的任何线上数据。
- `bunx tsc --noEmit` 通过；`bun test` 相对基线（924 pass / 1 fail，唯一失败为 stale-bundle 守卫）不回退。

## Acceptance criteria

- [x] hooks.json 注册三条 SessionStart hook；裸 `context` 输出会话记忆节
- [x] sessions 节整体 ≤2000 token（header 豁免），超长会话按节降级并输出 recall 指针行
- [x] persona 节只含 Persona 块，experience 节只含 Experience 块 + 日记索引；两者均为纯读、无 DB 写
- [x] `markSessionRunStart` 与 diary reconcile 每次 SessionStart 恰好执行一次
- [x] 三节各自的注入在 `estimateDiaryTokens` 度量下 ≤ 各自预算；新增回归覆盖超长 Current Session 的降级与指针
- [x] 既有 hooks 测试（context / session-end / session-init）不回退

## Comments

- `plugin/hooks/hooks.json` 现以同一 matcher 注册 `context`、`context persona`、`context experience`；`src/hooks/hook-command.ts` 保持裸 `context` 向后兼容，并在默认命令路由层让 persona/experience 绕过 SQLite 创建与 schema 初始化。
- sessions 输出保留两行 header 且不计入预算，其余文档用 `renderPersonaDocumentInjection` 在 `SESSION_INJECTION_TOKEN_BUDGET = 2_000` 内按节降级；溢出指针指向当前 `recall(id="S<n>")`，不暴露文件路径。
- Persona 独占一条 2000-token 输出；Experience 与 recent-first 日记索引合并为一条输出，索引仍受 1000-token 子上限约束，合并结果整体不超过 Experience 的 2000-token 上限。
- persona/experience 使用独立只读 handler：不执行 `markSessionRunStart`、`recoverStrandedTurns`、diary bootstrap/reconcile，也不创建数据目录或恢复 memory transaction。文件缺失、读取失败及仅标题无正文时均静默返回 `{continue: true}`。
- 新增/更新回归覆盖三路命令注册与分发、内容隔离、三路预算、超长 Current Session recall 指针、启动副作用只执行一次、缺失/heading-only 静默和 SessionEnd glance 门控。双轴实现审查复核无剩余实质问题。
- `bunx tsc --noEmit` 通过。全量 `bun test`：928 pass / 1 fail（基线 924 pass / 1 fail，无回退）；唯一失败仍为 `tests/shared/release-artifacts.test.ts` stale-bundle guard。按约束未重建 `plugin/scripts/*.cjs`、未改版本号。
- 调用方验收备注：两处有意识的偏差均接受。(1) Experience+日记索引合并后整体 ≤2000 token（索引先占、Experience 吃剩余预算），比票面「2000+1000」更贴合「每条 2000」的原始需求；(2) `readInjectionDocuments` 改为纯读（不 mkdir、不做事务恢复）——三条 hook 并行执行，并发事务恢复本身就是竞态源，纯读是正确取舍；代价是 commit 中途崩溃留下的半发布状态可能被注入读到，罕见且下次写者流程自愈。ENOENT 容忍已确认，全新安装安全。自跑 `bunx tsc --noEmit` 通过、全量 bun test 928 pass / 1 fail（唯一失败为预期 stale-bundle 守卫）。
