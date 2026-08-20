import type { Database } from "bun:sqlite";

import { runWriteTransaction } from "./database";
import { closePendingNoteDebtsAsClosed, realPromptPredicate } from "./note-debt";
import {
  DEFAULT_NOTE_SETTLEMENT_BACKFILL_MAX_TURNS,
  DEFAULT_NOTE_SETTLEMENT_CAP_TURNS,
  DEFAULT_NOTE_SETTLEMENT_THRESHOLD_TURNS,
} from "../shared/config";

/**
 * P2 note settlement, persistence half (spec D9, ticket 05).
 *
 * The unit of work is a WINDOW of one session's prompt numbers, and the whole
 * module exists to make "which turns does this settle" a durable, frozen fact
 * rather than something recomputed on every attempt. Four invariants carry it:
 *
 *   - a window never reaches back before the ERA. A legacy turn's record was
 *     written by the extraction agent, not by the turn itself, so there is
 *     nothing there for settlement to read; the floor is the session's last
 *     pre-era prompt number, which for a session that straddles the cutover is
 *     also the value its cursor is born holding;
 *   - a window is cut from the DECIDED CONTIGUOUS PREFIX only. A turn is decided
 *     when the note-debt ledger has finished with it (`noted`/`skipped`) or
 *     never opened a debt for it (trivial turns leave no row by design). The
 *     first still-`pending` debt stops the prefix, so a window never contains a
 *     turn whose note might still arrive;
 *   - windows never overlap, because the next one starts after
 *     max(cursor, highest enqueued window_end). Two triggers racing to the same
 *     boundary therefore produce two ADJACENT windows, not two claims on the
 *     same turns — spec's "同一 turn 只属一个窗口";
 *   - attempts are consumed AT CLAIM, so a worker that dies holding a lease has
 *     still spent one. Ticket 06 (read-write-contract spec "重试") splits what
 *     happens next by failure CLASS: a deterministic failure counts against
 *     the cap (`NOTE_SETTLEMENT_MAX_ATTEMPTS`, "1+1" — two deaths exhaust the
 *     job) and the reclaim path respects it instead of resurrecting a third
 *     attempt; a transient one (network/connection/SQLITE_BUSY,
 *     `failNoteSettlementJob`'s own doc comment) gives the spent attempt back
 *     and never counts toward the cap at all — see that function for the full
 *     split. A lease that expires with NO report at all (the claimant simply
 *     vanished) is treated as the conservative, deterministic case;
 *   - `claim_generation` rises on EVERY transition out of `claimed`, not only on
 *     a fresh claim. Ownership ends when the row stops being claimed — by
 *     reclamation or by terminalisation — and a fence that only moved on the
 *     next claim would leave a window in which the displaced dispatch's late
 *     write-back still matched, resurrecting a terminal job to `done` and
 *     walking the cursor over a window nobody settled;
 *   - the cursor advances across CONSECUTIVE RESOLVED windows, where resolved
 *     includes terminally `failed` (a legacy row, pre-ticket-06) and
 *     `abandoned` (a deterministic failure that spent its capped attempts,
 *     ticket 06). Abandon and continue: parking the cursor on a dead window
 *     would wedge every later window behind it forever.
 *
 * Deliberately NOT the same table as `settlement_jobs` — see the schema comment.
 */

/**
 * Decided turns that must accumulate before turn-stop planning cuts a window
 * ([S15069/T963], ticket 04 — replaces the old fixed 50-turn block).
 *
 * Re-exported from shared/config.ts's `DEFAULT_NOTE_SETTLEMENT_THRESHOLD_TURNS`
 * (ticket 02, [S15069/T1017]): the number now has one home, config-tunable,
 * and this stays a valid import path so nothing else in the codebase moves.
 */
export const NOTE_SETTLEMENT_WINDOW_THRESHOLD_TURNS =
  DEFAULT_NOTE_SETTLEMENT_THRESHOLD_TURNS;

/**
 * Per-run cap on a single window's turn count. A run that has accumulated more
 * than this cuts the cap and leaves the remainder pending for the next trigger
 * (60 accumulated → one 50-turn window, 10 left over) rather than growing the
 * window without bound.
 *
 * Re-exported from shared/config.ts's `DEFAULT_NOTE_SETTLEMENT_CAP_TURNS`
 * (ticket 02) — see `NOTE_SETTLEMENT_WINDOW_THRESHOLD_TURNS` above.
 */
export const NOTE_SETTLEMENT_WINDOW_CAP_TURNS = DEFAULT_NOTE_SETTLEMENT_CAP_TURNS;

/**
 * Floor on a residual window — a closed session's leftover, cut outside the
 * turn-stop tiling. Settling six turns costs a whole inference to produce
 * almost no arc. Below the floor nothing is written at all and the session is
 * left exactly as it was, to be picked up once more turns (or more idle time)
 * change the picture.
 *
 * A suggested value, exported rather than configured: it is a payload-shape
 * judgement the offline eval can recalibrate, not a knob a user should turn.
 */
export const NOTE_SETTLEMENT_MIN_WINDOW_TURNS = 20;

/**
 * Hard cap on a single manual backfill window (ticket 04, [S15069/T963]):
 * `/settle` takes no lookback and reaches back past the monotonic floor on
 * purpose, so nothing else bounds how much history one call could re-grade in
 * one inference. Over the cap the call is refused outright (`backfill_too_large`)
 * rather than silently clamped — an operator re-settling history states the
 * range they mean, and a silently truncated window would settle less than the
 * receipt implies.
 *
 * Re-exported from shared/config.ts's `DEFAULT_NOTE_SETTLEMENT_BACKFILL_MAX_TURNS`
 * (ticket 02) — see `NOTE_SETTLEMENT_WINDOW_THRESHOLD_TURNS` above.
 */
export const NOTE_SETTLEMENT_BACKFILL_MAX_TURNS =
  DEFAULT_NOTE_SETTLEMENT_BACKFILL_MAX_TURNS;

/** A `claimed` job older than this is presumed dead and returns to `pending`. */
export const NOTE_SETTLEMENT_LEASE_MS = 10 * 60 * 1000;

/**
 * Ticket 06 (read-write-contract spec, "重试"): the DETERMINISTIC failure
 * cap — "确定性失败上限 1 次…1+1 后弃窗" reads as one retry after the first
 * failure, so this is 2 total attempts, not 1. Once a claim's attempts reach
 * this AND the failure that spent the last one was deterministic, the job
 * goes `abandoned` with a debt row rather than back to `pending`.
 *
 * This cap governs the DETERMINISTIC class only. A transient failure
 * (network/connection/SQLITE_BUSY) never counts against it at all —
 * `failNoteSettlementJob`'s transient branch gives the spent attempt BACK
 * (same mechanism `releaseNoteSettlementJobClaim` already uses for a
 * graceful exit), so a job that fails transiently over and over never
 * approaches this number.
 *
 * The old uniform "claim increments attempts, backoff always, cap 3 for any
 * failure" semantics are retired by this same ticket — see
 * `failNoteSettlementJob`'s own doc comment for the two-class replacement.
 */
export const NOTE_SETTLEMENT_MAX_ATTEMPTS = 2;

/** First backoff step; doubles per consumed attempt (60s / 120s). Deterministic failures only — see `failNoteSettlementJob`. */
export const NOTE_SETTLEMENT_RETRY_BASE_MS = 60_000;

export type NoteSettlementFailureClass = "transient" | "deterministic";

/** Idle age past which an unregistered session counts as closed (R2#3). */
export const NOTE_SETTLEMENT_RESIDUAL_IDLE_MS = 24 * 60 * 60 * 1000;

