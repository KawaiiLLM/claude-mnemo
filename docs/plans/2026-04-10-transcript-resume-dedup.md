# Spec: Transcript Resume 去重 + 派生 Entry 过滤

## Context

Claude Code 在 `--continue` / `--resume` 时会把历史 entry **按原样再次追加**到 session 的 JSONL transcript 文件末尾。对一个 resume 过 N 次的 session，文件规模约是 `(N+1) × 原始条数`，且每条重复 entry 的 `uuid / parentUuid / timestamp / promptId / message` 全部保留原值——这是字面意义上的"重放追加"，不是 branch、不是 edit、不是 bug。

### 实测数据

| Session | 总条数 | 去重后 | 重复倍数 | 去重前 pid 复用率 | 去重后 pid 复用率 |
|---|---|---|---|---|---|
| claude-mem `68393c63` | 19926 | 8974 | **2.22x** | 766 / 1606 (48%) | 2 / 842 (0.2%) |
| ustcthesis `475a7a11` | 3270 | 1619 | **2.02x** | 90 / 239 (38%) | 1 / 135 (0.7%) |
| KawaiiLLM `7dd170f9` | 6065 | 5440 | **1.11x** | 5 / 173 (3%) | 5 / 173 (3%) |

前两个 session 各 resume 过 ~2 次，去重后 pid 复用率从 ~40% 垮到 ~0%。**KawaiiLLM 几乎没 resume，但仍有 3% 的 pid 复用且去重前后不变**——这暴露出第二个独立问题：**真实的 pid 共享**。

### Root cause：两个叠加的问题

#### Problem 1：文件级重放（resume append）
- **现象**：同 `uuid` entry 出现多次，所有字段逐字一致
- **解法判据**：`uuid` 是 entry 的**全局唯一 ID**，同 uuid 只能保留第一次出现
- **为什么不能用 parentUuid / promptId / sessionId**：parentUuid 区分不出"合法分支的兄弟"和"重放"；promptId 本身就被多条 entry 合法共享；sessionId 粒度太粗

#### Problem 2：真实的派生 entry 共享 pid
- **现象**：`uuid` 不同但 `promptId` 相同，content 是 slash-command / system-injected 文本
- **来源**：
  - `<command-name>` / `<command-args>` / `<command-message>` —— slash command 注入的 entry
  - `<local-command-stdout>` —— slash command 本地执行结果
  - `⏺ Ran N stop hooks...` —— hook 执行状态反馈
  - `<task-notification>` —— 已有过滤
- **性质**：这些 entry 是同一个 user turn 的"派生物"，不是新 turn 的开始，当成 turn 边界会把一个 turn 切碎
- **解法判据**：基于 `content` 前缀的系统注入过滤

### 两个问题叠加导致的观察现象

之前一直以为"promptId 作为 turn 边界不可靠"——**错**。promptId 语义一直是干净的，只是：
1. 重放让同 pid 在文件里反复出现（Problem 1）
2. 派生 entry 让不同 uuid 共享 pid（Problem 2）

**去重 + 过滤**两层处理后，promptId 变化**就是** turn 边界的充分必要条件。

### 影响面（当前 bug 的实际表现）

| 路径 | 症状 |
|---|---|
| `parseTranscript` | resume 序列 `[A, B, A, B]` 产生 4 个 turn 而不是 2 个 |
| `parseReplayTranscript` | 同上 + tool_result 匹配错位 |
| `backfill.ts:51` `toolCallCount = transcriptTurn.toolCalls.length` | resume 2 次 → `tool_call_count` 膨胀 2x |
| `extractAssistantResponse` | prefix 匹配命中第一个（可能是旧的重放副本） |
| `markSidechainTurnsUndone` (worker) | pid IN list 含 dup，对 SQL 无害但语义混乱 |
| `mcp/replay.ts` | 用户面向的 replay 输出包含重复 turn + 重复 tool 调用 |
| `countUserPromptsInTranscript` | **已有** `Set<string>` 防护（`transcript-parser.ts:344-361`），不受影响。session-init 的 `promptNumber` 计算因此侥幸正确 |

