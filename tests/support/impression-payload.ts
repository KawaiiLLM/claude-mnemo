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
 * What a COMPLIANT settlement writer DOES before `commit` (lane-impressions
 * ticket 10): it records a decision for every container it touched, one
 * `remember(action: "impression")` call at a time.
 *
 * A fixture whose subject is edges, gates or shape numbers still has to
 * discharge the impression duty — a touched container with no decision refuses
 * the commit — and hand-writing the addresses and base revisions into each of
 * those fixtures would make them fail for reasons that have nothing to do with
 * what they test. This derives the same coordinates the run is shown, exactly as
 * a writer reading its own advisory would, and retains every one THROUGH THE
 * REAL TOOL HANDLER, so a fixture never reaches a seam the shipped run does not.
 *
 * NOT a shortcut around the fence: the base revisions come from the live rows,
 * so a fixture that moved an impression row between the decision and the commit
 * still gets rejected — which is what the fence tests assert.
 */
export async function retainAllImpressions(
  handlers: Map<string, (args: Record<string, unknown>, extra?: unknown) => unknown>,
  db: Database,
  jobId: number,
  writableTurnIds?: Iterable<number>,
): Promise<void> {
  const remember = handlers.get("remember");
  if (remember === undefined) {
    throw new Error("this dispatch registers no `remember` tool to write impressions through");
  }
  for (const advisory of advisoriesFor(db, jobId, writableTurnIds)) {
    const result = (await remember({
      action: "impression",
      id: advisory.address,
      baseRevision: advisory.baseRevision,
      decision: "retain",
    })) as { content: Array<{ text: string }> };
    const text = result.content[0]?.text ?? "";
    if (!text.startsWith("Impression recorded")) {
      throw new Error(`retainAllImpressions was refused for ${advisory.address}: ${text}`);
    }
  }
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
