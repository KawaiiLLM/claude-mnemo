import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { createObservation } from "../../src/db/observations";
import { initializeSchema } from "../../src/db/schema";
import {
  getSession,
  updateLastAgentSessionId,
  upsertSession,
} from "../../src/db/sessions";
import { createWorkerProcessors } from "../../src/worker/processors";
import {
  checkForIdleWorkerShutdown,
  acquireWorkerSingleton,
  createWorkerCore,
  createWorkerFetchHandler,
  createWorkerServerState,
  main,
} from "../../src/worker/server";
import type { WorkerQuerySession } from "../../src/worker/query-session";

function createTurn(
  db: Database,
  sessionId: number,
  promptNumber: number,
  userPrompt = `Turn ${promptNumber}`,
  assistantResponse = `Reply ${promptNumber}`,
): number {
  return db
    .query<{ id: number }, [number, number, string, string]>(
      `
        INSERT INTO turns (
          session_id,
          prompt_number,
          status,
          user_prompt,
          assistant_response,
          created_at_epoch
        ) VALUES (?, ?, 'active', ?, ?, 100)
        RETURNING id
      `,
    )
    .get(sessionId, promptNumber, userPrompt, assistantResponse)!.id;
}

function queueObs(
  db: Database,
  sessionId: number,
  turnId: number,
  createdAtEpoch: number,
  label: string,
): number {
  const observationId = createObservation(db, {
    turnId,
    toolName: "Read",
    toolInput: `{"file_path":"src/${label}.ts"}`,
    toolResult: `${label} result`,
    status: "pending",
    createdAtEpoch,
  }).id;

  db.query(
    `
      INSERT INTO pending_queue (kind, target_id, session_db_id, claimed_at_epoch, enqueued_at_epoch)
      VALUES ('obs', ?, ?, NULL, ?)
    `,
  ).run(observationId, sessionId, createdAtEpoch);

  return observationId;
}

