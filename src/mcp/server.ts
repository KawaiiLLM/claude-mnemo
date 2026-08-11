import type { Database } from "bun:sqlite";


import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { getMnemoSessionIdForProcessSession } from "../db/process-session-map";
import {
  MNEMO_TOOL_DESCRIPTIONS,
  noteInputSchema,
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
  /**
   * Spec D2's identity source, threaded straight through to
   * `createDatabaseBackedHandlers`. Only `isDirectExecution`'s own startup
   * below ever supplies this — every test and every other embedding of this
   * server leaves it undefined, which is what keeps identity out of every
   * channel but the real MCP process.
   */
  resolveCallerSessionId?: () => number | null;
}

/**
 * Spec D2's identity resolution: the process env var naming this OS
 * process's session, joined through `process_session_map` (spec D1) to the
 * mnemo session a UserPromptSubmit hook has actually recorded for it. Both
 * halves can miss — the env var is absent on some Claude Code builds (the
 * investigation found no guaranteed write site for it), and the mapping row
 * may not exist yet if this runs before the session's first prompt — and a
 * miss on either one reads as `null`, "identity unknown", never as a false
 * match.
 *
 * Exported (rather than inlined in the startup IIFE below) purely so it has a
 * unit-testable surface independent of spawning the real MCP process.
 */
export function resolveCallerSessionIdFromEnv(
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const processSessionId = env.CLAUDE_CODE_SESSION_ID;
  if (typeof processSessionId !== "string" || processSessionId.length === 0) {
    return null;
  }

  return getMnemoSessionIdForProcessSession(db, processSessionId);
}

type MainMcpToolName = "recall" | "timeline" | "remember" | "note";
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
  server.registerTool(
    "note",
    {
      description: MNEMO_TOOL_DESCRIPTIONS.note,
      inputSchema: noteInputSchema,
    },
    (args) => toolHandlers.note(args as Record<string, unknown>),
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
      resolveCallerSessionId: options.resolveCallerSessionId,
    }),
    ...options.handlers,
  };

  const toolHandlers: MainMcpToolHandlers = {
    recall: mergedHandlers.recall ?? createStubHandler("recall"),
    timeline: mergedHandlers.timeline ?? createStubHandler("timeline"),
    remember: mergedHandlers.remember ?? createStubHandler("remember"),
    note: mergedHandlers.note ?? createStubHandler("note"),
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
    const { ensureRecordedEraCutoff } = await import("../db/era");
    const db = createDatabase();
    initializeDatabase(db);
    // The third production entry point that owns a writable database, and the
    // one most likely to open it first: the MCP server is spawned with the
    // session, before any hook of this build has run (db/era.ts).
    ensureRecordedEraCutoff(db, Math.floor(Date.now() / 1000));
    // spec D2: the only construction path in the whole codebase allowed to
    // supply this. Resolved fresh per `note` call (see the option's doc on
    // CreateDatabaseBackedHandlersOptions) rather than once here, since the
    // mapping this reads may not exist yet at this exact moment.
    await startMcpServer({
      database: db,
      resolveCallerSessionId: () => resolveCallerSessionIdFromEnv(db),
    });
  })();
}
