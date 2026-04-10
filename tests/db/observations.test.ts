import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  createObservation,
  getObservation,
  updateObservation,
} from "../../src/db/observations";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { saveTurn } from "../../src/db/turns";

describe("observation round trips", () => {
  let db: Database;
  let turnId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    const session = upsertSession(db, {
      contentSessionId: "observations-session",
      project: "claude-mnemo",
      title: "Observations",
      content: "Observation round-trip testing",
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    const turn = saveTurn(db, {
      sessionId: session.id,
      promptNumber: 1,
      userPrompt: "Record an observation",
      assistantResponse: "Done.",
      title: "Observation turn",
      content: "Turn content",
      insight: "- turn insight",
      filesRead: ["src/observations.ts"],
      filesModified: ["src/observations.ts"],
      createdAtEpoch: 120,
      updatedAtEpoch: null,
      observations: [],
    });

    turnId = turn.id;
  });

  afterEach(() => {
    db.close();
  });

  test("round-trips simplified observation data and only indexes extracted observations", () => {
    const created = createObservation(db, {
      turnId,
      toolName: "Read",
      toolInput: '{"file_path":"src/observations.ts"}',
      toolResult: "file contents",
      status: "pending",
      createdAtEpoch: 140,
    });

    const loaded = getObservation(db, created.id);
    const pendingFtsRow = db
      .query<{ layer: string; sourceId: number }, [number]>(
        "SELECT layer, source_id AS sourceId FROM memory_fts WHERE layer = 'observation' AND source_id = ?",
      )
      .get(created.id);
    const extracted = updateObservation(db, created.id, {
      title: "New observation columns",
      content: "Observation content",
      status: "extracted",
    });
    const extractedFtsRow = db
      .query<{ layer: string; sourceId: number }, [number]>(
        "SELECT layer, source_id AS sourceId FROM memory_fts WHERE layer = 'observation' AND source_id = ?",
      )
      .get(created.id);

    expect(loaded).not.toBeNull();
    expect(loaded?.toolName).toBe("Read");
    expect(loaded?.toolInput).toBe('{"file_path":"src/observations.ts"}');
    expect(loaded?.toolResult).toBe("file contents");
    expect(loaded?.status).toBe("pending");
    expect(loaded?.title).toBeNull();
    expect(loaded?.content).toBeNull();
    expect(pendingFtsRow).toBeNull();
    expect(extracted?.status).toBe("extracted");
    expect(extractedFtsRow).toEqual({ layer: "observation", sourceId: created.id });
  });
});
