import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  createObservation,
  getObservation,
  getObservationsForTurn,
  updateObservation,
} from "../../src/db/observations";
import { initializeSchema } from "../../src/db/schema";
import { searchMemory } from "../../src/db/search";
import { upsertSession } from "../../src/db/sessions";
import { getTurn } from "../../src/db/turns";
import { saveTurnFixture as saveTurn } from "../support/turn-fixtures";

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
          title: "Missing lock",
          content: "No mutex around refresh",
        },
        {
          title: "Add retry",
          content: "Protect retries",
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
          title: "Race reproduced",
          content: "Concurrent refreshes collide",
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

  test("only returns extracted observations in search and exposes simplified observation data", () => {
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

    const turn = saveTurn(db, {
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
      observations: [],
    });
    const pendingObservation = createObservation(db, {
      turnId: turn.id,
      toolName: "Read",
      toolInput: '{"file_path":"src/auth.ts"}',
      toolResult: "file contents",
      createdAtEpoch: 425,
    });
    const extractedObservation = createObservation(db, {
      turnId: turn.id,
      toolName: "Read",
      toolInput: '{"file_path":"src/auth.ts"}',
      toolResult: "file contents",
      createdAtEpoch: 426,
    });
    updateObservation(db, extractedObservation.id, {
      title: "Auth mutex",
      content: "Adds the mutex",
      status: "extracted",
    });

    const results = searchMemory(db, {
      scope: "observations",
      query: "mutex",
      after: 405,
      before: 430,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.layer).toBe("observation");
    expect(results[0]?.title).toBe("Auth mutex");
    expect(results[0]?.type).toBeNull();
    expect(results[0]?.filesRead).toEqual([]);
    expect(results[0]?.filesModified).toEqual([]);
    expect(results[0]?.observationId).toBe(extractedObservation.id);
    expect(results[0]?.observationId).not.toBe(pendingObservation.id);
  });

  test("finds a turn by a Chinese substring of its user prompt via trigram", () => {
    const session = upsertSession(db, {
      contentSessionId: "session-cjk",
      project: "claude-mnemo",
      title: "Cookie auth investigation",
      content: "English summary only",
      insight: null,
      createdAtEpoch: 600,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    saveTurn(db, {
      sessionId: session.id,
      promptNumber: 1,
      userPrompt: "哔哩哔哩 浏览器插件 登录测试",
      assistantResponse: "Investigated CookieCloud auth.",
      title: "Cookie auth",
      content: "English turn summary",
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 610,
      updatedAtEpoch: 620,
      observations: [],
    });

    expect(searchMemory(db, { query: "哔哩哔哩" }).some((r) => r.layer === "turn")).toBe(true);
    expect(searchMemory(db, { query: "浏览器" }).some((r) => r.layer === "turn")).toBe(true);
    expect(searchMemory(db, { query: "登录" })).toHaveLength(0);
  });

  test("appending a non-co-occurring term does not drop results (OR semantics)", () => {
    const session = upsertSession(db, {
      contentSessionId: "session-or",
      project: "claude-mnemo",
      title: "Race archive",
      content: "Session about the auth race",
      insight: null,
      createdAtEpoch: 700,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
    saveTurn(db, {
      sessionId: session.id,
      promptNumber: 1,
      userPrompt: "race details",
      assistantResponse: "reproduced",
      title: "Race diagnosis",
      content: "the race reproduction",
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 710,
      updatedAtEpoch: 720,
      observations: [],
    });

    const single = searchMemory(db, { query: "race" });
    const widened = searchMemory(db, { query: "race zzzznotpresent" });

    expect(single.length).toBeGreaterThan(0);
    expect(widened.length).toBeGreaterThanOrEqual(single.length);
  });

  test("≤2-char Latin tokens are an accepted regression; 3+ char still matches", () => {
    const session = upsertSession(db, {
      contentSessionId: "session-short-latin",
      project: "claude-mnemo",
      title: "UI API DB layer",
      content: "covers UI, the API surface, and the DB",
      insight: null,
      createdAtEpoch: 630,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
    void session;

    expect(searchMemory(db, { query: "UI" })).toHaveLength(0);
    expect(searchMemory(db, { query: "DB" })).toHaveLength(0);
    expect(searchMemory(db, { query: "API" }).some((r) => r.layer === "session")).toBe(true);
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
