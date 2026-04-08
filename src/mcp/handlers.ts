import type { Database } from "bun:sqlite";

import { recallMemory } from "./recall";
import { rememberTool } from "./remember";
import { replayMemory } from "./replay";
import { saveTurnTool } from "./save-turn";
import { updateSessionTool } from "./update-session";

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
  save_turn: ToolHandler;
  update_session: ToolHandler;
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
): Partial<MnemoToolHandlers> {
  if (!database) {
    return {};
  }

  return {
    recall: (args) =>
      textResult(
        recallMemory(database, {
          scope: args.scope as "sessions" | "turns" | "observations" | undefined,
          query: args.query as string | undefined,
          session: args.session as number | undefined,
          turn: args.turn as number | undefined,
          obs: (args.obs as number | number[] | string | undefined) ?? undefined,
          time: args.time as string | undefined,
          depth: args.depth as "collapsed" | "expanded" | "full" | undefined,
          observation: args.observation as number | undefined,
          expandTurns:
            (args.expand_turns as number[] | undefined) ??
            (args.expandTurns as number[] | undefined),
          around: args.around as string | undefined,
          before: args.before as number | undefined,
          after: args.after as number | undefined,
          file: args.file as string | undefined,
          type: args.type as string | undefined,
          project: args.project as string | undefined,
          fromEpoch:
            (args.fromEpoch as number | undefined) ??
            (args.from_epoch as number | undefined),
          toEpoch:
            (args.toEpoch as number | undefined) ??
            (args.to_epoch as number | undefined),
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
    save_turn: (args) =>
      saveTurnTool(database, args as unknown as Parameters<typeof saveTurnTool>[1]),
    update_session: (args) =>
      updateSessionTool(
        database,
        args as unknown as Parameters<typeof updateSessionTool>[1],
      ),
  };
}
