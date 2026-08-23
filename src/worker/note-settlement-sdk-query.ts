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
import { loadLaneCheckScope } from "../db/lane-checker-load";
import { checkLanes } from "../shared/lane-checker";
import { renderLaneCheckerReports } from "../shared/lane-checker-render";
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
  "mcp__mnemo__lane_check",
] as const;

/**
 * The settlement write facade's own description, separate from
 * `MNEMO_TOOL_DESCRIPTIONS.note` (mcp/definitions.ts) because the CALL
 * CONTRACT differs in three narrow ways: no `skip`, no `crossSession`, the
 * session address the main tool no longer has (ticket 09), and a write scope
 * this dispatch alone defines (the rendered window). Ticket 04
 * (edge-mechanism-revision D6) removed the two differences that used to
 * dominate this text — turn prose is settlement's again, and an edge no longer
 * needs a pre-existing pair. The MODE vocabulary is NOT part of that
 * difference any more (ticket 07, spec D12): `write`/`edit` mean here exactly
 * what they mean on the main agent's own `note`, out of the same engine
 * (`mcp/field-mode.ts`), so this text describes them in the same words rather
 * than describing settlement as the surface that lacks them.
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
export const SETTLEMENT_NOTE_TOOL_DESCRIPTION =
  "WRITE a turn's note, type/tags or edges, OR this " +
  "session's narrative — lands immediately, in this same call. Hindsight " +
  "work: supply what is missing, correct what is wrong, retract what is " +
  "false, judged by the Memory Rubric in the prompt. " +
  "Exactly one of `turn` (\"S<session>/T<prompt>\", from the window or " +
  "preceding-turns section) or `session` (\"S<session>\", this session). " +
  "On `turn`: title/content/insight, type/tags and the edge fields, only " +
  "for a turn shown in this prompt; omit to leave alone. A first note for a " +
  "turn needs title and content together. A field that already holds " +
  "something needs `mode.<field>: \"write\"` (the full replacement text or " +
  "set) or the edit form `{ mode: \"edit\", oldString, newString }` for one " +
  "exactly-matched span — the same rule, and the same words, the main " +
  "agent's own `note` uses; a whole-field `write` over text this prompt " +
  "showed only truncated is refused, and the edit form is the way through. " +
  "Each field is checked and applied " +
  "INDEPENDENTLY: if another writer (the main agent's own later note, or a " +
  "prior settlement attempt) touched a field since this dispatch's context " +
  "was read, that ONE field yields (reported in the receipt, not written) " +
  "while the other still lands. " +
  "override/narrows/extends/indexes/consume/grounds/verifies/refutes: " +
  "address lists — the SAME eight relations and legality validator the main " +
  "agent's own `note` tool uses. Each entry is a bare address (untagged — " +
  "acts on the cited turn itself) or `{turn, tags}` (acts on that lane " +
  "instead); every tag must already be on both this turn's and the " +
  "target's own tags. An edge stands on its own: no prose citation, no " +
  "pre-existing link between the two turns, and one pair may carry several " +
  "relations at once; a structurally illegal call (wrong phase, an illegal " +
  "tag, an illegal self-citation) is rejected, naming what is missing. " +
  "Each has a retract… mirror (retractOverride …) that deletes that edge; " +
  "an address carrying no such edge rejects the call, naming it, and " +
  "nothing is deleted. Which relation, if any, is the Memory Rubric's own " +
  "vocabulary above — this call only enforces phase domains, tag legality " +
  "and the self-citation gate. " +
  "On `session`: `title`/`content` only — type/tags/edges are refused. " +
  "A field that already holds something needs `mode.<field>`: \"write\" " +
  "replaces it whole (supply the finished text), or the edit form " +
  "`{ mode: \"edit\", oldString, newString }` swaps one exactly-matched span " +
  "inside it (`oldString` must match exactly once; add to the end by " +
  "anchoring on the current last line and putting that line plus your new " +
  "text in `newString`). With the edit form the field's own value is not " +
  "also supplied — the new text belongs in `newString`.";

/**
 * The `remember` tool's settlement-side call contract — `propose` (ticket 05),
 * `reassign` (ticket 08) and `create` (ticket 04, edge-mechanism-revision D6)
 * are the legal verbs; `assign` stays dead (ticket 05). Registered under the
 * SAME tool name the main agent's own `remember` uses, a settlement-specific
 * shape, the same relationship the `note` facade already has to the main
 * agent's `note` tool.
 */
