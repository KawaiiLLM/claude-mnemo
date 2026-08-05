import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { getSession, updateLastAgentSessionId, upsertSession } from "../../src/db/sessions";
import { createWorkerCore } from "../../src/worker/server";
import type { SessionState } from "../../src/worker/server";
import type { WorkerQuerySession } from "../../src/worker/query-session";
import type { CapturedSessionEnv } from "../../src/shared/session-env";

// A compact that never lands must not leave the oversized session in service:
// every later work unit re-reads its whole prefix, and the next compact is
// slower still, so without recovery the failure is permanent.
const COMPACT_TIMEOUT_ERROR = () =>
  new Error("Worker query session compact timed out after 300000ms.");

function seedSession(db: Database, contentSessionId: string): number {
  const id = upsertSession(db, {
    contentSessionId,
    project: "/tmp/project-compact-recovery",
    title: null,
    content: null,
    insight: null,
    createdAtEpoch: 1,
    updatedAtEpoch: 1,
    completedAtEpoch: null,
  }).id;
  // A resumable agent transcript already exists — this is the bloated one.
  updateLastAgentSessionId(db, id, "bloated-agent-session");
  return id;
}

function primeLiveSession(
  core: ReturnType<typeof createWorkerCore>,
  sessionDbId: number,
  contentSessionId: string,
  querySession: WorkerQuerySession,
): void {
  core.sessions.set(sessionDbId, {
    sessionDbId,
    querySession,
    agentSessionId: "bloated-agent-session",
    contentSessionId,
    project: "/tmp/project-compact-recovery",
    batchQueue: [],
    streamedParts: new Map<number, number>(),
    cacheTtlMs: 300_000,
    nextBatchNeedsSessionContext: false,
    lastInjectedSummaryEpoch: 0,
    lastPushAt: 1_000,
    lastMessageAt: 0,
    lastActivity: 0,
    lastAgentActivityAt: 0,
    requestInFlight: false,
    processingLock: Promise.resolve(),
    pushMessage: async () => {},
    unitSignals: {
      rememberedIds: new Set<number>(),
      rememberedSessionIds: new Set<number>(),
      hadSubstantiveText: false,
      hadIllegalTool: false,
      retryableError: null,
      assistantText: [] as string[],
    },
  } as unknown as SessionState);
}

