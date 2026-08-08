import type { Database } from "bun:sqlite";

import { isMnemoOwnToolName } from "../shared/note-tool";

/**
 * The P1 note-debt ledger (spec D2/D3).
 *
 * Ownership is split on purpose and the split is the point (R2#P2-6): every
 * WRITE in this module runs on the asynchronous ingest side (the Stop handler's
 * completion event and the PostToolUse capture entry), while the synchronous
 * PostToolUse entry that returns the reminder only ever calls the read
 * functions. A hook result carrying `additionalContext` cannot also carry
 * `asyncWork` — the runner emits one or the other — so a single handler that
 * both maintained the ledger and rendered the reminder would have to give up the
 * worker wake, and two handlers that both maintained it would race on the same
 * rows every batch.
 */

/** Turns a debt may wait before it is written off (spec D3's only hard bound). */
export const NOTE_DEBT_AGING_TURNS = 50;

export type NoteDebtStatus = "pending" | "noted" | "skipped";
export type NoteDebtReason = "aged" | "rolled-back";

export interface NoteDebtRecord {
  turnId: number;
  sessionId: number;
  promptNumber: number;
  status: NoteDebtStatus;
  reason: NoteDebtReason | null;
  openedAtEpoch: number;
  closedAtEpoch: number | null;
  updatedAtEpoch: number;
}

/** An open debt joined with what the reminder has to render. */
export interface OpenNoteDebt {
  turnId: number;
  sessionId: number;
  promptNumber: number;
  userPrompt: string | null;
  wasRolledBack: boolean;
  openedAtEpoch: number;
  /** How many turns the session has moved on since this turn ended. */
  pendingTurns: number;
}

export interface ReconcileNoteDebtInput {
  sessionId: number;
  nowEpoch: number;
  /**
   * A turn known to have just ended (the Stop event's turn). Without it only
   * turns strictly older than the session's open turn are classified, which is
   * the right rule for the capture entry — it fires mid-turn.
   */
  completedTurnId?: number;
  agingTurns?: number;
}

export interface ReconcileNoteDebtResult {
  opened: number[];
  noted: number[];
  aged: number[];
  rolledBack: number[];
  classifiedThroughPromptNumber: number;
}

const NOTE_DEBT_COLUMNS = `
  turn_id AS turnId,
  session_id AS sessionId,
  prompt_number AS promptNumber,
  status,
  reason,
  opened_at_epoch AS openedAtEpoch,
  closed_at_epoch AS closedAtEpoch,
  updated_at_epoch AS updatedAtEpoch
`;

export function getNoteDebt(
  db: Database,
  turnId: number,
): NoteDebtRecord | null {
  return (
    db
      .query<NoteDebtRecord, [number]>(
        `SELECT ${NOTE_DEBT_COLUMNS} FROM note_debt WHERE turn_id = ?`,
      )
      .get(turnId) ?? null
  );
}

export function listNoteDebt(
  db: Database,
  sessionId: number,
): NoteDebtRecord[] {
  return db
    .query<NoteDebtRecord, [number]>(
      `SELECT ${NOTE_DEBT_COLUMNS} FROM note_debt
       WHERE session_id = ?
       ORDER BY prompt_number ASC`,
    )
    .all(sessionId);
}

/**
 * A turn's substantive tool calls. Reads the captured observations rather than
 * `turns.tool_call_count`: the count column is derived from the transcript by a
 * later backfill and includes mnemo's own calls, while observations are what the
 * hook actually saw, are already present when the turn ends, and carry the
 * exclusion marker.
 */
export function countSubstantiveToolCalls(db: Database, turnId: number): number {
  const rows = db
    .query<{ toolName: string | null }, [number]>(
      `SELECT tool_name AS toolName FROM observations
       WHERE turn_id = ? AND excluded_from_extraction = 0`,
    )
    .all(turnId);

  return rows.filter(
    (row) => row.toolName !== null && !isMnemoOwnToolName(row.toolName),
  ).length;
}

