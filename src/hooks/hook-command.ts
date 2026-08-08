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
import { createPostToolUseHandler } from "./handlers/post-tool-use";
import { createMilestoneContextHandler } from "./handlers/context-milestones";
import { createNoteTakingContextHandler } from "./handlers/context-note-taking";
import { createResultDispatchHandler } from "./handlers/result-dispatch";
import { createSessionEndHandler } from "./handlers/session-end";
import { createSessionInitHandler } from "./handlers/session-init";
import { createStopHandler } from "./handlers/stop";
import {
  createPreToolUseDispatcher,
  createUserPromptSubmitDispatcher,
} from "../rules/pretooluse-dispatcher";
import type { HookEventName, HookHandler, HookResult } from "./types";

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
let defaultDigestContextHandler: HookHandler | undefined;
let defaultMilestoneContextHandler: HookHandler | undefined;
let defaultNoteTakingContextHandler: HookHandler | undefined;
let defaultPreToolUseHandler: HookHandler | undefined;
let defaultUserPromptSubmitDispatcher: HookHandler | undefined;
let defaultResultDispatchHandler: HookHandler | undefined;
let defaultHookDatabase: ReturnType<typeof createDatabase> | undefined;
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
    "SessionStart:digest": createReadOnlyContextHandler({ db }, "digest"),
    "SessionStart:milestones": createMilestoneContextHandler({ db }),
    "SessionStart:notes": createNoteTakingContextHandler(),
    SessionStart: createContextHandler(contextDependencies),
    SessionEnd: createSessionEndHandler({ db, workerClientDeps, workerEnv }),
    PostToolUse: createPostToolUseHandler({ db, workerClientDeps, workerEnv }),
    PreCompact: createCompactHandler({ db, workerClientDeps, workerEnv }),
    UserPromptSubmit: createSessionInitHandler({ db }),
    Stop: createStopHandler({ db, workerClientDeps, workerEnv }),
  };
}

// One writable handle per hook process, shared by every handler that needs one.
// A hook process runs exactly one handler, so this opens at most one database.
function getDefaultHookDatabase(): ReturnType<typeof createDatabase> {
  if (!defaultHookDatabase) {
    defaultHookDatabase = createDatabase(undefined, {
      busyTimeoutMs: HOOK_DB_BUSY_TIMEOUT_MS,
    });
    initializeDatabase(defaultHookDatabase);
  }
  return defaultHookDatabase;
}

function getDefaultHandlers(): Record<string, HookHandler> {
  if (defaultHandlers) {
    return defaultHandlers;
  }

  defaultHandlers = createDefaultHookHandlers({
    db: getDefaultHookDatabase(),
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

function getDefaultDigestContextHandler(): HookHandler {
  if (defaultDigestContextHandler) {
    return defaultDigestContextHandler;
  }

  const databasePath = resolveDatabasePath();
  if (!existsSync(databasePath)) {
    defaultDigestContextHandler = async () => ({ continue: true });
    return defaultDigestContextHandler;
  }

  const db = new Database(databasePath, {
    readonly: true,
    create: false,
  });
  defaultDigestContextHandler = createReadOnlyContextHandler({ db }, "digest");
  return defaultDigestContextHandler;
}

function getDefaultPreToolUseHandler(): HookHandler {
  if (!defaultPreToolUseHandler) {
    defaultPreToolUseHandler = createPreToolUseDispatcher();
  }
  return defaultPreToolUseHandler;
}

function getDefaultUserPromptSubmitDispatcher(): HookHandler {
  if (!defaultUserPromptSubmitDispatcher) {
    defaultUserPromptSubmitDispatcher = createUserPromptSubmitDispatcher();
  }
  return defaultUserPromptSubmitDispatcher;
}

// The synchronous PostToolUse entry. It needs a writable handle: rendering a
// pending-notes reminder is also the act of recording that those ids were shown
// (the exposure ledger), and only the renderer can know that.
//
// Opening that handle is allowed to fail. This runs in a fresh process on every
// single tool call, and `initializeDatabase` takes a write lock that a
// concurrent `tool-use` process can hold past the busy timeout. Without the
// guard that failure escapes to runHookCommand's catch-all and the whole entry
// answers with a bare non-blocking exit — which would drop the rule-digest
// output too, a feature that never needed a database. So a database that cannot
// be opened costs the reminder alone.
function getDefaultResultDispatchHandler(): HookHandler {
  if (!defaultResultDispatchHandler) {
    let db: ReturnType<typeof createDatabase> | undefined;
    try {
      db = getDefaultHookDatabase();
    } catch (error) {
      process.stderr.write(
        `[HOOK] note reminder disabled for this call: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
    defaultResultDispatchHandler = createResultDispatchHandler({ db });
  }
  return defaultResultDispatchHandler;
}

function getDefaultNoteTakingContextHandler(): HookHandler {
  if (!defaultNoteTakingContextHandler) {
    defaultNoteTakingContextHandler = createNoteTakingContextHandler();
  }
  return defaultNoteTakingContextHandler;
}

function getDefaultHandler(handlerKey: string): HookHandler | undefined {
  if (handlerKey === "PreToolUse") {
    return getDefaultPreToolUseHandler();
  }
  if (handlerKey === "UserPromptSubmit:rule-dispatch") {
    return getDefaultUserPromptSubmitDispatcher();
  }
  if (handlerKey === "PostToolUse:rule-dispatch") {
    return getDefaultResultDispatchHandler();
  }
  if (handlerKey === "SessionStart:notes") {
    return getDefaultNoteTakingContextHandler();
  }
  if (handlerKey === "SessionStart:recent") {
    return getDefaultRecentContextHandler();
  }
  if (handlerKey === "SessionStart:digest") {
    return getDefaultDigestContextHandler();
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
    case "pre-tool-dispatch":
      return "PreToolUse";
    case "prompt-dispatch":
      return "UserPromptSubmit";
    case "result-dispatch":
      return "PostToolUse";
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

function ruleDispatcherKeyFromCommandArgument(
  arg?: string,
): "UserPromptSubmit:rule-dispatch" | "PostToolUse:rule-dispatch" | undefined {
  switch (arg) {
    case "prompt-dispatch":
      return "UserPromptSubmit:rule-dispatch";
    case "result-dispatch":
      return "PostToolUse:rule-dispatch";
    default:
      return undefined;
  }
}

function contextSectionFromCommandArguments(
  command?: string,
  section?: string,
): "sessions" | "persona" | "recent" | "digest" | "milestones" | "notes" {
  if (command !== "context") {
    return "sessions";
  }
  return section === "persona" ||
    section === "recent" ||
    section === "digest" ||
    section === "milestones" ||
    section === "notes"
    ? section
    : "sessions";
}

function writeHookResult(
  result: HookResult,
  eventName: HookEventName,
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
      hookEventName: eventName,
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
    const handlerKey = ruleDispatcherKeyFromCommandArgument(argv[2]) ??
      (normalizedInput.eventName === "SessionStart" && contextSection !== "sessions"
        ? `SessionStart:${contextSection}`
        : normalizedInput.eventName);
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

    writeHookResult(result, normalizedInput.eventName, stdout);

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
