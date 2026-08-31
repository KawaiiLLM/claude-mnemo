import type { Database } from "bun:sqlite";

import {
  readNoteSettlementLaneMemberSnapshot,
  readNoteSettlementWritableTurnIds,
} from "../../src/db/note-settlement-snapshots";
import {
  computeTouchedImpressionContainers,
  loadImpressionAdvisories,
  resolveEraCutoffForImpressions,
  type ImpressionAdvisory,
} from "../../src/worker/note-settlement-impressions";

/**
 * What a COMPLIANT settlement writer sends at `commit` when it judges every
 * touched container unchanged (lane-impressions ticket 02).
 *
 * A fixture whose subject is edges, gates or shape numbers still has to satisfy
 * the impression obligation — a touched container with no judgment is a rejected
 * payload — and hand-writing the addresses and base revisions into each of those
 * fixtures would make them fail for reasons that have nothing to do with what
 * they test. This derives the same coordinates the run is shown, exactly as a
 * writer reading its own advisory would, and retains every one.
 *
 * NOT a shortcut around the fence: the base revisions come from the live rows,
 * so a fixture that moved an impression row between the advisory and the commit
 * still gets rejected — which is what the fence tests assert.
 */
export function retainAllImpressions(
  db: Database,
  jobId: number,
  writableTurnIds?: Iterable<number>,
): Array<{ id: string; baseRevision: number; decision: "retain" }> {
  return advisoriesFor(db, jobId, writableTurnIds).map((advisory) => ({
    id: advisory.address,
    baseRevision: advisory.baseRevision,
    decision: "retain" as const,
  }));
}

export function advisoriesFor(
  db: Database,
  jobId: number,
  writableTurnIds?: Iterable<number>,
): ImpressionAdvisory[] {
  return loadImpressionAdvisories(
    db,
    computeTouchedImpressionContainers(db, jobId),
    {
      eraCutoffEpoch: resolveEraCutoffForImpressions(db),
      projectedByLane: readNoteSettlementLaneMemberSnapshot(db, jobId),
      // Defaults to the job's own FROZEN writable set — the same authority the
      // run itself reads once its transition has landed.
      writableTurnIds: new Set(
        writableTurnIds ?? readNoteSettlementWritableTurnIds(db, jobId),
      ),
    },
  ).advisories;
}