/** Closed sessions one trigger may pick up, oldest first (裁决 11). */
export const NOTE_SETTLEMENT_RESIDUAL_PER_TRIGGER = 2;

/**
 * Why a window exists — and, for `backfill`, the one thing that distinguishes
 * it from every other window.
 *
 * `consecutive` (turn-stop planning) and `residual` (the closed-session scan)
 * are the two AUTOMATIC trigger types left (ticket 04, [S15069/T963]): some
 * event derived the window from the session's own state, and the two of them
 * tile a session's post-era turns monotonically forward, each starting past
 * the last one enqueued.
 *
 * `compact` and `sessionend` are RETIRED as automatic triggers by the same
 * ticket — nothing derives one any more — but both remain legal values here:
 * historical rows from before the retarget carry them, and the vocabulary
 * itself is schema, not planner behaviour. `planNoteSettlementWindows` no
 * longer accepts either.
 *
 * `backfill` is the operator's explicit re-settlement of a range that has
 * ALREADY been covered — turns settled by a build whose payload never graded
 * them, say. It is the only trigger permitted to reach back below the monotonic
 * floor, and the trigger type IS that permission: there is no second flag to
 * disagree with it, so a window that says it is a backfill is exactly a window
 * exempt from the floor. Nothing derives one; only an explicit caller
 * (`enqueueBackfillNoteSettlementJob`, reached from the worker's `POST /settle`)
 * ever creates one, which is why `NoteSettlementWindowPlan`'s own `triggerType`
 * excludes it at the type level rather than by convention.
 */
export type NoteSettlementTrigger =
  | "consecutive"
  | "compact"
  | "residual"
  | "sessionend"
  | "backfill";
export type NoteSettlementJobStatus =
  | "pending"
  | "claimed"
  | "done"
  | "failed"
  | "abandoned";

export interface NoteSettlementJob {
  id: number;
  sessionId: number;
  /** Inclusive first prompt_number of the frozen window. */
  windowStart: number;
  /** Inclusive last prompt_number of the frozen window. */
  windowEnd: number;
  triggerType: NoteSettlementTrigger;
  status: NoteSettlementJobStatus;
  attempts: number;
  /** Epoch seconds before which this job is not claimable. */
  retryAtEpoch: number;
  claimedAtEpoch: number | null;
  claimGeneration: number;
  lastError: string | null;
  /** Ticket 06: which class the LAST recorded failure belongs to; null until one has landed. */
  failureClass: NoteSettlementFailureClass | null;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

/**
 * Why a window was not written. Every structural refusal settlement can issue,
 * in one closed set — the operator's `POST /settle` maps it exhaustively, and
 * the automatic callers discard it.
 */
export type NoteSettlementInsertRefusal =
  /** `window_end < window_start` — not a window at all. */
  | "inverted_range"
  /** A `backfill` wider than `NOTE_SETTLEMENT_BACKFILL_MAX_TURNS`. */
  | "backfill_too_large"
  /**
   * At or below the session's last pre-era prompt number. Never exempt on any
   * automatic path; the ONE crossing is a manual backfill whose operator said
   * `allow_pre_era` explicitly — a pre-era window re-settled whole is regraded
   * into current semantics, so the mixing this floor guards against cannot
   * occur inside it.
   */
  | "below_era_floor"
  /** Below max(cursor, highest enqueued window_end). `backfill` is exempt. */
  | "below_window_floor"
  /** UNIQUE(session_id, window_start, trigger_type) already holds this window. */
  | "duplicate_window";

export type InsertNoteSettlementJobResult =
  | { ok: true; job: NoteSettlementJob }
  | { ok: false; reason: NoteSettlementInsertRefusal };

/**
 * A window the planner would cut, before anything is written.
 *
 * `triggerType` is the literal `"consecutive"` (ticket 04, [S15069/T963]):
 * turn-stop planning is the ONLY automatic trigger now — `compact` and
 * `sessionend` no longer derive or narrow a window at all, and `residual`/
 * `backfill` are excluded for the same reason they always were, neither is
 * ever DERIVED (a residual is built by its own scan, a backfill only ever
 * comes from an explicit operator call). Pinning the field to one literal is
 * what makes "the automatic planner only ever emits `consecutive`" a
 * compile-time fact rather than a test's hope.
 */
export interface NoteSettlementWindowPlan {
  sessionId: number;
  windowStart: number;
  windowEnd: number;
  triggerType: "consecutive";
}

const JOB_COLUMNS = `
    id,
    session_id AS sessionId,
    window_start AS windowStart,
    window_end AS windowEnd,
    trigger_type AS triggerType,
    status,
    attempts,
    retry_at_epoch AS retryAtEpoch,
    claimed_at_epoch AS claimedAtEpoch,
    claim_generation AS claimGeneration,
    last_error AS lastError,
    failure_class AS failureClass,
    created_at_epoch AS createdAtEpoch,
    updated_at_epoch AS updatedAtEpoch`;

const JOB_SELECT = `SELECT${JOB_COLUMNS} FROM note_settlement_jobs`;

export function getNoteSettlementJob(
  db: Database,
  jobId: number,
): NoteSettlementJob | null {
  return (
    db
      .query<NoteSettlementJob, [number]>(`${JOB_SELECT} WHERE id = ?`)
      .get(jobId) ?? null
  );
}

export function listNoteSettlementJobs(
  db: Database,
  sessionId: number,
): NoteSettlementJob[] {
  return db
    .query<NoteSettlementJob, [number]>(
      `${JOB_SELECT} WHERE session_id = ? ORDER BY window_start ASC, id ASC`,
    )
    .all(sessionId);
}

export function countNoteSettlementJobs(db: Database): number {
  return (
    db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM note_settlement_jobs",
      )
      .get()?.count ?? 0
  );
}

export function getNoteSettlementCursor(
  db: Database,
  sessionId: number,
): number {
  return (
    db
      .query<{ cursor: number }, [number]>(
        `SELECT last_settled_prompt_number AS cursor
         FROM note_settlement_cursors WHERE session_id = ?`,
      )
      .get(sessionId)?.cursor ?? 0
  );
}

/**
 * The last prompt number this session ran BEFORE the era, or 0 if it ran none.
 *
 * Settlement's floor (spec D11/D12, ticket 14). It is a MAX over prompt numbers
 * rather than a per-turn filter because a window is a contiguous range: bounding
 * the range at the highest pre-era prompt number is what makes "no pre-era turn
 * is inside it" true of the whole window, and it is what stops the switch-on
 * from grinding every historical session through an inference.
 */
export function getEraFloorPromptNumber(
  db: Database,
  sessionId: number,
  eraCutoffEpoch: number,
): number {
  return (
    db
      .query<{ floor: number | null }, [number, number]>(
        `SELECT MAX(prompt_number) AS floor FROM turns
         WHERE session_id = ? AND created_at_epoch < ?`,
      )
      .get(sessionId, eraCutoffEpoch)?.floor ?? 0
  );
}

