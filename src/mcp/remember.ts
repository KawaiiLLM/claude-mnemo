import type { Database } from "bun:sqlite";

import { runWriteTransaction } from "../db/database";
import {
  parseBareAddressReference,
  validateReferences,
  type ParsedReference,
} from "../db/references";
import {
  addSegmentMembers,
  appendSegmentWorkingStateRows,
  attachSegmentToSession,
  createSegment,
  findTopic,
  getSegment,
  getSegmentsForTopic,
  replaceInSegmentWorkingStateField,
  toggleSegmentStatus,
  upsertTopic,
  type SegmentRecord,
} from "../db/segments";
import { countTurnsSince } from "../db/sessions";
import { decodeHtmlEntities } from "./note";
import { renderSegmentCard } from "./segment-card";
import {
  SEGMENT_EDITABLE_FIELDS,
  type SegmentEditableField,
} from "../shared/segment-fields";
import {
  containsToolCallSyntax,
  toolCallSyntaxMessage,
} from "../shared/tool-call-syntax";
import { stripPrivateTags } from "../shared/tag-stripping";

type ToolTextResult = {
  content: Array<{
    type: "text";
    text: string;
  }>;
};

export type RememberVerb = "create" | "attach" | "append" | "replace" | "close";
const REMEMBER_VERBS: readonly RememberVerb[] = [
  "create",
  "attach",
  "append",
  "replace",
  "close",
];

import { MAINTENANCE_CADENCE } from "../shared/segment-cadence";

export interface RememberToolInput {
  verb?: unknown;
  // create
  title?: unknown;
  topic?: unknown;
  goal?: unknown;
  members?: unknown;
  // attach / append / replace / close share `id` — a segment's `E<n>`
  // address, or (attach/close only in practice, but resolved identically
  // everywhere) a topic name.
  id?: unknown;
  // append / replace
  field?: unknown;
  // append
  rows?: unknown;
  // replace
  oldString?: unknown;
  newString?: unknown;
}

export interface RememberToolOptions {
  now?: () => number;
  runWriteTransaction?: typeof runWriteTransaction;
  /**
   * The caller's mnemo session (same resolution as `note`'s `callerSessionId`
   * — spec D2, server.ts's direct-execution entry point only). `attach`
   * requires it (there is nothing to bind without a session); `append`/
   * `replace` degrade gracefully — the write still lands, the maintenance
   * cadence line just says the caller session is unknown instead of a count.
   */
  callerSessionId?: number | null;
}

function textResult(text: string): ToolTextResult {
  return { content: [{ type: "text", text }] };
}

function parameterError(message: string): ToolTextResult {
  return textResult(`Parameter error: ${message}`);
}

class RememberValidationError extends Error {}

function fail(message: string): never {
  throw new RememberValidationError(message);
}

/**
 * The one prose-field resolver `create`'s title/topic/goal all go through:
 * decode, markup-reject, strip `<private>` — the same hygiene `note`'s
 * `resolveStringField` applies, minus the append/overwrite mode machinery
 * `remember` has no equivalent of (a fresh segment has no prior value to
 * append onto).
 */
function resolveProseField(field: string, value: unknown, opts: { required: boolean }): string | null {
  if (value === undefined || value === null) {
    if (opts.required) {
      fail(`${field} is required.`);
    }
    return null;
  }
  if (typeof value !== "string") {
    fail(`${field} must be a string when present.`);
  }
  const decoded = decodeHtmlEntities(value);
  if (decoded.trim() === "") {
    if (opts.required) {
      fail(`${field} must not be empty.`);
    }
    return null;
  }
  if (containsToolCallSyntax(decoded)) {
    fail(toolCallSyntaxMessage(field));
  }
  return stripPrivateTags(decoded);
}

// ---------------------------------------------------------------------------
// Segment targeting — shared by attach/append/replace (ticket 02: "attach …
// by E id or topic"). append/replace reuse the identical resolution so a
// caller addresses a segment the same way from every verb.
// ---------------------------------------------------------------------------

type SegmentTargetResolution =
  | { ok: true; segment: SegmentRecord }
  | { ok: false; message: string };

