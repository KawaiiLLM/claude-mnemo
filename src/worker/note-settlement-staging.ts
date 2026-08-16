import type { Database } from "bun:sqlite";

import { runWriteTransaction } from "../db/database";
import {
  assertNoteSettlementJobClaimed,
  completeNoteSettlementJobIfSegmentedCore,
  NoteSettlementJobFenceError,
  type NoteSettlementCompletionResult,
} from "../db/note-settlement-completion";
import {
  evaluateSettlementSegmentWrite,
  renderSettlementSegmentWriteReceipt,
  type SettlementHandleMap,
  type SettlementSegmentWriteInput,
} from "./note-settlement-segment-facade";
import {
  evaluateSettlementTurnWrite,
  renderSettlementTurnWriteReceipt,
  type SettlementTurnFacadeContext,
  type SettlementTurnWriteInput,
} from "./note-settlement-turn-facade";

/**
 * The settlement staging engine (ticket 10b, spec A7) — where "staging lives
 * in the per-request server closure, in memory" actually lives.
 *
 * `note` and `segment` calls VALIDATE fully, right now, against the live
 * database (spec A7 requirement 2 — A1's real benefit, kept) and return a
 * real receipt, but the intent they describe is only APPENDED to an
 * in-memory list; no mutating statement runs. `commit` is the only function
 * in this whole module that writes: it replays every staged intent, IN
 * STAGING ORDER, inside one `runWriteTransaction`, resolving `E#n` handles
 * to real segment ids as it creates them, then runs the completion gate as
 * that same transaction's last statement. A crash before `commit` loses
 * nothing that was ever real (requirement 1) — the job stays `claimed` and
 * the next attempt starts clean, which is why no per-write idempotency key
 * is needed (spec A7, G5 dissolved).
 *
 * `commit`'s own transaction is ALSO the only place staged intents are
 * re-evaluated (`evaluateSettlementTurnWrite`/`evaluateSettlementSegmentWrite`
 * called again with `apply: true`, fresh reads throughout) — the "world
 * moved" case (requirement 5) falls out of running the SAME decision
 * function twice against two different moments, not a second concept.
 *
 * A REFUSED commit — a replay conflict, or the completion gate finding a gap
 * — throws inside the transaction, which SQLite rolls back whole: nothing
 * any staged write would have landed lands, and the job stays `claimed`.
 * Critically, the in-memory `staged` array is NOT cleared on a refusal
 * (requirement 7) — only a genuinely committed transaction clears it — so
 * the agent's existing work survives, it fills the gap the refusal named
 * with more tool calls, and `commit` again replays the WHOLE list (old
 * entries and new) against a transaction that, if it commits this time,
 * commits atomically. Replaying the full list rather than only what is new
 * is what makes a refused-then-retried commit safe without any staged
 * write needing its own replay contract (spec A7's G5 dissolution): a
 * rolled-back attempt left no trace to reconcile against.
 */

export interface CreateSettlementStagingEngineOptions {
  db: Database;
  context: SettlementTurnFacadeContext;
  /** Epoch seconds, injectable for tests; each call is stamped with its own reading. */
  now?: () => number;
}

type StagedEntry =
  | { kind: "note"; input: SettlementTurnWriteInput }
  | { kind: "segment"; handle: string | null; input: SettlementSegmentWriteInput };

type ToolTextResult = {
  content: Array<{ type: "text"; text: string }>;
};

function textResult(text: string): ToolTextResult {
  return { content: [{ type: "text", text }] };
}

function parameterError(message: string): ToolTextResult {
  return textResult(`Parameter error: ${message}`);
}

/** Thrown inside `commit`'s transaction when a staged write's fresh re-evaluation fails — a replay conflict or a validation truth the world changed underneath. Caught by `commit` itself; never escapes this module. */
class CommitReplayRefused extends Error {}

/** Thrown inside `commit`'s transaction when the completion gate finds a gap. Carries the gate's own result so the caller can report exactly what is missing. */
class CommitGateRefused extends Error {
  constructor(readonly result: NoteSettlementCompletionResult) {
    super("completion gate refused");
  }
}

export interface SettlementStagingEngine {
  stageNoteWrite(rawInput: SettlementTurnWriteInput): ToolTextResult;
  stageSegmentWrite(rawInput: SettlementSegmentWriteInput): ToolTextResult;
  commit(): ToolTextResult;
  /** Test/inspection only — how many intents are currently staged. */
  pendingCount(): number;
}

function describeGateRefusal(result: NoteSettlementCompletionResult): string {
  switch (result.reason) {
    case "segmentation-incomplete":
      return (
        `${result.segmentationGaps.length} turn(s) still need a segment (member or explicit ` +
        `no-segment verdict): ` +
        result.segmentationGaps.map((gap) => `S${gap.sessionId}/T${gap.promptNumber}`).join(", ")
      );
    case "note-incomplete":
      return (
        `${result.noteGaps.length} turn(s) still owe a note: ` +
        result.noteGaps.map((gap) => `S${gap.sessionId}/T${gap.promptNumber}`).join(", ")
      );
    case "coverage-incomplete":
      return (
        `${result.coverageGaps.length} turn(s) still have no stated type: ` +
        result.coverageGaps.map((gap) => `S${gap.sessionId}/T${gap.promptNumber}`).join(", ")
      );
    case "not-claimed":
    case "generation-mismatch":
      return "this dispatch's job lease was reclaimed; no further work will land. Stop making tool calls.";
    default:
      return "the window is not yet complete.";
  }
}

