import type { Database } from "bun:sqlite";

import { runWriteTransaction } from "./database";
import type { PendingQueueItem } from "./pending-queue";
import {
  computeDiaryWatermark,
  diaryDayOf,
  type DiaryWatermarkMaterial,
} from "../diary/domain";

export interface EnqueueDiaryDayInput {
  date: string;
  enqueuedAtEpoch: number;
}

export interface RecordDiaryFailureInput {
  date: string;
  queueSeq: number;
  error: string;
  nextAttemptEpoch: number;
}

export interface SettleDiaryDayInput {
  date: string;
  queueSeq: number;
  watermark: string;
  fileSha256: string;
  indexHook: string;
  validationReportJson: string;
  settledAtEpoch: number;
}

export type CommitDiaryDayStateInput = Omit<
  SettleDiaryDayInput,
  "queueSeq"
> & {
  pendingRebase?: boolean;
};

export interface CommitDiaryDayTombstoneInput {
  date: string;
  requestRebuild: boolean;
}

export interface ReconcileDiaryBacklogInput {
  today: string;
  cutoverDate: string;
  enqueuedAtEpoch: number;
}

export interface DiaryDayState {
  date: string;
  watermark: string | null;
  fileSha256: string | null;
  indexHook: string | null;
  validationReportJson: string | null;
  settledAtEpoch: number | null;
  needsRegen: boolean;
  pendingRebase: boolean;
  attemptCount: number;
  nextAttemptEpoch: number | null;
  lastError: string | null;
  terminal: boolean;
}

export interface DiaryIndexRow {
  date: string;
  indexHook: string | null;
}

export interface SettledDiaryDay {
  date: string;
  watermark: string;
  fileSha256: string;
  indexHook: string;
}

export interface DiaryBootstrapState {
  cutoverDate: string;
  rebuildRequested: boolean;
}

export interface PersonaCursor {
  lastFoldedDate: string | null;
  lastAppliedOperationId: string | null;
  foldsSinceRebase: number;
  rebuildRequested: boolean;
  rebuildRequestEpoch: number;
  rebuildConfirmedEpoch: number;
}

export interface FrozenPendingRebaseDay {
  date: string;
  watermark: string;
  fileSha256: string;
}

export interface PersonaRebuildGate {
  blockingDates: string[];
  partialMissingDates: string[];
}

export interface DiaryIntegrityScanInput {
  beforeDate: string;
  limit: number;
}

export interface CommitPersonaCursorInput {
  lastFoldedDate: string;
  lastAppliedOperationId: string;
  foldsSinceRebase?: number;
  rebuildRequested?: boolean;
  confirmedRebuildEpoch?: number;
  consumedPendingDays?: readonly FrozenPendingRebaseDay[];
  consumedPendingDates?: readonly string[];
}

export type PersonaOperationKind = "rebuild" | "fold" | "rebase";

export interface PersonaOperation {
  operationId: string;
  op: PersonaOperationKind;
  baseCurrentOperationId: string | null;
  baseGeneration: number;
  targetGeneration: number;
  inputDatesSnapshot: string[];
  consumedPendingDates: string[];
  consumedPendingDays: FrozenPendingRebaseDay[];
  rebuildRequestEpoch: number;
  partialMissingDates: string[];
  batchPlan: string[][];
  inputArtifactDir: string;
  nextBatchIndex: number;
  accumulatorGeneration: number | null;
  accumulatorHash: string | null;
  checkpointPath: string | null;
  checkpointSha256: string | null;
  attemptCount: number;
  nextAttemptEpoch: number | null;
  lastError: string | null;
  terminal: boolean;
}

export interface BeginPersonaOperationInput {
  operationId: string;
  op: PersonaOperationKind;
  inputDatesSnapshot: readonly string[];
  consumedPendingDates?: readonly string[];
  consumedPendingDays?: readonly FrozenPendingRebaseDay[];
  rebuildRequestEpoch?: number;
  partialMissingDates?: readonly string[];
  baseCurrentOperationId?: string | null;
  baseGeneration?: number;
  targetGeneration?: number;
  batchPlan?: readonly (readonly string[])[];
  inputArtifactDir?: string;
}

