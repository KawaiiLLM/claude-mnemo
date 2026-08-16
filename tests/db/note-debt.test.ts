import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  closeNoteDebtAsDeclined,
  closeNoteDebtAsNoted,
  getNoteDebt,
  listNoteDebt,
  listOwedNoteTurns,
  listOwedNoteTurnsInRange,
  NOTE_DEBT_AGING_TURNS,
  recordDeclinedNoteDebt,
} from "../../src/db/note-debt";
import {
  initializeDatabase,
  initializeSchema,
  retireLegacyPendingNoteDebts,
} from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { upsertShadowNote } from "../../src/db/shadow-notes";

/**
 * The prompt-clock ledger (note-prompt-clock spec, D1/D8): the owed set is a
 * derived query over `turns`/`shadow_notes`/`note_debt`, not a classification
 * walk. `note_debt` itself survives only as a table of recorded answers
 * (declined / closed) — nothing here opens a `pending` row any more.
 */
describe("listOwedNoteTurns (spec D1)", () => {
  let db: Database;
  let sessionId: number;

  function addTurn(
    promptNumber: number,
    options: {
      prompt?: string;
      status?: string;
      rolledBack?: boolean;
      type?: string;
    } = {},
  ): number {
    return db
      .query<{ id: number }, [number, number, string, string, number, string]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt,
           was_rolled_back, created_at_epoch, type
         ) VALUES (?, ?, ?, ?, ?, 100, ?)
         RETURNING id`,
      )
      .get(
        sessionId,
        promptNumber,
        options.status ?? "active",
        options.prompt ?? `prompt ${promptNumber}`,
        options.rolledBack ? 1 : 0,
        options.type ? JSON.stringify([options.type]) : "[]",
      )!.id;
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "session-note-debt",
      project: "/tmp/project",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("a turn ends the moment a later prompt exists — no Stop, no tool count required", () => {
    // A zero-tool-call, never-Stopped turn (T553/T562 class, spec Problem 2):
    // the prompt clock alone decides it is over.
    const turn = addTurn(1);
    addTurn(2);

    expect(listOwedNoteTurns(db, sessionId, 2).map((t) => t.turnId)).toEqual([
      turn,
    ]);
  });

  test("the current (still-open) turn never owes itself", () => {
    addTurn(1);
    const current = 2;

    // Nothing after turn 1 exists yet, so only turn 1 can be owed and the
    // query is asked as if turn `current` had just been created.
    const owed = listOwedNoteTurns(db, sessionId, current);
    expect(owed.map((t) => t.promptNumber)).toEqual([1]);
    expect(owed[0]!.pendingTurns).toBe(1);
  });

  test("a real note removes the turn from the owed set", () => {
    const noted = addTurn(1);
    addTurn(2);
    upsertShadowNote(db, {
      turnId: noted,
      title: "implement+ledger: notes answer the derived query",
      content: "…",
      nowEpoch: 200,
    });

    expect(listOwedNoteTurns(db, sessionId, 2)).toEqual([]);
  });

  test("a decline (any reason) removes the turn from the owed set", () => {
    for (const reason of ["declined", "aged", "rolled-back", "closed"] as const) {
      const turn = addTurn(1);
      db.query<unknown, [number, number, number, string, string, number, number]>(
        `INSERT INTO note_debt (
           turn_id, session_id, prompt_number, status, reason,
           opened_at_epoch, updated_at_epoch
         ) VALUES (?, ?, ?, 'skipped', ?, 100, 100)`,
      ).run(turn, sessionId, 1, reason);
      addTurn(2);

      expect(
        listOwedNoteTurns(db, sessionId, 2).map((t) => t.turnId),
        `reason=${reason}`,
      ).toEqual([]);

      // Clean up for the next iteration in this loop.
      db.query("DELETE FROM turns WHERE session_id = ?").run(sessionId);
      db.query("DELETE FROM note_debt WHERE session_id = ?").run(sessionId);
    }
  });

  test("a leftover pending note_debt row is not an answer — the turn still owes", () => {
    // 06 migrates stale pre-cutover pending rows; this ticket only guarantees
    // nothing new depends on them. Until that migration runs, a leftover
    // `pending` row must not be read as a suppressed debt.
    const turn = addTurn(1);
    db.query<unknown, [number, number, number]>(
      `INSERT INTO note_debt (
         turn_id, session_id, prompt_number, status,
         opened_at_epoch, updated_at_epoch
       ) VALUES (?, ?, ?, 'pending', 100, 100)`,
    ).run(turn, sessionId, 1);
    addTurn(2);

    expect(listOwedNoteTurns(db, sessionId, 2).map((t) => t.turnId)).toEqual([
      turn,
    ]);
  });

  test("a sidechain (undone) turn never owes", () => {
    addTurn(1, { status: "undone" });
    addTurn(2);

    expect(listOwedNoteTurns(db, sessionId, 2)).toEqual([]);
  });

  test("a rolled-back turn never owes", () => {
    addTurn(1, { rolledBack: true });
    addTurn(2);

    expect(listOwedNoteTurns(db, sessionId, 2)).toEqual([]);
  });

  test("a compact marker row never owes", () => {
    // The mechanical row hooks/capture-repair.ts leaves at a PreCompact
    // boundary (spec D2's one mechanical row in the session).
    addTurn(1, { type: "compact", prompt: "/compact" });
    addTurn(2);

    expect(listOwedNoteTurns(db, sessionId, 2)).toEqual([]);
  });

  test("a skill-triggering slash-command turn is a real prompt and owes like any other", () => {
    // spec D2: mechanical-command detection does not exist. The only
    // mechanical row is the compact marker (type = 'compact') tested above;
    // everything else that reaches UserPromptSubmit is a real turn.
    const turn = addTurn(1, { prompt: "/markdown-writing polish this doc" });
    addTurn(2);

    expect(listOwedNoteTurns(db, sessionId, 2).map((t) => t.turnId)).toEqual([
      turn,
    ]);
  });

  test("stays inside the 50-turn reminder window; outside it the turn is simply not listed", () => {
    const working = addTurn(1);
    // Every turn between the one under test and the boundary must be
    // answered, or it would owe a note of its own and swamp the assertion —
    // D1 has no tool-call gate any more, so an un-answered turn always owes.
    for (let promptNumber = 2; promptNumber <= 52; promptNumber += 1) {
      const turnId = addTurn(promptNumber);
      upsertShadowNote(db, {
        turnId,
        title: `write+filler: turn ${promptNumber}`,
        content: "…",
        nowEpoch: 100,
      });
    }

    // Exactly at the bound (51 turns later): still shown.
    expect(
      listOwedNoteTurns(db, sessionId, 51).map((t) => t.turnId),
    ).toEqual([working]);
    // One turn past it: no longer listed.
    expect(listOwedNoteTurns(db, sessionId, 52)).toEqual([]);
  });

  test("the aging window is configurable and defaults to NOTE_DEBT_AGING_TURNS", () => {
    expect(NOTE_DEBT_AGING_TURNS).toBe(50);
    const working = addTurn(1);
    addTurn(2);

    expect(
      listOwedNoteTurns(db, sessionId, 2, { agingTurns: 0 }).map((t) => t.turnId),
    ).toEqual([]);
    expect(
      listOwedNoteTurns(db, sessionId, 2, { agingTurns: 1 }).map((t) => t.turnId),
    ).toEqual([working]);
  });

  test("ordered oldest-first, with pendingTurns measured from the current prompt", () => {
    addTurn(1);
    addTurn(2);
    addTurn(3);

    expect(
      listOwedNoteTurns(db, sessionId, 3).map((t) => [t.promptNumber, t.pendingTurns]),
    ).toEqual([
      [1, 2],
      [2, 1],
    ]);
  });

  test("a turn from a different session never appears", () => {
    const otherSessionId = upsertSession(db, {
      contentSessionId: "session-note-debt-other",
      project: "/tmp/project",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
    db.query<unknown, [number, number, string]>(
      `INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch)
       VALUES (?, 1, 'active', 'their own turn', 100)`,
    ).run(otherSessionId);
    addTurn(1);
    addTurn(2);

    expect(
      listOwedNoteTurns(db, sessionId, 2).every((t) => t.sessionId === sessionId),
    ).toBe(true);
  });

  test("switching to the derived query does not revive turns already outside the historical window (spec D9)", () => {
    // A session with 200 turns of history, none ever written, cutting over to
    // the new query mid-session: only the newest 50 are ever asked about.
    for (let promptNumber = 1; promptNumber <= 199; promptNumber += 1) {
      addTurn(promptNumber);
    }
    addTurn(200);

    const owed = listOwedNoteTurns(db, sessionId, 200);
    expect(owed).toHaveLength(50);
    expect(owed[0]!.promptNumber).toBe(150);
    expect(owed[owed.length - 1]!.promptNumber).toBe(199);
  });
});

/**
 * Ticket 06's D8 investigation: does writing off a leftover `pending` row as
 * `skipped(closed)` make settlement's backfill (`listOwedNoteTurnsInRange`,
 * ticket 05) suddenly treat a dead session's history as due for
 * reconstruction? The predicate excludes a turn only on
 * `reason = 'declined'` (note-debt.ts) — `pending` was never excluded either,
 * so retiring a row to `closed` changes nothing about which turns settlement
 * still considers unanswered. This pins that finding directly rather than
 * only in the ticket's report.
 */
describe("listOwedNoteTurnsInRange is unaffected by D8's pending retirement", () => {
  let db: Database;
  let sessionId: number;

  function addTurn(promptNumber: number): number {
    return db
      .query<{ id: number }, [number, number, string]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt, created_at_epoch
         ) VALUES (?, ?, 'active', ?, 100)
         RETURNING id`,
      )
      .get(sessionId, promptNumber, `prompt ${promptNumber}`)!.id;
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "session-note-debt-range-retirement",
      project: "/tmp/project",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("a leftover pending row is owed, and stays owed once retired to closed", () => {
    const turn = addTurn(1);
    db.query<unknown, [number, number, number]>(
      `INSERT INTO note_debt (
         turn_id, session_id, prompt_number, status,
         opened_at_epoch, updated_at_epoch
       ) VALUES (?, ?, ?, 'pending', 100, 100)`,
    ).run(turn, sessionId, 1);

    expect(
      listOwedNoteTurnsInRange(db, sessionId, 1, 1).map((t) => t.turnId),
    ).toEqual([turn]);

    // The migration's own write, exactly as `initializeSchema` applies it.
    expect(retireLegacyPendingNoteDebts(db)).toBe(1);

    expect(
      listOwedNoteTurnsInRange(db, sessionId, 1, 1).map((t) => t.turnId),
    ).toEqual([turn]);
  });

  test("only a declined reason excludes — aged/rolled-back/closed all stay owed", () => {
    for (const reason of ["aged", "rolled-back", "closed"] as const) {
      const turn = addTurn(1);
      db.query<unknown, [number, number, number, string]>(
        `INSERT INTO note_debt (
           turn_id, session_id, prompt_number, status, reason,
           opened_at_epoch, updated_at_epoch
         ) VALUES (?, ?, ?, 'skipped', ?, 100, 100)`,
      ).run(turn, sessionId, 1, reason);

      expect(
        listOwedNoteTurnsInRange(db, sessionId, 1, 1).map((t) => t.turnId),
        `reason=${reason}`,
      ).toEqual([turn]);

      db.query("DELETE FROM turns WHERE session_id = ?").run(sessionId);
      db.query("DELETE FROM note_debt WHERE session_id = ?").run(sessionId);
    }

    const declinedTurn = addTurn(1);
    db.query<unknown, [number, number, number]>(
      `INSERT INTO note_debt (
         turn_id, session_id, prompt_number, status, reason,
         opened_at_epoch, updated_at_epoch
       ) VALUES (?, ?, ?, 'skipped', 'declined', 100, 100)`,
    ).run(declinedTurn, sessionId, 1);

    expect(listOwedNoteTurnsInRange(db, sessionId, 1, 1)).toEqual([]);
  });
});

