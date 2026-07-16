import type { ToolHandler } from "../mcp/handlers";
import { textResult } from "../mcp/handlers";
import type { CommitNightInput, DreamMemoryStore } from "../diary/memory-store";

/**
 * The commit tool is payload-free: the day's documents live in the staging
 * workspace, not in tool arguments. An empty shape keeps the SDK tool
 * argument-less and lets `assertDreamCommitToolFields` reject any stray field.
 */
export const dreamCommitInputShape: Record<string, never> = {};

export function assertDreamCommitToolFields(
  args: Record<string, unknown>,
): void {
  const unsupported = Object.keys(args);
  if (unsupported.length > 0) {
    throw new Error(
      `Dream commit does not accept arguments: ${unsupported.join(", ")}`,
    );
  }
}

/**
 * Agent-facing ticket-03 boundary. The commit carries no document bodies and
 * no filesystem paths: on invocation it reads the six staged documents back
 * from the run's staging workspace and hands them to the unchanged atomic
 * `commitNight` transaction.
 */
export function createDreamCommitToolHandler(
  store: Pick<DreamMemoryStore, "commitNight">,
  readStagedNight: () => Promise<CommitNightInput>,
): ToolHandler {
  return async (args) => {
    assertDreamCommitToolFields(args);

    const input = await readStagedNight();
    const result = await store.commitNight(input);
    return textResult(JSON.stringify({
      status: "committed",
      last_successful_date: result.lastSuccessfulDate,
      snapshot_id: result.snapshot.id,
    }));
  };
}
