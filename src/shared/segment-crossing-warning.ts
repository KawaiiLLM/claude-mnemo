/**
 * The stance-pair segment-crossing warning (relation-matrix spec, "同流约束
 * 只压立场对"; user-ruled S15069/T1191).
 *
 * `override`/`refines` are the rubric's diagonal STANCE pair: each claims the
 * two turns it connects sit in ONE workflow (override: replaces; refines:
 * improves on). Workflows are not reified anywhere in the schema, but a
 * segment is — "段就是现成的实体化工作流" (the peer finding this responds
 * to) — so when both ends of a stance edge already have an owning segment and
 * those segments differ, that is machine-checkable evidence the judgement may
 * be wrong. Never proof: a workflow can legitimately span segments the model
 * has not merged yet, and one end owning no segment at all gives nothing to
 * compare. That is why this is a receipt WARNING, never a rejection — the
 * edge lands exactly as judged either way, and the line just tells the writer
 * to re-judge or downgrade to `depends-on`.
 *
 * One composer, two consumers (`mcp/note.ts`'s `collectSegmentCrossingWarnings`
 * and, through it, the settlement facade) — same pattern as
 * `note-budget.ts`'s `formatBudgetWarning`: this module stays pure (no
 * database access, no knowledge of which surface is calling), and each
 * caller resolves the owning-segment ids before handing candidates in.
 */

export type StancePairRelation = "override" | "refines";

export interface SegmentCrossingCandidate {
  relation: StancePairRelation;
  /** The CITED turn's address, e.g. "S15069/T900" — the edge points there. */
  targetRef: string;
  /** The citing turn's owning segment id, or `null` when it is homeless. */
  citingSegmentId: number | null;
  /** The cited turn's owning segment id, or `null` when it is homeless. */
  citedSegmentId: number | null;
}

/**
 * Echo-on-divergence: returns one line per candidate that actually crosses
 * segments, and nothing for the rest — an empty array when nothing fires, so
 * a caller can splice the result straight into its receipt's parts list
 * without an empty-string check. Silent whenever either end is homeless
 * (`null`) or the two ids are equal; a candidate for any other relation is
 * the caller's own mistake, not something this function silently tolerates
 * — the type parameter closes that off at the call site instead.
 */
export function formatSegmentCrossingWarnings(
  candidates: readonly SegmentCrossingCandidate[],
): string[] {
  const warnings: string[] = [];
  for (const candidate of candidates) {
    if (candidate.citingSegmentId === null || candidate.citedSegmentId === null) {
      continue;
    }
    if (candidate.citingSegmentId === candidate.citedSegmentId) {
      continue;
    }
    warnings.push(
      `warning: ${candidate.relation} toward ${candidate.targetRef} crosses segments ` +
        `(E${candidate.citingSegmentId} -> E${candidate.citedSegmentId}) — the stance ` +
        "pair claims one workflow; re-judge or downgrade to depends-on.",
    );
  }
  return warnings;
}
