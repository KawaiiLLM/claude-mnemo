export const TYPE_EMOJI: Record<string, string> = {
  bugfix: "🔴",
  feature: "🟣",
  refactor: "🔄",
  change: "✅",
  discovery: "🔵",
  decision: "⚖️",
};

export interface FormattedObservation {
  id: number;
  type: string;
  title: string;
  description?: string | null;
  narrative?: string | null;
  facts?: string[];
  concepts?: string[];
  filesRead?: string[];
  filesModified?: string[];
}

interface ObservationFormatOptions {
  indent?: string;
}

export interface FormattedTurn {
  id: number;
  promptNumber: number;
  title: string | null;
  description?: string | null;
  observationCount?: number | null;
  toolCallCount?: number | null;
  filesReadCount?: number | null;
  filesModifiedCount?: number | null;
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
  startedAtEpoch: number;
  description?: string | null;
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

function formatEpoch(epoch: number): string {
  const date = new Date(epoch * 1000);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
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

function isObservationExpanded(observation: FormattedObservation): boolean {
  return Boolean(
    observation.narrative ||
      (observation.facts && observation.facts.length > 0) ||
      (observation.concepts && observation.concepts.length > 0) ||
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
    `- [S${session.id}] ${session.title ?? "Untitled"}${statsSegment} | ${formatEpoch(session.startedAtEpoch)} | ${session.project}`,
  ];

  if (session.description) {
    lines.push(`  - desc: ${session.description}`);
  }

  return lines.join("\n");
}

export function formatSessionExpanded(session: FormattedSession): string {
  const lines = [formatSessionCollapsed(session)];

  if (session.insight && session.insight.length > 0) {
    lines.push("  - insight:");
    pushBullets(lines, "    ", session.insight);
  }

  if (session.nextSteps) {
    lines.push("  - next_steps:");
    lines.push(`    - ${session.nextSteps}`);
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

  return `${prefix} ${turn.title ?? "Untitled"}${statsSegment}`;
}

export function formatTurnCollapsed(
  turn: FormattedTurn,
  options: TurnFormatOptions = {},
): string {
  const { indent = "  " } = options;
  const lines = [formatTurnLabel(turn, options)];

  if (turn.description) {
    lines.push(`${indent}  - desc: ${turn.description}`);
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
    lines.push(`${detailIndent}- prompt: "${turn.promptPreview}"`);
  }

  if (turn.responsePreview) {
    lines.push(`${detailIndent}- response: "${turn.responsePreview}"`);
  }

  if (turn.insight && turn.insight.length > 0) {
    lines.push(`${detailIndent}- insight:`);
    pushBullets(lines, `${detailIndent}  `, turn.insight);
  }

  return lines.join("\n");
}

function formatObservationLabel(
  observation: FormattedObservation,
  { indent = "" }: ObservationFormatOptions = {},
): string {
  return `${indent}- [O${observation.id}] ${typeEmoji(observation.type)} ${observation.title}`;
}

export function formatObservationCollapsed(
  observation: FormattedObservation,
  options: ObservationFormatOptions = {},
): string {
  const { indent = "" } = options;
  const lines = [formatObservationLabel(observation, options)];

  if (observation.description) {
    lines.push(`${indent}  - desc: ${observation.description}`);
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

  if (observation.narrative) {
    lines.push(`${detailIndent}- narrative: ${observation.narrative}`);
  }

  if (observation.facts && observation.facts.length > 0) {
    lines.push(`${detailIndent}- facts:`);
    pushBullets(lines, `${detailIndent}  `, observation.facts);
  }

  if (observation.concepts && observation.concepts.length > 0) {
    lines.push(`${detailIndent}- concepts: ${observation.concepts.join(", ")}`);
  }

  const filesParts: string[] = [];

  if (observation.filesRead && observation.filesRead.length > 0) {
    filesParts.push(`📖 ${observation.filesRead.join(", ")}`);
  }

  if (observation.filesModified && observation.filesModified.length > 0) {
    filesParts.push(`✏️ ${observation.filesModified.join(", ")}`);
  }

  if (filesParts.length > 0) {
    lines.push(`${detailIndent}- files: ${filesParts.join(" ")}`);
  }

  return lines.join("\n");
}

export function formatTree(sessions: FormattedSession[]): string {
  const lines: string[] = [];

  for (const session of sessions) {
    lines.push(formatSessionExpanded(session));

    for (const turn of session.turns ?? []) {
      lines.push(isTurnExpanded(turn) ? formatTurnExpanded(turn) : formatTurnCollapsed(turn));

      for (const observation of turn.observations ?? []) {
        lines.push(
          isObservationExpanded(observation)
            ? formatObservationExpanded(observation, { indent: "    " })
            : formatObservationCollapsed(observation, { indent: "    " }),
        );
      }
    }
  }

  return lines.join("\n");
}
