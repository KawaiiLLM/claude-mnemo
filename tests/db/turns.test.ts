import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import {
  getMaxPromptNumber,
  getTurnById,
  getTurn,
  getTurnsForSession,
  updateTurnBackfill,
  updateTurnById,
} from "../../src/db/turns";
import { getObservationsForTurn } from "../../src/db/observations";
import { saveTurnFixture as saveTurn } from "../support/turn-fixtures";

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
            title: Symbol("invalid") as unknown as string,
            content: "Invalid observation",
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
          title: "Temporary edit",
          content: "Applied an experimental change",
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

  test("updateTurnById can set transcriptLineStart", () => {
    const turn = saveTurn(db, {
      sessionId,
      promptNumber: 6,
      userPrompt: "Remember this prompt",
      assistantResponse: "Initial answer",
      title: "Remember this prompt",
      content: "Stored content",
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 600,
      updatedAtEpoch: 610,
      observations: [],
    });

    const updated = updateTurnById(db, turn.id, {
      transcriptLineStart: 7,
    });

    expect(updated?.transcriptLineStart).toBe(7);
    expect(getTurnById(db, turn.id)?.transcriptLineStart).toBe(7);
  });

  test("updateTurnBackfill skips an occupied contentPromptId instead of throwing", () => {
    const firstTurn = saveTurn(db, {
      sessionId,
      promptNumber: 7,
      userPrompt: "Earlier turn",
      assistantResponse: "Earlier answer",
      title: "Earlier turn",
      content: "Earlier content",
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 700,
      updatedAtEpoch: 710,
      observations: [],
    });
    db.query(
      "UPDATE turns SET content_prompt_id = ? WHERE id = ?",
    ).run("pid-occupied", firstTurn.id);

    const latestTurn = saveTurn(db, {
      sessionId,
      promptNumber: 8,
      userPrompt: "Latest turn",
      assistantResponse: null,
      title: null,
      content: null,
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 800,
      updatedAtEpoch: null,
      observations: [],
    });

    expect(() =>
      updateTurnBackfill(
        db,
        latestTurn.id,
        "Latest answer",
        0,
        "pid-occupied",
        42,
      ),
    ).not.toThrow();

    const updated = getTurnById(db, latestTurn.id);
    expect(updated?.assistantResponse).toBe("Latest answer");
    expect(updated?.contentPromptId).toBeNull();
    expect(updated?.transcriptLineStart).toBe(42);
  });

  test("getMaxPromptNumber returns null for an empty session", () => {
    expect(getMaxPromptNumber(db, sessionId)).toBeNull();
  });

  test("getMaxPromptNumber returns the highest prompt number", () => {
    saveTurn(db, {
      sessionId,
      promptNumber: 3,
      userPrompt: "Third prompt",
      assistantResponse: "Third answer",
      title: "Third prompt",
      content: "Third content",
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 900,
      updatedAtEpoch: 910,
      observations: [],
    });

    saveTurn(db, {
      sessionId,
      promptNumber: 11,
      userPrompt: "Eleventh prompt",
      assistantResponse: "Eleventh answer",
      title: "Eleventh prompt",
      content: "Eleventh content",
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 1100,
      updatedAtEpoch: 1110,
      observations: [],
    });

    saveTurn(db, {
      sessionId,
      promptNumber: 7,
      userPrompt: "Seventh prompt",
      assistantResponse: "Seventh answer",
      title: "Seventh prompt",
      content: "Seventh content",
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 1000,
      updatedAtEpoch: 1010,
      observations: [],
    });

    expect(getMaxPromptNumber(db, sessionId)).toBe(11);
  });

  test("updateTurnById accepts the new provisional and failed statuses", () => {
    const turn = saveTurn(db, {
      sessionId,
      promptNumber: 20,
      userPrompt: "Status test prompt",
      assistantResponse: "Status test reply",
      title: "Status test",
      content: "Testing new statuses",
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 2000,
      updatedAtEpoch: null,
      observations: [],
    });

    expect(updateTurnById(db, turn.id, { status: "provisional" })?.status).toBe("provisional");
    expect(updateTurnById(db, turn.id, { status: "failed" })?.status).toBe("failed");
  });

  test("metadata-only update on an active turn with no content stays active", () => {
    // create an ACTIVE turn (no title/content) via direct SQL, same pattern used in merge tests
    const turnId = db
      .query<{ id: number }, [number]>(
        `INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch)
         VALUES (?, 30, 'active', 'Some prompt', 3000)
         RETURNING id`,
      )
      .get(sessionId)!.id;

    const updated = updateTurnById(db, turnId, { toolCallCount: 3 });
    expect(updated?.status).toBe("active");
  });

  test("auto-promote still fires when title is provided", () => {
    const turnId = db
      .query<{ id: number }, [number]>(
        `INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch)
         VALUES (?, 31, 'active', 'Some prompt', 3100)
         RETURNING id`,
      )
      .get(sessionId)!.id;

    const updated = updateTurnById(db, turnId, { title: "Did a thing" });
    expect(updated?.status).toBe("extracted");
  });

});
