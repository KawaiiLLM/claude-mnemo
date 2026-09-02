import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  MAIN_AGENT_EDGES_CUTOVER_DDL_ARCHIVE,
  MAIN_AGENT_EDGES_CUTOVER_EDGE_ARCHIVE,
} from "../../src/db/main-agent-edges-cutover";
import {
  ensureMemoryEdgesRelationTurnScoped,
  initializeSchema,
  MEMORY_EDGES_RELATION_TURN_SCOPED_RECEIPT,
  type MemoryEdgesRelationTurnScopedReceipt,
} from "../../src/db/schema";
import { createSegment } from "../../src/db/segments";

/**
 * container-unification D10 (ticket 02): the relation graph is turn→turn.
 * `memory_edges` starts every open with 4 residue rows this ticket names by
 * shape — 3 `provenance='judged'` BARE `turn→segment`/`segment→segment` rows
 * and 1 `provenance='judged'` `verifies` `turn→segment` row, all written
 * 2026-08-13/14, before the relation vocabulary was narrowed — and ends it
 * with them deleted and a CHECK that refuses any FUTURE relation-carrying row
 * shaped like them. `text-ref`'s ~900 non-turn→turn BARE rows (the
 * prose-citation index) are a DIFFERENT population and must survive both
 * halves untouched.
 *
 * `initializeSchema`'s `beforeEach` already runs this migration for real —
 * fresh-creation `memory_edges` is deliberately born in the OLDEST lane shape
 * (see `MEMORY_EDGES_DDL`'s own comment) and walks the WHOLE chain, this
 * phase included, on every open. `toPending` below un-narrows the CHECK by
 * hand (a literal copy of the pre-this-ticket `sides-only` shape, same
 * fixture philosophy `tests/support/pre-v12-edge-shape.ts` states for
 * itself: a fixture describing an OLD shape must not import the generator
 * that produces it, or it stops describing that shape the day the generator
 * moves) so each test can seed the rows the CURRENT CHECK would otherwise
 * refuse at INSERT time.
 */
/**
 * main-agent-edges ticket 01: `initializeSchema` now ENDS with the cutover,
 * which rebuilds `memory_edges` without the `relation` column and with one row
 * per pair. The legacy chain under test still runs on this fixture, in the same
 * open, right before it — and the cutover ARCHIVES the table exactly as the
 * chain left it (`main_agent_edges_cutover_ddl_archive` /
 * `main_agent_edges_cutover_edge_archive`). The two accessors below therefore
 * read the chain's result out of the archive rather than out of the live table,
 * which is the same state a rollback would restore.
 */
