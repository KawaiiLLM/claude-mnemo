import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import {
  claimNextQueueItem,
  deleteQueueItem,
  enqueueQueueItem,
  getPendingQueueCount,
  listPendingQueueItems,
  queueItemExistsForTurn,
  resetClaimedQueueItems,
  resetQueueItemClaim,
} from "../../src/db/pending-queue";

describe("pending_queue helpers", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("claims the earliest unclaimed item in FIFO order", () => {
    const first = enqueueQueueItem(db, {
      kind: "obs",
      targetId: 11,
      sessionDbId: 1,
      enqueuedAtEpoch: 100,
    });
    const second = enqueueQueueItem(db, {
      kind: "turn-stop",
      targetId: 22,
      sessionDbId: 1,
      enqueuedAtEpoch: 101,
    });

    const claimed = claimNextQueueItem(db, 500);

    expect(claimed).toEqual({
      seq: first.seq,
      kind: "obs",
      targetId: 11,
      sessionDbId: 1,
      claimedAtEpoch: 500,
      enqueuedAtEpoch: 100,
    });
    expect(listPendingQueueItems(db).map((item) => item.seq)).toEqual([
      first.seq,
      second.seq,
    ]);
  });

  test("supports session filtering and session exclusion while claiming", () => {
    const sessionOne = enqueueQueueItem(db, {
      kind: "obs",
      targetId: 1,
      sessionDbId: 10,
      enqueuedAtEpoch: 100,
    });
    const sessionTwo = enqueueQueueItem(db, {
      kind: "turn-stop",
      targetId: 2,
      sessionDbId: 20,
      enqueuedAtEpoch: 101,
    });

    const filtered = claimNextQueueItem(db, 200, { sessionFilter: 20 });
    const excluded = claimNextQueueItem(db, 201, {
      excludeSessions: new Set([20]),
    });

    expect(filtered?.seq).toBe(sessionTwo.seq);
    expect(excluded?.seq).toBe(sessionOne.seq);
  });

  test("can skip already-failed queue items within a drain pass", () => {
    const first = enqueueQueueItem(db, {
      kind: "obs",
      targetId: 1,
      sessionDbId: 1,
      enqueuedAtEpoch: 100,
    });
    const second = enqueueQueueItem(db, {
      kind: "obs",
      targetId: 2,
      sessionDbId: 1,
      enqueuedAtEpoch: 101,
    });

    const claimed = claimNextQueueItem(db, 300, {
      skippedSeqs: new Set([first.seq]),
    });

    expect(claimed?.seq).toBe(second.seq);
  });

  test("resets claimed items and deletes finished work", () => {
    const first = enqueueQueueItem(db, {
      kind: "obs",
      targetId: 1,
      sessionDbId: 1,
      enqueuedAtEpoch: 100,
    });
    const second = enqueueQueueItem(db, {
      kind: "turn-stop",
      targetId: 2,
      sessionDbId: 1,
      enqueuedAtEpoch: 101,
    });

    claimNextQueueItem(db, 400, { sessionFilter: 1 });
    claimNextQueueItem(db, 401, { sessionFilter: 1 });
    expect(getPendingQueueCount(db, 1)).toBe(2);

    resetQueueItemClaim(db, second.seq);
    let rows = listPendingQueueItems(db);
    expect(rows.find((row) => row.seq === second.seq)?.claimedAtEpoch).toBeNull();

    resetClaimedQueueItems(db);
    rows = listPendingQueueItems(db);
    expect(rows.every((row) => row.claimedAtEpoch === null)).toBe(true);

    deleteQueueItem(db, first.seq);
    expect(getPendingQueueCount(db, 1)).toBe(1);
  });

  test("queueItemExistsForTurn detects an existing item of a kind for a target", () => {
    enqueueQueueItem(db, { kind: "turn-stop", targetId: 42, sessionDbId: 1, enqueuedAtEpoch: 1 });

    expect(queueItemExistsForTurn(db, "turn-stop", 42)).toBe(true);
    expect(queueItemExistsForTurn(db, "turn-stop", 99)).toBe(false);
    expect(queueItemExistsForTurn(db, "obs", 42)).toBe(false);
  });
});
