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
import { createSettlementDirectWriteEngine } from "./note-settlement-direct-write";
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
 * Ticket 05 (read-write-contract spec "结算(直写改造)"): DIRECT WRITE, not
 * staged — this call validates fully right now AND lands, in this same
 * transaction, before the tool result returns. There is no `commit` left to
 * wait for a write's own durability; `commit` is repurposed by ticket 06 to
 * claim validity + a run summary + the job's terminal mark (see its own
 * description below).
 */
const SETTLEMENT_NOTE_TOOL_DESCRIPTION =
  "WRITE a CORRECTION to a turn's grade/type/tags/relations, OR this " +
  "session's narrative — lands immediately, in this same call. This is a " +
  "RE-CHECK, not a first write: the main agent already wrote every field " +
  "below for this window's turns; call this only when the Memory Rubric " +
  "says a stored value is wrong. " +
  "Exactly one of `turn` (\"S<session>/T<prompt>\", from the window or " +
  "preceding-turns section) or `session` (\"S<session>\", this session). " +
  "On `turn`: does NOT accept title/content/insight — turn prose is the " +
  "main agent's alone to write. " +
  "grade (0-4)/type/tags: only for a turn shown in this prompt (window or " +
  "preceding turns); each overwrites whole when present, omit to leave " +
  "alone — there is no append. Each field is checked and applied " +
  "INDEPENDENTLY: if another writer (the main agent's own later note, or a " +
  "prior settlement attempt) touched a field since this dispatch's context " +
  "was read, that ONE field yields (reported in the receipt, not written) " +
  "while the others still land — grade in particular is not derived from " +
  "any note, so it lands even when type/tags on the same call yield. " +
  "evidenceFor/evidenceAgainst/groundedOn/refines/override/encodes/" +
  "dependsOn: address lists — the SAME seven relations and phase-legality " +
  "validator the main agent's own `note` tool uses; a target must already " +
  "be a pair that existed before this run started AND still exist right " +
  "now, and its two ends' `type` must satisfy the relation's phase pair (a " +
  "structurally illegal pair is rejected, naming which half is missing). " +
  "Which relation, if any, is the Memory Rubric's own 关系 checklist " +
  "above — this call only enforces address/eligibility/phase shape. " +
  "On `session`: `title`/`content` only, each overwritten whole when " +
  "present (no append — compose the incremented text yourself from what " +
  "you can already see) — grade/type/tags/relations are refused.";

/**
 * The `remember` tool's settlement-side call contract — `propose` and
 * `reassign` (ticket 08) are the two legal verbs; `assign` stays dead
 * (ticket 05). Registered under the SAME tool name the main agent's own
 * `remember` uses, a settlement-specific shape, the same relationship the
 * `note` facade already has to the main agent's `note` tool.
 */
const SETTLEMENT_REMEMBER_TOOL_DESCRIPTION =
  "WRITE a text-only task proposal, OR a membership CORRECTION — lands " +
  "immediately, in this same call. action: \"propose\" or \"reassign\". " +
  "propose: addresses (one or more \"S<session>/T<prompt>\" turn " +
  "addresses — a single homeless turn may open its own proposal, or name a " +
  "cluster forming ONE coherent task) + title (a short suggested name) — " +
  "stores a text-only suggestion for the user to confirm next session. " +
  "Idempotent on the address SET (order-independent): repeating the same " +
  "set (even after a retry) matches the earlier proposal instead of " +
  "storing a second one. NEVER creates a segment and is never auto-adopted " +
  "— do not propose an incoherent grab-bag. " +
  "reassign: turns (one or more \"S<session>/T<prompt>\" addresses to " +
  "correct) + id (an \"E<n>\" CURRENTLY attached to this session) or id " +
  "omitted to clear ownership (homeless). This is a RE-CHECK, not a first " +
  "assignment — the main agent already placed these turns; correct only a " +
  "DISPLAYED mismatch. A segment not attached right now is refused, " +
  "naming it as not attached — attaching a NEW segment to this session is " +
  "the main agent's call alone. Never required — this window may finish " +
  "without ever calling this tool.";

/** Ticket 06 (spec "commit 重定位"): claim validity + a run summary + the job's terminal mark — no separate `check` tool. */
const SETTLEMENT_COMMIT_TOOL_DESCRIPTION =
  "Finish this window: verify your job lease is still valid, report what " +
  "this run actually wrote, and mark the job durably complete. Call this " +
  "once you believe the window is done — whether or not you wrote " +
  "anything; every `note`/`remember` call already landed the instant it " +
  "ran, so an empty-handed `commit` (nothing to propose or correct) is a " +
  "normal, clean finish, not a no-op to avoid. This is the ONLY way the " +
  "job itself is marked done — without it, the window is retried later " +
  "even though your writes already stand. If your job lease has been " +
  "reclaimed, commit refuses and no further commit from this run will " +
  "ever succeed — stop making tool calls.";

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
    // built ONCE at module-call time while THIS context (and the direct-
    // write engine built from it, ticket 05) must be built per request: a
    // job's identity does not exist until a request names one.
    const turnFacadeContext: SettlementTurnFacadeContext = {
      jobId: request.jobId,
      claimGeneration: request.claimGeneration,
      sessionId: request.sessionId,
      reviewableTurnIds: request.reviewableTurnIds,
      contextBuiltAtEpoch: request.contextBuiltAtEpoch,
      eligibleRelationPairKeys: request.eligibleRelationPairKeys,
      attachedSegmentIds: request.attachedSegmentIds,
    };
    const writes = createSettlementDirectWriteEngine({
      db: options.db,
      context: turnFacadeContext,
      now: options.now,
    });
    // Ticket 06 (spec "Stop hook 重实现"): per REQUEST, like the engine it
    // reads — the block count is a fact about this run's stops, and a shared
    // one would let an earlier window's stops silence a later window's
    // warning. Registered as an SDK hook rather than through
    // `hooks/hook-command.ts`: that command short-circuits to success for
    // `CLAUDE_CODE_ENTRYPOINT === "sdk-ts"`, so mnemo's file-configured hooks
    // deliberately never fire inside a spawned SDK child. Reads the job row
    // directly (jobId + claim generation) rather than through the write
    // engine — direct write means the hook's probe is "job claimed but not
    // yet done", a plain read, not a re-run of any write-side logic.
    const stopHook = createSettlementStopHook({
      db: options.db,
      jobId: request.jobId,
      claimGeneration: request.claimGeneration,
    });

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
          async (args: SettlementTurnWriteInput) => writes.writeNote(args),
        ),
        toolImpl(
          "remember",
          SETTLEMENT_REMEMBER_TOOL_DESCRIPTION,
          settlementMembershipWriteInputShape,
          async (args: SettlementMembershipWriteInput) => writes.writeMembership(args),
        ),
        toolImpl(
          "commit",
          SETTLEMENT_COMMIT_TOOL_DESCRIPTION,
          {},
          async () => writes.commit(),
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
      // Ticket 10c (carried into ticket 05's direct-write engine):
      // `commitMetrics` is read ONCE, here, after the model's run has fully
      // ended (every message drained above) — never during it, and never
      // through a tool the model could call. This is what makes it safe
      // under spec G9 (invisible to the grading agent at every point in its
      // run): the value did not exist anywhere the model could observe it
      // until this line.
      return { text: envelope, commitMetrics: writes.getLastCommitMetrics() };
    } finally {
      if (request.signal) {
        request.signal.removeEventListener("abort", forwardAbort);
      }
    }
  };
}
