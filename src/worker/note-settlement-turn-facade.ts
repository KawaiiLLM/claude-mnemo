import { z } from "zod";
import type { Database } from "bun:sqlite";

import {
  getOutgoingEdges,
  pairKey,
  writeMemoryEdges,
  type CitingNode,
  type EdgeNode,
  type WriteEdgeInput,
} from "../db/memory-edges";
import { parseBareAddressReference, validateReferences } from "../db/references";
import { getSession, updateSessionFields } from "../db/sessions";
import { getTurn, getTurnById, updateTurnById } from "../db/turns";
import { checkFieldGate, claimWriterId, stampField } from "../db/write-gate";
import { settlementNoteInputShape } from "../mcp/definitions";
import { parseSessionAddress, parseTurnAddress } from "../mcp/note";
import {
  formatSessionFieldUsage,
  SESSION_SUMMARY_FIELDS,
} from "../mcp/session-summary";
import { findRetiredTopicTag, retiredTopicTagMessage } from "../shared/tag-stripping";
import { MEMORY_TYPES, normalizeTypeValues } from "../shared/type-vocabulary";
import {
  EDGE_RELATIONS,
  phasesForTypes,
  RELATION_FIELD_NAME,
  validateRelationTarget,
  type TurnEdgeRelation,
  type TurnPhase,
} from "../shared/turn-phase";

/**
 * The settlement turn-write facade (spec G6/G7/D5/D5a; staged commit per
 * spec A7).
 *
 * TICKET 05 (ownership-and-note-cadence spec, "settlement demolition"): duty 2
 * — turn prose reconstruction (title/content/insight) — retires OUTRIGHT.
 * "结算不再重建笔记": the prose write path this file used to carry
 * (`context.reconstructableTurnIds`, `upsertReconstructedShadowNote`,
 * `context.rideTurnId`, `context.writerModel`) is GONE, not merely unused —
 * a call naming title/content/insight is now refused loudly rather than
 * silently ignored, the same "never silent" discipline the retired `topic:`
 * tag namespace already gets. Grade/type/tags stay reachable through this
 * same facade — the STRUCTURED correction path (type/tags/relations, and
 * membership through the sibling `remember` facade) survives; only the
 * PROSE path is what duty 2 took with it.
 *
 * TICKET 06 (ownership-and-note-cadence spec, "选举机器拆除"): the election
 * tier (ADR-0003) — the third grading semantics this facade used to accept
 * alongside `grade`, era-gated by `src/election-era.ts` — is GONE. Settlement
 * assigns neither grade nor tier as of ticket 05's duty 1 removal; ticket 06
 * is the storage half, deleting the write surface a model could still
 * technically reach. `grade` stays reachable (ADR-0003's "significance_grade
 * 与旧读法保留" — old grade data and its read path are UNRELATED to tier and
 * are untouched), but era-gating and the tier field itself are gone.
 *
 * What is granted here, post-ticket-06:
 *
 *   - grade/type/tags ONLY for a turn `context.reviewableTurnIds`
 *     names — the window plus its rendered lookback — and yields the
 *     note-derived half (type/tags) to an agent note that landed after this
 *     dispatch's context was read (grade always lands: judged from raw
 *     material, not from the note);
 *   - a relation ONLY on a pair already present in
 *     `context.eligibleRelationPairKeys` — a snapshot the caller takes ONCE
 *     before the model run starts (spec C7/C14: "a reply cannot create its
 *     own eligibility", generalised from a single transaction's pre-state to
 *     a whole run's, because a run is many small transactions rather than
 *     one).
 *
 * Every field is whole-overwrite when present, omitted-leaves-alone
 * otherwise (spec D5a) — there is no `mode`, because there is no append: a
 * writer that could accumulate onto a field this project cannot audit inside
 * one live agentic run is exactly the replay hazard segment `extend` and
 * session `append` already carry, and this facade does not need to invent a
 * third case of it.
 *
 * TICKET 05 (read-write-contract spec, "结算(直写改造)"): staging is UNWIRED.
 * `note-settlement-sdk-query.ts` now calls `evaluateSettlementTurnWrite`
 * directly with `apply: true`, inside its own `runWriteTransaction`, once per
 * tool call — gate check, write, and stamp in the SAME transaction ("检查-写
 * 入原子"), landing immediately with an immediate receipt. `note-settlement-
 * staging.ts` (spec A7's staged-commit engine) still exists and still compiles
 * against this function's `apply: false`/`true` split, but nothing calls it
 * any more; the split itself is kept because `apply: false` remains a genuine
 * dry run any caller could still use, not because anything still stages
 * through it.
 *
 * `evaluateSettlementTurnWrite` stays a plain decision function either way —
 * every READ it needs (turn lookup, reference resolution) always runs live
 * against the database; only the WRITES (`updateTurnById`, `writeMemoryEdges`,
 * the write gate's own `stampField`) are conditional on `apply: true`.
 *
 * TICKET 08 (edge-ownership-impl, "settlement four-field check-and-
 * correct"): the relation half now consumes THE SAME validator the main
 * agent's `note` tool uses — `shared/turn-phase.ts`'s `validateRelationTarget`
 * / `isRelationLegalForPhases` / `explainRelationPhaseRejection`, driven by
 * the SAME `EDGE_RELATIONS`/`RELATION_FIELD_NAME` constants — rather than the
 * narrower pre-ticket-01 four-relation set (`evidenceFor`/`evidenceAgainst`/
 * `supersedes`/`dependsOn`) this file used to accept with no phase check at
 * all. One validator, both write paths: a phase-illegal relation is rejected
 * here with the identical "which half is missing" message `mcp/note.ts`
 * produces, not a second, independently-worded rule. `supersedes` is retired
 * from this write surface too — frozen legacy, readable on old rows
 * (`db/citations.ts`), never written by either path any more. The same-run
 * eligibility fence (`context.eligibleRelationPairKeys`, spec C7) is
 * untouched — the phase check is an ADDITIONAL gate, not a replacement for
 * it.
 */

