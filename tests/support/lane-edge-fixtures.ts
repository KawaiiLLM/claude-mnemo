import { deriveSideTags } from "../../src/db/memory-edges";
import type { LaneEdgeInput } from "../../src/shared/lane-interpretation";

/**
 * Build a `LaneEdgeInput` for a pure (DB-free) fixture with BOTH tag
 * surfaces populated the way a real row would carry them.
 *
 * Why this exists rather than each test spelling the fields out:
 * `LaneEdgeInput` grew `tailTag`/`headTag` (lane-model-v12 ticket 07, spec
 * D1) while `tags` is still what the reduction groups by (ticket 06 moves
 * that). A fixture that sets only `tags` therefore hands ticket 07's readers
 * `undefined` on both sides — which is neither "unsettled" (`''`) nor a
 * lane, and would silently read as a lane whose tag is `undefined`. bun's
 * test runner strips types instead of checking them and `tsconfig.json`
 * excludes `tests/`, so nothing would catch that at build time.
 *
 * The default projection is `db/memory-edges.ts`'s own `deriveSideTags` —
 * IMPORTED, not restated, so a fixture can never drift from what the live
 * dual-write actually stores. That means a fixture edge tagged with exactly
 * one tag gets that tag on BOTH sides, and one tagged with two or more gets
 * both sides UNSETTLED (the two-sided model has no single-valued form for a
 * multi-tag edge — see `deriveSideTags`' own doc).
 *
 * `tailTag`/`headTag` may be passed explicitly to build a CROSS-LANE edge
 * (`tailTag !== headTag`, both settled), which no `tags` set can express and
 * which is the shape ticket 07's readers must tell apart from a same-lane
 * one.
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
    tags,
    tailTag: input.tailTag ?? derived.tailTag,
    headTag: input.headTag ?? derived.headTag,
  };
}

/** `deriveSideTags`, re-exported for a fixture that already builds its own object literal and only needs the two side values. */
export { deriveSideTags };
