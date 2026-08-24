import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { getOutgoingEdges, writeMemoryEdges } from "../../src/db/memory-edges";
import { getNoteDebt, listOwedNoteTurns } from "../../src/db/note-debt";
import { initializeSchema } from "../../src/db/schema";
import {
  attachSegmentToSession,
  createSegment,
  getSegmentMemberTurnIds,
} from "../../src/db/segments";
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
    //
    // write-gate-hardening ticket 01 REORDERED this list (and nothing else —
    // same keys, same field objects): the long prose fields moved to the end,
    // `content` dead last. The order is what the model reads off the
    // serialized schema, and a long value's closing boundary is where the
    // serialization drifts into a field-named closing tag. See
    // `tests/mcp/definitions.test.ts` for the serialized-order pin this one's
    // shape-level list backs up.
    expect(Object.keys(noteInputSchema.shape)).toEqual([
      "turn",
      "title",
      "skip",
      "crossSession",
      "segment",
      "type",
      "tags",
      "mode",
      "override",
      "narrows",
      "extends",
      "indexes",
      "consume",
      "grounds",
      "verifies",
      "refutes",
      "retractOverride",
      "retractNarrows",
      "retractExtends",
      "retractIndexes",
      "retractConsume",
      "retractGrounds",
      "retractVerifies",
      "retractRefutes",
      // Peer round T1466 (finding P1-2): the retraction-only ninth mirror.
      // It has no assertion twin above and must never gain one — the frozen
      // `supersedes` word stays deletable so a window owning a legacy row can
      // clear its E2 and commit at all.
      "retractSupersedes",
      "insight",
      "content",
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
        id: expect.any(Number),
        citing: { kind: "turn", id: targetTurnId },
        cited: { kind: "turn", id: citedTurnId },
        relation: null,
        tags: [],
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

  // rubric-v10 ticket 02: Gate B's subset invariant reads a turn's OWN
  // `tags` column directly (not through the note write path, so a fixture
  // can set them without going through the write gate).
  function setTags(turnId: number, tags: readonly string[]): void {
    db.query<unknown, [string, number]>("UPDATE turns SET tags = ? WHERE id = ?").run(
      JSON.stringify(tags),
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
  // (evidence + delivery): `refutes` needs an evidence-phase source and a
  // decision/delivery target (T1215 — design here), and `consume` needs a phase the citing
  // turn shares with its own target — both hold in the one call, the
  // exists-rule.
  test("distinct fields for distinct targets land distinct relations in one call", () => {
    setType(targetTurnId, ["measure", "implement"]);
    setType(earlierTurnId, ["design"]);
    setType(anotherEarlierTurnId, ["fix"]);

    const result = noteTool(
      db,
      {
        turn: `S${sessionId}/T3`,
        title: "measure+implement: two claims at once",
        content: `Tested [S${sessionId}/T1] and used [S${sessionId}/T2].`,
        refutes: [`S${sessionId}/T1`],
        consume: [`S${sessionId}/T2`],
      },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );

    expect(isNoteSuccess(result)).toBe(true);
    const edges = getOutgoingEdges(db, { kind: "turn", id: targetTurnId });
    const byTarget = new Map(edges.map((edge) => [edge.cited.id, edge.relation]));
    expect(byTarget.get(earlierTurnId)).toBe("refutes");
    expect(byTarget.get(anotherEarlierTurnId)).toBe("consume");
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
  // relations. `verifies` needs an evidence-phase source; `override` needs a
  // phase the citing turn shares with its target — both hold at once.
  test("two relation fields naming the SAME target both land, as two coexisting rows", () => {
    setType(targetTurnId, ["measure", "correction"]);
    setType(earlierTurnId, ["design"]);

    const result = noteTool(
      db,
      {
        turn: `S${sessionId}/T3`,
        title: "measure+correction: two claims about one predecessor",
        content: "Tested it, then overturned it.",
        verifies: [`S${sessionId}/T1`],
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
    expect(relations).toEqual(["override", "verifies"]);
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
        grounds: [`S${sessionId}/T1`],
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
    expect(relations).toEqual(["grounds", "override"]);
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
    expect(resultText(result)).toContain("only `grounds` may ever cite the citing turn itself");
    expect(getOutgoingEdges(db, { kind: "turn", id: targetTurnId })).toEqual([]);
  });

  // rubric-v10 ticket 02 ("自引用", Gate C); round-4 review #1 hardened it:
  // only `grounds` may ever self-cite, and legality now rests on TWO
  // conditions — the implementer half (the citing turn's own type carries a
  // delivery-phase word, checked pre-write) and the settlement half (after
  // every edge this call writes has landed, the citing turn is the CURRENT
  // terminus of a lane it declared via a TAGGED `indexes` edge of its own,
  // declared in this same call or already stored). `targetTurnId` is a
  // COMPOSITE node here (`design` + `implement`) — both halves at once, the
  // old flow-derived settlement+implementer reading's surviving shape.
  test("a single call carrying a tagged-indexes declaration plus self-grounds passes, in one atomic write", () => {
    setType(targetTurnId, ["design", "implement"]);
    setType(earlierTurnId, ["design"]);
    setTags(targetTurnId, ["lane-a"]);
    setTags(earlierTurnId, ["lane-a"]);

    const result = noteTool(
      db,
      {
        turn: `S${sessionId}/T3`,
        indexes: [{ turn: `S${sessionId}/T1`, tags: ["lane-a"] }],
        grounds: [`S${sessionId}/T3`],
      },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );

    expect(isNoteSuccess(result)).toBe(true);
    const edges = getOutgoingEdges(db, { kind: "turn", id: targetTurnId });
    expect(edges.some((edge) => edge.relation === "grounds" && edge.cited.id === targetTurnId)).toBe(
      true,
    );
    expect(
      edges.some(
        (edge) =>
          edge.relation === "indexes" && edge.cited.id === earlierTurnId && edge.tags.includes("lane-a"),
      ),
    ).toBe(true);
  });

  // Mutation-critical (ticket's own acceptance criterion): with the
  // terminus-declaring edge absent, the SAME self-grounds still rejects — if
  // Gate C were disabled (admitted unconditionally) this test would flip to
  // a false pass. `targetTurnId` carries `implement` too so this exercises
  // Gate C specifically, not the (separate) pre-write delivery-phase gate.
  test("the same self-grounds WITHOUT any terminus-declaring edge in the post-transaction graph still rejects", () => {
    setType(targetTurnId, ["design", "implement"]);

    const result = noteTool(
      db,
      { turn: `S${sessionId}/T3`, grounds: [`S${sessionId}/T3`] },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );

    expect(resultText(result)).toStartWith("Parameter error:");
    expect(resultText(result)).toContain(`grounds "S${sessionId}/T3"`);
    expect(resultText(result)).toContain("TAGGED");
    expect(resultText(result)).toContain("indexes");
    expect(getOutgoingEdges(db, { kind: "turn", id: targetTurnId })).toEqual([]);
  });

  test("self-grounds passes when the tagged-indexes terminus was already stored from an EARLIER call", () => {
    setType(targetTurnId, ["design", "implement"]);
    setType(earlierTurnId, ["design"]);
    setTags(targetTurnId, ["lane-a"]);
    setTags(earlierTurnId, ["lane-a"]);

    noteTool(
      db,
      { turn: `S${sessionId}/T3`, indexes: [{ turn: `S${sessionId}/T1`, tags: ["lane-a"] }] },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );

    const result = noteTool(
      db,
      { turn: `S${sessionId}/T3`, grounds: [`S${sessionId}/T3`] },
      { now: () => 910, env: {}, eraCutoffEpoch: 1 },
    );

    expect(isNoteSuccess(result)).toBe(true);
    expect(
      getOutgoingEdges(db, { kind: "turn", id: targetTurnId }).some(
        (edge) => edge.relation === "grounds" && edge.cited.id === targetTurnId,
      ),
    ).toBe(true);
  });

  // An UNTAGGED indexes edge is free aggregation, never a terminus
  // declaration (draft-lane-model.md's 统一解读原则) — it must not satisfy
  // Gate C. `implement` is on `targetTurnId` too, for the same reason as
  // above: isolate Gate C from the pre-write delivery-phase gate.
  test("an untagged indexes edge does not satisfy Gate C — self-grounds still rejects", () => {
    setType(targetTurnId, ["design", "implement"]);
    setType(earlierTurnId, ["design"]);

    const result = noteTool(
      db,
      {
        turn: `S${sessionId}/T3`,
        indexes: [`S${sessionId}/T1`],
        grounds: [`S${sessionId}/T3`],
      },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );

    expect(resultText(result)).toStartWith("Parameter error:");
    expect(resultText(result)).toContain(`grounds "S${sessionId}/T3"`);
    // Atomic: the whole call rolls back, so the untagged indexes edge that
    // WOULD have been legal on its own does not survive either.
    expect(getOutgoingEdges(db, { kind: "turn", id: targetTurnId })).toEqual([]);
  });

  // round-4 review #1's own acceptance criterion: "decision-only self-grounds
  // REJECTS" — a turn with no delivery-phase type can never self-ground, even
  // carrying a legal tagged-indexes declaration in the very same call. This
  // is the pre-write half (`self-not-delivery`), refused before Gate C (the
  // post-transaction terminus check) ever runs.
  test("a decision-only turn's self-grounds rejects even with a legal tagged-indexes declaration in the same call", () => {
    setType(targetTurnId, ["design"]);
    setType(earlierTurnId, ["design"]);
    setTags(targetTurnId, ["lane-a"]);
    setTags(earlierTurnId, ["lane-a"]);

    const result = noteTool(
      db,
      {
        turn: `S${sessionId}/T3`,
        indexes: [{ turn: `S${sessionId}/T1`, tags: ["lane-a"] }],
        grounds: [`S${sessionId}/T3`],
      },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );

    expect(resultText(result)).toStartWith("Parameter error:");
    expect(resultText(result)).toContain(`grounds "S${sessionId}/T3"`);
    expect(resultText(result)).toContain("delivery");
    // Atomic: the indexes edge that would otherwise be legal on its own does
    // not survive the whole call's rollback either.
    expect(getOutgoingEdges(db, { kind: "turn", id: targetTurnId })).toEqual([]);
  });

  // round-4 review #1's own acceptance criterion: "stale-declaration
  // self-grounds REJECTS" — a lane's terminus declaration this turn made in
  // an EARLIER call no longer stands once a LATER turn's tag-matched
  // override reopens that lane; a fresh self-grounds attempt after that must
  // not read the stale declaration as still legal. Exercises the exact bug
  // round-4 review #1 found: the old check only asked "did the citing turn
  // EVER write a tagged indexes edge" and never re-examined it against a
  // later override written by someone else.
  test("a stale terminus declaration — reopened by a LATER turn's tag-matched override — rejects a fresh self-grounds", () => {
    setType(targetTurnId, ["design", "implement"]);
    setType(earlierTurnId, ["design"]);
    setTags(targetTurnId, ["lane-a"]);
    setTags(earlierTurnId, ["lane-a"]);

    // T3 declares itself the {lane-a} terminus and self-grounds in one call
    // — legal, per the earlier "single call" test above.
    const declare = noteTool(
      db,
      {
        turn: `S${sessionId}/T3`,
        indexes: [{ turn: `S${sessionId}/T1`, tags: ["lane-a"] }],
        grounds: [`S${sessionId}/T3`],
      },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );
    expect(isNoteSuccess(declare)).toBe(true);

    // A later turn, T4, overrides T3 WITHIN the {lane-a} lane (same tag on
    // both endpoints) — this reopens the lane: T3 is no longer its terminus.
    const laterTurnId = db
      .query<{ id: number }, [number, number, string, number]>(
        `INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch)
         VALUES (?, ?, 'extracted', ?, ?) RETURNING id`,
      )
      .get(sessionId, 4, "Fourth turn — reopens the lane", 120)!.id;
    setType(laterTurnId, ["design"]);
    setTags(laterTurnId, ["lane-a"]);

    const reopen = noteTool(
      db,
      { turn: `S${sessionId}/T4`, override: [{ turn: `S${sessionId}/T3`, tags: ["lane-a"] }] },
      { now: () => 950, env: {}, eraCutoffEpoch: 1 },
    );
    expect(isNoteSuccess(reopen)).toBe(true);

    // A FRESH self-grounds attempt by T3, resting on the now-stale
    // declaration from the first call, must reject.
    const staleAttempt = noteTool(
      db,
      { turn: `S${sessionId}/T3`, grounds: [`S${sessionId}/T3`] },
      { now: () => 1000, env: {}, eraCutoffEpoch: 1 },
    );

    expect(resultText(staleAttempt)).toStartWith("Parameter error:");
    expect(resultText(staleAttempt)).toContain(`grounds "S${sessionId}/T3"`);
    expect(resultText(staleAttempt)).toContain("TAGGED");
    // The first call's grounds edge stands (that call was legal and already
    // committed); the second, stale attempt adds nothing.
    expect(
      getOutgoingEdges(db, { kind: "turn", id: targetTurnId }).filter(
        (edge) => edge.relation === "grounds" && edge.cited.id === targetTurnId,
      ),
    ).toHaveLength(1);
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
  // Flow-relations spec (ticket 02): the six-row law. Each row gets at least
  // one legal and one illegal example, naming the missing half — replacing
  // ADR-0010's retired nine-cell matrix outright. `indexes`' dedicated
  // describe block further down demonstrates its retired graph-state gate
  // (indexes-rescope spec, ticket 01) — every graph shape that used to be
  // refused now succeeds, leaving phase legality (tested above, alongside
  // override/narrows/extends/consume) as indexes' whole remaining test.
  // ---------------------------------------------------------------------

  test("override: same phase on either end (not limited to decision, unlike narrows/extends); illegal when the phases mismatch", () => {
    setType(earlierTurnId, ["research"]);
    setType(anotherEarlierTurnId, ["implement"]);
    setType(targetTurnId, ["measure"]);

    const evidenceLegal = noteTool(
      db,
      { turn: `S${sessionId}/T3`, override: [`S${sessionId}/T1`] },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );
    expect(resultText(evidenceLegal)).toContain("Attached 1 relation(s).");

    setType(targetTurnId, ["ops"]);
    const deliveryLegal = noteTool(
      db,
      { turn: `S${sessionId}/T3`, override: [`S${sessionId}/T2`] },
      { now: () => 910, env: {}, eraCutoffEpoch: 1 },
    );
    expect(resultText(deliveryLegal)).toContain("Attached 1 relation(s).");

    setType(targetTurnId, ["design"]);
    const illegal = noteTool(
      db,
      { turn: `S${sessionId}/T3`, override: [`S${sessionId}/T1`] },
      { now: () => 920, env: {}, eraCutoffEpoch: 1 },
    );
    expect(resultText(illegal)).toStartWith("Parameter error:");
    expect(resultText(illegal)).toContain("decision-phase");
    expect(getOutgoingEdges(db, { kind: "turn", id: targetTurnId })).toHaveLength(2);
  });

  // rubric-v10 ticket 02: narrows widens from decision-only to same-phase
  // (the decision cage retires with the flow model) — legal on evidence-
  // evidence AND delivery-delivery now too, same breadth override already
  // had (mirrors override's own test above, turn for turn).
  // tag-mandate spec ("Write gate"): narrows/extends have no untagged form
  // any more, so every assertion below carries a lane tag both endpoints hold
  // — the subset invariant, satisfied deliberately rather than by weakening
  // the gate. The PHASE half is what these two tests still isolate: Gate A
  // runs before Gate B, so the illegal case still reports its phase problem,
  // not the mandate.
  test("narrows: same phase on either end (widened off decision-only); illegal when the phases mismatch", () => {
    setType(earlierTurnId, ["research"]);
    setType(anotherEarlierTurnId, ["implement"]);
    setType(targetTurnId, ["measure"]);
    setTags(earlierTurnId, ["lane-a"]);
    setTags(anotherEarlierTurnId, ["lane-a"]);
    setTags(targetTurnId, ["lane-a"]);

    const evidenceLegal = noteTool(
      db,
      { turn: `S${sessionId}/T3`, narrows: [{ turn: `S${sessionId}/T1`, tags: ["lane-a"] }] },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );
    expect(resultText(evidenceLegal)).toContain("Attached 1 relation(s).");

    setType(targetTurnId, ["ops"]);
    const deliveryLegal = noteTool(
      db,
      { turn: `S${sessionId}/T3`, narrows: [{ turn: `S${sessionId}/T2`, tags: ["lane-a"] }] },
      { now: () => 910, env: {}, eraCutoffEpoch: 1 },
    );
    expect(resultText(deliveryLegal)).toContain("Attached 1 relation(s).");

    setType(targetTurnId, ["design"]);
    const illegal = noteTool(
      db,
      { turn: `S${sessionId}/T3`, narrows: [{ turn: `S${sessionId}/T1`, tags: ["lane-a"] }] },
      { now: () => 920, env: {}, eraCutoffEpoch: 1 },
    );
    expect(resultText(illegal)).toStartWith("Parameter error:");
    expect(resultText(illegal)).toContain("decision-phase");
  });

  test("extends: same phase on either end (widened off decision-only); illegal when the phases mismatch", () => {
    setType(earlierTurnId, ["research"]);
    setType(anotherEarlierTurnId, ["implement"]);
    setType(targetTurnId, ["measure"]);
    setTags(earlierTurnId, ["lane-a"]);
    setTags(anotherEarlierTurnId, ["lane-a"]);
    setTags(targetTurnId, ["lane-a"]);

    const evidenceLegal = noteTool(
      db,
      { turn: `S${sessionId}/T3`, extends: [{ turn: `S${sessionId}/T1`, tags: ["lane-a"] }] },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );
    expect(resultText(evidenceLegal)).toContain("Attached 1 relation(s).");

    setType(targetTurnId, ["ops"]);
    const deliveryLegal = noteTool(
      db,
      { turn: `S${sessionId}/T3`, extends: [{ turn: `S${sessionId}/T2`, tags: ["lane-a"] }] },
      { now: () => 910, env: {}, eraCutoffEpoch: 1 },
    );
    expect(resultText(deliveryLegal)).toContain("Attached 1 relation(s).");

    setType(targetTurnId, ["design"]);
    const illegal = noteTool(
      db,
      { turn: `S${sessionId}/T3`, extends: [{ turn: `S${sessionId}/T1`, tags: ["lane-a"] }] },
      { now: () => 920, env: {}, eraCutoffEpoch: 1 },
    );
    expect(resultText(illegal)).toStartWith("Parameter error:");
    expect(resultText(illegal)).toContain("decision-phase");
  });

  // Indexes-rescope spec (ticket 01, [S15069/T1231]): `indexes` (the renamed,
  // widened `collects`) is same-phase like override/consume — no flow or
  // layer limit. Its dedicated "no graph-state gate" describe block further
  // down covers the retired collects membership check; this is its phase
  // test alone, same shape as override's and consume's above.
  test("indexes: same phase on either end; illegal when the phases mismatch", () => {
    setType(anotherEarlierTurnId, ["implement"]);
    setType(targetTurnId, ["fix"]);

    const legal = noteTool(
      db,
      { turn: `S${sessionId}/T3`, indexes: [`S${sessionId}/T2`] },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );
    expect(resultText(legal)).toContain("Attached 1 relation(s).");

    setType(earlierTurnId, ["design"]); // decision-phase — illegal indexes target
    const illegal = noteTool(
      db,
      { turn: `S${sessionId}/T3`, indexes: [`S${sessionId}/T1`] },
      { now: () => 910, env: {}, eraCutoffEpoch: 1 },
    );
    expect(resultText(illegal)).toStartWith("Parameter error:");
    expect(resultText(illegal)).toContain("delivery-phase");
  });

  test("consume: same phase on either end; illegal when the phases mismatch", () => {
    setType(anotherEarlierTurnId, ["implement"]);
    setType(targetTurnId, ["fix"]);

    const legal = noteTool(
      db,
      { turn: `S${sessionId}/T3`, consume: [`S${sessionId}/T2`] },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );
    expect(resultText(legal)).toContain("Attached 1 relation(s).");

    setType(earlierTurnId, ["design"]); // decision-phase — illegal consume target
    const illegal = noteTool(
      db,
      { turn: `S${sessionId}/T3`, consume: [`S${sessionId}/T1`] },
      { now: () => 910, env: {}, eraCutoffEpoch: 1 },
    );
    expect(resultText(illegal)).toStartWith("Parameter error:");
    expect(resultText(illegal)).toContain("delivery-phase");
  });

  // "No restriction" is the one row with NO illegal phase case at all — the
  // test proves breadth instead: an evidence-phase decision-phase and
  // delivery-phase target are ALL legal from the same decision-phase source,
  // absorbing the retired grounded-on's OR and encodes' reach at once.
  test("grounds: cross-phase only (T1209) — legal toward evidence and delivery from a decision source, refused toward a same-phase decision target", () => {
    setType(earlierTurnId, ["research"]);
    setType(anotherEarlierTurnId, ["implement"]);
    setType(targetTurnId, ["design"]);

    const towardEvidence = noteTool(
      db,
      { turn: `S${sessionId}/T3`, grounds: [`S${sessionId}/T1`] },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );
    expect(resultText(towardEvidence)).toContain("Attached 1 relation(s).");

    const towardDelivery = noteTool(
      db,
      { turn: `S${sessionId}/T3`, grounds: [`S${sessionId}/T2`] },
      { now: () => 910, env: {}, eraCutoffEpoch: 1 },
    );
    expect(resultText(towardDelivery)).toContain("Attached 1 relation(s).");

    db.query<unknown, [number, string]>(
      `INSERT INTO turns (session_id, prompt_number, status, user_prompt, type, created_at_epoch)
       VALUES (?, 4, 'extracted', 'A decision-only turn', ?, 118)`,
    ).run(sessionId, JSON.stringify(["discuss"]));
    // T1209 retightening: a decision-source grounds toward a decision-only
    // target is SAME-phase — refused, naming the cited side's missing cross
    // phases (within a phase, dependency is the stance words' or consume's).
    const towardDecision = noteTool(
      db,
      { turn: `S${sessionId}/T3`, grounds: [`S${sessionId}/T4`] },
      { now: () => 920, env: {}, eraCutoffEpoch: 1 },
    );
    expect(resultText(towardDecision)).toContain("cited turn");
    expect(resultText(towardDecision)).not.toContain("Attached 1 relation(s).");
    const edges = getOutgoingEdges(db, { kind: "turn", id: targetTurnId });
    expect(edges.filter((edge) => edge.relation === "grounds")).toHaveLength(2);
  });

  test("verifies/refutes: require an evidence-phase source and a decision/delivery target (T1215)", () => {
    setType(earlierTurnId, ["design"]); // decision-phase target
    setType(targetTurnId, ["research"]); // evidence-phase source

    const legal = noteTool(
      db,
      { turn: `S${sessionId}/T3`, verifies: [`S${sessionId}/T1`] },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );
    expect(resultText(legal)).toContain("Attached 1 relation(s).");

    // A fourth, decision-phase-only turn cannot supply verifies'/refutes'
    // source requirement (evidence).
    const fourthTurnId = db
      .query<{ id: number }, [number, number, string]>(
        `INSERT INTO turns (session_id, prompt_number, status, user_prompt, type, created_at_epoch)
         VALUES (?, 4, 'extracted', 'A fourth turn', ?, 115) RETURNING id`,
      )
      .get(sessionId, JSON.stringify(["design"]))!.id;

    const illegal = noteTool(
      db,
      { turn: `S${sessionId}/T4`, refutes: [`S${sessionId}/T1`] },
      { now: () => 950, env: {}, eraCutoffEpoch: 1 },
    );
    expect(resultText(illegal)).toStartWith("Parameter error:");
    expect(resultText(illegal)).toContain("evidence-phase");
    expect(getOutgoingEdges(db, { kind: "turn", id: fourthTurnId })).toEqual([]);
  });

  // The exists-rule for a MULTI-type turn — legal on BOTH ends at once for
  // two DIFFERENT relations, one exercising each half of the dual type.
  test("a dual-type (design+implement) turn is legal on both ends under the exists-rule — extends' decision half and consume's delivery half", () => {
    // anotherEarlierTurnId carries BOTH a decision phase (design) and a
    // delivery phase (implement) — legal as extends' TARGET (needs decision)
    // and, in a separate write, as consume's SOURCE (needs a shared phase
    // with ITS OWN target, here delivery).
    setType(anotherEarlierTurnId, ["design", "implement"]);
    setType(targetTurnId, ["correction"]);
    // tag-mandate: the extends half needs a lane both its endpoints carry.
    // The consume half below stays BARE on purpose — the mandate falls on
    // extends/narrows alone, and this test is one of the places that proves
    // another word's untagged form still lands.
    setTags(anotherEarlierTurnId, ["lane-a"]);
    setTags(targetTurnId, ["lane-a"]);

    const extendsResult = noteTool(
      db,
      { turn: `S${sessionId}/T3`, extends: [{ turn: `S${sessionId}/T2`, tags: ["lane-a"] }] },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );
    expect(resultText(extendsResult)).toContain("Attached 1 relation(s).");

    setType(earlierTurnId, ["implement"]);
    const consumeResult = noteTool(
      db,
      { turn: `S${sessionId}/T2`, consume: [`S${sessionId}/T1`] },
      { now: () => 950, env: {}, eraCutoffEpoch: 1 },
    );
    expect(resultText(consumeResult)).toContain("Attached 1 relation(s).");
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

  // rubric-v10 ticket 02 (spec "Checks, layered"): the flow-relations era's
  // `grounds` mid-flow warning retires ENTIRELY — no flow derivation runs on
  // the write path any more, and the receipt never carries a "mid-flow ...
  // cite that instead" line, whatever shape the graph is in. Same scenario
  // the retired describe block above exercised (a chain of `extends`, then a
  // `grounds` toward the mid-chain member) — legal, and silent.
  describe("grounds mid-flow warning retirement (rubric-v10 ticket 02)", () => {
    test("a grounds toward an earlier member of an extends chain stores with no warning at all", () => {
      setType(earlierTurnId, ["design"]);
      setType(anotherEarlierTurnId, ["design"]);
      setType(targetTurnId, ["implement"]);
      // tag-mandate: the chain this scenario needs is built with a real lane
      // now. The setup call is ASSERTED rather than fire-and-forget — an
      // extends that silently stopped landing would leave the `grounds`
      // assertion below testing an empty graph.
      setTags(earlierTurnId, ["lane-a"]);
      setTags(anotherEarlierTurnId, ["lane-a"]);

      const chain = noteTool(
        db,
        { turn: `S${sessionId}/T2`, extends: [{ turn: `S${sessionId}/T1`, tags: ["lane-a"] }] },
        { now: () => 890, env: {}, eraCutoffEpoch: 1 },
      );
      expect(resultText(chain)).toContain("Attached 1 relation(s).");

      const result = noteTool(
        db,
        { turn: `S${sessionId}/T3`, grounds: [`S${sessionId}/T1`] },
        { now: () => 900, env: {}, eraCutoffEpoch: 1 },
      );

      expect(isNoteSuccess(result)).toBe(true);
      expect(resultText(result)).toContain("Attached 1 relation(s).");
      expect(resultText(result)).not.toContain("warning:");
      expect(resultText(result)).not.toContain("mid-flow");
      expect(resultText(result)).not.toContain("settles at");
    });

    test("a grounds toward a target overridden by a later turn stores with no warning either", () => {
      setType(earlierTurnId, ["design"]);
      setType(anotherEarlierTurnId, ["design"]);
      setType(targetTurnId, ["implement"]);

      noteTool(
        db,
        { turn: `S${sessionId}/T2`, override: [`S${sessionId}/T1`] },
        { now: () => 890, env: {}, eraCutoffEpoch: 1 },
      );

      const result = noteTool(
        db,
        { turn: `S${sessionId}/T3`, grounds: [`S${sessionId}/T1`] },
        { now: () => 900, env: {}, eraCutoffEpoch: 1 },
      );

      expect(isNoteSuccess(result)).toBe(true);
      expect(resultText(result)).toContain("Attached 1 relation(s).");
      expect(resultText(result)).not.toContain("warning:");
    });
  });
});

// rubric-v10 ticket 02: the tagged relation entry form ({turn, tags}) end to
// end — Gate A (widened same-phase domains), Gate B (taggability + the
// subset invariant), and both forms coexisting on one pair/relation.
describe("note tool tagged relation entries (rubric-v10 ticket 02)", () => {
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
  function setTags(turnId: number, tags: readonly string[]): void {
    db.query<unknown, [string, number]>("UPDATE turns SET tags = ? WHERE id = ?").run(
      JSON.stringify(tags),
      turnId,
    );
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    sessionId = upsertSession(db, {
      contentSessionId: "note-tagged-relations-session",
      project: "claude-mnemo",
      title: "Note tagged relations",
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
    setType(targetTurnId, ["correction"]);
  });

  afterEach(() => {
    db.close();
  });

  test("a tagged entry stores a tagged assertion when every tag is on both endpoints' tags", () => {
    setTags(earlierTurnId, ["lane-a"]);
    setTags(targetTurnId, ["lane-a"]);

    const result = noteTool(
      db,
      { turn: `S${sessionId}/T3`, override: [{ turn: `S${sessionId}/T1`, tags: ["lane-a"] }] },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );

    expect(isNoteSuccess(result)).toBe(true);
    const edges = getOutgoingEdges(db, { kind: "turn", id: targetTurnId });
    expect(edges).toHaveLength(1);
    expect(edges[0]?.tags).toEqual(["lane-a"]);
  });

  test("both forms coexist on one pair/relation — the untagged and tagged rows are independent facts", () => {
    setTags(earlierTurnId, ["lane-a"]);
    setTags(targetTurnId, ["lane-a"]);

    const result = noteTool(
      db,
      {
        turn: `S${sessionId}/T3`,
        override: [`S${sessionId}/T1`, { turn: `S${sessionId}/T1`, tags: ["lane-a"] }],
      },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );

    expect(isNoteSuccess(result)).toBe(true);
    expect(resultText(result)).toContain("Attached 2 relation(s).");
    const edges = getOutgoingEdges(db, { kind: "turn", id: targetTurnId });
    expect(edges.map((edge) => edge.tags).sort()).toEqual([[], ["lane-a"]]);
  });

  // Gate B, part 1: word taggability — only the five same-phase words may
  // ever carry a tag; a cross-phase word (grounds/verifies/refutes) rejects
  // one outright, whatever the endpoints' own tags say.
  test("a tag on a cross-phase word (grounds) rejects, even when both endpoints already carry it", () => {
    setType(earlierTurnId, ["research"]);
    setTags(earlierTurnId, ["lane-a"]);
    setTags(targetTurnId, ["lane-a"]);

    const result = noteTool(
      db,
      { turn: `S${sessionId}/T3`, grounds: [{ turn: `S${sessionId}/T1`, tags: ["lane-a"] }] },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );

    expect(resultText(result)).toStartWith("Parameter error:");
    expect(resultText(result)).toContain(`grounds "S${sessionId}/T1"`);
    expect(resultText(result)).toContain("no lane tags");
    expect(getOutgoingEdges(db, { kind: "turn", id: targetTurnId })).toEqual([]);
  });

  // Gate B, part 2: the subset invariant — every edge tag must already be on
  // BOTH endpoint turns' own tags, rejection names the tag and the endpoint.
  test("a tag missing from the CITING turn's own tags rejects, naming the tag and the citing endpoint", () => {
    setTags(earlierTurnId, ["lane-a"]);
    // targetTurnId (citing) carries no tags at all.

    const result = noteTool(
      db,
      { turn: `S${sessionId}/T3`, extends: [{ turn: `S${sessionId}/T1`, tags: ["lane-a"] }] },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );

    expect(resultText(result)).toStartWith("Parameter error:");
    expect(resultText(result)).toContain(`extends "S${sessionId}/T1"`);
    expect(resultText(result)).toContain("lane-a");
    expect(resultText(result)).toContain("citing turn");
    expect(getOutgoingEdges(db, { kind: "turn", id: targetTurnId })).toEqual([]);
  });

  test("a tag missing from the CITED turn's own tags rejects, naming the tag and the cited endpoint", () => {
    setTags(targetTurnId, ["lane-a"]);
    // earlierTurnId (cited) carries no tags at all.

    const result = noteTool(
      db,
      { turn: `S${sessionId}/T3`, consume: [{ turn: `S${sessionId}/T1`, tags: ["lane-a"] }] },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );

    expect(resultText(result)).toStartWith("Parameter error:");
    expect(resultText(result)).toContain(`consume "S${sessionId}/T1"`);
    expect(resultText(result)).toContain("lane-a");
    expect(resultText(result)).toContain("cited turn");
    expect(getOutgoingEdges(db, { kind: "turn", id: targetTurnId })).toEqual([]);
  });

  // Mutation-critical (ticket's own acceptance criterion): with the gap
  // present, the write still rejects — if the subset invariant were
  // disabled, this call would silently attach the illegally-tagged edge.
  test("mutation check: the subset invariant still rejects when the gap is real, no silent admission", () => {
    setTags(earlierTurnId, []);
    setTags(targetTurnId, []);

    const result = noteTool(
      db,
      { turn: `S${sessionId}/T3`, indexes: [{ turn: `S${sessionId}/T1`, tags: ["lane-a"] }] },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );

    expect(resultText(result)).toStartWith("Parameter error:");
    expect(getOutgoingEdges(db, { kind: "turn", id: targetTurnId })).toEqual([]);
  });

  test("retraction gains the same {turn, tags} form: untagged retracts the bare row, tagged retracts the exact-set row", () => {
    setTags(earlierTurnId, ["lane-a"]);
    setTags(targetTurnId, ["lane-a"]);

    noteTool(
      db,
      {
        turn: `S${sessionId}/T3`,
        override: [`S${sessionId}/T1`, { turn: `S${sessionId}/T1`, tags: ["lane-a"] }],
      },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );
    expect(getOutgoingEdges(db, { kind: "turn", id: targetTurnId })).toHaveLength(2);

    const result = noteTool(
      db,
      {
        turn: `S${sessionId}/T3`,
        retractOverride: [{ turn: `S${sessionId}/T1`, tags: ["lane-a"] }],
      },
      { now: () => 950, env: {}, eraCutoffEpoch: 1 },
    );

    expect(isNoteSuccess(result)).toBe(true);
    expect(resultText(result)).toContain("Retracted 1 relation(s).");
    const remaining = getOutgoingEdges(db, { kind: "turn", id: targetTurnId });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.tags).toEqual([]);
  });

  // tag-mandate spec ("Write gate"): the MAIN AGENT half of the one-rule,
  // no-carve-outs gate. The settlement half is the mirror block in
  // tests/worker/note-settlement-turn-facade.test.ts; the shared judgment
  // itself is tests/shared/turn-phase.test.ts.
  describe("the tag mandate (tag-mandate spec, Write gate)", () => {
    test("a bare extends is refused with the teaching message, and nothing is stored", () => {
      setTags(earlierTurnId, ["lane-a"]);
      setTags(targetTurnId, ["lane-a"]);

      const result = noteTool(
        db,
        { turn: `S${sessionId}/T3`, extends: [`S${sessionId}/T1`] },
        { now: () => 900, env: {}, eraCutoffEpoch: 1 },
      );

      expect(resultText(result)).toStartWith("Parameter error:");
      expect(resultText(result)).toContain(`extends "S${sessionId}/T1"`);
      expect(resultText(result)).toContain("continuation names its lane");
      expect(resultText(result)).toContain("subset invariant");
      // Mutation-critical: the tags are ALREADY on both endpoints here, so
      // nothing but the mandate itself can be refusing this call — and if it
      // were disabled, the untagged edge would silently land.
      expect(getOutgoingEdges(db, { kind: "turn", id: targetTurnId })).toEqual([]);
    });

    test("a bare narrows is refused the same way", () => {
      setTags(earlierTurnId, ["lane-a"]);
      setTags(targetTurnId, ["lane-a"]);

      const result = noteTool(
        db,
        { turn: `S${sessionId}/T3`, narrows: [`S${sessionId}/T1`] },
        { now: () => 900, env: {}, eraCutoffEpoch: 1 },
      );

      expect(resultText(result)).toStartWith("Parameter error:");
      expect(resultText(result)).toContain(`narrows "S${sessionId}/T1"`);
      expect(resultText(result)).toContain("continuation names its lane");
      expect(getOutgoingEdges(db, { kind: "turn", id: targetTurnId })).toEqual([]);
    });

    test("the tagged form of the same call lands", () => {
      setTags(earlierTurnId, ["lane-a"]);
      setTags(targetTurnId, ["lane-a"]);

      const result = noteTool(
        db,
        { turn: `S${sessionId}/T3`, extends: [{ turn: `S${sessionId}/T1`, tags: ["lane-a"] }] },
        { now: () => 900, env: {}, eraCutoffEpoch: 1 },
      );

      expect(isNoteSuccess(result)).toBe(true);
      const edges = getOutgoingEdges(db, { kind: "turn", id: targetTurnId });
      expect(edges).toHaveLength(1);
      expect(edges[0]?.relation).toBe("extends");
      expect(edges[0]?.tags).toEqual(["lane-a"]);
    });

    // The mandate is two words wide. Every other same-phase word's bare form
    // is a legitimate reading the spec names, and the cross-phase words never
    // had a tagged form to lose.
    test("the other words' bare forms still land through the same tool", () => {
      const bareCalls: Array<Record<string, unknown>> = [
        { override: [`S${sessionId}/T1`] },
        { indexes: [`S${sessionId}/T1`] },
        { consume: [`S${sessionId}/T1`] },
      ];
      let clock = 900;
      for (const call of bareCalls) {
        const result = noteTool(
          db,
          { turn: `S${sessionId}/T3`, ...call },
          { now: () => (clock += 10), env: {}, eraCutoffEpoch: 1 },
        );
        expect(resultText(result)).toContain("Attached 1 relation(s).");
      }
      expect(getOutgoingEdges(db, { kind: "turn", id: targetTurnId })).toHaveLength(3);
    });

    // The assertion/retraction split (spec, peer round T1455): legacy
    // untagged rows must stay DELETABLE by their bare address, or the stock
    // the mandate exists to clean up becomes unrepairable. The row below is
    // seeded through the storage primitive precisely because the write gate
    // now refuses to mint one.
    test("retractExtends/retractNarrows still accept a bare address — legacy untagged stock stays deletable", () => {
      writeMemoryEdges(
        db,
        [
          {
            citing: { kind: "turn", id: targetTurnId },
            cited: { kind: "turn", id: earlierTurnId },
            relation: "extends",
            provenance: "asserted",
          },
          {
            citing: { kind: "turn", id: targetTurnId },
            cited: { kind: "turn", id: earlierTurnId },
            relation: "narrows",
            provenance: "asserted",
          },
        ],
        800,
      );
      expect(getOutgoingEdges(db, { kind: "turn", id: targetTurnId })).toHaveLength(2);

      const result = noteTool(
        db,
        {
          turn: `S${sessionId}/T3`,
          retractExtends: [`S${sessionId}/T1`],
          retractNarrows: [`S${sessionId}/T1`],
        },
        { now: () => 900, env: {}, eraCutoffEpoch: 1 },
      );

      expect(isNoteSuccess(result)).toBe(true);
      expect(resultText(result)).toContain("Retracted 2 relation(s).");
      expect(getOutgoingEdges(db, { kind: "turn", id: targetTurnId })).toEqual([]);
    });

    // Peer round T1466 (finding P1-2): the ninth word is RETRACTION-ONLY.
    // `supersedes` was frozen out of the write vocabulary while measured rows
    // carrying it still stand — and the lane checker classes such a row as E2,
    // which the settlement commit gate refuses over. With no deletion path the
    // window owning one could never commit, so the mirror exists on both write
    // surfaces while the assertion field stays retired on both.
    test("retractSupersedes deletes a frozen-legacy row, and supersedes itself stays unwritable", () => {
      writeMemoryEdges(
        db,
        [
          {
            citing: { kind: "turn", id: targetTurnId },
            cited: { kind: "turn", id: earlierTurnId },
            relation: "supersedes",
            provenance: "asserted",
          },
        ],
        800,
      );
      expect(getOutgoingEdges(db, { kind: "turn", id: targetTurnId })).toHaveLength(1);

      // The assertion half is a parse error, not a call the tool weighs.
      expect(
        noteInputSchema.safeParse({
          turn: `S${sessionId}/T3`,
          supersedes: [`S${sessionId}/T1`],
        }).success,
      ).toBe(false);
      // …and the retraction half goes through, on a bare address (a
      // frozen-legacy row predates the tag model and is never tagged).
      expect(
        noteInputSchema.safeParse({
          turn: `S${sessionId}/T3`,
          retractSupersedes: [`S${sessionId}/T1`],
        }).success,
      ).toBe(true);

      const result = noteTool(
        db,
        { turn: `S${sessionId}/T3`, retractSupersedes: [`S${sessionId}/T1`] },
        { now: () => 900, env: {}, eraCutoffEpoch: 1 },
      );

      expect(isNoteSuccess(result)).toBe(true);
      expect(resultText(result)).toContain("Retracted 1 relation(s).");
      expect(getOutgoingEdges(db, { kind: "turn", id: targetTurnId })).toEqual([]);
    });

    // The other half of "never restore the assertion": a retraction naming a
    // row that is not there is refused BY NAME, so "already gone" and "wrong
    // address" stay distinguishable for this word too.
    test("retractSupersedes on an address carrying no such edge is refused by name", () => {
      const result = noteTool(
        db,
        { turn: `S${sessionId}/T3`, retractSupersedes: [`S${sessionId}/T1`] },
        { now: () => 900, env: {}, eraCutoffEpoch: 1 },
      );

      expect(isNoteSuccess(result)).toBe(false);
      expect(resultText(result)).toContain("retraction field rejected");
      expect(resultText(result)).toContain("supersedes");
      expect(resultText(result)).toContain("is not a relation this turn currently carries");
    });
  });
});

// Indexes-rescope spec (ticket 01, `.scratch/indexes-rescope/spec.md`'s law
// 2, [S15069/T1232]): `indexes` (the renamed, widened `collects`) carries NO
// graph-state check any more — T1202's terminus + own-branch hard rejection
// RETIRES. Every graph shape the old `collects` describe block ("flow-
// relations spec, ticket 02: P1's one graph-state hard check") used to
// refuse now succeeds; the self-`grounds` settlement+implementer condition
// (pinned separately, see "a design+implement turn self-grounds" above) is
// the vocabulary's one remaining graph-state rejection. Exercised through the
// real `noteTool` call path so a caller touching only `indexes` is confirmed
// to build NO flow derivation at all (no `db/flows.ts` involvement).
describe("note tool indexes (indexes-rescope spec, ticket 01: no graph-state gate)", () => {
  let db: Database;
  let sessionId: number;
  let earlierTurnId: number; // T1, mid-flow member of T3's branch
  let anotherEarlierTurnId: number; // T2, an unrelated decision turn — out of T3's branch
  let targetTurnId: number; // T3, the branch's settlement (extends T1)

  function setType(turnId: number, types: readonly string[]): void {
    db.query<unknown, [string, number]>("UPDATE turns SET type = ? WHERE id = ?").run(
      JSON.stringify(types),
      turnId,
    );
  }

  function setTags(turnId: number, tags: readonly string[]): void {
    db.query<unknown, [string, number]>("UPDATE turns SET tags = ? WHERE id = ?").run(
      JSON.stringify(tags),
      turnId,
    );
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    sessionId = upsertSession(db, {
      contentSessionId: "note-indexes-session",
      project: "claude-mnemo",
      title: "Note indexes",
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
    anotherEarlierTurnId = insertTurn.get(sessionId, 2, "An unrelated decision", 105)!.id;
    targetTurnId = insertTurn.get(sessionId, 3, "The branch's settlement", 110)!.id;
    setType(earlierTurnId, ["design"]);
    setType(anotherEarlierTurnId, ["design"]);
    setType(targetTurnId, ["correction"]);
    // tag-mandate ("Write gate"): the branch below is a real lane now — the
    // setup extends carries {lane-a} and both its endpoints hold it.
    setTags(earlierTurnId, ["lane-a"]);
    setTags(targetTurnId, ["lane-a"]);

    // T3 extends T1 — T3 becomes the branch's settlement, T1 its mid-flow
    // member. Asserted, not fire-and-forget: every test in this block reads
    // a graph this one call builds.
    const branch = noteTool(
      db,
      { turn: `S${sessionId}/T3`, extends: [{ turn: `S${sessionId}/T1`, tags: ["lane-a"] }] },
      { now: () => 890, env: {}, eraCutoffEpoch: 1 },
    );
    expect(resultText(branch)).toContain("Attached 1 relation(s).");
  });

  afterEach(() => {
    db.close();
  });

  test("the settlement indexes an in-branch member — the old legal case still legal", () => {
    const result = noteTool(
      db,
      { turn: `S${sessionId}/T3`, indexes: [`S${sessionId}/T1`] },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );

    expect(isNoteSuccess(result)).toBe(true);
    expect(resultText(result)).toContain("Attached 1 relation(s).");
    const edges = getOutgoingEdges(db, { kind: "turn", id: targetTurnId });
    expect(
      edges.some((edge) => edge.relation === "indexes" && edge.cited.id === earlierTurnId),
    ).toBe(true);
  });

  // The retired collects rejection (peer final-audit finding 2, S15069/
  // T1217): "an overridden settlement (dead branch) can no longer collect".
  // indexes carries no graph-state check, so the identical shape now succeeds.
  test("an overridden settlement (dead branch) can still index — the graph-state gate retired", () => {
    const overriderId = db
      .query<{ id: number }, [number, number, string, number]>(
        `INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch)
         VALUES (?, ?, 'extracted', ?, ?) RETURNING id`,
      )
      .get(sessionId, 4, "The overrider", 115)!.id;
    setType(overriderId, ["design"]);
    const overrode = noteTool(
      db,
      { turn: `S${sessionId}/T4`, override: [`S${sessionId}/T3`] },
      { now: () => 895, env: {}, eraCutoffEpoch: 1 },
    );
    expect(isNoteSuccess(overrode)).toBe(true);

    const result = noteTool(
      db,
      { turn: `S${sessionId}/T3`, indexes: [`S${sessionId}/T1`] },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );
    expect(isNoteSuccess(result)).toBe(true);
    expect(
      getOutgoingEdges(db, { kind: "turn", id: targetTurnId }).some(
        (edge) => edge.relation === "indexes",
      ),
    ).toBe(true);
  });

  test("indexing an out-of-branch turn succeeds — same-phase aggregation is not membership-gated", () => {
    const result = noteTool(
      db,
      { turn: `S${sessionId}/T3`, indexes: [`S${sessionId}/T2`] },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );

    expect(isNoteSuccess(result)).toBe(true);
    expect(
      getOutgoingEdges(db, { kind: "turn", id: targetTurnId }).some(
        (edge) => edge.relation === "indexes" && edge.cited.id === anotherEarlierTurnId,
      ),
    ).toBe(true);
  });

  test("a mid-flow (non-terminus) turn can index too — the settlement-only rule retired", () => {
    const result = noteTool(
      db,
      { turn: `S${sessionId}/T1`, indexes: [`S${sessionId}/T2`] },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );

    expect(isNoteSuccess(result)).toBe(true);
    expect(
      getOutgoingEdges(db, { kind: "turn", id: earlierTurnId }).some(
        (edge) => edge.relation === "indexes",
      ),
    ).toBe(true);
  });

  // Delivery turns hold no flow of their own (spec's Structures section), but
  // that no longer matters — indexes is legal for ANY same-phase pair, the
  // motivating case being a release indexing the artifacts it ships.
  test("two delivery-phase turns index each other — a release indexing the artifacts it ships", () => {
    const insertTurn = db.query<{ id: number }, [number, number, string, string, number]>(
      `INSERT INTO turns (session_id, prompt_number, status, user_prompt, type, created_at_epoch)
       VALUES (?, ?, 'extracted', ?, ?, ?) RETURNING id`,
    );
    insertTurn.get(sessionId, 4, "A release", JSON.stringify(["ops"]), 115);
    insertTurn.get(sessionId, 5, "A shipped artifact", JSON.stringify(["implement"]), 116);

    const result = noteTool(
      db,
      { turn: `S${sessionId}/T4`, indexes: [`S${sessionId}/T5`] },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );

    expect(isNoteSuccess(result)).toBe(true);
  });

  test("indexes across phases is rejected — phase-illegal only, no graph-state wording", () => {
    const insertTurn = db.query<{ id: number }, [number, number, string, string, number]>(
      `INSERT INTO turns (session_id, prompt_number, status, user_prompt, type, created_at_epoch)
       VALUES (?, ?, 'extracted', ?, ?, ?) RETURNING id`,
    );
    insertTurn.get(sessionId, 4, "A delivery turn", JSON.stringify(["implement"]), 115);

    const result = noteTool(
      db,
      { turn: `S${sessionId}/T3`, indexes: [`S${sessionId}/T4`] },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );

    expect(resultText(result)).toStartWith("Parameter error:");
    expect(resultText(result)).toContain(`indexes "S${sessionId}/T4"`);
    expect(resultText(result)).toContain("cited turn");
    expect(resultText(result)).toContain("decision-phase");
    // Never the retired graph-state wording.
    expect(resultText(result)).not.toContain("live settlement");
    expect(resultText(result)).not.toContain("member of the flow");
  });

  test("indexes refuses a self target, like every relation but grounds", () => {
    const result = noteTool(
      db,
      { turn: `S${sessionId}/T3`, indexes: [`S${sessionId}/T3`] },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );

    expect(resultText(result)).toStartWith("Parameter error:");
    expect(resultText(result)).toContain(`indexes "S${sessionId}/T3"`);
    expect(resultText(result)).toContain("only `grounds` may ever cite the citing turn itself");
    // Only the beforeEach setup's own `extends` edge survives — no `indexes`
    // edge was added by the rejected self-citation attempt.
    expect(
      getOutgoingEdges(db, { kind: "turn", id: targetTurnId }).some(
        (edge) => edge.relation === "indexes",
      ),
    ).toBe(false);
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

  function setTags(turnId: number, tags: readonly string[]): void {
    db.query<unknown, [string, number]>("UPDATE turns SET tags = ? WHERE id = ?").run(
      JSON.stringify(tags),
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
    // tag-mandate ("Write gate"): both turns carry the lane the tagged
    // extends in this block asserts — the subset invariant, pre-satisfied so
    // the retraction tests exercise retraction rather than tag legality.
    setTags(earlierTurnId, ["lane-a"]);
    setTags(targetTurnId, ["lane-a"]);
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
        verifies: [`S${sessionId}/T1`],
        override: [`S${sessionId}/T1`],
      },
      { now: () => 900, env: {}, eraCutoffEpoch: 1 },
    );
    expect(relationsOn(targetTurnId)).toEqual(["override", "verifies"]);

    const result = noteTool(
      db,
      { turn: `S${sessionId}/T3`, retractOverride: [`S${sessionId}/T1`] },
      { now: () => 950, env: {}, eraCutoffEpoch: 1 },
    );

    expect(isNoteSuccess(result)).toBe(true);
    expect(resultText(result)).toContain("Retracted 1 relation(s).");
    expect(relationsOn(targetTurnId)).toEqual(["verifies"]);
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
        retractGrounds: [`S${sessionId}/T1`],
      },
      { now: () => 950, env: {}, eraCutoffEpoch: 1 },
    );

    expect(resultText(result)).toStartWith("Parameter error:");
    expect(resultText(result)).toContain("retraction field rejected");
    expect(resultText(result)).toContain(`grounds "S${sessionId}/T1"`);
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
        extends: [{ turn: `S${sessionId}/T1`, tags: ["lane-a"] }],
      },
      { now: () => 950, env: {}, eraCutoffEpoch: 1 },
    );

    expect(isNoteSuccess(result)).toBe(true);
    expect(resultText(result)).toContain("Retracted 1 relation(s).");
    expect(resultText(result)).toContain("Attached 1 relation(s).");
    expect(relationsOn(targetTurnId)).toEqual(["extends"]);
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
    // Peer round P1-8: the read that earns an edge write has to show the
    // relation SET, not merely the turn — `filter.fields` selecting
    // `relations` is what records the completeness the relations gate reads.
    recallMemory(db, {
      id: `S${sessionA}/T2`,
      filter: { fields: ["relations"] },
      readerId: sessionWriterId(sessionB),
    });

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
    // Session A writes the edge it owns — after reading the set it is adding
    // to, which the relations gate requires of every writer including the
    // turn's own (peer round P1-8: the first edge on a turn is still a claim
    // about a set, and "it was empty" is something the writer has to have
    // seen).
    recallMemory(db, {
      id: `S${sessionA}/T2`,
      filter: { fields: ["relations"] },
      readerId: sessionWriterId(sessionA),
    });
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

    // Read it — the relation set included (peer round P1-8) — and the
    // retraction lands: both writers hold the same power over an edge,
    // whoever asserted it ([S15069/T1124]).
    recallMemory(db, {
      id: `S${sessionA}/T2`,
      filter: { fields: ["relations"] },
      readerId: sessionWriterId(sessionB),
    });
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

// ---------------------------------------------------------------------------
// note-time membership (rubric-v10 ticket 07, "Segment tags and note-time
// membership"): the third of the three gated paths, and the only one of the
// three that lives on `note` rather than `remember`.
// ---------------------------------------------------------------------------

describe("note tool: segment membership parameter (rubric-v10 ticket 07)", () => {
  let db: Database;
  let sessionId: number;
  let turnId: number;

  function setTags(id: number, tags: readonly string[]): void {
    db.query<unknown, [string, number]>("UPDATE turns SET tags = ? WHERE id = ?").run(
      JSON.stringify(tags),
      id,
    );
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    sessionId = upsertSession(db, {
      contentSessionId: "note-segment-session",
      project: "claude-mnemo",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    }).id;

    turnId = db
      .query<{ id: number }, [number, number, number]>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch)
         VALUES (?, ?, 'extracted', ?) RETURNING id`,
      )
      .get(sessionId, 1, 100)!.id;
  });

  afterEach(() => {
    db.close();
  });

  test("assigns the turn to an attached segment with an empty tag set (vacuous pass)", () => {
    const segment = createSegment(db, { title: "target", nowEpoch: 100 });
    attachSegmentToSession(db, sessionId, segment.id, 100);

    const result = noteTool(
      db,
      { turn: `S${sessionId}/T1`, segment: `E${segment.id}` },
      { callerSessionId: sessionId },
    );
    expect(isNoteSuccess(result)).toBe(true);
    expect(resultText(result)).toContain(`Assigned to E${segment.id}`);
    expect(getSegmentMemberTurnIds(db, segment.id)).toEqual([turnId]);
  });

  test("rejects an unattached segment, naming the attachment requirement", () => {
    const segment = createSegment(db, { title: "unattached", nowEpoch: 100 });
    // deliberately NOT attached to this session

    const result = noteTool(
      db,
      { turn: `S${sessionId}/T1`, segment: `E${segment.id}` },
      { callerSessionId: sessionId },
    );
    expect(resultText(result)).toStartWith("Parameter error:");
    expect(resultText(result)).toContain("attached");
    expect(getSegmentMemberTurnIds(db, segment.id)).toEqual([]);
  });

  test("rejects a nonexistent segment", () => {
    const result = noteTool(
      db,
      { turn: `S${sessionId}/T1`, segment: "E999999" },
      { callerSessionId: sessionId },
    );
    expect(resultText(result)).toStartWith("Parameter error:");
    expect(getSegmentMemberTurnIds(db, 999999)).toEqual([]);
  });

  test("rejects when the caller session is unknown — attachment cannot be verified", () => {
    const segment = createSegment(db, { title: "target", nowEpoch: 100 });
    attachSegmentToSession(db, sessionId, segment.id, 100);

    const result = noteTool(db, { turn: `S${sessionId}/T1`, segment: `E${segment.id}` });
    expect(resultText(result)).toStartWith("Parameter error:");
    expect(resultText(result)).toContain("caller session unknown");
    expect(getSegmentMemberTurnIds(db, segment.id)).toEqual([]);
  });

  test("the segment's own tags gate the assignment: a turn missing one is refused, naming the gap and the segment", () => {
    const segment = createSegment(db, {
      title: "gated",
      tags: ["lease", "fencing"],
      nowEpoch: 100,
    });
    attachSegmentToSession(db, sessionId, segment.id, 100);
    setTags(turnId, ["lease"]); // missing "fencing"

    const result = noteTool(
      db,
      { turn: `S${sessionId}/T1`, segment: `E${segment.id}` },
      { callerSessionId: sessionId },
    );
    expect(resultText(result)).toStartWith("Parameter error:");
    expect(resultText(result)).toContain("fencing");
    expect(resultText(result)).toContain(`E${segment.id}`);
    expect(getSegmentMemberTurnIds(db, segment.id)).toEqual([]);
  });

  test("the gate judges the turn's tags AFTER this same call's own tags write", () => {
    const segment = createSegment(db, {
      title: "gated",
      tags: ["lease", "fencing"],
      nowEpoch: 100,
    });
    attachSegmentToSession(db, sessionId, segment.id, 100);
    setTags(turnId, ["lease"]); // starts missing "fencing"

    const result = noteTool(
      db,
      {
        turn: `S${sessionId}/T1`,
        tags: ["lease", "fencing"],
        mode: { tags: "write" },
        segment: `E${segment.id}`,
      },
      { callerSessionId: sessionId },
    );
    expect(resultText(result)).toContain(`Assigned to E${segment.id}`);
    expect(getSegmentMemberTurnIds(db, segment.id)).toEqual([turnId]);
  });

  // Ticket 02 (edge-mechanism-revision D1) established the pattern for a pure
  // edge call; ticket 07 extends it — a pure `segment` call is also complete.
  test("a segment parameter alone (no other field) is a complete call", () => {
    const segment = createSegment(db, { title: "target", nowEpoch: 100 });
    attachSegmentToSession(db, sessionId, segment.id, 100);

    const result = noteTool(
      db,
      { turn: `S${sessionId}/T1`, segment: `E${segment.id}` },
      { callerSessionId: sessionId },
    );
    expect(isNoteSuccess(result)).toBe(true);
  });

  test("reassigns — vacates the prior segment when moved to a new attached segment", () => {
    const segmentA = createSegment(db, { title: "a", nowEpoch: 100 });
    const segmentB = createSegment(db, { title: "b", nowEpoch: 100 });
    attachSegmentToSession(db, sessionId, segmentA.id, 100);
    attachSegmentToSession(db, sessionId, segmentB.id, 100);

    noteTool(
      db,
      { turn: `S${sessionId}/T1`, segment: `E${segmentA.id}` },
      { callerSessionId: sessionId },
    );
    expect(getSegmentMemberTurnIds(db, segmentA.id)).toEqual([turnId]);

    const result = noteTool(
      db,
      { turn: `S${sessionId}/T1`, segment: `E${segmentB.id}` },
      { callerSessionId: sessionId },
    );
    expect(resultText(result)).toContain(`Assigned to E${segmentB.id}`);
    expect(resultText(result)).toContain(`Removed from prior segment(s): E${segmentA.id}`);
    expect(getSegmentMemberTurnIds(db, segmentA.id)).toEqual([]);
    expect(getSegmentMemberTurnIds(db, segmentB.id)).toEqual([turnId]);
  });

  // Mutation check (this ticket's own acceptance criterion): if the gate
  // call in `handleTurnWrite` were removed, this test would let a mismatched
  // turn through undetected — it must fail loudly instead.
  test("MUTATION CHECK: disabling the gate on this path would let a mismatched turn through undetected", () => {
    const segment = createSegment(db, { title: "gated", tags: ["required"], nowEpoch: 100 });
    attachSegmentToSession(db, sessionId, segment.id, 100);
    // turnId carries no tags at all.

    const result = noteTool(
      db,
      { turn: `S${sessionId}/T1`, segment: `E${segment.id}` },
      { callerSessionId: sessionId },
    );
    expect(resultText(result)).toStartWith("Parameter error:");
    expect(getSegmentMemberTurnIds(db, segment.id)).toEqual([]);
  });
});
