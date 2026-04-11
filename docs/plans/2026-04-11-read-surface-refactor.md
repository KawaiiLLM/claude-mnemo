# Read Surface Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse claude-mnemo's read surface to a clean three-axis model — `recall` (high-entropy semantic index), `timeline` (temporal narrative, landed separately), and a `replay` **skill** pointing to raw JSONL/SQLite — by deleting the `replay` MCP tool, unifying pagination, removing hidden sampling, and capping truncation uniformly.

**Architecture:**
1. **Tool-layer shrink**: delete `replay` as an MCP tool. Mnemosyne's SDK server and the main MCP server both drop from three tools (`remember`, `recall`, `replay`) to two structured tools (`remember`, `recall`). Raw transcript access moves to a new `mnemo-replay` skill that points agents to the JSONL file path and the SQLite database directly.
2. **Render-layer simplification**: replace `depth=full`, the `limit` parameter, and `sampleWithOmissions` with a uniform `page + pageSize` pagination on the target level plus a fixed 5-item preview for child levels. Truncation becomes a single global `truncate` parameter (default 200, max 2000) that no longer varies with depth.
3. **Index leakage**: add a `jsonlPath` field to expanded session views so agents can jump straight from a `recall` result to `Read(jsonl_path)` without an extra lookup.

**Tech Stack:** TypeScript, Bun, Zod, SQLite (bun:sqlite), Claude Agent SDK (`createSdkMcpServer`), MCP SDK (`@modelcontextprotocol/sdk`).

---

## Three-axis read model (north star)

This refactor exists to make the following model real. Every task below should be evaluated against it:

| Axis | Tool | Purpose | Output contract |
|---|---|---|---|
| **Content index** | `recall` (MCP tool) | High-entropy semantic index: titles, tags, types, short content with truncation | Structured, paginated, truncated. Never the source of truth. |
| **Temporal narrative** | `timeline` (MCP tool, separate spec) | "How did this session unfold" — phases, gaps, tool bursts | Structured, time-ordered, per-session. |
| **Raw truth** | `mnemo-replay` **skill** (not a tool) | Pointer to JSONL + SQLite. Agent uses `Read` / `Grep` / `sqlite3` directly. | Raw bytes. No tool wrapper. |

**Why the skill instead of a tool**: replay's previous value was filtering/windowing raw data. But index-time filtering is what `recall` is for. Once the agent has `[S12/T3]` from recall, it already knows exactly where in the raw data to look — a tool that re-filters is redundant. The skill tells the agent where the raw data lives; the agent reads it.

**Consequence**: this refactor reduces Mnemosyne's available tool set from three to two. The extraction agent keeps `remember` and `recall`. It loses `replay`. If Mnemosyne needs exact wording in the future, a later spec can add read access to the JSONL via the SDK's file tools — that is out of scope here.

---

## Locked decisions

These answer Q1-Q10 from `docs/plans/2026-04-11-rendering-overflow-design-notes.md`. The user has approved each. They are not open for re-litigation during implementation.

| # | Decision |
|---|---|
| **D1** | Pagination is top-level only. Child levels are capped at a fixed 5-item preview with `+N more` hint. No per-child offset. |
| **D2** | Pagination params are `page: number` (1-indexed) + `pageSize: number`. No cursors. Converts to `offset = (page - 1) * pageSize` internally. |
| **D3** | `depth: "collapsed" \| "expanded"`. **`full` is removed.** `collapsed` = headers only; `expanded` = full fields (with truncation) + 5-item child preview. |
| **D4** | `sampleWithOmissions` is deleted. Active-turn priority is preserved by ORDER BY in SQL (status='active' DESC, created_at DESC). |
| **D5** | `truncate: number` is a single global parameter. Default `200`. Max `2000`. No unlimited. No per-field override. |
| **D6** | **`replay` MCP tool is deleted entirely** in one atomic cutover (Task 1), together with every runtime reference to it (Mnemosyne system prompt, SessionStart hint strings, MCP server registration, SDK server registration). Zod schema, handler, server registration, SDK tool registration, and `src/mcp/replay.ts` all go in the same commit. |
| **D7** | A new `plugin/skills/mnemo-replay/SKILL.md` is created, documenting how to read raw JSONL (`Read` / `Grep`) and query SQLite (`sqlite3` SELECT examples). No write path in the skill — writes still go through `remember`. |
| **D8** | `FormattedSession` gains a `jsonlPath` field populated at `expanded` depth, so agents can jump from a recall result to the raw file with one step. |
| **D9** | `src/hooks/handlers/context.ts` passes explicit conservative params (`truncate: 120, pageSize: 5`) when rendering recent sessions + current session. SessionStart is not affected by default changes. |
| **D10** | `limit` parameter is removed with **no** backwards compatibility alias. Internal callers updated in the same commit. |
| **D11** | **Mnemosyne system prompt is edited in the same commit that deletes `replay`** (`src/worker/query-session.ts:224-276`). Every `replay()` reference is removed. The turn-message truncation fallback becomes `recall({id, depth: "expanded", truncate: 2000})` — a strict **improvement** over the previous state, since the old `replay(..., depth: "full")` actually capped at 1000 chars anyway (Finding 1 from the design notes). This is a mandatory consistency edit, not a behavior change. |

---

## Non-goals

Explicitly out of scope — adding these derails the refactor:

- FTS tuning, new search operators
- Schema changes (no new DB columns, no migrations)
- **New Mnemosyne extraction behavior**. The extraction agent's logic, message routing, and remember() contract are all unchanged. However, the Mnemosyne **system prompt** IS edited in Task 1 to strip every reference to the deleted `replay()` tool — that is a mandatory consistency fix (the prompt would otherwise instruct Mnemosyne to call a tool that no longer exists), not an extraction-behavior change. See D11.
- `timeline` tool (separate spec, rebased after this lands)
- Replacing Zod
- Changing the tool-surface for writes (`remember` untouched)
- Turn-table `type` / `tags` rendering — that's a follow-up when `timeline` lands
- Performance/streaming changes
- `TYPE_EMOJI` orphan cleanup — known dead code, leave it for `timeline` spec to pick up

---

## File structure

### Files modified

| File | Responsibility after refactor |
|---|---|
| `src/mcp/definitions.ts` | Zod schemas for `recall` and `remember` only. No `replay*`. |
| `src/mcp/handlers.ts` | `MnemoToolHandlers` type with `recall` and `remember`. No `replay`. |
| `src/mcp/server.ts` | Registers `recall` and `remember` only. |
| `src/worker/agent-session.ts` | Mnemosyne SDK server registers `remember` + `recall` (2 tools, was 3). |
| `src/worker/query-session.ts` | Mnemosyne **system prompt** (lines ~224-276) — remove every `replay()` reference; replace the turn-message truncation fallback example with `recall({id, depth: "expanded", truncate: 2000})`. No code-path change beyond the prompt string itself. |
| `src/mcp/format.ts` | Unified truncation (single `truncate` param). Deletes `UNIFIED_TRUNCATION_LIMITS`, `sampleWithOmissions`, `formatTree`'s observation branch. `RenderDepth` narrowed to `"collapsed" \| "expanded"`. |
| `src/mcp/recall.ts` | Uses new pagination + child-cap. Populates `jsonlPath` at expanded depth. No `sampleWithOmissions` calls. |
| `src/hooks/handlers/context.ts` | Passes explicit `truncate: 120, pageSize: 5` when building SessionStart output. |
| `plugin/skills/mnemo-recall/SKILL.md` | Removes all `replay` examples. Documents new `page/pageSize/truncate` params. Points to `mnemo-replay` skill for raw. |
| `plugin/CLAUDE.md` | Updates tool list to `recall` + `replay` (skill, not tool). Workflow is browse → shape → raw. |
| `docs/design.md` | §Tool Surface rewritten: "two structured tools + one raw skill". §Display and Rendering updated to reflect new truncate/pagination model. |

### Files created

| File | Responsibility |
|---|---|
| `plugin/skills/mnemo-replay/SKILL.md` | Documents JSONL file locations, schema, and SQLite DB query examples. Points at `Read` / `Grep` / `sqlite3` as the tools. |

### Files deleted

| File | Why |
|---|---|
| `src/mcp/replay.ts` | Entire `replay` tool — replaced by skill. |
| `tests/mcp/replay.test.ts` (if it exists) | No tool to test. |

---

## Implementation order

1. **Task 1 — Atomic tool-surface cutover**. A single large commit that removes `replay` entirely (tool file, schema, handlers, server registration, SDK registration, Mnemosyne prompt references, SessionStart hint strings) AND narrows the `recall` input type (no `limit`, no `full`, adds `page`/`pageSize`/`truncate`). After this commit, the code compiles, all tests pass, and the external tool surface already matches the final state. Internally, `recall.ts` still uses the old rendering path and `format.ts` still has the old truncation table — those become internal refactors in later tasks.
2. Task 2 — `format.ts` primitives (truncate + `sampleWithOmissions` deletion)
3. Task 3 — `recall.ts` real pagination + child cap
4. Task 4 — `jsonlPath` on expanded session views
5. Task 5 — `src/hooks/handlers/context.ts` conservative params (truncate/pageSize only; string constants already fixed in Task 1)
6. Task 6 — Rewrite `plugin/skills/mnemo-recall/SKILL.md`
7. Task 7 — Create `plugin/skills/mnemo-replay/SKILL.md`
8. Task 8 — Update `plugin/CLAUDE.md`
9. Task 9 — Update `docs/design.md`
10. Task 10 — End-to-end verification + cross-caller audit

**Each task commits independently. The test suite must be green and the code must compile after every task.** Task 1 is large on purpose — a tool-surface cutover cannot be split without breaking this invariant, because `server.ts`, `agent-session.ts`, and the Mnemosyne prompt all import / reference the same set of symbols that disappear together.

