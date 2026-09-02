/**
 * 05a measurement — the BASELINE dump, run at HEAD (d06f4cc3) BEFORE the
 * re-keying lands. Its output is what candidate A must reproduce byte for byte.
 *
 * Two surfaces, because the frozen election is two elections and the ticket's
 * four keys are split across them:
 *
 *   `frontier`  — `buildSegmentFrontierSection`, the SessionStart milestone
 *                 slot, driven at its production budgets. The PER-LANE
 *                 election: `FRONTIER_OUT_EDGE_WEIGHTS`/`FRONTIER_IN_EDGE_
 *                 WEIGHTS` score each lane's settled members and the accepted
 *                 rows render under their lane's digest line. This is where
 *                 `use`'s in/out weight acts.
 *   `milestones`— `selectSegmentMilestonesByEdgeSignals` -> `electMilestones`,
 *                 the PER-SEGMENT election: tiers, in-degree, tier ④. This is
 *                 where the convergence rule (tier ①/②/④'s feeder) acts.
 *
 * Usage: bun run dump-head.ts <db> <out.json>
 */
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";

import { getSegment } from "../../../../src/db/segments";
import { chronologicalSegmentMembers } from "../../../../src/mcp/segment-card";
import {
  buildSegmentFrontierSection,
  DEFAULT_MILESTONE_PAGE_BUDGET,
  selectSegmentMilestonesByEdgeSignals,
} from "../../../../src/mcp/timeline";

const FRONTIER_PAGE_BUDGET = 2_000;
const HOST_CHAR_LIMIT = 9_500 - "[E999] · milestones".length - 1;

const dbPath = process.argv[2];
const outPath = process.argv[3];
if (!dbPath || !outPath) throw new Error("usage: dump-head.ts <db> <out.json>");

const db = new Database(dbPath);
const segmentIds = db
  .query<{ id: number }, []>("SELECT id FROM segments ORDER BY id")
  .all()
  .map((row) => row.id);

const out: unknown[] = [];
const t0 = performance.now();
for (const segmentId of segmentIds) {
  const segment = getSegment(db, segmentId);
  if (!segment) continue;
  let frontier = "";
  try {
    frontier = buildSegmentFrontierSection(
      db,
      segmentId,
      null,
      FRONTIER_PAGE_BUDGET,
      null,
      undefined,
      HOST_CHAR_LIMIT,
    );
  } catch (error) {
    frontier = `THREW ${String(error)}`;
  }
  let milestones: unknown[] = [];
  try {
    const selection = selectSegmentMilestonesByEdgeSignals(
      db,
      chronologicalSegmentMembers(db, segment, null),
      DEFAULT_MILESTONE_PAGE_BUDGET,
    );
    milestones = selection.kept.map((row) => ({
      turnId: row.member.turnId,
      address: `S${row.member.sessionId}/T${row.member.promptNumber}`,
      title: row.member.title,
    }));
  } catch (error) {
    milestones = [{ turnId: -1, address: "THREW", title: String(error) }];
  }
  out.push({ segmentId, frontier, milestones });
}
writeFileSync(outPath, `${JSON.stringify(out, null, 1)}\n`);
console.log(
  `baseline: ${segmentIds.length} segments in ${((performance.now() - t0) / 1000).toFixed(1)}s -> ${outPath}`,
);
db.close();
