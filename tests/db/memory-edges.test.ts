import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  canonicalizeTagSet,
  countMemoryEdges,
  deriveSideTags,
  reconcileCitedPairs,
  formatNodeRef,
  getEdgeInDegree,
  getEdgesBySideTag,
  getIncomingEdges,
  getOutgoingEdges,
  getRelationEdgesAmongTurns,
  getTurnRelationEdges,
  isCitationRelation,
  pairKey,
  parseNodeRef,
  rebuildMemoryEdgeSideTagsIndex,
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

  // Edge-mechanism-revision D1 (decoupling): prose drift owns only the BARE
  // layer. This is the causal witness the routes lean on now — a stale pair
  // that carries a relation KEEPS it (only retraction deletes a relation row),
  // while a stale bare-only pair vanishes with the prose that named it. The
  // earlier version of this test pinned the opposite ("relation-blind
  // delete"), which under decoupling let an ordinary note correction silently
  // destroy edges nobody retracted.
  describe("reconcileCitedPairs touches only the bare layer", () => {
    test("a relation-bearing stale pair survives; a bare-only stale pair goes", () => {
      const citer = addTurn(1);
      const keep = addTurn(2);
      const drop = addTurn(3);
      const bareDrop = addTurn(4);

      writeMemoryEdges(
        db,
        [
          {
            citing: { kind: "turn", id: citer },
            cited: { kind: "turn", id: keep },
            relation: "consume",
            provenance: "judged",
          },
          {
            citing: { kind: "turn", id: citer },
            cited: { kind: "turn", id: drop },
            relation: "narrows",
            provenance: "judged",
          },
          {
            citing: { kind: "turn", id: citer },
            cited: { kind: "turn", id: bareDrop },
            relation: null,
            provenance: "text-ref",
          },
        ],
        500,
      );
      expect(getOutgoingEdges(db, { kind: "turn", id: citer })).toHaveLength(3);

      // The body now cites only `keep`.
      reconcileCitedPairs(
        db,
        { kind: "turn", id: citer },
        [{ kind: "turn", id: keep }],
        600,
        "text-ref",
      );

      const survivors = getOutgoingEdges(db, { kind: "turn", id: citer });
      expect(survivors).toHaveLength(2);
      const byTarget = new Map(survivors.map((e) => [e.cited.id, e.relation]));
      // A bare re-statement of a pair that already carries a relation must not
      // clear it (spec C14), and prose withdrawing a mention must not clear a
      // relation either (D1) — the bare-only pair is the only casualty.
      expect(byTarget.get(keep)).toBe("consume");
      expect(byTarget.get(drop)).toBe("narrows");
      expect(byTarget.has(bareDrop)).toBe(false);
    });
  });

  test("node refs round-trip through the type-prefixed form", () => {
    expect(formatNodeRef({ kind: "segment", id: 47 })).toBe("segment:47");
    expect(parseNodeRef("turn:8942")).toEqual({ kind: "turn", id: 8942 });
    expect(parseNodeRef("T8942")).toBeNull();
    expect(parseNodeRef("turn:0")).toBeNull();
  });

  test("writes a BARE turn→segment edge and reads it from both ends", () => {
    const turnId = addTurn(1);
    const segment = createSegment(db, { title: "Fix the retry loop", nowEpoch: 200 });

    // container-unification D10: the relation graph is turn→turn, so a
    // turn→segment edge can only be BARE (the text-ref prose-citation index)
    // — see the dedicated rejection test below for the relation-carrying case.
    const result = writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: turnId },
          cited: { kind: "segment", id: segment.id },
          relation: null,
          provenance: "text-ref",
        },
      ],
      300,
    );

    expect(result.written).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
    expect(getOutgoingEdges(db, { kind: "turn", id: turnId })).toHaveLength(1);
    expect(getIncomingEdges(db, { kind: "segment", id: segment.id })).toEqual([
      {
        id: expect.any(Number),
        citing: { kind: "turn", id: turnId },
        cited: { kind: "segment", id: segment.id },
        relation: null,
        tailTag: "",
        headTag: "",
        // relation-vocabulary-v13 ticket 02: a bare row carries no class.
        relationClass: "",
        relationCoverage: "",
        provenance: "text-ref",
        createdAtEpoch: 300,
      },
    ]);
  });

  /**
   * container-unification D10: the relation graph is turn→turn, full stop —
   * a relation-carrying edge naming a segment on either end is refused with
   * a reported reason, the same discipline the self-loop guard uses, rather
   * than a thrown SQLITE_CONSTRAINT that would abort the whole batch.
   */
  test("a RELATION-carrying turn→segment edge is rejected (D10: relations are turn→turn only)", () => {
    const turnId = addTurn(1);
    const segment = createSegment(db, { title: "Fix the retry loop", nowEpoch: 200 });

    const result = writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: turnId },
          cited: { kind: "segment", id: segment.id },
          relation: "consume",
          provenance: "retrieval",
        },
      ],
      300,
    );

    expect(result.written).toHaveLength(0);
    expect(result.rejected).toEqual([
      {
        input: expect.objectContaining({ relation: "consume" }),
        reason: "relation-requires-turn-pair",
      },
    ]);
    expect(getOutgoingEdges(db, { kind: "turn", id: turnId })).toHaveLength(0);
  });

  test("a session may cite (citing_kind admits session, spec C10) but never be cited", () => {
    const segment = createSegment(db, { title: "Session-cited chapter", nowEpoch: 200 });

    const result = writeMemoryEdges(
      db,
      [
        {
          // BARE, not relation-carrying: container-unification D10 confines
          // every relation-carrying row to turn→turn, so a session's citation
          // is text-ref's bare existence record, same as a segment's.
          citing: { kind: "session", id: sessionId },
          cited: { kind: "segment", id: segment.id },
          relation: null,
          provenance: "text-ref",
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
    expect(result.written[0]?.relation).toBeNull();
    expect(result.rejected.map((entry) => entry.reason)).toEqual(["invalid-node"]);
  });

  /**
   * container-unification D10: a session citing WITH a relation is refused
   * the same way a segment target is (the dedicated rejection test above) —
   * `citing_kind` admitting `session` (spec C10) is about the BARE
   * text-ref population only.
   */
  test("a session citing WITH a relation is rejected (D10: relations are turn→turn only)", () => {
    const turnId = addTurn(1);

    const result = writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "session", id: sessionId },
          cited: { kind: "turn", id: turnId },
          relation: "consume",
          provenance: "asserted",
        },
      ],
      300,
    );

    expect(result.written).toHaveLength(0);
    expect(result.rejected).toEqual([
      {
        input: expect.objectContaining({ relation: "consume" }),
        reason: "relation-requires-turn-pair",
      },
    ]);
  });

  test("re-writing the same (pair, relation) is a no-op: no second row, and the first sighting's provenance and epoch stand (D2)", () => {
    const citing = addTurn(1);
    const cited = addTurn(2);
    const edge = {
      citing: { kind: "turn" as const, id: citing },
      cited: { kind: "turn" as const, id: cited },
      relation: "consume" as const,
    };

    writeMemoryEdges(db, [{ ...edge, provenance: "retrieval" }], 300);
    writeMemoryEdges(db, [{ ...edge, provenance: "judged" }], 400);
    const repeat = writeMemoryEdges(db, [{ ...edge, provenance: "asserted" }], 500);

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
    expect(repeat.written[0]?.relation).toBe("consume");
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
          relation: "narrows",
          provenance: "judged",
        },
      ],
      400,
    );
    expect(getOutgoingEdges(db, { kind: "turn", id: citing })).toEqual([
      {
        id: expect.any(Number),
        citing: { kind: "turn", id: citing },
        cited: { kind: "turn", id: cited },
        relation: "narrows",
        tailTag: "",
        headTag: "",
        // relation-vocabulary-v13 ticket 02: a direct `writeMemoryEdges` call
        // states no class, so the row is UNCLASSIFIED — exactly the shape every
        // row written before that release has.
        relationClass: "",
        relationCoverage: "",
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
    );

    expect(remention.written[0]?.relation).toBe("narrows");
    const stored = getOutgoingEdges(db, { kind: "turn", id: citing });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.relation).toBe("narrows");
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

    writeMemoryEdges(db, [bare], 300);
    writeMemoryEdges(db, [bare], 400);
    // Twice inside ONE call too — a batch is not a second chance at the same
    // duplicate.
    writeMemoryEdges(db, [bare, bare], 500);

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
        { ...pair, relation: "consume", provenance: "asserted" },
        { ...pair, relation: "grounds", provenance: "asserted" },
      ],
      300,
    );
    expect(oneCall.rejected).toEqual([]);
    expect(oneCall.written.map((edge) => edge.relation)).toEqual([
      "consume",
      "grounds",
    ]);

    // A third relation from a LATER call (settlement's hindsight pass) joins
    // them rather than replacing either.
    writeMemoryEdges(
      db,
      [{ ...pair, relation: "verifies", provenance: "judged" }],
      400,
    );

    const stored = getOutgoingEdges(db, pair.citing);
    expect(stored.map((edge) => edge.relation)).toEqual([
      "consume",
      "grounds",
      "verifies",
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
            relation: "consume",
            provenance: "asserted",
          },
          {
            citing: { kind: "turn", id: citing },
            cited: { kind: "turn", id: cited },
            relation: "grounds",
            provenance: "asserted",
          },
          {
            citing: { kind: "turn", id: citing },
            cited: { kind: "turn", id: other },
            relation: "consume",
            provenance: "asserted",
          },
        ],
        300,
      );
      return { citing, cited, other };
    }

    test("removes exactly the addressed (pair, relation) and nothing beside it", () => {
      const { citing, cited, other } = seedThreeWays();

      const result = retractMemoryEdges(db, [
        {
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: cited },
          relation: "consume",
        },
      ]);

      expect(result.rejected).toEqual([]);
      expect(result.deleted).toHaveLength(1);
      expect(result.deleted[0]?.relation).toBe("consume");
      expect(result.deleted[0]?.cited).toEqual({ kind: "turn", id: cited });
      // The pair's OTHER relation survives, and so does the same relation on a
      // different pair.
      expect(
        getOutgoingEdges(db, { kind: "turn", id: citing }).map((edge) => [
          edge.cited.id,
          edge.relation,
        ]),
      ).toEqual([
        [cited, "grounds"],
        [other, "consume"],
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
            relation: "extends",
            provenance: "asserted",
          },
        ],
        300,
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
      ).toEqual(["extends"]);
    });

    test("reports an address that resolved but matched nothing, and a malformed one, apart", () => {
      const { citing, cited } = seedThreeWays();

      const result = retractMemoryEdges(db, [
        {
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: cited },
          relation: "narrows",
        },
        {
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: cited },
          relation: "invented" as never,
        },
        {
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: 0 },
          relation: "consume",
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
            relation: "grounds",
            provenance: "asserted",
          },
        ],
        300,
      );

      retractMemoryEdges(db, [
        {
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: cited },
          relation: "grounds",
        },
      ]);

      // The bare row the relation superseded does not come back: resurrecting
      // the pair as "cited but unclassified" would re-assert something the
      // retraction never claimed. A body still naming the target restores it
      // through `reconcileCitedPairs` on the next write.
      expect(getOutgoingEdges(db, { kind: "turn", id: citing })).toEqual([]);
    });
  });

  // Ticket 05 narrowed this refusal to BARE self rows for a while;
  // lane-model-v12 D2 (ticket 04) put it back to every self row, so the case
  // below is the bare one only because that is what this fixture happens to
  // send — the next test covers the relation-carrying one.
  test("rejects a BARE self-loop and malformed nodes without writing them", () => {
    const turnId = addTurn(1);

    const result = writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: turnId },
          cited: { kind: "turn", id: turnId },
          relation: null,
          provenance: "text-ref",
        },
        {
          citing: { kind: "turn", id: turnId },
          cited: { kind: "turn", id: 0 },
          relation: "consume",
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

  // lane-model-v12 D2 (ticket 04) retracts ticket 05's "自引用" permission:
  // an edge's two ends must be DIFFERENT nodes, whatever the word. The
  // primitive no longer defers the question to the caller, because there is
  // no longer a question — the validator (`shared/turn-phase.ts`) refuses
  // every self edge with one reason, and the contracted table's own CHECK
  // refuses it under SQL that never comes through here.
  test("refuses a relation-carrying self edge too, not just the bare one (v12 D2)", () => {
    const turnId = addTurn(1);

    const result = writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: turnId },
          cited: { kind: "turn", id: turnId },
          relation: "grounds",
          provenance: "asserted",
        },
      ],
      300,
    );

    expect(result.written).toEqual([]);
    expect(result.rejected.map((entry) => entry.reason)).toEqual(["self-loop"]);
    expect(countMemoryEdges(db)).toBe(0);
  });

  /**
   * THE STANDING HALF of the same rule, and the reason M-C does not have to
   * rescan on every open. `writeMemoryEdges` above is the polite refusal; this
   * is the one that holds against a restore, a hand-written repair, or any
   * internal writer reaching past the primitive — the shapes the peer review
   * of this batch pointed out a one-shot migration can never catch.
   */
  test("the table itself refuses EVERY self row, so no SQL path can mint one (v12 D2)", () => {
    const turnId = addTurn(1);
    const other = addTurn(2);

    // Not the write path this time — a raw statement, the shape a migration or
    // a hand-written repair takes.
    expect(() =>
      db
        .query(
          `INSERT INTO memory_edges
             (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, created_at_epoch)
           VALUES ('turn', ?, 'turn', ?, 'consume', 'asserted', 300)`,
        )
        .run(turnId, turnId),
    ).toThrow(/CHECK constraint failed/);
    // The BARE row is banned by the same CHECK, regardless of kind.
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
    // BARE, not relation-carrying: container-unification D10 confines every
    // relation-carrying row to turn→turn, which this proof must not trip —
    // that CHECK is exercised on its own in the D10 test file.
    expect(() =>
      db
        .query(
          `INSERT INTO memory_edges
             (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, created_at_epoch)
           VALUES ('turn', ?, 'segment', ?, NULL, 'text-ref', 300)`,
        )
        .run(turnId, turnId),
    ).not.toThrow();
    // 1, not 2: only the cross-kind row above landed.
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
          relation: "consume",
          provenance: "retrieval",
        },
        {
          citing: { kind: "turn", id: citerB },
          cited: { kind: "turn", id: cited },
          relation: "verifies",
          provenance: "judged",
        },
      ],
      300,
    );

    expect(getEdgeInDegree(db, { kind: "turn", id: cited })).toBe(2);
  });

  // Ticket 04 (edge-mechanism-revision D6): the `relation eligibility` describe
  // block that stood here is DELETED along with the gate it tested —
  // `writeMemoryEdges`' `eligibleForRelation` option, its `relation-ineligible`
  // rejection and `getExistingEdgePairKeys` (the pre-run snapshot that fed it)
  // are all gone. Spec C7's pre-existence rule retired outright, so there is no
  // eligibility question left at this primitive: every write path answers for
  // its own relations through address resolution, phase legality and the citing
  // turn's write gate. The rest of this file is the proof the option is
  // unmissed — every call in it writes relations with no gate argument at all.

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
      // `evidence-for` lands on `verifies`; `supersedes` lands on `override`
      // (lane-model-v12 ticket 03 — the word left the CHECK the fold writes
      // into, so it can no longer pass through unchanged).
      const relationFor = (pairIndex: number): string | null =>
        db
          .query<{ relation: string | null }, [number, number]>(
            `SELECT relation FROM memory_edges
             WHERE citing_kind = 'turn' AND citing_id = ?
               AND cited_kind = 'turn' AND cited_id = ?`,
          )
          .get(legacy[pairIndex]!.citing, legacy[pairIndex]!.cited)?.relation ?? null;

      expect(relationFor(0)).toBeNull();
      expect(relationFor(1)).toBe("consume");
      expect(relationFor(2)).toBe("override");
      expect(relationFor(3)).toBe("verifies");

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
      // The `supersedes` row (remapped to `override`) beats the `builds-on`
      // row's remap-to-null under the "a real relation beats no relation"
      // collapse rule.
      const edge = db
        .query<{ relation: string | null; createdAtEpoch: number }, [number, number]>(
          `SELECT relation, created_at_epoch AS createdAtEpoch FROM memory_edges
           WHERE citing_kind = 'turn' AND citing_id = ?
             AND cited_kind = 'turn' AND cited_id = ?`,
        )
        .get(legacy[0]!.citing, legacy[0]!.cited);
      expect(edge?.relation).toBe("override");
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
           VALUES ('turn', ?, 'turn', ?, 'consume', 'asserted', 2000)`,
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
          { relation: "consume", provenance: "asserted", createdAtEpoch: 2000 },
          { relation: "verifies", provenance: "judged", createdAtEpoch: 1000 },
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
           VALUES ('turn', ?, 'turn', ?, 'narrows', 'judged', 2000)`,
        ).run(citing, cited);

        const migrated = migrateTurnCitationsToEdges(db);

        // No bare row appears beside the relation, and the relation is
        // untouched: a citation that says nothing about the relation cannot
        // clear one, and cannot re-record a pair already recorded.
        expect(readEdges({ citing, cited })).toEqual([
          { relation: "narrows", provenance: "judged", createdAtEpoch: 2000 },
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

  // lane-model-v12 tickets 08/09 (spec D1, "边的身份"): identity is
  // (pair, relation, tail_tag, head_tag), and the two SIDES are the whole of
  // what a caller states — ticket 09 deleted the legacy `tags` column they
  // used to be projected onto. This block is storage-only: the
  // canonical/declared/subset gate lives one layer up
  // (`shared/turn-phase.ts`), so what is proved here is the row shape, the
  // identity, the retraction address and the query index.
  describe("lane-model-v12 ticket 08: two-sided lane identity", () => {
    function rawSidesOf(
      db: Database,
      citing: number,
      cited: number,
    ): Array<{ tailTag: string; headTag: string }> {
      return db
        .query<{ tailTag: string; headTag: string }, [number, number]>(
          `SELECT tail_tag AS tailTag, head_tag AS headTag FROM memory_edges
           WHERE citing_kind = 'turn' AND citing_id = ?
             AND cited_kind = 'turn' AND cited_id = ?
           ORDER BY tail_tag ASC, head_tag ASC`,
        )
        .all(citing, cited);
    }

    /** The stored table's own column list — the sentinel that keeps the retired column from coming back under this name. */
    function edgeColumnNames(db: Database): string[] {
      return db
        .query<{ name: string }, []>("SELECT name FROM pragma_table_info('memory_edges')")
        .all()
        .map((row) => row.name);
    }

    test("canonicalizeTagSet still sorts and dedupes — a migration-era helper now, never a write input", () => {
      expect(canonicalizeTagSet(["b", "a", "b", "a", "c"])).toEqual(["a", "b", "c"]);
      expect(canonicalizeTagSet([])).toEqual([]);
      expect(canonicalizeTagSet(undefined)).toEqual([]);
      expect(canonicalizeTagSet(["only"])).toEqual(["only"]);
    });

    test("deriveSideTags is M-A's projection and the only direction left: one tag -> both sides, anything else -> unsettled", () => {
      expect(deriveSideTags(["lane-a"])).toEqual({ tailTag: "lane-a", headTag: "lane-a" });
      expect(deriveSideTags([])).toEqual({ tailTag: "", headTag: "" });
      // Ticket 09 deleted the INVERSE (`projectSideTagsToTagSet`) with the
      // column it wrote. Nothing replaces it: a crossing belongs to no single
      // lane, so collapsing two sides back into one set can only ever lose
      // the fact the two-sided model exists for.
      expect(deriveSideTags(["lane-a", "lane-b"])).toEqual({ tailTag: "", headTag: "" });
    });

    /**
     * THE GREP SENTINEL for ticket 09's first checkbox. Read off the STORED
     * table rather than the source text, so it also catches the column coming
     * back under a migration nobody re-read — the exact failure mode that
     * made `memoryEdgesTagSetIdentityIsStale` (db/schema.ts) rebuild a
     * contracted table straight back into the merged shape.
     */
    test("no merged lane column and no merged index survive a full open", () => {
      expect(edgeColumnNames(db)).not.toContain("tags");
      expect(edgeColumnNames(db)).toEqual(
        expect.arrayContaining(["tail_tag", "head_tag"]),
      );
      expect(
        db
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_edge_tags'",
          )
          .all(),
      ).toEqual([]);
    });

    test("a same-lane write stores the lane on BOTH side columns", () => {
      const citing = addTurn(1);
      const cited = addTurn(2);

      writeMemoryEdges(
        db,
        [
          {
            citing: { kind: "turn", id: citing },
            cited: { kind: "turn", id: cited },
            relation: "consume",
            provenance: "asserted",
            tailTag: "alpha",
            headTag: "alpha",
          },
        ],
        300,
      );

      // Raw stored values, not the mapped read side — this is the property
      // that actually lives in the database.
      expect(rawSidesOf(db, citing, cited)).toEqual([
        { tailTag: "alpha", headTag: "alpha" },
      ]);

      const stored = getOutgoingEdges(db, { kind: "turn", id: citing });
      expect(stored).toHaveLength(1);
      expect(stored[0]?.tailTag).toBe("alpha");
      expect(stored[0]?.headTag).toBe("alpha");
    });

    test("a CROSS-LANE write keeps its two ends apart", () => {
      const citing = addTurn(1);
      const cited = addTurn(2);

      writeMemoryEdges(
        db,
        [
          {
            citing: { kind: "turn", id: citing },
            cited: { kind: "turn", id: cited },
            relation: "consume",
            provenance: "asserted",
            tailTag: "lane-a",
            headTag: "lane-b",
          },
        ],
        300,
      );

      expect(rawSidesOf(db, citing, cited)).toEqual([
        { tailTag: "lane-a", headTag: "lane-b" },
      ]);
      const stored = getOutgoingEdges(db, { kind: "turn", id: citing });
      expect(stored[0]?.tailTag).toBe("lane-a");
      expect(stored[0]?.headTag).toBe("lane-b");
    });

    test("a DIFFERENT side pair on the same (pair, relation) is a SECOND, independent row", () => {
      const citing = addTurn(1);
      const cited = addTurn(2);
      const pair = {
        citing: { kind: "turn" as const, id: citing },
        cited: { kind: "turn" as const, id: cited },
        relation: "consume" as const,
        provenance: "asserted" as const,
      };

      writeMemoryEdges(db, [{ ...pair, tailTag: "laneA", headTag: "laneA" }], 300);
      writeMemoryEdges(db, [{ ...pair, tailTag: "laneB", headTag: "laneB" }], 400);

      const stored = getOutgoingEdges(db, { kind: "turn", id: citing });
      // MUTATION CHECK: a conflict target that ignored the side columns would
      // collapse these two independent facts into one row.
      expect(stored).toHaveLength(2);
      expect(stored.map((edge) => [edge.tailTag, edge.headTag])).toEqual([
        ["laneA", "laneA"],
        ["laneB", "laneB"],
      ]);
      expect(countMemoryEdges(db)).toBe(2);
      expect(stored[0]?.id).not.toBe(stored[1]?.id);
    });

    /**
     * The row ORDER of a multi-row read, which since ticket 09 is broken by
     * the two SIDES — the merged set's `tags ASC` used to be the tiebreak, and
     * removing the column removed it. `relation` alone cannot separate three
     * rows that share one, so without the side components these come back in
     * whatever order the b-tree happens to hand over and the `relations` recall
     * field renders non-deterministically.
     *
     * MUTATION: shorten `EDGE_IDENTITY_ORDER` to `"relation ASC"` — this is
     * the only test that reddens, which is why it exists (the mutation
     * survived the whole suite before it).
     */
    test("a multi-row read is ordered by the two SIDES after relation, not left to the b-tree", () => {
      const citing = addTurn(1);
      const cited = addTurn(2);
      const pair = {
        citing: { kind: "turn" as const, id: citing },
        cited: { kind: "turn" as const, id: cited },
        relation: "extends" as const,
        provenance: "asserted" as const,
      };

      // Written in an order that is neither the row-id order nor the sorted
      // one, so a query that fell back on either would be visible here.
      writeMemoryEdges(db, [{ ...pair, tailTag: "lane-c", headTag: "lane-a" }], 300);
      writeMemoryEdges(db, [{ ...pair, tailTag: "lane-a", headTag: "lane-b" }], 310);
      writeMemoryEdges(db, [{ ...pair, tailTag: "lane-a", headTag: "lane-a" }], 320);

      const expected = [
        ["lane-a", "lane-a"],
        ["lane-a", "lane-b"],
        ["lane-c", "lane-a"],
      ];
      expect(
        getOutgoingEdges(db, { kind: "turn", id: citing }).map((edge) => [
          edge.tailTag,
          edge.headTag,
        ]),
      ).toEqual(expected);
      expect(
        getIncomingEdges(db, { kind: "turn", id: cited }).map((edge) => [
          edge.tailTag,
          edge.headTag,
        ]),
      ).toEqual(expected);
      expect(
        getTurnRelationEdges(db, citing).outbound.map((edge) => [edge.tailTag, edge.headTag]),
      ).toEqual(expected);
    });

    test("a CROSSING and its same-lane namesake coexist: (a,b) and (a,a) are two rows", () => {
      const citing = addTurn(1);
      const cited = addTurn(2);
      const pair = {
        citing: { kind: "turn" as const, id: citing },
        cited: { kind: "turn" as const, id: cited },
        relation: "extends" as const,
        provenance: "asserted" as const,
      };

      writeMemoryEdges(db, [{ ...pair, tailTag: "lane-a", headTag: "lane-a" }], 300);
      writeMemoryEdges(db, [{ ...pair, tailTag: "lane-a", headTag: "lane-b" }], 400);

      expect(countMemoryEdges(db)).toBe(2);
    });

    test("re-writing the SAME side pair is an idempotent restatement: one row, first sighting stands", () => {
      const citing = addTurn(1);
      const cited = addTurn(2);
      const pair = {
        citing: { kind: "turn" as const, id: citing },
        cited: { kind: "turn" as const, id: cited },
        relation: "extends" as const,
      };

      const first = writeMemoryEdges(
        db,
        [{ ...pair, provenance: "retrieval", tailTag: "A", headTag: "B" }],
        300,
      );
      // Same sides, different provenance/time — still the same row.
      const second = writeMemoryEdges(
        db,
        [{ ...pair, provenance: "judged", tailTag: "A", headTag: "B" }],
        400,
      );

      const stored = getOutgoingEdges(db, { kind: "turn", id: citing });
      expect(stored).toHaveLength(1);
      expect(stored[0]?.tailTag).toBe("A");
      expect(stored[0]?.headTag).toBe("B");
      expect(stored[0]?.provenance).toBe("retrieval");
      expect(stored[0]?.createdAtEpoch).toBe(300);
      expect(first.written[0]?.id).toBe(second.written[0]?.id);
    });

    test("omitted sides and explicit empty strings both mean UNSETTLED, and both collide with each other", () => {
      const citing = addTurn(1);
      const cited = addTurn(2);
      const pair = {
        citing: { kind: "turn" as const, id: citing },
        cited: { kind: "turn" as const, id: cited },
        relation: "narrows" as const,
        provenance: "asserted" as const,
      };

      writeMemoryEdges(db, [pair], 300);
      writeMemoryEdges(db, [{ ...pair, tailTag: "", headTag: "" }], 400);

      const stored = getOutgoingEdges(db, { kind: "turn", id: citing });
      expect(stored).toHaveLength(1);
      expect(stored[0]?.tailTag).toBe("");
      expect(stored[0]?.headTag).toBe("");
      expect(stored[0]?.createdAtEpoch).toBe(300);
    });

    test("retraction addresses exactly ONE row: a lane-placed retraction leaves siblings untouched", () => {
      const citing = addTurn(1);
      const cited = addTurn(2);
      const pair = {
        citing: { kind: "turn" as const, id: citing },
        cited: { kind: "turn" as const, id: cited },
        relation: "override" as const,
        provenance: "asserted" as const,
      };

      writeMemoryEdges(db, [pair], 300);
      writeMemoryEdges(db, [{ ...pair, tailTag: "laneA", headTag: "laneA" }], 400);
      writeMemoryEdges(db, [{ ...pair, tailTag: "laneB", headTag: "laneB" }], 500);
      expect(countMemoryEdges(db)).toBe(3);

      const result = retractMemoryEdges(db, [
        {
          citing: pair.citing,
          cited: pair.cited,
          relation: "override",
          tailTag: "laneA",
          headTag: "laneA",
        },
      ]);

      expect(result.rejected).toEqual([]);
      expect(result.deleted).toHaveLength(1);
      expect(result.deleted[0]?.tailTag).toBe("laneA");

      const survivors = getOutgoingEdges(db, { kind: "turn", id: citing });
      expect(survivors.map((edge) => edge.tailTag).sort()).toEqual(["", "laneB"]);
    });

    test("a retraction addressing ONE side of a crossing does not match the row — an address names BOTH sides", () => {
      const citing = addTurn(1);
      const cited = addTurn(2);
      const pair = {
        citing: { kind: "turn" as const, id: citing },
        cited: { kind: "turn" as const, id: cited },
        relation: "consume" as const,
        provenance: "asserted" as const,
      };
      writeMemoryEdges(db, [{ ...pair, tailTag: "lane-a", headTag: "lane-b" }], 300);

      const wrong = retractMemoryEdges(db, [
        {
          citing: pair.citing,
          cited: pair.cited,
          relation: "consume",
          tailTag: "lane-a",
          headTag: "lane-a",
        },
      ]);
      expect(wrong.deleted).toEqual([]);
      expect(wrong.rejected[0]?.reason).toBe("no-such-edge");
      expect(countMemoryEdges(db)).toBe(1);

      const right = retractMemoryEdges(db, [
        {
          citing: pair.citing,
          cited: pair.cited,
          relation: "consume",
          tailTag: "lane-a",
          headTag: "lane-b",
        },
      ]);
      expect(right.deleted).toHaveLength(1);
      expect(countMemoryEdges(db)).toBe(0);
    });

    test("a retraction with NO side arguments still deletes exactly the UNSETTLED row, unaffected by placed siblings", () => {
      const citing = addTurn(1);
      const cited = addTurn(2);
      const pair = {
        citing: { kind: "turn" as const, id: citing },
        cited: { kind: "turn" as const, id: cited },
        relation: "consume" as const,
        provenance: "asserted" as const,
      };

      writeMemoryEdges(db, [pair], 300);
      writeMemoryEdges(db, [{ ...pair, tailTag: "laneA", headTag: "laneA" }], 400);

      const result = retractMemoryEdges(db, [
        { citing: pair.citing, cited: pair.cited, relation: "consume" },
      ]);

      expect(result.deleted).toHaveLength(1);
      expect(result.deleted[0]?.tailTag).toBe("");
      const survivors = getOutgoingEdges(db, { kind: "turn", id: citing });
      expect(survivors).toHaveLength(1);
      expect(survivors[0]?.tailTag).toBe("laneA");
    });

    describe("the query index (memory_edge_side_tags)", () => {
      /**
       * lane-model-v12 ticket 09 deleted the MERGED index this describe used
       * to check alongside the side one, so its assertions are gone rather
       * than rewritten: the merged index answered a strictly weaker question
       * (which lane is this edge INSIDE) that the side index already answers
       * per end, and there is no second table left to keep in step. The
       * grep sentinel below is what keeps it from coming back.
       */
      function sideIndexRows(
        db: Database,
      ): Array<{ edgeRowId: number; side: string; tag: string }> {
        return db
          .query<{ edgeRowId: number; side: string; tag: string }, []>(
            `SELECT edge_row_id AS edgeRowId, side, tag FROM memory_edge_side_tags
             ORDER BY edge_row_id ASC, side ASC`,
          )
          .all();
      }

      test("a CROSSING indexes one row per SIDE, and both are findable by their own tag", () => {
        const citing = addTurn(1);
        const cited = addTurn(2);

        const { written } = writeMemoryEdges(
          db,
          [
            {
              citing: { kind: "turn", id: citing },
              cited: { kind: "turn", id: cited },
              relation: "consume",
              provenance: "asserted",
              tailTag: "alpha",
              headTag: "beta",
            },
          ],
          300,
        );
        const edgeId = written[0]!.id;

        expect(sideIndexRows(db)).toEqual([
          { edgeRowId: edgeId, side: "head", tag: "beta" },
          { edgeRowId: edgeId, side: "tail", tag: "alpha" },
        ]);
        // The shape the retired merged index could not hold at all: it keyed
        // on "which lane is this edge INSIDE", and a crossing is inside
        // neither, so it went missing from every lookup. Both ends answer now.
        expect(getEdgesBySideTag(db, "alpha").map((e) => e.id)).toEqual([edgeId]);
        expect(getEdgesBySideTag(db, "beta").map((e) => e.id)).toEqual([edgeId]);
      });

      test("a same-lane edge indexes both sides under the one tag", () => {
        const citing = addTurn(1);
        const cited = addTurn(2);
        const { written } = writeMemoryEdges(
          db,
          [
            {
              citing: { kind: "turn", id: citing },
              cited: { kind: "turn", id: cited },
              relation: "consume",
              provenance: "asserted",
              tailTag: "alpha",
              headTag: "alpha",
            },
          ],
          300,
        );
        const edgeId = written[0]!.id;
        expect(sideIndexRows(db)).toEqual([
          { edgeRowId: edgeId, side: "head", tag: "alpha" },
          { edgeRowId: edgeId, side: "tail", tag: "alpha" },
        ]);
        expect(getEdgesBySideTag(db, "alpha").map((e) => e.id)).toEqual([edgeId]);
      });

      test("retraction cascades on the index: the retracted row's rows go, a sibling's stay", () => {
        const citing = addTurn(1);
        const cited = addTurn(2);
        const pair = {
          citing: { kind: "turn" as const, id: citing },
          cited: { kind: "turn" as const, id: cited },
          relation: "narrows" as const,
          provenance: "asserted" as const,
        };

        const first = writeMemoryEdges(db, [{ ...pair, tailTag: "laneA", headTag: "laneA" }], 300);
        const second = writeMemoryEdges(db, [{ ...pair, tailTag: "laneB", headTag: "laneB" }], 400);
        const firstId = first.written[0]!.id;
        const secondId = second.written[0]!.id;
        expect(sideIndexRows(db)).toHaveLength(4);

        retractMemoryEdges(db, [
          {
            citing: pair.citing,
            cited: pair.cited,
            relation: "narrows",
            tailTag: "laneA",
            headTag: "laneA",
          },
        ]);

        expect(sideIndexRows(db).map((row) => row.edgeRowId)).toEqual([secondId, secondId]);
        expect(getEdgesBySideTag(db, "laneA")).toEqual([]);
        expect(firstId).not.toBe(secondId);
      });

      test("a restatement of the same sides does not duplicate the index's rows", () => {
        const citing = addTurn(1);
        const cited = addTurn(2);
        const pair = {
          citing: { kind: "turn" as const, id: citing },
          cited: { kind: "turn" as const, id: cited },
          relation: "extends" as const,
          provenance: "asserted" as const,
        };

        writeMemoryEdges(db, [{ ...pair, tailTag: "laneA", headTag: "laneA" }], 300);
        writeMemoryEdges(db, [{ ...pair, tailTag: "laneA", headTag: "laneA" }], 400);
        writeMemoryEdges(db, [{ ...pair, tailTag: "laneA", headTag: "laneA" }], 500);

        expect(sideIndexRows(db)).toHaveLength(2);
      });

      test("rebuildMemoryEdgeSideTagsIndex reconstructs the index from the stored rows alone", () => {
        const citing = addTurn(1);
        const cited = addTurn(2);
        const other = addTurn(3);

        const a = writeMemoryEdges(
          db,
          [
            {
              citing: { kind: "turn", id: citing },
              cited: { kind: "turn", id: cited },
              relation: "consume",
              provenance: "asserted",
              tailTag: "alpha",
              headTag: "alpha",
            },
          ],
          300,
        );
        const b = writeMemoryEdges(
          db,
          [
            {
              citing: { kind: "turn", id: citing },
              cited: { kind: "turn", id: other },
              relation: "grounds",
              provenance: "asserted",
              tailTag: "gamma",
              headTag: "gamma",
            },
          ],
          400,
        );
        const expected = sideIndexRows(db);
        expect(expected.length).toBeGreaterThan(0);

        db.exec("DELETE FROM memory_edge_side_tags");
        expect(sideIndexRows(db)).toEqual([]);

        rebuildMemoryEdgeSideTagsIndex(db);

        expect(sideIndexRows(db)).toEqual(expected);
        expect(getEdgesBySideTag(db, "alpha").map((e) => e.id)).toEqual([a.written[0]!.id]);
        expect(getEdgesBySideTag(db, "gamma").map((e) => e.id)).toEqual([b.written[0]!.id]);
      });
    });

    test("a bare (untagged) write ignores any side arguments — a lane is a RELATION-level fact, not the bare existence row's", () => {
      const citing = addTurn(1);
      const cited = addTurn(2);

      const { written } = writeMemoryEdges(
        db,
        [
          {
            citing: { kind: "turn", id: citing },
            cited: { kind: "turn", id: cited },
            relation: null,
            provenance: "text-ref",
            tailTag: "ignored",
            headTag: "ignored",
          },
        ],
        300,
      );

      expect(written).toHaveLength(1);
      expect(written[0]?.tailTag).toBe("");
      expect(written[0]?.headTag).toBe("");
      expect(getEdgesBySideTag(db, "ignored")).toEqual([]);
    });
  });
});

