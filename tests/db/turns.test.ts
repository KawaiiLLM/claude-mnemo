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
  getStrandedTurns,
  resetTurnExtractionFields,
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
    // Skipped means "not worth rendering", never "unfindable": the captured
    // prompt and response stay indexed (spec D11).
    expect(ftsCount).toBe(1);
  });

  test("supports explicit undone status by clearing observations while retaining the turn row and its index entry", () => {
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
    // The observation rows are gone (so their index rows go too), but the turn
    // row survives and stays indexed — status drives rendering, not ingest.
    expect(ftsCount).toBe(1);
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

  test("updateTurnById returns assistantTranscript in the updated record", () => {
    const turn = saveTurn(db, {
      sessionId,
      promptNumber: 8,
      userPrompt: "Multi-step prompt",
      assistantResponse: "Final block",
      title: "Multi-step prompt",
      content: "Stored content",
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 800,
      updatedAtEpoch: 810,
      observations: [],
    });
    updateTurnBackfill(
      db,
      turn.id,
      "Final block",
      0,
      undefined,
      undefined,
      "Full narration across blocks",
    );
    // The value is stored (TURN_SELECT reads it) ...
    expect(getTurnById(db, turn.id)?.assistantTranscript).toBe(
      "Full narration across blocks",
    );

    // ... and the RETURNING clause of updateTurnById must surface it too.
    const updated = updateTurnById(db, turn.id, { title: "Retitled" });
    expect(updated?.assistantTranscript).toBe("Full narration across blocks");
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

  test("resetTurnExtractionFields clears agent output, keeps internal tags, re-indexes originals", () => {
    // Insert a provisional turn with partial extraction output and an assistant_response
    const turnId = db
      .query<{ id: number }, [number]>(
        `INSERT INTO turns (session_id, prompt_number, status, assistant_response, title, content, insight, type, created_at_epoch)
         VALUES (?, 50, 'provisional', 'r', 'Old title', 'Old content', 'Old insight', '["feature"]', 5000)
         RETURNING id`,
      )
      .get(sessionId)!.id;

    // Set tags: one freeform + one colon-namespaced internal tag
    updateTurnById(db, turnId, { replaceTags: ["auth", "delivery:dropped:notify-pending"] });

    // Seed an FTS row directly to simulate the turn having been indexed
    db.query(
      "INSERT INTO memory_fts (layer, source_id, title, content, extra) VALUES ('turn', ?, 'Old title', 'Old content', '')",
    ).run(turnId);

    resetTurnExtractionFields(db, turnId, 1234);

    const t = getTurnById(db, turnId)!;
    expect(t.status).toBe("active");
    expect(t.title).toBeNull();
    expect(t.content).toBeNull();
    expect(t.insight).toBeNull();
    expect(t.type).toEqual([]);
    expect(t.tags).toEqual(["delivery:dropped:notify-pending"]); // freeform dropped, internal kept
    expect(t.assistantResponse).toBe("r");                       // source kept
    // The extraction fields leave the index, but the captured originals stay:
    // FTS ingest is status-blind (spec D11), so the row is re-indexed, not dropped.
    const fts = db
      .query("SELECT title, content, extra, response FROM memory_fts WHERE layer='turn' AND source_id=?")
      .get(turnId) as { title: string | null; content: string | null; extra: string; response: string };
    expect(fts.title).toBeNull();
    expect(fts.content).toBeNull();
    expect(fts.extra).toBe("");
    expect(fts.response).toBe("r");
  });

  test("getStrandedTurns selects re-extractable failures in prompt_number order", () => {
    const insert = db.query<{ id: number }, [number, number, string, string | null, string | null, string | null]>(
      `INSERT INTO turns (session_id, prompt_number, status, assistant_response, title, content, created_at_epoch)
       VALUES (?, ?, ?, ?, ?, ?, 1000)
       RETURNING id`,
    );

    // p1 active, assistant_response='r' -> INCLUDED
    const p1id = insert.get(sessionId, 1, "active", "r", null, null)!.id;
    // p2 provisional, assistant_response='r' -> INCLUDED
    const p2id = insert.get(sessionId, 2, "provisional", "r", null, null)!.id;
    // p3 extracted, title=NULL, content=NULL, resp='r' -> INCLUDED (phantom)
    const p3id = insert.get(sessionId, 3, "extracted", "r", null, null)!.id;
    // p4 extracted, title='ok', content='c', resp='r' -> excluded (valid)
    insert.get(sessionId, 4, "extracted", "r", "ok", "c");
    // p5 skipped, resp='r' -> excluded
    insert.get(sessionId, 5, "skipped", "r", null, null);
    // p6 failed, resp='r' -> excluded (terminal)
    insert.get(sessionId, 6, "failed", "r", null, null);
    // p7 active, assistant_response=NULL -> excluded (nothing to extract)
    db.query(
      `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch)
       VALUES (?, 7, 'active', 1000)`,
    ).run(sessionId);
    // p8 extracted, title='t', content=NULL, resp='r' -> excluded (title-only is valid)
    insert.get(sessionId, 8, "extracted", "r", "t", null);

    const ids = getStrandedTurns(db, sessionId).map((t) => t.id);
    expect(ids).toEqual([p1id, p2id, p3id]);
  });

});
