# Rendering Overflow Design Notes

> **Status**: **Superseded by `2026-04-11-read-surface-refactor.md` (2026-04-11).**
>
> This document captured the findings + open questions that led to the refactor spec. Q1-Q10 were answered in the continuation conversation and locked as decisions D1-D10 in the refactor plan. The decisions went further than the questions: `depth=full` is deleted entirely and `replay` is demoted from MCP tool to skill. See the refactor plan for the final, executable form.
>
> Kept as a historical record of *why* — do not execute from this document.

**Scope**: how `recall` / `replay` / SessionStart context / (future) `timeline` handle two orthogonal overflow problems:

1. **Too many child elements** — a session with 200 turns, a turn with 50 observations, a search with 500 hits
2. **Too-long field values** — a prompt of 5000 characters, a tool output of 20000 characters

---

## Context: why this document exists

During brainstorming for the timeline view spec (`2026-04-11-timeline-view.md`), a detailed review of `src/mcp/format.ts` and `src/mcp/recall.ts` surfaced a set of ergonomic gaps and inconsistencies in the existing rendering layer. The findings do not block the timeline spec, but they indicate that any new tool built on the same renderer would inherit the same gaps. Rather than copy-paste the problems forward, the project is pausing to redesign the overflow handling first.

This document captures:

1. The **frozen findings** — what the current code actually does, with file:line references so a future session can re-verify.
2. The **user-proposed direction** — unified explicit pagination + unified 200-char field truncation with an override parameter.
3. The **open questions** a spec author needs answered before turning this into a task-level plan.
4. The **interactions with other in-flight specs** (workdir-isolation, compact-anchor, timeline-view).

---

## Frozen findings: current overflow behavior

These describe the code as it exists at the time of writing (branch `main`, HEAD around commit `5f9e640`). If a future session finds discrepancies, the code is authoritative — update this doc.

### Mechanism 1: field-level truncation

**Function**: `truncateText` at `src/mcp/format.ts:247-273`

**Limits** (`format.ts:12-17`):

```typescript
const LEGACY_TRUNCATION_LIMIT = 200;
const UNIFIED_TRUNCATION_LIMITS = {
  collapsed: 120,
  expanded:  300,
  full:     1000,
} as const;
```

**Behavior**:
- Slices the string to the limit and appends `...` (`FIELD_TRUNCATION_SUFFIX` at `format.ts:10`).
- In **legacy mode** (`formatSessionCollapsed`, `formatTurnExpanded`, etc. — exported wrappers that pass `mode: "legacy"`), additionally appends a hint like `[use replay(id="S1/T2", depth="expanded") for full content]` via `joinHint` (`format.ts:220-234`).
- In **unified mode** (the path `recall` and `replay` actually call through `renderNode`), **the hint is not appended** — see `format.ts:267-268` `const hint = mode === "legacy" ? joinHint(...) : ""`. This means recall's modern output gives users `...` with no indication of where to fetch the full value.

**Fields passing through `truncateText`**: session.content, session.insight (each line), session.nextSteps, turn.title, turn.content, turn.promptPreview, turn.responsePreview, turn.insight (each line), turn.filesRead.join(", "), turn.filesModified.join(", "), observation.content, toolCall.input (after JSON.stringify), toolCall.result, memory.content, memory.reasoning, memory.application, memory.tags.join(", ").

**Fields NOT truncated**: all IDs (S/T/O/M numbers), stats emoji digits (🔧3 📖5), status labels, formatted dates.

### Mechanism 2: collection-level sampling

**Function**: `sampleWithOmissions<T>(items, isProtected)` at `src/mcp/format.ts:857-929`

**Algorithm**:
1. If `items.length <= 50`: return all items, zero omissions.
2. Otherwise:
   - `headCount = min(5, items.length)` → keep first 5
   - `tailCount = min(10, items.length - headCount)` → keep last 10
   - Middle: pick 5 evenly spaced positions in `[headCount, items.length - tailCount)` via `round((sampleIndex * (middleLength - 1)) / 4)`
   - Union with any item where `isProtected(item, index)` returns truthy
