import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase } from "../../src/db/database";
import { createDiaryStateStore } from "../../src/db/diary-state";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { DreamMemoryStore } from "../../src/diary/memory-store";
import {
  createDefaultHookHandlers,
  runHookCommand,
} from "../../src/hooks/hook-command";
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
  test("production SessionStart wiring queues diary backlog, injects persona/index, and kicks the worker", async () => {
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
      });
      diaryStateStore.markDayStale("2026-07-10");
      let kickCalls = 0;
      const handlers = createDefaultHookHandlers({
        db,
        dataRoot,
        nowEpoch: () => nowEpoch,
        kickWorkerFast: async () => {
          kickCalls += 1;
        },
      });

      const result = await handlers.SessionStart!({
        eventName: "SessionStart",
        source: "startup",
        sessionId: "default-hook-wiring",
        cwd: "/projects/default-hook-wiring",
        stopHookActive: false,
        raw: {},
      });

      expect(createDiaryStateStore(db).hasQueuedDay("2026-07-10")).toBe(true);
      expect(result.hookSpecificOutput).toContain("## Persona");
      expect(result.hookSpecificOutput).toContain(
        "- 生产 wiring 中的用户画像 [S1/T1]",
      );
      expect(result.hookSpecificOutput).toContain("## Experience");
      expect(result.hookSpecificOutput).toContain("# Diary Index");
      expect(result.hookSpecificOutput).toContain(
        "- 2026-07-10：生产 wiring 日记索引",
      );
      expect(result.hookSpecificOutput).not.toContain("不应注入的归档内容");
      expect(kickCalls).toBe(1);
      expect(result.asyncWork).toBeUndefined();
      expect(readFileSync(join(dataRoot, "diary", "INDEX.md"), "utf8"))
        .toBe(indexBeforeSessionStart);
    } finally {
      db.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  test("production SessionStart wiring preserves base context before diary artifacts exist", async () => {
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
        kickWorkerFast: async () => {},
      });

      const result = await handlers.SessionStart!({
        eventName: "SessionStart",
        source: "startup",
        sessionId: "default-hook-before-artifacts",
        cwd: "/projects/default-hook-before-artifacts",
        stopHookActive: false,
        raw: {},
      });

      expect(result.hookSpecificOutput).toContain("claude-mnemo: 1 sessions");
      expect(result.hookSpecificOutput).toContain("## Recent Sessions");
      expect(result.asyncWork).toBeUndefined();
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
          hookEventName: "SessionStart",
          additionalContext: "sync-result",
        },
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