**关键观察**：DB 侧有 `UNIQUE(session_id, prompt_number)` + `UNIQUE(session_id, content_prompt_id) WHERE NOT NULL` 两道锁，resume **不会**造成 DB 里出现重复 turn 行。问题完全集中在**解析输出被污染**——backfill 写回 DB 的统计值膨胀、replay 的展示输出重复、sidechain 检测的判据扰动。

---

## 核心约束

- **修复顺序不能反**：先按 uuid 去重 → 再按 content 过滤派生 entry → 最后用 promptId 变化识别 turn 边界
- **派生过滤要覆盖 block-array**：真实 transcript 的 user entry 几乎全部是 `message.content = [{type:"text", ...}]` 形态；单纯扩 `isKnownSystemInjectedContent` 的前缀列表不够，还必须把调用入口从"只检查 pure string content"改成"检查 `extractUserPrompt` 抽取结果"（§1.5）
- **单点上游修复**：改动全部集中在 `src/shared/transcript-parser.ts`，7 个下游消费点一律不动，自动受益
- **promptId 语义不动**：去重后 `startsNewTurn` 的逻辑完全保留
- **向后兼容**：无 `uuid` 字段的 entry（老 fixture、手写测试数据）透传不去重
- **不做历史数据清洗**：本 spec 只修**新的解析路径**，旧 DB 里可能存在的 `tool_call_count` 膨胀值留给独立的 data migration 任务

---

## Changes

### 1. `src/shared/transcript-parser.ts` —— 唯一需要改动的文件

#### 1.1 `RawTranscriptEntry` / `TranscriptEntry` 增加 `uuid` 字段

`transcript-parser.ts:10-19` + `:45-54`：

```typescript
interface TranscriptEntry {
  type?: string;
  role?: string;
  content?: TranscriptContentBlock[] | string;
  promptId?: string;
  permissionMode?: string;
  isSidechain?: boolean;
  isApiErrorMessage?: boolean;
  uuid?: string;             // NEW
}

interface RawTranscriptEntry {
  type?: unknown;
  role?: unknown;
  content?: unknown;
  message?: unknown;
  promptId?: unknown;
  permissionMode?: unknown;
  isSidechain?: unknown;
  isApiErrorMessage?: unknown;
  uuid?: unknown;            // NEW
}
```

#### 1.2 `normalizeEntry` 提取 uuid

`transcript-parser.ts:182-211`，`return` 对象加一行：

```typescript
uuid: typeof raw.uuid === "string" ? raw.uuid : undefined,
```

#### 1.3 `readAllTranscriptEntries` 按 uuid 去重

`transcript-parser.ts:162-180`，在现有 `.map(normalizeEntry)` 和 `.filter(isApiErrorMessage)` 链尾追加 dedupe 步骤。**顺序重要**：在 `isApiErrorMessage` 过滤之后 dedupe，避免被过滤掉的 entry 的 uuid 白占 Set 容量。

```typescript
export function readAllTranscriptEntries(transcriptPath: string): TranscriptEntry[] {
  if (!existsSync(transcriptPath)) {
    return [];
  }

  const rawTranscript = readFileSync(transcriptPath, "utf8");

  if (rawTranscript.trim() === "") {
    return [];
  }

  const entries = rawTranscript
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => normalizeEntry(JSON.parse(line) as RawTranscriptEntry))
    .filter((entry) => !entry.isApiErrorMessage);

  const seenUuids = new Set<string>();
  const deduped: TranscriptEntry[] = [];
  for (const entry of entries) {
    if (entry.uuid) {
      if (seenUuids.has(entry.uuid)) {
        continue;
      }
      seenUuids.add(entry.uuid);
    }
    deduped.push(entry);
  }

  return deduped;
}
```

