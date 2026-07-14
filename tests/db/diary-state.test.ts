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

  test("creates terminal scheduling state with a non-terminal default", () => {
    const columns = db
      .query<{ name: string; notnull: number; dfltValue: string | null }, []>(
        `SELECT name, "notnull", dflt_value AS dfltValue
         FROM pragma_table_info('diary_day_state')`,
      )
      .all();

    expect(columns).toContainEqual({
      name: "terminal",
      notnull: 1,
      dfltValue: "0",
    });

    const store = createDiaryStateStore(db);
    store.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 100 });
    expect(store.getDayState("2026-07-10")?.terminal).toBe(false);
  });

  test("adds terminal state to an existing diary table only once", () => {
    db.exec("DROP TABLE diary_day_state");
    db.exec(`
      CREATE TABLE diary_day_state (
        date TEXT PRIMARY KEY,
        watermark TEXT,
        settled_at_epoch INTEGER,
        needs_regen INTEGER NOT NULL DEFAULT 0,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_epoch INTEGER,
        last_error TEXT
      )
    `);

    initializeSchema(db);
    initializeSchema(db);

    const terminalColumns = db
      .query<{ name: string }, []>(
        `SELECT name
         FROM pragma_table_info('diary_day_state')
         WHERE name = 'terminal'`,
      )
      .all();
    expect(terminalColumns).toEqual([{ name: "terminal" }]);

    db.query("INSERT INTO diary_day_state (date) VALUES (?)").run("2026-07-09");
    expect(createDiaryStateStore(db).getDayState("2026-07-09")?.terminal).toBe(false);
  });

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
      terminal: false,
      lastError: null,
    });
  });

  test("caps auto-retry at one attempt, then trips terminal", () => {
    const store = createDiaryStateStore(db);
    store.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 100 });

    // First failure: one auto-retry remains, so the day stays claimable at its
    // scheduled retry epoch.
    const first = store.claimNextDiaryItem(200)!;
    store.recordDreamFailure({
      date: "2026-07-10",
      queueSeq: first.seq,
      error: "dream agent failed",
      retryAtEpoch: 300,
    });
    expect(store.getDayState("2026-07-10")).toMatchObject({
      needsRegen: true,
      attemptCount: 1,
      nextAttemptEpoch: 300,
      terminal: false,
    });
    expect(store.claimNextDiaryItem(299)).toBeNull();
    const second = store.claimNextDiaryItem(300)!;
    expect(second.targetId).toBe(20260710);

    // Second failure trips terminal: no more auto-retry, schedule dropped.
    store.recordDreamFailure({
      date: "2026-07-10",
      queueSeq: second.seq,
      error: "dream agent failed again",
      retryAtEpoch: 400,
    });
    expect(store.getDayState("2026-07-10")).toMatchObject({
      needsRegen: true,
      attemptCount: 2,
      nextAttemptEpoch: null,
      terminal: true,
      lastError: "dream agent failed again",
    });

    // A terminal day is excluded from every automatic path, even far ahead.
    expect(store.claimNextDiaryItem(10_000)).toBeNull();
    expect(store.hasReadyDiaryItem(10_000)).toBe(false);
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

  test("enqueues only the most recent due days and demotes older ones to terminal", () => {
    const store = createDiaryStateStore(db);
    // Due range is 07-06..07-10; only the most recent maxDays are enqueued.
    expect(store.reconcileBacklog({
      today: "2026-07-11",
      cutoverDate: "2026-06-27",
      lastSuccessfulDate: "2026-07-05",
      maxDays: 3,
      timeZone: "Asia/Shanghai",
      enqueuedAtEpoch: 500,
    })).toEqual(["2026-07-08", "2026-07-09", "2026-07-10"]);

    // Kept days are queued and non-terminal.
    expect(store.hasQueuedDay("2026-07-10")).toBe(true);
    expect(store.getDayState("2026-07-10")?.terminal).toBe(false);

    // Older due days are demoted to terminal (manual-only) and not queued.
    expect(store.getDayState("2026-07-06")?.terminal).toBe(true);
    expect(store.getDayState("2026-07-07")?.terminal).toBe(true);
    expect(store.hasQueuedDay("2026-07-06")).toBe(false);
  });

  test("demotes an explicitly stale earlier date to terminal and never resurrects it", () => {
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

    // The stale earlier date is older than the kept window, so it is demoted.
    expect(store.reconcileBacklog({
      today: "2026-07-11",
      cutoverDate: "2026-06-27",
      lastSuccessfulDate: "2026-07-05",
      maxDays: 3,
      timeZone: "Asia/Shanghai",
      enqueuedAtEpoch: 500,
    })).toEqual(["2026-07-08", "2026-07-09", "2026-07-10"]);
    expect(store.getDayState("2026-07-01")?.terminal).toBe(true);

    // A terminal day is not a candidate on the next reconcile.
    expect(store.reconcileBacklog({
      today: "2026-07-11",
      cutoverDate: "2026-06-27",
      lastSuccessfulDate: "2026-07-05",
      maxDays: 3,
      timeZone: "Asia/Shanghai",
      enqueuedAtEpoch: 600,
    })).toEqual(["2026-07-08", "2026-07-09", "2026-07-10"]);
  });

  test("does not reconcile an unsettled failure for the committed marker date", () => {
    const store = createDiaryStateStore(db);
    store.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 100 });
    const claimed = store.claimNextDiaryItem(100)!;
    store.recordDreamFailure({
      date: "2026-07-10",
      queueSeq: claimed.seq,
      error: "agent timed out after commit",
      retryAtEpoch: 200,
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
