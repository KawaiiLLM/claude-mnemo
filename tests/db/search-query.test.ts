import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { saveTurn } from "../../src/db/turns";
import { searchMemory } from "../../src/db/search";

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