// ---------------------------------------------------------------------------
// Job identity (spec G6): per-request context, never a model-suppliable value
// ---------------------------------------------------------------------------

export interface SettlementTurnFacadeContext {
  jobId: number;
  claimGeneration: number;
  /** For reference resolution's drop-log prefix only; not an authority gate. */
  sessionId: number;
  /** The review-scope check (window plus rendered lookback). */
  reviewableTurnIds: ReadonlySet<number>;
  /** When this dispatch's context was read — the note-timestamp fence's boundary. */
  contextBuiltAtEpoch: number;
  /**
   * Pair keys (`memory-edges.ts`'s `pairKey`) eligible for a relation on THIS
   * dispatch's whole model run — taken ONCE, before the run starts, by the
   * caller (`worker/note-settlement-dispatch.ts`). Not recomputed per call:
   * recomputing it fresh at the top of each tool call's own transaction would
   * let an EARLIER call in the same run mint a pair and a LATER call in the
   * same run treat that freshly-minted pair as "pre-existing" and self-license
   * a relation on it — precisely the violation this snapshot exists to close.
   * Unaffected by staging: nothing lands before `commit`, so the run's own
   * writes never enter this set either way.
   */
  eligibleRelationPairKeys: ReadonlySet<string>;
  /**
   * Ticket 08 (edge-ownership-impl): the legal DOMAIN for a membership
   * correction — this session's currently attached segment ids
   * (`NoteSettlementContext.segmentRoster`, projected down to bare ids).
   * `db/segments.ts`'s `listAttachedSegments` doc comment anticipates this
   * exact field name. A membership reassign naming any other segment, or
   * attaching a NEW one, is out of settlement's authority — the main agent
   * alone grows a session's attachment set.
   */
  attachedSegmentIds: ReadonlySet<number>;
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
// for which fields are shared and which (title/content, turn, grade) are
// declared fresh because they describe an operation the main `note` tool
// does not have.
export const settlementTurnWriteInputShape = settlementNoteInputShape;

export const settlementTurnWriteInputSchema = z
  .object(settlementTurnWriteInputShape)
  .strict();

export type SettlementTurnWriteInput = z.infer<
  typeof settlementTurnWriteInputSchema
>;

// Ticket 08: derived from `EDGE_RELATIONS`/`RELATION_FIELD_NAME` — the SAME
// derivation `mcp/note.ts`'s own `RELATION_FIELD_ENTRIES` uses — so the
// seven-word closed set and its parameter spelling cannot drift apart
// between the two write paths.
const RELATION_FIELD_ENTRIES: ReadonlyArray<
  readonly [key: string, relation: TurnEdgeRelation]
> = EDGE_RELATIONS.map((relation) => [RELATION_FIELD_NAME[relation], relation] as const);

/**
 * One reviewed field's own outcome (ticket 05, read-write-contract spec
 * "结算(直写改造)"): `landed` is what the write gate's per-field
 * three-judgment check (`checkFieldGate`, writer = this dispatch's claim
 * identity) actually decided, checked and applied independently for
 * grade/type/tags — never a single all-or-nothing verdict for the whole
 * review. `yieldedReason` is the gate's own rejection text (never-read or
 * stale) when `landed` is false; this IS the new yield semantics (spec:
 * "门的'stale'拒绝就是新的yield 语义") — an agent note landing after this
 * dispatch's context was read re-stamps `type`/`tags` (the note->turn field
 * mapping, ticket 01), so this dispatch's own stale grant on those fields is
 * what rejects the correction, with no separate `noteSupersedesReview` check
 * left to duplicate that logic. `grade` is checked by the SAME gate, on its
 * own field — it is not note-derived (nothing stamps `grade` from a note
 * write), so in the ordinary case its grant simply never goes stale and it
 * lands regardless of whether `type`/`tags` on the SAME call yield.
 */
export interface ReviewFieldOutcome<T> {
  value: T;
  landed: boolean;
  yieldedReason?: string;
}

export interface ReviewOutcome {
  grade?: ReviewFieldOutcome<number>;
  type?: ReviewFieldOutcome<string[]>;
  tags?: ReviewFieldOutcome<string[]>;
}

export interface RelationOutcome {
  written: number;
}

/**
 * Ticket 09 (edge-ownership-impl, "结算顺手维护 session 叙事"): the outcome of
 * a `session`-addressed call — `title`/`content` written whole (settlement's
 * usual "no append, no null-clear" reconstruction semantics, same as the
 * retired main-agent prose path used to give a turn). `titleWritten`/
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
  /** `null` for a `turn`-addressed outcome. */
  session: SessionNarrativeOutcome | null;
}

