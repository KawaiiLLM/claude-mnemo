import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { createMemory } from "../../src/db/memories";
import { initializeDatabase } from "../../src/db/schema";
import { createDatabaseBackedHandlers } from "../../src/mcp/handlers";
import { replayInputSchema } from "../../src/mcp/definitions";

describe("database-backed MCP handlers", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeDatabase(db);

    createMemory(db, {
      type: "project",
      scope: "claude-mnemo",
      title: "Auth mutex policy",
      content: "Refresh token work must be serialized with a mutex.",
      reasoning: null,
      application: null,
      tags: [],
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      sourceTurnId: null,
      status: "active",
      supersededBy: null,
      expiresAtEpoch: null,
    });

    createMemory(db, {
      type: "project",
      scope: "other-project",
      title: "Other project note",
      content: "This should not appear when the handler defaults project scope.",
      reasoning: null,
      application: null,
      tags: [],
      createdAtEpoch: 110,
      updatedAtEpoch: null,
      sourceTurnId: null,
      status: "active",
      supersededBy: null,
      expiresAtEpoch: null,
    });
  });

  afterEach(() => {
    db.close();
  });

  test("routes simplified recall args without legacy scope fields", async () => {
    const handlers = createDatabaseBackedHandlers(db, {
      defaultProject: "claude-mnemo",
    });

    const result = await handlers.recall?.({
      id: "M1",
    });

    expect(result?.content[0]?.text).toContain("Auth mutex policy");
  });

  test("routes simplified replay args through the replay handler", async () => {
    const handlers = createDatabaseBackedHandlers(db);

    const result = await handlers.replay?.({
      id: "S1",
      depth: "collapsed",
    });

    expect(result?.content[0]?.text).toBe("Transcript not found.");
  });

  test("replay schema only accepts id and optional depth", () => {
    expect(replayInputSchema.parse({ id: "S1/T2", depth: "full" })).toEqual({
      id: "S1/T2",
      depth: "full",
    });

    expect(() =>
      replayInputSchema.parse({
        id: "S1",
        session: 1,
      }),
    ).toThrow();
  });
});
