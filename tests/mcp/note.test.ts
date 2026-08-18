import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { getOutgoingEdges, writeMemoryEdges } from "../../src/db/memory-edges";
import { getNoteDebt, listOwedNoteTurns } from "../../src/db/note-debt";
import { initializeSchema } from "../../src/db/schema";
import { createSegment } from "../../src/db/segments";
import { getShadowNote } from "../../src/db/shadow-notes";
import { getSession, upsertSession } from "../../src/db/sessions";
import { getTurnById } from "../../src/db/turns";
import { noteInputSchema } from "../../src/mcp/definitions";
import { createDatabaseBackedHandlers } from "../../src/mcp/handlers";
import { isNoteSuccess, noteTool } from "../../src/mcp/note";
import { registerMainMcpTools } from "../../src/mcp/server";

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
    // ticket 03 merged `remember`'s addressing and the `mode` vocabulary in;
    // `replace`/`regrade`/`status`/`cites` are gone (spec D5a, E1). ticket 01
    // (ADR-0003) removed `grade`. ticket 09 (edge-ownership-impl) retired
    // `session` from this schema outright — `turn` is the only address left.
    expect(Object.keys(noteInputSchema.shape)).toEqual([
      "turn",
      "title",
      "content",
      "insight",
      "type",
      "tags",
      "skip",
      "crossSession",
      "evidenceFor",
      "evidenceAgainst",
      "groundedOn",
      "refines",
      "override",
      "encodes",
      "dependsOn",
      "mode",
    ]);
    expect(note.rideTurnId).toBe(rideTurnId);
    expect(note.writerModel).toBeNull();
    expect(resultText(result)).toContain(`ride_turn: S${sessionId}/T334`);
    expect(resultText(result)).toContain("writer_model: not recorded");
  });

  test("rejects a repeat write that does not declare a mode (spec D5/D5a)", () => {
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
    expect(resultText(second)).toContain("title is not empty");
    expect(resultText(second)).toContain('mode.title');
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

  // ticket 01 (spec "Note contract revision"): budgets gain teeth at 2×. Below
  // that line, over-budget is advisory only — the tests above already pin
  // that (content 800 chars = 200 tok, exactly 2× its 100 tok budget, still
  // lands). These pin the far side: past 2×, the write is refused outright.
  describe("turn budget teeth at 2× (ticket 01)", () => {
    test("title over 2x its budget is rejected, naming the field, its count and its budget; nothing stored", () => {
      const result = noteTool(
        db,
        {
          turn: `S${sessionId}/T332`,
          title: "x".repeat(164), // 41 tok, one over the 40 tok (2x of 20) line
          content: "c",
        },
        { now: () => 900, env: {} },
      );

      expect(resultText(result)).toStartWith("Parameter error:");
      expect(resultText(result)).toContain("title");
      expect(resultText(result)).toContain("41 tok");
      expect(resultText(result)).toContain("20 tok");
      expect(resultText(result)).toContain("nothing stored");
      // The whole call rolled back — content did not land either, even
      // though content alone was well within its own budget.
      expect(getShadowNote(db, targetTurnId)).toBeNull();
    });

    test("content over 2x its budget is rejected on a rewrite, and the prior note survives untouched", () => {
      noteTool(
        db,
        { turn: `S${sessionId}/T332`, title: "first", content: "first content" },
        { now: () => 900, env: {} },
      );

      const result = noteTool(
        db,
        {
          turn: `S${sessionId}/T332`,
          content: "x".repeat(804), // 201 tok, one over the 200 tok (2x of 100) line
          mode: { content: "overwrite" },
        },
        { now: () => 1000, env: {} },
      );

      expect(resultText(result)).toStartWith("Parameter error:");
      expect(resultText(result)).toContain("content");
      expect(resultText(result)).toContain("201 tok");
      expect(resultText(result)).toContain("100 tok");
      // The rejected rewrite left the earlier note exactly as it was.
      expect(getShadowNote(db, targetTurnId)?.content).toBe("first content");
    });

    test("insight over 2x its budget is rejected; title/content in the same call do not land either", () => {
      const result = noteTool(
        db,
        {
          turn: `S${sessionId}/T332`,
          title: "t",
          content: "c",
          insight: "x".repeat(484), // 121 tok, one over the 120 tok (2x of 60) line
        },
        { now: () => 900, env: {} },
      );

      expect(resultText(result)).toStartWith("Parameter error:");
      expect(resultText(result)).toContain("insight");
      expect(resultText(result)).toContain("121 tok");
      expect(resultText(result)).toContain("60 tok");
      // Atomic: title/content in the SAME call did not land either.
      expect(getShadowNote(db, targetTurnId)).toBeNull();
    });

    // A design decision this suite pins deliberately: the check runs only
    // against a field THIS call resolves, not one merely inherited for
    // stripping/bracketing purposes. Without this, a pre-existing over-budget
    // field (legacy data written before budget teeth existed) would block
    // every future edit to any OTHER field on the same note forever.
    test("an inherited over-2x field (pre-existing, untouched by this call) does not block a sibling field's fresh write", () => {
      noteTool(
        db,
        { turn: `S${sessionId}/T332`, title: "t", content: "c" },
        { now: () => 900, env: {} },
      );
      // Simulate legacy data written before budget teeth existed — raw SQL,
      // bypassing noteTool's own gate entirely.
      db.query("UPDATE shadow_notes SET content = ? WHERE turn_id = ?").run(
        "x".repeat(4000), // 1000 tok, wildly over 2x
        targetTurnId,
      );

      const result = noteTool(
        db,
        { turn: `S${sessionId}/T332`, insight: "a fresh, well-sized insight" },
        { now: () => 1000, env: {} },
      );

      expect(isNoteSuccess(result)).toBe(true);
      expect(getShadowNote(db, targetTurnId)?.insight).toBe(
        "a fresh, well-sized insight",
      );
    });
  });

  test("a repeat write for the same turn overwrites the fields it names, leaving the rest alone", () => {
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
        mode: { title: "overwrite", content: "overwrite" },
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
    // Omitted, not cleared (spec D5a: omission is never a claim) — the
    // second call never named insight, so the first call's value survives.
    expect(note.insight).toBe("first insight");
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
        mode: { title: "overwrite", content: "overwrite" },
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
        mode: { title: "overwrite", content: "overwrite" },
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

// Spec C6: a bare `[S<session>/T<n>]` in an era-promoted note's title,
// content or insight creates the pair — no relation, no separate structured
// input. Era-promoted only: a legacy-era note never touches `turns`
// (P1 isolation), so there is no new body state for `memory_edges` to agree
// with (see noteTool's promotesTurnRecord branch).
describe("note tool citations (spec C6)", () => {
  let db: Database;
  let sessionId: number;
  let targetTurnId: number;
  let citedTurnId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    sessionId = upsertSession(db, {
      contentSessionId: "note-cites-session",
      project: "claude-mnemo",
      title: "Note citations",
      content: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 110,
      completedAtEpoch: null,
    }).id;

    const insertTurn = db.query<{ id: number }, [number, number, string, number]>(
      `INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch)
       VALUES (?, ?, 'extracted', ?, ?) RETURNING id`,
    );
    citedTurnId = insertTurn.get(sessionId, 1, "Earlier work", 100)!.id;
    targetTurnId = insertTurn.get(sessionId, 2, "The turn being noted", 110)!.id;
  });

  afterEach(() => {
    db.close();
  });

  // Acceptance criterion 1: a bare `[S/T]` in a note body creates an
  // unattributed pair.
  test("a bare qualified reference in content creates an unattributed pair", () => {

    const result = noteTool(
      db,
      {
        turn: `S${sessionId}/T2`,
        title: "design+routing: reverses an earlier call",
        content: `Reverses [S${sessionId}/T1].`,
      },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );

    expect(isNoteSuccess(result)).toBe(true);
    expect(
      getOutgoingEdges(db, { kind: "turn", id: targetTurnId }),
    ).toEqual([
      {
        citing: { kind: "turn", id: targetTurnId },
        cited: { kind: "turn", id: citedTurnId },
        relation: null,
        provenance: "text-ref",
        createdAtEpoch: 900,
      },
    ]);
  });

  test("a rewrite (mode: overwrite) that drops a reference drops its pair and any relation it carried", () => {
    noteTool(
      db,
      {
        turn: `S${sessionId}/T2`,
        title: "design+routing: first pass",
        content: `Cites [S${sessionId}/T1].`,
      },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: targetTurnId },
          cited: { kind: "turn", id: citedTurnId },
          relation: "supersedes",
          provenance: "judged",
        },
      ],
      950,
      { eligibleForRelation: "unrestricted" },
    );

    noteTool(
      db,
      {
        turn: `S${sessionId}/T2`,
        title: "design+routing: revised, no longer citing T1",
        content: "Stands on its own now.",
        mode: { title: "overwrite", content: "overwrite" },
      },
      { now: () => 1000, env: {}, eraCutoffEpoch: 1 },
    );

    expect(getOutgoingEdges(db, { kind: "turn", id: targetTurnId })).toEqual([]);
  });
});

