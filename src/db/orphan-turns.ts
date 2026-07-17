import type { Database } from "bun:sqlite";

import { enqueueQueueItem } from "./pending-queue";

export interface OrphanTurnRef {
  id: number;
  promptNumber: number;
}

/**
 * Turns whose extraction was never triggered: still `active`, no
 * assistant_response (interrupted before the Stop hook could fire), and no
 * pending `turn-stop` item. Distinct from the stranded class
 * (recover-stranded.ts), which requires a non-null assistant_response.
 * `beforeTurnId` excludes the turn currently being stopped (Stop-hook path);
 * omit it to scan the whole session (SessionEnd path).
 */
export function getOrphanTurns(
  db: Database,
  sessionDbId: number,
  beforeTurnId?: number,
): OrphanTurnRef[] {
  return db
    .query<OrphanTurnRef, [number, number]>(
      `
        SELECT
          t.id,
          t.prompt_number AS promptNumber
        FROM turns t
        WHERE t.session_id = ?
          AND t.status = 'active'
          AND t.id < ?
          AND t.assistant_response IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM pending_queue q
            WHERE q.kind = 'turn-stop' AND q.target_id = t.id
          )
        ORDER BY t.prompt_number ASC
      `,
    )
    .all(sessionDbId, beforeTurnId ?? Number.MAX_SAFE_INTEGER);
}

/**
 * Touch each orphan and enqueue its `turn-stop` in prompt_number order.
 * Callers pass a list captured earlier in the same transaction so the
 * selection is not perturbed by intervening writes (e.g. transcript backfill
 * filling assistant_response on the Stop path). Returns the count enqueued.
 */
export function enqueueOrphanTurnStops(
  db: Database,
  sessionDbId: number,
  nowEpoch: number,
  orphans: OrphanTurnRef[],
): number {
  for (const orphan of orphans) {
    db.query<unknown, [number, number]>(
      `
        UPDATE turns
        SET updated_at_epoch = ?
        WHERE id = ?
      `,
    ).run(nowEpoch, orphan.id);

    enqueueQueueItem(db, {
      kind: "turn-stop",
      targetId: orphan.id,
      sessionDbId,
      enqueuedAtEpoch: nowEpoch,
    });
  }
  return orphans.length;
}
