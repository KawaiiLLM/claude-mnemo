# Timeline View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `timeline` MCP tool (plus skill) that renders the temporal/decision shape of a past session — phases, gaps, tool bursts, compact boundary, broken-prompt candidates — so agents can answer "how did this session unfold" without reading full transcripts. Output is a paginated two-column turn table plus session-wide phase RLE and window-scoped shape signals, rendered with local-timezone timestamps.

**Architecture:** Add a third structured MCP tool alongside `recall` and `remember` (the `replay` tool is removed by the read-surface refactor and demoted to the `mnemo-replay` skill). Timeline reads pure SQLite columns (`turns.created_at_epoch`, `turns.type`, `turns.tags`, `turns.title`, `turns.tool_call_count`, `turns.files_*`, `turns.status`, `sessions.last_compact_turn`) — no JSONL parsing, no Mnemosyne invocation. Mnemosyne agent does NOT receive timeline; it is main-agent facing only.

**Tech Stack:** Bun + TypeScript + bun:sqlite + existing `@modelcontextprotocol/sdk` server plumbing + native `Intl.DateTimeFormat` for local-tz rendering.

---

## Spec position

This is the **fifth spec** in the current work stream, executed in this order:

1. `docs/plans/2026-04-11-mnemo-agent-workdir-isolation.md` — ✅ landed
2. `docs/plans/2026-04-11-compact-anchor-and-debug-docs.md` — ✅ landed
3. `docs/plans/2026-04-11-read-surface-refactor.md` — ✅ landed
4. `docs/plans/2026-04-11-compact-turn-and-line-anchors.md` — **must land before this spec**
5. **This spec**

**Hard dependency on read-surface-refactor**: this spec assumes the refactor has shipped. Specific assumptions:

- `replay` MCP tool no longer exists; `mnemo-replay` skill exists
- Main agent has `recall` + `remember` tools; timeline becomes the third structured tool
- `depth` enum is narrowed to `"collapsed" | "expanded"` project-wide (timeline removes depth entirely, but must not reintroduce `"full"`)
- `page` / `pageSize` / `truncate` are established concepts in recall
- `FormattedSession.jsonlPath` field exists; timeline's session header reuses `resolveTranscriptPath`
- Mnemosyne's system prompt no longer mentions `replay()`; its tool surface is `{remember, recall}`
- `docs/design.md` says "three structured MCP tools + mnemo-replay skill" (referring to the post-refactor count of `recall` + `remember`; timeline increases this to three)
- `plugin/CLAUDE.md` already introduces the three-axis read model

**Hard dependency on compact-turn-and-line-anchors**: this spec also assumes the line-anchor spec has shipped. Specific assumptions:

- `turns.transcript_line_start` column exists and is populated by backfill on all non-legacy turns
- `TurnRecord.transcriptLineStart: number | null` available to consumers
- `/compact` events produce `type = 'compact'` turn rows with `status = 'extracted'` and tag metadata `compact:pre_tokens=<N>` / `compact:trigger=<manual|auto>`
- PostCompact hook is registered and running (new compact events will continue to create compact turns)
- Recall renders `[S/T:L<n>]` ids with the line anchor

If either dependency has not landed, stop and ship it first.

---

## Context: why timeline

### The three-axis read model

Claude-mnemo's read surface is organized around three distinct axes:

| Axis | Surface | Answers |
|---|---|---|
| **Content** | `recall` (MCP tool) | What do we know about this? |
| **Temporal** | `timeline` (MCP tool — **this spec**) | How did this session unfold? |
| **Raw truth** | `mnemo-replay` (skill) | What were the exact bytes? |

The content axis compresses wording and loses temporal shape. The raw axis preserves everything byte-accurately but has low information density (~30k+ tokens for 50 turns). Neither answers the **shape/decision-arc** question.

Timeline fills this gap by projecting the SQLite data along the time/shape axis.

### Empirical evidence: this conversation reconstructing itself

During this conversation's design phase, a compact event occurred at T21. Recovering the pre-compact decision arc required reading the JSONL file manually with `jq`, because:

- **Recall's compact summary** preserved *what was done* but flattened *how it was done* — the pressure that built through T4→T5 toward the T6 decision, the 13m45s thinking pause before T19's final sentinel-cwd lock, the broken-prompt incident at T15→T16, were all invisible in the summary text.
- **Replay** (at the time, now removed) could have shown the raw prompts but gave no structural metadata — no way to see "this was a decision turn, that was a discovery turn".

The signals needed for shape reconstruction are:

- **Already in SQLite** (`turns.created_at_epoch`, `turns.type`, `turns.tags`, `turns.title`, `turns.tool_call_count`, `turns.files_*`, `turns.status`, `sessions.last_compact_turn`)
- **Unused by recall's renderer** (`turn.type` / `turn.tags` / `turn.title` are orphan-rendered — written but not shown in recall's output)
- **Unreachable via the mnemo-replay skill** (raw JSONL has timestamps but no structural metadata)

Timeline projects these signals along the time axis and produces a single view answering "how did this session unfold".

### Second instance of the orphan-code pattern

This spec connects a second instance of the pattern that `compact-anchor-and-debug-docs.md` addressed. The read-surface-refactor does not render `turn.type` / `turn.tags` / `turn.title` either — it leaves them for this spec to connect.

- `turns.type TEXT` / `turns.tags TEXT` / `turns.title TEXT` exist in schema and DTO
- Mnemosyne system prompt explicitly instructs population (5-15 word titles, enum types, 0-5 tags)
- `TYPE_EMOJI` constant at `src/mcp/format.ts:1-9` is exported but never imported elsewhere

Write path: 100% built. Render path: timeline is the renderer that finally connects it.

---

## Locked decisions

Thirteen design decisions were settled during the timeline + read-surface co-design. They are locked here so implementation does not re-litigate them.

### D1: Phase = `turn.type` run-length encoding

Phases are a run-length encoding over the `turn.type` sequence. Each phase's label is the type enum value itself (`discovery` / `decision` / `change` / `bugfix` / `feature` / `refactor`) — NOT a heuristic vocabulary.

**Algorithm:**
1. Iterate turns in `prompt_number` order.
2. **Skip undone turns** — they are transparent to phase RLE (treat as non-existent for adjacency comparison).
3. Current phase starts with the first non-undone turn's type.
4. When type differs from the current phase's type, close the current phase and start a new one.
5. Null-type turns form a `pending` phase (Mnemosyne has not yet extracted them).

Rationale: zero heuristic risk, deterministic, reuses Mnemosyne's existing validated enum.

### D2: Input shape — single `id` field, hard 30-turn cap

```typescript
interface TimelineInput {
  id: string;  // required
}
```

**That's the entire input.** No `depth`, no `pageSize`, no `page`, no `query`, no `time`.

Accepted `id` forms:

| Form | Returns |
|---|---|
| `S<n>` | T1..T30 (default first page) |
| `S<n>/T*` | T1..T30 (wildcard = first page alias) |
| `S<n>/T<m>..<k>` | T<m>..T<min(k, m+29)> (closed range, capped at 30 rows) |
| `S<n>/T..<k>` | T1..T<min(k, 30)> (open-start, capped at 30 rows) |
| `S<n>/T<m>..` | T<m>..T<min(m+29, last_turn)> (open-end, capped at 30 rows) |
| `S<n>/T<m>` | **ERROR** — single turn belongs to recall |

**Hard cap**: `TIMELINE_WINDOW_CAP = 30`. Cannot be overridden. Window beyond 30 truncates and emits a `showing:` line hint directing the agent to the next range.

**No escape hatch**: `T*` is not "give me all". It is an alias for "first page", treated identically to no range.

### D3: Scope rules — header + phases full-session, signals + table windowed

| Section | Scope |
|---|---|
| Session header metadata (time range, compact boundaries, types distribution) | **Full session** |
| Phases block | **Full session** |
| Turn table | **Actual returned window** (post-cap) |
| Shape signals (fastest/longest gap, tool bursts, broken-prompt pairs) | **Actual returned window** |
| `showing:` metadata line | **Actual returned window** (post-cap, with request diff if truncated) |

Rationale: header + phases give the agent "you are here" map of the whole session; signals + table drill into the window of interest.

### D4: Cross-session scope deferred to v2

`id` accepts only single-session forms. Cross-session timelines (`S40..42`, `time="-7d"`) are intentionally out of scope for v1.

### D5: Null-type (pending) turns are first-class

Mnemosyne may not have processed the most recent turns. Timeline handles this by:

1. **Mechanical signals always render** — time, gap, tool_call_count, files_read/modified come from hook writes and exist from turn creation.
2. **Null-type turns form a `pending` phase**, labeled explicitly, with ⏳ badge.
3. **Null-type rows get a `⏳` marker** in the title column (only `⏳`, no title text).
4. **Timeline is a live debugging tool** for the current session, not just archaeology.

### D6: Separate skill file

`plugin/skills/mnemo-timeline/SKILL.md` is a new standalone skill. It is NOT appended to `mnemo-recall/SKILL.md`. Rationale: skill matching is `description`-driven.

### D7: Broken-prompt detection ships in v1

**Algorithm**: two consecutive non-undone turns where:
1. `user_prompt` cleaned-first-lines share a prefix of length ≥ 20 characters
2. Time delta is < 5 minutes

Flag both turns with `※` marker in the gap column.

### D8: External-input detection reads `source:*` tags only

Timeline renders `[ext:<name>]` badges by inspecting `turn.tags` for entries matching `source:*`. Strip the `source:` prefix and render `[ext:<value>]` at the start of the prompt column.

**v1 does NOT modify the Mnemosyne system prompt** to instruct tagging. Timeline's code path supports the feature; actual tag population waits for a follow-up PR. If no source tags exist, timeline simply doesn't render any external-input badges.

### D9: Update `docs/design.md` tool surface language

After read-surface-refactor, `docs/design.md` says "two structured MCP tools (recall + remember) + mnemo-replay skill". Timeline changes this to:

> **Three structured MCP tools** (`recall`, `timeline`, `remember`) **+ `mnemo-replay` skill**.

### D10: Update `plugin/CLAUDE.md` for the three-axis model

Add timeline to the tool list and extend the workflow to `browse → shape → detail → raw`.

### D11: Local-timezone rendering

Timestamps in the turn table, gap column, and session header are rendered in the **system local timezone** via `Intl.DateTimeFormat(undefined, ...)`. DB layer is unchanged (`created_at_epoch` remains UTC Unix timestamps).

Session header includes an explicit `tz:` metadata line showing the timezone abbreviation and UTC offset.

### D12: Undone turn rendering

Turns with `status = "undone"` render as:

- **Turn table row**: prefix `T#` with `⨯`; wrap both prompt and title columns in markdown strikethrough (`~~...~~`)
- **Phase RLE**: skip entirely (transparent to type adjacency comparison)
- **Gap calculation**: participate (time still passed)
- **Shape signals top-N**: excluded from fastest/longest-gap ranking and tool-burst top-3

### D13: Two-column turn table — `prompt` + `title`

The turn table has **two separate columns**:

- **prompt column** (200 chars hard cap): cleaned raw user prompt first line
- **title column** (40 chars hard cap): `<type_emoji> <Mnemosyne title>`

