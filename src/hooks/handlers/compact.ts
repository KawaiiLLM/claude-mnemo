import type { Database } from "bun:sqlite";

import { getSessionByContentId, updateCompactAnchor } from "../../db/sessions";
import {
  claimTurnsForExtraction,
  getPendingTurns,
  recoverStalledExtractions,
} from "../../db/turns";
import { buildExtractionContext } from "../../mnemosyne/context";
import { forkMnemosyne } from "../../mnemosyne/fork";
import { buildMnemosynePrompt } from "../../mnemosyne/prompt";
import { backfillFromTranscript } from "../backfill";
import { resolveTranscriptPath } from "../../shared/paths";
import type { HookResult, NormalizedHookInput } from "../types";

export interface CompactHandlerDependencies {
  db: Database;
  forkMnemosyne: typeof forkMnemosyne;
  now?: () => number;
}

function buildPrompt(db: Database, sessionDbId: number): string {
  return buildMnemosynePrompt(buildExtractionContext(db, sessionDbId));
}

export function createCompactHandler(dependencies: CompactHandlerDependencies) {
  const now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));

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

    const transcriptPath =
      input.transcriptPath ||
      (input.cwd ? resolveTranscriptPath(input.cwd, input.sessionId) : undefined);
    const epoch = now();

    recoverStalledExtractions(dependencies.db, session.id, 300, epoch);

    const pendingTurns = getPendingTurns(dependencies.db, session.id);
    backfillFromTranscript(dependencies.db, pendingTurns, transcriptPath);
    const claimedCount = claimTurnsForExtraction(
      dependencies.db,
      session.id,
      epoch,
    );

    if (claimedCount > 0) {
      const prompt = buildPrompt(dependencies.db, session.id);

      return {
        continue: true,
        asyncWork: async () => {
          await dependencies.forkMnemosyne({
            cwd: input.cwd,
            prompt,
            database: dependencies.db,
          });
          updateCompactAnchor(dependencies.db, session.id);
        },
      };
    }

    return {
      continue: true,
    };
  };
}
