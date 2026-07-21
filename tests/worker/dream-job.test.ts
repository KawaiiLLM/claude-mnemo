import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createDatabase } from "../../src/db/database";
import { createRuleStore } from "../../src/db/rules";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { DreamMemoryStore } from "../../src/diary/memory-store";
import {
  resolveHitSidecarPath,
  resolveTriggerIndexPath,
} from "../../src/rules/pretooluse-dispatcher";
import {
  DEFAULT_DREAM_AGENT_MODEL,
} from "../../src/shared/config";
import {
  buildDreamPrompt,
  createDreamJobProcessor,
  DREAM_CURATE_PROMPT,
} from "../../src/worker/dream-job";
import type {
  DiaryAgentRunInput,
  DiaryAgentRunner,
} from "../../src/worker/diary-agent-runner";
import { dreamStagingPaths } from "../../src/worker/dream-staging";
import type { CommitNightInput } from "../../src/diary/memory-store";
import { saveTurnFixture } from "../support/turn-fixtures";

const roots: string[] = [];

/**
 * Mirrors what the real agent's Write/Edit tools do: lay the curated documents
 * into the run's staging workspace so the payload-free commit reads them back.
 */
function writeStaging(dataRoot: string, night: CommitNightInput): void {
  const paths = dreamStagingPaths(dataRoot, night.date);
  writeFileSync(paths.userProfile, night.userProfile);
  writeFileSync(paths.archive, night.archive);
  writeFileSync(paths.diary, night.diary);
  writeFileSync(paths.diaryIndex, night.diaryIndex);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), label));
  roots.push(root);
  return root;
}

function seedMaterial(db: ReturnType<typeof createDatabase>, date: string): number {
  const session = upsertSession(db, {
    contentSessionId: `dream-${date}`,
    project: "/projects/dream",
    title: "Dream agent",
    content: null,
    insight: null,
    createdAtEpoch: 1,
    updatedAtEpoch: null,
    completedAtEpoch: null,
  });
  saveTurnFixture(db, {
    sessionId: session.id,
    promptNumber: 1,
    userPrompt: "Remember the outcome and who I am, not implementation trivia.",
    assistantResponse: "We finished a memorable milestone together.",
    title: null,
    insight: null,
    filesRead: [],
    filesModified: [],
    createdAtEpoch: Date.parse(`${date}T04:00:00+08:00`) / 1_000,
    updatedAtEpoch: null,
    observations: [],
  });
  return session.id;
}

async function seedCurrentMemory(store: DreamMemoryStore): Promise<void> {
  await store.commitNight({
    date: "2026-07-09",
    userProfile: "# User Profile\n\n- values careful memory [S1/T1]\n",
    archive: "# Memory Archive\n\n- dormant original [S1/T1]\n",
    diary: "# 2026-07-09\n\n- prior day\n",
    diaryIndex: "# Diary Index\n\n- 2026-07-09：prior day\n",
  });
}