describe("note tool relation attach (spec C1/C5/C7, ticket 07; phase gate ticket 01)", () => {
  let db: Database;
  let sessionId: number;
  let earlierTurnId: number;
  let anotherEarlierTurnId: number;
  let targetTurnId: number;

  // Ticket 01 (turn-edge-mechanism spec): every relation is now phase-gated,
  // so a fixture turn needs an explicit `type` matching the phase the test is
  // exercising — the default (no type at all) carries NO phase and would be
  // rejected by the phase gate before ever reaching the checks these tests
  // actually target.
  function setType(turnId: number, types: readonly string[]): void {
    db.query<unknown, [string, number]>("UPDATE turns SET type = ? WHERE id = ?").run(
      JSON.stringify(types),
      turnId,
    );
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    sessionId = upsertSession(db, {
      contentSessionId: "note-relations-session",
      project: "claude-mnemo",
      title: "Note relations",
      content: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 110,
      completedAtEpoch: null,
    }).id;

    const insertTurn = db.query<{ id: number }, [number, number, string, number]>(
      `INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch)
       VALUES (?, ?, 'extracted', ?, ?) RETURNING id`,
    );
    earlierTurnId = insertTurn.get(sessionId, 1, "First earlier turn", 100)!.id;
    anotherEarlierTurnId = insertTurn.get(sessionId, 2, "Second earlier turn", 105)!.id;
    targetTurnId = insertTurn.get(sessionId, 3, "The turn being noted", 110)!.id;
  });

  afterEach(() => {
    db.close();
  });

  // Requirement 4: the main agent may attach a relation to a pair its own
  // write is creating — it authored the prose in the same call. `override`
  // replaces the retired `supersedes` for this "reverses whole" scenario —
  // decision-phase turns on both ends.
  test("attaches a relation to a pair this write's own body cites", () => {
    setType(earlierTurnId, ["design"]);
    setType(targetTurnId, ["correction"]);

    const result = noteTool(
      db,
      {
        turn: `S${sessionId}/T3`,
        title: "correction+routing: reverses the earlier call",
        content: `Overturns [S${sessionId}/T1].`,
        override: [`S${sessionId}/T1`],
      },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );

    expect(isNoteSuccess(result)).toBe(true);
    expect(resultText(result)).toContain("Attached 1 relation(s).");
    const edges = getOutgoingEdges(db, { kind: "turn", id: targetTurnId });
    expect(edges).toHaveLength(1);
    expect(edges[0]?.cited).toEqual({ kind: "turn", id: earlierTurnId });
    expect(edges[0]?.relation).toBe("override");
    // The main agent's own classification — distinct from a bare textual
    // reference (`text-ref`) and a settlement attribution (`judged`).
    expect(edges[0]?.provenance).toBe("asserted");
  });

  // Requirement 1: named fields, one per relation — two different fields
  // naming two different targets in the SAME call land two distinct
  // relations, not a shared guess. The citing turn is DUAL-typed
  // (evidence + delivery) so it satisfies BOTH evidenceAgainst's source
  // requirement and dependsOn's, in the one call — the exists-rule.
  test("distinct fields for distinct targets land distinct relations in one call", () => {
    setType(targetTurnId, ["measure", "implement"]);
    setType(earlierTurnId, ["design"]);
    setType(anotherEarlierTurnId, ["fix"]);

    const result = noteTool(
      db,
      {
        turn: `S${sessionId}/T3`,
        title: "measure+implement: two claims at once",
        content: `Tested [S${sessionId}/T1] and depends on [S${sessionId}/T2].`,
        evidenceAgainst: [`S${sessionId}/T1`],
        dependsOn: [`S${sessionId}/T2`],
      },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );

    expect(isNoteSuccess(result)).toBe(true);
    const edges = getOutgoingEdges(db, { kind: "turn", id: targetTurnId });
    const byTarget = new Map(edges.map((edge) => [edge.cited.id, edge.relation]));
    expect(byTarget.get(earlierTurnId)).toBe("evidence-against");
    expect(byTarget.get(anotherEarlierTurnId)).toBe("depends-on");
  });

  // Requirement 2: a relation naming a turn the body does not cite is
  // rejected — the whole call fails, nothing at all is written. Both turns
  // are decision-phase so the phase gate passes and this test isolates the
  // not-cited rejection specifically.
  test("rejects a relation naming a turn the body does not cite (requirement 2)", () => {
    setType(targetTurnId, ["correction"]);
    setType(anotherEarlierTurnId, ["design"]);

    const result = noteTool(
      db,
      {
        turn: `S${sessionId}/T3`,
        title: "correction+routing: mentions one, claims another",
        content: `Mentions [S${sessionId}/T1].`,
        override: [`S${sessionId}/T2`],
      },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );

    expect(resultText(result)).toStartWith("Parameter error:");
    expect(resultText(result)).toContain("not cited");
    expect(isNoteSuccess(result)).toBe(false);
    // The whole transaction rolled back — not even the note itself landed.
    expect(getShadowNote(db, targetTurnId)).toBeNull();
    expect(getOutgoingEdges(db, { kind: "turn", id: targetTurnId })).toEqual([]);
  });

  // Requirement 3: the same target under two relation fields is rejected.
  // The citing turn is dual-typed (evidence + decision) to satisfy BOTH
  // evidenceFor's and override's source requirement at once.
  test("rejects the same target claimed by two relation fields (requirement 3)", () => {
    setType(targetTurnId, ["measure", "correction"]);
    setType(earlierTurnId, ["design"]);

    const result = noteTool(
      db,
      {
        turn: `S${sessionId}/T3`,
        title: "measure+correction: conflicting claims",
        content: `Cites [S${sessionId}/T1].`,
        evidenceFor: [`S${sessionId}/T1`],
        override: [`S${sessionId}/T1`],
      },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );

    expect(resultText(result)).toStartWith("Parameter error:");
    expect(resultText(result)).toContain("already claimed by a different relation field");
    expect(getShadowNote(db, targetTurnId)).toBeNull();
  });

  test("a relation field with no citation-bearing field in the same call is rejected, atomically", () => {
    setType(earlierTurnId, ["design"]);
    noteTool(
      db,
      { turn: `S${sessionId}/T3`, title: "design+routing: first pass", content: "c" },
      { now: () => 800, env: {}, eraCutoffEpoch: 1 },
    );

    // This second call touches only `type` — no title/content/insight, so
    // there is no post-state for a relation to be eligible against. `type`
    // here also happens to be decision-phase, so this isolates the
    // "no citation-bearing field" rejection from the phase gate.
    const result = noteTool(
      db,
      { turn: `S${sessionId}/T3`, type: ["correction"], override: [`S${sessionId}/T1`] },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );

    expect(resultText(result)).toStartWith("Parameter error:");
    expect(resultText(result)).toContain("also touch a");
    // The type write did not land either — the whole call rolled back.
    expect(getTurnById(db, targetTurnId)?.type).toEqual([]);
  });

  // ticket 09 (edge-ownership-impl): `session` is retired from `note`
  // outright now — a call naming it (with or without a relation field
  // alongside) is refused before any field-level check runs. The dedicated
  // "note(session) is retired" describe block pins that rejection's own
  // wording; this test only pins that a relation field cannot sneak a
  // session-addressed call past it.
  test("a session write is refused before its relation field is even inspected", () => {
    const result = noteTool(
      db,
      { session: `S${sessionId}`, title: "x", override: [`S${sessionId}/T1`] },
      { now: () => 900, env: {} },
    );

    expect(resultText(result)).toStartWith("Parameter error:");
    expect(resultText(result)).toContain("session writes retired");
  });

  // ---------------------------------------------------------------------
  // Ticket 01 (turn-edge-mechanism spec): phase-pair legality. Each of the
  // spec's four phase-pair rows gets at least one legal and one illegal
  // example (acceptance criterion 2).
  // ---------------------------------------------------------------------

  test("evidence -> decision: evidence-for is legal with an evidence-phase source, illegal with a decision-phase source", () => {
    setType(earlierTurnId, ["design"]); // decision-phase target
    setType(targetTurnId, ["research"]); // evidence-phase source

    const legal = noteTool(
      db,
      {
        turn: `S${sessionId}/T3`,
        title: "research+routing: measured the claim directly",
        content: `Tests [S${sessionId}/T1].`,
        evidenceFor: [`S${sessionId}/T1`],
      },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );
    expect(resultText(legal)).toContain("Attached 1 relation(s).");

    // A fourth, decision-phase-only turn cannot supply evidenceFor's source
    // requirement (evidence).
    const fourthTurnId = db
      .query<{ id: number }, [number, number, string]>(
        `INSERT INTO turns (session_id, prompt_number, status, user_prompt, type, created_at_epoch)
         VALUES (?, 4, 'extracted', 'A fourth turn', ?, 115) RETURNING id`,
      )
      .get(sessionId, JSON.stringify(["design"]))!.id;

    const illegal = noteTool(
      db,
      {
        turn: `S${sessionId}/T4`,
        title: "design+routing: a decision-only turn",
        content: `Tests [S${sessionId}/T1].`,
        evidenceFor: [`S${sessionId}/T1`],
      },
      { now: () => 950, env: {}, eraCutoffEpoch: 1 },
    );
    expect(resultText(illegal)).toStartWith("Parameter error:");
    expect(resultText(illegal)).toContain("evidence-phase");
    expect(getOutgoingEdges(db, { kind: "turn", id: fourthTurnId })).toEqual([]);
  });

  test("decision -> decision: refines is legal between two decision-phase turns, illegal when the citing turn is delivery-only", () => {
    setType(earlierTurnId, ["design"]);
    setType(targetTurnId, ["discuss"]);

    const legal = noteTool(
      db,
      {
        turn: `S${sessionId}/T3`,
        title: "discuss+routing: revises part of the earlier decision",
        content: `Refines [S${sessionId}/T1].`,
        refines: [`S${sessionId}/T1`],
      },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );
    expect(resultText(legal)).toContain("Attached 1 relation(s).");
  });

  // The pure-review case is its own acceptance criterion: rejected, told to
  // add `design`, admitted once added.
  test("a pure-review turn attempting refines is rejected and told to add a decision-phase type; passes once design is added", () => {
    setType(earlierTurnId, ["design"]);
    setType(targetTurnId, ["review"]);

    const rejected = noteTool(
      db,
      {
        turn: `S${sessionId}/T3`,
        title: "review+routing: a pure review turn",
        content: `Refines [S${sessionId}/T1].`,
        refines: [`S${sessionId}/T1`],
      },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );
    expect(resultText(rejected)).toStartWith("Parameter error:");
    expect(resultText(rejected)).toContain("decision-phase");
    expect(resultText(rejected)).toContain("design");
    // The whole call rolled back — no note landed from the rejected attempt.
    expect(getShadowNote(db, targetTurnId)).toBeNull();

    // Self-forcing the double type (spec's own point): `review` alone
    // cannot carry `refines`, but `["review","design"]` can — the SAME
    // multi-type turn is now legal because its phase SET admits decision.
    // `mode.type: "overwrite"` because the turn already carries a `type`
    // (set directly for the fixture above) — the ordinary non-empty-field
    // rule, unrelated to the phase gate this test targets.
    const passed = noteTool(
      db,
      {
        turn: `S${sessionId}/T3`,
        title: "design+review: reviewing this also revised the design",
        content: `Refines [S${sessionId}/T1].`,
        type: ["review", "design"],
        mode: { type: "overwrite" },
        refines: [`S${sessionId}/T1`],
      },
      { now: () => 950, env: {}, eraCutoffEpoch: 1 },
    );
    expect(isNoteSuccess(passed)).toBe(true);
    expect(resultText(passed)).toContain("Attached 1 relation(s).");
  });

  test("delivery -> decision: encodes is legal from a delivery-phase turn, illegal from a decision-phase-only turn", () => {
    setType(earlierTurnId, ["design"]); // decision-phase target
    setType(targetTurnId, ["implement"]); // delivery-phase source

    const legal = noteTool(
      db,
      {
        turn: `S${sessionId}/T3`,
        title: "implement+routing: ships the ticket carrying the decision",
        content: `Encodes [S${sessionId}/T1].`,
        encodes: [`S${sessionId}/T1`],
      },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );
    expect(resultText(legal)).toContain("Attached 1 relation(s).");

    const fifthTurnId = db
      .query<{ id: number }, [number, number, string]>(
        `INSERT INTO turns (session_id, prompt_number, status, user_prompt, type, created_at_epoch)
         VALUES (?, 5, 'extracted', 'A fifth turn', ?, 120) RETURNING id`,
      )
      .get(sessionId, JSON.stringify(["design"]))!.id;

    const illegal = noteTool(
      db,
      {
        turn: `S${sessionId}/T5`,
        title: "design+routing: a decision-only turn",
        content: `Encodes [S${sessionId}/T1].`,
        encodes: [`S${sessionId}/T1`],
      },
      { now: () => 950, env: {}, eraCutoffEpoch: 1 },
    );
    expect(resultText(illegal)).toStartWith("Parameter error:");
    expect(resultText(illegal)).toContain("delivery-phase");
    expect(getOutgoingEdges(db, { kind: "turn", id: fifthTurnId })).toEqual([]);
  });

  test("delivery -> delivery: depends-on is legal between two delivery-phase turns, illegal when the target is decision-phase", () => {
    setType(anotherEarlierTurnId, ["implement"]);
    setType(targetTurnId, ["fix"]);

    const legal = noteTool(
      db,
      {
        turn: `S${sessionId}/T3`,
        title: "fix+routing: depends on the earlier build",
        content: `Depends on [S${sessionId}/T2].`,
        dependsOn: [`S${sessionId}/T2`],
      },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );
    expect(resultText(legal)).toContain("Attached 1 relation(s).");

    setType(earlierTurnId, ["design"]); // decision-phase — illegal dependsOn target
    const illegal = noteTool(
      db,
      {
        turn: `S${sessionId}/T3`,
        title: "fix+routing: revised, now depends on a decision instead",
        content: `Depends on [S${sessionId}/T1].`,
        dependsOn: [`S${sessionId}/T1`],
        mode: { title: "overwrite", content: "overwrite" },
      },
      { now: () => 950, env: {}, eraCutoffEpoch: 1 },
    );
    expect(resultText(illegal)).toStartWith("Parameter error:");
    expect(resultText(illegal)).toContain("delivery-phase");
  });

  // [S15069/T935] mid-flight amendment: `grounded-on` — decision source,
  // evidence OR delivery target (an OR the other relations do not have).
  test("decision -> {evidence, delivery}: groundedOn is legal against either phase, illegal against a decision-phase target", () => {
    setType(earlierTurnId, ["research"]); // evidence-phase
    setType(anotherEarlierTurnId, ["implement"]); // delivery-phase
    setType(targetTurnId, ["design"]); // decision-phase source, both calls

    const groundedOnEvidence = noteTool(
      db,
      {
        turn: `S${sessionId}/T3`,
        title: "design+routing: rests on the earlier finding",
        content: `Grounded on [S${sessionId}/T1].`,
        groundedOn: [`S${sessionId}/T1`],
      },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );
    expect(resultText(groundedOnEvidence)).toContain("Attached 1 relation(s).");

    const groundedOnDelivery = noteTool(
      db,
      {
        turn: `S${sessionId}/T3`,
        title: "design+routing: rests on the earlier finding, revised",
        content: `Grounded on [S${sessionId}/T2].`,
        groundedOn: [`S${sessionId}/T2`],
        mode: { title: "overwrite", content: "overwrite" },
      },
      { now: () => 950, env: {}, eraCutoffEpoch: 1 },
    );
    expect(resultText(groundedOnDelivery)).toContain("Attached 1 relation(s).");
    const edges = getOutgoingEdges(db, { kind: "turn", id: targetTurnId });
    expect(edges.every((edge) => edge.relation === "grounded-on")).toBe(true);

    // Illegal: a decision-phase target satisfies neither of groundedOn's two
    // pairs (evidence, delivery).
    const decisionTargetId = db
      .query<{ id: number }, [number, number, string]>(
        `INSERT INTO turns (session_id, prompt_number, status, user_prompt, type, created_at_epoch)
         VALUES (?, 4, 'extracted', 'A decision-only turn', ?, 118) RETURNING id`,
      )
      .get(sessionId, JSON.stringify(["discuss"]))!.id;
    const illegal = noteTool(
      db,
      {
        turn: `S${sessionId}/T3`,
        title: "design+routing: tries to ground on another decision",
        content: `Grounded on [S${sessionId}/T4].`,
        groundedOn: [`S${sessionId}/T4`],
        mode: { title: "overwrite", content: "overwrite" },
      },
      { now: () => 1000, env: {}, eraCutoffEpoch: 1 },
    );
    expect(resultText(illegal)).toStartWith("Parameter error:");
    expect(resultText(illegal)).toContain("evidence-phase");
    expect(resultText(illegal)).toContain("delivery-phase");
    expect(getOutgoingEdges(db, { kind: "turn", id: decisionTargetId })).toEqual([]);
  });

  // Ticket 01: the exists-rule for a MULTI-type turn — legal on BOTH ends at
  // once for two DIFFERENT relations, matching the spec's own worked example
  // ("design+ops 轮可被 refines 亦可发 encodes").
  test("a dual-type (design+ops) turn is legal on both ends under the exists-rule — refines' target and encodes' source", () => {
    // anotherEarlierTurnId carries BOTH a decision phase (design) and a
    // delivery phase (ops) — legal as refines' TARGET (needs decision) and,
    // in a separate write, as encodes' SOURCE (needs delivery).
    setType(anotherEarlierTurnId, ["design", "ops"]);
    setType(targetTurnId, ["correction"]);

    const refinesResult = noteTool(
      db,
      {
        turn: `S${sessionId}/T3`,
        title: "correction+routing: revises part of the earlier decision",
        content: `Refines [S${sessionId}/T2].`,
        refines: [`S${sessionId}/T2`],
      },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );
    expect(resultText(refinesResult)).toContain("Attached 1 relation(s).");

    setType(earlierTurnId, ["design"]);
    const encodesResult = noteTool(
      db,
      {
        turn: `S${sessionId}/T2`,
        title: "design+ops: ships the ticket that carries the earlier decision",
        content: `Encodes [S${sessionId}/T1].`,
        encodes: [`S${sessionId}/T1`],
      },
      { now: () => 950, env: {}, eraCutoffEpoch: 1 },
    );
    expect(resultText(encodesResult)).toContain("Attached 1 relation(s).");
  });

  // Ticket 01: relations are turn-only — an `E<n>` target is a parameter
  // error naming the ownership/cites alternative, never a silent drop.
  test("a relation target naming a segment is rejected — relations are turn-only", () => {
    const segment = createSegment(db, { title: "Some segment", nowEpoch: 200 });
    setType(targetTurnId, ["correction"]);

    const result = noteTool(
      db,
      {
        turn: `S${sessionId}/T3`,
        title: "correction+routing: tries to relate to a segment",
        content: `Related to [E${segment.id}].`,
        override: [`E${segment.id}`],
      },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );

    expect(resultText(result)).toStartWith("Parameter error:");
    expect(resultText(result)).toContain("segment address");
    expect(resultText(result)).toContain("turn-only");
  });
});

