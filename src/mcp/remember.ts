import type { Database } from "bun:sqlite";

import {
  replaceTurnCitations,
  type CitationInput,
  type ReplaceTurnCitationsResult,
} from "../db/citations";
import { runWriteTransaction } from "../db/database";
import { updateObservation } from "../db/observations";
import { getSession, updateSessionSummaryRewrite } from "../db/sessions";
import {
  getTurnById,
  updateTurnById,
  type TurnRecord,
  type TurnStatus,
} from "../db/turns";
import { isMemoryType, MEMORY_TYPES } from "../shared/type-vocabulary";
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
  // `null` explicitly clears; `undefined` (the field absent) leaves it as it
  // was. See resolveNullable (db/turns.ts) for why the two cannot share a
  // value.
  grade?: number | null;
  regrade?: {
    id: string;
    grade: number;
  };
  cites?: CitationInput[];
  type?: string | null;
  title?: string | null;
  content?: string | null;
  insight?: string | null;
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

function validateGrade(
  value: number | null | undefined,
  label: string,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Number.isInteger(value) || value < 0 || value > 4) {
    return `${label} must be an integer from 0 through 4.`;
  }
  return null;
}

/**
 * The closed `type` vocabulary stays closed at the write boundary too: an
 * unrecognised word is rejected rather than landing in the column (spec's
 * "an illegal type … leave the column empty rather than write an unknown
 * word"). `null` (an explicit clear) and `undefined` (omitted) both pass
 * through untouched — validation only concerns a word that IS supplied.
 */
