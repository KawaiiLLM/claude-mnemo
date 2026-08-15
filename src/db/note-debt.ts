import type { Database } from "bun:sqlite";

/**
 * The note-debt ledger (spec note-prompt-clock, D1/D8).
 *
 * The owed set is no longer written anywhere — it is a DERIVED QUERY, computed
 * fresh on every UserPromptSubmit from `turns`/`shadow_notes`/`note_debt`
 * (`listOwedNoteTurns` below). The clock that used to decide "has this turn
 * ended" (a Stop event, a classification sweep) is gone too: a turn ends the
 * moment a later prompt exists, full stop, and that is a fact `turns` already
 * carries — nothing needs to observe it happening.
 *
 * `note_debt` itself survives only as a table of RECORDED ANSWERS: a `skipped`
 * row is the agent explicitly declining a turn (`declined`), or the system
 * writing one off (`closed`, from residual settlement; `aged`/`rolled-back`
 * are historical reasons a pre-cutover ledger produced and are read here but
 * never written any more). A `noted` row exists only when a turn's decline was
 * later reversed by a real note — `getShadowNote` already answers "is this
 * turn noted" directly, so nothing reads `noted` rows as a signal, but closing
 * one is what lets a reversed decline stop being reported as `declined`. There
 * is no `pending` writer left: a debt this module never opens cannot need
 * closing, and a `pending` row surviving from before this cutover is read as
 * "unanswered", not as an obligation anything here tracks.
 */

export type NoteDebtStatus = "pending" | "noted" | "skipped";
/**
 * `closed` is written only by residual settlement (spec D9): a session with no
 * live registration and no activity for a day will never get its notes written,
 * so its open debts are converted at claim time. Without that conversion the
 * unsettled window is permanently blocked behind a debt nobody will ever pay.
 *
 * `declined` is the only reason the AGENT writes (裁决 24): it answered the
 * reminder with `note(turn, skip: true)` because the turn held nothing worth
 * keeping, or because its details had left the context window (a compact
 * routinely strands the oldest debts that way) and the only alternative was
 * inventing a note from the reminder line.
 *
 * `aged` and `rolled-back` are historical only (pre note-prompt-clock): a
 * turn past the reminder's window, or a rolled-back turn, simply never enters
 * `listOwedNoteTurns`'s result any more — there is nothing left to close.
 */
export type NoteDebtReason = "aged" | "rolled-back" | "closed" | "declined";

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
 * Every close goes through here, and every close is `WHERE status = 'pending'`.
 * That predicate is the whole concurrency story of the ledger: a debt has one
 * terminal state, whoever writes it first wins, and no later write can re-open
 * a closed debt or overwrite one outcome with another.
 */
function closeDebt(
  db: Database,
  turnId: number,
  status: Exclude<NoteDebtStatus, "pending">,
  reason: NoteDebtReason | null,
  nowEpoch: number,
): boolean {
  return (
    db
      .query<unknown, [string, string | null, number, number, number]>(
        `UPDATE note_debt
         SET status = ?, reason = ?, closed_at_epoch = ?, updated_at_epoch = ?
         WHERE turn_id = ? AND status = 'pending'`,
      )
      .run(status, reason, nowEpoch, nowEpoch, turnId).changes > 0
  );
}

/**
 * Close a debt because its note has just been written — called by the `note`
 * tool itself, synchronously with the write.
 *
 * This is the ONE close that can overwrite another outcome, and only that one:
 * `skipped(declined)` → `noted`. A decline is the agent's own judgement about
 * its own turn (裁決 24), so the agent is entitled to revise it — and it can
 * only do so by deliberately calling `note` for an address `listOwedNoteTurns`
 * will never show again (a decline already excludes the turn from the owed
 * set). `aged`, `rolled-back` and `closed` are the system's judgements and
 * stay terminal.
 *
 * A turn with no `note_debt` row at all (the ordinary case now that nothing
 * opens one pre-emptively) simply has nothing to close here — `WHERE turn_id
 * = ?` matches zero rows and this returns `false`, which the caller does not
 * need to act on: the note itself is the durable record.
 */
