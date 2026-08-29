/**
 * The SECOND PROCESS in the staged-settlement column migration race (final
 * review, finding 8). Spawned by `tests/db/schema.note-settlement-migration.test.ts`;
 * never imported by a test module.
 *
 * It enters `ensureNoteSettlementStageSchema` while the PARENT holds the
 * database's write lock, so its `PRAGMA table_info` pre-check (a read, which
 * WAL permits under a held writer) sees a `note_settlement_jobs` with no
 * `stage` column and its ALTER then has to wait. The parent adds the columns
 * itself inside that lock and commits — the lost race in its worst form: this
 * process resumes holding a belief about the schema that is exactly one commit
 * out of date, and issues an `ALTER TABLE ADD COLUMN` for a column that now
 * exists.
 *
 * Two things must then be true, and the parent asserts both: this process must
 * not THROW (a schema-init throw takes the caller's real work down with it —
 * for the `session-init` hook, the turn row of the prompt being submitted),
 * and it must leave the winner's columns and rows alone. The write below is
 * how the parent sees that this process got all the way through the migration
 * to real work on the migrated shape.
 *
 * argv: <db path> <ready-marker path> <session db id>
 */
import { writeFileSync } from "node:fs";

import { createDatabase } from "../../src/db/database";
import {
  ensureNoteSettlementStageSchema,
  enqueueNoteSettlementWindows,
} from "../../src/db/note-settlement";

const [, , databasePath, readyMarkerPath, sessionIdText] = process.argv;
if (!databasePath || !readyMarkerPath || !sessionIdText) {
  throw new Error(
    "usage: note-settlement-stage-migration-racer.ts <db> <ready-marker> <session-id>",
  );
}

const db = createDatabase(databasePath);
// Announce readiness only after the connection is open, so the parent's wait
// covers everything between here and the blocked ALTER.
writeFileSync(readyMarkerPath, "ready");
ensureNoteSettlementStageSchema(db);
enqueueNoteSettlementWindows(
  db,
  [
    {
      sessionId: Number(sessionIdText),
      windowStart: 100,
      windowEnd: 110,
      triggerType: "consecutive",
    },
  ],
  1_800_000_000,
  1,
);
db.close();
