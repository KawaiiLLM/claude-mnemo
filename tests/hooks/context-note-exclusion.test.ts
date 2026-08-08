import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { createContextHandler } from "../../src/hooks/handlers/context";
import type { NormalizedHookInput } from "../../src/hooks/types";

/**
 * A `note` call's observation is captured for the raw axis and withheld from
 * everything that reads observations as work content. The SessionStart context
 * counts observations twice — once for the global header, once per session —
 * and either count leaks the existence of the hidden row.
 */
const CWD = "/tmp/note-exclusion-project";

describe("session-start context withholds excluded observations", () => {
  let db: Database;
  let otherSessionId: number;

  function seedTurn(sessionId: number, promptNumber: number): number {
    return db
      .query<{ id: number }, [number, number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt, assistant_response,
           title, content, created_at_epoch
         ) VALUES (?, ?, 'extracted', 'do the work', 'done', 'A turn', 'body', 120)
         RETURNING id`,
      )
      .get(sessionId, promptNumber)!.id;
  }

  function seedObservation(turnId: number, excluded: boolean): void {
    db.query(
      `INSERT INTO observations (
         turn_id, tool_name, tool_input, tool_result, status, title, content,
         excluded_from_extraction, created_at_epoch
       ) VALUES (?, ?, '{}', 'ok', 'extracted', 'obs', 'body', ?, 121)`,
    ).run(turnId, excluded ? "mcp__mnemo__note" : "Edit", excluded ? 1 : 0);
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    const currentSessionId = upsertSession(db, {
      contentSessionId: "context-exclusion-current",
      project: CWD,
      title: "Current session",
      content: "Summary",
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 110,
      completedAtEpoch: null,
    }).id;
    otherSessionId = upsertSession(db, {
      contentSessionId: "context-exclusion-other",
      project: CWD,
      title: "Other session",
      content: "Summary",
      insight: null,
      createdAtEpoch: 90,
      updatedAtEpoch: 95,
      completedAtEpoch: null,
    }).id;

    // One real observation and one excluded `note` observation per session.
    for (const sessionId of [currentSessionId, otherSessionId]) {
      const turnId = seedTurn(sessionId, 1);
      seedObservation(turnId, false);
      seedObservation(turnId, true);
    }
  });

  afterEach(() => {
    db.close();
  });

  function input(): NormalizedHookInput {
    return {
      eventName: "SessionStart",
      source: "resume",
      sessionId: "context-exclusion-current",
      cwd: CWD,
      stopHookActive: false,
      raw: {},
    };
  }

  test("the header counts only extraction-visible observations", async () => {
    const output =
      (await createContextHandler({ db })(input())).hookSpecificOutput ?? "";

    // Four rows exist; two of them are `note` captures.
    expect(output).toContain("claude-mnemo: 2 sessions, 2 observations");
  });

  test("a recent session's observation count omits its note captures", async () => {
    const output =
      (await createContextHandler({ db }, "recent")(input()))
        .hookSpecificOutput ?? "";

    expect(output).toContain(`[S${otherSessionId}]`);
    expect(output).toContain("💡1");
    expect(output).not.toContain("💡2");
  });
});