describe("container-unification D10 — the relation graph is turn→turn", () => {
  let db: Database;
  let sessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = db
      .query<{ id: number }, [string, string]>(
        `INSERT INTO sessions (content_session_id, project, created_at_epoch)
         VALUES (?, ?, 100) RETURNING id`,
      )
      .get("relation-turn-scoped", "/tmp/project")!.id;
  });

  afterEach(() => {
    db.close();
  });

  function addTurn(promptNumber: number): number {
    return db
      .query<{ id: number }, [number, number]>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch, was_rolled_back)
         VALUES (?, ?, 'active', 100, 0) RETURNING id`,
      )
      .get(sessionId, promptNumber)!.id;
  }

  function addSegment(title: string): number {
    return createSegment(db, { title, nowEpoch: 100 }).id;
  }

  /**
   * Physical-only: rebuilds `memory_edges` back into the pre-this-ticket
   * `sides-only` shape (no `relationScopedToTurns` CHECK arm), a straight
   * copy of whatever rows currently exist. Does NOT touch `migration_receipts`
   * — callers that also want the "never ran" state clear the receipt
   * themselves, so a test can isolate "physically un-narrowed, receipt still
   * present" from "genuinely pending" (see the monotonic-marker test below).
   */
  function widenBack(db: Database): void {
    db.exec("PRAGMA foreign_keys = OFF;");
    try {
      db.exec(`
        CREATE TABLE memory_edges_widen_back (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          citing_kind TEXT NOT NULL CHECK (citing_kind IN ('turn', 'segment', 'session')),
          citing_id INTEGER NOT NULL,
          cited_kind TEXT NOT NULL CHECK (cited_kind IN ('turn', 'segment')),
          cited_id INTEGER NOT NULL,
          relation TEXT CHECK (
            relation IS NULL OR
            relation IN ('override', 'narrows', 'extends', 'indexes', 'consume', 'grounds', 'verifies')
          ),
          provenance TEXT NOT NULL CHECK (
            provenance IN ('retrieval', 'text-ref', 'rollback', 'judged', 'asserted')
          ),
          tail_tag TEXT NOT NULL DEFAULT '',
          head_tag TEXT NOT NULL DEFAULT '',
          -- relation-vocabulary-v13 ticket 02's two ADDITIVE columns are carried
          -- through rather than dropped: this fixture exists to un-narrow ONE
          -- thing (the turn-scoped relation CHECK), and a rebuild that also
          -- reverted an unrelated later migration would make every reader in
          -- this file fail on "no such column" instead of on the property under
          -- test.
          relation_class TEXT NOT NULL DEFAULT ''
            CHECK (relation_class IN ('', 'correct', 'verify', 'use')),
          relation_coverage TEXT NOT NULL DEFAULT ''
            CHECK (relation_coverage IN ('', 'full', 'partial')
                   AND (relation_coverage = '') = (relation_class <> 'correct')),
          created_at_epoch INTEGER NOT NULL,
          CHECK (citing_kind <> cited_kind OR citing_id <> cited_id),
          UNIQUE (citing_kind, citing_id, cited_kind, cited_id, relation, tail_tag, head_tag)
        );
      `);
      db.query(
        `INSERT INTO memory_edges_widen_back (
           id, citing_kind, citing_id, cited_kind, cited_id,
           relation, provenance, tail_tag, head_tag,
           relation_class, relation_coverage, created_at_epoch
         )
         SELECT id, citing_kind, citing_id, cited_kind, cited_id,
                -- The main-agent-edges cutover DROPPED memory_edges.relation,
                -- so the word this fixture's shape needs is reconstructed from
                -- the class pair, inverting the v13 backfill. Lossy in the
                -- direction that backfill was many-to-one.
                CASE relation_class
                  WHEN 'correct' THEN CASE relation_coverage WHEN 'full' THEN 'override' ELSE 'narrows' END
                  WHEN 'verify' THEN 'verifies'
                  WHEN 'use' THEN 'grounds'
                  ELSE NULL
                END,
                provenance, tail_tag, head_tag,
                relation_class, relation_coverage, created_at_epoch
         FROM memory_edges`,
      ).run();
      db.exec("DROP TABLE memory_edges");
      db.exec("ALTER TABLE memory_edges_widen_back RENAME TO memory_edges");
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_memory_edges_cited
          ON memory_edges(cited_kind, cited_id, relation);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_edges_bare_pair
          ON memory_edges(citing_kind, citing_id, cited_kind, cited_id)
          WHERE relation IS NULL;
      `);
    } finally {
      db.exec("PRAGMA foreign_keys = ON;");
    }
  }

  /** `widenBack` plus clearing the receipt — the genuine "never ran yet" state. */
  function toPending(db: Database): void {
    widenBack(db);
    db.query<unknown, [string]>("DELETE FROM migration_receipts WHERE name = ?").run(
      MEMORY_EDGES_RELATION_TURN_SCOPED_RECEIPT,
    );
  }

  function insertEdge(
    citingKind: string,
    citingId: number,
    citedKind: string,
    citedId: number,
    relation: string | null,
    provenance: string,
    createdAtEpoch: number,
  ): void {
    db.query<
      unknown,
      [string, number, string, number, string | null, string, number]
    >(
      `INSERT INTO memory_edges
         (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, created_at_epoch)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(citingKind, citingId, citedKind, citedId, relation, provenance, createdAtEpoch);
  }

  const edges = (): Array<{
    citingKind: string;
    citingId: number;
    citedKind: string;
    citedId: number;
    relation: string | null;
    provenance: string;
  }> =>
    db
      .query<
        {
          citingKind: string;
          citingId: number;
          citedKind: string;
          citedId: number;
          relation: string | null;
          provenance: string;
        },
        []
      >(
        `SELECT citing_kind AS citingKind, citing_id AS citingId,
                cited_kind AS citedKind, cited_id AS citedId,
                relation, provenance
         FROM memory_edges ORDER BY citing_kind, citing_id, cited_kind, cited_id, relation`,
      )
      .all();

  /**
   * The same rows, read out of the cutover's receipt archive. Every test in
   * this file that drives the migration DIRECTLY (`toPending` + the ensure
   * call) leaves the live table in the widened-back shape and reads `edges()`;
   * the two that go back through `initializeSchema` end past the cutover,
   * where the word column is gone, and read this instead.
   */
  const archivedEdges = (): Array<{
    citingKind: string;
    citingId: number;
    citedKind: string;
    citedId: number;
    relation: string | null;
    provenance: string;
  }> =>
    db
      .query<
        {
          citingKind: string;
          citingId: number;
          citedKind: string;
          citedId: number;
          relation: string | null;
          provenance: string;
        },
        []
      >(
        `SELECT citing_kind AS citingKind, citing_id AS citingId,
                cited_kind AS citedKind, cited_id AS citedId,
                relation, provenance
         FROM ${MAIN_AGENT_EDGES_CUTOVER_EDGE_ARCHIVE}
         ORDER BY citing_kind, citing_id, cited_kind, cited_id, relation`,
      )
      .all();

  const receipt = (): MemoryEdgesRelationTurnScopedReceipt =>
    JSON.parse(
      db
        .query<{ payload: string }, [string]>(
          "SELECT payload FROM migration_receipts WHERE name = ?",
        )
        .get(MEMORY_EDGES_RELATION_TURN_SCOPED_RECEIPT)!.payload,
    ) as MemoryEdgesRelationTurnScopedReceipt;

  const storedDdl = (): string =>
    db
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_edges'",
      )
      .get()!.sql;

  /** The DDL as the chain handed it to the cutover — see `archivedEdges`. */
  const archivedDdl = (): string =>
    db
      .query<{ sql: string }, []>(
        `SELECT sql FROM ${MAIN_AGENT_EDGES_CUTOVER_DDL_ARCHIVE}
            WHERE kind = 'table' AND name = 'memory_edges'`,
      )
      .get()!.sql;

  test("beforeEach's ordinary initializeSchema already settles the phase", () => {
    expect(
      db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM migration_receipts WHERE name = ?",
        )
        .get(MEMORY_EDGES_RELATION_TURN_SCOPED_RECEIPT)!.n,
    ).toBe(1);
    expect(archivedDdl()).toContain(
      "CHECK (relation IS NULL OR (citing_kind = 'turn' AND cited_kind = 'turn'))",
    );
  });

  /**
   * Ticket checkboxes 1 and 2: deletes exactly the `provenance='judged'`
   * stray rows, leaves `text-ref`'s bare non-turn→turn rows and every
   * turn→turn row (relation-carrying or bare) alone.
   */
  test("deletes the judged stray rows; text-ref and turn→turn rows survive untouched", () => {
    toPending(db);
    const turnA = addTurn(1);
    const turnB = addTurn(2);
    const segmentA = addSegment("chapter one");
    const segmentB = addSegment("chapter two");

    // The 4-shape residue this ticket names: 3 bare + 1 `verifies`.
    insertEdge("turn", turnA, "segment", segmentA, null, "judged", 700);
    insertEdge("turn", turnB, "segment", segmentB, null, "judged", 700);
    insertEdge("segment", segmentA, "segment", segmentB, null, "judged", 700);
    insertEdge("turn", turnA, "segment", segmentB, "verifies", "judged", 800);
    // The DIFFERENT population this ticket must leave alone.
    insertEdge("turn", turnB, "segment", segmentA, null, "text-ref", 900);
    // A legitimate turn→turn relation and a legitimate turn→turn bare row.
    insertEdge("turn", turnA, "turn", turnB, "consume", "asserted", 1000);
    insertEdge("turn", turnB, "turn", turnA, null, "text-ref", 1000);

    ensureMemoryEdgesRelationTurnScoped(db, 2000);

    expect(edges()).toEqual([
      {
        citingKind: "turn",
        citingId: turnA,
        citedKind: "turn",
        citedId: turnB,
        relation: "consume",
        provenance: "asserted",
      },
      {
        citingKind: "turn",
        citingId: turnB,
        citedKind: "segment",
        citedId: segmentA,
        relation: null,
        provenance: "text-ref",
      },
      {
        citingKind: "turn",
        citingId: turnB,
        citedKind: "turn",
        citedId: turnA,
        relation: null,
        provenance: "text-ref",
      },
    ]);
    expect(receipt().strayRowsDeleted).toBe(4);
    const strayRelations = receipt().strayRows.map((row) => row.relation);
    expect(strayRelations.filter((relation) => relation === null)).toHaveLength(3);
    expect(strayRelations.filter((relation) => relation === "verifies")).toHaveLength(1);
  });

  /**
   * Ticket checkbox 2, and the primary MUTATION target: remove the
   * `relationScopedToTurns` CHECK arm from `memoryEdgesTableDdl` (or drop the
   * `${relationTurnScopedCheck}` splice in its `return` template) and this
   * test reddens — the first `expect(...).toThrow()` becomes a passing
   * insert instead.
   */
  test("narrows the CHECK: a relation-carrying non-turn→turn insert is refused; a bare one still succeeds", () => {
    // Drive the migration directly: `beforeEach`'s `initializeSchema` ends
    // PAST the cutover, whose table has no `relation` column at all, so every
    // probe below would fail to prepare instead of meeting THIS ticket's CHECK.
    toPending(db);
    const turnA = addTurn(1);
    const segmentA = addSegment("chapter one");
    ensureMemoryEdgesRelationTurnScoped(db, 3000);

    expect(() =>
      insertEdge("turn", turnA, "segment", segmentA, "consume", "asserted", 3000),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      insertEdge("session", sessionId, "turn", turnA, "consume", "asserted", 3000),
    ).toThrow(/CHECK constraint failed/);

    // The UNAFFECTED population: a fresh text-ref bare row still lands.
    expect(() =>
      insertEdge("turn", turnA, "segment", segmentA, null, "text-ref", 3000),
    ).not.toThrow();
    expect(edges()).toEqual([
      {
        citingKind: "turn",
        citingId: turnA,
        citedKind: "segment",
        citedId: segmentA,
        relation: null,
        provenance: "text-ref",
      },
    ]);
  });

  test("idempotent: a second run is a no-op — no rebuild, receipt timestamp unchanged", () => {
    toPending(db);
    const turnA = addTurn(1);
    const segmentA = addSegment("chapter one");
    insertEdge("turn", turnA, "segment", segmentA, null, "judged", 700);
    insertEdge("turn", turnA, "turn", addTurn(2), "consume", "asserted", 800);

    ensureMemoryEdgesRelationTurnScoped(db, 2000);
    const after = edges();
    const ddl = storedDdl();
    const stamp = receipt();

    ensureMemoryEdgesRelationTurnScoped(db, 4000);

    expect(edges()).toEqual(after);
    expect(storedDdl()).toBe(ddl);
    expect(receipt()).toEqual(stamp);
    // A rebuild that ran again would have left its temporary table behind on
    // the way through, so its absence is the cheap check that nothing ran.
    expect(
      db
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count FROM sqlite_master
           WHERE type = 'table' AND name = 'memory_edges_relation_turn_scoped_rebuild'`,
        )
        .get()!.count,
    ).toBe(0);
  });

  /**
   * THE MONOTONIC MARKER, as behaviour. The guard is gated on
   * `migration_receipts`, not on `memory_edges`'s own DDL text or physical
   * shape — this is the property `memoryEdgesRelationTurnScopedIsSettled`'s
   * own comment in schema.ts states as the reason no later rebuild of
   * `memory_edges` (and this table is rebuilt by name a dozen times over in
   * this file's history) can silently re-arm this migration.
   *
   * MUTATION: change `memoryEdgesRelationTurnScopedIsSettled` to inspect
   * `memory_edges`'s stored DDL (or any other physical signal) instead of
   * `hasMigrationReceipt`, and this test reddens — the widened table plus its
   * freshly-seeded stray row would be treated as "pending" again, deleting
   * the row and re-narrowing the CHECK the second call is supposed to leave
   * alone.
   */
  test("the guard trusts the receipt over memory_edges's own physical shape", () => {
    // Physically un-narrow WITHOUT touching the receipt — simulating a
    // database whose memory_edges DDL text a later, unrelated rebuild has
    // changed, the exact hazard this file's own migrations have been bitten
    // by twice (see the docstring on `memoryEdgesRelationTurnScopedIsSettled`
    // in schema.ts).
    widenBack(db);
    const turnA = addTurn(1);
    const segmentA = addSegment("chapter one");
    insertEdge("turn", turnA, "segment", segmentA, "verifies", "judged", 700);
    expect(edges()).toHaveLength(1);

    ensureMemoryEdgesRelationTurnScoped(db, 5000);

    // Untouched: the receipt said "done", so the stray row survives and the
    // CHECK stays wide — proving the receipt, not the table, is the marker.
    expect(edges()).toHaveLength(1);
    expect(() =>
      insertEdge("turn", turnA, "segment", segmentA, "consume", "asserted", 5100),
    ).not.toThrow();
  });

  /**
   * The precondition M-E-style migrations state as a check rather than a
   * comment: a relation-carrying non-turn→turn row under a DIFFERENT
   * provenance is NOT this ticket's cleanup predicate (`provenance='judged'`
   * only) and must refuse the narrow BY NAME instead of failing the copy with
   * a raw SQLITE_CONSTRAINT.
   */
  test("a relation-carrying non-turn→turn row under a different provenance refuses the narrow by name", () => {
    toPending(db);
    const turnA = addTurn(1);
    const segmentA = addSegment("chapter one");
    insertEdge("turn", turnA, "segment", segmentA, "consume", "asserted", 700);

    expect(() => ensureMemoryEdgesRelationTurnScoped(db, 2000)).toThrow(
      /still holds 1 relation-carrying row\(s\) that are not turn→turn/,
    );
    // Refused, not half-done: the row is still there and no receipt landed.
    expect(edges()).toHaveLength(1);
    expect(
      db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM migration_receipts WHERE name = ?",
        )
        .get(MEMORY_EDGES_RELATION_TURN_SCOPED_RECEIPT)!.n,
    ).toBe(0);
  });

  test("a reopen via initializeSchema leaves the narrow CHECK and the deletion alone", () => {
    toPending(db);
    const turnA = addTurn(1);
    const segmentA = addSegment("chapter one");
    insertEdge("turn", turnA, "segment", segmentA, null, "judged", 700);
    insertEdge("turn", turnA, "turn", addTurn(2), "consume", "asserted", 800);

    ensureMemoryEdgesRelationTurnScoped(db, 2000);
    const after = edges();

    initializeSchema(db);
    initializeSchema(db);

    // Past the cutover the live table has no word column; the archive is the
    // state this migration produced, and the reopen must not have moved it.
    expect(archivedEdges()).toEqual(after);
    expect(archivedDdl()).toContain(
      "CHECK (relation IS NULL OR (citing_kind = 'turn' AND cited_kind = 'turn'))",
    );
  });
});
