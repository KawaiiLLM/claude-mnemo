import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  getObservation,
  getObservationsForTurn,
} from "../../src/db/observations";
import { initializeSchema } from "../../src/db/schema";
import { searchMemory } from "../../src/db/search";
import { upsertSession } from "../../src/db/sessions";
import { getTurn, saveTurn } from "../../src/db/turns";

describe("observation queries and search", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("retrieves observations for a turn and by observation id", () => {
    const session = upsertSession(db, {
      contentSessionId: "session-observation",
      project: "claude-mnemo",
      title: "Observation session",
      description: "For observation lookups",
      insight: "- observation indexing",
      startedAtEpoch: 100,
      updatedAtEpoch: 120,
      completedAtEpoch: 130,
    });

    saveTurn(db, {
      sessionId: session.id,
      promptNumber: 1,
      userPrompt: "Inspect the auth flow",
      assistantResponse: "I found the issue.",
      title: "Inspect auth",
      description: "Captured two observations",
      insight: null,
      filesRead: ["src/auth.ts"],
      filesModified: ["src/auth.ts"],
      createdAtEpoch: 140,
      updatedAtEpoch: 150,
      observations: [
        {
          type: "discovery",
          title: "Missing lock",
          description: "No mutex around refresh",
          narrative: "Refresh code lacked any guard against overlap.",
          facts: ["mutex absent"],
          concepts: ["gotcha"],
          filesRead: ["src/auth.ts"],
          filesModified: [],
        },
        {
          type: "decision",
          title: "Add retry",
          description: "Protect retries",
          narrative: "A retry path reduces transient auth failures.",
          facts: ["retry planned"],
          concepts: ["trade-off"],
          filesRead: ["src/auth.ts"],
          filesModified: ["src/auth.ts"],
        },
      ],
    });

    const turn = getTurn(db, session.id, 1);
    const observations = getObservationsForTurn(db, turn!.id);

    expect(observations).toHaveLength(2);
    expect(observations[0]?.title).toBe("Missing lock");
    expect(getObservation(db, observations[1]!.id)?.title).toBe("Add retry");
  });

  test("finds a keyword across sessions, turns, and observations", () => {
    const session = upsertSession(db, {
      contentSessionId: "session-search-1",
      project: "claude-mnemo",
      title: "Race archive",
      description: "Session about the auth race",
      insight: "- race captured at session level",
      startedAtEpoch: 200,
      updatedAtEpoch: 210,
      completedAtEpoch: 220,
    });

    saveTurn(db, {
      sessionId: session.id,
      promptNumber: 1,
      userPrompt: "Investigate auth race",
      assistantResponse: "I reproduced the race.",
      title: "Race diagnosis",
      description: "Turn records the race reproduction",
      insight: "- race visible in concurrent requests",
      filesRead: ["src/auth.ts"],
      filesModified: ["src/auth.ts"],
      createdAtEpoch: 230,
      updatedAtEpoch: 240,
      observations: [
        {
          type: "discovery",
          title: "Race reproduced",
          description: "Concurrent refreshes collide",
          narrative: "The race appears when multiple 401 responses refresh together.",
          facts: ["race confirmed"],
          concepts: ["problem-solution"],
          filesRead: ["src/auth.ts"],
          filesModified: [],
        },
      ],
    });

    const results = searchMemory(db, { query: "race" });

    expect(new Set(results.map((result) => result.layer))).toEqual(
      new Set(["session", "turn", "observation"]),
    );
  });

  test("filters keyword results by project", () => {
    upsertSession(db, {
      contentSessionId: "session-project-a",
      project: "claude-mnemo",
      title: "Shared keyword",
      description: "Project A session",
      insight: "- shared keyword",
      startedAtEpoch: 300,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    upsertSession(db, {
      contentSessionId: "session-project-b",
      project: "other-project",
      title: "Shared keyword",
      description: "Project B session",
      insight: "- shared keyword",
      startedAtEpoch: 310,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    const results = searchMemory(db, {
      query: "shared",
      project: "claude-mnemo",
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.project).toBe("claude-mnemo");
  });

  test("filters by observation type, file, and date range", () => {
    const session = upsertSession(db, {
      contentSessionId: "session-filter",
      project: "claude-mnemo",
      title: "Filtering session",
      description: "Filter coverage",
      insight: null,
      startedAtEpoch: 400,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    saveTurn(db, {
      sessionId: session.id,
      promptNumber: 1,
      userPrompt: "Apply auth fix",
      assistantResponse: "Applied the fix.",
      title: "Auth fix",
      description: "Fixing the issue",
      insight: null,
      filesRead: ["src/auth.ts"],
      filesModified: ["src/auth.ts"],
      createdAtEpoch: 410,
      updatedAtEpoch: 420,
      observations: [
        {
          type: "bugfix",
          title: "Auth mutex",
          description: "Adds the mutex",
          narrative: "The mutex now guards token refresh work.",
          facts: ["auth.ts updated"],
          concepts: ["problem-solution"],
          filesRead: ["src/auth.ts"],
          filesModified: ["src/auth.ts"],
        },
        {
          type: "decision",
          title: "Document follow-up",
          description: "Write migration note",
          narrative: "A follow-up note documents remaining cleanup.",
          facts: ["docs next"],
          concepts: ["pattern"],
          filesRead: ["docs/design.md"],
          filesModified: ["docs/design.md"],
        },
      ],
    });

    const results = searchMemory(db, {
      type: "bugfix",
      file: "src/auth.ts",
      fromEpoch: 405,
      toEpoch: 430,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.layer).toBe("observation");
    expect(results[0]?.title).toBe("Auth mutex");
  });

  test("returns recent sessions when no query is provided", () => {
    upsertSession(db, {
      contentSessionId: "session-recent-1",
      project: "claude-mnemo",
      title: "Oldest",
      description: "Old session",
      insight: null,
      startedAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    upsertSession(db, {
      contentSessionId: "session-recent-2",
      project: "claude-mnemo",
      title: "Newest",
      description: "New session",
      insight: null,
      startedAtEpoch: 500,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    upsertSession(db, {
      contentSessionId: "session-recent-3",
      project: "claude-mnemo",
      title: "Middle",
      description: "Middle session",
      insight: null,
      startedAtEpoch: 300,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    const results = searchMemory(db, {});

    expect(results.map((result) => result.title)).toEqual([
      "Newest",
      "Middle",
      "Oldest",
    ]);
    expect(new Set(results.map((result) => result.layer))).toEqual(
      new Set(["session"]),
    );
  });
});
