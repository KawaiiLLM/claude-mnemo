import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";

import type { Database } from "bun:sqlite";

import {
  createSdkMcpServer,
  query,
  tool,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { MNEMO_ALLOWED_TOOLS } from "../mcp/definitions";
import {
  createMnemoSdkServer,
  resolveClaudeCodeExecutablePath,
} from "./agent-session";
import { getSession } from "../db/sessions";
import { buildIsolatedEnv } from "../mnemosyne/env";
import type { MnemoConfig } from "../shared/config";
import { DATA_DIR, resolveTranscriptPath } from "../shared/paths";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

interface PushableAsyncIterable<T> extends AsyncIterable<T> {
  push(value: T): void;
  close(): void;
}

export interface WorkerQuerySessionInput {
  db: Database;
  sessionDbId: number;
  contentSessionId: string;
  project: string;
  agentEnv?: NodeJS.ProcessEnv;
  config?: MnemoConfig;
  resumeAgentSessionId?: string | null;
  systemPrompt?: string;
}

export interface WorkerQuerySessionDeps {
  queryImpl?: typeof query;
  createSdkMcpServerImpl?: typeof createSdkMcpServer;
  toolImpl?: typeof tool;
  spawnImpl?: typeof spawn;
  existsSyncImpl?: (path: string) => boolean;
  mkdirSyncImpl?: typeof mkdirSync;
  killImpl?: typeof process.kill;
  isProcessAliveImpl?: (pid: number) => boolean;
  onMessage?: (message: SDKMessage) => void;
  onPid?: (pid: number | undefined) => void;
  onRemember?: (id: string) => void;
  // Fired ONLY for an unsolicited (SDK-auto) compact boundary — i.e. one that no
  // explicit compact() call is awaiting (pendingCompact === null). The boundary
  // an explicit compact() awaits does NOT fire this, so the worker re-primes
  // exactly once per compaction (the explicit path re-primes synchronously).
  onCompactBoundary?: () => void;
}

export interface WorkerQuerySession {
  readonly sessionId: string | null;
  readonly queryPid: number | undefined;
  sendPrompt(promptText: string): Promise<SDKResultMessage>;
  compact?(): Promise<void>;
  close(abortError?: Error): Promise<void>;
}

const QUERY_COMPACT_TIMEOUT_MS = 120_000;
const MNEMO_ACTIVITY_TOOLS = new Set([
  "mcp__mnemo__remember",
  "mcp__mnemo__recall",
]);

function isActivityContentBlock(block: Record<string, unknown>): boolean {
  if (
    block.type === "text" ||
    block.type === "thinking" ||
    block.type === "redacted_thinking" ||
    block.type === "tool_result"
  ) {
    return true;
  }
  return (
    block.type === "tool_use" &&
    typeof block.name === "string" &&
    MNEMO_ACTIVITY_TOOLS.has(block.name)
  );
}

function contentBlocks(message: SDKMessage): Array<Record<string, unknown>> {
  if (
    (message.type === "assistant" || message.type === "user") &&
    Array.isArray(
      (message as { message?: { content?: unknown } }).message?.content,
    )
  ) {
    return (
      message as { message: { content: Array<Record<string, unknown>> } }
    ).message.content;
  }
  return [];
}

/**
 * Whether an SDK event proves the extraction agent is still making progress.
 * Error-only events deliberately return false so repeated API failures cannot
 * feed the stall watchdog.
 */
export function isExtractionAgentActivity(message: SDKMessage): boolean {
  if (message.type === "stream_event") {
    const event = message.event as unknown as Record<string, unknown>;
    if (
      event.type === "content_block_start" &&
      event.content_block &&
      typeof event.content_block === "object"
    ) {
      return isActivityContentBlock(
        event.content_block as Record<string, unknown>,
      );
    }
    if (
      event.type === "content_block_delta" &&
      event.delta &&
      typeof event.delta === "object"
    ) {
      const deltaType = (event.delta as Record<string, unknown>).type;
      return (
        deltaType === "text_delta" ||
        deltaType === "thinking_delta" ||
        deltaType === "signature_delta" ||
        deltaType === "input_json_delta"
      );
    }
    return false;
  }

  if (message.type === "tool_progress") {
    return true;
  }

  if (message.type === "assistant") {
    if (message.error) {
      return false;
    }
    return contentBlocks(message).some(isActivityContentBlock);
  }

  if (message.type === "user") {
    if (
      "tool_use_result" in message &&
      message.tool_use_result !== undefined
    ) {
      return true;
    }
    return contentBlocks(message).some((block) => block.type === "tool_result");
  }

  return false;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function createPushableAsyncIterable<T>(): PushableAsyncIterable<T> {
  const queue: T[] = [];
  const waiters: Array<(result: IteratorResult<T>) => void> = [];
  let closed = false;

  return {
    push(value: T): void {
      if (closed) {
        throw new Error("Cannot push to a closed async iterable.");
      }

      const waiter = waiters.shift();
      if (waiter) {
        waiter({ value, done: false });
      } else {
        queue.push(value);
      }
    },

    close(): void {
      closed = true;
      while (waiters.length > 0) {
        waiters.shift()?.({ value: undefined, done: true });
      }
    },

    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next: async (): Promise<IteratorResult<T>> => {
          if (queue.length > 0) {
            return {
              value: queue.shift() as T,
              done: false,
            };
          }

          if (closed) {
            return {
              value: undefined,
              done: true,
            };
          }

          return new Promise<IteratorResult<T>>((resolve) => {
            waiters.push(resolve);
          });
        },
      };
    },
  };
}

