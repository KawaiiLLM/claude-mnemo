import type { Database } from "bun:sqlite";

import { runWriteTransaction } from "../db/database";
import {
  parseBareAddressReference,
  validateReferences,
  type ParsedReference,
} from "../db/references";
import {
  appendSegmentWorkingStateRows,
  attachSegmentToSession,
  createSegment,
  findTopic,
  getSegment,
  getSegmentsForTopic,
  reassignSegmentMembers,
  replaceInSegmentWorkingStateField,
  toggleSegmentStatus,
  upsertTopic,
  type ReplaceSegmentWorkingStateFieldResult,
  type SegmentRecord,
} from "../db/segments";
import { countTurnsSince } from "../db/sessions";
import { checkFieldGate, sessionWriterId, stampField } from "../db/write-gate";
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

export type RememberVerb =
  | "create"
  | "attach"
  | "append"
  | "replace"
  | "close"
  | "assign";
const REMEMBER_VERBS: readonly RememberVerb[] = [
  "create",
  "attach",
  "append",
  "replace",
  "close",
  "assign",
];

import { MAINTENANCE_CADENCE } from "../shared/segment-cadence";

export interface RememberToolInput {
  verb?: unknown;
  // create
  title?: unknown;
  topic?: unknown;
  goal?: unknown;
  members?: unknown;
  // attach / append / replace / close / assign share `id` — a segment's
  // `E<n>` address, or (attach/close/assign in practice, but resolved
  // identically everywhere) a topic name. `assign` alone treats `id` as
  // OPTIONAL: omitted means "clear ownership" (ticket 02).
  id?: unknown;
  // append / replace
  field?: unknown;
  // append
  rows?: unknown;
  // replace
  oldString?: unknown;
  newString?: unknown;
  // assign (ticket 02, ownership-and-note-cadence spec): a turn interval
  // ("S<session>/T<a>..T<b>") or a list of turn addresses.
  turns?: unknown;
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

