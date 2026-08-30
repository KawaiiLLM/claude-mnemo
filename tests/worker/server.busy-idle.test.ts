import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  acquireBusyToken,
  checkForWorkerIdleShutdown,
  createWorkerServerState,
  HARD_EXIT_SHUTDOWN_GRACE_MS,
  type WorkerServerDeps,
} from "../../src/worker/server";
import { DEFAULT_CONFIG } from "../../src/shared/config";

/**
 * The worker's one idleness clock (staged-settlement spec Rev 5,
 * "Implementation" / "One idleness clock" — USER RULING S15069/T2083;
 * ticket 08). `busy` = any active HTTP request OR any tracked
 * drain/settlement/dream work genuinely live; a busy worker never exits,
 * however long the work runs. When the LAST busy token releases,
 * `idleSince` is stamped; a full quiet HOUR from that moment triggers a
 * BOUNDED shutdown (the old hard-exit path's own grace-then-forced-exit
 * shape). This suite is the regression pin for the two RETIRED paths this
 * ticket folds in: the 70-second "all registered sessions closed" hard-exit
 * (`createHardExitTimer`, deleted with this ticket) and the separate
 * 30-minute idle-HTTP-only shutdown (`checkForIdleWorkerShutdown`, deleted
 * with this ticket) — a worker that would have exited under either old rule
 * must NOT exit under the new one while genuinely busy.
 */

const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = DEFAULT_CONFIG.workerIdleShutdownMs;

interface FakeTimerEntry {
  id: number;
  callback: () => void | Promise<void>;
  delayMs: number;
  cleared: boolean;
  fired: boolean;
}

function createFakeTimers() {
  let nextId = 1;
  const entries: FakeTimerEntry[] = [];

  const setTimeoutImpl = (
    callback: () => void | Promise<void>,
    delayMs: number,
  ): unknown => {
    const id = nextId++;
    entries.push({ id, callback, delayMs, cleared: false, fired: false });
    return id;
  };

  const clearTimeoutImpl = (handle: unknown): void => {
    const entry = entries.find((e) => e.id === handle);
    if (entry) {
      entry.cleared = true;
    }
  };

  async function fireLatest(delayMs: number): Promise<void> {
    const candidates = entries.filter(
      (e) => e.delayMs === delayMs && !e.cleared && !e.fired,
    );
    const entry = candidates[candidates.length - 1];
    if (!entry) {
      throw new Error(`no live timer scheduled with delayMs=${delayMs}`);
    }
    entry.fired = true;
    await entry.callback();
  }

  function countScheduled(delayMs: number): number {
    return entries.filter(
      (e) => e.delayMs === delayMs && !e.cleared && !e.fired,
    ).length;
  }

  return { setTimeoutImpl, clearTimeoutImpl, fireLatest, countScheduled };
}

interface ShutdownHarness {
  clockMs: number;
  timers: ReturnType<typeof createFakeTimers>;
  exitCalls: number;
  warnMessages: string[];
  errorMessages: string[];
  gracefulExitCalls: number;
  deps: WorkerServerDeps;
}

function makeShutdownHarness(opts: {
  startMs?: number;
  shutdownGracefullyImpl?: () => Promise<void>;
} = {}): ShutdownHarness {
  const timers = createFakeTimers();
  const warnMessages: string[] = [];
  const errorMessages: string[] = [];
  const harness = {
    clockMs: opts.startMs ?? 0,
    timers,
    exitCalls: 0,
    warnMessages,
    errorMessages,
    gracefulExitCalls: 0,
  } as ShutdownHarness;

  harness.deps = {
    config: DEFAULT_CONFIG,
    nowMs: () => harness.clockMs,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    logger: {
      warn: (message: string) => warnMessages.push(message),
      error: (message: string) => errorMessages.push(message),
    },
    shutdownGracefullyImpl: opts.shutdownGracefullyImpl ?? (async () => {}),
    beginGracefulExitImpl: () => {
      harness.gracefulExitCalls += 1;
    },
    processImpl: {
      pid: 999,
      on: () => {},
      exit: () => {
        harness.exitCalls += 1;
      },
    } as unknown as WorkerServerDeps["processImpl"],
    unlinkSyncImpl: () => {},
    pidPath: "/tmp/mnemo-busy-idle-test.pid",
  };

  return harness;
}

