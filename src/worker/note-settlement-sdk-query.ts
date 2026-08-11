import {
  createSdkMcpServer,
  query,
  tool,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Database } from "bun:sqlite";

import {
  MNEMO_TOOL_DESCRIPTIONS,
  timelineInputShape,
  workerRecallInputShape,
} from "../mcp/definitions";
import { createDatabaseBackedHandlers } from "../mcp/handlers";
import { buildIsolatedEnv } from "../mnemosyne/env";
import { resolveClaudeCodeExecutablePath } from "./claude-executable";
import type {
  NoteSettlementQuery,
  NoteSettlementQueryRequest,
} from "./note-settlement-dispatch";

/**
 * The settlement subprocess (spec D9/D10, ticket 07).
 *
 * The worker hosts no model of its own, so every settlement is a spawned child
 * that exits when the window is decided — no resident session, no resume
 * pointer, no stall watchdog, which is the whole reason the previous extraction
 * architecture was retired. The window's material arrives in the prompt; the two
 * read tools exist only for the drill-down the spec allows ("不足时自行 recall
 * 下钻，与任何读者同权"), and are the same handlers every other reader uses.
 */

const SETTLEMENT_ALLOWED_TOOLS = [
  "mcp__mnemo__recall",
  "mcp__mnemo__timeline",
] as const;

export interface CreateNoteSettlementSdkQueryOptions {
  db: Database;
  dataRoot: string;
  defaultProject?: string;
  queryImpl?: typeof query;
  createSdkMcpServerImpl?: typeof createSdkMcpServer;
  toolImpl?: typeof tool;
  /** Environment snapshot for the child; defaults to the sanitized baseline. */
  agentEnv?: NodeJS.ProcessEnv;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function createNoteSettlementSdkQuery(
  options: CreateNoteSettlementSdkQueryOptions,
): NoteSettlementQuery {
  const queryImpl = options.queryImpl ?? query;
  const createSdkMcpServerImpl =
    options.createSdkMcpServerImpl ?? createSdkMcpServer;
  const toolImpl = options.toolImpl ?? tool;
  const handlers = createDatabaseBackedHandlers(options.db, {
    defaultProject: options.defaultProject,
    audience: "worker",
  });

  return async (request: NoteSettlementQueryRequest): Promise<string> => {
    const abortController = new AbortController();
    const forwardAbort = (): void => {
      abortController.abort(request.signal?.reason);
    };
    if (request.signal) {
      if (request.signal.aborted) {
        forwardAbort();
      } else {
        request.signal.addEventListener("abort", forwardAbort, { once: true });
      }
    }

    const server = createSdkMcpServerImpl({
      name: "mnemo",
      version: "0.9.11",
      tools: [
        toolImpl(
          "recall",
          MNEMO_TOOL_DESCRIPTIONS.recall,
          workerRecallInputShape,
          async (args: Record<string, unknown>) =>
            textResult(
              (await handlers.recall?.(args))?.content[0]?.text ??
                "recall unavailable",
            ),
        ),
        toolImpl(
          "timeline",
          MNEMO_TOOL_DESCRIPTIONS.timeline,
          timelineInputShape,
          async (args: Record<string, unknown>) =>
            textResult(
              (await handlers.timeline?.(args))?.content[0]?.text ??
                "timeline unavailable",
            ),
        ),
      ],
    });

    try {
      const execution = queryImpl({
        prompt: request.prompt,
        options: {
          model: request.model,
          cwd: options.dataRoot,
          // The bundled CJS worker breaks the SDK's import.meta.url CLI
          // resolution; resolve explicitly, same as diary/query-session.
          pathToClaudeCodeExecutable: resolveClaudeCodeExecutablePath(),
          env: {
            ...(options.agentEnv ?? buildIsolatedEnv(process.env, {})),
            // One short burst with no cross-run reuse: the 1h cache would pay
            // the write premium for nothing.
            FORCE_PROMPT_CACHING_5M: "1",
          },
          tools: [],
          allowedTools: [...SETTLEMENT_ALLOWED_TOOLS],
          mcpServers: { mnemo: server },
          abortController,
          systemPrompt: request.systemPrompt,
        },
      });

      let envelope: string | null = null;
      for await (const message of execution as AsyncIterable<SDKMessage>) {
        if (message.type !== "result") {
          continue;
        }
        if (message.subtype !== "success" || message.is_error) {
          throw new Error(
            `note settlement query failed (${message.subtype})`,
          );
        }
        envelope = message.result;
      }

      if (envelope === null) {
        throw new Error("note settlement query returned no result envelope");
      }
      return envelope;
    } finally {
      if (request.signal) {
        request.signal.removeEventListener("abort", forwardAbort);
      }
    }
  };
}
