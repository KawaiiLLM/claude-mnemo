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
  _options: CreateDatabaseBackedHandlersOptions = {},
): Partial<MnemoToolHandlers> {
  if (!database) {
    return {};
  }

  return {
    recall: (args) =>
      textResult(
        recallMemory(database, {
          id: args.id as string | undefined,
          query: args.query as string | undefined,
          time: args.time as string | undefined,
          depth: args.depth as "collapsed" | "expanded" | "full" | undefined,
          limit: args.limit as number | undefined,
        }),
      ),
    replay: (args) =>
      textResult(
        replayMemory(database, {
          id: args.id as string | undefined,
          depth: args.depth as "collapsed" | "expanded" | "full" | undefined,
        }),
      ),
    remember: (args) =>
      rememberTool(database, args as unknown as Parameters<typeof rememberTool>[1]),
  };
}
