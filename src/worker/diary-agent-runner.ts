import type { DiaryAgentToolHandlers } from "./diary-agent-tools";
import {
  DEFAULT_DREAM_AGENT_TIMEOUT_MS,
  DEFAULT_DREAM_AGENT_MODEL,
  type DreamAgentModel,
} from "../shared/config";

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

export function createDiaryAgentRunner(
  options: CreateDiaryAgentRunnerOptions,
): DiaryAgentRunner {
  const timeoutMs = options.timeoutMs ?? DEFAULT_DREAM_AGENT_TIMEOUT_MS;
  const watchdogMs = options.watchdogMs ?? 120_000;

  return {
    async run(input) {
      const controller = new AbortController();
      let abortReason: "timeout" | "watchdog" | null = null;
      let finished = false;
      let watchdog: ReturnType<typeof setTimeout> | undefined;

      const abort = (reason: "timeout" | "watchdog"): void => {
        if (controller.signal.aborted) {
          return;
        }

        abortReason = reason;
        controller.abort();
      };
      const armWatchdog = (): void => {
        if (finished || controller.signal.aborted) {
          return;
        }

        clearTimeout(watchdog);
        watchdog = setTimeout(() => abort("watchdog"), watchdogMs);
      };
      const timeout = setTimeout(() => abort("timeout"), timeoutMs);
      armWatchdog();

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
        if (abortReason === "watchdog") {
          throw new Error(
            `Diary agent request watchdog timed out after ${watchdogMs}ms.`,
          );
        }

        if (abortReason === "timeout") {
          throw new Error(`Diary agent request timed out after ${timeoutMs}ms.`);
        }

        throw error;
      } finally {
        finished = true;
        clearTimeout(timeout);
        clearTimeout(watchdog);
      }
    },
  };
}
