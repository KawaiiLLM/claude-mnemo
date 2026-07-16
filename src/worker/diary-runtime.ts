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
        options.stateStore.recordDreamFailure({
          date,
          queueSeq: item.seq,
          error: error instanceof Error ? error.message : String(error),
          retryAtEpoch: failedAtEpoch + 60,
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
}

export function createDiaryRuntime(
  options: CreateDiaryRuntimeOptions,
): DiaryRuntime {
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
  const processDreamDate = (date: string, processOptions?: DreamJobProcessOptions) =>
    dreamJob.process(date, processOptions);
  const dreamQueue = createDreamQueueProcessor({
    db: options.db,
    stateStore,
    processDreamDate,
    readLastSuccessfulDate: () => dreamStore.readLastSuccessfulDate(),
    nowEpoch: options.nowEpoch,
    timeZone: config.dreamAgentTimeZone,
    boundaryHour: config.dreamAgentHour,
  });

  return {
    processDreamDate,
    processDreamItem: (item) => dreamQueue.process(item),
  };
}
