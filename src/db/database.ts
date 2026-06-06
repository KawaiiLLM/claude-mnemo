import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";
import { resolveDatabasePath as resolveConfiguredDatabasePath } from "../shared/paths";

const DEFAULT_BUSY_TIMEOUT_MS = 5000;
const DEFAULT_HOOK_TRANSACTION_BUDGET_MS = 2500;

export interface CreateDatabaseOptions {
  busyTimeoutMs?: number;
}

export interface HookWriteTransactionOptions {
  budgetMs?: number;
  now?: () => number;
  sleep?: (ms: number) => void;
  backoffMs?: (attempt: number, elapsedMs: number) => number;
}

function resolveDatabasePath(path?: string): string {
  if (!path || path.trim() === "") {
    return resolveConfiguredDatabasePath();
  }
  return resolveConfiguredDatabasePath(path);
}

function ensureParentDirectory(databasePath: string): void {
  if (databasePath === ":memory:") {
    return;
  }

  const parentDirectory = dirname(databasePath);

  if (!existsSync(parentDirectory)) {
    mkdirSync(parentDirectory, { recursive: true });
  }
}

function normalizeNonNegativeMilliseconds(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }

  return Math.floor(value);
}

function syncSleep(ms: number): void {
  if (ms <= 0) {
    return;
  }

  const wakeSignal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(wakeSignal, 0, 0, ms);
}

function genericWriteBackoffMs(attempt: number): number {
  return Math.min(25, 5 * (attempt + 1));
}

function hookWriteBackoffMs(attempt: number): number {
  return Math.min(100, 25 * 2 ** attempt);
}

function configureDatabase(db: Database, options: Required<CreateDatabaseOptions>): void {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA mmap_size = 268435456;");
  db.exec("PRAGMA cache_size = 10000;");
  db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs};`);
}

export function createDatabase(path?: string, options: CreateDatabaseOptions = {}): Database {
  const databasePath = resolveDatabasePath(path);
  const busyTimeoutMs = normalizeNonNegativeMilliseconds(
    options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
    "busyTimeoutMs",
  );

  ensureParentDirectory(databasePath);

  const db = new Database(databasePath);
  configureDatabase(db, { busyTimeoutMs });

  return db;
}

export function isSqliteBusy(err: unknown): boolean {
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? String((err as { code?: unknown }).code)
      : "";

  if (code === "SQLITE_BUSY" || code === "SQLITE_BUSY_SNAPSHOT") {
    return true;
  }

  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";

  return (
    /\bSQLITE_BUSY(?:_SNAPSHOT)?\b/.test(message) ||
    /\bdatabase is locked\b/i.test(message) ||
    /\bdatabase table is locked\b/i.test(message)
  );
}

export function runWriteTransaction<T>(db: Database, fn: () => T, attempts = 3): T {
  const txn = db.transaction(fn);
  const maxAttempts = Math.max(1, Math.floor(attempts));

  for (let attempt = 0; ; attempt += 1) {
    try {
      return txn.immediate();
    } catch (err) {
      if (attempt >= maxAttempts - 1 || !isSqliteBusy(err)) {
        throw err;
      }

      syncSleep(genericWriteBackoffMs(attempt));
    }
  }
}

export function runHookWriteTransaction<T>(
  db: Database,
  fn: () => T,
  options: HookWriteTransactionOptions = {},
): T {
  const txn = db.transaction(fn);
  const budgetMs = normalizeNonNegativeMilliseconds(
    options.budgetMs ?? DEFAULT_HOOK_TRANSACTION_BUDGET_MS,
    "budgetMs",
  );
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? syncSleep;
  const backoffMs = options.backoffMs ?? ((attempt: number) => hookWriteBackoffMs(attempt));
  const start = now();

  for (let attempt = 0; ; attempt += 1) {
    try {
      return txn.immediate();
    } catch (err) {
      if (!isSqliteBusy(err)) {
        throw err;
      }

      const elapsedMs = Math.max(0, now() - start);
      if (elapsedMs >= budgetMs) {
        throw err;
      }

      const delayMs = normalizeNonNegativeMilliseconds(
        backoffMs(attempt, elapsedMs),
        "backoffMs",
      );
      const remainingMs = budgetMs - elapsedMs;

      if (delayMs >= remainingMs) {
        throw err;
      }

      sleep(delayMs);
    }
  }
}
