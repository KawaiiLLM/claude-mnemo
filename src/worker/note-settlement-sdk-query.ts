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
  settlementSegmentWriteInputShape,
  type SettlementSegmentWriteInput,
} from "./note-settlement-segment-facade";
import { createSettlementStagingEngine } from "./note-settlement-staging";
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
  "mcp__mnemo__segment",
  "mcp__mnemo__commit",
] as const;

/**
 * Ticket 10a/10b: the restricted write facade's own description, separate
 * from `MNEMO_TOOL_DESCRIPTIONS.note` (mcp/definitions.ts) because the
 * surface really is smaller — no `skip`, no session addressing, no
 * `crossSession`, no append mode, and prose/review are each gated to a scope
 * this dispatch alone defines. The duty-level instructions (which turns are
 * holes, which are reviewable, the grading rubric) live in the settlement
 * prompt, not here — this text states the CALL contract only.
 *
 * "Staged" (spec A7): this call validates fully right now and tells you
 * exactly what it found, but nothing reaches a stored row until you call
 * `commit`.
 */
const SETTLEMENT_NOTE_TOOL_DESCRIPTION =
  "STAGE one turn's reconstruction note and/or its grade/type/tags/relations " +
  "— validated now, written only when you call `commit`. `turn`: " +
  "\"S<session>/T<prompt>\", from the window or preceding-turns section " +
  "below — this is also this call's KEY: staging the same turn again " +
  "REPLACES what you staged for it before, so a lost-receipt retry or a " +
  "same-run correction is just another call, not a new problem. " +
  "title/content/insight: all three together, only for a turn this window " +
  "lists as owing a note (insight may be null, but must be named). grade " +
  "(0-4, against the rubric)/type/tags: only for a turn shown in this " +
  "prompt (window or preceding turns); each overwrites whole when present, " +
  "omit to leave alone — there is no append. " +
  "evidenceFor/evidenceAgainst/supersedes/dependsOn: address lists; a target " +
  "must already be a pair that existed before this run started AND still " +
  "exist when `commit` lands it — you cannot license a relation on a pair a " +
  "call earlier in this SAME run just created, or on one the main agent has " +
  "since stopped citing.";

/** Ticket 10b/10d (spec A7/A3-amended, A7a): the segment tool's call contract. */
const SETTLEMENT_SEGMENT_TOOL_DESCRIPTION =
  "STAGE a segment write — create a new chapter, extend an open one, or " +
  "record that a turn belongs to no segment — validated now, written only " +
  "when you call `commit`. action: \"create\", \"extend\" or \"exclude\". " +
  "create: title (required), handle (required — a short id YOU choose, " +
  "e.g. \"lease-fencing\"; letters/digits/hyphens/underscores only; this is " +
  "this call's KEY, so re-staging the same handle REPLACES this create " +
  "rather than minting a second one), noCandidateReason (required — what " +
  "you searched in the topic registry and open segments, and why nothing " +
  "fit), topic/topicAliases/content/insight/status/members (optional). " +
  "extend: segmentId + expectedRevision naming an already-existing, OPEN " +
  "segment (this is this call's KEY — re-staging the same segmentId " +
  "replaces the earlier call; a handle from THIS run can never be an " +
  "extend target — it has no real id yet, use it only as a citation, see " +
  "below); every other field overwrites whole when present, omit to leave " +
  "alone. exclude: turn (\"S<session>/T<prompt>\", also this call's KEY) — " +
  "records that this turn was reviewed and belongs to no segment; use it " +
  "for a turn that genuinely fits no chapter, instead of inventing one. " +
  "members: \"S<session>/T<prompt>\" turn addresses (never a handle — a " +
  "member is always a turn); an address that does not resolve is dropped, " +
  "not a failure of the call. This tool takes NO type and NO tags (spec " +
  "K5a): both are derived from the members — type is the union of their " +
  "activities, tags are their tags ordered by frequency — and a call that " +
  "names either is refused. insight: the arc's most reusable conclusion, " +
  "including the routes ruled out and why. Cite member turns inline in " +
  "content or insight as " +
  "[S<session>/T<prompt>] and other segments as [E<n>] — those citations " +
  "become the segment's anchors automatically, no separate step; an address " +
  "that does not resolve is likewise dropped and reported, not a failure. A " +
  "successful create's receipt states its handle as \"E#<handle>\", scoped " +
  "to THIS run only — cite it as [E#<handle>] in a LATER segment's content or insight " +
  "to refer to the segment you just created before it has a real id (never " +
  "in members, never as an extend target); `commit` resolves every handle " +
  "to a real id, in the order you staged them.";

/** Ticket 10b (spec A7): the completion gate exposed as commit's own precondition — settlement gets no separate `check` tool (spec G8 amended). */
const SETTLEMENT_COMMIT_TOOL_DESCRIPTION =
  "Land every staged `note`/`segment` write in one transaction, THEN check " +
  "this window is complete (every eligible turn typed or skipped, every one " +
  "segmented or explicitly excluded, no turn still owing a note). Call this " +
  "once you believe the window is done — it is the only way any of your " +
  "work becomes durable. If the window is not actually complete, this " +
  "tells you exactly what is still missing; every staged write is kept, so " +
  "you fill the gap with more `note`/`segment` calls and call `commit` " +
  "again. If instead a specific staged call has gone stale (the world " +
  "moved under it — a revision, a relation pair the main agent stopped " +
  "citing, ...), re-stage that SAME key with corrected input — that " +
  "replaces the stale entry — and call `commit` again; blindly retrying " +
  "the same input will fail the same way. If your job lease has been " +
  "reclaimed, no commit from this run will ever succeed again — stop " +
  "making tool calls.";

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
    // model supplied. `settlementTurnWriteInputShape`/`settlementSegmentWriteInputShape`
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
      reconstructableTurnIds: request.reconstructableTurnIds,
      reviewableTurnIds: request.reviewableTurnIds,
      exposedSegmentIds: request.exposedSegmentIds,
      contextBuiltAtEpoch: request.contextBuiltAtEpoch,
      rideTurnId: request.rideTurnId,
      writerModel: request.writerModel,
      eligibleRelationPairKeys: request.eligibleRelationPairKeys,
    };
    const staging = createSettlementStagingEngine({
      db: options.db,
      context: turnFacadeContext,
      now: options.now,
    });

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
          async (args: SettlementTurnWriteInput) => staging.stageNoteWrite(args),
        ),
        toolImpl(
          "segment",
          SETTLEMENT_SEGMENT_TOOL_DESCRIPTION,
          settlementSegmentWriteInputShape,
          async (args: SettlementSegmentWriteInput) => staging.stageSegmentWrite(args),
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