// Edge-read-surface spec, ticket 01: `getTurnRelationEdges` is the `relations`
// recall field's ONLY data source — both directions of one turn's
// relation-carrying edges, Law-8 filtered at both ends. Exercised at the DB
// layer directly (rather than only through `recall`'s render path) so a
// filtering regression here is caught independent of the renderer above it.
describe("getTurnRelationEdges (edge-read-surface spec, ticket 01)", () => {
  let db: Database;
  let sessionId: number;
  let otherSessionId: number;

  function addTurn(
    promptNumber: number,
    options: { sessionId?: number; wasRolledBack?: boolean; status?: string } = {},
  ): number {
    return db
      .query<{ id: number }, [number, number, string, number]>(
        `INSERT INTO turns (session_id, prompt_number, status, was_rolled_back, created_at_epoch)
         VALUES (?, ?, ?, ?, 100)
         RETURNING id`,
      )
      .get(
        options.sessionId ?? sessionId,
        promptNumber,
        options.status ?? "extracted",
        options.wasRolledBack ? 1 : 0,
      )!.id;
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "session-relation-edges",
      project: "/tmp/project",
      title: null,
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
    otherSessionId = upsertSession(db, {
      contentSessionId: "session-relation-edges-other",
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

  // lane-model-v12 ticket 08: the outbound edge used to be written with a
  // TWO-TAG set, a shape no write path can mint any more — a side holds ONE
  // value. It is a placed same-lane edge now, which is what that fixture meant
  // (an edge inside one lane), and the view carries both sides.
  test("resolves both directions with relation, both side lanes, and the other endpoint's own address", () => {
    const subject = addTurn(1);
    const outboundTarget = addTurn(2);
    const inboundSource = addTurn(3);

    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: subject },
          cited: { kind: "turn", id: outboundTarget },
          relation: "override",
          provenance: "asserted",
          tailTag: "rule-ledger-tickets",
          headTag: "rule-ledger-tickets",
        },
        {
          citing: { kind: "turn", id: inboundSource },
          cited: { kind: "turn", id: subject },
          relation: "narrows",
          provenance: "asserted",
        },
      ],
      500,
    );

    const edges = getTurnRelationEdges(db, subject);

    expect(edges.outbound).toEqual([
      {
        relation: "override",
        relationClass: "",
        relationCoverage: "",
        tailTag: "rule-ledger-tickets",
        headTag: "rule-ledger-tickets",
        otherTurnId: outboundTarget,
        otherSessionId: sessionId,
        otherPromptNumber: 2,
      },
    ]);
    expect(edges.inbound).toEqual([
      {
        relation: "narrows",
        relationClass: "",
        relationCoverage: "",
        tailTag: "",
        headTag: "",
        otherTurnId: inboundSource,
        otherSessionId: sessionId,
        otherPromptNumber: 3,
      },
    ]);
  });

  test("excludes a bare (relation-NULL) pair — no word to render", () => {
    const subject = addTurn(1);
    const target = addTurn(2);
    writeMemoryEdges(
      db,
      [{ citing: { kind: "turn", id: subject }, cited: { kind: "turn", id: target }, relation: null, provenance: "text-ref" }],
      500,
    );

    const edges = getTurnRelationEdges(db, subject);
    expect(edges.outbound).toEqual([]);
    expect(edges.inbound).toEqual([]);
  });

  test("Law 8: a dormant (skipped) or deleted (rolled-back) endpoint never renders on either side", () => {
    const subject = addTurn(1);
    const dormantTarget = addTurn(2, { status: "skipped" });
    const deletedTarget = addTurn(3, { wasRolledBack: true });
    const dormantSource = addTurn(4, { status: "skipped" });
    const deletedSource = addTurn(5, { wasRolledBack: true });
    const liveTarget = addTurn(6);

    writeMemoryEdges(
      db,
      [
        { citing: { kind: "turn", id: subject }, cited: { kind: "turn", id: dormantTarget }, relation: "extends", provenance: "asserted" },
        { citing: { kind: "turn", id: subject }, cited: { kind: "turn", id: deletedTarget }, relation: "extends", provenance: "asserted" },
        { citing: { kind: "turn", id: subject }, cited: { kind: "turn", id: liveTarget }, relation: "extends", provenance: "asserted" },
        { citing: { kind: "turn", id: dormantSource }, cited: { kind: "turn", id: subject }, relation: "consume", provenance: "asserted" },
        { citing: { kind: "turn", id: deletedSource }, cited: { kind: "turn", id: subject }, relation: "consume", provenance: "asserted" },
      ],
      500,
    );

    const edges = getTurnRelationEdges(db, subject);
    expect(edges.outbound.map((edge) => edge.otherTurnId)).toEqual([liveTarget]);
    expect(edges.inbound).toEqual([]);
  });

  test("a cross-session edge resolves the other endpoint's OWN session id", () => {
    const subject = addTurn(1);
    const foreign = addTurn(21, { sessionId: otherSessionId });
    writeMemoryEdges(
      db,
      [{ citing: { kind: "turn", id: subject }, cited: { kind: "turn", id: foreign }, relation: "grounds", provenance: "asserted" }],
      500,
    );

    const edges = getTurnRelationEdges(db, subject);
    expect(edges.outbound).toEqual([
      {
        relation: "grounds",
        relationClass: "",
        relationCoverage: "",
        tailTag: "",
        headTag: "",
        otherTurnId: foreign,
        otherSessionId: otherSessionId,
        otherPromptNumber: 21,
      },
    ]);
  });

  // Ticket 05 admitted a self row and this read surface had to render it in
  // both directions; lane-model-v12 D2 (ticket 04) means one can no longer be
  // stored at all, so the surface's honest answer is that it never sees one.
  test("a self row cannot be stored any more, so neither direction ever reports one (v12 D2)", () => {
    const subject = addTurn(1);
    const written = writeMemoryEdges(
      db,
      [{ citing: { kind: "turn", id: subject }, cited: { kind: "turn", id: subject }, relation: "verifies", provenance: "asserted" }],
      500,
    );
    expect(written.rejected.map((entry) => entry.reason)).toEqual(["self-loop"]);

    const edges = getTurnRelationEdges(db, subject);
    expect(edges.outbound).toEqual([]);
    expect(edges.inbound).toEqual([]);
  });
});

