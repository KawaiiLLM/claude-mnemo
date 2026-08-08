import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { getPendingQueueCount } from "../../src/db/pending-queue";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurnById } from "../../src/db/turns";
import { DEFAULT_CONFIG } from "../../src/shared/config";
import { classifyWorkerError } from "../../src/worker/error-classifier";
import { DELIVERY_DROPPED_PENDING_TAG } from "../../src/worker/invalidation";
import {
  createHardExitTimer,
  createWorkerCore,
} from "../../src/worker/server";
import type { WorkerQuerySession } from "../../src/worker/query-session";

function seedQueuedTurn(db: Database, contentSessionId: string): {
  sessionId: number;
  turnId: number;
} {
  const sessionId = upsertSession(db, {
    contentSessionId,
    project: `/projects/${contentSessionId}`,
    title: null,
    content: null,
    insight: null,
    createdAtEpoch: 1,
    updatedAtEpoch: 1,
    completedAtEpoch: null,
  }).id;
  const turnId = db
    .query<{ id: number }, [number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt,
         assistant_response, created_at_epoch
       ) VALUES (?, 1, 'active', 'Prompt', 'Response', 10)
       RETURNING id`,
    )
    .get(sessionId)!.id;
  db.query(
    `INSERT INTO pending_queue (
       kind, target_id, session_db_id, enqueued_at_epoch
     ) VALUES ('turn-stop', ?, ?, 20)`,
  ).run(turnId, sessionId);
  return { sessionId, turnId };
}

describe("SessionEnd bounded tail", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("a completed tail immediately closes only its own memory agent", async () => {
    const ending = seedQueuedTurn(db, "ending-session");
    const active = seedQueuedTurn(db, "active-session");
    const closed: number[] = [];
    const core = createWorkerCore({
      db,
      config: { ...DEFAULT_CONFIG, maxQueuedBatches: 0 },
      createWorkerQuerySessionImpl: ((...args: unknown[]) => {
        const input = args[0] as { sessionDbId: number };
        const deps = args[1] as { onRemember?: (id: string) => void };
        return {
          sessionId: `agent-${input.sessionDbId}`,
          queryPid: undefined,
          async sendPrompt(prompt: string) {
            for (const match of prompt.matchAll(/<turn id="T(\d+)"/g)) {
              deps.onRemember?.(`T${match[1]}`);
            }
            return { session_id: `agent-${input.sessionDbId}` };
          },
          async close() {
            closed.push(input.sessionDbId);
          },
        } satisfies WorkerQuerySession;
      }) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
      isProcessAliveImpl: () => false,
    });

    await core.flushSession(active.sessionId);
    expect(core.sessions.has(active.sessionId)).toBe(true);

    await core.finishSession(ending.sessionId);

    expect(getPendingQueueCount(db, ending.sessionId)).toBe(0);
    expect(core.sessions.has(ending.sessionId)).toBe(false);
    expect(core.sessions.has(active.sessionId)).toBe(true);
    expect(closed).toEqual([ending.sessionId]);
  });

  test("a tail timeout aborts in-flight inference and releases the turn for a later wake", async () => {
    const ending = seedQueuedTurn(db, "timed-out-session");
    let rejectPush: ((error: unknown) => void) | undefined;
    let fireTailTimeout: (() => void) | undefined;
    const closeErrors: Error[] = [];
    let closeCalls = 0;
    let currentMs = 1_000;
    let agentCreations = 0;
    let recoveryPushes = 0;
    const core = createWorkerCore({
      db,
      config: {
        ...DEFAULT_CONFIG,
        maxQueuedBatches: 0,
        sessionEndTailTimeoutMs: 1_234,
      },
      nowMs: () => currentMs,
      setTimeoutImpl(callback, delayMs) {
        if (delayMs === 1_234) {
          fireTailTimeout = () => void callback();
          return "tail-timeout";
        }
        return setTimeout(() => void callback(), delayMs);
      },
      clearTimeoutImpl(handle) {
        if (handle !== "tail-timeout") {
          clearTimeout(handle as ReturnType<typeof setTimeout>);
        }
      },
      createWorkerQuerySessionImpl: ((...args: unknown[]) => {
        agentCreations += 1;
        const queryDeps = args[1] as { onRemember?: (id: string) => void };
        if (agentCreations > 1) {
          return {
            sessionId: "recovered-agent",
            queryPid: undefined,
            async sendPrompt(prompt: string) {
              recoveryPushes += 1;
              for (const match of prompt.matchAll(/<turn id="T(\d+)"/g)) {
                queryDeps.onRemember?.(`T${match[1]}`);
              }
              return { session_id: "recovered-agent" };
            },
            async close() {},
          } satisfies WorkerQuerySession;
        }
        return {
          sessionId: "timed-out-agent",
          queryPid: 4321,
          async sendPrompt() {
            return new Promise<never>((_resolve, reject) => {
              rejectPush = reject;
            });
          },
          async close(abortError?: Error) {
            closeCalls += 1;
            if (abortError) {
              closeErrors.push(abortError);
              rejectPush?.(abortError);
            }
          },
        } satisfies WorkerQuerySession;
      }) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
      isProcessAliveImpl: () => false,
      logger: { warn() {}, error() {} },
    });

    const finishPromise = core.finishSession(ending.sessionId);
    for (let tick = 0; tick < 50 && !rejectPush; tick += 1) {
      await Promise.resolve();
    }
    expect(rejectPush).toBeDefined();
    expect(fireTailTimeout).toBeDefined();
    fireTailTimeout?.();
    await finishPromise;

    expect(closeCalls).toBe(1);
    expect(closeErrors).toHaveLength(1);
    expect(classifyWorkerError(closeErrors[0])).toBe("connection");
    expect(core.sessions.has(ending.sessionId)).toBe(false);
    expect(getPendingQueueCount(db, ending.sessionId)).toBe(1);
    expect(
      db.query<{ claimedAtEpoch: number | null }, [number]>(
        `SELECT claimed_at_epoch AS claimedAtEpoch
         FROM pending_queue WHERE session_db_id = ?`,
      ).get(ending.sessionId)?.claimedAtEpoch,
    ).toBeNull();
    expect(getTurnById(db, ending.turnId)?.status).toBe("active");
    expect(getTurnById(db, ending.turnId)?.tags ?? []).not.toContain(
      DELIVERY_DROPPED_PENDING_TAG,
    );

    currentMs += 10_001;
    await core.scanAndDrainQueue();
    expect(recoveryPushes).toBe(1);
    expect(getPendingQueueCount(db, ending.sessionId)).toBe(0);
  });

  test("a connection failure suspends the tail without retrying or dropping it", async () => {
    const ending = seedQueuedTurn(db, "connection-session");
    let pushes = 0;
    const closeErrors: Error[] = [];
    const core = createWorkerCore({
      db,
      // The seeded turn is stamped at epoch 10. Pin the clock there so the
      // suspended row sits on the still-open content-day: a real connection
      // failure is same-day, and the stranded repair must not floor it.
      now: () => 10,
      config: { ...DEFAULT_CONFIG, maxQueuedBatches: 0 },
      createWorkerQuerySessionImpl: (() => ({
        sessionId: "connection-agent",
        queryPid: undefined,
        async sendPrompt() {
          pushes += 1;
          throw Object.assign(new Error("socket reset"), {
            code: "ECONNRESET",
          });
        },
        async close(abortError?: Error) {
          if (abortError) {
            closeErrors.push(abortError);
          }
        },
      } satisfies WorkerQuerySession)) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
      isProcessAliveImpl: () => false,
      logger: { warn() {}, error() {} },
    });

    await core.finishSession(ending.sessionId);

    expect(pushes).toBe(1);
    expect(closeErrors.map(classifyWorkerError)).toEqual(["connection"]);
    expect(core.sessions.has(ending.sessionId)).toBe(false);
    expect(getPendingQueueCount(db, ending.sessionId)).toBe(1);
    expect(
      db.query<{ claimedAtEpoch: number | null }, [number]>(
        `SELECT claimed_at_epoch AS claimedAtEpoch
         FROM pending_queue WHERE session_db_id = ?`,
      ).get(ending.sessionId)?.claimedAtEpoch,
    ).toBeNull();
    expect(getTurnById(db, ending.turnId)?.tags ?? []).not.toContain(
      DELIVERY_DROPPED_PENDING_TAG,
    );
  });

  test("hard-exit timer aborts a hung extraction, requeues without a strike, and exits at the cap", async () => {
    const ending = seedQueuedTurn(db, "hard-exit-session");
    let rejectPush: ((error: unknown) => void) | undefined;
    let pushes = 0;
    const closeErrors: Error[] = [];
    const core = createWorkerCore({
      db,
      config: { ...DEFAULT_CONFIG, maxQueuedBatches: 0 },
      createWorkerQuerySessionImpl: (() => ({
        sessionId: "hung-agent",
        queryPid: undefined,
        async sendPrompt() {
          pushes += 1;
          return new Promise<never>((_resolve, reject) => {
            rejectPush = reject;
          });
        },
        async close(abortError?: Error) {
          if (abortError) {
            closeErrors.push(abortError);
            rejectPush?.(abortError);
          }
        },
      } satisfies WorkerQuerySession)) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
      closeSessionQueryImpl: async () =>
        new Promise<void>(() => {}),
      isProcessAliveImpl: () => false,
      logger: { warn() {}, error() {} },
    });

    const flush = core.flushSession(ending.sessionId);
    for (let tick = 0; tick < 50 && !rejectPush; tick += 1) {
      await Promise.resolve();
    }
    expect(rejectPush).toBeDefined();

    let fireHardExit: (() => Promise<void>) | undefined;
    const delays: number[] = [];
    const shutdownGracefully = mock(async () =>
      new Promise<void>(() => {})
    );
    const processExit = mock((_code?: number) => undefined as never);
    const hardExitTimer = createHardExitTimer({
      config: { ...DEFAULT_CONFIG, hardExitTimeoutMs: 70_000 },
      sessionEnvRegistry: new Map(),
      abortAllExtractionSessionsImpl:
        core.abortAllExtractionSessionsForShutdown,
      setTimeoutImpl(callback, delayMs) {
        delays.push(delayMs);
        fireHardExit = async () => {
          await callback();
        };
        return "hard-exit";
      },
      clearTimeoutImpl() {},
      shutdownGracefullyImpl: shutdownGracefully,
      unlinkSyncImpl: (() => undefined) as typeof import("node:fs").unlinkSync,
      processImpl: {
        pid: process.pid,
        on: (() => process) as typeof process.on,
        exit: processExit,
      },
      logger: { warn() {}, error() {} },
    });

    hardExitTimer.arm();
    expect(delays).toEqual([70_000]);
    expect(processExit).not.toHaveBeenCalled();
    await fireHardExit?.();
    void flush.catch(() => {});

    const turn = getTurnById(db, ending.turnId);
    expect(pushes).toBe(1);
    expect(closeErrors.map(classifyWorkerError)).toEqual(["connection"]);
    expect(getPendingQueueCount(db, ending.sessionId)).toBe(1);
    expect(
      db.query<{ claimedAtEpoch: number | null }, [number]>(
        `SELECT claimed_at_epoch AS claimedAtEpoch
         FROM pending_queue WHERE session_db_id = ?`,
      ).get(ending.sessionId)?.claimedAtEpoch,
    ).toBeNull();
    expect(turn?.status).toBe("active");
    expect(turn?.extractionStallAttempts).toBe(0);
    expect(turn?.tags ?? []).not.toContain(DELIVERY_DROPPED_PENDING_TAG);
    expect(shutdownGracefully).toHaveBeenCalledTimes(1);
    expect(processExit).toHaveBeenCalledWith(0);
  });
});
