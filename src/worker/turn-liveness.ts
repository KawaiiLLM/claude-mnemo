import type { Database } from "bun:sqlite";

import { runWriteTransaction } from "../db/database";
import { calendarDayBounds, contentDateAt } from "../diary/calendar";
import { getTurnById, type TurnRecord } from "../db/turns";

export interface RestoreStrandedTurnStopsOptions {
  /** Content-days to scan — see `listStrandedRepairDates`, the only producer. */
  dates: string[];
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
}

/**
 * A turn is stranded when the client evidenced that it finished — a queued
 * turn-stop, a later prompt in the same session, an interrupt or a rollback —
 * yet the turn itself never reached a terminal status. One SQL fragment, shared
 * verbatim by the per-day candidate scan and the candidate-date derivation, so
 * the two readings of "stranded" cannot drift apart.
 */
const STRANDED_TURN_PREDICATE = `
  t.status IN ('active', 'provisional')
  AND t.assistant_response IS NOT NULL
  AND (
    t.was_interrupted = 1
    OR t.was_rolled_back = 1
    OR EXISTS (
      SELECT 1 FROM pending_queue q
      WHERE q.kind = 'turn-stop' AND q.target_id = t.id
    )
    OR EXISTS (
      SELECT 1 FROM turns later
      WHERE later.session_id = t.session_id
        AND later.prompt_number > t.prompt_number
    )
  )`;

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
    `SELECT t.id, t.session_id AS sessionDbId
     FROM turns t
     WHERE t.created_at_epoch >= ?
       AND t.created_at_epoch < ?
       AND ${STRANDED_TURN_PREDICATE}
     ORDER BY t.created_at_epoch ASC, t.id ASC`,
  ).all(startEpoch, endEpoch);
}

/**
 * The closed content-days the repair has to visit, derived read-only from the
 * DB and the clock, from nothing else. Every stranded turn contributes its own
 * content-day and `listCompletionEvidencedTurnsForDate` re-selects exactly the
 * stranded turns falling inside a day, so this is by construction the smallest
 * date set that still yields every candidate on a closed day — no external
 * backlog can add a candidate it does not already cover.
 *
 * The still-open day is withheld deliberately. Not every queued turn-stop is
 * abandoned: a connection failure suspends its row for a later resume, and a
 * cleared session env gates its rows rather than dropping them. The repair
 * cannot tell those apart from genuine strandings, so it only claims a day once
 * that day is over — the same grace the dream due-day scan used to give it by
 * accident. `contentDateAt` inverts `calendarDayBounds` for a zone without DST
 * (the Asia/Shanghai default).
 */
export function listStrandedRepairDates(
  db: Database,
  options: { timeZone: string; boundaryHour: number; nowEpoch: number },
): string[] {
  const openDate = contentDateAt(
    options.nowEpoch,
    options.timeZone,
    options.boundaryHour,
  );
  const dates = new Set<string>();
  for (
    const row of db.query<{ createdAtEpoch: number }, []>(
      `SELECT DISTINCT t.created_at_epoch AS createdAtEpoch
       FROM turns t
       WHERE ${STRANDED_TURN_PREDICATE}
       ORDER BY t.created_at_epoch ASC`,
    ).all()
  ) {
    // A turn with no usable timestamp lands in no day's bounds, so the day scan
    // could never select it anyway — and `Intl` throws on a non-finite instant.
    if (!Number.isFinite(row.createdAtEpoch)) {
      continue;
    }
    const date = contentDateAt(
      row.createdAtEpoch,
      options.timeZone,
      options.boundaryHour,
    );
    // ISO dates compare chronologically, so this also drops a clock-skewed
    // future day, which is no more closed than today is.
    if (date < openDate) {
      dates.add(date);
    }
  }
  return [...dates];
}

export function restoreStrandedTurnStops(
  db: Database,
  options: RestoreStrandedTurnStopsOptions,
): StrandedTurnRepairResult {
  const candidates = new Map<number, CandidateTurnRow>();
  for (const date of new Set(options.dates)) {
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
