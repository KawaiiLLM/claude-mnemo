import { z } from "zod";
import type { Database } from "bun:sqlite";

import {
  attachTurnRelations,
  formatRelationRejections,
  formatRetractionReceipt,
  normalizeRelationTargetEntry,
  recomputeTurnCitedPairs,
  retractTurnRelations,
  RELATION_FIELD_ENTRIES,
  RETRACTION_FIELD_ENTRIES,
  type CitationRelation,
  type RelationTargetEntry,
  type TurnRelationFieldInput,
} from "../db/citations";
import { resolveEraCutoff } from "../db/era";
import { collectEdgeSideFacts } from "../db/lane-edge-gate";
import type { EdgeNode } from "../db/memory-edges";
import { closeNoteDebtAsNoted } from "../db/note-debt";
import type { NoteSettlementStage } from "../db/note-settlement";
import { parseBareAddressReference, validateReferences } from "../db/references";
import { getOwningSegmentId } from "../db/segments";
import { getSession, updateSessionFields } from "../db/sessions";
import { getShadowNote, upsertShadowNote } from "../db/shadow-notes";
import { checkTurnTagWrite } from "../db/turn-tag-gate";
import {
  getTurn,
  getTurnById,
  promoteTurnFromNote,
  updateTurnById,
  type TurnRecord,
} from "../db/turns";
import {
  checkFieldGate,
  checkRelationsGate,
  checkTurnLiveForWrite,
  claimWriterId,
  settlementTurnPermissions,
  stampField,
  stampTurnRelationsRevision,
  EDGE_WRITE_GATE_FIELD,
  type SettlementProvenanceIndex,
} from "../db/write-gate";
import { settlementNoteInputShape } from "../mcp/definitions";
import { recordPhaseRetypeAudit } from "../db/phase-retype-audit";
import { detectCompoundRetype } from "../shared/phase-connectivity";
import {
  FieldModeError,
  fieldModeErrorMessage,
  isFieldEditMode,
  MODE_FIELDS,
  parseModeMap,
  requireSetFieldMode,
  resolveStringField,
  type FieldMode,
} from "../mcp/field-mode";
import { clearToolCallSyntaxRejections } from "../shared/tool-call-syntax";
import {
  bracketBareTurnReferences,
  completeReadRemedyForTurnField,
  isValidPredecessorFor,
  parseSessionAddress,
  parseTurnAddress,
  writeOverwritesExistingTurnContent,
} from "../mcp/note";
import {
  formatSessionFieldUsage,
  SESSION_SUMMARY_FIELDS,
} from "../mcp/session-summary";
import { isSegmentEra } from "../segment-era";
import { formatBudgetWarning, formatNoteBudget } from "../shared/note-budget";
import {
  findRetiredTopicTag,
  retiredTopicTagMessage,
  stripPrivateTags,
} from "../shared/tag-stripping";
import { MEMORY_TYPES, normalizeTypeValues } from "../shared/type-vocabulary";
import {
  phasesForTypes,
  validateRelationTarget,
  type TurnEdgeRelation,
  type TurnPhase,
} from "../shared/turn-phase";

/**
 * The settlement turn-write facade (spec G6/G7/D5/D5a; staged commit per
 * spec A7).
 *
 * TICKET 04 (edge-mechanism-revision D6, "结算重武装"): this facade is the
 * main agent's own write surface again, in hindsight. Two retirements this
 * file used to enforce are EXPLICITLY REVOKED:
 *
 *   - "结算不再重建笔记" (ticket 05 below): title/content/insight are
 *     writable, through the SAME `mode` vocabulary, the SAME write gate and —
 *     ticket 07's recorded exemption, closed here — the same complete-read
 *     requirement the main agent's `note` obeys. A settlement pass may rewrite
 *     any note in the window it was shown; what stops it is the gate, not a
 *     categorical refusal. `writer_origin` on the shadow row records who wrote
 *     the text that now stands.
 *   - spec C7's pre-existence fence: `context.eligibleRelationPairKeys`, its
 *     pre-run snapshot, its frozen∩current intersection and the
 *     `duplicate-target` mirror that refused two relations on one pair are all
 *     DELETED (not bypassed — spec user story 18). A relation stands on its
 *     own now (D1), so "the pair must already exist" was the one premise a
 *     rebuild-from-zero settlement could never satisfy: the window it is asked
 *     to connect starts with no edges at all.
 *
 * What is machine-checked on an edge write is exactly what the main agent's
 * surface checks (D1): the CITING turn's own write gate, address existence,
 * tag legality, self-reference. The gate FIELD for an edge write is
 * `mcp/note.ts`'s own `EDGE_WRITE_GATE_FIELD` — CHECKED, never STAMPED — and
 * as of ticket 11 it is IMPORTED, not mirrored: see that constant's own
 * comment for both halves of the reasoning. A divergence here would fork the
 * two writers' gate semantics, which is precisely what this batch retired, so
 * the fork is now unrepresentable rather than merely discouraged.
 *
 * TICKET 05 (ownership-and-note-cadence spec, "settlement demolition"): duty 2
 * — turn prose reconstruction (title/content/insight) — retired outright.
 * REVOKED by ticket 04 above; the paragraph is kept because the plumbing it
 * removed (`context.reconstructableTurnIds`, `upsertReconstructedShadowNote`,
 * `context.rideTurnId`, `context.writerModel`) did NOT come back: prose lands
 * through the ordinary `upsertShadowNote`/`promoteTurnFromNote` path the main
 * agent uses, with no settlement-only "never over an agent note" clause — the
 * write gate is the arbiter now, for both writers alike.
 *
 * TICKET 06 (ownership-and-note-cadence spec, "选举机器拆除"): the election
 * tier (ADR-0003) — the third grading semantics this facade used to accept
 * alongside `grade`, era-gated by `src/election-era.ts` — is GONE. Settlement
 * assigns neither grade nor tier as of ticket 05's duty 1 removal; ticket 06
 * is the storage half, deleting the write surface a model could still
 * technically reach. `grade` stayed reachable a while longer (ADR-0003's
 * "significance_grade 与旧读法保留" carve-out is the STORED column and its
 * read path, not this facade's own acceptance of it) — see TICKET 02 below,
 * which retires that acceptance too. Era-gating and the tier field itself
 * are gone regardless.
 *
 * TICKET 02 (view-render-repair spec, "grading retires whole", ruled at
 * [S15069/T1035]): `grade` leaves this facade outright. `ReviewOutcome`
 * drops its `grade` field, the write-gate check below runs for `type`/`tags`
 * only, and a call still naming `grade` is `.strict()`'s ordinary
 * unrecognised-key parse error at the schema layer
 * (`mcp/definitions.ts`'s `settlementNoteInputShape` no longer declares it)
 * — the same treatment the main `note` tool's own `grade` already got from
 * ADR-0003. The stored `significance_grade` column and its legacy read path
 * (`db/turns.ts`, the pre-era milestone body in `mcp/timeline.ts`) are
 * UNRELATED and untouched — this ticket retires the WRITE surface only,
 * same split ADR-0003 already drew for the tier half.
 *
 * What is granted here, post-ticket-04:
 *
 *   - title/content/insight, type and tags for any turn
 *     `context.reviewableTurnIds` names — the window plus its rendered
 *     lookback — each field admitted or refused by the write gate on its own;
 *   - a relation or a retraction whose CITING turn is likewise one
 *     `context.reviewableTurnIds` names (ticket 07 of this batch made that
 *     range check unconditional for every turn-addressed call, not a
 *     side-effect of also naming prose or type/tags), pointed at any CITED
 *     address that resolves, judged by tag legality and the citing turn's own
 *     gate, with no pre-existence premise of any kind.
 *
 * TICKET 07 (write-mode-edit-semantics spec D12, "结算面与主 agent 完全一致"):
 * every field this facade writes now carries the SAME `mode` the main agent's
 * own `note` tool carries — `write` replaces the field whole, the edit form
 * (`{ mode: "edit", oldString, newString }`) swaps an exactly-matched span
 * within it, and a mode is REQUIRED on a field that already holds something.
 * The engine is `mcp/field-mode.ts`, the single home both surfaces read;
 * settlement has no whole-overwrite path of its own any more (the session
 * narrative's implicit one is what D12 named). This retires the older comment
 * this paragraph replaces ("there is no `mode`, because there is no append"):
 * the difference it described no longer exists, and the append it feared is
 * not what `edit` is — an edit anchors on text the writer has just been shown
 * and the write gate already made it read.
 *
 * TICKET 05 (read-write-contract spec, "结算(直写改造)"): staging is UNWIRED.
 * `note-settlement-sdk-query.ts` calls `evaluateSettlementTurnWrite` directly,
 * inside its own `runWriteTransaction`, once per tool call — gate check, write
 * and stamp in the SAME transaction ("检查-写入原子"), landing immediately with
 * an immediate receipt.
 *
 * TICKET 11 (edge-mechanism-revision): `note-settlement-staging.ts` is DELETED
 * outright, and with it this function's `apply: false`/`true` split. The dry
 * run was kept one ticket longer on the theory that it remained a genuine
 * probe any caller could use — but ticket 04 had already made it a DISHONEST
 * one: both edge primitives validate and mutate indivisibly, so `apply: false`
 * reported the count it would ATTEMPT rather than what would land, and no
 * caller was left to be told the difference. A rejection still comes from a
 * check that runs BEFORE any write in the same call, so a refusal never leaves
 * half a call standing; that property came from ordering, not from the split.
 *
 * TICKET 08 (edge-ownership-impl, "settlement four-field check-and-
 * correct"): the relation half now consumes THE SAME validator the main
 * agent's `note` tool uses — `shared/turn-phase.ts`'s
 * `validateRelationTarget`, driven by the SAME
 * `EDGE_RELATIONS`/`RELATION_FIELD_NAME` constants — rather than the narrower
 * pre-ticket-01 four-relation set (`evidenceFor`/`evidenceAgainst`/
 * `supersedes`/`dependsOn`) this file used to accept with no shared check at
 * all. One validator, both write paths: an illegal target or tag is rejected
 * here with the identical message `mcp/note.ts` produces, not a second,
 * independently-worded rule. `supersedes` is retired from this write surface
 * too — frozen legacy, readable on old rows (`db/citations.ts`), never
 * written by either path any more; lane-model v12 ticket 02 put `refutes` in
 * the same position. Ticket 04 finished the convergence: the target check is
 * now literally `mcp/note.ts`'s own `checkRelationTargetLegality`, and the
 * write is its own `attachTurnRelations`, with `judged` provenance as the
 * single declared difference between the two callers.
 */

