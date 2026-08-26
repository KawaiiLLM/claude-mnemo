import type { Database } from "bun:sqlite";

import {
  RELATION_FIELD_ENTRIES,
  RETRACTION_FIELD_ENTRIES,
  recomputeTurnCitedPairs,
  type RecomputeTurnCitedPairsResult,
} from "../db/citations";
import { runWriteTransaction } from "../db/database";
import {
  closeNoteDebtAsDeclined,
  closeNoteDebtAsNoted,
  getNoteDebt,
  recordDeclinedNoteDebt,
} from "../db/note-debt";
import { parseBareAddressReference } from "../db/references";
import {
  attachSegmentToSession,
  getOwningSegmentId,
  isSegmentDetachedFromSession,
} from "../db/segments";
import { renderSegmentLaneVocabulary } from "./lane-vocabulary";
import { renderSegmentCard } from "./segment-card";
import { checkTurnTagWrite } from "../db/turn-tag-gate";
import { getShadowNote, upsertShadowNote } from "../db/shadow-notes";
import {
  getTurn,
  getTurnById,
  promoteTurnFromNote,
  updateTurnById,
  type TurnRecord,
} from "../db/turns";
import {
  checkFieldGate,
  checkTurnLiveForWrite,
  sessionWriterId,
  stampField,
} from "../db/write-gate";
import {
  decodeHtmlEntities,
  FieldModeError,
  fieldModeErrorMessage,
  isFieldEditMode,
  modeRequiredMessage,
  parseModeMap,
  resolveStringField,
  type FieldEditMode,
  type FieldMode,
  type FieldResolution,
} from "./field-mode";
import { isSegmentEra } from "../segment-era";
import { formatBudgetWarning, formatNoteBudget } from "../shared/note-budget";
import {
  findRetiredTopicTag,
  retiredTopicTagMessage,
  stripPrivateTags,
} from "../shared/tag-stripping";
import { clearToolCallSyntaxRejections } from "../shared/tool-call-syntax";
import {
  MEMORY_TYPES,
  normalizeTypeValues,
  typeListsEqual,
} from "../shared/type-vocabulary";

type ToolTextResult = {
  content: Array<{
    type: "text";
    text: string;
  }>;
};

// The one mode vocabulary (write-mode-edit-semantics spec D1/D3/D4/D10/D14) —
// folded into `field-mode.ts` (ticket 07) so both write surfaces share one
// copy; re-exported here so existing importers of these two types keep
// working.
export type { FieldEditMode, FieldMode } from "./field-mode";

// ticket 01 (ADR-0003): `grade` left this list along with the parameter
// itself — the writer records facts, settlement assigns value.
const TURN_MODE_FIELDS = ["title", "content", "insight", "type", "tags"] as const;
type TurnModeField = (typeof TURN_MODE_FIELDS)[number];

