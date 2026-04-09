export const TYPE_EMOJI: Record<string, string> = {
  bugfix: "🔴",
  feature: "🟣",
  refactor: "🔄",
  change: "✅",
  discovery: "🔵",
  decision: "⚖️",
};

const FIELD_TRUNCATION_LIMIT = 200;
const FIELD_TRUNCATION_SUFFIX = "...";

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
    return `replay(turn=${turnPromptNumber})`;
  }

  if (turnPromptNumber === undefined) {
    return `replay(session=${sessionId})`;
  }

  return `replay(session=${sessionId}, turn=${turnPromptNumber})`;
}

function truncateText(
  text: string,
  sessionId?: number,
  turnPromptNumber?: number,
): string {
  if (text.length <= FIELD_TRUNCATION_LIMIT) {
    return text;
  }

  const hint = joinHint(sessionId, turnPromptNumber);

  return `${text.slice(0, FIELD_TRUNCATION_LIMIT)}${FIELD_TRUNCATION_SUFFIX}${
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
      (turn.observations && turn.observations.length > 0),
  );
}

export function formatSessionCollapsed(session: FormattedSession): string {
  const stats = formatSessionStats(session);
  const statsSegment = stats ? ` | ${stats}` : "";
  const lines = [
    `- [S${session.id}] ${session.title ?? "Untitled"}${statsSegment} | ${formatEpoch(session.createdAtEpoch)} | ${session.project}`,
  ];

  if (session.content) {
    lines.push(`  - desc: ${truncateText(session.content, session.id)}`);
  }

  return lines.join("\n");
}

export function formatSessionExpanded(session: FormattedSession): string {
  const lines = [formatSessionCollapsed(session)];

  if (session.insight && session.insight.length > 0) {
    lines.push("  - insight:");
    pushBullets(
      lines,
      "    ",
      session.insight.map((line) => truncateText(line, session.id)),
    );
  }

  if (session.nextSteps) {
    lines.push("  - next_steps:");
    lines.push(`    - ${truncateText(session.nextSteps, session.id)}`);
  }

  return lines.join("\n");
}

function formatTurnLabel(
  turn: FormattedTurn,
  { indent = "  ", sessionId }: TurnFormatOptions = {},
): string {
  const prefix =
    sessionId === undefined
      ? `${indent}- [T${turn.promptNumber}]`
      : `${indent}- [S${sessionId}][T${turn.promptNumber}]`;
  const stats = formatTurnStats(turn);
  const statsSegment = stats ? ` | ${stats}` : "";

  return `${prefix} ${turn.title ?? "Untitled"}${statsSegment}${formatStatus(turn.status)}`;
}

export function formatTurnCollapsed(
  turn: FormattedTurn,
  options: TurnFormatOptions = {},
): string {
  const { indent = "  " } = options;
  const lines = [formatTurnLabel(turn, options)];

  if (turn.content) {
    lines.push(
      `${indent}  - desc: ${truncateText(turn.content, options.sessionId, turn.promptNumber)}`,
    );
  }

  return lines.join("\n");
}

export function formatTurnExpanded(
  turn: FormattedTurn,
  options: TurnFormatOptions = {},
): string {
  const { indent = "  " } = options;
  const detailIndent = `${indent}  `;
  const lines = [formatTurnCollapsed(turn, options)];

  if (turn.promptPreview) {
    lines.push(
      `${detailIndent}- prompt: "${truncateText(
        turn.promptPreview,
        options.sessionId,
        turn.promptNumber,
      )}"`,
    );
  }

  if (turn.responsePreview) {
    lines.push(
      `${detailIndent}- response: "${truncateText(
        turn.responsePreview,
        options.sessionId,
        turn.promptNumber,
      )}"`,
    );
  }

  if (turn.insight && turn.insight.length > 0) {
    lines.push(`${detailIndent}- insight:`);
    pushBullets(
      lines,
      `${detailIndent}  `,
      turn.insight.map((line) =>
        truncateText(line, options.sessionId, turn.promptNumber),
      ),
    );
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

export function formatMemoryCollapsed(memory: FormattedMemory): string {
  return formatMemoryLabel(memory);
}

export function formatMemoryExpanded(memory: FormattedMemory): string {
  const lines = [formatMemoryLabel(memory, { includeSourceCount: false })];

  lines.push(`  - content: ${memory.content}`);

  if (memory.reasoning) {
    lines.push(`  - reasoning: ${memory.reasoning}`);
  }

  if (memory.application) {
    lines.push(`  - application: ${memory.application}`);
  }

  if (memory.tags && memory.tags.length > 0) {
    lines.push(`  - tags: [${memory.tags.join(", ")}]`);
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

export function formatObservationCollapsed(
  observation: FormattedObservation,
  options: ObservationFormatOptions = {},
): string {
  const { indent = "" } = options;
  const lines = [formatObservationLabel(observation, options)];

  if (observation.content) {
    lines.push(
      `${indent}  - desc: ${truncateText(
        observation.content,
        options.sessionId,
        options.turnPromptNumber,
      )}`,
    );
  }

  return lines.join("\n");
}

export function formatObservationExpanded(
  observation: FormattedObservation,
  options: ObservationFormatOptions = {},
): string {
  const { indent = "" } = options;
  const detailIndent = `${indent}  `;
  const lines = [formatObservationCollapsed(observation, options)];

  if (observation.insight) {
    lines.push(
      `${detailIndent}- insight: ${truncateText(
        observation.insight,
        options.sessionId,
        options.turnPromptNumber,
      )}`,
    );
  }

  if (observation.tags && observation.tags.length > 0) {
    lines.push(
      `${detailIndent}- tags: ${truncateText(
        observation.tags.join(", "),
        options.sessionId,
        options.turnPromptNumber,
      )}`,
    );
  }

  const filesParts: string[] = [];

  if (observation.filesRead && observation.filesRead.length > 0) {
    filesParts.push(`📖 ${truncateText(
      observation.filesRead.join(", "),
      options.sessionId,
      options.turnPromptNumber,
    )}`);
  }

  if (observation.filesModified && observation.filesModified.length > 0) {
    filesParts.push(`✏️ ${truncateText(
      observation.filesModified.join(", "),
      options.sessionId,
      options.turnPromptNumber,
    )}`);
  }

  if (filesParts.length > 0) {
    lines.push(`${detailIndent}- files: ${filesParts.join(" ")}`);
  }

  return lines.join("\n");
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
