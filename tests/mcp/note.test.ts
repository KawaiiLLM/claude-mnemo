import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  getNoteDebt,
  listOpenNoteDebt,
  reconcileNoteDebt,
} from "../../src/db/note-debt";
import { initializeSchema } from "../../src/db/schema";
import { getShadowNote } from "../../src/db/shadow-notes";
import { upsertSession } from "../../src/db/sessions";
import { noteInputSchema } from "../../src/mcp/definitions";
import { isNoteSuccess, noteTool } from "../../src/mcp/note";

function resultText(result: { content: Array<{ text: string }> }): string {
  return result.content[0]!.text;
}

/**
 * Byte-level snapshot of a turns row: every column, in schema order, as stored.
 * The P1 isolation claim is not "status is unchanged" but "nothing is changed",
 * so the assertion has to be over the whole row rather than a chosen subset.
 */
function snapshotTurnRow(db: Database, turnId: number): string {
  const row = db
    .query<Record<string, unknown>, [number]>("SELECT * FROM turns WHERE id = ?")
    .get(turnId);
  return JSON.stringify(row);
}

describe("note tool", () => {
  let db: Database;
  let sessionId: number;
  let targetTurnId: number;
  let rideTurnId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    sessionId = upsertSession(db, {
      contentSessionId: "note-session",
      project: "claude-mnemo",
      title: "Note session",
      content: "Initial session summary",
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 110,
      completedAtEpoch: null,
    }).id;

    // Prompt 332 is the turn being noted; 334 is where the session is now, so
    // the ride turn is genuinely different from the noted turn.
    const insertTurn = db.query<{ id: number }, [number, number, string, number]>(
      `INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch)
       VALUES (?, ?, 'extracted', ?, ?) RETURNING id`,
    );
    targetTurnId = insertTurn.get(sessionId, 332, "Measure note routing", 120)!.id;
    insertTurn.get(sessionId, 333, "Follow-up", 130);
    rideTurnId = insertTurn.get(sessionId, 334, "Write it up", 140)!.id;

    // A note is only writable against an open debt (ticket 03), so the fixture
    // has to produce one the way the system does: a finished turn with a
    // substantive tool call.
    db.query(
      `INSERT INTO observations (turn_id, tool_name, excluded_from_extraction, created_at_epoch)
       VALUES (?, 'Edit', 0, 120)`,
    ).run(targetTurnId);
    reconcileNoteDebt(db, { sessionId, nowEpoch: 150 });
    expect(getNoteDebt(db, targetTurnId)?.status).toBe("pending");
  });

  afterEach(() => {
    db.close();
  });

  test("writes a shadow row addressed by S<session>/T<prompt>", () => {
    const result = noteTool(
      db,
      {
        turn: `S${sessionId}/T332`,
        title: "measure+note-routing: fallback share 32%→4%",
        content: "Deferred writing wins; the subagent fallback is dropped.",
        insight: "Reminders must carry the id, not the count.",
      },
      { now: () => 900, env: { CLAUDE_MNEMO_WRITER_MODEL: "claude-opus-5" } },
    );

    expect(isNoteSuccess(result)).toBe(true);

    const note = getShadowNote(db, targetTurnId);
    expect(note).toEqual({
      turnId: targetTurnId,
      title: "measure+note-routing: fallback share 32%→4%",
      content: "Deferred writing wins; the subagent fallback is dropped.",
      insight: "Reminders must carry the id, not the count.",
      writerModel: "claude-opus-5",
      // The `note` tool is the agent's own channel; only P2 settlement writes
      // anything else here.
      writerOrigin: "agent",
      rideTurnId,
      createdAtEpoch: 900,
      updatedAtEpoch: 900,
    });
  });

  test("records writer_model and ride_turn mechanically, and says so when the model is unavailable", () => {
    const result = noteTool(
      db,
      {
        turn: `S${sessionId}/T332`,
        title: "implement+note: shadow store",
        content: "Shadow row only.",
      },
      { now: () => 900, env: {} },
    );

    const note = getShadowNote(db, targetTurnId)!;
    // Neither field is a tool parameter — the caller cannot supply or forge it.
    expect(Object.keys(noteInputSchema.shape)).toEqual([
      "turn",
      "title",
      "content",
      "insight",
      "skip",
      "replace",
      "crossSession",
    ]);
    expect(note.rideTurnId).toBe(rideTurnId);
    expect(note.writerModel).toBeNull();
    expect(resultText(result)).toContain(`ride_turn: S${sessionId}/T334`);
    expect(resultText(result)).toContain("writer_model: not recorded");
  });

  test("rejects a repeat write that does not declare replace (spec D3)", () => {
    noteTool(
      db,
      { turn: `S${sessionId}/T332`, title: "first", content: "c" },
      { now: () => 900, env: {} },
    );

    const second = noteTool(
      db,
      { turn: `S${sessionId}/T332`, title: "second", content: "c2" },
      { now: () => 1000, env: {} },
    );

    expect(resultText(second)).toStartWith("Parameter error:");
    expect(resultText(second)).toContain("already has a note");
    expect(resultText(second)).toContain("replace: true");
    expect(isNoteSuccess(second)).toBe(false);
    // Untouched — the rejected call must not have clobbered the first note.
    expect(getShadowNote(db, targetTurnId)?.title).toBe("first");
  });

  test("a first write's receipt starts \"Noted \", not \"Updated \"", () => {
    const result = noteTool(
      db,
      { turn: `S${sessionId}/T332`, title: "t", content: "c" },
      { now: () => 900, env: {} },
    );

    expect(resultText(result)).toStartWith("Noted ");
    expect(resultText(result)).not.toContain("replaced the previous note");
  });

  test("a successful write reports its own size against the budget", () => {
    // The budget is stated to the agent once, at session start. Stated and
    // never measured, it was ignored: sixteen consecutive notes on S15069 ran
    // 1.5x-2.5x over. The receipt is the only feedback that arrives in time to
    // change the next note.
    const overBudget = noteTool(
      db,
      {
        turn: `S${sessionId}/T332`,
        title: "t",
        content: "c".repeat(800),
      },
      { now: () => 900, env: {} },
    );

    expect(resultText(overBudget)).toContain("budget: title 1/20");
    expect(resultText(overBudget)).toContain("content 200/100");
    expect(resultText(overBudget)).toContain("→ 201/120 (1.7×).");
    // An absent insight is the documented default, not an underspend: it is
    // left out of the line and out of the denominator.
    expect(resultText(overBudget)).not.toContain("insight");
  });

  test("an insight is measured too, and only when one was written", () => {
    const result = noteTool(
      db,
      {
        turn: `S${sessionId}/T332`,
        title: "t",
        content: "c",
        insight: "i".repeat(120),
      },
      { now: () => 900, env: {} },
    );

    expect(resultText(result)).toContain("insight 30/60");
    expect(resultText(result)).toContain("→ 32/180");
  });

  test("a decline has nothing to measure and says nothing about the budget", () => {
    const result = noteTool(
      db,
      { turn: `S${sessionId}/T332`, skip: true },
      { now: () => 900, env: {} },
    );

    expect(resultText(result)).not.toContain("budget:");
  });

  test("a repeat write for the same turn overwrites, keeping only the latest", () => {
    noteTool(
      db,
      {
        turn: `S${sessionId}/T332`,
        title: "first title",
        content: "first content",
        insight: "first insight",
      },
      { now: () => 900, env: {} },
    );

    const second = noteTool(
      db,
      {
        turn: `S${sessionId}/T332`,
        title: "second title",
        content: "second content",
        replace: true,
      },
      { now: () => 1200, env: {} },
    );

    expect(isNoteSuccess(second)).toBe(true);
    expect(resultText(second)).toStartWith("Updated ");
    expect(resultText(second)).toContain("replaced the previous note");

    const rows = db
      .query<{ count: number }, [number]>(
        "SELECT COUNT(*) AS count FROM shadow_notes WHERE turn_id = ?",
      )
      .get(targetTurnId)!;
    expect(rows.count).toBe(1);

    const note = getShadowNote(db, targetTurnId)!;
    expect(note.title).toBe("second title");
    expect(note.content).toBe("second content");
    // Cleared, not left stale — a rewrite replaces the whole note.
    expect(note.insight).toBeNull();
    // First-noted time survives; the rewrite time moves.
    expect(note.createdAtEpoch).toBe(900);
    expect(note.updatedAtEpoch).toBe(1200);
  });

  test("leaves the noted turn's row byte-identical, status included", () => {
    const before = snapshotTurnRow(db, targetTurnId);
    const rideBefore = snapshotTurnRow(db, rideTurnId);

    noteTool(
      db,
      {
        turn: `S${sessionId}/T332`,
        title: "implement+note: shadow isolation",
        content: "Never touch turns.",
        insight: "P1 keeps the two summary sources independent.",
      },
      { now: () => 900, env: {} },
    );
    noteTool(
      db,
      {
        turn: `S${sessionId}/T332`,
        title: "implement+note: rewritten",
        content: "Still never touch turns.",
        replace: true,
      },
      { now: () => 1200, env: {} },
    );

    expect(snapshotTurnRow(db, targetTurnId)).toBe(before);
    expect(snapshotTurnRow(db, rideTurnId)).toBe(rideBefore);
    expect(getShadowNote(db, targetTurnId)?.title).toBe(
      "implement+note: rewritten",
    );
  });

  test("strips private-tagged content from every field before storing", () => {
    const result = noteTool(
      db,
      {
        turn: `S${sessionId}/T332`,
        title: "fix+privacy: <private>token abc</private>strip at the boundary",
        content:
          "Kept text. <private>API key sk-live-123</private>More kept text.",
        insight: "<private>personal note</private>Strip runs on the write path.",
      },
      { now: () => 900, env: {} },
    );

    const note = getShadowNote(db, targetTurnId)!;
    const stored = `${note.title} ${note.content} ${note.insight}`;
    expect(stored).not.toContain("token abc");
    expect(stored).not.toContain("sk-live-123");
    expect(stored).not.toContain("personal note");
    expect(stored).not.toContain("<private>");
    expect(note.title).toBe("fix+privacy: strip at the boundary");
    expect(note.content).toBe("Kept text. More kept text.");
    expect(note.insight).toBe("Strip runs on the write path.");
    expect(resultText(result)).toContain("Private-tagged content was removed");
  });

  test("rejects a malformed or unresolvable turn address", () => {
    const cases: Array<[string, string]> = [
      ["T332", "malformed: bare relative id"],
      [`S${sessionId}-T332`, "malformed: wrong separator"],
      ["", "malformed: empty"],
      [`S${sessionId}/T999`, "unresolvable: no such prompt in this session"],
      ["S999999/T332", "unresolvable: no such session"],
    ];

    for (const [turn, label] of cases) {
      const result = noteTool(
        db,
        { turn, title: "t", content: "c" },
        { now: () => 900, env: {} },
      );
      expect(resultText(result), label).toStartWith("Parameter error:");
      expect(isNoteSuccess(result)).toBe(false);
    }

    expect(
      db.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM shadow_notes",
      ).get()!.count,
    ).toBe(0);
  });

  test("rejects a turn that owes no note, including another session's", () => {
    const otherSessionId = upsertSession(db, {
      contentSessionId: "other-session",
      project: "claude-mnemo",
      title: "Someone else's session",
      content: null,
      insight: null,
      createdAtEpoch: 50,
      updatedAtEpoch: 60,
      completedAtEpoch: null,
    }).id;
    const insertTurn = db.query<{ id: number }, [number, number, string, number]>(
      `INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch)
       VALUES (?, ?, 'extracted', ?, ?) RETURNING id`,
    );
    const foreignTurnId = insertTurn.get(otherSessionId, 332, "Their work", 60)!.id;
    const foreignRideTurnId = insertTurn.get(otherSessionId, 333, "Their next turn", 70)!.id;

    // Same prompt number as this session's target: the exact shape of a
    // mistyped or borrowed address.
    const foreign = noteTool(
      db,
      { turn: `S${otherSessionId}/T332`, title: "t", content: "c" },
      { now: () => 900, env: {} },
    );
    // And a turn of this session that was classified trivial.
    const undebted = noteTool(
      db,
      { turn: `S${sessionId}/T333`, title: "t", content: "c" },
      { now: () => 900, env: {} },
    );

    expect(resultText(foreign)).toStartWith("Parameter error:");
    expect(resultText(foreign)).toContain("owes no note");
    expect(resultText(undebted)).toStartWith("Parameter error:");
    expect(getShadowNote(db, foreignTurnId)).toBeNull();
    expect(
      db.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM shadow_notes",
      ).get()!.count,
    ).toBe(0);
    // The rejection is what keeps ride_turn honest: had the write gone through,
    // the note would have been attributed to the OTHER session's newest turn.
    expect(foreignRideTurnId).not.toBe(rideTurnId);
  });

  test("the session's current turn is writable before its debt exists", () => {
    // 裁决 25: the note is written during the turn it describes, and the debt
    // only opens at classification after the turn ends. The latest turn is the
    // address the current-turn line hands out — and it is admitted debtless
    // only while it is still LIVE, which is when the protocol writes.
    db.query("UPDATE turns SET status = 'active' WHERE id = ?").run(rideTurnId);
    const result = noteTool(
      db,
      { turn: `S${sessionId}/T334`, title: "t", content: "c" },
      { now: () => 900, env: {} },
    );

    expect(isNoteSuccess(result)).toBe(true);
    expect(getShadowNote(db, rideTurnId)?.rideTurnId).toBe(rideTurnId);

    // Classification later finds the note and opens nothing.
    db.query(
      `INSERT INTO observations (turn_id, tool_name, excluded_from_extraction, created_at_epoch)
       VALUES (?, 'Edit', 0, 910)`,
    ).run(rideTurnId);
    db.query<{ id: number }, [number, number, string, number]>(
      `INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch)
       VALUES (?, ?, 'extracted', ?, ?) RETURNING id`,
    ).get(sessionId, 335, "Next", 920);
    const reconciled = reconcileNoteDebt(db, { sessionId, nowEpoch: 930 });
    expect(reconciled.opened).toEqual([]);
    expect(getNoteDebt(db, rideTurnId)).toBeNull();
  });

  test("skip:true on the current turn records a born-closed decline", () => {
    db.query("UPDATE turns SET status = 'active' WHERE id = ?").run(rideTurnId);
    const result = noteTool(
      db,
      { turn: `S${sessionId}/T334`, skip: true },
      { now: () => 900, env: {} },
    );

    expect(resultText(result)).toContain("closed as declined");
    expect(getNoteDebt(db, rideTurnId)).toMatchObject({
      status: "skipped",
      reason: "declined",
    });

    // And classification later respects the refusal instead of re-opening.
    db.query(
      `INSERT INTO observations (turn_id, tool_name, excluded_from_extraction, created_at_epoch)
       VALUES (?, 'Edit', 0, 910)`,
    ).run(rideTurnId);
    db.query<{ id: number }, [number, number, string, number]>(
      `INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch)
       VALUES (?, ?, 'extracted', ?, ?) RETURNING id`,
    ).get(sessionId, 335, "Next", 920);
    const reconciled = reconcileNoteDebt(db, { sessionId, nowEpoch: 930 });
    expect(reconciled.opened).toEqual([]);
    expect(getNoteDebt(db, rideTurnId)).toMatchObject({
      status: "skipped",
      reason: "declined",
    });
  });

  test("a finished latest turn is not \"current\" — idle sessions stay closed to borrowing", () => {
    // The fixture's T334 is `extracted`: exactly the shape of every idle
    // session's last turn, whose address any recall result can hand out.
    // Debtless admission must not apply to it (Codex review P1-1).
    const finished = noteTool(
      db,
      { turn: `S${sessionId}/T334`, title: "t", content: "c" },
      { now: () => 900, env: {} },
    );
    expect(resultText(finished)).toStartWith("Parameter error:");
    expect(resultText(finished)).toContain("owes no note");

    const finishedSkip = noteTool(
      db,
      { turn: `S${sessionId}/T334`, skip: true },
      { now: () => 900, env: {} },
    );
    expect(resultText(finishedSkip)).toStartWith("Parameter error:");
  });

  test("a sidechain row does not steal the current-turn position", () => {
    // A Task subagent's prompt inserts a row above the root turn for the whole
    // delegation window (born `undone` since 裁决 25). The root turn's own
    // note, written at the end of the batch that ran the subagent, must still
    // be admitted — and ride attribution must point at the root turn, not the
    // sidechain row (Codex review P1-2).
    db.query("UPDATE turns SET status = 'active' WHERE id = ?").run(rideTurnId);
    const sidechainId = db
      .query<{ id: number }, [number]>(
        `INSERT INTO turns (session_id, prompt_number, status, tags, user_prompt, created_at_epoch)
         VALUES (?, 335, 'undone', '["subagent:pending"]', 'delegated work', 150)
         RETURNING id`,
      )
      .get(sessionId)!.id;

    const result = noteTool(
      db,
      { turn: `S${sessionId}/T334`, title: "t", content: "c" },
      { now: () => 900, env: {} },
    );

    expect(isNoteSuccess(result)).toBe(true);
    const note = getShadowNote(db, rideTurnId);
    expect(note?.rideTurnId).toBe(rideTurnId);
    expect(note?.rideTurnId).not.toBe(sidechainId);
  });

  test("rejects a debt that has already been written off", () => {
    db.query(
      `UPDATE note_debt SET status = 'skipped', reason = 'aged' WHERE turn_id = ?`,
    ).run(targetTurnId);

    const result = noteTool(
      db,
      { turn: `S${sessionId}/T332`, title: "t", content: "c" },
      { now: () => 900, env: {} },
    );

    expect(resultText(result)).toContain("its debt closed as aged");
    expect(getShadowNote(db, targetTurnId)).toBeNull();
  });

  test("a debt closed by a concurrent reconcile between the fast-path read and the write transaction is honoured, not overwritten", () => {
    // The fast-path read above the transaction sees the debt still pending —
    // that is what lets this call proceed at all. The hook-side reconcile
    // (another process) closes it for real only once the write transaction
    // has begun, which this simulates by mutating the ledger row from inside
    // the injected `runWriteTransaction`, exactly the window the fast path
    // cannot see into. The authorising re-check lives inside the transaction,
    // so it must pick up this new state rather than the stale pending read.
    const result = noteTool(
      db,
      { turn: `S${sessionId}/T332`, title: "t", content: "c" },
      {
        now: () => 900,
        env: {},
        runWriteTransaction: (database, fn) => {
          db.query(
            `UPDATE note_debt SET status = 'skipped', reason = 'aged',
               closed_at_epoch = 500, updated_at_epoch = 500 WHERE turn_id = ?`,
          ).run(targetTurnId);
          return fn();
        },
      },
    );

    expect(isNoteSuccess(result)).toBe(false);
    expect(resultText(result)).toContain("its debt closed as aged");
    // Not just rejected — nothing was written, and the ledger keeps the state
    // the concurrent process actually committed, not the stale pending state
    // the fast-path read observed.
    expect(getShadowNote(db, targetTurnId)).toBeNull();
    expect(getNoteDebt(db, targetTurnId)?.status).toBe("skipped");
  });

  test("a closed debt still permits rewriting the note it closed", () => {
    noteTool(
      db,
      { turn: `S${sessionId}/T332`, title: "first", content: "c" },
      { now: () => 900, env: {} },
    );
    // The asynchronous side closes the debt once the note exists.
    reconcileNoteDebt(db, { sessionId, nowEpoch: 950 });
    expect(getNoteDebt(db, targetTurnId)?.status).toBe("noted");

    const rewrite = noteTool(
      db,
      {
        turn: `S${sessionId}/T332`,
        title: "corrected",
        content: "c",
        replace: true,
      },
      { now: () => 1000, env: {} },
    );

    expect(isNoteSuccess(rewrite)).toBe(true);
    expect(getShadowNote(db, targetTurnId)?.title).toBe("corrected");
  });

  test("rejects a missing or empty title/content", () => {
    for (const input of [
      { turn: `S${sessionId}/T332`, content: "c" },
      { turn: `S${sessionId}/T332`, title: "t" },
      { turn: `S${sessionId}/T332`, title: "   ", content: "c" },
      { turn: `S${sessionId}/T332`, title: "t", content: "" },
    ]) {
      const result = noteTool(db, input, { now: () => 900, env: {} });
      expect(resultText(result)).toStartWith("Parameter error:");
    }

    expect(getShadowNote(db, targetTurnId)).toBeNull();
  });

  test("a successful note closes its debt on the spot", () => {
    noteTool(
      db,
      {
        turn: `S${sessionId}/T332`,
        title: "implement+ledger: the write closes the account",
        content: "…",
      },
      { now: () => 900, env: {} },
    );

    // Not left to the next reconcile: a session whose last act is the note would
    // otherwise report that debt as open forever, because nothing is left to run
    // that could close it.
    expect(getNoteDebt(db, targetTurnId)).toMatchObject({
      status: "noted",
      reason: null,
      closedAtEpoch: 900,
    });
  });

  test("a note written past the aging bound still closes the debt as noted", () => {
    // The session runs on well past the 50-turn bound. The reminder stopped
    // rendering this debt long ago — that bound governs how long a debt keeps
    // asking, not whether a late answer counts — and the durable row is still
    // `pending` because lazy aging only filters on read.
    const insertTurn = db.query<{ id: number }, [number, number, string, number]>(
      `INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch)
       VALUES (?, ?, 'extracted', ?, ?) RETURNING id`,
    );
    for (let promptNumber = 335; promptNumber <= 400; promptNumber += 1) {
      insertTurn.get(sessionId, promptNumber, "later work", 200);
    }
    expect(getNoteDebt(db, targetTurnId)?.status).toBe("pending");

    const result = noteTool(
      db,
      {
        turn: `S${sessionId}/T332`,
        title: "write+late-note: better late than aged",
        content: "…",
      },
      { now: () => 900, env: {} },
    );

    expect(isNoteSuccess(result)).toBe(true);
    expect(getNoteDebt(db, targetTurnId)).toMatchObject({
      status: "noted",
      reason: null,
    });

    // And a later reconcile — which is where `aged` is written — must not
    // reclassify a debt that was answered.
    reconcileNoteDebt(db, { sessionId, nowEpoch: 1_000 });
    expect(getNoteDebt(db, targetTurnId)).toMatchObject({
      status: "noted",
      reason: null,
      closedAtEpoch: 900,
    });
  });

  describe("skip (裁决 24)", () => {
    test("closes the debt as declined with turn alone, writing no note", () => {
      const result = noteTool(
        db,
        { turn: `S${sessionId}/T332`, skip: true },
        { now: () => 900, env: {} },
      );

      // A refusal is a successful CALL but not a note, so it must not read as
      // one — nothing downstream should count it as material.
      expect(isNoteSuccess(result)).toBe(false);
      expect(resultText(result)).toStartWith(`Skipped S${sessionId}/T332.`);
      expect(getShadowNote(db, targetTurnId)).toBeNull();
      expect(getNoteDebt(db, targetTurnId)).toMatchObject({
        status: "skipped",
        reason: "declined",
        closedAtEpoch: 900,
      });
    });

    test("a declined debt leaves the reminder and relief selections", () => {
      // The point of the explicit skip: an unwritable turn — its material gone
      // with a compact — stops occupying one of the relief window's five
      // oldest-debt slots instead of sitting open until the 50-turn bound.
      expect(
        listOpenNoteDebt(db, sessionId, { latestPromptNumber: 334 }).map(
          (debt) => debt.promptNumber,
        ),
      ).toEqual([332]);

      noteTool(
        db,
        { turn: `S${sessionId}/T332`, skip: true },
        { now: () => 900, env: {} },
      );

      expect(
        listOpenNoteDebt(db, sessionId, { latestPromptNumber: 334 }),
      ).toEqual([]);
    });

    test("a real note after a skip is accepted and replaces the refusal", () => {
      noteTool(
        db,
        { turn: `S${sessionId}/T332`, skip: true },
        { now: () => 900, env: {} },
      );

      const late = noteTool(
        db,
        {
          turn: `S${sessionId}/T332`,
          title: "write+late-note: the material came back",
          content: "…",
        },
        { now: () => 1000, env: {} },
      );

      // Declining is the agent's own judgement about its own turn, so it is the
      // one closed state a note may reopen. `aged`/`rolled-back`/`closed` are
      // the system's judgements and stay terminal.
      expect(isNoteSuccess(late)).toBe(true);
      expect(getShadowNote(db, targetTurnId)?.title).toBe(
        "write+late-note: the material came back",
      );
      expect(getNoteDebt(db, targetTurnId)).toMatchObject({
        status: "noted",
        reason: null,
        closedAtEpoch: 1000,
      });
    });

    test("a skip for an already-noted turn changes nothing", () => {
      noteTool(
        db,
        { turn: `S${sessionId}/T332`, title: "kept", content: "c" },
        { now: () => 900, env: {} },
      );

      const skipped = noteTool(
        db,
        { turn: `S${sessionId}/T332`, skip: true },
        { now: () => 1000, env: {} },
      );

      expect(resultText(skipped)).toContain("already has a note");
      expect(getShadowNote(db, targetTurnId)?.title).toBe("kept");
      expect(getNoteDebt(db, targetTurnId)).toMatchObject({
        status: "noted",
        reason: null,
      });
    });

    test("a skip for a debt written off elsewhere is a no-op, not an error", () => {
      db.query(
        "UPDATE note_debt SET status = 'skipped', reason = 'aged' WHERE turn_id = ?",
      ).run(targetTurnId);

      const result = noteTool(
        db,
        { turn: `S${sessionId}/T332`, skip: true },
        { now: () => 900, env: {} },
      );

      // The agent is answering a line it was shown; a debt the system closed in
      // the meantime is not a caller mistake.
      expect(resultText(result)).not.toStartWith("Parameter error:");
      expect(resultText(result)).toContain("already closed as aged");
      expect(getNoteDebt(db, targetTurnId)?.reason).toBe("aged");
    });

    test("skipping a foreign or trivial turn is still a parameter error", () => {
      const undebted = noteTool(
        db,
        { turn: `S${sessionId}/T333`, skip: true },
        { now: () => 900, env: {} },
      );
      const unknown = noteTool(
        db,
        { turn: `S${sessionId}/T999`, skip: true },
        { now: () => 900, env: {} },
      );
      const malformed = noteTool(db, { turn: "T332", skip: true }, {});

      // An open debt is the only evidence an MCP server has that the address
      // belongs to the caller, so a skip needs it exactly as a note does.
      for (const result of [undebted, unknown, malformed]) {
        expect(resultText(result)).toStartWith("Parameter error:");
      }
    });

    test("skip:false is an ordinary note, and a non-boolean skip is rejected", () => {
      const written = noteTool(
        db,
        {
          turn: `S${sessionId}/T332`,
          title: "implement+skip: false means write it",
          content: "…",
          skip: false,
        },
        { now: () => 900, env: {} },
      );
      const malformed = noteTool(
        db,
        { turn: `S${sessionId}/T332`, skip: "yes" },
        { now: () => 900, env: {} },
      );

      expect(isNoteSuccess(written)).toBe(true);
      expect(resultText(malformed)).toBe(
        "Parameter error: skip must be a boolean when present.",
      );
    });

    test("the schema accepts a skip with no title or content", () => {
      expect(
        noteInputSchema.safeParse({ turn: "S1/T1", skip: true }).success,
      ).toBe(true);
      // And still rejects an unknown field: the shape stayed strict.
      expect(
        noteInputSchema.safeParse({ turn: "S1/T1", reason: "no material" })
          .success,
      ).toBe(false);
    });
  });

  test("never indexes shadow notes into the shared search index", () => {
    noteTool(
      db,
      {
        turn: `S${sessionId}/T332`,
        title: "measure+isolation: distinctivephrase",
        content: "distinctivephrase must not be searchable during P1.",
      },
      { now: () => 900, env: {} },
    );

    const hits = db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM memory_fts WHERE memory_fts MATCH 'distinctivephrase'",
      )
      .get()!;
    expect(hits.count).toBe(0);
  });

  describe("caller identity and the cross-session guard (spec D2/D4)", () => {
    let otherSessionId: number;
    let otherTurnId: number;

    beforeEach(() => {
      otherSessionId = upsertSession(db, {
        contentSessionId: "other-identity-session",
        project: "claude-mnemo",
        title: "A different caller's session",
        content: null,
        insight: null,
        createdAtEpoch: 50,
        updatedAtEpoch: 60,
        completedAtEpoch: null,
      }).id;
      // Its own current turn, so the address is legitimately writable —
      // ONLY the identity of who is calling makes this a cross-session write.
      otherTurnId = db
        .query<{ id: number }, [number]>(
          `INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch)
           VALUES (?, 1, 'active', 'Their own current turn', 50) RETURNING id`,
        )
        .get(otherSessionId)!.id;
    });

    test("unknown caller identity permits a write that would otherwise be cross-session", () => {
      // No `callerSessionId` in options at all — the default for every
      // channel except the MCP direct-execution entry point (spec D2).
      const result = noteTool(
        db,
        { turn: `S${otherSessionId}/T1`, title: "t", content: "c" },
        { now: () => 900, env: {} },
      );

      expect(isNoteSuccess(result)).toBe(true);
      expect(getShadowNote(db, otherTurnId)).not.toBeNull();
    });

    test("known identity blocks an undeclared cross-session write", () => {
      const result = noteTool(
        db,
        { turn: `S${otherSessionId}/T1`, title: "t", content: "c" },
        { now: () => 900, env: {}, callerSessionId: sessionId },
      );

      expect(resultText(result)).toStartWith("Parameter error:");
      expect(resultText(result)).toContain("different session");
      expect(resultText(result)).toContain("crossSession: true");
      expect(getShadowNote(db, otherTurnId)).toBeNull();
    });

    test("crossSession: true permits the declared cross-session write", () => {
      const result = noteTool(
        db,
        {
          turn: `S${otherSessionId}/T1`,
          title: "t",
          content: "c",
          crossSession: true,
        },
        { now: () => 900, env: {}, callerSessionId: sessionId },
      );

      expect(isNoteSuccess(result)).toBe(true);
      expect(getShadowNote(db, otherTurnId)).not.toBeNull();
    });

    test("known identity matching the address's own session needs no declaration", () => {
      const result = noteTool(
        db,
        { turn: `S${otherSessionId}/T1`, title: "t", content: "c" },
        { now: () => 900, env: {}, callerSessionId: otherSessionId },
      );

      expect(isNoteSuccess(result)).toBe(true);
    });

    test("the cross-session guard also covers skip:true", () => {
      const blocked = noteTool(
        db,
        { turn: `S${otherSessionId}/T1`, skip: true },
        { now: () => 900, env: {}, callerSessionId: sessionId },
      );
      expect(resultText(blocked)).toStartWith("Parameter error:");
      expect(resultText(blocked)).toContain("crossSession: true");

      const declared = noteTool(
        db,
        { turn: `S${otherSessionId}/T1`, skip: true, crossSession: true },
        { now: () => 900, env: {}, callerSessionId: sessionId },
      );
      expect(resultText(declared)).toContain("closed as declined");
    });
  });
});