/**
 * The last prompt_number of this session's contiguous ALREADY-FINISHED prefix
 * as of the one-time settlement transition (spec D8, tickets 05 + 09,
 * [S15069/T1124]) — 0 when the session has no row, which covers all three of
 * "born after the transition", "its first turn was still unfinished", and "the
 * database has not run the transition yet".
 *
 * A stored lookup, not a derivation, and that is forced rather than chosen:
 * `turns.status` is mutable, so once an `active`/`provisional` turn finishes,
 * nothing in the turns table still records that it was unfinished at the
 * transition. The migration computes the prefix once
 * (`ensureNoteSettlementWatermark`, db/schema.ts) and this reads it back.
 *
 * Ticket 09 replaced the global `MAX(turns.id)` this shipped with. That form
 * asked "did the turn EXIST at the transition", which walled a turn that was
 * merely mid-flight out of automatic settlement permanently, even after it
 * finished normally. The question the spec actually asks is "was it FINISHED",
 * and no single global boundary can answer it: one database holds sessions
 * whose low prompt numbers were unfinished alongside sessions whose high ones
 * were already done, so the answer is per-session or it is wrong.
 *
 * Same shape as `getEraFloorPromptNumber` above otherwise: one contiguous
 * boundary rather than a per-turn filter, because the floor a WINDOW needs is
 * contiguous-range, not per-turn.
 */
export function getNoteSettlementWatermarkFloorPromptNumber(
  db: Database,
  sessionId: number,
): number {
  return (
    db
      .query<{ floor: number }, [number]>(
        `SELECT finished_prompt_number AS floor
         FROM note_settlement_watermark_floors WHERE session_id = ?`,
      )
      .get(sessionId)?.floor ?? 0
  );
}

/**
 * Where the next window begins: one past the latest of the cursor, the highest
 * window already enqueued, the era floor, and the transition watermark floor.
 *
 * Consulting the enqueued windows and not just the cursor is what keeps windows
 * disjoint while a job is still open — the cursor deliberately does not move
 * until a window RESOLVES, so a second trigger arriving mid-flight would
 * otherwise cut a window over turns the in-flight job already owns.
 *
 * The era floor is consulted independently of the cursor row rather than only
 * through it: a session settlement has never written about has no cursor row at
 * all, and deriving the bound is what lets the below-threshold trigger stay a
 * pure read (see `planNoteSettlementWindows`). The watermark floor (spec D8,
 * ticket 05) joins it here for the same reason and the same exemption shape:
 * folding it into THIS bound rather than giving it its own dedicated check in
 * `insertJob` (the way the era floor gets `below_era_floor`) is deliberate —
 * the watermark is backfill-exempt exactly the way the monotonic floor
 * already is, never universal the way the era floor is, so it belongs beside
 * the terms that already share that exemption rather than beside the one
 * that does not.
 *
 * `backfill` rows are excluded, for the same reason they are excluded from the
 * cursor walk: this bound exists to keep the AUTOMATIC tiling disjoint, and a
 * backfill is by definition a window that overlaps it. Counting one here would
 * let an operator re-settling history push the automatic floor past turns no
 * automatic window has covered yet — the turns between the backfill's end and
 * the tiling's own next start would then never be planned at all. One rule,
 * both derivations: a backfill is invisible to the automatic sequence.
 */
export function getNoteSettlementWindowStart(
  db: Database,
  sessionId: number,
  eraCutoffEpoch: number,
): number {
  const highestEnqueued =
    db
      .query<{ windowEnd: number | null }, [number]>(
        `SELECT MAX(window_end) AS windowEnd FROM note_settlement_jobs
         WHERE session_id = ? AND trigger_type != 'backfill'`,
      )
      .get(sessionId)?.windowEnd ?? 0;
  return (
    Math.max(
      getNoteSettlementCursor(db, sessionId),
      highestEnqueued ?? 0,
      getEraFloorPromptNumber(db, sessionId, eraCutoffEpoch),
      getNoteSettlementWatermarkFloorPromptNumber(db, sessionId),
    ) + 1
  );
}

/**
 * Create this session's cursor row at the era boundary, once.
 *
 * The cursor says "settlement has dealt with everything through here", and for a
 * session that straddles the cutover the truthful birth value is its last legacy
 * turn: nothing at or below it will ever be settled. INSERT OR IGNORE, so a
 * cursor that has already advanced is never pulled back to the boundary.
 */
export function ensureNoteSettlementCursor(
  db: Database,
  sessionId: number,
  eraCutoffEpoch: number,
  nowEpoch: number,
): void {
  db.query<unknown, [number, number, number, number]>(
    `INSERT OR IGNORE INTO note_settlement_cursors (
       session_id, last_settled_prompt_number, updated_at_epoch
     )
     SELECT ?, COALESCE(
       (SELECT MAX(prompt_number) FROM turns
        WHERE session_id = ? AND created_at_epoch < ?), 0
     ), ?`,
  ).run(sessionId, sessionId, eraCutoffEpoch, nowEpoch);
}

/**
 * The session's highest REAL prompt number (note-debt.ts's
 * `realPromptPredicate`, spec D1/D10 — reused rather than re-derived here).
 *
 * A sidechain row is born `undone` with a HIGHER prompt number than the root
 * turn dispatching it, so an unfiltered MAX would inflate every reader of this
 * function — `getDecidedPrefixEnd` (whose `ended = MAX - 1` would then land on
 * the still-running root turn itself, one short of covering the phantom
 * sidechain slot) chief among them. Either way a turn still actively running
 * its subagent would be pulled into a settlement window mid-flight (P1-1).
 */
export function getMaxPromptNumber(db: Database, sessionId: number): number {
  return (
    db
      .query<{ maxPromptNumber: number | null }, [number]>(
        `SELECT MAX(t.prompt_number) AS maxPromptNumber FROM turns t
         WHERE t.session_id = ? AND ${realPromptPredicate("t")}`,
      )
      .get(sessionId)?.maxPromptNumber ?? 0
  );
}

/**
 * Last prompt_number of the contiguous DECIDED prefix starting at `windowStart`,
 * under the shared prompt-clock default (spec D10, ticket 05): a turn has ended
 * once a LATER prompt exists, full stop — the highest ended turn is always one
 * behind the session's current max, so the current (open) turn is excluded by
 * construction. This is the ONLY bound `planNoteSettlementWindows` uses now
 * (ticket 04, [S15069/T963]) — the `compact`/`sessionend` narrowing this
 * function used to feed is retired along with those two triggers.
 *
 * The note-debt classification cursor and the first-still-`pending`-debt
 * truncation are BOTH gone: owed notes are a derived query now (03), `note_debt`
 * no longer gates what a window may contain, and a stray legacy `pending` row
 * left by the one-time migration cleanup (06) must not wedge a window that has
 * otherwise moved on (spec D10's "含存量 pending 历史的会话窗口照常推进").
 *
 * Returns `windowStart - 1` (an EMPTY window) when the session has not even
 * reached `windowStart` yet.
 */
export function getDecidedPrefixEnd(
  db: Database,
  sessionId: number,
  windowStart: number,
): number {
  const ended = getMaxPromptNumber(db, sessionId) - 1;
  return Math.max(windowStart - 1, ended);
}

export interface NoteSettlementWindowOptions {
  /**
   * The era boundary, and required for that reason: there is no such thing as
   * planning a window without one, so the type says so rather than a comment.
   */
  eraCutoffEpoch: number;
  thresholdTurns?: number;
  capTurns?: number;
}

/**
 * The windows turn-stop planning would cut, computed with READS ONLY.
 *
 * Ticket 04 ([S15069/T963]) retargets the trigger: turn-stop planning is the
 * ONLY automatic trigger now. `compact` and `sessionend` no longer derive or
 * enqueue a window at all — settlement reads the database, never live
 * context, so a compact's repaired boundary and a session's live end carry no
 * information this planner needs, and check-natured work does not need
 * either event's immediacy. The accepted consequence: a session that ends
 * with fewer than `thresholdTurns` undecided-tail turns leaves that tail
 * unsettled until enough MORE turns (this session's own later turn-stop, or
 * the residual scan once it reads as closed) push it over the threshold.
 *
 * Separating the plan from the write is what makes the below-threshold case
 * cost nothing: a turn-stop that has not reached the threshold returns an
 * empty plan and never opens a transaction, so the overwhelmingly common
 * event leaves no trace in the database at all.
 *
 * Once the threshold is cleared, windows are cut greedily up to the cap: each
 * iteration takes `min(capTurns, remaining)` turns, so 60 accumulated decided
 * turns cut one 50-turn window and leave 10 — pending, not lost — for the
 * next trigger, rather than growing an unbounded single window or holding the
 * cap's own remainder back the way the old fixed-size block did.
 */
