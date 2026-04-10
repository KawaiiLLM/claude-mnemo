import type { Database } from "bun:sqlite";

import { getObservation, getObservationsForTurn } from "../db/observations";
import { getSession } from "../db/sessions";
import { getTurnById, updateTurnById } from "../db/turns";
import type { SessionState } from "./server";

function truncateMiddle(value: string | null | undefined, limit: number): string {
  const text = (value ?? "").trim();
  if (text.length <= limit) {
    return text;
  }

  const keep = Math.max(1, Math.floor((limit - 20) / 2));
  return `${text.slice(0, keep)}\n[...${text.length - keep * 2} chars truncated...]\n${text.slice(-keep)}`;
}

function buildObsBlock(
  observationId: number,
  toolName: string,
  toolInput: string | null,
  toolResult: string | null,
): string {
  return `<obs id="O${observationId}">
  🔧 ${toolName}
  in: ${truncateMiddle(toolInput, 500)}
  out: ${truncateMiddle(toolResult, 500)}
</obs>`;
}

function buildInitialObsPrompt(
  sessionId: number,
  project: string,
  firstUserPrompt: string | null,
  observationId: number,
  obsBlock: string,
): string {
  return `<session id="S${sessionId}">
  project: ${project}
  user_request: ${firstUserPrompt ?? ""}
</session>

${obsBlock}

<instruction>
Update this observation with remember({ id: "O${observationId}", title, content }).
If this tool call is not worth recording, use remember({ id: "O${observationId}", status: "skipped" }).
Do not update turns, sessions, or memories in this step.
</instruction>`;
}

function buildObsPrompt(observationId: number, toolName: string, toolInput: string | null, toolResult: string | null): string {
  return `${buildObsBlock(observationId, toolName, toolInput, toolResult)}

<instruction>
Update this observation with remember({ id: "O${observationId}", title, content }).
If this tool call is not worth recording, use remember({ id: "O${observationId}", status: "skipped" }).
Do not update turns, sessions, or memories in this step.
</instruction>`;
}

function buildTurnStopPrompt(
  sessionId: number,
  project: string,
  title: string | null,
  content: string | null,
  insight: string | null,
  nextSteps: string | null,
  turnId: number,
  prompt: string | null,
  response: string | null,
  filesRead: string[],
  filesModified: string[],
): string {
  return `You are Mnemosyne, observing a completed Claude Code turn.
Use only remember(), recall(), replay(). Non-tool output is discarded.

<turn id="T${turnId}">
  prompt: ${truncateMiddle(prompt, 1000)}
  response: ${truncateMiddle(response, 1000)}
</turn>

<session id="S${sessionId}">
  project: ${project}
  prior_title: ${title ?? ""}
  prior_content: ${content ?? ""}
  prior_insight: ${insight ?? ""}
  prior_next_steps: ${nextSteps ?? ""}
  files_read: ${filesRead.join(", ")}
  files_modified: ${filesModified.join(", ")}
</session>

<instruction>
Extract this turn with remember({ id: "T${turnId}", title, content, insight, type, tags }).
If the turn brought meaningful progress, also update the session with remember({ id: "S${sessionId}", title, content, insight, next_steps }).
If the turn is trivial, use remember({ id: "T${turnId}", status: "skipped" }).
</instruction>`;
}

function safeJsonParse(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function collectPathValues(input: Record<string, unknown>, key: string): string[] {
  const value = input[key];
  if (typeof value === "string" && value.trim() !== "") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is string => typeof item === "string" && item.trim() !== "",
    );
  }
  return [];
}

