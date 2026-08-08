import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Database } from "bun:sqlite";

/**
 * Read-only access for the P1 trial's measurement tools (spec D12 / ticket 04).
 *
 * Every one of these tools points at a live production database, so "read only"
 * has to be a property of the connection rather than of the queries someone
 * remembers to write. Two independent locks are set:
 *
 *   - `file://…?mode=ro` — SQLite opens the file itself read-only, so a write
 *     fails at the VFS layer even if a statement slips through;
 *   - `PRAGMA query_only = ON` — the connection refuses to prepare a mutating
 *     statement at all, which turns an accidental write into an error at the
 *     call site instead of a silent no-op somewhere downstream.
 *
 * The path is always explicit — there is deliberately no default that resolves
 * to `~/.claude-mnemo`, because a default is exactly how a measurement tool ends
 * up pointed at production by accident.
 */

/** Tables the P1 trial adds. Their absence means "the trial is not enabled". */
export const P1_TABLES = [
  "shadow_notes",
  "note_debt",
  "note_id_exposures",
] as const;

export function openReadOnlyDatabase(path: string): Database {
  const resolved = resolve(path);

  if (!existsSync(resolved)) {
    throw new Error(`Database not found: ${resolved}`);
  }

  // pathToFileURL percent-encodes `?` and `#`, so appending the query is safe
  // for any path a user can type.
  const uri = `${pathToFileURL(resolved).href}?mode=ro`;
  const db = new Database(uri, { readonly: true });
  db.exec("PRAGMA query_only = ON;");

  return db;
}

export function listMissingTables(
  db: Database,
  required: readonly string[],
): string[] {
  const present = new Set(
    db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      )
      .all()
      .map((row) => row.name),
  );

  return required.filter((name) => !present.has(name));
}

export function isP1Enabled(db: Database): boolean {
  return listMissingTables(db, P1_TABLES).length === 0;
}

/**
 * Resolve a session selector to an internal session id.
 *
 * Accepts the `S15069` form the model and the renderers use, the bare number,
 * and the content session uuid — one flag, three spellings, because the id a
 * user has at hand depends on where they copied it from.
 */
export function resolveSessionSelector(
  db: Database,
  selector: string,
): number | null {
  const trimmed = selector.trim();
  const numeric = /^[Ss](\d+)$/u.exec(trimmed)?.[1] ?? trimmed;

  if (/^\d+$/u.test(numeric)) {
    const id = Number.parseInt(numeric, 10);
    const found = db
      .query<{ id: number }, [number]>("SELECT id FROM sessions WHERE id = ?")
      .get(id);
    return found?.id ?? null;
  }

  const byContentId = db
    .query<{ id: number }, [string]>(
      "SELECT id FROM sessions WHERE content_session_id = ?",
    )
    .get(trimmed);

  return byContentId?.id ?? null;
}
