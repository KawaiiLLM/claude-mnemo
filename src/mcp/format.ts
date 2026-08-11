import { renderFileTree } from "../shared/file-tree";

export const TYPE_EMOJI: Record<string, string> = {
  bugfix: "🔴",
  feature: "🟣",
  refactor: "🔄",
  change: "✅",
  discovery: "🔵",
  decision: "⚖️",
};

const FIELD_TRUNCATION_SUFFIX = "...";
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
 * Deliberately NOT inferred by scanning the rendered string for "...": user
 * content (a prompt, a title) can itself contain an ellipsis, and a scan would
 * misread that as a truncation this renderer performed.
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

function truncateText(
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
  return `${text.slice(0, boundedLimit)}${FIELD_TRUNCATION_SUFFIX}`;
}

function truncateFileTree(
  tree: string,
  {
    limit,
    signal,
  }: {
    limit: number;
    signal?: TruncationSignal;
  },
): string[] {
  const boundedLimit = Math.max(limit, 1);
  const lines = tree.split("\n");
  const kept: string[] = [];
  let used = 0;

  for (const line of lines) {
    const nextUsed = used + line.length + 1;
    if (kept.length > 0 && nextUsed > boundedLimit) {
      break;
    }
    kept.push(line);
    used = nextUsed;
  }

  const omitted = lines.length - kept.length;
  if (omitted <= 0) {
    return kept;
  }

  markTruncated(signal);
  return [...kept, `... +${omitted} lines`];
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
      ? `"${truncateText(turn.promptPreview, { limit, signal })}"`
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

  if (turn.promptPreview) {
    lines.push(
      `${detailIndent}- prompt: "${truncateText(turn.promptPreview, { limit, signal })}"`,
    );
  }

  if (turn.responsePreview) {
    lines.push(
      `${detailIndent}- response: "${truncateText(turn.responsePreview, { limit, signal })}"`,
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
      truncateFileTree(renderFileTree(turn.filesRead), { limit, signal }),
    );
  }

  if (mode === "unified" && turn.filesModified && turn.filesModified.length > 0) {
    lines.push(`${detailIndent}- files_modified:`);
    pushBullets(
      lines,
      `${detailIndent}  `,
      truncateFileTree(renderFileTree(turn.filesModified), { limit, signal }),
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
): string {
  return `${indent}- [O${observation.id}] ${observation.title}`;
}

function formatObservationCollapsedWithMode(
  observation: FormattedObservation,
  options: ObservationFormatOptions & { mode?: RenderMode } = {},
): string {
  const { indent = "", signal } = options;
  const limit = resolveExplicitTruncate(options.truncate, options.truncateCap);
  const lines = [formatObservationLabel(observation, options)];

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
  if (observation.toolName && observation.toolName !== observation.title) {
    lines.push(`${indent}  - tool: 🔧 ${observation.toolName}`);
  }
  if (observation.toolInput) {
    lines.push(
      `${indent}  - in: ${truncateText(observation.toolInput, { limit, signal })}`,
    );
  }
  if (observation.toolResult) {
    lines.push(
      `${indent}  - out: ${truncateText(observation.toolResult, { limit, signal })}`,
    );
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