describe("note-debt recorded-answer writers", () => {
  let db: Database;
  let sessionId: number;
  let turnId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "session-note-debt-writers",
      project: "/tmp/project",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
    turnId = db
      .query<{ id: number }, [number]>(
        `INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch)
         VALUES (?, 1, 'active', 'prompt', 100) RETURNING id`,
      )
      .get(sessionId)!.id;
  });

  afterEach(() => {
    db.close();
  });

  test("recordDeclinedNoteDebt records a born-closed decline and getNoteDebt reads it", () => {
    expect(
      recordDeclinedNoteDebt(db, { id: turnId, sessionId, promptNumber: 1 }, 150),
    ).toBe(true);

    expect(getNoteDebt(db, turnId)).toMatchObject({
      status: "skipped",
      reason: "declined",
    });
    expect(listNoteDebt(db, sessionId)).toHaveLength(1);
  });

  test("recordDeclinedNoteDebt is a no-op once a row already exists", () => {
    recordDeclinedNoteDebt(db, { id: turnId, sessionId, promptNumber: 1 }, 150);

    expect(
      recordDeclinedNoteDebt(db, { id: turnId, sessionId, promptNumber: 1 }, 250),
    ).toBe(false);
  });

  test("closeNoteDebtAsDeclined closes an existing pending row", () => {
    db.query<unknown, [number, number, number]>(
      `INSERT INTO note_debt (turn_id, session_id, prompt_number, status, opened_at_epoch, updated_at_epoch)
       VALUES (?, ?, 1, 'pending', 100, 100)`,
    ).run(turnId, sessionId);

    expect(closeNoteDebtAsDeclined(db, turnId, 200)).toBe(true);
    expect(getNoteDebt(db, turnId)).toMatchObject({
      status: "skipped",
      reason: "declined",
      closedAtEpoch: 200,
    });
  });

  test("closeNoteDebtAsNoted reverses a decline, and only a decline", () => {
    recordDeclinedNoteDebt(db, { id: turnId, sessionId, promptNumber: 1 }, 150);

    expect(closeNoteDebtAsNoted(db, turnId, 300)).toBe(true);
    expect(getNoteDebt(db, turnId)).toMatchObject({ status: "noted", reason: null });

    // Terminal now: a second decline attempt does not reopen it.
    expect(closeNoteDebtAsDeclined(db, turnId, 400)).toBe(false);
    expect(getNoteDebt(db, turnId)?.status).toBe("noted");
  });

  test("closeNoteDebtAsNoted on a turn with no debt row at all is a harmless no-op", () => {
    // The ordinary shape now: nothing opens a debt ahead of time.
    expect(closeNoteDebtAsNoted(db, turnId, 300)).toBe(false);
    expect(getNoteDebt(db, turnId)).toBeNull();
  });

  test("opening the database runs no ledger scan", () => {
    initializeDatabase(db);

    expect(listNoteDebt(db, sessionId)).toEqual([]);
  });
});

describe("note id exposure ledger", () => {
  let db: Database;
  let sessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "session-note-debt-exposure",
      project: "/tmp/project",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

});
