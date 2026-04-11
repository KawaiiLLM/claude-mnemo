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

export interface FormattedObservation {
  id: number;
  title: string;
  content?: string | null;
}

export interface FormattedMemorySource {
  sessionId: number;
  promptNumber: number;
  title: string | null;
  createdAtEpoch: number;
}

export interface FormattedToolCall {
  name: string;
  keyParam?: string | null;
  input?: unknown;
  result?: string | null;
}

export interface FormattedMemory {
  id: number;
  type: string;
  scope: string;
  title: string;
  content: string;
  reasoning?: string | null;
  application?: string | null;
  tags?: string[];
  createdAtEpoch: number;
  updatedAtEpoch?: number | null;
  sourceCount?: number | null;
  source?: FormattedMemorySource | null;
}

interface ObservationFormatOptions {
  indent?: string;
  sessionId?: number;
  turnPromptNumber?: number;
  truncate?: number;
}

export interface FormattedTurn {
  id: number;
  promptNumber: number;
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
  turnCount?: number | null;
  observationCount?: number | null;
  turns?: FormattedTurn[];
}

interface TurnFormatOptions {
  indent?: string;
  sessionId?: number;
  truncate?: number;
}

interface ToolCallFormatOptions {
  indent?: string;
  sessionId?: number;
  turnPromptNumber?: number;
  truncate?: number;
}

interface RenderNodeOptions {
  depth: RenderDepth;
  indent?: string;
  sessionId?: number;
  turnPromptNumber?: number;
  truncate?: number;
  mode?: RenderMode;
  includeChildren?: boolean;
}

type RenderNode =
  | { type: "session"; value: FormattedSession }
  | { type: "turn"; value: FormattedTurn }
  | { type: "observation"; value: FormattedObservation }
  | { type: "memory"; value: FormattedMemory }
  | { type: "toolCall"; value: FormattedToolCall };

