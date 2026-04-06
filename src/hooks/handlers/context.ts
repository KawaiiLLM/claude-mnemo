import type { Database } from "bun:sqlite";

import { getRecentSessions, getSessionByContentId } from "../../db/sessions";
import { getPendingTurns, getTurnsForSession } from "../../db/turns";
import { formatSessionCollapsed } from "../../mcp/format";
import { forkMnemosyne } from "../../mnemosyne/fork";
import {
  buildExtractionStatusSummary,
  buildMnemosynePrompt,
} from "../../mnemosyne/prompt";
import type { HookResult, NormalizedHookInput } from "../types";

export interface ContextHandlerDependencies {
  db: Database;
  forkMnemosyne: typeof forkMnemosyne;
}

function buildPrompt(db: Database, sessionDbId: number): string {
  return buildMnemosynePrompt(
    buildExtractionStatusSummary(
      getTurnsForSession(db, sessionDbId).map((turn) => ({
        promptNumber: turn.promptNumber,
        status: turn.status as "pending" | "stale" | "extracted" | "skipped",
        promptPreview: turn.userPrompt ?? "",
      })),
    ),
  );
}

function buildContextOutput(db: Database): string {
  const sessions = getRecentSessions(db, { limit: 5 });

  if (sessions.length === 0) {
    return "claude-mnemo memory available via recall() and replay().";
  }

  return [
    "claude-mnemo memory available via recall() and replay().",
    ...sessions.map((session) =>
      formatSessionCollapsed({
        id: session.id,
        title: session.title,
        project: session.project,
        startedAtEpoch: session.startedAtEpoch,
      }),
    ),
  ].join("\n");
}

export function createContextHandler(dependencies: ContextHandlerDependencies) {
  return async function handleContextHook(
    input: NormalizedHookInput,
  ): Promise<HookResult> {
    if (input.source === "resume" && input.sessionId) {
      const session = getSessionByContentId(dependencies.db, input.sessionId);

      if (session && getPendingTurns(dependencies.db, session.id).length > 0) {
        void dependencies.forkMnemosyne({
          sessionId: input.sessionId,
          cwd: input.cwd,
          prompt: buildPrompt(dependencies.db, session.id),
        });
      }
    }

    return {
      continue: true,
      hookSpecificOutput: buildContextOutput(dependencies.db),
    };
  };
}

