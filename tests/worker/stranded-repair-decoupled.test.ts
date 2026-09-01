import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { listPendingQueueItems } from "../../src/db/pending-queue";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurnById, updateTurnById } from "../../src/db/turns";
import { DEFAULT_CONFIG } from "../../src/shared/config";
import { createWorkerCore } from "../../src/worker/server";

/**
 * The stranded-turn repair used to reuse the due days the dream backlog
 * reconcile returned, so the product default (`dreamAgentEnabled: false`, which
 * never reconciles and therefore never returns a day) silently switched the
 * whole cleanup off. It was decoupled to derive its own dates.
 *
 * DREAM-RETIREMENT TICKET 01 turned that decoupling into the reason this file
 * did not have to change shape: the dream is deleted, and the repair — which
 * had already stopped depending on it — keeps every behaviour below. What the
 * cases USED to prove by mocking `reconcileDreamBacklog`/`processDiaryItem`
 * and asserting they went uncalled, they now prove structurally: there is no
 * such dependency to inject, and `queueAfterRepair` asserts the queue the
 * repair leaves holds nothing at all — INCLUDING no `diary`-kind row, which is
 * the ticket's "the dream tables go inert" claim seen from the queue side.
 */

// Content-days are Asia/Shanghai with a 4am boundary, so these are 2026-07-10
// and 2026-07-11 respectively — the stranded turn sits on a closed day.
const STRANDED_EPOCH = Date.parse("2026-07-10T12:00:00+08:00") / 1_000;
const END_EVENT_EPOCH = Date.parse("2026-07-11T12:00:00+08:00") / 1_000;

/**
 * The WHOLE queue, unfiltered. This used to filter `kind !== "diary"` because
 * the fixture deliberately seeded a dream day the repair had to leave alone;
 * with the producer deleted nothing enqueues that kind any more, so dropping
 * the filter strengthens every `toEqual([])` below into "and no dream row was
 * created either".
 */
function queueAfterRepair(db: Database) {
  return listPendingQueueItems(db);
}

/**
 * THE INERTNESS PROBE (dream-retirement ticket 01). `diary_state` and
 * `diary_day_state` are deliberately NOT dropped — their `CREATE TABLE` still
 * runs in schema.ts, because dropping is irreversible and buys nothing — so
 * "the producer is gone" cannot be checked by their absence. It is checked by
 * their emptiness across the code path that used to fill them: the worker's
 * end event. Reading them by raw SQL is the point; there is no store module
 * left to read them with.
 */
function dreamTableRowCounts(db: Database): {
  state: number;
  dayState: number;
} {
  const count = (table: string) =>
    db
      .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`)
      .get()!.n;
  return { state: count("diary_state"), dayState: count("diary_day_state") };
}

describe("stranded repair runs with no dream at all", () => {
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
    /**
     * Make "stranded-session" absent to the reachability SCAN and present to
     * the FLOOR — the resume race, reproduced through the only surface the two
     * share. With no agent left there is no mid-drain callback to hang this on,
     * and a registry that answers differently on the second probe is exactly
     * what a session re-registering between them looks like.
     */
    reRegisterAfterScan?: boolean;
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

    const registry = options.reRegisterAfterScan
      ? (() => {
          let probes = 0;
          const map = new Map<string, Record<string, string>>([
            ["trigger-session", {}],
          ]);
          const realGet = map.get.bind(map);
          map.get = (key: string) => {
            if (key === "stranded-session" && (probes += 1) > 1) {
              map.set("stranded-session", {});
            }
            return realGet(key);
          };
          return map;
        })()
      : new Map<string, Record<string, string>>([["trigger-session", {}]]);
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
      registry,
      triggerSessionId,
      strandedTurnId,
      triggerStrandedTurnId,
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
      expect(queueAfterRepair(fixture.db)).toEqual([]);
      // The dream tables stay untouched by an end event (ticket 01: inert, not
      // dropped — `CREATE TABLE` still runs, and nothing ever writes a row).
      expect(dreamTableRowCounts(fixture.db)).toEqual({ state: 0, dayState: 0 });
    });
  }

  test("a reachable stranded turn is restored and settled", async () => {
    const fixture = setup({ repairHasEnv: true });

    await fixture.core.finishSession(fixture.triggerSessionId);

    expect(getTurnById(fixture.db, fixture.strandedTurnId)?.status).toBe("failed");
    expect(queueAfterRepair(fixture.db)).toEqual([]);
    expect(dreamTableRowCounts(fixture.db)).toEqual({ state: 0, dayState: 0 });
  });

  test("PreCompact still drains repair-restored work for its own compacting session", async () => {
    // The repair window keeps the triggering session in compactingSessions, so
    // the ordinary global drain skips it and only the session-scoped second
    // drain can finish this work. Decoupling must not change that.
    const fixture = setup({ strandedInTriggerSession: true });

    await fixture.core.handleCompact(fixture.triggerSessionId, null);

    expect(getTurnById(fixture.db, fixture.strandedTurnId)?.status).toBe("failed");
    expect(queueAfterRepair(fixture.db)).toEqual([]);
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

    expect(getTurnById(fixture.db, fixture.strandedTurnId)?.status).toBe("failed");
    expect(queueAfterRepair(fixture.db)).toEqual([]);
  });

  test("a session that re-registers during the drain is not floored", async () => {
    // The scan judges reachability, then the caller AWAITS a drain, and only
    // then does the floor run. A session that comes back inside that window is
    // resuming: flooring it on the stale verdict would mark its live turn failed
    // and delete the queue rows carrying the resume. The floor therefore
    // re-asks, per turn, inside its own write transaction.
    const fixture = setup({
      strandTriggerSessionToo: true,
      reRegisterAfterScan: true,
    });

    await fixture.core.finishSession(fixture.triggerSessionId);

    // The triggering session was reachable all along and settled normally.
    expect(getTurnById(fixture.db, fixture.triggerStrandedTurnId!)?.status).toBe(
      "failed",
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
