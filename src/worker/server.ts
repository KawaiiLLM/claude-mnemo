import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Database } from "bun:sqlite";

import { createDatabase } from "../db/database";
import { getSession } from "../db/sessions";
import { parseReplayTranscript } from "../shared/transcript-parser";
import {
  claimNextItem,
  countQueueItemsForSession,
  deleteQueueItem,
  releaseQueueClaim,
  resetClaimedQueueItems,
  type PendingQueueItem,
} from "../db/pending-queue";
import { initializeDatabase } from "../db/schema";
import { WORKER_PID_PATH, WORKER_STARTING_PATH } from "../shared/paths";
import { createWorkerProcessors } from "./processors";
import {
  createWorkerQuerySession,
  type WorkerQuerySession,
} from "./query-session";

const WORKER_PORT = 37778;
const STARTING_STALE_MS = 10_000;
const WATCHDOG_INTERVAL_MS = 10_000;
const STALLED_QUERY_MS = 30_000;
const IDLE_QUERY_SESSION_MS = 30 * 60 * 1000;
const IDLE_WORKER_HTTP_MS = 30 * 60 * 1000;
const OBS_TIMEOUT_MS = 15_000;
const TURN_STOP_TIMEOUT_MS = 30_000;

export interface QueueDrain {
  (sessionFilter?: number): Promise<void>;
}

export interface SessionState {
  sessionDbId: number;
  querySession: WorkerQuerySession | null;
  contentSessionId: string | null;
  project: string | null;
  initialized: boolean;
  priorTitles: string[];
  lastPushAt: number;
  lastMessageAt: number;
  lastActivity: number;
  queryPid?: number;
  agentSessionId?: string;
  processingLock: Promise<void>;
  closing?: Promise<void>;
  pushMessage: (prompt: string) => Promise<void>;
}

export interface WorkerCoreDeps {
  db: Database;
  now?: () => number;
  nowMs?: () => number;
  processObsImpl?: (state: SessionState, observationId: number) => Promise<void>;
  processTurnStopImpl?: (state: SessionState, turnId: number) => Promise<void>;
  pushSessionSummaryPromptImpl?: (
    state: SessionState,
    sessionId: number,
  ) => Promise<void>;
  closeSessionQueryImpl?: (sessionId: number) => Promise<void>;
  createWorkerQuerySessionImpl?: typeof createWorkerQuerySession;
  isProcessAliveImpl?: typeof isProcessAlive;
  logger?: Pick<Console, "warn" | "error">;
}

export interface WorkerServerDeps extends Partial<WorkerCoreDeps> {
  BunServeImpl?: typeof Bun.serve;
  scanAndDrainQueue?: QueueDrain;
  handleCompactImpl?: (
    sessionId: number,
    transcriptPath?: string | null,
  ) => Promise<void>;
  recoverFromCrashImpl?: () => void;
  now?: () => number;
  pidPath?: string;
  startingPath?: string;
  existsSyncImpl?: typeof existsSync;
  statSyncImpl?: typeof statSync;
  readFileSyncImpl?: typeof readFileSync;
  writeFileSyncImpl?: typeof writeFileSync;
  unlinkSyncImpl?: typeof unlinkSync;
  mkdirSyncImpl?: typeof mkdirSync;
  isProcessAliveImpl?: typeof isProcessAlive;
  shutdownGracefullyImpl?: () => Promise<void>;
  processImpl?: Pick<NodeJS.Process, "pid" | "on" | "exit">;
}

interface WorkerServerState {
  globalScanInFlight: Promise<void> | null;
  scanPending: boolean;
  lastHttpRequestAt: number;
  activeRequests: number;
  shuttingDown: boolean;
}

export interface WorkerCore {
  sessions: Map<number, SessionState>;
  compactingSessions: Set<number>;
  recoverFromCrash(): void;
  scanAndDrainQueue(sessionFilter?: number): Promise<void>;
  processClaimedItem(item: PendingQueueItem): Promise<void>;
  drainSessionCompletely(sessionDbId: number): Promise<void>;
  closeSessionQuery(sessionDbId: number): Promise<void>;
  handleCompact(sessionDbId: number, transcriptPath?: string | null): Promise<void>;
  abortStalledSessions(nowMs?: number): Promise<void>;
}

