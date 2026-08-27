import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  initializeSchema,
  TURN_ERA_GRANT_SEED_RECEIPT,
  type TurnEraGrantSeedReceipt,
} from "../../src/db/schema";
import { ERA_GRANT_COLUMN } from "../../src/segment-era";

/**
 * era-grant-by-settlement ticket 01 — the one-time seed.
 *
 * The population is WINDOW COVERAGE, not turns reviewed (ruled [S15069/T1818]):
 * a turn whose window a `done`, post-cutoff settlement job processed was
 * annotated under the current model, whether or not the agent chose to write a
 * note on that particular turn. Coverage is also the only population
 * reconstructible after the fact — `turnsReviewed` survives as a count and never
 * per turn.
 *
 * Every assertion here names the turns granted and the turns deliberately not.
 * A count alone would pass for a sweep that granted the wrong thousand rows.
 */

const CUTOFF = 2_000;
const LEGACY = 1_000;
const ERA = 3_000;

function readReceipt(db: Database): TurnEraGrantSeedReceipt | null {
  const row = db
    .query<{ payload: string }, [string]>(
      "SELECT payload FROM migration_receipts WHERE name = ?",
    )
    .get(TURN_ERA_GRANT_SEED_RECEIPT);
  return row ? (JSON.parse(row.payload) as TurnEraGrantSeedReceipt) : null;
}

function grantOf(db: Database, turnId: number): number | null {
  return (
    db
      .query<{ grantEpoch: number | null }, [number]>(
        `SELECT ${ERA_GRANT_COLUMN} AS grantEpoch FROM turns WHERE id = ?`,
      )
      .get(turnId)?.grantEpoch ?? null
  );
}