// ticket 03 (spec E1): `note` and the retired `remember` are one tool. These
// tests cover the acceptance criteria that neither the pre-existing note.test
// suite nor era-cutover.test.ts happen to exercise: that the old entry point
// is actually gone (not merely unused), the mode requirement on a NON-empty
// field for both a turn and a session, append accumulating versus overwrite
// replacing (with the stored value checked after each), the receipt reporting
// a post-write total rather than a delta, and content carrying tool-call
// syntax being rejected outright.
describe("the merged write tool (ticket 03)", () => {
  let db: Database;
  let sessionId: number;
  let turnId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    sessionId = upsertSession(db, {
      contentSessionId: "merge-session",
      project: "claude-mnemo",
      title: "Before",
      content: "Initial",
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    }).id;

    turnId = db
      .query<{ id: number }, [number, number]>(
        `INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch)
         VALUES (?, 1, 'active', 'Do the thing', ?) RETURNING id`,
      )
      .get(sessionId, 100)!.id;
  });

  afterEach(() => {
    db.close();
  });

  // Ticket 02 (ADR-0001/0002) revives `remember` — the name the 0.11.x merge
  // above freed — as the segment (semantic) write surface, distinct from
  // `note` (episodic). The three tests this block used to carry (the module
  // does not exist; the handler map carries no `remember` key; the server
  // never registers it) asserted the OLD state and are superseded by their
  // exact opposites: `remember` exists, is a SEPARATE tool from `note` (not
  // re-merged into it), and is registered on the main server. See
  // tests/mcp/remember.test.ts for `remember`'s own behavioural coverage.
  describe("the revived remember entry point (ticket 02)", () => {
    test("the module exports a tool distinct from noteTool", async () => {
      const remembered = await import("../../src/mcp/remember");
      expect(typeof remembered.rememberTool).toBe("function");
      expect(remembered.rememberTool).not.toBe(noteTool);
    });

    test("the database-backed handlers expose a remember key beside note", () => {
      const handlers = createDatabaseBackedHandlers(db);
      expect(Object.keys(handlers).sort()).toEqual([
        "note",
        "recall",
        "remember",
        "timeline",
      ]);
    });

    test("the main MCP server registers remember beside recall, timeline and note", () => {
      const registered: string[] = [];
      registerMainMcpTools(
        { registerTool: (name) => registered.push(name) },
        {
          recall: () => ({ content: [] }),
          timeline: () => ({ content: [] }),
          note: () => ({ content: [] }),
          remember: () => ({ content: [] }),
        } as never,
      );
      expect(registered).toEqual(["recall", "timeline", "note", "remember"]);
    });
  });

  // Acceptance criteria 2 and 3: a non-empty field (turn or session) needs a
  // declared mode; the same write to an empty field needs none.
  describe("the mode requirement", () => {
    test("a non-empty turn field errors naming the field; the same write to an empty field succeeds", () => {
      noteTool(db, { turn: `S${sessionId}/T1`, title: "t", content: "c" });

      const blocked = noteTool(db, {
        turn: `S${sessionId}/T1`,
        content: "c2",
      });
      expect(resultText(blocked)).toStartWith("Parameter error:");
      expect(resultText(blocked)).toContain("content is not empty");
      expect(resultText(blocked)).toContain("mode.content");
      expect(getShadowNote(db, turnId)?.content).toBe("c"); // untouched by the rejected call

      // `insight` is still empty (never written) — the identical shape of
      // write needs no mode at all.
      const allowed = noteTool(db, {
        turn: `S${sessionId}/T1`,
        insight: "first insight",
      });
      expect(isNoteSuccess(allowed)).toBe(true);
      expect(getShadowNote(db, turnId)?.insight).toBe("first insight");
    });

    // Ticket 09 (edge-ownership-impl): the session address itself retired —
    // this used to show `title`'s own mode-required behaviour on a session
    // write; that surface no longer exists (see the dedicated "note(session)
    // is retired" describe block), so the mode-required shape survives only
    // on the turn side, already covered by the tests above (content vs.
    // insight).
    test("a session write is refused before mode is even considered, with or without one", () => {
      const withoutMode = noteTool(db, { session: `S${sessionId}`, title: "x" } as never);
      expect(resultText(withoutMode)).toContain("session writes retired");

      const withMode = noteTool(db, {
        session: `S${sessionId}`,
        title: "x",
        mode: { title: "overwrite" },
      } as never);
      expect(resultText(withMode)).toContain("session writes retired");
    });
  });

  // Acceptance criterion 4: append accumulates, overwrite replaces — the
  // stored value checked after each, on one field of each shape (string,
  // array).
  describe("append accumulates, overwrite replaces", () => {
    test("a string field (turn content): append concatenates, overwrite replaces", () => {
      noteTool(db, { turn: `S${sessionId}/T1`, title: "t", content: "first" });
      expect(getShadowNote(db, turnId)?.content).toBe("first");

      noteTool(db, {
        turn: `S${sessionId}/T1`,
        content: "second",
        mode: { content: "append" },
      });
      expect(getShadowNote(db, turnId)?.content).toBe("first\nsecond");

      noteTool(db, {
        turn: `S${sessionId}/T1`,
        content: "third",
        mode: { content: "overwrite" },
      });
      expect(getShadowNote(db, turnId)?.content).toBe("third");
    });

    test("an array field (turn tags): append unions, overwrite replaces whole", () => {
      noteTool(db, {
        turn: `S${sessionId}/T1`,
        title: "t",
        content: "c",
        tags: ["auth"],
      });
      expect(getTurnById(db, turnId)!.tags).toEqual(["auth"]);

      noteTool(db, {
        turn: `S${sessionId}/T1`,
        tags: ["concurrency"],
        mode: { tags: "append" },
      });
      expect(getTurnById(db, turnId)!.tags).toEqual(["auth", "concurrency"]);

      noteTool(db, {
        turn: `S${sessionId}/T1`,
        tags: ["delivery"],
        mode: { tags: "overwrite" },
      });
      expect(getTurnById(db, turnId)!.tags).toEqual(["delivery"]);
    });
  });

  // Acceptance criterion 5: omission still leaves a stored value alone —
  // ticket 02's rule, unchanged by the merge. Was pinned across a field from
  // EACH surface (turn `grade`, session `decision`/`done`); ticket 01
  // (ADR-0003) removed `grade` and ticket 01/09 shrank the session address to
  // one field, `title` — with nothing left to omit while touching session
  // (every session call necessarily touches its one field), only the turn
  // half survives, now demonstrated with `tags` in `grade`'s old role.
  test("omission leaves a stored value alone", () => {
    noteTool(db, {
      turn: `S${sessionId}/T1`,
      title: "t",
      content: "c",
      type: ["implement"],
    });
    noteTool(db, { turn: `S${sessionId}/T1`, tags: ["auth"] });
    const turn = getTurnById(db, turnId)!;
    // Omitted from the second call, on the shadow row the merged tool always
    // maintains regardless of era (turns.title/content stay untouched here
    // with no era cutoff configured — see note's own P1-isolation tests).
    expect(getShadowNote(db, turnId)?.title).toBe("t");
    expect(getShadowNote(db, turnId)?.content).toBe("c");
    expect(turn.type).toEqual(["implement"]);
    expect(turn.tags).toEqual(["auth"]);
  });

  // Acceptance criterion 6: the receipt reports an accumulating field's total
  // after the write, not the delta.
  test("the receipt reports the post-write total of an appended field, not the delta", () => {
    noteTool(db, { turn: `S${sessionId}/T1`, title: "t", content: "a".repeat(40) });
    const result = noteTool(db, {
      turn: `S${sessionId}/T1`,
      content: "b".repeat(40),
      mode: { content: "append" },
    });

    const stored = getShadowNote(db, turnId)!.content;
    expect(stored.replace(/\n/g, "").length).toBe(80); // both halves survive
    // The receipt's content count reflects the full 80+1(newline) characters
    // now stored (~21 tok at 4 chars/tok), not merely the 40 just appended
    // (~10 tok) — a writer appending in small increments must see the total
    // it has reached, not the size of its own last call.
    expect(resultText(result)).toContain("content 21/100");
  });

  // Acceptance criterion 7: content carrying tool-call syntax is rejected
  // with a readable error, and nothing is stored (spec E2).
  describe("tool-call syntax in a field is rejected (spec E2)", () => {
    test("a first note whose content carries a raw parameter tag is refused, and nothing lands", () => {
      const result = noteTool(db, {
        turn: `S${sessionId}/T1`,
        title: "t",
        content: 'Kept text.</content>\n<parameter name="insight">leaked',
      });

      expect(resultText(result)).toStartWith("Parameter error:");
      expect(resultText(result)).toContain("content");
      expect(resultText(result)).toContain("tool-call");
      expect(getShadowNote(db, turnId)).toBeNull();
      expect(getTurnById(db, turnId)!.title).toBeNull();
    });

    // ticket 09 (edge-ownership-impl): `session` is rejected before this
    // call ever reaches field-by-field validation now — see the dedicated
    // "note(session) is retired" describe block below for that behaviour.
    // What survives here is the turn-side pin: tool-call markup is still
    // refused on a TURN field the same way.
  });
});

