import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  countMemoryEdges,
  formatNodeRef,
  getEdgeInDegree,
  getIncomingEdges,
  getOutgoingEdges,
  parseNodeRef,
  writeMemoryEdges,
} from "../../src/db/memory-edges";
import { initializeSchema, migrateTurnCitationsToEdges } from "../../src/db/schema";
import { createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";

describe("universal memory edges", () => {
  let db: Database;
  let sessionId: number;

  function addTurn(promptNumber: number): number {
    return db
      .query<{ id: number }, [number, number]>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch)
         VALUES (?, ?, 'extracted', 100)
         RETURNING id`,
      )
      .get(sessionId, promptNumber)!.id;
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "session-edges",
      project: "/tmp/project",
      title: null,
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("node refs round-trip through the type-prefixed form", () => {
    expect(formatNodeRef({ kind: "segment", id: 47 })).toBe("segment:47");
    expect(parseNodeRef("turn:8942")).toEqual({ kind: "turn", id: 8942 });
    expect(parseNodeRef("T8942")).toBeNull();
    expect(parseNodeRef("turn:0")).toBeNull();
  });

  test("writes turn→segment edges and reads them from both ends", () => {
    const turnId = addTurn(1);
    const segment = createSegment(db, { title: "Fix the retry loop", nowEpoch: 200 });

    const result = writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: turnId },
          cited: { kind: "segment", id: segment.id },
          relation: "builds-on",
          provenance: "retrieval",
        },
      ],
      300,
    );

    expect(result.written).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
    expect(getOutgoingEdges(db, { kind: "turn", id: turnId })).toHaveLength(1);
    expect(getIncomingEdges(db, { kind: "segment", id: segment.id })).toEqual([
      {
        citing: { kind: "turn", id: turnId },
        cited: { kind: "segment", id: segment.id },
        relation: "builds-on",
        provenance: "retrieval",
        createdAtEpoch: 300,
      },
    ]);
  });

  test("re-writing a pair is idempotent and upgrades provenance only upward", () => {
    const citing = addTurn(1);
    const cited = addTurn(2);
    const edge = {
      citing: { kind: "turn" as const, id: citing },
      cited: { kind: "turn" as const, id: cited },
      relation: "builds-on" as const,
    };

    writeMemoryEdges(db, [{ ...edge, provenance: "retrieval" }], 300);
    writeMemoryEdges(db, [{ ...edge, provenance: "judged" }], 400);
    writeMemoryEdges(db, [{ ...edge, provenance: "retrieval" }], 500);

    const stored = getOutgoingEdges(db, edge.citing);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.provenance).toBe("judged");
    // First-sighting epoch survives: "when did this edge appear" stays answerable.
    expect(stored[0]?.createdAtEpoch).toBe(300);
  });

  test("rejects self-loops and malformed nodes without writing them", () => {
    const turnId = addTurn(1);

    const result = writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: turnId },
          cited: { kind: "turn", id: turnId },
          relation: "builds-on",
          provenance: "text-ref",
        },
        {
          citing: { kind: "turn", id: turnId },
          cited: { kind: "turn", id: 0 },
          relation: "builds-on",
          provenance: "text-ref",
        },
        {
          citing: { kind: "turn", id: turnId },
          cited: { kind: "turn", id: 999 },
          relation: "invented" as never,
          provenance: "text-ref",
        },
      ],
      300,
    );

    expect(result.written).toHaveLength(0);
    expect(result.rejected.map((entry) => entry.reason)).toEqual([
      "self-loop",
      "invalid-node",
      "invalid-relation",
    ]);
    expect(countMemoryEdges(db)).toBe(0);
  });

  test("in-degree counts distinct citers, not claims", () => {
    const cited = addTurn(1);
    const citerA = addTurn(2);
    const citerB = addTurn(3);

    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: citerA },
          cited: { kind: "turn", id: cited },
          relation: "builds-on",
          provenance: "retrieval",
        },
        {
          citing: { kind: "turn", id: citerA },
          cited: { kind: "turn", id: cited },
          relation: "evidence-for",
          provenance: "text-ref",
        },
        {
          citing: { kind: "turn", id: citerB },
          cited: { kind: "turn", id: cited },
          relation: "builds-on",
          provenance: "judged",
        },
      ],
      300,
    );

    expect(getEdgeInDegree(db, { kind: "turn", id: cited })).toBe(2);
  });

  describe("turn_citations migration", () => {
    function seedLegacyEdges(count: number): Array<{
      citing: number;
      cited: number;
      relation: string;
      createdAtEpoch: number;
    }> {
      const relations = [
        "builds-on",
        "implements",
        "supersedes",
        "evidence-for",
      ] as const;
      const turnIds = Array.from({ length: count + 1 }, (_unused, index) =>
        addTurn(index + 1),
      );
      const rows: Array<{
        citing: number;
        cited: number;
        relation: string;
        createdAtEpoch: number;
      }> = [];

      const insert = db.query<unknown, [number, number, string, number]>(
        `INSERT INTO turn_citations (citing_turn_id, cited_turn_id, relation, created_at_epoch)
         VALUES (?, ?, ?, ?)`,
      );
      for (let index = 0; index < count; index += 1) {
        const row = {
          citing: turnIds[index]!,
          cited: turnIds[index + 1]!,
          relation: relations[index % relations.length]!,
          createdAtEpoch: 1000 + index,
        };
        insert.run(row.citing, row.cited, row.relation, row.createdAtEpoch);
        rows.push(row);
      }
      return rows;
    }

    test("carries every legacy edge over with no loss of rows or content", () => {
      const legacy = seedLegacyEdges(12);
      // Same pair under two relations: the migration must keep BOTH, since the
      // edge key includes the relation.
      db.query(
        `INSERT INTO turn_citations (citing_turn_id, cited_turn_id, relation, created_at_epoch)
         VALUES (?, ?, 'supersedes', 1500)`,
      ).run(legacy[0]!.citing, legacy[0]!.cited);

      db.query("DELETE FROM memory_edges").run();
      const migrated = migrateTurnCitationsToEdges(db);

      const sourceCount = db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM turn_citations",
        )
        .get()!.count;
      expect(sourceCount).toBe(13);
      expect(migrated).toBe(13);
      expect(countMemoryEdges(db)).toBe(13);

      const missing = db
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count
           FROM turn_citations c
           WHERE NOT EXISTS (
             SELECT 1 FROM memory_edges e
             WHERE e.citing_kind = 'turn' AND e.citing_id = c.citing_turn_id
               AND e.cited_kind = 'turn' AND e.cited_id = c.cited_turn_id
               AND e.relation = c.relation
               AND e.created_at_epoch = c.created_at_epoch
               AND e.provenance = 'judged'
           )`,
        )
        .get()!.count;
      expect(missing).toBe(0);
    });

    test("is idempotent and never resurrects nor duplicates on a re-run", () => {
      seedLegacyEdges(5);
      db.query("DELETE FROM memory_edges").run();

      expect(migrateTurnCitationsToEdges(db)).toBe(5);
      const secondRun = migrateTurnCitationsToEdges(db);

      expect(secondRun).toBe(0);
      expect(countMemoryEdges(db)).toBe(5);
    });

    test("runs once when the edge table is created, not on every open", () => {
      seedLegacyEdges(3);
      // Fresh open of the same database: the table already exists, so the
      // one-time gate must not fire again.
      const before = countMemoryEdges(db);
      initializeSchema(db);

      expect(before).toBe(0);
      expect(countMemoryEdges(db)).toBe(0);
    });
  });
});
