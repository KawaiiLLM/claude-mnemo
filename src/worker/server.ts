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
import { isBuildStaleForDatabase } from "../db/build-state";
import { createDatabase, runWriteTransaction } from "../db/database";
import { createDiaryStateStore } from "../db/diary-state";
import { contentDateAt } from "../diary/calendar";
import {
  getSession,
  getSessionByContentId,
  updateCompactAnchor,
} from "../db/sessions";
import { settleOutstandingTurns } from "../db/turn-settlement";
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
  enqueueBackfillNoteSettlementJob,
  type NoteSettlementInsertRefusal,
  type NoteSettlementJob,
} from "../db/note-settlement";
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
 * captured work, the note-settlement trigger and the nightly dream claim —
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
  /**
   * True once a DIFFERENT build has migrated this database since this worker
   * booted (db/build-state.ts). Testing seam; the default asks the database.
   */
  isStaleBuildImpl?: () => boolean;
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
  handleSettleImpl?: (request: ManualSettleRequest) => ManualSettleResult;
  /**
   * Dispatches the target session's due settlement jobs right after a manual
   * `/settle` enqueue succeeds — the operator's call is the content event.
   */
  drainSettleSessionImpl?: (sessionDbId: number) => Promise<unknown>;
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
  /** The server's own bound port; defaults to `WORKER_PORT`. Threaded through so the request gate below checks against the port actually listening, not a hardcoded assumption. */
  port?: number;
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

/**
 * Result of a manual `POST /settle` backfill: either the one job it created, or
 * a NAMED refusal plus the status the fetch handler echoes.
 *
 * The reason is a stable identifier rather than only prose because this is an
 * operator surface driven from a shell: "nothing happened" is not something a
 * human can act on, and each refusal here has a different repair (widen the
 * range, fix the inversion, look at the job that already exists).
 */
export type ManualSettleRefusal =
  | NoteSettlementInsertRefusal
  | "invalid_payload"
  | "unknown_session"
  | "settlement_disabled"
  | "no_era_cutoff";

export type ManualSettleResult =
  | { ok: true; job: NoteSettlementJob }
  | { ok: false; status: number; reason: ManualSettleRefusal; message: string };

/** The window `POST /settle` names, before anything has been validated. */
export interface ManualSettleRequest {
  sessionId: unknown;
  windowStart: unknown;
  windowEnd: unknown;
  /**
   * Exactly `true` crosses the era floor; anything else leaves it standing.
   * The operator's explicit word, never a default — see `below_era_floor`'s
   * rationale in db/note-settlement.ts.
   */
  allowPreEra?: unknown;
}

const MANUAL_SETTLE_REFUSAL_STATUS: Record<
  NoteSettlementInsertRefusal,
  number
> = {
  // Not a range at all, and not a range any state of the database could make
  // legal — the payload itself is wrong.
  inverted_range: 400,
  // Same kind of refusal as inverted_range — a payload-shape problem, not a
  // database-state one — so it gets the same status (ticket 04: backfill has
  // no lookback and no monotonic floor, so this is its one size ceiling).
  backfill_too_large: 400,
  // The one bound a backfill may never cross: pre-cutoff turns were graded
  // under legacy semantics that must not be mixed into a post-era window.
  below_era_floor: 409,
  // Unreachable while the exemption holds; reported rather than mapped away so
  // a regression names itself instead of arriving as a plausible other reason.
  below_window_floor: 409,
  // UNIQUE(session, window_start, 'backfill') already holds this window.
  duplicate_window: 409,
};

const MANUAL_SETTLE_REFUSAL_MESSAGE: Record<
  NoteSettlementInsertRefusal,
  string
