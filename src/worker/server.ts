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

import { BUILD_ID } from "../shared/build-id";
import { createDatabase } from "../db/database";
import {
  getSession,
  updateCompactAnchor,
  updateLastAgentSessionId,
} from "../db/sessions";
import { getObservation } from "../db/observations";
import { getTurnById } from "../db/turns";
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
import {
  DATA_DIR,
  WORKER_PID_PATH,
  WORKER_STARTING_PATH,
  resolveTranscriptPath,
} from "../shared/paths";
import { DEFAULT_CONFIG, loadConfig, type MnemoConfig } from "../shared/config";
import {
  getReminderItems,
  getSilencedReminderItems,
  markReminderItemsNotified,
} from "./invalidation";
import {
  detectAndCleanSubagentTurns,
  getPendingSubagentTurns,
  markSubagentTurnsNotified,
} from "./subagent-filter";
import { detectCacheTtl } from "./cache-ttl";
import { createWorkerProcessors, type TurnPayload } from "./processors";
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

export interface BufferState {
  items: PendingQueueItem[];
}

interface BatchEntry {
  turns: TurnPayload[];
  size: number;
  sessionUpdated: boolean;
  oldestTurnEpoch: number;
}

export interface SessionState {
  sessionDbId: number;
  querySession: WorkerQuerySession | null;
  contentSessionId: string | null;
  project: string | null;
  batchQueue: BatchEntry[];
  cacheTtlMs: number;
  lastInjectedSummaryEpoch?: number;
  nextBatchNeedsSessionContext: boolean;
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
  buildTurnPayloadImpl?: (
    turnId: number,
    obsItems: PendingQueueItem[],
    turnStopItem: PendingQueueItem,
  ) => TurnPayload | null;
  processBatchImpl?: (
    state: SessionState,
    items: PendingQueueItem[],
    options?: {
      turnStopItems?: PendingQueueItem[];
      sessionUpdated?: boolean;
    },
  ) => Promise<void>;
  pushSessionSummaryPromptImpl?: (
    state: SessionState,
    sessionId: number,
  ) => Promise<void>;
  closeSessionQueryImpl?: (sessionId: number) => Promise<void>;
  createWorkerQuerySessionImpl?: typeof createWorkerQuerySession;
  isProcessAliveImpl?: typeof isProcessAlive;
  logger?: Pick<Console, "warn" | "error">;
  config?: MnemoConfig;
}

export interface WorkerServerDeps extends Partial<WorkerCoreDeps> {
  BunServeImpl?: typeof Bun.serve;
  scanAndDrainQueue?: QueueDrain;
  handleFlushImpl?: (sessionId: number) => Promise<void>;
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
  env?: NodeJS.ProcessEnv;
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
  buffers: Map<number, BufferState>;
  compactingSessions: Set<number>;
  recoverFromCrash(): void;
  scanAndDrainQueue(sessionFilter?: number): Promise<void>;
  processClaimedItem(item: PendingQueueItem): Promise<void>;
  flushSession(sessionDbId: number): Promise<void>;
  drainSessionCompletely(sessionDbId: number): Promise<void>;
  closeSessionQuery(sessionDbId: number): Promise<void>;
  handleCompact(sessionDbId: number, transcriptPath?: string | null): Promise<void>;
  abortStalledSessions(nowMs?: number): Promise<void>;
  runKeepaliveTick(nowMs?: number): Promise<void>;
}

function defaultNoopDrain(): Promise<void> {
  return Promise.resolve();
}

function getStartupFlushSessionId(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const raw = env.CLAUDE_MNEMO_FLUSH_SESSION_ID;
  if (!raw) {
    return null;
  }

  const sessionId = Number(raw);
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    return null;
  }

  return sessionId;
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

function buildSubagentInvalidationEnvelope(promptNumbers: number[]): string {
  const labels = promptNumbers.map((promptNumber) => `T${promptNumber}`).join(", ");
  return `<subagent_invalidated>
  ${labels} originated from a Task subagent transcript and are out-of-scope
  for session memory.
</subagent_invalidated>`;
}

