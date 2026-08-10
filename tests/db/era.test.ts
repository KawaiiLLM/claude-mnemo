import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  ensureRecordedEraCutoff,
  getRecordedEraCutoff,
  resolveEraCutoff,
} from "../../src/db/era";
import { initializeSchema } from "../../src/db/schema";

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
  initializeSchema(db);
});

afterEach(() => db.close());

test("a fresh database has no era, so every turn in it is legacy", () => {
  // This is what a test database and a pre-cutover install both look like: the
  // boundary is recorded by a production entry point, never by the schema.
  expect(getRecordedEraCutoff(db)).toBeNull();
  expect(resolveEraCutoff(db)).toBeNull();
});

test("the first process to look records the boundary, and no later one moves it", () => {
  expect(ensureRecordedEraCutoff(db, 1_700_000_000)).toBe(1_700_000_000);
  // A restart, a second hook process, a clock that jumped: none of them may
  // move a boundary that turns have already been written against.
  expect(ensureRecordedEraCutoff(db, 1_800_000_000)).toBe(1_700_000_000);
  expect(ensureRecordedEraCutoff(db, 1_600_000_000)).toBe(1_700_000_000);
  expect(resolveEraCutoff(db)).toBe(1_700_000_000);
});

test("the recorded boundary is one row, and it carries when it was recorded", () => {
  ensureRecordedEraCutoff(db, 1_700_000_000);

  const rows = db
    .query<{ id: number; cutoffEpoch: number; recordedAtEpoch: number }, []>(
      `SELECT id, cutoff_epoch AS cutoffEpoch, recorded_at_epoch AS recordedAtEpoch
       FROM era_state`,
    )
    .all();

  expect(rows).toEqual([
    { id: 1, cutoffEpoch: 1_700_000_000, recordedAtEpoch: 1_700_000_000 },
  ]);
});