**设计决策**：没 uuid 的 entry 透传不去重。原因：
- 老 fixture / 手写 JSONL 没 uuid 字段，透传保证向后兼容
- 真实 Claude Code 产生的 entry 一定有 uuid，所以生产场景无 escape hatch 风险

#### 1.4 `isKnownSystemInjectedContent` 扩充派生 entry 前缀

`transcript-parser.ts:84-90`：

```typescript
function isKnownSystemInjectedContent(content: string): boolean {
  return (
    content.startsWith("<task-notification>") ||
    content.startsWith("<local-command-") ||
    content.startsWith("<command-name>") ||
    content.startsWith("<command-args>") ||      // NEW
    content.startsWith("<command-message>") ||   // NEW
    content.startsWith("⏺ Ran ")                 // NEW — stop hook status line
  );
}
```

**Encoding 注意**：`⏺` 是 U+25CF (BLACK CIRCLE)，不是 ASCII。TypeScript 源文件必须保存为 UTF-8，build 管道 (esbuild) 天然支持。测试 fixture 构造时确保字符一致。

**不加的前缀**（列出来是为了防止误加）：
- `<system-reminder>` —— 已在 `normalizeAssistantText` 里 strip（`transcript-parser.ts:56-62`），且 reminder 出现在 assistant 文本内不是 user entry
- `<user-prompt-submit-hook>` —— 这是 hook 反射的 user prompt 增强内容，是合法 user 输入的一部分，不能过滤

#### 1.5 `isRealUserPrompt` 修到 block-array 路径

**这是 round 1 漏掉的一层**。`transcript-parser.ts:92-102` 当前实现：

```typescript
function isRealUserPrompt(entry: TranscriptEntry): boolean {
  if (entry.permissionMode) {
    return true;
  }

  if (typeof entry.content === "string" && isKnownSystemInjectedContent(entry.content)) {
    return false;
  }

  return extractUserPrompt(entry) !== "";
}
```

**Bug**：`isKnownSystemInjectedContent` 只在 `typeof entry.content === "string"` 时才被调用。而真实 Claude Code transcript 的 user entry `message.content` **通常是 block array**（`{type: "text", text: "..."}` 数组）——`extractUserPrompt` `:68-78` 正是靠遍历 text blocks 才能拿到字符串。按当前实现，`<command-args>...</command-args>` / `⏺ Ran 2 stop hooks...` 等派生内容只要出现在 block array 的 text block 里，就会绕过过滤、被当成真实 user prompt 计入。

单独扩 `isKnownSystemInjectedContent` 的前缀列表**不能**修这个 bug，必须同时修调用入口。

**修法**：把系统注入检查从"只检查纯 string content"改成"检查 `extractUserPrompt` 抽取出的文本"。`extractUserPrompt` 本身已经处理了两种 content 形态（string 和 block array），把它的输出当作判据即可：

```typescript
function isRealUserPrompt(entry: TranscriptEntry): boolean {
  if (entry.permissionMode) {
    return true;
  }

  const text = extractUserPrompt(entry);
  if (text === "") {
    return false;
  }

  if (isKnownSystemInjectedContent(text)) {
    return false;
  }

  return true;
}
```

**重要的语义变化**：
- 之前：`permissionMode` 存在 → 永远返回 true（无论 content 是什么）。保留这个行为
- 之前：block-array 的 `<command-*>` / `⏺ Ran` → 漏网，计数。**修后**：被拦
- 之前：pure string 的 `<command-*>` → 拦住。**修后**：同样拦住（语义不变）
- 之前：空 content → 返回 false。**修后**：空 text 同样返回 false（语义不变）

