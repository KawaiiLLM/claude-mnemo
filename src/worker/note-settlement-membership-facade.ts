import { z } from "zod";
import type { Database } from "bun:sqlite";

import {
  checkCanonicalLaneTag,
  countLaneMemberTurnsInSegment,
  deleteLane,
  getLane,
  insertLane,
  mergeLaneTag,
  type LaneMergeReceipt,
} from "../db/lanes";
import { parseBareAddressReference } from "../db/references";
import { getSegment } from "../db/segments";
import { findTagNamespaceHolder, formatTagNamespaceRefusal } from "../db/tag-namespace";
import type { SettlementTurnFacadeContext } from "./note-settlement-turn-facade";

/**
 * The settlement LANE facade (lane-model-v12 spec D3d, ticket 15).
 *
 * Settlement does exactly two things now, and this file is the second of them:
 * the turn facade writes a turn's fields (edges included), and this one owns
 * the lane registry — `declare`, `undeclare`, `merge`. Nothing here touches a
 * segment.
 *
 * THREE VERBS RETIRED IN ONE TICKET, for one reason each:
 *
 *   - `propose` — a text-only "these homeless turns look like one task"
 *     suggestion for the user. Its only consumer was the main agent adopting
 *     the proposal into a new segment; membership is DERIVED from a turn's own
 *     tags now (D3e), so there is nothing left to adopt. The `proposals`
 *     SessionStart injection block retires in the same breath (spec D3f), for
 *     the same reason — an index of suggestions nobody can act on.
 *   - `reassign` — moved turns between segments. Retired as a VERB, not as a
 *     CAPABILITY, and the difference is the whole point (spec D3d's own
 *     wording correction): a turn belongs to the segment whose tag it carries,
 *     so writing `tags` through the turn facade IS changing membership. Both
 *     writers keep that; only the dedicated entry point goes away.
 *   - `create` — minted a segment and attached it to this session. A segment
 *     is a long-lived task container the user names; opening one is the main
 *     agent's act, in front of the person who decided it, never a hindsight
 *     pass's.
 *
 * All three are kept OUT of the enum entirely rather than refused downstream,
 * so a stale caller gets zod's own "invalid enum value" naming the three legal
 * verbs; `RETIRED_SETTLEMENT_MEMBERSHIP_VERB_REPLACEMENT` below adds the
 * replacement sentence on the hand-rolled path that bypasses the schema. That
 * pairing is this project's standing retirement shape — `assign` (ticket 05 of
 * ownership-and-note-cadence) and `mcp/remember.ts`'s `append`/`replace` both
 * do exactly this.
 *
 * Registered under the tool name `remember` (not `segment`) in
 * note-settlement-sdk-query.ts — the settlement subagent uses the same tool
 * quartet as the main agent (note, remember, timeline, recall), not a
 * dedicated facade set. The shape here is settlement's own restricted schema,
 * the same relationship this project's `note` facade already has to the main
 * agent's `note` tool (one tool NAME shared across both callers, a
 * caller-specific shape).
 *
 * The TRANSACTION IS THE CALLER'S — `note-settlement-direct-write.ts` wraps
 * every evaluation in one write transaction and throws on `ok: false`, so an
 * existence check and the write it guards are already serialized against a
 * concurrent declare without a second transaction opened here. `merge` leans
 * on that harder than the other two: it is three mutations that must commit or
 * vanish as a unit (see `mergeLaneTag`, db/lanes.ts).
 */

/**
 * Ticket 15: a caller still sending a retired verb gets its replacement named,
 * instead of only the generic enum list. The schema below rejects these values
 * before the evaluator ever sees them; this map is the belt-and-braces copy
 * for the hand-rolled path (the evaluator called directly, which is how most
 * of this facade's own tests reach it) — exactly the arrangement
 * `mcp/remember.ts`'s `RETIRED_REMEMBER_VERB_REPLACEMENT` has with
 * `definitions.ts`'s schema-layer superRefine.
 */
export const RETIRED_SETTLEMENT_MEMBERSHIP_VERB_REPLACEMENT: Record<string, string> = {
  propose:
    "segments attach automatically now — a turn belongs to the segment whose tag it carries, " +
    "so there is no proposal for anyone to adopt. Put the segment's tag in the turns' `note` tags instead.",
  reassign:
    "membership is derived from a turn's tags — write the destination segment's own tag into that " +
    "turn's `note` tags instead. The capability did not retire, only this verb did.",
  create:
    "settlement does not open segments; the main agent mints one with the user in front of it. " +
    "Leave the turns where their tags put them, or leave them unowned.",
};

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

