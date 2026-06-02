import type { Database } from "bun:sqlite";

import { enqueueQueueItem, queueItemExistsForTurn } from "./pending-queue";
import { getStrandedTurns, resetTurnExtractionFields } from "./turns";

/**
 * Scan the session for turns that should have been extracted but weren't
 * (`active` / `provisional` / legacy phantom `extracted`), reset each to a
 * fresh `active` state, and re-enqueue a `turn-stop` item in prompt_number
 * order. Idempotent: a turn that already has a queued `turn-stop` is skipped.
 * Returns the number of turns re-enqueued.
 */
export function recoverStrandedTurns(
  db: Database,
  sessionDbId: number,
  nowEpoch: number,
): number {
  const stranded = getStrandedTurns(db, sessionDbId); // prompt_number ASC
  let recovered = 0;
  for (const turn of stranded) {
    if (queueItemExistsForTurn(db, "turn-stop", turn.id)) {
      continue;
    }
    resetTurnExtractionFields(db, turn.id, nowEpoch);
    enqueueQueueItem(db, {
      kind: "turn-stop",
      targetId: turn.id,
      sessionDbId,
      enqueuedAtEpoch: nowEpoch,
    });
    recovered += 1;
  }
  return recovered;
}