describe("era grant seed migration", () => {
  let db: Database;
  let sessionId: number;

  function makeTurn(promptNumber: number, createdAtEpoch: number): number {
    return db
      .query<{ id: number }, [number, number, number]>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch)
         VALUES (?, ?, 'extracted', ?) RETURNING id`,
      )
      .get(sessionId, promptNumber, createdAtEpoch)!.id;
  }

  function makeJob(
    windowStart: number,
    windowEnd: number,
    status: string,
    updatedAtEpoch: number,
    triggerType = "consecutive",
  ): void {
    db.query<unknown, [number, number, number, string, string, number]>(
      `INSERT INTO note_settlement_jobs (
         session_id, window_start, window_end, trigger_type, status,
         created_at_epoch, updated_at_epoch
       ) VALUES (?, ?, ?, ?, ?, 0, ?)`,
    ).run(sessionId, windowStart, windowEnd, triggerType, status, updatedAtEpoch);
  }

  /**
   * Put the database back into the shape it had before this migration existed:
   * the column gone and the receipt with it. Dropping only one of the two would
   * rehearse a state no real installation was ever in.
   */
  function rewindMigration(): void {
    db.exec(`ALTER TABLE turns DROP COLUMN ${ERA_GRANT_COLUMN}`);
    db.query<unknown, [string]>(
      "DELETE FROM migration_receipts WHERE name = ?",
    ).run(TURN_ERA_GRANT_SEED_RECEIPT);
  }

  function recordEra(cutoffEpoch: number): void {
    db.query<unknown, [number, number]>(
      "INSERT OR REPLACE INTO era_state (id, cutoff_epoch, recorded_at_epoch) VALUES (1, ?, ?)",
    ).run(cutoffEpoch, cutoffEpoch);
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = db
      .query<{ id: number }, []>(
        `INSERT INTO sessions (content_session_id, project, created_at_epoch)
         VALUES ('era-grant-seed', '/tmp/era-grant', 1) RETURNING id`,
      )
      .get()!.id;
  });

  afterEach(() => {
    db.close();
  });

  test("a fresh database with no recorded era records a `no-era` receipt", () => {
    // Stated rather than left as a missing receipt: "never saw this database"
    // and "saw it and had nothing to do" are different answers.
    const receipt = readReceipt(db);
    expect(receipt?.disposition).toBe("no-era");
    expect(receipt?.cutoffEpoch).toBeNull();
    expect(receipt?.granted).toBe(0);
    expect(receipt?.grantedTotal).toBe(0);
  });

  test("the seed grants exactly the pre-era turns a done post-cutoff job covered", () => {
    const covered = makeTurn(10, LEGACY);
    const coveredNeighbour = makeTurn(11, LEGACY);
    const outsideWindow = makeTurn(20, LEGACY);
    const failedJobTurn = makeTurn(30, LEGACY);
    const preCutoffJobTurn = makeTurn(40, LEGACY);
    const alreadyEra = makeTurn(50, ERA);

    makeJob(10, 11, "done", CUTOFF + 500);
    makeJob(30, 30, "failed", CUTOFF + 500, "residual");
    // A job the RETIRED build completed: `done`, but before the cutoff, so it
    // vouches for nothing about the current model.
    makeJob(40, 40, "done", CUTOFF - 500, "compact");
    // The era turn is inside a covering window too — and must still cost no
    // write, because it was never invisible.
    makeJob(50, 50, "done", CUTOFF + 500, "sessionend");

    recordEra(CUTOFF);
    rewindMigration();
    initializeSchema(db);

    expect(grantOf(db, covered)).toBe(CUTOFF + 500);
    expect(grantOf(db, coveredNeighbour)).toBe(CUTOFF + 500);
    expect(grantOf(db, outsideWindow)).toBeNull();
    expect(grantOf(db, failedJobTurn)).toBeNull();
    expect(grantOf(db, preCutoffJobTurn)).toBeNull();
    expect(grantOf(db, alreadyEra)).toBeNull();

    const receipt = readReceipt(db);
    expect(receipt?.disposition).toBe("seeded");
    expect(receipt?.cutoffEpoch).toBe(CUTOFF);
    expect(receipt?.granted).toBe(2);
    expect(receipt?.grantedTotal).toBe(2);
  });

  test("the grant epoch is the EARLIEST covering job's completion, not migration time", () => {
    // "When did this turn become current" has to answer with the moment the
    // current model first covered it — which is why the column is an epoch and
    // not a boolean.
    const turnId = makeTurn(10, LEGACY);
    makeJob(10, 10, "done", CUTOFF + 900, "consecutive");
    makeJob(9, 12, "done", CUTOFF + 400, "backfill");

    recordEra(CUTOFF);
    rewindMigration();
    initializeSchema(db);

    expect(grantOf(db, turnId)).toBe(CUTOFF + 400);
  });

  test("running the migration again grants the same set and re-stamps nothing", () => {
    const covered = makeTurn(10, LEGACY);
    const uncovered = makeTurn(20, LEGACY);
    makeJob(10, 10, "done", CUTOFF + 500);

    recordEra(CUTOFF);
    rewindMigration();
    initializeSchema(db);

    const first = grantOf(db, covered);
    const firstReceipt = readReceipt(db);

    initializeSchema(db);
    initializeSchema(db);

    expect(grantOf(db, covered)).toBe(first);
    expect(grantOf(db, uncovered)).toBeNull();
    // The column already exists on the second pass, so the sweep does not run
    // at all — and the receipt still names the count from the pass that did.
    expect(readReceipt(db)).toEqual(firstReceipt);
    expect(firstReceipt?.granted).toBe(1);
    expect(firstReceipt?.grantedTotal).toBe(1);
  });

  test("a hand-set grant is never revoked by a later run", () => {
    const turnId = makeTurn(10, LEGACY);
    recordEra(CUTOFF);
    rewindMigration();
    initializeSchema(db);
    expect(grantOf(db, turnId)).toBeNull();

    db.query<unknown, [number]>(
      `UPDATE turns SET ${ERA_GRANT_COLUMN} = ${CUTOFF + 700} WHERE id = ?`,
    ).run(turnId);
    initializeSchema(db);
    expect(grantOf(db, turnId)).toBe(CUTOFF + 700);
  });
});

describe("the era grant column and the turns rebuilds", () => {
  /**
   * `turns` has TWO table rebuilds, each copying from an explicit column list
   * under `assertNoUnexpectedTurnsColumns` — the guard that refuses to silently
   * drop a column nobody told the rebuild about. A grant column that guard does
   * not know about is exactly the bug that guard exists to catch, so the column
   * joins `CONDITIONAL_TURNS_COLUMNS`: carried through when present, never
   * assumed.
   *
   * Two databases, two directions. First the legacy one that still needs both
   * rebuilds (a scalar `type` and a live `cites_recorded`) and does not yet have
   * the column; then the already-migrated one that does.
   */
  test("a legacy turns table still needing both rebuilds migrates and ends with the column", () => {
    const db = createDatabase(":memory:");
    try {
      db.exec(`
        CREATE TABLE sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          content_session_id TEXT UNIQUE NOT NULL,
          project TEXT NOT NULL,
          created_at_epoch INTEGER NOT NULL
        );
        CREATE TABLE turns (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER NOT NULL,
          prompt_number INTEGER NOT NULL,
          content_prompt_id TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          user_prompt TEXT,
          assistant_response TEXT,
          title TEXT,
          content TEXT,
          insight TEXT,
          type TEXT,
          tags TEXT,
          files_read TEXT,
          files_modified TEXT,
          tool_call_count INTEGER,
          cites_recorded INTEGER NOT NULL DEFAULT 0,
          created_at_epoch INTEGER NOT NULL,
          updated_at_epoch INTEGER
        );
        INSERT INTO sessions (content_session_id, project, created_at_epoch)
        VALUES ('era-grant-legacy', 'claude-mnemo', 1);
        INSERT INTO turns (session_id, prompt_number, status, type, created_at_epoch)
        VALUES (1, 1, 'extracted', 'discovery', ${LEGACY});
      `);

      expect(() => initializeSchema(db)).not.toThrow();

      const columns = db
        .query<{ name: string }, []>("PRAGMA table_info(turns)")
        .all()
        .map((row) => row.name);
      expect(columns).toContain(ERA_GRANT_COLUMN);
      expect(columns).not.toContain("cites_recorded");
      // The rebuild carried the row through; the value-preserving type wrap is
      // the other migration's business, asserted here only to prove the
      // rebuilds really did run in this fixture.
      expect(
        db.query<{ type: string }, []>("SELECT type FROM turns WHERE id = 1").get()
          ?.type,
      ).toBe('["discovery"]');
      expect(readReceipt(db)?.disposition).toBe("no-era");
    } finally {
      db.close();
    }
  });

  test("a rebuild run against an already-granted database carries the grants through", () => {
    // The other direction, and the one that actually bit: both rebuilds are
    // reachable on a database that has been through `ensureTurnEraGrantColumn`
    // already — `initializeSchema` runs them before it, but they are also
    // called directly, and a future migration could reopen either. Dropping a
    // grant here would silently un-publish every turn a settlement paid for.
    const db = createDatabase(":memory:");
    try {
      initializeSchema(db);
      const sessionId = db
        .query<{ id: number }, []>(
          `INSERT INTO sessions (content_session_id, project, created_at_epoch)
           VALUES ('era-grant-rebuild', '/tmp/era-grant', 1) RETURNING id`,
        )
        .get()!.id;
      const turnId = db
        .query<{ id: number }, [number]>(
          `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch,
                              ${ERA_GRANT_COLUMN})
           VALUES (?, 1, 'extracted', ${LEGACY}, ${CUTOFF + 42}) RETURNING id`,
        )
        .get(sessionId)!.id;

      // Put `cites_recorded` back so the rebuild has something to do, then run
      // the whole chain again the way a reopened database would.
      db.exec("ALTER TABLE turns ADD COLUMN cites_recorded INTEGER NOT NULL DEFAULT 0");
      expect(() => initializeSchema(db)).not.toThrow();

      expect(
        db
          .query<{ name: string }, []>("PRAGMA table_info(turns)")
          .all()
          .map((row) => row.name),
      ).not.toContain("cites_recorded");
      expect(grantOf(db, turnId)).toBe(CUTOFF + 42);
    } finally {
      db.close();
    }
  });
});
