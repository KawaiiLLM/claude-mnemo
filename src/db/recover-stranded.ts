import type { Database } from "bun:sqlite";

import { isSegmentEra } from "../segment-era";
import { enqueueQueueItem, queueItemExistsForTurn } from "./pending-queue";
import { getSession } from "./sessions";
import { getStrandedTurns, resetTurnExtractionFields } from "./turns";

/**
 * Scan the session for turns that should have been extracted but weren't
 * (`active` / `provisional` / legacy phantom `extracted`), reset each to a
 * fresh `active` state, and re-enqueue a `turn-stop` item in prompt_number
 * order. Idempotent: a turn that already has a queued `turn-stop` is skipped.
 * Returns the number of turns re-enqueued.
 *
 * `eraCutoffEpoch` is passed in rather than read from config here (a db module
 * has no business loading one) and defaults to `null`, which is "every turn is
 * legacy" — the behaviour from before the cutover.
 */
export function recoverStrandedTurns(
  db: Database,
  sessionDbId: number,
  nowEpoch: number,
  eraCutoffEpoch: number | null = null,
): number {
  const stranded = getStrandedTurns(db, sessionDbId); // prompt_number ASC
  let recovered = 0;
  for (const turn of stranded) {
    if (queueItemExistsForTurn(db, "turn-stop", turn.id)) {
      continue;
    }
    // An era turn's title/content is the main agent's own note (turns.ts
    // promoteTurnFromNote), not an extraction this recovery may redo. Wiping it
    // would destroy the official record while the shadow row and the debt
    // ledger still read "noted", and the re-queued writeback would then settle
    // an emptied row as `skipped`. Re-enqueue only: the turn-stop still reaches
    // the extraction agent, whose era writeback settles the row's status
    // without touching what the note put there (mcp/remember.ts).
    if (!isSegmentEra(turn.createdAtEpoch, eraCutoffEpoch)) {
      resetTurnExtractionFields(db, turn.id, nowEpoch);
    }
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
  eraCutoffEpoch: number | null = null,
  maxDepth = 16,
): number {
  let recovered = 0;
  const visited = new Set<number>([childSessionId]);
  let current = getSession(db, childSessionId)?.parentSessionId ?? null;
  let depth = 0;
  while (current != null && depth < maxDepth && !visited.has(current)) {
    visited.add(current);
    recovered += recoverStrandedTurns(db, current, nowEpoch, eraCutoffEpoch);
    current = getSession(db, current)?.parentSessionId ?? null;
    depth += 1;
  }
  return recovered;
}
