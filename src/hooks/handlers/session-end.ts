import type { Database } from "bun:sqlite";

import { runHookWriteTransaction } from "../../db/database";
import { getSessionByContentId } from "../../db/sessions";
import { hasNewTurnSinceSessionRunStart } from "../../db/session-run";
import {
  enqueueOrphanTurnStops,
  getOrphanTurns,
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

    // A turn interrupted mid-response never fires the Stop hook, so its
    // turn-stop is normally back-filled by the NEXT Stop in this session —
    // which never comes if the user closes right after interrupting. Enqueue
    // those orphans here so the session-end tail drain consumes them within
    // the same bounded budget.
    if (hasNewTurnSinceSessionRunStart(dependencies.db, session.id)) {
      const orphanTurns = getOrphanTurns(dependencies.db, session.id);
      if (orphanTurns.length > 0) {
        writeTransaction(dependencies.db, () => {
          enqueueOrphanTurnStops(
            dependencies.db,
            session.id,
            now(),
            orphanTurns,
          );
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
