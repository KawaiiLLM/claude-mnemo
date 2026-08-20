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
import { parseBareAddressReference } from "../db/references";
import { getShadowNote, upsertShadowNote } from "../db/shadow-notes";
import {
  getTurn,
  getTurnById,
  promoteTurnFromNote,
  updateTurnById,
  type TurnRecord,
} from "../db/turns";
import { checkFieldGate, sessionWriterId, stampField } from "../db/write-gate";
import { isSegmentEra } from "../segment-era";
import { formatBudgetWarning, formatNoteBudget } from "../shared/note-budget";
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
import {
  EDGE_RELATIONS,
  isTurnEdgeRelation,
  phasesForTypes,
  RELATION_FIELD_NAME,
  validateRelationTarget,
  type TurnEdgeRelation,
  type TurnPhase,
} from "../shared/turn-phase";

type ToolTextResult = {
  content: Array<{
    type: "text";
    text: string;
  }>;
};

// Ticket 05 (write-mode-edit-semantics, spec D1/D10): the one mode
// vocabulary, now a discriminated union rather than a bare enum — `write`
// replaces the field whole (clear included); the edit form carries its own
// payload since there is nowhere else on the call to put it. `append` and
// `overwrite` retired outright — `RETIRED_FIELD_MODE_REPLACEMENT` below is
// what a caller still sending either gets instead of a generic error.
export type FieldMode = "write" | FieldEditMode;
export interface FieldEditMode {
  mode: "edit";
  oldString: string;
  newString: string;
}

function isFieldEditMode(mode: FieldMode | undefined): mode is FieldEditMode {
  return typeof mode === "object" && mode !== null;
}

// Ticket 05 (spec D14): the retired mode literals, each naming its own
// replacement — same precedent the retired `topic`/`truncate`/`view`
// parameters already set (definitions.ts), applied here at the runtime
// layer too since most callers of `noteTool()` in this codebase's own tests
// bypass the zod schema entirely.
const RETIRED_FIELD_MODE_REPLACEMENT: Record<string, string> = {
  overwrite: 'use "write" instead.',
  append:
    'use "write" to replace the field whole, or the edit form ({ mode: "edit", oldString, newString }) to change part of it.',
};

// Ticket 05 (spec D4): type/tags are set fields — "part of a list" is not a
// span an oldString/newString pair can name, so the edit form is refused on
// them outright, not given a set-flavoured meaning of its own.
const NOTE_SET_MODE_FIELDS: readonly string[] = ["type", "tags"];

// ticket 01 (ADR-0003): `grade` left this list along with the parameter
// itself — the writer records facts, settlement assigns value.
const TURN_MODE_FIELDS = ["title", "content", "insight", "type", "tags"] as const;

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
  /** Bare subject words; the `topic:` namespace is retired (spec B6). */
  tags?: unknown;
  skip?: unknown;
  crossSession?: unknown;

  // ticket 07 (spec C1/C5/C7): one named field per relation. Targets are
  // address tokens this write's OWN title/content/insight post-state must
  // already name — see `RELATION_FIELD_ENTRIES` / `resolveRelationFields`.
  // ticket 01 (turn-edge-mechanism spec): `supersedes` retired from this
  // list — `refines`/`override`/`encodes`/`groundedOn` take its place in the
  // seven-word closed set ([S15069/T935] added `groundedOn` mid-flight).
  evidenceFor?: unknown;
  evidenceAgainst?: unknown;
  groundedOn?: unknown;
  refines?: unknown;
  override?: unknown;
  encodes?: unknown;
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
    `${field} is not empty; declare mode.${field} as "write" (replace it ` +
    'whole) or the edit form ({ mode: "edit", oldString, newString }) ' +
    "(change part of it) — omitting the mode is not allowed on a field " +
    "that already holds something."
  );
}

