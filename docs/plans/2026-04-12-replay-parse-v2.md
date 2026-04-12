# replay-parse v2: Schema-Driven Query

**Goal**: 替代 v1 的固定子命令（ls/show/grep），改为 schema discovery + field selection query。Agent 只拉需要的字段，每个字段独立控制截断，最大化上下文信噪比。

**入口**: `plugin/scripts/replay-parse.cjs`（复用 v1 的 parser 和 build 产物）

**调用方式**:
```bash
replay-parse schema <jsonl>
replay-parse query <jsonl> [filters] -f "field1:cap,field2:cap,..."
```

**依赖**: 复用 `src/shared/transcript-parser.ts` + `src/replay/parser.ts`（v1 已实现）。

---

## 设计动机

v1 的 `ls --all --usage` 对 50 个 turn 输出 ~6000 chars，但如果 agent 只想看 token 经济性，90% 是噪声。根本原因：固定输出格式无法适配不同问题。

v2 的核心改变：
- **Agent 自选字段** — 只拉需要的列
- **Per-field 截断** — `userPrompt:80` vs `assistantText:200` vs `usage.output`（数值无需截断）
- **一次 schema 调用** — Agent 理解可用字段后，后续 query 零认知负荷

---

## Locked Decisions

**D1**: `schema` 输出字段列表 + 类型 + 样本值 + 描述。这是 agent 理解数据模型的唯一入口。

**D2**: `query` 的 `-f` 参数格式为 `field:cap,field:cap,...`。cap 为正整数表示字符截断，0 表示不截断，省略 cap 则用默认值（string 120, number 不截断）。

**D3**: 输出格式为 **TSV**（tab-separated）。首行是字段名 header，后续每行一个 turn。String 字段值在输出前做 escaping：`\n` → `\\n`，`\t` → `\\t`，确保每行严格对应一个 turn。这样 agent 可以安全地按行分割 + 按 tab 分列。截断发生在 escaping 之后（即 cap 计数的是 escaped 后的字符数）。

**D4**: 过滤语法保持最简：`--last N`、`--first N`、`--range T5..T10`、`--all`、`--grep pattern`。不做通用 WHERE 表达式——复杂度收益比太低。

**D5**: 保留 `show` 子命令用于单 turn drill-down（展开完整消息序列）。Schema + query 覆盖列表/统计场景，show 覆盖深钻场景。

**D6**: `schema` 的样本值从文件的前 3 个 turn 中取，截断到 60 字符。如果文件为空，标注 `(empty file)`。

**D7**: 字段名用 dot notation 访问嵌套（`usage.input`、`usage.output`）。顶层字段直接用名字。

**D8**: 新增派生字段：`toolCount`（tool_use 数量）、`readCount`（Read 工具数量）、`editCount`（Edit/Write 数量）、`toolNames`（去重工具名列表）。这些在 parser 已有数据基础上简单计算。

**D9**: Compact boundary 不作为特殊行插入 TSV——会破坏 "header + N rows" 的纯表格契约。改为在字段注册表中新增 `compactAfter` 布尔字段（该 turn 之后有 compact boundary 时为 `1`，否则为 `0`）和 `compactInfo` string 字段（`"357k tokens, manual"` 或空）。Agent 通过 `-f` 选择这些字段来查看 compact 信息，不需要特殊行。`schema` 子命令的 summary 行仍然显示 compact 计数。

---

## Subcommand: `schema`

### 用法

```bash
replay-parse schema <jsonl>
```

### 输出

```
52 turns | 0 compacts | 2026-04-12 17:19 → 17:43 (24m)

Fields:
  promptNumber    number    1, 2, 3                          Turn number (= recall/timeline T<n>)
  lineStart       number    3, 8, 13                         JSONL 1-based line number
  localTime       string    "17:19", "17:19", "17:22"        Local time HH:MM
  timestamp       string    "2026-04-12T09:19:47..."         ISO timestamp
  durationMs      number    0, 0, 0                          Turn duration in ms
  userPrompt      string    "<session id=\"S102\">..."       Full user prompt text
  assistantText   string    "", "", ""                        Assistant text blocks concatenated
  toolCount       number    1, 1, 1                          Total tool_use calls in turn
  readCount       number    0, 0, 0                          Read tool calls
  editCount       number    0, 0, 0                          Edit/Write tool calls
  toolNames       string    "remember", "remember", ...      Unique tool names (comma-sep)
  usage.input     number    3, 3, 6                          Input tokens
  usage.output    number    192, 76, 267                     Output tokens
  usage.cacheRead number    19489, 20858, 42496              Cache read tokens
  usage.cacheCr   number    0, 0, 0                          Cache creation tokens
  messageCount    number    3, 3, 3                          Raw message count in turn
  compactAfter    number    0, 0, 0                          1 if compact follows this turn
  compactInfo     string    "", "", ""                        Compact metadata or empty

Usage: replay-parse query <jsonl> -f "promptNumber,localTime,userPrompt:80" --last 10
```

schema 末尾附一行示例 query，降低 agent 的首次使用门槛。

