# Spec: Worker Prompt Hardening

Date: 2026-04-11

Prerequisite: `docs/plans/2026-04-10-worker-realtime-obs.md`

## Context

`src/worker/query-session.ts` + `src/worker/processors.ts` are the two files that generate everything Mnemosyne actually sees at runtime. The current prompts work, but they have three concrete problems that are already in production:

1. **Context bloat from repeated instruction blocks.** `buildObsPrompt` (`processors.ts:69-77`) re-sends the full `<instruction>` block on every subsequent observation. For a 250-observation session, that's ~60 tokens × ~249 = **~15k tokens of identical boilerplate** in the query session's conversation history. `buildTurnStopPrompt` (`:92-93`) and `buildSessionSummaryPrompt` (`:194-195`) also re-declare "You are Mnemosyne, ..." identity headers that the system prompt already establishes.

2. **System prompt is too thin to anchor long-lived worker behavior.** Current system prompt (`query-session.ts:211-212`) is:

   > `"You are Mnemosyne, the memory worker for Claude Code. Use only remember(), recall(), and replay(). Non-tool output is discarded."`

   It doesn't tell the LLM:
   - This is a long-lived session with many messages (LLM treats it like a one-shot extraction agent and may revisit earlier records)
   - Each message has exactly one `<instruction>`-scoped task (no preemption, no cross-message work)
   - `recall` / `replay` are fallbacks, not exploration tools
   - `remember()` without `id` creates an M-level memory, which is the main agent's job, not Mnemosyne's

3. **Turn-stop prompt has no `type` enum.** `buildTurnStopPrompt` (`:110-114`) asks the LLM to fill `type` without telling it the allowed values. The turn-type legend (`bugfix | feature | refactor | change | discovery | decision`) is hard-coded in `src/hooks/handlers/context.ts:46` and the README, but the prompt never mentions it. In practice this means the LLM invents types like `"fix"` / `"implementation"` / `"misc"`, and `recall(query="type:bugfix")` silently misses records.

Spec `2026-04-10-worker-realtime-obs.md:1043-1063` already specified the intended design for point (1):

> **后续 obs 消息只带工具调用内容，不重复 instruction**。规则已经在初始化消息里声明过了，Mnemosyne 会记住。[...] 这样 250 次 obs 只需要在第一条消息声明一次规则，后续每条只有 ~100 tokens 工具调用数据，节省 ~25k tokens 上下文预算。

But `processors.ts` was implemented with the instruction block repeated on every obs, contradicting this design. This spec finalizes the design: consolidate all recurring rules into the **system prompt**, strip `buildObsPrompt` to just the `<obs>` block, and tighten the other builders to eliminate duplication.

## Token Budget (why this matters)

Per typical 250-obs, 50-turn session, current vs. post-spec:

| Prompt | Current (tokens) | New (tokens) | Delta |
|---|---|---|---|
| System prompt × 1 | ~30 | ~820 | **+790** |
| `buildInitialObsPrompt` × 1 | ~200 | ~130 | -70 |
| `buildObsPrompt` × 249 | ~160 each = ~39,840 | ~100 each = ~24,900 | **-14,940** |
| `buildTurnStopPrompt` × 50 | ~450 each = ~22,500 | ~350 each = ~17,500 | **-5,000** |
| `buildSessionSummaryPrompt` × ~1 | ~160 | ~200 | +40 |
| **Net savings** | | | **~19,180 tokens** |

The system prompt grows ~27× (one-time payment), but eliminates ~60 tokens × 249 = ~15k tokens on subsequent obs and ~100 tokens × 50 = 5k tokens on turn-stops. Net ≈ **19k tokens saved per session**.

For context: 19k tokens is ~10% of the 200k window. It is the single largest non-data savings available in the prompt layer.

## Changes

### 1. `src/worker/query-session.ts` — Replace system prompt

**Location**: lines 210-212 inside the `query()` call's `options` object.

**Current**:

```typescript
systemPrompt:
  input.systemPrompt ??
  "You are Mnemosyne, the memory worker for Claude Code. Use only remember(), recall(), and replay(). Non-tool output is discarded.",
```

**New**:

```typescript
systemPrompt:
  input.systemPrompt ??
  `You are Mnemosyne, a long-lived memory worker for Claude Code. You extract structured memory by updating SQLite records for observations (O), turns (T), and sessions (S).