3. Render as a list with gaps represented by `- ... N omitted ...` markers.

**Effective visible count**: baseline 5 + 10 + 5 = **20 items**, plus however many items the caller-provided `isProtected` callback preserves.

**Thresholds are hardcoded**: 50 / 5 / 10 / 5. No parameterization. No caller control.

**Usage sites** and their protection policies:

| Caller | File:line | Collection | `isProtected` |
|---|---|---|---|
| `renderSession` | `recall.ts:499-501` | turns under a session | `turn.status === "active"` |
| `renderTurnScope` | `recall.ts:554-556` | turns under a session (scoped) | `turn.status === "active"` |
| `renderObservationScope` (no parents) | `recall.ts:599` | observations | **none** |
| `renderObservationScope` (with parents) | `recall.ts:666` | observations | **none** |
| `formatTree` legacy | `format.ts:937` | turns | **none** |
| `formatTree` legacy | `format.ts:949-951` | observations | `(observation) => Boolean(observation)` ≈ protects all |

The `(observation) => Boolean(observation)` callback at `format.ts:949-951` is a probable bug or unfinished placeholder — it effectively disables observation sampling in `formatTree`, contradicting `recall.ts:599/666` which allow observation sampling. Needs `git blame` verification.

### Mechanism 3: `limit` parameter

**Location**: `recall.ts:1147` `const limit = input.limit ?? 50`

**Scope**: **top-level result count only**. Not applied to child collections (those go through `sampleWithOmissions` instead).

**Usages**:
- `listSessionIds(limit)` — how many sessions to return from recent or explicit id list
- `searchQueryResults(limit)` — FTS search result count cap
- `renderSessionList(limit)` — session list rendering
- Various `.slice(0, limit)` calls inside `renderRoutedId` for turns / observations / memories / session-observation lists

**`replay` has no `limit` parameter**. It renders whatever the selector resolves to, full size.

### The unequal distribution of overflow protection

Summary table of what each tool gets today:

| Tool | Field truncation | Child sampling | Top-level limit |
|---|---|---|---|
| `recall` | ✓ (depth-based, 120/300/1000) | ✓ (hardcoded >50 → ~20 visible) | ✓ `limit` param, default 50 |
| `replay` | ✓ (depth-based, 120/300/1000) | ✗ none | ✗ no param |
| SessionStart context | ✓ (inherits recall renderer) | ✓ (inherits) | inherits |
| `timeline` (proposed) | TBD | TBD (not planned to sample — time-ordered) | TBD |

---

## The six findings

These are the gaps and inconsistencies identified. Numbered for easy reference.

### Finding 1: `depth=full` is not truly unlimited

The `mnemo-recall` skill file at `plugin/skills/mnemo-recall/SKILL.md` states:

> `full` — Rare. Only for `replay` when you need untruncated tool I/O.

And:

> `full` disables truncation on tool results — use only when you need the exact payload.

**Reality**: `depth=full` still truncates, just at 1000 characters instead of 300. There is no code path anywhere that returns un-truncated strings. A 5000-char tool output gets sliced to 1000 + `...` regardless of depth.

**Implication**: users who need the full original content have no way to get it through the public API. They must read the JSONL file directly.

**Severity**: medium. Documentation / API contract mismatch. Either the docs lie or the code is incomplete.

### Finding 2: unified mode silently drops the truncation hint

In legacy mode, a truncated field becomes `<first 200 chars>... [use replay(id="S1/T2", depth="expanded") for full content]`. In unified mode, it becomes `<first 300 chars>...` — no hint.

This affects all current `recall` and `replay` output (they both use unified mode). The navigation signal "this was truncated, here's how to get the full version" is lost.

**Severity**: low-medium. Ergonomic regression, easy fix (one-line change at `format.ts:267-268`).

### Finding 3: `sampleWithOmissions` thresholds are hardcoded

Everything (50 threshold, 5 head, 10 tail, 5 middle samples = 20 visible) is hardcoded in `format.ts:857-929`. There is no parameter to:
- Disable sampling entirely ("give me all 200 turns")
- Change the threshold ("don't sample until 100 items")
- Change the visible window ("show me 50 items, not 20")