---

## Subcommand: `query`

### 用法

```bash
replay-parse query <jsonl> -f "field:cap,..." [filters]
```

### 示例

```bash
# Token 经济性分析 — 只要数值字段
replay-parse query session.jsonl -f "promptNumber,usage.input,usage.output,usage.cacheRead" --all

# Turn 概览 — prompt 截断到 60 字符
replay-parse query session.jsonl -f "promptNumber,localTime,toolCount,userPrompt:60" --last 20

# 搜索含 "codex" 的 turn — 只返回匹配行
replay-parse query session.jsonl -f "promptNumber,localTime,userPrompt:80" --grep codex

# 深入某些 turn 的 assistant 回复
replay-parse query session.jsonl -f "promptNumber,assistantText:200" --range T5..T6

# 完整 prompt 不截断
replay-parse query session.jsonl -f "promptNumber,userPrompt:0" --range T13..T13
```

### 输出格式（TSV，string 已 escape）

```
promptNumber	localTime	toolCount	userPrompt
1	17:19	1	<session id="S102">\n  project: /Users/zhaoqixuan/Projects/KawaiiLLM\n  user_request…
2	17:19	1	<obs id="O343">\n  🔧 ToolSearch\n  in: {"query":"select:AskUserQuestion"…
3	17:22	1	<obs id="O345">\n  🔧 Bash\n  in: {"command":"node \\"/Users/zhaoqixuan/.c…
```

每行严格一个 turn。String 中的 `\n` `\t` 已转义为字面 `\\n` `\\t`，agent 按行分割 + tab 分列安全。

### Filters

| Flag | Description |
|---|---|
| `--last N` | 最后 N 个 turn（默认 30） |
| `--first N` | 前 N 个 turn |
| `--range T<a>..T<b>` | 闭区间 |
| `--all` | 全部 |
| `--grep <pattern>` | 全文搜索：userPrompt + assistantText + tool_use input + tool_result content + toolNames。覆盖 turn 内所有可见文本内容，与 v1 grep 的搜索范围一致 |
| `-i` | grep 忽略大小写 |

---

## Subcommand: `show`（保留，微调）

单 turn drill-down，展开完整消息序列。保留 v1 设计，新增 `-f` 对输出做最小裁剪：

```bash
# 完整消息序列（默认）
replay-parse show <jsonl> T12

# 只看 tool 调用，不看 tool_result 内容
replay-parse show <jsonl> T12 --no-tool-result

# 含 thinking blocks
replay-parse show <jsonl> T12 --thinking
```

---

## Implementation

### Task 1: 字段注册表

**文件**: `src/replay/fields.ts`

```typescript
interface FieldContext {
  compactAfterSet: Set<number>;                    // promptNumbers that have a compact boundary after them
  compactInfoMap: Map<number, string>;             // promptNumber → "357k tokens, manual"
}

interface FieldDef {
  name: string;               // "promptNumber", "usage.input", etc.
  type: "number" | "string";
  description: string;
  extract: (turn: ReplayParseTurn, ctx: FieldContext) => string | number;
  defaultCap?: number;        // string fields default to 120, numbers undefined
}

const FIELD_REGISTRY: FieldDef[] = [
  { name: "promptNumber", type: "number", description: "Turn number (= recall/timeline T<n>)", extract: t => t.promptNumber },
  { name: "lineStart", type: "number", description: "JSONL 1-based line number", extract: t => t.lineStart },
  { name: "localTime", type: "string", description: "Local time HH:MM", extract: t => t.localTime, defaultCap: 5 },
  { name: "timestamp", type: "string", description: "ISO timestamp", extract: t => t.timestamp ?? "" },
  { name: "durationMs", type: "number", description: "Turn duration in ms", extract: t => t.durationMs ?? 0 },
  { name: "userPrompt", type: "string", description: "Full user prompt text", extract: t => t.userPrompt, defaultCap: 120 },
  { name: "assistantText", type: "string", description: "Assistant text blocks concatenated", extract: t => t.assistantText, defaultCap: 120 },
  { name: "toolCount", type: "number", description: "Total tool_use calls", extract: t => t.toolCalls.length },
  { name: "readCount", type: "number", description: "Read tool calls", extract: t => t.toolCalls.filter(c => c.name.includes("Read") || c.name.includes("read")).length },
  { name: "editCount", type: "number", description: "Edit/Write tool calls", extract: t => t.toolCalls.filter(c => /Edit|Write|edit|write/.test(c.name)).length },
  { name: "toolNames", type: "string", description: "Unique tool names (comma-sep)", extract: t => [...new Set(t.toolCalls.map(c => c.name))].join(","), defaultCap: 80 },
  { name: "usage.input", type: "number", description: "Input tokens", extract: t => t.usage.inputTokens },
  { name: "usage.output", type: "number", description: "Output tokens", extract: t => t.usage.outputTokens },
  { name: "usage.cacheRead", type: "number", description: "Cache read tokens", extract: t => t.usage.cacheReadTokens },
  { name: "usage.cacheCr", type: "number", description: "Cache creation tokens", extract: t => t.usage.cacheCreationTokens },
  { name: "messageCount", type: "number", description: "Raw message count in turn", extract: t => t.messages.length },
  { name: "compactAfter", type: "number", description: "1 if compact boundary follows this turn, 0 otherwise", extract: (t, ctx) => ctx.compactAfterSet.has(t.promptNumber) ? 1 : 0 },
  { name: "compactInfo", type: "string", description: "Compact metadata (e.g. '357k tokens, manual') or empty", extract: (t, ctx) => ctx.compactInfoMap.get(t.promptNumber) ?? "", defaultCap: 60 },
];
```

