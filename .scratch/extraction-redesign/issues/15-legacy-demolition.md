# 15 — 旧机构拆除

**What to build:** 切换的第三阶段（spec D10/D13）。按 D13 清单拆掉被新体系替代的机构：常驻提取 agent 的会话机构（compact 管理、resume 指针、stall watchdog、extraction_stall 列）、obs LLM 摘要管线、独立 per-session summary agent、SessionEnd tail 结算作业、新 era 路径的里程碑评分器（legacy 模块保留只读）、新 era 里旧 remember 形态的 grade/regrade/cites 强制、以及 dormant 的 tool/result 规则类工厂（裁决 22 挂账于本票）。明确不动：`claim_generation`、rules/persona/diary 本体、legacy 渲染全套。

**Blocked by:** 14 — 结算上线（拆除前必须有活的替代品）。

**Status:** ready-for-review

- [x] D13 继承／废止清单逐项勾验，「明确不动」三项回归测试保绿
- [x] worker 任何路径不再创建 SDK 会话（测试断言 + 全库 grep 双重验证），生命周期全程无 LLM
- [x] 切换时跑一次 `migrateTurnCitationsToEdges(db)` 追平迁移（幂等，已导出）——memory_edges 一次性迁移后 legacy remember 仍在写 turn_citations，增量不自动传播，拆除前必须追平
- [x] 拆除净减代码行数记录在发布说明
- [x] 版本号六处一致，构建产物守卫通过
- [x] 全量测试绿

## Comments

**净减行数（发布说明可直接引用）**

`src/` + `tests/`，不含 `plugin/scripts/*.cjs` 生成产物：**净减 21,080 行**（删 22,090、增 1,010，其中新增文件 447 行）。
- `src/`：净减 6,982（删 7,592、增 610）
- `tests/`：净减 14,098（删 14,498、增 400）

整文件删除：`src/worker/{query-session,derailment,cache-ttl,processors,settlement}.ts`、`src/db/settlement.ts`、`src/mcp/task-skeleton.ts`；`src/worker/agent-session.ts` 缩成 `claude-executable.ts`（只剩 `resolveClaudeCodeExecutablePath`，dream 与结算子进程仍需要）。`src/worker/server.ts` 4600 → 1574 行。

**实现记录（票 15 落地时的取舍）**

- **结算落点 = `reconcileNoteDebt` 的分类走查**（`src/db/note-debt.ts`），调用新的 `settleCompletedTurn`（`src/db/turn-completion.ts`）。三处调用方：Stop hook、PostToolUse 补扫、worker 的 turn-stop 出队。`completionFloorStatus` 从 `worker/turn-liveness.ts` 搬到同一模块，两个 floor 共用一份定义（票文明令不得再造第二份）。
- **worker 出队必须先结算再删队列行**：完结证据谓词把「排队中的 turn-stop」算作证据，先删行会留下无证据、无终态的 turn，残留修复每次结束事件都会重新入队，永动。
- **文件聚合被迫搬家**：`turns.files_read/files_modified/tool_call_count` 的唯一写者原来是提取 agent 的 mini-turn 构建副作用。recall、search、`db/segment-rank.ts`（⑤ files_modified 计数）与结算 prompt 都在读，故随 `settleCompletedTurn` 一起保留。
- **legacy 侧的真实代价**：`eraCutoffEpoch` 为 null 时，新 turn 落 `failed`（`completionFloorStatus` 的 pre-era 分支），因为再没有任何东西会为它写记录。这不是回归，是「拆掉写者却不翻开关」的诚实标注——**上线本票必须同时翻 cutoff**。
- **仍按 era 门控而非删除**：`mcp/remember.ts` 的 era 分支（不存 payload、不校验 grade/regrade/cites）保留——删掉它会让 era turn 的 `remember(T…)` 掉回 legacy 的 grade 强制路径，正是 D13 要废的东西；`timeline` 的里程碑评分选择保留为 legacy 只读渲染。
- **Codex 交叉审补丁（票 14+15 合并评审，3×P1，全部确认并修复）**：三条同一个根因——**「谁来解析纪元边界」没有单一入口**。worker 读注入的 `config.eraCutoffEpoch`（默认 null → 结算永久空转，且把新纪元 turn 判 `failed`）；MCP 在 handler 构造时把边界缓存一次（构造早于任何进程记录边界 → 整个会话的 `note` 只写影子笔记，正式行被 hook 结算成空洞）；orphan 与 stranded 两条终态化路径绕过 `aggregateTurnFiles`（`files_*` 永久为空）。修法：`resolveEraCutoff(db)` 加**按 db 实例的非空记忆**（null 永不缓存——它只意味着「还没人记录」；非空缓存住，边界不得在进程运行中移动），worker/MCP 改为「显式配置优先，否则用记录值」逐次解析，两条终态路径补上聚合。5 个回归测试，其中 worker 与 MCP 两条已实测在旧码上变红（`failed` / `Received: null`）。
- **裁决 22 的 tool/result 只拆投递侧**：`createPreToolUseDispatcher` / `createPostToolUseDispatcher` 与它们独占的匹配器删除；`rules/schema.ts` 的 `tool`/`result` 触发词表保留——digest、dream 写规则工具都在说这套词汇，而 D13 明列「rules 本体不动」。
