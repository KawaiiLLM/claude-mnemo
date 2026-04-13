# Observation Prompt 压缩与 Auto-Skip

**Goal**: 压缩发给 Mnemosyne agent 的 observation 内容，减少 worker query session 的 token 消耗；同时消除模型对不感兴趣的 obs 显式调用 `remember(id, status:skipped)` 的需求。

**动机**:

1. **obs 占 batch prompt 的 93%**（实测：36,147 字符的 batch 中 obs 占 33,511 字符），但大部分被 skip（49 个 obs 中 41 个被 skip）。
2. **当前格式浪费严重**：`toolInput`/`toolResult` 是原始 JSON 字符串直接 `truncateMiddle(500)`，包含大量系统噪音 key（`stderr:""`、`interrupted:false`、`isImage:false` 等），有效信息占比低。
3. **skip 协议浪费 output tokens**：模型需要对每个不感兴趣的 obs 显式调用 `remember({ id: "O<n>", status: "skipped" })`。实测一个 batch 产生 41 个 skip tool_use 调用 + 41 个 tool_result 反馈消息。
4. **Worker session ce6d2777 花费 $56.72**，其中 cache_read $31.31（prompt 随历史增长线性上涨），压缩 obs 内容可直接降低 prompt 增长速率。

**前置**: 无外部依赖，在现有 `buildObsBlock` + `remember` 协议上修改。

---

## Locked Decisions

**D1**: **Input 侧只剥离 Bash 的系统注入 key，其余 agent 参数全部保留**。

实测统计（1499 obs / 10 种工具）发现：只有 Bash 的 `description` 和 `timeout` 是 CC 系统注入的元数据。其他工具（Read、Grep、Edit、Glob、Agent、Write 等）的 input key 全部是 agent 主动指定的参数，没有系统注入。

```ts
const INPUT_STRIP: Record<string, Set<string>> = {
  Bash: new Set(["description", "timeout"]),
};
```

Bash 剥离后如果只剩 `command` 一个 string 值，解包为裸字符串（去掉 JSON 外壳）。其他工具的 input 原样保留 JSON 结构。

**D2**: **Output 侧用 per-tool allowlist 只保留正式返回结果**。

从真实数据中按工具分析 output JSON key 的角色（正式结果 vs 系统包装），确定以下 allowlist：

```ts
const OUTPUT_ALLOW: Record<string, Set<string>> = {
  Bash:       new Set(["stdout", "stderr"]),  // stderr conditionally kept
  Read:       new Set(["content"]),        // 从 file.content 提取
  Grep:       new Set(["filenames", "content", "numFiles", "numLines"]),
  Edit:       new Set(["filePath", "oldString", "newString"]),
  Glob:       new Set(["filenames", "numFiles"]),
  Write:      new Set(["filePath"]),
  Agent:      new Set(["status", "content"]),
  WebFetch:   new Set(["result", "code"]),
  WebSearch:  new Set(["results"]),
  ToolSearch: new Set(["matches"]),
  Skill:      new Set(["success", "commandName"]),
};
```

特殊处理：
- **Read**: output 结构是 `{"type":"text","file":{"filePath":"...","content":"..."}}`，`content` 嵌套在 `file` 对象内，需要 `obj.file.content` 提取。
- **Bash**: `stderr` 条件保留——为空时丢弃，非空时保留。如果 `stdout` 为空且 `stderr` 非空，直接用 `stderr` 作为主结果（测试失败、构建错误、权限问题等 durable finding 主要在 stderr）。两者都非空时保留两个 key。单值时解包为裸字符串。
- **未知工具**（不在 allowlist 中的 MCP 工具等）：output 原样保留，不做过滤。

被丢弃的 key 及理由：

