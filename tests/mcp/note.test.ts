import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { getNoteDebt, listOwedNoteTurns } from "../../src/db/note-debt";
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
  let followUpTurnId: number;
  let rideTurnId: number;

  /**
   * A `note_debt` row seeded directly, the way it was left by the retired
   * classification walk (note-prompt-clock ticket 03 deleted the walk itself,
   * not the table it wrote to). Several tests below exercise how a note or a
   * skip CLOSES an existing debt — that mechanism is unchanged, so its fixture
   * just has to produce the row the classifier used to produce.
   */
  function seedPendingDebt(turnId: number, promptNumber: number): void {
    db.query<unknown, [number, number, number, number, number]>(
      `INSERT INTO note_debt (
         turn_id, session_id, prompt_number, status, opened_at_epoch, updated_at_epoch
       ) VALUES (?, ?, ?, 'pending', ?, ?)`,
    ).run(turnId, sessionId, promptNumber, 150, 150);
  }

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
    followUpTurnId = insertTurn.get(sessionId, 333, "Follow-up", 130)!.id;
    rideTurnId = insertTurn.get(sessionId, 334, "Write it up", 140)!.id;

    // T332's writability no longer depends on this (spec D5: existence alone
    // suffices), but plenty of tests below exercise how a note or a skip
    // CLOSES a debt, so the fixture still seeds one — the way a real one would
    // exist on a database carrying pre-cutover history.
    seedPendingDebt(targetTurnId, 332);
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
    // Neither writer_model nor ride_turn is a tool parameter — the caller
    // cannot supply or forge it. type/tags ARE parameters (ticket 02, spec
    // B1/B2): the caller states them directly, no mechanical derivation.
    expect(Object.keys(noteInputSchema.shape)).toEqual([
      "turn",
      "title",
      "content",
      "insight",
      "type",
      "tags",
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
    const stored = [note.title, note.content, note.insight].join(" ");
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

  test("a zero-tool-call turn that never opened a debt is writable (T553/T562 class, spec D5/Problem 2)", () => {
    // T333 ("Follow-up") got no debt row seeded in the fixture, so it starts
    // with no `note_debt` row at all — exactly what D1's derived query
    // produces for a turn nobody has answered yet. Under the old debt-based
    // gate this read as "ineligible"; spec D5 collapses eligibility to
    // address resolution alone, and this address resolves — the turn
    // genuinely exists.
    const result = noteTool(
      db,
      { turn: `S${sessionId}/T333`, title: "t", content: "c" },
      { now: () => 900, env: {} },
    );

    expect(isNoteSuccess(result)).toBe(true);
    expect(getShadowNote(db, followUpTurnId)?.title).toBe("t");
  });

  test("an idle session's finished latest turn is writable — no debt required", () => {
    // The fixture's T334 is `extracted` with no debt row: exactly the shape
    // of every idle session's last turn, whose address any recall result can
    // hand out. The old code specifically carved this shape out as
    // ineligible (裁决 25's "current turn" required LIVE status, Codex review
    // P1-1); spec D5 retires that carve-out — every existing turn is writable
    // regardless of whether it is still live.
    const noted = noteTool(
      db,
      { turn: `S${sessionId}/T334`, title: "t", content: "c" },
      { now: () => 900, env: {} },
    );
    expect(isNoteSuccess(noted)).toBe(true);
    expect(getShadowNote(db, rideTurnId)?.title).toBe("t");
  });

  test("a zero-tool-call turn with no debt row is skippable too", () => {
    // Same shape as the writable test above (T333, no debt row) but
    // exercising the decline path — the "owes-nothing" rejection the old
    // debt-based gate produced here is gone; the born-closed decline is
    // recorded on the spot regardless of whether the turn is current or
    // trivial-and-finished.
    const skipped = noteTool(
      db,
      { turn: `S${sessionId}/T333`, skip: true },
      { now: () => 900, env: {} },
    );
    expect(resultText(skipped)).toContain("closed as declined");
    expect(getNoteDebt(db, followUpTurnId)).toMatchObject({
      status: "skipped",
      reason: "declined",
    });
  });

  test("an interrupted turn (status active, no Stop event, and not the session's latest turn) is writable", () => {
    // T333 is left `active` — no Stop event ever closed it — but the session
    // has already moved on to T334, so it is not even the session's current
    // turn either. Old code's current-turn admission only ever looked at the
    // LATEST turn by prompt_number, so an interrupted turn buried earlier in
    // history fell through every debtless admission and was rejected even
    // though it plainly exists.
    db.query("UPDATE turns SET status = 'active' WHERE id = ?").run(
      followUpTurnId,
    );

    const result = noteTool(
      db,
      { turn: `S${sessionId}/T333`, title: "t", content: "c" },
      { now: () => 900, env: {} },
    );

    expect(isNoteSuccess(result)).toBe(true);
    expect(getShadowNote(db, followUpTurnId)?.title).toBe("t");
  });

  test("the session's current turn is writable before its debt exists", () => {
    // 裁决 25: the note is written during the turn it describes, and nothing
    // opens a debt ahead of time any more. Spec D5 makes this the ordinary
    // case rather than a special-cased carve-out — the turn simply exists,
    // live or not — but it remains true and worth pinning.
    db.query("UPDATE turns SET status = 'active' WHERE id = ?").run(rideTurnId);
    const result = noteTool(
      db,
      { turn: `S${sessionId}/T334`, title: "t", content: "c" },
      { now: () => 900, env: {} },
    );

    expect(isNoteSuccess(result)).toBe(true);
    expect(getShadowNote(db, rideTurnId)?.rideTurnId).toBe(rideTurnId);
    // No debt row was ever opened for it (nothing pre-empts one any more), so
    // `closeNoteDebtAsNoted` inside the write above had nothing to close.
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

  test("a note succeeds even though its debt already closed as aged — the ledger's history does not gate eligibility (spec D5)", () => {
    // Previously the sole path back from a written-off debt: the ledger's
    // historical judgement no longer has any say over whether a NOTE may be
    // written — only over what a SKIP records (see the skip 已结算 tests
    // below, which keep the aged/rolled-back/closed reasons terminal for
    // declines). The turn still exists, so it is still writable.
    db.query(
      `UPDATE note_debt SET status = 'skipped', reason = 'aged' WHERE turn_id = ?`,
    ).run(targetTurnId);

    const result = noteTool(
      db,
      { turn: `S${sessionId}/T332`, title: "t", content: "c" },
      { now: () => 900, env: {} },
    );

    expect(isNoteSuccess(result)).toBe(true);
    expect(getShadowNote(db, targetTurnId)?.title).toBe("t");
  });

  test("a closed debt still permits rewriting the note it closed", () => {
    noteTool(
      db,
      { turn: `S${sessionId}/T332`, title: "first", content: "c" },
      { now: () => 900, env: {} },
    );
    // The write itself closes the debt on the spot (closeNoteDebtAsNoted runs
    // inside noteTool's own transaction) — there is no separate reconcile
    // step left to run.
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

  // Peer review item 3 on ticket 02 (spec B6): the migration
  // (stripRetiredTopicTagNamespace) stripped every EXISTING `topic:`-prefixed
  // tag once; nothing at the write boundary stopped a caller from writing the
  // prefix straight back in until this check landed.
  test("rejects a topic:-prefixed tag with a readable parameter error, and stores nothing (spec B6)", () => {
    const result = noteTool(
      db,
      {
        turn: `S${sessionId}/T332`,
        title: "measure+note-routing: fallback share 32%→4%",
        content: "Deferred writing wins; the subagent fallback is dropped.",
        tags: ["topic:routing"],
      },
      { now: () => 900, env: {} },
    );

    expect(resultText(result)).toStartWith("Parameter error:");
    expect(resultText(result)).toContain("topic:routing");
    expect(resultText(result)).toContain("retired");
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

    // Closed synchronously with the write, not left to any later pass — a
    // session whose last act is the note would otherwise report that debt as
    // open forever, since nothing is left to run that could close it.
    expect(getNoteDebt(db, targetTurnId)).toMatchObject({
      status: "noted",
      reason: null,
      closedAtEpoch: 900,
    });
  });

  test("a note written past the aging bound still closes the debt as noted", () => {
    // The session runs on well past the 50-turn bound. The owed suffix
    // stopped naming this debt long ago — that bound governs how long a debt
    // keeps getting asked about, not whether a late answer counts.
    const insertTurn = db.query<{ id: number }, [number, number, string, number]>(
      `INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch)
       VALUES (?, ?, 'extracted', ?, ?) RETURNING id`,
    );
    for (let promptNumber = 335; promptNumber <= 400; promptNumber += 1) {
      insertTurn.get(sessionId, promptNumber, "later work", 200);
    }

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
      closedAtEpoch: 900,
    });
  });

  describe("compact markers (spec D2/D5)", () => {
    let markerTurnId: number;

    beforeEach(() => {
      markerTurnId = db
        .query<{ id: number }, [number]>(
          `INSERT INTO turns (
             session_id, prompt_number, status, title, type, created_at_epoch
           ) VALUES (?, 336, 'extracted', '/compact', '["compact"]', 200)
           RETURNING id`,
        )
        .get(sessionId)!.id;
    });

    test("a note against a compact marker is rejected, and states the fact", () => {
      const result = noteTool(
        db,
        { turn: `S${sessionId}/T336`, title: "t", content: "c" },
        { now: () => 900, env: {} },
      );

      expect(resultText(result)).toStartWith("Parameter error:");
      expect(resultText(result)).toContain("compact marker");
      expect(isNoteSuccess(result)).toBe(false);
      expect(getShadowNote(db, markerTurnId)).toBeNull();
    });

    test("a skip against a compact marker is rejected the same way", () => {
      const result = noteTool(
        db,
        { turn: `S${sessionId}/T336`, skip: true },
        { now: () => 900, env: {} },
      );

      expect(resultText(result)).toStartWith("Parameter error:");
      expect(resultText(result)).toContain("compact marker");
      expect(getNoteDebt(db, markerTurnId)).toBeNull();
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

    test("a declined turn leaves the owed set, an undeclined one stays on it", () => {
      // The point of the explicit skip: an unwritable turn — its material gone
      // with a compact — stops occupying one of the relief window's five
      // oldest-debt slots instead of sitting open until the 50-turn bound.
      // T333 has no debt row of its own but is still a real, un-answered
      // turn, so D1's derived query owes it too.
      expect(
        listOwedNoteTurns(db, sessionId, 334).map((turn) => turn.promptNumber),
      ).toEqual([332, 333]);

      noteTool(
        db,
        { turn: `S${sessionId}/T332`, skip: true },
        { now: () => 900, env: {} },
      );

      expect(
        listOwedNoteTurns(db, sessionId, 334).map((turn) => turn.promptNumber),
      ).toEqual([333]);
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

    test("skipping a nonexistent or malformed turn is still a parameter error", () => {
      // Note the absence of a "trivial, no debt" case here (spec D5): a
      // debtless turn is now the ordinary case a skip answers — see "a
      // zero-tool-call turn with no debt row is skippable too" above — not a
      // rejection. Only an address that fails to resolve at all stays an
      // error.
      const unknown = noteTool(
        db,
        { turn: `S${sessionId}/T999`, skip: true },
        { now: () => 900, env: {} },
      );
      const malformed = noteTool(db, { turn: "T332", skip: true }, {});

      for (const result of [unknown, malformed]) {
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
