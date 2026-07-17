import type { Database } from "bun:sqlite";

import { getSessionByContentId } from "../../db/sessions";
import { renderSessionMilestoneInjection } from "../milestone-injection";
import type { HookResult, NormalizedHookInput } from "../types";

export interface MilestoneContextHandlerDependencies {
  db: Database;
  renderMilestoneInjection?: (db: Database, sessionId: number) => string;
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

      const hookSpecificOutput = (
        dependencies.renderMilestoneInjection ?? renderSessionMilestoneInjection
      )(dependencies.db, session.id);
      return hookSpecificOutput
        ? { continue: true, hookSpecificOutput }
        : { continue: true };
    } catch {
      return { continue: true };
    }
  };
}
