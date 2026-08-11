import { renderFileTree } from "../shared/file-tree";
import { projectToolCall, type ProjectedCall } from "./tool-projection";

export const TYPE_EMOJI: Record<string, string> = {
  bugfix: "🔴",
  feature: "🟣",
  refactor: "🔄",
  change: "✅",
  discovery: "🔵",
  decision: "⚖️",
};

/**
 * One mark for a cut field, on every read surface. This renderer ended a cut
 * with "..." while the timeline ended it with "…", so the same session read
 * differently depending on which view produced the line.
 *
 * The single character wins. It is already what every other renderer here
 * emits — the timeline's segment spine and its token-level trimmer, the
 * session-state pointer, the note reminder's prompt prefix, the replay CLI — so
 * the three-dot form could only have won by changing all of them, or by leaving
 * two marks inside one rendered response. It also costs two fewer characters of
 * a budget that exists precisely because the text did not fit: the timeline
 * measures hard per-unit token caps on the rendered line.
 */
const FIELD_TRUNCATION_SUFFIX = "…";
export const DEFAULT_TRUNCATE = 200;
export const MAX_TRUNCATE = 2000;
export const DEFAULT_PREVIEW_COUNT = 5;

export type RenderDepth = "collapsed" | "expanded";

type RenderMode = "legacy" | "unified";

/**
 * Render-scoped "did anything get cut" flag (spec D1). Discoverability — "you
 * can read the full text, and here is how" — is a property of the WHOLE
 * response, not of each truncated field, so it is recorded once per response
 * instead of re-derived per field. Created by the entry point (`recallMemory`,
 * `timelineQuery`) and threaded down through render options; a caller that
 * omits it simply gets no legend, which is what every direct `formatX` call
 * outside those two entry points wants.
 *
 * Deliberately NOT inferred by scanning the rendered string for the truncation
 * mark: user content (a prompt, a title) can itself contain an ellipsis, and a
 * scan would misread that as a truncation this renderer performed.
 */
export interface TruncationSignal {
  truncated: boolean;
}

export function createTruncationSignal(): TruncationSignal {
  return { truncated: false };
}

function markTruncated(signal?: TruncationSignal): void {
  if (signal) {
    signal.truncated = true;
  }
}

/**
 * The one navigation notice for a whole rendered response (spec D1), said once
 * instead of once per field. It covers all three things a reader needs to keep
 * digging: truncated fields are readable in full, the bracketed ids already on
 * each line are what addresses them, and hidden turn counts (timeline's folded
 * day groups) are reachable with `timeline(..., view="turns")`.
 *
 * It deliberately does NOT spell out an id format. An earlier wording promised
 * `[S<n>/T<n>]`, a form this renderer never emits — turn lines carry
 * `[S<n>][T<n>]`, optionally with a transcript-line suffix. A legend that names
 * a shape has to be re-checked against the renderer every time a label changes;
 * pointing at "the ids on that line" cannot go stale.
 * Appended only when `TruncationSignal.truncated` is set — a response with
 * nothing cut gets no legend.
 */
export const NAVIGATION_LEGEND =
  'Legend: text ending in an ellipsis was truncated — read it in full with the mnemo-replay skill, addressing it by the bracketed ids on that line; a "+N more" count is reachable with timeline(id="S<n>", view="turns").';

export function appendNavigationLegend(
  output: string,
  signal: TruncationSignal,
): string {
  if (!signal.truncated) {
    return output;
  }

  return output ? `${output}\n\n${NAVIGATION_LEGEND}` : NAVIGATION_LEGEND;
}

export interface FormattedObservation {
  id: number;
  title: string;
  content?: string | null;
  /**
   * Mechanical fields (spec D11: the O layer renders tool name + input prefix +
   * result prefix). In the segment era nothing summarizes an observation any
   * more — the LLM obs pipeline is gone — so what a tool call DID has to come
   * off the call itself. All three are era-gated together (spec D5): a legacy
   * row's record is the extractor's summary, and giving it raw tool fields
   * would change what an old rendering says. `toolName` is present here only
   * for era rows, where the label has already fallen back to it — which is
   * exactly the case the `tool:` dedup below has to catch.
   */
  toolName?: string | null;
  toolInput?: string | null;
  toolResult?: string | null;
}

