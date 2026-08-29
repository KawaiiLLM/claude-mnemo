import { z } from "zod";
import type { Database } from "bun:sqlite";

import { loadLaneCheckScope } from "../db/lane-checker-load";
import {
  computeComponentFingerprint,
  computeLaneFractures,
  hasAnyLaneReadReceipt,
  recordLaneDispositionJustification,
  unreadLaneMembers,
} from "../db/lane-disposition";
import {
  checkCanonicalLaneTag,
  countLaneMemberTurnsInSegment,
  deleteLane,
  getLane,
  insertLane,
  mergeLaneTag,
  type LaneMergeReceipt,
} from "../db/lanes";
import { resolveEraCutoff } from "../db/era";
import { parseBareAddressReference } from "../db/references";
import { getSegment } from "../db/segments";
import { findTagNamespaceHolder, formatTagNamespaceRefusal } from "../db/tag-namespace";
import { getTurn, getTurnById } from "../db/turns";
import { checkCompleteReadFreshness, checkTurnLiveForWrite, claimWriterId } from "../db/write-gate";
import { parseTurnAddress } from "../mcp/note";
import { chronologicalSegmentMembers } from "../mcp/segment-card";
import { checkLanes } from "../shared/lane-checker";
import type { SettlementTurnFacadeContext } from "./note-settlement-turn-facade";

/**
 * The settlement LANE facade (lane-model-v12 spec D3d, ticket 15).
 *
 * Settlement does exactly two things now, and this file is the second of them:
 * the turn facade writes a turn's fields (edges included), and this one owns
 * the lane registry — `create` (lane tier), `delete`, `merge`. Nothing here
 * touches a segment.
 *
 * FIVE VERBS RETIRED, for one reason each:
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
 *   - `create` (SEGMENT sense) — minted a segment and attached it to this
 *     session. A segment is a long-lived task container the user names;
 *     opening one is the main agent's act, in front of the person who decided
 *     it, never a hindsight pass's. This retirement PREDATES container-
 *     unification ticket 05 and is unrelated to that ticket's own `create` —
 *     see the word's own describe below for how the two do not collide: this
 *     facade has no title/goal parameter at all, so `create` here can never
 *     mean anything but "mint a lane".
 *   - `declare` (container-unification ticket 05, spec D3) — `declare`'s own
 *     capability did not retire, only the dedicated verb did: the main
 *     `remember` tool folded it into `create`'s id-tier routing
 *     (`mcp/remember.ts`'s `handleCreateLane`), and this facade's own action
 *     vocabulary moves with it so the two entry points teach one word, not
 *     two — see `RETIRED_SETTLEMENT_MEMBERSHIP_VERB_REPLACEMENT` below.
 *   - `undeclare` (container-unification ticket 06, spec D4) — the same
 *     retirement shape one tier over: the capability (remove a lane, refusing
 *     while any member turn still carries the tag) did not retire, only the
 *     dedicated verb did, folded into `delete`'s own id-tier routing
 *     (`mcp/remember.ts`'s `handleDeleteLane`).
 *
 * All five are kept OUT of the enum entirely rather than refused downstream,
 * so a stale caller gets zod's own "invalid enum value" naming the three legal
 * verbs; `RETIRED_SETTLEMENT_MEMBERSHIP_VERB_REPLACEMENT` below adds the
 * replacement sentence on the hand-rolled path that bypasses the schema. That
 * pairing is this project's standing retirement shape — `assign` (ticket 05 of
 * ownership-and-note-cadence) and `mcp/remember.ts`'s `append`/`replace`/
 * `declare`/`undeclare` all do exactly this.
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
 * concurrent create without a second transaction opened here. `merge` leans
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
    "tasks attach automatically now — a turn belongs to the task whose tag it carries, " +
    "so there is no proposal for anyone to adopt. Put the task's tag in the turns' `note` tags instead.",
  reassign:
    "membership is derived from a turn's tags — write the destination task's own tag into that " +
    "turn's `note` tags instead. The capability did not retire, only this verb did.",
  // Container-unification ticket 05 (spec D3): the SEGMENT-minting sense of
  // `create` never existed on this facade (no title/goal parameter, ever —
  // see the module comment), so retiring `declare` and having `create` take
  // its place collides with nothing. Same id+tag shape, same refusals — only
  // the word changed.
  declare:
    'use "create" instead — same id+tag shape, same refusals; this facade only ever mints a LANE, ' +
    "never a task (that stays the main agent's alone, in front of the user).",
  // Container-unification ticket 06 (spec D4): same shape of retirement, one
  // tier over — `delete` keeps `undeclare`'s exact guard (refuses while any
  // member turn still carries the tag) and its exact id+tag shape.
  undeclare:
    'use "delete" instead — same id+tag shape, same guard: refuses while any member turn still ' +
    "carries the tag.",
};

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

/**
 * Settlement's own lane vocabulary — deliberately NOT `REMEMBER_VERBS`, which
 * is the main agent's ten-verb surface; this facade is lane-only and headless.
 * It is a tuple rather than three literals because it had THREE of them (the
 * zod enum, the outcome type, the evaluator's parameter) plus a tool
 * description and a prompt call list, all free to drift from one another —
 * peer review [S15069/T1772] named that after the same class of drift had
 * already shipped once, `remember(declare)` outliving the verb it named.
 * Everything derives from here now, and the description and prompt are pinned
 * against it in `tests/shared/tag-mandate-teaching-surfaces.test.ts`.
 */
