import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { enqueueQueueItem, getPendingQueueCount, listPendingQueueItems } from "../../src/db/pending-queue";
import { createQueueRuntime } from "../../src/worker/queue";

describe("worker queue runtime", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("scanAndDrainQueue processes items in FIFO order", async () => {
    enqueueQueueItem(db, {
      kind: "obs",
      targetId: 10,
      sessionDbId: 1,
      enqueuedAtEpoch: 100,
    });
    enqueueQueueItem(db, {
      kind: "turn-stop",
      targetId: 20,
      sessionDbId: 1,
      enqueuedAtEpoch: 101,
    });

    const processed: string[] = [];
    const runtime = createQueueRuntime({
      db,
      now: () => 500,
      processObs: async (_sessionState, obsId) => {
        processed.push(`obs:${obsId}`);
      },
      processTurnStop: async (_sessionState, turnId) => {
        processed.push(`turn:${turnId}`);
      },
    });

    await runtime.scanAndDrainQueue();

    expect(processed).toEqual(["obs:10", "turn:20"]);
    expect(getPendingQueueCount(db)).toBe(0);
  });

  test("failed items are unclaimed and skipped for the rest of the current drain", async () => {
    enqueueQueueItem(db, {
      kind: "obs",
      targetId: 10,
      sessionDbId: 1,
      enqueuedAtEpoch: 100,
    });
    enqueueQueueItem(db, {
      kind: "turn-stop",
      targetId: 20,
      sessionDbId: 1,
      enqueuedAtEpoch: 101,
    });

    const processed: string[] = [];
    const runtime = createQueueRuntime({
      db,
      now: () => 500,
      processObs: async () => {
        throw new Error("boom");
      },
      processTurnStop: async (_sessionState, turnId) => {
        processed.push(`turn:${turnId}`);
      },
    });

    await runtime.scanAndDrainQueue();

    expect(processed).toEqual(["turn:20"]);
    expect(listPendingQueueItems(db)).toEqual([
      {
        seq: 1,
        kind: "obs",
        targetId: 10,
        sessionDbId: 1,
        claimedAtEpoch: null,
        enqueuedAtEpoch: 100,
      },
    ]);
  });

  test("global scans can exclude sessions while compact owns them", async () => {
    enqueueQueueItem(db, {
      kind: "obs",
      targetId: 10,
      sessionDbId: 1,
      enqueuedAtEpoch: 100,
    });
    enqueueQueueItem(db, {
      kind: "obs",
      targetId: 20,
      sessionDbId: 2,
      enqueuedAtEpoch: 101,
    });

    const processed: string[] = [];
    const runtime = createQueueRuntime({
      db,
      now: () => 500,
      processObs: async (_sessionState, obsId) => {
        processed.push(`obs:${obsId}`);
      },
      processTurnStop: async () => {},
    });

    runtime.compactingSessions.add(2);
    await runtime.scanAndDrainQueue();

    expect(processed).toEqual(["obs:10"]);
    expect(getPendingQueueCount(db, 2)).toBe(1);
  });

  test("drainSessionCompletely waits for pending work in one session", async () => {
    enqueueQueueItem(db, {
      kind: "obs",
      targetId: 10,
      sessionDbId: 7,
      enqueuedAtEpoch: 100,
    });
    enqueueQueueItem(db, {
      kind: "turn-stop",
      targetId: 20,
      sessionDbId: 7,
      enqueuedAtEpoch: 101,
    });

    const processed: string[] = [];
    const runtime = createQueueRuntime({
      db,
      now: () => 500,
      processObs: async (_sessionState, obsId) => {
        processed.push(`obs:${obsId}`);
      },
      processTurnStop: async (_sessionState, turnId) => {
        processed.push(`turn:${turnId}`);
      },
    });

    await runtime.drainSessionCompletely(7);

    expect(processed).toEqual(["obs:10", "turn:20"]);
    expect(getPendingQueueCount(db, 7)).toBe(0);
  });

  test("recoverFromCrash resets claimed rows", () => {
    enqueueQueueItem(db, {
      kind: "obs",
      targetId: 10,
      sessionDbId: 1,
      enqueuedAtEpoch: 100,
    });

    const runtime = createQueueRuntime({
      db,
      now: () => 500,
      processObs: async () => {},
      processTurnStop: async () => {},
    });

    runtime.claimNextItem();
    expect(listPendingQueueItems(db)[0]?.claimedAtEpoch).toBe(500);

    runtime.recoverFromCrash();
    expect(listPendingQueueItems(db)[0]?.claimedAtEpoch).toBeNull();
  });
});