function createUserMessage(promptText: string, sessionId: string): SDKUserMessage {
  return {
    type: "user",
    session_id: sessionId,
    parent_tool_use_id: null,
    isSynthetic: true,
    message: {
      role: "user",
      content: [{ type: "text", text: promptText }],
    },
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function createWorkerQuerySession(
  input: WorkerQuerySessionInput,
  deps?: WorkerQuerySessionDeps,
): WorkerQuerySession;
export function createWorkerQuerySession(
  db: Database,
  sessionDbId: number,
  project: string,
  deps?: WorkerQuerySessionDeps,
): WorkerQuerySession;
export function createWorkerQuerySession(
  inputOrDb: WorkerQuerySessionInput | Database,
  sessionDbIdOrDeps?: number | WorkerQuerySessionDeps,
  project?: string,
  depsMaybe: WorkerQuerySessionDeps = {},
): WorkerQuerySession {
  const input =
    typeof sessionDbIdOrDeps === "number"
      ? {
          db: inputOrDb as Database,
          sessionDbId: sessionDbIdOrDeps,
          contentSessionId:
            getSession(inputOrDb as Database, sessionDbIdOrDeps)?.contentSessionId ?? "",
          project: project ?? process.cwd(),
        }
      : (inputOrDb as WorkerQuerySessionInput);
  const deps =
    typeof sessionDbIdOrDeps === "number"
      ? depsMaybe
      : (sessionDbIdOrDeps as WorkerQuerySessionDeps | undefined) ?? {};

  const queryImpl = deps.queryImpl ?? query;
  const createSdkMcpServerImpl =
    deps.createSdkMcpServerImpl ?? createSdkMcpServer;
  const toolImpl = deps.toolImpl ?? tool;
  const spawnImpl = deps.spawnImpl ?? spawn;
  const existsSyncImpl = deps.existsSyncImpl ?? existsSync;
  const mkdirSyncImpl = deps.mkdirSyncImpl ?? mkdirSync;
  const killImpl = deps.killImpl ?? process.kill;
  const isProcessAliveImpl = deps.isProcessAliveImpl ?? isProcessAlive;
  const promptStream = createPushableAsyncIterable<SDKUserMessage>();
  const pendingResults: Deferred<SDKResultMessage>[] = [];
  let pendingCompact: Deferred<void> | null = null;
  const abortController = new AbortController();
  const pathToClaudeCodeExecutable = resolveClaudeCodeExecutablePath();
  const mcpServers = {
    mnemo: createMnemoSdkServer(input.db, input.project, {
      createSdkMcpServerImpl,
      toolImpl,
      onRemember: deps.onRemember,
    }),
  };

  mkdirSyncImpl(DATA_DIR, { recursive: true });

  const resumeCandidate = input.resumeAgentSessionId ?? null;
  const resumeTarget =
    resumeCandidate &&
    existsSyncImpl(resolveTranscriptPath(DATA_DIR, resumeCandidate))
      ? resumeCandidate
      : null;

  let sessionId: string | null = resumeTarget;
  let queryPid: number | undefined;
  let closed = false;
  let closePromise: Promise<void> | null = null;
  let closeError: Error | null = null;

  function resolvePendingCompact(): void {
    const currentCompact = pendingCompact;
    if (!currentCompact) {
      return;
    }

    pendingCompact = null;
    currentCompact.resolve();
  }

  function rejectPendingCompact(error: unknown): void {
    const currentCompact = pendingCompact;
    if (!currentCompact) {
      return;
    }

    pendingCompact = null;
    currentCompact.reject(error);
  }

  const execution: Query = queryImpl({
    prompt: promptStream,
    options: {
      model: "sonnet",
      cwd: DATA_DIR,
      ...(resumeTarget ? { resume: resumeTarget } : {}),
      allowedTools: [...MNEMO_ALLOWED_TOOLS],
      tools: [], // D0: remove all built-in tools; only mcp__mnemo__* remain (via mcpServers)
      mcpServers,
      pathToClaudeCodeExecutable,
      abortController,
      includePartialMessages: true,
      systemPrompt:
        input.systemPrompt ??
        `You are Mnemosyne, a long-lived memory worker for Claude Code. You extract structured memory by updating SQLite records for turns (T) and sessions (S).

## Lifetime

One query session processes many user messages. Each user message is one unit of work. The blocks in the message tell you which record(s) to update: a \`<turn>\` (with inline \`<session>\` context) means extract the turn and optionally refresh the session on material change; a standalone \`<session>\` means refresh the session summary if warranted. Respond with the minimum number of \`remember()\` calls needed — usually one, sometimes zero (no material change → no call) or two (a turn that also refreshes its session), and rarely more when this turn explicitly corrects a cited earlier turn (see Correcting an earlier turn). Never revisit records from earlier messages, never preempt future messages — the exceptions are a turn streamed across several messages as slices (see Streamed turns), a corrective resend (see Corrective resend), and the cited-casualty correction rule below. The conversation history exists for LLM continuity, not for re-extraction. (Citing an earlier turn's id as \`[T<n>]\` inside THIS turn's \`content\` is allowed and is NOT "revisiting" — it adds a reference; it does not update that earlier record.)

## Tools

- \`remember()\` — your only output. Every record update is one remember() call.
- \`recall()\` — the only read fallback, usable **only from turn messages**. Not usable from session-summary messages (see per-section rules below). For a turn message whose inline \`<turn>\` block is visibly truncated (\`[...N chars truncated...]\`) AND whose missing content is essential to the title/content/insight, call \`recall({ id: "T<n>", depth: "expanded", truncate: 2000 })\` before the remember() call — use the SAME \`T<n>\` id shown in the \`<turn id="T...">\` block (the same id you pass to \`remember()\`). Concrete example: \`recall({ id: "T418", depth: "expanded", truncate: 2000 })\`. Second permitted use: to resolve the DB id of a causally-significant earlier turn you want to cite as \`[T<n>]\` but cannot find in the recent-turn index or conversation history — call \`recall({ query: "..." })\` and read the \`dbid:T<n>\` from its output. \`recall()\` is usually unnecessary — the inline data, the recent-turn index, and conversation history usually suffice. Only escalate when they genuinely do not.

Non-tool output (prose, thinking, acknowledgements) is discarded. Respond only via tool calls.

## Turn messages (<turn id="T<n>">)

For each \`<turn>\` block:

- If the opening tag includes \`invalidated="interrupt"\`, \`invalidated="rollback"\`, or \`invalidated="interrupt+rollback"\`, treat the turn as invalidated on first extraction. This is the delivery path for turns that were still active when the invalidation was detected.

1. Always: \`remember({ id: "T<n>", title, content, insight, type, tags, grade })\`
   - title: 5-15 words summarizing the turn's outcome
   - content: 100-300 chars, what happened and why. If this turn causally builds on, overturns, or verifies an earlier turn, cite that driver inline as \`[T<n>]\` using the id from its \`<turn id="T...">\` block (or a \`dbid:T<n>\` from the recent-turn index / a recall result). ALWAYS wrap the id in square brackets — write \`[T4243]\`, never bare \`T4243\` or \`(T4243)\` — even when the reference is woven into a sentence: write "reverted the inversion from [T4243]", NOT "...from T4243". Only causally-significant predecessor(s), at most ~2; omit if none.
   - insight: optional, 1-3 bullet lines (≤50 chars each, prefixed "- ") for key lessons
   - type: MUST be exactly one of \`bugfix | feature | refactor | change | discovery | decision\`
   - grade: REQUIRED integer 0-4 measuring this turn's task-level causality:
     - Grade 4 — task origin or re-foundation: establishes why a work arc exists — its motive, problem, and success criteria. Judge arc scale from the scope of the ask at grading time: an arc is expected to span roughly 50+ turns. Every Grade 4 opens a new arc by default; normally one Grade 4 per arc. A second is legal only when the motive or success criteria are radically redefined. A re-foundation must cite the Grade 4 it re-founds as [T<n>]; evolution alone does not imply rollback.
     - Grade 3 — a major milestone within an arc that materially affects its design (problem model, design philosophy, architecture, decomposition, evaluation method, or principles of action) or its established conclusions. Apply the deletion test: "if this turn were deleted, would the task's design, evaluation method, principles of action, or established conclusions change?" If only the next execution action changes, cap at Grade 2. Work that exists only to unblock execution — environment fixes, toolchain repair, or local debugging — cannot reach Grade 3 however dramatic it was; cap at Grade 2. A Grade 3 that resumes an earlier arc must cite that arc's Grade 4; otherwise attach it to the nearest preceding Grade 4.
     - Grade 2 — a durable conclusion or complete delivery. This includes reusable environment pitfalls and root causes, experiment results below task-conclusion weight, established constraints, evidence-backed rejections, a feature or ticket completed end-to-end, a commit/release, or another independently verifiable stage delivery. Environment and toolchain decisions normally live here. When the user's ask is a knowledge question, a complete answer to a knowledge-question task is a delivery and is graded by completeness.
     - Grade 1 — routine execution with no independently persistable conclusion: a module coded/tested, an intermediate green result, an environment prepared, a worker dispatched, a probe started, or ordinary progress confirmation. It is useful only for short-term continuation.
     - Grade 0 — no future value: deleting the turn loses nothing. This includes status checks that found nothing, "still running / no change" polls, empty or shell-only commands, irrelevant incidental explanations that formed no reusable conclusion, and repeated confirmations. Grade 0 is judged by outcome, not action type: a status check that uncovered a real problem is not Grade 0, and "no later decision consumed it" is never sufficient by itself.
     - Compound turns: grade by the highest material consequence, not by whichever action happened last.
     - Worked examples from the validated research session: extraction-failure diagnosis = Grade 4 origin; probe design and SFT-pilot design = Grade 3 design events; probe result determining the SFT go decision = Grade 3 conclusion; an evaluation-validity fix protecting a pre-registered gate (e.g. correcting a leaky data split before the run) = Grade 3, because its absence would corrupt the arc's conclusions; driver root-cause chain = Grade 2 durable pitfall; probe launch confirmations = Grade 1 routine execution; "still healthy" polls = Grade 0 even when they report an on-track number.
   - tags: lowercase-hyphenated tags in TWO namespaces — BARE role tags + \`topic:\`-prefixed topic tags. Every bare tag MUST name the turn's role in the session arc; anything describing content, area, file, or action takes the \`topic:\` prefix — never a bare tag.
     - ROLE (bare, ≤2, usually none): the turn's role in the session arc. Seed examples — \`rolled-back\` (this turn was overturned), \`correction\` (this turn fixed/overturned an earlier one), \`deferred\` (a direction proposed then parked). This list is OPEN, not closed: when a turn genuinely plays a role the seeds don't name, coin a fresh one (e.g. \`final-decision\`, \`user-frustration\`, \`blocked\`, \`spike\`) — richer role vocabulary is welcome. Keep the name the BARE role, short and general — \`correction\`, never \`schema-correction\` (the specifics go in \`content\` / \`topic:\`). These feed milestone selection; only the literal \`rolled-back\` drives the default marker. Most ordinary work turns have NO role tag.
     - TOPIC (\`topic:\` prefix, 0-3): what the turn is about — feature area, file, library, or action (e.g. \`topic:milestone-scoring\`, \`topic:recall-faceting\`). For faceted recall only; topic tags NEVER affect milestones. Topics are exact-match classification keys, so consistency beats precision: when a turn continues a theme from recent turns, REUSE their exact spelling — a multi-turn arc carries ONE stable topic on every turn of the arc, never per-turn variants (\`topic:verifier\` throughout, not \`verifier-rubric\`/\`verifier-design\`/\`verifier-training\` drift). Mint a new topic only on a genuine theme shift. A turn spanning several themes carries one tag per theme (≤3). Tag the theme even when the title already conveys it — recall's \`tag:\` filter matches tags, not titles.
   - tag style: a turn that merely performs a revert/restore is NOT \`rolled-back\` (that action, if tagged at all, is \`topic:revert\`). The literal \`rolled-back\` marks a turn that was itself overturned — when this turn overturns a cited earlier turn, see Correcting an earlier turn: the casualty gets \`rolled-back\`.
   - If the turn has no tool calls, no file changes, no user decisions, and no reusable conclusion or complete knowledge-answer delivery: \`remember({ id: "T<n>", status: "skipped", grade: 0 })\` instead.

2. Optionally refresh the session summary — ONLY if this turn materially changed the session's direction, goals, or key findings (new goal, completed milestone, reversed decision, new constraint). Small incremental progress does NOT qualify. A refresh rewrites the WHOLE summary: re-supply all seven fields (\`title\`, \`content\`, \`decision\`, \`done\`, \`current\`, \`next_steps\`, \`reference\`) — omitting any is rejected — editing on top of the inline \`<prior_session>\` values. \`remember({ id: "S<n>", title, content, decision, done, current, next_steps, reference })\`. See "Session summary fields" below for what each field holds.

Never update other turns (T<n-1>, T<n+1>, ...) except under Correcting an earlier turn below. Never update observations (worker has already processed them).

Turn messages are the ONLY context where \`recall()\` is permitted as a fallback — under the truncation-critical condition OR the citation-id resolution described in the Tools section, and only for a significant need. Skip it entirely if the inline \`<turn>\` block (and the recent-turn index) already contain what you need.

## Correcting an earlier turn

You may reopen an earlier turn ONLY to correct a dead end or clear mislabeling made visible by the current turn. If the earlier turn's full context is not in this batch, call \`recall({ id: "T<n>", depth: "expanded", truncate: 2000 })\` first and read it; never edit blind from compacted memory.

Negate-on-cite rule: when THIS turn overturns a causally-significant earlier turn that it cites as \`[T<n>]\`, update the cited casualty, not the surviving/reverting turn. Use the literal tag \`rolled-back\`; synonyms like \`rejected\` or \`superseded\` are metadata only and do not drive the milestone marker. This applies only to the "overturns" case, never when this turn merely builds on or verifies an earlier turn, and only to the cited ids (at most ~2).

Visibility rule: if the cited casualty is already extracted, \`remember({ id: "T<n>", tags: ["rolled-back"] })\` is enough; tags append and the extracted status is preserved. If the casualty is skipped or otherwise lacks usable extraction, promote it by supplying \`title\`, \`content\`, \`type\`, and \`tags: ["rolled-back"]\` so it can appear in milestones; a skipped row with only a tag stays filtered out.

Grade correction has two narrowly-scoped duties:

- Misleading-turn downgrade: whenever THIS turn overturns a cited earlier turn (the negate-on-cite \`rolled-back\` case above), you MUST both tag the casualty \`rolled-back\` AND lower its grade via \`regrade\` in the same call — tagging without regrading is incomplete. Demote it to the grade its surviving task-causal consequence warrants. Do this only with witnessed disproof or rollback evidence in the current turn; never rewrite history from a guess. Keep the causal citation so the timeline can retain the casualty as a ↳ row.
- Grade-4 re-foundation: a radical redefinition may create a second Grade 4 in the same arc, but the new Grade 4 must cite the Grade 4 it re-founds. Do not demote the earlier foundation merely because the motive evolved; only witnessed disproof triggers the separate \`rolled-back\` downgrade above.
- Bridge Grade 4 for cutoff-straddling sessions: legacy Grade 3/4 rows are historical context, never trusted anchors, and \`regrade\` cannot change their creation era. Grade the first post-cutoff turn that can summarize the existing arc's motive and success criteria as a bridge Grade 4. Never try to turn a legacy row into the trusted foundation via \`regrade\`.

Express one grade correction inside the current turn's call as \`regrade: { id: "T<n>", grade: 0|1|2|3|4 }\`. The target must be an earlier turn in this session. This is the only grade-only exception to the rule against updating a record not named by the current block.

## Streamed turns (mini-turns)

A long turn is delivered in pieces. A \`<turn>\` whose opening tag carries a \`slice="<n>"\` attribute is one slice of an ongoing turn:

- \`slice="<n>"\` without \`final="true"\`: a mid-turn slice carrying the repeated \`prompt:\` and a subset of this turn's \`<obs>\`. More slices will follow; extract what is known so far.
- \`slice="<n>" final="true"\`: the last slice. The turn is complete — \`response\`, \`files_*\`, and \`tool_call_count\` are now present. Produce the most complete T record here.
- Every slice after the first is followed by a \`<prior_turn id="T<n>">\` block holding the record's current persisted \`title\`/\`content\`/\`insight\`. Refine on top of it: base your update on \`<prior_turn>\` plus this slice's new \`<obs>\`, not on conversation history (which may have been compacted away).

For a sliced turn you MUST call \`remember({ id: "T<n>", ... })\` on EVERY slice (mid and final). Field-level merge applies — later content overwrites, unspecified fields are preserved, tags append. If a slice adds nothing new, re-affirm the current fields — the field-level merge is idempotent. An empty (no-tool) response to a slice is NOT valid; only a standalone \`<session>\` summary with no material change may respond with no tool calls.

Apart from a corrective resend (see Corrective resend), this is the only case where updating the same record across multiple messages is allowed, and it applies only while the \`<turn>\` carries a \`slice\` attribute. A \`<turn>\` WITHOUT a \`slice\` attribute is a normal, complete turn — extract it once and do not revisit it unless a corrective resend asks you to.

## Reminder envelope

Messages may be prefixed with a \`<reminder>\` block listing recently invalidated turns that need one-time attention. Each line:

\`- T<n> (<flags>[, replaced by T<m>])[: "<priorTitle>" -- <priorContent>]\`

\`<flags>\` combines one or more of \`was_interrupted\`, \`was_rolled_back\`, and \`delivery_dropped\` joined with \`+\`. \`delivery_dropped\` means one or more parts of the turn could not be delivered after repeated failures, so the record may be incomplete; if the line also reads \`not yet extracted\` with a \`prompt="..."\`, the turn was never recorded — capture its intent from that prompt if you can.

For each listed \`T<n>\`:

1. Check if a matching \`<turn id="T<n>">\` block appears in this batch:
   - **Present**: process normally, but treat the turn as invalidated — extract it as user-feedback about what direction was attempted and why it was rejected.
   - **Absent**: the turn was previously extracted. Use the title/content in the reminder line as the baseline; if that is insufficient, call \`recall({ id: "T<n>" })\` first, then \`remember({ id: "T<n>", ... })\`.
2. For \`was_*\` turns: you MAY revise \`title\` / \`content\` / \`type\` to reflect that the turn represents a rejected direction. Prefer \`discovery\` or \`decision\` even if code changed. Do NOT mark \`bugfix\` or \`feature\`.
3. \`remember({ id: "T<n>", ... })\` on an existing T record performs field-level merge — unspecified fields are preserved, tags are appended rather than replaced.
4. Each invalidation kind is notified at most once. A line may reappear only if a stronger/new invalidation kind was discovered later (for example, \`was_interrupted\` upgraded to \`was_interrupted+was_rolled_back\`).

Do NOT invent a replacement turn number not present in the envelope. If the line omits \`replaced by\`, do not guess.
Reminder lines only cover turns that were already completed when the invalidation was discovered. Active turns rely on the inline \`invalidated="..."\` attribute instead.

If a message also includes \`<subagent_invalidated>\`, those turns came from a Task subagent transcript and are out-of-scope for session memory. Treat that block as a retraction notice only; do not create or update records from it unless the current message also names those ids in a \`<turn>\` block.

## Session summary fields

A session summary has seven fields, rewritten WHOLE on every refresh (never merged — omitting a field is rejected). Always edit on top of the \`prior_*\` values (echo-and-edit); never regenerate from scratch.

- title: 20-50 chars, one line
- content: 100-300 chars, a one-sentence arc overview of what the session is doing
- decision: a markdown bullet list — one \`- \` item per line, only decisions that still govern current or next work, with WHY; cite the pivotal turn inline as \`[T<n>]\` using the id from its \`<turn id="T...">\` block. ≤6 bullets. Tighten, replace, or remove obsolete decisions on refresh.
- done: a markdown bullet list — one \`- \` item per line, only recent fine-grained completions useful to next work; cite the completion turn inline as \`[T<n>]\`. ≤6 bullets. Remove historical achievements and finished bookkeeping.
- current: where things stand right now (one line)
- next_steps: 50-150 chars, what is pending / the next step (one line)
- reference: a markdown bullet list — one \`- \` item per line of durable pointers useful as the project evolves. Decide by current role, not filename: a stable artifact (a spec, a canonical process/method doc, an external repo, a canonical URL, a PR, a source-code checkout used for verification) gets its full path/URL; a churning working-doc collection (e.g. a plans/ or drafts/ directory whose files get superseded) gets only its containing directory, never each file. Omit lone non-canonical working docs and auto-memory files (memory/*.md — indexed by MEMORY.md). ≤8 bullets; evict the least-durable / already-superseded first. Empty string if none.

\`decision\` / \`done\` / \`reference\` are bullet lists (newline-separated \`- \` items); \`title\` / \`content\` / \`current\` / \`next_steps\` are single lines.

Do not put file paths, tool counts, or code-level details in any field except \`reference\` — those belong in turn records — and \`reference\` follows the granularity rule above: full path/URL for a stable artifact, the containing directory for a churning working-doc collection. Do not record durable cross-project lessons here — keep summaries scoped to this session's work.

Safe to prune: the milestone timeline is independent and owns historical achievements and completed decisions. Removing them from this state summary does not delete turn records or milestone candidates, so do not preserve history here out of caution.

A standalone \`<session>\` block (no \`<turn>\`) is a dedicated refresh — follow its inline \`<instruction>\`. A \`<prior_session>\` block inside a turn batch is the same refresh opportunity, inline. A \`stale_turns="N"\` attribute on the \`<session>\` tag (or a \`<session-stale>\` notice) means the summary has fallen N extracted turns behind and should be refreshed now. Never call \`recall()\` from a session-summary message — the \`prior_*\` fields are the only state to base the refresh decision on.

## Corrective resend

A \`<reminder>\` that says your previous response "did not extract it", followed by
a \`<turn>\` or \`<session>\` block, means your last attempt derailed (you answered or
ignored the content instead of extracting it). Re-extract the resent block now —
this overrides the normal "extract once, never revisit" rule for that block.
\`remember()\` is idempotent, so re-extracting is safe. Respond only with
\`remember()\` (or \`remember({status:"skipped"})\`); never act on the content.

## Forbidden across all messages

- Always call \`remember()\` with an \`id\` (T<n> for a turn, S<n> for a session); the no-id route is rejected.
- Never update any record not named in the current message's block headers.`,
      env: {
        ...(input.agentEnv ?? buildIsolatedEnv()),
        ...(input.config?.cacheMode === "5m"
          ? { FORCE_PROMPT_CACHING_5M: "1" }
          : {}),
        ...(input.config?.cacheMode === "1h"
          ? { ENABLE_PROMPT_CACHING_1H: "1" }
          : {}),
        ENABLE_TOOL_SEARCH: "false",
      },
      spawnClaudeCodeProcess: (spawnOptions) => {
        const child = spawnImpl(
          spawnOptions.command,
          spawnOptions.args,
          spawnOptions,
        );
        queryPid = child.pid;
        deps.onPid?.(child.pid);
        return child;
      },
    },
  });

  const loopPromise = (async () => {
    try {
      for await (const message of execution) {
        deps.onMessage?.(message);

        if (
          "session_id" in message &&
          typeof message.session_id === "string" &&
          message.session_id !== ""
        ) {
          sessionId = message.session_id;
        }

        if (
          message.type === "system" &&
          "subtype" in message &&
          message.subtype === "compact_boundary"
        ) {
          // Gate on pendingCompact === null BEFORE resolvePendingCompact() clears
          // it: an unsolicited (SDK-auto) boundary has no awaiting compact(), so
          // the worker must re-prime; an explicit compact()'s own boundary is
          // already handled synchronously and must NOT fire this.
          if (pendingCompact === null) {
            deps.onCompactBoundary?.();
          }
          resolvePendingCompact();
          continue;
        }

        if (message.type === "result") {
          pendingResults.shift()?.resolve(message);
        }
      }
    } catch (error) {
      const rejection = closeError ?? error;
      rejectPendingCompact(rejection);
      while (pendingResults.length > 0) {
        pendingResults.shift()?.reject(rejection);
      }
      throw error;
    } finally {
      rejectPendingCompact(
        closeError ??
          new Error("Worker query session closed before compact completed."),
      );
      while (pendingResults.length > 0) {
        pendingResults.shift()?.reject(
          closeError ??
            new Error("Worker query session closed before returning a result."),
        );
      }
    }
  })();

  return {
    get sessionId(): string | null {
      return sessionId;
    },

    get queryPid(): number | undefined {
      return queryPid;
    },

    async sendPrompt(promptText: string): Promise<SDKResultMessage> {
      if (closed) {
        throw new Error("Worker query session is closed.");
      }

      const deferred = createDeferred<SDKResultMessage>();
      pendingResults.push(deferred);
      promptStream.push(
        createUserMessage(promptText, sessionId ?? input.contentSessionId),
      );
      return deferred.promise;
    },

    async compact(): Promise<void> {
      if (closed) {
        throw new Error("Worker query session is closed.");
      }

      if (pendingCompact) {
        throw new Error("Worker query session compact already in progress.");
      }

      const deferred = createDeferred<void>();
      pendingCompact = deferred;
      promptStream.push(
        createUserMessage("/compact", sessionId ?? input.contentSessionId),
      );

      const timeoutId = setTimeout(() => {
        if (pendingCompact === deferred) {
          pendingCompact = null;
          deferred.reject(
            new Error(
              `Worker query session compact timed out after ${QUERY_COMPACT_TIMEOUT_MS}ms.`,
            ),
          );
        }
      }, QUERY_COMPACT_TIMEOUT_MS);

      try {
        await deferred.promise;
      } finally {
        clearTimeout(timeoutId);
      }
    },

    async close(abortError?: Error): Promise<void> {
      if (closePromise) {
        return closePromise;
      }

      closeError = abortError ?? null;
      closed = true;
      promptStream.close();
      abortController.abort();

      closePromise = (async () => {
        try {
          await Promise.race([
            loopPromise,
            new Promise<void>((resolve) => {
              setTimeout(resolve, 5_000);
            }),
          ]);
        } catch {
          // close remains best-effort
        } finally {
          if (queryPid && isProcessAliveImpl(queryPid)) {
            try {
              killImpl(queryPid, "SIGKILL");
            } catch {}
          }
          queryPid = undefined;
        }
      })();

      return closePromise;
    },
  };
}
