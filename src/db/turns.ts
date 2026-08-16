import type { Database } from "bun:sqlite";

import { runWriteTransaction } from "./database";
import { markSettledDiaryDayStaleForTurn } from "./diary-state";

import { indexTurnToFTS, reindexTurnFromDb } from "./search";
import { recomputeSegmentFacetsForTurn } from "./segments";

export type TurnStatus =
  | "active"
  | "provisional"
  | "extracted"
  | "skipped"
  | "failed"
  | "undone";

export interface TurnRecord {
  id: number;
  sessionId: number;
  promptNumber: number;
  contentPromptId: string | null;
  transcriptLineStart: number | null;
  wasInterrupted: boolean;
  wasRolledBack: boolean;
  status: TurnStatus;
  userPrompt: string | null;
  assistantResponse: string | null;
  assistantTranscript: string | null;
  title: string | null;
  content: string | null;
  insight: string | null;
  /**
   * Multi-valued (ticket 02, spec B5): the closed vocabulary allows more than
   * one activity word per turn. `[]` means no type was stated — the same fact
   * `null` used to carry — never a positive claim (spec B7). Legacy rows keep
   * their pre-migration words wrapped one-per-element (spec's Out of Scope);
   * `compact` survives the same way and is read-legal though outside the
   * current vocabulary (see MEMORY_TYPES).
   */
  type: string[];
  significanceGrade: number | null;
  tags: string[];
  filesRead: string[];
  filesModified: string[];
  toolCallCount: number | null;
  parentTurnId: number | null;
  /**
   * Identity key of the `compact_boundary` transcript entry this marker turn
   * claims (spec §F). NULL on every ordinary turn; unique per session, which is
   * what makes boundary claiming idempotent across re-scans.
   */
  compactBoundaryUuid: string | null;
  createdAtEpoch: number;
  updatedAtEpoch: number | null;
}

interface TurnRow {
  id: number;
  sessionId: number;
  promptNumber: number;
  contentPromptId: string | null;
  transcriptLineStart: number | null;
  wasInterrupted: number;
  wasRolledBack: number;
  status: TurnStatus;
  userPrompt: string | null;
  assistantResponse: string | null;
  assistantTranscript: string | null;
  title: string | null;
  content: string | null;
  insight: string | null;
  type: string;
  significanceGrade: number | null;
  tags: string | null;
  filesRead: string | null;
  filesModified: string | null;
  toolCallCount: number | null;
  parentTurnId: number | null;
  compactBoundaryUuid: string | null;
  createdAtEpoch: number;
  updatedAtEpoch: number | null;
}

const TURN_SELECT = `
  SELECT
    id,
    session_id AS sessionId,
    prompt_number AS promptNumber,
    content_prompt_id AS contentPromptId,
    transcript_line_start AS transcriptLineStart,
    was_interrupted AS wasInterrupted,
    was_rolled_back AS wasRolledBack,
    status,
    user_prompt AS userPrompt,
    assistant_response AS assistantResponse,
    assistant_transcript AS assistantTranscript,
    title,
    content,
    insight,
    type,
    significance_grade AS significanceGrade,
    tags,
    files_read AS filesRead,
    files_modified AS filesModified,
    tool_call_count AS toolCallCount,
    parent_turn_id AS parentTurnId,
    compact_boundary_uuid AS compactBoundaryUuid,
    created_at_epoch AS createdAtEpoch,
    updated_at_epoch AS updatedAtEpoch
  FROM turns
`;

function stringifyArray(values: string[]): string {
  return JSON.stringify(values);
}

function parseJsonArray(value: string | null): string[] {
  if (!value) {
    return [];
  }

  return JSON.parse(value) as string[];
}

function mapTurnRow(row: TurnRow | null): TurnRecord | null {
  if (!row) {
    return null;
  }

  return {
    ...row,
    wasInterrupted: row.wasInterrupted === 1,
    wasRolledBack: row.wasRolledBack === 1,
    type: parseJsonArray(row.type),
    tags: parseJsonArray(row.tags),
    filesRead: parseJsonArray(row.filesRead),
    filesModified: parseJsonArray(row.filesModified),
    parentTurnId: row.parentTurnId ?? null,
  };
}