export interface AdvancePersonaCheckpointInput {
  operationId: string;
  nextBatchIndex: number;
  accumulatorGeneration: number;
  accumulatorHash: string;
  checkpointPath: string;
  checkpointSha256: string;
}

export interface RecordPersonaOperationFailureInput {
  operationId: string;
  error: string;
  nextAttemptEpoch: number;
}

export interface DiaryStateStore {
  enqueueDay(input: EnqueueDiaryDayInput): void;
  claimNextDiaryItem(claimedAtEpoch: number): PendingQueueItem | null;
  hasReadyDiaryItem(nowEpoch: number): boolean;
  getDayState(date: string): DiaryDayState | null;
  recordFailure(input: RecordDiaryFailureInput): void;
  settleDay(input: SettleDiaryDayInput): void;
  commitDayState(input: CommitDiaryDayStateInput): void;
  commitDayTombstone(input: CommitDiaryDayTombstoneInput): void;
  acknowledgeDiaryItem(queueSeq: number): void;
  hasQueuedDay(date: string): boolean;
  markDayStale(date: string): void;
  markDayStaleAndEnqueue(input: EnqueueDiaryDayInput): void;
  reconcileBacklog(input: ReconcileDiaryBacklogInput): string[];
  listIndexRows(): DiaryIndexRow[];
  initializeBootstrap(today: string): DiaryBootstrapState;
  listSettledDays(): SettledDiaryDay[];
  nextIntegrityScanBatch(input: DiaryIntegrityScanInput): SettledDiaryDay[];
  listPendingRebaseDays(): SettledDiaryDay[];
  getPersonaRebuildGate(today: string): PersonaRebuildGate;
  getPersonaCursor(): PersonaCursor;
  commitPersonaCursor(input: CommitPersonaCursorInput): void;
  requestPersonaRebuild(): void;
  getPersonaOperation(): PersonaOperation | null;
  beginPersonaOperation(input: BeginPersonaOperationInput): void;
  initializePersonaOperationArtifacts(input: {
    operationId: string;
    baseCurrentOperationId: string | null;
    baseGeneration: number;
    targetGeneration: number;
    batchPlan: readonly (readonly string[])[];
    inputArtifactDir: string;
  }): void;
  advancePersonaCheckpoint(input: AdvancePersonaCheckpointInput): void;
  terminalPersonaOperation(operationId: string, error: string): void;
  recordPersonaOperationFailure(
    input: RecordPersonaOperationFailureInput,
  ): void;
  completePersonaOperation(operationId: string): void;
}

interface PersonaOperationRow {
  operationId: string;
  op: PersonaOperationKind;
  baseCurrentOperationId: string | null;
  baseGeneration: number;
  targetGeneration: number;
  inputDatesSnapshot: string;
  consumedPendingDates: string;
  rebuildRequestEpoch: number;
  partialMissingDates: string;
  batchPlan: string;
  inputArtifactDir: string;
  nextBatchIndex: number;
  accumulatorGeneration: number | null;
  accumulatorHash: string | null;
  checkpointPath: string | null;
  checkpointSha256: string | null;
  attemptCount: number;
  nextAttemptEpoch: number | null;
  lastError: string | null;
  terminal: number;
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
  fileSha256: string | null;
  indexHook: string | null;
  validationReportJson: string | null;
  settledAtEpoch: number | null;
  needsRegen: number;
  pendingRebase: number;
  attemptCount: number;
  nextAttemptEpoch: number | null;
  lastError: string | null;
  terminal: number;
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
  const date = diaryDayOf(createdAtEpoch);
  db.query<unknown, [string]>(
    `
      UPDATE diary_day_state
      SET needs_regen = 1,
          attempt_count = 0,
          next_attempt_epoch = NULL,
          last_error = NULL,
          terminal = 0
      WHERE date = ?
        AND settled_at_epoch IS NOT NULL
        AND date >= COALESCE(
          (SELECT value FROM diary_state WHERE key = 'cutover_date'),
          '9999-12-31'
        )
    `,
  ).run(date);
}

