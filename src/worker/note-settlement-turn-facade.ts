import { z } from "zod";
import type { Database } from "bun:sqlite";

import { isCitationRelation, type CitationRelation } from "../db/citations";
import {
  getOutgoingEdges,
  pairKey,
  writeMemoryEdges,
  type CitingNode,
  type EdgeNode,
  type WriteEdgeInput,
} from "../db/memory-edges";
import { parseBareAddressReference, validateReferences } from "../db/references";
import { getShadowNote } from "../db/shadow-notes";
import { getTurn, updateTurnById } from "../db/turns";
import { findRetiredTopicTag, retiredTopicTagMessage } from "../shared/tag-stripping";
import { MEMORY_TYPES, normalizeTypeValues } from "../shared/type-vocabulary";
import { settlementNoteInputShape } from "../mcp/definitions";
import { parseTurnAddress } from "../mcp/note";

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
 * STAGED COMMIT (spec A7): `evaluateSettlementTurnWrite` below is a plain
 * decision function — every READ it needs (turn lookup, shadow-note
 * freshness, reference resolution) always runs live against the database,
 * because a staged call must "still validate fully and return a real
 * receipt"; only the WRITES (`updateTurnById`, `writeMemoryEdges`) are
 * conditional on `apply: true`. The staging engine
 * (`note-settlement-staging.ts`) calls this function twice for the same
 * intent: once at stage time with `apply: false` (a dry run, for the
 * immediate receipt), and once inside `commit`'s own transaction with
 * `apply: true` (the write that actually lands, re-evaluated fresh against
 * whatever the database says at that later moment — "stage-time validation
 * is feedback, commit-time validation is truth"). There is deliberately no
 * third, separate "apply-only" code path: replaying the SAME evaluation
 * function rather than a cached stage-time decision is what makes
 * commit-time re-validation real rather than cosmetic.
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

export interface ReviewOutcome {
  kind: "written" | "yielded";
  grade?: number;
  type?: string[];
  tags?: string[];
}

export interface RelationOutcome {
  written: number;
}

export interface SettlementTurnWriteOutcome {
  ref: string;
  turnId: number;
  review: ReviewOutcome | null;
  relations: RelationOutcome | null;
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
  candidates: ReadonlyArray<{ key: string; relation: CitationRelation; node: EdgeNode }>,
  eligiblePairKeys: ReadonlySet<string>,
): { accepted: WriteEdgeInput[]; rejections: string[] } {
  const currentPairKeys = new Set(
    getOutgoingEdges(db, citing).map((edge) => pairKey({ citing, cited: edge.cited })),
  );
  const relationsByPair = new Map<string, Set<CitationRelation>>();
  for (const candidate of candidates) {
    const key = pairKey({ citing, cited: candidate.node });
    const set = relationsByPair.get(key) ?? new Set<CitationRelation>();
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

/**
 * The settlement turn-write facade's whole decision (spec A7's staged split).
 * Every read below runs unconditionally; every write is gated on
 * `options.apply`. Returns a structured `{ ok, ... }` rather than throwing —
 * the caller (staging engine) decides what a failure means at its own layer
 * (a parameter error at stage time, a thrown commit-replay refusal at commit
 * time), which is not this function's business.
 */
export function evaluateSettlementTurnWrite(
  db: Database,
  context: SettlementTurnFacadeContext,
  rawInput: SettlementTurnWriteInput,
  nowEpoch: number,
  options: EvaluateSettlementTurnWriteOptions,
): SettlementTurnWriteEvaluation {
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
    ([key]) => (rawInput[key]?.length ?? 0) > 0,
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
    // Re-read fresh, right here, right before the write it guards (the
    // write-back's own two-half fence, ported verbatim):
    //   1. freshness — a value merged into a write must come from a read
    //      taken now, never from context-build time;
    //   2. yield-when-the-document-changed — `type`/`tags` are facts
    //      ABOUT the note, so a review of a turn whose note arrived
    //      during the async gap between claim and this call is a review
    //      of a document the model never saw. Grade still lands: it
    //      judges what the turn DID, read off raw material no later note
    //      can change; only the note-derived half stands down.
    const currentNote = getShadowNote(db, turn.id);
    const noteSupersedesReview =
      currentNote !== null &&
      currentNote.writerOrigin === "agent" &&
      currentNote.updatedAtEpoch >= context.contextBuiltAtEpoch;

    if (noteSupersedesReview) {
      if (options.apply && rawInput.grade !== undefined) {
        updateTurnById(db, turn.id, {
          significanceGrade: rawInput.grade,
          updatedAtEpoch: nowEpoch,
        });
      }
      review = { kind: "yielded", grade: rawInput.grade };
    } else {
      if (options.apply) {
        updateTurnById(db, turn.id, {
          significanceGrade: rawInput.grade,
          type: normalizedType,
          tags: rawInput.tags,
          updatedAtEpoch: nowEpoch,
        });
      }
      review = {
        kind: "written",
        grade: rawInput.grade,
        type: normalizedType,
        tags: rawInput.tags,
      };
    }
  }

  let relations: RelationOutcome | null = null;
  if (relationFields.length > 0) {
    const citing: CitingNode = { kind: "turn", id: turn.id };
    const candidates: Array<{ key: string; relation: CitationRelation; node: EdgeNode }> = [];
    const rejections: string[] = [];
    for (const [key, relation] of relationFields) {
      for (const raw of rawInput[key] ?? []) {
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

  return { ok: true, outcome: { ref, turnId: turn.id, review, relations } };
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
    if (outcome.review.kind === "yielded") {
      parts.push(
        outcome.review.grade !== undefined
          ? `${outcome.ref} review ${options.staged ? "would yield" : "yielded"} (an agent note landed after this dispatch's ` +
              "context was read) — grade recorded, type/tags left as the agent's own."
          : `${outcome.ref} review ${options.staged ? "would yield" : "yielded"} (an agent note landed after this dispatch's ` +
              "context was read) — nothing to write.",
      );
    } else {
      const bits: string[] = [];
      if (outcome.review.grade !== undefined) bits.push(`grade ${outcome.review.grade}`);
      if (outcome.review.type !== undefined)
        bits.push(`type ${outcome.review.type.length > 0 ? outcome.review.type.join(",") : "(none)"}`);
      if (outcome.review.tags !== undefined)
        bits.push(`tags ${outcome.review.tags.length > 0 ? outcome.review.tags.join(",") : "(none)"}`);
      parts.push(`${verb} review for ${outcome.ref}: ${bits.join(", ")}${options.staged ? " (pending commit)" : ""}.`);
    }
  }
  if (outcome.relations) {
    parts.push(
      `${verb} ${outcome.relations.written} relation(s)${options.staged ? " (pending commit)" : ""}.`,
    );
  }
  if (parts.length === 0) {
    parts.push(`No-op for ${outcome.ref}.`);
  }
  return parts.join(" ");
}
