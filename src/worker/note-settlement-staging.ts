import type { Database } from "bun:sqlite";

import { parseTurnAddress } from "../mcp/note";

import { isSqliteBusy, runHookWriteTransaction, runWriteTransaction } from "../db/database";
import {
  assertNoteSettlementJobClaimed,
  completeNoteSettlementJobIfSegmentedCore,
  NoteSettlementJobFenceError,
  type NoteSettlementCompletionResult,
} from "../db/note-settlement-completion";
import {
  evaluateSettlementMembershipWrite,
  renderSettlementMembershipWriteReceipt,
  type SettlementMembershipWriteInput,
} from "./note-settlement-membership-facade";
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
 *
 * TICKET 10C'S ADDITION: `commit`'s own replay is now the source of the
 * operator-facing job-log metrics (`worker/note-settlement-dispatch.ts`'s
 * `metrics()`), which used to read `turnsReviewed`/`notesReconstructed`/etc.
 * off the retired write-back's parsed-envelope result — a payload the model
 * has not produced since turn writes moved onto the `note`/`segment` tools
 * (ticket 10a), so that sink had been reporting zero while real work landed
 * through calls nothing counted. `getLastCommitMetrics` exposes exactly what
 * THIS module's own replay loop landed, counted as it happens rather than
 * inferred from what the model claimed. It is deliberately NOT an MCP tool —
 * `note-settlement-sdk-query.ts` never registers it with the SDK's `tool()`,
 * so the model can never call it, and the per-grade histogram inside it
 * never appears in any `ToolTextResult` this module returns. The query
 * wrapper reads it exactly once, after the model's run has already ended,
 * for a sink the model never sees (spec G9).
 *
 * TICKET 11'S ADDITION: `previewCommit` — `attemptCommit(preview: true)`,
 * which is the SAME replay and the SAME gate in a transaction whose last
 * statement is a throw. Its only caller is the Stop hook
 * (note-settlement-stop-hook.ts), which has to answer "what would `commit`
 * refuse" for an agent that is stopping without having called it. Computing
 * that against un-replayed tables would report gaps the agent has already
 * staged the fix for, so the answer comes from the gate itself — spec G8's
 * "the check cannot drift from the gate: it IS the gate", one layer up from
 * where G8 states it. Like `getLastCommitMetrics` it is NOT an MCP tool:
 * settlement has no `check` (G8 amended), and the model cannot reach this.
 *
 * TICKET 15 FINDING 5'S REPAIR: a preview runs against the worker's own
 * long-lived `db` connection, opened with the production busy_timeout (5s) —
 * right for every OTHER writer on it, wrong for a check whose whole point is
 * to answer inside a Stop hook's short budget. Under a writer lock held
 * elsewhere, a plain `runWriteTransaction` could burn up to three attempts'
 * worth of that 5s each, then THROW `SQLITE_BUSY` straight out of the hook.
 * A preview attempt therefore runs through `runHookWriteTransaction`
 * (db/database.ts) instead — its own bounded budget (2.5s default) with
 * backoff — AND, for the duration of that one attempt only, this
 * connection's `busy_timeout` is turned down first (`runPreviewTransaction`
 * below): otherwise a single blocked `BEGIN IMMEDIATE` still eats the whole
 * 5s before `runHookWriteTransaction`'s own JS-level clock ever gets a turn,
 * and the budget is decorative — measured (see the finding's test): with the
 * connection left at the production default, one blocked attempt alone takes
 * ~5.3s; with it turned down for the preview, the SAME budget of 2.5s is
 * respected to within a few ms. If the budget still runs out — the lock
 * genuinely outlasts it — `attemptCommit` catches `SQLITE_BUSY` and returns
 * `{ kind: "indeterminate" }` rather than letting it escape: the one
 * behaviour confirmed definitely wrong was an uncaught throw crossing the
 * hook boundary, not merely a slow answer. `previewCommit` surfaces this as
 * `checkFailed: true`, and the Stop hook (note-settlement-stop-hook.ts)
 * chooses to BLOCK on it with an honest "the check could not run" message —
 * not silently let the stop through (which would hide exactly the staged-
 * work loss this hook exists to catch) and not retry again inside the hook
 * (which would just repeat the wait `runHookWriteTransaction` already paid
 * out). The existing block cap (spec G2, `blocksIssued`) still governs: this
 * counts as one of the two, and the job's own multi-attempt retry policy is
 * the eventual backstop, same as for a genuine gap. A real (non-preview)
 * `commit` is unaffected — it keeps `runWriteTransaction` and still
 * propagates `SQLITE_BUSY` as a tool-call error the model can see and retry,
 * which is out of this finding's scope.
 *
 * TICKET 05'S DEMOLITION (ownership-and-note-cadence spec): the completion
 * gate `attemptCommit` runs (`db/note-settlement-completion.ts`) is now an
 * empty shell — fence plus CAS, no segmentation/note/coverage/election-
 * ceiling checks — so a `CommitGateRefused` here is always fence-shaped
 * (see `describeGateRefusal` below). `assign` retired from the membership
 * facade (`propose` is the only action), so the membership branch of the
 * replay loop no longer counts `membersAdded`, and the turn-facade's prose
 * (title/content/insight) path is gone, so `notesReconstructed`/
 * `notesYielded` are no longer counted either.
 */

/**
 * What `commit`'s own replay actually landed, this call (ticket 10c). Built
 * by walking the SAME `snapshot` the replay loop below iterates, so every
 * count here is a fact about a transaction that just committed, never a
 * guess about what the model said it would do.
 */
export interface NoteSettlementCommitCounts {
  /** Turns a `note` call actually carried a review (grade/type/tags) for, landed or yielded. */
  turnsReviewed: number;
  /** Of `turnsReviewed`, how many had their type/tags step aside because an agent note landed after this dispatch's context was read — grade still lands either way. */
  reviewsYieldedToLateNote: number;
  /**
   * Indexed 0-4 (the task-causality scale). Counted whenever a landed review
   * carried a grade, written OR yielded — grade always lands regardless
   * (`evaluateSettlementTurnWrite`: only the note-derived half stands down).
   * Operator-only (spec G9) — see the module doc comment above for how that
   * is enforced, not merely intended.
   */
  gradeHistogram: number[];
  relationsWritten: number;
  /** A `propose` call that landed a stored proposal. */
  proposalsCreated: number;
  /** Ticket 09: a `session`-addressed `note` call that landed (title and/or content). */
  sessionNarrativeWritten: number;
}

function emptyCommitCounts(): NoteSettlementCommitCounts {
  // A fresh array/object every call: this is mutated in place below, and a
  // shared reference would let every window this process ever commits
  // corrupt every other window's counts.
  return {
    turnsReviewed: 0,
    reviewsYieldedToLateNote: 0,
    gradeHistogram: [0, 0, 0, 0, 0],
    relationsWritten: 0,
    proposalsCreated: 0,
    sessionNarrativeWritten: 0,
  };
}

export interface CreateSettlementStagingEngineOptions {
  db: Database;
  context: SettlementTurnFacadeContext;
  /** Epoch seconds, injectable for tests; each call is stamped with its own reading. */
  now?: () => number;
}

type StagedEntry =
  | { kind: "note"; input: SettlementTurnWriteInput }
  | { kind: "membership"; input: SettlementMembershipWriteInput };

// ---------------------------------------------------------------------------
// Staging keys (spec A7a) — one canonical, kind-prefixed key per staged call
// shape, so a `note` on turn S3/T5 and a membership `assign` on the SAME turn
// (a legitimate, unrelated pair of facts) never collide, while two calls of
// the SAME shape naming the SAME address/pair/address-set always do.
// ---------------------------------------------------------------------------

/**
 * The staging key of a membership call, from the RAW input — no validation,
 * so a partial correction can find the entry it is correcting. `null` when
 * the call is malformed enough that no key exists; evaluation refuses it a
 * moment later, and the key is never used.
 *
 * `assign` is dead (ticket 05) — `propose` is the only action, keyed on its
 * address SET (sorted, so order never matters): a restated set (even with a
 * different title) corrects the same proposal; a different set is a
 * different cluster.
 */
function membershipStagingKeyOf(
  rawInput: SettlementMembershipWriteInput,
): string | null {
  if (!rawInput.addresses || rawInput.addresses.length === 0) {
    return null;
  }
  return proposeStagingKey(rawInput.addresses);
}

function noteStagingKey(ref: string): string {
  return `note:${ref}`;
}
function proposeStagingKey(addresses: readonly string[]): string {
  const normalized = [...addresses].map((raw) => raw.trim()).sort();
  return `propose:${JSON.stringify(normalized)}`;
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

/**
 * Thrown as the LAST statement of a preview's transaction, once the replay and
 * the gate have both passed — the throw is what rolls the whole attempt back
 * (ticket 11). A preview is a `commit` that answers and then undoes itself:
 * anything weaker would have to re-implement the gate against un-replayed
 * tables and would report gaps the agent has already staged the fix for, which
 * is precisely the drift spec G8 forbids ("the check cannot drift from the
 * gate: it IS the gate").
 */
class CommitPreviewComplete extends Error {}

/** Why a commit attempt refused, in the shape its caller needs to render it. */
type CommitRefusal =
  | { kind: "gate"; result: NoteSettlementCompletionResult }
  | { kind: "replay"; message: string }
  | { kind: "fence"; message: string };

type CommitAttempt =
  | { kind: "landed"; counts: NoteSettlementCommitCounts }
  | { kind: "refused"; refusal: CommitRefusal }
  | {
      /**
       * The completion check itself could not run (ticket 15 finding 5) — a
       * writer lock outlasted the preview's own bounded budget.
       * Preview-only: `attemptCommit(preview: false)` never produces this
       * arm (see its own catch clause), so `commit()` treats it as
       * unreachable defensively rather than as a real case to render.
       */
      kind: "indeterminate";
      message: string;
    };

/**
 * What a `commit` called RIGHT NOW would do, without doing it (ticket 11,
 * spec G2's first layer). The Stop hook is its only caller: an agent that
 * stops without committing has produced nothing, and this is what turns that
 * fact into an actionable sentence.
 */
export interface SettlementCommitPreview {
  /** Staged calls that would replay. Zero is not "nothing to do" — the gate still runs. */
  staged: number;
  /** True when a `commit` right now would land the window and complete the job. */
  wouldCommit: boolean;
  /** Commit's own refusal, in commit's own words; null when it would land. */
  refusal: string | null;
  /**
   * The lease is gone. No `commit` from this run can ever succeed, so telling
   * the agent to call one would be telling it to do the impossible — the same
   * distinction `commit`'s own refusal path draws (ticket 10d).
   */
  fenceLost: boolean;
  /**
   * The completion check itself could not run within its bounded budget
   * (ticket 15 finding 5) — a writer lock elsewhere outlasted it. Distinct
   * from `wouldCommit: false`: that states a real gate answer (a genuine gap
   * to fill); this states "unknown". `refusal` is null and `fenceLost` is
   * false here on purpose — there is nothing to quote and the lease is not
   * known to be lost, just unchecked.
   */
  checkFailed: boolean;
}

export interface SettlementStagingEngine {
  stageNoteWrite(rawInput: SettlementTurnWriteInput): ToolTextResult;
  stageMembershipWrite(rawInput: SettlementMembershipWriteInput): ToolTextResult;
  commit(): ToolTextResult;
  /**
   * `commit` without the commit (ticket 11) — the same replay and the same
   * gate, inside a transaction that always rolls back. NOT an MCP tool: the
   * settlement agent has no `check` (spec G8 amended, "the check folds into
   * commit"), and this exists for the Stop hook alone, which the model cannot
   * call either.
   */
  previewCommit(): SettlementCommitPreview;
  /** Test/inspection only — how many intents are currently staged. */
  pendingCount(): number;
  /**
   * `commit`'s own replay result (ticket 10c) — null until a commit actually
   * lands. NOT an MCP tool (see the module doc comment): the model can never
   * reach this, only `note-settlement-sdk-query.ts`'s own code, after the
   * model's run has already produced its final message.
   */
  getLastCommitMetrics(): NoteSettlementCommitCounts | null;
}

/**
 * `previewCommit`'s own connection-level busy_timeout (ticket 15 finding 5),
 * held for the duration of one preview attempt only. See the module doc
 * comment's "TICKET 15 FINDING 5'S REPAIR" paragraph for why this has to be
 * lower than `runHookWriteTransaction`'s own budget: without it, a single
 * blocked `BEGIN IMMEDIATE` can silently swallow the whole hook budget
 * before that budget's own JS-level clock ever gets a turn.
 */
const PREVIEW_LOCK_POLL_TIMEOUT_MS = 200;

function readBusyTimeoutMs(db: Database): number {
  return db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout ?? 0;
}

/**
 * `runHookWriteTransaction`, but with this connection's own `busy_timeout`
 * turned down for the call and restored in a `finally`. Safe to mutate a
 * shared connection's pragma like this because bun's sqlite calls are
 * synchronous — nothing else in this process can run between the lowering
 * and the restore.
 */
function runPreviewTransaction<T>(db: Database, fn: () => T): T {
  const priorBusyTimeoutMs = readBusyTimeoutMs(db);
  db.exec(`PRAGMA busy_timeout = ${PREVIEW_LOCK_POLL_TIMEOUT_MS};`);
  try {
    return runHookWriteTransaction(db, fn);
  } finally {
    db.exec(`PRAGMA busy_timeout = ${priorBusyTimeoutMs};`);
  }
}

/**
 * The completion gate is an EMPTY SHELL after ticket 05 (see
 * `db/note-settlement-completion.ts`'s module doc comment) — every reason it
 * can return is fence-shaped. `commit()`/`previewCommit()` below already
 * special-case the fence reasons on their own terms; this renders the same
 * fact in prose for the `CommitGateRefused` path.
 */
function describeGateRefusal(result: NoteSettlementCompletionResult): string {
  return "this dispatch's job lease was reclaimed; no further work will land. Stop making tool calls.";
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
  /** `commit`'s own last landed result (ticket 10c) — see `getLastCommitMetrics`. */
  let lastCommitMetrics: NoteSettlementCommitCounts | null = null;

  function stageNoteWrite(rawInput: SettlementTurnWriteInput): ToolTextResult {
    const nowEpoch = now();
    // Merge BEFORE validating, not after (spec A7a, field-level). Two things
    // ride on the order. The receipt must describe what is actually staged,
    // and after a merge that is the combination, not this call's own fields.
    // And a combination neither call would have passed alone — prose for a
    // turn this dispatch may not write prose for, arriving in a second call
    // that only names a grade — has to be refused here rather than at commit,
    // which is A7's whole "the agent learns while it can still act" rule.
    // Ticket 09: `rawInput.turn` is optional now (a `session`-addressed call
    // carries `rawInput.session` instead) — the staging key falls back to
    // whichever raw address token the call actually supplied.
    const address = rawInput.turn !== undefined ? parseTurnAddress(rawInput.turn) : null;
    const priorKey = noteStagingKey(
      address
        ? `S${address.sessionId}/T${address.promptNumber}`
        : (rawInput.session ?? rawInput.turn ?? ""),
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

  function stageMembershipWrite(rawInput: SettlementMembershipWriteInput): ToolTextResult {
    const nowEpoch = now();
    // Same field-level merge as `stageNoteWrite`, and merged before
    // validation for the same two reasons. The key has to be derivable from
    // the raw input alone — the address set — because a partial correction
    // is exactly what a merge exists to allow, and would not survive being
    // validated on its own first.
    const priorKey = membershipStagingKeyOf(rawInput);
    const prior = priorKey === null ? undefined : staged.get(priorKey);
    const mergedInput: SettlementMembershipWriteInput =
      prior?.kind === "membership" ? { ...prior.input, ...rawInput } : rawInput;

    const evaluation = evaluateSettlementMembershipWrite(db, context, mergedInput, nowEpoch, {
      apply: false,
    });
    if (!evaluation.ok) {
      return parameterError(evaluation.message);
    }

    const key = proposeStagingKey(rawInput.addresses ?? []);

    const replaced = staged.has(key);
    staged.set(key, { kind: "membership", input: mergedInput });
    return textResult(
      renderSettlementMembershipWriteReceipt(evaluation.outcome, { staged: true, replaced }),
    );
  }

  /**
   * One commit attempt — the replay, then the gate, in one transaction.
   *
   * `preview` (ticket 11) changes exactly one statement: the transaction is
   * rolled back at the end instead of committed. Everything before that is
   * the same code against the same tables, which is the point — a preview
   * that computed the answer differently would be a second gate, and the two
   * would drift toward whichever is looser.
   */
  function attemptCommit(nowEpoch: number, preview: boolean): CommitAttempt {
    // An empty snapshot is not special-cased: the gate still runs (an
    // earlier commit attempt may have landed everything already and only
    // failed the gate for a reason since fixed by other means), it just
    // replays nothing first. Map iteration order is insertion order.
    const snapshot = [...staged.values()];
    // A preview's transaction throws rather than returns, so its counts have
    // to leave the closure by assignment.
    let previewCounts: NoteSettlementCommitCounts | null = null;

    // A preview runs through `runHookWriteTransaction` with this connection's
    // busy_timeout turned down (ticket 15 finding 5); a real commit stays on
    // `runWriteTransaction` — see the module doc comment's "TICKET 15
    // FINDING 5'S REPAIR" paragraph.
    const transactionBody = (): { counts: NoteSettlementCommitCounts } => {
        // The fence, first statement (spec G6/G7) — guards EVERYTHING below,
        // the staged replay included. A lease reclaimed between staging and
        // commit throws here, before any staged write can land.
        assertNoteSettlementJobClaimed(db, context.jobId, context.claimGeneration);

        // Counted from what this replay ACTUALLY does below, not from a
        // payload the model sends — see `NoteSettlementCommitCounts`'s own
        // doc comment.
        const counts = emptyCommitCounts();
        for (const entry of snapshot) {
          if (entry.kind === "membership") {
            const evaluation = evaluateSettlementMembershipWrite(db, context, entry.input, nowEpoch, {
              apply: true,
            });
            if (!evaluation.ok) {
              throw new CommitReplayRefused(
                `propose ${entry.input.addresses?.join(",") ?? ""}: ${evaluation.message}`,
              );
            }
            counts.proposalsCreated += 1;
          } else {
            const evaluation = evaluateSettlementTurnWrite(db, context, entry.input, nowEpoch, {
              apply: true,
            });
            if (!evaluation.ok) {
              throw new CommitReplayRefused(`note ${entry.input.turn}: ${evaluation.message}`);
            }
            const outcome = evaluation.outcome;
            if (outcome.review) {
              counts.turnsReviewed += 1;
              if (outcome.review.kind === "yielded") {
                counts.reviewsYieldedToLateNote += 1;
              }
              // Grade always lands regardless of written/yielded — only the
              // note-derived half (type/tags) stands down on a late agent
              // note (see evaluateSettlementTurnWrite) — so the histogram
              // counts it unconditionally, same as the retired write-back did
              // when grade was a required field on every review directive.
              if (outcome.review.grade !== undefined) {
                counts.gradeHistogram[outcome.review.grade] =
                  (counts.gradeHistogram[outcome.review.grade] ?? 0) + 1;
              }
            }
            if (outcome.relations) {
              counts.relationsWritten += outcome.relations.written;
            }
            // Ticket 09: a `session`-addressed entry carries neither
            // `review` nor `relations` — its own count is separate, not
            // folded into `turnsReviewed` (a session narrative write is not
            // a turn review).
            if (outcome.session) {
              counts.sessionNarrativeWritten += 1;
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
        // `gate` itself is not returned: its only remaining fact,
        // `completed`, is true by construction past this point (the throw
        // above is the only other exit), so nothing after this needs it.
        if (preview) {
          // Everything above passed, so a real commit would land. Throwing
          // here is the rollback (ticket 11).
          previewCounts = counts;
          throw new CommitPreviewComplete();
        }
        return { counts };
    };

    try {
      const { counts } = preview
        ? runPreviewTransaction(db, transactionBody)
        : runWriteTransaction(db, transactionBody);

      return { kind: "landed", counts };
    } catch (error) {
      if (error instanceof CommitPreviewComplete) {
        return { kind: "landed", counts: previewCounts ?? emptyCommitCounts() };
      }
      // A refusal for ANY reason below leaves `staged` untouched (spec A7
      // requirement 7): the transaction rolled back, so nothing any entry
      // in `snapshot` would have written actually landed, and the agent's
      // existing staged work is exactly as good as it was before this call.
      if (error instanceof CommitGateRefused) {
        return { kind: "refused", refusal: { kind: "gate", result: error.result } };
      }
      if (error instanceof CommitReplayRefused) {
        return { kind: "refused", refusal: { kind: "replay", message: error.message } };
      }
      if (error instanceof NoteSettlementJobFenceError) {
        return { kind: "refused", refusal: { kind: "fence", message: error.message } };
      }
      // Ticket 15 finding 5: only a PREVIEW may answer "indeterminate" — a
      // real commit still propagates SQLITE_BUSY as before (the model sees a
      // tool-call error and may retry `commit` itself, same as any other
      // transient failure; out of this finding's scope).
      if (preview && isSqliteBusy(error)) {
        return {
          kind: "indeterminate",
          message: error instanceof Error ? error.message : "database busy",
        };
      }
      throw error;
    }
  }

  function commit(): ToolTextResult {
    const attempt = attemptCommit(now(), false);

    if (attempt.kind === "landed") {
      // Only a transaction that actually committed clears the staging —
      // everything the replay did is now durable, so replaying it again on a
      // later `commit` call would be redundant (and, for an `assign`,
      // pointless: `addSegmentMembers` is already idempotent, but there is
      // nothing left to re-land). The counts are kept, not cleared: they
      // describe what THIS commit did, for a caller that reads them only
      // after this call returns.
      staged.clear();
      lastCommitMetrics = attempt.counts;
      return textResult(
        `Committed. S${context.sessionId} window settled — job complete.`,
      );
    }

    // The gate is an empty shell after ticket 05 (see db/note-settlement-
    // completion.ts's module doc comment) — every `CommitGateRefused` it can
    // throw is fence-shaped (the job's lease is gone), so there is no
    // "genuinely fixable by staging more" gate refusal left to word
    // differently from a lost lease.
    if (attempt.kind === "indeterminate") {
      // Never actually reached: `attemptCommit`'s busy-catch only fires for
      // `preview === true` (see its own comment), and `commit()` always
      // calls with `false`. Handled explicitly so this stays a real
      // exhaustiveness check rather than an unsound cast.
      throw new Error(
        `unreachable: commit() attempt reported indeterminate (${attempt.message})`,
      );
    }
    const { refusal } = attempt;
    if (refusal.kind === "gate") {
      return textResult(`Commit refused — ${describeGateRefusal(refusal.result)}`);
    }
    if (refusal.kind === "replay") {
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
        `Commit refused — ${refusal.message} Staging kept: re-stage the SAME call ` +
          "(same key) with corrected input, then call commit again — a stale " +
          "staged entry is not dropped automatically.",
      );
    }
    return textResult(
      `Commit refused — this dispatch's job lease was reclaimed (${refusal.message}). ` +
        "No further commit will succeed. Stop making tool calls.",
    );
  }

  function previewCommit(): SettlementCommitPreview {
    const attempt = attemptCommit(now(), true);
    const stagedCount = staged.size;

    if (attempt.kind === "landed") {
      return {
        staged: stagedCount,
        wouldCommit: true,
        refusal: null,
        fenceLost: false,
        checkFailed: false,
      };
    }
    if (attempt.kind === "indeterminate") {
      // Ticket 15 finding 5: the gate never ran — the lock outlasted the
      // preview's own bounded budget. `refusal`/`fenceLost` state a real
      // gate answer, which this is not, so both stay at their "nothing to
      // report" values; `checkFailed` is the only signal the Stop hook acts
      // on for this case.
      return {
        staged: stagedCount,
        wouldCommit: false,
        refusal: null,
        fenceLost: false,
        checkFailed: true,
      };
    }
    const { refusal } = attempt;
    if (refusal.kind === "gate") {
      const fenceLost =
        refusal.result.reason === "not-claimed" ||
        refusal.result.reason === "generation-mismatch";
      return {
        staged: stagedCount,
        wouldCommit: false,
        refusal: describeGateRefusal(refusal.result),
        fenceLost,
        checkFailed: false,
      };
    }
    if (refusal.kind === "replay") {
      return {
        staged: stagedCount,
        wouldCommit: false,
        refusal: refusal.message,
        fenceLost: false,
        checkFailed: false,
      };
    }
    return {
      staged: stagedCount,
      wouldCommit: false,
      refusal:
        "this dispatch's job lease was reclaimed; no further work will land. " +
        "Stop making tool calls.",
      fenceLost: true,
      checkFailed: false,
    };
  }

  return {
    stageNoteWrite,
    stageMembershipWrite,
    commit,
    previewCommit,
    pendingCount: () => staged.size,
    getLastCommitMetrics: () => lastCommitMetrics,
  };
}