export function planNoteSettlementWindows(
  db: Database,
  sessionId: number,
  options: NoteSettlementWindowOptions,
): NoteSettlementWindowPlan[] {
  const thresholdTurns =
    options.thresholdTurns ?? NOTE_SETTLEMENT_WINDOW_THRESHOLD_TURNS;
  const capTurns = options.capTurns ?? NOTE_SETTLEMENT_WINDOW_CAP_TURNS;

  let windowStart = getNoteSettlementWindowStart(
    db,
    sessionId,
    options.eraCutoffEpoch,
  );
  const prefixEnd = getDecidedPrefixEnd(db, sessionId, windowStart);
  const plans: NoteSettlementWindowPlan[] = [];

  while (prefixEnd - windowStart + 1 >= thresholdTurns) {
    const windowSize = Math.min(capTurns, prefixEnd - windowStart + 1);
    const windowEnd = windowStart + windowSize - 1;
    plans.push({
      sessionId,
      windowStart,
      windowEnd,
      triggerType: "consecutive",
    });
    windowStart = windowEnd + 1;
  }

  return plans;
}

/**
 * Insert one job, re-deriving the disjointness bound INSIDE the caller's
 * transaction and refusing any window that reaches back over turns another job
 * already owns.
 *
 * Planning is a read and enqueueing is a write, and the two are not one atomic
 * step. Today nothing can interleave them (one JS worker, no await between), so
 * this is a guard against a second writer rather than a live bug — but the
 * UNIQUE key is (session, window_start, trigger_type), which means two plans of
 * DIFFERENT trigger types are free to claim the same turns without the
 * constraint noticing. First writer wins (先到先得); the loser's turns are not
 * dropped, they are simply re-planned from the new bound at the next trigger.
 *
 * Refusing rather than clipping is deliberate: a clipped window can fall under
 * the minimum-window floor, and the floor is the planner's judgement to make.
 *
 * A `backfill` is floored on the ERA BOUNDARY ALONE. The monotonic bound above
 * is derived from `MAX(window_end)` over the session's own jobs, so it can only
 * ever rise and a historical window is simply unexpressible under it — which is
 * the whole reason `backfill` exists. What does NOT yield is the era: a pre-era
 * turn's record was written by the extraction agent under legacy grading
 * semantics, and letting a window straddle the cutover would mix the two
 * vocabularies in one payload. A backfill may revisit settled ground; it may
 * never cross the era boundary. `windowEnd < windowStart` is refused for every
 * type, backfill included — an inverted range is not a window at all.
 *
 * Returns WHY it refused rather than a bare null. Every caller but one throws
 * the reason away, and that one (`enqueueBackfillNoteSettlementJob`, the
 * operator's path) is the reason it exists: "nothing happened" is not something
 * a human driving a backfill can act on. Naming the refusal HERE rather than
 * re-deriving it in the operator's wrapper is what keeps each guard to a single
 * home — a second copy of the era check in the wrapper could disagree with this
 * one, and only one of them would be the guard that actually holds.
 */
function insertJob(
  db: Database,
  sessionId: number,
  windowStart: number,
  windowEnd: number,
  triggerType: NoteSettlementTrigger,
  nowEpoch: number,
  eraCutoffEpoch: number,
  options: { allowPreEra?: boolean; maxTurns?: number } = {},
): InsertNoteSettlementJobResult {
  if (windowEnd < windowStart) {
    return { ok: false, reason: "inverted_range" };
  }
  // Backfill's own size ceiling (ticket 04): no lookback and no monotonic
  // floor to bound it, so this is the one guard standing between an operator
  // and re-grading an unbounded stretch of history in a single inference.
  // Checked alongside `inverted_range` because it is the same kind of guard —
  // a property of the RANGE ITSELF, true or false before any DB state enters
  // the picture — rather than a derived floor like the two below.
  //
  // `options.maxTurns` (ticket 02): the operator surface's own cap comes from
  // config now, not the compiled-in default — but the fallback keeps every
  // caller that never passed it (every automatic path, and every legacy test)
  // exactly as it was.
  if (
    triggerType === "backfill" &&
    windowEnd - windowStart + 1 > (options.maxTurns ?? NOTE_SETTLEMENT_BACKFILL_MAX_TURNS)
  ) {
    return { ok: false, reason: "backfill_too_large" };
  }
  // `allowPreEra` reaches here only from the manual backfill wrapper — no
  // automatic caller passes options at all. The floor's rationale (legacy
  // grades must not mix into a post-era window) does not survive an explicit
  // re-settlement: the whole window is regraded into current semantics, so
  // what the operator asked for is precisely "stop treating these as legacy".
  if (
    options.allowPreEra !== true &&
    windowStart <= getEraFloorPromptNumber(db, sessionId, eraCutoffEpoch)
  ) {
    return { ok: false, reason: "below_era_floor" };
  }
  // The monotonic floor, and the ONE thing a backfill is exempt from. The era
  // floor above is checked first and separately for exactly that reason: it
  // applies to every type, this does not.
  if (
    triggerType !== "backfill" &&
    windowStart < getNoteSettlementWindowStart(db, sessionId, eraCutoffEpoch)
  ) {
    return { ok: false, reason: "below_window_floor" };
  }
  const job =
    db
      .query<
        NoteSettlementJob,
        [number, number, number, string, number, number]
      >(
        `INSERT OR IGNORE INTO note_settlement_jobs (
           session_id, window_start, window_end, trigger_type,
           status, attempts, retry_at_epoch,
           created_at_epoch, updated_at_epoch
         ) VALUES (?, ?, ?, ?, 'pending', 0, 0, ?, ?)
         RETURNING${JOB_COLUMNS}`,
      )
      .get(sessionId, windowStart, windowEnd, triggerType, nowEpoch, nowEpoch) ??
    null;
  if (job && triggerType !== "backfill") {
    // The first job is the first moment settlement writes anything about this
    // session, and therefore the place its cursor is born — at the era boundary,
    // so the row states outright that the legacy prefix is out of scope. Written
    // only on a job that landed: a refused window leaves no trace at all.
    //
    // A backfill is excluded because the cursor means "everything at or below
    // here is resolved" and a backfill asserts nothing of the kind. On a session
    // settlement has never touched, `ensureNoteSettlementCursor` would create the
    // row at the era boundary and so move the READ value from 0 up to the last
    // legacy prompt — a forward move bought by an out-of-band window rather than
    // by the automatic sequence that owns the cursor.
    ensureNoteSettlementCursor(db, sessionId, eraCutoffEpoch, nowEpoch);
  }
  if (!job) {
    // Every structural guard above passed, so the only thing left that can
    // swallow the row is UNIQUE(session_id, window_start, trigger_type).
    return { ok: false, reason: "duplicate_window" };
  }
  return { ok: true, job };
}

/**
 * Insert every plan against the disjointness bound, WITHOUT opening its own
 * transaction — callers that are already inside one (`planAndEnqueueNoteSettlementWindows`)
 * call this directly; `enqueueNoteSettlementWindows` below wraps it in one for
 * callers that are not.
 */
