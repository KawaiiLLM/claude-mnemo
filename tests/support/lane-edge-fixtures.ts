import { deriveSideTags } from "../../src/db/memory-edges";
import type { LaneEdgeInput } from "../../src/shared/lane-interpretation";

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
  tags?: readonly string[];
  tailTag?: string;
  headTag?: string;
}): LaneEdgeInput {
  const tags = input.tags ?? [];
  const derived = deriveSideTags(tags);
  return {
    citingId: input.citingId,
    citedId: input.citedId,
    relation: input.relation,
    tailTag: input.tailTag ?? derived.tailTag,
    headTag: input.headTag ?? derived.headTag,
  };
}

/** `deriveSideTags`, re-exported for a fixture that already builds its own object literal and only needs the two side values. */
export { deriveSideTags };
