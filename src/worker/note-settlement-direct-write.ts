import type { Database } from "bun:sqlite";

import { runWriteTransaction } from "../db/database";
import {
  assertNoteSettlementJobClaimed,
  completeNoteSettlementJobIfSegmentedCore,
  NoteSettlementJobFenceError,
} from "../db/note-settlement-completion";
import {
  evaluateSettlementMembershipWrite,
  renderSettlementMembershipWriteReceipt,
  type SettlementMembershipWriteInput,
  type SettlementMembershipWriteOutcome,
} from "./note-settlement-membership-facade";
import {
  evaluateSettlementTurnWrite,
  renderSettlementTurnWriteReceipt,
  type SettlementTurnFacadeContext,
  type SettlementTurnWriteInput,
  type SettlementTurnWriteOutcome,
} from "./note-settlement-turn-facade";

/**
 * The settlement direct-write engine (ticket 05, read-write-contract spec
 * "结算(直写改造)") — what REPLACES `note-settlement-staging.ts`'s wiring
 * role. `note-settlement-sdk-query.ts` registers this module's three
 * functions under the `note`/`remember`/`commit` tool names.
 *
 * Every `note`/`remember` call now VALIDATES and LANDS in the SAME
 * transaction, immediately: `evaluateSettlementTurnWrite`/
 * `evaluateSettlementMembershipWrite` already run every read unconditionally
 * and gate every write behind `options.apply` (spec A7's own split, kept
 * because it is still a genuine dry-run boundary, not because anything
 * stages through it any more) — this engine simply always calls them with
 * `apply: true` and returns the receipt as a FACT ("Landed", never
 * "Staged... pending commit"). There is no in-memory staged list, no replay,
 * and therefore no "refused commit, staging kept, re-stage and retry" story:
 * a rejected call is rejected right there, and a landed one is already
 * durable before the tool result returns.
 *
 * `commit` is repurposed by ticket 06 (spec "commit 重定位") to three things
 * only: claim validity (the SAME fence `evaluateSettlementTurnWrite`'s
 * writer identity already leans on for staleness, checked here as the
 * job-level CAS `completeNoteSettlementJobIfSegmentedCore` already was),
 * this run's own write counts (accumulated as each call lands, never
 * replayed), and the terminal mark. It does NOT judge duty coverage — an
 * empty-handed window (nothing staged... nothing WRITTEN, now) completes
 * exactly as cleanly as one that corrected everything the rubric found
 * wrong, because `completeNoteSettlementJobIfSegmentedCore` has been an
 * empty shell (fence + CAS only) since ticket 05 of the ownership-and-
 * note-cadence spec — see that function's own doc comment
 * (db/note-settlement-completion.ts).
 *
 * Per-write lease fencing is DELIBERATELY absent (pinned decision: "claim
 * 栅栏不再需要独立的逐写检查"). A lapsed claimant's writes are fenced out
 * field-by-field, as the NEW claimant's own writes land and go stale under
 * it — see `note-settlement-turn-facade.ts`'s write-gate integration. Only
 * `commit` itself still checks job-level claim validity, once, at the very
 * end of a run.
 */

export interface NoteSettlementCommitCounts {
  /** Turns a `note` call actually carried a review (grade/type/tags) for, landed or with at least one field yielded. */
  turnsReviewed: number;
  /** Of `turnsReviewed`, how many had at least one field (grade/type/tags) rejected by the write gate as stale/never-read. */
  reviewsYieldedToLateNote: number;
  /** Indexed 0-4 (the task-causality scale). Counted only for a LANDED grade — a grade the gate itself rejected never reached a stored row. Operator-only (spec G9): read by note-settlement-dispatch.ts ONLY after the model's run has fully ended. */
  gradeHistogram: number[];
  relationsWritten: number;
  /** A `propose` call that landed a NEW stored proposal — a duplicate that matched an earlier one (spec "propose 携幂等键") is not counted again. */
  proposalsCreated: number;
  /** A `session`-addressed `note` call that landed (title and/or content). */
  sessionNarrativeWritten: number;
  /** A `reassign` call that landed a membership correction. */
  membersReassigned: number;
}

function emptyCommitCounts(): NoteSettlementCommitCounts {
  return {
    turnsReviewed: 0,
    reviewsYieldedToLateNote: 0,
    gradeHistogram: [0, 0, 0, 0, 0],
    relationsWritten: 0,
    proposalsCreated: 0,
    sessionNarrativeWritten: 0,
    membersReassigned: 0,
  };
}

function accumulateTurnWriteCounts(
  counts: NoteSettlementCommitCounts,
  outcome: SettlementTurnWriteOutcome,
): void {
  if (outcome.review) {
    counts.turnsReviewed += 1;
    const anyYielded =
      (outcome.review.grade !== undefined && !outcome.review.grade.landed) ||
      (outcome.review.type !== undefined && !outcome.review.type.landed) ||
      (outcome.review.tags !== undefined && !outcome.review.tags.landed);
    if (anyYielded) {
      counts.reviewsYieldedToLateNote += 1;
    }
    if (outcome.review.grade?.landed) {
      const grade = outcome.review.grade.value;
      counts.gradeHistogram[grade] = (counts.gradeHistogram[grade] ?? 0) + 1;
    }
  }
  if (outcome.relations) {
    counts.relationsWritten += outcome.relations.written;
  }
  if (outcome.session) {
    counts.sessionNarrativeWritten += 1;
  }
}

