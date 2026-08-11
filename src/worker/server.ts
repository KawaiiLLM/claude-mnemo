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
import { createDatabase, runWriteTransaction } from "../db/database";
import { createDiaryStateStore } from "../db/diary-state";
import { contentDateAt } from "../diary/calendar";
import {
  getSession,
  getSessionByContentId,
  updateCompactAnchor,
} from "../db/sessions";
import { reconcileNoteDebt } from "../db/note-debt";
import { getTurnById } from "../db/turns";
import {
  claimNextItem,
  countQueueItemsForSession,
  deleteQueueItem,
  releaseQueueClaim,
  resetClaimedQueueItems,
  type PendingQueueItem,
} from "../db/pending-queue";
import { ensureRecordedEraCutoff, resolveEraCutoff } from "../db/era";
import { initializeDatabase, migrateTurnCitationsToEdges } from "../db/schema";
import { runTranscriptPathBackfill } from "../db/transcript-path-backfill";
import {
  createNoteSettlementScheduler,
  type NoteSettlementDispatch,
  type NoteSettlementScheduler,
} from "./note-settlement";
import { createNoteSettlementDispatch } from "./note-settlement-dispatch";
import { createNoteSettlementSdkQuery } from "./note-settlement-sdk-query";
import {
  DATA_DIR,
  WORKER_PID_PATH,
  WORKER_STARTING_PATH,
} from "../shared/paths";
import { DEFAULT_CONFIG, loadConfig, type MnemoConfig } from "../shared/config";
import { createLogger } from "../shared/logger";
import { detectAndCleanSubagentTurns } from "./subagent-filter";
import {
  createDiaryRuntime,
  type CreateDiaryRuntimeOptions,
  type DiaryRuntime,
} from "./diary-runtime";
import {
  finalizeUnreachableStrandedTurns,
  listStrandedRepairDates,
  restoreStrandedTurnStops,
} from "./turn-liveness";
import {
  buildIsolatedEnv,
  captureSessionEnv,
  type CapturedSessionEnv,
} from "../mnemosyne/env";

const WORKER_PORT = 37778;
const STARTING_STALE_MS = 10_000;
const WATCHDOG_INTERVAL_MS = 10_000;
const IDLE_WORKER_HTTP_MS = 30 * 60 * 1000;

/**
 * The worker is a librarian, not a reader (spec D10, ticket 15).
 *
 * It owns the serialized write to the database, the mechanical retirement of
 * captured work, the two note-settlement triggers and the nightly dream claim —
 * and it hosts NO language model of its own on any path. The resident extraction
 * agent that used to live here (its SDK session, compact management, resume
 * pointer, stall watchdog, obs summary pipeline, per-session summary pass and
 * two-phase grade settlement) was removed whole: a turn's record is now written
 * by the agent that lived the turn, and the turn's own completion event settles
 * the row arithmetically (db/turn-completion.ts, reached through the note-debt
 * classification path).
 *
 * The one subprocess the worker can still start is the note-settlement payload,
 * and it is doubly gated: no era cutoff, or the kill switch off, and nothing is
 * even constructed (see `main`).
 */

export interface QueueDrain {
  (sessionFilter?: number): Promise<void>;
}

interface DrainQueueResult {
  turnStopSessionDbIds: Set<number>;
}

export interface WorkerCoreDeps {
  db: Database;
  workerEnv?: NodeJS.ProcessEnv;
  sessionEnvRegistry?: Map<string, CapturedSessionEnv>;
  now?: () => number;
  nowMs?: () => number;
  processDiaryItem?: (
    item: PendingQueueItem,
    agentEnv: NodeJS.ProcessEnv,
  ) => Promise<void>;
  reconcileDreamBacklog?: (nowEpoch: number) => Promise<string[] | void>;
  setTimeoutImpl?: (
    callback: () => void | Promise<void>,
    delayMs: number,
  ) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
  /**
   * P2 note settlement payload (spec D9). Defaults to undefined, which is what
   * keeps "the worker never calls a model" true of the shipped wiring; `main`
   * supplies the real Sonnet subprocess only when both switches are on.
   */
  noteSettlementDispatchImpl?: NoteSettlementDispatch;
  /** Forces the record-only graceful-exit window in tests. */
  isGracefulExitImpl?: () => boolean;
  logger?: Pick<Console, "warn" | "error">;
  config?: MnemoConfig;
}

