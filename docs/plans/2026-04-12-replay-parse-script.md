# replay-parse: JSONL Transcript Parser

**Goal**: 提供一个可直接 `bun run` 的 CLI 脚本，让 agent 免去手写 Python 解析 JSONL 的时间。三个子命令覆盖 turn 列表、单 turn 展开、关键词搜索。

**入口**: `plugin/scripts/replay-parse.cjs`（esbuild bundle，随插件分发）

**调用方式**: agent 通过 Bash 执行：
```bash
bun <plugin-root>/scripts/replay-parse.cjs <subcommand> <jsonl-path> [options]
```

**依赖**: 复用 `src/shared/transcript-parser.ts` 的 entry reader/normalizer，不引入外部库。

---

## JSONL 结构参考

基于实际日志分析（2774 行，151 turns，5 compact boundaries）：

| 行类型 | 占比 | 关键字段 |
|---|---|---|
| `assistant` | ~49% | `message.content[]` = text / tool_use / thinking |
| `user` | ~33% | `message.content` = string (human) 或 `[{type:"tool_result"}]` |
| `system` | ~9% | `subtype` = stop_hook_summary / turn_duration / compact_boundary / api_error / local_command |
| `file-history-snapshot` | ~7% | 无分析价值，跳过 |
| `last-prompt` / `permission-mode` / `queue-operation` | <2% | 元数据，跳过 |

**Turn 定义**：一个 turn 由同一 `promptId` 下的所有消息组成：
1. 一条 `user` 消息（`content` 为 string 或含 `type:"text"` 的数组） — turn 起点
2. N 条 `assistant` 消息（text / tool_use / thinking blocks）
3. N 条 `user` 消息（`content` 含 `type:"tool_result"` — 工具返回）
4. 一条 `system/turn_duration`（`durationMs`, `messageCount`）
5. 一条 `system/stop_hook_summary`（hook 摘要）

**Compact boundary**: `system` 行 `subtype:"compact_boundary"`，含 `compactMetadata.trigger` 和 `compactMetadata.preTokens`。

---

## Locked Decisions

**D1**: 脚本输出纯文本，不 JSON 化。Agent 直接读 stdout，不需要再 `JSON.parse`。

**D2**: Turn 编号使用 `T<n>`，语义与 mnemo 全系统的 `promptNumber` 一致（`parseReplayTranscript` 中按 `startsNewTurn` 递增的计数器）。即 replay-parse 的 `T12` 等价于 `recall(id="Sx/T12")` 和 `timeline(id="Sx/T12")`，坐标系统一。

**D3**: 默认 preview 长度 120 字符，`--preview N` 可调，`--preview 0` 不截断。截断时追加 `…`。

**D4**: `ls` 默认显示最后 30 个 turn（`--last 30`）。`--all` 显示全部。`--range T50..80` 精确范围。`--first N` 从头取。

**D5**: Compact boundary 在 `ls` 输出中以分隔线 `── compact (357k tokens, manual) ──` 标记，插入到对应 turn 之间。

**D6**: `show` 展开单 turn 时，tool_use 显示为 `TOOL: <name>(<key>=<value_preview>)`，tool_result 显示为 `  → <content_preview>`。thinking blocks 默认跳过，`--thinking` 显示。

**D7**: `grep` 默认搜索 user prompt + assistant text。`--type user|assistant|tool` 限定搜索范围。输出格式与 `ls` 一致但高亮匹配行。

**D8**: 行号 `L<n>` 指 JSONL 文件的 1-based 行号（对应 turn 起始 user 消息所在行），agent 可直接 `Read --offset` 定位。

**D9**: Usage 统计可选——`ls --usage` 在每个 turn 追加 `in=<n> out=<n> cache=<n>`。默认不显示（减少噪声）。

**D10**: 脚本入口使用 `process.argv` 解析参数，不引入 arg-parser 库。参数格式保持最简。

---

## Subcommand: `ls`

列出 turn 概览。

### 用法

```bash
replay-parse ls <jsonl> [options]
```

### Options

| Flag | Default | Description |
|---|---|---|
| `--last N` | 30 | 显示最后 N 个 turn |
| `--first N` | — | 显示前 N 个 turn |
| `--range T<a>..T<b>` | — | 显示 T<a> 到 T<b>（闭区间） |
| `--all` | — | 显示全部 turn |
| `--preview N` | 120 | user prompt 截断长度 |
| `--usage` | false | 显示 token 统计 |
| `--grep <keyword>` | — | 只显示 user prompt 包含 keyword 的 turn |

