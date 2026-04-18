import type { Database } from "bun:sqlite";

import type { PendingQueueItem } from "../db/pending-queue";
import {
  getObservation,
  getObservationsForTurn,
  updateObservation,
} from "../db/observations";
import { getSession } from "../db/sessions";
import { renderFileTree } from "../shared/file-tree";
import { getTurnById, updateTurnById } from "../db/turns";
import type { SessionState } from "./server";

export interface TurnPayload {
  turnId: number;
  promptNumber: number;
  prompt: string | null;
  response: string | null;
  obsBlocks: string[];
  filesRead: string[];
  filesModified: string[];
  toolCallCount: number;
  size: number;
  obsItems: PendingQueueItem[];
  turnStopItem: PendingQueueItem;
}

function truncateMiddle(value: string | null | undefined, limit: number): string {
  const text = (value ?? "").trim();
  if (text.length <= limit) {
    return text;
  }

  const keep = Math.max(1, Math.floor((limit - 20) / 2));
  return `${text.slice(0, keep)}\n[...${text.length - keep * 2} chars truncated...]\n${text.slice(-keep)}`;
}

const INPUT_STRIP: Record<string, Set<string>> = {
  Bash: new Set(["description", "timeout"]),
};

const OUTPUT_ALLOW: Record<string, Set<string>> = {
  Bash: new Set(["stdout", "stderr"]),
  Read: new Set(["content"]),
  Grep: new Set(["filenames", "content", "numFiles", "numLines"]),
  Edit: new Set(["filePath", "oldString", "newString"]),
  Glob: new Set(["filenames", "numFiles"]),
  Write: new Set(["filePath"]),
  Agent: new Set(["status", "content"]),
  WebFetch: new Set(["result", "code"]),
  WebSearch: new Set(["results"]),
  ToolSearch: new Set(["matches"]),
  Skill: new Set(["success", "commandName"]),
};

function formatJsonValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
}

function unwrapSingleStringValue(
  obj: Record<string, unknown>,
): string | Record<string, unknown> {
  const entries = Object.entries(obj);
  if (entries.length === 1 && typeof entries[0]?.[1] === "string") {
    return entries[0][1] as string;
  }

  return obj;
}

export function cleanInput(toolName: string, rawJson: string | null): string {
  const parsed = safeJsonParse(rawJson);
  if (!parsed) {
    return (rawJson ?? "").trim();
  }

  const stripKeys = INPUT_STRIP[toolName];
  const cleaned = Object.fromEntries(
    Object.entries(parsed).filter(([key]) => !stripKeys?.has(key)),
  );

  return formatJsonValue(unwrapSingleStringValue(cleaned)).trim();
}

export function cleanOutput(toolName: string, rawJson: string | null): string {
  const parsed = safeJsonParse(rawJson);
  if (!parsed) {
    return (rawJson ?? "").trim();
  }

  if (!(toolName in OUTPUT_ALLOW)) {
    return (rawJson ?? "").trim();
  }

  if (toolName === "Read") {
    const content = parsed.file;
    if (
      content &&
      typeof content === "object" &&
      typeof (content as Record<string, unknown>).content === "string"
    ) {
      return ((content as Record<string, unknown>).content as string).trim();
    }
  }

  if (toolName === "Bash") {
    const stdout =
      typeof parsed.stdout === "string" ? parsed.stdout.trim() : "";
    const stderr =
      typeof parsed.stderr === "string" ? parsed.stderr.trim() : "";

    if (!stdout && stderr) {
      return stderr;
    }

    const filtered: Record<string, unknown> = {};
    if (stdout) {
      filtered.stdout = stdout;
    }
    if (stderr) {
      filtered.stderr = stderr;
    }

    if (Object.keys(filtered).length === 0) {
      return "";
    }

    return formatJsonValue(unwrapSingleStringValue(filtered)).trim();
  }

  const allowKeys = OUTPUT_ALLOW[toolName];
  const filtered = Object.fromEntries(
    Object.entries(parsed).filter(([key, value]) => {
      if (!allowKeys?.has(key)) {
        return false;
      }
      return value !== null && value !== undefined;
    }),
  );

  if (Object.keys(filtered).length === 0) {
    return "";
  }

  return formatJsonValue(unwrapSingleStringValue(filtered)).trim();
}

function buildObsBlock(
  observationId: number,
  toolName: string,
  toolInput: string | null,
  toolResult: string | null,
): string {
  return `<obs id="O${observationId}">
  🔧 ${toolName}
  in: ${truncateMiddle(cleanInput(toolName, toolInput), 300)}
  out: ${truncateMiddle(cleanOutput(toolName, toolResult), 300)}
</obs>`;
}

