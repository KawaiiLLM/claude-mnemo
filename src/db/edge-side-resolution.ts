/**
 * ONE RULE FOR "WHICH LANE IS THIS EDGE'S SIDE IN"
 * (`.scratch/main-agent-edges/spec.md` D2).
 *
 * ## The model this replaces
 *
 * An edge used to STORE a lane word on each side, and every lane reader asked
 * for that stored word: `tail_tag = ?`, `head_tag <> ''`, a `memory_edge_side_tags`
 * lookup. Measured on production, the stored word carried almost nothing —
 * 87% of laned turns are in exactly one lane, and on every placed edge whose
 * endpoint has one lane the stored side EQUALS that lane (2,660/2,660 tail,
 * 2,686/2,686 head). The writer was paying for a declaration that was already
 * derivable, and the 69% of edges nobody had got round to declaring were
 * invisible to their own lanes.
 *
 * So: **an edge is a fact about two nodes; a lane side is an ATTRIBUTION,
 * resolved at read time.** A stored tag now means exactly one thing — "this
 * endpoint is in SEVERAL lanes and this is the one" — and settlement declares
 * a side only in that case.
 *
 * ## Five outcomes, and why `invalid` does not fall back
 *
 *   `declared`   a stored tag that IS among the endpoint's current lane tags
 *   `derived`    no stored tag; the endpoint is in exactly one lane
 *   `ambiguous`  no stored tag; the endpoint is in two or more
 *   `none`       no stored tag; the endpoint is in no lane at all
 *   `invalid`    a stored tag that is NOT among the endpoint's current tags
 *
 * `invalid` is E4's fact and never degrades to `derived`, even when the
 * endpoint happens to have exactly one lane now. A declaration that no longer
 * matches its endpoint is a CONTRADICTION between two writes, and silently
 * answering it with the derivation would hide the repair settlement owes:
 * "the writer said alpha, the turn says beta" is not the same finding as "the
 * writer said nothing".
 *
 * There is deliberately no `unknown`. Malformed `turns.tags` is normalised at
 * the cutover and refused at write, so a reader never has to invent a sixth
 * answer for a row it cannot parse.
 *
 * ## Lanes are QUALIFIED
 *
 * A lane is `(segmentId, tag)`, never a bare word: two tasks may both declare
 * `#alpha`, and an edge whose endpoints sit in different tasks names two
 * different lanes with the same string. Every outcome that names a lane names
 * the qualified pair, and the endpoint's OWNING segment is where its tag is
 * qualified.
 */

import type { Database } from "bun:sqlite";

/** A lane's machine identity: the owning task plus one canonical tag. Never a bare word — see the module header. */
export interface QualifiedLane {
  segmentId: number;
  tag: string;
}

/** `''` — a side no one has declared. Mirrors `db/memory-edges.ts`'s `UNSETTLED_SIDE_TAG`; never a lane whose tag is the empty string. */
export const UNDECLARED_SIDE_TAG = "";

/**
 * What one ENDPOINT contributes to resolution: the task that owns it, and the
 * lane tags it is actually a member of there.
 *
 * `lanes` is the RESOLVED set — `turns.tags` intersected with the lanes
 * DECLARED in the owning segment — not the raw column, because a turn
 * carrying a word no lane of its task declares is a member of nothing.
 * `segmentId: null` is a homeless turn: no owning task, therefore no
 * qualified lane, therefore no membership at all.
 */
export interface EndpointLaneFacts {
  segmentId: number | null;
  lanes: readonly string[];
}

const NO_FACTS: EndpointLaneFacts = Object.freeze({ segmentId: null, lanes: [] });

export type EdgeSide = "tail" | "head";

export type EdgeSideOutcome = "declared" | "derived" | "ambiguous" | "none" | "invalid";

/** Just enough of an edge row to resolve either side. Every loader in the tree already selects these four columns. */
export interface ResolvableEdgeSides {
  citingId: number;
  citedId: number;
  tailTag: string;
  headTag: string;
}

export interface EdgeSideResolution {
  outcome: EdgeSideOutcome;
  /** The qualified lane this side attributes to — non-null for `declared` and `derived` ONLY. */
  lane: QualifiedLane | null;
  /** The tag the row stores on this side (`''` when undeclared) — carried so a caller reporting an `invalid` side can name what was written. */
  storedTag: string;
  /** The endpoint turn this side belongs to: the CITING turn for `tail`, the CITED turn for `head`. */
  endpointId: number;
  /** How many lanes the endpoint is in — the number `ambiguous` and the "declaration is redundant" rule both key on. */
  laneCardinality: number;
}

/** The endpoint one side belongs to: an arc's TAIL is at its citing turn, its HEAD at the cited turn. */
export function edgeSideEndpointId(edge: ResolvableEdgeSides, side: EdgeSide): number {
  return side === "tail" ? edge.citingId : edge.citedId;
}

/** The tag the row stores on one side. */
export function edgeSideStoredTag(edge: ResolvableEdgeSides, side: EdgeSide): string {
  return side === "tail" ? edge.tailTag : edge.headTag;
}

/**
 * THE PURE FUNCTION (spec D2). No database, no I/O — the endpoint facts are
 * loaded once by the caller (`loadEndpointLaneFacts`) and every reader
 * projects its own candidate scope through this.
 *
 * An endpoint the caller supplied no facts for resolves as if it were
 * homeless, which is the honest answer: a reader that did not load an
 * endpoint knows nothing about its lanes, and inventing a membership for it
 * would attribute an edge to a lane on no evidence.
 */
