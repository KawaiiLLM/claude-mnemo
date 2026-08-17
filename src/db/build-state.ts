import type { Database } from "bun:sqlite";

/**
 * Which build last migrated this database.
 *
 * The hazard: hooks and the MCP server are short-lived, so a plugin update
 * reaches them on their very next invocation and they run the new migrations
 * immediately — while the worker is resident and keeps executing the PREVIOUS
 * release's SQL against the migrated schema. On 2026-08-17 that window cost two
 * settlement jobs, which died on an `ON CONFLICT` clause naming the five-column
 * `memory_edges` key ticket 07 had just collapsed to the four-column pair.
 *
 * A worker cannot see this by looking at its own files. `/plugin` installs a new
 * version into a NEW directory, so the running worker's plugin root, its
 * `worker.cjs` path and that file's mtime are all unchanged — the newer build is
 * invisible from its side, and any "did my own bundle change" check is
 * structurally false. The database is the one thing both builds touch, so the
 * question worth asking is not "is there a newer bundle on disk" but "was this
 * database last migrated by someone other than me", which is the hazard itself
 * rather than a proxy for it.
 */
export interface InitializerBuild {
  buildId: string;
  recordedAtEpoch: number;
}

export function readInitializerBuild(db: Database): InitializerBuild | null {
  const row = db
    .query<InitializerBuild, []>(
      `SELECT build_id AS buildId, recorded_at_epoch AS recordedAtEpoch
       FROM build_state
       WHERE id = 1`,
    )
    .get();
  return row && typeof row.buildId === "string" ? row : null;
}

/**
 * Stamp `buildId` as this database's initializer, but only when it differs from
 * what is already recorded.
 *
 * The conditional is load-bearing, not an optimization: `initializeDatabase`
 * runs in every hook process, so an unconditional write would put a transaction
 * on the hook critical path once per event to record something that did not
 * change. In the steady state — every process on the same build — this costs one
 * indexed read and writes nothing.
 */
export function recordInitializerBuild(
  db: Database,
  buildId: string,
  nowEpoch: number,
): void {
  if (readInitializerBuild(db)?.buildId === buildId) {
    return;
  }
  db.query<unknown, [string, number, string, number]>(
    `INSERT INTO build_state (id, build_id, recorded_at_epoch)
     VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET build_id = ?, recorded_at_epoch = ?`,
  ).run(buildId, nowEpoch, buildId, nowEpoch);
}

/**
 * Is `buildId` stale for this database — did a DIFFERENT build stamp it at or
 * after `sinceEpoch`?
 *
 * Ordering by time, never by version. Version strings are not totally ordered,
 * and a build has no way to tell whether another id is newer or older than its
 * own; but it does know when it started, and "someone else stamped this database
 * after I booted" is exactly the condition that matters. A build's own stamp can
 * never make it stale, so an ordinary boot — where the worker is itself the
 * initializer — is never a false positive.
 *
 * The comparison is `>=` rather than `>` because both sides are whole seconds: a
 * foreign stamp landing in the same second as boot is the update race this
 * exists to catch, and treating it as fresh would reopen the window at exactly
 * its narrowest and most likely point.
 */
export function isBuildStaleForDatabase(
  db: Database,
  buildId: string,
  sinceEpoch: number,
): boolean {
  const recorded = readInitializerBuild(db);
  if (!recorded || recorded.buildId === buildId) {
    return false;
  }
  return recorded.recordedAtEpoch >= sinceEpoch;
}
