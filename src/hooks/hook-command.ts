import { readFileSync } from "node:fs";

import {
  HOOK_NON_BLOCKING_EXIT_CODE,
  HOOK_SUCCESS_EXIT_CODE,
} from "../shared/hook-constants";
import { createDatabase } from "../db/database";
import { initializeDatabase } from "../db/schema";
import { forkMnemosyne } from "../mnemosyne/fork";
import { normalizeHookInput } from "./adapters";
import { createCompactHandler } from "./handlers/compact";
import { createContextHandler } from "./handlers/context";
import { createSessionInitHandler } from "./handlers/session-init";
import { createStopHandler } from "./handlers/stop";
import type { HookHandler, HookResult } from "./types";

const db = createDatabase();
initializeDatabase(db);

const HANDLERS: Record<string, HookHandler> = {
  SessionStart: createContextHandler({ db }),
  PreCompact: createCompactHandler({ db, forkMnemosyne }),
  UserPromptSubmit: createSessionInitHandler({ db }),
  Stop: createStopHandler({
    db,
    forkMnemosyne,
  }),
};

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

function writeHookResult(result: HookResult): void {
  const output: Record<string, unknown> = {
    continue: result.continue,
  };

  if (result.suppressOutput !== undefined) {
    output.suppressOutput = result.suppressOutput;
  }

  if (result.hookSpecificOutput !== undefined) {
    output.hookSpecificOutput = result.hookSpecificOutput;
  }

  if (Object.keys(output).length > 1 || output.continue !== true) {
    process.stdout.write(JSON.stringify(output));
  }
}

export async function runHookCommand(): Promise<number> {
  if (process.env.CLAUDE_CODE_ENTRYPOINT === "sdk-ts") {
    return HOOK_SUCCESS_EXIT_CODE;
  }

  try {
    const rawInput = readJsonFromStdin();
    const eventNameOverride = eventNameFromCommandArgument(process.argv[2]);

    if (eventNameOverride && !("event_name" in rawInput) && !("hook_event_name" in rawInput)) {
      rawInput.event_name = eventNameOverride;
    }

    const normalizedInput = normalizeHookInput(rawInput);
    const handler = HANDLERS[normalizedInput.eventName];

    if (!handler) {
      return HOOK_SUCCESS_EXIT_CODE;
    }

    const result = await handler(normalizedInput);
    writeHookResult(result);

    return result.exitCode ?? HOOK_SUCCESS_EXIT_CODE;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown hook failure";
    process.stderr.write(`[HOOK] ${message}\n`);
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
