import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  claimNextItem,
  listQueueItems,
  resetClaimedQueueItems,
} from "../../src/db/pending-queue";
import { initializeSchema } from "../../src/db/schema";

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
