import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { createObservation, getObservation } from "../../src/db/observations";
import { listPendingQueueItems } from "../../src/db/pending-queue";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurnById, updateTurnById } from "../../src/db/turns";
import { createWorkerCore } from "../../src/worker/server";
import type { WorkerQuerySession } from "../../src/worker/query-session";
import {
  finalizeUnreachableStrandedTurns,
  restoreStrandedTurnStops,
} from "../../src/worker/turn-liveness";

const DUE_DATE = "2026-07-21";
const OTHER_DATE = "2026-07-22";
const DUE_EPOCH = Date.parse(`${DUE_DATE}T12:00:00Z`) / 1_000;
const OTHER_EPOCH = Date.parse(`${OTHER_DATE}T12:00:00Z`) / 1_000;

describe("closed-day stranded-turn liveness repair", () => {
  let db: Database;
  let sessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = makeSession("stranded-session");
  });

  afterEach(() => db.close());

  function makeSession(contentSessionId: string): number {
    return upsertSession(db, {
      contentSessionId,
      project: "/proj",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: DUE_EPOCH,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
  }

  function seedTurn(input: {
    sessionDbId?: number;
    promptNumber: number;
    status?: "active" | "provisional";
    response?: string | null;
    title?: string | null;
    content?: string | null;
    createdAtEpoch?: number;
    interrupted?: boolean;
    rolledBack?: boolean;
  }): number {
    return db.query<
      { id: number },
      [number, number, string, string | null, string | null, string | null, number, number, number]
    >(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         title, content, created_at_epoch, was_interrupted, was_rolled_back
       ) VALUES (?, ?, ?, 'prompt', ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    ).get(
      input.sessionDbId ?? sessionId,
      input.promptNumber,
      input.status ?? "active",
      input.response === undefined ? "response" : input.response,
      input.title ?? null,
      input.content ?? null,
      input.createdAtEpoch ?? DUE_EPOCH,
      input.interrupted ? 1 : 0,
      input.rolledBack ? 1 : 0,
    )!.id;
  }

  function repair(registered = new Set<number>()) {
    return restoreStrandedTurnStops(db, {
      dueDates: [DUE_DATE],
      timeZone: "UTC",
      boundaryHour: 0,
      nowEpoch: DUE_EPOCH + 100,
      hasRegisteredSessionEnv: (id) => registered.has(id),
    });
  }

  test("recognizes queued-stop, later-turn, and invalidation completion evidence", () => {
    const queued = seedTurn({ promptNumber: 1 });
    db.query(
      `INSERT INTO pending_queue (kind, target_id, session_db_id, enqueued_at_epoch)
       VALUES ('turn-stop', ?, ?, ?)`,
    ).run(queued, sessionId, DUE_EPOCH);
    const laterSessionId = makeSession("later-turn-session");
    const followed = seedTurn({ sessionDbId: laterSessionId, promptNumber: 1 });
    seedTurn({ sessionDbId: laterSessionId, promptNumber: 2 });
    const invalidatedSessionId = makeSession("invalidated-session");
    const interrupted = seedTurn({
      sessionDbId: invalidatedSessionId,
      promptNumber: 1,
      interrupted: true,
    });
    const rolledBack = seedTurn({
      sessionDbId: invalidatedSessionId,
      promptNumber: 2,
      rolledBack: true,
    });

    const result = repair();

    expect(result.strandedTurnIds).toEqual([queued, followed, interrupted, rolledBack]);
    expect(result.unreachableTurnIds).toEqual([queued, followed, interrupted, rolledBack]);
  });

  test("leaves no-evidence, no-response, and outside-due-day turns untouched", () => {
    const noEvidence = seedTurn({ promptNumber: 1 });
    const noResponse = seedTurn({
      sessionDbId: makeSession("no-response-session"),
      promptNumber: 1,
      response: null,
      interrupted: true,
    });
    const outsideDue = seedTurn({
      sessionDbId: makeSession("outside-due-session"),
      promptNumber: 1,
      createdAtEpoch: OTHER_EPOCH,
      interrupted: true,
    });

    const result = repair();

    expect(result.strandedTurnIds).toEqual([]);
    expect([noEvidence, noResponse, outsideDue].map((id) => getTurnById(db, id)?.status)).toEqual([
      "active",
      "active",
      "active",
    ]);
  });

  test("restores one deduplicated stop when the original session environment is available", () => {
    const stranded = seedTurn({ promptNumber: 1, interrupted: true });

    const first = repair(new Set([sessionId]));
    const second = repair(new Set([sessionId]));

    expect(first.enqueuedTurnStopCount).toBe(1);
    expect(second.enqueuedTurnStopCount).toBe(0);
    expect(listPendingQueueItems(db).filter((item) => item.kind === "turn-stop" && item.targetId === stranded)).toHaveLength(1);
    expect(first.unreachableTurnIds).toEqual([]);
  });

  test("runs a restored stop through ordinary extraction when the environment is available", async () => {
    const stranded = seedTurn({ promptNumber: 1, interrupted: true });
    repair(new Set([sessionId]));
    const core = createWorkerCore({
      db,
      now: () => DUE_EPOCH + 100,
      sessionEnvRegistry: new Map([["stranded-session", {}]]),
      createWorkerQuerySessionImpl: ((...args: unknown[]) => {
        const deps = (args.length === 2 ? args[1] : args[3]) as
          | { onRemember?: (id: string) => void }
          | undefined;
        return {
          sessionId: "liveness-worker",
          queryPid: 123,
          async sendPrompt(prompt: string) {
            for (const match of prompt.matchAll(/<turn id="T(\d+)"/g)) {
              const id = Number(match[1]);
              updateTurnById(db, id, {
                status: "extracted",
                title: "recovered",
                content: "ordinary completion",
              });
              deps?.onRemember?.(`T${id}`);
            }
            return { session_id: "liveness-worker" };
          },
          async close() {},
        } satisfies WorkerQuerySession;
      }) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
      isProcessAliveImpl: () => false,
    });

    await core.scanAndDrainQueue();
    await core.flushSession(sessionId);

    expect(getTurnById(db, stranded)?.status).toBe("extracted");
    expect(listPendingQueueItems(db)).toEqual([]);
  });

  test("floors unreachable partial and empty turns atomically with zero queue residue", () => {
    const partial = seedTurn({
      promptNumber: 1,
      status: "provisional",
      title: "usable partial",
      interrupted: true,
    });
    const empty = seedTurn({ promptNumber: 2, interrupted: true });
    for (const turnId of [partial, empty]) {
      const observationId = createObservation(db, {
        turnId,
        toolName: "Bash",
        status: "pending",
        createdAtEpoch: DUE_EPOCH,
      }).id;
      db.query(
        `INSERT INTO pending_queue (kind, target_id, session_db_id, enqueued_at_epoch)
         VALUES ('obs', ?, ?, ?), ('turn-stop', ?, ?, ?)`,
      ).run(observationId, sessionId, DUE_EPOCH, turnId, sessionId, DUE_EPOCH);
    }

    const prepared = repair();
    const first = finalizeUnreachableStrandedTurns(db, prepared.unreachableTurnIds);
    const second = finalizeUnreachableStrandedTurns(db, prepared.unreachableTurnIds);

    expect(getTurnById(db, partial)?.status).toBe("extracted");
    expect(getTurnById(db, empty)?.status).toBe("failed");
    expect(first.map((item) => item.turnId)).toEqual([partial, empty]);
    expect(second).toEqual([]);
    expect(listPendingQueueItems(db)).toEqual([]);
    expect(db.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM observations WHERE status != 'skipped'",
    ).get()?.count).toBe(0);
    expect(getObservation(db, 1)?.status).toBe("skipped");
  });
});
