import type { Database } from "bun:sqlite";

import { createMemory, updateMemory } from "../db/memories";
import { updateObservation } from "../db/observations";
import { getSession, upsertSession } from "../db/sessions";
import { getTurnById, updateTurnById } from "../db/turns";

type ToolTextResult = {
  content: Array<{
    type: "text";
    text: string;
  }>;
};

type RememberStatus =
  | "pending"
  | "extracted"
  | "skipped"
  | "undone"
  | "active"
  | "superseded"
  | "archived";

type ObservationStatus = "pending" | "extracted" | "skipped";
type TurnStatus = "active" | "extracted" | "skipped" | "undone";

const TURN_REMEMBER_STATUSES = ["skipped", "undone", "active"] as const;
const OBSERVATION_REMEMBER_STATUSES = [
  "pending",
  "extracted",
  "skipped",
] as const;
const MEMORY_REMEMBER_STATUSES = ["active", "superseded", "archived"] as const;

export interface RememberToolInput {
  id?: string;
  type?: string;
  scope?: string;
  title?: string;
  content?: string;
  insight?: string;
  reasoning?: string;
  application?: string;
  tags?: string[];
  status?: RememberStatus;
  next_steps?: string;
  source?: string;
}

function textResult(text: string): ToolTextResult {
  return {
    content: [{ type: "text", text }],
  };
}

function parameterError(message: string): ToolTextResult {
  return textResult(`Parameter error: ${message}`);
}

function parseSessionId(value: string): number | null {
  const match = /^S(\d+)$/i.exec(value.trim());
  return match ? Number.parseInt(match[1]!, 10) : null;
}

function parseTurnId(value: string): number | null {
  const match = /^T(\d+)$/i.exec(value.trim());
  return match ? Number.parseInt(match[1]!, 10) : null;
}

function parseObservationId(value: string): number | null {
  const match = /^O(\d+)$/i.exec(value.trim());
  return match ? Number.parseInt(match[1]!, 10) : null;
}

function parseMemoryId(value: string): number | null {
  const match = /^M(\d+)$/i.exec(value.trim());
  return match ? Number.parseInt(match[1]!, 10) : null;
}

function parseTurnSource(value: string | undefined): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  return parseTurnId(value);
}

function validateStatusForRoute(
  status: string | undefined,
  allowedStatuses: readonly string[] | null,
  routeLabel: string,
): string | null {
  if (status === undefined) {
    return null;
  }

  if (allowedStatuses === null) {
    return `${routeLabel} does not accept a status field.`;
  }

  if (!allowedStatuses.includes(status)) {
    const allowedText = allowedStatuses.map((value) => `"${value}"`).join(", ");
    return `status "${status}" is not valid for ${routeLabel}. Allowed: ${allowedText}.`;
  }

  return null;
}

function deriveTurnStatus(input: RememberToolInput): TurnStatus {
  if (input.status === "undone") {
    return "undone";
  }

  if (input.status === "skipped") {
    return "skipped";
  }

  if (input.status === "active") {
    return "active";
  }

  return input.title || input.content || input.insight || input.type || (input.tags?.length ?? 0) > 0
    ? "extracted"
    : "skipped";
}

function deriveObservationStatus(input: RememberToolInput): ObservationStatus {
  if (input.status === "pending" || input.status === "extracted" || input.status === "skipped") {
    return input.status;
  }

  return input.title || input.content ? "extracted" : "skipped";
}

function handleTurnRemember(
  db: Database,
  turnId: number,
  input: RememberToolInput,
): ToolTextResult {
  const statusError = validateStatusForRoute(
    input.status,
    TURN_REMEMBER_STATUSES,
    "turn remember",
  );

  if (statusError) {
    return parameterError(statusError);
  }

  const turn = updateTurnById(db, turnId, {
    status: deriveTurnStatus(input),
    title: input.title ?? null,
    content: input.content ?? null,
    insight: input.insight ?? null,
    type: input.type ?? null,
    tags: input.tags ?? [],
    updatedAtEpoch: Math.floor(Date.now() / 1000),
  });

  if (!turn) {
    return textResult(`Turn T${turnId} not found.`);
  }

  return textResult(`Updated turn T${turnId} with status ${turn.status}.`);
}

function handleObservationRemember(
  db: Database,
  observationId: number,
  input: RememberToolInput,
): ToolTextResult {
  const statusError = validateStatusForRoute(
    input.status,
    OBSERVATION_REMEMBER_STATUSES,
    "observation remember",
  );

  if (statusError) {
    return parameterError(statusError);
  }

  if (
    input.type !== undefined ||
    input.scope !== undefined ||
    input.insight !== undefined ||
    input.reasoning !== undefined ||
    input.application !== undefined ||
    input.tags !== undefined ||
    input.next_steps !== undefined ||
    input.source !== undefined
  ) {
    return parameterError(
      "observation remember only accepts title, content, and status.",
    );
  }

  const observation = updateObservation(db, observationId, {
    title: input.title,
    content: input.content,
    status: deriveObservationStatus(input),
  });

  if (!observation) {
    return textResult(`Observation O${observationId} not found.`);
  }

  return textResult(`Updated observation O${observationId} with status ${observation.status}.`);
}