### 输出格式

```
151 turns | 5 compacts | 2026-04-11 01:50 → 17:06 (15h 16m)

T  1  L3     01:50  🔧5          看看这个项目中最长的那个session日志
T  2  L20    01:53  🔧3 📖1      最新的compact内容是什么
T  3  L37    01:56  🔧1          简单看看后续工作
...
T 29  L410   03:33  🔧4 📖2      codex审查
T 30  L425   03:36  🔧1          /compact
── compact (357k tokens, manual) ──
T 31  L435   03:37  🔧12 📖4     继续实现spec
...
T151  L2770  17:06  🔧2          看看目前的timeline是否正常
```

**列说明**：
- `T<n>`: promptNumber（与 recall/timeline 坐标一致）
- `L<n>`: JSONL 行号
- `HH:MM`: 本地时间
- stats: 🔧tool_use 📖Read ✏️Edit/Write（仅计数 > 0 时显示）
- prompt: user prompt preview（截断到 `--preview`）

**Summary 行**（首行）：total turns | compact count | time range (duration)

### `--usage` 追加列

```
T  1  L3     01:50  🔧5          看看这个项目中...    in=29k out=925 cache=17k
```

---

## Subcommand: `show`

展开单个 turn 的完整交互序列。

### 用法

```bash
replay-parse show <jsonl> T<n> [options]
```

### Options

| Flag | Default | Description |
|---|---|---|
| `--preview N` | 200 | 每条消息截断长度 |
| `--no-tool-result` | false | 隐藏 tool_result 内容（只显示 tool_use） |
| `--thinking` | false | 显示 thinking blocks |
| `--raw` | false | 不截断，输出完整内容 |

### 输出格式

```
T12  L248  02:37  duration=42s  messages=15

USER:
不能指定work运行的agent的日志存储位置吗

ASST:
好问题 —— 理论上应该能。让我先查 SDK 的 `query()` 接受哪些和路径相关的参数，确认一下是不是真的没有这个选项。

TOOL: Grep(pattern="cwd|workdir", path="src/worker")
  → 3 matches found...

TOOL: Read(file_path="src/worker/query-session.ts")
  → (379 lines)

ASST:
SDK 的 `query()` 有 `cwd` 参数，但它控制的是工具执行的工作目录，不是日志存储路径。Agent session 的 JSONL 固定写到 `~/.claude/projects/` 下...

TOOL: Grep(pattern="resolveTranscriptPath", path="src/")
  → 2 files matched

TOOL: Read(file_path="src/shared/paths.ts")
  → (45 lines)

ASST:
确认了：transcript 路径由 `resolveTranscriptPath(project, contentSessionId)` 决定...

usage: input=12,450  output=1,823  cache_read=28,100
```

**消息序列**：按 JSONL 出现顺序，交替显示 USER / ASST / TOOL。

**TOOL 行格式**：
- tool_use: `TOOL: <name>(<param>=<value_preview>)` — 参数只取前 2 个 key，每个 value 截断到 60 字符
- tool_result: `  → <content_preview>` — 缩进 2 格，preview 截断到 `--preview`
- `--no-tool-result` 时 tool_result 行替换为 `  → (omitted)`

**Thinking**：
- 默认不显示（占大量 token）
- `--thinking` 时显示为 `THINK: <content_preview>`

---

## Subcommand: `grep`

搜索 turn 内容。

### 用法

```bash
replay-parse grep <jsonl> <pattern> [options]
```

### Options

| Flag | Default | Description |
|---|---|---|
| `--type user\|assistant\|tool` | all | 限定搜索范围 |
| `--context N` | 0 | 匹配行前后显示 N 条消息 |
| `--preview N` | 120 | 消息截断长度 |
| `-i` | false | 忽略大小写 |

### 输出格式

```
12 matches in 8 turns

T  7  L93   02:07  🔧8 📖3
  USER: 当前日志记录哪些信息，记忆Agent有session日志吗
  ASST: ...worker 代码里一共 9 个日志...

T 12  L248  02:37  🔧7 📖2
  USER: 不能指定work运行的agent的日志存储位置吗
  ASST: ...SDK 的 `query()` 有 `cwd` 参数...

T 45  L890  05:12  🔧3
  TOOL: Grep(pattern="日志") → ...worker.log 3 matches...
```