function getMaxPromptNumber(db: Database, sessionId: number): number {
  return (
    db
      .query<{ maxPromptNumber: number | null }, [number]>(
        "SELECT MAX(prompt_number) AS maxPromptNumber FROM turns WHERE session_id = ?",
      )
      .get(sessionId)?.maxPromptNumber ?? 0
  );
}

function getClassificationCursor(db: Database, sessionId: number): number {
  return (
    db
      .query<{ cursor: number }, [number]>(
        `SELECT last_classified_prompt_number AS cursor
         FROM note_debt_cursor WHERE session_id = ?`,
      )
      .get(sessionId)?.cursor ?? 0
  );
}

function setClassificationCursor(
  db: Database,
  sessionId: number,
  promptNumber: number,
  nowEpoch: number,
): void {
  db.query<unknown, [number, number, number]>(
    `INSERT INTO note_debt_cursor (
       session_id, last_classified_prompt_number, updated_at_epoch
     ) VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       last_classified_prompt_number = MAX(
         note_debt_cursor.last_classified_prompt_number,
         excluded.last_classified_prompt_number
       ),
       updated_at_epoch = excluded.updated_at_epoch`,
  ).run(sessionId, promptNumber, nowEpoch);
}

/**
 * Classify one finished turn and open a debt if it owes a note.
 *
 * Returns the turn id when a debt was opened. Trivial turns (spec's 裁决 13)
 * leave no trace at all: absence from the ledger IS the "owes nothing" record,
 * and their value is carried by the raw text and FTS instead.
 */
function classifyCompletedTurn(
  db: Database,
  turn: { id: number; promptNumber: number; sessionId: number },
  nowEpoch: number,
): boolean {
  if (getNoteDebt(db, turn.id) !== null) {
    return false;
  }

  // Already noted before the ledger ever saw it (the agent can note any turn it
  // has an address for). Opening a debt now would demand a second note.
  const alreadyNoted = db
    .query<{ present: number }, [number]>(
      "SELECT 1 AS present FROM shadow_notes WHERE turn_id = ?",
    )
    .get(turn.id);
  if (alreadyNoted) {
    return false;
  }

  if (countSubstantiveToolCalls(db, turn.id) === 0) {
    return false;
  }

  db.query<unknown, [number, number, number, number, number]>(
    `INSERT OR IGNORE INTO note_debt (
       turn_id, session_id, prompt_number, status, opened_at_epoch, updated_at_epoch
     ) VALUES (?, ?, ?, 'pending', ?, ?)`,
  ).run(turn.id, turn.sessionId, turn.promptNumber, nowEpoch, nowEpoch);

  return true;
}

function closeDebt(
  db: Database,
  turnId: number,
  status: Exclude<NoteDebtStatus, "pending">,
  reason: NoteDebtReason | null,
  nowEpoch: number,
): void {
  db.query<unknown, [string, string | null, number, number, number]>(
    `UPDATE note_debt
     SET status = ?, reason = ?, closed_at_epoch = ?, updated_at_epoch = ?
     WHERE turn_id = ? AND status = 'pending'`,
  ).run(status, reason, nowEpoch, nowEpoch, turnId);
}

/**
 * Bring the ledger up to date for one session: classify newly finished turns,
 * clear debts the agent has written notes for, close rolled-back debts the agent
 * has already been told about, and age out debts past the 50-turn bound.
 *
 * Idempotent and event-driven — there is no startup scan anywhere, and calling
 * it twice for the same event changes nothing the second time.
 */
