import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase } from "../../src/db/database";
import { createDiaryStateStore } from "../../src/db/diary-state";
import { createRuleStore } from "../../src/db/rules";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { DreamMemoryStore } from "../../src/diary/memory-store";
import {
  createDefaultHookHandlers,
  runHookCommand,
} from "../../src/hooks/hook-command";
import {
  HOOK_NON_BLOCKING_EXIT_CODE,
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
  test("production SessionStart wiring captures env once while preserving all context outputs", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-default-hooks-"));
    const nowEpoch = Date.parse("2026-07-11T12:00:00+08:00") / 1_000;

    try {
      const session = upsertSession(db, {
        contentSessionId: "default-hook-wiring",
        project: "/projects/default-hook-wiring",
        title: "Default hook wiring",
        content: "The normal SessionStart context remains present.",
        insight: null,
        createdAtEpoch: nowEpoch,
        updatedAtEpoch: null,
        completedAtEpoch: null,
      });
      await new DreamMemoryStore(dataRoot).commitNight({
        date: "2026-07-10",
        userProfile: "## 身份与背景\n## 专长与判断力\n## 品味与兴趣\n## 沟通风格\n## 协作偏好\n- 生产 wiring 中的用户画像 [S1/T1]\n",
        experience: "## 项目\n## 通用\n- 生产 wiring 中的协作经历 [S1/T1]\n",
        archive: "# Memory Archive\n\n- 不应注入的归档内容\n",
        diary: "# 2026-07-10\n\n- production wiring\n",
        diaryIndex: "# Diary Index\n\n- 2026-07-10：生产 wiring 日记索引\n",
      });
      const indexBeforeSessionStart = readFileSync(
        join(dataRoot, "diary", "INDEX.md"),
        "utf8",
      );
      const diaryStateStore = createDiaryStateStore(db);
      diaryStateStore.initializeBootstrap("2026-07-11");
      diaryStateStore.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: nowEpoch });
      const claimed = diaryStateStore.claimNextDiaryItem(nowEpoch)!;
      diaryStateStore.settleDreamDay({
        date: "2026-07-10",
        queueSeq: claimed.seq,
        watermark: "production-wiring-watermark",
        settledAtEpoch: nowEpoch,
        remoteAttemptSucceeded: false,
      });
      diaryStateStore.markDayStale("2026-07-10");
      createRuleStore(db).create({
        name: "production-digest-rule",
        claim: "准备作出排他性断言时，先检查可溯源材料。",
        rationale: "防止把未验证判断写成事实。",
        scope: "/projects/default-hook-wiring",
        triggerKind: "none",
        triggerSpec: null,
        status: "confirmed",
        createdAtEpoch: nowEpoch,
      });
      // Model an active turn arriving after the prior dream settled. Claiming
      // a day that already contains this non-finalized turn is now forbidden.
      db.query(
        `INSERT INTO turns (
          session_id,
          prompt_number,
          status,
          user_prompt,
          assistant_response,
          created_at_epoch
        ) VALUES (?, 1, 'active', ?, ?, ?)`,
      ).run(
        session.id,
        "Yesterday through the production handler factory",
        "Queue this material for the diary",
        Date.parse("2026-07-10T12:00:00+08:00") / 1_000,
      );
      const fetchImpl = mock(async () => new Response(null, { status: 200 }));
      const handlers = createDefaultHookHandlers({
        db,
        dataRoot,
        nowEpoch: () => nowEpoch,
        workerClientDeps: { fetchImpl },
        workerEnv: {
          ANTHROPIC_AUTH_TOKEN: "session-auth",
          ANTHROPIC_API_KEY: "session-api-key",
          HTTP_PROXY: "http://session-proxy",
          ANTHROPIC_MODEL: "excluded-model",
          GITHUB_TOKEN: "excluded-github-token",
        },
        enableSessionEnvCapture: true,
      });

      const input = {
        eventName: "SessionStart",
        source: "startup",
        sessionId: "default-hook-wiring",
        cwd: "/projects/default-hook-wiring",
        stopHookActive: false,
        raw: {},
      } as const;
      const sessionsResult = await handlers.SessionStart!(input);
      const personaResult = await handlers["SessionStart:persona"]!(input);
      const recentResult = await handlers["SessionStart:recent"]!(input);
      const digestResult = await handlers["SessionStart:digest"]!(input);
      const milestonesResult = await handlers["SessionStart:milestones"]!(input);
      await Promise.resolve();
      await Promise.resolve();

      expect(createDiaryStateStore(db).hasQueuedDay("2026-07-10")).toBe(false);
      expect(sessionsResult).toEqual({ continue: true });
      expect(personaResult.hookSpecificOutput).toContain("## Persona");
      expect(personaResult.hookSpecificOutput).toContain(
        "- 生产 wiring 中的用户画像 [S1/T1]",
      );
      expect(personaResult.hookSpecificOutput).not.toContain("## Experience");
      expect(recentResult.hookSpecificOutput).toContain("# Diary Index");
      expect(recentResult.hookSpecificOutput).not.toContain("## Experience");
      expect(recentResult.hookSpecificOutput).toContain(
        "- 2026-07-10：生产 wiring 日记索引",
      );
      expect(digestResult.hookSpecificOutput).toContain("## Rule Digest");
      expect(digestResult.hookSpecificOutput).toContain("production-digest-rule");
      expect(milestonesResult).toEqual({ continue: true });
      expect(personaResult.hookSpecificOutput).not.toContain("不应注入的归档内容");
      expect(recentResult.hookSpecificOutput).not.toContain("生产 wiring 中的协作经历");
      expect(recentResult.hookSpecificOutput).not.toContain("不应注入的归档内容");
      expect(sessionsResult.asyncWork).toBeUndefined();
      expect(personaResult.asyncWork).toBeUndefined();
      expect(recentResult.asyncWork).toBeUndefined();
      expect(digestResult.asyncWork).toBeUndefined();
      expect(milestonesResult.asyncWork).toBeUndefined();
      expect(readFileSync(join(dataRoot, "diary", "INDEX.md"), "utf8"))
        .toBe(indexBeforeSessionStart);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(fetchImpl.mock.calls[1]?.[0]).toBe("http://127.0.0.1:37778/trigger");
      expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual({
        action: "capture",
        content_session_id: "default-hook-wiring",
        session_id: session.id,
        env: {
          ANTHROPIC_AUTH_TOKEN: "session-auth",
          ANTHROPIC_API_KEY: "session-api-key",
          HTTP_PROXY: "http://session-proxy",
        },
      });
    } finally {
      db.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  test("production startup stays silent before persona and diary artifacts exist", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-empty-default-hooks-"));

    try {
      upsertSession(db, {
        contentSessionId: "default-hook-before-artifacts",
        project: "/projects/default-hook-before-artifacts",
        title: "Before diary artifacts",
        content: "Existing memory context must survive missing diary files.",
        insight: null,
        createdAtEpoch: Date.parse("2026-07-11T12:00:00+08:00") / 1_000,
        updatedAtEpoch: null,
        completedAtEpoch: null,
      });
      const handlers = createDefaultHookHandlers({
        db,
        dataRoot,
        nowEpoch: () => Date.parse("2026-07-11T12:00:00+08:00") / 1_000,
      });

      const input = {
        eventName: "SessionStart",
        source: "startup",
        sessionId: "default-hook-before-artifacts",
        cwd: "/projects/default-hook-before-artifacts",
        stopHookActive: false,
        raw: {},
      } as const;
      const sessionsResult = await handlers.SessionStart!(input);
      const recentResult = await handlers["SessionStart:recent"]!(input);
      const digestResult = await handlers["SessionStart:digest"]!(input);

      expect(sessionsResult).toEqual({ continue: true });
      expect(recentResult).toEqual({ continue: true });
      expect(digestResult).toEqual({ continue: true });
    } finally {
      db.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  test("maps the tool-use command argument to PostToolUse", async () => {
    const handler = mock(async () => ({
      continue: true,
      exitCode: 0,
    }));
    const normalized = mock(() => ({
      ...createNormalizedInput(),
      eventName: "PostToolUse" as const,
    }));
    const run = runHookCommand as unknown as (
      dependencies?: TestHookCommandDependencies,
    ) => Promise<number>;

    const exitCode = await run({
      env: {},
      argv: ["bun", "hook-command.ts", "tool-use"],
      stdout: { write: mock(() => true) },
      stderr: { write: mock(() => true) },
      readJsonFromStdin: () => ({}),
      normalizeHookInputImpl: normalized,
      handlers: {
        PostToolUse: handler,
      } as unknown as Record<string, HookHandler>,
    });

    expect(exitCode).toBe(0);
    expect(normalized).toHaveBeenCalled();
    expect(handler).toHaveBeenCalled();
  });

  test("maps the session-end command argument to SessionEnd", async () => {
    const handler = mock(async () => ({
      continue: true,
      exitCode: 0,
    }));
    const normalized = mock(() => ({
      ...createNormalizedInput(),
      eventName: "SessionEnd" as const,
    }));
    const run = runHookCommand as unknown as (
      dependencies?: TestHookCommandDependencies,
    ) => Promise<number>;

    const exitCode = await run({
      env: {},
      argv: ["bun", "hook-command.ts", "session-end"],
      stdout: { write: mock(() => true) },
      stderr: { write: mock(() => true) },
      readJsonFromStdin: () => ({}),
      normalizeHookInputImpl: normalized,
      handlers: {
        SessionEnd: handler,
      } as unknown as Record<string, HookHandler>,
    });

    expect(exitCode).toBe(0);
    expect(normalized).toHaveBeenCalled();
    expect(handler).toHaveBeenCalled();
  });

  test("routes context section arguments to their dedicated SessionStart handlers", async () => {
    const sessionsHandler = mock(async () => ({ continue: true }));
    const personaHandler = mock(async () => ({ continue: true }));
    const recentHandler = mock(async () => ({ continue: true }));
    const digestHandler = mock(async () => ({ continue: true }));
    const milestonesHandler = mock(async () => ({ continue: true }));
    const notesHandler = mock(async () => ({ continue: true }));
    const run = runHookCommand as unknown as (
      dependencies?: TestHookCommandDependencies,
    ) => Promise<number>;
    const handlers = {
      SessionStart: sessionsHandler,
      "SessionStart:persona": personaHandler,
      "SessionStart:recent": recentHandler,
      "SessionStart:digest": digestHandler,
      "SessionStart:milestones": milestonesHandler,
      "SessionStart:notes": notesHandler,
    };

    for (const [section, expectedHandler] of [
      [undefined, sessionsHandler],
      ["persona", personaHandler],
      ["recent", recentHandler],
      ["digest", digestHandler],
      ["milestones", milestonesHandler],
      ["notes", notesHandler],
    ] as const) {
      await run({
        env: {},
        argv: [
          "bun",
          "hook-command.ts",
          "context",
          ...(section ? [section] : []),
        ],
        stdout: { write: mock(() => true) },
        stderr: { write: mock(() => true) },
        readJsonFromStdin: () => ({}),
        normalizeHookInputImpl: () => ({
          ...createNormalizedInput(),
          eventName: "SessionStart",
        }),
        handlers,
      });

      expect(expectedHandler).toHaveBeenCalledTimes(1);
    }
  });

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
        hookSpecificOutput: {
          hookEventName: "Stop",
          additionalContext: "sync-result",
        },
      }),
    ]);
  });

  test.each([
    [
      "UserPromptSubmit",
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-test",
        prompt: "Remember this rule",
      },
      "prompt-tip",
      '{"continue":true,"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"prompt-tip"}}',
    ],
    [
      "PreToolUse",
      {
        hook_event_name: "PreToolUse",
        session_id: "session-test",
        tool_name: "Bash",
        tool_input: { command: "bun test" },
      },
      "pre-tool-tip",
      '{"continue":true,"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"pre-tool-tip"}}',
    ],
    [
      "PostToolUse",
      {
        hook_event_name: "PostToolUse",
        session_id: "session-test",
        tool_name: "Bash",
        tool_response: "17 pass",
      },
      "post-tool-tip",
      '{"continue":true,"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"post-tool-tip"}}',
    ],
  ])(
    "writes %s as the hook-specific output event",
    async (eventName, rawInput, additionalContext, expectedOutput) => {
      const writes: string[] = [];
      const input: NormalizedHookInput = {
        ...createNormalizedInput(),
        eventName: eventName as NormalizedHookInput["eventName"],
      };
      const normalizeInput = mock(() => input);

      const exitCode = await runHookCommand({
        env: {},
        argv: ["bun", "hook-command.ts"],
        stdout: {
          write: mock((chunk: string) => {
            writes.push(chunk);
            return true;
          }),
        },
        stderr: { write: mock(() => true) },
        readJsonFromStdin: () => rawInput,
        normalizeHookInputImpl: normalizeInput,
        handlers: {
          [eventName]: async () => ({
            continue: true,
            hookSpecificOutput: additionalContext,
          }),
        },
      });

      expect(exitCode).toBe(HOOK_SUCCESS_EXIT_CODE);
      expect(normalizeInput).toHaveBeenCalledWith(rawInput);
      expect(writes).toEqual([expectedOutput]);
    },
  );

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

  // A hook that loses the write lock to the worker's own burst used to exit
  // non-blocking, which Claude Code renders as a red error in the user's
  // transcript — at a compact or a worker restart, the moments contention peaks.
  // The capture is gone either way; only the banner was ever in question.
  test("treats a lost write lock as a silent, logged loss rather than a hook failure", async () => {
    const stderr = { write: mock(() => true) };
    const warn = mock(() => {});
    const busy = Object.assign(new Error("database is locked"), {
      code: "SQLITE_BUSY",
    });

    const exitCode = await runHookCommand({
      env: {},
      argv: ["bun", "hook-command.ts", "session-init"],
      stdout: { write: mock(() => true) },
      stderr,
      logger: { warn },
      readJsonFromStdin: () => ({ event_name: "Stop" }),
      normalizeHookInputImpl: () => createNormalizedInput(),
      handlers: {
        Stop: async () => {
          throw busy;
        },
      },
    });

    expect(exitCode).toBe(HOOK_SUCCESS_EXIT_CODE);
    expect(stderr.write).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "hook write lost to database contention",
      expect.objectContaining({
        command: "session-init",
        reasonCode: "hook-write-contention",
      }),
    );
  });

  test("still reports every other failure to stderr with a non-blocking exit", async () => {
    const stderr = { write: mock(() => true) };
    const warn = mock(() => {});

    const exitCode = await runHookCommand({
      env: {},
      argv: ["bun", "hook-command.ts", "session-init"],
      stdout: { write: mock(() => true) },
      stderr,
      logger: { warn },
      readJsonFromStdin: () => ({ event_name: "Stop" }),
      normalizeHookInputImpl: () => createNormalizedInput(),
      handlers: {
        Stop: async () => {
          throw new Error("no such column: nope");
        },
      },
    });

    expect(exitCode).toBe(HOOK_NON_BLOCKING_EXIT_CODE);
    expect(stderr.write).toHaveBeenCalledWith(
      "[HOOK] no such column: nope\n",
    );
    expect(warn).not.toHaveBeenCalled();
  });
});