export function resolveEdgeSide(
  edge: ResolvableEdgeSides,
  side: EdgeSide,
  endpointLaneFacts: ReadonlyMap<number, EndpointLaneFacts>,
): EdgeSideResolution {
  const endpointId = edgeSideEndpointId(edge, side);
  const facts = endpointLaneFacts.get(endpointId) ?? NO_FACTS;
  const storedTag = edgeSideStoredTag(edge, side);
  const cardinality = facts.lanes.length;
  const base = { storedTag, endpointId, laneCardinality: cardinality };

  if (storedTag !== UNDECLARED_SIDE_TAG) {
    if (facts.segmentId !== null && facts.lanes.includes(storedTag)) {
      return { ...base, outcome: "declared", lane: { segmentId: facts.segmentId, tag: storedTag } };
    }
    // E4. Never `derived`, however unambiguous the endpoint looks now.
    return { ...base, outcome: "invalid", lane: null };
  }
  if (cardinality === 1 && facts.segmentId !== null) {
    return { ...base, outcome: "derived", lane: { segmentId: facts.segmentId, tag: facts.lanes[0]! } };
  }
  if (cardinality >= 2) {
    return { ...base, outcome: "ambiguous", lane: null };
  }
  return { ...base, outcome: "none", lane: null };
}

/** Does this side attribute the edge to `lane`? The predicate every LANE reader filters its candidates with — true for `declared` and `derived`, false for every other outcome. */
export function edgeSideAttributesTo(
  edge: ResolvableEdgeSides,
  side: EdgeSide,
  lane: QualifiedLane,
  endpointLaneFacts: ReadonlyMap<number, EndpointLaneFacts>,
): boolean {
  const resolved = resolveEdgeSide(edge, side, endpointLaneFacts);
  return (
    resolved.lane !== null &&
    resolved.lane.segmentId === lane.segmentId &&
    resolved.lane.tag === lane.tag
  );
}

/** Both sides at once, for a renderer or a report that annotates a whole row. */
export function resolveEdgeSides(
  edge: ResolvableEdgeSides,
  endpointLaneFacts: ReadonlyMap<number, EndpointLaneFacts>,
): { tail: EdgeSideResolution; head: EdgeSideResolution } {
  return {
    tail: resolveEdgeSide(edge, "tail", endpointLaneFacts),
    head: resolveEdgeSide(edge, "head", endpointLaneFacts),
  };
}

/**
 * THE ONE SHARED LOAD (spec D2): every endpoint's owning task and its
 * resolved lane tags there, batched.
 *
 * Two queries and one registry read for a whole projection. `MIN(segment_id)`
 * mirrors `getOwningSegmentId`'s "lowest id wins" tie-break for a legacy
 * multi-membership row, so this and every other owning-segment reader in the
 * tree answer the same question the same way.
 *
 * The `lanes` registry is checked for EXISTENCE first, for the same reason
 * `db/lane-checker-load.ts`'s own resolver does: hard-`readonly` callers
 * (`scripts/lane-check.ts`) cannot create it, and a production database not
 * opened by a writer since the registry shipped genuinely does not have one.
 * A missing registry means zero declared lanes, so every endpoint resolves as
 * a member of nothing — which is a truthful "no attributions here", not a
 * crash on an absent table.
 */
export function loadEndpointLaneFacts(
  db: Database,
  turnIds: readonly number[],
): Map<number, EndpointLaneFacts> {
  const ids = [...new Set(turnIds)];
  const facts = new Map<number, EndpointLaneFacts>();
  if (ids.length === 0) {
    return facts;
  }
  const placeholders = ids.map(() => "?").join(",");

  const owningSegments = new Map<number, number>(
    db
      .query<{ turnId: number; segmentId: number }, number[]>(
        `SELECT turn_id AS turnId, MIN(segment_id) AS segmentId
           FROM segment_members
          WHERE turn_id IN (${placeholders})
          GROUP BY turn_id`,
      )
      .all(...ids)
      .map((row) => [row.turnId, row.segmentId] as const),
  );

  const hasLanesTable =
    db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lanes'`,
      )
      .all().length > 0;
  const declaredBySegment = new Map<number, Set<string>>();
  const declaredFor = (segmentId: number): Set<string> => {
    let declared = declaredBySegment.get(segmentId);
    if (declared === undefined) {
      declared = hasLanesTable
        ? new Set(
            db
              .query<{ tag: string }, [number]>(
                `SELECT tag FROM lanes WHERE segment_id = ?`,
              )
              .all(segmentId)
              .map((row) => row.tag),
          )
        : new Set<string>();
      declaredBySegment.set(segmentId, declared);
    }
    return declared;
  };

  for (const row of db
    .query<{ id: number; tags: string | null }, number[]>(
      `SELECT id, tags FROM turns WHERE id IN (${placeholders})`,
    )
    .all(...ids)) {
    const segmentId = owningSegments.get(row.id);
    if (segmentId === undefined) {
      facts.set(row.id, { segmentId: null, lanes: [] });
      continue;
    }
    const declared = declaredFor(segmentId);
    facts.set(row.id, {
      segmentId,
      lanes: parseStoredTags(row.tags).filter((tag) => declared.has(tag)),
    });
  }
  // A turn id with no `turns` row at all (a caller's stale id) still gets an
  // entry, so `resolveEdgeSide`'s "absent = homeless" arm is only ever
  // reached by a caller that did not ask about the endpoint.
  for (const id of ids) {
    if (!facts.has(id)) {
      facts.set(id, { segmentId: null, lanes: [] });
    }
  }
  return facts;
}

/** The stored-tags parse, tolerant exactly where the cutover has not yet normalised: a non-array or unparseable column is no tags, never a throw in a read path. */
function parseStoredTags(raw: string | null): string[] {
  if (raw === null) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}
