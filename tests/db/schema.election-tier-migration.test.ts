import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { addSegmentMembers, createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { getTurnById, updateTurnById } from "../../src/db/turns";

/**
 * ADR-0003 (ticket 06): `turns.election_tier`, the third grading semantics.
 *
 * Unlike the `note_settlement_jobs.trigger_type` CHECK-widening family this
 * ticket's own background pointed at (schema.note-settlement-migration.test.ts,
 * the 12-step rebuild + its cascade-delete lesson), `election_tier` is a
 * BRAND NEW column whose CHECK references only itself — the exact shape
 * `significance_grade` already has (`ensureTurnSignificanceGradeColumn`).
 * SQLite's `ALTER TABLE … ADD COLUMN` accepts a self-referencing CHECK
 * without a rebuild, so there is no rename-away step and therefore no
 * cascade-delete hazard to demonstrate for THIS migration specifically — the
 * dependent-row test below exists to prove that claim on real foreign-key
 * shaped data, not to exercise a rebuild that never runs.
 *
 * What DOES rebuild `turns` on a real database — `ensureTurnTypeMultiValueColumn`
 * and `retireTurnCitesRecordedColumn`, both hardcoded column-list rebuilds —
 * had to be taught about `election_tier` too (schema.ts), or
 * `assertNoUnexpectedTurnsColumns` would throw the moment either fires on a
 * database that already carries it (which is every database, since
 * `ensureTurnElectionTierColumn` runs first in `initializeSchema`). The last
 * two tests below force that path and prove the column survives it.
 */

const NOW = 1_800_000_000;

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
  initializeSchema(db);
});

afterEach(() => {
  db.close();
});

function seedSession(): number {
  return upsertSession(db, {
    contentSessionId: "election-tier-migration-session",
    project: "/tmp/project-election-tier-migration",
    title: null,
    content: null,
    insight: null,
    createdAtEpoch: NOW,
    updatedAtEpoch: NOW,
    completedAtEpoch: null,
  }).id;
}

function seedTurn(sessionDbId: number, promptNumber: number): number {
  return db
    .query<{ id: number }, [number, number, string, number]>(
      `INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch)
       VALUES (?, ?, 'active', ?, ?) RETURNING id`,
    )
    .get(sessionDbId, promptNumber, `prompt ${promptNumber}`, NOW)!.id;
}

describe("a fresh database carries election_tier from creation", () => {
  test("the column exists, nullable, defaulting to NULL on a new row", () => {
    const sessionDbId = seedSession();
    const turnId = seedTurn(sessionDbId, 1);

    expect(getTurnById(db, turnId)!.electionTier).toBeNull();
  });

  test("the CHECK constraint accepts A/B/C and NULL, and rejects anything else", () => {
    const sessionDbId = seedSession();
    const turnId = seedTurn(sessionDbId, 1);

    for (const tier of ["A", "B", "C"]) {
      expect(() =>
        db
          .query<unknown, [string, number]>(
            "UPDATE turns SET election_tier = ? WHERE id = ?",
          )
          .run(tier, turnId),
      ).not.toThrow();
    }
    expect(() =>
      db
        .query<unknown, [number]>("UPDATE turns SET election_tier = NULL WHERE id = ?")
        .run(turnId),
    ).not.toThrow();

    expect(() =>
      db
        .query<unknown, [string, number]>(
          "UPDATE turns SET election_tier = ? WHERE id = ?",
        )
        .run("D", turnId),
    ).toThrow();
    expect(() =>
      db
        .query<unknown, [string, number]>(
          "UPDATE turns SET election_tier = ? WHERE id = ?",
        )
        .run("a", turnId),
    ).toThrow();
  });

  test("updateTurnById writes and clears election_tier independently of significance_grade", () => {
    const sessionDbId = seedSession();
    const turnId = seedTurn(sessionDbId, 1);

    updateTurnById(db, turnId, { electionTier: "B" });
    let turn = getTurnById(db, turnId)!;
    expect(turn.electionTier).toBe("B");
    expect(turn.significanceGrade).toBeNull();

    updateTurnById(db, turnId, { significanceGrade: 2 });
    turn = getTurnById(db, turnId)!;
    // Omitted field (electionTier) leaves the existing value alone — the
    // same "undefined = leave alone" contract every other field here has.
    expect(turn.electionTier).toBe("B");
    expect(turn.significanceGrade).toBe(2);

    updateTurnById(db, turnId, { electionTier: null });
    expect(getTurnById(db, turnId)!.electionTier).toBeNull();
  });
});

