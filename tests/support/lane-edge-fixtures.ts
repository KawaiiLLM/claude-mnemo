import { resolveEdgeSide, type EndpointLaneFacts } from "../../src/db/edge-side-resolution";
import { deriveSideTags } from "../../src/db/memory-edges";
import type { LaneCheckerEdgeInput } from "../../src/shared/lane-checker";
import {
  DEFAULT_SEGMENT,
  type LaneEdgeInput,
  type LaneTurnInput,
} from "../../src/shared/lane-interpretation";
import {
  formatRelationClass,
  type RelationClass,
  type RelationCoverageValue,
} from "../../src/shared/relation-class";

/**
 * The seven storage words a pre-cutover fixture still spells, mapped to the
 * class and coverage the v13 backfill gave them — the FIXTURE-SIDE mirror of
 * `db/schema.ts`'s frozen `MEMORY_EDGES_LEGACY_WORD_CLASS` migration literal.
 *
 * It lives here, in `tests/`, because the main-agent-edges cutover dropped the
 * `relation` column and nothing in `src/` may name one of these words outside
 * that migration literal (spec P3, the raw-word release gate). A fixture that
 * predates the cutover states its edges in the old vocabulary; this is the one
 * place that vocabulary is translated, so no fixture can invent a class the
 * migration would not have written.
 *
 * A fixture may pass `relationClass`/`relationCoverage` directly instead — the
 * shape a post-cutover row actually carries — and then no word is involved.
 */
export const FIXTURE_LEGACY_WORD_CLASS: Readonly<
  Record<string, { relationClass: RelationClass; relationCoverage: RelationCoverageValue }>
> = Object.freeze({
  override: { relationClass: "correct", relationCoverage: "full" },
  narrows: { relationClass: "correct", relationCoverage: "partial" },
  verifies: { relationClass: "verify", relationCoverage: "" },
  extends: { relationClass: "use", relationCoverage: "" },
  consume: { relationClass: "use", relationCoverage: "" },
  grounds: { relationClass: "use", relationCoverage: "" },
  indexes: { relationClass: "use", relationCoverage: "" },
});

/** The seven words, in the frozen order the storage vocabulary listed them. */
export const FIXTURE_LEGACY_WORDS: readonly string[] = Object.freeze([
  "override",
  "narrows",
  "extends",
  "indexes",
  "consume",
  "grounds",
  "verifies",
]);

/**
 * A fixture's class, from whichever surface it stated: the explicit
 * class/coverage pair, else the legacy word translated. A word this table does
 * not know (a deliberately out-of-vocabulary fixture, e.g. `supersedes`)
 * carries NO class — exactly what a row the backfill skipped looks like, and
 * what every class-bearing reader must keep out of its graph.
 */
export function fixtureRelationClass(input: {
  relation?: string;
  relationClass?: RelationClass | "";
  relationCoverage?: RelationCoverageValue;
}): { relationClass: RelationClass | ""; relationCoverage: RelationCoverageValue } {
  if (input.relationClass !== undefined && input.relationClass !== "") {
    return {
      relationClass: input.relationClass,
      relationCoverage: input.relationCoverage ?? "",
    };
  }
  const mapped = input.relation === undefined ? undefined : FIXTURE_LEGACY_WORD_CLASS[input.relation];
  return mapped ?? { relationClass: "", relationCoverage: "" };
}

/**
 * Give every turn the lane tags ITS OWN SIDE of the given edges names — the
 * E4-clean state a settlement leaves behind, where each side's tag is also
 * present on that side's own endpoint (lane-model-v12 D2 rule 3).
 *
 * WHY THIS EXISTS. Membership is a NODE fact since ticket 10: a turn belongs
 * to the lanes its own `laneTags` name, and an edge adds no member. Fixtures
 * written before that change state their lanes on the EDGES only, and are
 * about something else entirely — a path count, a component split, an error
 * class — so re-stating each one's membership by hand would be noise. This
 * projects the legal membership those fixtures always implied.
 *
 * It is a FIXTURE CONVENIENCE, never a model rule: a test that is about
 * membership itself must state `laneTags` directly (see
 * `tests/shared/lane-interpretation.test.ts`, whose own fixtures do exactly
 * that and whose counter-example tests are what actually pin the change).
 * Per SIDE, deliberately — a cross-lane edge gives its citing turn the TAIL's
 * lane and its cited turn the HEAD's, never both to both.
 *
 * A turn whose RAW `tags` are loaded (`LaneCheckerTurnInput.tags`) claims only
 * the edge tags that column carries: membership is `tags` intersected with the
 * declared lanes (`db/edge-side-resolution.ts`'s `EndpointLaneFacts`), so a
 * turn cannot be a member of a lane its own column lacks. That is what lets an
 * E4 fixture — a side tag the endpoint does NOT carry — resolve `invalid`
 * through the real resolver rather than `declared` through a projection that
 * invented the membership.
 */
export function withEdgeClaimedLaneTags<T extends LaneTurnInput & { tags?: readonly string[] }>(
  turns: readonly T[],
  edges: readonly LaneEdgeInput[],
): T[] {
  const claimed = new Map<number, Set<string>>();
  const claim = (turnId: number, tag: string | undefined): void => {
    if (typeof tag !== "string" || tag === "") return;
    let bucket = claimed.get(turnId);
    if (bucket === undefined) {
      bucket = new Set();
      claimed.set(turnId, bucket);
    }
    bucket.add(tag);
  };
  for (const edge of edges) {
    claim(edge.citingId, edge.tailTag);
    claim(edge.citedId, edge.headTag);
  }
  return turns.map((turn) => {
    const fromEdges = [...(claimed.get(turn.id) ?? [])].filter(
      (tag) => turn.tags === undefined || turn.tags.includes(tag),
    );
    if (fromEdges.length === 0 && turn.laneTags === undefined) {
      return turn;
    }
    return {
      ...turn,
      laneTags: [...new Set([...(turn.laneTags ?? []), ...fromEdges])],
    };
  });
}

