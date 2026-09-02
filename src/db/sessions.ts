import type { Database } from "bun:sqlite";

import { parseQualifiedReferences, validateReferences } from "./references";
import { indexSessionToFTS } from "./search";

// The 4-state lineage resolution status. Only `resolved`/`root` are terminal;
// `unchecked` (default) and `unresolved` are retried on later relink calls.
export type LineageStatus = "unchecked" | "resolved" | "root" | "unresolved";

export interface SessionRecord {
  id: number;
  contentSessionId: string;
  project: string;
  /**
   * The transcript JSONL this session actually writes to, captured from the
   * hook input at registration and never overwritten (`project` drifts to the
   * latest cwd; the transcript directory does not). NULL on rows that predate
   * the column or whose one-time repair found no file — readers fall back to
   * deriving the path from `project`.
   */
  transcriptPath: string | null;
  title: string | null;
  content: string | null;
  insight: string | null;
  nextSteps: string | null;
  decision: string | null;
  done: string | null;
  current: string | null;
  reference: string | null;
  lastCompactTurn: number | null;
  summaryUpdatedAtEpoch: number | null;
  /** Byte offset of the first not-yet-scanned transcript byte (spec §F). */
  scanCursorByteOffset: number;
  /** 1-based number of the last fully committed transcript line scanned. */
  scanCursorLine: number;
  parentSessionId: number | null;
  lineageStatus: string;
  /** Ticket 13 (anchor revised 0.12.1; verb scope narrowed to field-writing calls only by ticket 09): the session's MAX turn row id at its last successful field-writing `remember` call (`create`/`append`/`replace` — not `attach`/`close`/`assign`; 0 = called before any turn) — `null` if never. See touchSessionRememberActivity. */
  lastRememberTurnId: number | null;
  createdAtEpoch: number;
  updatedAtEpoch: number | null;
  completedAtEpoch: number | null;
}

