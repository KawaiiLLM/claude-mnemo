import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";

import type { Database } from "bun:sqlite";

import {
  createSdkMcpServer,
  query,
  tool,
} from "@anthropic-ai/claude-agent-sdk";

import {
  MNEMO_ALLOWED_TOOLS,
  MNEMO_TOOL_DESCRIPTIONS,
  recallInputShape,
  rememberInputShape,
  replayInputShape,
} from "../mcp/definitions";
import {
  createDatabaseBackedHandlers,
  type MnemoToolHandlers,
} from "../mcp/handlers";
import { resolveAgentSessionPath, resolveTranscriptPath } from "../shared/paths";
import { buildIsolatedEnv } from "./env";

export interface ForkMnemosyneInput {
  prompt: string;
  cwd?: string;
  database?: Database;
}

export interface ForkMnemosyneResult {
  sessionId: string;
  numTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  durationMs: number;
  totalCostUsd: number;
}

interface ClaudeExecutableResolverDeps {
  existsSync: (path: string) => boolean;
  findOnPath: () => string | null;
}

interface ForkMnemosyneDeps {
  queryImpl?: typeof query;
  createSdkMcpServerImpl?: typeof createSdkMcpServer;
  toolImpl?: typeof tool;
  resolveClaudeCodeExecutablePathImpl?: typeof resolveClaudeCodeExecutablePath;
}

function findClaudeOnPath(): string | null {
  const command = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(command, ["claude"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  if (result.status !== 0) {
    return null;
  }

  const candidate = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return candidate || null;
}

export function resolveClaudeCodeExecutablePath(
  sourceEnv: NodeJS.ProcessEnv = process.env,
  deps: ClaudeExecutableResolverDeps = {
    existsSync,
    findOnPath: findClaudeOnPath,
  },
): string | undefined {
  const explicitPath =
    sourceEnv.CLAUDE_CODE_PATH || sourceEnv.CLAUDE_CODE_EXECUTABLE;

  if (explicitPath && deps.existsSync(explicitPath)) {
    return explicitPath;
  }

  return deps.findOnPath() ?? undefined;
}

export function createMnemoSdkServer(
  database: Database,
  defaultProject: string | undefined,
  deps: {
    createSdkMcpServerImpl: typeof createSdkMcpServer;
    toolImpl: typeof tool;
  } = {
    createSdkMcpServerImpl: createSdkMcpServer,
    toolImpl: tool,
  },
) {
  const partialHandlers = createDatabaseBackedHandlers(database, {
    defaultProject,
  });
  const handlers: MnemoToolHandlers = {
    recall: partialHandlers.recall ?? missingHandler("recall"),
    replay: partialHandlers.replay ?? missingHandler("replay"),
    remember: partialHandlers.remember ?? missingHandler("remember"),
  };

  return deps.createSdkMcpServerImpl({
    name: "mnemo",
    version: "0.1.0",
    tools: [
      deps.toolImpl(
        "remember",
        MNEMO_TOOL_DESCRIPTIONS.remember,
        rememberInputShape,
        async (args) => handlers.remember(args as Record<string, unknown>),
      ),
      deps.toolImpl(
        "recall",
        MNEMO_TOOL_DESCRIPTIONS.recall,
        recallInputShape,
        async (args) => handlers.recall(args as Record<string, unknown>),
      ),
      deps.toolImpl(
        "replay",
        MNEMO_TOOL_DESCRIPTIONS.replay,
        replayInputShape,
        async (args) => handlers.replay(args as Record<string, unknown>),
      ),
    ],
  });
}

function missingHandler(toolName: string): never {
  throw new Error(`Missing Mnemo tool handler: ${toolName}`);
}

export interface MoveAgentSessionDeps {
  resolveSrcPath: (cwd: string, sessionId: string) => string;
  resolveDestPath: (sessionId: string) => string;
  existsSync: typeof existsSync;
  mkdirSync: typeof mkdirSync;
  renameSync: typeof renameSync;
  copyFileSync: typeof copyFileSync;
  unlinkSync: typeof unlinkSync;
}

const defaultMoveDeps: MoveAgentSessionDeps = {
  resolveSrcPath: resolveTranscriptPath,
  resolveDestPath: resolveAgentSessionPath,
  existsSync,
  mkdirSync,
  renameSync,
  copyFileSync,
  unlinkSync,
};

function isExdevError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EXDEV"
  );
}

export function moveAgentSession(
  cwd: string,
  sessionId: string,
  deps: MoveAgentSessionDeps = defaultMoveDeps,
): void {
  const srcPath = deps.resolveSrcPath(cwd, sessionId);
  const destPath = deps.resolveDestPath(sessionId);

  if (!deps.existsSync(srcPath)) {
    return;
  }

  deps.mkdirSync(dirname(destPath), { recursive: true });

  try {
    deps.renameSync(srcPath, destPath);
  } catch (error) {
    if (!isExdevError(error)) {
      throw error;
    }

    // Cross-device move: sync copy then delete
    deps.copyFileSync(srcPath, destPath);
    deps.unlinkSync(srcPath);
  }
}

export async function forkMnemosyne(
  input: ForkMnemosyneInput,
  deps: ForkMnemosyneDeps = {},
): Promise<ForkMnemosyneResult | null> {
  const pathResolver =
    deps.resolveClaudeCodeExecutablePathImpl ?? resolveClaudeCodeExecutablePath;
  const pathToClaudeCodeExecutable = pathResolver();
  const queryImpl = deps.queryImpl ?? query;
  const createSdkMcpServerImpl =
    deps.createSdkMcpServerImpl ?? createSdkMcpServer;
  const toolImpl = deps.toolImpl ?? tool;
  const mcpServers = input.database
    ? {
        mnemo: createMnemoSdkServer(
          input.database,
          input.cwd ?? process.cwd(),
          {
            createSdkMcpServerImpl,
            toolImpl,
          },
        ),
      }
    : undefined;
  const execution = queryImpl({
    prompt: input.prompt,
    options: {
      model: "claude-sonnet-4-6",
      cwd: input.cwd,
      maxTurns: 5,
      allowedTools: [...MNEMO_ALLOWED_TOOLS],
      mcpServers,
      pathToClaudeCodeExecutable,
      env: {
        ...buildIsolatedEnv(),
        ENABLE_TOOL_SEARCH: "false",
      },
    },
  });

  let result: ForkMnemosyneResult | null = null;

  for await (const message of execution) {
    if (message.type === "result") {
      result = {
        sessionId: message.session_id,
        numTurns: message.num_turns,
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadInputTokens: message.usage.cache_read_input_tokens,
        cacheCreationInputTokens: message.usage.cache_creation_input_tokens,
        durationMs: message.duration_ms,
        totalCostUsd: "total_cost_usd" in message ? message.total_cost_usd : 0,
      };
    }
  }

  if (result) {
    moveAgentSession(input.cwd ?? process.cwd(), result.sessionId);
  }

  return result;
}