function insertJobs(
  db: Database,
  plans: readonly NoteSettlementWindowPlan[],
  nowEpoch: number,
  eraCutoffEpoch: number,
): NoteSettlementJob[] {
  const created: NoteSettlementJob[] = [];
  for (const plan of plans) {
    const result = insertJob(
      db,
      plan.sessionId,
      plan.windowStart,
      plan.windowEnd,
      plan.triggerType,
      nowEpoch,
      eraCutoffEpoch,
    );
    if (result.ok) {
      created.push(result.job);
    }
  }
  return created;
}

/** Persist a plan. Idempotent through UNIQUE(session, window_start, trigger). */
export function enqueueNoteSettlementWindows(
  db: Database,
  plans: readonly NoteSettlementWindowPlan[],
  nowEpoch: number,
  eraCutoffEpoch: number,
): NoteSettlementJob[] {
  if (plans.length === 0) {
    return [];
  }
  return runWriteTransaction(db, () => insertJobs(db, plans, nowEpoch, eraCutoffEpoch));
}

/**
 * Plan and enqueue in ONE write transaction (spec D7, P1-4).
 *
 * `planNoteSettlementWindows` is a bare read and `enqueueNoteSettlementWindows`
 * opens its own separate write transaction — calling them back to back (as
 * `runTrigger` in worker/note-settlement.ts still does for its FIRST, gate-only
 * read) leaves a window between the read and the write in which a concurrent
 * writer — another turn-stop for the SAME session, racing in from a different
 * process — can land its own job. `insertJob`'s freshness check then refuses
 * the now-stale plan WHOLE rather than shrinking it to the remainder: nothing
 * recomputes a smaller replacement, so the turns between the concurrent job's
 * end and this plan's original end are not covered by THIS call — but unlike
 * the retired `sessionend` race, turn-stop planning always gets a next chance:
 * the very next turn-stop for this session re-derives from the new bound and
 * picks the remainder up.
 *
 * `BEGIN IMMEDIATE` (via `runWriteTransaction`) is what closes this: once this
 * transaction starts, no other writer can commit anything about this session
 * until it finishes, so the plan computed inside it is always read against
 * whatever the LAST committed writer left — never a state that goes stale
 * mid-call.
 */
export function planAndEnqueueNoteSettlementWindows(
  db: Database,
  sessionId: number,
  nowEpoch: number,
  options: NoteSettlementWindowOptions,
): NoteSettlementJob[] {
  return runWriteTransaction(db, () => {
    const plans = planNoteSettlementWindows(db, sessionId, options);
    if (plans.length === 0) {
      return [];
    }
    return insertJobs(db, plans, nowEpoch, options.eraCutoffEpoch);
  });
}

export interface ResidualNoteSettlementCandidate {
  sessionId: number;
  windowStart: number;
  windowEnd: number;
  lastActivityEpoch: number;
  /** Turns the window would cover; the dispatch predicate reads this. */
  residualTurns: number;
}

export interface ListResidualNoteSettlementOptions {
  /**
   * Session db ids this scan must never return: those with a live env
   * registration (never residual by definition), plus any the caller is already
   * settling this pass and must not double-count against its budget.
   */
  activeSessionIds: ReadonlySet<number>;
  nowEpoch: number;
  /** The era boundary, floor of every derived window — see the window start. */
  eraCutoffEpoch: number;
  idleMs?: number;
  minWindowTurns?: number;
  limit?: number;
}

/**
 * Closed sessions carrying enough unsettled turns to be worth an inference,
 * oldest first (裁决 11).
 *
 * "Closed" is computed HERE and never stored: no live env registration, and no
 * activity for a day. Storing it would need a close generation to survive the
 * race where a session reopens a second later; the spec's accepted alternative
 * is to recompute and accept that the worst misjudgement costs a few notes.
 *
 * The window runs to the session's LAST prompt number, not to its decided
 * prefix, because claiming a residual job writes its open debts off first — so
 * every turn in the range is decided by the time the payload sees it. That is
 * also why the threshold is checked before anything is written: a session under
 * the floor must leave no trace, so reopening it returns it to the live path
 * with its ledger untouched.
 *
 * The era floor enters the derived window start exactly as it does on the live
 * path, which is also what keeps a purely legacy session out: its window would
 * start one past its last turn, so it counts zero residual turns and never
 * reaches the threshold. The transition watermark floor (spec D8, ticket 05)
 * joins it for the same reason: a residual candidate's `windowStart` must
 * already be watermark-clean by the time it is derived, because
 * `enqueueResidualNoteSettlementJob` routes through `insertJob`, whose
 * `below_window_floor` check (via `getNoteSettlementWindowStart`, now
 * watermark-aware too) would otherwise refuse the WHOLE candidate rather than
 * clip it — silently dropping a session's legitimate post-watermark residual
 * turns instead of settling them from the watermark forward.
 */
export function listResidualNoteSettlementCandidates(
  db: Database,
  options: ListResidualNoteSettlementOptions,
): ResidualNoteSettlementCandidate[] {
  const idleMs = options.idleMs ?? NOTE_SETTLEMENT_RESIDUAL_IDLE_MS;
  const minWindowTurns =
    options.minWindowTurns ?? NOTE_SETTLEMENT_MIN_WINDOW_TURNS;
  const limit = options.limit ?? NOTE_SETTLEMENT_RESIDUAL_PER_TRIGGER;
  const idleCutoffEpoch = options.nowEpoch - Math.floor(idleMs / 1000);
  // Active sessions are filtered in TS (the set lives in worker memory), so the
  // SQL limit has to leave room for them or a busy project could crowd every
  // genuine candidate out of the result.
  const scanLimit = limit + options.activeSessionIds.size;

  return db
    .query<ResidualNoteSettlementCandidate, [number, number, number, number]>(
      `SELECT sessionId, windowStart, windowEnd, lastActivityEpoch,
              windowEnd - windowStart + 1 AS residualTurns
       FROM (
         SELECT
           s.id AS sessionId,
           MAX(
             s.updated_at_epoch,
             COALESCE(
               (SELECT MAX(t.created_at_epoch) FROM turns t
                WHERE t.session_id = s.id),
               0
             )
           ) AS lastActivityEpoch,
           COALESCE(
             (SELECT MAX(t.prompt_number) FROM turns t
              WHERE t.session_id = s.id),
             0
           ) AS windowEnd,
           MAX(
             COALESCE(
               (SELECT c.last_settled_prompt_number
                FROM note_settlement_cursors c WHERE c.session_id = s.id),
               0
             ),
             -- Excluding backfill for the reason given at
             -- getNoteSettlementWindowStart: this is the same derived bound,
             -- and the two must not disagree about where a session's next
             -- automatic window begins.
             COALESCE(
               (SELECT MAX(j.window_end) FROM note_settlement_jobs j
                WHERE j.session_id = s.id AND j.trigger_type != 'backfill'),
               0
             ),
             COALESCE(
               (SELECT MAX(t.prompt_number) FROM turns t
                WHERE t.session_id = s.id AND t.created_at_epoch < ?),
               0
             ),
             COALESCE(
               (SELECT w.finished_prompt_number
                FROM note_settlement_watermark_floors w
                WHERE w.session_id = s.id),
               0
             )
           ) + 1 AS windowStart
         FROM sessions s
       )
       WHERE lastActivityEpoch <= ?
         AND windowEnd - windowStart + 1 >= ?
       ORDER BY lastActivityEpoch ASC, sessionId ASC
       LIMIT ?`,
    )
    .all(options.eraCutoffEpoch, idleCutoffEpoch, minWindowTurns, scanLimit)
    .filter((row) => !options.activeSessionIds.has(row.sessionId))
    .slice(0, limit);
}

