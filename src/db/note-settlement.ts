import type { Database } from "bun:sqlite";

import { runWriteTransaction } from "./database";
import { closePendingNoteDebtsAsClosed } from "./note-debt";

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
 *     still spent one. Three deaths exhaust the job; the reclaim path respects
 *     the cap instead of resurrecting a fourth attempt;
 *   - `claim_generation` rises on EVERY transition out of `claimed`, not only on
 *     a fresh claim. Ownership ends when the row stops being claimed — by
 *     reclamation or by terminalisation — and a fence that only moved on the
 *     next claim would leave a window in which the displaced dispatch's late
 *     write-back still matched, resurrecting a terminal job to `done` and
 *     walking the cursor over a window nobody settled;
 *   - the cursor advances across CONSECUTIVE RESOLVED windows, where resolved
 *     includes terminally failed. Abandon and continue: parking the cursor on a
 *     dead window would wedge every later window behind it forever.
 *
 * Deliberately NOT the same table as `settlement_jobs` — see the schema comment.
 */

/** Decided turns that must accumulate before the in-session trigger fires. */
export const NOTE_SETTLEMENT_CONSECUTIVE_TURNS = 50;

/**
 * Floor on a window that is cut EARLY — by a compact, or off a closed session's
 * residual. Both are "settle what you have" events, and settling six turns costs
 * a whole inference to produce almost no arc. Below the floor nothing is written
 * at all and the window simply keeps accumulating to the next trigger.
 *
 * A suggested value, exported rather than configured: it is a payload-shape
 * judgement the offline eval can recalibrate, not a knob a user should turn.
 */
export const NOTE_SETTLEMENT_MIN_WINDOW_TURNS = 20;

/** A `claimed` job older than this is presumed dead and returns to `pending`. */
export const NOTE_SETTLEMENT_LEASE_MS = 10 * 60 * 1000;

/** A job that has consumed this many attempts is terminal — never reclaimed. */
export const NOTE_SETTLEMENT_MAX_ATTEMPTS = 3;

/** First backoff step; doubles per consumed attempt (60s / 120s / 240s). */
export const NOTE_SETTLEMENT_RETRY_BASE_MS = 60_000;

/** Idle age past which an unregistered session counts as closed (R2#3). */
export const NOTE_SETTLEMENT_RESIDUAL_IDLE_MS = 24 * 60 * 60 * 1000;

/** Closed sessions one trigger may pick up, oldest first (裁决 11). */
export const NOTE_SETTLEMENT_RESIDUAL_PER_TRIGGER = 2;

export type NoteSettlementTrigger =
  | "consecutive"
  | "compact"
  | "residual"
  | "sessionend";
export type NoteSettlementJobStatus =
  | "pending"
  | "claimed"
  | "done"
  | "failed";

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
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