export type SettlementTurnWriteEvaluation =
  | { ok: true; outcome: SettlementTurnWriteOutcome }
  | { ok: false; message: string };

export interface EvaluateSettlementTurnWriteOptions {
  /**
   * `false` (the default, stage time): every READ still runs, but no
   * mutating statement does — the caller gets the same receipt a real write
   * would produce without anything reaching a live table (spec A7
   * requirement 1/2). `true` (commit time): the identical decision logic
   * runs again, fresh, and this time its mutations land for real.
   */
  apply: boolean;
}

/**
 * Mirrors `writeMemoryEdges`'s own pre-write checks (self-loop, conflicting-
 * relation-on-one-pair, eligibility) WITHOUT writing, so a stage-time dry run
 * can report the identical verdict a real write would produce. Small,
 * deliberate duplication: modifying the shared `writeMemoryEdges` primitive
 * to grow a dry-run mode would touch every other caller (note.ts,
 * segments.ts) for one caller's benefit. Both stage (`apply: false`) and
 * commit (`apply: true`, immediately followed by the real `writeMemoryEdges`
 * call with the same accepted list) run this same function first, so the two
 * can never disagree about WHICH inputs are legal — only about whether they
 * are actually written.
 *
 * Ticket 10d finding 1: eligibility is the FROZEN pre-run snapshot
 * INTERSECTED with the pair's CURRENT existence, not the frozen set alone.
 * The freeze (ticket 07/C7) exists to stop a run self-licensing a pair its
 * OWN writes just minted mid-run; it says nothing about the pair surviving
 * to commit time. Without the current-state half, a stale frozen key can
 * RESURRECT a pair the main agent deleted between the snapshot and commit:
 * T2 cites T1 when the snapshot is taken, settlement stages `dependsOn(T1)`,
 * the main agent then rewrites T2's body and `reconcileCitedPairs` deletes
 * T2->T1 — the frozen set still names the key, so without this check
 * `writeMemoryEdges` would re-INSERT a relation-only pair T2's body no
 * longer supports, which is exactly what C6 forbids. Dropping the CURRENT
 * check reintroduces that bug; dropping the FROZEN check reintroduces the
 * self-licensing bug ticket 07 closed. Both constraints, not either — hence
 * the intersection, not a replacement.
 *
 * `currentPairKeys` is read from `citing`'s own outgoing edges — one query
 * regardless of how many candidates this call carries, and correct at BOTH
 * stage time (still frozen==current, ordinarily) and commit time (fresh,
 * inside the same transaction the write lands in), because this function
 * runs unconditionally at both, same as every other read in this file.
 */
