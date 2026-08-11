# Observation payload projection — data survey

Source: `~/.claude-mnemo/claude-mnemo.db`, table `observations`, read-only (`sqlite3 -readonly` / Python `sqlite3.connect(uri=True, mode=ro)`). Era cutoff `created_at_epoch >= 1786427403`.

At query time: **457 era rows** (10 distinct `tool_name`), **71,924 legacy rows**. Legacy was sampled with a spread predicate (`id % 130 = 0`, 553 rows) rather than `ORDER BY RANDOM()`, to avoid a full-table sort on a read-only 72K-row table and still cover the whole id range. All raw dumps live in `/tmp/era_rows.json` (all 457 era rows) and `/tmp/legacy_sample.json` (553-row legacy sample) if re-analysis is needed; they are not part of this deliverable and can be discarded.

## 1. Frequency table (era rows, n=457)

| tool_name | n | share | cumulative |
|---|---:|---:|---:|
| Bash | 281 | 61.49% | 61.49% |
| Edit | 62 | 13.57% | 75.05% |
| mcp__plugin_claude-mnemo_mnemo__note | 37 | 8.10% | 83.15% |
| Write | 30 | 6.56% | 89.72% |
| Read | 27 | 5.91% | 95.62% |
| Agent | 12 | 2.63% | 98.25% |
| mcp__plugin_claude-mnemo_mnemo__recall | 4 | 0.88% | 99.12% |
| ToolSearch | 2 | 0.44% | 99.56% |
| AskUserQuestion | 1 | 0.22% | 99.78% |
| EnterPlanMode | 1 | 0.22% | 100.00% |

Six named tools (Bash, Edit, Write, Read, Agent, mcp__note) already cover **95.62%** of era rows. The generic fallback only has to look decent on the remaining **4.38%** (18 rows across mcp__recall/ToolSearch/AskUserQuestion/EnterPlanMode) plus whatever tools show up in the future that never appeared in this window (Task, Glob, Grep, TodoWrite, WebFetch, WebSearch — see §5).

**Required-tool coverage note**: the brief also names `Task`, `Glob`, `Grep`, `TodoWrite`, `WebFetch`, `WebSearch`. None of these occur in the 457 era rows. `Task` as a literal tool name doesn't exist in this deployment's tool set at all, in either era or legacy — the actual tool names are `TaskCreate` / `TaskUpdate`. `TodoWrite` never appears in either sample (superseded by TaskCreate/TaskUpdate). Shapes for Glob/Grep/WebFetch/WebSearch/TaskCreate/TaskUpdate below are drawn from the legacy sample since era has zero instances.

## 2. Per-tool key inventory, classification, and projection

Legend: **signal** = a reader wants it; **duplicate** = repeats a value already in the input; **bulk** = whole file / large structure; **flag** = boolean/constant, almost always the same value.

### Bash (n=281, 61.5% of era)

`tool_input`: `command` (100%, string), `description` (96%, string), `timeout` (58%, number).
`tool_result`: `stdout` (100%, string), `stderr` (100%, string), `interrupted` (100%, bool), `isImage` (100%, bool), `noOutputExpected` (100%, bool), `gitOperation` (1%, object — only `{"push":{"branch":"main"}}`, seen on 2/281 rows).

Classification:
- `command` — **signal** (the call itself).
- `description` — **signal** (short human label, cheap to show, 96% populated).
- `timeout` — **flag**, only present when set (163/281); default path has no override.
- `stdout` — **signal**, but the real payload; empty in only 10/281 rows. Median 562 chars, p90 2311, max 20802 — long tail needs truncation.
- `stderr` — **flag-leaning signal**: empty in 262/281 (93%); when present it's diagnostic and should be shown (max 63 chars in the sample, but this is a small n and stderr is unbounded in principle).
- `interrupted`, `isImage`, `noOutputExpected` — **flag**: constant `False` across all 281 era rows. Worth a conditional render only when non-default (never observed true here, but the schema clearly allows it).
- `gitOperation` — **flag/signal hybrid**: rare (2/281) but meaningful when present (this Bash call did a `git push`). Cheap one-line callout when present, silent otherwise.

Real example (id=71925):
```
INPUT:  {"command": "sqlite3 -readonly ~/.claude-mnemo/claude-mnemo.db \"SELECT * FROM era_state;\" ..."}
RESULT: {"stdout": "1|1786427403|1786427403\n--- 新纪元 turn 状态 ---\nactive|1", "stderr": "", "interrupted": false, ...}
```

