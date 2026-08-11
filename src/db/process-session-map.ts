import type { Database } from "bun:sqlite";

/**
 * Process-session → mnemo-session identity map (spec D1).
 *
 * `CLAUDE_CODE_SESSION_ID` (the process env var an MCP or hook process can
 * read directly) is NOT the id mnemo keys a session on — that is the hook
 * payload's `session_id`, stable across resume/compact while the process id
 * mints a fresh value each time. This table is the only place the two are
 * joined, so the MCP entry point can resolve "which mnemo session is this
 * process's caller" without guessing from the process id directly.
 */

/**
 * Record (or refresh) which mnemo session a process session currently belongs
 * to. Called once per UserPromptSubmit — resume/compact change the process id
 * mid-session, so a single write at session start would go stale the moment
 * either happens.
 */
export function upsertProcessSessionMap(
  db: Database,
  processSessionId: string,
  sessionId: number,
  nowEpoch: number,
): void {
  db.query<unknown, [string, number, number]>(
    `INSERT INTO process_session_map (
       process_session_id, session_id, updated_at_epoch
     ) VALUES (?, ?, ?)
     ON CONFLICT(process_session_id) DO UPDATE SET
       session_id = excluded.session_id,
       updated_at_epoch = excluded.updated_at_epoch`,
  ).run(processSessionId, sessionId, nowEpoch);
}

/**
 * The mnemo session a process session was last mapped to, or null if this
 * process id has never been recorded (never lived through a UserPromptSubmit
 * yet, or was recorded before this table existed). A miss is not evidence of
 * anything — every reader of this function treats it as "identity unknown"
 * and falls through to whatever admits on unknown identity.
 */
export function getMnemoSessionIdForProcessSession(
  db: Database,
  processSessionId: string,
): number | null {
  return (
    db
      .query<{ sessionId: number }, [string]>(
        `SELECT session_id AS sessionId FROM process_session_map
         WHERE process_session_id = ?`,
      )
      .get(processSessionId)?.sessionId ?? null
  );
}
