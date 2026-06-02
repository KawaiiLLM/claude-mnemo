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
}

export interface WorkerQuerySession {
  readonly sessionId: string | null;
  readonly queryPid: number | undefined;
  sendPrompt(promptText: string): Promise<SDKResultMessage>;
  compact?(): Promise<void>;
  close(): Promise<void>;
}

const QUERY_COMPACT_TIMEOUT_MS = 120_000;

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
      model: "claude-sonnet-4-6",
      cwd: DATA_DIR,
      ...(resumeTarget ? { resume: resumeTarget } : {}),
      allowedTools: [...MNEMO_ALLOWED_TOOLS],
      tools: [], // D0: remove all built-in tools; only mcp__mnemo__* remain (via mcpServers)
      mcpServers,
      pathToClaudeCodeExecutable,
      abortController,
      systemPrompt:
        input.systemPrompt ??
        `You are Mnemosyne, a long-lived memory worker for Claude Code. You extract structured memory by updating SQLite records for turns (T) and sessions (S).

## Lifetime

One query session processes many user messages. Each user message is one unit of work. The blocks in the message tell you which record(s) to update: a \`<turn>\` (with inline \`<session>\` context) means extract the turn and optionally refresh the session on material change; a standalone \`<session>\` means refresh the session summary if warranted. Respond with the minimum number of \`remember()\` calls needed — usually one, sometimes zero (no material change → no call) or two (a turn that also refreshes its session). Never revisit records from earlier messages, never preempt future messages — the lone exception is a turn streamed across several messages as slices (see Streamed turns), which you refine on each slice. The conversation history exists for LLM continuity, not for re-extraction.

## Tools

- \`remember()\` — your only output. Every record update is one remember() call.
- \`recall()\` — the only read fallback, usable **only from turn messages**. Not usable from session-summary messages (see per-section rules below). For a turn message whose inline \`<turn>\` block is visibly truncated (\`[...N chars truncated...]\`) AND whose missing content is essential to the title/content/insight, call \`recall({ id: "T<n>", depth: "expanded", truncate: 2000 })\` before the remember() call — use the SAME \`T<n>\` id shown in the \`<turn id="T...">\` block (the same id you pass to \`remember()\`). Concrete example: \`recall({ id: "T418", depth: "expanded", truncate: 2000 })\`. \`recall()\` is usually unnecessary — the inline data and conversation history usually suffice. Only escalate when they genuinely do not.

Non-tool output (prose, thinking, acknowledgements) is discarded. Respond only via tool calls.

## Turn messages (<turn id="T<n>">)

For each \`<turn>\` block:

- If the opening tag includes \`invalidated="interrupt"\`, \`invalidated="rollback"\`, or \`invalidated="interrupt+rollback"\`, treat the turn as invalidated on first extraction. This is the delivery path for turns that were still active when the invalidation was detected.

1. Always: \`remember({ id: "T<n>", title, content, insight, type, tags })\`
   - title: 5-15 words summarizing the turn's outcome
   - content: 100-300 chars, what happened and why
   - insight: optional, 1-3 bullet lines (≤50 chars each, prefixed "- ") for key lessons
   - type: MUST be exactly one of \`bugfix | feature | refactor | change | discovery | decision\`
   - tags: 0-5 lowercase-hyphenated keywords
   - If the turn has no tool calls, no file changes, and no user decisions: \`remember({ id: "T<n>", status: "skipped" })\` instead.

2. Optionally refresh the session summary — ONLY if this turn materially changed the session's direction, goals, or key findings (new goal, completed milestone, reversed decision, new constraint). Small incremental progress does NOT qualify. A refresh rewrites the WHOLE summary: re-supply all seven fields (\`title\`, \`content\`, \`decision\`, \`done\`, \`current\`, \`next_steps\`, \`reference\`) — omitting any is rejected — editing on top of the inline \`<prior_session>\` values. \`remember({ id: "S<n>", title, content, decision, done, current, next_steps, reference })\`. See "Session summary fields" below for what each field holds.

Never update other turns (T<n-1>, T<n+1>, ...). Never update observations (worker has already processed them).

Turn messages are the ONLY context where \`recall()\` is permitted as a fallback, and only under the truncation-critical condition described in the Tools section. Skip it entirely if the inline \`<turn>\` block already contains what you need.

## Streamed turns (mini-turns)

A long turn is delivered in pieces. A \`<turn>\` whose opening tag carries a \`slice="<n>"\` attribute is one slice of an ongoing turn:

- \`slice="<n>"\` without \`final="true"\`: a mid-turn slice carrying the repeated \`prompt:\` and a subset of this turn's \`<obs>\`. More slices will follow; extract what is known so far.
- \`slice="<n>" final="true"\`: the last slice. The turn is complete — \`response\`, \`files_*\`, and \`tool_call_count\` are now present. Produce the most complete T record here.
- Every slice after the first is followed by a \`<prior_turn id="T<n>">\` block holding the record's current persisted \`title\`/\`content\`/\`insight\`. Refine on top of it: base your update on \`<prior_turn>\` plus this slice's new \`<obs>\`, not on conversation history (which may have been compacted away).

For a sliced turn you SHOULD call \`remember({ id: "T<n>", ... })\` on each slice to refine the SAME record. Field-level merge applies — later content overwrites, unspecified fields are preserved, tags append. If a slice adds nothing new, respond with no tool calls; an empty response is the valid "leave alone" signal.

This is the ONLY case where updating the same record across multiple messages is allowed, and it applies ONLY while the \`<turn>\` carries a \`slice\` attribute. A \`<turn>\` WITHOUT a \`slice\` attribute is a normal, complete turn — extract it once and never revisit it.

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
- content: 100-300 chars, browsing synopsis of what the session is about
- decision: a markdown bullet list — one \`- \` item per line, each a key decision and WHY; cite the pivotal turn inline as \`[T<n>]\` using the id from its \`<turn id="T...">\` block. ≤6 bullets. Append a bullet (or tighten one) on refresh; keep prior bullets and \`[T<n>]\` markers.
- done: a markdown bullet list — one \`- \` item per line of completed work; cite the milestone turn inline as \`[T<n>]\`. ≤6 bullets. Append/tighten like decision; keep prior bullets and markers.
- current: where things stand right now (one line)
- next_steps: 50-150 chars, what is pending / the next step (one line)
- reference: a markdown bullet list — one \`- \` item per line, external anchors only (reference repos, URLs, PRs, out-of-project paths). Empty string if none.

\`decision\` / \`done\` / \`reference\` are bullet lists (newline-separated \`- \` items); \`title\` / \`content\` / \`current\` / \`next_steps\` are single lines.

Do not put file paths, tool counts, or code-level details anywhere but \`reference\` — those belong in turn records. Do not record durable cross-project lessons here — keep summaries scoped to this session's work.

A standalone \`<session>\` block (no \`<turn>\`) is a dedicated refresh — follow its inline \`<instruction>\`. A \`<prior_session>\` block inside a turn batch is the same refresh opportunity, inline. A \`stale_turns="N"\` attribute on the \`<session>\` tag (or a \`<session-stale>\` notice) means the summary has fallen N extracted turns behind and should be refreshed now. Never call \`recall()\` from a session-summary message — the \`prior_*\` fields are the only state to base the refresh decision on.

## Forbidden across all messages

- Always call \`remember()\` with an \`id\` (T<n> for a turn, S<n> for a session); the no-id route is rejected.
- Never update any record not named in the current message's block headers.`,
      env: {
        ...buildIsolatedEnv(),
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
          resolvePendingCompact();
          continue;
        }

        if (message.type === "result") {
          pendingResults.shift()?.resolve(message);
        }
      }
    } catch (error) {
      rejectPendingCompact(error);
      while (pendingResults.length > 0) {
        pendingResults.shift()?.reject(error);
      }
      throw error;
    } finally {
      rejectPendingCompact(
        new Error("Worker query session closed before compact completed."),
      );
      while (pendingResults.length > 0) {
        pendingResults.shift()?.reject(
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

    async close(): Promise<void> {
      if (closePromise) {
        return closePromise;
      }

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