/** A window the planner would cut, before anything is written. */
export interface NoteSettlementWindowPlan {
  sessionId: number;
  windowStart: number;
  windowEnd: number;
  triggerType: Exclude<NoteSettlementTrigger, "residual">;
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
 * Where the next window begins: one past the latest of the cursor, the highest
 * window already enqueued, and the era floor.
 *
 * Consulting the enqueued windows and not just the cursor is what keeps windows
 * disjoint while a job is still open — the cursor deliberately does not move
 * until a window RESOLVES, so a second trigger arriving mid-flight would
 * otherwise cut a window over turns the in-flight job already owns.
 *
 * The era floor is consulted independently of the cursor row rather than only
 * through it: a session settlement has never written about has no cursor row at
 * all, and deriving the bound is what lets the below-threshold trigger stay a
 * pure read (see `planNoteSettlementWindows`).
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
         WHERE session_id = ?`,
      )
      .get(sessionId)?.windowEnd ?? 0;
  return (
    Math.max(
      getNoteSettlementCursor(db, sessionId),
      highestEnqueued ?? 0,
      getEraFloorPromptNumber(db, sessionId, eraCutoffEpoch),
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

export function getMaxPromptNumber(db: Database, sessionId: number): number {
  return (
    db
      .query<{ maxPromptNumber: number | null }, [number]>(
        "SELECT MAX(prompt_number) AS maxPromptNumber FROM turns WHERE session_id = ?",
      )
      .get(sessionId)?.maxPromptNumber ?? 0
  );
}

/**
 * Last prompt_number of the contiguous DECIDED prefix starting at `windowStart`,
 * under the shared prompt-clock default (spec D10, ticket 05): a turn has ended
 * once a LATER prompt exists, full stop — the highest ended turn is always one
 * behind the session's current max, so the current (open) turn is excluded by
 * construction. This is the bound `consecutive` uses as-is; `compact` and
 * `sessionend` narrow it further with their own frozen boundary marker (see
 * `planNoteSettlementWindows`).
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

/**
 * The compact boundary marker as `updateCompactAnchor` last repaired it: the
 * highest prompt_number that had reached a terminal status when the compact was
 * handled. Null when the session has never had one.
 */
export function getCompactBoundaryPromptNumber(
  db: Database,
  sessionId: number,
): number | null {
  return (
    db
      .query<{ boundary: number | null }, [number]>(
        "SELECT last_compact_turn AS boundary FROM sessions WHERE id = ?",
      )
      .get(sessionId)?.boundary ?? null
  );
}

export interface NoteSettlementWindowOptions {
  /**
   * The era boundary, and required for that reason: there is no such thing as
   * planning a window without one, so the type says so rather than a comment.
   */
  eraCutoffEpoch: number;
  consecutiveTurns?: number;
  minWindowTurns?: number;
}

/**
 * The windows this trigger would cut, computed with READS ONLY.
 *
 * Separating the plan from the write is what makes the below-threshold case cost
 * nothing: a turn-stop that has not reached the 50-turn mark returns an empty
 * plan and never opens a transaction, so the overwhelmingly common event leaves
 * no trace in the database at all.
 *
 * Full 50-turn blocks are cut for EVERY trigger — a backfill that lands 130
 * decided turns at once produces two 50-turn windows plus (at a compact or a
 * sessionend) the 30-turn remainder, rather than one 130-turn payload. Only the
 * remainder is subject to the minimum-window floor, and only `compact`/
 * `sessionend` may take it — `consecutive` never cuts a partial block.
 *
 * `compact` and `sessionend` each narrow the shared decided-prefix default with
 * their OWN frozen boundary (spec D10, ticket 05 — the three trigger types are
 * NOT interchangeable, each states its upper bound explicitly):
 *
 *   - `compact` is bounded by the repaired anchor marker
 *     (`getCompactBoundaryPromptNumber`), used AS-IS rather than intersected
 *     with the prompt-clock default: the anchor is itself already "the highest
 *     prompt_number that had reached a terminal status when the compact was
 *     handled", computed independently, and can legitimately equal the
 *     session's current max turn (a compact landing between that turn's Stop
 *     and the next prompt). Absent an anchor (never compacted) there is no
 *     boundary to narrow by, so the shared default stands unclamped — never a
 *     licence to settle everything, since the default is itself bounded;
 *   - `sessionend` is bounded by the LIVE max prompt number, read at the exact
 *     moment the hook calls this — that read IS the freeze (spec D7's "hook
 *     冻结的 end 边界"): a session actually ending is stronger evidence than
 *     "a later prompt exists", so unlike the shared default the current turn is
 *     NOT excluded. The frozen value survives only inside the enqueued job's
 *     `window_end`; nothing else persists it, and nothing needs to.
 *
 * `sessionend`'s remainder is additionally EXEMPT from the minimum-window floor
 * (spec D7, 用户定案 T570): a session may end after a single turn, and without
 * the exemption the tail would never be settled at all.
 */
export function planNoteSettlementWindows(
  db: Database,
  sessionId: number,
  trigger: Exclude<NoteSettlementTrigger, "residual">,
  options: NoteSettlementWindowOptions,
): NoteSettlementWindowPlan[] {
  const consecutiveTurns =
    options.consecutiveTurns ?? NOTE_SETTLEMENT_CONSECUTIVE_TURNS;
  const minWindowTurns =
    options.minWindowTurns ?? NOTE_SETTLEMENT_MIN_WINDOW_TURNS;

  let windowStart = getNoteSettlementWindowStart(
    db,
    sessionId,
    options.eraCutoffEpoch,
  );
  let prefixEnd = getDecidedPrefixEnd(db, sessionId, windowStart);
  if (trigger === "compact") {
    const boundary = getCompactBoundaryPromptNumber(db, sessionId);
    // Null means no compact has ever been anchored on this session, so there is
    // no boundary to be bounded by — the shared default stands unclamped.
    if (boundary !== null) {
      prefixEnd = boundary;
    }
  } else if (trigger === "sessionend") {
    prefixEnd = getMaxPromptNumber(db, sessionId);
  }
  const plans: NoteSettlementWindowPlan[] = [];

  while (prefixEnd - windowStart + 1 >= consecutiveTurns) {
    const windowEnd = windowStart + consecutiveTurns - 1;
    plans.push({
      sessionId,
      windowStart,
      windowEnd,
      triggerType: "consecutive",
    });
    windowStart = windowEnd + 1;
  }

  const remainderFloor = trigger === "sessionend" ? 1 : minWindowTurns;
  if (
    (trigger === "compact" || trigger === "sessionend") &&
    prefixEnd - windowStart + 1 >= remainderFloor
  ) {
    plans.push({
      sessionId,
      windowStart,
      windowEnd: prefixEnd,
      triggerType: trigger,
    });
  }

  return plans;
}

/**
 * The hook's own half of spec D7: freeze this session's SessionEnd boundary and
 * enqueue whatever window it closes over, in one pass. "Freeze" is nothing more
 * than the plan/enqueue pair below reading `getMaxPromptNumber` and committing
 * it into a job's `window_end` — nothing else can create a turn for this
 * session between that read and the commit, so there is no separate boundary
 * column to keep in sync with the job table.
 *
 * Idempotent by construction, satisfying spec D7's "同一会话重复收到 end 事件
 * 只产生一条边界/一单作业": a repeat SessionEnd with no new activity re-derives
 * the identical, already-consumed window, `planNoteSettlementWindows` returns
 * nothing to plan, and `enqueueNoteSettlementWindows` opens no transaction at
 * all. A SessionEnd after a genuine resume with new turns derives a NEW window
 * starting past the previous one (`getNoteSettlementWindowStart` already reads
 * the highest enqueued `window_end`) — the boundary is only ever a boundary,
 * never a lock on the session (spec D7: "边界只是边界,其后新 turn 归下一窗口,
 * 已入队作业不失效").
 */
export function enqueueSessionEndNoteSettlementWindow(
  db: Database,
  sessionId: number,
  nowEpoch: number,
  eraCutoffEpoch: number,
): NoteSettlementJob[] {
  const plans = planNoteSettlementWindows(db, sessionId, "sessionend", {
    eraCutoffEpoch,
  });
  return enqueueNoteSettlementWindows(db, plans, nowEpoch, eraCutoffEpoch);
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
 */
function insertJob(
  db: Database,
  sessionId: number,
  windowStart: number,
  windowEnd: number,
  triggerType: NoteSettlementTrigger,
  nowEpoch: number,
  eraCutoffEpoch: number,
): NoteSettlementJob | null {
  if (windowStart < getNoteSettlementWindowStart(db, sessionId, eraCutoffEpoch)) {
    return null;
  }
  if (windowEnd < windowStart) {
    return null;
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
  if (job) {
    // The first job is the first moment settlement writes anything about this
    // session, and therefore the place its cursor is born — at the era boundary,
    // so the row states outright that the legacy prefix is out of scope. Written
    // only on a job that landed: a refused window leaves no trace at all.
    ensureNoteSettlementCursor(db, sessionId, eraCutoffEpoch, nowEpoch);
  }
  return job;
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
  return runWriteTransaction(db, () => {
    const created: NoteSettlementJob[] = [];
    for (const plan of plans) {
      const job = insertJob(
        db,
        plan.sessionId,
        plan.windowStart,
        plan.windowEnd,
        plan.triggerType,
        nowEpoch,
        eraCutoffEpoch,
      );
      if (job) {
        created.push(job);
      }
    }
    return created;
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
 * reaches the threshold.
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
             COALESCE(
               (SELECT MAX(j.window_end) FROM note_settlement_jobs j
                WHERE j.session_id = s.id),
               0
             ),
             COALESCE(
               (SELECT MAX(t.prompt_number) FROM turns t
                WHERE t.session_id = s.id AND t.created_at_epoch < ?),
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
  return runWriteTransaction(db, () =>
    insertJob(
      db,
      candidate.sessionId,
      candidate.windowStart,
      candidate.windowEnd,
      "residual",
      nowEpoch,
      eraCutoffEpoch,
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
    db.query<unknown, [string, number, number, number, number]>(
      `UPDATE note_settlement_jobs
       SET status = 'failed',
           claimed_at_epoch = NULL,
           claim_generation = claim_generation + 1,
           last_error = COALESCE(last_error, ?),
           updated_at_epoch = ?
       WHERE session_id = ?
         AND status = 'claimed'
         AND (claimed_at_epoch IS NULL OR claimed_at_epoch <= ?)
         AND attempts >= ?`,
    ).run(
      LEASE_EXHAUSTED_ERROR,
      nowEpoch,
      sessionId,
      leaseCutoffEpoch,
      maxAttempts,
    );

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

/**
 * Record a failed attempt and stamp when the next one becomes claimable.
 *
 * `attempts` is untouched — the claim already consumed it — so the backoff step
 * is derived from the attempts already spent: 60s after the first failure, 120s
 * after the second, and irrelevant after the third because the job is terminal.
 * Fenced on the generation, same as completion.
 */
export function failNoteSettlementJob(
  db: Database,
  jobId: number,
  reason: string,
  nowEpoch: number,
  claimGeneration: number,
  options: FailNoteSettlementJobOptions = {},
): NoteSettlementJob | null {
  const retryBaseMs = options.retryBaseMs ?? NOTE_SETTLEMENT_RETRY_BASE_MS;

  return runWriteTransaction(db, () => {
    const job = getNoteSettlementJob(db, jobId);
    if (
      !job ||
      job.status !== "claimed" ||
      job.claimGeneration !== claimGeneration
    ) {
      return null;
    }
    const backoffSeconds = Math.max(
      1,
      Math.round((retryBaseMs * 2 ** Math.max(0, job.attempts - 1)) / 1000),
    );
    const changed = db
      .query<unknown, [string, number, number, number, number]>(
        `UPDATE note_settlement_jobs
         SET status = 'failed', claimed_at_epoch = NULL, last_error = ?,
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
       WHERE session_id = ? ORDER BY window_start ASC, id ASC`,
    )
    .all(sessionId);

  let consecutive = 0;
  for (const row of rows) {
    const resolved =
      row.status === "done" ||
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