export const settlementMembershipWriteInputShape = {
  /**
   * One line per verb, saying why it is here — and see the module comment for
   * the three that are NOT, and what each caller should reach for instead.
   *
   *   - `declare` / `undeclare` (lane-declaration D4, ticket 02) — mint and
   *     remove a LANE, `(segment, one tag)`. Lanes are settlement's outright
   *     ([S15069/T1547]): a lane must be declared BEFORE a turn's tags or an
   *     edge's side may name it, so a facade without these makes both the
   *     instruction and the write gate unfollowable.
   *   - `merge` (lane-model-v12 D3d, ticket 15) — fold one declared lane into
   *     another. Two lanes turning out to be one task is the ordinary
   *     hindsight finding this pass exists to make, and without it the repair
   *     is "retag every member by hand, then undeclare", which is the same
   *     work with a window in the middle where half the turns point at each.
   */
  action: z.enum(["declare", "undeclare", "merge"]),
  /**
   * ONE lane tag — canonical form, no ":" namespace prefix. `declare`/
   * `undeclare` name the lane they mint or remove; `merge` names the lane that
   * CEASES TO EXIST (`into` names the one that survives).
   */
  tag: z
    .string()
    .optional()
    .describe(
      'declare/undeclare/merge (required): ONE lane tag inside `id` — canonical form (NFC, trimmed, lowercase, no interior whitespace), no ":" namespace prefix. On `merge` this is the lane that GOES AWAY.',
    ),
  /**
   * `merge`'s second operand. A bare tag names a lane in the same segment
   * `id` does, which is the only merge that can succeed; the segment-qualified
   * form exists so that naming a lane in ANOTHER segment is a REFUSAL that
   * names the gap rather than a shape a caller cannot express. A lane's
   * identity is `(segment, tag)` and the same word in two segments is two
   * lanes — a caller who believes otherwise has to be told so, not silently
   * given the wrong one.
   */
  into: z
    .string()
    .min(1)
    .optional()
    .describe(
      'merge (required): the lane that SURVIVES — a bare tag in the same segment, or "E<n>/<tag>" to be explicit about which segment it lives in. A lane in a different segment is refused, naming both containers.',
    ),
  /** declare / undeclare / merge (required) — an "E<n>" segment address. */
  id: z.string().min(1).optional(),
};

export const settlementMembershipWriteInputSchema = z
  .object(settlementMembershipWriteInputShape)
  .strict();

export type SettlementMembershipWriteInput = z.infer<
  typeof settlementMembershipWriteInputSchema
>;

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface SettlementMembershipWriteOutcome {
  lane: {
    action: "declare" | "undeclare" | "merge";
    segmentId: number;
    /** `declare`/`undeclare`: the lane named. `merge`: the lane that ceased to exist. */
    tag: string;
    /** The lane row's id on a `declare`; `null` on an `undeclare`/`merge` (the row is gone). */
    laneId: number | null;
    /** `merge` only — what the fold actually moved. */
    merge?: LaneMergeReceipt;
  };
}

export type SettlementMembershipWriteEvaluation =
  | { ok: true; outcome: SettlementMembershipWriteOutcome }
  | { ok: false; message: string };

/**
 * The settlement lane facade's whole decision — dispatches on `action`. The
 * zod shape already refuses any value outside the three legal verbs before
 * this runs; the retirement check below is for the hand-rolled path that does
 * not go through it.
 */
export function evaluateSettlementMembershipWrite(
  db: Database,
  _context: SettlementTurnFacadeContext,
  rawInput: SettlementMembershipWriteInput,
  nowEpoch: number,
): SettlementMembershipWriteEvaluation {
  const retiredReplacement =
    RETIRED_SETTLEMENT_MEMBERSHIP_VERB_REPLACEMENT[rawInput.action as string];
  if (retiredReplacement) {
    return {
      ok: false,
      message: `action "${rawInput.action}" has retired — ${retiredReplacement}`,
    };
  }
  return evaluateLaneVerb(db, rawInput, rawInput.action, nowEpoch);
}

/** An `E<n>` address resolved to an OPEN segment, or the refusal that names why not. */
function resolveOpenSegment(
  db: Database,
  raw: string,
  action: string,
  label: string,
): { ok: true; segmentId: number; tags: string[] } | { ok: false; message: string } {
  const parsed = parseBareAddressReference(raw);
  if (!parsed || parsed.kind !== "segment") {
    return {
      ok: false,
      message: `${label} must be an "E<n>" segment address; got "${raw}".`,
    };
  }
  const segment = getSegment(db, parsed.segmentId);
  if (!segment) {
    return {
      ok: false,
      message: `E${parsed.segmentId} does not exist — ${action} names an existing segment.`,
    };
  }
  if (segment.status === "closed") {
    return {
      ok: false,
      message: `E${segment.id} is closed — a lane may only be ${action}d on an open segment.`,
    };
  }
  return { ok: true, segmentId: segment.id, tags: segment.tags };
}

