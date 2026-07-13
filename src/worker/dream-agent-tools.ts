import type { ToolHandler } from "../mcp/handlers";
import { textResult } from "../mcp/handlers";
import type { CommitNightInput, DreamMemoryStore } from "../diary/memory-store";
import { z } from "zod";

export const dreamCommitInputShape = {
  date: z.string().min(1),
  userProfile: z.string(),
  experience: z.string(),
  archive: z.string(),
  diary: z.string(),
  diaryIndex: z.string(),
} satisfies Record<keyof CommitNightInput, z.ZodType<string>>;

const COMMIT_FIELDS = Object.keys(
  dreamCommitInputShape,
) as (keyof CommitNightInput)[];

export function assertDreamCommitToolFields(
  args: Record<string, unknown>,
): void {
  const supported = new Set<string>(COMMIT_FIELDS);
  const unsupported = Object.keys(args).filter((field) => !supported.has(field));
  if (unsupported.length > 0) {
    throw new Error(`Dream commit has unsupported fields: ${unsupported.join(", ")}`);
  }
}

/**
 * Agent-facing ticket-01 boundary. It accepts complete document bodies only;
 * callers cannot choose filesystem paths or split one night into partial writes.
 */
export function createDreamCommitToolHandler(
  store: Pick<DreamMemoryStore, "commitNight">,
): ToolHandler {
  return async (args) => {
    assertDreamCommitToolFields(args);

    const input = {} as Record<keyof CommitNightInput, string>;
    for (const field of COMMIT_FIELDS) {
      const value = args[field];
      if (typeof value !== "string") {
        throw new Error(`Dream commit field must be a string: ${field}`);
      }
      input[field] = value;
    }

    const result = await store.commitNight(input);
    return textResult(JSON.stringify({
      status: "committed",
      last_successful_date: result.lastSuccessfulDate,
      snapshot_id: result.snapshot.id,
    }));
  };
}