function evaluateRelationCandidates(
  db: Database,
  citing: CitingNode,
  candidates: ReadonlyArray<{ key: string; relation: TurnEdgeRelation; node: EdgeNode }>,
  eligiblePairKeys: ReadonlySet<string>,
): { accepted: WriteEdgeInput[]; rejections: string[] } {
  const currentPairKeys = new Set(
    getOutgoingEdges(db, citing).map((edge) => pairKey({ citing, cited: edge.cited })),
  );
  const relationsByPair = new Map<string, Set<TurnEdgeRelation>>();
  for (const candidate of candidates) {
    const key = pairKey({ citing, cited: candidate.node });
    const set = relationsByPair.get(key) ?? new Set<TurnEdgeRelation>();
    set.add(candidate.relation);
    relationsByPair.set(key, set);
  }
  const conflictingPairs = new Set(
    [...relationsByPair.entries()]
      .filter(([, relations]) => relations.size > 1)
      .map(([key]) => key),
  );

  const accepted: WriteEdgeInput[] = [];
  const rejections: string[] = [];
  for (const candidate of candidates) {
    if (citing.kind === candidate.node.kind && citing.id === candidate.node.id) {
      rejections.push(`${candidate.key} names this turn itself (self-loop)`);
      continue;
    }
    const key = pairKey({ citing, cited: candidate.node });
    if (conflictingPairs.has(key)) {
      rejections.push(
        `${candidate.key} names a pair another relation field in this same ` +
          "call already claims a different relation for",
      );
      continue;
    }
    if (!eligiblePairKeys.has(key)) {
      rejections.push(
        `${candidate.key} names a pair not eligible for a relation — settlement ` +
          "may only attach a relation to a pair that already existed before " +
          "this dispatch's model run began (spec C7)",
      );
      continue;
    }
    if (!currentPairKeys.has(key)) {
      rejections.push(
        `${candidate.key} names a pair that no longer exists — the citing ` +
          "side's body has stopped citing it since this run's eligibility " +
          "snapshot was taken (frozen ∩ current, spec C6/C7); a relation " +
          "cannot outlive the citation it rests on",
      );
      continue;
    }
    accepted.push({
      citing,
      cited: candidate.node,
      relation: candidate.relation,
      provenance: "judged",
    });
  }
  return { accepted, rejections };
}

const SESSION_ONLY_FORBIDDEN_FIELDS = [
  "insight",
  "grade",
  "type",
  "tags",
  "evidenceFor",
  "evidenceAgainst",
  "groundedOn",
  "refines",
  "override",
  "encodes",
  "dependsOn",
] as const;

/**
 * The session-narrative branch (ticket 09, edge-ownership-impl: "结算顺手维
 * 护 session 叙事"). Settlement is the session's SOLE writer now — `note`'s
 * own session address retired outright (`mcp/note.ts`). `title`/`content`
 * are whole-overwrite, no append, no null-clear — the same reconstruction
 * semantics the retired main-agent prose path used to give a turn, reused
 * here for the one address kind that still wants it: `title` set once (this
 * function does not special-case "already non-empty" — a repeat call simply
 * overwrites, so the PROMPT is what tells the model to leave it alone once
 * set — prompt-only enforcement USER-RATIFIED at [S15069/T1040] against a
 * hard first-set gate and an explicit-flag variant: T913's "极少改" allows
 * rare changes, and the prompt is the ruled keeper of that judgment),
 * `content` incremented by the model composing old-plus-new text
 * itself (it can already see the current session summary in its own
 * context) and submitting the whole result.
 */
