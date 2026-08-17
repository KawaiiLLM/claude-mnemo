import type { Database } from "bun:sqlite";

import {
  attachTurnRelations,
  recomputeTurnCitedPairs,
  type AttachTurnRelationsResult,
  type CitationRelation,
  type RecomputeTurnCitedPairsResult,
  type TurnRelationFieldInput,
  type TurnRelationRejection,
  type TurnRelationRejectionReason,
} from "../db/citations";
import { runWriteTransaction } from "../db/database";
import {
  closeNoteDebtAsDeclined,
  closeNoteDebtAsNoted,
  getNoteDebt,
  recordDeclinedNoteDebt,
} from "../db/note-debt";
import {
  countTurnsSince,
  getSession,
  updateSessionFields,
  type SessionRecord,
  type UpdateSessionFieldsInput,
} from "../db/sessions";
import { getShadowNote, upsertShadowNote } from "../db/shadow-notes";
import {
  getTurn,
  getTurnById,
  promoteTurnFromNote,
  updateTurnById,
  type TurnRecord,
} from "../db/turns";
import { isSegmentEra } from "../segment-era";
import {
  formatSessionFieldUsage,
  formatSummaryCadence,
  RETIRED_SESSION_FIELD,
  retiredSessionFieldMessage,
  SESSION_FIELD_GUIDANCE,
  SESSION_SUMMARY_FIELDS,
  type SessionSummaryField,
} from "./session-summary";
import {
  budgetOverageRejection,
  formatNoteBudget,
  NOTE_TOKEN_BUDGET,
} from "../shared/note-budget";
import {
  findRetiredTopicTag,
  retiredTopicTagMessage,
  stripPrivateTags,
} from "../shared/tag-stripping";
import {
  containsToolCallSyntax,
  toolCallSyntaxMessage,
} from "../shared/tool-call-syntax";
import { MEMORY_TYPES, normalizeTypeValues } from "../shared/type-vocabulary";

type ToolTextResult = {
  content: Array<{
    type: "text";
    text: string;
  }>;
};

// D5/D5a: the one mode vocabulary. `append` accumulates (string concat with a
// newline, array union); `overwrite` replaces the field whole, clear included.
export type FieldMode = "append" | "overwrite";
const FIELD_MODE_VALUES: readonly FieldMode[] = ["append", "overwrite"];

// ticket 01 (ADR-0003): `grade` left this list along with the parameter
// itself — the writer records facts, settlement assigns value.
const TURN_MODE_FIELDS = ["title", "content", "insight", "type", "tags"] as const;
// ticket 01/09 (spec "Session retirement"): one field, `title` — the other
// six retired with the segment redesign. One list, imported rather than
// restated, so the tool surface and the receipt's guidance values cannot
// describe different sets of fields.
const SESSION_MODE_FIELDS = SESSION_SUMMARY_FIELDS;

export interface NoteToolInput {
  // Exactly one of `turn` / `session` addresses the write (D5/E1: one tool,
  // both surfaces).
  turn?: unknown;
  session?: unknown;

  // Turn fields. `title`/`content`/`insight` are shared with the session
  // address (session accepts `title` only — `content`/`insight` are refused
  // by name there; see `handleSessionWrite`).
  title?: unknown;
  content?: unknown;
  insight?: unknown;
  /** What this turn did (spec B2) — omitted or `[]` means none fit; never guessed at (spec B7). */
  type?: unknown;
  /** Bare subject words; the `topic:` namespace is retired (spec B6). */
  tags?: unknown;
  skip?: unknown;
  crossSession?: unknown;

  // ticket 07 (spec C1/C5/C7): one named field per relation. Targets are
  // address tokens this write's OWN title/content/insight post-state must
  // already name — see `RELATION_FIELD_ENTRIES` / `resolveRelationFields`.
  evidenceFor?: unknown;
  evidenceAgainst?: unknown;
  supersedes?: unknown;
  dependsOn?: unknown;

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

function parseSessionAddress(value: string): number | null {
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

const HTML_ENTITY_MAP: Record<string, string> = { lt: "<", gt: ">", amp: "&" };

// The memory agent sometimes emits HTML-escaped text even though every field
// here is plain text; decode once at the persistence boundary. Single-pass so
// `&amp;lt;` decodes to `&lt;`, never `<`.
//
// Exported (ticket 02): `remember`'s Working State fields need the identical
// decode note's own fields get — one entity map, not a second copy in
// `mcp/remember.ts`.
export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(lt|gt|amp);/g, (_match, name: string) => HTML_ENTITY_MAP[name]!);
}

