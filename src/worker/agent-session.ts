import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

import type { Database } from "bun:sqlite";

import {
  createSdkMcpServer,
  tool,
} from "@anthropic-ai/claude-agent-sdk";

import {
  MNEMO_ALLOWED_TOOLS,
  MNEMO_TOOL_DESCRIPTIONS,
  recallInputShape,
  rememberInputShape,
} from "../mcp/definitions";
import {
  createDatabaseBackedHandlers,
  type MnemoToolHandlers,
} from "../mcp/handlers";

interface ClaudeExecutableResolverDeps {
  existsSync: (path: string) => boolean;
  findOnPath: () => string | null;
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
    onRemember?: (id: string) => void;
  } = {
    createSdkMcpServerImpl: createSdkMcpServer,
    toolImpl: tool,
  },
) {
  const partialHandlers = createDatabaseBackedHandlers(database, {
    defaultProject,
  });
  const handlers: Pick<MnemoToolHandlers, "recall" | "remember"> = {
    recall: partialHandlers.recall ?? missingHandler("recall"),
    remember: partialHandlers.remember ?? missingHandler("remember"),
  };

  return deps.createSdkMcpServerImpl({
    name: "mnemo",
    version: "0.2.11",
    tools: [
      deps.toolImpl(
        "remember",
        MNEMO_TOOL_DESCRIPTIONS.remember,
        rememberInputShape,
        async (args) => {
          const id = (args as { id?: unknown }).id;
          if (typeof id === "string") {
            deps.onRemember?.(id);
          }
          return handlers.remember(args as Record<string, unknown>);
        },
      ),
      deps.toolImpl(
        "recall",
        MNEMO_TOOL_DESCRIPTIONS.recall,
        recallInputShape,
        async (args) => handlers.recall(args as Record<string, unknown>),
      ),
    ],
  });
}

function missingHandler(toolName: string): never {
  throw new Error(`Missing Mnemo tool handler: ${toolName}`);
}