| 类别 | 丢弃的 key | 理由 |
|------|-----------|------|
| 布尔标志 | `interrupted`, `isImage`, `noOutputExpected`, `truncated`, `replaceAll`, `userModified` | 实测全为 false 或与理解工具行为无关 |
| 计时/统计 | `durationMs`, `totalDurationMs`, `totalTokens`, `totalToolUseCount` | Agent 性能数据，非正式结果 |
| 类型标记 | `type`, `mode` | 全为固定值（`"text"`、`"content"` 等） |
| 输入重复 | `file`(Read 的 `filePath` 重复 input)、`query`(WebSearch)、`url`(WebFetch)、`prompt`(Agent) | 与 input 字段重复 |
| 空值/占位 | `originalFile`(null)、`structuredPatch`([]) | 无信息量 |
| 元数据 | `returnCodeInterpretation`, `persistedOutputPath/Size`, `appliedLimit`, `startLine`, `totalLines`, `numLines`(Read) | 非正式结果的辅助信息 |
| Agent 内部 | `agentId`, `agentType`, `usage`, `server_tool_use`, `cache_creation`, `service_tier`, `inference_geo`, `speed`, `iterations`, `ephemeral_*` | CC 内部跟踪数据 |

**D3**: **过滤后单值 JSON 解包**。如果过滤后的 JSON 对象只剩一个 key 且值为 string，直接解包为裸字符串，去掉 JSON 外壳。这使 Bash 的 `{"stdout":"..."}` → `...`，Read 的 `file.content` → 直接文件内容，提升可读性。

**D4**: **截断策略：`truncateMiddle`（head+tail），in: 300, out: 300**。

选择 head+tail 而非 head-only 的理由（基于真实数据对比）：
- **Grep**: JSON 结构的统计字段 `numFiles`/`numLines` 在末尾，head-only 会丢失
- **Edit**: `newString` 的末尾包含修改后的完整代码，head-only 看不到结尾
- **Agent**: 末尾包含总结和建议

选择 300c 的理由：
- 清洗后 input p50=108，绝大部分不需要截断
- 清洗后 output p50=957，300c 保留了 head 150c + tail 150c 的关键信息
- 记忆 agent 的任务是写 1 段摘要或 skip，不需要完整内容
- 300c ≈ 75 tokens，每端约 37 tokens，足够理解要点

**D5**: **过滤+截断的执行顺序：先过滤，再截断**。必须先将 JSON 解析、过滤 key、解包单值，然后对结果应用 `truncateMiddle(300)`。当前代码是直接对原始 JSON 字符串 `truncateMiddle(500)`，截断后的残缺 JSON 无法再做 key 过滤。

实现位置：在 `buildObsBlock` 中增加 `cleanInput(toolName, toolInput)` 和 `cleanOutput(toolName, toolResult)` 两个处理函数，替换当前的直接 `truncateMiddle` 调用。

**D6**: **Auto-skip 仅在 completed-turn batch 中启用，partial-turn keepalive 不做 auto-skip**。

当前协议要求模型对每个 obs 都调用 `remember()`（extracted 或 skipped）。改为：

- `processBatch` 在 `pushMessage` 前记录本次 batch 中来自 **completed turn** 的 pending obs ID 集合
- `pushMessage` 完成后（Mnemosyne 已处理完毕），重新读取这些 obs 的 status
- 仍为 `pending` 的 obs 自动更新为 `skipped`（Mnemosyne 没有调用 `remember()`，等同于不感兴趣）
- 已经被 Mnemosyne 更新为 `extracted` 的 obs 不受影响

**partial-turn keepalive 路径不做 auto-skip**。原因：keepalive 只选取 in-progress turn 的部分 obs 发送（`server.ts` 的 partial-turn 选择逻辑），模型这次没处理的 obs 可能只是还没轮到，turn 结束后它们会进入完整的 completed-turn batch。如果在 keepalive 阶段就标 skipped，这些 obs 后续再也不会被处理。

区分方法：`processBatch` 的 `options.turnStopItems` 非空时表示 completed-turn batch，此时启用 auto-skip；`turnStopItems` 为空且存在 `partialTurns` 时为 keepalive 路径，不做 auto-skip。

**D7**: **更新系统 prompt，移除 skip 协议**。`query-session.ts` 中的 Mnemosyne 系统 prompt 需要修改：

当前：
```
For each <obs> block, make exactly one call:
- remember({ id: "O<n>", title, content }) 
- remember({ id: "O<n>", status: "skipped" }) for routine operations
```

改为：
```
For each <obs> block, call remember({ id: "O<n>", title, content }) only if the observation contains durable findings worth recording. Routine operations (repeated reads, navigation, failed retries, environment probes) can be silently ignored — unprocessed observations are automatically marked as skipped.
```

