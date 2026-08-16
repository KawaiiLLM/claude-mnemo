import { z } from "zod";
import type { Database } from "bun:sqlite";

import { isCitationRelation, type CitationRelation } from "../db/citations";
import { runWriteTransaction } from "../db/database";
import {
  writeMemoryEdges,
  type CitingNode,
  type WriteEdgeInput,
} from "../db/memory-edges";
import { assertNoteSettlementJobClaimed } from "../db/note-settlement-completion";
import { parseBareAddressReference, validateReferences } from "../db/references";
import { getShadowNote, upsertReconstructedShadowNote } from "../db/shadow-notes";
import { getTurn, getTurnById, updateTurnById } from "../db/turns";
import { MEMORY_TYPES, normalizeTypeValues } from "../shared/type-vocabulary";
import { parseTurnAddress } from "../mcp/note";

/**
 * The settlement write server (ticket 10a, spec G6/G7/D5/D5a).
 *
 * This is "the restricted facade over the shared primitive" the ticket asks
 * for, not the main-agent schema (`mcp/note.ts`) reused raw. Handing
 * settlement that schema would silently grant it `skip`, session fields,
 * `crossSession`, append modes and the main agent's own relation authority —
 * none of which the retiring write-back ever had. What settlement is granted
 * here is deliberately no more than what
 * `worker/note-settlement-writeback.ts` already proved it needed:
 *
 *   - prose (title/content/insight) ONLY for a turn `context.reconstructableTurnIds`
 *     names — the write-back's own reconstruction loop's hole scope — and it
 *     yields to a note the agent landed after the window's context was read,
 *     the exact race `upsertReconstructedShadowNote`'s WHERE clause resolves;
 *   - grade/type/tags ONLY for a turn `context.reviewableTurnIds` names — the
 *     write-back's review-scope check against the window plus its rendered
 *     lookback — and the same "yield to a late agent note" rule for the
 *     note-derived half (type/tags; grade always lands, judged from raw
 *     material, not from the note);
 *   - a relation ONLY on a pair already present in `context.eligibleRelationPairKeys`
 *     — a snapshot the caller takes ONCE before the model run starts (spec
 *     C7/C14, ticket 07's "a reply cannot create its own eligibility" rule,
 *     generalised from a single transaction's pre-state to a whole run's,
 *     because a run is now many small transactions rather than one).
 *
 * Every field is whole-overwrite when present, omitted-leaves-alone
 * otherwise (spec D5a) — there is no `mode`, because there is no append: a
 * writer that could accumulate onto a field this project cannot audit inside
 * one live agentic run is exactly the G5 replay hazard segment `extend` and
 * session `append` already carry, and this facade does not need to invent a
 * third case of it.
 */

// ---------------------------------------------------------------------------
// Job identity (spec G6): per-request context, never a model-suppliable value
// ---------------------------------------------------------------------------

export interface SettlementTurnFacadeContext {
  jobId: number;
  claimGeneration: number;
  /** For reference resolution's drop-log prefix only; not an authority gate (ticket 07 retired the exposure ledger). */
  sessionId: number;
  /** The write-back's own reconstruction-loop hole scope. */
  reconstructableTurnIds: ReadonlySet<number>;
  /** The write-back's own review-scope check (window plus rendered lookback). */
  reviewableTurnIds: ReadonlySet<number>;
  /** When this dispatch's context was read — the note-timestamp fence's boundary. */
  contextBuiltAtEpoch: number;
  /** Recorded on a reconstruction note, same as the write-back's own `rideTurnId`. */
  rideTurnId: number | null;
  writerModel: string | null;
  /**
   * Pair keys (`memory-edges.ts`'s `pairKey`) eligible for a relation on THIS
   * dispatch's whole model run — taken ONCE, before the run starts, by the
   * caller (`worker/note-settlement-dispatch.ts`). Not recomputed per call:
   * recomputing it fresh at the top of each tool call's own transaction would
   * let an EARLIER call in the same run mint a pair and a LATER call in the
   * same run treat that freshly-minted pair as "pre-existing" and self-license
   * a relation on it — precisely the violation this snapshot exists to close.
   */
  eligibleRelationPairKeys: ReadonlySet<string>;
  logger?: Pick<Console, "warn">;
}

class SettlementFacadeError extends Error {}

function fail(message: string): never {
  throw new SettlementFacadeError(message);
}

type ToolTextResult = {
  content: Array<{ type: "text"; text: string }>;
};

function textResult(text: string): ToolTextResult {
  return { content: [{ type: "text", text }] };
}