export function closeNoteDebtAsNoted(
  db: Database,
  turnId: number,
  nowEpoch: number,
): boolean {
  return (
    db
      .query<unknown, [number, number, number]>(
        `UPDATE note_debt
         SET status = 'noted', reason = NULL,
             closed_at_epoch = ?, updated_at_epoch = ?
         WHERE turn_id = ?
           AND (status = 'pending' OR (status = 'skipped' AND reason = 'declined'))`,
      )
      .run(nowEpoch, nowEpoch, turnId).changes > 0
  );
}

/**
 * Close a debt because the agent declined it — `note(turn, skip: true)`, the
 * explicit half of 裁决 24's skip rule.
 *
 * A skip is a real answer, not silence: it takes the turn out of
 * `listOwedNoteTurns` (which excludes any turn with a `skipped` `note_debt`
 * row, whatever the reason) so a turn the agent cannot honestly write about
 * stops occupying one of the backlog relief's five oldest slots.
 *
 * Same `WHERE status = 'pending'` guard as `closeNoteDebtAsNoted`, so a debt a
 * note has already settled keeps its `noted` outcome and the skip is a no-op.
 */
export function closeNoteDebtAsDeclined(
  db: Database,
  turnId: number,
  nowEpoch: number,
): boolean {
  return closeDebt(db, turnId, "skipped", "declined", nowEpoch);
}

/**
 * Record a decline for a turn whose debt does not exist yet — the ordinary
 * shape now that nothing opens a debt ahead of time. The row is born closed:
 * `skipped(declined)` from the start. `INSERT OR IGNORE` keeps a concurrent
 * write (another decline, or a note landing first) authoritative; the caller
 * falls back to the ordinary close in that case.
 */
export function recordDeclinedNoteDebt(
  db: Database,
  turn: { id: number; sessionId: number; promptNumber: number },
  nowEpoch: number,
): boolean {
  return (
    db
      .query<unknown, [number, number, number, number, number, number]>(
        `INSERT OR IGNORE INTO note_debt (
           turn_id, session_id, prompt_number, status, reason,
           opened_at_epoch, closed_at_epoch, updated_at_epoch
         ) VALUES (?, ?, ?, 'skipped', 'declined', ?, ?, ?)`,
      )
      .run(turn.id, turn.sessionId, turn.promptNumber, nowEpoch, nowEpoch, nowEpoch)
      .changes > 0
  );
}

/**
 * Convert every open debt of a CLOSED session to `skipped(closed)` — the
 * claim-time step of residual settlement (spec D9, 裁决 11).
 *
 * Called from inside the residual job's claim transaction, never speculatively:
 * "closed" is a judgement computed at query time from live registrations and
 * idle age, and it is deliberately never stored outside this write. Uses the
 * same `WHERE status = 'pending'` guard as every other close, so a debt a late
 * note just settled keeps its `noted` outcome. A session whose ledger holds no
 * pre-cutover `pending` rows simply has nothing for this to touch.
 */
export function closePendingNoteDebtsAsClosed(
  db: Database,
  sessionId: number,
  nowEpoch: number,
): number {
  return db
    .query<unknown, [number, number, number]>(
      `UPDATE note_debt
       SET status = 'skipped', reason = 'closed',
           closed_at_epoch = ?, updated_at_epoch = ?
       WHERE session_id = ? AND status = 'pending'`,
    )
    .run(nowEpoch, nowEpoch, sessionId).changes;
}

