import type { Database } from "bun:sqlite";

import { createMemory, updateMemory } from "../db/memories";
import { createObservation } from "../db/observations";
import { getSession } from "../db/sessions";
import {
  getPendingTurns,
  getTurn,
  getTurnsForSession,
  saveTurn,
} from "../db/turns";
import { updateSessionTool } from "./update-session";

type ToolTextResult = {
  content: Array<{
    type: "text";
    text: string;
  }>;
};

type RememberStatus = "skipped" | "undone" | "active" | "superseded" | "archived";

export interface RememberToolInput {
  parent?: string;
  id?: string;
  type?: string;
  scope?: string;
  title?: string;
  content?: string;
  description?: string;
  insight?: string;
  reasoning?: string;
  application?: string;
  tags?: string[];
  status?: RememberStatus;
  next_steps?: string;
  user_prompt?: string;
  assistant_response?: string;
  files_read?: string[];
  files_modified?: string[];
  source_turn_id?: number;
  created_at_epoch?: number;
  updated_at_epoch?: number;
  completed_at_epoch?: number;
  expires_at_epoch?: number;
}

function textResult(text: string): ToolTextResult {
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
  };
}

function parseSessionId(value: string): number | null {
  const match = /^S(\d+)$/.exec(value.trim());
  return match ? Number.parseInt(match[1]!, 10) : null;
}

function parseMemoryId(value: string): number | null {
  const match = /^M(\d+)$/.exec(value.trim());
  return match ? Number.parseInt(match[1]!, 10) : null;
}

function parseTurnParent(value: string): { sessionId: number; promptNumber: number } | null {
  const match = /^S(\d+)\/T(\d+)$/.exec(value.trim());

  if (!match) {
    return null;
  }

  return {
    sessionId: Number.parseInt(match[1]!, 10),
    promptNumber: Number.parseInt(match[2]!, 10),
  };
}

function resolveContent(input: Pick<RememberToolInput, "content" | "description">): string | null {
  return input.content ?? input.description ?? null;
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
  if (!getSession(db, sessionId)) {
    return textResult(`Session ${sessionId} not found.`);
  }

  const promptNumber = resolveNextPromptNumber(db, sessionId);
  const content = input.status === "skipped" ? null : resolveContent(input);
  const turn = saveTurn(db, {
    sessionId,
    promptNumber,
    status: input.status === "undone" ? "undone" : undefined,
    userPrompt: input.user_prompt ?? null,
    assistantResponse: input.assistant_response ?? null,
    title: input.status === "skipped" ? null : input.title ?? null,
    content,
    description: content,
    insight: input.status === "skipped" ? null : input.insight ?? null,
    filesRead: input.status === "skipped" ? [] : input.files_read ?? [],
    filesModified: input.status === "skipped" ? [] : input.files_modified ?? [],
    createdAtEpoch: input.created_at_epoch ?? Math.floor(Date.now() / 1000),
    updatedAtEpoch: input.updated_at_epoch ?? null,
    observations: [],
  });

  return textResult(`Saved turn #${turn.promptNumber} with status ${turn.status}.`);
}

function handleObservationRemember(
  db: Database,
  parent: { sessionId: number; promptNumber: number },
  input: RememberToolInput,
): ToolTextResult {
  const turn = getTurn(db, parent.sessionId, parent.promptNumber);

  if (!turn) {
    return textResult(`Turn S${parent.sessionId}/T${parent.promptNumber} not found.`);
  }

  const observation = createObservation(db, {
    turnId: turn.id,
    type: input.type ?? "discovery",
    title: input.title ?? "Untitled observation",
    content: resolveContent(input),
    description: resolveContent(input),
    insight: input.insight ?? null,
    narrative: input.insight ?? null,
    tags: input.tags ?? [],
    concepts: input.tags ?? [],
    filesRead: input.files_read ?? [],
    filesModified: input.files_modified ?? [],
    createdAtEpoch: input.created_at_epoch ?? Math.floor(Date.now() / 1000),
  });

  return textResult(`Saved observation O${observation.id} for S${parent.sessionId}/T${parent.promptNumber}.`);
}

function handleMemoryCreate(db: Database, input: RememberToolInput): ToolTextResult {
  if (!input.type || !input.scope || !input.title || !resolveContent(input)) {
    return textResult("Memory creation requires type, scope, title, and content.");
  }

  const memory = createMemory(db, {
    type: input.type,
    scope: input.scope,
    title: input.title,
    content: resolveContent(input)!,
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
    expiresAtEpoch: input.expires_at_epoch ?? null,
    sourceTurnId: input.source_turn_id ?? null,
    createdAtEpoch: input.created_at_epoch ?? Math.floor(Date.now() / 1000),
    updatedAtEpoch: input.updated_at_epoch ?? null,
  });

  return textResult(`Created memory M${memory.id}.`);
}

function handleMemoryUpdate(
  db: Database,
  memoryId: number,
  input: RememberToolInput,
): ToolTextResult {
  const memory = updateMemory(db, memoryId, {
    type: input.type,
    scope: input.scope,
    title: input.title,
    content: resolveContent(input) ?? undefined,
    reasoning: input.reasoning,
    application: input.application,
    tags: input.tags,
    status:
      input.status === "active" ||
      input.status === "superseded" ||
      input.status === "archived"
        ? input.status
        : undefined,
    expiresAtEpoch: input.expires_at_epoch,
    sourceTurnId: input.source_turn_id,
    updatedAtEpoch: input.updated_at_epoch,
  });

  if (!memory) {
    return textResult(`Memory M${memoryId} not found.`);
  }

  return textResult(`Updated memory M${memory.id}.`);
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
      const session = getSession(db, sessionId);

      if (!session) {
        return textResult(`Session ${sessionId} not found.`);
      }

      return updateSessionTool(db, {
        session_id: sessionId,
        title: input.title,
        content: resolveContent(input) ?? undefined,
        description: resolveContent(input) ?? undefined,
        insight: input.insight,
        next_steps: input.next_steps,
        updated_at_epoch: input.updated_at_epoch,
        completed_at_epoch: input.completed_at_epoch,
      });
    }

    const memoryId = parseMemoryId(input.id);

    if (memoryId !== null) {
      return handleMemoryUpdate(db, memoryId, input);
    }

    return textResult(`Unsupported id selector: ${input.id}`);
  }

  return handleMemoryCreate(db, input);
}
