import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { getPendingQueueCount } from "../../src/db/pending-queue";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { DEFAULT_CONFIG } from "../../src/shared/config";
import { createWorkerCore } from "../../src/worker/server";

/**
 * Ticket 09 (semantic-container, ADR-0006) — the per-session summary agent
 * retires entirely. The worker hosts exactly two SDK-spawning seams
 * (`processDiaryItem` for diary, `noteSettlementDispatchImpl` for settlement —
 * confirmed by reading every `WorkerCoreDeps` field and every SDK-query import
 * under `src/worker/`); there is no third, session-summary-shaped seam to
 * suppress. What this ticket owns instead is the queue's tolerance for a
 * ROW a pre-upgrade database might still hold from the retired agent's own
 * scheduling: `retireQueueItem` (server.ts) already unconditionally deletes
 * any `pending_queue` row whose kind is not `turn-stop` (the same fallback
 * that already drained the earlier `obs` retirement) — these tests pin that
 * behaviour to the session-summary agent's own legacy kind, prove the drain
 * never reaches either SDK seam, and prove a legacy row does not block real
 * work queued behind it (the "a terminal state must abandon and continue"
 * rule).
 */

function seedSession(db: Database, contentSessionId: string): number {
  return upsertSession(db, {
    contentSessionId,
    project: "/tmp/project-session-summary-retirement",
    title: null,
    content: null,
    insight: null,
    createdAtEpoch: 1,
    updatedAtEpoch: 1,
    completedAtEpoch: null,
  }).id;
}

/** A raw legacy queue row, inserted the way a pre-upgrade database would still
 * hold one: outside the current `PendingQueueKind` union, which now only
 * offers `obs` | `turn-stop` | `diary` and has no `session-summary` member to
 * enqueue even in a test. `kind` carries no CHECK constraint at the SQL
 * level (confirmed against schema.ts), so this is exactly the row shape a
 * worker built after the retirement would still have to face. */
function seedLegacySummaryQueueRow(
  db: Database,
  sessionDbId: number,
  targetId: number,
  enqueuedAtEpoch: number,
): void {
  db.query<
    unknown,
    [string, number, number, number]
  >(
    `INSERT INTO pending_queue (kind, target_id, session_db_id, enqueued_at_epoch)
     VALUES (?, ?, ?, ?)`,
  ).run("session-summary", targetId, sessionDbId, enqueuedAtEpoch);
}

function seedUndecidedTurn(
  db: Database,
  sessionDbId: number,
  promptNumber: number,
): number {
  return db
    .query<{ id: number }, [number, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt,
         assistant_response, created_at_epoch
       ) VALUES (?, ?, 'active', 'prompt', 'reply', 1)
       RETURNING id`,
    )
    .get(sessionDbId, promptNumber)!.id;
}

describe("the per-session summary agent's queue leftovers drain harmlessly (ticket 09)", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("a legacy session-summary row drains without invoking either worker SDK seam", async () => {
    const sessionDbId = seedSession(db, "session-summary-legacy-row");
    seedLegacySummaryQueueRow(db, sessionDbId, sessionDbId, 1);

    const diaryCalls: unknown[] = [];
    const settlementCalls: unknown[] = [];
    const errors: unknown[] = [];
    const core = createWorkerCore({
      db,
      config: DEFAULT_CONFIG,
      logger: { warn: () => {}, error: (...args) => errors.push(args) },
      processDiaryItem: async (item) => {
        diaryCalls.push(item);
      },
      noteSettlementDispatchImpl: async (args) => {
        settlementCalls.push(args);
        return { ok: true };
      },
    });

    await core.scanAndDrainQueue();

    // Drained, not stuck: the row is gone and nothing was logged as an error.
    expect(getPendingQueueCount(db)).toBe(0);
    expect(errors).toHaveLength(0);
    // Neither SDK-spawning seam this worker owns was ever reached — there is
    // no third one for a summary agent to have used.
    expect(diaryCalls).toHaveLength(0);
    expect(settlementCalls).toHaveLength(0);
  });

  test("a legacy row ahead of real work does not block the lane behind it", async () => {
    const sessionDbId = seedSession(db, "session-summary-legacy-lane");
    const turnId = seedUndecidedTurn(db, sessionDbId, 1);
    // The legacy row is enqueued FIRST (lower seq — claimed first), the real
    // turn-stop SECOND, mirroring the actual upgrade scenario: old rows sit
    // ahead of new work in seq order.
    seedLegacySummaryQueueRow(db, sessionDbId, sessionDbId, 1);
    db.query<unknown, [string, number, number, number]>(
      `INSERT INTO pending_queue (kind, target_id, session_db_id, enqueued_at_epoch)
       VALUES (?, ?, ?, ?)`,
    ).run("turn-stop", turnId, sessionDbId, 2);

    const errors: unknown[] = [];
    const core = createWorkerCore({
      db,
      config: DEFAULT_CONFIG,
      logger: { warn: () => {}, error: (...args) => errors.push(args) },
    });

    await core.scanAndDrainQueue();

    // Both rows drained in one pass — the legacy kind never stalls, retries,
    // or otherwise holds the claim cursor back from the turn-stop behind it.
    expect(getPendingQueueCount(db)).toBe(0);
    expect(errors).toHaveLength(0);
    // The turn-stop's own effect (settling the turn) still landed — proof the
    // lane was not blocked, not just that the row disappeared.
    const settled = db
      .query<{ status: string }, [number]>(
        "SELECT status FROM turns WHERE id = ?",
      )
      .get(turnId);
    expect(settled?.status).not.toBe("active");
  });

  test("draining a session-scoped legacy row (the session-close path) is equally harmless", async () => {
    const sessionDbId = seedSession(db, "session-summary-legacy-scoped");
    seedLegacySummaryQueueRow(db, sessionDbId, sessionDbId, 1);

    const errors: unknown[] = [];
    const core = createWorkerCore({
      db,
      config: DEFAULT_CONFIG,
      logger: { warn: () => {}, error: (...args) => errors.push(args) },
    });

    // The session-filtered drain is what handleTurnStop/finishSession use —
    // the "session end" trigger ticket 09 names explicitly.
    await core.scanAndDrainQueue(sessionDbId);

    expect(getPendingQueueCount(db, sessionDbId)).toBe(0);
    expect(errors).toHaveLength(0);
  });
});