function editValueConflictMessage(field: string): string {
  return (
    `${field} was supplied together with mode.${field}'s edit form — the new ` +
    `text belongs in mode.${field}.newString, not in ${field} itself.`
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
  // Ticket 05 (spec D10): the edit form's payload lives entirely in
  // `mode.<field>` — the field's own value is not also supplied. Routed here
  // before anything else so the "value + edit form together" combo (D10) is
  // caught regardless of which branch below would otherwise have handled
  // `provided`.
  if (isFieldEditMode(mode)) {
    if (provided !== undefined) {
      fail(editValueConflictMessage(field));
    }
    return resolveFieldEdit(field, existing, mode, opts);
  }
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
  // Ticket 05 (trap #1): this is the branch that used to treat ANY
  // non-`append` mode as a whole overwrite. `mode` here can only be
  // `undefined` or `"write"` (edit is routed away above) — falling through
  // to `return { value: decoded }` is a full replacement either way, exactly
  // as spec D2 defines `write`. See the regression test in note.test.ts
  // pinning that `mode: "edit"` never reaches this fallthrough.
  if (!isEmpty && mode === undefined) {
    fail(modeRequiredMessage(field));
  }
  return { value: decoded };
}

/**
 * Ticket 05 (spec D3): the edit form's three-state contract, ported from the
 * segment surface's already-shipped `replaceInSegmentWorkingStateField`
 * (db/segments.ts) — unique hit succeeds, no hit rejects naming `oldString`,
 * more than one hit rejects naming the count. `newString: ""` deletes the
 * matched span; a non-nullable field (title/content) edited down to empty is
 * refused rather than silently landing an empty string, the same "cannot be
 * cleared" discipline `resolveStringField`'s own null branch already applies.
 */
function resolveFieldEdit(
  field: string,
  existing: string | null,
  edit: FieldEditMode,
  opts: { nullable: boolean },
): FieldResolution<string | null> {
  const current = existing ?? "";
  const occurrences = current === "" ? 0 : current.split(edit.oldString).length - 1;
  if (occurrences === 0) {
    fail(`oldString ${JSON.stringify(edit.oldString)} not found in ${field}.`);
  }
  if (occurrences > 1) {
    fail(
      `oldString ${JSON.stringify(edit.oldString)} matches ${occurrences} times in ${field} — narrow it so it matches exactly once.`,
    );
  }
  const replaced = current.split(edit.oldString).join(edit.newString);
  if (replaced.trim() === "") {
    if (opts.nullable) {
      return { value: null };
    }
    fail(`${field} cannot be edited down to empty; supply a replacement instead of deleting all of it.`);
  }
  return { value: replaced };
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
  // `mode` is guaranteed `"write"` here — the edit form is routed away by
  // `resolveStringField` before this function is ever reached.
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

// ticket 01/07 (spec C1; turn-edge-mechanism spec): the seven named relation
// fields, field name -> the relation it means — DERIVED from
// `shared/turn-phase.ts`'s `EDGE_RELATIONS`/`RELATION_FIELD_NAME` rather than
// a second hand-kept literal, so the closed set and its parameter spelling
// cannot drift apart ([S15069/T939]: the shared module, not this file, is
// where the seven-word set and its judgment live — this list is only the
// note surface's OWN wiring of field name -> relation onto that constant).
// `supersedes` is gone (ticket 01): a caller still sending it is a
// `.strict()` parse error at the schema layer (`noteInputSchema` omits the
// field even though `noteInputShape` keeps it for `settlementNoteInputShape`
// to reuse) rather than something this list needs to reject by hand.
//
// Exported so a guard test can pin that this list's relation VALUES equal
// `EDGE_RELATIONS` exactly and that every key names a real `noteInputShape`
// parameter — the derivation above already makes drift a compile error for
// the relation half, this closes the loop on the parameter-name half too.
export const RELATION_FIELD_ENTRIES: ReadonlyArray<
  readonly [key: string, relation: TurnEdgeRelation]
> = EDGE_RELATIONS.map((relation) => [RELATION_FIELD_NAME[relation], relation] as const);

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
 * Ticket 01 (turn-edge-mechanism spec) / [S15069/T939]: two checks
 * `attachTurnRelations` itself does NOT make, because that function is
 * shared plumbing settlement's own facade also calls with `supersedes` and
 * segment targets (spec: "既有 segment 端点的旧边冻结可读" — that history
 * stays legible through the generic path). `note`'s own seven-word surface
 * is narrower, so the narrowing lives here, one layer up, rather than
 * inside the shared function.
 *
 * The JUDGMENT itself — segment targets refused, phase-pair legality, which
 * half is missing — is `shared/turn-phase.ts`'s `validateRelationTarget`,
 * not reimplemented here: this function's own job is strictly address
 * parsing and the DB lookup that turns a raw token into the phase-set input
 * that shared judgment needs, so a future caller (ticket 08's settlement
 * correction surface) can supply the SAME judgment from its own address
 * resolution without duplicating the rules.
 *
 * Returns `null` (legal) or the rejection message; a malformed or unresolved
 * address is left for `attachTurnRelations`' own pass to report — this
 * function only has an opinion once an address actually resolves to a node.
 */
function checkRelationTargetPhase(
  db: Database,
  relation: string,
  raw: string,
  citingPhases: ReadonlySet<TurnPhase>,
): string | null {
  if (!isTurnEdgeRelation(relation)) {
    return null;
  }
  const reference = parseBareAddressReference(raw);
  if (!reference) {
    return null;
  }
  if (reference.kind === "segment") {
    const result = validateRelationTarget({
      relation,
      citingPhases,
      targetKind: "segment",
      citedPhases: new Set(),
    });
    return result.ok ? null : `${relation} "${raw}" ${result.detail}`;
  }
  const cited = getTurn(db, reference.sessionId, reference.promptNumber);
  if (!cited) {
    return null;
  }
  const result = validateRelationTarget({
    relation,
    citingPhases,
    targetKind: "turn",
    citedPhases: phasesForTypes(cited.type),
  });
  return result.ok ? null : `${relation} "${raw}" ${result.detail}`;
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
  citingTurnType: readonly string[],
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
      "evidenceFor/evidenceAgainst/groundedOn/refines/override/encodes/dependsOn require this write to also touch a " +
        "citation-bearing field (title, content or insight) whose post-state names the " +
        "target — a relation cannot attach to a pair this call is not itself citing (spec C7).",
    );
  }

  // Ticket 01: phase/segment-target legality, checked BEFORE `attachTurnRelations`'
  // own citation/duplicate checks — a structurally illegal relation (wrong
  // phase pair, a segment target) is rejected atomically with every other
  // one found in the same call, the same all-or-nothing shape
  // `attachTurnRelations` already gives its own rejections.
  const citingPhases = phasesForTypes(citingTurnType);
  const phaseIssues: string[] = [];
  for (const field of fields) {
    for (const raw of field.targets) {
      const issue = checkRelationTargetPhase(db, field.relation, raw, citingPhases);
      if (issue) {
        phaseIssues.push(issue);
      }
    }
  }
  if (phaseIssues.length > 0) {
    fail(`relation field rejected: ${phaseIssues.join("; ")}.`);
  }

  const result = attachTurnRelations(db, citingTurnId, fields, citations.written, nowEpoch);
  if (result.rejected.length > 0) {
    fail(formatRelationRejections(result.rejected));
  }
  return result;
}

