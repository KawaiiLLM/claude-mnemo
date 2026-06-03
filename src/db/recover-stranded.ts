import type { Database } from "bun:sqlite";

import { enqueueQueueItem, queueItemExistsForTurn } from "./pending-queue";
import { getSession } from "./sessions";
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

/**
 * Walk a session's parent chain and recover each ancestor's stranded tail. A
 * forked child reopening its lineage re-enqueues turn-stop work for any
 * stranded turns left behind in its ancestors (the child's own turns are
 * recovered separately). Cycle-guarded (a `visited` set) and depth-capped so a
 * corrupt `parent_session_id` self/loop never spins. Returns the total number
 * of ancestor turns re-enqueued.
 */
export function recoverStrandedAncestors(
  db: Database,
  childSessionId: number,
  nowEpoch: number,
  maxDepth = 16,
): number {
  let recovered = 0;
  const visited = new Set<number>([childSessionId]);
  let current = getSession(db, childSessionId)?.parentSessionId ?? null;
  let depth = 0;
  while (current != null && depth < maxDepth && !visited.has(current)) {
    visited.add(current);
    recovered += recoverStrandedTurns(db, current, nowEpoch);
    current = getSession(db, current)?.parentSessionId ?? null;
    depth += 1;
  }
  return recovered;
}
