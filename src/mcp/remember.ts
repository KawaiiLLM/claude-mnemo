import type { Database } from "bun:sqlite";

import { updateObservation } from "../db/observations";
import { getSession, updateSessionSummaryRewrite } from "../db/sessions";
import { getTurnById, updateTurnById, type TurnStatus } from "../db/turns";

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
  | "active";

type ObservationStatus = "pending" | "extracted" | "skipped";

const TURN_REMEMBER_STATUSES = ["skipped", "undone", "active"] as const;
const OBSERVATION_REMEMBER_STATUSES = [
  "pending",
  "extracted",
  "skipped",
] as const;

export interface RememberToolInput {
  id?: string;
  type?: string;
  title?: string;
  content?: string;
  insight?: string;
  tags?: string[];
  status?: RememberStatus;
  next_steps?: string;
  decision?: string;
  done?: string;
  current?: string;
  reference?: string;
}

// D1/D2: the seven session-summary fields. `next_steps` is the tool/DB name for
// the displayed "next" field. A session remember must supply ALL of them
// (empty string allowed) — summaries are rewritten whole, never merged.
const SESSION_SUMMARY_KEYS = [
  "title",
  "content",
  "decision",
  "done",
  "current",
  "next_steps",
  "reference",
] as const;

function textResult(text: string): ToolTextResult {
  return {
    content: [{ type: "text", text }],
  };
}

function parameterError(message: string): ToolTextResult {
  return textResult(`Parameter error: ${message}`);
}

/**
 * A remember result is a successful write iff its text is one of the "Updated …"
 * confirmations (handleTurnRemember/handleObservationRemember/handleSessionRemember).
 * Failures are parameterError("Parameter error: …") or "… not found.".
 */
export function isRememberSuccess(result: { content: Array<{ type: string; text?: string }> }): boolean {
  const text = result.content?.[0]?.text ?? "";
  return text.startsWith("Updated ");
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

  return input.title || input.content ? "extracted" : "skipped";
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
    input.insight !== undefined ||
    input.tags !== undefined ||
    input.next_steps !== undefined ||
    input.decision !== undefined ||
    input.done !== undefined ||
    input.current !== undefined ||
    input.reference !== undefined
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

  // All-or-nothing (D2): every summary field must be present (empty allowed).
  // A partial update would silently freeze the omitted fields — the exact
  // staleness root cause this redesign removes. Reject rather than half-write.
  const missing = SESSION_SUMMARY_KEYS.filter((key) => input[key] === undefined);

  if (missing.length > 0) {
    return parameterError(
      `session remember rewrites the whole summary — supply all fields (${SESSION_SUMMARY_KEYS.join(
        ", ",
      )}). Missing: ${missing.join(", ")}.`,
    );
  }

  const updated = updateSessionSummaryRewrite(
    db,
    sessionId,
    {
      title: input.title ?? "",
      content: input.content ?? "",
      decision: input.decision ?? "",
      done: input.done ?? "",
      current: input.current ?? "",
      nextSteps: input.next_steps ?? "",
      reference: input.reference ?? "",
    },
    Math.floor(Date.now() / 1000),
  );

  if (!updated) {
    return textResult(`Session ${sessionId} not found.`);
  }

  return textResult(`Updated session ${sessionId}.`);
}

export function rememberTool(
  db: Database,
  input: RememberToolInput,
): ToolTextResult {
  if (!input.id) {
    return parameterError(
      "id is required: O<n> (observation), T<n> (turn), or S<n> (session). Durable memory creation was removed.",
    );
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

  if (/^M\d+$/i.test(input.id)) {
    return parameterError(
      "Durable memory (M<n>) was removed. Use O<n> (observation), T<n> (turn), or S<n> (session).",
    );
  }

  return textResult(`Unsupported id selector: ${input.id}`);
}