function formatEpoch(epoch: number): string {
  const date = new Date(epoch * 1000);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function formatSourceCount(value?: number | null): string {
  const count = normalizeCount(value);

  if (count === 0) {
    return "";
  }

  return `${count} source${count === 1 ? "" : "s"}`;
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

function joinHint(sessionId: number | undefined, turnPromptNumber: number | undefined): string {
  if (sessionId === undefined && turnPromptNumber === undefined) {
    return "";
  }

  if (sessionId === undefined) {
    return "";
  }

  if (turnPromptNumber === undefined) {
    return `mnemo-replay skill → read S${sessionId}`;
  }

  return `mnemo-replay skill → read S${sessionId}/T${turnPromptNumber}`;
}
function truncateText(
  text: string,
  {
    limit,
    mode = "legacy",
    hintId,
  }: {
    limit: number;
    mode?: RenderMode;
    hintId?: string;
  },
): string {
  const boundedLimit = Math.min(Math.max(limit, 1), MAX_TRUNCATE);

  if (text.length <= boundedLimit) {
    return text;
  }

  return `${text.slice(0, boundedLimit)}${FIELD_TRUNCATION_SUFFIX}${
    mode === "unified" && hintId
      ? ` [use mnemo-replay skill → read ${hintId} for full content]`
      : ""
  }`;
}

function resolveExplicitTruncate(truncate?: number): number {
  return Math.min(Math.max(truncate ?? DEFAULT_TRUNCATE, 1), MAX_TRUNCATE);
}

function buildSessionHintId(sessionId: number): string {
  return `S${sessionId}`;
}

function buildTurnHintId(
  sessionId: number | undefined,
  promptNumber: number,
): string | undefined {
  return sessionId === undefined ? undefined : `S${sessionId}/T${promptNumber}`;
}

function buildObservationHintId(
  observationId: number,
  sessionId?: number,
  turnPromptNumber?: number,
): string | undefined {
  if (sessionId === undefined || turnPromptNumber === undefined) {
    return undefined;
  }

  return `S${sessionId}/T${turnPromptNumber}/O${observationId}`;
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
): string {
  const limit = resolveExplicitTruncate(truncate);
  const stats = formatSessionStats(session);
  const statsSegment = stats ? ` | ${stats}` : "";
  const lines = [
    `- [S${session.id}] ${session.title ?? "Untitled"}${statsSegment} | ${formatEpoch(session.createdAtEpoch)} | ${session.project}`,
  ];

  if (session.content) {
    lines.push(
      `  - desc: ${truncateText(session.content, {
        limit,
        mode,
        hintId: buildSessionHintId(session.id),
      })}`,
    );
  }

  return lines.join("\n");
}

function formatSessionExpandedWithMode(
  session: FormattedSession,
  mode: RenderMode,
  truncate?: number,
): string {
  const limit = resolveExplicitTruncate(truncate);
  const lines = [formatSessionCollapsedWithMode(session, mode, truncate)];

  if (session.insight && session.insight.length > 0) {
    lines.push("  - insight:");
    pushBullets(
      lines,
      "    ",
      session.insight.map((line) =>
        truncateText(line, {
          limit,
          mode,
          hintId: buildSessionHintId(session.id),
        }),
      ),
    );
  }

  if (session.nextSteps) {
    lines.push("  - next_steps:");
    lines.push(
      `    - ${truncateText(session.nextSteps, {
        limit,
        mode,
        hintId: buildSessionHintId(session.id),
      })}`,
    );
  }

  return lines.join("\n");
}

function formatTurnLabel(
  turn: FormattedTurn,
  {
    indent = "  ",
    sessionId,
    mode = "legacy",
    depth = "collapsed",
    truncate,
  }: TurnFormatOptions & { mode?: RenderMode; depth?: RenderDepth } = {},
): string {
  const prefix =
    sessionId === undefined
      ? `${indent}- [T${turn.promptNumber}]`
      : `${indent}- [S${sessionId}][T${turn.promptNumber}]`;
  const stats = formatTurnStats(turn);
  const statsSegment = stats ? ` | ${stats}` : "";
  const rawTitle = turn.title ?? turn.promptPreview ?? "Untitled";
  const limit = resolveExplicitTruncate(truncate);
  const hintId = buildTurnHintId(sessionId, turn.promptNumber);
  const title =
    turn.title === null && turn.promptPreview
      ? `"${truncateText(turn.promptPreview, {
          limit,
          mode,
          hintId,
        })}"`
      : truncateText(rawTitle, {
          limit,
          mode,
          hintId,
        });

  return `${prefix} ${title}${statsSegment}${formatStatus(turn.status)}`;
}

function formatTurnCollapsedWithMode(
  turn: FormattedTurn,
  options: TurnFormatOptions & { mode?: RenderMode } = {},
): string {
  const { indent = "  ", mode = "legacy" } = options;
  const limit = resolveExplicitTruncate(options.truncate);
  const lines = [
    formatTurnLabel(turn, {
      ...options,
      mode,
      depth: "collapsed",
    }),
  ];

  if (turn.content) {
    lines.push(
      `${indent}  - desc: ${truncateText(turn.content, {
        limit,
        mode,
        hintId: buildTurnHintId(options.sessionId, turn.promptNumber),
      })}`,
    );
  }

  return lines.join("\n");
}

function formatToolCallLabel(
  toolCall: FormattedToolCall,
  { indent = "    ", mode = "unified", depth = "collapsed", truncate }: ToolCallFormatOptions & {
    mode?: RenderMode;
    depth?: RenderDepth;
  } = {},
): string {
  const limit = resolveExplicitTruncate(truncate);
  const keyParam = toolCall.keyParam ?? extractKeyParam(toolCall.name, toolCall.input);
  const suffix = keyParam
    ? ` ${truncateText(keyParam, { limit, mode })}`
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
  const { indent = "    ", mode = "unified", depth = "expanded", truncate } = options;
  const limit = resolveExplicitTruncate(truncate);
  const detailIndent = `${indent}  `;
  const hintId = buildTurnHintId(options.sessionId, options.turnPromptNumber ?? 0);
  const lines = [
    formatToolCallLabel(toolCall, {
      ...options,
      mode,
      depth: "expanded",
      truncate,
    }),
  ];

  if (toolCall.input !== undefined) {
    lines.push(
      `${detailIndent}- in: ${truncateText(JSON.stringify(toolCall.input), {
        limit,
        mode,
        hintId,
      })}`,
    );
  }

  if (toolCall.result) {
    lines.push(
      `${detailIndent}- out: ${truncateText(toolCall.result, {
        limit,
        mode,
        hintId,
      })}`,
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

  const { indent = "  ", sessionId, mode = "legacy", truncate } = options;
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
  } = options;
  const detailIndent = `${indent}  `;
  const limit = resolveExplicitTruncate(options.truncate);
  const hintId = buildTurnHintId(options.sessionId, turn.promptNumber);
  const lines = [formatTurnCollapsedWithMode(turn, { ...options, mode })];

  if (turn.promptPreview) {
    lines.push(
      `${detailIndent}- prompt: "${truncateText(
        turn.promptPreview,
        {
          limit,
          mode,
          hintId,
        },
      )}"`,
    );
  }

  if (turn.responsePreview) {
    lines.push(
      `${detailIndent}- response: "${truncateText(
        turn.responsePreview,
        {
          limit,
          mode,
          hintId,
        },
      )}"`,
    );
  }

  if (turn.insight && turn.insight.length > 0) {
    lines.push(`${detailIndent}- insight:`);
    pushBullets(
      lines,
      `${detailIndent}  `,
      turn.insight.map((line) =>
        truncateText(line, {
          limit,
          mode,
          hintId,
        }),
      ),
    );
  }

  if (mode === "unified" && turn.filesRead && turn.filesRead.length > 0) {
    lines.push(
      `${detailIndent}- files_read: ${truncateText(turn.filesRead.join(", "), {
        limit,
        mode,
        hintId,
      })}`,
    );
  }

  if (mode === "unified" && turn.filesModified && turn.filesModified.length > 0) {
    lines.push(
      `${detailIndent}- files_modified: ${truncateText(
        turn.filesModified.join(", "),
        {
          limit,
          mode,
          hintId,
        },
      )}`,
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

function formatMemoryLabel(
  memory: FormattedMemory,
  { includeSourceCount = true }: { includeSourceCount?: boolean } = {},
): string {
  const parts = [
    `- [M${memory.id}] ${memory.type}/${memory.scope}: ${memory.title}`,
    formatEpoch(memory.updatedAtEpoch ?? memory.createdAtEpoch),
  ];
  const sourceCount = includeSourceCount
    ? formatSourceCount(memory.sourceCount)
    : "";

  if (sourceCount) {
    parts.push(sourceCount);
  }

  return parts.join(" | ");
}

function formatMemoryCollapsedWithMode(
  memory: FormattedMemory,
  mode: RenderMode,
): string {
  return formatMemoryLabel(memory);
}

function formatMemoryExpandedWithMode(
  memory: FormattedMemory,
  mode: RenderMode,
  truncate?: number,
): string {
  const limit = resolveExplicitTruncate(truncate);
  const lines = [formatMemoryLabel(memory, { includeSourceCount: false })];

  lines.push(
    `  - content: ${truncateText(memory.content, {
      limit,
      mode,
    })}`,
  );

  if (memory.reasoning) {
    lines.push(
      `  - reasoning: ${truncateText(memory.reasoning, {
        limit,
        mode,
      })}`,
    );
  }

  if (memory.application) {
    lines.push(
      `  - application: ${truncateText(memory.application, {
        limit,
        mode,
      })}`,
    );
  }

  if (memory.tags && memory.tags.length > 0) {
    lines.push(
      `  - tags: [${truncateText(memory.tags.join(", "), {
        limit,
        mode,
      })}]`,
    );
  }

  if (memory.source) {
    lines.push(
      `  - source: [S${memory.source.sessionId}/T${memory.source.promptNumber}] ${
        memory.source.title ?? "Untitled"
      } | ${formatEpoch(memory.source.createdAtEpoch)}`,
    );
  }

  return lines.join("\n");
}

function formatObservationCollapsedWithMode(
  observation: FormattedObservation,
  options: ObservationFormatOptions & { mode?: RenderMode } = {},
): string {
  const { indent = "", mode = "legacy" } = options;
  const limit = resolveExplicitTruncate(options.truncate);
  const lines = [formatObservationLabel(observation, options)];

  if (observation.content) {
    lines.push(
      `${indent}  - desc: ${truncateText(
        observation.content,
        {
          limit,
          mode,
          hintId: buildObservationHintId(
            observation.id,
            options.sessionId,
            options.turnPromptNumber,
          ),
        },
      )}`,
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

  switch (node.type) {
    case "session":
      return options.depth === "collapsed"
        ? formatSessionCollapsedWithMode(node.value, mode, options.truncate)
        : formatSessionExpandedWithMode(node.value, mode, options.truncate);
    case "turn":
      return options.depth === "collapsed"
        ? formatTurnCollapsedWithMode(node.value, { ...options, mode })
        : formatTurnExpandedWithMode(node.value, { ...options, mode });
    case "observation":
      return options.depth === "collapsed"
        ? formatObservationCollapsedWithMode(node.value, { ...options, mode })
        : formatObservationExpandedWithMode(node.value, { ...options, mode });
    case "memory":
      return options.depth === "collapsed"
        ? formatMemoryCollapsedWithMode(node.value, mode)
        : formatMemoryExpandedWithMode(node.value, mode, options.truncate);
    case "toolCall":
      return options.depth === "collapsed"
        ? formatToolCallCollapsedWithMode(node.value, { ...options, mode })
        : formatToolCallExpandedWithMode(node.value, { ...options, mode });
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

export function formatMemoryCollapsed(memory: FormattedMemory): string {
  return renderNode({ type: "memory", value: memory }, { depth: "collapsed", mode: "legacy" });
}

export function formatMemoryExpanded(memory: FormattedMemory): string {
  return renderNode({ type: "memory", value: memory }, { depth: "expanded", mode: "legacy" });
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
