import type { Database } from "bun:sqlite";


import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  MNEMO_TOOL_DESCRIPTIONS,
  recallInputSchema,
  rememberInputSchema,
  timelineInputSchema,
} from "./definitions";
import {
  createDatabaseBackedHandlers,
  createStubHandler,
  type MnemoToolHandlers,
} from "./handlers";

declare const __DEFAULT_PACKAGE_VERSION__: string;

const PACKAGE_VERSION =
  typeof __DEFAULT_PACKAGE_VERSION__ === "string"
    ? __DEFAULT_PACKAGE_VERSION__
    : "0.0.0-test";

export interface CreateMcpServerOptions {
  database?: Database;
  handlers?: Partial<MnemoToolHandlers>;
}

type MainMcpToolName = "recall" | "timeline" | "remember";
type MainMcpToolHandlers = Pick<MnemoToolHandlers, MainMcpToolName>;
type ToolRegistrationTarget = Pick<McpServer, "registerTool">;

function startParentHeartbeat(intervalMs = 30_000): NodeJS.Timeout {
  const timer = setInterval(() => {
    if (process.ppid === 1) {
      process.exit(0);
    }
  }, intervalMs);

  timer.unref();

  return timer;
}

export function registerMainMcpTools(
  server: ToolRegistrationTarget,
  toolHandlers: MainMcpToolHandlers,
): void {
  server.registerTool(
    "recall",
    {
      description: MNEMO_TOOL_DESCRIPTIONS.recall,
      inputSchema: recallInputSchema,
    },
    (args) => toolHandlers.recall(args as Record<string, unknown>),
  );
  server.registerTool(
    "timeline",
    {
      description: MNEMO_TOOL_DESCRIPTIONS.timeline,
      inputSchema: timelineInputSchema,
    },
    (args) => toolHandlers.timeline(args as Record<string, unknown>),
  );
  server.registerTool(
    "remember",
    {
      description: MNEMO_TOOL_DESCRIPTIONS.remember,
      inputSchema: rememberInputSchema,
    },
    (args) => toolHandlers.remember(args as Record<string, unknown>),
  );
}

export function createMcpServer(
  options: CreateMcpServerOptions = {},
): McpServer {
  const server = new McpServer(
    {
      name: "claude-mnemo",
      version: PACKAGE_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  const mergedHandlers = {
    ...createDatabaseBackedHandlers(options.database, {
      defaultProject: process.cwd(),
    }),
    ...options.handlers,
  };

  const toolHandlers: MainMcpToolHandlers = {
    recall: mergedHandlers.recall ?? createStubHandler("recall"),
    timeline: mergedHandlers.timeline ?? createStubHandler("timeline"),
    remember: mergedHandlers.remember ?? createStubHandler("remember"),
  };

  registerMainMcpTools(server, toolHandlers);

  return server;
}

export async function startMcpServer(
  options: CreateMcpServerOptions = {},
): Promise<void> {
  const server = createMcpServer(options);
  const transport = new StdioServerTransport();
  const heartbeat = startParentHeartbeat();

  try {
    await server.connect(transport);
  } finally {
    clearInterval(heartbeat);
  }
}

function isDirectExecution(): boolean {
  const entry = process.argv[1] ?? "";
  return entry.endsWith("/server.ts") || entry.endsWith("/mcp-server.cjs");
}

if (isDirectExecution()) {
  void (async () => {
    const { createDatabase } = await import("../db/database");
    const { initializeDatabase } = await import("../db/schema");
    const db = createDatabase();
    initializeDatabase(db);
    await startMcpServer({ database: db });
  })();
}
