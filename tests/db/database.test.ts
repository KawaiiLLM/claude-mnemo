import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDatabase,
  isSqliteBusy,
  runHookWriteTransaction,
  runWriteTransaction,
} from "../../src/db/database";

function busyError(code: "SQLITE_BUSY" | "SQLITE_BUSY_SNAPSHOT" = "SQLITE_BUSY"): Error {
  return Object.assign(new Error(code === "SQLITE_BUSY" ? "database is locked" : code), {
    code,
  });
}

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

function createTransactionFake(outcomes: Array<"busy" | "snapshot" | "success">): {
  db: Database;
  calls: { transaction: number; immediate: number; body: number };
} {
  const calls = { transaction: 0, immediate: 0, body: 0 };

  const db = {
    transaction<T>(fn: () => T) {
      calls.transaction += 1;

      return {
        immediate() {
          calls.immediate += 1;
          const outcome = outcomes.shift() ?? "success";

          if (outcome === "busy") {
            throw busyError("SQLITE_BUSY");
          }

          if (outcome === "snapshot") {
            throw busyError("SQLITE_BUSY_SNAPSHOT");
          }

          calls.body += 1;
          return fn();
        },
      };
    },
  } as unknown as Database;

  return { db, calls };
}

describe("database configuration", () => {
  test("defaults busy_timeout to 5000 ms for existing callers", () => {
    const db = createDatabase(":memory:");

    try {
      const row = db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get();

      expect(row?.timeout).toBe(5000);
    } finally {
      db.close();
    }
  });

  test("allows callers to configure busy_timeout", () => {
    const db = createDatabase(":memory:", { busyTimeoutMs: 800 });

    try {
      const row = db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get();

      expect(row?.timeout).toBe(800);
    } finally {
      db.close();
    }
  });
});

describe("isSqliteBusy", () => {
  test("matches SQLITE_BUSY and SQLITE_BUSY_SNAPSHOT by code", () => {
    expect(isSqliteBusy(busyError("SQLITE_BUSY"))).toBe(true);
    expect(isSqliteBusy(busyError("SQLITE_BUSY_SNAPSHOT"))).toBe(true);
  });

  test("matches SQLITE_BUSY and SQLITE_BUSY_SNAPSHOT by message", () => {
    expect(isSqliteBusy(new Error("SQLITE_BUSY: database is locked"))).toBe(true);
    expect(isSqliteBusy(new Error("SQLITE_BUSY_SNAPSHOT"))).toBe(true);
    expect(isSqliteBusy(new Error("database is locked"))).toBe(true);
  });

  test("does not match unrelated errors", () => {
    expect(
      isSqliteBusy(
        Object.assign(new Error("constraint failed"), { code: "SQLITE_CONSTRAINT" }),
      ),
    ).toBe(false);
    expect(isSqliteBusy(new Error("unexpected database failure"))).toBe(false);
  });
});

