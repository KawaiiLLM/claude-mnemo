import type { Database } from "bun:sqlite";

import { deleteQueueItem, type PendingQueueItem } from "../db/pending-queue";
import {
  getObservation,
  getObservationsForTurn,
  updateObservation,
} from "../db/observations";
import { getSession } from "../db/sessions";
import { renderFileTree } from "../shared/file-tree";
import { getTurnById, updateTurnById } from "../db/turns";
import type { MnemoConfig } from "../shared/config";
import type { SessionState } from "./server";

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

// --- Mini-turn streaming primitives (D1-D7) -------------------------------
//
// A turn streams >=1 mini-turns. Per-field caps keep each mini-turn bounded;
// the file tree is the only previously-uncapped field, so it is capped here.

const PROMPT_CAP = 1000;
const RESPONSE_CAP = 1000;
export const FILE_TREE_CAP = 1500;
const PRIOR_TITLE_CAP = 100;
const PRIOR_CONTENT_CAP = 300;
const PRIOR_INSIGHT_CAP = 150;
// Worst-case rendered <prior_turn> block (capped fields + structure) <= this.
export const PRIOR_TURN_RESERVE = 700;

// Conservative fixed-overhead upper bounds. The obs budget for a slice is
// maxMiniTurnChars minus these, so the rendered mini-turn is <= maxMiniTurnChars
// by construction (D2). Streaming slices carry no tail (response/files/count);
// final slices carry the full tail with two capped file trees.
export const STREAMING_SLICE_OVERHEAD = PROMPT_CAP + PRIOR_TURN_RESERVE + 256;
export const FINAL_SLICE_OVERHEAD =
  PROMPT_CAP + RESPONSE_CAP + PRIOR_TURN_RESERVE + 2 * FILE_TREE_CAP + 512;

// A streamed slice (mid-turn) renders slice="n" and no tail; a final slice
// (turn-stop, turn was streamed) renders slice="n" final="true" + tail; a short
// turn (never streamed) renders no slice/final attrs + tail (== today's block,
// mergeable with other short turns).
export type MiniTurnRole = "streaming" | "final" | "short";

export interface MiniTurnPriorTurn {
  title: string | null;
  content: string | null;
  insight: string | null;
}

export interface MiniTurnPayload {
  turnId: number;
  promptNumber: number;
  role: MiniTurnRole;
  partIndex: number;
  isFinal: boolean;
  needsPriorTurn: boolean;
  prompt: string | null;
  response: string | null;
  obsBlocks: string[];
  filesRead: string[];
  filesModified: string[];
  toolCallCount: number;
  invalidatedKinds: string | null;
  obsItems: PendingQueueItem[];
  turnStopItem: PendingQueueItem | null;
  size: number;
}

export interface BuildMiniTurnOptions {
  role: MiniTurnRole;
  partIndex: number;
  needsPriorTurn: boolean;
  turnStopItem: PendingQueueItem | null;
}

// Pure render of a single mini-turn. `priorTurn` is injected only when
// needsPriorTurn (read fresh at flush time, never baked into the payload, D4).
export function renderMiniTurn(
  payload: MiniTurnPayload,
  priorTurn: MiniTurnPriorTurn | null,
): string {
  const sliceAttr =
    payload.role !== "short" ? ` slice="${payload.partIndex}"` : "";
  const finalAttr = payload.role === "final" ? ` final="true"` : "";
  const invalidatedAttr = payload.invalidatedKinds
    ? ` invalidated="${payload.invalidatedKinds}"`
    : "";
  const hasTail = payload.role !== "streaming";

  const lines = [
    `  <turn id="T${payload.turnId}"${sliceAttr}${finalAttr}${invalidatedAttr}>`,
  ];
  for (const obsBlock of payload.obsBlocks) {
    lines.push(...obsBlock.split("\n").map((line) => `    ${line}`));
  }
  lines.push(`    prompt: ${truncateMiddle(payload.prompt, PROMPT_CAP)}`);
  if (hasTail) {
    lines.push(`    response: ${truncateMiddle(payload.response, RESPONSE_CAP)}`);
    lines.push("    files_read:");
    lines.push(
      ...renderFileTree(payload.filesRead, { maxChars: FILE_TREE_CAP })
        .split("\n")
        .map((line) => `      ${line}`),
    );
    lines.push("    files_modified:");
    lines.push(
      ...renderFileTree(payload.filesModified, { maxChars: FILE_TREE_CAP })
        .split("\n")
        .map((line) => `      ${line}`),
    );
    lines.push(`    tool_call_count: ${payload.toolCallCount}`);
  }
  lines.push("  </turn>");

  if (payload.needsPriorTurn && priorTurn) {
    // Caps keep the block within PRIOR_TURN_RESERVE so the budget holds (D2/D4).
    lines.push(`  <prior_turn id="T${payload.turnId}">`);
    lines.push(`    title: ${truncateMiddle(priorTurn.title, PRIOR_TITLE_CAP)}`);
    lines.push(`    content: ${truncateMiddle(priorTurn.content, PRIOR_CONTENT_CAP)}`);
    lines.push(`    insight: ${truncateMiddle(priorTurn.insight, PRIOR_INSIGHT_CAP)}`);
    lines.push("  </prior_turn>");
  }

  return lines.join("\n");
}