// ticket 09 (edge-ownership-impl, "结算顺手维护 session 叙事"): `note`'s
// session address retired OUTRIGHT — every describe block this file used to
// carry for a session write (title-only budget/cadence/current-retirement
// behaviour) is gone with the surface itself. What replaces it: `session`,
// however it arrives (alone, with other fields, well-formed or not), is
// refused before any field-level validation runs, and the message names
// settlement as the field's new writer.
describe("note(session) is retired — settlement is the session's sole writer now (ticket 09)", () => {
  let db: Database;
  let sessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "summary-session",
      project: "claude-mnemo",
      title: "Before",
      content: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("a bare session write is refused, naming settlement as the writer, and nothing lands", () => {
    const result = noteTool(db, { session: `S${sessionId}`, title: "a new title" } as never);

    expect(resultText(result)).toStartWith("Parameter error:");
    expect(resultText(result)).toContain("session writes retired");
    expect(resultText(result).toLowerCase()).toContain("settlement");
    expect(isNoteSuccess(result)).toBe(false);
    expect(getSession(db, sessionId)?.title).toBe("Before");
  });

  // Whatever else rides with `session` — content, a malformed session id, a
  // long-retired field, tool-call markup — the SAME rejection fires before
  // any of it is inspected: there is no field-by-field session validation
  // left to reach.
  test("the rejection fires regardless of which other fields accompany session, well-formed or not", () => {
    for (const input of [
      { session: `S${sessionId}`, current: "x", title: "y" },
      { session: `S${sessionId}`, content: "a turn-only field now" },
      { session: `S${sessionId}`, decision: "x", done: "y" },
      { session: `S${sessionId}`, title: 'Chose X.\n<invoke name="note">' },
      { session: "not-an-address", title: "x" },
    ] as const) {
      const result = noteTool(db, input as never);
      expect(resultText(result)).toStartWith("Parameter error:");
      expect(resultText(result)).toContain("session writes retired");
    }
    expect(getSession(db, sessionId)?.title).toBe("Before");
  });

  test("noteInputSchema rejects session at the wire layer — a `.strict()` parse error, whatever rides with it", () => {
    expect(() => noteInputSchema.parse({ session: "S1", title: "t" })).toThrow();
    expect(() => noteInputSchema.parse({ session: "S1" })).toThrow();
  });

  test("turn is still required and still works — only the session surface retired", () => {
    db.query<{ id: number }, [number]>(
      `INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch)
       VALUES (?, 1, 'extracted', 'work', 100) RETURNING id`,
    ).get(sessionId);
    const result = noteTool(db, { turn: `S${sessionId}/T1`, title: "t", content: "c" });
    expect(isNoteSuccess(result)).toBe(true);
  });
});
