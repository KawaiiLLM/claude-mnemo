import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  createDiaryStateStore,
  DREAM_MAX_AUTO_ATTEMPTS,
  markSettledDiaryDayStaleForTurn,
} from "../../src/db/diary-state";
import { initializeSchema } from "../../src/db/schema";
import { DREAM_RETRY_BACKOFF_MS } from "../../src/shared/config";

const CONTENT_DAY = "2026-07-10";
// Asia/Shanghai content-day 2026-07-10 with a 04:00 boundary is exactly
// [2026-07-09T20:00:00Z, 2026-07-10T20:00:00Z).
const CONTENT_DAY_START_EPOCH = Date.parse("2026-07-09T20:00:00Z") / 1_000;
const CONTENT_DAY_END_EPOCH = Date.parse("2026-07-10T20:00:00Z") / 1_000;
const READY_EPOCH = CONTENT_DAY_END_EPOCH + 86_400;

function configureContentDayBoundary(db: Database): void {
  db.query(
    `INSERT INTO diary_state (key, value)
     VALUES ('dream_timezone', 'Asia/Shanghai'), ('dream_hour', '4')`,
  ).run();
}

function insertTurn(
  db: Database,
  promptNumber: number,
  status: string,
  createdAtEpoch: number,
): void {
  const session = db.query<{ id: number }, []>(
    `INSERT INTO sessions (
       content_session_id, project, created_at_epoch
     ) VALUES ('diary-completeness', '/projects/diary', 1)
     ON CONFLICT(content_session_id) DO UPDATE SET
       project = excluded.project
     RETURNING id`,
  ).get();
  if (!session) throw new Error("Failed to create diary completeness session");
  db.query(
    `INSERT INTO turns (
       session_id, prompt_number, status, created_at_epoch
     ) VALUES (?, ?, ?, ?)`,
  ).run(session.id, promptNumber, status, createdAtEpoch);
}

