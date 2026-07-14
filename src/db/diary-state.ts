import type { Database } from "bun:sqlite";

import { addCalendarDays, calendarDateAt } from "../diary/calendar";
import { DEFAULT_DREAM_AGENT_TIME_ZONE } from "../shared/config";
import { runWriteTransaction } from "./database";
import type { PendingQueueItem } from "./pending-queue";

/**
 * A dream day gets one automatic retry after its first failure; the second
 * failure trips `terminal = 1`, which excludes the day from every automatic
 * path (claim, reconcile) until a manual trigger resets it.
 */
export const DREAM_MAX_AUTO_ATTEMPTS = 2;

export interface EnqueueDiaryDayInput {
  date: string;
  enqueuedAtEpoch: number;
}

export interface RecordDreamFailureInput {
  date: string;
  queueSeq: number;
  error: string;
  /** Epoch to schedule the single auto-retry at; ignored once the day trips terminal. */
  retryAtEpoch: number;
}

export interface SettleDreamDayInput {
  date: string;
  queueSeq: number;
  watermark: string;
  settledAtEpoch: number;
}

export interface ReconcileDreamBacklogInput {
  today: string;
  cutoverDate: string;
  lastSuccessfulDate: string | null;
  maxDays: number;
  timeZone: string;
  enqueuedAtEpoch: number;
}

export interface DiaryDayState {
  date: string;
  watermark: string | null;
  settledAtEpoch: number | null;
  needsRegen: boolean;
  attemptCount: number;
  nextAttemptEpoch: number | null;
  terminal: boolean;
  lastError: string | null;
}

export interface DiaryBootstrapState {
  cutoverDate: string;
}

export interface DiaryStateStore {
  enqueueDay(input: EnqueueDiaryDayInput): void;
  claimNextDiaryItem(claimedAtEpoch: number): PendingQueueItem | null;
  hasReadyDiaryItem(nowEpoch: number): boolean;
  getDayState(date: string): DiaryDayState | null;
  recordDreamFailure(input: RecordDreamFailureInput): void;
  settleDreamDay(input: SettleDreamDayInput): void;
  acknowledgeDiaryItem(queueSeq: number): void;
  hasQueuedDay(date: string): boolean;
  markDayStale(date: string): void;
  markDayStaleAndEnqueue(input: EnqueueDiaryDayInput): void;
  reconcileBacklog(input: ReconcileDreamBacklogInput): string[];
  initializeBootstrap(today: string): DiaryBootstrapState;
}

interface PendingQueueRow {
  seq: number;
  kind: "diary";
  targetId: number;
  sessionDbId: number;
  claimedAtEpoch: number | null;
  enqueuedAtEpoch: number;
}

interface DiaryDayStateRow {
  date: string;
  watermark: string | null;
  settledAtEpoch: number | null;
  needsRegen: number;
  attemptCount: number;
  nextAttemptEpoch: number | null;
  terminal: number;
  lastError: string | null;
}

const DIARY_QUEUE_SELECT = `
  SELECT
    q.seq,
    q.kind,
    q.target_id AS targetId,
    q.session_db_id AS sessionDbId,
    q.claimed_at_epoch AS claimedAtEpoch,
    q.enqueued_at_epoch AS enqueuedAtEpoch
  FROM pending_queue q
  JOIN diary_day_state d
    ON CAST(REPLACE(d.date, '-', '') AS INTEGER) = q.target_id
`;

export function markSettledDiaryDayStaleForTurn(
  db: Database,
  createdAtEpoch: number,
): void {
  const timeZone =
    db.query<{ value: string }, []>(
      "SELECT value FROM diary_state WHERE key = 'dream_timezone'",
    ).get()?.value ?? DEFAULT_DREAM_AGENT_TIME_ZONE;
  const date = calendarDateAt(createdAtEpoch, timeZone);
  db.query<unknown, [string]>(
    `UPDATE diary_day_state
     SET needs_regen = 1,
         attempt_count = 0,
         next_attempt_epoch = NULL,
         last_error = NULL
     WHERE date = ?
       AND settled_at_epoch IS NOT NULL
       AND date >= COALESCE(
         (SELECT value FROM diary_state WHERE key = 'cutover_date'),
         '9999-12-31'
       )`,
  ).run(date);
}

