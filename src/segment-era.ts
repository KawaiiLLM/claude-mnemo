/**
 * The P2 era boundary (spec D11, R2#7).
 *
 * A turn belongs to the segment era when it was created at or after the cutoff.
 * The comparison is per TURN, not per session: a session that was open across
 * the switch keeps rendering its old turns through the legacy path and its new
 * ones through the segment spine, because the two halves were written under
 * different semantics and no backfill reconciles them (spec D11: old data is
 * read-only and does not evolve). This is the task-causality-era precedent.
 *
 * The cutoff is `null` until ticket 09 sets it, and `null` means EVERY turn is
 * legacy — merging the rendering work is therefore inert in production, and a
 * test opts a fixture into the new path by passing an epoch.
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
