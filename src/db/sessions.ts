import type { Database } from "bun:sqlite";

import { indexSessionToFTS } from "./search";

export interface SessionRecord {
  id: number;
  contentSessionId: string;
  project: string;
  title: string | null;
  content: string | null;
  insight: string | null;
  nextSteps: string | null;
  lastCompactTurn: number | null;
  lastAgentSessionId: string | null;
  createdAtEpoch: number;
  updatedAtEpoch: number | null;
  completedAtEpoch: number | null;
}

export interface UpsertSessionInput {
  contentSessionId: string;
  project: string;
  title: string | null;
  content?: string | null;
  insight: string | null;
  nextSteps?: string | null;
  lastCompactTurn?: number | null;
  createdAtEpoch: number;
  updatedAtEpoch: number | null;
  completedAtEpoch: number | null;
}

export interface GetRecentSessionsOptions {
  project?: string;
  limit?: number;
}

const SESSION_SELECT = `
  SELECT
    id,
    content_session_id AS contentSessionId,
    project,
    title,
    content,
    insight,
    next_steps AS nextSteps,
    last_compact_turn AS lastCompactTurn,
    last_agent_session_id AS lastAgentSessionId,
    created_at_epoch AS createdAtEpoch,
    updated_at_epoch AS updatedAtEpoch,
    completed_at_epoch AS completedAtEpoch
  FROM sessions
`;

export function upsertSession(
  db: Database,
  input: UpsertSessionInput,
): SessionRecord {
  const session =
  db
    .query<SessionRecord, [string, string, string | null, string | null, string | null, string | null, number | null, number, number | null, number | null]>(`
      INSERT INTO sessions (
        content_session_id,
        project,
        title,
        content,
        insight,
        next_steps,
        last_compact_turn,
        created_at_epoch,
        updated_at_epoch,
        completed_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(content_session_id) DO UPDATE SET
        project = excluded.project,
        title = COALESCE(excluded.title, sessions.title),
        content = COALESCE(excluded.content, sessions.content),
        insight = COALESCE(excluded.insight, sessions.insight),
        next_steps = COALESCE(excluded.next_steps, sessions.next_steps),
        last_compact_turn = COALESCE(excluded.last_compact_turn, sessions.last_compact_turn),
        created_at_epoch = excluded.created_at_epoch,
        updated_at_epoch = excluded.updated_at_epoch,
        completed_at_epoch = COALESCE(excluded.completed_at_epoch, sessions.completed_at_epoch)
      RETURNING
        id,
        content_session_id AS contentSessionId,
        project,
        title,
        content,
        insight,
        next_steps AS nextSteps,
        last_compact_turn AS lastCompactTurn,
        last_agent_session_id AS lastAgentSessionId,
        created_at_epoch AS createdAtEpoch,
        updated_at_epoch AS updatedAtEpoch,
        completed_at_epoch AS completedAtEpoch
    `)
    .get(
      input.contentSessionId,
      input.project,
      input.title,
      input.content ?? null,
      input.insight,
      input.nextSteps ?? null,
      input.lastCompactTurn ?? null,
      input.createdAtEpoch,
      input.updatedAtEpoch,
      input.completedAtEpoch,
    );

  if (!session) {
    throw new Error("Failed to upsert session.");
  }

  indexSessionToFTS(db, session);

  return session;
}

export function getSession(db: Database, id: number): SessionRecord | null {
  return (
    db
      .query<SessionRecord, [number]>(`${SESSION_SELECT} WHERE id = ?`)
      .get(id) ?? null
  );
}

export function getSessionByContentId(
  db: Database,
  contentSessionId: string,
): SessionRecord | null {
  return (
    db
      .query<SessionRecord, [string]>(
        `${SESSION_SELECT} WHERE content_session_id = ?`,
      )
      .get(contentSessionId) ?? null
  );
}

export function getRecentSessions(
  db: Database,
  options: GetRecentSessionsOptions = {},
): SessionRecord[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  if (options.project) {
    clauses.push("project = ?");
    params.push(options.project);
  }

  const whereClause =
    clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const limit = options.limit ?? 20;

  return db
    .query<SessionRecord, Array<string | number>>(
      `${SESSION_SELECT}${whereClause} ORDER BY created_at_epoch DESC LIMIT ?`,
    )
    .all(...params, limit);
}

export function updateCompactAnchor(db: Database, sessionId: number): void {
  db.query(
    `UPDATE sessions
     SET last_compact_turn = (
       SELECT MAX(prompt_number) FROM turns
       WHERE session_id = ?
         AND status != 'active'
     )
     WHERE id = ?`,
  ).run(sessionId, sessionId);
}

export function updateLastAgentSessionId(
  db: Database,
  sessionId: number,
  agentSessionId: string,
): void {
  db.query(
    `UPDATE sessions
     SET last_agent_session_id = ?
     WHERE id = ?`,
  ).run(agentSessionId, sessionId);
}
