# Compact Turn and Line Anchors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make two targeted guarantees on top of the existing turn model:

1. Every `/compact` event produces a first-class `type='compact'` turn, written deterministically by a new `PostCompact` hook handler.
2. Every turn row carries `transcript_line_start` — the JSONL line number of the first entry whose `promptId` matches the turn — enabling one-step jumps from recall/timeline output to raw transcript reads.

**Explicitly not a goal:** claiming coverage of every `promptId` group in the transcript. Teleport-generated summary wrappers (`src/utils/teleport.tsx:68` in Claude Code source) and any future unknown slash commands remain invisible to the turn layer. That is the `mnemo-replay` skill's domain, not `recall` or `timeline`.

**Architecture:**

1. **Line number = promptId first-occurrence lookup.** The parser in `src/shared/transcript-parser.ts` tracks line numbers while reading entries. Each `ParsedReplayTurn` carries `transcriptLineStart: number | null`, which the backfill flow writes into the new `turns.transcript_line_start` column. This is independent of any "every promptId is a turn" invariant — we only fill in values for turns that exist.
2. **PostCompact hook creates compact turn.** A new handler in `src/hooks/handlers/post-compact.ts` reads the post-compact transcript, locates the most recent `compact_boundary` system event, finds the immediately-following user entry (the summary wrapper) via its `parentUuid`, and inserts one row with `type='compact'`, `status='extracted'`, populated content and metadata tags. Idempotency via the existing `idx_turns_session_prompt_id` unique index on `(session_id, content_prompt_id)`.
3. **Recall and timeline surface the new data via rendering changes only.** `src/mcp/format.ts` renders `[S/T:L<n>]` when line number is present. No further schema changes, no extraction logic changes, no Mnemosyne behavior changes.

**Tech Stack:** TypeScript, Bun, Zod, SQLite (bun:sqlite), Claude Agent SDK hooks system.

---

## Context — why this spec exists

During the 2026-04-11 timeline design session, an empirical recovery test on this project's own session JSONL (file `2e26a8aa-c1ad-4ca4-922e-e0023415ff20.jsonl`, 1142 lines, two `/compact` events) surfaced two concrete gaps in how mnemo models session history:

1. **`/compact` is invisible in the turn layer.** Claude Code's `PreCompact` hook is wired only to notify the worker; no turn row is ever created for a compact event. The summary wrapper that Claude Code emits (`src/services/compact/prompt.ts:345` in CC source: `"This session is being continued from a previous conversation..."`) arrives as a `type:"user"` entry with its own `promptId`, but `UserPromptSubmit` does not fire on it (the summary is system-generated, not user-submitted). The `promptId` gets *counted* by `countUserPromptsInTranscript`, so subsequent real prompts are numbered correctly, but the counted group has no corresponding turn row.

2. **No fast path from `[S/T]` in recall/timeline output to raw JSONL.** Recovery consistently degenerates to `grep '"type":"user"' jsonl` followed by manual `Read(offset=X)` with a guessed offset. The JSONL position is deterministic given a `promptId` — it just isn't stored anywhere.

Empirical scan of 36 local sessions (111 unique `promptId` groups) confirmed that `/compact` is the only `promptId` bypass actually exercised. Grep of Claude Code source confirmed exactly two places that emit `"This session is being continued"` — the `/compact` path (covered by `PostCompact`) and the teleport path (no corresponding hook exists). Teleport was absent from the scan and is out of scope. See D10.

---

## Locked decisions

These answer the open design questions from the 2026-04-11 session. Each was approved by the user. Not open for re-litigation during implementation.

