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
  const constructionCutoff =
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
      // ERA BOOTSTRAP RACE (ticket 07 P2-1). These readonly slots resolve
      // the cutoff in parallel with the WRITABLE context process that
      // RECORDS it on the first run after a legacy upgrade, so a null read
      // here can be a race artifact, not a fact. A null resolved at
      // construction is re-read per invocation (`resolveEraCutoff` never
      // caches null — the writer may have landed by now); an explicit null
      // in the dependencies stays forced (the test seam).
      const eraCutoffEpoch =
        constructionCutoff !== null || dependencies.eraCutoffEpoch === null
          ? constructionCutoff
          : resolveEraCutoff(dependencies.db);

      const session = getSessionByContentId(dependencies.db, input.sessionId);
      if (!session) {
        return { continue: true };
      }
      if (kind === "milestones" && eraCutoffEpoch === null && hasAnyTurn(dependencies.db)) {
        // A null cutoff over EXISTING turns is the legacy-upgrade race: with
        // no boundary, every one of those turns would enter the frontier
        // universe and the block would render ALL-ERA — denominators and
        // elections a correctly-scoped next render contradicts. The minimal
        // honest shape is NO block at all for this invocation (exactly a
        // vacant slot's shape): a header-only block would assert "this task
        // has no lanes/milestones", which is a claim, and a wrong one. The
        // next SessionStart reads the recorded cutoff and renders normally.
        // (A turnless database is fine either way: all-era over nothing is
        // era-scoped over nothing.)
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

/** One indexed existence probe — the legacy-shape test for the P2-1 gate above. */
function hasAnyTurn(db: Database): boolean {
  return db.query<{ one: number }, []>("SELECT 1 AS one FROM turns LIMIT 1").get() !== null;
}