// ---------------------------------------------------------------------------
// Job identity (spec G6): per-request context, never a model-suppliable value
// ---------------------------------------------------------------------------

export interface SettlementTurnFacadeContext {
  jobId: number;
  claimGeneration: number;
  /**
   * The THIRD member of the ownership tuple `(job, claimGeneration, stage)`
   * (staged-settlement spec Rev 5, §Identity and authorization). Two things
   * read it and nothing else may derive it independently:
   *
   *   - `claimWriterId(jobId, claimGeneration, stage)`, this dispatch's writer
   *     identity — so every grant family (read grants, per-field completeness,
   *     the relations gate, lane-read receipts) keys on the full tuple and
   *     stage 2 inherits no authority stage 1 earned;
   *   - `assertNoteSettlementJobClaimed`'s `expectedStage`, mounted per write
   *     in `note-settlement-direct-write.ts` — the fence a generation cannot
   *     give, since the generation deliberately does not move at the
   *     transition.
   *
   * REQUIRED, not defaulted. An optional stage would silently file a stage-2
   * context under stage 1's identity, which is precisely the inheritance this
   * field exists to make impossible.
   */
  stage: NoteSettlementStage;
  /** For reference resolution's drop-log prefix only; not an authority gate. */
  sessionId: number;
  /**
   * The writable-range check. Tag-mandate ticket 05: this carries the
   * dispatch's IMMUTABLE WRITABLE SET —
   * `db/note-settlement.ts`'s `computeSettlementWritableTurnIds` over the
   * rendered turns, i.e. window ∪ rendered lookback ∪ the deadlock-guard
   * closure (the cited endpoints of in-scope-anchored edges, so an
   * untagged extends/narrows is repairable by TAGGING and not only by
   * retracting). Fed verbatim from `NoteSettlementQueryRequest.writableTurnIds`
   * by `note-settlement-sdk-query.ts`; nothing here recomputes it, which is
   * what makes the commit gate's verdict and this range check the same
   * question asked twice rather than two sets that can disagree.
   *
   * The FIELD keeps its pre-ticket name only because
   * `note-settlement-membership-facade.ts` shares this interface; the name
   * now under-describes the value, which ticket 06 may settle when it
   * declares the set in the prompt.
   */
  reviewableTurnIds: ReadonlySet<number>;
  /**
   * The SAME ids as `reviewableTurnIds`, each carrying WHY it is writable
   * (staged-settlement spec Rev 5, §Persisted snapshots #1) — ticket 04's
   * frozen `note_settlement_writable_turns` snapshot, read once per request and
   * never re-derived here.
   *
   * It answers one question this facade could not otherwise ask: a turn admitted
   * ONLY as a `removed-side-citer` is in the set because THIS job's own stage-1
   * projection invalidated an edge it cites, and that debt buys relation writes
   * and nothing else — its note fields belong to whichever window owns them.
   * `reviewableTurnIds` is a flat set and cannot express that; without this the
   * citer would arrive holding full authority over a turn no window of this job
   * ever judged.
   *
   * Optional. Absent (a job that never transitioned, or a fixture that models no
   * provenance) means every writable turn carries full authority — exactly the
   * pre-staging behaviour. See `settlementTurnPermissions` for why an absent
   * entry must not become a second refusal of a turn the range check already
   * owns.
   */
  writableProvenance?: SettlementProvenanceIndex;
  /** When this dispatch's context was read — the note-timestamp fence's boundary. */
  contextBuiltAtEpoch: number;
  // Ticket 04 (edge-mechanism-revision D6): `eligibleRelationPairKeys` — the
  // frozen pre-run pair snapshot spec C7 required — is GONE from this context,
  // from the dispatch that built it and from `db/memory-edges.ts`'s own gate.
  // Nothing replaces it: a relation is a standalone claim (D1), so there is no
  // pre-state left for it to be eligible against.
  // Ticket 04 (edge-mechanism-revision D6): `attachedSegmentIds` — ticket 08's
  // membership DOMAIN — is gone from this context too, with the restriction it
  // encoded. Settlement reassigns across segments and creates them, so "which
  // segments may receive a turn" is no longer a question anything asks; the
  // roster still renders in the prompt (`NoteSettlementContext.segmentRoster`)
  // as orientation, which is all it ever was for the model.
  logger?: Pick<Console, "warn">;
}

export type ToolTextResult = {
  content: Array<{ type: "text"; text: string }>;
};

export function textResult(text: string): ToolTextResult {
  return { content: [{ type: "text", text }] };
}

export function parameterError(message: string): ToolTextResult {
  return textResult(`Parameter error: ${message}`);
}

// ---------------------------------------------------------------------------
// Input shape — the model-visible surface
// ---------------------------------------------------------------------------

// No `jobId`/`claimGeneration` field anywhere below. Two independent things
// stop a model-supplied value from reaching them (spec G6):
//
//   1. `note-settlement-sdk-query.ts` registers this SHAPE (not this file's
//      `.strict()` schema) with the SDK's `tool()`, which builds its own
//      zod object from it and parses every call's `arguments` through THAT
//      before the handler runs — an unknown key such as a model-invented
//      `jobId` is therefore never part of what the staging engine
//      receives as `rawInput`, whether the SDK strips it or rejects the
//      call outright.
//   2. Even the staging engine never reads a job identity off `rawInput` —
//      the only value it ever fences against is `context.jobId`/
//      `context.claimGeneration`, closed over from `SettlementTurnFacadeContext`,
//      which the per-request server factory builds from the dispatch's own
//      job record (worker/note-settlement-dispatch.ts). There is no code
//      path from model output into that closure at all — the two live in
//      variables with different names, not the same field gated by a filter
//      that could be forgotten.
//
// Ticket 07 (ADR-0007, semantic-container): the shape itself is no longer
// hand-kept here — it is `mcp/definitions.ts`'s `settlementNoteInputShape`,
// re-exported under this module's pre-existing name so every import site
// (`note-settlement-sdk-query.ts`'s tool registration, this file's own
// `.strict()` schema below, every test that imports it from here) is
// untouched. What moved is only WHERE the field objects are authored: type,
// tags and the four relation fields are the SAME zod objects `noteInputShape`
// declares, so a contract change to one of those reaches both surfaces from
// a single edit in `mcp/definitions.ts` — see that shape's own doc comment
// for which fields are shared and which (title/content, turn) are declared
// fresh because they describe an operation the main `note` tool does not
// have.
//
// Ticket 07 (write-mode-edit-semantics spec D12): `mode` joins it — the SAME
// object `noteInputShape.mode` declares, not a settlement-flavoured copy, so
// the two surfaces cannot drift into two vocabularies (the parity test
// tests/worker/note-settlement-parity.test.ts asserts that identity at the
// tool-REGISTRATION boundary, where a prose claim of sameness cannot reach).
// Ticket 08 folded that key into `settlementNoteInputShape` itself — it was
// spread here for one ticket only, while ticket 06 held `mcp/definitions.ts`
// open — so this was a plain re-export, one object, no local key.
//
// Phase-connectivity ticket 01 (spec "Compound-retype is not a free pass")
// reopens exactly that shape, with exactly that one-ticket reasoning: a
// SETTLEMENT-ONLY key, `typeReason`, spread on top rather than added to
// `settlementNoteInputShape` itself — the main agent's own `note` tool
// shares that base shape and this rule is settlement's alone (ticket 01's
// own scope line: the retype audit belongs to settlement's hindsight write,
// never a capability the main agent is taught to reach for). Every other
// key is still the SAME field object the main tool declares (`mode`,
// `type`, … — spreading copies references, not values, so
// `settlementTurnWriteInputShape.mode === noteInputShape.mode` still holds).
export const settlementTurnWriteInputShape = {
  ...settlementNoteInputShape,
  /**
   * Ticket 01: required ONLY for a compound retype — a write that turns a
   * landing-only turn (type intersects implement/fix/refactor, no basis
   * word) into a compound one by adding a basis word (design/correction/
   * measure/research/review). Names the ACCURATE basis the turn's content
   * actually carries and why (a measurement adds "measure", an
   * investigation "research", a review finding "review" — never a default
   * "design"/"correction" unless the turn truly set or revised a
   * commitment). Every other `type` write ignores this field entirely.
   */
  typeReason: z
    .string()
    .max(500)
    .optional()
    .describe(
      "Required ONLY when this write adds a basis word (design/correction/measure/research/" +
        "review) to a turn whose type was landing-only (implement/fix/refactor, no basis word) — " +
        "the accurate basis this turn's content carries and why, never a default. Every other " +
        "type write ignores this field.",
    ),
};

