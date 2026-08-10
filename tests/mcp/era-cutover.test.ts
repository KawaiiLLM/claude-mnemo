import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase, runWriteTransaction } from "../../src/db/database";
import { getNoteDebt, reconcileNoteDebt } from "../../src/db/note-debt";
import { initializeSchema } from "../../src/db/schema";
import { getShadowNote } from "../../src/db/shadow-notes";
import { upsertSession } from "../../src/db/sessions";
import { getStrandedTurns, getTurnById } from "../../src/db/turns";
import { createDatabaseBackedHandlers } from "../../src/mcp/handlers";
import { isNoteSuccess, noteTool } from "../../src/mcp/note";
import { isRememberSuccess, rememberTool } from "../../src/mcp/remember";

/**
 * Ticket 09 — the P2 cutover: for turns created at or after the cutoff the main
 * agent's `note` becomes the official turn record, and the extraction
 * subagent's writeback stops producing one. Everything created earlier keeps
 * the legacy arrangement, in the same session.
 */

const CUTOFF = 2_000;

function resultText(result: { content: Array<{ text: string }> }): string {
  return result.content[0]!.text;
}

/** Every column of a turns row, as stored — "nothing changed" needs all of it. */
function snapshotTurnRow(db: Database, turnId: number): string {
  return JSON.stringify(
    db
      .query<Record<string, unknown>, [number]>(
        "SELECT * FROM turns WHERE id = ?",
      )
      .get(turnId),
  );
}

