import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  countMemoryEdges,
  reconcileCitedPairs,
  formatNodeRef,
  getEdgeInDegree,
  getExistingEdgePairKeys,
  getIncomingEdges,
  getOutgoingEdges,
  isCitationRelation,
  pairKey,
  parseNodeRef,
  retractMemoryEdges,
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

  // The four route-level "a rewrite drops its pair" tests were all written with
  // a RELATIONLESS stale target, so narrowing this delete to
  // `relation IS NULL` left three of the four green — a mutation that deletes
  // only unattributed edges would have shipped. This is the shared causal
  // witness the routes lean on: the stale pair here carries a relation, so the
  // delete has to be relation-blind to pass.
  describe("reconcileCitedPairs deletes a stale pair whatever relation it carries", () => {
    test("a relation-bearing stale pair goes, and the surviving one keeps its relation", () => {
      const citer = addTurn(1);
      const keep = addTurn(2);
      const drop = addTurn(3);

      writeMemoryEdges(
        db,
        [
          {
            citing: { kind: "turn", id: citer },
            cited: { kind: "turn", id: keep },
            relation: "depends-on",
            provenance: "judged",
          },
          {
            citing: { kind: "turn", id: citer },
            cited: { kind: "turn", id: drop },
            relation: "supersedes",
            provenance: "judged",
          },
        ],
        500,
        { eligibleForRelation: "unrestricted" },
      );
      expect(getOutgoingEdges(db, { kind: "turn", id: citer })).toHaveLength(2);

      // The body now cites only `keep`.
      reconcileCitedPairs(
        db,
        { kind: "turn", id: citer },
        [{ kind: "turn", id: keep }],
        600,
        "text-ref",
      );

      const survivors = getOutgoingEdges(db, { kind: "turn", id: citer });
      expect(survivors).toHaveLength(1);
      expect(survivors[0]!.cited).toEqual({ kind: "turn", id: keep });
      // A bare re-statement of a pair that already carries a relation must not
      // clear it (spec C14) — the reconcile is about which pairs exist, not
      // about what they mean.
      expect(survivors[0]!.relation).toBe("depends-on");
    });
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
      { eligibleForRelation: "unrestricted" },
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
      { eligibleForRelation: "unrestricted" },
    );

    expect(result.written).toHaveLength(1);
    expect(result.written[0]?.citing).toEqual({ kind: "session", id: sessionId });
    expect(result.rejected.map((entry) => entry.reason)).toEqual(["invalid-node"]);
  });

  test("re-writing the same (pair, relation) is a no-op: no second row, and the first sighting's provenance and epoch stand (D2)", () => {
    const citing = addTurn(1);
    const cited = addTurn(2);
    const edge = {
      citing: { kind: "turn" as const, id: citing },
      cited: { kind: "turn" as const, id: cited },
      relation: "depends-on" as const,
    };

    writeMemoryEdges(db, [{ ...edge, provenance: "retrieval" }], 300, { eligibleForRelation: "unrestricted" });
    writeMemoryEdges(db, [{ ...edge, provenance: "judged" }], 400, { eligibleForRelation: "unrestricted" });
    const repeat = writeMemoryEdges(db, [{ ...edge, provenance: "asserted" }], 500, { eligibleForRelation: "unrestricted" });

    const stored = getOutgoingEdges(db, edge.citing);
    expect(stored).toHaveLength(1);
    // A restatement of a claim already on file changes nothing about it —
    // neither the provenance recording how it was first learned nor the
    // moment it first appeared. (Overwriting is retired with the old upsert:
    // a relation is corrected by retraction, not by a later write silently
    // relabelling the row.)
    expect(stored[0]?.provenance).toBe("retrieval");
    expect(stored[0]?.createdAtEpoch).toBe(300);
    // The restatement still REPORTS the row it satisfied — callers count
    // `written` into receipts and eligibility sets, so a no-op must not read
    // as "nothing is stored".
    expect(repeat.written).toHaveLength(1);
    expect(repeat.written[0]?.relation).toBe("depends-on");
  });

  test("a bare write is storable, is superseded by a relation on the same pair, and never comes back over one (D2)", () => {
    const citing = addTurn(1);
    const cited = addTurn(2);

    // An unattributed citation must be storable — it is the pair's existence
    // record when nothing has classified it.
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
      { eligibleForRelation: "unrestricted" },
    );
    expect(bare.written).toHaveLength(1);
    expect(bare.written[0]?.relation).toBeNull();

    // A classification arrives for the same pair. The relation row now records
    // the pair's existence, so the bare row goes: keeping both would hand
    // every reader a duplicate of the same fact to filter out.
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
      { eligibleForRelation: "unrestricted" },
    );
    expect(getOutgoingEdges(db, { kind: "turn", id: citing })).toEqual([
      {
        citing: { kind: "turn", id: citing },
        cited: { kind: "turn", id: cited },
        relation: "supersedes",
        provenance: "judged",
        createdAtEpoch: 400,
      },
    ]);

    // A later bare re-mention neither retracts the relation nor re-opens a
    // bare row beside it: the pair is already on file.
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
      { eligibleForRelation: "unrestricted" },
    );

    expect(remention.written[0]?.relation).toBe("supersedes");
    const stored = getOutgoingEdges(db, { kind: "turn", id: citing });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.relation).toBe("supersedes");
  });

  test("a repeated bare write never yields a second bare row (D2, partial unique index)", () => {
    const citing = addTurn(1);
    const cited = addTurn(2);
    const bare = {
      citing: { kind: "turn" as const, id: citing },
      cited: { kind: "turn" as const, id: cited },
      relation: null,
      provenance: "text-ref" as const,
    };

    writeMemoryEdges(db, [bare], 300, { eligibleForRelation: "unrestricted" });
    writeMemoryEdges(db, [bare], 400, { eligibleForRelation: "unrestricted" });
    // Twice inside ONE call too — a batch is not a second chance at the same
    // duplicate.
    writeMemoryEdges(db, [bare, bare], 500, { eligibleForRelation: "unrestricted" });

    expect(countMemoryEdges(db)).toBe(1);
    const stored = getOutgoingEdges(db, bare.citing);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.relation).toBeNull();
    // First sighting, not the last restatement.
    expect(stored[0]?.createdAtEpoch).toBe(300);
  });

  test("two relations on one pair coexist, each readable, whether written in one call or two (D2)", () => {
    const citing = addTurn(1);
    const cited = addTurn(2);
    const pair = {
      citing: { kind: "turn" as const, id: citing },
      cited: { kind: "turn" as const, id: cited },
    };

    // Requirement 3's own shape: a landing turn depends on its plan AND
    // encodes the ruling it carries, about the same target.
    const oneCall = writeMemoryEdges(
      db,
      [
        { ...pair, relation: "depends-on", provenance: "asserted" },
        { ...pair, relation: "encodes", provenance: "asserted" },
      ],
      300,
      { eligibleForRelation: "unrestricted" },
    );
    expect(oneCall.rejected).toEqual([]);
    expect(oneCall.written.map((edge) => edge.relation)).toEqual([
      "depends-on",
      "encodes",
    ]);

    // A third relation from a LATER call (settlement's hindsight pass) joins
    // them rather than replacing either.
    writeMemoryEdges(
      db,
      [{ ...pair, relation: "evidence-for", provenance: "judged" }],
      400,
      { eligibleForRelation: "unrestricted" },
    );

    const stored = getOutgoingEdges(db, pair.citing);
    expect(stored.map((edge) => edge.relation)).toEqual([
      "depends-on",
      "encodes",
      "evidence-for",
    ]);
    expect(countMemoryEdges(db)).toBe(3);
    // Each keeps its own provenance and moment — they are three separate
    // claims, not one row being relabelled three times.
    expect(stored.map((edge) => [edge.provenance, edge.createdAtEpoch])).toEqual([
      ["asserted", 300],
      ["asserted", 300],
      ["judged", 400],
    ]);
    // The pair is still ONE citer of the target.
    expect(getEdgeInDegree(db, { kind: "turn", id: cited })).toBe(1);
  });

  describe("retraction (D3)", () => {
    function seedThreeWays(): { citing: number; cited: number; other: number } {
      const citing = addTurn(1);
      const cited = addTurn(2);
      const other = addTurn(3);
      writeMemoryEdges(
        db,
        [
          {
            citing: { kind: "turn", id: citing },
            cited: { kind: "turn", id: cited },
            relation: "depends-on",
            provenance: "asserted",
          },
          {
            citing: { kind: "turn", id: citing },
            cited: { kind: "turn", id: cited },
            relation: "encodes",
            provenance: "asserted",
          },
          {
            citing: { kind: "turn", id: citing },
            cited: { kind: "turn", id: other },
            relation: "depends-on",
            provenance: "asserted",
          },
        ],
        300,
        { eligibleForRelation: "unrestricted" },
      );
      return { citing, cited, other };
    }

    test("removes exactly the addressed (pair, relation) and nothing beside it", () => {
      const { citing, cited, other } = seedThreeWays();

      const result = retractMemoryEdges(db, [
        {
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: cited },
          relation: "depends-on",
        },
      ]);

      expect(result.rejected).toEqual([]);
      expect(result.deleted).toHaveLength(1);
      expect(result.deleted[0]?.relation).toBe("depends-on");
      expect(result.deleted[0]?.cited).toEqual({ kind: "turn", id: cited });
      // The pair's OTHER relation survives, and so does the same relation on a
      // different pair.
      expect(
        getOutgoingEdges(db, { kind: "turn", id: citing }).map((edge) => [
          edge.cited.id,
          edge.relation,
        ]),
      ).toEqual([
        [cited, "encodes"],
        [other, "depends-on"],
      ]);
    });

    test("relation: null addresses the bare row, and leaves a classified pair alone", () => {
      const citing = addTurn(1);
      const bareTarget = addTurn(2);
      const classified = addTurn(3);
      writeMemoryEdges(
        db,
        [
          {
            citing: { kind: "turn", id: citing },
            cited: { kind: "turn", id: bareTarget },
            relation: null,
            provenance: "text-ref",
          },
          {
            citing: { kind: "turn", id: citing },
            cited: { kind: "turn", id: classified },
            relation: "refines",
            provenance: "asserted",
          },
        ],
        300,
        { eligibleForRelation: "unrestricted" },
      );

      const bare = retractMemoryEdges(db, [
        {
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: bareTarget },
          relation: null,
        },
      ]);
      expect(bare.deleted).toHaveLength(1);
      expect(bare.deleted[0]?.relation).toBeNull();

      // A null address is NOT a wildcard: the classified pair has no bare row,
      // so retracting one there matches nothing and its relation stands.
      const wildcardAttempt = retractMemoryEdges(db, [
        {
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: classified },
          relation: null,
        },
      ]);
      expect(wildcardAttempt.deleted).toEqual([]);
      expect(wildcardAttempt.rejected.map((entry) => entry.reason)).toEqual([
        "no-such-edge",
      ]);
      expect(
        getOutgoingEdges(db, { kind: "turn", id: citing }).map((edge) => edge.relation),
      ).toEqual(["refines"]);
    });

    test("reports an address that resolved but matched nothing, and a malformed one, apart", () => {
      const { citing, cited } = seedThreeWays();

      const result = retractMemoryEdges(db, [
        {
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: cited },
          relation: "supersedes",
        },
        {
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: cited },
          relation: "invented" as never,
        },
        {
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: 0 },
          relation: "depends-on",
        },
      ]);

      expect(result.deleted).toEqual([]);
      expect(result.rejected.map((entry) => entry.reason)).toEqual([
        "no-such-edge",
        "invalid-relation",
        "invalid-node",
      ]);
      expect(countMemoryEdges(db)).toBe(3);
    });

    test("retracting a pair's last relation leaves no row — it is not downgraded to a bare citation", () => {
      const citing = addTurn(1);
      const cited = addTurn(2);
      writeMemoryEdges(
        db,
        [
          {
            citing: { kind: "turn", id: citing },
            cited: { kind: "turn", id: cited },
            relation: null,
            provenance: "text-ref",
          },
          {
            citing: { kind: "turn", id: citing },
            cited: { kind: "turn", id: cited },
            relation: "grounded-on",
            provenance: "asserted",
          },
        ],
        300,
        { eligibleForRelation: "unrestricted" },
      );

      retractMemoryEdges(db, [
        {
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: cited },
          relation: "grounded-on",
        },
      ]);

      // The bare row the relation superseded does not come back: resurrecting
      // the pair as "cited but unclassified" would re-assert something the
      // retraction never claimed. A body still naming the target restores it
      // through `reconcileCitedPairs` on the next write.
      expect(getOutgoingEdges(db, { kind: "turn", id: citing })).toEqual([]);
    });
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
      { eligibleForRelation: "unrestricted" },
    );

    expect(result.written).toHaveLength(0);
    expect(result.rejected.map((entry) => entry.reason)).toEqual([
      "self-loop",
      "invalid-node",
      "invalid-relation",
    ]);
    expect(countMemoryEdges(db)).toBe(0);
  });

  test("the table itself refuses a self-loop, so no SQL path can mint one (D2)", () => {
    const turnId = addTurn(1);
    const other = addTurn(2);

    // Not the write path this time — a raw statement, the shape a migration or
    // a hand-written repair takes. Both relation-bearing and bare.
    expect(() =>
      db
        .query(
          `INSERT INTO memory_edges
             (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, created_at_epoch)
           VALUES ('turn', ?, 'turn', ?, 'depends-on', 'asserted', 300)`,
        )
        .run(turnId, turnId),
    ).toThrow();
    expect(() =>
      db
        .query(
          `INSERT INTO memory_edges
             (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, created_at_epoch)
           VALUES ('segment', ?, 'segment', ?, NULL, 'text-ref', 300)`,
        )
        .run(7, 7),
    ).toThrow();
    // Same id across DIFFERENT kinds is not a self-loop and stays legal — the
    // id spaces are separate, so a CHECK on the ids alone would be wrong.
    expect(() =>
      db
        .query(
          `INSERT INTO memory_edges
             (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, created_at_epoch)
           VALUES ('turn', ?, 'segment', ?, 'depends-on', 'asserted', 300)`,
        )
        .run(turnId, turnId),
    ).not.toThrow();
    expect(countMemoryEdges(db)).toBe(1);
    expect(other).toBeGreaterThan(0);
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
      { eligibleForRelation: "unrestricted" },
    );

    expect(getEdgeInDegree(db, { kind: "turn", id: cited })).toBe(2);
  });

  // Ticket 07 (spec C7/C14): eligibility is OPT-IN at this primitive — a
  // caller that does not pass `eligibleForRelation` keeps writing relations
  // exactly as it did before this option existed (the whole test file above
  // this block proves that: none of those calls pass the option, and every
  // one still writes a relation-bearing edge). These tests exercise the gate
  // itself, once passed.
  describe("relation eligibility (spec C7/C14, ticket 07)", () => {
    test("a relation-bearing write is dropped when its pair is outside the eligible set", () => {
      const citing = addTurn(1);
      const cited = addTurn(2);

      const result = writeMemoryEdges(
        db,
        [
          {
            citing: { kind: "turn", id: citing },
            cited: { kind: "turn", id: cited },
            relation: "supersedes",
            provenance: "judged",
          },
        ],
        300,
        { eligibleForRelation: new Set() },
      );

      expect(result.written).toHaveLength(0);
      expect(result.rejected.map((entry) => entry.reason)).toEqual([
        "relation-ineligible",
      ]);
      expect(countMemoryEdges(db)).toBe(0);
    });

    test("a relation-bearing write lands when its pair IS in the eligible set", () => {
      const citing = addTurn(1);
      const cited = addTurn(2);
      const key = pairKey({
        citing: { kind: "turn", id: citing },
        cited: { kind: "turn", id: cited },
      });

      const result = writeMemoryEdges(
        db,
        [
          {
            citing: { kind: "turn", id: citing },
            cited: { kind: "turn", id: cited },
            relation: "supersedes",
            provenance: "judged",
          },
        ],
        300,
        { eligibleForRelation: new Set([key]) },
      );

      expect(result.written).toHaveLength(1);
      expect(result.written[0]?.relation).toBe("supersedes");
    });

    // Requirement 6: a bare pair stays legal regardless of eligibility — the
    // gate only ever looks at relation-bearing writes. An EMPTY eligible set
    // (the strictest possible value) must still let a bare write through.
    test("a bare (relation: null) write is never gated, whatever the eligible set contains", () => {
      const citing = addTurn(1);
      const cited = addTurn(2);

      const result = writeMemoryEdges(
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
        { eligibleForRelation: new Set() },
      );

      expect(result.written).toHaveLength(1);
      expect(result.written[0]?.relation).toBeNull();
    });

    test("getExistingEdgePairKeys reads only what is stored BEFORE the call, in pairKey's own currency", () => {
      const citing = addTurn(1);
      const cited = addTurn(2);
      const other = addTurn(3);

      expect(getExistingEdgePairKeys(db).size).toBe(0);

      writeMemoryEdges(
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
        { eligibleForRelation: "unrestricted" },
      );

      const snapshot = getExistingEdgePairKeys(db);
      expect(snapshot.has(
        pairKey({
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: cited },
        }),
      )).toBe(true);
      expect(snapshot.has(
        pairKey({
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: other },
        }),
      )).toBe(false);
    });
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

    // Production shape: every citation pair ALREADY exists in `memory_edges`
    // when this runs, so the fold-in's conflict behaviour decides essentially
    // every row's outcome. The earlier tests in this block empty
    // `memory_edges` first, which is exactly the shape that never exercises
    // the conflict at all — this block does not.
    describe("overlapping pair (the case production actually contains)", () => {
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

      function readEdges(pair: { citing: number; cited: number }) {
        return db
          .query<
            { relation: string | null; provenance: string; createdAtEpoch: number },
            [number, number]
          >(
            `SELECT relation, provenance, created_at_epoch AS createdAtEpoch
             FROM memory_edges
             WHERE citing_kind = 'turn' AND citing_id = ?
               AND cited_kind = 'turn' AND cited_id = ?
             ORDER BY relation ASC`,
          )
          .all(pair.citing, pair.cited);
      }

      test("the legacy relation JOINS the one already stored instead of overwriting it (D2)", () => {
        const pair = seedOverlappingPair();

        const migrated = migrateTurnCitationsToEdges(db);

        // One row added, not one row rewritten: with (pair, relation)
        // identity there is no contest for the citation side to win — the
        // legacy claim and the live one both fit, which is exactly what spec
        // C16's overwrite rule existed to work around.
        expect(migrated).toBe(1);
        expect(readEdges(pair)).toEqual([
          { relation: "depends-on", provenance: "asserted", createdAtEpoch: 2000 },
          { relation: "evidence-for", provenance: "judged", createdAtEpoch: 1000 },
        ]);
        expect(countMemoryEdges(db)).toBe(2);
      });

      test("a second call over the same overlap changes nothing", () => {
        const pair = seedOverlappingPair();

        migrateTurnCitationsToEdges(db);
        const before = readEdges(pair);
        const secondRun = migrateTurnCitationsToEdges(db);
        const after = readEdges(pair);

        expect(secondRun).toBe(0);
        expect(after).toEqual(before);
        expect(countMemoryEdges(db)).toBe(2);
      });

      // `builds-on` remaps to NULL (spec C2) — the absence of a statement
      // about the relation, not a statement that there is none. It therefore
      // carries only the pair, and the pair is already on file.
      test("a citation whose relation remapped to NULL adds nothing to a pair already recorded", () => {
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

        // No bare row appears beside the relation, and the relation is
        // untouched: a citation that says nothing about the relation cannot
        // clear one, and cannot re-record a pair already recorded.
        expect(readEdges({ citing, cited })).toEqual([
          { relation: "supersedes", provenance: "judged", createdAtEpoch: 2000 },
        ]);
        expect(migrated).toBe(0);
      });

      test("a relationless citation lands as a bare pair when nothing records the pair yet", () => {
        createLegacyTurnCitationsTable();
        const citing = addTurn(1);
        const cited = addTurn(2);
        db.query(
          `INSERT INTO turn_citations (citing_turn_id, cited_turn_id, relation, created_at_epoch)
           VALUES (?, ?, 'builds-on', 3000)`,
        ).run(citing, cited);

        expect(migrateTurnCitationsToEdges(db)).toBe(1);
        expect(readEdges({ citing, cited })).toEqual([
          { relation: null, provenance: "judged", createdAtEpoch: 3000 },
        ]);
      });
    });
  });
});