Turn 的 skip 协议保持不变（`remember({ id: "T<n>", status: "skipped" })`），因为 turn 的 skip 判断更复杂且数量远小于 obs。

**D8**: **`remember()` 工具仍然接受 `status: "skipped"`**。不移除 `skipped` 状态的显式支持——如果模型出于某种原因想要主动 skip 一个 obs，仍然可以。auto-skip 只是作为"模型没有处理"的兜底，不是强制。

**D9**: **`files_read` / `files_modified` 渲染为文件树格式**。

当前格式是逗号分隔的绝对路径列表，平均路径长约 71c，长 turn 的 `files_read` 可达 1500c+。改为自动计算公共根目录，按目录层级缩进渲染：

当前：
```
files_read: /Users/zhaoqixuan/Projects/claude-mnemo/src/worker/processors.ts, /Users/zhaoqixuan/Projects/claude-mnemo/src/worker/server.ts, /Users/zhaoqixuan/Projects/claude-mnemo/src/db/pending-queue.ts
```

优化后：
```
files_read:
  /Users/zhaoqixuan/Projects/claude-mnemo
  src/db/pending-queue.ts
  src/worker/
    processors.ts
    server.ts
```

实现要点：
- `renderFileTree(paths)` 函数：计算所有路径的最长公共目录前缀作为根，其余路径相对化后按目录归组
- 单文件目录不展开：`src/db/pending-queue.ts`（不拆成目录+文件两行）
- 多文件目录展开缩进：`src/worker/` 下列出文件
- 根路径本身如果出现在列表中（如 Glob 返回裸目录），去重不重复打印
- 跨项目路径（公共前缀较短如 `~`）也能正常工作，只是相对化收益小
- `files_read` 和 `files_modified` 共用同一个 `renderFileTree` 函数

实测效果（S38 session，214 turns）：

| 指标 | 当前 (flat 绝对路径) | 优化后 (文件树) | 变化 |
|------|---------------------|----------------|------|
| files_read 总大小 | 26,498c | ~10,600c | **-60%** |
| files_modified 总大小 | 4,660c | ~1,860c | **-60%** |
| 最长 turn (T160, 22 files) | 1,538c | 651c | **-58%** |

应用于 `buildBatchTurnBlock`、`buildPartialTurnBlock`、`buildTurnStopPrompt` 三个渲染函数中的 `files_read` / `files_modified` 字段。

---

## 不做的事

- **不做 per-tool 的 input 提取**（如 Bash 只取 command, Read 只取 file_path）。Input 侧 agent 参数信息密度高（p50=108c），全量保留成本低，且 Grep 的 `output_mode`、`-n` 等参数确实影响结果解读。
- **不做 output 的嵌套 key 过滤**（如 Read 的 `file.content` 内部不再剥离）。过滤到正式返回值后交给 truncateMiddle 处理，不递归进入嵌套对象。
- **不改变 `<obs>` 的 XML 结构**。仍然保持 `in:` / `out:` 两字段格式，只是内容更干净。
- **不改变 turn 的 skip 协议**。Turn 数量远小于 obs，且 turn skip 需要模型判断（无工具调用、无文件变更、无用户决策），不适合 auto-skip。
- **不对 `files_read`/`files_modified` 做路径相对化**。文件树格式已经通过公共前缀自动达到相对化效果，不需要额外传 `project` 参数。

---

## 预期收益

基于 S38 session（1196 obs）的实测数据：

| 指标 | 当前 | 优化后 | 变化 |
|------|------|--------|------|
| 平均 obs block 大小 | 684c | 480c | -30% |
| Bash obs 均大小 | 836c | 532c | -36% |
| Read obs 均大小 | 654c | 450c | -31% |
| Grep obs 均大小 | 632c | 487c | -23% |
| Skip output tokens/batch | ~820 (41 skip calls) | 0 | -100% |
| Skip tool_result messages/batch | 41 | 0 | -100% |

Worker session cache_read 成本与 prompt 长度线性相关，obs 压缩 30% 直接降低 prompt 增长速率约 28%（obs 占 batch 的 93%）。

---

## 实现任务

### Task 1: `cleanInput` + `cleanOutput` 函数

**文件**: `src/worker/processors.ts`

新增两个函数，在 `buildObsBlock` 调用前处理 toolInput / toolResult：