export const settlementTurnWriteInputSchema = z
  .object(settlementTurnWriteInputShape)
  .strict();

export type SettlementTurnWriteInput = z.infer<
  typeof settlementTurnWriteInputSchema
>;

// Ticket 08 derived its own `RELATION_FIELD_ENTRIES` here from the same
// constants `mcp/note.ts` derives from; ticket 04 stopped deriving twice and
// IMPORTS both that list and its `RETRACTION_FIELD_ENTRIES` mirror. Two
// derivations from one constant cannot drift in their VALUES, but they can (and
// did) drift in which halves of the vocabulary each surface wires up at all —
// importing removes even that.

/** The three prose fields, in the order a receipt reads best. */
const PROSE_FIELDS = ["title", "content", "insight"] as const;
type ProseField = (typeof PROSE_FIELDS)[number];

/**
 * The relation (or retraction) parameters this call carries, in
 * the `{relation, targets}` shape both `db/citations.ts` primitives take. The
 * zod shape has already proved each entry is a bare address or
 * `{turn, tailTag, headTag}` (lane-model-v12 ticket 08's `RelationTargetEntry`
 * union), so this collector has no type-check to fail — it is the only edge
 * write surface left, and the schema is always in front of it.
 */
function collectRelationFields(
  entries: ReadonlyArray<readonly [key: string, relation: CitationRelation]>,
  rawInput: SettlementTurnWriteInput,
): TurnRelationFieldInput[] {
  const fields: TurnRelationFieldInput[] = [];
  for (const [key, relation] of entries) {
    const provided = (rawInput as Record<string, unknown>)[key] as
      | RelationTargetEntry[]
      | undefined;
    if (provided !== undefined && provided.length > 0) {
      fields.push({ relation: relation as TurnRelationFieldInput["relation"], targets: provided });
    }
  }
  return fields;
}

/**
 * One reviewed field's own outcome (ticket 05, read-write-contract spec
 * "结算(直写改造)"): `landed` is what the write gate's per-field
 * three-judgment check (`checkFieldGate`, writer = this dispatch's claim
 * identity) actually decided, checked and applied independently for
 * type/tags — never a single all-or-nothing verdict for the whole review.
 * `yieldedReason` is the gate's own rejection text (never-read or stale)
 * when `landed` is false; this IS the new yield semantics (spec: "门的
 * 'stale'拒绝就是新的yield 语义") — an agent note landing after this
 * dispatch's context was read re-stamps `type`/`tags` (the note->turn field
 * mapping, ticket 01), so this dispatch's own stale grant on those fields is
 * what rejects the correction, with no separate `noteSupersedesReview` check
 * left to duplicate that logic. Ticket 02 (view-render-repair spec, "grading
 * retires whole"): `grade` — the one field of this trio that was NOT
 * note-derived, and so used to land regardless of whether `type`/`tags` on
 * the same call yielded — is gone; every field left here now goes through
 * the identical note-derived path.
 */
export interface ReviewFieldOutcome<T> {
  value: T;
  landed: boolean;
  yieldedReason?: string;
}

export interface ReviewOutcome {
  type?: ReviewFieldOutcome<string[]>;
  tags?: ReviewFieldOutcome<string[]>;
}

export interface RelationOutcome {
  /** Rows this call ADDED (ticket 04: `attachTurnRelations`' own additive count). */
  written: number;
  /** Accepted targets whose (pair, relation) row was already stored — a restatement, not new work. */
  restated: number;
  /** Rows a `retract…` mirror deleted in this same call (D3). */
  retracted: number;
  /**
   * Ticket 10's own outcome, surfaced by ticket 11: BARE rows put back because
   * the retraction emptied a pair the citing prose still names. A different
   * fact from `retracted` — the classification is gone, the citation stands —
   * and the receipt has to be able to say so without a follow-up query.
   */
  restored: number;
}

/**
 * Ticket 04 (edge-mechanism-revision D6): the prose half of a turn write —
 * settlement's revoked duty 2. `fields` names what this call actually wrote,
 * `noteExisted` distinguishes a first note from a rewrite (the receipt's own
 * "Noted"/"Updated" split on the main agent's surface), and the two budget
 * strings are the SAME feedback `mcp/note.ts` puts on every prose receipt —
 * settlement writes under the same field budgets, so it is told about them in
 * the same words.
 */
export interface ProseOutcome {
  fields: ProseField[];
  noteExisted: boolean;
  stripped: boolean;
  budget: string;
  budgetWarning: string | null;
}

/**
 * Ticket 09 (edge-ownership-impl, "结算顺手维护 session 叙事"): the outcome of
 * a `session`-addressed call — `title`/`content` resolved through the shared
 * `mode` vocabulary (ticket 07: `write` replaces whole, the edit form swaps a
 * span; no null-clear on either path). `titleWritten`/
 * `contentWritten` distinguish "field present in the call" from "field
 * landed", since `title` is expected to be a no-op on most windows (it is
 * set once, when still empty — the session row itself is not visible to this
 * facade's caller, so "was it actually empty" is answered by
 * `evaluateSettlementSessionWrite` at read time, not assumed here).
 */
export interface SessionNarrativeOutcome {
  sessionId: number;
  titleWritten: boolean;
  contentWritten: boolean;
  usage: string[];
}

export interface SettlementTurnWriteOutcome {
  ref: string;
  /** `null` for a `session`-addressed outcome — there is no turn row. */
  turnId: number | null;
  review: ReviewOutcome | null;
  relations: RelationOutcome | null;
  /** Ticket 04: the turn's own prose, `null` when this call wrote none. */
  prose: ProseOutcome | null;
  /** `null` for a `turn`-addressed outcome. */
  session: SessionNarrativeOutcome | null;
  /**
   * Severed-lane over-blocking fix: the (turn, tag) pairs THIS CALL actually
   * landed — one entry per tag in a landed `tags` write, plus one entry per
   * PLACED side (tail or head) of every edge this call attached or restated.
   * `[]` for a call that touched neither (a pure prose write, a session
   * narrative, a rejected relation). Consumed by
   * `note-settlement-direct-write.ts`'s touch accumulator, never read
   * anywhere else — this is not a general-purpose "what did this call touch"
   * receipt, only the lane-disposition gate's own input.
   */
  laneTouches: Array<{ turnId: number; tag: string }>;
  /**
   * Ticket 04: the LANE-ADDRESSED touches this call landed — `(segment, tag)`,
   * for the one destructive case the `(turn, tag)` shape above structurally
   * cannot carry. A landed `tags` write that REMOVED a lane tag takes the
   * turn OUT of that lane, so the gate — which resolves a `(turn, tag)` touch
   * through the lane's current island membership — would find the turn is no
   * longer a member and match nothing. The lane the turn LEFT is named
   * directly here instead. `[]` when this call removed no lane tag, or when
   * the turn belongs to no segment (a homeless lane has no segment row to
   * bind a justify to, and the gate skips it anyway).
   */
  laneKeyTouches: Array<{ segmentId: number; tag: string }>;
}

export type SettlementTurnWriteEvaluation =
  | { ok: true; outcome: SettlementTurnWriteOutcome }
  | { ok: false; message: string };

// A session row has no insight, no facets and no edges — every one of these is
// a TURN field, and a session-addressed call naming one is told so by name
// rather than by a generic parse error. Derived for the two edge halves
// (ticket 04 adds the retraction mirrors) so a relation added to the
// vocabulary tomorrow is refused here without anyone remembering to type it.
const SESSION_ONLY_FORBIDDEN_FIELDS: readonly string[] = [
  "insight",
  "type",
  "tags",
  ...RELATION_FIELD_ENTRIES.map(([key]) => key),
  ...RETRACTION_FIELD_ENTRIES.map(([key]) => key),
];

/**
 * The session-narrative branch (ticket 09, edge-ownership-impl: "结算顺手维
 * 护 session 叙事"). Settlement is the session's SOLE writer now — `note`'s
 * own session address retired outright (`mcp/note.ts`). `title` is set once
 * (this function does not special-case "already non-empty" beyond the mode
 * requirement below — the PROMPT is what tells the model to leave it alone
 * once set — prompt-only enforcement USER-RATIFIED at [S15069/T1040] against
 * a hard first-set gate and an explicit-flag variant: T913's "极少改" allows
 * rare changes, and the prompt is the ruled keeper of that judgment).
 *
 * TICKET 07 (write-mode-edit-semantics spec D12): the whole-overwrite this
 * function used to perform IMPLICITLY is now the declared `mode.<field>:
 * "write"`, and `content`'s increment has a second, cheaper expression —
 * `mode.content` = the edit form, anchored on the tail of the text the model
 * was just shown. Both run through `mcp/field-mode.ts`, the same engine the
 * main agent's `note` uses; a non-empty field with no mode is refused with
 * that engine's own message rather than silently clobbered.
 */
