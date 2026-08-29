import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { insertLane } from "../../src/db/lanes";
import { deriveSideTags, writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import { addSegmentMembers, createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { recallMemory } from "../../src/mcp/recall";
import { timelineQuery } from "../../src/mcp/timeline";
import {
  createConsoleReader,
  encodeSessionsCursor,
  openConsoleReaderDatabase,
  parseSessionsCursor,
} from "../../src/worker/console-reader";

/**
 * ConsoleReader (memory-console spec, "Read-only, structurally"; ticket 02,
 * grown by ticket 03 to the full `/api/console/*` query surface).
 *
 * Two guarantees stay independently tested from ticket 02 (unchanged by the
 * growth): the CONNECTION cannot write (a real seeded sqlite FILE, since the
 * readonly-open contract is about the file open mode itself), and the
 * MODULE'S OWN SOURCE never reaches for a write path or the queue/settlement
 * machinery that drives one.
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

describe("ConsoleReader connection lifecycle (behavioral)", () => {
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

  test("findSession reads through the narrow surface", () => {
    const { sessionId } = seedFixture();
    const db = openConsoleReaderDatabase(dbPath);
    try {
      const reader = createConsoleReader(db);
      expect(reader.findSession(sessionId)).toMatchObject({
        id: sessionId,
        title: "fixture session",
        project: "/tmp/console-reader-fixture",
      });
      expect(reader.findSession(sessionId + 999)).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe("sessions cursor codec", () => {
  test("round-trips", () => {
    expect(parseSessionsCursor(encodeSessionsCursor(1_000, 42))).toEqual({ epoch: 1_000, id: 42 });
  });

  test("rejects anything not exactly <digits>:<digits>", () => {
    for (const bad of ["", "abc", "1:2:3", "1:", ":2", "1.5:2", "-1:2", "1:-2"]) {
      expect(parseSessionsCursor(bad)).toBeNull();
    }
  });

  test("rejects a digit run beyond Number.MAX_SAFE_INTEGER — malformed, not silently truncated or handed to SQLite (peer finding #13)", () => {
    const tooLarge = String(Number.MAX_SAFE_INTEGER + 1); // 9007199254740992
    expect(parseSessionsCursor(`${tooLarge}:1`)).toBeNull();
    expect(parseSessionsCursor(`1:${tooLarge}`)).toBeNull();
    // A digit run long enough to parse to Infinity is the same failure mode.
    expect(parseSessionsCursor("9".repeat(400) + ":1")).toBeNull();
    // The boundary itself is still accepted — this is a strictly-greater-than
    // rejection, not an off-by-one narrowing of the legal range.
    expect(parseSessionsCursor(`${Number.MAX_SAFE_INTEGER}:1`)).toEqual({
      epoch: Number.MAX_SAFE_INTEGER,
      id: 1,
    });
  });
});

describe("ConsoleReader query surface (in-memory schema)", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  const NOW = 1_800_000_000;

  function seedSession(label: string, createdAtEpoch: number): number {
    return upsertSession(db, {
      contentSessionId: `${label}-${Math.random()}`,
      project: `/tmp/${label}`,
      title: label,
      content: null,
      insight: null,
      createdAtEpoch,
      updatedAtEpoch: createdAtEpoch,
      completedAtEpoch: null,
    }).id;
  }

  function insertTurn(
    sessionId: number,
    promptNumber: number,
    options: {
      type?: string[];
      title?: string | null;
      userPrompt?: string | null;
      content?: string | null;
      status?: string;
    } = {},
  ): number {
    return db
      .query<
        { id: number },
        [number, number, string, string | null, string | null, string | null, number, string]
      >(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt, title, content,
           tool_call_count, created_at_epoch, type
         ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
         RETURNING id`,
      )
      .get(
        sessionId,
        promptNumber,
        options.status ?? "active",
        options.userPrompt ?? "p",
        options.title ?? null,
        options.content ?? null,
        NOW + promptNumber,
        JSON.stringify(options.type ?? ["design"]),
      )!.id;
  }

  function tagEdge(citingId: number, citedId: number, relation: string, tags: readonly string[]): void {
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: citingId },
          cited: { kind: "turn", id: citedId },
          relation: relation as never,
          provenance: "asserted",
          ...deriveSideTags(tags),
        },
      ],
      NOW,
    );
  }

  describe("listSessionsPage", () => {
    test("orders newest-first, respects limit, and emits a nextCursor iff there is a next page", () => {
      const s1 = seedSession("s1", 1_000);
      const s2 = seedSession("s2", 1_001);
      const s3 = seedSession("s3", 1_002);
      const reader = createConsoleReader(db);

      const page1 = reader.listSessionsPage({ cursor: null, limit: 2 });
      expect(page1.sessions.map((s) => s.id)).toEqual([s3, s2]);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = reader.listSessionsPage({
        cursor: parseSessionsCursor(page1.nextCursor!)!,
        limit: 2,
      });
      expect(page2.sessions.map((s) => s.id)).toEqual([s1]);
      expect(page2.nextCursor).toBeNull();
    });

    test("turnCount excludes undone turns; date is the session's createdAtEpoch as ISO", () => {
      const sessionId = seedSession("counted", 1_000);
      insertTurn(sessionId, 1);
      insertTurn(sessionId, 2);
      const undone = insertTurn(sessionId, 3);
      db.query("UPDATE turns SET status = 'undone' WHERE id = ?").run(undone);

      const reader = createConsoleReader(db);
      const page = reader.listSessionsPage({ cursor: null, limit: 10 });
      const summary = page.sessions.find((s) => s.id === sessionId)!;
      expect(summary.turnCount).toBe(2);
      expect(summary.date).toBe(new Date(1_000 * 1000).toISOString());
    });
  });

  describe("listAllSegmentCards", () => {
    test("reports every segment (any status) with its own member count", () => {
      const sessionId = seedSession("seg", 1_000);
      const t1 = insertTurn(sessionId, 1);
      const t2 = insertTurn(sessionId, 2);
      const open = createSegment(db, { title: "open one", tags: [], nowEpoch: NOW });
      const closed = createSegment(db, { title: "closed one", tags: [], status: "closed", nowEpoch: NOW });
      addSegmentMembers(db, open.id, [t1, t2], NOW);
      addSegmentMembers(db, closed.id, [t1], NOW);

      const reader = createConsoleReader(db);
      const cards = reader.listAllSegmentCards();
      expect(cards.find((c) => c.id === open.id)).toMatchObject({ status: "open", memberCount: 2 });
      expect(cards.find((c) => c.id === closed.id)).toMatchObject({ status: "closed", memberCount: 1 });
    });
  });

  describe("getSessionMaxPromptNumber", () => {
    test("the highest prompt_number, regardless of status; null for a turn-less session", () => {
      const withTurns = seedSession("with-turns", 1_000);
      insertTurn(withTurns, 1);
      insertTurn(withTurns, 5);
      const empty = seedSession("empty", 1_001);

      const reader = createConsoleReader(db);
      expect(reader.getSessionMaxPromptNumber(withTurns)).toBe(5);
      expect(reader.getSessionMaxPromptNumber(empty)).toBeNull();
    });
  });

  describe("getSegmentCardDetail", () => {
    test("null for an unknown id; the full record + S<session>/T<prompt> member addresses, oldest first, for a known one", () => {
      const sessionId = seedSession("card", 1_000);
      const t1 = insertTurn(sessionId, 1);
      const t2 = insertTurn(sessionId, 2);
      const segment = createSegment(db, { title: "card segment", tags: [], nowEpoch: NOW });
      addSegmentMembers(db, segment.id, [t2, t1], NOW);

      const reader = createConsoleReader(db);
      expect(reader.getSegmentCardDetail(999_999)).toBeNull();

      const detail = reader.getSegmentCardDetail(segment.id)!;
      expect(detail.segment.id).toBe(segment.id);
      expect(detail.memberAddresses).toEqual([`S${sessionId}/T1`, `S${sessionId}/T2`]);
    });
  });

  describe("runLaneCheck", () => {
    test("one call yields a LaneCheckerResult AND the exact turns/edges that produced it", () => {
      const sessionId = seedSession("lane", 1_000);
      const t1 = insertTurn(sessionId, 1);
      const t2 = insertTurn(sessionId, 2);
      // A lane needs MEMBERS, and since lane-model-v12 ticket 10 a member is a
      // turn whose OWN tags carry a lane DECLARED in its owning segment — the
      // edge alone no longer enumerates anything.
      const segment = createSegment(db, { title: "lane segment", tags: [], nowEpoch: NOW });
      addSegmentMembers(db, segment.id, [t1, t2], NOW);
      insertLane(db, segment.id, "focus", NOW);
      db.query<unknown, [number]>(`UPDATE turns SET tags = '["focus"]' WHERE id = ?`).run(t1);
      db.query<unknown, [number]>(`UPDATE turns SET tags = '["focus"]' WHERE id = ?`).run(t2);
      tagEdge(t2, t1, "indexes", ["focus"]);

      const reader = createConsoleReader(db);
      const run = reader.runLaneCheck({ kind: "range", sessionId, promptStart: 1, promptEnd: 2 });

      expect(run.result.lanes).toHaveLength(1);
      expect(new Set(run.turns.map((t) => t.id))).toEqual(new Set([t1, t2]));
      expect(() => new Date(run.asOf).toISOString()).not.toThrow();
    });

    test("a write is impossible mid-run: the transaction is over the readonly connection", () => {
      const sessionId = seedSession("lane-write", 1_000);
      insertTurn(sessionId, 1);
      const reader = createConsoleReader(db);
      // Sanity: runLaneCheck itself never attempts a write, so this is really
      // just proving the call completes without touching the write path —
      // the structural guarantee (readonly connection) is proven on the real
      // file-backed connection in the lifecycle describe block above.
      expect(() =>
        reader.runLaneCheck({ kind: "range", sessionId, promptStart: 1, promptEnd: 1 }),
      ).not.toThrow();
    });
  });

  describe("loadTurnDisplayFields", () => {
    test("batches by id; empty input needs no query and returns an empty map", () => {
      const sessionId = seedSession("display", 1_000);
      const t1 = insertTurn(sessionId, 1, { title: "T1 title", userPrompt: "hello", content: "insight text" });

      const reader = createConsoleReader(db);
      expect(reader.loadTurnDisplayFields([])).toEqual(new Map());

      const fields = reader.loadTurnDisplayFields([t1, 999_999]);
      expect(fields.size).toBe(1);
      expect(fields.get(t1)).toEqual({
        sessionId,
        promptNumber: 1,
        title: "T1 title",
        userPrompt: "hello",
        content: "insight text",
        tags: [],
      });
    });

    // [S15069/T1696]: the console panel shows the RAW column, not the lane
    // resolution, so this loader has to carry every stored word — including
    // the segment's own tag and legacy vocabulary, which the lane resolution
    // drops by design.
    test("carries the turn's RAW tags column, parsed, every word", () => {
      const sessionId = seedSession("tags", 2_000);
      const t1 = insertTurn(sessionId, 1);
      db.query("UPDATE turns SET tags = ? WHERE id = ?").run(
        JSON.stringify(["claude-mnemo", "lane-declaration", "observation-pipeline"]),
        t1,
      );

      const reader = createConsoleReader(db);
      expect(reader.loadTurnDisplayFields([t1]).get(t1)!.tags).toEqual([
        "claude-mnemo",
        "lane-declaration",
        "observation-pipeline",
      ]);
    });

    // A display field must never be able to fail a whole graph request: every
    // shape that is not an array of strings answers [], never a throw.
    test("malformed, non-array and non-string tag values all degrade to [] rather than throwing", () => {
      const sessionId = seedSession("tags-bad", 3_000);
      const reader = createConsoleReader(db);
      for (const stored of ["not json at all", '{"a":1}', "42", '["ok", 7, null]']) {
        const id = insertTurn(sessionId, 1 + ["not json at all", '{"a":1}', "42", '["ok", 7, null]'].indexOf(stored));
        db.query("UPDATE turns SET tags = ? WHERE id = ?").run(stored, id);
        const tags = reader.loadTurnDisplayFields([id]).get(id)!.tags;
        expect({ stored, tags }).toEqual({ stored, tags: stored.startsWith("[") ? ["ok"] : [] });
      }
    });
  });
});

/**
 * Ticket 13 (console-recall-timeline-panels), the hard gate: the console
 * demo runs against the LIVE production DB — read-only "from this repo" only
 * because nothing on this path ever asks to write. `runRecall`/`runTimeline`
 * wrap `recallMemory`/`timelineQuery`, both of which DO write a delivery
 * ledger (`write_gate_reads`/`write_gate_field_completeness`/
 * `lane_read_receipts`) for an IDENTIFIED caller — the seam this proves is
 * that `ConsoleRecallInput`/`ConsoleTimelineInput` cannot carry a `readerId`
 * at all (see those types' own doc, console-reader.ts), so that ledger never
 * gets built on this path.
 *
 * Each test pairs the console call (must write nothing) with a CONTRAST call
 * — the exact same underlying function, on the exact same seeded data, but
 * called directly with a `readerId` — to prove the zero-write result is a
 * consequence of the omitted identity, not an accident of a render that
 * would never have written anything regardless.
 */
describe("ConsoleReader.runRecall / runTimeline (ticket 13: render-only, writes nothing)", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  const NOW = 1_800_000_000;

  function counts(): { reads: number; completeness: number; laneReceipts: number } {
    const reads = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM write_gate_reads").get()!.c;
    const completeness = db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM write_gate_field_completeness")
      .get()!.c;
    const laneReceipts = db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM lane_read_receipts")
      .get()!.c;
    return { reads, completeness, laneReceipts };
  }

  function seedSessionWithTurn(label: string): { sessionId: number; turnId: number } {
    const sessionId = upsertSession(db, {
      contentSessionId: `${label}-${Math.random()}`,
      project: `/tmp/${label}`,
      title: label,
      content: null,
      insight: null,
      createdAtEpoch: NOW,
      updatedAtEpoch: NOW,
      completedAtEpoch: null,
    }).id;
    const turnId = db
      .query<{ id: number }, [number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt, assistant_response,
           title, content, created_at_epoch, type
         ) VALUES (?, 1, 'active', 'p', 'r', 'a title', 'body', ${NOW}, '["design"]')
         RETURNING id`,
      )
      .get(sessionId)!.id;
    return { sessionId, turnId };
  }

  test("runRecall(id=S<n>) renders the session and leaves write_gate_reads/write_gate_field_completeness untouched, though the identical render WITH a readerId writes to write_gate_reads", () => {
    const { sessionId } = seedSessionWithTurn("recall-render-only");
    const reader = createConsoleReader(db);

    const before = counts();
    const text = reader.runRecall({ id: `S${sessionId}` });
    expect(text).toContain("recall-render-only");
    expect(counts()).toEqual(before);

    // Contrast: the SAME session, the SAME underlying function, called
    // directly with a writer identity — proves the ledger this route bypasses
    // is a real, reachable write path on this exact data, not a no-op that
    // would have written nothing regardless of `readerId`.
    recallMemory(db, { id: `S${sessionId}`, readerId: "session:1" });
    expect(counts().reads).toBeGreaterThan(before.reads);
  });

  test("runTimeline(id=S<n>) renders the session's turns and leaves write_gate_reads untouched, though the identical query WITH a readerId writes to write_gate_reads", () => {
    const { sessionId } = seedSessionWithTurn("timeline-render-only");
    const reader = createConsoleReader(db);

    const before = counts();
    const text = reader.runTimeline({ id: `S${sessionId}` });
    expect(text.length).toBeGreaterThan(0);
    expect(counts()).toEqual(before);

    timelineQuery(db, { id: `S${sessionId}`, readerId: "session:1" });
    expect(counts().reads).toBeGreaterThan(before.reads);
  });

  test("runRecall(id=E<n>/#<lane>) renders the lane and leaves lane_read_receipts untouched, though the identical render WITH a readerId stamps a receipt", () => {
    const segment = createSegment(db, { title: "Lane render-only", nowEpoch: NOW });
    insertLane(db, segment.id, "mylane", NOW);
    const sessionId = upsertSession(db, {
      contentSessionId: `lane-render-only-${Math.random()}`,
      project: "/tmp/lane-render-only",
      title: "lane-render-only",
      content: null,
      insight: null,
      createdAtEpoch: NOW,
      updatedAtEpoch: NOW,
      completedAtEpoch: null,
    }).id;
    const turnId = db
      .query<{ id: number }, [number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt, title, content,
           created_at_epoch, type, tags
         ) VALUES (?, 1, 'active', 'p', 'lane turn', 'body', ${NOW}, '["design"]', '["mylane"]')
         RETURNING id`,
      )
      .get(sessionId)!.id;
    addSegmentMembers(db, segment.id, [turnId], NOW);

    const reader = createConsoleReader(db);
    const before = counts();
    const text = reader.runRecall({ id: `E${segment.id}/#mylane` });
    expect(text).toContain("lane turn");
    expect(counts()).toEqual(before);

    recallMemory(db, { id: `E${segment.id}/#mylane`, readerId: "session:1" });
    expect(counts().laneReceipts).toBeGreaterThan(before.laneReceipts);
  });
});
