import { afterEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase } from "../../src/db/database";
import { createDiaryStateStore } from "../../src/db/diary-state";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { DEFAULT_CONFIG, type MnemoConfig } from "../../src/shared/config";
import { createDiaryRuntime } from "../../src/worker/diary-runtime";
import { createWorkerCore } from "../../src/worker/server";

const DUE_DATE = "2026-07-10";
const END_EVENT_EPOCH = Date.parse("2026-07-11T12:00:00+08:00") / 1_000;
// After the due day closed at the 4am boundary, so a claim is eligible.
const CLAIM_EPOCH = Date.parse("2026-07-11T05:00:00+08:00") / 1_000;

function dreamConfig(enabled: boolean): MnemoConfig {
  return { ...DEFAULT_CONFIG, dreamAgentEnabled: enabled };
}

function claimedSeqs(db: Database): number[] {
  return db
    .query<{ seq: number }, []>(
      `SELECT seq FROM pending_queue
       WHERE kind = 'diary' AND claimed_at_epoch IS NOT NULL`,
    )
    .all()
    .map((row) => row.seq);
}

function cutoverDate(db: Database): string | null {
  return (
    db
      .query<{ value: string }, []>(
        "SELECT value FROM diary_state WHERE key = 'cutover_date'",
      )
      .get()?.value ?? null
  );
}

