import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { createObservation } from "../../src/db/observations";
import { getPendingQueueCount } from "../../src/db/pending-queue";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { DEFAULT_CONFIG } from "../../src/shared/config";
import { createWorkerCore } from "../../src/worker/server";
import type { WorkerQuerySession } from "../../src/worker/query-session";

function queueTurn(
  db: Database,
  sessionId: number,
  promptNumber: number,
  status: "active" | "provisional" = "active",
): number {
  const turnId = db
    .query<{ id: number }, [number, number, string]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt,
         assistant_response, created_at_epoch
       ) VALUES (?, ?, ?, 'Prompt', 'Response', 10)
       RETURNING id`,
    )
    .get(sessionId, promptNumber, status)!.id;
  db.query(
    `INSERT INTO pending_queue (
       kind, target_id, session_db_id, enqueued_at_epoch
     ) VALUES ('turn-stop', ?, ?, ?)`,
  ).run(turnId, sessionId, 100 + promptNumber);
  return turnId;
}

function recordingQuery(sentPrompts: string[]): typeof import("../../src/worker/query-session").createWorkerQuerySession {
  return ((...args: unknown[]) => {
    const deps = args[1] as { onRemember?: (id: string) => void };
    return {
      sessionId: "closed-batch-agent",
      queryPid: undefined,
      async sendPrompt(prompt: string) {
        sentPrompts.push(prompt);
        for (const match of prompt.matchAll(/<turn id="T(\d+)"/g)) {
          deps.onRemember?.(`T${match[1]}`);
        }
        return { session_id: "closed-batch-agent" };
      },
      async close() {},
    } satisfies WorkerQuerySession;
  }) as typeof import("../../src/worker/query-session").createWorkerQuerySession;
}

describe("closed batch eager flush", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("a cold drain flushes the closed non-tail batch and keeps the open tail", async () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "closed-batch-cold",
      project: "/projects/closed-batch",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    const closedTurnId = queueTurn(db, sessionId, 1, "provisional");
    const openTurnId = queueTurn(db, sessionId, 2);
    const sentPrompts: string[] = [];
    const core = createWorkerCore({
      db,
      now: () => 123,
      config: {
        ...DEFAULT_CONFIG,
        mergeThresholdChars: 100_000,
        maxQueuedBatches: 5,
      },
      createWorkerQuerySessionImpl: recordingQuery(sentPrompts),
    });

    await core.scanAndDrainQueue();

    expect(sentPrompts).toHaveLength(1);
    expect(sentPrompts[0]).toContain(`<turn id="T${closedTurnId}"`);
    expect(sentPrompts[0]).not.toContain(`<turn id="T${openTurnId}"`);
    expect(getPendingQueueCount(db, sessionId)).toBe(1);
  });

  test("a tail at the merge threshold flushes during drain completion", async () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "full-tail",
      project: "/projects/closed-batch",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    const turnId = queueTurn(db, sessionId, 1);
    const sentPrompts: string[] = [];
    const core = createWorkerCore({
      db,
      now: () => 123,
      config: {
        ...DEFAULT_CONFIG,
        mergeThresholdChars: 1,
        maxQueuedBatches: 5,
      },
      createWorkerQuerySessionImpl: recordingQuery(sentPrompts),
    });

    await core.scanAndDrainQueue();

    expect(sentPrompts).toHaveLength(1);
    expect(sentPrompts[0]).toContain(`<turn id="T${turnId}"`);
    expect(getPendingQueueCount(db, sessionId)).toBe(0);
  });

  test("a burst is fully enqueued before slow closed-batch inference starts", async () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "burst-before-flush",
      project: "/projects/closed-batch",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    const turnIds = [1, 2, 3].map((promptNumber) =>
      queueTurn(db, sessionId, promptNumber),
    );
    const streamingTurnId = db
      .query<{ id: number }, [number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt,
           assistant_response, created_at_epoch
         ) VALUES (?, 4, 'active', 'Streaming prompt', 'In progress', 10)
         RETURNING id`,
      )
      .get(sessionId)!.id;
    const streamingObservationId = createObservation(db, {
      turnId: streamingTurnId,
      toolName: "Read",
      toolInput: '{"file_path":"src/later.ts"}',
      toolResult: "later observation",
      status: "pending",
      createdAtEpoch: 104,
    }).id;
    db.query(
      `INSERT INTO pending_queue (
         kind, target_id, session_db_id, enqueued_at_epoch
       ) VALUES ('obs', ?, ?, 104)`,
    ).run(streamingObservationId, sessionId);
    let reportStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      reportStarted = resolve;
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const sentPrompts: string[] = [];
    let sends = 0;
    const core = createWorkerCore({
      db,
      now: () => 123,
      config: {
        ...DEFAULT_CONFIG,
        mergeThresholdChars: 1,
        maxQueuedBatches: 0,
      },
      createWorkerQuerySessionImpl: ((...args: unknown[]) => {
        const deps = args[1] as { onRemember?: (id: string) => void };
        return {
          sessionId: "slow-closed-batch-agent",
          queryPid: undefined,
          async sendPrompt(prompt: string) {
            sends += 1;
            sentPrompts.push(prompt);
            if (sends === 1) {
              reportStarted();
              await firstGate;
            }
            for (const match of prompt.matchAll(/<turn id="T(\d+)"/g)) {
              deps.onRemember?.(`T${match[1]}`);
            }
            return { session_id: "slow-closed-batch-agent" };
          },
          async close() {},
        } satisfies WorkerQuerySession;
      }) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
    });

    const drain = core.scanAndDrainQueue();
    await started;

    const claims = db
      .query<{ targetId: number; claimedAtEpoch: number | null }, [number]>(
        `SELECT target_id AS targetId, claimed_at_epoch AS claimedAtEpoch
         FROM pending_queue
         WHERE session_db_id = ?
         ORDER BY seq`,
      )
      .all(sessionId);
    expect(claims).toHaveLength(4);
    expect(claims.every((row) => row.claimedAtEpoch === 123)).toBe(true);
    expect(
      core.buffers
        .get(sessionId)
        ?.items.some((item) => item.targetId === streamingObservationId),
    ).toBe(true);

    releaseFirst();
    await drain;
    expect(sentPrompts).toHaveLength(3);
    expect(
      sentPrompts.every((prompt, index) =>
        prompt.includes(`<turn id="T${turnIds[index]}"`),
      ),
    ).toBe(true);
    expect(getPendingQueueCount(db, sessionId)).toBe(1);
  });

  test("the maxQueuedBatches overflow cap still flushes an otherwise open tail", async () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "open-tail-overflow",
      project: "/projects/closed-batch",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    const turnId = queueTurn(db, sessionId, 1);
    const sentPrompts: string[] = [];
    const core = createWorkerCore({
      db,
      now: () => 123,
      config: {
        ...DEFAULT_CONFIG,
        mergeThresholdChars: 100_000,
        maxQueuedBatches: 0,
      },
      createWorkerQuerySessionImpl: recordingQuery(sentPrompts),
    });

    await core.scanAndDrainQueue();

    expect(sentPrompts).toHaveLength(1);
    expect(sentPrompts[0]).toContain(`<turn id="T${turnId}"`);
    expect(getPendingQueueCount(db, sessionId)).toBe(0);
  });

  test("retryLater stops eager tail flushing at the FIFO head", async () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "closed-batch-retry",
      project: "/projects/closed-batch",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    queueTurn(db, sessionId, 1, "provisional");
    queueTurn(db, sessionId, 2);
    let sends = 0;
    const core = createWorkerCore({
      db,
      now: () => 123,
      config: {
        ...DEFAULT_CONFIG,
        mergeThresholdChars: 100_000,
        maxQueuedBatches: 5,
      },
      logger: { warn() {}, error() {} },
      createWorkerQuerySessionImpl: (() => ({
        sessionId: "closed-batch-retry-agent",
        queryPid: undefined,
        async sendPrompt() {
          sends += 1;
          throw new Error("deterministic delivery failure");
        },
        async close() {},
      } satisfies WorkerQuerySession)) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
    });

    await core.scanAndDrainQueue();

    expect(sends).toBe(1);
    expect(getPendingQueueCount(db, sessionId)).toBe(2);
    expect(
      db
        .query<{ claimedAtEpoch: number | null }, [number]>(
          `SELECT claimed_at_epoch AS claimedAtEpoch
           FROM pending_queue WHERE session_db_id = ?`,
        )
        .all(sessionId)
        .every((row) => row.claimedAtEpoch === 123),
    ).toBe(true);

    await core.runRetryTick();
    expect(sends).toBe(2);
    expect(getPendingQueueCount(db, sessionId)).toBe(2);
  });

  test("a suspended session releases every eager-tail claim and is not retried by the same drain", async () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "closed-batch-suspended",
      project: "/projects/closed-batch",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    queueTurn(db, sessionId, 1, "provisional");
    queueTurn(db, sessionId, 2);
    let sends = 0;
    const core = createWorkerCore({
      db,
      now: () => 123,
      nowMs: () => 1_000,
      config: {
        ...DEFAULT_CONFIG,
        mergeThresholdChars: 100_000,
        maxQueuedBatches: 5,
      },
      logger: { warn() {}, error() {} },
      createWorkerQuerySessionImpl: (() => ({
        sessionId: "closed-batch-suspended-agent",
        queryPid: undefined,
        async sendPrompt() {
          sends += 1;
          throw Object.assign(new Error("socket reset"), {
            code: "ECONNRESET",
          });
        },
        async close() {},
      } satisfies WorkerQuerySession)) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
      isProcessAliveImpl: () => false,
    });

    await core.scanAndDrainQueue();

    expect(sends).toBe(1);
    expect(core.sessions.has(sessionId)).toBe(false);
    expect(getPendingQueueCount(db, sessionId)).toBe(2);
    expect(
      db
        .query<{ claimedAtEpoch: number | null }, [number]>(
          `SELECT claimed_at_epoch AS claimedAtEpoch
           FROM pending_queue WHERE session_db_id = ?`,
        )
        .all(sessionId)
        .every((row) => row.claimedAtEpoch === null),
    ).toBe(true);

    await core.scanAndDrainQueue();
    expect(sends).toBe(1);
  });
});
