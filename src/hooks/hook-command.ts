import { readFileSync } from "node:fs";

import {
  HOOK_NON_BLOCKING_EXIT_CODE,
  HOOK_SUCCESS_EXIT_CODE,
} from "../shared/hook-constants";
import { createDatabase } from "../db/database";
import { createDiaryStateStore } from "../db/diary-state";
import { initializeDatabase } from "../db/schema";
import { DiaryFileStore } from "../diary/file-store";
import { DreamMemoryStore } from "../diary/memory-store";
import { DATA_DIR } from "../shared/paths";
import { loadConfig, type MnemoConfig } from "../shared/config";
import { normalizeHookInput } from "./adapters";
import { createCompactHandler } from "./handlers/compact";
import { createContextHandler } from "./handlers/context";
import { createPostCompactHandler } from "./handlers/post-compact";
import { createPostToolUseHandler } from "./handlers/post-tool-use";
import { createSessionEndHandler } from "./handlers/session-end";
import { createSessionInitHandler } from "./handlers/session-init";
import { createStopHandler } from "./handlers/stop";
import type { HookHandler, HookResult } from "./types";

export interface HookCommandDependencies {
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  readJsonFromStdin?: () => Record<string, unknown>;
  normalizeHookInputImpl?: typeof normalizeHookInput;
  handlers?: Record<string, HookHandler>;
}

let defaultHandlers: Record<string, HookHandler> | undefined;
const HOOK_DB_BUSY_TIMEOUT_MS = 800;

export interface DefaultHookHandlersDependencies {
  db: ReturnType<typeof createDatabase>;
  dataRoot?: string;
  nowEpoch?: () => number;
  config?: MnemoConfig;
}

export function createDefaultHookHandlers({
  db,
  dataRoot = DATA_DIR,
  nowEpoch,
  config = loadConfig(),
}: DefaultHookHandlersDependencies): Record<string, HookHandler> {
  const diaryStateStore = createDiaryStateStore(db);
  const fileStore = new DiaryFileStore(dataRoot);
  const dreamStore = new DreamMemoryStore(dataRoot);

  return {
    SessionStart: createContextHandler({
      db,
      diaryStateStore,
      fileStore,
      memoryStore: dreamStore,
      nowEpoch,
      dreamSchedule: {
        hour: config.dreamAgentHour,
        timeZone: config.dreamAgentTimeZone,
        backlogLimit: config.dreamAgentBacklogLimit,
      },
      readLastSuccessfulDate: () => dreamStore.readLastSuccessfulDate(),
    }),
    SessionEnd: createSessionEndHandler({ db }),
    PostToolUse: createPostToolUseHandler({ db }),
    PostCompact: createPostCompactHandler({ db }),
    PreCompact: createCompactHandler({ db }),
    UserPromptSubmit: createSessionInitHandler({ db }),
    Stop: createStopHandler({ db }),
  };
}

function getDefaultHandlers(): Record<string, HookHandler> {
  if (defaultHandlers) {
    return defaultHandlers;
  }

  const db = createDatabase(undefined, { busyTimeoutMs: HOOK_DB_BUSY_TIMEOUT_MS });
  initializeDatabase(db);

  defaultHandlers = createDefaultHookHandlers({ db });

  return defaultHandlers;
}

function readJsonFromStdin(): Record<string, unknown> {
  const input = readFileSync(0, "utf8").trim();

  if (input === "") {
    return {};
  }

  return JSON.parse(input) as Record<string, unknown>;
}

function eventNameFromCommandArgument(arg?: string): string | undefined {
  switch (arg) {
    case "context":
      return "SessionStart";
    case "session-end":
      return "SessionEnd";
    case "tool-use":
      return "PostToolUse";
    case "post-compact":
      return "PostCompact";
    case "compact":
      return "PreCompact";
    case "session-init":
      return "UserPromptSubmit";
    case "stop":
      return "Stop";
    default:
      return undefined;
  }
}

function writeHookResult(
  result: HookResult,
  stdout: Pick<NodeJS.WriteStream, "write"> = process.stdout,
): void {
  const output: Record<string, unknown> = {
    continue: result.continue,
  };

  if (result.suppressOutput !== undefined) {
    output.suppressOutput = result.suppressOutput;
  }

  if (result.hookSpecificOutput !== undefined) {
    output.hookSpecificOutput = {
      hookEventName: "SessionStart",
      additionalContext: result.hookSpecificOutput,
    };
  }

  if (Object.keys(output).length > 1 || output.continue !== true) {
    stdout.write(JSON.stringify(output));
  }
}

export async function runHookCommand(
  dependencies: HookCommandDependencies = {},
): Promise<number> {
  const env = dependencies.env ?? process.env;
  const argv = dependencies.argv ?? process.argv;
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const readJson = dependencies.readJsonFromStdin ?? readJsonFromStdin;
  const normalizeInput =
    dependencies.normalizeHookInputImpl ?? normalizeHookInput;

  if (env.CLAUDE_CODE_ENTRYPOINT === "sdk-ts") {
    return HOOK_SUCCESS_EXIT_CODE;
  }

  try {
    const rawInput = readJson();
    const eventNameOverride = eventNameFromCommandArgument(argv[2]);

    if (eventNameOverride && !("event_name" in rawInput) && !("hook_event_name" in rawInput)) {
      rawInput.event_name = eventNameOverride;
    }

    const normalizedInput = normalizeInput(rawInput);
    const handler = (dependencies.handlers ?? getDefaultHandlers())[normalizedInput.eventName];

    if (!handler) {
      return HOOK_SUCCESS_EXIT_CODE;
    }

    const result = await handler(normalizedInput);

    if (result.asyncWork) {
      stdout.write(`${JSON.stringify({ async: true })}\n`);
      await result.asyncWork();
      return HOOK_SUCCESS_EXIT_CODE;
    }

    writeHookResult(result, stdout);

    return result.exitCode ?? HOOK_SUCCESS_EXIT_CODE;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown hook failure";
    stderr.write(`[HOOK] ${message}\n`);
    return HOOK_NON_BLOCKING_EXIT_CODE;
  }
}

function isDirectExecution(): boolean {
  const entry = process.argv[1] ?? "";
  return entry.endsWith("/hook-command.ts") || entry.endsWith("/hook-command.cjs");
}

if (isDirectExecution()) {
  void runHookCommand().then((exitCode) => {
    process.exit(exitCode);
  });
}
