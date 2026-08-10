import { existsSync, readFileSync } from "node:fs";
import { Database } from "bun:sqlite";

import {
  HOOK_NON_BLOCKING_EXIT_CODE,
  HOOK_SUCCESS_EXIT_CODE,
} from "../shared/hook-constants";
import { createDatabase, isSqliteBusy } from "../db/database";
import { ensureRecordedEraCutoff } from "../db/era";
import { initializeDatabase } from "../db/schema";
import { createLogger } from "../shared/logger";
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
import { createPromptDispatchHandler } from "./handlers/prompt-dispatch";
import { createSessionEndHandler } from "./handlers/session-end";
import { createSessionInitHandler } from "./handlers/session-init";
import { createStopHandler } from "./handlers/stop";
import type { HookEventName, HookHandler, HookResult } from "./types";

export interface HookCommandDependencies {
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  readJsonFromStdin?: () => Record<string, unknown>;
  normalizeHookInputImpl?: typeof normalizeHookInput;
  handlers?: Record<string, HookHandler>;
  logger?: HookCommandLogger;
}

export interface HookCommandLogger {
  warn: (message: string, context?: Record<string, unknown>) => void;
}

let defaultHandlers: Record<string, HookHandler> | undefined;
let defaultReadOnlyContextHandlers: Record<string, HookHandler> | undefined;
let defaultRecentContextHandler: HookHandler | undefined;
let defaultDigestContextHandler: HookHandler | undefined;
let defaultMilestoneContextHandler: HookHandler | undefined;
let defaultNoteTakingContextHandler: HookHandler | undefined;
let defaultUserPromptSubmitDispatcher: HookHandler | undefined;
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
    // The era begins the first time a build without an extraction agent runs
    // (db/era.ts). Here rather than in `initializeDatabase`, which every test
    // database also runs: this is the production boundary, and a turn created
    // before the boundary exists would be a legacy turn nobody can write a
    // record for. INSERT OR IGNORE, so this costs one indexed read forever
    // after.
    ensureRecordedEraCutoff(defaultHookDatabase, Math.floor(Date.now() / 1000));
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

// The one synchronous entry mnemo has left, and the only one that returns
// `additionalContext` at all: the tool-adjacent entries were retired because
// Claude Code re-renders their context at request assembly, which rewrites the
// previous turn's tail and destroys the message-side cache breakpoint.
//
// It needs a writable handle — both pending-notes paths record the ids they just
// showed and take their claim in the same transaction — and it must survive
// failing to get one: `session-init` runs in a parallel process on the very same
// event and can hold the write lock past the busy timeout. A database that
// cannot be opened costs the notes sections alone, never the rule digest.
function getDefaultUserPromptSubmitDispatcher(): HookHandler {
  if (!defaultUserPromptSubmitDispatcher) {
    let db: ReturnType<typeof createDatabase> | undefined;
    try {
      db = getDefaultHookDatabase();
    } catch (error) {
      process.stderr.write(
        `[HOOK] pending-notes sections disabled for this call: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
    defaultUserPromptSubmitDispatcher = createPromptDispatchHandler({ db });
  }
  return defaultUserPromptSubmitDispatcher;
}

function getDefaultNoteTakingContextHandler(): HookHandler {
  if (!defaultNoteTakingContextHandler) {
    defaultNoteTakingContextHandler = createNoteTakingContextHandler();
  }
  return defaultNoteTakingContextHandler;
}

function getDefaultHandler(handlerKey: string): HookHandler | undefined {
  if (handlerKey === "UserPromptSubmit:rule-dispatch") {
    return getDefaultUserPromptSubmitDispatcher();
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
    case "prompt-dispatch":
      return "UserPromptSubmit";
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

// `prompt-dispatch` and `session-init` are both UserPromptSubmit, so the
// subcommand — not the event name — is what picks the handler.
function ruleDispatcherKeyFromCommandArgument(
  arg?: string,
): "UserPromptSubmit:rule-dispatch" | undefined {
  return arg === "prompt-dispatch" ? "UserPromptSubmit:rule-dispatch" : undefined;
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
  const logger = dependencies.logger ?? createLogger("HOOK");

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

    // Losing the write lock is not a hook failure. Every write mnemo makes from
    // a hook is best-effort capture that cannot block the user's turn, so a race
    // lost to the worker's own write burst must cost that capture and nothing
    // else. Reporting it costs more than it saves: a non-blocking exit renders a
    // red banner in the user's transcript at exactly the moments contention
    // peaks — a compact, a worker restart, a large ingest — and names a fault
    // there is no user action for. It goes to the log every other mnemo fault
    // goes to instead, where the frequency is diagnosable rather than merely
    // startling. Any other failure keeps the banner: it is a real defect.
    if (isSqliteBusy(error)) {
      logger.warn("hook write lost to database contention", {
        command: argv[2] ?? null,
        reasonCode: "hook-write-contention",
        error: message,
      });
      return HOOK_SUCCESS_EXIT_CODE;
    }

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
