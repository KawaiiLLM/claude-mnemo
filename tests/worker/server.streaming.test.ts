import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { createObservation, getObservation } from "../../src/db/observations";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurnById } from "../../src/db/turns";
import {
  getPendingQueueCount,
  type PendingQueueItem,
} from "../../src/db/pending-queue";
import {
  createWorkerCore,
  type WorkerCoreDeps,
} from "../../src/worker/server";
import type { WorkerQuerySession } from "../../src/worker/query-session";
import { MIN_MINI_TURN_CHARS, type MnemoConfig } from "../../src/shared/config";

// maxMiniTurnChars at the production floor (MIN_MINI_TURN_CHARS, what
// loadConfig clamps to) keeps the budget invariant honest: a final slice with
// >=1 obs always fits. ~10 large obs cross the threshold.
const STREAM_CONFIG: MnemoConfig = {
  mergeThresholdChars: 1000,
  maxQueuedBatches: 5,
  keepaliveLeadMs: 60_000,
  cacheMode: "auto",
  maxMiniTurnChars: MIN_MINI_TURN_CHARS,
  maxFlushAttempts: 3,
  compactContextRatio: 0.5,
};

function makeCore(
  db: Database,
  sentPrompts: string[],
  overrides: Partial<WorkerCoreDeps> = {},
) {
  return createWorkerCore({
    db,
    config: STREAM_CONFIG,
    now: () => 123,
    createWorkerQuerySessionImpl: ((...args: unknown[]) => {
      // Healthy agent: remember every <turn id="T..."> block so each flush unit
      // resolves on the first send (no derailment resends/re-session).
      const deps = (args.length === 2 ? args[1] : args[3]) as
        | { onRemember?: (id: string) => void }
        | undefined;
      return {
        sessionId: "worker-query",
        queryPid: 1234,
        async sendPrompt(prompt: string) {
          sentPrompts.push(prompt);
          for (const match of prompt.matchAll(/<turn id="T(\d+)"/g)) {
            deps?.onRemember?.(`T${match[1]}`);
          }
          return { session_id: "worker-query" };
        },
        async close() {},
      } satisfies WorkerQuerySession;
    }) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
    isProcessAliveImpl: () => false,
    ...overrides,
  });
}