/**
 * The prompt clock's "is this a REAL prompt" predicate (spec D1/D10): a row
 * only counts as session progression when it is not a sidechain's pending
 * marker (`undone`), not invalidated (`was_rolled_back`), and not a compact
 * marker (a `type` list containing `compact`). `listOwedNoteTurns`/
 * `listOwedNoteTurnsInRange` apply it to the CANDIDATE row below;
 * db/turn-settlement.ts's settlement candidate predicate and
 * db/note-settlement.ts's `getMaxPromptNumber` apply the same definition to
 * decide whether a LATER row is real evidence that a turn has ended — one
 * definition, so "what counts as a real prompt" cannot drift between readers
 * (P1-1: a sidechain row born with a higher prompt number must never read as
 * proof that an earlier, still-running turn ended).
 *
 * `type` is a JSON array since ticket 02 (spec B5); matched via `json_each`
 * rather than a scalar `!=`, same pattern as the `tag:` search facet. The
 * column is `NOT NULL DEFAULT '[]'` post-migration, so the old `IS NULL`
 * branch is dead weight kept only for a database mid-migration (schema.ts's
 * rebuild runs at startup, but a read racing that same startup should not
 * see a nonexistent state as "not a compact marker").
 */
export function realPromptPredicate(alias = "t"): string {
  return `${alias}.status != 'undone' AND ${alias}.was_rolled_back = 0 AND (${alias}.type IS NULL OR NOT EXISTS (SELECT 1 FROM json_each(${alias}.type) WHERE value = 'compact'))`;
}

/** Turns before which the reminder no longer counts a turn as owed (spec D1's only hard bound — it governs display, not writability; see mcp/note.ts). */
export const NOTE_DEBT_AGING_TURNS = 50;

export interface OwedNoteTurn {
  turnId: number;
  sessionId: number;
  promptNumber: number;
  userPrompt: string | null;
  /** How many later prompts have gone by since this turn ended. */
  pendingTurns: number;
}

export interface ListOwedNoteTurnsOptions {
  agingTurns?: number;
}

/**
 * The owed-note set for one session, computed fresh on every call (spec D1).
 *
 * A turn owes a note when every one of these holds, and none of them is a
 * write this function performs:
 *
 *   - it ENDED, which the prompt clock alone decides: `prompt_number <
 *     currentPromptNumber` — a later prompt existing IS the turn ending, no
 *     Stop capture or tool-call count required (spec's core move: "结束的
 *     定义就是新 prompt 到达");
 *   - nobody has ANSWERED for it — no `shadow_notes` row (a real note), and no
 *     `note_debt` row whose status is `skipped` for ANY reason (a decline, an
 *     aged-out or rolled-back closure from before this query replaced the
 *     classification walk, or a residual write-off). A stray leftover
 *     `pending` row from before the cutover is deliberately NOT an answer —
 *     it is read exactly like no row at all;
 *   - it is not a row this session's own bookkeeping produced: not `undone`
 *     (a sidechain's pending row, born already marked), not rolled back, and
 *     not a compact marker (`type = 'compact'` — spec D2's one mechanical row
 *     in the whole session, created by the PreCompact transcript-repair path);
 *   - it is inside the reminder's 50-turn window. The bound is on the
 *     REMINDER, not on writability — `note`/`skip` accept any address that
 *     resolves to a real, non-marker turn (spec D5) — so a turn that ages out
 *     of this list is still writable, it is simply no longer asked about.
 *
 * Ordered oldest-first: the backlog relief wants the oldest N, the
 * current-turn suffix wants the newest one, and both read off this one array
 * (spec D3) — there is exactly one query, not a display copy and a trigger
 * copy that could disagree.
 *
 * Bounded by `session_id, prompt_number` (the same index `turns` already
 * carries) and by the aging window; the two `NOT EXISTS` clauses are primary-
 * key lookups on `shadow_notes`/`note_debt`, one per candidate row, not a scan.
 */
