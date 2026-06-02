import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { createObservation, getObservation } from "../../src/db/observations";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurnById } from "../../src/db/turns";
import { getPendingQueueCount } from "../../src/db/pending-queue";
import {
  DELIVERY_DROPPED_PENDING_TAG,
  getReminderItems,
} from "../../src/worker/invalidation";
import { buildReminderEnvelope, createWorkerCore } from "../../src/worker/server";
import type { WorkerQuerySession } from "../../src/worker/query-session";
import { MIN_MINI_TURN_CHARS, type MnemoConfig } from "../../src/shared/config";

// maxMiniTurnChars at the production floor (MIN_MINI_TURN_CHARS, what
// loadConfig clamps to), so retry/drop coverage matches the tightest config.
const RETRY_CONFIG: MnemoConfig = {
  mergeThresholdChars: 1000,
  maxQueuedBatches: 5,
  keepaliveLeadMs: 60_000,
  cacheMode: "auto",
  maxMiniTurnChars: MIN_MINI_TURN_CHARS,
  maxFlushAttempts: 3,
  compactContextRatio: 0.5,
};

describe("flush retry / drop (D8)", () => {
  let db: Database;
  let sessionId: number;
  let turnId: number;
  let observationId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "retry-session",
      project: "/proj",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
    turnId = db
      .query<{ id: number }, []>(
        `INSERT INTO turns (session_id, prompt_number, status, user_prompt, assistant_response, created_at_epoch)
         VALUES (?, 1, 'active', 'A prompt', 'A reply', 10) RETURNING id`,
      )
      .get(sessionId)!.id;
    observationId = createObservation(db, {
      turnId,
      toolName: "Read",
      toolInput: '{"file_path":"a.ts"}',
      toolResult: "result",
      status: "pending",
      createdAtEpoch: 100,
    }).id;
    db.query(
      `INSERT INTO pending_queue (kind, target_id, session_db_id, enqueued_at_epoch) VALUES ('obs', ?, ?, 100)`,
    ).run(observationId, sessionId);
    db.query(
      `INSERT INTO pending_queue (kind, target_id, session_db_id, enqueued_at_epoch) VALUES ('turn-stop', ?, ?, 200)`,
    ).run(turnId, sessionId);
  });

  afterEach(() => {
    db.close();
  });

  function failingCore(failTimes: number, attempts: { n: number }) {
    return createWorkerCore({
      db,
      config: RETRY_CONFIG,
      now: () => 123,
      logger: { warn: () => {}, error: () => {} },
      createWorkerQuerySessionImpl: ((...args: unknown[]) => {
        // On a successful push, remember every <turn id="T..."> so the work
        // unit resolves (this suite exercises delivery failure, not derailment).
        const deps = (args.length === 2 ? args[1] : args[3]) as
          | { onRemember?: (id: string) => void }
          | undefined;
        return {
          sessionId: "worker-query",
          queryPid: 1234,
          async sendPrompt(prompt: string) {
            attempts.n += 1;
            if (attempts.n <= failTimes) {
              throw new Error("push failed");
            }
            for (const match of prompt.matchAll(/<turn id="T(\d+)"/g)) {
              deps?.onRemember?.(`T${match[1]}`);
            }
            return { session_id: "worker-query" };
          },
          async close() {},
        } satisfies WorkerQuerySession;
      }) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
      isProcessAliveImpl: () => false,
    });
  }

  test("first failure returns retryLater: batch + claims retained, attempts=1", async () => {
    const attempts = { n: 0 };
    const core = failingCore(Infinity, attempts);

    await core.flushSession(sessionId);

    // One attempt burned; the batch and its claimed queue rows remain.
    expect(attempts.n).toBe(1);
    const state = core.sessions.get(sessionId);
    expect(state?.batchQueue).toHaveLength(1);
    expect(state?.batchQueue[0]?.attempts).toBe(1);
    expect(getPendingQueueCount(db)).toBe(2);
  });

  test("flushSession does not burn attempts to the limit in one drain", async () => {
    const attempts = { n: 0 };
    const core = failingCore(Infinity, attempts);

    await core.flushSession(sessionId);
    // A second drain triggers exactly one more attempt (no hot loop).
    await core.flushSession(sessionId);

    expect(attempts.n).toBe(2);
    expect(core.sessions.get(sessionId)?.batchQueue[0]?.attempts).toBe(2);
  });

  test("after maxFlushAttempts the batch drops: obs skipped, turn flagged, turn-stop removed", async () => {
    const attempts = { n: 0 };
    const core = failingCore(Infinity, attempts);

    // attempt 1 (drain) -> retryLater; retry tick attempts 2 and 3 -> dropped.
    await core.flushSession(sessionId);
    await core.runRetryTick();
    await core.runRetryTick();

    expect(attempts.n).toBe(3);
    expect(core.sessions.get(sessionId)?.batchQueue).toHaveLength(0);
    // Dropped runs the same side effects as flushed + a delivery-dropped tag.
    expect(getObservation(db, observationId)?.status).toBe("skipped");
    expect(getPendingQueueCount(db)).toBe(0);
    expect(getTurnById(db, turnId)?.tags).toContain(DELIVERY_DROPPED_PENDING_TAG);
  });

  test("a dropped, never-extracted turn stays active and reminds 'not yet extracted'", async () => {
    const attempts = { n: 0 };
    const core = failingCore(Infinity, attempts);

    await core.flushSession(sessionId);
    await core.runRetryTick();
    await core.runRetryTick();

    // buildMiniTurn must NOT have auto-promoted the active turn at build time,
    // so the delivery-dropped reminder takes the "not yet extracted" branch.
    expect(getTurnById(db, turnId)?.status).toBe("active");
    const envelope = buildReminderEnvelope(getReminderItems(db, sessionId));
    expect(envelope).toContain("not yet extracted");
    expect(envelope).toContain('prompt="A prompt"');
    expect(envelope).not.toContain("record may be incomplete");
  });

  test("retry tick bypasses the cache-age gate and re-flushes a retry-pending head", async () => {
    const attempts = { n: 0 };
    const core = failingCore(1, attempts); // only the first push fails

    await core.flushSession(sessionId);
    expect(core.sessions.get(sessionId)?.batchQueue[0]?.attempts).toBe(1);

    // Cache is cold (no successful push yet); the retry tick still re-flushes.
    await core.runRetryTick();
    expect(attempts.n).toBe(2);
    expect(core.sessions.get(sessionId)?.batchQueue ?? []).toHaveLength(0);
    expect(getPendingQueueCount(db)).toBe(0);
  });

  test("retry tick skips compacting sessions", async () => {
    const attempts = { n: 0 };
    const core = failingCore(Infinity, attempts);

    await core.flushSession(sessionId);
    expect(attempts.n).toBe(1);

    core.compactingSessions.add(sessionId);
    await core.runRetryTick();
    // No additional attempt while compacting.
    expect(attempts.n).toBe(1);
  });

  test("recoverFromCrash resets claims and in-memory streaming state", async () => {
    const attempts = { n: 0 };
    const core = failingCore(Infinity, attempts);

    await core.flushSession(sessionId);
    const state = core.sessions.get(sessionId)!;
    state.streamedParts.set(turnId, 3);
    expect(state.batchQueue.length).toBe(1);

    core.recoverFromCrash();

    expect(state.batchQueue).toHaveLength(0);
    expect(state.streamedParts.has(turnId)).toBe(false);
    // Queue rows are un-claimed (available for a fresh drain).
    const claimed = db
      .query<{ claimed_at_epoch: number | null }, []>(
        "SELECT claimed_at_epoch FROM pending_queue",
      )
      .all();
    expect(claimed.every((row) => row.claimed_at_epoch === null)).toBe(true);
  });
});