function hasText(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Ticket 06 (spec D2): does this call's write to `field` land ON TOP of
 * content already there? Only then does the gate additionally demand that
 * the authorizing render delivered the field whole
 * (`FieldGateOptions.requireCompleteRead`).
 *
 * Three separate exemptions, all of them "there is nothing here to lose":
 * the edit form (it replaces only the span it matched, spec D3), an absent
 * mode (a non-empty field with no mode never gets this far — the resolvers'
 * own `modeRequiredMessage` refuses it, and letting that message win keeps
 * the more specific diagnosis), and an empty field.
 *
 * Prose emptiness is read from BOTH stores this write would replace — the
 * shadow note (the resolvers' own edit baseline) and the promoted `turns`
 * row — because a `write` overwrites both. They agree for everything `note`
 * itself wrote; taking either as "occupied" keeps the requirement honest for
 * a turn whose prose reached `turns` by some other path.
 */
export function writeOverwritesExistingTurnContent(
  field: TurnModeField,
  turn: TurnRecord,
  note: { title: string | null; content: string | null; insight: string | null } | null,
  mode: FieldMode | undefined,
): boolean {
  if (mode !== "write") {
    return false;
  }
  switch (field) {
    case "type":
      return turn.type.length > 0;
    case "tags":
      return turn.tags.length > 0;
    case "title":
      return hasText(note?.title) || hasText(turn.title);
    case "content":
      return hasText(note?.content) || hasText(turn.content);
    case "insight":
      return hasText(note?.insight) || hasText(turn.insight);
  }
}

/**
 * Ticket 06 (spec D8: "拒绝报文必须指名是哪个字段被截断、补救动作是什么"):
 * the read that actually brings THIS field back whole on the turn surface.
 *
 * Ticket 12 (edge-mechanism-revision spec, [S15069/T1135]): `metadata` — and
 * therefore `type`/`tags`, which render on its one line (mcp/format.ts's
 * `composeTurnMetadata`) — joined `DEFAULT_TURN_RENDER_FIELDS`, so a PLAIN
 * recall now earns type/tags completeness the same way it already did for
 * title/content; the explicit `filter={fields:["metadata"]}` narrowing this
 * remedy used to prescribe as the ONLY path is now just the fallback for a
 * caller whose own prior read had narrowed `filter.fields` away from
 * metadata — the field-selection mechanism itself is unchanged and still
 * worth naming, just no longer the default recipe.
 */
export function completeReadRemedyForTurnField(
  field: TurnModeField,
  address: string,
): string {
  if (field === "type" || field === "tags") {
    return (
      `re-read it whole with recall(id="${address}", turn=<a bigger token budget>) ` +
      `(type and tags render on the metadata line, included by default; add ` +
      `filter={fields:["metadata"]} only if your last read had narrowed past it),`
    );
  }
  return (
    `re-read it whole with recall(id="${address}", filter={fields:["${field}"]}, ` +
    `turn=<a bigger token budget>),`
  );
}

export interface NoteToolInput {
  // `turn` is the only address this tool accepts now (ticket 09: the
  // `session` address retired outright — settlement is the session's sole
  // writer, through its own staged-commit channel; see
  // `worker/note-settlement-turn-facade.ts`). `session` stays declared here,
  // `unknown`, ONLY so `noteTool()`'s own entry-point guard can name a
  // caller still sending it and point at settlement rather than have it
  // silently vanish as an object property TypeScript never sees.
  turn?: unknown;
  session?: unknown;

  // Turn fields.
  title?: unknown;
  content?: unknown;
  insight?: unknown;
  /** What this turn did (spec B2) — omitted or `[]` means none fit; never guessed at (spec B7). */
  type?: unknown;
  /**
   * Two closed vocabularies, and nothing else (lane-model-v12 spec D3b/D3e,
   * ticket 14): the ONE tag of the segment this turn belongs to, and the lane
   * tags DECLARED in that segment. Membership follows from the first of those
   * — `db/turn-tag-gate.ts` is the write-time check and
   * `deriveTurnSegmentMembership` is the consequence. The `topic:` namespace
   * is retired (spec B6); machine namespaces (`compact:` / `invalidated:` /
   * `delivery:`) are the hooks' and never an agent's.
   */
  tags?: unknown;
  skip?: unknown;
  crossSession?: unknown;
  /**
   * RETIRED (lane-model-v12 ticket 14). Membership is DERIVED from `tags`:
   * a turn belongs to whichever segment's tag it carries. Kept in this shape
   * as frozen documentation — `noteInputSchema` omits it, so a caller still
   * sending it gets a `.strict()` parse error rather than a silent no-op.
   */
  segment?: unknown;

  // RETIRED (lane-model-v12 ticket 08, ruling [S15069/T1651]: 边整块归结算).
  // The seven relation parameters and their seven `retract…` mirrors are GONE
  // from this surface — `noteInputShape` no longer declares them, so a
  // schema-validated caller gets `.strict()`'s unrecognised-key parse error,
  // and `noteTool()`'s own entry guard names settlement for a caller that
  // reaches this function without the schema in front (see `EDGE_PARAMETERS`).
  // An edge is settlement's whole business now: it is the side with hindsight
  // about which lane a turn belongs to, and a relation written before that
  // judgment exists is the thing the measured 92.1%-adjacent-predecessor
  // result (spec D3d) says the main agent actually produces.

  // D5/D5a: per-field mode, required whenever the target field is currently
  // non-empty. One object, shared vocabulary across every field of both
  // addressing surfaces.
  mode?: unknown;
}

export interface NoteToolOptions {
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  /** Injected for tests: lets a race with a concurrent reconcile be simulated. */
  runWriteTransaction?: typeof runWriteTransaction;
  /**
   * P2 era boundary (spec D11/D12), resolved by the handler layer and never
   * read from config here. Absent or `null` = every turn is legacy, which is
   * the P1 behaviour (shadow row only) and the rollback. Governs ONLY the
   * title/content/insight promotion onto `turns` — `type`/`tags` write
   * `turns` directly regardless of era, same as the retired `remember`
   * always did (the main agent needs to correct a legacy turn's type/tags
   * without a note ever promoting its prose; `grade` left this tool
   * entirely, ADR-0003 — settlement now assigns it through its own facade,
   * `worker/note-settlement-turn-facade.ts`, untouched by this option).
   */
  eraCutoffEpoch?: number | null;
  /**
   * The mnemo session the caller belongs to (spec D2), resolved ONLY by the
   * MCP process's direct-execution entry point (server.ts). Every other
   * construction path must leave this absent — see note.ts's prior history
   * for the full rationale. Absent or null both mean "unknown", and unknown
   * always admits.
   */
  callerSessionId?: number | null;
}

function textResult(text: string): ToolTextResult {
  return { content: [{ type: "text", text }] };
}

function parameterError(message: string): ToolTextResult {
  return textResult(`Parameter error: ${message}`);
}

/**
 * A note result is a successful write iff it opens with "Noted " (a first
 * write) or "Updated " (a write to a turn/session that already had one).
 * Failures are `Parameter error: …`. A declined turn answers "Skipped …",
 * which is a successful CALL but not a note, so it deliberately reads as
 * false here.
 */
export function isNoteSuccess(result: {
  content: Array<{ type: string; text?: string }>;
}): boolean {
  const text = result.content?.[0]?.text ?? "";
  return text.startsWith("Noted ") || text.startsWith("Updated ");
}

const TURN_ADDRESS_PATTERN = /^S(\d+)\/T(\d+)$/i;
const SESSION_ADDRESS_PATTERN = /^S(\d+)$/i;

interface TurnAddress {
  sessionId: number;
  promptNumber: number;
}

export function parseTurnAddress(value: string): TurnAddress | null {
  const match = TURN_ADDRESS_PATTERN.exec(value.trim());
  if (!match) {
    return null;
  }

  const sessionId = Number.parseInt(match[1]!, 10);
  const promptNumber = Number.parseInt(match[2]!, 10);
  if (!Number.isSafeInteger(sessionId) || !Number.isSafeInteger(promptNumber)) {
    return null;
  }

  return { sessionId, promptNumber };
}

// Exported (ticket 09): the note tool's own session address retired, but the
// address FORMAT ("S<n>") is still what settlement's own session-narrative
// write parses (worker/note-settlement-turn-facade.ts) — one parser, not a
// second hand-kept copy of the same regex.
export function parseSessionAddress(value: string): number | null {
  const match = SESSION_ADDRESS_PATTERN.exec(value.trim());
  if (!match) {
    return null;
  }
  const sessionId = Number.parseInt(match[1]!, 10);
  return Number.isSafeInteger(sessionId) ? sessionId : null;
}

const WRITER_MODEL_ENV_KEYS = [
  "CLAUDE_MNEMO_WRITER_MODEL",
  "ANTHROPIC_MODEL",
  "CLAUDE_CODE_MODEL",
] as const;

export function resolveWriterModel(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  for (const key of WRITER_MODEL_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function getSessionCurrentTurn(
  db: Database,
  sessionId: number,
): { id: number } | null {
  const row = db
    .query<{ id: number }, [number]>(
      `SELECT id FROM turns
       WHERE session_id = ? AND status != 'undone'
       ORDER BY prompt_number DESC LIMIT 1`,
    )
    .get(sessionId);

  return row ?? null;
}

function getRidePromptNumber(db: Database, turnId: number): number | null {
  return (
    db
      .query<{ promptNumber: number }, [number]>(
        "SELECT prompt_number AS promptNumber FROM turns WHERE id = ?",
      )
      .get(turnId)?.promptNumber ?? null
  );
}

function compactMarkerMessage(address: TurnAddress): string {
  return (
    `S${address.sessionId}/T${address.promptNumber} is a compact marker, not a turn` +
    " — there is nothing to note or skip."
  );
}

function crossSessionRequiredMessage(
  address: TurnAddress,
  callerSessionId: number,
): string {
  return (
    `S${address.sessionId}/T${address.promptNumber} belongs to a different session` +
    ` than this call (S${callerSessionId}).` +
    " Resend with crossSession: true to confirm the cross-session write."
  );
}

function isCrossSessionWrite(
  callerSessionId: number | null | undefined,
  addressSessionId: number,
): boolean {
  return (
    typeof callerSessionId === "number" && callerSessionId !== addressSessionId
  );
}

/**
 * Backstop for fix #1: the memory agent reliably names the predecessor turn's
 * DB id but, when the reference is woven mid-sentence ("reverted in T4244",
 * "(T4243)"), writes it bare instead of the bracketed `[T<n>]` form the
 * timeline resolver and recall key on. Ported from the retired `remember.ts` —
 * every turn write goes through one content path now, so the convenience
 * applies uniformly rather than only to the addressing scheme that used to
 * reach it.
 */
export function bracketBareTurnReferences(
  content: string,
  isValidPredecessor: (candidateId: number) => boolean,
): string {
  if (!content) {
    return content;
  }
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

// `decodeHtmlEntities` (with `HTML_ENTITY_MAP`) moved to `field-mode.ts`
// (ticket 07) so both write surfaces share one copy; re-exported here so
// `mcp/remember.ts`'s existing import keeps working.
export { decodeHtmlEntities } from "./field-mode";

// Extends `FieldModeError` (not `Error`) so the catch sites below, which test
// `instanceof FieldModeError`, catch both what this file's own `fail()`
// throws and what the imported field-mode functions throw.
class NoteValidationError extends FieldModeError {}

function fail(message: string): never {
  throw new NoteValidationError(message);
}

function resolveTypeField(
  provided: unknown,
  existing: readonly string[],
  mode: FieldMode | undefined,
): FieldResolution<string[]> | undefined {
  if (provided === undefined) {
    return undefined;
  }
  if (!Array.isArray(provided) || provided.some((value) => typeof value !== "string")) {
    fail("type must be an array of strings when present.");
  }
  let normalized: string[];
  try {
    normalized = normalizeTypeValues(provided as string[]);
  } catch (error) {
    fail(
      `${error instanceof Error ? error.message : String(error)}. Allowed: ${MEMORY_TYPES.join(", ")}.`,
    );
  }
  // Ticket 05 (spec D4): `mode.type` can only be `undefined` or `"write"` by
  // the time this runs — `parseModeMap` refuses the edit form on a set field
  // before it ever reaches here — so there is no merge/union branch any
  // more: a non-empty `type` always needs `mode.type: "write"` and always
  // means the full replacement set (the accepted cost of D4's ruling).
  const isEmpty = existing.length === 0;
  if (!isEmpty && mode === undefined) {
    fail(modeRequiredMessage("type"));
  }
  return { value: normalized };
}

function resolveTagsField(
  provided: unknown,
  existing: readonly string[],
  mode: FieldMode | undefined,
): FieldResolution<string[]> | undefined {
  if (provided === undefined) {
    return undefined;
  }
  if (!Array.isArray(provided) || provided.some((value) => typeof value !== "string")) {
    fail("tags must be an array of strings when present.");
  }
  const decoded = (provided as string[]).map((tag) => decodeHtmlEntities(tag));
  const retired = findRetiredTopicTag(decoded);
  if (retired !== null) {
    fail(retiredTopicTagMessage(retired));
  }
  // Ticket 05 (spec D4) — see the identical note on `resolveTypeField` above.
  const isEmpty = existing.length === 0;
  if (!isEmpty && mode === undefined) {
    fail(modeRequiredMessage("tags"));
  }
  return { value: decoded };
}

/**
 * The edge parameters this surface RETIRED (lane-model-v12 ticket 08). Kept
 * as a list rather than deleted outright so `noteTool()`'s entry guard can
 * name the one a caller still sent and point it at the writer that owns
 * edges now — the same belt-and-braces treatment `session`'s own retirement
 * gets one function below, for a caller that reaches `noteTool()` directly
 * without `noteInputSchema` in front of it.
 *
 * DERIVED from `db/citations.ts`'s own field tables, so a relation added to
 * the vocabulary tomorrow is a parameter this guard already knows to refuse
 * rather than one it silently accepts and drops.
 */
const EDGE_PARAMETERS: readonly string[] = [
  ...RELATION_FIELD_ENTRIES.map(([key]) => key),
  ...RETRACTION_FIELD_ENTRIES.map(([key]) => key),
];

// ---------------------------------------------------------------------------
// Decline (skip)
// ---------------------------------------------------------------------------

type DeclineOutcome =
  | { kind: "declined" }
  | { kind: "already-noted" }
  | { kind: "already-settled"; settledAs: string };

function declineTurn(
  db: Database,
  address: TurnAddress,
  options: NoteToolOptions,
  crossSession: boolean,
): ToolTextResult {
  const turn = getTurn(db, address.sessionId, address.promptNumber);
  if (!turn) {
    return parameterError(
      `no turn at S${address.sessionId}/T${address.promptNumber}. Use an address copied from a reminder or from injected context.`,
    );
  }

  if (turn.type.includes("compact")) {
    return parameterError(compactMarkerMessage(address));
  }

  if (isCrossSessionWrite(options.callerSessionId, turn.sessionId) && !crossSession) {
    return parameterError(
      crossSessionRequiredMessage(address, options.callerSessionId as number),
    );
  }

  const nowEpoch = options.now?.() ?? Math.floor(Date.now() / 1000);
  const writeTransaction = options.runWriteTransaction ?? runWriteTransaction;
  const ref = `S${turn.sessionId}/T${turn.promptNumber}`;

  const outcome = writeTransaction(db, (): DeclineOutcome => {
    if (getShadowNote(db, turn.id) !== null) {
      return { kind: "already-noted" };
    }

    const debt = getNoteDebt(db, turn.id);
    if (debt === null) {
      recordDeclinedNoteDebt(db, turn, nowEpoch);
      return { kind: "declined" };
    }
    if (debt.status !== "pending") {
      return { kind: "already-settled", settledAs: debt.reason ?? debt.status };
    }

    closeNoteDebtAsDeclined(db, turn.id, nowEpoch);
    return { kind: "declined" };
  });

  switch (outcome.kind) {
    case "declined":
      return textResult(
        `Skipped ${ref}. Its debt is closed as declined and it will not be listed again;` +
          " send a real note for this turn if the material comes back.",
      );
    case "already-noted":
      return textResult(`Skipped ${ref} ignored: it already has a note.`);
    case "already-settled":
      return textResult(
        `Skipped ${ref} ignored: its debt already closed as ${outcome.settledAs}.`,
      );
  }
}

// ---------------------------------------------------------------------------
// Turn write
// ---------------------------------------------------------------------------

interface TurnWriteTransactionResult {
  turn: TurnRecord;
  noteExisted: boolean;
  touchedProse: boolean;
  finalTitle: string | null | undefined;
  finalContent: string | null | undefined;
  finalInsight: string | null | undefined;
  finalType: string[] | undefined;
  finalTags: string[] | undefined;
  citations: RecomputeTurnCitedPairsResult | null;
  stripped: boolean;
  /**
   * Ticket 14 — non-null only when this call wrote `tags`, which is the only
   * thing that can move membership now. Both ids may be `null`: `segmentId`
   * `null` means the write left the turn unowned, `priorSegmentId` `null`
   * means it had no owner to leave.
   */
  membership: { segmentId: number | null; priorSegmentId: number | null } | null;
  /**
   * Ticket 17 auto-attach (ruling [S15069/T1663]) — the segment this call
   * BOUND the caller session to, non-null only when the binding did not exist
   * before. It is the trigger for putting that segment's card in this write's
   * RETURN VALUE, which is the only channel a mid-conversation attachment has:
   * injection blocks are emitted on `SessionStart` alone, so a session that
   * attaches at turn 40 cannot be told by injection until it resumes.
   */
  autoAttachedSegmentId: number | null;
}

export function isValidPredecessorFor(
  db: Database,
  turn: { id: number; sessionId: number; promptNumber: number },
): (candidateId: number) => boolean {
  return (candidateId: number): boolean => {
    if (candidateId === turn.id) {
      return false;
    }
    const cited = getTurnById(db, candidateId);
    return (
      cited !== null &&
      cited.sessionId === turn.sessionId &&
      cited.promptNumber < turn.promptNumber
    );
  };
}

function handleTurnWrite(
  db: Database,
  address: TurnAddress,
  input: NoteToolInput,
  options: NoteToolOptions,
): ToolTextResult {
  if (input.skip !== undefined && typeof input.skip !== "boolean") {
    return parameterError("skip must be a boolean when present.");
  }
  if (
    input.crossSession !== undefined &&
    typeof input.crossSession !== "boolean"
  ) {
    return parameterError("crossSession must be a boolean when present.");
  }
  const crossSession = input.crossSession === true;
  // Declared here rather than beside its first gate use further down because
  // the tool-call-syntax rejection path (write-gate-hardening ticket 01) keys
  // its consecutive-rejection counter on it, and the first rejection that can
  // reach that path — `parseModeMap`'s edit-form check — runs before the turn
  // row is even loaded. `getTurn` below resolves THIS address, so the label is
  // the same string either way.
  const addressLabel = `S${address.sessionId}/T${address.promptNumber}`;

  if (input.skip === true) {
    return declineTurn(db, address, options, crossSession);
  }

  const turn = getTurn(db, address.sessionId, address.promptNumber);
  if (!turn) {
    return parameterError(
      `no turn at S${address.sessionId}/T${address.promptNumber}. Use an address copied from a reminder or from injected context.`,
    );
  }

  if (turn.type.includes("compact")) {
    return parameterError(compactMarkerMessage(address));
  }

  if (isCrossSessionWrite(options.callerSessionId, turn.sessionId) && !crossSession) {
    return parameterError(
      crossSessionRequiredMessage(address, options.callerSessionId as number),
    );
  }

  // Ticket 14 (lane-model-v12 spec D3e): the `segment` parameter's whole
  // validation block used to live here. It is gone — membership is derived
  // from `tags` inside the transaction below, where the gate can read the
  // tags this same call is about to store.
  let modeMap: Partial<Record<string, FieldMode>>;
  try {
    modeMap = parseModeMap(input.mode, TURN_MODE_FIELDS);
  } catch (error) {
    if (error instanceof FieldModeError) {
      return parameterError(fieldModeErrorMessage(error, addressLabel));
    }
    throw error;
  }

  // Ticket 05: a field touched ONLY through the edit form (no field value of
  // its own — D10's whole point) still has to reach the write-gate check
  // below and the pre-cutoff guard just after it. Parsed above `providedFields`
  // now (moved ahead of it, was after) so both can see it.
  const providedFields = TURN_MODE_FIELDS.filter(
    (key) =>
      (input as Record<string, unknown>)[key] !== undefined ||
      isFieldEditMode(modeMap[key]),
  );
  // The prose half of `providedFields`, named once: the pre-cutoff refusal
  // below and the dormancy exemption inside the transaction (peer round P2-3)
  // ask the same question — does this call write prose to this turn.
  const touchesProseFields = (["title", "content", "insight"] as const).some(
    (field) =>
      (input as Record<string, unknown>)[field] !== undefined ||
      isFieldEditMode(modeMap[field]),
  );
  // Ticket 14: `segment` is no longer one of the ways a call does real work —
  // a membership change IS a `tags` write now, and `tags` is already in
  // `providedFields`. Ticket 08: nor is an edge parameter — this surface has
  // none, so the five fields are the whole list again.
  if (providedFields.length === 0) {
    return parameterError(`at least one of ${TURN_MODE_FIELDS.join(", ")} is required.`);
  }

  const nowEpoch = options.now?.() ?? Math.floor(Date.now() / 1000);
  const writerModel = resolveWriterModel(options.env ?? process.env);
  const current = getSessionCurrentTurn(db, turn.sessionId);
  const rideTurnId = current?.id ?? null;
  const writeTransaction = options.runWriteTransaction ?? runWriteTransaction;
  const promotesTurnRecord = isSegmentEra(turn.createdAtEpoch, options.eraCutoffEpoch);
  // Write gate (ticket 03, read-write-contract spec "受管面"): the caller's
  // own write-gate identity, `null` when unknown — the same "unknown always
  // admits" latitude the crossSession guard above already gives it. Covers
  // BOTH cross- and same-session writes uniformly (no special-case bypass
  // for same-session — the three-judgment check's own rule 2/3 admit a
  // first write or a self-rewrite without ever needing a grant).
  const writer =
    typeof options.callerSessionId === "number"
      ? sessionWriterId(options.callerSessionId)
      : null;

  // Prose on a pre-cutoff turn is REFUSED, not written somewhere quiet (user
  // ruling). A legacy turn never promotes, so its title/content/insight could
  // only land in `shadow_notes` — and nothing reads that table: not recall,
  // not timeline, not search, not the injected context. Only the metrics
  // tooling and the debt ledger touch it. So the write succeeded, answered
  // "Noted", and produced a record no reader would ever meet. Refusing says
  // the same thing the tool already says about content carrying tool-call
  // syntax (spec E2): a write whose result cannot be read is a failure, and a
  // failure must be legible at the call.
  //
  // Type and tags are NOT refused. They write `turns` directly for
  // every era and every one of them renders, so settlement can still judge a
  // pre-cutoff turn in its fifty-turn lookback. The rule is about the
  // destination, not about the turn's age.
  //
  // Safe against the debt ledger, checked before landing: pre-cutoff turns
  // carry 346 `skipped` debts and no `pending` ones in the live database, so
  // a refusal cannot strand a debt that had been waiting for a note.
  //
  // Conditional on the era being CONFIGURED. An absent or null cutoff is the
  // rollback (spec D11/D12): it means "treat every turn as legacy", and under
  // it the shadow row is the intended and only record. Refusing there would
  // turn the rollback from a safety valve into a system that cannot write a
  // note at all — which the first version of this guard did, taking 39 tests
  // with it.
  const eraConfigured =
    options.eraCutoffEpoch !== undefined && options.eraCutoffEpoch !== null;
  if (eraConfigured && !promotesTurnRecord && touchesProseFields) {
    return parameterError(
      `S${address.sessionId}/T${address.promptNumber} is a pre-cutoff turn, whose prose has no reader —` +
        " title, content and insight cannot be written to it." +
        " Its type and tags are still writable.",
    );
  }

  let result: TurnWriteTransactionResult;
  try {
    result = writeTransaction(db, (): TurnWriteTransactionResult => {
      // Both current states are read FIRST (ticket 06: they were read just
      // below before this ticket): the gate check needs to know, per field,
      // whether this write would land over existing content, and reading
      // them inside this same transaction keeps that judgment atomic with
      // the write it guards.
      const freshTurn = getTurnById(db, turn.id)!;
      const existingNote = getShadowNote(db, turn.id);
      const noteExisted = existingNote !== null;

      // Peer round P2-3: liveness, re-read INSIDE the transaction. The turn
      // was resolved before this transaction opened (address parse, compact
      // check, cross-session check), and a rollback landing in that gap left
      // this write to a node the graph no longer contains. `revivesTurn` is
      // the one exit `skipped` has: the LATE NOTE that fills the hole. Any
      // prose write counts, not only one that promotes — whether the text also
      // lands on the `turns` row is an era question about where prose lives
      // (the rollback path stores it in the shadow row and always has), while
      // dormancy is a question about whether the turn may be written at all.
      const livenessVerdict = checkTurnLiveForWrite(db, turn.id, addressLabel, {
        revivesTurn: touchesProseFields,
      });
      if (!livenessVerdict.ok) {
        fail(livenessVerdict.message);
      }

      // Write gate (ticket 03): checked first, inside this transaction, for
      // every field the call actually provided — "检查-写入原子", no gap
      // between this passing and the fields it guards actually landing
      // below. `fail()` throws and unwinds the WHOLE transaction, the same
      // all-or-nothing shape every other whole-call validation in this
      // function already has: one rejected field blocks the rest too.
      //
      // Ticket 06 (spec D2/D5/D6): both modes run this identically — the
      // edit form earns no exemption from authorization or staleness — and
      // a `write` replacing existing content additionally has to have been
      // granted by a render that showed that field whole.
      if (writer) {
        for (const field of providedFields) {
          const verdict = checkFieldGate(db, writer, "turn", turn.id, field, addressLabel, {
            requireCompleteRead: writeOverwritesExistingTurnContent(
              field,
              freshTurn,
              existingNote,
              modeMap[field],
            ),
            completeReadRemedy: completeReadRemedyForTurnField(field, addressLabel),
          });
          if (!verdict.ok) {
            fail(verdict.message);
          }
        }
        // Ticket 08: the EDGE write gate that stood here (the `type` field
        // check plus the relations-set gate, both on the citing turn) is gone
        // with the parameters it guarded. It lives on unchanged in
        // `worker/note-settlement-turn-facade.ts`, which is the one writer
        // that can still grow a turn's edges.
      }

      // Ticket 05: a field is "touched" by its own value OR by the edit
      // form on `mode.<field>` — the edit form carries its whole payload
      // there and needs no accompanying field value (D10).
      const titleResolution =
        input.title !== undefined || isFieldEditMode(modeMap.title)
          ? resolveStringField(
              "title",
              input.title,
              existingNote?.title ?? null,
              modeMap.title,
              { nullable: false },
            )
          : undefined;
      const contentResolution =
        input.content !== undefined || isFieldEditMode(modeMap.content)
          ? resolveStringField(
              "content",
              input.content,
              existingNote?.content ?? null,
              modeMap.content,
              { nullable: false },
            )
          : undefined;
      const insightResolution =
        input.insight !== undefined || isFieldEditMode(modeMap.insight)
          ? resolveStringField(
              "insight",
              input.insight,
              existingNote?.insight ?? null,
              modeMap.insight,
              { nullable: true },
            )
          : undefined;

      const touchesProseInput =
        titleResolution !== undefined ||
        contentResolution !== undefined ||
        insightResolution !== undefined;
      if (!noteExisted && touchesProseInput) {
        const hasTitle = titleResolution !== undefined;
        const hasContent = contentResolution !== undefined;
        if (!hasTitle || !hasContent) {
          fail("a first note for this turn requires both title and content.");
        }
      }

      const typeResolution = resolveTypeField(input.type, freshTurn.type, modeMap.type);
      const tagsResolution = resolveTagsField(input.tags, freshTurn.tags, modeMap.tags);

      // The TAGS write gate (ticket 14, spec D3b/D3e), checked BEFORE anything
      // lands: `tags` draws from the segment tag and that segment's declared
      // lanes, and nothing else. A refusal `fail()`s, unwinding the whole
      // transaction — no prose is co-written behind an illegal tag set.
      //
      // Read live from `freshTurn`, not from a snapshot taken at the door: the
      // vocabulary rule exempts values this turn ALREADY carries, and the
      // structural rules judge the set this write would leave behind.
      let priorOwningSegmentId: number | null = null;
      if (tagsResolution !== undefined) {
        const gate = checkTurnTagWrite(db, {
          nextTags: tagsResolution.value,
          priorTags: freshTurn.tags,
        });
        if (!gate.ok) {
          fail(gate.message);
        }
        priorOwningSegmentId = getOwningSegmentId(db, turn.id);
      }

      const touchedProse =
        titleResolution !== undefined ||
        contentResolution !== undefined ||
        insightResolution !== undefined;

      let stripped = false;
      let finalTitle = titleResolution?.value;
      let finalContent = contentResolution?.value;
      let finalInsight = insightResolution?.value;

      if (touchedProse) {
        const priorTitle = existingNote?.title ?? null;
        const priorContent = existingNote?.content ?? null;
        const priorInsight = existingNote?.insight ?? null;

        const rawTitle = finalTitle !== undefined ? finalTitle : priorTitle;
        const rawContent = finalContent !== undefined ? finalContent : priorContent;
        const rawInsight = finalInsight !== undefined ? finalInsight : priorInsight;

        const strippedTitle = rawTitle === null ? null : stripPrivateTags(rawTitle);
        const strippedContent =
          rawContent === null ? null : stripPrivateTags(rawContent);
        const strippedInsight =
          rawInsight === null ? null : stripPrivateTags(rawInsight);

        stripped =
          strippedTitle !== rawTitle ||
          strippedContent !== rawContent ||
          strippedInsight !== rawInsight;

        const predecessor = isValidPredecessorFor(db, {
          id: turn.id,
          sessionId: turn.sessionId,
          promptNumber: turn.promptNumber,
        });
        const bracketedContent =
          strippedContent === null
            ? null
            : bracketBareTurnReferences(strippedContent, predecessor);

        finalTitle = strippedTitle;
        finalContent = bracketedContent;
        finalInsight = strippedInsight;

        // Ticket 01 (field-semantics spec): the former budget-teeth hard
        // rejection at 2× lived here — checked only against a field this
        // call actually resolved, refusing the whole write past the line.
        // It is retired outright (BUDGET_REJECTION_MULTIPLE/
        // budgetOverageRejection no longer exist): every field is stored
        // regardless of size, and `formatBudgetWarning` on the receipt below
        // is the only signal a runaway field now gets.

        upsertShadowNote(db, {
          turnId: turn.id,
          // shadow_notes.title/content are NOT NULL — by this point both are
          // guaranteed non-null, either freshly resolved or inherited.
          title: finalTitle as string,
          content: finalContent as string,
          insight: finalInsight,
          writerModel,
          rideTurnId,
          nowEpoch,
        });
        closeNoteDebtAsNoted(db, turn.id, nowEpoch);
      }

      let updatedTurn = freshTurn;
      let citations: RecomputeTurnCitedPairsResult | null = null;

      const promotesThisWrite = touchedProse && promotesTurnRecord;
      const wantsFieldsWrite =
        typeResolution !== undefined || tagsResolution !== undefined;

      if (promotesThisWrite) {
        const promoted = promoteTurnFromNote(db, turn.id, {
          title: finalTitle as string,
          content: finalContent as string,
          insight: finalInsight ?? null,
          updatedAtEpoch: nowEpoch,
        });
        if (promoted) {
          updatedTurn = promoted;
        }
      }
      if (wantsFieldsWrite) {
        const written = updateTurnById(db, turn.id, {
          type: typeResolution?.value,
          tags: tagsResolution?.value,
          updatedAtEpoch: nowEpoch,
        });
        if (written) {
          updatedTurn = written;
        }
      }

      // Ticket 14: membership is DERIVED, and `updateTurnById` above already
      // performed the derivation as part of the tags write. Nothing is done
      // here; what remains is READING the outcome, so the receipt can name the
      // segment this write moved the turn into (or out of) without pretending
      // an assignment verb was involved.
      const membershipSegmentId =
        tagsResolution === undefined ? null : getOwningSegmentId(db, turn.id);
      const membership =
        tagsResolution === undefined
          ? null
          : { segmentId: membershipSegmentId, priorSegmentId: priorOwningSegmentId };

      // Ticket 17 auto-attach (ruling [S15069/T1663]). Writing a segment's tag
      // into `tags` is the ONLY act that joins a turn to a segment, so it is
      // also the earliest moment the session's own attachment is answerable —
      // and answering it here dissolves a circular dependency: seeing a
      // segment's lanes needs its card, the card needs an attachment, and an
      // attachment needs to know WHICH segment. The roster answers that last
      // question on its own (it carries every segment's tag), so the chain
      // self-starts from a roster the session already has.
      //
      // Keyed on the OWNING segment, not on a membership CHANGE: a re-write
      // that leaves the turn where it was still means this session is working
      // in that segment, and `attachSegmentToSession` is idempotent, so the
      // binding is asserted rather than toggled. `attached` is true only for
      // the binding this call actually minted — that is what makes the card
      // ride back exactly once.
      //
      // TICKET 23 pins the two edges ticket 17 left open, and they are the two
      // extra clauses below:
      //
      //  1. THE CALLER'S OWN SESSION ONLY. A cross-session `note` maintains
      //     someone else's turn; letting it bind THIS session to that turn's
      //     segment would make housekeeping on a historical turn silently
      //     change which cards the current session gets injected. The turn's
      //     session is the one working in that segment, and it is not the one
      //     calling.
      //  2. NOT AFTER AN EXPLICIT DETACH. `detach` records itself
      //     (`segment_detachments`, db/segments.ts), and a recorded refusal
      //     stands until the session attaches again through the menu or
      //     `remember(attach)`. Without this, detach undid one call rather
      //     than deciding anything — the next tags write minted the binding
      //     straight back, which is the shipped behaviour peer review B2
      //     caught. The record is per (session, segment): detaching E5 says
      //     nothing about E9.
      let autoAttachedSegmentId: number | null = null;
      if (
        membershipSegmentId !== null &&
        typeof options.callerSessionId === "number" &&
        !isCrossSessionWrite(options.callerSessionId, turn.sessionId) &&
        !isSegmentDetachedFromSession(
          db,
          options.callerSessionId,
          membershipSegmentId,
        )
      ) {
        const { attached } = attachSegmentToSession(
          db,
          options.callerSessionId,
          membershipSegmentId,
          nowEpoch,
        );
        if (attached) {
          autoAttachedSegmentId = membershipSegmentId;
        }
      }

      if (touchedProse && promotesTurnRecord) {
        citations = recomputeTurnCitedPairs(
          db,
          turn.id,
          {
            title: updatedTurn.title,
            content: updatedTurn.content,
            insight: updatedTurn.insight,
          },
          nowEpoch,
          updatedTurn.sessionId,
        );
      }

      // Ticket 08: the retraction/attach pair and the relations-revision stamp
      // that followed them lived here. Both moved WHOLE to the settlement
      // facade — this surface writes no edge, so it also bumps no relations
      // revision: the number records a mutation of the edge set, and a note
      // write is not one.
      //
      // `recomputeTurnCitedPairs` above is untouched and is NOT an exception to
      // that: it maintains the BARE existence rows prose itself names
      // (`[S<n>/T<m>]` in the body), which have no relation word and belong to
      // no lane.

      // Write gate (ticket 01, read-write-contract spec "字段映射"): stamp
      // whichever fields this write actually touched, writer = the caller's
      // own session. Skipped entirely when the caller identity is unknown
      // (every channel but the MCP direct-execution entry point) — there is
      // no writer to attribute the stamp to, same "unknown always admits"
      // latitude `isCrossSessionWrite` already gives this identity.
      if ((touchedProse || wantsFieldsWrite) && writer) {
        if (titleResolution !== undefined) {
          stampField(db, "turn", turn.id, "title", writer, nowEpoch);
        }
        if (contentResolution !== undefined) {
          stampField(db, "turn", turn.id, "content", writer, nowEpoch);
        }
        if (insightResolution !== undefined) {
          stampField(db, "turn", turn.id, "insight", writer, nowEpoch);
        }
        // Subsumption: ANY note write on this turn re-stamps type/tags too,
        // even when this call did not touch them itself — settlement's own
        // yield gate (ticket 05) reads this as "the agent has fresher
        // knowledge of this turn than my pre-run snapshot", the field-level
        // generalization of the old per-turn yield check.
        stampField(db, "turn", turn.id, "type", writer, nowEpoch);
        stampField(db, "turn", turn.id, "tags", writer, nowEpoch);
      }

      return {
        turn: updatedTurn,
        noteExisted,
        touchedProse,
        finalTitle,
        finalContent,
        finalInsight,
        finalType: typeResolution?.value,
        finalTags: tagsResolution?.value,
        citations,
        stripped,
        membership,
        autoAttachedSegmentId,
      };
    });
  } catch (error) {
    if (error instanceof FieldModeError) {
      return parameterError(fieldModeErrorMessage(error, addressLabel));
    }
    throw error;
  }

  // The write landed: whatever run of malformed serializations preceded it is
  // over, so the next rejection on this address starts from one again
  // (write-gate-hardening ticket 01 — "any successful write resets").
  clearToolCallSyntaxRejections(addressLabel);

  const verb = result.noteExisted || !result.touchedProse ? "Updated" : "Noted";
  const parts = [
    `${verb} S${turn.sessionId}/T${turn.promptNumber}${
      result.noteExisted && result.touchedProse ? " (replaced the previous note)" : ""
    }.`,
  ];

  if (result.touchedProse) {
    const budgetFields = {
      title: result.finalTitle ?? "",
      content: result.finalContent ?? "",
      insight: result.finalInsight,
    };
    parts.push(`budget: ${formatNoteBudget(budgetFields)}`);
    // Ticket 01 (field-semantics spec): fires on every call that lands over
    // 1.5×, no state kept between calls — see formatBudgetWarning's own doc
    // comment for why a one-shot reminder was ruled out.
    const budgetWarning = formatBudgetWarning(budgetFields);
    if (budgetWarning) {
      parts.push(budgetWarning);
    }
    // ride_turn is diagnostic-only (ticket 02, render-boilerplate-trim): the
    // common case is that the ride turn IS the turn just written, and saying
    // so on every call told the caller nothing it didn't already know. Print
    // only when it is unknown or points somewhere else.
    if (rideTurnId === null) {
      parts.push("ride_turn: unknown.");
    } else if (rideTurnId !== turn.id) {
      parts.push(
        `ride_turn: S${turn.sessionId}/T${
          getRidePromptNumber(db, rideTurnId) ?? turn.promptNumber
        }.`,
      );
    }
    // writer_model: printed only when one was actually recorded. The
    // "not recorded" case used to print an apology on every call — this
    // environment (the MCP server process) has no channel to learn which
    // model is calling it, so that line was an environment constant, zero
    // information per call, not a per-write diagnostic.
    if (writerModel !== null) {
      parts.push(`writer_model: ${writerModel}.`);
    }
    if (result.stripped) {
      parts.push("Private-tagged content was removed before storing.");
    }
  }

  // type/tags echo: printed only when the STORED form diverges from what was
  // submitted (normalization dedupes/trims `type`, HTML-entity decoding can
  // change `tags`) — identical stays silent, since restating exactly what
  // the caller just sent tells it nothing new.
  if (
    result.finalType !== undefined &&
    !typeListsEqual(result.finalType, input.type as string[])
  ) {
    parts.push(`type: ${result.finalType.length > 0 ? result.finalType.join(", ") : "(none)"}.`);
  }
  if (
    result.finalTags !== undefined &&
    !typeListsEqual(result.finalTags, input.tags as string[])
  ) {
    parts.push(`tags: ${result.finalTags.length > 0 ? result.finalTags.join(", ") : "(none)"}.`);
  }

  if (result.citations) {
    if (result.citations.written.length > 0 || result.citations.deleted.length > 0) {
      let citeLine = `Cites ${result.citations.written.length} pair(s)`;
      if (result.citations.deleted.length > 0) {
        citeLine += `, dropped ${result.citations.deleted.length} no longer referenced`;
      }
      citeLine += ".";
      parts.push(citeLine);
    }
    if (result.citations.rejected.length > 0) {
      parts.push(
        `Dropped ${result.citations.rejected.length} unresolvable reference(s): ${result.citations.rejected
          .map((entry) => `${entry.reference.raw} (${entry.reason})`)
          .join(", ")}.`,
      );
    }
  }

  // Ticket 08: the attach and retraction receipt lines left with the
  // parameters they reported on. `formatRelationRejections` /
  // `formatRetractionReceipt` still exist — in `db/citations.ts`, rendered by
  // the settlement facade, which is the surface that still has something to
  // report.

  // Ticket 14: the DERIVED membership receipt — printed only when this write
  // actually moved the turn, since a tags write that leaves it where it was is
  // not news. Worded as a consequence ("belongs to"), not as an act
  // ("assigned to"): no verb was called.
  if (result.membership && result.membership.segmentId !== result.membership.priorSegmentId) {
    const left =
      result.membership.priorSegmentId === null
        ? ""
        : ` (was E${result.membership.priorSegmentId})`;
    parts.push(
      result.membership.segmentId === null
        ? `Now belongs to no segment${left} — its tags carry no segment tag.`
        : `Now belongs to E${result.membership.segmentId}${left}, derived from its tags.`,
    );
  }

  // Ticket 17 auto-attach: the card rides back HERE, as this write's return
  // value, because it cannot ride back any other way — injection blocks are
  // emitted on SessionStart only (`hooks/hooks.json`), so a session that
  // attaches at turn 40 would otherwise not see the segment's lane vocabulary
  // until it resumed. Printed once, on the call that minted the binding.
  //
  // The VOCABULARY is a separate line under the card (peer review A4): ticket
  // 18 took the `- lanes:` row off the card and put it on the roster row, so
  // the card alone answers "what is this segment" and not "what may I write" —
  // and this receipt exists precisely because the second question has no other
  // answer before the next SessionStart.
  if (result.autoAttachedSegmentId !== null) {
    return textResult(
      `${parts.join(" ")}\nThis session is now attached to E${
        result.autoAttachedSegmentId
      } — its card follows, then the lane tags declared in it; both are injected at the next SessionStart. ` +
        `remember(detach, id="E${result.autoAttachedSegmentId}") cancels that, and it stays cancelled — ` +
        `a later tags write will not re-attach it.\n${renderSegmentCard(
          db,
          result.autoAttachedSegmentId,
          { eraCutoffEpoch: null },
        )}\n${renderSegmentLaneVocabulary(db, result.autoAttachedSegmentId)}`,
    );
  }

  return textResult(parts.join(" "));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * `note` — the merged write tool (spec E1, ticket 03). Turn-only now (ticket
 * 09, edge-ownership-impl "结算顺手维护 session 叙事"): the session address
 * this section used to carry (`handleSessionWrite`) retired outright —
 * session has no main-agent writer any more. Three layers, three writers:
 * turn/segment stay the main agent's (`note`/`remember`), session moved to
 * settlement's own staged-commit channel
 * (`worker/note-settlement-turn-facade.ts`'s `evaluateSettlementTurnWrite`,
 * a `session`-addressed branch alongside its existing `turn`-addressed one).
 * `noteInputShape` dropped the `session` parameter entirely (a schema-
 * validated caller sending it gets `.strict()`'s ordinary parse error); the
 * guard below is this function's OWN belt-and-braces check for a caller that
 * reaches `noteTool()` directly, without the schema in front — same pattern
 * `current`'s retirement (ticket 04) used to apply here before this ticket
 * folded session retirement's `current` special-case into the wider one.
 */
export function noteTool(
  db: Database,
  rawInput: NoteToolInput,
  options: NoteToolOptions = {},
): ToolTextResult {
  if ((rawInput as Record<string, unknown>).session !== undefined) {
    return parameterError(
      "session writes retired from `note` — session has no main-agent writer any" +
        " more. Settlement is the session's sole writer now: title is set once" +
        " (when still empty) and content is incremented with a conversational" +
        " narrative after each settled window. Nothing was written.",
    );
  }

  // Lane-model-v12 ticket 08 (ruling [S15069/T1651]): edges belong wholly to
  // settlement, so every relation and retraction parameter left this surface.
  // The schema already refuses one as an unrecognised key; this is the guard
  // for a caller reaching `noteTool()` directly, and it names the writer that
  // owns edges rather than letting the parameter vanish silently.
  const sentEdgeParameters = EDGE_PARAMETERS.filter(
    (key) => (rawInput as Record<string, unknown>)[key] !== undefined,
  );
  if (sentEdgeParameters.length > 0) {
    return parameterError(
      `${sentEdgeParameters.join(", ")} retired from \`note\` — an edge is settlement's` +
        " to write, whole. This tool writes one turn's own five fields (title, content," +
        " insight, type, tags); which turns it relates to, and in which lane, is a" +
        " hindsight judgment settlement makes over the finished window. Nothing was written.",
    );
  }

  const hasTurn = typeof rawInput.turn === "string";

  if (!hasTurn) {
    return parameterError(
      rawInput.turn === undefined
        ? 'turn ("S<session>/T<prompt>") is required.'
        : "turn must be a string when present.",
    );
  }

  const address = parseTurnAddress(rawInput.turn as string);
  if (!address) {
    return parameterError(
      `turn must be a fully qualified "S<session>/T<prompt>" address, e.g. "S15069/T332"; got "${rawInput.turn}".`,
    );
  }

  return handleTurnWrite(db, address, rawInput, options);
}