export function createSettlementStagingEngine(
  options: CreateSettlementStagingEngineOptions,
): SettlementStagingEngine {
  const { db, context } = options;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  const staged: StagedEntry[] = [];
  /** Handles assigned so far, every value `null` until `commit` resolves them for real. */
  let knownHandles: SettlementHandleMap = new Map();
  let nextHandleNumber = 1;

  function stageNoteWrite(rawInput: SettlementTurnWriteInput): ToolTextResult {
    const nowEpoch = now();
    const evaluation = evaluateSettlementTurnWrite(db, context, rawInput, nowEpoch, {
      apply: false,
    });
    if (!evaluation.ok) {
      return parameterError(evaluation.message);
    }
    staged.push({ kind: "note", input: rawInput });
    return textResult(renderSettlementTurnWriteReceipt(evaluation.outcome, { staged: true }));
  }

  function stageSegmentWrite(rawInput: SettlementSegmentWriteInput): ToolTextResult {
    const nowEpoch = now();
    const evaluation = evaluateSettlementSegmentWrite(db, context, rawInput, nowEpoch, {
      apply: false,
      handleMap: knownHandles,
    });
    if (!evaluation.ok) {
      return parameterError(evaluation.message);
    }
    let handle: string | null = null;
    if (rawInput.action === "create") {
      handle = `E#${nextHandleNumber}`;
      nextHandleNumber += 1;
      const grown = new Map(knownHandles);
      grown.set(handle, null);
      knownHandles = grown;
    }
    staged.push({ kind: "segment", handle, input: rawInput });
    return textResult(
      renderSettlementSegmentWriteReceipt(evaluation.outcome, { staged: true, handle }),
    );
  }

  function commit(): ToolTextResult {
    const nowEpoch = now();
    // An empty snapshot is not special-cased: the gate still runs (an
    // earlier commit attempt may have landed everything already and only
    // failed the gate for a reason since fixed by other means), it just
    // replays nothing first.
    const snapshot = [...staged];

    try {
      const gateResult = runWriteTransaction(db, () => {
        // The fence, first statement (spec G6/G7) — guards EVERYTHING below,
        // the staged replay included. A lease reclaimed between staging and
        // commit throws here, before any staged write can land.
        assertNoteSettlementJobClaimed(db, context.jobId, context.claimGeneration);

        const handleMap = new Map<string, number | null>();
        for (const entry of snapshot) {
          if (entry.kind === "segment") {
            const evaluation = evaluateSettlementSegmentWrite(db, context, entry.input, nowEpoch, {
              apply: true,
              handleMap,
            });
            if (!evaluation.ok) {
              throw new CommitReplayRefused(
                `segment ${entry.handle ?? entry.input.segmentId}: ${evaluation.message}`,
              );
            }
            if (entry.handle) {
              handleMap.set(entry.handle, evaluation.outcome.segmentId);
            }
          } else {
            const evaluation = evaluateSettlementTurnWrite(db, context, entry.input, nowEpoch, {
              apply: true,
            });
            if (!evaluation.ok) {
              throw new CommitReplayRefused(`note ${entry.input.turn}: ${evaluation.message}`);
            }
          }
        }

        // The completion gate as commit's own precondition (spec A7
        // requirement 6), inside this SAME transaction and therefore under
        // the fence above — `completeNoteSettlementJobIfSegmentedCore` is
        // the transaction-free core `db/note-settlement-completion.ts` was
        // split into exactly so this call could compose here rather than
        // nesting a second `runWriteTransaction`.
        const gate = completeNoteSettlementJobIfSegmentedCore(
          db,
          context.jobId,
          context.claimGeneration,
          nowEpoch,
          {},
        );
        if (!gate.completed) {
          throw new CommitGateRefused(gate);
        }
        return gate;
      });

      // Only a transaction that actually committed clears the staging —
      // everything the loop above did is now durable, so replaying it again
      // on a later `commit` call would be redundant (and, for a `create`,
      // wrong: it would mint a second segment).
      staged.length = 0;
      knownHandles = new Map();
      nextHandleNumber = 1;
      void gateResult; // completed:true by construction — the gate throws before returning otherwise
      return textResult(
        `Committed. S${context.sessionId} window settled — job complete.`,
      );
    } catch (error) {
      // A refusal for ANY reason below leaves `staged` untouched (spec A7
      // requirement 7): the transaction rolled back, so nothing any entry
      // in `snapshot` would have written actually landed, and the agent's
      // existing staged work is exactly as good as it was before this call.
      if (error instanceof CommitGateRefused) {
        return textResult(
          `Commit refused — ${describeGateRefusal(error.result)} Staging kept: fill the gap and call commit again.`,
        );
      }
      if (error instanceof CommitReplayRefused) {
        return textResult(
          `Commit refused — ${error.message} Staging kept: fix and call commit again.`,
        );
      }
      if (error instanceof NoteSettlementJobFenceError) {
        return textResult(
          `Commit refused — this dispatch's job lease was reclaimed (${error.message}). ` +
            "No further commit will succeed. Stop making tool calls.",
        );
      }
      throw error;
    }
  }

  return {
    stageNoteWrite,
    stageSegmentWrite,
    commit,
    pendingCount: () => staged.length,
  };
}