function computeTurnPayloadSize(
  prompt: string | null,
  response: string | null,
  obsBlocks: string[],
  filesRead: string[],
  filesModified: string[],
  toolCallCount: number,
): number {
  return [
    prompt ?? "",
    response ?? "",
    ...obsBlocks,
    ...filesRead,
    ...filesModified,
    String(toolCallCount),
  ].join("\n").length;
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
  const renderedFilesRead = renderFileTree(filesRead);
  const renderedFilesModified = renderFileTree(filesModified);
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
  files_read:
${renderedFilesRead
  .split("\n")
  .map((line) => `  ${line}`)
  .join("\n")}
  files_modified:
${renderedFilesModified
  .split("\n")
  .map((line) => `  ${line}`)
  .join("\n")}
</session>`;
}

function buildBatchTurnBlock(
  turnId: number,
  invalidatedKinds: string | null,
  obsBlocks: string[],
  prompt: string | null,
  response: string | null,
  filesRead: string[],
  filesModified: string[],
  toolCallCount: number,
): string {
  const renderedFilesRead = renderFileTree(filesRead);
  const renderedFilesModified = renderFileTree(filesModified);
  const invalidatedAttr = invalidatedKinds
    ? ` invalidated="${invalidatedKinds}"`
    : "";
  const lines = [`  <turn id="T${turnId}"${invalidatedAttr}>`];
  for (const obsBlock of obsBlocks) {
    lines.push(...obsBlock.split("\n").map((line) => `    ${line}`));
  }
  lines.push(`    prompt: ${truncateMiddle(prompt, 1000)}`);
  lines.push(`    response: ${truncateMiddle(response, 1000)}`);
  lines.push("    files_read:");
  lines.push(...renderedFilesRead.split("\n").map((line) => `      ${line}`));
  lines.push("    files_modified:");
  lines.push(...renderedFilesModified.split("\n").map((line) => `      ${line}`));
  lines.push(`    tool_call_count: ${toolCallCount}`);
  lines.push("  </turn>");
  return lines.join("\n");
}

export function buildBatchPrompt(args: {
  sessionId: number;
  project: string;
  sessionTitle: string | null;
  currentPrompt: string | null;
  priorTitle: string | null;
  priorContent: string | null;
  priorInsight: string | null;
  priorNextSteps: string | null;
  sessionUpdated?: boolean;
  completedTurnBlocks: string[];
}): string {
  const sessionUpdatedBlock = args.sessionUpdated
    ? `<session-updated>
Session summary was refreshed since your last message.
</session-updated>

`
    : "";
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
  const body = args.completedTurnBlocks.filter(Boolean).join("\n");
  const titleLine = args.sessionTitle
    ? `\n  title: ${args.sessionTitle}`
    : "";
  const promptLine = args.currentPrompt
    ? `\n  current_prompt: ${truncateMiddle(args.currentPrompt, 200)}`
    : "";

  return `<session id="S${args.sessionId}">
  project: ${args.project}${titleLine}${promptLine}
</session>
${sessionUpdatedBlock}
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

function formatInlineInvalidationKinds(args: {
  wasInterrupted: boolean;
  wasRolledBack: boolean;
}): string | null {
  if (args.wasInterrupted && args.wasRolledBack) {
    return "interrupt+rollback";
  }
  if (args.wasInterrupted) {
    return "interrupt";
  }
  if (args.wasRolledBack) {
    return "rollback";
  }
  return null;
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
  return aggregateFilesFromObservations(observations);
}

function aggregateFilesFromObservations(
  observations: Array<{
    toolName: string | null;
    toolInput: string | null;
  }>,
) {
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
    buildTurnPayload(
      turnId: number,
      obsItems: PendingQueueItem[],
      turnStopItem: PendingQueueItem,
    ): TurnPayload | null {
      const turn = getTurnById(db, turnId);
      if (!turn || turn.status === "undone") {
        return null;
      }

      const aggregate = aggregateTurnFiles(db, turn.id);
      updateTurnById(db, turn.id, {
        filesRead: aggregate.filesRead,
        filesModified: aggregate.filesModified,
        toolCallCount: aggregate.toolCallCount,
        updatedAtEpoch: Math.floor(Date.now() / 1000),
      });

      const obsBlocks = obsItems
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
        .filter((block): block is string => block !== null);

      return {
        turnId: turn.id,
        promptNumber: turn.promptNumber,
        prompt: turn.userPrompt,
        response: turn.assistantResponse,
        obsBlocks,
        filesRead: aggregate.filesRead,
        filesModified: aggregate.filesModified,
        toolCallCount: aggregate.toolCallCount,
        size: computeTurnPayloadSize(
          turn.userPrompt,
          turn.assistantResponse,
          obsBlocks,
          aggregate.filesRead,
          aggregate.filesModified,
          aggregate.toolCallCount,
        ),
        obsItems,
        turnStopItem,
      };
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
    },

    async processBatch(
      state: SessionState,
      items: PendingQueueItem[],
      options?: {
        turnStopItems?: PendingQueueItem[];
        sessionUpdated?: boolean;
      },
    ): Promise<void> {
      if (items.length === 0 && (options?.turnStopItems?.length ?? 0) === 0) {
        return;
      }

      const sessionId =
        options?.turnStopItems?.[0]?.sessionDbId ??
        items[0]?.sessionDbId ??
        state.sessionDbId;
      const session = getSession(db, sessionId);
      if (!session) {
        return;
      }

      const obsByTurnId = new Map<
        number,
        Array<{
          observationId: number;
          toolName: string;
          toolInput: string | null;
          toolResult: string | null;
        }>
      >();

      for (const item of items) {
        const observation = getObservation(db, item.targetId);
        if (!observation || observation.status !== "pending") {
          continue;
        }

        const group = obsByTurnId.get(observation.turnId) ?? [];
        group.push({
          observationId: observation.id,
          toolName: observation.toolName ?? "Tool",
          toolInput: observation.toolInput,
          toolResult: observation.toolResult,
        });
        obsByTurnId.set(observation.turnId, group);
      }

      let currentPrompt: string | null = null;
      let latestPromptNumber = Number.NEGATIVE_INFINITY;
      const completedTurnBlocks = (options?.turnStopItems ?? [])
        .map((turnStopItem) => {
          const turn = getTurnById(db, turnStopItem.targetId);
          if (!turn || turn.status === "undone") {
            return null;
          }

          const aggregate = aggregateTurnFiles(db, turn.id);
          updateTurnById(db, turn.id, {
            filesRead: aggregate.filesRead,
            filesModified: aggregate.filesModified,
            toolCallCount: aggregate.toolCallCount,
            updatedAtEpoch: Math.floor(Date.now() / 1000),
          });

          const obsBlocks = (obsByTurnId.get(turn.id) ?? []).map((observation) =>
            buildObsBlock(
              observation.observationId,
              observation.toolName,
              observation.toolInput,
              observation.toolResult,
            ),
          );

          if (turn.promptNumber > latestPromptNumber) {
            latestPromptNumber = turn.promptNumber;
            currentPrompt = turn.userPrompt;
          }

          return buildBatchTurnBlock(
            turn.id,
            formatInlineInvalidationKinds({
              wasInterrupted: turn.wasInterrupted,
              wasRolledBack: turn.wasRolledBack,
            }),
            obsBlocks,
            turn.userPrompt,
            turn.assistantResponse,
            aggregate.filesRead,
            aggregate.filesModified,
            aggregate.toolCallCount,
          );
        })
        .filter((block): block is string => block !== null);

      if (completedTurnBlocks.length === 0) {
        return;
      }

      const needsSessionContext = options?.sessionUpdated ?? false;
      const sessionUpdated = options?.sessionUpdated ?? false;

      await state.pushMessage(
        buildBatchPrompt({
          sessionId: session.id,
          project: session.project,
          sessionTitle: session.title,
          currentPrompt,
          priorTitle: needsSessionContext ? session.title : null,
          priorContent: needsSessionContext ? session.content : null,
          priorInsight: needsSessionContext ? session.insight : null,
          priorNextSteps: needsSessionContext ? session.nextSteps : null,
          sessionUpdated,
          completedTurnBlocks,
        }),
      );
      if ((options?.turnStopItems?.length ?? 0) > 0) {
        const completedTurnIds = new Set(
          (options?.turnStopItems ?? []).map((item) => item.targetId),
        );
        for (const item of items) {
          const observation = getObservation(db, item.targetId);
          if (
            !observation ||
            observation.status !== "pending" ||
            !completedTurnIds.has(observation.turnId)
          ) {
            continue;
          }
          updateObservation(db, observation.id, { status: "skipped" });
        }
      }
      const freshSession = getSession(db, session.id);
      state.lastInjectedSummaryEpoch = freshSession?.summaryUpdatedAtEpoch ?? 0;
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
    },
  };
}
