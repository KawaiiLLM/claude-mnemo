import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { createDiaryStateStore } from "../../src/db/diary-state";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { computeDiaryWatermark } from "../../src/diary/domain";
import { saveTurnFixture } from "../support/turn-fixtures";

describe("DiaryStateStore", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("deduplicates a diary day and claims the eligible item once", () => {
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

  test("persists the default state for an enqueued diary day", () => {
    const store = createDiaryStateStore(db);

    store.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 100 });

    expect(store.getDayState("2026-07-10")).toEqual({
      date: "2026-07-10",
      watermark: null,
      fileSha256: null,
      indexHook: null,
      validationReportJson: null,
      settledAtEpoch: null,
      needsRegen: false,
      pendingRebase: false,
      attemptCount: 0,
      nextAttemptEpoch: null,
      lastError: null,
      terminal: false,
    });
  });

  test("defers a failed diary item until its retry time", () => {
    const store = createDiaryStateStore(db);

    store.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 100 });
    const claimed = store.claimNextDiaryItem(200);

    store.recordFailure({
      date: "2026-07-10",
      queueSeq: claimed!.seq,
      error: "watchdog timeout",
      nextAttemptEpoch: 500,
    });

    expect(store.getDayState("2026-07-10")).toMatchObject({
      attemptCount: 1,
      nextAttemptEpoch: 500,
      lastError: "watchdog timeout",
      terminal: false,
    });
    expect(store.claimNextDiaryItem(499)).toBeNull();
    expect(store.claimNextDiaryItem(500)).toMatchObject({
      kind: "diary",
      targetId: 20260710,
      claimedAtEpoch: 500,
    });
  });

  test("terminalizes a diary day after its third failed attempt", () => {
    const store = createDiaryStateStore(db);

    store.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 100 });
    for (const [claimAt, retryAt] of [
      [200, 300],
      [300, 400],
      [400, 500],
    ] as const) {
      const claimed = store.claimNextDiaryItem(claimAt);
      store.recordFailure({
        date: "2026-07-10",
        queueSeq: claimed!.seq,
        error: "agent failed",
        nextAttemptEpoch: retryAt,
      });
    }

    expect(store.getDayState("2026-07-10")).toMatchObject({
      attemptCount: 3,
      terminal: true,
    });
    expect(store.claimNextDiaryItem(500)).toBeNull();
  });

  test("settles a diary day and acknowledges its queue item", () => {
    const store = createDiaryStateStore(db);

    store.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 100 });
    const claimed = store.claimNextDiaryItem(200);
    store.settleDay({
      date: "2026-07-10",
      queueSeq: claimed!.seq,
      watermark: "a3f9c2e18b04d7f6",
      fileSha256: "full-file-sha256",
      indexHook: "完成 diary state tracer",
      validationReportJson: '{"version":1,"total":1,"deleted":0,"items":[]}',
      settledAtEpoch: 250,
    });

    expect(store.getDayState("2026-07-10")).toEqual({
      date: "2026-07-10",
      watermark: "a3f9c2e18b04d7f6",
      fileSha256: "full-file-sha256",
      indexHook: "完成 diary state tracer",
      validationReportJson: '{"version":1,"total":1,"deleted":0,"items":[]}',
      settledAtEpoch: 250,
      needsRegen: false,
      pendingRebase: false,
      attemptCount: 0,
      nextAttemptEpoch: null,
      lastError: null,
      terminal: false,
    });
    expect(store.claimNextDiaryItem(300)).toBeNull();
  });

  test("overwrites validation reports on success, preserves them on failure, and clears them on tombstone", () => {
    const store = createDiaryStateStore(db);
    const zeroDeletionReport = '{"version":1,"total":2,"deleted":0,"items":[]}';
    const deletionReport = '{"version":1,"total":3,"deleted":1,"items":[{"section":"人物"}]}';

    store.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 100 });
    store.commitDayState({
      date: "2026-07-10",
      watermark: "first",
      fileSha256: "first-sha",
      indexHook: "first hook",
      validationReportJson: zeroDeletionReport,
      settledAtEpoch: 200,
    });
    expect(store.getDayState("2026-07-10")?.validationReportJson).toBe(zeroDeletionReport);

    store.commitDayState({
      date: "2026-07-10",
      watermark: "second",
      fileSha256: "second-sha",
      indexHook: "second hook",
      validationReportJson: deletionReport,
      settledAtEpoch: 300,
    });
    store.recordFailure({
      date: "2026-07-10",
      queueSeq: store.claimNextDiaryItem(300)!.seq,
      error: "later failed attempt",
      nextAttemptEpoch: 400,
    });
    expect(store.getDayState("2026-07-10")).toMatchObject({
      validationReportJson: deletionReport,
      lastError: "later failed attempt",
    });

    store.commitDayTombstone({ date: "2026-07-10", requestRebuild: false });
    expect(store.getDayState("2026-07-10")?.validationReportJson).toBeNull();
  });

  test("starts a fresh retry epoch when a diary day is marked stale", () => {
    const store = createDiaryStateStore(db);

    store.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 100 });
    for (const [claimAt, retryAt] of [
      [200, 300],
      [300, 400],
      [400, 500],
    ] as const) {
      const claimed = store.claimNextDiaryItem(claimAt);
      store.recordFailure({
        date: "2026-07-10",
        queueSeq: claimed!.seq,
        error: "agent failed",
        nextAttemptEpoch: retryAt,
      });
    }

    store.markDayStale("2026-07-10");

    expect(store.getDayState("2026-07-10")).toMatchObject({
      needsRegen: true,
      attemptCount: 0,
      nextAttemptEpoch: null,
      lastError: null,
      terminal: false,
    });
  });

  test("reconciles only material dates inside the backfill window", () => {
    const store = createDiaryStateStore(db);
    const sessionId = upsertSession(db, {
      contentSessionId: "diary-reconcile",
      project: "/projects/diary",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
    const insertTurn = db.query(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, created_at_epoch
       ) VALUES (?, ?, ?, ?, ?)`,
    );
    insertTurn.run(
      sessionId,
      1,
      "skipped",
      "inside window",
      Date.parse("2026-07-08T04:00:00Z") / 1_000,
    );
    insertTurn.run(
      sessionId,
      2,
      "extracted",
      "yesterday",
      Date.parse("2026-07-10T04:00:00Z") / 1_000,
    );
    insertTurn.run(
      sessionId,
      3,
      "undone",
      "excluded undone",
      Date.parse("2026-07-09T04:00:00Z") / 1_000,
    );
    insertTurn.run(
      sessionId,
      4,
      "active",
      "excluded today",
      Date.parse("2026-07-11T04:00:00Z") / 1_000,
    );
    insertTurn.run(
      sessionId,
      5,
      "skipped",
      "before cutover",
      Date.parse("2026-06-20T04:00:00Z") / 1_000,
    );

    expect(
      store.reconcileBacklog({
        today: "2026-07-11",
        cutoverDate: "2026-06-27",
        enqueuedAtEpoch: 500,
      }),
    ).toEqual(["2026-07-08", "2026-07-10"]);
    expect(store.claimNextDiaryItem(600)?.targetId).toBe(20260708);
    expect(store.claimNextDiaryItem(600)?.targetId).toBe(20260710);
    expect(store.claimNextDiaryItem(600)).toBeNull();
  });

  test("requeues a settled day only after its diary material changes", () => {
    const store = createDiaryStateStore(db);
    const sessionId = upsertSession(db, {
      contentSessionId: "diary-reconcile-watermark",
      project: "/projects/diary",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
    const turn = saveTurnFixture(db, {
      sessionId,
      promptNumber: 1,
      userPrompt: "original prompt",
      assistantResponse: "original response",
      title: "original title",
      content: "original content",
      insight: "original insight",
      filesRead: [],
      filesModified: [],
      createdAtEpoch: Date.parse("2026-07-10T04:00:00Z") / 1_000,
      updatedAtEpoch: null,
      observations: [],
    });
    const originalWatermark = computeDiaryWatermark([
      {
        turnId: turn.id,
        status: turn.status,
        userPrompt: turn.userPrompt,
        assistantResponse: turn.assistantResponse,
        title: turn.title,
        content: turn.content,
        insight: turn.insight,
      },
    ]);

    store.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 100 });
    store.settleDay({
      date: "2026-07-10",
      queueSeq: store.claimNextDiaryItem(200)!.seq,
      watermark: originalWatermark,
      fileSha256: "sha",
      indexHook: "settled diary",
      settledAtEpoch: 250,
    });

    expect(
      store.reconcileBacklog({
        today: "2026-07-11",
        cutoverDate: "2026-06-27",
        enqueuedAtEpoch: 300,
      }),
    ).toEqual([]);
    expect(
      store.reconcileBacklog({
        today: "2026-07-11",
        cutoverDate: "2026-06-27",
        enqueuedAtEpoch: 301,
      }),
    ).toEqual([]);
    expect(store.hasQueuedDay("2026-07-10")).toBe(false);

    db.query(
      `UPDATE turns
       SET title = ?, content = ?, assistant_response = ?
       WHERE id = ?`,
    ).run("changed title", "changed content", "changed response", turn.id);

    expect(
      store.reconcileBacklog({
        today: "2026-07-11",
        cutoverDate: "2026-06-27",
        enqueuedAtEpoch: 400,
      }),
    ).toEqual(["2026-07-10"]);
    expect(store.hasQueuedDay("2026-07-10")).toBe(true);
  });

  test("reconciles recent state rows and older explicitly stale dates", () => {
    const store = createDiaryStateStore(db);
    const sessionId = upsertSession(db, {
      contentSessionId: "diary-reconcile-state",
      project: "/projects/diary",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
    const insertTurn = db.query(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, created_at_epoch
       ) VALUES (?, ?, 'skipped', ?, ?)`,
    );
    insertTurn.run(
      sessionId,
      1,
      "recent material",
      Date.parse("2026-07-10T04:00:00Z") / 1_000,
    );
    insertTurn.run(
      sessionId,
      2,
      "old material without stale flag",
      Date.parse("2026-06-01T04:00:00Z") / 1_000,
    );
    store.enqueueDay({ date: "2026-07-09", enqueuedAtEpoch: 100 });
    store.enqueueDay({ date: "2026-05-01", enqueuedAtEpoch: 100 });
    store.markDayStale("2026-05-01");

    expect(
      store.reconcileBacklog({
        today: "2026-07-11",
        cutoverDate: "2026-01-01",
        enqueuedAtEpoch: 500,
      }),
    ).toEqual(["2026-05-01", "2026-07-09", "2026-07-10"]);
  });

  test("exposes day-state rows as the source for the diary index", () => {
    const store = createDiaryStateStore(db);
    store.enqueueDay({ date: "2026-07-09", enqueuedAtEpoch: 100 });
    store.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 100 });
    const claimed = store.claimNextDiaryItem(200);
    store.settleDay({
      date: "2026-07-09",
      queueSeq: claimed!.seq,
      watermark: "watermark",
      fileSha256: "sha",
      indexHook: "older hook",
      settledAtEpoch: 250,
    });

    expect(store.listIndexRows()).toEqual([
      { date: "2026-07-09", indexHook: "older hook" },
      { date: "2026-07-10", indexHook: null },
    ]);
  });

  test("keeps a committed diary queued until the index is ready to acknowledge", () => {
    const store = createDiaryStateStore(db);
    store.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 100 });
    const claimed = store.claimNextDiaryItem(200)!;

    store.commitDayState({
      date: "2026-07-10",
      watermark: "watermark",
      fileSha256: "sha",
      indexHook: "index hook",
      settledAtEpoch: 250,
    });

    expect(store.hasQueuedDay("2026-07-10")).toBe(true);
    store.acknowledgeDiaryItem(claimed.seq);
    expect(store.hasQueuedDay("2026-07-10")).toBe(false);
  });

  test("initializes the fourteen-day bootstrap state once", () => {
    const store = createDiaryStateStore(db);

    expect(store.initializeBootstrap("2026-07-11")).toEqual({
      cutoverDate: "2026-06-27",
      rebuildRequested: true,
    });
    expect(store.initializeBootstrap("2026-07-20")).toEqual({
      cutoverDate: "2026-06-27",
      rebuildRequested: true,
    });
  });

  test("lists only settled non-tombstone diaries for persona maintenance", () => {
    const store = createDiaryStateStore(db);
    store.enqueueDay({ date: "2026-07-09", enqueuedAtEpoch: 100 });
    store.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 100 });
    const claimed = store.claimNextDiaryItem(200)!;
    store.settleDay({
      date: "2026-07-09",
      queueSeq: claimed.seq,
      watermark: "watermark-09",
      fileSha256: "sha-09",
      indexHook: "hook-09",
      settledAtEpoch: 250,
    });

    expect(store.listSettledDays()).toEqual([
      {
        date: "2026-07-09",
        watermark: "watermark-09",
        fileSha256: "sha-09",
        indexHook: "hook-09",
      },
    ]);
  });

  test("rotates ten historical diary integrity candidates across restarts and skips tombstones", () => {
    const store = createDiaryStateStore(db);
    const dates = [
      "2026-06-01",
      "2026-06-02",
      "2026-06-03",
      "2026-06-04",
      "2026-06-05",
      "2026-06-06",
      "2026-06-07",
      "2026-06-08",
      "2026-06-09",
      "2026-06-10",
      "2026-06-11",
      "2026-06-12",
      "2026-07-30",
    ];

    for (const date of dates) {
      store.enqueueDay({ date, enqueuedAtEpoch: 100 });
      store.commitDayState({
        date,
        watermark: `watermark-${date}`,
        fileSha256: `sha-${date}`,
        indexHook: `hook-${date}`,
        settledAtEpoch: 200,
      });
    }
    store.enqueueDay({ date: "2026-06-03", enqueuedAtEpoch: 100 });
    store.commitDayTombstone({
      date: "2026-06-03",
      requestRebuild: false,
    });

    expect(
      store
        .nextIntegrityScanBatch({ beforeDate: "2026-07-30", limit: 10 })
        .map((day) => day.date),
    ).toEqual([
      "2026-06-01",
      "2026-06-02",
      "2026-06-04",
      "2026-06-05",
      "2026-06-06",
      "2026-06-07",
      "2026-06-08",
      "2026-06-09",
      "2026-06-10",
      "2026-06-11",
    ]);

    const restartedStore = createDiaryStateStore(db);
    expect(
      restartedStore
        .nextIntegrityScanBatch({ beforeDate: "2026-07-30", limit: 10 })
        .map((day) => day.date),
    ).toEqual([
      "2026-06-12",
      "2026-06-01",
      "2026-06-02",
      "2026-06-04",
      "2026-06-05",
      "2026-06-06",
      "2026-06-07",
      "2026-06-08",
      "2026-06-09",
      "2026-06-10",
    ]);
  });
});
