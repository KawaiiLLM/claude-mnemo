import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  canonicalizeTagSet,
  CITING_NODE_KINDS,
  countMemoryEdges,
  deriveSideTags,
  EDGE_NODE_KINDS,
  formatNodeRef,
  getEdgeInDegree,
  getEdgesBySideTag,
  getIncomingEdges,
  getOutgoingEdges,
  getRelationEdgesAmongTurns,
  getTurnRelationEdges,
  pairKey,
  parseNodeRef,
  rebuildMemoryEdgeSideTagsIndex,
  retractMemoryEdges,
  writeMemoryEdges,
} from "../../src/db/memory-edges";
import { initializeSchema, migrateTurnCitationsToEdges } from "../../src/db/schema";
import { createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { wordEdgeClass } from "../support/edge-row-fixtures";
import { displayEdgeRelation } from "../../src/shared/relation-class";
import { downgradeToPreCutoverShape, seedPreCutoverEdge } from "../support/pre-cutover-edge-shape";

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

  /**
   * A LEGACY row, written PAST the write path.
   *
   * main-agent-edges D5 made the pair the whole of a row's identity, so no
   * writer can mint a second row for one pair any more, and D1 retired the
   * wordless write outright. Production still holds both populations — 109
   * multi-row pairs and the whole bare layer — until ticket 01's cutover folds
   * and deletes them, and the reads and the retraction below are exercised
   * over exactly that stock. So a fixture that needs one seeds it in SQL
   * rather than pretending `writeMemoryEdges` will still produce it.
   */
  /**
   * A PRE-CUTOVER row, written past the write path AND past the current
   * schema: the rebuilt `memory_edges` is UNIQUE on the pair and has no word
   * column, so a wordless row and a second row on one pair exist only on a
   * database whose cutover is still deferred behind D9's claim fence. The
   * fixture puts the table back into that shape (idempotent) and seeds there —
   * which is the state the readers under test still have to be right about.
   */
  function legacyEdge(
    citing: number,
    cited: number,
    relation: string | null,
    createdAtEpoch: number,
    sides: { tailTag?: string; headTag?: string; relationClass?: "correct" | "verify" | "use" } = {},
  ): number {
    downgradeToPreCutoverShape(db);
    return seedPreCutoverEdge(db, {
      citingId: citing,
      citedId: cited,
      relation,
      relationClass: sides.relationClass ?? "",
      tailTag: sides.tailTag ?? "",
      headTag: sides.headTag ?? "",
      createdAtEpoch,
    });
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

  // `reconcileCitedPairs` IS DELETED (main-agent-edges D1 / R10-2), and the
  // `describe` block that pinned its one rule went with it: prose drift owned
  // only the BARE layer, so a stale pair carrying a relation kept it while a
  // stale bare-only pair vanished with the prose that named it.
  //
  // Half of that rule is now true by construction rather than by test: no
  // code path reads a citing node's prose on the way to `memory_edges` at
  // all, so an ordinary note correction cannot destroy an edge nobody
  // retracted. The other half — the bare layer itself — is the population D1
  // retires, and `writeMemoryEdges` refuses to mint another row of it
  // (`bare-row-retired`, pinned in `tests/db/logical-edge-writes.test.ts`).

  test("node refs round-trip through the type-prefixed form", () => {
    expect(formatNodeRef({ kind: "segment", id: 47 })).toBe("segment:47");
    expect(parseNodeRef("turn:8942")).toEqual({ kind: "turn", id: 8942 });
    expect(parseNodeRef("T8942")).toBeNull();
    expect(parseNodeRef("turn:0")).toBeNull();
  });

  /**
   * MAIN-AGENT-EDGES D1. What stood here was "writes a BARE turn→segment edge
   * and reads it from both ends" — the text-ref prose-citation index, written
   * with `relation: null` and read back from either endpoint. That WRITE PATH
   * is retired: a wordless input is refused BY NAME, because the pair-existence
   * record it produced is a fact nothing acts on and the prose it stood for is
   * still reachable through `parseInlineCitations`.
   *
   * The old case carried a second claim worth keeping, and it is the reason
   * this test is a replacement rather than a deletion: the table's STRUCTURAL
   * capacity to name a segment on the cited side, which pre-cutover rows still
   * use. So the capacity is asserted where it is DECLARED (`EDGE_NODE_KINDS`),
   * and the write path is asserted to refuse.
   */
  test("`segment` stays a declared edge-node kind, and the wordless write onto one is refused by name (D1)", () => {
    const turnId = addTurn(1);
    const segment = createSegment(db, { title: "Fix the retry loop", nowEpoch: 200 });

    expect(EDGE_NODE_KINDS).toContain("segment");

    const result = writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: turnId },
          cited: { kind: "segment", id: segment.id },
          relationClass: null as never,
          provenance: "text-ref",
        },
      ],
      300,
    );

    expect(result.written).toEqual([]);
    expect(result.rejected.map((entry) => entry.reason)).toEqual([
      "invalid-relation",
    ]);
    expect(getOutgoingEdges(db, { kind: "turn", id: turnId })).toEqual([]);
    expect(getIncomingEdges(db, { kind: "segment", id: segment.id })).toEqual([]);
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
          ...wordEdgeClass("consume"),
          provenance: "retrieval",
        },
      ],
      300,
    );

    expect(result.written).toHaveLength(0);
    expect(result.rejected).toEqual([
      {
        input: expect.objectContaining({ relationClass: "use" }),
        reason: "relation-requires-turn-pair",
      },
    ]);
    expect(getOutgoingEdges(db, { kind: "turn", id: turnId })).toHaveLength(0);
  });

  /**
   * The same replacement the segment case above gets, for spec C10's other
   * half. `citing_kind` still ADMITS `session` — that capacity is what
   * pre-cutover rows written from a session summary field occupy — but the
   * only write that ever used it was the wordless one main-agent-edges D1
   * retired, so the capacity is asserted where it is declared and the write
   * path is asserted to refuse. The asymmetry survives untouched: a session is
   * never a citation TARGET, and that rejection is not about wordlessness at
   * all, so it keeps its own name.
   */
  test("`session` is a declared CITING kind and never a cited one — and the wordless write it took is refused by name (C10 + D1)", () => {
    const segment = createSegment(db, { title: "Session-cited chapter", nowEpoch: 200 });

    expect(CITING_NODE_KINDS).toContain("session");
    expect(EDGE_NODE_KINDS as readonly string[]).not.toContain("session");

    const result = writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "session", id: sessionId },
          cited: { kind: "segment", id: segment.id },
          relationClass: null as never,
          provenance: "text-ref",
        },
        {
          // A session can never be the TARGET of a relation — nothing "flows
          // trust" toward a container the way it does toward a conclusion.
          // Checked before the wordless refusal, so this input still reports
          // the malformed address rather than the retired write path.
          citing: { kind: "segment", id: segment.id },
          cited: { kind: "session", id: sessionId } as never,
          ...wordEdgeClass("consume"),
          provenance: "text-ref",
        },
      ],
      300,
    );

    expect(result.written).toEqual([]);
    expect(result.rejected.map((entry) => entry.reason)).toEqual([
      "invalid-relation",
      "invalid-node",
    ]);
    expect(countMemoryEdges(db)).toBe(0);
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
          ...wordEdgeClass("consume"),
          provenance: "asserted",
        },
      ],
      300,
    );

    expect(result.written).toHaveLength(0);
    expect(result.rejected).toEqual([
      {
        input: expect.objectContaining({ relationClass: "use" }),
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
      ...wordEdgeClass("consume"),
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
    expect(displayEdgeRelation(repeat.written[0]!)).toBe("use");
  });

  /**
   * MAIN-AGENT-EDGES D1, the half of the retired bare layer that still has a
   * live behaviour to pin. Three cases stood here — "a bare write is storable",
   * "a repeated bare write never yields a second bare row", and the
   * supersession this keeps — and the first two are gone with the write path:
   * nothing mints a wordless row, so "storable" and "not duplicated" are
   * claims about a population no caller can create. The refusal that replaced
   * them is asserted by name above and in `logical-edge-writes.test.ts`.
   *
   * What SURVIVES is the displacement: pre-cutover stock still holds wordless
   * rows, and a relation write onto such a pair drops the one it finds, so
   * bare and relation rows never coexist on the pair on the way out. The bare
   * row is therefore seeded in SQL — `writeMemoryEdges` will not produce one.
   */
  test("a relation write DISPLACES the pair's PRE-CUTOVER wordless row, and no wordless write can re-open one (D1)", () => {
    const citing = addTurn(1);
    const cited = addTurn(2);

    legacyEdge(citing, cited, null, 300);
    expect(countMemoryEdges(db)).toBe(1);

    // A classification arrives for the same pair. The relation row now records
    // the pair's existence, so the bare row goes: keeping both would hand
    // every reader a duplicate of the same fact to filter out.
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: cited },
          ...wordEdgeClass("narrows"),
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
        tailTag: "",
        headTag: "",
        // Every write states its class after the cutover: `relationClass` is
        // REQUIRED on the input and NOT NULL on the row.
        relationClass: "correct",
        relationCoverage: "partial",
        provenance: "judged",
        createdAtEpoch: 400,
      },
    ]);

    // A later bare re-mention neither retracts the relation nor re-opens a
    // bare row beside it — it does not reach storage at all.
    const remention = writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: cited },
          relationClass: null as never,
          provenance: "text-ref",
        },
      ],
      500,
    );

    expect(remention.written).toEqual([]);
    expect(remention.rejected.map((entry) => entry.reason)).toEqual([
      "invalid-relation",
    ]);
    const stored = getOutgoingEdges(db, { kind: "turn", id: citing });
    expect(stored).toHaveLength(1);
    expect(displayEdgeRelation(stored[0]!)).toBe("correct(partial)");
  });

  // DELETED (main-agent-edges D5): "two relations on one pair coexist, each
  // readable, whether written in one call or two (D2)". Identity is the PAIR
  // now — one pair, one row — so a second class on a pair no longer mints a
  // second row to read back: it PROMOTES the stored one when it is strictly
  // more specific and is a no-op when it is not. That precedence, and the fact
  // that a promotion preserves the row's id, provenance and creation time, is
  // pinned in `tests/db/logical-edge-writes.test.ts`. The in-degree claim this
  // case ended on ("the pair is still ONE citer of the target") outlives it in
  // "in-degree counts distinct citers, not claims" below.

  /**
   * RETRACTION IS PAIR-ADDRESSED (main-agent-edges D4/D5, ruling T2432 P1).
   * The address used to be (pair, relation, tail, head) — the physical row key
   * — which made a retraction's success depend on the caller knowing which of
   * seven storage words a class had landed under and which lanes somebody else
   * had since declared on it. Under one-pair-one-row the address that names
   * the edge is the pair, and EVERY row of it goes, a pre-cutover wordless one
   * included. The CLASS precondition a caller may still want is checked one
   * layer up, in `db/citations.ts`'s `retractTurnRelations`
   * (`tests/db/logical-edge-writes.test.ts`).
   */
  describe("retraction (D3)", () => {
    function seedThreeWays(): { citing: number; cited: number; other: number } {
      const citing = addTurn(1);
      const cited = addTurn(2);
      const other = addTurn(3);
      // A LEGACY MULTI-ROW PAIR: no writer can mint the second row any more
      // (D5), and taking ALL of a pair's rows is exactly what this block has
      // to prove over the stock ticket 01's cutover has yet to fold.
      legacyEdge(citing, cited, "consume", 300);
      legacyEdge(citing, cited, "grounds", 300);
      writeMemoryEdges(
        db,
        [
          {
            citing: { kind: "turn", id: citing },
            cited: { kind: "turn", id: other },
            ...wordEdgeClass("consume"),
            provenance: "asserted",
          },
        ],
        300,
      );
      return { citing, cited, other };
    }

    test("removes EVERY row of the addressed pair and nothing beside it", () => {
      const { citing, cited, other } = seedThreeWays();

      const result = retractMemoryEdges(db, [
        {
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: cited },
        },
      ]);

      expect(result.rejected).toEqual([]);
      // Both legacy rows of the one logical edge — leaving a fragment behind
      // is the "the classification is gone but something still records the
      // pair" state D1 retires.
      expect(result.deleted).toHaveLength(2);
      expect(result.deleted.map((edge) => displayEdgeRelation(edge)).sort()).toEqual([
        "",
        "",
      ]);
      expect(result.deleted[0]?.cited).toEqual({ kind: "turn", id: cited });
      // The same relation on a DIFFERENT pair is untouched: the address is the
      // pair, not the word.
      expect(
        getOutgoingEdges(db, { kind: "turn", id: citing }).map((edge) => [
          edge.cited.id,
          displayEdgeRelation(edge),
        ]),
      ).toEqual([[other, "use"]]);
    });

    // DELETED (main-agent-edges D4/D5): "relation: null addresses the bare row,
    // and leaves a classified pair alone". The address no longer names a
    // relation at all, so there is no null-versus-word distinction left to
    // draw — and the population that distinction existed for (the wordless
    // layer) is retired by D1. What it proved besides, that an address
    // resolving to nothing is reported as `no-such-edge` rather than silently
    // succeeding, is kept in the next case.

    test("reports an address that resolved but matched nothing, and a malformed one, apart", () => {
      const { citing, cited } = seedThreeWays();

      const result = retractMemoryEdges(db, [
        // The pair exists in the OTHER direction only — a citation is
        // directed, so this address resolves and matches nothing.
        {
          citing: { kind: "turn", id: cited },
          cited: { kind: "turn", id: citing },
        },
        {
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: 0 },
        },
      ]);

      expect(result.deleted).toEqual([]);
      // The `invalid-relation` arm this case used to carry is gone with the
      // relation component of the address: a retraction can no longer name a
      // word, so it can no longer name a word wrongly.
      expect(result.rejected.map((entry) => entry.reason)).toEqual([
        "no-such-edge",
        "invalid-node",
      ]);
      expect(countMemoryEdges(db)).toBe(3);
    });

    test("takes the pair's PRE-CUTOVER wordless row with it, and downgrades nothing to one", () => {
      const citing = addTurn(1);
      const cited = addTurn(2);
      // Both seeded past the write path: a relation write would DISPLACE the
      // wordless row rather than stand beside it, and the state this case is
      // about is the pre-cutover one where both are on file.
      legacyEdge(citing, cited, null, 300);
      legacyEdge(citing, cited, "grounds", 300);

      const result = retractMemoryEdges(db, [
        {
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: cited },
        },
      ]);

      expect(result.deleted).toHaveLength(2);
      // Nothing is resurrected as "cited but unclassified": that would
      // re-assert something the retraction never claimed, and after D1 there
      // is no writer left that could put the row back.
      expect(getOutgoingEdges(db, { kind: "turn", id: citing })).toEqual([]);
    });
  });

  // Ticket 05 narrowed this refusal to BARE self rows for a while;
  // lane-model-v12 D2 (ticket 04) put it back to every self row, so the case
  // below is the bare one only because that is what this fixture happens to
  // send — the next test covers the relation-carrying one.
  //
  // The self-loop guard runs BEFORE main-agent-edges D1's wordless refusal, so
  // a wordless self row is reported as what is most wrong with it — the two
  // ends being the same node — rather than as the retired write path.
  test("rejects a BARE self-loop and malformed nodes without writing them", () => {
    const turnId = addTurn(1);

    const result = writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: turnId },
          cited: { kind: "turn", id: turnId },
          relationClass: null as never,
          provenance: "text-ref",
        },
        {
          citing: { kind: "turn", id: turnId },
          cited: { kind: "turn", id: 0 },
          ...wordEdgeClass("consume"),
          provenance: "text-ref",
        },
        {
          citing: { kind: "turn", id: turnId },
          cited: { kind: "turn", id: 999 },
          relationClass: "invented" as never,
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
          ...wordEdgeClass("grounds"),
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
             (citing_kind, citing_id, cited_kind, cited_id, relation_class, provenance, created_at_epoch)
           VALUES ('turn', ?, 'turn', ?, 'use', 'asserted', 300)`,
        )
        .run(turnId, turnId),
    ).toThrow(/CHECK constraint failed/);
    // A non-turn endpoint is banned by the post-cutover kind CHECKs, which
    // took the place of the wordless row this half used to state.
    expect(() =>
      db
        .query(
          `INSERT INTO memory_edges
             (citing_kind, citing_id, cited_kind, cited_id, relation_class, provenance, created_at_epoch)
           VALUES ('segment', ?, 'segment', ?, 'use', 'text-ref', 300)`,
        )
        .run(7, 7),
    ).toThrow();
    // Same id across DIFFERENT kinds is not a self-loop and stays legal — the
    // id spaces are separate, so a CHECK on the ids alone would be wrong.
    // The cross-kind BARE row this half used to land is now refused too: the
    // post-cutover table CHECKs `citing_kind = 'turn'` and `cited_kind =
    // 'turn'`, and `relation_class` is NOT NULL. Nothing at all lands.
    expect(() =>
      db
        .query(
          `INSERT INTO memory_edges
             (citing_kind, citing_id, cited_kind, cited_id, relation_class, provenance, created_at_epoch)
           VALUES ('turn', ?, 'segment', ?, 'use', 'text-ref', 300)`,
        )
        .run(turnId, turnId),
    ).toThrow(/CHECK constraint failed/);
    expect(countMemoryEdges(db)).toBe(0);
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
          ...wordEdgeClass("consume"),
          provenance: "retrieval",
        },
        {
          citing: { kind: "turn", id: citerB },
          cited: { kind: "turn", id: cited },
          ...wordEdgeClass("verifies"),
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

    test("carries every WORDED legacy pair over, remapping the retired vocabulary, and skips the wordless ones", () => {
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
      // One row per PAIR (spec C5) — the legacy table's wider key is gone.
      // NINE, not twelve: `builds-on` (indices 0, 4, 8) remaps to no relation
      // at all, and main-agent-edges D1 retires the wordless row a winnerless
      // pair used to fold into. A historical import is not the place to
      // re-open a population ticket 01's cutover deletes, so those three pairs
      // are simply not migrated.
      expect(migrated).toBe(9);
      expect(countMemoryEdges(db)).toBe(9);

      // Spot-check the remap: `implements` (index 1, 5, 9) → `consume`;
      // `evidence-for` lands on `verifies`; `supersedes` lands on `override`
      // (lane-model-v12 ticket 03 — the word left the CHECK the fold writes
      // into, so it can no longer pass through unchanged).
      // The fold lands a CLASS, not a word: the cutover dropped the column the
      // remapped word used to go into, so what a migrated pair says about
      // itself is its class token.
      const relationFor = (pairIndex: number): string | undefined => {
        const row = db
          .query<{ relationClass: string; relationCoverage: string }, [number, number]>(
            `SELECT relation_class AS relationClass, relation_coverage AS relationCoverage
             FROM memory_edges
             WHERE citing_kind = 'turn' AND citing_id = ?
               AND cited_kind = 'turn' AND cited_id = ?`,
          )
          .get(legacy[pairIndex]!.citing, legacy[pairIndex]!.cited);
        return row === null ? undefined : displayEdgeRelation(row as never);
      };

      // `undefined`: the `builds-on` pair has NO ROW at all. That is the whole
      // of D1 here — there is no wordless row for it to be instead.
      expect(relationFor(0)).toBeUndefined();
      expect(relationFor(1)).toBe("use");
      expect(relationFor(2)).toBe("correct(full)");
      expect(relationFor(3)).toBe("verify");

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
        .query<
          { relationClass: string; relationCoverage: string; createdAtEpoch: number },
          [number, number]
        >(
          `SELECT relation_class AS relationClass, relation_coverage AS relationCoverage,
                  created_at_epoch AS createdAtEpoch FROM memory_edges
           WHERE citing_kind = 'turn' AND citing_id = ?
             AND cited_kind = 'turn' AND cited_id = ?`,
        )
        .get(legacy[0]!.citing, legacy[0]!.cited);
      expect(displayEdgeRelation(edge as never)).toBe("correct(full)");
      // The earliest timestamp across the group survives the collapse.
      expect(edge?.createdAtEpoch).toBe(1000);
    });

    test("is idempotent and never resurrects nor duplicates on a re-run", () => {
      createLegacyTurnCitationsTable();
      seedLegacyEdges(5);
      db.query("DELETE FROM memory_edges").run();

      // THREE of the five: indices 0 and 4 are `builds-on`, which remaps to no
      // relation and is therefore not migrated at all (main-agent-edges D1).
      expect(migrateTurnCitationsToEdges(db)).toBe(3);
      const secondRun = migrateTurnCitationsToEdges(db);

      expect(secondRun).toBe(0);
      expect(countMemoryEdges(db)).toBe(3);
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
             (citing_kind, citing_id, cited_kind, cited_id, relation_class, provenance, created_at_epoch)
           VALUES ('turn', ?, 'turn', ?, 'use', 'asserted', 2000)`,
        ).run(citing, cited);
        return { citing, cited };
      }

      function readEdges(pair: { citing: number; cited: number }) {
        return db
          .query<
            {
              relationClass: string;
              relationCoverage: string;
              provenance: string;
              createdAtEpoch: number;
            },
            [number, number]
          >(
            `SELECT relation_class AS relationClass, relation_coverage AS relationCoverage,
                    provenance, created_at_epoch AS createdAtEpoch
             FROM memory_edges
             WHERE citing_kind = 'turn' AND citing_id = ?
               AND cited_kind = 'turn' AND cited_id = ?
             ORDER BY relation_class ASC`,
          )
          .all(pair.citing, pair.cited);
      }

      test("the legacy relation PROMOTES the row already stored rather than joining it (D5)", () => {
        const pair = seedOverlappingPair();

        const migrated = migrateTurnCitationsToEdges(db);

        // NO row added. This case used to prove the opposite — that the legacy
        // claim and the live one both fit, because identity was
        // (pair, relation). Under main-agent-edges D5 the pair IS the row, so
        // the fold-in goes through the same precedence every live write obeys:
        // the stored `consume` reads as class `use`, the legacy `evidence-for`
        // remaps to `verifies` which is class `verify`, and a strictly more
        // specific class promotes the stored row IN PLACE.
        expect(migrated).toBe(0);
        // The promotion revises WHAT is claimed, not who claimed it or when:
        // provenance and creation time are the live row's, untouched.
        expect(readEdges(pair)).toEqual([
          { ...wordEdgeClass("verifies"), provenance: "asserted", createdAtEpoch: 2000 },
        ]);
        expect(countMemoryEdges(db)).toBe(1);
      });

      test("a second call over the same overlap changes nothing", () => {
        const pair = seedOverlappingPair();

        migrateTurnCitationsToEdges(db);
        const before = readEdges(pair);
        const secondRun = migrateTurnCitationsToEdges(db);
        const after = readEdges(pair);

        expect(secondRun).toBe(0);
        // The second pass finds the class it would assert already stored, so
        // it is a NO-OP rather than a second promotion (D5).
        expect(after).toEqual(before);
        expect(countMemoryEdges(db)).toBe(1);
      });

      // `builds-on` remaps to NULL (spec C2) — the absence of a statement
      // about the relation, not a statement that there is none. Under
      // main-agent-edges D1 such a pair is not migrated at all, so it cannot
      // reach the stored row to disturb it either.
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
             (citing_kind, citing_id, cited_kind, cited_id, relation_class, relation_coverage, provenance, created_at_epoch)
           VALUES ('turn', ?, 'turn', ?, 'correct', 'partial', 'judged', 2000)`,
        ).run(citing, cited);

        const migrated = migrateTurnCitationsToEdges(db);

        // No bare row appears beside the relation, and the relation is
        // untouched: a citation that says nothing about the relation cannot
        // clear one, and cannot re-record a pair already recorded.
        expect(readEdges({ citing, cited })).toEqual([
          {
            relationClass: "correct",
            relationCoverage: "partial",
            provenance: "judged",
            createdAtEpoch: 2000,
          },
        ]);
        expect(migrated).toBe(0);
      });

      /**
       * MAIN-AGENT-EDGES D1 inverts this case. It used to read "a relationless
       * citation lands as a BARE pair when nothing records the pair yet" — the
       * fold's one remaining producer of wordless rows. The wordless
       * population is retired as a write path and deleted at cutover, so a
       * historical import may not re-open it: a pair whose winning relation is
       * null is skipped, and the fact that the legacy table once held it
       * survives only in the legacy table.
       */
      test("a relationless citation is not migrated at all — the fold mints no wordless row (D1)", () => {
        createLegacyTurnCitationsTable();
        const citing = addTurn(1);
        const cited = addTurn(2);
        db.query(
          `INSERT INTO turn_citations (citing_turn_id, cited_turn_id, relation, created_at_epoch)
           VALUES (?, ?, 'builds-on', 3000)`,
        ).run(citing, cited);

        expect(migrateTurnCitationsToEdges(db)).toBe(0);
        expect(readEdges({ citing, cited })).toEqual([]);
        expect(countMemoryEdges(db)).toBe(0);
      });
    });
  });

  /**
   * lane-model-v12 tickets 08/09 (spec D1, "边的身份"): the two SIDES are the
   * whole of the lane surface a caller states — ticket 09 deleted the legacy
   * `tags` column they used to be projected onto. This block is storage-only:
   * the canonical/declared/subset gate lives one layer up
   * (`shared/turn-phase.ts`), so what is proved here is the row shape, the
   * columns and the query index.
   *
   * WHAT THIS BLOCK NO LONGER PROVES (main-agent-edges D5). The sides used to
   * be IDENTITY-BEARING: identity was (pair, relation, tail, head), so a
   * second side placement minted a second, independent row, a crossing and its
   * same-lane namesake coexisted, and a retraction had to name both sides to
   * match one of them. Identity is the PAIR now. Every case that turned on
   * that wider key is deleted below with a note in its place; the COLUMNS
   * survive untouched — still stored, still indexed in
   * `memory_edge_side_tags`, still cascading on delete — and only their role
   * in identity is gone. Changing a stored side is `declareEdgeSides`' job
   * (`tests/db/logical-edge-writes.test.ts`), never a write's.
   */
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
            ...wordEdgeClass("consume"),
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
            ...wordEdgeClass("consume"),
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

    // DELETED (main-agent-edges D5): "a DIFFERENT side pair on the same
    // (pair, relation) is a SECOND, independent row". Identity is the pair, so
    // a second side placement never mints a row — the write leaves the stored
    // sides exactly as they are and only the class may be promoted. Re-placing
    // a side is `declareEdgeSides`' job, pinned in
    // `tests/db/logical-edge-writes.test.ts` (including that an attach never
    // re-places one).

    /**
     * The row ORDER of a multi-row read, which since ticket 09 is broken by
     * the two SIDES — the merged set's `tags ASC` used to be the tiebreak, and
     * removing the column removed it. `relation` alone cannot separate three
     * rows that share one, so without the side components these come back in
     * whatever order the b-tree happens to hand over and the `relations` recall
     * field renders non-deterministically.
     *
     * THE ROWS ARE SEEDED IN SQL now (main-agent-edges D5): one pair holds one
     * row, so the only population a multi-row read can still see is the legacy
     * stock ticket 01's cutover has yet to fold — 109 such pairs in
     * production. That is exactly the population whose read order this pins,
     * so the fixture builds it rather than pretending a writer will.
     *
     * MUTATION: drop `EDGE_IDENTITY_ORDER` from either read — this is the
     * only test that reddens (the mutation survived the whole suite before it).
     *
     * The ORDER moved with the cutover: one pair is one row now, so after the
     * pair columns there is nothing to tie-break on but the row id, and `id
     * ASC` is what keeps the deferral window's legacy multi-row pair
     * deterministic. The fixture writes its rows in an order that is neither
     * the sorted-by-sides one nor the reverse of insertion, so a read that
     * fell back on the b-tree would still be visible.
     */
    test("a multi-row LEGACY read is ordered by ROW ID, not left to the b-tree", () => {
      const citing = addTurn(1);
      const cited = addTurn(2);

      // Written in an order that is neither the row-id order nor the sorted
      // one, so a query that fell back on either would be visible here.
      legacyEdge(citing, cited, "extends", 300, { tailTag: "lane-c", headTag: "lane-a", relationClass: "use" });
      legacyEdge(citing, cited, "extends", 310, { tailTag: "lane-a", headTag: "lane-b", relationClass: "use" });
      legacyEdge(citing, cited, "extends", 320, { tailTag: "lane-a", headTag: "lane-a", relationClass: "use" });

      const expected = [
        ["lane-c", "lane-a"],
        ["lane-a", "lane-b"],
        ["lane-a", "lane-a"],
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

    // DELETED (main-agent-edges D5): "a CROSSING and its same-lane namesake
    // coexist: (a,b) and (a,a) are two rows". Same retirement as the case
    // above — the sides no longer separate two rows, because there is only
    // ever one row for the pair to separate. An edge is placed on one crossing
    // at a time, and moving it there is a declaration.

    test("re-writing a pair a second time is an idempotent restatement: one row, first sighting stands, sides untouched", () => {
      const citing = addTurn(1);
      const cited = addTurn(2);
      const pair = {
        citing: { kind: "turn" as const, id: citing },
        cited: { kind: "turn" as const, id: cited },
        ...wordEdgeClass("extends"),
      };

      const first = writeMemoryEdges(
        db,
        [{ ...pair, provenance: "retrieval", tailTag: "A", headTag: "B" }],
        300,
      );
      // Different sides, different provenance and time — still the same row,
      // and still the sides the FIRST write placed. main-agent-edges D5: a
      // second side placement never mints a row and never re-places a stored
      // side; only `declareEdgeSides` moves one.
      const second = writeMemoryEdges(
        db,
        [{ ...pair, provenance: "judged", tailTag: "C", headTag: "D" }],
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
        ...wordEdgeClass("narrows"),
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

    // DELETED, all three (main-agent-edges D4/D5, ruling T2432 P1): "retraction
    // addresses exactly ONE row: a lane-placed retraction leaves siblings
    // untouched", "a retraction addressing ONE side of a crossing does not
    // match the row — an address names BOTH sides", and "a retraction with NO
    // side arguments still deletes exactly the UNSETTLED row, unaffected by
    // placed siblings".
    //
    // All three pinned the SIDES as part of the retraction address, and there
    // is no such address any more: `retractMemoryEdges` takes `{citing, cited}`
    // and removes every row of the pair. The rule they enforced — that a
    // retraction must not overreach — is now enforced by the pair being the
    // whole edge (there is nothing beside it to overreach onto) plus the class
    // compare-and-swap one layer up in `retractTurnRelations`, which refuses a
    // stale precondition BY NAME instead of silently matching nothing. Both
    // are pinned in `tests/db/logical-edge-writes.test.ts`; the pair-addressed
    // deletion itself is pinned in the `retraction (D3)` block above.

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
              ...wordEdgeClass("consume"),
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
              ...wordEdgeClass("consume"),
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

      /**
       * The CASCADE survives main-agent-edges D5 untouched — the side index is
       * keyed on the edge's row id, so a deleted row takes its side rows with
       * it. What changed is where the "sibling" comes from: the two rows used
       * to be two side placements of ONE pair, and a pair holds one row now,
       * so the neighbour that must NOT be disturbed is a different pair's
       * edge. That is the stronger reading anyway — a retraction reaching into
       * another pair's index rows would be a real fault, while the old case's
       * sibling could only ever be lost together with it.
       */
      test("retraction cascades on the index: the retracted row's rows go, another pair's stay", () => {
        const citing = addTurn(1);
        const cited = addTurn(2);
        const other = addTurn(3);
        const shape = {
          citing: { kind: "turn" as const, id: citing },
          ...wordEdgeClass("narrows"),
          provenance: "asserted" as const,
        };

        const first = writeMemoryEdges(
          db,
          [{ ...shape, cited: { kind: "turn", id: cited }, tailTag: "laneA", headTag: "laneA" }],
          300,
        );
        const second = writeMemoryEdges(
          db,
          [{ ...shape, cited: { kind: "turn", id: other }, tailTag: "laneB", headTag: "laneB" }],
          400,
        );
        const firstId = first.written[0]!.id;
        const secondId = second.written[0]!.id;
        expect(sideIndexRows(db)).toHaveLength(4);

        retractMemoryEdges(db, [
          { citing: shape.citing, cited: { kind: "turn", id: cited } },
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
          ...wordEdgeClass("extends"),
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
              ...wordEdgeClass("consume"),
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
              ...wordEdgeClass("grounds"),
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

    // DELETED (main-agent-edges D1): "a bare (untagged) write ignores any side
    // arguments — a lane is a RELATION-level fact, not the bare existence
    // row's". The claim held that a wordless write stores `''` on both sides
    // whatever sides it names; there is no wordless write left to store
    // anything, so the case has no subject. The refusal that replaced it is
    // pinned by name at the top of this file. Nothing about a lane's being a
    // relation-level fact is lost with it: after D1 EVERY row a writer can
    // create carries a relation.
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
          ...wordEdgeClass("override"),
          provenance: "asserted",
          tailTag: "rule-ledger-tickets",
          headTag: "rule-ledger-tickets",
        },
        {
          citing: { kind: "turn", id: inboundSource },
          cited: { kind: "turn", id: subject },
          ...wordEdgeClass("narrows"),
          provenance: "asserted",
        },
      ],
      500,
    );

    const edges = getTurnRelationEdges(db, subject);

    expect(edges.outbound).toEqual([
      {
        relationClass: "correct",
        relationCoverage: "full",
        tailTag: "rule-ledger-tickets",
        headTag: "rule-ledger-tickets",
        otherTurnId: outboundTarget,
        otherSessionId: sessionId,
        otherPromptNumber: 2,
      },
    ]);
    expect(edges.inbound).toEqual([
      {
        relationClass: "correct",
        relationCoverage: "partial",
        tailTag: "",
        headTag: "",
        otherTurnId: inboundSource,
        otherSessionId: sessionId,
        otherPromptNumber: 3,
      },
    ]);
  });

  test("excludes a bare (relation-NULL) pair — no class to render", () => {
    const subject = addTurn(1);
    const target = addTurn(2);
    // Seeded in the PRE-CUTOVER shape: the cutover deleted every wordless row
    // and left `relation_class` NOT NULL, so this population survives only in
    // D9's deferral window — where this reader still has to skip it.
    downgradeToPreCutoverShape(db);
    seedPreCutoverEdge(db, {
      citingId: subject,
      citedId: target,
      relation: null,
      provenance: "text-ref",
      createdAtEpoch: 500,
    });

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
        { citing: { kind: "turn", id: subject }, cited: { kind: "turn", id: dormantTarget }, ...wordEdgeClass("extends"), provenance: "asserted" },
        { citing: { kind: "turn", id: subject }, cited: { kind: "turn", id: deletedTarget }, ...wordEdgeClass("extends"), provenance: "asserted" },
        { citing: { kind: "turn", id: subject }, cited: { kind: "turn", id: liveTarget }, ...wordEdgeClass("extends"), provenance: "asserted" },
        { citing: { kind: "turn", id: dormantSource }, cited: { kind: "turn", id: subject }, ...wordEdgeClass("consume"), provenance: "asserted" },
        { citing: { kind: "turn", id: deletedSource }, cited: { kind: "turn", id: subject }, ...wordEdgeClass("consume"), provenance: "asserted" },
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
      [{ citing: { kind: "turn", id: subject }, cited: { kind: "turn", id: foreign }, ...wordEdgeClass("grounds"), provenance: "asserted" }],
      500,
    );

    const edges = getTurnRelationEdges(db, subject);
    expect(edges.outbound).toEqual([
      {
        relationClass: "use",
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
      [{ citing: { kind: "turn", id: subject }, cited: { kind: "turn", id: subject }, ...wordEdgeClass("verifies"), provenance: "asserted" }],
      500,
    );
    expect(written.rejected.map((entry) => entry.reason)).toEqual(["self-loop"]);

    const edges = getTurnRelationEdges(db, subject);
    expect(edges.outbound).toEqual([]);
    expect(edges.inbound).toEqual([]);
  });
});

// THE WHOLE "retired words are cleanly rejected and override survives" BLOCK
// IS DELETED (main-agent-edges ticket 01).
//
// It asserted that `supersedes`, `refutes`, `refines`, `encodes` and
// `grounded-on` were refused at `isCitationRelation` and by the table's own
// seven-word CHECK, and that `override` — the survivor — still wrote. The
// cutover dropped the `relation` column, deleted `isCitationRelation` and
// `CITATION_RELATIONS` with it, and made `relation_class` the only vocabulary
// there is: `WriteEdgeInput.relationClass` is typed to the three classes, the
// table CHECKs the same three, and no string outside them can be named at all.
// The refusal that replaced this block is the class CHECK, asserted in
// `tests/shared/relation-class.test.ts`.

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
    const t3 = addTurn(3);
    // TWO PAIRS, not two rows of one (main-agent-edges D5): the pair is the
    // whole of a row's identity, so the settled and the unsettled edge have to
    // be different edges to coexist at all.
    writeMemoryEdges(
      db,
      [
        { citing: { kind: "turn", id: t2 }, cited: { kind: "turn", id: t1 }, ...wordEdgeClass("extends"), provenance: "asserted", ...deriveSideTags(["lane-a"]) },
        { citing: { kind: "turn", id: t2 }, cited: { kind: "turn", id: t3 }, ...wordEdgeClass("consume"), provenance: "asserted", ...deriveSideTags([]) },
      ],
      100,
    );
    const rows = getRelationEdgesAmongTurns(db, [t1, t2, t3]);
    const settled = rows.find((row) => row.citedId === t1)!;
    const unsettled = rows.find((row) => row.citedId === t3)!;
    expect([settled.tailTag, settled.headTag]).toEqual(["lane-a", "lane-a"]);
    expect([unsettled.tailTag, unsettled.headTag]).toEqual(["", ""]);
  });

  test("a CROSS-LANE row keeps its two ends apart — the fact the merged `tags` set cannot carry", () => {
    const t1 = addTurn(1);
    const t2 = addTurn(2);
    writeMemoryEdges(
      db,
      [{ citing: { kind: "turn", id: t2 }, cited: { kind: "turn", id: t1 }, ...wordEdgeClass("consume"), provenance: "asserted", ...deriveSideTags(["lane-a"]) }],
      100,
    );
    // Settled directly: `writeMemoryEdges` can only ever produce `tail === head`
    // today (`deriveSideTags`); ticket 08's write gate is what accepts a
    // genuine crossing, and storage already holds one.
    db.query(
      `UPDATE memory_edges SET tail_tag = 'lane-a', head_tag = 'lane-b'
       WHERE citing_id = ? AND cited_id = ?`,
    ).run(t2, t1);

    const row = getRelationEdgesAmongTurns(db, [t1, t2]).find((entry) => entry.citedId === t1)!;
    expect(row.tailTag).toBe("lane-a");
    expect(row.headTag).toBe("lane-b");
    // The tail is the CITING side and the head the CITED one — not the
    // reverse, and not two values a reader has to guess the order of.
    expect(row.citingId).toBe(t2);
    expect(row.citedId).toBe(t1);
  });
});