function validateType(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isMemoryType(value)) {
    return `type "${value}" is not a recognised type. Allowed: ${MEMORY_TYPES.join(", ")}.`;
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

interface TurnRememberWrite {
  turn: TurnRecord;
  citations: ReplaceTurnCitationsResult | null;
}

/**
 * Raised from inside the write transaction when the nested regrade's target has
 * vanished since it was validated, so the transaction rolls back whole.
 */
class RegradeTargetMissingError extends Error {
  constructor(readonly targetId: number) {
    super(`regrade target T${targetId} no longer exists`);
    this.name = "RegradeTargetMissingError";
  }
}

/**
 * Ticket 04 (spec D10) lifted the era write refusal that used to live here.
 * An era turn used to be settled without storing any of a `remember` call's
 * payload (裁决 27, ticket 09) because the resident extraction agent — the
 * only caller that ever reached this route for an era turn — was writing a
 * reconstruction the cutover had already taken the record away from. That
 * agent is retired (ticket 15), and its replacement, the settlement review
 * pass, needs the opposite: a real write path onto era turns, to correct the
 * grade/type/tags a note's mechanical draft got wrong. So every turn, era or
 * legacy, now runs the one patch/clear path below.
 */
function handleTurnRemember(
  db: Database,
  turnId: number,
  input: RememberToolInput,
): ToolTextResult {
  const current = getTurnById(db, turnId);
  if (!current) {
    return textResult(`Turn T${turnId} not found.`);
  }

  const statusError = validateStatusForRoute(
    input.status,
    TURN_REMEMBER_STATUSES,
    "turn remember",
  );

  if (statusError) {
    return parameterError(statusError);
  }

  const gradeError = validateGrade(input.grade, "grade");
  if (gradeError) {
    return parameterError(gradeError);
  }

  const typeError = validateType(input.type);
  if (typeError) {
    return parameterError(typeError);
  }

  if (
    (current.status === "active" || current.status === "provisional") &&
    (input.grade === undefined || input.grade === null)
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

  // DB-aware predecessor predicate, mirroring the read-side pull-through guard
  // (timeline.ts selectMilestoneTurns): a bare `T<n>` is bracketed only if the
  // cited turn exists, shares this turn's session, and precedes it by
  // prompt_number.
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

  // One transaction for the turn fields, the replace-set edge write, and the
  // nested regrade (spec §B). Split writes could publish a turn whose narrated
  // causality and whose citation edges disagree — the settle pass reads the
  // edges as fact, so a half-write is worse than a rejected write.
  const nowEpoch = Math.floor(Date.now() / 1000);
  let written: TurnRememberWrite | null;
  try {
    written = runWriteTransaction(db, () => {
      const turn = updateTurnById(db, turnId, {
        status: deriveTurnStatusForUpdate(current, input),
        // Passed straight through (no `?? null`): input.title/insight/type are
        // already `T | null | undefined`, and collapsing them onto a shared
        // `null` here would be the exact omit-vs-clear ambiguity this ticket
        // removes — undefined must reach updateTurnById as undefined.
        title: input.title,
        content:
          typeof input.content === "string"
            ? bracketBareTurnReferences(input.content, isValidPredecessor)
            : input.content,
        insight: input.insight,
        type: input.type,
        significanceGrade: input.grade,
        tags: input.tags ?? [],
        updatedAtEpoch: nowEpoch,
      });

      if (!turn) {
        return null;
      }

      // Field absent = leave the edge set alone; present (even empty) = replace.
      const citations =
        input.cites === undefined
          ? null
          : replaceTurnCitations(db, turnId, input.cites, nowEpoch);

      if (regradeTarget && input.regrade) {
        // Re-checked INSIDE the transaction: the pre-validation above ran before
        // BEGIN, so a concurrent delete of the target in between would otherwise
        // commit the turn and its edges while silently skipping the regrade.
        // Throwing aborts the whole write instead of publishing that half.
        const regraded = updateTurnById(db, regradeTarget.id, {
          significanceGrade: input.regrade.grade,
        });
        if (!regraded) {
          throw new RegradeTargetMissingError(regradeTarget.id);
        }
      }

      return { turn, citations };
    });
  } catch (error) {
    if (error instanceof RegradeTargetMissingError) {
      return parameterError(
        `regrade target T${error.targetId} no longer exists; nothing was written.`,
      );
    }
    throw error;
  }

  if (!written) {
    return textResult(`Turn T${turnId} not found.`);
  }

  let message = `Updated turn T${turnId} with status ${written.turn.status}.`;
  if (regradeTarget && input.regrade) {
    message += ` Regraded turn T${regradeTarget.id} to ${input.regrade.grade}.`;
  }
  if (written.citations) {
    message += ` Recorded ${written.citations.written.length} citation(s).`;
    if (written.citations.droppedIds.length > 0) {
      message += ` Dropped unresolvable: ${written.citations.droppedIds
        .map((id) => `T${id}`)
        .join(", ")}.`;
    }
  }

  return textResult(message);
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
    input.cites !== undefined ||
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
    // Observation remember has no clear concept (out of ticket 04's scope);
    // `UpdateObservationInput.title` stays `string | undefined`, so an
    // explicit `null` here — which the shared schema now technically allows
    // through — degrades to "omitted" rather than a type error.
    title: input.title ?? undefined,
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
  if (
    input.grade !== undefined ||
    input.regrade !== undefined ||
    input.cites !== undefined
  ) {
    return parameterError(
      "session remember does not accept grade, regrade, or cites.",
    );
  }

  const session = getSession(db, sessionId);

  if (!session) {
    return textResult(`Session ${sessionId} not found.`);
  }

  // All-or-nothing (D2): every summary field must be present (empty allowed).
  // A partial update would silently freeze the omitted fields — the exact
  // staleness root cause this redesign removes. Reject rather than half-write.
  // `== null` on purpose: title/content are shared with the turn route's new
  // clear expression (ticket 04), so the schema now technically lets a caller
  // send `null` here too. The session route has no clear concept — an empty
  // string already means "no value" — so an explicit `null` counts as missing
  // exactly like an omitted key, rather than silently degrading to "".
  const missing = SESSION_SUMMARY_KEYS.filter((key) => input[key] == null);

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

export interface RememberToolOptions {
  /**
   * P2 era boundary (spec D11/D12). Kept for call-site compatibility with the
   * shared resolution in mcp/handlers.ts (note and remember are handed the
   * same number) — but ticket 04 (spec D10) lifted the era write refusal this
   * option used to gate, so `handleTurnRemember` no longer branches on it. A
   * turn's era no longer changes whether `remember` can write it.
   */
  eraCutoffEpoch?: number | null;
}

export function rememberTool(
  db: Database,
  rawInput: RememberToolInput,
  options: RememberToolOptions = {},
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