export function getTurn(
  db: Database,
  sessionId: number,
  promptNumber: number,
): TurnRecord | null {
  return mapTurnRow(
    db
      .query<TurnRow, [number, number]>(
        `${TURN_SELECT} WHERE session_id = ? AND prompt_number = ?`,
      )
      .get(sessionId, promptNumber) ?? null,
  );
}

export function getTurnById(
  db: Database,
  turnId: number,
): TurnRecord | null {
  return mapTurnRow(
    db.query<TurnRow, [number]>(`${TURN_SELECT} WHERE id = ?`).get(turnId) ?? null,
  );
}

export interface UpdateTurnByIdInput {
  status?: TurnStatus;
  wasInterrupted?: boolean;
  wasRolledBack?: boolean;
  title?: string | null;
  content?: string | null;
  insight?: string | null;
  /**
   * Undefined = leave the stored list alone; a defined array (including `[]`)
   * WHOLESALE REPLACES it. There is no separate "clear" value the way
   * title/content/insight have one: `[]` already means "no type", so it is
   * both the empty state and the explicit-clear state at once (spec B7).
   */
  type?: string[];
  significanceGrade?: number | null;
  transcriptLineStart?: number | null;
  /**
   * Undefined = leave the stored list alone; a defined array (including `[]`)
   * WHOLESALE REPLACES it — same rule as `type` immediately above, and for
   * the same reason (spec D5a/B7): there is no separate "clear" state, `[]`
   * already means that. Ticket 10a deleted the additive form this field used
   * to carry (`mergeTags`, above) plus the `replaceTags` alias that used to be
   * the only whole-replace path — settlement's own review directive was the
   * last caller that needed the additive one, and it now states its own full
   * tag list instead (worker/note-settlement-writeback.ts). A caller that
   * wants to keep an existing tag must restate it.
   */
  tags?: string[];
  filesRead?: string[];
  filesModified?: string[];
  toolCallCount?: number | null;
  updatedAtEpoch?: number | null;
}

/**
 * Undefined = the field was omitted, so the existing value survives; `null` =
 * an explicit clear, so a real SQL NULL is written; anything else is the new
 * value. Plain `??` cannot express this — it treats `null` and `undefined`
 * alike, collapsing "leave alone" and "clear" onto the same written value,
 * which is exactly the ambiguity ticket 04 (spec D10) closes for `remember`'s
 * per-field patch. Every caller that never sets these fields (they stay
 * `undefined`) sees no change in behaviour: `resolveNullable` falls back to
 * `existing` exactly where `??` used to.
 */
function resolveNullable<T>(
  value: T | null | undefined,
  existing: T | null,
): T | null {
  return value === undefined ? existing : value;
}

