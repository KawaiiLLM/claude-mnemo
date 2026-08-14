import type { Database } from "bun:sqlite";

import type { NoteSettlementJob } from "../db/note-settlement";
import type { MnemoConfig } from "../shared/config";
import { DEFAULT_CONFIG } from "../shared/config";
import { SIGNIFICANCE_TARGET_SHARES } from "../task-causality-rubric";
import {
  buildNoteSettlementContext,
  type NoteSettlementContext,
} from "./note-settlement-context";
import {
  NOTE_SETTLEMENT_SYSTEM_PROMPT,
  renderNoteSettlementPrompt,
} from "./note-settlement-prompt";
import {
  parseNoteSettlementResponse,
  type SettlementSegmentDirective,
} from "./note-settlement-response";
import {
  applyNoteSettlementSegmentReplay,
  applyNoteSettlementWriteBack,
  type NoteSettlementSegmentConflict,
  type NoteSettlementWriteBackCounts,
} from "./note-settlement-writeback";
import type {
  NoteSettlementDispatch,
  NoteSettlementDispatchOutcome,
} from "./note-settlement";

/**
 * The real settlement payload (spec D9, ticket 07): assemble the window's
 * context, run ONE stateless Sonnet call in a subprocess, and land the result in
 * a single transaction.
 *
 * It plugs into ticket 05's dispatch seam unchanged — `(job) => verdict` — so
 * every scheduling property (lease, generation fence, backoff, cursor) stays
 * exactly where it was proved. What this module adds is the payload, and its
 * only contract with the machine is the verdict it returns: `ok:false` means the
 * window is unsettled and may be retried, `ok:true` means the window's effects
 * are already durable.
 */

/** Spec D9: settlement runs on Sonnet, by user decision (裁决 10). */
export const NOTE_SETTLEMENT_MODEL = "claude-sonnet-5";

export interface NoteSettlementQueryRequest {
  prompt: string;
  systemPrompt: string;
  model: string;
  signal?: AbortSignal;
}

/**
 * The subprocess boundary. The worker hosts no model in-process (D10), so this
 * is always a spawned child; it is injectable so tests stub it and never reach
 * a network.
 */
export type NoteSettlementQuery = (
  request: NoteSettlementQueryRequest,
) => Promise<string>;

export interface NoteSettlementWindowMetrics
  extends NoteSettlementWriteBackCounts {
  jobId: number;
  sessionId: number;
  windowStart: number;
  windowEnd: number;
  triggerType: NoteSettlementJob["triggerType"];
  windowTurns: number;
  interiorHoles: number;
  /** Segments whose write lost the revision CAS and were replayed. */
  casConflicts: number;
  casReplaysApplied: number;
  /**
   * D13's drift-is-a-comparison-not-an-investigation ask: the standing
   * calibration targets ride every line beside the actual histogram
   * (`gradeHistogram`, inherited from `NoteSettlementWriteBackCounts`), so a
   * reader scanning the log does not have to open `task-causality-rubric.ts`
   * to know what "too many 3s" means. Imported, never restated.
   */
  gradeTargets: typeof SIGNIFICANCE_TARGET_SHARES;
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
  /** Replay rounds per conflicted segment. One is enough in practice. */
  maxReplayRounds?: number;
  logger?: NoteSettlementDispatchLogger;
}

/**
 * The worker's logger exposes `info` where `console` exposes `log`; the metrics
 * line goes to whichever is present, so the same dispatch works under both.
 */
export type NoteSettlementDispatchLogger = Pick<Console, "warn" | "error"> &
  Partial<Pick<Console, "log" | "info">>;

/**
 * Spec D9's naming-drift alarm: how many topics a window MINTED rather than
 * reused. Emitted as one structured line so the metrics side can read it
 * without a schema, and so a run that mints on every window is visible in the
 * log before it is visible in the topic table.
 */
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

