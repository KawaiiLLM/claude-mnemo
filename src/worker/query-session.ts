import { spawn } from "node:child_process";

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
  moveAgentSession,
  resolveClaudeCodeExecutablePath,
} from "./agent-session";
import { getSession } from "../db/sessions";
import { buildIsolatedEnv } from "../mnemosyne/env";

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
  systemPrompt?: string;
}

export interface WorkerQuerySessionDeps {
  queryImpl?: typeof query;
  createSdkMcpServerImpl?: typeof createSdkMcpServer;
  toolImpl?: typeof tool;
  spawnImpl?: typeof spawn;
  moveAgentSessionImpl?: typeof moveAgentSession;
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
  const moveAgentSessionImpl = deps.moveAgentSessionImpl ?? moveAgentSession;
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

  let sessionId: string | null = null;
  let queryPid: number | undefined;
  let closed = false;
  let closePromise: Promise<void> | null = null;

  const execution: Query = queryImpl({
    prompt: promptStream,
    options: {
      model: "claude-sonnet-4-6",
      cwd: input.project,
      allowedTools: [...MNEMO_ALLOWED_TOOLS],
      mcpServers,
      pathToClaudeCodeExecutable,
      abortController,
      systemPrompt:
        input.systemPrompt ??
        "You are Mnemosyne, the memory worker for Claude Code. Use only remember(), recall(), and replay(). Non-tool output is discarded.",
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
          if (sessionId) {
            moveAgentSessionImpl(input.project, sessionId);
          }
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