Projection: CALL = `command` (truncate ~150–200 chars, de-escape `\n`, collapse to first line or first N lines), append `description` if present. RESULT = `stdout` truncated (~300 chars budget) + `stderr` appended only if non-empty + a one-line note if `interrupted`/`gitOperation` is non-default.

### Edit (n=62, 13.6% of era)

`tool_input`: `file_path`, `old_string`, `new_string` (all 100%, string), `replace_all` (100%, bool, always `False` in sample).
`tool_result`: `filePath`, `oldString`, `newString`, `originalFile` (100%, string), `structuredPatch` (100%, array), `userModified`, `replaceAll` (100%, bool, always `False`), `staleRecovered` (3%, bool), `memdirStamped` (2%, bool — era-only, see §6).

Verified duplicates (not assumed):
- `result.oldString == input.old_string` in **62/62**.
- `result.newString == input.new_string` in **62/62**.
- `result.filePath == input.file_path` in **62/62**.
→ these three are **duplicate**, 100% confirmed.

`originalFile` is the **whole pre-edit file**, not just the changed region: median 23,494 chars vs. `old_string` median 172 chars; longer than `old_string` by >1.5× in **62/62** rows. Classified **bulk**.

`structuredPatch` (median JSON length 1220, p90 2568) is a derivable diff view of `old_string`/`new_string`, already known from the input — **duplicate** (different encoding of the same information, not new signal).

`userModified`, `replaceAll` — **flag**, constant `False` in all 62 rows.

Projection: CALL = `file_path` + a compact before/after preview (first ~80 chars each of `old_string`/`new_string`, or a line-delta computed once from `structuredPatch`). RESULT = **nothing** beyond a success marker — every field is either duplicate or bulk. This is the largest win in the table (see §4).

### Write (n=30, 6.6% of era)

`tool_input`: `file_path`, `content` (100%, string).
`tool_result`: `type` (100%, string: `create` 24/30, `update` 6/30), `filePath`, `content` (100%, string), `structuredPatch` (100%, array), `originalFile` (100%, but `null` for 24/30 `create` rows, string for the 6 `update` rows), `userModified` (100%, bool, always `False`), `memdirStamped` (3%, bool).

Verified: `result.filePath == input.file_path` in **30/30**; `result.content == input.content` in **29/30** (one 35-char mismatch, id=71985 — tails match exactly, difference is upstream of the render layer, not a projection concern). → `content`, `filePath` are **duplicate**.

`structuredPatch` — **duplicate** (derived from content, same reasoning as Edit). `originalFile` — **bulk when present**, but note it's `null` for creates — a diff-style projection must branch on `type`, not assume both old/new exist (see §6).

Projection: CALL = `file_path` + `type`-aware verb ("write N bytes to …") + optional short content preview for small files. RESULT = **nothing** beyond the `type` (create/update) already summarized in the call line — content is a full duplicate.

### Read (n=27, 5.9% of era)

`tool_input`: `file_path` (100%), `offset`/`limit` (81% each, number).
`tool_result`: `type` (100%, string, constant `"text"` — **flag**, no information), `file` (100%, object) containing `filePath` (matches `input.file_path` in **27/27** → **duplicate**), `content` (string, **bulk** — median 1145 chars, p90 2300, max 9387; this is the literal file slice), `numLines`, `startLine`, `totalLines` (100%, numbers — **signal**, cheap, tells the reader what range was read).

Projection: CALL = `file_path[offset:offset+limit]` one line. RESULT = `"{numLines} lines ({startLine}–{startLine+numLines})"` — not the content itself. `file.content` is the single biggest bulk item relative to how small its own tool_input already is (input median 98 chars vs. result median 1366).

### Agent (n=12, 2.6% of era) — bimodal result shape, see §6 risk

`tool_input`: `description`, `prompt`, `subagent_type` (100%, string), `model` (83%, string), `run_in_background` (42%, bool).
`tool_result` splits by `status`: **`async_launched` (11/12)** → `status`, `agentId`, `resolvedModel`, `prompt` (echo, matches input in 12/12 sampled incl. the completed one), `isAsync`, `description` (echo, matches input in 11/12), `outputFile` (ephemeral tmp path), `canReadOutputFile`. **`completed` (1/12)** → additionally `agentType`, `content` (array, MCP-content-array shape, the actual final report text, 5770 chars for the one sample), `totalDurationMs`, `totalTokens`, `totalToolUseCount`, `usage` (object), `toolStats` (object).

`prompt`, `description` in the result — **duplicate** of input (verified 12/12 and 11/12).