**边界情况 1 —— 多 text block 混合**：如果一个 entry 的 block array 包含 `[{type:"text", text:"real prompt"}, {type:"text", text:"⏺ Ran 2 stop hooks"}]`，`extractUserPrompt` 会 join 为 `"real prompt\n⏺ Ran 2 stop hooks"`，`startsWith("⏺ Ran ")` 返回 false → **保留为 real prompt**。反向情况（`⏺ Ran` 在前、real prompt 在后）在真实 Claude Code 行为下**不会发生**——派生 entry 是独立的 transcript 记录，不会和用户输入混装到同一个 entry 的 content 里。这个假设在测试用例 C 里验证。

**边界情况 2 —— tool_result 伪装成 text block**：user entry 有时承载 tool_result 块（`{type:"tool_result", ...}`），`extractUserPrompt` 的 `filter(block => block.type === "text")` 会自动跳过，join 后可能是空字符串 → 走 `text === ""` 分支返回 false。行为与修复前一致。

**边界情况 3 —— system-reminder 内嵌**：如果 user 的 text block 内容是 `"<system-reminder>...</system-reminder>\n\nreal question"`，`extractUserPrompt` 直接 trim 返回整段，`startsWith("<system-reminder")` 不在 `isKnownSystemInjectedContent` 列表里（spec 第 1.4 节明确不加），所以保留为 real prompt。这是对的——system-reminder 不等于派生 entry，只是附加元数据。

#### 1.6 `countUserPromptsInTranscript` 的 pid Set 保留

`transcript-parser.ts:344-371` 里已有的 `Set<string>` 去重经过新 `readAllTranscriptEntries` 后成为**冗余但不冲突**的二次保护。**保留不动**，作为 defense-in-depth：如果未来 reader dedupe 有 escape hatch，这层兜底仍然有效。

### 2. 下游消费者审计（全部不改）

| 调用点 | 调用函数 | 为什么不用改 |
|---|---|---|
| `parseTranscript` (本文件 :220) | `readTranscriptEntries` → `readAllTranscriptEntries` | reader 已去重，startsNewTurn 在清洁序列上正确 |
| `parseReplayTranscript` (本文件 :267) | `readAllTranscriptEntries` | 同上 + tool_result 匹配依赖 in-turn 顺序，dedupe 保序 |
| `extractAssistantResponse` (本文件 :370) | `parseTranscript` | prefix 匹配在清洁 turn 列表上唯一命中 |
| `hooks/backfill.ts:22` | `parseReplayTranscript` | `toolCallCount` 自动恢复正确 |
| `hooks/handlers/stop.ts:124` `extractAssistantResponse` | `parseTranscript` | orphan turn 的 assistant response 查找自动正确 |
| `worker/server.ts:163` `markSidechainTurnsUndone` | `parseReplayTranscript` | IN list 不再含 dup pid |
| `mcp/replay.ts:312` | `parseReplayTranscript` | 用户可见输出自动去重 |
| `hooks/handlers/session-init.ts:59` `countUserPromptsInTranscript` | `readAllTranscriptEntries` | 双重防护，行为不变 |

**下游零改动**是这次修复最关键的特点——1 个文件、~20 行代码，自动修复 7 个下游路径。

### 3. 测试

新增 `tests/shared/transcript-parser.test.ts`（如果已有则在内补用例）。所有 fixture 用行内字符串，避免外部 JSONL 依赖。

#### 3.1 用例 A：uuid 去重

```typescript
const jsonl = [
  makeEntry({ uuid: "u1", role: "user", content: "hello" }),
  makeEntry({ uuid: "u2", role: "assistant", content: "hi" }),
  makeEntry({ uuid: "u1", role: "user", content: "hello" }),  // dup
].join("\n");

// 预期：readAllTranscriptEntries 返回 2 条（u1, u2），u1 只保留第一次
```

#### 3.2 用例 B：resume 重放的 turn 边界

