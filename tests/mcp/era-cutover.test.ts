import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase, runWriteTransaction } from "../../src/db/database";
import { ensureRecordedEraCutoff } from "../../src/db/era";
import { getNoteDebt } from "../../src/db/note-debt";
import { initializeSchema } from "../../src/db/schema";
import { getShadowNote } from "../../src/db/shadow-notes";
import { upsertSession } from "../../src/db/sessions";
import { settleOutstandingTurns } from "../../src/db/turn-settlement";
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

/**
 * Run `fire` the instant after the next read of a turns row, then get out of
 * the way. The main agent notes its own turn while the turn is still running,
 * so a note transaction really can commit between a writeback's read of the row
 * and its write; this reproduces that interleave deterministically.
 */
function fireAfterNextTurnRead(db: Database, fire: () => void): void {
  const originalQuery = db.query.bind(db);
  let armed = true;
  (db as unknown as { query: (sql: string) => unknown }).query = (
    sql: string,
  ) => {
    const statement = originalQuery(sql) as unknown as {
      get: (...args: unknown[]) => unknown;
    };
    if (!armed || !/^\s*SELECT/i.test(sql) || !/FROM turns/i.test(sql)) {
      return statement;
    }
    const originalGet = statement.get.bind(statement);
    statement.get = (...args: unknown[]) => {
      const row = originalGet(...args);
      if (armed) {
        armed = false;
        statement.get = originalGet;
        (db as unknown as { query: unknown }).query = originalQuery;
        fire();
      }
      return row;
    };
    return statement;
  };
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
    // Ticket 15 gave the turns their terminal statuses AND opened their debts
    // in one pass; note-prompt-clock ticket 03 retired that whole
    // classification walk (owed turns are a derived query now — spec D1) and
    // ticket 02 split settlement out into its own channel first. This fixture
    // reproduces exactly the end state the walk used to leave: settlement
    // gives each turn its terminal status, and a `pending` `note_debt` row is
    // seeded directly the way a pre-cutover database still carries one — the
    // era turn becomes the hole `skipped` names; the pre-era one becomes
    // `failed`, which is what a turn whose only writer is gone has always
    // been called.
    settleOutstandingTurns(db, sessionId, CUTOFF, 3_200);
    const insertPendingDebt = db.query<unknown, [number, number, number]>(
      `INSERT INTO note_debt (turn_id, session_id, prompt_number, status, opened_at_epoch, updated_at_epoch)
       VALUES (?, ?, ?, 'pending', 3200, 3200)`,
    );
    insertPendingDebt.run(legacyTurnId, sessionId, 10);
    insertPendingDebt.run(eraTurnId, sessionId, 11);
    expect(getNoteDebt(db, legacyTurnId)?.status).toBe("pending");
    expect(getNoteDebt(db, eraTurnId)?.status).toBe("pending");
    expect(getTurnById(db, eraTurnId)?.status).toBe("skipped");
    expect(getTurnById(db, legacyTurnId)?.status).toBe("failed");
    expect(getTurnById(db, rideTurnId)?.status).toBe("active");
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
      // This turn already ended, so its completion settled it as a hole and the
      // note is the backlog relief's answer: a record is a record, and a row
      // holding one is `extracted` (db/search.ts renders only those).
      expect(turn.status).toBe("extracted");
      expect(turn.updatedAtEpoch).toBe(3_300);
    });

    test("keeps the turn live for observation capture while it is still running", () => {
      // The session's current turn (裁决 25) — the ordinary case now that a
      // note is written inside the turn it is about.
      noteTool(
        db,
        {
          turn: `S${sessionId}/T12`,
          title: "implement+era-cutover: mid-turn note",
          content: "The turn may still call more tools after this.",
        },
        { now: () => 3_300, env: {}, eraCutoffEpoch: CUTOFF },
      );

      // The capture path (hooks/handlers/post-tool-use.ts) drops every
      // observation once the session's newest turn stops reading as live, so a
      // promotion straight to `extracted` would silently truncate the raw axis
      // for the rest of the turn.
      expect(getTurnById(db, rideTurnId)!.status).toBe("provisional");
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
          replace: true,
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
      // The turn's own completion already took it out of the selection; the
      // writeback must not put it back. This is the loop the mechanical
      // settlement exists to close — the stranded repair re-enqueues anything
      // left `active`/`provisional` on every end event, forever.
      expect(getStrandedTurns(db, sessionId).map((t) => t.id)).not.toContain(
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

      rememberTool(db, { id: `T${eraTurnId}` }, { eraCutoffEpoch: CUTOFF });

      expect(getStrandedTurns(db, sessionId).map((t) => t.id)).not.toContain(
        eraTurnId,
      );
    });

    test("decides from the row as it stands when a note commits mid-settle", () => {
      fireAfterNextTurnRead(db, () => {
        noteTool(
          db,
          {
            turn: `S${sessionId}/T11`,
            title: "the agent's own note",
            content: "Written while the writeback was still deciding.",
          },
          { now: () => 3_300, env: {}, eraCutoffEpoch: CUTOFF },
        );
      });

      const result = rememberTool(
        db,
        { id: `T${eraTurnId}`, grade: 1, title: "the observer's version" },
        { eraCutoffEpoch: CUTOFF },
      );

      // A decision taken before the note committed would force `skipped` onto a
      // turn that now holds a record — hiding it from search.
      expect(isRememberSuccess(result)).toBe(true);
      expect(resultText(result)).toContain("status extracted");
      const turn = getTurnById(db, eraTurnId)!;
      expect(turn.title).toBe("the agent's own note");
      expect(turn.status).toBe("extracted");
    });

    test("leaves an already-terminal turn exactly as it found it", () => {
      // The stranded repair's floor may have settled the turn first
      // (worker/turn-liveness.ts); a late writeback is not a licence to move a
      // terminal status, in either direction.
      db.query<unknown, [number]>(
        "UPDATE turns SET status = 'failed' WHERE id = ?",
      ).run(eraTurnId);
      db.query<unknown, [number]>(
        "UPDATE turns SET status = 'undone' WHERE id = ?",
      ).run(rideTurnId);
      const beforeFailed = snapshotTurnRow(db, eraTurnId);
      const beforeUndone = snapshotTurnRow(db, rideTurnId);

      const failedResult = rememberTool(
        db,
        { id: `T${eraTurnId}`, title: "late observer" },
        { eraCutoffEpoch: CUTOFF },
      );
      const undoneResult = rememberTool(
        db,
        { id: `T${rideTurnId}`, title: "late observer" },
        { eraCutoffEpoch: CUTOFF },
      );

      expect(isRememberSuccess(failedResult)).toBe(true);
      expect(resultText(failedResult)).toContain("status failed");
      expect(snapshotTurnRow(db, eraTurnId)).toBe(beforeFailed);
      expect(isRememberSuccess(undoneResult)).toBe(true);
      expect(snapshotTurnRow(db, rideTurnId)).toBe(beforeUndone);
    });

    test("settles an era turn whose status field the turn route would reject", () => {
      // `extracted` is not in the turn route's allowed set, and the validation
      // that says so used to run before the turn was even loaded — so an era
      // turn came back `Parameter error`, leaving its id unresolved in the
      // worker's work unit and starting the derailment ladder.
      const result = rememberTool(
        db,
        {
          id: `T${eraTurnId}`,
          status: "extracted",
          title: "observer's reconstruction",
        },
        { eraCutoffEpoch: CUTOFF },
      );

      expect(isRememberSuccess(result)).toBe(true);
      const turn = getTurnById(db, eraTurnId)!;
      expect(turn.status).toBe("skipped");
      expect(turn.title).toBeNull();
    });

    test("still rejects that status on a pre-cutoff turn", () => {
      const result = rememberTool(
        db,
        {
          id: `T${legacyTurnId}`,
          grade: 2,
          status: "extracted",
          title: "legacy extraction",
        },
        { eraCutoffEpoch: CUTOFF },
      );

      expect(resultText(result)).toContain("Parameter error");
      expect(getTurnById(db, legacyTurnId)!.title).toBeNull();
    });

    test("answers a missing turn with not-found, whatever the payload", () => {
      const result = rememberTool(
        db,
        { id: "T999999", status: "extracted" },
        { eraCutoffEpoch: CUTOFF },
      );

      expect(resultText(result)).toBe("Turn T999999 not found.");
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

    test("picks up a boundary recorded after the handlers were built", async () => {
      // The MCP server is spawned with the session and builds its handlers at
      // connect time, which can be before any process of this build has
      // recorded the era. Resolving once at that moment pinned `null`, so every
      // `note` for the rest of the session wrote a shadow note and left the
      // turn row empty — while the hooks, resolving live, settled that same row
      // as a new-era hole. The note was written and then lost.
      const handlers = createDatabaseBackedHandlers(db);
      expect(getTurnById(db, eraTurnId)!.title).toBeNull();

      ensureRecordedEraCutoff(db, CUTOFF);

      await handlers.note!({
        turn: `S${sessionId}/T11`,
        title: "implement+era-cutover: late boundary",
        content: "Recorded after the handlers were built.",
      });

      expect(getTurnById(db, eraTurnId)!.title).toBe(
        "implement+era-cutover: late boundary",
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
