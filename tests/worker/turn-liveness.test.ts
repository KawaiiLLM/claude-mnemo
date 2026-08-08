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
  listStrandedRepairDates,
  restoreStrandedTurnStops,
} from "../../src/worker/turn-liveness";

const DUE_DATE = "2026-07-21";
const OTHER_DATE = "2026-07-22";
const DUE_EPOCH = Date.parse(`${DUE_DATE}T12:00:00Z`) / 1_000;
const OTHER_EPOCH = Date.parse(`${OTHER_DATE}T12:00:00Z`) / 1_000;

describe("stranded-turn liveness repair", () => {
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

  function derivedDates(
    options: { boundaryHour?: number; nowEpoch?: number } = {},
  ): string[] {
    return listStrandedRepairDates(db, {
      timeZone: "UTC",
      boundaryHour: options.boundaryHour ?? 0,
      // A day after the last seeded turn, so every seeded day is closed.
      nowEpoch: options.nowEpoch ?? OTHER_EPOCH + 86_400,
    });
  }

  function repair(registered = new Set<number>()) {
    return restoreStrandedTurnStops(db, {
      dates: [DUE_DATE],
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
    expect(result.unreachable.map((item) => item.turnId)).toEqual([
      queued,
      followed,
      interrupted,
      rolledBack,
    ]);
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
    expect(first.unreachable).toEqual([]);
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
    const first = finalizeUnreachableStrandedTurns(db, prepared.unreachable, {
      hasRegisteredSessionEnv: () => false,
    });
    const second = finalizeUnreachableStrandedTurns(db, prepared.unreachable, {
      hasRegisteredSessionEnv: () => false,
    });

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

  test("a session that re-registers between the scan and the floor is spared", () => {
    // The caller awaits a drain in that window, and a session whose environment
    // comes back is being resumed, not abandoned. Flooring on the stale verdict
    // would mark a live turn failed and delete the queue rows carrying its
    // resume.
    const stranded = seedTurn({ promptNumber: 1, interrupted: true });
    db.query(
      `INSERT INTO pending_queue (kind, target_id, session_db_id, enqueued_at_epoch)
       VALUES ('turn-stop', ?, ?, ?)`,
    ).run(stranded, sessionId, DUE_EPOCH);

    const prepared = repair();
    expect(prepared.unreachable.map((item) => item.turnId)).toEqual([stranded]);

    const registered = new Set<number>();
    const floored = finalizeUnreachableStrandedTurns(db, prepared.unreachable, {
      hasRegisteredSessionEnv: (id) => {
        registered.add(id);
        return true;
      },
    });

    expect(floored).toEqual([]);
    expect(registered).toEqual(new Set([sessionId]));
    expect(getTurnById(db, stranded)?.status).toBe("active");
    expect(
      listPendingQueueItems(db).filter((item) => item.kind === "turn-stop"),
    ).toHaveLength(1);
  });

  test("a turn whose queue or observations moved during the repair is deferred", () => {
    const requeued = seedTurn({ promptNumber: 1, interrupted: true });
    const observed = seedTurn({ promptNumber: 2, interrupted: true });

    const prepared = repair();
    expect(prepared.unreachable.map((item) => item.turnId)).toEqual([
      requeued,
      observed,
    ]);

    // Both are things only a live session does: a stop re-queued by the Stop
    // hook, and a tool result captured by PostToolUse.
    db.query(
      `INSERT INTO pending_queue (kind, target_id, session_db_id, enqueued_at_epoch)
       VALUES ('turn-stop', ?, ?, ?)`,
    ).run(requeued, sessionId, DUE_EPOCH + 50);
    createObservation(db, {
      turnId: observed,
      toolName: "Bash",
      status: "pending",
      createdAtEpoch: DUE_EPOCH + 50,
    });

    const floored = finalizeUnreachableStrandedTurns(db, prepared.unreachable, {
      hasRegisteredSessionEnv: () => false,
    });

    expect(floored).toEqual([]);
    expect(getTurnById(db, requeued)?.status).toBe("active");
    expect(getTurnById(db, observed)?.status).toBe("active");

    // Nothing is lost: the next end event re-scans and floors what is still
    // stranded then.
    const nextRound = repair();
    expect(
      finalizeUnreachableStrandedTurns(db, nextRound.unreachable, {
        hasRegisteredSessionEnv: () => false,
      }).map((item) => item.turnId),
    ).toEqual([requeued, observed]);
  });

  test("derives one repair date per content-day holding a stranded turn", () => {
    seedTurn({ promptNumber: 1, interrupted: true });
    seedTurn({ promptNumber: 2, rolledBack: true });
    seedTurn({
      sessionDbId: makeSession("other-day-session"),
      promptNumber: 1,
      createdAtEpoch: OTHER_EPOCH,
      interrupted: true,
    });

    expect(derivedDates()).toEqual([DUE_DATE, OTHER_DATE]);
  });

  test("no evidence, no response, or a terminal status derives no date", () => {
    seedTurn({ promptNumber: 1 });
    seedTurn({
      sessionDbId: makeSession("no-response-session"),
      promptNumber: 1,
      response: null,
      interrupted: true,
    });
    const terminal = seedTurn({
      sessionDbId: makeSession("terminal-session"),
      promptNumber: 1,
      interrupted: true,
    });
    db.query("UPDATE turns SET status = 'extracted' WHERE id = ?").run(terminal);

    expect(derivedDates()).toEqual([]);
  });

  test("the boundary hour rolls a small-hours turn into the previous content-day", () => {
    seedTurn({
      promptNumber: 1,
      createdAtEpoch: Date.parse(`${OTHER_DATE}T02:00:00Z`) / 1_000,
      interrupted: true,
    });

    expect(derivedDates({ boundaryHour: 4, nowEpoch: OTHER_EPOCH })).toEqual([DUE_DATE]);
  });

  test("the still-open content-day derives no date", () => {
    // Today's queued stops include work that is merely suspended — a connection
    // failure keeps its row for a later resume, a cleared session env gates its
    // rows. The repair cannot tell those from strandings, so it waits out the
    // day rather than flooring them.
    seedTurn({ promptNumber: 1, createdAtEpoch: OTHER_EPOCH, interrupted: true });

    expect(derivedDates({ nowEpoch: OTHER_EPOCH + 3_600 })).toEqual([]);
    expect(derivedDates({ nowEpoch: OTHER_EPOCH + 86_400 })).toEqual([OTHER_DATE]);
  });

  test("in a DST-free zone the derived dates cover every dream due day's candidates", () => {
    // The old wiring scanned exactly the due days the dream reconcile returned.
    // A due day only ever yields turns that live inside it, and each such turn
    // puts its own content-day into the derived set, so the due-day result is
    // always a subset — unioning the two would add nothing.
    //
    // The "always" holds where contentDateAt inverts calendarDayBounds exactly,
    // i.e. a zone without DST: the Asia/Shanghai default and the UTC here. Under
    // a DST zone with a small-hours boundary the two can disagree by an hour on
    // a transition day; see listStrandedRepairDates.
    const onDueDay = seedTurn({ promptNumber: 1, interrupted: true });
    const offDueDay = seedTurn({
      sessionDbId: makeSession("off-due-day-session"),
      promptNumber: 1,
      createdAtEpoch: OTHER_EPOCH,
      interrupted: true,
    });
    const scan = (dates: string[]) =>
      restoreStrandedTurnStops(db, {
        dates,
        timeZone: "UTC",
        boundaryHour: 0,
        nowEpoch: DUE_EPOCH + 100,
        hasRegisteredSessionEnv: () => false,
      });

    expect(scan([DUE_DATE]).strandedTurnIds).toEqual([onDueDay]);
    expect(scan(derivedDates()).strandedTurnIds).toEqual([
      onDueDay,
      offDueDay,
    ]);
  });

  test("the derived-date repair stays idempotent across runs", () => {
    // The restored stop is itself completion evidence, so the turn stays in the
    // derived set until it goes terminal; the dedup must hold every run.
    const stranded = seedTurn({ promptNumber: 1, interrupted: true });
    const run = () =>
      restoreStrandedTurnStops(db, {
        dates: derivedDates(),
        timeZone: "UTC",
        boundaryHour: 0,
        nowEpoch: DUE_EPOCH + 100,
        hasRegisteredSessionEnv: () => true,
      });

    expect(run().enqueuedTurnStopCount).toBe(1);
    expect(run().enqueuedTurnStopCount).toBe(0);
    expect(derivedDates()).toEqual([DUE_DATE]);
    expect(
      listPendingQueueItems(db).filter(
        (item) => item.kind === "turn-stop" && item.targetId === stranded,
      ),
    ).toHaveLength(1);
  });
});
