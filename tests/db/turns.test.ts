import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import {
  getTurn,
  getTurnsForSession,
  saveTurn,
} from "../../src/db/turns";
import { getObservationsForTurn } from "../../src/db/observations";

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
      content: "Turn testing",
      insight: null,
      createdAtEpoch: 1,
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
      content: "Added locking around token refresh",
      insight: "- lock prevents overlapping refreshes",
      filesRead: ["src/auth.ts"],
      filesModified: ["src/auth.ts", "tests/auth.test.ts"],
      createdAtEpoch: 100,
      updatedAtEpoch: 120,
      observations: [
        {
          title: "Added mutex",
          content: "Serialized refresh calls",
        },
        {
          title: "Found overlap",
          content: "Parallel requests collided",
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

  test("allows simplified observation payloads without legacy metadata", () => {
    const turn = saveTurn(db, {
      sessionId,
      promptNumber: 4,
      userPrompt: "Inspect auth flow",
      assistantResponse: "Read the file.",
      title: "Inspect auth flow",
      content: "Captured a lightweight observation",
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 400,
      updatedAtEpoch: null,
      observations: [
        {
          title: "Read auth module",
          content: "Inspected refresh handling.",
        },
      ],
    });

    const observation = getObservationsForTurn(db, turn.id)[0]!;

    expect(observation.title).toBe("Read auth module");
    expect(observation.content).toBe("Inspected refresh handling.");
    expect(observation.insight).toBeNull();
    expect(observation.tags).toEqual([]);
    expect(observation.filesRead).toEqual([]);
    expect(observation.filesModified).toEqual([]);
  });

  test("rolls back the turn when observation insert fails", () => {
    expect(() => {
      saveTurn(db, {
        sessionId,
        promptNumber: 2,
        userPrompt: "Break it",
        assistantResponse: "This should fail.",
        title: "Broken turn",
        content: "Should not persist",
        insight: null,
        filesRead: [],
        filesModified: [],
        createdAtEpoch: 200,
        updatedAtEpoch: null,
        observations: [
          {
            type: "bugfix",
            title: Symbol("invalid") as unknown as string,
            content: "Invalid observation",
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
      content: null,
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

  test("supports explicit undone status by clearing observations and FTS while retaining the turn row", () => {
    const firstSave = saveTurn(db, {
      sessionId,
      promptNumber: 5,
      userPrompt: "Try an approach that gets undone",
      assistantResponse: "Initial branch response",
      title: "Initial branch",
      content: "A branch that later gets undone",
      insight: "- temporary branch",
      filesRead: ["src/auth.ts"],
      filesModified: ["src/auth.ts"],
      createdAtEpoch: 500,
      updatedAtEpoch: 510,
      observations: [
        {
          type: "change",
          title: "Temporary edit",
          content: "Applied an experimental change",
          insight: "This branch was later abandoned.",
          tags: ["trade-off"],
          filesRead: ["src/auth.ts"],
          filesModified: ["src/auth.ts"],
        },
      ],
    });

    const secondSave = saveTurn(db, {
      sessionId,
      promptNumber: 5,
      status: "undone",
      userPrompt: "Try an approach that gets undone",
      assistantResponse: "Initial branch response",
      title: null,
      content: null,
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 500,
      updatedAtEpoch: 520,
      observations: [],
    });

    const observationCount = db
      .query<{ count: number }, [number]>(
        "SELECT COUNT(*) AS count FROM observations WHERE turn_id = ?",
      )
      .get(secondSave.id).count;
    const ftsCount = db
      .query<{ count: number }, [number]>(
        "SELECT COUNT(*) AS count FROM memory_fts WHERE layer IN ('turn', 'observation') AND source_id = ?",
      )
      .get(secondSave.id).count;

    expect(secondSave.id).toBe(firstSave.id);
    expect(secondSave.status).toBe("undone");
    expect(observationCount).toBe(0);
    expect(ftsCount).toBe(0);
  });

});
