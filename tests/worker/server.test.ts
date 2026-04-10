import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import {
  checkForIdleWorkerShutdown,
  acquireWorkerSingleton,
  createWorkerCore,
  createWorkerFetchHandler,
  createWorkerServerState,
  main,
} from "../../src/worker/server";
import type { WorkerQuerySession } from "../../src/worker/query-session";

describe("worker server", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("acquireWorkerSingleton writes a starting marker when nothing is running", () => {
    const writes: Array<{ path: string; value: string }> = [];

    const result = acquireWorkerSingleton({
      pidPath: "/tmp/worker.pid",
      startingPath: "/tmp/worker.starting",
      existsSyncImpl: () => false,
      writeFileSyncImpl: ((path: string, value: string) => {
        writes.push({ path, value });
      }) as typeof import("node:fs").writeFileSync,
      mkdirSyncImpl: (() => undefined) as typeof import("node:fs").mkdirSync,
    });

    expect(result).toBe("acquired");
    expect(writes).toEqual([
      { path: "/tmp/worker.starting", value: String(process.pid) },
    ]);
  });

  test("createWorkerFetchHandler deduplicates concurrent wake scans", async () => {
    let resolveDrain: (() => void) | null = null;
    let drainCalls = 0;
    const scanAndDrainQueue = mock(
      () =>
        new Promise<void>((resolve) => {
          drainCalls += 1;
          resolveDrain = resolve;
        }),
    );
    const handler = createWorkerFetchHandler({
      scanAndDrainQueue,
    });

    const firstWake = handler(new Request("http://127.0.0.1:37778/wake", { method: "POST" }));
    const secondWake = handler(new Request("http://127.0.0.1:37778/wake", { method: "POST" }));

    const [firstResponse, secondResponse] = await Promise.all([firstWake, secondWake]);
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(scanAndDrainQueue).toHaveBeenCalledTimes(1);

    resolveDrain?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(drainCalls).toBe(2);
  });

  test("createWorkerFetchHandler validates compact requests", async () => {
    const handleCompactImpl = mock(async () => {});
    const handler = createWorkerFetchHandler({
      handleCompactImpl,
    });

    const missingSession = await handler(
      new Request("http://127.0.0.1:37778/compact", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(missingSession.status).toBe(400);

    const ok = await handler(
      new Request("http://127.0.0.1:37778/compact", {
        method: "POST",
        body: JSON.stringify({
          session_id: 7,
          transcript_path: "/tmp/session.jsonl",
        }),
      }),
    );

    expect(ok.status).toBe(200);
    expect(handleCompactImpl).toHaveBeenCalledWith(7, "/tmp/session.jsonl");
  });

  test("createWorkerFetchHandler tracks HTTP activity while requests are in flight", async () => {
    let resolveCompact: (() => void) | null = null;
    const serverState = createWorkerServerState(100);
    const handler = createWorkerFetchHandler(
      {
        nowMs: () => 100,
        handleCompactImpl: mock(
          () =>
            new Promise<void>((resolve) => {
              resolveCompact = resolve;
            }),
        ),
      },
      serverState,
    );

    const responsePromise = handler(
      new Request("http://127.0.0.1:37778/compact", {
        method: "POST",
        body: JSON.stringify({ session_id: 7 }),
      }),
    );

    await Promise.resolve();

    expect(serverState.lastHttpRequestAt).toBe(100);
    expect(serverState.activeRequests).toBe(1);

    resolveCompact?.();
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(serverState.activeRequests).toBe(0);
    expect(serverState.lastHttpRequestAt).toBe(100);
  });

  test("checkForIdleWorkerShutdown shuts down after 30 minutes without HTTP traffic", async () => {
    const shutdownCalls: number[] = [];
    const processExit = mock((_code?: number) => undefined as never);
    const serverState = createWorkerServerState(0);
    serverState.lastHttpRequestAt = 0;

    const didShutdown = await checkForIdleWorkerShutdown(serverState, {
      nowMs: () => 1_800_001,
      shutdownGracefullyImpl: async () => {
        shutdownCalls.push(1);
      },
      processImpl: {
        pid: process.pid,
        on: mock(() => process as never),
        exit: processExit,
      },
    });

    expect(didShutdown).toBe(true);
    expect(shutdownCalls).toEqual([1]);
    expect(processExit).toHaveBeenCalledWith(0);
  });

  test("checkForIdleWorkerShutdown does not exit while an HTTP request is active", async () => {
    const shutdown = mock(async () => {});
    const processExit = mock((_code?: number) => undefined as never);
    const serverState = createWorkerServerState(0);
    serverState.lastHttpRequestAt = 0;
    serverState.activeRequests = 1;

    const didShutdown = await checkForIdleWorkerShutdown(serverState, {
      nowMs: () => 1_800_001,
      shutdownGracefullyImpl: shutdown,
      processImpl: {
        pid: process.pid,
        on: mock(() => process as never),
        exit: processExit,
      },
    });

    expect(didShutdown).toBe(false);
    expect(shutdown).not.toHaveBeenCalled();
    expect(processExit).not.toHaveBeenCalled();
  });

  test("createWorkerCore serializes same-session items and recovers claimed rows", async () => {
    const firstSessionId = upsertSession(db, {
      contentSessionId: "worker-session-11",
      project: "/tmp/project-a",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    const secondSessionId = upsertSession(db, {
      contentSessionId: "worker-session-12",
      project: "/tmp/project-b",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 2,
      updatedAtEpoch: 2,
      completedAtEpoch: null,
    }).id;

    db.query(
      `
        INSERT INTO pending_queue (kind, target_id, session_db_id, claimed_at_epoch, enqueued_at_epoch)
        VALUES
          ('obs', 1, ?, NULL, 1),
          ('turn-stop', 2, ?, NULL, 2),
          ('obs', 3, ?, 999, 3)
      `,
    ).run(firstSessionId, firstSessionId, secondSessionId);

    const started: string[] = [];
    const finished: string[] = [];
    const pushedPrompts: string[] = [];
    let createdSessions = 0;
    let resolveFirstObs!: () => void;
    const firstObsGate = new Promise<void>((resolve) => {
      resolveFirstObs = resolve;
    });

    const core = createWorkerCore({
      db,
      now: () => 123,
      processObsImpl: async (_state, observationId) => {
        started.push(`obs:${observationId}`);
        await _state.pushMessage(`obs:${observationId}`);
        if (observationId === 1) {
          await firstObsGate;
        }
        finished.push(`obs:${observationId}`);
      },
      processTurnStopImpl: async (_state, turnId) => {
        started.push(`turn:${turnId}`);
        await _state.pushMessage(`turn:${turnId}`);
        finished.push(`turn:${turnId}`);
      },
      createWorkerQuerySessionImpl: ((_input) => {
        createdSessions += 1;
        return {
          sessionId: "worker-query",
          queryPid: 4321,
          async sendPrompt(prompt: string) {
            pushedPrompts.push(prompt);
            return {
              session_id: "worker-query",
            };
          },
          async close() {},
        } satisfies WorkerQuerySession;
      }) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
    });

    core.recoverFromCrash();
    expect(
      db
        .query<{ claimed_at_epoch: number | null }, []>(
          "SELECT claimed_at_epoch FROM pending_queue WHERE seq = 3",
        )
        .get()?.claimed_at_epoch,
    ).toBeNull();

    const drainPromise = core.scanAndDrainQueue();
    await Promise.resolve();
    await Promise.resolve();

    expect(started).toEqual(["obs:1"]);

    resolveFirstObs();
    await drainPromise;

    expect(started).toEqual(["obs:1", "turn:2", "obs:3"]);
    expect(finished).toEqual(["obs:1", "turn:2", "obs:3"]);
    expect(createdSessions).toBe(2);
    expect(pushedPrompts).toEqual(["obs:1", "turn:2", "obs:3"]);
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM pending_queue").get()
        ?.count,
    ).toBe(0);
  });

  test("handleCompact drains the session, pushes summary, and closes query", async () => {
    const compactSessionId = upsertSession(db, {
      contentSessionId: "worker-session-20",
      project: "/tmp/project-compact",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    const otherSessionId = upsertSession(db, {
      contentSessionId: "worker-session-21",
      project: "/tmp/project-other",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 2,
      updatedAtEpoch: 2,
      completedAtEpoch: null,
    }).id;

    db.query(
      `
        INSERT INTO pending_queue (kind, target_id, session_db_id, claimed_at_epoch, enqueued_at_epoch)
        VALUES
          ('obs', 1, ?, NULL, 1),
          ('turn-stop', 2, ?, NULL, 2),
          ('obs', 3, ?, NULL, 3)
      `,
    ).run(compactSessionId, compactSessionId, otherSessionId);

    const processed: string[] = [];
    const pushed: number[] = [];
    const closed: number[] = [];
    const sentPrompts: string[] = [];

    const core = createWorkerCore({
      db,
      processObsImpl: async (_state, observationId) => {
        processed.push(`obs:${observationId}`);
        await _state.pushMessage(`obs:${observationId}`);
      },
      processTurnStopImpl: async (_state, turnId) => {
        processed.push(`turn:${turnId}`);
        await _state.pushMessage(`turn:${turnId}`);
      },
      pushSessionSummaryPromptImpl: async (_state, sessionId) => {
        pushed.push(sessionId);
        await _state.pushMessage(`summary:${sessionId}`);
      },
      closeSessionQueryImpl: async (sessionId) => {
        closed.push(sessionId);
      },
      createWorkerQuerySessionImpl: ((_input) =>
        ({
          sessionId: "worker-query",
          queryPid: 1234,
          async sendPrompt(prompt: string) {
            sentPrompts.push(prompt);
            return {
              session_id: "worker-query",
            };
          },
          async close() {},
        }) satisfies WorkerQuerySession) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
      isProcessAliveImpl: () => false,
    });

    await core.handleCompact(compactSessionId, "/tmp/session.jsonl");

    expect(processed).toEqual(["obs:1", "turn:2"]);
    expect(pushed).toEqual([compactSessionId]);
    expect(closed).toEqual([compactSessionId]);
    expect(sentPrompts).toEqual(["obs:1", "turn:2", `summary:${compactSessionId}`]);
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM pending_queue WHERE session_db_id = ?",
        )
        .get(compactSessionId)?.count,
    ).toBe(0);
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM pending_queue WHERE session_db_id = ?",
        )
        .get(otherSessionId)?.count,
    ).toBe(1);
  });

  test("abortStalledSessions closes only sessions with an overdue in-flight request", async () => {
    const closed: number[] = [];
    const stateCore = createWorkerCore({
      db,
      nowMs: () => 40_000,
      createWorkerQuerySessionImpl: ((_input) =>
        ({
          sessionId: "worker-query",
          queryPid: 1111,
          async sendPrompt() {
            return {
              session_id: "worker-query",
            };
          },
          async close() {},
        }) satisfies WorkerQuerySession) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
      closeSessionQueryImpl: async (sessionId) => {
        closed.push(sessionId);
      },
      isProcessAliveImpl: () => false,
    });

    stateCore.sessions.set(1, {
      sessionDbId: 1,
      querySession: {
        sessionId: "one",
        queryPid: 1111,
        async sendPrompt() {
          return {
            session_id: "one",
          };
        },
        async close() {},
      },
      contentSessionId: null,
      project: null,
      initialized: false,
      priorTitles: [],
      lastPushAt: 1_000,
      lastMessageAt: 0,
      lastActivity: 0,
      processingLock: Promise.resolve(),
      pushMessage: async () => {},
    });
    stateCore.sessions.set(2, {
      sessionDbId: 2,
      querySession: {
        sessionId: "two",
        queryPid: 2222,
        async sendPrompt() {
          return {
            session_id: "two",
          };
        },
        async close() {},
      },
      contentSessionId: null,
      project: null,
      initialized: false,
      priorTitles: [],
      lastPushAt: 39_500,
      lastMessageAt: 39_000,
      lastActivity: 0,
      processingLock: Promise.resolve(),
      pushMessage: async () => {},
    });

    await stateCore.abortStalledSessions(40_000);

    expect(closed).toEqual([1]);
  });

  test("abortStalledSessions also closes idle sessions without in-flight work", async () => {
    const closed: number[] = [];
    const stateCore = createWorkerCore({
      db,
      nowMs: () => 2_000_000,
      closeSessionQueryImpl: async (sessionId) => {
        closed.push(sessionId);
      },
      isProcessAliveImpl: () => false,
    });

    stateCore.sessions.set(10, {
      sessionDbId: 10,
      querySession: {
        sessionId: "idle",
        queryPid: 1010,
        async sendPrompt() {
          return {
            session_id: "idle",
          };
        },
        async close() {},
      },
      contentSessionId: null,
      project: null,
      initialized: false,
      priorTitles: [],
      lastPushAt: 100,
      lastMessageAt: 100,
      lastActivity: 100,
      processingLock: Promise.resolve(),
      pushMessage: async () => {},
    });
    stateCore.sessions.set(11, {
      sessionDbId: 11,
      querySession: {
        sessionId: "active",
        queryPid: 1111,
        async sendPrompt() {
          return {
            session_id: "active",
          };
        },
        async close() {},
      },
      contentSessionId: null,
      project: null,
      initialized: false,
      priorTitles: [],
      lastPushAt: 1_999_500,
      lastMessageAt: 1_999_500,
      lastActivity: 1_999_500,
      processingLock: Promise.resolve(),
      pushMessage: async () => {},
    });
    stateCore.sessions.set(12, {
      sessionDbId: 12,
      querySession: {
        sessionId: "in-flight",
        queryPid: 1212,
        async sendPrompt() {
          return {
            session_id: "in-flight",
          };
        },
        async close() {},
      },
      contentSessionId: null,
      project: null,
      initialized: false,
      priorTitles: [],
      lastPushAt: 1_999_000,
      lastMessageAt: 1_998_000,
      lastActivity: 100,
      processingLock: Promise.resolve(),
      pushMessage: async () => {},
    });

    await stateCore.abortStalledSessions(2_000_000);

    expect(closed).toEqual([10]);
  });

  test("processClaimedItem keeps same-session work serialized after a timeout", async () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "worker-session-timeout",
      project: "/tmp/project-timeout",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;

    globalThis.setTimeout = ((handler: TimerHandler, _timeout?: number, ...args: unknown[]) => {
      if (typeof handler === "function") {
        handler(...args);
      }
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout;

    try {
      const core = createWorkerCore({
        db,
        processObsImpl: async (_state, observationId) => {
          started.push(observationId);
          if (observationId === 1) {
            await firstGate;
          }
        },
      });

      const first = core.processClaimedItem({
        seq: 1,
        kind: "obs",
        targetId: 1,
        sessionDbId: sessionId,
        claimedAtEpoch: 1,
        enqueuedAtEpoch: 1,
      });

      await Promise.resolve();
      await Promise.resolve();

      const second = core.processClaimedItem({
        seq: 2,
        kind: "obs",
        targetId: 2,
        sessionDbId: sessionId,
        claimedAtEpoch: 2,
        enqueuedAtEpoch: 2,
      });

      await Promise.resolve();
      await Promise.resolve();

      expect(started).toEqual([1]);

      releaseFirst();
      await Promise.all([first.catch(() => {}), second.catch(() => {})]);
      expect(started).toEqual([1, 2]);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test("main clears the starting marker and exits cleanly when Bun.serve fails with EADDRINUSE", async () => {
    const writes: Array<{ path: string; value: string }> = [];
    const unlinks: string[] = [];
    const originalExit = process.exit;
    const originalSetInterval = globalThis.setInterval;
    const exitMock = mock((_code?: number) => undefined as never);

    (process as typeof process & { exit: typeof process.exit }).exit = exitMock;
    globalThis.setInterval = mock(() => 0 as unknown as NodeJS.Timeout) as typeof setInterval;

    try {
      await main({
        db: createDatabase(":memory:"),
        BunServeImpl: mock(() => {
          const error = new Error("bind failed") as NodeJS.ErrnoException;
          error.code = "EADDRINUSE";
          throw error;
        }) as typeof Bun.serve,
        pidPath: "/tmp/worker.pid",
        startingPath: "/tmp/worker.starting",
        existsSyncImpl: (path: string) =>
          path !== "/tmp/worker.pid" && path !== "/tmp/worker.starting",
        mkdirSyncImpl: (() => undefined) as typeof import("node:fs").mkdirSync,
        writeFileSyncImpl: ((path: string, value: string) => {
          writes.push({ path, value });
        }) as typeof import("node:fs").writeFileSync,
        unlinkSyncImpl: ((path: string) => {
          unlinks.push(path);
        }) as typeof import("node:fs").unlinkSync,
      });

      expect(exitMock).toHaveBeenCalledWith(0);
      expect(writes).toEqual([{ path: "/tmp/worker.starting", value: String(process.pid) }]);
      expect(unlinks).toContain("/tmp/worker.starting");
      expect(unlinks).not.toContain("/tmp/worker.pid");
    } finally {
      (process as typeof process & { exit: typeof process.exit }).exit = originalExit;
      globalThis.setInterval = originalSetInterval;
    }
  });
});
