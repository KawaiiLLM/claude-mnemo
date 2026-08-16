import type { Database } from "bun:sqlite";

import { parseTurnAddress } from "../mcp/note";

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
 * STAGING ORDER, inside one `runWriteTransaction`, resolving `E#<handle>`
 * handles to real segment ids as it creates them, then runs the completion
 * gate as that same transaction's last statement. A crash before `commit`
 * loses nothing that was ever real (requirement 1) — the job stays
 * `claimed` and the next attempt starts clean, which is why no per-write
 * idempotency key is needed (spec A7, G5 dissolved).
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
 * Critically, the in-memory `staged` map is NOT cleared on a refusal
 * (requirement 7) — only a genuinely committed transaction clears it — so
 * the agent's existing work survives, it fills the gap the refusal named
 * with more tool calls, and `commit` again replays the WHOLE list (old
 * entries and new) against a transaction that, if it commits this time,
 * commits atomically. Replaying the full list rather than only what is new
 * is what makes a refused-then-retried commit safe without any staged
 * write needing its own replay contract (spec A7's G5 dissolution): a
 * rolled-back attempt left no trace to reconcile against.
 *
 * STAGED ENTRIES ARE KEYED (spec A7a, ticket 10d — `staged` is a `Map`, not
 * an array). A7's first draft left staged intents identityless: a retried
 * stage call appended a duplicate `commit` then landed twice, and a model
 * that noticed its own mistake had no way to replace the stale entry — the
 * bad intent replayed, and failed, on every subsequent commit. The fix is
 * the SAME "present overwrites" rule D5a already applies to every field,
 * applied one level up to the staged CALL: a turn note keys on the turn
 * address (automatic), `segment` create keys on a handle the MODEL names
 * (so a retry reproduces it by construction — see note-settlement-segment-
 * facade.ts), `segment` extend keys on the segment id, `segment` exclude
 * keys on the turn address. Re-staging a key REPLACES its Map entry rather
 * than appending a second one — `Map.set` on an existing key updates the
 * value but leaves its ITERATION POSITION exactly where it was first
 * staged, which is deliberate: staging order still matches the order the
 * agent's calls were FIRST recognised in, so a correction does not silently
 * reorder itself past a handle it needs to reference (or that references
 * it).
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

// ---------------------------------------------------------------------------
// Staging keys (spec A7a) — one canonical, kind-prefixed key per staged call
// shape, so a `note` on turn S3/T5 and a `segment exclude` on the SAME turn
// (a legitimate, unrelated pair of facts) never collide, while two calls of
// the SAME shape naming the SAME address/handle/id always do.
// ---------------------------------------------------------------------------

/**
 * The staging key of a segment call, from the RAW input — no validation, so a
 * partial correction can find the entry it is correcting. `null` when the
 * call is malformed enough that no key exists; evaluation refuses it a moment
 * later, and the key is never used.
 */
function segmentStagingKeyOf(
  rawInput: SettlementSegmentWriteInput,
): string | null {
  if (rawInput.action === "create") {
    const handle = rawInput.handle?.trim();
    return handle ? segmentCreateStagingKey(`E#${handle}`) : null;
  }
  if (rawInput.action === "extend") {
    return rawInput.segmentId === undefined
      ? null
      : segmentExtendStagingKey(rawInput.segmentId);
  }
  const address = parseTurnAddress(rawInput.turn ?? "");
  return address
    ? segmentExcludeStagingKey(`S${address.sessionId}/T${address.promptNumber}`)
    : null;
}

function noteStagingKey(ref: string): string {
  return `note:${ref}`;
}
function segmentCreateStagingKey(handle: string): string {
  return `segment-create:${handle}`;
}
function segmentExtendStagingKey(segmentId: number): string {
  return `segment-extend:${segmentId}`;
}
function segmentExcludeStagingKey(ref: string): string {
  return `segment-exclude:${ref}`;
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

  // Keyed staging (spec A7a) — see the module doc comment. Iteration order
  // is `Map`'s own insertion order, and `Map.set` on an EXISTING key updates
  // the value without moving its position, so a same-key restage lands
  // exactly where it was first staged, not at the end of the run.
  const staged = new Map<string, StagedEntry>();
  /** Handles assigned so far, every value `null` until `commit` resolves them for real. */
  let knownHandles: SettlementHandleMap = new Map();

  function stageNoteWrite(rawInput: SettlementTurnWriteInput): ToolTextResult {
    const nowEpoch = now();
    // Merge BEFORE validating, not after (spec A7a, field-level). Two things
    // ride on the order. The receipt must describe what is actually staged,
    // and after a merge that is the combination, not this call's own fields.
    // And a combination neither call would have passed alone — prose for a
    // turn this dispatch may not write prose for, arriving in a second call
    // that only names a grade — has to be refused here rather than at commit,
    // which is A7's whole "the agent learns while it can still act" rule.
    const address = parseTurnAddress(rawInput.turn);
    const priorKey = noteStagingKey(
      address ? `S${address.sessionId}/T${address.promptNumber}` : rawInput.turn,
    );
    const prior = staged.get(priorKey);
    const merged: SettlementTurnWriteInput =
      prior?.kind === "note" ? { ...prior.input, ...rawInput } : rawInput;

    const evaluation = evaluateSettlementTurnWrite(db, context, merged, nowEpoch, {
      apply: false,
    });
    if (!evaluation.ok) {
      return parameterError(evaluation.message);
    }
    const key = noteStagingKey(evaluation.outcome.ref);
    const replaced = staged.has(key);
    staged.set(key, { kind: "note", input: merged });
    return textResult(
      renderSettlementTurnWriteReceipt(evaluation.outcome, { staged: true, replaced }),
    );
  }

  function stageSegmentWrite(rawInput: SettlementSegmentWriteInput): ToolTextResult {
    const nowEpoch = now();
    // Same field-level merge as `stageNoteWrite`, and merged before
    // validation for the same two reasons. The key has to be derivable from
    // the raw input alone — `action` plus the handle, the segment id or the
    // turn address — because a partial correction (a title alone, say) is
    // exactly what a merge exists to allow, and would not survive being
    // validated on its own first.
    const priorSegmentKey = segmentStagingKeyOf(rawInput);
    const priorSegment =
      priorSegmentKey === null ? undefined : staged.get(priorSegmentKey);
    const mergedInput: SettlementSegmentWriteInput =
      priorSegment?.kind === "segment"
        ? { ...priorSegment.input, ...rawInput }
        : rawInput;

    const evaluation = evaluateSettlementSegmentWrite(db, context, mergedInput, nowEpoch, {
      apply: false,
      handleMap: knownHandles,
    });
    if (!evaluation.ok) {
      return parameterError(evaluation.message);
    }

    let key: string;
    let handle: string | null = null;
    if (rawInput.action === "create") {
      // Model-named (spec A7a) — see note-settlement-segment-facade.ts's
      // own required-field check; `rawInput.handle` is guaranteed present
      // and valid here because `evaluation.ok` is true.
      handle = `E#${rawInput.handle!.trim()}`;
      key = segmentCreateStagingKey(handle);
      if (!knownHandles.has(handle)) {
        const grown = new Map(knownHandles);
        grown.set(handle, null);
        knownHandles = grown;
      }
    } else if (rawInput.action === "extend") {
      key = segmentExtendStagingKey(rawInput.segmentId!);
    } else {
      // exclude
      key = segmentExcludeStagingKey(evaluation.outcome.excludedTurnRef!);
    }

    const replaced = staged.has(key);
    staged.set(key, { kind: "segment", handle, input: mergedInput });
    return textResult(
      renderSettlementSegmentWriteReceipt(evaluation.outcome, { staged: true, handle, replaced }),
    );
  }

  function commit(): ToolTextResult {
    const nowEpoch = now();
    // An empty snapshot is not special-cased: the gate still runs (an
    // earlier commit attempt may have landed everything already and only
    // failed the gate for a reason since fixed by other means), it just
    // replays nothing first. Map iteration order is insertion order.
    const snapshot = [...staged.values()];

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
                `segment ${entry.handle ?? entry.input.segmentId ?? entry.input.turn}: ${evaluation.message}`,
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
      staged.clear();
      knownHandles = new Map();
      void gateResult; // completed:true by construction — the gate throws before returning otherwise
      return textResult(
        `Committed. S${context.sessionId} window settled — job complete.`,
      );
    } catch (error) {
      // A refusal for ANY reason below leaves `staged` untouched (spec A7
      // requirement 7): the transaction rolled back, so nothing any entry
      // in `snapshot` would have written actually landed, and the agent's
      // existing staged work is exactly as good as it was before this call.
      //
      // Ticket 10d: the message must not tell the model to do the
      // impossible. A GATE GAP (segmentation/note/coverage-incomplete) is
      // genuinely fixable by staging MORE calls — nothing already staged was
      // wrong, the window just does not cover itself yet. A FENCE-shaped
      // refusal (the job's lease is gone — `not-claimed`/`generation-
      // mismatch`, whether it reaches here as a thrown `NoteSettlementJobFenceError`
      // or, defensively, as a `CommitGateRefused` whose OWN reason is one of
      // those two) is different in kind: THIS dispatch's `claimGeneration`
      // is fixed for its whole life and can never match a newer one, so no
      // amount of re-staging or re-committing from THIS run will ever
      // succeed — telling the model to "fill the gap and commit again" here
      // would be the exact self-contradiction the review found (saying
      // "commit again" and "stop making tool calls" in the same breath).
      if (error instanceof CommitGateRefused) {
        if (error.result.reason === "not-claimed" || error.result.reason === "generation-mismatch") {
          return textResult(
            `Commit refused — ${describeGateRefusal(error.result)}`,
          );
        }
        return textResult(
          `Commit refused — ${describeGateRefusal(error.result)} Staging kept: fill the gap and call commit again.`,
        );
      }
      if (error instanceof CommitReplayRefused) {
        // A REPLAY conflict is a specific staged entry disagreeing with the
        // world as of commit time (a stale segment revision, a relation
        // pair the main agent's own edit has since dropped, ...) — spec
        // A7a's keyed staging (this same ticket) is what makes this
        // genuinely fixable in-run: re-stage the SAME key (the turn address
        // for a note, the handle for a segment create, the segment id for
        // extend, the turn address for exclude) with corrected input — that
        // REPLACES the stale entry rather than adding to it — then call
        // commit again. Blindly retrying the SAME staged input would just
        // fail again the same way.
        return textResult(
          `Commit refused — ${error.message} Staging kept: re-stage the SAME call ` +
            "(same key) with corrected input, then call commit again — a stale " +
            "staged entry is not dropped automatically.",
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
    pendingCount: () => staged.size,
  };
}
