import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { createMemory } from "../../src/db/memories";
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
      content: "For observation lookups",
      insight: "- observation indexing",
      createdAtEpoch: 100,
      updatedAtEpoch: 120,
      completedAtEpoch: 130,
    });

    saveTurn(db, {
      sessionId: session.id,
      promptNumber: 1,
      userPrompt: "Inspect the auth flow",
      assistantResponse: "I found the issue.",
      title: "Inspect auth",
      content: "Captured two observations",
      insight: null,
      filesRead: ["src/auth.ts"],
      filesModified: ["src/auth.ts"],
      createdAtEpoch: 140,
      updatedAtEpoch: 150,
      observations: [
        {
          type: "discovery",
          title: "Missing lock",
          content: "No mutex around refresh",
          insight: "Refresh code lacked any guard against overlap.",
          tags: ["gotcha"],
          filesRead: ["src/auth.ts"],
          filesModified: [],
        },
        {
          type: "decision",
          title: "Add retry",
          content: "Protect retries",
          insight: "A retry path reduces transient auth failures.",
          tags: ["trade-off"],
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
      content: "Session about the auth race",
      insight: "- race captured at session level",
      createdAtEpoch: 200,
      updatedAtEpoch: 210,
      completedAtEpoch: 220,
    });

    saveTurn(db, {
      sessionId: session.id,
      promptNumber: 1,
      userPrompt: "Investigate auth race",
      assistantResponse: "I reproduced the race.",
      title: "Race diagnosis",
      content: "Turn records the race reproduction",
      insight: "- race visible in concurrent requests",
      filesRead: ["src/auth.ts"],
      filesModified: ["src/auth.ts"],
      createdAtEpoch: 230,
      updatedAtEpoch: 240,
      observations: [
        {
          type: "discovery",
          title: "Race reproduced",
          content: "Concurrent refreshes collide",
          insight: "The race appears when multiple 401 responses refresh together.",
          tags: ["problem-solution"],
          filesRead: ["src/auth.ts"],
          filesModified: [],
        },
      ],
    });

    createMemory(db, {
      type: "feedback",
      scope: "global",
      title: "Avoid auth refresh races",
      content: "Use a mutex for auth refresh race handling.",
      reasoning: "Parallel refresh race work collides without coordination.",
      application: "When auth middleware updates tokens.",
      tags: ["auth", "concurrency"],
      createdAtEpoch: 250,
      updatedAtEpoch: null,
      sourceTurnId: null,
      status: "active",
      supersededBy: null,
      expiresAtEpoch: null,
    });

    const results = searchMemory(db, { query: "race" });

    expect(new Set(results.map((result) => result.layer))).toEqual(
      new Set(["session", "turn", "observation", "memory"]),
    );
  });

  test("supports scoped memory search by type, project, and query", () => {
    createMemory(db, {
      type: "feedback",
      scope: "claude-mnemo",
      title: "Prefer mutex over debounce",
      content: "Use a mutex for auth refresh coordination.",
      reasoning: "Debounce still allows stale shared state.",
      application: "When multiple requests may refresh together.",
      tags: ["auth", "concurrency"],
      createdAtEpoch: 600,
      updatedAtEpoch: null,
      sourceTurnId: null,
      status: "active",
      supersededBy: null,
      expiresAtEpoch: null,
    });

    createMemory(db, {
      type: "feedback",
      scope: "other-project",
      title: "Other project memory",
      content: "Mutex note that should not match project filtering.",
      reasoning: null,
      application: null,
      tags: [],
      createdAtEpoch: 610,
      updatedAtEpoch: null,
      sourceTurnId: null,
      status: "active",
      supersededBy: null,
      expiresAtEpoch: null,
    });

    createMemory(db, {
      type: "reference",
      scope: "claude-mnemo",
      title: "Reference note",
      content: "This is a reference memory, not feedback.",
      reasoning: null,
      application: null,
      tags: [],
      createdAtEpoch: 620,
      updatedAtEpoch: null,
      sourceTurnId: null,
      status: "active",
      supersededBy: null,
      expiresAtEpoch: null,
    });

    const results = searchMemory(db, {
      scope: "memories",
      type: "feedback",
      project: "claude-mnemo",
      query: "mutex",
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.layer).toBe("memory");
    expect(results[0]?.project).toBe("claude-mnemo");
    expect(results[0]?.type).toBe("feedback");
    expect(results[0]?.title).toBe("Prefer mutex over debounce");
  });

  test("filters keyword results by project", () => {
    upsertSession(db, {
      contentSessionId: "session-project-a",
      project: "claude-mnemo",
      title: "Shared keyword",
      content: "Project A session",
      insight: "- shared keyword",
      createdAtEpoch: 300,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    upsertSession(db, {
      contentSessionId: "session-project-b",
      project: "other-project",
      title: "Shared keyword",
      content: "Project B session",
      insight: "- shared keyword",
      createdAtEpoch: 310,
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
      content: "Filter coverage",
      insight: null,
      createdAtEpoch: 400,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    saveTurn(db, {
      sessionId: session.id,
      promptNumber: 1,
      userPrompt: "Apply auth fix",
      assistantResponse: "Applied the fix.",
      title: "Auth fix",
      content: "Fixing the issue",
      insight: null,
      filesRead: ["src/auth.ts"],
      filesModified: ["src/auth.ts"],
      createdAtEpoch: 410,
      updatedAtEpoch: 420,
      observations: [
        {
          type: "bugfix",
          title: "Auth mutex",
          content: "Adds the mutex",
          insight: "The mutex now guards token refresh work.",
          tags: ["problem-solution"],
          filesRead: ["src/auth.ts"],
          filesModified: ["src/auth.ts"],
        },
        {
          type: "decision",
          title: "Document follow-up",
          content: "Write migration note",
          insight: "A follow-up note documents remaining cleanup.",
          tags: ["pattern"],
          filesRead: ["docs/design.md"],
          filesModified: ["docs/design.md"],
        },
      ],
    });

    const results = searchMemory(db, {
      type: "bugfix",
      file: "src/auth.ts",
      after: 405,
      before: 430,
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
      content: "Old session",
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    upsertSession(db, {
      contentSessionId: "session-recent-2",
      project: "claude-mnemo",
      title: "Newest",
      content: "New session",
      insight: null,
      createdAtEpoch: 500,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    upsertSession(db, {
      contentSessionId: "session-recent-3",
      project: "claude-mnemo",
      title: "Middle",
      content: "Middle session",
      insight: null,
      createdAtEpoch: 300,
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
