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

/**
 * Ticket 09 — the P2 cutover: for turns created at or after the cutoff the main
 * agent's `note` becomes the official turn record, and the extraction
 * subagent's writeback stops producing one. Everything created earlier keeps
 * the legacy arrangement, in the same session.
 */

const CUTOFF = 2_000;

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

    test("a rewrite that omits insight leaves it stored, both on the shadow row and its turns promotion", () => {
      // spec D5a: omission is never a claim — the second call never named
      // insight, so it is left alone rather than cleared, on both surfaces
      // the note promotes to.
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
          mode: { title: "write", content: "write" },
        },
        { ...options, now: () => 3_400 },
      );

      const turn = getTurnById(db, eraTurnId)!;
      expect(turn.title).toBe("second title");
      expect(turn.insight).toBe("first insight");
      expect(getShadowNote(db, eraTurnId)!.insight).toBe("first insight");
    });

    test("an explicit insight clear (null + overwrite mode) stores NULL, on both surfaces", () => {
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
          insight: null,
          mode: { title: "write", content: "write", insight: "write" },
        },
        { ...options, now: () => 3_400 },
      );

      const turn = getTurnById(db, eraTurnId)!;
      expect(turn.title).toBe("second title");
      expect(turn.insight).toBeNull();
      expect(getShadowNote(db, eraTurnId)!.insight).toBeNull();
    });

    // Was: "leaves a pre-cutoff turn's row byte-identical while the era is
    // on", which passed while the prose went to `shadow_notes` and the call
    // answered "Noted". Nothing reads that table — not recall, timeline,
    // search or the injected context — so the write produced a record no
    // reader would ever meet. A write whose result cannot be read is a
    // failure, and a failure has to be legible at the call (user ruling; the
    // same rule spec E2 already applies to content carrying tool-call syntax).
    test("refuses prose on a pre-cutoff turn rather than writing it where nothing reads", () => {
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

      expect(isNoteSuccess(result)).toBe(false);
      expect(result.content[0]?.text).toContain("pre-cutoff turn");
      // Nothing landed on either surface — not the turns row, not the shadow
      // row the refusal replaces.
      expect(snapshotTurnRow(db, legacyTurnId)).toBe(before);
      expect(getShadowNote(db, legacyTurnId)).toBeNull();
    });

    test("still takes a pre-cutoff turn's type and tags — the rule is about the destination, not the age", () => {
      const result = noteTool(
        db,
        {
          turn: `S${sessionId}/T10`,
          type: ["fix"],
          tags: ["era-cutover"],
        },
        { now: () => 3_300, env: {}, eraCutoffEpoch: CUTOFF },
      );

      expect(isNoteSuccess(result)).toBe(true);
      const turn = getTurnById(db, legacyTurnId)!;
      expect(turn.type).toEqual(["fix"]);
      expect(turn.tags).toEqual(["era-cutover"]);
    });

    test("the rollback still writes a shadow row, because that is what it is for", () => {
      // An absent cutoff means "every turn is legacy" (spec D11/D12). The
      // refusal must not fire there, or the safety valve becomes a system
      // that cannot write a note at all.
      const result = noteTool(
        db,
        {
          turn: `S${sessionId}/T10`,
          title: "implement+era-cutover: rollback shape",
          content: "Shadow-only is the intended record under a null cutoff.",
        },
        { now: () => 3_300, env: {}, eraCutoffEpoch: null },
      );

      expect(isNoteSuccess(result)).toBe(true);
      // Existence alone would pass on an empty or wrong-turn payload.
      const shadow = getShadowNote(db, legacyTurnId);
      expect(shadow?.title).toBe("implement+era-cutover: rollback shape");
      expect(shadow?.content).toBe(
        "Shadow-only is the intended record under a null cutoff.",
      );
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
          mode: { title: "write", content: "write", type: "write" },
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
          mode: { title: "write", content: "write" },
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
          mode: { title: "write", content: "write", type: "write" },
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
          mode: { title: "write", content: "write", tags: "write" },
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
          mode: { title: "write", content: "write" },
        },
        { ...options, now: () => 3_500 },
      );
      expect(getTurnById(db, eraTurnId)!.tags).toEqual([
        "login-flow",
        "oauth-redirect",
      ]);
    });
  });

  describe("type/tags write turns directly regardless of era; prose stays era-gated (ticket 03 merge)", () => {
    // ticket 03 merges `remember`'s turn route into `note`. Its old shape
    // wrote title/content/insight directly onto `turns` for EVERY turn,
    // bypassing note's shadow store and era gate entirely — a second,
    // unfenced writer of the exact fields note.ts already owned. The merge
    // closes that: every prose write goes through the ONE era-gated path
    // below, whichever address form named it. `type`/`tags` keep remember's
    // era-independent write (spec: settlement and the main agent both need
    // to correct a legacy turn's type/tags without a note ever promoting its
    // prose). `grade` used to share this era-independent write too, but
    // ticket 01 (ADR-0003) removed it from `note` entirely — settlement now
    // assigns it through its own facade (worker/note-settlement-turn-facade.ts),
    // which this suite does not exercise.
    test("a never-noted era turn (a hole) is fully writable through the merged tool, prose included", () => {
      const result = noteTool(
        db,
        {
          turn: `S${sessionId}/T11`,
          type: ["implement"],
          title: "observer's reconstruction",
          content: "Written from the transcript, not from the turn itself.",
          insight: "A late correction reaching the record.",
          tags: ["era-cutover"],
        },
        { eraCutoffEpoch: CUTOFF },
      );

      expect(isNoteSuccess(result)).toBe(true);

      const turn = getTurnById(db, eraTurnId)!;
      expect(turn.title).toBe("observer's reconstruction");
      expect(turn.content).toBe(
        "Written from the transcript, not from the turn itself.",
      );
      expect(turn.insight).toBe("A late correction reaching the record.");
      expect(turn.type).toEqual(["implement"]);
      expect(turn.tags).toEqual(["era-cutover"]);
      expect(turn.status).toBe("extracted");
    });

    test("a settled hole given only a type still leaves the stranded selection", () => {
      // The turn's own completion already took it out of the selection
      // (status 'skipped', not 'active'/'provisional'); a type-only write
      // must not put it back there.
      expect(getStrandedTurns(db, sessionId).map((t) => t.id)).not.toContain(
        eraTurnId,
      );

      noteTool(
        db,
        { turn: `S${sessionId}/T11`, type: ["fix"] },
        { eraCutoffEpoch: CUTOFF },
      );

      expect(getStrandedTurns(db, sessionId).map((t) => t.id)).not.toContain(
        eraTurnId,
      );
    });

    test("a type patches onto an era turn without restating the note the main agent already wrote", () => {
      noteTool(
        db,
        {
          turn: `S${sessionId}/T11`,
          title: "the agent's own note",
          content: "First-person record of this turn.",
        },
        { now: () => 3_300, env: {}, eraCutoffEpoch: CUTOFF },
      );

      // type-only: title/content are omitted, not restated, and need no mode.
      const result = noteTool(
        db,
        { turn: `S${sessionId}/T11`, type: ["fix"] },
        { eraCutoffEpoch: CUTOFF },
      );

      expect(isNoteSuccess(result)).toBe(true);
      const turn = getTurnById(db, eraTurnId)!;
      expect(turn.title).toBe("the agent's own note");
      expect(turn.content).toBe("First-person record of this turn.");
      expect(turn.type).toEqual(["fix"]);
      expect(turn.status).toBe("extracted");
    });

    test("a title+content call now resurrects a terminal era turn, matching legacy promotion", () => {
      // promoteTurnFromNote's own status derivation has no terminal floor
      // beyond `undone` — a late reconstruction of a 'failed' hole lands as
      // 'extracted', same as it always has for a legacy turn.
      db.query<unknown, [number]>(
        "UPDATE turns SET status = 'failed' WHERE id = ?",
      ).run(eraTurnId);

      const result = noteTool(
        db,
        {
          turn: `S${sessionId}/T11`,
          title: "late observer",
          content: "Reconstructed after the turn was settled as a hole.",
        },
        { eraCutoffEpoch: CUTOFF },
      );

      expect(isNoteSuccess(result)).toBe(true);
      const turn = getTurnById(db, eraTurnId)!;
      expect(turn.title).toBe("late observer");
      expect(turn.status).toBe("extracted");
    });

    test("an 'undone' sidechain row is protected on every address form now — the divergence the pre-merge remember had is closed", () => {
      // Before the merge, note.ts's promoteTurnFromNote floored an 'undone'
      // row's status (a sidechain prompt is not part of the session's arc,
      // so promoting it would put it back in view), but remember.ts's
      // era-independent write had no equivalent floor. Type/tags still write
      // directly (unconditioned on status, same as before the merge), but
      // with only one path left for prose, the floor now applies regardless
      // of which field a caller touches.
      db.query<unknown, [number]>(
        "UPDATE turns SET status = 'undone' WHERE id = ?",
      ).run(rideTurnId);

      const result = noteTool(
        db,
        { turn: `S${sessionId}/T12`, type: ["fix"] },
        { eraCutoffEpoch: CUTOFF },
      );

      expect(isNoteSuccess(result)).toBe(true);
      const turn = getTurnById(db, rideTurnId)!;
      expect(turn.type).toEqual(["fix"]);
      expect(turn.status).toBe("undone");
    });

    test("extracts a pre-cutoff turn's type/tags directly while its prose stays shadow-only", () => {
      const result = noteTool(
        db,
        {
          turn: `S${sessionId}/T10`,
          type: ["implement"],
          tags: ["legacy"],
        },
        { eraCutoffEpoch: CUTOFF },
      );

      expect(isNoteSuccess(result)).toBe(true);
      const turn = getTurnById(db, legacyTurnId)!;
      expect(turn.type).toEqual(["implement"]);
      expect(turn.tags).toEqual(["legacy"]);
      // P1 isolation is universal now: a legacy turn's official title/content
      // stay whatever the old extraction pipeline last left them (NULL in
      // this fixture), untouched by any address form.
      expect(turn.title).toBeNull();
      expect(turn.content).toBeNull();
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
      const shadow = getShadowNote(db, eraTurnId);
      expect(shadow?.title).toBe("implement+era-cutover: rollback");
      expect(shadow?.content).toBe("With no cutoff every turn is legacy.");
      expect(getNoteDebt(db, eraTurnId)?.status).toBe("noted");
    });

    test("type/tags still land under a null cutoff; prose stays shadow-only", () => {
      // Peer round P2-3: T11 is a settled HOLE (`status = 'skipped'`), and a
      // dormant turn takes no facet-only write any more — the late note is
      // what a hole waits for. The prose here is that note; what this test
      // pins is unchanged and now stated in one call: type/tags reach the
      // `turns` row under a null cutoff while the prose does not.
      const result = noteTool(
        db,
        {
          turn: `S${sessionId}/T11`,
          title: "implement+era-cutover: facets",
          content: "The late note that fills the hole.",
          type: ["implement"],
          tags: ["rollback"],
        },
        { eraCutoffEpoch: null },
      );

      expect(isNoteSuccess(result)).toBe(true);
      const turn = getTurnById(db, eraTurnId)!;
      expect(turn.type).toEqual(["implement"]);
      expect(turn.tags).toEqual(["rollback"]);
      // No cutoff means every turn is legacy — prose never reaches `turns`.
      expect(turn.title).toBeNull();
      expect(turn.content).toBeNull();
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
      const shadow = getShadowNote(db, eraTurnId);
      expect(shadow?.title).toBe("implement+era-cutover: default");
      expect(shadow?.content).toBe("No option supplied at all.");
    });
  });

  describe("handler wiring", () => {
    test("hands note the one resolved cutoff for prose promotion; type lands regardless of it", async () => {
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

      // A second, type-only call — the same resolved cutoff governs prose
      // promotion, but type is era-independent and needs no mode (empty).
      await handlers.note!({
        turn: `S${sessionId}/T11`,
        type: ["fix"],
      });
      expect(getTurnById(db, eraTurnId)!.type).toEqual(["fix"]);
      // The first call's title survives the type-only second call untouched.
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

      const result = await handlers.note!({
        turn: `S${sessionId}/T11`,
        title: "implement+era-cutover: inert",
        content: "Nothing reaches the turn row.",
      });

      // "Turns unchanged" alone does not distinguish the legacy path from an
      // erroneous REFUSAL, which leaves the row untouched too — and the
      // refusal firing under a null cutoff is the exact regression this
      // ticket already shipped once. So the write has to be shown to have
      // succeeded and landed somewhere.
      expect(result.content[0]!.text).not.toStartWith("Parameter error:");
      expect(snapshotTurnRow(db, eraTurnId)).toBe(before);
      const shadow = getShadowNote(db, eraTurnId);
      expect(shadow?.title).toBe("implement+era-cutover: inert");
      expect(shadow?.content).toBe("Nothing reaches the turn row.");
      expect(getNoteDebt(db, eraTurnId)?.status).toBe("noted");
    });
  });
});
