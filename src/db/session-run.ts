import type { Database } from "bun:sqlite";

/** Record the durable turn boundary for one Claude Code run. */
export function markSessionRunStart(db: Database, sessionDbId: number): void {
  db.query<unknown, [number, number]>(
    `INSERT INTO session_run_state (session_db_id, start_turn_id)
     VALUES (
       ?,
       COALESCE((SELECT MAX(id) FROM turns WHERE session_id = ?), 0)
     )
     ON CONFLICT(session_db_id) DO UPDATE SET
       start_turn_id = excluded.start_turn_id`,
  ).run(sessionDbId, sessionDbId);
}

/** One SQL judgment: did this run create any turn after its start boundary? */
export function hasNewTurnSinceSessionRunStart(
  db: Database,
  sessionDbId: number,
): boolean {
  return (
    db
      .query<{ hasNewTurn: number }, [number]>(
        `SELECT EXISTS(
           SELECT 1
           FROM session_run_state r
           JOIN turns t
             ON t.session_id = r.session_db_id
            AND t.id > r.start_turn_id
           WHERE r.session_db_id = ?
         ) AS hasNewTurn`,
      )
      .get(sessionDbId)?.hasNewTurn === 1
  );
}
