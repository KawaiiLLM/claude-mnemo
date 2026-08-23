import { Database } from "bun:sqlite";

import { getRecentSessions, type SessionRecord } from "../db/sessions";

/**
 * The console's read-only query capability (memory-console spec, "Read-only,
 * structurally"; ticket 02).
 *
 * `ConsoleReader` is the ONLY thing a console route handler ever receives —
 * never the raw `Database`. It is deliberately narrow: today one real method
 * (`listRecentSessions`), reusing an existing `db/sessions.ts` reader rather
 * than a new SQL string, so the query logic this module carries stays at
 * zero. Ticket 03 grows this surface with the session/segment/graph queries
 * `/api/console/*` needs; it adds methods here, it does not widen what the
 * capability is allowed to touch.
 *
 * Two independent guarantees back the "read-only, structurally" claim:
 *   - the connection this module is handed is opened via
 *     `openConsoleReaderDatabase`, `bun:sqlite`'s `{ readonly: true, create:
 *     false }` — the VFS itself refuses a write, so a bug here cannot
 *     silently succeed at one;
 *   - this module's own source is pinned free of DML (`INSERT`/`UPDATE`/
 *     `DELETE`/`REPLACE`), `db.exec`, and any import from the queue or
 *     settlement modules (`tests/worker/console-reader.test.ts`'s source
 *     guard) — so even a future method added here cannot reach for a write
 *     path or the mechanisms that drive one.
 *
 * Scope statement (spec): this is a guarantee about the CONSOLE REQUEST PATH
 * against the persistent memory DB. It says nothing about the worker process
 * at large, which keeps writing through its own (separate) connection.
 */
export interface ConsoleReader {
  /**
   * Placeholder shape (ticket 02) — the one real method proving the
   * capability and connection plumbing end to end. Ticket 03 replaces this
   * with the paginated `/api/console/sessions` shape the API contract
   * defines; callers should not depend on this exact return type surviving.
   */
  listRecentSessions(limit?: number): SessionRecord[];
}

export type OpenConsoleReaderDatabase = (path: string) => Database;

/**
 * The production opener. `readonly: true` is `bun:sqlite`'s own read-only
 * open mode (no write operations reach the VFS); `create: false` is stated
 * explicitly even though `readonly: true` alone already refuses to create a
 * missing file — a missing console database is a real error (the worker's
 * main connection did not run first, or the path is wrong), never a reason
 * to silently create an empty one that would make every query look like
 * "no data" instead of surfacing the actual problem.
 */
export const openConsoleReaderDatabase: OpenConsoleReaderDatabase = (path) =>
  new Database(path, { readonly: true, create: false });

/** Wrap an already-open (readonly) connection as the narrow console capability. */
export function createConsoleReader(db: Database): ConsoleReader {
  return {
    listRecentSessions(limit = 20): SessionRecord[] {
      return getRecentSessions(db, { limit });
    },
  };
}
