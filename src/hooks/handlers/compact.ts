import type { Database } from "bun:sqlite";

import { getSessionByContentId } from "../../db/sessions";
import { notifyWorkerCompact, type WorkerClientDeps } from "../../worker/client";
import type { HookResult, NormalizedHookInput } from "../types";

export interface CompactHandlerDependencies {
  db: Database;
  workerClientDeps?: WorkerClientDeps;
  workerEnv?: NodeJS.ProcessEnv;
}

export function createCompactHandler(dependencies: CompactHandlerDependencies) {
  return async function handleCompactHook(
    input: NormalizedHookInput,
  ): Promise<HookResult> {
    if (!input.sessionId) {
      return { continue: true };
    }

    const session = getSessionByContentId(dependencies.db, input.sessionId);
    if (!session) {
      return { continue: true };
    }

    await notifyWorkerCompact(
      session.id,
      input.transcriptPath,
      dependencies.workerClientDeps,
      dependencies.workerEnv,
    );

    return { continue: true };
  };
}
