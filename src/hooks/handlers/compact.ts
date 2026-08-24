import type { Database } from "bun:sqlite";

import { runHookWriteTransaction } from "../../db/database";
import { getSessionByContentId } from "../../db/sessions";
import { clearReadGrantsForWriter, sessionWriterId } from "../../db/write-gate";
import { notifyWorkerCompact, type WorkerClientDeps } from "../../worker/client";
import type { HookResult, NormalizedHookInput } from "../types";

export interface CompactHandlerDependencies {
  db: Database;
  workerClientDeps?: WorkerClientDeps;
  workerEnv?: NodeJS.ProcessEnv;
  /** Seam for the write-gate wipe's own transaction (default `runHookWriteTransaction`). */
  runHookWriteTransaction?: typeof runHookWriteTransaction;
}

export function createCompactHandler(dependencies: CompactHandlerDependencies) {
  const writeTransaction =
    dependencies.runHookWriteTransaction ?? runHookWriteTransaction;

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

    // Write gate (ticket 01, read-write-contract spec "compact后才清空一次
    // 授权"): PreCompact is the event that actually destroys the context this
    // writer's read grants were earned on (a plain resume reloads the full
    // transcript; a compacted one does not) — so the wipe lives HERE, not in
    // SessionEnd. Clears both the grants and this writer's per-field
    // completeness records in one call (`clearReadGrantsForWriter`), which
    // is also what makes `checkRelationsGate` demand a fresh relations read
    // post-compact — the relations completeness row it consults is the same
    // per-writer table this wipe clears. Best-effort: a failure here must
    // never stop the compact notification below, which is what keeps the
    // worker's own state in sync with the transcript boundary.
    try {
      writeTransaction(dependencies.db, () => {
        clearReadGrantsForWriter(dependencies.db, sessionWriterId(session.id));
      });
    } catch (error) {
      process.stderr.write(
        `[claude-mnemo] pre-compact write-gate wipe failed for session ${session.id}: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }

    await notifyWorkerCompact(
      session.id,
      session.contentSessionId,
      input.transcriptPath,
      dependencies.workerClientDeps,
      dependencies.workerEnv,
    );

    return { continue: true };
  };
}