export interface UpsertSessionInput {
  contentSessionId: string;
  project: string;
  /** First-non-NULL: written when absent, never overwritten once set. */
  transcriptPath?: string | null;
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
    transcript_path AS transcriptPath,
    title,
    content,
    insight,
    next_steps AS nextSteps,
    decision,
    done,
    "current" AS current,
    "reference" AS reference,
    last_compact_turn AS lastCompactTurn,
    summary_updated_at_epoch AS summaryUpdatedAtEpoch,
    scan_cursor_byte_offset AS scanCursorByteOffset,
    scan_cursor_line AS scanCursorLine,
    parent_session_id AS parentSessionId,
    lineage_status AS lineageStatus,
    last_remember_turn_id AS lastRememberTurnId,
    created_at_epoch AS createdAtEpoch,
    updated_at_epoch AS updatedAtEpoch,
    completed_at_epoch AS completedAtEpoch
  FROM sessions
`;

const SESSION_UPSERT_RETURNING = `
  RETURNING
    id,
    content_session_id AS contentSessionId,
    project,
    transcript_path AS transcriptPath,
    title,
    content,
    insight,
    next_steps AS nextSteps,
    decision,
    done,
    "current" AS current,
    "reference" AS reference,
    last_compact_turn AS lastCompactTurn,
        summary_updated_at_epoch AS summaryUpdatedAtEpoch,
    scan_cursor_byte_offset AS scanCursorByteOffset,
    scan_cursor_line AS scanCursorLine,
    parent_session_id AS parentSessionId,
    lineage_status AS lineageStatus,
    last_remember_turn_id AS lastRememberTurnId,
    created_at_epoch AS createdAtEpoch,
    updated_at_epoch AS updatedAtEpoch,
    completed_at_epoch AS completedAtEpoch
`;

/**
 * UPDATE-first, insert-only-when-missing (ticket 01, session-id-burn). The
 * prior shape was a single `INSERT ... ON CONFLICT DO UPDATE`, which SQLite
 * implements by allocating a fresh AUTOINCREMENT id for the attempted insert
 * BEFORE the conflict is detected and the DO UPDATE branch runs — so every
 * touch of an already-registered session (the overwhelming majority of calls;
 * a session is created once and touched many times) burned one never-reused
 * `sqlite_sequence` number. Session ids render into every `[S<n>/T<m>]`
 * citation address, so the burn is a compounding token cost (production: 221
 * rows, sequence 23484 — ~105x). UPDATE never touches AUTOINCREMENT, so
 * repeated touches of an existing row now cost nothing; a genuinely new
 * session still takes the INSERT path and advances the sequence by exactly
 * one, same as before. The INSERT keeps its `ON CONFLICT` clause as a pure
 * race guard for the gap between "UPDATE found no row" and "INSERT runs" —
 * under concurrent callers on the same content_session_id, the loser's
 * UPDATE returns null, its INSERT then conflicts with the winner's newly
 * committed row, and the ON CONFLICT DO UPDATE (identical merge semantics)
 * makes it converge on the same result instead of throwing. The whole
 * read-modify-write is one transaction (nested safely via bun:sqlite
 * SAVEPOINT support when the caller already holds one) so no writer can
 * observe or act on the gap between the UPDATE miss and the INSERT.
 */
export function upsertSession(
  db: Database,
  input: UpsertSessionInput,
): SessionRecord {
  const runUpsert = db.transaction(() => {
    const updated = db
      .query<SessionRecord, [
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        number | null,
        number | null,
        number,
        number | null,
        number | null,
        string,
      ]>(`
        UPDATE sessions SET
          project = ?,
          -- First-non-NULL, and deliberately the reverse of project's
          -- last-writer-wins: the transcript directory is fixed at the
          -- session's STARTING cwd, so a later upsert from a different cwd
          -- must not move it.
          transcript_path = COALESCE(transcript_path, ?),
          title = COALESCE(?, title),
          content = COALESCE(?, content),
          insight = COALESCE(?, insight),
          next_steps = COALESCE(?, next_steps),
          last_compact_turn = COALESCE(?, last_compact_turn),
          summary_updated_at_epoch = COALESCE(?, summary_updated_at_epoch),
          created_at_epoch = ?,
          updated_at_epoch = ?,
          completed_at_epoch = COALESCE(?, completed_at_epoch)
        WHERE content_session_id = ?
        ${SESSION_UPSERT_RETURNING}
      `)
      .get(
        input.project,
        input.transcriptPath ?? null,
        input.title,
        input.content ?? null,
        input.insight,
        input.nextSteps ?? null,
        input.lastCompactTurn ?? null,
        input.summaryUpdatedAtEpoch ?? null,
        input.createdAtEpoch,
        input.updatedAtEpoch,
        input.completedAtEpoch,
        input.contentSessionId,
      );

    if (updated) {
      return updated;
    }

    return db
      .query<SessionRecord, [string, string, string | null, string | null, string | null, string | null, string | null, number | null, number | null, number, number | null, number | null]>(`
        INSERT INTO sessions (
          content_session_id,
          project,
          transcript_path,
          title,
          content,
          insight,
          next_steps,
          last_compact_turn,
          summary_updated_at_epoch,
          created_at_epoch,
          updated_at_epoch,
          completed_at_epoch
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(content_session_id) DO UPDATE SET
          project = excluded.project,
          transcript_path = COALESCE(sessions.transcript_path, excluded.transcript_path),
          title = COALESCE(excluded.title, sessions.title),
          content = COALESCE(excluded.content, sessions.content),
          insight = COALESCE(excluded.insight, sessions.insight),
          next_steps = COALESCE(excluded.next_steps, sessions.next_steps),
          last_compact_turn = COALESCE(excluded.last_compact_turn, sessions.last_compact_turn),
          summary_updated_at_epoch = COALESCE(excluded.summary_updated_at_epoch, sessions.summary_updated_at_epoch),
          created_at_epoch = excluded.created_at_epoch,
          updated_at_epoch = excluded.updated_at_epoch,
          completed_at_epoch = COALESCE(excluded.completed_at_epoch, sessions.completed_at_epoch)
        ${SESSION_UPSERT_RETURNING}
      `)
      .get(
        input.contentSessionId,
        input.project,
        input.transcriptPath ?? null,
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
  });

  const session = runUpsert.immediate();

  if (!session) {
    throw new Error("Failed to upsert session.");
  }

  indexSessionToFTS(db, session);

  return session;
}

export interface SessionSummaryRewrite {
  title: string;
  content: string;
  insight: string;
  decision: string;
  done: string;
  nextSteps: string;
  reference: string;
}

// D2: the dedicated session-summary write path. Unlike upsertSession (which
// COALESCE-preserves omitted fields for the non-summary callers), this rewrites
// all seven summary fields whole — no merge, no preservation. The caller has
// already enforced that every field is present (all-or-nothing). The epoch is
// advanced UNCONDITIONALLY so a stale-forced refresh clears the staleness
// reminder even when the agent echoes byte-identical fields (D5). Empty strings
// are written as NULL, the empty state every reader already understands.
//
// ticket 04 (spec D2): the seven are title/content/insight and
// next_steps/decision/done/reference. `current` is deleted — this path no
// longer writes the column at all (it survives as dead storage; retiring it
// physically is a separate decision), and `insight` is a first-class field
// rather than a legacy value to clear.
//
// No production caller: ticket 03's per-field `updateSessionFields` replaced
// it everywhere. Kept because the tests that pin the citation rescan address
// it directly; a deletion is a separate, larger call than this ticket.
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
        insight = ?,
        decision = ?,
        done = ?,
        next_steps = ?,
        "reference" = ?,
        summary_updated_at_epoch = ?,
        updated_at_epoch = ?
      WHERE id = ?
      RETURNING
        id,
        content_session_id AS contentSessionId,
        project,
        transcript_path AS transcriptPath,
        title,
        content,
        insight,
        next_steps AS nextSteps,
        decision,
        done,
        "current" AS current,
        "reference" AS reference,
        last_compact_turn AS lastCompactTurn,
            summary_updated_at_epoch AS summaryUpdatedAtEpoch,
        scan_cursor_byte_offset AS scanCursorByteOffset,
        scan_cursor_line AS scanCursorLine,
        parent_session_id AS parentSessionId,
        lineage_status AS lineageStatus,
        last_remember_turn_id AS lastRememberTurnId,
        created_at_epoch AS createdAtEpoch,
        updated_at_epoch AS updatedAtEpoch,
        completed_at_epoch AS completedAtEpoch
    `)
    .get(
      toNull(fields.title),
      toNull(fields.content),
      toNull(fields.insight),
      toNull(fields.decision),
      toNull(fields.done),
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

  // The session-field CITATION RESCAN is DELETED (main-agent-edges D1 / R10-2).
  // It kept one wordless `session -> turn|segment` row per address the seven
  // summary fields happened to name — part of production's 1,883-row wordless
  // population, and a fact nothing acts on: an edge is a class, and a session
  // asserts no class about anything. No replacement table (D1: reproducing the
  // kindful endpoint space for a fact nobody reads is the cost that ruled it
  // out). The addresses stay in the prose, where a reader reads them.

  return session;
}

export interface UpdateSessionFieldsInput {
  /** `undefined` = leave alone; `null` = clear; a string = the new value. */
  title?: string | null;
  content?: string | null;
  insight?: string | null;
  decision?: string | null;
  done?: string | null;
  nextSteps?: string | null;
  reference?: string | null;
}

/**
 * The per-field session write (spec D5/D6, ticket 03): unlike
 * `updateSessionSummaryRewrite` (which requires all seven fields and rewrites
 * the row whole), this takes the same omit-leaves-alone / explicit-null-clears
 * shape `resolveNullable` already gives turns — a caller corrects one field
 * without restating the other six.
 *
 * ticket 04 (spec D2): `insight` is one of the seven now — a compressed global
 * view for another session browsing this one — so it is written like any other
 * field instead of being cleared on every call. The clearing existed to stop a
 * stale legacy value resurfacing through the decision-empty read fallback; the
 * renderers no longer have that fallback (they render `insight` in its own
 * right), so the reason is gone with it. `current` is deleted and is no longer
 * written at all; the column survives as dead storage, and retiring it
 * physically is a separate decision.
 *
 * The epoch advances unconditionally on every successful call (D5: even a
 * byte-identical rewrite must clear the staleness reminder), and the full
 * citation rescan runs over the row's POST-write values regardless of which
 * fields this call touched — same reasoning as `updateSessionSummaryRewrite`.
 */
export function updateSessionFields(
  db: Database,
  sessionId: number,
  input: UpdateSessionFieldsInput,
  nowEpoch: number,
): SessionRecord | null {
  const existing = getSession(db, sessionId);
  if (!existing) {
    return null;
  }

  const resolve = (
    value: string | null | undefined,
    current: string | null,
  ): string | null => {
    if (value === undefined) {
      return current;
    }
    if (value === null) {
      return null;
    }
    return value.trim() === "" ? null : value;
  };

  const title = resolve(input.title, existing.title);
  const content = resolve(input.content, existing.content);
  const insight = resolve(input.insight, existing.insight);
  const decision = resolve(input.decision, existing.decision);
  const done = resolve(input.done, existing.done);
  const nextSteps = resolve(input.nextSteps, existing.nextSteps);
  const reference = resolve(input.reference, existing.reference);

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
        insight = ?,
        decision = ?,
        done = ?,
        next_steps = ?,
        "reference" = ?,
        summary_updated_at_epoch = ?,
        updated_at_epoch = ?
      WHERE id = ?
      RETURNING
        id,
        content_session_id AS contentSessionId,
        project,
        transcript_path AS transcriptPath,
        title,
        content,
        insight,
        next_steps AS nextSteps,
        decision,
        done,
        "current" AS current,
        "reference" AS reference,
        last_compact_turn AS lastCompactTurn,
            summary_updated_at_epoch AS summaryUpdatedAtEpoch,
        scan_cursor_byte_offset AS scanCursorByteOffset,
        scan_cursor_line AS scanCursorLine,
        parent_session_id AS parentSessionId,
        lineage_status AS lineageStatus,
        last_remember_turn_id AS lastRememberTurnId,
        created_at_epoch AS createdAtEpoch,
        updated_at_epoch AS updatedAtEpoch,
        completed_at_epoch AS completedAtEpoch
    `)
    .get(
      title,
      content,
      insight,
      decision,
      done,
      nextSteps,
      reference,
      nowEpoch,
      nowEpoch,
      sessionId,
    );

  if (!session) {
    return null;
  }

  indexSessionToFTS(db, session);

  // Deleted with its twin in `updateSessionSummaryRewrite` above
  // (main-agent-edges D1 / R10-2): the wordless rows this rescan maintained
  // are retired as a population.

  return session;
}

/**
 * How many of this session's turns started after `sinceEpoch` — the cadence
 * figure the `note` receipt reports (spec D8/D10), computed from the summary
 * timestamp the row already carries rather than from new instrumentation.
 *
 * `null` means no summary has ever been written, and then every turn counts:
 * "nothing has been summarised yet, and this much has happened" is the same
 * measurement with a different starting point, not a missing value.
 *
 * `undone` rows are excluded — a retracted turn is not a turn that passed.
 * Note the boundary is strict (`>`): a turn that was already open when the
 * last summary landed is not counted again by the next write.
 */
export function countTurnsSince(
  db: Database,
  sessionId: number,
  sinceEpoch: number | null,
): number {
  return (
    db
      .query<{ count: number }, [number, number]>(
        `SELECT COUNT(*) AS count FROM turns
         WHERE session_id = ?
           AND status != 'undone'
           AND created_at_epoch > ?`,
      )
      .get(sessionId, sinceEpoch ?? -1)?.count ?? 0
  );
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

/**
 * Stop's own end-of-turn stamp (ticket 03, read-write-contract spec "受管写者
 * 含 hook"). Touches ONLY its own two columns — never title/content/insight/
 * next_steps, which a settlement write may already have moved past whatever
 * `stop.ts` read at hook entry.
 *
 * The prior call site here used `upsertSession`, which re-wrote every summary
 * field from that stale, hook-entry snapshot: its `COALESCE(excluded.content,
 * sessions.content)` prefers the PASSED-IN value whenever it is non-null, so
 * a same-window settlement write landing between the hook's session read and
 * this write's own commit would be silently stomped back to the old value —
 * "开场读、收尾整行 upsert" is exactly this TOCTOU. A function with no columns
 * to stomp cannot repeat the mistake.
 */
export function touchSessionCompletion(
  db: Database,
  sessionId: number,
  updatedAtEpoch: number,
  completedAtEpoch: number,
): void {
  db.query<unknown, [number, number, number]>(
    `UPDATE sessions SET updated_at_epoch = ?, completed_at_epoch = ? WHERE id = ?`,
  ).run(updatedAtEpoch, completedAtEpoch, sessionId);
}

/**
 * `remember`'s own end-of-call stamp (ticket 13, spec "节奏与建段指导"; verb
 * scope narrowed by ticket 09): the ONE column this touches, same "dedicated
 * setter, never the general upsert" shape `touchSessionCompletion` above
 * already uses for `updated_at_epoch`/`completed_at_epoch` — a session-arc
 * field a routine SessionStart/UserPromptSubmit upsert must never stomp back
 * to an earlier value. `mcp/remember.ts` calls this once per successful
 * FIELD-WRITING verb only (`create`/`append`/`replace` — `attach`/`close`/
 * `assign` move or toggle a segment without touching a field, so they leave
 * the clock alone) — a parameter-error call never reaches here either, so a
 * rejected attempt does not reset the clock.
 */
export function touchSessionRememberActivity(
  db: Database,
  sessionId: number,
): void {
  // The anchor is a turn ROW ID, not an epoch: ids order turns against this
  // call exactly, where second-granularity timestamps cannot (a turn created
  // in the same second as the call must still count as "after" it if its row
  // is newer — and must not if it is older). COALESCE(…, 0): a call before
  // any turn exists anchors at 0, so every future turn counts.
  db.query<unknown, [number, number]>(
    `UPDATE sessions
     SET last_remember_turn_id = COALESCE(
       (SELECT MAX(id) FROM turns WHERE session_id = ?1), 0)
     WHERE id = ?2`,
  ).run(sessionId, sessionId);
}

/**
 * Turns of `sessionId` whose row id is strictly greater than `anchorTurnId`
 * — the remember-reminder's own counter (`anchorTurnId` = the stamped
 * `lastRememberTurnId`, or 0 for a session that never called `remember`,
 * which counts every turn). Row-id order is the one ordering that cannot
 * tie: `countTurnsSince`'s epoch comparison stays for the segment
 * maintenance counters, whose anchors are genuinely epochs.
 */
export function countTurnsAfterTurnId(
  db: Database,
  sessionId: number,
  anchorTurnId: number,
): number {
  return (
    db
      .query<{ count: number }, [number, number]>(
        `SELECT COUNT(*) AS count FROM turns
         WHERE session_id = ?
           AND status != 'undone'
           AND id > ?`,
      )
      .get(sessionId, anchorTurnId)?.count ?? 0
  );
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

function compareAndSetScanCursor(
  db: Database,
  sessionId: number,
  byteOffset: number,
  lineNumber: number,
  observedByteOffset: number,
): boolean {
  const result = db
    .query<unknown, [number, number, number, number]>(
      `UPDATE sessions
       SET scan_cursor_byte_offset = ?,
           scan_cursor_line = ?
       WHERE id = ?
         AND scan_cursor_byte_offset = ?`,
    )
    .run(byteOffset, lineNumber, sessionId, observedByteOffset);

  return result.changes > 0;
}

/**
 * Advance the persisted transcript scan cursor (spec §F) by compare-and-set on
 * the offset this scan actually observed.
 *
 * UserPromptSubmit and SessionEnd can scan concurrently. Without the CAS the
 * loser commits its older result last and the high-water mark regresses, which
 * re-reads the same region on every future event (claiming stays correct — it is
 * UUID-idempotent — but the bounded-work guarantee is lost). With it, a writer
 * whose observed cursor has already moved on simply no-ops; the winner's cursor
 * stands. Returns false when that happened, so the caller can log rather than
 * assume it advanced.
 */
export function updateSessionScanCursor(
  db: Database,
  sessionId: number,
  byteOffset: number,
  lineNumber: number,
  observedByteOffset: number,
): boolean {
  return compareAndSetScanCursor(
    db,
    sessionId,
    byteOffset,
    lineNumber,
    observedByteOffset,
  );
}

/**
 * Deliberately pull the cursor BACKWARDS (spec §F pending-boundary rewind, and
 * the file-shrank restart). Separate from the advance path because a backwards
 * write is otherwise indistinguishable from the stale write the CAS exists to
 * reject; keeping it explicit means the guard never has to guess. Still
 * CAS-guarded on the observed value: a rewind computed from a stale snapshot is
 * exactly as wrong as a stale advance.
 */
export function rewindSessionScanCursor(
  db: Database,
  sessionId: number,
  byteOffset: number,
  lineNumber: number,
  observedByteOffset: number,
): boolean {
  return compareAndSetScanCursor(
    db,
    sessionId,
    byteOffset,
    lineNumber,
    observedByteOffset,
  );
}

/**
 * First-non-NULL write for the registration path that does NOT go through
 * `upsertSession` (SessionStart on an already-registered session). The
 * `IS NULL` guard is the whole semantics: a session that already knows its
 * transcript keeps it, so a resume from a different cwd cannot move the path.
 * Returns true when this call is the one that filled it.
 */
export function setSessionTranscriptPathIfAbsent(
  db: Database,
  sessionId: number,
  transcriptPath: string,
): boolean {
  return (
    db
      .query<unknown, [string, number]>(
        `UPDATE sessions
         SET transcript_path = ?
         WHERE id = ? AND transcript_path IS NULL`,
      )
      .run(transcriptPath, sessionId).changes > 0
  );
}

export function setSessionParent(
  db: Database,
  sessionId: number,
  parentSessionId: number,
): void {
  db.query(
    `UPDATE sessions SET parent_session_id = ? WHERE id = ?`,
  ).run(parentSessionId, sessionId);
}

export function setSessionLineageStatus(
  db: Database,
  sessionId: number,
  status: LineageStatus,
): void {
  db.query(
    `UPDATE sessions SET lineage_status = ? WHERE id = ?`,
  ).run(status, sessionId);
}
