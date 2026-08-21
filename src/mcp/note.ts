import type { Database } from "bun:sqlite";

import {
  attachTurnRelations,
  recomputeTurnCitedPairs,
  retractTurnRelations,
  type AttachTurnRelationsResult,
  type CitationRelation,
  type RecomputeTurnCitedPairsResult,
  type RetractTurnRelationsResult,
  type TurnRelationFieldInput,
  type TurnRelationRejection,
  type TurnRelationRejectionReason,
} from "../db/citations";
import { runWriteTransaction } from "../db/database";
import { deriveFlowsForSessions } from "../db/flows";
import type { MemoryEdge } from "../db/memory-edges";
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
import {
  formatGroundsMidFlowWarnings,
  type GroundsMidFlowCandidate,
} from "../shared/grounds-warning";
import {
  isFlowSettlement,
  isOwnFlowMember,
  settlementsOfTurn,
  type FlowDerivation,
} from "../shared/flows";
import {
  decodeHtmlEntities,
  FieldModeError,
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
import {
  containsToolCallSyntax,
  toolCallSyntaxMessage,
} from "../shared/tool-call-syntax";
import {
  MEMORY_TYPES,
  normalizeTypeValues,
  typeListsEqual,
} from "../shared/type-vocabulary";
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

// The one mode vocabulary (write-mode-edit-semantics spec D1/D3/D4/D10/D14) —
// folded into `field-mode.ts` (ticket 07) so both write surfaces share one
// copy; re-exported here so existing importers of these two types keep
// working.
export type { FieldEditMode, FieldMode } from "./field-mode";

// ticket 01 (ADR-0003): `grade` left this list along with the parameter
// itself — the writer records facts, settlement assigns value.
const TURN_MODE_FIELDS = ["title", "content", "insight", "type", "tags"] as const;
type TurnModeField = (typeof TURN_MODE_FIELDS)[number];

/**
 * Ticket 02 (edge-mechanism-revision D1): which field's write gate an EDGE
 * write is judged by. `type`, for two reasons, and it is deliberately not a
 * new field key of its own:
 *
 *   - it is the field the surviving machine check already reads. Whether a
 *     relation is even legal is computed from the citing turn's `type`
 *     (`phasesForTypes` -> `validateRelationTarget`), so "you have seen this
 *     turn's type" is the premise the legality verdict rests on anyway.
 *   - EVERY note write on a turn stamps `type` (the subsumption stamp at the
 *     bottom of the write transaction), so it is the field that records
 *     "somebody maintains this turn". A relation onto a turn another writer
 *     owns, unread by this one, is therefore refused as `never-read`, while
 *     a turn nobody has ever written admits — the same "a create is not
 *     gated on having read the thing it creates" latitude every other field
 *     gets.
 *
 * CHECKED, never STAMPED: an edge write changes no `type` value, and
 * stamping one would tell settlement's yield gate (which reads exactly this
 * stamp as "the agent has fresher knowledge of this turn") that a type
 * correction landed when none did.
 *
 * TICKET 11 (edge-mechanism-revision): EXPORTED, and the settlement facade
 * imports it rather than hardcoding a second `"type"` of its own. The two
 * surfaces used to state the same value twice with a comment on each side
 * promising they matched — a promise nothing checked. One constant makes the
 * divergence unrepresentable instead of merely discouraged.
 */
export const EDGE_WRITE_GATE_FIELD = "type";

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
  /** Bare subject words; the `topic:` namespace is retired (spec B6). */
  tags?: unknown;
  skip?: unknown;
  crossSession?: unknown;

  // Flow-relations spec (ticket 02): one named field per relation, the
  // eight-word vocabulary. Targets are address tokens — see
  // `RELATION_FIELD_ENTRIES` / `resolveRelationFields`. These do not require
  // the same call to touch a prose field, nor the body to name the target.
  override?: unknown;
  narrows?: unknown;
  extends?: unknown;
  collects?: unknown;
  consume?: unknown;
  grounds?: unknown;
  verifies?: unknown;
  refutes?: unknown;

  // Flow-relations spec (ticket 02): the eight retraction mirrors — same
  // address-list shape, `retract` + the relation field's own name, so a
  // caller never has to learn a second spelling of the vocabulary. See
  // `RETRACTION_FIELD_ENTRIES`.
  retractOverride?: unknown;
  retractNarrows?: unknown;
  retractExtends?: unknown;
  retractCollects?: unknown;
  retractConsume?: unknown;
  retractGrounds?: unknown;
  retractVerifies?: unknown;
  retractRefutes?: unknown;

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

// Flow-relations spec (ticket 02): the eight named relation fields, field
// name -> the relation it means — DERIVED from `shared/turn-phase.ts`'s
// `EDGE_RELATIONS`/`RELATION_FIELD_NAME` rather than a second hand-kept
// literal, so the closed set and its parameter spelling cannot drift apart
// (the shared module, not this file, is where the eight-word set and its
// judgment live — this list is only the note surface's OWN wiring of field
// name -> relation onto that constant). `supersedes` is gone: a caller still
// sending it is a `.strict()` parse error at the schema layer
// (`noteInputSchema` omits the field even though `noteInputShape` keeps it
// as frozen documentation) rather than something this list needs to reject
// by hand.
//
// Exported so a guard test can pin that this list's relation VALUES equal
// `EDGE_RELATIONS` exactly and that every key names a real `noteInputShape`
// parameter — the derivation above already makes drift a compile error for
// the relation half, this closes the loop on the parameter-name half too.
export const RELATION_FIELD_ENTRIES: ReadonlyArray<
  readonly [key: string, relation: TurnEdgeRelation]
> = EDGE_RELATIONS.map((relation) => [RELATION_FIELD_NAME[relation], relation] as const);

/**
 * Flow-relations spec (ticket 02): the retraction surface, DERIVED from the
 * relation field names above rather than spelled out a second time —
 * `override` -> `retractOverride`. One mechanical rule for all eight, so
 * a relation added to `EDGE_RELATIONS` tomorrow gets its retraction parameter
 * for free and the two halves cannot drift into different vocabularies.
 * Exported for the same guard test that pins `RELATION_FIELD_ENTRIES` against
 * the schema's real parameter names.
 */
export const RETRACTION_FIELD_ENTRIES: ReadonlyArray<
  readonly [key: string, relation: TurnEdgeRelation]
> = RELATION_FIELD_ENTRIES.map(
  ([key, relation]) =>
    [`retract${key.charAt(0).toUpperCase()}${key.slice(1)}`, relation] as const,
);

const RELATION_REJECTION_TEXT: Record<TurnRelationRejectionReason, string> = {
  malformed: 'is not a valid address ("S<session>/T<prompt>" or "E<segment>")',
  unresolved: "does not resolve to a turn or segment",
  // Flow-relations spec (ticket 02): narrowed to exactly one exception — only
  // `grounds` may ever cite the citing turn itself, and even then only under
  // the settlement+implementer gate `checkRelationTargetPhase`'s pre-check
  // below catches first, with a dynamic message. This reason therefore only
  // ever fires for any OTHER relation, which can never legally cite itself,
  // whatever the phase.
  "self-not-grounds":
    "is this turn's own address, and only grounds may ever cite the citing turn itself — " +
    "every other relation compares two DIFFERENT turns, whatever the phase",
  "no-such-edge":
    "is not a relation this turn currently carries — nothing was retracted; read the turn to see what it does carry",
};

/**
 * Exported (ticket 04, edge-mechanism-revision D6) so the settlement facade
 * reports an address-level edge rejection in the SAME words this surface does:
 * both writers now hold the same relation and retraction vocabulary, and a
 * `no-such-edge` that read differently depending on who called it would be two
 * contracts wearing one name.
 */
export function formatRelationRejections(
  rejections: readonly TurnRelationRejection[],
  surface: "relation" | "retraction",
): string {
  const lines = rejections.map(
    (entry) => `${entry.relation} "${entry.raw}" ${RELATION_REJECTION_TEXT[entry.reason]}`,
  );
  return `${surface} field rejected: ${lines.join("; ")}.`;
}

/**
 * Ticket 11 (edge-mechanism-revision): the retraction receipt, in ONE register
 * both write surfaces render — this tool and the settlement facade
 * (`worker/note-settlement-turn-facade.ts`), which imports it rather than
 * phrasing the same two numbers its own way.
 *
 * `restored` is ticket 10's own outcome and the reason this line needed a
 * second number at all: retracting a pair's last relation puts the BARE row
 * back when the citing prose still names the target, so "the classification is
 * gone but the citation stands" is a third outcome distinct from both
 * "removed" and "nothing happened". Without it on the receipt a writer has to
 * query the graph to learn whether its own retraction cost the `↳`
 * pull-through — and one that does not query assumes the worse of the two.
 *
 * Returns null when nothing was deleted: a retraction that deleted nothing
 * cannot have restored anything either (the whole call is refused by name
 * before any delete — `no-such-edge`), so there is no line to print.
 *
 * Takes COUNTS rather than the row arrays, so the settlement facade — whose
 * outcome type carries numbers, not `MemoryEdge`s — renders the same words
 * without materialising rows it does not keep.
 */
export function formatRetractionReceipt(counts: {
  retracted: number;
  restored: number;
}): string | null {
  if (counts.retracted === 0) {
    return null;
  }
  return (
    `Retracted ${counts.retracted} relation(s)` +
    (counts.restored > 0
      ? `, ${counts.restored} bare citation(s) restored (the prose still names them).`
      : ".")
  );
}

/**
 * Flow-relations spec (ticket 02, P1): the `grounds` mid-flow warning's
 * DB-facing half — resolve each `grounds` edge's cited turn to its address
 * and the settlement(s) its branch reaches (`shared/flows.ts`'s
 * `settlementsOfTurn`), then hand the resolved candidates to
 * `formatGroundsMidFlowWarnings` (shared/grounds-warning.ts), which decides
 * and renders. `flows` is `null` exactly when this call touched neither
 * `grounds` nor `collects` — in that case `edges` carries no `grounds` row
 * either, so the loop below is a no-op and this returns `[]` without ever
 * dereferencing it.
 *
 * The one shared composer both write surfaces use: `mcp/note.ts` calls it
 * directly for its own written+restated edges, and
 * `worker/note-settlement-turn-facade.ts` imports this same function for its
 * own — same trigger condition and wording on both, by construction rather
 * than by discipline. Replaces the retired segment-crossing warning
 * (dcd17fe) — same PATTERN (a pure composer fed already-resolved candidates
 * by this DB-facing half), different trigger and target.
 */
export function collectGroundsMidFlowWarnings(
  db: Database,
  flows: FlowDerivation | null,
  edges: readonly MemoryEdge[],
): string[] {
  if (!flows) {
    return [];
  }
  const candidates: GroundsMidFlowCandidate[] = [];
  for (const edge of edges) {
    if (edge.relation !== "grounds") {
      continue;
    }
    const citedTurn = getTurnById(db, edge.cited.id);
    if (!citedTurn) {
      continue;
    }
    const settlementRefs = settlementsOfTurn(flows, edge.cited.id)
      .map((settlementId) => getTurnById(db, settlementId))
      .filter((turn): turn is TurnRecord => turn !== null)
      .map((turn) => `S${turn.sessionId}/T${turn.promptNumber}`);
    candidates.push({
      targetRef: `S${citedTurn.sessionId}/T${citedTurn.promptNumber}`,
      settlementRefs,
    });
  }
  return formatGroundsMidFlowWarnings(candidates);
}

/**
 * The eight relation (or eight retraction) parameters this call carries, as
 * the shared `{relation, targets}` input both db-layer functions take. Throws
 * the tool's own parameter error for a non-array value, so a caller sending
 * `override: "S1/T2"` is told what shape the field takes rather than having
 * the field silently ignored.
 */
function collectRelationFields(
  entries: ReadonlyArray<readonly [key: string, relation: TurnEdgeRelation]>,
  input: NoteToolInput,
): TurnRelationFieldInput[] {
  const fields: TurnRelationFieldInput[] = [];
  for (const [key, relation] of entries) {
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
  return fields;
}

/** Does this call carry any edge parameter at all — relation or retraction, empty list included? */
function touchesEdgeFields(input: NoteToolInput): boolean {
  return [...RELATION_FIELD_ENTRIES, ...RETRACTION_FIELD_ENTRIES].some(
    ([key]) => (input as Record<string, unknown>)[key] !== undefined,
  );
}

/**
 * Flow-relations spec (ticket 02) / [S15069/T939]: two checks
 * `attachTurnRelations` itself does NOT make, because that function is the
 * generic storage-vocabulary path — it accepts `supersedes` and segment
 * targets so existing edges of that shape stay writable/legible. `note`'s
 * own eight-word surface is narrower, so the narrowing lives here, one layer
 * up, rather than inside the shared function.
 *
 * The JUDGMENT itself — segment targets refused, phase-pair legality, which
 * half is missing, the self-citation gate — is `shared/turn-phase.ts`'s
 * `validateRelationTarget`, not reimplemented here: this function's own job
 * is strictly address parsing, the DB lookup that turns a raw token into the
 * phase-set input that shared judgment needs, and (new this ticket) the
 * `collects` flow-membership hard check — P1's one graph-state rejection,
 * which is NOT part of `validateRelationTarget` because it needs a flow
 * derivation `shared/turn-phase.ts` has no DB access to build.
 *
 * Returns `null` (legal) or the rejection message; a malformed or unresolved
 * address is left for `attachTurnRelations`' own pass to report — this
 * function only has an opinion once an address actually resolves to a node.
 *
 * `flows` is the derivation `resolveRelationFields` built once for this whole
 * call (`null` when neither `collects` nor `grounds` appears in it) — reused
 * here for both the self-`grounds` settlement gate and the `collects`
 * membership check, rather than re-derived per target.
 */
function checkRelationTargetPhase(
  db: Database,
  relation: string,
  raw: string,
  citingTurnId: number,
  citingRef: string,
  citingPhases: ReadonlySet<TurnPhase>,
  flows: FlowDerivation | null,
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
  const isSelf = cited.id === citingTurnId;
  const result = validateRelationTarget({
    relation,
    citingPhases,
    targetKind: "turn",
    citedPhases: phasesForTypes(cited.type),
    isSelfReference: isSelf,
    isSettlement: isSelf && flows !== null ? isFlowSettlement(flows, citingTurnId) : false,
  });
  if (!result.ok) {
    return `${relation} "${raw}" ${result.detail}`;
  }

  // Flow-relations spec, P1 (S15069/T1202's constitutive-interface ruling):
  // collects' one graph-state hard check — OWN structural membership from
  // `deriveFlows`, never inherited. The citing turn must itself be a flow's
  // terminus; every target must be a member of THAT SAME branch.
  if (relation === "collects" && flows !== null) {
    if (flows.flowById.get(citingTurnId) === undefined) {
      return (
        `collects "${raw}" requires the citing turn to itself be a flow's terminus ` +
        `(nothing further narrows/extends it) — ${citingRef} is mid-flow, or belongs to no decision flow at all`
      );
    }
    if (!isOwnFlowMember(flows, citingTurnId, cited.id)) {
      return (
        `collects "${raw}" is not a member of the flow terminating at ${citingRef} — ` +
        "collects only names turns already inside this branch"
      );
    }
  }
  return null;
}

/**
 * Ticket 02 (edge-mechanism-revision D1): a relation field stands on its own.
 * Content carries no citation obligation — a relation field is structured
 * input, not prose a model might hallucinate a bracket into — so what fails
 * the WHOLE write rather than silently dropping the relation is what a claim
 * cannot be right about by construction: phase legality (self-citation
 * included), the `collects` membership hard check, and address resolution.
 *
 * Flow-relations spec (ticket 02): builds ONE flow derivation for the whole
 * call, only when `collects` or `grounds` actually appears in it (every
 * other relation is decided on phase sets alone) — scoped to the citing
 * turn's own session plus every resolved target's own session
 * (`db/flows.ts`'s own documented scope). The SAME derivation is returned to
 * the caller for the post-write `grounds` mid-flow warning
 * (`collectGroundsMidFlowWarnings`): writing the edge this call produces does
 * not change what that warning needs to read (a fresh `grounds` edge affects
 * only the CITING turn's own inherited membership, never the cited turn's),
 * so reusing the pre-write derivation is correct, not merely convenient.
 */
function resolveRelationFields(
  db: Database,
  citingTurnId: number,
  citingSessionId: number,
  citingRef: string,
  citingTurnType: readonly string[],
  input: NoteToolInput,
  nowEpoch: number,
): { attach: AttachTurnRelationsResult; flows: FlowDerivation | null } | null {
  const fields = collectRelationFields(RELATION_FIELD_ENTRIES, input);
  if (fields.length === 0) {
    return null;
  }

  const citingPhases = phasesForTypes(citingTurnType);

  const needsFlows = fields.some(
    (field) => field.relation === "collects" || field.relation === "grounds",
  );
  let flows: FlowDerivation | null = null;
  if (needsFlows) {
    const sessionIds = new Set<number>([citingSessionId]);
    for (const field of fields) {
      if (field.relation !== "collects" && field.relation !== "grounds") {
        continue;
      }
      for (const raw of field.targets) {
        const reference = parseBareAddressReference(raw);
        if (reference && reference.kind === "turn") {
          sessionIds.add(reference.sessionId);
        }
      }
    }
    flows = deriveFlowsForSessions(db, [...sessionIds]);
  }

  // Phase/segment-target/collects/self-citation legality, checked BEFORE
  // `attachTurnRelations`' own address checks — a structurally illegal
  // relation is rejected atomically with every other one found in the same
  // call, the same all-or-nothing shape `attachTurnRelations` already gives
  // its own rejections.
  const phaseIssues: string[] = [];
  for (const field of fields) {
    for (const raw of field.targets) {
      const issue = checkRelationTargetPhase(
        db,
        field.relation,
        raw,
        citingTurnId,
        citingRef,
        citingPhases,
        flows,
      );
      if (issue) {
        phaseIssues.push(issue);
      }
    }
  }
  if (phaseIssues.length > 0) {
    fail(`relation field rejected: ${phaseIssues.join("; ")}.`);
  }

  const attach = attachTurnRelations(db, citingTurnId, fields, nowEpoch);
  if (attach.rejected.length > 0) {
    fail(formatRelationRejections(attach.rejected, "relation"));
  }
  return { attach, flows };
}

/**
 * Ticket 02 (edge-mechanism-revision D3): the retraction half of the same
 * surface. No phase check runs here — legality governs what may be ASSERTED,
 * and an edge that has become illegal (the turn's type was corrected since)
 * is exactly one a writer must still be able to remove. An address carrying
 * no such relation fails the whole call by name (`no-such-edge`), so
 * "already gone" and "wrong address" stay distinguishable.
 */
function resolveRetractionFields(
  db: Database,
  citingTurnId: number,
  input: NoteToolInput,
  nowEpoch: number,
): RetractTurnRelationsResult | null {
  const fields = collectRelationFields(RETRACTION_FIELD_ENTRIES, input);
  if (fields.length === 0) {
    return null;
  }
  const result = retractTurnRelations(db, citingTurnId, fields, nowEpoch);
  if (result.rejected.length > 0) {
    fail(formatRelationRejections(result.rejected, "retraction"));
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
  /** Flow-relations spec: the derivation `resolveRelationFields` built for this call, `null` unless collects/grounds appeared — reused post-write for the grounds mid-flow warning. */
  relationFlows: FlowDerivation | null;
  retractions: RetractTurnRelationsResult | null;
  stripped: boolean;
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
    if (error instanceof FieldModeError) {
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
  // Ticket 02 (edge-mechanism-revision D1): an edge parameter alone is a
  // complete call. The entry gate exists to refuse a call that would do
  // NOTHING, and a pure relation or retraction call does plenty — it just
  // does it to the turn's edges rather than to its prose. Keeping the old
  // "at least one field" wording here would have re-imposed the C7
  // co-occurrence rule at the door, one layer above where it was deleted.
  const touchesEdges = touchesEdgeFields(input);
  if (providedFields.length === 0 && !touchesEdges) {
    return parameterError(
      `at least one of ${TURN_MODE_FIELDS.join(", ")}, a relation field` +
        " (override/narrows/extends/collects/consume/grounds/verifies/refutes)" +
        " or one of their retract… mirrors is required.",
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
      // Both current states are read FIRST (ticket 06: they were read just
      // below before this ticket): the gate check needs to know, per field,
      // whether this write would land over existing content, and reading
      // them inside this same transaction keeps that judgment atomic with
      // the write it guards.
      const freshTurn = getTurnById(db, turn.id)!;
      const existingNote = getShadowNote(db, turn.id);
      const noteExisted = existingNote !== null;

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
        // Ticket 02 (edge-mechanism-revision D1, spec user story 17): an edge
        // write goes through the SAME gate, on the CITING turn — the turn
        // whose record grows an edge — and the cited turn gets no read check
        // at all ([S15069/T1124]). Without this a pure edge call would be the
        // one write on this surface nobody had to have read.
        if (touchesEdges) {
          const verdict = checkFieldGate(
            db,
            writer,
            "turn",
            turn.id,
            EDGE_WRITE_GATE_FIELD,
            addressLabel,
          );
          if (!verdict.ok) {
            fail(verdict.message);
          }
        }
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

      // Retraction runs BEFORE the attach: correcting a wrong relation is
      // "retract it, then write the right one" (D2/D3), and a caller doing
      // both in one call means them in that order.
      const retractions = resolveRetractionFields(db, turn.id, input, nowEpoch);
      const relationsResolution = resolveRelationFields(
        db,
        turn.id,
        turn.sessionId,
        addressLabel,
        updatedTurn.type,
        input,
        nowEpoch,
      );
      const relations = relationsResolution?.attach ?? null;
      const relationFlows = relationsResolution?.flows ?? null;

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
        relationFlows,
        retractions,
        stripped,
      };
    });
  } catch (error) {
    if (error instanceof FieldModeError) {
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

  // Ticket 02: a relation write is additive AND idempotent (D2), so the
  // receipt says which of the two happened — "attached" for a row this call
  // added, "already present" for one it merely restated. A writer that cannot
  // tell them apart reads its own no-op as new work.
  if (result.retractions) {
    // Ticket 11: one shared register with the settlement facade, and it now
    // carries ticket 10's restored count — "classification removed, citation
    // stands" is visible on the receipt instead of only in the graph.
    const retractionLine = formatRetractionReceipt({
      retracted: result.retractions.deleted.length,
      restored: result.retractions.restored.length,
    });
    if (retractionLine) {
      parts.push(retractionLine);
    }
  }
  if (result.relations) {
    const attached = result.relations.written.length;
    const restated = result.relations.restated.length;
    if (attached > 0) {
      parts.push(
        restated > 0
          ? `Attached ${attached} relation(s), ${restated} already present.`
          : `Attached ${attached} relation(s).`,
      );
    } else if (restated > 0) {
      parts.push(`${restated} relation(s) already present, nothing added.`);
    }
    // Flow-relations spec, P1: the grounds mid-flow warning — fires only
    // when this call's own written+restated edges include a `grounds` whose
    // target is mid-flow with a settlement to name; silent otherwise
    // (echo-on-divergence, dead branches included).
    for (const warning of collectGroundsMidFlowWarnings(db, result.relationFlows, [
      ...result.relations.written,
      ...result.relations.restated,
    ])) {
      parts.push(warning);
    }
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