export function updateTurnById(
  db: Database,
  turnId: number,
  input: UpdateTurnByIdInput,
): TurnRecord | null {
  const existing = getTurnById(db, turnId);

  if (!existing) {
    return null;
  }

  const mergedTitle = resolveNullable(input.title, existing.title);
  const mergedContent = resolveNullable(input.content, existing.content);
  const mergedInsight = resolveNullable(input.insight, existing.insight);
  // No `resolveNullable` here: type has no SQL-NULL "clear" state any more —
  // `[]` already means "no type" (spec B7), so a defined array (empty or not)
  // always wins over the stored value, and only `undefined` leaves it alone.
  const mergedType = input.type === undefined ? existing.type : input.type;
  const mergedGrade = resolveNullable(
    input.significanceGrade,
    existing.significanceGrade,
  );
  const hasSubstance = mergedTitle !== null || mergedContent !== null;
  const nextStatus =
    input.status ??
    (existing.status === "active" && hasSubstance
      ? "extracted"
      : existing.status);
  const nextTags = input.tags === undefined ? existing.tags : input.tags;

  const updated = mapTurnRow(
    db
      .query<
        TurnRow,
        [
          string,
          number,
          number,
          string | null,
          string | null,
          string | null,
          string,
          number | null,
          number | null,
          string,
          string,
          string,
          number | null,
          number | null,
          number,
        ]
      >(
        `
          UPDATE turns
          SET
            status = ?,
            was_interrupted = ?,
            was_rolled_back = ?,
            title = ?,
            content = ?,
            insight = ?,
            type = ?,
            significance_grade = ?,
            transcript_line_start = ?,
            tags = ?,
            files_read = ?,
            files_modified = ?,
            tool_call_count = ?,
            updated_at_epoch = ?
          WHERE id = ?
          RETURNING
            id,
            session_id AS sessionId,
            prompt_number AS promptNumber,
            content_prompt_id AS contentPromptId,
            was_interrupted AS wasInterrupted,
            was_rolled_back AS wasRolledBack,
            status,
            user_prompt AS userPrompt,
            assistant_response AS assistantResponse,
            assistant_transcript AS assistantTranscript,
            title,
            content,
            insight,
            type,
            significance_grade AS significanceGrade,
            transcript_line_start AS transcriptLineStart,
            tags,
            files_read AS filesRead,
            files_modified AS filesModified,
            tool_call_count AS toolCallCount,
            parent_turn_id AS parentTurnId,
            compact_boundary_uuid AS compactBoundaryUuid,
            created_at_epoch AS createdAtEpoch,
            updated_at_epoch AS updatedAtEpoch
        `,
      )
      .get(
        nextStatus,
        input.wasInterrupted ?? existing.wasInterrupted ? 1 : 0,
        input.wasRolledBack ?? existing.wasRolledBack ? 1 : 0,
        mergedTitle,
        mergedContent,
        mergedInsight,
        stringifyArray(mergedType),
        mergedGrade,
        input.transcriptLineStart ?? existing.transcriptLineStart,
        stringifyArray(nextTags),
        stringifyArray(input.filesRead ?? existing.filesRead),
        stringifyArray(input.filesModified ?? existing.filesModified),
        input.toolCallCount ?? existing.toolCallCount,
        input.updatedAtEpoch ?? existing.updatedAtEpoch,
        turnId,
      ) ?? null,
  );

  if (!updated) {
    return null;
  }

  // Status-blind (spec D11): the row is re-indexed as it now stands, whatever
  // status the write left it in. A skipped or undone turn keeps its originals
  // findable; what a reader is SHOWN is decided at render time.
  indexTurnToFTS(db, updated);
  // A member's facets are an input to its segments' derived `type`/`tags`
  // (spec K5a), so this write is a segment write too (ticket 15 finding 1).
  // The two writes that most need it are the ordinary ones: a settlement window
  // revising an EARLIER turn's type (the prompt's duty 1 invites exactly that),
  // and a staged `segment` create replayed before the `note` that types its
  // member. `promoteTurnFromNote` needs no such call — it writes title, content,
  // insight and status, none of which any facet derives from.
  //
  // Gated on the facets having actually moved, on the same question the
  // `segments_facets_stale_on_member_facets_written` trigger asks (schema.ts):
  // a recomputation costs ~16 ms on the live database, nearly all of it the FTS
  // rewrite, and `updateTurnById` restates `type`/`tags` on every write whether
  // or not they changed. Skipping an unchanged write is safe precisely because
  // the trigger raised no debt for it either.
  if (
    JSON.stringify(existing.type) !== stringifyArray(mergedType) ||
    JSON.stringify(existing.tags) !== stringifyArray(nextTags)
  ) {
    recomputeSegmentFacetsForTurn(db, turnId);
  }

  if (
    existing.status !== updated.status ||
    existing.userPrompt !== updated.userPrompt ||
    existing.assistantResponse !== updated.assistantResponse ||
    existing.title !== updated.title ||
    existing.content !== updated.content ||
    existing.insight !== updated.insight
  ) {
    markSettledDiaryDayStaleForTurn(db, updated.createdAtEpoch);
  }

  return updated;
}

export interface PromoteTurnFromNoteInput {
  title: string;
  content: string;
  insight: string | null;
  updatedAtEpoch: number;
}