---

### Task 1: Atomic tool-surface cutover

**This is the largest task in the plan.** It deletes `replay` as a tool in every place it exists — schema, handlers, MCP server, Mnemosyne SDK server, the tool file itself, the Mnemosyne system prompt, and SessionStart hint strings — and simultaneously narrows `RecallInput` / `recallInputSchema` to the final shape (no `limit`, no `depth=full`, adds `page` / `pageSize` / `truncate`). Everything must change together because the removed symbols are imported across multiple files; splitting this task would break compilation at the intermediate checkpoints.

After this task commits:
- `bun test` — all green.
- `bun run typecheck` — zero errors.
- `grep -r "replayInputShape\|replayInputSchema\|replayMemory\|mcp__mnemo__replay" src/` — zero hits.
- Mnemosyne's system prompt no longer contains the string `replay()` or `replay(`.
- The external tool surface is already final: only `recall` and `remember` are registered. The later tasks (2-4) are pure internal refactors of the `recall` implementation and renderer.

Internally, after this commit `src/mcp/recall.ts` and `src/mcp/format.ts` still use the **old** rendering logic — depth-based truncation limits, old `sampleWithOmissions` calls, `limit` internally renamed to `pageSize` as a minimal no-op. Real pagination, real child cap, and the new truncation model arrive in Tasks 2-4. This is deliberate: the tool-surface change is orthogonal to the rendering-behavior change, and bundling them would block either half of the work from landing cleanly.

**Files:**
- Modify: `src/mcp/definitions.ts`
- Modify: `src/mcp/handlers.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/worker/agent-session.ts`
- Modify: `src/worker/query-session.ts` (Mnemosyne system prompt only — no logic changes)
- Modify: `src/mcp/recall.ts` (input interface + minimal translation of `limit` → `pageSize`; no rendering behavior changes yet)
- Modify: `src/hooks/handlers/context.ts` (string constants only — `EMPTY_CONTEXT_FALLBACK` and the `buildHeader` help line)
- Delete: `src/mcp/replay.ts`
- Delete: `tests/mcp/replay.test.ts` (if present)
- Test: `tests/mcp/definitions.test.ts` (create)
- Test: `tests/worker/query-session.test.ts` (update — remove any assertion that exercises replay tool registration)

- [ ] **Step 1: Write the failing schema test**

Create `tests/mcp/definitions.test.ts` if it does not exist. Add:

```typescript
import { describe, expect, it } from "bun:test";

import {
  recallInputSchema,
  rememberInputSchema,
  MNEMO_ALLOWED_TOOLS,
  MNEMO_TOOL_DESCRIPTIONS,
} from "../../src/mcp/definitions";

describe("recallInputSchema", () => {
  it("accepts page + pageSize + truncate and rejects limit + depth=full", () => {
    const ok = recallInputSchema.parse({
      id: "S1",
      depth: "expanded",
      page: 2,
      pageSize: 10,
      truncate: 500,
    });

    expect(ok).toEqual({
      id: "S1",
      depth: "expanded",
      page: 2,
      pageSize: 10,
      truncate: 500,
    });

    expect(() =>
      recallInputSchema.parse({ id: "S1", limit: 10 }),
    ).toThrow();
    expect(() =>
      recallInputSchema.parse({ id: "S1", depth: "full" }),
    ).toThrow();
    expect(() =>
      recallInputSchema.parse({ id: "S1", truncate: 5000 }),
    ).toThrow();
    expect(() =>
      recallInputSchema.parse({ id: "S1", truncate: 0 }),
    ).toThrow();
  });
});

describe("tool surface", () => {
  it("exposes exactly two read/write tools: recall and remember", () => {
    expect(MNEMO_ALLOWED_TOOLS).toEqual([
      "mcp__mnemo__remember",
      "mcp__mnemo__recall",
    ]);
    expect(Object.keys(MNEMO_TOOL_DESCRIPTIONS).sort()).toEqual([
      "recall",
      "remember",
    ]);
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `bun test tests/mcp/definitions.test.ts`
Expected: FAIL — current schema still has `limit` / `depth=full` / `replay*`.

- [ ] **Step 3: Rewrite `src/mcp/definitions.ts`**

Replace the entire file with:

```typescript
import { z } from "zod";

export const MNEMO_TOOL_DESCRIPTIONS = {
  recall:
    "Recall structured memories from the SQLite store. Paginated index; use the mnemo-replay skill for raw JSONL.",
  remember:
    "Persist sessions, turns, observations, or memories through one routed write tool.",
} as const;

const depthEnum = z.enum(["collapsed", "expanded"]);

export const recallInputShape = {
  id: z.string().optional(),
  query: z.string().optional(),
  time: z.string().optional(),
  depth: depthEnum.optional(),
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().optional(),
  truncate: z.number().int().min(1).max(2000).optional(),
};

export const rememberInputShape = {
  id: z.string().optional(),
  type: z.string().optional(),
  scope: z.string().optional(),
  title: z.string().optional(),
  content: z.string().optional(),
  insight: z.string().optional(),
  reasoning: z.string().optional(),
  application: z.string().optional(),
  tags: z.array(z.string()).optional(),
  status: z
    .enum([
      "pending",
      "extracted",
      "skipped",
      "undone",
      "active",
      "superseded",
      "archived",
    ])
    .optional(),
  next_steps: z.string().optional(),
  source: z.string().optional(),
};

export const recallInputSchema = z.object(recallInputShape).strict();
export const rememberInputSchema = z.object(rememberInputShape).strict();

export const MNEMO_ALLOWED_TOOLS = [
  "mcp__mnemo__remember",
  "mcp__mnemo__recall",
] as const;
```

Note: the `replayInputShape` / `replayInputSchema` exports are gone. Any importer will fail compilation — the remaining steps in this same task clean them up.

- [ ] **Step 4: Update `src/mcp/handlers.ts`**

Replace the file's import block and the handler interface:

```typescript
import type { Database } from "bun:sqlite";

import { recallMemory } from "./recall";
import { rememberTool } from "./remember";

export type ToolResult = {
  content: Array<{
    type: "text";
    text: string;
  }>;
};

export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult> | ToolResult;

export interface MnemoToolHandlers {
  recall: ToolHandler;
  remember: ToolHandler;
}

export interface CreateDatabaseBackedHandlersOptions {
  defaultProject?: string;
}

export function textResult(text: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
  };
}

export function createStubHandler(toolName: string): ToolHandler {
  return async () => textResult(`${toolName} not implemented`);
}

export function createDatabaseBackedHandlers(
  database?: Database,
  _options: CreateDatabaseBackedHandlersOptions = {},
): Partial<MnemoToolHandlers> {
  if (!database) {
    return {};
  }

  return {
    recall: (args) =>
      textResult(
        recallMemory(database, {
          id: args.id as string | undefined,
          query: args.query as string | undefined,
          time: args.time as string | undefined,
          depth: args.depth as "collapsed" | "expanded" | undefined,
          page: args.page as number | undefined,
          pageSize: args.pageSize as number | undefined,
          truncate: args.truncate as number | undefined,
        }),
      ),
    remember: (args) =>
      rememberTool(database, args as unknown as Parameters<typeof rememberTool>[1]),
  };
}
```

The `replay` entry is gone. The import of `./replay` is gone.

- [ ] **Step 5: Run the definitions test — verify it passes**

Run: `bun test tests/mcp/definitions.test.ts`
Expected: PASS.

At this intermediate point, `bun run typecheck` WILL fail. That is expected — the remaining steps in this same task fix every downstream caller. Do NOT commit yet.

- [ ] **Step 6: Update `src/mcp/server.ts` — remove replay registration**

Open `src/mcp/server.ts`. Remove the `replayInputSchema` import at the top of the imports block. Remove the `replay: mergedHandlers.replay ?? createStubHandler("replay")` entry from the `toolHandlers` assembly. Delete the entire `server.registerTool("replay", …)` block (currently lines ~74-81).

Resulting `toolHandlers` shape is `{ recall, remember }`. Two `registerTool` calls remain.

- [ ] **Step 7: Update `src/worker/agent-session.ts` — remove replay from Mnemosyne's SDK server**

Open `src/worker/agent-session.ts`. Remove the `replayInputShape` import at the top. In `createMnemoSdkServer`, remove the `replay: partialHandlers.replay ?? missingHandler("replay")` entry from the `handlers` object (currently lines ~78-82). Delete the entire `deps.toolImpl("replay", …)` block (currently lines ~100-105).

Resulting SDK server exposes exactly two tools: `remember` and `recall`.

- [ ] **Step 8: Update `src/worker/query-session.ts` — Mnemosyne system prompt**

Open `src/worker/query-session.ts`. The Mnemosyne system prompt is the template literal passed as `systemPrompt` in the `input.systemPrompt ?? \`…\`` fallback (currently lines ~224-276).

There are **four** places the prompt mentions `replay()`. Apply these exact edits:

(a) **Tools section** (line ~234-235). Replace:

```
- \`replay()\` / \`recall()\` — read-only fallbacks, usable **only from turn messages**. Not usable from observation or session-summary messages (see per-section rules below). For a turn message whose inline \`<turn>\` block is visibly truncated (\`[...N chars truncated...]\`) AND whose missing content is essential to the title/content/insight, call \`replay({ id: "<session id>/<turn id>", depth: "full" })\` before the remember() call — read the session id from the \`<session id="S...">\` block and the turn id from the \`<turn id="T...">\` block of the current message; they are two different numbers. Concrete example: \`replay({ id: "S12/T3", depth: "full" })\`. \`recall()\` is rarely needed — the inline data and conversation history almost always suffice.
```

with:

```
- \`recall()\` — the only read fallback, usable **only from turn messages**. Not usable from observation or session-summary messages (see per-section rules below). For a turn message whose inline \`<turn>\` block is visibly truncated (\`[...N chars truncated...]\`) AND whose missing content is essential to the title/content/insight, call \`recall({ id: "<session id>/<turn id>", depth: "expanded", truncate: 2000 })\` before the remember() call — read the session id from the \`<session id="S...">\` block and the turn id from the \`<turn id="T...">\` block of the current message; they are two different numbers. Concrete example: \`recall({ id: "S12/T3", depth: "expanded", truncate: 2000 })\`. The inline data and conversation history usually suffice — only escalate when they genuinely do not.
```

(b) **Observation section** (line ~249). Replace:

```
Never update T/S records, create memories, or call \`recall()\` / \`replay()\` from an obs message.
```

with:

```
Never update T/S records, create memories, or call \`recall()\` from an obs message.
```

(c) **Turn section** (line ~267). Replace:

```
Turn messages are the ONLY context where \`replay()\` is permitted, and only under the truncation-critical condition described in the Tools section. Skip it entirely if the inline \`<turn>\` block already contains what you need.
```

with:

```
Turn messages are the ONLY context where \`recall()\` is permitted as a fallback, and only under the truncation-critical condition described in the Tools section. Skip it entirely if the inline \`<turn>\` block already contains what you need.
```

(d) **Session summary section** (line ~271). Replace:

```
When you receive a \`<session>\` block without an accompanying \`<turn>\`, it is a session summary refresh. Follow the length budget in the inline \`<instruction>\` block. Never call \`recall()\` or \`replay()\` from a session-summary message — the inline \`prior_*\` fields are the only state you should base the refresh decision on.
```

with:

```
When you receive a \`<session>\` block without an accompanying \`<turn>\`, it is a session summary refresh. Follow the length budget in the inline \`<instruction>\` block. Never call \`recall()\` from a session-summary message — the inline \`prior_*\` fields are the only state you should base the refresh decision on.
```

After these edits, `grep -c "replay()" src/worker/query-session.ts` must return `0`.

- [ ] **Step 9: Update `src/mcp/recall.ts` — RecallInput type + minimal translation**

Open `src/mcp/recall.ts`. Locate the `RecallInput` interface (search for `export interface RecallInput`). Replace it with:

```typescript
export interface RecallInput {
  id?: string;
  query?: string;
  time?: string;
  depth?: "collapsed" | "expanded";
  page?: number;
  pageSize?: number;
  truncate?: number;
}
```

Locate the `const limit = input.limit ?? 50;` line near the `recallMemory` function entry (currently around line 1147). Replace with:

```typescript
const depth = input.depth ?? "collapsed";
const pageSize = input.pageSize ?? 50;
// Legacy internal name — Task 3 replaces this with real pagination.
const limit = pageSize;
```

Keep the rest of `recall.ts` unchanged in this task. The goal is only to make it compile with the new input shape; real pagination semantics land in Task 3.

