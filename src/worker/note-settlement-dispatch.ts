import type { Database } from "bun:sqlite";

import { getExistingEdgePairKeys } from "../db/memory-edges";
import { getNoteSettlementJob, type NoteSettlementJob } from "../db/note-settlement";
import type { MnemoConfig } from "../shared/config";
import { DEFAULT_CONFIG } from "../shared/config";
import {
  buildNoteSettlementContext,
  type NoteSettlementContext,
} from "./note-settlement-context";
import {
  NOTE_SETTLEMENT_SYSTEM_PROMPT,
  renderNoteSettlementPrompt,
} from "./note-settlement-prompt";
import type {
  NoteSettlementDispatch,
  NoteSettlementDispatchOutcome,
} from "./note-settlement";

/**
 * The real settlement payload (spec D9, ticket 07; staged by ticket 10b,
 * spec A7): assemble the window's context, run ONE stateless Sonnet call in
 * a subprocess against the staged write tools (`note`/`segment`/`commit`,
 * note-settlement-sdk-query.ts), and read back whatever the run actually
 * landed.
 *
 * It plugs into ticket 05's dispatch seam unchanged — `(job) => verdict` — so
 * every scheduling property (lease, generation fence, backoff, cursor) stays
 * exactly where it was proved. What this module adds is the payload, and its
 * only contract with the machine is the verdict it returns: `ok:false` means the
 * window is unsettled and may be retried, `ok:true` means the window's effects
 * are already durable.
 *
 * TICKET 10B'S CHANGE (spec A7 requirement 9 — "the dispatch stops routing
 * through the write-back"): this module used to parse the model's final
 * reply as a structured envelope and apply it in one write-back transaction
 * (`note-settlement-response.ts`/`note-settlement-writeback.ts`). Neither is
 * called here any more, and this module reads no envelope of any kind — the
 * settlement agent's WORK now lands as it happens, one staged tool call at a
 * time, and durability is decided entirely by whether the agent's own
 * `commit` call succeeded (note-settlement-staging.ts), inside the
 * subprocess. This function's whole job after `runQuery` returns is to look:
 * `commit`'s completion gate is the ONLY path that can move a job to `done`
 * (requirement 9), so re-reading the job row is a complete answer to "did
 * this run settle its window" — no parsing, no reconciliation, no replay.
 * `note-settlement-writeback.ts`/`note-settlement-response.ts` are left in
 * place, unreached (ticket 10c deletes them, deliberately, in its own
 * change, on expand-contract) — nothing in this file imports them any more.
 */

/** Spec D9: settlement runs on Sonnet, by user decision (裁决 10). */
export const NOTE_SETTLEMENT_MODEL = "claude-sonnet-5";

export interface NoteSettlementQueryRequest {
  prompt: string;
  systemPrompt: string;
  model: string;
  signal?: AbortSignal;
  /**
   * Job identity and the write facades' per-dispatch scope (ticket 10a/10b,
   * spec G6). Carried on the REQUEST rather than closed over at
   * `createNoteSettlementDispatch` construction time, because a job (and its
   * reconstructable/reviewable/exposed scope) exists only per call — one
   * dispatch instance serves every window a session ever produces. The SDK
   * query layer (note-settlement-sdk-query.ts) is what actually keeps these
   * out of the model's reach, by injecting them into a staging-engine
   * closure the model's own tool input schemas have no field for.
   */
  jobId: number;
  claimGeneration: number;
  sessionId: number;
  reconstructableTurnIds: ReadonlySet<number>;
  reviewableTurnIds: ReadonlySet<number>;
  /** Open segment ids this dispatch's prompt shows — the scope `segment`'s `extend` may address (ticket 10b). */
  exposedSegmentIds: ReadonlySet<number>;
  contextBuiltAtEpoch: number;
  rideTurnId: number | null;
  writerModel: string | null;
  /** Relation eligibility, snapshotted ONCE before this call's model run starts (spec C7, requirement 4). */
  eligibleRelationPairKeys: ReadonlySet<string>;
}

/**
 * The subprocess boundary. The worker hosts no model in-process (D10), so this
 * is always a spawned child; it is injectable so tests stub it and never reach
 * a network.
 *
 * The returned string is whatever final text the model produced after its
 * tool calls — no longer a structured envelope this module parses (ticket
 * 10b). It is not inspected for correctness; `commit`'s own effect on the
 * job row is.
 */
export type NoteSettlementQuery = (
  request: NoteSettlementQueryRequest,
) => Promise<string>;

export interface NoteSettlementWindowMetrics {
  jobId: number;
  sessionId: number;
  windowStart: number;
  windowEnd: number;
  triggerType: NoteSettlementJob["triggerType"];
  windowTurns: number;
  interiorHoles: number;
  /** Did the run's own `commit` call land the window (job status read back `done`)? */
  committed: boolean;
}