describe("compact failure recovery", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("a compact that never lands abandons the oversized agent session", async () => {
    const contentSessionId = "worker-session-compact-timeout";
    const sessionDbId = seedSession(db, contentSessionId);

    const resumeTargets: Array<string | null | undefined> = [];
    let created = 0;
    let closed = 0;

    const core = createWorkerCore({
      db,
      processBatchImpl: async () => {},
      pushSessionSummaryPromptImpl: async () => {},
      closeSessionQueryImpl: async () => {},
      // The agent context is far past the compact gate.
      readAgentContextTokensImpl: () => 470_000,
      createWorkerQuerySessionImpl: ((input: {
        resumeAgentSessionId?: string | null;
      }) => {
        created += 1;
        resumeTargets.push(input.resumeAgentSessionId);
        return {
          sessionId: `worker-query-${created}`,
          queryPid: 1234,
          async sendPrompt(_prompt: string) {
            return { session_id: `worker-query-${created}` };
          },
          async compact() {},
          async close() {},
        } satisfies WorkerQuerySession;
      }) as unknown as typeof import("../../src/worker/query-session").createWorkerQuerySession,
      isProcessAliveImpl: () => false,
    });

    primeLiveSession(core, sessionDbId, contentSessionId, {
      sessionId: "worker-query-0",
      queryPid: 1234,
      sendPrompt: async () => ({ session_id: "worker-query-0" }),
      compact: async () => {
        throw COMPACT_TIMEOUT_ERROR();
      },
      close: async () => {
        closed += 1;
      },
    } satisfies WorkerQuerySession);

    await core.handleCompact(sessionDbId, null);

    const after = core.sessions.get(sessionDbId)!;
    // The bloated runtime is gone, and nothing was spawned to replace it yet.
    expect(closed).toBe(1);
    expect(after.querySession).toBeNull();
    expect(created).toBe(0);
    expect(after.agentSessionId).toBeUndefined();
    // Only when work actually arrives do we open one — and it must not resume.
    expect(after.forceFreshNextQuery).toBe(true);

    core.ensureQuerySession(after);
    expect(created).toBe(1);
    expect(resumeTargets[0]).toBeNull();
    expect(after.forceFreshNextQuery).toBe(false);
  });

  test("a successful compact keeps the agent session in service", async () => {
    const contentSessionId = "worker-session-compact-ok";
    const sessionDbId = seedSession(db, contentSessionId);

    let closed = 0;
    const core = createWorkerCore({
      db,
      processBatchImpl: async () => {},
      pushSessionSummaryPromptImpl: async () => {},
      closeSessionQueryImpl: async () => {},
      readAgentContextTokensImpl: () => 470_000,
      isProcessAliveImpl: () => false,
    });

    primeLiveSession(core, sessionDbId, contentSessionId, {
      sessionId: "worker-query-0",
      queryPid: 1234,
      sendPrompt: async () => ({ session_id: "worker-query-0" }),
      compact: async () => {},
      close: async () => {
        closed += 1;
      },
    } satisfies WorkerQuerySession);

    await core.handleCompact(sessionDbId, null);

    const after = core.sessions.get(sessionDbId)!;
    expect(closed).toBe(0);
    expect(after.querySession).not.toBeNull();
    expect(after.forceFreshNextQuery).toBeFalsy();
  });

  test("a runtime that fails to open keeps the do-not-resume mark", async () => {
    const contentSessionId = "worker-session-compact-open-fails";
    const sessionDbId = seedSession(db, contentSessionId);

    const resumeTargets: Array<string | null | undefined> = [];
    let attempts = 0;

    const core = createWorkerCore({
      db,
      processBatchImpl: async () => {},
      pushSessionSummaryPromptImpl: async () => {},
      closeSessionQueryImpl: async () => {},
      readAgentContextTokensImpl: () => 470_000,
      createWorkerQuerySessionImpl: ((input: {
        resumeAgentSessionId?: string | null;
      }) => {
        attempts += 1;
        resumeTargets.push(input.resumeAgentSessionId);
        // The agent process fails to spawn the first time.
        if (attempts === 1) {
          throw new Error("spawn failed");
        }
        return {
          sessionId: `worker-query-${attempts}`,
          queryPid: 1234,
          async sendPrompt(_prompt: string) {
            return { session_id: `worker-query-${attempts}` };
          },
          async compact() {},
          async close() {},
        } satisfies WorkerQuerySession;
      }) as unknown as typeof import("../../src/worker/query-session").createWorkerQuerySession,
      isProcessAliveImpl: () => false,
    });

    primeLiveSession(core, sessionDbId, contentSessionId, {
      sessionId: "worker-query-0",
      queryPid: 1234,
      sendPrompt: async () => ({ session_id: "worker-query-0" }),
      compact: async () => {
        throw COMPACT_TIMEOUT_ERROR();
      },
      close: async () => {},
    } satisfies WorkerQuerySession);

    await core.handleCompact(sessionDbId, null);
    const state = core.sessions.get(sessionDbId)!;
    expect(state.forceFreshNextQuery).toBe(true);

    expect(() => core.ensureQuerySession(state)).toThrow("spawn failed");
    // The mark must survive the failed attempt, or the retry silently resumes
    // the transcript we just abandoned.
    expect(state.forceFreshNextQuery).toBe(true);

    core.ensureQuerySession(state);
    expect(resumeTargets).toEqual([null, null]);
    expect(state.forceFreshNextQuery).toBe(false);
  });

  test("a message from an abandoned runtime cannot restore it as the resume target", async () => {
    const contentSessionId = "worker-session-compact-late-message";
    const sessionDbId = seedSession(db, contentSessionId);

    let capturedOnMessage: ((message: unknown) => void) | null = null;

    const core = createWorkerCore({
      db,
      processBatchImpl: async () => {},
      pushSessionSummaryPromptImpl: async () => {},
      closeSessionQueryImpl: async () => {},
      readAgentContextTokensImpl: () => 470_000,
      createWorkerQuerySessionImpl: ((
        _input: unknown,
        callbacks: { onMessage?: (message: unknown) => void },
      ) => {
        capturedOnMessage = callbacks.onMessage ?? null;
        return {
          sessionId: "worker-query-live",
          queryPid: 1234,
          async sendPrompt(_prompt: string) {
            return { session_id: "worker-query-live" };
          },
          async compact() {
            throw COMPACT_TIMEOUT_ERROR();
          },
          async close() {},
        } satisfies WorkerQuerySession;
      }) as unknown as typeof import("../../src/worker/query-session").createWorkerQuerySession,
      isProcessAliveImpl: () => false,
    });

    // Build the runtime through the real path so its callbacks close over the
    // live state, then abandon it via a compact that never lands.
    primeLiveSession(core, sessionDbId, contentSessionId, {
      sessionId: "worker-query-0",
      queryPid: 1234,
      sendPrompt: async () => ({ session_id: "worker-query-0" }),
      compact: async () => {
        throw COMPACT_TIMEOUT_ERROR();
      },
      close: async () => {},
    } satisfies WorkerQuerySession);
    const state = core.sessions.get(sessionDbId)!;
    state.querySession = null;
    core.ensureQuerySession(state);
    expect(capturedOnMessage).not.toBeNull();

    await core.handleCompact(sessionDbId, null);
    expect(core.sessions.get(sessionDbId)?.agentSessionId).toBeUndefined();

    // The dead runtime finally emits — it must change nothing.
    capturedOnMessage!({ type: "system", session_id: "abandoned-agent" });

    expect(core.sessions.get(sessionDbId)?.agentSessionId).toBeUndefined();
    expect(getSession(db, sessionDbId)?.lastAgentSessionId).not.toBe(
      "abandoned-agent",
    );
  });

  test("a compact is abandoned early once every content session has exited", async () => {
    const contentSessionId = "worker-session-compact-shutdown";
    const sessionDbId = seedSession(db, contentSessionId);

    // Empty registry = every content session has exited, so the worker is only
    // alive for this compact.
    const sessionEnvRegistry = new Map<string, CapturedSessionEnv>();

    let currentMs = 0;
    const timers: Array<{ at: number; fn: () => void | Promise<void> }> = [];
    let requestedBudgetMs: number | null = null;
    let closed = 0;
    let abandonedAtMs: number | null = null;

    const core = createWorkerCore({
      db,
      sessionEnvRegistry,
      processBatchImpl: async () => {},
      pushSessionSummaryPromptImpl: async () => {},
      closeSessionQueryImpl: async () => {},
      readAgentContextTokensImpl: () => 470_000,
      isProcessAliveImpl: () => false,
      nowMs: () => currentMs,
      setTimeoutImpl: ((fn: () => void | Promise<void>, delayMs: number) => {
        const handle = { at: currentMs + delayMs, fn };
        timers.push(handle);
        return handle;
      }) as unknown as undefined,
      clearTimeoutImpl: ((handle: unknown) => {
        const index = timers.indexOf(handle as (typeof timers)[number]);
        if (index >= 0) {
          timers.splice(index, 1);
        }
      }) as unknown as undefined,
    });

    primeLiveSession(core, sessionDbId, contentSessionId, {
      sessionId: "worker-query-0",
      queryPid: 1234,
      sendPrompt: async () => ({ session_id: "worker-query-0" }),
      // Never settles: the production symptom.
      compact: (budgetMs?: number) => {
        requestedBudgetMs = budgetMs ?? null;
        return new Promise<void>(() => {});
      },
      close: async () => {
        closed += 1;
        abandonedAtMs = currentMs;
      },
    } as unknown as WorkerQuerySession);

    let settled = false;
    const compacting = core.handleCompact(sessionDbId, null).then(() => {
      settled = true;
    });

    // Standard fake-clock drive: jump to the next scheduled timer, never past
    // it. With no timer pending the clock does not move at all, so the measured
    // abandonment time is the implementation's, not the driver's.
    for (let step = 0; step < 400 && !settled; step += 1) {
      const nextAt = timers.reduce(
        (min, timer) => Math.min(min, timer.at),
        Number.POSITIVE_INFINITY,
      );
      if (Number.isFinite(nextAt)) {
        currentMs = Math.max(currentMs, nextAt);
        for (const timer of timers.filter((t) => t.at <= currentMs)) {
          timers.splice(timers.indexOf(timer), 1);
          await timer.fn();
        }
      }
      await Promise.resolve();
    }

    await compacting;
    // Abandoned ON the shutdown budget — not merely somewhere short of 300s.
    expect(abandonedAtMs).toBeGreaterThanOrEqual(60_000);
    expect(abandonedAtMs).toBeLessThanOrEqual(61_000);

    // The runtime still gets the full budget — only our wait is shortened.
    expect(requestedBudgetMs).toBe(300_000);
    expect(closed).toBe(1);
    expect(core.sessions.get(sessionDbId)?.forceFreshNextQuery).toBe(true);
  });
});