**匹配逻辑**：`pattern` 作为 substring match（非 regex），匹配 user text / assistant text / tool_use name+input / tool_result content。

**`--type` 过滤**：
- `user`: 只搜 user prompt text
- `assistant`: 只搜 assistant text blocks
- `tool`: 只搜 tool_use 参数 + tool_result 内容

---

## Implementation

### Task 1: Turn parser（基于 transcript-parser）

**文件**: `src/replay/parser.ts`

**核心原则**：复用 `src/shared/transcript-parser.ts` 的底层能力，不重新实现 JSONL 解析规则。

**复用链**：
- `readAllTranscriptEntries(path)` — entry 读取 + malformed skip + uuid dedupe + `normalizeEntry`
- `parseReplayTranscript(path)` — turn 分割（`startsNewTurn` / `isRealUserPrompt` / `isCountedUserPrompt`）+ promptNumber 递增 + tool_use/tool_result 配对

**扩展点**：`parseReplayTranscript` 返回 `ParsedReplayTurn[]`，已包含 `promptNumber`、`promptId`、`transcriptLineStart`、`userPrompt`、`assistantText`、`toolCalls[]`（含 result）。replay-parse 在此基础上补充：

1. **timestamp / localTime** — 从 `readAllTranscriptEntries` 的原始 entry 中提取 `timestamp` 字段（entry 级别有但 `ParsedReplayTurn` 未暴露），需要扩展 `TranscriptEntryWithLineNumber` 或在上层二次扫描
2. **durationMs / messageCount** — 从 `system/turn_duration` entries 中提取，按 parentUuid 或位置关联到 turn
3. **usage** — 从 `assistant` entries 的 `message.usage` 中聚合（`readAllTranscriptEntries` 的 `normalizeEntry` 当前不提取 usage，需要扩展或在上层从原始 JSON 提取）
4. **compact boundaries** — 从 `system/compact_boundary` entries 中提取（`readAllTranscriptEntries` 已返回这些 entries，上层按 lineNumber 定位到 afterTurnNumber）
5. **thinking blocks** — 从 `assistant` entries 的 content blocks 中提取（`extractAssistantParts` 当前跳过 thinking，上层需直接读 content blocks）
6. **message sequence** — `parseReplayTranscript` 把 tool_use/tool_result 折叠到 `toolCalls[]`，但 `show` 命令需要按 JSONL 原始顺序的 USER/ASST/TOOL 交替序列。上层需要从 entries 重建这个序列

**需要对 transcript-parser 做的最小扩展**（不改现有接口）：

```typescript
// 新增导出：让 replay-parse 能访问原始 entry 流中的 timestamp/usage/system 信息
// 方案：readAllTranscriptEntries 已返回 TranscriptEntryWithLineNumber[]
// 在 normalizeEntry 中补充 timestamp 字段即可

// TranscriptEntry 新增可选字段：
timestamp?: string;           // ISO string, 原始 JSON 的 timestamp
usage?: {                     // assistant message 的 usage
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};
durationMs?: number;          // system/turn_duration 的 durationMs
messageCount?: number;        // system/turn_duration 的 messageCount
```

核心数据结构：

```typescript
// 继承 ParsedReplayTurn 并扩展
interface ReplayParseTurn {
  promptNumber: number;         // 与 mnemo 全系统一致
  promptId: string | null;
  lineStart: number;            // transcriptLineStart
  timestamp: string | null;     // ISO string
  localTime: string;            // HH:MM
  durationMs: number | null;
  messageCount: number | null;
  userPrompt: string;
  assistantText: string;
  toolCalls: ReplayToolCall[];  // 复用 transcript-parser 的类型
  messages: TurnMessage[];      // 按 JSONL 顺序的完整消息序列（show 命令用）
  usage: TurnUsage;
}

interface TurnMessage {
  type: "user" | "assistant" | "tool_use" | "tool_result" | "thinking";
  line: number;
  content: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
}

interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

interface CompactBoundary {
  afterPromptNumber: number;    // 对齐 promptNumber 坐标
  line: number;
  trigger: string;
  preTokens: number;
}

interface ReplayParseResult {
  turns: ReplayParseTurn[];
  compacts: CompactBoundary[];
  timeRange: { start: string; end: string };
}
```

