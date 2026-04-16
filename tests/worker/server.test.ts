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

function primeSessionState(
  core: ReturnType<typeof createWorkerCore>,
  sessionId: number,
  overrides: Partial<{
    batchQueue: Array<{
      turns: Array<{
        turnId: number;
        promptNumber: number;
        prompt: string | null;
        response: string | null;
        obsBlocks: string[];
        filesRead: string[];
        filesModified: string[];
        toolCallCount: number;
        size: number;
        obsItems: Array<{ seq: number; kind: "obs"; targetId: number; sessionDbId: number; claimedAtEpoch: number | null; enqueuedAtEpoch: number }>;
        turnStopItem: { seq: number; kind: "turn-stop"; targetId: number; sessionDbId: number; claimedAtEpoch: number | null; enqueuedAtEpoch: number };
      }>;
      size: number;
      sessionUpdated: boolean;
      oldestTurnEpoch: number;
    }>;
    cacheTtlMs: number;
    nextBatchNeedsSessionContext: boolean;
    lastInjectedSummaryEpoch: number;
    lastPushAt: number;
    lastMessageAt: number;
    lastActivity: number;
  }> = {},
): void {
  const existing = core.sessions.get(sessionId);
  core.sessions.set(sessionId, {
    sessionDbId: sessionId,
    querySession: existing?.querySession ?? null,
    contentSessionId: existing?.contentSessionId ?? null,
    project: existing?.project ?? null,
    batchQueue: overrides.batchQueue ?? existing?.batchQueue ?? [],
    cacheTtlMs: overrides.cacheTtlMs ?? existing?.cacheTtlMs ?? 300_000,
    nextBatchNeedsSessionContext:
      overrides.nextBatchNeedsSessionContext ??
      existing?.nextBatchNeedsSessionContext ??
      false,
    lastInjectedSummaryEpoch:
      overrides.lastInjectedSummaryEpoch ?? existing?.lastInjectedSummaryEpoch ?? 0,
    lastPushAt: overrides.lastPushAt ?? 0,
    lastMessageAt: overrides.lastMessageAt ?? 0,
    lastActivity: overrides.lastActivity ?? 0,
    processingLock: existing?.processingLock ?? Promise.resolve(),
    pushMessage: existing?.pushMessage ?? (async () => {}),
  });
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

  test("scanAndDrainQueue flushes the oldest completed batch when queue overflow exceeds the cap", async () => {
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
    const turnIds = [
      createTurn(db, sessionId, 1, "Turn 1", "Reply 1"),
      createTurn(db, sessionId, 2, "Turn 2", "Reply 2"),
      createTurn(db, sessionId, 3, "Turn 3", "Reply 3"),
      createTurn(db, sessionId, 4, "Turn 4", "Reply 4"),
    ];
    const observationIds = turnIds.map((turnId, index) =>
      queueObs(db, sessionId, turnId, 101 + index, `batch-${index + 1}`),
    );
    turnIds.forEach((turnId, index) => {
      queueTurnStop(db, sessionId, turnId, 201 + index);
    });

    const sentPrompts: string[] = [];
    const batchCalls: Array<{
      itemIds: number[];
      turnStopTargetIds: number[];
    }> = [];
    const core = createWorkerCore({
      db,
      config: {
        mergeThresholdChars: 1,
        maxQueuedBatches: 3,
        keepaliveLeadMs: 60_000,
        cacheMode: "auto",
      },
      now: () => 123,
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
          options?: { turnStopItems?: Array<{ targetId: number }> },
        ) => {
          batchCalls.push({
            itemIds: items.map((item) => item.targetId),
            turnStopTargetIds: (options?.turnStopItems ?? []).map(
              (item) => item.targetId,
            ),
          });
          await state.pushMessage(
            `<batch>${items.map((item) => `<obs id="O${item.targetId}"/>`).join("")}</batch>`,
          );
        },
      } as Record<string, unknown>),
    } as Parameters<typeof createWorkerCore>[0]);

    await core.scanAndDrainQueue();

    expect(batchCalls).toEqual([
      {
        itemIds: [observationIds[0]!],
        turnStopTargetIds: [turnIds[0]!],
      },
    ]);
    expect(sentPrompts).toHaveLength(1);
    expect(sentPrompts[0]).toContain("<batch>");
    expect(sentPrompts[0]).toContain(`<obs id="O${observationIds[0]}"`);
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM pending_queue").get()
        ?.count,
    ).toBe(6);
    expect(
      core.sessions
        .get(sessionId)
        ?.batchQueue.map((batch) => batch.turns.map((turn) => turn.turnId)),
    ).toEqual([[turnIds[1]!], [turnIds[2]!], [turnIds[3]!]]);
    expect(core.buffers.get(sessionId)?.items ?? []).toEqual([]);
  });

  test("flushSession uses the highest prompt_number in a merged batch as current_prompt", async () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "worker-session-merged-prompt",
      project: "/tmp/project-merged-prompt",
      title: "Merged title",
      content: "Prior content",
      insight: "- prior insight",
      nextSteps: "Keep going",
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    const turnIds = [
      createTurn(db, sessionId, 1, "Earlier prompt", "Reply 1"),
      createTurn(db, sessionId, 2, "Latest prompt", "Reply 2"),
    ];
    turnIds.forEach((turnId, index) => {
      queueObs(db, sessionId, turnId, 101 + index, `merged-${index + 1}`);
      queueTurnStop(db, sessionId, turnId, 201 + index);
    });

    const sentPrompts: string[] = [];
    const processors = createWorkerProcessors(db);
    const core = createWorkerCore({
      db,
      config: {
        mergeThresholdChars: 10_000,
        maxQueuedBatches: 3,
        keepaliveLeadMs: 60_000,
        cacheMode: "auto",
      },
      now: () => 123,
      buildTurnPayloadImpl: processors.buildTurnPayload,
      processBatchImpl: processors.processBatch,
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
    await core.flushSession(sessionId);

    expect(sentPrompts).toHaveLength(1);
    expect(sentPrompts[0]).toContain("title: Merged title");
    expect(sentPrompts[0]).toContain("current_prompt: Latest prompt");
    expect(sentPrompts[0]).not.toContain("current_prompt: Earlier prompt");
    expect(sentPrompts[0]).not.toContain("user_request:");
  });

  test("scanAndDrainQueue releases only the overflow batch claims when overflow flush fails", async () => {
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
    const turnIds = [
      createTurn(db, sessionId, 1),
      createTurn(db, sessionId, 2),
      createTurn(db, sessionId, 3),
      createTurn(db, sessionId, 4),
    ];
    const observationIds = turnIds.map((turnId, index) =>
      queueObs(db, sessionId, turnId, 101 + index, `fail-${index + 1}`),
    );
    turnIds.forEach((turnId, index) => {
      queueTurnStop(db, sessionId, turnId, 201 + index);
    });

    const logger = {
      warn: mock(() => {}),
      error: mock(() => {}),
    };
    const sentPrompts: string[] = [];
    const core = createWorkerCore({
      db,
      config: {
        mergeThresholdChars: 1,
        maxQueuedBatches: 3,
        keepaliveLeadMs: 60_000,
        cacheMode: "auto",
      },
      now: () => 123,
      logger,
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
          "SELECT claimed_at_epoch FROM pending_queue ORDER BY seq ASC",
        )
        .all()
        .map((row) => row.claimed_at_epoch),
    ).toEqual([123, 123, 123, null, 123, 123, 123, null]);
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM pending_queue").get()
        ?.count,
    ).toBe(8);
    expect(
      core.sessions
        .get(sessionId)
        ?.batchQueue.map((batch) => batch.turns.map((turn) => turn.turnId)),
    ).toEqual([[turnIds[0]!], [turnIds[1]!], [turnIds[2]!]]);
    expect(
      (core.buffers.get(sessionId)?.items ?? []).map((item) => item.targetId),
    ).toEqual([observationIds[3]!]);
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
    queueTurnStop(db, sessionId, turnId, 201);

    const batchCalls: number[][] = [];
    const sentPrompts: string[] = [];
    const core = createWorkerCore({
      db,
      now: () => 123,
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
      core.sessions.get(sessionId)?.batchQueue,
    ).toEqual([]);
  });

  test("runKeepaliveTick sends one reserve turn after four minutes in warm state", async () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "worker-session-keepalive-reserve",
      project: "/tmp/project-keepalive-reserve",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;

    const turnIds = [1, 2, 3].map((promptNumber) =>
      createTurn(db, sessionId, promptNumber, `Turn ${promptNumber}`, `Reply ${promptNumber}`),
    );
    const observationIds = turnIds.map((turnId, index) =>
      queueObs(db, sessionId, turnId, 100 + index, `reserve-${index + 1}`),
    );
    turnIds.forEach((turnId, index) => {
      queueTurnStop(db, sessionId, turnId, 200 + index);
    });

    const keepaliveCalls: Array<{
      itemIds: number[];
      turnStopTargetIds: number[];
    }> = [];
    const core = createWorkerCore({
      db,
      config: {
        mergeThresholdChars: 1,
        maxQueuedBatches: 5,
        keepaliveLeadMs: 60_000,
        cacheMode: "auto",
      },
      processBatchImpl: async (_state, items, options) => {
        keepaliveCalls.push({
          itemIds: items.map((item) => item.targetId),
          turnStopTargetIds: (options?.turnStopItems ?? []).map((item) => item.targetId),
        });
      },
    });

    await core.scanAndDrainQueue();
    primeSessionState(core, sessionId, {
      lastPushAt: 1_000_000,
      lastMessageAt: 1_000_000,
      lastActivity: 1_000_000,
    });

    await core.runKeepaliveTick(1_240_000);

    expect(keepaliveCalls).toEqual([
      {
        itemIds: [observationIds[0]!],
        turnStopTargetIds: [turnIds[0]!],
      },
    ]);
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM pending_queue").get()
        ?.count,
    ).toBe(4);
    expect(
      core.sessions
        .get(sessionId)
        ?.batchQueue.map((batch) => batch.turns.map((turn) => turn.turnId)),
    ).toEqual([[turnIds[1]!], [turnIds[2]!]]);
  });

  test("runKeepaliveTick does not push standalone in-progress observations", async () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "worker-session-keepalive-partial",
      project: "/tmp/project-keepalive-partial",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    const turnId = createTurn(db, sessionId, 1, "Long task", "Still working");
    const observationIds = Array.from({ length: 6 }, (_, index) =>
      queueObs(db, sessionId, turnId, 100 + index, `partial-${index + 1}`),
    );

    const partialCalls: Array<{
      itemIds: number[];
      turnStopTargetIds: number[];
    }> = [];
    const core = createWorkerCore({
      db,
      processBatchImpl: async (_state, items, options) => {
        partialCalls.push({
          itemIds: items.map((item) => item.targetId),
          turnStopTargetIds: (options?.turnStopItems ?? []).map((item) => item.targetId),
        });
      },
    });

    await core.scanAndDrainQueue();
    primeSessionState(core, sessionId, {
      lastPushAt: 2_000_000,
      lastMessageAt: 2_000_000,
      lastActivity: 2_000_000,
    });

    await core.runKeepaliveTick(2_240_000);

    expect(partialCalls).toEqual([]);
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM pending_queue").get()
        ?.count,
    ).toBe(6);
    expect(core.buffers.get(sessionId)?.items).toHaveLength(6);
  });

  test("runKeepaliveTick does nothing for cold sessions without an established cache", async () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "worker-session-keepalive-cold",
      project: "/tmp/project-keepalive-cold",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    const turnId = createTurn(db, sessionId, 1, "Cold turn", "Cold reply");
    queueObs(db, sessionId, turnId, 100, "cold-1");
    queueTurnStop(db, sessionId, turnId, 200);

    const processBatchImpl = mock(async () => {});
    const core = createWorkerCore({
      db,
      processBatchImpl,
    });

    await core.scanAndDrainQueue();
    primeSessionState(core, sessionId, {
      lastPushAt: 0,
      lastMessageAt: 0,
      lastActivity: 0,
    });

    await core.runKeepaliveTick(240_000);

    expect(processBatchImpl).not.toHaveBeenCalled();
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM pending_queue").get()
        ?.count,
    ).toBe(2);
    expect(core.buffers.get(sessionId)?.items).toBeUndefined();
    expect(core.sessions.get(sessionId)?.batchQueue).toHaveLength(1);
  });

  test("runKeepaliveTick preserves concurrently buffered obs via seq-based removal", async () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "worker-session-keepalive-concurrent",
      project: "/tmp/project-keepalive-concurrent",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;

    const reserveTurnIds = [1, 2, 3].map((promptNumber) =>
      createTurn(db, sessionId, promptNumber, `Turn ${promptNumber}`, `Reply ${promptNumber}`),
    );
    reserveTurnIds.forEach((turnId, index) => {
      queueObs(db, sessionId, turnId, 100 + index, `reserve-concurrent-${index + 1}`);
      queueTurnStop(db, sessionId, turnId, 200 + index);
    });

    const inflightTurnId = createTurn(db, sessionId, 4, "Concurrent turn", "Reply 4");
    let releaseBatch!: () => void;
    const batchStarted = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });

    const core = createWorkerCore({
      db,
      config: {
        mergeThresholdChars: 1,
        maxQueuedBatches: 5,
        keepaliveLeadMs: 60_000,
        cacheMode: "auto",
      },
      processBatchImpl: async () => {
        await batchStarted;
      },
    });

    await core.scanAndDrainQueue();
    primeSessionState(core, sessionId, {
      lastPushAt: 3_000_000,
      lastMessageAt: 3_000_000,
      lastActivity: 3_000_000,
    });

    const keepalivePromise = core.runKeepaliveTick(3_240_000);
    await Promise.resolve();

    const concurrentObservationId = queueObs(
      db,
      sessionId,
      inflightTurnId,
      400,
      "concurrent-extra",
    );
    await core.scanAndDrainQueue(sessionId);

    releaseBatch();
    await keepalivePromise;

    expect(
      core.buffers
        .get(sessionId)
        ?.items.some((item) => item.kind === "obs" && item.targetId === concurrentObservationId),
    ).toBe(true);
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM pending_queue").get()
        ?.count,
    ).toBe(5);
    expect(core.sessions.get(sessionId)?.batchQueue).toHaveLength(2);
  });

  test("handleCompact drains the session, pushes summary, compacts the query, and resets it to cold without closing", async () => {
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
    const compacted: number[] = [];
    const closed: number[] = [];
    const sentPrompts: string[] = [];

    const core = createWorkerCore({
      db,
      processBatchImpl: async (_state, items, options) => {
        processed.push(
          `batch:${items.map((item) => item.targetId).join(",")}:${(options?.turnStopItems ?? []).map((item) => item.targetId).join(",") || "none"}`,
        );
        await _state.pushMessage(
          `batch:${items.map((item) => item.targetId).join(",")}:${(options?.turnStopItems ?? []).map((item) => item.targetId).join(",") || "none"}`,
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
          async compact() {
            compacted.push(compactSessionId);
          },
          async close() {},
        }) satisfies WorkerQuerySession) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
      isProcessAliveImpl: () => false,
    });

    await core.handleCompact(compactSessionId, "/tmp/session.jsonl");

    expect(processed).toEqual([`batch:${compactObservationId}:${compactTurnId}`]);
    expect(pushed).toEqual([compactSessionId]);
    expect(compacted).toEqual([compactSessionId]);
    expect(closed).toEqual([]);
    expect(sentPrompts).toEqual([
      `batch:${compactObservationId}:${compactTurnId}`,
      `summary:${compactSessionId}`,
    ]);
    const state = core.sessions.get(compactSessionId);
    expect(state?.lastPushAt).toBe(0);
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

  test("handleCompact skips compact step when querySession is null", async () => {
    const compactSessionId = upsertSession(db, {
      contentSessionId: "worker-session-compact-no-qs",
      project: "/tmp/project-compact-no-qs",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;

    const compacted: number[] = [];
    const core = createWorkerCore({
      db,
      processBatchImpl: async () => {},
      pushSessionSummaryPromptImpl: async () => {},
      closeSessionQueryImpl: async () => {},
      createWorkerQuerySessionImpl: ((_input) =>
        ({
          sessionId: "worker-query",
          queryPid: 1234,
          async sendPrompt(_prompt: string) {
            return { session_id: "worker-query" };
          },
          async compact() {
            compacted.push(compactSessionId);
          },
          async close() {},
        }) satisfies WorkerQuerySession) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
      isProcessAliveImpl: () => false,
    });

    // No items queued, pushSessionSummaryPromptImpl is a noop → querySession stays null
    await core.handleCompact(compactSessionId, null);

    expect(compacted).toEqual([]);
    const state = core.sessions.get(compactSessionId);
    expect(state?.lastPushAt).toBe(0);
    expect(state?.lastInjectedSummaryEpoch).toBe(0);
  });

  test("handleCompact resets state even when compact() throws", async () => {
    const compactSessionId = upsertSession(db, {
      contentSessionId: "worker-session-compact-fail",
      project: "/tmp/project-compact-fail",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;

    const errors: unknown[] = [];
    const core = createWorkerCore({
      db,
      processBatchImpl: async () => {},
      pushSessionSummaryPromptImpl: async (_state, _sessionId) => {
        await _state.pushMessage(`summary:${_sessionId}`);
      },
      closeSessionQueryImpl: async () => {},
      createWorkerQuerySessionImpl: ((_input) =>
        ({
          sessionId: "worker-query",
          queryPid: 1234,
          async sendPrompt(_prompt: string) {
            return { session_id: "worker-query" };
          },
          async compact() {
            throw new Error("compact exploded");
          },
          async close() {},
        }) satisfies WorkerQuerySession) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
      isProcessAliveImpl: () => false,
      logger: {
        warn: () => {},
        error: (...args: unknown[]) => {
          errors.push(args);
        },
      },
    });

    await core.handleCompact(compactSessionId, null);

    const state = core.sessions.get(compactSessionId);
    expect(state?.lastPushAt).toBe(0);
    expect(state?.lastInjectedSummaryEpoch).toBe(0);
    expect(errors.some((e) => String(e).includes("mnemosyne compact failed"))).toBe(true);
  });

  test("abortStalledSessions skips sessions that are compacting", async () => {
    const compactSessionId = upsertSession(db, {
      contentSessionId: "worker-session-compact-stalled",
      project: "/tmp/project-compact-stalled",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;

    const closed: number[] = [];
    const core = createWorkerCore({
      db,
      closeSessionQueryImpl: async (sessionId) => {
        closed.push(sessionId);
      },
      createWorkerQuerySessionImpl: ((_input) =>
        ({
          sessionId: "worker-query",
          queryPid: 1234,
          async sendPrompt(_prompt: string) {
            return { session_id: "worker-query" };
          },
          async compact() {},
          async close() {},
        }) satisfies WorkerQuerySession) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
      isProcessAliveImpl: () => false,
    });

    primeSessionState(core, compactSessionId, {
      lastPushAt: 1_000,
      lastMessageAt: 0,
      lastActivity: 0,
    });
    core.sessions.get(compactSessionId)!.querySession = {
      sessionId: "worker-query",
      queryPid: 1234,
      sendPrompt: async () => ({ session_id: "worker-query" }),
      compact: async () => {},
      close: async () => {},
    } satisfies WorkerQuerySession;
    core.compactingSessions.add(compactSessionId);

    await core.abortStalledSessions(1_000 + 31_000);

    expect(closed).toEqual([]);
    expect(core.sessions.has(compactSessionId)).toBe(true);
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
    const turnId = createTurn(db, sessionId, 1);

    const createWorkerQuerySessionCalls: unknown[][] = [];
    const core = createWorkerCore({
      db,
      processBatchImpl: async (state) => {
        await state.pushMessage("batch");
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
      kind: "turn-stop",
      targetId: turnId,
      sessionDbId: sessionId,
      claimedAtEpoch: 1,
      enqueuedAtEpoch: 1,
    });
    await core.flushSession(sessionId);

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
      lastPushAt: 1_999_000,
      lastMessageAt: 1_998_000,
      lastActivity: 100,
      processingLock: Promise.resolve(),
      pushMessage: async () => {},
    });

    await stateCore.abortStalledSessions(2_000_000);

    expect(closed).toEqual([10]);
  });

  test("processClaimedItem keeps same-session work serialized while a prior turn-stop is in flight", async () => {
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
    const firstTurnId = createTurn(db, sessionId, 1);
    const secondTurnId = createTurn(db, sessionId, 2);

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: number[] = [];
    const core = createWorkerCore({
      db,
      config: {
        mergeThresholdChars: 1,
        maxQueuedBatches: 0,
        keepaliveLeadMs: 60_000,
        cacheMode: "auto",
      },
      processBatchImpl: async (_state, _items, options) => {
        const turnId = options?.turnStopItems?.[0]?.targetId;
        if (!turnId) {
          return;
        }
        started.push(turnId);
        if (turnId === firstTurnId) {
          await firstGate;
        }
      },
    });

    const first = core.processClaimedItem({
      seq: 1,
      kind: "turn-stop",
      targetId: firstTurnId,
      sessionDbId: sessionId,
      claimedAtEpoch: 1,
      enqueuedAtEpoch: 1,
    });

    await Promise.resolve();
    await Promise.resolve();

    const second = core.processClaimedItem({
      seq: 2,
      kind: "turn-stop",
      targetId: secondTurnId,
      sessionDbId: sessionId,
      claimedAtEpoch: 2,
      enqueuedAtEpoch: 2,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(started).toEqual([firstTurnId]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(started).toEqual([firstTurnId, secondTurnId]);
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
    queueTurnStop(db, sessionId, turnId, 201);

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
