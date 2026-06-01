import type { Database } from "bun:sqlite";

import { recallMemory } from "./recall";
import { rememberTool } from "./remember";
import { timelineQuery } from "./timeline";

export type ToolResult = {
  content: Array<{
    type: "text";
    text: string;
  }>;
};

export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult> | ToolResult;

export interface MnemoToolHandlers {
  recall: ToolHandler;
  remember: ToolHandler;
  timeline: ToolHandler;
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
          depth: args.depth as "collapsed" | "expanded" | undefined,
          page: args.page as number | undefined,
          pageSize: args.pageSize as number | undefined,
          truncate: args.truncate as number | undefined,
        }),
      ),
    remember: (args) =>
      rememberTool(database, args as unknown as Parameters<typeof rememberTool>[1]),
    timeline: (args) =>
      textResult(
        timelineQuery(database, {
          id: args.id as string,
          page: args.page as number | undefined,
          pageSize: args.pageSize as number | undefined,
          milestones: args.milestones as boolean | undefined,
          phases: args.phases as boolean | undefined,
        }),
      ),
  };
}