Projection: CALL = `description` + `subagent_type` + first ~150 chars of `prompt`. RESULT is genuinely two different projections gated on `status`:
- `async_launched` → `"launched in background ({subagent_type}): {description}"` — do **not** try to project a result payload, there isn't one yet (see §6).
- `completed` → `content[0].text` truncated (~400–500 chars) — this is the one case in the whole table where the *result*, not the call, is the valuable long text.

### mcp__plugin_claude-mnemo_mnemo__note (n=37, 8.1% of era)

`tool_input`: `turn` (100%, string), `title` (92%, string), `content` (92%, string — median 1170 chars, this is the note body, **signal**, not bulk: it's the actual point of the call), `insight` (30%, string), `skip` (8%, bool), `replace` (3%, bool).
`tool_result`: **not an object** — MCP content-array shape `[{"type":"text","text":"..."}]` in 37/37. `text` is a short ack, median 133 chars, max 191 — e.g. `"Noted S15069/T485. ride_turn: ... writer_model: not recorded — this environment does not expose the model to the MCP server."` or `"Skipped S15069/T451. Its debt is closed as declined..."`.

Classification: `title` — **signal**. `content`/`insight` — **signal** (not duplicate: nothing upstream repeats them). `turn` — **signal**, small, useful for correlation. `skip`/`replace` — **flag**, rare, meaningful when true. Result `text` — mostly **flag-like** (boilerplate "Noted S…/T…" prefix repeats info already in `turn`), but the leading word (`Noted`/`Skipped`) is a real outcome signal.

Projection: CALL = `title` (fallback to first ~100 chars of `content` if no title). RESULT = first word of `text` (Noted/Skipped) — the rest is boilerplate.

### mcp__plugin_claude-mnemo_mnemo__recall (n=4, 0.9% of era — below 1% but included as required, being an mcp__* tool)

`tool_input`: `id` (75%), `pageSize` (75%, number), `depth` (25%, string), `truncate` (25%, number), `query` (25%, string) — this tool has two call modes (by-id vs. by-query) so key presence is naturally partial, not a data-quality issue.
`tool_result`: same MCP content-array shape as `note`, but `text` is **real search-result content**, median 2869 chars, p90 4233 — the actual recall answer, **signal**, not boilerplate. Do not treat this like `note`'s ack text.

Projection: CALL = whichever of `id`/`query` is present + `depth`/`truncate` if set. RESULT = `text` truncated to a larger budget than most tools (~500 chars) since it's the substantive payload, not filler.

### ToolSearch (n=2, 0.4%), AskUserQuestion (n=1), EnterPlanMode (n=1)

Too few rows for a stable per-tool rule; all fall to the generic fallback (§5). Shapes for reference: `ToolSearch` result = `{"matches":[...], "query":"...", "total_deferred_tools": N}` (small, flat, no bulk). `AskUserQuestion` input/result mirror each other (`questions`/`answers`/`annotations`), i.e. the result **is** an echo of the input plus the answers merged in — classify whole result as **duplicate+signal** (the delta is the answers). `EnterPlanMode` result is just `{"message": "..."}`.

### Not present in era — shapes from legacy sample (for design reference only)

| tool | input keys | result keys | note |
|---|---|---|---|
| Glob | `pattern` | `filenames`(array), `numFiles`, `durationMs`, `truncated` | `filenames` bulk if `numFiles` large; `truncated` is a real flag |
| Grep | `pattern`, `path`, `output_mode`, `-n`, `-C` | `content`(string), `numLines`, `numFiles`, `mode`, `filenames` | `content` is bulk in `-C`/context mode, signal in `count` mode — mode-dependent |
| WebFetch | `url`, `prompt` | `code`, `codeText`, `bytes`, `durationMs`, `result`(string) | `result` is the fetched/summarized text — signal, can be large |
| WebSearch | `query` | `query`(dup), `searchCount`, `durationSeconds`, `results`(array) | **`results` array mixes plain strings and `{tool_use_id, content}` dicts** — see §3/§6 |
| TaskCreate | `subject`, `description`, `activeForm` | `task:{id,subject}` | small, near-minimal already |
| TaskUpdate | `taskId`, `status` | `success`, `taskId`, `updatedFields`, `verificationNudgeNeeded` | small, near-minimal already |
| TodoWrite | — | — | **zero rows in era or legacy sample (553 rows); no evidence to characterize** |
| Task (literal) | — | — | **does not exist as a tool name in this deployment**; brief's "Task" maps to TaskCreate/TaskUpdate |

## 3. Non-JSON / surprising payloads

All `tool_input` across era (457/457) and legacy sample (553/553) parses as a JSON object — no surprises on the input side.

`tool_result`:
- **Era**: 41/457 (9.0%) are not objects — all 37 `mcp__…__note` rows + all 4 `mcp__…__recall` rows are JSON **arrays** (`[{"type":"text","text":"..."}]`), the standard MCP content-block shape. 0 parse failures.
- **Legacy sample**: 30/553 (5.4%) non-object results, all MCP tools (`mcp__plugin_playwright_playwright__*` — 25 rows across `browser_select_option`/`take_screenshot`/`wait_for`/`resize`/`navigate`/`evaluate`/`hover`, plus `mcp__…__recall` — 5 rows), same array-of-content-blocks shape. **1 parse failure**: `StructuredOutput` tool, id=15080, `tool_result` = literal string `'Structured output provided successfully'` — not JSON at all, not even a quoted JSON string; `json.loads` throws.

**Rule implied**: any `mcp__*` tool's `tool_result` should be expected to be a JSON array of `{type, text}` blocks, not an object — this is architectural (the MCP content-block protocol), not tool-specific, and held across every mcp__ tool seen in both samples (mnemo, playwright). The non-JSON `StructuredOutput` result is the only outright parse failure found in ~1000 combined rows sampled — rare but the fallback must not crash on it (§5).

Also flagged here rather than in §2: **WebSearch's `results` array is heterogeneous** — items are a mix of `{tool_use_id, content}` dicts and bare narration strings (e.g. `"I'll search for that query now."` appears as a raw array element next to dict entries). Real example (id=3250):
```
"results": [{"tool_use_id": "srvtoolu_01Fh...", "content": []}, "I'll search for that query now.", {"tool_use_id": "srvtoolu_018x...", "content": [...]}]
```
A projection or fallback that assumes uniform item shape inside an array will break here.

## 4. Size numbers (raw JSON string length, chars — min/median/p90/max)

| tool | input | result | result composition | projected result |
|---|---|---|---|---|
| Bash | 49 / 231 / 1075 / 4042 | 86 / 676 / 2468 / 20907 | stdout-dominated (signal) | stdout≤300 chars + stderr if set |
| Edit | 260 / 803 / 2002 / 2785 | 1726 / **27485** / 36875 / 51016 | `originalFile` whole-file (bulk) | ~0 (success marker only) |
| Write | 525 / 1992 / 9007 / 12978 | 602 / 2684 / 12892 / 31645 | `content` duplicate of input | ~10 chars (`type` only) |
| Read | 74 / 98 / 118 / 129 | 513 / 1366 / 2506 / 10226 | `file.content` bulk (whole slice) | ~30 chars (line range) |
| Agent | 1050 / 2923 / 4000 / 4031 | 1274 / 3495 / 4233 / 7845 | bimodal: stub (11/12) or report (1/12) | ~60 chars, or ~500 for completed |
| mcp__note | 34 / 1170 / 1632 / 1987 | 94 / 133 / 160 / 191 | small ack text | first word only (~10 chars) |
| mcp__recall | 36 / 47 / 57 / 57 | 2695 / 2869 / 4233 / 4233 | real answer text (signal) | ~500 chars |
| ToolSearch | 73 / 92 / 110 / 110 | 136 / 174 / 212 / 212 | already small | pass-through |

The Edit result is the standout: **median 27,485 raw chars, of which 100% of the informative fields (`oldString`/`newString`/`filePath`) are exact duplicates of the input and the remaining bulk (`originalFile`, whole pre-edit file) carries zero new information for a reader who already sees the call**. Projecting it to a bare confirmation is a ~99.9% reduction with no signal loss. Write's result is the same pattern one order of magnitude smaller (median 2684 → ~10, content 29/30 verified duplicate).

## 5. Generic fallback rule (tools not in §2, including all future/unseen tools)

For any `tool_name` not covered by a per-tool rule:

1. **De-escape before truncating.** Raw JSON string-escapes (`\n`, `\"`, unicode) must be rendered as literal characters first — this alone fixes most of the "unreadable" complaint from the background, independent of projection.
2. **CALL** (`tool_input`, guaranteed to be a JSON object in both samples, 457/457 and 553/553): pick the first key, in this preference order, that is a non-empty string: `command`, `query`, `pattern`, `prompt`, `description`, `url`, `path`, `file_path`, `subject`. If none match, fall back to `JSON.stringify(tool_input)` truncated to ~200 chars.
3. **RESULT** (`tool_result`): branch on parsed shape.
   - Parses to a JSON **array**: assume MCP content-block shape (`[{type, text}, ...]`); join the `text` fields of items that are dicts with a `text` key, **skip non-dict/no-text items** (required — see WebSearch counter-example in §3), truncate to ~300–500 chars.
   - Parses to a JSON **object**: pick the first key, in preference order, from `result`, `stdout`, `content`, `message`, `text`, `output`; truncate. If none match, `JSON.stringify` truncated.
   - **Fails to parse** (e.g. `StructuredOutput`'s bare string): render the raw string as-is, truncated — do not crash, do not attempt re-parsing.

Evidence this behaves acceptably on tools it would catch: applied by hand to every legacy-only shape found (Glob, Grep, WebFetch, WebSearch, TaskCreate, TaskUpdate, Skill, SendMessage, `mcp__…__playwright__*`, `mcp__…__blender`, `StructuredOutput`) — all either have a matching preference key in step 2/3 or degrade to the truncated-stringify path without crashing. The one shape that needs the explicit array-item guard in step 3 is WebSearch's mixed-type `results` array (§3) — without the dict/`text`-key check, a naive `.map(x => x.text)` throws on the bare-string element.

## 6. Risks

1. **Same key name, different meaning across tools — no global key denylist works.** `content`: Write.tool_input.content = whole file (bulk, drop); mcp__note.tool_input.content = note body (signal, the actual message — dropping it guts the projection); Agent.tool_result.content = final report (signal, only when `status=completed`). `description`: Bash.tool_input.description = cheap useful label (signal); Agent.tool_result.description = pure echo of Agent.tool_input.description (duplicate). `type`: Write.tool_result.type = create/update (signal flag); Read.tool_result.type = constant `"text"` (useless flag). Any per-key rule must be scoped to `(tool_name, field, key)`, not `key` alone.
2. **Agent's result is not the agent's output for backgrounded runs (11/12 sampled).** `status=async_launched` rows only carry a launch stub (`agentId`, `outputFile` — an ephemeral `/private/tmp/claude-501/.../*.output` path, not durably queryable from this DB). The actual completion report for a backgrounded agent is delivered later as a turn-level notification, not as a second `observations` row for the same call — so a projection that reaches for `tool_result.content` will find it in only the 1/12 synchronous-completion case and must not render "no output" as if that were the final state for the other 11.
3. **Write's `originalFile` is `null` for creates (24/30), populated for updates (6/30).** A diff-style projection that assumes both old/new file text exist will render empty or throw on the majority (`create`) case unless it branches on `result.type` first.
4. **Bash's tool_result shape looks version-dependent.** Legacy Bash rows (sampled) carry `dangerouslyDisableSandbox`, `run_in_background` (input) and `returnCodeInterpretation`, `persistedOutputSize`, `backgroundTaskId`, `dangerouslyDisableSandbox`, `persistedOutputPath` (result) that are **absent from all 281 era Bash rows**. Since legacy renders from the extractor summary (not this projection) this isn't a live bug, but if the projection code is ever reused for legacy replay it must tolerate these extra keys rather than assume the era-only key set is exhaustive.
5. **`memdirStamped` and `staleRecovered` (Edit/Write results) appear only in era, never in the legacy sample** — consistent with being new fields, but the sample sizes are small (1–2 occurrences); don't over-fit a rule to them, treat as **flag, render only when true**.
6. **WebSearch's `results` array is heterogeneous** (§3) — any array-processing code (in the fallback or a future WebSearch-specific rule) must guard on item shape, not assume uniform `{type,text}` dicts.
7. **`StructuredOutput`'s non-JSON string result** is the only outright JSON-parse failure across ~1010 combined rows sampled — rare, but a projection that unconditionally calls `JSON.parse(tool_result)` without a try/catch will throw on it.

## Summary of proposed projections (compact)

| tool | CALL renders | RESULT renders |
|---|---|---|
| Bash | `command` (≤200c, de-escaped) + `description` | `stdout` (≤300c) + `stderr` if non-empty + gitOperation note if present |
| Edit | `file_path` + short old/new preview | nothing (success marker) |
| Write | `file_path` + type-aware verb | nothing (`type` already in call) |
| Read | `file_path[offset:+limit]` | `"{numLines} lines ({startLine}–…)"` |
| Agent | `description` + `subagent_type` + prompt preview | `"launched in background: …"` (async) / `content[0].text` ≤500c (completed) |
| mcp__note | `title` (fallback: content preview) | first word of ack text |
| mcp__recall | `id`/`query` + depth/truncate | `text` ≤500c |
| fallback | first matching string key | joined MCP text blocks / first matching object key / raw string, all truncated |