export interface FormattedToolCall {
  name: string;
  keyParam?: string | null;
  input?: unknown;
  result?: string | null;
}

interface ObservationFormatOptions {
  indent?: string;
  sessionId?: number;
  turnPromptNumber?: number;
  truncate?: number;
  truncateCap?: number;
  signal?: TruncationSignal;
}

export interface FormattedTurn {
  id: number;
  promptNumber: number;
  transcriptLineStart: number | null;
  title: string | null;
  createdAtEpoch?: number | null;
  content?: string | null;
  observationCount?: number | null;
  toolCallCount?: number | null;
  filesReadCount?: number | null;
  filesModifiedCount?: number | null;
  status?: string | null;
  promptPreview?: string | null;
  responsePreview?: string | null;
  insight?: string[];
  filesRead?: string[];
  filesModified?: string[];
  observations?: FormattedObservation[];
  toolCalls?: FormattedToolCall[];
}

export interface FormattedSession {
  id: number;
  title: string | null;
  project: string;
  createdAtEpoch: number;
  content?: string | null;
  insight?: string[];
  nextSteps?: string | null;
  decision?: string | null;
  done?: string | null;
  current?: string | null;
  reference?: string | null;
  turnCount?: number | null;
  observationCount?: number | null;
  jsonlPath?: string;
  turns?: FormattedTurn[];
}

interface TurnFormatOptions {
  indent?: string;
  sessionId?: number;
  truncate?: number;
  truncateCap?: number;
  // Worker-only: append a `dbid:T<dbid>` token to the turn label so the memory
  // worker can cite a turn it found via recall. Public/main rendering leaves
  // this unset and the output is byte-identical to before.
  includeDbTurnIds?: boolean;
  signal?: TruncationSignal;
}

interface ToolCallFormatOptions {
  indent?: string;
  sessionId?: number;
  turnPromptNumber?: number;
  truncate?: number;
  truncateCap?: number;
  signal?: TruncationSignal;
}

interface RenderNodeOptions {
  depth: RenderDepth;
  indent?: string;
  sessionId?: number;
  turnPromptNumber?: number;
  truncate?: number;
  truncateCap?: number;
  mode?: RenderMode;
  includeChildren?: boolean;
  includeDbTurnIds?: boolean;
  signal?: TruncationSignal;
}

type RenderNode =
  | { type: "session"; value: FormattedSession }
  | { type: "turn"; value: FormattedTurn }
  | { type: "observation"; value: FormattedObservation }
  | { type: "toolCall"; value: FormattedToolCall };

function formatEpoch(epoch: number): string {
  const date = new Date(epoch * 1000);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function normalizeCount(value?: number | null): number {
  if (!value || value < 0) {
    return 0;
  }

  return value;
}

function formatStats(parts: string[]): string {
  return parts.join(" ");
}

function formatSessionStats(session: FormattedSession): string {
  const parts: string[] = [];
  const turnCount = normalizeCount(session.turnCount ?? session.turns?.length);
  const observationCount = normalizeCount(
    session.observationCount ??
      session.turns?.reduce(
        (sum, turn) => sum + normalizeCount(turn.observationCount),
        0,
      ),
  );

  if (turnCount > 0) {
    parts.push(`💬${turnCount}`);
  }

  if (observationCount > 0) {
    parts.push(`💡${observationCount}`);
  }

  return formatStats(parts);
}

function formatTurnStats(turn: FormattedTurn): string {
  const parts: string[] = [];
  const observationCount = normalizeCount(
    turn.observationCount ?? turn.observations?.length,
  );
  const filesReadCount = normalizeCount(
    turn.filesReadCount ?? turn.filesRead?.length,
  );
  const filesModifiedCount = normalizeCount(
    turn.filesModifiedCount ?? turn.filesModified?.length,
  );
  const toolCallCount = normalizeCount(turn.toolCallCount);

  if (observationCount > 0) {
    parts.push(`💡${observationCount}`);
  }

  if (filesReadCount > 0) {
    parts.push(`📖${filesReadCount}`);
  }

  if (filesModifiedCount > 0) {
    parts.push(`✏️${filesModifiedCount}`);
  }

  if (toolCallCount > 0) {
    parts.push(`🔧${toolCallCount}`);
  }

  return formatStats(parts);
}

function pushBullets(lines: string[], indent: string, values: string[]): void {
  for (const value of values) {
    lines.push(`${indent}- ${value}`);
  }
}

// Split a stored bullet-list field (newline-separated "- " items) into its
// items, stripping the leading dash. A single-line value yields one item.
export function splitBulletField(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^-+\s*/, ""));
}

function collapseToSingleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The one truncator. Exported because the timeline renders the same fields and
 * used to carry its own same-named copy, which hard-cut and marked the cut
 * differently — a duplicate that only half-received every fix this one got.
 */
export function truncateText(
  text: string,
  {
    limit,
    signal,
  }: {
    limit: number;
    signal?: TruncationSignal;
  },
): string {
  const boundedLimit = Math.max(limit, 1);

  if (text.length <= boundedLimit) {
    return text;
  }

  markTruncated(signal);
  const window = text.slice(0, boundedLimit);
  // End on a boundary the reader can see. A raw slice ends mid-word ("identity
  // sup...", "messaging-s..."), which reads as corruption rather than as
  // truncation.
  //
  // Word boundary only — an earlier revision also retreated to the last full
  // sentence, and that was worse: a note written conclusion-first ends its
  // first sentence around 45% in, so honouring it threw away the evidence the
  // rest of the window exists to show. One rule, and it never sacrifices text
  // it did not have to.
  if (/\s/.test(text.charAt(boundedLimit))) {
    // The window already stopped before whitespace, so its last word is whole.
    return `${window}${FIELD_TRUNCATION_SUFFIX}`;
  }
  const wordEnd = window.lastIndexOf(" ");
  // A late word boundary costs a partial word; an early one would cost most of
  // the window (a long URL, a base64 blob, an unbroken CJK run), and a hard cut
  // — the original behaviour — is the better trade there.
  if (wordEnd >= boundedLimit * 0.8) {
    return `${window.slice(0, wordEnd)}${FIELD_TRUNCATION_SUFFIX}`;
  }
  return `${window}${FIELD_TRUNCATION_SUFFIX}`;
}

/**
 * The one line-aware cut: fit a multi-line value to the same character budget a
 * one-line field gets, dropping whole lines and saying how many went.
 *
 * It was written for the file tree and now also carries an observation's body,
 * because those are the same problem and the alternative is two budgeting
 * concepts that drift apart — this renderer has already had to delete a
 * duplicate truncator that grew that way.
 *
 * `lineLimit` caps each individual line and is opt-in. A file tree does not
 * want it: its lines are paths, a cut one is a path that does not exist, and
 * the two callers that pass a tree here rendered whole paths before this
 * existed. A tool's output does want it — one line of `stdout` can be twenty
 * thousand characters, and without a per-line cap the "whole lines" rule would
 * hand the reader all of it.
 */
function truncateLines(
  lines: string[],
  {
    limit,
    signal,
    lineLimit,
  }: {
    limit: number;
    signal?: TruncationSignal;
    lineLimit?: number;
  },
): string[] {
  const boundedLimit = Math.max(limit, 1);
  // Blank lines are dropped before anything is counted, so the "+N lines" a
  // reader judges by counts content rather than emptiness. A rendered file tree
  // has none, so this is inert on that path.
  const content = lines.filter((line) => line.trim() !== "");
  const kept: string[] = [];
  let used = 0;

  for (const line of content) {
    const capped =
      lineLimit === undefined
        ? line
        : truncateText(line, { limit: lineLimit, signal });
    const nextUsed = used + capped.length + 1;
    if (kept.length > 0 && nextUsed > boundedLimit) {
      break;
    }
    kept.push(capped);
    used = nextUsed;
  }

  const omitted = content.length - kept.length;
  if (omitted <= 0) {
    return kept;
  }

  markTruncated(signal);
  // Same mark as a cut field and as the timeline's `… +N more`: a response that
  // hides things should say so one way, not two.
  return [...kept, `${FIELD_TRUNCATION_SUFFIX} +${omitted} lines`];
}

