import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { createDiaryStateStore } from "../../src/db/diary-state";
import { createObservation } from "../../src/db/observations";
import { initializeSchema } from "../../src/db/schema";
import {
  getSession,
  updateLastAgentSessionId,
  upsertSession,
} from "../../src/db/sessions";
import {
  getStrandedTurns,
  getTurn,
  getTurnById,
  updateTurnById,
} from "../../src/db/turns";
import { createWorkerProcessors } from "../../src/worker/processors";
import {
  checkForIdleWorkerShutdown,
  acquireWorkerSingleton,
  createWorkerCore,
  createWorkerFetchHandler,
  createWorkerServerState,
  DerailmentFloorError,
  ensureWorkerPidFile,
  main,
} from "../../src/worker/server";
import type { SessionState } from "../../src/worker/server";
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

// Streaming knobs default to large/quiet values so legacy batching tests
// (tiny obs) never cross the slice threshold and exercise the short-turn path.
const QUIET_STREAMING = {
  maxMiniTurnChars: 24_000,
  maxFlushAttempts: 3,
  compactContextRatio: 0.5,
};

// Read the turn ids carried by a batch regardless of kind (merged | slice).
function batchTurnIds(batch: {
  kind: "merged" | "slice";
  miniTurns?: Array<{ turnId: number }>;
  miniTurn?: { turnId: number };
}): number[] {
  return batch.kind === "merged"
    ? (batch.miniTurns ?? []).map((miniTurn) => miniTurn.turnId)
    : batch.miniTurn
      ? [batch.miniTurn.turnId]
      : [];
}

// Callbacks the worker passes to createWorkerQuerySession. A test fake captures
// these to drive the D1 work-unit signals (onRemember) the derailment state
// machine classifies against.
type FakeQueryDeps = {
  onMessage?: (message: { session_id?: string }) => void;
  onRemember?: (id: string) => void;
};

function fakeQueryDeps(args: unknown[]): FakeQueryDeps | undefined {
  return (args.length === 2 ? args[1] : args[3]) as FakeQueryDeps | undefined;
}

