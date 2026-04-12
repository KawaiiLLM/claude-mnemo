import type { Database } from "bun:sqlite";

import type { PendingQueueItem } from "../db/pending-queue";
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
  priorTitle: string | null,
  priorContent: string | null,
  priorInsight: string | null,
  priorNextSteps: string | null,
  obsBlock: string,
): string {
  const priorSessionBlock =
    priorTitle || priorContent || priorInsight || priorNextSteps
      ? `
<prior_session>
  title: ${priorTitle ?? ""}
  content: ${priorContent ?? ""}
  insight: ${priorInsight ?? ""}
  next_steps: ${priorNextSteps ?? ""}
</prior_session>
`
      : "";

  return `<session id="S${sessionId}">
  project: ${project}
  user_request: ${firstUserPrompt ?? ""}
</session>
${priorSessionBlock}
${obsBlock}`;
}

function buildObsPrompt(
  observationId: number,
  toolName: string,
  toolInput: string | null,
  toolResult: string | null,
): string {
  return buildObsBlock(observationId, toolName, toolInput, toolResult);
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
  return `<turn id="T${turnId}">
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
</session>`;
}

function buildBatchTurnBlock(
  turnId: number,
  prompt: string | null,
  response: string | null,
  filesRead: string[],
  filesModified: string[],
  toolCallCount: number,
): string {
  return `  <turn id="T${turnId}">
    prompt: ${truncateMiddle(prompt, 1000)}
    response: ${truncateMiddle(response, 1000)}
    files_read: ${filesRead.join(", ")}
    files_modified: ${filesModified.join(", ")}
    tool_call_count: ${toolCallCount}
  </turn>`;
}

export function buildBatchPrompt(args: {
  sessionId: number;
  project: string;
  firstUserPrompt: string | null;
  priorTitle: string | null;
  priorContent: string | null;
  priorInsight: string | null;
  priorNextSteps: string | null;
  obsBlocks: string[];
  turnBlock?: string | null;
}): string {
  const priorSessionBlock =
    args.priorTitle || args.priorContent || args.priorInsight || args.priorNextSteps
      ? `
<prior_session>
  title: ${args.priorTitle ?? ""}
  content: ${args.priorContent ?? ""}
  insight: ${args.priorInsight ?? ""}
  next_steps: ${args.priorNextSteps ?? ""}
</prior_session>
`
      : "";
  const body = [...args.obsBlocks, args.turnBlock ?? ""].filter(Boolean).join("\n");

  return `<session id="S${args.sessionId}">
  project: ${args.project}
  user_request: ${args.firstUserPrompt ?? ""}
</session>
${priorSessionBlock}
<batch>
${body}
</batch>`;
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
  return `<session id="S${sessionId}">
  project: ${project}
  prior_title: ${title ?? ""}
  prior_content: ${content ?? ""}
  prior_insight: ${insight ?? ""}
  prior_next_steps: ${nextSteps ?? ""}
</session>

<instruction>
Refresh the session summary ONLY if material change since prior_*: a new goal, a completed milestone, a reversed decision, or a newly discovered constraint. Small incremental work does NOT qualify.

If updating, call:
remember({ id: "S${sessionId}", title, content, insight, next_steps })

Length budget (strict):
- title: 20-50 chars, one line
- content: 100-300 chars, what the session is about
- insight: 2-5 bullet lines, each ≤50 chars, prefixed "- "
- next_steps: 50-150 chars, what's pending
- Total: <500 chars

Do NOT mention file paths, tool counts, or code-level details. Those belong in turn records.

If no material change, respond with no tool calls. An empty response is the "leave alone" signal.
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
            session.title,
            session.content,
            session.insight,
            session.nextSteps,
            obsBlock,
          ),
        );
        state.initialized = true;
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

    async processBatch(
      state: SessionState,
      items: PendingQueueItem[],
      turnStopItem?: PendingQueueItem,
    ): Promise<void> {
      if (items.length === 0 && !turnStopItem) {
        return;
      }

      const sessionId =
        turnStopItem?.sessionDbId ?? items[0]?.sessionDbId ?? state.sessionDbId;
      const session = getSession(db, sessionId);
      if (!session) {
        return;
      }

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

      const obsBlocks = items
        .map((item) => {
          const observation = getObservation(db, item.targetId);
          if (!observation || observation.status !== "pending") {
            return null;
          }

          return buildObsBlock(
            observation.id,
            observation.toolName ?? "Tool",
            observation.toolInput,
            observation.toolResult,
          );
        })
        .filter((value): value is string => value !== null);

      let turnBlock: string | null = null;
      if (turnStopItem) {
        const turn = getTurnById(db, turnStopItem.targetId);
        if (turn && turn.status === "active") {
          const aggregate = aggregateTurnFiles(db, turn.id);
          updateTurnById(db, turn.id, {
            filesRead: aggregate.filesRead,
            filesModified: aggregate.filesModified,
            toolCallCount: aggregate.toolCallCount,
            updatedAtEpoch: Math.floor(Date.now() / 1000),
          });

          turnBlock = buildBatchTurnBlock(
            turn.id,
            turn.userPrompt,
            turn.assistantResponse,
            aggregate.filesRead,
            aggregate.filesModified,
            aggregate.toolCallCount,
          );
        }
      }

      if (obsBlocks.length === 0 && !turnBlock) {
        return;
      }

      await state.pushMessage(
        buildBatchPrompt({
          sessionId: session.id,
          project: session.project,
          firstUserPrompt: firstTurn?.user_prompt ?? null,
          priorTitle: session.title,
          priorContent: session.content,
          priorInsight: session.insight,
          priorNextSteps: session.nextSteps,
          obsBlocks,
          turnBlock,
        }),
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