const MODE_SHAPE_MESSAGE =
  'must be "write" or an edit form ({ mode: "edit", oldString, newString }).';

/**
 * Ticket 05 (spec D1/D3/D4/D10/D14): parses `mode.<field>` into the
 * discriminated union `FieldMode` — the one place every trap this ticket
 * exists to close is checked in a single pass: a retired literal names its
 * replacement (D14), an edit form on a set field is refused (D4), and the
 * edit form's own hygiene (decode, tool-call-syntax, private-tag strip) runs
 * once here rather than being duplicated across every prose field's own
 * resolver — mirroring where `remember.ts`'s `handleReplace`/`handleEdit`
 * already do the identical decode/strip for `oldString`/`newString`.
 */
function parseModeMap(
  raw: unknown,
  allowed: readonly string[],
): Partial<Record<string, FieldMode>> {
  if (raw === undefined) {
    return {};
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(`mode ${MODE_SHAPE_MESSAGE}`);
  }
  const result: Partial<Record<string, FieldMode>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowed.includes(key)) {
      fail(`mode.${key} names a field this call does not accept a mode for.`);
    }
    if (typeof value === "string") {
      if (value === "write") {
        result[key] = "write";
        continue;
      }
      const replacement = RETIRED_FIELD_MODE_REPLACEMENT[value];
      if (replacement) {
        fail(`mode.${key}: "${value}" has retired — ${replacement}`);
      }
      fail(`mode.${key} ${MODE_SHAPE_MESSAGE}`);
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      fail(`mode.${key} ${MODE_SHAPE_MESSAGE}`);
    }
    const editRaw = value as Record<string, unknown>;
    if (editRaw.mode !== "edit") {
      fail(`mode.${key} ${MODE_SHAPE_MESSAGE}`);
    }
    if (NOTE_SET_MODE_FIELDS.includes(key)) {
      fail(
        `mode.${key}: the edit form has no meaning on a set field — oldString/newString cannot ` +
          `target part of a list; use mode.${key}: "write" with the full replacement set instead.`,
      );
    }
    if (typeof editRaw.oldString !== "string" || editRaw.oldString === "") {
      fail(`mode.${key}.oldString is required and must be a non-empty string.`);
    }
    if (typeof editRaw.newString !== "string") {
      fail(`mode.${key}.newString is required (use "" to delete the matched text).`);
    }
    const oldString = decodeHtmlEntities(editRaw.oldString);
    const newStringRaw = decodeHtmlEntities(editRaw.newString);
    if (containsToolCallSyntax(oldString)) {
      fail(toolCallSyntaxMessage(`mode.${key}.oldString`));
    }
    if (newStringRaw !== "" && containsToolCallSyntax(newStringRaw)) {
      fail(toolCallSyntaxMessage(`mode.${key}.newString`));
    }
    const newString = newStringRaw === "" ? "" : stripPrivateTags(newStringRaw);
    result[key] = { mode: "edit", oldString, newString };
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

  let modeMap: Partial<Record<string, FieldMode>>;
  try {
    modeMap = parseModeMap(input.mode, TURN_MODE_FIELDS);
  } catch (error) {
    if (error instanceof NoteValidationError) {
      return parameterError(error.message);
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
  if (providedFields.length === 0) {
    return parameterError(
      `at least one of ${TURN_MODE_FIELDS.join(", ")} is required.`,
    );
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
  const addressLabel = `S${turn.sessionId}/T${turn.promptNumber}`;

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
  if (
    eraConfigured &&
    !promotesTurnRecord &&
    (input.title !== undefined ||
      input.content !== undefined ||
      input.insight !== undefined ||
      isFieldEditMode(modeMap.title) ||
      isFieldEditMode(modeMap.content) ||
      isFieldEditMode(modeMap.insight))
  ) {
    return parameterError(
      `S${address.sessionId}/T${address.promptNumber} is a pre-cutoff turn, whose prose has no reader —` +
        " title, content and insight cannot be written to it." +
        " Its type and tags are still writable.",
    );
  }

  let result: TurnWriteTransactionResult;
  try {
    result = writeTransaction(db, (): TurnWriteTransactionResult => {
      // Write gate (ticket 03): checked first, inside this transaction, for
      // every field the call actually provided — "检查-写入原子", no gap
      // between this passing and the fields it guards actually landing
      // below. `fail()` throws and unwinds the WHOLE transaction, the same
      // all-or-nothing shape every other whole-call validation in this
      // function already has: one rejected field blocks the rest too.
      if (writer) {
        for (const field of providedFields) {
          const verdict = checkFieldGate(db, writer, "turn", turn.id, field, addressLabel);
          if (!verdict.ok) {
            fail(verdict.message);
          }
        }
      }

      const freshTurn = getTurnById(db, turn.id)!;
      const existingNote = getShadowNote(db, turn.id);
      const noteExisted = existingNote !== null;

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

      const relations = resolveRelationFields(
        db,
        turn.id,
        updatedTurn.type,
        input,
        citations,
        nowEpoch,
      );

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
