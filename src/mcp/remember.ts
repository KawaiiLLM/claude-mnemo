import type { Database } from "bun:sqlite";

import { updateObservation } from "../db/observations";
import { getSession, updateSessionSummaryRewrite } from "../db/sessions";
import { getTurnById, updateTurnById, type TurnStatus } from "../db/turns";
import {
  CURRENT_SESSION_STATE_TOKEN_BUDGET,
  measureSessionStateTokens,
} from "./session-output";

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
  grade?: number;
  regrade?: {
    id: string;
    grade: number;
  };
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

const HTML_ENTITY_MAP: Record<string, string> = { lt: "<", gt: ">", amp: "&" };

// The memory agent sometimes emits HTML-escaped text (e.g. `T&lt;n&gt;`) even
// though summaries are plain text; decode once at the persistence boundary.
// Single-pass (one replace call) so `&amp;lt;` decodes to `&lt;`, never `<`.
function decodeHtmlEntities(value: string): string {
  return value.replace(/&(lt|gt|amp);/g, (_match, name: string) => HTML_ENTITY_MAP[name]!);
}

function decodeRememberInput(input: RememberToolInput): RememberToolInput {
  const decoded: RememberToolInput = { ...input };
  for (const key of [
    "id",
    "type",
    "title",
    "content",
    "insight",
    "next_steps",
    "decision",
    "done",
    "current",
    "reference",
  ] as const) {
    const value = decoded[key];
    if (typeof value === "string") {
      decoded[key] = decodeHtmlEntities(value);
    }
  }
  if (decoded.tags) {
    decoded.tags = decoded.tags.map((tag) => decodeHtmlEntities(tag));
  }
  return decoded;
}

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

/**
 * Backstop for fix #1: the memory agent reliably names the predecessor turn's
 * DB id but, when the reference is woven mid-sentence ("reverted in T4244",
 * "(T4243)"), writes it bare instead of the bracketed `[T<n>]` form the timeline
 * resolver (parseContentReferences, /\[T(\d+)\]/g) and recall key on — so the
 * causal link never reaches the temporal layer. This rewrites those bare
 * mentions to `[T<n>]` before persisting, under two guards:
 *
 *  - Valid predecessor only: `isValidPredecessor(id)` decides whether a bare id
 *    is a real causal driver. The caller passes the SAME predicate the read-side
 *    resolver applies (timeline.ts) — the cited turn must exist, share the
 *    session, and precede this one by prompt_number. A numeric `id < turnId`
 *    check is NOT enough: DB-id order ≠ prompt order, and an incidental bare
 *    `T123` that happens to be a real earlier turn would become a false cite.
 *  - Boundary + spacing: a bare id glued into a larger token ("fooT4243") or
 *    already bracketed (`[T4243]`) is skipped; when the surviving neighbour is
 *    non-space text (it sat in parens or after a comma) a single space is
 *    inserted so the bracket never abuts adjacent text.
 */
