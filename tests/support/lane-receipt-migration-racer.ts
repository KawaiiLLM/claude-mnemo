/**
 * The SECOND PROCESS in the `lane_read_receipts` migration race
 * (phase-connectivity ticket 08, decision 4). Spawned by
 * `tests/db/lane-disposition.test.ts`; never imported by a test module.
 *
 * It enters `ensureLaneReadMemberCoverageReceipts` while the PARENT holds the
 * database's write lock, so its shape pre-check (a read, which WAL permits
 * under a held writer) sees the legacy `page_coverage` table and its drop then
 * has to wait. The parent migrates the table itself inside that lock and
 * commits — which is exactly the lost race: this process resumes holding a
 * belief about the schema that is one commit out of date.
 *
 * Two things must then be true, and the parent asserts both from the rows:
 * this process must not THROW (a schema-init throw takes the caller's real
 * work down with it — for the `session-init` hook, the turn row of the prompt
 * being submitted), and it must not DROP the table the parent has already
 * recreated and written into.
 *
 * Deliberately a separate process rather than a second connection: two
 * connections driven from one test body interleave in whatever order the test
 * writes down, which is the serial fixture this ticket rejected. Only real
 * processes contend for the lock on their own.
 *
 * argv: <db path> <ready-marker path> <segment id>
 */
import { writeFileSync } from "node:fs";

import { createDatabase } from "../../src/db/database";
import { ensureLaneReadMemberCoverageReceipts } from "../../src/db/schema";

const [, , databasePath, readyMarkerPath, segmentIdText] = process.argv;
if (!databasePath || !readyMarkerPath || !segmentIdText) {
  throw new Error("usage: lane-receipt-migration-racer.ts <db> <ready-marker> <segment-id>");
}

const db = createDatabase(databasePath);
// Announce readiness only after the connection is open, so the parent's wait
// covers everything between here and the blocked drop.
writeFileSync(readyMarkerPath, "ready");
ensureLaneReadMemberCoverageReceipts(db);
db.query<unknown, [number]>(
  `INSERT INTO lane_read_receipts
     (reader_id, segment_id, lane_tag, membership_snapshot, rendered_member_ids, sequence, created_at_epoch)
   VALUES ('claim:racer:1', ?, 'lane', '[11]', '[11]', 1, 1)`,
).run(Number(segmentIdText));
db.close();
