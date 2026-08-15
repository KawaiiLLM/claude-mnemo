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
          relation: "depends-on",
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
        relation: "depends-on",
        provenance: "retrieval",
        createdAtEpoch: 300,
      },
    ]);
  });

  test("a session may cite (citing_kind admits session, spec C10) but never be cited", () => {
    const segment = createSegment(db, { title: "Session-cited chapter", nowEpoch: 200 });

    const result = writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "session", id: sessionId },
          cited: { kind: "segment", id: segment.id },
          relation: "depends-on",
          provenance: "asserted",
        },
        {
          // A session can never be the TARGET of a relation — nothing "flows
          // trust" toward a container the way it does toward a conclusion.
          citing: { kind: "segment", id: segment.id },
          cited: { kind: "session", id: sessionId } as never,
          relation: null,
          provenance: "text-ref",
        },
      ],
      300,
    );

    expect(result.written).toHaveLength(1);
    expect(result.written[0]?.citing).toEqual({ kind: "session", id: sessionId });
    expect(result.rejected.map((entry) => entry.reason)).toEqual(["invalid-node"]);
  });

  test("re-writing a pair is idempotent, and a later relation-bearing write replaces provenance outright (spec C14: no rank test)", () => {
    const citing = addTurn(1);
    const cited = addTurn(2);
    const edge = {
      citing: { kind: "turn" as const, id: citing },
      cited: { kind: "turn" as const, id: cited },
      relation: "depends-on" as const,
    };

    writeMemoryEdges(db, [{ ...edge, provenance: "retrieval" }], 300);
    writeMemoryEdges(db, [{ ...edge, provenance: "judged" }], 400);
    writeMemoryEdges(db, [{ ...edge, provenance: "retrieval" }], 500);

    const stored = getOutgoingEdges(db, edge.citing);
    expect(stored).toHaveLength(1);
    // The LAST relation-bearing write's provenance wins outright — no
    // upward-only ratchet, because no rank test stands between an authorised
    // write and the relation/provenance it sets.
    expect(stored[0]?.provenance).toBe("retrieval");
    // First-sighting epoch survives: "when did this edge appear" stays answerable.
    expect(stored[0]?.createdAtEpoch).toBe(300);
  });

  test("a bare (relation-less) write can be stored, and never clears an existing relation", () => {
    const citing = addTurn(1);
    const cited = addTurn(2);

    // An unattributed citation — spec C5's whole point — must be storable.
    const bare = writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: cited },
          relation: null,
          provenance: "text-ref",
        },
      ],
      300,
    );
    expect(bare.written).toHaveLength(1);
    expect(bare.written[0]?.relation).toBeNull();

    // A judged classification attaches to the same pair (spec C6/C7 territory,
    // but the DB layer must support it): a correction updates the row.
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: cited },
          relation: "supersedes",
          provenance: "judged",
        },
      ],
      400,
    );

    // A later bare re-mention (weaker signal) must NOT retract the relation.
    const remention = writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: cited },
          relation: null,
          provenance: "text-ref",
        },
      ],
      500,
    );

    expect(remention.written[0]?.relation).toBe("supersedes");
    const stored = getOutgoingEdges(db, { kind: "turn", id: citing });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.relation).toBe("supersedes");
    expect(stored[0]?.createdAtEpoch).toBe(300);
  });

  test("correcting a relation replaces the attribute rather than inserting a second row", () => {
    const citing = addTurn(1);
    const cited = addTurn(2);
    const pair = {
      citing: { kind: "turn" as const, id: citing },
      cited: { kind: "turn" as const, id: cited },
    };

    writeMemoryEdges(
      db,
      [{ ...pair, relation: "depends-on", provenance: "judged" }],
      300,
    );
    // Same-rank correction (another `judged` pass revising the earlier one) —
    // must land as an UPDATE of the one row, not a second edge.
    writeMemoryEdges(
      db,
      [{ ...pair, relation: "supersedes", provenance: "judged" }],
      400,
    );

    expect(countMemoryEdges(db)).toBe(1);
    const stored = getOutgoingEdges(db, pair.citing);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.relation).toBe("supersedes");
  });

  test("settlement corrects a relation the main agent asserted — no rank stands in the way (spec C7/C14)", () => {
    const citing = addTurn(1);
    const cited = addTurn(2);
    const pair = {
      citing: { kind: "turn" as const, id: citing },
      cited: { kind: "turn" as const, id: cited },
    };

    // The main agent's own write, `asserted` — the highest-ranked provenance
    // under the OLD (removed) ordering.
    writeMemoryEdges(
      db,
      [{ ...pair, relation: "depends-on", provenance: "asserted" }],
      300,
    );
    // Settlement later corrects it with hindsight. This is exactly the
    // operation spec C7 exists to permit — a rank gate that made an
    // `asserted` relation permanently immune to correction made C7
    // unimplementable, which is why C14 removes it.
    writeMemoryEdges(
      db,
      [{ ...pair, relation: "supersedes", provenance: "judged" }],
      400,
    );

    const stored = getOutgoingEdges(db, pair.citing);
    expect(stored[0]?.relation).toBe("supersedes");
    expect(stored[0]?.provenance).toBe("judged");
  });

  test("naming the same target under two different relations in one call rejects both", () => {
    const citing = addTurn(1);
    const cited = addTurn(2);

    const result = writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: cited },
          relation: "evidence-for",
          provenance: "judged",
        },
        {
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: cited },
          relation: "depends-on",
          provenance: "judged",
        },
      ],
      300,
    );

    expect(result.written).toHaveLength(0);
    expect(result.rejected.map((entry) => entry.reason)).toEqual([
      "conflicting-relation",
      "conflicting-relation",
    ]);
    expect(countMemoryEdges(db)).toBe(0);
  });

  test("rejects self-loops and malformed nodes without writing them", () => {
    const turnId = addTurn(1);

    const result = writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: turnId },
          cited: { kind: "turn", id: turnId },
          relation: "depends-on",
          provenance: "text-ref",
        },
        {
          citing: { kind: "turn", id: turnId },
          cited: { kind: "turn", id: 0 },
          relation: "depends-on",
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
          relation: "depends-on",
          provenance: "retrieval",
        },
        {
          citing: { kind: "turn", id: citerB },
          cited: { kind: "turn", id: cited },
          relation: "evidence-for",
          provenance: "judged",
        },
      ],
      300,
    );

    expect(getEdgeInDegree(db, { kind: "turn", id: cited })).toBe(2);
  });

  describe("legacy turn_citations retirement (spec C13)", () => {
    // The legacy table no longer ships in fresh schema (ticket 05 retires it),
    // so a fixture that wants one recreates its exact pre-ticket-05 shape —
    // the same discipline schema.test.ts's migration fixtures use.
    function createLegacyTurnCitationsTable(): void {
      db.exec(`
        CREATE TABLE turn_citations (
          citing_turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
          cited_turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
          relation TEXT NOT NULL CHECK (
            relation IN ('builds-on', 'implements', 'supersedes', 'evidence-for')
          ),
          created_at_epoch INTEGER NOT NULL,
          PRIMARY KEY (citing_turn_id, cited_turn_id, relation)
        );
      `);
    }

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

    test("carries every legacy pair over, remapping the retired vocabulary", () => {
      createLegacyTurnCitationsTable();
      const legacy = seedLegacyEdges(12);

      db.query("DELETE FROM memory_edges").run();
      const migrated = migrateTurnCitationsToEdges(db);

      const sourceCount = db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM turn_citations",
        )
        .get()!.count;
      expect(sourceCount).toBe(12);
      // One row per PAIR (spec C5) — the legacy table's wider key is gone, so
      // migrating 12 distinct pairs yields 12 rows, not 12 relations.
      expect(migrated).toBe(12);
      expect(countMemoryEdges(db)).toBe(12);

      // Spot-check the remap: `implements` (index 1, 5, 9) → `depends-on`;
      // `builds-on` (index 0, 4, 8) → no relation, pair preserved;
      // `supersedes`/`evidence-for` pass through unchanged.
      const relationFor = (pairIndex: number): string | null =>
        db
          .query<{ relation: string | null }, [number, number]>(
            `SELECT relation FROM memory_edges
             WHERE citing_kind = 'turn' AND citing_id = ?
               AND cited_kind = 'turn' AND cited_id = ?`,
          )
          .get(legacy[pairIndex]!.citing, legacy[pairIndex]!.cited)?.relation ?? null;

      expect(relationFor(0)).toBeNull();
      expect(relationFor(1)).toBe("depends-on");
      expect(relationFor(2)).toBe("supersedes");
      expect(relationFor(3)).toBe("evidence-for");

      const provenances = db
        .query<{ provenance: string }, []>(
          "SELECT DISTINCT provenance FROM memory_edges",
        )
        .all()
        .map((row) => row.provenance);
      expect(provenances).toEqual(["judged"]);
    });

    test("collapses a pair the legacy table held under two relations to one row", () => {
      createLegacyTurnCitationsTable();
      const legacy = seedLegacyEdges(1);
      // Same pair under a second, distinct legacy relation — legal there
      // because relation was part of the old key.
      db.query(
        `INSERT INTO turn_citations (citing_turn_id, cited_turn_id, relation, created_at_epoch)
         VALUES (?, ?, 'supersedes', 1500)`,
      ).run(legacy[0]!.citing, legacy[0]!.cited);

      db.query("DELETE FROM memory_edges").run();
      const migrated = migrateTurnCitationsToEdges(db);

      expect(migrated).toBe(1);
      expect(countMemoryEdges(db)).toBe(1);
      // `supersedes` beats the `builds-on` row's remap-to-null under the
      // "a real relation beats no relation" collapse rule.
      const edge = db
        .query<{ relation: string | null; createdAtEpoch: number }, [number, number]>(
          `SELECT relation, created_at_epoch AS createdAtEpoch FROM memory_edges
           WHERE citing_kind = 'turn' AND citing_id = ?
             AND cited_kind = 'turn' AND cited_id = ?`,
        )
        .get(legacy[0]!.citing, legacy[0]!.cited);
      expect(edge?.relation).toBe("supersedes");
      // The earliest timestamp across the group survives the collapse.
      expect(edge?.createdAtEpoch).toBe(1000);
    });

    test("is idempotent and never resurrects nor duplicates on a re-run", () => {
      createLegacyTurnCitationsTable();
      seedLegacyEdges(5);
      db.query("DELETE FROM memory_edges").run();

      expect(migrateTurnCitationsToEdges(db)).toBe(5);
      const secondRun = migrateTurnCitationsToEdges(db);

      expect(secondRun).toBe(0);
      expect(countMemoryEdges(db)).toBe(5);
    });

    test("does nothing when the legacy table does not exist", () => {
      expect(migrateTurnCitationsToEdges(db)).toBe(0);
      expect(countMemoryEdges(db)).toBe(0);
    });

    // Second review round (spec C16). Production shape: every citation pair
    // ALREADY exists in `memory_edges` when this runs, so the fold-in's
    // conflict clause decides essentially every row's outcome. The earlier
    // tests in this block empty `memory_edges` first, which is exactly the
    // shape that never exercises the conflict at all — this test does not.
    describe("overlapping pair (spec C16, the case production actually contains)", () => {
      function seedOverlappingPair(): {
        citing: number;
        cited: number;
      } {
        createLegacyTurnCitationsTable();
        const citing = addTurn(1);
        const cited = addTurn(2);
        // The legacy citation table's row: a real, DIFFERENT relation, and the
        // EARLIER timestamp.
        db.query(
          `INSERT INTO turn_citations (citing_turn_id, cited_turn_id, relation, created_at_epoch)
           VALUES (?, ?, 'evidence-for', 1000)`,
        ).run(citing, cited);
        // The edge table already holds the SAME pair — e.g. written live
        // between schema init and this fold-in — under a DIFFERENT relation
        // and a LATER timestamp. If the edge row's timestamp were the earlier
        // one, the MIN rule would be unobservable (nothing to prove).
        db.query(
          `INSERT INTO memory_edges
             (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, created_at_epoch)
           VALUES ('turn', ?, 'turn', ?, 'depends-on', 'asserted', 2000)`,
        ).run(citing, cited);
        return { citing, cited };
      }

      function readEdge(pair: { citing: number; cited: number }) {
        return db
          .query<
            { relation: string | null; provenance: string; createdAtEpoch: number },
            [number, number]
          >(
            `SELECT relation, provenance, created_at_epoch AS createdAtEpoch
             FROM memory_edges
             WHERE citing_kind = 'turn' AND citing_id = ?
               AND cited_kind = 'turn' AND cited_id = ?`,
          )
          .get(pair.citing, pair.cited);
      }

      test("the citation side's relation and provenance win, and the earlier timestamp survives", () => {
        const pair = seedOverlappingPair();

        const migrated = migrateTurnCitationsToEdges(db);

        expect(migrated).toBe(1);
        const edge = readEdge(pair);
        // The citation table's relation ('evidence-for') beats the edge
        // table's ('depends-on') outright — no rank test, C16's own rule.
        expect(edge?.relation).toBe("evidence-for");
        expect(edge?.provenance).toBe("judged");
        // The EARLIER of the two timestamps (1000, not the edge row's 2000)
        // survives.
        expect(edge?.createdAtEpoch).toBe(1000);
        expect(countMemoryEdges(db)).toBe(1);
      });

      test("a second call over the same overlap changes nothing", () => {
        const pair = seedOverlappingPair();

        migrateTurnCitationsToEdges(db);
        const before = readEdge(pair);
        const secondRun = migrateTurnCitationsToEdges(db);
        const after = readEdge(pair);

        expect(secondRun).toBe(0);
        expect(after).toEqual(before);
        expect(countMemoryEdges(db)).toBe(1);
      });

      // C16's win is conditional on the citation SAYING something. `builds-on`
      // remaps to NULL (spec C2) — the absence of a statement about the
      // relation, not a statement that there is none. Unconditional, the
      // fold-in would carry that NULL over a relation settlement had
      // corrected, in one irreversible pass that then drops the source table.
      test("a citation whose relation remapped to NULL contributes the pair, never a cleared relation", () => {
        createLegacyTurnCitationsTable();
        const citing = addTurn(1);
        const cited = addTurn(2);
        db.query(
          `INSERT INTO turn_citations (citing_turn_id, cited_turn_id, relation, created_at_epoch)
           VALUES (?, ?, 'builds-on', 1000)`,
        ).run(citing, cited);
        // The edge side carries a real relation — the exact shape an
        // unconditional citation win would erase.
        db.query(
          `INSERT INTO memory_edges
             (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, created_at_epoch)
           VALUES ('turn', ?, 'turn', ?, 'supersedes', 'judged', 2000)`,
        ).run(citing, cited);

        const migrated = migrateTurnCitationsToEdges(db);

        const edge = readEdge({ citing, cited });
        expect(edge?.relation).toBe("supersedes");
        expect(edge?.provenance).toBe("judged");
        // The age still corrects: the timestamp is pooled independently of the
        // relation, so a relationless citation that predates the edge moves it
        // earlier — which is also the change this call reports.
        expect(edge?.createdAtEpoch).toBe(1000);
        expect(migrated).toBe(1);
      });

      test("a relationless citation with nothing new to say changes nothing at all", () => {
        createLegacyTurnCitationsTable();
        const citing = addTurn(1);
        const cited = addTurn(2);
        db.query(
          `INSERT INTO turn_citations (citing_turn_id, cited_turn_id, relation, created_at_epoch)
           VALUES (?, ?, 'builds-on', 3000)`,
        ).run(citing, cited);
        db.query(
          `INSERT INTO memory_edges
             (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, created_at_epoch)
           VALUES ('turn', ?, 'turn', ?, 'supersedes', 'judged', 2000)`,
        ).run(citing, cited);

        expect(migrateTurnCitationsToEdges(db)).toBe(0);
        expect(readEdge({ citing, cited })).toEqual({
          relation: "supersedes",
          provenance: "judged",
          createdAtEpoch: 2000,
        });
      });
    });
  });
});