> = {
  inverted_range: "window_end is before window_start",
  backfill_too_large:
    "window spans more than the configured backfill cap " +
    "(noteSettlementBackfillMaxTurns); narrow the range and re-run",
  below_era_floor:
    "window_start is at or below the session's last pre-era prompt number; " +
    "pass allow_pre_era: true to re-settle pre-era turns deliberately",
  below_window_floor:
    "window_start is below the monotonic settlement floor, which a backfill should be exempt from",
  duplicate_window:
    "a backfill job for this session and window_start already exists",
};

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
   * Enqueue ONE explicit backfill window (`POST /settle`). Deliberately an
   * operator surface and not an MCP tool: an MCP tool would hand the main agent
   * a lever over the grading of its own record.
   *
   * It enqueues and stops there — no planning, no range guessing. Dispatch is
   * kicked by the fetch layer via `noteSettlement.drainSession` in the same
   * request: the original "the next content event's leak picks it up" design
   * was falsified for ACTIVE sessions ([S15069/T1014] — their own turn-stops
   * are threshold-gated and the leak excludes the caller), so a manual call is
   * itself the event, or the row strands.
   */
  settleBackfillWindow(request: ManualSettleRequest): ManualSettleResult;
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
  // Wall clock on purpose, and captured once: the stamp this is compared against
  // is written with the same clock, and an injected `now` is a test's fiction
  // that has no bearing on when another process migrated the database.
  const workerBootEpoch = Math.floor(Date.now() / 1000);
  const isStaleBuild =
    deps.isStaleBuildImpl ??
    (() => isBuildStaleForDatabase(deps.db, BUILD_ID, workerBootEpoch));
  const noteSettlement: NoteSettlementScheduler = createNoteSettlementScheduler({
    db: deps.db,
    config,
    now,
    nowMs,
    dispatch: deps.noteSettlementDispatchImpl,
    // "Closed" is derived, never stored: a session counts as live exactly while
    // its env registration is present, which is worker memory, not a column.
    activeSessionIds: () => contentSessionIdByDbId.keys(),
    // Two reasons to claim nothing, and one latch for both (ticket 08). A stale
    // build is the graceful-exit window arriving from the outside: this process
    // is about to go away either way, and until it does, every claim it makes
    // runs the PREVIOUS release's SQL against a schema somebody else migrated.
    // The latch already gates before claiming, refunds the attempt on a claim
    // that raced it, leaves the job durable and blocks the leak outright — which
    // is exactly what a stale build owes the work it must not touch.
    isGracefulExit:
      deps.isGracefulExitImpl ?? (() => gracefulExitWindow || isStaleBuild()),
    logger,
  });

  /**
   * Run the settlement trigger. Wrapped so a settlement fault can never fail
   * the content event that carried it — capture outranks settlement, and a
   * settled window is recoverable from the durable job row anyway.
   *
   * Turn-stop planning is the ONLY automatic trigger (ticket 04, [S15069/T963]):
   * settlement reads the database, never live context, so compact's own
   * repaired boundary and a session's live end carry nothing this needs, and
   * check-natured work does not need either event's immediacy. `handleCompact`
   * below no longer calls this at all — see its own comment.
   */
  async function runNoteSettlementTrigger(sessionDbId: number): Promise<void> {
    try {
      await noteSettlement.onTurnStop(sessionDbId);
    } catch (error) {
      logger.error?.("note settlement trigger failed", {
        sessionDbId,
        error,
      });
    }
  }

  /**
   * The leak point (spec D7, ticket 05), run after `handleTurnStop`'s own
   * trigger — including the below-threshold case that used to return before
   * any cross-session scan ran at all. Ticket 04 ([S15069/T963]) narrows WHERE
   * this runs from: only turn-stop now, never compact or flush/finishSession
   * (their own handlers no longer call it — see each). A settlement fault
   * here must never fail the content event that carried it, same tolerance as
   * `runNoteSettlementTrigger`.
   */
  async function runNoteSettlementLeak(sessionDbId: number): Promise<void> {
    try {
      await noteSettlement.leakDueSessions(sessionDbId);
    } catch (error) {
      logger.error?.("note settlement leak failed", { sessionDbId, error });
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
   * A `turn-stop` row is the turn's completion event. Completion is what
   * settles the row — `settleOutstandingTurns` (db/turn-settlement.ts, ticket
   * 02) is the one place that knows both "this turn is over" and "here is
   * what it carries". The note-debt ledger reads no event of its own any more
   * (spec D1): owed turns are a derived query `session-init` runs at prompt
   * time. Settling BEFORE the delete matters: the settlement candidate
   * predicate counts a queued turn-stop as evidence, so a row deleted first
   * would leave a turn with no evidence and no terminal status, which the
   * stranded repair would re-enqueue on every end event forever.
   *
   * Every other kind is just dropped — deletion is unconditional below. The only
   * other kind ever seen here was `obs` (observation-queue-teardown ticket): it
   * used to be a wake signal plus a place in the retired extraction agent's input
   * stream, and capture has stopped writing it. A row still sitting in the table
   * from before that change drains through this same unconditional delete the
   * first time it is claimed, and nothing re-enqueues it, so this is also the
   * last time it is ever seen. Its observation's `status` is left exactly as
   * capture wrote it — the turn's own completion (`settleCompletedTurn`) is what
   * retires an observation's status now, not the queue.
   */
  function retireQueueItem(item: PendingQueueItem): void {
    runWriteTransaction(deps.db, () => {
      if (item.kind === "turn-stop") {
        const turn = getTurnById(deps.db, item.targetId);
        if (turn) {
          const eraCutoffEpoch =
            config.eraCutoffEpoch ?? resolveEraCutoff(deps.db);
          settleOutstandingTurns(deps.db, turn.sessionId, eraCutoffEpoch, now());
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
    // The ONLY automatic settlement trigger (spec D9, retargeted by ticket 04,
    // [S15069/T963]). It settles nothing until the threshold's worth of
    // consecutive decided turns have accumulated, so every other turn-stop
    // costs one indexed read.
    await runNoteSettlementTrigger(sessionDbId);
    // The leak (spec D7, ticket 05): unconditional, including the below-
    // threshold case above that just returned without triggering anything of
    // its own. Ticket 04 confines the leak to THIS entry point alone — compact
    // and finish/flush no longer call it (see each).
    await runNoteSettlementLeak(sessionDbId);
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
    // SessionEnd opens no settlement window at all any more (ticket 04,
    // [S15069/T963]): the hook used to freeze and enqueue a `sessionend`
    // window synchronously before this flush was ever notified, but that path
    // is retired — settlement reads the database, not the live context a
    // session's ending carries, so closing a session has no settlement work
    // of its own left to do. Flush no longer runs the leak either: turn-stop
    // is the only entry point the residual/leak piggyback rides now (ticket
    // 04's "残余搭车通道保持、只挂 turn-stop") — an unrelated session's own
    // turn-stop is what eventually picks up anything this session left due.
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

    // Compact creates and triggers NO settlement work any more (ticket 04,
    // [S15069/T963]): settlement reads the database, never live context, so a
    // compact's repaired boundary carries nothing this needs, and
    // check-natured work does not need a compact's immediacy either. The
    // anchor repair above still matters for its OTHER reader (timeline's own
    // boundary marker, `mcp/timeline.ts`) — only settlement's consumption of
    // it is retired. The leak does not run here either: it rides turn-stop
    // alone now (see `handleTurnStop`).
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
    settleBackfillWindow(request: ManualSettleRequest): ManualSettleResult {
      const { sessionId, windowStart, windowEnd } = request;
      if (
        !Number.isInteger(sessionId) ||
        !Number.isInteger(windowStart) ||
        !Number.isInteger(windowEnd) ||
        (windowStart as number) < 1
      ) {
        return {
          ok: false,
          status: 400,
          reason: "invalid_payload",
          message:
            "session_id, window_start and window_end must be integers, and window_start must be at least 1",
        };
      }

      // The same two gates every settlement path checks, and refused BEFORE the
      // insert for the same reason the dream refuses before enqueueing: a job
      // recorded into a system that cannot dispatch it would burn its three
      // attempts on a payload that is not there and go terminal.
      const eraCutoffEpoch = config.eraCutoffEpoch ?? resolveEraCutoff(deps.db);
      if (!config.settlementEnabled) {
        return {
          ok: false,
          status: 503,
          reason: "settlement_disabled",
          message: "note settlement is disabled (set settlementEnabled to true)",
        };
      }
      if (eraCutoffEpoch === null) {
        return {
          ok: false,
          status: 503,
          reason: "no_era_cutoff",
          message: "no era cutoff is recorded; every turn is legacy",
        };
      }

      if (!getSession(deps.db, sessionId as number)) {
        return {
          ok: false,
          status: 404,
          reason: "unknown_session",
          message: `no session ${sessionId}`,
        };
      }

      const result = enqueueBackfillNoteSettlementJob(
        deps.db,
        sessionId as number,
        windowStart as number,
        windowEnd as number,
        now(),
        eraCutoffEpoch,
        {
          allowPreEra: request.allowPreEra === true,
          maxTurns: config.noteSettlementBackfillMaxTurns,
        },
      );
      if (result.ok) {
        return { ok: true, job: result.job };
      }
      return {
        ok: false,
        status: MANUAL_SETTLE_REFUSAL_STATUS[result.reason],
        reason: result.reason,
        message: MANUAL_SETTLE_REFUSAL_MESSAGE[result.reason],
      };
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

/** Why a request was refused by {@link evaluateRequestGate}. */
export type RequestGateRejectionReason = "host" | "origin" | "sec-fetch-site";

export type RequestGateVerdict =
  | { allowed: true }
  | { allowed: false; reason: RequestGateRejectionReason };

/**
 * The DNS-rebinding gate (memory-console spec, "Security posture"; ticket
 * 02). A pure function of the request's own headers and the port this server
 * is actually bound to — no `Request`/`URL` object, no server state — so the
 * gate matrix can hit it directly AND the fetch handler below can apply the
 * identical verdict to every route, before any dispatch.
 *
 * Three independent checks, each violating the loopback-only contract in a
 * different way an attacker can reach it:
 *   - `Host` must equal the bound loopback host:port. This is the DNS-
 *     rebinding defense itself: a browser that resolved a hostile domain to
 *     127.0.0.1 still sends that domain's name as `Host`, not "127.0.0.1" —
 *     so an exact match here is the one thing DNS control cannot forge.
 *   - `Origin`, when a browser sends one (any cross-origin fetch, and most
 *     same-origin POSTs), must equal the loopback origin — belt-and-braces
 *     against a same-`Host` request that a compromised loopback-adjacent
 *     process still shouldn't be allowed to forge without the browser's own
 *     origin tag agreeing.
 *   - `Sec-Fetch-Site`, when the browser sends one (it does not on older
 *     browsers or non-fetch clients — hence `none` and absence are both
 *     accepted, never treated as a violation on their own), must say the
 *     request did not cross an origin boundary.
 *
 * Absent `Host` is a REJECTION, not a pass-through: every real HTTP/1.1
 * request carries one (it is not optional at the wire level), so an absent
 * value here only ever means a synthetic, non-network `Request` — a shape a
 * genuine browser or loopback client never produces.
 */
export function evaluateRequestGate(
  headers: Headers,
  port: number,
): RequestGateVerdict {
  const loopbackHosts = [`127.0.0.1:${port}`, `localhost:${port}`];

  const host = headers.get("host");
  if (host === null || !loopbackHosts.includes(host)) {
    return { allowed: false, reason: "host" };
  }

  const origin = headers.get("origin");
  if (origin !== null) {
    const loopbackOrigins = [
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
    ];
    if (!loopbackOrigins.includes(origin)) {
      return { allowed: false, reason: "origin" };
    }
  }

  const secFetchSite = headers.get("sec-fetch-site");
  if (
    secFetchSite !== null &&
    secFetchSite !== "same-origin" &&
    secFetchSite !== "none"
  ) {
    return { allowed: false, reason: "sec-fetch-site" };
  }

  return { allowed: true };
}

/**
 * Terse JSON error envelope for a gate rejection — the same `{ error: {
 * code, message } }` shape the console API contract uses elsewhere, adopted
 * here first since the gate ships ahead of any console route. Deliberately
 * NEVER sets `Access-Control-Allow-Origin` (spec: "No `Access-Control-Allow-
 * Origin` header, ever") — omission is the whole point, not an oversight to
 * double-check per response.
 */
function requestGateRejectionResponse(reason: RequestGateRejectionReason): Response {
  return Response.json(
    {
      error: {
        code: "forbidden",
        message: `request rejected by the loopback request gate: ${reason}`,
      },
    },
    { status: 403 },
  );
}

export function createWorkerFetchHandler(
  deps: WorkerServerDeps = {},
  state: WorkerServerState = createWorkerServerState(deps.nowMs?.() ?? Date.now()),
): (req: Request) => Promise<Response> {
  const port = deps.port ?? WORKER_PORT;
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
  const handleSettleImpl: (request: ManualSettleRequest) => ManualSettleResult =
    deps.handleSettleImpl ??
    runtime?.settleBackfillWindow ??
    (() => ({
      ok: false,
      status: 503,
      reason: "settlement_disabled",
      message: "settlement runtime unavailable",
    }));
  const registerSessionEnvImpl =
    deps.registerSessionEnvImpl ?? runtime?.registerSessionEnv;
  const clearSessionEnvImpl =
    deps.clearSessionEnvImpl ?? runtime?.clearSessionEnv;
  const drainSettleSessionImpl = deps.drainSettleSessionImpl;
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
      // Before ALL route dispatch (memory-console spec, "Security posture";
      // ticket 02) — covers every existing route below and every console
      // route ticket 03 adds, from one shared gate rather than a per-route
      // check that a new route could forget to add.
      const gateVerdict = evaluateRequestGate(req.headers, port);
      if (!gateVerdict.allowed) {
        return requestGateRejectionResponse(gateVerdict.reason);
      }

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
          action?: "capture" | "turn-stop" | "compact" | "finish";
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

      // Operator-only, by construction: settlement's other entry points are all
      // content events, and re-grading a stretch of history is a decision a
      // human makes about the record — not one the agent being recorded gets to
      // make about itself. This never plans and never guesses a range; the
      // caller states one, and exactly one job comes of it.
      if (req.method === "POST" && url.pathname === "/settle") {
        const payload = (await req.json()) as {
          session_id?: unknown;
          window_start?: unknown;
          window_end?: unknown;
          allow_pre_era?: unknown;
        };
        const result = handleSettleImpl({
          sessionId: payload.session_id,
          windowStart: payload.window_start,
          windowEnd: payload.window_end,
          allowPreEra: payload.allow_pre_era,
        });
        // Manual means dispatched: without this kick an ACTIVE session's
        // backfill strands in the scheduling blind spot (its own turn-stops
        // are threshold-gated, the leak excludes the caller). Background —
        // a settle runs minutes; the operator polls the job row for the
        // verdict, and the response says only that dispatch began.
        const kickDrain = (sessionDbId: number): "started" | "unavailable" => {
          const drain = drainSettleSessionImpl?.(sessionDbId);
          if (!drain) {
            return "unavailable";
          }
          trackGlobalWork(
            drain.then(
              () => undefined,
              (error) => {
                deps.logger?.error?.("manual settle dispatch failed", {
                  sessionId: sessionDbId,
                  error,
                });
              },
            ),
          );
          return "started";
        };
        if (!result.ok) {
          // `duplicate_window` names a job that already EXISTS and is due —
          // the operator's intent ("run this window") is servable even though
          // the enqueue is refused; without this kick a stranded row would
          // need a fresh window enqueued beside it just to hitch a ride on
          // its drain. Every other refusal has nothing to dispatch.
          const dispatch =
            result.reason === "duplicate_window" &&
            Number.isInteger(payload.session_id)
              ? kickDrain(payload.session_id as number)
              : undefined;
          return Response.json(
            {
              ok: false,
              reason: result.reason,
              message: result.message,
              ...(dispatch === undefined ? {} : { dispatch }),
            },
            { status: result.status },
          );
        }
        return Response.json({
          ok: true,
          job: result.job,
          dispatch: kickDrain(result.job.sessionId),
        });
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

/**
 * Get off a schema somebody else migrated (ticket 08).
 *
 * Same shape as `checkForLastAgentShutdown` with one guard deliberately absent:
 * there is no `hasLiveSessions()` check. Waiting for the user to close the
 * session would leave a stale worker resident for hours, and the whole point of
 * leaving is that this process can no longer be trusted with a write. Exiting is
 * also the repair: the next hook event lazily starts a worker from whatever
 * version the hook itself resolves to, which is by construction the build that
 * migrated the database.
 *
 * Nothing is torn out from under itself. New claims stopped at the settlement
 * latch the moment this went stale, so the guards below describe work that is
 * already in flight and is left to finish; each watchdog beat re-asks, and the
 * exit happens on the first beat where the process is genuinely idle.
 */
export async function checkForStaleBuildShutdown(
  state: WorkerServerState,
  deps: WorkerServerDeps = {},
): Promise<boolean> {
  const isStaleBuild = deps.isStaleBuildImpl ?? (() => false);
  if (!isStaleBuild()) {
    return false;
  }

  const isDreamRunning = deps.isDreamRunningImpl ?? (() => false);

  if (state.shuttingDown || state.activeRequests > 0) {
    return false;
  }

  const dreamWasRunning = isDreamRunning();
  const serverWork = state.globalScanInFlight;
  const coreWork = deps.getGlobalScanInFlightImpl?.() ?? null;

  // Same division as the last-agent path: ordinary queue work is a hard guard
  // and gets the next beat, a dream is the sole exception because its query has
  // to be aborted before the global drain carrying it can ever settle.
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

    // Work may have arrived while the dream/global drain unwound. Staleness is
    // not re-asked: it is monotone — the foreign stamp that caused it cannot be
    // taken back — so only the guards that can still change are re-read.
    if (
      state.activeRequests > 0 ||
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
  // Before `initializeDatabase` below, so the window this covers starts as early
  // as it can. Our OWN stamp can never make us stale, so recording it a moment
  // after this line is not a self-accusation (db/build-state.ts).
  const workerBootEpoch = Math.floor(Date.now() / 1000);
  const isStaleBuildImpl =
    deps.isStaleBuildImpl ??
    (() => isBuildStaleForDatabase(db, BUILD_ID, workerBootEpoch));
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
  // The cutover catch-up (spec D13, "收编重造"; table retired outright by
  // ticket 05). `initializeDatabase` already folds any surviving legacy
  // `turn_citations` rows into `memory_edges` and drops the table on the FIRST
  // process to open a pre-ticket-05 database — but that runs on every hook
  // process's critical path, so it cannot be where a slow, best-effort sweep
  // lives. This call is now a safety net for whatever window exists between a
  // hook process finishing that drop and this worker tick observing it: once
  // the table is gone, `migrateTurnCitationsToEdges` is a guarded no-op
  // (idempotent either way — the pair primary key absorbs a re-run).
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
          model: config.noteSettlementModel,
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
    // Shared with the lifecycle deps below rather than left to the core's own
    // default, so both halves of this check — the claim latch and the exit —
    // answer from one boot epoch and can never disagree about being stale.
    isStaleBuildImpl,
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
    isStaleBuildImpl,
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
      // runtime unset, so /dream and /settle must be wired explicitly or they
      // 503s.
      handleDreamImpl: deps.handleDreamImpl ?? core.triggerManualDream,
      handleSettleImpl: deps.handleSettleImpl ?? core.settleBackfillWindow,
      drainSettleSessionImpl:
        deps.drainSettleSessionImpl ??
        ((sessionDbId) => core.noteSettlement.drainSession(sessionDbId)),
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
      // Stale first: it is the only one of the three that must not wait for the
      // user to close a session, and once it fires the other two have nothing
      // left to decide.
      if (await checkForStaleBuildShutdown(serverState, lifecycleDeps)) {
        return;
      }
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
