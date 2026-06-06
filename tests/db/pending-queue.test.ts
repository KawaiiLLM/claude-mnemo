import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase, isSqliteBusy } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import {
  claimNextQueueItem,
  deleteQueueItem,
  enqueueQueueItem,
  getPendingQueueCount,
  listPendingQueueItems,
  queueItemExistsForTurn,
  resetClaimedQueueItems,
  resetQueueItemClaim,
} from "../../src/db/pending-queue";

function createTempDatabasePath(prefix: string): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  return {
    directory,
    path: join(directory, "mnemo.sqlite"),
  };
}

function rollbackIfOpen(db: Database): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // No active transaction.
  }
}

function captureError(fn: () => void): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }

  return null;
}

describe("pending_queue helpers", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("claims the earliest unclaimed item in FIFO order", () => {
    const first = enqueueQueueItem(db, {
      kind: "obs",
      targetId: 11,
      sessionDbId: 1,
      enqueuedAtEpoch: 100,
    });
    const second = enqueueQueueItem(db, {
      kind: "turn-stop",
      targetId: 22,
      sessionDbId: 1,
      enqueuedAtEpoch: 101,
    });

    const claimed = claimNextQueueItem(db, 500);

    expect(claimed).toEqual({
      seq: first.seq,
      kind: "obs",
      targetId: 11,
      sessionDbId: 1,
      claimedAtEpoch: 500,
      enqueuedAtEpoch: 100,
    });
    expect(listPendingQueueItems(db).map((item) => item.seq)).toEqual([
      first.seq,
      second.seq,
    ]);
  });

  test("claims through an immediate retrying write transaction", () => {
    let immediateCalls = 0;
    const fakeDb = {
      transaction<T>(fn: (...args: unknown[]) => T) {
        const wrapped = ((...args: unknown[]) => fn(...args)) as ((...args: unknown[]) => T) & {
          immediate: () => T;
        };

        wrapped.immediate = () => {
          immediateCalls += 1;
          return fn();
        };

        return wrapped;
      },
      query(sql: string) {
        if (sql.includes("FROM pending_queue")) {
          return {
            get() {
              return {
                seq: 7,
                kind: "obs",
                targetId: 88,
                sessionDbId: 3,
                claimedAtEpoch: null,
                enqueuedAtEpoch: 123,
              };
            },
          };
        }

        if (sql.includes("UPDATE pending_queue")) {
          return {
            run() {
              return { changes: 1 };
            },
          };
        }

        throw new Error(`unexpected query: ${sql}`);
      },
    } as unknown as Database;

    const claimed = claimNextQueueItem(fakeDb, 900);

    expect(immediateCalls).toBe(1);
    expect(claimed).toEqual({
      seq: 7,
      kind: "obs",
      targetId: 88,
      sessionDbId: 3,
      claimedAtEpoch: 900,
      enqueuedAtEpoch: 123,
    });
  });

  test("old deferred queue claims fail with SQLITE_BUSY_SNAPSHOT after another connection claims", () => {
    const temp = createTempDatabasePath("claude-mnemo-queue-snapshot-");
    const staleReader = createDatabase(temp.path, { busyTimeoutMs: 0 });
    const claimer = createDatabase(temp.path, { busyTimeoutMs: 0 });

    try {
      initializeSchema(staleReader);
      enqueueQueueItem(staleReader, {
        kind: "turn-stop",
        targetId: 42,
        sessionDbId: 7,
        enqueuedAtEpoch: 100,
      });

      staleReader.exec("BEGIN DEFERRED");
      const selected = staleReader
        .query<{ seq: number }, []>(
          `
            SELECT seq
            FROM pending_queue
            WHERE claimed_at_epoch IS NULL
            ORDER BY seq ASC
            LIMIT 1
          `,
        )
        .get();
      expect(selected?.seq).toBe(1);

      const claimed = claimNextQueueItem(claimer, 200);
      expect(claimed).toEqual({
        seq: 1,
        kind: "turn-stop",
        targetId: 42,
        sessionDbId: 7,
        claimedAtEpoch: 200,
        enqueuedAtEpoch: 100,
      });

      const err = captureError(() => {
        staleReader
          .query<unknown, [number, number]>(
            `
              UPDATE pending_queue
              SET claimed_at_epoch = ?
              WHERE seq = ? AND claimed_at_epoch IS NULL
            `,
          )
          .run(300, selected!.seq);
      });

      expect(isSqliteBusy(err)).toBe(true);
      expect((err as { code?: unknown })?.code).toBe("SQLITE_BUSY_SNAPSHOT");
      expect(listPendingQueueItems(claimer)).toEqual([
        {
          seq: 1,
          kind: "turn-stop",
          targetId: 42,
          sessionDbId: 7,
          claimedAtEpoch: 200,
          enqueuedAtEpoch: 100,
        },
      ]);
    } finally {
      rollbackIfOpen(staleReader);
      rollbackIfOpen(claimer);
      staleReader.close();
      claimer.close();
      rmSync(temp.directory, { recursive: true, force: true });
    }
  });

  test("supports session filtering and session exclusion while claiming", () => {
    const sessionOne = enqueueQueueItem(db, {
      kind: "obs",
      targetId: 1,
      sessionDbId: 10,
      enqueuedAtEpoch: 100,
    });
    const sessionTwo = enqueueQueueItem(db, {
      kind: "turn-stop",
      targetId: 2,
      sessionDbId: 20,
      enqueuedAtEpoch: 101,
    });

    const filtered = claimNextQueueItem(db, 200, { sessionFilter: 20 });
    const excluded = claimNextQueueItem(db, 201, {
      excludeSessions: new Set([20]),
    });

    expect(filtered?.seq).toBe(sessionTwo.seq);
    expect(excluded?.seq).toBe(sessionOne.seq);
  });

  test("can skip already-failed queue items within a drain pass", () => {
    const first = enqueueQueueItem(db, {
      kind: "obs",
      targetId: 1,
      sessionDbId: 1,
      enqueuedAtEpoch: 100,
    });
    const second = enqueueQueueItem(db, {
      kind: "obs",
      targetId: 2,
      sessionDbId: 1,
      enqueuedAtEpoch: 101,
    });

    const claimed = claimNextQueueItem(db, 300, {
      skippedSeqs: new Set([first.seq]),
    });

    expect(claimed?.seq).toBe(second.seq);
  });

  test("resets claimed items and deletes finished work", () => {
    const first = enqueueQueueItem(db, {
      kind: "obs",
      targetId: 1,
      sessionDbId: 1,
      enqueuedAtEpoch: 100,
    });
    const second = enqueueQueueItem(db, {
      kind: "turn-stop",
      targetId: 2,
      sessionDbId: 1,
      enqueuedAtEpoch: 101,
    });

    claimNextQueueItem(db, 400, { sessionFilter: 1 });
    claimNextQueueItem(db, 401, { sessionFilter: 1 });
    expect(getPendingQueueCount(db, 1)).toBe(2);

    resetQueueItemClaim(db, second.seq);
    let rows = listPendingQueueItems(db);
    expect(rows.find((row) => row.seq === second.seq)?.claimedAtEpoch).toBeNull();

    resetClaimedQueueItems(db);
    rows = listPendingQueueItems(db);
    expect(rows.every((row) => row.claimedAtEpoch === null)).toBe(true);

    deleteQueueItem(db, first.seq);
    expect(getPendingQueueCount(db, 1)).toBe(1);
  });

  test("queueItemExistsForTurn detects an existing item of a kind for a target", () => {
    enqueueQueueItem(db, { kind: "turn-stop", targetId: 42, sessionDbId: 1, enqueuedAtEpoch: 1 });

    expect(queueItemExistsForTurn(db, "turn-stop", 42)).toBe(true);
    expect(queueItemExistsForTurn(db, "turn-stop", 99)).toBe(false);
    expect(queueItemExistsForTurn(db, "obs", 42)).toBe(false);
  });
});