export function createWorkerProcessors(db: Database) {
  function buildObsBlocksFromItems(obsItems: PendingQueueItem[]): string[] {
    return obsItems
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
  }

  return {
    // Build one mini-turn payload (streaming / final / short). For final/short
    // the full-turn files are aggregated and persisted (as today); streaming
    // slices carry no tail. Role booleans are computed once here (D6).
    buildMiniTurn(
      turnId: number,
      obsItems: PendingQueueItem[],
      opts: BuildMiniTurnOptions,
    ): MiniTurnPayload | null {
      const turn = getTurnById(db, turnId);
      if (!turn || turn.status === "undone") {
        return null;
      }

      const hasTail = opts.role !== "streaming";
      const obsBlocks = buildObsBlocksFromItems(obsItems);

      let filesRead: string[] = [];
      let filesModified: string[] = [];
      let toolCallCount = 0;
      let invalidatedKinds: string | null = null;

      if (hasTail) {
        const aggregate = aggregateTurnFiles(db, turn.id);
        updateTurnById(db, turn.id, {
          filesRead: aggregate.filesRead,
          filesModified: aggregate.filesModified,
          toolCallCount: aggregate.toolCallCount,
          updatedAtEpoch: Math.floor(Date.now() / 1000),
        });
        filesRead = aggregate.filesRead;
        filesModified = aggregate.filesModified;
        toolCallCount = aggregate.toolCallCount;
        invalidatedKinds = formatInlineInvalidationKinds({
          wasInterrupted: turn.wasInterrupted,
          wasRolledBack: turn.wasRolledBack,
        });
      }

      const payload: MiniTurnPayload = {
        turnId: turn.id,
        promptNumber: turn.promptNumber,
        role: opts.role,
        partIndex: opts.partIndex,
        isFinal: opts.role === "final",
        needsPriorTurn: opts.needsPriorTurn,
        prompt: turn.userPrompt,
        response: turn.assistantResponse,
        obsBlocks,
        filesRead,
        filesModified,
        toolCallCount,
        invalidatedKinds,
        obsItems,
        turnStopItem: opts.turnStopItem,
        size: 0,
      };
      payload.size =
        renderMiniTurn(payload, null).length +
        (opts.needsPriorTurn ? PRIOR_TURN_RESERVE : 0);
      return payload;
    },

    // Peel a budget-bounded prefix of buffered obs from the head. Always takes
    // at least one obs (a single obs is <= ~720 chars < any floored budget), so
    // the buffer always drains. chunk + rest partitions the input by seq.
    peelMiniTurnObs(
      bufferedObs: PendingQueueItem[],
      budget: number,
    ): { chunk: PendingQueueItem[]; rest: PendingQueueItem[] } {
      const chunk: PendingQueueItem[] = [];
      const rest: PendingQueueItem[] = [];
      let used = 0;
      let chunkClosed = false;
      for (const item of bufferedObs) {
        const observation = getObservation(db, item.targetId);
        if (!observation || observation.status !== "pending") {
          // Stale/undone obs are dropped from the buffer (not carried to rest).
          continue;
        }
        if (chunkClosed) {
          rest.push(item);
          continue;
        }
        const block = buildObsBlock(
          observation.id,
          observation.toolName ?? "Tool",
          observation.toolInput,
          observation.toolResult,
        );
        // +4 spaces of indentation per line under <turn>, approximated.
        const blockSize = block.length + block.split("\n").length * 4;
        if (chunk.length > 0 && used + blockSize > budget) {
          chunkClosed = true;
          rest.push(item);
          continue;
        }
        chunk.push(item);
        used += blockSize;
      }
      return { chunk, rest };
    },

    // The single side-effector (D7): mark this slice's obs skipped + delete its
    // obs queue rows, and delete the turn-stop queue row when the slice carries
    // it (final/short). Run identically on flushed and dropped (D8).
    applyMiniTurnSideEffects(payload: MiniTurnPayload): void {
      for (const item of payload.obsItems) {
        const observation = getObservation(db, item.targetId);
        if (observation && observation.status === "pending") {
          updateObservation(db, observation.id, { status: "skipped" });
        }
        deleteQueueItem(db, item.seq);
      }
      if (payload.turnStopItem) {
        deleteQueueItem(db, payload.turnStopItem.seq);
      }
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
