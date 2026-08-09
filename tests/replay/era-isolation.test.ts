import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { createObservation } from "../../src/db/observations";
import { initializeSchema } from "../../src/db/schema";
import { reindexTurnFromDb, searchMemory } from "../../src/db/search";
import { upsertSession } from "../../src/db/sessions";
import { recallMemory } from "../../src/mcp/recall";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/**
 * Spec D11's last line: "replay 原文轴零改动". The raw axis is the escape hatch
 * that makes every other filter safe to have — recall may decide a turn is not
 * a hit and the arc may decide it is not a row, but the bytes stay reachable.
 * These are the regression assertions for that.
 */
describe("the replay axis is untouched by the segment era", () => {
  let db: Database;
  let sessionId: number;
  let turnId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "session-replay-era",
      project: "/tmp/project",
      title: null,
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;

    turnId = db
      .query<{ id: number }, [number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt, assistant_response,
           assistant_transcript, created_at_epoch, tags, files_read, files_modified
         ) VALUES (?, 1, 'skipped', 'the exact words the user typed',
                   'the final answer', 'the full narration', 100, '[]', '[]', '[]')
         RETURNING id`,
      )
      .get(sessionId)!.id;
    reindexTurnFromDb(db, turnId);

    createObservation(db, {
      turnId,
      toolName: "Bash",
      toolInput: "rg --files-with-matches watchdog",
      toolResult: "src/worker/server.ts",
      status: "pending",
      createdAtEpoch: 101,
    });
  });

  afterEach(() => {
    db.close();
  });

  test("a turn the render filter hides is still readable in full on the raw axis", () => {
    // Hidden from the hit set...
    expect(searchMemory(db, { scope: "turns", query: "exact words" })).toEqual([]);

    // ...and reachable by direct address, which is what replay does.
    const raw = db
      .query<
        { userPrompt: string; assistantTranscript: string },
        [number, number]
      >(
        `SELECT user_prompt AS userPrompt, assistant_transcript AS assistantTranscript
         FROM turns WHERE session_id = ? AND prompt_number = ?`,
      )
      .get(sessionId, 1);
    expect(raw?.userPrompt).toBe("the exact words the user typed");
    expect(raw?.assistantTranscript).toBe("the full narration");

    const observations = db
      .query<{ toolInput: string; toolResult: string }, [number]>(
        `SELECT tool_input AS toolInput, tool_result AS toolResult
         FROM observations WHERE turn_id = ?`,
      )
      .all(turnId);
    expect(observations).toEqual([
      {
        toolInput: "rg --files-with-matches watchdog",
        toolResult: "src/worker/server.ts",
      },
    ]);
  });

  test("recall's direct turn address is unaffected by the hit-set filter", () => {
    const output = recallMemory(db, {
      id: `S${sessionId}/T1`,
      depth: "expanded",
    });
    expect(output).toContain("the exact words the user typed");
  });

  test("turn-detail.sh carries no turn-status predicate", () => {
    const script = readFileSync(
      join(REPO_ROOT, "plugin", "scripts", "turn-detail.sh"),
      "utf8",
    );
    expect(script).not.toMatch(/t\.status\s*=|turns[^;]*WHERE[^;]*status\s*=/i);
  });

  test("no replay source imports the segment/era rendering machinery", () => {
    for (const file of ["cli.ts", "parser.ts", "fields.ts", "format.ts"]) {
      const source = readFileSync(join(REPO_ROOT, "src", "replay", file), "utf8");
      expect(source).not.toContain("segment-era");
      expect(source).not.toContain("segment-rank");
      expect(source).not.toContain("segment-spine");
      expect(source).not.toContain("eraCutoffEpoch");
    }
  });
});