function renderReplayPrompt(
  context: NoteSettlementContext,
  conflict: NoteSettlementSegmentConflict,
): string {
  const latest = conflict.excluded.latest;
  return [
    `# Segment [E${conflict.directive.segmentId}] changed while you were settling S${context.job.sessionId}/T${context.job.windowStart}-T${context.job.windowEnd}`,
    "",
    "Another settlement rewrote this open segment. Your version was not " +
      "applied. Re-decide the segment body against the version that is stored " +
      "now, keeping whatever the other pass added and folding in what this " +
      "window contributes. Same writing discipline: conclusion first, cite " +
      "member turns as [S<session>/T<prompt>].",
    "",
    "## Stored now",
    "",
    latest
      ? [
          `revision: ${latest.revision}`,
          `title: ${latest.title}`,
          `content: ${latest.content ?? ""}`,
          `type: ${latest.type.join(",")}`,
          `tags: ${latest.tags.join(",")}`,
          `status: ${latest.status}`,
        ].join("\n")
      : `(the segment no longer exists: ${conflict.excluded.reason})`,
    "",
    "## What this window wanted to write",
    "",
    [
      `title: ${conflict.directive.title}`,
      `content: ${conflict.directive.content}`,
      `type: ${conflict.directive.type.join(",")}`,
      `tags: ${conflict.directive.tags.join(",")}`,
      `status: ${conflict.directive.status}`,
      `members: ${conflict.directive.members.join(", ")}`,
    ].join("\n"),
    "",
    "## Output",
    "",
    "Reply with one JSON object and nothing else, containing a single " +
      "`segments` entry for this segment:",
    "",
    `{"segments":[{"action":"extend","segment_id":${conflict.directive.segmentId},` +
      `"expected_revision":${latest?.revision ?? conflict.directive.expectedRevision},` +
      `"title":"...","content":"...","type":["..."],"tags":["..."],` +
      `"status":"open","members":["S1/T2"]}]}`,
  ].join("\n");
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
  const maxReplayRounds = options.maxReplayRounds ?? 1;

  async function replayConflicts(
    context: NoteSettlementContext,
    conflicts: readonly NoteSettlementSegmentConflict[],
    nowEpoch: number,
  ): Promise<number> {
    let applied = 0;
    for (const conflict of conflicts) {
      const latest = conflict.excluded.latest;
      if (!latest || latest.status !== "open" || maxReplayRounds < 1) {
        // A frozen or deleted segment is not a conflict to replay: D6 overturns
        // a closed segment with an edge, never by rewriting it.
        logger.warn?.(
          `${NOTE_SETTLEMENT_METRICS_PREFIX}: segment ${conflict.directive.segmentId} not replayable (${conflict.excluded.reason})`,
        );
        continue;
      }

      let directive: SettlementSegmentDirective = conflict.directive;
      let raw: string;
      try {
        raw = await options.runQuery({
          prompt: renderReplayPrompt(context, conflict),
          systemPrompt: NOTE_SETTLEMENT_SYSTEM_PROMPT,
          model,
        });
      } catch (error) {
        logger.warn?.(
          `${NOTE_SETTLEMENT_METRICS_PREFIX}: segment replay call failed for ${conflict.directive.segmentId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        continue;
      }

      const parsed = parseNoteSettlementResponse(raw);
      if (!parsed.ok || parsed.response.segments.length === 0) {
        logger.warn?.(
          `${NOTE_SETTLEMENT_METRICS_PREFIX}: segment replay output rejected for ${conflict.directive.segmentId}`,
        );
        continue;
      }
      directive = parsed.response.segments[0]!;

      const result = applyNoteSettlementSegmentReplay(db, {
        job: context.job,
        segmentId: conflict.directive.segmentId!,
        expectedRevision: directive.expectedRevision ?? latest.revision,
        title: directive.title,
        content: directive.content,
        type: directive.type,
        tags: directive.tags,
        status: directive.status,
        memberTokens: directive.members,
        exposedSegmentIds: context.exposedSegmentIds,
        nowEpoch,
        logger,
      });
      if (result.applied) {
        applied += 1;
      } else {
        logger.warn?.(
          `${NOTE_SETTLEMENT_METRICS_PREFIX}: segment replay not applied for ${conflict.directive.segmentId} (${result.reason})`,
        );
      }
    }
    return applied;
  }

  return async ({ job }): Promise<NoteSettlementDispatchOutcome> => {
    if (!config.settlementEnabled) {
      return { ok: false, reason: "note settlement is disabled" };
    }

    const nowEpoch = now();
    const context = buildNoteSettlementContext(db, job, { nowEpoch });
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

    let raw: string;
    try {
      raw = await options.runQuery({
        prompt: renderNoteSettlementPrompt(context),
        systemPrompt: NOTE_SETTLEMENT_SYSTEM_PROMPT,
        model,
      });
    } catch (error) {
      return {
        ok: false,
        reason: `note settlement call failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    const parsed = parseNoteSettlementResponse(raw);
    if (!parsed.ok) {
      return { ok: false, reason: parsed.reason };
    }

    const rideTurnId =
      context.windowTurns[context.windowTurns.length - 1]?.turnId ?? null;
    const result = applyNoteSettlementWriteBack(db, {
      job,
      response: parsed.response,
      nowEpoch,
      reconstructableTurnIds: new Set(
        context.interiorHoles.map((turn) => turn.turnId),
      ),
      exposedSegmentIds: context.exposedSegmentIds,
      reviewableTurnIds: context.reviewableTurnIds,
      contextBuiltAtEpoch: context.builtAtEpoch,
      rideTurnId,
      writerModel: options.writerModel ?? model,
      logger,
    });

    if (!result.committed) {
      return {
        ok: false,
        reason: result.reason ?? "note settlement write-back was discarded",
      };
    }

    const casReplaysApplied = await replayConflicts(
      context,
      result.conflicts,
      nowEpoch,
    );

    metrics({
      jobId: job.id,
      sessionId: job.sessionId,
      windowStart: job.windowStart,
      windowEnd: job.windowEnd,
      triggerType: job.triggerType,
      windowTurns: context.windowTurns.length,
      interiorHoles: context.interiorHoles.length,
      casConflicts: result.conflicts.length,
      casReplaysApplied,
      gradeTargets: SIGNIFICANCE_TARGET_SHARES,
      turnsReviewed: result.turnsReviewed,
      gradeHistogram: result.gradeHistogram,
      reviewsYieldedToLateNote: result.reviewsYieldedToLateNote,
      segmentsCreated: result.segmentsCreated,
      segmentsExtended: result.segmentsExtended,
      topicsMinted: result.topicsMinted,
      topicsReused: result.topicsReused,
      membersAdded: result.membersAdded,
      anchorEdges: result.anchorEdges,
      judgedEdges: result.judgedEdges,
      rejectedReferences: result.rejectedReferences,
      notesReconstructed: result.notesReconstructed,
      notesRejected: result.notesRejected,
      notesYielded: result.notesYielded,
      summaryUpdated: result.summaryUpdated,
    });

    return { ok: true };
  };
}
