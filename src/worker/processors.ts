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

// D5: a session whose summary is this many extracted turns behind is flagged
// stale, and the next injected batch nudges a full refresh.
export const STALE_TURN_THRESHOLD = 10;

export function buildBatchPrompt(args: {
  sessionId: number;
  project: string;
  sessionTitle: string | null;
  currentPrompt: string | null;
  prior: PriorSessionSummary | null;
  sessionUpdated?: boolean;
  staleTurns?: number;
  completedTurnBlocks: string[];
}): string {
  const isStale = (args.staleTurns ?? 0) >= STALE_TURN_THRESHOLD;
  const staleAttr = isStale ? ` stale_turns="${args.staleTurns}"` : "";
  const noticeBlock = isStale
    ? `<session-stale>
The session summary is ${args.staleTurns} extracted turns behind. Re-supply ALL session fields (title, content, decision, done, current, next_steps, reference) for a complete refresh — edit on top of prior_* below.
</session-stale>

`
    : args.sessionUpdated
      ? `<session-updated>
Session summary was refreshed since your last message.
</session-updated>

`
      : "";
  const prior = args.prior;
  // Render the FULL prior scaffold whenever a refresh is invited (summary
  // changed elsewhere, or stale) — even if every field is empty. A
  // never-refreshed stale session must still see the labelled prior_* fields
  // the instruction tells the agent to edit on top of. Labels mirror the
  // standalone summary message's `prior_*` wording.
  const showPrior = prior !== null && (Boolean(args.sessionUpdated) || isStale);
  const priorSessionBlock = showPrior
    ? `
<prior_session>
  prior_title: ${prior!.title ?? ""}
  prior_content: ${prior!.content ?? ""}
  prior_decision: ${prior!.decision ?? ""}
  prior_done: ${prior!.done ?? ""}
  prior_current: ${prior!.current ?? ""}
  prior_next: ${prior!.nextSteps ?? ""}
  prior_reference: ${prior!.reference ?? ""}
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

  return `<session id="S${args.sessionId}"${staleAttr}>
  project: ${args.project}${titleLine}${promptLine}
</session>
${noticeBlock}${priorSessionBlock}
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

export interface PriorSessionSummary {
  title: string | null;
  content: string | null;
  decision: string | null;
  done: string | null;
  current: string | null;
  nextSteps: string | null;
  reference: string | null;
}

// Shared instruction body for a session-summary refresh (D1/D2). Used by both
// the standalone summary message and the inline <prior_session> path so the
// field set, all-or-nothing rule, and [T<n>] convention stay identical.
function sessionSummaryInstruction(sessionId: number): string {
  return `<instruction>
Refresh the session summary ONLY if material change since prior_*: a new goal, a completed milestone, a reversed decision, or a newly discovered constraint. Small incremental work does NOT qualify.

If updating, you MUST re-supply ALL seven fields — the summary is rewritten whole, never merged, so omitting any field is rejected. Edit each field on top of its prior_* value (echo-and-edit), do not regenerate from scratch:
remember({ id: "S${sessionId}", title, content, decision, done, current, next_steps, reference })

Fields:
- title: 20-50 chars, one line
- content: 100-300 chars, what the session is about (browsing synopsis)
- decision: key decisions and WHY they were made; cite pivotal turns inline as [T<n>] using the id from the <turn id="T..."> block. Keep prior [T<n>] markers.
- done: completed work; cite milestone turns inline as [T<n>]. Keep prior [T<n>] markers.
- current: where things stand right now
- next_steps: 50-150 chars, what is pending / the next step
- reference: external anchors only — reference repos, URLs, PRs, out-of-project paths. Empty string if none.

Do NOT mention file paths, tool counts, or code-level details except in reference. Those belong in turn records. Do NOT record durable cross-project lessons here — those are the main agent's M-level memories.

If no material change, respond with no tool calls. An empty response is the "leave alone" signal.
</instruction>`;
}

function buildSessionSummaryPrompt(
  sessionId: number,
  project: string,
  prior: PriorSessionSummary,
): string {
  return `<session id="S${sessionId}">
  project: ${project}
  prior_title: ${prior.title ?? ""}
  prior_content: ${prior.content ?? ""}
  prior_decision: ${prior.decision ?? ""}
  prior_done: ${prior.done ?? ""}
  prior_current: ${prior.current ?? ""}
  prior_next: ${prior.nextSteps ?? ""}
  prior_reference: ${prior.reference ?? ""}
</session>

${sessionSummaryInstruction(sessionId)}`;
}

// --- Mini-turn streaming primitives (D1-D7) -------------------------------
//
// A turn streams >=1 mini-turns. Per-field caps keep each mini-turn bounded;
// the file tree is the only previously-uncapped field, so it is capped here.

const PROMPT_CAP = 1000;
const RESPONSE_CAP = 2000;
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
        // Pass status explicitly so persisting the file aggregation does NOT
        // auto-promote an active turn to extracted (turns.ts auto-promote).
        // Status changes only when the agent remembers; otherwise a dropped
        // flush would wrongly render "partially extracted" instead of "not yet
        // extracted" (delivery-dropped reminder, D8/D9).
        updateTurnById(db, turn.id, {
          status: turn.status,
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
        buildSessionSummaryPrompt(session.id, session.project, {
          title: session.title,
          content: session.content,
          decision: session.decision,
          done: session.done,
          current: session.current,
          nextSteps: session.nextSteps,
          reference: session.reference,
        }),
      );
    },
  };
}