export function listOwedNoteTurns(
  db: Database,
  sessionId: number,
  currentPromptNumber: number,
  options: ListOwedNoteTurnsOptions = {},
): OwedNoteTurn[] {
  const agingTurns = options.agingTurns ?? NOTE_DEBT_AGING_TURNS;

  return db
    .query<
      {
        turnId: number;
        sessionId: number;
        promptNumber: number;
        userPrompt: string | null;
      },
      [number, number, number]
    >(
      `SELECT
         t.id AS turnId,
         t.session_id AS sessionId,
         t.prompt_number AS promptNumber,
         t.user_prompt AS userPrompt
       FROM turns t
       WHERE t.session_id = ?
         AND t.prompt_number < ?
         AND t.prompt_number >= ?
         AND ${realPromptPredicate("t")}
         AND NOT EXISTS (
           SELECT 1 FROM shadow_notes n WHERE n.turn_id = t.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM note_debt d
           WHERE d.turn_id = t.id AND d.status = 'skipped'
         )
       ORDER BY t.prompt_number ASC`,
    )
    .all(sessionId, currentPromptNumber, currentPromptNumber - agingTurns)
    .map((row) => ({
      ...row,
      pendingTurns: currentPromptNumber - row.promptNumber,
    }));
}

export interface OwedNoteTurnInRange {
  turnId: number;
  sessionId: number;
  promptNumber: number;
}

/**
 * Settlement's "still owes a note" judgement (spec D7, ticket 05), bounded by
 * an explicit inclusive prompt-number range instead of the reminder's aging
 * window relative to "now". Read at DISPATCH time rather than at
 * window-freeze time, so a main-agent note written while the job sat queued
 * is already excluded by the `NOT EXISTS shadow_notes` clause below, the same
 * way it excludes a noted turn from the live reminder (裁決: 回写只填空缺).
 *
 * Deliberately NOT `listOwedNoteTurns`'s exact predicate — the two differ in
 * one place, and the difference is load-bearing: the live reminder treats ANY
 * `note_debt.status = 'skipped'` row as answered, but settlement's backfill
 * must still reconstruct a turn residual settlement wrote off with reason
 * `closed` (spec 裁決 20's interior/trailing-hole reconstruction, which this
 * ticket keeps — only the position-dependent "interior vs trailing" split and
 * the "no debt row is trivial" call are deleted, per D7's 用户裁定). `closed`
 * is the SYSTEM abandoning a dead session's ledger, not a value judgement
 * about the turn; only `declined` is the main agent's own real-time skip
 * (spec: "价值分流只属于主 agent 的实时 skip"), so only `declined` excludes a
 * turn here. A legacy `aged`/`rolled-back` reason (pre note-prompt-clock) is
 * read the same as `closed`: historical bookkeeping, not a judgement to defer to.
 */
export function listOwedNoteTurnsInRange(
  db: Database,
  sessionId: number,
  rangeStart: number,
  rangeEnd: number,
): OwedNoteTurnInRange[] {
  return db
    .query<OwedNoteTurnInRange, [number, number, number]>(
      `SELECT
         t.id AS turnId,
         t.session_id AS sessionId,
         t.prompt_number AS promptNumber
       FROM turns t
       WHERE t.session_id = ?
         AND t.prompt_number BETWEEN ? AND ?
         AND ${realPromptPredicate("t")}
         AND NOT EXISTS (
           SELECT 1 FROM shadow_notes n WHERE n.turn_id = t.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM note_debt d
           WHERE d.turn_id = t.id
             AND d.status = 'skipped'
             AND d.reason = 'declined'
         )
       ORDER BY t.prompt_number ASC`,
    )
    .all(sessionId, rangeStart, rangeEnd);
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
 * turn. Written by whoever does the rendering — `session-init` for the
 * current-turn line's owed suffix and the backlog relief block, settlement's
 * own context builder for its window — because only the renderer knows an id
 * actually reached the model. Read by `db/references.ts`'s citation gate: an
 * id a writer was never shown cannot be something it built on.
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