describe("runWriteTransaction", () => {
  test("old DEFERRED read snapshots fail with SQLITE_BUSY_SNAPSHOT after another connection commits", () => {
    const temp = createTempDatabasePath("claude-mnemo-deferred-snapshot-");
    const reader = createDatabase(temp.path, { busyTimeoutMs: 0 });
    const writer = createDatabase(temp.path, { busyTimeoutMs: 0 });

    try {
      reader.exec(`
        CREATE TABLE items (
          id INTEGER PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO items (value) VALUES ('initial');
      `);

      reader.exec("BEGIN DEFERRED");
      expect(
        reader.query<{ value: string }, []>("SELECT value FROM items WHERE id = 1").get()
          ?.value,
      ).toBe("initial");

      writer.exec("BEGIN IMMEDIATE");
      writer.query<unknown, [string]>("UPDATE items SET value = ? WHERE id = 1").run("writer");
      writer.exec("COMMIT");

      const err = captureError(() => {
        reader.query<unknown, [string]>("UPDATE items SET value = ? WHERE id = 1").run("reader");
      });

      expect(isSqliteBusy(err)).toBe(true);
      expect((err as { code?: unknown })?.code).toBe("SQLITE_BUSY_SNAPSHOT");
    } finally {
      rollbackIfOpen(reader);
      rollbackIfOpen(writer);
      reader.close();
      writer.close();
      rmSync(temp.directory, { recursive: true, force: true });
    }
  });

  test("immediate write transactions prevent another writer from staling a read snapshot", () => {
    const temp = createTempDatabasePath("claude-mnemo-immediate-snapshot-");
    const first = createDatabase(temp.path, { busyTimeoutMs: 0 });
    const second = createDatabase(temp.path, { busyTimeoutMs: 0 });

    try {
      first.exec(`
        CREATE TABLE items (
          id INTEGER PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO items (value) VALUES ('initial');
      `);

      let competingWriteError: unknown = null;
      const result = runWriteTransaction(first, () => {
        expect(
          first.query<{ value: string }, []>("SELECT value FROM items WHERE id = 1").get()
            ?.value,
        ).toBe("initial");

        competingWriteError = captureError(() => {
          second.exec("BEGIN IMMEDIATE");
          second
            .query<unknown, [string]>("UPDATE items SET value = ? WHERE id = 1")
            .run("second");
          second.exec("COMMIT");
        });
        rollbackIfOpen(second);

        first.query<unknown, [string]>("UPDATE items SET value = ? WHERE id = 1").run("first");
        return first.query<{ value: string }, []>("SELECT value FROM items WHERE id = 1").get()
          ?.value;
      });

      expect(result).toBe("first");
      expect(isSqliteBusy(competingWriteError)).toBe(true);
      expect(
        first.query<{ value: string }, []>("SELECT value FROM items WHERE id = 1").get()
          ?.value,
      ).toBe("first");
    } finally {
      rollbackIfOpen(first);
      rollbackIfOpen(second);
      first.close();
      second.close();
      rmSync(temp.directory, { recursive: true, force: true });
    }
  });

  test("does not retry non-busy errors", () => {
    const err = Object.assign(new Error("constraint failed"), { code: "SQLITE_CONSTRAINT" });
    let immediateCalls = 0;
    const db = {
      transaction() {
        return {
          immediate() {
            immediateCalls += 1;
            throw err;
          },
        };
      },
    } as unknown as Database;

    expect(() => runWriteTransaction(db, () => "unreachable", 3)).toThrow(err);
    expect(immediateCalls).toBe(1);
  });

  test("uses an immediate transaction and returns the callback value", () => {
    const { db, calls } = createTransactionFake(["success"]);

    const result = runWriteTransaction(db, () => "stored");

    expect(result).toBe("stored");
    expect(calls).toEqual({ transaction: 1, immediate: 1, body: 1 });
  });

  test("retries SQLITE_BUSY and SQLITE_BUSY_SNAPSHOT up to the attempt limit", () => {
    const { db, calls } = createTransactionFake(["busy", "snapshot", "success"]);

    const result = runWriteTransaction(db, () => 42, 3);

    expect(result).toBe(42);
    expect(calls).toEqual({ transaction: 1, immediate: 3, body: 1 });
  });

  test("throws the original busy error after attempts are exhausted", () => {
    const err = busyError();
    const db = {
      transaction() {
        return {
          immediate() {
            throw err;
          },
        };
      },
    } as unknown as Database;

    expect(() => runWriteTransaction(db, () => "unreachable", 2)).toThrow(err);
  });
});

describe("runHookWriteTransaction", () => {
  test("does not retry non-busy errors", () => {
    const err = Object.assign(new Error("constraint failed"), { code: "SQLITE_CONSTRAINT" });
    let immediateCalls = 0;
    const db = {
      transaction() {
        return {
          immediate() {
            immediateCalls += 1;
            throw err;
          },
        };
      },
    } as unknown as Database;

    expect(() =>
      runHookWriteTransaction(db, () => "unreachable", {
        budgetMs: 50,
        now: () => 0,
        sleep: () => {},
        backoffMs: () => 10,
      }),
    ).toThrow(err);
    expect(immediateCalls).toBe(1);
  });

  test("retries busy transactions while the elapsed budget remains", () => {
    const { db, calls } = createTransactionFake(["busy", "success"]);
    let now = 0;
    const sleeps: number[] = [];

    const result = runHookWriteTransaction(db, () => "hook-stored", {
      budgetMs: 50,
      now: () => now,
      sleep: (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      backoffMs: () => 10,
    });

    expect(result).toBe("hook-stored");
    expect(sleeps).toEqual([10]);
    expect(calls).toEqual({ transaction: 1, immediate: 2, body: 1 });
  });

  test("throws the busy error when retrying would exceed the elapsed budget", () => {
    const err = busyError();
    const db = {
      transaction() {
        return {
          immediate() {
            throw err;
          },
        };
      },
    } as unknown as Database;
    let now = 0;

    expect(() =>
      runHookWriteTransaction(db, () => "unreachable", {
        budgetMs: 5,
        now: () => now,
        sleep: (ms) => {
          now += ms;
        },
        backoffMs: () => 10,
      }),
    ).toThrow(err);
    expect(now).toBe(0);
  });
});