describe("mini-turn streaming orchestration", () => {
  let db: Database;
  let sessionId: number;
  let turnId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "streaming-session",
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
        `
          INSERT INTO turns (session_id, prompt_number, status, user_prompt, assistant_response, created_at_epoch)
          VALUES (?, 7, 'active', 'Run /goal migration', 'Migrated everything', 10)
          RETURNING id
        `,
      )
      .get(sessionId)!.id;
  });

  afterEach(() => {
    db.close();
  });

  // Each obs renders to ~700 chars (in caps at 200; out is 400 here, < 800
  // cap); enough cross the streaming threshold (MIN_MINI_TURN_CHARS - ~1956).
  function queueBigObs(count: number, startEpoch = 100): PendingQueueItem[] {
    const items: PendingQueueItem[] = [];
    for (let index = 0; index < count; index += 1) {
      const observationId = createObservation(db, {
        turnId,
        toolName: "Bash",
        // in caps at 200, out at 800 (out is 400 here, untruncated) => ~700/obs.
        toolInput: JSON.stringify({ command: `${index}-${"y".repeat(400)}` }),
        toolResult: JSON.stringify({ stdout: "x".repeat(400) }),
        status: "pending",
        createdAtEpoch: startEpoch + index,
      }).id;
      items.push(
        db
          .query<PendingQueueItem, [number, number, number]>(
            `INSERT INTO pending_queue (kind, target_id, session_db_id, claimed_at_epoch, enqueued_at_epoch)
             VALUES ('obs', ?, ?, NULL, ?)
             RETURNING seq, kind, target_id AS targetId, session_db_id AS sessionDbId, claimed_at_epoch AS claimedAtEpoch, enqueued_at_epoch AS enqueuedAtEpoch`,
          )
          .get(observationId, sessionId, startEpoch + index)!,
      );
    }
    return items;
  }

  function queueTurnStop(epoch: number): void {
    db.query(
      `INSERT INTO pending_queue (kind, target_id, session_db_id, claimed_at_epoch, enqueued_at_epoch)
       VALUES ('turn-stop', ?, ?, NULL, ?)`,
    ).run(turnId, sessionId, epoch);
  }

  test("streams a slice once buffered obs cross the threshold, then a final slice at turn-stop", async () => {
    const sentPrompts: string[] = [];
    const core = makeCore(db, sentPrompts);

    const obs = queueBigObs(14);
    await core.scanAndDrainQueue();

    // A streaming slice was flushed mid-turn: slice="1", no final, no tail.
    const sliceMsg = sentPrompts.find((prompt) => prompt.includes('slice="1"'));
    expect(sliceMsg).toBeDefined();
    expect(sliceMsg!).not.toContain('final="true"');
    expect(sliceMsg!).not.toContain("response:");
    // The streamed turn is tracked for continuation.
    expect(core.sessions.get(sessionId)?.streamedParts.get(turnId)).toBeGreaterThan(1);

    // Peeled obs are skipped after a successful push.
    const skipped = obs.filter(
      (item) => getObservation(db, item.targetId)?.status === "skipped",
    );
    expect(skipped.length).toBeGreaterThan(0);

    // turn-stop emits a final slice with the tail.
    queueTurnStop(900);
    await core.scanAndDrainQueue();
    await core.flushSession(sessionId);

    const finalMsg = sentPrompts.find((prompt) => prompt.includes('final="true"'));
    expect(finalMsg).toBeDefined();
    expect(finalMsg!).toContain("response: Migrated everything");
    expect(finalMsg!).toContain('slice="');

    // Everything drained; streaming state cleared.
    expect(getPendingQueueCount(db)).toBe(0);
    expect(core.sessions.get(sessionId)?.streamedParts.has(turnId)).toBe(false);
    expect(
      obs.every((item) => getObservation(db, item.targetId)?.status === "skipped"),
    ).toBe(true);
  });

  test("a short turn never streams: one turn-stop push, no slice/final, mergeable", async () => {
    const sentPrompts: string[] = [];
    const core = makeCore(db, sentPrompts);

    // Two small obs never cross the threshold.
    createObservation(db, {
      turnId,
      toolName: "Read",
      toolInput: '{"file_path":"a.ts"}',
      toolResult: "small",
      status: "pending",
      createdAtEpoch: 100,
    });
    db.query(
      `INSERT INTO pending_queue (kind, target_id, session_db_id, enqueued_at_epoch)
       SELECT 'obs', id, ?, 100 FROM observations WHERE turn_id = ?`,
    ).run(sessionId, turnId);
    queueTurnStop(200);

    await core.scanAndDrainQueue();
    await core.flushSession(sessionId);

    expect(sentPrompts).toHaveLength(1);
    expect(sentPrompts[0]).not.toContain("slice=");
    expect(sentPrompts[0]).not.toContain('final="true"');
    expect(sentPrompts[0]).toContain("response: Migrated everything");
    expect(core.sessions.get(sessionId)?.streamedParts.has(turnId)).toBe(false);
  });

  test("restart-safe: after streamedParts is lost, a non-active turn still finalizes as a slice", async () => {
    const sentPrompts: string[] = [];
    const core = makeCore(db, sentPrompts);

    // Simulate slice 1 already delivered: the agent remembered the turn
    // (status extracted) and the worker restarted (streamedParts empty).
    db.query("UPDATE turns SET status = 'extracted' WHERE id = ?").run(turnId);
    core.sessions.get(sessionId)?.streamedParts.delete(turnId);

    // A couple of small leftover obs + the turn-stop.
    createObservation(db, {
      turnId,
      toolName: "Read",
      toolInput: '{"file_path":"b.ts"}',
      toolResult: "leftover",
      status: "pending",
      createdAtEpoch: 100,
    });
    db.query(
      `INSERT INTO pending_queue (kind, target_id, session_db_id, enqueued_at_epoch)
       SELECT 'obs', id, ?, 100 FROM observations WHERE turn_id = ? AND status = 'pending'`,
    ).run(sessionId, turnId);
    queueTurnStop(200);

    await core.scanAndDrainQueue();
    await core.flushSession(sessionId);

    // status != active is the durable "already streamed" signal: final slice,
    // not a merged short turn.
    const finalMsg = sentPrompts.find((prompt) => prompt.includes('final="true"'));
    expect(finalMsg).toBeDefined();
    expect(finalMsg!).toContain('slice="');
    expect(finalMsg!).toContain("<prior_turn");
  });

  test("restart-safe even if the agent never remembered: skipped obs still force a final slice", async () => {
    const sentPrompts: string[] = [];
    const core = makeCore(db, sentPrompts);

    // Stream a slice. The mock never calls remember(), so the turn stays
    // active — but the delivered slice's obs are marked skipped (durable).
    queueBigObs(14);
    await core.scanAndDrainQueue();
    expect(sentPrompts.some((p) => p.includes('slice="1"'))).toBe(true);
    expect(getTurnById(db, turnId)?.status).toBe("active");

    // Simulate a restart: in-memory streamedParts is lost.
    core.sessions.get(sessionId)?.streamedParts.delete(turnId);

    db.query(
      `INSERT INTO pending_queue (kind, target_id, session_db_id, enqueued_at_epoch) VALUES ('turn-stop', ?, ?, 900)`,
    ).run(turnId, sessionId);
    await core.scanAndDrainQueue();
    await core.flushSession(sessionId);

    // Despite status=active and empty streamedParts, the skipped obs prove a
    // slice was delivered, so turn-stop emits a final slice (not a short turn).
    const finalMsg = sentPrompts.find((p) => p.includes('final="true"'));
    expect(finalMsg).toBeDefined();
    expect(finalMsg!).toContain('slice="');
    expect(finalMsg!).toContain("<prior_turn");
  });

  test("non-first slices inject a fresh <prior_turn>; the first does not", async () => {
    const sentPrompts: string[] = [];
    const core = makeCore(db, sentPrompts);

    queueBigObs(28);
    await core.scanAndDrainQueue();

    const firstSlice = sentPrompts.find((p) => p.includes('slice="1"'));
    const laterSlice = sentPrompts.find((p) => p.includes('slice="2"'));
    expect(firstSlice).toBeDefined();
    expect(firstSlice!).not.toContain("<prior_turn");
    expect(laterSlice).toBeDefined();
    expect(laterSlice!).toContain(`<prior_turn id="T${turnId}">`);
  });
});
