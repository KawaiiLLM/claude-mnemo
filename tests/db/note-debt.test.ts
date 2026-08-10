import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  claimNoteBacklogRelief,
  getExposedTurnIds,
  getNoteDebt,
  listNoteDebt,
  listOpenNoteDebt,
  recordDeclinedNoteDebt,
  recordNoteIdExposure,
  reconcileNoteDebt,
} from "../../src/db/note-debt";
import { getDecidedPrefixEnd } from "../../src/db/note-settlement";
import { initializeDatabase, initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { upsertShadowNote } from "../../src/db/shadow-notes";

describe("note debt ledger", () => {
  let db: Database;
  let sessionId: number;

  /**
   * A turn whose Stop the hook captured — the ordinary case, and what every
   * test here means by "a turn that ended". The turn row itself stays `active`
   * because extraction is a later, separate pipeline; the queued `turn-stop` is
   * mnemo's own record that the turn's tool batch is closed, and the sweep will
   * not classify a turn without it (a turn with neither that nor a terminal
   * status is STRANDED, not finished).
   */
  function addTurn(
    promptNumber: number,
    options: {
      prompt?: string;
      rolledBack?: boolean;
      /** Model a turn whose Stop was never captured. */
      stranded?: boolean;
    } = {},
  ): number {
    const turnId = db
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
    if (!options.stranded) {
      db.query<unknown, [number, number]>(
        `INSERT INTO pending_queue (kind, target_id, session_db_id, enqueued_at_epoch)
         VALUES ('turn-stop', ?, ?, 100)`,
      ).run(turnId, sessionId);
    }
    return turnId;
  }

  function getClassificationCursor(): number {
    return (
      db
        .query<{ cursor: number }, [number]>(
          `SELECT last_classified_prompt_number AS cursor
           FROM note_debt_cursor WHERE session_id = ?`,
        )
        .get(sessionId)?.cursor ?? 0
    );
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

  test("a rolled-back debt closes silently at reconcile", () => {
    // It used to wait for a reminder to show its notice once (user story 5);
    // 裁决 25 retired that channel, so the close needs no exposure and the
    // timeline's rollback fold is the notice.
    const working = addTurn(1, { rolledBack: true });
    addObservation(working, "Edit");
    addTurn(2);

    const result = reconcileNoteDebt(db, { sessionId, nowEpoch: 200 });

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

  /**
   * The sweep's premise is that a classified turn's tool batch is FINAL, and a
   * turn whose Stop mnemo never captured is still nominally open — more
   * observations can land against it at any time. Classifying it on what has
   * arrived so far reads zero tool calls as "owed nothing", which is
   * indistinguishable from a genuinely trivial turn, and the watermark then
   * walks over it. That is not a delay a later pass corrects: settlement cuts
   * frozen windows from this watermark, so the misreading becomes a window that
   * can never be recut.
   */
  test("a stranded turn blocks the watermark instead of being read as trivial", () => {
    // Trivial by design: no observations, so they are decided by absence.
    for (let promptNumber = 1; promptNumber <= 9; promptNumber += 1) {
      addTurn(promptNumber);
    }
    // Turn 10's Stop never reached mnemo, so nothing has closed its batch.
    const stranded = addTurn(10, { stranded: true });
    const later = addTurn(11);

    const blocked = reconcileNoteDebt(db, {
      sessionId,
      nowEpoch: 300,
      completedTurnId: later,
    });

    expect(getNoteDebt(db, stranded)).toBeNull();
    // Turn 11 is finished, but the prefix is contiguous: it waits behind 10.
    expect(getNoteDebt(db, later)).toBeNull();
    expect(blocked.classifiedThroughPromptNumber).toBe(9);
    expect(getClassificationCursor()).toBe(9);
    // The settlement consequence, which is why this matters at all: no window
    // can be cut over turn 10 while its outcome is unknown.
    expect(getDecidedPrefixEnd(db, sessionId, 1)).toBe(9);

    // Proof the batch was not final: a tool call for turn 10 lands late. Had
    // the sweep classified it above, this work would already have been written
    // off as a turn that owed nothing.
    addObservation(stranded, "Edit");
    // The liveness repair (ticket 10) re-enqueues the missing turn-stop.
    db.query<unknown, [number, number]>(
      `INSERT INTO pending_queue (kind, target_id, session_db_id, enqueued_at_epoch)
       VALUES ('turn-stop', ?, ?, 310)`,
    ).run(stranded, sessionId);

    const resumed = reconcileNoteDebt(db, {
      sessionId,
      nowEpoch: 320,
      completedTurnId: later,
    });

    expect(resumed.opened).toEqual([stranded]);
    expect(getNoteDebt(db, stranded)?.status).toBe("pending");
    expect(resumed.classifiedThroughPromptNumber).toBe(11);
    // Now the debt itself — a real, writable one — is what holds the window.
    expect(getDecidedPrefixEnd(db, sessionId, 1)).toBe(9);

    upsertShadowNote(db, {
      turnId: stranded,
      title: "repair+ledger: the late note lands",
      content: "…",
      nowEpoch: 330,
    });
    reconcileNoteDebt(db, { sessionId, nowEpoch: 340 });
    expect(getDecidedPrefixEnd(db, sessionId, 1)).toBe(11);
  });

  test("a gap in prompt numbers does not wedge the watermark", () => {
    addObservation(addTurn(1), "Edit");
    // Prompt 2 never existed — a cleaned subagent turn leaves exactly this.
    addObservation(addTurn(3), "Edit");
    const latest = addTurn(4);

    const result = reconcileNoteDebt(db, {
      sessionId,
      nowEpoch: 300,
      completedTurnId: latest,
    });

    expect(result.classifiedThroughPromptNumber).toBe(4);
    expect(getClassificationCursor()).toBe(4);
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
  });

  test("a current turn may be declined before its debt exists", () => {
    // 裁决 25: the current turn's debt only opens at classification, after the
    // turn ends, so the decline is recorded as a born-closed row — and the
    // later classification finds it and opens nothing.
    const current = addTurn(1);
    addObservation(current, "Edit");

    expect(
      recordDeclinedNoteDebt(
        db,
        { id: current, sessionId, promptNumber: 1 },
        150,
      ),
    ).toBe(true);
    expect(getNoteDebt(db, current)).toMatchObject({
      status: "skipped",
      reason: "declined",
    });

    addTurn(2);
    const result = reconcileNoteDebt(db, { sessionId, nowEpoch: 200 });
    expect(result.opened).toEqual([]);
    expect(getNoteDebt(db, current)).toMatchObject({
      status: "skipped",
      reason: "declined",
    });

    // A pending row already claimed by classification is left authoritative.
    expect(
      recordDeclinedNoteDebt(
        db,
        { id: current, sessionId, promptNumber: 1 },
        250,
      ),
    ).toBe(false);
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