function resolveSegmentTarget(db: Database, rawId: string): SegmentTargetResolution {
  const trimmed = rawId.trim();
  const bareRef = parseBareAddressReference(trimmed);

  if (bareRef) {
    if (bareRef.kind !== "segment") {
      return {
        ok: false,
        message: `id must be a segment address ("E<n>") or a topic name — got a turn address "${trimmed}".`,
      };
    }
    const segment = getSegment(db, bareRef.segmentId);
    if (!segment) {
      return { ok: false, message: `no segment E${bareRef.segmentId}.` };
    }
    return { ok: true, segment };
  }

  const topic = findTopic(db, trimmed);
  if (!topic) {
    return {
      ok: false,
      message: `no segment "E<n>" and no topic named "${trimmed}" — use remember(create) to mint one.`,
    };
  }
  const candidates = getSegmentsForTopic(db, topic.id);
  if (candidates.length === 0) {
    return {
      ok: false,
      message: `topic "${topic.name}" has no segment yet — use remember(create) to mint one.`,
    };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      message:
        `topic "${topic.name}" has ${candidates.length} segments ` +
        `(${candidates.map((entry) => `E${entry.id}`).join(", ")}) — use an explicit "E<n>" address.`,
    };
  }
  return { ok: true, segment: candidates[0]! };
}

// ---------------------------------------------------------------------------
// Maintenance cadence receipt (ADR-0002) — advisory, never a gate.
// ---------------------------------------------------------------------------