class NoteValidationError extends Error {}

function fail(message: string): never {
  throw new NoteValidationError(message);
}

function modeRequiredMessage(field: string): string {
  return (
    `${field} is not empty; declare mode.${field} as "overwrite" (replace it ` +
    'whole) or "append" (add to it) — omitting the mode is not allowed on a ' +
    "field that already holds something."
  );
}

type FieldResolution<T> = { value: T };

/**
 * The one string-field resolver, shared by every prose field of both
 * addressing surfaces (spec D5a: one mode vocabulary, no field gets a
 * mechanism of its own).
 *
 * `nullable: false` (turn `title`/`content`) rejects both an explicit `null`
 * and an empty string — the shadow_notes schema itself requires them non-null,
 * so "clearing" one is not an operation this tool can express; the caller
 * supplies a replacement or leaves the field alone. `nullable: true` (turn
 * `insight`, every session field) treats an empty string as a plain synonym
 * for `null` — the pre-existing convention for these columns — and both route
 * through the same overwrite-mode-gated clear.
 */
function resolveStringField(
  field: string,
  provided: unknown,
  existing: string | null,
  mode: FieldMode | undefined,
  opts: { nullable: boolean },
): FieldResolution<string | null> {
  if (provided === null) {
    if (!opts.nullable) {
      fail(`${field} cannot be cleared; supply a replacement value instead of null.`);
    }
    return resolveClear(field, existing, mode);
  }
  if (typeof provided !== "string") {
    fail(`${field} must be a string${opts.nullable ? " or null" : ""} when present.`);
  }
  const decoded = decodeHtmlEntities(provided);
  if (decoded.trim() === "") {
    if (opts.nullable) {
      return resolveClear(field, existing, mode);
    }
    fail(`${field} must not be empty.`);
  }
  if (containsToolCallSyntax(decoded)) {
    fail(toolCallSyntaxMessage(field));
  }
  const isEmpty = existing === null || existing.trim() === "";
  if (!isEmpty) {
    if (mode === undefined) {
      fail(modeRequiredMessage(field));
    }
    if (mode === "append") {
      const base = existing!.trim();
      return { value: base ? `${base}\n${decoded}` : decoded };
    }
  }
  return { value: decoded };
}