export function reconcileNoteDebt(
  db: Database,
  input: ReconcileNoteDebtInput,
): ReconcileNoteDebtResult {
  const { sessionId, nowEpoch } = input;
  const agingTurns = input.agingTurns ?? NOTE_DEBT_AGING_TURNS;
  const maxPromptNumber = getMaxPromptNumber(db, sessionId);
  const cursor = getClassificationCursor(db, sessionId);

  // The session's newest turn is still open, so it is not classified — unless
  // the caller names it as the turn that just ended (the Stop event).
  let classifyThrough = maxPromptNumber - 1;
  if (input.completedTurnId !== undefined) {
    const completed = db
      .query<{ promptNumber: number; sessionId: number }, [number]>(
        `SELECT prompt_number AS promptNumber, session_id AS sessionId
         FROM turns WHERE id = ?`,
      )
      .get(input.completedTurnId);
    if (completed && completed.sessionId === sessionId) {
      classifyThrough = Math.max(classifyThrough, completed.promptNumber);
    }
  }

  const opened: number[] = [];
  if (classifyThrough > cursor) {
    const candidates = db
      .query<
        { id: number; promptNumber: number; sessionId: number },
        [number, number, number]
      >(
        `SELECT id, prompt_number AS promptNumber, session_id AS sessionId
         FROM turns
         WHERE session_id = ? AND prompt_number > ? AND prompt_number <= ?
         ORDER BY prompt_number ASC`,
      )
      .all(sessionId, cursor, classifyThrough);

    for (const candidate of candidates) {
      if (classifyCompletedTurn(db, candidate, nowEpoch)) {
        opened.push(candidate.id);
      }
    }

    setClassificationCursor(db, sessionId, classifyThrough, nowEpoch);
  }

  const pending = db
    .query<
      {
        turnId: number;
        promptNumber: number;
        wasRolledBack: number;
        hasNote: number;
        wasExposed: number;
      },
      [number]
    >(
      `SELECT
         d.turn_id AS turnId,
         d.prompt_number AS promptNumber,
         t.was_rolled_back AS wasRolledBack,
         EXISTS(SELECT 1 FROM shadow_notes n WHERE n.turn_id = d.turn_id) AS hasNote,
         EXISTS(
           SELECT 1 FROM note_id_exposures e
           WHERE e.session_id = d.session_id
             AND e.exposed_turn_id = d.turn_id
             AND e.source = 'reminder'
         ) AS wasExposed
       FROM note_debt d
       JOIN turns t ON t.id = d.turn_id
       WHERE d.session_id = ? AND d.status = 'pending'
       ORDER BY d.prompt_number ASC`,
    )
    .all(sessionId);

  const noted: number[] = [];
  const rolledBack: number[] = [];
  const aged: number[] = [];

  for (const row of pending) {
    if (row.hasNote === 1) {
      closeDebt(db, row.turnId, "noted", null, nowEpoch);
      noted.push(row.turnId);
      continue;
    }

    // A rolled-back turn needs no note, but the debt is not deleted silently:
    // it closes only after the agent has been shown the "rolled back" line once,
    // so every debt it ever saw has a visible outcome (user story 5).
    if (row.wasRolledBack === 1 && row.wasExposed === 1) {
      closeDebt(db, row.turnId, "skipped", "rolled-back", nowEpoch);
      rolledBack.push(row.turnId);
      continue;
    }

    if (maxPromptNumber - row.promptNumber > agingTurns) {
      closeDebt(db, row.turnId, "skipped", "aged", nowEpoch);
      aged.push(row.turnId);
    }
  }

  return {
    opened,
    noted,
    aged,
    rolledBack,
    classifiedThroughPromptNumber: Math.max(cursor, classifyThrough),
  };
}

export interface ListOpenNoteDebtOptions {
  /** The turn the session is on now; "pending N turns" is measured from it. */
  latestPromptNumber: number;
  agingTurns?: number;
}

/**
 * The open debts a reminder may show — READ ONLY, by contract.
 *
 * Aging is applied here as a filter rather than an update: a debt past the bound
 * is never rendered again from the moment it crosses it, which is the behaviour
 * "lazily aged at read time" is asking for, while the durable `skipped(aged)`
 * transition happens on the next reconcile from the async side. The alternative
 * — writing from the reminder path — would put ledger mutation on the one entry
 * that cannot wake the worker.
 */