export interface WorkerServerDeps extends Partial<WorkerCoreDeps> {
  dataRoot?: string;
  createDiaryRuntimeImpl?: (
    options: CreateDiaryRuntimeOptions,
  ) => DiaryRuntime;
  BunServeImpl?: typeof Bun.serve;
  scanAndDrainQueue?: QueueDrain;
  handleTurnStopImpl?: (sessionId: number) => Promise<void>;
  handleFlushImpl?: (sessionId: number) => Promise<void>;
  handleCompactImpl?: (
    sessionId: number,
    transcriptPath?: string | null,
  ) => Promise<void>;
  handleDreamImpl?: (date: unknown) => ManualDreamResult;
  registerSessionEnvImpl?: (
    contentSessionId: string,
    sessionDbId: number | undefined,
    env: NodeJS.ProcessEnv,
  ) => Promise<number | null>;
  clearSessionEnvImpl?: (
    contentSessionId: string,
    sessionDbId?: number,
  ) => void;
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
  hardExitTimerImpl?: HardExitTimer;
  /** True while any content session is still registered with the worker. */
  hasLiveSessionsImpl?: () => boolean;
  getGlobalScanInFlightImpl?: () => Promise<void> | null;
  isDreamRunningImpl?: () => boolean;
  abortDreamImpl?: () => Promise<void>;
  /** Latches the record-only settlement window before the process exits. */
  beginGracefulExitImpl?: () => void;
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

export interface HardExitTimer {
  arm(): void;
  cancel(): void;
}

interface HardExitTimerDeps extends WorkerServerDeps {
  config: MnemoConfig;
  sessionEnvRegistry: Map<string, CapturedSessionEnv>;
  beginGracefulExitImpl: () => void;
}

/**
 * Result of a manual `POST /dream` trigger: either enqueued, or rejected with an
 * HTTP status the fetch handler can echo verbatim.
 */
export type ManualDreamResult =
  | { ok: true; date: string }
  | { ok: false; status: number; message: string };

export interface WorkerCore {
  recoverFromCrash(): void;
  scanAndDrainQueue(sessionFilter?: number): Promise<void>;
  handleTurnStop(sessionDbId: number): Promise<void>;
  finishSession(sessionDbId: number): Promise<void>;
  drainSessionCompletely(sessionDbId: number): Promise<void>;
  /**
   * P2 note settlement (spec D9). Exposed so the trigger surface can be driven
   * directly; the worker itself calls it from exactly two places —
   * `handleTurnStop` and `handleCompact`.
   */
  noteSettlement: NoteSettlementScheduler;
  handleCompact(sessionDbId: number, transcriptPath?: string | null): Promise<void>;
  triggerManualDream(date: unknown): ManualDreamResult;
  /**
   * Enter the record-only window: from here settlement records jobs and
   * dispatches nothing, because anything started now would be killed before it
   * reported back and would burn an attempt for no work.
   */
  beginGracefulExit(): void;
  /**
   * One bounded slice of the `sessions.transcript_path` repair. The worker is
   * the only long-lived process, so it is the only place this belongs — hosting
   * it in `initializeDatabase` put an unbounded filesystem scan on every hook's
   * critical path and let several processes drive one ledger. Self-retiring:
   * once the repair completes there is nothing left to call.
   */
  runTranscriptRepairTick(): void;
  registerSessionEnv(
    contentSessionId: string,
    sessionDbId: number | undefined,
    env: NodeJS.ProcessEnv,
  ): Promise<number | null>;
  clearSessionEnv(contentSessionId: string, sessionDbId?: number): void;
  getGlobalScanInFlight(): Promise<void> | null;
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

export function createHardExitTimer(deps: HardExitTimerDeps): HardExitTimer {
  const setTimeoutImpl =
    deps.setTimeoutImpl ??
    ((callback: () => void | Promise<void>, delayMs: number): unknown =>
      setTimeout(() => void callback(), delayMs));
  const clearTimeoutImpl =
    deps.clearTimeoutImpl ??
    ((handle: unknown): void =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));
  const logger = deps.logger ?? console;
  let pending:
    | {
        token: object;
        handle: unknown;
      }
    | null = null;

  return {
    arm(): void {
      if (pending || deps.sessionEnvRegistry.size !== 0) {
        return;
      }

      const token = {};
      const handle = setTimeoutImpl(() => {
        if (pending?.token !== token) {
          return;
        }
        pending = null;
        if (deps.sessionEnvRegistry.size !== 0) {
          return;
        }

        try {
          deps.beginGracefulExitImpl();
        } catch (error) {
          logger.error?.("hard-exit graceful-exit latch failed", { error });
        } finally {
          createHardExitCleanup(deps);
        }
      }, deps.config.hardExitTimeoutMs);
      pending = { token, handle };

      const remainingTurns =
        deps.db
          ?.query<{ count: number }, []>(
            `SELECT COUNT(*) AS count
             FROM pending_queue
             WHERE kind = 'turn-stop'`,
          )
          .get()?.count ?? 0;
      logger.warn?.("all content sessions closed; hard-exit timer armed", {
        hardExitTimeoutMs: deps.config.hardExitTimeoutMs,
        remainingTurns,
      });
    },
    cancel(): void {
      if (!pending) {
        return;
      }
      clearTimeoutImpl(pending.handle);
      pending = null;
    },
  };
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
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
  const sessionEnvRegistry =
    deps.sessionEnvRegistry ?? new Map<string, CapturedSessionEnv>();
  const contentSessionIdByDbId = new Map<number, string>();
  // Latched by the shutdown path. Inside this window settlement records jobs and
  // dispatches nothing.
  let gracefulExitWindow = false;
  const noteSettlement: NoteSettlementScheduler = createNoteSettlementScheduler({
    db: deps.db,
    config,
    now,
    nowMs,
    dispatch: deps.noteSettlementDispatchImpl,
    // "Closed" is derived, never stored: a session counts as live exactly while
    // its env registration is present, which is worker memory, not a column.
    activeSessionIds: () => contentSessionIdByDbId.keys(),
    isGracefulExit: deps.isGracefulExitImpl ?? (() => gracefulExitWindow),
    logger,
  });

