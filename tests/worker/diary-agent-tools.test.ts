import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase } from "../../src/db/database";
import {
  createDiaryStateStore,
  type DiaryStateStore,
} from "../../src/db/diary-state";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { DiaryFileStore } from "../../src/diary/file-store";
import { createDiaryAgentToolHandlers } from "../../src/worker/diary-agent-tools";

describe("diary agent tools", () => {
  let db: Database;
  let sessionId: number;
  let dataRoot: string;
  let fileStore: DiaryFileStore;
  let stateStore: DiaryStateStore;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    stateStore = createDiaryStateStore(db);
    dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-diary-tools-"));
    fileStore = new DiaryFileStore(dataRoot);

    sessionId = upsertSession(db, {
      contentSessionId: "diary-tools-session",
      project: "/projects/diary-tools",
      title: "Diary tool fixtures",
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;

    const insertTurn = db.query(
      `INSERT INTO turns (
         session_id,
         prompt_number,
         status,
         user_prompt,
         assistant_response,
         created_at_epoch
       ) VALUES (?, ?, 'skipped', ?, ?, ?)`,
    );

    insertTurn.run(sessionId, 2, "allowed prompt", "allowed response", 2);
    insertTurn.run(sessionId, 3, "secret prompt", "secret response", 3);
  });

  afterEach(() => {
    db.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });

  test("reads only turns in this SDK request's allow-set", () => {
    const handlers = createDiaryAgentToolHandlers({
      db,
      stateStore,
      allowedTurnRefs: new Set([`S${sessionId}/T2`]),
      fileStore,
      allowedDiaryDates: new Set(),
    });

    expect(handlers.readTurn(sessionId, 2)).toEqual({
      sessionId,
      promptNumber: 2,
      userPrompt: "allowed prompt",
      assistantResponse: "allowed response",
    });
    expect(() => handlers.readTurn(sessionId, 3)).toThrow(
      `Turn S${sessionId}/T3 is not allowed for this request.`,
    );
  });

  test("reads only diaries in this SDK request's allow-set", async () => {
    const allowedBytes = new TextEncoder().encode(
      [
        "---",
        "format: 2",
        'date: "2026-07-10"',
        'sessions: ["S1"]',
        'projects: ["/project"]',
        'watermark: "watermark-1"',
        'index_hook: "允许读取"',
        "---",
        "## 工作",
        "- work [S1/T1]",
        "## 人物",
        "- signal [S1/T1]",
        "## 反思",
        "- reflection [S1/T1]",
        "",
      ].join("\n"),
    );
    const deniedBytes = new TextEncoder().encode(
      "---\ndate: 2026-07-09\n---\n\n不得读取的日记。\n",
    );
    await fileStore.commitDiary("2026-07-10", allowedBytes);
    await fileStore.commitDiary("2026-07-09", deniedBytes);
    stateStore.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 1 });
    stateStore.commitDayState({
      date: "2026-07-10",
      watermark: "watermark-1",
      fileSha256: createHash("sha256").update(allowedBytes).digest("hex"),
      indexHook: "允许读取",
      settledAtEpoch: 2,
    });

    const handlers = createDiaryAgentToolHandlers({
      db,
      stateStore,
      allowedTurnRefs: new Set(),
      fileStore,
      allowedDiaryDates: new Set(["2026-07-10"]),
    });

    expect(await handlers.readDiary("2026-07-10")).toEqual(allowedBytes);
    await expect(handlers.readDiary("2026-07-09")).rejects.toThrow(
      "Diary 2026-07-09 is not allowed for this request.",
    );
  });

  test("rejects missing or corrupt allow-listed diaries and marks their public day state stale", async () => {
    const date = "2026-07-10";
    const missingDate = "2026-07-11";
    const canonicalBytes = new TextEncoder().encode(
      [
        "---",
        "format: 2",
        `date: ${JSON.stringify(date)}`,
        'sessions: ["S1"]',
        'projects: ["/project"]',
        'watermark: "watermark-1"',
        'index_hook: "validated hook"',
        "---",
        "## 工作",
        "- work [S1/T1]",
        "## 人物",
        "- signal [S1/T1]",
        "## 反思",
        "- reflection [S1/T1]",
        "",
      ].join("\n"),
    );
    stateStore.enqueueDay({ date, enqueuedAtEpoch: 1 });
    stateStore.commitDayState({
      date,
      watermark: "watermark-1",
      fileSha256: createHash("sha256").update(canonicalBytes).digest("hex"),
      indexHook: "validated hook",
      settledAtEpoch: 2,
    });
    stateStore.enqueueDay({ date: missingDate, enqueuedAtEpoch: 1 });
    stateStore.commitDayState({
      date: missingDate,
      watermark: "watermark-2",
      fileSha256: createHash("sha256").update(canonicalBytes).digest("hex"),
      indexHook: "missing hook",
      settledAtEpoch: 2,
    });
    await fileStore.commitDiary(
      date,
      new TextEncoder().encode("corrupt diary bytes"),
    );
    const handlers = createDiaryAgentToolHandlers({
      db,
      stateStore,
      allowedTurnRefs: new Set(),
      fileStore,
      allowedDiaryDates: new Set([date, missingDate]),
    });

    await expect(handlers.readDiary(date)).rejects.toThrow();
    expect(stateStore.getDayState(date)?.needsRegen).toBe(true);
    expect(stateStore.hasQueuedDay(date)).toBe(true);
    await expect(handlers.readDiary(missingDate)).rejects.toThrow();
    expect(stateStore.getDayState(missingDate)?.needsRegen).toBe(true);
  });

  test("atomically marks an invalid day state stale and enqueues a missing queue row", async () => {
    const date = "2026-07-12";
    stateStore.enqueueDay({ date, enqueuedAtEpoch: 1 });
    const claimed = stateStore.claimNextDiaryItem(2)!;
    stateStore.acknowledgeDiaryItem(claimed.seq);
    stateStore.commitDayState({
      date,
      watermark: "empty",
      fileSha256: "unused",
      indexHook: "invalid precheck",
      settledAtEpoch: 2,
    });
    expect(stateStore.hasQueuedDay(date)).toBe(false);
    const handlers = createDiaryAgentToolHandlers({
      db,
      stateStore,
      allowedTurnRefs: new Set(),
      fileStore,
      allowedDiaryDates: new Set([date]),
    });
    await expect(handlers.readDiary(date)).rejects.toThrow(
      "has no valid settled day state",
    );
    expect(stateStore.getDayState(date)?.needsRegen).toBe(true);
    expect(stateStore.hasQueuedDay(date)).toBe(true);
  });
});