function buildReminderEnvelope(
  items: ReadonlyArray<{
    promptNumber: number;
    wasInterrupted: boolean;
    wasRolledBack: boolean;
    priorTitle: string | null;
    priorContent: string | null;
    replacementPromptNumber: number | null;
  }>,
): string {
  function truncateReminderContent(value: string | null): string | null {
    const text = value?.trim().replace(/\s+/g, " ");
    if (!text) {
      return null;
    }
    if (text.length <= 120) {
      return text;
    }
    return `${text.slice(0, 117)}...`;
  }

  const lines = items.map((item) => {
    const flags =
      item.wasInterrupted && item.wasRolledBack
        ? "was_interrupted+was_rolled_back"
        : item.wasInterrupted
          ? "was_interrupted"
          : item.wasRolledBack
            ? "was_rolled_back"
            : "fresh";
    const replacementClause =
      item.replacementPromptNumber !== null
        ? `, replaced by T${item.replacementPromptNumber}`
        : "";
    const summaryParts: string[] = [];
    if (item.priorTitle) {
      summaryParts.push(`"${item.priorTitle}"`);
    }
    const truncatedContent = truncateReminderContent(item.priorContent);
    if (truncatedContent) {
      summaryParts.push(truncatedContent);
    }
    const summaryClause =
      summaryParts.length > 0 ? `: ${summaryParts.join(" -- ")}` : "";
    return `  - T${item.promptNumber} (${flags}${replacementClause})${summaryClause}`;
  });

  return `<reminder>
  The following turns were invalidated and need one-time attention.
${lines.join("\n")}
</reminder>`;
}

function pruneBufferedUndoneItems(
  db: Database,
  items: PendingQueueItem[],
): { activeItems: PendingQueueItem[]; prunedSeqs: Set<number> } {
  const activeItems: PendingQueueItem[] = [];
  const prunedSeqs = new Set<number>();

  for (const item of items) {
    if (item.kind === "obs") {
      const observation = getObservation(db, item.targetId);
      const turn = observation ? getTurnById(db, observation.turnId) : null;

      if (!observation || !turn || turn.status === "undone") {
        deleteQueueItem(db, item.seq);
        prunedSeqs.add(item.seq);
        continue;
      }

      activeItems.push(item);
      continue;
    }

    const turn = getTurnById(db, item.targetId);
    if (!turn || turn.status === "undone") {
      deleteQueueItem(db, item.seq);
      prunedSeqs.add(item.seq);
      continue;
    }

    activeItems.push(item);
  }

  return { activeItems, prunedSeqs };
}

