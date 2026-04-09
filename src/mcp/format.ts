export const TYPE_EMOJI: Record<string, string> = {
  bugfix: "🔴",
  feature: "🟣",
  refactor: "🔄",
  change: "✅",
  discovery: "🔵",
  decision: "⚖️",
};

const FIELD_TRUNCATION_SUFFIX = "...";

const LEGACY_TRUNCATION_LIMIT = 200;
const UNIFIED_TRUNCATION_LIMITS = {
  collapsed: 120,
  expanded: 300,
  full: 1000,
} as const;

export type RenderDepth = "collapsed" | "expanded" | "full";

type RenderMode = "legacy" | "unified";

export interface FormattedObservation {
  id: number;
  type: string;
  title: string;
  content?: string | null;
  insight?: string | null;
  tags?: string[];
  filesRead?: string[];
  filesModified?: string[];
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
}

interface ToolCallFormatOptions {
  indent?: string;
  sessionId?: number;
  turnPromptNumber?: number;
}

interface RenderNodeOptions {
  depth: RenderDepth;
  indent?: string;
  sessionId?: number;
  turnPromptNumber?: number;
  mode?: RenderMode;
  includeChildren?: boolean;
}

type RenderNode =
  | { type: "session"; value: FormattedSession }
  | { type: "turn"; value: FormattedTurn }
  | { type: "observation"; value: FormattedObservation }
  | { type: "memory"; value: FormattedMemory }
  | { type: "toolCall"; value: FormattedToolCall };

export interface OmissionResult<T> {
  items: Array<T | { omittedCount: number }>;
  omittedCount: number;
}

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

function typeEmoji(type: string): string {
  return TYPE_EMOJI[type] ?? type;
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
    return `replay(id="S${sessionId}", depth="expanded")`;
  }

  return `replay(id="S${sessionId}/T${turnPromptNumber}", depth="expanded")`;
}

function resolveTruncationLimit(
  depth: RenderDepth,
  mode: RenderMode,
): number {
  if (mode === "legacy") {
    return LEGACY_TRUNCATION_LIMIT;
  }

  return UNIFIED_TRUNCATION_LIMITS[depth];
}

function truncateText(
  text: string,
  {
    depth,
    mode = "legacy",
    sessionId,
    turnPromptNumber,
  }: {
    depth: RenderDepth;
    mode?: RenderMode;
    sessionId?: number;
    turnPromptNumber?: number;
  },
): string {
  const limit = resolveTruncationLimit(depth, mode);

  if (text.length <= limit) {
    return text;
  }

  const hint =
    mode === "legacy" ? joinHint(sessionId, turnPromptNumber) : "";

  return `${text.slice(0, limit)}${FIELD_TRUNCATION_SUFFIX}${
    hint ? ` [use ${hint} for full content]` : ""
  }`;
}

function formatDisplayStatus(status?: string | null): string | null | undefined {
  switch (status) {
    case "extracting_pending":
      return "pending";
    case "extracting_stale":
      return "stale";
    default:
      return status;
  }
}

function formatStatus(status?: string | null): string {
  const displayStatus = formatDisplayStatus(status);
  return displayStatus ? ` [${displayStatus}]` : "";
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
  return Boolean(
    observation.insight ||
      (observation.tags && observation.tags.length > 0) ||
      (observation.filesRead && observation.filesRead.length > 0) ||
      (observation.filesModified && observation.filesModified.length > 0),
  );
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
): string {
  const stats = formatSessionStats(session);
  const statsSegment = stats ? ` | ${stats}` : "";
  const lines = [
    `- [S${session.id}] ${session.title ?? "Untitled"}${statsSegment} | ${formatEpoch(session.createdAtEpoch)} | ${session.project}`,
  ];

  if (session.content) {
    lines.push(
      `  - desc: ${truncateText(session.content, {
        depth: "collapsed",
        mode,
        sessionId: session.id,
      })}`,
    );
  }

  return lines.join("\n");
}

