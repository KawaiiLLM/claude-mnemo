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
  decision: string | null;
  done: string | null;
  current: string | null;
  reference: string | null;
  lastCompactTurn: number | null;
  lastAgentSessionId: string | null;
  summaryUpdatedAtEpoch: number | null;
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
  summaryUpdatedAtEpoch?: number | null;
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
    decision,
    done,
    "current" AS current,
    "reference" AS reference,
    last_compact_turn AS lastCompactTurn,
    last_agent_session_id AS lastAgentSessionId,
    summary_updated_at_epoch AS summaryUpdatedAtEpoch,
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
    .query<SessionRecord, [string, string, string | null, string | null, string | null, string | null, number | null, number | null, number, number | null, number | null]>(`
      INSERT INTO sessions (
        content_session_id,
        project,
        title,
        content,
        insight,
        next_steps,
        last_compact_turn,
        summary_updated_at_epoch,
        created_at_epoch,
        updated_at_epoch,
        completed_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(content_session_id) DO UPDATE SET
        project = excluded.project,
        title = COALESCE(excluded.title, sessions.title),
        content = COALESCE(excluded.content, sessions.content),
        insight = COALESCE(excluded.insight, sessions.insight),
        next_steps = COALESCE(excluded.next_steps, sessions.next_steps),
        last_compact_turn = COALESCE(excluded.last_compact_turn, sessions.last_compact_turn),
        summary_updated_at_epoch = COALESCE(excluded.summary_updated_at_epoch, sessions.summary_updated_at_epoch),
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
        decision,
        done,
        "current" AS current,
        "reference" AS reference,
        last_compact_turn AS lastCompactTurn,
        last_agent_session_id AS lastAgentSessionId,
        summary_updated_at_epoch AS summaryUpdatedAtEpoch,
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
      input.summaryUpdatedAtEpoch ?? null,
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

export interface SessionSummaryRewrite {
  title: string;
  content: string;
  decision: string;
  done: string;
  current: string;
  nextSteps: string;
  reference: string;
}

// D2: the dedicated session-summary write path. Unlike upsertSession (which
// COALESCE-preserves omitted fields for the non-summary callers), this rewrites
// all seven summary fields whole — no merge, no preservation. The caller has
// already enforced that every field is present (all-or-nothing). The epoch is
// advanced UNCONDITIONALLY so a stale-forced refresh clears the staleness
// reminder even when the agent echoes byte-identical fields (D5). Empty strings
// are written as NULL so read-side fallback (decision empty → legacy insight)
// works uniformly for new and old sessions. The legacy `insight` column is
// cleared on every rewrite (D3): once a session is on the new model the
// deprecated insight must not resurface through the decision-empty fallback.
export function updateSessionSummaryRewrite(
  db: Database,
  sessionId: number,
  fields: SessionSummaryRewrite,
  nowEpoch: number,
): SessionRecord | null {
  const toNull = (value: string): string | null =>
    value.trim() === "" ? null : value;

  const session = db
    .query<SessionRecord, [
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
      number,
      number,
      number,
    ]>(`
      UPDATE sessions SET
        title = ?,
        content = ?,
        decision = ?,
        done = ?,
        "current" = ?,
        next_steps = ?,
        "reference" = ?,
        insight = NULL,
        summary_updated_at_epoch = ?,
        updated_at_epoch = ?
      WHERE id = ?
      RETURNING
        id,
        content_session_id AS contentSessionId,
        project,
        title,
        content,
        insight,
        next_steps AS nextSteps,
        decision,
        done,
        "current" AS current,
        "reference" AS reference,
        last_compact_turn AS lastCompactTurn,
        last_agent_session_id AS lastAgentSessionId,
        summary_updated_at_epoch AS summaryUpdatedAtEpoch,
        created_at_epoch AS createdAtEpoch,
        updated_at_epoch AS updatedAtEpoch,
        completed_at_epoch AS completedAtEpoch
    `)
    .get(
      toNull(fields.title),
      toNull(fields.content),
      toNull(fields.decision),
      toNull(fields.done),
      toNull(fields.current),
      toNull(fields.nextSteps),
      toNull(fields.reference),
      nowEpoch,
      nowEpoch,
      sessionId,
    );

  if (!session) {
    return null;
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
         AND status NOT IN ('active', 'provisional')
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
