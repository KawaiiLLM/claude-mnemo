import type { Database } from "bun:sqlite";

import { enqueueQueueItem } from "./pending-queue";
import { aggregateTurnFiles, hasActualResponse } from "./turn-completion";
import { updateTurnById } from "./turns";

export interface OrphanTurnRef {
  id: number;
  promptNumber: number;
}

/**
 * Turns whose extraction was never triggered: still non-terminal, no
 * assistant_response (interrupted before the Stop hook could fire), and no
 * pending `turn-stop` item. Distinct from the stranded class
 * (recover-stranded.ts), which requires a non-null assistant_response.
 * `beforeTurnId` excludes the turn currently being stopped (Stop-hook path);
 * omit it to scan the whole session (SessionEnd path).
 *
 * `provisional` counts as non-terminal here, exactly as it does in the skip
 * path below and in every other stranded selector. A turn the main agent noted
 * mid-turn sits `provisional` until its own end carries it further; if the
 * session dies before Stop captures a response, an `active`-only selector never
 * sees it again and the note stays out of search forever (db/search.ts renders
 * `extracted` only).
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
          AND t.status IN ('active', 'provisional')
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

/**
 * Finalize orphans that can no longer receive content without attempting
 * extraction. Callers own the surrounding transaction.
 */
export function skipOrphanTurns(
  db: Database,
  sessionDbId: number,
  nowEpoch: number,
  orphans: OrphanTurnRef[],
): number {
  let processedCount = 0;
  for (const orphan of orphans) {
    const turn = db
      .query<
        { title: string | null; content: string | null; assistantResponse: string | null },
        [number, number]
      >(
        `SELECT title, content, assistant_response AS assistantResponse
         FROM turns WHERE id = ? AND session_id = ?`,
      )
      .get(orphan.id, sessionDbId);
    if (!turn) {
      continue;
    }

    // Same fork as `db/turn-completion.ts`'s `completionFloorStatus` (issue
    // 01), minus its era/`failed` branch — an orphan is always fresh, never a
    // pre-era backlog item, so this stays a plain title/content/response OR
    // rather than threading an `eraCutoffEpoch` this call site has no use for.
    // In practice every orphan reaching here has a NULL response by
    // construction (`getOrphanTurns`' own selector requires it), so the
    // response branch is a parity guarantee against a future caller, not a
    // path production data exercises today.
    const status =
      turn.title !== null ||
      turn.content !== null ||
      hasActualResponse(turn.assistantResponse)
        ? "extracted"
        : "skipped";
    const result = db.query<unknown, [string, number, number]>(
      `
        UPDATE turns
        SET status = ?, updated_at_epoch = ?
        WHERE id = ? AND status IN ('active', 'provisional')
      `,
    ).run(status, nowEpoch, orphan.id);
    if (result.changes === 0) {
      continue;
    }

    // The same mechanical aggregation the completion settlement does. An orphan
    // skips extraction, not bookkeeping: `files_read` / `files_modified` /
    // `tool_call_count` have exactly one writer left (db/turn-completion.ts),
    // and a turn that reaches its terminal status down this path would keep
    // them empty forever — invisible to `file:` recall and underweighted by
    // segment ranking, for work it demonstrably did.
    updateTurnById(db, orphan.id, aggregateTurnFiles(db, orphan.id));

    db.query<unknown, [number]>(
      `UPDATE observations SET status = 'skipped'
       WHERE turn_id = ? AND status = 'pending'`,
    ).run(orphan.id);
    db.query<unknown, [number]>(
      `DELETE FROM pending_queue
       WHERE kind = 'obs' AND target_id IN (
         SELECT id FROM observations WHERE turn_id = ?
       )`,
    ).run(orphan.id);
    processedCount += result.changes;
  }
  return processedCount;
}