export function bracketBareTurnReferences(
  content: string,
  isValidPredecessor: (candidateId: number) => boolean,
): string {
  if (!content) {
    return content;
  }

  // lead: start-of-string, or the single char before an optional `(` — never an
  //   existing `[` or a word char, so we never reach into `[T..]` or a token.
  // `\(?T(\d+)\)?`: the id, unwrapping a `(…)` form into brackets.
  // lookahead: not already followed by `]` or a word char.
  return content.replace(
    /(^|[^[\w])\(?T(\d+)\)?(?![\]\w])/g,
    (match: string, lead: string, digits: string) => {
      const id = Number.parseInt(digits, 10);
      if (!Number.isFinite(id) || !isValidPredecessor(id)) {
        return match;
      }
      const needsSpace =
        lead !== "" && !/\s/.test(lead) && !"([{".includes(lead);
      const prefix = needsSpace ? `${lead} ` : lead;
      return `${prefix}[T${id}]`;
    },
  );
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

function validateGrade(value: number | undefined, label: string): string | null {
  if (value === undefined) {
    return null;
  }
  if (!Number.isInteger(value) || value < 0 || value > 4) {
    return `${label} must be an integer from 0 through 4.`;
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

function deriveTurnStatusForUpdate(
  current: ReturnType<typeof getTurnById>,
  input: RememberToolInput,
): TurnStatus | undefined {
  if (
    current?.status === "extracted" &&
    input.status === undefined &&
    input.title === undefined &&
    input.content === undefined
  ) {
    return undefined;
  }

  return deriveTurnStatus(input);
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

  // DB-aware predecessor predicate, mirroring the read-side resolver
  // (timeline.ts resolveMilestoneReferences): a bare `T<n>` is bracketed only if
  // the cited turn exists, shares this turn's session, and precedes it by
  // prompt_number. `current` is null only when the turn itself is missing, in
  // which case updateTurnById below returns null → "not found".
  const current = getTurnById(db, turnId);
  if (!current) {
    return textResult(`Turn T${turnId} not found.`);
  }

  const gradeError = validateGrade(input.grade, "grade");
  if (gradeError) {
    return parameterError(gradeError);
  }
  if (
    (current.status === "active" || current.status === "provisional") &&
    input.grade === undefined
  ) {
    return parameterError(
      "grade is required when extracting a new turn (integer 0 through 4).",
    );
  }

  let regradeTarget: ReturnType<typeof getTurnById> = null;
  if (input.regrade !== undefined) {
    const regradeError = validateGrade(input.regrade.grade, "regrade.grade");
    if (regradeError) {
      return parameterError(regradeError);
    }
    const regradeId = parseTurnId(input.regrade.id);
    if (regradeId === null) {
      return parameterError("regrade.id must be a T<n> turn reference.");
    }
    regradeTarget = getTurnById(db, regradeId);
    if (
      !regradeTarget ||
      regradeTarget.sessionId !== current.sessionId ||
      regradeTarget.promptNumber >= current.promptNumber
    ) {
      return parameterError(
        "regrade must target an earlier turn in the same session.",
      );
    }
  }

  const isValidPredecessor = (candidateId: number): boolean => {
    if (candidateId === turnId) {
      return false;
    }
    const cited = getTurnById(db, candidateId);
    return (
      cited !== null &&
      cited.sessionId === current.sessionId &&
      cited.promptNumber < current.promptNumber
    );
  };

  const turn = updateTurnById(db, turnId, {
    status: deriveTurnStatusForUpdate(current, input),
    title: input.title ?? null,
    content:
      input.content != null
        ? bracketBareTurnReferences(input.content, isValidPredecessor)
        : null,
    insight: input.insight ?? null,
    type: input.type ?? null,
    significanceGrade: input.grade,
    tags: input.tags ?? [],
    updatedAtEpoch: Math.floor(Date.now() / 1000),
  });

  if (!turn) {
    return textResult(`Turn T${turnId} not found.`);
  }

  if (regradeTarget && input.regrade) {
    updateTurnById(db, regradeTarget.id, {
      significanceGrade: input.regrade.grade,
    });
    return textResult(
      `Updated turn T${turnId} with status ${turn.status}. Regraded turn T${regradeTarget.id} to ${input.regrade.grade}.`,
    );
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
    input.grade !== undefined ||
    input.regrade !== undefined ||
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
  if (input.grade !== undefined || input.regrade !== undefined) {
    return parameterError("session remember does not accept grade or regrade.");
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

  const tokenReport = measureSessionStateTokens({
    id: session.id,
    title: input.title ?? "",
    content: input.content ?? "",
    decision: input.decision ?? "",
    done: input.done ?? "",
    current: input.current ?? "",
    nextSteps: input.next_steps ?? "",
    reference: input.reference ?? "",
  });
  if (tokenReport.total > CURRENT_SESSION_STATE_TOKEN_BUDGET) {
    return parameterError(
      `rendered state exceeds ${CURRENT_SESSION_STATE_TOKEN_BUDGET} tokens; ` +
        `title=${tokenReport.title}, content=${tokenReport.content}, ` +
        `current=${tokenReport.current}, next_steps=${tokenReport.nextSteps}, ` +
        `decision=${tokenReport.decision}, done=${tokenReport.done}, ` +
        `reference=${tokenReport.reference}, total=${tokenReport.total}. ` +
        "Trim fields and retry.",
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
  rawInput: RememberToolInput,
): ToolTextResult {
  const input = decodeRememberInput(rawInput);

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
