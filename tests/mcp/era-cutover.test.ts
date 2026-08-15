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
      // agent answers for it afterwards. `beforeEach` already produced that
      // hole via settleOutstandingTurns (status 'skipped', no title/content);
      // ticket 04 lifted remember's era refusal, so remember is no longer a
      // way to reaffirm a hole without writing to it — the settled state
      // asserted here comes straight from the fixture.
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

  describe("note accepts type/tags from the caller directly (ticket 02, spec B1/B2/B6/B7)", () => {
    test("a recognised type list lands verbatim, and bare tags land with no namespace prefix", () => {
      const result = noteTool(
        db,
        {
          turn: `S${sessionId}/T11`,
          title: "implement+shadow-store: notes land in their own table",
          content: "Promotion writes turns directly.",
          type: ["implement"],
          tags: ["shadow-store"],
        },
        { now: () => 3_300, env: {}, eraCutoffEpoch: CUTOFF },
      );

      expect(isNoteSuccess(result)).toBe(true);
      const turn = getTurnById(db, eraTurnId)!;
      expect(turn.type).toEqual(["implement"]);
      expect(turn.tags).toContain("shadow-store");
    });

    test("an unrecognised activity word is a parameter error, never a stored guess", () => {
      const result = noteTool(
        db,
        {
          turn: `S${sessionId}/T11`,
          title: "addendum+the-plan: appended a clause nobody expected",
          content: "The activity word has no alias in the vocabulary.",
          type: ["addendum"],
        },
        { now: () => 3_300, env: {}, eraCutoffEpoch: CUTOFF },
      );

      expect(isNoteSuccess(result)).toBe(false);
      expect(result.content[0]?.text).toContain("addendum");
      // The whole call was rejected: nothing landed at all, so the column
      // stays at its default — never the literal unrecognised word.
      const turn = getTurnById(db, eraTurnId)!;
      expect(turn.type).toEqual([]);
    });

    test("omitting type/tags leaves them empty — never a guess derived from the title (spec B7)", () => {
      const result = noteTool(
        db,
        {
          turn: `S${sessionId}/T11`,
          title: "implement+the-plan: a title that LOOKS like it states an activity",
          content: "But the caller never named a type, so none is stored.",
        },
        { now: () => 3_300, env: {}, eraCutoffEpoch: CUTOFF },
      );

      expect(isNoteSuccess(result)).toBe(true);
      const turn = getTurnById(db, eraTurnId)!;
      expect(turn.type).toEqual([]);
      expect(turn.tags).toEqual([]);
    });

    test("a multi-valued type round-trips in full, and a replace restates it rather than accumulating", () => {
      const options = { now: () => 3_300, env: {}, eraCutoffEpoch: CUTOFF };
      noteTool(
        db,
        {
          turn: `S${sessionId}/T11`,
          title: "implement+login-flow: first pass",
          content: "First answer.",
          type: ["implement"],
          tags: ["login-flow"],
        },
        options,
      );
      expect(getTurnById(db, eraTurnId)!.type).toEqual(["implement"]);

      noteTool(
        db,
        {
          turn: `S${sessionId}/T11`,
          title: "fix+auth-bug: corrected after review, also reviewed the fix",
          content: "The first pass mischaracterised the turn.",
          type: ["review", "fix"],
          replace: true,
        },
        { ...options, now: () => 3_400 },
      );

      const turn = getTurnById(db, eraTurnId)!;
      // A stated type replaces the stored one whole: the redraft says
      // "review, fix", so the first call's "implement" is gone rather than
      // accumulated onto.
      expect(turn.type).toEqual(["review", "fix"]);
      // This call stated no tags at all, and absent means leave alone — so
      // the first call's "login-flow" is still there. It survives because
      // nothing overwrote it, not because tags accumulate.
      expect(turn.tags).toEqual(["login-flow"]);
    });

    test("a corrected note that omits type leaves the stored value alone; clearing takes an explicit empty list (spec B7)", () => {
      // B7 says empty is NEVER a claim, so writing empty cannot be the act of
      // claiming there is no type — an omitted field is silence, and silence
      // must not overwrite something another pass stated. The same shape was
      // ruled on twice for relation edges (spec C14/C16): the absence of a
      // statement is not a statement of absence. Clearing stays expressible,
      // it just has to be said.
      const options = { now: () => 3_300, env: {}, eraCutoffEpoch: CUTOFF };
      noteTool(
        db,
        {
          turn: `S${sessionId}/T11`,
          title: "implement+login-flow: first pass",
          content: "First answer.",
          type: ["implement"],
        },
        options,
      );
      expect(getTurnById(db, eraTurnId)!.type).toEqual(["implement"]);

      noteTool(
        db,
        {
          turn: `S${sessionId}/T11`,
          title: "a plain corrected title with no shape at all",
          content: "The correction dropped the <activity>+<topic>: shape.",
          replace: true,
        },
        { ...options, now: () => 3_400 },
      );
      expect(getTurnById(db, eraTurnId)!.type).toEqual(["implement"]);

      noteTool(
        db,
        {
          turn: `S${sessionId}/T11`,
          title: "a correction that really does mean none of them fit",
          content: "An explicit empty list is the way to say so.",
          type: [],
          replace: true,
        },
        { ...options, now: () => 3_500 },
      );
      expect(getTurnById(db, eraTurnId)!.type).toEqual([]);
    });

    test("tags present replace the stored set whole; tags absent leave it alone (one rule, not a per-field mechanism)", () => {
      const options = { now: () => 3_300, env: {}, eraCutoffEpoch: CUTOFF };
      noteTool(
        db,
        {
          turn: `S${sessionId}/T11`,
          title: "implement+login-flow: first pass",
          content: "First answer.",
          tags: ["login-flow", "session-cookie"],
        },
        options,
      );
      expect(getTurnById(db, eraTurnId)!.tags).toEqual([
        "login-flow",
        "session-cookie",
      ]);

      // Present: a restatement, not an accumulation. `session-cookie` was not
      // restated, so it goes — which is what makes a retry idempotent (G5).
      noteTool(
        db,
        {
          turn: `S${sessionId}/T11`,
          title: "implement+login-flow: it was really about the redirect",
          content: "Second answer.",
          tags: ["login-flow", "oauth-redirect"],
          replace: true,
        },
        { ...options, now: () => 3_400 },
      );
      expect(getTurnById(db, eraTurnId)!.tags).toEqual([
        "login-flow",
        "oauth-redirect",
      ]);

      // Absent: silence, same as every other field.
      noteTool(
        db,
        {
          turn: `S${sessionId}/T11`,
          title: "implement+login-flow: wording only",
          content: "Third answer.",
          replace: true,
        },
        { ...options, now: () => 3_500 },
      );
      expect(getTurnById(db, eraTurnId)!.tags).toEqual([
        "login-flow",
        "oauth-redirect",
      ]);
    });
  });

  describe("remember writes era turns like legacy ones (ticket 04, D10 — the era refusal is lifted)", () => {
    test("a never-noted era turn (a hole) is fully writable through remember", () => {
      const result = rememberTool(
        db,
        {
          id: `T${eraTurnId}`,
          grade: 3,
          type: ["implement"],
          title: "observer's reconstruction",
          content: "Written from the transcript, not from the turn itself.",
          insight: "A late correction reaching the record.",
          tags: ["era-cutover"],
        },
        { eraCutoffEpoch: CUTOFF },
      );

      // Before ticket 04 this call would have read as a success while
      // storing nothing (裁决 27, ticket 09's now-retired refusal). The
      // review pass that replaced the resident extraction agent needs the
      // opposite — a real write path — so every field supplied now lands,
      // exactly as it would on a legacy turn.
      expect(isRememberSuccess(result)).toBe(true);
      expect(resultText(result)).toContain("status extracted");

      const turn = getTurnById(db, eraTurnId)!;
      expect(turn.title).toBe("observer's reconstruction");
      expect(turn.content).toBe(
        "Written from the transcript, not from the turn itself.",
      );
      expect(turn.insight).toBe("A late correction reaching the record.");
      expect(turn.type).toEqual(["implement"]);
      expect(turn.tags).toEqual(["era-cutover"]);
      expect(turn.significanceGrade).toBe(3);
      expect(turn.status).toBe("extracted");
    });

    test("a settled hole given only a title still leaves the stranded selection", () => {
      // The turn's own completion already took it out of the selection
      // (status 'skipped', not 'active'/'provisional'); a remember call must
      // not put it back there, whatever it supplies.
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

    test("a single field can be patched on an era turn without restating the rest, even after the main agent noted it", () => {
      noteTool(
        db,
        {
          turn: `S${sessionId}/T11`,
          title: "the agent's own note",
          content: "First-person record of this turn.",
        },
        { now: () => 3_300, env: {}, eraCutoffEpoch: CUTOFF },
      );

      // grade-only: title/content are omitted, not restated.
      const result = rememberTool(
        db,
        { id: `T${eraTurnId}`, grade: 2 },
        { eraCutoffEpoch: CUTOFF },
      );

      expect(isRememberSuccess(result)).toBe(true);
      const turn = getTurnById(db, eraTurnId)!;
      // The note's own title/content survive untouched (D10: per-field patch
      // semantics already existed and are kept for era turns too).
      expect(turn.title).toBe("the agent's own note");
      expect(turn.content).toBe("First-person record of this turn.");
      expect(turn.significanceGrade).toBe(2);
      expect(turn.status).toBe("extracted");
    });

    test("a field remember DOES supply overwrites even a note that committed mid-call — no special protection survives for era turns", () => {
      // Before ticket 04, the retired refusal re-read the row inside its own
      // UPDATE statement, so a note committing between remember's initial
      // read and its write could never be clobbered — remember's payload was
      // dropped wholesale regardless. Now era turns share the legacy write
      // path, which has no equivalent protection: whatever field remember
      // supplies wins over a concurrently-committed note, exactly like
      // legacy always has. This is a direct, intended consequence of "per-
      // field patch semantics already exist and are kept" (D10) — not
      // something this ticket added protection against.
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

      expect(isRememberSuccess(result)).toBe(true);
      expect(resultText(result)).toContain("status extracted");
      const turn = getTurnById(db, eraTurnId)!;
      // title was supplied, so it overwrites the note's title …
      expect(turn.title).toBe("the observer's version");
      // … but content, which this call omitted, keeps what the note wrote.
      expect(turn.content).toBe(
        "Written while the writeback was still deciding.",
      );
      expect(turn.status).toBe("extracted");
    });

    test("a title-bearing remember call now resurrects a terminal era turn, matching legacy — the era-specific immunity is gone", () => {
      // The retired refusal's own SQL guard (`status IN ('active',
      // 'provisional')`) made 'failed' rows immune to remember. That guard
      // was part of the refusal, not a separate protection — lifting the
      // refusal lifts this too. An era turn now runs the exact status
      // derivation a legacy turn always has (deriveTurnStatus), which has no
      // terminal-status floor: a late, title-bearing call resurrects it.
      db.query<unknown, [number]>(
        "UPDATE turns SET status = 'failed' WHERE id = ?",
      ).run(eraTurnId);

      const result = rememberTool(
        db,
        { id: `T${eraTurnId}`, grade: 2, title: "late observer" },
        { eraCutoffEpoch: CUTOFF },
      );

      expect(isRememberSuccess(result)).toBe(true);
      expect(resultText(result)).toContain("status extracted");
      const turn = getTurnById(db, eraTurnId)!;
      expect(turn.title).toBe("late observer");
      expect(turn.status).toBe("extracted");
    });

    test("an 'undone' sidechain row is no longer immune either — flagged, not fixed, as out of this ticket's scope", () => {
      // note.ts's promoteTurnFromNote explicitly refuses an 'undone' row ("a
      // sidechain row is not part of this session's arc, and promoting it
      // would put it back in view"). remember.ts's deriveTurnStatus has no
      // equivalent floor for an EXISTING undone row receiving an unrelated
      // field — it only special-cases an explicit `status: "undone"` in the
      // input. This was already true for legacy turns (untested, since a
      // resident extraction agent never targeted a sidechain row in
      // practice); routing era turns through the same path exposes it there
      // too. Pinned here as a regression marker, not a guarantee to keep.
      db.query<unknown, [number]>(
        "UPDATE turns SET status = 'undone' WHERE id = ?",
      ).run(rideTurnId);

      const result = rememberTool(
        db,
        { id: `T${rideTurnId}`, title: "late observer" },
        { eraCutoffEpoch: CUTOFF },
      );

      expect(isRememberSuccess(result)).toBe(true);
      const turn = getTurnById(db, rideTurnId)!;
      expect(turn.title).toBe("late observer");
      expect(turn.status).toBe("extracted");
    });

    test("status validation applies to era turns exactly as it does to legacy ones", () => {
      // `extracted` was never in the turn route's allowed status set
      // (TURN_REMEMBER_STATUSES). Before ticket 04 an era turn never reached
      // this check — the retired refusal ran first and read as a success
      // regardless of the input. Now every turn is validated identically.
      const eraResult = rememberTool(
        db,
        {
          id: `T${eraTurnId}`,
          status: "extracted",
          title: "observer's reconstruction",
        },
        { eraCutoffEpoch: CUTOFF },
      );
      const legacyResult = rememberTool(
        db,
        {
          id: `T${legacyTurnId}`,
          grade: 2,
          status: "extracted",
          title: "legacy extraction",
        },
        { eraCutoffEpoch: CUTOFF },
      );

      expect(resultText(eraResult)).toContain("Parameter error");
      expect(getTurnById(db, eraTurnId)!.title).toBeNull();
      expect(resultText(legacyResult)).toContain("Parameter error");
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
          type: ["implement"],
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
      expect(turn.type).toEqual(["implement"]);
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
          type: ["implement"],
          title: "extraction still owns this",
          content: "Rolled back to the legacy write path.",
          tags: ["rollback"],
        },
        { eraCutoffEpoch: null },
      );

      expect(isRememberSuccess(result)).toBe(true);
      const turn = getTurnById(db, eraTurnId)!;
      expect(turn.title).toBe("extraction still owns this");
      expect(turn.type).toEqual(["implement"]);
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
    test("hands note the one resolved cutoff; remember writes regardless of it (ticket 04)", async () => {
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

      // remember no longer branches on the era at all (ticket 04 lifted the
      // refusal), so a later call overwrites the note's title exactly as it
      // would on a legacy turn — the handler layer still hands it the
      // resolved cutoff, but handleTurnRemember no longer reads it.
      await handlers.remember!({
        id: `T${eraTurnId}`,
        grade: 4,
        title: "observer override",
        content: "Now lands.",
      });
      expect(getTurnById(db, eraTurnId)!.title).toBe("observer override");
      expect(getTurnById(db, eraTurnId)!.content).toBe("Now lands.");
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
