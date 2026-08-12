import type { Database } from "bun:sqlite";

import { settleCompletedTurn } from "./turn-completion";

/**
 * The turn-completion channel's own entry point (spec D10, ticket 02).
 *
 * `settleCompletedTurn` (db/turn-completion.ts) is the sole writer of a turn's
 * terminal status, `files_read`/`files_modified`/`tool_call_count`, and its
 * observations' retirement — but until now nothing called it except the
 * note-debt ledger's classification walk, which meant the rationale for
 * "which turn to settle" lived inside a note-taking concept that has nothing
 * to do with settlement. This module is the writer's own home: three sites —
 * the Stop hook, the PostToolUse catch-up sweep, and the worker's queue drain
 * — call it directly, before they touch the note-debt ledger at all.
 *
 * NO CURSOR. The old classification walk advanced a watermark
 * (`note_debt_cursor`) so it never re-scanned a decided prefix; that cursor is
 * about to be cut loose by the note-debt redesign (ticket 03), so settlement
 * cannot depend on it. Instead the candidate set is SELF-IDENTIFYING: a turn
 * is a candidate exactly while it is still `active`/`provisional`, and
 * `settleCompletedTurn` moves every turn it touches OUT of that pair of
 * statuses. The predicate below is therefore naturally bounded by whatever is
 * still outstanding, not by the size of the session's history — no full scan,
 * no watermark to carry forward.
 */

/**
 * Two independent proofs that a turn is over, either sufficient (spec D10's
 * "prompt 时钟口径" — the prompt hook is the clock):
 *
 *   - PROMPT CLOCK: a strictly later `prompt_number` already exists in the
 *     same session. The next prompt beginning IS this turn ending, regardless
 *     of whether Stop capture ever ran for it.
 *   - CAPTURE: a `turn-stop` item is queued for this turn — what the Stop
 *     hook, and the stranded repair (worker/turn-liveness.ts), leave behind
 *     for a turn that has no later prompt yet (typically the session's
 *     newest turn, right when its own Stop fires).
 *
 * A turn matching neither is STRANDED: no Stop was ever captured, and no
 * later prompt has arrived either. It is left exactly alone here, for
 * worker/turn-liveness.ts to repair — settling it would freeze a guess (zero
 * observations read as "trivial") that a late-arriving tool call could later
 * prove wrong.
 */
const SETTLEMENT_CANDIDATE_SQL = `
  SELECT t.id AS id
  FROM turns t
  WHERE t.session_id = ?
    AND t.status IN ('active', 'provisional')
    AND (
      EXISTS (
        SELECT 1 FROM turns later
        WHERE later.session_id = t.session_id
          AND later.prompt_number > t.prompt_number
      )
      OR EXISTS (
        SELECT 1 FROM pending_queue q
        WHERE q.kind = 'turn-stop' AND q.target_id = t.id
      )
    )
  ORDER BY t.prompt_number ASC
`;

/**
 * The turns in one session that are settleable right now — a plain read, so
 * the predicate itself is directly testable without exercising the write.
 */
export function listSettlementCandidateTurnIds(
  db: Database,
  sessionId: number,
): number[] {
  return db
    .query<{ id: number }, [number]>(SETTLEMENT_CANDIDATE_SQL)
    .all(sessionId)
    .map((row) => row.id);
}

/**
 * Settle every currently-determinable turn in a session.
 *
 * Called by all three sites that used to reach `settleCompletedTurn`
 * indirectly through the note-debt ledger's classification walk (the Stop
 * hook, the PostToolUse catch-up sweep, and the worker's `turn-stop` queue
 * retirement) — always BEFORE those sites touch the ledger, so the ledger's
 * own completion-evidence check (which still lives in db/note-debt.ts, unless
 * and until ticket 03 removes it) reads the same turn state it always did.
 *
 * Returns the ids this call actually settled, for callers and tests that want
 * to observe the effect without re-querying turn status.
 */
export function settleOutstandingTurns(
  db: Database,
  sessionId: number,
  eraCutoffEpoch: number | null,
  nowEpoch: number,
): number[] {
  const settled: number[] = [];
  for (const turnId of listSettlementCandidateTurnIds(db, sessionId)) {
    if (settleCompletedTurn(db, turnId, eraCutoffEpoch, nowEpoch)) {
      settled.push(turnId);
    }
  }
  return settled;
}
