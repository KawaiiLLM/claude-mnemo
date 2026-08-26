import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { enqueueQueueItem } from "../../src/db/pending-queue";
import {
  createHardExitTimer,
  countPendingTurnStops,
} from "../../src/worker/server";
import { DEFAULT_CONFIG } from "../../src/shared/config";
import type { CapturedSessionEnv } from "../../src/mnemosyne/env";

/**
 * `createHardExitTimer` driven through injected `setTimeoutImpl`/
 * `clearTimeoutImpl` and a real in-memory db, so the timer's own logic (not a
 * stub standing in for it) is what is under test. This is the regression
 * suite for the production incident where 4 `turn-stop` rows were enqueued
 * during the 70s hard-exit window and stranded when the worker exited anyway.
 */

const HARD_EXIT_MS = DEFAULT_CONFIG.hardExitTimeoutMs;

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

  // Fires the most recently scheduled, still-live entry at this delay — the
  // shape a real re-arm produces (a fresh entry alongside any stale one).
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

// Spins on microtasks (no real timers, no arbitrary sleep) until `predicate`
// becomes true, for asserting on the tail of a fire-and-forgot
// `createHardExitCleanup(deps)` chain.
async function waitFor(predicate: () => boolean, maxTicks = 200): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  if (!predicate()) {
    throw new Error("waitFor: predicate never became true");
  }
}

function makeDb(): Database {
  const db = createDatabase(":memory:");
  initializeSchema(db);
  return db;
}

function enqueueTurnStops(db: Database, count: number): void {
  for (let i = 0; i < count; i++) {
    enqueueQueueItem(db, {
      kind: "turn-stop",
      targetId: i + 1,
      sessionDbId: 1,
      enqueuedAtEpoch: 1_000,
    });
  }
}

interface Harness {
  db: Database;
  timers: ReturnType<typeof createFakeTimers>;
  sessionEnvRegistry: Map<string, CapturedSessionEnv>;
  exitCalls: number;
  gracefulExitCalls: number;
  warnMessages: string[];
  errorMessages: string[];
  timer: ReturnType<typeof createHardExitTimer>;
}

function makeHarness(opts: {
  db?: Database;
  sessionEnvRegistry?: Map<string, CapturedSessionEnv>;
  shutdownGracefullyImpl?: () => Promise<void>;
} = {}): Harness {
  const db = opts.db ?? makeDb();
  const timers = createFakeTimers();
  const sessionEnvRegistry =
    opts.sessionEnvRegistry ?? new Map<string, CapturedSessionEnv>();
  const warnMessages: string[] = [];
  const errorMessages: string[] = [];
  const harness = {
    db,
    timers,
    sessionEnvRegistry,
    exitCalls: 0,
    gracefulExitCalls: 0,
    warnMessages,
    errorMessages,
  } as Harness;

  const deps = {
    db,
    config: DEFAULT_CONFIG,
    sessionEnvRegistry,
    beginGracefulExitImpl: () => {
      harness.gracefulExitCalls += 1;
    },
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    logger: {
      warn: (message: string) => warnMessages.push(message),
      error: (message: string) => errorMessages.push(message),
    },
    shutdownGracefullyImpl: opts.shutdownGracefullyImpl,
    processImpl: {
      pid: 999,
      on: () => {},
      exit: () => {
        harness.exitCalls += 1;
      },
    },
    unlinkSyncImpl: () => {},
    pidPath: "/tmp/mnemo-hard-exit-test.pid",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  harness.timer = createHardExitTimer(deps);
  return harness;
}

describe("countPendingTurnStops", () => {
  test("counts only kind='turn-stop' rows", () => {
    const db = makeDb();
    enqueueTurnStops(db, 2);
    enqueueQueueItem(db, {
      kind: "obs",
      targetId: 99,
      sessionDbId: 1,
      enqueuedAtEpoch: 1_000,
    });
    expect(countPendingTurnStops(db)).toBe(2);
    db.close();
  });
});

describe("createHardExitTimer — fire-time re-check (ticket 1)", () => {
  test("backlog 0 at arm and still 0 at fire -> exits", async () => {
    const h = makeHarness();
    h.timer.arm();
    expect(h.timers.countScheduled(HARD_EXIT_MS)).toBe(1);

    await h.timers.fireLatest(HARD_EXIT_MS);
    await waitFor(() => h.exitCalls === 1);

    expect(h.gracefulExitCalls).toBe(1);
    expect(h.exitCalls).toBe(1);
    h.db.close();
  });

  test("backlog 0 at arm but non-zero at fire -> does not exit, and a new timer is scheduled (production incident regression)", async () => {
    const h = makeHarness();
    h.timer.arm(); // backlog 0 at arm time
    expect(h.timers.countScheduled(HARD_EXIT_MS)).toBe(1);

    // The 4 turn-stop rows enqueued during the 70s window in the incident.
    enqueueTurnStops(h.db, 4);

    await h.timers.fireLatest(HARD_EXIT_MS);

    expect(h.gracefulExitCalls).toBe(0);
    expect(h.exitCalls).toBe(0);
    // The re-arm actually scheduled a new timer — proves the `pending`
    // early-return was not silently defeated.
    expect(h.timers.countScheduled(HARD_EXIT_MS)).toBe(1);
    expect(
      h.warnMessages.some((m) => m.includes("deferred")),
    ).toBe(true);
    h.db.close();
  });

  test("backlog drains between the first fire and the second -> the second fire exits", async () => {
    const h = makeHarness();
    h.timer.arm();
    enqueueTurnStops(h.db, 2);

    await h.timers.fireLatest(HARD_EXIT_MS); // 1st fire: backlog=2, reschedules
    expect(h.gracefulExitCalls).toBe(0);
    expect(h.exitCalls).toBe(0);
    expect(h.timers.countScheduled(HARD_EXIT_MS)).toBe(1);

    h.db.query("DELETE FROM pending_queue WHERE kind = 'turn-stop'").run();

    await h.timers.fireLatest(HARD_EXIT_MS); // 2nd fire: backlog=0, exits
    await waitFor(() => h.exitCalls === 1);

    expect(h.gracefulExitCalls).toBe(1);
    expect(h.exitCalls).toBe(1);
    h.db.close();
  });

  test("sessionEnvRegistry becoming non-empty before fire still short-circuits, unchanged", async () => {
    const sessionEnvRegistry = new Map<string, CapturedSessionEnv>();
    const h = makeHarness({ sessionEnvRegistry });
    h.timer.arm(); // registry empty at arm time

    // Backlog stays 0 here on purpose: if the sessionEnvRegistry check were
    // deleted, a 0 backlog would fall straight through to exit, so this
    // fixture makes the session check — and only the session check — the
    // reason nothing happens (a non-zero backlog would make this an inert
    // mutation, since the backlog re-check would ALSO bail).
    sessionEnvRegistry.set("late-session", {} as CapturedSessionEnv);

    await h.timers.fireLatest(HARD_EXIT_MS);

    expect(h.gracefulExitCalls).toBe(0);
    expect(h.exitCalls).toBe(0);
    // This branch returns outright — it must not also reschedule.
    expect(h.timers.countScheduled(HARD_EXIT_MS)).toBe(0);
    h.db.close();
  });
});