/**
 * Cut a projected header inside its parentheses rather than after them.
 *
 * `Bash(git diff --stat &&…` reads as a renderer that lost its footing;
 * `Bash(git diff --stat &&…)` reads as an argument that was too long, which is
 * what happened. Two characters to keep the call's shape intact.
 */
function truncateCallHeader(
  header: string,
  { limit, signal }: { limit: number; signal?: TruncationSignal },
): string {
  const cut = truncateText(header, { limit, signal });
  if (cut === header) {
    return cut;
  }
  return header.endsWith(")") && !cut.endsWith(")") ? `${cut})` : cut;
}

function resolveExplicitTruncate(
  truncate?: number,
  truncateCap = MAX_TRUNCATE,
): number {
  return Math.min(Math.max(truncate ?? DEFAULT_TRUNCATE, 1), truncateCap);
}

function formatStatus(status?: string | null): string {
  return status ? ` [${status}]` : "";
}

export function extractKeyParam(name: string, input: unknown): string | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const record = input as Record<string, unknown>;
  const valueForKey = (...keys: string[]) => {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim() !== "") {
        return value;
      }
    }

    return null;
  };

  switch (name) {
    case "Edit":
    case "Read":
    case "Write":
    case "Glob":
      return valueForKey("file_path", "path");
    case "Bash":
      return valueForKey("command");
    case "Grep": {
      const pattern = valueForKey("pattern");
      const path = valueForKey("path");
      if (pattern && path) {
        return `${pattern} ${path}`;
      }
      return pattern ?? path;
    }
    case "Agent":
      return valueForKey("description");
    default:
      for (const value of Object.values(record)) {
        if (typeof value === "string" && value.trim() !== "") {
          return value;
        }
      }
      return null;
  }
}

function isObservationExpanded(observation: FormattedObservation): boolean {
  return false;
}

function isTurnExpanded(turn: FormattedTurn): boolean {
  return Boolean(
    turn.promptPreview ||
      turn.responsePreview ||
      (turn.insight && turn.insight.length > 0) ||
      (turn.observations && turn.observations.length > 0) ||
      (turn.toolCalls && turn.toolCalls.length > 0),
  );
}

function formatSessionCollapsedWithMode(
  session: FormattedSession,
  mode: RenderMode,
  truncate?: number,
  truncateCap?: number,
  signal?: TruncationSignal,
): string {
  const limit = resolveExplicitTruncate(truncate, truncateCap);
  const stats = formatSessionStats(session);
  const statsSegment = stats ? ` | ${stats}` : "";
  const lines = [
    `- [S${session.id}] ${session.title ?? "Untitled"}${statsSegment} | ${formatEpoch(session.createdAtEpoch)} | ${session.project}`,
  ];

  if (session.content) {
    lines.push(
      `  - desc: ${truncateText(session.content, { limit, signal })}`,
    );
  }

  return lines.join("\n");
}

function formatSessionExpandedWithMode(
  session: FormattedSession,
  mode: RenderMode,
  truncate?: number,
  truncateCap?: number,
  signal?: TruncationSignal,
): string {
  const limit = resolveExplicitTruncate(truncate, truncateCap);
  const lines = [
    formatSessionCollapsedWithMode(session, mode, truncate, truncateCap, signal),
  ];
  const pushField = (label: string, value: string | null | undefined): void => {
    if (!value) {
      return;
    }
    lines.push(`  - ${label}: ${truncateText(value, { limit, signal })}`);
  };
  // decision/done/reference are markdown bullet lists: render a label line +
  // indented bullets (one per stored "- " line). Single-line values render as
  // one bullet. The WHOLE field shares one `limit` budget (truncate before
  // splitting) so a multi-bullet field can't balloon to bulletCount * limit.
  const pushBulletField = (label: string, value: string | null | undefined): void => {
    if (!value) {
      return;
    }
    const items = splitBulletField(truncateText(value, { limit, signal }));
    if (items.length === 0) {
      return;
    }
    lines.push(`  - ${label}:`);
    pushBullets(lines, "    ", items);
  };

  if (session.jsonlPath) {
    lines.push(`  raw: ${session.jsonlPath}`);
  }

  // D4: render the redesigned summary fields. `decision` falls back to the
  // legacy `insight` bullets for old sessions (decision NULL); empty
  // done/current/reference are skipped. decision/done/reference are bullet
  // lists; current/next are single lines.
  if (session.decision) {
    pushBulletField("decision", session.decision);
  } else if (session.insight && session.insight.length > 0) {
    lines.push("  - insight:");
    pushBullets(
      lines,
      "    ",
      session.insight.map((line) => truncateText(line, { limit, signal })),
    );
  }

  pushBulletField("done", session.done);
  pushField("current", session.current);
  pushField("next", session.nextSteps);
  pushBulletField("reference", session.reference);

  return lines.join("\n");
}

