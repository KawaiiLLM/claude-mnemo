/**
 * The election-tier era boundary (ADR-0003, ticket 06).
 *
 * Grading is now a THIRD semantics, layered the same way task-causality
 * grading (`task-causality-era.ts`) once superseded whatever came before it:
 * a turn created from this cutoff forward is ranked into a tier (A/B/C) by
 * settlement's election; everything earlier keeps whatever 0-4 grade it
 * already carries (or earns from a correction under the OLD rubric), frozen.
 * The two semantics never mix — a legacy-era read never sees a tier, a
 * new-era read never sees a grade (ADR-0003, spec "Judging").
 *
 * Placeholder, exactly like `TASK_CAUSALITY_ERA_CUTOFF_EPOCH` was: until a
 * release-time ticket pins the real cutover moment, this sits comfortably
 * above every timestamp this codebase's own settlement fixtures seed (all of
 * them cluster around epoch 1.8B), so every turn currently under test —
 * and every turn a production install has settled so far — reads as
 * legacy-era, grade path, unchanged. Injectable via the second parameter so
 * a test can move the boundary without waiting for a real release.
 */
export const ELECTION_ERA_CUTOFF_EPOCH = 1_950_000_000;

export function isElectionEra(
  createdAtEpoch: number,
  cutoffEpoch = ELECTION_ERA_CUTOFF_EPOCH,
): boolean {
  return createdAtEpoch >= cutoffEpoch;
}