export type NoteSettlementMetricsSink = (
  metrics: NoteSettlementWindowMetrics,
) => void;

export interface CreateNoteSettlementDispatchOptions {
  db: Database;
  runQuery: NoteSettlementQuery;
  config?: MnemoConfig;
  /** Epoch seconds. */
  now?: () => number;
  model?: string;
  writerModel?: string | null;
  metrics?: NoteSettlementMetricsSink;
  logger?: NoteSettlementDispatchLogger;
}

/**
 * The worker's logger exposes `info` where `console` exposes `log`; the metrics
 * line goes to whichever is present, so the same dispatch works under both.
 */
export type NoteSettlementDispatchLogger = Pick<Console, "warn" | "error"> &
  Partial<Pick<Console, "log" | "info">>;

export const NOTE_SETTLEMENT_METRICS_PREFIX = "[claude-mnemo] note-settlement";

export function defaultNoteSettlementMetricsSink(
  logger: Partial<Pick<Console, "log" | "info">> = console,
): NoteSettlementMetricsSink {
  return (metrics) => {
    const line = `${NOTE_SETTLEMENT_METRICS_PREFIX} ${JSON.stringify(metrics)}`;
    if (logger.info) {
      logger.info(line);
      return;
    }
    logger.log?.(line);
  };
}

export function createNoteSettlementDispatch(
  options: CreateNoteSettlementDispatchOptions,
): NoteSettlementDispatch {
  const db = options.db;
  const config = options.config ?? DEFAULT_CONFIG;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const model = options.model ?? NOTE_SETTLEMENT_MODEL;
  const logger = options.logger ?? console;
  const metrics = options.metrics ?? defaultNoteSettlementMetricsSink(logger);

  return async ({ job }): Promise<NoteSettlementDispatchOutcome> => {
    if (!config.settlementEnabled) {
      return { ok: false, reason: "note settlement is disabled" };
    }

    const nowEpoch = now();
    const context: NoteSettlementContext | null = buildNoteSettlementContext(db, job, {
      nowEpoch,
    });
    if (!context) {
      return {
        ok: false,
        reason: `note settlement window has no session ${job.sessionId}`,
      };
    }
    if (context.windowTurns.length === 0) {
      // Nothing to settle — a window whose turns were deleted. Resolving it as
      // done is what lets the cursor walk past it instead of retrying forever.
      return { ok: true };
    }

    const rideTurnId =
      context.windowTurns[context.windowTurns.length - 1]?.turnId ?? null;
    // Requirement 4 (spec C7/C14): taken ONCE, here, before the model run
    // starts — not inside each tool call's own transaction. A pair this
    // dispatch's own tool calls mint during the run must stay ineligible for
    // a relation for the REST of the run, which only holds if every call
    // shares one frozen snapshot rather than each re-reading the table fresh.
    const eligibleRelationPairKeys = getExistingEdgePairKeys(db);

    try {
      await options.runQuery({
        prompt: renderNoteSettlementPrompt(context),
        systemPrompt: NOTE_SETTLEMENT_SYSTEM_PROMPT,
        model,
        jobId: job.id,
        claimGeneration: job.claimGeneration,
        sessionId: job.sessionId,
        reconstructableTurnIds: new Set(
          context.interiorHoles.map((turn) => turn.turnId),
        ),
        reviewableTurnIds: context.reviewableTurnIds,
        exposedSegmentIds: context.exposedSegmentIds,
        contextBuiltAtEpoch: context.builtAtEpoch,
        rideTurnId,
        writerModel: options.writerModel ?? model,
        eligibleRelationPairKeys,
      });
    } catch (error) {
      return {
        ok: false,
        reason: `note settlement call failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    // Requirement 9: `commit` (inside the subprocess, note-settlement-
    // staging.ts) is the ONLY path that can move this job to `done` — there
    // is no envelope here to parse and no write-back transaction to apply.
    // Re-reading the row is a COMPLETE answer to "did this run settle its
    // window": `commit`'s completion gate runs under the same ownership
    // fence a stale attempt would fail, so a `done` read here can only be
    // this run's own doing or a strictly newer one's — either way the
    // scheduler's own post-hoc reconciliation (worker/note-settlement.ts)
    // is what tells those two apart, exactly as it already does for the
    // "payload settles its own window" case that predates this ticket.
    const settled = getNoteSettlementJob(db, job.id);
    const committed = settled?.status === "done";

    metrics({
      jobId: job.id,
      sessionId: job.sessionId,
      windowStart: job.windowStart,
      windowEnd: job.windowEnd,
      triggerType: job.triggerType,
      windowTurns: context.windowTurns.length,
      interiorHoles: context.interiorHoles.length,
      committed,
    });

    if (!committed) {
      return {
        ok: false,
        reason: `note settlement run ended without a successful commit (job status: ${settled?.status ?? "missing"})`,
      };
    }
    return { ok: true };
  };
}