describe("acquireBusyToken — pairing (acceptance item 1)", () => {
  test("start/end pair exactly once; a released token's second release() does not affect a still-active sibling", () => {
    const state = createWorkerServerState(1_000);
    let clockMs = 1_000;

    const tokenA = acquireBusyToken(state, () => clockMs);
    expect(state.busyCount).toBe(1);
    expect(state.idleSince).toBeNull();

    const tokenB = acquireBusyToken(state, () => clockMs);
    expect(state.busyCount).toBe(2);
    expect(state.idleSince).toBeNull();

    // The abort verdict releases tokenA while tokenB (unrelated concurrent
    // work) is still live.
    clockMs = 5_000;
    tokenA.release();
    expect(state.busyCount).toBe(1);
    expect(state.idleSince).toBeNull();

    // A double release — e.g. the wedged call underneath tokenA eventually
    // settling on its own and trying to release the same token again. A
    // naive `busyCount -= 1` without the idempotency guard would wrongly
    // drop this to 0 here and stamp `idleSince` at 5_000 even though tokenB
    // is still outstanding.
    tokenA.release();
    expect(state.busyCount).toBe(1);
    expect(state.idleSince).toBeNull();

    // The TRUE last release.
    clockMs = 9_000;
    tokenB.release();
    expect(state.busyCount).toBe(0);
    expect(state.idleSince).toBe(9_000);
  });

  test("acquiring a new token clears idleSince, whatever it was", () => {
    const state = createWorkerServerState(1_000);
    state.idleSince = 500;

    const token = acquireBusyToken(state, () => 2_000);
    expect(state.idleSince).toBeNull();

    token.release();
    expect(state.idleSince).toBe(2_000);
  });
});

describe("checkForWorkerIdleShutdown — the one-hour idleness clock", () => {
  test("a 70-minute live drain does not exit at any point; idleSince starts only at its end; +59min no exit, +60min exits gracefully", async () => {
    const harness = makeShutdownHarness({ startMs: 0 });
    const state = createWorkerServerState(harness.clockMs);
    const token = acquireBusyToken(state, () => harness.clockMs);

    // Sampled across the 70-minute drain: idleSince stays null throughout,
    // so the check refuses outright at every point sampled — no threshold
    // arithmetic even runs while genuinely busy.
    for (const sampleMs of [0, 35 * ONE_MINUTE_MS, 70 * ONE_MINUTE_MS - 1]) {
      harness.clockMs = sampleMs;
      expect(state.idleSince).toBeNull();
      expect(await checkForWorkerIdleShutdown(state, harness.deps)).toBe(
        false,
      );
    }

    // The drain ends at minute 70 — idleSince starts HERE, not at the
    // drain's start.
    harness.clockMs = 70 * ONE_MINUTE_MS;
    token.release();
    expect(state.idleSince).toBe(70 * ONE_MINUTE_MS);

    // +59 idle minutes: still short of the hour.
    harness.clockMs = 70 * ONE_MINUTE_MS + 59 * ONE_MINUTE_MS;
    expect(await checkForWorkerIdleShutdown(state, harness.deps)).toBe(false);
    expect(harness.exitCalls).toBe(0);

    // +60 idle minutes: the hour lands, and the shutdown is graceful —
    // shutdownGracefully resolves well inside the grace window, so the
    // forced-exit fallback never has to fire.
    harness.clockMs = 70 * ONE_MINUTE_MS + ONE_HOUR_MS;
    expect(await checkForWorkerIdleShutdown(state, harness.deps)).toBe(true);
    expect(harness.exitCalls).toBe(1);
    expect(harness.gracefulExitCalls).toBe(1);
    expect(harness.warnMessages.some((m) => m.includes("grace"))).toBe(
      false,
    );
  });

  test("a query that received its abort but never settles releases its busy token at the abort verdict; the hour later exhausts the bounded shutdown's grace and forces the exit anyway (pinned)", async () => {
    const harness = makeShutdownHarness({
      startMs: 0,
      // Simulates the shutdown-time cleanup being unable to make progress —
      // whatever it is waiting on (the same wedged call the abort verdict
      // already gave up on) never resolves.
      shutdownGracefullyImpl: () => new Promise<void>(() => {}),
    });
    const state = createWorkerServerState(harness.clockMs);

    // The query's own promise never settles — deliberately never awaited,
    // never wired to anything. It is not what drives the busy/idle clock;
    // only the token is.
    const wedgedQuery = new Promise<void>(() => {});
    void wedgedQuery;
    const token = acquireBusyToken(state, () => harness.clockMs);

    // The claim monitor's abort verdict lands: release the busy token right
    // there, independent of the wedged promise.
    token.release();
    expect(state.idleSince).toBe(0);
    expect(state.busyCount).toBe(0);

    harness.clockMs = ONE_HOUR_MS;
    const resultPromise = checkForWorkerIdleShutdown(state, harness.deps);

    // The grace timer was scheduled synchronously inside the promise
    // construction createHardExitCleanup performs before its own first
    // await — it is already live by the time this line runs.
    expect(harness.timers.countScheduled(HARD_EXIT_SHUTDOWN_GRACE_MS)).toBe(
      1,
    );
    expect(harness.exitCalls).toBe(0);

    await harness.timers.fireLatest(HARD_EXIT_SHUTDOWN_GRACE_MS);
    expect(await resultPromise).toBe(true);

    expect(harness.exitCalls).toBe(1);
    expect(harness.warnMessages.some((m) => m.includes("grace"))).toBe(true);
  });

  test("a freshly spawned worker with no registered sessions and no jobs survives well past the old 70-second hard-exit horizon (retired path pinned dead)", async () => {
    const harness = makeShutdownHarness({ startMs: 0 });
    const state = createWorkerServerState(harness.clockMs);

    // 5 minutes of total silence — comfortably past the old 70-second
    // hard-exit, comfortably short of the new one-hour clock.
    harness.clockMs = 5 * ONE_MINUTE_MS;
    expect(await checkForWorkerIdleShutdown(state, harness.deps)).toBe(false);
    expect(harness.exitCalls).toBe(0);
  });

  test("a live drain at minute 40 of HTTP silence does not exit (the retired 30-minute idle-HTTP path pinned dead)", async () => {
    const harness = makeShutdownHarness({ startMs: 0 });
    const state = createWorkerServerState(harness.clockMs);
    // Genuinely live work, no HTTP request in the picture at all — exactly
    // what the retired 30-minute idle-HTTP-only path could not see.
    acquireBusyToken(state, () => harness.clockMs);

    harness.clockMs = 40 * ONE_MINUTE_MS;
    expect(await checkForWorkerIdleShutdown(state, harness.deps)).toBe(false);
    expect(harness.exitCalls).toBe(0);
  });

  test("an in-flight HTTP request holds the exit off even once otherwise idle", async () => {
    const harness = makeShutdownHarness({ startMs: 0 });
    const state = createWorkerServerState(harness.clockMs);
    state.activeRequests = 1;

    harness.clockMs = ONE_HOUR_MS;
    expect(await checkForWorkerIdleShutdown(state, harness.deps)).toBe(false);
    expect(harness.exitCalls).toBe(0);
  });

  test("a global scan in flight (either side) holds the exit off, even once otherwise idle", async () => {
    const serverSide = makeShutdownHarness({ startMs: 0 });
    const serverState = createWorkerServerState(serverSide.clockMs);
    serverState.globalScanInFlight = new Promise<void>(() => {});
    serverSide.clockMs = ONE_HOUR_MS;
    expect(
      await checkForWorkerIdleShutdown(serverState, serverSide.deps),
    ).toBe(false);
    expect(serverSide.exitCalls).toBe(0);

    const coreSide = makeShutdownHarness({ startMs: 0 });
    const coreState = createWorkerServerState(coreSide.clockMs);
    coreSide.deps.getGlobalScanInFlightImpl = () => new Promise<void>(() => {});
    coreSide.clockMs = ONE_HOUR_MS;
    expect(await checkForWorkerIdleShutdown(coreState, coreSide.deps)).toBe(
      false,
    );
    expect(coreSide.exitCalls).toBe(0);
  });

  test("a shutdown already under way is not started a second time", async () => {
    const harness = makeShutdownHarness({ startMs: ONE_HOUR_MS });
    const state = createWorkerServerState(0);
    state.shuttingDown = true;

    expect(await checkForWorkerIdleShutdown(state, harness.deps)).toBe(
      false,
    );
    expect(harness.exitCalls).toBe(0);
  });
});

