import type { DiaryAgentToolHandlers } from "./diary-agent-tools";
import {
  DEFAULT_DREAM_AGENT_TIMEOUT_MS,
  DEFAULT_DREAM_AGENT_IDLE_WATCHDOG_MS,
  DEFAULT_DREAM_AGENT_MODEL,
  type DreamAgentModel,
} from "../shared/config";
import {
  createWorkerAbortError,
  type WorkerAbortReason,
} from "./error-classifier";

export interface DiaryAgentRunInput {
  date: string;
  prompt: string;
  toolHandlers: DiaryAgentToolHandlers;
  /** Defaults to the configured product generation's reviewed dream model. */
  model?: DreamAgentModel;
}

export interface DiaryAgentQueryRequest extends DiaryAgentRunInput {
  model: DreamAgentModel;
  timeoutMs: number;
  watchdogMs: number;
  signal: AbortSignal;
  reportActivity(): void;
}

export interface CreateDiaryAgentRunnerOptions {
  runQuery(request: DiaryAgentQueryRequest): Promise<string>;
  timeoutMs?: number;
  watchdogMs?: number;
}

export interface DiaryAgentRunner {
  run(input: DiaryAgentRunInput): Promise<string>;
}

export interface ManagedDiaryAgentRunner extends DiaryAgentRunner {
  isRunning(): boolean;
  abort(reason: WorkerAbortReason): Promise<void>;
}

export function createDiaryAgentRunner(
  options: CreateDiaryAgentRunnerOptions,
): ManagedDiaryAgentRunner {
  const timeoutMs = options.timeoutMs ?? DEFAULT_DREAM_AGENT_TIMEOUT_MS;
  const watchdogMs = options.watchdogMs ?? DEFAULT_DREAM_AGENT_IDLE_WATCHDOG_MS;
  let pendingAbortReason: WorkerAbortReason | null = null;
  let active:
    | {
        controller: AbortController;
        reason: "timeout" | WorkerAbortReason | null;
        completion: Promise<void>;
        finish(): void;
      }
    | null = null;

  return {
    run(input) {
      if (active) {
        return Promise.reject(new Error("Diary agent request is already running."));
      }
      if (pendingAbortReason) {
        const reason = pendingAbortReason;
        pendingAbortReason = null;
        return Promise.reject(
          createWorkerAbortError(
            reason,
            reason === "shutdown"
              ? "Diary agent request aborted for worker shutdown."
              : undefined,
          ),
        );
      }

      const controller = new AbortController();
      let finished = false;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      let finish!: () => void;
      const completion = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const current = {
        controller,
        reason: null as "timeout" | WorkerAbortReason | null,
        completion,
        finish,
      };
      active = current;

      const abort = (reason: "timeout" | WorkerAbortReason): void => {
        if (controller.signal.aborted) {
          return;
        }

        current.reason = reason;
        controller.abort();
      };
      const armWatchdog = (): void => {
        if (finished || controller.signal.aborted) {
          return;
        }

        clearTimeout(watchdog);
        watchdog = setTimeout(() => abort("stall-watchdog"), watchdogMs);
      };
      const timeout = setTimeout(() => abort("timeout"), timeoutMs);
      armWatchdog();

      return (async () => {
        try {
          return await options.runQuery({
            ...input,
            model: input.model ?? DEFAULT_DREAM_AGENT_MODEL,
            timeoutMs,
            watchdogMs,
            signal: controller.signal,
            reportActivity: armWatchdog,
          });
        } catch (error) {
          if (current.reason === "stall-watchdog") {
            throw createWorkerAbortError(
              "stall-watchdog",
              `Diary agent request watchdog timed out after ${watchdogMs}ms.`,
            );
          }

          if (current.reason === "shutdown") {
            throw createWorkerAbortError(
              "shutdown",
              "Diary agent request aborted for worker shutdown.",
            );
          }

          if (current.reason === "timeout") {
            throw new Error(`Diary agent request timed out after ${timeoutMs}ms.`);
          }

          throw error;
        } finally {
          finished = true;
          clearTimeout(timeout);
          clearTimeout(watchdog);
          if (active === current) {
            active = null;
          }
          current.finish();
        }
      })();
    },
    isRunning() {
      return active !== null;
    },
    async abort(reason) {
      const current = active;
      if (!current) {
        // The runtime can enter shutdown while the dream job is still seeding
        // staging, before run() has installed its query controller. Arm the
        // next run so that setup cannot cross the shutdown boundary and launch
        // a fresh Claude request.
        pendingAbortReason = reason;
        return;
      }
      // Shutdown wins even if a timeout/watchdog fired one microtask earlier:
      // while the request is still active it belongs to the shutdown path and
      // must not consume a deterministic attempt.
      current.reason = reason;
      if (!current.controller.signal.aborted) {
        current.controller.abort();
      }
      await current.completion;
    },
  };
}