describe("dream kill switch", () => {
  const databases: Database[] = [];
  const roots: string[] = [];

  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function setupCore(options: { enabled: boolean; seedDueDay?: boolean }) {
    const db = createDatabase(":memory:");
    databases.push(db);
    initializeSchema(db);
    const sessionId = upsertSession(db, {
      contentSessionId: "dream-kill-switch",
      project: "/proj",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: END_EVENT_EPOCH,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
    const stateStore = createDiaryStateStore(db);
    if (options.seedDueDay !== false) {
      stateStore.enqueueDay({ date: DUE_DATE, enqueuedAtEpoch: 100 });
    }
    const processDiaryItem = mock(async (item: { seq: number }) => {
      stateStore.acknowledgeDiaryItem(item.seq);
    });
    const reconcileDreamBacklog = mock(async () => [DUE_DATE]);
    const timers: Array<() => void | Promise<void>> = [];
    const core = createWorkerCore({
      db,
      now: () => END_EVENT_EPOCH,
      config: dreamConfig(options.enabled),
      processDiaryItem,
      reconcileDreamBacklog,
      pushSessionSummaryPromptImpl: async () => {},
      setTimeoutImpl(callback) {
        timers.push(callback);
        return timers.length;
      },
      clearTimeoutImpl() {},
      logger: { warn() {}, error() {} },
    });
    return {
      db,
      core,
      sessionId,
      stateStore,
      processDiaryItem,
      reconcileDreamBacklog,
      async runTimers() {
        for (const callback of timers.splice(0)) await callback();
      },
    };
  }

  test("the flag is off by default", () => {
    expect(DEFAULT_CONFIG.dreamAgentEnabled).toBe(false);
  });

  for (const entry of ["SessionEnd", "PreCompact"] as const) {
    test(`disabled: a ${entry} end event neither reconciles nor claims a due day`, async () => {
      const fixture = setupCore({ enabled: false });

      if (entry === "SessionEnd") {
        await fixture.core.finishSession(fixture.sessionId);
      } else {
        await fixture.core.handleCompact(fixture.sessionId, null);
      }

      expect(fixture.reconcileDreamBacklog).not.toHaveBeenCalled();
      expect(fixture.processDiaryItem).not.toHaveBeenCalled();
      expect(fixture.stateStore.hasQueuedDay(DUE_DATE)).toBe(true);
      expect(claimedSeqs(fixture.db)).toEqual([]);
    });

    test(`enabled: a ${entry} end event reconciles and dispatches as before`, async () => {
      const fixture = setupCore({ enabled: true });

      if (entry === "SessionEnd") {
        await fixture.core.finishSession(fixture.sessionId);
      } else {
        await fixture.core.handleCompact(fixture.sessionId, null);
      }

      expect(fixture.reconcileDreamBacklog).toHaveBeenCalledTimes(1);
      expect(fixture.processDiaryItem).toHaveBeenCalledTimes(1);
      expect(fixture.stateStore.hasQueuedDay(DUE_DATE)).toBe(false);
    });
  }

  test("disabled: a retry-ready failed day stays unclaimed", async () => {
    const fixture = setupCore({ enabled: false });
    const first = fixture.stateStore.claimNextDiaryItem(CLAIM_EPOCH)!;
    fixture.stateStore.recordDreamFailure({
      date: DUE_DATE,
      queueSeq: first.seq,
      error: "connection reset",
      failedAtEpoch: CLAIM_EPOCH,
      outcome: "transient",
    });
    // The retry is due (backoff long elapsed): only the flag can hold it back.
    expect(fixture.stateStore.hasReadyDiaryItem(END_EVENT_EPOCH)).toBe(true);

    await fixture.core.finishSession(fixture.sessionId);

    expect(fixture.processDiaryItem).not.toHaveBeenCalled();
    expect(fixture.stateStore.getDayState(DUE_DATE)?.attemptCount).toBe(1);
    expect(fixture.stateStore.hasReadyDiaryItem(END_EVENT_EPOCH)).toBe(true);
  });

  test("disabled: a manual POST /dream is rejected and writes nothing", async () => {
    const fixture = setupCore({ enabled: false, seedDueDay: false });

    expect(fixture.core.triggerManualDream(DUE_DATE)).toMatchObject({
      ok: false,
      status: 503,
    });

    expect(fixture.stateStore.hasQueuedDay(DUE_DATE)).toBe(false);
    expect(fixture.stateStore.getDayState(DUE_DATE)).toBeNull();
    expect(cutoverDate(fixture.db)).toBeNull();
    await fixture.runTimers();
    expect(fixture.processDiaryItem).not.toHaveBeenCalled();
  });

  test("enabled: a manual POST /dream still enqueues and drains its day", async () => {
    const fixture = setupCore({ enabled: true, seedDueDay: false });

    expect(fixture.core.triggerManualDream(DUE_DATE)).toEqual({
      ok: true,
      date: DUE_DATE,
    });
    expect(fixture.stateStore.hasQueuedDay(DUE_DATE)).toBe(true);
    await fixture.runTimers();

    expect(fixture.processDiaryItem).toHaveBeenCalledTimes(1);
    expect(fixture.reconcileDreamBacklog).not.toHaveBeenCalled();
  });

  test("disabled: the diary runtime neither enqueues a backlog nor runs the agent", async () => {
    const db = createDatabase(":memory:");
    databases.push(db);
    initializeSchema(db);
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-dream-off-"));
    roots.push(dataRoot);
    const stateStore = createDiaryStateStore(db);
    stateStore.enqueueDay({ date: DUE_DATE, enqueuedAtEpoch: 100 });
    const item = stateStore.claimNextDiaryItem(CLAIM_EPOCH)!;
    const runQuery = mock(async () => "");
    const runtime = createDiaryRuntime({
      db,
      dataRoot,
      runQuery,
      nowEpoch: () => END_EVENT_EPOCH,
      config: dreamConfig(false),
    });

    expect(await runtime.reconcileDreamBacklog(END_EVENT_EPOCH)).toEqual([]);
    // Reconcile bootstraps the cutover date on its first run; a disabled dream
    // must not even take that write.
    expect(cutoverDate(db)).toBeNull();

    await runtime.processDreamItem(item);
    await runtime.processDreamDate(DUE_DATE);

    expect(runQuery).not.toHaveBeenCalled();
    expect(runtime.isDreamRunning()).toBe(false);
  });
});
