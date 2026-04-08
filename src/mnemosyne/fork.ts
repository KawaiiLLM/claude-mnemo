import { existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname } from "node:path";

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
  saveTurnInputShape,
  updateSessionInputShape,
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

function createMnemoSdkServer(
  database: Database,
  defaultProject: string | undefined,
  deps: {
    createSdkMcpServerImpl: typeof createSdkMcpServer;
    toolImpl: typeof tool;
  },
) {
  const partialHandlers = createDatabaseBackedHandlers(database, {
    defaultProject,
  });
  const handlers: MnemoToolHandlers = {
    recall: partialHandlers.recall ?? missingHandler("recall"),
    replay: partialHandlers.replay ?? missingHandler("replay"),
    remember: partialHandlers.remember ?? missingHandler("remember"),
    save_turn: partialHandlers.save_turn ?? missingHandler("save_turn"),
    update_session:
      partialHandlers.update_session ?? missingHandler("update_session"),
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
        "save_turn",
        MNEMO_TOOL_DESCRIPTIONS.save_turn,
        saveTurnInputShape,
        async (args) => handlers.save_turn(args as Record<string, unknown>),
      ),
      deps.toolImpl(
        "update_session",
        MNEMO_TOOL_DESCRIPTIONS.update_session,
        updateSessionInputShape,
        async (args) => handlers.update_session(args as Record<string, unknown>),
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

function moveAgentSession(cwd: string, sessionId: string): void {
  const srcPath = resolveTranscriptPath(cwd, sessionId);
  const destPath = resolveAgentSessionPath(sessionId);

  if (!existsSync(srcPath)) {
    return;
  }

  mkdirSync(dirname(destPath), { recursive: true });

  try {
    renameSync(srcPath, destPath);
  } catch {
    // Cross-device move: copy then delete
    const content = Bun.file(srcPath).text();
    Bun.write(destPath, content);
    unlinkSync(srcPath);
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
          basename(input.cwd ?? process.cwd()),
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
      maxTurns: 15,
      allowedTools: [...MNEMO_ALLOWED_TOOLS],
      mcpServers,
      pathToClaudeCodeExecutable,
      env: buildIsolatedEnv(),
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
