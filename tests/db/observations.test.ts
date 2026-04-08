import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { createObservation, getObservation } from "../../src/db/observations";
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
      description: "Observation round-trip testing",
      insight: null,
      startedAtEpoch: 100,
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

  test("round-trips the new observation columns and FTS payload", () => {
    const created = createObservation(db, {
      turnId,
      type: "discovery",
      title: "New observation columns",
      content: "Observation content",
      insight: "Observation insight",
      tags: ["auth", "cache"],
      filesRead: ["src/observations.ts"],
      filesModified: ["src/observations.ts"],
      createdAtEpoch: 140,
    });

    const loaded = getObservation(db, created.id);
    const ftsRow = db
      .query<{ layer: string; sourceId: number }, [number]>(
        "SELECT layer, source_id AS sourceId FROM memory_fts WHERE layer = 'observation' AND source_id = ?",
      )
      .get(created.id);

    expect(loaded).not.toBeNull();
    expect(loaded?.content).toBe("Observation content");
    expect(loaded?.description).toBe("Observation content");
    expect(loaded?.insight).toBe("Observation insight");
    expect(loaded?.narrative).toBe("Observation insight");
    expect(loaded?.tags).toEqual(["auth", "cache"]);
    expect(loaded?.concepts).toEqual(["auth", "cache"]);
    expect(loaded?.filesRead).toEqual(["src/observations.ts"]);
    expect(loaded?.filesModified).toEqual(["src/observations.ts"]);
    expect(ftsRow).toEqual({ layer: "observation", sourceId: created.id });
  });
});