      // Ticket 02 (ownership-and-note-cadence spec): `members` seeding goes
      // through the SAME write path `assign` uses — `reassignSegmentMembers`,
      // not `addSegmentMembers` directly — so single ownership is enforced
      // uniformly. A fresh segment has no prior members of its own, but a
      // named turn may already belong to ANOTHER segment; seeding it here
      // evicts it from that segment the identical way an explicit `assign`
      // would, rather than opening a second, looser path around the rule.
      if (turnIds.length > 0) {
        reassignSegmentMembers(db, turnIds, segment.id, nowEpoch);
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

// ---------------------------------------------------------------------------
// Write gate (ticket 02, read-write-contract spec "门(写面)") — the first
// consumer of `db/write-gate.ts`'s three-judgment check. `remember`'s own
// segment-field surface (append/replace, both Working State and content/
// insight): each call runs the gate for the ONE field it is about to touch,
// INSIDE the same write transaction as the field mutation and the stamp that
// follows it — no gap between the check passing and the write landing.
// ---------------------------------------------------------------------------

/**
 * `null` when the write may proceed (either the gate admits it, or `writer`
 * is unknown — the same "unknown always admits" latitude `note`'s own
 * cross-session guard gives an unidentified caller, since there is no writer
 * to attribute a stamp or a rejection to). Otherwise the rejection message,
 * already distinguishing "never-read" from "stale" in its own text.
 */
function checkSegmentFieldGate(
  db: Database,
  writer: string | null,
  segmentId: number,
  field: SegmentEditableField,
): string | null {
  if (!writer) {
    return null;
  }
  const verdict = checkFieldGate(db, writer, "segment", segmentId, field, `E${segmentId}`);
  return verdict.ok ? null : verdict.message;
}

function stampSegmentField(
  db: Database,
  writer: string | null,
  segmentId: number,
  field: SegmentEditableField,
  nowEpoch: number,
): void {
  if (writer) {
    stampField(db, "segment", segmentId, field, writer, nowEpoch);
  }
}

function callerWriterId(callerSessionId: number | null | undefined): string | null {
  return typeof callerSessionId === "number" ? sessionWriterId(callerSessionId) : null;
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
  const writer = callerWriterId(options.callerSessionId);

  type AppendOutcome =
    | { kind: "gate-rejected"; message: string }
    | { kind: "missing" }
    | { kind: "ok"; segment: SegmentRecord };

  const outcome = writeTransaction(db, (): AppendOutcome => {
    const rejection = checkSegmentFieldGate(db, writer, resolution.segment.id, field);
    if (rejection) {
      return { kind: "gate-rejected", message: rejection };
    }
    const updated = appendSegmentWorkingStateRows(db, resolution.segment.id, field, rows, nowEpoch);
    if (!updated) {
      return { kind: "missing" };
    }
    stampSegmentField(db, writer, resolution.segment.id, field, nowEpoch);
    return { kind: "ok", segment: updated };
  });

  if (outcome.kind === "gate-rejected") {
    return parameterError(outcome.message);
  }
  if (outcome.kind === "missing") {
    return parameterError(`E${resolution.segment.id} no longer exists.`);
  }
  const updated = outcome.segment;

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
  const writer = callerWriterId(options.callerSessionId);

  type ReplaceOutcome =
    | { kind: "gate-rejected"; message: string }
    | { kind: "replaced"; result: ReplaceSegmentWorkingStateFieldResult };

  const outcome = writeTransaction(db, (): ReplaceOutcome => {
    const rejection = checkSegmentFieldGate(db, writer, resolution.segment.id, field);
    if (rejection) {
      return { kind: "gate-rejected", message: rejection };
    }
    const result = replaceInSegmentWorkingStateField(
      db,
      resolution.segment.id,
      field,
      oldString,
      newString,
      nowEpoch,
    );
    if (result.segment && !result.rejection) {
      stampSegmentField(db, writer, resolution.segment.id, field, nowEpoch);
    }
    return { kind: "replaced", result };
  });

  if (outcome.kind === "gate-rejected") {
    return parameterError(outcome.message);
  }
  const { result } = outcome;

  if (!result.segment) {
    return parameterError(`E${resolution.segment.id} no longer exists.`);
  }
  if (result.rejection === "missing") {
    return parameterError(
      `oldString ${JSON.stringify(oldString)} not found in ${field} on E${resolution.segment.id}.`,
    );
  }
  if (result.rejection === "ambiguous") {
    return parameterError(
      `oldString ${JSON.stringify(oldString)} matches ${result.occurrences} times in ${field} on ` +
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
// assign
// ---------------------------------------------------------------------------

/**
 * Ticket 02 (ownership-and-note-cadence spec): `assign`'s own turn-token
 * grammar — an interval (`S<session>/T<a>..T<b>`, inclusive, EVERY prompt
 * number in range must resolve) or a list of individual turn addresses. Both
 * shapes share one array parameter (`turns`); a caller mixing the two forms
 * in one array is not rejected, just unusual — each element is parsed on its
 * own.
 */
const ASSIGN_RANGE_PATTERN = /^S(\d+)\/T(\d+)\.\.T(\d+)$/i;

interface AssignTokenRejection {
  raw: string;
  reason: "malformed" | "not-a-turn" | "unresolved";
  /** Present for a range whose span names a specific missing turn. */
  detail?: string;
}

const ASSIGN_TOKEN_REJECTION_TEXT: Record<AssignTokenRejection["reason"], string> = {
  malformed:
    'is not a valid turn address ("S<session>/T<prompt>") or interval ("S<session>/T<a>..T<b>")',
  "not-a-turn": "names a segment, not a turn",
  unresolved: "does not resolve to a turn",
};

function formatAssignRejections(rejections: readonly AssignTokenRejection[]): string {
  return (
    "turns rejected: " +
    rejections
      .map(
        (entry) =>
          `"${entry.raw}" ${entry.detail ?? ASSIGN_TOKEN_REJECTION_TEXT[entry.reason]}`,
      )
      .join("; ") +
    " — the whole call is rejected, zero turns assigned."
  );
}

/**
 * Resolves `assign`'s `turns` tokens to database turn ids, de-duplicated,
 * first-seen order. Zero partial writes (ticket 02 acceptance criterion): an
 * interval spanning even one missing prompt number, or a malformed/
 * unresolved individual address, rejects the WHOLE list — the caller gets
 * every problem found, not just the first, so it can fix them in one pass.
 */
function resolveAssignTurns(
  db: Database,
  tokens: readonly string[],
): { turnIds: number[]; rejections: AssignTokenRejection[] } {
  const rejections: AssignTokenRejection[] = [];
  const turnIds: number[] = [];
  const seen = new Set<number>();

  for (const raw of tokens) {
    const trimmed = raw.trim();
    const rangeMatch = ASSIGN_RANGE_PATTERN.exec(trimmed);
    if (rangeMatch) {
      const sessionId = Number.parseInt(rangeMatch[1]!, 10);
      const start = Number.parseInt(rangeMatch[2]!, 10);
      const end = Number.parseInt(rangeMatch[3]!, 10);
      if (
        !Number.isSafeInteger(sessionId) ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        end < start
      ) {
        rejections.push({ raw, reason: "malformed" });
        continue;
      }
      for (let promptNumber = start; promptNumber <= end; promptNumber += 1) {
        // A bare id lookup — the only thing an interval needs is existence
        // and the row id, the same minimal query `db/references.ts`'s
        // `validateReferences` already uses for a single address, rather
        // than the fuller `getTurn` (db/turns.ts) this module has no other
        // reason to depend on.
        const row = db
          .query<{ id: number }, [number, number]>(
            "SELECT id FROM turns WHERE session_id = ? AND prompt_number = ?",
          )
          .get(sessionId, promptNumber);
        if (!row) {
          rejections.push({
            raw,
            reason: "unresolved",
            detail: `spans a missing turn S${sessionId}/T${promptNumber}`,
          });
          continue;
        }
        if (!seen.has(row.id)) {
          seen.add(row.id);
          turnIds.push(row.id);
        }
      }
      continue;
    }

    const parsed = parseBareAddressReference(trimmed);
    if (!parsed) {
      rejections.push({ raw, reason: "malformed" });
      continue;
    }
    if (parsed.kind !== "turn") {
      rejections.push({ raw, reason: "not-a-turn" });
      continue;
    }
    const { accepted, rejected } = validateReferences(db, [parsed]);
    if (rejected.length > 0) {
      rejections.push({ raw, reason: "unresolved" });
      continue;
    }
    const id = accepted[0]!.node.id;
    if (!seen.has(id)) {
      seen.add(id);
      turnIds.push(id);
    }
  }

  return { turnIds, rejections };
}

/**
 * `remember`'s `assign` verb (ticket 02, ownership-and-note-cadence spec):
 * the main agent's own ownership channel. `id="E<n>"` (or a topic name)
 * places the named turns in that segment; `id` OMITTED clears ownership —
 * the named turns become homeless. Single ownership is the WRITE path's own
 * invariant (`reassignSegmentMembers`, db/segments.ts): a turn already
 * belonging elsewhere is moved, not duplicated, in the same transaction.
 */
function handleAssign(
  db: Database,
  input: RememberToolInput,
  options: RememberToolOptions,
): ToolTextResult {
  let targetSegment: SegmentRecord | null = null;
  if (input.id !== undefined) {
    if (typeof input.id !== "string" || input.id.trim() === "") {
      return parameterError(
        'id must be a non-empty "E<n>" address or topic name when present — omit id entirely to clear ownership.',
      );
    }
    const resolution = resolveSegmentTarget(db, input.id);
    if (!resolution.ok) {
      return parameterError(resolution.message);
    }
    targetSegment = resolution.segment;
  }

  if (
    !Array.isArray(input.turns) ||
    input.turns.length === 0 ||
    !input.turns.every((value) => typeof value === "string")
  ) {
    return parameterError(
      'turns is required for assign — an array of turn addresses ("S<session>/T<prompt>") or one interval ("S<session>/T<a>..T<b>").',
    );
  }

  const { turnIds, rejections } = resolveAssignTurns(db, input.turns as string[]);
  if (rejections.length > 0) {
    return parameterError(formatAssignRejections(rejections));
  }
  if (turnIds.length === 0) {
    return parameterError("turns resolved to zero addresses.");
  }

  const nowEpoch = options.now?.() ?? Math.floor(Date.now() / 1000);
  const writeTransaction = options.runWriteTransaction ?? runWriteTransaction;
  const result = writeTransaction(db, () =>
    reassignSegmentMembers(db, turnIds, targetSegment?.id ?? null, nowEpoch),
  );

  const parts: string[] = [
    targetSegment
      ? `Assigned ${result.addedTurnIds.length} turn(s) to E${targetSegment.id}.`
      : `Cleared ownership on ${turnIds.length} turn(s) — now homeless.`,
  ];
  if (result.vacatedSegmentIds.length > 0) {
    parts.push(
      `Removed from prior segment(s): ${result.vacatedSegmentIds
        .map((id) => `E${id}`)
        .join(", ")}.`,
    );
  }
  return textResult(parts.join(" "));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * `remember` — the segment (semantic) write surface, revived beside `note`
 * (episodic) per ADR-0002. Six verbs, one tool: `create` mints a segment
 * from the roster the caller has in view; `attach` binds the current session
 * to one and returns its fields; `append`/`replace` maintain one named
 * field (Working State, or content/insight); `close` toggles the segment off
 * (or back onto) the roster; `assign` (ticket 02) places or clears turn
 * ownership.
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
    case "assign":
      return handleAssign(db, rawInput, options);
  }
}
