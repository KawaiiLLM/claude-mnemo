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
import { createDiaryStateStore } from "../db/diary-state";
import { contentDateAt } from "../diary/calendar";
import {
  getSession,
  updateCompactAnchor,
  updateLastAgentSessionId,
} from "../db/sessions";
import {
  getObservation,
  hasSkippedObservationsForTurn,
} from "../db/observations";
import { getMaxPromptNumber, getTurnById, updateTurnById } from "../db/turns";
import {
  parseReplayTranscript,
  readLatestContextTokens,
} from "../shared/transcript-parser";
import {
  claimNextItem,
  countQueueItemsForSession,
  deleteQueueItem,
  releaseQueueClaim,
  resetClaimedQueueItems,
  resetClaimedQueueItemsForSession,
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
import { createLogger } from "../shared/logger";
import {
  flagDeliveryDropped,
  getReminderItems,
  getSilencedReminderItems,
  markReminderItemsNotified,
  type ReminderItem,
} from "./invalidation";
import {
  detectAndCleanSubagentTurns,
  getPendingSubagentTurns,
  markSubagentTurnsNotified,
} from "./subagent-filter";
import { detectCacheTtl } from "./cache-ttl";
import {
  buildBatchPrompt,
  createWorkerProcessors,
  FINAL_SLICE_OVERHEAD,
  renderMiniTurn,
  STALE_TURN_THRESHOLD,
  STREAMING_SLICE_OVERHEAD,
  type MiniTurnPayload,
} from "./processors";
import {
  createWorkerQuerySession,
  type WorkerQuerySession,
} from "./query-session";
import {
  buildCorrectiveResend,
  classifyWorkUnitResponse,
  deriveRequiredTargetIds,
  type WorkUnitShape,
} from "./derailment";
import { createDiaryRuntime } from "./diary-runtime";
import { renderCurrentSessionOutput } from "../mcp/session-output";
import { buildSessionSummary, recallMemory } from "../mcp/recall";
import {
  classifyWorkerError,
  createWorkerAbortError,
} from "./error-classifier";

const WORKER_PORT = 37778;
const STARTING_STALE_MS = 10_000;
const WATCHDOG_INTERVAL_MS = 10_000;
const STALLED_QUERY_MS = 30_000;
const CONNECTION_RETRY_BACKOFF_MS = 10_000;
const IDLE_QUERY_SESSION_MS = 30 * 60 * 1000;
const IDLE_WORKER_HTTP_MS = 30 * 60 * 1000;
const OBS_TIMEOUT_MS = 15_000;
const TURN_STOP_TIMEOUT_MS = 30_000;
// Memory agent runs on claude-sonnet-5 (1M window). Used to turn
// config.compactContextRatio into an absolute token gate for /compact.
const AGENT_CONTEXT_WINDOW_TOKENS = 1_000_000;
// Hard ceiling on the /compact trigger. Even with the 1M window we keep each
// memory-agent turn lean by compacting no later than 100K context, so the gate
// is min(window * ratio, this). With the 1M window this cap governs for every
// in-range ratio (0.1..0.95 → 100K..950K), pinning the effective trigger at
// 100K; the ratio only re-engages if the window is set below 200K.
const AGENT_COMPACT_MAX_TOKENS = 100_000;

export interface QueueDrain {
  (sessionFilter?: number): Promise<void>;
}

export interface BufferState {
  items: PendingQueueItem[];
}

// A flush unit = one outgoing message (D6). The discriminant pins the two
// shapes at the type level: "merged" carries multiple short-turn mini-turns
// that may be merged up to mergeThresholdChars; "slice" carries exactly one
// mini-turn (streaming or final) from a turn that has streamed, never merged.
type BatchEntry =
  | {
      kind: "merged";
      miniTurns: MiniTurnPayload[];
      attempts: number;
      sessionUpdated: boolean;
      size: number;
      oldestTurnEpoch: number;
    }
  | {
      kind: "slice";
      miniTurn: MiniTurnPayload;
      attempts: number;
      sessionUpdated: boolean;
      size: number;
      oldestTurnEpoch: number;
    };

function batchMiniTurns(batch: BatchEntry): MiniTurnPayload[] {
  return batch.kind === "merged" ? batch.miniTurns : [batch.miniTurn];
}

// The minimal {turnId}-only shape the derailment module needs for one flush
// unit (D1 required-id derivation + D5 floor granularity). Merged → all turn
// ids; any slice (streaming mid / final) → its single turn id.
function batchWorkUnitShape(batch: BatchEntry): WorkUnitShape {
  if (batch.kind === "merged") {
    return {
      kind: "merged",
      miniTurns: batch.miniTurns.map((miniTurn) => ({ turnId: miniTurn.turnId })),
    };
  }
  return { kind: "slice", miniTurn: { turnId: batch.miniTurn.turnId } };
}

// A flush unit is a completion point (eligible for T3 re-session + the D5
// floor) unless it is a streaming mid slice (a later/final slice still carries
// the turn). A merged batch is always short turns (completion points).
function batchIsCompletionPoint(batch: BatchEntry): boolean {
  return !(batch.kind === "slice" && batch.miniTurn.role === "streaming");
}

// Result state machine (D8) — flushOneBatchLocked never throws for control flow.
type FlushOutcome =
  | "flushed"
  | "retryLater"
  | "suspended"
  | "dropped"
  | "empty";

// Thrown by sendWorkUnit when a completion-point unit still fails to extract
// after K corrective resends AND a fresh-session cold-start retry (the
// derailment floor). The caller (Task 10) decides the drop/flag side effects.
export class DerailmentFloorError extends Error {
  constructor(public requiredIds: Set<number>) {
    super("derailment floor");
    this.name = "DerailmentFloorError";
  }
}

export interface SessionState {
  sessionDbId: number;
  querySession: WorkerQuerySession | null;
  contentSessionId: string | null;
  project: string | null;
  batchQueue: BatchEntry[];
  // turnId -> next streaming partIndex. Presence means the turn has streamed
  // at least one slice this process lifetime (D2/D6). Lost on restart; the
  // turn-stop role decision also consults turn.status as a durable signal.
  streamedParts: Map<number, number>;
  cacheTtlMs: number;
  lastInjectedSummaryEpoch?: number;
  nextBatchNeedsSessionContext: boolean;
  lastPushAt: number;
  lastMessageAt: number;
  lastActivity: number;
  queryPid?: number;
  agentSessionId?: string;
  // Set by the onCompactBoundary callback when the SDK auto-compacts the agent
  // mid-stream (no explicit compact() awaiting). Re-prime can't be injected
  // mid-stream, so the next work unit re-primes before its turn batch, then
  // clears this flag. The worker-driven compact path re-primes synchronously and
  // never sets this (see handleCompact / query-session compact_boundary gating).
  needsReprime?: boolean;
  processingLock: Promise<void>;
  closing?: Promise<void>;
  pushMessage: (prompt: string) => Promise<void>;
  // Transient per-work-unit signal accumulation (one outgoing message → its
  // result). Reset before each unit and after a cold-start (D1). The SDK
  // onMessage stream populates these; sendWorkUnit reads them to classify.
  unitSignals: {
    rememberedIds: Set<number>;
    rememberedSessionIds: Set<number>;
    hadSubstantiveText: boolean;
    hadIllegalTool: boolean;
  };
}

// Clear the transient per-work-unit signals between units (and after a
// cold-start render, which is exempt from derailment detection).
function resetUnitSignals(state: SessionState): void {
  state.unitSignals.rememberedIds.clear();
  state.unitSignals.rememberedSessionIds.clear();
  state.unitSignals.hadSubstantiveText = false;
  state.unitSignals.hadIllegalTool = false;
}

export interface WorkerCoreDeps {
  db: Database;
  now?: () => number;
  nowMs?: () => number;
  processDiaryItem?: (item: PendingQueueItem) => Promise<void>;
  setTimeoutImpl?: (
    callback: () => void | Promise<void>,
    delayMs: number,
  ) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
  pushSessionSummaryPromptImpl?: (
    state: SessionState,
    sessionId: number,
    // Optional sender so the standalone <session> summary can be routed through
    // the derailment state machine (D1/T2/T3). Defaults to state.pushMessage.
    send?: (message: string) => Promise<void>,
  ) => Promise<void>;
  closeSessionQueryImpl?: (sessionId: number) => Promise<void>;
  createWorkerQuerySessionImpl?: typeof createWorkerQuerySession;
  isProcessAliveImpl?: typeof isProcessAlive;
  /** Live context size (tokens) of the memory agent, by agent session id. */
  readAgentContextTokensImpl?: (agentSessionId: string) => number | null;
  logger?: Pick<Console, "warn" | "error">;
  config?: MnemoConfig;
}

export interface WorkerServerDeps extends Partial<WorkerCoreDeps> {
  dataRoot?: string;
  createDiaryRuntimeImpl?: typeof createDiaryRuntime;
  BunServeImpl?: typeof Bun.serve;
  scanAndDrainQueue?: QueueDrain;
  handleFlushImpl?: (sessionId: number) => Promise<void>;
  handleCompactImpl?: (
    sessionId: number,
    transcriptPath?: string | null,
  ) => Promise<void>;
  handleDreamImpl?: (date: unknown) => ManualDreamResult;
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

/**
 * Result of a manual `POST /dream` trigger: either enqueued, or rejected with an
 * HTTP status the fetch handler can echo verbatim.
 */
export type ManualDreamResult =
  | { ok: true; date: string }
  | { ok: false; status: number; message: string };

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
  triggerManualDream(date: unknown): ManualDreamResult;
  abortStalledSessions(nowMs?: number): Promise<void>;
  runKeepaliveTick(nowMs?: number): Promise<void>;
  runRetryTick(nowMs?: number): Promise<void>;
  // D1/T2/T3 derailment state machine. Task 10 wires the flush callers to it;
  // exposed here so it can be unit-tested in isolation.
  sendWorkUnit(
    state: SessionState,
    message: string,
    requiredIds: Set<number>,
    isCompletionPoint: boolean,
  ): Promise<void>;
  reopenQuerySessionFresh(state: SessionState): Promise<void>;
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

function buildSubagentInvalidationEnvelope(turnIds: number[]): string {
  // DB turn ids — consistent with the <turn id="T..."> blocks the agent matches
  // these against.
  const labels = turnIds.map((turnId) => `T${turnId}`).join(", ");
  return `<subagent_invalidated>
  ${labels} originated from a Task subagent transcript and are out-of-scope
  for session memory.
</subagent_invalidated>`;
}

// Pure line grammar over resolved reason hits — never names a concrete reason.
// Each reason on a turn contributes its own render fragments (flagToken /
// parenExtra / bodyLead / tail); this function only assembles them (D0).
export function buildReminderEnvelope(
  items: ReadonlyArray<ReminderItem>,
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
    const flags = item.reasons.map((reason) => reason.flagToken).join("+");
    const parenExtras = item.reasons
      .map((reason) => reason.parenExtra)
      .filter((extra): extra is string => extra !== null);
    const parenInner = [flags, ...parenExtras].join(", ");

    const leadParts: string[] = [];
    if (item.priorTitle) {
      leadParts.push(`"${item.priorTitle}"`);
    }
    for (const reason of item.reasons) {
      if (reason.bodyLead) {
        leadParts.push(reason.bodyLead);
      }
    }

    const reasonTails = item.reasons
      .map((reason) => reason.tail)
      .filter((tail): tail is string => tail !== null);
    const truncatedContent = truncateReminderContent(item.priorContent);
    const tailParts =
      reasonTails.length > 0
        ? reasonTails
        : truncatedContent
          ? [truncatedContent]
          : [];

    const bodyParts = [...leadParts, ...tailParts];
    const bodyClause = bodyParts.length > 0 ? `: ${bodyParts.join(" -- ")}` : "";
    // DB turn id — the same id the agent sees in <turn id="T..."> blocks and
    // passes to remember()/recall(), so the reminder is actionable in sessions
    // where prompt_number and DB id diverge (adopted/gapped sessions).
    return `  - T${item.turnId} (${parenInner})${bodyClause}`;
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
  const setTimeoutImpl =
    deps.setTimeoutImpl ??
    ((callback: () => void | Promise<void>, delayMs: number): unknown =>
      setTimeout(() => void callback(), delayMs));
  const clearTimeoutImpl =
    deps.clearTimeoutImpl ??
    ((handle: unknown): void =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));
  const logger = deps.logger ?? console;
  const config = deps.config ?? DEFAULT_CONFIG;
  const sessions = new Map<number, SessionState>();
  const buffers = new Map<number, BufferState>();
  const compactingSessions = new Set<number>();
  const suspendedUntilBySession = new Map<number, number>();
  const diaryStateStore = createDiaryStateStore(deps.db);
  let persistentRetryTimer: { handle: unknown; dueEpoch: number } | null = null;
  let diaryContinuationTimer: unknown | null = null;
  let globalScanInFlight: Promise<void> | null = null;
  const createWorkerQuerySessionImpl =
    deps.createWorkerQuerySessionImpl ?? createWorkerQuerySession;
  const isProcessAliveImpl = deps.isProcessAliveImpl ?? isProcessAlive;
  const readAgentContextTokensImpl =
    deps.readAgentContextTokensImpl ??
    ((agentSessionId: string) =>
      readLatestContextTokens(resolveTranscriptPath(DATA_DIR, agentSessionId)));

  const processors = createWorkerProcessors(deps.db);
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
      (session.nextSteps ?? "") !== "" ||
      (session.decision ?? "") !== "" ||
      (session.done ?? "") !== "" ||
      (session.current ?? "") !== "" ||
      (session.reference ?? "") !== ""
    );
  }

  // D5: how many extracted turns have landed since the summary was last
  // refreshed. baseline uses COALESCE so a never-refreshed summary (NULL epoch)
  // measures against session creation instead of comparing against NULL (which
  // would make the > comparison always false and never flag staleness).
  function countTurnsSinceSummary(sessionId: number): number {
    const row = deps.db
      .query<{ n: number }, [number, number]>(
        `SELECT COUNT(*) AS n
         FROM turns
         WHERE session_id = ?
           AND status = 'extracted'
           AND updated_at_epoch > (
             SELECT COALESCE(summary_updated_at_epoch, created_at_epoch, 0)
             FROM sessions WHERE id = ?
           )`,
      )
      .get(sessionId, sessionId);

    return row?.n ?? 0;
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

    // Skip if a queued batch already carries session context — avoid stacking.
    if (state.batchQueue.some((batch) => batch.sessionUpdated)) {
      return;
    }

    const summaryEpoch = session.summaryUpdatedAtEpoch ?? 0;
    if (summaryEpoch > (state.lastInjectedSummaryEpoch ?? 0)) {
      // Summary was refreshed elsewhere — show the agent the new summary.
      state.nextBatchNeedsSessionContext = hasPriorSessionSummary(state.sessionDbId);
      return;
    }

    // D5: summary fell behind by >= threshold extracted turns. Nudge a full
    // refresh even when no summary exists yet (a long pre-compact session).
    if (countTurnsSinceSummary(state.sessionDbId) >= STALE_TURN_THRESHOLD) {
      state.nextBatchNeedsSessionContext = true;
    }
  }

  function recalculateBatchSize(batch: BatchEntry): void {
    batch.size = batchMiniTurns(batch).reduce(
      (total, miniTurn) => total + miniTurn.size,
      0,
    );
  }

  function releaseBatchClaims(batch: BatchEntry): void {
    for (const miniTurn of batchMiniTurns(batch)) {
      for (const item of miniTurn.obsItems) {
        releaseQueueClaim(deps.db, item.seq);
      }
      if (miniTurn.turnStopItem) {
        releaseQueueClaim(deps.db, miniTurn.turnStopItem.seq);
      }
    }
  }

  function deleteMiniTurnQueueItems(miniTurn: MiniTurnPayload): void {
    for (const item of miniTurn.obsItems) {
      deleteQueueItem(deps.db, item.seq);
    }
    if (miniTurn.turnStopItem) {
      deleteQueueItem(deps.db, miniTurn.turnStopItem.seq);
    }
  }

  // Assign the pending session-context flag to a batch (at most one batch
  // carries it). Returns whether it was assigned, so the caller can restore it
  // if the batch is later dropped (D6).
  function assignSessionContextLocked(
    state: SessionState,
    batch: BatchEntry,
  ): boolean {
    if (!batch.sessionUpdated && state.nextBatchNeedsSessionContext) {
      batch.sessionUpdated = true;
      state.nextBatchNeedsSessionContext = false;
      return true;
    }
    return false;
  }

  // A turn's streaming state is done once its final slice leaves the queue.
  function clearStreamedPartsForBatch(
    state: SessionState,
    batch: BatchEntry,
  ): void {
    for (const miniTurn of batchMiniTurns(batch)) {
      if (miniTurn.isFinal) {
        state.streamedParts.delete(miniTurn.turnId);
      }
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
      if (batch.kind === "slice") {
        const turn = getTurnById(deps.db, batch.miniTurn.turnId);
        if (!turn || turn.status === "undone") {
          deleteMiniTurnQueueItems(batch.miniTurn);
          continue;
        }
        nextQueue.push(batch);
        continue;
      }

      const keptMiniTurns = batch.miniTurns.filter((miniTurn) => {
        const turn = getTurnById(deps.db, miniTurn.turnId);
        if (!turn || turn.status === "undone") {
          deleteMiniTurnQueueItems(miniTurn);
          return false;
        }
        return true;
      });

      if (keptMiniTurns.length === 0) {
        continue;
      }

      const nextBatch: BatchEntry = {
        ...batch,
        miniTurns: keptMiniTurns,
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
      streamedParts: new Map<number, number>(),
      cacheTtlMs: 300_000,
      lastInjectedSummaryEpoch: 0,
      nextBatchNeedsSessionContext: hasPriorSessionSummary(sessionDbId),
      lastPushAt: 0,
      lastMessageAt: 0,
      lastActivity: nowMs(),
      processingLock: Promise.resolve(),
      unitSignals: {
        rememberedIds: new Set<number>(),
        rememberedSessionIds: new Set<number>(),
        hadSubstantiveText: false,
        hadIllegalTool: false,
      },
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
              pendingSubagentTurns.map((turn) => turn.id),
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

  // forceFresh (T3): build a brand-new query that NEVER resumes the (poisoned)
  // agent transcript and does NOT seed state.agentSessionId from the persisted
  // lastAgentSessionId — the caller re-cold-starts the worker on it.
  function ensureQuerySession(
    state: SessionState,
    options: { forceFresh?: boolean } = {},
  ): WorkerQuerySession {
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
    if (!options.forceFresh && session.lastAgentSessionId) {
      state.agentSessionId = session.lastAgentSessionId;
    }
    state.querySession = createWorkerQuerySessionImpl(
      {
        db: deps.db,
        sessionDbId: state.sessionDbId,
        contentSessionId: session.contentSessionId,
        project: session.project,
        config,
        resumeAgentSessionId: options.forceFresh
          ? null
          : session.lastAgentSessionId,
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
          // D1 signal accumulation: inspect assistant content blocks for this
          // work unit. thinking blocks are ignored; substantive text and any
          // non-mnemo tool_use are strikes.
          if (
            message.type === "assistant" &&
            Array.isArray((message as { message?: { content?: unknown } }).message?.content)
          ) {
            const content = (
              message as { message: { content: Array<Record<string, unknown>> } }
            ).message.content;
            for (const block of content) {
              if (
                block.type === "text" &&
                typeof block.text === "string" &&
                block.text.trim().length > 0
              ) {
                state!.unitSignals.hadSubstantiveText = true;
              } else if (
                block.type === "tool_use" &&
                typeof block.name === "string" &&
                block.name !== "mcp__mnemo__remember" &&
                block.name !== "mcp__mnemo__recall"
              ) {
                state!.unitSignals.hadIllegalTool = true;
              }
            }
          }
        },
        onPid: (pid) => {
          state!.queryPid = pid;
        },
        // SDK-auto compact: an unsolicited compact_boundary wiped the agent's
        // history. Re-prime can't be injected mid-stream, so flag it; the next
        // work unit re-primes before its turn batch and clears the flag.
        onCompactBoundary: () => {
          state!.needsReprime = true;
        },
        onRemember: (id: string) => {
          const t = /^T(\d+)$/i.exec(id);
          if (t) {
            state!.unitSignals.rememberedIds.add(Number(t[1]));
            return;
          }
          const sMatch = /^S(\d+)$/i.exec(id);
          if (sMatch) {
            state!.unitSignals.rememberedSessionIds.add(Number(sMatch[1]));
          }
        },
      },
    );

    return state.querySession;
  }

  function ensureQuerySessionFresh(state: SessionState): WorkerQuerySession {
    return ensureQuerySession(state, { forceFresh: true });
  }

  // Recall-style, collapsed index of the session's most recent (≤30) turns,
  // rendered in the WORKER DB-id space (`dbid:T<dbid>` per line). The agent
  // cites turns by DB id, so the re-prime must hand it citable ids for recent
  // turns it can no longer see in its (compacted) history. Empty string when the
  // session has no turns yet.
  function buildRecentTurnIndex(sessionDbId: number): string {
    const maxPromptNumber = getMaxPromptNumber(deps.db, sessionDbId);
    if (maxPromptNumber === null) {
      return "";
    }
    const lo = Math.max(1, maxPromptNumber - 29);
    try {
      return recallMemory(deps.db, {
        id: `S${sessionDbId}/T${lo}..${maxPromptNumber}`,
        depth: "collapsed",
        // pageSize must cover the whole window so all 30 turns render in one page.
        pageSize: 30,
        includeDbTurnIds: true,
      });
    } catch {
      // Re-prime must stay resilient even if the recent-turn index fails to
      // render; the structured summary digest below is the primary payload.
      return "";
    }
  }

  // Re-cold-start the (existing) query session with the shared SessionStart
  // render so a freshly-compacted / reopened agent regains the session's
  // structured state, plus a recent-turn DB-id index it can cite. The re-prime
  // response is exempt from derailment detection. Used by both the derailment
  // reopen and the post-compact (worker-driven + SDK-auto) re-prime paths.
  async function sendSessionReprime(state: SessionState): Promise<void> {
    const runtime = ensureQuerySession(state);
    const formatted = buildSessionSummary(deps.db, state.sessionDbId);
    const session = getSession(deps.db, state.sessionDbId);
    if (formatted && session) {
      const coldStart = renderCurrentSessionOutput(deps.db, formatted, session);
      const recentIndex = buildRecentTurnIndex(state.sessionDbId);
      const body = recentIndex
        ? `${coldStart}\n\nMost recent turns (cite by DB id):\n${recentIndex}`
        : coldStart;
      resetUnitSignals(state);
      await runtime.sendPrompt(
        `<context note="Session so far. CONTEXT ONLY — do not remember anything from this message; await the next message.">\n${body}\n</context>`,
      );
    }
    resetUnitSignals(state); // re-prime response is exempt from detection
  }

  // Tear down the current (poisoned) query and bring up a brand-new one that
  // never resumes the old transcript (T3). Re-cold-start it with the shared
  // SessionStart render so the fresh agent has the session's structured state;
  // the cold-start response is exempt from derailment detection.
  async function reopenQuerySessionFresh(state: SessionState): Promise<void> {
    try {
      await state.querySession?.close();
    } catch {
      /* best-effort */
    }
    state.querySession = null;
    state.agentSessionId = undefined;
    ensureQuerySessionFresh(state);
    await sendSessionReprime(state);
  }

  const MAX_REMINDERS = 2; // K

  // D1/T2/T3 work-unit state machine. Sends `message`, classifies the agent's
  // response against `requiredIds`, and on a strike escalates: up to K
  // corrective resends (T2), then — only at a completion point — one fresh
  // session + cold start (T3); if that still fails, throw DerailmentFloorError.
  // A streaming mid slice (isCompletionPoint=false) is skipped after the
  // resends with no re-session and no floor.
  async function sendWorkUnit(
    state: SessionState,
    message: string,
    requiredIds: Set<number>,
    isCompletionPoint: boolean,
  ): Promise<void> {
    const evaluate = () =>
      classifyWorkUnitResponse({
        requiredIds,
        rememberedIds: state.unitSignals.rememberedIds,
        rememberedSessionIds: state.unitSignals.rememberedSessionIds,
        sessionDbId: state.sessionDbId,
        hadSubstantiveText: state.unitSignals.hadSubstantiveText,
        hadIllegalTool: state.unitSignals.hadIllegalTool,
      });

    // Only a standalone session summary has an empty required set; its
    // corrective resend must point the agent at the session route (re-supply
    // all summary fields), never remember({status:"skipped"}) (turn-only).
    const resendKind = requiredIds.size === 0 ? "session-summary" : "turn";

    resetUnitSignals(state);
    await state.pushMessage(message);
    if (evaluate() === "resolved") {
      return;
    }

    for (let i = 0; i < MAX_REMINDERS; i++) {
      resetUnitSignals(state);
      await state.pushMessage(buildCorrectiveResend(message, resendKind));
      if (evaluate() === "resolved") {
        return;
      }
    }

    // Streaming mid slice: skip the slice, leave the turn row as-is, continue.
    // No re-session, no floor (a later slice / the final slice carries the turn).
    if (!isCompletionPoint) {
      logger.warn?.("derailment: skipping mid slice after reminders", {
        sessionDbId: state.sessionDbId,
        requiredIds: [...requiredIds],
      });
      return;
    }

    // T3 (completion points only): fresh session + cold start, reprocess once.
    await reopenQuerySessionFresh(state);
    resetUnitSignals(state);
    await state.pushMessage(buildCorrectiveResend(message, resendKind));
    if (evaluate() === "resolved") {
      return;
    }

    throw new DerailmentFloorError(requiredIds);
  }

  // D5 finalize-by-content. Reached only when a completion-point unit hits the
  // derailment floor. A turn's record is built incrementally; finalize each
  // unresolved turn TERMINALLY by whether it carries usable content, so a turn
  // never lingers non-terminal (active/provisional) — otherwise getStrandedTurns
  // re-enqueues it on every resume and it re-derails forever (no terminal bound):
  //   - has a partial extraction (title or content set, e.g. a provisional turn
  //     a mid-slice wrote) → finalize as `extracted` (keeps the partial);
  //   - content-less (never extracted) → `failed`.
  // A standalone session-summary refresh is abandoned (idempotent; the next
  // compact retries it) with no turn touched.
  function applyFloor(
    unit: WorkUnitShape,
    unresolved: Set<number>,
    sessionDbId: number,
  ): void {
    if (unit.kind === "session-summary") {
      logger.warn?.("derailment floor: abandoning session-summary refresh", {
        sessionDbId,
      });
      return;
    }
    for (const turnId of unresolved) {
      const turn = getTurnById(deps.db, turnId);
      if (!turn) {
        continue;
      }
      // Already-extracted turns are terminal — a real remember already ran;
      // leave them. A partial extraction (title/content set, e.g. a provisional
      // turn a mid-slice wrote) is finalized to extracted, keeping the partial.
      const hasContent = turn.title !== null || turn.content !== null;
      if (turn.status === "extracted" || hasContent) {
        if (turn.status !== "extracted") {
          updateTurnById(deps.db, turnId, { status: "extracted" });
        }
        logger.warn?.(
          "derailment floor: keeping partial extraction (finalized extracted)",
          { turnId },
        );
      } else {
        // Content-less, never extracted (active or empty provisional) → failed.
        updateTurnById(deps.db, turnId, { status: "failed" });
        logger.warn?.("derailment floor: turn failed (no extraction)", {
          turnId,
        });
      }
    }
  }

  async function closeSessionQuery(
    sessionDbId: number,
    abortError?: Error,
  ): Promise<void> {
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
          state.querySession?.close(abortError) ?? Promise.resolve(),
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

  async function suspendSessionAfterConnectionError(
    state: SessionState,
    error: unknown,
  ): Promise<void> {
    const sessionDbId = state.sessionDbId;
    suspendedUntilBySession.set(
      sessionDbId,
      nowMs() + CONNECTION_RETRY_BACKOFF_MS,
    );

    // Per-session crash recovery: every claimed row becomes eligible for a
    // clean rebuild, and no in-memory slice/batch survives the interrupted
    // request. The durable turn/observation rows remain untouched.
    resetClaimedQueueItemsForSession(deps.db, sessionDbId);
    buffers.delete(sessionDbId);
    state.batchQueue = [];
    state.streamedParts.clear();

    logger.warn?.("mini-turn flush suspended after connection failure", {
      sessionDbId,
      retryAfterMs: CONNECTION_RETRY_BACKOFF_MS,
      error,
    });
    await closeSessionQuery(sessionDbId).catch((closeError) => {
      logger.error?.("connection suspension failed to close query session", {
        sessionDbId,
        error: closeError,
      });
    });
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

  // Render a flush unit (one or more mini-turns) and push it as one message.
  // prior_turn is read fresh here (D4) so each slice reflects the latest T
  // record written by earlier slices. Throws on push failure (caller decides
  // retry vs drop).
  async function pushMiniTurnBatch(
    state: SessionState,
    batch: BatchEntry,
  ): Promise<void> {
    const session = getSession(deps.db, state.sessionDbId);
    if (!session) {
      return;
    }

    // SDK-auto re-prime boundary: an unsolicited compact wiped the agent's
    // history since the last work unit. Re-prime now — before this turn batch —
    // so the agent regains the session's structured state + recent-turn DB-id
    // index. Clear the flag only AFTER a successful re-prime so a transient
    // send failure is retried by the next batch; on failure, proceed with this
    // batch anyway so a doomed re-prime never wedges throughput.
    if (state.needsReprime) {
      try {
        await sendSessionReprime(state);
        state.needsReprime = false;
      } catch (error) {
        logger.error?.("session re-prime failed; will retry next batch", {
          sessionDbId: state.sessionDbId,
          error,
        });
      }
    }

    const miniTurns = batchMiniTurns(batch);
    let currentPrompt: string | null = null;
    let latestPromptNumber = Number.NEGATIVE_INFINITY;
    const blocks = miniTurns.map((miniTurn) => {
      let priorTurn = null;
      if (miniTurn.needsPriorTurn) {
        const turn = getTurnById(deps.db, miniTurn.turnId);
        if (turn) {
          priorTurn = {
            title: turn.title,
            content: turn.content,
            insight: turn.insight,
          };
        }
      }
      if (miniTurn.promptNumber > latestPromptNumber) {
        latestPromptNumber = miniTurn.promptNumber;
        currentPrompt = miniTurn.prompt;
      }
      return renderMiniTurn(miniTurn, priorTurn);
    });

    const sessionUpdated = batch.sessionUpdated;
    const staleTurns = sessionUpdated
      ? countTurnsSinceSummary(session.id)
      : 0;
    const message = buildBatchPrompt({
      sessionId: session.id,
      project: session.project,
      sessionTitle: session.title,
      currentPrompt,
      prior: sessionUpdated
        ? {
            title: session.title,
            content: session.content,
            decision: session.decision,
            done: session.done,
            current: session.current,
            nextSteps: session.nextSteps,
            reference: session.reference,
          }
        : null,
      sessionUpdated,
      staleTurns,
      completedTurnBlocks: blocks,
    });
    // Route through the D1/T2/T3 derailment state machine. A DerailmentFloorError
    // (completion point exhausted resends + a fresh-session retry) is resolved
    // by D5 finalize-by-status; any other throw (push/delivery failure) is left
    // to flushOneBatchLocked's retry/drop handling.
    const shape = batchWorkUnitShape(batch);
    try {
      await sendWorkUnit(
        state,
        message,
        deriveRequiredTargetIds(shape),
        batchIsCompletionPoint(batch),
      );
    } catch (e) {
      if (e instanceof DerailmentFloorError) {
        applyFloor(shape, e.requiredIds, state.sessionDbId);
      } else {
        throw e;
      }
    }

    const freshSession = getSession(deps.db, session.id);
    state.lastInjectedSummaryEpoch = freshSession?.summaryUpdatedAtEpoch ?? 0;
  }

  async function flushOneBatchLocked(state: SessionState): Promise<FlushOutcome> {
    pruneBatchQueueLocked(state);
    const batch = state.batchQueue[0];
    if (!batch) {
      return "empty";
    }

    try {
      await pushMiniTurnBatch(state, batch);
    } catch (error) {
      if (classifyWorkerError(error) === "connection") {
        await suspendSessionAfterConnectionError(state, error);
        return "suspended";
      }

      batch.attempts += 1;
      if (batch.attempts < config.maxFlushAttempts) {
        // Keep the batch at the head with its claims; retry tick re-flushes.
        logger.warn?.("mini-turn flush failed, will retry", {
          sessionDbId: state.sessionDbId,
          attempts: batch.attempts,
          error,
        });
        return "retryLater";
      }
      // Dropped: same side effects as a successful flush (so the queue
      // lifecycle is identical) plus a delivery-dropped reminder per turn (D8).
      logger.error?.("mini-turn flush dropped after repeated failures", {
        sessionDbId: state.sessionDbId,
        attempts: batch.attempts,
        error,
      });
      for (const miniTurn of batchMiniTurns(batch)) {
        processors.applyMiniTurnSideEffects(miniTurn);
        flagDeliveryDropped(deps.db, miniTurn.turnId, now());
      }
      if (batch.sessionUpdated) {
        state.nextBatchNeedsSessionContext = hasPriorSessionSummary(state.sessionDbId);
      }
      clearStreamedPartsForBatch(state, batch);
      state.batchQueue.shift();
      return "dropped";
    }

    for (const miniTurn of batchMiniTurns(batch)) {
      processors.applyMiniTurnSideEffects(miniTurn);
    }
    clearStreamedPartsForBatch(state, batch);
    state.batchQueue.shift();
    refreshPendingSessionContextFlag(state);
    return "flushed";
  }

  async function flushAllBatchesLocked(state: SessionState): Promise<void> {
    while (true) {
      pruneBatchQueueLocked(state);
      if (state.batchQueue.length === 0) {
        return;
      }
      const outcome = await flushOneBatchLocked(state);
      // retryLater leaves the blocking batch at the head (FIFO order holds).
      // suspended has already released the session's claims and state. Either
      // outcome stops this drain so it cannot burn attempts in a hot loop.
      if (
        outcome === "retryLater" ||
        outcome === "suspended" ||
        outcome === "empty"
      ) {
        return;
      }
    }
  }

  function enqueueSliceLocked(
    state: SessionState,
    miniTurn: MiniTurnPayload,
    oldestTurnEpoch: number,
  ): void {
    const batch: BatchEntry = {
      kind: "slice",
      miniTurn,
      attempts: 0,
      size: miniTurn.size,
      sessionUpdated: false,
      oldestTurnEpoch,
    };
    assignSessionContextLocked(state, batch);
    state.batchQueue.push(batch);
  }

  // Short turns (never streamed) merge into a trailing "merged" batch up to
  // mergeThresholdChars, exactly as before. A slice batch is never a merge
  // target (slices are solo).
  function enqueueMergedTurnLocked(
    state: SessionState,
    miniTurn: MiniTurnPayload,
  ): void {
    refreshPendingSessionContextFlag(state);
    const lastBatch = state.batchQueue[state.batchQueue.length - 1];
    let targetBatch =
      lastBatch && lastBatch.kind === "merged" ? lastBatch : undefined;

    if (!targetBatch || targetBatch.size + miniTurn.size >= config.mergeThresholdChars) {
      targetBatch = {
        kind: "merged",
        miniTurns: [],
        attempts: 0,
        size: 0,
        sessionUpdated: false,
        oldestTurnEpoch: miniTurn.turnStopItem?.enqueuedAtEpoch ?? now(),
      };
      state.batchQueue.push(targetBatch);
    }

    targetBatch.miniTurns.push(miniTurn);
    targetBatch.size += miniTurn.size;
    assignSessionContextLocked(state, targetBatch);
  }

  // Peel a streaming slice out of the buffer and flush it immediately (D2).
  async function enqueueAndFlushStreamingSliceLocked(
    state: SessionState,
    turnId: number,
    chunk: PendingQueueItem[],
  ): Promise<void> {
    if (chunk.length === 0) {
      return;
    }
    const turn = getTurnById(deps.db, turnId);
    const hadPriorDelivery =
      state.streamedParts.has(turnId) ||
      (turn ? turn.status !== "active" : false) ||
      hasSkippedObservationsForTurn(deps.db, turnId);
    const partIndex = state.streamedParts.get(turnId) ?? 1;
    const miniTurn = processors.buildMiniTurn(turnId, chunk, {
      role: "streaming",
      partIndex,
      needsPriorTurn: hadPriorDelivery,
      turnStopItem: null,
    });
    if (!miniTurn) {
      for (const item of chunk) {
        deleteQueueItem(deps.db, item.seq);
      }
      return;
    }
    state.streamedParts.set(turnId, partIndex + 1);
    enqueueSliceLocked(state, miniTurn, chunk[0]?.enqueuedAtEpoch ?? now());
    await flushAllBatchesLocked(state);
    // Hold the turn `provisional` until the FINAL completion. The mid-slice's
    // remember has already landed by the time the await above resolves (the
    // agent finished responding to this slice's push), so the agent may have
    // promoted the turn active → extracted. Overwrite that with `provisional`:
    // a streamed turn is only authoritative once processTurnStopLocked builds
    // and flushes its FINAL mini-turn (→ extracted / skipped / failed). This is
    // race-free: it runs under the session processing lock, strictly after the
    // synchronous flush has fully resolved, and never touches a short turn
    // (which never enters this function), so role detection at turn-stop still
    // sees a never-streamed turn as `active`. An interruption mid-stream thus
    // leaves the turn `provisional`, which the resume scan re-extracts (D6).
    const heldTurn = getTurnById(deps.db, turnId);
    if (heldTurn && heldTurn.status !== "undone") {
      updateTurnById(deps.db, turnId, { status: "provisional" });
    }
  }

  // Cheap synchronous pre-check (no lock): do buffered obs for this turn cross
  // the streaming threshold? Authoritative re-check happens inside the lock.
  function bufferedTurnObsExceedThreshold(
    sessionDbId: number,
    turnId: number,
  ): boolean {
    const buffer = buffers.get(sessionDbId);
    if (!buffer) {
      return false;
    }
    const turnObs = buffer.items.filter(
      (item) => getObservation(deps.db, item.targetId)?.turnId === turnId,
    );
    if (turnObs.length === 0) {
      return false;
    }
    const threshold = config.maxMiniTurnChars - STREAMING_SLICE_OVERHEAD;
    return processors.peelMiniTurnObs(turnObs, threshold).rest.length > 0;
  }

  // During a turn: once buffered obs for the in-progress turn cross the
  // streaming threshold, peel a chunk and flush it as a streaming slice (D2).
  async function maybeStreamInProgressTurnLocked(
    state: SessionState,
    turnId: number,
  ): Promise<void> {
    pruneInProgressBuffer(state.sessionDbId);
    const buffer = buffers.get(state.sessionDbId);
    if (!buffer) {
      return;
    }
    const turnObs = buffer.items.filter(
      (item) => getObservation(deps.db, item.targetId)?.turnId === turnId,
    );
    if (turnObs.length === 0) {
      return;
    }
    const threshold = config.maxMiniTurnChars - STREAMING_SLICE_OVERHEAD;
    const { chunk, rest } = processors.peelMiniTurnObs(turnObs, threshold);
    if (rest.length === 0) {
      // Buffered obs still fit under the threshold; keep accumulating.
      return;
    }
    const chunkSeqs = new Set(chunk.map((item) => item.seq));
    buffer.items = buffer.items.filter((item) => !chunkSeqs.has(item.seq));
    if (buffer.items.length === 0) {
      buffers.delete(state.sessionDbId);
    }
    await enqueueAndFlushStreamingSliceLocked(state, turnId, chunk);
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

    let obsItems = collectTurnObsItemsLocked(state.sessionDbId, turn.id);
    try {
      // Peel streaming slices until the remaining obs fit a final-slice render.
      // A never-streamed short turn can still overflow once the tail is added,
      // so peeling here is the budget-correctness backstop (D2).
      const finalBudget = config.maxMiniTurnChars - FINAL_SLICE_OVERHEAD;
      while (true) {
        const { chunk, rest } = processors.peelMiniTurnObs(obsItems, finalBudget);
        if (rest.length === 0) {
          obsItems = chunk;
          break;
        }
        await enqueueAndFlushStreamingSliceLocked(state, turn.id, chunk);
        obsItems = rest;
      }

      // hadPriorDelivery decides final-slice vs short-turn. streamedParts is
      // the in-memory signal; turn.status !== "active" and "has skipped obs"
      // are restart-durable. Skipped obs is the strongest: it is set whenever a
      // slice was delivered, even if the agent chose not to remember it, so a
      // restart can't misjudge a streamed turn as a fresh short turn (D6).
      const hadPriorDelivery =
        state.streamedParts.has(turn.id) ||
        turn.status !== "active" ||
        hasSkippedObservationsForTurn(deps.db, turn.id);

      const miniTurn = processors.buildMiniTurn(turn.id, obsItems, {
        role: hadPriorDelivery ? "final" : "short",
        partIndex: hadPriorDelivery ? state.streamedParts.get(turn.id) ?? 1 : 1,
        needsPriorTurn: hadPriorDelivery,
        turnStopItem,
      });
      if (!miniTurn) {
        for (const item of obsItems) {
          deleteQueueItem(deps.db, item.seq);
        }
        deleteQueueItem(deps.db, turnStopItem.seq);
        return;
      }

      if (hadPriorDelivery) {
        enqueueSliceLocked(state, miniTurn, turnStopItem.enqueuedAtEpoch);
      } else {
        enqueueMergedTurnLocked(state, miniTurn);
      }

      while (state.batchQueue.length > config.maxQueuedBatches) {
        const outcome = await flushOneBatchLocked(state);
        if (outcome === "retryLater" || outcome === "empty") {
          break;
        }
      }
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

  function schedulePersistentRetry(): void {
    if (!deps.processDiaryItem) {
      return;
    }

    const dueEpoch = deps.db
      .query<{ nextAttemptEpoch: number | null }, []>(
        `SELECT MIN(d.next_attempt_epoch) AS nextAttemptEpoch
         FROM diary_day_state d
         WHERE d.next_attempt_epoch IS NOT NULL
           AND EXISTS (
             SELECT 1
             FROM pending_queue q
             WHERE q.kind = 'diary'
               AND q.claimed_at_epoch IS NULL
               AND q.target_id = CAST(REPLACE(d.date, '-', '') AS INTEGER)
           )`,
      )
      .get()?.nextAttemptEpoch ?? null;

    if (dueEpoch === null) {
      if (persistentRetryTimer) {
        clearTimeoutImpl(persistentRetryTimer.handle);
        persistentRetryTimer = null;
      }
      return;
    }

    if (persistentRetryTimer?.dueEpoch === dueEpoch) {
      return;
    }
    if (persistentRetryTimer) {
      clearTimeoutImpl(persistentRetryTimer.handle);
    }

    const handle = setTimeoutImpl(
      async () => {
        if (persistentRetryTimer?.dueEpoch !== dueEpoch) {
          return;
        }
        persistentRetryTimer = null;
        await scanAndDrainQueue();
      },
      Math.max(0, dueEpoch - now()) * 1_000,
    );
    persistentRetryTimer = { handle, dueEpoch };
  }

  function scheduleDiaryContinuation(): void {
    if (!deps.processDiaryItem) {
      return;
    }

    if (!diaryStateStore.hasReadyDiaryItem(now())) {
      if (diaryContinuationTimer !== null) {
        clearTimeoutImpl(diaryContinuationTimer);
        diaryContinuationTimer = null;
      }
      return;
    }
    if (diaryContinuationTimer !== null) {
      return;
    }

    let handle: unknown;
    handle = setTimeoutImpl(async () => {
      if (diaryContinuationTimer !== handle) {
        return;
      }
      diaryContinuationTimer = null;
      await scanAndDrainQueue();
    }, 0);
    diaryContinuationTimer = handle;
  }

  async function drainQueue(sessionFilter?: number): Promise<void> {
    const currentMs = nowMs();
    for (const [sessionDbId, retryAtMs] of suspendedUntilBySession) {
      if (retryAtMs <= currentMs) {
        suspendedUntilBySession.delete(sessionDbId);
      }
    }
    if (
      sessionFilter !== undefined &&
      suspendedUntilBySession.has(sessionFilter)
    ) {
      return;
    }

    const skippedSeqs = new Set<number>();
    let diaryProcessed = false;

    while (true) {
      const excludedSessions =
        sessionFilter === undefined
          ? new Set([
              ...compactingSessions,
              ...suspendedUntilBySession.keys(),
            ])
          : undefined;
      const item = claimNextItem(deps.db, now(), {
        sessionFilter,
        skippedSeqs,
        excludeSessions: excludedSessions,
      });

      if (!item) {
        if (
          sessionFilter === undefined &&
          deps.processDiaryItem &&
          !diaryProcessed
        ) {
          const diaryItem = diaryStateStore.claimNextDiaryItem(now());
          if (diaryItem) {
            diaryProcessed = true;
            try {
              await deps.processDiaryItem(diaryItem);
            } catch (error) {
              logger.error?.("diary queue item failed", {
                seq: diaryItem.seq,
                targetId: diaryItem.targetId,
                error,
              });
            }
            continue;
          }
        }
        if (sessionFilter === undefined) {
          schedulePersistentRetry();
          scheduleDiaryContinuation();
        }
        return;
      }

      if (item.kind === "obs") {
        getOrCreateBuffer(item.sessionDbId).items.push(item);
        // Streaming trigger (D2): each per-tool wake buffers the obs, then we
        // check whether the in-progress turn has crossed the slice threshold.
        // A cheap lock-free pre-check avoids acquiring the session lock (and
        // blocking the drain behind an in-flight flush) for the common
        // under-threshold case; maybeStream re-checks authoritatively.
        const observation = getObservation(deps.db, item.targetId);
        if (
          observation &&
          !compactingSessions.has(item.sessionDbId) &&
          bufferedTurnObsExceedThreshold(item.sessionDbId, observation.turnId)
        ) {
          try {
            await withSessionProcessingLock(item.sessionDbId, async (state) => {
              await maybeStreamInProgressTurnLocked(state, observation.turnId);
            });
          } catch (error) {
            logger.error?.("streaming slice flush failed during drain", {
              seq: item.seq,
              error,
            });
          }
        }
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

  function scanAndDrainQueue(sessionFilter?: number): Promise<void> {
    if (sessionFilter !== undefined) {
      return drainQueue(sessionFilter);
    }
    if (globalScanInFlight) {
      return globalScanInFlight;
    }

    const scan = drainQueue();
    const tracked = scan.finally(() => {
      if (globalScanInFlight === tracked) {
        globalScanInFlight = null;
      }
    });
    globalScanInFlight = tracked;
    return tracked;
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
    // Drop in-memory batch/streaming state so reclaimed obs re-stream from
    // scratch with attempts reset (a clean retry, D8).
    for (const state of sessions.values()) {
      state.batchQueue = [];
      state.streamedParts.clear();
    }
    resetClaimedQueueItems(deps.db);
  }

  // Gate the worker-driven /compact on the agent's live context size. The most
  // recent assistant turn's prompt (read from the agent transcript) is the true
  // context gauge; we only compact once it reaches config.compactContextRatio of
  // the window, so a small agent session is never needlessly compressed. When
  // the context can't be read we default to compacting (prior behavior).
  function shouldCompactAgent(state: SessionState): boolean {
    if (!state.agentSessionId) {
      return true;
    }
    let contextTokens: number | null;
    try {
      contextTokens = readAgentContextTokensImpl(state.agentSessionId);
    } catch {
      // Unreadable / concurrently-deleted transcript: unknown context, so
      // fall back to compacting (prior behavior) rather than the outer catch
      // mislabeling it "mnemosyne compact failed".
      return true;
    }
    if (contextTokens === null) {
      return true;
    }
    return (
      contextTokens >=
      Math.min(
        AGENT_CONTEXT_WINDOW_TOKENS * config.compactContextRatio,
        AGENT_COMPACT_MAX_TOKENS,
      )
    );
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
        // Standalone <session> summary: requiredIds = ∅, completion point. A
        // floor here abandons the refresh (idempotent; next compact retries).
        const summaryShape: WorkUnitShape = { kind: "session-summary" };
        await pushSessionSummaryPromptImpl(
          state,
          sessionDbId,
          async (message) => {
            try {
              await sendWorkUnit(
                state,
                message,
                deriveRequiredTargetIds(summaryShape),
                true,
              );
            } catch (e) {
              if (e instanceof DerailmentFloorError) {
                applyFloor(summaryShape, e.requiredIds, sessionDbId);
              } else {
                throw e;
              }
            }
          },
        );
      } catch (error) {
        logger.error?.("session summary push failed", {
          sessionDbId,
          error,
        });
      }

      const compactState = sessions.get(sessionDbId);
      try {
        if (compactState?.querySession && shouldCompactAgent(compactState)) {
          await compactState.querySession.compact?.();
          // Worker-driven path: re-prime synchronously now that the agent's
          // history has been compacted away. The explicit compact() boundary is
          // gated out of onCompactBoundary (query-session.ts), so this is the
          // only re-prime for this compaction — no double re-prime.
          await sendSessionReprime(compactState);
        }
      } catch (error) {
        logger.error?.("mnemosyne compact failed", {
          sessionDbId,
          error,
        });
        // The agent's history may already be wiped while the re-prime failed;
        // flag so the next work unit retries the re-prime rather than running
        // the agent on compacted-away history.
        if (compactState) {
          compactState.needsReprime = true;
        }
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
    triggerManualDream(date: unknown): ManualDreamResult {
      if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return { ok: false, status: 400, message: "date must be YYYY-MM-DD" };
      }
      const parsed = new Date(`${date}T00:00:00Z`);
      if (
        Number.isNaN(parsed.getTime()) ||
        parsed.toISOString().slice(0, 10) !== date
      ) {
        return { ok: false, status: 400, message: "date is not a real calendar day" };
      }
      // A dream runs for a completed day; today is not due yet. "today" is the
      // in-progress content-day (4am boundary), so before 4am the just-ended
      // calendar day is still open and correctly rejected.
      const today = contentDateAt(
        now(),
        config.dreamAgentTimeZone,
        config.dreamAgentHour,
      );
      if (date >= today) {
        return { ok: false, status: 400, message: "date must be a completed past day" };
      }
      const { cutoverDate } = diaryStateStore.initializeBootstrap(today);
      if (date < cutoverDate) {
        return {
          ok: false,
          status: 400,
          message: `date is before the dream cutover ${cutoverDate}`,
        };
      }
      // Reset to a clean, non-terminal, retryable state, requeue, and kick a
      // continuation so the worker picks it up promptly.
      diaryStateStore.markDayStaleAndEnqueue({ date, enqueuedAtEpoch: now() });
      scheduleDiaryContinuation();
      return { ok: true, date };
    },
    sendWorkUnit,
    reopenQuerySessionFresh,
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
            await closeSessionQuery(
              state.sessionDbId,
              createWorkerAbortError("stall-watchdog"),
            ).catch((error) => {
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
    // Reliable >=10s retry beat for flush units left in "retryLater" (D8).
    // Mirrors the keepalive concurrency discipline: skip compacting sessions
    // and do all queue work inside the session processing lock.
    async runRetryTick(): Promise<void> {
      for (const sessionDbId of [...sessions.keys()]) {
        if (compactingSessions.has(sessionDbId)) {
          continue;
        }
        await withSessionProcessingLock(sessionDbId, async (state) => {
          pruneBatchQueueLocked(state);
          const head = state.batchQueue[0];
          if (head && head.attempts > 0 && head.attempts < config.maxFlushAttempts) {
            // Bypass the keepalive cache-age gate: this is a failure retry.
            await flushOneBatchLocked(state);
          }
        });
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

// Re-assert our pid handle. The initial write in `main` happens once, but a
// peer worker's shutdown cleanup unlinks the *shared* pid path, and idle churn
// can leave the live listener with no pid file (the port bind + starting marker
// remain the real singleton guard; the pid file is only `client`'s kill
// fallback). Called at boot and on every watchdog tick so the file tracks the
// process that actually holds the port.
export function ensureWorkerPidFile(deps: WorkerServerDeps = {}): void {
  const pidPath = deps.pidPath ?? WORKER_PID_PATH;
  const existsSyncImpl = deps.existsSyncImpl ?? existsSync;
  const readFileSyncImpl = deps.readFileSyncImpl ?? readFileSync;
  const writeFileSyncImpl = deps.writeFileSyncImpl ?? writeFileSync;
  const processImpl = deps.processImpl ?? process;
  const ownPid = String(processImpl.pid);

  if (existsSyncImpl(pidPath)) {
    try {
      if (readFileSyncImpl(pidPath, "utf8").trim() === ownPid) {
        return;
      }
    } catch {
      // Unreadable pid file — fall through and rewrite it.
    }
  }
  writeFileSyncImpl(pidPath, ownPid);
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
  const handleDreamImpl: (date: unknown) => ManualDreamResult =
    deps.handleDreamImpl ??
    runtime?.triggerManualDream ??
    (() => ({ ok: false, status: 503, message: "dream runtime unavailable" }));

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

      if (req.method === "POST" && url.pathname === "/dream") {
        const payload = (await req.json()) as { date?: unknown };
        const result = handleDreamImpl(payload.date);
        if (!result.ok) {
          return new Response(result.message, { status: result.status });
        }
        return Response.json({ enqueued: result.date });
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
  const startingPath = deps.startingPath ?? WORKER_STARTING_PATH;
  const unlinkSyncImpl = deps.unlinkSyncImpl ?? unlinkSync;
  const db = deps.db ?? createDatabase();
  const serverState = createWorkerServerState(deps.nowMs?.() ?? Date.now());
  const config = deps.config ?? loadConfig();

  initializeDatabase(db);
  const processors = createWorkerProcessors(db);
  const diaryRuntime =
    deps.processDiaryItem
      ? null
      : (deps.createDiaryRuntimeImpl ?? createDiaryRuntime)({
          db,
          dataRoot: deps.dataRoot ?? DATA_DIR,
          nowEpoch: deps.now,
          config,
        });

  const core = createWorkerCore({
    db,
    now: deps.now,
    nowMs: deps.nowMs,
    config,
    pushSessionSummaryPromptImpl:
      deps.pushSessionSummaryPromptImpl ?? processors.pushSessionSummaryPrompt,
    closeSessionQueryImpl: deps.closeSessionQueryImpl,
    createWorkerQuerySessionImpl: deps.createWorkerQuerySessionImpl,
    isProcessAliveImpl: deps.isProcessAliveImpl,
    processDiaryItem:
      deps.processDiaryItem ??
      diaryRuntime?.processDreamItem,
    logger: deps.logger ?? createLogger("MNEMOSYNE"),
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
    ensureWorkerPidFile(deps);
  } finally {
    try {
      unlinkSyncImpl(startingPath);
    } catch {}
  }

  // Heartbeat so the log file exists on a healthy boot (otherwise it only
  // appears once a warn/error fires). Skipped when a logger is injected (tests).
  if (!deps.logger) {
    createLogger("MNEMOSYNE").info("worker started", {
      pid: process.pid,
      buildId: BUILD_ID,
      port: WORKER_PORT,
    });
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
    ensureWorkerPidFile(deps);
    void core.abortStalledSessions();
    void core.runKeepaliveTick();
    void core.runRetryTick();
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