The 200-char cap (bumped from the v1 draft's 70) is deliberate: empirical session-recovery testing on `2e26a8aa-c1ad-4ca4-922e-e0023415ff20.jsonl` demonstrated that decision-seed prompts — the ones a reader most wants to read at a glance — concentrate character density after the first polite ~70 characters. Clipping at 70 reproduced recall's "flatten-how-it-was-done" failure mode (see the spec's Context section). 200 matches the global `truncate` default from the read-surface refactor, giving a consistent character budget across `recall` and `timeline`.

**Clean rules for prompt column** (in `cleanPromptForLabel`):
1. Strip `<command-name>/xxx</command-name>...<command-args>...</command-args>` wrappers, extract command name
2. Strip `<local-command-caveat>...</local-command-caveat>` blocks
3. Strip `<local-command-stdout>...</local-command-stdout>` blocks
4. Take first non-empty line
5. Collapse internal `\s+` to single space
6. Trim
7. Truncate at 200 chars, append `…` if truncated
8. Prepend `[ext:<name>]` badges (space-separated if multiple) when `source:*` tags exist

**Title column handling**:

| Turn state | Title column |
|---|---|
| `extracted` with title and type | `<type_emoji> <title>` (truncate title at ~35 chars; total column at 40) |
| `pending` / `active` / null type / null title | `⏳` (just the pending emoji) |
| `undone` with title | `~~<type_emoji> <title>~~` |
| `undone` without title | `⨯` |

Type emoji at the first character of the title column creates a vertical "phase strip" agents can scan top-to-bottom.

**`showing:` line forms**:

| Situation | Line |
|---|---|
| Short session, all turns fit | `showing: T1-T21 of 21 (end)` |
| Long session, first page | `showing: T1-T30 of 120 (next: T31..60)` |
| Long session, middle page | `showing: T31-T60 of 120 (next: T61..90)` |
| Long session, last page | `showing: T91-T120 of 120 (end)` |
| Request exceeds cap | `showing: T50-T79 of 120 (requested T50..100, truncated to 30 rows; next: T80..109)` |
| Open-end range `T30..` | `showing: T30-T59 of 120 (next: T60..89)` — no truncation notice, normal pagination |

### D14: Line anchor column and compact turn rendering

These two are picked up from the `compact-turn-and-line-anchors.md` spec, which must land before timeline implementation starts.

**Line anchor in the turn table.** Each turn row gains a `line` column rendering `L<transcript_line_start>` when the field is non-null, `—` otherwise. The column is placed between `T#` and `time` so that the identity (T#, line) stays left-aligned as a single visual unit. Downstream consumers (agents recovering a session) can copy a turn's `L<n>` value directly into `Read(jsonl_path, offset=<n>)` for one-step raw access.

**Compact turn rendering.** Turns with `type = 'compact'` (created by the PostCompact hook in the anchors spec) render as a **distinct row type**:

- `T#` column: normal `T<n>` (compact turns are real turns with a real prompt_number)
- `line` column: `L<line>` from the summary wrapper's line number (always populated by PostCompact handler)
- `time` column: `HH:MM` from `created_at_epoch`
- `gap` column: normal gap computation — compact is just another turn from the gap calculator's perspective
- `stats` column: `—` (compact turns always have `tool_call_count = 0`)
- `prompt` column: fixed literal `/compact` (NOT the raw summary wrapper text — that's 1-10KB of noise and defeats the "scan shape at a glance" goal). The renderer checks `turn.type === "compact"` and substitutes the literal regardless of the `content` field.
- `title` column: `⏸ /compact <pre_tokens> tokens, <trigger>` — parsed from the turn's `tags` JSON (`compact:pre_tokens=<N>`, `compact:trigger=<T>`). Pre-tokens formatted with a `k` suffix for thousands (`357k`) or `M` suffix for millions.

The type emoji `⏸` is new and lives in the timeline module's local `TYPE_EMOJI_MAP` (not the `format.ts` orphan). It is visually distinct from the six Mnemosyne-taxonomy emojis (🔴 🟣 🔄 ✅ 🔵 ⚖️) so the compact row reads as a structural marker rather than a domain phase.

**Phase RLE treatment of compact turns.** `type = 'compact'` participates in phase RLE as a distinct run value. In practice this means a compact turn always forms its own single-turn phase, separating the phase before compact from the phase after. Rendered as `⏸ compact  T<n>  —  1 turn  —` in the phases block, without a duration or tool counts. This is a pure consequence of the RLE algorithm — no special-case code needed beyond adding `compact` to the `TYPE_EMOJI_MAP`.

**Source of truth for compact boundaries.** `TimelineView.compactBoundaries` is populated from **both** sources, with a preference chain:

1. **Primary**: `SELECT prompt_number FROM turns WHERE session_id = ? AND type = 'compact' ORDER BY prompt_number ASC`
2. **Fallback**: `sessions.last_compact_turn` (populated by the already-landed compact-anchor spec)

On a fresh database post-anchors-spec, both should agree on the most recent compact. On an older database where compact turns have not yet been created (PostCompact handler hadn't run for pre-spec `/compact` events), only `last_compact_turn` will be populated and timeline falls back to it. Early dev dictates no migration — users with legacy DBs reset.

This is the **only** place in the spec that reads `sessions.last_compact_turn`. All new code paths prefer the turn-type query.

---

## Non-goals / Out of scope

- **Cross-session timelines** (`id="S40..42"`, `time="-7d"`)
- **Depth parameter** — timeline intentionally has no depth knob
- **`pageSize` parameter** — pagination expressed only through `id` range syntax
- **Configurable hard cap** — 30 is a compile-time constant
- **Modifying Mnemosyne system prompt** to instruct `source:*` tagging
- **Mnemosyne gaining access to timeline** — `src/worker/agent-session.ts` stays at `{remember, recall}`
- **Merging broken-prompt candidates visually**
- **Phase vocabulary beyond the type enum**
- **SessionStart integration**
- **Timeline for `M` records**
- **Live streaming / incremental rendering**
- **Removing `TYPE_EMOJI` orphan status from `format.ts`** — timeline has its own local `TYPE_EMOJI_MAP`; cross-module sharing is a follow-up

---

## Pre-existing infrastructure inventory

Everything in this list is **already built** and must not be re-implemented:

| Asset | Location | Notes |
|---|---|---|
| `turns.type TEXT` column | `src/db/schema.ts:31` | Populated by Mnemosyne |
| `turns.tags TEXT` column | `src/db/schema.ts:32` | JSON array |
| `turns.title TEXT` column | existing | 5-15 word Mnemosyne summary |
| `turns.status TEXT` | existing | Includes `"undone"` value |
| `TurnRecord.type / .tags / .title / .status` | `src/db/turns.ts` | DTO fields |
| `TurnRecord.userPrompt: string \| null` | existing | Raw prompt from hook |
| `TurnRecord.toolCallCount / .filesRead / .filesModified / .createdAtEpoch / .promptNumber` | existing | Hook-populated |
| `TURN_SELECT` reads all above columns | `src/db/turns.ts` | Verify no new select needed |
| `TYPE_EMOJI` constant | `src/mcp/format.ts:1-9` | 🔴 bugfix / 🟣 feature / 🔄 refactor / ✅ change / 🔵 discovery / ⚖️ decision |
| `sessions.last_compact_turn` | `src/db/schema.ts:14` | Populated by compact-anchor spec (landed). Used as fallback only — see D14 |
| `turns.transcript_line_start INTEGER` | `src/db/schema.ts` | Added by compact-turn-and-line-anchors spec. Non-null for turns backfilled after that spec. |
| `TurnRecord.transcriptLineStart: number \| null` | `src/db/turns.ts` | DTO field added by compact-turn-and-line-anchors spec |
| `ParsedReplayTurn.transcriptLineStart` | `src/shared/transcript-parser.ts` | Parser-side field populated by the anchors spec |
| `buildPromptIdLineMap(path)` | `src/shared/transcript-parser.ts` | Helper exported by the anchors spec — available if timeline ever needs direct line lookups |
| `type = 'compact'` turn rows | written by `src/hooks/handlers/post-compact.ts` | New row type introduced by the anchors spec; timeline renders them as structural markers (D14) |
| `getTurnsForSession` ordered by prompt_number | `src/db/turns.ts` | Existing query |
| `getSession` | `src/db/sessions.ts` | Existing query |
| `resolveTranscriptPath` | `src/shared/paths.ts` | JSONL path resolver |
| `createMcpServer` registers tools | `src/mcp/server.ts` | Post-refactor: 2 tools; spec adds 3rd |
| `createDatabaseBackedHandlers` factory | `src/mcp/handlers.ts` | Pattern for adding a new handler |
| Tool description + schema pair | `src/mcp/definitions.ts` | Pattern: `MNEMO_TOOL_DESCRIPTIONS.xxx` + `xxxInputShape` + `xxxInputSchema` |

**Do not add migrations. Do not add schema columns. Do not modify existing test DB helpers beyond adding fixture data.**

---

## File structure

### New files

```
src/mcp/timeline.ts                        ~750 lines   Pure helpers + view builder + renderer + entry point
tests/mcp/timeline.test.ts                 ~600 lines   Unit tests across all pure helpers + integration
plugin/skills/mnemo-timeline/SKILL.md      ~200 lines   Skill file with workflow and examples
```

### Modified files

```
src/mcp/definitions.ts                     +12 lines    Add timeline description + input shape/schema. DO NOT add timeline to MNEMO_ALLOWED_TOOLS — that constant is the Mnemosyne SDK allowlist (imported only by src/worker/query-session.ts and src/worker/agent-session.ts), not the main server's tool list. Timeline is registered by an explicit src/mcp/server.ts registerTool call, matching recall and remember.
src/mcp/handlers.ts                        +10 lines    Add timeline handler wiring
src/mcp/server.ts                          +10 lines    Register third tool
plugin/CLAUDE.md                           ~15 lines    Add timeline to tool list; update workflow to browse→shape→detail→raw
docs/design.md                             2 sections   Tool surface language (2→3 structured tools); add Display and Rendering note about timeline
```

### Untouched but relevant

```
src/worker/agent-session.ts                NO CHANGE    Mnemosyne does NOT get timeline
src/db/schema.ts                           NO CHANGE    All columns exist
src/db/turns.ts                            NO CHANGE    DTO fields exist
src/worker/query-session.ts                NO CHANGE    Mnemosyne prompt does not gain source:* tagging instructions in v1
src/mcp/replay.ts                          DOES NOT EXIST (removed by refactor)
```

**Critical invariant**: after this spec, Mnemosyne SDK tool list in `src/worker/agent-session.ts:createMnemoSdkServer` still has exactly two `deps.toolImpl(...)` blocks (`remember` + `recall`). Verified in Task 9.

---

## Module boundaries inside `src/mcp/timeline.ts`

```typescript
// ============================================================================
// 1. Public interface
// ============================================================================
export interface TimelineInput { id: string; }

// ============================================================================
// 2. Internal types
// ============================================================================
type RangeSpec =
  | { kind: "none" }
  | { kind: "all" }
  | { kind: "closed"; start: number; end: number }
  | { kind: "openStart"; end: number }
  | { kind: "openEnd"; start: number };

interface ParsedId { sessionId: number; range: RangeSpec; }

interface ResolvedWindow {
  startPromptNumber: number;
  endPromptNumber: number;
  requestedEnd: number | null;  // user-asked end if exceeded cap, else null
  hadExplicitEnd: boolean;
  totalTurns: number;
}

interface Phase {
  kind: "typed" | "pending";
  type: string | null;
  emoji: string;
  startPromptNumber: number;
  endPromptNumber: number;
  turnCount: number;
  totalToolCalls: number;
  totalFilesRead: number;
  totalFilesModified: number;
  durationMs: number;
  externalInputs: string[];
}

interface TypesDistribution {
  bugfix: number; feature: number; refactor: number;
  change: number; discovery: number; decision: number;
  pending: number;
}

interface ShapeSignals {
  fastestGap: { afterPromptNumber: number; ms: number } | null;
  longestGap: { afterPromptNumber: number; ms: number } | null;
  toolBursts: Array<{ promptNumber: number; toolCallCount: number }>;
  toolBurstMedian: number;
  toolBurstThreshold: number;
  brokenPromptPairs: Array<{ first: number; second: number }>;
  undoneTurns: number[];
  externalInputs: Array<{ promptNumber: number; source: string }>;
}

interface TimelineView {
  session: SessionRecord;
  totalTurns: number;
  totalToolCalls: number;
  typesDistribution: TypesDistribution;
  compactBoundaries: number[];
  phases: Phase[];           // full-session
  window: ResolvedWindow;
  windowTurns: TurnRecord[]; // window-scoped
  windowSignals: ShapeSignals;
  jsonlPath: string | null;
  tz: { name: string; offsetLabel: string };
}

// ============================================================================
// 3. Pure helpers (no DB)
// ============================================================================
export function parseTimelineId(id: string): ParsedId;
export function resolveWindow(range: RangeSpec, totalTurns: number): ResolvedWindow;
export function cleanPromptForLabel(raw: string | null): string;
export function truncateText(text: string, maxChars: number): string;
export function formatLocalTime(epochSeconds: number): string;
export function formatLocalDate(epochSeconds: number): string;
export function getSystemTimezone(): { name: string; offsetLabel: string };
export function formatDuration(ms: number): string;
export function formatGap(currentEpoch: number, previousEpoch: number | null): string;
export function segmentPhases(turns: TurnRecord[]): Phase[];
export function computeTypesDistribution(turns: TurnRecord[]): TypesDistribution;
export function detectBrokenPromptPairs(turns: TurnRecord[]): Array<{ first: number; second: number }>;
export function detectShapeSignals(turns: TurnRecord[]): ShapeSignals;
export function extractSourceTags(tags: string[]): string[];

// ============================================================================
// 4. View builder (DB-backed)
// ============================================================================
export function buildTimelineView(db: Database, input: TimelineInput): TimelineView;

// ============================================================================
// 5. Renderers
// ============================================================================
function renderSessionHeader(view: TimelineView): string[];
function renderTurnTable(view: TimelineView): string[];
function renderPhases(view: TimelineView): string[];
function renderShapeSignals(view: TimelineView): string[];
export function renderTimeline(view: TimelineView): string;

// ============================================================================
// 6. Public entry point
// ============================================================================
export function timelineQuery(db: Database, input: TimelineInput): string;
```

**Constants** (module-local):

```typescript
const TIMELINE_WINDOW_CAP = 30;
const PROMPT_COLUMN_CAP = 200;
const TITLE_COLUMN_CAP = 40;
const BROKEN_PROMPT_MIN_PREFIX = 20;
const BROKEN_PROMPT_MAX_GAP_MS = 5 * 60 * 1000;
const TOOL_BURST_TOP_N = 3;
```

---

## Output structure

### Full session header (always present)

```
- [S42] 2026-04-11 09:50 → 11:36 (1h 46m, compact at T21)
  claude-mnemo | 21 turns | 111 tool_calls
  types: 🔵9 ⚖️1 ✅4 ⏳3 (session-wide)
  showing: T1-T21 of 21 (end)
  tz: CST (+08:00)
  raw: ~/.claude/projects/-Users-zhaoqixuan-Projects-claude-mnemo/<uuid>.jsonl
```

Six fixed metadata lines:
1. **Identity**: session id, date range (local tz), duration, compact boundary list
2. **Stats**: project, total turns, total tool calls
3. **`types:` line**: distribution with emoji + count, suffix `(session-wide)`
4. **`showing:` line**: window + next-hint
5. **`tz:` line**: timezone name + UTC offset
6. **`raw:` line**: absolute JSONL path (via `resolveTranscriptPath`)

### Turn table (two-column, window-scoped)

```
  T#    line     time    gap         stats          prompt (up to 200 chars — truncated here for doc readability)                            title
  ───   ──────   ─────   ─────────   ────────────   ──────────────────────────────────────────────────────────────────────────────────────   ────────────────────────────────────────
  T1    L3       09:50   (start)     🔧9 📖5        看看这个项目中最长的那个 session 日志:~/.claude/projects/-Users-zhaoqixuan-Projects-cl…  🔵 Survey longest session via MCP tools
  T2    L20      09:53   +2m16s      🔧3 📖2        最新的 compact 内容是什么                                                                 🔵 Inspect latest compact artifact
  T3    L33      09:55   +2m37s      —              /plugin                                                                                    🔵 Probe plugin install state
  T4    L37      09:56   +36s        —              简单看看后续工作                                                                          🔵 Review post-install follow-up work
  T5    L45      09:58   +2m35s      🔧15 📖8       "插件装机后 worker 日志/compact 行为",这部分可以深入看看                                   🔵 Deep dive worker logs and compact flow
  T6    L56      10:01   +3m52s      🔧2            方案 A 是什么                                                                              ⚖️ Adopt sentinel cwd option A
  T7    L64      10:03   +1m24s      🔧1            可以                                                                                        ⚖️ Approve sentinel cwd direction
  T12   L236     10:34   +6m15s      🔧4 📖3        如果我 resume 之前的 session,记忆 Agent 也会 resume 吗                                     🔵 Reveal Mnemosyne resume gap
  T19   L344     11:11   +8m16s      🔧2            方案: Sentinel cwd + 不 rename / Session 实际位置:~/.claude/projects/-Users-zhaoqixuan-…  ⚖️ Lock sentinel-cwd final plan
  T20   L354     11:14   +2m46s      🔧1            按你推荐的来,可以开始写文档了                                                              ⚖️ Start workdir-isolation spec draft
  T21   L394     11:27   +13m27s     🔧8 ✏️5        [ext:codex] • 发现 2 个需要先收紧的问题。 1. 中: resume miss 时把 sessionId 先乐观设成…   🔵 Codex round-2 flags resume safety
  T22   L432     11:36   +9m03s      —              /compact                                                                                   ⏸ /compact 358k tokens, manual
  T23   L509     11:50   +13m52s     🔧6 📖4        说一个实际一点,你看看此 session compact 前的历史记录                                       🔵 Kick off session-recovery demo
  T24   L544     12:04   +13m37s     🔧9 📖6        这个 session 是为了恢复之前一个 session 的工作,所以探索了另一个 session 的中断点…         🔵 Surface auto-recovery motivation
  T25   L631     12:31   +27m02s     🔧12 📖8       先不急,我在从长计议,recall replay timeline 各自的职责是什么                                 ⚖️ Start three-axis deliberation
```

**Columns:**
- `T#` (4 chars fixed): `T<promptNumber>`, prefixed with `⨯ ` when undone
- `line` (6 chars, variable): `L<transcript_line_start>` when field is non-null; `—` otherwise. Enables one-step `Read(jsonl_path, offset=<n>)` handoff to the mnemo-replay skill.
- `time` (5 chars fixed): local-tz `HH:MM`
- `gap` (~9 chars, variable): `(start)` for T1, `+<duration>` otherwise; `  ※  ` suffix when broken-prompt candidate
- `stats` (~14 chars, variable): `🔧N 📖N ✏️N` (zero-value emoji omitted); `—` for compact turns (zero tool calls)
- `prompt` (200 chars cap): cleaned raw prompt; `[ext:<name>]` badge prefix; wrapped in `~~...~~` when undone; **substituted with the literal `/compact` when `turn.type === 'compact'`**
- `title` (40 chars cap): `<type_emoji> <title>` when extracted; `⏳` when pending; `~~<type_emoji> <title>~~` or `⨯` when undone; `⏸ /compact <N> tokens, <trigger>` when `turn.type === 'compact'` (parsed from `compact:pre_tokens=<N>` and `compact:trigger=<T>` tags)

**T22 in the example** is a compact turn created by the PostCompact hook. Visual contrast with the surrounding T21/T23 rows is the design intent — the ⏸ emoji in the title column plus `/compact` in the prompt column make it unmistakable as a structural marker rather than a user prompt.

### Phases block (always full session)

```
  phases (session-wide):
    1. 🔵 discovery   T1-T5       ~8m    5 turns   📖21 🔧33
    2. ⚖️ decision    T6-T7       ~4m    2 turns   🔧3
    3. 🔵 discovery   T8-T9       ~9m    2 turns   📖6 🔧10
    4. ⚖️ decision    T10         <1m    1 turn    🔧3
    5. 🔵 discovery   T11-T18     ~35m   7 turns   📖14 🔧24    (T16 undone, skipped)  [ext:codex @T11]
    6. ⚖️ decision    T19-T20     ~6m    2 turns   🔧3
    7. 🔵 discovery   T21         <1m    1 turn    🔧8          [ext:codex]
```

### Shape signals block (window-scoped)

```
  shape signals (window T1-T21 = full session):
    - fastest gap:   after T3  (+12s)
    - longest gap:   after T5  (+13m45s)   ← pressure toward ⚖️ decision T6
    - tool bursts:   T5 🔧15, T21 🔧8, T8 🔧6   [median 🔧2, threshold >🔧4]
    - broken-prompt: T15→T17 (T16 undone in between)
    - undone turns:  T16
    - external inputs: T11 [ext:codex], T21 [ext:codex]
    - compact boundary: after T21
```

### Long-session paginated example

```
- [S77] 2026-04-15 22:20 → 02:05 (3h 45m, compact at T45, T80)
  claude-mnemo | 120 turns | 411 tool_calls
  types: 🔵32 ⚖️8 ✅28 🔴5 🔄15 ⏳12 (session-wide)
  showing: T31-T60 of 120 (next: T61..90)
  tz: CST (+08:00)
  raw: ~/.claude/projects/-Users-zhaoqixuan-Projects-claude-mnemo/<uuid>.jsonl

  [turn table renders only T31..T60]

  phases (session-wide):
    [all 11 phases listed, not just those in window]

  shape signals (window T31-T60):
    - fastest gap:   after T44 (+1m48s)
    - longest gap:   after T45 (+14m20s)   ← compact boundary
    - tool bursts:   T52 🔧23, T47 🔧18, T60 🔧12   [median 🔧6, threshold >🔧12]
    - broken-prompt: none in window
    - undone turns:  none in window
    - compact boundary: after T45 (within window); after T80 (outside window)
```

### Explicit range exceeding cap

Input: `timeline(id="S77/T50..100")`

```
  showing: T50-T79 of 120 (requested T50..100, truncated to 30 rows; next: T80..109)
```

The `showing:` line is the only place truncation is announced.

---

## Task decomposition

Tasks are bite-sized and TDD-first. Each task commits independently. The full test suite must be green after every task.

---

### Task 1: Definitions and schema registration

Add the timeline tool to `definitions.ts` and `handlers.ts`. Create a stub `timeline.ts` so downstream imports compile.

**Files:**
- Modify: `src/mcp/definitions.ts`
- Modify: `src/mcp/handlers.ts`
- Create: `src/mcp/timeline.ts` (stub)
- Modify: `tests/mcp/definitions.test.ts`

- [ ] **Step 1: Write the failing schema test**

Add to `tests/mcp/definitions.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";

import {
  timelineInputSchema,
  MNEMO_ALLOWED_TOOLS,
  MNEMO_TOOL_DESCRIPTIONS,
} from "../../src/mcp/definitions";

describe("timelineInputSchema", () => {
  it("accepts a plain session id", () => {
    expect(timelineInputSchema.parse({ id: "S42" })).toEqual({ id: "S42" });
  });

  it("accepts closed turn range", () => {
    expect(timelineInputSchema.parse({ id: "S42/T10..30" })).toEqual({ id: "S42/T10..30" });
  });

  it("accepts open-end and open-start ranges and wildcard", () => {
    expect(timelineInputSchema.parse({ id: "S42/T30.." })).toEqual({ id: "S42/T30.." });
    expect(timelineInputSchema.parse({ id: "S42/T..20" })).toEqual({ id: "S42/T..20" });
    expect(timelineInputSchema.parse({ id: "S42/T*" })).toEqual({ id: "S42/T*" });
  });

  it("rejects missing id", () => {
    expect(() => timelineInputSchema.parse({})).toThrow();
  });

  it("rejects extra fields like depth or pageSize", () => {
    expect(() => timelineInputSchema.parse({ id: "S42", depth: "expanded" })).toThrow();
    expect(() => timelineInputSchema.parse({ id: "S42", pageSize: 10 })).toThrow();
  });
});

describe("tool surface — timeline is NOT in the Mnemosyne allowlist", () => {
  // MNEMO_ALLOWED_TOOLS is the Mnemosyne SDK allowlist (imported only by
  // src/worker/query-session.ts and src/worker/agent-session.ts). Timeline
  // must NOT appear here — the extraction agent does not get timeline.
  it("MNEMO_ALLOWED_TOOLS stays at remember + recall only", () => {
    expect(MNEMO_ALLOWED_TOOLS.slice().sort()).toEqual([
      "mcp__mnemo__recall",
      "mcp__mnemo__remember",
    ]);
  });

  it("MNEMO_TOOL_DESCRIPTIONS adds timeline (used by the main MCP server's registerTool call)", () => {
    expect(Object.keys(MNEMO_TOOL_DESCRIPTIONS).sort()).toEqual([
      "recall",
      "remember",
      "timeline",
    ]);
  });
});
```

- [ ] **Step 2: Run — verify fail**

Run: `bun test tests/mcp/definitions.test.ts`
Expected: FAIL — `timelineInputSchema` not exported.

- [ ] **Step 3: Extend `src/mcp/definitions.ts`**

After the read-surface-refactor, this file has `recallInputShape` and `rememberInputShape`. Add timeline:

```typescript
import { z } from "zod";

export const MNEMO_TOOL_DESCRIPTIONS = {
  recall:
    "Recall structured memories from the SQLite store. Paginated index; use the mnemo-replay skill for raw JSONL.",
  timeline:
    "Render the temporal/decision shape of a past session — phases, gaps, tool bursts, compact boundary, broken-prompt candidates. Single-session view with range-based pagination (30-turn hard cap).",
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

export const timelineInputShape = {
  id: z.string().min(1),
};

export const rememberInputShape = {
  /* unchanged from refactor */
};

export const recallInputSchema = z.object(recallInputShape).strict();
export const timelineInputSchema = z.object(timelineInputShape).strict();
export const rememberInputSchema = z.object(rememberInputShape).strict();

// NOTE: MNEMO_ALLOWED_TOOLS is the Mnemosyne SDK allowlist — imported only
// by src/worker/query-session.ts:220 and src/worker/agent-session.ts. It
// must stay at two entries. Timeline is exposed to the main agent via an
// explicit server.registerTool call in src/mcp/server.ts (Step 5 below),
// mirroring how recall and remember are already registered.
export const MNEMO_ALLOWED_TOOLS = [
  "mcp__mnemo__remember",
  "mcp__mnemo__recall",
] as const;
```

**Critical:** `MNEMO_ALLOWED_TOOLS` keeps exactly two entries. The previous v1 draft of this spec mistakenly added `mcp__mnemo__timeline` to this array under the assumption it was the main-agent allowlist. It is not — `src/mcp/server.ts` does not read this constant; it registers tools via explicit `server.registerTool` calls. The worker files, on the other hand, DO read it and pass it straight into the Mnemosyne SDK query's `allowedTools` option. Adding timeline here would contradict the **Critical invariant** further up in this spec (the `createMnemoSdkServer` two-toolImpl rule, verified by Task 9's grep) and give Mnemosyne a tool it must never see.

**Rename follow-up (out of scope for this spec):** the name `MNEMO_ALLOWED_TOOLS` is misleading precisely because of this confusion. A future cleanup should rename it to `MNEMOSYNE_AGENT_TOOLS` or similar, updating the two importers. Leaving the name unchanged in this spec minimizes diff scope and risk; the critical fix is "don't add timeline here", not the rename.

- [ ] **Step 4: Create stub `src/mcp/timeline.ts`**

So `handlers.ts` can import:

```typescript
import type { Database } from "bun:sqlite";

export interface TimelineInput {
  id: string;
}

export function timelineQuery(_db: Database, _input: TimelineInput): string {
  return "timeline not implemented";
}
```

The real implementation replaces this stub in Tasks 2-4.

- [ ] **Step 5: Extend `src/mcp/handlers.ts`**

```typescript
import type { Database } from "bun:sqlite";

import { recallMemory } from "./recall";
import { rememberTool } from "./remember";
import { timelineQuery } from "./timeline";

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
};

export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult> | ToolResult;

export interface MnemoToolHandlers {
  recall: ToolHandler;
  timeline: ToolHandler;
  remember: ToolHandler;
}

// ... (existing CreateDatabaseBackedHandlersOptions, textResult, createStubHandler unchanged)

export function createDatabaseBackedHandlers(
  database?: Database,
  _options: CreateDatabaseBackedHandlersOptions = {},
): Partial<MnemoToolHandlers> {
  if (!database) return {};

  return {
    recall: (args) =>
      textResult(recallMemory(database, { /* existing args mapping from refactor */ } as any)),
    timeline: (args) =>
      textResult(
        timelineQuery(database, {
          id: args.id as string,
        }),
      ),
    remember: (args) =>
      rememberTool(database, args as unknown as Parameters<typeof rememberTool>[1]),
  };
}
```

- [ ] **Step 6: Run — verify pass**

Run: `bun test tests/mcp/definitions.test.ts`
Expected: PASS.

Run: `bun test`
Expected: full suite green (the stub `timelineQuery` compiles and returns a placeholder string; no runtime error since Task 5 hasn't registered the tool in `server.ts` yet).

- [ ] **Step 7: Commit**

```bash
git add src/mcp/definitions.ts src/mcp/handlers.ts src/mcp/timeline.ts tests/mcp/definitions.test.ts
git commit -m "feat(mcp): register timeline tool schema and stub

- Add timelineInputShape/Schema with single required id field
- Add timeline to MNEMO_TOOL_DESCRIPTIONS only
- MNEMO_ALLOWED_TOOLS stays at {remember, recall} — it is the
  Mnemosyne SDK allowlist, not the main server's tool list
- Wire stub timelineQuery through createDatabaseBackedHandlers

Real implementation arrives in the next tasks. The main MCP server
does not yet register the timeline tool; that happens in Task 5."
```

---

### Task 2: Pure helpers (TDD-first)

Implement every pure function that the view builder and renderers will compose. Every function in this task is side-effect-free and unit-testable — no DB, no file system (tests that need `Intl` are tz-loose).

**Files:**
- Modify: `src/mcp/timeline.ts`
- Create: `tests/mcp/timeline.test.ts`

- [ ] **Step 1: Write failing tests for `parseTimelineId`**

Create `tests/mcp/timeline.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";

import { parseTimelineId } from "../../src/mcp/timeline";

describe("parseTimelineId", () => {
  it("parses plain session id", () => {
    expect(parseTimelineId("S42")).toEqual({
      sessionId: 42,
      range: { kind: "none" },
    });
  });

  it("parses wildcard T*", () => {
    expect(parseTimelineId("S42/T*")).toEqual({
      sessionId: 42,
      range: { kind: "all" },
    });
  });

  it("parses closed range", () => {
    expect(parseTimelineId("S42/T10..30")).toEqual({
      sessionId: 42,
      range: { kind: "closed", start: 10, end: 30 },
    });
  });

  it("parses open-start range", () => {
    expect(parseTimelineId("S42/T..20")).toEqual({
      sessionId: 42,
      range: { kind: "openStart", end: 20 },
    });
  });

  it("parses open-end range", () => {
    expect(parseTimelineId("S42/T30..")).toEqual({
      sessionId: 42,
      range: { kind: "openEnd", start: 30 },
    });
  });

  it("rejects single-turn forms", () => {
    expect(() => parseTimelineId("S42/T10")).toThrow(/single turn/i);
  });

  it("rejects malformed input", () => {
    expect(() => parseTimelineId("foo")).toThrow();
    expect(() => parseTimelineId("S42/bogus")).toThrow();
    expect(() => parseTimelineId("")).toThrow();
  });
});
```

- [ ] **Step 2: Run — verify fail**

Run: `bun test tests/mcp/timeline.test.ts -t parseTimelineId`
Expected: FAIL — function not exported.

- [ ] **Step 3: Implement `parseTimelineId`**

Replace the stub `src/mcp/timeline.ts` body with:

```typescript
import type { Database } from "bun:sqlite";

// ============================================================================
// Public interface
// ============================================================================
export interface TimelineInput {
  id: string;
}

// ============================================================================
// Constants
// ============================================================================
const TIMELINE_WINDOW_CAP = 30;
const PROMPT_COLUMN_CAP = 200;
const TITLE_COLUMN_CAP = 40;
const BROKEN_PROMPT_MIN_PREFIX = 20;
const BROKEN_PROMPT_MAX_GAP_MS = 5 * 60 * 1000;
const TOOL_BURST_TOP_N = 3;

// ============================================================================
// Types
// ============================================================================
export type RangeSpec =
  | { kind: "none" }
  | { kind: "all" }
  | { kind: "closed"; start: number; end: number }
  | { kind: "openStart"; end: number }
  | { kind: "openEnd"; start: number };

export interface ParsedId {
  sessionId: number;
  range: RangeSpec;
}

// ============================================================================
// Pure helpers
// ============================================================================
export function parseTimelineId(id: string): ParsedId {
  const trimmed = id.trim();
  if (!trimmed) throw new Error("timeline id is empty");

  const rootMatch = trimmed.match(/^S(\d+)(?:\/T(.+))?$/i);
  if (!rootMatch) {
    throw new Error(`timeline id does not match 'S<n>' or 'S<n>/T...': ${id}`);
  }

  const sessionId = Number(rootMatch[1]);
  const rangeStr = rootMatch[2];

  if (rangeStr === undefined) {
    return { sessionId, range: { kind: "none" } };
  }

  if (rangeStr === "*") {
    return { sessionId, range: { kind: "all" } };
  }

  const closed = rangeStr.match(/^(\d+)\.\.(\d+)$/);
  if (closed) {
    return {
      sessionId,
      range: { kind: "closed", start: Number(closed[1]), end: Number(closed[2]) },
    };
  }

  const openEnd = rangeStr.match(/^(\d+)\.\.$/);
  if (openEnd) {
    return {
      sessionId,
      range: { kind: "openEnd", start: Number(openEnd[1]) },
    };
  }

  const openStart = rangeStr.match(/^\.\.(\d+)$/);
  if (openStart) {
    return {
      sessionId,
      range: { kind: "openStart", end: Number(openStart[1]) },
    };
  }

  if (/^\d+$/.test(rangeStr)) {
    throw new Error(
      `timeline does not accept single-turn forms; use recall(id='S${sessionId}/T${rangeStr}', depth='expanded') instead`,
    );
  }

  throw new Error(`timeline range syntax not recognized: T${rangeStr}`);
}

// Keep a stub timelineQuery at the bottom until Task 5 replaces it with the
// real entry point.
export function timelineQuery(_db: Database, _input: TimelineInput): string {
  return "timeline not implemented";
}
```

- [ ] **Step 4: Run — verify pass**

Run: `bun test tests/mcp/timeline.test.ts -t parseTimelineId`
Expected: PASS.

- [ ] **Step 5: Write failing tests for `resolveWindow`**

Add:

```typescript
import { resolveWindow } from "../../src/mcp/timeline";

describe("resolveWindow", () => {
  it("defaults to first 30 turns when range is 'none'", () => {
    const w = resolveWindow({ kind: "none" }, 120);
    expect(w.startPromptNumber).toBe(1);
    expect(w.endPromptNumber).toBe(30);
    expect(w.requestedEnd).toBeNull();
    expect(w.hadExplicitEnd).toBe(false);
  });

  it("returns whole short session when total <= cap", () => {
    const w = resolveWindow({ kind: "none" }, 21);
    expect(w.startPromptNumber).toBe(1);
    expect(w.endPromptNumber).toBe(21);
  });

  it("treats T* identically to none", () => {
    const none = resolveWindow({ kind: "none" }, 120);
    const star = resolveWindow({ kind: "all" }, 120);
    expect(star).toEqual(none);
  });

  it("respects closed range within cap", () => {
    const w = resolveWindow({ kind: "closed", start: 10, end: 30 }, 120);
    expect(w.startPromptNumber).toBe(10);
    expect(w.endPromptNumber).toBe(30);
    expect(w.hadExplicitEnd).toBe(true);
    expect(w.requestedEnd).toBeNull();
  });

  it("truncates closed range exceeding cap", () => {
    const w = resolveWindow({ kind: "closed", start: 10, end: 50 }, 120);
    expect(w.startPromptNumber).toBe(10);
    expect(w.endPromptNumber).toBe(39);
    expect(w.hadExplicitEnd).toBe(true);
    expect(w.requestedEnd).toBe(50);
  });

  it("truncates closed range exceeding session end", () => {
    const w = resolveWindow({ kind: "closed", start: 100, end: 150 }, 120);
    expect(w.startPromptNumber).toBe(100);
    expect(w.endPromptNumber).toBe(120);
    expect(w.requestedEnd).toBe(150);
  });

  it("open-end starts at the given turn and caps at 30 rows", () => {
    const w = resolveWindow({ kind: "openEnd", start: 30 }, 120);
    expect(w.startPromptNumber).toBe(30);
    expect(w.endPromptNumber).toBe(59);
    expect(w.requestedEnd).toBeNull();
    expect(w.hadExplicitEnd).toBe(false);
  });

  it("open-start ends at the given turn", () => {
    const w = resolveWindow({ kind: "openStart", end: 20 }, 120);
    expect(w.startPromptNumber).toBe(1);
    expect(w.endPromptNumber).toBe(20);
    expect(w.hadExplicitEnd).toBe(true);
    expect(w.requestedEnd).toBeNull();
  });

  it("open-start exceeding cap is truncated", () => {
    const w = resolveWindow({ kind: "openStart", end: 50 }, 120);
    expect(w.startPromptNumber).toBe(1);
    expect(w.endPromptNumber).toBe(30);
    expect(w.requestedEnd).toBe(50);
  });

  it("empty session returns zero-length window", () => {
    const w = resolveWindow({ kind: "none" }, 0);
    expect(w.startPromptNumber).toBe(1);
    expect(w.endPromptNumber).toBe(0);
  });
});
```

- [ ] **Step 6: Implement `resolveWindow`**

Append to `src/mcp/timeline.ts`:

```typescript
export interface ResolvedWindow {
  startPromptNumber: number;
  endPromptNumber: number;
  requestedEnd: number | null;
  hadExplicitEnd: boolean;
  totalTurns: number;
}

export function resolveWindow(range: RangeSpec, totalTurns: number): ResolvedWindow {
  if (totalTurns === 0) {
    return {
      startPromptNumber: 1,
      endPromptNumber: 0,
      requestedEnd: null,
      hadExplicitEnd: false,
      totalTurns: 0,
    };
  }

  if (range.kind === "none" || range.kind === "all") {
    return {
      startPromptNumber: 1,
      endPromptNumber: Math.min(TIMELINE_WINDOW_CAP, totalTurns),
      requestedEnd: null,
      hadExplicitEnd: false,
      totalTurns,
    };
  }

  if (range.kind === "closed") {
    const start = Math.max(1, range.start);
    const cappedByCap = start + TIMELINE_WINDOW_CAP - 1;
    const cappedBySession = totalTurns;
    const actualEnd = Math.min(range.end, cappedByCap, cappedBySession);
    const wasTruncated = actualEnd < range.end;
    return {
      startPromptNumber: start,
      endPromptNumber: actualEnd,
      requestedEnd: wasTruncated ? range.end : null,
      hadExplicitEnd: true,
      totalTurns,
    };
  }

  if (range.kind === "openEnd") {
    const start = Math.max(1, range.start);
    const actualEnd = Math.min(start + TIMELINE_WINDOW_CAP - 1, totalTurns);
    return {
      startPromptNumber: start,
      endPromptNumber: actualEnd,
      requestedEnd: null,
      hadExplicitEnd: false,
      totalTurns,
    };
  }

  if (range.kind === "openStart") {
    const cappedByCap = TIMELINE_WINDOW_CAP;
    const cappedBySession = totalTurns;
    const actualEnd = Math.min(range.end, cappedByCap, cappedBySession);
    const wasTruncated = actualEnd < range.end;
    return {
      startPromptNumber: 1,
      endPromptNumber: actualEnd,
      requestedEnd: wasTruncated ? range.end : null,
      hadExplicitEnd: true,
      totalTurns,
    };
  }

  throw new Error(`Unknown range kind: ${(range as { kind: string }).kind}`);
}
```

- [ ] **Step 7: Run — verify pass**

Run: `bun test tests/mcp/timeline.test.ts -t resolveWindow`
Expected: PASS.

- [ ] **Step 8: Write failing tests for `cleanPromptForLabel`**

```typescript
import { cleanPromptForLabel } from "../../src/mcp/timeline";

describe("cleanPromptForLabel", () => {
  it("returns empty string for null", () => {
    expect(cleanPromptForLabel(null)).toBe("");
  });

  it("passes through short Chinese prompt unchanged", () => {
    expect(cleanPromptForLabel("可以")).toBe("可以");
    expect(cleanPromptForLabel("方案 A 是什么")).toBe("方案 A 是什么");
  });

  it("collapses multi-line prompt to first non-empty line", () => {
    expect(cleanPromptForLabel("line1\nline2\nline3")).toBe("line1");
    expect(cleanPromptForLabel("\n\n  first  \n\nsecond")).toBe("first");
  });

  it("strips slash-command wrapper and extracts command name", () => {
    const input = `<command-name>/plugin</command-name>
            <command-message>plugin</command-message>
            <command-args></command-args>`;
    expect(cleanPromptForLabel(input)).toBe("/plugin");
  });

  it("strips local-command-caveat and stdout wrappers", () => {
    const input = `<local-command-caveat>Caveat: blah blah</local-command-caveat>`;
    expect(cleanPromptForLabel(input)).toBe("");
  });

  it("collapses internal whitespace runs", () => {
    expect(cleanPromptForLabel("foo    bar\t\tbaz")).toBe("foo bar baz");
  });

  it("preserves CJK and emoji", () => {
    expect(cleanPromptForLabel("🔵 测试 emoji")).toBe("🔵 测试 emoji");
  });
});
```

- [ ] **Step 9: Implement `cleanPromptForLabel`**

```typescript
export function cleanPromptForLabel(raw: string | null): string {
  if (!raw) return "";

  let text = raw;

  // Extract slash-command name if present
  const cmdName = text.match(/<command-name>\s*([^<]+?)\s*<\/command-name>/);
  if (cmdName) {
    return cmdName[1].trim();
  }

  // Strip wrapper tags (non-greedy, across newlines)
  text = text.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "");
  text = text.replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "");
  text = text.replace(/<command-args>[\s\S]*?<\/command-args>/g, "");
  text = text.replace(/<command-message>[\s\S]*?<\/command-message>/g, "");

  // Take first non-empty line
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";

  // Collapse internal whitespace runs
  return firstLine.replace(/\s+/g, " ").trim();
}
```

- [ ] **Step 10: Write failing tests for `truncateText`**

```typescript
import { truncateText } from "../../src/mcp/timeline";

describe("truncateText", () => {
  it("returns text unchanged when shorter than max", () => {
    expect(truncateText("hello", 10)).toBe("hello");
  });

  it("truncates and appends ellipsis when longer", () => {
    expect(truncateText("hello world", 5)).toBe("hello…");
  });

  it("treats exactly-max as unchanged", () => {
    expect(truncateText("hello", 5)).toBe("hello");
  });

  it("handles empty string", () => {
    expect(truncateText("", 10)).toBe("");
  });
});
```

- [ ] **Step 11: Implement `truncateText`**

```typescript
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "…";
}
```

- [ ] **Step 12: Write failing tests for `formatDuration` / `formatGap`**

```typescript
import { formatDuration, formatGap } from "../../src/mcp/timeline";

describe("formatDuration", () => {
  it("sub-minute → seconds", () => {
    expect(formatDuration(12_000)).toBe("12s");
    expect(formatDuration(59_000)).toBe("59s");
  });

  it("sub-hour → minutes+seconds", () => {
    expect(formatDuration(2 * 60 * 1000 + 16_000)).toBe("2m16s");
    expect(formatDuration(13 * 60 * 1000 + 45_000)).toBe("13m45s");
  });

  it("multi-hour → hours and minutes", () => {
    expect(formatDuration(60 * 60 * 1000 + 46 * 60 * 1000)).toBe("1h 46m");
    expect(formatDuration(3 * 60 * 60 * 1000 + 45 * 60 * 1000)).toBe("3h 45m");
  });
});

describe("formatGap", () => {
  it("returns (start) for null previous", () => {
    expect(formatGap(1000, null)).toBe("(start)");
  });

  it("prefixes with +", () => {
    expect(formatGap(120, 108)).toBe("+12s");
    expect(formatGap(1000, 864)).toBe("+2m16s");
  });
});
```

Note: `formatGap` takes epochs in **seconds** (matching `turns.created_at_epoch`), internally multiplies by 1000 for `formatDuration` which expects ms.

- [ ] **Step 13: Implement duration helpers**

```typescript
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const seconds = totalSeconds % 60;
    return seconds === 0 ? `${totalMinutes}m` : `${totalMinutes}m${seconds}s`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

export function formatGap(currentEpochSeconds: number, previousEpochSeconds: number | null): string {
  if (previousEpochSeconds === null) return "(start)";
  return `+${formatDuration((currentEpochSeconds - previousEpochSeconds) * 1000)}`;
}
```

**Verify unit**: before committing this step, read `src/db/turns.ts` and confirm `createdAtEpoch` is seconds (not milliseconds). If it is ms, remove the `* 1000` in `formatGap`.

- [ ] **Step 14: Write failing tests for `formatLocalTime` / `getSystemTimezone`**

```typescript
import { formatLocalTime, getSystemTimezone } from "../../src/mcp/timeline";

describe("formatLocalTime", () => {
  it("renders an epoch as HH:MM in local tz", () => {
    const output = formatLocalTime(Math.floor(Date.parse("2026-04-11T01:50:47Z") / 1000));
    expect(output).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe("getSystemTimezone", () => {
  it("returns name and offset label", () => {
    const tz = getSystemTimezone();
    expect(tz.name).toBeTruthy();
    expect(tz.offsetLabel).toMatch(/^[+-]\d{2}:\d{2}$/);
  });
});
```

These tests are tz-loose — they assert format shape, not exact values.

- [ ] **Step 15: Implement time helpers**

```typescript
export function formatLocalTime(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function formatLocalDate(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function getSystemTimezone(): { name: string; offsetLabel: string } {
  const iana = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: iana,
    timeZoneName: "short",
  }).formatToParts(new Date());
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? iana;

  const now = new Date();
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  const offsetLabel = `${sign}${hh}:${mm}`;

  return { name, offsetLabel };
}
```

- [ ] **Step 16: Run all helper tests so far**

Run: `bun test tests/mcp/timeline.test.ts`
Expected: all PASS.

- [ ] **Step 17: Write failing tests for `segmentPhases`**

Add fixture helper at top of test file:

```typescript
import type { TurnRecord } from "../../src/db/turns";

function turn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    id: 1,
    sessionId: 1,
    promptNumber: 1,
    status: "extracted",
    title: null,
    content: null,
    insight: null,
    type: null,
    tags: [],
    userPrompt: null,
    promptPreview: null,
    responsePreview: null,
    filesRead: [],
    filesModified: [],
    toolCallCount: 0,
    createdAtEpoch: 1000,
    ...overrides,
  } as TurnRecord;
}
```

Then tests:

```typescript
import { segmentPhases } from "../../src/mcp/timeline";

describe("segmentPhases", () => {
  it("returns empty for no turns", () => {
    expect(segmentPhases([])).toEqual([]);
  });

  it("single typed turn → single phase", () => {
    const phases = segmentPhases([turn({ promptNumber: 1, type: "discovery", createdAtEpoch: 1000 })]);
    expect(phases).toHaveLength(1);
    expect(phases[0].type).toBe("discovery");
  });

  it("run-length encodes same-type runs", () => {
    const phases = segmentPhases([
      turn({ promptNumber: 1, type: "discovery", createdAtEpoch: 1000 }),
      turn({ promptNumber: 2, type: "discovery", createdAtEpoch: 1100 }),
      turn({ promptNumber: 3, type: "discovery", createdAtEpoch: 1200 }),
      turn({ promptNumber: 4, type: "decision",  createdAtEpoch: 1300 }),
      turn({ promptNumber: 5, type: "discovery", createdAtEpoch: 1400 }),
    ]);
    expect(phases).toHaveLength(3);
    expect(phases[0]).toMatchObject({ type: "discovery", startPromptNumber: 1, endPromptNumber: 3 });
    expect(phases[1]).toMatchObject({ type: "decision",  startPromptNumber: 4, endPromptNumber: 4 });
    expect(phases[2]).toMatchObject({ type: "discovery", startPromptNumber: 5, endPromptNumber: 5 });
  });

  it("undone turns are skipped transparently", () => {
    const phases = segmentPhases([
      turn({ promptNumber: 1, type: "discovery", createdAtEpoch: 1000 }),
      turn({ promptNumber: 2, type: "discovery", createdAtEpoch: 1100, status: "undone" }),
      turn({ promptNumber: 3, type: "discovery", createdAtEpoch: 1200 }),
    ]);
    expect(phases).toHaveLength(1);
    expect(phases[0]).toMatchObject({
      type: "discovery",
      startPromptNumber: 1,
      endPromptNumber: 3,
      turnCount: 2,
    });
  });

  it("null-type turns form a pending phase", () => {
    const phases = segmentPhases([
      turn({ promptNumber: 1, type: "discovery", createdAtEpoch: 1000 }),
      turn({ promptNumber: 2, type: null, createdAtEpoch: 1100 }),
      turn({ promptNumber: 3, type: null, createdAtEpoch: 1200 }),
    ]);
    expect(phases).toHaveLength(2);
    expect(phases[0].kind).toBe("typed");
    expect(phases[1]).toMatchObject({
      kind: "pending",
      type: null,
      turnCount: 2,
    });
  });

  it("aggregates stats per phase", () => {
    const phases = segmentPhases([
      turn({ promptNumber: 1, type: "discovery", toolCallCount: 9, filesRead: ["a", "b"], createdAtEpoch: 1000 }),
      turn({ promptNumber: 2, type: "discovery", toolCallCount: 3, filesRead: ["c"], createdAtEpoch: 1100 }),
    ]);
    expect(phases[0].totalToolCalls).toBe(12);
    expect(phases[0].totalFilesRead).toBe(3);
  });
});
```

- [ ] **Step 18: Implement `segmentPhases` and `extractSourceTags`**

Append to `src/mcp/timeline.ts`:

```typescript
import type { TurnRecord } from "../db/turns";

export interface Phase {
  kind: "typed" | "pending";
  type: string | null;
  emoji: string;
  startPromptNumber: number;
  endPromptNumber: number;
  turnCount: number;
  totalToolCalls: number;
  totalFilesRead: number;
  totalFilesModified: number;
  durationMs: number;
  externalInputs: string[];
}

const TYPE_EMOJI_MAP: Record<string, string> = {
  bugfix:   "🔴",
  feature:  "🟣",
  refactor: "🔄",
  change:   "✅",
  discovery:"🔵",
  decision: "⚖️",
};

const PENDING_EMOJI = "⏳";

export function extractSourceTags(tags: string[]): string[] {
  return tags
    .filter((t) => t.startsWith("source:"))
    .map((t) => t.slice("source:".length));
}

export function segmentPhases(turns: TurnRecord[]): Phase[] {
  const phases: Phase[] = [];
  let current: Phase | null = null;

  for (const t of turns) {
    if (t.status === "undone") continue;

    const phaseType: string | null = t.type;
    const kind: Phase["kind"] = phaseType === null ? "pending" : "typed";
    const emoji = phaseType === null ? PENDING_EMOJI : (TYPE_EMOJI_MAP[phaseType] ?? "•");

    const matches =
      current !== null &&
      current.kind === kind &&
      current.type === phaseType;

    if (!matches) {
      if (current) phases.push(current);
      current = {
        kind,
        type: phaseType,
        emoji,
        startPromptNumber: t.promptNumber,
        endPromptNumber: t.promptNumber,
        turnCount: 0,
        totalToolCalls: 0,
        totalFilesRead: 0,
        totalFilesModified: 0,
        durationMs: 0,
        externalInputs: [],
      };
    }

    current!.endPromptNumber = t.promptNumber;
    current!.turnCount += 1;
    current!.totalToolCalls += t.toolCallCount;
    current!.totalFilesRead += t.filesRead.length;
    current!.totalFilesModified += t.filesModified.length;

    const sources = extractSourceTags(t.tags);
    for (const s of sources) {
      if (!current!.externalInputs.includes(s)) {
        current!.externalInputs.push(s);
      }
    }
  }

  if (current) phases.push(current);

  // Second pass to compute durationMs
  for (const p of phases) {
    const first = turns.find((t) => t.promptNumber === p.startPromptNumber);
    const last = turns.find((t) => t.promptNumber === p.endPromptNumber);
    if (first && last) {
      p.durationMs = (last.createdAtEpoch - first.createdAtEpoch) * 1000;
    }
  }

  return phases;
}
```

- [ ] **Step 19: Run — verify pass**

Run: `bun test tests/mcp/timeline.test.ts -t segmentPhases`
Expected: PASS.

- [ ] **Step 20: Write failing tests for `computeTypesDistribution`**

```typescript
import { computeTypesDistribution } from "../../src/mcp/timeline";

describe("computeTypesDistribution", () => {
  it("counts each type and pending (null)", () => {
    const dist = computeTypesDistribution([
      turn({ promptNumber: 1, type: "discovery" }),
      turn({ promptNumber: 2, type: "discovery" }),
      turn({ promptNumber: 3, type: "decision" }),
      turn({ promptNumber: 4, type: "change" }),
      turn({ promptNumber: 5, type: null }),
      turn({ promptNumber: 6, type: null }),
    ]);
    expect(dist).toEqual({
      bugfix: 0, feature: 0, refactor: 0, change: 1,
      discovery: 2, decision: 1, pending: 2,
    });
  });

  it("excludes undone turns", () => {
    const dist = computeTypesDistribution([
      turn({ promptNumber: 1, type: "discovery" }),
      turn({ promptNumber: 2, type: "discovery", status: "undone" }),
    ]);
    expect(dist.discovery).toBe(1);
  });
});
```

- [ ] **Step 21: Implement `computeTypesDistribution`**

```typescript
export interface TypesDistribution {
  bugfix: number; feature: number; refactor: number;
  change: number; discovery: number; decision: number;
  pending: number;
}

export function computeTypesDistribution(turns: TurnRecord[]): TypesDistribution {
  const dist: TypesDistribution = {
    bugfix: 0, feature: 0, refactor: 0, change: 0,
    discovery: 0, decision: 0, pending: 0,
  };
  for (const t of turns) {
    if (t.status === "undone") continue;
    if (t.type === null) {
      dist.pending += 1;
    } else if (t.type in dist) {
      (dist as Record<string, number>)[t.type] += 1;
    }
  }
  return dist;
}
```

- [ ] **Step 22: Write failing tests for `detectBrokenPromptPairs`**

```typescript
import { detectBrokenPromptPairs } from "../../src/mcp/timeline";

describe("detectBrokenPromptPairs", () => {
  it("detects consecutive prompts with shared prefix and short gap", () => {
    const pairs = detectBrokenPromptPairs([
      turn({
        promptNumber: 1,
        userPrompt: "选 2,不过 -Users-zhaoqixuan-.claude-mnemo-agent-workdir 怎么这么长",
        createdAtEpoch: 1000,
      }),
      turn({
        promptNumber: 2,
        userPrompt: "选 2,不过 -Users-zhaoqixuan-.claude-mnemo-agent-workdir 怎么这么长,不是已经",
        createdAtEpoch: 1040,
      }),
    ]);
    expect(pairs).toEqual([{ first: 1, second: 2 }]);
  });

  it("rejects prompts with short shared prefix", () => {
    const pairs = detectBrokenPromptPairs([
      turn({ promptNumber: 1, userPrompt: "foo bar baz", createdAtEpoch: 1000 }),
      turn({ promptNumber: 2, userPrompt: "qux quux",    createdAtEpoch: 1040 }),
    ]);
    expect(pairs).toEqual([]);
  });

  it("rejects prompts with gap >= 5 minutes", () => {
    const pairs = detectBrokenPromptPairs([
      turn({ promptNumber: 1, userPrompt: "x".repeat(30), createdAtEpoch: 1000 }),
      turn({ promptNumber: 2, userPrompt: "x".repeat(30), createdAtEpoch: 1000 + 5 * 60 + 1 }),
    ]);
    expect(pairs).toEqual([]);
  });

  it("skips undone turns in comparison", () => {
    const pairs = detectBrokenPromptPairs([
      turn({ promptNumber: 1, userPrompt: "x".repeat(30), createdAtEpoch: 1000 }),
      turn({ promptNumber: 2, userPrompt: "x".repeat(30), createdAtEpoch: 1030, status: "undone" }),
      turn({ promptNumber: 3, userPrompt: "x".repeat(30) + " extra", createdAtEpoch: 1060 }),
    ]);
    expect(pairs).toEqual([{ first: 1, second: 3 }]);
  });
});
```

- [ ] **Step 23: Implement `detectBrokenPromptPairs`**

```typescript
export function detectBrokenPromptPairs(
  turns: TurnRecord[],
): Array<{ first: number; second: number }> {
  const pairs: Array<{ first: number; second: number }> = [];
  const live = turns.filter((t) => t.status !== "undone");

  for (let i = 0; i < live.length - 1; i += 1) {
    const a = live[i];
    const b = live[i + 1];
    const promptA = cleanPromptForLabel(a.userPrompt);
    const promptB = cleanPromptForLabel(b.userPrompt);
    if (promptA.length < BROKEN_PROMPT_MIN_PREFIX) continue;
    if (promptB.length < BROKEN_PROMPT_MIN_PREFIX) continue;

    const sharedPrefixLen = sharedPrefixLength(promptA, promptB);
    if (sharedPrefixLen < BROKEN_PROMPT_MIN_PREFIX) continue;

    const gapMs = (b.createdAtEpoch - a.createdAtEpoch) * 1000;
    if (gapMs >= BROKEN_PROMPT_MAX_GAP_MS) continue;

    pairs.push({ first: a.promptNumber, second: b.promptNumber });
  }

  return pairs;
}

function sharedPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i += 1;
  return i;
}
```

- [ ] **Step 24: Write failing tests for `detectShapeSignals`**

```typescript
import { detectShapeSignals } from "../../src/mcp/timeline";

describe("detectShapeSignals", () => {
  it("finds fastest and longest gap, excluding undone turns from candidates", () => {
    const signals = detectShapeSignals([
      turn({ promptNumber: 1, createdAtEpoch: 1000 }),
      turn({ promptNumber: 2, createdAtEpoch: 1010 }),
      turn({ promptNumber: 3, createdAtEpoch: 1900 }),
      turn({ promptNumber: 4, createdAtEpoch: 1912 }),
      turn({ promptNumber: 5, createdAtEpoch: 3412, status: "undone" }),
      turn({ promptNumber: 6, createdAtEpoch: 3500 }),
    ]);
    expect(signals.fastestGap).toMatchObject({ afterPromptNumber: 1, ms: 10_000 });
    expect(signals.longestGap).toMatchObject({ afterPromptNumber: 2, ms: 890_000 });
  });

  it("computes tool burst median and filters by 2x threshold", () => {
    const signals = detectShapeSignals([
      turn({ promptNumber: 1, toolCallCount: 2 }),
      turn({ promptNumber: 2, toolCallCount: 3 }),
      turn({ promptNumber: 3, toolCallCount: 2 }),
      turn({ promptNumber: 4, toolCallCount: 18 }),
      turn({ promptNumber: 5, toolCallCount: 15 }),
      turn({ promptNumber: 6, toolCallCount: 3 }),
    ]);
    expect(signals.toolBurstMedian).toBe(3);
    expect(signals.toolBurstThreshold).toBe(6);
    expect(signals.toolBursts.map((b) => b.promptNumber)).toEqual([4, 5]);
  });

  it("returns empty signals for empty input", () => {
    const signals = detectShapeSignals([]);
    expect(signals.fastestGap).toBeNull();
    expect(signals.longestGap).toBeNull();
    expect(signals.toolBursts).toEqual([]);
  });
});
```

- [ ] **Step 25: Implement `detectShapeSignals`**

```typescript
export interface ShapeSignals {
  fastestGap: { afterPromptNumber: number; ms: number } | null;
  longestGap: { afterPromptNumber: number; ms: number } | null;
  toolBursts: Array<{ promptNumber: number; toolCallCount: number }>;
  toolBurstMedian: number;
  toolBurstThreshold: number;
  brokenPromptPairs: Array<{ first: number; second: number }>;
  undoneTurns: number[];
  externalInputs: Array<{ promptNumber: number; source: string }>;
}

export function detectShapeSignals(turns: TurnRecord[]): ShapeSignals {
  if (turns.length === 0) {
    return {
      fastestGap: null, longestGap: null,
      toolBursts: [], toolBurstMedian: 0, toolBurstThreshold: 0,
      brokenPromptPairs: [], undoneTurns: [], externalInputs: [],
    };
  }

  const live = turns.filter((t) => t.status !== "undone");

  let fastest: { afterPromptNumber: number; ms: number } | null = null;
  let longest: { afterPromptNumber: number; ms: number } | null = null;
  for (let i = 0; i < live.length - 1; i += 1) {
    const ms = (live[i + 1].createdAtEpoch - live[i].createdAtEpoch) * 1000;
    if (fastest === null || ms < fastest.ms) {
      fastest = { afterPromptNumber: live[i].promptNumber, ms };
    }
    if (longest === null || ms > longest.ms) {
      longest = { afterPromptNumber: live[i].promptNumber, ms };
    }
  }

  const counts = live.map((t) => t.toolCallCount).slice().sort((a, b) => a - b);
  const median = counts.length === 0
    ? 0
    : counts.length % 2 === 1
      ? counts[Math.floor(counts.length / 2)]
      : Math.round((counts[counts.length / 2 - 1] + counts[counts.length / 2]) / 2);
  const threshold = median * 2;
  const toolBursts = live
    .filter((t) => t.toolCallCount > threshold)
    .map((t) => ({ promptNumber: t.promptNumber, toolCallCount: t.toolCallCount }))
    .sort((a, b) => b.toolCallCount - a.toolCallCount)
    .slice(0, TOOL_BURST_TOP_N);

  const brokenPromptPairs = detectBrokenPromptPairs(turns);

  const undoneTurns = turns
    .filter((t) => t.status === "undone")
    .map((t) => t.promptNumber);

  const externalInputs: Array<{ promptNumber: number; source: string }> = [];
  for (const t of live) {
    for (const source of extractSourceTags(t.tags)) {
      externalInputs.push({ promptNumber: t.promptNumber, source });
    }
  }

  return {
    fastestGap: fastest, longestGap: longest,
    toolBursts, toolBurstMedian: median, toolBurstThreshold: threshold,
    brokenPromptPairs, undoneTurns, externalInputs,
  };
}
```

- [ ] **Step 26: Run all helper tests**

Run: `bun test tests/mcp/timeline.test.ts`
Expected: all PASS.

- [ ] **Step 27: Commit**

```bash
git add src/mcp/timeline.ts tests/mcp/timeline.test.ts
git commit -m "feat(timeline): pure helpers for id parsing, window cap, phase RLE, shape signals

- parseTimelineId: all range forms; rejects single-turn and bad syntax
- resolveWindow: 30-turn hard cap with truncation tracking
- cleanPromptForLabel: strips command wrappers, first line, collapses whitespace
- truncateText: char slice + ellipsis
- formatDuration / formatGap: compact time deltas
- formatLocalTime / getSystemTimezone: Intl.DateTimeFormat based
- segmentPhases: run-length encoding, undone transparent, null pending
- computeTypesDistribution: per-type counts excluding undone
- detectBrokenPromptPairs: 20+ char shared prefix + <5min gap
- detectShapeSignals: fastest/longest gap, tool bursts >2x median

Pure functions only, no DB. Full unit coverage."
```

---

### Task 3: View builder with DB integration

Connect the helpers to the DB. `buildTimelineView` is the only function here that touches `bun:sqlite`.

**Files:**
- Modify: `src/mcp/timeline.ts`
- Modify: `tests/mcp/timeline.test.ts`

- [ ] **Step 1: Write failing integration test**

Add to `tests/mcp/timeline.test.ts`:

```typescript
import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { buildTimelineView } from "../../src/mcp/timeline";

function seedSession(db: ReturnType<typeof createDatabase>) {
  initializeSchema(db);
  const session = upsertSession(db, {
    contentSessionId: "abc-uuid-timeline",
    project: "/tmp/claude-mnemo-test",
    title: "timeline fixture",
    content: null,
    insight: null,
    createdAtEpoch: 1_700_000_000,
    updatedAtEpoch: 1_700_010_000,
    completedAtEpoch: null,
  });

  for (let i = 1; i <= 21; i += 1) {
    const type =
      i === 6 || i === 19 || i === 20 ? "decision"
      : i >= 19 ? null
      : "discovery";
    db.query(`
      INSERT INTO turns (
        session_id, prompt_number, status, title, type, tags,
        user_prompt, tool_call_count, files_read, files_modified,
        created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id, i,
      "extracted",
      type ? `title for T${i}` : null,
      type,
      JSON.stringify([]),
      `raw prompt ${i}`,
      i === 5 || i === 11 ? 15 : 2,
      JSON.stringify([]),
      JSON.stringify([]),
      1_700_000_000 + i * 100,
    );
  }
  return session;
}

describe("buildTimelineView", () => {
  it("returns a view for a plain S id", () => {
    const db = createDatabase({ path: ":memory:" });
    seedSession(db);
    const view = buildTimelineView(db, { id: "S1" });
    expect(view.totalTurns).toBe(21);
    expect(view.window.startPromptNumber).toBe(1);
    expect(view.window.endPromptNumber).toBe(21);
    expect(view.windowTurns).toHaveLength(21);
    expect(view.phases.length).toBeGreaterThan(1);
  });

  it("respects closed range", () => {
    const db = createDatabase({ path: ":memory:" });
    seedSession(db);
    const view = buildTimelineView(db, { id: "S1/T5..10" });
    expect(view.window.startPromptNumber).toBe(5);
    expect(view.window.endPromptNumber).toBe(10);
    expect(view.windowTurns).toHaveLength(6);
  });

  it("phases always full-session regardless of window", () => {
    const db = createDatabase({ path: ":memory:" });
    seedSession(db);
    const view = buildTimelineView(db, { id: "S1/T10..15" });
    const first = view.phases[0];
    const last = view.phases[view.phases.length - 1];
    expect(first.startPromptNumber).toBe(1);
    expect(last.endPromptNumber).toBeGreaterThanOrEqual(19);
  });

  it("rejects unknown session id", () => {
    const db = createDatabase({ path: ":memory:" });
    initializeSchema(db);
    expect(() => buildTimelineView(db, { id: "S999" })).toThrow(/session/i);
  });

  it("includes compact boundary", () => {
    const db = createDatabase({ path: ":memory:" });
    const session = seedSession(db);
    db.query("UPDATE sessions SET last_compact_turn = 15 WHERE id = ?").run(session.id);
    const view = buildTimelineView(db, { id: "S1" });
    expect(view.compactBoundaries).toContain(15);
  });
});
```

- [ ] **Step 2: Run — verify fail**

Expected: FAIL — `buildTimelineView` not implemented.

- [ ] **Step 3: Implement `buildTimelineView`**

Append to `src/mcp/timeline.ts`:

```typescript
import { getSession } from "../db/sessions";
import type { SessionRecord } from "../db/sessions";
import { getTurnsForSession } from "../db/turns";
import { resolveTranscriptPath } from "../shared/paths";

export interface TimelineView {
  session: SessionRecord;
  totalTurns: number;
  totalToolCalls: number;
  typesDistribution: TypesDistribution;
  compactBoundaries: number[];
  phases: Phase[];
  window: ResolvedWindow;
  windowTurns: TurnRecord[];
  windowSignals: ShapeSignals;
  jsonlPath: string | null;
  tz: { name: string; offsetLabel: string };
}

export function buildTimelineView(db: Database, input: TimelineInput): TimelineView {
  const parsed = parseTimelineId(input.id);
  const session = getSession(db, parsed.sessionId);
  if (!session) {
    throw new Error(`timeline: session S${parsed.sessionId} not found`);
  }

  const allTurns = getTurnsForSession(db, session.id);
  const totalTurns = allTurns.length;
  const totalToolCalls = allTurns.reduce((sum, t) => sum + t.toolCallCount, 0);

  const window = resolveWindow(parsed.range, totalTurns);
  const windowTurns = allTurns.filter(
    (t) => t.promptNumber >= window.startPromptNumber && t.promptNumber <= window.endPromptNumber,
  );

  const phases = segmentPhases(allTurns);
  const typesDistribution = computeTypesDistribution(allTurns);
  const windowSignals = detectShapeSignals(windowTurns);

  const compactBoundaries: number[] = [];
  if (session.lastCompactTurn !== null && session.lastCompactTurn !== undefined) {
    compactBoundaries.push(session.lastCompactTurn);
  }

  const jsonlPath = resolveTranscriptPath(session.project, session.contentSessionId) ?? null;
  const tz = getSystemTimezone();

  return {
    session, totalTurns, totalToolCalls, typesDistribution,
    compactBoundaries, phases, window, windowTurns, windowSignals,
    jsonlPath, tz,
  };
}
```

- [ ] **Step 4: Run — verify pass**

Run: `bun test tests/mcp/timeline.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/timeline.ts tests/mcp/timeline.test.ts
git commit -m "feat(timeline): DB-backed view builder

buildTimelineView composes the pure helpers over real session + turn
records. Validates session existence, resolves window with 30-turn
cap, keeps phases full-session, keeps signals windowed, surfaces
compact boundary from sessions.last_compact_turn, resolves jsonlPath
for the header."
```

---

### Task 4: Renderers (two-column table, local tz, all metadata lines)

Compose view data into the final string output. Every rendering function is pure (takes `TimelineView`, returns string[]).

**Files:**
- Modify: `src/mcp/timeline.ts`
- Modify: `tests/mcp/timeline.test.ts`

- [ ] **Step 1: Write failing tests for `renderTimeline`**

```typescript
import { renderTimeline } from "../../src/mcp/timeline";

describe("renderTimeline", () => {
  it("includes all 6 metadata lines in the header", () => {
    const db = createDatabase({ path: ":memory:" });
    seedSession(db);
    const view = buildTimelineView(db, { id: "S1" });
    const output = renderTimeline(view);

    expect(output).toMatch(/- \[S1\]/);
    expect(output).toMatch(/\| \d+ turns \| \d+ tool_calls/);
    expect(output).toMatch(/types: .+\(session-wide\)/);
    expect(output).toMatch(/showing: T\d+-T\d+/);
    expect(output).toMatch(/tz: .+/);
    expect(output).toMatch(/raw: .+\.jsonl/);
  });

  it("renders two-column turn table header", () => {
    const db = createDatabase({ path: ":memory:" });
    seedSession(db);
    const view = buildTimelineView(db, { id: "S1/T1..5" });
    const output = renderTimeline(view);
    expect(output).toMatch(/T#\s+time\s+gap\s+stats\s+prompt\s+title/);
  });

  it("showing line reports truncation when request exceeds cap", () => {
    const db = createDatabase({ path: ":memory:" });
    seedSession(db);
    const view = buildTimelineView(db, { id: "S1/T5..60" });
    const output = renderTimeline(view);
    expect(output).toMatch(/requested T5\.\.60, truncated/);
  });

  it("showing line emits (end) on last page", () => {
    const db = createDatabase({ path: ":memory:" });
    seedSession(db);
    const view = buildTimelineView(db, { id: "S1" });
    const output = renderTimeline(view);
    expect(output).toMatch(/showing: T1-T21 of 21 \(end\)/);
  });

  it("pending turns render ⏳ in title column", () => {
    const db = createDatabase({ path: ":memory:" });
    seedSession(db);
    const view = buildTimelineView(db, { id: "S1/T19..21" });
    const output = renderTimeline(view);
    expect(output).toMatch(/T19[\s\S]*⏳/);
  });

  it("phases block labeled session-wide", () => {
    const db = createDatabase({ path: ":memory:" });
    seedSession(db);
    const view = buildTimelineView(db, { id: "S1/T10..15" });
    const output = renderTimeline(view);
    expect(output).toMatch(/phases \(session-wide\)/);
  });
});
```

- [ ] **Step 2: Run — verify fail**

Expected: FAIL.

- [ ] **Step 3: Implement the renderers**

Append to `src/mcp/timeline.ts`:

```typescript
// ============================================================================
// Renderers
// ============================================================================

function renderSessionHeader(view: TimelineView): string[] {
  const s = view.session;
  const startDate = formatLocalDate(s.createdAtEpoch);
  const startTime = formatLocalTime(s.createdAtEpoch);
  const endEpoch = s.updatedAtEpoch ?? s.completedAtEpoch ?? s.createdAtEpoch;
  const endTime = formatLocalTime(endEpoch);
  const durationLabel = formatDuration((endEpoch - s.createdAtEpoch) * 1000);

  const compactSuffix =
    view.compactBoundaries.length > 0
      ? `, compact at ${view.compactBoundaries.map((n) => `T${n}`).join(", ")}`
      : "";

  const identity = `- [S${s.id}] ${startDate} ${startTime} → ${endTime} (${durationLabel}${compactSuffix})`;
  const stats = `  ${s.project} | ${view.totalTurns} turns | ${view.totalToolCalls} tool_calls`;

  const td = view.typesDistribution;
  const typesParts: string[] = [];
  if (td.bugfix)    typesParts.push(`🔴${td.bugfix}`);
  if (td.feature)   typesParts.push(`🟣${td.feature}`);
  if (td.refactor)  typesParts.push(`🔄${td.refactor}`);
  if (td.change)    typesParts.push(`✅${td.change}`);
  if (td.discovery) typesParts.push(`🔵${td.discovery}`);
  if (td.decision)  typesParts.push(`⚖️${td.decision}`);
  if (td.pending)   typesParts.push(`⏳${td.pending}`);
  const typesLine = `  types: ${typesParts.join(" ")} (session-wide)`;

  const showingLine = `  showing: ${formatShowingLine(view)}`;
  const tzLine = `  tz: ${view.tz.name} (${view.tz.offsetLabel})`;
  const rawLine = view.jsonlPath ? `  raw: ${view.jsonlPath}` : `  raw: (unresolved)`;

  return [identity, stats, typesLine, showingLine, tzLine, rawLine];
}

function formatShowingLine(view: TimelineView): string {
  const w = view.window;
  if (view.totalTurns === 0) return "T0-T0 of 0 (empty)";

  const base = `T${w.startPromptNumber}-T${w.endPromptNumber} of ${w.totalTurns}`;
  const atEnd = w.endPromptNumber >= w.totalTurns;

  if (w.requestedEnd !== null) {
    const nextStart = w.endPromptNumber + 1;
    const nextEnd = Math.min(nextStart + TIMELINE_WINDOW_CAP - 1, w.totalTurns);
    const nextHint = atEnd ? "" : ` next: T${nextStart}..${nextEnd}`;
    const rows = w.endPromptNumber - w.startPromptNumber + 1;
    return `${base} (requested T${w.startPromptNumber}..${w.requestedEnd}, truncated to ${rows} rows;${nextHint})`;
  }

  if (atEnd) return `${base} (end)`;

  const nextStart = w.endPromptNumber + 1;
  const nextEnd = Math.min(nextStart + TIMELINE_WINDOW_CAP - 1, w.totalTurns);
  return `${base} (next: T${nextStart}..${nextEnd})`;
}

function renderTurnTable(view: TimelineView): string[] {
  if (view.windowTurns.length === 0) return [];

  const lines: string[] = [];
  lines.push("");
  lines.push("  T#    time    gap          stats          prompt                                                                   title");
  lines.push("  ───   ─────   ─────────    ────────────   ──────────────────────────────────────────────────────────────────────   ────────────────────────────────────────");

  const brokenPairs = new Set<number>();
  for (const pair of view.windowSignals.brokenPromptPairs) {
    brokenPairs.add(pair.first);
    brokenPairs.add(pair.second);
  }

  let prevEpoch: number | null = null;
  for (const t of view.windowTurns) {
    lines.push(renderTurnRow(t, prevEpoch, brokenPairs.has(t.promptNumber)));
    prevEpoch = t.createdAtEpoch;
  }

  return lines;
}

function renderTurnRow(
  turn: TurnRecord,
  prevEpoch: number | null,
  isBrokenPromptCandidate: boolean,
): string {
  const isUndone = turn.status === "undone";
  const tColumn = (isUndone ? "⨯ " : "  ") + `T${turn.promptNumber}`.padEnd(4);
  const timeColumn = formatLocalTime(turn.createdAtEpoch);
  const gapRaw = formatGap(turn.createdAtEpoch, prevEpoch);
  const brokenMarker = isBrokenPromptCandidate ? " ※ " : "   ";
  const gapColumn = gapRaw.padEnd(9) + brokenMarker;

  const statsColumn = renderStats(turn).padEnd(14);

  const rawPrompt = cleanPromptForLabel(turn.userPrompt);
  const sourceTags = extractSourceTags(turn.tags);
  const sourcePrefix = sourceTags.length > 0
    ? sourceTags.map((s) => `[ext:${s}]`).join(" ") + " "
    : "";
  let promptText = truncateText(sourcePrefix + rawPrompt, PROMPT_COLUMN_CAP);
  if (isUndone) promptText = `~~${promptText}~~`;
  const promptColumn = promptText.padEnd(PROMPT_COLUMN_CAP + 4);

  const titleColumn = renderTitleCell(turn, isUndone);

  return `  ${tColumn}  ${timeColumn}   ${gapColumn}${statsColumn}   ${promptColumn}   ${titleColumn}`;
}

function renderStats(turn: TurnRecord): string {
  const parts: string[] = [];
  if (turn.toolCallCount > 0) parts.push(`🔧${turn.toolCallCount}`);
  if (turn.filesRead.length > 0) parts.push(`📖${turn.filesRead.length}`);
  if (turn.filesModified.length > 0) parts.push(`✏️${turn.filesModified.length}`);
  return parts.length === 0 ? "—" : parts.join(" ");
}

function renderTitleCell(turn: TurnRecord, isUndone: boolean): string {
  if (turn.type && turn.title) {
    const emoji = TYPE_EMOJI_MAP[turn.type] ?? "•";
    const titleText = truncateText(turn.title, TITLE_COLUMN_CAP - 3);
    const body = `${emoji} ${titleText}`;
    return isUndone ? `~~${body}~~` : body;
  }
  if (isUndone) return "⨯";
  return "⏳";
}

function renderPhases(view: TimelineView): string[] {
  if (view.phases.length === 0) return [];

  const lines: string[] = ["", "  phases (session-wide):"];
  view.phases.forEach((p, idx) => {
    const phaseNum = `${idx + 1}.`.padEnd(4);
    const label = p.kind === "pending" ? "pending   " : (p.type ?? "").padEnd(10);
    const range = p.startPromptNumber === p.endPromptNumber
      ? `T${p.startPromptNumber}`
      : `T${p.startPromptNumber}-T${p.endPromptNumber}`;
    const rangeCol = range.padEnd(12);
    const duration = p.durationMs > 0 ? `~${formatDuration(p.durationMs)}` : "<1m";
    const durationCol = duration.padEnd(7);
    const turnCountCol = `${p.turnCount} turns`.padEnd(10);

    const statsParts: string[] = [];
    if (p.totalFilesRead > 0)     statsParts.push(`📖${p.totalFilesRead}`);
    if (p.totalFilesModified > 0) statsParts.push(`✏️${p.totalFilesModified}`);
    if (p.totalToolCalls > 0)     statsParts.push(`🔧${p.totalToolCalls}`);
    const statsCol = statsParts.join(" ").padEnd(14);

    const extSuffix = p.externalInputs.length > 0
      ? `  [ext:${p.externalInputs.join(",")}]`
      : "";

    lines.push(`    ${phaseNum} ${p.emoji} ${label} ${rangeCol} ${durationCol} ${turnCountCol} ${statsCol}${extSuffix}`);
  });

  return lines;
}

function renderShapeSignals(view: TimelineView): string[] {
  const w = view.window;
  const windowLabel =
    w.startPromptNumber === 1 && w.endPromptNumber === w.totalTurns
      ? ` = full session`
      : "";
  const header = `  shape signals (window T${w.startPromptNumber}-T${w.endPromptNumber}${windowLabel}):`;

  const lines: string[] = ["", header];
  const sig = view.windowSignals;

  if (sig.fastestGap) {
    lines.push(`    - fastest gap:   after T${sig.fastestGap.afterPromptNumber} (+${formatDuration(sig.fastestGap.ms)})`);
  }
  if (sig.longestGap) {
    lines.push(`    - longest gap:   after T${sig.longestGap.afterPromptNumber} (+${formatDuration(sig.longestGap.ms)})`);
  }
  if (sig.toolBursts.length > 0) {
    const bursts = sig.toolBursts.map((b) => `T${b.promptNumber} 🔧${b.toolCallCount}`).join(", ");
    lines.push(`    - tool bursts:   ${bursts}   [median 🔧${sig.toolBurstMedian}, threshold >🔧${sig.toolBurstThreshold}]`);
  }
  if (sig.brokenPromptPairs.length > 0) {
    const pairs = sig.brokenPromptPairs.map((p) => `T${p.first}→T${p.second}`).join(", ");
    lines.push(`    - broken-prompt: ${pairs}`);
  }
  if (sig.undoneTurns.length > 0) {
    lines.push(`    - undone turns:  ${sig.undoneTurns.map((n) => `T${n}`).join(", ")}`);
  }
  if (sig.externalInputs.length > 0) {
    const ext = sig.externalInputs.map((e) => `T${e.promptNumber} [ext:${e.source}]`).join(", ");
    lines.push(`    - external inputs: ${ext}`);
  }

  const windowCompact = view.compactBoundaries.filter(
    (n) => n >= w.startPromptNumber && n <= w.endPromptNumber,
  );
  const outsideCompact = view.compactBoundaries.filter(
    (n) => !(n >= w.startPromptNumber && n <= w.endPromptNumber),
  );
  if (windowCompact.length > 0 || outsideCompact.length > 0) {
    const parts: string[] = [];
    for (const n of windowCompact) parts.push(`after T${n} (within window)`);
    for (const n of outsideCompact) parts.push(`after T${n} (outside window)`);
    lines.push(`    - compact boundary: ${parts.join("; ")}`);
  }

  return lines;
}

export function renderTimeline(view: TimelineView): string {
  const sections: string[] = [
    ...renderSessionHeader(view),
    ...renderTurnTable(view),
    ...renderPhases(view),
    ...renderShapeSignals(view),
  ];
  return sections.join("\n");
}
```

Replace the stub `timelineQuery`:

```typescript
export function timelineQuery(db: Database, input: TimelineInput): string {
  try {
    const view = buildTimelineView(db, input);
    return renderTimeline(view);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `timeline error: ${message}`;
  }
}
```

- [ ] **Step 4: Run all tests**

Run: `bun test tests/mcp/timeline.test.ts`
Expected: all PASS.

Run: `bun test`
Expected: full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/timeline.ts tests/mcp/timeline.test.ts
git commit -m "feat(timeline): session header, two-column turn table, phases, signals

- 6-line session header (identity / stats / types / showing / tz / raw)
- Two-column turn table: prompt (200 cap) + title (40 cap, emoji+title)
- Pending turns render ⏳, undone turns strikethrough + ⨯
- Phases block full-session with emoji, range, duration, stats
- Shape signals block window-scoped with burst threshold annotation
- Local-timezone rendering via Intl.DateTimeFormat
- timelineQuery entry point with error-to-string safety"
```

---

### Task 5: Wire handler and register tool (main MCP server only)

Register timeline in `src/mcp/server.ts`. Explicitly do NOT modify `src/worker/agent-session.ts`.

**Files:**
- Modify: `src/mcp/server.ts`
- Test: `tests/mcp/server.test.ts`

- [ ] **Step 1: Write failing test for server registration**

Add to `tests/mcp/server.test.ts` (or create if missing):

```typescript
import { describe, expect, it } from "bun:test";
import { createMcpServer } from "../../src/mcp/server";

describe("createMcpServer tool registration", () => {
  it("registers exactly three tools: recall, timeline, remember", () => {
    const server = createMcpServer();
    // Inspect however the current test pattern does it — there may be a
    // private accessor. If not, call listTools via the MCP client surface
    // or check the _registeredToolNames private field. Adapt to reality.
    const toolNames = (server as any)._registeredToolNames?.() ?? [];
    expect(toolNames.sort()).toEqual(["recall", "remember", "timeline"]);
  });
});
```

If `createMcpServer` has no tool-name accessor, either add one or check via an existing test pattern. Read `src/mcp/server.ts` and the existing server test first to find the pattern.

- [ ] **Step 2: Run — verify fail**

Expected: FAIL.

- [ ] **Step 3: Register timeline in `src/mcp/server.ts`**

Add the import:

```typescript
import { timelineInputSchema } from "./definitions";
```

Add `timeline` to the `toolHandlers` assembly:

```typescript
const toolHandlers: MnemoToolHandlers = {
  recall: mergedHandlers.recall ?? createStubHandler("recall"),
  timeline: mergedHandlers.timeline ?? createStubHandler("timeline"),
  remember: mergedHandlers.remember ?? createStubHandler("remember"),
};
```

Register the tool:

```typescript
server.registerTool(
  "timeline",
  {
    description: MNEMO_TOOL_DESCRIPTIONS.timeline,
    inputSchema: timelineInputSchema.shape,
  },
  async (args) => toolHandlers.timeline(args as Record<string, unknown>),
);
```

- [ ] **Step 4: Verify `src/worker/agent-session.ts` is UNCHANGED**

```bash
grep -c "deps.toolImpl" src/worker/agent-session.ts
```

Expected: `2` (remember + recall only, NOT timeline).

If you accidentally added timeline to agent-session.ts, remove it.

- [ ] **Step 5: Run all tests**

Run: `bun test`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/server.ts tests/mcp/server.test.ts
git commit -m "feat(mcp): register timeline tool on main MCP server

Main agent tool surface is now: recall, timeline, remember.
Mnemosyne's SDK server in src/worker/agent-session.ts is explicitly
NOT modified — Mnemosyne remains a two-tool agent."
```

---

### Task 6: Create `plugin/skills/mnemo-timeline/SKILL.md`

**Files:**
- Create: `plugin/skills/mnemo-timeline/SKILL.md`

- [ ] **Step 1: Write the skill file**

```markdown
---
name: mnemo-timeline
description: Render the temporal/decision shape of a past session — phases, gaps, tool bursts, compact boundary, broken-prompt candidates. Use when the user asks "how did this session unfold", "what was the decision arc", "where did we decide X", or when reconstructing a session after a compact event.
---

# Mnemo Timeline

Timeline is the **temporal axis** of the three-axis read model. It answers "how did this session unfold" by rendering a time-ordered turn table, session-wide phase segmentation (run-length encoding of turn types), and window-scoped shape signals (gaps, tool bursts, broken-prompt candidates, compact boundaries).

**Three axes of read access:**
- `recall` — what / where — structured semantic index (content axis)
- **`timeline` — when / how — temporal narrative (this skill)**
- `mnemo-replay` skill — raw truth — direct JSONL and SQLite reads

## When to Use

Use timeline when:
- Reconstructing a session after a compact event
- Answering "what was the decision arc in S42?"
- Finding where a specific decision was made (look at ⚖️ decision phases)
- Debugging a session still in progress (pending turns render mechanical signals)
- Understanding the rhythm / pressure of a session (gaps, tool bursts)

Use recall for content navigation; use mnemo-replay skill for byte-accurate raw transcripts.

## Input

```
timeline(id="S42")
```

The input has exactly one field: `id`. No depth, no page, no pageSize, no truncate.

### Range syntax

| Form | Returns |
|---|---|
| `S42` | First 30 turns (T1..T30 or the whole session if shorter) |
| `S42/T*` | Same as `S42` (wildcard is an alias for "first page") |
| `S42/T10..30` | Closed range T10-T30 (21 turns) |
| `S42/T10..50` | **Truncated** to T10-T39 (30-row cap); header shows next hint |
| `S42/T..20` | Half-open: T1-T20 |
| `S42/T30..` | Half-open: T30-T59 (30-row cap) |

**Hard 30-turn cap**: timeline always returns at most 30 turns in the table. Phases and session metadata are always full-session regardless of range. To scroll through a long session, step through ranges:

```
timeline(id="S42")           # T1..T30
timeline(id="S42/T31..60")   # T31..T60
timeline(id="S42/T61..90")   # T61..T90
```

The `showing:` line in each output tells you exactly which range to pass next.

### Single-turn forms

`timeline(id="S42/T10")` is an **error**. For a single-turn detail, use `recall(id="S42/T10", depth="expanded")`.

## Output Structure

### Session header (6 metadata lines)

```
- [S42] 2026-04-11 09:50 → 11:36 (1h 46m, compact at T21)
  claude-mnemo | 21 turns | 111 tool_calls
  types: 🔵9 ⚖️1 ✅4 ⏳3 (session-wide)
  showing: T1-T21 of 21 (end)
  tz: CST (+08:00)
  raw: ~/.claude/projects/.../<uuid>.jsonl
```

1. **Identity**: session id, local-tz date/time range, duration, compact boundaries
2. **Stats**: project, total turns, total tool calls
3. **Types distribution**: emoji counts across the whole session
4. **Showing**: current window + next-hint
5. **Timezone**: explicit tz name + UTC offset
6. **Raw**: absolute JSONL path — copy-paste hand-off to the `mnemo-replay` skill

### Turn table (two columns: prompt + title)

```
  T#    time    gap         stats          prompt                                                    title
  ───   ─────   ─────────   ────────────   ───────────────────────────────────────────────────────   ────────────────────────────────────────
  T6    10:01   +3m52s      🔧2            方案 A 是什么                                             ⚖️ Adopt sentinel cwd option A
  T7    10:03   +1m24s      🔧1            可以                                                      ⚖️ Approve sentinel cwd direction
  T10   10:18   +6m27s      🔧3            可以,写一份新的 spec                                      ⚖️ Kick off workdir-isolation spec
```

- **prompt** column (200 char cap) = cleaned raw user prompt
- **title** column (40 char cap) = `<type_emoji> <Mnemosyne title>` when extracted, `⏳` when pending, strikethrough when undone
- Type emoji in the title column creates a vertical "phase strip" — scan it top-to-bottom

**Markers:**
- `⨯` prefix on `T#` = undone turn
- `※` after gap = broken-prompt candidate (next turn shares 20+ char prefix within 5 minutes)
- `[ext:<name>]` prefix in prompt column = external-source turn
- `🔧N 📖N ✏️N` stats = tool calls / files read / files modified

### Phases block (session-wide)

```
  phases (session-wide):
    1. 🔵 discovery   T1-T5       ~8m    5 turns   📖21 🔧33
    2. ⚖️ decision    T6-T7       ~4m    2 turns   🔧3
    ...
```

A phase is a run-length-encoded span of same-type turns. Labels are the `turn.type` enum values. Pending turns (null type) form their own "pending" phase.

**Phases always reflect the whole session**, even when the turn table is windowed.

### Shape signals (window-scoped)

```
  shape signals (window T1-T21 = full session):
    - fastest gap:   after T3  (+12s)
    - longest gap:   after T5  (+13m45s)   ← pressure toward ⚖️ decision T6
    - tool bursts:   T5 🔧15, T11 🔧12, T21 🔧8   [median 🔧2, threshold >🔧4]
    - broken-prompt: T15→T17
    - undone turns:  T16
    - external inputs: T11 [ext:codex]
    - compact boundary: after T21 (within window)
```

Signals are computed over the returned window only. The `threshold >🔧N` tells you the bar (2 × median) to clear to be flagged as a burst.

## Workflow examples

### Reconstruct after compact

```
recall()                                         # → recent sessions
timeline(id="S42")                               # → T1..T30 + phases + signals
timeline(id="S42/T31..")                         # → scroll forward
recall(id="S42/T19", depth="expanded")           # → zoom into a specific turn
# Raw: mnemo-replay skill → Read <path from `raw:` line>
```

### Locate a decision

```
recall(query="workdir isolation")
# → [S42] "Mnemo agent workdir isolation design"
timeline(id="S42")
# → see ⚖️ decision phases; notice 13m45s longest-gap pause before T19
recall(id="S42/T19", depth="expanded")
# → read the decision's content/insight
```

### Debug the live session

```
timeline(id="S<current>")
# → pending turns (⏳) still render with mechanical signals
# → undone turns show strikethrough
# → broken-prompts visible with ※
```

## Design notes

- Timeline reads **only SQLite** — no JSONL parsing
- Timeline is **main-agent only**. Mnemosyne does not receive timeline
- Cross-session timelines are deferred to v2
- Local timezone rendering uses the system tz via `Intl.DateTimeFormat`
- The 30-turn hard cap is intentional: larger windows hurt readability and blow context budget
```

- [ ] **Step 2: Commit**

```bash
git add plugin/skills/mnemo-timeline/SKILL.md
git commit -m "docs(skill): add mnemo-timeline skill"
```

---

### Task 7: Update `plugin/CLAUDE.md` for timeline

**Files:**
- Modify: `plugin/CLAUDE.md`

- [ ] **Step 1: Replace the context block**

```markdown
<claude-mnemo-context>
Claude-Mnemo is installed in this environment.

Three-axis memory, three structured tools + one skill:
- `recall` MCP tool — content axis: high-entropy semantic index
- `timeline` MCP tool — temporal axis: decision arc, phases, gaps, bursts
- `mnemo-replay` skill — raw axis: JSONL + SQLite direct access
- `remember` MCP tool — the single write path

Preferred workflow: browse → shape → detail → raw.

1. `recall()` to browse recent memory or `recall(query=...)` / `recall(time=...)` to narrow.
2. `timeline(id="S<n>")` to see the session's shape — decision arc, gaps, phases.
3. `recall(id="S<n>/T<m>", depth="expanded")` to zoom into a specific turn's content.
4. Use the `mnemo-replay` skill only when exact wording or full tool output matters — the `raw:` line in an expanded recall or timeline result is your hand-off.
</claude-mnemo-context>
```

- [ ] **Step 2: Commit**

```bash
git add plugin/CLAUDE.md
git commit -m "docs(plugin): add timeline to CLAUDE.md three-axis model"
```

---

### Task 8: Update `docs/design.md`

**Files:**
- Modify: `docs/design.md`

- [ ] **Step 1: Update Tool surface section**

Replace with:

```markdown
### Tool surface

Claude-Mnemo exposes **three structured MCP tools** plus a raw-access skill:

1. **`remember`** — the single routed write tool.
2. **`recall`** — the semantic content index. Paginated (`page` + `pageSize`), truncated (`truncate`), depth-controlled (`collapsed` / `expanded`).
3. **`timeline`** — the temporal shape renderer. Single-session; range-based pagination with a 30-turn hard cap. No depth, no pageSize.
4. **`mnemo-replay` skill** — not a tool; a skill that points agents at the raw JSONL transcript and the SQLite database for byte-accurate reads.

**Three read axes** map cleanly:

| Axis | Surface | Answers |
|---|---|---|
| Content | `recall` | What is this session about? |
| Temporal | `timeline` | How did this session unfold? |
| Raw | `mnemo-replay` skill | What were the exact bytes? |

Mnemosyne's extraction agent sees only `remember` + `recall`.
```

- [ ] **Step 2: Update Display and Rendering section**

Append:

```markdown
#### Timeline rendering

Timeline uses its own renderer in `src/mcp/timeline.ts`, not the shared `format.ts` `renderNode` path. Rationale: timeline's output shape (6-line session header + two-column turn table + phases block + shape signals block) is incompatible with recall's node-based hierarchical renderer.

Timeline's turn table has **two label columns**: `prompt` (200 chars, cleaned raw user prompt) and `title` (40 chars, `<type_emoji> <Mnemosyne title>`). The separation is deliberate — raw prompt is ground truth (what the user asked), title is the LLM-compressed outcome summary (what the turn did).

The `TYPE_EMOJI` constant in `src/mcp/format.ts` is first consumed by timeline via a local `TYPE_EMOJI_MAP` copy. Before timeline shipped, `TYPE_EMOJI` was exported but never imported — an orphan pattern timeline finally closes.
```

- [ ] **Step 3: Commit**

```bash
git add docs/design.md
git commit -m "docs(design): add timeline to tool surface and rendering sections"
```

---

### Task 9: End-to-end verification

- [ ] **Step 1: Full test suite**

```bash
bun test
```
Expected: all PASS.

- [ ] **Step 2: Typecheck**

```bash
bun run typecheck
```
Expected: zero errors.

- [ ] **Step 3: Verify Mnemosyne has exactly two tools**

```bash
grep -c "deps.toolImpl" src/worker/agent-session.ts
```
Expected: `2`.

```bash
grep 'deps.toolImpl(' src/worker/agent-session.ts
```
Expected: `remember` and `recall` only. **Zero for timeline.**

- [ ] **Step 4: Verify main MCP server registers three tools**

```bash
grep -c 'server.registerTool(' src/mcp/server.ts
```
Expected: `3`.

- [ ] **Step 5: Grep for residual `depth` / `pageSize` in timeline.ts**

Grep `depth|pageSize` in `src/mcp/timeline.ts`.
Expected: zero matches.

- [ ] **Step 6: Manual smoke test (optional)**

```typescript
import { createDatabase } from "./src/db/database";
import { initializeSchema } from "./src/db/schema";
import { timelineQuery } from "./src/mcp/timeline";

const db = createDatabase({ path: "~/.claude-mnemo/db.sqlite" });
initializeSchema(db);
console.log(timelineQuery(db, { id: "S1" }));
```

Visually inspect: all 6 header lines, two-column table, phases reflect session shape, signals block has values.

- [ ] **Step 7: Commit (may be empty)**

```bash
git commit --allow-empty -m "chore: verify timeline view spec is green end-to-end

- Full test suite passes.
- Type-check clean.
- Mnemosyne SDK server still has exactly 2 tools (remember + recall).
- Main MCP server registers 3 tools (recall + timeline + remember).
- Timeline has no depth/pageSize parameters; single id-based input."
```

---

## Tests summary

| Test | Location | Task |
|---|---|---|
| `timelineInputSchema accepts all range forms` | `tests/mcp/definitions.test.ts` | 1 |
| `tool surface includes timeline` | `tests/mcp/definitions.test.ts` | 1 |
| `parseTimelineId` across all range forms | `tests/mcp/timeline.test.ts` | 2 |
| `resolveWindow` default / cap / truncation / half-open | `tests/mcp/timeline.test.ts` | 2 |
| `cleanPromptForLabel` wrappers / whitespace / CJK | `tests/mcp/timeline.test.ts` | 2 |
| `truncateText` edges | `tests/mcp/timeline.test.ts` | 2 |
| `formatDuration` / `formatGap` units | `tests/mcp/timeline.test.ts` | 2 |
| `formatLocalTime` format shape (tz-loose) | `tests/mcp/timeline.test.ts` | 2 |
| `segmentPhases` RLE + undone skip + pending | `tests/mcp/timeline.test.ts` | 2 |
| `computeTypesDistribution` counts + undone exclusion | `tests/mcp/timeline.test.ts` | 2 |
| `detectBrokenPromptPairs` prefix / gap / undone skip | `tests/mcp/timeline.test.ts` | 2 |
| `detectShapeSignals` fastest / longest / median / threshold | `tests/mcp/timeline.test.ts` | 2 |
| `buildTimelineView` full / windowed / phases / signals / compact | `tests/mcp/timeline.test.ts` | 3 |
| `renderTimeline` header + table + showing + pending | `tests/mcp/timeline.test.ts` | 4 |
| `createMcpServer` registers timeline | `tests/mcp/server.test.ts` | 5 |

---

## Implementation order

1. Task 1: Definitions + schema + stub file
2. Task 2: Pure helpers (TDD, one helper per step)
3. Task 3: DB-backed view builder
4. Task 4: Renderers + real `timelineQuery`
5. Task 5: Main MCP server registration (NOT agent-session.ts)
6. Task 6: `mnemo-timeline` skill
7. Task 7: `plugin/CLAUDE.md` update
8. Task 8: `docs/design.md` update
9. Task 9: End-to-end verification

Each task commits independently. Full test suite green after every task.

---

## Self-review checklist

- [ ] **D1** (phase RLE + undone transparent) — Task 2 `segmentPhases`
- [ ] **D2** (30-turn cap + range syntax) — Task 1 schema, Task 2 parser+window, Task 4 `formatShowingLine`
- [ ] **D3** (scope: header+phases full, signals+table windowed) — Task 3 view builder, Task 4 renderer
- [ ] **D4** (cross-session deferred) — Task 2 parser rejects multi-session
- [ ] **D5** (null-type pending first-class) — Task 2 segmentPhases, Task 4 title cell
- [ ] **D6** (separate skill file) — Task 6
- [ ] **D7** (broken-prompt detection) — Task 2 `detectBrokenPromptPairs`
- [ ] **D8** (source:* tags → ext badges) — Task 2 extractSourceTags, Task 4 prompt column prefix
- [ ] **D9** (design.md "three structured tools") — Task 8
- [ ] **D10** (plugin/CLAUDE.md three-axis) — Task 7
- [ ] **D11** (local tz rendering + tz header line) — Task 2 helpers, Task 4 header
- [ ] **D12** (undone strikethrough + phase skip + signal exclude) — Task 2 + Task 4
- [ ] **D13** (two-column prompt + title) — Task 4 `renderTurnTable`
- [ ] **Mnemosyne tool surface unchanged** — Task 9 Step 3: grep = 2
- [ ] **Main MCP server = 3 tools** — Task 9 Step 4
- [ ] **No depth/pageSize in timeline** — Task 9 Step 5

**Type consistency:**
- `RangeSpec` has all five kinds; `resolveWindow` handles each exhaustively
- `Phase.kind` enum matches declaration and usage
- `formatLocalTime(epochSeconds)` unit matches `turn.createdAtEpoch` unit — verify before committing Task 2

**Invariants:**
- Prompt cleaning deterministic, no locale dependency
- Local-tz rendering uses `undefined` locale so tests don't break on non-UTC machines
- Undone handling consistent across `segmentPhases`, `detectShapeSignals`, `computeTypesDistribution`, `renderTurnRow`
- `TIMELINE_WINDOW_CAP = 30` used everywhere; no stray hardcoded 30s
- `[ext:*]` badges appear in prompt column, never title column

---

## Follow-up items (NOT in v1)

1. **Cross-session timelines** (`id="S40..42"`, `time="-7d"`)
2. **Mnemosyne source tagging** — modify Mnemosyne prompt to tag external-input turns
3. **Shared `TYPE_EMOJI` import** between `format.ts` and `timeline.ts`
4. **Turn-range selector in recall** — consolidate `Tm..k` parsing with recall's existing parser
5. **Timeline SessionStart integration** — inject collapsed timeline at session start
6. **Memory (`M` records) timeline** — different view, would need separate design
7. **Bigger window cap via explicit flag** — if 30-turn cap proves painful

---

## Execution handoff

**Plan complete and saved to `docs/plans/2026-04-11-timeline-view.md`.** Two execution options:

1. **Subagent-Driven (recommended)** — dispatch fresh subagent per task, two-stage review. Task 2's many independent sub-steps parallelize well.

2. **Inline Execution** — sequential via `superpowers:executing-plans`.

**Hard prerequisite**: `docs/plans/2026-04-11-read-surface-refactor.md` must land before Task 1 of this spec.
