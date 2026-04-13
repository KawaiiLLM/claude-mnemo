# Timeline Compact Rendering

**Goal:** Rewrite the turn table rendering from padded fixed-width columns to a pipe-delimited compact format, reducing token consumption by ~50-70% while preserving all information.

---

## Context

Current `renderTurnTable` (`src/mcp/timeline.ts:884`) outputs a fixed-width ASCII table with every column `.padEnd(N)`. This wastes significant tokens on whitespace padding — the prompt column alone pads to 100 chars regardless of content length. Skipped turns each consume a full padded row despite carrying almost no information.

The same `renderTimeline` function serves both the MCP timeline tool and the SessionStart context hook (`src/hooks/handlers/context.ts:151`), so this change improves token economy in both paths.

**Before:**

```
  T#    line   time    gap          stats          prompt<...pad to 100...>   title
  ───   ────   ─────   ─────────    ────────────   ─────────────<...100...>   ──────────────────────
  T130  —     15:56   +5m2s        🔧6              如何uninstall当前版本...               🔵 Explained marketplace...
  ⏭ T133  —     15:59   +38s         —                我用的远程仓库...                       ⏭
  T134  —     16:01   +2m2s        🔧2              为什么其他插件的scope...                 🔵 Explained why custom...
  ⏭ T136  —     16:03   +1m10s       —                Install Plugins                        ⏭
  ⏭ T137  —     16:04   +32s         🔧4              清了也一样                               ⏭
  T138  —     16:05   +1m49s       🔧8 📖2 ✏️2      一样的                                   ✅ Updated plugin meta...
```

~190 chars/row. Skipped turns each take a full row.

**After:**

```
T# | line | time | gap | stats | prompt → title
T130 | L482 | 15:56 | +5m2s | 🔧6 | 如何uninstall当前版本，安装新版本 → 🔵 Explained marketplace plugin update f…
T134 | L510 | 16:01 | +2m2s | 🔧2 | 为什么其他插件的scope都是project，只有我是user → 🔵 Explained why custom marketplace plug…
T138 | L580 | 16:05 | +1m49s | 🔧8 📖2 ✏️2 | 一样的 → ✅ Updated plugin metadata versions, off…
⏭ T133, T136-T137
```

~80-100 chars/row. Skipped turns collapsed into one trailing line.

---

## Locked decisions

| # | Decision |
|---|---|
| **D1** | **Pipe-delimited, no padding.** Replace `.padEnd(N)` column alignment with `\|`-separated fields. Each field is its natural width. Header row uses the same pipe format: `T# \| line \| time \| gap \| stats \| prompt → title`. No separator/dash row. |
| **D2** | **Prompt and title merged into one field.** `prompt → title` as a single last column. Prompt is truncated by `promptCap` (100 for MCP tool, 80 for context hook). Title follows `→` delimiter. This eliminates the second largest pad source. |
| **D3** | **Skipped turns collapsed to one trailing line.** All skipped turns in the page are collected and rendered as a single line at the bottom: `⏭ T133, T136-T137, T140`. Consecutive skipped turn numbers are range-compressed (e.g., T136-T137). If no skipped turns exist in the page, the line is omitted. |
| **D4** | **Undone turns render inline with strikethrough.** Undone turns (`⨯`) keep their current inline position (they carry meaningful prompt/title content). Only skipped turns (`⏭`) move to the trailing line. |
| **D5** | **`line` column shows `—` when null, `L<n>` when populated.** Same as today, just without padding. |
| **D6** | **Broken-prompt `※` marker stays in the gap field.** `+5m2s ※` — no change in semantics, just no padding after it. |
| **D7** | **Context hook uses the same compact format.** `renderTimeline` is the single rendering path. Context hook's `promptCap: 80` is respected as before — the only difference is the prompt field is shorter. |
| **D8** | **Sanitize `\|` and `→` in prompt and title.** Since `\|` is the field delimiter and `→` is the prompt/title separator, literal occurrences in prompt or title text must be replaced before rendering. Replace `\|` with `/` and `→` with `->`. This keeps the output parseable and prevents pseudo-columns. Applied in `renderTurnRow` after `truncateText`, before joining. |
| **D10** | **Title truncation unchanged.** Title continues to use `TITLE_COLUMN_CAP` (currently 40 chars) via `truncateText` in `renderTitleCell`. The merged `prompt → title` field applies `promptCap` to prompt and `TITLE_COLUMN_CAP` to title independently — they don't share a budget. |
| **D9** | **Skipped turns still participate in `prevEpoch` tracking.** When iterating `pageTurns`, skipped turns update `prevEpoch` but do not emit a row. This ensures the next visible turn's gap reflects the time since the previous turn (including any skipped turns in between), not since the last *visible* turn. Without this, gaps after skipped regions would be artificially inflated. |

