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

// observation-queue-teardown: capture stopped writing `obs` rows, and
// `retireQueueItem` stopped special-casing them. What is left to cover is that
// a row from BEFORE that change — still sitting in a production `pending_queue`
// table — drains exactly once through the same unconditional delete every other
// kind uses, and is never re-enqueued.
describe("legacy obs row draining", () => {
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

  function seedLegacyObsRow(status: string, promptNumber: number): number {
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

  for (const status of ["active", "extracted", "skipped", "failed", "undone"] as const) {
    test(`drains a legacy obs row owned by a ${status} turn, and does not re-enqueue it`, async () => {
      const observationId = seedLegacyObsRow(status, 1);

      const core = makeCore();
      await core.scanAndDrainQueue();
      await core.scanAndDrainQueue();

      // The queue row is gone — that is the whole of what "drained" means now.
      // The observation's own `status` is untouched: nothing but a turn's own
      // completion (db/turn-completion.ts) retires it any more, and this row's
      // turn was set to its status directly, bypassing that path — exactly the
      // pre-upgrade shape a legacy row can be found in.
      expect(listQueueItems(db)).toEqual([]);
      expect(getObservation(db, observationId)?.status).toBe("pending");
    });
  }

  test("drains a legacy obs row whose owning turn is missing, without erroring", async () => {
    const observationId = seedLegacyObsRow("active", 1);
    db.exec("PRAGMA foreign_keys = OFF");
    db.query("DELETE FROM turns").run();

    await makeCore().scanAndDrainQueue();

    expect(listQueueItems(db)).toEqual([]);
    expect(getObservation(db, observationId)?.status).toBe("pending");
  });

  test("releases the claim and leaves the row queued when deletion fails", async () => {
    const observationId = seedLegacyObsRow("extracted", 1);
    db.exec(`CREATE TRIGGER reject_queue_delete BEFORE DELETE ON pending_queue
      BEGIN SELECT RAISE(ABORT, 'delete rejected'); END`);

    // The drain itself does not throw: it releases the claim and moves on,
    // which is what keeps one poisoned row from wedging every other session's
    // work. Generic to every queue kind, not obs-specific — exercised here
    // because a legacy obs row is exactly the kind of row that could still be
    // sitting in a production table when this runs.
    await makeCore().scanAndDrainQueue();

    expect(listQueueItems(db)).toHaveLength(1);
    expect(getObservation(db, observationId)?.status).toBe("pending");
  });

  test("drains a legacy obs row and still settles a valid turn-stop in the same pass", async () => {
    seedLegacyObsRow("extracted", 1);
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
