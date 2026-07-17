import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase } from "../../src/db/database";
import { createDiaryStateStore } from "../../src/db/diary-state";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { estimateDiaryTokens } from "../../src/diary/domain";
import { DiaryFileStore } from "../../src/diary/file-store";
import { DreamMemoryStore } from "../../src/diary/memory-store";
import {
  DIARY_INDEX_INJECTION_TOKEN_BUDGET,
  EXPERIENCE_INJECTION_TOKEN_BUDGET,
  PROFILE_INJECTION_TOKEN_BUDGET,
} from "../../src/diary/persona-render";
import { createContextHandler } from "../../src/hooks/handlers/context";

describe("SessionStart dream scheduling and injection", () => {
  let db: Database;
  const roots: string[] = [];

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function session(contentSessionId: string, createdAtEpoch: number) {
    upsertSession(db, {
      contentSessionId,
      project: "/projects/dream",
      title: "Dream session",
      content: null,
      insight: null,
      createdAtEpoch,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
    return {
      eventName: "SessionStart" as const,
      source: "startup" as const,
      sessionId: contentSessionId,
      cwd: "/projects/dream",
      stopHookActive: false,
      raw: {},
    };
  }

  test("queues every missed date after the configured hour without waking the worker", async () => {
    const stateStore = createDiaryStateStore(db);
    const nowEpoch = Date.parse("2026-07-11T05:00:00+08:00") / 1_000;
    await createContextHandler({
      db,
      diaryStateStore: stateStore,
      nowEpoch: () => nowEpoch,
      dreamSchedule: {
        hour: 4,
        timeZone: "Asia/Shanghai",
        backlogLimit: 7,
      },
      readLastSuccessfulDate: async () => "2026-07-07",
    })(session("dream-schedule", nowEpoch));

    expect(stateStore.claimNextDiaryItem(nowEpoch)?.targetId).toBe(20260708);
    expect(stateStore.claimNextDiaryItem(nowEpoch)?.targetId).toBe(20260709);
    expect(stateStore.claimNextDiaryItem(nowEpoch)?.targetId).toBe(20260710);
    expect(stateStore.claimNextDiaryItem(nowEpoch)).toBeNull();
  });

  test("does not queue before the configured hour", async () => {
    const stateStore = createDiaryStateStore(db);
    const nowEpoch = Date.parse("2026-07-11T03:00:00+08:00") / 1_000;
    await createContextHandler({
      db,
      diaryStateStore: stateStore,
      nowEpoch: () => nowEpoch,
      dreamSchedule: {
        hour: 4,
        timeZone: "Asia/Shanghai",
        backlogLimit: 7,
      },
      readLastSuccessfulDate: async () => "2026-07-07",
    })(session("dream-pre-trigger", nowEpoch));
    expect(stateStore.claimNextDiaryItem(nowEpoch)).toBeNull();
  });

  test("injects only bounded current memory and a recent-first diary index", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-context-dream-"));
    roots.push(dataRoot);
    const memoryStore = new DreamMemoryStore(dataRoot);
    const longDocument = (heading: string, label: string) => [
      `# ${heading}`,
      ...Array.from(
        { length: 60 },
        (_, index) => `- ${label} ${index} ${"中文记忆内容".repeat(8)}`,
      ),
      "",
    ].join("\n");
    // Seed oversized documents by writing the live files directly: commitNight
    // now hard-caps hot memory at MEMORY_DOCUMENT_TOKEN_LIMIT, but pre-cap
    // installs can still carry larger docs on disk, and the injection renderer
    // must stay bounded for them regardless.
    mkdirSync(join(dataRoot, "memory"), { recursive: true });
    mkdirSync(join(dataRoot, "diary"), { recursive: true });
    writeFileSync(
      join(dataRoot, "memory", "user-profile.md"),
      longDocument("User Profile", "profile"),
    );
    writeFileSync(
      join(dataRoot, "memory", "experience.md"),
      longDocument("Experience", "experience"),
    );
    writeFileSync(
      join(dataRoot, "memory", "archive.md"),
      "# Memory Archive\n\n- ARCHIVE_MUST_NEVER_BE_INJECTED\n",
    );
    writeFileSync(
      join(dataRoot, "diary", "2026-07-10.md"),
      "# 2026-07-10\n\n- current day\n",
    );
    writeFileSync(
      join(dataRoot, "diary", "INDEX.md"),
      [
        "# Diary Index",
        "",
        "- 2026-07-08：older",
        "- 2026-07-10：newest",
        "- 2026-07-09：middle",
        "",
      ].join("\n"),
    );
    const nowEpoch = Date.parse("2026-07-11T12:00:00+08:00") / 1_000;
    const result = await createContextHandler({
      db,
      fileStore: new DiaryFileStore(dataRoot),
      memoryStore,
    })(session("dream-injection", nowEpoch));
    const output = result.hookSpecificOutput ?? "";
    const profileStart = output.indexOf("## Persona");
    const experienceStart = output.indexOf("## Experience");
    const indexStart = output.indexOf("# Diary Index", experienceStart);
    const profile = output.slice(profileStart, experienceStart).trim();
    const experience = output.slice(experienceStart, indexStart).trim();
    const index = output.slice(indexStart).trim();

    expect(estimateDiaryTokens(profile)).toBeLessThanOrEqual(
      PROFILE_INJECTION_TOKEN_BUDGET,
    );
    expect(estimateDiaryTokens(experience)).toBeLessThanOrEqual(
      EXPERIENCE_INJECTION_TOKEN_BUDGET,
    );
    expect(estimateDiaryTokens(index)).toBeLessThanOrEqual(
      DIARY_INDEX_INJECTION_TOKEN_BUDGET,
    );
    expect(output).not.toContain("ARCHIVE_MUST_NEVER_BE_INJECTED");
    expect(output).not.toContain("memory/archive.md");
    expect(index.indexOf("2026-07-10")).toBeLessThan(index.indexOf("2026-07-09"));
    expect(index.indexOf("2026-07-09")).toBeLessThan(index.indexOf("2026-07-08"));
  });
});
