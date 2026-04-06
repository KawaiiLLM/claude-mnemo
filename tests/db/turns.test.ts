import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import {
  getPendingTurns,
  getTurn,
  getTurnsForSession,
  markTurnsStale,
  saveTurn,
} from "../../src/db/turns";

describe("turn queries", () => {
  let db: Database;
  let sessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    sessionId = upsertSession(db, {
      contentSessionId: "content-turns",
      project: "claude-mnemo",
      title: "Turns",
      description: "Turn testing",
      insight: null,
      startedAtEpoch: 1,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("saves a turn and observations atomically", () => {
    saveTurn(db, {
      sessionId,
      promptNumber: 1,
      userPrompt: "Fix the race condition in auth",
      assistantResponse: "I added a mutex and retry logic.",
      title: "Fix auth race",
      description: "Added locking around token refresh",
      insight: "- lock prevents overlapping refreshes",
      filesRead: ["src/auth.ts"],
      filesModified: ["src/auth.ts", "tests/auth.test.ts"],
      createdAtEpoch: 100,
      updatedAtEpoch: 120,
      observations: [
        {
          type: "bugfix",
          title: "Added mutex",
          description: "Serialized refresh calls",
          narrative: "Refresh requests now wait on a shared promise.",
          facts: ["race reproduced", "mutex added"],
          concepts: ["problem-solution", "trade-off"],
          filesRead: ["src/auth.ts"],
          filesModified: ["src/auth.ts"],
        },
        {
          type: "discovery",
          title: "Found overlap",
          description: "Parallel requests collided",
          narrative: "Concurrent 401 handling triggered duplicate refresh work.",
          facts: ["Promise.all reproduces issue"],
          concepts: ["gotcha"],
          filesRead: ["tests/auth.test.ts"],
          filesModified: [],
        },
      ],
    });

    const turn = getTurn(db, sessionId, 1);
    const observationCount = db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM observations")
      .get().count;
    const ftsCount = db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM memory_fts WHERE layer IN ('turn', 'observation')",
      )
      .get().count;

    expect(turn?.status).toBe("extracted");
    expect(turn?.userPrompt).toBe("Fix the race condition in auth");
    expect(turn?.assistantResponse).toBe("I added a mutex and retry logic.");
    expect(turn?.filesRead).toEqual(["src/auth.ts"]);
    expect(turn?.filesModified).toEqual(["src/auth.ts", "tests/auth.test.ts"]);
    expect(observationCount).toBe(2);
    expect(ftsCount).toBe(3);
  });

  test("rolls back the turn when observation insert fails", () => {
    expect(() => {
      saveTurn(db, {
        sessionId,
        promptNumber: 2,
        userPrompt: "Break it",
        assistantResponse: "This should fail.",
        title: "Broken turn",
        description: "Should not persist",
        insight: null,
        filesRead: [],
        filesModified: [],
        createdAtEpoch: 200,
        updatedAtEpoch: null,
        observations: [
          {
            type: "bugfix",
            title: null as unknown as string,
            description: "Invalid observation",
            narrative: "This should violate the schema.",
            facts: [],
            concepts: [],
            filesRead: [],
            filesModified: [],
          },
        ],
      });
    }).toThrow();

    expect(getTurn(db, sessionId, 2)).toBeNull();
  });

  test("uses the skip convention when no memory content is provided", () => {
    const turn = saveTurn(db, {
      sessionId,
      promptNumber: 3,
      userPrompt: "Just saying thanks",
      assistantResponse: "You're welcome.",
      title: null,
      description: null,
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 300,
      updatedAtEpoch: null,
      observations: [],
    });

    const ftsCount = db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM memory_fts WHERE layer = 'turn' AND source_id = ?",
      )
      .get(turn.id).count;

    expect(turn.status).toBe("skipped");
    expect(getTurnsForSession(db, sessionId)).toHaveLength(1);
    expect(ftsCount).toBe(0);
  });

  test("re-extracts stale turns by replacing observations and FTS rows", () => {
    const firstSave = saveTurn(db, {
      sessionId,
      promptNumber: 4,
      userPrompt: "Investigate auth race",
      assistantResponse: "I found the cause.",
      title: "Investigate auth",
      description: "Initial extraction",
      insight: "- first pass",
      filesRead: ["src/auth.ts"],
      filesModified: [],
      createdAtEpoch: 400,
      updatedAtEpoch: 410,
      observations: [
        {
          type: "discovery",
          title: "Initial finding",
          description: "First observation",
          narrative: "Original extraction result.",
          facts: ["first"],
          concepts: ["what-changed"],
          filesRead: ["src/auth.ts"],
          filesModified: [],
        },
      ],
    });

    markTurnsStale(db, sessionId, [4]);

    const secondSave = saveTurn(db, {
      sessionId,
      promptNumber: 4,
      userPrompt: "Investigate auth race",
      assistantResponse: "I found the cause and fixed it.",
      title: "Fix auth race",
      description: "Updated extraction",
      insight: "- second pass",
      filesRead: ["src/auth.ts", "tests/auth.test.ts"],
      filesModified: ["src/auth.ts"],
      createdAtEpoch: 400,
      updatedAtEpoch: 430,
      observations: [
        {
          type: "bugfix",
          title: "Final fix",
          description: "Updated observation",
          narrative: "Replaced the original observation with the final fix.",
          facts: ["second"],
          concepts: ["problem-solution"],
          filesRead: ["src/auth.ts"],
          filesModified: ["src/auth.ts"],
        },
        {
          type: "decision",
          title: "Added test",
          description: "Protected regression",
          narrative: "Regression coverage now verifies concurrent refresh calls.",
          facts: ["test added"],
          concepts: ["pattern"],
          filesRead: ["tests/auth.test.ts"],
          filesModified: ["tests/auth.test.ts"],
        },
      ],
    });

    const observationTitles = db
      .query<{ title: string }, []>("SELECT title FROM observations ORDER BY id")
      .all()
      .map((row) => row.title);
    const ftsCount = db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM memory_fts WHERE layer IN ('turn', 'observation')",
      )
      .get().count;

    expect(secondSave.id).toBe(firstSave.id);
    expect(secondSave.status).toBe("extracted");
    expect(observationTitles).toEqual(["Final fix", "Added test"]);
    expect(ftsCount).toBe(3);
  });

  test("marks turns stale and returns pending work in prompt order", () => {
    db.query(
      "INSERT INTO turns (session_id, prompt_number, status, created_at_epoch) VALUES (?, ?, ?, ?)",
    ).run(sessionId, 5, "pending", 500);

    saveTurn(db, {
      sessionId,
      promptNumber: 6,
      userPrompt: "Another turn",
      assistantResponse: "Done",
      title: "Another turn",
      description: "Extracted turn",
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 600,
      updatedAtEpoch: null,
      observations: [],
    });

    markTurnsStale(db, sessionId, [6]);

    const pendingTurns = getPendingTurns(db, sessionId);

    expect(pendingTurns.map((turn) => [turn.promptNumber, turn.status])).toEqual([
      [5, "pending"],
      [6, "stale"],
    ]);
  });
});
