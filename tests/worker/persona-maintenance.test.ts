import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase } from "../../src/db/database";
import { createDiaryStateStore } from "../../src/db/diary-state";
import { initializeSchema } from "../../src/db/schema";
import {
  compileDiaryDocument,
  estimateDiaryTokens,
} from "../../src/diary/domain";
import { DiaryFileStore } from "../../src/diary/file-store";
import {
  EXPERIENCE_PUBLISHED_TOKEN_BUDGET,
  PROFILE_PUBLISHED_TOKEN_BUDGET,
} from "../../src/diary/persona-render";
import {
  createPersonaMaintainer,
  decidePersonaOperation,
  selectPersonaInputDays,
  validatePersonaEnvelopeForRequest,
  parsePersonaEnvelope,
  type PersonaRunRequest,
} from "../../src/worker/persona-maintenance";

const roots: string[] = [];

const validUserProfile = [
  "## 身份与背景",
  "## 专长与判断力",
  "## 品味与兴趣",
  "## 沟通风格",
  "## 协作偏好",
].join("\n");
const validExperience = ["## 项目", "## 通用"].join("\n");

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("createPersonaMaintainer", () => {
  test("applies periodic rebase and pending rebuild thresholds at their boundaries", () => {
    const cursor = (foldsSinceRebase: number) => ({
      lastFoldedDate: "2026-07-11",
      foldsSinceRebase,
      rebuildRequested: false,
    });
    const pendingDates = (count: number) => Array.from(
      { length: count },
      (_, index) => new Date(Date.UTC(2026, 4, 1 + index)).toISOString().slice(0, 10),
    );
    expect(decidePersonaOperation({ cursor: cursor(29), pendingDates: [], today: "2026-07-12" })).toBe("fold");
    expect(decidePersonaOperation({ cursor: cursor(30), pendingDates: [], today: "2026-07-12" })).toBe("rebase");
    expect(decidePersonaOperation({ cursor: cursor(0), pendingDates: pendingDates(30), today: "2026-07-12" })).toBe("rebase");
    expect(decidePersonaOperation({ cursor: cursor(0), pendingDates: pendingDates(31), today: "2026-07-12" })).toBe("rebuild");
    expect(decidePersonaOperation({ cursor: cursor(0), pendingDates: ["2026-04-14"], today: "2026-07-12" })).toBe("rebase"); // 89 days
    expect(decidePersonaOperation({ cursor: cursor(0), pendingDates: ["2026-04-13"], today: "2026-07-12" })).toBe("rebase"); // 90 days
    expect(decidePersonaOperation({ cursor: cursor(0), pendingDates: ["2026-04-12"], today: "2026-07-12" })).toBe("rebuild"); // 91 days
  });

  test("selects only the latest 30 settled days plus old pending days for rebase", () => {
    const settledDays = Array.from({ length: 40 }, (_, index) => ({
      date: new Date(Date.UTC(2026, 4, 1 + index)).toISOString().slice(0, 10),
    }));
    const selected = selectPersonaInputDays({
      operation: "rebase",
      settledDays,
      pendingDays: [settledDays[2]!],
      lastFoldedDate: "2026-06-09",
    });
    expect(selected.map((day) => day.date)).toEqual([
      settledDays[2]!.date,
      ...settledDays.slice(-30).map((day) => day.date),
    ]);
    expect(selected).not.toContainEqual(settledDays[1]);
  });
  test("marks an invalid diary stale and defers persona maintenance until it re-settles", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-persona-invalid-diary-"));
    roots.push(dataRoot);
    const stateStore = createDiaryStateStore(db);
    const fileStore = new DiaryFileStore(dataRoot);
    const date = "2026-07-10";
    stateStore.initializeBootstrap("2026-07-11");
    const bytes = new TextEncoder().encode(
      [
        "---",
        "format: 1",
        `date: ${JSON.stringify(date)}`,
        'sessions: ["S1"]',
        'projects: ["/projects/mnemo"]',
        'watermark: "invalid-format-watermark"',
        'index_hook: "invalid format"',
        "---",
        "## 工作",
        "- invalid format [S1/T1]",
        "## 人物",
        "- invalid format [S1/T1]",
        "## 反思",
        "- invalid format [S1/T1]",
        "",
      ].join("\n"),
    );
    await fileStore.commitDiary(date, bytes);
    stateStore.enqueueDay({ date, enqueuedAtEpoch: 100 });
    stateStore.commitDayState({
      date,
      watermark: "invalid-format-watermark",
      fileSha256: createHash("sha256").update(bytes).digest("hex"),
      indexHook: "invalid format",
      settledAtEpoch: 300,
    });
    let agentCalls = 0;
    const maintainer = createPersonaMaintainer({
      stateStore,
      fileStore,
      async runPersona() {
        agentCalls += 1;
        throw new Error("persona agent must not run");
      },
    });

    expect(await maintainer.runPersonaMaintenance()).toBe("deferred");
    expect(stateStore.getDayState(date)?.needsRegen).toBe(true);
    expect(stateStore.hasQueuedDay(date)).toBe(true);
    expect(stateStore.getPersonaOperation()).toBeNull();
    expect(agentCalls).toBe(0);
    db.close();
  });

  test("resumes from frozen generations after CURRENT is corrupted between batches", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-persona-corrupt-resume-"));
    roots.push(dataRoot);
    const stateStore = createDiaryStateStore(db);
    const fileStore = new DiaryFileStore(dataRoot);
    stateStore.initializeBootstrap("2026-07-11");
    await fileStore.commitPersonaGeneration({
      generation: 5,
      manifest: {
        operation_id: "published-five",
        op: "fold",
        generation: 5,
        last_folded_date_after: "2026-07-07",
        folds_since_rebase_after: 2,
        consumed_pending_dates: [],
        partial_missing_dates_after: [],
      },
      userProfile: validUserProfile,
      experience: validExperience,
    });
    stateStore.commitPersonaCursor({
      lastFoldedDate: "2026-07-07",
      lastAppliedOperationId: "published-five",
      foldsSinceRebase: 2,
      rebuildRequested: true,
    });

    for (const [index, date] of ["2026-07-08", "2026-07-09"].entries()) {
      const bytes = compileDiaryDocument({
        date,
        sessions: ["S1"],
        projects: ["/projects/mnemo"],
        watermark: `watermark-${date}`,
        indexHook: `index-${date}`,
        body: [
          "## 工作",
          `- ${"批次素材".repeat(45)} [S1/T${index + 1}]`,
          "## 人物",
          `- 用户偏好冻结恢复 [S1/T${index + 1}]`,
          "## 反思",
          `- 发布代次不得回退 [S1/T${index + 1}]`,
          "- 无",
        ].join("\n"),
      });
      stateStore.enqueueDay({ date, enqueuedAtEpoch: 100 + index });
      const claimed = stateStore.claimNextDiaryItem(200 + index)!;
      await fileStore.commitDiary(date, bytes);
      stateStore.settleDay({
        date,
        queueSeq: claimed.seq,
        watermark: `watermark-${date}`,
        fileSha256: createHash("sha256").update(bytes).digest("hex"),
        indexHook: `index-${date}`,
        validationReportJson: JSON.stringify({ version: 1, total: 3, deleted: 0, items: [] }),
        settledAtEpoch: 300 + index,
      });
    }

    let nowEpoch = 1_000;
    let calls = 0;
    const maintainer = createPersonaMaintainer({
      stateStore,
      fileStore,
      operationId: () => "frozen-generation-operation",
      nowEpoch: () => nowEpoch,
      requestGateTokens: 800,
      accumulatorReserveTokens: 0,
      requestOverheadTokens: 100,
      async runPersona(request) {
        calls += 1;
        if (calls === 2) throw new Error("pause after batch one");
        const ref = calls === 1 ? "S1/T1，S9/T9" : "S1/T2";
        return [
          "===USER_PROFILE_V1_BEGIN===",
          `${validUserProfile}\n- frozen profile [${ref}]`,
          "===USER_PROFILE_V1_END===",
          "===EXPERIENCE_V1_BEGIN===",
          `${validExperience}\n- frozen experience [${ref}]`,
          "===EXPERIENCE_V1_END===",
        ].join("\n");
      },
    });

    await expect(maintainer.runPersonaMaintenance()).rejects.toThrow("pause after batch one");
    expect(stateStore.getPersonaOperation()).toMatchObject({
      baseGeneration: 5,
      targetGeneration: 6,
      nextBatchIndex: 1,
    });
    expect(stateStore.getPersonaCursor().rebuildRequested).toBe(true);
    writeFileSync(join(dataRoot, "persona", "CURRENT"), "corrupt CURRENT");

    nowEpoch += 61;
    expect(await maintainer.runPersonaMaintenance()).toBe("completed");
    const published = await fileStore.loadCurrentPersona();
    expect(published.generation).toBe(6);
    expect(published.manifest.generation).toBe(6);
    expect(published.manifest.operation_id).toBe("frozen-generation-operation");
    expect(published.manifest.validation_report).toEqual({
      version: 2,
      total: 6,
      stripped: 2,
      items: [
        { section: "USER_PROFILE/协作偏好", line: 6, original: "S9/T9" },
        { section: "EXPERIENCE/通用", line: 3, original: "S9/T9" },
      ],
    });
    expect(stateStore.getPersonaCursor().rebuildRequested).toBe(false);
    expect(stateStore.getPersonaOperation()).toBeNull();
    db.close();
  });

  test("accepts free-form and legacy envelopes across rebuild, fold, and rebase", () => {
    const diary = [
      "---", "format: 2", 'projects: ["/projects/mnemo/../mnemo"]', "---",
      "- source [S1/T1]",
    ].join("\n");
    const freeFormProfile = [
      "# 此刻与长期倾向",
      "用户偏爱用证据推进复杂工作 [S1/T1]",
      "## 文化兴趣",
      "尚待更多材料。",
    ].join("\n");
    const freeFormExperience = [
      "### 2026 年轨迹",
      "2026-07-10：用户启动了记忆系统维护 [S1/T1]",
    ].join("\n");
    const envelope = (profile: string, experience: string) => [
      "===USER_PROFILE_V1_BEGIN===", profile, "===USER_PROFILE_V1_END===",
      "===EXPERIENCE_V1_BEGIN===", experience, "===EXPERIENCE_V1_END===",
    ].join("\n");
    const previousPersona = { userProfile: validUserProfile, experience: validExperience };
    const requests: PersonaRunRequest[] = [
      { op: "rebuild", diaries: [{ date: "2026-07-10", content: diary }] },
      { op: "fold", previousPersona, diaries: [{ date: "2026-07-10", content: diary }] },
      { op: "rebase", previousPersona, diaries: [{ date: "2026-07-10", content: diary }] },
    ];
    for (const request of requests) {
      expect(validatePersonaEnvelopeForRequest(
        envelope(freeFormProfile, freeFormExperience),
        request,
      )).toEqual({ userProfile: freeFormProfile, experience: freeFormExperience });
      expect(() => validatePersonaEnvelopeForRequest(
        envelope(validUserProfile, validExperience),
        request,
      )).not.toThrow();
    }
  });

  test("rebuild later batches allow accumulator refs but never old CURRENT-only refs", () => {
    const diary = { date: "2026-07-11", content: "- batch two [S2/T2]" };
    const accumulator = {
      userProfile: `${validUserProfile}\n- carried [S1/T1]`,
      experience: `${validExperience}\n- carried [S1/T1]`,
    };
    const request: PersonaRunRequest = { op: "rebuild", accumulator, diaries: [diary] };
    const make = (ref: string) => [
      "===USER_PROFILE_V1_BEGIN===", `${validUserProfile}\n- trait [${ref}]`, "===USER_PROFILE_V1_END===",
      "===EXPERIENCE_V1_BEGIN===", `${validExperience}\n- memory [${ref}]`, "===EXPERIENCE_V1_END===",
    ].join("\n");
    expect(validatePersonaEnvelopeForRequest(make("S1/T1"), request).userProfile).toContain("[S1/T1]");
    expect(validatePersonaEnvelopeForRequest(make("S9/T9"), request).userProfile).not.toContain("[S9/T9]");
  });

  test("anchors expanded budgets and rejects bodies over their commit budgets", () => {
    expect(PROFILE_PUBLISHED_TOKEN_BUDGET).toBe(4_000);
    expect(EXPERIENCE_PUBLISHED_TOKEN_BUDGET).toBe(6_000);
    const request: PersonaRunRequest = { op: "rebuild", diaries: [{ date: "2026-07-10", content: "- source [S1/T1]" }] };
    const raw = [
      "===USER_PROFILE_V1_BEGIN===", `# Profile\n${"汉".repeat(4_100)}`, "===USER_PROFILE_V1_END===",
      "===EXPERIENCE_V1_BEGIN===", `# Experience\n${"汉".repeat(6_100)}`, "===EXPERIENCE_V1_END===",
    ].join("\n");
    expect(() => validatePersonaEnvelopeForRequest(raw, request)).toThrow("profile_budget");
    expect(() => validatePersonaEnvelopeForRequest(raw, request)).toThrow("experience_budget");
  });

  test("requires both v1 blocks and at least one parsed heading in each", () => {
    const envelope = [
      "===USER_PROFILE_V1_BEGIN===",
      validUserProfile,
      "===USER_PROFILE_V1_END===",
      "===EXPERIENCE_V1_BEGIN===",
      validExperience,
      "===EXPERIENCE_V1_END===",
    ].join("\n");

    expect(parsePersonaEnvelope(envelope)).toEqual({
      userProfile: validUserProfile,
      experience: validExperience,
    });
    expect(() =>
      parsePersonaEnvelope(
        envelope.replace(
          "===EXPERIENCE_V1_BEGIN===\n## 项目\n## 通用\n===EXPERIENCE_V1_END===",
          "",
        ),
      ),
    ).toThrow("invalid persona envelope: EXPERIENCE");
    expect(() => parsePersonaEnvelope(
      envelope.replace("## 项目\n## 通用", "plain experience without headings"),
    )).toThrow("missing persona heading: EXPERIENCE");
    expect(() => parsePersonaEnvelope(
      envelope.replace(validUserProfile, "plain profile without headings"),
    )).toThrow("missing persona heading: USER_PROFILE");
    expect(() =>
      parsePersonaEnvelope(
        envelope.replace(
          "===USER_PROFILE_V1_END===\n===EXPERIENCE_V1_BEGIN===",
          "===USER_PROFILE_V1_END===\nextra\n===EXPERIENCE_V1_BEGIN===",
        ),
      ),
    ).toThrow("invalid persona envelope ordering");
    expect(() => parsePersonaEnvelope(`${envelope}\nextra`)).toThrow(
      "invalid persona envelope ordering",
    );
    const userBlock = envelope.slice(0, envelope.indexOf("===EXPERIENCE_V1_BEGIN==="));
    const experienceBlock = envelope.slice(envelope.indexOf("===EXPERIENCE_V1_BEGIN==="));
    expect(() => parsePersonaEnvelope(`${experienceBlock}\n${userBlock.trimEnd()}`)).toThrow();
  });

  test("cold-start rebuild publishes generation one before advancing the SQLite cursor", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-persona-"));
    roots.push(dataRoot);
    const stateStore = createDiaryStateStore(db);
    const fileStore = new DiaryFileStore(dataRoot);
    const date = "2026-07-10";
    const watermark = "watermark-2026-07-10";
    const indexHook = "完成 persona cold-start tracer";
    const diaryBytes = compileDiaryDocument({
      date,
      sessions: ["S1"],
      projects: ["/projects/mnemo"],
      watermark,
      indexHook,
      body: [
        "## 工作",
        "- 完成 persona tracer [S1/T1]",
        "## 人物",
        "- 用户要求严格 TDD [S1/T1]",
        "## 反思",
        "- 先验证再发布 [S1/T1]",

        "- 无",
      ].join("\n"),
    });
    const fileSha256 = createHash("sha256").update(diaryBytes).digest("hex");

    stateStore.initializeBootstrap("2026-07-11");
    stateStore.enqueueDay({ date, enqueuedAtEpoch: 100 });
    const claimed = stateStore.claimNextDiaryItem(200)!;
    await fileStore.commitDiary(date, diaryBytes);
    stateStore.settleDay({
      date,
      queueSeq: claimed.seq,
      watermark,
      fileSha256,
      indexHook,
      settledAtEpoch: 300,
    });

    const userProfile = "# 工作方式\n用户要求严格 TDD [S1/T1，S9/T9]\n";
    const publishedUserProfile = "# 工作方式\n用户要求严格 TDD [S1/T1]\n";
    const experience = "## 项目\n## 通用\n- 我应先验证再发布 [S1/T1]\n";
    let observedDiary = "";
    let personaCalls = 0;
    const maintainer = createPersonaMaintainer({
      stateStore,
      fileStore,
      operationId: () => "persona-operation-1",
      async runPersona(request) {
        personaCalls += 1;
        observedDiary = request.diaries[0]!.content;
        return [
          "===USER_PROFILE_V1_BEGIN===",
          userProfile,
          "===USER_PROFILE_V1_END===",
          "===EXPERIENCE_V1_BEGIN===",
          experience,
          "===EXPERIENCE_V1_END===",
        ].join("\n");
      },
    });

    try {
      await maintainer.runPersonaMaintenance();

      expect(personaCalls).toBe(1);
      expect(observedDiary).toBe(new TextDecoder().decode(diaryBytes));
      expect(await fileStore.loadCurrentPersona()).toMatchObject({
        generation: 1,
        manifest: {
          operation_id: "persona-operation-1",
          op: "rebuild",
          generation: 1,
          source_diary_date: date,
          last_folded_date_after: date,
          folds_since_rebase_after: 0,
          consumed_pending_dates: [],
          partial_missing_dates_after: [],
          validation_report: {
            version: 2,
            total: 3,
            stripped: 1,
            items: [{ section: "USER_PROFILE/工作方式", line: 2, original: "S9/T9" }],
          },
        },
        userProfile: publishedUserProfile,
        experience,
      });
      expect(stateStore.getPersonaCursor()).toMatchObject({
        lastFoldedDate: date,
        lastAppliedOperationId: "persona-operation-1",
        rebuildRequested: false,
      });
    } finally {
      db.close();
    }
  });

  test("cold-start rebuild waits for non-terminal diary days but records terminal gaps in a partial manifest", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-persona-gate-"));
    roots.push(dataRoot);
    const stateStore = createDiaryStateStore(db);
    const fileStore = new DiaryFileStore(dataRoot);
    const settledDate = "2026-07-09";
    const missingDate = "2026-07-10";
    const watermark = "watermark-persona-gate";
    const indexHook = "persona rebuild gate tracer";
    const diaryBytes = compileDiaryDocument({
      date: settledDate,
      sessions: ["S1"],
      projects: ["/projects/mnemo"],
      watermark,
      indexHook,
      body: [
        "## 工作",
        "- 验证 persona rebuild gate [S1/T1]",
        "## 人物",
        "- 用户不接受过早 partial [S1/T1]",
        "## 反思",
        "- terminal 缺日应明确记账 [S1/T1]",

        "- 无",
      ].join("\n"),
    });

    stateStore.initializeBootstrap("2026-07-11");
    stateStore.enqueueDay({ date: settledDate, enqueuedAtEpoch: 100 });
    const settledClaim = stateStore.claimNextDiaryItem(200)!;
    await fileStore.commitDiary(settledDate, diaryBytes);
    stateStore.settleDay({
      date: settledDate,
      queueSeq: settledClaim.seq,
      watermark,
      fileSha256: createHash("sha256").update(diaryBytes).digest("hex"),
      indexHook,
      settledAtEpoch: 300,
    });
    stateStore.enqueueDay({ date: missingDate, enqueuedAtEpoch: 101 });

    let agentCalls = 0;
    const maintainer = createPersonaMaintainer({
      stateStore,
      fileStore,
      operationId: () => "persona-gated-operation",
      nowEpoch: () => Date.parse("2026-07-11T00:00:00+08:00") / 1_000,
      async runPersona() {
        agentCalls += 1;
        return [
          "===USER_PROFILE_V1_BEGIN===",
          "## 身份与背景\n## 专长与判断力\n## 品味与兴趣\n## 沟通风格\n## 协作偏好\n- 用户要求完整日记优先 [S1/T1]",
          "===USER_PROFILE_V1_END===",
          "===EXPERIENCE_V1_BEGIN===",
          "## 项目\n## 通用\n- 我应标明 terminal 缺口 [S1/T1]",
          "===EXPERIENCE_V1_END===",
        ].join("\n");
      },
    });

    try {
      expect(await maintainer.runPersonaMaintenance()).toBe("deferred");
      expect(agentCalls).toBe(0);

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const claim = stateStore.claimNextDiaryItem(400 + attempt)!;
        stateStore.recordFailure({
          date: missingDate,
          queueSeq: claim.seq,
          error: `terminal diary failure ${attempt}`,
          nextAttemptEpoch: 400 + attempt + 1,
        });
      }

      expect(await maintainer.runPersonaMaintenance()).toBe("completed");
      expect(agentCalls).toBe(1);
      expect((await fileStore.loadCurrentPersona()).manifest).toMatchObject({
        op: "rebuild",
        source_diary_date: settledDate,
        last_folded_date_after: settledDate,
        partial_missing_dates_after: [missingDate],
      });
    } finally {
      db.close();
    }
  });

  test("folds only the next settled diary into generation two", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-persona-fold-"));
    roots.push(dataRoot);
    const stateStore = createDiaryStateStore(db);
    const fileStore = new DiaryFileStore(dataRoot);
    stateStore.initializeBootstrap("2026-07-11");
    const missingDate = "2026-07-08";
    stateStore.enqueueDay({ date: missingDate, enqueuedAtEpoch: 90 });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claim = stateStore.claimNextDiaryItem(90 + attempt)!;
      stateStore.recordFailure({ date: missingDate, queueSeq: claim.seq, error: "terminal gap", nextAttemptEpoch: 91 + attempt });
    }

    const settleDiary = async (date: string, promptNumber: number) => {
      const watermark = `watermark-${date}`;
      const indexHook = `persona input ${date}`;
      const bytes = compileDiaryDocument({
        date,
        sessions: ["S1"],
        projects: ["/projects/mnemo"],
        watermark,
        indexHook,
        body: [
          "## 工作",
          `- 完成 ${date} diary [S1/T${promptNumber}]`,
          "## 人物",
          `- 保留 ${date} signal [S1/T${promptNumber}]`,
          "## 反思",
          `- 验证 ${date} fold [S1/T${promptNumber}]`,

          "- 无",
        ].join("\n"),
      });
      stateStore.enqueueDay({ date, enqueuedAtEpoch: 100 + promptNumber });
      const claimed = stateStore.claimNextDiaryItem(200 + promptNumber)!;
      await fileStore.commitDiary(date, bytes);
      stateStore.settleDay({
        date,
        queueSeq: claimed.seq,
        watermark,
        fileSha256: createHash("sha256").update(bytes).digest("hex"),
        indexHook,
        settledAtEpoch: 300 + promptNumber,
      });
      return new TextDecoder().decode(bytes);
    };

    const firstDate = "2026-07-09";
    const secondDate = "2026-07-10";
    const firstDiary = await settleDiary(firstDate, 1);
    const firstUserProfile =
      "## 身份与背景\n## 专长与判断力\n## 品味与兴趣\n## 沟通风格\n## 协作偏好\n- 用户要求按日期顺序维护 persona [S1/T1]\n";
    const firstExperience =
      "## 项目\n## 通用\n- 我应只吸收已结算日记 [S1/T1]\n";
    const foldedUserProfile =
      "## 身份与背景\n## 专长与判断力\n## 品味与兴趣\n## 沟通风格\n## 协作偏好\n- 用户要求按日期顺序维护 persona [S1/T1]\n";
    const foldedExperience =
      "## 项目\n## 通用\n- 我应只吸收新的顺序日记 [S1/T1]\n";
    const requests: Parameters<
      Parameters<typeof createPersonaMaintainer>[0]["runPersona"]
    >[0][] = [];
    let nextOperation = 1;
    const maintainer = createPersonaMaintainer({
      stateStore,
      fileStore,
      operationId: () => `persona-operation-${nextOperation++}`,
      async runPersona(request) {
        requests.push(request);
        const isFold = request.op === "fold";
        return [
          "===USER_PROFILE_V1_BEGIN===",
          isFold ? foldedUserProfile : firstUserProfile,
          "===USER_PROFILE_V1_END===",
          "===EXPERIENCE_V1_BEGIN===",
          isFold ? foldedExperience : firstExperience,
          "===EXPERIENCE_V1_END===",
        ].join("\n");
      },
    });

    try {
      await maintainer.runPersonaMaintenance();
      const secondDiary = await settleDiary(secondDate, 2);
      await maintainer.runPersonaMaintenance();

      expect(requests[0]).toMatchObject({
        op: "rebuild",
        diaries: [{ date: firstDate, content: firstDiary }],
      });
      expect(requests[1]).toEqual({
        op: "fold",
        previousPersona: {
          userProfile: firstUserProfile,
          experience: firstExperience,
        },
        diaries: [{ date: secondDate, content: secondDiary }],
      });
      expect(await fileStore.loadCurrentPersona()).toMatchObject({
        generation: 2,
        manifest: {
          operation_id: "persona-operation-2",
          op: "fold",
          generation: 2,
          source_diary_date: secondDate,
          last_folded_date_after: secondDate,
          folds_since_rebase_after: 1,
          consumed_pending_dates: [],
          partial_missing_dates_after: [missingDate],
        },
        userProfile: foldedUserProfile,
        experience: foldedExperience,
      });
      expect(stateStore.getPersonaCursor()).toMatchObject({
        lastFoldedDate: secondDate,
        lastAppliedOperationId: "persona-operation-2",
        rebuildRequested: false,
      });
    } finally {
      db.close();
    }
  });

  test("rebases a corrected historical diary and clears its pending marker", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-persona-rebase-"));
    roots.push(dataRoot);
    const stateStore = createDiaryStateStore(db);
    const fileStore = new DiaryFileStore(dataRoot);
    stateStore.initializeBootstrap("2026-07-11");

    const publishDiary = async (
      date: string,
      promptNumber: number,
      signal: string,
    ) => {
      const watermark = `watermark-${date}-corrected`;
      const indexHook = `corrected diary ${date}`;
      const bytes = compileDiaryDocument({
        date,
        sessions: ["S1"],
        projects: ["/projects/mnemo"],
        watermark,
        indexHook,
        body: [
          "## 工作",
          `- ${signal} [S1/T${promptNumber}]`,
          "## 人物",
          `- 修正 ${date} 人物信号 [S1/T${promptNumber}]`,
          "## 反思",
          `- 验证历史 rebase [S1/T${promptNumber}]`,

          "- 无",
        ].join("\n"),
      });
      const fileSha256 = createHash("sha256").update(bytes).digest("hex");
      stateStore.enqueueDay({ date, enqueuedAtEpoch: 100 + promptNumber });
      const claimed = stateStore.claimNextDiaryItem(200 + promptNumber)!;
      await fileStore.commitDiary(date, bytes);
      stateStore.settleDay({
        date,
        queueSeq: claimed.seq,
        watermark,
        fileSha256,
        indexHook,
        settledAtEpoch: 300 + promptNumber,
      });
      return { bytes, content: new TextDecoder().decode(bytes), watermark, indexHook, fileSha256 };
    };

    const corrected = await publishDiary(
      "2026-07-09",
      1,
      "修正旧日记中的人物判断",
    );
    const latest = await publishDiary("2026-07-10", 2, "保留最新日记事实");
    stateStore.commitDayState({
      date: "2026-07-09",
      watermark: corrected.watermark,
      fileSha256: corrected.fileSha256,
      indexHook: corrected.indexHook,
      settledAtEpoch: 400,
      pendingRebase: true,
    });

    const oldUserProfile =
      "## 身份与背景\n## 专长与判断力\n## 品味与兴趣\n## 沟通风格\n## 协作偏好\n- 用户重视可追溯的历史修正 [S1/T1]\n";
    const oldExperience =
      "## 项目\n## 通用\n- 我应在旧日记修正后执行 rebase [S1/T1]\n";
    await fileStore.commitPersonaGeneration({
      generation: 2,
      manifest: {
        operation_id: "persona-operation-2",
        op: "fold",
        generation: 2,
        source_diary_date: "2026-07-10",
        last_folded_date_after: "2026-07-10",
        folds_since_rebase_after: 1,
        consumed_pending_dates: [],
        partial_missing_dates_after: [],
      },
      userProfile: oldUserProfile,
      experience: oldExperience,
    });
    stateStore.commitPersonaCursor({
      lastFoldedDate: "2026-07-10",
      lastAppliedOperationId: "persona-operation-2",
      foldsSinceRebase: 1,
      rebuildRequested: false,
    });

    const rebasedUserProfile =
      "## 身份与背景\n## 专长与判断力\n## 品味与兴趣\n## 沟通风格\n## 协作偏好\n- 用户重视经修正且可追溯的事实 [S1/T1]\n";
    const rebasedExperience =
      "## 项目\n## 通用\n- 我已吸收历史日记修正 [S1/T1]\n";
    const requests: PersonaRunRequest[] = [];
    const maintainer = createPersonaMaintainer({
      stateStore,
      fileStore,
      operationId: () => "persona-operation-3",
      async runPersona(request) {
        requests.push(request);
        stateStore.commitDayState({
          date: "2026-07-10",
          watermark: latest.watermark,
          fileSha256: latest.fileSha256,
          indexHook: latest.indexHook,
          settledAtEpoch: 500,
          pendingRebase: true,
        });
        return [
          "===USER_PROFILE_V1_BEGIN===",
          rebasedUserProfile,
          "===USER_PROFILE_V1_END===",
          "===EXPERIENCE_V1_BEGIN===",
          rebasedExperience,
          "===EXPERIENCE_V1_END===",
        ].join("\n");
      },
    });

    try {
      await maintainer.runPersonaMaintenance();

      expect(requests).toEqual([
        {
          op: "rebase",
          previousPersona: {
            userProfile: oldUserProfile,
            experience: oldExperience,
          },
          diaries: [
            { date: "2026-07-09", content: corrected.content },
            { date: "2026-07-10", content: latest.content },
          ],
        },
      ]);
      expect(await fileStore.loadCurrentPersona()).toMatchObject({
        generation: 3,
        manifest: {
          operation_id: "persona-operation-3",
          op: "rebase",
          generation: 3,
          source_diary_date: "2026-07-09",
          last_folded_date_after: "2026-07-10",
          folds_since_rebase_after: 0,
          consumed_pending_dates: ["2026-07-09"],
          partial_missing_dates_after: [],
        },
        userProfile: rebasedUserProfile,
        experience: rebasedExperience,
      });
      expect(stateStore.getDayState("2026-07-09")?.pendingRebase).toBe(false);
      expect(stateStore.getDayState("2026-07-10")?.pendingRebase).toBe(true);
      expect(stateStore.getPersonaCursor()).toEqual({
        lastFoldedDate: "2026-07-10",
        lastAppliedOperationId: "persona-operation-3",
        foldsSinceRebase: 0,
        rebuildRequested: false,
      });
    } finally {
      db.close();
    }
  });

  test("persists the first persona failure and defers retries until their due time", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-persona-failure-"));
    roots.push(dataRoot);
    const stateStore = createDiaryStateStore(db);
    const fileStore = new DiaryFileStore(dataRoot);
    const date = "2026-07-10";
    const watermark = "watermark-persona-failure";
    const indexHook = "persona failure state tracer";
    const diaryBytes = compileDiaryDocument({
      date,
      sessions: ["S1"],
      projects: ["/projects/mnemo"],
      watermark,
      indexHook,
      body: [
        "## 工作",
        "- 验证 persona 失败状态 [S1/T1]",
        "## 人物",
        "- 用户要求失败可恢复 [S1/T1]",
        "## 反思",
        "- 退避期间不得重调 agent [S1/T1]",

        "- 无",
      ].join("\n"),
    });
    stateStore.initializeBootstrap("2026-07-11");
    stateStore.enqueueDay({ date, enqueuedAtEpoch: 100 });
    const claimed = stateStore.claimNextDiaryItem(200)!;
    await fileStore.commitDiary(date, diaryBytes);
    stateStore.settleDay({
      date,
      queueSeq: claimed.seq,
      watermark,
      fileSha256: createHash("sha256").update(diaryBytes).digest("hex"),
      indexHook,
      settledAtEpoch: 300,
    });

    let nowEpoch = 1_000;
    let agentCalls = 0;
    const maintainer = createPersonaMaintainer({
      stateStore,
      fileStore,
      operationId: () => "persona-failure-operation",
      nowEpoch: () => nowEpoch,
      async runPersona() {
        agentCalls += 1;
        throw new Error("persona agent failed");
      },
    });

    try {
      await expect(maintainer.runPersonaMaintenance()).rejects.toThrow(
        "persona agent failed",
      );
      expect(stateStore.getPersonaOperation()).toMatchObject({
        operationId: "persona-failure-operation",
        op: "rebuild",
        inputDatesSnapshot: [date],
        attemptCount: 1,
        nextAttemptEpoch: 1_060,
        lastError: "persona agent failed",
        terminal: false,
      });
      expect(stateStore.getPersonaCursor()).toEqual({
        lastFoldedDate: null,
        lastAppliedOperationId: null,
        foldsSinceRebase: 0,
        rebuildRequested: true,
      });
      await expect(fileStore.loadCurrentPersona()).rejects.toThrow();

      nowEpoch = 1_059;
      expect(await maintainer.runPersonaMaintenance()).toBe("deferred");
      expect(agentCalls).toBe(1);
    } finally {
      db.close();
    }
  });

  test("resumes a due persona operation with its frozen dates and original id", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-persona-resume-"));
    roots.push(dataRoot);
    const stateStore = createDiaryStateStore(db);
    const fileStore = new DiaryFileStore(dataRoot);
    stateStore.initializeBootstrap("2026-07-11");

    const settleDiary = async (date: string, promptNumber: number) => {
      const watermark = `watermark-resume-${date}`;
      const indexHook = `resume input ${date}`;
      const bytes = compileDiaryDocument({
        date,
        sessions: ["S1"],
        projects: ["/projects/mnemo"],
        watermark,
        indexHook,
        body: [
          "## 工作",
          `- 维护 ${date} persona 输入 [S1/T${promptNumber}]`,
          "## 人物",
          `- 冻结日期 ${date} [S1/T${promptNumber}]`,
          "## 反思",
          `- 到期后安全续跑 [S1/T${promptNumber}]`,

          "- 无",
        ].join("\n"),
      });
      stateStore.enqueueDay({ date, enqueuedAtEpoch: 100 + promptNumber });
      const claimed = stateStore.claimNextDiaryItem(200 + promptNumber)!;
      await fileStore.commitDiary(date, bytes);
      stateStore.settleDay({
        date,
        queueSeq: claimed.seq,
        watermark,
        fileSha256: createHash("sha256").update(bytes).digest("hex"),
        indexHook,
        settledAtEpoch: 300 + promptNumber,
      });
      return new TextDecoder().decode(bytes);
    };

    const frozenDate = "2026-07-09";
    const frozenDiary = await settleDiary(frozenDate, 1);
    const userProfile =
      "## 身份与背景\n## 专长与判断力\n## 品味与兴趣\n## 沟通风格\n## 协作偏好\n- 用户要求失败续跑不漂移输入 [S1/T1]\n";
    const experience =
      "## 项目\n## 通用\n- 我应复用冻结的 operation [S1/T1]\n";
    let nowEpoch = 1_000;
    let operationIdCalls = 0;
    const requests: unknown[] = [];
    const maintainer = createPersonaMaintainer({
      stateStore,
      fileStore,
      nowEpoch: () => nowEpoch,
      operationId: () => {
        operationIdCalls += 1;
        return "persona-resume-operation";
      },
      async runPersona(request) {
        requests.push(request);
        if (requests.length === 1) {
          return [
            "===USER_PROFILE_V1_BEGIN===", `# Too large\n${"汉".repeat(4_100)}`, "===USER_PROFILE_V1_END===",
            "===EXPERIENCE_V1_BEGIN===", validExperience, "===EXPERIENCE_V1_END===",
          ].join("\n");
        }
        return [
          "===USER_PROFILE_V1_BEGIN===",
          userProfile,
          "===USER_PROFILE_V1_END===",
          "===EXPERIENCE_V1_BEGIN===",
          experience,
          "===EXPERIENCE_V1_END===",
        ].join("\n");
      },
    });

    try {
      await expect(maintainer.runPersonaMaintenance()).rejects.toThrow(
        "persona validator feedback",
      );
      await settleDiary("2026-07-10", 2);

      nowEpoch = 1_060;
      expect(await maintainer.runPersonaMaintenance()).toBe("completed");

      expect(requests[0]).toEqual({
        op: "rebuild", diaries: [{ date: frozenDate, content: frozenDiary }],
      });
      expect(requests[1]).toMatchObject({
        op: "rebuild",
        diaries: [{ date: frozenDate, content: frozenDiary }],
        validatorFeedback: { version: 1, errors: expect.any(Array) },
      });
      expect(JSON.stringify(requests[1])).not.toContain("===USER_PROFILE_V1_BEGIN===");
      expect(operationIdCalls).toBe(1);
      expect(await fileStore.loadCurrentPersona()).toMatchObject({
        generation: 1,
        manifest: {
          operation_id: "persona-resume-operation",
          op: "rebuild",
          generation: 1,
          source_diary_date: frozenDate,
          last_folded_date_after: frozenDate,
          folds_since_rebase_after: 0,
          consumed_pending_dates: [],
          partial_missing_dates_after: [],
        },
        userProfile,
        experience,
      });
      expect(stateStore.getPersonaCursor()).toEqual({
        lastFoldedDate: frozenDate,
        lastAppliedOperationId: "persona-resume-operation",
        foldsSinceRebase: 0,
        rebuildRequested: false,
      });
      expect(stateStore.getPersonaOperation()).toBeNull();
    } finally {
      db.close();
    }
  });

  test("terminalizes one frozen operation after three due failures and blocks later work", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-persona-terminal-"));
    roots.push(dataRoot);
    const stateStore = createDiaryStateStore(db);
    const fileStore = new DiaryFileStore(dataRoot);
    const date = "2026-07-10";
    const watermark = "watermark-persona-terminal";
    const indexHook = "persona terminal tracer";
    const diaryBytes = compileDiaryDocument({
      date,
      sessions: ["S1"],
      projects: ["/projects/mnemo"],
      watermark,
      indexHook,
      body: [
        "## 工作",
        "- 验证 persona terminal 状态 [S1/T1]",
        "## 人物",
        "- 用户要求失败停止热循环 [S1/T1]",
        "## 反思",
        "- 三次失败后阻止新操作 [S1/T1]",

        "- 无",
      ].join("\n"),
    });
    stateStore.initializeBootstrap("2026-07-11");
    stateStore.enqueueDay({ date, enqueuedAtEpoch: 100 });
    const claimed = stateStore.claimNextDiaryItem(200)!;
    await fileStore.commitDiary(date, diaryBytes);
    stateStore.settleDay({
      date,
      queueSeq: claimed.seq,
      watermark,
      fileSha256: createHash("sha256").update(diaryBytes).digest("hex"),
      indexHook,
      settledAtEpoch: 300,
    });

    let nowEpoch = 1_000;
    let agentCalls = 0;
    let operationIdCalls = 0;
    const maintainer = createPersonaMaintainer({
      stateStore,
      fileStore,
      nowEpoch: () => nowEpoch,
      operationId: () => {
        operationIdCalls += 1;
        return "persona-terminal-operation";
      },
      async runPersona() {
        agentCalls += 1;
        throw new Error(`persona failure ${agentCalls}`);
      },
    });

    try {
      for (const dueEpoch of [1_000, 1_060, 1_120]) {
        nowEpoch = dueEpoch;
        await expect(maintainer.runPersonaMaintenance()).rejects.toThrow(
          `persona failure ${agentCalls + 1}`,
        );
      }

      expect(stateStore.getPersonaOperation()).toMatchObject({
        operationId: "persona-terminal-operation",
        op: "rebuild",
        inputDatesSnapshot: [date],
        attemptCount: 3,
        nextAttemptEpoch: null,
        lastError: "persona failure 3",
        terminal: true,
      });

      nowEpoch = 9_999;
      expect(await maintainer.runPersonaMaintenance()).toBe("blocked");
      expect(agentCalls).toBe(3);
      expect(operationIdCalls).toBe(1);
      expect(stateStore.getPersonaOperation()?.operationId).toBe(
        "persona-terminal-operation",
      );
      await expect(fileStore.loadCurrentPersona()).rejects.toThrow();
    } finally {
      db.close();
    }
  });

  test("supersedes a stale terminal tombstone when new diary days await a rebase", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-persona-supersede-"));
    roots.push(dataRoot);
    const stateStore = createDiaryStateStore(db);
    const fileStore = new DiaryFileStore(dataRoot);
    stateStore.initializeBootstrap("2026-07-11");

    const settlePendingDiary = async (date: string, promptNumber: number) => {
      const watermark = `watermark-${date}`;
      const indexHook = `supersede ${date}`;
      const bytes = compileDiaryDocument({
        date,
        sessions: ["S1"],
        projects: ["/projects/mnemo"],
        watermark,
        indexHook,
        body: [
          "## 工作",
          `- 回填历史日记 ${date} [S1/T${promptNumber}]`,
          "## 人物",
          `- 记录 ${date} 人物信号 [S1/T${promptNumber}]`,
          "## 反思",
          `- 陈旧墓碑不应永久阻塞 [S1/T${promptNumber}]`,

          "- 无",
        ].join("\n"),
      });
      const fileSha256 = createHash("sha256").update(bytes).digest("hex");
      stateStore.enqueueDay({ date, enqueuedAtEpoch: 100 + promptNumber });
      const claimed = stateStore.claimNextDiaryItem(200 + promptNumber)!;
      await fileStore.commitDiary(date, bytes);
      stateStore.settleDay({
        date,
        queueSeq: claimed.seq,
        watermark,
        fileSha256,
        indexHook,
        settledAtEpoch: 300 + promptNumber,
      });
      stateStore.commitDayState({
        date,
        watermark,
        fileSha256,
        indexHook,
        settledAtEpoch: 400 + promptNumber,
        pendingRebase: true,
      });
      return new TextDecoder().decode(bytes);
    };

    // The older day was already folded into the baseline; the newer day is a
    // backfilled diary awaiting a rebase — the world the tombstone never saw.
    const olderDiary = await settlePendingDiary("2026-07-09", 1);
    const newerDiary = await settlePendingDiary("2026-07-10", 2);

    const baseUserProfile =
      "## 身份与背景\n## 专长与判断力\n## 品味与兴趣\n## 沟通风格\n## 协作偏好\n- 用户重视可追溯的历史 [S1/T1]\n";
    const baseExperience =
      "## 项目\n## 通用\n- 我记得旧日记的基线印象 [S1/T1]\n";
    await fileStore.commitPersonaGeneration({
      generation: 1,
      manifest: {
        operation_id: "baseline-op",
        op: "rebuild",
        generation: 1,
        source_diary_date: "2026-07-09",
        last_folded_date_after: "2026-07-09",
        folds_since_rebase_after: 0,
        consumed_pending_dates: [],
        partial_missing_dates_after: [],
      },
      userProfile: baseUserProfile,
      experience: baseExperience,
    });
    stateStore.commitPersonaCursor({
      lastFoldedDate: "2026-07-09",
      lastAppliedOperationId: "baseline-op",
      foldsSinceRebase: 0,
      rebuildRequested: false,
    });

    // Fabricate the deadlocking tombstone: a rebase that only ever attempted the
    // older day and died on the pre-0.3.1 executable-path crash.
    stateStore.beginPersonaOperation({
      operationId: "stale-tombstone",
      op: "rebase",
      baseGeneration: 1,
      targetGeneration: 2,
      inputDatesSnapshot: ["2026-07-09"],
    });
    stateStore.terminalPersonaOperation(
      "stale-tombstone",
      'The "url" argument must be of type string. Received undefined',
    );
    expect(stateStore.getPersonaOperation()).toMatchObject({
      operationId: "stale-tombstone",
      terminal: true,
    });

    const rebasedUserProfile =
      "## 身份与背景\n## 专长与判断力\n## 品味与兴趣\n## 沟通风格\n## 协作偏好\n- 用户重视经修正且可追溯的事实 [S1/T1]\n";
    const rebasedExperience =
      "## 项目\n## 通用\n- 我已吸收回填的历史日记 [S1/T2]\n";
    const requests: PersonaRunRequest[] = [];
    let agentCalls = 0;
    const maintainer = createPersonaMaintainer({
      stateStore,
      fileStore,
      operationId: () => "persona-fresh",
      async runPersona(request) {
        agentCalls += 1;
        requests.push(request);
        return [
          "===USER_PROFILE_V1_BEGIN===",
          rebasedUserProfile,
          "===USER_PROFILE_V1_END===",
          "===EXPERIENCE_V1_BEGIN===",
          rebasedExperience,
          "===EXPERIENCE_V1_END===",
        ].join("\n");
      },
    });

    try {
      // Old behaviour returned "blocked" without ever calling the agent.
      expect(await maintainer.runPersonaMaintenance()).toBe("completed");
      expect(agentCalls).toBe(1);
      expect(requests[0]).toMatchObject({ op: "rebase" });
      expect(
        (requests[0] as { diaries: Array<{ date: string; content: string }> })
          .diaries.map((diary) => diary.date),
      ).toEqual(["2026-07-09", "2026-07-10"]);
      expect(
        (requests[0] as { diaries: Array<{ date: string; content: string }> })
          .diaries.map((diary) => diary.content),
      ).toEqual([olderDiary, newerDiary]);
      // The tombstone is gone; a fresh generation folded the backfilled day.
      expect(stateStore.getPersonaOperation()).toBeNull();
      expect(await fileStore.loadCurrentPersona()).toMatchObject({
        generation: 2,
        manifest: { operation_id: "persona-fresh", op: "rebase" },
        userProfile: rebasedUserProfile,
        experience: rebasedExperience,
      });
    } finally {
      db.close();
    }
  });

  test("keeps a terminal tombstone blocked when no new work has appeared", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-persona-still-blocked-"));
    roots.push(dataRoot);
    const stateStore = createDiaryStateStore(db);
    const fileStore = new DiaryFileStore(dataRoot);
    stateStore.initializeBootstrap("2026-07-11");

    stateStore.beginPersonaOperation({
      operationId: "stuck-tombstone",
      op: "rebuild",
      inputDatesSnapshot: ["2026-07-10"],
    });
    stateStore.terminalPersonaOperation("stuck-tombstone", "persona failure 3");

    let agentCalls = 0;
    const maintainer = createPersonaMaintainer({
      stateStore,
      fileStore,
      async runPersona() {
        agentCalls += 1;
        throw new Error("agent must not run for a still-blocked tombstone");
      },
    });

    try {
      expect(await maintainer.runPersonaMaintenance()).toBe("blocked");
      expect(agentCalls).toBe(0);
      expect(stateStore.getPersonaOperation()?.operationId).toBe(
        "stuck-tombstone",
      );
    } finally {
      db.close();
    }
  });

  test("immediately resumes a persisted pre-call operation after a crash", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-persona-crash-"));
    roots.push(dataRoot);
    const stateStore = createDiaryStateStore(db);
    const fileStore = new DiaryFileStore(dataRoot);
    stateStore.initializeBootstrap("2026-07-11");

    const settleDiary = async (date: string, promptNumber: number) => {
      const watermark = `watermark-crash-${date}`;
      const indexHook = `crash resume ${date}`;
      const bytes = compileDiaryDocument({
        date,
        sessions: ["S1"],
        projects: ["/projects/mnemo"],
        watermark,
        indexHook,
        body: [
          "## 工作",
          `- 恢复 ${date} persona operation [S1/T${promptNumber}]`,
          "## 人物",
          `- 冻结 ${date} 输入 [S1/T${promptNumber}]`,
          "## 反思",
          `- 调用前崩溃后立即续跑 [S1/T${promptNumber}]`,

          "- 无",
        ].join("\n"),
      });
      stateStore.enqueueDay({ date, enqueuedAtEpoch: 100 + promptNumber });
      const claimed = stateStore.claimNextDiaryItem(200 + promptNumber)!;
      await fileStore.commitDiary(date, bytes);
      stateStore.settleDay({
        date,
        queueSeq: claimed.seq,
        watermark,
        fileSha256: createHash("sha256").update(bytes).digest("hex"),
        indexHook,
        settledAtEpoch: 300 + promptNumber,
      });
      return new TextDecoder().decode(bytes);
    };

    const frozenDate = "2026-07-09";
    const frozenDiary = await settleDiary(frozenDate, 1);
    stateStore.beginPersonaOperation({
      operationId: "persona-crash-operation",
      op: "rebuild",
      inputDatesSnapshot: [frozenDate],
    });
    await settleDiary("2026-07-10", 2);

    const userProfile =
      "## 身份与背景\n## 专长与判断力\n## 品味与兴趣\n## 沟通风格\n## 协作偏好\n- 用户要求崩溃恢复保持确定性 [S1/T1]\n";
    const experience =
      "## 项目\n## 通用\n- 我应立即恢复未调用的 operation [S1/T1]\n";
    const requests: unknown[] = [];
    const maintainer = createPersonaMaintainer({
      stateStore,
      fileStore,
      operationId: () => {
        throw new Error("must reuse persisted operation id");
      },
      async runPersona(request) {
        requests.push(request);
        return [
          "===USER_PROFILE_V1_BEGIN===",
          userProfile,
          "===USER_PROFILE_V1_END===",
          "===EXPERIENCE_V1_BEGIN===",
          experience,
          "===EXPERIENCE_V1_END===",
        ].join("\n");
      },
    });

    try {
      expect(stateStore.getPersonaOperation()).toMatchObject({
        operationId: "persona-crash-operation",
        attemptCount: 0,
        nextAttemptEpoch: null,
        terminal: false,
      });
      expect(await maintainer.runPersonaMaintenance()).toBe("completed");
      expect(requests).toEqual([
        {
          op: "rebuild",
          diaries: [{ date: frozenDate, content: frozenDiary }],
        },
      ]);
      expect(await fileStore.loadCurrentPersona()).toMatchObject({
        generation: 1,
        manifest: {
          operation_id: "persona-crash-operation",
          op: "rebuild",
          source_diary_date: frozenDate,
          last_folded_date_after: frozenDate,
        },
        userProfile,
        experience,
      });
      expect(stateStore.getPersonaOperation()).toBeNull();
    } finally {
      db.close();
    }
  });

  test("recovers a published target generation without calling the persona agent again", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = mkdtempSync(
      join(tmpdir(), "claude-mnemo-persona-published-recovery-"),
    );
    roots.push(dataRoot);
    const stateStore = createDiaryStateStore(db);
    const fileStore = new DiaryFileStore(dataRoot);
    stateStore.initializeBootstrap("2026-07-11");

    const date = "2026-07-09";
    const watermark = "published-recovery-watermark";
    const indexHook = "published recovery diary";
    const diaryBytes = compileDiaryDocument({
      date,
      sessions: ["S1"],
      projects: ["/projects/mnemo"],
      watermark,
      indexHook,
      body: [
        "## 工作",
        "- 恢复已发布的 persona operation [S1/T1]",
        "## 人物",
        "- 用户要求断电恢复不重调模型 [S1/T1]",
        "## 反思",
        "- 以 CURRENT manifest 为恢复事实 [S1/T1]",

        "- 无",
      ].join("\n"),
    });
    stateStore.enqueueDay({ date, enqueuedAtEpoch: 100 });
    const claimed = stateStore.claimNextDiaryItem(200)!;
    await fileStore.commitDiary(date, diaryBytes);
    stateStore.settleDay({
      date,
      queueSeq: claimed.seq,
      watermark,
      fileSha256: createHash("sha256").update(diaryBytes).digest("hex"),
      indexHook,
      settledAtEpoch: 300,
    });
    stateStore.commitDayState({
      date,
      watermark,
      fileSha256: createHash("sha256").update(diaryBytes).digest("hex"),
      indexHook,
      settledAtEpoch: 300,
      pendingRebase: true,
    });
    stateStore.commitPersonaCursor({
      lastFoldedDate: "2026-07-10",
      lastAppliedOperationId: "persona-operation-1",
      foldsSinceRebase: 2,
      rebuildRequested: true,
    });
    stateStore.beginPersonaOperation({
      operationId: "persona-operation-2",
      op: "rebase",
      baseGeneration: 1,
      targetGeneration: 2,
      inputDatesSnapshot: ["2026-07-09"],
      consumedPendingDays: [{ date, watermark, fileSha256: createHash("sha256").update(diaryBytes).digest("hex") }],
    });
    await fileStore.commitPersonaGeneration({
      generation: 2,
      manifest: {
        operation_id: "persona-operation-2",
        op: "rebase",
        generation: 2,
        source_diary_date: "2026-07-09",
        last_folded_date_after: "2026-07-10",
        folds_since_rebase_after: 0,
        consumed_pending_dates: ["2026-07-09"],
        partial_missing_dates_after: [],
      },
      userProfile:
        "## 身份与背景\n## 专长与判断力\n## 品味与兴趣\n## 沟通风格\n## 协作偏好\n- 用户要求发布后恢复不得重复调用模型 [S1/T1]\n",
      experience:
        "## 项目\n## 通用\n- 我应按 CURRENT 绝对恢复 SQLite 状态 [S1/T1]\n",
    });
    rmSync(join(dataRoot, "persona", "CURRENT"));

    let agentCalls = 0;
    const maintainer = createPersonaMaintainer({
      stateStore,
      fileStore,
      async runPersona() {
        agentCalls += 1;
        throw new Error("published operation must not call persona agent again");
      },
    });

    try {
      expect(await maintainer.runPersonaMaintenance()).toBe("completed");
      expect(agentCalls).toBe(0);
      expect(stateStore.getPersonaCursor()).toEqual({
        lastFoldedDate: "2026-07-10",
        lastAppliedOperationId: "persona-operation-2",
        foldsSinceRebase: 0,
        rebuildRequested: false,
      });
      expect(stateStore.getDayState("2026-07-09")?.pendingRebase).toBe(false);
      expect(stateStore.getPersonaOperation()).toBeNull();
      expect((await fileStore.loadCurrentPersona()).generation).toBe(2);
    } finally {
      db.close();
    }
  });

  test("rebuilds without the old persona while advancing the existing generation", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = mkdtempSync(
      join(tmpdir(), "claude-mnemo-persona-rebuild-generation-"),
    );
    roots.push(dataRoot);
    const stateStore = createDiaryStateStore(db);
    const fileStore = new DiaryFileStore(dataRoot);
    stateStore.initializeBootstrap("2026-07-11");

    const date = "2026-07-10";
    const watermark = "rebuild-generation-watermark";
    const indexHook = "rebuild generation diary";
    const diaryBytes = compileDiaryDocument({
      date,
      sessions: ["S1"],
      projects: ["/projects/mnemo"],
      watermark,
      indexHook,
      body: [
        "## 工作",
        "- 从日记重建 persona [S1/T1]",
        "## 人物",
        "- 用户要求 rebuild 排除旧 persona [S1/T1]",
        "## 反思",
        "- 新发布应延续 generation 序号 [S1/T1]",

        "- 无",
      ].join("\n"),
    });
    stateStore.enqueueDay({ date, enqueuedAtEpoch: 100 });
    const claimed = stateStore.claimNextDiaryItem(200)!;
    await fileStore.commitDiary(date, diaryBytes);
    stateStore.settleDay({
      date,
      queueSeq: claimed.seq,
      watermark,
      fileSha256: createHash("sha256").update(diaryBytes).digest("hex"),
      indexHook,
      settledAtEpoch: 300,
    });
    stateStore.commitPersonaCursor({
      lastFoldedDate: date,
      lastAppliedOperationId: "persona-operation-2",
      foldsSinceRebase: 4,
      rebuildRequested: true,
    });
    await fileStore.commitPersonaGeneration({
      generation: 2,
      manifest: {
        operation_id: "persona-operation-2",
        op: "fold",
        generation: 2,
        source_diary_date: date,
        last_folded_date_after: date,
        folds_since_rebase_after: 4,
        consumed_pending_dates: [],
        partial_missing_dates_after: [],
      },
      userProfile: "## 身份与背景\n## 专长与判断力\n## 品味与兴趣\n## 沟通风格\n## 协作偏好\n- 这是必须排除的旧 persona [S1/T1]\n",
      experience: "## 项目\n## 通用\n- 这是必须排除的旧 experience [S1/T1]\n",
    });

    const rebuiltUserProfile =
      "## 身份与背景\n## 专长与判断力\n## 品味与兴趣\n## 沟通风格\n## 协作偏好\n- 用户要求 rebuild 只基于日记 [S1/T1]\n";
    const rebuiltExperience =
      "## 项目\n## 通用\n- 我应让 generation 单调递增 [S1/T1]\n";
    const requests: unknown[] = [];
    const maintainer = createPersonaMaintainer({
      stateStore,
      fileStore,
      operationId: () => "persona-operation-3",
      async runPersona(request) {
        requests.push(request);
        return [
          "===USER_PROFILE_V1_BEGIN===",
          rebuiltUserProfile,
          "===USER_PROFILE_V1_END===",
          "===EXPERIENCE_V1_BEGIN===",
          rebuiltExperience,
          "===EXPERIENCE_V1_END===",
        ].join("\n");
      },
    });

    try {
      expect(await maintainer.runPersonaMaintenance()).toBe("completed");
      expect(requests).toEqual([
        {
          op: "rebuild",
          diaries: [
            { date, content: new TextDecoder().decode(diaryBytes) },
          ],
        },
      ]);
      expect(await fileStore.loadCurrentPersona()).toMatchObject({
        generation: 3,
        manifest: {
          operation_id: "persona-operation-3",
          op: "rebuild",
          generation: 3,
          source_diary_date: date,
          last_folded_date_after: date,
          folds_since_rebase_after: 0,
          consumed_pending_dates: [],
          partial_missing_dates_after: [],
        },
        userProfile: rebuiltUserProfile,
        experience: rebuiltExperience,
      });
    } finally {
      db.close();
    }
  });

  test("rebuilds three bounded batches and publishes CURRENT only after the final batch", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-persona-batches-"));
    roots.push(dataRoot);
    const stateStore = createDiaryStateStore(db);
    const fileStore = new DiaryFileStore(dataRoot);
    stateStore.initializeBootstrap("2026-07-11");

    const dates = ["2026-07-08", "2026-07-09", "2026-07-10"];
    for (const [index, date] of dates.entries()) {
      const watermark = `batch-watermark-${date}`;
      const indexHook = `batch diary ${date}`;
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
          `- 用户要求有界归约 [S1/T${index + 1}]`,
          "## 反思",
          `- 每批落 checkpoint [S1/T${index + 1}]`,

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
    const requests: Array<{
      request: Parameters<Parameters<typeof createPersonaMaintainer>[0]["runPersona"]>[0];
      currentWasPublished: boolean;
    }> = [];
    const requestGateTokens = 800;
    const requestOverheadTokens = 100;
    const maintainer = createPersonaMaintainer({
      stateStore,
      fileStore,
      operationId: () => "persona-three-batch-operation",
      requestGateTokens,
      accumulatorReserveTokens: 0,
      requestOverheadTokens,
      async runPersona(request) {
        let currentWasPublished = true;
        try {
          await fileStore.loadCurrentPersona();
        } catch {
          currentWasPublished = false;
        }
        requests.push({ request, currentWasPublished });
        const sourceDate = request.diaries.at(-1)!.date;
        return [
          "===USER_PROFILE_V1_BEGIN===",
          `## 身份与背景\n## 专长与判断力\n## 品味与兴趣\n## 沟通风格\n## 协作偏好\n- 已归约到 ${sourceDate} [S1/T1]`,
          "===USER_PROFILE_V1_END===",
          "===EXPERIENCE_V1_BEGIN===",
          `## 项目\n## 通用\n- 已 checkpoint ${sourceDate} [S1/T1]`,
          "===EXPERIENCE_V1_END===",
        ].join("\n");
      },
    });

    try {
      expect(await maintainer.runPersonaMaintenance()).toBe("completed");
      expect(requests).toHaveLength(3);
      expect(requests.map(({ request }) => request.diaries.map((diary) => diary.date))).toEqual(
        dates.map((date) => [date]),
      );
      expect(requests.map(({ currentWasPublished }) => currentWasPublished)).toEqual([
        false,
        false,
        false,
      ]);
      for (const { request } of requests) {
        expect(requestOverheadTokens + estimateDiaryTokens(JSON.stringify(request))).toBeLessThanOrEqual(
          requestGateTokens,
        );
      }
      expect("accumulator" in requests[0]!.request).toBe(false);
      expect("accumulator" in requests[1]!.request).toBe(true);
      expect("accumulator" in requests[2]!.request).toBe(true);
      expect(await fileStore.loadCurrentPersona()).toMatchObject({
        generation: 1,
        manifest: {
          operation_id: "persona-three-batch-operation",
          op: "rebuild",
          source_diary_date: "2026-07-10",
        },
      });
      expect(stateStore.getPersonaOperation()).toBeNull();
    } finally {
      db.close();
    }
  });

  test("resumes after the first checkpoint from immutable inputs without rerunning that batch", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-persona-snapshot-"));
    roots.push(dataRoot);
    const stateStore = createDiaryStateStore(db);
    const fileStore = new DiaryFileStore(dataRoot);
    stateStore.initializeBootstrap("2026-07-11");

    const dates = ["2026-07-08", "2026-07-09", "2026-07-10"];
    const originalByDate = new Map<string, string>();
    for (const [index, date] of dates.entries()) {
      const watermark = `snapshot-watermark-${date}`;
      const indexHook = `snapshot diary ${date}`;
      const bytes = compileDiaryDocument({
        date,
        sessions: ["S1"],
        projects: ["/projects/mnemo"],
        watermark,
        indexHook,
        body: [
          "## 工作",
          `- ${"不可变素材".repeat(45)} [S1/T${index + 1}]`,
          "## 人物",
          `- 用户要求崩溃续跑 [S1/T${index + 1}]`,
          "## 反思",
          `- 不得重读变化源 [S1/T${index + 1}]`,

          "- 无",
        ].join("\n"),
      });
      originalByDate.set(date, new TextDecoder().decode(bytes));
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

    const initiallyPending = stateStore.getDayState(dates[0]!)!;
    stateStore.commitDayState({
      date: initiallyPending.date,
      watermark: initiallyPending.watermark!,
      fileSha256: initiallyPending.fileSha256!,
      indexHook: initiallyPending.indexHook!,
      validationReportJson: initiallyPending.validationReportJson!,
      settledAtEpoch: initiallyPending.settledAtEpoch!,
      pendingRebase: true,
    });
    await fileStore.commitPersonaGeneration({
      generation: 1,
      manifest: {
        operation_id: "persona-before-snapshot",
        op: "fold",
        generation: 1,
        source_diary_date: dates[2],
        last_folded_date_after: dates[2],
        folds_since_rebase_after: 1,
        consumed_pending_dates: [],
        partial_missing_dates_after: [],
      },
      userProfile: validUserProfile,
      experience: validExperience,
    });
    stateStore.commitPersonaCursor({
      lastFoldedDate: dates[2]!,
      lastAppliedOperationId: "persona-before-snapshot",
      foldsSinceRebase: 1,
      rebuildRequested: false,
    });

    let nowEpoch = 1_000;
    const firstRunDates: string[] = [];
    const firstMaintainer = createPersonaMaintainer({
      stateStore,
      fileStore,
      operationId: () => "persona-snapshot-operation",
      nowEpoch: () => nowEpoch,
      requestGateTokens: 800,
      accumulatorReserveTokens: 0,
      requestOverheadTokens: 100,
      async runPersona(request) {
        const date = request.diaries[0]!.date;
        firstRunDates.push(date);
        if (date === dates[1]) {
          throw new Error("simulated crash before batch two result");
        }
        return [
          "===USER_PROFILE_V1_BEGIN===",
          `## 身份与背景\n## 专长与判断力\n## 品味与兴趣\n## 沟通风格\n## 协作偏好\n- checkpoint ${date} [S1/T1]`,
          "===USER_PROFILE_V1_END===",
          "===EXPERIENCE_V1_BEGIN===",
          `## 项目\n## 通用\n- checkpoint ${date} [S1/T1]`,
          "===EXPERIENCE_V1_END===",
        ].join("\n");
      },
    });

    try {
      await expect(firstMaintainer.runPersonaMaintenance()).rejects.toThrow(
        "simulated crash before batch two result",
      );
      expect(firstRunDates).toEqual([dates[0], dates[1]]);
      expect(stateStore.getPersonaOperation()).toMatchObject({
        operationId: "persona-snapshot-operation",
        op: "rebase",
        consumedPendingDates: [dates[0]],
        nextBatchIndex: 1,
        accumulatorGeneration: 1,
        attemptCount: 1,
        terminal: false,
      });

      const newlyPending = stateStore.getDayState(dates[2]!)!;
      stateStore.commitDayState({
        date: newlyPending.date,
        watermark: newlyPending.watermark!,
        fileSha256: newlyPending.fileSha256!,
        indexHook: newlyPending.indexHook!,
        validationReportJson: newlyPending.validationReportJson!,
        settledAtEpoch: newlyPending.settledAtEpoch!,
        pendingRebase: true,
      });

      // A fresh rebuild request and a new version of the already-consumed day
      // both land after batch one. Publication may confirm/clear only snapshots.
      const regenerated = stateStore.getDayState(dates[0]!)!;
      stateStore.commitDayState({
        date: regenerated.date,
        watermark: `${regenerated.watermark}-v2`,
        fileSha256: `${regenerated.fileSha256}-v2`,
        indexHook: regenerated.indexHook!,
        validationReportJson: regenerated.validationReportJson!,
        settledAtEpoch: regenerated.settledAtEpoch! + 1,
        pendingRebase: true,
      });
      stateStore.commitDayTombstone({ date: dates[2]!, requestRebuild: true });

      await fileStore.commitDiary(
        dates[1]!,
        new TextEncoder().encode("source diary changed after operation start"),
      );

      nowEpoch = 1_061;
      const resumedRequests: PersonaRunRequest[] = [];
      const resumedMaintainer = createPersonaMaintainer({
        stateStore,
        fileStore,
        nowEpoch: () => nowEpoch,
        operationId: () => {
          throw new Error("resume must keep operation id");
        },
        requestGateTokens: 800,
        accumulatorReserveTokens: 0,
        requestOverheadTokens: 100,
        async runPersona(request) {
          resumedRequests.push(request);
          const date = request.diaries[0]!.date;
          return [
            "===USER_PROFILE_V1_BEGIN===",
            `## 身份与背景\n## 专长与判断力\n## 品味与兴趣\n## 沟通风格\n## 协作偏好\n- resumed ${date} [S1/T1]`,
            "===USER_PROFILE_V1_END===",
            "===EXPERIENCE_V1_BEGIN===",
            `## 项目\n## 通用\n- resumed ${date} [S1/T1]`,
            "===EXPERIENCE_V1_END===",
          ].join("\n");
        },
      });

      expect(await resumedMaintainer.runPersonaMaintenance()).toBe("completed");
      expect(resumedRequests.map((request) => request.diaries[0]!.date)).toEqual([
        dates[1],
        dates[2],
      ]);
      expect(resumedRequests[0]!.diaries[0]!.content).toBe(
        originalByDate.get(dates[1]!),
      );
      expect(firstRunDates.filter((date) => date === dates[0])).toHaveLength(1);
      expect(stateStore.getDayState(dates[0]!)?.pendingRebase).toBe(true);
      expect(stateStore.getDayState(dates[2]!)?.pendingRebase).toBe(false);
      expect(stateStore.getPersonaCursor().rebuildRequested).toBe(true);
      expect(stateStore.getPersonaOperation()).toBeNull();
    } finally {
      db.close();
    }
  });

  test("terminalizes a tampered checkpoint before making another persona request", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-persona-tamper-"));
    roots.push(dataRoot);
    const stateStore = createDiaryStateStore(db);
    const fileStore = new DiaryFileStore(dataRoot);
    stateStore.initializeBootstrap("2026-07-11");

    for (const [index, date] of ["2026-07-09", "2026-07-10"].entries()) {
      const watermark = `tamper-watermark-${date}`;
      const indexHook = `tamper diary ${date}`;
      const bytes = compileDiaryDocument({
        date,
        sessions: ["S1"],
        projects: ["/projects/mnemo"],
        watermark,
        indexHook,
        body: [
          "## 工作",
          `- ${"校验素材".repeat(55)} [S1/T${index + 1}]`,
          "## 人物",
          `- 用户要求拒绝坏 checkpoint [S1/T${index + 1}]`,
          "## 反思",
          `- hash 失配不得调用 agent [S1/T${index + 1}]`,

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

    let calls = 0;
    const firstMaintainer = createPersonaMaintainer({
      stateStore,
      fileStore,
      operationId: () => "persona-tampered-checkpoint",
      nowEpoch: () => 1_000,
      requestGateTokens: 800,
      accumulatorReserveTokens: 0,
      requestOverheadTokens: 100,
      async runPersona(request) {
        calls += 1;
        const date = request.diaries[0]!.date;
        if (calls === 2) {
          throw new Error("pause after checkpoint");
        }
        return [
          "===USER_PROFILE_V1_BEGIN===",
          `## 身份与背景\n## 专长与判断力\n## 品味与兴趣\n## 沟通风格\n## 协作偏好\n- checkpoint ${date} [S1/T1]`,
          "===USER_PROFILE_V1_END===",
          "===EXPERIENCE_V1_BEGIN===",
          `## 项目\n## 通用\n- checkpoint ${date} [S1/T1]`,
          "===EXPERIENCE_V1_END===",
        ].join("\n");
      },
    });

    try {
      await expect(firstMaintainer.runPersonaMaintenance()).rejects.toThrow(
        "pause after checkpoint",
      );
      const checkpoint = stateStore.getPersonaOperation()!;
      expect(checkpoint.nextBatchIndex).toBe(1);
      writeFileSync(checkpoint.checkpointPath!, "tampered checkpoint\n");

      let resumedAgentCalls = 0;
      const resumedMaintainer = createPersonaMaintainer({
        stateStore,
        fileStore,
        nowEpoch: () => 1_001,
        requestGateTokens: 800,
        accumulatorReserveTokens: 0,
        requestOverheadTokens: 100,
        async runPersona() {
          resumedAgentCalls += 1;
          throw new Error("must not run");
        },
      });
      expect(await resumedMaintainer.runPersonaMaintenance()).toBe("blocked");
      expect(resumedAgentCalls).toBe(0);
      expect(stateStore.getPersonaOperation()).toMatchObject({
        operationId: "persona-tampered-checkpoint",
        terminal: true,
        nextAttemptEpoch: null,
        lastError: "Persona checkpoint hash mismatch",
      });
      await expect(fileStore.loadCurrentPersona()).rejects.toThrow();
    } finally {
      db.close();
    }
  });
});
