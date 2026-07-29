import type { Database } from "bun:sqlite";

import { runHookWriteTransaction } from "../../db/database";
import { getSessionByContentId } from "../../db/sessions";
import { hasNewTurnSinceSessionRunStart } from "../../db/session-run";
import {
  getOrphanTurns,
  skipOrphanTurns,
} from "../../db/orphan-turns";
import {
  notifyWorkerFlush,
  notifyWorkerTrigger,
  type WorkerClientDeps,
} from "../../worker/client";
import type { HookResult, NormalizedHookInput } from "../types";

export interface SessionEndHandlerDependencies {
  db: Database;
  now?: () => number;
  workerClientDeps?: WorkerClientDeps;
  workerEnv?: NodeJS.ProcessEnv;
  runHookWriteTransaction?: typeof runHookWriteTransaction;
}

export function createSessionEndHandler(
  dependencies: SessionEndHandlerDependencies,
) {
  const now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));
  const writeTransaction =
    dependencies.runHookWriteTransaction ?? runHookWriteTransaction;

  return async function handleSessionEndHook(
    input: NormalizedHookInput,
  ): Promise<HookResult> {
    if (!input.sessionId) {
      return { continue: true };
    }

    const session = getSessionByContentId(dependencies.db, input.sessionId);
    if (!session) {
      return {
        continue: true,
        asyncWork: async () => {
          await notifyWorkerTrigger(
            {
              action: "finish",
              contentSessionId: input.sessionId!,
            },
            dependencies.workerClientDeps,
            dependencies.workerEnv,
          );
        },
      };
    }

    // A turn interrupted mid-response will never receive more content after
    // the session exits. Enqueueing a turn-stop here only works if the
    // session's env is still registered at the exact moment SessionEnd runs;
    // that precondition necessarily fails, stranding the queue item and
    // leaving the turn active forever, which permanently blocks the diary
    // readiness gate. Finalize these orphans directly without enqueueing.
    if (hasNewTurnSinceSessionRunStart(dependencies.db, session.id)) {
      const orphanTurns = getOrphanTurns(dependencies.db, session.id);
      if (orphanTurns.length > 0) {
        writeTransaction(dependencies.db, () => {
          skipOrphanTurns(dependencies.db, session.id, now(), orphanTurns);
        });
      }
    }

    return {
      continue: true,
      asyncWork: async () => {
        await notifyWorkerFlush(
          session.id,
          session.contentSessionId,
          dependencies.workerClientDeps,
          dependencies.workerEnv,
        );
      },
    };
  };
}