function resolveClear(
  field: string,
  existing: string | null,
  mode: FieldMode | undefined,
): FieldResolution<string | null> {
  const isEmpty = existing === null || existing.trim() === "";
  if (isEmpty) {
    return { value: null };
  }
  if (mode === undefined) {
    fail(modeRequiredMessage(field));
  }
  if (mode === "append") {
    fail(`${field} cannot be cleared with mode: "append" — use "overwrite".`);
  }
  return { value: null };
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
  const isEmpty = existing.length === 0;
  if (!isEmpty) {
    if (mode === undefined) {
      fail(modeRequiredMessage("type"));
    }
    if (mode === "append") {
      const merged = [...existing];
      for (const value of normalized) {
        if (!merged.includes(value)) {
          merged.push(value);
        }
      }
      return { value: merged };
    }
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
  const isEmpty = existing.length === 0;
  if (!isEmpty) {
    if (mode === undefined) {
      fail(modeRequiredMessage("tags"));
    }
    if (mode === "append") {
      const merged = [...existing];
      for (const tag of decoded) {
        if (!merged.includes(tag)) {
          merged.push(tag);
        }
      }
      return { value: merged };
    }
  }
  return { value: decoded };
}

// ticket 07 (spec C1): the four named relation fields, field name -> the
// relation it means. One list, so the field-shape loop and the "which turn
// keys are relation fields" checks below (`handleSessionWrite`'s guard) stay
// in sync by construction rather than by two hand-kept literals agreeing.
const RELATION_FIELD_ENTRIES: ReadonlyArray<
  readonly [
    key: "evidenceFor" | "evidenceAgainst" | "supersedes" | "dependsOn",
    relation: CitationRelation,
  ]
> = [
  ["evidenceFor", "evidence-for"],
  ["evidenceAgainst", "evidence-against"],
  ["supersedes", "supersedes"],
  ["dependsOn", "depends-on"],
];

const RELATION_REJECTION_TEXT: Record<TurnRelationRejectionReason, string> = {
  malformed: 'is not a valid address ("S<session>/T<prompt>" or "E<segment>")',
  unresolved: "does not resolve to a turn or segment",
  "not-cited":
    "is not cited by this write's title, content or insight — attach a relation only to a pair the body actually names (spec C7)",
  "duplicate-target":
    "is already claimed by a different relation field in this same call — a pair carries at most one relation (spec C5)",
};

function formatRelationRejections(
  rejections: readonly TurnRelationRejection[],
): string {
  const lines = rejections.map(
    (entry) => `${entry.relation} "${entry.raw}" ${RELATION_REJECTION_TEXT[entry.reason]}`,
  );
  return `relation field rejected: ${lines.join("; ")}.`;
}

/**
 * Spec C7 (ticket 07): the main agent may attach a relation to a pair its OWN
 * write is creating, never to one this call did not itself cite — so this
 * only has an answer once `citations` (the same write's post-state, from
 * `recomputeTurnCitedPairs`) is known. A relation field present on a call
 * that never touched a citation-bearing field (title/content/insight), or
 * whose targets the resulting post-state does not name, fails the WHOLE
 * write rather than silently dropping the relation — a relation field is
 * structured input, not prose a model might hallucinate a bracket into.
 */
function resolveRelationFields(
  db: Database,
  citingTurnId: number,
  input: NoteToolInput,
  citations: RecomputeTurnCitedPairsResult | null,
  nowEpoch: number,
): AttachTurnRelationsResult | null {
  const fields: TurnRelationFieldInput[] = [];
  for (const [key, relation] of RELATION_FIELD_ENTRIES) {
    const provided = (input as Record<string, unknown>)[key];
    if (provided === undefined) {
      continue;
    }
    if (!Array.isArray(provided) || provided.some((value) => typeof value !== "string")) {
      fail(`${key} must be an array of strings when present.`);
    }
    if (provided.length > 0) {
      fields.push({ relation, targets: provided as string[] });
    }
  }
  if (fields.length === 0) {
    return null;
  }
  if (citations === null) {
    fail(
      "evidenceFor/evidenceAgainst/supersedes/dependsOn require this write to also touch a " +
        "citation-bearing field (title, content or insight) whose post-state names the " +
        "target — a relation cannot attach to a pair this call is not itself citing (spec C7).",
    );
  }

  const result = attachTurnRelations(db, citingTurnId, fields, citations.written, nowEpoch);
  if (result.rejected.length > 0) {
    fail(formatRelationRejections(result.rejected));
  }
  return result;
}

function parseModeMap(
  raw: unknown,
  allowed: readonly string[],
): Partial<Record<string, FieldMode>> {
  if (raw === undefined) {
    return {};
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail('mode must be an object mapping field names to "overwrite" or "append".');
  }
  const result: Partial<Record<string, FieldMode>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === RETIRED_SESSION_FIELD) {
      // Named, not lumped into the generic "unknown field" answer: a caller
      // still sending `mode.current` is working from the retired contract and
      // needs to be told which field replaced it (ticket 04, spec D2).
      fail(retiredSessionFieldMessage("mode"));
    }
    if (!allowed.includes(key)) {
      fail(`mode.${key} names a field this call does not accept a mode for.`);
    }
    if (!FIELD_MODE_VALUES.includes(value as FieldMode)) {
      fail(`mode.${key} must be "overwrite" or "append".`);
    }
    result[key] = value as FieldMode;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Decline (skip)
// ---------------------------------------------------------------------------

type DeclineOutcome =
  | { kind: "declined" }
  | { kind: "already-noted" }
  | { kind: "already-settled"; settledAs: string };

function overwriteRequiredMessage(address: TurnAddress): string {
  return (
    `S${address.sessionId}/T${address.promptNumber} already has a note.` +
    ' Declare mode.title/mode.content (or mode.insight) as "overwrite" or ' +
    '"append" to confirm you want to touch it.'
  );
}

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
  relations: AttachTurnRelationsResult | null;
  stripped: boolean;
}

