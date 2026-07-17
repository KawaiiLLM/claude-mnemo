import type { Database } from "bun:sqlite";

import { createDiaryStateStore } from "../db/diary-state";
import type { PendingQueueItem } from "../db/pending-queue";
import { DreamMemoryStore } from "../diary/memory-store";
import { computeDiaryWatermark } from "../diary/domain";
import { loadConfig, type MnemoConfig } from "../shared/config";
import {
  createDiaryAgentRunner,
  type DiaryAgentQueryRequest,
} from "./diary-agent-runner";
import { createDiarySdkQuery } from "./diary-sdk-query";
import { loadDiaryMaterial } from "./diary-material";
import {
  createDreamJobProcessor,
  type DreamJobProcessOptions,
} from "./dream-job";
import {
  classifyWorkerError,
  type WorkerAbortReason,
} from "./error-classifier";

export interface CreateDreamQueueProcessorOptions {
  db: Database;
  stateStore: Pick<
    ReturnType<typeof createDiaryStateStore>,
    | "settleDreamDay"
    | "recordDreamFailure"
    | "markDayStaleAndEnqueue"
    | "getDayState"
  >;
  processDreamDate(date: string, options?: DreamJobProcessOptions): Promise<void>;
  readLastSuccessfulDate(): Promise<string | null>;
  nowEpoch?: () => number;
  timeZone: string;
  boundaryHour?: number;
}

function dreamDateFromQueueItem(item: PendingQueueItem): string {
  if (item.kind !== "diary" || item.sessionDbId !== 0) {
    throw new Error(`Not a dream queue item: seq=${item.seq}`);
  }
  const digits = String(item.targetId);
  if (!/^\d{8}$/.test(digits)) {
    throw new Error(`Invalid dream queue target: ${item.targetId}`);
  }
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

export function createDreamQueueProcessor(
  options: CreateDreamQueueProcessorOptions,
): { process(item: PendingQueueItem): Promise<void> } {
  const nowEpoch = options.nowEpoch ?? (() => Math.floor(Date.now() / 1_000));
  const watermarkFor = (date: string) =>
    computeDiaryWatermark(
      loadDiaryMaterial(options.db, date, options.timeZone, options.boundaryHour),
    );

  return {
    async process(item) {
      const date = dreamDateFromQueueItem(item);
      try {
        const processedWatermark = watermarkFor(date);
        const dayState = options.stateStore.getDayState(date);
        const lastSuccessfulDate = await options.readLastSuccessfulDate();
        const committedButUnsettled =
          dayState?.needsRegen === true &&
          dayState.settledAtEpoch === null &&
          lastSuccessfulDate === date;
        await options.processDreamDate(date, {
          regenerate: dayState?.needsRegen === true && !committedButUnsettled,
        });
        options.stateStore.settleDreamDay({
          date,
          queueSeq: item.seq,
          watermark: processedWatermark,
          settledAtEpoch: nowEpoch(),
        });

        // A turn can finalize while the dream transaction is in flight. Close
        // that race after settlement so the date is queued again if needed.
        if (watermarkFor(date) !== processedWatermark) {
          options.stateStore.markDayStaleAndEnqueue({
            date,
            enqueuedAtEpoch: nowEpoch(),
          });
        }
      } catch (error) {
        const failedAtEpoch = nowEpoch();
        const classification = classifyWorkerError(error);
        const isShutdownAbort =
          typeof error === "object" &&
          error !== null &&
          "workerAbortReason" in error &&
          error.workerAbortReason === "shutdown";
        // Connection failures never consume the retry budget, so their retry
        // rate is the only bound on cost: a dream attempt that burns tokens
        // before an idle-watchdog kill must not respin on the 60s cadence
        // (the 0.4.0 burn pattern). Fast-fail outages lose nothing from the
        // longer wait — a dream is never urgent.
        const retryDelaySeconds = isShutdownAbort
          ? 0
          : classification === "connection"
            ? 15 * 60
            : 60;
        options.stateStore.recordDreamFailure({
          date,
          queueSeq: item.seq,
          error: error instanceof Error ? error.message : String(error),
          retryAtEpoch: failedAtEpoch + retryDelaySeconds,
          countAttempt: classification === "deterministic",
        });
        throw error;
      }
    },
  };
}

export interface CreateDiaryRuntimeOptions {
  db: Database;
  dataRoot: string;
  runQuery?: (request: DiaryAgentQueryRequest) => Promise<string>;
  nowEpoch?: () => number;
  config?: MnemoConfig;
}

export interface DiaryRuntime {
  processDreamDate(date: string): Promise<void>;
  processDreamItem(item: PendingQueueItem): Promise<void>;
  isDreamRunning?(): boolean;
  abortDream?(reason: WorkerAbortReason): Promise<void>;
}

export interface ManagedDiaryRuntime extends DiaryRuntime {
  isDreamRunning(): boolean;
  abortDream(reason: WorkerAbortReason): Promise<void>;
}

export function createDiaryRuntime(
  options: CreateDiaryRuntimeOptions,
): ManagedDiaryRuntime {
  const stateStore = createDiaryStateStore(options.db);
  const config = options.config ?? loadConfig();
  const runQuery =
    options.runQuery ??
    createDiarySdkQuery({ dataRoot: options.dataRoot }).runQuery;
  const agentRunner = createDiaryAgentRunner({
    runQuery,
    timeoutMs: config.dreamAgentTimeoutMs,
    watchdogMs: config.dreamAgentIdleWatchdogMs,
  });
  const dreamStore = new DreamMemoryStore(options.dataRoot);
  const dreamJob = createDreamJobProcessor({
    db: options.db,
    dataRoot: options.dataRoot,
    store: dreamStore,
    agentRunner,
    config,
  });
  const processDreamDateRaw = (date: string, processOptions?: DreamJobProcessOptions) =>
    dreamJob.process(date, processOptions);
  const dreamQueue = createDreamQueueProcessor({
    db: options.db,
    stateStore,
    processDreamDate: processDreamDateRaw,
    readLastSuccessfulDate: () => dreamStore.readLastSuccessfulDate(),
    nowEpoch: options.nowEpoch,
    timeZone: config.dreamAgentTimeZone,
    boundaryHour: config.dreamAgentHour,
  });

  let activeDream: Promise<void> | null = null;

  function trackDream(work: () => Promise<void>): Promise<void> {
    if (activeDream) {
      return Promise.reject(new Error("Dream processing is already running."));
    }

    const operation = work();
    const tracked = operation.finally(() => {
      if (activeDream === tracked) {
        activeDream = null;
      }
    });
    activeDream = tracked;
    // Lifecycle abort waits on this same operation; pre-handle the rejection so
    // shutdown cannot create an unhandled-rejection window before the queue
    // drain observes the original error.
    tracked.catch(() => {});
    return tracked;
  }

  return {
    processDreamDate: (date) => trackDream(() => processDreamDateRaw(date)),
    processDreamItem: (item) => trackDream(() => dreamQueue.process(item)),
    isDreamRunning: () => activeDream !== null,
    async abortDream(reason) {
      const dream = activeDream;
      if (!dream) {
        return;
      }
      await agentRunner.abort(reason);
      await dream.catch(() => {});
    },
  };
}
