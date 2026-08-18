import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { addSegmentMembers, createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { getTurnById, updateTurnById } from "../../src/db/turns";

/**
 * `turns.election_tier` (ADR-0003) is RETIRED (ownership-and-note-cadence
 * spec, ticket 06, "选举机器拆除") — the column no longer appears in
 * `SCHEMA_SQL`, `ensureTurnElectionTierColumn` is deleted, and neither
 * `TurnRecord` nor `updateTurnById`'s input carries the field any more. A
 * fresh database never gets the column.
 *
 * What THIS file exists to prove is the migration-safety half: a database
 * migrated under a PRE-06 install may still physically carry the column
 * (added by the now-deleted `ensureTurnElectionTierColumn`), and `turns`'s
 * two hardcoded-column-list rebuilds (`ensureTurnTypeMultiValueColumn`,
 * `retireTurnCitesRecordedColumn`) must not throw when they find it — the
 * `assertNoUnexpectedTurnsColumns` guard those rebuilds run under would
 * otherwise treat an unlisted-but-present column as a silent-drop hazard and
 * refuse to proceed (see schema.ts's own doc comment on that guard). Ticket
 * 06 added `election_tier` to both rebuilds' `droppedColumns` allowlist
 * specifically so this case is a KNOWN, INTENTIONAL drop rather than an
 * unaccounted-for column; these tests are the regression coverage for that
 * fix.
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

/** Simulate a pre-06 install: add back the column `ensureTurnElectionTierColumn` used to add. */
function addStrayElectionTierColumn(target: Database): void {
  target.exec(
    `ALTER TABLE turns ADD COLUMN election_tier TEXT CHECK (election_tier IS NULL OR election_tier IN ('A', 'B', 'C'))`,
  );
}

describe("a fresh database never carries election_tier", () => {
  test("the column does not exist, and TurnRecord has no field for it", () => {
    const sessionDbId = seedSession();
    const turnId = seedTurn(sessionDbId, 1);

    expect(
      db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('turns')").all(),
    ).not.toEqual(expect.arrayContaining([{ name: "election_tier" }]));
    expect(getTurnById(db, turnId)!).not.toHaveProperty("electionTier");
  });
});

describe("an orphaned election_tier column (a pre-06 install) survives the turns table's own hardcoded-column-list rebuilds without throwing", () => {
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

  test("ensureTurnTypeMultiValueColumn's rebuild drops the stray column silently — no throw, every other field and dependent row survives", () => {
    const sessionDbId = seedSession();
    const turnId = seedTurn(sessionDbId, 1);
    addStrayElectionTierColumn(db);
    db.query<unknown, [string, number]>(
      "UPDATE turns SET election_tier = ? WHERE id = ?",
    ).run("C", turnId);
    updateTurnById(db, turnId, { significanceGrade: 1 });
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
    expect(staleDdl).toContain("election_tier");

    // The load-bearing assertion: no throw. Before ticket 06 added
    // `election_tier` to `droppedColumns`, this would have thrown
    // "turns carries column(s) this rebuild does not know about".
    expect(() => initializeSchema(db)).not.toThrow();

    const turn = getTurnById(db, turnId)!;
    expect(turn).not.toHaveProperty("electionTier");
    expect(turn.significanceGrade).toBe(1);
    expect(
      db
        .query<{ count: number }, [number]>(
          "SELECT COUNT(*) AS count FROM segment_members WHERE turn_id = ?",
        )
        .get(turnId)!.count,
    ).toBe(1);
    // The rebuilt table's own DDL no longer states the retired column — the
    // drop actually happened, not merely "didn't crash".
    const rebuiltDdl = db
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'turns'",
      )
      .get()!.sql;
    expect(rebuiltDdl).not.toContain("election_tier");
  });

  test("retireTurnCitesRecordedColumn's rebuild drops the stray column silently — no throw, every other field and dependent row survives", () => {
    const sessionDbId = seedSession();
    const turnId = seedTurn(sessionDbId, 1);
    addStrayElectionTierColumn(db);
    db.query<unknown, [string, number]>(
      "UPDATE turns SET election_tier = ? WHERE id = ?",
    ).run("B", turnId);
    const segment = createSegment(db, { title: "chapter", nowEpoch: NOW });
    addSegmentMembers(db, segment.id, [turnId], NOW);

    // Reproduce a database that still carries the retired `cites_recorded`
    // column — `retireTurnCitesRecordedColumn`'s own staleness predicate
    // (schema.ts: `hasColumn(db, "turns", "cites_recorded")`).
    db.exec("ALTER TABLE turns ADD COLUMN cites_recorded INTEGER NOT NULL DEFAULT 0");
    expect(
      db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('turns')").all(),
    ).toEqual(
      expect.arrayContaining([{ name: "cites_recorded" }, { name: "election_tier" }]),
    );

    expect(() => initializeSchema(db)).not.toThrow();

    const turn = getTurnById(db, turnId)!;
    expect(turn).not.toHaveProperty("electionTier");
    expect(
      db
        .query<{ count: number }, [number]>(
          "SELECT COUNT(*) AS count FROM segment_members WHERE turn_id = ?",
        )
        .get(turnId)!.count,
    ).toBe(1);
    const columns = db
      .query<{ name: string }, []>("SELECT name FROM pragma_table_info('turns')")
      .all();
    expect(columns).not.toEqual(expect.arrayContaining([{ name: "cites_recorded" }]));
    expect(columns).not.toEqual(expect.arrayContaining([{ name: "election_tier" }]));
  });
});