function isValidPredecessorFor(
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

  const providedFields = TURN_MODE_FIELDS.filter(
    (key) => (input as Record<string, unknown>)[key] !== undefined,
  );
  if (providedFields.length === 0) {
    return parameterError(
      `at least one of ${TURN_MODE_FIELDS.join(", ")} is required.`,
    );
  }

  let modeMap: Partial<Record<string, FieldMode>>;
  try {
    modeMap = parseModeMap(input.mode, TURN_MODE_FIELDS);
  } catch (error) {
    if (error instanceof NoteValidationError) {
      return parameterError(error.message);
    }
    throw error;
  }

  const nowEpoch = options.now?.() ?? Math.floor(Date.now() / 1000);
  const writerModel = resolveWriterModel(options.env ?? process.env);
  const current = getSessionCurrentTurn(db, turn.sessionId);
  const rideTurnId = current?.id ?? null;
  const writeTransaction = options.runWriteTransaction ?? runWriteTransaction;
  const promotesTurnRecord = isSegmentEra(turn.createdAtEpoch, options.eraCutoffEpoch);

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
  // Grade, type and tags are NOT refused. They write `turns` directly for
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
  if (
    eraConfigured &&
    !promotesTurnRecord &&
    (input.title !== undefined ||
      input.content !== undefined ||
      input.insight !== undefined)
  ) {
    return parameterError(
      `S${address.sessionId}/T${address.promptNumber} is a pre-cutoff turn, whose prose has no reader —` +
        " title, content and insight cannot be written to it." +
        " Its grade, type and tags are still writable.",
    );
  }

  let result: TurnWriteTransactionResult;
  try {
    result = writeTransaction(db, (): TurnWriteTransactionResult => {
      const freshTurn = getTurnById(db, turn.id)!;
      const existingNote = getShadowNote(db, turn.id);
      const noteExisted = existingNote !== null;

      const titleResolution =
        input.title !== undefined
          ? resolveStringField(
              "title",
              input.title,
              existingNote?.title ?? null,
              modeMap.title,
              { nullable: false },
            )
          : undefined;
      const contentResolution =
        input.content !== undefined
          ? resolveStringField(
              "content",
              input.content,
              existingNote?.content ?? null,
              modeMap.content,
              { nullable: false },
            )
          : undefined;
      const insightResolution =
        input.insight !== undefined
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

        // ticket 01 (spec "Note contract revision"): budget teeth. Checked
        // only against a field THIS call actually resolved (not one merely
        // inherited above for stripping/bracketing purposes) — a pre-existing
        // over-budget field this write never touches must not block an
        // unrelated edit to a sibling field. The whole write fails atomically
        // (fail() unwinds this transaction), so a rejected field's mere
        // presence in the same call blocks the others too, same as every
        // other whole-call validation in this function.
        if (titleResolution !== undefined && finalTitle !== null) {
          const rejection = budgetOverageRejection(
            "title",
            finalTitle,
            NOTE_TOKEN_BUDGET.title,
          );
          if (rejection) fail(rejection);
        }
        if (contentResolution !== undefined && finalContent !== null) {
          const rejection = budgetOverageRejection(
            "content",
            finalContent,
            NOTE_TOKEN_BUDGET.content,
          );
          if (rejection) fail(rejection);
        }
        if (insightResolution !== undefined && finalInsight !== null) {
          const rejection = budgetOverageRejection(
            "insight",
            finalInsight,
            NOTE_TOKEN_BUDGET.insight,
          );
          if (rejection) fail(rejection);
        }

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

      const relations = resolveRelationFields(db, turn.id, input, citations, nowEpoch);

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
        relations,
        stripped,
      };
    });
  } catch (error) {
    if (error instanceof NoteValidationError) {
      return parameterError(error.message);
    }
    throw error;
  }

  const verb = result.noteExisted || !result.touchedProse ? "Updated" : "Noted";
  const parts = [
    `${verb} S${turn.sessionId}/T${turn.promptNumber}${
      result.noteExisted && result.touchedProse ? " (replaced the previous note)" : ""
    }.`,
  ];

  if (result.touchedProse) {
    parts.push(
      `budget: ${formatNoteBudget({
        title: result.finalTitle ?? "",
        content: result.finalContent ?? "",
        insight: result.finalInsight,
      })}`,
    );
    parts.push(
      rideTurnId === null
        ? "ride_turn: unknown."
        : `ride_turn: S${turn.sessionId}/T${
            getRidePromptNumber(db, rideTurnId) ?? turn.promptNumber
          }.`,
    );
    parts.push(
      writerModel === null
        ? "writer_model: not recorded — this environment does not expose the model to the MCP server."
        : `writer_model: ${writerModel}.`,
    );
    if (result.stripped) {
      parts.push("Private-tagged content was removed before storing.");
    }
  }

  if (result.finalType !== undefined) {
    parts.push(`type: ${result.finalType.length > 0 ? result.finalType.join(", ") : "(none)"}.`);
  }
  if (result.finalTags !== undefined) {
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

  if (result.relations && result.relations.written.length > 0) {
    parts.push(`Attached ${result.relations.written.length} relation(s).`);
  }

  return textResult(parts.join(" "));
}

