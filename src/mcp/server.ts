import type { Database } from "bun:sqlite";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { recallMemory } from "./recall";
import { replayMemory } from "./replay";
import { saveTurnTool } from "./save-turn";
import { updateSessionTool } from "./update-session";

declare const __DEFAULT_PACKAGE_VERSION__: string;

type ToolResult = {
  content: Array<{
    type: "text";
    text: string;
  }>;
};

type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult> | ToolResult;

export interface MnemoToolHandlers {
  recall: ToolHandler;
  replay: ToolHandler;
  save_turn: ToolHandler;
  update_session: ToolHandler;
}

export interface CreateMcpServerOptions {
  database?: Database;
  handlers?: Partial<MnemoToolHandlers>;
}

function textResult(text: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
  };
}

function createStubHandler(toolName: string): ToolHandler {
  return async () => textResult(`${toolName} not implemented`);
}

const recallInputSchema = z.object({
  query: z.string().optional(),
  session: z.number().int().optional(),
  turn: z.number().int().optional(),
  observation: z.number().int().optional(),
  expand_turns: z.array(z.number().int()).optional(),
  around: z.string().optional(),
  before: z.number().int().nonnegative().optional(),
  after: z.number().int().nonnegative().optional(),
  file: z.string().optional(),
  type: z.string().optional(),
  project: z.string().optional(),
  from_epoch: z.number().int().optional(),
  to_epoch: z.number().int().optional(),
});

const replayInputSchema = z.object({
  session: z.number().int(),
  turn: z.number().int().optional(),
  tool: z.number().int().positive().optional(),
  full: z.boolean().optional(),
  transcript_path: z.string().optional(),
});

const saveTurnInputSchema = z.object({
  session_id: z.number().int(),
  prompt_number: z.number().int().positive(),
  status: z.literal("undone").optional(),
  user_prompt: z.string().optional(),
  assistant_response: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  insight: z.string().optional(),
  files_read: z.array(z.string()).optional(),
  files_modified: z.array(z.string()).optional(),
  created_at_epoch: z.number().int().optional(),
  updated_at_epoch: z.number().int().optional(),
  observations: z
    .array(
      z.object({
        type: z.string(),
        title: z.string(),
        description: z.string().optional(),
        narrative: z.string().optional(),
        facts: z.array(z.string()).optional(),
        concepts: z.array(z.string()).optional(),
        files_read: z.array(z.string()).optional(),
        files_modified: z.array(z.string()).optional(),
      }),
    )
    .optional(),
});

const updateSessionInputSchema = z.object({
  session_id: z.number().int(),
  title: z.string().optional(),
  description: z.string().optional(),
  insight: z.string().optional(),
  updated_at_epoch: z.number().int().optional(),
  completed_at_epoch: z.number().int().optional(),
});

function createDatabaseBackedHandlers(
  database?: Database,
): Partial<MnemoToolHandlers> {
  if (!database) {
    return {};
  }

  return {
    recall: (args) =>
      textResult(
        recallMemory(database, {
          query: args.query as string | undefined,
          session: args.session as number | undefined,
          turn: args.turn as number | undefined,
          observation: args.observation as number | undefined,
          expandTurns: args.expand_turns as number[] | undefined,
          around: args.around as string | undefined,
          before: args.before as number | undefined,
          after: args.after as number | undefined,
          file: args.file as string | undefined,
          type: args.type as string | undefined,
          project: args.project as string | undefined,
          fromEpoch: args.from_epoch as number | undefined,
          toEpoch: args.to_epoch as number | undefined,
        }),
      ),
    replay: (args) =>
      textResult(
        replayMemory(database, {
          session: args.session as number,
          turn: args.turn as number | undefined,
          tool: args.tool as number | undefined,
          full: args.full as boolean | undefined,
          transcriptPath: args.transcript_path as string | undefined,
        }),
      ),
    save_turn: (args) =>
      saveTurnTool(database, args as unknown as Parameters<typeof saveTurnTool>[1]),
    update_session: (args) =>
      updateSessionTool(
        database,
        args as unknown as Parameters<typeof updateSessionTool>[1],
      ),
  };
}

function startParentHeartbeat(intervalMs = 30_000): NodeJS.Timeout {
  const timer = setInterval(() => {
    if (process.ppid === 1) {
      process.exit(0);
    }
  }, intervalMs);

  timer.unref();

  return timer;
}

export function createMcpServer(
  options: CreateMcpServerOptions = {},
): McpServer {
  const server = new McpServer(
    {
      name: "claude-mnemo",
      version: __DEFAULT_PACKAGE_VERSION__,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  const mergedHandlers = {
    ...createDatabaseBackedHandlers(options.database),
    ...options.handlers,
  };

  const toolHandlers: MnemoToolHandlers = {
    recall: mergedHandlers.recall ?? createStubHandler("recall"),
    replay: mergedHandlers.replay ?? createStubHandler("replay"),
    save_turn: mergedHandlers.save_turn ?? createStubHandler("save_turn"),
    update_session:
      mergedHandlers.update_session ?? createStubHandler("update_session"),
  };

  server.registerTool(
    "recall",
    {
      description: "Recall structured memories from the SQLite store.",
      inputSchema: recallInputSchema,
    },
    (args) => toolHandlers.recall(args as Record<string, unknown>),
  );
  server.registerTool(
    "replay",
    {
      description: "Replay raw transcript content from the source JSONL.",
      inputSchema: replayInputSchema,
    },
    (args) => toolHandlers.replay(args as Record<string, unknown>),
  );
  server.registerTool(
    "save_turn",
    {
      description: "Persist one extracted turn and its observations.",
      inputSchema: saveTurnInputSchema,
    },
    (args) => toolHandlers.save_turn(args as Record<string, unknown>),
  );
  server.registerTool(
    "update_session",
    {
      description: "Update the session summary fields.",
      inputSchema: updateSessionInputSchema,
    },
    (args) => toolHandlers.update_session(args as Record<string, unknown>),
  );

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
    const { initializeSchema } = await import("../db/schema");
    const db = createDatabase();
    initializeSchema(db);
    await startMcpServer({ database: db });
  })();
}