  /**
   * Run one settlement trigger. Wrapped so a settlement fault can never fail the
   * content event that carried it — capture outranks settlement, and a settled
   * window is recoverable from the durable job row anyway.
   */
  async function runNoteSettlementTrigger(
    sessionDbId: number,
    trigger: "turn-stop" | "compact",
  ): Promise<void> {
    try {
      if (trigger === "compact") {
        await noteSettlement.onCompact(sessionDbId);
      } else {
        await noteSettlement.onTurnStop(sessionDbId);
      }
    } catch (error) {
      logger.error?.("note settlement trigger failed", {
        sessionDbId,
        trigger,
        error,
      });
    }
  }

  const diaryStateStore = createDiaryStateStore(deps.db);
  let diaryContinuationTimer: unknown | null = null;
  let pendingDiaryTriggerSessionDbId: number | null | undefined;
  let globalScanInFlight: Promise<void> | null = null;
  // Latches once the transcript-path repair reports it has nothing left to do,
  // so the steady state costs zero — not even the ledger's indexed read.
  let transcriptRepairRetired = false;

  function getRegisteredSessionEnv(
    sessionDbId: number,
  ): CapturedSessionEnv | undefined {
    const knownContentSessionId = contentSessionIdByDbId.get(sessionDbId);
    if (knownContentSessionId) {
      return sessionEnvRegistry.get(knownContentSessionId);
    }

    const session = getSession(deps.db, sessionDbId);
    if (!session) {
      return undefined;
    }

    const captured = sessionEnvRegistry.get(session.contentSessionId);
    if (captured) {
      contentSessionIdByDbId.set(sessionDbId, session.contentSessionId);
    }
    return captured;
  }

  /**
   * Retire one claimed queue item.
   *
   * This is the whole of what the queue does now. An `obs` row was only ever a
   * wake signal plus a place in the extraction agent's input stream; with the
   * agent gone the observation is already captured, already FTS-indexed and
   * already readable, so the row is simply dropped — except when its owning turn
   * is already terminal (or gone), which is queue pollution: the turn's own
   * settlement has been and gone, so nothing else will ever retire that
   * observation and it would stay `pending` forever. Retirement and deletion
   * share one transaction, so a failed delete cannot leave a retired-but-queued
   * row behind.
   *
   * A `turn-stop` row is the turn's completion event, and completion is what
   * settles the row — through `reconcileNoteDebt`, the one place that knows both
   * "this turn is over" and "here is what it carries". Settling BEFORE the
   * delete matters: the ledger's completion-evidence predicate counts a queued
   * turn-stop as evidence, so a row deleted first would leave a turn with no
   * evidence and no terminal status, which the stranded repair would re-enqueue
   * on every end event forever.
   */
  function retireQueueItem(item: PendingQueueItem): void {
    runWriteTransaction(deps.db, () => {
      if (item.kind === "turn-stop") {
        const turn = getTurnById(deps.db, item.targetId);
        if (turn) {
          reconcileNoteDebt(deps.db, {
            sessionId: turn.sessionId,
            nowEpoch: now(),
            completedTurnId: turn.id,
            eraCutoffEpoch: config.eraCutoffEpoch ?? resolveEraCutoff(deps.db),
          });
        }
      } else if (item.kind === "obs") {
        const owner = deps.db
          .query<{ observationId: number | null; turnStatus: string | null }, [number]>(
            `SELECT o.id AS observationId, t.status AS turnStatus
             FROM pending_queue q
             LEFT JOIN observations o ON o.id = q.target_id
             LEFT JOIN turns t ON t.id = o.turn_id
             WHERE q.seq = ? AND q.kind = 'obs'`,
          )
          .get(item.seq);
        const ownerIsLive =
          owner?.turnStatus === "active" || owner?.turnStatus === "provisional";
        if (owner?.observationId !== null && owner !== null && !ownerIsLive) {
          deps.db
            .query<unknown, [number]>(
              "UPDATE observations SET status = 'skipped' WHERE id = ?",
            )
            .run(owner!.observationId!);
        }
      }
      deleteQueueItem(deps.db, item.seq);
    });
  }

  async function registerSessionEnv(
    contentSessionId: string,
    sessionDbId: number | undefined,
    rawEnv: NodeJS.ProcessEnv,
  ): Promise<number | null> {
    sessionEnvRegistry.set(contentSessionId, captureSessionEnv(rawEnv));

    const suppliedSession =
      sessionDbId === undefined ? null : getSession(deps.db, sessionDbId);
    const dbSession =
      suppliedSession?.contentSessionId === contentSessionId
        ? suppliedSession
        : getSessionByContentId(deps.db, contentSessionId);
    if (!dbSession) {
      return null;
    }

    contentSessionIdByDbId.set(dbSession.id, contentSessionId);
    return dbSession.id;
  }

