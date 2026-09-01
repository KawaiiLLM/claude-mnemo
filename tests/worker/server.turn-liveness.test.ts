import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { DEFAULT_CONFIG } from "../../src/shared/config";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurnById, updateTurnById } from "../../src/db/turns";
import { createWorkerCore } from "../../src/worker/server";

const DUE_DATE = "2026-07-10";
const DUE_EPOCH = Date.parse(`${DUE_DATE}T12:00:00Z`) / 1_000;
const END_EVENT_EPOCH = Date.parse("2026-07-11T12:00:00Z") / 1_000;

/**
 * These cases used to be titled "... before diary claim", and their witness
 * was `diaryStatuses`: a `processDiaryItem` stub that recorded the stranded
 * turn's status AT THE MOMENT the end event's nightly-dream claim fired, which
 * pinned the ORDER of the two halves of `coordinateEndEvent` (repair first,
 * dream claim second).
 *
 * dream-retirement ticket 01 deleted the dream, so the end event has only one
 * half left and there is no second consumer to be ordered against. The witness
 * is retired with it; every case keeps its real subject — that the end event
 * floors, restores or leaves alone exactly the right turns — asserted directly
 * on the turn rows and the queue. This IS a coverage reduction and is recorded
 * as one: the intra-event ordering property has no remaining observer at this
 * seam, because the thing it ordered against no longer exists.
 */

