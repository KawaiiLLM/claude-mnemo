import type { Database } from "bun:sqlite";

import { checkCanonicalLaneTag } from "./lanes";
import { loadDeclaredLaneTags, loadSegmentTagIndex } from "./turn-tag-gate";
import { UNSETTLED_SIDE_TAG } from "./memory-edges";
import type { EdgeSideFact, EdgeSideRegistryFacts } from "../shared/turn-phase";

/**
 * The DB-aware half of the two-sided edge write gate (lane-model-v12 spec D2,
 * ticket 08). `shared/turn-phase.ts`'s `validateRelationTarget` owns the ORDER
 * and the wording of every refusal; this module owns only the reads that turn
 * a proposed edge into the evidence that judgment needs — the same "caller
 * pre-computes, the shared module judges" split `citingPhases` already has.
 *
 * Why the split rather than one DB-aware validator: the three per-side checks
 * (canonical form, declaration, the subset invariant) have to run IN THAT
 * ORDER, and a gate that ran AROUND the shared judgment instead of feeding it
 * would put the subset check on one side of the registry checks in one write
 * path and on the other in the next one added.
 *
 * A LANE'S IDENTITY IS `(segment, tag)`, so each side is resolved against ITS
 * OWN endpoint and never against the other's: the tail's tag is judged in the
 * citing turn's segment, the head's in the cited turn's. Two sides carrying
 * the same literal word in two different segments are therefore two different
 * lanes — a legal cross-lane edge, which is the shape v11 could not store at
 * all (spec 问题 2).
 *
 * WHERE A SEGMENT COMES FROM (spec D3e, ticket 14): a turn's segment is
 * DERIVED from its own tags — whichever segment's globally unique tag it
 * carries. So this module resolves it from the endpoint's tag set through
 * `loadSegmentTagIndex`, the same index the TURN-tags gate
 * (`db/turn-tag-gate.ts`'s `checkTurnTagWrite`) judges against, rather than
 * from the `segment_members` projection: the tags a caller hands in are the
 * tags this same call is about to store, and derivation has not run for them
 * yet. Reading the projection would judge an edge against the turn's PREVIOUS
 * segment whenever one call corrects tags and writes an edge together — which
 * the settlement facade does routinely.
 */

/** One endpoint, as the caller knows it: where it lives, and the tags it will carry once this call lands. */
export interface EdgeSideEndpointInput {
  /** The endpoint's `S<session>/T<prompt>` address — a refusal has to be able to say WHICH turn. */
  address: string;
  /**
   * The endpoint turn's EFFECTIVE tags — for the citing side, the set this
   * same call is about to store when it also corrects tags; otherwise what the
   * turn stores today. The caller owns that resolution because only it knows
   * whether its own tag correction landed.
   */
  tags: readonly string[];
}

/** The endpoint's own segment, derived from its tags — `null` when it carries no segment tag at all. */
function owningSegmentId(
  segmentTags: ReadonlyMap<string, number>,
  tags: readonly string[],
): number | null {
  for (const tag of tags) {
    const segmentId = segmentTags.get(tag);
    if (segmentId !== undefined) {
      return segmentId;
    }
  }
  return null;
}

/**
 * Assemble the per-side evidence `validateRelationTarget` judges a lane-
 * carrying edge write against. Returns `undefined` when NEITHER side is
 * settled (there is nothing to check — that is the draft form), so a caller
 * can hand the result straight through as an optional field.
 *
 * A HALF-settled edge still gets facts: the refusal for it names the settled
 * side's own turn, and that address lives here.
 */
export function collectEdgeSideFacts(
  db: Database,
  input: {
    tailTag: string;
    headTag: string;
    /** The CITING endpoint — the tail side. */
    citing: EdgeSideEndpointInput;
    /** The CITED endpoint — the head side. */
    cited: EdgeSideEndpointInput;
  },
): EdgeSideRegistryFacts | undefined {
  if (input.tailTag === UNSETTLED_SIDE_TAG && input.headTag === UNSETTLED_SIDE_TAG) {
    return undefined;
  }

  const segmentTags = loadSegmentTagIndex(db);
  const declaredBySegment = new Map<number | null, Set<string>>();

  const fact = (endpoint: EdgeSideEndpointInput, tag: string): EdgeSideFact => {
    const segmentId = owningSegmentId(segmentTags, endpoint.tags);
    let declared = declaredBySegment.get(segmentId);
    if (declared === undefined) {
      declared = segmentId === null ? new Set<string>() : loadDeclaredLaneTags(db, segmentId);
      declaredBySegment.set(segmentId, declared);
    }
    // An unsettled side has no tag to be non-canonical about — the
    // both-or-neither refusal is the only verdict it can attract.
    const verdict = tag === UNSETTLED_SIDE_TAG ? null : checkCanonicalLaneTag(tag);
    return {
      address: endpoint.address,
      segment: segmentId === null ? null : `E${segmentId}`,
      declaredTags: declared,
      turnTags: new Set(endpoint.tags),
      nonCanonicalMessage: verdict === null || verdict.ok ? null : verdict.message,
    };
  };

  return {
    tail: fact(input.citing, input.tailTag),
    head: fact(input.cited, input.headTag),
  };
}