// ---------------------------------------------------------------------------
// Session write
// ---------------------------------------------------------------------------

function handleSessionWrite(
  db: Database,
  sessionId: number,
  input: NoteToolInput,
  options: NoteToolOptions,
): ToolTextResult {
  // ticket 01 (spec "Session retirement"): `content`/`insight` retired from
  // the session address specifically — they stay in `noteInputShape`'s
  // schema because they are still valid TURN fields, so `.strict()` cannot
  // catch a session call sending them; refused here by name instead, same
  // pattern `current` already used. `next_steps`/`decision`/`done`/
  // `reference` need no entry here at all: they are removed from the schema
  // outright and already fail as a `.strict()` parse error before `noteTool`
  // is even reached by a schema-validated caller (and a caller bypassing the
  // schema, e.g. a direct `noteTool()` call, simply has them ignored — there
  // is no field left on `NoteToolInput` to read them into). `grade` needs no
  // entry either, for the identical reason (ADR-0003: it left this tool).
  for (const key of [
    "content",
    "insight",
    "type",
    "tags",
    "skip",
    "crossSession",
    "evidenceFor",
    "evidenceAgainst",
    "supersedes",
    "dependsOn",
  ] as const) {
    if ((input as Record<string, unknown>)[key] !== undefined) {
      return parameterError(`${key} is a turn field; this call addresses a session.`);
    }
  }

  const providedFields = SESSION_MODE_FIELDS.filter(
    (key) => (input as Record<string, unknown>)[key] !== undefined,
  );
  if (providedFields.length === 0) {
    return parameterError(
      `at least one of ${SESSION_MODE_FIELDS.join(", ")} is required.`,
    );
  }

  let modeMap: Partial<Record<string, FieldMode>>;
  try {
    modeMap = parseModeMap(input.mode, SESSION_MODE_FIELDS);
  } catch (error) {
    if (error instanceof NoteValidationError) {
      return parameterError(error.message);
    }
    throw error;
  }

  const session = getSession(db, sessionId);
  if (!session) {
    return textResult(`Session S${sessionId} not found.`);
  }

  // One field, `title` — SESSION_MODE_FIELDS (session-summary.ts) is the
  // single source for what a session write may touch; this map stays keyed
  // off it rather than a hand-kept literal so the two cannot drift apart.
  const fieldMap: ReadonlyArray<[key: SessionSummaryField, existing: string | null]> = [
    ["title", session.title],
  ];

  let resolvedInput: UpdateSessionFieldsInput;
  const finals: Array<[SessionSummaryField, string | null]> = [];
  try {
    resolvedInput = {};
    for (const [key, existing] of fieldMap) {
      const provided = (input as Record<string, unknown>)[key];
      if (provided === undefined) {
        continue;
      }
      const resolution = resolveStringField(key, provided, existing, modeMap[key], {
        nullable: true,
      });
      // ticket 01: budget teeth on the session's own field, same 2× hard
      // line as a turn's title/content/insight — shared helper, this
      // field's own guidance value.
      if (resolution.value !== null) {
        const rejection = budgetOverageRejection(
          key,
          resolution.value,
          SESSION_FIELD_GUIDANCE[key],
        );
        if (rejection) fail(rejection);
      }
      finals.push([key, resolution.value]);
      // `key` is `"title"` today — the one field left on the session address
      // — which happens to need no camelCase remapping the way the retired
      // `next_steps` -> `nextSteps` once did.
      (resolvedInput as Record<string, string | null>)[key] = resolution.value;
    }
  } catch (error) {
    if (error instanceof NoteValidationError) {
      return parameterError(error.message);
    }
    throw error;
  }

  // Read BEFORE the write: `updateSessionFields` advances the summary epoch
  // unconditionally, so the staleness this write is answering is only
  // measurable from the row as it stood on the way in (spec D8).
  const priorSummaryEpoch = session.summaryUpdatedAtEpoch;
  const turnsSinceUpdate = countTurnsSince(db, sessionId, priorSummaryEpoch);

  const nowEpoch = options.now?.() ?? Math.floor(Date.now() / 1000);
  const writeTransaction = options.runWriteTransaction ?? runWriteTransaction;
  const updated = writeTransaction(db, () =>
    updateSessionFields(db, sessionId, resolvedInput, nowEpoch),
  );

  if (!updated) {
    return textResult(`Session S${sessionId} not found.`);
  }

  // The receipt is the only feedback a session write's author ever gets (spec
  // D8), and it carries exactly two things: per-field usage against the
  // guidance value — post-write totals, so an appending writer sees where the
  // field now STANDS rather than what it just added — and how many turns have
  // passed since the last update. Nothing here truncates: over budget is a
  // signal to the writer, never a loss to the reader.
  //
  // The cadence figure travels without its healthy band, deliberately (D8a).
  // Do not "helpfully" add one: a writer that knows the target updates to
  // reset the counter, and the diagnostic then reads healthy by construction.
  const parts = [`Updated S${sessionId}.`];
  parts.push(
    `after write: ${finals
      .map(([key, value]) => formatSessionFieldUsage(key, value))
      .join(", ")}.`,
  );
  parts.push(formatSummaryCadence(turnsSinceUpdate, priorSummaryEpoch !== null));

  return textResult(parts.join(" "));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * `note` — the merged write tool (spec E1, ticket 03). One tool writes turns
 * and sessions; the retired `remember` entry point is gone. Merging is not
 * only tidiness: it removes an unfenced third writer of a turn's `grade`,
 * `type` and `tags`, so the note-timestamp fence that protects a late note
 * covers every write path without a new provenance column.
 */
export function noteTool(
  db: Database,
  rawInput: NoteToolInput,
  options: NoteToolOptions = {},
): ToolTextResult {
  // ticket 04 (spec D2): `current` is deleted, and a caller still sending it
  // is REFUSED rather than having the field quietly dropped — a writer whose
  // update vanishes without a word keeps writing into the same hole. Checked
  // at the entry point so it answers the same way on both addressing surfaces
  // and for callers that reach `noteTool` without the zod schema in front.
  if ((rawInput as Record<string, unknown>)[RETIRED_SESSION_FIELD] !== undefined) {
    return parameterError(retiredSessionFieldMessage("field"));
  }

  const hasTurn = typeof rawInput.turn === "string";
  const hasSession = typeof rawInput.session === "string";

  if (rawInput.turn !== undefined && !hasTurn) {
    return parameterError("turn must be a string when present.");
  }
  if (rawInput.session !== undefined && !hasSession) {
    return parameterError("session must be a string when present.");
  }

  if (hasTurn === hasSession) {
    return parameterError(
      hasTurn
        ? "exactly one of turn or session is required, not both."
        : 'exactly one of turn ("S<session>/T<prompt>") or session ("S<session>") is required.',
    );
  }

  if (hasSession) {
    const sessionId = parseSessionAddress(rawInput.session as string);
    if (sessionId === null) {
      return parameterError(
        `session must be a "S<session>" address, e.g. "S15069"; got "${rawInput.session}".`,
      );
    }
    return handleSessionWrite(db, sessionId, rawInput, options);
  }

  const address = parseTurnAddress(rawInput.turn as string);
  if (!address) {
    return parameterError(
      `turn must be a fully qualified "S<session>/T<prompt>" address, e.g. "S15069/T332"; got "${rawInput.turn}".`,
    );
  }

  return handleTurnWrite(db, address, rawInput, options);
}