export function createDiaryStateStore(db: Database): DiaryStateStore {
  return {
    enqueueDay(input): void {
      const targetId = Number(input.date.replaceAll("-", ""));
      runWriteTransaction(db, () => {
        db.query<unknown, [string]>(
          `INSERT INTO diary_day_state (date)
           VALUES (?)
           ON CONFLICT DO NOTHING`,
        ).run(input.date);
        db.query<unknown, [number, number]>(
          `INSERT INTO pending_queue (
             kind, target_id, session_db_id, enqueued_at_epoch
           ) VALUES ('diary', ?, 0, ?)
           ON CONFLICT DO NOTHING`,
        ).run(targetId, input.enqueuedAtEpoch);
      });
    },

    claimNextDiaryItem(claimedAtEpoch): PendingQueueItem | null {
      return runWriteTransaction(db, () => {
        const row = db
          .query<PendingQueueRow, [number]>(
            `${DIARY_QUEUE_SELECT}
             WHERE q.kind = 'diary'
               AND q.claimed_at_epoch IS NULL
               AND d.terminal = 0
               AND (d.next_attempt_epoch IS NULL OR d.next_attempt_epoch <= ?)
             ORDER BY q.seq ASC
             LIMIT 1`,
          )
          .get(claimedAtEpoch);
        if (!row) return null;

        const result = db.query<unknown, [number, number]>(
          `UPDATE pending_queue
           SET claimed_at_epoch = ?
           WHERE seq = ? AND claimed_at_epoch IS NULL`,
        ).run(claimedAtEpoch, row.seq);
        if (result.changes !== 1) {
          throw new Error(`unexpected claim race on dream queue seq=${row.seq}`);
        }
        return { ...row, claimedAtEpoch };
      });
    },

    hasReadyDiaryItem(nowEpoch): boolean {
      return db
        .query<{ one: number }, [number]>(
          `${DIARY_QUEUE_SELECT}
           WHERE q.kind = 'diary'
             AND q.claimed_at_epoch IS NULL
             AND d.terminal = 0
             AND (d.next_attempt_epoch IS NULL OR d.next_attempt_epoch <= ?)
           LIMIT 1`,
        )
        .get(nowEpoch) !== null;
    },

    getDayState(date): DiaryDayState | null {
      const row = db.query<DiaryDayStateRow, [string]>(
        `SELECT
           date,
           watermark,
           settled_at_epoch AS settledAtEpoch,
           needs_regen AS needsRegen,
           attempt_count AS attemptCount,
           next_attempt_epoch AS nextAttemptEpoch,
           terminal,
           last_error AS lastError
         FROM diary_day_state
         WHERE date = ?`,
      ).get(date);
      return row
        ? {
            ...row,
            needsRegen: row.needsRegen === 1,
            terminal: row.terminal === 1,
          }
        : null;
    },

    recordDreamFailure(input): void {
      runWriteTransaction(db, () => {
        // SQLite evaluates every SET expression against the pre-update row, so
        // `attempt_count + 1` is the post-failure count throughout. On the
        // capped attempt the day trips terminal and drops its retry schedule;
        // an already-terminal day stays terminal (the CASE preserves it).
        db.query<unknown, [string, number, number, number, string]>(
          `UPDATE diary_day_state
           SET needs_regen = 1,
               attempt_count = attempt_count + 1,
               last_error = ?,
               terminal = CASE
                 WHEN attempt_count + 1 >= ? THEN 1 ELSE terminal END,
               next_attempt_epoch = CASE
                 WHEN attempt_count + 1 >= ? THEN NULL ELSE ? END
           WHERE date = ?`,
        ).run(
          input.error,
          DREAM_MAX_AUTO_ATTEMPTS,
          DREAM_MAX_AUTO_ATTEMPTS,
          input.retryAtEpoch,
          input.date,
        );
        db.query<unknown, [number]>(
          `UPDATE pending_queue
           SET claimed_at_epoch = NULL
           WHERE seq = ? AND kind = 'diary'`,
        ).run(input.queueSeq);
      });
    },

    settleDreamDay(input): void {
      runWriteTransaction(db, () => {
        db.query<unknown, [string, number, string]>(
          `UPDATE diary_day_state
           SET watermark = ?,
               settled_at_epoch = ?,
               needs_regen = 0,
               attempt_count = 0,
               next_attempt_epoch = NULL,
               last_error = NULL
           WHERE date = ?`,
        ).run(input.watermark, input.settledAtEpoch, input.date);
        db.query<unknown, [number]>(
          "DELETE FROM pending_queue WHERE seq = ? AND kind = 'diary'",
        ).run(input.queueSeq);
      });
    },

    acknowledgeDiaryItem(queueSeq): void {
      db.query<unknown, [number]>(
        "DELETE FROM pending_queue WHERE seq = ? AND kind = 'diary'",
      ).run(queueSeq);
    },

    hasQueuedDay(date): boolean {
      const targetId = Number(date.replaceAll("-", ""));
      return db.query<{ one: number }, [number]>(
        `SELECT 1 AS one
         FROM pending_queue
         WHERE kind = 'diary' AND target_id = ?
         LIMIT 1`,
      ).get(targetId) !== null;
    },

    markDayStale(date): void {
      db.query<unknown, [string]>(
        `UPDATE diary_day_state
         SET needs_regen = 1,
             attempt_count = 0,
             next_attempt_epoch = NULL,
             terminal = 0,
             last_error = NULL
         WHERE date = ?`,
      ).run(date);
    },

    markDayStaleAndEnqueue(input): void {
      runWriteTransaction(db, () => {
        this.markDayStale(input.date);
        this.enqueueDay(input);
      });
    },

    reconcileBacklog(input): string[] {
      if (!Number.isSafeInteger(input.maxDays) || input.maxDays < 1) {
        throw new Error("Dream backlog maxDays must be a positive integer");
      }
      db.query<unknown, [string]>(
        `INSERT INTO diary_state (key, value) VALUES ('dream_timezone', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(input.timeZone);

      const startDate = input.lastSuccessfulDate === null
        ? input.cutoverDate
        : addCalendarDays(input.lastSuccessfulDate, 1);
      const dates = new Set<string>();
      for (
        let date = startDate < input.cutoverDate ? input.cutoverDate : startDate;
        date < input.today;
        date = addCalendarDays(date, 1)
      ) {
        dates.add(date);
      }
      for (const row of db.query<
        { date: string },
        [string, string, string | null, string | null]
      >(
        `SELECT date
         FROM diary_day_state
         WHERE needs_regen = 1
           AND date >= ?
           AND date < ?
           AND (
             settled_at_epoch IS NOT NULL
             OR ? IS NULL
             OR date <> ?
           )`,
      ).all(
        input.cutoverDate,
        input.today,
        input.lastSuccessfulDate,
        input.lastSuccessfulDate,
      )) {
        dates.add(row.date);
      }

      // A terminal (manual-only) day is never resurrected by reconcile.
      for (const row of db.query<{ date: string }, [string, string]>(
        `SELECT date FROM diary_day_state
         WHERE terminal = 1 AND date >= ? AND date < ?`,
      ).all(input.cutoverDate, input.today)) {
        dates.delete(row.date);
      }

      const sorted = Array.from(dates).sort();
      // Auto-enqueue only the most recent maxDays due days (default 1 = just
      // the latest, usually yesterday); every older due day is treated as
      // auto-retry-exhausted and demoted to terminal (manual-only) so the
      // backlog neither piles up nor gets re-enqueued next reconcile.
      const keep = sorted.slice(-input.maxDays);
      const terminalize = sorted.slice(0, sorted.length - keep.length);
      return runWriteTransaction(db, () => {
        for (const date of terminalize) {
          db.query<unknown, [string]>(
            `INSERT INTO diary_day_state (date, terminal, next_attempt_epoch)
             VALUES (?, 1, NULL)
             ON CONFLICT(date) DO UPDATE SET terminal = 1, next_attempt_epoch = NULL`,
          ).run(date);
          db.query<unknown, [number]>(
            "DELETE FROM pending_queue WHERE kind = 'diary' AND target_id = ?",
          ).run(Number(date.replaceAll("-", "")));
        }
        for (const date of keep) {
          this.enqueueDay({ date, enqueuedAtEpoch: input.enqueuedAtEpoch });
        }
        return keep;
      });
    },

    initializeBootstrap(today): DiaryBootstrapState {
      const defaultCutoverDate = addCalendarDays(today, -14);
      return runWriteTransaction(db, () => {
        db.query<unknown, [string]>(
          `INSERT INTO diary_state (key, value)
           VALUES ('cutover_date', ?)
           ON CONFLICT DO NOTHING`,
        ).run(defaultCutoverDate);
        const cutoverDate = db.query<{ value: string }, []>(
          "SELECT value FROM diary_state WHERE key = 'cutover_date'",
        ).get()?.value;
        if (!cutoverDate) throw new Error("Dream cutover date was not initialized");
        return { cutoverDate };
      });
    },
  };
}
