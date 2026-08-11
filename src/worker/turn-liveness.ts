import type { Database } from "bun:sqlite";

import { runWriteTransaction } from "../db/database";
import { calendarDayBounds, contentDateAt } from "../diary/calendar";
import { getTurnById, updateTurnById } from "../db/turns";
import {
  aggregateTurnFiles,
  completionFloorStatus,
} from "../db/turn-completion";

export interface RestoreStrandedTurnStopsOptions {
  /** Content-days to scan — see `listStrandedRepairDates`, the only producer. */
  dates: string[];
  timeZone: string;
  boundaryHour: number;
  nowEpoch: number;
  hasRegisteredSessionEnv(sessionDbId: number): boolean;
}

/**
 * Everything about a turn that the "unreachable" verdict rested on, sampled at
 * the moment the verdict was reached. The finalizer re-samples it inside its
 * write transaction and refuses to floor a turn whose sample moved: between the
 * two, the caller awaits a drain, and a session that re-registers its
 * environment in that window is being resumed, not abandoned.
 */
export interface StrandedTurnEvidence {
  status: string;
  /** seq of every turn-stop row targeting the turn, ascending. */
  turnStopSeqs: number[];
  /** Highest observation id the turn had; 0 when it had none. */
  latestObservationId: number;
}

export interface UnreachableStrandedTurn {
  turnId: number;
  sessionDbId: number;
  evidence: StrandedTurnEvidence;
}

export interface StrandedTurnRepairResult {
  strandedTurnIds: number[];
  unreachable: UnreachableStrandedTurn[];
  enqueuedSessionDbIds: number[];
  enqueuedTurnStopCount: number;
}

export interface FlooredTurnResult {
  turnId: number;
  sessionDbId: number;
  status: "extracted" | "skipped" | "failed";
  reasonCode: "unreachable-partial-preserved" | "unreachable-no-usable-record";
}

export interface FinalizeUnreachableOptions {
  /** Re-asked per turn inside the write transaction, never cached. */
  hasRegisteredSessionEnv(sessionDbId: number): boolean;
  /**
   * P2 era boundary (spec D11). Only decides what an un-noted turn is floored
   * to — `skipped` in the new era, `failed` before it. Omitted = legacy.
   */
  eraCutoffEpoch?: number | null;
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
 * That coverage argument holds where `contentDateAt` and `calendarDayBounds`
 * are exact inverses, which is any zone without DST — the Asia/Shanghai default
 * and the UTC the tests use. Under a DST zone with a small-hours boundary (say
 * America/New_York at 4am) a transition day's bounds and its derived date can
 * disagree by an hour, so a turn inside that hour may land on a neighbouring
 * day. It would be re-derived on the next end event, and nothing here is
 * configured for such a zone today; this is a documented limit, not a claim.
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
  const unreachable: UnreachableStrandedTurn[] = [];
  const enqueuedSessionDbIds = new Set<number>();
  let enqueuedTurnStopCount = 0;

  for (const candidate of candidates.values()) {
    strandedTurnIds.push(candidate.id);
    if (!options.hasRegisteredSessionEnv(candidate.sessionDbId)) {
      const evidence = readStrandedTurnEvidence(db, candidate.id);
      if (evidence) {
        unreachable.push({
          turnId: candidate.id,
          sessionDbId: candidate.sessionDbId,
          evidence,
        });
      }
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
    unreachable,
    enqueuedSessionDbIds: [...enqueuedSessionDbIds],
    enqueuedTurnStopCount,
  };
}

function readStrandedTurnEvidence(
  db: Database,
  turnId: number,
): StrandedTurnEvidence | null {
  const turn = getTurnById(db, turnId);
  if (!turn) {
    return null;
  }

  return {
    status: turn.status,
    turnStopSeqs: db
      .query<{ seq: number }, [number]>(
        `SELECT seq FROM pending_queue
         WHERE kind = 'turn-stop' AND target_id = ?
         ORDER BY seq ASC`,
      )
      .all(turnId)
      .map((row) => row.seq),
    latestObservationId:
      db
        .query<{ maxId: number | null }, [number]>(
          "SELECT MAX(id) AS maxId FROM observations WHERE turn_id = ?",
        )
        .get(turnId)?.maxId ?? 0,
  };
}

function sameEvidence(
  left: StrandedTurnEvidence,
  right: StrandedTurnEvidence,
): boolean {
  return (
    left.status === right.status &&
    left.latestObservationId === right.latestObservationId &&
    left.turnStopSeqs.length === right.turnStopSeqs.length &&
    left.turnStopSeqs.every((seq, index) => seq === right.turnStopSeqs[index])
  );
}

/**
 * Write the completion floor for turns the scan judged unreachable.
 *
 * The verdict is re-established here rather than trusted: the caller awaits a
 * drain between the scan and this call, and during that await a session can
 * re-register its environment (server.ts's registerSessionEnv) and have its
 * turn-stops re-queued. Flooring on the stale verdict would mark a turn that is
 * mid-resume as failed and delete the queue rows carrying its resume. So every
 * turn is re-checked inside its own write transaction — environment first, then
 * the evidence sample — and anything that moved is left for the next end event.
 */
export function finalizeUnreachableStrandedTurns(
  db: Database,
  unreachableTurns: Iterable<UnreachableStrandedTurn>,
  options: FinalizeUnreachableOptions,
): FlooredTurnResult[] {
  const results: FlooredTurnResult[] = [];
  const seen = new Set<number>();

  for (const candidate of unreachableTurns) {
    if (seen.has(candidate.turnId)) {
      continue;
    }
    seen.add(candidate.turnId);
    const turnId = candidate.turnId;

    const result = runWriteTransaction(db, () => {
      const turn = getTurnById(db, turnId);
      if (
        !turn ||
        (turn.status !== "active" && turn.status !== "provisional")
      ) {
        return null;
      }
      // The session came back while the drain ran: its work is live again and
      // the floor would destroy it.
      if (options.hasRegisteredSessionEnv(turn.sessionId)) {
        return null;
      }
      const current = readStrandedTurnEvidence(db, turnId);
      if (!current || !sameEvidence(current, candidate.evidence)) {
        return null;
      }
      const status = completionFloorStatus(
        turn,
        options.eraCutoffEpoch ?? null,
      );
      db.query<unknown, [string, number]>(
        "UPDATE turns SET status = ? WHERE id = ?",
      ).run(status, turnId);
      // Flooring is still a completion: the turn did the work, only nobody was
      // left to narrate it. `files_read` / `files_modified` / `tool_call_count`
      // have one writer (db/turn-completion.ts), so skipping the aggregation
      // here would drop this turn out of `file:` recall permanently.
      updateTurnById(db, turnId, aggregateTurnFiles(db, turnId));
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
