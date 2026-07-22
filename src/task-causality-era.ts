/**
 * Placeholder until the release-time validation ticket pins the feature epoch.
 * Keep era checks behind isTaskCausalityEra so tests can inject a boundary.
 */
// 0.8.0 release moment: turns created from here on are graded (and trusted)
// under task-causality semantics; everything earlier stays legacy.
export const TASK_CAUSALITY_ERA_CUTOFF_EPOCH = 1_784_711_427;

export function isTaskCausalityEra(
  createdAtEpoch: number,
  cutoffEpoch = TASK_CAUSALITY_ERA_CUTOFF_EPOCH,
): boolean {
  return createdAtEpoch >= cutoffEpoch;
}