// A "healthy agent" fake query session: records every prompt and, for each
// <turn id="T..."> block in it, fires onRemember so the flush unit resolves on
// the first send (no derailment). Use this for legacy flush tests that only
// assert on what was sent — the derailment wiring would otherwise classify a
// silent fake as a strike and resend.
function healthyQueryImpl(
  sentPrompts: string[],
  agentSessionId = "worker-query",
): typeof import("../../src/worker/query-session").createWorkerQuerySession {
  return ((...args: unknown[]) => {
    const deps = fakeQueryDeps(args);
    return {
      sessionId: agentSessionId,
      queryPid: 1234,
      async sendPrompt(prompt: string) {
        sentPrompts.push(prompt);
        deps?.onMessage?.({ session_id: agentSessionId });
        for (const match of prompt.matchAll(/<turn id="T(\d+)"/g)) {
          deps?.onRemember?.(`T${match[1]}`);
        }
        return { session_id: agentSessionId };
      },
      async close() {},
    } satisfies WorkerQuerySession;
  }) as typeof import("../../src/worker/query-session").createWorkerQuerySession;
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
    streamedParts: existing?.streamedParts ?? new Map<number, number>(),
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
    unitSignals: existing?.unitSignals ?? {
      rememberedIds: new Set<number>(),
      rememberedSessionIds: new Set<number>(),
      hadSubstantiveText: false,
      hadIllegalTool: false,
    },
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

  test("ensureWorkerPidFile writes our pid when the file is missing", () => {
    const writes: Array<{ path: string; value: string }> = [];
    ensureWorkerPidFile({
      pidPath: "/tmp/worker.pid",
      existsSyncImpl: () => false,
      writeFileSyncImpl: ((path: string, value: string) => {
        writes.push({ path, value });
      }) as typeof import("node:fs").writeFileSync,
      processImpl: { pid: 4242 } as NodeJS.Process,
    });
    expect(writes).toEqual([{ path: "/tmp/worker.pid", value: "4242" }]);
  });

  test("ensureWorkerPidFile rewrites a pid file that holds a different pid", () => {
    const writes: Array<{ path: string; value: string }> = [];
    ensureWorkerPidFile({
      pidPath: "/tmp/worker.pid",
      existsSyncImpl: () => true,
      readFileSyncImpl: (() => "999\n") as typeof import("node:fs").readFileSync,
      writeFileSyncImpl: ((path: string, value: string) => {
        writes.push({ path, value });
      }) as typeof import("node:fs").writeFileSync,
      processImpl: { pid: 4242 } as NodeJS.Process,
    });
    expect(writes).toEqual([{ path: "/tmp/worker.pid", value: "4242" }]);
  });

  test("ensureWorkerPidFile is a no-op when the file already holds our pid", () => {
    const writes: Array<{ path: string; value: string }> = [];
    ensureWorkerPidFile({
      pidPath: "/tmp/worker.pid",
      existsSyncImpl: () => true,
      readFileSyncImpl: (() => "4242") as typeof import("node:fs").readFileSync,
      writeFileSyncImpl: ((path: string, value: string) => {
        writes.push({ path, value });
      }) as typeof import("node:fs").writeFileSync,
      processImpl: { pid: 4242 } as NodeJS.Process,
    });
    expect(writes).toEqual([]);
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
      createWorkerQuerySessionImpl: healthyQueryImpl(sentPrompts),
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

  test("scanAndDrainQueue dispatches diary work before touching session state", async () => {
    const stateStore = createDiaryStateStore(db);
    stateStore.enqueueDay({
      date: "2026-07-10",
      enqueuedAtEpoch: 100,
    });
    const processed: Array<{ targetId: number; claimedAtEpoch: number | null }> = [];
    const core = createWorkerCore({
      db,
      now: () => 123,
      processDiaryItem: async (item) => {
        processed.push({
          targetId: item.targetId,
          claimedAtEpoch: item.claimedAtEpoch,
        });
        stateStore.acknowledgeDiaryItem(item.seq);
      },
    });

    await core.scanAndDrainQueue();

    expect(processed).toEqual([
      { targetId: 20260710, claimedAtEpoch: 123 },
    ]);
    expect(core.sessions.size).toBe(0);
    expect(stateStore.hasQueuedDay("2026-07-10")).toBe(false);
  });

  test("global drain buffers session work before processing at most one diary", async () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "worker-session-diary-fairness",
      project: "/tmp/project-diary-fairness",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    const turnId = createTurn(db, sessionId, 1);
    const observationId = queueObs(db, sessionId, turnId, 100, "diary-fairness");
    const stateStore = createDiaryStateStore(db);
    stateStore.enqueueDay({ date: "2026-07-09", enqueuedAtEpoch: 101 });
    stateStore.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 102 });
    const sawBufferedObservation: boolean[] = [];
    let core!: ReturnType<typeof createWorkerCore>;
    core = createWorkerCore({
      db,
      now: () => 123,
      setTimeoutImpl: (() => 0 as unknown as NodeJS.Timeout) as typeof setTimeout,
      processDiaryItem: async (item) => {
        sawBufferedObservation.push(
          core.buffers
            .get(sessionId)
            ?.items.some((buffered) => buffered.targetId === observationId) ?? false,
        );
        stateStore.acknowledgeDiaryItem(item.seq);
      },
    });

    await core.scanAndDrainQueue();

    expect(sawBufferedObservation).toEqual([true]);
    expect(stateStore.hasQueuedDay("2026-07-09")).toBe(false);
    expect(stateStore.hasQueuedDay("2026-07-10")).toBe(true);
  });

  test("global drain continues a multi-day diary backlog without another hook while rechecking session work between days", async () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "worker-session-diary-continuation",
      project: "/tmp/project-diary-continuation",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    const turnId = createTurn(db, sessionId, 1);
    const observationIds = [
      queueObs(db, sessionId, turnId, 100, "diary-continuation-1"),
    ];
    const stateStore = createDiaryStateStore(db);
    for (const [offset, date] of [
      "2026-07-08",
      "2026-07-09",
      "2026-07-10",
    ].entries()) {
      stateStore.enqueueDay({ date, enqueuedAtEpoch: 101 + offset });
    }

    const scheduled: Array<{
      callback: () => void | Promise<void>;
      delayMs: number;
    }> = [];
    const bufferedCounts: number[] = [];
    let core!: ReturnType<typeof createWorkerCore>;
    core = createWorkerCore({
      db,
      now: () => 123,
      setTimeoutImpl(callback, delayMs) {
        scheduled.push({ callback, delayMs });
        return Symbol("diary-continuation");
      },
      clearTimeoutImpl: () => {},
      async processDiaryItem(item) {
        bufferedCounts.push(core.buffers.get(sessionId)?.items.length ?? 0);
        stateStore.acknowledgeDiaryItem(item.seq);
        if (bufferedCounts.length < 3) {
          observationIds.push(
            queueObs(
              db,
              sessionId,
              turnId,
              100 + bufferedCounts.length,
              `diary-continuation-${bufferedCounts.length + 1}`,
            ),
          );
        }
      },
    });

    await core.scanAndDrainQueue();
    expect(bufferedCounts).toEqual([1]);
    expect(scheduled.map((entry) => entry.delayMs)).toEqual([0]);

    await scheduled.shift()!.callback();
    expect(bufferedCounts).toEqual([1, 2]);
    expect(scheduled.map((entry) => entry.delayMs)).toEqual([0]);

    await scheduled.shift()!.callback();
    expect(bufferedCounts).toEqual([1, 2, 3]);
    expect(scheduled).toEqual([]);
    expect(observationIds).toHaveLength(3);
    expect(stateStore.hasQueuedDay("2026-07-08")).toBe(false);
    expect(stateStore.hasQueuedDay("2026-07-09")).toBe(false);
    expect(stateStore.hasQueuedDay("2026-07-10")).toBe(false);
  });

  test("a persisted diary backoff schedules one global retry at its due time", async () => {
    const stateStore = createDiaryStateStore(db);
    stateStore.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 100 });
    let nowEpoch = 100;
    let attempts = 0;
    let scheduled:
      | { callback: () => void | Promise<void>; delayMs: number }
      | null = null;
    const setTimeoutImpl = mock(
      (callback: () => void | Promise<void>, delayMs: number): unknown => {
        scheduled = { callback, delayMs };
        return Symbol("diary-retry");
      },
    );
    const clearTimeoutImpl = mock((_handle: unknown): void => {});
    const core = createWorkerCore({
      db,
      now: () => nowEpoch,
      setTimeoutImpl,
      clearTimeoutImpl,
      logger: { warn: () => {}, error: () => {} },
      processDiaryItem: async (item) => {
        attempts += 1;
        if (attempts === 1) {
          stateStore.recordDreamFailure({
            date: "2026-07-10",
            queueSeq: item.seq,
            error: "temporary failure",
            nextAttemptEpoch: nowEpoch + 60,
          });
          throw new Error("temporary failure");
        }
        stateStore.acknowledgeDiaryItem(item.seq);
      },
    });

    await core.scanAndDrainQueue();

    expect(attempts).toBe(1);
    expect(setTimeoutImpl).toHaveBeenCalledTimes(1);
    expect(scheduled?.delayMs).toBe(60_000);

    nowEpoch = 159;
    await core.scanAndDrainQueue();
    expect(attempts).toBe(1);
    expect(setTimeoutImpl).toHaveBeenCalledTimes(1);

    nowEpoch = 160;
    await scheduled!.callback();
    expect(attempts).toBe(2);
    expect(stateStore.hasQueuedDay("2026-07-10")).toBe(false);
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
    const core = createWorkerCore({
      db,
      config: {
        mergeThresholdChars: 1,
        maxQueuedBatches: 3,
        keepaliveLeadMs: 60_000,
        cacheMode: "auto",
        ...QUIET_STREAMING,
      },
      now: () => 123,
      createWorkerQuerySessionImpl: healthyQueryImpl(sentPrompts),
    });

    await core.scanAndDrainQueue();

    // mergeThresholdChars=1 => each short turn its own merged batch; overflow
    // beyond maxQueuedBatches=3 flushes the oldest (turn 1) as one message.
    expect(sentPrompts).toHaveLength(1);
    expect(sentPrompts[0]).toContain("<batch>");
    expect(sentPrompts[0]).toContain(`<obs id="O${observationIds[0]}"`);
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM pending_queue").get()
        ?.count,
    ).toBe(6);
    expect(
      core.sessions.get(sessionId)?.batchQueue.map(batchTurnIds),
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
      createWorkerQuerySessionImpl: healthyQueryImpl(sentPrompts),
    });

    await core.scanAndDrainQueue();
    await core.flushSession(sessionId);

    expect(sentPrompts).toHaveLength(1);
    expect(sentPrompts[0]).toContain("title: Merged title");
    expect(sentPrompts[0]).toContain("current_prompt:");
    expect(sentPrompts[0]).toContain("<source_prompt");
    expect(sentPrompts[0]).toContain("Latest prompt");
    expect(sentPrompts[0]).not.toContain("current_prompt: Latest prompt");
    expect(sentPrompts[0]).not.toContain("current_prompt: Earlier prompt");
    expect(sentPrompts[0]).not.toContain("user_request:");
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

    const sentPrompts: string[] = [];
    const core = createWorkerCore({
      db,
      now: () => 123,
      createWorkerQuerySessionImpl: healthyQueryImpl(sentPrompts),
    });

    await core.scanAndDrainQueue();
    await core.drainSessionCompletely(sessionId);

    expect(sentPrompts).toHaveLength(1);
    expect(sentPrompts[0]).toContain(`<obs id="O${observationId}"`);
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

    const sentPrompts: string[] = [];
    const core = createWorkerCore({
      db,
      config: {
        mergeThresholdChars: 1,
        maxQueuedBatches: 5,
        keepaliveLeadMs: 60_000,
        cacheMode: "auto",
        ...QUIET_STREAMING,
      },
      createWorkerQuerySessionImpl: healthyQueryImpl(sentPrompts),
    });

    await core.scanAndDrainQueue();
    primeSessionState(core, sessionId, {
      lastPushAt: 1_000_000,
      lastMessageAt: 1_000_000,
      lastActivity: 1_000_000,
    });

    await core.runKeepaliveTick(1_240_000);

    // One reserve push flushes the oldest batch (turn 1) to keep cache warm.
    expect(sentPrompts).toHaveLength(1);
    expect(sentPrompts[0]).toContain(`<obs id="O${observationIds[0]}"`);
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM pending_queue").get()
        ?.count,
    ).toBe(4);
    expect(
      core.sessions.get(sessionId)?.batchQueue.map(batchTurnIds),
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
        ...QUIET_STREAMING,
      },
      createWorkerQuerySessionImpl: ((_input) =>
        ({
          sessionId: "worker-query",
          queryPid: 1234,
          async sendPrompt(_prompt: string) {
            await batchStarted;
            return { session_id: "worker-query" };
          },
          async close() {},
        }) satisfies WorkerQuerySession) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
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

    const pushed: number[] = [];
    const compacted: number[] = [];
    const closed: number[] = [];
    const sentPrompts: string[] = [];

    const core = createWorkerCore({
      db,
      pushSessionSummaryPromptImpl: async (_state, sessionId) => {
        pushed.push(sessionId);
        await _state.pushMessage(`summary:${sessionId}`);
      },
      closeSessionQueryImpl: async (sessionId) => {
        closed.push(sessionId);
      },
      createWorkerQuerySessionImpl: ((...args: unknown[]) => {
        const deps = fakeQueryDeps(args) as
          | (FakeQueryDeps & { onRemember?: (id: string) => void })
          | undefined;
        return {
          sessionId: "worker-query",
          queryPid: 1234,
          async sendPrompt(prompt: string) {
            sentPrompts.push(prompt);
            deps?.onMessage?.({ session_id: "worker-query" });
            for (const match of prompt.matchAll(/<turn id="T(\d+)"/g)) {
              deps?.onRemember?.(`T${match[1]}`);
            }
            return {
              session_id: "worker-query",
            };
          },
          async compact() {
            compacted.push(compactSessionId);
          },
          async close() {},
        } satisfies WorkerQuerySession;
      }) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
      isProcessAliveImpl: () => false,
    });

    await core.handleCompact(compactSessionId, "/tmp/session.jsonl");

    expect(pushed).toEqual([compactSessionId]);
    expect(compacted).toEqual([compactSessionId]);
    expect(closed).toEqual([]);
    // One rendered batch (the drained turn), the summary push, then the
    // post-compact re-prime, in order. The re-prime fires after compact() so the
    // freshly-compacted agent regains the session's structured state.
    expect(sentPrompts).toHaveLength(3);
    expect(sentPrompts[0]).toContain(`<obs id="O${compactObservationId}"`);
    expect(sentPrompts[1]).toBe(`summary:${compactSessionId}`);
    expect(sentPrompts[2]).toContain("CONTEXT ONLY");
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

  test("SDK-auto compact: needsReprime re-primes before the next work unit, then clears", async () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "worker-session-auto-reprime",
      project: "/tmp/project-auto-reprime",
      title: "Auto reprime session",
      content: "Some content",
      insight: "- prior insight",
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;

    // A couple of finalized turns so the re-prime's recent-turn index has rows.
    createTurn(db, sessionId, 1, "Turn 1", "Reply 1");
    createTurn(db, sessionId, 2, "Turn 2", "Reply 2");
    const turn3 = createTurn(db, sessionId, 3, "Turn 3", "Reply 3");
    queueObs(db, sessionId, turn3, 101, "auto-reprime");
    queueTurnStop(db, sessionId, turn3, 201);

    const sentPrompts: string[] = [];
    const core = createWorkerCore({
      db,
      now: () => 123,
      config: {
        mergeThresholdChars: 1,
        maxQueuedBatches: 3,
        keepaliveLeadMs: 60_000,
        cacheMode: "auto",
        ...QUIET_STREAMING,
      },
      createWorkerQuerySessionImpl: healthyQueryImpl(sentPrompts),
    });

    // Bring the (real) session state up so it has the worker's pushMessage
    // routing, then simulate the onCompactBoundary callback: an unsolicited
    // SDK-auto compact set the flag since the last work unit.
    await core.scanAndDrainQueue(sessionId);
    const state = core.sessions.get(sessionId)!;
    state.needsReprime = true;

    await core.flushSession(sessionId);

    // Re-prime is sent BEFORE the turn-3 batch, and the flag is cleared.
    expect(sentPrompts).toHaveLength(2);
    expect(sentPrompts[0]).toContain("CONTEXT ONLY");
    expect(sentPrompts[1]).toContain(`<turn id="T${turn3}"`);
    expect(state.needsReprime).toBe(false);
  });

  test("the re-prime payload carries the recent-turn index with dbid:T<dbid> tokens", async () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "worker-session-reprime-index",
      project: "/tmp/project-reprime-index",
      title: "Reprime index session",
      content: "Content here",
      insight: "- prior insight",
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;

    createTurn(db, sessionId, 1, "Turn 1", "Reply 1");
    const turn2 = createTurn(db, sessionId, 2, "Turn 2", "Reply 2");
    const turn3 = createTurn(db, sessionId, 3, "Turn 3", "Reply 3");
    queueObs(db, sessionId, turn3, 101, "reprime-index");
    queueTurnStop(db, sessionId, turn3, 201);

    const sentPrompts: string[] = [];
    const core = createWorkerCore({
      db,
      now: () => 123,
      config: {
        mergeThresholdChars: 1,
        maxQueuedBatches: 3,
        keepaliveLeadMs: 60_000,
        cacheMode: "auto",
        ...QUIET_STREAMING,
      },
      createWorkerQuerySessionImpl: healthyQueryImpl(sentPrompts),
    });

    await core.scanAndDrainQueue(sessionId);
    core.sessions.get(sessionId)!.needsReprime = true;

    await core.flushSession(sessionId);

    const reprime = sentPrompts[0]!;
    expect(reprime).toContain("Most recent turns (cite by DB id):");
    // DB ids (not prompt numbers) are emitted so the agent can cite them.
    expect(reprime).toContain(`dbid:T${turn2}`);
    expect(reprime).toContain(`dbid:T${turn3}`);
  });

  test("worker-driven compact re-primes once and does NOT leave needsReprime set (no double re-prime)", async () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "worker-session-no-double",
      project: "/tmp/project-no-double",
      title: "No double reprime",
      content: "Content",
      insight: "- prior insight",
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    const turn1 = createTurn(db, sessionId, 1, "Turn 1", "Reply 1");
    queueObs(db, sessionId, turn1, 101, "no-double");
    queueTurnStop(db, sessionId, turn1, 201);

    const sentPrompts: string[] = [];
    const compacted: number[] = [];
    const core = createWorkerCore({
      db,
      readAgentContextTokensImpl: () => 150_000, // >= 0.5 * 200K → compact runs
      pushSessionSummaryPromptImpl: async (state, sid) => {
        await state.pushMessage(`summary:${sid}`);
      },
      createWorkerQuerySessionImpl: ((...args: unknown[]) => {
        const deps = fakeQueryDeps(args) as
          | (FakeQueryDeps & { onCompactBoundary?: () => void })
          | undefined;
        return {
          sessionId: "worker-query",
          queryPid: 1234,
          async sendPrompt(prompt: string) {
            sentPrompts.push(prompt);
            deps?.onMessage?.({ session_id: "worker-query" });
            for (const match of prompt.matchAll(/<turn id="T(\d+)"/g)) {
              deps?.onRemember?.(`T${match[1]}`);
            }
            return { session_id: "worker-query" };
          },
          async compact() {
            compacted.push(sessionId);
            // The explicit compact()'s own boundary is gated out of
            // onCompactBoundary in query-session.ts, so a real session would
            // NOT call deps.onCompactBoundary here. Asserting we don't is the
            // negative guard.
          },
          async close() {},
        } satisfies WorkerQuerySession;
      }) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
      isProcessAliveImpl: () => false,
    });

    // handleCompact drains the queued turn (bringing the query session up),
    // pushes the summary, then compacts + re-primes.
    await core.handleCompact(sessionId, null);

    expect(compacted).toEqual([sessionId]);
    // Exactly one re-prime (the synchronous worker-driven one); the explicit
    // boundary did not set needsReprime.
    const reprimes = sentPrompts.filter((p) => p.includes("CONTEXT ONLY"));
    expect(reprimes).toHaveLength(1);
    expect(core.sessions.get(sessionId)!.needsReprime ?? false).toBe(false);
  });

  test("SDK-auto compact: a failed re-prime keeps needsReprime set and still runs the batch", async () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "worker-session-reprime-fail",
      project: "/tmp/project-reprime-fail",
      title: "Reprime fail session",
      content: "Some content",
      insight: "- prior insight",
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;

    createTurn(db, sessionId, 1, "Turn 1", "Reply 1");
    const turn2 = createTurn(db, sessionId, 2, "Turn 2", "Reply 2");
    queueObs(db, sessionId, turn2, 101, "reprime-fail");
    queueTurnStop(db, sessionId, turn2, 201);

    const sentPrompts: string[] = [];
    let failedReprimeOnce = false;
    // Throws on the FIRST re-prime (the `CONTEXT ONLY` payload), succeeds on
    // everything else, so the batch send still lands.
    const failingReprimeImpl = ((...args: unknown[]) => {
      const deps = fakeQueryDeps(args);
      return {
        sessionId: "worker-query",
        queryPid: 1234,
        async sendPrompt(prompt: string) {
          if (prompt.includes("CONTEXT ONLY") && !failedReprimeOnce) {
            failedReprimeOnce = true;
            throw new Error("re-prime send failed");
          }
          sentPrompts.push(prompt);
          deps?.onMessage?.({ session_id: "worker-query" });
          for (const match of prompt.matchAll(/<turn id="T(\d+)"/g)) {
            deps?.onRemember?.(`T${match[1]}`);
          }
          return { session_id: "worker-query" };
        },
        async close() {},
      } satisfies WorkerQuerySession;
    }) as typeof import("../../src/worker/query-session").createWorkerQuerySession;

    const core = createWorkerCore({
      db,
      now: () => 123,
      config: {
        mergeThresholdChars: 1,
        maxQueuedBatches: 3,
        keepaliveLeadMs: 60_000,
        cacheMode: "auto",
        ...QUIET_STREAMING,
      },
      createWorkerQuerySessionImpl: failingReprimeImpl,
    });

    await core.scanAndDrainQueue(sessionId);
    const state = core.sessions.get(sessionId)!;
    state.needsReprime = true;

    await core.flushSession(sessionId);

    // The re-prime threw, so the flag stays set for the next batch to retry...
    expect(failedReprimeOnce).toBe(true);
    expect(state.needsReprime).toBe(true);
    // ...but the turn batch still ran — a doomed re-prime must not wedge throughput.
    expect(sentPrompts.some((p) => p.includes(`<turn id="T${turn2}"`))).toBe(true);
  });

  test("worker-driven compact: a failed re-prime sets needsReprime so the next work unit retries", async () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "worker-session-reprime-retry",
      project: "/tmp/project-reprime-retry",
      title: "Reprime retry",
      content: "Content",
      insight: "- prior insight",
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    const turn1 = createTurn(db, sessionId, 1, "Turn 1", "Reply 1");
    queueObs(db, sessionId, turn1, 101, "reprime-retry");
    queueTurnStop(db, sessionId, turn1, 201);

    const sentPrompts: string[] = [];
    const compacted: number[] = [];
    const core = createWorkerCore({
      db,
      readAgentContextTokensImpl: () => 150_000, // >= 0.5 * 200K → compact runs
      pushSessionSummaryPromptImpl: async (state, sid) => {
        await state.pushMessage(`summary:${sid}`);
      },
      createWorkerQuerySessionImpl: ((...args: unknown[]) => {
        const deps = fakeQueryDeps(args);
        return {
          sessionId: "worker-query",
          queryPid: 1234,
          async sendPrompt(prompt: string) {
            // The post-compact re-prime fails; the agent's history is already
            // wiped, so the flag must be set for the next work unit to retry.
            if (prompt.includes("CONTEXT ONLY")) {
              throw new Error("re-prime send failed");
            }
            sentPrompts.push(prompt);
            deps?.onMessage?.({ session_id: "worker-query" });
            for (const match of prompt.matchAll(/<turn id="T(\d+)"/g)) {
              deps?.onRemember?.(`T${match[1]}`);
            }
            return { session_id: "worker-query" };
          },
          async compact() {
            compacted.push(sessionId);
          },
          async close() {},
        } satisfies WorkerQuerySession;
      }) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
      isProcessAliveImpl: () => false,
    });

    await core.handleCompact(sessionId, null);

    // compact() ran but the re-prime threw → flag set for retry, no re-prime landed.
    expect(compacted).toEqual([sessionId]);
    expect(sentPrompts.some((p) => p.includes("CONTEXT ONLY"))).toBe(false);
    expect(core.sessions.get(sessionId)!.needsReprime).toBe(true);
  });

  function compactGateCore(
    sessionId: number,
    contextTokens: number | null,
    compacted: number[],
  ) {
    return createWorkerCore({
      db,
      pushSessionSummaryPromptImpl: async (state) => {
        await state.pushMessage("summary");
      },
      readAgentContextTokensImpl: () => contextTokens,
      createWorkerQuerySessionImpl: ((_input) =>
        ({
          sessionId: "worker-query",
          queryPid: 1234,
          async sendPrompt(_prompt: string) {
            return { session_id: "agent-sess" };
          },
          async compact() {
            compacted.push(sessionId);
          },
          async close() {},
        }) satisfies WorkerQuerySession) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
      isProcessAliveImpl: () => false,
    });
  }

  test("handleCompact skips the agent /compact when context is below the ratio threshold", async () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "compact-low-ctx",
      project: "/tmp/p-low",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;

    const compacted: number[] = [];
    // 50K < min(0.5 * 1M, 100K) = 100K → below threshold, skip.
    await compactGateCore(sessionId, 50_000, compacted).handleCompact(
      sessionId,
      null,
    );

    expect(compacted).toEqual([]);
  });

  test("handleCompact runs the agent /compact when context is at/above the threshold", async () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "compact-high-ctx",
      project: "/tmp/p-high",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;

    const compacted: number[] = [];
    // 150K >= 100K cap (= min(0.5 * 1M, 100K)) → compact; below 0.5 * 1M, so
    // this only compacts because the absolute cap, not the ratio, governs.
    await compactGateCore(sessionId, 150_000, compacted).handleCompact(
      sessionId,
      null,
    );

    expect(compacted).toEqual([sessionId]);
  });

  test("handleCompact caps the /compact trigger at 100K under the 1M window", async () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "compact-cap-ctx",
      project: "/tmp/p-cap",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;

    const compacted: number[] = [];
    // 400K is far below 0.5 * 1M (500K) but at/above the 100K absolute cap, so
    // the agent still compacts — the cap governs, the ratio no longer does.
    await compactGateCore(sessionId, 400_000, compacted).handleCompact(
      sessionId,
      null,
    );

    expect(compacted).toEqual([sessionId]);
  });

  test("handleCompact compacts when the agent context size is unknown (null)", async () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "compact-null-ctx",
      project: "/tmp/p-null",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;

    const compacted: number[] = [];
    // Unknown context (no transcript) → fall back to compacting (prior behavior).
    await compactGateCore(sessionId, null, compacted).handleCompact(
      sessionId,
      null,
    );

    expect(compacted).toEqual([sessionId]);
  });

  test("handleCompact still compacts when the context read throws (unreadable transcript)", async () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "compact-throw-ctx",
      project: "/tmp/p-throw",
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
      pushSessionSummaryPromptImpl: async (state) => {
        await state.pushMessage("summary");
      },
      readAgentContextTokensImpl: () => {
        throw new Error("EACCES");
      },
      createWorkerQuerySessionImpl: ((_input) =>
        ({
          sessionId: "worker-query",
          queryPid: 1234,
          async sendPrompt(_prompt: string) {
            return { session_id: "agent-sess" };
          },
          async compact() {
            compacted.push(sessionId);
          },
          async close() {},
        }) satisfies WorkerQuerySession) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
      isProcessAliveImpl: () => false,
    });

    await core.handleCompact(sessionId, null);

    // A read error is treated as unknown context → compact (not skipped).
    expect(compacted).toEqual([sessionId]);
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
        const deps = fakeQueryDeps(args);

        return {
          sessionId: "fresh-agent-session",
          queryPid: 1234,
          async sendPrompt(prompt: string) {
            deps?.onMessage?.({ session_id: "fresh-agent-session" });
            for (const match of prompt.matchAll(/<turn id="T(\d+)"/g)) {
              deps?.onRemember?.(`T${match[1]}`);
            }
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

  test("flushSession prepends one-shot reminder and subagent invalidation envelopes", async () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "worker-session-reminder",
      project: "/tmp/project-reminder",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;

    db.query(
      `
        INSERT INTO turns (
          session_id,
          prompt_number,
          content_prompt_id,
          was_interrupted,
          was_rolled_back,
          status,
          user_prompt,
          title,
          content,
          tags,
          created_at_epoch,
          updated_at_epoch
        ) VALUES
          (?, 1, 'p1', 1, 0, 'extracted', 'Interrupted draft', 'Interrupted draft', 'Interrupted content', '["invalidated:notify-pending:interrupt"]', 100, 101),
          (?, 2, 'p2', 0, 0, 'extracted', 'Replacement', 'Replacement', 'Replacement content', '[]', 110, 111),
          (?, 3, 'p3', 0, 0, 'undone', 'Subagent draft', 'Subagent draft', NULL, '["subagent:pending"]', 120, 121)
      `,
    ).run(sessionId, sessionId, sessionId);
    const turnId = createTurn(db, sessionId, 4);

    const sentPrompts: string[] = [];
    const core = createWorkerCore({
      db,
      processBatchImpl: async (state) => {
        await state.pushMessage("<batch><turn id=\"T4\"/></batch>");
      },
      createWorkerQuerySessionImpl: ((...args: unknown[]) => {
        const deps = fakeQueryDeps(args);

        return {
          sessionId: "worker-query",
          queryPid: 1234,
          async sendPrompt(prompt: string) {
            sentPrompts.push(prompt);
            deps?.onMessage?.({ session_id: "worker-query" });
            for (const match of prompt.matchAll(/<turn id="T(\d+)"/g)) {
              deps?.onRemember?.(`T${match[1]}`);
            }
            return {
              session_id: "worker-query",
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

    expect(sentPrompts).toHaveLength(1);
    expect(sentPrompts[0]).toContain("<subagent_invalidated>");
    expect(sentPrompts[0]).toContain("<reminder>");
    expect(sentPrompts[0]).toContain(
      '- T1 (was_interrupted): "Interrupted draft" -- Interrupted content',
    );
    expect(getTurn(db, sessionId, 1)?.tags).toEqual(["invalidated:notified:interrupt"]);
    expect(getTurn(db, sessionId, 3)?.tags).toEqual(["subagent:notified"]);
  });

  test("flushSession only sends the 10 most recent reminders once and silently clears older backlog", async () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "worker-session-reminder-cap",
      project: "/tmp/project-reminder-cap",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;

    for (let promptNumber = 1; promptNumber <= 12; promptNumber += 1) {
      db.query(
        `
          INSERT INTO turns (
            session_id,
            prompt_number,
            content_prompt_id,
            was_interrupted,
            was_rolled_back,
            status,
            user_prompt,
            title,
            content,
            tags,
            created_at_epoch,
            updated_at_epoch
          ) VALUES (?, ?, ?, 0, 1, 'extracted', ?, ?, ?, '["invalidated:notify-pending:rollback"]', ?, ?)
        `,
      ).run(
        sessionId,
        promptNumber,
        `p${promptNumber}`,
        `Prompt ${promptNumber}`,
        `Title ${promptNumber}`,
        `Content ${promptNumber}`,
        promptNumber,
        promptNumber,
      );
    }

    db.query(
      `
        INSERT INTO turns (
          session_id,
          prompt_number,
          content_prompt_id,
          was_interrupted,
          was_rolled_back,
          status,
          user_prompt,
          title,
          content,
          tags,
          created_at_epoch,
          updated_at_epoch
        ) VALUES (?, 13, 'p13', 0, 0, 'extracted', 'Replacement', 'Replacement', 'Replacement content', '[]', 13, 13)
      `,
    ).run(sessionId);

    const turnId = createTurn(db, sessionId, 14);
    const nextTurnId = createTurn(db, sessionId, 15);

    const sentPrompts: string[] = [];
    const core = createWorkerCore({
      db,
      processBatchImpl: async (state, _items, options) => {
        const turnStopItems = options?.turnStopItems ?? [];
        const turnId = turnStopItems[0]?.targetId;
        await state.pushMessage(`<batch><turn id="T${turnId}"/></batch>`);
      },
      createWorkerQuerySessionImpl: ((...args: unknown[]) => {
        const deps = fakeQueryDeps(args);

        return {
          sessionId: "worker-query",
          queryPid: 1234,
          async sendPrompt(prompt: string) {
            sentPrompts.push(prompt);
            deps?.onMessage?.({ session_id: "worker-query" });
            for (const match of prompt.matchAll(/<turn id="T(\d+)"/g)) {
              deps?.onRemember?.(`T${match[1]}`);
            }
            return {
              session_id: "worker-query",
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

    expect(sentPrompts[0]).toContain("<reminder>");
    expect(sentPrompts[0]).not.toContain("T1 (");
    expect(sentPrompts[0]).not.toContain("T2 (");
    expect(sentPrompts[0]).toContain("T3 (was_rolled_back");
    expect(sentPrompts[0]).toContain("T12 (was_rolled_back");

    for (let promptNumber = 1; promptNumber <= 12; promptNumber += 1) {
      expect(getTurn(db, sessionId, promptNumber)?.tags).toEqual([
        "invalidated:notified:rollback",
      ]);
    }

    await core.processClaimedItem({
      seq: 2,
      kind: "turn-stop",
      targetId: nextTurnId,
      sessionDbId: sessionId,
      claimedAtEpoch: 2,
      enqueuedAtEpoch: 2,
    });
    await core.flushSession(sessionId);

    expect(sentPrompts).toHaveLength(2);
    expect(sentPrompts[1]).not.toContain("<reminder>");
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
    const started: string[] = [];
    const core = createWorkerCore({
      db,
      config: {
        mergeThresholdChars: 1,
        maxQueuedBatches: 0,
        keepaliveLeadMs: 60_000,
        cacheMode: "auto",
        ...QUIET_STREAMING,
      },
      createWorkerQuerySessionImpl: ((...args: unknown[]) => {
        const deps = fakeQueryDeps(args);
        return {
          sessionId: "worker-query",
          queryPid: 1234,
          async sendPrompt(prompt: string) {
            const tag = prompt.includes('id="T1"') ? "T1" : "T2";
            started.push(tag);
            if (tag === "T1") {
              await firstGate;
            }
            for (const match of prompt.matchAll(/<turn id="T(\d+)"/g)) {
              deps?.onRemember?.(`T${match[1]}`);
            }
            return { session_id: "worker-query" };
          },
          async close() {},
        } satisfies WorkerQuerySession;
      }) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
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

    expect(started).toEqual(["T1"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(started).toEqual(["T1", "T2"]);
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
        logger: { warn() {}, error() {} },
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
    const sentPrompts: string[] = [];
    const originalSetInterval = globalThis.setInterval;

    globalThis.setInterval = mock(() => 0 as unknown as NodeJS.Timeout) as typeof setInterval;

    try {
      await main({
        db,
        logger: { warn() {}, error() {} },
        BunServeImpl: mock(((options: { fetch: (req: Request) => Promise<Response> }) => {
          fetchHandler = options.fetch;
          return { stop() {} };
        }) as typeof Bun.serve),
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
        isProcessAliveImpl: () => false,
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

      // /flush -> core.flushSession drains + renders the buffered turn as one push.
      expect(sentPrompts).toHaveLength(1);
      expect(sentPrompts[0]).toContain(`<obs id="O`);
    } finally {
      globalThis.setInterval = originalSetInterval;
    }
  });

  // --- Task 9: sendWorkUnit derailment state machine (T2/T3) ---

  // A fake query whose sendPrompt drives the wired onMessage/onRemember to
  // simulate the agent's response, then returns a result. `rememberIds`
  // controls which T ids the agent "remembers" on each sendPrompt (default:
  // none → always a strike). Tracks the resumeAgentSessionId each fake was
  // built with so the fresh-session (no-resume) path can be asserted.
  type FakeDeps = {
    onMessage?: (message: { type?: string; session_id?: string; message?: { content?: unknown } }) => void;
    onRemember?: (id: string) => void;
    onPid?: (pid: number | undefined) => void;
  };

  function makeFakeQueryFactory(opts: {
    rememberIds?: () => number[];
    resumes: Array<string | null | undefined>;
    sentPrompts: string[];
    // Emit a substantive assistant text block (a strike for ∅-required units
    // like a standalone session summary).
    substantiveText?: boolean;
    // Side-effect run on each send (e.g. mirror the real remember() DB write).
    onSend?: (prompt: string) => void;
  }) {
    return ((...args: unknown[]) => {
      const input = args[0] as { resumeAgentSessionId?: string | null };
      const deps = (args.length === 2 ? args[1] : args[3]) as FakeDeps | undefined;
      opts.resumes.push(input.resumeAgentSessionId);
      return {
        sessionId: "fake-agent",
        queryPid: 999,
        async sendPrompt(prompt: string) {
          opts.sentPrompts.push(prompt);
          opts.onSend?.(prompt);
          // Simulate the agent emitting an assistant text block + remembers.
          const ids = opts.rememberIds?.() ?? [];
          deps?.onMessage?.({
            type: "assistant",
            session_id: "fake-agent",
            message: {
              content: [
                ...(opts.substantiveText
                  ? [{ type: "text", text: "Here is my answer." }]
                  : []),
                ...ids.map((id) => ({
                  type: "tool_use",
                  name: "mcp__mnemo__remember",
                  input: { id: `T${id}` },
                })),
              ],
            },
          });
          for (const id of ids) {
            deps?.onRemember?.(`T${id}`);
          }
          return { session_id: "fake-agent" };
        },
        async close() {},
      } satisfies WorkerQuerySession;
    }) as typeof import("../../src/worker/query-session").createWorkerQuerySession;
  }

  function seedDerailSession(contentSessionId: string): number {
    return upsertSession(db, {
      contentSessionId,
      project: "/tmp/project-derail",
      title: "Derail title",
      content: "Derail content",
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
  }

  // Drive the core to create a genuine SessionState (with real pushMessage and
  // unitSignals wiring) by flushing an empty queue, then return it.
  async function realState(
    core: ReturnType<typeof createWorkerCore>,
    sessionId: number,
  ): Promise<SessionState> {
    await core.flushSession(sessionId);
    return core.sessions.get(sessionId)!;
  }

  test("sendWorkUnit resolves on first attempt when required id is remembered", async () => {
    const sessionId = seedDerailSession("derail-resolve-first");
    const sentPrompts: string[] = [];
    const resumes: Array<string | null | undefined> = [];
    const core = createWorkerCore({
      db,
      createWorkerQuerySessionImpl: makeFakeQueryFactory({
        rememberIds: () => [42],
        resumes,
        sentPrompts,
      }),
      isProcessAliveImpl: () => false,
    });

    const state = await realState(core, sessionId);
    await core.sendWorkUnit(state, "<turn id=\"T42\"/>", new Set([42]), true);

    // One initial push, no resends, no re-session.
    expect(sentPrompts).toHaveLength(1);
    expect(sentPrompts[0]).not.toContain("did not extract it");
    expect(resumes).toHaveLength(1); // only the initial session built
  });

  test("sendWorkUnit completion point: resends up to K then re-sessions then floors", async () => {
    const sessionId = seedDerailSession("derail-floor");
    const sentPrompts: string[] = [];
    const resumes: Array<string | null | undefined> = [];
    const core = createWorkerCore({
      db,
      createWorkerQuerySessionImpl: makeFakeQueryFactory({
        rememberIds: () => [], // never remembers → always a strike
        resumes,
        sentPrompts,
      }),
      isProcessAliveImpl: () => false,
    });

    const state = await realState(core, sessionId);

    await expect(
      core.sendWorkUnit(state, "<turn id=\"T7\"/>", new Set([7]), true),
    ).rejects.toBeInstanceOf(DerailmentFloorError);

    // 1 initial + 2 corrective resends (K) on the poisoned session.
    const poisoned = sentPrompts.filter((p) => p.includes("<turn id=\"T7\"/>"));
    expect(poisoned).toHaveLength(4); // initial + 2 resends + 1 fresh-session resend
    // 2 corrective resends before the re-session, then 1 more after.
    expect(
      sentPrompts.filter((p) => p.includes("did not extract it")),
    ).toHaveLength(3);
    // A fresh session was created (initial + one reopened).
    expect(resumes.length).toBeGreaterThanOrEqual(2);
    // The reopened session must NOT resume the poisoned transcript.
    expect(resumes[resumes.length - 1] ?? null).toBeNull();
  });

  test("sendWorkUnit mid slice: resends up to K then skips the slice (no re-session, no floor)", async () => {
    const sessionId = seedDerailSession("derail-mid-slice");
    const sentPrompts: string[] = [];
    const resumes: Array<string | null | undefined> = [];
    const core = createWorkerCore({
      db,
      logger: { warn() {}, error() {} },
      createWorkerQuerySessionImpl: makeFakeQueryFactory({
        rememberIds: () => [], // never remembers
        resumes,
        sentPrompts,
      }),
      isProcessAliveImpl: () => false,
    });

    const state = await realState(core, sessionId);

    // isCompletionPoint=false → after K resends, skip; no throw.
    await core.sendWorkUnit(state, "<turn id=\"T9\" slice=\"2\"/>", new Set([9]), false);

    // 1 initial + 2 corrective resends, then return.
    expect(sentPrompts).toHaveLength(3);
    expect(
      sentPrompts.filter((p) => p.includes("did not extract it")),
    ).toHaveLength(2);
    // No fresh session was created — only the initial session built.
    expect(resumes).toHaveLength(1);
    expect(state.querySession).not.toBeNull(); // session was not torn down
  });

  test("sendWorkUnit cold-start uses a fresh session without resume and is exempt from detection", async () => {
    const sessionId = seedDerailSession("derail-cold-start");
    updateLastAgentSessionId(db, sessionId, "poisoned-agent-session");
    const sentPrompts: string[] = [];
    const resumes: Array<string | null | undefined> = [];
    const core = createWorkerCore({
      db,
      createWorkerQuerySessionImpl: makeFakeQueryFactory({
        rememberIds: () => [], // never remembers (irrelevant to cold-start exemption)
        resumes,
        sentPrompts,
      }),
      isProcessAliveImpl: () => false,
    });

    const state = await realState(core, sessionId);
    // Establish the initial session (lazily built on first push); it resumes
    // the persisted (now poisoned) transcript.
    await state.pushMessage("warmup");
    expect(resumes).toHaveLength(1);
    expect(resumes[0]).toBe("poisoned-agent-session");

    await core.reopenQuerySessionFresh(state);

    // A new fake was built; it must NOT resume the poisoned transcript.
    expect(resumes).toHaveLength(2);
    expect(resumes[1] ?? null).toBeNull();
    // The cold-start render was pushed as CONTEXT ONLY.
    const coldStart = sentPrompts[sentPrompts.length - 1] ?? "";
    expect(coldStart).toContain("CONTEXT ONLY");
    expect(coldStart).toContain(`[S${sessionId}]`);
    // Signals are reset after the cold-start (exempt from detection).
    expect(state.unitSignals.rememberedIds.size).toBe(0);
    expect(state.unitSignals.hadSubstantiveText).toBe(false);
    expect(state.unitSignals.hadIllegalTool).toBe(false);
    // agentSessionId was rewritten to the fresh agent by onMessage.
    expect(state.agentSessionId).toBe("fake-agent");
  });

  // --- Task 10: flush pipeline wiring + D5 finalize-by-status floor ---

  // Insert a turn with an explicit status; the floor finalizes by db status, so
  // tests control the pre-flush record directly. Returns the new turn id.
  function insertTurnWithStatus(
    sessionId: number,
    promptNumber: number,
    status: "active" | "provisional" | "extracted" | "skipped" | "failed" | "undone",
  ): number {
    return db
      .query<{ id: number }, [number, number, string]>(
        `INSERT INTO turns (session_id, prompt_number, status, user_prompt,
           assistant_response, created_at_epoch)
         VALUES (?, ?, ?, 'Prompt', 'Reply', 100) RETURNING id`,
      )
      .get(sessionId, promptNumber, status)!.id;
  }

  // Config that keeps short turns un-merged budget-wise and never force-flushes
  // mid-scan, so a turn-stop lands one whole batch on the queue for flushSession.
  const FLOOR_CONFIG = {
    mergeThresholdChars: 100_000,
    maxQueuedBatches: 50,
    keepaliveLeadMs: 60_000,
    cacheMode: "auto" as const,
    ...QUIET_STREAMING,
  };

  test("mid slice that keeps derailing is skipped without re-session; turn row left as-is", async () => {
    const sessionId = seedDerailSession("derail-mid-slice-status");
    const turnId = insertTurnWithStatus(sessionId, 1, "active");
    const sentPrompts: string[] = [];
    const resumes: Array<string | null | undefined> = [];
    const core = createWorkerCore({
      db,
      logger: { warn() {}, error() {} },
      createWorkerQuerySessionImpl: makeFakeQueryFactory({
        rememberIds: () => [], // never remembers → strike every time
        resumes,
        sentPrompts,
      }),
      isProcessAliveImpl: () => false,
    });

    const state = await realState(core, sessionId);

    // Streaming mid slice (isCompletionPoint=false): resends K, then skips —
    // no fresh session, no DerailmentFloorError, no status change.
    await core.sendWorkUnit(
      state,
      `<turn id="T${turnId}" slice="2"/>`,
      new Set([turnId]),
      false,
    );

    expect(resumes).toHaveLength(1); // no re-session
    expect(getTurnById(db, turnId)?.status).toBe("active"); // row left as-is
  });

  test("final-slice/short floor keeps a partial record an earlier slice produced (no downgrade)", async () => {
    const sessionId = seedDerailSession("derail-floor-keep-partial");
    // An earlier slice already extracted this turn (active → extracted). Its
    // turn-stop now flushes as a final slice that derails to the floor.
    const turnId = insertTurnWithStatus(sessionId, 1, "extracted");
    queueObs(db, sessionId, turnId, 101, "partial");
    queueTurnStop(db, sessionId, turnId, 201);
    const sentPrompts: string[] = [];
    const resumes: Array<string | null | undefined> = [];
    const core = createWorkerCore({
      db,
      config: FLOOR_CONFIG,
      logger: { warn() {}, error() {} },
      createWorkerQuerySessionImpl: makeFakeQueryFactory({
        rememberIds: () => [], // the final slice still derails → floor
        resumes,
        sentPrompts,
      }),
      isProcessAliveImpl: () => false,
    });

    await core.drainSessionCompletely(sessionId);

    // The floor (real applyFloor via the wired pushMiniTurnBatch catch) must NOT
    // downgrade the extracted partial.
    expect(getTurnById(db, turnId)?.status).toBe("extracted");
    // Queue still drained; the floor reached re-session (completion point).
    expect(resumes.length).toBeGreaterThan(1);
  });

  test("short turn floor (never extracted → still active) marks the turn failed", async () => {
    const sessionId = seedDerailSession("derail-floor-skip-active");
    const turnId = insertTurnWithStatus(sessionId, 1, "active");
    queueObs(db, sessionId, turnId, 101, "short");
    queueTurnStop(db, sessionId, turnId, 201);
    const sentPrompts: string[] = [];
    const resumes: Array<string | null | undefined> = [];
    const core = createWorkerCore({
      db,
      config: FLOOR_CONFIG,
      logger: { warn() {}, error() {} },
      createWorkerQuerySessionImpl: makeFakeQueryFactory({
        rememberIds: () => [], // never remembers → floor
        resumes,
        sentPrompts,
      }),
      isProcessAliveImpl: () => false,
    });

    await core.drainSessionCompletely(sessionId);

    expect(getTurnById(db, turnId)?.status).toBe("failed");
  });

  test("merged batch floor: a remembered turn stays extracted; an unremembered one is failed", async () => {
    const sessionId = seedDerailSession("derail-floor-merged");
    // Two short (active) turns merge into one batch. The agent remembers A
    // (mirrored as the real remember() DB write: active → extracted) but never
    // B, so the merged unit strikes and floors with requiredIds = {A, B}.
    const turnA = insertTurnWithStatus(sessionId, 1, "active");
    const turnB = insertTurnWithStatus(sessionId, 2, "active");
    queueObs(db, sessionId, turnA, 101, "merged-a");
    queueObs(db, sessionId, turnB, 102, "merged-b");
    queueTurnStop(db, sessionId, turnA, 201);
    queueTurnStop(db, sessionId, turnB, 202);
    const sentPrompts: string[] = [];
    const resumes: Array<string | null | undefined> = [];
    const core = createWorkerCore({
      db,
      config: FLOOR_CONFIG,
      logger: { warn() {}, error() {} },
      createWorkerQuerySessionImpl: makeFakeQueryFactory({
        // Remember A only (the merged unit still strikes on missing B).
        rememberIds: () => [turnA],
        resumes,
        sentPrompts,
        // Mirror the real remember() side effect for A on every send.
        onSend: () => {
          if (getTurnById(db, turnA)?.status === "active") {
            updateTurnById(db, turnA, { status: "extracted" });
          }
        },
      }),
      isProcessAliveImpl: () => false,
    });

    await core.drainSessionCompletely(sessionId);

    // Per-turn granularity comes from the floor, not from splitting the message.
    expect(getTurnById(db, turnA)?.status).toBe("extracted"); // kept
    expect(getTurnById(db, turnB)?.status).toBe("failed"); // finalized
  });

  // Regression: a turn that streamed ≥1 mid-slice is `provisional` (not active).
  // If it derails at the floor it must be TERMINATED — never left provisional —
  // or getStrandedTurns re-enqueues it forever (no terminal bound).
  test("provisional turn with partial content at the floor is finalized extracted (terminal, not stranded)", async () => {
    const sessionId = seedDerailSession("derail-floor-provisional-partial");
    // A mid-slice already wrote partial content, moving the turn provisional.
    // The turn-stop's final slice then derails to the floor.
    const turnId = insertTurnWithStatus(sessionId, 1, "provisional");
    updateTurnById(db, turnId, {
      status: "provisional",
      title: "Partial title",
      content: "Partial content from a mid-slice",
    });
    expect(getTurnById(db, turnId)?.status).toBe("provisional");
    queueObs(db, sessionId, turnId, 101, "partial");
    queueTurnStop(db, sessionId, turnId, 201);
    const sentPrompts: string[] = [];
    const resumes: Array<string | null | undefined> = [];
    const core = createWorkerCore({
      db,
      config: FLOOR_CONFIG,
      logger: { warn() {}, error() {} },
      createWorkerQuerySessionImpl: makeFakeQueryFactory({
        rememberIds: () => [], // the final slice still derails → floor
        resumes,
        sentPrompts,
      }),
      isProcessAliveImpl: () => false,
    });

    await core.drainSessionCompletely(sessionId);

    // Terminated as extracted (keeps the partial), NOT left provisional.
    expect(getTurnById(db, turnId)?.status).toBe("extracted");
    // The partial content is preserved.
    expect(getTurnById(db, turnId)?.content).toBe(
      "Partial content from a mid-slice",
    );
    // And it is no longer stranded — a resume will not re-enqueue it.
    expect(getStrandedTurns(db, sessionId).map((t) => t.id)).not.toContain(
      turnId,
    );
  });

  test("provisional turn with no content at the floor is finalized failed (terminal, not stranded)", async () => {
    const sessionId = seedDerailSession("derail-floor-provisional-empty");
    // Provisional (a mid-slice streamed) but produced no usable extraction
    // (title/content still null); the final slice derails to the floor.
    const turnId = insertTurnWithStatus(sessionId, 1, "provisional");
    expect(getTurnById(db, turnId)?.status).toBe("provisional");
    expect(getTurnById(db, turnId)?.title).toBeNull();
    expect(getTurnById(db, turnId)?.content).toBeNull();
    queueObs(db, sessionId, turnId, 101, "empty");
    queueTurnStop(db, sessionId, turnId, 201);
    const sentPrompts: string[] = [];
    const resumes: Array<string | null | undefined> = [];
    const core = createWorkerCore({
      db,
      config: FLOOR_CONFIG,
      logger: { warn() {}, error() {} },
      createWorkerQuerySessionImpl: makeFakeQueryFactory({
        rememberIds: () => [], // never remembers → floor
        resumes,
        sentPrompts,
      }),
      isProcessAliveImpl: () => false,
    });

    await core.drainSessionCompletely(sessionId);

    // Content-less provisional → failed (terminal), not left provisional.
    expect(getTurnById(db, turnId)?.status).toBe("failed");
    expect(getStrandedTurns(db, sessionId).map((t) => t.id)).not.toContain(
      turnId,
    );
  });

  test("session-summary floor abandons refresh (no turn skipped), queue still drains", async () => {
    const sessionId = seedDerailSession("derail-floor-summary");
    const turnId = insertTurnWithStatus(sessionId, 1, "active");
    const sentPrompts: string[] = [];
    const resumes: Array<string | null | undefined> = [];
    const warns: unknown[][] = [];
    const core = createWorkerCore({
      db,
      config: FLOOR_CONFIG,
      logger: { warn: (...a: unknown[]) => warns.push(a), error() {} },
      // The summary push routes through the worker's sendWorkUnit sender
      // (∅ required ids, completion point); a strike floors → abandon.
      pushSessionSummaryPromptImpl: async (state, _sessionId, send) => {
        await (send ?? state.pushMessage)("<session>refresh</session>");
      },
      createWorkerQuerySessionImpl: makeFakeQueryFactory({
        // A ∅-required summary resolves on an empty response, so force a strike
        // with substantive prose to exercise the abandon path.
        rememberIds: () => [],
        substantiveText: true,
        resumes,
        sentPrompts,
      }),
      isProcessAliveImpl: () => false,
    });

    await core.handleCompact(sessionId, null);

    // A summary floor never skips a turn.
    expect(getTurnById(db, turnId)?.status).toBe("active");
    expect(
      warns.some((a) => String(a[0]).includes("abandoning session-summary")),
    ).toBe(true);
    // The queue still drains (no leftover items for the session).
    expect(
      db
        .query<{ count: number }, [number]>(
          "SELECT COUNT(*) AS count FROM pending_queue WHERE session_db_id = ?",
        )
        .get(sessionId)?.count,
    ).toBe(0);
  });
});
