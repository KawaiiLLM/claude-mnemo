import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { createObservation, getObservation } from "../../src/db/observations";
import {
  claimNextItem,
  listQueueItems,
  resetClaimedQueueItems,
} from "../../src/db/pending-queue";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurnById } from "../../src/db/turns";
import { createWorkerCore } from "../../src/worker/server";

describe("pending queue helpers", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    db.query(
      `
        INSERT INTO pending_queue (kind, target_id, session_db_id, claimed_at_epoch, enqueued_at_epoch)
        VALUES
          ('obs', 1, 10, NULL, 1),
          ('turn-stop', 2, 10, NULL, 2),
          ('obs', 3, 11, NULL, 3)
      `,
    ).run();
  });

  afterEach(() => {
    db.close();
  });

  test("claims the earliest unclaimed item with optional filters", () => {
    const first = claimNextItem(db, 100);
    expect(first?.seq).toBe(1);
    expect(first?.claimedAtEpoch).toBe(100);

    const second = claimNextItem(db, 101, {
      sessionFilter: 10,
      skippedSeqs: new Set([2]),
    });
    expect(second).toBeNull();

    const third = claimNextItem(db, 102, {
      excludeSessions: new Set([10]),
    });
    expect(third?.seq).toBe(3);
  });

  test("resets claimed rows during crash recovery", () => {
    claimNextItem(db, 100);
    claimNextItem(db, 101);

    resetClaimedQueueItems(db);

    const rows = listQueueItems(db);
    expect(rows.map((row) => row.claimedAtEpoch)).toEqual([null, null, null]);
  });
});

describe("terminal-owner queue hygiene", () => {
  let db: Database;
  let sessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "queue-hygiene",
      project: "/proj",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => db.close());

  function seedObservation(status: string, promptNumber: number): number {
    const turnId = db.query<{ id: number }, [number, number, string]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response, created_at_epoch
       ) VALUES (?, ?, ?, 'prompt', 'response', 10)
       RETURNING id`,
    ).get(sessionId, promptNumber, status)!.id;
    const observationId = createObservation(db, {
      turnId,
      toolName: "Read",
      status: "pending",
      createdAtEpoch: 20,
    }).id;
    db.query(
      `INSERT INTO pending_queue (kind, target_id, session_db_id, enqueued_at_epoch)
       VALUES ('obs', ?, ?, 20)`,
    ).run(observationId, sessionId);
    return observationId;
  }

  function makeCore() {
    return createWorkerCore({ db, now: () => 100 });
  }

  for (const status of ["extracted", "skipped", "failed", "undone"] as const) {
    test(`retires an observation owned by a ${status} turn`, async () => {
      const observationId = seedObservation(status, 1);

      await makeCore().scanAndDrainQueue();

      expect(getObservation(db, observationId)?.status).toBe("skipped");
      expect(listQueueItems(db)).toEqual([]);
    });
  }

  test("retires an observation whose owning turn is missing", async () => {
    const observationId = seedObservation("active", 1);
    db.exec("PRAGMA foreign_keys = OFF");
    db.query("DELETE FROM turns").run();

    await makeCore().scanAndDrainQueue();

    expect(getObservation(db, observationId)?.status).toBe("skipped");
    expect(listQueueItems(db)).toEqual([]);
  });

  test("rolls back observation retirement if queue-row deletion fails", async () => {
    const observationId = seedObservation("extracted", 1);
    db.exec(`CREATE TRIGGER reject_queue_delete BEFORE DELETE ON pending_queue
      BEGIN SELECT RAISE(ABORT, 'delete rejected'); END`);

    // Retirement and deletion share one transaction, so a rejected delete must
    // leave the observation exactly as it was. The drain itself does not throw:
    // it releases the claim and moves on, which is what keeps one poisoned row
    // from wedging every other session's work.
    await makeCore().scanAndDrainQueue();

    expect(getObservation(db, observationId)?.status).toBe("pending");
    expect(listQueueItems(db)).toHaveLength(1);
  });

  test("settles a valid turn-stop after retiring terminal-owner pollution", async () => {
    seedObservation("extracted", 1);
    const liveTurnId = db.query<{ id: number }, [number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response, created_at_epoch
       ) VALUES (?, 2, 'active', 'live prompt', 'live response', 30)
       RETURNING id`,
    ).get(sessionId)!.id;
    db.query(
      `INSERT INTO pending_queue (kind, target_id, session_db_id, enqueued_at_epoch)
       VALUES ('turn-stop', ?, ?, 40)`,
    ).run(liveTurnId, sessionId);
    const core = makeCore();

    await core.scanAndDrainQueue();

    // No era configured, so an un-noted turn nobody will ever write is `failed`
    // (db/turn-completion.ts) — the same floor the stranded repair applies.
    expect(getTurnById(db, liveTurnId)?.status).toBe("failed");
    expect(listQueueItems(db)).toEqual([]);
  });
});
