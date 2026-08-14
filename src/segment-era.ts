/**
 * The P2 era boundary (spec D11/D12, R2#7).
 *
 * A turn belongs to the segment era when it was created at or after the cutoff.
 * The comparison is per TURN, not per session: a session that was open across
 * the switch keeps rendering its old turns through the legacy path and its new
 * ones through the segment spine, because the two halves were written under
 * different semantics and no backfill reconciles them (spec D11: old data is
 * read-only and does not evolve). This is the task-causality-era precedent.
 *
 * Ticket 09 made it a WRITE gate as well as a read one, and deliberately reuses
 * this same function rather than restating the comparison: the turn whose note
 * `note` promotes onto the row must be exactly the turn the renderer draws as
 * era, or a turn could be written under one era's rules and read under the
 * other's. Read side — recall/timeline/settlement context; write side —
 * `mcp/note.ts` (promotion). Ticket 04 (spec D10) lifted the write-side use
 * this function used to also have in `mcp/remember.ts`: the settlement review
 * pass needs `remember` to correct an era turn's grade/type/tags, so that
 * route no longer branches on the era at all and writes every turn, era or
 * legacy, through the one patch/clear path.
 *
 * The cutoff is `null` in the product default, and `null` means EVERY turn is
 * legacy — every path guarded by this is therefore inert until an operator sets
 * an epoch, which is also the rollback.
 */
export function isSegmentEra(
  createdAtEpoch: number,
  cutoffEpoch: number | null | undefined,
): boolean {
  return (
    cutoffEpoch !== null &&
    cutoffEpoch !== undefined &&
    createdAtEpoch >= cutoffEpoch
  );
}

/** Normalize a configured/raw cutoff to the nullable epoch the readers take. */
export function normalizeEraCutoffEpoch(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}
