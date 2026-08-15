import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { searchMemory } from "../../src/db/search";
import { saveTurnFixture as saveTurn } from "../support/turn-fixtures";

describe("searchMemory query escaping", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    const session = upsertSession(db, {
      contentSessionId: "session-search",
      project: "claude-mnemo",
      title: "foo:bar auth issue",
      content: "Tracks foo:bar namespace failures",
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    saveTurn(db, {
      sessionId: session.id,
      promptNumber: 1,
      userPrompt: "Investigate foo:bar auth issue",
      assistantResponse: "The foo:bar namespace is missing a lookup.",
      title: "Inspect foo:bar lookup",
      content: "Verified the namespaced key path",
      insight: null,
      filesRead: ["src/auth.ts"],
      filesModified: [],
      createdAtEpoch: 110,
      updatedAtEpoch: null,
      observations: [],
    });
  });

  afterEach(() => {
    db.close();
  });

  test("treats punctuation-bearing free text as a literal search", () => {
    expect(() => searchMemory(db, { query: "foo:bar" })).not.toThrow();
    expect(searchMemory(db, { query: "foo:bar" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          layer: "session",
          title: "foo:bar auth issue",
        }),
        expect.objectContaining({
          layer: "turn",
          title: "Inspect foo:bar lookup",
        }),
      ]),
    );
  });
});

describe("searchMemory tag filter", () => {
  let db: Database;
  let sessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    const session = upsertSession(db, {
      contentSessionId: "session-tags",
      project: "claude-mnemo",
      title: "Tag filter session",
      content: "Holds a tagged turn",
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
    sessionId = session.id;

    saveTurn(db, {
      sessionId: session.id,
      promptNumber: 1,
      userPrompt: "Port the section panel",
      assistantResponse: "Rolled it back after review.",
      title: "Section panel attempt",
      content: "Tagged turn",
      insight: null,
      tags: ["rolled-back", "topic:svg-filter"],
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 110,
      updatedAtEpoch: null,
      observations: [{ title: "Probe", content: "probe obs" }],
    });

    saveTurn(db, {
      sessionId: session.id,
      promptNumber: 2,
      userPrompt: "Unrelated follow-up",
      assistantResponse: "No tags here.",
      title: "Untagged turn",
      content: "Untagged turn",
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 120,
      updatedAtEpoch: null,
      observations: [],
    });
  });

  afterEach(() => {
    db.close();
  });

  test("matches a bare role tag at the session and turn layers", () => {
    const results = searchMemory(db, { tag: "rolled-back" });
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ layer: "session", sourceId: sessionId }),
        expect.objectContaining({ layer: "turn", title: "Section panel attempt" }),
      ]),
    );
    // The untagged turn must NOT be returned.
    expect(results.some((r) => r.title === "Untagged turn")).toBe(false);
    // Tags live on turns — the observation layer is excluded.
    expect(results.some((r) => r.layer === "observation")).toBe(false);
  });

  test("matches a topic:-prefixed tag exactly, never as a prefix", () => {
    expect(
      searchMemory(db, { tag: "topic:svg-filter" }).some(
        (r) => r.title === "Section panel attempt",
      ),
    ).toBe(true);

    // Anchored to a whole array element: a strict prefix must not match.
    expect(searchMemory(db, { tag: "topic:svg" })).toEqual([]);
    expect(searchMemory(db, { tag: "rolled" })).toEqual([]);
  });

  test("treats LIKE wildcards as literal tag characters, not patterns", () => {
    // Regression: a json_each `value = ?` match (not LIKE) means `%`/`_` are
    // ordinary characters — they match only a literal tag, never everything.
    expect(searchMemory(db, { tag: "%" })).toEqual([]);
    expect(searchMemory(db, { tag: "_" })).toEqual([]);
    expect(searchMemory(db, { tag: "topic:svg_filter" })).toEqual([]);
  });
});

// ticket 02 (spec B5/B6): `type` is multi-valued now, matched the same way
// `tag` already is — a queried word must match ANY element of the stored
// list, not the whole list as a unit.
describe("searchMemory type filter (ticket 02, spec B5)", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    const session = upsertSession(db, {
      contentSessionId: "session-type-filter",
      project: "claude-mnemo",
      title: "Type filter session",
      content: "Holds a multi-valued turn",
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    saveTurn(db, {
      sessionId: session.id,
      promptNumber: 1,
      userPrompt: "Ship the release and review the fix",
      assistantResponse: "Reviewed the fix, then shipped it.",
      title: "Multi-valued turn",
      content: "Carries two stated activities",
      insight: null,
      type: ["review", "ops"],
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 110,
      updatedAtEpoch: null,
      observations: [],
    });

    saveTurn(db, {
      sessionId: session.id,
      promptNumber: 2,
      userPrompt: "Unrelated follow-up",
      assistantResponse: "No activity stated here.",
      title: "Untyped turn",
      content: "Untyped turn",
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 120,
      updatedAtEpoch: null,
      observations: [],
    });
  });

  afterEach(() => {
    db.close();
  });

  test("matches a word that is one of several stored values, not the whole list", () => {
    const byFirst = searchMemory(db, { scope: "turns", type: "review" });
    expect(byFirst.some((r) => r.title === "Multi-valued turn")).toBe(true);

    const bySecond = searchMemory(db, { scope: "turns", type: "ops" });
    expect(bySecond.some((r) => r.title === "Multi-valued turn")).toBe(true);

    // The untyped turn never matches either word.
    expect(byFirst.some((r) => r.title === "Untyped turn")).toBe(false);
    expect(bySecond.some((r) => r.title === "Untyped turn")).toBe(false);
  });

  test("a word the turn never stated does not match", () => {
    expect(
      searchMemory(db, { scope: "turns", type: "design" }).some(
        (r) => r.title === "Multi-valued turn",
      ),
    ).toBe(false);
  });
});
