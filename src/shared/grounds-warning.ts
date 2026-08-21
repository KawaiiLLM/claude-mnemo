/**
 * The `grounds` mid-flow warning (flow-relations spec, P1: "a grounds at a
 * mid-flow target still stores, and the receipt names the settlement to use
 * instead"). Ticket 02 retires the segment-crossing warning
 * (`shared/segment-crossing-warning.ts`, S15069/T1191's stance-pair check,
 * dcd17fe) along with the vocabulary it was built for — its `override`/
 * `refines` stance pair no longer exists — and reuses the same COMPOSER
 * PATTERN (not the file): a pure, DB-free module that decides and renders,
 * fed already-resolved candidates by each write surface's own orchestration
 * (`mcp/note.ts`, `worker/note-settlement-turn-facade.ts`).
 *
 * `grounds` has NO phase or graph-state REJECTION (spec's six-row law: "no
 * restriction") — citing a mid-flow member instead of its branch's
 * settlement still stores. What this module adds is the one thing P1 asks
 * for in its place: a receipt line naming the settlement to cite instead,
 * addenda-scoped precisely — "fires only when the target's branch HAS a
 * settlement to name (`settlementsOfTurn`); a dead branch (settlement null)
 * warns nothing — grounds stores silently."
 *
 * Silent in two cases, both echo-on-divergence (same discipline the retired
 * segment-crossing warning used):
 *
 *   - `settlementRefs` is empty — the target reaches no settlement at all
 *     (a dead/overridden branch, or a homeless turn with no flow membership
 *     of its own or inherited);
 *   - the target IS ALREADY its own settlement — `settlementRefs` names
 *     exactly the target itself, so citing it directly is already correct.
 */

export interface GroundsMidFlowCandidate {
  /** The `grounds` edge's CITED turn address, e.g. "S15069/T954". */
  targetRef: string;
  /**
   * The settlement(s) reachable from the target (`shared/flows.ts`'s
   * `settlementsOfTurn`), already resolved to the SAME "S<session>/T<prompt>"
   * address form as `targetRef` — empty when the target's branch has no
   * settlement to name.
   */
  settlementRefs: readonly string[];
}

/**
 * Returns one line per candidate that is genuinely mid-flow with a
 * settlement to point at, and nothing for the rest — an empty array when
 * nothing fires, so a caller can splice the result straight into its
 * receipt's parts list without an empty-string check.
 */
export function formatGroundsMidFlowWarnings(
  candidates: readonly GroundsMidFlowCandidate[],
): string[] {
  const warnings: string[] = [];
  for (const candidate of candidates) {
    if (candidate.settlementRefs.length === 0) {
      continue;
    }
    if (
      candidate.settlementRefs.length === 1 &&
      candidate.settlementRefs[0] === candidate.targetRef
    ) {
      continue;
    }
    warnings.push(
      `warning: grounds toward ${candidate.targetRef} is mid-flow — this flow settles at ` +
        `${candidate.settlementRefs.join(", ")}; cite that instead.`,
    );
  }
  return warnings;
}
