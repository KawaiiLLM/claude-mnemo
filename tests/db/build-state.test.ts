import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import {
  isBuildStaleForDatabase,
  readInitializerBuild,
  recordInitializerBuild,
} from "../../src/db/build-state";
import { createDatabase } from "../../src/db/database";
import { initializeDatabase, initializeSchema } from "../../src/db/schema";
import { BUILD_ID } from "../../src/shared/build-id";

/**
 * Which build last migrated this database (ticket 08). The question is asked in
 * TIME, never in version order: a build cannot tell whether another id is newer
 * or older than its own, but it does know when it booted, and "somebody else
 * stamped this database after that" is precisely the hazard — the schema moved
 * underneath a process that is still writing the previous release's SQL.
 */

let db: Database;

/** This worker's own id, and the one that updated the plugin out from under it. */
const OWN_BUILD = "0.10.0-msqdbiq3";
const FOREIGN_BUILD = "0.11.1-p91xq2k7";
const BOOT_EPOCH = 1_700_000_000;

beforeEach(() => {
  db = createDatabase(":memory:");
  initializeSchema(db);
});

afterEach(() => db.close());

test("a database nobody has stamped makes nobody stale", () => {
  // The pre-ticket-08 install, and every test fixture: no row, no accusation.
  expect(readInitializerBuild(db)).toBeNull();
  expect(isBuildStaleForDatabase(db, OWN_BUILD, BOOT_EPOCH)).toBe(false);
});

test("a build's own stamp never makes it stale, however long after boot it lands", () => {
  // The ordinary boot: the worker IS the initializer. Comparing timestamps alone
  // would make every worker that migrates its own database instantly stale.
  recordInitializerBuild(db, OWN_BUILD, BOOT_EPOCH + 86_400);

  expect(isBuildStaleForDatabase(db, OWN_BUILD, BOOT_EPOCH)).toBe(false);
});

test("a foreign stamp recorded after boot is stale", () => {
  // The incident: a hook process on the new release runs the migrations while
  // this worker is resident.
  recordInitializerBuild(db, FOREIGN_BUILD, BOOT_EPOCH + 1);

  expect(isBuildStaleForDatabase(db, OWN_BUILD, BOOT_EPOCH)).toBe(true);
});

test("a foreign stamp recorded before boot is not stale", () => {
  // Nothing moved underneath anyone: whatever that build migrated, this process
  // opened the database afterwards and came up on the result.
  recordInitializerBuild(db, FOREIGN_BUILD, BOOT_EPOCH - 1);

  expect(isBuildStaleForDatabase(db, OWN_BUILD, BOOT_EPOCH)).toBe(false);
});

test("a foreign stamp in the same second as boot is stale", () => {
  // The `>=` boundary, and the reason it is not `>`: both sides are whole
  // seconds, so the migration that lands in the same second as boot is the
  // update race at its narrowest and likeliest — reading it as fresh would
  // reopen the window exactly where it is most likely to be hit.
  recordInitializerBuild(db, FOREIGN_BUILD, BOOT_EPOCH);

  expect(isBuildStaleForDatabase(db, OWN_BUILD, BOOT_EPOCH)).toBe(true);
});

test("re-recording the same build writes nothing, timestamp included", () => {
  recordInitializerBuild(db, OWN_BUILD, BOOT_EPOCH);
  recordInitializerBuild(db, OWN_BUILD, BOOT_EPOCH + 5_000);

  // Not merely "the id is still right": `initializeDatabase` runs in every hook
  // process, so an unconditional write would put a transaction on the hook
  // critical path once per event to record something that did not change. The
  // timestamp is what proves no write happened.
  expect(readInitializerBuild(db)).toEqual({
    buildId: OWN_BUILD,
    recordedAtEpoch: BOOT_EPOCH,
  });
});

test("a different build takes the single row over in place", () => {
  recordInitializerBuild(db, OWN_BUILD, BOOT_EPOCH);
  recordInitializerBuild(db, FOREIGN_BUILD, BOOT_EPOCH + 10);

  const rows = db
    .query<{ id: number; buildId: string; recordedAtEpoch: number }, []>(
      `SELECT id, build_id AS buildId, recorded_at_epoch AS recordedAtEpoch
       FROM build_state`,
    )
    .all();

  expect(rows).toEqual([
    { id: 1, buildId: FOREIGN_BUILD, recordedAtEpoch: BOOT_EPOCH + 10 },
  ]);
});

test("initializeDatabase stamps BUILD_ID as this database's initializer", () => {
  // The stamp is the migrations' own receipt: whoever ran them says so, and the
  // schema alone never writes this row.
  expect(readInitializerBuild(db)).toBeNull();

  initializeDatabase(db);

  const recorded = readInitializerBuild(db);
  expect(recorded?.buildId).toBe(BUILD_ID);
  expect(recorded!.recordedAtEpoch).toBeGreaterThan(0);
  // And the process that just ran them is not stale against its own work.
  expect(
    isBuildStaleForDatabase(db, BUILD_ID, Math.floor(Date.now() / 1000)),
  ).toBe(false);
});
