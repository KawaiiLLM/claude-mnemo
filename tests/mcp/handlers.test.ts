import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { createMemory } from "../../src/db/memories";
import { initializeDatabase } from "../../src/db/schema";
import { recallInputSchema } from "../../src/mcp/definitions";
import { createDatabaseBackedHandlers } from "../../src/mcp/handlers";

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

  test("recall schema accepts the new surface and rejects removed fields", () => {
    expect(
      recallInputSchema.parse({
        id: "S1/T2",
        depth: "expanded",
        page: 2,
        pageSize: 10,
        truncate: 500,
      }),
    ).toEqual({
      id: "S1/T2",
      depth: "expanded",
      page: 2,
      pageSize: 10,
      truncate: 500,
    });

    expect(() =>
      recallInputSchema.parse({
        id: "S1",
        limit: 10,
      }),
    ).toThrow();
    expect(() =>
      recallInputSchema.parse({
        id: "S1",
        depth: "full",
      }),
    ).toThrow();
  });
});