function accumulateMembershipWriteCounts(
  counts: NoteSettlementCommitCounts,
  input: SettlementMembershipWriteInput,
  outcome: SettlementMembershipWriteOutcome,
): void {
  if (input.action === "reassign") {
    counts.membersReassigned += 1;
    return;
  }
  if (!outcome.proposeAlreadyExisted) {
    counts.proposalsCreated += 1;
  }
}

function summarizeCounts(counts: NoteSettlementCommitCounts): string {
  const bits = [
    `${counts.turnsReviewed} turn review(s)`,
    `${counts.relationsWritten} relation(s)`,
    `${counts.proposalsCreated} proposal(s)`,
    `${counts.membersReassigned} reassignment(s)`,
  ];
  if (counts.sessionNarrativeWritten > 0) {
    bits.push("session narrative written");
  }
  return `(${bits.join(", ")}.)`;
}

type ToolTextResult = {
  content: Array<{ type: "text"; text: string }>;
};

function textResult(text: string): ToolTextResult {
  return { content: [{ type: "text", text }] };
}

function parameterError(message: string): ToolTextResult {
  return textResult(`Parameter error: ${message}`);
}

export interface CreateSettlementDirectWriteEngineOptions {
  db: Database;
  context: SettlementTurnFacadeContext;
  /** Epoch seconds, injectable for tests; each call is stamped with its own reading. */
  now?: () => number;
}

export interface SettlementDirectWriteEngine {
  writeNote(rawInput: SettlementTurnWriteInput): ToolTextResult;
  writeMembership(rawInput: SettlementMembershipWriteInput): ToolTextResult;
  commit(): ToolTextResult;
  /** This run's own write counts, sourced from what actually landed (ticket 10c's discipline, carried over) — null until a `commit` has landed. */
  getLastCommitMetrics(): NoteSettlementCommitCounts | null;
}

export function createSettlementDirectWriteEngine(
  options: CreateSettlementDirectWriteEngineOptions,
): SettlementDirectWriteEngine {
  const { db, context } = options;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  const counts = emptyCommitCounts();
  let lastCommitMetrics: NoteSettlementCommitCounts | null = null;

  function writeNote(rawInput: SettlementTurnWriteInput): ToolTextResult {
    const nowEpoch = now();
    const evaluation = evaluateSettlementTurnWrite(db, context, rawInput, nowEpoch, {
      apply: true,
    });
    if (!evaluation.ok) {
      return parameterError(evaluation.message);
    }
    accumulateTurnWriteCounts(counts, evaluation.outcome);
    return textResult(
      renderSettlementTurnWriteReceipt(evaluation.outcome, { staged: false }),
    );
  }

  function writeMembership(rawInput: SettlementMembershipWriteInput): ToolTextResult {
    const nowEpoch = now();
    const evaluation = evaluateSettlementMembershipWrite(db, context, rawInput, nowEpoch, {
      apply: true,
    });
    if (!evaluation.ok) {
      return parameterError(evaluation.message);
    }
    accumulateMembershipWriteCounts(counts, rawInput, evaluation.outcome);
    return textResult(
      renderSettlementMembershipWriteReceipt(evaluation.outcome, { staged: false }),
    );
  }

  function commit(): ToolTextResult {
    // Idempotent within this SAME run: a second `commit` call after one
    // already landed reports the same fact rather than re-running the CAS,
    // which would otherwise throw `not-claimed` (the job is `done`, not
    // `claimed`) and mis-render a legitimate double-call as a lost lease.
    if (lastCommitMetrics !== null) {
      return textResult(
        `Already committed. S${context.sessionId} window settled — job complete. ` +
          summarizeCounts(lastCommitMetrics),
      );
    }

    const nowEpoch = now();
    try {
      runWriteTransaction(db, () => {
        // Ticket 06 (spec "commit 重定位"): claim validity + terminal mark,
        // nothing else — `completeNoteSettlementJobIfSegmentedCore` IS the
        // fence-and-CAS gate, already an empty shell of any duty-coverage
        // judgment (db/note-settlement-completion.ts's own doc comment).
        // `assertNoteSettlementJobClaimed` runs again as this function's own
        // first statement — belt-and-braces with the CAS itself, not a
        // second concept.
        assertNoteSettlementJobClaimed(db, context.jobId, context.claimGeneration);
        const gate = completeNoteSettlementJobIfSegmentedCore(
          db,
          context.jobId,
          context.claimGeneration,
          nowEpoch,
          {},
        );
        if (!gate.completed) {
          throw new NoteSettlementJobFenceError(
            context.jobId,
            gate.reason ?? "generation-mismatch",
            `settlement job ${context.jobId}: commit CAS did not match (${gate.reason ?? "unknown"})`,
          );
        }
      });
    } catch (error) {
      if (error instanceof NoteSettlementJobFenceError) {
        return textResult(
          `Commit refused — this dispatch's job lease was reclaimed (${error.message}). ` +
            "No further commit will succeed. Stop making tool calls.",
        );
      }
      throw error;
    }

    lastCommitMetrics = counts;
    return textResult(
      `Committed. S${context.sessionId} window settled — job complete. ` +
        summarizeCounts(counts),
    );
  }

  return {
    writeNote,
    writeMembership,
    commit,
    getLastCommitMetrics: () => lastCommitMetrics,
  };
}