/** One residual job for one closed session — never mixed with another. */
export function enqueueResidualNoteSettlementJob(
  db: Database,
  candidate: ResidualNoteSettlementCandidate,
  nowEpoch: number,
  eraCutoffEpoch: number,
): NoteSettlementJob | null {
  return runWriteTransaction(db, () => {
    const result = insertJob(
      db,
      candidate.sessionId,
      candidate.windowStart,
      candidate.windowEnd,
      "residual",
      nowEpoch,
      eraCutoffEpoch,
    );
    return result.ok ? result.job : null;
  });
}

/**
 * Enqueue ONE explicitly named window for re-settlement, exempt from the
 * monotonic floor and from nothing else.
 *
 * The range is taken verbatim: this never derives, clips or plans, because the
 * whole point is that the caller — an operator, through `POST /settle` — states
 * which turns are to be settled again. Everything after the insert is the
 * ordinary path: the row is claimed, dispatched, committed and retried by
 * exactly the machinery every other trigger type uses.
 *
 * `below_window_floor` is not reachable here — the monotonic floor is precisely
 * what a backfill is exempt from — and it is deliberately left in the returned
 * union rather than mapped away: if that exemption ever regresses, the operator
 * is told which floor stopped them instead of being handed a plausible lie.
 */
export function enqueueBackfillNoteSettlementJob(
  db: Database,
  sessionId: number,
  windowStart: number,
  windowEnd: number,
  nowEpoch: number,
  eraCutoffEpoch: number,
  options: { allowPreEra?: boolean; maxTurns?: number } = {},
): InsertNoteSettlementJobResult {
  return runWriteTransaction(db, () =>
    insertJob(
      db,
      sessionId,
      windowStart,
      windowEnd,
      "backfill",
      nowEpoch,
      eraCutoffEpoch,
      options,
    ),
  );
}

export interface ListDispatchableNoteSettlementSessionsOptions {
  /** Sessions the caller drains anyway — normally the triggering session. */
  excludeSessionIds?: ReadonlySet<number>;
  nowEpoch: number;
  nowMs: number;
  leaseMs?: number;
  maxAttempts?: number;
  limit?: number;
}

/**
 * Sessions holding a job that is DUE right now, oldest job first.
 *
 * The counterpart to `listResidualNoteSettlementCandidates`, and the reason both
 * exist: that one derives candidates from turns and deliberately skips a session
 * that already has a job row, so once a job is RECORDED it can only ever be
 * dispatched by whoever recorded it. Two ordinary situations record a job that
 * nobody then dispatches — the graceful-exit window (records, never dispatches,
 * by design) and a transient failure whose backoff comes due later — and for a
 * closed session there is no later trigger of its own to pick it up. Dispatch
 * therefore has to be able to start from the job table, not only from a fresh
 * derivation.
 *
 * "Due" is anything the claim would act on: a pending or backed-off job with
 * attempts left, and an expired lease of any attempt count (an expired lease at
 * the cap has no dispatch left in it, but reclaiming it is what turns it
 * terminal and lets the cursor walk past — one trigger's work, after which it
 * stops being due).
 *
 * Spec D9's 「无定时器」 is preserved exactly: this is a query run in passing by
 * a content event, never a wake-up.
 */
export function listDispatchableNoteSettlementSessions(
  db: Database,
  options: ListDispatchableNoteSettlementSessionsOptions,
): number[] {
  const leaseMs = options.leaseMs ?? NOTE_SETTLEMENT_LEASE_MS;
  const maxAttempts = options.maxAttempts ?? NOTE_SETTLEMENT_MAX_ATTEMPTS;
  const limit = options.limit ?? NOTE_SETTLEMENT_RESIDUAL_PER_TRIGGER;
  const leaseCutoffEpoch = Math.floor((options.nowMs - leaseMs) / 1000);
  const excluded = options.excludeSessionIds ?? new Set<number>();

  if (limit <= 0) {
    return [];
  }

  return db
    .query<{ sessionId: number }, [number, number, number, number]>(
      `SELECT session_id AS sessionId, MIN(created_at_epoch) AS oldestJobEpoch
       FROM note_settlement_jobs
       WHERE (
               (status IN ('pending', 'failed')
                AND attempts < ?
                AND retry_at_epoch <= ?)
               OR (status = 'claimed'
                   AND (claimed_at_epoch IS NULL OR claimed_at_epoch <= ?))
             )
       GROUP BY session_id
       ORDER BY oldestJobEpoch ASC, session_id ASC
       LIMIT ?`,
    )
    // The exclusion set lives in worker memory, so it is filtered in TS and the
    // SQL limit leaves room for it — same shape as the residual scan.
    .all(
      maxAttempts,
      options.nowEpoch,
      leaseCutoffEpoch,
      limit + excluded.size,
    )
    .map((row) => row.sessionId)
    .filter((sessionId) => !excluded.has(sessionId))
    .slice(0, limit);
}

export interface ClaimNoteSettlementJobOptions {
  /** Jobs already attempted in this pass; one pass burns one attempt each. */
  excludeJobIds?: ReadonlySet<number>;
  leaseMs?: number;
  maxAttempts?: number;
}

const LEASE_EXHAUSTED_ERROR =
  "note settlement lease expired with no attempts left (dispatch never reported back)";

/**
 * Claim this session's next due job, ascending by window.
 *
 * Reclamation runs first: an expired lease with attempts left returns to
 * `pending`, an expired lease at the cap goes durably `failed`, and a `failed`
 * row whose backoff has elapsed returns to `pending`. Every successful claim
 * bumps `claim_generation`, which is what lets a displaced dispatch be told from
 * the one that replaced it.
 *
 * Returns null while another job of this session is validly claimed: one
 * in-flight settle per session is what makes commit order match window order.
 *
 * A residual claim ALSO writes the session's open debts off inside this
 * transaction — the one place "this session is closed" turns into durable state,
 * and only once a job actually owns the window.
 */
