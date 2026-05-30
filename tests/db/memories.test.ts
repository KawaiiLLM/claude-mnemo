import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeDatabase } from "../../src/db/schema";
import {
  archiveMemory,
  createMemory,
  getMemory,
  listMemories,
  updateMemory,
} from "../../src/db/memories";

describe("memory queries", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeDatabase(db);
  });

  afterEach(() => {
    db.close();
  });

  test("creates, updates, lists, and archives memories", () => {
    const created = createMemory(db, {
      type: "feedback",
      scope: "global",
      title: "Use real DB integration tests",
      content: "Integration tests should use the real database layer.",
      reasoning: "Mocks hide transaction and locking behavior.",
      application: "When a change affects concurrency or persistence.",
      tags: ["testing", "database"],
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      sourceTurnId: null,
      status: "active",
      supersededBy: null,
      expiresAtEpoch: null,
    });

    expect(getMemory(db, created.id)).toEqual(created);
    expect(listMemories(db)).toHaveLength(1);

    const updated = updateMemory(db, created.id, {
      content: "Prefer the real database in integration tests.",
      application: "When writing persistence integration tests.",
      updatedAtEpoch: 120,
    });

    expect(updated?.content).toBe("Prefer the real database in integration tests.");
    expect(updated?.application).toBe("When writing persistence integration tests.");

    const archived = archiveMemory(db, created.id, {
      updatedAtEpoch: 140,
    });

    expect(archived?.status).toBe("archived");
    expect(listMemories(db)).toHaveLength(1);
    expect(listMemories(db, { status: "active" })).toHaveLength(0);
    expect(listMemories(db, { status: "archived" })).toHaveLength(1);
  });

  test("allows nullable memory fields to be cleared on update", () => {
    const created = createMemory(db, {
      type: "reference",
      scope: "claude-mnemo",
      title: "SQLite pragma note",
      content: "WAL mode should stay enabled.",
      reasoning: "It improves concurrent read/write behavior.",
      application: "When checking database initialization.",
      tags: ["database"],
      createdAtEpoch: 300,
      updatedAtEpoch: null,
      sourceTurnId: null,
      status: "active",
      supersededBy: null,
      expiresAtEpoch: 400,
    });

    const updated = updateMemory(db, created.id, {
      reasoning: null,
      application: null,
      expiresAtEpoch: null,
      updatedAtEpoch: 320,
    });

    expect(updated?.reasoning).toBeNull();
    expect(updated?.application).toBeNull();
    expect(updated?.expiresAtEpoch).toBeNull();
  });
});
