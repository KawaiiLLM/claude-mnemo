import type { Database } from "bun:sqlite";

import { checkTool } from "./check";
import { noteTool } from "./note";
import { recallMemory } from "./recall";
import { rememberTool } from "./remember";
import { timelineQuery } from "./timeline";
import { resolveEraCutoff } from "../db/era";
import { stripPrivateTags } from "../shared/tag-stripping";


export const WORKER_TOOL_RESULT_MAX_CHARS = 100_000;
export const WORKER_TOOL_RESULT_TRUNCATION_HINT =
  "\n\n[工具返回已达上限；请用分页或收窄选择器继续。]";

export type ToolResult = {
  content: Array<{
    type: "text";
    text: string;
  }>;
};

export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult> | ToolResult;

export interface MnemoToolHandlers {
  recall: ToolHandler;
  timeline: ToolHandler;
  note: ToolHandler;
  remember: ToolHandler;
  check: ToolHandler;
}

export type TimelineToolView = "turns" | "milestones" | "phases";

export interface TimelineQueryInput {
  id: string;
  page?: number;
  pageSize?: number;
  view?: TimelineToolView;
  eraCutoffEpoch?: number | null;
}

export interface CreateDatabaseBackedHandlersOptions {
  defaultProject?: string;
  // "worker" surfaces the DB turn id (`dbid:T<dbid>`) in recall output so the
  // memory worker can cite a turn it found via `recall(query=...)`. The public
  // main agent uses "main" (default) and keeps the prompt-number labels — this
  // is wired here, NOT in `recallInputShape`, which is strict.
  audience?: "main" | "worker";
  /**
   * P2 era boundary (spec D11/D12). Resolved once here rather than per call —
   * it only changes on a reload — and defaults to the configured value, whose
   * own default (`null`) keeps every turn on the legacy path. This is the one
   * place the value is read for tool calls: reads (recall/timeline) and writes
   * (note) are handed the same number, so a turn cannot be written
   * under one era's rules and rendered under the other's.
   */
  eraCutoffEpoch?: number | null;
  /**
   * Resolves the caller's mnemo session id for `note` (spec D2), called fresh
   * on every `note` invocation rather than once here — the process-session
   * mapping this reads can be written by a UserPromptSubmit hook that runs
   * AFTER these handlers are built (the MCP server connects before the
   * session's first prompt), so resolving once at construction time would
   * permanently miss it. Only the MCP direct-execution entry point
   * (server.ts) ever supplies this; every other construction path — every
   * worker tool channel included — must leave it undefined, which `note`
   * reads as "caller identity unknown" and always admits.
   */
  resolveCallerSessionId?: () => number | null;
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

export function toTimelineQueryInput(args: Record<string, unknown>): TimelineQueryInput {
  const input: TimelineQueryInput = {
    id: args.id as string,
  };

  if (args.page !== undefined) {
    input.page = args.page as number;
  }
  if (args.pageSize !== undefined) {
    input.pageSize = args.pageSize as number;
  }
  if (args.view !== undefined) {
    input.view = args.view as TimelineToolView;
  }

  return input;
}

export function createDatabaseBackedHandlers(
  database?: Database,
  options: CreateDatabaseBackedHandlersOptions = {},
): Partial<MnemoToolHandlers> {
  if (!database) {
    return {};
  }

  const includeDbTurnIds = options.audience === "worker";
  // Resolved per tool call, not once here. These handlers are built when the
  // MCP server connects, which can be before any process of this build has
  // recorded the era: pinning `null` at that moment would make every `note` in
  // the session decline to promote its turn while the hooks, resolving live,
  // settle the same rows as new-era holes.
  const eraCutoff = (): number | null =>
    options.eraCutoffEpoch !== undefined
      ? options.eraCutoffEpoch
      : resolveEraCutoff(database);
  const workerTextResult = (text: string): ToolResult => {
    if (!includeDbTurnIds) {
      return textResult(text);
    }
    const stripped = stripPrivateTags(text);
    if (stripped.length <= WORKER_TOOL_RESULT_MAX_CHARS) {
      return textResult(stripped);
    }
    const contentLimit = Math.max(
      0,
      WORKER_TOOL_RESULT_MAX_CHARS - WORKER_TOOL_RESULT_TRUNCATION_HINT.length,
    );
    return textResult(
      stripped.slice(0, contentLimit) + WORKER_TOOL_RESULT_TRUNCATION_HINT,
    );
  };

  return {
    recall: (args) =>
      workerTextResult(
        recallMemory(database, {
          id: args.id as string | undefined,
          query: args.query as string | undefined,
          time: args.time as string | undefined,
          depth: args.depth as "collapsed" | "expanded" | undefined,
          page: args.page as number | undefined,
          pageSize: args.pageSize as number | undefined,
          truncate: args.truncate as number | undefined,
          includeDbTurnIds,
          truncateCap: includeDbTurnIds ? Number.MAX_SAFE_INTEGER : undefined,
          eraCutoffEpoch: eraCutoff(),
        }),
      ),
    timeline: (args) =>
      workerTextResult(
        timelineQuery(database, {
          ...toTimelineQueryInput(args),
          eraCutoffEpoch: eraCutoff(),
        }),
      ),
    // Not wrapped in workerTextResult: `note` is a main-agent-only write, and
    // its confirmation is a short mechanical receipt with no memory text to
    // truncate or re-strip.
    note: (args) =>
      noteTool(database, args as Parameters<typeof noteTool>[1], {
        eraCutoffEpoch: eraCutoff(),
        callerSessionId: options.resolveCallerSessionId?.() ?? null,
      }),
    // Same shape as `note`: a main-agent-only write (ADR-0002), a short
    // mechanical receipt (plus `attach`'s field render), nothing to truncate.
    // No era gating — segments carry no legacy shape `remember` needs to
    // route around.
    remember: (args) =>
      rememberTool(database, args as Parameters<typeof rememberTool>[1], {
        callerSessionId: options.resolveCallerSessionId?.() ?? null,
      }),
    // Same shape as `note`: a short mechanical report, nothing to truncate.
    check: (args) => checkTool(database, args as Parameters<typeof checkTool>[1]),
  };
}