function evaluateSettlementSessionWrite(
  db: Database,
  context: SettlementTurnFacadeContext,
  rawInput: SettlementTurnWriteInput,
  modeMap: Partial<Record<string, FieldMode>>,
  nowEpoch: number,
): SettlementTurnWriteEvaluation {
  const sessionId = parseSessionAddress(rawInput.session!);
  if (sessionId === null) {
    return {
      ok: false,
      message: `session must be a "S<session>" address; got "${rawInput.session}".`,
    };
  }
  const ref = `S${sessionId}`;

  if (sessionId !== context.sessionId) {
    return {
      ok: false,
      message:
        `${ref} is not this dispatch's own session (S${context.sessionId}) — ` +
        "settlement may only write its own session's narrative.",
    };
  }

  for (const key of SESSION_ONLY_FORBIDDEN_FIELDS) {
    if ((rawInput as Record<string, unknown>)[key] !== undefined) {
      return { ok: false, message: `${key} is a turn field; this call addresses a session.` };
    }
    // Ticket 07: a mode naming a turn-only field is the same mistake as the
    // field itself, and gets the same message — `parseModeMap` admitted it
    // because the VOCABULARY is shared across both address kinds; which
    // fields this particular call may carry is this branch's own business.
    if (modeMap[key] !== undefined) {
      return { ok: false, message: `mode.${key} is a turn field; this call addresses a session.` };
    }
  }

  // Ticket 07 (spec D10): a field touched ONLY through the edit form carries
  // no value of its own — it still counts as a field this call writes.
  const sessionFields = (["title", "content"] as const).filter(
    (field) => rawInput[field] !== undefined || isFieldEditMode(modeMap[field]),
  );
  if (sessionFields.length === 0) {
    return {
      ok: false,
      message: `at least one of ${SESSION_SUMMARY_FIELDS.join(", ")} is required.`,
    };
  }

  const session = getSession(db, sessionId);
  if (!session) {
    return { ok: false, message: `no session at ${ref}.` };
  }

  // The narrative is a MANAGED write surface too (read-write-contract spec:
  // "受管面…session 字段写(含结算叙事)"), gated field-by-field under this
  // dispatch's claim identity — the grant comes from the context build's own
  // full-document render (note-settlement-context.ts). What this fences in
  // practice is the OTHER settlement writer: a lapsed claimant whose
  // successor already re-narrated this session sees its grant stale and is
  // told to re-read, instead of whole-overwriting the newer narrative.
  const sessionWriter = claimWriterId(
    context.jobId,
    context.claimGeneration,
    context.stage,
  );
  for (const field of sessionFields) {
    const verdict = checkFieldGate(db, sessionWriter, "session", sessionId, field, ref);
    if (!verdict.ok) {
      return { ok: false, message: verdict.message };
    }
  }

  // Ticket 07: mode resolution runs AFTER the gate, same order `mcp/note.ts`'s
  // own turn write uses — the gate answers "have you read what is there", and
  // an `edit` applied to text this writer never read is exactly what it
  // exists to stop. `nullable: false`: settlement cannot CLEAR a session
  // narrative (the shape carries no null and an edit that empties the field is
  // refused), it replaces or edits it.
  let resolved: Partial<Record<"title" | "content", string | null>>;
  try {
    resolved = Object.fromEntries(
      sessionFields.map((field) => [
        field,
        resolveStringField(field, rawInput[field], session[field], modeMap[field], {
          nullable: false,
        }).value,
      ]),
    );
  } catch (error) {
    if (error instanceof FieldModeError) {
      return { ok: false, message: fieldModeErrorMessage(error, ref) };
    }
    throw error;
  }

  updateSessionFields(
    db,
    sessionId,
    {
      title: resolved.title,
      content: resolved.content,
    },
    nowEpoch,
  );
  for (const field of sessionFields) {
    stampField(db, "session", sessionId, field, sessionWriter, nowEpoch);
  }

  const usage: string[] = [];
  for (const field of sessionFields) {
    usage.push(formatSessionFieldUsage(field, resolved[field] ?? null));
  }

  clearToolCallSyntaxRejections(ref);

  return {
    ok: true,
    outcome: {
      ref,
      turnId: null,
      review: null,
      relations: null,
      prose: null,
      session: {
        sessionId,
        titleWritten: sessionFields.includes("title"),
        contentWritten: sessionFields.includes("content"),
        usage,
      },
      // A session narrative names no turn's lane — see the field's own doc.
      laneTouches: [],
      laneKeyTouches: [],
    },
  };
}

/**
 * The address a call names, read straight off the raw input (peer round P2-6).
 * Deliberately independent of every parse below it: the consecutive-rejection
 * counter keys on the address, so a call whose ADDRESS is fine and whose
 * `mode` is malformed has to count against that address — otherwise a model
 * looping on the same bad edit form is never told it is looping. `null` only
 * when neither field carries a parseable address, which is the one case where
 * there is genuinely nothing to count against.
 */
function rawAddressLabel(rawInput: SettlementTurnWriteInput): string | null {
  if (typeof rawInput.turn === "string") {
    const address = parseTurnAddress(rawInput.turn);
    if (address) {
      return `S${address.sessionId}/T${address.promptNumber}`;
    }
  }
  if (typeof rawInput.session === "string") {
    const sessionId = parseSessionAddress(rawInput.session);
    if (sessionId !== null) {
      return `S${sessionId}`;
    }
  }
  return null;
}

/**
 * The settlement turn-write facade's whole decision. Returns a structured
 * `{ ok, ... }` rather than throwing — the caller (the direct-write engine)
 * decides what a failure means at its own layer, which is not this function's
 * business. Ticket 11 removed the `apply` parameter: there is one form, and it
 * writes.
 *
 * Ticket 09: `session` (exclusive with `turn`) routes to
 * `evaluateSettlementSessionWrite` above — the rest of this function is
 * unchanged, turn-addressed behaviour.
 */