export function createWorkerCore(deps: WorkerCoreDeps): WorkerCore {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const nowMs = deps.nowMs ?? Date.now;
  const logger = deps.logger ?? console;
  const config = deps.config ?? DEFAULT_CONFIG;
  const sessions = new Map<number, SessionState>();
  const buffers = new Map<number, BufferState>();
  const compactingSessions = new Set<number>();
  const createWorkerQuerySessionImpl =
    deps.createWorkerQuerySessionImpl ?? createWorkerQuerySession;
  const isProcessAliveImpl = deps.isProcessAliveImpl ?? isProcessAlive;

  const fallbackProcessors = deps.buildTurnPayloadImpl
    ? null
    : createWorkerProcessors(deps.db);
  const buildTurnPayloadImpl =
    deps.buildTurnPayloadImpl ??
    fallbackProcessors!.buildTurnPayload;
  const processBatchImpl =
    deps.processBatchImpl ??
    (async () => {
      throw new Error("processBatch not implemented");
    });
  const pushSessionSummaryPromptImpl =
    deps.pushSessionSummaryPromptImpl ?? (async () => {});
  const closeSessionQueryImpl = deps.closeSessionQueryImpl ?? (async () => {});

  function hasPriorSessionSummary(sessionId: number): boolean {
    const session = getSession(deps.db, sessionId);
    if (!session) {
      return false;
    }

    return (
      (session.title ?? "") !== "" ||
      (session.content ?? "") !== "" ||
      (session.insight ?? "") !== "" ||
      (session.nextSteps ?? "") !== ""
    );
  }

  function getOrCreateBuffer(sessionDbId: number): BufferState {
    let buffer = buffers.get(sessionDbId);
    if (buffer) {
      return buffer;
    }

    buffer = { items: [] };
    buffers.set(sessionDbId, buffer);
    return buffer;
  }

  function clearBuffer(sessionDbId: number): void {
    buffers.delete(sessionDbId);
  }

  function removeBufferedItemsBySeq(
    sessionDbId: number,
    seqs: Set<number>,
  ): void {
    if (seqs.size === 0) {
      return;
    }

    const buffer = buffers.get(sessionDbId);
    if (!buffer) {
      return;
    }

    buffer.items = buffer.items.filter((item) => !seqs.has(item.seq));
    if (buffer.items.length === 0) {
      buffers.delete(sessionDbId);
    }
  }

  function replaceBufferItems(
    sessionDbId: number,
    items: PendingQueueItem[],
  ): void {
    if (items.length === 0) {
      buffers.delete(sessionDbId);
      return;
    }

    const buffer = getOrCreateBuffer(sessionDbId);
    buffer.items = items;
  }

  function refreshPendingSessionContextFlag(state: SessionState): void {
    const session = getSession(deps.db, state.sessionDbId);
    if (!session) {
      return;
    }

    const summaryEpoch = session.summaryUpdatedAtEpoch ?? 0;
    if (
      summaryEpoch > (state.lastInjectedSummaryEpoch ?? 0) &&
      !state.batchQueue.some((batch) => batch.sessionUpdated)
    ) {
      state.nextBatchNeedsSessionContext = hasPriorSessionSummary(state.sessionDbId);
    }
  }

  function recalculateBatchSize(batch: BatchEntry): void {
    batch.size = batch.turns.reduce((total, turn) => total + turn.size, 0);
  }

  function releaseBatchClaims(batch: BatchEntry): void {
    for (const turn of batch.turns) {
      for (const item of turn.obsItems) {
        releaseQueueClaim(deps.db, item.seq);
      }
      releaseQueueClaim(deps.db, turn.turnStopItem.seq);
    }
  }

  function pruneInProgressBuffer(sessionDbId: number): void {
    const buffer = buffers.get(sessionDbId);
    if (!buffer) {
      return;
    }

    const activeItems: PendingQueueItem[] = [];
    const prunedSeqs = new Set<number>();
    const { activeItems: prunedItems, prunedSeqs: deletedSeqs } =
      pruneBufferedUndoneItems(deps.db, buffer.items);

    for (const item of prunedItems) {
      if (item.kind === "obs") {
        activeItems.push(item);
      } else {
        deleteQueueItem(deps.db, item.seq);
        prunedSeqs.add(item.seq);
      }
    }

    if (deletedSeqs.size > 0 || prunedSeqs.size > 0) {
      replaceBufferItems(sessionDbId, activeItems);
      return;
    }

    buffer.items = activeItems;
    if (buffer.items.length === 0) {
      buffers.delete(sessionDbId);
    }
  }

  function pruneBatchQueueLocked(state: SessionState): void {
    const nextQueue: BatchEntry[] = [];

    for (const batch of state.batchQueue) {
      const keptTurns = batch.turns.filter((turnPayload) => {
        const turn = getTurnById(deps.db, turnPayload.turnId);
        if (!turn || turn.status === "undone") {
          for (const item of turnPayload.obsItems) {
            deleteQueueItem(deps.db, item.seq);
          }
          deleteQueueItem(deps.db, turnPayload.turnStopItem.seq);
          return false;
        }
        return true;
      });

      if (keptTurns.length === 0) {
        continue;
      }

      const nextBatch: BatchEntry = {
        ...batch,
        turns: keptTurns,
      };
      recalculateBatchSize(nextBatch);
      nextQueue.push(nextBatch);
    }

    state.batchQueue = nextQueue;
  }

  function collectTurnObsItemsLocked(
    sessionDbId: number,
    turnId: number,
  ): PendingQueueItem[] {
    pruneInProgressBuffer(sessionDbId);
    const buffer = buffers.get(sessionDbId);
    if (!buffer) {
      return [];
    }

    const selected = buffer.items.filter((item) => {
      const observation = getObservation(deps.db, item.targetId);
      return observation?.turnId === turnId;
    });

    if (selected.length === 0) {
      return [];
    }

    removeBufferedItemsBySeq(
      sessionDbId,
      new Set(selected.map((item) => item.seq)),
    );

    return selected;
  }

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
      batchQueue: [],
      cacheTtlMs: 300_000,
      lastInjectedSummaryEpoch: 0,
      nextBatchNeedsSessionContext: hasPriorSessionSummary(sessionDbId),
      lastPushAt: 0,
      lastMessageAt: 0,
      lastActivity: nowMs(),
      processingLock: Promise.resolve(),
      async pushMessage(prompt: string): Promise<void> {
        const runtime = ensureQuerySession(state!);
        const mainTranscriptPath =
          state!.contentSessionId && state!.project
            ? resolveTranscriptPath(state!.project, state!.contentSessionId)
            : undefined;
        const pendingSubagentTurns = getPendingSubagentTurns(
          deps.db,
          state!.sessionDbId,
        );
        const reminderItems = getReminderItems(
          deps.db,
          state!.sessionDbId,
          mainTranscriptPath,
        );
        const silencedReminderItems = getSilencedReminderItems(
          deps.db,
          state!.sessionDbId,
          mainTranscriptPath,
        );
        const envelopeBlocks: string[] = [];
        if (pendingSubagentTurns.length > 0) {
          envelopeBlocks.push(
            buildSubagentInvalidationEnvelope(
              pendingSubagentTurns.map((turn) => turn.promptNumber),
            ),
          );
        }
        if (reminderItems.length > 0) {
          envelopeBlocks.push(buildReminderEnvelope(reminderItems));
        }
        const promptWithEnvelopes =
          envelopeBlocks.length > 0
            ? `${envelopeBlocks.join("\n\n")}\n\n${prompt}`
            : prompt;
        state!.lastActivity = nowMs();
        state!.lastPushAt = nowMs();
        const result = await runtime.sendPrompt(promptWithEnvelopes);
        state!.lastMessageAt = nowMs();
        state!.queryPid = runtime.queryPid;
        state!.agentSessionId = result.session_id;
        void detectCacheTtl(result.session_id, runtimeProjectPath)
          .then((ttlMs) => {
            if (ttlMs) {
              state!.cacheTtlMs = ttlMs;
            }
          })
          .catch(() => {});
        if (pendingSubagentTurns.length > 0) {
          try {
            markSubagentTurnsNotified(deps.db, pendingSubagentTurns, now());
          } catch (error) {
            logger.error?.("failed to mark subagent turns notified", {
              sessionDbId: state!.sessionDbId,
              error,
            });
          }
        }
        if (reminderItems.length > 0 || silencedReminderItems.length > 0) {
          try {
            markReminderItemsNotified(
              deps.db,
              [...reminderItems, ...silencedReminderItems],
              now(),
            );
          } catch (error) {
            logger.error?.("failed to mark reminder items notified", {
              sessionDbId: state!.sessionDbId,
              error,
            });
          }
        }
      },
    };
    const runtimeProjectPath = DATA_DIR;
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
    state.nextBatchNeedsSessionContext =
      state.nextBatchNeedsSessionContext || hasPriorSessionSummary(state.sessionDbId);
    if (session.lastAgentSessionId) {
      state.agentSessionId = session.lastAgentSessionId;
    }
    state.querySession = createWorkerQuerySessionImpl(
      {
        db: deps.db,
        sessionDbId: state.sessionDbId,
        contentSessionId: session.contentSessionId,
        project: session.project,
        config,
        resumeAgentSessionId: session.lastAgentSessionId,
      },
      {
        onMessage: (message) => {
          state!.lastMessageAt = nowMs();
          state!.lastActivity = nowMs();
          if (
            "session_id" in message &&
            typeof message.session_id === "string" &&
            message.session_id !== ""
          ) {
            const newAgentSessionId = message.session_id;
            const isFirstObservation =
              state!.agentSessionId !== newAgentSessionId;
            state!.agentSessionId = newAgentSessionId;
            if (isFirstObservation) {
              try {
                updateLastAgentSessionId(
                  deps.db,
                  state!.sessionDbId,
                  newAgentSessionId,
                );
              } catch (error) {
                logger.error?.("updateLastAgentSessionId failed", {
                  sessionDbId: state!.sessionDbId,
                  error,
                });
              }
            }
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

  async function withSessionProcessingLock<T>(
    sessionDbId: number,
    work: (state: SessionState) => Promise<T>,
  ): Promise<T> {
    const state = getOrCreateSessionState(sessionDbId);
    const myTurn = state.processingLock;
    let release!: () => void;
    state.processingLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await myTurn;

    const workPromise = Promise.resolve(work(state));
    const completion = workPromise.finally(() => {
      release();
    });
    completion.catch(() => {});

    return workPromise;
  }

  async function processClaimedItem(item: PendingQueueItem): Promise<void> {
    if (item.kind === "obs") {
      throw new Error("processClaimedItem no longer supports standalone obs pushes");
    }

    const workPromise = withSessionProcessingLock(item.sessionDbId, async (state) => {
      await processTurnStopLocked(state, item);
    });

    await withTimeout(
      workPromise,
      TURN_STOP_TIMEOUT_MS,
      `${item.kind} ${item.targetId} timeout after ${TURN_STOP_TIMEOUT_MS}ms`,
    );
  }

  async function flushOneBatchLocked(state: SessionState): Promise<void> {
    pruneBatchQueueLocked(state);
    const batch = state.batchQueue[0];
    if (!batch) {
      return;
    }

    const obsItems = batch.turns.flatMap((turn) => turn.obsItems);
    const turnStopItems = batch.turns.map((turn) => turn.turnStopItem);

    try {
      await processBatchImpl(state, obsItems, {
        turnStopItems,
        sessionUpdated: batch.sessionUpdated,
      });

      for (const item of obsItems) {
        deleteQueueItem(deps.db, item.seq);
      }
      for (const item of turnStopItems) {
        deleteQueueItem(deps.db, item.seq);
      }
    } catch (error) {
      for (const item of obsItems) {
        releaseQueueClaim(deps.db, item.seq);
      }
      for (const item of turnStopItems) {
        releaseQueueClaim(deps.db, item.seq);
      }
      if (batch.sessionUpdated) {
        state.nextBatchNeedsSessionContext = hasPriorSessionSummary(state.sessionDbId);
      }
      state.batchQueue.shift();
      throw error;
    }

    state.batchQueue.shift();
    refreshPendingSessionContextFlag(state);
  }

  async function flushAllBatchesLocked(state: SessionState): Promise<void> {
    while (true) {
      pruneBatchQueueLocked(state);
      if (state.batchQueue.length === 0) {
        return;
      }
      await flushOneBatchLocked(state);
    }
  }

  async function enqueueCompletedTurnLocked(
    state: SessionState,
    turnPayload: TurnPayload,
  ): Promise<void> {
    refreshPendingSessionContextFlag(state);
    const lastBatch = state.batchQueue[state.batchQueue.length - 1];
    let targetBatch = lastBatch;
    let createdBatch = false;

    if (
      !lastBatch ||
      lastBatch.size + turnPayload.size >= config.mergeThresholdChars
    ) {
      targetBatch = {
        turns: [],
        size: 0,
        sessionUpdated: false,
        oldestTurnEpoch: turnPayload.turnStopItem.enqueuedAtEpoch,
      };
      state.batchQueue.push(targetBatch);
      createdBatch = true;
    }

    targetBatch.turns.push(turnPayload);
    targetBatch.size += turnPayload.size;
    const assignedSessionUpdated =
      !targetBatch.sessionUpdated && state.nextBatchNeedsSessionContext;
    if (assignedSessionUpdated) {
      targetBatch.sessionUpdated = true;
      state.nextBatchNeedsSessionContext = false;
    }

    try {
      if (state.batchQueue.length > config.maxQueuedBatches) {
        await flushOneBatchLocked(state);
      }
    } catch (error) {
      for (const batch of state.batchQueue) {
        releaseBatchClaims(batch);
      }
      state.batchQueue = [];
      if (assignedSessionUpdated) {
        state.nextBatchNeedsSessionContext = hasPriorSessionSummary(state.sessionDbId);
      }
      throw error;
    }
  }

  async function processTurnStopLocked(
    state: SessionState,
    turnStopItem: PendingQueueItem,
  ): Promise<void> {
    const turn = getTurnById(deps.db, turnStopItem.targetId);
    if (!turn || turn.status === "undone") {
      deleteQueueItem(deps.db, turnStopItem.seq);
      return;
    }

    const obsItems = collectTurnObsItemsLocked(state.sessionDbId, turn.id);
    try {
      const turnPayload = buildTurnPayloadImpl(turn.id, obsItems, turnStopItem);
      if (!turnPayload) {
        for (const item of obsItems) {
          deleteQueueItem(deps.db, item.seq);
        }
        deleteQueueItem(deps.db, turnStopItem.seq);
        return;
      }

      await enqueueCompletedTurnLocked(state, turnPayload);
    } catch (error) {
      for (const item of obsItems) {
        releaseQueueClaim(deps.db, item.seq);
      }
      releaseQueueClaim(deps.db, turnStopItem.seq);
      for (const item of obsItems) {
        getOrCreateBuffer(state.sessionDbId).items.push(item);
      }
      throw error;
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

      if (item.kind === "obs") {
        getOrCreateBuffer(item.sessionDbId).items.push(item);
        continue;
      }

      const bufferedSeqs = [
        item.seq,
        ...((buffers.get(item.sessionDbId)?.items ?? []).map(
          (bufferedItem) => bufferedItem.seq,
        )),
      ];
      try {
        await withSessionProcessingLock(item.sessionDbId, async (state) => {
          await processTurnStopLocked(state, item);
        });
      } catch (error) {
        for (const seq of bufferedSeqs) {
          skippedSeqs.add(seq);
        }
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
      try {
        await withSessionProcessingLock(sessionDbId, async (state) => {
          await flushAllBatchesLocked(state);
        });
      } catch (error) {
        logger.error?.("drainSessionCompletely failed to flush buffer", {
          sessionDbId,
          error,
        });
      }

      await scanAndDrainQueue(sessionDbId);

      try {
        await withSessionProcessingLock(sessionDbId, async (state) => {
          await flushAllBatchesLocked(state);
        });
      } catch (error) {
        logger.error?.("drainSessionCompletely failed to flush buffer", {
          sessionDbId,
          error,
        });
      }

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

  async function flushSession(sessionDbId: number): Promise<void> {
    await scanAndDrainQueue(sessionDbId);
    await withSessionProcessingLock(sessionDbId, async (state) => {
      await flushAllBatchesLocked(state);
    });
  }

  async function tickKeepaliveSessionLocked(
    state: SessionState,
    currentMs: number,
  ): Promise<void> {
    pruneBatchQueueLocked(state);
    if (state.batchQueue.length === 0 || state.lastPushAt <= 0) {
      return;
    }

    const age = currentMs - state.lastPushAt;
    const triggerAt = state.cacheTtlMs - config.keepaliveLeadMs;
    if (age < triggerAt || age >= state.cacheTtlMs) {
      return;
    }

    if (state.lastPushAt > state.lastMessageAt) {
      return;
    }

    await flushOneBatchLocked(state);
  }

  async function tryKeepaliveSession(
    sessionDbId: number,
    currentMs: number,
  ): Promise<void> {
    if (compactingSessions.has(sessionDbId)) {
      return;
    }

    const existingState = sessions.get(sessionDbId);
    if (!existingState || existingState.lastPushAt <= 0) {
      return;
    }

    const age = currentMs - existingState.lastPushAt;
    const triggerAt = existingState.cacheTtlMs - config.keepaliveLeadMs;
    if (age < triggerAt || age >= existingState.cacheTtlMs) {
      return;
    }

    if (existingState.lastPushAt > existingState.lastMessageAt) {
      return;
    }

    await withSessionProcessingLock(sessionDbId, async (state) => {
      await tickKeepaliveSessionLocked(state, currentMs);
    });
  }

  function recoverFromCrash(): void {
    buffers.clear();
    resetClaimedQueueItems(deps.db);
  }

  async function handleCompact(
    sessionDbId: number,
    transcriptPath?: string | null,
  ): Promise<void> {
    compactingSessions.add(sessionDbId);

    try {
      if (transcriptPath) {
        detectAndCleanSubagentTurns(
          deps.db,
          sessionDbId,
          transcriptPath,
          now(),
        );
      }

      try {
        updateCompactAnchor(deps.db, sessionDbId);
      } catch (error) {
        logger.error?.("updateCompactAnchor failed during compact", {
          sessionDbId,
          error,
        });
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

      try {
        const state = sessions.get(sessionDbId);
        if (state?.querySession) {
          await state.querySession.compact?.();
        }
      } catch (error) {
        logger.error?.("mnemosyne compact failed", {
          sessionDbId,
          error,
        });
      }
    } finally {
      compactingSessions.delete(sessionDbId);
      const state = sessions.get(sessionDbId);
      if (state) {
        state.lastPushAt = 0;
        state.lastInjectedSummaryEpoch = 0;
        state.nextBatchNeedsSessionContext = hasPriorSessionSummary(sessionDbId);
      }
    }
  }

  return {
    sessions,
    buffers,
    compactingSessions,
    recoverFromCrash,
    scanAndDrainQueue,
    processClaimedItem,
    flushSession,
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

          if (compactingSessions.has(state.sessionDbId)) {
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
    async runKeepaliveTick(nowMsOverride?: number): Promise<void> {
      const currentMs = nowMsOverride ?? nowMs();
      for (const sessionDbId of sessions.keys()) {
        await tryKeepaliveSession(sessionDbId, currentMs);
      }
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
  const runtimeDb = deps.db ?? createDatabase();
  const runtimeProcessors =
    deps.scanAndDrainQueue ||
    deps.handleFlushImpl ||
    deps.handleCompactImpl ||
    deps.recoverFromCrashImpl
      ? undefined
      : createWorkerProcessors(runtimeDb);
  const runtime =
    deps.scanAndDrainQueue ||
    deps.handleFlushImpl ||
    deps.handleCompactImpl ||
    deps.recoverFromCrashImpl
      ? undefined
      : createWorkerCore({
          db: runtimeDb,
          now: deps.now,
          nowMs: deps.nowMs,
          config: deps.config,
          buildTurnPayloadImpl:
            deps.buildTurnPayloadImpl ?? runtimeProcessors?.buildTurnPayload,
          processBatchImpl:
            deps.processBatchImpl ?? runtimeProcessors?.processBatch,
          pushSessionSummaryPromptImpl:
            deps.pushSessionSummaryPromptImpl ??
            runtimeProcessors?.pushSessionSummaryPrompt,
          closeSessionQueryImpl: deps.closeSessionQueryImpl,
          createWorkerQuerySessionImpl: deps.createWorkerQuerySessionImpl,
          isProcessAliveImpl: deps.isProcessAliveImpl,
        });

  const scanAndDrainQueue =
    deps.scanAndDrainQueue ?? runtime?.scanAndDrainQueue ?? defaultNoopDrain;
  const handleFlushImpl =
    deps.handleFlushImpl ??
    runtime?.flushSession ??
    (async (sessionId: number) => {
      await scanAndDrainQueue(sessionId);
    });
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
        return new Response(
          JSON.stringify({ ok: true, buildId: BUILD_ID, pid: process.pid }),
          {
          status: 200,
          headers: { "content-type": "application/json" },
          },
        );
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

        void handleCompactImpl(payload.session_id, payload.transcript_path).catch((error) => {
          deps.logger?.error?.("compact request failed", {
            sessionId: payload.session_id,
            error,
          });
        });
        return new Response(null, { status: 200 });
      }

      if (req.method === "POST" && url.pathname === "/flush") {
        const payload = (await req.json()) as {
          session_id?: number;
        };

        if (typeof payload.session_id !== "number") {
          return new Response("session_id is required", { status: 400 });
        }

        void handleFlushImpl(payload.session_id).catch((error) => {
          deps.logger?.error?.("flush request failed", {
            sessionId: payload.session_id,
            error,
          });
        });
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
  const env = deps.env ?? process.env;
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
  const config = deps.config ?? loadConfig();

  initializeDatabase(db);
  const processors = createWorkerProcessors(db);

  const core = createWorkerCore({
    db,
    now: deps.now,
    nowMs: deps.nowMs,
    config,
    buildTurnPayloadImpl: deps.buildTurnPayloadImpl ?? processors.buildTurnPayload,
    processBatchImpl: deps.processBatchImpl ?? processors.processBatch,
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
          config,
          scanAndDrainQueue: core.scanAndDrainQueue,
          handleFlushImpl: core.flushSession,
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

  const startupFlushSessionId = getStartupFlushSessionId(env);
  if (startupFlushSessionId !== null) {
    void (async () => {
      try {
        await core.flushSession(startupFlushSessionId);
      } finally {
        await core.scanAndDrainQueue();
      }
    })();
  } else {
    void core.scanAndDrainQueue();
  }
  setInterval(() => {
    void core.abortStalledSessions();
    void core.runKeepaliveTick();
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