function evaluateSettlementSessionWrite(
  db: Database,
  context: SettlementTurnFacadeContext,
  rawInput: SettlementTurnWriteInput,
  nowEpoch: number,
  options: EvaluateSettlementTurnWriteOptions,
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
    if (rawInput[key] !== undefined) {
      return { ok: false, message: `${key} is a turn field; this call addresses a session.` };
    }
  }

  if (rawInput.title === undefined && rawInput.content === undefined) {
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
  const sessionWriter = claimWriterId(context.jobId, context.claimGeneration);
  const sessionFields = (["title", "content"] as const).filter(
    (field) => rawInput[field] !== undefined,
  );
  for (const field of sessionFields) {
    const verdict = checkFieldGate(db, sessionWriter, "session", sessionId, field, ref);
    if (!verdict.ok) {
      return { ok: false, message: verdict.message };
    }
  }

  if (options.apply) {
    updateSessionFields(
      db,
      sessionId,
      {
        title: rawInput.title,
        content: rawInput.content,
      },
      nowEpoch,
    );
    for (const field of sessionFields) {
      stampField(db, "session", sessionId, field, sessionWriter, nowEpoch);
    }
  }

  const usage: string[] = [];
  if (rawInput.title !== undefined) {
    usage.push(formatSessionFieldUsage("title", rawInput.title));
  }
  if (rawInput.content !== undefined) {
    usage.push(formatSessionFieldUsage("content", rawInput.content));
  }

  return {
    ok: true,
    outcome: {
      ref,
      turnId: null,
      review: null,
      relations: null,
      session: {
        sessionId,
        titleWritten: rawInput.title !== undefined,
        contentWritten: rawInput.content !== undefined,
        usage,
      },
    },
  };
}

