import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { reindexTurnFromDb } from "../../src/db/search";
import { appendSegmentWorkingStateRows, createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { recallMemory } from "../../src/mcp/recall";

/**
 * write-mode-edit-semantics ticket 04 (spec D8): the write gate's RECORD
 * half — a real `recall()` render pass, when it shows a field in full or
 * truncated, records that fact into `write_gate_field_completeness`. The
 * storage-level judgment table (long field truncated / short field on the
 * same entity stays complete; later render wins) lives in
 * tests/db/write-gate.test.ts and is unconditional there; this file proves
 * the SAME facts flow correctly through the actual renderers this ticket
 * wires — segment-card.ts's elision ladder, and recall.ts's per-field browse
 * block (`renderBrowseTurnBlock`) — not just the storage API in isolation.
 */

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
  initializeSchema(db);
});

afterEach(() => db.close());

function completenessRow(
  target: Database,
  writer: string,
  entityType: string,
  entityId: number,
  field: string,
): { complete: number } | null {
  return target
    .query<{ complete: number }, [string, string, number, string]>(
      `SELECT complete FROM write_gate_field_completeness
       WHERE writer = ? AND entity_type = ? AND entity_id = ? AND field = ?`,
    )
    .get(writer, entityType, entityId, field);
}

function seedSessionWithTurn(
  contentSessionId: string,
  overrides: { content?: string; insight?: string } = {},
): { sessionId: number; turnId: number } {
  const sessionId = upsertSession(db, {
    contentSessionId,
    project: "/tmp/field-completeness",
    title: `${contentSessionId} title`,
    content: null,
    insight: null,
    createdAtEpoch: 100,
    updatedAtEpoch: 100,
    completedAtEpoch: null,
  }).id;

  const turnId = db
    .query<{ id: number }, [number, string | null, string | null]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         title, content, insight, created_at_epoch
       ) VALUES (?, 1, 'extracted', 'prompt', 'response', 'a title', ?, ?, 110)
       RETURNING id`,
    )
    .get(sessionId, overrides.content ?? "turn content", overrides.insight ?? null)!.id;

  // Same explicit re-index every raw-INSERT turn fixture in this codebase
  // uses (recall.ticket14.test.ts) — the write path this bypasses normally
  // maintains memory_fts itself.
  reindexTurnFromDb(db, turnId);
  return { sessionId, turnId };
}

describe("segment card render records per-field completeness (segment-card.ts's elision ladder)", () => {
  test("a long content field that gets elided is recorded incomplete; a short goal field on the SAME segment is recorded complete", () => {
    const segment = createSegment(db, {
      title: "Field completeness lane",
      content: "x".repeat(5000),
      nowEpoch: 100,
    });
    appendSegmentWorkingStateRows(db, segment.id, "goal", ["short goal"], 100);

    recallMemory(db, { id: `E${segment.id}`, pageBudget: 80, readerId: "session:1", now: () => 500 });

    expect(completenessRow(db, "session:1", "segment", segment.id, "content")?.complete).toBe(0);
    expect(completenessRow(db, "session:1", "segment", segment.id, "goal")?.complete).toBe(1);
  });

  test("an untruncated card (generous budget) records every rendered field complete", () => {
    const segment = createSegment(db, {
      title: "Small lane",
      content: "short content",
      nowEpoch: 100,
    });
    appendSegmentWorkingStateRows(db, segment.id, "goal", ["short goal"], 100);

    recallMemory(db, { id: `E${segment.id}`, readerId: "session:1", now: () => 500 });

    expect(completenessRow(db, "session:1", "segment", segment.id, "content")?.complete).toBe(1);
    expect(completenessRow(db, "session:1", "segment", segment.id, "goal")?.complete).toBe(1);
  });
});

describe("the bare browse feed records per-field turn completeness (recall.ts's renderBrowseTurnBlock)", () => {
  test("a long content field that gets word-boundary cut is recorded incomplete; a short insight field on the SAME turn is recorded complete", () => {
    const { turnId } = seedSessionWithTurn("browse-completeness", {
      content: "x".repeat(1000),
      insight: "- short insight",
    });

    recallMemory(db, {
      filter: { fields: ["content", "insight"] },
      turn: 20,
      readerId: "session:1",
      now: () => 500,
    });

    expect(completenessRow(db, "session:1", "turn", turnId, "content")?.complete).toBe(0);
    expect(completenessRow(db, "session:1", "turn", turnId, "insight")?.complete).toBe(1);
  });

  test("title is always recorded complete when selected — it renders as the row label, never through truncateText", () => {
    const { turnId } = seedSessionWithTurn("browse-title-completeness", { content: "x".repeat(1000) });

    recallMemory(db, {
      filter: { fields: ["title", "content"] },
      turn: 5,
      readerId: "session:1",
      now: () => 500,
    });

    expect(completenessRow(db, "session:1", "turn", turnId, "title")?.complete).toBe(1);
  });
});

describe("later render wins — no permanent disqualification from an earlier truncated read", () => {
  test("a field recorded incomplete under a tight budget is re-recorded complete under a generous one", () => {
    const segment = createSegment(db, {
      title: "Re-read lane",
      content: "x".repeat(5000),
      nowEpoch: 100,
    });

    recallMemory(db, { id: `E${segment.id}`, pageBudget: 60, readerId: "session:1", now: () => 500 });
    expect(completenessRow(db, "session:1", "segment", segment.id, "content")?.complete).toBe(0);

    // A budget generous enough to hold the whole 5000-char content field —
    // the default (1000 tokens) is not, so it is stated explicitly here.
    recallMemory(db, { id: `E${segment.id}`, pageBudget: 5000, readerId: "session:1", now: () => 600 });
    expect(completenessRow(db, "session:1", "segment", segment.id, "content")?.complete).toBe(1);
  });
});

describe("a readonly render pass produces no write at all", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("recall() on a readonly file handle with no readerId renders normally and writes nothing to write_gate_field_completeness", () => {
    const dir = mkdtempSync(join(tmpdir(), "field-completeness-readonly-"));
    tempDirs.push(dir);
    const path = join(dir, "readonly-fixture.db");

    const writable = new Database(path, { create: true });
    initializeSchema(writable);
    const segment = createSegment(writable, {
      title: "Readonly lane",
      content: "x".repeat(5000),
      nowEpoch: 100,
    });
    appendSegmentWorkingStateRows(writable, segment.id, "goal", ["short goal"], 100);
    // A readonly connection to a WAL-mode database fails to open unless the
    // -wal/-shm sidecars are still present — not the shape under test here
    // (same setup tests/hooks/context-segments.test.ts already uses).
    writable.exec("PRAGMA journal_mode = DELETE;");
    writable.close();

    const readonlyDb = new Database(path, { readonly: true, create: false });

    // No readerId — the exact shape the SessionStart injection path uses
    // (background: hook connections never pass a writer identity). If this
    // call attempted a write of ANY kind — a grant, a field-completeness row
    // — it would throw "attempt to write a readonly database", the same
    // failure shape a sibling ticket is separately fixing for the grant
    // table.
    let output: string | undefined;
    expect(() => {
      output = recallMemory(readonlyDb, { id: `E${segment.id}`, pageBudget: 60 });
    }).not.toThrow();

    expect(output).toContain("Readonly lane");

    const rows = readonlyDb
      .query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM write_gate_field_completeness`)
      .get();
    expect(rows?.count).toBe(0);

    readonlyDb.close();
  });
});
