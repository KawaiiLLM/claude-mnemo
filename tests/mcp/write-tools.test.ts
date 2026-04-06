import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { getObservationsForTurn } from "../../src/db/observations";
import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { getSession, upsertSession } from "../../src/db/sessions";
import { getTurn } from "../../src/db/turns";
import { saveTurnTool } from "../../src/mcp/save-turn";
import { updateSessionTool } from "../../src/mcp/update-session";

describe("MCP write tools", () => {
  let db: Database;
  let sessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    sessionId = upsertSession(db, {
      contentSessionId: "session-write-tools",
      project: "claude-mnemo",
      title: "Before update",
      description: "Initial session summary",
      insight: "- initial insight",
      startedAtEpoch: 100,
      updatedAtEpoch: 110,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("saveTurnTool persists extracted content and observations", () => {
    const result = saveTurnTool(db, {
      session_id: sessionId,
      prompt_number: 1,
      user_prompt: "Fix the auth race",
      assistant_response: "Added a mutex and coverage.",
      title: "Fix auth race",
      description: "Persists the extracted turn",
      insight: "- regression covered",
      files_read: ["src/auth.ts"],
      files_modified: ["src/auth.ts", "tests/auth.test.ts"],
      created_at_epoch: 200,
      updated_at_epoch: 210,
      observations: [
        {
          type: "bugfix",
          title: "Auth mutex",
          description: "Guards refresh",
          narrative: "Refresh work now serializes correctly.",
          facts: ["mutex added"],
          concepts: ["problem-solution"],
          files_read: ["src/auth.ts"],
          files_modified: ["src/auth.ts"],
        },
      ],
    });

    const turn = getTurn(db, sessionId, 1)!;
    const observations = getObservationsForTurn(db, turn.id);

    expect(result.content[0]?.text).toContain("Saved turn #1");
    expect(turn.status).toBe("extracted");
    expect(turn.title).toBe("Fix auth race");
    expect(observations).toHaveLength(1);
    expect(observations[0]?.title).toBe("Auth mutex");
  });

  test("saveTurnTool uses skip semantics when content is empty", () => {
    saveTurnTool(db, {
      session_id: sessionId,
      prompt_number: 2,
      user_prompt: "Thanks",
      assistant_response: "You're welcome.",
      created_at_epoch: 220,
    });

    const turn = getTurn(db, sessionId, 2)!;

    expect(turn.status).toBe("skipped");
    expect(getObservationsForTurn(db, turn.id)).toHaveLength(0);
  });

  test("updateSessionTool updates the session summary", () => {
    const result = updateSessionTool(db, {
      session_id: sessionId,
      title: "After update",
      description: "Updated session summary",
      insight: "- updated insight",
      completed_at_epoch: 300,
    });

    const session = getSession(db, sessionId)!;

    expect(result.content[0]?.text).toContain(`Updated session ${sessionId}`);
    expect(session.title).toBe("After update");
    expect(session.description).toBe("Updated session summary");
    expect(session.insight).toBe("- updated insight");
    expect(session.completedAtEpoch).toBe(300);
  });
});
