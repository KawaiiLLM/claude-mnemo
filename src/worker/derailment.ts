/** Signals observed for one work unit (one outgoing message → its result). */
export interface WorkUnitSignals {
  /** Turn ids this unit MUST remember (∅ only for a standalone session summary). */
  requiredIds: Set<number>;
  /** Turn ids the agent actually remembered during this unit. */
  rememberedIds: Set<number>;
  /** A substantive (non-thinking) text block was emitted. */
  hadSubstantiveText: boolean;
  /** A non-mnemo tool was attempted (should be impossible under D0). */
  hadIllegalTool: boolean;
}

export type WorkUnitVerdict = "resolved" | "strike";

/**
 * D1: a unit is RESOLVED iff every required id was remembered. Otherwise it is a
 * strike. recall and remembers of non-required ids do not resolve a required id.
 * For an empty required set (standalone summary), prose-without-remember or an
 * illegal tool is still a strike; an empty/thinking-only response is resolved.
 */
export function classifyWorkUnitResponse(s: WorkUnitSignals): WorkUnitVerdict {
  if (s.hadIllegalTool) {
    return "strike";
  }
  for (const id of s.requiredIds) {
    if (!s.rememberedIds.has(id)) {
      return "strike";
    }
  }
  if (s.requiredIds.size === 0 && s.hadSubstantiveText && s.rememberedIds.size === 0) {
    return "strike";
  }
  return "resolved";
}