/**
 * `justify` (severed-lane ticket 02, spec "The refined form"): the
 * mandatory-disposition rule's own write — a structured justification for
 * ONE remaining fracture of a SEVERED lane, bound to a component
 * fingerprint. Added alongside the three lane-registry verbs because it is,
 * like them, a fact about a LANE rather than about one turn's own fields;
 * unlike them it never mints, removes or folds a lane — it records a
 * disposition on the topology as this run leaves it.
 */
export const SETTLEMENT_LANE_ACTIONS = ["create", "delete", "merge", "justify"] as const;

export type SettlementLaneAction = (typeof SETTLEMENT_LANE_ACTIONS)[number];

export const settlementMembershipWriteInputShape = {
  /**
   * One line per verb, saying why it is here — and see the module comment for
   * the ones that are NOT, and what each caller should reach for instead.
   *
   *   - `create` (container-unification ticket 05, spec D3) / `delete`
   *     (container-unification ticket 06, spec D4 — the retired `undeclare`'s
   *     own replacement) — mint and remove a LANE, `(segment, one tag)`.
   *     Lanes are settlement's outright ([S15069/T1547]): a lane must be
   *     declared BEFORE a turn's tags or an edge's side may name it, so a
   *     facade without these makes both the instruction and the write gate
   *     unfollowable. `create` here is LANE-ONLY — this facade has no
   *     title/goal parameter, so there is no task-tier reading to route to.
   *   - `merge` (lane-model-v12 D3d, ticket 15) — fold one declared lane into
   *     another. Two lanes turning out to be one task is the ordinary
   *     hindsight finding this pass exists to make, and without it the repair
   *     is "retag every member by hand, then delete", which is the same
   *     work with a window in the middle where half the turns point at each.
   */
  action: z.enum(SETTLEMENT_LANE_ACTIONS),
  /**
   * ONE lane tag — canonical form, no ":" namespace prefix. `create`/
   * `delete` name the lane they mint or remove; `merge` names the lane that
   * CEASES TO EXIST (`into` names the one that survives).
   */
  tag: z
    .string()
    .optional()
    .describe(
      'create/delete/merge (required): ONE lane tag inside `id` — canonical form (lowercase letters, digits and "-" only, never leading or trailing), no ":" namespace prefix. On `merge` this is the lane that GOES AWAY.',
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
      'merge (required): the lane that SURVIVES — a bare tag in the same task, or "E<n>/<tag>" to be explicit about which task it lives in. A lane in a different task is refused, naming both containers.',
    ),
  /** create / delete / merge / justify (required) — an "E<n>" segment address. */
  id: z.string().min(1).optional(),
  /**
   * `justify` (required): THIS side's fracture representative — an
   * "S<n>/T<m>" address that must match one of the lane's CURRENT island
   * representatives (`lane_check`'s SEVERED report names them). Paired with
   * `otherRepresentative`, the two together identify exactly one remaining
   * fracture.
   */
  representative: z
    .string()
    .optional()
    .describe(
      'justify (required): THIS side\'s fracture representative — an "S<n>/T<m>" address matching ' +
        "one of the lane's current island representatives (see lane_check's SEVERED report).",
    ),
  /**
   * `justify` (required): the OTHER side's representative. A full-content
   * read grant on THIS turn is required before the call is accepted — the
   * recall-before-justify obligation (ticket 02) binds to the side you are
   * not already standing on.
   */
  otherRepresentative: z
    .string()
    .optional()
    .describe(
      "justify (required): the OTHER side's representative — an \"S<n>/T<m>\" address. A " +
        "full-content recall of THIS turn is required before the call is accepted.",
    ),
  /**
   * `justify` (required, max 1000 chars): why none of the seven relation
   * words applies between the two representatives. The machine checks
   * PRESENCE and BINDING (both addresses, the fingerprint, the read
   * receipts) — never truth; a duplicate-reason rate is tracked separately
   * and only surfaced when anomalous.
   */
  reason: z
    .string()
    .min(1)
    .max(1000)
    .optional()
    .describe(
      "justify (required, max 1000 chars): why none of the seven relation words applies between " +
        "the two representatives — name both and the gap. Never a restatement of the counts.",
    ),
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
    action: SettlementLaneAction;
    segmentId: number;
    /** `create`/`delete`: the lane named. `merge`: the lane that ceased to exist. `justify`: the severed lane. */
    tag: string;
    /** The lane row's id on a `create`; `null` on a `delete`/`merge`/`justify` (no lane row changes). */
    laneId: number | null;
    /** `merge` only — what the fold actually moved. */
    merge?: LaneMergeReceipt;
    /** `justify` only — the fracture this call recorded a disposition for. */
    justify?: {
      componentFingerprint: string;
      representativeA: number;
      representativeB: number;
    };
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
 *
 * Container-unification ticket 05 (spec D3): the ACCEPTED word is `create`;
 * everything downstream of this function — `evaluateLaneVerb`, the outcome
 * shape, the receipt renderer, and every OTHER caller of this module
 * (`note-settlement-direct-write.ts`'s own bucket-counting, in particular) —
 * still speaks the internal literal `"declare"`, unchanged. Remapping here,
 * at the one seam the retired word crosses, is what lets the retirement stay
 * scoped to the WRITE ENTRY POINT (the same boundary the main `remember` tool
 * retires it at) without renaming a type that this facade's own callers
 * outside this file depend on.
 */
export function evaluateSettlementMembershipWrite(
  db: Database,
  context: SettlementTurnFacadeContext,
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
  if (rawInput.action === "justify") {
    return evaluateJustify(db, context, rawInput, nowEpoch);
  }
  // [S15069/T1738]: no remap. The outcome literal IS the caller's word, so a
  // receipt can never name a verb the caller did not send — the earlier
  // internal-remap kept `"declare"` alive in the receipt text long after the
  // input surface retired it.
  const internalAction: "create" | "delete" | "merge" = rawInput.action;
  return evaluateLaneVerb(db, rawInput, internalAction, nowEpoch);
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
      message: `${label} must be an "E<n>" task address; got "${raw}".`,
    };
  }
  const segment = getSegment(db, parsed.segmentId);
  if (!segment) {
    return {
      ok: false,
      message: `E${parsed.segmentId} does not exist — ${action} names an existing task.`,
    };
  }
  if (segment.status === "closed") {
    return {
      ok: false,
      message: `E${segment.id} is closed — a lane may only be ${action}d on an open task.`,
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
 * `create` (lane tier)/`delete` (lane-declaration spec D1/D4, ticket 02;
 * verb renamed `declare`->`create` by container-unification ticket 05 and
 * `undeclare`->`delete` by ticket 06) and `merge` (lane-model-v12 D3d,
 * ticket 15) — settlement's half of the lane registry, refusing on exactly
 * the same conditions the main agent's `remember` does (`mcp/remember.ts`'s
 * `handleCreateLane`/`handleDeleteLane`), through the same `db/lanes.ts`
 * primitives:
 *
 *   - a NON-CANONICAL tag is refused rather than normalized, so "write-gate" /
 *     "Write-Gate" / " write-gate " can never become three lanes;
 *   - `create` refuses a duplicate, and refuses a tag already among the
 *     segment's CURATED tags — the two vocabularies are separated by an
 *     enforced invariant, not by intent;
 *   - `delete` refuses while any MEMBER TURN in the segment still carries
 *     the tag, naming the count, so an operator knows how much has to move
 *     first — and `merge` is the verb that moves it.
 *
 * `action` is the caller's own word ([S15069/T1738]) — there is no longer an
 * internal remap, so the dispatch below, the OUTCOME's `action` field and every
 * user-facing message all name the same verb. The remap existed to spare a
 * downstream type-narrowing one rename, and its cost was a receipt that said
 * "declare" to a caller who had sent "create".
 */
function evaluateLaneVerb(
  db: Database,
  rawInput: SettlementMembershipWriteInput,
  action: SettlementLaneAction,
  nowEpoch: number,
): SettlementMembershipWriteEvaluation {
  // Messages name `rawInput.action`, which is now the same value as `action` —
  // kept explicit so a future remap cannot silently reintroduce the drift.
  if (rawInput.id === undefined) {
    return { ok: false, message: `${rawInput.action} requires id, an "E<n>" task address.` };
  }
  const resolved = resolveOpenSegment(db, rawInput.id, rawInput.action, "id");
  if (!resolved.ok) {
    return resolved;
  }
  const { segmentId, tags: curatedTags } = resolved;
  if (typeof rawInput.tag !== "string" || rawInput.tag === "") {
    return { ok: false, message: `${rawInput.action} requires tag, a single lane tag.` };
  }
  const canonical = checkCanonicalLaneTag(rawInput.tag);
  if (!canonical.ok) {
    return { ok: false, message: canonical.message };
  }
  const tag = rawInput.tag;

  if (action === "create") {
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
        `E${segmentId}'s lane "${tag}" still has ${inUse} member turn(s) carrying it — delete ` +
        "refuses while any turn in the task carries the tag; clear those tags first, or " +
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
 *      which is the exact state `delete`'s own guard exists to prevent;
 *   3. the two are the SAME lane — a no-op that would nonetheless delete
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
        "tasks — a lane's identity is (task, tag), and merge folds one lane into another " +
        "inside ONE task. Move the turns' task tag first if they belong in the other container.",
    };
  }
  if (from === into) {
    return {
      ok: false,
      message:
        `merge needs two different lanes — "${from}" is both sides of this call, and folding a ` +
        "lane into itself would delete the very lane it merged into.",
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
 * `justify` (severed-lane ticket 02): a structured disposition for ONE
 * remaining fracture of a SEVERED lane. Machine checks PRESENCE and BINDING,
 * never truth (ticket 02's own honesty boundary) — in order:
 *
 *   1. both representative addresses resolve to live turns;
 *   2. the lane is currently SEVERED (2+ islands) and the two given
 *      representatives name exactly one of its CURRENT consecutive-pair
 *      fractures (`computeLaneFractures`) — a pair that does not match any
 *      current fracture is refused naming the ones that DO, so a stale
 *      justify (the topology already moved) cannot be filed against a gap
 *      that no longer exists;
 *   3. the `reason` NAMES both current representatives, in the `S<n>/T<m>`
 *      form the refusals print (ticket 05 decision 3 — the anti-grinding
 *      clause ticket 02 wrote and the first implementation checked only for
 *      non-emptiness);
 *   4. this run has RECALLED the lane at all, and has had every MEMBER of
 *      the OTHER representative's component rendered to it
 *      (`hasAnyLaneReadReceipt`/`unreadLaneMembers`) — the
 *      recall-before-justify obligation;
 *   5. this run holds a FULL-CONTENT read grant on `otherRepresentative` —
 *      the side the caller is not already standing on.
 *
 * On success the row is bound to `computeComponentFingerprint`, which is
 * exactly what makes a later topology change invalidate it: the checker
 * recomputes islands fresh on every commit, so a stitch or a further split
 * changes the representative pair and this fingerprint simply stops matching
 * any current fracture.
 *
 * THE FINGERPRINT'S STRENGTH IS NOT A DEFECT, and a future reader arriving at
 * the same doubt should stop here (ticket 05 decision 4): a membership change
 * that leaves BOTH representatives standing leaves the same fracture — the
 * representative pair IS the fracture's identity, and islands are recomputed
 * fresh on every commit, so there is nothing for a stronger fingerprint to
 * catch that this one lets through. Cross-run stale receipts are likewise
 * already bounded: a receipt is keyed to
 * `claimWriterId(jobId, claimGeneration)`, so staleness cannot outlive one
 * claim, and counting member ids rather than pages narrows what remains
 * inside it.
 */
/** `S<n>/T<m>` for a turn id — the address form every refusal in this machinery prints, and the form a `reason` is checked against. */
function turnAddressFor(db: Database, turnId: number): string {
  const turn = getTurnById(db, turnId);
  return turn ? `S${turn.sessionId}/T${turn.promptNumber}` : `turn#${turnId}`;
}

/**
 * Does `reason` name this address — as an address, not as a prefix of a
 * longer one. `S1/T1` occurs inside `S1/T12`, so a bare `includes` would
 * accept a reason that names a different turn entirely; the character after
 * the match must not be a digit.
 */
function reasonNamesAddress(reason: string, address: string): boolean {
  for (let from = 0; ; from += 1) {
    const at = reason.indexOf(address, from);
    if (at < 0) {
      return false;
    }
    const next = reason[at + address.length];
    if (next === undefined || next < "0" || next > "9") {
      return true;
    }
    from = at;
  }
}

/**
 * Appended to both read-obligation refusals (ticket 07 decision 3). A lane
 * page the worker envelope would cut writes NO receipt at all, so a run that
 * DID recall the lane and still reads as "has not recalled it" is looking at
 * an oversize page, and the remedy is a smaller one — a fact neither refusal
 * could otherwise state, since by then there is nothing on record to read.
 */
const OVERSIZE_PAGE_HINT =
  "A lane page too large for the tool-result cap is delivered CUT and records no receipt at " +
  "all, so page it smaller (pageSize=) if you did recall the lane.";

/**
 * Split an island's membership into what this reader can be asked to have
 * read, and what it is structurally forbidden to see.
 *
 * USER RULING [S15069/T1964] (ticket 07 decision 1): the read obligation is
 * over the ERA-VISIBLE members of the other island. `db/lane-checker-load.ts`
 * applies no era filter, so the checker's islands can hold pre-cutoff members;
 * `recall`'s lane route is era-scoped and settlement's own recall handler
 * forces the cutoff; and the era GRANT that would make such a member visible
 * lands at COMMIT, which this gate precedes. A lane whose other island held an
 * ungranted pre-cutoff member therefore owed a justify no sequence of calls
 * could satisfy. The alternatives — moving era semantics into settlement's
 * read reach, or retiring the receipt obligation outright — were put to the
 * user and rejected.
 *
 * Visibility is not recomputed here: it is `chronologicalSegmentMembers`, the
 * SAME call `recall`'s lane route and its receipt writer make, with the SAME
 * cutoff (`resolveEraCutoff`, which is also what the settlement recall handler
 * resolves), so "visible" has exactly one definition on both sides of the
 * obligation. That call carries the grant column too (`rankSegmentMembers` ->
 * `eraVisibleMemberSqlClause`), including its rule that a database with NO
 * recorded cutoff filters nothing.
 *
 * An island member is a live turn in this segment's `segment_members` carrying
 * the lane tag (`loadSegmentTurnIdsCarryingTag`); the lane render's membership
 * is that same set with the era clause applied. The difference between the two
 * is therefore the era clause and nothing else, which is what lets the refusal
 * name the excluded members as out-of-era rather than merely as missing.
 */
function splitObligationByEraVisibility(
  db: Database,
  segmentId: number,
  memberIds: readonly number[],
): { visible: number[]; outOfEra: number[] } {
  if (memberIds.length === 0) {
    return { visible: [], outOfEra: [] };
  }
  const segment = getSegment(db, segmentId);
  if (!segment) {
    return { visible: [...memberIds], outOfEra: [] };
  }
  const renderable = new Set(
    chronologicalSegmentMembers(db, segment, resolveEraCutoff(db)).map(
      (member) => member.turnId,
    ),
  );
  const visible: number[] = [];
  const outOfEra: number[] = [];
  for (const turnId of memberIds) {
    (renderable.has(turnId) ? visible : outOfEra).push(turnId);
  }
  return { visible, outOfEra };
}

function evaluateJustify(
  db: Database,
  context: SettlementTurnFacadeContext,
  rawInput: SettlementMembershipWriteInput,
  nowEpoch: number,
): SettlementMembershipWriteEvaluation {
  if (rawInput.id === undefined) {
    return { ok: false, message: "justify requires id, an \"E<n>\" task address." };
  }
  const resolved = resolveOpenSegment(db, rawInput.id, "justify", "id");
  if (!resolved.ok) {
    return resolved;
  }
  const { segmentId } = resolved;
  if (typeof rawInput.tag !== "string" || rawInput.tag === "") {
    return { ok: false, message: "justify requires tag, a single lane tag." };
  }
  const tag = rawInput.tag;
  if (!getLane(db, segmentId, tag)) {
    return { ok: false, message: `E${segmentId} has no declared lane "${tag}".` };
  }
  if (typeof rawInput.representative !== "string" || rawInput.representative === "") {
    return { ok: false, message: "justify requires representative, an \"S<n>/T<m>\" address." };
  }
  if (typeof rawInput.otherRepresentative !== "string" || rawInput.otherRepresentative === "") {
    return { ok: false, message: "justify requires otherRepresentative, an \"S<n>/T<m>\" address." };
  }
  const reason = rawInput.reason?.trim();
  if (!reason) {
    return { ok: false, message: "justify requires reason: why none of the seven relation words applies." };
  }

  const repAddress = parseTurnAddress(rawInput.representative);
  if (!repAddress) {
    return { ok: false, message: `representative must be an "S<n>/T<m>" address; got "${rawInput.representative}".` };
  }
  const otherAddress = parseTurnAddress(rawInput.otherRepresentative);
  if (!otherAddress) {
    return {
      ok: false,
      message: `otherRepresentative must be an "S<n>/T<m>" address; got "${rawInput.otherRepresentative}".`,
    };
  }
  const repTurn = getTurn(db, repAddress.sessionId, repAddress.promptNumber);
  if (!repTurn) {
    return { ok: false, message: `no turn at ${rawInput.representative}.` };
  }
  const otherTurn = getTurn(db, otherAddress.sessionId, otherAddress.promptNumber);
  if (!otherTurn) {
    return { ok: false, message: `no turn at ${rawInput.otherRepresentative}.` };
  }
  // P2-3's own discipline, restated here: this facade's earlier absence of
  // any turn address meant it structurally could never write against a turn
  // rolled back or skipped between render and this transaction — `justify`
  // reopens that surface (it needs both representatives' addresses), so it
  // owes the SAME in-transaction liveness re-check every turn-addressed
  // write in this codebase carries.
  const repLiveness = checkTurnLiveForWrite(db, repTurn.id, rawInput.representative);
  if (!repLiveness.ok) {
    return { ok: false, message: repLiveness.message };
  }
  const otherLiveness = checkTurnLiveForWrite(db, otherTurn.id, rawInput.otherRepresentative);
  if (!otherLiveness.ok) {
    return { ok: false, message: otherLiveness.message };
  }

  // The lane's CURRENT islands — a fresh, `lanes`-scoped `checkLanes` pass
  // (the same core `lane_check`/the commit gate run), never a cached report:
  // a justify is judged against the topology as it stands THIS instant.
  const projection = loadLaneCheckScope(db, {
    kind: "lanes",
    laneKeys: [{ segment: String(segmentId), tag }],
  });
  const result = checkLanes(projection.turns, projection.edges, projection.outOfVocabularyEdges, projection.segmentFacts);
  const component = result.components.find(
    (entry) => entry.key.segment === String(segmentId) && entry.key.tag === tag,
  );
  if (!component || component.componentCount <= 1) {
    return {
      ok: false,
      message: `E${segmentId}'s lane "${tag}" is not currently severed — no disposition is owed.`,
    };
  }
  const fractures = computeLaneFractures(segmentId, component);
  const wanted = new Set([repTurn.id, otherTurn.id]);
  const fracture = fractures.find(
    (candidate) =>
      wanted.has(candidate.representativeA) &&
      wanted.has(candidate.representativeB) &&
      candidate.representativeA !== candidate.representativeB,
  );
  if (!fracture) {
    const named = fractures
      .map((candidate) => `${candidate.representativeA}<->${candidate.representativeB}`)
      .join(", ");
    return {
      ok: false,
      message:
        `${rawInput.representative} / ${rawInput.otherRepresentative} do not name a CURRENT fracture of ` +
        `E${segmentId}'s lane "${tag}" — its remaining fracture(s), by representative turn id: ${named || "(none)"}.`,
    };
  }

  // TICKET 05 decision 3 (the anti-grinding clause, which the first
  // implementation checked only for non-emptiness): the reason has to NAME
  // both current representatives, in the address form the refusal itself
  // prints. Checked here, before the read obligations below, for the same
  // reason `commit` validates its own report before taking the lease fence:
  // this is a purely local text check the caller can act on without reading
  // anything more, so when both are wrong it is the more actionable refusal.
  // The other half of that clause — "why none of the seven words holds" —
  // stays unmachine-checked; that is the ticket's own honesty boundary.
  const repAddressText = turnAddressFor(db, repTurn.id);
  const otherAddressText = turnAddressFor(db, otherTurn.id);
  const unnamed = [repAddressText, otherAddressText].filter(
    (address) => !reasonNamesAddress(reason, address),
  );
  if (unnamed.length > 0) {
    return {
      ok: false,
      message:
        `justify refused: the reason must name both representatives of the fracture it disposes of, ` +
        `and does not name ${unnamed.join(" or ")}. Say what stands between ${repAddressText} and ` +
        `${otherAddressText}, naming both — a reason that names neither side cannot be read back as ` +
        "being about this gap rather than any other.",
    };
  }

  const readerId = claimWriterId(context.jobId, context.claimGeneration);
  if (!hasAnyLaneReadReceipt(db, readerId, segmentId, tag)) {
    return {
      ok: false,
      message:
        `justify refused: this run has not recalled E${segmentId}/#${tag} at all — recall the lane ` +
        `(id="E${segmentId}/#${tag}") before justifying a fracture in it. ${OVERSIZE_PAGE_HINT}`,
    };
  }
  // TICKET 05 decision 2: the obligation is the OTHER component's membership
  // — ticket 02's teaching is "read the side you are not standing on", and
  // `otherRepresentative` is that side (it is also the side the full-content
  // grant below is required on). The island is found by its representative,
  // which the fracture match above has already established `otherTurn.id` is.
  //
  // Counted over MEMBER IDS, never page numbers: `unreadLaneMembers` returns
  // exactly what is still unread, so the refusal names it instead of telling
  // the caller to "page through the lane" and leaving it to guess how far.
  const otherIsland = component.islands.find(
    (island) => island.representative === otherTurn.id,
  );
  const obligation = splitObligationByEraVisibility(
    db,
    segmentId,
    otherIsland?.memberIds ?? [],
  );
  const unread = unreadLaneMembers(db, readerId, segmentId, tag, obligation.visible);
  const excludedClause =
    obligation.outOfEra.length > 0
      ? ` ${obligation.outOfEra.length} further member(s) of that component ` +
        "are excluded from this obligation as OUT-OF-ERA — recall cannot render them at all " +
        `(${obligation.outOfEra.map((turnId) => turnAddressFor(db, turnId)).join(", ")}).`
      : "";
  if (unread.length > 0) {
    return {
      ok: false,
      message:
        `justify refused: this run has not read all ${obligation.visible.length} era-visible member(s) of ` +
        `the component ${otherAddressText} represents — still unread: ` +
        `${unread.map((turnId) => turnAddressFor(db, turnId)).join(", ")}. Recall the lane ` +
        `(id="E${segmentId}/#${tag}") until every one of them has been rendered to this run. ` +
        `${OVERSIZE_PAGE_HINT}${excludedClause}`,
    };
  }
  // USER RULING [S15069/T1964], ticket 07 decision 1: the full-content grant
  // is waived on exactly the same ground the membership obligation is. It is
  // required ON the other representative, and a representative the era filter
  // hides is one no `recall` can ever deliver whole — demanding it would
  // reinstate the deadlock this ticket exists to remove, one member narrower.
  if (obligation.visible.includes(otherTurn.id)) {
    const grantFailure = checkCompleteReadFreshness(db, readerId, "turn", otherTurn.id, "content");
    if (grantFailure?.kind === "incomplete") {
      return {
        ok: false,
        message:
          `justify refused: no full-content read grant on ${rawInput.otherRepresentative} — recall it whole ` +
          "before justifying against it.",
      };
    }
    // TICKET 07 P1-3: `complete` alone was the whole test, so a grant taken
    // before ANOTHER writer changed that representative's content inside this
    // same claim still authorized a justification that outlives the run.
    // Judged by `db/write-gate.ts`'s own sequence semantics, not a second
    // notion of freshness invented here.
    if (grantFailure?.kind === "stale") {
      return {
        ok: false,
        message:
          `justify refused: this run's full-content read of ${rawInput.otherRepresentative} predates ` +
          `${grantFailure.staleWriter}'s write to its "content" — re-read it whole before justifying ` +
          "against it.",
      };
    }
  }

  recordLaneDispositionJustification(db, {
    jobId: context.jobId,
    segmentId,
    laneTag: tag,
    componentFingerprint: fracture.fingerprint,
    representativeA: fracture.representativeA,
    representativeB: fracture.representativeB,
    reason,
    createdAtEpoch: nowEpoch,
  });

  return {
    ok: true,
    outcome: {
      lane: {
        action: "justify",
        segmentId,
        tag,
        laneId: null,
        justify: {
          componentFingerprint: fracture.fingerprint,
          representativeA: fracture.representativeA,
          representativeB: fracture.representativeB,
        },
      },
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
  if (action === "create") {
    return `Landed create: lane "${tag}" on E${segmentId}${laneId !== null ? ` (lane #${laneId})` : ""}.`;
  }
  if (action === "delete") {
    return `Landed delete: lane "${tag}" removed from E${segmentId}.`;
  }
  if (action === "justify") {
    const justify = outcome.lane.justify!;
    return (
      `Landed justify: E${segmentId}'s lane "${tag}" — fracture ` +
      `${justify.representativeA}<->${justify.representativeB} disposed (fingerprint ` +
      `${justify.componentFingerprint}). Invalidated automatically if the topology changes.`
    );
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