| # | Decision |
|---|---|
| **D1** | New column `turns.transcript_line_start INTEGER` (nullable, no default, no CHECK). Added to `SCHEMA_SQL` in `src/db/schema.ts` for fresh installs, **and** a new `ensureTurnTranscriptLineStartColumn(db)` helper called from `initializeSchema` for existing dev databases — following the same pattern as `ensureSessionLastAgentSessionIdColumn` at `src/db/schema.ts:120-126`. This is required: `hasLegacySchema` at `src/db/schema.ts:212` checks only for observation/session legacy columns and will NOT detect a missing `transcript_line_start` column, so without the ALTER helper, existing DBs would silently skip the new column and crash at write time. No reset of existing data; the ALTER adds the column with NULL defaults for all existing rows. |
| **D2** | Population path: the existing `backfill.ts` flow. No separate sync pass. `updateTurnBackfill` accepts `transcriptLineStart?: number | null` and writes it. Turns that never get backfilled (e.g. very recent pending turns) have `transcript_line_start = NULL` until backfill catches up. |
| **D3** | Parser surface (`src/shared/transcript-parser.ts`): (a) `readAllTranscriptEntries` returns `Array<TranscriptEntry & { lineNumber: number }>` — 1-indexed, matching the split-by-newline order after `readFileSync`. (b) `ParsedReplayTurn` gains `transcriptLineStart: number | null`. (c) A new helper `buildPromptIdLineMap(transcriptPath): Map<string, number>` returns `promptId → first-line number`, reused by both `parseReplayTranscript` and `PostCompact`. |
| **D4** | `parseReplayTranscript` sets each turn's `transcriptLineStart` to the `lineNumber` of the entry that **opened** the turn (the one that caused `startsNewTurn` to return true). This matches "first occurrence of this turn's `promptId` in the visible-user stream" because `startsNewTurn` already gates on exactly that. |
| **D5** | PostCompact handler file: `src/hooks/handlers/post-compact.ts`, factory `createPostCompactHandler({ db })`. Wired in `hook-command.ts:37-45` alongside existing handlers. Adds `"post-compact" → "PostCompact"` to `eventNameFromCommandArgument`. Registers in `plugin/hooks/hooks.json` as a `PostCompact` event (matcher `"manual\|auto"` to mirror the existing `PreCompact` binding), running the same `hook-command.cjs` entry point with a new `post-compact` argv. |
| **D6** | Compact turn row shape (inserted by the handler): `type='compact'`, `status='extracted'`, `title='/compact'`, `content` = raw summary wrapper text (the full `content` string of the summary wrapper entry), `tags` = JSON array `["compact:pre_tokens=<N>", "compact:trigger=<manual\|auto>"]`, `content_prompt_id` = the summary wrapper entry's `promptId`, `transcript_line_start` = the summary wrapper's line number, `tool_call_count = 0`, `user_prompt = NULL`, `assistant_response = NULL`, `insight = NULL`, `files_read = '[]'`, `files_modified = '[]'`. **`prompt_number` is the summary wrapper's own ordinal in the transcript's unique-promptId sequence** — NOT the current total of `countUserPromptsInTranscript`. The correct value is derived by running `parseReplayTranscript(transcriptPath)` and finding the `ParsedReplayTurn` whose `promptId` matches the summary wrapper; that turn's `promptNumber` field is the answer. Using the current total would produce incorrect numbering if the handler runs against a transcript that has newer prompts appended after the wrapper (retry scenarios, delayed execution, backfilling old sessions). |
| **D7** | Idempotency: single `INSERT OR IGNORE` guarded by the existing `idx_turns_session_prompt_id` unique index on `(session_id, content_prompt_id)`. No read-before-write. Re-running the handler on the same transcript state is a no-op that leaves DB row and any Mnemosyne extraction untouched. |
| **D8** | PostCompact handler does **not** call `notifyWorkerCompact`. That remains the existing `PreCompact` handler's job. PostCompact is purely a DB write path and must not duplicate worker-signaling logic. |
| **D9** | Compact turns are invisible to Mnemosyne. The worker's pending queue filters on `status` — `'extracted'` is not in the pending set — so no worker code change is needed. Mnemosyne never sees `type='compact'` rows, which prevents wasted extraction tokens and avoids misleading title/insight generation on a structural marker. |
| **D10** | **No observability for orphan promptIds.** If a future Claude Code change introduces a new summary-wrapper source (teleport, new slash command, etc.), it will be invisible to the turn layer and this spec does NOT try to detect it. The `mnemo-replay` skill is the escape hatch for raw access. We explicitly do not add a "warn on unknown promptId" log path because (a) it creates runtime noise, (b) it's a weak guarantee, (c) the two clean invariants we DO have (`UserPromptSubmit` + `PostCompact`) are sufficient in practice. |
| **D11** | `turn.type` is conceptually extended with `'compact'`, but the DB column is untyped `TEXT` with no `CHECK` constraint, so no schema change is required for the type widening. Consumers (timeline renderer, recall renderer) treat `'compact'` as just another type value. Phase RLE (in `timeline-view.md`) naturally uses it as a run boundary because it's a distinct value. |
| **D12** | Recall render: `[S/T]` → `[S/T:L<n>]` when `transcript_line_start` is non-null; falls back to `[S/T]` when null. Change scoped to `src/mcp/format.ts`. Timeline renderer picks up the same data via the `FormattedTurn` interface (which adopts the `transcriptLineStart` field in this spec's Task 4). |
| **D13** | Timeline-view.md is updated in the **same motion** as this spec (a separate file edit) to absorb three render-side changes: (a) D6 prompt column cap 70 → 200, (b) turn row gains a `line` column, (c) compact turns render inline as normal turn rows, with `type='compact'` producing a visually distinct row and serving as a phase RLE boundary. The timeline-view.md D13 previously covered "two-column title + prompt"; it remains valid but picks up the new column width. See Stage 5 edits to `docs/plans/2026-04-11-timeline-view.md`. |

---

## Non-goals

Explicitly out of scope — adding any of these derails the spec:

- **Backward compatibility for pre-existing DB rows.** Early dev. `transcript_line_start` starts NULL for anything predating this spec, renderer falls back to `[S/T]` for them, and that's it. No migration script.
- **Coverage of all summary-wrapper sources.** Teleport (`src/utils/teleport.tsx:68` in Claude Code source) is a known theoretical bypass with no hook available. Future unknown slash commands are a hypothetical bypass. Both are out of scope per D10.
- **Observability/logging for orphan promptIds.** Explicitly rejected (D10).
- **Partial-update semantics for the `remember` tool.** `updateTurnById` already supports nullish coalescing at the DB layer (`src/db/turns.ts:192-199`), and `remember` already threads through optional fields. G5 (pivot tagging by Mnemosyne) reuses this as-is and is a separate follow-up, not part of this spec.
- **Mnemosyne extraction-logic changes.** Compact turns bypass Mnemosyne entirely via `status='extracted'`. No system prompt edits, no extraction flow edits.
- **Worker pending-queue changes.** Filtering on `status` already excludes `'extracted'`. No code touches the worker.
- **Adding a CHECK constraint to `turn.type`.** The column stays untyped `TEXT`. Adding a constraint would force us to enumerate all legal values and couple DB schema to Mnemosyne's evolving taxonomy.
- **Timeline tool implementation itself.** This spec sets up the data surface; `timeline-view.md` (rebased in Stage 5) consumes it. Implementation of the timeline tool is a separate execution pass after both specs land.

---

## File structure

### Files modified

| File | Responsibility after this spec |
|---|---|
| `src/db/schema.ts` | `SCHEMA_SQL` declares `transcript_line_start INTEGER` in the `turns` table (fresh installs). New `ensureTurnTranscriptLineStartColumn(db)` helper runs inside `initializeSchema` after the `CREATE TABLE IF NOT EXISTS` pass, mirroring `ensureSessionLastAgentSessionIdColumn`, so existing dev DBs pick up the column via `ALTER TABLE turns ADD COLUMN transcript_line_start INTEGER`. |
| `src/db/turns.ts` | `UpdateTurnBackfillInput` gains `transcriptLineStart?: number | null`. `updateTurnBackfill` SQL writes the new column. `TurnRecord` gains a read-side `transcriptLineStart: number | null` field. `mapTurnRow` populates it. |
| `src/shared/transcript-parser.ts` | `readAllTranscriptEntries` return type extends with `lineNumber: number`. `ParsedReplayTurn` gains `transcriptLineStart: number | null`. New exported helper `buildPromptIdLineMap(transcriptPath): Map<string, number>`. `parseReplayTranscript` populates `transcriptLineStart` from the opening entry of each turn group. |
| `src/hooks/backfill.ts` | Threads `transcriptTurn?.transcriptLineStart` into the `updateTurnBackfill` call. |
| `src/hooks/hook-command.ts` | `defaultHandlers` adds `PostCompact: createPostCompactHandler({ db })`. `eventNameFromCommandArgument` adds `"post-compact" → "PostCompact"`. |
| `src/mcp/format.ts` | `FormattedTurn` gains `transcriptLineStart: number | null`. The `[Tn]` formatter renders `[Tn:L<line>]` when the field is non-null, `[Tn]` otherwise. Session-level `[Sn]` rendering is unchanged (sessions do not have line numbers). |
| `src/mcp/recall.ts` | `buildFormattedTurn` (and any sibling builders) pass the DB column through to `FormattedTurn.transcriptLineStart`. No new recall parameters. |
| `plugin/hooks/hooks.json` | Declares `PostCompact` event binding alongside existing `PreCompact`. Matcher `"manual\|auto"`, command `hook-command.cjs post-compact`, timeout 10s. |

### Files created

| File | Responsibility |
|---|---|
| `src/hooks/handlers/post-compact.ts` | `createPostCompactHandler({ db })` factory. Reads post-compact transcript, locates the most recent `compact_boundary` system event, finds the immediately following user entry via `parentUuid`, reads `compactMetadata`, and does a single `INSERT OR IGNORE` into `turns`. |
| `tests/hooks/post-compact.test.ts` | Idempotency tests (same transcript twice → one row), "no compact boundary present" tolerance (returns cleanly, no row written), tag extraction (`pre_tokens` + `trigger` parsed correctly from `compactMetadata`). |
| `tests/shared/transcript-line-map.test.ts` | Unit tests for `buildPromptIdLineMap`: 1-indexed, returns first occurrence, handles multiple promptIds, handles entries without `promptId` correctly. |

### Files deleted

(none)

---

## Implementation order

Each task commits independently; `bun test` and typecheck must be green after every commit.

1. **Task 1 — Schema column + parser line tracking.** `src/db/schema.ts` + `src/shared/transcript-parser.ts` + unit tests for `buildPromptIdLineMap`. Foundation layer: no observable runtime behavior change beyond the new column being writable and the parser emitting the new field.

2. **Task 2 — Backfill integration.** `src/hooks/backfill.ts` + `src/db/turns.ts` (signature + mapRow). Existing turns start accumulating `transcript_line_start` when normal backfill fires. Renderer still ignores the new field until Task 4.

3. **Task 3 — PostCompact handler.** New `src/hooks/handlers/post-compact.ts` + `src/hooks/hook-command.ts` registration + `plugin/hooks.json` declaration + unit tests covering idempotency, missing-boundary tolerance, and metadata extraction. From this commit forward, every `/compact` event produces a compact turn row.

4. **Task 4 — Renderer surfaces line numbers.** `src/mcp/format.ts` + `src/mcp/recall.ts` (minimal builder wire-through). Recall output starts showing `[S/T:L<n>]`.

5. **Task 5 — End-to-end verification.** Full suite green, grep checks, smoke test of a real `/compact` → compact turn round trip.

**Parallel motion (same conversation, separate file):** `docs/plans/2026-04-11-timeline-view.md` is edited in Stage 5 to absorb (a) the prompt column cap change 70 → 200, (b) the new `line` column in the turn-row format, (c) compact turns rendering inline as a distinct row type. The timeline implementation itself remains a separate execution pass after both specs land.

---

### Task 1: Schema column + parser line tracking

**Scope:** Add the `transcript_line_start INTEGER` column to the `turns` table, and teach the transcript parser to track per-entry line numbers and expose them via `buildPromptIdLineMap` plus a new field on `ParsedReplayTurn`. No observable runtime behavior change beyond the new column being writable and the parser returning the new field — nothing reads it yet.

**Files:**
- Modify: `src/db/schema.ts` (add column to `SCHEMA_SQL`)
- Modify: `src/shared/transcript-parser.ts` (line tracking, new helper, field on `ParsedReplayTurn`)
- Create: `tests/shared/transcript-line-map.test.ts`

- [ ] **Step 1: Write failing test for `buildPromptIdLineMap`**

Create `tests/shared/transcript-line-map.test.ts`:

```typescript
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildPromptIdLineMap } from "../../src/shared/transcript-parser";

describe("buildPromptIdLineMap", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "line-map-"));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeJsonl(name: string, lines: Array<Record<string, unknown>>): string {
    const path = join(tmpDir, name);
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return path;
  }

  it("returns 1-indexed line of each promptId's first occurrence", () => {
    const path = writeJsonl("basic.jsonl", [
      { type: "user", promptId: "pa", uuid: "u1", message: { role: "user", content: "hi" } },
      { type: "assistant", uuid: "u2", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
      { type: "user", promptId: "pb", uuid: "u3", message: { role: "user", content: "second" } },
      { type: "user", promptId: "pb", uuid: "u4", message: { role: "user", content: "<local-command-caveat>x</local-command-caveat>" } },
    ]);

    const map = buildPromptIdLineMap(path);

    expect(map.get("pa")).toBe(1);
    expect(map.get("pb")).toBe(3);
    expect(map.size).toBe(2);
  });

  it("ignores entries without promptId", () => {
    const path = writeJsonl("no-pid.jsonl", [
      { type: "system", subtype: "turn_duration", uuid: "u1" },
      { type: "user", uuid: "u2", message: { role: "user", content: "no pid" } },
      { type: "user", promptId: "px", uuid: "u3", message: { role: "user", content: "with pid" } },
    ]);

    const map = buildPromptIdLineMap(path);

    expect(map.get("px")).toBe(3);
    expect(map.size).toBe(1);
  });

  it("records only the first occurrence when the same promptId repeats", () => {
    const path = writeJsonl("repeats.jsonl", [
      { type: "user", promptId: "p1", uuid: "u1", message: { role: "user", content: "first" } },
      { type: "user", promptId: "p1", uuid: "u2", message: { role: "user", content: "still first group" } },
      { type: "user", promptId: "p2", uuid: "u3", message: { role: "user", content: "second group" } },
    ]);

    const map = buildPromptIdLineMap(path);

    expect(map.get("p1")).toBe(1);
    expect(map.get("p2")).toBe(3);
  });

  it("returns an empty map for an empty or missing transcript", () => {
    const empty = writeJsonl("empty.jsonl", []);
    expect(buildPromptIdLineMap(empty).size).toBe(0);
    expect(buildPromptIdLineMap(join(tmpDir, "does-not-exist.jsonl")).size).toBe(0);
  });
});
```

The test exercises four properties: 1-indexed line numbers, missing-`promptId` entries skipped, first-occurrence-wins semantics, and empty/missing transcript tolerance.

- [ ] **Step 2: Run the test — verify it fails**

```bash
bun test tests/shared/transcript-line-map.test.ts
```

Expected: FAIL — `buildPromptIdLineMap` does not yet exist, import fails at load time.

- [ ] **Step 3: Add `transcript_line_start` column to `src/db/schema.ts`**

Two coordinated edits to the same file.

(a) In `SCHEMA_SQL`, add the new column to the `turns` table DDL (after `tool_call_count`, before `created_at_epoch`):

```sql
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  prompt_number INTEGER NOT NULL,
  content_prompt_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  user_prompt TEXT,
  assistant_response TEXT,
  title TEXT,
  content TEXT,
  insight TEXT,
  type TEXT,
  tags TEXT,
  files_read TEXT,
  files_modified TEXT,
  tool_call_count INTEGER,
  transcript_line_start INTEGER,      -- NEW
  created_at_epoch INTEGER NOT NULL,
  updated_at_epoch INTEGER,
  UNIQUE(session_id, prompt_number)
);
```

(b) Add an `ensureTurnTranscriptLineStartColumn` helper following the existing `ensureSessionLastAgentSessionIdColumn` pattern (currently at `src/db/schema.ts:120-126`), and call it from `initializeSchema` right after the existing `ensureSessionLastAgentSessionIdColumn()` call:

```typescript
export function initializeSchema(db: Database): void {
  db.exec(SCHEMA_SQL);
  ensureSessionLastAgentSessionIdColumn(db);
  ensureTurnTranscriptLineStartColumn(db);   // NEW
  ensureSessionProjectIndex(db);
  ensureTurnPromptIdIndex(db);
}

function ensureTurnTranscriptLineStartColumn(db: Database): void {
  if (hasColumn(db, "turns", "transcript_line_start")) {
    return;
  }

  db.exec("ALTER TABLE turns ADD COLUMN transcript_line_start INTEGER");
}
```

This is mandatory: `hasLegacySchema` at `src/db/schema.ts:212` checks only for observation/session legacy columns and does NOT treat a missing `transcript_line_start` on `turns` as a reset-worthy drift. Without this helper, existing dev databases would:

1. Pass `hasLegacySchema` → skip `resetSchema`
2. Run `db.exec(SCHEMA_SQL)` → no-op on existing `turns` table (because `CREATE TABLE IF NOT EXISTS` doesn't add columns)
3. Silently miss `transcript_line_start` → crash at the first backfill write in Task 2

The ALTER is non-destructive (existing rows get NULL for the new column) and cheap.

- [ ] **Step 4: Extend `src/shared/transcript-parser.ts`**

Four coordinated edits to the same file:

(a) **`readAllTranscriptEntries` returns entries with `lineNumber`.** Change the return type and the split-and-parse loop to attach a 1-indexed line number to each entry. Keep the dedupe-by-uuid logic intact — the line number comes from the pre-dedupe iteration index, so a dropped duplicate still "consumes" its original line.

```typescript
export interface TranscriptEntryWithLine extends TranscriptEntry {
  lineNumber: number;
}

export function readAllTranscriptEntries(transcriptPath: string): TranscriptEntryWithLine[] {
  if (!existsSync(transcriptPath)) {
    return [];
  }

  const rawTranscript = readFileSync(transcriptPath, "utf8");

  if (rawTranscript.trim() === "") {
    return [];
  }

  const rawLines = rawTranscript.split("\n");
  const entries: TranscriptEntryWithLine[] = [];

  for (let i = 0; i < rawLines.length; i += 1) {
    const line = rawLines[i]!.trim();
    if (line === "") {
      continue;
    }

    let raw: RawTranscriptEntry;
    try {
      raw = JSON.parse(line) as RawTranscriptEntry;
    } catch {
      continue;
    }

    const normalized = normalizeEntry(raw);
    if (normalized.isApiErrorMessage) {
      continue;
    }

    entries.push({ ...normalized, lineNumber: i + 1 });
  }

  const seenUuids = new Set<string>();
  const deduped: TranscriptEntryWithLine[] = [];

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

(b) **`readTranscriptEntries` preserves `lineNumber`** when filtering out sidechains and API errors:

```typescript
export function readTranscriptEntries(transcriptPath: string): TranscriptEntryWithLine[] {
  return readAllTranscriptEntries(transcriptPath).filter(
    (entry) => !entry.isSidechain && !entry.isApiErrorMessage,
  );
}
```

The return type widens from `TranscriptEntry[]` to `TranscriptEntryWithLine[]`. Downstream callers that only needed the base shape continue to work because `TranscriptEntryWithLine` extends `TranscriptEntry`.

(c) **Add `buildPromptIdLineMap`**, exported, right after `readAllTranscriptEntries`:

```typescript
export function buildPromptIdLineMap(
  transcriptPath: string,
): Map<string, number> {
  const map = new Map<string, number>();

  for (const entry of readAllTranscriptEntries(transcriptPath)) {
    if (!entry.promptId) {
      continue;
    }
    if (map.has(entry.promptId)) {
      continue;
    }
    map.set(entry.promptId, entry.lineNumber);
  }

  return map;
}
```

Note this reads the **full** transcript including sidechains — a promptId on a sidechain entry still corresponds to a real line number. `parseReplayTranscript` and `parseTranscript` handle sidechain filtering separately.

(d) **`ParsedReplayTurn` gains `transcriptLineStart`**, populated in `parseReplayTranscript` from the entry that opens each turn:

```typescript
export interface ParsedReplayTurn {
  promptNumber: number;
  promptId: string | null;
  userPrompt: string;
  assistantText: string;
  toolCalls: ReplayToolCall[];
  isSidechain: boolean;
  transcriptLineStart: number | null;   // NEW
}
```

In `parseReplayTranscript`, inside the `if (startsNewTurn(...))` branch, set `transcriptLineStart: entry.lineNumber`:

```typescript
currentTurn = {
  promptNumber,
  promptId: entry.promptId ?? null,
  userPrompt,
  assistantText: "",
  toolCalls: [],
  isSidechain: Boolean(entry.isSidechain),
  transcriptLineStart: entry.lineNumber,   // NEW
};
```

`parseTranscript` does **not** need to change — it returns `ParsedTurn[]`, which is a narrower shape consumed by different callers. Task 2's backfill wiring will use `parseReplayTranscript` exclusively.

- [ ] **Step 5: Run the test — verify it passes**

```bash
bun test tests/shared/transcript-line-map.test.ts
```

Expected: PASS.

Also run the existing transcript-parser test suite to catch regressions from the return-type widening:

```bash
bun test tests/shared/
```

Expected: PASS. If any existing test accessed a `TranscriptEntry` field that now has `lineNumber` alongside it, the test still works because `TranscriptEntryWithLine extends TranscriptEntry`.

- [ ] **Step 6: Run the full suite**

```bash
bun test
bun run typecheck
```

Expected: green. The schema-column addition compiles cleanly because no code reads the new column yet.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts src/shared/transcript-parser.ts tests/shared/transcript-line-map.test.ts
git commit -m "feat(parser): track transcript line numbers and add promptId → line map

- Add transcript_line_start column to turns schema.
- readAllTranscriptEntries now attaches 1-indexed lineNumber per entry.
- New buildPromptIdLineMap helper returns promptId → first-occurrence line.
- ParsedReplayTurn gains transcriptLineStart field, populated by
  parseReplayTranscript from the turn's opening entry.

No backfill or renderer changes in this commit — the column is written
only after Task 2 wires it through updateTurnBackfill."
```

---

### Task 2: Backfill integration

**Scope:** Thread `transcriptLineStart` from the parser through `backfill.ts` into `updateTurnBackfill`, and surface it on `TurnRecord` for downstream readers. After this task, any turn that goes through normal backfill accumulates a real `transcript_line_start` value. Renderer still ignores it.

**Files:**
- Modify: `src/db/turns.ts` (signature + mapRow + update SQL)
- Modify: `src/hooks/backfill.ts` (pass `transcriptLineStart` to `updateTurnBackfill`)
- Modify: `tests/hooks/backfill.test.ts` (or wherever backfill tests live — locate via `grep -l updateTurnBackfill tests/`)

- [ ] **Step 1: Audit `updateTurnBackfill` call sites**

```bash
grep -rn "updateTurnBackfill" src/ tests/
```

Expect exactly one call site in `src/hooks/backfill.ts:57` and one definition in `src/db/turns.ts`. If additional call sites exist, list them — all of them must be updated in the same commit.

- [ ] **Step 2: Write failing test for backfill line-number wiring**

Locate the existing backfill test file (`grep -l "backfillFromTranscript" tests/`). Add a new test case that seeds a pending turn, drops a transcript file whose first user entry is at a known line number, runs `backfillFromTranscript`, and asserts the turn's `transcriptLineStart` matches.

```typescript
it("populates transcriptLineStart from the parser's line map", () => {
  const db = createDatabase({ path: ":memory:" });
  initializeDatabase(db);

  const session = upsertSession(db, {
    contentSessionId: "line-test",
    project: "/tmp",
    title: null,
    content: null,
    insight: null,
    createdAtEpoch: 1000,
    updatedAtEpoch: 1000,
    completedAtEpoch: null,
  });

  // Insert a pending turn with a user prompt that matches the transcript.
  db.query(
    `INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch)
     VALUES (?, 1, 'active', ?, ?)`,
  ).run(session.id, "hello world", 1000);

  const pendingTurns = getTurnsForSession(db, session.id);

  // Write a transcript with filler lines before the real user entry,
  // so the expected lineNumber is not 1.
  const transcriptPath = writeJsonl("bf-line.jsonl", [
    { type: "system", subtype: "turn_duration", uuid: "u-pad" },
    { type: "system", subtype: "stop_hook_summary", uuid: "u-pad2" },
    {
      type: "user",
      promptId: "pa",
      uuid: "u1",
      message: { role: "user", content: "hello world" },
    },
    {
      type: "assistant",
      uuid: "u2",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    },
  ]);

  backfillFromTranscript(db, pendingTurns, transcriptPath, "hi");

  const refreshed = getTurnsForSession(db, session.id)[0]!;
  expect(refreshed.transcriptLineStart).toBe(3);
});
```

The test seeds 2 filler lines before the user entry to prove the value isn't a hardcoded `1`. It also exercises the full backfill path (`parseReplayTranscript` → `updateTurnBackfill`), not just the DB helper in isolation.

- [ ] **Step 3: Run the test — verify it fails**

```bash
bun test tests/hooks/backfill.test.ts
```

Expected: FAIL — `transcriptLineStart` is not yet on `TurnRecord`, the field access at the end errors at compile time OR the property is undefined.

- [ ] **Step 4: Extend `UpdateTurnByIdInput` / `TurnRecord` / `mapTurnRow` in `src/db/turns.ts`**

Three coordinated edits:

(a) **`TurnRecord` gains the new read-side field**:

```typescript
export interface TurnRecord {
  id: number;
  sessionId: number;
  promptNumber: number;
  contentPromptId: string | null;
  status: string;
  userPrompt: string | null;
  assistantResponse: string | null;
  title: string | null;
  content: string | null;
  insight: string | null;
  type: string | null;
  tags: string[];
  filesRead: string[];
  filesModified: string[];
  toolCallCount: number | null;
  transcriptLineStart: number | null;   // NEW
  createdAtEpoch: number;
  updatedAtEpoch: number | null;
}
```

(b) **`TurnRow`** (the raw DB-query shape) and **`mapTurnRow`** populate the new field:

```typescript
interface TurnRow {
  // ... existing fields ...
  transcriptLineStart: number | null;
}

function mapTurnRow(row: TurnRow | null | undefined): TurnRecord | null {
  if (!row) return null;
  return {
    // ... existing fields ...
    transcriptLineStart: row.transcriptLineStart ?? null,
    // ... remaining fields ...
  };
}
```

Every `SELECT` that reads from `turns` must alias the new column: `transcript_line_start AS "transcriptLineStart"`. Locate these via `grep -n "FROM turns" src/db/turns.ts` and update each.

(c) **`updateTurnBackfill` accepts the new argument** and writes it:

```typescript
export function updateTurnBackfill(
  db: Database,
  turnId: number,
  assistantResponse: string,
  toolCallCount: number,
  contentPromptId: string | null | undefined,
  transcriptLineStart: number | null | undefined,  // NEW
): TurnRecord | null {
  // Existing: SELECT to get current state, then UPDATE.
  // Add transcript_line_start = COALESCE(?, transcript_line_start) to the UPDATE SET clause,
  // placing the new parameter in the parameter list accordingly.
}
```

Use `COALESCE(?, transcript_line_start)` semantics so that a subsequent backfill with a null value (e.g. transcript missing on a second pass) does not clobber an already-populated value. The PostCompact handler in Task 3 will write the column via a separate `INSERT` path, not through `updateTurnBackfill`.

Adjust the `updateTurnById` path (at `src/db/turns.ts:128`) similarly — add `transcriptLineStart?: number | null` to `UpdateTurnByIdInput`, add `transcript_line_start = ?` (with the nullish-coalescing `input.transcriptLineStart ?? existing.transcriptLineStart` pattern the other fields use) to the SQL. This keeps `remember` tool updates symmetric with backfill.

- [ ] **Step 5: Thread the new argument in `src/hooks/backfill.ts`**

```typescript
updateTurnBackfill(
  db,
  pendingTurn.id,
  assistantResponse,
  toolCallCount,
  transcriptTurn?.promptId,
  transcriptTurn?.transcriptLineStart ?? null,   // NEW
);
```

No other changes to `backfillFromTranscript`. The parser populates `transcriptLineStart` on every `ParsedReplayTurn` (from Task 1), so when a pending turn matches a transcript turn, the line number flows through automatically.

- [ ] **Step 6: Run the test — verify it passes**

```bash
bun test tests/hooks/backfill.test.ts
bun test
bun run typecheck
```

Expected: all green. The renderer still ignores `transcriptLineStart` (Task 4 introduces that), but every existing test should continue to pass because the new field defaults to `null` and none of them assert on it.

- [ ] **Step 7: Commit**

```bash
git add src/db/turns.ts src/hooks/backfill.ts tests/hooks/backfill.test.ts
git commit -m "feat(db): thread transcriptLineStart from parser through backfill

- TurnRecord gains transcriptLineStart: number | null.
- updateTurnBackfill accepts the new argument, writes via COALESCE so
  null on a second pass doesn't clobber a populated value.
- updateTurnById symmetric (nullish coalescing with existing value).
- backfillFromTranscript forwards transcriptTurn.transcriptLineStart.

Renderer still ignores this column; recall/timeline display arrives in
Task 4."
```

---

### Task 3: PostCompact handler

**Scope:** New `src/hooks/handlers/post-compact.ts`. Registered in `hook-command.ts` and declared in `plugin/hooks/hooks.json`. After this task, every `/compact` event produces a single `type='compact'` turn row in the DB, with `content` = raw summary wrapper text and `tags` = `['compact:pre_tokens=<N>', 'compact:trigger=<T>']`. Idempotent via `INSERT OR IGNORE`.

**Files:**
- Create: `src/hooks/handlers/post-compact.ts`
- Create: `tests/hooks/post-compact.test.ts`
- Modify: `src/hooks/hook-command.ts`
- Modify: `plugin/hooks/hooks.json`

- [ ] **Step 1: Write failing handler tests**

Create `tests/hooks/post-compact.test.ts` with four test cases:

```typescript
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase } from "../../src/db/database";
import { initializeDatabase } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurnsForSession } from "../../src/db/turns";
import { createPostCompactHandler } from "../../src/hooks/handlers/post-compact";

describe("createPostCompactHandler", () => {
  let tmpDir: string;
  let db: ReturnType<typeof createDatabase>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "post-compact-"));
    db = createDatabase({ path: ":memory:" });
    initializeDatabase(db);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeJsonl(name: string, entries: Array<Record<string, unknown>>): string {
    const path = join(tmpDir, name);
    writeFileSync(
      path,
      entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    return path;
  }

  function seedSession(contentSessionId = "post-compact-session") {
    return upsertSession(db, {
      contentSessionId,
      project: "/tmp/fake",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1000,
      updatedAtEpoch: 1000,
      completedAtEpoch: null,
    });
  }

  function buildTranscript(): string {
    return writeJsonl("post-compact.jsonl", [
      // A couple of pre-compact real user prompts so prompt_number ≠ 1
      {
        type: "user",
        promptId: "p-real-1",
        uuid: "u-real-1",
        message: { role: "user", content: "first real prompt" },
      },
      {
        type: "user",
        promptId: "p-real-2",
        uuid: "u-real-2",
        message: { role: "user", content: "second real prompt" },
      },
      // compact_boundary system event
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "u-boundary",
        compactMetadata: { trigger: "manual", preTokens: 357725 },
      },
      // summary wrapper — this is the entry the handler must find
      {
        type: "user",
        promptId: "p-compact",
        parentUuid: "u-boundary",
        uuid: "u-summary",
        message: {
          role: "user",
          content: "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary: detailed recap here.",
        },
      },
      // local-command entries that share the same promptId
      {
        type: "user",
        promptId: "p-compact",
        parentUuid: "u-summary",
        uuid: "u-caveat",
        message: { role: "user", content: "<local-command-caveat>x</local-command-caveat>" },
      },
      {
        type: "user",
        promptId: "p-compact",
        parentUuid: "u-caveat",
        uuid: "u-cmd",
        message: { role: "user", content: "<command-name>/compact</command-name>" },
      },
    ]);
  }

  it("inserts one compact turn when a compact_boundary is present", async () => {
    const session = seedSession();
    const transcript = buildTranscript();

    const handler = createPostCompactHandler({ db });
    await handler({
      eventName: "PostCompact",
      sessionId: "post-compact-session",
      cwd: "/tmp/fake",
      transcriptPath: transcript,
      prompt: null,
    } as any);

    const turns = getTurnsForSession(db, session.id);
    const compactTurn = turns.find((t) => t.type === "compact");

    expect(compactTurn).toBeDefined();
    expect(compactTurn!.title).toBe("/compact");
    expect(compactTurn!.status).toBe("extracted");
    expect(compactTurn!.content).toContain("This session is being continued");
    expect(compactTurn!.contentPromptId).toBe("p-compact");
    expect(compactTurn!.tags).toContain("compact:pre_tokens=357725");
    expect(compactTurn!.tags).toContain("compact:trigger=manual");
    expect(compactTurn!.transcriptLineStart).toBe(4); // 1,2 real; 3 boundary; 4 summary
  });

  it("is idempotent — running the handler twice leaves one row", async () => {
    const session = seedSession();
    const transcript = buildTranscript();

    const handler = createPostCompactHandler({ db });
    await handler({
      eventName: "PostCompact",
      sessionId: "post-compact-session",
      cwd: "/tmp/fake",
      transcriptPath: transcript,
      prompt: null,
    } as any);
    await handler({
      eventName: "PostCompact",
      sessionId: "post-compact-session",
      cwd: "/tmp/fake",
      transcriptPath: transcript,
      prompt: null,
    } as any);

    const compactTurns = getTurnsForSession(db, session.id).filter(
      (t) => t.type === "compact",
    );
    expect(compactTurns.length).toBe(1);
  });

  it("returns cleanly when the transcript has no compact_boundary", async () => {
    const session = seedSession();
    const transcript = writeJsonl("no-boundary.jsonl", [
      {
        type: "user",
        promptId: "p-only",
        uuid: "u-only",
        message: { role: "user", content: "no compact here" },
      },
    ]);

    const handler = createPostCompactHandler({ db });
    const result = await handler({
      eventName: "PostCompact",
      sessionId: "post-compact-session",
      cwd: "/tmp/fake",
      transcriptPath: transcript,
      prompt: null,
    } as any);

    expect(result.continue).toBe(true);
    const turns = getTurnsForSession(db, session.id);
    expect(turns.filter((t) => t.type === "compact").length).toBe(0);
  });

  it("uses the MOST RECENT compact_boundary when there are multiple", async () => {
    const session = seedSession();
    // Simulate a session with two compact events
    const transcript = writeJsonl("two-compacts.jsonl", [
      {
        type: "user",
        promptId: "p1",
        uuid: "u1",
        message: { role: "user", content: "first prompt" },
      },
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "u-b1",
        compactMetadata: { trigger: "auto", preTokens: 100000 },
      },
      {
        type: "user",
        promptId: "p-c1",
        parentUuid: "u-b1",
        uuid: "u-s1",
        message: { role: "user", content: "This session is being continued from a previous conversation first compact" },
      },
      {
        type: "user",
        promptId: "p2",
        uuid: "u2",
        message: { role: "user", content: "more work" },
      },
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "u-b2",
        compactMetadata: { trigger: "manual", preTokens: 250000 },
      },
      {
        type: "user",
        promptId: "p-c2",
        parentUuid: "u-b2",
        uuid: "u-s2",
        message: { role: "user", content: "This session is being continued from a previous conversation second compact" },
      },
    ]);

    const handler = createPostCompactHandler({ db });
    await handler({
      eventName: "PostCompact",
      sessionId: "post-compact-session",
      cwd: "/tmp/fake",
      transcriptPath: transcript,
      prompt: null,
    } as any);

    const compactTurns = getTurnsForSession(db, session.id).filter(
      (t) => t.type === "compact",
    );
    // Handler inserts exactly one row per invocation — for the most recent
    // boundary. Earlier compact boundaries already got their own PostCompact
    // invocation when they happened; we do not retroactively backfill.
    expect(compactTurns.length).toBe(1);
    expect(compactTurns[0]!.contentPromptId).toBe("p-c2");
    expect(compactTurns[0]!.tags).toContain("compact:pre_tokens=250000");
    expect(compactTurns[0]!.tags).toContain("compact:trigger=manual");
  });
});
```

Four invariants locked: basic insertion, idempotency, no-boundary tolerance, most-recent-wins for multi-compact sessions.

- [ ] **Step 2: Run the tests — verify they fail**

```bash
bun test tests/hooks/post-compact.test.ts
```

Expected: FAIL — `createPostCompactHandler` does not yet exist.

- [ ] **Step 3: Implement `src/hooks/handlers/post-compact.ts`**

Create the file:

```typescript
import type { Database } from "bun:sqlite";

import { getSessionByContentId } from "../../db/sessions";
import {
  parseReplayTranscript,
  readAllTranscriptEntries,
  type TranscriptEntryWithLine,
} from "../../shared/transcript-parser";
import type { HookResult, NormalizedHookInput } from "../types";

export interface PostCompactHandlerDependencies {
  db: Database;
  now?: () => number;
}

interface CompactMetadata {
  trigger: string;
  preTokens: number | null;
}

function extractCompactMetadata(entry: TranscriptEntryWithLine): CompactMetadata {
  // compactMetadata is a free-form object on the system entry.
  const raw = (entry as unknown as { compactMetadata?: unknown }).compactMetadata;
  if (!raw || typeof raw !== "object") {
    return { trigger: "unknown", preTokens: null };
  }
  const meta = raw as { trigger?: unknown; preTokens?: unknown };
  return {
    trigger: typeof meta.trigger === "string" ? meta.trigger : "unknown",
    preTokens: typeof meta.preTokens === "number" ? meta.preTokens : null,
  };
}

function findLastCompactBoundary(
  entries: TranscriptEntryWithLine[],
): TranscriptEntryWithLine | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (entry.type === "system" && (entry as unknown as { subtype?: unknown }).subtype === "compact_boundary") {
      return entry;
    }
  }
  return null;
}

function findSummaryWrapperAfter(
  entries: TranscriptEntryWithLine[],
  boundaryUuid: string,
): TranscriptEntryWithLine | null {
  const boundaryIdx = entries.findIndex((e) => e.uuid === boundaryUuid);
  if (boundaryIdx < 0) {
    return null;
  }
  for (let i = boundaryIdx + 1; i < entries.length; i += 1) {
    const entry = entries[i]!;
    if (
      entry.type === "user" &&
      entry.parentUuid === boundaryUuid &&
      entry.promptId &&
      typeof entry.content === "string"
    ) {
      return entry;
    }
  }
  return null;
}

function extractContent(entry: TranscriptEntryWithLine): string {
  if (typeof entry.content === "string") {
    return entry.content;
  }
  return "";
}

export function createPostCompactHandler(
  dependencies: PostCompactHandlerDependencies,
) {
  const now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));

  return async function handlePostCompactHook(
    input: NormalizedHookInput,
  ): Promise<HookResult> {
    if (!input.sessionId || !input.transcriptPath) {
      return { continue: true };
    }

    const session = getSessionByContentId(dependencies.db, input.sessionId);
    if (!session) {
      return { continue: true };
    }

    const entries = readAllTranscriptEntries(input.transcriptPath);
    const boundary = findLastCompactBoundary(entries);
    if (!boundary || !boundary.uuid) {
      return { continue: true };
    }

    const summary = findSummaryWrapperAfter(entries, boundary.uuid);
    if (!summary || !summary.promptId) {
      return { continue: true };
    }

    // Derive prompt_number from the summary wrapper's OWN ordinal in the
    // transcript's unique-promptId sequence, not from the current total.
    // parseReplayTranscript produces stable promptNumbers (it walks the
    // transcript in order, deduping by promptId), so even if this handler
    // runs later against a transcript that has newer prompts appended, the
    // wrapper's promptNumber is unchanged.
    const parsedTurns = parseReplayTranscript(input.transcriptPath);
    const summaryTurn = parsedTurns.find(
      (t) => t.promptId === summary.promptId,
    );
    if (!summaryTurn) {
      // Parser couldn't reconstruct the turn — transcript malformed or
      // wrapper filtered unexpectedly. Skip rather than guess.
      return { continue: true };
    }

    const metadata = extractCompactMetadata(boundary);
    const promptNumber = summaryTurn.promptNumber;
    const content = extractContent(summary);
    const tags = [
      `compact:pre_tokens=${metadata.preTokens ?? "unknown"}`,
      `compact:trigger=${metadata.trigger}`,
    ];

    dependencies.db
      .query(
        `
          INSERT INTO turns (
            session_id,
            prompt_number,
            content_prompt_id,
            status,
            title,
            content,
            type,
            tags,
            files_read,
            files_modified,
            tool_call_count,
            transcript_line_start,
            created_at_epoch
          ) VALUES (?, ?, ?, 'extracted', ?, ?, 'compact', ?, '[]', '[]', 0, ?, ?)
          ON CONFLICT(session_id, content_prompt_id) DO NOTHING
        `,
      )
      .run(
        session.id,
        promptNumber,
        summary.promptId,
        "/compact",
        content,
        JSON.stringify(tags),
        summary.lineNumber,
        now(),
      );

    return { continue: true };
  };
}
```

Notes on design decisions encoded in this implementation:

- **`prompt_number` comes from `parseReplayTranscript`, not from `countUserPromptsInTranscript`.** Parsing the whole transcript into ordered `ParsedReplayTurn[]` and looking up the summary wrapper by `promptId` gives a stable ordinal (the wrapper's own position in the unique-promptId sequence). This remains correct if the handler is ever invoked on a transcript that has newer prompts appended after the wrapper — a retry, a crash-recovery, or a hypothetical backfill over old sessions. Using the current total would silently produce wrong `prompt_number` values in those cases, which would corrupt the per-session `(session_id, prompt_number)` uniqueness invariant.
- **`INSERT OR IGNORE` via the `ON CONFLICT` clause** uses the existing `idx_turns_session_prompt_id` unique index. No read-before-write.
- **`status = 'extracted'`** means the worker's pending-queue scan will never pick up compact turns, so Mnemosyne never sees them. No worker code change needed.
- **No call to `notifyWorkerCompact`** — PreCompact handler already handles that signal. PostCompact is purely a DB write path (D8).
- **`compactMetadata` access via unchecked cast** — the `TranscriptEntry` type in `transcript-parser.ts` does not model system events' metadata because system events are normally filtered out. Rather than widening the type, we do a narrow `unknown` cast here, scoped to this one handler.

- [ ] **Step 4: Register in `src/hooks/hook-command.ts`**

Three small edits:

(a) Import:

```typescript
import { createPostCompactHandler } from "./handlers/post-compact";
```

(b) `defaultHandlers` entry:

```typescript
defaultHandlers = {
  SessionStart: createContextHandler({ db }),
  PostToolUse: createPostToolUseHandler({ db }),
  PreCompact: createCompactHandler({ db }),
  PostCompact: createPostCompactHandler({ db }),   // NEW
  UserPromptSubmit: createSessionInitHandler({ db }),
  Stop: createStopHandler({ db }),
};
```

(c) `eventNameFromCommandArgument` — add the new argv mapping:

```typescript
function eventNameFromCommandArgument(arg?: string): string | undefined {
  switch (arg) {
    case "context":
      return "SessionStart";
    case "tool-use":
      return "PostToolUse";
    case "compact":
      return "PreCompact";
    case "post-compact":          // NEW
      return "PostCompact";       // NEW
    case "session-init":
      return "UserPromptSubmit";
    case "stop":
      return "Stop";
    default:
      return undefined;
  }
}
```

- [ ] **Step 5: Declare the event in `plugin/hooks/hooks.json`**

Add a new top-level entry to the `hooks` object, mirroring the existing `PreCompact` shape:

```json
"PostCompact": [
  {
    "matcher": "manual|auto",
    "hooks": [
      {
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/bun-runner.js ${CLAUDE_PLUGIN_ROOT}/scripts/hook-command.cjs post-compact",
        "timeout": 10
      }
    ]
  }
]
```

The 10s timeout matches `SessionStart` and is sufficient for a single DB insert + transcript re-parse. The matcher `"manual|auto"` mirrors `PreCompact` and covers both interactive `/compact` and automatic compaction.

- [ ] **Step 6: Run the tests — verify they pass**

```bash
bun test tests/hooks/post-compact.test.ts
bun test
bun run typecheck
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/hooks/handlers/post-compact.ts src/hooks/hook-command.ts \
        plugin/hooks/hooks.json tests/hooks/post-compact.test.ts
git commit -m "feat(hooks): create compact turn via PostCompact handler

- New src/hooks/handlers/post-compact.ts reads the post-compact
  transcript, locates the most recent compact_boundary system event,
  finds the immediately-following summary wrapper via parentUuid,
  and inserts a single turn with type='compact', status='extracted',
  content=summary wrapper text, tags=[pre_tokens, trigger].
- Idempotent via INSERT OR IGNORE on the existing
  idx_turns_session_prompt_id unique index.
- Registered in hook-command.ts and plugin/hooks/hooks.json.
- Worker's pending queue ignores status='extracted' → Mnemosyne
  never sees compact turns."
```

---

### Task 4: Surface line numbers in the recall renderer

**Scope:** `src/mcp/format.ts` renders turn identifiers as `[S/T:L<line>]` when `transcript_line_start` is non-null, falling back to `[S/T]` when null. `src/mcp/recall.ts` threads the DB column into `FormattedTurn` via the existing builder. No behavior change beyond the one-line renderer modification and the interface widening.

**Files:**
- Modify: `src/mcp/format.ts` (`FormattedTurn` interface + every `[Tn]` emission)
- Modify: `src/mcp/recall.ts` (population of `transcriptLineStart` in the `FormattedTurn` builder)
- Modify: `tests/mcp/format.test.ts` (or `format.truncate.test.ts`) — assert `:L<n>` suffix behavior
- Modify: `tests/mcp/recall.test.ts` — existing turn-list assertions may need `:L<n>` appended

- [ ] **Step 1: Audit current `[Tn]` emission sites in `format.ts`**

```bash
grep -n '\[T' src/mcp/format.ts
```

Expect several hits across `renderTurnCollapsed`, `renderTurnExpanded`, and any session-level child preview that emits turn rows. Every hit must be updated — the renderer's turn-id format is the single source of truth for recall output and, via reuse, timeline output.

- [ ] **Step 2: Write failing renderer tests**

Append to `tests/mcp/format.test.ts` (or create a dedicated file `tests/mcp/format.line-anchor.test.ts` if the existing one is large):

```typescript
import { describe, expect, it } from "bun:test";
import { renderNode, type FormattedTurn } from "../../src/mcp/format";

function turn(overrides: Partial<FormattedTurn> = {}): FormattedTurn {
  return {
    id: 1,
    sessionId: 42,
    promptNumber: 5,
    title: "fix auth",
    content: "short",
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
    transcriptLineStart: null,
    ...overrides,
  };
}

describe("renderNode turn id line anchor", () => {
  it("emits [S42/T5:L123] when transcriptLineStart is populated", () => {
    const rendered = renderNode(
      { type: "turn", value: turn({ transcriptLineStart: 123 }) },
      { depth: "collapsed", mode: "unified" },
    );
    expect(rendered).toContain("[S42/T5:L123]");
    expect(rendered).not.toContain("[S42/T5]");
  });

  it("falls back to [S42/T5] when transcriptLineStart is null", () => {
    const rendered = renderNode(
      { type: "turn", value: turn({ transcriptLineStart: null }) },
      { depth: "collapsed", mode: "unified" },
    );
    expect(rendered).toContain("[S42/T5]");
    expect(rendered).not.toContain(":L");
  });

  it("expanded depth also shows the line anchor", () => {
    const rendered = renderNode(
      { type: "turn", value: turn({ transcriptLineStart: 520 }) },
      { depth: "expanded", mode: "unified" },
    );
    expect(rendered).toContain("[S42/T5:L520]");
  });
});
```

Note: `FormattedTurn` needs a `sessionId` field for the `[Sn/Tn:Ln]` rendering to work. If it doesn't already have one, check how the current renderer produces the `S42` segment and match that mechanism. If the current code passes session context via `NodeRenderOptions`, keep that pattern and add the line anchor to the existing emission path.

- [ ] **Step 3: Run the tests — verify they fail**

```bash
bun test tests/mcp/format.test.ts
```

Expected: FAIL — `transcriptLineStart` is not on `FormattedTurn` (compile error or undefined access), AND the current emission does not include `:L<n>`.

- [ ] **Step 4: Extend `FormattedTurn` and update every turn-id emission**

In `src/mcp/format.ts`:

(a) Add the field to the interface:

```typescript
export interface FormattedTurn {
  // ... existing fields ...
  transcriptLineStart: number | null;
}
```

(b) Introduce a small helper for the id rendering, and replace every hardcoded `[T${promptNumber}]` or `[S${sessionId}/T${promptNumber}]` emission with a call to it:

```typescript
function formatTurnId(turn: FormattedTurn, includeSession: boolean): string {
  const core = includeSession
    ? `S${turn.sessionId}/T${turn.promptNumber}`
    : `T${turn.promptNumber}`;
  const suffix =
    turn.transcriptLineStart !== null ? `:L${turn.transcriptLineStart}` : "";
  return `[${core}${suffix}]`;
}
```

Grep for every `[T${...}]` / `[S${...}/T${...}]` template literal in the file and replace with the helper call. Two likely call sites: the collapsed turn row and the expanded turn header. If the existing code computes the session segment differently (e.g. from a render option rather than the turn), pass `includeSession: true/false` accordingly.

(c) **Do not touch `[Sn]` rendering.** Sessions do not have line numbers. Only turn ids get the `:L<n>` suffix.

(d) **Do not touch `[On]` or `[Mn]` rendering.** Observations and memories are not in scope for this spec; they keep their existing id formats.

- [ ] **Step 5: Thread `transcriptLineStart` through `src/mcp/recall.ts`**

In the function that builds `FormattedTurn` from a `TurnRecord` (likely named `buildFormattedTurn` or similar — locate via `grep -n "FormattedTurn" src/mcp/recall.ts`), add the new field:

```typescript
function buildFormattedTurn(turn: TurnRecord, ...): FormattedTurn {
  return {
    // ... existing fields ...
    transcriptLineStart: turn.transcriptLineStart,
  };
}
```

No recall input or query logic changes. No new parameters.

- [ ] **Step 6: Run the format tests**

```bash
bun test tests/mcp/format.test.ts
```

Expected: the new line-anchor tests pass. Existing snapshot tests may fail because the rendered `[T]` strings now include `:L<n>` when data is present. Update snapshots where the fixture turns have populated `transcript_line_start`; for fixtures where the field is null, the output should be unchanged.

- [ ] **Step 7: Run the recall tests**

```bash
bun test tests/mcp/recall.test.ts
```

Expected: some assertions that grep for `[T5]` in output strings may need to become `[T5:L<n>]` when the seeded data includes line numbers, OR the test fixtures can explicitly leave `transcript_line_start = NULL` to keep the old format. Pick whichever is least invasive per test. The goal is to preserve semantic coverage without over-coupling tests to the anchor format.

- [ ] **Step 8: Run the full suite**

```bash
bun test
bun run typecheck
```

Expected: green.

- [ ] **Step 9: Commit**

```bash
git add src/mcp/format.ts src/mcp/recall.ts tests/mcp/format.test.ts tests/mcp/recall.test.ts
git commit -m "feat(recall): surface transcript line anchor in turn ids

Turn-id rendering becomes [S/T:L<n>] when transcript_line_start is
populated, falling back to [S/T] when null. Single renderer change
in format.ts propagates to all recall output.

Enables one-step jumps from recall output to raw JSONL via the
mnemo-replay skill (Read offset=<line>)."
```

---

### Task 5: End-to-end verification

No new code. Runs the full suite, confirms the grep invariants, and smoke-tests a real `/compact` → compact turn round trip on a dev database.

- [ ] **Step 1: Run the full suite and typecheck**

```bash
bun test
bun run typecheck
```

Expected: all green.

- [ ] **Step 2: Grep invariants**

Run these and confirm each matches expectations:

| Pattern | Where | Expected |
|---|---|---|
| `transcript_line_start` | `src/db/schema.ts` | exactly 1 hit (the column declaration) |
| `transcriptLineStart` | `src/` | hits in schema-adjacent files: `turns.ts`, `transcript-parser.ts`, `backfill.ts`, `format.ts`, `recall.ts`, `post-compact.ts` |
| `buildPromptIdLineMap` | `src/` | hits in `transcript-parser.ts` (def) and `post-compact.ts` (import, optional — only if the handler uses it directly; it uses `readAllTranscriptEntries` instead) |
| `PostCompact` | `src/hooks/hook-command.ts` | exactly 1 hit in `defaultHandlers` |
| `post-compact` | `src/hooks/hook-command.ts` | exactly 1 hit in `eventNameFromCommandArgument` |
| `PostCompact` | `plugin/hooks/hooks.json` | exactly 1 top-level hook entry |
| `type='compact'` or `'compact'` as turn type | `src/mcp/format.ts` / `src/mcp/recall.ts` | **zero** special-casing hits — compact turns render via the normal turn path, phase-by-type logic in timeline will pick them up later |

- [ ] **Step 3: Smoke test — real `/compact` round trip**

On a scratch dev session:

1. Reset `~/.claude-mnemo/db.sqlite` (early dev permits this).
2. Start a Claude Code session in the claude-mnemo project.
3. Type a few real prompts to produce normal turns.
4. Type `/compact`. Wait for completion.
5. Query the DB:
   ```bash
   sqlite3 ~/.claude-mnemo/db.sqlite \
     "SELECT id, prompt_number, type, status, title, content_prompt_id, transcript_line_start, tags
      FROM turns WHERE type = 'compact' ORDER BY id DESC LIMIT 5;"
   ```
6. Expect at least one row with `type='compact'`, `status='extracted'`, a non-null `transcript_line_start`, and `tags` containing `compact:pre_tokens=...` and `compact:trigger=manual`.
7. Call `recall(id="S<n>")` — the compact turn should appear in the expanded view with `[S<n>/T<m>:L<line>]` formatting.

- [ ] **Step 4: Commit (allow empty)**

```bash
git add -u
git commit --allow-empty -m "chore: verify compact-turn-and-line-anchors end-to-end

- Full test suite green.
- Grep invariants confirmed.
- Smoke test: /compact in a dev session produces a type='compact'
  row with non-null transcript_line_start."
```

---

## Self-Review Checklist

Run through these once Task 5 commits. Each should be a one-line yes/no against a file:line or a grep result.

**Decision coverage:**

- [ ] **D1** — `turns.transcript_line_start INTEGER` declared in `SCHEMA_SQL` → `src/db/schema.ts`.
- [ ] **D2** — `updateTurnBackfill` accepts and writes `transcriptLineStart` via `COALESCE` → `src/db/turns.ts`.
- [ ] **D3** — `readAllTranscriptEntries` returns `TranscriptEntryWithLine[]`; `buildPromptIdLineMap` exported → `src/shared/transcript-parser.ts`.
- [ ] **D4** — `parseReplayTranscript` sets `transcriptLineStart` from the opening entry's `lineNumber` → `src/shared/transcript-parser.ts`.
- [ ] **D5** — `createPostCompactHandler` in `src/hooks/handlers/post-compact.ts`; registered in `hook-command.ts` and `plugin/hooks/hooks.json`.
- [ ] **D6** — Compact turn row has `type='compact'`, `status='extracted'`, `title='/compact'`, `content` = summary wrapper text, `tags` = `[pre_tokens, trigger]`.
- [ ] **D7** — `INSERT OR IGNORE ... ON CONFLICT(session_id, content_prompt_id) DO NOTHING`; idempotency test passes.
- [ ] **D8** — PostCompact handler does NOT call `notifyWorkerCompact` (grep check on `src/hooks/handlers/post-compact.ts`).
- [ ] **D9** — Worker pending-queue code unchanged; compact turns have `status='extracted'` which is outside the pending set.
- [ ] **D10** — No orphan-promptId detection / logging anywhere in `src/`.
- [ ] **D11** — `turn.type = 'compact'` used only as a string literal in the `INSERT` statement; no CHECK constraint added to the column.
- [ ] **D12** — `[S/T:L<n>]` renders when `transcript_line_start` is non-null; `[S/T]` when null. Format tests cover both.

**Non-goal compliance:**

- [ ] No migration script for existing `transcript_line_start` NULL rows.
- [ ] No handler or detection for teleport / non-`/compact` summary wrappers.
- [ ] No `remember` tool API changes.
- [ ] No Mnemosyne system prompt edits.
- [ ] No worker code changes.
- [ ] No `CHECK` constraint on `turn.type`.

**Type consistency:**

- [ ] `TurnRecord.transcriptLineStart` is `number | null`.
- [ ] `FormattedTurn.transcriptLineStart` matches.
- [ ] `ParsedReplayTurn.transcriptLineStart` matches.
- [ ] `buildPromptIdLineMap` returns `Map<string, number>` (never null values — a missing key means missing).

**Test coverage:**

- [ ] `tests/shared/transcript-line-map.test.ts` covers 1-indexing, missing promptId, first-occurrence-wins, empty/missing file.
- [ ] `tests/hooks/backfill.test.ts` new test covers line-number propagation from transcript to DB.
- [ ] `tests/hooks/post-compact.test.ts` covers insert, idempotency, no-boundary tolerance, most-recent-wins.
- [ ] `tests/mcp/format.test.ts` covers `[S/T:L<n>]` vs `[S/T]` rendering.

---

## Interactions with other plans

- **`2026-04-11-timeline-view.md`**: **tight dependency**. Timeline's turn-row rendering consumes `FormattedTurn.transcriptLineStart`. Timeline-view.md is edited in Stage 5 of this conversation (a separate motion) to (a) bump D6 prompt column cap 70 → 200, (b) add a `line` column to the turn row, (c) render `type='compact'` turns as a distinct row (visually different from normal turns, acts as a phase RLE boundary). Timeline-view.md also picks up `buildPromptIdLineMap` and `transcriptLineStart` as load-bearing parser primitives.
- **`2026-04-11-read-surface-refactor.md`**: already landed. This spec introduces no new recall parameters and does not reopen the D1-D11 decisions from that refactor. The `[S/T:L<n>]` id format is a pure rendering change within the existing `format.ts` module.
- **`2026-04-11-compact-anchor-and-debug-docs.md`**: already landed. That spec populated `sessions.last_compact_turn` via SQL MAX over extracted turns. This spec creates `type='compact'` turns with `status='extracted'`, which **will be included** in that SQL — meaning `last_compact_turn` after this spec will point at the compact turn itself rather than the last extracted normal turn. This is a semantic change that needs a minor follow-up: either (a) exclude `type='compact'` from the `last_compact_turn` computation, or (b) redefine `last_compact_turn` to mean "the compact turn row id" rather than "the turn id just before compact". Option (b) is simpler and more accurate — `last_compact_turn` becomes a direct pointer to the compact turn. Add this as a follow-up note at the top of compact-anchor spec, do not edit the behavior in this spec.
- **`2026-04-11-mnemo-agent-workdir-isolation.md`**: independent. Mnemosyne's workdir isolation does not interact with the read surface or hook routing.
- **G5 follow-up (pivot tagging)**: out of scope. When Mnemosyne eventually gains session-summary pivot detection, it will call `remember({id: "S42/T15", tags: [...merged, "pivot"]})`. `updateTurnById` already supports partial updates via nullish coalescing (`src/db/turns.ts:192-199`), and the `transcript_line_start` column from this spec is untouched by that path — nothing to wire.

---

*Stage 4 ends here. Stage 5 contains the timeline-view.md edits as a separate file motion.*

