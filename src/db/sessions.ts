import type { Database } from "bun:sqlite";

import { indexSessionToFTS } from "./search";

export interface SessionRecord {
  id: number;
  contentSessionId: string;
  project: string;
  title: string | null;
  description: string | null;
  insight: string | null;
  startedAtEpoch: number;
  updatedAtEpoch: number | null;
  completedAtEpoch: number | null;
}

export interface UpsertSessionInput {
  contentSessionId: string;
  project: string;
  title: string | null;
  description: string | null;
  insight: string | null;
  startedAtEpoch: number;
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
    description,
    insight,
    started_at_epoch AS startedAtEpoch,
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
    .query<SessionRecord, [string, string, string | null, string | null, string | null, number, number | null, number | null]>(`
      INSERT INTO sessions (
        content_session_id,
        project,
        title,
        description,
        insight,
        started_at_epoch,
        updated_at_epoch,
        completed_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(content_session_id) DO UPDATE SET
        project = excluded.project,
        title = excluded.title,
        description = excluded.description,
        insight = excluded.insight,
        started_at_epoch = excluded.started_at_epoch,
        updated_at_epoch = excluded.updated_at_epoch,
        completed_at_epoch = excluded.completed_at_epoch
      RETURNING
        id,
        content_session_id AS contentSessionId,
        project,
        title,
        description,
        insight,
        started_at_epoch AS startedAtEpoch,
        updated_at_epoch AS updatedAtEpoch,
        completed_at_epoch AS completedAtEpoch
    `)
    .get(
      input.contentSessionId,
      input.project,
      input.title,
      input.description,
      input.insight,
      input.startedAtEpoch,
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
      `${SESSION_SELECT}${whereClause} ORDER BY started_at_epoch DESC LIMIT ?`,
    )
    .all(...params, limit);
}
