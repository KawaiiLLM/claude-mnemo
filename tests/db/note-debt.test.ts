import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  claimNoteBacklogRelief,
  getExposedTurnIds,
  getNoteDebt,
  hasReminderForRideTurn,
  listNoteDebt,
  listOpenNoteDebt,
  recordNoteIdExposure,
  reconcileNoteDebt,
} from "../../src/db/note-debt";
import { initializeDatabase, initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { upsertShadowNote } from "../../src/db/shadow-notes";

describe("note debt ledger", () => {
  let db: Database;
  let sessionId: number;

  function addTurn(
    promptNumber: number,
    options: { prompt?: string; rolledBack?: boolean } = {},
  ): number {
    return db
      .query<{ id: number }, [number, number, string, number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt,
           was_rolled_back, created_at_epoch
         ) VALUES (?, ?, 'active', ?, ?, 100)
         RETURNING id`,
      )
      .get(
        sessionId,
        promptNumber,
        options.prompt ?? `prompt ${promptNumber}`,
        options.rolledBack ? 1 : 0,
      )!.id;
  }

  function addObservation(
    turnId: number,
    toolName: string,
    excluded = false,
  ): void {
    db.query(
      `INSERT INTO observations (
         turn_id, tool_name, excluded_from_extraction, created_at_epoch
       ) VALUES (?, ?, ?, 100)`,
    ).run(turnId, toolName, excluded ? 1 : 0);
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

  test("a turn with no tool call at all never enters the ledger", () => {
    const chat = addTurn(1);
    addTurn(2);

    reconcileNoteDebt(db, { sessionId, nowEpoch: 200 });

    expect(getNoteDebt(db, chat)).toBeNull();
    expect(listNoteDebt(db, sessionId)).toEqual([]);
  });

  // Both mount shapes, all four mnemo tools: memory housekeeping is not work,
  // so a turn that only recalled or only took a note owes nothing. Otherwise
  // writing a note would open the next debt (R2#P2-5).
  for (const toolName of [
    "mcp__mnemo__recall",
    "mcp__mnemo__remember",
    "mcp__mnemo__timeline",
    "mcp__mnemo__note",
    "mcp__plugin_claude-mnemo_mnemo__recall",
    "mcp__plugin_claude-mnemo_mnemo__note",
  ] as const) {
    test(`a turn whose only tool call is ${toolName} owes nothing`, () => {
      const turn = addTurn(1);
      addObservation(turn, toolName, toolName.endsWith("__note"));
      addTurn(2);

      reconcileNoteDebt(db, { sessionId, nowEpoch: 200 });

      expect(getNoteDebt(db, turn)).toBeNull();
    });
  }

  test("a turn with a substantive tool call owes a note once it ends", () => {
    const working = addTurn(1);
    addObservation(working, "Read");
    addObservation(working, "mcp__mnemo__recall");

    // Still the open turn: its batch is not final, so it is not classified yet.
    reconcileNoteDebt(db, { sessionId, nowEpoch: 200 });
    expect(getNoteDebt(db, working)).toBeNull();

    // The Stop event names the turn that just ended.
    reconcileNoteDebt(db, {
      sessionId,
      nowEpoch: 210,
      completedTurnId: working,
    });

    expect(getNoteDebt(db, working)).toMatchObject({
      turnId: working,
      promptNumber: 1,
      status: "pending",
      reason: null,
      openedAtEpoch: 210,
    });
  });

  test("the next prompt also completes the previous turn", () => {
    const working = addTurn(1);
    addObservation(working, "Edit");
    addTurn(2);

    reconcileNoteDebt(db, { sessionId, nowEpoch: 200 });

    expect(getNoteDebt(db, working)?.status).toBe("pending");
  });

  test("a note clears the debt, and the closure is idempotent", () => {
    const working = addTurn(1);
    addObservation(working, "Edit");
    addTurn(2);
    reconcileNoteDebt(db, { sessionId, nowEpoch: 200 });

    upsertShadowNote(db, {
      turnId: working,
      title: "implement+ledger: debt closes on note",
      content: "…",
      nowEpoch: 220,
    });
    const first = reconcileNoteDebt(db, { sessionId, nowEpoch: 230 });
    const second = reconcileNoteDebt(db, { sessionId, nowEpoch: 240 });

    expect(first.noted).toEqual([working]);
    expect(second.noted).toEqual([]);
    expect(getNoteDebt(db, working)).toMatchObject({
      status: "noted",
      reason: null,
      closedAtEpoch: 230,
    });
  });

  test("a turn noted before the ledger saw it never opens a debt", () => {
    const working = addTurn(1);
    addObservation(working, "Edit");
    upsertShadowNote(db, {
      turnId: working,
      title: "write+notes: pre-emptive note",
      content: "…",
      nowEpoch: 190,
    });
    addTurn(2);

    reconcileNoteDebt(db, { sessionId, nowEpoch: 200 });

    expect(getNoteDebt(db, working)).toBeNull();
  });

  test("a rolled-back debt closes only after it has been shown once", () => {
    const working = addTurn(1, { rolledBack: true });
    addObservation(working, "Edit");
    const rideTurn = addTurn(2);
    reconcileNoteDebt(db, { sessionId, nowEpoch: 200 });

    // Not yet announced: still pending, so the reminder can still show it.
    reconcileNoteDebt(db, { sessionId, nowEpoch: 210 });
    expect(getNoteDebt(db, working)?.status).toBe("pending");

    recordNoteIdExposure(db, {
      sessionId,
      rideTurnId: rideTurn,
      exposedTurnIds: [working],
      source: "reminder",
      nowEpoch: 215,
    });
    const result = reconcileNoteDebt(db, { sessionId, nowEpoch: 220 });

    expect(result.rolledBack).toEqual([working]);
    expect(getNoteDebt(db, working)).toMatchObject({
      status: "skipped",
      reason: "rolled-back",
    });
  });

  test("a debt past 50 turns ages out, and stops being readable first", () => {
    const working = addTurn(1);
    addObservation(working, "Edit");
    addTurn(2);
    reconcileNoteDebt(db, { sessionId, nowEpoch: 200 });

    for (let promptNumber = 3; promptNumber <= 52; promptNumber += 1) {
      addTurn(promptNumber);
    }

    // 51 turns later it is exactly at the bound: still shown, still pending.
    expect(
      listOpenNoteDebt(db, sessionId, { latestPromptNumber: 51 }).map(
        (debt) => debt.turnId,
      ),
    ).toEqual([working]);

    // One turn past it the reader drops it — the durable transition follows on
    // the next reconcile from the async side, with no scan in between.
    expect(
      listOpenNoteDebt(db, sessionId, { latestPromptNumber: 52 }),
    ).toEqual([]);
    expect(getNoteDebt(db, working)?.status).toBe("pending");

    const result = reconcileNoteDebt(db, { sessionId, nowEpoch: 300 });

    expect(result.aged).toEqual([working]);
    expect(getNoteDebt(db, working)).toMatchObject({
      status: "skipped",
      reason: "aged",
    });
  });

  test("opening the database runs no ledger scan", () => {
    const working = addTurn(1);
    addObservation(working, "Edit");
    addTurn(2);

    initializeDatabase(db);

    expect(listNoteDebt(db, sessionId)).toEqual([]);
  });

  test("classification never revisits a turn it already ruled on", () => {
    const chat = addTurn(1);
    addTurn(2);
    reconcileNoteDebt(db, { sessionId, nowEpoch: 200 });

    // A late observation on an already-classified turn does not reopen it: the
    // cursor is what keeps the sweep O(new turns) instead of O(session).
    addObservation(chat, "Edit");
    reconcileNoteDebt(db, { sessionId, nowEpoch: 210 });

    expect(getNoteDebt(db, chat)).toBeNull();
  });

  test("pending turns are counted from the session's current turn", () => {
    const first = addTurn(1);
    addObservation(first, "Edit");
    const second = addTurn(2);
    addObservation(second, "Bash");
    addTurn(3);
    reconcileNoteDebt(db, { sessionId, nowEpoch: 200 });

    expect(
      listOpenNoteDebt(db, sessionId, { latestPromptNumber: 3 }).map((debt) => [
        debt.promptNumber,
        debt.pendingTurns,
      ]),
    ).toEqual([
      [1, 2],
      [2, 1],
    ]);
  });

  test("the exposure ledger records reminder and injection ids alike", () => {
    const first = addTurn(1);
    const second = addTurn(2);
    const rideTurn = addTurn(3);

    recordNoteIdExposure(db, {
      sessionId,
      rideTurnId: rideTurn,
      exposedTurnIds: [first],
      source: "reminder",
      nowEpoch: 300,
    });
    recordNoteIdExposure(db, {
      sessionId,
      rideTurnId: rideTurn,
      exposedTurnIds: [second],
      source: "injection",
      nowEpoch: 300,
    });

    expect([...getExposedTurnIds(db, sessionId)].sort()).toEqual(
      [first, second].sort(),
    );
    expect([...getExposedTurnIds(db, sessionId, "reminder")]).toEqual([first]);
    expect(hasReminderForRideTurn(db, sessionId, rideTurn)).toBe(true);
    expect(hasReminderForRideTurn(db, sessionId, first)).toBe(false);
  });

  test("the relief claim refuses a second claim built on the same watermark", () => {
    // Two parallel UserPromptSubmit processes, each holding a different ride
    // turn because only one of them had its `session-init` sibling create the
    // newest turn row — but both computed eligibility from watermark 0. A claim
    // that merely took the maximum would let both through, the later ride turn
    // simply overwriting the earlier one, and the agent would be handed the
    // standing authorisation twice.
    const earlier = claimNoteBacklogRelief(db, {
      sessionId,
      firePromptNumber: 6,
      previousReliefPromptNumber: 0,
      nowEpoch: 500,
    });
    const later = claimNoteBacklogRelief(db, {
      sessionId,
      firePromptNumber: 7,
      previousReliefPromptNumber: 0,
      nowEpoch: 500,
    });

    expect([earlier, later]).toEqual([true, false]);
    expect(
      db
        .query<{ lastRelief: number }, [number]>(
          `SELECT last_relief_prompt_number AS lastRelief
           FROM note_debt_cursor WHERE session_id = ?`,
        )
        .get(sessionId)?.lastRelief,
    ).toBe(6);

    // A caller that did read the current watermark still claims, and the
    // watermark never moves backwards.
    expect(
      claimNoteBacklogRelief(db, {
        sessionId,
        firePromptNumber: 12,
        previousReliefPromptNumber: 6,
        nowEpoch: 600,
      }),
    ).toBe(true);
    expect(
      claimNoteBacklogRelief(db, {
        sessionId,
        firePromptNumber: 8,
        previousReliefPromptNumber: 12,
        nowEpoch: 600,
      }),
    ).toBe(false);
  });
});
