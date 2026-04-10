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

const WORKER_PORT = 37778;
const STARTING_STALE_MS = 10_000;
const OBS_TIMEOUT_MS = 15_000;
const TURN_STOP_TIMEOUT_MS = 30_000;

export interface QueueDrain {
  (sessionFilter?: number): Promise<void>;
}

export interface SessionState {
  sessionDbId: number;
  processingLock: Promise<void>;
  closing?: Promise<void>;
}

export interface WorkerCoreDeps {
  db: Database;
  now?: () => number;
  processObsImpl?: (state: SessionState, observationId: number) => Promise<void>;
  processTurnStopImpl?: (state: SessionState, turnId: number) => Promise<void>;
  pushSessionSummaryPromptImpl?: (sessionId: number) => Promise<void>;
  closeSessionQueryImpl?: (sessionId: number) => Promise<void>;
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
}

function defaultNoopDrain(): Promise<void> {
  return Promise.resolve();
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

function getOrCreateSessionState(
  sessions: Map<number, SessionState>,
  sessionDbId: number,
): SessionState {
  let state = sessions.get(sessionDbId);

  if (!state) {
    state = {
      sessionDbId,
      processingLock: Promise.resolve(),
    };
    sessions.set(sessionDbId, state);
  }

  return state;
}

export function createWorkerCore(deps: WorkerCoreDeps): WorkerCore {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const logger = deps.logger ?? console;
  const sessions = new Map<number, SessionState>();
  const compactingSessions = new Set<number>();

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
        await closeSessionQueryImpl(sessionDbId);
      } finally {
        sessions.delete(sessionDbId);
      }
    })();

    return state.closing;
  }

  async function processClaimedItem(item: PendingQueueItem): Promise<void> {
    const state = getOrCreateSessionState(sessions, item.sessionDbId);

    const myTurn = state.processingLock;
    let release!: () => void;
    state.processingLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await myTurn;

    const timeoutMs = item.kind === "obs" ? OBS_TIMEOUT_MS : TURN_STOP_TIMEOUT_MS;

    try {
      await withTimeout(
        item.kind === "obs"
          ? processObsImpl(state, item.targetId)
          : processTurnStopImpl(state, item.targetId),
        timeoutMs,
        `${item.kind} ${item.targetId} timeout after ${timeoutMs}ms`,
      );
    } finally {
      release();
    }
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
    _transcriptPath?: string | null,
  ): Promise<void> {
    compactingSessions.add(sessionDbId);

    try {
      try {
        await drainSessionCompletely(sessionDbId);
      } catch (error) {
        logger.error?.("drainSessionCompletely failed during compact", {
          sessionDbId,
          error,
        });
      }

      try {
        await pushSessionSummaryPromptImpl(sessionDbId);
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
  state: WorkerServerState = {
    globalScanInFlight: null,
    scanPending: false,
  },
): (req: Request) => Promise<Response> {
  const runtime =
    deps.scanAndDrainQueue || deps.handleCompactImpl || deps.recoverFromCrashImpl
      ? undefined
      : createWorkerCore({
          db: deps.db ?? createDatabase(),
          now: deps.now,
          processObsImpl: deps.processObsImpl,
          processTurnStopImpl: deps.processTurnStopImpl,
          pushSessionSummaryPromptImpl: deps.pushSessionSummaryPromptImpl,
          closeSessionQueryImpl: deps.closeSessionQueryImpl,
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
  };
}

export async function shutdownGracefully(
  deps: WorkerServerDeps = {},
): Promise<void> {
  await deps.shutdownGracefullyImpl?.();
}

export function registerShutdownCleanup(deps: WorkerServerDeps = {}): void {
  const pidPath = deps.pidPath ?? WORKER_PID_PATH;
  const unlinkSyncImpl = deps.unlinkSyncImpl ?? unlinkSync;
  const processImpl = deps.processImpl ?? process;

  const cleanup = async () => {
    try {
      await shutdownGracefully(deps);
    } finally {
      try {
        unlinkSyncImpl(pidPath);
      } catch {}
      processImpl.exit(0);
    }
  };

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

  initializeDatabase(db);

  const core = createWorkerCore({
    db,
    now: deps.now,
    processObsImpl: deps.processObsImpl,
    processTurnStopImpl: deps.processTurnStopImpl,
    pushSessionSummaryPromptImpl: deps.pushSessionSummaryPromptImpl,
    closeSessionQueryImpl: deps.closeSessionQueryImpl,
  });

  core.recoverFromCrash();

  const server = BunServeImpl({
    port: WORKER_PORT,
    fetch: createWorkerFetchHandler({
      ...deps,
      db,
      scanAndDrainQueue: core.scanAndDrainQueue,
      handleCompactImpl: core.handleCompact,
    }),
  });

  try {
    writeFileSyncImpl(pidPath, String(process.pid));
  } finally {
    try {
      unlinkSyncImpl(startingPath);
    } catch {}
  }

  void core.scanAndDrainQueue();

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