/**
 * Resolve a pure fixture's edges the way `db/lane-checker-load.ts` resolves a
 * projection's: each side through `resolveEdgeSide` (THE pure function,
 * main-agent-edges D2) against the endpoint facts the fixture's own turns
 * state — `laneTags` as the lane set, `segment` as the owning task. The
 * fixture's `tailTag`/`headTag` are its STORED declarations; what comes back
 * carries the resolved lane per side, the five-outcome verdict, and the stored
 * tag alongside — `LaneCheckerEdgeInput`, the only shape the checker takes.
 *
 * The one place a fixture's outcome comes from. It is deliberately NOT a
 * parameter of `laneEdge`: an outcome a test could simply state would let it
 * assert a verdict the endpoint facts contradict, which is the kind of
 * coverage-that-cannot-fail this helper exists to end (ticket 02b, F2). Feed
 * the SAME turns `checkLanes` will see (after `withEdgeClaimedLaneTags` when
 * that projection is in use), or the resolution and the membership disagree.
 *
 * A fixture turn the edge names but the fixture omits resolves as homeless —
 * exactly the loader's own posture for an endpoint it loaded no facts for.
 * Segment ids are interned per call: the resolver wants a number and a
 * fixture writes a label, and only equality within one projection matters.
 */
export function resolveLaneEdges(
  turns: readonly LaneTurnInput[],
  edges: readonly LaneEdgeInput[],
): LaneCheckerEdgeInput[] {
  const segmentIds = new Map<string, number>();
  const segmentIdOf = (segment: string | undefined): number => {
    const label = segment ?? DEFAULT_SEGMENT;
    let id = segmentIds.get(label);
    if (id === undefined) {
      id = segmentIds.size + 1;
      segmentIds.set(label, id);
    }
    return id;
  };
  const facts = new Map<number, EndpointLaneFacts>();
  for (const turn of turns) {
    facts.set(turn.id, { segmentId: segmentIdOf(turn.segment), lanes: [...(turn.laneTags ?? [])] });
  }
  return edges.map((edge) => {
    const tail = resolveEdgeSide(edge, "tail", facts);
    const head = resolveEdgeSide(edge, "head", facts);
    return {
      ...edge,
      tailTag: tail.lane?.tag ?? "",
      headTag: head.lane?.tag ?? "",
      tailOutcome: tail.outcome,
      headOutcome: head.outcome,
      storedTailTag: edge.tailTag,
      storedHeadTag: edge.headTag,
    };
  });
}

/**
 * Build a `LaneEdgeInput` for a pure (DB-free) fixture with BOTH tag
 * surfaces populated the way a real row would carry them.
 *
 * Why this exists rather than each test spelling the fields out: bun's test
 * runner strips types instead of checking them and `tsconfig.json` excludes
 * `tests/`, so an object literal missing `tailTag`/`headTag` still compiles
 * and still runs — handing every reader `undefined` on both sides, which is
 * neither "unsettled" (`''`) nor a lane, and which `undefined === undefined`
 * would silently read as a lane whose tag is `undefined`.
 *
 * `tags` is an INPUT CONVENIENCE ONLY since lane-model-v12 ticket 09 deleted
 * the merged set from the shape: it is a shorthand for "put this one tag on
 * both sides", projected through `db/memory-edges.ts`'s own `deriveSideTags`
 * — IMPORTED, not restated, so a fixture cannot drift from what M-A actually
 * derives — and it never reaches the returned object. One tag lands on BOTH
 * sides; two or more leave both sides UNSETTLED, because the two-sided model
 * has no single-valued form for a multi-tag edge (see `deriveSideTags`' own
 * doc).
 *
 * `tailTag`/`headTag` may be passed explicitly to build a CROSS-LANE edge
 * (`tailTag !== headTag`, both settled) — the shape no single tag set could
 * express, and the one the checker's readers must tell apart from a same-lane
 * edge.
 */
export function laneEdge(input: {
  citingId: number;
  citedId: number;
  relation: string;
  relationClass?: RelationClass | "";
  relationCoverage?: RelationCoverageValue;
  tags?: readonly string[];
  tailTag?: string;
  headTag?: string;
}): LaneEdgeInput {
  const tags = input.tags ?? [];
  const derived = deriveSideTags(tags);
  const { relationClass, relationCoverage } = fixtureRelationClass(input);
  return {
    citingId: input.citingId,
    citedId: input.citedId,
    // `LaneEdgeInput.relation` is the CLASS TOKEN since the cutover — a
    // display label, never a storage word. A fixture that spells the old word
    // gets the token its class formats to; one the vocabulary never knew keeps
    // its own spelling, because there is no class to format.
    relation:
      relationClass === ""
        ? input.relation
        : formatRelationClass(relationClass, relationCoverage),
    relationClass,
    relationCoverage,
    tailTag: input.tailTag ?? derived.tailTag,
    headTag: input.headTag ?? derived.headTag,
  };
}

/** `deriveSideTags`, re-exported for a fixture that already builds its own object literal and only needs the two side values. */
export { deriveSideTags };
