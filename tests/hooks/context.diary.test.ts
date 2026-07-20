import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  PROFILE_INJECTION_TOKEN_BUDGET,
  SESSION_INJECTION_TOKEN_BUDGET,
} from "../../src/diary/persona-render";
import { createContextHandler } from "../../src/hooks/handlers/context";

describe("SessionStart dream isolation and injection", () => {
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

  test("does not bootstrap or queue a due dream after the configured hour", async () => {
    const stateStore = createDiaryStateStore(db);
    const nowEpoch = Date.parse("2026-07-11T05:00:00+08:00") / 1_000;
    await createContextHandler({
      db,
    })(session("dream-schedule", nowEpoch));

    expect(stateStore.claimNextDiaryItem(nowEpoch)).toBeNull();
    expect(db.query<{ value: string }, []>(
      "SELECT value FROM diary_state WHERE key = 'cutover_date'",
    ).get()).toBeNull();
    expect(db.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM session_run_state",
    ).get()?.count).toBe(1);
  });

  test("splits bounded state, persona, and recent/diary output while sessions side effects run once", async () => {
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
    const dependencies = {
      db,
      fileStore: new DiaryFileStore(dataRoot),
      memoryStore,
    };
    const input = {
      ...session("dream-injection", nowEpoch),
      source: "resume" as const,
    };
    const sessionsResult = await createContextHandler(dependencies)(input);
    const sessionDbId = db.query<{ id: number }, []>(
      "SELECT id FROM sessions WHERE content_session_id = 'dream-injection'",
    ).get()!.id;
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt,
        assistant_response, created_at_epoch
      ) VALUES (?, 1, 'active', 'stranded after sessions hook', 'answer', ?)`,
    ).run(sessionDbId, nowEpoch + 1);
    const personaResult = await createContextHandler(dependencies, "persona")(input);
    const recentResult = await createContextHandler(
      dependencies,
      "recent",
    )(input);
    const sessions = sessionsResult.hookSpecificOutput ?? "";
    const persona = personaResult.hookSpecificOutput ?? "";
    const recent = recentResult.hookSpecificOutput ?? "";
    const indexStart = recent.indexOf("# Diary Index");
    const index = recent.slice(indexStart).trim();

    expect(sessions).toContain("claude-mnemo:");
    expect(sessions).not.toContain("## Recent Sessions");
    expect(sessions).not.toContain("## Persona");
    expect(sessions).not.toContain("## Experience");
    expect(estimateDiaryTokens(sessions.split("\n").slice(3).join("\n")))
      .toBeLessThanOrEqual(SESSION_INJECTION_TOKEN_BUDGET);
    expect(persona).toContain("## Persona");
    expect(persona).not.toContain("## Experience");
    expect(persona).not.toContain("# Diary Index");
    expect(estimateDiaryTokens(persona)).toBeLessThanOrEqual(
      PROFILE_INJECTION_TOKEN_BUDGET,
    );
    expect(estimateDiaryTokens(recent)).toBeLessThanOrEqual(
      SESSION_INJECTION_TOKEN_BUDGET,
    );
    expect(estimateDiaryTokens(index)).toBeLessThanOrEqual(
      DIARY_INDEX_INJECTION_TOKEN_BUDGET,
    );
    expect(recent).toContain("# Diary Index");
    expect(recent).not.toContain("## Experience");
    expect(recent).not.toContain("## Persona");
    expect(persona).not.toContain("ARCHIVE_MUST_NEVER_BE_INJECTED");
    expect(recent).not.toContain("ARCHIVE_MUST_NEVER_BE_INJECTED");
    expect(recent).not.toContain("experience 0");
    expect(persona).not.toContain("memory/archive.md");
    expect(recent).not.toContain("memory/archive.md");
    expect(index.indexOf("2026-07-10")).toBeLessThan(index.indexOf("2026-07-09"));
    expect(index.indexOf("2026-07-09")).toBeLessThan(index.indexOf("2026-07-08"));
    expect(db.query<{ startTurnId: number }, []>(
      `SELECT start_turn_id AS startTurnId
       FROM session_run_state
       WHERE session_db_id = ${sessionDbId}`,
    ).get()?.startTurnId).toBe(0);
    expect(db.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM pending_queue",
    ).get()?.count).toBe(0);
  });

  test("persona and recent reads are silent when their stores are unavailable or fail", async () => {
    const input = session("dream-empty-injection", 100);
    const missingPersona = await createContextHandler({ db }, "persona")(input);
    const missingRecent = await createContextHandler({ db }, "recent")(
      input,
    );
    const failedPersona = await createContextHandler({
      db,
      memoryStore: {
        dataRoot: "/unavailable",
        readInjectionDocuments: async () => {
          throw new Error("unavailable");
        },
      },
    }, "persona")(input);

    expect(missingPersona).toEqual({ continue: true });
    expect(missingRecent).toEqual({ continue: true });
    expect(failedPersona).toEqual({ continue: true });
  });

  test("persona and recent do not create missing roots; diary-only content still emits", async () => {
    const parent = mkdtempSync(join(tmpdir(), "claude-mnemo-read-only-context-"));
    roots.push(parent);
    const missingDataRoot = join(parent, "missing");
    const missingMemoryStore = new DreamMemoryStore(missingDataRoot);
    const input = session("dream-read-only-injection", 100);

    const missingPersona = await createContextHandler({
      db,
      memoryStore: missingMemoryStore,
    }, "persona")(input);
    const missingRecent = await createContextHandler({
      db,
      fileStore: new DiaryFileStore(missingDataRoot),
    }, "recent")(input);
    const headingOnlyMemoryStore = {
      dataRoot: parent,
      readInjectionDocuments: async () => ({
        userProfile: "# User Profile\n## Identity\n",
        experience: "# Experience\n## Projects\n",
      }),
    };
    const headingOnlyPersona = await createContextHandler({
      db,
      memoryStore: headingOnlyMemoryStore,
    }, "persona")(input);
    const diaryOnlyRecent = await createContextHandler({
      db,
      fileStore: {
        readIndex: async () =>
          new TextEncoder().encode("# Diary Index\n\n- 2026-07-10：entry\n"),
      },
    }, "recent")(input);

    expect(missingPersona).toEqual({ continue: true });
    expect(missingRecent).toEqual({ continue: true });
    expect(headingOnlyPersona).toEqual({ continue: true });
    expect(diaryOnlyRecent.hookSpecificOutput).toContain("# Diary Index");
    expect(diaryOnlyRecent.hookSpecificOutput).not.toContain("## Experience");
    expect(existsSync(missingDataRoot)).toBe(false);
  });
});
