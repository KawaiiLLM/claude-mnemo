import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { DreamMemoryStore } from "../../src/diary/memory-store";
import {
  DEFAULT_DREAM_AGENT_MODEL,
} from "../../src/shared/config";
import {
  createDreamJobProcessor,
  DREAM_CURATE_PROMPT,
} from "../../src/worker/dream-job";
import type {
  DiaryAgentRunInput,
  DiaryAgentRunner,
} from "../../src/worker/diary-agent-runner";
import { saveTurnFixture } from "../support/turn-fixtures";

const roots: string[] = [];

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
    experience: "# Experience\n\n- 2026-07-09: began the arc [S1/T1]\n",
    archive: "# Memory Archive\n\n- dormant original [S1/T1]\n",
    diary: "# 2026-07-09\n\n- prior day\n",
    diaryIndex: "# Diary Index\n\n- 2026-07-09：prior day\n",
  });
}

describe("dream job processor", () => {
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
        expect(input.toolHandlers.commit).toBeDefined();
        await input.toolHandlers.commit!({
          date: "2026-07-10",
          userProfile: "# User Profile\n\n- values memorable outcomes [S1/T1]\n",
          experience: `# Experience\n\n- 2026-07-10: completed the arc [S${sessionId}/T1]\n`,
          archive: "# Memory Archive\n\n- dormant original [S1/T1]\n- demoted detail [S1/T1]\n",
          diary: `# 2026-07-10\n\n- engineering detail stays here [S${sessionId}/T1]\n`,
          diaryIndex: "# Diary Index\n\n- 2026-07-10：completed the arc\n- 2026-07-09：prior day\n",
        });
        return "dream committed";
      },
    };

    try {
      await createDreamJobProcessor({ db, dataRoot, store, agentRunner })
        .process("2026-07-10");

      expect(calls).toHaveLength(1);
      expect(calls[0]?.model).toBe(DEFAULT_DREAM_AGENT_MODEL);
      expect(await store.readLastSuccessfulDate()).toBe("2026-07-10");
      expect(await store.readCurrentMemory()).toEqual({
        userProfile: "# User Profile\n\n- values memorable outcomes [S1/T1]\n",
        experience: `# Experience\n\n- 2026-07-10: completed the arc [S${sessionId}/T1]\n`,
        archive: "# Memory Archive\n\n- dormant original [S1/T1]\n- demoted detail [S1/T1]\n",
      });
      expect(readFileSync(join(dataRoot, "diary", "2026-07-10.md"), "utf8"))
        .toContain("engineering detail stays here");
      expect(readFileSync(join(dataRoot, "diary", "INDEX.md"), "utf8"))
        .toContain("2026-07-10：completed the arc");
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
      await createDreamJobProcessor({
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

      expect(agentCalls).toBe(0);
      expect(await store.readCurrentMemory()).toEqual({
        userProfile: "# User Profile\n\n- values careful memory [S1/T1]\n",
        experience: "# Experience\n\n- 2026-07-09: began the arc [S1/T1]\n",
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
            expect(await input.toolHandlers.readDoc("diary/2026-07-09.md"))
              .toContain("remembered history");
            await input.toolHandlers.commit!({
              date: "2026-07-10",
              userProfile: "# User Profile\n\n- rebuilt from history [S1/T1]\n",
              experience: "# Experience\n\n- recovered history [S1/T1]\n",
              archive: "# Memory Archive\n",
              diary: "# 2026-07-10\n\n安静的一天。\n",
              diaryIndex: "# Diary Index\n\n- 2026-07-10：安静的一天\n",
            });
            return "full fill committed";
          },
        },
      }).process("2026-07-10");

      expect(agentCalls).toBe(1);
      expect(await store.requiresInitialFullFill()).toBe(false);
      expect(await store.readCurrentMemory()).toMatchObject({
        userProfile: expect.stringContaining("rebuilt from history"),
        experience: expect.stringContaining("recovered history"),
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
            await input.toolHandlers.commit!({
              date: "2026-07-10",
              userProfile: "# User Profile\n\n- curated replacement [S1/T1]\n",
              experience: "# Experience\n\n- curated replacement [S1/T1]\n",
              archive: "# Memory Archive\n",
              diary: "# 2026-07-10\n\n- day\n",
              diaryIndex: "# Diary Index\n\n- 2026-07-10：day\n",
            });
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
        experience: "# Experience\n\n- 2026-07-09: began the arc [S1/T1]\n",
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
            await input.toolHandlers.commit!({
              date: "2026-07-10",
              userProfile: "# User Profile\n",
              experience: "# Experience\n",
              archive: "# Memory Archive\n",
              diary: "# 2026-07-10\n",
              diaryIndex: "# Diary Index\n",
            });
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
