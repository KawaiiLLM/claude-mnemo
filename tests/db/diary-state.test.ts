import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  createDiaryStateStore,
  markSettledDiaryDayStaleForTurn,
} from "../../src/db/diary-state";
import { initializeSchema } from "../../src/db/schema";

describe("DiaryStateStore dream queue", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => db.close());

  test("deduplicates a date and claims it once", () => {
    const store = createDiaryStateStore(db);
    store.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 100 });
    store.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 101 });

    expect(store.claimNextDiaryItem(200)).toEqual({
      seq: 1,
      kind: "diary",
      targetId: 20260710,
      sessionDbId: 0,
      claimedAtEpoch: 200,
      enqueuedAtEpoch: 100,
    });
    expect(store.claimNextDiaryItem(200)).toBeNull();
  });

  test("persists only dream scheduling state", () => {
    const store = createDiaryStateStore(db);
    store.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 100 });
    expect(store.getDayState("2026-07-10")).toEqual({
      date: "2026-07-10",
      watermark: null,
      settledAtEpoch: null,
      needsRegen: false,
      attemptCount: 0,
      nextAttemptEpoch: null,
      lastError: null,
    });
  });

  test("keeps failures durable and retryable past three attempts", () => {
    const store = createDiaryStateStore(db);
    store.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 100 });
    for (const [claimAt, retryAt] of [[200, 300], [300, 400], [400, 500]] as const) {
      const claimed = store.claimNextDiaryItem(claimAt)!;
      store.recordDreamFailure({
        date: "2026-07-10",
        queueSeq: claimed.seq,
        error: "dream agent failed",
        nextAttemptEpoch: retryAt,
      });
    }
    expect(store.getDayState("2026-07-10")).toMatchObject({
      needsRegen: true,
      attemptCount: 3,
      nextAttemptEpoch: 500,
    });
    expect(store.claimNextDiaryItem(499)).toBeNull();
    expect(store.claimNextDiaryItem(500)?.targetId).toBe(20260710);
  });

  test("settles a dream date and acknowledges its queue item", () => {
    const store = createDiaryStateStore(db);
    store.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 100 });
    const claimed = store.claimNextDiaryItem(200)!;
    store.settleDreamDay({
      date: "2026-07-10",
      queueSeq: claimed.seq,
      watermark: "dream-watermark",
      settledAtEpoch: 250,
    });
    expect(store.getDayState("2026-07-10")).toMatchObject({
      watermark: "dream-watermark",
      settledAtEpoch: 250,
      needsRegen: false,
    });
    expect(store.hasQueuedDay("2026-07-10")).toBe(false);
  });

  test("reconciles quiet dates from the marker and caps each trigger", () => {
    const store = createDiaryStateStore(db);
    expect(store.reconcileBacklog({
      today: "2026-07-11",
      cutoverDate: "2026-06-27",
      lastSuccessfulDate: "2026-07-05",
      maxDays: 3,
      timeZone: "Asia/Shanghai",
      enqueuedAtEpoch: 500,
    })).toEqual(["2026-07-06", "2026-07-07", "2026-07-08"]);
  });

  test("retains an explicitly stale earlier date within the cap", () => {
    const store = createDiaryStateStore(db);
    store.enqueueDay({ date: "2026-07-01", enqueuedAtEpoch: 100 });
    const claimed = store.claimNextDiaryItem(100)!;
    store.settleDreamDay({
      date: "2026-07-01",
      queueSeq: claimed.seq,
      watermark: "old",
      settledAtEpoch: 200,
    });
    store.markDayStale("2026-07-01");
    expect(store.reconcileBacklog({
      today: "2026-07-11",
      cutoverDate: "2026-06-27",
      lastSuccessfulDate: "2026-07-05",
      maxDays: 3,
      timeZone: "Asia/Shanghai",
      enqueuedAtEpoch: 500,
    })).toEqual(["2026-07-01", "2026-07-06", "2026-07-07"]);
  });

  test("does not reconcile an unsettled failure for the committed marker date", () => {
    const store = createDiaryStateStore(db);
    store.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 100 });
    const claimed = store.claimNextDiaryItem(100)!;
    store.recordDreamFailure({
      date: "2026-07-10",
      queueSeq: claimed.seq,
      error: "agent timed out after commit",
      nextAttemptEpoch: 200,
    });

    expect(store.reconcileBacklog({
      today: "2026-07-11",
      cutoverDate: "2026-06-27",
      lastSuccessfulDate: "2026-07-10",
      maxDays: 7,
      timeZone: "Asia/Shanghai",
      enqueuedAtEpoch: 300,
    })).toEqual([]);
  });

  test("uses the configured timezone for late-turn invalidation", () => {
    const store = createDiaryStateStore(db);
    store.initializeBootstrap("2026-11-02");
    store.reconcileBacklog({
      today: "2026-11-02",
      cutoverDate: "2026-10-20",
      lastSuccessfulDate: "2026-11-01",
      maxDays: 7,
      timeZone: "America/New_York",
      enqueuedAtEpoch: 100,
    });
    store.enqueueDay({ date: "2026-11-01", enqueuedAtEpoch: 100 });
    const claimed = store.claimNextDiaryItem(100)!;
    store.settleDreamDay({
      date: "2026-11-01",
      queueSeq: claimed.seq,
      watermark: "before-late-turn",
      settledAtEpoch: 200,
    });

    markSettledDiaryDayStaleForTurn(
      db,
      Date.parse("2026-11-02T04:30:00Z") / 1_000,
    );
    expect(store.getDayState("2026-11-01")?.needsRegen).toBe(true);
  });

  test("initializes the fourteen-day cutover once", () => {
    const store = createDiaryStateStore(db);
    expect(store.initializeBootstrap("2026-07-11")).toEqual({
      cutoverDate: "2026-06-27",
    });
    expect(store.initializeBootstrap("2026-07-20")).toEqual({
      cutoverDate: "2026-06-27",
    });
  });
});