**Severity**: medium. This is the core of the overflow problem the user wants to solve.

### Finding 4: `replay` has no overflow protection for child elements

`replay(id="S12")` on a 200-turn session renders all 200 turns with their full prompts/responses. A 50-turn session can easily produce 30k+ tokens of output. There is no `limit`, no `sampleWithOmissions`, no pagination.

**Current workaround**: users are expected to use narrower selectors (`S12/T3..7`). But this is an undocumented, unenforced convention.

**Severity**: medium-high. Can cause accidental context blowups with no warning.

### Finding 5: observation sampling has no protection mechanism

`recall(id="S12/T3/O*")` applies `sampleWithOmissions` with no `isProtected` callback. If T3 has 200 observations and a critical one is position 73, it will silently disappear from the sampled output. There is no way for a `status="pending"` observation or any other special case to be preserved.

By contrast, turn sampling protects active turns (`turn.status === "active"`).

**Severity**: low in isolation, but compounds with Finding 3. Once sampling becomes opt-in, this may become moot.

### Finding 6: `formatTree` observation callback looks like an unfinished placeholder

`src/mcp/format.ts:949-951`:

```typescript
const observationsResult = sampleWithOmissions(
  entry.observations ?? [],
  (observation) => Boolean(observation),
);
```

`(observation) => Boolean(observation)` returns `true` for any non-null observation, effectively protecting every single one. This disables sampling for observations in `formatTree` but keeps it enabled for the same observations in `recall.ts:599/666`.

Either:
- (a) This is an unfinished placeholder — the author meant to write a real protection predicate but left a stub
- (b) This is intentional but undocumented — `formatTree` has different needs than `renderSession`

**Action needed**: run `git blame src/mcp/format.ts` on those lines to see what commit introduced this and whether the message clarifies intent. If it's a stub, decide on a real policy.

**Severity**: low. But it's the exact kind of silent inconsistency that erodes trust in the renderer.

---

## User-proposed direction

The user reviewed the findings and proposed two design changes:

### Proposal A: unified pagination replaces `limit` parameter and `sampleWithOmissions`

> 统一用分页机制代替 limit 参数，不再隐藏

**Intent**:
- No more hidden sampling. If a collection is large, the caller explicitly asks for a specific page.
- Applied uniformly across recall and replay (and timeline when it lands).
- The `limit` parameter is either replaced or reinterpreted under the pagination model.

**Implications (as I understand them)**:
- `sampleWithOmissions` is removed or made opt-in
- Child collections (turns under a session, observations under a turn) get paginated too, not just top-level lists
- Output format needs to convey "more available" somehow — a hint, a count, a next-page marker

### Proposal B: unified 200-char default field truncation with override parameter

> 字段截断默认统一截断到 200 字符避免爆炸，然后可以用参数指定具体的值

**Intent**:
- Default truncation = 200 chars, regardless of `depth`
- Caller can pass a parameter (name TBD) to override
- Decouples field truncation from depth — depth only controls which fields are shown, not how long each field can be

**Implications**:
- `UNIFIED_TRUNCATION_LIMITS` table disappears
- `depth` becomes purely a "field selection" parameter (what to include/exclude), not a "field size" parameter
- Need to define what the override value means at the extremes — 0? negative? a special "unlimited" token?

---

## Open questions to decide before writing a spec

These are the decision points the user needs to answer. Recommendations included for each, but the user has final say.

### Q1: pagination granularity

Does pagination apply only to **top-level results** (the list of sessions, memories, or search hits), or also to **child collections** (turns inside a session, observations inside a turn)?

**Option A: top-level only** — only the list you're fetching gets paginated. Children are either shown fully or summarized.

**Option B: all levels** — every collection, at every nesting depth, can be paginated. Requires per-level offset params or cursors.

**Option C: hybrid** — top-level is paginated with `offset`/`page`. Child collections have a per-query cap (like 20 or 50 per parent) with an explicit `[+N more, use recall(id="S12/T*", offset=20)]` hint directing the user to a narrower selector.

