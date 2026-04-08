import type { Database } from "bun:sqlite";

import { createMemory, updateMemory } from "../db/memories";
import { createObservation } from "../db/observations";
import { getSession, upsertSession } from "../db/sessions";
import { getPendingTurns, getTurn, getTurnsForSession, saveTurn } from "../db/turns";

type ToolTextResult = {
  content: Array<{
    type: "text";
    text: string;
  }>;
};

type RememberStatus = "skipped" | "undone" | "active" | "superseded" | "archived";

const TURN_REMEMBER_STATUSES = ["skipped", "undone"] as const;
const MEMORY_REMEMBER_STATUSES = ["active", "superseded", "archived"] as const;

export interface RememberToolInput {
  parent?: string;
  id?: string;
  type?: string;
  scope?: string;
  prompt_number?: number;
  title?: string;
  content?: string;
  insight?: string;
  reasoning?: string;
  application?: string;
  tags?: string[];
  status?: RememberStatus;
  next_steps?: string;
  files_read?: string[];
  files_modified?: string[];
  source_turn_id?: number;
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

function parseMemoryId(value: string): number | null {
  const match = /^M(\d+)$/i.exec(value.trim());
  return match ? Number.parseInt(match[1]!, 10) : null;
}

function parseTurnParent(value: string): { sessionId: number; promptNumber: number } | null {
  const match = /^S(\d+)\/T(\d+)$/i.exec(value.trim());

  if (!match) {
    return null;
  }

  return {
    sessionId: Number.parseInt(match[1]!, 10),
    promptNumber: Number.parseInt(match[2]!, 10),
  };
}

function validateStatusForRoute(
  status: RememberStatus | undefined,
  allowedStatuses: readonly RememberStatus[] | null,
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

function resolveNextPromptNumber(db: Database, sessionId: number): number {
  const pendingTurns = getPendingTurns(db, sessionId);

  if (pendingTurns.length > 0) {
    return pendingTurns[0]!.promptNumber;
  }

  const existingTurns = getTurnsForSession(db, sessionId);

  if (existingTurns.length === 0) {
    return 1;
  }

  return Math.max(...existingTurns.map((turn) => turn.promptNumber)) + 1;
}

function handleTurnRemember(
  db: Database,
  sessionId: number,
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

  if (!getSession(db, sessionId)) {
    return textResult(`Session ${sessionId} not found.`);
  }

  const promptNumber = input.prompt_number ?? resolveNextPromptNumber(db, sessionId);
  const isSkipped = input.status === "skipped";
  const turn = saveTurn(db, {
    sessionId,
    promptNumber,
    status: input.status === "undone" ? "undone" : undefined,
    userPrompt: null,
    assistantResponse: null,
    title: isSkipped ? null : input.title ?? null,
    content: isSkipped ? null : input.content ?? null,
    insight: isSkipped ? null : input.insight ?? null,
    filesRead: isSkipped ? [] : input.files_read ?? [],
    filesModified: isSkipped ? [] : input.files_modified ?? [],
    createdAtEpoch: Math.floor(Date.now() / 1000),
    updatedAtEpoch: null,
    observations: [],
  });

  return textResult(`Saved turn #${turn.promptNumber} with status ${turn.status}.`);
}

function handleObservationRemember(
  db: Database,
  parent: { sessionId: number; promptNumber: number },
  input: RememberToolInput,
): ToolTextResult {
  const statusError = validateStatusForRoute(
    input.status,
    null,
    "observation remember",
  );

  if (statusError) {
    return parameterError(statusError);
  }

  const turn = getTurn(db, parent.sessionId, parent.promptNumber);

  if (!turn) {
    return textResult(`Turn S${parent.sessionId}/T${parent.promptNumber} not found.`);
  }

  const observation = createObservation(db, {
    turnId: turn.id,
    type: input.type ?? "discovery",
    title: input.title ?? "Untitled observation",
    content: input.content ?? null,
    insight: input.insight ?? null,
    tags: input.tags ?? [],
    filesRead: input.files_read ?? [],
    filesModified: input.files_modified ?? [],
    createdAtEpoch: Math.floor(Date.now() / 1000),
  });

  return textResult(`Saved observation O${observation.id} for S${parent.sessionId}/T${parent.promptNumber}.`);
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
    sourceTurnId: input.source_turn_id ?? null,
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
    sourceTurnId: input.source_turn_id,
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

  upsertSession(db, {
    contentSessionId: session.contentSessionId,
    project: session.project,
    title: input.title ?? session.title,
    content: input.content ?? session.content,
    insight: input.insight ?? session.insight,
    nextSteps: input.next_steps ?? session.nextSteps,
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
  if (input.parent) {
    const turnParent = parseTurnParent(input.parent);

    if (turnParent) {
      return handleObservationRemember(db, turnParent, input);
    }

    const sessionId = parseSessionId(input.parent);

    if (sessionId !== null) {
      return handleTurnRemember(db, sessionId, input);
    }

    return textResult(`Unsupported parent selector: ${input.parent}`);
  }

  if (input.id) {
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

  return handleMemoryCreate(db, input);
}
