import type { Database } from "bun:sqlite";

import { loadConfig } from "../shared/config";

/**
 * When the new era began, as a durable fact rather than an operator's chore.
 *
 * Ticket 15 deleted the extraction subagent, and with it the only writer a
 * legacy turn's record ever had. A turn created before the era therefore gets no
 * record at all from a build that no longer has one — so shipping the demolition
 * with the cutoff unset would leave every new turn invisible to recall until
 * somebody edited a JSON file. The era is not a preference; it is a property of
 * which build is running, so the build records it the first time it runs.
 *
 * An explicit `eraCutoffEpoch` in the config still wins, which is what makes the
 * boundary testable and what an operator would reach for to move it. Recording
 * it is INSERT OR IGNORE: the first process to look wins, and no later boot,
 * downgrade or clock change can move a boundary that turns have already been
 * written against.
 */
export function getRecordedEraCutoff(db: Database): number | null {
  const row = db
    .query<{ cutoffEpoch: number }, []>(
      "SELECT cutoff_epoch AS cutoffEpoch FROM era_state WHERE id = 1",
    )
    .get();
  return row && Number.isFinite(row.cutoffEpoch) ? row.cutoffEpoch : null;
}

/**
 * Record the era at `nowEpoch` unless it is already recorded, and return the
 * cutoff in force. Called from the two production entry points that own a
 * writable database — the hook command and the worker — and from nowhere else,
 * so a test database stays era-less (and therefore legacy) unless it asks.
 */
export function ensureRecordedEraCutoff(
  db: Database,
  nowEpoch: number,
): number | null {
  const configured = loadConfigEraCutoff();
  if (configured !== null) {
    settledBoundary.set(db, configured);
    return configured;
  }
  db.query<unknown, [number, number]>(
    `INSERT OR IGNORE INTO era_state (id, cutoff_epoch, recorded_at_epoch)
     VALUES (1, ?, ?)`,
  ).run(nowEpoch, nowEpoch);
  const recorded = getRecordedEraCutoff(db);
  if (recorded !== null) {
    settledBoundary.set(db, recorded);
  }
  return recorded;
}

/**
 * Once a database has answered with a boundary, that answer is kept.
 *
 * Not an optimization — a correctness rule that also happens to be free. The
 * boundary is immutable by construction (INSERT OR IGNORE, and a config epoch an
 * operator sets while a process runs must not move a line turns are already
 * being written against), so re-reading it can only produce the same number or a
 * wrong one. `null` is deliberately NEVER cached: it means "nobody has recorded
 * one YET", and another process may record it a moment later — caching that is
 * exactly how a long-lived process ends up disagreeing with the rest of the
 * install. Keyed by database rather than by module so a test's database cannot
 * pin a boundary onto the next one.
 */
const settledBoundary = new WeakMap<Database, number>();

/**
 * The era boundary every reader and writer must agree on: the configured epoch
 * if there is one, otherwise the recorded one, otherwise none (which is the
 * legacy world, and what an unbootstrapped test database sees).
 *
 * Call this per operation. Resolving once and holding the result across a
 * process's life is what made the worker and the MCP server judge the same turn
 * differently; the cache above is what makes calling it per operation cost
 * nothing after the first non-null answer.
 */
export function resolveEraCutoff(db: Database): number | null {
  const settled = settledBoundary.get(db);
  if (settled !== undefined) {
    return settled;
  }
  const resolved = loadConfigEraCutoff() ?? getRecordedEraCutoff(db);
  if (resolved !== null) {
    settledBoundary.set(db, resolved);
  }
  return resolved;
}

function loadConfigEraCutoff(): number | null {
  try {
    return loadConfig().eraCutoffEpoch;
  } catch {
    // A config read must never cost a hook or a tool call; the recorded value
    // (or none) is always a safe answer.
    return null;
  }
}