function defaultNoopDrain(): Promise<void> {
  return Promise.resolve();
}

export function createWorkerServerState(nowMs = Date.now()): WorkerServerState {
  return {
    globalScanInFlight: null,
    scanPending: false,
    lastHttpRequestAt: nowMs,
    activeRequests: 0,
    shuttingDown: false,
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function markSidechainTurnsUndone(
  db: Database,
  sessionDbId: number,
  transcriptPath: string,
  updatedAtEpoch: number,
): number[] {
  const sidechainTurns = parseReplayTranscript(transcriptPath).filter(
    (turn) => turn.isSidechain,
  );

  if (sidechainTurns.length === 0) {
    return [];
  }

  const promptIds = sidechainTurns
    .map((turn) => turn.promptId)
    .filter((value): value is string => Boolean(value));
  const promptNumbers = sidechainTurns.map((turn) => turn.promptNumber);
  const matchClauses: string[] = [];
  const params: Array<number | string> = [sessionDbId];

  if (promptIds.length > 0) {
    matchClauses.push(
      `content_prompt_id IN (${promptIds.map(() => "?").join(", ")})`,
    );
    params.push(...promptIds);
  }

  if (promptNumbers.length > 0) {
    matchClauses.push(
      `prompt_number IN (${promptNumbers.map(() => "?").join(", ")})`,
    );
    params.push(...promptNumbers);
  }

  if (matchClauses.length === 0) {
    return [];
  }

  const turnIds = db
    .query<{ id: number }, Array<number | string>>(
      `
        SELECT id
        FROM turns
        WHERE session_id = ?
          AND (${matchClauses.join(" OR ")})
      `,
    )
    .all(...params)
    .map((row) => row.id);

  if (turnIds.length === 0) {
    return [];
  }

  db.query<unknown, [number, ...number[]]>(
    `
      UPDATE turns
      SET status = 'undone',
          updated_at_epoch = ?
      WHERE id IN (${turnIds.map(() => "?").join(", ")})
    `,
  ).run(updatedAtEpoch, ...turnIds);

  return turnIds;
}

function cleanupUndoneTurnTasks(
  db: Database,
  sessionDbId: number,
  turnIds: number[],
): void {
  if (turnIds.length === 0) {
    return;
  }

  db.query<unknown, [number, ...number[]]>(
    `
      DELETE FROM pending_queue
      WHERE session_db_id = ?
        AND kind = 'turn-stop'
        AND target_id IN (${turnIds.map(() => "?").join(", ")})
    `,
  ).run(sessionDbId, ...turnIds);
}

export function createWorkerCore(deps: WorkerCoreDeps): WorkerCore {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const nowMs = deps.nowMs ?? Date.now;
  const logger = deps.logger ?? console;
  const sessions = new Map<number, SessionState>();
  const compactingSessions = new Set<number>();
  const createWorkerQuerySessionImpl =
    deps.createWorkerQuerySessionImpl ?? createWorkerQuerySession;
  const isProcessAliveImpl = deps.isProcessAliveImpl ?? isProcessAlive;

  const processObsImpl =
    deps.processObsImpl ??
    (async (_state: SessionState, observationId: number) => {
      throw new Error(`processObs not implemented for O${observationId}`);
    });
  const processTurnStopImpl =
    deps.processTurnStopImpl ??
    (async (_state: SessionState, turnId: number) => {
      throw new Error(`processTurnStop not implemented for T${turnId}`);
    });
  const pushSessionSummaryPromptImpl =
    deps.pushSessionSummaryPromptImpl ?? (async () => {});
  const closeSessionQueryImpl = deps.closeSessionQueryImpl ?? (async () => {});

  function getOrCreateSessionState(sessionDbId: number): SessionState {
    let state = sessions.get(sessionDbId);

    if (state) {
      return state;
    }

    state = {
      sessionDbId,
      querySession: null,
      contentSessionId: null,
      project: null,
      initialized: false,
      priorTitles: [],
      lastPushAt: 0,
      lastMessageAt: 0,
      lastActivity: nowMs(),
      processingLock: Promise.resolve(),
      async pushMessage(prompt: string): Promise<void> {
        const runtime = ensureQuerySession(state!);
        state!.lastActivity = nowMs();
        state!.lastPushAt = nowMs();
        const result = await runtime.sendPrompt(prompt);
        state!.lastMessageAt = nowMs();
        state!.queryPid = runtime.queryPid;
        state!.agentSessionId = result.session_id;
        state!.initialized = true;
      },
    };
    sessions.set(sessionDbId, state);
    return state;
  }

  function ensureQuerySession(state: SessionState): WorkerQuerySession {
    if (state.querySession) {
      return state.querySession;
    }

    const session = getSession(deps.db, state.sessionDbId);
    if (!session) {
      throw new Error(`Missing session ${state.sessionDbId} for worker query setup.`);
    }

    state.contentSessionId = session.contentSessionId;
    state.project = session.project;
    state.querySession = createWorkerQuerySessionImpl(
      deps.db,
      state.sessionDbId,
      session.project,
      {
        onMessage: (message) => {
          state!.lastMessageAt = nowMs();
          state!.lastActivity = nowMs();
          if (
            "session_id" in message &&
            typeof message.session_id === "string" &&
            message.session_id !== ""
          ) {
            state!.agentSessionId = message.session_id;
          }
        },
        onPid: (pid) => {
          state!.queryPid = pid;
        },
      },
    );

    return state.querySession;
  }

  async function closeSessionQuery(sessionDbId: number): Promise<void> {
    const state = sessions.get(sessionDbId);
    if (!state) {
      return;
    }

    if (state.closing) {
      return state.closing;
    }

    state.closing = (async () => {
      try {
        await Promise.race([
          state.querySession?.close() ?? Promise.resolve(),
          new Promise<void>((resolve) => {
            setTimeout(resolve, 5_000);
          }),
        ]);

        if (state.queryPid && isProcessAliveImpl(state.queryPid)) {
          try {
            process.kill(state.queryPid, "SIGKILL");
          } catch {}
        }

        await closeSessionQueryImpl(sessionDbId);
      } finally {
        sessions.delete(sessionDbId);
      }
    })();

    return state.closing;
  }

  async function processClaimedItem(item: PendingQueueItem): Promise<void> {
    const state = getOrCreateSessionState(item.sessionDbId);

    const myTurn = state.processingLock;
    let release!: () => void;
    state.processingLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await myTurn;

    const timeoutMs = item.kind === "obs" ? OBS_TIMEOUT_MS : TURN_STOP_TIMEOUT_MS;
    const workPromise = Promise.resolve(
      item.kind === "obs"
        ? processObsImpl(state, item.targetId)
        : processTurnStopImpl(state, item.targetId),
    );
    const completion = workPromise.finally(() => {
      release();
    });
    completion.catch(() => {});

    await withTimeout(
      workPromise,
      timeoutMs,
      `${item.kind} ${item.targetId} timeout after ${timeoutMs}ms`,
    );
  }

  async function scanAndDrainQueue(sessionFilter?: number): Promise<void> {
    const skippedSeqs = new Set<number>();

    while (true) {
      const item = claimNextItem(deps.db, now(), {
        sessionFilter,
        skippedSeqs,
        excludeSessions:
          sessionFilter === undefined ? compactingSessions : undefined,
      });

      if (!item) {
        return;
      }

      try {
        await processClaimedItem(item);
        deleteQueueItem(deps.db, item.seq);
      } catch (error) {
        releaseQueueClaim(deps.db, item.seq);
        skippedSeqs.add(item.seq);
        logger.error?.("queue item failed, skipping for this drain", {
          seq: item.seq,
          kind: item.kind,
          targetId: item.targetId,
          error,
        });
      }
    }
  }

  async function drainSessionCompletely(sessionDbId: number): Promise<void> {
    let previousCount = Number.POSITIVE_INFINITY;

    while (true) {
      await scanAndDrainQueue(sessionDbId);

      const state = sessions.get(sessionDbId);
      if (state) {
        while (true) {
          const lockBefore = state.processingLock;
          await lockBefore;
          if (lockBefore === state.processingLock) {
            break;
          }
        }
      }

      const remaining = countQueueItemsForSession(deps.db, sessionDbId);
      if (remaining === 0) {
        return;
      }

      if (remaining >= previousCount) {
        logger.warn?.("drainSessionCompletely: no progress, giving up", {
          sessionDbId,
          remaining,
        });
        return;
      }

      previousCount = remaining;
    }
  }

  function recoverFromCrash(): void {
    resetClaimedQueueItems(deps.db);
  }

  async function handleCompact(
    sessionDbId: number,
    transcriptPath?: string | null,
  ): Promise<void> {
    compactingSessions.add(sessionDbId);

    try {
      if (transcriptPath) {
        const undoneTurnIds = markSidechainTurnsUndone(
          deps.db,
          sessionDbId,
          transcriptPath,
          now(),
        );
        cleanupUndoneTurnTasks(deps.db, sessionDbId, undoneTurnIds);
      }

      try {
        await drainSessionCompletely(sessionDbId);
      } catch (error) {
        logger.error?.("drainSessionCompletely failed during compact", {
          sessionDbId,
          error,
        });
      }

      try {
        const state = getOrCreateSessionState(sessionDbId);
        await pushSessionSummaryPromptImpl(state, sessionDbId);
      } catch (error) {
        logger.error?.("session summary push failed", {
          sessionDbId,
          error,
        });
      }
    } finally {
      compactingSessions.delete(sessionDbId);
      await closeSessionQuery(sessionDbId).catch((error) => {
        logger.error?.("closeSessionQuery failed", { sessionDbId, error });
      });
    }
  }

  return {
    sessions,
    compactingSessions,
    recoverFromCrash,
    scanAndDrainQueue,
    processClaimedItem,
    drainSessionCompletely,
    closeSessionQuery,
    handleCompact,
    async abortStalledSessions(nowMsOverride?: number): Promise<void> {
      const currentMs = nowMsOverride ?? nowMs();
      await Promise.all(
        Array.from(sessions.values()).map(async (state) => {
          if (!state.querySession) {
            return;
          }

          const hasInflightRequest = state.lastPushAt > state.lastMessageAt;

          if (
            hasInflightRequest &&
            currentMs - state.lastPushAt > STALLED_QUERY_MS
          ) {
            logger.warn?.("query session stalled, aborting", {
              sessionDbId: state.sessionDbId,
              lastPushAt: state.lastPushAt,
              lastMessageAt: state.lastMessageAt,
              queryPid: state.queryPid,
            });
            await closeSessionQuery(state.sessionDbId).catch((error) => {
              logger.error?.("watchdog closeSessionQuery failed", {
                sessionDbId: state.sessionDbId,
                error,
              });
            });
            return;
          }

          if (
            !hasInflightRequest &&
            currentMs - state.lastActivity > IDLE_QUERY_SESSION_MS
          ) {
            logger.warn?.("query session idle, closing", {
              sessionDbId: state.sessionDbId,
              lastActivity: state.lastActivity,
              queryPid: state.queryPid,
            });
            await closeSessionQuery(state.sessionDbId).catch((error) => {
              logger.error?.("idle closeSessionQuery failed", {
                sessionDbId: state.sessionDbId,
                error,
              });
            });
          }
        }),
      );
    },
  };
}

export function acquireWorkerSingleton(
  deps: WorkerServerDeps = {},
): "acquired" | "already-running" {
  const now = deps.now ?? Date.now;
  const pidPath = deps.pidPath ?? WORKER_PID_PATH;
  const startingPath = deps.startingPath ?? WORKER_STARTING_PATH;
  const existsSyncImpl = deps.existsSyncImpl ?? existsSync;
  const statSyncImpl = deps.statSyncImpl ?? statSync;
  const readFileSyncImpl = deps.readFileSyncImpl ?? readFileSync;
  const writeFileSyncImpl = deps.writeFileSyncImpl ?? writeFileSync;
  const unlinkSyncImpl = deps.unlinkSyncImpl ?? unlinkSync;
  const mkdirSyncImpl = deps.mkdirSyncImpl ?? mkdirSync;
  const isProcessAliveImpl = deps.isProcessAliveImpl ?? isProcessAlive;
  const dataDir = join(homedir(), ".claude-mnemo");

  if (!existsSyncImpl(dataDir)) {
    mkdirSyncImpl(dataDir, { recursive: true });
  }

  if (existsSyncImpl(startingPath)) {
    const startingAt = statSyncImpl(startingPath).mtimeMs;
    if (now() - startingAt < STARTING_STALE_MS) {
      return "already-running";
    }
    try {
      unlinkSyncImpl(startingPath);
    } catch {}
  }

  if (existsSyncImpl(pidPath)) {
    const rawPid = readFileSyncImpl(pidPath, "utf8");
    const pid = Number.parseInt(rawPid, 10);
    if (!Number.isNaN(pid) && isProcessAliveImpl(pid)) {
      return "already-running";
    }
    try {
      unlinkSyncImpl(pidPath);
    } catch {}
  }

  writeFileSyncImpl(startingPath, String(process.pid));
  return "acquired";
}

export function createWorkerFetchHandler(
  deps: WorkerServerDeps = {},
  state: WorkerServerState = createWorkerServerState(deps.nowMs?.() ?? Date.now()),
): (req: Request) => Promise<Response> {
  const runtime =
    deps.scanAndDrainQueue || deps.handleCompactImpl || deps.recoverFromCrashImpl
      ? undefined
      : createWorkerCore({
          db: deps.db ?? createDatabase(),
          now: deps.now,
          nowMs: deps.nowMs,
          processObsImpl: deps.processObsImpl,
          processTurnStopImpl: deps.processTurnStopImpl,
          pushSessionSummaryPromptImpl: deps.pushSessionSummaryPromptImpl,
          closeSessionQueryImpl: deps.closeSessionQueryImpl,
          createWorkerQuerySessionImpl: deps.createWorkerQuerySessionImpl,
          isProcessAliveImpl: deps.isProcessAliveImpl,
        });

  const scanAndDrainQueue =
    deps.scanAndDrainQueue ?? runtime?.scanAndDrainQueue ?? defaultNoopDrain;
  const handleCompactImpl =
    deps.handleCompactImpl ??
    runtime?.handleCompact ??
    (async (sessionId: number) => {
      await scanAndDrainQueue(sessionId);
    });

  async function handleWake(): Promise<Response> {
    if (state.globalScanInFlight) {
      state.scanPending = true;
      return new Response(null, { status: 200 });
    }

    state.globalScanInFlight = (async () => {
      do {
        state.scanPending = false;
        await scanAndDrainQueue();
      } while (state.scanPending);
    })().finally(() => {
      state.globalScanInFlight = null;
    });

    return new Response(null, { status: 200 });
  }

  return async (req: Request): Promise<Response> => {
    state.lastHttpRequestAt = deps.nowMs?.() ?? Date.now();
    state.activeRequests += 1;

    try {
      const url = new URL(req.url);

      if (req.method === "GET" && url.pathname === "/health") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (req.method === "POST" && url.pathname === "/wake") {
        return handleWake();
      }

      if (req.method === "POST" && url.pathname === "/compact") {
        const payload = (await req.json()) as {
          session_id?: number;
          transcript_path?: string | null;
        };

        if (typeof payload.session_id !== "number") {
          return new Response("session_id is required", { status: 400 });
        }

        await handleCompactImpl(payload.session_id, payload.transcript_path);
        return new Response(null, { status: 200 });
      }

      return new Response("Not found", { status: 404 });
    } finally {
      state.activeRequests = Math.max(0, state.activeRequests - 1);
    }
  };
}

export async function shutdownGracefully(
  deps: WorkerServerDeps = {},
): Promise<void> {
  await deps.shutdownGracefullyImpl?.();
}

function createShutdownCleanup(deps: WorkerServerDeps = {}): () => Promise<void> {
  const pidPath = deps.pidPath ?? WORKER_PID_PATH;
  const unlinkSyncImpl = deps.unlinkSyncImpl ?? unlinkSync;
  const processImpl = deps.processImpl ?? process;

  return async () => {
    try {
      await shutdownGracefully(deps);
    } finally {
      try {
        unlinkSyncImpl(pidPath);
      } catch {}
      processImpl.exit(0);
    }
  };
}

export async function checkForIdleWorkerShutdown(
  state: WorkerServerState,
  deps: WorkerServerDeps = {},
): Promise<boolean> {
  if (state.shuttingDown || state.activeRequests > 0) {
    return false;
  }

  const currentMs = deps.nowMs?.() ?? Date.now();
  if (currentMs - state.lastHttpRequestAt <= IDLE_WORKER_HTTP_MS) {
    return false;
  }

  state.shuttingDown = true;
  try {
    await createShutdownCleanup(deps)();
    return true;
  } catch (error) {
    state.shuttingDown = false;
    throw error;
  }
}

export function registerShutdownCleanup(deps: WorkerServerDeps = {}): void {
  const processImpl = deps.processImpl ?? process;
  const cleanup = createShutdownCleanup(deps);

  processImpl.on("SIGTERM", cleanup);
  processImpl.on("SIGINT", cleanup);
  processImpl.on("beforeExit", cleanup);
}

export async function main(deps: WorkerServerDeps = {}): Promise<void> {
  const result = acquireWorkerSingleton(deps);
  if (result === "already-running") {
    process.exit(0);
  }

  const BunServeImpl = deps.BunServeImpl ?? Bun.serve;
  const pidPath = deps.pidPath ?? WORKER_PID_PATH;
  const startingPath = deps.startingPath ?? WORKER_STARTING_PATH;
  const writeFileSyncImpl = deps.writeFileSyncImpl ?? writeFileSync;
  const unlinkSyncImpl = deps.unlinkSyncImpl ?? unlinkSync;
  const db = deps.db ?? createDatabase();
  const serverState = createWorkerServerState(deps.nowMs?.() ?? Date.now());

  initializeDatabase(db);
  const processors = createWorkerProcessors(db);

  const core = createWorkerCore({
    db,
    now: deps.now,
    nowMs: deps.nowMs,
    processObsImpl: deps.processObsImpl ?? processors.processObs,
    processTurnStopImpl: deps.processTurnStopImpl ?? processors.processTurnStop,
    pushSessionSummaryPromptImpl:
      deps.pushSessionSummaryPromptImpl ?? processors.pushSessionSummaryPrompt,
    closeSessionQueryImpl: deps.closeSessionQueryImpl,
    createWorkerQuerySessionImpl: deps.createWorkerQuerySessionImpl,
    isProcessAliveImpl: deps.isProcessAliveImpl,
  });

  core.recoverFromCrash();

  let server: { stop(force?: boolean): void };
  try {
    server = BunServeImpl({
      port: WORKER_PORT,
      fetch: createWorkerFetchHandler(
        {
          ...deps,
          db,
          scanAndDrainQueue: core.scanAndDrainQueue,
          handleCompactImpl: core.handleCompact,
        },
        serverState,
      ),
    });
  } catch (error) {
    try {
      unlinkSyncImpl(startingPath);
    } catch {}

    if ((error as NodeJS.ErrnoException | undefined)?.code === "EADDRINUSE") {
      process.exit(0);
      return;
    }

    throw error;
  }

  try {
    writeFileSyncImpl(pidPath, String(process.pid));
  } finally {
    try {
      unlinkSyncImpl(startingPath);
    } catch {}
  }

  void core.scanAndDrainQueue();
  setInterval(() => {
    void core.abortStalledSessions();
  }, WATCHDOG_INTERVAL_MS);
  setInterval(() => {
    void checkForIdleWorkerShutdown(serverState, {
      ...deps,
      shutdownGracefullyImpl: async () => {
        await deps.shutdownGracefullyImpl?.();
        server.stop(true);
      },
    });
  }, WATCHDOG_INTERVAL_MS);

  registerShutdownCleanup({
    ...deps,
    shutdownGracefullyImpl: async () => {
      await deps.shutdownGracefullyImpl?.();
      server.stop(true);
    },
  });
}

function isDirectExecution(): boolean {
  const entry = process.argv[1] ?? "";
  return entry.endsWith("/server.ts") || entry.endsWith("/worker.cjs");
}

if (isDirectExecution()) {
  void main();
}
