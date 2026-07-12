import { afterEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase } from "../../src/db/database";
import { createDiaryStateStore } from "../../src/db/diary-state";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { compileDiaryDocument } from "../../src/diary/domain";
import { DiaryFileStore } from "../../src/diary/file-store";
import { createDiaryRuntime } from "../../src/worker/diary-runtime";
import {
  CANONICAL_DIARY_WIRE_FORMAT_EXAMPLE,
  CANONICAL_PERSONA_WIRE_FORMAT_EXAMPLE,
} from "../../src/worker/prompt-wire-format";
import { main } from "../../src/worker/server";
import { saveTurnFixture } from "../support/turn-fixtures";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("createDiaryRuntime", () => {
  test("processes one diary and publishes the first persona generation", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-diary-runtime-"));
    roots.push(dataRoot);
    const globalClaudeMd = join(dataRoot, "global-CLAUDE.md");
    writeFileSync(globalClaudeMd, "# Global material\nPrefer runtime evidence.");
    const session = upsertSession(db, {
      contentSessionId: "runtime-session",
      project: "/projects/runtime",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
    saveTurnFixture(db, {
      sessionId: session.id,
      promptNumber: 1,
      userPrompt: "Remember that I want runtime wiring tested end to end.",
      assistantResponse: "I will keep the runtime boundary observable.",
      title: null,
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: Date.parse("2026-07-10T04:00:00Z") / 1_000,
      updatedAtEpoch: null,
      observations: [],
    });

    const prompts: string[] = [];
    const runtime = createDiaryRuntime({
      db,
      dataRoot,
      nowEpoch: () => 300,
      priorPersonaPath: globalClaudeMd,
      async runQuery(request) {
        prompts.push(request.prompt);
        if (request.prompt.includes("op: rebuild")) {
          expect(
            await request.toolHandlers.readDoc("diary/2026-07-10.md"),
          ).toContain("runtime");
          return [
            "===USER_PROFILE_V1_BEGIN===",
            `## 身份与背景\n## 专长与判断力\n## 品味与兴趣\n## 沟通风格\n## 协作偏好\n- 用户要求端到端验证 runtime [S${session.id}/T1]`,
            "===USER_PROFILE_V1_END===",
            "===EXPERIENCE_V1_BEGIN===",
            `## 项目\n## 通用\n- 我应维持可观察的 runtime 边界 [S${session.id}/T1]`,
            "===EXPERIENCE_V1_END===",
          ].join("\n");
        }

        const pulled = await request.toolHandlers.recall({
          id: `S${session.id}/T1`,
          fields: ["prompt", "response"],
        });
        expect(JSON.stringify(pulled)).toContain(
          "Remember that I want runtime wiring tested end to end.",
        );

        return [
          "===DIARY_V2_BEGIN===",
          "## 工作",
          `- 完成 runtime tracer [S${session.id}/T1]`,
          "## 人物",
          `- 用户要求端到端验证 [S${session.id}/T1]`,
          "## 反思",
          `- 保持 boundary 可观察 [S${session.id}/T1]`,

          "- 无",
          "===DIARY_V2_END===",
          "===INDEX_HOOK_V1===",
          "完成 diary runtime 纵向 tracer",
        ].join("\n");
      },
    });
    const stateStore = createDiaryStateStore(db);
    stateStore.initializeBootstrap("2026-07-11");
    stateStore.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 100 });
    const item = stateStore.claimNextDiaryItem(200);

    try {
      expect(item).not.toBeNull();
      await runtime.processDiaryItem(item!);
      expect(await runtime.runPersonaMaintenance()).toBe("completed");

      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain("op: rebuild");
      for (const sentinel of [
        "===USER_PROFILE_V1_BEGIN===",
        "===USER_PROFILE_V1_END===",
        "===EXPERIENCE_V1_BEGIN===",
        "===EXPERIENCE_V1_END===",
      ]) expect(prompts[1]).toContain(sentinel);
      for (const sentinel of [
        "===DIARY_V2_BEGIN===",
        "===DIARY_V2_END===",
        "===INDEX_HOOK_V1===",
      ]) expect(prompts[0]).toContain(sentinel);
      expect(prompts[0]).toContain(CANONICAL_DIARY_WIRE_FORMAT_EXAMPLE);
      expect(prompts[0]).toContain('"kind":"session_manifest"');
      expect(prompts[0]).toContain('"kind":"turn_manifest"');
      expect(prompts[0]).toContain('"kind":"global_claude_md"');
      expect(prompts[0]).toContain("Prefer runtime evidence.");
      expect(prompts[0]).not.toContain("source_response");
      expect(prompts[0]).not.toContain("### 项目");
      expect(prompts[0]).not.toMatch(/^\s*- 无\s*$/m);
      expect(prompts[1]).toContain(CANONICAL_PERSONA_WIRE_FORMAT_EXAMPLE);
      expect(prompts[1]).toContain("2026-07-10");
      expect(prompts[1]).toContain("完成 runtime tracer");
      expect(prompts[1]).toContain("USER_PROFILE_V1 block followed by one EXPERIENCE_V1 block");
      expect(prompts[1]).toContain("非强制，可自由增删改组织");
      expect(prompts[1]).toContain("会话注入只取每节前序行");
      expect(prompts[1]).toContain('"kind":"global_claude_md"');
      expect(prompts[1]).toContain("Prefer runtime evidence.");
      expect(
        (await new DiaryFileStore(dataRoot).loadCurrentPersona()).manifest,
      ).toMatchObject({
        generation: 1,
        op: "rebuild",
        last_folded_date_after: "2026-07-10",
      });
    } finally {
      db.close();
    }
  });

  test("trusts real database turn references even when absent from persona input material", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-runtime-allowset-"));
    roots.push(dataRoot);
    const trustedSession = upsertSession(db, {
      contentSessionId: "runtime-trusted-session",
      project: "/projects/runtime",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
    const pendingOnlySession = upsertSession(db, {
      contentSessionId: "runtime-pending-only-session",
      project: "/projects/runtime",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 2,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
    saveTurnFixture(db, {
      sessionId: trustedSession.id,
      promptNumber: 1,
      userPrompt: "Trusted persona evidence",
      assistantResponse: "Trusted response",
      title: null,
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: Date.parse("2026-07-10T04:00:00Z") / 1_000,
      updatedAtEpoch: null,
      observations: [],
    });
    saveTurnFixture(db, {
      sessionId: pendingOnlySession.id,
      promptNumber: 9,
      userPrompt: "Pending-only material must stay unreadable",
      assistantResponse: "This turn exists but is not trusted input",
      title: null,
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: Date.parse("2026-06-01T04:00:00Z") / 1_000,
      updatedAtEpoch: null,
      observations: [],
    });

    const date = "2026-07-10";
    const watermark = "runtime-allowset-watermark";
    const indexHook = "runtime allow-set provenance";
    const bytes = compileDiaryDocument({
      date,
      sessions: [`S${trustedSession.id}`],
      projects: ["/projects/runtime"],
      watermark,
      indexHook,
      body: [
        "## 工作",
        `- 可信事实 [S${trustedSession.id}/T1]`,
        "## 人物",
        `- 可信人物信号 [S${trustedSession.id}/T1]`,
        "## 反思",
        `- 可信协作反馈 [S${trustedSession.id}/T1]`,

      ].join("\n"),
    });
    const stateStore = createDiaryStateStore(db);
    const fileStore = new DiaryFileStore(dataRoot);
    stateStore.initializeBootstrap("2026-07-11");
    stateStore.enqueueDay({ date, enqueuedAtEpoch: 100 });
    const claimed = stateStore.claimNextDiaryItem(200)!;
    await fileStore.commitDiary(date, bytes);
    stateStore.settleDay({
      date,
      queueSeq: claimed.seq,
      watermark,
      fileSha256: createHash("sha256").update(bytes).digest("hex"),
      indexHook,
      settledAtEpoch: 300,
    });

    const runtime = createDiaryRuntime({
      db,
      dataRoot,
      nowEpoch: () => Date.parse("2026-07-11T04:00:00Z") / 1_000,
      async runQuery(request) {
        await expect(request.toolHandlers.readDoc(`diary/${date}.md`)).resolves.toContain("可信");
        await expect(
          request.toolHandlers.readDoc("persona/user-profile.md"),
        ).rejects.toThrow("outside the allowed scope");

        return [
          "===USER_PROFILE_V1_BEGIN===",
          `## 身份与背景\n- recall 可引入当前 diary 未引用的真实 turn [S${pendingOnlySession.id}/T9]`,
          "===USER_PROFILE_V1_END===",
          "===EXPERIENCE_V1_BEGIN===",
          `## 项目\n## 通用\n- 维持来源边界 [S${trustedSession.id}/T1]`,
          "===EXPERIENCE_V1_END===",
        ].join("\n");
      },
    });

    try {
      expect(await runtime.runPersonaMaintenance()).toBe("completed");
      expect((await fileStore.loadCurrentPersona()).userProfile).toContain(
        `[S${pendingOnlySession.id}/T9]`,
      );
    } finally {
      db.close();
    }
  });

  test("carries the previous rebuild accumulator through every production runtime batch", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-runtime-batches-"));
    roots.push(dataRoot);
    const stateStore = createDiaryStateStore(db);
    const fileStore = new DiaryFileStore(dataRoot);
    stateStore.initializeBootstrap("2026-07-11");

    const dates = ["2026-07-08", "2026-07-09", "2026-07-10"];
    for (const [index, date] of dates.entries()) {
      const watermark = `runtime-batch-watermark-${date}`;
      const indexHook = `runtime batch ${date}`;
      const bytes = compileDiaryDocument({
        date,
        sessions: ["S1"],
        projects: ["/projects/mnemo"],
        watermark,
        indexHook,
        body: [
          "## 工作",
          `- ${"批次素材".repeat(45)} [S1/T${index + 1}]`,
          "## 人物",
          `- 用户要求 runtime 保留上一批结果 [S1/T${index + 1}]`,
          "## 反思",
          `- 每批都传递 accumulator [S1/T${index + 1}]`,

          "- 无",
        ].join("\n"),
      });
      stateStore.enqueueDay({ date, enqueuedAtEpoch: 100 + index });
      const claimed = stateStore.claimNextDiaryItem(200 + index)!;
      await fileStore.commitDiary(date, bytes);
      stateStore.settleDay({
        date,
        queueSeq: claimed.seq,
        watermark,
        fileSha256: createHash("sha256").update(bytes).digest("hex"),
        indexHook,
        settledAtEpoch: 300 + index,
      });
    }

    const prompts: string[] = [];
    const runtime = createDiaryRuntime({
      db,
      dataRoot,
      nowEpoch: () => Date.parse("2026-07-11T04:00:00Z") / 1_000,
      personaRequestGateTokens: 800,
      personaAccumulatorReserveTokens: 0,
      personaRequestOverheadTokens: 100,
      async runQuery(request) {
        prompts.push(request.prompt);
        const batchNumber = prompts.length;
        const date = dates[batchNumber - 1]!;
        return [
          "===USER_PROFILE_V1_BEGIN===",
          `## 身份与背景\n## 专长与判断力\n## 品味与兴趣\n## 沟通风格\n## 协作偏好\n- runtime accumulator user ${batchNumber} [S1/T${batchNumber}${batchNumber === 1 ? "，S9/T9" : ""}]`,
          "===USER_PROFILE_V1_END===",
          "===EXPERIENCE_V1_BEGIN===",
          `## 项目\n## 通用\n- runtime accumulator experience ${batchNumber} [S1/T${batchNumber}]`,
          "===EXPERIENCE_V1_END===",
        ].join("\n");
      },
    });

    try {
      expect(await runtime.runPersonaMaintenance()).toBe("completed");
      expect(prompts).toHaveLength(3);
      expect(prompts[0]).not.toContain('"kind":"previous_accumulator"');
      expect(prompts[1]).toContain(
        JSON.stringify({
          kind: "previous_accumulator",
          userProfile:
            "## 身份与背景\n## 专长与判断力\n## 品味与兴趣\n## 沟通风格\n## 协作偏好\n- runtime accumulator user 1 [S1/T1]",
          experience: "## 项目\n## 通用\n- runtime accumulator experience 1 [S1/T1]",
        }),
      );
      expect(prompts[2]).toContain(
        JSON.stringify({
          kind: "previous_accumulator",
          userProfile:
            "## 身份与背景\n## 专长与判断力\n## 品味与兴趣\n## 沟通风格\n## 协作偏好\n- runtime accumulator user 2 [S1/T2]",
          experience: "## 项目\n## 通用\n- runtime accumulator experience 2 [S1/T2]",
        }),
      );
      for (const prompt of prompts.slice(1)) {
        expect(prompt).not.toContain('"kind":"previous_user_profile"');
        expect(prompt).not.toContain('"kind":"previous_experience"');
      }
      expect((await fileStore.loadCurrentPersona()).manifest.validation_report).toEqual({
        version: 2,
        total: 7,
        stripped: 1,
        items: [{ section: "USER_PROFILE/协作偏好", line: 6, original: "S9/T9" }],
      });
    } finally {
      db.close();
    }
  });

  test("production main wires the diary runtime boundaries into the worker core", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-main-runtime-"));
    roots.push(dataRoot);
    const stateStore = createDiaryStateStore(db);
    stateStore.initializeBootstrap("2026-07-11");
    stateStore.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 100 });
    const processedTargets: number[] = [];
    let factoryCalls = 0;
    let personaRuns = 0;
    const originalSetInterval = globalThis.setInterval;
    globalThis.setInterval = mock(
      () => 0 as unknown as NodeJS.Timeout,
    ) as typeof setInterval;

    try {
      await main({
        db,
        dataRoot,
        logger: { warn() {}, error() {} },
        createDiaryRuntimeImpl(options) {
          factoryCalls += 1;
          expect(options.db).toBe(db);
          expect(options.dataRoot).toBe(dataRoot);
          return {
            async processDiaryItem(item) {
              processedTargets.push(item.targetId);
              stateStore.acknowledgeDiaryItem(item.seq);
            },
            async runPersonaMaintenance() {
              personaRuns += 1;
              return "idle";
            },
          };
        },
        BunServeImpl: mock(() => ({ stop() {} })) as typeof Bun.serve,
        pidPath: join(dataRoot, "worker.pid"),
        startingPath: join(dataRoot, "worker.starting"),
        existsSyncImpl: () => false,
        mkdirSyncImpl: (() => undefined) as typeof import("node:fs").mkdirSync,
        writeFileSyncImpl: (() => undefined) as typeof import("node:fs").writeFileSync,
        unlinkSyncImpl: (() => undefined) as typeof import("node:fs").unlinkSync,
        processImpl: {
          pid: 12345,
          on: (() => undefined) as NodeJS.Process["on"],
          exit: (() => undefined as never) as NodeJS.Process["exit"],
        },
      });

      for (let i = 0; i < 10 && personaRuns === 0; i += 1) {
        await Promise.resolve();
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(factoryCalls).toBe(1);
      expect(processedTargets).toEqual([20260710]);
      expect(personaRuns).toBe(1);
    } finally {
      globalThis.setInterval = originalSetInterval;
      db.close();
    }
  });
});