// Ticket 01 (turn-edge-mechanism spec) once kept `supersedes` FROZEN-READABLE
// after retiring it from the write vocabulary: storage-legal, never
// assertable, "局部替换 ≠ 整体作废". Lane-model-v12 ticket 03 ends that state —
// M-B rewrites every stored row onto `override` and M-D takes the word (and
// `refutes` with it) out of the table's CHECK, so the storage vocabulary is
// now exactly the write vocabulary. This block is that contract's regression
// guard at the layer underneath `note.ts`: the words this project has retired
// over three tickets are all rejected the SAME way, at the
// `isCitationRelation` gate, and `override` — the survivor they all fold into
// — still passes.
describe("the retired words are cleanly rejected and override survives (tickets 01, 03, lane-model-v12/03)", () => {
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

  test("isCitationRelation no longer admits supersedes or refutes", () => {
    expect(isCitationRelation("supersedes")).toBe(false);
    expect(isCitationRelation("refutes")).toBe(false);
  });

  // The write gate refuses first, so the CHECK is never reached — but the
  // CHECK is what makes the refusal a STORAGE fact rather than a policy one,
  // and it is asserted directly here for that reason.
  test("a supersedes edge is refused by the write gate, and by the table itself", () => {
    const citing = addTurn(1);
    const cited = addTurn(2);

    const { written, rejected } = writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: cited },
          relation: "supersedes" as never,
          provenance: "judged",
        },
      ],
      500,
    );

    expect(written).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(getOutgoingEdges(db, { kind: "turn", id: citing })).toEqual([]);

    expect(() =>
      db
        .query<unknown, [number, number]>(
          `INSERT INTO memory_edges
             (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, created_at_epoch)
           VALUES ('turn', ?, 'turn', ?, 'supersedes', 'judged', 500)`,
        )
        .run(citing, cited),
    ).toThrow();
  });

  test("override still passes the storage CHECK constraint", () => {
    const citing = addTurn(1);
    const cited = addTurn(2);

    const { written, rejected } = writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: cited },
          relation: "override",
          provenance: "asserted",
        },
      ],
      600,
    );

    expect(rejected).toEqual([]);
    expect(written).toHaveLength(1);
    expect(written[0]?.relation).toBe("override");
  });

  // Flow-relations ticket 03's relation contract: these three retired words
  // are now cleanly rejected at the `isCitationRelation` write-path gate
  // (`invalid-relation`) rather than reaching the DB CHECK at all — the gate
  // and the CHECK are kept in lockstep on purpose (db/citations.ts).
  test("refines/encodes/grounded-on are retired words: cleanly rejected, not written", () => {
    const citing = addTurn(1);
    let promptNumber = 2;
    for (const relation of ["refines", "encodes", "grounded-on"] as const) {
      const cited = addTurn(promptNumber);
      promptNumber += 1;

      const { written, rejected } = writeMemoryEdges(
        db,
        [
          {
            citing: { kind: "turn", id: citing },
            cited: { kind: "turn", id: cited },
            relation: relation as never,
            provenance: "asserted",
          },
        ],
        600,
      );

      expect(written).toEqual([]);
      expect(rejected.map((entry) => entry.reason)).toEqual(["invalid-relation"]);
    }
  });
});

