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
  getSegment,
  reassignSegmentMembers,
  replaceInSegmentWorkingStateField,
  segmentEditableFieldValue,
  toggleSegmentStatus,
  writeSegmentWorkingStateField,
  type ReplaceSegmentWorkingStateFieldResult,
  type SegmentRecord,
} from "../db/segments";
import { countTurnsSince, touchSessionRememberActivity } from "../db/sessions";
import {
  checkFieldGate,
  sessionWriterId,
  stampField,
  type FieldGateOptions,
} from "../db/write-gate";
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
  | "write"
  | "edit"
  | "close"
  | "assign";
const REMEMBER_VERBS: readonly RememberVerb[] = [
  "create",
  "attach",
  "write",
  "edit",
  "close",
  "assign",
];

// Ticket 05 (write-mode-edit-semantics, spec D1/D14): `append`/`replace`
// retired — a caller still sending either gets this message naming the
// replacement, instead of the generic "verb must be one of ..." the plain
// `REMEMBER_VERBS` membership check below would otherwise give (same
// precedent `note.ts`'s own `RETIRED_FIELD_MODE_REPLACEMENT` follows for
// `mode.<field>`'s retired literals). `definitions.ts`'s own schema-layer
// superRefine gives the identical message for a call that goes through the
// real MCP validation path; this is the belt-and-braces copy for the
// hand-rolled path most of this file's own tests call directly.
const RETIRED_REMEMBER_VERB_REPLACEMENT: Record<string, string> = {
  append:
    "use `write` (replace the field whole) or `edit` (anchor the last row and add to it) instead.",
  replace: "use `edit` instead — same oldString/newString shape.",
};

// Ticket 09 (spec "write-mode-edit-semantics"): the verbs that write a
// segment FIELD — `create` (it seeds title and, when given, the goal row)
// and the field-writing verbs proper (`write`/`edit`, ticket 05's rename of
// `append`/`replace`). `attach`/`close`/`assign` move a segment between
// roster states or sessions without touching any of its fields, so they are
// deliberately excluded — see `touchSessionRememberActivity`'s call site
// below.
const FIELD_WRITING_VERBS: readonly RememberVerb[] = ["create", "write", "edit"];

function isFieldWritingVerb(verb: RememberVerb): boolean {
  return FIELD_WRITING_VERBS.includes(verb);
}