function aggregateTurnFiles(db: Database, turnId: number) {
  const observations = getObservationsForTurn(db, turnId);
  const filesRead = new Set<string>();
  const filesModified = new Set<string>();

  for (const observation of observations) {
    const input = safeJsonParse(observation.toolInput);
    if (!input) {
      continue;
    }

    switch (observation.toolName) {
      case "Read":
      case "Grep":
      case "Glob":
        for (const path of [
          ...collectPathValues(input, "file_path"),
          ...collectPathValues(input, "path"),
        ]) {
          filesRead.add(path);
        }
        break;
      case "Write":
      case "Edit":
      case "MultiEdit":
        for (const path of collectPathValues(input, "file_path")) {
          filesModified.add(path);
        }
        break;
      default:
        break;
    }
  }

  return {
    filesRead: [...filesRead],
    filesModified: [...filesModified],
    toolCallCount: observations.length,
  };
}

function buildSessionSummaryPrompt(
  sessionId: number,
  project: string,
  title: string | null,
  content: string | null,
  insight: string | null,
  nextSteps: string | null,
): string {
  return `You are Mnemosyne, finalizing a Claude Code session summary.
Use only remember(). Non-tool output is discarded.

<session id="S${sessionId}">
  project: ${project}
  prior_title: ${title ?? ""}
  prior_content: ${content ?? ""}
  prior_insight: ${insight ?? ""}
  prior_next_steps: ${nextSteps ?? ""}
</session>

<instruction>
Refresh the session summary only if it materially changed:
remember({ id: "S${sessionId}", title, content, insight, next_steps }).
</instruction>`;
}

export function createWorkerProcessors(db: Database) {
  return {
    async processObs(state: SessionState, observationId: number): Promise<void> {
      const observation = getObservation(db, observationId);
      if (!observation || observation.status !== "pending") {
        return;
      }

      const turn = getTurnById(db, observation.turnId);
      if (!turn) {
        return;
      }

      const session = getSession(db, turn.sessionId);
      if (!session) {
        return;
      }

      const obsBlock = buildObsBlock(
        observation.id,
        observation.toolName ?? "Tool",
        observation.toolInput,
        observation.toolResult,
      );

      if (state.initialized) {
        await state.pushMessage(
          buildObsPrompt(
            observation.id,
            observation.toolName ?? "Tool",
            observation.toolInput,
            observation.toolResult,
          ),
        );
      } else {
        const firstTurn = db
          .query<{ user_prompt: string | null }, [number]>(
            `
              SELECT user_prompt
              FROM turns
              WHERE session_id = ?
              ORDER BY prompt_number ASC
              LIMIT 1
            `,
          )
          .get(session.id);

        await state.pushMessage(
          buildInitialObsPrompt(
            session.id,
            session.project,
            firstTurn?.user_prompt ?? null,
            observation.id,
            obsBlock,
          ),
        );
        state.initialized = true;
      }

      const updatedObservation = getObservation(db, observation.id);
      if (updatedObservation?.title) {
        state.priorTitles.push(updatedObservation.title);
      }
    },

    async processTurnStop(state: SessionState, turnId: number): Promise<void> {
      const turn = getTurnById(db, turnId);
      if (!turn || turn.status !== "active") {
        return;
      }

      const session = getSession(db, turn.sessionId);
      if (!session) {
        return;
      }

      const aggregate = aggregateTurnFiles(db, turn.id);
      updateTurnById(db, turn.id, {
        filesRead: aggregate.filesRead,
        filesModified: aggregate.filesModified,
        toolCallCount: aggregate.toolCallCount,
        updatedAtEpoch: Math.floor(Date.now() / 1000),
      });

      await state.pushMessage(
        buildTurnStopPrompt(
          session.id,
          session.project,
          session.title,
          session.content,
          session.insight,
          session.nextSteps,
          turn.id,
          turn.userPrompt,
          turn.assistantResponse,
          aggregate.filesRead,
          aggregate.filesModified,
        ),
      );
      state.initialized = true;
    },

    async pushSessionSummaryPrompt(
      state: SessionState,
      sessionId: number,
    ): Promise<void> {
      const session = getSession(db, sessionId);
      if (!session) {
        return;
      }

      await state.pushMessage(
        buildSessionSummaryPrompt(
          session.id,
          session.project,
          session.title,
          session.content,
          session.insight,
          session.nextSteps,
        ),
      );
      state.initialized = true;
    },
  };
}