/**
 * The settlement turn-write facade's whole decision (spec A7's staged split).
 * Every read below runs unconditionally; every write is gated on
 * `options.apply`. Returns a structured `{ ok, ... }` rather than throwing —
 * the caller (staging engine) decides what a failure means at its own layer
 * (a parameter error at stage time, a thrown commit-replay refusal at commit
 * time), which is not this function's business.
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
  options: EvaluateSettlementTurnWriteOptions,
): SettlementTurnWriteEvaluation {
  if (rawInput.session !== undefined) {
    if (rawInput.turn !== undefined) {
      return { ok: false, message: "exactly one of turn or session is required, not both." };
    }
    return evaluateSettlementSessionWrite(db, context, rawInput, nowEpoch, options);
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

  // Ticket 05 (ownership-and-note-cadence spec, "settlement demolition"):
  // duty 2 — turn prose reconstruction — retires OUTRIGHT. title/content/
  // insight are refused LOUDLY here rather than silently ignored: the main
  // agent is the note's sole first-hand writer now, and a settlement call
  // still naming these fields is a caller running against a contract that no
  // longer exists, not a no-op.
  if (
    rawInput.title !== undefined ||
    rawInput.content !== undefined ||
    rawInput.insight !== undefined
  ) {
    return {
      ok: false,
      message:
        "title/content/insight are no longer settlement's to write — turn " +
        "prose reconstruction retired with duty 2; the main agent is the " +
        "note's sole writer. This call may only carry grade/type/tags " +
        "and/or a relation field.",
    };
  }

  const touchesReview =
    rawInput.grade !== undefined ||
    rawInput.type !== undefined ||
    rawInput.tags !== undefined;
  const relationFields = RELATION_FIELD_ENTRIES.filter(
    ([key]) =>
      (((rawInput as Record<string, unknown>)[key] as string[] | undefined)?.length ?? 0) > 0,
  );

  if (!touchesReview && relationFields.length === 0) {
    return {
      ok: false,
      message: "at least one of grade/type/tags, or a relation field is required.",
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

  let review: ReviewOutcome | null = null;
  if (touchesReview) {
    if (!context.reviewableTurnIds.has(turn.id)) {
      return {
        ok: false,
        message:
          `${ref} is outside this dispatch's reviewable window (the window ` +
          "plus its rendered lookback) — grade/type/tags may only be " +
          "written for a turn this prompt actually showed.",
      };
    }

    // Ticket 05 (read-write-contract spec "结算(直写改造)"): the write
    // gate's per-field three-judgment check, writer = this dispatch's claim
    // identity (`claimWriterId`, ticket 01's pinned encoding) — checked
    // independently for each of grade/type/tags this call actually
    // provided, replacing the old single `noteSupersedesReview` fence. The
    // context build recorded a read grant on THIS turn for this same claim
    // identity (worker/note-settlement-context.ts); a field the gate now
    // finds stale means an agent note (or another claim) stamped it after
    // that grant — this outcome's `yieldedReason` is exactly what teaches
    // that, in the gate's own words.
    const writer = claimWriterId(context.jobId, context.claimGeneration);
    const outcome: ReviewOutcome = {};
    const landedUpdate: {
      significanceGrade?: number;
      type?: string[];
      tags?: string[];
    } = {};

    if (rawInput.grade !== undefined) {
      const verdict = checkFieldGate(db, writer, "turn", turn.id, "grade", ref);
      outcome.grade = verdict.ok
        ? { value: rawInput.grade, landed: true }
        : { value: rawInput.grade, landed: false, yieldedReason: verdict.message };
      if (verdict.ok) {
        landedUpdate.significanceGrade = rawInput.grade;
      }
    }
    if (normalizedType !== undefined) {
      const verdict = checkFieldGate(db, writer, "turn", turn.id, "type", ref);
      outcome.type = verdict.ok
        ? { value: normalizedType, landed: true }
        : { value: normalizedType, landed: false, yieldedReason: verdict.message };
      if (verdict.ok) {
        landedUpdate.type = normalizedType;
      }
    }
    if (rawInput.tags !== undefined) {
      const verdict = checkFieldGate(db, writer, "turn", turn.id, "tags", ref);
      outcome.tags = verdict.ok
        ? { value: rawInput.tags, landed: true }
        : { value: rawInput.tags, landed: false, yieldedReason: verdict.message };
      if (verdict.ok) {
        landedUpdate.tags = rawInput.tags;
      }
    }

    if (
      options.apply &&
      (landedUpdate.significanceGrade !== undefined ||
        landedUpdate.type !== undefined ||
        landedUpdate.tags !== undefined)
    ) {
      updateTurnById(db, turn.id, { ...landedUpdate, updatedAtEpoch: nowEpoch });
      // Stamp gate (spec "检查-写入原子"): only the fields that actually
      // landed, same writer identity the check above used — a yielded
      // field must NOT be re-stamped, or a second correction attempt in
      // this same run would find its own prior (rejected) call admitted.
      if (landedUpdate.significanceGrade !== undefined) {
        stampField(db, "turn", turn.id, "grade", writer, nowEpoch);
      }
      if (landedUpdate.type !== undefined) {
        stampField(db, "turn", turn.id, "type", writer, nowEpoch);
      }
      if (landedUpdate.tags !== undefined) {
        stampField(db, "turn", turn.id, "tags", writer, nowEpoch);
      }
    }

    review = outcome;
  }

  let relations: RelationOutcome | null = null;
  if (relationFields.length > 0) {
    const citing: CitingNode = { kind: "turn", id: turn.id };
    // Ticket 08: the citing turn's phase set reflects THIS SAME call's own
    // type correction when present — mirrors `mcp/note.ts`'s
    // `resolveRelationFields`, which checks relation legality against
    // `updatedTurn.type` (the post-write type), not the pre-write one. A
    // turn corrected to `["design"]` in the same call that also attaches
    // `refines` must be judged as a decision-phase turn, not by whatever it
    // carried before this write.
    //
    // UNLESS the type field itself yielded (the write gate found it stale):
    // then the proposed type never reaches the database, and an edge judged
    // by it would be a validator-endorsed illegal edge (citing type in the
    // DB may carry no legal phase half at all). Post-write state IS the
    // persisted `turn.type` in that branch — the same rule, followed to
    // where the write actually landed. A review that never touched `type`
    // at all (`review?.type` undefined) is the ordinary case: the pre-write
    // `turn.type` this call did not ask to change.
    const typeCorrectionLands = review?.type === undefined || review.type.landed;
    const citingPhases = phasesForTypes(
      typeCorrectionLands ? (normalizedType ?? turn.type) : turn.type,
    );
    const candidates: Array<{ key: string; relation: TurnEdgeRelation; node: EdgeNode }> = [];
    const rejections: string[] = [];
    for (const [key, relation] of relationFields) {
      for (const raw of (rawInput as Record<string, unknown>)[key] as string[] | undefined ?? []) {
        const reference = parseBareAddressReference(raw);
        if (!reference) {
          rejections.push(`${key} "${raw}" is not a valid address`);
          continue;
        }
        const { accepted } = validateReferences(db, [reference], {
          writerSessionId: context.sessionId,
          logger: context.logger,
        });
        const node = accepted[0]?.node;
        if (!node) {
          rejections.push(`${key} "${raw}" does not resolve to a turn or segment`);
          continue;
        }
        // Ticket 08 (requirement 1 — one validator, both write paths): the
        // SAME `validateRelationTarget` the main agent's `note` tool calls
        // (`mcp/note.ts`'s `checkRelationTargetPhase`) — segment targets
        // refused, phase-pair legality checked, the rejection naming which
        // half is missing (`explainRelationPhaseRejection`, wrapped inside
        // `validateRelationTarget`'s own `detail`).
        const citedPhases =
          node.kind === "turn"
            ? phasesForTypes(getTurnById(db, node.id)?.type ?? [])
            : (new Set<TurnPhase>() as ReadonlySet<TurnPhase>);
        const legality = validateRelationTarget({
          relation,
          citingPhases,
          targetKind: node.kind,
          citedPhases,
        });
        if (!legality.ok) {
          rejections.push(`${key} "${raw}" ${legality.detail}`);
          continue;
        }
        candidates.push({ key, relation, node });
      }
    }
    if (rejections.length > 0) {
      return { ok: false, message: `relation field rejected: ${rejections.join("; ")}.` };
    }
    // Ticket 07/10a (spec C7/C14): eligibility is the PRE-RUN snapshot,
    // not this call's own citations — settlement has no body of its own
    // here to cite anything into, and even if it did, a pair this same
    // run just minted must not license its own relation.
    const evaluated = evaluateRelationCandidates(
      db,
      citing,
      candidates,
      context.eligibleRelationPairKeys,
    );
    if (evaluated.rejections.length > 0) {
      return {
        ok: false,
        message: `relation field rejected: ${evaluated.rejections.join("; ")}.`,
      };
    }
    if (options.apply) {
      const { written } = writeMemoryEdges(db, evaluated.accepted, nowEpoch, {
        eligibleForRelation: context.eligibleRelationPairKeys,
      });
      relations = { written: written.length };
    } else {
      relations = { written: evaluated.accepted.length };
    }
  }

  return { ok: true, outcome: { ref, turnId: turn.id, review, relations, session: null } };
}

/**
 * Render one turn-write outcome as tool-result text. `staged: true` is spec
 * A7 requirement 2's "the receipt says the write is staged, not written" —
 * used at stage time; `staged: false` is commit-time replay's internal
 * bookkeeping text (never shown on its own — `commit`'s own receipt
 * summarises the whole run).
 */