export interface RememberToolInput {
  verb?: unknown;
  // create
  title?: unknown;
  goal?: unknown;
  members?: unknown;
  // attach / write / edit / close / assign share `id` — a segment's
  // `E<n>` address (ticket 15: the topic-name fallback retired). `assign`
  // alone treats `id` as OPTIONAL: omitted means "clear ownership" (ticket 02).
  id?: unknown;
  // write / edit
  field?: unknown;
  // write (ticket 05): the field's whole replacement text; null (or "")
  // clears it.
  value?: unknown;
  // edit (ticket 05's rename of replace)
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
   * requires it (there is nothing to bind without a session); `write`/
   * `edit` degrade gracefully — the write still lands, the maintenance
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
 * The one prose-field resolver `create`'s title/goal both go through:
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
// Segment targeting — shared by attach/append/replace/close/assign (ticket
// 15: the topic registry retired, so `id` resolves ONLY as a segment address
// — every verb that used to fall back to a topic name now rejects a
// non-address string, echoing the address grammar).
// ---------------------------------------------------------------------------

type SegmentTargetResolution =
  | { ok: true; segment: SegmentRecord }
  | { ok: false; message: string };

function resolveSegmentTarget(db: Database, rawId: string): SegmentTargetResolution {
  const trimmed = rawId.trim();
  const bareRef = parseBareAddressReference(trimmed);

  if (!bareRef || bareRef.kind !== "segment") {
    return {
      ok: false,
      message: `id must be a segment address ("E<n>") — got "${trimmed}".`,
    };
  }
  const segment = getSegment(db, bareRef.segmentId);
  if (!segment) {
    return { ok: false, message: `no segment E${bareRef.segmentId}.` };
  }
  return { ok: true, segment };
}

// ---------------------------------------------------------------------------
// Maintenance cadence receipt (ADR-0002) — advisory, never a gate.
// ---------------------------------------------------------------------------

function formatMaintenanceCadence(
  db: Database,
  callerSessionId: number | null | undefined,
  priorUpdatedAtEpoch: number,
): string {
  if (typeof callerSessionId !== "number") {
    return "maintenance cadence: caller session unknown.";
  }
  const turnsSince = countTurnsSince(db, callerSessionId, priorUpdatedAtEpoch);
  const label = `${turnsSince} turn${turnsSince === 1 ? "" : "s"}`;
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
  memberTurnIds: number[];
  goalSeeded: boolean;
}

function handleCreate(
  db: Database,
  input: RememberToolInput,
  options: RememberToolOptions,
): ToolTextResult {
  let title: string;
  let goal: string | null;
  let memberAddresses: string[];
  try {
    title = resolveProseField("title", input.title, { required: true })!;
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

      let segment = createSegment(db, {
        title,
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

      return { segment, memberTurnIds: turnIds, goalSeeded };
    });
  } catch (error) {
    if (error instanceof RememberValidationError) {
      return parameterError(error.message);
    }
    throw error;
  }

  const parts = [`Created E${result.segment.id} "${result.segment.title}".`];
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
    return parameterError('id is required for attach — an "E<n>" address.');
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
// write / edit (ticket 05, write-mode-edit-semantics: the vocabulary switch
// — `write` replaces a segment field whole, `edit` swaps an exactly-matched
// span within it, retiring `append`/`replace`)
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
 * already distinguishing "never-read" from "stale" — and, ticket 06, from
 * "read but not in full" — in its own text.
 */
function checkSegmentFieldGate(
  db: Database,
  writer: string | null,
  segmentId: number,
  field: SegmentEditableField,
  options: FieldGateOptions = {},
): string | null {
  if (!writer) {
    return null;
  }
  const verdict = checkFieldGate(
    db,
    writer,
    "segment",
    segmentId,
    field,
    `E${segmentId}`,
    options,
  );
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

/**
 * `remember`'s `write` verb (ticket 05, spec D2/D11): whole-field
 * replacement, the segment surface's first capability of this shape — wired
 * onto `writeSegmentWorkingStateField` (db/segments.ts, ticket 03's
 * prefactor), which already carries the citation-rebuild and FTS-reindex
 * duties this replaces. Supplied verbatim, no bullet-list normalization: the
 * row-list convention still stands (ADR-0001), but `write` is for the
 * caller who has read a field whole and is handing back the finished text —
 * see the tool description's row-add idiom for the alternative when only
 * one row needs to change.
 */
function handleWrite(
  db: Database,
  input: RememberToolInput,
  options: RememberToolOptions,
): ToolTextResult {
  if (typeof input.id !== "string" || input.id.trim() === "") {
    return parameterError('id is required for write — an "E<n>" address.');
  }
  if (!isEditableField(input.field)) {
    return parameterError(fieldRequiredMessage());
  }
  if (input.value === undefined) {
    return parameterError(
      "value is required for write — the field's full replacement text, or null to clear it.",
    );
  }
  if (input.value !== null && typeof input.value !== "string") {
    return parameterError("value must be a string or null when present.");
  }

  const resolution = resolveSegmentTarget(db, input.id);
  if (!resolution.ok) {
    return parameterError(resolution.message);
  }
  if (resolution.segment.status === "closed") {
    return parameterError(closedSegmentRejection(resolution.segment.id));
  }

  const field = input.field;
  let value: string | null;
  try {
    if (input.value === null) {
      value = null;
    } else {
      const decoded = decodeHtmlEntities(input.value);
      if (containsToolCallSyntax(decoded)) {
        fail(toolCallSyntaxMessage("value"));
      }
      value = decoded.trim() === "" ? null : stripPrivateTags(decoded);
    }
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

  type WriteOutcome =
    | { kind: "gate-rejected"; message: string }
    | { kind: "missing" }
    | { kind: "ok"; segment: SegmentRecord };

  const outcome = writeTransaction(db, (): WriteOutcome => {
    // Ticket 06 (spec D2): "does this field already hold something" is read
    // INSIDE the transaction, not off the pre-transaction `resolution`
    // snapshot — the same "检查-写入原子" discipline the gate check itself
    // follows, so a field that gained content between the two cannot be
    // overwritten under an exemption that was true a moment earlier.
    const fresh = getSegment(db, resolution.segment.id);
    if (!fresh) {
      return { kind: "missing" };
    }
    const existing = segmentEditableFieldValue(fresh, field);
    const rejection = checkSegmentFieldGate(db, writer, resolution.segment.id, field, {
      // `write` replaces the field whole, so anything currently there that
      // this writer's read did not show is what it would silently delete.
      // An empty field (never written, or cleared) has nothing to lose.
      requireCompleteRead: existing !== null && existing.trim() !== "",
      // The card's field rows are elided against `pageBudget` (segment-card.ts's
      // ladder), not against recall's per-item `turn` cap — so the segment
      // surface names its OWN knob here rather than inheriting the gate's
      // generic wording.
      completeReadRemedy:
        `re-read it whole with recall(id="E${resolution.segment.id}", ` +
        `pageBudget=<a bigger token budget>),`,
    });
    if (rejection) {
      return { kind: "gate-rejected", message: rejection };
    }
    const updated = writeSegmentWorkingStateField(db, resolution.segment.id, field, value, nowEpoch);
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

  const cadence = formatMaintenanceCadence(
    db,
    options.callerSessionId,
    priorUpdatedAtEpoch,
  );

  const verb = value === null ? "Cleared" : "Wrote";
  return textResult(`${verb} ${field} on E${updated.id}. ${cadence}`);
}

// ---------------------------------------------------------------------------
// edit (ticket 05's rename of replace — identical oldString/newString shape)
// ---------------------------------------------------------------------------

function handleEdit(
  db: Database,
  input: RememberToolInput,
  options: RememberToolOptions,
): ToolTextResult {
  if (typeof input.id !== "string" || input.id.trim() === "") {
    return parameterError('id is required for edit — an "E<n>" address.');
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
    // Ticket 06 (spec D3/D5/D6): `edit` runs the SAME three judgments —
    // authorization and staleness are not relaxed for it — and only the
    // complete-read requirement is left off, because an exact-match swap
    // never touches the rows a truncated render hid.
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
    return parameterError('id is required for close — an "E<n>" address.');
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
// The second endpoint's `T` is optional: recall ranges write `T3..7`, this
// grammar wrote `T3..T7`, and one session mixing the surfaces writes both
// ([S15069/T1021]).
const ASSIGN_RANGE_PATTERN = /^S(\d+)\/T(\d+)\.\.T?(\d+)$/i;

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
 * the main agent's own ownership channel. `id="E<n>"` places the named turns
 * in that segment; `id` OMITTED clears ownership —
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
        'id must be a non-empty "E<n>" address when present — omit id entirely to clear ownership.',
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
 * to one and returns its fields; `write`/`edit` (ticket 05) maintain one
 * named field (Working State, or content/insight) — `write` replaces it
 * whole, `edit` swaps an exactly-matched span within it; `close` toggles the
 * segment off (or back onto) the roster; `assign` (ticket 02) places or
 * clears turn ownership.
 */
/** The one shape every handler's rejection takes — see `parameterError` above. */
function isParameterError(result: ToolTextResult): boolean {
  return result.content[0]?.text.startsWith("Parameter error:") ?? false;
}

export function rememberTool(
  db: Database,
  rawInput: RememberToolInput,
  options: RememberToolOptions = {},
): ToolTextResult {
  if (typeof rawInput.verb !== "string") {
    return parameterError(`verb must be one of ${REMEMBER_VERBS.join(", ")}.`);
  }
  // Ticket 05 (spec D14): checked before the closed-vocabulary membership
  // test below, so a retired verb gets its replacement named instead of the
  // generic "verb must be one of ..." list.
  const retiredReplacement = RETIRED_REMEMBER_VERB_REPLACEMENT[rawInput.verb];
  if (retiredReplacement) {
    return parameterError(`verb "${rawInput.verb}" has retired — ${retiredReplacement}`);
  }
  if (!REMEMBER_VERBS.includes(rawInput.verb as RememberVerb)) {
    return parameterError(`verb must be one of ${REMEMBER_VERBS.join(", ")}.`);
  }

  const result = ((): ToolTextResult => {
    switch (rawInput.verb as RememberVerb) {
      case "create":
        return handleCreate(db, rawInput, options);
      case "attach":
        return handleAttach(db, rawInput, options);
      case "write":
        return handleWrite(db, rawInput, options);
      case "edit":
        return handleEdit(db, rawInput, options);
      case "close":
        return handleClose(db, rawInput, options);
      case "assign":
        return handleAssign(db, rawInput, options);
    }
  })();

  // Ticket 09 (spec "write-mode-edit-semantics"): only a successful
  // FIELD-WRITING call resets the universal 20-turn `remember` check
  // (hooks/note-reminder.ts renders it off `sessions.last_remember_turn_id` —
  // a turn ROW ID anchor, 0.12.1: epochs cannot order same-second turns).
  // `attach`/`close`/`assign` bind, toggle, or re-own a segment without
  // touching any of its fields, so a session that only ever calls those still
  // gets nudged after 20 turns — narrower than ticket 13's original "any of
  // the six verbs," which reset the clock even for a session that never
  // wrote a field. "Since last remember call" is a session-scoped fact no
  // existing column carries — create/close/assign do not attribute a caller
  // session on their own write paths at all — so this is the one new column
  // ticket 13 added. A parameter-error call is not a "call" for this
  // purpose either: nothing was checked or written, so a rejected attempt
  // must not reset the clock.
  if (
    typeof options.callerSessionId === "number" &&
    !isParameterError(result) &&
    isFieldWritingVerb(rawInput.verb as RememberVerb)
  ) {
    touchSessionRememberActivity(db, options.callerSessionId);
  }

  return result;
}
