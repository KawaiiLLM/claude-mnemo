import type { Database } from "bun:sqlite";

import { runWriteTransaction } from "../db/database";
import { calendarDayBounds } from "../diary/calendar";
import { getTurnById, type TurnRecord } from "../db/turns";

export interface RestoreStrandedTurnStopsOptions {
  dueDates: string[];
  timeZone: string;
  boundaryHour: number;
  nowEpoch: number;
  hasRegisteredSessionEnv(sessionDbId: number): boolean;
}

export interface StrandedTurnRepairResult {
  strandedTurnIds: number[];
  unreachableTurnIds: number[];
  enqueuedSessionDbIds: number[];
  enqueuedTurnStopCount: number;
}

export interface FlooredTurnResult {
  turnId: number;
  sessionDbId: number;
  status: "extracted" | "failed";
  reasonCode: "unreachable-partial-preserved" | "unreachable-no-usable-record";
}

interface CandidateTurnRow {
  id: number;
  sessionDbId: number;
  promptNumber: number;
  wasInterrupted: number;
  wasRolledBack: number;
  hasQueuedStop: number;
  hasLaterTurn: number;
}

function listCompletionEvidencedTurnsForDate(
  db: Database,
  date: string,
  timeZone: string,
  boundaryHour: number,
): CandidateTurnRow[] {
  const { startEpoch, endEpoch } = calendarDayBounds(
    date,
    timeZone,
    boundaryHour,
  );
  return db.query<CandidateTurnRow, [number, number]>(
    `SELECT
       t.id,
       t.session_id AS sessionDbId,
       t.prompt_number AS promptNumber,
       t.was_interrupted AS wasInterrupted,
       t.was_rolled_back AS wasRolledBack,
       EXISTS (
         SELECT 1 FROM pending_queue q
         WHERE q.kind = 'turn-stop' AND q.target_id = t.id
       ) AS hasQueuedStop,
       EXISTS (
         SELECT 1 FROM turns later
         WHERE later.session_id = t.session_id
           AND later.prompt_number > t.prompt_number
       ) AS hasLaterTurn
     FROM turns t
     WHERE t.created_at_epoch >= ?
       AND t.created_at_epoch < ?
       AND t.status IN ('active', 'provisional')
       AND t.assistant_response IS NOT NULL
     ORDER BY t.created_at_epoch ASC, t.id ASC`,
  ).all(startEpoch, endEpoch).filter(
    (turn) =>
      turn.hasQueuedStop === 1 ||
      turn.hasLaterTurn === 1 ||
      turn.wasInterrupted === 1 ||
      turn.wasRolledBack === 1,
  );
}

export function restoreStrandedTurnStops(
  db: Database,
  options: RestoreStrandedTurnStopsOptions,
): StrandedTurnRepairResult {
  const candidates = new Map<number, CandidateTurnRow>();
  for (const date of new Set(options.dueDates)) {
    for (const candidate of listCompletionEvidencedTurnsForDate(
      db,
      date,
      options.timeZone,
      options.boundaryHour,
    )) {
      candidates.set(candidate.id, candidate);
    }
  }

  const strandedTurnIds: number[] = [];
  const unreachableTurnIds: number[] = [];
  const enqueuedSessionDbIds = new Set<number>();
  let enqueuedTurnStopCount = 0;

  for (const candidate of candidates.values()) {
    strandedTurnIds.push(candidate.id);
    if (!options.hasRegisteredSessionEnv(candidate.sessionDbId)) {
      unreachableTurnIds.push(candidate.id);
      continue;
    }
    const enqueued = runWriteTransaction(db, () => {
      const current = getTurnById(db, candidate.id);
      if (
        !current ||
        (current.status !== "active" && current.status !== "provisional")
      ) {
        return false;
      }
      const exists = db.query<{ one: number }, [number]>(
        `SELECT 1 AS one FROM pending_queue
         WHERE kind = 'turn-stop' AND target_id = ? LIMIT 1`,
      ).get(candidate.id);
      if (exists) {
        return false;
      }
      db.query<unknown, [number, number, number]>(
        `INSERT INTO pending_queue (
           kind, target_id, session_db_id, enqueued_at_epoch
         ) VALUES ('turn-stop', ?, ?, ?)`,
      ).run(candidate.id, candidate.sessionDbId, options.nowEpoch);
      return true;
    });
    if (enqueued) {
      enqueuedTurnStopCount += 1;
      enqueuedSessionDbIds.add(candidate.sessionDbId);
    }
  }

  return {
    strandedTurnIds,
    unreachableTurnIds,
    enqueuedSessionDbIds: [...enqueuedSessionDbIds],
    enqueuedTurnStopCount,
  };
}

export function completionFloorStatus(
  turn: Pick<TurnRecord, "title" | "content">,
): "extracted" | "failed" {
  return turn.title !== null || turn.content !== null ? "extracted" : "failed";
}

export function finalizeUnreachableStrandedTurns(
  db: Database,
  turnIds: Iterable<number>,
): FlooredTurnResult[] {
  const results: FlooredTurnResult[] = [];
  for (const turnId of new Set(turnIds)) {
    const result = runWriteTransaction(db, () => {
      const turn = getTurnById(db, turnId);
      if (
        !turn ||
        (turn.status !== "active" && turn.status !== "provisional")
      ) {
        return null;
      }
      const status = completionFloorStatus(turn);
      db.query<unknown, [string, number]>(
        "UPDATE turns SET status = ? WHERE id = ?",
      ).run(status, turnId);
      db.query<unknown, [number]>(
        `UPDATE observations SET status = 'skipped'
         WHERE turn_id = ? AND status = 'pending'`,
      ).run(turnId);
      db.query<unknown, [number, number]>(
        `DELETE FROM pending_queue
         WHERE (kind = 'turn-stop' AND target_id = ?)
            OR (kind = 'obs' AND target_id IN (
              SELECT id FROM observations WHERE turn_id = ?
            ))`,
      ).run(turnId, turnId);
      return {
        turnId,
        sessionDbId: turn.sessionId,
        status,
        reasonCode:
          status === "extracted"
            ? "unreachable-partial-preserved" as const
            : "unreachable-no-usable-record" as const,
      };
    });
    if (result) {
      results.push(result);
    }
  }
  return results;
}
