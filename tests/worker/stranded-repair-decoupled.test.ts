import { afterEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { createDiaryStateStore } from "../../src/db/diary-state";
import { listPendingQueueItems } from "../../src/db/pending-queue";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurnById, updateTurnById } from "../../src/db/turns";
import { DEFAULT_CONFIG } from "../../src/shared/config";
import { createWorkerCore } from "../../src/worker/server";
import type { WorkerQuerySession } from "../../src/worker/query-session";

/**
 * The stranded-turn repair used to reuse the due days the dream backlog
 * reconcile returned, so the product default (`dreamAgentEnabled: false`, which
 * never reconciles and therefore never returns a day) silently switched the
 * whole cleanup off. Every case here runs with the dream disabled.
 */

// Content-days are Asia/Shanghai with a 4am boundary, so these are 2026-07-10
// and 2026-07-11 respectively — the stranded turn sits on a closed day.
const STRANDED_EPOCH = Date.parse("2026-07-10T12:00:00+08:00") / 1_000;
const END_EVENT_EPOCH = Date.parse("2026-07-11T12:00:00+08:00") / 1_000;
const DUE_DATE = "2026-07-10";

/** Queue residue that belongs to extraction — the seeded dream day is not it. */
function extractionQueue(db: Database) {
  return listPendingQueueItems(db).filter((item) => item.kind !== "diary");
}