describe("end-event extraction-liveness orchestration", () => {
  const databases: Database[] = [];
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  function setup(options: {
    repairHasEnv?: boolean;
    seedStranded?: boolean;
    strandedInTriggerSession?: boolean;
  } = {}) {
    const db = createDatabase(":memory:");
    databases.push(db);
    initializeSchema(db);
    const triggerSessionId = upsertSession(db, {
      contentSessionId: "trigger-session",
      project: "/proj",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: DUE_EPOCH,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
    const strandedSessionId = options.strandedInTriggerSession
      ? triggerSessionId
      : upsertSession(db, {
          contentSessionId: "stranded-session",
          project: "/proj",
          title: null,
          content: null,
          insight: null,
          createdAtEpoch: DUE_EPOCH,
          updatedAtEpoch: null,
          completedAtEpoch: null,
        }).id;
    const strandedTurnId = options.seedStranded === false
      ? null
      : db.query<{ id: number }, [number, number]>(
          `INSERT INTO turns (
             session_id, prompt_number, status, user_prompt, assistant_response,
             was_interrupted, created_at_epoch
           ) VALUES (?, 1, 'active', 'old prompt', 'old response', 1, ?)
           RETURNING id`,
        ).get(strandedSessionId, DUE_EPOCH)!.id;
    const registry = new Map<string, Record<string, string>>([
      ["trigger-session", {}],
    ]);
    if (options.repairHasEnv) registry.set("stranded-session", {});
    const core = createWorkerCore({
      db,
      now: () => END_EVENT_EPOCH,
      sessionEnvRegistry: registry,
      config: DEFAULT_CONFIG,
      logger: { warn() {}, error() {} },
    });
    return {
      db,
      core,
      triggerSessionId,
      strandedTurnId,
    };
  }

  for (const entry of ["Stop", "SessionEnd", "PreCompact"] as const) {
    test(`${entry} repairs the stranded turn`, async () => {
      const fixture = setup();
      if (entry === "Stop") {
        const triggerTurnId = fixture.db.query<{ id: number }, [number, number]>(
          `INSERT INTO turns (
             session_id, prompt_number, status, user_prompt, assistant_response, created_at_epoch
           ) VALUES (?, 1, 'active', 'trigger', 'done', ?)
           RETURNING id`,
        ).get(fixture.triggerSessionId, END_EVENT_EPOCH)!.id;
        fixture.db.query(
          `INSERT INTO pending_queue (kind, target_id, session_db_id, enqueued_at_epoch)
           VALUES ('turn-stop', ?, ?, ?)`,
        ).run(triggerTurnId, fixture.triggerSessionId, END_EVENT_EPOCH);
        await fixture.core.handleTurnStop(fixture.triggerSessionId);
      } else if (entry === "SessionEnd") {
        await fixture.core.finishSession(fixture.triggerSessionId);
      } else {
        await fixture.core.handleCompact(fixture.triggerSessionId, null);
      }

      expect(getTurnById(fixture.db, fixture.strandedTurnId!)?.status).toBe("failed");
    });
  }

  test("pure liveness scan and worker recovery do not run repair", async () => {
    const fixture = setup({ repairHasEnv: true });
    fixture.db.query(
      `INSERT INTO pending_queue (
         kind, target_id, session_db_id, enqueued_at_epoch
       ) VALUES ('turn-stop', ?, ?, ?)`,
    ).run(
      fixture.strandedTurnId,
      fixture.db.query<{ id: number }, []>(
        "SELECT id FROM sessions WHERE content_session_id = 'stranded-session'",
      ).get()!.id,
      DUE_EPOCH,
    );

    // THE WITNESS. The queued turn above drains on ANY scan, so its terminal
    // status cannot distinguish "the drain ran" from "the repair ran" — it was
    // the retired `diaryStatuses` probe that used to carry that distinction.
    // This second stranded turn has no queue row and lives in a session with
    // no registered environment, so ONLY the end-event repair can move it: it
    // must still be `active` after a pure scan, and it is what goes red if the
    // sweep is ever hung off the global drain instead of the end event.
    const unrepairedSessionId = upsertSession(fixture.db, {
      contentSessionId: "unrepaired-session",
      project: "/proj",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: DUE_EPOCH,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
    const unrepairedTurnId = fixture.db.query<{ id: number }, [number, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         was_interrupted, created_at_epoch
       ) VALUES (?, 1, 'active', 'unrepaired prompt', 'unrepaired response', 1, ?)
       RETURNING id`,
    ).get(unrepairedSessionId, DUE_EPOCH)!.id;

    fixture.core.recoverFromCrash();
    await fixture.core.scanAndDrainQueue();

    expect(getTurnById(fixture.db, fixture.strandedTurnId!)?.status).toBe("failed");
    expect(getTurnById(fixture.db, unrepairedTurnId)?.status).toBe("active");

    // ...and the very same turn IS floored once a real end event runs, so the
    // assertion above is a genuine discriminator rather than a turn that
    // nothing could ever have repaired.
    await fixture.core.finishSession(fixture.triggerSessionId);
    expect(getTurnById(fixture.db, unrepairedTurnId)?.status).toBe("failed");
  });

  test("one conditional second drain completes restored work", async () => {
    const fixture = setup({ repairHasEnv: true });

    await fixture.core.finishSession(fixture.triggerSessionId);

    expect(getTurnById(fixture.db, fixture.strandedTurnId!)?.status).toBe("failed");
  });

  test("PreCompact drains repair-restored work for its own compacting session", async () => {
    const fixture = setup({ strandedInTriggerSession: true });

    await fixture.core.handleCompact(fixture.triggerSessionId, null);

    expect(getTurnById(fixture.db, fixture.strandedTurnId!)?.status).toBe("failed");
  });

  test("does not create extraction work when repair finds nothing", async () => {
    const fixture = setup({ seedStranded: false });

    await fixture.core.finishSession(fixture.triggerSessionId);

    // Nothing to repair: the end event must not manufacture extraction work.
    expect(
      fixture.db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM pending_queue",
        )
        .get()?.count,
    ).toBe(0);
  });

  test("restart claim reset makes orphaned work executable on the next end event", async () => {
    const fixture = setup({ repairHasEnv: true });
    fixture.db.query(
      `INSERT INTO pending_queue (
         kind, target_id, session_db_id, claimed_at_epoch, enqueued_at_epoch
       ) VALUES ('turn-stop', ?, ?, 123, ?)`,
    ).run(
      fixture.strandedTurnId,
      fixture.db.query<{ id: number }, []>(
        "SELECT id FROM sessions WHERE content_session_id = 'stranded-session'",
      ).get()!.id,
      DUE_EPOCH,
    );

    fixture.core.recoverFromCrash();
    await fixture.core.finishSession(fixture.triggerSessionId);

    expect(getTurnById(fixture.db, fixture.strandedTurnId!)?.status).toBe("failed");
  });

  test("repeated end events leave repaired terminal records and stop queues unchanged", async () => {
    const fixture = setup();

    await fixture.core.finishSession(fixture.triggerSessionId);
    await fixture.core.handleCompact(fixture.triggerSessionId, null);

    expect(getTurnById(fixture.db, fixture.strandedTurnId!)?.status).toBe("failed");
    expect(fixture.db.query<{ count: number }, [number]>(
      `SELECT COUNT(*) AS count FROM pending_queue
       WHERE kind = 'turn-stop' AND target_id = ?`,
    ).get(fixture.strandedTurnId!)?.count).toBe(0);
  });
});