describe("dream job processor", () => {
  test("prompt orders induction and review tools and states the usefulness contract", () => {
    const dataRoot = tempRoot("claude-mnemo-dream-prompt-");
    const prompt = buildDreamPrompt(
      "2026-07-10",
      dataRoot,
      dreamStagingPaths(dataRoot, "2026-07-10"),
      [],
    );

    const induction = prompt.indexOf("## 规则归纳（Induction）");
    const propose = prompt.indexOf("propose_rule", induction);
    const review = prompt.indexOf("## 规则评审（Review）");
    const list = prompt.indexOf("list_rule_hits", review);
    const detail = prompt.indexOf("read_turn_detail", list);
    const judgment = prompt.indexOf("submit_judgment", detail);

    expect(induction).toBeGreaterThanOrEqual(0);
    expect(propose).toBeGreaterThan(induction);
    expect(review).toBeGreaterThan(propose);
    expect(list).toBeGreaterThan(review);
    expect(detail).toBeGreaterThan(list);
    expect(judgment).toBeGreaterThan(detail);
    expect(prompt).toContain("判重只由 propose_rule 工具内部强制执行");
    expect(prompt).toContain("遵从（compliance）不等于有用（usefulness）");
    expect(prompt).toContain("只有规则对结果产生了正面作用才算有用");
    expect(prompt).toContain("label 是开放词汇");
    expect(prompt).toContain("rationale 必填");
    expect(prompt).toContain("adjustment 可选");
    expect(prompt).not.toContain("experience.md");
  });

  test("one agent pass commits the diary, index, curated memory, and archive together", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = tempRoot("claude-mnemo-dream-job-");
    const store = new DreamMemoryStore(dataRoot);
    await seedCurrentMemory(store);
    const sessionId = seedMaterial(db, "2026-07-10");
    const calls: DiaryAgentRunInput[] = [];
    const agentRunner: DiaryAgentRunner = {
      async run(input) {
        calls.push(input);
        expect(input.prompt).toContain(DREAM_CURATE_PROMPT);
        expect(input.prompt).toContain(`"ref":"S${sessionId}/T1"`);
        expect(input.prompt).toContain(`${dataRoot}/memory/archive.md`);
        expect(input.prompt).toContain(`${dataRoot}/diary`);
        expect(input.prompt).toContain(
          `${dataRoot}/.dream-staging/2026-07-10/memory/user-profile.md`,
        );
        expect(input.toolHandlers.commit).toBeDefined();
        writeStaging(dataRoot, {
          date: "2026-07-10",
          userProfile: "# User Profile\n\n- values memorable outcomes [S1/T1]\n",
          archive: "# Memory Archive\n\n- dormant original [S1/T1]\n- demoted detail [S1/T1]\n",
          diary: `# 2026-07-10\n\n- engineering detail stays here [S${sessionId}/T1]\n`,
          diaryIndex: "# Diary Index\n\n- 2026-07-10：completed the arc\n- 2026-07-09：prior day\n",
        });
        await input.toolHandlers.commit!({});
        return "dream committed";
      },
    };

    try {
      const result =
        await createDreamJobProcessor({ db, dataRoot, store, agentRunner })
          .process("2026-07-10");

      expect(result).toEqual({ remoteAttemptSucceeded: true });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.model).toBe(DEFAULT_DREAM_AGENT_MODEL);
      expect(await store.readLastSuccessfulDate()).toBe("2026-07-10");
      expect(await store.readCurrentMemory()).toEqual({
        userProfile: "# User Profile\n\n- values memorable outcomes [S1/T1]\n",
        archive: "# Memory Archive\n\n- dormant original [S1/T1]\n- demoted detail [S1/T1]\n",
      });
      expect(readFileSync(join(dataRoot, "diary", "2026-07-10.md"), "utf8"))
        .toContain("engineering detail stays here");
      expect(readFileSync(join(dataRoot, "diary", "INDEX.md"), "utf8"))
        .toContain("2026-07-10：completed the arc");
      expect(existsSync(join(dataRoot, "memory", "experience.md"))).toBeFalse();
    } finally {
      db.close();
    }
  });

  test("ingests sidecars before review and compiles the trigger index after commit", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = tempRoot("claude-mnemo-dream-rules-");
    const store = new DreamMemoryStore(dataRoot);
    await seedCurrentMemory(store);
    const sessionId = seedMaterial(db, "2026-07-10");
    const rule = createRuleStore(db).create({
      name: "reviewed-timeout",
      claim: "运行测试命令时设置明确的 timeout。",
      rationale: "避免无人值守的命令永久挂起。",
      scope: "/projects/dream",
      triggerKind: "tool",
      triggerSpec: { kind: "tool", tool: "Bash", param_absent: "timeout" },
      status: "provisional",
      createdAtEpoch: 1,
    });
    const hitTimestamp = Date.parse("2026-07-10T04:00:00+08:00");
    const sidecarPath = resolveHitSidecarPath(dataRoot, hitTimestamp);
    mkdirSync(dirname(sidecarPath), { recursive: true });
    writeFileSync(sidecarPath, `${JSON.stringify({
      hit_id: "88888888-8888-4888-8888-888888888888",
      content_session_id: "dream-2026-07-10",
      event_type: "UserPromptSubmit",
      ts_ms: hitTimestamp,
      rule_id: rule.id,
      prompt_summary: "Remember the outcome and who I am, not implementation trivia.",
    })}\n`);

    try {
      await createDreamJobProcessor({
        db,
        dataRoot,
        store,
        agentRunner: {
          async run(input) {
            expect(() => readFileSync(resolveTriggerIndexPath(dataRoot), "utf8"))
              .toThrow();
            const hits = JSON.parse(
              (await input.toolHandlers.listRuleHits!({ date: "2026-07-10" }))
                .content[0]!.text,
            );
            expect(hits.hits).toHaveLength(1);
            expect(hits.hits[0]).toMatchObject({
              rule: { id: rule.id },
              turn_ref: `S${sessionId}/T1`,
              unresolved: false,
            });
            writeStaging(dataRoot, {
              date: "2026-07-10",
              userProfile: "# User Profile\n",
              archive: "# Memory Archive\n",
              diary: "# 2026-07-10\n",
              diaryIndex: "# Diary Index\n",
            });
            await expect(input.toolHandlers.commit!({})).rejects.toThrow(
              "pending rule hits",
            );
            expect(await store.readLastSuccessfulDate()).toBe("2026-07-09");
            await input.toolHandlers.submitJudgment!({
              rule_id: rule.id,
              source_event_id: hits.hits[0].event_id,
              label: "prevented-stall",
              rationale: "The reminder caused the bounded command and avoided a stall.",
              adjustment: { status: "confirmed" },
            });
            await input.toolHandlers.commit!({});
            return "committed";
          },
        },
      }).process("2026-07-10");

      expect(JSON.parse(readFileSync(resolveTriggerIndexPath(dataRoot), "utf8")))
        .toMatchObject({
          version: 1,
          rules: [{ id: rule.id, name: "reviewed-timeout" }],
        });
      expect(createRuleStore(db).get(rule.id)?.status).toBe("confirmed");
    } finally {
      db.close();
    }
  });

  test("an already-written success marker repairs a failed trigger-index publish", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = tempRoot("claude-mnemo-dream-index-repair-");
    const store = new DreamMemoryStore(dataRoot);
    seedMaterial(db, "2026-07-10");
    const indexPath = resolveTriggerIndexPath(dataRoot);
    mkdirSync(indexPath, { recursive: true });
    let agentRuns = 0;
    const processor = createDreamJobProcessor({
      db,
      dataRoot,
      store,
      agentRunner: {
        async run(input) {
          agentRuns += 1;
          writeStaging(dataRoot, {
            date: "2026-07-10",
            userProfile: "# User Profile\n",
            archive: "# Memory Archive\n",
            diary: "# 2026-07-10\n",
            diaryIndex: "# Diary Index\n",
          });
          await input.toolHandlers.commit!({});
          return "committed";
        },
      },
    });

    try {
      await expect(processor.process("2026-07-10")).rejects.toThrow();
      expect(await store.readLastSuccessfulDate()).toBe("2026-07-10");
      rmSync(indexPath, { recursive: true, force: true });

      expect(await processor.process("2026-07-10"))
        .toEqual({ remoteAttemptSucceeded: false });
      expect(agentRuns).toBe(1);
      expect(JSON.parse(readFileSync(indexPath, "utf8"))).toEqual({
        version: 1,
        rules: [],
      });
    } finally {
      db.close();
    }
  });

  test("a same-session index retry reuses the memory commit snapshot", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = tempRoot("claude-mnemo-dream-index-same-run-");
    const store = new DreamMemoryStore(dataRoot);
    seedMaterial(db, "2026-07-10");
    const indexPath = resolveTriggerIndexPath(dataRoot);
    mkdirSync(indexPath, { recursive: true });

    try {
      await createDreamJobProcessor({
        db,
        dataRoot,
        store,
        agentRunner: {
          async run(input) {
            writeStaging(dataRoot, {
              date: "2026-07-10",
              userProfile: "# User Profile\n",
              archive: "# Memory Archive\n",
              diary: "# 2026-07-10\n",
              diaryIndex: "# Diary Index\n",
            });
            await expect(input.toolHandlers.commit!({})).rejects.toThrow();
            rmSync(indexPath, { recursive: true, force: true });
            await input.toolHandlers.commit!({});
            return "committed";
          },
        },
      }).process("2026-07-10");

      expect((await store.listSnapshots()).filter(({ date }) =>
        date === "2026-07-10"
      )).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("an unresolved sidecar hit still runs review on an otherwise quiet day", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = tempRoot("claude-mnemo-dream-unresolved-review-");
    const store = new DreamMemoryStore(dataRoot);
    await seedCurrentMemory(store);
    const rule = createRuleStore(db).create({
      name: "unresolved-review",
      claim: "无法解析轨迹时显式记录证据不足。",
      rationale: "未解析 hit 也不能静默丢弃。",
      scope: "global",
      triggerKind: "prompt",
      triggerSpec: { kind: "prompt", keywords: ["unresolved"] },
      status: "provisional",
      createdAtEpoch: 1,
    });
    const hitTimestamp = Date.parse("2026-07-10T04:00:00+08:00");
    const sidecarPath = resolveHitSidecarPath(dataRoot, hitTimestamp);
    mkdirSync(dirname(sidecarPath), { recursive: true });
    writeFileSync(sidecarPath, `${JSON.stringify({
      hit_id: "99999999-9999-4999-8999-999999999999",
      content_session_id: "missing-session",
      event_type: "UserPromptSubmit",
      ts_ms: hitTimestamp,
      rule_id: rule.id,
      prompt_summary: "unresolved evidence",
    })}\n`);
    let agentRuns = 0;

    try {
      await createDreamJobProcessor({
        db,
        dataRoot,
        store,
        agentRunner: {
          async run(input) {
            agentRuns += 1;
            const hits = JSON.parse(
              (await input.toolHandlers.listRuleHits!({ date: "2026-07-10" }))
                .content[0]!.text,
            );
            expect(hits.hits).toHaveLength(1);
            expect(hits.hits[0]).toMatchObject({
              turn_ref: null,
              unresolved: true,
            });
            await input.toolHandlers.submitJudgment!({
              rule_id: rule.id,
              source_event_id: hits.hits[0].event_id,
              label: "insufficient-evidence",
              rationale: "The hit could not be resolved to a turn.",
            });
            writeStaging(dataRoot, {
              date: "2026-07-10",
              userProfile: "# User Profile\n",
              archive: "# Memory Archive\n",
              diary: "# 2026-07-10\n\n安静的一天。\n",
              diaryIndex: "# Diary Index\n\n- 2026-07-10：安静的一天\n",
            });
            await input.toolHandlers.commit!({});
            return "committed";
          },
        },
      }).process("2026-07-10");

      expect(agentRuns).toBe(1);
      const judgments = createRuleStore(db).listEvents(rule.id)
        .filter(({ eventKind }) => eventKind === "judgment");
      expect(judgments).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("the single-commit guard blocks a second payload-free commit", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = tempRoot("claude-mnemo-dream-double-commit-");
    const store = new DreamMemoryStore(dataRoot);
    await seedCurrentMemory(store);
    seedMaterial(db, "2026-07-10");

    try {
      await createDreamJobProcessor({
        db,
        dataRoot,
        store,
        agentRunner: {
          async run(input) {
            writeStaging(dataRoot, {
              date: "2026-07-10",
              userProfile: "# User Profile\n\n- once [S1/T1]\n",
              archive: "# Memory Archive\n",
              diary: "# 2026-07-10\n\n- day\n",
              diaryIndex: "# Diary Index\n\n- 2026-07-10：day\n",
            });
            await input.toolHandlers.commit!({});
            await expect(input.toolHandlers.commit!({})).rejects.toThrow(
              "attempted more than one commit",
            );
            return "committed";
          },
        },
      }).process("2026-07-10");

      // Exactly one publish for the date: the guard stopped the second commit
      // before it could run a second commitNight transaction (one snapshot).
      expect(await store.readLastSuccessfulDate()).toBe("2026-07-10");
      expect(
        (await store.listSnapshots()).filter((s) => s.date === "2026-07-10"),
      ).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("a no-material date writes a quiet-day diary atomically and skips curation", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = tempRoot("claude-mnemo-dream-quiet-");
    const store = new DreamMemoryStore(dataRoot);
    await seedCurrentMemory(store);
    let agentCalls = 0;

    try {
      const result = await createDreamJobProcessor({
        db,
        dataRoot,
        store,
        agentRunner: {
          async run() {
            agentCalls += 1;
            throw new Error("quiet days must not invoke the agent");
          },
        },
      }).process("2026-07-10");

      expect(result).toEqual({ remoteAttemptSucceeded: false });
      expect(agentCalls).toBe(0);
      expect(await store.readCurrentMemory()).toEqual({
        userProfile: "# User Profile\n\n- values careful memory [S1/T1]\n",
        archive: "# Memory Archive\n\n- dormant original [S1/T1]\n",
      });
      expect(readFileSync(join(dataRoot, "diary", "2026-07-10.md"), "utf8"))
        .toContain("安静的一天");
      expect(readFileSync(join(dataRoot, "diary", "INDEX.md"), "utf8"))
        .toBe("# Diary Index\n\n- 2026-07-10：安静的一天\n- 2026-07-09：prior day\n");
      expect(await store.readLastSuccessfulDate()).toBe("2026-07-10");
    } finally {
      db.close();
    }
  });

  test("an already-committed date reports a local no-op", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = tempRoot("claude-mnemo-dream-noop-");
    const store = new DreamMemoryStore(dataRoot);
    await seedCurrentMemory(store);
    let agentCalls = 0;

    try {
      const result = await createDreamJobProcessor({
        db,
        dataRoot,
        store,
        agentRunner: {
          async run() {
            agentCalls += 1;
            throw new Error("already committed dates must not invoke the agent");
          },
        },
      }).process("2026-07-09");

      expect(result).toEqual({ remoteAttemptSucceeded: false });
      expect(agentCalls).toBe(0);
    } finally {
      db.close();
    }
  });

  test("a missing legacy CURRENT makes the first night perform a full fill even without material", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = tempRoot("claude-mnemo-dream-full-fill-");
    const store = new DreamMemoryStore(dataRoot);
    mkdirSync(join(dataRoot, "diary"), { recursive: true });
    writeFileSync(
      join(dataRoot, "diary", "2026-07-09.md"),
      "# 2026-07-09\n\n- remembered history [S1/T1]\n",
    );
    let agentCalls = 0;

    try {
      await createDreamJobProcessor({
        db,
        dataRoot,
        store,
        agentRunner: {
          async run(input) {
            agentCalls += 1;
            expect(input.prompt).toContain("# 首夜全量填充");
            expect(input.prompt).toContain("不要只根据当天材料填充");
            expect(input.prompt).toContain("当天没有材料");
            expect(input.prompt).toContain("开头必须是沟通风格与为人");
            expect(await input.toolHandlers.readDoc("diary/2026-07-09.md"))
              .toContain("remembered history");
            writeStaging(dataRoot, {
              date: "2026-07-10",
              userProfile: "# User Profile\n\n- rebuilt from history [S1/T1]\n",
              archive: "# Memory Archive\n",
              diary: "# 2026-07-10\n\n安静的一天。\n",
              diaryIndex: "# Diary Index\n\n- 2026-07-10：安静的一天\n",
            });
            await input.toolHandlers.commit!({});
            return "full fill committed";
          },
        },
      }).process("2026-07-10");

      expect(agentCalls).toBe(1);
      expect(await store.requiresInitialFullFill()).toBe(false);
      expect(await store.readCurrentMemory()).toMatchObject({
        userProfile: expect.stringContaining("rebuilt from history"),
      });
    } finally {
      db.close();
    }
  });

  test("the nightly snapshot contains the pre-curate memory", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = tempRoot("claude-mnemo-dream-snapshot-");
    const store = new DreamMemoryStore(dataRoot);
    await seedCurrentMemory(store);
    seedMaterial(db, "2026-07-10");

    try {
      await createDreamJobProcessor({
        db,
        dataRoot,
        store,
        agentRunner: {
          async run(input) {
            writeStaging(dataRoot, {
              date: "2026-07-10",
              userProfile: "# User Profile\n\n- curated replacement [S1/T1]\n",
              archive: "# Memory Archive\n",
              diary: "# 2026-07-10\n\n- day\n",
              diaryIndex: "# Diary Index\n\n- 2026-07-10：day\n",
            });
            await input.toolHandlers.commit!({});
            return "committed";
          },
        },
      }).process("2026-07-10");

      const nightly = (await store.listSnapshots()).find(
        (snapshot) => snapshot.date === "2026-07-10",
      );
      expect(nightly).toBeDefined();
      expect((await store.verifySnapshot(nightly!.id)).documents).toEqual({
        userProfile: "# User Profile\n\n- values careful memory [S1/T1]\n",
        archive: "# Memory Archive\n\n- dormant original [S1/T1]\n",
      });
    } finally {
      db.close();
    }
  });

  test("reads the model from config and falls back with a warning before the fake runner", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = tempRoot("claude-mnemo-dream-model-");
    const configHome = tempRoot("claude-mnemo-dream-config-");
    mkdirSync(join(configHome, ".claude-mnemo"), { recursive: true });
    writeFileSync(
      join(configHome, ".claude-mnemo", "config.json"),
      JSON.stringify({ dreamAgentModel: "not-a-known-model" }),
    );
    seedMaterial(db, "2026-07-10");
    const warnings: string[] = [];
    let seenModel: string | undefined;

    try {
      await createDreamJobProcessor({
        db,
        dataRoot,
        configHomePath: configHome,
        configLogger: { warn: (message) => warnings.push(message) },
        agentRunner: {
          async run(input) {
            seenModel = input.model;
            expect(await input.toolHandlers.readDoc("memory/user-profile.md"))
              .toBe("# User Profile\n");
            expect(await input.toolHandlers.readDoc("memory/archive.md"))
              .toBe("# Memory Archive\n");
            expect(await input.toolHandlers.canUseTool("Grep", {
              path: join(dataRoot, "diary"),
              pattern: ".",
            }, {} as never)).toMatchObject({ behavior: "allow" });
            writeStaging(dataRoot, {
              date: "2026-07-10",
              userProfile: "# User Profile\n",
              archive: "# Memory Archive\n",
              diary: "# 2026-07-10\n",
              diaryIndex: "# Diary Index\n",
            });
            await input.toolHandlers.commit!({});
            return "committed";
          },
        },
      }).process("2026-07-10");

      expect(seenModel).toBe(DEFAULT_DREAM_AGENT_MODEL);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("Invalid dreamAgentModel");
    } finally {
      db.close();
    }
  });
});