describe("ticket 10 (ticket 07's adjudication) — the topics dispatch's acquireBusyToken option is threaded at its real construction site", () => {
  /**
   * `tests/worker/note-settlement-call.test.ts`'s own ticket-10 test proves
   * the BEHAVIOR: `acquireBusyToken` + `createWorkerServerState`, composed
   * exactly the way this file's construction site composes them, satisfy the
   * full hold/release contract against a real `WorkerServerState`. What that
   * test cannot see is whether THIS SPECIFIC construction call — inline
   * inside `main`, with no injectable seam of its own — still passes the
   * option at all; a regression here is silent (`options.acquireBusyToken?.()
   * ?? null` degrades to exactly ticket 07's own documented gap, no error,
   * no type failure). `mock.module` would be the usual way to observe a
   * construction site from outside, but replacing
   * `note-settlement-dispatch.ts` reproducibly hangs `main()`'s own startup,
   * and — separately — bun's `mock.module` is not reliably undone once
   * registered (it leaks into every other test file `bun test` runs in the
   * same process). A source-text pin is the safe alternative: it fails the
   * instant the option is dropped, renamed, or the primitive it calls
   * diverges, exactly the shape of regression this ticket closes.
   */
  test("main's real construction of createUnifiedNoteSettlementDispatch passes acquireBusyToken, built from the exported acquireBusyToken primitive", () => {
    const source = readFileSync(
      resolve(import.meta.dir, "../../src/worker/server.ts"),
      "utf8",
    );
    const constructionSite = source.slice(
      source.indexOf("createUnifiedNoteSettlementDispatch({"),
      source.indexOf("createUnifiedNoteSettlementDispatch({") + 1200,
    );
    expect(constructionSite).toContain("runQuery: createUnifiedNoteSettlementSdkQuery(");
    expect(constructionSite).toMatch(
      /acquireBusyToken:\s*\(\)\s*=>\s*acquireBusyToken\(serverState,\s*deps\.nowMs\s*\?\?\s*Date\.now\)/,
    );
  });
});
