import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";
import { resolveDatabasePath as resolveConfiguredDatabasePath } from "../shared/paths";

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

function configureDatabase(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA mmap_size = 268435456;");
  db.exec("PRAGMA cache_size = 10000;");
  db.exec("PRAGMA busy_timeout = 5000;");
}

export function createDatabase(path?: string): Database {
  const databasePath = resolveDatabasePath(path);

  ensureParentDirectory(databasePath);

  const db = new Database(databasePath);
  configureDatabase(db);

  return db;
}
