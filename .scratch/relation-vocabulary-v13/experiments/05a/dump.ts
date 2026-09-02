/**
 * 05a measurement — the same two elected sets `dump-head.ts` takes at HEAD,
 * under ONE candidate parameterisation. Candidate A must equal the HEAD dump
 * byte for byte; that equality is the re-key's own acceptance.
 *
 * Usage: bun run dump.ts <db> <out.json> <candidateId> [frontierPageBudget] [hostCharLimit|none]
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
import { CANDIDATES } from "./candidates";

const dbPath = process.argv[2];
const outPath = process.argv[3];
const candidateId = process.argv[4] ?? "A";
const frontierPageBudget = Number(process.argv[5] ?? 2_000);
const hostCharLimitArg = process.argv[6] ?? String(9_500 - "[E999] · milestones".length - 1);
const hostCharLimit = hostCharLimitArg === "none" ? null : Number(hostCharLimitArg);
if (!dbPath || !outPath) throw new Error("usage: dump.ts <db> <out.json> <candidateId>");
const candidate = CANDIDATES[candidateId];
if (!candidate) throw new Error(`unknown candidate ${candidateId}`);

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
      frontierPageBudget,
      null,
      undefined,
      hostCharLimit,
      candidate.parameters,
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
      undefined,
      candidate.parameters,
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
  `${candidateId}: ${segmentIds.length} segments in ${((performance.now() - t0) / 1000).toFixed(1)}s -> ${outPath}`,
);
db.close();