describe("DiaryStateStore dream queue", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => db.close());

  test("creates retry disposition state with a null default", () => {
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
    expect(columns).toContainEqual({
      name: "retry_disposition",
      notnull: 0,
      dfltValue: null,
    });

    const store = createDiaryStateStore(db);
    store.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 100 });
    expect(store.getDayState("2026-07-10")).toMatchObject({
      terminal: false,
      retryDisposition: null,
    });
  });

  test("adds retry disposition once and backfills existing terminal rows", () => {
    db.exec("DROP TABLE diary_day_state");
    db.exec(`
      CREATE TABLE diary_day_state (
        date TEXT PRIMARY KEY,
        watermark TEXT,
        settled_at_epoch INTEGER,
        needs_regen INTEGER NOT NULL DEFAULT 0,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_epoch INTEGER,
        terminal INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      )
    `);
    db.query(
      "INSERT INTO diary_day_state (date, terminal) VALUES (?, ?), (?, ?)",
    ).run("2026-07-08", 1, "2026-07-09", 0);

    initializeSchema(db);
    initializeSchema(db);

    const dispositionColumns = db
      .query<{ name: string }, []>(
        `SELECT name
         FROM pragma_table_info('diary_day_state')
         WHERE name = 'retry_disposition'`,
      )
      .all();
    expect(dispositionColumns).toEqual([{ name: "retry_disposition" }]);

    const store = createDiaryStateStore(db);
    expect(store.getDayState("2026-07-08")?.retryDisposition).toBe("permanent");
    expect(store.getDayState("2026-07-09")?.retryDisposition).toBeNull();
  });

  test("deduplicates a date and claims it once", () => {
    const store = createDiaryStateStore(db);
    store.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 100 });
    store.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 101 });

    expect(store.claimNextDiaryItem(READY_EPOCH)).toEqual({
      seq: 1,
      kind: "diary",
      targetId: 20260710,
      sessionDbId: 0,
      claimedAtEpoch: READY_EPOCH,
      enqueuedAtEpoch: 100,
    });
    expect(store.claimNextDiaryItem(READY_EPOCH)).toBeNull();
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
      retryDisposition: null,
      lastError: null,
    });
  });

  test("withholds a diary day until its content-day boundary has ended", () => {
    configureContentDayBoundary(db);
    const store = createDiaryStateStore(db);
    store.enqueueDay({ date: CONTENT_DAY, enqueuedAtEpoch: 100 });

    expect(store.hasReadyDiaryItem(CONTENT_DAY_END_EPOCH - 1)).toBe(false);
    expect(store.claimNextDiaryItem(CONTENT_DAY_END_EPOCH - 1)).toBeNull();
    expect(store.hasReadyDiaryItem(CONTENT_DAY_END_EPOCH)).toBe(true);
  });

  test.each(["active", "provisional"])(
    "withholds an ended content-day while a %s turn is non-finalized",
    (status) => {
      configureContentDayBoundary(db);
      const store = createDiaryStateStore(db);
      store.enqueueDay({ date: CONTENT_DAY, enqueuedAtEpoch: 100 });
      insertTurn(db, 1, status, CONTENT_DAY_START_EPOCH);

      expect(store.hasReadyDiaryItem(CONTENT_DAY_END_EPOCH)).toBe(false);
      expect(store.claimNextDiaryItem(CONTENT_DAY_END_EPOCH)).toBeNull();
    },
  );

  test("claims an ended content-day once all of its turns are finalized", () => {
    configureContentDayBoundary(db);
    const store = createDiaryStateStore(db);
    store.enqueueDay({ date: CONTENT_DAY, enqueuedAtEpoch: 100 });
    insertTurn(db, 1, "active", CONTENT_DAY_END_EPOCH - 1);

    expect(store.claimNextDiaryItem(CONTENT_DAY_END_EPOCH)).toBeNull();
    db.query("UPDATE turns SET status = 'extracted'").run();

    expect(store.hasReadyDiaryItem(CONTENT_DAY_END_EPOCH)).toBe(true);
    expect(store.claimNextDiaryItem(CONTENT_DAY_END_EPOCH)?.targetId).toBe(
      20260710,
    );
  });

  test("does not block an ended day on extracted, skipped, or next-day turns", () => {
    configureContentDayBoundary(db);
    const store = createDiaryStateStore(db);
    store.enqueueDay({ date: CONTENT_DAY, enqueuedAtEpoch: 100 });
    insertTurn(db, 1, "extracted", CONTENT_DAY_START_EPOCH);
    insertTurn(db, 2, "skipped", CONTENT_DAY_END_EPOCH - 1);
    // The upper bound is exclusive: this active turn belongs to the next
    // content-day and must not block 2026-07-10.
    insertTurn(db, 3, "active", CONTENT_DAY_END_EPOCH);

    expect(store.hasReadyDiaryItem(CONTENT_DAY_END_EPOCH)).toBe(true);
    expect(store.claimNextDiaryItem(CONTENT_DAY_END_EPOCH)?.targetId).toBe(
      20260710,
    );
  });

  test("counts transient failures under one cap and honors the minimal backoff floor", () => {
    const store = createDiaryStateStore(db);
    store.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 100 });
    const backoffSec = Math.ceil(DREAM_RETRY_BACKOFF_MS / 1_000);

    for (let attempt = 1; attempt <= DREAM_MAX_AUTO_ATTEMPTS; attempt += 1) {
      const failedAtEpoch = READY_EPOCH + attempt * 100;
      const item = store.claimNextDiaryItem(failedAtEpoch)!;
      store.recordDreamFailure({
        date: "2026-07-10",
        queueSeq: item.seq,
        error: `connection failure ${attempt}`,
        failedAtEpoch,
        outcome: "transient",
      });
      expect(store.getDayState("2026-07-10")).toMatchObject({
        attemptCount: attempt,
        nextAttemptEpoch:
          attempt === DREAM_MAX_AUTO_ATTEMPTS
            ? null
            : failedAtEpoch + backoffSec,
        terminal: attempt === DREAM_MAX_AUTO_ATTEMPTS,
        retryDisposition: "transient",
      });
      if (attempt < DREAM_MAX_AUTO_ATTEMPTS) {
        expect(store.hasReadyDiaryItem(failedAtEpoch + backoffSec - 1)).toBe(false);
        expect(store.hasReadyDiaryItem(failedAtEpoch + backoffSec)).toBe(true);
      }
    }

    expect(store.getDayState("2026-07-10")).toMatchObject({
      needsRegen: true,
      attemptCount: DREAM_MAX_AUTO_ATTEMPTS,
      nextAttemptEpoch: null,
      terminal: true,
      retryDisposition: "transient",
      lastError: `connection failure ${DREAM_MAX_AUTO_ATTEMPTS}`,
    });
    expect(store.claimNextDiaryItem(10_000)).toBeNull();
    expect(store.hasReadyDiaryItem(10_000)).toBe(false);
  });

  test("keeps a permanent disposition sticky across later transient attempts", () => {
    const store = createDiaryStateStore(db);
    store.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 100 });

    for (const [index, outcome] of [
      "permanent",
      "transient",
      "transient",
    ].entries()) {
      const failedAtEpoch = READY_EPOCH + 100 + index * 20;
      const item = store.claimNextDiaryItem(failedAtEpoch)!;
      store.recordDreamFailure({
        date: "2026-07-10",
        queueSeq: item.seq,
        error: `${outcome} failure`,
        failedAtEpoch,
        outcome: outcome as "permanent" | "transient",
      });
    }

    expect(store.getDayState("2026-07-10")).toMatchObject({
      attemptCount: 3,
      terminal: true,
      retryDisposition: "permanent",
    });
  });

  test("counts mixed transient and permanent failures toward the same cap", () => {
    const store = createDiaryStateStore(db);
    store.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 100 });

    for (const [index, outcome] of [
      "transient",
      "transient",
      "permanent",
    ].entries()) {
      const failedAtEpoch = READY_EPOCH + 100 + index * 20;
      const item = store.claimNextDiaryItem(failedAtEpoch)!;
      store.recordDreamFailure({
        date: "2026-07-10",
        queueSeq: item.seq,
        error: `${outcome} failure`,
        failedAtEpoch,
        outcome: outcome as "permanent" | "transient",
      });
    }

    expect(store.getDayState("2026-07-10")).toMatchObject({
      attemptCount: DREAM_MAX_AUTO_ATTEMPTS,
      terminal: true,
      retryDisposition: "permanent",
    });
  });

  test("repeated shutdowns re-enqueue without consuming attempts", () => {
    const store = createDiaryStateStore(db);
    store.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 100 });

    for (let shutdown = 0; shutdown < DREAM_MAX_AUTO_ATTEMPTS + 2; shutdown += 1) {
      const failedAtEpoch = READY_EPOCH + 100 + shutdown;
      const item = store.claimNextDiaryItem(failedAtEpoch)!;
      store.recordDreamFailure({
        date: "2026-07-10",
        queueSeq: item.seq,
        error: "worker shutdown",
        failedAtEpoch,
        outcome: "shutdown",
      });
      expect(store.getDayState("2026-07-10")).toMatchObject({
        attemptCount: 0,
        nextAttemptEpoch: failedAtEpoch,
        terminal: false,
        retryDisposition: null,
        lastError: null,
      });
    }
  });

  test("clears disposition when a retry cycle is reset or settled", () => {
    const store = createDiaryStateStore(db);
    store.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 100 });
    const first = store.claimNextDiaryItem(READY_EPOCH)!;
    store.recordDreamFailure({
      date: "2026-07-10",
      queueSeq: first.seq,
      error: "deterministic failure",
      failedAtEpoch: READY_EPOCH,
      outcome: "permanent",
    });
    expect(store.getDayState("2026-07-10")?.retryDisposition).toBe("permanent");

    store.markDayStale("2026-07-10");
    expect(store.getDayState("2026-07-10")).toMatchObject({
      attemptCount: 0,
      terminal: false,
      retryDisposition: null,
    });

    const second = store.claimNextDiaryItem(READY_EPOCH + 10)!;
    store.recordDreamFailure({
      date: "2026-07-10",
      queueSeq: second.seq,
      error: "transient failure",
      failedAtEpoch: READY_EPOCH + 10,
      outcome: "transient",
    });
    const third = store.claimNextDiaryItem(READY_EPOCH + 20)!;
    store.settleDreamDay({
      date: "2026-07-10",
      queueSeq: third.seq,
      watermark: "settled",
      settledAtEpoch: 120,
      remoteAttemptSucceeded: false,
    });
    expect(store.getDayState("2026-07-10")).toMatchObject({
      attemptCount: 0,
      terminal: false,
      retryDisposition: null,
    });
  });

  test("settles a dream date and acknowledges its queue item", () => {
    const store = createDiaryStateStore(db);
    store.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 100 });
    const claimed = store.claimNextDiaryItem(READY_EPOCH)!;
    store.settleDreamDay({
      date: "2026-07-10",
      queueSeq: claimed.seq,
      watermark: "dream-watermark",
      settledAtEpoch: 250,
      remoteAttemptSucceeded: false,
    });
    expect(store.getDayState("2026-07-10")).toMatchObject({
      watermark: "dream-watermark",
      settledAtEpoch: 250,
      needsRegen: false,
      terminal: false,
      retryDisposition: null,
    });
    expect(store.hasQueuedDay("2026-07-10")).toBe(false);
  });

  test("remote-verified settle resurrects only other transient-terminal days", () => {
    const store = createDiaryStateStore(db);
    for (const date of ["2026-07-08", "2026-07-09", "2026-07-10"]) {
      store.enqueueDay({ date, enqueuedAtEpoch: 100 });
    }

    for (const [date, outcome] of [
      ["2026-07-08", "transient"],
      ["2026-07-09", "permanent"],
    ] as const) {
      for (let attempt = 0; attempt < DREAM_MAX_AUTO_ATTEMPTS; attempt += 1) {
        const failedAtEpoch = READY_EPOCH + 100 + attempt * 20;
        const item = store.claimNextDiaryItem(failedAtEpoch)!;
        expect(item.targetId).toBe(Number(date.replaceAll("-", "")));
        store.recordDreamFailure({
          date,
          queueSeq: item.seq,
          error: `${outcome} failure`,
          failedAtEpoch,
          outcome,
        });
      }
    }

    const successful = store.claimNextDiaryItem(READY_EPOCH + 1_000)!;
    expect(successful.targetId).toBe(20260710);
    store.settleDreamDay({
      date: "2026-07-10",
      queueSeq: successful.seq,
      watermark: "remote-success",
      settledAtEpoch: 1_000,
      remoteAttemptSucceeded: true,
    });

    expect(store.getDayState("2026-07-08")).toMatchObject({
      attemptCount: 0,
      nextAttemptEpoch: null,
      terminal: false,
      retryDisposition: null,
      lastError: null,
    });
    expect(store.hasQueuedDay("2026-07-08")).toBe(true);
    expect(store.getDayState("2026-07-09")).toMatchObject({
      attemptCount: DREAM_MAX_AUTO_ATTEMPTS,
      terminal: true,
      retryDisposition: "permanent",
    });
    expect(store.hasQueuedDay("2026-07-09")).toBe(true);
  });

  test("quiet-day and already-committed no-op settles do not resurrect", () => {
    const store = createDiaryStateStore(db);
    store.enqueueDay({ date: "2026-07-08", enqueuedAtEpoch: 100 });
    for (let attempt = 0; attempt < DREAM_MAX_AUTO_ATTEMPTS; attempt += 1) {
      const failedAtEpoch = READY_EPOCH + 100 + attempt * 20;
      const item = store.claimNextDiaryItem(failedAtEpoch)!;
      store.recordDreamFailure({
        date: "2026-07-08",
        queueSeq: item.seq,
        error: "transient outage",
        failedAtEpoch,
        outcome: "transient",
      });
    }

    for (const date of ["2026-07-09", "2026-07-10"]) {
      store.enqueueDay({ date, enqueuedAtEpoch: 500 });
      const item = store.claimNextDiaryItem(READY_EPOCH + 500)!;
      store.settleDreamDay({
        date,
        queueSeq: item.seq,
        watermark: `${date}-local-settle`,
        settledAtEpoch: 500,
        remoteAttemptSucceeded: false,
      });
      expect(store.getDayState("2026-07-08")).toMatchObject({
        attemptCount: DREAM_MAX_AUTO_ATTEMPTS,
        terminal: true,
        retryDisposition: "transient",
      });
    }

    expect(store.reconcileBacklog({
      today: "2026-07-11",
      cutoverDate: "2026-07-01",
      lastSuccessfulDate: "2026-07-10",
      maxDays: 7,
      timeZone: "Asia/Shanghai",
      enqueuedAtEpoch: 600,
    })).toEqual([]);
    expect(store.getDayState("2026-07-08")).toMatchObject({
      attemptCount: DREAM_MAX_AUTO_ATTEMPTS,
      terminal: true,
      retryDisposition: "transient",
    });
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
    expect(store.getDayState("2026-07-06")?.retryDisposition).toBe("permanent");
    expect(store.getDayState("2026-07-07")?.retryDisposition).toBe("permanent");
    expect(store.hasQueuedDay("2026-07-06")).toBe(false);
  });

  test("demotes an explicitly stale earlier date to terminal and never resurrects it", () => {
    const store = createDiaryStateStore(db);
    store.enqueueDay({ date: "2026-07-01", enqueuedAtEpoch: 100 });
    const claimed = store.claimNextDiaryItem(READY_EPOCH)!;
    store.settleDreamDay({
      date: "2026-07-01",
      queueSeq: claimed.seq,
      watermark: "old",
      settledAtEpoch: 200,
      remoteAttemptSucceeded: false,
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
    const claimed = store.claimNextDiaryItem(READY_EPOCH)!;
    store.recordDreamFailure({
      date: "2026-07-10",
      queueSeq: claimed.seq,
      error: "agent timed out after commit",
      failedAtEpoch: READY_EPOCH + 100,
      outcome: "transient",
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
    const claimed = store.claimNextDiaryItem(
      Date.parse("2026-11-02T10:00:00Z") / 1_000,
    )!;
    store.settleDreamDay({
      date: "2026-11-01",
      queueSeq: claimed.seq,
      watermark: "before-late-turn",
      settledAtEpoch: 200,
      remoteAttemptSucceeded: false,
    });

    markSettledDiaryDayStaleForTurn(
      db,
      Date.parse("2026-11-02T04:30:00Z") / 1_000,
    );
    expect(store.getDayState("2026-11-01")?.needsRegen).toBe(true);
  });

  test("a pre-dawn turn invalidates the previous day via the 4am boundary", () => {
    const store = createDiaryStateStore(db);
    store.initializeBootstrap("2026-07-16");
    // Seeds dream_timezone + dream_hour (defaults to the 4am boundary).
    store.reconcileBacklog({
      today: "2026-07-16",
      cutoverDate: "2026-07-01",
      lastSuccessfulDate: "2026-07-15",
      maxDays: 7,
      timeZone: "Asia/Shanghai",
      enqueuedAtEpoch: 100,
    });
    store.enqueueDay({ date: "2026-07-15", enqueuedAtEpoch: 100 });
    const claimed = store.claimNextDiaryItem(
      Date.parse("2026-07-16T20:00:00Z") / 1_000,
    )!;
    store.settleDreamDay({
      date: "2026-07-15",
      queueSeq: claimed.seq,
      watermark: "settled",
      settledAtEpoch: 200,
      remoteAttemptSucceeded: false,
    });

    // 2026-07-16 02:00 Shanghai (UTC+8) == 2026-07-15T18:00:00Z. Pre-dawn, so it
    // belongs to Jul 15 — not Jul 16 as a midnight boundary would bucket it.
    markSettledDiaryDayStaleForTurn(
      db,
      Date.parse("2026-07-15T18:00:00Z") / 1_000,
    );
    expect(store.getDayState("2026-07-15")?.needsRegen).toBe(true);
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
