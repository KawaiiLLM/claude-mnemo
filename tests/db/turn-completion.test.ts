import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { createObservation, getObservation } from "../../src/db/observations";
import { getNoteDebt, reconcileNoteDebt } from "../../src/db/note-debt";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurnById, promoteTurnFromNote } from "../../src/db/turns";
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
  }): number {
    return db
      .query<{ id: number }, [number, number, string, string | null, number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, title, user_prompt,
           assistant_response, created_at_epoch
         ) VALUES (?, ?, ?, ?, 'prompt', 'response', ?) RETURNING id`,
      )
      .get(
        sessionId,
        options.promptNumber,
        options.status ?? "active",
        options.title ?? null,
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

  test("an era turn with a record settles extracted, one without settles skipped", () => {
    const noted = seedTurn({
      promptNumber: 1,
      createdAtEpoch: 3_000,
      status: "provisional",
      title: "the agent's own note",
    });
    const hole = seedTurn({ promptNumber: 2, createdAtEpoch: 3_100 });

    expect(settleCompletedTurn(db, noted, CUTOFF, 4_000)).toBe(true);
    expect(settleCompletedTurn(db, hole, CUTOFF, 4_000)).toBe(true);

    expect(getTurnById(db, noted)?.status).toBe("extracted");
    expect(getTurnById(db, hole)?.status).toBe("skipped");
  });

  test("a pre-era turn nobody will ever write settles failed, not skipped", () => {
    const legacy = seedTurn({ promptNumber: 1, createdAtEpoch: 1_000 });

    settleCompletedTurn(db, legacy, CUTOFF, 4_000);

    // The one definition, shared with the stranded repair's floor: pre-era the
    // extraction really did lose the only summary that turn would have had.
    expect(getTurnById(db, legacy)?.status).toBe("failed");
    expect(
      completionFloorStatus(
        { title: null, content: null, createdAtEpoch: 1_000 },
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

  test("the note-debt classification walk settles every turn it admits", () => {
    const first = seedTurn({ promptNumber: 1, createdAtEpoch: 3_000 });
    const second = seedTurn({ promptNumber: 2, createdAtEpoch: 3_100 });
    seedObservation(first, "Edit", { file_path: "/a.ts" });
    seedObservation(second, "Edit", { file_path: "/b.ts" });
    for (const turnId of [first, second]) {
      db.query(
        `INSERT INTO pending_queue (kind, target_id, session_db_id, enqueued_at_epoch)
         VALUES ('turn-stop', ?, ?, 10)`,
      ).run(turnId, sessionId);
    }

    const result = reconcileNoteDebt(db, {
      sessionId,
      nowEpoch: 4_000,
      completedTurnId: second,
      eraCutoffEpoch: CUTOFF,
    });

    expect(result.settled).toEqual([first, second]);
    expect(getTurnById(db, first)?.status).toBe("skipped");
    expect(getTurnById(db, second)?.status).toBe("skipped");
    // Settling is not paying: both still owe a note, which the relief valve may
    // still collect.
    expect(getNoteDebt(db, first)?.status).toBe("pending");
    expect(getNoteDebt(db, second)?.status).toBe("pending");
  });

  test("the walk stops at a turn with no completion evidence, and settles nothing past it", () => {
    const stranded = seedTurn({ promptNumber: 1, createdAtEpoch: 3_000 });
    const later = seedTurn({ promptNumber: 2, createdAtEpoch: 3_100 });
    seedObservation(later, "Edit", { file_path: "/b.ts" });
    db.query(
      `INSERT INTO pending_queue (kind, target_id, session_db_id, enqueued_at_epoch)
       VALUES ('turn-stop', ?, ?, 10)`,
    ).run(later, sessionId);

    // `stranded` has neither a terminal status nor a queued turn-stop, so the
    // contiguous prefix blocks on it. That is the ledger's existing contract and
    // the stranded repair is what ends the block; the point here is that the
    // settlement inherits it rather than skipping over a turn.
    const result = reconcileNoteDebt(db, {
      sessionId,
      nowEpoch: 4_000,
      eraCutoffEpoch: CUTOFF,
    });

    expect(result.settled).toEqual([]);
    expect(getTurnById(db, stranded)?.status).toBe("active");
    expect(getTurnById(db, later)?.status).toBe("active");
  });
});