If anywhere in `recall.ts` you find a branch on `depth === "full"`, replace it with the equivalent `expanded` branch (or delete the branch outright if it's redundant). There should be zero remaining references to `"full"` after this step.

- [ ] **Step 10: Delete `src/mcp/replay.ts`**

```bash
git rm src/mcp/replay.ts
```

If `tests/mcp/replay.test.ts` exists:

```bash
git rm tests/mcp/replay.test.ts
```

- [ ] **Step 11: Update `src/hooks/handlers/context.ts` string constants**

Open `src/hooks/handlers/context.ts`. Two string constants reference the deleted `replay()` tool:

(a) `EMPTY_CONTEXT_FALLBACK` at line ~22:

```typescript
// BEFORE
const EMPTY_CONTEXT_FALLBACK = "claude-mnemo memory available via recall() and replay().";

// AFTER
const EMPTY_CONTEXT_FALLBACK =
  "claude-mnemo memory available via recall(); raw transcripts via the mnemo-replay skill.";
```

(b) `buildHeader` help line at line ~53:

```typescript
// BEFORE
'Expand: recall(id="Sx/Ty", depth="expanded") | Raw: replay(id="Sx/Ty", depth="expanded")',

// AFTER
'Expand: recall(id="Sx/Ty", depth="expanded") | Raw: mnemo-replay skill (read jsonlPath)',
```

No logic changes. Only two string literals touched. The render-option changes (passing `truncate`/`pageSize`) happen in Task 5, not this task.

- [ ] **Step 12: Update tests that reference replay tool registration**

Run: `grep -rl "replay" tests/ --include="*.ts"`

Expected hits:
- `tests/mcp/definitions.test.ts` (covers absence — leave alone, it already asserts zero).
- `tests/worker/query-session.test.ts` (may have assertions about the prompt containing `replay()` or about replay tool availability — flip them to assert absence).
- `tests/worker/agent-session.test.ts` (may register replay in a mocked SDK server — remove those mocks).
- `tests/mcp/handlers.test.ts` (if it checks the handler interface — update).

For each test file hit, read it, find the replay assertions, and either delete the test or flip the assertion from "contains replay" to "does not contain replay" to lock the invariant. **Every edited test must still express a meaningful assertion** — do not leave empty `describe` blocks.

Example flip for `tests/worker/query-session.test.ts`:

```typescript
// BEFORE
expect(allowedTools).toContain("mcp__mnemo__replay");

// AFTER
expect(allowedTools).not.toContain("mcp__mnemo__replay");
expect(allowedTools.sort()).toEqual([
  "mcp__mnemo__recall",
  "mcp__mnemo__remember",
]);
```

- [ ] **Step 13: Run the full suite — verify green**

Run: `bun test`
Expected: PASS. All tests green, no compile errors.

Run: `bun run typecheck` (or the project's equivalent).
Expected: zero errors.

Run these greps and verify zero hits in `src/`:

| Pattern | Expected |
|---|---|
| `replayInputShape` | 0 |
| `replayInputSchema` | 0 |
| `replayMemory` | 0 |
| `from "\./replay"` or `from "\.\./mcp/replay"` | 0 |
| `mcp__mnemo__replay` | 0 |
| `replay\(\)` | 0 |
| `depth: "full"` or `depth === "full"` | 0 |

If any of these show nonzero hits in `src/`, fix them before committing.

- [ ] **Step 14: Commit**

```bash
git add src/mcp/definitions.ts src/mcp/handlers.ts src/mcp/server.ts
git add src/worker/agent-session.ts src/worker/query-session.ts
git add src/mcp/recall.ts src/hooks/handlers/context.ts
git add tests/mcp/definitions.test.ts
git add -u tests/  # picks up edited test files from Step 12
git rm --cached src/mcp/replay.ts 2>/dev/null || true  # safety — Step 10 already ran
git commit -m "refactor(mcp): atomic tool-surface cutover to recall + remember

Delete the replay MCP tool end to end and narrow the recall schema in
one atomic commit. This is the tool-surface change; the internal
pagination + truncate refactor of recall.ts and format.ts lands in
the follow-up tasks of the read-surface-refactor plan.

Touched:
- definitions.ts, handlers.ts: remove replay schema, add
  page/pageSize/truncate, narrow depth enum.
- server.ts, agent-session.ts: drop replay tool registration from
  both the MCP server and Mnemosyne's SDK server.
- query-session.ts: strip replay() references from Mnemosyne's
  system prompt; turn-truncation fallback becomes recall(truncate=2000).
- replay.ts: deleted.
- recall.ts: RecallInput updated to final shape; internal logic
  unchanged (pagination semantics land in a later task).
- context.ts: string constants point at the mnemo-replay skill
  instead of the deleted tool.

Mnemosyne is now a two-tool agent (remember, recall)."
```

---

### Task 2: Refactor `format.ts` primitives

Replace depth-keyed truncation limits with a single `truncate` option. Delete `sampleWithOmissions`. Narrow `RenderDepth`. Restore the `[use …]` truncation hint, but only when truncation actually happens and only in unified mode.

**Files:**
- Modify: `src/mcp/format.ts`
- Modify: `tests/mcp/format.test.ts` (existing snapshot tests need updates)

- [ ] **Step 1: Audit current `format.ts` structure**

Read `src/mcp/format.ts` in full. Locate these specific regions — you will modify each:

| Region | Lines (approx.) | Purpose |
|---|---|---|
| `LEGACY_TRUNCATION_LIMIT` / `UNIFIED_TRUNCATION_LIMITS` / `FIELD_TRUNCATION_SUFFIX` | ~10-20 | Per-depth truncation table — replace with single constant. |
| `RenderDepth` type | search `type RenderDepth` | Narrow enum. |
| `FormattedTurn` interface | ~64-82 | Unchanged in this task (`jsonlPath` on session added in Task 4). |
| `truncateText` | ~247-273 | Signature becomes `(text, limit, options)`. Hint appended only on actual truncation. |
| `renderNode` and `NodeRenderOptions` | search `interface NodeRenderOptions` | Add `truncate: number` to options. Remove depth-based limit lookup. |
| `sampleWithOmissions` | ~857-929 | Delete entirely. |
| `formatTree` | ~937-951 | Remove the `sampleWithOmissions` branches; inline a simple `slice(0, 5)` child preview. |

- [ ] **Step 2: Write failing test for single global truncate**

Append to `tests/mcp/format.test.ts` (or create a new `tests/mcp/format.truncate.test.ts` if the existing file is large):

```typescript
import { describe, expect, it } from "bun:test";
import { renderNode, type FormattedTurn } from "../../src/mcp/format";

function baseTurn(overrides: Partial<FormattedTurn> = {}): FormattedTurn {
  return {
    id: 1,
    promptNumber: 1,
    title: "fix auth",
    content: "x".repeat(500),
    promptPreview: null,
    responsePreview: null,
    insight: [],
    filesRead: [],
    filesModified: [],
    observationCount: 0,
    toolCallCount: 0,
    filesReadCount: 0,
    filesModifiedCount: 0,
    status: "extracted",
    ...overrides,
  };
}

describe("renderNode truncation", () => {
  it("uses the global truncate option at all depths", () => {
    const turn = baseTurn();

    const shortLimit = renderNode(
      { type: "turn", value: turn },
      { depth: "expanded", truncate: 50 },
    );
    const longLimit = renderNode(
      { type: "turn", value: turn },
      { depth: "expanded", truncate: 500 },
    );

    // shortLimit must contain a truncation marker; longLimit must not.
    expect(shortLimit).toContain("...");
    expect(longLimit).not.toContain("x".repeat(500) + "...");
  });

  it("defaults truncate to 200 when unspecified", () => {
    const rendered = renderNode(
      { type: "turn", value: baseTurn() },
      { depth: "expanded" },
    );

    // 200-char slice + "..." -> 203 chars of x then ...
    expect(rendered).toContain("x".repeat(200));
    expect(rendered).not.toContain("x".repeat(201));
  });

  it("restores the [use …] hint only when truncation actually happens", () => {
    const short = renderNode(
      { type: "turn", value: baseTurn({ content: "short text" }) },
      { depth: "expanded", truncate: 200 },
    );
    const long = renderNode(
      { type: "turn", value: baseTurn({ content: "y".repeat(500) }) },
      { depth: "expanded", truncate: 200 },
    );

    expect(short).not.toContain("[use ");
    expect(long).toContain("[use ");
  });
});
```

- [ ] **Step 3: Run the test — verify it fails**

Run: `bun test tests/mcp/format.truncate.test.ts`
Expected: FAIL — current `renderNode` has no `truncate` option and does not default to 200 uniformly.

- [ ] **Step 4: Apply changes to `format.ts`**

Make these specific edits. Line numbers are approximate — locate by content.

(a) **Replace the truncation constants** near the top of the file:

```typescript
// BEFORE
const LEGACY_TRUNCATION_LIMIT = 200;
const UNIFIED_TRUNCATION_LIMITS = {
  collapsed: 120,
  expanded: 300,
  full: 1000,
} as const;
const FIELD_TRUNCATION_SUFFIX = "...";

// AFTER
export const DEFAULT_TRUNCATE = 200;
export const MAX_TRUNCATE = 2000;
const FIELD_TRUNCATION_SUFFIX = "...";
```

(b) **Narrow `RenderDepth`**:

```typescript
// BEFORE
export type RenderDepth = "collapsed" | "expanded" | "full";

// AFTER
export type RenderDepth = "collapsed" | "expanded";
```

(c) **Update `NodeRenderOptions`**:

```typescript
// BEFORE
export interface NodeRenderOptions {
  depth: RenderDepth;
  mode?: "legacy" | "unified";
}

// AFTER
export interface NodeRenderOptions {
  depth: RenderDepth;
  /** Global field-level character cap. Default 200. Max 2000. */
  truncate?: number;
  mode?: "legacy" | "unified";
}
```

(d) **Rewrite `truncateText`** to take the limit from options, append the hint whenever truncation actually happens:

```typescript
function truncateText(
  text: string,
  options: {
    limit: number;
    hintId?: string;
    mode?: "legacy" | "unified";
  },
): string {
  const limit = Math.min(Math.max(options.limit, 1), MAX_TRUNCATE);
  if (text.length <= limit) {
    return text;
  }
  const head = text.slice(0, limit);
  const hint = options.hintId
    ? ` [use mnemo-replay skill → read ${options.hintId}]`
    : "";
  return `${head}${FIELD_TRUNCATION_SUFFIX}${hint}`;
}
```

Note: the hint text now points at the **skill**, not the removed `replay` tool. The hint is added whenever `hintId` is provided AND truncation actually occurred. Mode still controls other legacy details (e.g. prefixes); pass `mode: "unified"` from `renderNode`.

(e) **Every `truncateText` call** in the file needs to pass `limit: options.truncate ?? DEFAULT_TRUNCATE`. Grep for `truncateText(` inside format.ts and update each call:

```typescript
// BEFORE (example pattern)
truncateText(turn.content, UNIFIED_TRUNCATION_LIMITS[options.depth])

// AFTER
truncateText(turn.content, {
  limit: options.truncate ?? DEFAULT_TRUNCATE,
  hintId: buildHintIdForTurn(turn),
  mode: options.mode,
})
```

Use a small local helper `buildHintIdForTurn(turn)` that returns `S{sessionId}/T{promptNumber}` or similar. For session-level fields, use `S{id}`. For observations, `S{sessionId}/T{promptNumber}/O{id}`.

(f) **Delete `sampleWithOmissions` entirely**. The function at ~857-929 and its `const { OMISSION_MARKER } = ...` nearby. Remove all imports if they exist.

(g) **Simplify `formatTree`**. Replace any `sampleWithOmissions(entry.observations ?? [], ...)` with `(entry.observations ?? []).slice(0, 5)`. If `formatTree` is only called in legacy mode that is about to be retired, evaluate deleting the whole function — but only if no caller remains after Task 5 (the SessionStart context-handler task that will flip to `mode: "unified"`).

- [ ] **Step 5: Run the truncate test — verify it passes**

Run: `bun test tests/mcp/format.truncate.test.ts`
Expected: PASS.

- [ ] **Step 6: Run existing format snapshot tests and update**

Run: `bun test tests/mcp/format.test.ts`
Expected: some snapshot failures because the rendered output changed (new truncate limit, new hint text, `depth=full` removed). Review each failure, confirm the new output is correct, and update the snapshot with `--update-snapshots` or by editing the test inline.

**Important**: if any snapshot test exercises `depth: "full"`, either delete that test or change the depth to `"expanded"`. `full` is gone.

- [ ] **Step 7: Run the full suite**

Run: `bun test`
Expected: all tests green (Task 1 already cleaned up every cross-file compile error; `format.ts`'s internal refactor in this task should stay isolated to the format-specific tests).

- [ ] **Step 8: Commit**

```bash
git add src/mcp/format.ts tests/mcp/format.test.ts tests/mcp/format.truncate.test.ts
git commit -m "refactor(format): unify truncation and drop hidden sampling

- Single global truncate option, default 200, max 2000.
- Narrow RenderDepth to collapsed|expanded.
- Delete sampleWithOmissions; children will be capped via slice(0,5)
  in the callers.
- Restore [use mnemo-replay skill] hint, emitted only when a field is
  actually truncated."
```

---

### Task 3: Refactor `recall.ts` for pagination and child cap

Remove `limit`, add `page` + `pageSize` (default 50 at `collapsed`, 10 at `expanded`). Replace every `sampleWithOmissions` call with `items.slice(offset, offset + pageSize)` at the target level and `items.slice(0, 5)` + `+N more` hint at child levels. Thread `truncate` through to `renderNode`.

**Files:**
- Modify: `src/mcp/recall.ts`
- Test: `tests/mcp/recall.test.ts`

- [ ] **Step 1: Write failing pagination test**

Append to `tests/mcp/recall.test.ts` (or create `tests/mcp/recall.pagination.test.ts`):

```typescript
import { beforeEach, describe, expect, it } from "bun:test";
import { createDatabase } from "../../src/db/database";
import { initializeDatabase } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { insertTurn } from "../../src/db/turns";
import { recallMemory } from "../../src/mcp/recall";

describe("recall pagination", () => {
  let db: ReturnType<typeof createDatabase>;

  beforeEach(() => {
    db = createDatabase({ path: ":memory:" });
    initializeDatabase(db);

    const session = upsertSession(db, {
      contentSessionId: "pager-session",
      project: "/tmp",
      title: "pagination test",
      content: null,
      insight: null,
      createdAtEpoch: 1000,
      updatedAtEpoch: 1000,
      completedAtEpoch: null,
    });

    for (let i = 1; i <= 25; i += 1) {
      insertTurn(db, {
        sessionId: session.id,
        promptNumber: i,
        status: "extracted",
        title: `turn ${i}`,
        content: null,
        insight: null,
        promptPreview: null,
        responsePreview: null,
        filesRead: [],
        filesModified: [],
        toolCallCount: 0,
        createdAtEpoch: 1000 + i,
      });
    }
  });

  it("returns page 1 with pageSize 10 for expanded depth", () => {
    const output = recallMemory(db, {
      id: "S1/T*",
      depth: "expanded",
      page: 1,
      pageSize: 10,
    });

    expect(output).toContain("[T1]");
    expect(output).toContain("[T10]");
    expect(output).not.toContain("[T11]");
    expect(output).toContain("page 1 / 3");
  });

  it("returns page 2 with the same pageSize", () => {
    const output = recallMemory(db, {
      id: "S1/T*",
      depth: "expanded",
      page: 2,
      pageSize: 10,
    });

    expect(output).toContain("[T11]");
    expect(output).toContain("[T20]");
    expect(output).not.toContain("[T10]");
    expect(output).toContain("page 2 / 3");
  });

  it("child preview caps at 5 with +N more marker", () => {
    // Insert 8 observations against T1.
    for (let i = 1; i <= 8; i += 1) {
      db.query(
        `INSERT INTO observations (turn_id, tool_name, description, created_at_epoch)
         VALUES ((SELECT id FROM turns WHERE prompt_number = 1), 'Bash', ?, ?)`,
      ).run(`obs ${i}`, 2000 + i);
    }

    const output = recallMemory(db, {
      id: "S1/T1",
      depth: "expanded",
    });

    // First 5 observations visible, +3 more.
    expect(output).toContain("obs 1");
    expect(output).toContain("obs 5");
    expect(output).not.toContain("obs 6");
    expect(output).toContain("+3 more");
  });
});
```

Note: `insertTurn` may not exist with that name. Check `src/db/turns.ts` for the actual insert helper and adjust. If only a raw SQL path exists, use `db.query(...).run(...)`.

- [ ] **Step 2: Run the test — verify it fails**

Run: `bun test tests/mcp/recall.pagination.test.ts`
Expected: FAIL — `recall` still uses `limit`, does not emit `page X / Y`, and does not emit `+N more`.

- [ ] **Step 3: Update `RecallInput` and defaults**

In `src/mcp/recall.ts`, update the input interface:

```typescript
export interface RecallInput {
  id?: string;
  query?: string;
  time?: string;
  depth?: "collapsed" | "expanded";
  page?: number;
  pageSize?: number;
  truncate?: number;
}
```

Locate the old `const limit = input.limit ?? 50;` near line 1147 and replace with:

```typescript
const depth = input.depth ?? "collapsed";
const page = Math.max(1, input.page ?? 1);
const pageSize = input.pageSize ?? (depth === "collapsed" ? 50 : 10);
const offset = (page - 1) * pageSize;
const truncate = input.truncate ?? 200;
```

- [ ] **Step 4: Replace every `sampleWithOmissions` call**

Grep for `sampleWithOmissions` inside `src/mcp/recall.ts`. For each call site (`renderSession`, `renderTurnScope`, `renderObservationScope` — both branches), replace with:

**Top-level (when this collection is the pagination target)**:

```typescript
// items is the full collection fetched from the DB
const total = items.length;
const pageItems = items.slice(offset, offset + pageSize);
const pageCount = Math.max(1, Math.ceil(total / pageSize));

const rendered = pageItems.map((item) => renderNode(
  { type: "turn", value: item },
  { depth, truncate, mode: "unified" },
));

return [
  `page ${page} / ${pageCount} (total ${total})`,
  ...rendered,
].join("\n");
```

**Child preview (when this collection is not the target)**:

```typescript
const preview = items.slice(0, 5);
const rendered = preview.map((item) => renderNode(
  { type: "observation", value: item },
  { depth: "collapsed", truncate, mode: "unified" },
));
const remainder = items.length - preview.length;
const suffix = remainder > 0 ? [`  +${remainder} more`] : [];
return [...rendered, ...suffix].join("\n");
```

Identifying which call site is "target" vs "child" depends on the routed selector. Rule of thumb:
- If the selector's last segment matches the collection (e.g. `S12/T*` → turns are target), use pagination block.
- Otherwise (e.g. `S12` → turns are a child preview of the session), use the fixed-5 block.

The existing `routed` parser in `recall.ts` already knows which level is target. Reuse that signal; do not re-parse.

- [ ] **Step 5: Remove the `isProtected` sampling callback**

The "active turn always visible" guarantee is now enforced by the SQL ORDER BY. Verify that `src/db/turns.ts`'s `getTurnsForSession` (or whatever helper recall uses) orders `active` turns first. If it does not, add `ORDER BY CASE WHEN status='active' THEN 0 ELSE 1 END, prompt_number ASC`.

Check the actual ordering currently in `src/db/turns.ts`. If it is already deterministic by `prompt_number ASC`, and active turns can appear anywhere in that ordering, then the guarantee is weaker than before. Accept this — the user confirmed via D4 that the explicit SQL ordering is sufficient, and active turns are typically the most recent anyway.

- [ ] **Step 6: Run the pagination test — verify it passes**

Run: `bun test tests/mcp/recall.pagination.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the full recall suite**

Run: `bun test tests/mcp/recall.test.ts`
Expected: existing tests may fail on changed output (`page X / Y` headers, new defaults). Update assertions where necessary, keeping semantic expectations intact.

- [ ] **Step 8: Commit**

```bash
git add src/mcp/recall.ts tests/mcp/recall.test.ts tests/mcp/recall.pagination.test.ts
git commit -m "refactor(recall): replace limit with page/pageSize + child preview cap

- Default pageSize: 50 (collapsed), 10 (expanded).
- Output header shows 'page N / M (total K)'.
- Child collections capped at 5 with '+N more' marker.
- sampleWithOmissions usages all removed.
- Truncate threaded through to renderNode."
```

---

### Task 4: Add `jsonlPath` to `FormattedSession` and populate in recall

Session views at `expanded` depth surface the exact JSONL path so agents can jump straight from a recall result to `Read(path)` without an extra lookup.

**Files:**
- Modify: `src/mcp/format.ts` (type)
- Modify: `src/mcp/recall.ts` (population)
- Modify: `src/hooks/handlers/context.ts` (population — same helper)
- Modify: `src/shared/paths.ts` (if `resolveTranscriptPath` is not already reusable)
- Test: `tests/mcp/recall.test.ts`

- [ ] **Step 1: Write failing test**

Add to `tests/mcp/recall.test.ts`:

```typescript
it("expanded session output contains jsonlPath", () => {
  const db = createDatabase({ path: ":memory:" });
  initializeDatabase(db);

  upsertSession(db, {
    contentSessionId: "abc-uuid",
    project: "/Users/test/Projects/foo",
    title: "with path",
    content: null,
    insight: null,
    createdAtEpoch: 1000,
    updatedAtEpoch: 1000,
    completedAtEpoch: null,
  });

  const output = recallMemory(db, {
    id: "S1",
    depth: "expanded",
  });

  expect(output).toContain("abc-uuid.jsonl");
  expect(output).toContain("/Users/test/Projects/foo");
});

it("collapsed session output omits jsonlPath", () => {
  const db = createDatabase({ path: ":memory:" });
  initializeDatabase(db);

  upsertSession(db, {
    contentSessionId: "abc-uuid",
    project: "/Users/test/Projects/foo",
    title: "no path",
    content: null,
    insight: null,
    createdAtEpoch: 1000,
    updatedAtEpoch: 1000,
    completedAtEpoch: null,
  });

  const output = recallMemory(db, {
    id: "S1",
    depth: "collapsed",
  });

  expect(output).not.toContain(".jsonl");
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `bun test tests/mcp/recall.test.ts -t "jsonlPath"`
Expected: FAIL.

- [ ] **Step 3: Add `jsonlPath` field to `FormattedSession`**

In `src/mcp/format.ts`, extend the interface:

```typescript
export interface FormattedSession {
  id: number;
  title: string | null;
  project: string;
  createdAtEpoch: number;
  content: string | null;
  insight: string[];
  nextSteps: string | null;
  turnCount: number;
  observationCount: number;
  /** Absolute path to source JSONL. Populated only at expanded depth. */
  jsonlPath?: string;
}
```

In the session render function within `format.ts`, emit the path when `depth === "expanded"` and `value.jsonlPath` is set:

```typescript
if (options.depth === "expanded" && value.jsonlPath) {
  lines.push(`  raw: ${value.jsonlPath}`);
}
```

- [ ] **Step 4: Populate `jsonlPath` in recall**

In `src/mcp/recall.ts`, wherever `buildSessionView` (or the equivalent) constructs a `FormattedSession`, import `resolveTranscriptPath` from `src/shared/paths` and add:

```typescript
import { resolveTranscriptPath } from "../shared/paths";

// in the builder:
const jsonlPath = depth === "expanded"
  ? resolveTranscriptPath(session.project, session.contentSessionId) ?? undefined
  : undefined;

return {
  // ... existing fields ...
  jsonlPath,
};
```

- [ ] **Step 5: Mirror the change in `context.ts`**

`src/hooks/handlers/context.ts` builds its own `buildSessionView` (lines ~120-135) — update it to pass `jsonlPath` when the depth is expanded. Since SessionStart renders current session at `expanded` and recent sessions at `collapsed`, the primary session gets the path and the others do not.

- [ ] **Step 6: Run the tests — verify they pass**

Run: `bun test tests/mcp/recall.test.ts -t "jsonlPath"`
Expected: PASS.

Run: `bun test tests/hooks/context.test.ts`
Expected: existing tests may show the new `raw:` line in the primary session block — update assertions.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/format.ts src/mcp/recall.ts src/hooks/handlers/context.ts tests/mcp/recall.test.ts tests/hooks/context.test.ts
git commit -m "feat(recall): surface jsonlPath on expanded session views

Agents can jump from a recall result straight to Read(jsonl_path)
without an extra DB lookup. Collapsed output is unchanged."
```

---

### Task 5: Update `src/hooks/handlers/context.ts` for explicit conservative params

SessionStart context is tight — it should not drift when recall defaults change. Pass explicit `truncate: 120, pageSize: 5` for recent session rendering and keep the current session at a slightly larger budget.

**Note:** Task 1 already fixed the `EMPTY_CONTEXT_FALLBACK` and `buildHeader` help-line strings in this file as part of the tool-surface cutover. This task only touches `buildCurrentSessionOutput` and `buildRecentSessionsOutput` to pass explicit render options.

**Files:**
- Modify: `src/hooks/handlers/context.ts`
- Test: `tests/hooks/context.test.ts`

- [ ] **Step 1: Write failing test**

Add to `tests/hooks/context.test.ts`:

```typescript
it("SessionStart context passes conservative render options", () => {
  const db = buildTestDb(); // helper from existing test file
  // seed a session with long content
  // ...
  const handler = createContextHandler({ db });
  const result = await handler({
    sessionId: "abc",
    cwd: "/tmp",
    prompt: "hello",
    transcriptPath: null,
  });

  const text = result.hookSpecificOutput ?? "";
  // Primary session content is truncated at 120 chars.
  expect(text).toMatch(/.{120}\.\.\./);
  // Recent sessions list shows at most 4 (pageSize 5 minus the primary).
  const recentSessionLines = text
    .split("## Recent Sessions")[1]
    ?.split("\n")
    .filter((line) => line.startsWith("- [S")) ?? [];
  expect(recentSessionLines.length).toBeLessThanOrEqual(4);
});
```

- [ ] **Step 2: Run the test — verify it fails (or green by accident)**

Run: `bun test tests/hooks/context.test.ts -t "conservative"`
Expected: FAIL — current render passes `{ depth: "expanded", mode: "legacy" }` with no truncate.

- [ ] **Step 3: Pass explicit params in `context.ts`**

In `buildCurrentSessionOutput` (around line 181-202):

```typescript
function buildCurrentSessionOutput(
  session: FormattedSession,
  turns: FormattedTurn[],
): string {
  const lines = [
    formatModule.renderNode(
      { type: "session", value: session },
      { depth: "expanded", truncate: 120, mode: "unified" },
    ),
  ];

  for (const turn of turns.slice(0, 5)) {
    lines.push(
      formatModule.renderNode(
        { type: "turn", value: turn },
        { depth: "collapsed", truncate: 120, mode: "unified" },
      ),
    );
  }

  return lines.join("\n");
}
```

In `buildRecentSessionsOutput` (around line 204-219):

```typescript
function buildRecentSessionsOutput(
  recentSessions: SessionRecord[],
  sessionMetrics: Map<number, { turnCount: number; observationCount: number }>,
  primarySessionId: number,
): string[] {
  const others = recentSessions
    .filter((session) => session.id !== primarySessionId)
    .slice(0, 4);

  return others
    .map((session) => buildSessionView(session, sessionMetrics.get(session.id)))
    .map((session) =>
      formatModule.renderNode(
        { type: "session", value: session },
        { depth: "collapsed", truncate: 120, mode: "unified" },
      ),
    );
}
```

Note: `mode` switches from `"legacy"` to `"unified"` to match the rest of the refactor. If the legacy mode had snapshot-visible differences the context test captures, update the snapshot.

The header builder's `Expand:` line and `EMPTY_CONTEXT_FALLBACK` were already updated in Task 1 Step 11 — verify they still point at the mnemo-replay skill before committing this task.

- [ ] **Step 4: Run the context test**

Run: `bun test tests/hooks/context.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/handlers/context.ts tests/hooks/context.test.ts
git commit -m "refactor(hooks): pass explicit truncate/pageSize in SessionStart

SessionStart is token-budget-sensitive — hardcode truncate=120 and
the 5-item recent-sessions cap rather than inheriting whatever the
recall defaults happen to be on any given day."
```

---

### Task 6: Rewrite `plugin/skills/mnemo-recall/SKILL.md`

Remove every `replay(...)` example. Document the new `page`/`pageSize`/`truncate` params. Point at the `mnemo-replay` skill for raw JSONL.

**Files:**
- Modify: `plugin/skills/mnemo-recall/SKILL.md`

- [ ] **Step 1: Replace the file contents**

Write the full new SKILL.md. The structure below is the target:

```markdown
---
name: mnemo-recall
description: Search and read structured memory from past sessions in this project. Use when the user asks "did we already do this?", "how did we fix X last time?", "what happened last week?", or when you need context from a previous conversation before answering.
---

# Mnemo Recall

`recall` is the **semantic index** over past sessions — titles, types, tags, short content. It is paginated and truncated. For raw transcript content (exact prompts, full tool output), use the `mnemo-replay` skill — not a tool, a pointer to the source files.

**Three axes of read access**:
- `recall` — what / where — structured semantic index
- `timeline` — when / how — temporal narrative of one session (see the mnemo-timeline skill once it lands)
- `mnemo-replay` skill — raw truth — direct JSONL and SQLite reads

**Rule of thumb**: start broad, drill into detail. The default `collapsed` depth is 5-10× cheaper than `expanded`. When a recall result is enough, stop there — only go to raw when exact wording or full tool output matters.

## When to Use

Use when the user asks about PREVIOUS sessions (not the current one):

- "Did we already solve this?"
- "How did we fix X last time?"
- "What happened in last week's work?"
- "What do we already know about this project?"

Also use *proactively* before answering anything that depends on earlier decisions — the answer may already be indexed.

## Data Model

```
Session  [S12]   one per Claude Code conversation
  Turn     [T3]   one per user prompt (promptNumber-scoped to session)
    Observation [O87]   one per tool call
Memory   [M4]   durable cross-session knowledge
```

Output IDs map directly to selectors:

- `[S12]` → `recall(id="S12")`
- `[S12/T3]` → `recall(id="S12/T3")` (turn = session-scoped promptNumber)
- `[O87]` → `recall(id="O87")` (observation = global DB id)
- `[M4]` → `recall(id="M4")` (memory = global DB id)

## Progressive Workflow

### Step 1 — Browse or search

```
recall()                                        # recent sessions (collapsed, paginated)
recall(query="auth race")                       # FTS across all layers
recall(query="type:bugfix file:src/auth.ts")    # typed filters
recall(query="tag:feedback")                    # memory tag filter
recall(time="-7d")                              # last 7 days
recall(id="M*")                                 # all active memories
```

Returns a paginated list of sessions / turns / observations / memories with titles only (~30-80 tokens each). Page 1 by default; pass `page=2` etc. to navigate.

### Step 2 — Drill into a session

```
recall(id="S12")                                # session summary + 5-turn preview
recall(id="S12/T*")                             # all turns in session, paginated
recall(id="S12/T3..7")                          # turns 3-7 only
recall(id="S12", depth="expanded")              # session + full content + jsonlPath
```

At `expanded` depth on a session, the output includes a `raw:` line with the absolute JSONL path. That path is the handoff to the `mnemo-replay` skill when you need exact content.

### Step 3 — Turn detail and observations

```
recall(id="S12/T3", depth="expanded")           # single turn with prompt + response + files
recall(id="S12/T3/O*")                          # all observations for one turn, paginated
recall(id="S12/T*/O*")                          # all observations across a session, paginated
recall(id="O87", depth="expanded")              # single observation, full content (up to truncate cap)
```

### Step 4 — Raw content when exact wording matters

When the recall output is truncated (look for `...[use mnemo-replay skill → read S12/T3]`), switch to the **mnemo-replay skill** — it tells you the JSONL path layout and shows how to `Read` / `Grep` specific turns from the source file.

You can also raise the `truncate` parameter (up to 2000) to get more content through `recall` directly:

```
recall(id="S12/T3", depth="expanded", truncate=2000)
```

If 2000 is not enough, the answer is always "use the mnemo-replay skill" — there is no unlimited mode on `recall`.

## `recall` Parameter Reference

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Selector. Wildcards (`*`), ranges (`5..10`), and paths (`S12/T3/O*`) supported. See *Selector Grammar* below. |
| `query` | string | Free text + optional prefixes `type:` / `file:` / `project:` / `tag:`. Space-separated tokens, ANDed. |
| `time` | string | `-7d` / `-2w` (relative), `2026-04-01` (single UTC day), `2026-04-01..2026-04-07` (inclusive UTC range). |
| `depth` | string | `collapsed` (default) / `expanded`. |
| `page` | number | 1-indexed page number. Default `1`. |
| `pageSize` | number | Items per page at the target level. Default `50` for `collapsed`, `10` for `expanded`. |
| `truncate` | number | Character cap on each field. Default `200`, max `2000`. |

Omit `id` **and** `query` to get recent sessions.

Child collections (turns under a session, observations under a turn) are always previewed as the first 5 items with a `+N more` marker. To see more, narrow the selector to the child level (e.g. `S12/T*` or `S12/T3/O*`).

### Selector Grammar

| Form | Meaning |
|---|---|
| `S*` / `S12` / `S5..10` | Sessions |
| `S12/T*` / `S12/T3` / `S12/T3..7` | Turns in a session (promptNumber) |
| `S12/T3/O*` | Observations for one turn |
| `S12/T*/O*` | Observations for an entire session |
| `O87` | Single observation (global DB id) |
| `M*` / `M4` / `M1..20` | Memories |

Turn IDs in `S12/T3` are **session-scoped promptNumbers**, not global DB ids. Use the form exactly as it appears in output headers.

### Query Filters

| Prefix | Applies to | Notes |
|---|---|---|
| `type:bugfix` | turns, observations, memories | Matches the `type` field. Turn types: `bugfix` / `feature` / `refactor` / `change` / `discovery` / `decision`. |
| `file:src/auth.ts` | turns, observations | Substring match against `files_read` + `files_modified`. |
| `project:/abs/path` | sessions, turns, observations | Exact match against `session.project` (absolute path). |
| `tag:foo` | memories only | Post-filter; ignores non-memory results. Combine with text terms to narrow. |

Free words become an FTS phrase. Example: `query="token refresh"` → matches rows containing both "token" AND "refresh".

## Depth Guidance

| Depth | Use when |
|---|---|
| `collapsed` | Browsing / listing. Titles + counts only. Default. |
| `expanded` | You have a specific target (one session, turn, or observation) and need full fields. Session view includes `raw:` path for handoff to mnemo-replay. |

There is no `full` depth. If you need untruncated content, either raise `truncate` (max 2000) or use the `mnemo-replay` skill.

## Common Patterns

**"Did we already fix the auth race?"**
```
recall(query="auth race")
# → sees [S12/T3] "Fixed auth mutex"
recall(id="S12/T3", depth="expanded")
# → reads the turn content + insight
```

**"Show me the exact edit to login.ts last Thursday"**
```
recall(query="file:src/login.ts", time="2026-04-03")
# → picks out [S8/T2]
recall(id="S8", depth="expanded")
# → session header shows raw: /Users/.../S8.jsonl
# → use mnemo-replay skill to Read that path for exact diff content
```

**"What feedback has the user given about testing?"**
```
recall(query="tag:feedback testing")
# → list of M-level memories tagged feedback containing "testing"
recall(id="M4", depth="expanded")
# → full memory content + reasoning + application
```

**"What are we working on this week?"**
```
recall(time="-7d")
# → recent sessions
```

## Undone Turns

Turns reverted via sidechain appear with `[undone]` markers. They represent abandoned work — treat them as historical, not current state. The `recall` index filters most undone turns out of rollups.

## Guidance

- Prefer `recall` for navigation, FTS, and structured answers — it is cheap and deduped.
- Narrow with `id` / `query` / `time` **before** raising `depth` or `truncate`.
- Use `project:<path>` to scope to the current repo when the user's question is project-local.
- Omit parameters you do not need — defaults are tuned for browsing.
- When you see `[use mnemo-replay skill → read <id>]` in truncated output, that is your signal to switch to raw access.
```

- [ ] **Step 2: Sanity-check the content**

Read the new SKILL.md once. Confirm:
- No `replay(...)` call examples remain.
- `page`, `pageSize`, `truncate` are in the parameter reference.
- `depth=full` is gone everywhere.
- The hand-off phrase "mnemo-replay skill" is used consistently.

- [ ] **Step 3: Commit**

```bash
git add plugin/skills/mnemo-recall/SKILL.md
git commit -m "docs(skill): rewrite mnemo-recall for new recall surface

- Document page/pageSize/truncate parameters.
- Drop depth=full references.
- Replace replay(...) examples with mnemo-replay skill hand-off.
- Note that expanded session view includes raw jsonlPath."
```

---

### Task 7: Create `plugin/skills/mnemo-replay/SKILL.md`

A new skill that documents raw access paths — JSONL file layout, SQLite DB location, read-only query examples. This is the replacement for the deleted `replay` tool.

**Files:**
- Create: `plugin/skills/mnemo-replay/SKILL.md`

- [ ] **Step 1: Write the new SKILL.md**

Create the file with this content:

```markdown
---
name: mnemo-replay
description: Read raw Claude Code session transcripts and the mnemo SQLite database directly. Use when recall output is truncated, when you need exact user wording or full tool output, or when you want to reconstruct a session's timeline from the source bytes.
---

# Mnemo Replay

Raw access to the source data behind claude-mnemo. This skill is **not a tool** — it tells you where the files live and how to read them with `Read`, `Grep`, and `sqlite3`. You do the filtering; the skill does not.

**When to use**: after `recall` has narrowed you down to a specific session / turn / observation. If you do not already have an ID from `recall`, start there — this skill is for reading raw, not searching.

## Two data sources

| Source | Contents | Tool |
|---|---|---|
| JSONL transcript | The canonical Claude Code session file: every user prompt, assistant response, tool call, and tool result in insertion order. Byte-accurate. | `Read` / `Grep` |
| SQLite DB | The indexed mirror: sessions, turns, observations, memories. Used by `recall`. | `sqlite3` CLI (read-only is safe) |

Use JSONL when you need the exact bytes of a specific turn. Use SQLite when you need cross-session aggregates or joined lookups (e.g. "every turn that modified `src/auth.ts` in the last week").

## JSONL transcripts

### Where they live

Claude Code stores each session's transcript under:

```
~/.claude/projects/<encoded-project-path>/<content-session-id>.jsonl
```

Where `<encoded-project-path>` replaces `/` with `-` in the absolute path. Example:

```
/Users/alice/code/my-app
→ ~/.claude/projects/-Users-alice-code-my-app/<uuid>.jsonl
```

**Easier**: `recall(id="S12", depth="expanded")` includes a `raw:` line with the resolved absolute path. Copy it, then:

```
Read(<absolute path>)
```

### Schema sketch

Each line is one JSON object. Relevant fields:

```jsonc
{
  "type": "user" | "assistant" | "summary",
  "uuid": "<event uuid>",
  "timestamp": "2026-04-11T01:50:47.089Z",
  "message": {
    "role": "user" | "assistant",
    "content": [/* text / tool_use / tool_result blocks */]
  },
  "toolUseResult": /* for tool results, the raw result blob */
}
```

- `message.content` is an array of blocks. A `tool_use` block has `name`, `input`, and `id`. A `tool_result` block has `tool_use_id` and `content`.
- A `summary` entry marks the compact boundary — everything before it is compacted history, everything after is the live session.

### Common patterns

**Read a specific turn by rough position**: pick the nth user message in the file.

```
Grep(pattern='"type":"user"', path='<jsonl path>', -n=true)
```

gives you line numbers. Then:

```
Read(<jsonl path>, offset=<line>, limit=50)
```

**Find all tool uses of a specific tool**:

```
Grep(pattern='"name":"Bash"', path='<jsonl path>', -C=5)
```

**Find the compact boundary**:

```
Grep(pattern='"type":"summary"', path='<jsonl path>', -n=true)
```

**Reconstruct a session shape quickly**: once the mnemo-timeline tool lands, prefer it over manual grepping. Until then, counting `"type":"user"` and `"type":"assistant"` entries gives you a rough timeline.

## SQLite database

### Where it lives

Default location:

```
~/.claude-mnemo/db.sqlite
```

(Adjust if your setup uses a custom `MNEMO_DATA_DIR`.)

### Read-only query pattern

```bash
sqlite3 ~/.claude-mnemo/db.sqlite -cmd ".mode column" -cmd ".headers on" "<query>"
```

**Do not** write through `sqlite3`. Writes must go through the `remember` MCP tool — hand-edits corrupt the pending queue and break the extraction pipeline.

### Relevant tables

| Table | Row = | Key columns |
|---|---|---|
| `sessions` | One Claude Code conversation | `id`, `content_session_id` (UUID), `project`, `title`, `insight`, `created_at_epoch`, `last_compact_turn` |
| `turns` | One user prompt inside a session | `id`, `session_id`, `prompt_number`, `status`, `title`, `content`, `type`, `tags` (JSON array), `created_at_epoch` |
| `observations` | One tool call inside a turn | `id`, `turn_id`, `tool_name`, `description`, `content`, `created_at_epoch` |
| `memories` | Durable cross-session knowledge | `id`, `type`, `scope`, `title`, `content`, `tags`, `status` |

### Useful queries

**Find the JSONL path for S12**:

```sql
SELECT project, content_session_id FROM sessions WHERE id = 12;
```

Then concatenate: `~/.claude/projects/<encoded project>/<content_session_id>.jsonl`.

**All turns of a session, shortest-form**:

```sql
SELECT prompt_number, type, title
FROM turns
WHERE session_id = 12
ORDER BY prompt_number;
```

**Every turn that touched `src/auth.ts` in the last 7 days**:

```sql
SELECT s.id AS session, t.prompt_number AS turn, t.title
FROM turns t
JOIN sessions s ON s.id = t.session_id
WHERE (t.files_read LIKE '%src/auth.ts%' OR t.files_modified LIKE '%src/auth.ts%')
  AND t.created_at_epoch > strftime('%s', 'now', '-7 days')
ORDER BY t.created_at_epoch DESC;
```

**Recent memories by tag**:

```sql
SELECT id, type, scope, title
FROM memories
WHERE tags LIKE '%"feedback"%' AND status = 'active'
ORDER BY updated_at_epoch DESC
LIMIT 20;
```

## When to use which source

| Situation | Use |
|---|---|
| Need exact user prompt wording | JSONL |
| Need full untruncated tool output | JSONL |
| Need to reconstruct pre-compact history | JSONL |
| Need to count or aggregate across sessions | SQLite |
| Need to filter by tag / type / file | SQLite |
| Just want an overview | **neither** — use `recall` |

## Guidance

- Always narrow with `recall` first. Raw access is for the final byte-accurate read, not for searching.
- Never write to the SQLite DB outside of `remember`.
- The `raw:` line in expanded `recall` output is your copy-paste handoff — use it.
- If you need to recover history across compact boundaries, find `"type":"summary"` in the JSONL — that is the compact marker.
```

- [ ] **Step 2: Verify the skill file structure**

Check that:
- YAML frontmatter is valid (`name`, `description`).
- No `replay(...)` tool-style calls anywhere in the body.
- Both JSONL and SQLite paths are documented.
- A clear "when to use which" table exists.

- [ ] **Step 3: Commit**

```bash
git add plugin/skills/mnemo-replay/SKILL.md
git commit -m "docs(skill): add mnemo-replay skill for raw JSONL + SQLite access

This skill replaces the deleted replay MCP tool. It documents:
- JSONL file path layout and line schema.
- SQLite table shapes and read-only query patterns.
- When to use raw access vs the recall index."
```

---

### Task 8: Update `plugin/CLAUDE.md`

The top-level plugin context should list the new tool/skill model: recall (tool) + timeline (tool, separate spec) + mnemo-replay (skill).

**Files:**
- Modify: `plugin/CLAUDE.md`

- [ ] **Step 1: Rewrite the context block**

Replace `plugin/CLAUDE.md` with:

```markdown
<claude-mnemo-context>
Claude-Mnemo is installed in this environment.

Three-axis memory:
- `recall` MCP tool — high-entropy semantic index (what / where)
- `mnemo-replay` skill — raw JSONL + SQLite access (exact truth)
- `mnemo-timeline` skill (when available) — temporal narrative of a single session

Preferred workflow:
1. Call `recall()` to browse recent memory, or `recall(query=...)` / `recall(time=...)` to narrow.
2. Drill with `recall(id="S12/T3", depth="expanded")` when you need fields.
3. Switch to the `mnemo-replay` skill only when exact wording or full tool output matters — the `raw:` line in an expanded recall result is your hand-off.
</claude-mnemo-context>
```

- [ ] **Step 2: Commit**

```bash
git add plugin/CLAUDE.md
git commit -m "docs(plugin): update top-level CLAUDE.md for three-axis memory"
```

---

### Task 9: Update `docs/design.md`

The design document currently says "exactly three MCP tools (remember/recall/replay)" — update the tool surface section and the display-and-rendering section.

**Files:**
- Modify: `docs/design.md`

- [ ] **Step 1: Locate the tool-surface section**

Search `docs/design.md` for "exactly three MCP tools" or "three-tool" phrasing. Likely around line 294-300.

- [ ] **Step 2: Rewrite that section**

Replace the "exactly three" paragraph with:

```markdown
### Tool surface

Claude-Mnemo exposes **two structured MCP tools** plus a raw-access skill:

1. **`remember`** — the single routed write tool (sessions, turns, observations, memories).
2. **`recall`** — the semantic read index. Paginated (`page` + `pageSize`), truncated (`truncate`, default 200, max 2000), depth-controlled (`collapsed` / `expanded`).
3. **`mnemo-replay` skill** — not a tool; a skill that points agents at the raw JSONL transcript and the SQLite database for byte-accurate reads. Agents use `Read` / `Grep` / `sqlite3` directly.

A fourth surface, `timeline` (see `docs/plans/2026-04-11-timeline-view.md`), adds a temporal-narrative read path. It is a separate MCP tool that reuses the `recall` rendering primitives but does not affect the write path or the raw skill.

**Three axes of read access**:

| Axis | Surface | Answers |
|---|---|---|
| Content | `recall` | What is this session about? What did we change? |
| Temporal | `timeline` | How did this session unfold? Where were the gaps and phase transitions? |
| Raw | `mnemo-replay` skill | What were the exact bytes? |

The two structured tools (recall, timeline) are the only tools Mnemosyne's extraction agent sees. Raw access is a main-agent concern, not an extraction concern.
```

- [ ] **Step 3: Locate the Display and Rendering section**

Search for "Display and Rendering" — likely around line 554-574.

- [ ] **Step 4: Update the rendering paragraphs**

Replace any references to:
- `UNIFIED_TRUNCATION_LIMITS` → single `truncate` option, default 200, max 2000
- `limit` parameter → `page` + `pageSize`
- `sampleWithOmissions` head/middle/tail behavior → fixed 5-item preview for child collections, explicit pagination at target level
- `depth=full` → gone; only `collapsed` and `expanded`

Keep the existing architectural description (unified renderer shared across recall / context-handler / future timeline); just update the behavioral specifics.

- [ ] **Step 5: Add a changelog note at the top of the design doc (optional)**

If `docs/design.md` has a "Recent changes" or "History" section, append a one-line entry:

```markdown
- **2026-04-11**: Read surface refactor. Deleted `replay` MCP tool. Pagination replaces `limit`. `depth=full` removed. Single global `truncate` parameter. Raw access moves to the `mnemo-replay` skill.
```

- [ ] **Step 6: Commit**

```bash
git add docs/design.md
git commit -m "docs(design): update tool surface and rendering for read-surface refactor

- Three axes: recall (content), timeline (temporal), mnemo-replay
  skill (raw). Two MCP tools + one skill, not three MCP tools.
- Rendering model: page+pageSize pagination, fixed 5-item child
  preview, global truncate param."
```

---

### Task 10: End-to-end verification + cross-caller audit

No new code. Runs the full suite, inspects every known caller of the removed symbols, and produces the "everything green" commit.

- [ ] **Step 1: Run the full test suite**

Run: `bun test`
Expected: All tests PASS. If any fail, fix in-place and note which task's scope the fix belonged in.

- [ ] **Step 2: Type-check**

Run: `bun run typecheck` (or the project's equivalent; check `package.json` scripts).
Expected: No errors.

- [ ] **Step 3: Grep for residual references to removed symbols**

Run these greps via the Grep tool and verify **zero** matches in `src/`:

| Pattern | Expected hits |
|---|---|
| `replayInputShape` | 0 |
| `replayInputSchema` | 0 |
| `replayMemory` | 0 |
| `"./replay"` or `"../mcp/replay"` | 0 |
| `mcp__mnemo__replay` | 0 |
| `replay\(\)` or `replay\(` | 0 |
| `depth === "full"` or `depth: "full"` | 0 |
| `UNIFIED_TRUNCATION_LIMITS` | 0 |
| `sampleWithOmissions` | 0 |
| `input\.limit` in `src/mcp/recall.ts` | 0 |

Matches in `docs/` or `docs/plans/` are fine (historical records). Matches in `tests/` are only fine if they are negative assertions (e.g. "rejects `limit`" or "does not contain `mcp__mnemo__replay`").

- [ ] **Step 4: Smoke-test the main-agent path**

From the project root:

```bash
bun run dev  # or whichever script starts the MCP server
```

In a separate terminal, list the registered tools through the MCP client of your choice. Expected: exactly `recall` and `remember`. No `replay`.

Kill the server.

- [ ] **Step 5: Re-verify the Mnemosyne prompt invariant (D11)**

The Mnemosyne system prompt was edited in Task 1 Step 8. This step re-verifies the invariant has not regressed:

```
Grep pattern: replay\(
Path: src/worker/query-session.ts
```

Expected: **zero hits**. If any match appears, find where it reentered (likely a rebase or a merge resolving against the old prompt) and remove it before committing.

Also verify the fallback replacement landed:

```
Grep pattern: recall\(\{ id: "<session id>/<turn id>", depth: "expanded", truncate: 2000 \}\)
Path: src/worker/query-session.ts
```

Expected: at least one hit in the Tools section of the prompt.

- [ ] **Step 6: Commit (may be empty if everything is already green)**

```bash
git add -u
git commit --allow-empty -m "chore: verify read-surface refactor is green end-to-end

- Full test suite passes.
- No residual references to replay tool, sampleWithOmissions, or
  depth=full in src/.
- Mnemosyne system prompt no longer mentions the deleted replay tool.
- MCP server exposes exactly two tools: recall, remember."
```

---

## Self-Review Checklist

Run through these once the last task commits.

**Spec coverage**:

- [ ] **D1** (top-level-only pagination) — Task 3 implements; Task 3 child preview cap uses slice(0,5).
- [ ] **D2** (page+pageSize, no cursors) — Task 1 (schema + `RecallInput`), Task 3 (handler semantics).
- [ ] **D3** (depth narrowed to collapsed|expanded) — Task 1 (schema + `RecallInput`), Task 2 (`format.ts` `RenderDepth` type).
- [ ] **D4** (sampleWithOmissions deleted) — Task 2.
- [ ] **D5** (truncate default 200, max 2000) — Task 1 (schema), Task 2 (`format.ts` `DEFAULT_TRUNCATE` / `MAX_TRUNCATE`).
- [ ] **D6** (replay tool deleted) — Task 1 (atomic cutover).
- [ ] **D7** (mnemo-replay skill created) — Task 7.
- [ ] **D8** (jsonlPath on expanded session) — Task 4.
- [ ] **D9** (context.ts conservative params) — Task 5.
- [ ] **D10** (limit removed with no alias) — Task 1 (schema + `RecallInput`), Task 3 (handler semantics).
- [ ] **D11** (Mnemosyne system prompt no longer references `replay()`) — Task 1 Step 8. Task 10 Step 5 re-verifies.
- [ ] `docs/design.md` updated — Task 9.
- [ ] `plugin/CLAUDE.md` updated — Task 8.
- [ ] Skill files updated — Task 6 (mnemo-recall), Task 7 (mnemo-replay).

**Placeholder scan**: search the spec for any of:
- "TBD", "TODO", "implement later"
- "appropriate error handling"
- "similar to Task N" without repeated code

**Type consistency**:
- `RecallInput.depth` is `"collapsed" | "expanded"` in Task 1 (interface edit) and Task 3 (pagination uses it).
- `FormattedSession.jsonlPath` is optional `string | undefined`, added as a type in Task 4 alongside its population. (Task 2 does not touch `FormattedSession`.)
- `truncate` parameter has type `number` (min 1, max 2000) everywhere it appears.
- `NodeRenderOptions.truncate` is optional; callers pass `?? DEFAULT_TRUNCATE`.

**Cross-task consistency**:
- Task 2 deletes `sampleWithOmissions`; Task 3 also grep-confirms no callers. Both need to be done or neither.
- Task 1 is the single atomic cutover for deleting `replay` — schema, handlers, server registration, SDK registration, the tool file itself, the Mnemosyne prompt, and SessionStart strings all land together. No other task depends on replay artifacts still existing.
- Task 5 references `truncate=120` — that value must match what Task 2's `format.ts` accepts (it does, since range is 1-2000).

---

## Interactions with other plans

- **`2026-04-11-mnemo-agent-workdir-isolation.md`**: independent. Worker-side SDK cwd change does not touch the read surface.
- **`2026-04-11-compact-anchor-and-debug-docs.md`**: minor. Compact anchor updates the README debug chapter; this refactor updates `plugin/CLAUDE.md` and `docs/design.md`. If both land in the same week, sequence compact-anchor **before** this refactor so README debug docs reference the pre-refactor API, then this refactor's commit updates them in the same motion.
- **`2026-04-11-timeline-view.md`**: **significant**. The timeline spec was drafted assuming three MCP tools and depth=full. Rebase after this refactor lands:
  - Drop `full` from timeline's depth option.
  - Use `page`/`pageSize` (the timeline spec already does not fight this).
  - Update the "three-axis model" intro to match the new description (two structured tools + raw skill).
  - Confirm timeline's own truncate defaults follow the 200/2000 contract.

**Recommended sequencing**:
1. workdir-isolation (independent, already ready)
2. compact-anchor (independent, already ready)
3. **this refactor** (read-surface-refactor)
4. timeline-view (rebased onto the post-refactor model)