/**
 * `merge`'s second operand: a bare tag, or `E<n>/<tag>`. Parsed here rather
 * than in `db/references.ts` because a lane is the only thing this grammar
 * addresses and only this one verb takes two of them — the parse is three
 * lines, and a new address KIND in the shared parser would then have to answer
 * for every reader that switches on kind.
 */
function parseLaneOperand(
  raw: string,
  defaultSegmentId: number,
): { segmentId: number; tag: string } | null {
  const slash = raw.indexOf("/");
  if (slash === -1) {
    return { segmentId: defaultSegmentId, tag: raw };
  }
  const parsed = parseBareAddressReference(raw.slice(0, slash));
  if (!parsed || parsed.kind !== "segment") {
    return null;
  }
  return { segmentId: parsed.segmentId, tag: raw.slice(slash + 1) };
}

/**
 * `declare`/`undeclare` (lane-declaration spec D1/D4, ticket 02) and `merge`
 * (lane-model-v12 D3d, ticket 15) — settlement's half of the lane registry,
 * refusing on exactly the same conditions the main agent's `remember` does
 * (`mcp/remember.ts`'s `handleDeclare`/`handleUndeclare`), through the same
 * `db/lanes.ts` primitives:
 *
 *   - a NON-CANONICAL tag is refused rather than normalized, so "write-gate" /
 *     "Write-Gate" / " write-gate " can never become three lanes;
 *   - `declare` refuses a duplicate, and refuses a tag already among the
 *     segment's CURATED tags — the two vocabularies are separated by an
 *     enforced invariant, not by intent;
 *   - `undeclare` refuses while any MEMBER TURN in the segment still carries
 *     the tag, naming the count, so an operator knows how much has to move
 *     first — and `merge` is the verb that moves it.
 */
function evaluateLaneVerb(
  db: Database,
  rawInput: SettlementMembershipWriteInput,
  action: "declare" | "undeclare" | "merge",
  nowEpoch: number,
): SettlementMembershipWriteEvaluation {
  if (rawInput.id === undefined) {
    return { ok: false, message: `${action} requires id, an "E<n>" segment address.` };
  }
  const resolved = resolveOpenSegment(db, rawInput.id, action, "id");
  if (!resolved.ok) {
    return resolved;
  }
  const { segmentId, tags: curatedTags } = resolved;
  if (typeof rawInput.tag !== "string" || rawInput.tag === "") {
    return { ok: false, message: `${action} requires tag, a single lane tag.` };
  }
  const canonical = checkCanonicalLaneTag(rawInput.tag);
  if (!canonical.ok) {
    return { ok: false, message: canonical.message };
  }
  const tag = rawInput.tag;

  if (action === "declare") {
    const existing = getLane(db, segmentId, tag);
    if (existing) {
      return {
        ok: false,
        message: `E${segmentId} already declares lane "${tag}" (lane #${existing.id}).`,
      };
    }
    if (curatedTags.includes(tag)) {
      return {
        ok: false,
        message:
          `"${tag}" is already one of E${segmentId}'s curated tags — a lane tag and a curated tag ` +
          "are two separate vocabularies; retag it off first if it should become a lane instead.",
      };
    }
    // ANOTHER segment's tag (lane-model-v12, peer A2): a pre-check for the
    // message only. `insertLane` is the authority and refuses by throwing —
    // this turns the throw into the refusal shape settlement can render.
    const namespaceHolder = findTagNamespaceHolder(db, "lane", tag);
    if (namespaceHolder) {
      return { ok: false, message: formatTagNamespaceRefusal("lane", namespaceHolder) };
    }
    const lane = insertLane(db, segmentId, tag, nowEpoch);
    // `insertLane` returns null only on a genuine race with an identical
    // concurrent declare, which the caller's write transaction serializes
    // against; re-reading the row keeps the receipt honest either way.
    const laneId = lane?.id ?? getLane(db, segmentId, tag)?.id ?? null;
    return {
      ok: true,
      outcome: { lane: { action, segmentId, tag, laneId } },
    };
  }

  if (action === "merge") {
    return evaluateMerge(db, rawInput, segmentId, tag, nowEpoch);
  }

  if (!getLane(db, segmentId, tag)) {
    return { ok: false, message: `E${segmentId} has no declared lane "${tag}".` };
  }
  // TICKET 10: the guard counts MEMBER TURNS — turns whose own tags carry the
  // lane — not edges. Membership comes from the node's tags now, so a
  // provisional lane with members and no edge at all would otherwise be
  // undeclared out from under them, leaving turns whose tags point at a lane
  // that does not exist. Clearing those tags is settlement's explicit act.
  const inUse = countLaneMemberTurnsInSegment(db, segmentId, tag);
  if (inUse > 0) {
    return {
      ok: false,
      message:
        `E${segmentId}'s lane "${tag}" still has ${inUse} member turn(s) carrying it — undeclare ` +
        "refuses while any turn in the segment carries the tag; clear those tags first, or " +
        `\`merge\` it into the lane those turns belong to.`,
    };
  }
  deleteLane(db, segmentId, tag);
  return {
    ok: true,
    outcome: { lane: { action, segmentId, tag, laneId: null } },
  };
}