describe("stranded repair runs with the dream disabled", () => {
  const databases: Database[] = [];
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  function setup(options: {
    repairHasEnv?: boolean;
    strandedInTriggerSession?: boolean;
    strandedEpoch?: number;
    /** A second stranded turn in the (registered) triggering session. */
    strandTriggerSessionToo?: boolean;
    /** Runs inside the drain, i.e. after the scan and before the floor. */
    onSendPrompt?: (registry: Map<string, Record<string, string>>) => void;
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
      createdAtEpoch: STRANDED_EPOCH,
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
          createdAtEpoch: STRANDED_EPOCH,
          updatedAtEpoch: null,
          completedAtEpoch: null,
        }).id;
    const strandedTurnId = db.query<{ id: number }, [number, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         was_interrupted, created_at_epoch
       ) VALUES (?, 1, 'active', 'old prompt', 'old response', 1, ?)
       RETURNING id`,
    ).get(strandedSessionId, options.strandedEpoch ?? STRANDED_EPOCH)!.id;

    const triggerStrandedTurnId = options.strandTriggerSessionToo
      ? db.query<{ id: number }, [number, number]>(
          `INSERT INTO turns (
             session_id, prompt_number, status, user_prompt, assistant_response,
             was_interrupted, created_at_epoch
           ) VALUES (?, 1, 'active', 'trigger prompt', 'trigger response', 1, ?)
           RETURNING id`,
        ).get(triggerSessionId, options.strandedEpoch ?? STRANDED_EPOCH)!.id
      : null;

    // A day is waiting in the dream queue: with the switch off nothing may
    // claim it, and the repair must no longer need it either.
    const stateStore = createDiaryStateStore(db);
    stateStore.enqueueDay({ date: DUE_DATE, enqueuedAtEpoch: STRANDED_EPOCH });

    const reconcileDreamBacklog = mock(async () => [DUE_DATE]);
    const processDiaryItem = mock(async () => {});
    const registry = new Map<string, Record<string, string>>([
      ["trigger-session", {}],
    ]);
    if (options.repairHasEnv) registry.set("stranded-session", {});
    const core = createWorkerCore({
      db,
      now: () => END_EVENT_EPOCH,
      sessionEnvRegistry: registry,
      config: DEFAULT_CONFIG,
      reconcileDreamBacklog,
      processDiaryItem,
      createWorkerQuerySessionImpl: ((...args: unknown[]) => {
        const deps = (args.length === 2 ? args[1] : args[3]) as
          | { onRemember?: (id: string) => void }
          | undefined;
        return {
          sessionId: "decoupled-worker",
          queryPid: 123,
          async sendPrompt(prompt: string) {
            options.onSendPrompt?.(registry);
            for (const match of prompt.matchAll(/<turn id="T(\d+)"/g)) {
              const turnId = Number(match[1]);
              updateTurnById(db, turnId, {
                status: "extracted",
                title: "recovered",
                content: "completed normally",
              });
              deps?.onRemember?.(`T${turnId}`);
            }
            return { session_id: "decoupled-worker" };
          },
          async close() {},
        } satisfies WorkerQuerySession;
      }) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
      isProcessAliveImpl: () => false,
      logger: { warn() {}, error() {} },
    });
    return {
      db,
      core,
      registry,
      triggerSessionId,
      strandedTurnId,
      triggerStrandedTurnId,
      stateStore,
      reconcileDreamBacklog,
      processDiaryItem,
    };
  }

  for (const entry of ["SessionEnd", "PreCompact"] as const) {
    test(`${entry} floors an unreachable stranded turn without any dream work`, async () => {
      const fixture = setup();

      if (entry === "SessionEnd") {
        await fixture.core.finishSession(fixture.triggerSessionId);
      } else {
        await fixture.core.handleCompact(fixture.triggerSessionId, null);
      }

      expect(getTurnById(fixture.db, fixture.strandedTurnId)?.status).toBe("failed");
      expect(extractionQueue(fixture.db)).toEqual([]);
      expect(fixture.reconcileDreamBacklog).not.toHaveBeenCalled();
      expect(fixture.processDiaryItem).not.toHaveBeenCalled();
      expect(fixture.stateStore.hasQueuedDay(DUE_DATE)).toBe(true);
    });
  }

  test("a reachable stranded turn is restored and extracted", async () => {
    const fixture = setup({ repairHasEnv: true });

    await fixture.core.finishSession(fixture.triggerSessionId);

    expect(getTurnById(fixture.db, fixture.strandedTurnId)?.status).toBe("extracted");
    expect(extractionQueue(fixture.db)).toEqual([]);
    expect(fixture.reconcileDreamBacklog).not.toHaveBeenCalled();
  });

  test("PreCompact still drains repair-restored work for its own compacting session", async () => {
    // The repair window keeps the triggering session in compactingSessions, so
    // the ordinary global drain skips it and only the session-scoped second
    // drain can finish this work. Decoupling must not change that.
    const fixture = setup({ strandedInTriggerSession: true });

    await fixture.core.handleCompact(fixture.triggerSessionId, null);

    expect(getTurnById(fixture.db, fixture.strandedTurnId)?.status).toBe("extracted");
    expect(extractionQueue(fixture.db)).toEqual([]);
  });

  test("a turn on the still-open content-day keeps its live status", async () => {
    // Decoupling from the dream must not widen the repair's reach. Today's
    // queued work includes suspended-and-resumable rows (a connection failure,
    // a cleared session env), and the closed-day rule is what protects them.
    const fixture = setup({ strandedEpoch: END_EVENT_EPOCH - 60 });

    await fixture.core.finishSession(fixture.triggerSessionId);

    expect(getTurnById(fixture.db, fixture.strandedTurnId)?.status).toBe("active");
  });

  test("repeated end events are idempotent", async () => {
    const fixture = setup({ repairHasEnv: true });

    await fixture.core.finishSession(fixture.triggerSessionId);
    await fixture.core.handleCompact(fixture.triggerSessionId, null);
    await fixture.core.finishSession(fixture.triggerSessionId);

    expect(getTurnById(fixture.db, fixture.strandedTurnId)?.status).toBe("extracted");
    expect(getTurnById(fixture.db, fixture.strandedTurnId)?.title).toBe("recovered");
    expect(extractionQueue(fixture.db)).toEqual([]);
  });

  test("a session that re-registers during the drain is not floored", async () => {
    // The scan judges reachability, then the caller AWAITS a drain, and only
    // then does the floor run. A session that comes back inside that window is
    // resuming: flooring it on the stale verdict would mark its live turn failed
    // and delete the queue rows carrying the resume. The floor therefore
    // re-asks, per turn, inside its own write transaction.
    const fixture = setup({
      strandTriggerSessionToo: true,
      onSendPrompt: (registry) => registry.set("stranded-session", {}),
    });

    await fixture.core.finishSession(fixture.triggerSessionId);

    // The triggering session was reachable all along and completed normally.
    expect(getTurnById(fixture.db, fixture.triggerStrandedTurnId!)?.status).toBe(
      "extracted",
    );
    // The one that came back mid-drain kept its live status and its queue row.
    expect(getTurnById(fixture.db, fixture.strandedTurnId)?.status).toBe("active");

    // And it is not lost: once it is gone again, the next end event floors it.
    fixture.registry.delete("stranded-session");
    await fixture.core.finishSession(fixture.triggerSessionId);
    expect(getTurnById(fixture.db, fixture.strandedTurnId)?.status).toBe("failed");
  });

  test("a pure liveness scan still does not repair", async () => {
    const fixture = setup({ repairHasEnv: true });

    fixture.core.recoverFromCrash();
    await fixture.core.scanAndDrainQueue();

    expect(getTurnById(fixture.db, fixture.strandedTurnId)?.status).toBe("active");
  });
});
