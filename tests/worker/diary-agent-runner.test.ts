import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import {
  createDiaryAgentRunner,
  type DiaryAgentQueryRequest,
} from "../../src/worker/diary-agent-runner";
import {
  DEFAULT_DREAM_AGENT_TIMEOUT_MS,
  DEFAULT_DREAM_AGENT_IDLE_WATCHDOG_MS,
} from "../../src/shared/config";
import { createDreamAgentToolHandlers } from "../../src/worker/diary-agent-tools";
import { classifyWorkerError } from "../../src/worker/error-classifier";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("diary agent runner", () => {
  test("runs one dream-agent request with the default model and timeout contract", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-diary-runner-"));
    roots.push(dataRoot);
    const toolHandlers = createDreamAgentToolHandlers({ db, dataRoot });
    const rawEnvelope = [
      "===DIARY_V1_BEGIN===",
      "---",
      'date: "2026-07-10"',
      "---",
      "## 工作",
      "## 人物信号",
      "## 协作反馈",
      "## 未决与杂记",
      "===DIARY_V1_END===",
      "===INDEX_HOOK_V1===",
      "完成 diary runner tracer",
    ].join("\n");
    let seenRequest: DiaryAgentQueryRequest | null = null;
    const runner = createDiaryAgentRunner({
      runQuery: async (request) => {
        seenRequest = request;
        return rawEnvelope;
      },
    });

    try {
      expect(
        await runner.run({
          date: "2026-07-10",
          prompt: "Write the diary for 2026-07-10.",
          toolHandlers,
        }),
      ).toBe(rawEnvelope);
      expect(seenRequest).toMatchObject({
        date: "2026-07-10",
        prompt: "Write the diary for 2026-07-10.",
        toolHandlers,
        model: "claude-opus-4-8",
        timeoutMs: DEFAULT_DREAM_AGENT_TIMEOUT_MS,
        watchdogMs: DEFAULT_DREAM_AGENT_IDLE_WATCHDOG_MS,
      });
    } finally {
      db.close();
    }
  });

  test("aborts and rejects a diary request at the configured total timeout", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-diary-timeout-"));
    roots.push(dataRoot);
    const toolHandlers = createDreamAgentToolHandlers({ db, dataRoot });
    const runner = createDiaryAgentRunner({
      timeoutMs: 1,
      runQuery: (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(new Error("query aborted by signal")),
            { once: true },
          );
        }),
    });

    try {
      await expect(
        runner.run({
          date: "2026-07-10",
          prompt: "This request should time out.",
          toolHandlers,
        }),
      ).rejects.toThrow("Diary agent request timed out after 1ms.");
    } finally {
      db.close();
    }
  });

  test("aborts an inactive diary request at the configured watchdog timeout", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-diary-watchdog-"));
    roots.push(dataRoot);
    const toolHandlers = createDreamAgentToolHandlers({ db, dataRoot });
    let seenRequest: DiaryAgentQueryRequest | null = null;
    const runner = createDiaryAgentRunner({
      timeoutMs: 50,
      watchdogMs: 1,
      runQuery: (request) => {
        seenRequest = request;
        return new Promise((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(new Error("query aborted by signal")),
            { once: true },
          );
        });
      },
    });

    try {
      const error = await runner
        .run({
          date: "2026-07-10",
          prompt: "This request has no activity.",
          toolHandlers,
        })
        .catch((caught) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "Diary agent request watchdog timed out after 1ms.",
      );
      expect(classifyWorkerError(error)).toBe("connection");
      expect(typeof seenRequest?.reportActivity).toBe("function");
    } finally {
      db.close();
    }
  });
});
