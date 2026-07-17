import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dreamStagingPaths } from "../../src/worker/dream-staging";
import type { CommitNightInput } from "../../src/diary/memory-store";

import { createDatabase } from "../../src/db/database";
import { createDiaryStateStore } from "../../src/db/diary-state";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { updateTurnById } from "../../src/db/turns";
import { DreamMemoryStore } from "../../src/diary/memory-store";
import {
  createDiaryRuntime,
  createDreamQueueProcessor,
} from "../../src/worker/diary-runtime";
import { main } from "../../src/worker/server";
import { DEFAULT_CONFIG } from "../../src/shared/config";
import { saveTurnFixture } from "../support/turn-fixtures";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Simulates the agent's Write/Edit tools laying documents into staging. */
function writeStaging(dataRoot: string, night: CommitNightInput): void {
  const paths = dreamStagingPaths(dataRoot, night.date);
  writeFileSync(paths.userProfile, night.userProfile);
  writeFileSync(paths.experience, night.experience);
  writeFileSync(paths.archive, night.archive);
  writeFileSync(paths.diary, night.diary);
  writeFileSync(paths.diaryIndex, night.diaryIndex);
}
describe("createDiaryRuntime", () => {
  test("two connection failures do not consume attempts and the day later settles automatically", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const stateStore = createDiaryStateStore(db);
    stateStore.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 100 });
    let nowEpoch = 100;
    let runs = 0;
    const processor = createDreamQueueProcessor({
      db,
      stateStore,
      readLastSuccessfulDate: async () => null,
      nowEpoch: () => nowEpoch,
      timeZone: "Asia/Shanghai",
      async processDreamDate() {
        runs += 1;
        if (runs <= 2) {
          throw Object.assign(new Error("socket reset"), {
            code: "ECONNRESET",
          });
        }
      },
    });

    try {
      await expect(
        processor.process(stateStore.claimNextDiaryItem(nowEpoch)!),
      ).rejects.toThrow("socket reset");
      expect(stateStore.getDayState("2026-07-10")).toMatchObject({
        attemptCount: 0,
        nextAttemptEpoch: 1000,
        terminal: false,
        lastError: null,
      });

      nowEpoch = 1000;
      await expect(
        processor.process(stateStore.claimNextDiaryItem(nowEpoch)!),
      ).rejects.toThrow("socket reset");
      expect(stateStore.getDayState("2026-07-10")).toMatchObject({
        attemptCount: 0,
        nextAttemptEpoch: 1900,
        terminal: false,
        lastError: null,
      });

      nowEpoch = 1900;
      await processor.process(stateStore.claimNextDiaryItem(nowEpoch)!);

      expect(runs).toBe(3);
      expect(stateStore.getDayState("2026-07-10")).toMatchObject({
        settledAtEpoch: 1900,
        needsRegen: false,
        attemptCount: 0,
        nextAttemptEpoch: null,
        terminal: false,
        lastError: null,
      });
      expect(stateStore.hasQueuedDay("2026-07-10")).toBe(false);
    } finally {
      db.close();
    }
  });

  test("processes queued dream dates independently when one date fails", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const stateStore = createDiaryStateStore(db);
    for (const date of ["2026-07-08", "2026-07-09", "2026-07-10"]) {
      stateStore.enqueueDay({ date, enqueuedAtEpoch: 100 });
    }
    const calls: string[] = [];
    const processor = createDreamQueueProcessor({
      db,
      stateStore,
      readLastSuccessfulDate: async () => null,
      nowEpoch: () => 100,
      timeZone: "Asia/Shanghai",
      async processDreamDate(date) {
        calls.push(date);
        if (date === "2026-07-09") throw new Error("one date failed");
      },
    });

    try {
      await processor.process(stateStore.claimNextDiaryItem(100)!);
      await expect(
        processor.process(stateStore.claimNextDiaryItem(100)!),
      ).rejects.toThrow("one date failed");
      await processor.process(stateStore.claimNextDiaryItem(100)!);

      expect(calls).toEqual(["2026-07-08", "2026-07-09", "2026-07-10"]);
      expect(stateStore.getDayState("2026-07-08")?.settledAtEpoch).toBe(100);
      expect(stateStore.getDayState("2026-07-09")).toMatchObject({
        attemptCount: 1,
        nextAttemptEpoch: 160,
      });
      expect(stateStore.getDayState("2026-07-10")?.settledAtEpoch).toBe(100);
    } finally {
      db.close();
    }
  });

  test("re-enqueues a late-finalized turn and idempotently replaces that day's outputs", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-dream-late-turn-"));
    roots.push(dataRoot);
    const stateStore = createDiaryStateStore(db);
    stateStore.initializeBootstrap("2026-07-11");
    const session = upsertSession(db, {
      contentSessionId: "dream-late-turn",
      project: "/projects/dream",
      title: "Late turn",
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
    const turn = saveTurnFixture(db, {
      sessionId: session.id,
      promptNumber: 1,
      userPrompt: "This turn will finalize after the first dream.",
      assistantResponse: "Initial response.",
      title: null,
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: Date.parse("2026-07-10T12:00:00+08:00") / 1_000,
      updatedAtEpoch: null,
      observations: [],
    });
    let dreamRuns = 0;
    const runtime = createDiaryRuntime({
      db,
      dataRoot,
      config: DEFAULT_CONFIG,
      nowEpoch: () => 500,
      async runQuery(input) {
        dreamRuns += 1;
        const revision = dreamRuns === 1 ? "initial" : "late-finalized";
        writeStaging(dataRoot, {
          date: "2026-07-10",
          userProfile: "# User Profile\n",
          experience: `# Experience\n\n- 2026-07-10: ${revision} contribution [S${session.id}/T1]\n`,
          archive: "# Memory Archive\n",
          diary: `# 2026-07-10\n\n- ${revision} diary [S${session.id}/T1]\n`,
          diaryIndex: `# Diary Index\n\n- 2026-07-10：${revision}\n`,
        });
        await input.toolHandlers.commit!({});
        return "committed";
      },
    });

    try {
      stateStore.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 100 });
      await runtime.processDreamItem(stateStore.claimNextDiaryItem(200)!);
      expect(stateStore.getDayState("2026-07-10")?.needsRegen).toBe(false);

      updateTurnById(db, turn.id, {
        title: "Late-finalized extraction",
        content: "The finalized content arrived after the first dream.",
        updatedAtEpoch: 300,
      });
      expect(stateStore.getDayState("2026-07-10")?.needsRegen).toBe(true);

      const marker = await new DreamMemoryStore(dataRoot).readLastSuccessfulDate();
      expect(
        stateStore.reconcileBacklog({
          mode: "dream",
          today: "2026-07-11",
          cutoverDate: "2026-06-27",
          lastSuccessfulDate: marker,
          maxDays: 7,
          timeZone: "Asia/Shanghai",
          enqueuedAtEpoch: 400,
        }),
      ).toEqual(["2026-07-10"]);
      await runtime.processDreamItem(stateStore.claimNextDiaryItem(400)!);

      const experience = readFileSync(join(dataRoot, "memory", "experience.md"), "utf8");
      expect(dreamRuns).toBe(2);
      expect(experience).toContain("late-finalized contribution");
      expect(experience).not.toContain("initial contribution");
      expect(experience.match(/2026-07-10/g)).toHaveLength(1);
      expect(readFileSync(join(dataRoot, "diary", "2026-07-10.md"), "utf8"))
        .toContain("late-finalized diary");
      expect(stateStore.getDayState("2026-07-10")?.needsRegen).toBe(false);
    } finally {
      db.close();
    }
  });


  test("exposes the date-based dream processor seam for the session-start trigger", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-dream-runtime-"));
    roots.push(dataRoot);
    const session = upsertSession(db, {
      contentSessionId: "dream-runtime-session",
      project: "/projects/dream-runtime",
      title: "Dream runtime",
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
    saveTurnFixture(db, {
      sessionId: session.id,
      promptNumber: 1,
      userPrompt: "Wire the dream processor without wiring its trigger.",
      assistantResponse: "The runtime exposes a date-based seam.",
      title: null,
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: Date.parse("2026-07-10T04:00:00+08:00") / 1_000,
      updatedAtEpoch: null,
      observations: [],
    });
    let calls = 0;
    const runtime = createDiaryRuntime({
      db,
      dataRoot,
      async runQuery(request) {
        calls += 1;
        writeStaging(dataRoot, {
          date: "2026-07-10",
          userProfile: "# User Profile\n",
          experience: "# Experience\n",
          archive: "# Memory Archive\n",
          diary: "# 2026-07-10\n",
          diaryIndex: "# Diary Index\n",
        });
        await request.toolHandlers.commit!({});
        return "committed";
      },
    });

    try {
      await runtime.processDreamDate("2026-07-10");
      expect(calls).toBe(1);
      expect(readFileSync(join(dataRoot, "diary", "2026-07-10.md"), "utf8"))
        .toBe("# 2026-07-10\n");
    } finally {
      db.close();
    }
  });

  test("settles a committed date when the agent request throws afterward", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-committed-threw-"));
    roots.push(dataRoot);
    const stateStore = createDiaryStateStore(db);
    const session = upsertSession(db, {
      contentSessionId: "dream-committed-threw",
      project: "/projects/dream",
      title: "Committed then threw",
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
    saveTurnFixture(db, {
      sessionId: session.id,
      promptNumber: 1,
      userPrompt: "Commit before the request reports a timeout.",
      assistantResponse: "The durable commit wins.",
      title: null,
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: Date.parse("2026-07-10T12:00:00+08:00") / 1_000,
      updatedAtEpoch: null,
      observations: [],
    });
    let dreamRuns = 0;
    const runtime = createDiaryRuntime({
      db,
      dataRoot,
      config: DEFAULT_CONFIG,
      nowEpoch: () => 500,
      async runQuery(request) {
        dreamRuns += 1;
        writeStaging(dataRoot, {
          date: "2026-07-10",
          userProfile: "# User Profile\n",
          experience: "# Experience\n\n- committed once [S1/T1]\n",
          archive: "# Memory Archive\n",
          diary: "# 2026-07-10\n\n- committed once [S1/T1]\n",
          diaryIndex: "# Diary Index\n\n- 2026-07-10：committed once\n",
        });
        await request.toolHandlers.commit!({});
        throw new Error("Diary agent request timed out after 600000ms.");
      },
    });

    try {
      stateStore.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 100 });
      await runtime.processDreamItem(stateStore.claimNextDiaryItem(200)!);

      expect(dreamRuns).toBe(1);
      expect(await new DreamMemoryStore(dataRoot).readLastSuccessfulDate())
        .toBe("2026-07-10");
      expect(stateStore.getDayState("2026-07-10")).toMatchObject({
        settledAtEpoch: 500,
        needsRegen: false,
        attemptCount: 0,
        nextAttemptEpoch: null,
        lastError: null,
      });
      expect(stateStore.hasQueuedDay("2026-07-10")).toBe(false);
      expect(stateStore.reconcileBacklog({
        today: "2026-07-11",
        cutoverDate: "2026-06-27",
        lastSuccessfulDate: "2026-07-10",
        maxDays: 7,
        timeZone: "Asia/Shanghai",
        enqueuedAtEpoch: 600,
      })).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("re-processing an already committed date is an idempotent no-op", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-dream-idempotent-"));
    roots.push(dataRoot);
    {
      const session = upsertSession(db, {
        contentSessionId: "dream-idempotent",
        project: "/projects/dream",
        title: "Idempotent dream",
        content: null,
        insight: null,
        createdAtEpoch: 1,
        updatedAtEpoch: null,
        completedAtEpoch: null,
      });
      saveTurnFixture(db, {
        sessionId: session.id,
        promptNumber: 1,
        userPrompt: "Only contribute once.",
        assistantResponse: "One durable contribution.",
        title: null,
        insight: null,
        filesRead: [],
        filesModified: [],
        createdAtEpoch: Date.parse("2026-07-10T12:00:00+08:00") / 1_000,
        updatedAtEpoch: null,
        observations: [],
      });
    }
    let dreamRuns = 0;
    const seenTimeouts: number[] = [];
    const runtime = createDiaryRuntime({
      db,
      dataRoot,
      config: { ...DEFAULT_CONFIG, dreamAgentTimeoutMs: 2_400_000 },
      async runQuery(request) {
        dreamRuns += 1;
        seenTimeouts.push(request.timeoutMs);
        writeStaging(dataRoot, {
          date: "2026-07-10",
          userProfile: "# User Profile\n",
          experience: "# Experience\n\n- 2026-07-10: only contribution [S1/T1]\n",
          archive: "# Memory Archive\n",
          diary: "# 2026-07-10\n\n- only contribution [S1/T1]\n",
          diaryIndex: "# Diary Index\n\n- 2026-07-10：only contribution\n",
        });
        await request.toolHandlers.commit!({});
        return "committed";
      },
    });

    try {
      await runtime.processDreamDate("2026-07-10");
      const committedExperience = readFileSync(
        join(dataRoot, "memory", "experience.md"),
        "utf8",
      );
      const snapshotCount = (await new DreamMemoryStore(dataRoot).listSnapshots()).length;

      await runtime.processDreamDate("2026-07-10");

      expect(dreamRuns).toBe(1);
      expect(seenTimeouts).toEqual([2_400_000]);
      expect(readFileSync(join(dataRoot, "memory", "experience.md"), "utf8"))
        .toBe(committedExperience);
      expect((await new DreamMemoryStore(dataRoot).listSnapshots()).length)
        .toBe(snapshotCount);
    } finally {
      db.close();
    }
  });

  test("production main routes every explicitly woken date through the sole dream runtime", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-main-runtime-"));
    roots.push(dataRoot);
    const stateStore = createDiaryStateStore(db);
    stateStore.initializeBootstrap("2026-07-11");
    stateStore.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 100 });
    const processedTargets: number[] = [];
    let factoryCalls = 0;
    let fetchHandler: ((request: Request) => Promise<Response>) | null = null;
    const originalSetInterval = globalThis.setInterval;
    globalThis.setInterval = mock(
      () => 0 as unknown as NodeJS.Timeout,
    ) as typeof setInterval;

    try {
      await main({
        db,
        env: {},
        dataRoot,
        config: DEFAULT_CONFIG,
        logger: { warn() {}, error() {} },
        createDiaryRuntimeImpl(options) {
          factoryCalls += 1;
          expect(options.db).toBe(db);
          expect(options.dataRoot).toBe(dataRoot);
          return {
            async processDreamItem(item) {
              processedTargets.push(item.targetId);
              stateStore.acknowledgeDiaryItem(item.seq);
            },
            async processDreamDate() {},
          };
        },
        BunServeImpl: mock(((options: { fetch: (request: Request) => Promise<Response> }) => {
          fetchHandler = options.fetch;
          return { stop() {} };
        }) as typeof Bun.serve),
        pidPath: join(dataRoot, "worker.pid"),
        startingPath: join(dataRoot, "worker.starting"),
        existsSyncImpl: () => false,
        mkdirSyncImpl: (() => undefined) as typeof import("node:fs").mkdirSync,
        writeFileSyncImpl: (() => undefined) as typeof import("node:fs").writeFileSync,
        unlinkSyncImpl: (() => undefined) as typeof import("node:fs").unlinkSync,
        processImpl: {
          pid: 12345,
          on: (() => undefined) as NodeJS.Process["on"],
          exit: (() => undefined as never) as NodeJS.Process["exit"],
        },
      });

      expect(fetchHandler).not.toBeNull();
      const response = await fetchHandler!(
        new Request("http://127.0.0.1:37778/wake", { method: "POST" }),
      );
      expect(response.status).toBe(200);

      for (let i = 0; i < 10 && processedTargets.length === 0; i += 1) {
        await Promise.resolve();
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(factoryCalls).toBe(1);
      expect(processedTargets).toEqual([20260710]);
    } finally {
      globalThis.setInterval = originalSetInterval;
      db.close();
    }
  });
});