function handleMemoryCreate(db: Database, input: RememberToolInput): ToolTextResult {
  const statusError = validateStatusForRoute(
    input.status,
    MEMORY_REMEMBER_STATUSES,
    "memory remember",
  );

  if (statusError) {
    return parameterError(statusError);
  }

  if (!input.type || !input.scope || !input.title || !input.content) {
    return textResult("Memory creation requires type, scope, title, and content.");
  }

  const sourceTurnId = parseTurnSource(input.source);

  if (input.source !== undefined && sourceTurnId === null) {
    return parameterError('source must be a turn id like "T12".');
  }

  const memory = createMemory(db, {
    type: input.type,
    scope: input.scope,
    title: input.title,
    content: input.content,
    reasoning: input.reasoning ?? null,
    application: input.application ?? null,
    tags: input.tags ?? [],
    status:
      input.status === "active" ||
      input.status === "superseded" ||
      input.status === "archived"
        ? input.status
        : "active",
    supersededBy: null,
    sourceTurnId: sourceTurnId ?? null,
    createdAtEpoch: Math.floor(Date.now() / 1000),
    updatedAtEpoch: null,
  });

  return textResult(`Created memory M${memory.id}.`);
}

function handleMemoryUpdate(
  db: Database,
  memoryId: number,
  input: RememberToolInput,
): ToolTextResult {
  const statusError = validateStatusForRoute(
    input.status,
    MEMORY_REMEMBER_STATUSES,
    "memory remember",
  );

  if (statusError) {
    return parameterError(statusError);
  }

  const sourceTurnId = parseTurnSource(input.source);

  if (input.source !== undefined && sourceTurnId === null) {
    return parameterError('source must be a turn id like "T12".');
  }

  const memory = updateMemory(db, memoryId, {
    type: input.type,
    scope: input.scope,
    title: input.title,
    content: input.content,
    reasoning: input.reasoning,
    application: input.application,
    tags: input.tags,
    status:
      input.status === "active" ||
      input.status === "superseded" ||
      input.status === "archived"
        ? input.status
        : undefined,
    ...(sourceTurnId !== undefined ? { sourceTurnId } : {}),
    updatedAtEpoch: Math.floor(Date.now() / 1000),
  });

  if (!memory) {
    return textResult(`Memory M${memoryId} not found.`);
  }

  return textResult(`Updated memory M${memory.id}.`);
}

function handleSessionRemember(
  db: Database,
  sessionId: number,
  input: RememberToolInput,
): ToolTextResult {
  const statusError = validateStatusForRoute(input.status, null, "session remember");

  if (statusError) {
    return parameterError(statusError);
  }

  const session = getSession(db, sessionId);

  if (!session) {
    return textResult(`Session ${sessionId} not found.`);
  }

  const nextTitle = input.title ?? session.title;
  const nextContent = input.content ?? session.content;
  const nextInsight = input.insight ?? session.insight;
  const nextNextSteps = input.next_steps ?? session.nextSteps;
  const summaryChanged =
    nextTitle !== session.title ||
    nextContent !== session.content ||
    nextInsight !== session.insight ||
    nextNextSteps !== session.nextSteps;

  upsertSession(db, {
    contentSessionId: session.contentSessionId,
    project: session.project,
    title: nextTitle,
    content: nextContent,
    insight: nextInsight,
    nextSteps: nextNextSteps,
    summaryUpdatedAtEpoch: summaryChanged
      ? Math.floor(Date.now() / 1000)
      : session.summaryUpdatedAtEpoch,
    createdAtEpoch: session.createdAtEpoch,
    updatedAtEpoch: Math.floor(Date.now() / 1000),
    completedAtEpoch: session.completedAtEpoch,
  });

  return textResult(`Updated session ${sessionId}.`);
}

export function rememberTool(
  db: Database,
  input: RememberToolInput,
): ToolTextResult {
  if (!input.id) {
    return handleMemoryCreate(db, input);
  }

  const observationId = parseObservationId(input.id);

  if (observationId !== null) {
    return handleObservationRemember(db, observationId, input);
  }

  const turnId = parseTurnId(input.id);

  if (turnId !== null) {
    return handleTurnRemember(db, turnId, input);
  }

  const sessionId = parseSessionId(input.id);

  if (sessionId !== null) {
    return handleSessionRemember(db, sessionId, input);
  }

  const memoryId = parseMemoryId(input.id);

  if (memoryId !== null) {
    return handleMemoryUpdate(db, memoryId, input);
  }

  return textResult(`Unsupported id selector: ${input.id}`);
}
