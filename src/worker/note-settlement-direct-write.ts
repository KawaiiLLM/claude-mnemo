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
 * TICKET 08 (edge-mechanism-revision, peer 终审必改 5): every direct write is
 * lease-fenced PER CALL, not only at `commit`. The earlier reading — that a
 * lapsed claimant is fenced out field-by-field by the write gate, so a
 * job-level check at `commit` sufficed — does not hold for the writes that
 * create state rather than overwrite it: `remember(create)` mints a segment
 * and attaches it to the session, `reassign` moves membership, `propose`
 * stores a proposal. None of those collide with a field stamp, so a reclaimed
 * claimant could plant a stray segment on the session and only learn at
 * `commit` that it never held the lease — by which time the segment exists
 * and the next window renders it. `assertNoteSettlementJobClaimed` therefore
 * runs as the FIRST statement inside each write's own transaction (the same
 * predicate `commit` leans on, not a second one), so the fence and the write
 * commit or vanish together: a lease that moved before this transaction
 * opened aborts the call before any mutation runs.
 *
 * `commit`'s own end-of-run check is UNCHANGED and still required — per-write
 * fencing is an ADDITIONAL gate, not a replacement. It is also not a
 * substitute for the field-level write gate, which continues to arbitrate two
 * writers that both hold a valid claim on different generations of the same
 * field.
 */

export interface NoteSettlementCommitCounts {
  /** Turns a `note` call actually carried a review (type/tags) for, landed or with at least one field yielded. */
  turnsReviewed: number;
  /** Of `turnsReviewed`, how many had at least one field (type/tags) rejected by the write gate as stale/never-read. */
  reviewsYieldedToLateNote: number;
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
      (outcome.review.type !== undefined && !outcome.review.type.landed) ||
      (outcome.review.tags !== undefined && !outcome.review.tags.landed);
    if (anyYielded) {
      counts.reviewsYieldedToLateNote += 1;
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
  /**
   * Test seam only (same `options.runWriteTransaction ?? runWriteTransaction`
   * port `mcp/note.ts` and `mcp/remember.ts` already expose): lets a test
   * interleave a competing write INSIDE this engine's own transaction, which
   * is the only way to prove the lease check and the mutation share one. Every
   * one of the three tools routes through it — a seam that some writes escaped
   * would report atomicity the engine does not actually have.
   */
  runWriteTransaction?: typeof runWriteTransaction;
}

export interface SettlementDirectWriteEngine {
  writeNote(rawInput: SettlementTurnWriteInput): ToolTextResult;
  writeMembership(rawInput: SettlementMembershipWriteInput): ToolTextResult;
  commit(): ToolTextResult;
  /** This run's own write counts, sourced from what actually landed (ticket 10c's discipline, carried over) — null until a `commit` has landed. */
  getLastCommitMetrics(): NoteSettlementCommitCounts | null;
}

/** Rejection sentinel: thrown inside the per-call transaction so the whole
 * check-write-stamp sequence rolls back, caught at the boundary and reported
 * as an ordinary parameter error (never escapes this module). */
class DirectWriteRefused extends Error {}

/**
 * A lost lease is NOT a parameter error — the call was well-formed and the
 * model can do nothing to make it succeed. Rendered in `commit`'s own
 * "reclaimed / stop calling" register instead, naming the fence's reason
 * verbatim (`not-claimed` vs `generation-mismatch`, with the job id), so the
 * transcript records which of the two happened rather than a generic refusal.
 */
function leaseRefusal(error: NoteSettlementJobFenceError): ToolTextResult {
  return textResult(
    `Write refused — this dispatch's job lease was reclaimed (${error.message}). ` +
      "Nothing was written. No further write or commit will succeed. " +
      "Stop making tool calls.",
  );
}

export function createSettlementDirectWriteEngine(
  options: CreateSettlementDirectWriteEngineOptions,
): SettlementDirectWriteEngine {
  const { db, context } = options;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const writeTransaction = options.runWriteTransaction ?? runWriteTransaction;

  const counts = emptyCommitCounts();
  let lastCommitMetrics: NoteSettlementCommitCounts | null = null;

  function writeNote(rawInput: SettlementTurnWriteInput): ToolTextResult {
    const nowEpoch = now();
    let evaluation: ReturnType<typeof evaluateSettlementTurnWrite>;
    try {
      // One transaction per call (peer finding P1-1): the evaluator's whole
      // check→write→stamp sequence — including a compound call whose LATER
      // half rejects after an EARLIER half already applied — commits or
      // vanishes as a unit. A rejection throws the sentinel so SQLite rolls
      // the transaction back whole (the staging engine's own
      // refusal-inside-transaction pattern), then reports as an ordinary
      // parameter error.
      evaluation = writeTransaction(db, () => {
        // Ticket 08: the lease check is the FIRST statement in the SAME
        // transaction as the write it guards. Its throw rolls the transaction
        // back for free, so no ordering discipline further down can be got
        // wrong — see `assertNoteSettlementJobClaimed`'s own doc comment.
        assertNoteSettlementJobClaimed(db, context.jobId, context.claimGeneration);
        const result = evaluateSettlementTurnWrite(db, context, rawInput, nowEpoch, {
          apply: true,
        });
        if (!result.ok) {
          throw new DirectWriteRefused(result.message);
        }
        return result;
      });
    } catch (error) {
      if (error instanceof NoteSettlementJobFenceError) {
        return leaseRefusal(error);
      }
      if (error instanceof DirectWriteRefused) {
        return parameterError(error.message);
      }
      throw error;
    }
    accumulateTurnWriteCounts(counts, evaluation.outcome);
    return textResult(
      renderSettlementTurnWriteReceipt(evaluation.outcome, { staged: false }),
    );
  }

  function writeMembership(rawInput: SettlementMembershipWriteInput): ToolTextResult {
    const nowEpoch = now();
    let evaluation: ReturnType<typeof evaluateSettlementMembershipWrite>;
    try {
      // Same one-transaction-per-call discipline; this wrap is also what
      // makes the reassign path's live attachment/open re-check share a
      // transaction with the membership mutation it guards.
      evaluation = writeTransaction(db, () => {
        // Ticket 08, and this is the path the ticket was written for: a
        // `create` mints a segment AND attaches it to the session, a
        // `reassign` moves membership, a `propose` stores a row — none of
        // them meet a field stamp on the way in, so nothing but this fence
        // stops a reclaimed claimant from planting durable state that
        // `commit` can then only complain about after the fact.
        assertNoteSettlementJobClaimed(db, context.jobId, context.claimGeneration);
        const result = evaluateSettlementMembershipWrite(db, context, rawInput, nowEpoch, {
          apply: true,
        });
        if (!result.ok) {
          throw new DirectWriteRefused(result.message);
        }
        return result;
      });
    } catch (error) {
      if (error instanceof NoteSettlementJobFenceError) {
        return leaseRefusal(error);
      }
      if (error instanceof DirectWriteRefused) {
        return parameterError(error.message);
      }
      throw error;
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
      writeTransaction(db, () => {
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
