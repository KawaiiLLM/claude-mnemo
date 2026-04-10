import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import {
  acquireWorkerSingleton,
  createWorkerCore,
  createWorkerFetchHandler,
} from "../../src/worker/server";

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

  test("createWorkerCore serializes same-session items and recovers claimed rows", async () => {
    db.query(
      `
        INSERT INTO pending_queue (kind, target_id, session_db_id, claimed_at_epoch, enqueued_at_epoch)
        VALUES
          ('obs', 1, 11, NULL, 1),
          ('turn-stop', 2, 11, NULL, 2),
          ('obs', 3, 12, 999, 3)
      `,
    ).run();

    const started: string[] = [];
    const finished: string[] = [];
    let resolveFirstObs!: () => void;
    const firstObsGate = new Promise<void>((resolve) => {
      resolveFirstObs = resolve;
    });

    const core = createWorkerCore({
      db,
      now: () => 123,
      processObsImpl: async (_state, observationId) => {
        started.push(`obs:${observationId}`);
        if (observationId === 1) {
          await firstObsGate;
        }
        finished.push(`obs:${observationId}`);
      },
      processTurnStopImpl: async (_state, turnId) => {
        started.push(`turn:${turnId}`);
        finished.push(`turn:${turnId}`);
      },
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
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM pending_queue").get()
        ?.count,
    ).toBe(0);
  });

  test("handleCompact drains the session, pushes summary, and closes query", async () => {
    db.query(
      `
        INSERT INTO pending_queue (kind, target_id, session_db_id, claimed_at_epoch, enqueued_at_epoch)
        VALUES
          ('obs', 1, 20, NULL, 1),
          ('turn-stop', 2, 20, NULL, 2),
          ('obs', 3, 21, NULL, 3)
      `,
    ).run();

    const processed: string[] = [];
    const pushed: number[] = [];
    const closed: number[] = [];

    const core = createWorkerCore({
      db,
      processObsImpl: async (_state, observationId) => {
        processed.push(`obs:${observationId}`);
      },
      processTurnStopImpl: async (_state, turnId) => {
        processed.push(`turn:${turnId}`);
      },
      pushSessionSummaryPromptImpl: async (sessionId) => {
        pushed.push(sessionId);
      },
      closeSessionQueryImpl: async (sessionId) => {
        closed.push(sessionId);
      },
    });

    await core.handleCompact(20, "/tmp/session.jsonl");

    expect(processed).toEqual(["obs:1", "turn:2"]);
    expect(pushed).toEqual([20]);
    expect(closed).toEqual([20]);
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM pending_queue WHERE session_db_id = 20",
        )
        .get()?.count,
    ).toBe(0);
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM pending_queue WHERE session_db_id = 21",
        )
        .get()?.count,
    ).toBe(1);
  });
});