/**
 * `merge` (ticket 15): fold lane `tag` into lane `into`, both inside one
 * segment. Three refusals, each naming its own gap, checked before any
 * mutation runs:
 *
 *   1. the two lanes live in DIFFERENT segments — identity is `(segment, tag)`,
 *      so this is not one lane wearing two names but two lanes wearing one
 *      word, and folding them would silently move turns between containers;
 *   2. either side is NOT DECLARED — merging into an undeclared word would
 *      leave every rewritten turn attributed to a lane that does not exist,
 *      which is the exact state `undeclare`'s own guard exists to prevent;
 *   3. the two are the SAME lane — a no-op that would nonetheless undeclare
 *      the lane it just merged into, i.e. destroy it.
 */
function evaluateMerge(
  db: Database,
  rawInput: SettlementMembershipWriteInput,
  segmentId: number,
  from: string,
  nowEpoch: number,
): SettlementMembershipWriteEvaluation {
  if (typeof rawInput.into !== "string" || rawInput.into.trim() === "") {
    return {
      ok: false,
      message: "merge requires into, the lane that survives the fold.",
    };
  }
  const operand = parseLaneOperand(rawInput.into, segmentId);
  if (!operand) {
    return {
      ok: false,
      message:
        `into must be a bare lane tag or an "E<n>/<tag>" lane address; got "${rawInput.into}".`,
    };
  }
  const intoCanonical = checkCanonicalLaneTag(operand.tag);
  if (!intoCanonical.ok) {
    return { ok: false, message: intoCanonical.message };
  }
  const into = operand.tag;

  if (operand.segmentId !== segmentId) {
    return {
      ok: false,
      message:
        `E${segmentId}'s "${from}" and E${operand.segmentId}'s "${into}" are two lanes in two ` +
        "segments — a lane's identity is (segment, tag), and merge folds one lane into another " +
        "inside ONE segment. Move the turns' segment tag first if they belong in the other container.",
    };
  }
  if (from === into) {
    return {
      ok: false,
      message:
        `merge needs two different lanes — "${from}" is both sides of this call, and folding a ` +
        "lane into itself would undeclare the very lane it merged into.",
    };
  }
  if (!getLane(db, segmentId, from)) {
    return {
      ok: false,
      message: `E${segmentId} has no declared lane "${from}" — merge folds a DECLARED lane away.`,
    };
  }
  if (!getLane(db, segmentId, into)) {
    return {
      ok: false,
      message:
        `E${segmentId} has no declared lane "${into}" — merge folds INTO a declared lane; ` +
        "declare it first, or name one that already exists.",
    };
  }

  const receipt = mergeLaneTag(db, segmentId, from, into, nowEpoch);
  return {
    ok: true,
    outcome: {
      lane: { action: "merge", segmentId, tag: from, laneId: null, merge: receipt },
    },
  };
}

/**
 * Render one lane-write outcome as tool-result text.
 *
 * Every write has already landed by the time this renders, so "Landed" is the
 * only honest verb — the `staged`/`replaced` options retired with the staging
 * engine that was their only source (ticket 11).
 */
export function renderSettlementMembershipWriteReceipt(
  outcome: SettlementMembershipWriteOutcome,
): string {
  const { action, segmentId, tag, laneId, merge } = outcome.lane;
  if (action === "declare") {
    return `Landed declare: lane "${tag}" on E${segmentId}${laneId !== null ? ` (lane #${laneId})` : ""}.`;
  }
  if (action === "undeclare") {
    return `Landed undeclare: lane "${tag}" removed from E${segmentId}.`;
  }
  const receipt = merge!;
  const deduped =
    receipt.turnsDeduplicated > 0
      ? ` (${receipt.turnsDeduplicated} already carried it)`
      : "";
  // The collision count is stated even at zero: a merge that folded two edges
  // into one has DESTROYED a stored row, and a receipt that mentions it only
  // sometimes teaches a reader to skim past the line where it matters.
  return (
    `Landed merge: E${segmentId}'s lane "${tag}" folded into "${receipt.into}" — ` +
    `${receipt.turnsRetagged} member turn(s) retagged${deduped}, ` +
    `${receipt.edgeSidesRewritten} edge side(s) rewritten, ` +
    `${receipt.collisions.length} duplicate edge(s) merged. "${tag}" is no longer declared.`
  );
}