  function clearSessionEnv(
    contentSessionId: string,
    sessionDbId?: number,
  ): void {
    sessionEnvRegistry.delete(contentSessionId);
    if (sessionDbId !== undefined) {
      contentSessionIdByDbId.delete(sessionDbId);
    }
    for (const [dbId, knownContentSessionId] of contentSessionIdByDbId) {
      if (knownContentSessionId === contentSessionId) {
        contentSessionIdByDbId.delete(dbId);
      }
    }
  }

  function scheduleDiaryContinuation(): void {
    if (!config.dreamAgentEnabled || !deps.processDiaryItem) {
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
    // This zero-delay continuation is reserved for the explicit manual
    // trigger. Automatic retries and remaining backlog wait for a turn-stop.
    handle = setTimeoutImpl(async () => {
      if (diaryContinuationTimer !== handle) {
        return;
      }
      diaryContinuationTimer = null;
      await scanAndDrainGlobalQueue(null);
    }, 0);
    diaryContinuationTimer = handle;
  }

  async function drainQueue(sessionFilter?: number): Promise<DrainQueueResult> {
    const result: DrainQueueResult = {
      turnStopSessionDbIds: new Set<number>(),
    };
    const skippedSeqs = new Set<number>();

    while (true) {
      const item = claimNextItem(deps.db, now(), {
        sessionFilter,
        skippedSeqs,
      });
      if (!item) {
        return result;
      }

      try {
        retireQueueItem(item);
        if (item.kind === "turn-stop") {
          result.turnStopSessionDbIds.add(item.sessionDbId);
        }
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

  async function drainOneDiaryItem(
    triggeringSessionDbId: number | null,
  ): Promise<void> {
    // The only executor of dream work: gating here also holds back every retry,
    // since a failed day is re-dispatched through this same claim.
    if (!config.dreamAgentEnabled || !deps.processDiaryItem) {
      return;
    }

    const diaryItem = diaryStateStore.claimNextDiaryItem(now());
    if (!diaryItem) {
      return;
    }

    const capturedSessionEnv =
      triggeringSessionDbId === null
        ? undefined
        : getRegisteredSessionEnv(triggeringSessionDbId);
    if (!capturedSessionEnv) {
      logger.warn?.(
        "dream triggering session env unavailable; using operational baseline",
        { triggeringSessionDbId },
      );
    }
    const agentEnv = buildIsolatedEnv(
      deps.workerEnv ?? process.env,
      capturedSessionEnv ?? {},
    );

    try {
      await deps.processDiaryItem(diaryItem, agentEnv);
    } catch (error) {
      logger.error?.("diary queue item failed", {
        seq: diaryItem.seq,
        targetId: diaryItem.targetId,
        error,
      });
    }
  }

  async function coordinateEndEvent(
    triggeringSessionDbId: number,
  ): Promise<void> {
    if (config.dreamAgentEnabled) {
      try {
        // Called for its enqueue side effect only. The repair below used to
        // reuse the due days this returns, which silently switched the whole
        // cleanup off with the dream kill switch; it now derives its own dates.
        await deps.reconcileDreamBacklog?.(now());
      } catch (error) {
        logger.error?.("dream backlog reconcile failed", { error });
      }
    }

    // Read-only, dream-independent: the closed content-days of the stranded
    // turns themselves.
    const repairDates = listStrandedRepairDates(deps.db, {
      timeZone: config.dreamAgentTimeZone,
      boundaryHour: config.dreamAgentHour,
      nowEpoch: now(),
    });

    if (repairDates.length > 0) {
      const repair = restoreStrandedTurnStops(deps.db, {
        dates: repairDates,
        timeZone: config.dreamAgentTimeZone,
        boundaryHour: config.dreamAgentHour,
        nowEpoch: now(),
        hasRegisteredSessionEnv: (sessionDbId) =>
          getRegisteredSessionEnv(sessionDbId) !== undefined,
      });

      if (repair.enqueuedTurnStopCount > 0) {
        await drainQueue();
      }

      // The environment probe is handed to the finalizer rather than read once
      // here: the drain above is an await, and a session that re-registers
      // during it is being resumed. The finalizer re-asks per turn inside its
      // write transaction and defers anything that moved.
      const floored = finalizeUnreachableStrandedTurns(
        deps.db,
        repair.unreachable,
        {
          hasRegisteredSessionEnv: (sessionDbId) =>
            getRegisteredSessionEnv(sessionDbId) !== undefined,
          eraCutoffEpoch: config.eraCutoffEpoch ?? resolveEraCutoff(deps.db),
        },
      );

      for (const item of floored) {
        logger.warn?.("stranded turn completion floor applied", {
          sessionDbId: item.sessionDbId,
          turnId: item.turnId,
          reasonCode: item.reasonCode,
        });
      }

      const deferredCount = repair.unreachable.length - floored.length;
      if (deferredCount > 0) {
        logger.warn?.("stranded turn completion floor deferred", {
          count: deferredCount,
          reasonCode: "turn-changed-during-repair",
        });
      }
    }

    await drainOneDiaryItem(triggeringSessionDbId);
  }

  function scanAndDrainGlobalQueue(
    requestedTriggerSessionDbId?: number | null,
  ): Promise<void> {
    // Pure liveness scans only recover session work. A processed turn-stop (or
    // the explicit manual trigger) earns one diary claim after that work.
    if (
      requestedTriggerSessionDbId !== undefined &&
      pendingDiaryTriggerSessionDbId === undefined
    ) {
      pendingDiaryTriggerSessionDbId = requestedTriggerSessionDbId;
    }
    if (globalScanInFlight) {
      return globalScanInFlight;
    }

    let tracked!: Promise<void>;
    tracked = (async () => {
      try {
        do {
          const requestedTriggerForThisDrain = pendingDiaryTriggerSessionDbId;
          pendingDiaryTriggerSessionDbId = undefined;
          await drainQueue();
          if (
            requestedTriggerForThisDrain !== undefined &&
            requestedTriggerForThisDrain !== null
          ) {
            await coordinateEndEvent(requestedTriggerForThisDrain);
          } else if (requestedTriggerForThisDrain === null) {
            await drainOneDiaryItem(null);
          }
        } while (pendingDiaryTriggerSessionDbId !== undefined);
      } finally {
        if (globalScanInFlight === tracked) {
          globalScanInFlight = null;
        }
      }
    })();
    globalScanInFlight = tracked;
    return tracked;
  }

  function scanAndDrainQueue(sessionFilter?: number): Promise<void> {
    if (sessionFilter !== undefined) {
      return (async () => {
        await drainQueue(sessionFilter);
      })();
    }
    return scanAndDrainGlobalQueue();
  }

  async function handleTurnStop(sessionDbId: number): Promise<void> {
    // Turn-stop wakes share the global drain serializer with ordinary wake
    // scans. A direct session drain can otherwise overtake rows already being
    // claimed by an in-flight global drain and terminalize their owner first.
    await scanAndDrainGlobalQueue(sessionDbId);
    // One of the two settlement triggers (spec D9), and the only one that fires
    // from ordinary work. It settles nothing until 50 consecutive decided turns
    // have accumulated, so every other turn-stop costs one indexed read.
    await runNoteSettlementTrigger(sessionDbId, "turn-stop");
  }

  async function drainSessionCompletely(sessionDbId: number): Promise<void> {
    let previousCount = Number.POSITIVE_INFINITY;

    while (true) {
      await scanAndDrainQueue(sessionDbId);

      const remaining = countQueueItemsForSession(deps.db, sessionDbId);
      if (remaining === 0 || remaining >= previousCount) {
        if (remaining > 0) {
          logger.warn?.("drainSessionCompletely: no progress, giving up", {
            sessionDbId,
            remaining,
          });
        }
        return;
      }

      previousCount = remaining;
    }
  }

  async function finishSession(sessionDbId: number): Promise<void> {
    // SessionEnd is deliberately NOT a settlement trigger (spec D9, 裁决 7):
    // it drains what capture left behind and nothing else. A closed session's
    // unsettled window is picked up by another session's residual dispatch.
    await drainSessionCompletely(sessionDbId);
    await scanAndDrainGlobalQueue(sessionDbId);
  }

  async function handleCompact(
    sessionDbId: number,
    transcriptPath?: string | null,
  ): Promise<void> {
    if (transcriptPath) {
      detectAndCleanSubagentTurns(deps.db, sessionDbId, transcriptPath, now());
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

    await scanAndDrainGlobalQueue(sessionDbId);

    // The second settlement trigger (spec D9). Placed here on purpose: the
    // boundary marker has already been repaired by updateCompactAnchor above
    // and the queue is drained, so the note-debt ledger is as decided as it
    // will get for the turns this compact closes over.
    await runNoteSettlementTrigger(sessionDbId, "compact");
  }

  return {
    recoverFromCrash(): void {
      resetClaimedQueueItems(deps.db);
    },
    scanAndDrainQueue,
    handleTurnStop,
    finishSession,
    drainSessionCompletely,
    noteSettlement,
    handleCompact,
    beginGracefulExit(): void {
      gracefulExitWindow = true;
    },
    triggerManualDream(date: unknown): ManualDreamResult {
      // Reject before any DB write: a disabled dream must leave no queued day
      // behind that a later re-enable would silently run.
      if (!config.dreamAgentEnabled) {
        return {
          ok: false,
          status: 503,
          message: "dream agent is disabled (set dreamAgentEnabled to true)",
        };
      }
      if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return { ok: false, status: 400, message: "date must be YYYY-MM-DD" };
      }
      const parsed = new Date(`${date}T00:00:00Z`);
      if (
        Number.isNaN(parsed.getTime()) ||
        parsed.toISOString().slice(0, 10) !== date
      ) {
        return {
          ok: false,
          status: 400,
          message: "date is not a real calendar day",
        };
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
        return {
          ok: false,
          status: 400,
          message: "date must be a completed past day",
        };
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
    registerSessionEnv,
    clearSessionEnv,
    getGlobalScanInFlight() {
      return globalScanInFlight;
    },
    runTranscriptRepairTick(): void {
      if (transcriptRepairRetired) {
        return;
      }

      try {
        const summary = runTranscriptPathBackfill(deps.db, {
          log: (message) => logger.warn?.(message),
        });
        if (summary.status === "completed" || summary.status === "skipped") {
          transcriptRepairRetired = true;
        }
      } catch (error) {
        // A data repair must never become a per-tick error loop. The next
        // worker start gets one more attempt from the same ledger cursor.
        logger.error?.("transcript-path backfill failed", { error });
        transcriptRepairRetired = true;
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
  const sessionEnvRegistry =
    deps.sessionEnvRegistry ?? new Map<string, CapturedSessionEnv>();
  const runtime =
    deps.scanAndDrainQueue ||
    deps.handleTurnStopImpl ||
    deps.handleFlushImpl ||
    deps.handleCompactImpl ||
    deps.recoverFromCrashImpl
      ? undefined
      : createWorkerCore({
          db: runtimeDb,
          workerEnv: deps.workerEnv ?? deps.env,
          sessionEnvRegistry,
          now: deps.now,
          nowMs: deps.nowMs,
          config: deps.config,
        });

  const scanAndDrainQueue =
    deps.scanAndDrainQueue ?? runtime?.scanAndDrainQueue ?? defaultNoopDrain;
  const handleTurnStopImpl =
    deps.handleTurnStopImpl ??
    runtime?.handleTurnStop ??
    (async (sessionId: number) => {
      await scanAndDrainQueue(sessionId);
    });
  const handleFlushImpl =
    deps.handleFlushImpl ??
    runtime?.finishSession ??
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
  const registerSessionEnvImpl =
    deps.registerSessionEnvImpl ?? runtime?.registerSessionEnv;
  const clearSessionEnvImpl =
    deps.clearSessionEnvImpl ?? runtime?.clearSessionEnv;
  let wakeScanInFlight: Promise<void> | null = null;
  let activeGlobalWork = 0;
  let resolveGlobalWork: (() => void) | null = null;

  function trackGlobalWork(work: Promise<void>): void {
    if (activeGlobalWork === 0) {
      state.globalScanInFlight = new Promise<void>((resolve) => {
        resolveGlobalWork = resolve;
      });
    }
    activeGlobalWork += 1;
    const settle = (): void => {
      activeGlobalWork = Math.max(0, activeGlobalWork - 1);
      if (activeGlobalWork === 0) {
        const finishGlobalWork = resolveGlobalWork;
        resolveGlobalWork = null;
        state.globalScanInFlight = null;
        finishGlobalWork?.();
      }
    };
    void work.then(settle, settle);
  }

  function clearRegisteredSession(
    contentSessionId: string,
    sessionDbId?: number,
  ): void {
    const hadRegisteredSessions = sessionEnvRegistry.size > 0;
    clearSessionEnvImpl?.(contentSessionId, sessionDbId);
    if (hadRegisteredSessions && sessionEnvRegistry.size === 0) {
      deps.hardExitTimerImpl?.arm();
    }
  }

  async function handleWake(): Promise<Response> {
    if (wakeScanInFlight) {
      state.scanPending = true;
      return new Response(null, { status: 200 });
    }

    const scan = (async () => {
      do {
        state.scanPending = false;
        await scanAndDrainQueue();
      } while (state.scanPending);
    })().finally(() => {
      wakeScanInFlight = null;
    });
    wakeScanInFlight = scan;
    trackGlobalWork(scan);

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

      if (req.method === "POST" && url.pathname === "/trigger") {
        const payload = (await req.json()) as {
          action?: "capture" | "wake" | "turn-stop" | "compact" | "finish";
          content_session_id?: string;
          session_id?: number;
          transcript_path?: string | null;
          env?: Record<string, unknown>;
        };
        if (
          !payload.action ||
          typeof payload.content_session_id !== "string" ||
          payload.content_session_id === "" ||
          !payload.env ||
          typeof payload.env !== "object" ||
          Array.isArray(payload.env)
        ) {
          return new Response("valid trigger identity and env are required", {
            status: 400,
          });
        }

        const capturedEnv = Object.fromEntries(
          Object.entries(payload.env).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        );
        // Any new content-session activity means the previously observed
        // registry-empty state is no longer the worker's final close.
        deps.hardExitTimerImpl?.cancel();
        const associatedSessionId = registerSessionEnvImpl
          ? await registerSessionEnvImpl(
              payload.content_session_id,
              payload.session_id,
              capturedEnv,
            )
          : payload.session_id ?? null;

        if (payload.action === "finish") {
          if (associatedSessionId === null) {
            clearRegisteredSession(
              payload.content_session_id,
              payload.session_id,
            );
            return new Response(null, { status: 200 });
          }
          const finish = handleFlushImpl(associatedSessionId)
            .catch((error) => {
              deps.logger?.error?.("session finish request failed", {
                sessionId: associatedSessionId,
                error,
              });
            })
            .finally(() => {
              clearRegisteredSession(
                payload.content_session_id!,
                associatedSessionId,
              );
            });
          trackGlobalWork(finish);
          return new Response(null, { status: 200 });
        }

        if (payload.action === "turn-stop") {
          if (associatedSessionId === null) {
            return new Response("session_id is required", { status: 400 });
          }
          const turnStop = handleTurnStopImpl(associatedSessionId).catch(
            (error) => {
              deps.logger?.error?.("turn-stop request failed", {
                sessionId: associatedSessionId,
                error,
              });
            },
          );
          trackGlobalWork(turnStop);
          return new Response(null, { status: 200 });
        }

        if (payload.action === "compact") {
          if (associatedSessionId === null) {
            return new Response("session_id is required", { status: 400 });
          }
          const compact = handleCompactImpl(
            associatedSessionId,
            payload.transcript_path,
          ).catch((error) => {
            deps.logger?.error?.("compact request failed", {
              sessionId: associatedSessionId,
              error,
            });
          });
          trackGlobalWork(compact);
          return new Response(null, { status: 200 });
        }

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

        const compact = handleCompactImpl(
          payload.session_id,
          payload.transcript_path,
        ).catch((error) => {
          deps.logger?.error?.("compact request failed", {
            sessionId: payload.session_id,
            error,
          });
        });
        trackGlobalWork(compact);
        return new Response(null, { status: 200 });
      }

      if (req.method === "POST" && url.pathname === "/flush") {
        const payload = (await req.json()) as {
          session_id?: number;
        };

        if (typeof payload.session_id !== "number") {
          return new Response("session_id is required", { status: 400 });
        }

        const flush = handleFlushImpl(payload.session_id).catch((error) => {
          deps.logger?.error?.("flush request failed", {
            sessionId: payload.session_id,
            error,
          });
        });
        trackGlobalWork(flush);
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

function createHardExitCleanup(deps: WorkerServerDeps): void {
  void shutdownGracefully(deps).catch((error) => {
    deps.logger?.error?.("hard-exit graceful cleanup failed", { error });
  });
  exitWorkerProcess(deps);
}

function exitWorkerProcess(deps: WorkerServerDeps): void {
  const pidPath = deps.pidPath ?? WORKER_PID_PATH;
  const unlinkSyncImpl = deps.unlinkSyncImpl ?? unlinkSync;
  const processImpl = deps.processImpl ?? process;

  deps.hardExitTimerImpl?.cancel();
  try {
    unlinkSyncImpl(pidPath);
  } catch {}
  processImpl.exit(0);
}

function createShutdownCleanup(deps: WorkerServerDeps = {}): () => Promise<void> {
  return async () => {
    try {
      await shutdownGracefully(deps);
    } finally {
      exitWorkerProcess(deps);
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

/**
 * Exit as soon as the last content session is gone. Unlike the 30-minute idle
 * fallback, this path coordinates every fire-and-forget queue operation and a
 * running dream before invoking the existing pid-cleaning graceful shutdown.
 *
 * "Live" used to mean an open extraction agent, which kept the worker resident
 * for the agent's own idle window. With no agent left, liveness is the content
 * session registry itself — otherwise the worker would exit between two turns of
 * the same session and pay a cold start on every prompt.
 */
export async function checkForLastAgentShutdown(
  state: WorkerServerState,
  deps: WorkerServerDeps = {},
): Promise<boolean> {
  const hasLiveSessions = deps.hasLiveSessionsImpl ?? (() => false);
  const isDreamRunning = deps.isDreamRunningImpl ?? (() => false);

  if (state.shuttingDown || state.activeRequests > 0 || hasLiveSessions()) {
    return false;
  }

  const dreamWasRunning = isDreamRunning();
  const serverWork = state.globalScanInFlight;
  const coreWork = deps.getGlobalScanInFlightImpl?.() ?? null;

  // Ordinary queue work is a hard guard: let it finish and re-evaluate on the
  // next watchdog beat. A dream is the sole exception because shutdown must
  // abort its query to make that global drain settle.
  if (!dreamWasRunning && (serverWork || coreWork)) {
    return false;
  }
  if (dreamWasRunning && !deps.abortDreamImpl) {
    return false;
  }

  state.shuttingDown = true;
  try {
    if (dreamWasRunning) {
      await deps.abortDreamImpl?.();
      await Promise.all([
        serverWork?.catch(() => {}),
        coreWork?.catch(() => {}),
      ]);
    }

    // Work or a new session may have appeared while the dream/global drain was
    // unwinding. Graceful exit is allowed only when all four guards hold at
    // this final decision point.
    if (
      state.activeRequests > 0 ||
      hasLiveSessions() ||
      state.globalScanInFlight !== null ||
      (deps.getGlobalScanInFlightImpl?.() ?? null) !== null ||
      isDreamRunning()
    ) {
      state.shuttingDown = false;
      return false;
    }

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
  const sessionEnvRegistry = new Map<string, CapturedSessionEnv>();
  const logger = deps.logger ?? createLogger("MNEMOSYNE");

  initializeDatabase(db);
  // Same boundary the hook command records, in case the worker is the first
  // process of this build to open the database (db/era.ts).
  const recordedEraCutoff = ensureRecordedEraCutoff(
    db,
    Math.floor(Date.now() / 1000),
  );
  const eraCutoffEpoch = config.eraCutoffEpoch ?? recordedEraCutoff;
  // The cutover catch-up (spec D13, "收编重造"). `turn_citations` was folded into
  // `memory_edges` once, when the edge table was created, and the legacy
  // `remember` route kept appending to the source table afterwards — an
  // increment the one-time migration cannot see. Re-running it here is idempotent
  // (the edge primary key absorbs it) and belongs to the worker rather than to
  // `initializeDatabase`, which every hook process runs on its critical path.
  try {
    migrateTurnCitationsToEdges(db);
  } catch (error) {
    logger.error?.("turn-citation edge catch-up failed", { error });
  }

  const diaryRuntime = deps.processDiaryItem
    ? null
    : (deps.createDiaryRuntimeImpl ?? createDiaryRuntime)({
        db,
        dataRoot: deps.dataRoot ?? DATA_DIR,
        nowEpoch: deps.now,
        config,
        workerEnv: env,
      });

  // The real settlement payload is assembled HERE rather than inside the core,
  // because it needs the data root the subprocess runs in and the core has no
  // reason to learn about one. Both switches gate it — no era means nothing to
  // settle, the flag means "not right now" — and with either off nothing is
  // constructed, so "the worker calls no model" stays true of the shipped
  // default wiring rather than of a code path.
  const noteSettlementDispatchImpl =
    deps.noteSettlementDispatchImpl ??
    (config.settlementEnabled && eraCutoffEpoch !== null
      ? createNoteSettlementDispatch({
          db,
          config,
          now: deps.now,
          logger,
          runQuery: createNoteSettlementSdkQuery({
            db,
            dataRoot: deps.dataRoot ?? DATA_DIR,
          }),
        })
      : undefined);

  const core = createWorkerCore({
    db,
    workerEnv: env,
    sessionEnvRegistry,
    noteSettlementDispatchImpl,
    now: deps.now,
    nowMs: deps.nowMs,
    setTimeoutImpl: deps.setTimeoutImpl,
    clearTimeoutImpl: deps.clearTimeoutImpl,
    config,
    processDiaryItem: deps.processDiaryItem ?? diaryRuntime?.processDreamItem,
    reconcileDreamBacklog:
      deps.reconcileDreamBacklog ?? diaryRuntime?.reconcileDreamBacklog,
    logger,
  });

  core.recoverFromCrash();

  let server!: { stop(force?: boolean): void };
  const baseLifecycleDeps: WorkerServerDeps = {
    ...deps,
    db,
    config,
    sessionEnvRegistry,
    hasLiveSessionsImpl: () => sessionEnvRegistry.size > 0,
    getGlobalScanInFlightImpl: core.getGlobalScanInFlight,
    isDreamRunningImpl: () => diaryRuntime?.isDreamRunning?.() ?? false,
    abortDreamImpl: async () => {
      await diaryRuntime?.abortDream?.("shutdown");
    },
    beginGracefulExitImpl: () => {
      serverState.shuttingDown = true;
      core.beginGracefulExit();
    },
    shutdownGracefullyImpl: async () => {
      await deps.shutdownGracefullyImpl?.();
      server.stop(true);
    },
    logger,
  };
  const hardExitTimer = createHardExitTimer({
    ...baseLifecycleDeps,
    config,
    sessionEnvRegistry,
    beginGracefulExitImpl: baseLifecycleDeps.beginGracefulExitImpl!,
  });
  const lifecycleDeps: WorkerServerDeps = {
    ...baseLifecycleDeps,
    hardExitTimerImpl: hardExitTimer,
  };

  const fetchHandler = createWorkerFetchHandler(
    {
      ...deps,
      db,
      config,
      sessionEnvRegistry,
      scanAndDrainQueue: core.scanAndDrainQueue,
      handleTurnStopImpl: core.handleTurnStop,
      handleFlushImpl: core.finishSession,
      handleCompactImpl: core.handleCompact,
      registerSessionEnvImpl: core.registerSessionEnv,
      clearSessionEnvImpl: core.clearSessionEnv,
      hardExitTimerImpl: hardExitTimer,
      // Injecting core pieces above leaves the fetch factory's internal
      // runtime unset, so /dream must be wired explicitly or it 503s.
      handleDreamImpl: deps.handleDreamImpl ?? core.triggerManualDream,
    },
    serverState,
  );
  try {
    server = BunServeImpl({
      port: WORKER_PORT,
      hostname: "127.0.0.1",
      fetch: fetchHandler,
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

  setInterval(() => {
    ensureWorkerPidFile(deps);
    // Off the startup path and off every request path: the first slice runs one
    // watchdog interval after boot, each slice is budget-bounded, and the tick
    // retires itself once the repair is done.
    core.runTranscriptRepairTick();
  }, WATCHDOG_INTERVAL_MS);
  setInterval(() => {
    void (async () => {
      const didShutdown = await checkForLastAgentShutdown(
        serverState,
        lifecycleDeps,
      );
      if (!didShutdown) {
        await checkForIdleWorkerShutdown(serverState, lifecycleDeps);
      }
    })();
  }, WATCHDOG_INTERVAL_MS);

  registerShutdownCleanup(lifecycleDeps);
}

function isDirectExecution(): boolean {
  const entry = process.argv[1] ?? "";
  return entry.endsWith("/server.ts") || entry.endsWith("/worker.cjs");
}

if (isDirectExecution()) {
  void main();
}