function formatTurnLabel(
  turn: FormattedTurn,
  {
    indent = "  ",
    sessionId,
    depth = "collapsed",
    truncate,
    truncateCap,
    includeDbTurnIds = false,
    signal,
  }: TurnFormatOptions & { mode?: RenderMode; depth?: RenderDepth } = {},
): string {
  const turnId = turn.transcriptLineStart === null
    ? `T${turn.promptNumber}`
    : `T${turn.promptNumber}:L${turn.transcriptLineStart}`;
  const prefix =
    sessionId === undefined
      ? `${indent}- [${turnId}]`
      : `${indent}- [S${sessionId}][${turnId}]`;
  const stats = formatTurnStats(turn);
  const statsSegment = stats ? ` | ${stats}` : "";
  const rawTitle = turn.title ?? turn.promptPreview ?? "Untitled";
  const limit = resolveExplicitTruncate(truncate, truncateCap);
  const title =
    turn.title === null && turn.promptPreview
      ? // The title slot is one line by construction. A prompt standing in for
        // a missing note need not be: a task notification or a pasted payload
        // carries newlines, and they reached the layout intact, spilling one
        // turn's label across four lines. Collapse before measuring, so the
        // truncation budget is spent on content rather than on line breaks.
        `"${truncateText(collapseToSingleLine(turn.promptPreview), {
          limit,
          signal,
        })}"`
      : truncateText(rawTitle, { limit, signal });

  // Worker-only DB-id surface: recall labels turns by prompt number, but a
  // citation needs the DB turn id (the same id remember() / `<turn id="T...">`
  // use). Appending `dbid:T<dbid>` lets the worker cite a turn it found via
  // recall(query=...). Unset → output is byte-identical to the public form.
  const dbIdSegment = includeDbTurnIds ? ` dbid:T${turn.id}` : "";

  return `${prefix} ${title}${statsSegment}${formatStatus(turn.status)}${dbIdSegment}`;
}

function formatTurnCollapsedWithMode(
  turn: FormattedTurn,
  options: TurnFormatOptions & { mode?: RenderMode } = {},
): string {
  const { indent = "  ", mode = "legacy", signal } = options;
  const limit = resolveExplicitTruncate(options.truncate, options.truncateCap);
  const lines = [
    formatTurnLabel(turn, {
      ...options,
      mode,
      depth: "collapsed",
    }),
  ];

  if (turn.content) {
    lines.push(
      `${indent}  - desc: ${truncateText(turn.content, { limit, signal })}`,
    );
  }

  return lines.join("\n");
}

function formatToolCallLabel(
  toolCall: FormattedToolCall,
  { indent = "    ", truncate, truncateCap, signal }: ToolCallFormatOptions & {
    mode?: RenderMode;
    depth?: RenderDepth;
  } = {},
): string {
  const limit = resolveExplicitTruncate(truncate, truncateCap);
  const keyParam = toolCall.keyParam ?? extractKeyParam(toolCall.name, toolCall.input);
  const suffix = keyParam
    ? ` ${truncateText(keyParam, { limit, signal })}`
    : "";

  return `${indent}- 🔧 ${toolCall.name}${suffix}`;
}

function formatToolCallCollapsedWithMode(
  toolCall: FormattedToolCall,
  options: ToolCallFormatOptions & { mode?: RenderMode } = {},
): string {
  return formatToolCallLabel(toolCall, {
    ...options,
    mode: options.mode,
    depth: "collapsed",
  });
}

