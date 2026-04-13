# Transcript Dedup: Last-Wins

**Goal**: 修复 `readAllTranscriptEntries()` 的 uuid 去重策略，从 first-wins 改为 last-wins，确保保留 streaming response 的最终态而非中间态。

**影响范围**: `src/shared/transcript-parser.ts`（`readAllTranscriptEntries`），所有依赖该函数的读路径。

---

## 问题分析

Claude Code 在 JSONL 中对同一个 uuid 可能写入多条 entry，有两种场景：

### 场景 1: Streaming snapshot（中间态 → 最终态）

```
L1871  uuid=4e89... out=18   stop=None      ← 中间态（stream 刚开始）
L2986  uuid=4e89... out=148  stop=tool_use  ← 最终态（stream 完成）
```

当前 first-wins 保留 L1871（中间态），丢弃 L2986（最终态）。导致：
- output tokens 低估（18 vs 148）
- content 不完整（可能只有 thinking block 开头）
- stop_reason 丢失（None vs tool_use）

### 场景 2: Resume replay（完整态被重复写入）

CC 恢复 session 时将早期消息重新写入 JSONL。同一个 uuid 出现 N 次，内容一致（或第一次是中间态，后续是完整态）。

实测数据（942 个 JSONL 文件）：
- 4 个文件有 uuid 重复（最高 8316 个重复 uuid）
- 其中仅 83 个有 output tokens 差异（streaming snapshot）
- 其余均为 resume replay 的等价副本
- 当前项目（claude-mnemo）的 49 个 JSONL 无重复

### 影响

受影响的读路径：
1. `src/replay/parser.ts` — usage.outputTokens 低估、assistantText 不完整、tool_use 可能丢失
2. `src/shared/transcript-parser.ts` — turn 的 assistantText/toolCalls 不完整
3. `src/hooks/handlers/stop.ts` — orphan turn 补 assistant_response 时可能写入中间态

不受影响：
- `countUserPromptsInTranscript()` — 只看 user prompt
- batch/rollback spec 的 D7/D8 sidechain 检测 — 依赖 isSidechain 字段

---

## Locked Decisions

**D1**: 去重策略从 **first-wins 改为 last-wins**。JSONL 是 append-only，后写入的 entry 必定 ≥ 先写入的完整度。对两种场景都正确：
- Streaming snapshot：最终态覆盖中间态
- Resume replay：等价副本覆盖等价副本（无损）

**D2**: **保留首次出现的位置/时序元数据**。last-wins 替换 content/usage 等语义字段，但以下字段保留第一次出现的值：
- `lineNumber` — 表示"该消息在 JSONL 中的首次位置"，对 replay-parse 的 `lineStart` 字段语义更准确
- `timestamp` — 表示"该消息的原始发生时刻"。Resume replay 会带晚到的 timestamp（恢复时刻），如果被覆盖会导致 turn 时间显示为恢复时刻而非原始时刻

原则：**last-wins for content/usage，first-wins for location/chronology metadata**。

**D3**: 不引入"选更完整的 snapshot"的复杂逻辑（比较 output_tokens、content blocks 数量等）。Last-wins 在 append-only JSONL 中等价于 most-complete，不需要额外比较。

---

## Implementation

修改 `readAllTranscriptEntries()` 中的去重循环：

```typescript
// Before (first-wins):
const seenUuids = new Set<string>();
for (const entry of entries) {
  if (entry.uuid) {
    if (seenUuids.has(entry.uuid)) continue;
    seenUuids.add(entry.uuid);
  }
  deduped.push(entry);
}

// After (last-wins for content/usage, first-wins for location/chronology):
const uuidIndex = new Map<string, number>();
for (const entry of entries) {
  if (entry.uuid) {
    const existing = uuidIndex.get(entry.uuid);
    if (existing !== undefined) {
      const first = deduped[existing];
      deduped[existing] = {
        ...entry,
        lineNumber: first.lineNumber,
        timestamp: first.timestamp ?? entry.timestamp,
      };
      continue;
    }
    uuidIndex.set(entry.uuid, deduped.length);
  }
  deduped.push(entry);
}
```

---

## Tests

1. 同 uuid 两条 entry（中间态 + 最终态）→ 保留最终态的 content/usage，保留首次 lineNumber 和 timestamp
2. 同 uuid 多条 entry（resume replay）→ 保留最后一条的 content/usage，保留首次 lineNumber 和 timestamp
3. Resume replay 带晚到 timestamp → turn 时间显示为原始发生时刻，不是恢复时刻
4. 无重复 uuid → 行为不变
5. uuid 为空的 entry（system 类型等）→ 不参与去重，全部保留
6. 混合场景：部分 uuid 重复、部分不重复 → 各自正确处理，输出顺序不变