```typescript
// 模拟 resume：[pid=A user, pid=A assistant, pid=B user, pid=B assistant] ×2
const jsonl = buildResumeFixture(["A", "B"], { repeat: 2 });

// 预期：
//   parseTranscript(fixture).length === 2（不是 4）
//   turn[0].promptNumber === 1 && turn[0].userPrompt 来自 pid=A
//   turn[1].promptNumber === 2 && turn[1].userPrompt 来自 pid=B
```

#### 3.3 用例 C：派生 entry 过滤（string content 路径）

三个子用例，每个构造一条合法 user prompt + 一条派生 entry（共享同一 pid），content 用 **pure string** 形态：

```typescript
const cases = [
  { derived: "<command-args>foo bar</command-args>" },
  { derived: "<command-message>slash command</command-message>" },
  { derived: "⏺ Ran 2 stop hooks in 120ms" },
];

for (const { derived } of cases) {
  const jsonl = [
    makeEntry({ uuid: "u1", role: "user", promptId: "pA", content: "real prompt" }),
    makeEntry({ uuid: "u2", role: "user", promptId: "pA", content: derived }),
  ].join("\n");

  // 预期：parseTranscript 返回 1 个 turn，userPrompt === "real prompt"
}
```

#### 3.3b 用例 C2：派生 entry 过滤（block-array content 路径，新增）

**这是 round 1 漏掉的覆盖**。真实 Claude Code transcript 的 user entry 几乎全部是 `message.content = [{type:"text", text:"..."}]` 形态，必须单独覆盖。对每个派生 content 构造 block-array 版本：

```typescript
const cases = [
  "<command-args>foo bar</command-args>",
  "<command-message>slash command</command-message>",
  "⏺ Ran 2 stop hooks in 120ms",
];

for (const derived of cases) {
  const jsonl = [
    // real user prompt in block-array form
    makeEntry({
      uuid: "u1",
      role: "user",
      promptId: "pA",
      message: { role: "user", content: [{ type: "text", text: "real prompt" }] },
    }),
    // derived entry in block-array form (同一 pid)
    makeEntry({
      uuid: "u2",
      role: "user",
      promptId: "pA",
      message: { role: "user", content: [{ type: "text", text: derived }] },
    }),
  ].join("\n");

  // 预期：parseTranscript 返回 1 个 turn，userPrompt === "real prompt"
  //       countUserPromptsInTranscript === 1
}
```

**这条测试是 1.5 节 `isRealUserPrompt` 修复的直接验证**。如果只扩 `isKnownSystemInjectedContent` 的前缀但不改 `isRealUserPrompt` 的调用入口，这条测试会失败（返回 2 个 turn）。

#### 3.4 用例 D：countUserPromptsInTranscript 在 resume 场景下不双计

```typescript
const jsonl = buildResumeFixture(["A", "B", "C"], { repeat: 2 });

// 预期：countUserPromptsInTranscript === 3
```

#### 3.5 用例 E：backfill 的 tool_call_count 不膨胀

在 `tests/hooks/backfill.test.ts`（或 stop.test.ts）新增：

```typescript
// Fixture: pid=A 含 3 个 tool_use，整段重复 2 次
// 调用 backfillFromTranscript 后：
//   updateTurnBackfill 的 toolCallCount 参数 === 3（不是 6）
```

#### 3.6 回归保障

- `tests/shared/transcript-parser.test.ts` 原有用例全部 pass
- `tests/hooks/stop.test.ts`、`tests/hooks/post-tool-use.test.ts`、`tests/worker/server.test.ts` 全部 pass
- `tests/mcp/replay.test.ts`（如有）全部 pass

### 4. 构建

```bash
npm run build
```

`src/shared/transcript-parser.ts` 会被 inlined 进 `plugin/scripts/hook-command.cjs`、`plugin/scripts/worker.cjs`、`plugin/scripts/mcp-server.cjs` 三个产物。

---

## 实施顺序

所有改动都在 1 个 commit 完成，不需要分阶段：

