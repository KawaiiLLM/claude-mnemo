import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import { DreamMemoryStore } from "../../src/diary/memory-store";
import { PROFILE_INJECTION_TOKEN_BUDGET } from "../../src/diary/persona-render";
import { createContextHandler } from "../../src/hooks/handlers/context";

/**
 * The persona section stays isolated from the archive/experience documents
 * regardless of what the diary artifacts on disk carry, and the bare
 * `context` command's own side effects (session registration, stranded
 * recovery) still run once per SessionStart. The "recent" section this file
 * used to also cover retired at ticket 10 (RecentSessions and the diary
 * index no longer render at SessionStart) — see `injection-matrix.test.ts`
 * for the roster that replaced its body.
 */
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

  test("persona stays isolated from experience/archive while roster and side effects run once", async () => {
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
    const nowEpoch = Date.parse("2026-07-11T12:00:00+08:00") / 1_000;
    const dependencies = { db, memoryStore };
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
    const sessions = sessionsResult.hookSpecificOutput ?? "";
    const persona = personaResult.hookSpecificOutput ?? "";

    expect(sessions).toContain("## Segment roster");
    expect(sessions).not.toContain("## Persona");
    expect(sessions).not.toContain("## Experience");
    expect(persona).toContain("## Persona");
    expect(persona).not.toContain("## Experience");
    expect(estimateDiaryTokens(persona)).toBeLessThanOrEqual(
      PROFILE_INJECTION_TOKEN_BUDGET,
    );
    expect(persona).not.toContain("ARCHIVE_MUST_NEVER_BE_INJECTED");
    expect(persona).not.toContain("memory/archive.md");
    expect(db.query<{ startTurnId: number }, []>(
      `SELECT start_turn_id AS startTurnId
       FROM session_run_state
       WHERE session_db_id = ${sessionDbId}`,
    ).get()?.startTurnId).toBe(0);
    expect(db.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM pending_queue",
    ).get()?.count).toBe(0);
  });

  test("persona reads are silent when the store is unavailable or fails", async () => {
    const input = session("dream-empty-injection", 100);
    const missingPersona = await createContextHandler({ db }, "persona")(input);
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
    expect(failedPersona).toEqual({ continue: true });
  });

  test("persona does not create missing roots and stays silent on a heading-only profile", async () => {
    const parent = mkdtempSync(join(tmpdir(), "claude-mnemo-read-only-context-"));
    roots.push(parent);
    const missingDataRoot = join(parent, "missing");
    const missingMemoryStore = new DreamMemoryStore(missingDataRoot);
    const input = session("dream-read-only-injection", 100);

    const missingPersona = await createContextHandler({
      db,
      memoryStore: missingMemoryStore,
    }, "persona")(input);
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

    expect(missingPersona).toEqual({ continue: true });
    expect(headingOnlyPersona).toEqual({ continue: true });
    expect(existsSync(missingDataRoot)).toBe(false);
  });
});
