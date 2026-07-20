import { existsSync, readFileSync } from "node:fs";
import { Database } from "bun:sqlite";

import {
  HOOK_NON_BLOCKING_EXIT_CODE,
  HOOK_SUCCESS_EXIT_CODE,
} from "../shared/hook-constants";
import { createDatabase } from "../db/database";
import { initializeDatabase } from "../db/schema";
import { DiaryFileStore } from "../diary/file-store";
import { DreamMemoryStore } from "../diary/memory-store";
import { DATA_DIR, resolveDatabasePath } from "../shared/paths";
import { normalizeHookInput } from "./adapters";
import { createCompactHandler } from "./handlers/compact";
import {
  createContextHandler,
  createReadOnlyContextHandler,
  type ContextHandlerDependencies,
} from "./handlers/context";
import { createPostCompactHandler } from "./handlers/post-compact";
import { createPostToolUseHandler } from "./handlers/post-tool-use";
import { createMilestoneContextHandler } from "./handlers/context-milestones";
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
let defaultReadOnlyContextHandlers: Record<string, HookHandler> | undefined;
let defaultRecentContextHandler: HookHandler | undefined;
let defaultMilestoneContextHandler: HookHandler | undefined;
const HOOK_DB_BUSY_TIMEOUT_MS = 800;

export interface DefaultHookHandlersDependencies {
  db: ReturnType<typeof createDatabase>;
  dataRoot?: string;
  workerClientDeps?: import("../worker/client").WorkerClientDeps;
  workerEnv?: NodeJS.ProcessEnv;
  enableSessionEnvCapture?: boolean;
}

interface DefaultReadOnlyContextHandlersDependencies {
  dataRoot?: string;
}

function createDefaultReadOnlyContextHandlers({
  dataRoot = DATA_DIR,
}: DefaultReadOnlyContextHandlersDependencies = {}): Record<string, HookHandler> {
  const memoryStore = new DreamMemoryStore(dataRoot);
  const readOnlyDependencies = {
    memoryStore,
  };

  return {
    "SessionStart:persona": createReadOnlyContextHandler(
      readOnlyDependencies,
      "persona",
    ),
  };
}

export function createDefaultHookHandlers({
  db,
  dataRoot = DATA_DIR,
  workerClientDeps,
  workerEnv,
  enableSessionEnvCapture = false,
}: DefaultHookHandlersDependencies): Record<string, HookHandler> {
  const fileStore = new DiaryFileStore(dataRoot);
  const contextDependencies: ContextHandlerDependencies = {
    db,
    workerClientDeps,
    workerEnv,
    enableSessionEnvCapture,
  };

  return {
    ...createDefaultReadOnlyContextHandlers({ dataRoot }),
    "SessionStart:recent": createReadOnlyContextHandler(
      { db, fileStore },
      "recent",
    ),
    "SessionStart:milestones": createMilestoneContextHandler({ db }),
    SessionStart: createContextHandler(contextDependencies),
    SessionEnd: createSessionEndHandler({ db, workerClientDeps, workerEnv }),
    PostToolUse: createPostToolUseHandler({ db, workerClientDeps, workerEnv }),
    PostCompact: createPostCompactHandler({ db }),
    PreCompact: createCompactHandler({ db, workerClientDeps, workerEnv }),
    UserPromptSubmit: createSessionInitHandler({ db }),
    Stop: createStopHandler({ db, workerClientDeps, workerEnv }),
  };
}

function getDefaultHandlers(): Record<string, HookHandler> {
  if (defaultHandlers) {
    return defaultHandlers;
  }

  const db = createDatabase(undefined, { busyTimeoutMs: HOOK_DB_BUSY_TIMEOUT_MS });
  initializeDatabase(db);

  defaultHandlers = createDefaultHookHandlers({
    db,
    workerEnv: process.env,
    enableSessionEnvCapture: true,
  });

  return defaultHandlers;
}

function getDefaultReadOnlyContextHandlers(): Record<string, HookHandler> {
  if (!defaultReadOnlyContextHandlers) {
    defaultReadOnlyContextHandlers = createDefaultReadOnlyContextHandlers();
  }
  return defaultReadOnlyContextHandlers;
}

function getDefaultRecentContextHandler(): HookHandler {
  if (defaultRecentContextHandler) {
    return defaultRecentContextHandler;
  }

  const databasePath = resolveDatabasePath();
  if (!existsSync(databasePath)) {
    defaultRecentContextHandler = async () => ({ continue: true });
    return defaultRecentContextHandler;
  }

  const db = new Database(databasePath, {
    readonly: true,
    create: false,
  });
  defaultRecentContextHandler = createReadOnlyContextHandler(
    { db, fileStore: new DiaryFileStore(DATA_DIR) },
    "recent",
  );
  return defaultRecentContextHandler;
}

function getDefaultMilestoneContextHandler(): HookHandler {
  if (defaultMilestoneContextHandler) {
    return defaultMilestoneContextHandler;
  }

  const databasePath = resolveDatabasePath();
  if (!existsSync(databasePath)) {
    defaultMilestoneContextHandler = async () => ({ continue: true });
    return defaultMilestoneContextHandler;
  }

  const db = new Database(databasePath, {
    readonly: true,
    create: false,
  });
  defaultMilestoneContextHandler = createMilestoneContextHandler({ db });
  return defaultMilestoneContextHandler;
}

function getDefaultHandler(handlerKey: string): HookHandler | undefined {
  if (handlerKey === "SessionStart:recent") {
    return getDefaultRecentContextHandler();
  }
  if (handlerKey === "SessionStart:milestones") {
    return getDefaultMilestoneContextHandler();
  }
  if (handlerKey === "SessionStart:persona") {
    return getDefaultReadOnlyContextHandlers()[handlerKey];
  }
  return getDefaultHandlers()[handlerKey];
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

function contextSectionFromCommandArguments(
  command?: string,
  section?: string,
): "sessions" | "persona" | "recent" | "milestones" {
  if (command !== "context") {
    return "sessions";
  }
  return section === "persona" ||
    section === "recent" ||
    section === "milestones"
    ? section
    : "sessions";
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
    const contextSection = contextSectionFromCommandArguments(argv[2], argv[3]);
    const handlerKey =
      normalizedInput.eventName === "SessionStart" && contextSection !== "sessions"
        ? `SessionStart:${contextSection}`
        : normalizedInput.eventName;
    const handler = dependencies.handlers
      ? dependencies.handlers[handlerKey]
      : getDefaultHandler(handlerKey);

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