1. `src/shared/transcript-parser.ts`：
   - 加 `uuid` 字段到 `TranscriptEntry` / `RawTranscriptEntry`（§1.1）
   - `normalizeEntry` 提取 uuid（§1.2）
   - `readAllTranscriptEntries` 尾部 dedupe（§1.3）
   - `isKnownSystemInjectedContent` 扩前缀到 6 个（§1.4）
   - **`isRealUserPrompt` 改造**：改用 `extractUserPrompt` 输出作判据，覆盖 block-array 路径（§1.5）
2. `tests/shared/transcript-parser.test.ts`：6 个新用例（A uuid dedupe、B resume 重放 turn 边界、C string-content 派生过滤、**C2 block-array 派生过滤**、D countUserPrompts 不双计、E backfill tool_call_count 在 backfill 测试文件）
3. `bun test`：确认新用例 + 全量回归通过
4. `npm run typecheck`：确认
5. `npm run build`：刷新产物

---

## Verification

1. **单元测试**：`bun test` 全绿，新用例精确覆盖 uuid 去重、resume 重放、派生过滤三条路径
2. **类型检查**：`npm run typecheck` 通过
3. **人工抽样**：拿一个已知 resume 过的真实 transcript（e.g. 数据表里 claude-mem `68393c63`），验证
   - `parseTranscript(transcriptPath).length` ≈ 真实用户提问次数（而不是 2.22x）
   - `countUserPromptsInTranscript(transcriptPath)` 与 `parseTranscript(...).length` 一致
   - `parseReplayTranscript(transcriptPath).reduce((n, t) => n + t.toolCalls.length, 0)` 不膨胀

---

## Risks & Notes

- **存量 DB 里的膨胀统计**：旧 session（被 resume 过的）里的 `turns.tool_call_count` 可能已经写入了 2x 值。本 spec **不做回溯清理**。清理是独立 data migration 任务，触发时机可以是"用户发现数字明显不对 → 补一次 backfill 扫描"。影响面仅限观感，不影响 worker 运行时正确性
- **`⏺` 字符的真实形态**：spec 里写的是 U+25CF。建议实施时先用 `rg -l '⏺ Ran'` 在 `~/.claude/projects/*/`*.jsonl 快速抓一条真实样本，复制 literal 进代码，避免同形近码点踩坑
- **Sidechain 检测不受影响**：`worker/server.ts:markSidechainTurnsUndone` 依赖 `isSidechain` flag（reader 已带），且 DB 侧的 `IN (...)` 对 dup 参数不敏感
- **`NormalizedHookInput` 不带 promptId**：`src/hooks/types.ts:8-22` 当前 UserPromptSubmit 时机拿不到 pid，所以 session-init 仍然只能用 `prompt_number` 作为幂等 key。本 spec **不引入** pid-at-creation-time，留给未来的独立任务（需要先在 `adapters/claude-code.ts` 里从 `raw` 抽取 `prompt_id` 字段——需要验证 Claude Code 的 UserPromptSubmit hook 载荷里是否携带）
- **`seenUuids` 内存占用**：对一个 ~20000 行的 transcript，Set 容纳 ~10000 个 36 字符 UUID ≈ 400KB，单次调用作用域内 GC 友好，无持久化泄漏
- **不改 `countUserPromptsInTranscript` 的 pid Set**：虽然 reader 去重后这层是冗余的，保留它作为二次防护

---

## Out of Scope

- 不改 `session-init.ts` 的 turn 创建逻辑
- 不改 `content_prompt_id` 的 schema 或索引
- 不做历史 DB 数据清洗
- 不动 worker 侧的 sidechain 检测逻辑（已容忍 IN list dup）
- 不扩展 `NormalizedHookInput` 加 promptId（独立任务）
- 不修改 `parseTranscript` / `parseReplayTranscript` 的消费逻辑（dedupe 单点修复到位）
