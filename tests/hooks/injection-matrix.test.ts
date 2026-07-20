import { describe, expect, mock, test } from "bun:test";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { estimateDiaryTokens } from "../../src/diary/domain";
import { SESSION_INJECTION_TOKEN_BUDGET } from "../../src/diary/persona-render";
import { createMilestoneContextHandler } from "../../src/hooks/handlers/context-milestones";
import {
  createContextHandler,
  createReadOnlyContextHandler,
} from "../../src/hooks/handlers/context";
import type { NormalizedHookInput } from "../../src/hooks/types";

const SOURCES = ["startup", "clear", "resume", "compact"] as const;

function totalChanges(db: ReturnType<typeof createDatabase>): number {
  return db.query<{ count: number }, []>(
    "SELECT total_changes() AS count",
  ).get()!.count;
}

describe("SessionStart injection matrix", () => {
  for (const source of SOURCES) {
    test(`${source} emits only its matrix sections while sessions side effects run once`, async () => {
      const db = createDatabase(":memory:");
      initializeSchema(db);
      const current = upsertSession(db, {
        contentSessionId: `current-${source}`,
        project: "/projects/matrix",
        title: `Current ${source}`,
        content: "Current session state",
        current: "Continue the matrix implementation.",
        insight: null,
        createdAtEpoch: 1_700_000_100,
        updatedAtEpoch: null,
        completedAtEpoch: null,
      });
      const prior = upsertSession(db, {
        contentSessionId: `prior-${source}`,
        project: "/projects/matrix",
        title: `Prior ${source}`,
        content: "Prior session context",
        insight: null,
        createdAtEpoch: 1_700_000_000,
        updatedAtEpoch: null,
        completedAtEpoch: null,
      });
      db.query(
        `INSERT INTO turns (
          session_id, prompt_number, status, user_prompt,
          assistant_response, title, type, created_at_epoch
        ) VALUES (?, 1, 'extracted', 'prior prompt', 'prior response',
          'Prior milestone', 'feature', 1700000010)`,
      ).run(prior.id);
      db.query(
        `INSERT INTO turns (
          session_id, prompt_number, status, user_prompt,
          assistant_response, title, type, created_at_epoch
        ) VALUES (?, 1, 'extracted', 'current prompt', 'current response',
          'Current milestone', 'feature', 1700000110)`,
      ).run(current.id);
      db.query(
        `INSERT INTO turns (
          session_id, prompt_number, status, user_prompt,
          assistant_response, created_at_epoch
        ) VALUES (?, 2, 'active', 'stranded prompt',
          'stranded response', 1700000120)`,
      ).run(current.id);

      const input: NormalizedHookInput = {
        eventName: "SessionStart",
        source,
        sessionId: `current-${source}`,
        cwd: "/projects/matrix",
        stopHookActive: false,
        raw: {},
      };
      const dependencies = {
        db,
        fileStore: {
          readIndex: async () =>
            new TextEncoder().encode(
              "# Diary Index\n\n- 2026-07-10: diary entry\n",
            ),
        },
        memoryStore: {
          dataRoot: "/virtual",
          readInjectionDocuments: async () => ({
            userProfile: "# User Profile\n\n- Matrix persona\n",
            experience: "# Experience\n\n- MUST_NOT_BE_INJECTED\n",
          }),
        },
      };

      const sessions = await createContextHandler(dependencies)(input);
      const persona = await createReadOnlyContextHandler(
        dependencies,
        "persona",
      )(input);
      const recent = await createReadOnlyContextHandler(
        dependencies,
        "recent",
      )(input);
      const milestones = await createMilestoneContextHandler({
        db,
        renderMilestoneInjection: () => "MILESTONE_OUTPUT",
      })(input);

      if (source === "resume" || source === "compact") {
        expect(sessions.hookSpecificOutput).toContain("## Current Session");
        expect(milestones.hookSpecificOutput).toBe("MILESTONE_OUTPUT");
      } else {
        expect(sessions).toEqual({ continue: true });
        expect(milestones).toEqual({ continue: true });
      }
      expect(sessions.hookSpecificOutput ?? "").not.toContain(
        "## Recent Sessions",
      );
      expect(persona.hookSpecificOutput).toContain("## Persona");
      expect(recent.hookSpecificOutput).toContain("## Recent Sessions");
      expect(recent.hookSpecificOutput).toContain("# Diary Index");
      expect(recent.hookSpecificOutput).toContain(`Prior ${source}`);
      expect(recent.hookSpecificOutput).not.toContain(
        "MUST_NOT_BE_INJECTED",
      );
      expect(estimateDiaryTokens(recent.hookSpecificOutput!))
        .toBeLessThanOrEqual(SESSION_INJECTION_TOKEN_BUDGET);
      expect(db.query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM sessions WHERE content_session_id = ?",
      ).get(`current-${source}`)?.count).toBe(1);
      expect(db.query<{ count: number }, [number]>(
        `SELECT COUNT(*) AS count
         FROM pending_queue
         WHERE session_db_id = ? AND kind = 'turn-stop'`,
      ).get(current.id)?.count).toBe(1);
      expect(db.query<{ count: number }, [number]>(
        "SELECT COUNT(*) AS count FROM session_run_state WHERE session_db_id = ?",
      ).get(current.id)?.count).toBe(1);

      db.close();
    });
  }

  test("recent sessions uses read-only DB access and a naked recall() overflow pointer", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    upsertSession(db, {
      contentSessionId: "current-overflow",
      project: "/projects/matrix",
      title: "Current",
      content: null,
      insight: null,
      createdAtEpoch: 2_000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
    for (let index = 1; index <= 10; index += 1) {
      upsertSession(db, {
        contentSessionId: `overflow-${index}`,
        project: "/projects/matrix",
        title: `Overflow ${index} ${"超长标题".repeat(180)}`,
        content: `Context ${index}`,
        insight: null,
        createdAtEpoch: 2_000 - index,
        updatedAtEpoch: null,
        completedAtEpoch: null,
      });
    }
    const before = totalChanges(db);

    const result = await createReadOnlyContextHandler({
      db,
      fileStore: {
        readIndex: async () =>
          new TextEncoder().encode(
            "# Diary Index\n\n- 2026-07-10: newest\n",
          ),
      },
    }, "recent")({
      eventName: "SessionStart",
      source: "startup",
      sessionId: "current-overflow",
      cwd: "/projects/matrix",
      stopHookActive: false,
      raw: {},
    });

    expect(result.hookSpecificOutput).toContain("完整见 recall()");
    expect(result.hookSpecificOutput).not.toContain('recall(id="S');
    expect(totalChanges(db)).toBe(before);
    db.close();
  });
});