function queueTurnStop(
  db: Database,
  sessionId: number,
  turnId: number,
  enqueuedAtEpoch: number,
): void {
  db.query(
    `
      INSERT INTO pending_queue (kind, target_id, session_db_id, claimed_at_epoch, enqueued_at_epoch)
      VALUES ('turn-stop', ?, ?, NULL, ?)
    `,
  ).run(turnId, sessionId, enqueuedAtEpoch);
}

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

  test("createWorkerFetchHandler health response includes the worker pid", async () => {
    const handler = createWorkerFetchHandler({});

    const response = await handler(new Request("http://127.0.0.1:37778/health"));
    const body = (await response.json()) as { ok: boolean; buildId: string; pid: number };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.buildId).toBe("string");
    expect(body.pid).toBe(process.pid);
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

  test("createWorkerFetchHandler returns before async compact completes", async () => {
    let resolveCompact: (() => void) | null = null;
    const serverState = createWorkerServerState(100);
    const handleCompactImpl = mock(
      () =>
        new Promise<void>((resolve) => {
          resolveCompact = resolve;
        }),
    );
    const handler = createWorkerFetchHandler(
      {
        nowMs: () => 100,
        handleCompactImpl,
      },
      serverState,
    );

    const response = await handler(
      new Request("http://127.0.0.1:37778/compact", {
        method: "POST",
        body: JSON.stringify({ session_id: 7 }),
      }),
    );

    expect(response.status).toBe(200);
    expect(handleCompactImpl).toHaveBeenCalledWith(7, undefined);
    expect(serverState.lastHttpRequestAt).toBe(100);
    expect(serverState.activeRequests).toBe(0);

    resolveCompact?.();
  });

  test("createWorkerFetchHandler leaves a compacting session excluded from concurrent scans after /compact returns", async () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "worker-session-compact-skip",
      project: "/tmp/project-compact-skip",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    const compactTurnId = createTurn(db, sessionId, 1);
    queueObs(db, sessionId, compactTurnId, 101, "compact-inflight");
    queueTurnStop(db, sessionId, compactTurnId, 102);

    let releaseCompactBatch!: () => void;
    const compactBatchStarted = new Promise<void>((resolve) => {
      releaseCompactBatch = resolve;
    });
    let compactPromise: Promise<void> | null = null;

    const core = createWorkerCore({
      db,
      now: () => 123,
      processObsImpl: async (state, observationId) => {
        await state.pushMessage(`obs:${observationId}`);
      },
      processTurnStopImpl: async (state, queuedTurnId) => {
        await state.pushMessage(`turn:${queuedTurnId}`);
      },
      processBatchImpl: async () => {
        await compactBatchStarted;
      },
      pushSessionSummaryPromptImpl: async () => {},
      closeSessionQueryImpl: async () => {},
      createWorkerQuerySessionImpl: ((_input) =>
        ({
          sessionId: "worker-query",
          queryPid: 1234,
          async sendPrompt(_prompt: string) {
            return { session_id: "worker-query" };
          },
          async close() {},
        }) satisfies WorkerQuerySession) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
      isProcessAliveImpl: () => false,
    });

    const handler = createWorkerFetchHandler({
      scanAndDrainQueue: core.scanAndDrainQueue,
      handleCompactImpl: (queuedSessionId, transcriptPath) => {
        compactPromise = core.handleCompact(queuedSessionId, transcriptPath);
        return compactPromise;
      },
    });

    const response = await handler(
      new Request("http://127.0.0.1:37778/compact", {
        method: "POST",
        body: JSON.stringify({ session_id: sessionId }),
      }),
    );

    expect(response.status).toBe(200);

    await Promise.resolve();
    expect((core as { compactingSessions: Set<number> }).compactingSessions.has(sessionId)).toBe(
      true,
    );

    const skippedTurnId = createTurn(db, sessionId, 2);
    const skippedObservationId = queueObs(db, sessionId, skippedTurnId, 103, "skip-me");

    await core.scanAndDrainQueue();

    expect(
      db
        .query<{ claimed_at_epoch: number | null }, [number]>(
          "SELECT claimed_at_epoch FROM pending_queue WHERE kind = 'obs' AND target_id = ?",
        )
        .get(skippedObservationId)?.claimed_at_epoch,
    ).toBeNull();

    releaseCompactBatch();
    await compactPromise;
  });

  test("createWorkerFetchHandler swallows background compact failures after returning 200", async () => {
    const logger = { error: mock(() => {}) };
    const handler = createWorkerFetchHandler({
      handleCompactImpl: mock(async () => {
        throw new Error("compact failed");
      }),
      logger,
    });

    const response = await handler(
      new Request("http://127.0.0.1:37778/compact", {
        method: "POST",
        body: JSON.stringify({ session_id: 7 }),
      }),
    );

    expect(response.status).toBe(200);

    await Promise.resolve();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  test("createWorkerFetchHandler validates flush requests and returns before async flush completes", async () => {
    let resolveFlush: (() => void) | null = null;
    const handleFlushImpl = mock(
      () =>
        new Promise<void>((resolve) => {
          resolveFlush = resolve;
        }),
    );
    const handler = createWorkerFetchHandler({
      handleFlushImpl,
    });

    const missingSession = await handler(
      new Request("http://127.0.0.1:37778/flush", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(missingSession.status).toBe(400);

    const response = await handler(
      new Request("http://127.0.0.1:37778/flush", {
        method: "POST",
        body: JSON.stringify({ session_id: 7 }),
      }),
    );

    expect(response.status).toBe(200);
    expect(handleFlushImpl).toHaveBeenCalledWith(7);

    resolveFlush?.();
  });

  test("createWorkerFetchHandler tracks HTTP activity timestamps for compact requests", async () => {
    const serverState = createWorkerServerState(100);
    const handler = createWorkerFetchHandler(
      {
        nowMs: () => 100,
        handleCompactImpl: mock(async () => {}),
      },
      serverState,
    );

    const response = await handler(
      new Request("http://127.0.0.1:37778/compact", {
        method: "POST",
        body: JSON.stringify({ session_id: 7 }),
      }),
    );

    expect(serverState.lastHttpRequestAt).toBe(100);
    expect(response.status).toBe(200);
    expect(serverState.activeRequests).toBe(0);
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

  test("createWorkerCore recoverFromCrash resets claimed queue rows", () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "worker-session-recover",
      project: "/tmp/project-recover",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;

    const turnId = createTurn(db, sessionId, 1);
    const observationId = createObservation(db, {
      turnId,
      toolName: "Read",
      toolInput: '{"file_path":"src/recover.ts"}',
      toolResult: "recover result",
      status: "pending",
      createdAtEpoch: 101,
    }).id;

    db.query(
      `
        INSERT INTO pending_queue (kind, target_id, session_db_id, claimed_at_epoch, enqueued_at_epoch)
        VALUES ('obs', ?, ?, 999, 101)
      `,
    ).run(observationId, sessionId);

    const core = createWorkerCore({ db, now: () => 123 });

    core.recoverFromCrash();

    expect(
      db
        .query<{ claimed_at_epoch: number | null }, []>(
          "SELECT claimed_at_epoch FROM pending_queue",
        )
        .get()?.claimed_at_epoch,
    ).toBeNull();
  });

  test("scanAndDrainQueue buffers observation claims without prompting until a turn-stop arrives", async () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "worker-session-buffer-only",
      project: "/tmp/project-buffer-only",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    const turnId = createTurn(db, sessionId, 1);
    queueObs(db, sessionId, turnId, 101, "one");
    queueObs(db, sessionId, turnId, 102, "two");

    const processors = createWorkerProcessors(db);
    const sentPrompts: string[] = [];
    const core = createWorkerCore({
      db,
      now: () => 123,
      processObsImpl: processors.processObs,
      processTurnStopImpl: processors.processTurnStop,
      createWorkerQuerySessionImpl: ((_input) =>
        ({
          sessionId: "worker-query",
          queryPid: 1234,
          async sendPrompt(prompt: string) {
            sentPrompts.push(prompt);
            return { session_id: "worker-query" };
          },
          async close() {},
        }) satisfies WorkerQuerySession) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
    });

    await core.scanAndDrainQueue();

    expect(sentPrompts).toEqual([]);
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM pending_queue").get()
        ?.count,
    ).toBe(2);
    expect(
      db
        .query<{ claimed_at_epoch: number | null }, []>(
          "SELECT claimed_at_epoch FROM pending_queue ORDER BY seq ASC LIMIT 1",
        )
        .get()?.claimed_at_epoch,
    ).toBe(123);
    expect(
      ((core as unknown as {
        buffers?: Map<number, { items: Array<{ targetId: number }> }>;
      }).buffers?.get(sessionId)?.items ?? []).map((item) => item.targetId),
    ).toHaveLength(2);
  });

  test("scanAndDrainQueue flushes buffered observations and turn-stop as one batch prompt", async () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "worker-session-batch",
      project: "/tmp/project-batch",
      title: "Prior title",
      content: "Prior content",
      insight: "- prior insight",
      nextSteps: "Keep going",
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    const turnId = createTurn(db, sessionId, 1, "Diagnose batch flush", "Combined reply");
    const firstObsId = queueObs(db, sessionId, turnId, 101, "batch-one");
    const secondObsId = queueObs(db, sessionId, turnId, 102, "batch-two");
    queueTurnStop(db, sessionId, turnId, 103);

    const sentPrompts: string[] = [];
    const batchCalls: Array<{
      itemIds: number[];
      turnStopTargetId: number | null;
    }> = [];
    const core = createWorkerCore({
      db,
      now: () => 123,
      processObsImpl: async (state, observationId) => {
        await state.pushMessage(`obs:${observationId}`);
      },
      processTurnStopImpl: async (state, queuedTurnId) => {
        await state.pushMessage(`turn:${queuedTurnId}`);
      },
      createWorkerQuerySessionImpl: ((_input) =>
        ({
          sessionId: "worker-query",
          queryPid: 1234,
          async sendPrompt(prompt: string) {
            sentPrompts.push(prompt);
            return { session_id: "worker-query" };
          },
          async close() {},
        }) satisfies WorkerQuerySession) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
      ...( {
        processBatchImpl: async (
          state: { pushMessage(prompt: string): Promise<void> },
          items: Array<{ targetId: number }>,
          turnStopItem?: { targetId: number },
        ) => {
          batchCalls.push({
            itemIds: items.map((item) => item.targetId),
            turnStopTargetId: turnStopItem?.targetId ?? null,
          });
          await state.pushMessage(
            `<batch><obs id="O${items[0]?.targetId}"/><obs id="O${items[1]?.targetId}"/><turn id="T${turnStopItem?.targetId ?? 0}"/></batch>`,
          );
        },
      } as Record<string, unknown>),
    } as Parameters<typeof createWorkerCore>[0]);

    await core.scanAndDrainQueue();

    expect(batchCalls).toEqual([
      {
        itemIds: [firstObsId, secondObsId],
        turnStopTargetId: turnId,
      },
    ]);
    expect(sentPrompts).toHaveLength(1);
    expect(sentPrompts[0]).toContain("<batch>");
    expect(sentPrompts[0]).toContain(`<obs id="O${firstObsId}"`);
    expect(sentPrompts[0]).toContain(`<obs id="O${secondObsId}"`);
    expect(sentPrompts[0]).toContain(`<turn id="T${turnId}"`);
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM pending_queue").get()
        ?.count,
    ).toBe(0);
  });

  test("scanAndDrainQueue releases buffered observation claims when batch flush fails", async () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "worker-session-fail",
      project: "/tmp/project-fail",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    const turnId = createTurn(db, sessionId, 1);
    queueObs(db, sessionId, turnId, 101, "fail-one");
    queueObs(db, sessionId, turnId, 102, "fail-two");
    queueTurnStop(db, sessionId, turnId, 103);

    const logger = {
      warn: mock(() => {}),
      error: mock(() => {}),
    };
    const sentPrompts: string[] = [];
    const core = createWorkerCore({
      db,
      now: () => 123,
      logger,
      processObsImpl: async (state, observationId) => {
        await state.pushMessage(`obs:${observationId}`);
      },
      processTurnStopImpl: async (state, queuedTurnId) => {
        await state.pushMessage(`turn:${queuedTurnId}`);
      },
      createWorkerQuerySessionImpl: ((_input) =>
        ({
          sessionId: "worker-query",
          queryPid: 1234,
          async sendPrompt(prompt: string) {
            sentPrompts.push(prompt);
            return { session_id: "worker-query" };
          },
          async close() {},
        }) satisfies WorkerQuerySession) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
      ...( {
        processBatchImpl: async () => {
          throw new Error("batch failed");
        },
      } as Record<string, unknown>),
    } as Parameters<typeof createWorkerCore>[0]);

    await core.scanAndDrainQueue();

    expect(
      db
        .query<{ claimed_at_epoch: number | null }, []>(
          "SELECT claimed_at_epoch FROM pending_queue ORDER BY seq ASC LIMIT 3",
        )
        .all()
        .map((row) => row.claimed_at_epoch),
    ).toEqual([null, null, null]);
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM pending_queue").get()
        ?.count,
    ).toBe(3);
    expect(
      ((core as unknown as {
        buffers?: Map<number, { items: Array<{ targetId: number }> }>;
      }).buffers?.get(sessionId)?.items ?? []).map((item) => item.targetId),
    ).toEqual([]);
    expect(logger.error).toHaveBeenCalled();
  });

  test("drainSessionCompletely flushes an already-buffered session before continuing compact drain", async () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "worker-session-compact-buffer",
      project: "/tmp/project-compact-buffer",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    const turnId = createTurn(db, sessionId, 1);
    const observationId = queueObs(db, sessionId, turnId, 101, "compact-buffer");

    const batchCalls: number[][] = [];
    const sentPrompts: string[] = [];
    const core = createWorkerCore({
      db,
      now: () => 123,
      processObsImpl: async (state, queuedObservationId) => {
        await state.pushMessage(`obs:${queuedObservationId}`);
      },
      createWorkerQuerySessionImpl: ((_input) =>
        ({
          sessionId: "worker-query",
          queryPid: 1234,
          async sendPrompt(prompt: string) {
            sentPrompts.push(prompt);
            return { session_id: "worker-query" };
          },
          async close() {},
        }) satisfies WorkerQuerySession) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
      ...( {
        processBatchImpl: async (
          state: { pushMessage(prompt: string): Promise<void> },
          items: Array<{ targetId: number }>,
        ) => {
          batchCalls.push(items.map((item) => item.targetId));
          await state.pushMessage(`batch:${items.map((item) => item.targetId).join(",")}`);
        },
      } as Record<string, unknown>),
    } as Parameters<typeof createWorkerCore>[0]);

    await core.scanAndDrainQueue();
    await core.drainSessionCompletely(sessionId);

    expect(batchCalls).toEqual([[observationId]]);
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM pending_queue").get()
        ?.count,
    ).toBe(0);
    expect(
      ((core as unknown as {
        buffers?: Map<number, { items: Array<{ targetId: number }> }>;
      }).buffers?.get(sessionId)?.items ?? []).map((item) => item.targetId),
    ).toEqual([]);
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

    const compactTurnId = createTurn(db, compactSessionId, 1);
    const compactObservationId = queueObs(db, compactSessionId, compactTurnId, 1, "compact");
    queueTurnStop(db, compactSessionId, compactTurnId, 2);

    const otherTurnId = createTurn(db, otherSessionId, 1);
    queueObs(db, otherSessionId, otherTurnId, 3, "other");

    const processed: string[] = [];
    const pushed: number[] = [];
    const closed: number[] = [];
    const sentPrompts: string[] = [];

    const core = createWorkerCore({
      db,
      processBatchImpl: async (_state, items, turnStopItem) => {
        processed.push(
          `batch:${items.map((item) => item.targetId).join(",")}:${turnStopItem?.targetId ?? "none"}`,
        );
        await _state.pushMessage(
          `batch:${items.map((item) => item.targetId).join(",")}:${turnStopItem?.targetId ?? "none"}`,
        );
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

    expect(processed).toEqual([`batch:${compactObservationId}:${compactTurnId}`]);
    expect(pushed).toEqual([compactSessionId]);
    expect(closed).toEqual([compactSessionId]);
    expect(sentPrompts).toEqual([
      `batch:${compactObservationId}:${compactTurnId}`,
      `summary:${compactSessionId}`,
    ]);
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

  test("handleCompact advances last_compact_turn to the latest finalized turn", async () => {
    const compactSessionId = upsertSession(db, {
      contentSessionId: "worker-session-compact-anchor",
      project: "/tmp/project-anchor",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;

    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES
        (?, 1, 'extracted', 'first',  110),
        (?, 2, 'undone',    'second', 120),
        (?, 3, 'active',    'third',  130)`,
    ).run(compactSessionId, compactSessionId, compactSessionId);

    const core = createWorkerCore({
      db,
      processObsImpl: async () => {},
      processTurnStopImpl: async () => {},
      pushSessionSummaryPromptImpl: async () => {},
      closeSessionQueryImpl: async () => {},
      createWorkerQuerySessionImpl: ((_input) =>
        ({
          sessionId: "worker-query",
          queryPid: 1234,
          async sendPrompt(_prompt: string) {
            return { session_id: "worker-query" };
          },
          async close() {},
        }) satisfies WorkerQuerySession) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
      isProcessAliveImpl: () => false,
    });

    const before = db
      .query<{ last_compact_turn: number | null }, [number]>(
        "SELECT last_compact_turn FROM sessions WHERE id = ?",
      )
      .get(compactSessionId);
    expect(before?.last_compact_turn).toBeNull();

    await core.handleCompact(compactSessionId, null);

    const after = db
      .query<{ last_compact_turn: number | null }, [number]>(
        "SELECT last_compact_turn FROM sessions WHERE id = ?",
      )
      .get(compactSessionId);
    expect(after?.last_compact_turn).toBe(2);
  });

  test("handleCompact updates last_compact_turn before drain can insert a compact turn", async () => {
    const compactSessionId = upsertSession(db, {
      contentSessionId: "worker-session-compact-race",
      project: "/tmp/project-race",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;

    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES
        (?, 1, 'extracted', 'first', 110),
        (?, 2, 'undone', 'second', 120),
        (?, 3, 'active', 'third', 130)`,
    ).run(compactSessionId, compactSessionId, compactSessionId);

    const activeTurnId = getSession(db, compactSessionId) ? createTurn(db, compactSessionId, 4) : 0;
    queueObs(db, compactSessionId, activeTurnId, 140, "compact-race");

    const core = createWorkerCore({
      db,
      processObsImpl: async () => {},
      processTurnStopImpl: async () => {},
      processBatchImpl: async () => {
        db.query(
          `INSERT INTO turns (
            session_id,
            prompt_number,
            status,
            user_prompt,
            title,
            type,
            created_at_epoch
          ) VALUES (?, 99, 'extracted', '/compact', '/compact', 'compact', 150)`,
        ).run(compactSessionId);
      },
      pushSessionSummaryPromptImpl: async () => {},
      closeSessionQueryImpl: async () => {},
      createWorkerQuerySessionImpl: ((_input) =>
        ({
          sessionId: "worker-query",
          queryPid: 1234,
          async sendPrompt(_prompt: string) {
            return { session_id: "worker-query" };
          },
          async close() {},
        }) satisfies WorkerQuerySession) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
      isProcessAliveImpl: () => false,
    });

    await core.handleCompact(compactSessionId, null);

    const after = db
      .query<{ last_compact_turn: number | null }, [number]>(
        "SELECT last_compact_turn FROM sessions WHERE id = ?",
      )
      .get(compactSessionId);
    expect(after?.last_compact_turn).toBe(2);
  });

  test("handleCompact leaves last_compact_turn NULL when no turns have been finalized", async () => {
    const freshSessionId = upsertSession(db, {
      contentSessionId: "worker-session-fresh-anchor",
      project: "/tmp/project-fresh",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;

    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, 1, 'active', 'only', 110)`,
    ).run(freshSessionId);

    const core = createWorkerCore({
      db,
      processObsImpl: async () => {},
      processTurnStopImpl: async () => {},
      pushSessionSummaryPromptImpl: async () => {},
      closeSessionQueryImpl: async () => {},
      createWorkerQuerySessionImpl: ((_input) =>
        ({
          sessionId: "worker-query",
          queryPid: 1234,
          async sendPrompt(_prompt: string) {
            return { session_id: "worker-query" };
          },
          async close() {},
        }) satisfies WorkerQuerySession) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
      isProcessAliveImpl: () => false,
    });

    await core.handleCompact(freshSessionId, null);

    const after = db
      .query<{ last_compact_turn: number | null }, [number]>(
        "SELECT last_compact_turn FROM sessions WHERE id = ?",
      )
      .get(freshSessionId);
    expect(after?.last_compact_turn).toBeNull();
  });

  test("createWorkerCore passes through the persisted agent session id and rewrites it when the SDK reports a new id", async () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "worker-session-resume",
      project: "/tmp/project-resume",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    updateLastAgentSessionId(db, sessionId, "persisted-agent-session");

    const createWorkerQuerySessionCalls: unknown[][] = [];
    const core = createWorkerCore({
      db,
      processObsImpl: async (state, observationId) => {
        await state.pushMessage(`obs:${observationId}`);
      },
      createWorkerQuerySessionImpl: ((...args: unknown[]) => {
        createWorkerQuerySessionCalls.push(args);
        const deps =
          (args.length === 2 ? args[1] : args[3]) as
            | {
                onMessage?: (message: { session_id?: string }) => void;
              }
            | undefined;

        return {
          sessionId: "fresh-agent-session",
          queryPid: 1234,
          async sendPrompt() {
            deps?.onMessage?.({ session_id: "fresh-agent-session" });
            return {
              session_id: "fresh-agent-session",
            };
          },
          async close() {},
        } satisfies WorkerQuerySession;
      }) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
      isProcessAliveImpl: () => false,
    });

    await core.processClaimedItem({
      seq: 1,
      kind: "obs",
      targetId: 1,
      sessionDbId: sessionId,
      claimedAtEpoch: 1,
      enqueuedAtEpoch: 1,
    });

    expect(createWorkerQuerySessionCalls).toHaveLength(1);
    expect(createWorkerQuerySessionCalls[0]?.[0]).toMatchObject({
      db,
      sessionDbId: sessionId,
      contentSessionId: "worker-session-resume",
      project: "/tmp/project-resume",
      resumeAgentSessionId: "persisted-agent-session",
    });
    expect(getSession(db, sessionId)?.lastAgentSessionId).toBe(
      "fresh-agent-session",
    );
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

  test("main wires /flush to core.flushSession so SessionEnd flushes buffered observations", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);

    const sessionId = upsertSession(db, {
      contentSessionId: "worker-session-flush",
      project: "/tmp/project-flush",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    const turnId = createTurn(db, sessionId, 1);
    queueObs(db, sessionId, turnId, 101, "flush-me");

    let fetchHandler: ((req: Request) => Promise<Response>) | null = null;
    const processBatchImpl = mock(async () => {});
    const originalSetInterval = globalThis.setInterval;

    globalThis.setInterval = mock(() => 0 as unknown as NodeJS.Timeout) as typeof setInterval;

    try {
      await main({
        db,
        BunServeImpl: mock(((options: { fetch: (req: Request) => Promise<Response> }) => {
          fetchHandler = options.fetch;
          return { stop() {} };
        }) as typeof Bun.serve),
        processBatchImpl,
        existsSyncImpl: () => false,
        mkdirSyncImpl: (() => undefined) as typeof import("node:fs").mkdirSync,
        writeFileSyncImpl: (() => undefined) as typeof import("node:fs").writeFileSync,
        unlinkSyncImpl: (() => undefined) as typeof import("node:fs").unlinkSync,
      });

      expect(fetchHandler).not.toBeNull();

      const response = await fetchHandler!(
        new Request("http://127.0.0.1:37778/flush", {
          method: "POST",
          body: JSON.stringify({ session_id: sessionId }),
        }),
      );

      expect(response.status).toBe(200);

      await Promise.resolve();
      await Promise.resolve();

      expect(processBatchImpl).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.setInterval = originalSetInterval;
    }
  });
});
