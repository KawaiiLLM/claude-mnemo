import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { unlinkSync } from "node:fs";
import type { Database } from "bun:sqlite";

import { recordInitializerBuild } from "../../src/db/build-state";
import { createDatabase } from "../../src/db/database";
import {
  enqueueNoteSettlementWindows,
  listNoteSettlementJobs,
  NOTE_SETTLEMENT_WINDOW_CAP_TURNS,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { BUILD_ID } from "../../src/shared/build-id";
import { createTransitionOnlyStageOneDispatch } from "../../src/worker/note-settlement";
import {
  checkForStaleBuildShutdown,
  createWorkerCore,
  createWorkerServerState,
  type WorkerServerDeps,
} from "../../src/worker/server";
import {
  SETTLEMENT_ENABLED_CONFIG,
  SETTLEMENT_ERA_CUTOFF_EPOCH,
} from "../support/settlement-config";

/**
 * Ticket 08 — a worker that is no longer the build this database was migrated
 * by claims nothing and leaves.
 *
 * The incident it comes from: a plugin update reaches the short-lived hook and
 * MCP processes on their very next invocation and they run the migrations
 * immediately, while the resident worker keeps dispatching the PREVIOUS
 * release's SQL. Two settlement jobs died on an `ON CONFLICT` clause naming a
 * key that had just been collapsed — and each burned an attempt out of three on
 * the way. A hook-side version check cannot cover this: it only fires when a
 * hook talks to the worker, and the damage happened between two hooks, on the
 * worker's own timer.
 */

/** Whatever this test binary's own id is, and the release that displaced it. */
const FOREIGN_BUILD = "0.11.1-p91xq2k7";

function seedDecidedSession(
  db: Database,
  contentSessionId: string,
  turns: number,
): number {
  const sessionDbId = upsertSession(db, {
    contentSessionId,
    project: "/tmp/project-stale-build",
    title: null,
    content: null,
    insight: null,
    createdAtEpoch: 1,
    updatedAtEpoch: 1_000,
    completedAtEpoch: null,
  }).id;

  for (let promptNumber = 1; promptNumber <= turns; promptNumber += 1) {
    const turnId = db
      .query<{ id: number }, [number, number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt,
           assistant_response, created_at_epoch
         ) VALUES (?, ?, 'failed', 'prompt', 'reply', 1000)
         RETURNING id`,
      )
      .get(sessionDbId, promptNumber)!.id;
    db.query<unknown, [number, number, number]>(
      `INSERT INTO note_debt (
         turn_id, session_id, prompt_number, status,
         opened_at_epoch, updated_at_epoch
       ) VALUES (?, ?, ?, 'noted', 1000, 1000)`,
    ).run(turnId, sessionDbId, promptNumber);
  }
  db.query<unknown, [number, number]>(
    `INSERT INTO note_debt_cursor (
       session_id, last_classified_prompt_number, updated_at_epoch
     ) VALUES (?, ?, 1000)`,
  ).run(sessionDbId, turns);

  return sessionDbId;
}

describe("a stale build claims no settlement work", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("a foreign build stamping the database mid-life stops every claim, and restoring our own stamp resumes them", async () => {
    // +1: the current max turn is never itself ended (spec D10), so a 51st turn
    // is what makes the 50-turn window settleable.
    const sessionDbId = seedDecidedSession(
      db,
      "content-stale-live-stamp",
      NOTE_SETTLEMENT_WINDOW_CAP_TURNS + 1,
    );
    const dispatched: NoteSettlementJob[] = [];
    // No seam: the core asks the database, exactly as the shipped wiring does.
    const core = createWorkerCore({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      // The stub stage 1, NAMED (final review, re-ruling 10): the scheduler's
      // own default is a deterministic failure, so a harness whose subject is
      // something else says which stage 1 it is standing in for.
      noteSettlementStage1DispatchImpl: createTransitionOnlyStageOneDispatch(db, () =>
        Math.floor(Date.now() / 1000),
      ),
      noteSettlementDispatchImpl: async ({ job }) => {
        dispatched.push(job);
        return { ok: true };
      },
    });

    // The plugin update lands: a hook process on the new release migrates this
    // database out from under the worker that is already running.
    recordInitializerBuild(db, FOREIGN_BUILD, Math.floor(Date.now() / 1000));

    await core.handleTurnStop(sessionDbId);

    // The window is still RECORDED — it is real, and a later trigger must not
    // recut it — but nothing was claimed, so no attempt was spent and no lease
    // was taken.
    expect(dispatched).toHaveLength(0);
    const parked = listNoteSettlementJobs(db, sessionDbId);
    expect(parked).toHaveLength(1);
    expect(parked[0]!.status).toBe("pending");
    expect(parked[0]!.attempts).toBe(0);
    expect(parked[0]!.claimedAtEpoch).toBeNull();

    // The control that makes the zeros above about STALENESS rather than about
    // an unsettleable fixture: the same parked job, the same core — with this
    // database's initializer back to our own id. Compact is retired as a
    // trigger outright now (ticket 04), so a SECOND, unrelated session's
    // below-threshold turn-stop is used instead — its own leak (which excludes
    // only ITS OWN session id) is what reaches the first session's parked job.
    recordInitializerBuild(db, BUILD_ID, Math.floor(Date.now() / 1000));
    const otherSessionDbId = seedDecidedSession(
      db,
      "content-stale-resume-other",
      3,
    );

    await core.handleTurnStop(otherSessionDbId);

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.sessionId).toBe(sessionDbId);
    expect(listNoteSettlementJobs(db, sessionDbId)[0]!.status).toBe("done");
  });

  test("the stale latch also blocks the cross-session leak", async () => {
    // Below the threshold, so this session triggers no window of its own — the
    // only thing that could be claimed here is the OTHER session's recorded job,
    // which is what the leak exists to pick up. Compact and finish are not
    // exercised here: neither carries any settlement wiring any more (ticket
    // 04), so the leak's only remaining entry point is turn-stop.
    const busySessionDbId = seedDecidedSession(db, "content-stale-leak-busy", 3);
    const otherSessionDbId = upsertSession(db, {
      contentSessionId: "content-stale-leak-other",
      project: "/tmp/project-stale-build",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    enqueueNoteSettlementWindows(
      db,
      [
        {
          sessionId: otherSessionDbId,
          windowStart: 1,
          windowEnd: 7,
          triggerType: "sessionend",
        },
      ],
      1_000,
      SETTLEMENT_ERA_CUTOFF_EPOCH,
    );
    const dispatched: NoteSettlementJob[] = [];
    let stale = true;
    const core = createWorkerCore({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      isStaleBuildImpl: () => stale,
      // The stub stage 1, NAMED (final review, re-ruling 10): the scheduler's
      // own default is a deterministic failure, so a harness whose subject is
      // something else says which stage 1 it is standing in for.
      noteSettlementStage1DispatchImpl: createTransitionOnlyStageOneDispatch(db, () =>
        Math.floor(Date.now() / 1000),
      ),
      noteSettlementDispatchImpl: async ({ job }) => {
        dispatched.push(job);
        return { ok: true };
      },
    });

    await core.handleTurnStop(busySessionDbId);

    expect(dispatched).toHaveLength(0);
    const leaked = listNoteSettlementJobs(db, otherSessionDbId);
    expect(leaked).toHaveLength(1);
    expect(leaked[0]!.status).toBe("pending");
    expect(leaked[0]!.attempts).toBe(0);

    // Same control: with the build no longer stale, the very same leak claims
    // the very same job.
    stale = false;
    await core.handleTurnStop(busySessionDbId);

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.sessionId).toBe(otherSessionDbId);
  });
});

type WorkerState = ReturnType<typeof createWorkerServerState>;

interface ExitHarness {
  state: WorkerState;
  deps: WorkerServerDeps;
  record: { shutdowns: number; exits: number[]; aborts: number };
}

function createExitHarness(
  overrides: Partial<WorkerServerDeps> = {},
): ExitHarness {
  const record = { shutdowns: 0, exits: [] as number[], aborts: 0 };
  const state = createWorkerServerState(1_000);
  const deps: WorkerServerDeps = {
    isStaleBuildImpl: () => true,
    shutdownGracefullyImpl: async () => {
      record.shutdowns += 1;
    },
    pidPath: "/tmp/claude-mnemo-stale-build-test.pid",
    unlinkSyncImpl: (() => undefined) as typeof unlinkSync,
    processImpl: {
      pid: 12345,
      on: (() => undefined) as NodeJS.Process["on"],
      exit: ((code?: number) => {
        record.exits.push(code ?? 0);
        return undefined as never;
      }) as NodeJS.Process["exit"],
    },
    ...overrides,
  };
  return { state, deps, record };
}

describe("checkForStaleBuildShutdown", () => {
  test("exits while a content session is still live", async () => {
    const { state, deps, record } = createExitHarness();

    expect(await checkForStaleBuildShutdown(state, deps)).toBe(true);
    expect(record.shutdowns).toBe(1);
    expect(record.exits).toEqual([0]);
    expect(state.shuttingDown).toBe(true);
  });

  test("a build that is not stale never exits", async () => {
    const fresh = createExitHarness({ isStaleBuildImpl: () => false });
    expect(await checkForStaleBuildShutdown(fresh.state, fresh.deps)).toBe(
      false,
    );
    expect(fresh.record.shutdowns).toBe(0);
    expect(fresh.state.shuttingDown).toBe(false);

    // And with no seam wired at all — every OTHER caller of these lifecycle
    // deps — the answer is the same.
    const unwired = createExitHarness({ isStaleBuildImpl: undefined });
    expect(await checkForStaleBuildShutdown(unwired.state, unwired.deps)).toBe(
      false,
    );
    expect(unwired.record.exits).toEqual([]);
  });

  test("an in-flight HTTP request holds the exit off", async () => {
    const { state, deps, record } = createExitHarness();
    state.activeRequests = 1;

    expect(await checkForStaleBuildShutdown(state, deps)).toBe(false);
    expect(record.shutdowns).toBe(0);
    expect(state.shuttingDown).toBe(false);
  });

  test("a global scan in flight holds the exit off, from either side", async () => {
    const serverSide = createExitHarness();
    serverSide.state.globalScanInFlight = new Promise<void>(() => {});
    expect(
      await checkForStaleBuildShutdown(serverSide.state, serverSide.deps),
    ).toBe(false);
    expect(serverSide.record.shutdowns).toBe(0);

    const coreSide = createExitHarness({
      getGlobalScanInFlightImpl: () => new Promise<void>(() => {}),
    });
    expect(await checkForStaleBuildShutdown(coreSide.state, coreSide.deps)).toBe(
      false,
    );
    expect(coreSide.record.shutdowns).toBe(0);
  });

  test("a running dream is aborted, and then the worker exits", async () => {
    let dreamRunning = true;
    const harness = createExitHarness({
      isDreamRunningImpl: () => dreamRunning,
    });
    harness.deps.abortDreamImpl = async () => {
      harness.record.aborts += 1;
      dreamRunning = false;
    };

    expect(await checkForStaleBuildShutdown(harness.state, harness.deps)).toBe(
      true,
    );
    expect(harness.record.aborts).toBe(1);
    expect(harness.record.shutdowns).toBe(1);
    expect(harness.record.exits).toEqual([0]);
  });

  test("a running dream with no abort seam blocks the exit instead of wedging on it", async () => {
    // Nothing can make this drain settle: the dream exemption skips the hard
    // scan guard, and with no abort there is nothing to end the query the drain
    // is waiting on. Refusing up front is what keeps the watchdog able to ask
    // again — proceeding would park this call, and the `shuttingDown` flag it
    // set, on a promise that never resolves.
    const { state, deps, record } = createExitHarness({
      isDreamRunningImpl: () => true,
    });
    state.globalScanInFlight = new Promise<void>(() => {});

    const outcome = await Promise.race([
      checkForStaleBuildShutdown(state, deps),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("wedged on the un-abortable dream"), 50),
      ),
    ]);

    expect(outcome).toBe(false);
    expect(record.shutdowns).toBe(0);
    expect(state.shuttingDown).toBe(false);
  });

  test("work that arrives while the dream unwinds cancels the exit", async () => {
    let dreamRunning = true;
    const harness = createExitHarness({
      isDreamRunningImpl: () => dreamRunning,
    });
    harness.deps.abortDreamImpl = async () => {
      harness.record.aborts += 1;
      dreamRunning = false;
      // A hook event landed while the dream was being torn down.
      harness.state.globalScanInFlight = new Promise<void>(() => {});
    };

    expect(await checkForStaleBuildShutdown(harness.state, harness.deps)).toBe(
      false,
    );
    expect(harness.record.aborts).toBe(1);
    expect(harness.record.shutdowns).toBe(0);
    // Released, so the next watchdog beat re-asks rather than finding a worker
    // wedged half-way out the door.
    expect(harness.state.shuttingDown).toBe(false);
  });

  test("a shutdown already under way is not started a second time", async () => {
    const { state, deps, record } = createExitHarness();
    state.shuttingDown = true;

    expect(await checkForStaleBuildShutdown(state, deps)).toBe(false);
    expect(record.shutdowns).toBe(0);
  });
});
