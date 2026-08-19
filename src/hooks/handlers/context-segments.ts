import type { Database } from "bun:sqlite";

import { resolveEraCutoff } from "../../db/era";
import { listRecentSettlementProposals } from "../../db/note-settlement-proposals";
import { listAttachedSegmentsByActivity } from "../../db/segments";
import { getSessionByContentId } from "../../db/sessions";
import {
  ATTACHED_SEGMENT_BLOCK_SLOTS,
  renderAttachedSegmentBlock,
  renderProposalsBlock,
  topicNameForSegment,
  type SegmentBlockKind,
} from "../session-composition";
import type { HookResult, NormalizedHookInput } from "../types";
import { sessionWriterId } from "../../db/write-gate";

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
      const topicName = topicNameForSegment(dependencies.db, segment);
      const hookSpecificOutput = renderAttachedSegmentBlock(
        dependencies.db,
        kind,
        segment,
        topicName,
        eraCutoffEpoch,
        sessionWriterId(session.id),
      );
      return { continue: true, hookSpecificOutput };
    } catch {
      return { continue: true };
    }
  };
}

export interface ProposalsContextHandlerDependencies {
  db: Database;
}

/**
 * Proposals block (ticket 10, ticket 08's owed render-time boilerplate).
 * Deliberately NOT source-gated (review overturned the implementer's
 * resume|compact gate): ticket 08 stores a proposal "for the next
 * session's injection", and the next session opens cold — a startup gate
 * would hide every proposal from exactly the audience it was stored for.
 * Silent when nothing is pending, matching the slot handlers' "silent,
 * not an empty block" convention — the renderer's own "(none pending)"
 * line is for direct calls, not a per-session standing charge.
 */
export function createProposalsContextHandler(
  dependencies: ProposalsContextHandlerDependencies,
) {
  return async function handleProposalsContextHook(
    _input: NormalizedHookInput,
  ): Promise<HookResult> {
    try {
      if (listRecentSettlementProposals(dependencies.db, 1).length === 0) {
        return { continue: true };
      }
      return { continue: true, hookSpecificOutput: renderProposalsBlock(dependencies.db) };
    } catch {
      return { continue: true };
    }
  };
}
