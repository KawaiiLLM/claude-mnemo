import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { resolveTurnPointers } from "../../src/mcp/turn-pointers";

describe("resolveTurnPointers", () => {
  let db: Database;
  let sessionA: number;
  let sessionB: number;
  let turnA1Id: number;
  let turnB1Id: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    sessionA = db
      .query<{ id: number }, []>(
        "INSERT INTO sessions (content_session_id, project, created_at_epoch) VALUES ('sess-a', 'proj', 1) RETURNING id",
      )
      .get()!.id;
    sessionB = db
      .query<{ id: number }, []>(
        "INSERT INTO sessions (content_session_id, project, created_at_epoch) VALUES ('sess-b', 'proj', 1) RETURNING id",
      )
      .get()!.id;

    // session A: prompt_number 7 (DB id will differ from prompt number)
    turnA1Id = db
      .query<{ id: number }, [number]>(
        "INSERT INTO turns (session_id, prompt_number, status, title, created_at_epoch) VALUES (?, 7, 'extracted', 'Add migration columns', 2) RETURNING id",
      )
      .get(sessionA)!.id;
    // session B: a turn that must never resolve from session A
    turnB1Id = db
      .query<{ id: number }, [number]>(
        "INSERT INTO turns (session_id, prompt_number, status, title, created_at_epoch) VALUES (?, 3, 'extracted', 'Unrelated work', 2) RETURNING id",
      )
      .get(sessionB)!.id;
  });

  afterEach(() => {
    db.close();
  });

  test("resolves a marker to S<id>/T<prompt_number> with the current title", () => {
    const resolved = resolveTurnPointers(
      db,
      sessionA,
      `Shipped the schema [T${turnA1Id}]`,
    );

    expect(resolved).toBe(
      `Shipped the schema [S${sessionA}/T7] "Add migration columns"`,
    );
  });

  test("uses the DB turn id, not the prompt number", () => {
    // The marker carries the DB id; prompt_number 7 surfaces only after lookup.
    expect(turnA1Id).not.toBe(7);
    expect(resolveTurnPointers(db, sessionA, `[T${turnA1Id}]`)).toContain("/T7]");
  });

  test("keeps the literal marker for a cross-session turn id", () => {
    const resolved = resolveTurnPointers(db, sessionA, `See [T${turnB1Id}]`);
    expect(resolved).toBe(`See [T${turnB1Id}]`);
  });

  test("keeps the literal marker for an unknown turn id", () => {
    expect(resolveTurnPointers(db, sessionA, "Done [T9999]")).toBe("Done [T9999]");
  });

  test("keeps the literal marker for an undone (retracted) turn", () => {
    const undoneId = db
      .query<{ id: number }, [number]>(
        "INSERT INTO turns (session_id, prompt_number, status, title, created_at_epoch) VALUES (?, 8, 'undone', 'Abandoned approach', 2) RETURNING id",
      )
      .get(sessionA)!.id;

    expect(resolveTurnPointers(db, sessionA, `Tried [T${undoneId}]`)).toBe(
      `Tried [T${undoneId}]`,
    );
  });

  test("resolves several markers and leaves prose intact", () => {
    const resolved = resolveTurnPointers(
      db,
      sessionA,
      `[T${turnA1Id}] then [T${turnA1Id}] again`,
    );
    expect(resolved).toBe(
      `[S${sessionA}/T7] "Add migration columns" then [S${sessionA}/T7] "Add migration columns" again`,
    );
  });

  test("passes through null and pointer-free text untouched", () => {
    expect(resolveTurnPointers(db, sessionA, null)).toBeNull();
    expect(resolveTurnPointers(db, sessionA, "no markers here")).toBe(
      "no markers here",
    );
  });
});
