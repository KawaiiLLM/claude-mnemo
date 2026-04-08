import type { Database } from "bun:sqlite";

import { recallMemory } from "./recall";
import { rememberTool } from "./remember";
import { replayMemory } from "./replay";

export type ToolResult = {
  content: Array<{
    type: "text";
    text: string;
  }>;
};

export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult> | ToolResult;

export interface MnemoToolHandlers {
  recall: ToolHandler;
  replay: ToolHandler;
  remember: ToolHandler;
}

export interface CreateDatabaseBackedHandlersOptions {
  defaultProject?: string;
}

export function textResult(text: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
  };
}

export function createStubHandler(toolName: string): ToolHandler {
  return async () => textResult(`${toolName} not implemented`);
}

export function createDatabaseBackedHandlers(
  database?: Database,
  options: CreateDatabaseBackedHandlersOptions = {},
): Partial<MnemoToolHandlers> {
  if (!database) {
    return {};
  }

  return {
    recall: (args) =>
      textResult(
        recallMemory(database, {
          view: args.view as "sessions" | "turns" | "observations" | "memories" | undefined,
          id: args.id as string | undefined,
          query: args.query as string | undefined,
          session: args.session as number | number[] | string | undefined,
          turn: args.turn as number | number[] | string | undefined,
          obs: (args.obs as number | number[] | string | undefined) ?? undefined,
          time: args.time as string | undefined,
          depth: args.depth as "collapsed" | "expanded" | "full" | undefined,
          limit: args.limit as number | undefined,
          expandTurns:
            (args.expand_turns as number[] | undefined) ??
            (args.expandTurns as number[] | undefined),
          before: args.before as number | undefined,
          after: args.after as number | undefined,
          file: args.file as string | undefined,
          type: args.type as string | undefined,
          project:
            (args.project as string | undefined) ?? options.defaultProject,
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
    remember: (args) =>
      rememberTool(database, args as unknown as Parameters<typeof rememberTool>[1]),
  };
}
