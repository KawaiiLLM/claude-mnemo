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
import {
  settlementTurnWriteInputShape,
  settlementTurnWriteTool,
  type SettlementTurnFacadeContext,
  type SettlementTurnWriteInput,
} from "./note-settlement-turn-facade";

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
  "mcp__mnemo__note",
] as const;

/**
 * Ticket 10a: the restricted write facade's own description, separate from
 * `MNEMO_TOOL_DESCRIPTIONS.note` (mcp/definitions.ts) because the surface
 * really is smaller — no `skip`, no session addressing, no `crossSession`,
 * no append mode, and prose/review are each gated to a scope this dispatch
 * alone defines. The duty-level instructions (which turns are holes, which
 * are reviewable, the grading rubric) live in the settlement prompt, not
 * here — this text states the CALL contract only.
 */
const SETTLEMENT_NOTE_TOOL_DESCRIPTION =
  "Write one turn's reconstruction note and/or its grade/type/tags/relations, " +
  "as you decide them — one call per turn, any time during this run. `turn`: " +
  "\"S<session>/T<prompt>\", from the window or preceding-turns section below. " +
  "title/content/insight: all three together, only for a turn this window " +
  "lists as owing a note (insight may be null, but must be named). grade " +
  "(0-4, against the rubric)/type/tags: only for a turn shown in this prompt " +
  "(window or preceding turns); each overwrites whole when present, omit to " +
  "leave alone — there is no append. evidenceFor/evidenceAgainst/supersedes/" +
  "dependsOn: address lists; a target must already be a pair that existed " +
  "before this run started — you cannot license a relation on a pair a call " +
  "earlier in this SAME run just created.";

export interface CreateNoteSettlementSdkQueryOptions {
  db: Database;
  dataRoot: string;
  defaultProject?: string;
  queryImpl?: typeof query;
  createSdkMcpServerImpl?: typeof createSdkMcpServer;
  toolImpl?: typeof tool;
  /** Environment snapshot for the child; defaults to the sanitized baseline. */
  agentEnv?: NodeJS.ProcessEnv;
  /** Epoch seconds at the moment of each individual tool write; injectable for tests. */
  now?: () => number;
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

    // Job identity (spec G6, ticket 10a): built HERE, inside the per-request
    // closure, from the dispatch's own job record — never from anything the
    // model supplied. `settlementTurnWriteInputShape` (note-settlement-
    // turn-facade.ts) declares no `jobId`/`claimGeneration` field at all, so
    // the SDK's own arg-parsing (built from that same shape, ahead of the
    // handler) never delivers one even if a model tried to state one; and
    // `settlementTurnWriteTool` itself never reads a job identity off its
    // input regardless — see that file's own comment for both halves. This
    // closure is the only place these values exist for this request, and
    // they never travel through the model's own input or output. It is also
    // why the handlers above are built ONCE at module-call time while THIS
    // context must be built per request: a job's identity does not exist
    // until a request names one.
    const turnFacadeContext: SettlementTurnFacadeContext = {
      jobId: request.jobId,
      claimGeneration: request.claimGeneration,
      sessionId: request.sessionId,
      reconstructableTurnIds: request.reconstructableTurnIds,
      reviewableTurnIds: request.reviewableTurnIds,
      contextBuiltAtEpoch: request.contextBuiltAtEpoch,
      rideTurnId: request.rideTurnId,
      writerModel: request.writerModel,
      eligibleRelationPairKeys: request.eligibleRelationPairKeys,
    };

    const server = createSdkMcpServerImpl({
      name: "mnemo",
      version: "0.10.0",
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
        toolImpl(
          "note",
          SETTLEMENT_NOTE_TOOL_DESCRIPTION,
          settlementTurnWriteInputShape,
          async (args: SettlementTurnWriteInput) =>
            settlementTurnWriteTool(
              options.db,
              turnFacadeContext,
              args,
              options.now?.() ?? Math.floor(Date.now() / 1000),
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
