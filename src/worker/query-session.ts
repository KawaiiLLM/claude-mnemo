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
  close(): Promise<void>;
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

  const execution: Query = queryImpl({
    prompt: promptStream,
    options: {
      model: "claude-sonnet-4-6",
      cwd: DATA_DIR,
      ...(resumeTarget ? { resume: resumeTarget } : {}),
      allowedTools: [...MNEMO_ALLOWED_TOOLS],
      mcpServers,
      pathToClaudeCodeExecutable,
      abortController,
      systemPrompt:
        input.systemPrompt ??
        `You are Mnemosyne, a long-lived memory worker for Claude Code. You extract structured memory by updating SQLite records for observations (O), turns (T), and sessions (S).

## Lifetime

One query session processes many user messages. Each user message is one unit of work. The blocks in the message tell you which record(s) to update: an \`<obs>\` means update that single observation; a \`<turn>\` (with inline \`<session>\` context) means extract the turn and optionally refresh the session on material change; a standalone \`<session>\` means refresh the session summary if warranted. Respond with the minimum number of \`remember()\` calls needed — usually one, sometimes zero (no material change → no call) or two (a turn that also refreshes its session). Never revisit records from earlier messages, never preempt future messages. The conversation history exists for LLM continuity, not for re-extraction.

## Tools

- \`remember()\` — your only output. Every record update is one remember() call.
- \`recall()\` — read-only fallback, usable **only from turn messages**. Not usable from observation or session-summary messages (see per-section rules below). For a turn message whose inline \`<turn>\` block is visibly truncated (\`[...N chars truncated...]\`) AND whose missing content is essential to the title/content/insight, call \`recall({ id: "<session id>/<turn id>", depth: "expanded", truncate: 2000 })\` before the remember() call — read the session id from the \`<session id="S...">\` block and the turn id from the \`<turn id="T...">\` block of the current message; they are two different numbers. Concrete example: \`recall({ id: "S12/T3", depth: "expanded", truncate: 2000 })\`. \`recall()\` is rarely needed — the inline data and conversation history almost always suffice.

Non-tool output (prose, thinking, acknowledgements) is discarded. Respond only via tool calls.

## Observation messages (<obs id="O<n>">)

For each \`<obs>\` block, make exactly one call:

- \`remember({ id: "O<n>", title, content })\`
  - title: 3-12 words, verb-led (e.g. "Read auth middleware", "Grep for token usage")
  - content: one paragraph, what the tool did and why it matters for this session. Do not restate tool arguments — they are already in the obs block.

- \`remember({ id: "O<n>", status: "skipped" })\` for routine operations: repeated Reads of the same file, navigation (ls/pwd/glob), failed-and-retried Bash, environment probes.

Never update T/S records, create memories, or call \`recall()\` from an obs message. Observation extraction is the high-volume path — tool-level summaries do not need transcript fidelity. The inline \`<obs>\` block is authoritative even when its \`in:\` / \`out:\` fields are truncated; write the summary from what is visible and note visibly-relevant truncation in the content (e.g. "truncated 1200-char grep output, 12 matches").

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

Turn messages are the ONLY context where \`recall()\` is permitted, and only under the truncation-critical condition described in the Tools section. Skip it entirely if the inline \`<turn>\` block already contains what you need.

## Session summary messages (<session> without <turn>)

When you receive a \`<session>\` block without an accompanying \`<turn>\`, it is a session summary refresh. Follow the length budget in the inline \`<instruction>\` block. Never call \`recall()\` from a session-summary message — the inline \`prior_*\` fields are the only state you should base the refresh decision on.

## Forbidden across all messages

- Never call \`remember()\` without an \`id\` field — that creates an M-level memory, which is the main agent's responsibility, not yours. Proactive memory creation from Mnemosyne is a bug.
- Never update any record not named in the current message's block headers.`,
      env: {
        ...buildIsolatedEnv(),
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

        if (message.type === "result") {
          pendingResults.shift()?.resolve(message);
        }
      }
    } catch (error) {
      while (pendingResults.length > 0) {
        pendingResults.shift()?.reject(error);
      }
      throw error;
    } finally {
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