// lane-model-v12 ticket 07 — the ELECTION's own DB feed reads the two side
// columns, not the merged `tags` set. `shared/milestone-election.ts` consumes
// this shape directly as `LaneEdgeInput`, so a side dropped here is a side the
// election silently reads as unsettled.
describe("getRelationEdgesAmongTurns carries both side columns (lane-model-v12 ticket 07)", () => {
  let db: Database;
  let sessionId: number;

  function addTurn(promptNumber: number): number {
    return db
      .query<{ id: number }, [number, number]>(
        `INSERT INTO turns (session_id, prompt_number, status, title, created_at_epoch)
         VALUES (?, ?, 'active', 'fixture', 100) RETURNING id`,
      )
      .get(sessionId, promptNumber)!.id;
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "side-columns",
      project: "claude-mnemo",
      title: "A",
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
      content: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("a settled edge reports its tag on BOTH sides; an unsettled one reports the empty sentinel on both", () => {
    const t1 = addTurn(1);
    const t2 = addTurn(2);
    writeMemoryEdges(
      db,
      [
        { citing: { kind: "turn", id: t2 }, cited: { kind: "turn", id: t1 }, relation: "extends", provenance: "asserted", ...deriveSideTags(["lane-a"]) },
        { citing: { kind: "turn", id: t2 }, cited: { kind: "turn", id: t1 }, relation: "consume", provenance: "asserted", ...deriveSideTags([]) },
      ],
      100,
    );
    const rows = getRelationEdgesAmongTurns(db, [t1, t2]);
    const settled = rows.find((row) => row.relation === "extends")!;
    const unsettled = rows.find((row) => row.relation === "consume")!;
    expect([settled.tailTag, settled.headTag]).toEqual(["lane-a", "lane-a"]);
    expect([unsettled.tailTag, unsettled.headTag]).toEqual(["", ""]);
  });

  test("a CROSS-LANE row keeps its two ends apart — the fact the merged `tags` set cannot carry", () => {
    const t1 = addTurn(1);
    const t2 = addTurn(2);
    writeMemoryEdges(
      db,
      [{ citing: { kind: "turn", id: t2 }, cited: { kind: "turn", id: t1 }, relation: "consume", provenance: "asserted", ...deriveSideTags(["lane-a"]) }],
      100,
    );
    // Settled directly: `writeMemoryEdges` can only ever produce `tail === head`
    // today (`deriveSideTags`); ticket 08's write gate is what accepts a
    // genuine crossing, and storage already holds one.
    db.query(
      `UPDATE memory_edges SET tail_tag = 'lane-a', head_tag = 'lane-b'
       WHERE citing_id = ? AND cited_id = ? AND relation = 'consume'`,
    ).run(t2, t1);

    const row = getRelationEdgesAmongTurns(db, [t1, t2]).find((entry) => entry.relation === "consume")!;
    expect(row.tailTag).toBe("lane-a");
    expect(row.headTag).toBe("lane-b");
    // The tail is the CITING side and the head the CITED one — not the
    // reverse, and not two values a reader has to guess the order of.
    expect(row.citingId).toBe(t2);
    expect(row.citedId).toBe(t1);
  });
});