describe("a pre-existing database missing election_tier is migrated without row loss", () => {
  /**
   * Simulate a database from before this ticket: the column simply is not
   * there yet. `ALTER TABLE … DROP COLUMN` is itself the tool being trusted
   * here, so this fixture goes the other direction from the rename-based
   * downgrades in schema.note-settlement-migration.test.ts — there is no
   * rebuild to reverse, only a column to remove.
   */
  function downgradeToPreElectionTierSchema(target: Database): void {
    target.exec("ALTER TABLE turns DROP COLUMN election_tier");
  }

  test("initializeSchema adds the column back, keeping every existing row and its FK-dependent rows intact", () => {
    const sessionDbId = seedSession();
    const turnId = seedTurn(sessionDbId, 1);
    updateTurnById(db, turnId, { significanceGrade: 3, type: ["design"], tags: ["lease"] });

    // A dependent row via the two live foreign keys onto `turns(id)` this
    // migration must not disturb: segment membership (segment_members) and
    // the segment it points at.
    const segment = createSegment(db, { title: "chapter", nowEpoch: NOW });
    addSegmentMembers(db, segment.id, [turnId], NOW);

    downgradeToPreElectionTierSchema(db);
    expect(() =>
      db
        .query<unknown, [string, number]>(
          "UPDATE turns SET election_tier = ? WHERE id = ?",
        )
        .run("A", turnId),
    ).toThrow();

    initializeSchema(db);

    // The turn survived, verbatim, with every OTHER field untouched — this
    // is not a rebuild, so there is no column list that could have silently
    // dropped anything.
    const turn = getTurnById(db, turnId)!;
    expect(turn.electionTier).toBeNull();
    expect(turn.significanceGrade).toBe(3);
    expect(turn.type).toEqual(["design"]);
    expect(turn.tags).toEqual(["lease"]);

    // …and so did the dependent row a cascade would have eaten had this been
    // a rename-based rebuild instead of a plain ADD COLUMN.
    expect(
      db
        .query<{ count: number }, [number]>(
          "SELECT COUNT(*) AS count FROM segment_members WHERE turn_id = ?",
        )
        .get(turnId)!.count,
    ).toBe(1);

    // The widened column now accepts a real write.
    updateTurnById(db, turnId, { electionTier: "A" });
    expect(getTurnById(db, turnId)!.electionTier).toBe("A");
  });

  test("is idempotent — running the migration twice changes nothing further", () => {
    const sessionDbId = seedSession();
    const turnId = seedTurn(sessionDbId, 1);
    downgradeToPreElectionTierSchema(db);

    initializeSchema(db);
    const afterFirst = getTurnById(db, turnId);

    initializeSchema(db);
    initializeSchema(db);

    expect(getTurnById(db, turnId)).toEqual(afterFirst);
  });
});

describe("election_tier survives the turns table's own hardcoded-column-list rebuilds", () => {
  /**
   * Force `ensureTurnTypeMultiValueColumn`'s rebuild to fire by putting
   * `type` back on its pre-ticket-02 scalar shape — the same downgrade
   * idiom `turnsTypeColumnIsStale` detects (schema.ts: "does the stored DDL
   * lack the array CHECK"). Column-order-preserving `ALTER … RENAME`/rebuild
   * is overkill here; a raw DDL swap is enough to trip the staleness read.
   */
  function downgradeToScalarTypeColumn(target: Database): void {
    target.exec("PRAGMA foreign_keys = OFF;");
    target.exec(`
      CREATE TABLE turns_scalar_type_downgrade AS SELECT * FROM turns;
      DROP TABLE turns;
      ALTER TABLE turns_scalar_type_downgrade RENAME TO turns;
    `);
    target.exec("PRAGMA foreign_keys = ON;");
  }

  test("ensureTurnTypeMultiValueColumn's rebuild carries election_tier through untouched", () => {
    const sessionDbId = seedSession();
    const turnId = seedTurn(sessionDbId, 1);
    updateTurnById(db, turnId, { electionTier: "C", significanceGrade: 1 });
    const segment = createSegment(db, { title: "chapter", nowEpoch: NOW });
    addSegmentMembers(db, segment.id, [turnId], NOW);

    downgradeToScalarTypeColumn(db);
    // Confirms the fixture actually reproduces the staleness this rebuild
    // detects — a `type` column with no array CHECK — so the assertion below
    // exercises the real rebuild path, not a no-op.
    const staleDdl = db
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'turns'",
      )
      .get()!.sql;
    expect(staleDdl).not.toContain("CHECK (json_type(type) = 'array')");

    initializeSchema(db);

    const turn = getTurnById(db, turnId)!;
    expect(turn.electionTier).toBe("C");
    expect(turn.significanceGrade).toBe(1);
    expect(
      db
        .query<{ count: number }, [number]>(
          "SELECT COUNT(*) AS count FROM segment_members WHERE turn_id = ?",
        )
        .get(turnId)!.count,
    ).toBe(1);
    // The rebuilt table's own DDL states the CHECK this ticket added — proof
    // the rebuild's hardcoded column list was actually taught about it,
    // not merely that data happened to survive by accident.
    const rebuiltDdl = db
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'turns'",
      )
      .get()!.sql;
    expect(rebuiltDdl).toContain("election_tier");
  });

  test("retireTurnCitesRecordedColumn's rebuild carries election_tier through untouched", () => {
    const sessionDbId = seedSession();
    const turnId = seedTurn(sessionDbId, 1);
    updateTurnById(db, turnId, { electionTier: "B" });
    const segment = createSegment(db, { title: "chapter", nowEpoch: NOW });
    addSegmentMembers(db, segment.id, [turnId], NOW);

    // Reproduce a database that still carries the retired `cites_recorded`
    // column — `retireTurnCitesRecordedColumn`'s own staleness predicate
    // (schema.ts: `hasColumn(db, "turns", "cites_recorded")`).
    db.exec("ALTER TABLE turns ADD COLUMN cites_recorded INTEGER NOT NULL DEFAULT 0");
    expect(
      db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('turns')").all(),
    ).toEqual(expect.arrayContaining([{ name: "cites_recorded" }]));

    initializeSchema(db);

    const turn = getTurnById(db, turnId)!;
    expect(turn.electionTier).toBe("B");
    expect(
      db
        .query<{ count: number }, [number]>(
          "SELECT COUNT(*) AS count FROM segment_members WHERE turn_id = ?",
        )
        .get(turnId)!.count,
    ).toBe(1);
    expect(
      db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('turns')").all(),
    ).not.toEqual(expect.arrayContaining([{ name: "cites_recorded" }]));
  });
});