export function claimNextNoteSettlementJob(
  db: Database,
  sessionId: number,
  nowEpoch: number,
  nowMs: number,
  options: ClaimNoteSettlementJobOptions = {},
): NoteSettlementJob | null {
  const leaseMs = options.leaseMs ?? NOTE_SETTLEMENT_LEASE_MS;
  const maxAttempts = options.maxAttempts ?? NOTE_SETTLEMENT_MAX_ATTEMPTS;
  const leaseCutoffEpoch = Math.floor((nowMs - leaseMs) / 1000);
  const excluded = options.excludeJobIds ?? new Set<number>();

  return runWriteTransaction(db, () => {
    // Both reclaim paths bump the generation, and that bump is the whole reason
    // a late write-back is safe: the dispatch still running against this row
    // holds the OLD generation, so its `done` (or its failure) matches nothing
    // once ownership has moved — including when ownership moved to nobody,
    // which is exactly the terminal case below.
    //
    // Ticket 06: a lease that expired with the attempt cap already spent goes
    // straight to `abandoned` (the same terminal state `failNoteSettlementJob`'s
    // own deterministic-at-cap branch produces), with a debt row — a dispatch
    // that vanished without reporting back at all is treated as the
    // conservative (deterministic) case, same as the migration backfill for
    // pre-ticket-06 `failed` rows (db/schema.ts's
    // `ensureNoteSettlementJobsRetrySchema`): there is no report to classify,
    // and assuming it would have self-resolved is the reading that could wedge
    // a session behind a truly broken window forever.
    const reclaimedAtCap = db
      .query<
        { id: number; sessionId: number; windowStart: number; windowEnd: number },
        [string, number, number, number, number]
      >(
        `UPDATE note_settlement_jobs
         SET status = 'abandoned',
             claimed_at_epoch = NULL,
             claim_generation = claim_generation + 1,
             last_error = COALESCE(last_error, ?),
             failure_class = 'deterministic',
             updated_at_epoch = ?
         WHERE session_id = ?
           AND status = 'claimed'
           AND (claimed_at_epoch IS NULL OR claimed_at_epoch <= ?)
           AND attempts >= ?
         RETURNING id, session_id AS sessionId, window_start AS windowStart, window_end AS windowEnd`,
      )
      .get(LEASE_EXHAUSTED_ERROR, nowEpoch, sessionId, leaseCutoffEpoch, maxAttempts);
    if (reclaimedAtCap) {
      recordNoteSettlementDebt(db, reclaimedAtCap, LEASE_EXHAUSTED_ERROR, nowEpoch);
    }

    db.query<unknown, [number, number, number, number]>(
      `UPDATE note_settlement_jobs
       SET status = 'pending', claimed_at_epoch = NULL,
           claim_generation = claim_generation + 1, updated_at_epoch = ?
       WHERE session_id = ?
         AND status = 'claimed'
         AND (claimed_at_epoch IS NULL OR claimed_at_epoch <= ?)
         AND attempts < ?`,
    ).run(nowEpoch, sessionId, leaseCutoffEpoch, maxAttempts);

    db.query<unknown, [number, number, number, number]>(
      `UPDATE note_settlement_jobs
       SET status = 'pending', claimed_at_epoch = NULL, updated_at_epoch = ?
       WHERE session_id = ? AND status = 'failed'
         AND attempts < ? AND retry_at_epoch <= ?`,
    ).run(nowEpoch, sessionId, maxAttempts, nowEpoch);

    const stillClaimed = db
      .query<{ id: number }, [number]>(
        `SELECT id FROM note_settlement_jobs
         WHERE session_id = ? AND status = 'claimed' LIMIT 1`,
      )
      .get(sessionId);
    if (stillClaimed) {
      return null;
    }

    const excludedIds = [...excluded];
    const exclusionClause =
      excludedIds.length > 0
        ? ` AND id NOT IN (${excludedIds.map(() => "?").join(", ")})`
        : "";
    const candidate = db
      .query<{ id: number }, number[]>(
        `SELECT id FROM note_settlement_jobs
         WHERE session_id = ? AND status = 'pending'
           AND attempts < ? AND retry_at_epoch <= ?${exclusionClause}
         ORDER BY window_start ASC, id ASC
         LIMIT 1`,
      )
      .get(sessionId, maxAttempts, nowEpoch, ...excludedIds);
    if (!candidate) {
      return null;
    }

    const claimed =
      db
        .query<NoteSettlementJob, [number, number, number]>(
          `UPDATE note_settlement_jobs
           SET status = 'claimed',
               attempts = attempts + 1,
               claim_generation = claim_generation + 1,
               claimed_at_epoch = ?,
               updated_at_epoch = ?
           WHERE id = ? AND status = 'pending'
           RETURNING${JOB_COLUMNS}`,
        )
        .get(nowEpoch, nowEpoch, candidate.id) ?? null;

    if (claimed?.triggerType === "residual") {
      closePendingNoteDebtsAsClosed(db, sessionId, nowEpoch);
    }

    return claimed;
  });
}

/**
 * Give a claim back WITHOUT spending its attempt — the graceful-exit path.
 *
 * A claim normally costs an attempt precisely because a worker that vanishes
 * holding the lease must not retry forever. Shutdown is the one case where the
 * disappearance is known in advance and provably did no work, so the attempt is
 * returned. The generation still rises: releasing is a transition out of
 * `claimed` like any other, and a dispatch that somehow started must not be able
 * to report against the released row.
 */
export function releaseNoteSettlementJobClaim(
  db: Database,
  jobId: number,
  nowEpoch: number,
  claimGeneration: number,
): boolean {
  return (
    db
      .query<unknown, [number, number, number]>(
        `UPDATE note_settlement_jobs
         SET status = 'pending', claimed_at_epoch = NULL,
             attempts = MAX(0, attempts - 1),
             claim_generation = claim_generation + 1,
             updated_at_epoch = ?
         WHERE id = ? AND status = 'claimed' AND claim_generation = ?`,
      )
      .run(nowEpoch, jobId, claimGeneration).changes > 0
  );
}

/**
 * Mark the job done, fenced on the generation it was claimed under.
 *
 * Returns false when the CAS matches nothing — the lease expired and the row has
 * a new owner, or no owner at all. A late dispatch result is DISCARDED at this
 * point rather than committed over the attempt that replaced it.
 *
 * `status = 'claimed'` is part of the fence and not decoration: it is what makes
 * the rejection self-evident for a row that left `claimed` without anyone
 * claiming it again (a terminalised or released job), independently of the
 * generation arithmetic.
 */
export function completeNoteSettlementJob(
  db: Database,
  jobId: number,
  nowEpoch: number,
  claimGeneration: number,
): boolean {
  return (
    db
      .query<unknown, [number, number, number]>(
        `UPDATE note_settlement_jobs
         SET status = 'done', claimed_at_epoch = NULL, last_error = NULL,
             updated_at_epoch = ?
         WHERE id = ? AND status = 'claimed' AND claim_generation = ?`,
      )
      .run(nowEpoch, jobId, claimGeneration).changes > 0
  );
}

export interface FailNoteSettlementJobOptions {
  retryBaseMs?: number;
  maxAttempts?: number;
}

export interface NoteSettlementDebtRecord {
  id: number;
  jobId: number;
  sessionId: number;
  windowStart: number;
  windowEnd: number;
  reason: string;
  createdAtEpoch: number;
}

/**
 * Ticket 06's own debt row (spec "作业状态机相应扩展": "新增 abandoned 终态
 * + 一个欠账记录(窗口区间+原因,供手动 /settle 补)") — recorded exactly once,
 * by `failNoteSettlementJob`'s deterministic branch, at the moment a window
 * is actually abandoned. Never written for a transient failure (it never
 * reaches a terminal state at all) and never synthesized retroactively for a
 * pre-migration `failed` row (see `ensureNoteSettlementJobsRetrySchema`'s own
 * doc comment in db/schema.ts).
 */
