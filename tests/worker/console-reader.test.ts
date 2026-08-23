import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import {
  createConsoleReader,
  openConsoleReaderDatabase,
} from "../../src/worker/console-reader";

/**
 * ConsoleReader (memory-console spec, "Read-only, structurally"; ticket 02).
 *
 * Two guarantees, tested independently: the CONNECTION cannot write (a real
 * seeded sqlite FILE -- not `:memory:`, since the readonly-open contract is
 * about the file open mode itself, and two separate `:memory:` connections
 * do not even share state to prove that against), and the MODULE'S OWN
 * SOURCE never reaches for a write path or the queue/settlement machinery
 * that drives one (precedent: tests/mcp/timeline.election-retirement.test.ts's
 * static source scan).
 */

const CONSOLE_READER_SOURCE_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "src",
  "worker",
  "console-reader.ts",
);

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("ConsoleReader source guard (static)", () => {
  test("the reader module is free of DML, db.exec, and queue/settlement imports", () => {
    const code = stripComments(readFileSync(CONSOLE_READER_SOURCE_PATH, "utf8"));

    expect(code).not.toMatch(/\bINSERT\b/i);
    expect(code).not.toMatch(/\bUPDATE\b/i);
    expect(code).not.toMatch(/\bDELETE\b/i);
    expect(code).not.toMatch(/\bREPLACE\b/i);
    expect(code).not.toMatch(/\.exec\s*\(/);
    expect(code).not.toMatch(/pending-queue/i);
    expect(code).not.toMatch(/note-settlement/i);
  });
});

describe("ConsoleReader (behavioral)", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "console-reader-test-"));
    dbPath = join(dir, "fixture.db");
  });

  afterEach(() => {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function seedFixture(): { sessionId: number } {
    const db = createDatabase(dbPath);
    initializeSchema(db);
    const sessionId = upsertSession(db, {
      contentSessionId: "console-reader-fixture",
      project: "/tmp/console-reader-fixture",
      title: "fixture session",
      content: null,
      insight: null,
      createdAtEpoch: 1_000,
      updatedAtEpoch: 1_000,
      completedAtEpoch: null,
    }).id;
    db.close();
    return { sessionId };
  }

  test("a write attempted through the readonly connection throws (readonly proof)", () => {
    seedFixture();
    const db = openConsoleReaderDatabase(dbPath);
    try {
      expect(() =>
        db.run(
          "INSERT INTO turns (session_id, prompt_number, status, created_at_epoch) VALUES (1, 1, 'active', 0)",
        ),
      ).toThrow();
      expect(() => db.exec("DELETE FROM sessions")).toThrow();
    } finally {
      db.close();
    }
  });

  test("opening a missing file fails -- create:false semantics, it never silently creates one", () => {
    const missingPath = join(dir, "does-not-exist.db");

    expect(() => openConsoleReaderDatabase(missingPath)).toThrow();
    expect(existsSync(missingPath)).toBe(false);
  });

  test("listRecentSessions reads through the narrow surface (the one real method, ticket 02)", () => {
    const { sessionId } = seedFixture();
    const db = openConsoleReaderDatabase(dbPath);
    try {
      const reader = createConsoleReader(db);
      const sessions = reader.listRecentSessions();

      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        id: sessionId,
        title: "fixture session",
        project: "/tmp/console-reader-fixture",
      });
    } finally {
      db.close();
    }
  });

  test("listRecentSessions respects its limit parameter", () => {
    const db1 = createDatabase(dbPath);
    initializeSchema(db1);
    for (let i = 0; i < 3; i += 1) {
      upsertSession(db1, {
        contentSessionId: `console-reader-limit-${i}`,
        project: "/tmp/console-reader-fixture",
        title: `session ${i}`,
        content: null,
        insight: null,
        createdAtEpoch: 1_000 + i,
        updatedAtEpoch: 1_000 + i,
        completedAtEpoch: null,
      });
    }
    db1.close();

    const db = openConsoleReaderDatabase(dbPath);
    try {
      const reader = createConsoleReader(db);
      expect(reader.listRecentSessions(2)).toHaveLength(2);
    } finally {
      db.close();
    }
  });
});
