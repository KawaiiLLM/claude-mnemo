/**
 * Placeholder until the release-time validation ticket pins the feature epoch.
 * Keep era checks behind isTaskCausalityEra so tests can inject a boundary.
 */
export const TASK_CAUSALITY_ERA_CUTOFF_EPOCH = Number.MAX_SAFE_INTEGER;

export function isTaskCausalityEra(
  createdAtEpoch: number,
  cutoffEpoch = TASK_CAUSALITY_ERA_CUTOFF_EPOCH,
): boolean {
  return createdAtEpoch >= cutoffEpoch;
}