export function createDiaryStateStore(db: Database): DiaryStateStore {
  return {
    enqueueDay(input): void {
      const targetId = Number(input.date.replaceAll("-", ""));

      runWriteTransaction(db, () => {
        db.query<unknown, [string]>(
          `
            INSERT INTO diary_day_state (date)
            VALUES (?)
            ON CONFLICT DO NOTHING
          `,
        ).run(input.date);

        db.query<unknown, [number, number]>(
          `
            INSERT INTO pending_queue (
              kind,
              target_id,
              session_db_id,
              enqueued_at_epoch
            ) VALUES ('diary', ?, 0, ?)
            ON CONFLICT DO NOTHING
          `,
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

        if (!row) {
          return null;
        }

        const result = db
          .query<unknown, [number, number]>(
            `
              UPDATE pending_queue
              SET claimed_at_epoch = ?
              WHERE seq = ? AND claimed_at_epoch IS NULL
            `,
          )
          .run(claimedAtEpoch, row.seq);

        if (result.changes !== 1) {
          throw new Error(`unexpected claim race on diary queue seq=${row.seq}`);
        }

        return {
          ...row,
          claimedAtEpoch,
        };
      });
    },

    hasReadyDiaryItem(nowEpoch): boolean {
      return (
        db
          .query<{ one: number }, [number]>(
            `${DIARY_QUEUE_SELECT}
             WHERE q.kind = 'diary'
               AND q.claimed_at_epoch IS NULL
               AND d.terminal = 0
               AND (d.next_attempt_epoch IS NULL OR d.next_attempt_epoch <= ?)
             LIMIT 1`,
          )
          .get(nowEpoch) !== null
      );
    },

    getDayState(date): DiaryDayState | null {
      const row = db
        .query<DiaryDayStateRow, [string]>(
          `
            SELECT
              date,
              watermark,
              file_sha256 AS fileSha256,
              index_hook AS indexHook,
              validation_report_json AS validationReportJson,
              settled_at_epoch AS settledAtEpoch,
              needs_regen AS needsRegen,
              pending_rebase AS pendingRebase,
              attempt_count AS attemptCount,
              next_attempt_epoch AS nextAttemptEpoch,
              last_error AS lastError,
              terminal
            FROM diary_day_state
            WHERE date = ?
          `,
        )
        .get(date);

      if (!row) {
        return null;
      }

      return {
        ...row,
        needsRegen: row.needsRegen === 1,
        pendingRebase: row.pendingRebase === 1,
        terminal: row.terminal === 1,
      };
    },

    recordFailure(input): void {
      runWriteTransaction(db, () => {
        db.query<unknown, [number, string, string]>(
          `
            UPDATE diary_day_state
            SET attempt_count = attempt_count + 1,
                next_attempt_epoch = CASE
                  WHEN attempt_count + 1 >= 3 THEN NULL
                  ELSE ?
                END,
                last_error = ?,
                terminal = CASE
                  WHEN attempt_count + 1 >= 3 THEN 1
                  ELSE terminal
                END
            WHERE date = ?
          `,
        ).run(input.nextAttemptEpoch, input.error, input.date);

        db.query<unknown, [number, string]>(
          `
            DELETE FROM pending_queue
            WHERE seq = ?
              AND kind = 'diary'
              AND EXISTS (
                SELECT 1
                FROM diary_day_state
                WHERE date = ? AND terminal = 1
              )
          `,
        ).run(input.queueSeq, input.date);

        db.query<unknown, [number]>(
          `
            UPDATE pending_queue
            SET claimed_at_epoch = NULL
            WHERE seq = ? AND kind = 'diary'
          `,
        ).run(input.queueSeq);
      });
    },

    settleDay(input): void {
      runWriteTransaction(db, () => {
        db.query<unknown, [string, string, string, string, number, string]>(
          `
            UPDATE diary_day_state
            SET watermark = ?,
                file_sha256 = ?,
                index_hook = ?,
                validation_report_json = ?,
                settled_at_epoch = ?,
                needs_regen = 0,
                attempt_count = 0,
                next_attempt_epoch = NULL,
                last_error = NULL,
                terminal = 0
            WHERE date = ?
          `,
        ).run(
          input.watermark,
          input.fileSha256,
          input.indexHook,
          input.validationReportJson,
          input.settledAtEpoch,
          input.date,
        );

        db.query<unknown, [number]>(
          "DELETE FROM pending_queue WHERE seq = ? AND kind = 'diary'",
        ).run(input.queueSeq);
      });
    },

    commitDayState(input): void {
      db.query<unknown, [string, string, string, string, number, number, string]>(
        `
          UPDATE diary_day_state
          SET watermark = ?,
              file_sha256 = ?,
              index_hook = ?,
              validation_report_json = ?,
              settled_at_epoch = ?,
              pending_rebase = CASE
                WHEN ? = 1 THEN 1
                ELSE pending_rebase
              END,
              needs_regen = 0,
              attempt_count = 0,
              next_attempt_epoch = NULL,
              last_error = NULL,
              terminal = 0
          WHERE date = ?
        `,
      ).run(
        input.watermark,
        input.fileSha256,
        input.indexHook,
        input.validationReportJson,
        input.settledAtEpoch,
        input.pendingRebase ? 1 : 0,
        input.date,
      );
    },

    commitDayTombstone(input): void {
      runWriteTransaction(db, () => {
        const result = db.query<unknown, [string]>(
          `
            UPDATE diary_day_state
            SET watermark = 'empty',
                file_sha256 = NULL,
                index_hook = NULL,
                validation_report_json = NULL,
                needs_regen = 0,
                pending_rebase = 0,
                attempt_count = 0,
                next_attempt_epoch = NULL,
                last_error = NULL,
                terminal = 0
            WHERE date = ?
          `,
        ).run(input.date);
        if (result.changes !== 1) {
          throw new Error(`Cannot tombstone missing diary day: ${input.date}`);
        }

        if (input.requestRebuild) {
          db.query<unknown, []>(
            `
              INSERT INTO diary_state (key, value) VALUES ('rebuild_request_epoch', '1')
              ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1
            `,
          ).run();
        }
      });
    },

    acknowledgeDiaryItem(queueSeq): void {
      db.query<unknown, [number]>(
        "DELETE FROM pending_queue WHERE seq = ? AND kind = 'diary'",
      ).run(queueSeq);
    },

    hasQueuedDay(date): boolean {
      const targetId = Number(date.replaceAll("-", ""));
      return (
        db
          .query<{ one: number }, [number]>(
            `
              SELECT 1 AS one
              FROM pending_queue
              WHERE kind = 'diary' AND target_id = ?
              LIMIT 1
            `,
          )
          .get(targetId) !== null
      );
    },

    markDayStale(date): void {
      db.query<unknown, [string]>(
        `
          UPDATE diary_day_state
          SET needs_regen = 1,
              attempt_count = 0,
              next_attempt_epoch = NULL,
              last_error = NULL,
              terminal = 0
          WHERE date = ?
        `,
      ).run(date);
    },

    markDayStaleAndEnqueue(input): void {
      runWriteTransaction(db, () => {
        this.markDayStale(input.date);
        this.enqueueDay(input);
      });
    },

    reconcileBacklog(input): string[] {
      const recentStart = new Date(
        Date.parse(`${input.today}T00:00:00Z`) - 14 * 24 * 60 * 60 * 1_000,
      )
        .toISOString()
        .slice(0, 10);
      const windowStart =
        input.cutoverDate > recentStart ? input.cutoverDate : recentStart;
      const startEpoch = Date.parse(`${windowStart}T00:00:00+08:00`) / 1_000;
      const endEpoch = Date.parse(`${input.today}T00:00:00+08:00`) / 1_000;
      const dates = new Set(
        db
          .query<{ createdAtEpoch: number }, [number, number]>(
            `
              SELECT created_at_epoch AS createdAtEpoch
              FROM turns
              WHERE created_at_epoch >= ?
                AND created_at_epoch < ?
                AND status != 'undone'
            `,
          )
          .all(startEpoch, endEpoch)
          .map((row) => diaryDayOf(row.createdAtEpoch)),
      );

      for (const row of db
        .query<
          { date: string },
          [string, string, string, string]
        >(
          `
            SELECT date
            FROM diary_day_state
            WHERE (date >= ? AND date < ?)
               OR (needs_regen = 1 AND date >= ? AND date < ?)
          `,
        )
        .all(windowStart, input.today, input.cutoverDate, input.today)) {
        dates.add(row.date);
      }

      const sortedDates = Array.from(dates).sort();

      const datesNeedingWork: string[] = [];

      for (const date of sortedDates) {
        const dayStartEpoch =
          Date.parse(`${date}T00:00:00+08:00`) / 1_000;
        const material = db
          .query<DiaryWatermarkMaterial, [number, number]>(
            `
              SELECT
                id AS turnId,
                status,
                user_prompt AS userPrompt,
                assistant_response AS assistantResponse,
                title,
                content,
                insight
              FROM turns
              WHERE created_at_epoch >= ?
                AND created_at_epoch < ?
                AND status != 'undone'
              ORDER BY id ASC
            `,
          )
          .all(dayStartEpoch, dayStartEpoch + 24 * 60 * 60);
        const currentWatermark = computeDiaryWatermark(material);
        const state = this.getDayState(date);
        if (
          state !== null &&
          !state.needsRegen &&
          state.watermark === currentWatermark
        ) {
          continue;
        }

        if (state !== null && state.watermark !== currentWatermark) {
          this.markDayStale(date);
        }
        this.enqueueDay({ date, enqueuedAtEpoch: input.enqueuedAtEpoch });
        datesNeedingWork.push(date);
      }

      return datesNeedingWork;
    },

    listIndexRows(): DiaryIndexRow[] {
      return db
        .query<DiaryIndexRow, []>(
          `
            SELECT date, index_hook AS indexHook
            FROM diary_day_state
            ORDER BY date ASC
          `,
        )
        .all();
    },

    initializeBootstrap(today): DiaryBootstrapState {
      const defaultCutoverDate = new Date(
        Date.parse(`${today}T00:00:00Z`) - 14 * 24 * 60 * 60 * 1_000,
      )
        .toISOString()
        .slice(0, 10);

      return runWriteTransaction(db, () => {
        db.query<unknown, [string, string, string]>(
          `
            INSERT INTO diary_state (key, value)
            VALUES ('cutover_date', ?), ('rebuild_requested', ?), ('rebuild_request_epoch', ?)
            ON CONFLICT DO NOTHING
          `,
        ).run(defaultCutoverDate, "1", "1");

        const rows = db
          .query<{ key: string; value: string }, []>(
            `
              SELECT key, value
              FROM diary_state
              WHERE key IN ('cutover_date', 'rebuild_requested')
            `,
          )
          .all();
        const values = new Map(rows.map((row) => [row.key, row.value]));

        return {
          cutoverDate: values.get("cutover_date")!,
          rebuildRequested: values.get("rebuild_requested") === "1",
        };
      });
    },

    listSettledDays(): SettledDiaryDay[] {
      return db
        .query<SettledDiaryDay, []>(
          `
            SELECT
              date,
              watermark,
              file_sha256 AS fileSha256,
              index_hook AS indexHook
            FROM diary_day_state
            WHERE settled_at_epoch IS NOT NULL
              AND watermark IS NOT NULL
              AND watermark != 'empty'
              AND file_sha256 IS NOT NULL
              AND index_hook IS NOT NULL
            ORDER BY date ASC
          `,
        )
        .all();
    },

    nextIntegrityScanBatch(input): SettledDiaryDay[] {
      if (!Number.isInteger(input.limit) || input.limit <= 0) {
        return [];
      }

      return runWriteTransaction(db, () => {
        const days = this.listSettledDays().filter(
          (day) => day.date < input.beforeDate,
        );
        if (days.length === 0) {
          return [];
        }

        const cursor = db
          .query<{ value: string }, []>(
            "SELECT value FROM diary_state WHERE key = 'integrity_cursor'",
          )
          .get()?.value;
        const nextIndex = cursor
          ? days.findIndex((day) => day.date > cursor)
          : 0;
        const startIndex = nextIndex >= 0 ? nextIndex : 0;
        const batchSize = Math.min(input.limit, days.length);
        const batch = Array.from(
          { length: batchSize },
          (_, offset) => days[(startIndex + offset) % days.length]!,
        );

        db.query<unknown, [string]>(
          `
            INSERT INTO diary_state (key, value)
            VALUES ('integrity_cursor', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
          `,
        ).run(batch.at(-1)!.date);

        return batch;
      });
    },

    listPendingRebaseDays(): SettledDiaryDay[] {
      return db
        .query<SettledDiaryDay, []>(
          `
            SELECT
              date,
              watermark,
              file_sha256 AS fileSha256,
              index_hook AS indexHook
            FROM diary_day_state
            WHERE pending_rebase = 1
              AND settled_at_epoch IS NOT NULL
              AND watermark IS NOT NULL
              AND watermark != 'empty'
              AND file_sha256 IS NOT NULL
              AND index_hook IS NOT NULL
            ORDER BY date ASC
          `,
        )
        .all();
    },

    getPersonaRebuildGate(today): PersonaRebuildGate {
      const rows = db
        .query<{ date: string; terminal: number }, [string]>(
          `
            SELECT date, terminal
            FROM diary_day_state
            WHERE date >= COALESCE(
                (SELECT value FROM diary_state WHERE key = 'cutover_date'),
                '9999-12-31'
              )
              AND date < ?
              AND (settled_at_epoch IS NULL OR needs_regen = 1)
            ORDER BY date ASC
          `,
        )
        .all(today);

      return {
        blockingDates: rows
          .filter((row) => row.terminal === 0)
          .map((row) => row.date),
        partialMissingDates: rows
          .filter((row) => row.terminal === 1)
          .map((row) => row.date),
      };
    },

    getPersonaCursor(): PersonaCursor {
      const rows = db
        .query<{ key: string; value: string }, []>(
          `
            SELECT key, value
            FROM diary_state
            WHERE key IN (
              'last_folded_date',
              'last_applied_operation_id',
              'folds_since_rebase',
              'rebuild_requested',
              'rebuild_request_epoch',
              'rebuild_confirmed_epoch'
            )
          `,
        )
        .all();
      const values = new Map(rows.map((row) => [row.key, row.value]));

      const rebuildRequestEpoch = Number(values.get("rebuild_request_epoch") ?? (values.get("rebuild_requested") === "1" ? "1" : "0"));
      const rebuildConfirmedEpoch = Number(values.get("rebuild_confirmed_epoch") ?? "0");
      const cursor = {
        lastFoldedDate: values.get("last_folded_date") ?? null,
        lastAppliedOperationId:
          values.get("last_applied_operation_id") ?? null,
        foldsSinceRebase: Number(values.get("folds_since_rebase") ?? "0"),
        rebuildRequested: rebuildRequestEpoch > rebuildConfirmedEpoch,
      } as PersonaCursor;
      Object.defineProperties(cursor, {
        rebuildRequestEpoch: { value: rebuildRequestEpoch, enumerable: false },
        rebuildConfirmedEpoch: { value: rebuildConfirmedEpoch, enumerable: false },
      });
      return cursor;
    },

    commitPersonaCursor(input): void {
      runWriteTransaction(db, () => {
        const entries = [
          ["last_folded_date", input.lastFoldedDate],
          ["last_applied_operation_id", input.lastAppliedOperationId],
          ["folds_since_rebase", String(input.foldsSinceRebase ?? 0)],
        ] as const;

        for (const [key, value] of entries) {
          db.query<unknown, [string, string]>(
            `
              INSERT INTO diary_state (key, value)
              VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value
            `,
          ).run(key, value);
        }

        if (input.confirmedRebuildEpoch !== undefined) {
          db.query<unknown, [string]>(`
            INSERT INTO diary_state (key, value) VALUES ('rebuild_confirmed_epoch', ?)
            ON CONFLICT(key) DO UPDATE SET value = MAX(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER))
          `).run(String(input.confirmedRebuildEpoch));
        } else if (input.rebuildRequested === false) {
          const requested = this.getPersonaCursor().rebuildRequestEpoch;
          db.query<unknown, [string]>(`
            INSERT INTO diary_state (key, value) VALUES ('rebuild_confirmed_epoch', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
          `).run(String(requested));
        }

        for (const day of input.consumedPendingDays ?? []) {
          db.query<unknown, [string, string, string]>(
            "UPDATE diary_day_state SET pending_rebase = 0 WHERE date = ? AND watermark = ? AND file_sha256 = ?",
          ).run(day.date, day.watermark, day.fileSha256);
        }
      });
    },

    requestPersonaRebuild(): void {
      runWriteTransaction(db, () => {
        db.query<unknown, []>(
          `
            INSERT INTO diary_state (key, value) VALUES ('rebuild_request_epoch', '1')
            ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1
          `,
        ).run();
      });
    },

    getPersonaOperation(): PersonaOperation | null {
      const row = db
        .query<PersonaOperationRow, []>(
          `
            SELECT
              operation_id AS operationId,
              op,
              base_current_operation_id AS baseCurrentOperationId,
              base_generation AS baseGeneration,
              target_generation AS targetGeneration,
              input_dates_snapshot AS inputDatesSnapshot,
              consumed_pending_dates AS consumedPendingDates,
              rebuild_request_epoch AS rebuildRequestEpoch,
              partial_missing_dates AS partialMissingDates,
              batch_plan AS batchPlan,
              input_artifact_dir AS inputArtifactDir,
              next_batch_index AS nextBatchIndex,
              accumulator_generation AS accumulatorGeneration,
              accumulator_hash AS accumulatorHash,
              checkpoint_path AS checkpointPath,
              checkpoint_sha256 AS checkpointSha256,
              attempt_count AS attemptCount,
              next_attempt_epoch AS nextAttemptEpoch,
              last_error AS lastError,
              terminal
            FROM persona_operation_state
            ORDER BY terminal DESC, rowid DESC
            LIMIT 1
          `,
        )
        .get();
      if (!row) {
        return null;
      }

      const inputDatesSnapshot: unknown = JSON.parse(row.inputDatesSnapshot);
      const consumedPendingDates: unknown = JSON.parse(row.consumedPendingDates);
      const partialMissingDates: unknown = JSON.parse(row.partialMissingDates);
      const batchPlan: unknown = JSON.parse(row.batchPlan);
      if (
        !Array.isArray(inputDatesSnapshot) ||
        !inputDatesSnapshot.every((date) => typeof date === "string") ||
        !Array.isArray(consumedPendingDates) ||
        !consumedPendingDates.every((value) => typeof value === "string" || (
          typeof value === "object" && value !== null &&
          typeof (value as FrozenPendingRebaseDay).date === "string" &&
          typeof (value as FrozenPendingRebaseDay).watermark === "string" &&
          typeof (value as FrozenPendingRebaseDay).fileSha256 === "string"
        )) ||
        !Array.isArray(partialMissingDates) || !partialMissingDates.every((date) => typeof date === "string") ||
        !Array.isArray(batchPlan) ||
        !batchPlan.every(
          (batch) =>
            Array.isArray(batch) &&
            batch.every((date) => typeof date === "string"),
        )
      ) {
        throw new Error(`invalid persona input snapshot: ${row.operationId}`);
      }

      return {
        ...row,
        inputDatesSnapshot,
        consumedPendingDates: consumedPendingDates.map((value) => typeof value === "string" ? value : value.date),
        consumedPendingDays: consumedPendingDates.map((value) => typeof value === "string" ? { date: value, watermark: "", fileSha256: "" } : value),
        partialMissingDates,
        batchPlan,
        terminal: row.terminal === 1,
      };
    },

    beginPersonaOperation(input): void {
      db.query<
        unknown,
        [
          string,
          PersonaOperationKind,
          string | null,
          number,
          number,
          string,
          string,
          number,
          string,
          string,
          string,
        ]
      >(
        `
          INSERT INTO persona_operation_state (
            operation_id,
            op,
            base_current_operation_id,
            base_generation,
            target_generation,
            input_dates_snapshot,
            consumed_pending_dates,
            rebuild_request_epoch,
            partial_missing_dates,
            batch_plan,
            input_artifact_dir
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        input.operationId,
        input.op,
        input.baseCurrentOperationId ?? null,
        input.baseGeneration ?? 0,
        input.targetGeneration ?? (input.baseGeneration ?? 0) + 1,
        JSON.stringify(input.inputDatesSnapshot),
        JSON.stringify(input.consumedPendingDays ?? input.consumedPendingDates ?? []),
        input.rebuildRequestEpoch ?? this.getPersonaCursor().rebuildRequestEpoch,
        JSON.stringify(input.partialMissingDates ?? []),
        JSON.stringify(input.batchPlan ?? [input.inputDatesSnapshot]),
        input.inputArtifactDir ?? "",
      );
    },

    initializePersonaOperationArtifacts(input): void {
      db.query<unknown, [string | null, number, number, string, string, string]>(
        `
          UPDATE persona_operation_state
          SET base_current_operation_id = ?,
              base_generation = ?,
              target_generation = ?,
              batch_plan = ?,
              input_artifact_dir = ?
          WHERE operation_id = ? AND input_artifact_dir = '' AND terminal = 0
        `,
      ).run(
        input.baseCurrentOperationId,
        input.baseGeneration,
        input.targetGeneration,
        JSON.stringify(input.batchPlan),
        input.inputArtifactDir,
        input.operationId,
      );
    },

    advancePersonaCheckpoint(input): void {
      runWriteTransaction(db, () => {
        db.query<
          unknown,
          [number, number, string, string, string, string]
        >(
          `
            UPDATE persona_operation_state
            SET next_batch_index = ?,
                accumulator_generation = ?,
                accumulator_hash = ?,
                checkpoint_path = ?,
                checkpoint_sha256 = ?,
                attempt_count = 0,
                next_attempt_epoch = NULL,
                last_error = NULL
            WHERE operation_id = ? AND terminal = 0
          `,
        ).run(
          input.nextBatchIndex,
          input.accumulatorGeneration,
          input.accumulatorHash,
          input.checkpointPath,
          input.checkpointSha256,
          input.operationId,
        );
      });
    },

    terminalPersonaOperation(operationId, error): void {
      db.query<unknown, [string, string]>(
        `
          UPDATE persona_operation_state
          SET terminal = 1,
              next_attempt_epoch = NULL,
              last_error = ?
          WHERE operation_id = ?
        `,
      ).run(error, operationId);
    },

    recordPersonaOperationFailure(input): void {
      db.query<unknown, [number, string, string]>(
        `
          UPDATE persona_operation_state
          SET attempt_count = attempt_count + 1,
              next_attempt_epoch = CASE
                WHEN attempt_count + 1 >= 3 THEN NULL
                ELSE ?
              END,
              last_error = ?,
              terminal = CASE
                WHEN attempt_count + 1 >= 3 THEN 1
                ELSE terminal
              END
          WHERE operation_id = ? AND terminal = 0
        `,
      ).run(input.nextAttemptEpoch, input.error, input.operationId);
    },

    completePersonaOperation(operationId): void {
      db.query<unknown, [string]>(
        "DELETE FROM persona_operation_state WHERE operation_id = ?",
      ).run(operationId);
    },
  };
}
