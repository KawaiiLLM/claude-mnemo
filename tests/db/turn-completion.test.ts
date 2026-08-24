import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { createObservation, getObservation } from "../../src/db/observations";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import {
  getStrandedTurns,
  getTurnById,
  promoteTurnFromNote,
} from "../../src/db/turns";
import { isLiveTurn } from "../../src/db/turn-liveness";
import {
  listOwedNoteTurns,
  listOwedNoteTurnsInRange,
} from "../../src/db/note-debt";
import {
  aggregateTurnFiles,
  completionFloorStatus,
  settleCompletedTurn,
} from "../../src/db/turn-completion";

/**
 * Ticket 15: with the extraction subagent gone, a turn's own completion is what
 * carries it to a terminal status. Everything here is arithmetic over rows the
 * capture path already wrote — there is no queue, no retry and no model in it.
 */

const CUTOFF = 2_000;

describe("mechanical turn completion", () => {
  let db: Database;
  let sessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "completion-session",
      project: "/proj",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => db.close());

  function seedTurn(options: {
    promptNumber: number;
    createdAtEpoch: number;
    status?: string;
    title?: string | null;
    /** Defaults to a real response; pass `null`/whitespace for the no-record cases. */
    assistantResponse?: string | null;
  }): number {
    return db
      .query<
        { id: number },
        [number, number, string, string | null, string | null, number]
      >(
        `INSERT INTO turns (
           session_id, prompt_number, status, title, user_prompt,
           assistant_response, created_at_epoch
         ) VALUES (?, ?, ?, ?, 'prompt', ?, ?) RETURNING id`,
      )
      .get(
        sessionId,
        options.promptNumber,
        options.status ?? "active",
        options.title ?? null,
        options.assistantResponse === undefined ? "response" : options.assistantResponse,
        options.createdAtEpoch,
      )!.id;
  }

  function seedObservation(
    turnId: number,
    toolName: string,
    toolInput: Record<string, unknown>,
    excluded = false,
  ): number {
    return createObservation(db, {
      turnId,
      toolName,
      toolInput: JSON.stringify(toolInput),
      status: "pending",
      excludedFromExtraction: excluded,
      createdAtEpoch: 10,
    }).id;
  }

  test("an era turn with a record settles extracted, a true hole settles skipped", () => {
    const noted = seedTurn({
      promptNumber: 1,
      createdAtEpoch: 3_000,
      status: "provisional",
      title: "the agent's own note",
    });
    // A true hole (issue 01): no title/content AND no actual response — the
    // no-reply-slash-command / empty-notification shape.
    const hole = seedTurn({
      promptNumber: 2,
      createdAtEpoch: 3_100,
      assistantResponse: null,
    });

    expect(settleCompletedTurn(db, noted, CUTOFF, 4_000)).toBe(true);
    expect(settleCompletedTurn(db, hole, CUTOFF, 4_000)).toBe(true);

    expect(getTurnById(db, noted)?.status).toBe("extracted");
    expect(getTurnById(db, hole)?.status).toBe("skipped");
  });

  test("an unnoted turn with a real response settles extracted, not skipped", () => {
    // The user ruling (S15069/T1477): don't auto-skip a turn carrying an
    // actual response. It lands in the already-recognized noteless-extracted
    // shape (`getStrandedTurns`'s second branch), not a new status.
    const responded = seedTurn({
      promptNumber: 1,
      createdAtEpoch: 3_000,
      assistantResponse: "the model actually answered",
    });

    expect(settleCompletedTurn(db, responded, CUTOFF, 4_000)).toBe(true);

    const turn = getTurnById(db, responded)!;
    expect(turn.status).toBe("extracted");
    expect(turn.title).toBeNull();
    expect(turn.content).toBeNull();
  });

  test("a no-reply slash command turn and an empty notification turn both still settle skipped", () => {
    // No-reply slash command: the harness answers locally, so Stop never
    // writes a response at all — assistant_response stays NULL.
    const noReplyCommand = seedTurn({
      promptNumber: 1,
      createdAtEpoch: 3_000,
      assistantResponse: null,
    });
    // Empty notification spin: the harness writes a blank/whitespace string
    // rather than omitting the column.
    const emptyNotification = seedTurn({
      promptNumber: 2,
      createdAtEpoch: 3_100,
      assistantResponse: "   \n\t  ",
    });

    settleCompletedTurn(db, noReplyCommand, CUTOFF, 4_000);
    settleCompletedTurn(db, emptyNotification, CUTOFF, 4_000);

    expect(getTurnById(db, noReplyCommand)?.status).toBe("skipped");
    expect(getTurnById(db, emptyNotification)?.status).toBe("skipped");
  });

  test("a floored-extracted noteless turn is live, stranded, and still owed a note", () => {
    const responded = seedTurn({
      promptNumber: 1,
      createdAtEpoch: 3_000,
      assistantResponse: "the model actually answered",
    });

    settleCompletedTurn(db, responded, CUTOFF, 4_000);
    const turn = getTurnById(db, responded)!;
    expect(turn.status).toBe("extracted");

    // `isLiveTurn` is a denylist (wasRolledBack / status='skipped'); neither
    // applies to a noteless-extracted turn.
    expect(
      isLiveTurn({ wasRolledBack: turn.wasRolledBack, status: turn.status }),
    ).toBe(true);

    // `getStrandedTurns`'s second branch: extracted AND title/content both
    // NULL is exactly the shape this floor now produces.
    expect(getStrandedTurns(db, sessionId).map((t) => t.id)).toContain(
      responded,
    );

    // Neither note-debt predicate ever read `turns.status`, so the floor
    // change alone keeps the turn owed without any predicate edit.
    expect(
      listOwedNoteTurns(db, sessionId, 2).map((t) => t.turnId),
    ).toContain(responded);
    expect(
      listOwedNoteTurnsInRange(db, sessionId, 1, 1).map((t) => t.turnId),
    ).toContain(responded);
  });

  test("a late note on a floored-extracted turn lands as a plain write", () => {
    const responded = seedTurn({
      promptNumber: 1,
      createdAtEpoch: 3_000,
      assistantResponse: "the model actually answered",
    });
    settleCompletedTurn(db, responded, CUTOFF, 4_000);
    expect(getTurnById(db, responded)?.status).toBe("extracted");

    // `promoteTurnFromNote`'s "already finished" branch writes `extracted`
    // unconditionally — extracted -> extracted here needs no special casing
    // for the noteless-extracted shape.
    const promoted = promoteTurnFromNote(db, responded, {
      title: "late note",
      content: "written after the noteless floor",
      insight: null,
      updatedAtEpoch: 5_000,
    });

    expect(promoted?.status).toBe("extracted");
    expect(promoted?.title).toBe("late note");
    expect(promoted?.content).toBe("written after the noteless floor");
  });

  test("a pre-era turn nobody will ever write settles failed, not skipped", () => {
    // seedTurn's default assistantResponse is a real, non-empty string — this
    // also proves the era gate outranks the response test: pre-era stays
    // `failed` even though the turn carries an actual response.
    const legacy = seedTurn({ promptNumber: 1, createdAtEpoch: 1_000 });

    settleCompletedTurn(db, legacy, CUTOFF, 4_000);

    // The one definition, shared with the stranded repair's floor: pre-era the
    // extraction really did lose the only summary that turn would have had.
    expect(getTurnById(db, legacy)?.status).toBe("failed");
    expect(
      completionFloorStatus(
        {
          title: null,
          content: null,
          createdAtEpoch: 1_000,
          assistantResponse: "an actual response, ignored pre-era",
        },
        CUTOFF,
      ),
    ).toBe("failed");
  });

  test("retires the turn's pending observations and persists its file aggregate", () => {
    const turnId = seedTurn({ promptNumber: 1, createdAtEpoch: 3_000 });
    const read = seedObservation(turnId, "Read", { file_path: "/a.ts" });
    const edit = seedObservation(turnId, "Edit", { file_path: "/b.ts" });
    // A `note` call is bookkeeping ABOUT the turn, so it must not inflate the
    // count the segment ranking reads as evidence of work.
    seedObservation(turnId, "mcp__mnemo__note", {}, true);

    settleCompletedTurn(db, turnId, CUTOFF, 4_000);

    const turn = getTurnById(db, turnId)!;
    expect(turn.filesRead).toEqual(["/a.ts"]);
    expect(turn.filesModified).toEqual(["/b.ts"]);
    expect(turn.toolCallCount).toBe(2);
    expect(getObservation(db, read)?.status).toBe("skipped");
    expect(getObservation(db, edit)?.status).toBe("skipped");
    expect(aggregateTurnFiles(db, turnId).toolCallCount).toBe(2);
  });

  test("is idempotent, and a late note still promotes an already-settled row", () => {
    const turnId = seedTurn({ promptNumber: 1, createdAtEpoch: 3_000 });

    expect(settleCompletedTurn(db, turnId, CUTOFF, 4_000)).toBe(true);
    expect(settleCompletedTurn(db, turnId, CUTOFF, 5_000)).toBe(false);
    expect(getTurnById(db, turnId)?.updatedAtEpoch).toBe(4_000);

    // The backlog relief's case (裁决 21): the answer arrives turns later, and
    // a row holding a record is `extracted` whatever it was settled as.
    promoteTurnFromNote(db, turnId, {
      title: "late note",
      content: "written after the hole was settled",
      insight: null,
      updatedAtEpoch: 6_000,
    });
    expect(getTurnById(db, turnId)?.status).toBe("extracted");

    // And a re-settle after that does not demote it.
    expect(settleCompletedTurn(db, turnId, CUTOFF, 7_000)).toBe(false);
    expect(getTurnById(db, turnId)?.status).toBe("extracted");
  });

  test("leaves an undone sidechain row alone", () => {
    const turnId = seedTurn({
      promptNumber: 1,
      createdAtEpoch: 3_000,
      status: "undone",
    });

    expect(settleCompletedTurn(db, turnId, CUTOFF, 4_000)).toBe(false);
    expect(getTurnById(db, turnId)?.status).toBe("undone");
  });

  // The integration between this walk and the note-debt ledger's own
  // classification (which turn ids get settled from a session, and which are
  // left stranded) moved to db/turn-settlement.ts along with the write itself
  // (ticket 02, spec D10) — see tests/db/turn-settlement.test.ts. Nothing in
  // this file drives `settleCompletedTurn` through `reconcileNoteDebt` any
  // more, because nothing in the source does either.
});
