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
  NoteSettlementQueryResult,
} from "./note-settlement-dispatch";
import {
  settlementMembershipWriteInputShape,
  type SettlementMembershipWriteInput,
} from "./note-settlement-membership-facade";
import { createSettlementStagingEngine } from "./note-settlement-staging";
import { createSettlementStopHook } from "./note-settlement-stop-hook";
import {
  settlementTurnWriteInputShape,
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
  "mcp__mnemo__remember",
  "mcp__mnemo__commit",
] as const;

/**
 * The restricted write facade's own description, separate from
 * `MNEMO_TOOL_DESCRIPTIONS.note` (mcp/definitions.ts) because the surface
 * really is smaller — no `skip`, no session addressing, no `crossSession`,
 * no append mode, no prose (title/content/insight — retired with duty 2,
 * ticket 05), and review is gated to a scope this dispatch alone defines.
 * The duty-level instructions (which turns are reviewable) live in the
 * settlement prompt, not here — this text states the CALL contract only.
 *
 * "Staged" (spec A7): this call validates fully right now and tells you
 * exactly what it found, but nothing reaches a stored row until you call
 * `commit`.
 */
const SETTLEMENT_NOTE_TOOL_DESCRIPTION =
  "STAGE a turn's grade/type/tags and/or relations — validated now, " +
  "written only when you call `commit`. `turn`: \"S<session>/T<prompt>\", " +
  "from the window or preceding-turns section below — this is also this " +
  "call's KEY: staging the same turn again REPLACES what you staged for it " +
  "before, so a lost-receipt retry or a same-run correction is just " +
  "another call, not a new problem. Does NOT accept title/content/insight " +
  "— turn prose is the main agent's alone to write. " +
  "grade (0-4)/type/tags: only for a turn shown in this prompt (window or " +
  "preceding turns); each overwrites whole when present, omit to leave " +
  "alone — there is no append. " +
  "evidenceFor/evidenceAgainst/supersedes/dependsOn: address lists; a target " +
  "must already be a pair that existed before this run started AND still " +
  "exist when `commit` lands it — you cannot license a relation on a pair a " +
  "call earlier in this SAME run just created, or on one the main agent has " +
  "since stopped citing.";

/**
 * The `remember` tool's settlement-side call contract — `propose` is the
 * only surviving verb (ticket 05: `assign` is dead, membership is no longer
 * settlement's to change here). Registered under the SAME tool name the main
 * agent's own `remember` uses, a settlement-specific shape, the same
 * relationship the `note` facade already has to the main agent's `note`
 * tool.
 */
const SETTLEMENT_REMEMBER_TOOL_DESCRIPTION =
  "STAGE a text-only task proposal — validated now, written only when you " +
  "call `commit`. action: \"propose\" (the only legal value). addresses " +
  "(one or more \"S<session>/T<prompt>\" turn addresses — a single homeless " +
  "turn may open its own proposal, or name a cluster forming ONE coherent " +
  "task) + title (a short suggested name) — stores a text-only suggestion " +
  "for the user to confirm next session. This call's KEY is the address SET " +
  "(order-independent): re-staging the same set replaces the earlier " +
  "proposal. NEVER creates a segment and is never auto-adopted — do not " +
  "propose an incoherent grab-bag. Never required — this window may commit " +
  "without ever calling this tool.";

/** The completion gate exposed as commit's own precondition — settlement gets no separate `check` tool. */
const SETTLEMENT_COMMIT_TOOL_DESCRIPTION =
  "Land every staged `note`/`remember` write in one transaction. Call this " +
  "once you believe the window is done — whether or not you staged " +
  "anything; a window with nothing to propose or relate commits cleanly — " +
  "it is the only way any of your work becomes durable. If your job lease " +
  "has been reclaimed, commit refuses and no further commit from this run " +
  "will ever succeed — stop making tool calls.";

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

  return async (
    request: NoteSettlementQueryRequest,
  ): Promise<NoteSettlementQueryResult> => {
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
    // model supplied. `settlementTurnWriteInputShape`/`settlementMembershipWriteInputShape`
    // declare no `jobId`/`claimGeneration` field at all, so the SDK's own
    // arg-parsing (built from that same shape, ahead of the handler) never
    // delivers one even if a model tried to state one; and neither facade's
    // own evaluator ever reads a job identity off its input regardless —
    // see those files' own comments. This closure is the only place these
    // values exist for this request, and they never travel through the
    // model's own input or output. It is also why the handlers above are
    // built ONCE at module-call time while THIS context (and the staging
    // engine built from it, ticket 10b) must be built per request: a job's
    // identity — and its own staged-write list — does not exist until a
    // request names one.
    const turnFacadeContext: SettlementTurnFacadeContext = {
      jobId: request.jobId,
      claimGeneration: request.claimGeneration,
      sessionId: request.sessionId,
      reviewableTurnIds: request.reviewableTurnIds,
      contextBuiltAtEpoch: request.contextBuiltAtEpoch,
      eligibleRelationPairKeys: request.eligibleRelationPairKeys,
    };
    const staging = createSettlementStagingEngine({
      db: options.db,
      context: turnFacadeContext,
      now: options.now,
    });
    // Ticket 11 (spec G2's first layer): per REQUEST, like the staging engine
    // it reads — the block count is a fact about this run's stops, and a
    // shared one would let an earlier window's stops silence a later
    // window's warning. Registered as an SDK hook rather than through
    // `hooks/hook-command.ts`: that command short-circuits to success for
    // `CLAUDE_CODE_ENTRYPOINT === "sdk-ts"`, so mnemo's file-configured hooks
    // deliberately never fire inside a spawned SDK child.
    const stopHook = createSettlementStopHook({ engine: staging });

    const server = createSdkMcpServerImpl({
      name: "mnemo",
      version: "0.11.2",
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
          async (args: SettlementTurnWriteInput) => staging.stageNoteWrite(args),
        ),
        toolImpl(
          "remember",
          SETTLEMENT_REMEMBER_TOOL_DESCRIPTION,
          settlementMembershipWriteInputShape,
          async (args: SettlementMembershipWriteInput) => staging.stageMembershipWrite(args),
        ),
        toolImpl(
          "commit",
          SETTLEMENT_COMMIT_TOOL_DESCRIPTION,
          {},
          async () => staging.commit(),
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
          hooks: { Stop: [{ hooks: [stopHook] }] },
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
      // Ticket 10c: `commitMetrics` is read from the staging engine ONCE,
      // here, after the model's run has fully ended (every message drained
      // above) — never during it, and never through a tool the model could
      // call. This is what makes it safe under spec G9 (invisible to the
      // grading agent at every point in its run): the value did not exist
      // anywhere the model could observe it until this line.
      return { text: envelope, commitMetrics: staging.getLastCommitMetrics() };
    } finally {
      if (request.signal) {
        request.signal.removeEventListener("abort", forwardAbort);
      }
    }
  };
}