export function renderSettlementTurnWriteReceipt(
  outcome: SettlementTurnWriteOutcome,
  options: { staged: boolean; replaced?: boolean },
): string {
  const verb = options.staged ? "Staged" : "Landed";
  const parts: string[] = [];
  if (options.replaced) {
    parts.push(`(replaces the earlier staged call for ${outcome.ref})`);
  }
  if (outcome.review) {
    const landedBits: string[] = [];
    const yieldedBits: string[] = [];
    const describeArray = (value: string[]): string =>
      value.length > 0 ? value.join(",") : "(none)";
    if (outcome.review.grade) {
      if (outcome.review.grade.landed) {
        landedBits.push(`grade ${outcome.review.grade.value}`);
      } else {
        yieldedBits.push(`grade — ${outcome.review.grade.yieldedReason}`);
      }
    }
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
        `${verb} review for ${outcome.ref}: ${landedBits.join(", ")}${options.staged ? " (pending commit)" : ""}.`,
      );
    }
    if (yieldedBits.length > 0) {
      parts.push(`Yielded for ${outcome.ref}: ${yieldedBits.join("; ")}.`);
    }
  }
  if (outcome.relations) {
    parts.push(
      `${verb} ${outcome.relations.written} relation(s)${options.staged ? " (pending commit)" : ""}.`,
    );
  }
  if (outcome.session) {
    const fields = [
      outcome.session.titleWritten ? "title" : null,
      outcome.session.contentWritten ? "content" : null,
    ].filter((field): field is string => field !== null);
    parts.push(
      `${verb} session narrative for ${outcome.ref} (${fields.join(", ")})` +
        `${options.staged ? " (pending commit)" : ""}` +
        `${outcome.session.usage.length > 0 ? `: ${outcome.session.usage.join(", ")}` : ""}.`,
    );
  }
  if (parts.length === 0) {
    parts.push(`No-op for ${outcome.ref}.`);
  }
  return parts.join(" ");
}