function formatToolCallExpandedWithMode(
  toolCall: FormattedToolCall,
  options: ToolCallFormatOptions & { mode?: RenderMode; depth?: RenderDepth } = {},
): string {
  const { indent = "    ", truncate, signal } = options;
  const limit = resolveExplicitTruncate(truncate, options.truncateCap);
  const detailIndent = `${indent}  `;
  const lines = [
    formatToolCallLabel(toolCall, {
      ...options,
      depth: "expanded",
      truncate,
    }),
  ];

  if (toolCall.input !== undefined) {
    lines.push(
      `${detailIndent}- in: ${truncateText(JSON.stringify(toolCall.input), {
        limit,
        signal,
      })}`,
    );
  }

  if (toolCall.result) {
    lines.push(
      `${detailIndent}- out: ${truncateText(toolCall.result, { limit, signal })}`,
    );
  }

  return lines.join("\n");
}

function renderTurnChildren(
  turn: FormattedTurn,
  depth: RenderDepth,
  options: TurnFormatOptions & { mode?: RenderMode } = {},
): string {
  if (depth === "collapsed") {
    return "";
  }

  const { indent = "  ", sessionId, mode = "legacy", truncate, signal } = options;
  const childIndent = `${indent}  `;
  const childLines: string[] = [];

  if (turn.observations && turn.observations.length > 0) {
    for (const observation of turn.observations.slice(0, DEFAULT_PREVIEW_COUNT)) {
      childLines.push(
        formatObservationExpandedWithMode(observation, {
          indent: childIndent,
          sessionId,
          turnPromptNumber: turn.promptNumber,
          mode,
          depth: "expanded",
          truncate,
          signal,
        }),
      );
    }

    if (turn.observations.length > DEFAULT_PREVIEW_COUNT) {
      childLines.push(`${childIndent}+${turn.observations.length - DEFAULT_PREVIEW_COUNT} more`);
    }

    return childLines.join("\n");
  }

  if (turn.toolCalls && turn.toolCalls.length > 0) {
    for (const toolCall of turn.toolCalls.slice(0, DEFAULT_PREVIEW_COUNT)) {
      childLines.push(
        formatToolCallExpandedWithMode(toolCall, {
          indent: childIndent,
          sessionId,
          turnPromptNumber: turn.promptNumber,
          mode,
          depth: "expanded",
          truncate,
          signal,
        }),
      );
    }

    if (turn.toolCalls.length > DEFAULT_PREVIEW_COUNT) {
      childLines.push(`${childIndent}+${turn.toolCalls.length - DEFAULT_PREVIEW_COUNT} more`);
    }
  }

  return childLines.join("\n");
}

function formatTurnExpandedWithMode(
  turn: FormattedTurn,
  options: TurnFormatOptions & {
    mode?: RenderMode;
    depth?: RenderDepth;
    includeChildren?: boolean;
  } = {},
): string {
  const {
    indent = "  ",
    mode = "legacy",
    depth = "expanded",
    includeChildren = mode === "unified",
    signal,
  } = options;
  const detailIndent = `${indent}  `;
  const limit = resolveExplicitTruncate(options.truncate, options.truncateCap);
  const lines = [formatTurnCollapsedWithMode(turn, { ...options, mode })];

  // Collapsed for the reason the title slot is (see `formatTurnLabel`): these
  // are one-line field slots, and a task notification or a pasted payload
  // arrives with its newlines, which reached the layout intact and split one
  // field across four lines that no reader can attribute to it. Fixing only the
  // title slot is what left the same prompt reading differently at the two
  // depths. Collapse before measuring, so the budget buys content, not breaks.
  if (turn.promptPreview) {
    lines.push(
      `${detailIndent}- prompt: "${truncateText(collapseToSingleLine(turn.promptPreview), { limit, signal })}"`,
    );
  }

  if (turn.responsePreview) {
    lines.push(
      `${detailIndent}- response: "${truncateText(collapseToSingleLine(turn.responsePreview), { limit, signal })}"`,
    );
  }

  if (turn.insight && turn.insight.length > 0) {
    lines.push(`${detailIndent}- insight:`);
    pushBullets(
      lines,
      `${detailIndent}  `,
      turn.insight.map((line) => truncateText(line, { limit, signal })),
    );
  }

  if (mode === "unified" && turn.filesRead && turn.filesRead.length > 0) {
    lines.push(`${detailIndent}- files_read:`);
    pushBullets(
      lines,
      `${detailIndent}  `,
      truncateLines(renderFileTree(turn.filesRead).split("\n"), { limit, signal }),
    );
  }

  if (mode === "unified" && turn.filesModified && turn.filesModified.length > 0) {
    lines.push(`${detailIndent}- files_modified:`);
    pushBullets(
      lines,
      `${detailIndent}  `,
      truncateLines(renderFileTree(turn.filesModified).split("\n"), {
        limit,
        signal,
      }),
    );
  }

  const childBlock = includeChildren
    ? renderTurnChildren(turn, depth, { ...options, mode })
    : "";
  if (childBlock) {
    lines.push(childBlock);
  }

  return lines.join("\n");
}