### Task 2: `-f` 解析器

**文件**: `src/replay/fields.ts`（同文件）

```typescript
interface SelectedField {
  def: FieldDef;
  cap: number | null;  // null = no truncation (numbers, or explicit :0)
}

function parseFieldSpec(spec: string): SelectedField[]
// "promptNumber,userPrompt:80,usage.output" →
// [{ def: promptNumberDef, cap: null }, { def: userPromptDef, cap: 80 }, { def: usageOutputDef, cap: null }]
```

### Task 3: `schema` 子命令

**文件**: `src/replay/commands/schema.ts`

1. 调用 `parseReplayFile` 获取 result
2. 输出 summary 行（turns | compacts | time range）
3. 遍历 `FIELD_REGISTRY`，取前 3 个 turn 的值作为样本
4. 格式化为对齐表格
5. 末尾输出示例 query

### Task 4: `query` 子命令

**文件**: `src/replay/commands/query.ts`

1. 解析 `-f` 参数 → `SelectedField[]`
2. 调用 `parseReplayFile` + filter（last/first/range/grep）
3. 构造 `FieldContext`（从 `compacts[]` 构建 `compactAfterSet` 和 `compactInfoMap`）
4. 对每个 turn 的每个选中字段调用 `extract(turn, ctx)`
5. String 值 escape：`\n` → `\\n`，`\t` → `\\t`
6. 按 `cap` 截断 escaped 后的字符串（追加 `…`），number 不截断
7. 输出 TSV header + data rows，纯表格，无特殊行

### Task 5: CLI 入口更新

**文件**: `src/replay/cli.ts`

保留 `show`，替换 `ls`/`grep` 为 `schema`/`query`。

### Task 6: 测试

**文件**: `tests/replay/query.test.ts`

1. `schema` 输出包含所有注册字段（含 compactAfter、compactInfo）
2. `query -f "promptNumber,toolCount" --last 2` 输出 2 行 TSV
3. `query -f "userPrompt:20"` 截断到 20 字符 + `…`
4. `query -f "usage.input,usage.output" --all` 数值字段不截断
5. `query -f "promptNumber" --grep keyword` 只返回匹配行
6. `query -f "promptNumber,userPrompt:0"` cap=0 不截断
7. `query` string escaping — userPrompt 含换行时输出 `\\n`，每行严格一个 turn
8. `query --grep` 搜索范围覆盖 tool_use input 和 tool_result content（不只 userPrompt + assistantText）
9. `query -f "compactAfter,compactInfo"` — compact boundary 后的 turn 标记正确

### Task 7: Build + Skill 更新

Skill 内容改为：
```
1. 运行 `replay-parse schema <jsonl>` 了解可用字段
2. 按需组合 `replay-parse query <jsonl> -f "field:cap,..." [filters]`
3. 深钻单 turn：`replay-parse show <jsonl> T<n>`
```

---

## 上下文效率对比

同一个 "token 经济性" 问题：

**v1 (`ls --all --usage`)**: ~6000 chars，52 行 turn 概览 + prompt preview + usage 列

**v2 (`query -f "promptNumber,usage.input,usage.output,usage.cacheRead" --all`)**: ~1200 chars

```
promptNumber	usage.input	usage.output	usage.cacheRead
1	3	192	19489
2	3	76	20858
3	6	267	42496
...
52	6	114	110674
```

**5x 压缩**，零噪声。

---

## Files Modified

| File | Change |
|---|---|
| `src/replay/fields.ts` | 字段注册表 + `-f` 解析器 |
| `src/replay/commands/schema.ts` | schema 子命令 |
| `src/replay/commands/query.ts` | query 子命令 |
| `src/replay/commands/ls.ts` | 删除（被 query 替代） |
| `src/replay/commands/grep.ts` | 删除（被 query --grep 替代） |
| `src/replay/cli.ts` | 更新子命令分发 |
| `plugin/skills/mnemo-replay/SKILL.md` | Skill 内容重写 |
| `tests/replay/query.test.ts` | 新测试 |
| `tests/replay/commands.test.ts` | 删除旧测试 |

---

## Non-goals

- 不做通用 WHERE 表达式（`--grep` + `--range` 足够）
- 不做聚合函数（SUM/AVG）——agent 可以自己从 TSV 算
- 不改 show 子命令的消息序列格式
- 不改 parser 层（v1 的 parser 完全复用）
