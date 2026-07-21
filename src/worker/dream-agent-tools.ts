import type { ToolHandler } from "../mcp/handlers";
import { textResult } from "../mcp/handlers";
import type { CommitNightInput, DreamMemoryStore } from "../diary/memory-store";
import { MEMORY_DOCUMENT_TOKEN_LIMIT } from "../diary/memory-store";
import { estimateDiaryTokens } from "../diary/domain";

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

export const dreamCheckBudgetInputShape: Record<string, never> = {};

/**
 * Payload-free self-check for the hot-memory token target. Reads the staged
 * user-profile back and reports its estimated tokens
 * against the SOFT TARGET the agent optimizes toward. `ok: false` / `over_by`>0
 * only means the doc is over the aim — commit is NOT size-gated, so the agent
 * trims toward target in at most ~3 passes and then commits regardless.
 */
export function createDreamCheckBudgetToolHandler(
  readStagedNight: () => Promise<CommitNightInput>,
): ToolHandler {
  return async (args) => {
    const unsupported = Object.keys(args);
    if (unsupported.length > 0) {
      throw new Error(
        `check_budget does not accept arguments: ${unsupported.join(", ")}`,
      );
    }

    const staged = await readStagedNight();
    const report = Object.fromEntries(
      (
        [
          ["user-profile.md", staged.userProfile],
        ] as const
      ).map(([filename, document]) => {
        const tokens = estimateDiaryTokens(document);
        return [
          filename,
          {
            estimated_tokens: tokens,
            limit: MEMORY_DOCUMENT_TOKEN_LIMIT,
            ok: tokens <= MEMORY_DOCUMENT_TOKEN_LIMIT,
            over_by: Math.max(0, tokens - MEMORY_DOCUMENT_TOKEN_LIMIT),
          },
        ];
      }),
    );
    return textResult(JSON.stringify(report));
  };
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