**Recommendation**: **Option C**. It matches the existing recall mental model (drill down via selectors) and avoids the API complexity of multi-level cursors. Users who want "all observations for this turn" can already use `recall(id="S12/T3/O*", offset=20)` — that narrows the query to a single parent, where flat pagination is natural.

### Q2: pagination style — offset/limit vs cursor vs page number

**Option A: offset + limit** — `recall(..., offset=50, limit=50)`. Easy to understand, stateless. Leaks DB ordering assumptions (if records are inserted between two queries, results shift).

**Option B: cursor-based** — `recall(..., cursor="...")` returns next cursor. Stable under insertion. Opaque to the caller; harder for agents to compose ad-hoc queries.

**Option C: page number** — `recall(..., page=2, pageSize=50)`. Simplest mental model. Requires pre-computing total count (extra query).

**Recommendation**: **Option A (offset + limit)**. Stateless, composable, agent-friendly. The shift-under-insertion concern is minor for claude-mnemo because inserts happen at session end (end of list) rather than scattered through history — offset-based queries on past sessions are stable in practice.

Rename the parameter from `limit` to something clearer like `pageSize` or `take`. Add `offset` alongside.

### Q3: default page size — scale with depth or fixed

Token budget per item varies dramatically by depth:
- `collapsed` turn: ~50 tokens
- `expanded` turn: ~500 tokens
- `full` turn with observations: ~2000 tokens

A fixed `pageSize=50` means:
- collapsed: ~2500 tokens per page (comfortable)
- expanded: ~25000 tokens per page (too much)
- full: ~100000 tokens per page (catastrophic)

**Option A: fixed default** (e.g. `pageSize=50`) regardless of depth. Simple, but dangerous at deeper depths.

**Option B: depth-scaled defaults** — `collapsed: 50, expanded: 20, full: 5`. Keeps each page roughly token-balanced. Predictable behavior.

**Option C: token-budget-based** — target X tokens per page, compute item count. Most principled, hardest to implement.

**Recommendation**: **Option B**. Simple to implement, predictable, token-aware by construction. Document the defaults in the skill files so agents can reason about them.

### Q4: `sampleWithOmissions` — remove entirely or make opt-in

**Option A: remove entirely** — all callers switch to pagination. `formatTree` either gets paginated or the function is dropped.

**Option B: make opt-in via a `sample=true` flag** — keep the head/middle/tail overview as an explicit feature for "give me a shape sense" queries.

**Option C: reframe as a distinct tool/mode** — `recall(..., mode="overview")` returns head/middle/tail, `mode="page"` returns a contiguous page.

**Recommendation**: **Option A (remove)**. The overview use case is already served by `depth="collapsed"` on the session level. The sample-based overview muddles two different questions and confuses agents about whether they're seeing the full collection or a summary. Simpler mental model wins.

One caveat: the `protect active turns` behavior (turns with `status="active"` always shown) serves a real purpose — in-flight work should not disappear from view. If we remove sampleWithOmissions, we need to preserve that guarantee by always including active turns in the first page or by sorting active turns to the front. This is a detail, not a blocker.

### Q5: field truncate parameter shape

The user wants: default 200 chars, override via parameter.

**Option A: single global param** — `recall(..., truncate=500)` sets every field's cap to 500.

**Option B: per-field-type** — `recall(..., truncate={ content: 500, toolResult: 2000 })`. Fine-grained, but complex.

