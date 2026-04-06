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

export interface FormattedTurn {
  id: number;
  promptNumber: number;
  title: string | null;
  observationCount: number;
  promptPreview?: string | null;
  responsePreview?: string | null;
  description?: string | null;
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
  turns?: FormattedTurn[];
}

interface TurnFormatOptions {
  indent?: string;
  sessionId?: number;
}

function formatEpoch(epoch: number): string {
  const date = new Date(epoch * 1000);
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");

  return `${month}-${day} ${hour}:${minute}`;
}

function formatFiles(
  filesRead: string[] = [],
  filesModified: string[] = [],
  indent: string,
): string[] {
  const parts: string[] = [];

  if (filesRead.length > 0) {
    parts.push(`[R] ${filesRead.join(", ")}`);
  }

  if (filesModified.length > 0) {
    parts.push(`[M] ${filesModified.join(", ")}`);
  }

  if (parts.length === 0) {
    return [];
  }

  return [`${indent}files: ${parts.join(" ")}`];
}

function pushInsight(lines: string[], insight: string[] | undefined, indent: string): void {
  if (!insight || insight.length === 0) {
    return;
  }

  lines.push(`${indent}insight:`);

  for (const bullet of insight) {
    lines.push(`${indent}- ${bullet}`);
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
      turn.description ||
      (turn.insight && turn.insight.length > 0) ||
      (turn.filesRead && turn.filesRead.length > 0) ||
      (turn.filesModified && turn.filesModified.length > 0) ||
      (turn.observations && turn.observations.length > 0),
  );
}

export function formatSessionCollapsed(session: FormattedSession): string {
  return `[S${session.id}] ${session.title ?? "Untitled"} | ${formatEpoch(session.startedAtEpoch)} | ${session.project}`;
}

export function formatSessionExpanded(session: FormattedSession): string {
  const lines = [formatSessionCollapsed(session)];

  if (session.description) {
    lines.push(`  description: ${session.description}`);
  }

  pushInsight(lines, session.insight, "  ");

  return lines.join("\n");
}

function formatTurnLabel(
  turn: FormattedTurn,
  { indent = "  ", sessionId }: TurnFormatOptions = {},
): string {
  const prefix =
    sessionId === undefined
      ? `${indent}[T${turn.promptNumber}]`
      : `${indent}[S${sessionId}][T${turn.promptNumber}]`;

  return `${prefix} ${turn.title ?? "Untitled"} | ${turn.observationCount} obs`;
}

export function formatTurnCollapsed(
  turn: FormattedTurn,
  options: TurnFormatOptions = {},
): string {
  return formatTurnLabel(turn, options);
}

export function formatTurnExpanded(
  turn: FormattedTurn,
  options: TurnFormatOptions = {},
): string {
  const { indent = "  " } = options;
  const detailIndent = `${indent}  `;
  const lines = [formatTurnCollapsed(turn, options)];

  if (turn.promptPreview) {
    lines.push(`${detailIndent}prompt: "${turn.promptPreview}"`);
  }

  if (turn.responsePreview) {
    lines.push(`${detailIndent}response: "${turn.responsePreview}"`);
  }

  if (turn.description) {
    lines.push(`${detailIndent}description: ${turn.description}`);
  }

  pushInsight(lines, turn.insight, detailIndent);
  lines.push(...formatFiles(turn.filesRead, turn.filesModified, detailIndent));

  return lines.join("\n");
}

export function formatObservationCollapsed(
  observation: FormattedObservation,
): string {
  const suffix = observation.description ? ` — ${observation.description}` : "";

  return `    [O${observation.id}] ${observation.type}: ${observation.title}${suffix}`;
}

export function formatObservationExpanded(
  observation: FormattedObservation,
): string {
  const lines = [formatObservationCollapsed(observation)];

  if (observation.narrative) {
    lines.push(`      narrative: ${observation.narrative}`);
  }

  if (observation.facts && observation.facts.length > 0) {
    lines.push(`      facts: ${observation.facts.join("; ")}`);
  }

  if (observation.concepts && observation.concepts.length > 0) {
    lines.push(`      concepts: ${observation.concepts.join(", ")}`);
  }

  lines.push(
    ...formatFiles(observation.filesRead, observation.filesModified, "      "),
  );

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
            ? formatObservationExpanded(observation)
            : formatObservationCollapsed(observation),
        );
      }
    }
  }

  return lines.join("\n");
}
