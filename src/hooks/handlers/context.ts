import type { Database } from "bun:sqlite";

import { getRecentSessions } from "../../db/sessions";
import { formatSessionCollapsed } from "../../mcp/format";
import { forkMnemosyne } from "../../mnemosyne/fork";
import type { HookResult, NormalizedHookInput } from "../types";

export interface ContextHandlerDependencies {
  db: Database;
  forkMnemosyne: typeof forkMnemosyne;
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
    _input: NormalizedHookInput,
  ): Promise<HookResult> {
    return {
      continue: true,
      hookSpecificOutput: buildContextOutput(dependencies.db),
    };
  };
}