describe("era cutover write path", () => {
  let db: Database;
  let sessionId: number;
  let legacyTurnId: number;
  let eraTurnId: number;
  let rideTurnId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    sessionId = upsertSession(db, {
      contentSessionId: "era-session",
      project: "claude-mnemo",
      title: "Session that spans the cutover",
      content: "Initial session summary",
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 110,
      completedAtEpoch: null,
    }).id;

    // One session, both eras (spec D11: the boundary is per turn, and a session
    // open across the switch renders each half under its own semantics).
    const insertTurn = db.query<
      { id: number },
      [number, number, string, number]
    >(
      `INSERT INTO turns (session_id, prompt_number, status, user_prompt,
                          assistant_response, created_at_epoch)
       VALUES (?, ?, 'active', ?, 'response text', ?) RETURNING id`,
    );
    legacyTurnId = insertTurn.get(sessionId, 10, "Before the cutover", 1_000)!.id;
    eraTurnId = insertTurn.get(sessionId, 11, "After the cutover", 3_000)!.id;
    rideTurnId = insertTurn.get(sessionId, 12, "Where the session is now", 3_100)!.id;

    // A note needs an open debt, which needs a finished turn with a substantive
    // tool call — produced the way the system produces it. The queued
    // `turn-stop` is the completion evidence the ledger insists on, and it also
    // puts both turns in exactly the state this ticket is about: finished, and
    // waiting for whoever writes their record.
    const insertObservation = db.query<unknown, [number, number]>(
      `INSERT INTO observations (turn_id, tool_name, excluded_from_extraction, created_at_epoch)
       VALUES (?, 'Edit', 0, ?)`,
    );
    const insertTurnStop = db.query<unknown, [number, number, number]>(
      `INSERT INTO pending_queue (kind, target_id, session_db_id, enqueued_at_epoch)
       VALUES ('turn-stop', ?, ?, ?)`,
    );
    insertObservation.run(legacyTurnId, 1_000);
    insertObservation.run(eraTurnId, 3_000);
    insertTurnStop.run(legacyTurnId, sessionId, 1_000);
    insertTurnStop.run(eraTurnId, sessionId, 3_000);
    reconcileNoteDebt(db, { sessionId, nowEpoch: 3_200 });
    expect(getNoteDebt(db, legacyTurnId)?.status).toBe("pending");
    expect(getNoteDebt(db, eraTurnId)?.status).toBe("pending");
  });

  afterEach(() => {
    db.close();
  });

  describe("note promotes an era turn's record", () => {
    test("writes title/content/insight onto the turn and advances its status", () => {
      const result = noteTool(
        db,
        {
          turn: `S${sessionId}/T11`,
          title: "implement+era-cutover: the note is the record",
          content: "Promotion writes turns directly; the shadow row stays.",
          insight: "The cutoff is compared per turn, so a session can span it.",
        },
        { now: () => 3_300, env: {}, eraCutoffEpoch: CUTOFF },
      );

      expect(isNoteSuccess(result)).toBe(true);

      const turn = getTurnById(db, eraTurnId)!;
      expect(turn.title).toBe("implement+era-cutover: the note is the record");
      expect(turn.content).toBe(
        "Promotion writes turns directly; the shadow row stays.",
      );
      expect(turn.insight).toBe(
        "The cutoff is compared per turn, so a session can span it.",
      );
      // Not `extracted` yet: the note was written inside its own turn, and
      // `extracted` is read across the codebase as "this turn is over".
      expect(turn.status).toBe("provisional");
      expect(turn.updatedAtEpoch).toBe(3_300);
    });

    test("keeps the turn live for observation capture while it is still running", () => {
      noteTool(
        db,
        {
          turn: `S${sessionId}/T11`,
          title: "implement+era-cutover: mid-turn note",
          content: "The turn may still call more tools after this.",
        },
        { now: () => 3_300, env: {}, eraCutoffEpoch: CUTOFF },
      );

      // The capture path (hooks/handlers/post-tool-use.ts) drops every
      // observation once the session's newest turn stops reading as live, so a
      // promotion straight to `extracted` would silently truncate the raw axis
      // for the rest of the turn.
      const status = getTurnById(db, eraTurnId)!.status;
      expect(status === "active" || status === "provisional").toBe(true);
    });

    test("a late note on a turn that already ended lands as extracted", () => {
      // The backlog relief's case: the turn was settled as a hole, and the
      // agent answers for it afterwards.
      rememberTool(
        db,
        { id: `T${eraTurnId}`, title: "nothing to extract" },
        { eraCutoffEpoch: CUTOFF },
      );
      expect(getTurnById(db, eraTurnId)!.status).toBe("skipped");

      noteTool(
        db,
        {
          turn: `S${sessionId}/T11`,
          title: "implement+era-cutover: late note",
          content: "Written after the turn was settled as a hole.",
        },
        { now: () => 3_400, env: {}, eraCutoffEpoch: CUTOFF },
      );

      const turn = getTurnById(db, eraTurnId)!;
      expect(turn.title).toBe("implement+era-cutover: late note");
      expect(turn.status).toBe("extracted");
    });

    test("keeps the shadow row as the provenance record", () => {
      noteTool(
        db,
        {
          turn: `S${sessionId}/T11`,
          title: "implement+era-cutover: provenance",
          content: "Who wrote it is still recorded beside the turn.",
        },
        {
          now: () => 3_300,
          env: { CLAUDE_MNEMO_WRITER_MODEL: "claude-opus-5" },
          eraCutoffEpoch: CUTOFF,
        },
      );

      const note = getShadowNote(db, eraTurnId)!;
      expect(note.title).toBe("implement+era-cutover: provenance");
      expect(note.writerOrigin).toBe("agent");
      expect(note.writerModel).toBe("claude-opus-5");
      expect(note.rideTurnId).toBe(rideTurnId);
      expect(getNoteDebt(db, eraTurnId)?.status).toBe("noted");
    });

    test("promotion, shadow row and debt closure share one transaction", () => {
      const before = snapshotTurnRow(db, eraTurnId);

      expect(() =>
        noteTool(
          db,
          {
            turn: `S${sessionId}/T11`,
            title: "implement+era-cutover: atomicity",
            content: "A failure after the promotion must take it back.",
          },
          {
            now: () => 3_300,
            env: {},
            eraCutoffEpoch: CUTOFF,
            // Fails INSIDE the transaction, after the tool's whole write body
            // has run — so anything that landed outside it would survive.
            runWriteTransaction: (database, fn) =>
              runWriteTransaction(database, () => {
                fn();
                throw new Error("interrupted mid-write");
              }),
          },
        ),
      ).toThrow("interrupted mid-write");

      expect(snapshotTurnRow(db, eraTurnId)).toBe(before);
      expect(getShadowNote(db, eraTurnId)).toBeNull();
      expect(getNoteDebt(db, eraTurnId)?.status).toBe("pending");
    });

    test("a rewrite that drops its insight stores the NULL rather than the old one", () => {
      const options = { now: () => 3_300, env: {}, eraCutoffEpoch: CUTOFF };
      noteTool(
        db,
        {
          turn: `S${sessionId}/T11`,
          title: "first title",
          content: "first content",
          insight: "first insight",
        },
        options,
      );
      noteTool(
        db,
        {
          turn: `S${sessionId}/T11`,
          title: "second title",
          content: "second content",
        },
        { ...options, now: () => 3_400 },
      );

      const turn = getTurnById(db, eraTurnId)!;
      expect(turn.title).toBe("second title");
      expect(turn.insight).toBeNull();
      expect(getShadowNote(db, eraTurnId)!.insight).toBeNull();
    });

    test("leaves a pre-cutoff turn's row byte-identical while the era is on", () => {
      const before = snapshotTurnRow(db, legacyTurnId);

      const result = noteTool(
        db,
        {
          turn: `S${sessionId}/T10`,
          title: "implement+era-cutover: legacy stays legacy",
          content: "Old turns keep the shadow-only arrangement.",
          insight: "No backfill reconciles the two halves.",
        },
        { now: () => 3_300, env: {}, eraCutoffEpoch: CUTOFF },
      );

      expect(isNoteSuccess(result)).toBe(true);
      expect(snapshotTurnRow(db, legacyTurnId)).toBe(before);
      expect(getShadowNote(db, legacyTurnId)).not.toBeNull();
    });
  });

  describe("the extraction subagent stops writing era turn notes", () => {
    test("stores nothing it supplied and settles the hole as skipped", () => {
      const result = rememberTool(
        db,
        {
          id: `T${eraTurnId}`,
          grade: 3,
          type: "implement",
          title: "observer's reconstruction",
          content: "Written from the transcript, not from the turn itself.",
          insight: "Should never reach the record.",
          tags: ["era-cutover"],
        },
        { eraCutoffEpoch: CUTOFF },
      );

      // Reads as a success on purpose: an error would leave the turn id
      // unresolved in the worker's work unit and start the derailment ladder.
      expect(isRememberSuccess(result)).toBe(true);
      expect(resultText(result)).toContain("status skipped");

      const turn = getTurnById(db, eraTurnId)!;
      expect(turn.title).toBeNull();
      expect(turn.content).toBeNull();
      expect(turn.insight).toBeNull();
      expect(turn.type).toBeNull();
      expect(turn.tags).toEqual([]);
      expect(turn.significanceGrade).toBeNull();
      // 裁决 27: an un-noted era turn stays a hole. `skipped` is what a hole
      // has always looked like, not a rescue.
      expect(turn.status).toBe("skipped");
    });

    test("a settled hole is not re-offered — nothing spins", () => {
      // Still open before the writeback: the stranded repair would re-enqueue
      // it, which is the loop the status advance exists to close.
      expect(getStrandedTurns(db, sessionId).map((t) => t.id)).toContain(
        eraTurnId,
      );

      rememberTool(
        db,
        { id: `T${eraTurnId}`, grade: 0, title: "nothing to extract" },
        { eraCutoffEpoch: CUTOFF },
      );

      expect(getStrandedTurns(db, sessionId).map((t) => t.id)).not.toContain(
        eraTurnId,
      );
    });

    test("never demotes or overwrites a turn the main agent already noted", () => {
      noteTool(
        db,
        {
          turn: `S${sessionId}/T11`,
          title: "the agent's own note",
          content: "First-person record of this turn.",
        },
        { now: () => 3_300, env: {}, eraCutoffEpoch: CUTOFF },
      );

      const result = rememberTool(
        db,
        {
          id: `T${eraTurnId}`,
          grade: 2,
          title: "the observer's version",
          content: "Reconstructed after the fact.",
        },
        { eraCutoffEpoch: CUTOFF },
      );

      expect(isRememberSuccess(result)).toBe(true);
      const turn = getTurnById(db, eraTurnId)!;
      expect(turn.title).toBe("the agent's own note");
      expect(turn.content).toBe("First-person record of this turn.");
      // The turn's end is what finishes the promotion the note started: the
      // record is there, so the settle reads `extracted` rather than `skipped`.
      expect(turn.status).toBe("extracted");
    });

    test("a noted turn is out of the stranded selection once its turn ends", () => {
      noteTool(
        db,
        {
          turn: `S${sessionId}/T11`,
          title: "the agent's own note",
          content: "First-person record of this turn.",
        },
        { now: () => 3_300, env: {}, eraCutoffEpoch: CUTOFF },
      );
      // Still selectable while `provisional` — correct, the turn is live.
      expect(getStrandedTurns(db, sessionId).map((t) => t.id)).toContain(
        eraTurnId,
      );

      rememberTool(db, { id: `T${eraTurnId}` }, { eraCutoffEpoch: CUTOFF });

      expect(getStrandedTurns(db, sessionId).map((t) => t.id)).not.toContain(
        eraTurnId,
      );
    });

    test("extracts a pre-cutoff turn exactly as before while the era is on", () => {
      const result = rememberTool(
        db,
        {
          id: `T${legacyTurnId}`,
          grade: 2,
          type: "implement",
          title: "legacy extraction",
          content: "The old pipeline still owns this row.",
          tags: ["legacy"],
        },
        { eraCutoffEpoch: CUTOFF },
      );

      expect(isRememberSuccess(result)).toBe(true);
      const turn = getTurnById(db, legacyTurnId)!;
      expect(turn.title).toBe("legacy extraction");
      expect(turn.content).toBe("The old pipeline still owns this row.");
      expect(turn.type).toBe("implement");
      expect(turn.tags).toEqual(["legacy"]);
      expect(turn.significanceGrade).toBe(2);
      expect(turn.status).toBe("extracted");
    });
  });

  describe("rollback: a null cutoff is the behaviour from before the ticket", () => {
    test("note writes the shadow row only, whatever the turn's date", () => {
      const before = snapshotTurnRow(db, eraTurnId);

      noteTool(
        db,
        {
          turn: `S${sessionId}/T11`,
          title: "implement+era-cutover: rollback",
          content: "With no cutoff every turn is legacy.",
        },
        { now: () => 3_300, env: {}, eraCutoffEpoch: null },
      );

      expect(snapshotTurnRow(db, eraTurnId)).toBe(before);
      expect(getShadowNote(db, eraTurnId)).not.toBeNull();
      expect(getNoteDebt(db, eraTurnId)?.status).toBe("noted");
    });

    test("remember extracts the same turn the era gate would have refused", () => {
      const result = rememberTool(
        db,
        {
          id: `T${eraTurnId}`,
          grade: 3,
          type: "implement",
          title: "extraction still owns this",
          content: "Rolled back to the legacy write path.",
          tags: ["rollback"],
        },
        { eraCutoffEpoch: null },
      );

      expect(isRememberSuccess(result)).toBe(true);
      const turn = getTurnById(db, eraTurnId)!;
      expect(turn.title).toBe("extraction still owns this");
      expect(turn.type).toBe("implement");
      expect(turn.tags).toEqual(["rollback"]);
      expect(turn.significanceGrade).toBe(3);
      expect(turn.status).toBe("extracted");
    });

    test("an omitted cutoff behaves as a null one", () => {
      const before = snapshotTurnRow(db, eraTurnId);

      noteTool(
        db,
        {
          turn: `S${sessionId}/T11`,
          title: "implement+era-cutover: default",
          content: "No option supplied at all.",
        },
        { now: () => 3_300, env: {} },
      );

      expect(snapshotTurnRow(db, eraTurnId)).toBe(before);
      expect(getShadowNote(db, eraTurnId)).not.toBeNull();
    });
  });

  describe("handler wiring", () => {
    test("hands reads and writes the one resolved cutoff", async () => {
      const handlers = createDatabaseBackedHandlers(db, {
        eraCutoffEpoch: CUTOFF,
      });

      await handlers.note!({
        turn: `S${sessionId}/T11`,
        title: "implement+era-cutover: wiring",
        content: "The handler layer resolves the era once.",
      });
      expect(getTurnById(db, eraTurnId)!.title).toBe(
        "implement+era-cutover: wiring",
      );

      await handlers.remember!({
        id: `T${eraTurnId}`,
        grade: 4,
        title: "observer override",
        content: "Must not land.",
      });
      expect(getTurnById(db, eraTurnId)!.title).toBe(
        "implement+era-cutover: wiring",
      );
    });

    test("defaults to the legacy path when no cutoff is configured", async () => {
      const handlers = createDatabaseBackedHandlers(db, {
        eraCutoffEpoch: null,
      });
      const before = snapshotTurnRow(db, eraTurnId);

      await handlers.note!({
        turn: `S${sessionId}/T11`,
        title: "implement+era-cutover: inert",
        content: "Nothing reaches the turn row.",
      });

      expect(snapshotTurnRow(db, eraTurnId)).toBe(before);
    });
  });
});