/**
 * Write a main agent's own note onto the turn row — the era cutover's whole
 * point (spec D4/D12, ticket 09).
 *
 * Separate from `updateTurnById` because the contract differs, not the SQL:
 * every field there coalesces (`input.x ?? existing.x`), which is right for an
 * extraction that fills a record in pieces and wrong here. In the new era the
 * note IS the record, so a rewrite that drops its insight has to store the NULL
 * rather than silently inherit the previous note's.
 *
 * Status advances one step of the ordinary lifecycle, and which step depends on
 * whether the turn is over:
 *
 *  - still open (`active`/`provisional`) → `provisional`. In this era a note is
 *    written DURING its own turn (裁决 26), so `extracted` would stop meaning
 *    "this turn is over" — and readers use it with exactly that meaning. The
 *    one that bites is observation capture (hooks/handlers/post-tool-use.ts),
 *    which drops every observation once the session's newest turn reads
 *    terminal: a note mid-turn would silently truncate the raw axis for the
 *    rest of it. `provisional` is the lifecycle's existing word for "a record
 *    has been written, the turn is not final yet", and the turn's own end
 *    carries it the rest of the way.
 *  - already finished (`extracted`/`skipped`/`failed` — a late note answering a
 *    backlog relief) → `extracted`, which is what holding a record means:
 *    db/search.ts renders only `extracted` turns.
 *  - `undone` → left alone. A sidechain row is not part of this session's arc,
 *    and promoting it would put it back in view.
 */
export function promoteTurnFromNote(
  db: Database,
  turnId: number,
  input: PromoteTurnFromNoteInput,
): TurnRecord | null {
  const existing = getTurnById(db, turnId);
  if (!existing) {
    return null;
  }

  const nextStatus: TurnStatus =
    existing.status === "undone"
      ? "undone"
      : existing.status === "active" || existing.status === "provisional"
        ? "provisional"
        : "extracted";

  db.query<unknown, [string, string, string | null, string, number, number]>(
    `UPDATE turns
     SET title = ?, content = ?, insight = ?, status = ?, updated_at_epoch = ?
     WHERE id = ?`,
  ).run(
    input.title,
    input.content,
    input.insight,
    nextStatus,
    input.updatedAtEpoch,
    turnId,
  );

  const updated = getTurnById(db, turnId);
  if (!updated) {
    return null;
  }

  indexTurnToFTS(db, updated);

  if (
    existing.status !== updated.status ||
    existing.title !== updated.title ||
    existing.content !== updated.content ||
    existing.insight !== updated.insight
  ) {
    markSettledDiaryDayStaleForTurn(db, updated.createdAtEpoch);
  }

  return updated;
}

export function resetTurnExtractionFields(
  db: Database,
  turnId: number,
  updatedAtEpoch: number,
): void {
  const existing = getTurnById(db, turnId);
  if (!existing) {
    return;
  }
  // Keep colon-namespaced internal reminder tags; drop agent freeform tags.
  const keptTags = existing.tags.filter((tag) => tag.includes(":"));
  db.query(
    `UPDATE turns
       SET status = 'active',
           title = NULL,
           content = NULL,
           insight = NULL,
           type = '[]',
           tags = ?,
           updated_at_epoch = ?
       WHERE id = ?`,
  ).run(stringifyArray(keptTags), updatedAtEpoch, turnId);
  // Re-index rather than delete: the extraction fields are gone, but the
  // prompt and response this turn was captured with are still the record.
  reindexTurnFromDb(db, turnId);
  // This write clears `type` and strips the freeform tags, so a segment holding
  // this turn was deriving from values that no longer exist (ticket 15). Same
  // gate as `updateTurnById`: a reset of a turn that already held neither
  // changes no input.
  if (
    existing.type.length > 0 ||
    JSON.stringify(existing.tags) !== stringifyArray(keptTags)
  ) {
    recomputeSegmentFacetsForTurn(db, turnId);
  }

  if (
    existing.status !== "active" ||
    existing.title !== null ||
    existing.content !== null ||
    existing.insight !== null
  ) {
    markSettledDiaryDayStaleForTurn(db, existing.createdAtEpoch);
  }
}

export function getTurnsForSession(
  db: Database,
  sessionId: number,
): TurnRecord[] {
  return db
    .query<TurnRow, [number]>(
      `${TURN_SELECT} WHERE session_id = ? ORDER BY prompt_number ASC`,
    )
    .all(sessionId)
    .map((row) => mapTurnRow(row))
    .filter((turn): turn is TurnRecord => turn !== null);
}