function recordNoteSettlementDebt(
  db: Database,
  job: Pick<NoteSettlementJob, "id" | "sessionId" | "windowStart" | "windowEnd">,
  reason: string,
  nowEpoch: number,
): void {
  db.query<unknown, [number, number, number, number, string, number]>(
    `INSERT INTO note_settlement_debts (
       job_id, session_id, window_start, window_end, reason, created_at_epoch
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(job.id, job.sessionId, job.windowStart, job.windowEnd, reason.slice(0, 500), nowEpoch);
}

/** Debts for one session (newest first), or every session's when omitted — the manual-`/settle`-facing read. */
export function listNoteSettlementDebts(
  db: Database,
  sessionId?: number,
): NoteSettlementDebtRecord[] {
  const DEBT_COLUMNS = `
    id, job_id AS jobId, session_id AS sessionId,
    window_start AS windowStart, window_end AS windowEnd,
    reason, created_at_epoch AS createdAtEpoch`;
  if (sessionId === undefined) {
    return db
      .query<NoteSettlementDebtRecord, []>(
        `SELECT${DEBT_COLUMNS} FROM note_settlement_debts ORDER BY created_at_epoch DESC, id DESC`,
      )
      .all();
  }
  return db
    .query<NoteSettlementDebtRecord, [number]>(
      `SELECT${DEBT_COLUMNS} FROM note_settlement_debts
       WHERE session_id = ? ORDER BY created_at_epoch DESC, id DESC`,
    )
    .all(sessionId);
}

/**
 * Record a failed attempt, fenced on the generation like completion — and, as
 * of ticket 06 (read-write-contract spec "重试"), branched entirely on
 * `failureClass`:
 *
 *   - `"transient"` (network/connection/SQLITE_BUSY): the attempt this claim
 *     already spent is given BACK — same mechanism
 *     `releaseNoteSettlementJobClaim` already uses for a graceful exit
 *     (`attempts = MAX(0, attempts - 1)`) — and the job returns straight to
 *     `pending` with `retry_at_epoch` set to NOW, not backed off. There is no
 *     cap for this class at all: nothing here ever moves it toward
 *     `abandoned`. "无主动重试——事件驱动": the next NATURAL trigger event
 *     (this session's own next turn-stop, or the cross-session leak) is what
 *     tries it again, never a timer.
 *   - `"deterministic"`: `attempts` is left exactly as the claim set it. If it
 *     has now reached `maxAttempts` (default `NOTE_SETTLEMENT_MAX_ATTEMPTS`,
 *     "1+1"), the job goes `abandoned` and a debt row is written
 *     (`recordNoteSettlementDebt`) — terminal, never reclaimed again, same
 *     "abandon and continue" discipline `advanceNoteSettlementCursor` already
 *     applies to a legacy exhausted `failed` row. Otherwise it goes `failed`
 *     with the SAME exponential backoff this function always used (60s after
 *     the first attempt), awaiting one more try.
 *
 * The old uniform "every failure counts, every failure backs off, cap 3"
 * semantics — one function, one branch, no class — are retired by this same
 * ticket.
 */
export function failNoteSettlementJob(
  db: Database,
  jobId: number,
  failureClass: NoteSettlementFailureClass,
  reason: string,
  nowEpoch: number,
  claimGeneration: number,
  options: FailNoteSettlementJobOptions = {},
): NoteSettlementJob | null {
  const retryBaseMs = options.retryBaseMs ?? NOTE_SETTLEMENT_RETRY_BASE_MS;
  const maxAttempts = options.maxAttempts ?? NOTE_SETTLEMENT_MAX_ATTEMPTS;

  return runWriteTransaction(db, () => {
    const job = getNoteSettlementJob(db, jobId);
    if (
      !job ||
      job.status !== "claimed" ||
      job.claimGeneration !== claimGeneration
    ) {
      return null;
    }

    if (failureClass === "transient") {
      const changed = db
        .query<unknown, [string, number, number, number, number]>(
          `UPDATE note_settlement_jobs
           SET status = 'pending', claimed_at_epoch = NULL,
               attempts = MAX(0, attempts - 1),
               claim_generation = claim_generation + 1,
               last_error = ?, failure_class = 'transient',
               retry_at_epoch = ?, updated_at_epoch = ?
           WHERE id = ? AND status = 'claimed' AND claim_generation = ?`,
        )
        .run(reason.slice(0, 500), nowEpoch, nowEpoch, jobId, claimGeneration).changes;
      if (changed === 0) {
        return null;
      }
      return getNoteSettlementJob(db, jobId);
    }

    // Deterministic: `attempts` stays exactly as the claim left it.
    if (job.attempts >= maxAttempts) {
      const changed = db
        .query<unknown, [string, number, number, number]>(
          `UPDATE note_settlement_jobs
           SET status = 'abandoned', claimed_at_epoch = NULL,
               claim_generation = claim_generation + 1,
               last_error = ?, failure_class = 'deterministic',
               updated_at_epoch = ?
           WHERE id = ? AND status = 'claimed' AND claim_generation = ?`,
        )
        .run(reason.slice(0, 500), nowEpoch, jobId, claimGeneration).changes;
      if (changed === 0) {
        return null;
      }
      recordNoteSettlementDebt(db, job, reason, nowEpoch);
      return getNoteSettlementJob(db, jobId);
    }

    const backoffSeconds = Math.max(
      1,
      Math.round((retryBaseMs * 2 ** Math.max(0, job.attempts - 1)) / 1000),
    );
    const changed = db
      .query<unknown, [string, number, number, number, number]>(
        `UPDATE note_settlement_jobs
         SET status = 'failed', claimed_at_epoch = NULL,
             last_error = ?, failure_class = 'deterministic',
             retry_at_epoch = ?, updated_at_epoch = ?
         WHERE id = ? AND status = 'claimed' AND claim_generation = ?`,
      )
      .run(
        reason.slice(0, 500),
        nowEpoch + backoffSeconds,
        nowEpoch,
        jobId,
        claimGeneration,
      ).changes;
    if (changed === 0) {
      return null;
    }
    return getNoteSettlementJob(db, jobId);
  });
}

/**
 * Advance the cursor across every consecutively RESOLVED window.
 *
 * "Resolved" includes a job that burned all its attempts, which is the
 * terminal-state-must-abandon-and-continue rule: a permanently failed window is
 * a durable disposition, and holding the cursor at it would park the session's
 * whole settlement behind one bad payload — the deadlock the diary's three-strike
 * tombstone produced before it grew a supersede path. The failed row with its
 * `last_error` stays as the audit trail of the gap.
 *
 * Monotonic: it never moves backwards.
 *
 * `backfill` rows are excluded from the walk entirely. The cursor is derived
 * from the AUTOMATIC window sequence, which tiles the session contiguously
 * forward; a backfill deliberately overlaps that sequence, so a resolved one
 * sitting between two automatic windows would either drag the local prefix end
 * backwards (harmless only because of the `Math.max` below) or, when its range
 * reaches past a still-unresolved automatic window, carry the cursor over turns
 * nobody has settled. Excluding it makes the derivation exactly what it was
 * before backfill existed.
 */
export function advanceNoteSettlementCursor(
  db: Database,
  sessionId: number,
  nowEpoch: number,
  maxAttempts: number = NOTE_SETTLEMENT_MAX_ATTEMPTS,
): number {
  const rows = db
    .query<
      {
        windowEnd: number;
        status: NoteSettlementJobStatus;
        attempts: number;
      },
      [number]
    >(
      `SELECT window_end AS windowEnd, status, attempts
       FROM note_settlement_jobs
       WHERE session_id = ? AND trigger_type != 'backfill'
       ORDER BY window_start ASC, id ASC`,
    )
    .all(sessionId);

  let consecutive = 0;
  for (const row of rows) {
    // Ticket 06: `abandoned` is ALSO a resolved terminal state (a deterministic
    // failure that spent its capped attempts) — same "abandon and continue"
    // rule the `failed`-at-cap reading already gave a pre-ticket-06 row, kept
    // here for a legacy row this migration's data backfill left at `failed`
    // rather than force-terminalising (see db/schema.ts's
    // `ensureNoteSettlementJobsRetrySchema`).
    const resolved =
      row.status === "done" ||
      row.status === "abandoned" ||
      (row.status === "failed" && row.attempts >= maxAttempts);
    if (!resolved) {
      break;
    }
    consecutive = row.windowEnd;
  }

  const current = getNoteSettlementCursor(db, sessionId);
  const next = Math.max(current, consecutive);
  if (next !== current) {
    db.query<unknown, [number, number, number]>(
      `INSERT INTO note_settlement_cursors (
         session_id, last_settled_prompt_number, updated_at_epoch
       ) VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         last_settled_prompt_number = excluded.last_settled_prompt_number,
         updated_at_epoch = excluded.updated_at_epoch`,
    ).run(sessionId, next, nowEpoch);
  }
  return next;
}
