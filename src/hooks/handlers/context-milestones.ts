import type { Database } from "bun:sqlite";

import { getSessionByContentId } from "../../db/sessions";
import { loadConfig } from "../../shared/config";
import { renderSessionMilestoneInjection } from "../milestone-injection";
import type { HookResult, NormalizedHookInput } from "../types";

export interface MilestoneContextHandlerDependencies {
  db: Database;
  renderMilestoneInjection?: (db: Database, sessionId: number) => string;
  /**
   * P2 era boundary (spec D11). Read once at handler construction, not per
   * hook: the value only changes on a worker reload. Omitted, it comes from
   * config, whose default (`null`) keeps the injection on the legacy arc.
   */
  eraCutoffEpoch?: number | null;
}

function resolveConfiguredEraCutoff(): number | null {
  try {
    return loadConfig().eraCutoffEpoch;
  } catch {
    // A config read must never cost the injection; the legacy path is safe.
    return null;
  }
}

function sessionHasTurns(db: Database, sessionId: number): boolean {
  return db
    .query<{ present: number }, [number]>(
      "SELECT 1 AS present FROM turns WHERE session_id = ? LIMIT 1",
    )
    .get(sessionId) !== null;
}

export function createMilestoneContextHandler(
  dependencies: MilestoneContextHandlerDependencies,
) {
  const eraCutoffEpoch =
    dependencies.eraCutoffEpoch !== undefined
      ? dependencies.eraCutoffEpoch
      : resolveConfiguredEraCutoff();

  return async function handleMilestoneContextHook(
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
      if (!session || !sessionHasTurns(dependencies.db, session.id)) {
        return { continue: true };
      }

      const hookSpecificOutput = dependencies.renderMilestoneInjection
        ? dependencies.renderMilestoneInjection(dependencies.db, session.id)
        : renderSessionMilestoneInjection(dependencies.db, session.id, {
            eraCutoffEpoch,
          });
      return hookSpecificOutput
        ? { continue: true, hookSpecificOutput }
        : { continue: true };
    } catch {
      return { continue: true };
    }
  };
}
