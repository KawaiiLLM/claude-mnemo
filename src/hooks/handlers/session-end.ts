import type { Database } from "bun:sqlite";

import { getSessionByContentId } from "../../db/sessions";
import { hasNewTurnSinceSessionRunStart } from "../../db/session-run";
import { notifyWorkerFlush, type WorkerClientDeps } from "../../worker/client";
import type { HookResult, NormalizedHookInput } from "../types";

export interface SessionEndHandlerDependencies {
  db: Database;
  workerClientDeps?: WorkerClientDeps;
  workerEnv?: NodeJS.ProcessEnv;
}

export function createSessionEndHandler(
  dependencies: SessionEndHandlerDependencies,
) {
  return async function handleSessionEndHook(
    input: NormalizedHookInput,
  ): Promise<HookResult> {
    if (!input.sessionId) {
      return { continue: true };
    }

    const session = getSessionByContentId(dependencies.db, input.sessionId);
    if (!session) {
      return { continue: true };
    }
    if (!hasNewTurnSinceSessionRunStart(dependencies.db, session.id)) {
      return { continue: true };
    }

    return {
      continue: true,
      asyncWork: async () => {
        await notifyWorkerFlush(
          session.id,
          dependencies.workerClientDeps,
          dependencies.workerEnv,
        );
      },
    };
  };
}