function formatSessionExpandedWithMode(
  session: FormattedSession,
  mode: RenderMode,
): string {
  const lines = [formatSessionCollapsedWithMode(session, mode)];

  if (session.insight && session.insight.length > 0) {
    lines.push("  - insight:");
    pushBullets(
      lines,
      "    ",
      session.insight.map((line) =>
        truncateText(line, {
          depth: "expanded",
          mode,
          sessionId: session.id,
        }),
      ),
    );
  }

  if (session.nextSteps) {
    lines.push("  - next_steps:");
    lines.push(
      `    - ${truncateText(session.nextSteps, {
        depth: "expanded",
        mode,
        sessionId: session.id,
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
  }: TurnFormatOptions & { mode?: RenderMode; depth?: RenderDepth } = {},
): string {
  const prefix =
    sessionId === undefined
      ? `${indent}- [T${turn.promptNumber}]`
      : `${indent}- [S${sessionId}][T${turn.promptNumber}]`;
  const stats = formatTurnStats(turn);
  const statsSegment = stats ? ` | ${stats}` : "";
  const rawTitle = turn.title ?? turn.promptPreview ?? "Untitled";
  const title =
    turn.title === null && turn.promptPreview
      ? `"${truncateText(turn.promptPreview, {
          depth,
          mode,
          sessionId,
          turnPromptNumber: turn.promptNumber,
        })}"`
      : truncateText(rawTitle, {
          depth,
          mode,
          sessionId,
          turnPromptNumber: turn.promptNumber,
        });

  return `${prefix} ${title}${statsSegment}${formatStatus(turn.status)}`;
}

