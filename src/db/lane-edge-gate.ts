import type { Database } from "bun:sqlite";

import { checkCanonicalLaneTag } from "./lanes";
import type { LaneEndpointRegistryFact, LaneRegistryFacts } from "../shared/turn-phase";

/**
 * The DB-aware half of the tagged-edge write gate (lane-declaration spec D2,
 * ticket 02). `shared/turn-phase.ts`'s `validateRelationTarget` owns the
 * ORDER and the wording of every refusal; this module owns only the reads
 * that turn a proposed edge into the evidence that judgment needs — the same
 * "caller pre-computes, the shared module judges" split `citingPhases` and
 * Gate C's `isCurrentTerminus` already have.
 *
 * Why the split rather than one DB-aware validator: the three per-tag checks
 * (canonical form, declaration, subset invariant) have to run IN THAT ORDER,
 * and the subset invariant lives inside `validateRelationTarget`. A gate that
 * ran around that function instead of inside it would put the registry checks
 * on one side of the subset check in `mcp/note.ts` and on the other in
 * `worker/note-settlement-turn-facade.ts` the first time either was edited
 * alone.
 *
 * DEPENDENCY DIRECTION. This module queries `segment_members` directly rather
 * than importing `db/segments.ts`'s `getOwningSegmentId` — the same one-way
 * convention `db/segments.ts`'s own `findRetagLaneCollisions` states for the
 * mirror case (it queries `lanes` directly rather than importing
 * `db/lanes.ts`, which reads `getOwningSegmentId` from it). The tie-break for
 * a legacy turn holding several membership rows is `MIN(segment_id)`, which is
 * `getOwningSegmentId`'s own "lowest id wins".
 *
 * The MEMBERSHIP half of D2 — re-checking incident tagged edges when a turn
 * MOVES between segments — is not here: it lives on the single membership
 * write primitive it guards (`db/segments.ts`'s `reassignSegmentMembers`), so
 * that no membership path can reach the table without passing it.
 */

/** `getOwningSegmentId`'s query, batched for a turn pair. `null` = the turn belongs to no segment (homeless). */
function owningSegmentIds(
  db: Database,
  turnIds: readonly number[],
): Map<number, number | null> {
  const ids = [...new Set(turnIds)];
  const owning = new Map<number, number | null>(ids.map((id) => [id, null]));
  if (ids.length === 0) {
    return owning;
  }
  const placeholders = ids.map(() => "?").join(",");
  for (const row of db
    .query<{ turnId: number; segmentId: number }, number[]>(
      `SELECT turn_id AS turnId, MIN(segment_id) AS segmentId
         FROM segment_members
        WHERE turn_id IN (${placeholders})
        GROUP BY turn_id`,
    )
    .all(...ids)) {
    owning.set(row.turnId, row.segmentId);
  }
  return owning;
}

/** Every tag `segmentId` has DECLARED as a lane. Empty set for `null` (homeless — nowhere to declare). */
function declaredLaneTags(db: Database, segmentId: number | null): Set<string> {
  if (segmentId === null) {
    return new Set();
  }
  return new Set(
    db
      .query<{ tag: string }, [number]>(`SELECT tag FROM lanes WHERE segment_id = ?`)
      .all(segmentId)
      .map((row) => row.tag),
  );
}

export interface LaneRegistryEndpointInput {
  turnId: number;
  /** The endpoint's `S<session>/T<prompt>` address — a refusal has to be able to say WHICH turn. */
  address: string;
}

/**
 * Assemble the evidence `validateRelationTarget` judges a TAGGED edge write
 * against. Returns `undefined` for an untagged write (nothing to check) so a
 * caller can hand the result straight through as an optional field.
 *
 * `intersectingRows` deliberately EXCLUDES a row whose canonical set is
 * identical to this write's: that row IS the row being written, and repeating
 * the same claim is an idempotent no-op (`writeMemoryEdges`' own D2 contract),
 * not a duplicate lane reading.
 */
export function collectLaneRegistryFacts(
  db: Database,
  input: {
    relation: string;
    /** Canonical (sorted, deduped) tag set — `db/memory-edges.ts`'s `canonicalizeTagSet`. */
    tags: readonly string[];
    citing: LaneRegistryEndpointInput;
    cited: LaneRegistryEndpointInput;
  },
): LaneRegistryFacts | undefined {
  if (input.tags.length === 0) {
    return undefined;
  }

  const nonCanonical = new Map<string, string>();
  for (const tag of input.tags) {
    const verdict = checkCanonicalLaneTag(tag);
    if (!verdict.ok) {
      nonCanonical.set(tag, verdict.message);
    }
  }

  const owning = owningSegmentIds(db, [input.citing.turnId, input.cited.turnId]);
  const declaredBySegment = new Map<number | null, Set<string>>();
  const endpointFact = (endpoint: LaneRegistryEndpointInput): LaneEndpointRegistryFact => {
    const segmentId = owning.get(endpoint.turnId) ?? null;
    let declared = declaredBySegment.get(segmentId);
    if (declared === undefined) {
      declared = declaredLaneTags(db, segmentId);
      declaredBySegment.set(segmentId, declared);
    }
    return {
      address: endpoint.address,
      segment: segmentId === null ? null : `E${segmentId}`,
      declaredTags: declared,
    };
  };

  const wanted = new Set(input.tags);
  const intersectingRows: { tags: readonly string[]; shared: readonly string[] }[] = [];
  for (const row of db
    .query<{ tags: string }, [number, number, string]>(
      `SELECT tags FROM memory_edges
        WHERE citing_kind = 'turn' AND citing_id = ?
          AND cited_kind = 'turn' AND cited_id = ?
          AND relation = ?`,
    )
    .all(input.citing.turnId, input.cited.turnId, input.relation)) {
    let stored: unknown;
    try {
      stored = JSON.parse(row.tags);
    } catch {
      continue;
    }
    if (!Array.isArray(stored)) {
      continue;
    }
    const storedTags = stored.filter((tag): tag is string => typeof tag === "string");
    const shared = storedTags.filter((tag) => wanted.has(tag));
    if (shared.length === 0) {
      continue;
    }
    // Identical set = the very row this write restates; D2 makes that a no-op.
    if (shared.length === storedTags.length && storedTags.length === input.tags.length) {
      continue;
    }
    intersectingRows.push({ tags: storedTags, shared });
  }

  return {
    citing: endpointFact(input.citing),
    cited: endpointFact(input.cited),
    nonCanonical,
    intersectingRows,
  };
}