---

## Non-goals

- Changing the session header format (already compact).
- Changing phases or shape signals rendering.
- Changing the `promptCap` values (100 for MCP, 80 for context).
- Changing undone turn behavior.

---

## Implementation

### Task 1: Rewrite `renderTurnTable` and `renderTurnRow`

**Files:**
- Modify: `src/mcp/timeline.ts`
- Modify: `tests/mcp/timeline.test.ts`
- Modify: `tests/hooks/context.test.ts` (if assertions match exact turn table format)

**Changes to `renderTurnTable` (line 884):**

1. Replace the padded header with: `T# | line | time | gap | stats | prompt → title`
2. Remove the dash separator row.
3. Iterate all `pageTurns` in order, always updating `prevEpoch` (D9). For skipped turns, collect their `promptNumber` into a separate array instead of emitting a row. For all other turns, emit a compact row.
4. After the loop, append the skipped summary line if the array is non-empty.

**Changes to `renderTurnRow` (line 920):**

1. Remove all `.padEnd(N)` calls.
2. Join fields with ` | ` delimiter.
3. Merge prompt and title into one field: `{prompt} → {title}`.
4. After `truncateText` and before joining, sanitize `|` → `/` and `→` → `->` in prompt and title text (D8).
5. `renderTurnRow` is only called for non-skipped turns; skipped turns are handled by `renderTurnTable` directly.

**New helper `renderSkippedSummary`:**

Takes an array of skipped turn numbers, range-compresses consecutive numbers, and returns a single line like `⏭ T133, T136-T137, T140`.

**Test updates:**

Timeline and context tests that assert exact turn table format need updating. The assertions should verify:
- Header line contains `T# | line | time | gap | stats | prompt → title`
- Normal turns use `|` delimiters and `→` between prompt and title
- Skipped turns appear as a single trailing line
- Undone turns render inline with `⨯` prefix and `~~strikethrough~~`

---

## Test cases

| # | Case | Assert |
|---|---|---|
| 1 | Normal turn row | `T5 \| L100 \| 22:30 \| +1m40s \| 🔧2 \| raw prompt 5 → 🔵 title for T5` |
| 2 | Skipped turns collapsed | Single trailing line `⏭ T3, T7-T9` for skipped turns at positions 3, 7, 8, 9 |
| 3 | No skipped turns | No `⏭` line at bottom |
| 4 | Undone turn inline | `⨯T12 \| ... \| ~~prompt~~ → ~~🔵 title~~` in normal position |
| 5 | Compact turn | Renders inline like normal turns with `/compact` prompt |
| 6 | Null transcriptLineStart | `— ` in line field (no pad) |
| 7 | Context hook format | Same compact format, respects `promptCap: 80` |
| 8 | Broken-prompt marker | `+5m2s ※` in gap field |
| 9 | Header row present | First line of turn table is `T# \| line \| time \| gap \| stats \| prompt → title` |
| 10 | Prompt contains `\|` | `rg foo \| sed` rendered as `rg foo / sed` — no extra columns in output |
| 11 | Title contains `→` | `→` in title replaced with `->`, only the field separator `→` separates prompt from title |
| 12 | Skipped turns don't inflate gap | T5 visible, T6 skipped, T7 visible: T7's gap is relative to T6 (not T5) |