export function getStrandedTurns(
  db: Database,
  sessionId: number,
): TurnRecord[] {
  return db
    .query<TurnRow, [number]>(
      `${TURN_SELECT}
       WHERE session_id = ?
         AND assistant_response IS NOT NULL
         AND ( status IN ('active','provisional')
               OR (status = 'extracted' AND title IS NULL AND content IS NULL) )
       ORDER BY prompt_number ASC`,
    )
    .all(sessionId)
    .map((row) => mapTurnRow(row))
    .filter((turn): turn is TurnRecord => turn !== null);
}

export function getFirstTurn(
  db: Database,
  sessionId: number,
): TurnRecord | null {
  return mapTurnRow(
    db
      .query<TurnRow, [number]>(
        `${TURN_SELECT} WHERE session_id = ? ORDER BY prompt_number ASC LIMIT 1`,
      )
      .get(sessionId) ?? null,
  );
}

export function setTurnParent(
  db: Database,
  turnId: number,
  parentTurnId: number,
): void {
  db.query("UPDATE turns SET parent_turn_id = ? WHERE id = ?").run(
    parentTurnId,
    turnId,
  );
}

export function getMaxPromptNumber(
  db: Database,
  sessionId: number,
): number | null {
  const row = db
    .query<{ max: number | null }, [number]>(
      "SELECT MAX(prompt_number) AS max FROM turns WHERE session_id = ?",
    )
    .get(sessionId);

  return row?.max ?? null;
}

/**
 * The turn the session is on right now — the one the backlog relief's
 * injection rides and attributes its exposure rows to.
 *
 * `undone` rows are excluded: a sidechain prompt's row (born `undone`, or
 * marked so by the transcript scan) sits above the root turn in prompt order
 * for the whole delegation window, and it is not a turn the session is "on".
 */
export function getLatestTurn(
  db: Database,
  sessionId: number,
): { id: number; promptNumber: number } | null {
  return (
    db
      .query<{ id: number; promptNumber: number }, [number]>(
        `SELECT id, prompt_number AS promptNumber FROM turns
         WHERE session_id = ? AND status != 'undone'
         ORDER BY prompt_number DESC LIMIT 1`,
      )
      .get(sessionId) ?? null
  );
}

/**
 * Highest turn id in the session right now. SessionEnd snapshots it alongside
 * the activity gate so its later orphan pass is fenced to turns that already
 * existed — anything a concurrent UserPromptSubmit (or the repair itself)
 * inserts afterwards gets a larger id and is out of scope by construction.
 */
export function getMaxTurnId(db: Database, sessionId: number): number | null {
  const row = db
    .query<{ max: number | null }, [number]>(
      "SELECT MAX(id) AS max FROM turns WHERE session_id = ?",
    )
    .get(sessionId);

  return row?.max ?? null;
}

export function updateTurnBackfill(
  db: Database,
  turnId: number,
  assistantResponse: string,
  toolCallCount: number,
  contentPromptId?: string | null,
  transcriptLineStart?: number | null,
  assistantTranscript?: string | null,
): void {
  const existing = getTurnById(db, turnId);
  if (!existing) {
    return;
  }

  const safeContentPromptId =
    contentPromptId &&
    !hasOtherTurnWithContentPromptId(
      db,
      existing.sessionId,
      turnId,
      contentPromptId,
    )
      ? contentPromptId
      : null;

  db.query(
    `UPDATE turns
     SET assistant_response = ?,
         assistant_transcript = COALESCE(?, assistant_transcript),
         tool_call_count = ?,
         content_prompt_id = COALESCE(content_prompt_id, ?),
         transcript_line_start = COALESCE(?, transcript_line_start)
     WHERE id = ?`,
  ).run(
    assistantResponse,
    assistantTranscript ?? null,
    toolCallCount,
    safeContentPromptId,
    transcriptLineStart ?? null,
    turnId,
  );

  if (existing.assistantResponse !== assistantResponse) {
    markSettledDiaryDayStaleForTurn(db, existing.createdAtEpoch);
  }
}

function hasOtherTurnWithContentPromptId(
  db: Database,
  sessionId: number,
  turnId: number,
  contentPromptId: string,
): boolean {
  return (
    db
      .query<{ id: number }, [number, string, number]>(
        `
          SELECT id
          FROM turns
          WHERE session_id = ?
            AND content_prompt_id = ?
            AND id <> ?
          LIMIT 1
        `,
      )
      .get(sessionId, contentPromptId, turnId) !== null
  );
}
