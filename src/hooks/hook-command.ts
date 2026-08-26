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
import { createSegmentBlockContextHandler } from "./handlers/context-segments";
import { ATTACHED_SEGMENT_BLOCK_SLOTS, type SegmentBlockKind } from "./session-composition";
import { createNoteTakingContextHandler } from "./handlers/context-note-taking";
import { createPromptDispatchHandler } from "./handlers/prompt-dispatch";
import { createSessionEndHandler } from "./handlers/session-end";
import { createSessionInitHandler } from "./handlers/session-init";
import { createStopHandler } from "./handlers/stop";
import type { HookEventName, HookHandler, HookResult } from "./types";

/** `context segment<slotIndex>-<kind>` argv sections, e.g. `segment1-fields`. */
const SEGMENT_BLOCK_SECTION_PATTERN = /^segment([1-9][0-9]*)-(fields|milestones)$/;

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
let defaultDigestContextHandler: HookHandler | undefined;
const defaultSegmentBlockContextHandlers = new Map<string, HookHandler>();
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
  const contextDependencies: ContextHandlerDependencies = {
    db,
    workerClientDeps,
    workerEnv,
    enableSessionEnvCapture,
  };

  const segmentBlockHandlers: Record<string, HookHandler> = {};
  for (let slot = 1; slot <= ATTACHED_SEGMENT_BLOCK_SLOTS; slot += 1) {
    for (const kind of ["fields", "milestones"] as const) {
      segmentBlockHandlers[`SessionStart:segment${slot}-${kind}`] =
        createSegmentBlockContextHandler({ db }, slot, kind);
    }
  }

  return {
    ...createDefaultReadOnlyContextHandlers({ dataRoot }),
    ...segmentBlockHandlers,
    "SessionStart:digest": createReadOnlyContextHandler({ db }, "digest"),
    "SessionStart:rubric": createReadOnlyContextHandler({}, "rubric"),
    "SessionStart:notes": createNoteTakingContextHandler(),
    SessionStart: createContextHandler(contextDependencies),
    SessionEnd: createSessionEndHandler({ db, workerClientDeps, workerEnv }),
    PostToolUse: createPostToolUseHandler({ db }),
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

/**
 * One slot of the fixed segment-block pool (ticket 10). Same lazy
 * readonly-DB pattern as the retired `recent`/`milestones` getters: each
 * SessionStart hook command is its own process, so only the writable
 * `context` (bare) command opens the shared writable handle — every other
 * section reads through its own readonly connection to avoid write-lock
 * contention across the parallel hook processes one SessionStart fires.
 */
function getDefaultSegmentBlockContextHandler(
  slotIndex: number,
  kind: SegmentBlockKind,
): HookHandler {
  const cacheKey = `${slotIndex}-${kind}`;
  const cached = defaultSegmentBlockContextHandlers.get(cacheKey);
  if (cached) {
    return cached;
  }

  const databasePath = resolveDatabasePath();
  if (!existsSync(databasePath)) {
    const noop: HookHandler = async () => ({ continue: true });
    defaultSegmentBlockContextHandlers.set(cacheKey, noop);
    return noop;
  }

  const db = new Database(databasePath, {
    readonly: true,
    create: false,
  });
  const handler = createSegmentBlockContextHandler({ db }, slotIndex, kind);
  defaultSegmentBlockContextHandlers.set(cacheKey, handler);
  return handler;
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

// The `prompt-dispatch` UserPromptSubmit entry — the rule digest only (spec
// note-prompt-clock D9). It opens no database: `session-init`, the sibling
// UserPromptSubmit registration, is the sole writer and sole reader of the
// owed-notes state (turn creation, the backlog relief — ticket 03 retired
// the current-turn line's owed SUFFIX outright, see hooks/note-reminder.ts),
// all inside its own transaction, so there is nothing left here that a write
// lock could contend with.
function getDefaultUserPromptSubmitDispatcher(): HookHandler {
  if (!defaultUserPromptSubmitDispatcher) {
    defaultUserPromptSubmitDispatcher = createPromptDispatchHandler();
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
  if (handlerKey === "SessionStart:digest") {
    return getDefaultDigestContextHandler();
  }
  if (handlerKey === "SessionStart:rubric") {
    // Pure prose, no db — construct directly rather than booting the full
    // default-handler map for a block that never reads anything.
    return createReadOnlyContextHandler({}, "rubric");
  }
  if (handlerKey.startsWith("SessionStart:")) {
    const match = SEGMENT_BLOCK_SECTION_PATTERN.exec(handlerKey.slice("SessionStart:".length));
    if (match) {
      return getDefaultSegmentBlockContextHandler(
        Number.parseInt(match[1]!, 10),
        match[2] as SegmentBlockKind,
      );
    }
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

type SegmentBlockSection = `segment${number}-fields` | `segment${number}-milestones`;

function contextSectionFromCommandArguments(
  command?: string,
  section?: string,
): "sessions" | "persona" | "digest" | "rubric" | "notes" | SegmentBlockSection {
  if (command !== "context") {
    return "sessions";
  }
  if (
    section === "persona" ||
    section === "digest" ||
    section === "rubric" ||
    section === "notes"
  ) {
    return section;
  }
  if (section && SEGMENT_BLOCK_SECTION_PATTERN.test(section)) {
    return section as SegmentBlockSection;
  }
  return "sessions";
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