- `cleanInput(toolName, rawJson)`: 解析 JSON → 按 `INPUT_STRIP` 删除 key → 单值解包
- `cleanOutput(toolName, rawJson)`: 解析 JSON → Read 特殊提取 `file.content` → 按 `OUTPUT_ALLOW` 过滤 → Bash 丢弃空 stderr → 单值解包
- JSON 解析失败时返回原始字符串（容错）

修改 `buildObsBlock`：`truncateMiddle(toolInput, 500)` → `truncateMiddle(cleanInput(toolName, toolInput), 300)`，output 同理。

### Task 2: Auto-skip 逻辑

**文件**: `src/worker/processors.ts` (`processBatch` 方法)

在 `pushMessage` 完成后、返回前，**仅当 completed-turn batch（`turnStopItems` 非空）时**：

1. 收集本次 batch 中所有 kind === "obs" 且来自 completed turn 的 item 的 targetId
2. 重新读取这些 observation 的 status
3. 仍为 `pending` 的批量更新为 `skipped`

partial-turn keepalive 路径（`turnStopItems` 为空且存在 `partialTurns`）不执行 auto-skip。

需要新增批量更新函数或复用现有 `updateObservation`。

### Task 3: `renderFileTree` 函数

**文件**: `src/worker/processors.ts`

新增 `renderFileTree(paths)` 函数，替换 `buildBatchTurnBlock`、`buildPartialTurnBlock`、`buildTurnStopPrompt` 中的 `filesRead.join(", ")` / `filesModified.join(", ")`。

- 计算公共目录前缀作为根
- 路径相对化后按目录归组
- 单文件目录渲染为 `dir/file`，多文件目录展开为缩进列表
- 根路径如果本身出现在列表中，去重
- 空列表返回 `(none)`

### Task 4: 更新 Mnemosyne 系统 prompt

**文件**: `src/worker/query-session.ts`

修改 `## Observation messages` 部分，移除显式 skip 调用的要求，改为"不感兴趣的 obs 可以忽略"。

### Task 5: 测试

- `cleanInput` / `cleanOutput` 的单元测试：覆盖 Bash、Read、Grep、Edit、Glob、Agent、Write、未知工具
- 单值解包测试
- JSON 解析失败容错测试
- `truncateMiddle` 在新限制下的行为测试
- auto-skip 集成测试：batch 中 3 个 obs，模型只 remember 1 个，验证另外 2 个自动变为 skipped
- `renderFileTree` 单元测试：单文件、多文件同目录、跨目录、公共前缀计算、根路径去重、空列表
- 系统 prompt 中不再包含 `status: "skipped"` 指令的验证

---

## Test Cases

1. `cleanInput` strips Bash description and timeout
2. `cleanInput` preserves all keys for non-Bash tools (Read, Grep, Edit)
3. `cleanInput` unwraps single-value JSON to bare string (Bash command)
4. `cleanInput` returns raw string when JSON parse fails
5. `cleanOutput` extracts file.content for Read
6. `cleanOutput` keeps stdout for Bash, drops empty stderr
7. `cleanOutput` keeps non-empty stderr for Bash (error context)
8. `cleanOutput` uses stderr as primary result when stdout is empty and stderr is non-empty
9. `cleanOutput` keeps filenames + content + numFiles + numLines for Grep
10. `cleanOutput` keeps filePath + oldString + newString for Edit
11. `cleanOutput` passes through unknown tool output unchanged
12. `cleanOutput` unwraps single-value result to bare string
13. `cleanOutput` returns raw string when JSON parse fails
14. `buildObsBlock` produces truncated output at 300c limit with head+tail
15. `processBatch` auto-skips pending obs in completed-turn batch not processed by Mnemosyne
16. `processBatch` does not auto-skip obs that Mnemosyne extracted
17. `processBatch` does not auto-skip obs in partial-turn keepalive batch
18. `renderFileTree` groups files under common root with directory indentation
19. `renderFileTree` renders single-file directory as `dir/file` (no expansion)
20. `renderFileTree` deduplicates root path when it appears in path list
21. `renderFileTree` returns `(none)` for empty list
22. `renderFileTree` handles cross-project paths (short common prefix)
23. `buildBatchTurnBlock` renders files_read/files_modified as file tree
24. System prompt no longer instructs explicit skip calls for observations