function formatObservationLabel(
  observation: FormattedObservation,
  { indent = "" }: ObservationFormatOptions = {},
  header?: string,
): string {
  return `${indent}- [O${observation.id}] ${header ?? observation.title}`;
}

/**
 * The body sits under the label's text rather than at the bullet's own column,
 * so a multi-line value can no longer reach column zero. A line at column zero
 * does not merely look wrong: it produces a line neither a reader nor a
 * downstream parser can attribute to the observation it came from.
 */
const OBSERVATION_BODY_INDENT = "    ";

/**
 * The projection applies only to a row that carries raw tool fields, which are
 * era-gated upstream (spec D5): a legacy row's record is its extractor's
 * summary and must keep rendering as it always did. The check is the observable
 * fact — are the raw fields here — never a second era comparison, because two
 * places deciding the same era is how they come to disagree.
 */
function projectObservation(
  observation: FormattedObservation,
): ProjectedCall | null {
  if (!observation.toolInput && !observation.toolResult) {
    return null;
  }

  return projectToolCall(
    observation.toolName ?? "",
    observation.toolInput,
    observation.toolResult,
  );
}

function formatObservationCollapsedWithMode(
  observation: FormattedObservation,
  options: ObservationFormatOptions & { mode?: RenderMode } = {},
): string {
  const { indent = "", signal } = options;
  const limit = resolveExplicitTruncate(options.truncate, options.truncateCap);
  const projection = projectObservation(observation);
  // An era row has no extractor title — 0 of the 517 measured — so its label is
  // already just the tool name, and the projected header replaces it in place.
  // Where a title does exist it is the row's own record and keeps the label;
  // the header then rides the `tool:` line, which is where the tool name was
  // going anyway.
  const headerIsLabel =
    projection !== null && observation.title === observation.toolName;
  const lines = [
    formatObservationLabel(
      observation,
      options,
      headerIsLabel
        ? truncateCallHeader(projection.header, { limit, signal })
        : undefined,
    ),
  ];

  if (observation.content) {
    lines.push(
      `${indent}  - desc: ${truncateText(observation.content, { limit, signal })}`,
    );
  }

  // D3: the label above already fell back to the tool name when there was no
  // extractor title (`title ?? toolName ?? ...`, spec D11). Printing `tool:`
  // again in that case repeats the same word twice. What decides it is the
  // observable fact — does the label already say this — never the era. A
  // legacy row is not carved out here either: it never reaches this line,
  // because a legacy view carries no mechanical fields at all (spec D5).
  const toolLine = projection
    ? (headerIsLabel ? null : projection.header)
    : observation.toolName && observation.toolName !== observation.title
      ? observation.toolName
      : null;
  if (toolLine) {
    lines.push(
      `${indent}  - tool: 🔧 ${truncateCallHeader(toolLine, { limit, signal })}`,
    );
  }

  if (projection) {
    for (const line of truncateLines(projection.body, {
      limit,
      signal,
      lineLimit: limit,
    })) {
      lines.push(`${indent}${OBSERVATION_BODY_INDENT}${line}`);
    }
  }

  return lines.join("\n");
}

function formatObservationExpandedWithMode(
  observation: FormattedObservation,
  options: ObservationFormatOptions & { mode?: RenderMode; depth?: RenderDepth } = {},
): string {
  const mode = options.mode ?? "legacy";
  const lines = [formatObservationCollapsedWithMode(observation, { ...options, mode })];

  return lines.join("\n");
}

