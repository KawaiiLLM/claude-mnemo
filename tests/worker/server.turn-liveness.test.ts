import { afterEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { createDiaryStateStore } from "../../src/db/diary-state";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurnById, updateTurnById } from "../../src/db/turns";
import { createWorkerCore } from "../../src/worker/server";
import { DREAM_ENABLED_CONFIG } from "../support/dream-config";

const DUE_DATE = "2026-07-10";
const DUE_EPOCH = Date.parse(`${DUE_DATE}T12:00:00Z`) / 1_000;
const END_EVENT_EPOCH = Date.parse("2026-07-11T12:00:00Z") / 1_000;

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
    const stateStore = createDiaryStateStore(db);
    stateStore.enqueueDay({ date: DUE_DATE, enqueuedAtEpoch: DUE_EPOCH });
    const diaryStatuses: Array<string | undefined> = [];
    const reconcileDreamBacklog = mock(async () => [DUE_DATE]);
    const registry = new Map<string, Record<string, string>>([
      ["trigger-session", {}],
    ]);
    if (options.repairHasEnv) registry.set("stranded-session", {});
    const core = createWorkerCore({
      db,
      now: () => END_EVENT_EPOCH,
      sessionEnvRegistry: registry,
      config: DREAM_ENABLED_CONFIG,
      reconcileDreamBacklog,
      async processDiaryItem(item) {
        diaryStatuses.push(
          strandedTurnId === null ? "no-stranded-turn" : getTurnById(db, strandedTurnId)?.status,
        );
        stateStore.acknowledgeDiaryItem(item.seq);
      },
      logger: { warn() {}, error() {} },
    });
    return {
      db,
      core,
      triggerSessionId,
      strandedTurnId,
      diaryStatuses,
      reconcileDreamBacklog,
    };
  }

  for (const entry of ["Stop", "SessionEnd", "PreCompact"] as const) {
    test(`${entry} repairs before diary claim`, async () => {
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
      expect(fixture.diaryStatuses).toEqual(["failed"]);
      expect(fixture.reconcileDreamBacklog).toHaveBeenCalledTimes(1);
    });
  }

  test("pure liveness scan and worker recovery do not run repair or dream", async () => {
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

    fixture.core.recoverFromCrash();
    await fixture.core.scanAndDrainQueue();

    expect(fixture.reconcileDreamBacklog).not.toHaveBeenCalled();
    expect(fixture.diaryStatuses).toEqual([]);
    expect(getTurnById(fixture.db, fixture.strandedTurnId!)?.status).toBe("failed");
  });

  test("one conditional second drain completes restored work before diary readiness", async () => {
    const fixture = setup({ repairHasEnv: true });

    await fixture.core.finishSession(fixture.triggerSessionId);

    expect(fixture.reconcileDreamBacklog).toHaveBeenCalledTimes(1);
    expect(getTurnById(fixture.db, fixture.strandedTurnId!)?.status).toBe("failed");
    expect(fixture.diaryStatuses).toEqual(["failed"]);
  });

  test("PreCompact drains repair-restored work for its own compacting session before diary claim", async () => {
    const fixture = setup({ strandedInTriggerSession: true });

    await fixture.core.handleCompact(fixture.triggerSessionId, null);

    expect(getTurnById(fixture.db, fixture.strandedTurnId!)?.status).toBe("failed");
    expect(fixture.diaryStatuses).toEqual(["failed"]);
  });

  test("does not create extraction work when repair finds nothing", async () => {
    const fixture = setup({ seedStranded: false });

    await fixture.core.finishSession(fixture.triggerSessionId);

    expect(fixture.diaryStatuses).toEqual(["no-stranded-turn"]);
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
    expect(fixture.diaryStatuses).toEqual(["failed"]);
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
    expect(fixture.diaryStatuses).toEqual(["failed"]);
  });
});