## Lifetime

One query session processes many user messages. Each user message is one unit of work. The blocks in the message tell you which record(s) to update: an \`<obs>\` means update that single observation; a \`<turn>\` (with inline \`<session>\` context) means extract the turn and optionally refresh the session on material change; a standalone \`<session>\` means refresh the session summary if warranted. Respond with the minimum number of \`remember()\` calls needed — usually one, sometimes zero (no material change → no call) or two (a turn that also refreshes its session). Never revisit records from earlier messages, never preempt future messages. The conversation history exists for LLM continuity, not for re-extraction.

## Tools

- \`remember()\` — your only output. Every record update is one remember() call.
- \`replay()\` / \`recall()\` — read-only fallbacks, usable **only from turn messages**. Not usable from observation or session-summary messages (see per-section rules below). For a turn message whose inline \`<turn>\` block is visibly truncated (\`[...N chars truncated...]\`) AND whose missing content is essential to the title/content/insight, call \`replay({ id: "<session id>/<turn id>", depth: "full" })\` before the remember() call — read the session id from the \`<session id="S...">\` block and the turn id from the \`<turn id="T...">\` block of the current message; they are two different numbers. Concrete example: \`replay({ id: "S12/T3", depth: "full" })\`. \`recall()\` is rarely needed — the inline data and conversation history almost always suffice.

Non-tool output (prose, thinking, acknowledgements) is discarded. Respond only via tool calls.

## Observation messages (<obs id="O<n>">)

For each \`<obs>\` block, make exactly one call:

- \`remember({ id: "O<n>", title, content })\`
  - title: 3-12 words, verb-led (e.g. "Read auth middleware", "Grep for token usage")
  - content: one paragraph, what the tool did and why it matters for this session. Do not restate tool arguments — they are already in the obs block.

- \`remember({ id: "O<n>", status: "skipped" })\` for routine operations: repeated Reads of the same file, navigation (ls/pwd/glob), failed-and-retried Bash, environment probes.

Never update T/S records, create memories, or call \`recall()\` / \`replay()\` from an obs message. Observation extraction is the high-volume path — tool-level summaries do not need transcript fidelity. The inline \`<obs>\` block is authoritative even when its \`in:\` / \`out:\` fields are truncated; write the summary from what is visible and note visibly-relevant truncation in the content (e.g. "truncated 1200-char grep output, 12 matches").

## Turn messages (<turn id="T<n>">)

For each \`<turn>\` block:

1. Always: \`remember({ id: "T<n>", title, content, insight, type, tags })\`
   - title: 5-15 words summarizing the turn's outcome
   - content: 100-300 chars, what happened and why
   - insight: optional, 1-3 bullet lines (≤50 chars each, prefixed "- ") for key lessons
   - type: MUST be exactly one of \`bugfix | feature | refactor | change | discovery | decision\`
   - tags: 0-5 lowercase-hyphenated keywords
   - If the turn has no tool calls, no file changes, and no user decisions: \`remember({ id: "T<n>", status: "skipped" })\` instead.

2. Optionally: \`remember({ id: "S<n>", title, content, insight, next_steps })\` — ONLY if this turn materially changed the session's direction, goals, or key findings (new goal, completed milestone, reversed decision, new constraint). Small incremental progress does NOT qualify.

Never update other turns (T<n-1>, T<n+1>, ...). Never update observations (worker has already processed them). Never create memories.

Turn messages are the ONLY context where \`replay()\` is permitted, and only under the truncation-critical condition described in the Tools section. Skip it entirely if the inline \`<turn>\` block already contains what you need.

## Session summary messages (<session> without <turn>)

When you receive a \`<session>\` block without an accompanying \`<turn>\`, it is a session summary refresh. Follow the length budget in the inline \`<instruction>\` block. Never call \`recall()\` or \`replay()\` from a session-summary message — the inline \`prior_*\` fields are the only state you should base the refresh decision on.

## Forbidden across all messages

- Never call \`remember()\` without an \`id\` field — that creates an M-level memory, which is the main agent's responsibility, not yours. Proactive memory creation from Mnemosyne is a bug.
- Never update any record not named in the current message's block headers.`,
```

**Rationale**: anchors long-lived behavior, declares scope-per-message rule, moves all recurring obs/turn rules here (including `type` enum), and explicitly forbids M-level memory creation (closes the mirror of the mnemo-remember skill's "main agent only" rule).

### 2. `src/worker/processors.ts:69-77` — Strip `buildObsPrompt` to just the obs block

**Current**:

```typescript
function buildObsPrompt(observationId: number, toolName: string, toolInput: string | null, toolResult: string | null): string {
  return `${buildObsBlock(observationId, toolName, toolInput, toolResult)}

<instruction>
Update this observation with remember({ id: "O${observationId}", title, content }).
If this tool call is not worth recording, use remember({ id: "O${observationId}", status: "skipped" }).
Do not update turns, sessions, or memories in this step.
</instruction>`;
}
```

**New**:

```typescript
function buildObsPrompt(
  observationId: number,
  toolName: string,
  toolInput: string | null,
  toolResult: string | null,
): string {
  return buildObsBlock(observationId, toolName, toolInput, toolResult);
}
```

That's it. No instruction block. The LLM already knows from the system prompt how to handle `<obs>` messages. This is the single biggest token win — ~15k tokens saved per 250-obs session.

### 3. `src/worker/processors.ts:31-67` — Simplify `buildInitialObsPrompt`

**Current**: includes an `<instruction>` block duplicating what the system prompt now covers.

**New**: drop the instruction block. Keep session + optional prior_session + obs blocks.

```typescript
function buildInitialObsPrompt(
  sessionId: number,
  project: string,
  firstUserPrompt: string | null,
  priorTitle: string | null,
  priorContent: string | null,
  priorInsight: string | null,
  priorNextSteps: string | null,
  _observationId: number,
  obsBlock: string,
): string {
  const priorSessionBlock =
    priorTitle || priorContent || priorInsight || priorNextSteps
      ? `<prior_session>
  title: ${priorTitle ?? ""}
  content: ${priorContent ?? ""}
  insight: ${priorInsight ?? ""}
  next_steps: ${priorNextSteps ?? ""}
</prior_session>
`
      : "";

  return `<session id="S${sessionId}">
  project: ${project}
  user_request: ${firstUserPrompt ?? ""}
</session>
${priorSessionBlock}
${obsBlock}`;
}
```

The `_observationId` parameter is kept (renamed to underscore-prefix) for call-site stability and future-proofing, but is no longer referenced inside the body. If you prefer, remove it from the signature and update the caller at `processors.ts:260-269` to drop the argument.

### 4. `src/worker/processors.ts:79-115` — Strip `buildTurnStopPrompt`

**Current**: has a two-line identity header ("You are Mnemosyne, observing a completed turn...") and an instruction block.

**New**: drop the identity header (system prompt owns identity) and the instruction block (system prompt owns turn-extraction rules).

```typescript
function buildTurnStopPrompt(
  sessionId: number,
  project: string,
  title: string | null,
  content: string | null,
  insight: string | null,
  nextSteps: string | null,
  turnId: number,
  prompt: string | null,
  response: string | null,
  filesRead: string[],
  filesModified: string[],
): string {
  return `<turn id="T${turnId}">
  prompt: ${truncateMiddle(prompt, 1000)}
  response: ${truncateMiddle(response, 1000)}
</turn>

<session id="S${sessionId}">
  project: ${project}
  prior_title: ${title ?? ""}
  prior_content: ${content ?? ""}
  prior_insight: ${insight ?? ""}
  prior_next_steps: ${nextSteps ?? ""}
  files_read: ${filesRead.join(", ")}
  files_modified: ${filesModified.join(", ")}
</session>`;
}
```

The LLM sees `<turn>` + `<session>` blocks and, per system prompt, knows to call `remember({id:"T<n>",...})` always + `remember({id:"S<n>",...})` optionally on material change. No inline instruction needed.

### 5. `src/worker/processors.ts:186-209` — Tighten `buildSessionSummaryPrompt`

**Current**: has identity header + vague "only if material" instruction with no length budget.

**New**: drop identity header, keep the instruction block but fill it with the strict length budget and the "no tool call = no-op" explicit signal (which the system prompt doesn't cover because it's S-specific).

```typescript
function buildSessionSummaryPrompt(
  sessionId: number,
  project: string,
  title: string | null,
  content: string | null,
  insight: string | null,
  nextSteps: string | null,
): string {
  return `<session id="S${sessionId}">
  project: ${project}
  prior_title: ${title ?? ""}
  prior_content: ${content ?? ""}
  prior_insight: ${insight ?? ""}
  prior_next_steps: ${nextSteps ?? ""}
</session>

<instruction>
Refresh the session summary ONLY if material change since prior_*: a new goal, a completed milestone, a reversed decision, or a newly discovered constraint. Small incremental work does NOT qualify.

If updating, call:
remember({ id: "S${sessionId}", title, content, insight, next_steps })

Length budget (strict):
- title: 20-50 chars, one line
- content: 100-300 chars, what the session is about
- insight: 2-5 bullet lines, each ≤50 chars, prefixed "- "
- next_steps: 50-150 chars, what's pending
- Total: <500 chars

Do NOT mention file paths, tool counts, or code-level details. Those belong in turn records.

If no material change, respond with no tool calls. An empty response is the "leave alone" signal.
</instruction>`;
}
```

The length budget is kept inline rather than moved to system prompt because (a) it only applies to this one message type, (b) it's called at most 1-2 times per session (PreCompact + optional hard-threshold), so per-call overhead is negligible, and (c) it keeps the system prompt focused on recurring-message rules.

The final sentence — "empty response is the leave-alone signal" — is critical. Without it the LLM will always prefer to emit a remember() call rather than abstain, leading to thrash on every compact cycle.

## Tests

### Unit tests (`tests/worker/processors.test.ts`)

If this file exists and has assertions on the exact string output of `buildObsPrompt` / `buildInitialObsPrompt` / `buildTurnStopPrompt` / `buildSessionSummaryPrompt`, they will all break. Update each `expect(...).toBe(...)` / `toContain(...)` to match the new prompt shapes.

Key assertions to **add** or **update**:

- `buildObsPrompt` output **does NOT contain** `"<instruction>"` — strict check that the instruction block is gone.
- `buildObsPrompt` output **equals** the raw `<obs>` block — no prefix, no suffix.
- `buildInitialObsPrompt` output **contains** `<session id=`, `<obs id=` — but **does NOT contain** `"<instruction>"`.
- `buildTurnStopPrompt` output **contains** `<turn id=`, `<session id=` — but **does NOT contain** `"You are Mnemosyne"` or `"<instruction>"`.
- `buildSessionSummaryPrompt` output **contains** `"Length budget"`, `"material change"`, `"no tool calls"` — but **does NOT contain** `"You are Mnemosyne"`.

### System prompt test (`tests/worker/query-session.test.ts`)

If there's a test asserting the default system prompt string, update it. Consider adding a test that verifies the custom `systemPrompt` override path still works (inject a tiny custom prompt and check it ends up in the query options).

### No behavior tests

LLM output cannot be unit-tested. Do not try. The verification section below covers human eyeball review.

## Verification

Prompt changes can't be validated by CI. After merging, watch the next 1-2 real sessions for:

1. **`type` enum compliance**: after a session ends, run
   ```sql
   SELECT DISTINCT type FROM turns WHERE created_at_epoch > <deploy_time>;
   ```
   Every value MUST be one of `bugfix | feature | refactor | change | discovery | decision`. Any other value = prompt didn't stick.

2. **No Mnemosyne-created memories**: after a session ends, run
   ```sql
   SELECT id, title, created_at_epoch FROM memories WHERE created_at_epoch > <deploy_time>;
   ```
   This count should match the number of memories the **main agent** was asked to create. Any unexplained new memories = Mnemosyne ignored the "never create memories" rule.

3. **Session summary length compliance**: run
   ```sql
   SELECT LENGTH(title), LENGTH(content), LENGTH(insight), LENGTH(next_steps) FROM sessions WHERE updated_at_epoch > <deploy_time>;
   ```
   Verify budgets: title 20-50, content 100-300, insight ≤5 lines of ≤50 chars each, next_steps 50-150, total <500.

4. **No session thrash**: compare `updated_at_epoch` of a session across multiple compacts. If `updated_at_epoch` advances on every compact even when no real progress happened, the "no tool calls = leave alone" signal isn't being honored — revisit the prompt wording.

5. **No cross-turn updates**: query
   ```sql
   SELECT id, title, updated_at_epoch FROM turns WHERE status = 'extracted' ORDER BY id;
   ```
   Each turn's `updated_at_epoch` should be a single moment (from its extraction). If earlier turns keep getting re-updated, Mnemosyne is revisiting records — the "process only the current message" rule isn't landing.

6. **Token usage per session**: if the worker logs `cumulativeTokens` (spec §466), compare pre-deploy vs post-deploy averages. Expect ~15-20k token reduction per comparable session.

## Out of Scope

- **`notifyWorkerWake` IIFE bug** (previously at `src/worker/client.ts:94-110`). Already fixed in runtime by commit `a5c369a` (inlined the try/catch, removed the fire-and-forget IIFE so `process.exit()` can no longer kill the pending fetch/spawn). Unrelated to this prompt spec — mentioned only so readers searching for "worker wake" land on the right commit.
- **Query session reset logic** (PreCompact + hard threshold). The reset mechanic is correct; this spec only changes what each prompt *contains*, not when prompts are sent or how sessions are rotated.
- **MCP tool gating** (dynamic `setMcpServers` to disable `recall`/`replay` for obs). Spec `2026-04-10-worker-realtime-obs.md:1099` explicitly defers this — we use soft prompt-level constraints instead. This spec inherits that decision and does not introduce dynamic gating.
- **`src/hooks/handlers/context.ts` SessionStart injection legend**. The 6 type emojis there match the new prompt's `type` enum, so no change needed. But if the enum is ever expanded, both files must be updated together — add a cross-reference comment in `context.ts:46` and `processors.ts` if helpful.
- **mnemo-recall / mnemo-remember skills**. Already updated in prior commits. The boundary is already documented there ("main agent only creates memories; worker updates T/S/O"). This spec closes the mirror from the worker side.

## Risks

- **Prompt regressions are invisible until real data comes through.** Unlike code bugs, a prompt change that makes the LLM slightly dumber won't trip any test. Rely on the verification SQL queries above; budget time to run them on the first few post-deploy sessions.
- **System prompt size.** ~820 tokens is a meaningful one-time cost. On very short sessions (<14 obs), the break-even may not be reached. This is acceptable because the Mnemosyne worker is designed for long-running sessions; the break-even point is around 14 obs messages (one-time cost ~790 ÷ per-obs saving ~60 ≈ 13.2), and any real session crosses that easily.
- **LLM may under-update sessions.** The new session summary prompt is stricter about "material change" and has an explicit no-op signal. This is intentional — current behavior over-updates. But if post-deploy we see sessions where `content` goes stale over multiple compacts, we may need to soften the threshold (not reverse it).
- **Identity header removal may weaken identity anchoring on long sessions.** The current identity headers in turn-stop and session-summary prompts were redundant, but they did serve as a mid-session reminder. If post-deploy we see identity drift (LLM forgetting it's Mnemosyne), we can add a single brief identity line to `buildTurnStopPrompt` — but do not revert the full removal.
- **`<instruction>`-less messages may confuse the LLM initially.** Most prompt corpora teach LLMs that a user message should contain an explicit ask. With the rules moved to the system prompt, some messages are pure data blocks. If the LLM ever says "I see this obs but I'm not sure what to do with it", the system prompt didn't land — revisit its opening paragraph.

## Implementation Order

One commit, no phased rollout:

1. Replace `src/worker/query-session.ts:211-212` with the new multi-line system prompt (change #1).
2. Update `src/worker/processors.ts` in this order (bottom-up is fine):
   - `buildObsPrompt` (change #2)
   - `buildInitialObsPrompt` (change #3)
   - `buildTurnStopPrompt` (change #4)
   - `buildSessionSummaryPrompt` (change #5)
3. Update `tests/worker/processors.test.ts` (if it exists) with the new assertions.
4. Update `tests/worker/query-session.test.ts` (if it exists) with the new system prompt assertion.
5. Run `bun test` — all green.
6. Run `npm run typecheck` — all green.
7. Run `npm run build` — refresh `plugin/scripts/worker.cjs` + `plugin/scripts/hook-command.cjs` + `plugin/scripts/mcp-server.cjs`.
8. Ship.

Then begin the verification SQL monitoring on the next 1-2 real sessions.