export function renderNode(node: RenderNode, options: RenderNodeOptions): string {
  const mode = options.mode ?? "unified";
  const effectiveOptions = options;

  switch (node.type) {
    case "session":
      return effectiveOptions.depth === "collapsed"
        ? formatSessionCollapsedWithMode(
            node.value,
            mode,
            effectiveOptions.truncate,
            effectiveOptions.truncateCap,
            effectiveOptions.signal,
          )
        : formatSessionExpandedWithMode(
            node.value,
            mode,
            effectiveOptions.truncate,
            effectiveOptions.truncateCap,
            effectiveOptions.signal,
          );
    case "turn":
      return effectiveOptions.depth === "collapsed"
        ? formatTurnCollapsedWithMode(node.value, { ...effectiveOptions, mode })
        : formatTurnExpandedWithMode(node.value, { ...effectiveOptions, mode });
    case "observation":
      return effectiveOptions.depth === "collapsed"
        ? formatObservationCollapsedWithMode(node.value, { ...effectiveOptions, mode })
        : formatObservationExpandedWithMode(node.value, { ...effectiveOptions, mode });
    case "toolCall":
      return effectiveOptions.depth === "collapsed"
        ? formatToolCallCollapsedWithMode(node.value, { ...effectiveOptions, mode })
        : formatToolCallExpandedWithMode(node.value, { ...effectiveOptions, mode });
  }
}

export function formatSessionCollapsed(session: FormattedSession): string {
  return renderNode({ type: "session", value: session }, { depth: "collapsed", mode: "legacy" });
}

export function formatSessionExpanded(session: FormattedSession): string {
  return renderNode({ type: "session", value: session }, { depth: "expanded", mode: "legacy" });
}

export function formatTurnCollapsed(
  turn: FormattedTurn,
  options: TurnFormatOptions = {},
): string {
  return renderNode({ type: "turn", value: turn }, { depth: "collapsed", mode: "legacy", ...options });
}

export function formatTurnExpanded(
  turn: FormattedTurn,
  options: TurnFormatOptions = {},
): string {
  return renderNode({ type: "turn", value: turn }, { depth: "expanded", mode: "legacy", ...options });
}

export function formatObservationCollapsed(
  observation: FormattedObservation,
  options: ObservationFormatOptions = {},
): string {
  return renderNode({ type: "observation", value: observation }, { depth: "collapsed", mode: "legacy", ...options });
}

export function formatObservationExpanded(
  observation: FormattedObservation,
  options: ObservationFormatOptions = {},
): string {
  return renderNode({ type: "observation", value: observation }, { depth: "expanded", mode: "legacy", ...options });
}

export function formatTree(sessions: FormattedSession[]): string {
  const lines: string[] = [];

  for (const session of sessions) {
    lines.push(formatSessionExpanded(session));

    const turns = session.turns ?? [];
    for (const entry of turns.slice(0, DEFAULT_PREVIEW_COUNT)) {
      const turnLine = isTurnExpanded(entry)
        ? formatTurnExpanded(entry, { sessionId: session.id })
        : formatTurnCollapsed(entry, { sessionId: session.id });
      lines.push(turnLine);

      const observations = entry.observations ?? [];
      for (const observationEntry of observations.slice(0, DEFAULT_PREVIEW_COUNT)) {
        lines.push(
          isObservationExpanded(observationEntry)
            ? formatObservationExpanded(observationEntry, {
                indent: "    ",
                sessionId: session.id,
                turnPromptNumber: entry.promptNumber,
              })
            : formatObservationCollapsed(observationEntry, {
                indent: "    ",
                sessionId: session.id,
                turnPromptNumber: entry.promptNumber,
              }),
        );
      }

      if (observations.length > DEFAULT_PREVIEW_COUNT) {
        lines.push(`    - ... ${observations.length - DEFAULT_PREVIEW_COUNT} omitted ...`);
      }
    }

    if (turns.length > DEFAULT_PREVIEW_COUNT) {
      lines.push(`  - ... ${turns.length - DEFAULT_PREVIEW_COUNT} omitted ...`);
    }
  }

  return lines.join("\n");
}
