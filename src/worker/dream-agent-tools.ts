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
 * Payload-free self-check for the hot-memory token caps. Reads the staged
 * user-profile and experience back from the workspace and reports each
 * document's estimated tokens against the commit-enforced limit, so the agent
 * can prune BEFORE burning a failed commit attempt. Uses the same estimator
 * and constant as commitNight — the check can never disagree with the gate.
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
          ["experience.md", staged.experience],
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