export function evaluateSettlementTurnWrite(
  db: Database,
  context: SettlementTurnFacadeContext,
  rawInput: SettlementTurnWriteInput,
  nowEpoch: number,
): SettlementTurnWriteEvaluation {
  // Ticket 07 (spec D12): parsed ONCE, ahead of the address branch and against
  // the FULL field list `mcp/note.ts` parses against — one vocabulary for both
  // surfaces and both address kinds. Which of those fields a given call may
  // actually carry is each branch's own refusal below, so a `mode.type` on a
  // session call (or a `mode.title` on a turn call) is named for what it is
  // rather than for being an unknown word.
  // Peer round P2-6: the address this call is ABOUT, derived from the raw
  // input before anything is parsed. The mode parse below runs ahead of the
  // turn/session branch (one vocabulary for both address kinds) and used to
  // report its rejection with `address = null` — which reads to
  // `fieldModeErrorMessage` as "unaddressable", so the consecutive-rejection
  // counter had nothing to count against and the loop escalation never fired
  // for a model repeating the same malformed `mode.*` on the same turn. Null
  // now means what it says: no usable address in the call at all.
  const syntaxAddressLabel = rawAddressLabel(rawInput);

  let modeMap: Partial<Record<string, FieldMode>>;
  try {
    modeMap = parseModeMap(rawInput.mode, MODE_FIELDS);
  } catch (error) {
    if (error instanceof FieldModeError) {
      return { ok: false, message: fieldModeErrorMessage(error, syntaxAddressLabel) };
    }
    throw error;
  }

  if (rawInput.session !== undefined) {
    if (rawInput.turn !== undefined) {
      return { ok: false, message: "exactly one of turn or session is required, not both." };
    }
    return evaluateSettlementSessionWrite(db, context, rawInput, modeMap, nowEpoch);
  }
  if (rawInput.turn === undefined) {
    return { ok: false, message: "exactly one of turn or session is required." };
  }

  const address = parseTurnAddress(rawInput.turn);
  if (!address) {
    return {
      ok: false,
      message: `turn must be a fully qualified "S<session>/T<prompt>" address; got "${rawInput.turn}".`,
    };
  }
  const ref = `S${address.sessionId}/T${address.promptNumber}`;

  // Ticket 04 (edge-mechanism-revision D6): the prose fields are settlement's
  // again — ticket 05's outright refusal is REVOKED. A field touched ONLY
  // through `mode.<field>` (the edit form carries its whole payload there,
  // spec D10) counts as written, same rule `mcp/note.ts` applies.
  const proseFields = PROSE_FIELDS.filter(
    (field) => rawInput[field] !== undefined || isFieldEditMode(modeMap[field]),
  );

  const touchesReview =
    rawInput.type !== undefined ||
    rawInput.tags !== undefined;
  const relationFields = collectRelationFields(RELATION_FIELD_ENTRIES, rawInput);
  const retractionFields = collectRelationFields(RETRACTION_FIELD_ENTRIES, rawInput);

  if (
    proseFields.length === 0 &&
    !touchesReview &&
    relationFields.length === 0 &&
    retractionFields.length === 0
  ) {
    return {
      ok: false,
      message:
        "at least one of title, content, insight, type, tags, a relation field" +
        " (override/narrows/extends/indexes/consume/grounds/verifies)" +
        " or one of their retract… mirrors is required.",
    };
  }

  let normalizedType: string[] | undefined;
  if (rawInput.type !== undefined) {
    try {
      normalizedType = normalizeTypeValues(rawInput.type);
    } catch (error) {
      return {
        ok: false,
        message: `${error instanceof Error ? error.message : String(error)}. Allowed: ${MEMORY_TYPES.join(", ")}.`,
      };
    }
  }

  // Ticket 10d: the retired `topic:` namespace (spec B6) stays retired at
  // THIS write boundary too. `mcp/note.ts` refuses it loudly rather than
  // silently stripping it (`findRetiredTopicTag`/`retiredTopicTagMessage`,
  // shared/tag-stripping.ts) — reused verbatim here, not re-derived, because
  // 10a's own judgement call already put this facade on "match the note
  // tool's own discipline: a live tool call the agent can retry is not a
  // fire-and-forget batch" for every other rejection (relations, prose
  // targets). The retiring write-back silently STRIPPED the prefix instead,
  // but that was a batch parser with no agent to correct after a refusal;
  // this facade is not that any more.
  if (rawInput.tags !== undefined) {
    const retiredTag = findRetiredTopicTag(rawInput.tags);
    if (retiredTag) {
      return { ok: false, message: retiredTopicTagMessage(retiredTag) };
    }
  }

  const turn = getTurn(db, address.sessionId, address.promptNumber);
  if (!turn) {
    return { ok: false, message: `no turn at ${ref}.` };
  }
  if (turn.type.includes("compact")) {
    return { ok: false, message: `${ref} is a compact marker, not a turn.` };
  }

  // Scope, UNCONDITIONAL (ticket 07, edge-mechanism-revision; peer final-review
  // must-fix 1, [S15069/T1138]; spec D6 "渲染即授权"): rendering IS
  // authorization, so a turn this prompt did not show is out of reach for
  // EVERY kind of write addressed at it — prose, type/tags, a relation and a
  // retraction alike. This check used to run only when `touchesReview ||
  // proseFields.length > 0`, which left a pure-relation or pure-retraction call
  // to be caught, if at all, by the edge write gate further down; the gate's
  // third judgment ("nobody ever wrote this field") ADMITS a hidden turn that
  // carries no type chapter, so `T2 depends-on T1` landed on a turn outside the
  // window — the peer reproduced exactly that. Range is now decided before the
  // gate, on the CITING turn only.
  //
  // The CITED target is deliberately NOT range-checked ([S15069/T1124]): an
  // edge is written on the citing side and the cited turn gets no check of any
  // kind, which is what lets a window connect to what came before it.
  if (!context.reviewableTurnIds.has(turn.id)) {
    return {
      ok: false,
      message:
        `${ref} is outside this dispatch's reviewable window — its writable ` +
        "set is the window, its lookback, and the cited endpoints those " +
        "turns' own edges reach. A turn's fields and its edges may only be " +
        "written for a turn that set names; recalling a turn outside it " +
        "grants reading, never writing.",
    };
  }

  // RELATION-WRITES-ONLY AUTHORITY (staged-settlement spec Rev 5, §Stage-1
  // final projection: "authorizing relation writes only on that turn — note
  // fields stay out of reach"). A turn whose ONLY provenance is
  // `removed-side-citer` joined the writable set because this job's own stage-1
  // projection removed a lane from a turn it cites, leaving that edge's side
  // attribution pointing at a lane its endpoint has left. That debt is the
  // whole of the job's claim on this turn: it may retract or re-place the edge,
  // and it may not touch a single note field.
  //
  // AFTER the range check and BEFORE the tag gate, for the same reason the tag
  // gate sits where it does: "may you write this turn at all" is the earlier
  // question, and "may you write THIS KIND of thing on it" is earlier than any
  // vocabulary judgment about the value.
  //
  // The union rule is ticket 04's `settlementWritePermissions`, reached through
  // `settlementTurnPermissions` — never re-derived here (spec reviewer guardrail
  // 1). A turn that is BOTH an ordinary member and a removed-side citer takes
  // the union and keeps full field authority.
  const permissions = settlementTurnPermissions(context.writableProvenance, turn.id);
  if (!permissions.fields) {
    const refusedFields = [
      ...proseFields,
      ...(rawInput.type !== undefined ? (["type"] as const) : []),
      ...(rawInput.tags !== undefined ? (["tags"] as const) : []),
    ];
    if (refusedFields.length > 0) {
      return {
        ok: false,
        message:
          `${ref} is writable to this dispatch for its RELATIONS ONLY — it is here because this ` +
          "job's own lane removal invalidated an edge it cites, and discharging that debt is the " +
          `whole of the authority that grants. ${refusedFields.join(", ")} ${
            refusedFields.length === 1 ? "belongs" : "belong"
          } to whichever window owns this turn's fields, not to this one. Retract the edge, or ` +
          "re-place its sides with a {turn, tailTag, headTag} entry.",
      };
    }
  }

  // The TAGS write gate (lane-model-v12 ticket 14, spec D3b/D3e) — the SAME
  // check `mcp/note.ts` applies to the main agent, on the same one function,
  // because settlement writes this field too and a rule enforced on one of two
  // writers is not a rule. Refused before anything lands: an illegal tag set is
  // not a field a caller can yield on, it is a call that never had a legal
  // form. Membership follows automatically from whatever does land
  // (`updateTurnById` -> `deriveTurnSegmentMembership`).
  //
  // AFTER the scope check above, deliberately: authorization is the earlier
  // question. A turn this dispatch may not write at all should hear that,
  // not a vocabulary lecture about a field it was never allowed to touch.
  if (rawInput.tags !== undefined) {
    const gate = checkTurnTagWrite(db, {
      nextTags: rawInput.tags,
      priorTags: turn.tags,
    });
    if (!gate.ok) {
      return { ok: false, message: `${ref}: ${gate.message}` };
    }
  }

  const writer = claimWriterId(context.jobId, context.claimGeneration, context.stage);

  // Severed-lane over-blocking fix: the (turn, tag) pairs this call itself
  // lands, collected as each mutation below actually applies rather than
  // re-derived from the input after the fact — a rejected write, a yielded
  // field or a draft (unplaced) edge side never reaches this list. A landed
  // `tags` write adds one entry per tag below; a landed edge side adds its
  // own once `attachTurnRelations` reports which rows actually landed.
  const laneTouches: Array<{ turnId: number; tag: string }> = [];
  // Ticket 04: the lane-addressed half — see `laneKeyTouches`' own doc on the
  // outcome type for why a tag REMOVAL cannot ride the list above.
  const laneKeyTouches: Array<{ segmentId: number; tag: string }> = [];

  let review: ReviewOutcome | null = null;
  const landedUpdate: { type?: string[]; tags?: string[] } = {};
  // Phase-connectivity ticket 01: set only when THIS call's type write is a
  // compound retype whose `typeReason` gate passed — the persistent audit
  // record is written after `landedUpdate` actually lands (below), so a
  // rolled-back call (the caller's own write transaction) never leaves an
  // audit row for a type that never landed.
  let pendingRetypeAudit: {
    oldTypes: string[];
    newTypes: string[];
    basisWord: string;
    reason: string;
  } | null = null;
  if (touchesReview) {

    // Ticket 07 (spec D4/D12): the SAME set-field rule the main agent's own
    // `note` obeys — a type/tags that already holds something is replaced only
    // when the call SAYS so (`mode.<field>: "write"`, the full replacement
    // set). The edit form never reaches here: `parseModeMap` refuses it on a
    // set field. This is an input verdict, not a gate verdict — it rejects the
    // whole call before anything lands, rather than yielding one field.
    try {
      if (normalizedType !== undefined) {
        requireSetFieldMode("type", turn.type, modeMap.type);
      }
      if (rawInput.tags !== undefined) {
        requireSetFieldMode("tags", turn.tags, modeMap.tags);
      }
    } catch (error) {
      if (error instanceof FieldModeError) {
        return { ok: false, message: fieldModeErrorMessage(error, ref) };
      }
      throw error;
    }

    // Ticket 05 (read-write-contract spec "结算(直写改造)"): the write
    // gate's per-field three-judgment check, writer = this dispatch's claim
    // identity (`claimWriterId`, ticket 01's pinned encoding) — checked
    // independently for each of type/tags this call actually
    // provided, replacing the old single `noteSupersedesReview` fence. The
    // context build recorded a read grant on THIS turn for this same claim
    // identity (worker/note-settlement-context.ts); a field the gate now
    // finds stale means an agent note (or another claim) stamped it after
    // that grant — this outcome's `yieldedReason` is exactly what teaches
    // that, in the gate's own words.
    // Peer round P2-1: type/tags are WHOLE replacements (spec D4 — there is no
    // merge form), so replacing a NON-EMPTY one has to be authorized by a read
    // that delivered the current set complete, exactly as the main agent's own
    // `note` already required. Without it an entity grant earned by a
    // content-only recall was enough to drop a turn's lane and identity tags
    // sight-unseen — the same class of loss `requireCompleteRead` exists for on
    // the prose fields, on the two fields where the loss is silent.
    const reviewGateOptions = (field: "type" | "tags") => ({
      requireCompleteRead: writeOverwritesExistingTurnContent(
        field,
        turn,
        null,
        modeMap[field],
      ),
      completeReadRemedy: completeReadRemedyForTurnField(field, ref),
    });
    const outcome: ReviewOutcome = {};

    if (normalizedType !== undefined) {
      const verdict = checkFieldGate(
        db,
        writer,
        "turn",
        turn.id,
        "type",
        ref,
        reviewGateOptions("type"),
      );
      if (!verdict.ok) {
        outcome.type = { value: normalizedType, landed: false, yieldedReason: verdict.message };
      } else {
        // Phase-connectivity ticket 01 ("Compound-retype is not a free
        // pass"): a write that turns a landing-only turn into a compound one
        // by adding a basis word owes a reason — checked here, AFTER the
        // ordinary write gate, so a stale-grant refusal is still reported as
        // that refusal and never masked by this one.
        const retype = detectCompoundRetype(turn.type, normalizedType);
        const reason = rawInput.typeReason?.trim();
        if (retype !== null && !reason) {
          outcome.type = {
            value: normalizedType,
            landed: false,
            yieldedReason:
              `this write turns a landing-only turn (type [${turn.type.join(",")}]) into a ` +
              `compound one by adding "${retype.basisWord}" — phase-connectivity ticket 01 requires ` +
              `typeReason: the accurate basis this turn's content actually carries and why (not a ` +
              `default). Resend with typeReason set.`,
          };
        } else {
          outcome.type = { value: normalizedType, landed: true };
          landedUpdate.type = normalizedType;
          if (retype !== null) {
            pendingRetypeAudit = {
              oldTypes: turn.type,
              newTypes: normalizedType,
              basisWord: retype.basisWord,
              reason: reason!,
            };
          }
        }
      }
    }
    if (rawInput.tags !== undefined) {
      const verdict = checkFieldGate(
        db,
        writer,
        "turn",
        turn.id,
        "tags",
        ref,
        reviewGateOptions("tags"),
      );
      outcome.tags = verdict.ok
        ? { value: rawInput.tags, landed: true }
        : { value: rawInput.tags, landed: false, yieldedReason: verdict.message };
      if (verdict.ok) {
        landedUpdate.tags = rawInput.tags;
      }
    }

    review = outcome;
  }

  // ---- Prose (ticket 04, D6): validated here, applied below --------------
  //
  // Nothing in this block writes. The whole call's rejections are collected
  // before the first mutation, so a refusal on the third field never leaves
  // the first two standing — the same all-or-nothing shape `mcp/note.ts` gets
  // for free from its single write transaction.
  const existingNote = proseFields.length > 0 ? getShadowNote(db, turn.id) : null;
  const noteExisted = existingNote !== null;
  const eraCutoffEpoch = resolveEraCutoff(db);
  const promotesTurnRecord = isSegmentEra(turn.createdAtEpoch, eraCutoffEpoch);

  // Peer round P2-3: liveness, checked here — inside the caller's write
  // transaction and ahead of every mutation below (the retraction is the
  // first). A run can be minutes long; a turn rolled back or skipped since
  // this dispatch's context was built is no longer a node the commit loader
  // will even see, so a write to it lands nowhere the window is judged from.
  // `revivesTurn`: the late note is the one write `skipped` exists to wait
  // for (same rule as `mcp/note.ts` — see its own comment for why the era does
  // not enter into it).
  const livenessVerdict = checkTurnLiveForWrite(db, turn.id, ref, {
    revivesTurn: proseFields.length > 0,
  });
  if (!livenessVerdict.ok) {
    return { ok: false, message: livenessVerdict.message };
  }
  let resolvedProse:
    | {
        title: string | null | undefined;
        content: string | null | undefined;
        insight: string | null | undefined;
        stripped: boolean;
        finalTitle: string;
        finalContent: string;
        finalInsight: string | null;
      }
    | null = null;

  if (proseFields.length > 0) {
    // The same destination rule the main agent obeys (`mcp/note.ts`): a
    // pre-cutoff turn never promotes, so its prose could only land in
    // `shadow_notes`, which no reader reads. Refusing says so at the call
    // instead of writing a record nobody will ever meet. An UNCONFIGURED era
    // (the rollback) means "every turn is legacy", and there the shadow row is
    // the intended and only record — so the refusal is conditional on the era
    // existing, exactly as it is on the main surface.
    if (eraCutoffEpoch !== null && !promotesTurnRecord) {
      return {
        ok: false,
        message:
          `${ref} is a pre-cutoff turn, whose prose has no reader — title,` +
          " content and insight cannot be written to it. Its type and tags are" +
          " still writable.",
      };
    }

    // The gate, per field, BEFORE mode resolution — the order is load-bearing
    // on both surfaces: the gate answers "have you read what is there", and an
    // `edit` applied to text this writer never read is what it exists to stop.
    //
    // `requireCompleteRead` is ticket 07's recorded exemption, closed (ticket
    // 04's pinned decision "同门同要求"): a whole-field `write` over content
    // another writer put there must be authorized by a render that showed the
    // field WHOLE. Settlement earns that record in its own context build
    // (worker/note-settlement-context.ts flushes the turn render's per-field
    // completeness), so a note that fitted the per-turn budget is rewritable
    // and a truncated one is refused — the identical verdict the main agent
    // gets from a truncated recall, in the identical words, remedy included.
    for (const field of proseFields) {
      const verdict = checkFieldGate(db, writer, "turn", turn.id, field, ref, {
        requireCompleteRead: writeOverwritesExistingTurnContent(
          field,
          turn,
          existingNote,
          modeMap[field],
        ),
        completeReadRemedy: completeReadRemedyForTurnField(field, ref),
      });
      if (!verdict.ok) {
        return { ok: false, message: verdict.message };
      }
    }

    let title: string | null | undefined;
    let content: string | null | undefined;
    let insight: string | null | undefined;
    try {
      title =
        rawInput.title !== undefined || isFieldEditMode(modeMap.title)
          ? resolveStringField("title", rawInput.title, existingNote?.title ?? null, modeMap.title, {
              nullable: false,
            }).value
          : undefined;
      content =
        rawInput.content !== undefined || isFieldEditMode(modeMap.content)
          ? resolveStringField(
              "content",
              rawInput.content,
              existingNote?.content ?? null,
              modeMap.content,
              { nullable: false },
            ).value
          : undefined;
      insight =
        rawInput.insight !== undefined || isFieldEditMode(modeMap.insight)
          ? resolveStringField(
              "insight",
              rawInput.insight,
              existingNote?.insight ?? null,
              modeMap.insight,
              { nullable: true },
            ).value
          : undefined;
    } catch (error) {
      if (error instanceof FieldModeError) {
        return { ok: false, message: fieldModeErrorMessage(error, ref) };
      }
      throw error;
    }

    if (!noteExisted && (title === undefined || content === undefined)) {
      return {
        ok: false,
        message: "a first note for this turn requires both title and content.",
      };
    }

    // Private-tag stripping and the bare-`T<n>` bracketing convenience, the
    // same two normalizations every note on the main surface gets — a note is
    // a note whoever wrote it, and a settlement rewrite that skipped them
    // would produce prose the reader's own resolver cannot follow.
    const rawTitle = title !== undefined ? title : existingNote?.title ?? null;
    const rawContent = content !== undefined ? content : existingNote?.content ?? null;
    const rawInsight = insight !== undefined ? insight : existingNote?.insight ?? null;
    const strippedTitle = rawTitle === null ? null : stripPrivateTags(rawTitle);
    const strippedContent = rawContent === null ? null : stripPrivateTags(rawContent);
    const strippedInsight = rawInsight === null ? null : stripPrivateTags(rawInsight);
    const finalContent =
      strippedContent === null
        ? null
        : bracketBareTurnReferences(
            strippedContent,
            isValidPredecessorFor(db, {
              id: turn.id,
              sessionId: turn.sessionId,
              promptNumber: turn.promptNumber,
            }),
          );

    resolvedProse = {
      title,
      content,
      insight,
      stripped:
        strippedTitle !== rawTitle ||
        strippedContent !== rawContent ||
        strippedInsight !== rawInsight,
      // Non-null by construction past the first-note check above: either this
      // call resolved them or the existing note supplied them.
      finalTitle: strippedTitle as string,
      finalContent: finalContent as string,
      finalInsight: strippedInsight,
    };
  }

  // ---- Relations (D1): address, self-reference, tags — and nothing
  // else. rubric-v10 ticket 02 retires the flow derivation this block used
  // to build for `grounds` calls (`db/flows.ts`'s `deriveFlowsForSessions`)
  // — the lane model derives no flow at write time; self-`grounds` legality
  // (Gate C) is a graph fact read straight off `memory_edges` AFTER the
  // write lands, not a flow structure computed beforehand.
  const citingPhases = (): ReadonlySet<TurnPhase> => {
    // Ticket 08: the citing turn's phase set reflects THIS SAME call's own
    // type correction when present — mirrors `mcp/note.ts`'s
    // `resolveRelationFields`. UNLESS the type field itself yielded (the write
    // gate found it stale): then the proposed type never reaches the database.
    // Lane-model v12 left this set ONE reader — the self-`grounds` implementer
    // half — since no relation word is judged by phase any more.
    const typeCorrectionLands = review?.type === undefined || review.type.landed;
    return phasesForTypes(typeCorrectionLands ? normalizedType ?? turn.type : turn.type);
  };

  // The citing turn's own tags, reflecting THIS SAME call's own tag correction
  // when it landed — the tag-half mirror of `citingPhases` above, same
  // "yielded means the proposed value never reached the database" rule. This is
  // what the TAIL side is judged against, both for the subset invariant and for
  // which segment the citing turn belongs to (membership is derived from tags,
  // spec D3e), so an edge written in the same call that moves the turn is
  // judged against where the turn ENDS UP.
  const citingTurnTags = (): readonly string[] => {
    const tagsCorrectionLands = review?.tags === undefined || review.tags.landed;
    return tagsCorrectionLands ? (landedUpdate.tags ?? turn.tags) : turn.tags;
  };

  if (relationFields.length > 0) {
    const phases = citingPhases();
    const citingTags = citingTurnTags();

    const rejections: string[] = [];
    for (const field of relationFields) {
      const key = RELATION_FIELD_ENTRIES.find(([, relation]) => relation === field.relation)![0];
      for (const entry of field.targets) {
        const { raw, tailTag, headTag } = normalizeRelationTargetEntry(entry);
        const reference = parseBareAddressReference(raw);
        if (!reference) {
          rejections.push(`${key} "${raw}" is not a valid address`);
          continue;
        }
        const { accepted } = validateReferences(db, [reference], {
          writerSessionId: context.sessionId,
          logger: context.logger,
        });
        const node: EdgeNode | undefined = accepted[0]?.node;
        if (!node) {
          rejections.push(`${key} "${raw}" does not resolve to a turn or segment`);
          continue;
        }
        // ONE validator: segment targets refused, SELF targets refused outright
        // (lane-model-v12 ticket 04), then each PLACED side — canonical form,
        // declaration in THAT side's own segment, and the subset invariant. The
        // WORD itself is never refused (lane-model v12 ticket 02), and neither
        // is a DRAFT (ticket 20): an edge with either side left empty is written
        // here and refused at `commit` as error E6, not refused at this gate.
        const isSelf = node.kind === "turn" && node.id === turn.id;
        const citedTurn = node.kind === "turn" ? getTurnById(db, node.id) : null;
        const legality = validateRelationTarget({
          relation: field.relation as TurnEdgeRelation,
          citingPhases: phases,
          targetKind: node.kind,
          isSelfReference: isSelf,
          tailTag,
          headTag,
          // spec D2: the per-side evidence. A segment target has no cited TURN
          // to place, so none is gathered; `validateRelationTarget` has already
          // refused it above.
          laneSides:
            node.kind === "turn"
              ? collectEdgeSideFacts(db, {
                  tailTag,
                  headTag,
                  citing: {
                    address: `S${turn.sessionId}/T${turn.promptNumber}`,
                    tags: citingTags,
                  },
                  cited: {
                    address: citedTurn
                      ? `S${citedTurn.sessionId}/T${citedTurn.promptNumber}`
                      : `turn #${node.id}`,
                    tags: citedTurn?.tags ?? [],
                  },
                })
              : undefined,
        });
        if (!legality.ok) {
          rejections.push(`${key} "${raw}" ${legality.detail}`);
          continue;
        }
      }
    }
    if (rejections.length > 0) {
      return { ok: false, message: `relation field rejected: ${rejections.join("; ")}.` };
    }
  }

  // Ticket 02 (D1, spec user story 17): an edge write goes through the SAME
  // gate as everything else, on the CITING turn — the turn whose record grows
  // an edge — and the cited turn gets no read check at all ([S15069/T1124]).
  // The gate FIELD is `mcp/note.ts`'s own `EDGE_WRITE_GATE_FIELD` (imported,
  // ticket 11 — whose comment carries the reasoning): CHECKED, never STAMPED,
  // because an edge write corrects no type and a stamp would tell the next
  // settlement pass a type correction landed when none did.
  if (relationFields.length > 0 || retractionFields.length > 0) {
    const verdict = checkFieldGate(db, writer, "turn", turn.id, EDGE_WRITE_GATE_FIELD, ref);
    if (!verdict.ok) {
      return { ok: false, message: verdict.message };
    }
    // Peer round P1-8: and the relation SET's own gate. Under pull, the run's
    // `recall` IS its view of the graph — a claim that writes an edge without
    // having read the current set is stating how the lane stands from memory
    // of a prompt that no longer renders one. The gate consumes the same
    // completeness record every other field's does, recorded when the
    // `relations` field renders (`mcp/format.ts`'s `GATED_TURN_FIELDS`), under
    // this run's own claim identity.
    const relationsVerdict = checkRelationsGate(db, writer, turn.id, ref);
    if (!relationsVerdict.ok) {
      return { ok: false, message: relationsVerdict.message };
    }
  }

  // ---- Apply ------------------------------------------------------------
  let relations: RelationOutcome | null = null;
  // Retraction runs BEFORE the attach: correcting a wrong relation is
  // "retract it, then write the right one" (D2/D3), and a caller doing both
  // in one call means them in that order. It is also the first mutation of
  // the whole evaluation, so its own all-or-nothing rejection (an address
  // carrying no such edge) still precedes every other write.
  let retracted = 0;
  let restored = 0;
  if (retractionFields.length > 0) {
    const result = retractTurnRelations(db, turn.id, retractionFields, nowEpoch);
    if (result.rejected.length > 0) {
      return { ok: false, message: formatRelationRejections(result.rejected, "retraction") };
    }
    retracted = result.deleted.length;
    // Ticket 04 (phase-connectivity, "a touch ledger as durable as the writes
    // it guards"): a RETRACTED edge's two lane sides are touches exactly like
    // an attached edge's are. Removing the sole bridging edge of an otherwise
    // whole lane is the single most direct way a run can SEVER one, and the
    // touch list used to record nothing at all for it — so `commit` passed
    // over a fracture this run had just created, with neither stitch nor
    // justify. Both endpoints keep their lane tags across a retraction, so
    // both stay members of the lane and the `(turn, tag)` shape resolves
    // normally. Same two skips as the attach side: an unplaced side carries
    // `''`, and a segment-kind cited side carries no turn id.
    for (const edge of result.deleted) {
      if (edge.tailTag !== "") {
        laneTouches.push({ turnId: edge.citing.id, tag: edge.tailTag });
      }
      if (edge.headTag !== "" && edge.cited.kind === "turn") {
        laneTouches.push({ turnId: edge.cited.id, tag: edge.headTag });
      }
    }
    // Ticket 10's restore, carried onto the receipt by ticket 11: emptying a
    // pair whose prose still names the target puts the BARE row back, so the
    // ↳ pull-through survives a retraction. Counted separately because "the
    // citation stands" is not "the relation stands".
    restored = result.restored.length;
  }

  if (landedUpdate.type !== undefined || landedUpdate.tags !== undefined) {
    updateTurnById(db, turn.id, { ...landedUpdate, updatedAtEpoch: nowEpoch });
    // Stamp gate (spec "检查-写入原子"): only the fields that actually
    // landed, same writer identity the check above used — a yielded
    // field must NOT be re-stamped, or a second correction attempt in
    // this same run would find its own prior (rejected) call admitted.
    if (landedUpdate.type !== undefined) {
      stampField(db, "turn", turn.id, "type", writer, nowEpoch);
    }
    if (landedUpdate.tags !== undefined) {
      stampField(db, "turn", turn.id, "tags", writer, nowEpoch);
      for (const tag of landedUpdate.tags) {
        laneTouches.push({ turnId: turn.id, tag });
      }
      // Ticket 04: the tags this write REMOVED (previous set minus landed
      // set). Dropping a bridge member's lane tag severs the lane just as
      // surely as retracting the bridging edge does, and the new set alone
      // says nothing about it. Recorded as a LANE-addressed touch, not a
      // (turn, tag) one: the turn is no longer in the lane it just left, so
      // the gate's membership lookup would never find it there — see
      // `laneKeyTouches`' doc on the outcome type. Reading
      // `getOwningSegmentId` AFTER `updateTurnById` is safe rather than
      // lucky: ownership lives in `segment_members`, and `updateTurnById`
      // writes the `turns` row alone — it re-derives no membership, so the
      // answer here is the same one a read before the update would give.
      const landedTagSet = new Set(landedUpdate.tags);
      const removedTags = turn.tags.filter((tag) => !landedTagSet.has(tag));
      if (removedTags.length > 0) {
        const owningSegmentId = getOwningSegmentId(db, turn.id);
        if (owningSegmentId !== null) {
          for (const tag of removedTags) {
            laneKeyTouches.push({ segmentId: owningSegmentId, tag });
          }
        }
      }
    }
    // Phase-connectivity ticket 01: the persistent audit record, written only
    // once the type write it describes has actually landed (never on a
    // yielded field, never on a rolled-back transaction).
    if (pendingRetypeAudit) {
      recordPhaseRetypeAudit(db, {
        jobId: context.jobId,
        turnId: turn.id,
        oldTypes: pendingRetypeAudit.oldTypes,
        newTypes: pendingRetypeAudit.newTypes,
        basisWord: pendingRetypeAudit.basisWord,
        reason: pendingRetypeAudit.reason,
        createdAtEpoch: nowEpoch,
      });
    }
  }

  if (resolvedProse) {
    upsertShadowNote(db, {
      turnId: turn.id,
      title: resolvedProse.finalTitle,
      content: resolvedProse.finalContent,
      insight: resolvedProse.finalInsight,
      // `writer_origin` is the audit fact this write owes the reader: the
      // text that now stands is settlement's, whoever wrote the previous
      // draft. `writerModel`/`rideTurnId` have no settlement analogue — the
      // model is not plumbed to this layer and a settlement pass rides no
      // turn — and are left null rather than inherited, since a rewrite that
      // kept them would attribute the new text to the old author.
      writerOrigin: "settlement",
      nowEpoch,
    });
    closeNoteDebtAsNoted(db, turn.id, nowEpoch);
    if (promotesTurnRecord) {
      const promoted = promoteTurnFromNote(db, turn.id, {
        title: resolvedProse.finalTitle,
        content: resolvedProse.finalContent,
        insight: resolvedProse.finalInsight,
        updatedAtEpoch: nowEpoch,
      });
      // The bare citation layer follows the prose that produced it
      // (`reconcileCitedPairs`, narrowed to bare rows only — relation rows
      // are standalone claims that die by retraction, never by a rewrite).
      recomputeTurnCitedPairs(
        db,
        turn.id,
        {
          title: promoted?.title ?? resolvedProse.finalTitle,
          content: promoted?.content ?? resolvedProse.finalContent,
          insight: promoted?.insight ?? resolvedProse.finalInsight,
        },
        nowEpoch,
        turn.sessionId,
        context.logger,
      );
    }
    for (const field of proseFields) {
      stampField(db, "turn", turn.id, field, writer, nowEpoch);
    }
  }

  if (relationFields.length > 0) {
    // The main agent's own primitive (ticket 02), called with settlement's
    // provenance — one attach path, one dedupe rule, one written/restated
    // split, and `judged` as the single declared difference.
    const attached = attachTurnRelations(db, turn.id, relationFields, nowEpoch, "judged");
    if (attached.rejected.length > 0) {
      // Unreachable in practice: the pass above already rejected every
      // malformed, unresolvable and self-referential address by name. Kept
      // because the primitive owns those checks and a silent drop here would
      // be the one failure mode neither layer reports.
      return { ok: false, message: formatRelationRejections(attached.rejected, "relation") };
    }
    // lane-model-v12 ticket 04: no post-transaction gate stands here any
    // more. The one that did re-read the live graph to decide whether a
    // self-`grounds` still held its lane's terminus; self edges are refused
    // outright at `validateRelationTarget` now, so no edge this call lands
    // can make one legal after the fact.
    relations = {
      written: attached.written.length,
      restated: attached.restated.length,
      retracted,
      restored,
    };
    // Both ADDED and RESTATED count as touching the sides they place — a
    // restatement is still this call asserting the edge, not new work, and
    // ticket 02's own "a genuine stitch self-evidences" wording never says
    // the stitch has to be first-time. An unplaced (draft, E6) side carries
    // `''` and is skipped; a segment-kind cited side carries no turn id at
    // all and is skipped the same way.
    for (const edge of [...attached.written, ...attached.restated]) {
      if (edge.tailTag !== "") {
        laneTouches.push({ turnId: edge.citing.id, tag: edge.tailTag });
      }
      if (edge.headTag !== "" && edge.cited.kind === "turn") {
        laneTouches.push({ turnId: edge.cited.id, tag: edge.headTag });
      }
    }
  } else if (retracted > 0) {
    relations = { written: 0, restated: 0, retracted, restored };
  }

  // Peer round P1-8: one bump for whatever this call actually changed about
  // the set — a restatement changes nothing and moves nothing, so it does not
  // send every other reader back for a re-read it does not need. Placed after
  // Gate C above: a call that rolls back must not leave a revision behind
  // claiming a change that did not survive (the caller wraps this evaluation
  // in one transaction, so the stamp unwinds with everything else, but the
  // ordering keeps that true independently of the caller's shape).
  if (relations && (relations.written > 0 || relations.retracted > 0)) {
    stampTurnRelationsRevision(db, turn.id, writer, nowEpoch);
  }

  clearToolCallSyntaxRejections(ref);

  return {
    ok: true,
    outcome: {
      ref,
      turnId: turn.id,
      review,
      relations,
      prose: resolvedProse
        ? {
            fields: [...proseFields],
            noteExisted,
            stripped: resolvedProse.stripped,
            budget: formatNoteBudget({
              title: resolvedProse.finalTitle,
              content: resolvedProse.finalContent,
              insight: resolvedProse.finalInsight,
            }),
            budgetWarning:
              formatBudgetWarning({
                title: resolvedProse.finalTitle,
                content: resolvedProse.finalContent,
                insight: resolvedProse.finalInsight,
              }) || null,
          }
        : null,
      session: null,
      laneTouches,
      laneKeyTouches,
    },
  };
}