**解析流程**：
1. `readAllTranscriptEntries(path)` 获取全部 entries（已 dedupe + normalize + skip malformed）
2. `parseReplayTranscript(path, entries)` 获取 `ParsedReplayTurn[]`（复用 preloadedEntries 避免二次读取）
3. 遍历 entries 补充 timestamp / usage / durationMs / thinking / message sequence / compact boundaries
4. 按 promptNumber 关联 turn 和 system entries

### Task 2: `ls` 子命令

**文件**: `src/replay/commands/ls.ts`

1. 调用 parser 获取 `ParseResult`
2. 按 `--last`/`--first`/`--range`/`--all` 过滤 turns
3. `--grep` 进一步过滤（substring match on `userPrompt`）
4. 渲染 summary 行 + turn 行 + compact 分隔线
5. stats 列：统计 messages 中 tool_use 的 name，分类计数（Read→📖, Edit/Write→✏️, 其他→🔧）

### Task 3: `show` 子命令

**文件**: `src/replay/commands/show.ts`

1. 调用 parser，定位目标 turn
2. 按消息顺序渲染 USER / ASST / TOOL / THINK 块
3. tool_use 格式化：取 `toolInput` 前 2 个 key，value 截断
4. tool_result 格式化：按 `--preview` 截断，`--no-tool-result` 时替换为 `(omitted)`
5. 末尾输出 usage 汇总

### Task 4: `grep` 子命令

**文件**: `src/replay/commands/grep.ts`

1. 调用 parser 获取全部 turns
2. 对每个 turn 的每条 message 做 substring match（or `--type` 过滤后的子集）
3. 收集匹配的 turns + messages
4. 渲染：turn header + 匹配的 message preview
5. `--context N` 时，匹配 message 前后各展示 N 条

### Task 5: CLI 入口

**文件**: `src/replay/cli.ts`

1. `process.argv` 解析：`argv[2]` = subcommand, `argv[3]` = jsonl path, `argv[4..]` = options
2. 分发到 ls / show / grep handler
3. 无效参数时输出 usage 文本
4. 所有输出写到 `process.stdout`

### Task 6: Build + Skill 更新

1. `scripts/build.js` 新增 `replay-parse.cjs` entrypoint（从 `src/replay/cli.ts`）
2. `plugin/skills/mnemo-replay` 更新：砍掉路径格式、grep pattern 等低价值内容，改为子命令调用示例
3. `npm run build` 重新构建

### Task 7: 测试

**文件**: `tests/replay/parser.test.ts`

1. 构造最小 JSONL fixture（3 turns + 1 compact boundary）
2. 验证 `ParseResult` 的 turn 数量、promptId、lineStart、userPrompt
3. 验证 compact boundary 的 afterTurnNumber 和 metadata
4. 验证 tool_use / tool_result 提取
5. 验证 usage 聚合

**文件**: `tests/replay/commands.test.ts`

6. `ls` 输出包含 summary 行和 compact 分隔线
7. `ls --last 2` 只输出最后 2 个 turn
8. `ls --range T2..T3` 输出 T2 和 T3
9. `ls --grep keyword` 只输出匹配的 turn
10. `show T2` 输出完整消息序列
11. `show T2 --no-tool-result` tool_result 显示为 `(omitted)`
12. `grep keyword` 返回匹配的 turn + message

---

## Files Modified

| File | Change |
|---|---|
| `src/replay/parser.ts` | Turn parser — 基于 transcript-parser 扩展 |
| `src/shared/transcript-parser.ts` | 最小扩展：normalizeEntry 补充 timestamp/usage/duration |
| `src/replay/commands/ls.ts` | ls 子命令 |
| `src/replay/commands/show.ts` | show 子命令 |
| `src/replay/commands/grep.ts` | grep 子命令 |
| `src/replay/cli.ts` | CLI 入口 |
| `scripts/build.js` | 新增 replay-parse.cjs entrypoint |
| `plugin/skills/mnemo-replay` | Skill 内容重写 |
| `tests/replay/parser.test.ts` | Parser 测试 |
| `tests/replay/commands.test.ts` | 子命令测试 |
| `plugin/scripts/replay-parse.cjs` | Build 产物 |

---

## Non-goals

- 不替代 timeline MCP tool（timeline 是结构化分析视图，replay-parse 是原始日志浏览）
- 不替代 recall（recall 是语义索引，replay-parse 是行级扫描）
- 不做 JSONL 写入/修改
- 不解析 `file-history-snapshot`（文件快照与 turn 分析无关）
- 不做跨文件搜索（单文件 scope）
