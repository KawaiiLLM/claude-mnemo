import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { getOutgoingEdges, writeMemoryEdges } from "../../src/db/memory-edges";
import { getNoteDebt, listOwedNoteTurns } from "../../src/db/note-debt";
import { initializeSchema } from "../../src/db/schema";
import { addSegmentMembers, createSegment } from "../../src/db/segments";
import { getShadowNote } from "../../src/db/shadow-notes";
import { getSession, upsertSession } from "../../src/db/sessions";
import { getTurnById } from "../../src/db/turns";
import { sessionWriterId } from "../../src/db/write-gate";
import { noteInputSchema } from "../../src/mcp/definitions";
import { createDatabaseBackedHandlers } from "../../src/mcp/handlers";
import { isNoteSuccess, noteTool } from "../../src/mcp/note";
import { recallMemory } from "../../src/mcp/recall";
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

  test("records writer_model and ride_turn mechanically; ride_turn prints on divergence, writer_model stays silent when unrecorded", () => {
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
    // ticket 02 (edge-mechanism-revision D3) added the seven `retract…`
    // mirrors, one per relation.
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
      "retractEvidenceFor",
      "retractEvidenceAgainst",
      "retractGroundedOn",
      "retractRefines",
      "retractOverride",
      "retractEncodes",
      "retractDependsOn",
      "mode",
    ]);
    expect(note.rideTurnId).toBe(rideTurnId);
    expect(note.writerModel).toBeNull();
    // ride_turn: S334 diverges from the written turn (T332) — diagnostic,
    // so it prints (ticket 02, render-boilerplate-trim).
    expect(resultText(result)).toContain(`ride_turn: S${sessionId}/T334`);
    // writer_model was not recorded — the former "not recorded — this
    // environment does not expose..." apology told the caller nothing new on
    // every single call, so the segment now stays silent entirely.
    expect(resultText(result)).not.toContain("writer_model");
  });

  // render-boilerplate-trim ticket 02: a receipt segment prints only when it
  // tells the caller something it does not already know. These pin the four
  // cuts' diagnostic/silent split directly (writer_model, ride_turn, the
  // type/tags echo) and the minimal shape a fully-ordinary write collapses to.
  describe("receipt trim: segments print only on divergence", () => {
    test("a same-turn, in-budget, no-divergence write's receipt is exactly the minimal shape", () => {
      // T334 is the session's own current turn (highest prompt_number,
      // seeded in beforeEach) — writing directly to it makes ride_turn equal
      // the written turn, the silent case. No writer_model env, no type/tags,
      // no relations: nothing beyond "Noted … budget: …" should fire.
      const result = noteTool(
        db,
        { turn: `S${sessionId}/T334`, title: "t", content: "c" },
        { now: () => 900, env: {} },
      );

      expect(isNoteSuccess(result)).toBe(true);
      expect(resultText(result)).toBe(
        `Noted S${sessionId}/T334. budget: title 1/20 · content 1/100 → 2/120 (<0.1×).`,
      );
    });

    test("ride_turn: unknown when the session has no non-undone turn to compare against", () => {
      const soloSessionId = upsertSession(db, {
        contentSessionId: "note-session-solo-undone",
        project: "claude-mnemo",
        title: "Solo undone session",
        content: "x",
        insight: null,
        createdAtEpoch: 100,
        updatedAtEpoch: 110,
        completedAtEpoch: null,
      }).id;
      // The only turn in this session is itself 'undone', so
      // getSessionCurrentTurn's own `status != 'undone'` filter excludes it
      // too — there is no current turn at all, the genuinely-unknown case.
      db.query<unknown, [number, number, string, number]>(
        `INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch)
         VALUES (?, ?, 'undone', ?, ?)`,
      ).run(soloSessionId, 1, "The only turn, and it is undone", 120);

      const result = noteTool(
        db,
        { turn: `S${soloSessionId}/T1`, title: "t", content: "c" },
        { now: () => 900, env: {} },
      );

      expect(isNoteSuccess(result)).toBe(true);
      expect(resultText(result)).toContain("ride_turn: unknown.");
    });

    test("type echo prints only when normalization changes the submitted value", () => {
      const divergent = noteTool(
        db,
        { turn: `S${sessionId}/T332`, type: ["fix", "fix", " design "] },
        { now: () => 900, env: {} },
      );
      // Deduped and trimmed to two values — stored differs from submitted.
      expect(resultText(divergent)).toContain("type: fix, design.");

      const identical = noteTool(
        db,
        { turn: `S${sessionId}/T333`, type: ["fix"] },
        { now: () => 900, env: {} },
      );
      // Already exactly the normalized form — nothing new to report.
      expect(resultText(identical)).not.toContain("type:");
    });

    test("tags echo prints only when HTML-entity decoding changes the submitted value", () => {
      const divergent = noteTool(
        db,
        { turn: `S${sessionId}/T332`, tags: ["fix &amp; polish"] },
        { now: () => 900, env: {} },
      );
      expect(resultText(divergent)).toContain("tags: fix & polish.");

      const identical = noteTool(
        db,
        { turn: `S${sessionId}/T333`, tags: ["auth"] },
        { now: () => 900, env: {} },
      );
      expect(resultText(identical)).not.toContain("tags:");
    });
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

  // ticket 01 (field-semantics spec, "01 — 字段定义进注入,预算硬拒改为回执提
  // 醒"): the 2× hard rejection this describe used to pin is RETIRED — a
  // field over budget, however far over, is now always stored. What replaces
  // it is a receipt warning past 1.5×, fired on EVERY call that still lands
  // over the line (no suppression state — the ruling's own reasoning: "如果
  // 只提醒一次无法抑制一直超写"). Every test below INVERTS what its
  // pre-ticket-01 namesake pinned:
  //   - "title/content/insight over 2x ... rejected ... nothing stored"
  //     -> the same oversized values now land, and the receipt warns.
  //   - "an inherited over-2x field ... does not block a sibling field's
  //     fresh write" is DROPPED outright, not inverted: the design decision
  //     it existed to pin (scope the rejection check to only the field THIS
  //     call resolves, so an inherited oversized field cannot block a
  //     sibling) is moot now that nothing is ever blocked.
  describe("turn budget: 2× no longer rejects, 1.5× warns every time (ticket 01)", () => {
    test("title over 2x its budget is stored, and the receipt warns past 1.5×", () => {
      const result = noteTool(
        db,
        {
          turn: `S${sessionId}/T332`,
          title: "x".repeat(164), // 41 tok, over 1.5x (30) and 2x (40) of the 20 tok budget alike
          content: "c",
        },
        { now: () => 900, env: {} },
      );

      expect(isNoteSuccess(result)).toBe(true);
      expect(resultText(result)).toContain("title 41/20");
      expect(resultText(result)).toContain(
        "title over 1.5× — occasional is fine, a standing pattern is not.",
      );
      expect(getShadowNote(db, targetTurnId)?.title).toBe("x".repeat(164));
    });

    test("content over 2x its budget on a rewrite is stored, replacing the prior note, and warns", () => {
      noteTool(
        db,
        { turn: `S${sessionId}/T332`, title: "first", content: "first content" },
        { now: () => 900, env: {} },
      );

      const result = noteTool(
        db,
        {
          turn: `S${sessionId}/T332`,
          content: "x".repeat(804), // 201 tok, over 2x of the 100 tok budget
          mode: { content: "write" },
        },
        { now: () => 1000, env: {} },
      );

      expect(isNoteSuccess(result)).toBe(true);
      expect(resultText(result)).toContain("content over 1.5×");
      // The rewrite actually landed — the prior content is gone, replaced.
      expect(getShadowNote(db, targetTurnId)?.content).toBe("x".repeat(804));
    });

    test("insight over 2x its budget is stored alongside title/content in the same call, and warns", () => {
      const result = noteTool(
        db,
        {
          turn: `S${sessionId}/T332`,
          title: "t",
          content: "c",
          insight: "x".repeat(484), // 121 tok, over 2x of the 60 tok budget
        },
        { now: () => 900, env: {} },
      );

      expect(isNoteSuccess(result)).toBe(true);
      expect(resultText(result)).toContain("insight over 1.5×");
      expect(getShadowNote(db, targetTurnId)?.insight).toBe("x".repeat(484));
      // title/content in the same call landed too — nothing rolled back.
      expect(getShadowNote(db, targetTurnId)?.title).toBe("t");
    });

    test("a field under 1.5× its budget does not warn", () => {
      const result = noteTool(
        db,
        { turn: `S${sessionId}/T332`, title: "t", content: "c" },
        { now: () => 900, env: {} },
      );

      expect(resultText(result)).not.toContain("over 1.5×");
    });

    // Acceptance criterion: "连续三次超,三次都带" — no state suppresses a
    // repeat warning across calls on the same field.
    test("three consecutive over-1.5× writes to the same field warn all three times", () => {
      noteTool(
        db,
        { turn: `S${sessionId}/T332`, title: "t", content: "x".repeat(804) },
        { now: () => 900, env: {} },
      );

      for (let i = 0; i < 3; i++) {
        const result = noteTool(
          db,
          {
            turn: `S${sessionId}/T332`,
            content: "x".repeat(804), // 201 tok, over 1.5x of the 100 tok budget every time
            mode: { content: "write" },
          },
          { now: () => 1000 + i, env: {} },
        );
        expect(resultText(result)).toContain("content over 1.5×");
      }
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
        mode: { title: "write", content: "write" },
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
        mode: { title: "write", content: "write" },
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
        mode: { title: "write", content: "write" },
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

  test("a rewrite (mode: overwrite) that drops a reference drops the bare row but never a relation (decoupling, edge-revision D1)", () => {
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
    );

    noteTool(
      db,
      {
        turn: `S${sessionId}/T2`,
        title: "design+routing: revised, no longer citing T1",
        content: "Stands on its own now.",
        mode: { title: "write", content: "write" },
      },
      { now: () => 1000, env: {}, eraCutoffEpoch: 1 },
    );

    // The relation row is a standalone claim — prose drift cannot delete it;
    // only retraction can. The prose's own bare record is what a bare-only
    // pair would have lost (the relation write already replaced it here, so
    // the surviving set is exactly the relation row).
    const survivors = getOutgoingEdges(db, { kind: "turn", id: targetTurnId });
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.relation).toBe("supersedes");
  });

  test("a rewrite that drops a reference deletes a BARE-only pair outright", () => {
    noteTool(
      db,
      {
        turn: `S${sessionId}/T2`,
        title: "design+routing: first pass",
        content: `Cites [S${sessionId}/T1].`,
      },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );

    noteTool(
      db,
      {
        turn: `S${sessionId}/T2`,
        title: "design+routing: revised, no longer citing T1",
        content: "Stands on its own now.",
        mode: { title: "write", content: "write" },
      },
      { now: () => 1000, env: {}, eraCutoffEpoch: 1 },
    );

    expect(getOutgoingEdges(db, { kind: "turn", id: targetTurnId })).toEqual([]);
  });
});

describe("note tool relation attach (spec C1, ticket 07; phase gate ticket 01; prose decoupled by ticket 02)", () => {
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

  // Ticket 02 (edge-mechanism-revision D1), the REVERSE of what spec C7 used
  // to assert: a body that names no address at all still carries its
  // relations. This is the acceptance criterion "正文完全不含目标地址时关系
  // 照常写入" — the old contract failed exactly this call with `not-cited`.
  test("a body naming no address at all still attaches the relation (C7's reverse)", () => {
    setType(targetTurnId, ["correction"]);
    setType(anotherEarlierTurnId, ["design"]);

    const result = noteTool(
      db,
      {
        turn: `S${sessionId}/T3`,
        title: "correction+routing: reverses an earlier call",
        content: "Plain prose, no bracketed address anywhere.",
        override: [`S${sessionId}/T2`],
      },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );

    expect(isNoteSuccess(result)).toBe(true);
    expect(resultText(result)).toContain("Attached 1 relation(s).");
    const edges = getOutgoingEdges(db, { kind: "turn", id: targetTurnId });
    expect(edges).toHaveLength(1);
    expect(edges[0]?.cited).toEqual({ kind: "turn", id: anotherEarlierTurnId });
    expect(edges[0]?.relation).toBe("override");
    // No "not cited" rejection survives anywhere on this surface.
    expect(resultText(result)).not.toContain("not cited");
  });

  // Ticket 02 (D2, acceptance criterion 3): the same pair carries two
  // relations. The citing turn is dual-typed (evidence + decision) so it
  // satisfies BOTH evidenceFor's source requirement and override's.
  test("two relation fields naming the SAME target both land, as two coexisting rows", () => {
    setType(targetTurnId, ["measure", "correction"]);
    setType(earlierTurnId, ["design"]);

    const result = noteTool(
      db,
      {
        turn: `S${sessionId}/T3`,
        title: "measure+correction: two claims about one predecessor",
        content: "Tested it, then overturned it.",
        evidenceFor: [`S${sessionId}/T1`],
        override: [`S${sessionId}/T1`],
      },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );

    expect(isNoteSuccess(result)).toBe(true);
    expect(resultText(result)).toContain("Attached 2 relation(s).");
    expect(resultText(result)).not.toContain("already claimed by a different relation field");
    const relations = getOutgoingEdges(db, { kind: "turn", id: targetTurnId })
      .filter((edge) => edge.cited.id === earlierTurnId)
      .map((edge) => edge.relation)
      .sort();
    expect(relations).toEqual(["evidence-for", "override"]);
  });

  // The same criterion reached the other way — two separate calls, which is
  // how a real writer discovers the second relation later.
  test("a second relation on the same pair, written by a later call, coexists with the first", () => {
    setType(targetTurnId, ["implement", "correction"]);
    setType(earlierTurnId, ["design"]);

    noteTool(
      db,
      {
        turn: `S${sessionId}/T3`,
        title: "implement+correction: ships the decision it also revised",
        content: "First pass.",
        encodes: [`S${sessionId}/T1`],
      },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );
    const second = noteTool(
      db,
      { turn: `S${sessionId}/T3`, override: [`S${sessionId}/T1`] },
      { now: () => 950, env: {}, eraCutoffEpoch: 1 },
    );

    expect(isNoteSuccess(second)).toBe(true);
    expect(resultText(second)).toContain("Attached 1 relation(s).");
    const relations = getOutgoingEdges(db, { kind: "turn", id: targetTurnId })
      .map((edge) => edge.relation)
      .sort();
    expect(relations).toEqual(["encodes", "override"]);
  });

  // Ticket 02: a relation field is now a complete call on its own — the
  // former "requires a citation-bearing field in the same call" rejection is
  // gone, not merely satisfiable another way.
  test("a call carrying nothing but a relation field attaches the edge and writes no prose", () => {
    setType(earlierTurnId, ["design"]);
    setType(targetTurnId, ["correction"]);

    const result = noteTool(
      db,
      { turn: `S${sessionId}/T3`, override: [`S${sessionId}/T1`] },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );

    expect(isNoteSuccess(result)).toBe(true);
    expect(resultText(result)).toContain("Attached 1 relation(s).");
    expect(resultText(result)).not.toContain("also touch a");
    // No note was created by an edge-only call.
    expect(getShadowNote(db, targetTurnId)).toBeNull();
    const edges = getOutgoingEdges(db, { kind: "turn", id: targetTurnId });
    expect(edges).toHaveLength(1);
    expect(edges[0]?.relation).toBe("override");
    expect(edges[0]?.provenance).toBe("asserted");
  });

  test("re-sending the same relation is reported as already present, not as new work", () => {
    setType(earlierTurnId, ["design"]);
    setType(targetTurnId, ["correction"]);

    noteTool(
      db,
      { turn: `S${sessionId}/T3`, override: [`S${sessionId}/T1`] },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );
    const again = noteTool(
      db,
      { turn: `S${sessionId}/T3`, override: [`S${sessionId}/T1`] },
      { now: () => 950, env: {}, eraCutoffEpoch: 1 },
    );

    expect(isNoteSuccess(again)).toBe(true);
    expect(resultText(again)).toContain("1 relation(s) already present, nothing added.");
    expect(getOutgoingEdges(db, { kind: "turn", id: targetTurnId })).toHaveLength(1);
  });

  test("a relation naming the citing turn itself is rejected by name", () => {
    setType(targetTurnId, ["correction", "design"]);

    const result = noteTool(
      db,
      { turn: `S${sessionId}/T3`, override: [`S${sessionId}/T3`] },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );

    expect(resultText(result)).toStartWith("Parameter error:");
    expect(resultText(result)).toContain(`override "S${sessionId}/T3"`);
    expect(resultText(result)).toContain("cannot cite itself");
    expect(getOutgoingEdges(db, { kind: "turn", id: targetTurnId })).toEqual([]);
  });

  // Relation-matrix spec, "自引用" (ticket 05): the validator matrix pinned by
  // the ticket — a multi-phase turn may self-cite with a CROSS-PHASE word
  // when its own `type` list spans both halves; a single-phase turn never can
  // (whatever the relation); a DIAGONAL word never can (whatever the phase).
  test("a research+review turn self-encodes — its review half carries its research half", () => {
    setType(targetTurnId, ["research", "review"]);

    const result = noteTool(
      db,
      { turn: `S${sessionId}/T3`, encodes: [`S${sessionId}/T3`] },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );

    expect(isNoteSuccess(result)).toBe(true);
    const edges = getOutgoingEdges(db, { kind: "turn", id: targetTurnId });
    expect(edges).toHaveLength(1);
    expect(edges[0]?.relation).toBe("encodes");
    expect(edges[0]?.cited).toEqual({ kind: "turn", id: targetTurnId });
  });

  test("a research-ONLY turn cannot self-encodes — naming the single phase it lacks", () => {
    setType(targetTurnId, ["research"]);

    const result = noteTool(
      db,
      { turn: `S${sessionId}/T3`, encodes: [`S${sessionId}/T3`] },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );

    expect(resultText(result)).toStartWith("Parameter error:");
    expect(resultText(result)).toContain(`encodes "S${sessionId}/T3"`);
    expect(resultText(result)).toContain("this turn's own type list");
    expect(resultText(result)).toContain("delivery-phase");
    expect(getOutgoingEdges(db, { kind: "turn", id: targetTurnId })).toEqual([]);
  });

  test("a research+review turn cannot self-refines — a diagonal word never self-cites", () => {
    setType(targetTurnId, ["research", "review"]);

    const result = noteTool(
      db,
      { turn: `S${sessionId}/T3`, refines: [`S${sessionId}/T3`] },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );

    expect(resultText(result)).toStartWith("Parameter error:");
    expect(resultText(result)).toContain(`refines "S${sessionId}/T3"`);
    expect(resultText(result)).toContain("cannot cite itself");
    expect(getOutgoingEdges(db, { kind: "turn", id: targetTurnId })).toEqual([]);
  });

  test("a design-ONLY turn cannot self-grounded-on — its own type list lacks a second phase", () => {
    setType(targetTurnId, ["design"]);

    const result = noteTool(
      db,
      { turn: `S${sessionId}/T3`, groundedOn: [`S${sessionId}/T3`] },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );

    expect(resultText(result)).toStartWith("Parameter error:");
    expect(resultText(result)).toContain(`grounded-on "S${sessionId}/T3"`);
    expect(resultText(result)).toContain("this turn's own type list");
    expect(getOutgoingEdges(db, { kind: "turn", id: targetTurnId })).toEqual([]);
  });

  test("a call carrying no field and no edge parameter still names what it needs", () => {
    const result = noteTool(
      db,
      { turn: `S${sessionId}/T3` },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );

    expect(resultText(result)).toStartWith("Parameter error:");
    expect(resultText(result)).toContain("a relation field");
    expect(resultText(result)).toContain("retract");
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

  // Ticket 01 (relation-matrix spec): `review` alone (delivery-phase) is now
  // a LEGAL `refines` SOURCE — the diagonal relaxation admits every
  // same-phase pair, not decision->decision only. So a pure-review turn
  // pointed at a decision-phase target is rejected on the CITED side (the
  // target needs a delivery-phase type to match), not because the citing
  // turn itself lacks a decision-phase type. Adding `design` widens the
  // CITING turn's own phase set instead, so its decision->decision pair now
  // matches the target — same outcome as before the rewrite, different
  // mechanism.
  test("a pure-review turn attempting refines against a decision-phase target is rejected naming the missing delivery-phase target; passes once design is added", () => {
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
    expect(resultText(rejected)).toContain("delivery-phase");
    expect(resultText(rejected)).toContain("implement");
    // The whole call rolled back — no note landed from the rejected attempt.
    expect(getShadowNote(db, targetTurnId)).toBeNull();

    // Self-forcing the double type (spec's own point): `review` alone
    // is legal against a DELIVERY-phase target, but not this DECISION-phase
    // one; `["review","design"]` widens the citing turn's own phase set so
    // its decision->decision pair also matches. `mode.type: "write"` because
    // the turn already carries a `type` (set directly for the fixture
    // above) — the ordinary non-empty-field rule, unrelated to the phase
    // gate this test targets.
    const passed = noteTool(
      db,
      {
        turn: `S${sessionId}/T3`,
        title: "design+review: reviewing this also revised the design",
        content: `Refines [S${sessionId}/T1].`,
        type: ["review", "design"],
        mode: { type: "write" },
        refines: [`S${sessionId}/T1`],
      },
      { now: () => 950, env: {}, eraCutoffEpoch: 1 },
    );
    expect(isNoteSuccess(passed)).toBe(true);
    expect(resultText(passed)).toContain("Attached 1 relation(s).");
  });

  // Ticket 01's own headline example (relation-matrix spec): an E->E
  // `refines` write that REJECTED before this ticket (refines was
  // decision->decision only) is now legal — exercised through the real
  // `noteTool` call path, not just the phase-table unit test.
  test("evidence -> evidence: refines is legal between two evidence-phase turns (the diagonal relaxation, was illegal pre-matrix)", () => {
    setType(earlierTurnId, ["research"]);
    setType(targetTurnId, ["measure"]);

    const legal = noteTool(
      db,
      {
        turn: `S${sessionId}/T3`,
        title: "measure+routing: a tighter measurement of the same claim",
        content: `Refines [S${sessionId}/T1].`,
        refines: [`S${sessionId}/T1`],
      },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );
    expect(resultText(legal)).toContain("Attached 1 relation(s).");
  });

  // The delivery diagonal's own new competitor: `depends-on` used to be the
  // ONLY legal word between two delivery-phase turns; now `refines` and
  // `override` are legal there too (though the caller must still pick one).
  test("delivery -> delivery: refines is now legal between two delivery-phase turns (was depends-on's exclusive cell pre-matrix)", () => {
    setType(earlierTurnId, ["implement"]);
    setType(targetTurnId, ["ops"]);

    const legal = noteTool(
      db,
      {
        turn: `S${sessionId}/T3`,
        title: "ops+routing: a follow-up rollout improving the earlier one",
        content: `Refines [S${sessionId}/T1].`,
        refines: [`S${sessionId}/T1`],
      },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );
    expect(resultText(legal)).toContain("Attached 1 relation(s).");
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
        mode: { title: "write", content: "write" },
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
        mode: { title: "write", content: "write" },
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
        mode: { title: "write", content: "write" },
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

  // T1191 (relation-matrix spec, "同流约束只压立场对"): override/refines
  // each claim ONE workflow between their two turns; segments are the
  // project's one reified workflow unit, so a stance edge whose two ends own
  // DIFFERENT segments is worth a receipt warning — never a rejection, and
  // never for depends-on or a cross-phase relation, which carry no such claim.
  describe("segment-crossing warning on the stance pair (T1191)", () => {
    test("a cross-segment override warns, naming both segments", () => {
      setType(earlierTurnId, ["design"]);
      setType(targetTurnId, ["correction"]);
      const citingSegment = createSegment(db, { title: "Citing segment", nowEpoch: 200 });
      const citedSegment = createSegment(db, { title: "Cited segment", nowEpoch: 200 });
      addSegmentMembers(db, citingSegment.id, [targetTurnId], 200);
      addSegmentMembers(db, citedSegment.id, [earlierTurnId], 200);

      const result = noteTool(
        db,
        { turn: `S${sessionId}/T3`, override: [`S${sessionId}/T1`] },
        { now: () => 900, env: {}, eraCutoffEpoch: 1 },
      );

      expect(isNoteSuccess(result)).toBe(true);
      expect(resultText(result)).toContain(
        `warning: override toward S${sessionId}/T1 crosses segments ` +
          `(E${citingSegment.id} -> E${citedSegment.id}) — the stance pair claims one workflow;` +
          " re-judge or downgrade to depends-on.",
      );
    });

    test("a cross-segment refines warns, naming both segments", () => {
      setType(earlierTurnId, ["design"]);
      setType(targetTurnId, ["design"]);
      const citingSegment = createSegment(db, { title: "Citing segment", nowEpoch: 200 });
      const citedSegment = createSegment(db, { title: "Cited segment", nowEpoch: 200 });
      addSegmentMembers(db, citingSegment.id, [targetTurnId], 200);
      addSegmentMembers(db, citedSegment.id, [earlierTurnId], 200);

      const result = noteTool(
        db,
        { turn: `S${sessionId}/T3`, refines: [`S${sessionId}/T1`] },
        { now: () => 900, env: {}, eraCutoffEpoch: 1 },
      );

      expect(isNoteSuccess(result)).toBe(true);
      expect(resultText(result)).toContain(
        `warning: refines toward S${sessionId}/T1 crosses segments ` +
          `(E${citingSegment.id} -> E${citedSegment.id})`,
      );
    });

    test("both ends of the same segment stay silent", () => {
      setType(earlierTurnId, ["design"]);
      setType(targetTurnId, ["correction"]);
      const segment = createSegment(db, { title: "Shared segment", nowEpoch: 200 });
      addSegmentMembers(db, segment.id, [targetTurnId, earlierTurnId], 200);

      const result = noteTool(
        db,
        { turn: `S${sessionId}/T3`, override: [`S${sessionId}/T1`] },
        { now: () => 900, env: {}, eraCutoffEpoch: 1 },
      );

      expect(isNoteSuccess(result)).toBe(true);
      expect(resultText(result)).toContain("Attached 1 relation(s).");
      expect(resultText(result)).not.toContain("warning:");
      expect(resultText(result)).not.toContain("crosses segments");
    });

    test("one homeless end stays silent — nothing to compare", () => {
      setType(earlierTurnId, ["design"]);
      setType(targetTurnId, ["correction"]);
      // Only the citing turn has a segment; earlierTurnId (cited) is homeless.
      const citingSegment = createSegment(db, { title: "Citing segment only", nowEpoch: 200 });
      addSegmentMembers(db, citingSegment.id, [targetTurnId], 200);

      const result = noteTool(
        db,
        { turn: `S${sessionId}/T3`, override: [`S${sessionId}/T1`] },
        { now: () => 900, env: {}, eraCutoffEpoch: 1 },
      );

      expect(isNoteSuccess(result)).toBe(true);
      expect(resultText(result)).not.toContain("warning:");
      expect(resultText(result)).not.toContain("crosses segments");
    });

    test("a cross-segment depends-on stays silent — the constraint binds only the stance pair", () => {
      setType(earlierTurnId, ["implement"]);
      setType(targetTurnId, ["implement"]);
      const citingSegment = createSegment(db, { title: "Citing segment", nowEpoch: 200 });
      const citedSegment = createSegment(db, { title: "Cited segment", nowEpoch: 200 });
      addSegmentMembers(db, citingSegment.id, [targetTurnId], 200);
      addSegmentMembers(db, citedSegment.id, [earlierTurnId], 200);

      const result = noteTool(
        db,
        { turn: `S${sessionId}/T3`, dependsOn: [`S${sessionId}/T1`] },
        { now: () => 900, env: {}, eraCutoffEpoch: 1 },
      );

      expect(isNoteSuccess(result)).toBe(true);
      expect(resultText(result)).toContain("Attached 1 relation(s).");
      expect(resultText(result)).not.toContain("warning:");
      expect(resultText(result)).not.toContain("crosses segments");
    });
  });
});

// Ticket 02 (edge-mechanism-revision D3): the retraction mirrors —
// `retract<Relation>`, address lists, same shape as the relation fields they
// undo. A relation is never overwritten, so this is the only way a wrong one
// leaves the graph.
describe("note tool relation retraction (edge-mechanism-revision D3, ticket 02)", () => {
  let db: Database;
  let sessionId: number;
  let earlierTurnId: number;
  let targetTurnId: number;

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
      contentSessionId: "note-retraction-session",
      project: "claude-mnemo",
      title: "Note retractions",
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
    targetTurnId = insertTurn.get(sessionId, 3, "The turn being noted", 110)!.id;
    setType(earlierTurnId, ["design"]);
    setType(targetTurnId, ["measure", "correction"]);
  });

  afterEach(() => {
    db.close();
  });

  function relationsOn(turnId: number): Array<string | null> {
    return getOutgoingEdges(db, { kind: "turn", id: turnId })
      .map((edge) => edge.relation)
      .sort();
  }

  test("retracts exactly the addressed relation, leaving the pair's other relation standing", () => {
    noteTool(
      db,
      {
        turn: `S${sessionId}/T3`,
        evidenceFor: [`S${sessionId}/T1`],
        override: [`S${sessionId}/T1`],
      },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );
    expect(relationsOn(targetTurnId)).toEqual(["evidence-for", "override"]);

    const result = noteTool(
      db,
      { turn: `S${sessionId}/T3`, retractOverride: [`S${sessionId}/T1`] },
      { now: () => 950, env: {}, eraCutoffEpoch: 1 },
    );

    expect(isNoteSuccess(result)).toBe(true);
    expect(resultText(result)).toContain("Retracted 1 relation(s).");
    expect(relationsOn(targetTurnId)).toEqual(["evidence-for"]);
  });

  test("a retraction naming a relation this turn does not carry is rejected by name, and deletes nothing", () => {
    noteTool(
      db,
      { turn: `S${sessionId}/T3`, override: [`S${sessionId}/T1`] },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );

    // One live relation and one that was never written, in the same call:
    // all-or-nothing, so the live one survives too.
    const result = noteTool(
      db,
      {
        turn: `S${sessionId}/T3`,
        retractOverride: [`S${sessionId}/T1`],
        retractEncodes: [`S${sessionId}/T1`],
      },
      { now: () => 950, env: {}, eraCutoffEpoch: 1 },
    );

    expect(resultText(result)).toStartWith("Parameter error:");
    expect(resultText(result)).toContain("retraction field rejected");
    expect(resultText(result)).toContain(`encodes "S${sessionId}/T1"`);
    expect(resultText(result)).toContain("not a relation this turn currently carries");
    expect(relationsOn(targetTurnId)).toEqual(["override"]);
  });

  test("retract plus attach in one call is how a wrong relation is corrected", () => {
    noteTool(
      db,
      { turn: `S${sessionId}/T3`, override: [`S${sessionId}/T1`] },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );

    const result = noteTool(
      db,
      {
        turn: `S${sessionId}/T3`,
        retractOverride: [`S${sessionId}/T1`],
        refines: [`S${sessionId}/T1`],
      },
      { now: () => 950, env: {}, eraCutoffEpoch: 1 },
    );

    expect(isNoteSuccess(result)).toBe(true);
    expect(resultText(result)).toContain("Retracted 1 relation(s).");
    expect(resultText(result)).toContain("Attached 1 relation(s).");
    expect(relationsOn(targetTurnId)).toEqual(["refines"]);
  });

  test("a retraction addressed at another session's turn needs the crossSession confirmation", () => {
    noteTool(
      db,
      { turn: `S${sessionId}/T3`, override: [`S${sessionId}/T1`] },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );
    const otherSessionId = upsertSession(db, {
      contentSessionId: "note-retraction-other",
      project: "claude-mnemo",
      title: "Another session",
      content: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 110,
      completedAtEpoch: null,
    }).id;

    const result = noteTool(
      db,
      { turn: `S${sessionId}/T3`, retractOverride: [`S${sessionId}/T1`] },
      { now: () => 950, env: {}, eraCutoffEpoch: 1, callerSessionId: otherSessionId },
    );

    expect(resultText(result)).toStartWith("Parameter error:");
    expect(resultText(result)).toContain("crossSession: true");
    expect(relationsOn(targetTurnId)).toEqual(["override"]);
  });
});

// Ticket 02 (edge-mechanism-revision D1, spec user story 17 / [S15069/T1124]):
// an edge write is gated on the CITING turn — the turn whose record grows or
// loses an edge — under the existing read-grant rules. The CITED turn gets no
// read check at all, which is the ruling's other half.
describe("note tool edge writes go through the citing turn's write gate (ticket 02)", () => {
  let db: Database;
  let sessionA: number;
  let sessionB: number;
  let citingTurnId: number;

  function insertTurn(sessionId: number, promptNumber: number): number {
    return db
      .query<{ id: number }, [number, number]>(
        `INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch)
         VALUES (?, ?, 'extracted', 'p', 100) RETURNING id`,
      )
      .get(sessionId, promptNumber)!.id;
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionA = upsertSession(db, {
      contentSessionId: "edge-gate-a",
      project: "/tmp/edge-gate",
      title: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    }).id;
    sessionB = upsertSession(db, {
      contentSessionId: "edge-gate-b",
      project: "/tmp/edge-gate",
      title: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    }).id;
    insertTurn(sessionA, 1);
    citingTurnId = insertTurn(sessionA, 2);
    // Session A owns both turns' `type` — the field the gate judges an edge
    // write by, and the field every note write stamps.
    noteTool(db, { turn: `S${sessionA}/T1`, type: ["design"] }, { callerSessionId: sessionA });
    noteTool(
      db,
      { turn: `S${sessionA}/T2`, type: ["correction"] },
      { callerSessionId: sessionA },
    );
  });

  afterEach(() => {
    db.close();
  });

  test("a pure relation call on a turn another writer owns, never read, is refused", () => {
    const result = noteTool(
      db,
      {
        turn: `S${sessionA}/T2`,
        override: [`S${sessionA}/T1`],
        crossSession: true,
      },
      { callerSessionId: sessionB },
    );

    expect(resultText(result)).toStartWith("Parameter error:");
    expect(resultText(result)).toContain("has not been read this session");
    expect(getOutgoingEdges(db, { kind: "turn", id: citingTurnId })).toEqual([]);
  });

  test("the same call lands once the caller has read the citing turn — and the CITED turn is never read at all", () => {
    recallMemory(db, { id: `S${sessionA}/T2`, readerId: sessionWriterId(sessionB) });

    const result = noteTool(
      db,
      {
        turn: `S${sessionA}/T2`,
        override: [`S${sessionA}/T1`],
        crossSession: true,
      },
      { callerSessionId: sessionB },
    );

    expect(isNoteSuccess(result)).toBe(true);
    expect(resultText(result)).toContain("Attached 1 relation(s).");
    expect(getOutgoingEdges(db, { kind: "turn", id: citingTurnId })).toHaveLength(1);
  });

  test("a pure retraction call is gated identically", () => {
    // Session A writes the edge it owns.
    noteTool(
      db,
      { turn: `S${sessionA}/T2`, override: [`S${sessionA}/T1`] },
      { callerSessionId: sessionA },
    );

    const refused = noteTool(
      db,
      {
        turn: `S${sessionA}/T2`,
        retractOverride: [`S${sessionA}/T1`],
        crossSession: true,
      },
      { callerSessionId: sessionB },
    );
    expect(resultText(refused)).toStartWith("Parameter error:");
    expect(resultText(refused)).toContain("has not been read this session");
    expect(getOutgoingEdges(db, { kind: "turn", id: citingTurnId })).toHaveLength(1);

    // Read it, and the retraction lands — both writers hold the same power
    // over an edge, whoever asserted it ([S15069/T1124]).
    recallMemory(db, { id: `S${sessionA}/T2`, readerId: sessionWriterId(sessionB) });
    const retracted = noteTool(
      db,
      {
        turn: `S${sessionA}/T2`,
        retractOverride: [`S${sessionA}/T1`],
        crossSession: true,
      },
      { callerSessionId: sessionB },
    );
    expect(isNoteSuccess(retracted)).toBe(true);
    expect(resultText(retracted)).toContain("Retracted 1 relation(s).");
    expect(getOutgoingEdges(db, { kind: "turn", id: citingTurnId })).toEqual([]);
  });
});

// ticket 03 (spec E1): `note` and the retired `remember` are one tool. These
// tests cover the acceptance criteria that neither the pre-existing note.test
// suite nor era-cutover.test.ts happen to exercise: that the old entry point
// is actually gone (not merely unused), the mode requirement on a NON-empty
// field for both a turn and a session, the edit form changing part of a
// field versus `write` replacing it whole (with the stored value checked
// after each — ticket 05 rewrote this half: `append`/`overwrite` retired,
// see "the edit form changes a span, write replaces it whole" below), the
// receipt reporting a post-write total rather than a delta, and content
// carrying tool-call syntax being rejected outright.
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
        mode: { title: "write" },
      } as never);
      expect(resultText(withMode)).toContain("session writes retired");
    });
  });

  // Ticket 05 (write-mode-edit-semantics, spec D1/D3/D4): `append`/
  // `overwrite` retired outright — this block used to be "append
  // accumulates, overwrite replaces" (ticket 03's acceptance criterion 4).
  // Rewritten rather than deleted: the edit form is `append`'s nearest
  // functional successor for a prose field (grow it without resupplying the
  // whole text), and D4 means a set field (tags) gets no such successor at
  // all — `edit` is refused there outright, `write` is the only verb.
  describe("the edit form changes a span, write replaces it whole", () => {
    test("a string field (turn content): edit swaps an exact span, write replaces the whole field", () => {
      noteTool(db, { turn: `S${sessionId}/T1`, title: "t", content: "first" });
      expect(getShadowNote(db, turnId)?.content).toBe("first");

      noteTool(db, {
        turn: `S${sessionId}/T1`,
        mode: {
          content: { mode: "edit", oldString: "first", newString: "first\nsecond" },
        },
      });
      expect(getShadowNote(db, turnId)?.content).toBe("first\nsecond");

      noteTool(db, {
        turn: `S${sessionId}/T1`,
        content: "third",
        mode: { content: "write" },
      });
      expect(getShadowNote(db, turnId)?.content).toBe("third");
    });

    // Ticket 05 (spec D4): tags is a SET field — the edit form has no
    // "span" to match inside a list, so it is refused outright rather than
    // given a set-flavoured meaning (element add/remove) of its own. `write`
    // is the only way to change it, and always states the full replacement
    // set (the accepted cost of D4's ruling).
    test("a set field (turn tags): edit is refused, write replaces the whole set", () => {
      noteTool(db, {
        turn: `S${sessionId}/T1`,
        title: "t",
        content: "c",
        tags: ["auth"],
      });
      expect(getTurnById(db, turnId)!.tags).toEqual(["auth"]);

      const rejected = noteTool(db, {
        turn: `S${sessionId}/T1`,
        mode: { tags: { mode: "edit", oldString: "auth", newString: "authn" } },
      });
      expect(resultText(rejected)).toStartWith("Parameter error:");
      expect(resultText(rejected)).toContain("mode.tags");
      expect(resultText(rejected)).toContain("set field");
      expect(getTurnById(db, turnId)!.tags).toEqual(["auth"]); // untouched by the rejected call

      noteTool(db, {
        turn: `S${sessionId}/T1`,
        tags: ["auth", "concurrency"],
        mode: { tags: "write" },
      });
      expect(getTurnById(db, turnId)!.tags).toEqual(["auth", "concurrency"]);

      noteTool(db, {
        turn: `S${sessionId}/T1`,
        tags: ["delivery"],
        mode: { tags: "write" },
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

  // Acceptance criterion 6 (ticket 03), ported onto the edit form by ticket
  // 05 (`append` is gone): the receipt reports a grown field's total after
  // the write, not the size of the span just changed.
  test("the receipt reports the post-write total after an edit, not the size of the changed span", () => {
    noteTool(db, { turn: `S${sessionId}/T1`, title: "t", content: "a".repeat(40) });
    const result = noteTool(db, {
      turn: `S${sessionId}/T1`,
      mode: {
        content: {
          mode: "edit",
          oldString: "a".repeat(40),
          newString: `${"a".repeat(40)}\n${"b".repeat(40)}`,
        },
      },
    });

    const stored = getShadowNote(db, turnId)!.content;
    expect(stored.replace(/\n/g, "").length).toBe(80); // both halves survive
    // The receipt's content count reflects the full 80+1(newline) characters
    // now stored (~21 tok at 4 chars/tok), not merely the 40 characters the
    // edit's `newString` added — a writer growing a field one edit at a time
    // must see the total it has reached, not the size of its own last call.
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

// ---------------------------------------------------------------------------
// Write gate (ticket 03, read-write-contract spec) — `note`'s turn-write
// surface, both cross- and same-session. `.scratch/read-write-contract/
// spec.md` "受管面" / "crossSession 旗保留".
// ---------------------------------------------------------------------------

describe("note tool write gate (ticket 03)", () => {
  let db: Database;
  let sessionA: number;
  let sessionB: number;

  function insertTurn(sessionId: number, promptNumber: number, createdAtEpoch = 100): number {
    return db
      .query<{ id: number }, [number, number, number]>(
        `INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch)
         VALUES (?, ?, 'active', 'p', ?) RETURNING id`,
      )
      .get(sessionId, promptNumber, createdAtEpoch)!.id;
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionA = upsertSession(db, {
      contentSessionId: "gate-a",
      project: "/tmp/gate",
      title: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    }).id;
    sessionB = upsertSession(db, {
      contentSessionId: "gate-b",
      project: "/tmp/gate",
      title: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  describe("same-session writes hit zero gate friction", () => {
    test("first write on a field never written by anyone admits with no read at all", () => {
      insertTurn(sessionA, 1);
      const result = noteTool(
        db,
        { turn: `S${sessionA}/T1`, type: ["design"] },
        { callerSessionId: sessionA },
      );
      expect(isNoteSuccess(result)).toBe(true);
    });

    test("the same session may keep rewriting a field it last wrote, with no read in between", () => {
      const turnId = insertTurn(sessionA, 1);
      noteTool(db, { turn: `S${sessionA}/T1`, type: ["design"] }, { callerSessionId: sessionA });
      const result = noteTool(
        db,
        { turn: `S${sessionA}/T1`, type: ["fix"], mode: { type: "write" } },
        { callerSessionId: sessionA },
      );
      expect(isNoteSuccess(result)).toBe(true);
      expect(getTurnById(db, turnId)?.type).toEqual(["fix"]);
    });
  });

  describe("cross-session writes: three combinations of grant and the crossSession flag", () => {
    test("no read at all: rejected by the gate itself even with crossSession declared — never-read", () => {
      const turnId = insertTurn(sessionA, 1);
      noteTool(db, { turn: `S${sessionA}/T1`, type: ["design"] }, { callerSessionId: sessionA });

      const result = noteTool(
        db,
        { turn: `S${sessionA}/T1`, type: ["fix"], mode: { type: "write" }, crossSession: true },
        { callerSessionId: sessionB },
      );

      expect(resultText(result)).toStartWith("Parameter error:");
      expect(resultText(result)).toContain("recall");
      expect(getTurnById(db, turnId)?.type).toEqual(["design"]);
    });

    test("read, but no crossSession flag: blocked by the flag, before the gate ever runs", () => {
      const turnId = insertTurn(sessionA, 1);
      recallMemory(db, { id: `S${sessionA}/T1`, readerId: sessionWriterId(sessionB) });

      const result = noteTool(
        db,
        { turn: `S${sessionA}/T1`, type: ["design"] },
        { callerSessionId: sessionB },
      );

      expect(resultText(result)).toStartWith("Parameter error:");
      expect(resultText(result)).toContain("crossSession: true");
      expect(getTurnById(db, turnId)?.type).toEqual([]);
    });

    test("both read AND crossSession declared: admitted", () => {
      insertTurn(sessionA, 1);
      recallMemory(db, { id: `S${sessionA}/T1`, readerId: sessionWriterId(sessionB) });

      const result = noteTool(
        db,
        { turn: `S${sessionA}/T1`, type: ["design"], crossSession: true },
        { callerSessionId: sessionB },
      );

      expect(isNoteSuccess(result)).toBe(true);
    });
  });

  test("a grant that predates a later write by someone else is stale — distinguishable from never-read", () => {
    const turnId = insertTurn(sessionA, 1);
    recallMemory(db, { id: `S${sessionA}/T1`, readerId: sessionWriterId(sessionB) });
    noteTool(db, { turn: `S${sessionA}/T1`, type: ["design"] }, { callerSessionId: sessionA });

    const result = noteTool(
      db,
      { turn: `S${sessionA}/T1`, type: ["fix"], mode: { type: "write" }, crossSession: true },
      { callerSessionId: sessionB },
    );

    expect(resultText(result)).toStartWith("Parameter error:");
    expect(resultText(result)).toContain("type");
    expect(resultText(result)).toContain(`S${sessionA}`);
    expect(resultText(result)).toContain("recall");
    expect(getTurnById(db, turnId)?.type).toEqual(["design"]);

    // Re-reading clears the staleness — the write proceeds. Ticket 06: the
    // re-read must also DELIVER `type`, which rides the metadata line, or the
    // retry trades its stale rejection for an incomplete-read one (pinned by
    // "note write gate: the complete-read requirement" below).
    recallMemory(db, {
      id: `S${sessionA}/T1`,
      filter: { fields: ["metadata"] },
      readerId: sessionWriterId(sessionB),
    });
    const retried = noteTool(
      db,
      { turn: `S${sessionA}/T1`, type: ["fix"], mode: { type: "write" }, crossSession: true },
      { callerSessionId: sessionB },
    );
    expect(isNoteSuccess(retried)).toBe(true);
    expect(getTurnById(db, turnId)?.type).toEqual(["fix"]);
  });

  test("posting a note stamps type/tags too even when this call only touched prose — subsumption", () => {
    const turnId = insertTurn(sessionA, 1);
    noteTool(
      db,
      { turn: `S${sessionA}/T1`, title: "t", content: "c" },
      { callerSessionId: sessionA },
    );

    const stampedFields = db
      .query<{ field: string }, [number]>(
        `SELECT field FROM write_gate_stamps WHERE entity_type = 'turn' AND entity_id = ? ORDER BY field`,
      )
      .all(turnId)
      .map((row) => row.field);

    expect(stampedFields).toContain("type");
    expect(stampedFields).toContain("tags");
  });

  test("an explicit null-clear stamps the field — 'cleared' reads as written, not as never-written", () => {
    const turnId = insertTurn(sessionA, 1);
    noteTool(
      db,
      { turn: `S${sessionA}/T1`, title: "t", content: "c", insight: "first insight" },
      { callerSessionId: sessionA },
    );
    noteTool(
      db,
      { turn: `S${sessionA}/T1`, insight: null, mode: { insight: "write" } },
      { callerSessionId: sessionA },
    );

    // A second session, never having read this turn, tries to write insight.
    // If the clear had left the field looking "never written", rule 3 would
    // wrongly admit this blind write; instead it is rejected as never-read.
    const result = noteTool(
      db,
      { turn: `S${sessionA}/T1`, insight: "blind overwrite", crossSession: true },
      { callerSessionId: sessionB },
    );
    expect(resultText(result)).toStartWith("Parameter error:");
    expect(resultText(result)).toContain("recall");
    // The blocked write never landed — insight is still cleared, not
    // overwritten with the blind session's text.
    expect(getShadowNote(db, turnId)?.insight ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Ticket 06 (write-mode-edit-semantics spec D2/D5/D6): the gate judges both
// modes identically for authorization and staleness; `write` alone
// additionally needs the granting render to have shown THAT field whole.
// Everything here goes through real `recallMemory` renders — a hand-written
// completeness row would prove only what tests/db/write-gate.test.ts already
// proves in isolation, not that a writer can actually earn one by reading.
// ---------------------------------------------------------------------------

describe("note write gate: the complete-read requirement (ticket 06)", () => {
  let db: Database;
  let sessionA: number;
  let sessionB: number;
  const ERA = { eraCutoffEpoch: 1 };

  function insertTurn(sessionId: number, promptNumber: number): number {
    return db
      .query<{ id: number }, [number, number]>(
        `INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch)
         VALUES (?, ?, 'active', 'p', 100) RETURNING id`,
      )
      .get(sessionId, promptNumber)!.id;
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionA = upsertSession(db, {
      contentSessionId: "complete-read-a",
      project: "/tmp/complete-read",
      title: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    }).id;
    sessionB = upsertSession(db, {
      contentSessionId: "complete-read-b",
      project: "/tmp/complete-read",
      title: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  /** A's note on a fresh turn, long enough that a tight budget must cut it. */
  function seedLongNoteFromA(): { address: string; turnId: number } {
    const turnId = insertTurn(sessionA, 1);
    const address = `S${sessionA}/T1`;
    noteTool(
      db,
      {
        turn: address,
        title: "A's title",
        content: Array.from({ length: 40 }, (_, i) => `- row ${i} of A's content`).join("\n"),
      },
      { callerSessionId: sessionA, ...ERA },
    );
    return { address, turnId };
  }

  test("a truncated read refuses the overwrite and names the field; a complete read admits the same write", () => {
    const { address, turnId } = seedLongNoteFromA();

    // B reads it, but under a per-item budget too small to deliver `content`.
    recallMemory(db, {
      id: address,
      filter: { fields: ["content"] },
      turn: 20,
      readerId: sessionWriterId(sessionB),
    });

    const refused = resultText(
      noteTool(
        db,
        {
          turn: address,
          content: "- B replaces the whole thing",
          mode: { content: "write" },
          crossSession: true,
        },
        { callerSessionId: sessionB, ...ERA },
      ),
    );
    expect(refused).toStartWith("Parameter error:");
    expect(refused).toContain("content");
    expect(refused).toContain(address);
    expect(refused).toContain("recall");
    // Nothing landed: A's rows are all still there.
    expect(getShadowNote(db, turnId)?.content).toContain("- row 39 of A's content");

    // The remedy the message names actually clears it.
    recallMemory(db, {
      id: address,
      filter: { fields: ["content"] },
      turn: 4000,
      readerId: sessionWriterId(sessionB),
    });
    const admitted = noteTool(
      db,
      {
        turn: address,
        content: "- B replaces the whole thing",
        mode: { content: "write" },
        crossSession: true,
      },
      { callerSessionId: sessionB, ...ERA },
    );
    expect(isNoteSuccess(admitted)).toBe(true);
    expect(getShadowNote(db, turnId)?.content).toBe("- B replaces the whole thing");
  });

  test("under that SAME truncated read an `edit` is admitted — the read requirement is the modes' only difference", () => {
    const { address, turnId } = seedLongNoteFromA();
    recallMemory(db, {
      id: address,
      filter: { fields: ["content"] },
      turn: 20,
      readerId: sessionWriterId(sessionB),
    });

    const result = noteTool(
      db,
      {
        turn: address,
        mode: {
          content: { mode: "edit", oldString: "- row 0 of A's content", newString: "- row 0, edited by B" },
        },
        crossSession: true,
      },
      { callerSessionId: sessionB, ...ERA },
    );

    expect(isNoteSuccess(result)).toBe(true);
    const stored = getShadowNote(db, turnId)!.content;
    expect(stored).toContain("- row 0, edited by B");
    // The rows B never saw are untouched — which is exactly why `edit` needs
    // no complete read.
    expect(stored).toContain("- row 39 of A's content");
  });

  test("an `edit` success stamps the field, and the next writer is judged stale against it", () => {
    const { address } = seedLongNoteFromA();
    recallMemory(db, {
      id: address,
      filter: { fields: ["content"] },
      turn: 4000,
      readerId: sessionWriterId(sessionB),
    });
    // A holds a grant of its own, taken before B's edit lands.
    recallMemory(db, {
      id: address,
      filter: { fields: ["content"] },
      turn: 4000,
      readerId: sessionWriterId(sessionA),
    });

    const edited = noteTool(
      db,
      {
        turn: address,
        mode: {
          content: { mode: "edit", oldString: "- row 1 of A's content", newString: "- row 1, B was here" },
        },
        crossSession: true,
      },
      { callerSessionId: sessionB, ...ERA },
    );
    expect(isNoteSuccess(edited)).toBe(true);

    const stale = resultText(
      noteTool(
        db,
        {
          turn: address,
          mode: {
            content: { mode: "edit", oldString: "- row 2 of A's content", newString: "- row 2, A again" },
          },
        },
        { callerSessionId: sessionA, ...ERA },
      ),
    );
    expect(stale).toStartWith("Parameter error:");
    expect(stale).toContain(`S${sessionB}`);
    expect(stale).toContain("content");
  });

  test("a field cleared to empty is exempt: the overwrite lands on a truncated read, because there is nothing left to lose", () => {
    const { address, turnId } = seedLongNoteFromA();
    // A gives the turn an insight, then clears it. The field is now WRITTEN
    // (A's stamp stands) but empty.
    noteTool(
      db,
      { turn: address, insight: "- A's first insight" },
      { callerSessionId: sessionA, ...ERA },
    );
    noteTool(
      db,
      { turn: address, insight: null, mode: { insight: "write" } },
      { callerSessionId: sessionA, ...ERA },
    );

    // B's read is deliberately budget-starved; `insight` is not even selected.
    recallMemory(db, {
      id: address,
      filter: { fields: ["content"] },
      turn: 20,
      readerId: sessionWriterId(sessionB),
    });

    const result = noteTool(
      db,
      { turn: address, insight: "- B writes the first insight since the clear", crossSession: true },
      { callerSessionId: sessionB, ...ERA },
    );

    expect(isNoteSuccess(result)).toBe(true);
    expect(getShadowNote(db, turnId)?.insight).toBe(
      "- B writes the first insight since the clear",
    );
  });

  test("a long field's truncation does not block a short field's write on the same turn", () => {
    const { address, turnId } = seedLongNoteFromA();

    // One read, one budget: `content` is cut, `title` is the row label and
    // always arrives whole.
    recallMemory(db, {
      id: address,
      filter: { fields: ["title", "content"] },
      turn: 20,
      readerId: sessionWriterId(sessionB),
    });

    const titleWrite = noteTool(
      db,
      { turn: address, title: "B's title", mode: { title: "write" }, crossSession: true },
      { callerSessionId: sessionB, ...ERA },
    );
    expect(isNoteSuccess(titleWrite)).toBe(true);
    expect(getShadowNote(db, turnId)?.title).toBe("B's title");

    // Same grant, same call shape, the long field: still refused.
    const contentWrite = resultText(
      noteTool(
        db,
        {
          turn: address,
          content: "- B replaces the whole thing",
          mode: { content: "write" },
          crossSession: true,
        },
        { callerSessionId: sessionB, ...ERA },
      ),
    );
    expect(contentWrite).toStartWith("Parameter error:");
    expect(contentWrite).toContain("content");
  });

  test("type/tags: the metadata line is what earns their completeness, and the rejection says so", () => {
    const turnId = insertTurn(sessionA, 1);
    const address = `S${sessionA}/T1`;
    noteTool(
      db,
      { turn: address, type: ["design", "review"], tags: ["alpha", "bravo"] },
      { callerSessionId: sessionA, ...ERA },
    );

    // B reads the turn the ordinary way — no metadata line, so `type` was
    // never delivered at all.
    recallMemory(db, {
      id: address,
      filter: { fields: ["content"] },
      readerId: sessionWriterId(sessionB),
    });
    const refused = resultText(
      noteTool(
        db,
        { turn: address, type: ["fix"], mode: { type: "write" }, crossSession: true },
        { callerSessionId: sessionB, ...ERA },
      ),
    );
    expect(refused).toStartWith("Parameter error:");
    expect(refused).toContain("type");
    // The remedy has to name the read that can actually deliver it, or the
    // writer re-reads forever: type/tags have no `filter.fields` slot of
    // their own.
    expect(refused).toContain("metadata");
    expect(getTurnById(db, turnId)?.type).toEqual(["design", "review"]);

    recallMemory(db, {
      id: address,
      filter: { fields: ["metadata"] },
      turn: 4000,
      readerId: sessionWriterId(sessionB),
    });
    const admitted = noteTool(
      db,
      { turn: address, type: ["fix"], mode: { type: "write" }, crossSession: true },
      { callerSessionId: sessionB, ...ERA },
    );
    expect(isNoteSuccess(admitted)).toBe(true);
    expect(getTurnById(db, turnId)?.type).toEqual(["fix"]);
  });

  test("the same session keeps writing its own fields with no read at all — writing is reading is untouched", () => {
    const { address, turnId } = seedLongNoteFromA();

    const rewrite = noteTool(
      db,
      { turn: address, content: "- A rewrites its own field", mode: { content: "write" } },
      { callerSessionId: sessionA, ...ERA },
    );
    expect(isNoteSuccess(rewrite)).toBe(true);

    const reedit = noteTool(
      db,
      {
        turn: address,
        mode: {
          content: { mode: "edit", oldString: "own field", newString: "own field again" },
        },
      },
      { callerSessionId: sessionA, ...ERA },
    );
    expect(isNoteSuccess(reedit)).toBe(true);
    expect(getShadowNote(db, turnId)?.content).toBe("- A rewrites its own field again");
  });
});

// Ticket 05 (write-mode-edit-semantics, spec D1/D3/D4/D10/D14): the
// vocabulary switch itself. "the edit form changes a span, write replaces
// it whole" (above) proves the new verbs work end to end; these tests pin
// the four traps the ticket named as the ones that fail silently rather
// than loudly if missed.
describe("write/edit vocabulary switch (ticket 05)", () => {
  let db: Database;
  let sessionId: number;
  let turnId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    sessionId = upsertSession(db, {
      contentSessionId: "vocab-switch-session",
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

  // Trap #1 (the ticket's own framing): note.ts's resolver used to treat ANY
  // non-`append` mode as a whole overwrite. This pins that `mode: "edit"`
  // changes ONLY the matched span — a regression here means the resolver
  // fell back onto that old branch and silently overwrote the whole field.
  test("regression: mode 'edit' never degenerates into a whole-field overwrite", () => {
    noteTool(db, {
      turn: `S${sessionId}/T1`,
      title: "t",
      content: "The quick brown fox jumps over the lazy dog.",
    });

    noteTool(db, {
      turn: `S${sessionId}/T1`,
      mode: {
        content: { mode: "edit", oldString: "lazy dog", newString: "sleeping dog" },
      },
    });

    expect(getShadowNote(db, turnId)?.content).toBe(
      "The quick brown fox jumps over the sleeping dog.",
    );
  });

  test("edit's three states: unique hit succeeds, no hit rejects naming oldString, ambiguous rejects naming the count", () => {
    noteTool(db, { turn: `S${sessionId}/T1`, title: "t", content: "alpha beta alpha" });

    const missing = noteTool(db, {
      turn: `S${sessionId}/T1`,
      mode: { content: { mode: "edit", oldString: "gamma", newString: "delta" } },
    });
    expect(resultText(missing)).toStartWith("Parameter error:");
    expect(resultText(missing)).toContain("gamma");
    expect(resultText(missing)).toContain("not found");

    const ambiguous = noteTool(db, {
      turn: `S${sessionId}/T1`,
      mode: { content: { mode: "edit", oldString: "alpha", newString: "omega" } },
    });
    expect(resultText(ambiguous)).toStartWith("Parameter error:");
    expect(resultText(ambiguous)).toContain("2 times");
    expect(getShadowNote(db, turnId)?.content).toBe("alpha beta alpha"); // untouched by either rejection

    const ok = noteTool(db, {
      turn: `S${sessionId}/T1`,
      mode: { content: { mode: "edit", oldString: "beta", newString: "gamma" } },
    });
    expect(isNoteSuccess(ok)).toBe(true);
    expect(getShadowNote(db, turnId)?.content).toBe("alpha gamma alpha");
  });

  // D10: the edit form's payload lives entirely in `mode.<field>` — the
  // field's own value is not also supplied. This combo is a parameter
  // error, not "value wins" or "edit wins" silently.
  test("a field value supplied together with its edit form is a parameter error", () => {
    noteTool(db, { turn: `S${sessionId}/T1`, title: "t", content: "first" });

    const result = noteTool(db, {
      turn: `S${sessionId}/T1`,
      content: "second",
      mode: { content: { mode: "edit", oldString: "first", newString: "second" } },
    });
    expect(resultText(result)).toStartWith("Parameter error:");
    expect(resultText(result)).toContain("newString");
    expect(getShadowNote(db, turnId)?.content).toBe("first"); // untouched
  });

  // D14: the retired literals stay in the vocabulary with a message naming
  // their replacement, not a generic "must be ..." error — checked at the
  // runtime entry point (`noteTool` itself), since most of this suite calls
  // it directly rather than through `noteInputSchema`. definitions.test.ts
  // covers the schema-layer copy of the same rejection.
  test("the retired mode literals 'overwrite' and 'append' each name their replacement", () => {
    noteTool(db, { turn: `S${sessionId}/T1`, title: "t", content: "first" });

    const overwrite = noteTool(db, {
      turn: `S${sessionId}/T1`,
      content: "second",
      mode: { content: "overwrite" },
    });
    expect(resultText(overwrite)).toStartWith("Parameter error:");
    expect(resultText(overwrite)).toContain("retired");
    expect(resultText(overwrite)).toContain('"write"');

    const append = noteTool(db, {
      turn: `S${sessionId}/T1`,
      content: "second",
      mode: { content: "append" },
    });
    expect(resultText(append)).toStartWith("Parameter error:");
    expect(resultText(append)).toContain("retired");
    expect(resultText(append)).toContain('"write"');
    expect(resultText(append)).toContain("edit");

    expect(getShadowNote(db, turnId)?.content).toBe("first"); // neither call landed
  });
});
