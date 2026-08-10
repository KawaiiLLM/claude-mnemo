import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import {
  updateLastAgentSessionId,
  upsertSession,
} from "../../src/db/sessions";
import { getTurnById, updateTurnById } from "../../src/db/turns";
import { DEFAULT_CONFIG } from "../../src/shared/config";
import { createWorkerAbortError } from "../../src/worker/error-classifier";
import { createWorkerCore } from "../../src/worker/server";
import type { WorkerQuerySession } from "../../src/worker/query-session";

describe("bounded extraction stall escalation", () => {
  let db: Database;
  let sessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "stall-escalation",
      project: "/proj",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
    updateLastAgentSessionId(db, sessionId, "persisted-agent-session");
  });

  afterEach(() => {
    db.close();
  });

  function queueTurn(promptNumber: number): number {
    const turnId = db
      .query<{ id: number }, [number, number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt,
           assistant_response, created_at_epoch
         ) VALUES (?, ?, 'active', 'prompt', 'response', 10)
         RETURNING id`,
      )
      .get(sessionId, promptNumber)!.id;
    db.query(
      `INSERT INTO pending_queue (
         kind, target_id, session_db_id, enqueued_at_epoch
       ) VALUES ('turn-stop', ?, ?, ?)`,
    ).run(turnId, sessionId, 100 + promptNumber);
    return turnId;
  }

  function createAlwaysStallingCore(
    currentMs: () => number,
    constructions: Array<string | null>,
    prompts: string[],
  ) {
    return createWorkerCore({
      db,
      now: () => 123,
      nowMs: currentMs,
      config: {
        ...DEFAULT_CONFIG,
        mergeThresholdChars: 100_000,
        maxQueuedBatches: 0,
      },
      logger: { warn() {}, error() {} },
      createWorkerQuerySessionImpl: ((...args: unknown[]) => {
        const input = args[0] as { resumeAgentSessionId?: string | null };
        constructions.push(input.resumeAgentSessionId ?? null);
        return {
          sessionId: "fake-stalling-query",
          queryPid: 1234,
          async sendPrompt(prompt: string) {
            prompts.push(prompt);
            throw createWorkerAbortError("extraction-stall-watchdog");
          },
          async close() {},
        } satisfies WorkerQuerySession;
      }) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
      isProcessAliveImpl: () => false,
    });
  }

  test("resume, fresh, then skip isolate merged work from retry-trigger turns", async () => {
    let currentMs = 1_000;
    const constructions: Array<string | null> = [];
    const prompts: string[] = [];
    const originalTurnId = queueTurn(1);
    const mergedSiblingTurnId = queueTurn(2);
    const firstCore = createAlwaysStallingCore(
      () => currentMs,
      constructions,
      prompts,
    );

    await firstCore.scanAndDrainQueue();
    expect(getTurnById(db, originalTurnId)?.extractionStallAttempts).toBe(1);
    expect(getTurnById(db, mergedSiblingTurnId)?.extractionStallAttempts).toBe(1);
    expect(getTurnById(db, originalTurnId)?.status).toBe("active");
    expect(constructions).toEqual(["persisted-agent-session"]);

    // A newer turn-stop alone cannot bypass a stall retry's backoff.
    const firstTriggerTurnId = queueTurn(3);
    await firstCore.scanAndDrainQueue();
    expect(constructions).toHaveLength(1);

    currentMs = 11_001;
    await firstCore.scanAndDrainQueue();
    expect(constructions).toEqual([
      "persisted-agent-session",
      "persisted-agent-session",
    ]);
    expect(getTurnById(db, originalTurnId)?.extractionStallAttempts).toBe(2);
    expect(getTurnById(db, mergedSiblingTurnId)?.extractionStallAttempts).toBe(2);
    expect(getTurnById(db, firstTriggerTurnId)?.extractionStallAttempts).toBe(0);
    expect(prompts[1]).toContain(`<turn id="T${originalTurnId}"`);
    expect(prompts[1]).toContain(`<turn id="T${mergedSiblingTurnId}"`);
    expect(prompts[1]).not.toContain(`<turn id="T${firstTriggerTurnId}"`);

    const secondTriggerTurnId = queueTurn(4);
    await firstCore.scanAndDrainQueue();
    expect(constructions).toHaveLength(2);
    currentMs = 21_002;
    await firstCore.scanAndDrainQueue();

    expect(constructions).toEqual([
      "persisted-agent-session",
      "persisted-agent-session",
      null,
    ]);
    expect(getTurnById(db, originalTurnId)?.extractionStallAttempts).toBe(3);
    expect(getTurnById(db, originalTurnId)?.status).toBe("failed");
    expect(getTurnById(db, mergedSiblingTurnId)?.extractionStallAttempts).toBe(3);
    expect(getTurnById(db, mergedSiblingTurnId)?.status).toBe("failed");
    expect(getTurnById(db, firstTriggerTurnId)?.extractionStallAttempts).toBe(0);
    expect(getTurnById(db, secondTriggerTurnId)?.extractionStallAttempts).toBe(0);
    expect(prompts[2]).not.toContain(`<turn id="T${firstTriggerTurnId}"`);
    expect(prompts[2]).not.toContain(`<turn id="T${secondTriggerTurnId}"`);

    const originalQueueCount = db
      .query<{ count: number }, [number]>(
        `SELECT COUNT(*) AS count
         FROM pending_queue
         WHERE kind = 'turn-stop' AND target_id = ?`,
      )
      .get(originalTurnId)!.count;
    expect(originalQueueCount).toBe(0);

    // Even if a duplicate stop arrives later, the terminal counter guard skips
    // it locally and never constructs a fourth extraction request for this turn.
    const duplicate = db
      .query<{ seq: number }, [number, number]>(
        `INSERT INTO pending_queue (
           kind, target_id, session_db_id, enqueued_at_epoch
         ) VALUES ('turn-stop', ?, ?, 999)
         RETURNING seq`,
      )
      .get(originalTurnId, sessionId)!;
    const constructionCount = constructions.length;
    await firstCore.processClaimedItem({
      seq: duplicate.seq,
      kind: "turn-stop",
      targetId: originalTurnId,
      sessionDbId: sessionId,
      claimedAtEpoch: 999,
      enqueuedAtEpoch: 999,
    });
    expect(constructions).toHaveLength(constructionCount);
    expect(
      db.query<{ count: number }, [number]>(
        `SELECT COUNT(*) AS count FROM pending_queue WHERE seq = ?`,
      ).get(duplicate.seq)!.count,
    ).toBe(0);
  });

  test("durable retry gate and forceFresh mode survive worker restarts", async () => {
    let currentMs = 1_000;
    const constructions: Array<string | null> = [];
    const prompts: string[] = [];
    const turnId = queueTurn(1);
    const firstCore = createAlwaysStallingCore(
      () => currentMs,
      constructions,
      prompts,
    );
    await firstCore.scanAndDrainQueue();
    expect(getTurnById(db, turnId)).toMatchObject({
      extractionStallAttempts: 1,
      extractionStallRetryAtMs: 11_000,
      extractionStallRetryMode: "resume",
    });

    const secondCore = createAlwaysStallingCore(
      () => currentMs,
      constructions,
      prompts,
    );
    await secondCore.scanAndDrainQueue();
    currentMs = 11_001;
    await secondCore.scanAndDrainQueue();
    expect(constructions).toHaveLength(1);

    queueTurn(2);
    await secondCore.scanAndDrainQueue();
    expect(constructions).toEqual([
      "persisted-agent-session",
      "persisted-agent-session",
    ]);
    expect(getTurnById(db, turnId)).toMatchObject({
      extractionStallAttempts: 2,
      extractionStallRetryAtMs: 21_001,
      extractionStallRetryMode: "forceFresh",
    });

    const thirdCore = createAlwaysStallingCore(
      () => currentMs,
      constructions,
      prompts,
    );
    currentMs = 21_002;
    await thirdCore.scanAndDrainQueue();
    expect(constructions).toHaveLength(2);

    queueTurn(3);
    await thirdCore.scanAndDrainQueue();
    expect(constructions[2]).toBeNull();
    expect(getTurnById(db, turnId)?.status).toBe("failed");
  });

  test("a remembered merged sibling is finalized without consuming a stall", async () => {
    const resolvedTurnId = queueTurn(1);
    const stalledTurnId = queueTurn(2);
    const core = createWorkerCore({
      db,
      now: () => 123,
      nowMs: () => 1_000,
      config: {
        ...DEFAULT_CONFIG,
        mergeThresholdChars: 100_000,
        maxQueuedBatches: 0,
      },
      logger: { warn() {}, error() {} },
      createWorkerQuerySessionImpl: ((...args: unknown[]) => {
        const deps = args[1] as { onRemember?: (id: string) => void };
        return {
          sessionId: "partial-success-query",
          queryPid: 1234,
          async sendPrompt() {
            updateTurnById(db, resolvedTurnId, {
              status: "extracted",
              title: "Resolved before stall",
            });
            deps.onRemember?.(`T${resolvedTurnId}`);
            throw createWorkerAbortError("extraction-stall-watchdog");
          },
          async close() {},
        } satisfies WorkerQuerySession;
      }) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
      isProcessAliveImpl: () => false,
    });

    await core.scanAndDrainQueue();

    expect(getTurnById(db, resolvedTurnId)).toMatchObject({
      status: "extracted",
      extractionStallAttempts: 0,
    });
    expect(getTurnById(db, stalledTurnId)).toMatchObject({
      status: "active",
      extractionStallAttempts: 1,
    });
    expect(
      db.query<{ count: number }, [number]>(
        `SELECT COUNT(*) AS count FROM pending_queue
         WHERE kind = 'turn-stop' AND target_id = ?`,
      ).get(resolvedTurnId)!.count,
    ).toBe(0);
  });

  // The stall floor is the extraction pipeline giving up on a turn. In the
  // segment era that pipeline no longer owns the record, so what it floors to
  // has to be read off the row rather than assumed lost.
  describe("the stall floor reads an era turn's own note", () => {
    const ERA_CUTOFF = 5;

    function seedStalledTurn(
      promptNumber: number,
      createdAtEpoch: number,
      note: { title: string; content: string } | null,
    ): number {
      const turnId = db
        .query<
          { id: number },
          [number, number, string | null, string | null, number]
        >(
          `INSERT INTO turns (
             session_id, prompt_number, status, user_prompt, assistant_response,
             title, content, extraction_stall_attempts, created_at_epoch
           ) VALUES (?, ?, 'provisional', 'prompt', 'response', ?, ?, 3, ?)
           RETURNING id`,
        )
        .get(
          sessionId,
          promptNumber,
          note?.title ?? null,
          note?.content ?? null,
          createdAtEpoch,
        )!.id;
      db.query(
        `INSERT INTO pending_queue (
           kind, target_id, session_db_id, enqueued_at_epoch
         ) VALUES ('turn-stop', ?, ?, ?)`,
      ).run(turnId, sessionId, 100 + promptNumber);
      return turnId;
    }

    function createFlooringCore(eraCutoffEpoch: number | null) {
      return createWorkerCore({
        db,
        now: () => 123,
        nowMs: () => 1_000,
        config: { ...DEFAULT_CONFIG, eraCutoffEpoch },
        logger: { warn() {}, error() {} },
        createWorkerQuerySessionImpl: (() => {
          throw new Error("a turn at its stall limit must never be dispatched");
        }) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
        isProcessAliveImpl: () => false,
      });
    }

    test("a noted era turn floors to extracted, an un-noted one to skipped", async () => {
      const notedTurnId = seedStalledTurn(1, 10, {
        title: "the agent's own note",
        content: "First-person record of this turn.",
      });
      const unnotedTurnId = seedStalledTurn(2, 10, null);

      await createFlooringCore(ERA_CUTOFF).scanAndDrainQueue();

      // `failed` would hide a record that is on the row and correct.
      expect(getTurnById(db, notedTurnId)).toMatchObject({
        status: "extracted",
        title: "the agent's own note",
      });
      // Nobody noted it, and a hole has always been `skipped`.
      expect(getTurnById(db, unnotedTurnId)?.status).toBe("skipped");
    });

    test("a pre-cutoff turn still floors to failed", async () => {
      const legacyNotedTurnId = seedStalledTurn(1, 1, {
        title: "partial extraction",
        content: "half a record",
      });
      const legacyTurnId = seedStalledTurn(2, 1, null);

      await createFlooringCore(ERA_CUTOFF).scanAndDrainQueue();

      expect(getTurnById(db, legacyNotedTurnId)?.status).toBe("failed");
      expect(getTurnById(db, legacyTurnId)?.status).toBe("failed");
    });

    test("with no cutoff configured every turn floors to failed", async () => {
      const turnId = seedStalledTurn(1, 10, {
        title: "the agent's own note",
        content: "First-person record of this turn.",
      });

      await createFlooringCore(null).scanAndDrainQueue();

      expect(getTurnById(db, turnId)?.status).toBe("failed");
    });
  });

  test("a partial turn still consumes a stall when its final slice remembers nothing", async () => {
    const turnId = queueTurn(1);
    updateTurnById(db, turnId, {
      status: "extracted",
      title: "Partial extraction from an earlier streaming slice",
    });
    const core = createAlwaysStallingCore(
      () => 1_000,
      [],
      [],
    );

    await core.scanAndDrainQueue();

    expect(getTurnById(db, turnId)).toMatchObject({
      status: "extracted",
      extractionStallAttempts: 1,
      extractionStallRetryMode: "resume",
    });
    expect(
      db.query<{ count: number }, [number]>(
        `SELECT COUNT(*) AS count FROM pending_queue
         WHERE kind = 'turn-stop' AND target_id = ?`,
      ).get(turnId)!.count,
    ).toBe(1);
  });
});
