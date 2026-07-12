import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase } from "../../src/db/database";
import { createDiaryStateStore } from "../../src/db/diary-state";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import {
  compileDiaryDocument,
  estimateDiaryTokens,
} from "../../src/diary/domain";
import { DiaryFileStore } from "../../src/diary/file-store";
import { computeDiaryWatermark } from "../../src/diary/domain";
import { PERSONA_INJECTION_TOKEN_BUDGET } from "../../src/diary/persona-render";
import { createContextHandler } from "../../src/hooks/handlers/context";

function seedIndexRows(
  db: Database,
  rows: Array<{ date: string; indexHook: string }>,
): void {
  const insert = db.query(
    "INSERT INTO diary_day_state (date, index_hook) VALUES (?, ?)",
  );
  for (const row of rows) insert.run(row.date, row.indexHook);
}

describe("SessionStart diary scheduling", () => {
  let db: Database;
  const dataRoots: string[] = [];

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
    for (const dataRoot of dataRoots.splice(0)) {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  test("queues yesterday's material and awaits a fast worker kick without replacing context", async () => {
    const nowEpoch = Date.parse("2026-07-11T12:00:00+08:00") / 1_000;
    const session = upsertSession(db, {
      contentSessionId: "diary-session-start",
      project: "/projects/diary",
      title: "Diary startup session",
      content: "Existing memory context remains available.",
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
      "Yesterday's prompt",
      "Yesterday's response",
      Date.parse("2026-07-10T12:00:00+08:00") / 1_000,
    );

    const diaryStateStore = createDiaryStateStore(db);
    let kickCalls = 0;
    let kickCompleted = false;
    const handler = createContextHandler({
      db,
      diaryStateStore,
      nowEpoch: () => nowEpoch,
      kickWorkerFast: async () => {
        kickCalls += 1;
        await Promise.resolve();
        kickCompleted = true;
      },
    });

    const result = await handler({
      eventName: "SessionStart",
      source: "startup",
      sessionId: "diary-session-start",
      cwd: "/projects/diary",
      stopHookActive: false,
      raw: {},
    });

    expect(result.hookSpecificOutput).toContain("claude-mnemo: 1 sessions");
    expect(result.hookSpecificOutput).toContain("## Recent Sessions");
    expect(result.asyncWork).toBeUndefined();
    expect(diaryStateStore.hasQueuedDay("2026-07-10")).toBe(true);
    expect(kickCalls).toBe(1);
    expect(kickCompleted).toBe(true);
  });

  test("appends profile and experience with the rolling recent section inside experience", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-context-diary-"));
    dataRoots.push(dataRoot);
    const fileStore = new DiaryFileStore(dataRoot);
    await fileStore.commitPersonaGeneration({
      generation: 1,
      manifest: {
        operation_id: "context-persona-1",
        op: "fold",
        generation: 1,
      },
      userProfile: "## 身份与背景\n## 专长与判断力\n## 品味与兴趣\n## 沟通风格\n## 协作偏好\n- 用户偏好证据充分的实现 [S1/T1]\n",
      experience: "## 项目\n- mnemo：注入可靠 [S1/T1]\n  - 路径：[\"/projects/diary\"]\n  - 进度：已完成 [S1/T1]\n  - [2026-07] 先验证再总结 [S1/T1]\n## 通用\n- 保留证据 [S1/T1]\n",
    });
    const indexRows = [{ date: "2026-07-10", indexHook: "完成 SessionStart diary 注入" }];
    seedIndexRows(db, indexRows);
    expect(createDiaryStateStore(db).listIndexRows()).toEqual(indexRows);
    await fileStore.ensureIndex(indexRows);
    upsertSession(db, {
      contentSessionId: "diary-injection-session",
      project: "/projects/diary",
      title: "Existing session context",
      content: "This remains the primary SessionStart context.",
      insight: null,
      createdAtEpoch: Date.parse("2026-07-11T12:00:00+08:00") / 1_000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    const result = await createContextHandler({
      db,
      fileStore,
      diaryStateStore: createDiaryStateStore(db),
    })({
      eventName: "SessionStart",
      source: "startup",
      sessionId: "diary-injection-session",
      cwd: "/projects/diary",
      stopHookActive: false,
      raw: {},
    });
    const output = result.hookSpecificOutput ?? "";

    expect(output).toContain("claude-mnemo: 1 sessions");
    expect(output.indexOf("## Persona")).toBeGreaterThan(
      output.indexOf("## Recent Sessions"),
    );
    expect(output).toContain("- 用户偏好证据充分的实现 [S1/T1]");
    expect(output.indexOf("## Experience")).toBeGreaterThan(
      output.indexOf("## Persona"),
    );
    expect(output.indexOf("## 近期")).toBeGreaterThan(output.indexOf("## 通用"));
    expect(output).not.toContain("## Diary Index");
    expect(output).toContain("- 2026-07-10：完成 SessionStart diary 注入");
    expect(result.asyncWork).toBeUndefined();
  });

  test("skips a corrupt persona and requests a rebuild", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-context-corrupt-"));
    dataRoots.push(dataRoot);
    const fileStore = new DiaryFileStore(dataRoot);
    await fileStore.commitPersonaGeneration({
      generation: 1,
      manifest: {
        operation_id: "context-persona-missing",
        op: "fold",
        generation: 1,
      },
      userProfile: "## 身份与背景\n## 专长与判断力\n## 品味与兴趣\n## 沟通风格\n## 协作偏好\n",
      experience: "## 项目\n## 通用\n",
    });
    rmSync(join(dataRoot, "persona", "generations", "1"), {
      recursive: true,
      force: true,
    });
    const indexRows = [{ date: "2026-07-10", indexHook: "有效 INDEX 仍应注入" }];
    seedIndexRows(db, indexRows);
    await fileStore.ensureIndex(indexRows);
    upsertSession(db, {
      contentSessionId: "diary-corrupt-persona-session",
      project: "/projects/diary",
      title: "Context survives persona corruption",
      content: "Existing context must remain available.",
      insight: null,
      createdAtEpoch: Date.parse("2026-07-11T12:00:00+08:00") / 1_000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    const stateStore = createDiaryStateStore(db);
    stateStore.commitPersonaCursor({
      lastFoldedDate: "2026-07-10",
      lastAppliedOperationId: "context-persona-missing",
      rebuildRequested: false,
    });
    const result = await createContextHandler({ db, fileStore, diaryStateStore: stateStore })({
      eventName: "SessionStart",
      source: "startup",
      sessionId: "diary-corrupt-persona-session",
      cwd: "/projects/diary",
      stopHookActive: false,
      raw: {},
    });
    const output = result.hookSpecificOutput ?? "";

    expect(output).toContain("claude-mnemo: 1 sessions");
    expect(output).not.toContain("## Persona");
    expect(output).not.toContain("不应出现在损坏降级输出中");
    expect(output).not.toContain("## Experience");
    expect(output).not.toContain("## 近期");
    expect(stateStore.getPersonaCursor().rebuildRequested).toBe(true);
    expect(result.asyncWork).toBeUndefined();
  });

  test("loads an over-budget profile dynamically without requesting a rebuild", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-context-budget-"));
    dataRoots.push(dataRoot);
    const fileStore = new DiaryFileStore(dataRoot);
    const userBullets = Array.from(
      { length: 80 },
      (_, index) =>
        `- 用户条目${String(index).padStart(2, "0")}：偏好完整且可验证的中文证据记录 [2026-07-10]`,
    );
    const userProfile = ["## 身份与背景", ...userBullets, "## 专长与判断力", "## 品味与兴趣", "## 沟通风格", "## 协作偏好", ""].join("\n");
    const experience = "## 项目\n## 通用\n";
    expect(
      estimateDiaryTokens(["## Persona", "", userProfile.trim()].join("\n")),
    ).toBeGreaterThan(1_000);
    await fileStore.commitPersonaGeneration({
      generation: 1,
      manifest: {
        operation_id: "context-persona-budget",
        op: "fold",
        generation: 1,
      },
      userProfile,
      experience,
    });
    const indexRows = [{ date: "2026-07-10", indexHook: "persona 预算已校准" }];
    seedIndexRows(db, indexRows);
    await fileStore.ensureIndex(indexRows);
    upsertSession(db, {
      contentSessionId: "diary-persona-budget-session",
      project: "/projects/diary",
      title: "Persona budget session",
      content: "Existing context precedes bounded persona.",
      insight: null,
      createdAtEpoch: Date.parse("2026-07-11T12:00:00+08:00") / 1_000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    const stateStore = createDiaryStateStore(db);
    stateStore.commitPersonaCursor({ lastFoldedDate: "2026-07-10", lastAppliedOperationId: "context-persona-budget", rebuildRequested: false });
    const result = await createContextHandler({ db, fileStore, diaryStateStore: stateStore })({
      eventName: "SessionStart",
      source: "startup",
      sessionId: "diary-persona-budget-session",
      cwd: "/projects/diary",
      stopHookActive: false,
      raw: {},
    });
    const output = result.hookSpecificOutput ?? "";
    const profileStart = output.indexOf("## Persona");
    const experienceStart = output.indexOf("## Experience");
    const profileBlock = output.slice(profileStart, experienceStart).trim();
    expect(profileStart).toBeGreaterThan(-1);
    expect(profileBlock).toContain("用户条目00");
    expect(profileBlock).toContain(
      `完整见 ${join(dataRoot, "persona", "generations", "1", "user-profile.md")}）`,
    );
    expect(estimateDiaryTokens(profileBlock)).toBeLessThanOrEqual(1_000);
    expect(result.asyncWork).toBeUndefined();
    const personaBlocks = output.slice(profileStart).trim();
    expect(estimateDiaryTokens(personaBlocks)).toBeLessThanOrEqual(
      PERSONA_INJECTION_TOKEN_BUDGET,
    );
  });

  test("renders fourteen UTC+8 daily lines and at most six monthly lines under the experience budget", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-context-index-"));
    dataRoots.push(dataRoot);
    const fileStore = new DiaryFileStore(dataRoot);
    const today = "2026-07-11";
    const todayEpoch = Date.parse(`${today}T12:00:00+08:00`) / 1_000;
    const dateBeforeToday = (days: number) =>
      new Date(Date.parse(`${today}T00:00:00Z`) - days * 86_400_000)
        .toISOString()
        .slice(0, 10);
    const recentRows = Array.from({ length: 14 }, (_, index) => ({
      date: dateBeforeToday(index + 1),
      indexHook: `近期${String(index + 1).padStart(2, "0")}日进展`,
    }));
    const mayHooks = [
      `甲${"长".repeat(99)}`,
      `乙${"长".repeat(99)}`,
      `丙${"长".repeat(99)}`,
    ];
    const oldMonths = [
      "2026-05",
      "2026-04",
      "2026-03",
      "2026-02",
      "2026-01",
      "2025-12",
      "2025-11",
    ];
    const oldRows = oldMonths.flatMap((month) => {
      const hooks =
        month === "2026-05"
          ? mayHooks
          : ["较长旧日甲信号", "较长旧日乙信号", "较长旧日丙信号"];
      return [
        { date: `${month}-28`, indexHook: hooks[0]! },
        { date: `${month}-20`, indexHook: hooks[0]! },
        { date: `${month}-12`, indexHook: hooks[1]! },
        { date: `${month}-04`, indexHook: hooks[2]! },
      ];
    });
    seedIndexRows(db, [...recentRows, ...oldRows]);
    await fileStore.ensureIndex([...recentRows, ...oldRows]);
    await fileStore.commitPersonaGeneration({
      generation: 1,
      manifest: { operation_id: "context-index", generation: 1 },
      userProfile: "## 身份与背景\n## 专长与判断力\n## 品味与兴趣\n## 沟通风格\n## 协作偏好\n",
      experience: "## 项目\n## 通用\n",
    });
    upsertSession(db, {
      contentSessionId: "diary-index-budget-session",
      project: "/projects/diary",
      title: "Diary index budget session",
      content: "Existing context precedes the rolling diary index.",
      insight: null,
      createdAtEpoch: todayEpoch,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    const result = await createContextHandler({
      db,
      fileStore,
      diaryStateStore: createDiaryStateStore(db),
      nowEpoch: () => todayEpoch,
    })({
      eventName: "SessionStart",
      source: "startup",
      sessionId: "diary-index-budget-session",
      cwd: "/projects/diary",
      stopHookActive: false,
      raw: {},
    });
    const output = result.hookSpecificOutput ?? "";
    const indexBlock = output.slice(output.indexOf("## Experience")).trim();
    const indexLines = indexBlock.split("\n").filter(Boolean);

    expect(estimateDiaryTokens(indexBlock)).toBeLessThanOrEqual(2_000);
    expect(indexBlock).toContain("## 近期");
    expect(indexBlock).not.toContain("## Diary Index");
    for (const row of recentRows) {
      expect(indexLines).toContain(`- ${row.date}：${row.indexHook}`);
    }
    expect(indexLines.some((line) => /^- \d{4}-\d{2}-\d{2}：/.test(line) && line.includes("旧日"))).toBe(false);
    const monthLines = indexLines.filter((line) => /^- \d{4}-\d{2}：/.test(line));
    expect(monthLines.map((line) => line.slice(2, 9))).toEqual(
      oldMonths.slice(0, 6),
    );
    expect(indexBlock).not.toContain("- 2025-11：");
    const mayLine = monthLines[0]!;
    const maySummary = mayLine.slice("- 2026-05：".length);
    expect(Array.from(maySummary).length).toBe(240);
    expect(maySummary).toBe(
      Array.from(mayHooks.join("；")).slice(0, 240).join(""),
    );
    expect(result.asyncWork).toBeUndefined();
  });

  test("requeues a settled day whose canonical diary file is missing", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-context-gap-file-"));
    dataRoots.push(dataRoot);
    const fileStore = new DiaryFileStore(dataRoot);
    const stateStore = createDiaryStateStore(db);
    const nowEpoch = Date.parse("2026-07-11T12:00:00+08:00") / 1_000;
    const session = upsertSession(db, {
      contentSessionId: "diary-missing-file-session",
      project: "/projects/diary",
      title: "Context survives diary file loss",
      content: null,
      insight: null,
      createdAtEpoch: nowEpoch,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
    const material = {
      turnId: 1,
      status: "skipped",
      userPrompt: "settled material",
      assistantResponse: "settled response",
      title: null,
      content: null,
      insight: null,
    };
    const inserted = db
      .query<{ id: number }, [number, string, string, number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt,
           assistant_response, created_at_epoch
         ) VALUES (?, 1, 'skipped', ?, ?, ?) RETURNING id`,
      )
      .get(
        session.id,
        material.userPrompt,
        material.assistantResponse,
        Date.parse("2026-07-10T12:00:00+08:00") / 1_000,
      )!;
    material.turnId = inserted.id;
    stateStore.initializeBootstrap("2026-07-11");
    stateStore.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 100 });
    const claimed = stateStore.claimNextDiaryItem(200)!;
    stateStore.settleDay({
      date: "2026-07-10",
      queueSeq: claimed.seq,
      watermark: computeDiaryWatermark([material]),
      fileSha256: "missing-file-sha",
      indexHook: "missing file hook",
      settledAtEpoch: 250,
    });
    let kickCalls = 0;

    const result = await createContextHandler({
      db,
      diaryStateStore: stateStore,
      fileStore,
      nowEpoch: () => nowEpoch,
      kickWorkerFast: async () => {
        kickCalls += 1;
      },
    })({
      eventName: "SessionStart",
      source: "startup",
      sessionId: "diary-missing-file-session",
      cwd: "/projects/diary",
      stopHookActive: false,
      raw: {},
    });

    expect(result.hookSpecificOutput).toContain("claude-mnemo: 1 sessions");
    expect(stateStore.getDayState("2026-07-10")?.needsRegen).toBe(true);
    expect(stateStore.hasQueuedDay("2026-07-10")).toBe(true);
    expect(kickCalls).toBe(1);
  });

  test("rotates canonical validation across ten historical diaries per SessionStart", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-context-integrity-"));
    dataRoots.push(dataRoot);
    const fileStore = new DiaryFileStore(dataRoot);
    const stateStore = createDiaryStateStore(db);
    stateStore.initializeBootstrap("2026-06-20");
    const dates = [
      "2026-06-10",
      "2026-06-11",
      "2026-06-12",
      "2026-06-13",
      "2026-06-14",
      "2026-06-15",
      "2026-06-16",
      "2026-06-17",
      "2026-06-18",
      "2026-06-19",
      "2026-06-20",
      "2026-06-21",
    ];

    for (const date of dates) {
      const watermark = `watermark-${date}`;
      const indexHook = `hook-${date}`;
      const bytes = compileDiaryDocument({
        date,
        sessions: ["S1"],
        projects: ["/projects/diary"],
        watermark,
        indexHook,
        body: [
          "## 工作",
          "- 完成历史完整性检查 [S1/T1]",
          "## 人物",
          "- 完成历史人物检查 [S1/T1]",
          "## 反思",
          "- 完成历史反思检查 [S1/T1]",
        ].join("\n"),
      });
      await fileStore.commitDiary(date, bytes);
      stateStore.enqueueDay({ date, enqueuedAtEpoch: 100 });
      const claimed = stateStore.claimNextDiaryItem(200)!;
      stateStore.settleDay({
        date,
        queueSeq: claimed.seq,
        watermark,
        fileSha256: createHash("sha256").update(bytes).digest("hex"),
        indexHook,
        settledAtEpoch: 250,
      });
    }
    const invalidV1Bytes = new TextEncoder().encode(
      [
        "---",
        "format: 1",
        'date: "2026-06-15"',
        'sessions: ["S1"]',
        'projects: ["/projects/diary"]',
        'watermark: "watermark-2026-06-15"',
        'index_hook: "hook-2026-06-15"',
        "---",
        "## 工作",
        "- v1 document [S1/T1]",
        "## 人物",
        "- v1 document [S1/T1]",
        "## 反思",
        "- v1 document [S1/T1]",
        "",
      ].join("\n"),
    );
    writeFileSync(join(dataRoot, "diary", "2026-06-15.md"), invalidV1Bytes);
    stateStore.commitDayState({
      date: "2026-06-15",
      watermark: "watermark-2026-06-15",
      fileSha256: createHash("sha256").update(invalidV1Bytes).digest("hex"),
      indexHook: "hook-2026-06-15",
      settledAtEpoch: 250,
    });
    rmSync(join(dataRoot, "diary", "2026-06-20.md"));
    upsertSession(db, {
      contentSessionId: "diary-integrity-session",
      project: "/projects/diary",
      title: "Rotating diary integrity",
      content: null,
      insight: null,
      createdAtEpoch: Date.parse("2026-07-30T12:00:00+08:00") / 1_000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
    let kickCalls = 0;
    const handler = createContextHandler({
      db,
      diaryStateStore: stateStore,
      fileStore,
      nowEpoch: () => Date.parse("2026-07-30T12:00:00+08:00") / 1_000,
      kickWorkerFast: async () => {
        kickCalls += 1;
      },
    });
    const input = {
      eventName: "SessionStart" as const,
      source: "startup" as const,
      sessionId: "diary-integrity-session",
      cwd: "/projects/diary",
      stopHookActive: false,
      raw: {},
    };

    await handler(input);

    expect(stateStore.getDayState("2026-06-15")?.needsRegen).toBe(true);
    expect(stateStore.hasQueuedDay("2026-06-15")).toBe(true);
    expect(stateStore.getDayState("2026-06-20")?.needsRegen).toBe(false);
    expect(stateStore.hasQueuedDay("2026-06-20")).toBe(false);

    await handler(input);

    expect(stateStore.getDayState("2026-06-20")?.needsRegen).toBe(true);
    expect(stateStore.hasQueuedDay("2026-06-20")).toBe(true);
    expect(kickCalls).toBe(2);
  });
});