function formatMaintenanceCadence(
  db: Database,
  callerSessionId: number | null | undefined,
  priorUpdatedAtEpoch: number,
  exemptFromTooSoon: boolean,
): string {
  if (typeof callerSessionId !== "number") {
    return "maintenance cadence: caller session unknown.";
  }
  const turnsSince = countTurnsSince(db, callerSessionId, priorUpdatedAtEpoch);
  const label = `${turnsSince} turn${turnsSince === 1 ? "" : "s"}`;
  if (turnsSince < MAINTENANCE_CADENCE.tooSoonUnder && !exemptFromTooSoon) {
    return `${label} since this segment's last maintenance — you may be over-maintaining; consider batching small edits.`;
  }
  // Ticket 12's nudge half: the 20-turn nudge left this receipt. A receipt
  // only reaches whoever is ALREADY maintaining the segment — the session
  // that has gone 20 turns without touching it never sees a receipt at all.
  // The nudge rides the segment card's header instead (segment-card.ts),
  // which renders at SessionStart and in recall without any write.
  return `${label} since this segment's last maintenance.`;
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

interface MemberAddressRejection {
  raw: string;
  reason: "malformed" | "not-a-turn" | "unresolved";
}

const MEMBER_REJECTION_TEXT: Record<MemberAddressRejection["reason"], string> = {
  malformed: 'is not a valid turn address ("S<session>/T<prompt>")',
  "not-a-turn": "names a segment, not a turn",
  unresolved: "does not resolve to a turn",
};

function formatMemberRejections(rejections: readonly MemberAddressRejection[]): string {
  return (
    "members rejected: " +
    rejections.map((entry) => `"${entry.raw}" ${MEMBER_REJECTION_TEXT[entry.reason]}`).join("; ") +
    " — membership is recorded for exactly the addresses given, so a call naming even one bad address seeds none."
  );
}

function resolveMemberAddresses(
  db: Database,
  addresses: readonly string[],
): { turnIds: number[]; rejections: MemberAddressRejection[] } {
  const rejections: MemberAddressRejection[] = [];
  const turnRefs: ParsedReference[] = [];

  for (const raw of addresses) {
    const parsed = parseBareAddressReference(raw);
    if (!parsed) {
      rejections.push({ raw, reason: "malformed" });
      continue;
    }
    if (parsed.kind !== "turn") {
      rejections.push({ raw, reason: "not-a-turn" });
      continue;
    }
    turnRefs.push(parsed);
  }

  if (turnRefs.length === 0) {
    return { turnIds: [], rejections };
  }

  const { accepted, rejected } = validateReferences(db, turnRefs);
  for (const entry of rejected) {
    rejections.push({ raw: entry.reference.raw, reason: "unresolved" });
  }
  return { turnIds: accepted.map((entry) => entry.node.id), rejections };
}

interface CreateTransactionResult {
  segment: SegmentRecord;
  topicName: string;
  memberTurnIds: number[];
  goalSeeded: boolean;
}

function handleCreate(
  db: Database,
  input: RememberToolInput,
  options: RememberToolOptions,
): ToolTextResult {
  let title: string;
  let topicInput: string;
  let goal: string | null;
  let memberAddresses: string[];
  try {
    title = resolveProseField("title", input.title, { required: true })!;
    topicInput = resolveProseField("topic", input.topic, { required: true })!;
    goal = resolveProseField("goal", input.goal, { required: false });

    if (input.members === undefined) {
      memberAddresses = [];
    } else if (
      Array.isArray(input.members) &&
      input.members.every((value) => typeof value === "string")
    ) {
      memberAddresses = input.members as string[];
    } else {
      fail("members must be an array of strings when present.");
    }
  } catch (error) {
    if (error instanceof RememberValidationError) {
      return parameterError(error.message);
    }
    throw error;
  }

  const nowEpoch = options.now?.() ?? Math.floor(Date.now() / 1000);
  const writeTransaction = options.runWriteTransaction ?? runWriteTransaction;

  let result: CreateTransactionResult;
  try {
    result = writeTransaction(db, (): CreateTransactionResult => {
      const { turnIds, rejections } = resolveMemberAddresses(db, memberAddresses);
      if (rejections.length > 0) {
        fail(formatMemberRejections(rejections));
      }

      const topic = upsertTopic(db, { name: topicInput, nowEpoch });
      let segment = createSegment(db, {
        title,
        topicId: topic.id,
        nowEpoch,
      });

      if (turnIds.length > 0) {
        addSegmentMembers(db, segment.id, turnIds, nowEpoch);
      }

      let goalSeeded = false;
      if (goal !== null) {
        const withGoal = appendSegmentWorkingStateRows(
          db,
          segment.id,
          "goal",
          [goal],
          nowEpoch,
        );
        if (withGoal) {
          segment = withGoal;
          goalSeeded = true;
        }
      }

      return { segment, topicName: topic.name, memberTurnIds: turnIds, goalSeeded };
    });
  } catch (error) {
    if (error instanceof RememberValidationError) {
      return parameterError(error.message);
    }
    throw error;
  }

  const parts = [
    `Created E${result.segment.id} "${result.segment.title}" (topic: ${result.topicName}).`,
  ];
  parts.push(
    result.memberTurnIds.length > 0
      ? `${result.memberTurnIds.length} member(s) seeded.`
      : "0 members seeded.",
  );
  if (result.goalSeeded) {
    parts.push("goal: 1 row seeded.");
  }
  return textResult(parts.join(" "));
}

// ---------------------------------------------------------------------------
// attach
// ---------------------------------------------------------------------------

function handleAttach(
  db: Database,
  input: RememberToolInput,
  options: RememberToolOptions,
): ToolTextResult {
  if (typeof input.id !== "string" || input.id.trim() === "") {
    return parameterError('id is required for attach — an "E<n>" address or a topic name.');
  }
  if (typeof options.callerSessionId !== "number") {
    return parameterError("caller session unknown; attach cannot bind a segment to it.");
  }
  const callerSessionId = options.callerSessionId;

  const resolution = resolveSegmentTarget(db, input.id);
  if (!resolution.ok) {
    return parameterError(resolution.message);
  }

  const nowEpoch = options.now?.() ?? Math.floor(Date.now() / 1000);
  const writeTransaction = options.runWriteTransaction ?? runWriteTransaction;
  const { attached } = writeTransaction(db, () =>
    attachSegmentToSession(db, callerSessionId, resolution.segment.id, nowEpoch),
  );

  const header = `Attached S${callerSessionId} to E${resolution.segment.id}${
    attached ? "" : " (already attached)"
  }.`;
  // Ticket 03: attach returns the canonical segment card — the same render
  // `recall(id="E<n>")` collapsed produces — swapping ticket 02's provisional
  // plain render for it, per this module's own note above `handleAttach`.
  const card = renderSegmentCard(db, resolution.segment.id, {
    depth: "collapsed",
    eraCutoffEpoch: null,
  });
  return textResult(`${header}\n${card}`);
}

// ---------------------------------------------------------------------------
// append
// ---------------------------------------------------------------------------

function isEditableField(value: unknown): value is SegmentEditableField {
  return (
    typeof value === "string" &&
    (SEGMENT_EDITABLE_FIELDS as readonly string[]).includes(value)
  );
}

function fieldRequiredMessage(): string {
  return `field is required and must be one of ${SEGMENT_EDITABLE_FIELDS.join(", ")}.`;
}

/** Ticket 05: the write gate names `close` as the way back, in the same breath it refuses. */
function closedSegmentRejection(segmentId: number): string {
  return (
    `E${segmentId} is closed — Working State only accepts writes on an open segment; ` +
    `remember(close, id="E${segmentId}") reopens it.`
  );
}

function handleAppend(
  db: Database,
  input: RememberToolInput,
  options: RememberToolOptions,
): ToolTextResult {
  if (typeof input.id !== "string" || input.id.trim() === "") {
    return parameterError('id is required for append — an "E<n>" address or a topic name.');
  }
  if (!isEditableField(input.field)) {
    return parameterError(fieldRequiredMessage());
  }
  if (
    !Array.isArray(input.rows) ||
    input.rows.length === 0 ||
    !input.rows.every((value) => typeof value === "string")
  ) {
    return parameterError("rows must be a non-empty array of strings.");
  }

  const resolution = resolveSegmentTarget(db, input.id);
  if (!resolution.ok) {
    return parameterError(resolution.message);
  }
  if (resolution.segment.status === "closed") {
    return parameterError(closedSegmentRejection(resolution.segment.id));
  }

  const field = input.field;
  let rows: string[];
  try {
    rows = (input.rows as string[]).map((raw, index) => {
      const decoded = decodeHtmlEntities(raw);
      if (decoded.trim() === "") {
        fail(`rows[${index}] must not be empty.`);
      }
      if (containsToolCallSyntax(decoded)) {
        fail(toolCallSyntaxMessage(`rows[${index}]`));
      }
      if (decoded.includes("\n")) {
        fail(`rows[${index}] contains a newline — one row, one line.`);
      }
      return stripPrivateTags(decoded);
    });
  } catch (error) {
    if (error instanceof RememberValidationError) {
      return parameterError(error.message);
    }
    throw error;
  }

  const priorUpdatedAtEpoch = resolution.segment.updatedAtEpoch;
  const nowEpoch = options.now?.() ?? Math.floor(Date.now() / 1000);
  const writeTransaction = options.runWriteTransaction ?? runWriteTransaction;
  const updated = writeTransaction(db, () =>
    appendSegmentWorkingStateRows(db, resolution.segment.id, field, rows, nowEpoch),
  );

  if (!updated) {
    return parameterError(`E${resolution.segment.id} no longer exists.`);
  }

  // decisions appends are exempt from the too-soon reminder ONLY (ADR-0002:
  // "a lost ruling is the costliest loss") — the 20+ nudge still applies.
  const cadence = formatMaintenanceCadence(
    db,
    options.callerSessionId,
    priorUpdatedAtEpoch,
    field === "decisions",
  );

  return textResult(
    `Appended ${rows.length} row(s) to ${field} on E${updated.id}. ${cadence}`,
  );
}

// ---------------------------------------------------------------------------
// replace
// ---------------------------------------------------------------------------

function handleReplace(
  db: Database,
  input: RememberToolInput,
  options: RememberToolOptions,
): ToolTextResult {
  if (typeof input.id !== "string" || input.id.trim() === "") {
    return parameterError('id is required for replace — an "E<n>" address or a topic name.');
  }
  if (!isEditableField(input.field)) {
    return parameterError(fieldRequiredMessage());
  }
  if (typeof input.oldString !== "string" || input.oldString === "") {
    return parameterError("oldString is required and must be a non-empty string.");
  }
  if (typeof input.newString !== "string") {
    return parameterError('newString is required (use "" to delete the matched text).');
  }

  const resolution = resolveSegmentTarget(db, input.id);
  if (!resolution.ok) {
    return parameterError(resolution.message);
  }
  if (resolution.segment.status === "closed") {
    return parameterError(closedSegmentRejection(resolution.segment.id));
  }

  const field = input.field;
  const oldString = decodeHtmlEntities(input.oldString);
  const newStringRaw = decodeHtmlEntities(input.newString);
  if (containsToolCallSyntax(oldString)) {
    return parameterError(toolCallSyntaxMessage("oldString"));
  }
  if (newStringRaw !== "" && containsToolCallSyntax(newStringRaw)) {
    return parameterError(toolCallSyntaxMessage("newString"));
  }
  const newString = newStringRaw === "" ? "" : stripPrivateTags(newStringRaw);

  const priorUpdatedAtEpoch = resolution.segment.updatedAtEpoch;
  const nowEpoch = options.now?.() ?? Math.floor(Date.now() / 1000);
  const writeTransaction = options.runWriteTransaction ?? runWriteTransaction;
  const outcome = writeTransaction(db, () =>
    replaceInSegmentWorkingStateField(db, resolution.segment.id, field, oldString, newString, nowEpoch),
  );

  if (!outcome.segment) {
    return parameterError(`E${resolution.segment.id} no longer exists.`);
  }
  if (outcome.rejection === "missing") {
    return parameterError(
      `oldString ${JSON.stringify(oldString)} not found in ${field} on E${resolution.segment.id}.`,
    );
  }
  if (outcome.rejection === "ambiguous") {
    return parameterError(
      `oldString ${JSON.stringify(oldString)} matches ${outcome.occurrences} times in ${field} on ` +
        `E${resolution.segment.id} — narrow it so it matches exactly once.`,
    );
  }

  const cadence = formatMaintenanceCadence(
    db,
    options.callerSessionId,
    priorUpdatedAtEpoch,
    false,
  );
  const verb = newString === "" ? "Removed a row from" : "Replaced text in";
  return textResult(`${verb} ${field} on E${resolution.segment.id}. ${cadence}`);
}

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------

/**
 * Ticket 05: toggles the segment closed (leaves the roster, still
 * `recall`-able) or, on an already-closed segment, reopens it — see
 * `toggleSegmentStatus` (db/segments.ts) for why this is one verb, not two.
 */
function handleClose(
  db: Database,
  input: RememberToolInput,
  options: RememberToolOptions,
): ToolTextResult {
  if (typeof input.id !== "string" || input.id.trim() === "") {
    return parameterError('id is required for close — an "E<n>" address or a topic name.');
  }

  const resolution = resolveSegmentTarget(db, input.id);
  if (!resolution.ok) {
    return parameterError(resolution.message);
  }

  const nowEpoch = options.now?.() ?? Math.floor(Date.now() / 1000);
  const writeTransaction = options.runWriteTransaction ?? runWriteTransaction;
  const updated = writeTransaction(db, () =>
    toggleSegmentStatus(db, resolution.segment.id, nowEpoch),
  );

  if (!updated) {
    return parameterError(`E${resolution.segment.id} no longer exists.`);
  }

  return textResult(
    updated.status === "closed"
      ? `Closed E${updated.id} — it leaves the roster, still recall-able. ` +
          `remember(close, id="E${updated.id}") reopens it.`
      : `Reopened E${updated.id} — it rejoins the roster.`,
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * `remember` — the segment (semantic) write surface, revived beside `note`
 * (episodic) per ADR-0002. Five verbs, one tool: `create` mints a segment
 * from the roster the caller has in view; `attach` binds the current session
 * to one and returns its fields; `append`/`replace` maintain one named
 * field (Working State, or content/insight); `close` toggles the segment off
 * (or back onto) the roster.
 */
export function rememberTool(
  db: Database,
  rawInput: RememberToolInput,
  options: RememberToolOptions = {},
): ToolTextResult {
  if (typeof rawInput.verb !== "string" || !REMEMBER_VERBS.includes(rawInput.verb as RememberVerb)) {
    return parameterError(`verb must be one of ${REMEMBER_VERBS.join(", ")}.`);
  }

  switch (rawInput.verb as RememberVerb) {
    case "create":
      return handleCreate(db, rawInput, options);
    case "attach":
      return handleAttach(db, rawInput, options);
    case "append":
      return handleAppend(db, rawInput, options);
    case "replace":
      return handleReplace(db, rawInput, options);
    case "close":
      return handleClose(db, rawInput, options);
  }
}
