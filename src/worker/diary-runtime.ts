import type { Database } from "bun:sqlite";

import { createDiaryStateStore } from "../db/diary-state";
import type { PendingQueueItem } from "../db/pending-queue";
import { DreamMemoryStore } from "../diary/memory-store";
import { computeDiaryWatermark } from "../diary/domain";
import { dreamTriggerWindow } from "../diary/calendar";
import { buildIsolatedEnv } from "../mnemosyne/env";
import { loadConfig, type MnemoConfig } from "../shared/config";
import {
  formatErrorForPersistence,
  type SensitiveEnv,
} from "../shared/error-sanitizer";
import {
  createDiaryAgentRunner,
  type DiaryAgentQueryRequest,
} from "./diary-agent-runner";
import { createDiarySdkQuery } from "./diary-sdk-query";
import { loadDiaryMaterial } from "./diary-material";
import {
  createDreamJobProcessor,
  type DreamJobProcessOptions,
  type DreamJobProcessResult,
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
  processDreamDate(
    date: string,
    options?: DreamJobProcessOptions,
  ): Promise<DreamJobProcessResult>;
  readLastSuccessfulDate(): Promise<string | null>;
  nowEpoch?: () => number;
  timeZone: string;
  boundaryHour?: number;
  sensitiveEnv?: SensitiveEnv;
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
        const result = await options.processDreamDate(date, {
          regenerate: dayState?.needsRegen === true && !committedButUnsettled,
        });
        options.stateStore.settleDreamDay({
          date,
          queueSeq: item.seq,
          watermark: processedWatermark,
          settledAtEpoch: nowEpoch(),
          remoteAttemptSucceeded: result.remoteAttemptSucceeded,
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
        options.stateStore.recordDreamFailure({
          date,
          queueSeq: item.seq,
          error: formatErrorForPersistence(error, options.sensitiveEnv),
          failedAtEpoch,
          outcome: isShutdownAbort
            ? "shutdown"
            : classification === "connection" || classification === "blocked"
              ? "transient"
              : "permanent",
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
  sensitiveEnv?: SensitiveEnv;
  workerEnv?: NodeJS.ProcessEnv;
}

export interface DiaryRuntime {
  reconcileDreamBacklog(nowEpoch: number): Promise<string[]>;
  processDreamDate(date: string): Promise<void>;
  processDreamItem(
    item: PendingQueueItem,
    agentEnv?: NodeJS.ProcessEnv,
  ): Promise<void>;
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
  const operationalBaseline = buildIsolatedEnv(
    options.workerEnv ?? process.env,
    {},
  );
  let activeAgentEnv = operationalBaseline;
  const agentRunner = createDiaryAgentRunner({
    runQuery: (request) =>
      runQuery({ ...request, agentEnv: activeAgentEnv }),
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
    sensitiveEnv: options.sensitiveEnv,
  });

  let activeDream: Promise<void> | null = null;

  function trackDream(
    work: () => Promise<void>,
    agentEnv: NodeJS.ProcessEnv = operationalBaseline,
  ): Promise<void> {
    if (activeDream) {
      return Promise.reject(new Error("Dream processing is already running."));
    }

    activeAgentEnv = { ...agentEnv };
    let operation: Promise<void>;
    try {
      operation = work();
    } catch (error) {
      activeAgentEnv = operationalBaseline;
      throw error;
    }
    const tracked = operation.finally(() => {
      if (activeDream === tracked) {
        activeDream = null;
      }
      activeAgentEnv = operationalBaseline;
    });
    activeDream = tracked;
    // Lifecycle abort waits on this same operation; pre-handle the rejection so
    // shutdown cannot create an unhandled-rejection window before the queue
    // drain observes the original error.
    tracked.catch(() => {});
    return tracked;
  }

  return {
    async reconcileDreamBacklog(nowEpoch) {
      const triggerWindow = dreamTriggerWindow({
        nowEpoch,
        timeZone: config.dreamAgentTimeZone,
        triggerHour: config.dreamAgentHour,
      });
      const { cutoverDate } = stateStore.initializeBootstrap(
        triggerWindow.today,
      );
      if (!triggerWindow.hasPassedTrigger) {
        return [];
      }
      return stateStore.reconcileBacklog({
        today: triggerWindow.today,
        cutoverDate,
        lastSuccessfulDate: await dreamStore.readLastSuccessfulDate(),
        maxDays: config.dreamAgentBacklogLimit,
        timeZone: config.dreamAgentTimeZone,
        boundaryHour: config.dreamAgentHour,
        enqueuedAtEpoch: nowEpoch,
      });
    },
    processDreamDate: (date) =>
      trackDream(async () => {
        await processDreamDateRaw(date);
      }),
    processDreamItem: (item, agentEnv) =>
      trackDream(() => dreamQueue.process(item), agentEnv),
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