function parameterError(message: string): ToolTextResult {
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
//      `jobId` is therefore never part of what `settlementTurnWriteTool`
//      receives as `rawInput`, whether the SDK strips it or rejects the
//      call outright.
//   2. Even if it were, `settlementTurnWriteTool` never reads a job identity
//      off `rawInput` — the only value it ever fences against is
//      `context.jobId`/`context.claimGeneration`, closed over from
//      `SettlementTurnFacadeContext`, which the per-request server factory
//      builds from the dispatch's own job record (worker/note-settlement-
//      dispatch.ts). There is no code path from model output into that
//      closure at all — the two live in variables with different names,
//      not the same field gated by a filter that could be forgotten.
export const settlementTurnWriteInputShape = {
  turn: z.string().min(1),
  title: z.string().optional(),
  content: z.string().optional(),
  insight: z.string().nullable().optional(),
  grade: z.number().int().min(0).max(4).optional(),
  type: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  evidenceFor: z.array(z.string()).optional(),
  evidenceAgainst: z.array(z.string()).optional(),
  supersedes: z.array(z.string()).optional(),
  dependsOn: z.array(z.string()).optional(),
};

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

interface ReviewOutcome {
  kind: "written" | "yielded";
  grade?: number;
  type?: string[];
  tags?: string[];
}

interface ProseOutcome {
  kind: "written" | "yielded";
}

interface RelationOutcome {
  written: number;
}

interface FacadeTransactionResult {
  ref: string;
  prose: ProseOutcome | null;
  review: ReviewOutcome | null;
  relations: RelationOutcome | null;
}

/**
 * The settlement write server's one tool call (ticket 10a). One
 * `runWriteTransaction` — the fence, the write it guards, its derived edges
 * and its status all share it (spec A2's per-call atomicity, unchanged by
 * A2's window-level surrender).
 */
export function settlementTurnWriteTool(
  db: Database,
  context: SettlementTurnFacadeContext,
  rawInput: SettlementTurnWriteInput,
  nowEpoch: number,
): ToolTextResult {
  const address = parseTurnAddress(rawInput.turn);
  if (!address) {
    return parameterError(
      `turn must be a fully qualified "S<session>/T<prompt>" address; got "${rawInput.turn}".`,
    );
  }
  const ref = `S${address.sessionId}/T${address.promptNumber}`;

  const touchesProse =
    rawInput.title !== undefined ||
    rawInput.content !== undefined ||
    rawInput.insight !== undefined;
  const touchesReview =
    rawInput.grade !== undefined ||
    rawInput.type !== undefined ||
    rawInput.tags !== undefined;
  const relationFields = RELATION_FIELD_ENTRIES.filter(
    ([key]) => (rawInput[key]?.length ?? 0) > 0,
  );

  if (!touchesProse && !touchesReview && relationFields.length === 0) {
    return parameterError(
      "at least one of title/content/insight, grade/type/tags, or a relation field is required.",
    );
  }

  // Requirement 7: a reconstruction is a WHOLE-REWRITE write — this dispatch
  // is filling a hole that has no prior note for the caller to leave alone —
  // so there is no "omitted means leave alone" reading available the way
  // `mcp/note.ts`'s own per-field update has for an EXISTING row. The
  // retiring write-back defaulted an absent `insight` to `""` (survivable
  // only because a reconstruction always targets an empty hole, so there was
  // nothing to accidentally clear); this replacement refuses the call
  // instead of guessing what "absent" means for a field with nothing behind
  // it. `insight` must still be NAMED, even as `null`, to state "no insight".
  if (touchesProse) {
    if (
      rawInput.title === undefined ||
      rawInput.content === undefined ||
      rawInput.insight === undefined
    ) {
      return parameterError(
        "a reconstruction note requires title, content and insight all named " +
          "together in one call (insight may be null) — an omitted field is " +
          "refused, never defaulted to empty.",
      );
    }
    if (rawInput.title.trim() === "") {
      return parameterError("title must not be empty.");
    }
    if (rawInput.content.trim() === "") {
      return parameterError("content must not be empty.");
    }
  }

  let normalizedType: string[] | undefined;
  if (rawInput.type !== undefined) {
    try {
      normalizedType = normalizeTypeValues(rawInput.type);
    } catch (error) {
      return parameterError(
        `${error instanceof Error ? error.message : String(error)}. Allowed: ${MEMORY_TYPES.join(", ")}.`,
      );
    }
  }

  let result: FacadeTransactionResult;
  try {
    result = runWriteTransaction(db, (): FacadeTransactionResult => {
      // The fence: the FIRST statement of this transaction (spec G6/G7). A
      // dispatch whose lease was reclaimed under a new generation throws
      // here, rolling back everything below — nothing this call would have
      // written can ever land once ownership has moved.
      assertNoteSettlementJobClaimed(db, context.jobId, context.claimGeneration);

      const turn = getTurn(db, address.sessionId, address.promptNumber);
      if (!turn) {
        fail(`no turn at ${ref}.`);
      }
      if (turn.type.includes("compact")) {
        fail(`${ref} is a compact marker, not a turn.`);
      }

      let prose: ProseOutcome | null = null;
      if (touchesProse) {
        if (!context.reconstructableTurnIds.has(turn.id)) {
          fail(
            `${ref} is not a reconstructable hole of this dispatch — prose may ` +
              "only be written for a turn this window's own backfill scope names.",
          );
        }
        const written = upsertReconstructedShadowNote(db, {
          turnId: turn.id,
          title: rawInput.title!,
          content: rawInput.content!,
          insight: rawInput.insight ?? null,
          writerModel: context.writerModel,
          writerOrigin: "settlement",
          rideTurnId: context.rideTurnId,
          nowEpoch,
        });
        // `upsertReconstructedShadowNote`'s own `WHERE writer_origin != 'agent'`
        // is the yield: the main agent's own note can land between this job
        // being claimed and this call landing, and that note wins — a
        // hindsight reconstruction of the same turn never outranks it.
        prose = { kind: written ? "written" : "yielded" };
      }

      let review: ReviewOutcome | null = null;
      if (touchesReview) {
        if (!context.reviewableTurnIds.has(turn.id)) {
          fail(
            `${ref} is outside this dispatch's reviewable window (the window ` +
              "plus its rendered lookback) — grade/type/tags may only be " +
              "written for a turn this prompt actually showed.",
          );
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
          if (rawInput.grade !== undefined) {
            updateTurnById(db, turn.id, {
              significanceGrade: rawInput.grade,
              updatedAtEpoch: nowEpoch,
            });
          }
          review = { kind: "yielded", grade: rawInput.grade };
        } else {
          updateTurnById(db, turn.id, {
            significanceGrade: rawInput.grade,
            type: normalizedType,
            tags: rawInput.tags,
            updatedAtEpoch: nowEpoch,
          });
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
        const inputs: WriteEdgeInput[] = [];
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
            inputs.push({ citing, cited: node, relation, provenance: "judged" });
          }
        }
        if (rejections.length > 0) {
          fail(`relation field rejected: ${rejections.join("; ")}.`);
        }
        // Ticket 07/10a (spec C7/C14): eligibility is the PRE-RUN snapshot,
        // not this call's own citations — settlement has no body of its own
        // here to cite anything into, and even if it did, a pair this same
        // run just minted must not license its own relation.
        const { written, rejected } = writeMemoryEdges(db, inputs, nowEpoch, {
          eligibleForRelation: context.eligibleRelationPairKeys,
        });
        if (rejected.length > 0) {
          fail(
            "relation field rejected: a target pair is not eligible — settlement " +
              "may only attach a relation to a pair that already existed before " +
              "this dispatch's model run began (spec C7).",
          );
        }
        relations = { written: written.length };
      }

      return { ref, prose, review, relations };
    });
  } catch (error) {
    if (error instanceof SettlementFacadeError) {
      return parameterError(error.message);
    }
    // A lost lease (NoteSettlementJobFenceError) is not a parameter mistake —
    // it means every remaining call in this dispatch would also fail the
    // fence, so surfacing it as a firm text answer (rather than throwing
    // through the tool boundary) lets the agent stop rather than retry
    // pointlessly against a window it no longer owns.
    if (error instanceof Error && error.name === "NoteSettlementJobFenceError") {
      return textResult(
        `${ref}: this dispatch's job lease was reclaimed; no further writes ` +
          "will land. Stop making tool calls.",
      );
    }
    throw error;
  }

  const parts: string[] = [];
  if (result.prose) {
    parts.push(
      result.prose.kind === "written"
        ? `Reconstructed ${ref}.`
        : `${ref} reconstruction yielded: an agent note landed first.`,
    );
  }
  if (result.review) {
    if (result.review.kind === "yielded") {
      parts.push(
        result.review.grade !== undefined
          ? `${ref} review yielded (an agent note landed after this dispatch's ` +
              "context was read) — grade recorded, type/tags left as the agent's own."
          : `${ref} review yielded (an agent note landed after this dispatch's ` +
              "context was read) — nothing written.",
      );
    } else {
      const bits: string[] = [];
      if (result.review.grade !== undefined) bits.push(`grade ${result.review.grade}`);
      if (result.review.type !== undefined)
        bits.push(`type ${result.review.type.length > 0 ? result.review.type.join(",") : "(none)"}`);
      if (result.review.tags !== undefined)
        bits.push(`tags ${result.review.tags.length > 0 ? result.review.tags.join(",") : "(none)"}`);
      parts.push(`Reviewed ${ref}: ${bits.join(", ")}.`);
    }
  }
  if (result.relations) {
    parts.push(`Attached ${result.relations.written} relation(s).`);
  }
  if (parts.length === 0) {
    parts.push(`No-op for ${ref}.`);
  }
  return textResult(parts.join(" "));
}