// Ticket 01 (turn-edge-mechanism spec): `supersedes` retires from the WRITE
// vocabulary `mcp/note.ts` offers, but existing edges must stay
// frozen-readable and storage-legal — no migration, no remap to `override`
// (spec: "局部替换 ≠ 整体作废"). This is a regression guard at the layer
// underneath `note.ts`, independent of the tool surface: the storage CHECK
// constraint and `isCitationRelation` both still admit it, and the four new
// words (`refines`/`override`/`encodes`/`grounded-on`) are storage-legal too.
describe("supersedes stays frozen-readable; the new relation words are storage-legal (ticket 01)", () => {
  let db: Database;
  let sessionId: number;

  function addTurn(promptNumber: number): number {
    return db
      .query<{ id: number }, [number, number]>(
        `INSERT INTO turns (session_id, prompt_number, status, title, created_at_epoch)
         VALUES (?, ?, 'extracted', 'fixture', 100) RETURNING id`,
      )
      .get(sessionId, promptNumber)!.id;
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "supersedes-frozen",
      project: "claude-mnemo",
      title: "A",
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("isCitationRelation still admits supersedes", () => {
    expect(isCitationRelation("supersedes")).toBe(true);
  });

  test("a supersedes edge (e.g. settlement's own facade) still writes and reads back unchanged", () => {
    const citing = addTurn(1);
    const cited = addTurn(2);

    const { written } = writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: cited },
          relation: "supersedes",
          provenance: "judged",
        },
      ],
      500,
      { eligibleForRelation: "unrestricted" },
    );

    expect(written).toHaveLength(1);
    expect(written[0]?.relation).toBe("supersedes");
    expect(getOutgoingEdges(db, { kind: "turn", id: citing })[0]?.relation).toBe(
      "supersedes",
    );
  });

  test("refines/override/encodes/grounded-on each pass the storage CHECK constraint", () => {
    const citing = addTurn(1);
    let promptNumber = 2;
    for (const relation of ["refines", "override", "encodes", "grounded-on"] as const) {
      const cited = addTurn(promptNumber);
      promptNumber += 1;

      const { written, rejected } = writeMemoryEdges(
        db,
        [
          {
            citing: { kind: "turn", id: citing },
            cited: { kind: "turn", id: cited },
            relation,
            provenance: "asserted",
          },
        ],
        600,
        { eligibleForRelation: "unrestricted" },
      );

      expect(rejected).toEqual([]);
      expect(written).toHaveLength(1);
      expect(written[0]?.relation).toBe(relation);
    }
  });
});