const SETTLEMENT_REMEMBER_TOOL_DESCRIPTION =
  "WRITE a text-only task proposal, a membership correction, or a new " +
  "segment — lands immediately, in this same call. action: \"propose\", " +
  "\"reassign\" or \"create\". " +
  "propose: addresses (one or more \"S<session>/T<prompt>\" turn " +
  "addresses — a single homeless turn may open its own proposal, or name a " +
  "cluster forming ONE coherent task) + title (a short suggested name) — " +
  "stores a text-only suggestion for the user to confirm next session. " +
  "Idempotent on the address SET (order-independent): repeating the same " +
  "set (even after a retry) matches the earlier proposal instead of " +
  "storing a second one. NEVER creates a segment and is never auto-adopted " +
  "— do not propose an incoherent grab-bag. " +
  "reassign: turns (one or more \"S<session>/T<prompt>\" addresses to " +
  "correct) + id (any OPEN \"E<n>\", on this session's roster or not — a " +
  "turn's right home is often a segment this session never attached) or id " +
  "omitted to clear ownership (homeless). Correct a DISPLAYED mismatch; a " +
  "closed segment, or an id naming nothing, is refused. " +
  "create: title (the new segment's own name, written for the task's actual " +
  "shape) + optional turns to seed as its members. The segment is attached " +
  "to this session, so the next window sees it on the roster — check that " +
  "roster first: joining an existing segment beats minting a new one. " +
  "Never required — this window may finish without ever calling this tool.";

/**
 * rubric-v10 ticket 06 (spec "settlement agent (v2 duty)"): the four-report
 * lane checker, wired through the SAME `shared/lane-checker.ts` core the CLI
 * renders (`scripts/lane-check.ts`) — no digraph, and no parameters: the
 * scope is always this dispatch's own window (`request.sessionId` +
 * `windowStart`/`windowEnd`), never a range the model could name itself, so
 * there is nothing for it to get wrong here. Advisory only (spec: "findings
 * enter the agent's EXISTING supply/correct/propose judgment... never an
 * automatic write obligation") — this tool computes and reports, it never
 * writes.
 */
const SETTLEMENT_LANE_CHECK_TOOL_DESCRIPTION =
  "Run the lane checker over THIS window's own scope (no parameters) and " +
  "return its four reports as compact numbers and names — never a digraph, " +
  "never a write. Report 1: per-lane statistics (members, edge counts, a " +
  "closed-valid/closed-invalid/open state, who cites a member from outside " +
  "— grounds, consume-class use, or testimony; a lane cited only by " +
  "consume is still ADOPTED, not unused). Report 2: whether " +
  "each lane's members sit in one connected component (severed if not). " +
  "Report 3: components several lanes' members share. Report 4, three " +
  "blocks: inter-lane interface counts with terminus-bypass edges; " +
  "start-to-terminus path counts, plain and folded across cross-phase " +
  "citations (facts, no target); time-order violations (an edge citing " +
  "the future). Also a vocabulary-conformance block: turns in scope whose " +
  "type is empty or carries a word outside the closed activity vocabulary " +
  "(phase-empty, nearly edge-illegal), and edges whose relation lies " +
  "outside the eight-word relation vocabulary (e.g. the frozen-legacy " +
  "supersedes) — reported only, never folded into any other report's " +
  "counts. Treat a finding as a CANDIDATE for the same supply/correct/ " +
  "propose judgment every other duty above uses — never call this more " +
  "than once, and never let its output alone justify a write without the " +
  "usual Memory Rubric judgment.";

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

    // Ticket 06: read ONCE, after the model's run has fully ended (below,
    // mirroring `getLastCommitMetrics`'s own "the model never sees this
    // value" discipline) — a plain per-request flag, never exposed as a
    // tool result itself, just whether the call ever happened.
    let laneCheckCalled = false;

    const server = createSdkMcpServerImpl({
      name: "mnemo",
      version: "0.17.0",
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
        toolImpl(
          "lane_check",
          SETTLEMENT_LANE_CHECK_TOOL_DESCRIPTION,
          {},
          async () => {
            laneCheckCalled = true;
            const projection = loadLaneCheckScope(options.db, {
              kind: "range",
              sessionId: request.sessionId,
              promptStart: request.windowStart,
              promptEnd: request.windowEnd,
            });
            const result = checkLanes(projection.turns, projection.edges, projection.outOfVocabularyEdges);
            return textResult(renderLaneCheckerReports(result));
          },
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
      return {
        text: envelope,
        commitMetrics: writes.getLastCommitMetrics(),
        laneCheckCalled,
      };
    } finally {
      if (request.signal) {
        request.signal.removeEventListener("abort", forwardAbort);
      }
    }
  };
}