export function listOpenNoteDebt(
  db: Database,
  sessionId: number,
  options: ListOpenNoteDebtOptions,
): OpenNoteDebt[] {
  const agingTurns = options.agingTurns ?? NOTE_DEBT_AGING_TURNS;

  return db
    .query<
      {
        turnId: number;
        sessionId: number;
        promptNumber: number;
        userPrompt: string | null;
        wasRolledBack: number;
        openedAtEpoch: number;
      },
      [number]
    >(
      `SELECT
         d.turn_id AS turnId,
         d.session_id AS sessionId,
         d.prompt_number AS promptNumber,
         t.user_prompt AS userPrompt,
         t.was_rolled_back AS wasRolledBack,
         d.opened_at_epoch AS openedAtEpoch
       FROM note_debt d
       JOIN turns t ON t.id = d.turn_id
       WHERE d.session_id = ? AND d.status = 'pending'
       ORDER BY d.prompt_number ASC`,
    )
    .all(sessionId)
    .map((row) => ({
      turnId: row.turnId,
      sessionId: row.sessionId,
      promptNumber: row.promptNumber,
      userPrompt: row.userPrompt,
      wasRolledBack: row.wasRolledBack === 1,
      openedAtEpoch: row.openedAtEpoch,
      pendingTurns: Math.max(0, options.latestPromptNumber - row.promptNumber),
    }))
    .filter((debt) => debt.pendingTurns <= agingTurns);
}

export type NoteIdExposureSource = "reminder" | "injection";

export interface RecordNoteIdExposureInput {
  sessionId: number;
  rideTurnId: number;
  exposedTurnIds: number[];
  source: NoteIdExposureSource;
  nowEpoch: number;
}

/**
 * Record which turn ids were rendered into the model's context, and during which
 * turn. Written by whoever does the rendering — the reminder path for `reminder`
 * rows, an injection builder for `injection` rows — because only the renderer
 * knows an id actually reached the model.
 */
export function recordNoteIdExposure(
  db: Database,
  input: RecordNoteIdExposureInput,
): number {
  const statement = db.query<unknown, [number, number, number, string, number]>(
    `INSERT OR IGNORE INTO note_id_exposures (
       session_id, ride_turn_id, exposed_turn_id, source, created_at_epoch
     ) VALUES (?, ?, ?, ?, ?)`,
  );

  let written = 0;
  for (const exposedTurnId of input.exposedTurnIds) {
    statement.run(
      input.sessionId,
      input.rideTurnId,
      exposedTurnId,
      input.source,
      input.nowEpoch,
    );
    written += 1;
  }

  return written;
}

/** Every turn id this session has shown the agent, from any source. */
export function getExposedTurnIds(
  db: Database,
  sessionId: number,
  source?: NoteIdExposureSource,
): Set<number> {
  const rows = source
    ? db
        .query<{ exposedTurnId: number }, [number, string]>(
          `SELECT DISTINCT exposed_turn_id AS exposedTurnId
           FROM note_id_exposures WHERE session_id = ? AND source = ?`,
        )
        .all(sessionId, source)
    : db
        .query<{ exposedTurnId: number }, [number]>(
          `SELECT DISTINCT exposed_turn_id AS exposedTurnId
           FROM note_id_exposures WHERE session_id = ?`,
        )
        .all(sessionId);

  return new Set(rows.map((row) => row.exposedTurnId));
}

/** Has a reminder already been delivered during this turn? (at most one). */
export function hasReminderForRideTurn(
  db: Database,
  sessionId: number,
  rideTurnId: number,
): boolean {
  return (
    db
      .query<{ present: number }, [number, number]>(
        `SELECT 1 AS present FROM note_id_exposures
         WHERE session_id = ? AND ride_turn_id = ? AND source = 'reminder'
         LIMIT 1`,
      )
      .get(sessionId, rideTurnId) !== null
  );
}