/**
 * Render one turn-write outcome as tool-result text.
 *
 * Ticket 11: the `staged`/`replaced` options are GONE with the staging engine
 * that was their only source. Every receipt reads "Landed", because every
 * write already has by the time this renders — a "Staged … (pending commit)"
 * string that no caller can produce is a lie waiting for a future caller to
 * tell.
 */
export function renderSettlementTurnWriteReceipt(
  outcome: SettlementTurnWriteOutcome,
): string {
  const verb = "Landed";
  const parts: string[] = [];
  if (outcome.review) {
    const landedBits: string[] = [];
    const yieldedBits: string[] = [];
    const describeArray = (value: string[]): string =>
      value.length > 0 ? value.join(",") : "(none)";
    if (outcome.review.type) {
      if (outcome.review.type.landed) {
        landedBits.push(`type ${describeArray(outcome.review.type.value)}`);
      } else {
        yieldedBits.push(`type — ${outcome.review.type.yieldedReason}`);
      }
    }
    if (outcome.review.tags) {
      if (outcome.review.tags.landed) {
        landedBits.push(`tags ${describeArray(outcome.review.tags.value)}`);
      } else {
        yieldedBits.push(`tags — ${outcome.review.tags.yieldedReason}`);
      }
    }
    if (landedBits.length > 0) {
      parts.push(
        `${verb} review for ${outcome.ref}: ${landedBits.join(", ")}.`,
      );
    }
    if (yieldedBits.length > 0) {
      parts.push(`Yielded for ${outcome.ref}: ${yieldedBits.join("; ")}.`);
    }
  }
  if (outcome.prose) {
    // The main agent's own receipt vocabulary: "Noted" for a first note,
    // "Updated (replaced the previous note)" for a rewrite, then the budget —
    // settlement writes under the same budgets, so it is told about them in
    // the same words rather than left to guess from silence.
    parts.push(
      `${verb} note for ${outcome.ref}: ${outcome.prose.fields.join(", ")}` +
        `${outcome.prose.noteExisted ? " (replaced the previous note)" : ""}.`,
    );
    parts.push(`budget: ${outcome.prose.budget}`);
    if (outcome.prose.budgetWarning) {
      parts.push(outcome.prose.budgetWarning);
    }
    if (outcome.prose.stripped) {
      parts.push("Private-tagged content was removed before storing.");
    }
  }
  if (outcome.relations) {
    // Ticket 11: the SAME register `mcp/note.ts` renders (its
    // `formatRetractionReceipt`, imported), including ticket 10's restored
    // count — one wording for both write surfaces, not two.
    const retractionLine = formatRetractionReceipt(outcome.relations);
    if (retractionLine) {
      parts.push(retractionLine);
    }
    // Ticket 04: additive AND idempotent (D2), so the receipt says which of
    // the two happened — a writer that cannot tell "attached" from "already
    // present" reads its own no-op as new work.
    if (outcome.relations.written > 0) {
      parts.push(
        `${verb} ${outcome.relations.written} relation(s)` +
          `${outcome.relations.restated > 0 ? `, ${outcome.relations.restated} already present` : ""}.`,
      );
    } else if (outcome.relations.restated > 0) {
      parts.push(`${outcome.relations.restated} relation(s) already present, nothing added.`);
    }
  }
  if (outcome.session) {
    const fields = [
      outcome.session.titleWritten ? "title" : null,
      outcome.session.contentWritten ? "content" : null,
    ].filter((field): field is string => field !== null);
    parts.push(
      `${verb} session narrative for ${outcome.ref} (${fields.join(", ")})` +
        `${outcome.session.usage.length > 0 ? `: ${outcome.session.usage.join(", ")}` : ""}.`,
    );
  }
  if (parts.length === 0) {
    parts.push(`No-op for ${outcome.ref}.`);
  }
  return parts.join(" ");
}