**Option C: depth-tied default with global override** — `truncate=500` overrides all; no override means a depth-specific default (defaulting to 200 at all depths, matching the user's proposal).

**Recommendation**: **Option A** for v1. Global parameter, single integer, applied to every truncated field. Per-field granularity can be added later if a real use case emerges. Document that unusual use cases (fetching a specific large tool output) should use `replay` with a specific selector rather than passing `truncate=999999` broadly.

### Q6: `truncate` sentinel for unlimited

If the parameter is an integer, what represents "no truncation"?

**Option A: `0`** — zero chars = unlimited (semantically confusing: zero chars usually means empty string).

**Option B: negative number** — `truncate=-1` = unlimited. Clear intent but arbitrary magic value.

**Option C: a very large number** — `truncate=999999`. Practical but hacky.

**Option D: special string** — `truncate="unlimited"` or `truncate=null`. Mixed types complicate Zod schema.

**Option E: separate boolean** — `truncate=200` and `unlimited=true` as mutually exclusive. Two params.

**Recommendation**: **Option B (negative = unlimited)**. `-1` is a well-known sentinel for "no limit" in many APIs. Zod schema stays clean (`z.number().int()`). Document it clearly. Positive integers do what they say; `-1` means unlimited.

### Q7: replay default truncate value

`replay`'s purpose is byte-accurate reproduction. A 200-char default would violate its contract.

**Option A: same 200 default as recall** — consistent API surface, but replay loses its core value. Users would always need to pass `truncate=-1`.

**Option B: replay-specific default** — e.g. replay defaults to `truncate=5000` or `truncate=-1` (unlimited).

**Option C: require explicit `truncate` for replay** — no default, fail loudly if omitted.

**Recommendation**: **Option B with unlimited default** — `replay(..., truncate=-1)` is the default. This matches replay's stated purpose (byte-accurate). Users who want a bounded replay (e.g. to sanity-check) can pass an explicit truncate value. Document prominently that replay output can be very large by design.

Interaction note: replay also needs pagination (Finding 4). With pagination, unlimited truncate is much safer because pageSize caps the item count even if individual items are long.

### Q8: restore the `[use replay(...) for full content]` hint in unified mode

Finding 2 showed that unified mode silently drops the navigation hint. Should the refactor include restoring it?

**Option A: yes, always hint** — every truncated field in every output gets a navigation hint.

**Option B: yes, but only when truncation happened** — if the field fits within truncate budget, no hint; only add hint when something was actually cut.

**Option C: no, keep dropping it** — the `...` suffix is enough signal.

**Recommendation**: **Option B**. Restore the hint, but only when truncation occurred. Avoids noise for short fields. Matches the legacy mode behavior's intent.

Implementation note: the hint should direct to `replay` (byte-accurate) by default, since `recall(..., truncate=-1)` could theoretically serve the same role but is a less clear signal. Recommend `replay(id="<session>/<turn>", truncate=-1)` as the canonical "see full content" hint.

### Q9: does the refactor apply to SessionStart context injection

`src/hooks/session-start.ts` (or similar) uses the same renderer via SessionStart to inject context at the start of each session. That context is tightly token-budgeted.

**Option A: SessionStart uses the same new defaults** — `truncate=200`, paginated. Token budget is controlled by pagination + truncation just like recall.

**Option B: SessionStart passes explicit conservative params** — e.g. `truncate=120, pageSize=5`. Keeps SessionStart tight regardless of default changes.

**Option C: SessionStart has its own renderer path** — separate from the general unified renderer.

**Recommendation**: **Option B**. SessionStart has unique constraints (must fit in injected context budget, must cover multiple collections — recent sessions, current session summary, relevant memories). It should pass explicit params optimized for its use case, not rely on defaults that might change for other reasons. The renderer stays shared; the params are per-caller.

Verify current SessionStart behavior before finalizing — I have not read `src/hooks/session-start.ts` yet in this context.

### Q10: `limit` parameter backward compatibility

Current callers may pass `recall(..., limit=100)`. How does the refactor handle this?

**Option A: hard rename** — remove `limit`, require `pageSize`. Breaks existing skill files and any ad-hoc calls. Needs a migration.

**Option B: alias** — both `limit` and `pageSize` work, `limit` is deprecated but functional. Add a deprecation warning in output or docs. Remove in a future version.

**Option C: keep `limit`, redefine it as "page size"** — no rename, just new semantics. Existing callers keep working. But the name `limit` is misleading for a page-size concept.

**Recommendation**: **Option B**. Alias `limit` to `pageSize` for one or two release cycles, then remove. Update all skill files in the same PR as the refactor so internal callers are already on the new name. External callers (other Claude Code users) get a grace period. This is the least disruptive path.

---

## Interactions with other in-flight specs

### `docs/plans/2026-04-11-mnemo-agent-workdir-isolation.md`

**No interaction.** Workdir-isolation is a worker-side change (SDK cwd + resume). Rendering layer is untouched.

### `docs/plans/2026-04-11-compact-anchor-and-debug-docs.md`

**Minor interaction.** Compact-anchor spec updates README debug docs. If the rendering refactor changes `recall`/`replay` skill files, there's potential for merge contention with the debug docs chapter. Sequencing: compact-anchor should land before the rendering refactor, so the debug docs can reference the pre-refactor API, and the rendering refactor updates them in its own commit.

### `docs/plans/2026-04-11-timeline-view.md`

**Significant interaction.** Timeline spec includes its own pagination/truncation decisions that were made without the refactor in mind. If the rendering refactor lands first, timeline must be updated to follow the new model (paginated turn table, 200-char preview default, `truncate` override). If timeline lands first, its pagination model will be inconsistent with recall/replay until the refactor catches up.

**Recommended sequencing**:
1. Workdir-isolation (independent)
2. Compact-anchor (independent)
3. **Rendering overflow refactor** (this document, once decisions locked)
4. Timeline view (updated to use new pagination/truncation)

If timeline is urgent and the rendering refactor needs more design time, an alternative is to ship timeline with its own internal pagination that gets refactored out later. Not ideal (double work) but possible.

---

## What this refactor is NOT (non-goals)

Explicitly out of scope to prevent scope creep:

- **FTS relevance tuning**. Rendering layer only.
- **Output format changes beyond overflow**. No new emoji, no rearranged columns, no changed IDs.
- **Performance optimization** (e.g. lazy loading, streaming). All existing queries remain eager.
- **Schema changes**. No new DB columns, no migrations.
- **Mnemosyne behavior changes**. The extraction agent is not affected.
- **Replacing the Zod schema with a different validation library**. Stay with Zod.
- **Changing what `depth` means besides field truncation**. Depth still controls which fields are included (collapsed strips body fields, expanded includes them, full adds children). Depth just no longer controls the per-field character limit.

---

## Next actions (not execution, just what needs to happen)

1. **Decisions**: user answers Q1-Q10. Each answer either confirms a recommendation or picks an alternative.
2. **Verification**: before writing the spec, a future session runs `git blame src/mcp/format.ts:949-951` to resolve Finding 6 (stub vs intentional) and inspects `src/hooks/session-start.ts` to verify Q9 assumptions.
3. **Spec drafting**: once decisions are locked, turn this document into a task-level implementation spec at `docs/plans/2026-04-XX-rendering-overflow-refactor.md`. The spec should have the standard writing-plans structure (tasks, tests, implementation order, self-review).
4. **Skill updates**: list every SKILL.md that needs updating alongside the refactor so none are forgotten. Expected: `mnemo-recall/SKILL.md`, `mnemo-timeline/SKILL.md` (if timeline already landed), `plugin/CLAUDE.md`.
5. **Back-compat audit**: grep for `limit:` and `depth:` call sites inside the codebase to enumerate all internal callers that will need updating.

---

## Preservation note for future sessions

This document exists because the conversation in which it was drafted was approaching compact. The findings are frozen as of that moment. If a future Claude Code session picks this up:

- **Do not trust the findings blindly** — re-verify each against current code. Cite file:line numbers when you confirm or refute.
- **The user's proposed direction** (Proposal A + B) is authoritative design intent. Start from there, don't re-litigate unless you find a concrete problem.
- **Q1-Q10 are the decisions to make**. They are not answered yet in this doc. A follow-up conversation will answer them, at which point they can be rewritten as a "Locked decisions" section in the full spec.
- **The timeline view spec** (`2026-04-11-timeline-view.md`) was drafted before this document. It does not incorporate the rendering refactor. Revisit the timeline spec after this refactor's decisions are locked.
