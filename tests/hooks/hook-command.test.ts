import { describe, expect, mock, test } from "bun:test";

import { runHookCommand } from "../../src/hooks/hook-command";
import {
  HOOK_SUCCESS_EXIT_CODE,
} from "../../src/shared/hook-constants";
import type { HookHandler, HookResult, NormalizedHookInput } from "../../src/hooks/types";

interface TestHookCommandDependencies {
  env?: Record<string, string | undefined>;
  argv?: string[];
  stdout?: { write: (chunk: string) => boolean };
  stderr?: { write: (chunk: string) => boolean };
  readJsonFromStdin?: () => Record<string, unknown>;
  normalizeHookInputImpl?: (rawInput: Record<string, unknown>) => NormalizedHookInput;
  handlers?: Record<string, HookHandler>;
}

function createNormalizedInput(): NormalizedHookInput {
  return {
    eventName: "Stop",
    sessionId: "session-test",
    cwd: "/Users/zhaoqixuan/Projects/claude-mnemo",
    stopHookActive: false,
    raw: {},
  };
}

function createRunner(handler: HookHandler) {
  const writes: string[] = [];
  const stdout = {
    write: mock((chunk: string) => {
      writes.push(chunk);
      return true;
    }),
  };
  const stderr = {
    write: mock(() => true),
  };
  const run = runHookCommand as unknown as (
    dependencies?: TestHookCommandDependencies,
  ) => Promise<number>;

  return {
    writes,
    stdout,
    stderr,
    run: () =>
      run({
        env: {},
        argv: ["bun", "hook-command.ts"],
        stdout,
        stderr,
        readJsonFromStdin: () => ({ event_name: "Stop" }),
        normalizeHookInputImpl: () => createNormalizedInput(),
        handlers: {
          Stop: handler,
        },
      }),
  };
}

describe("runHookCommand", () => {
  test("writes only the async sentinel to stdout and awaits async work", async () => {
    const events: string[] = [];
    const asyncWork = mock(async () => {
      events.push("async");
    });
    const result: HookResult = {
      continue: false,
      suppressOutput: true,
      hookSpecificOutput: "should-not-be-written",
      exitCode: 17,
      asyncWork,
    };
    const handler = mock(async () => {
      events.push("handler");
      return result;
    });
    const runner = createRunner(handler);

    const exitCode = await runner.run();

    expect(exitCode).toBe(HOOK_SUCCESS_EXIT_CODE);
    expect(runner.writes).toEqual(['{"async":true}\n']);
    expect(events).toEqual(["handler", "async"]);
  });

  test("writes the normal sync hook result when async work is absent", async () => {
    const result: HookResult = {
      continue: false,
      suppressOutput: true,
      hookSpecificOutput: "sync-result",
      exitCode: 9,
    };
    const runner = createRunner(async () => result);

    const exitCode = await runner.run();

    expect(exitCode).toBe(9);
    expect(runner.writes).toEqual([
      JSON.stringify({
        continue: false,
        suppressOutput: true,
        hookSpecificOutput: "sync-result",
      }),
    ]);
  });

  test("skips sync hook result output entirely when async work is present", async () => {
    const runner = createRunner(async () => ({
      continue: false,
      suppressOutput: true,
      hookSpecificOutput: "sync-result",
      asyncWork: async () => {},
    }));

    await runner.run();

    expect(runner.writes).not.toContain(
      JSON.stringify({
        continue: false,
        suppressOutput: true,
        hookSpecificOutput: "sync-result",
      }),
    );
    expect(runner.writes).toEqual(['{"async":true}\n']);
  });
});
