import type { Database } from "bun:sqlite";

import { resolveEraCutoff } from "../../db/era";
import { listAttachedSegmentsByActivity } from "../../db/segments";
import { getSessionByContentId } from "../../db/sessions";
import {
  ATTACHED_SEGMENT_BLOCK_SLOTS,
  renderAttachedSegmentBlock,
  type SegmentBlockKind,
} from "../session-composition";
import type { HookResult, NormalizedHookInput } from "../types";

export interface SegmentBlockContextHandlerDependencies {
  db: Database;
  /** P2 era boundary, read once at handler construction — same pattern `context-milestones.ts` (retired by this ticket) used. */
  eraCutoffEpoch?: number | null;
}

/**
 * One slot of the fixed SessionStart segment-block pool (ticket 10). Slots
 * are 1-based and activity-ordered: slot `k` renders the k-th
 * most-recently-active attached segment's `kind` block, or stays silent
 * when the session has fewer than `k` attachments. `ATTACHED_SEGMENT_BLOCK_SLOTS`
 * slots x {fields, milestones} are registered as SEPARATE SessionStart hook
 * commands — the persist-granularity experiment's pool verdict (this
 * ticket's Status note has the file:line evidence): an attachment count
 * beyond the pool renders through the roster's recall pointer instead of a
 * seventh/eighth/… command that does not exist.
 *
 * Gated to resume/compact like the milestones/sessions sections it replaces
 * — a freshly started or cleared session cannot yet have a pre-existing
 * attachment to render.
 */
export function createSegmentBlockContextHandler(
  dependencies: SegmentBlockContextHandlerDependencies,
  slotIndex: number,
  kind: SegmentBlockKind,
) {
  const eraCutoffEpoch =
    dependencies.eraCutoffEpoch !== undefined
      ? dependencies.eraCutoffEpoch
      : resolveEraCutoff(dependencies.db);

  return async function handleSegmentBlockContextHook(
    input: NormalizedHookInput,
  ): Promise<HookResult> {
    if (
      !input.sessionId ||
      (input.source !== "resume" && input.source !== "compact")
    ) {
      return { continue: true };
    }

    try {
      const session = getSessionByContentId(dependencies.db, input.sessionId);
      if (!session) {
        return { continue: true };
      }
      const attached = listAttachedSegmentsByActivity(
        dependencies.db,
        session.id,
        ATTACHED_SEGMENT_BLOCK_SLOTS,
      );
      const segment = attached[slotIndex - 1];
      if (!segment) {
        return { continue: true };
      }
      const hookSpecificOutput = renderAttachedSegmentBlock(
        dependencies.db,
        kind,
        segment,
        eraCutoffEpoch,
      );
      return { continue: true, hookSpecificOutput };
    } catch {
      return { continue: true };
    }
  };
}
