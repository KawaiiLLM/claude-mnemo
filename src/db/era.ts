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
    return configured;
  }
  db.query<unknown, [number, number]>(
    `INSERT OR IGNORE INTO era_state (id, cutoff_epoch, recorded_at_epoch)
     VALUES (1, ?, ?)`,
  ).run(nowEpoch, nowEpoch);
  return getRecordedEraCutoff(db);
}

/**
 * The era boundary every reader and writer must agree on: the configured epoch
 * if there is one, otherwise the recorded one, otherwise none (which is the
 * legacy world, and what an unbootstrapped test database sees).
 */
export function resolveEraCutoff(db: Database): number | null {
  return loadConfigEraCutoff() ?? getRecordedEraCutoff(db);
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