function formatTurnCollapsedWithMode(
  turn: FormattedTurn,
  options: TurnFormatOptions & { mode?: RenderMode } = {},
): string {
  const { indent = "  ", mode = "legacy" } = options;
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
        depth: "collapsed",
        mode,
        sessionId: options.sessionId,
        turnPromptNumber: turn.promptNumber,
      })}`,
    );
  }

  return lines.join("\n");
}

function formatToolCallLabel(
  toolCall: FormattedToolCall,
  { indent = "    ", mode = "unified", depth = "collapsed" }: ToolCallFormatOptions & {
    mode?: RenderMode;
    depth?: RenderDepth;
  } = {},
): string {
  const keyParam = toolCall.keyParam ?? extractKeyParam(toolCall.name, toolCall.input);
  const suffix = keyParam
    ? ` ${truncateText(keyParam, { depth, mode })}`
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
  const { indent = "    ", mode = "unified", depth = "expanded" } = options;
  const detailIndent = `${indent}  `;
  const lines = [
    formatToolCallLabel(toolCall, {
      ...options,
      mode,
      depth: depth === "full" ? "full" : "expanded",
    }),
  ];

  if (toolCall.input !== undefined) {
    lines.push(
      `${detailIndent}- in: ${truncateText(JSON.stringify(toolCall.input), {
        depth,
        mode,
      })}`,
    );
  }

  if (toolCall.result) {
    lines.push(
      `${detailIndent}- out: ${truncateText(toolCall.result, {
        depth,
        mode,
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

  const { indent = "  ", sessionId, mode = "legacy" } = options;
  const childIndent = `${indent}  `;
  const childDepth = depth === "full" ? "full" : "expanded";
  const childLines: string[] = [];

  if (turn.observations && turn.observations.length > 0) {
    for (const observation of turn.observations) {
      childLines.push(
        childDepth === "full"
          ? formatObservationExpandedWithMode(observation, {
              indent: childIndent,
              sessionId,
              turnPromptNumber: turn.promptNumber,
              mode,
              depth: "full",
            })
          : formatObservationCollapsedWithMode(observation, {
              indent: childIndent,
              sessionId,
              turnPromptNumber: turn.promptNumber,
              mode,
            }),
      );
    }

    return childLines.join("\n");
  }

  if (turn.toolCalls && turn.toolCalls.length > 0) {
    for (const toolCall of turn.toolCalls) {
      childLines.push(
        formatToolCallExpandedWithMode(toolCall, {
          indent: childIndent,
          sessionId,
          turnPromptNumber: turn.promptNumber,
          mode,
          depth: childDepth,
        }),
      );
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
  const lines = [formatTurnCollapsedWithMode(turn, { ...options, mode })];

  if (turn.promptPreview) {
    lines.push(
      `${detailIndent}- prompt: "${truncateText(
        turn.promptPreview,
        {
          depth,
          mode,
          sessionId: options.sessionId,
          turnPromptNumber: turn.promptNumber,
        },
      )}"`,
    );
  }

  if (turn.responsePreview) {
    lines.push(
      `${detailIndent}- response: "${truncateText(
        turn.responsePreview,
        {
          depth,
          mode,
          sessionId: options.sessionId,
          turnPromptNumber: turn.promptNumber,
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
          depth,
          mode,
          sessionId: options.sessionId,
          turnPromptNumber: turn.promptNumber,
        }),
      ),
    );
  }

  if (mode === "unified" && turn.filesRead && turn.filesRead.length > 0) {
    lines.push(
      `${detailIndent}- files_read: ${truncateText(turn.filesRead.join(", "), {
        depth,
        mode,
        sessionId: options.sessionId,
        turnPromptNumber: turn.promptNumber,
      })}`,
    );
  }

  if (mode === "unified" && turn.filesModified && turn.filesModified.length > 0) {
    lines.push(
      `${detailIndent}- files_modified: ${truncateText(
        turn.filesModified.join(", "),
        {
          depth,
          mode,
          sessionId: options.sessionId,
          turnPromptNumber: turn.promptNumber,
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
  return `${indent}- [O${observation.id}] ${typeEmoji(observation.type)} ${observation.title}`;
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
): string {
  const lines = [formatMemoryLabel(memory, { includeSourceCount: false })];

  lines.push(
    `  - content: ${truncateText(memory.content, {
      depth: "expanded",
      mode,
    })}`,
  );

  if (memory.reasoning) {
    lines.push(
      `  - reasoning: ${truncateText(memory.reasoning, {
        depth: "expanded",
        mode,
      })}`,
    );
  }

  if (memory.application) {
    lines.push(
      `  - application: ${truncateText(memory.application, {
        depth: "expanded",
        mode,
      })}`,
    );
  }

  if (memory.tags && memory.tags.length > 0) {
    lines.push(
      `  - tags: [${truncateText(memory.tags.join(", "), {
        depth: "expanded",
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
  const lines = [formatObservationLabel(observation, options)];

  if (observation.content) {
    lines.push(
      `${indent}  - desc: ${truncateText(
        observation.content,
        {
          depth: "collapsed",
          mode,
          sessionId: options.sessionId,
          turnPromptNumber: options.turnPromptNumber,
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
  const { indent = "", mode = "legacy", depth = "expanded" } = options;
  const detailIndent = `${indent}  `;
  const lines = [formatObservationCollapsedWithMode(observation, { ...options, mode })];

  if (observation.insight) {
    lines.push(
      `${detailIndent}- insight: ${truncateText(
        observation.insight,
        {
          depth,
          mode,
          sessionId: options.sessionId,
          turnPromptNumber: options.turnPromptNumber,
        },
      )}`,
    );
  }

  if (observation.tags && observation.tags.length > 0) {
    lines.push(
      `${detailIndent}- tags: ${truncateText(
        observation.tags.join(", "),
        {
          depth,
          mode,
          sessionId: options.sessionId,
          turnPromptNumber: options.turnPromptNumber,
        },
      )}`,
    );
  }

  const filesParts: string[] = [];

  if (observation.filesRead && observation.filesRead.length > 0) {
    filesParts.push(`📖 ${truncateText(
      observation.filesRead.join(", "),
      {
        depth,
        mode,
        sessionId: options.sessionId,
        turnPromptNumber: options.turnPromptNumber,
      },
    )}`);
  }

  if (observation.filesModified && observation.filesModified.length > 0) {
    filesParts.push(`✏️ ${truncateText(
      observation.filesModified.join(", "),
      {
        depth,
        mode,
        sessionId: options.sessionId,
        turnPromptNumber: options.turnPromptNumber,
      },
    )}`);
  }

  if (filesParts.length > 0) {
    lines.push(`${detailIndent}- files: ${filesParts.join(" ")}`);
  }

  return lines.join("\n");
}

export function renderNode(node: RenderNode, options: RenderNodeOptions): string {
  const mode = options.mode ?? "unified";

  switch (node.type) {
    case "session":
      return options.depth === "collapsed"
        ? formatSessionCollapsedWithMode(node.value, mode)
        : formatSessionExpandedWithMode(node.value, mode);
    case "turn":
      return options.depth === "collapsed"
        ? formatTurnCollapsedWithMode(node.value, options)
        : formatTurnExpandedWithMode(node.value, options);
    case "observation":
      return options.depth === "collapsed"
        ? formatObservationCollapsedWithMode(node.value, options)
        : formatObservationExpandedWithMode(node.value, options);
    case "memory":
      return options.depth === "collapsed"
        ? formatMemoryCollapsedWithMode(node.value, mode)
        : formatMemoryExpandedWithMode(node.value, mode);
    case "toolCall":
      return options.depth === "collapsed"
        ? formatToolCallCollapsedWithMode(node.value, options)
        : formatToolCallExpandedWithMode(node.value, options);
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

export function sampleWithOmissions<T>(
  items: T[],
  isProtected: (item: T, index: number) => boolean = () => false,
): OmissionResult<T> {
  if (items.length <= 50) {
    return { items: [...items], omittedCount: 0 };
  }

  const visibleIndexes = new Set<number>();
  const headCount = Math.min(5, items.length);
  const tailCount = Math.min(10, items.length - headCount);

  for (let index = 0; index < headCount; index += 1) {
    visibleIndexes.add(index);
  }

  for (let index = items.length - tailCount; index < items.length; index += 1) {
    if (index >= 0) {
      visibleIndexes.add(index);
    }
  }

  const middleStart = headCount;
  const middleEnd = Math.max(headCount, items.length - tailCount);
  const middleLength = middleEnd - middleStart;

  if (middleLength > 0) {
    const sampleTargets = new Set<number>();

    for (let sampleIndex = 0; sampleIndex < 5; sampleIndex += 1) {
      const position = Math.round(
        (sampleIndex * Math.max(middleLength - 1, 0)) / Math.max(5 - 1, 1),
      );
      sampleTargets.add(middleStart + Math.min(position, middleLength - 1));
    }

    for (const index of sampleTargets) {
      visibleIndexes.add(index);
    }
  }

  items.forEach((item, index) => {
    if (isProtected(item, index)) {
      visibleIndexes.add(index);
    }
  });

  const orderedItems: Array<T | { omittedCount: number }> = [];
  let omittedCount = 0;
  let gapStart: number | null = null;

  for (let index = 0; index < items.length; index += 1) {
    if (visibleIndexes.has(index)) {
      if (gapStart !== null) {
        orderedItems.push({ omittedCount: index - gapStart });
        gapStart = null;
      }

      orderedItems.push(items[index]!);
    } else {
      omittedCount += 1;
      if (gapStart === null) {
        gapStart = index;
      }
    }
  }

  if (gapStart !== null) {
    orderedItems.push({ omittedCount: items.length - gapStart });
  }

  return { items: orderedItems, omittedCount };
}

export function formatTree(sessions: FormattedSession[]): string {
  const lines: string[] = [];

  for (const session of sessions) {
    lines.push(formatSessionExpanded(session));

    const turnsResult = sampleWithOmissions(session.turns ?? []);
    for (const entry of turnsResult.items) {
      if ("omittedCount" in entry) {
        lines.push(`  - ... ${entry.omittedCount} omitted ...`);
        continue;
      }

      const turnLine = isTurnExpanded(entry)
        ? formatTurnExpanded(entry, { sessionId: session.id })
        : formatTurnCollapsed(entry, { sessionId: session.id });
      lines.push(turnLine);

      const observationsResult = sampleWithOmissions(
        entry.observations ?? [],
        (observation) => Boolean(observation),
      );

      for (const observationEntry of observationsResult.items) {
        if ("omittedCount" in observationEntry) {
          lines.push(`    - ... ${observationEntry.omittedCount} omitted ...`);
          continue;
        }

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
    }
  }

  return lines.join("\n");
}
