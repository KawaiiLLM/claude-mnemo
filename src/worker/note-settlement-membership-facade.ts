import { z } from "zod";
import type { Database } from "bun:sqlite";

import {
  checkCanonicalLaneTag,
  countLaneMemberTurnsInSegment,
  deleteLane,
  getLane,
  insertLane,
  mergeLaneTag,
  turnIdsCarryingTagInSegment,
  type LaneMergeReceipt,
} from "../db/lanes";
import { normalizeIncidentAttribution } from "../db/normalize-incident-attribution";
import { parseBareAddressReference } from "../db/references";
import { getSegment } from "../db/segments";
import { findTagNamespaceHolder, formatTagNamespaceRefusal } from "../db/tag-namespace";
import { LANE_CREATE_WRITER } from "../db/write-gate";

/**
 * The settlement LANE facade (lane-model-v12 spec D3d, ticket 15).
 *
 * Settlement does exactly two things now, and this file is the second of them:
 * the turn facade writes a turn's fields (edges included), and this one owns
 * the lane registry — `create` (lane tier), `delete`, `merge`. Nothing here
 * touches a segment.
 *
 * SIX VERBS RETIRED, for one reason each:
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
 *   - `justify` (settlement-gate-taxonomy ticket 06, user ruling
 *     S15069/T2278) — the ONE retirement here where the capability went with
 *     the verb. It recorded a disposition for a severed lane's fracture, and
 *     its only consumer was the commit gate that refused without one; ticket
 *     04 made that fracture a warning, so the write had nothing left to
 *     answer. Keeping it would have meant maintaining fingerprints, a
 *     lane-read obligation, a full-content grant on a remote representative
 *     and a content-sequence freshness check for a row nobody reads. Its
 *     ledger table is INERT, not dropped (`db/lane-disposition.ts`).
 *
 * All six are kept OUT of the enum entirely rather than refused downstream,
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
  // Settlement-gate-taxonomy ticket 06 (user ruling S15069/T2278). Unlike the
  // five above, NO capability moved anywhere: there is no replacement call,
  // because there is nothing left to answer. A severed lane is a warning that
  // blocks nothing, so the sentence has to say the OBLIGATION is gone rather
  // than point at another verb — a caller told only "retired" will look for
  // the new spelling and spend the round trip anyway.
  justify:
    "a severed lane no longer owes anything. It is a WARNING on `lane_check` and on your commit " +
    "receipt, naming the two pieces as a stitch target; it does not block commit and there is no " +
    "disposition to file. Write a stitch only where a truthful relation is already supported by " +
    "the material you are reading, and otherwise leave the fracture standing and commit.",
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
 * `justify` WAS A FOURTH ACTION HERE, AND IT RETIRED (settlement-gate-taxonomy
 * ticket 06, user ruling S15069/T2278). It wrote a structured disposition for
 * one fracture of a severed lane, and its whole purpose was to discharge a
 * commit gate. Ticket 04 made a fracture a WARNING, so there is nothing left
 * to discharge — and a persistent semantic judgment nobody consults, bought
 * with a whole-lane read obligation, is the accidental complexity the project
 * forbids. See `RETIRED_SETTLEMENT_MEMBERSHIP_VERB_REPLACEMENT` for what a
 * stale caller is told. The lane registry is what this vocabulary is now.
 */
export const SETTLEMENT_LANE_ACTIONS = ["create", "delete", "merge"] as const;

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
  /** create / delete / merge (required) — an "E<n>" segment address. */
  id: z.string().min(1).optional(),
};

export const settlementMembershipWriteInputSchema = z
  .object(settlementMembershipWriteInputShape)
  .strict();

/**
 * THE SETTLEMENT `remember` TOOL'S OWN ACTION SET (lane-impressions ticket 10,
 * user ruling S15069/T2346: 「印象修改应该用 remember 工具，commit 只做检查和提交
 * 报告」).
 *
 * `remember` already owns the container verbs, and an impression IS container
 * state — so the impression write is an ACTION here rather than an array
 * argument smuggled through the terminal gate. It is deliberately NOT a member
 * of `SETTLEMENT_LANE_ACTIONS`: that tuple is the LANE REGISTRY's vocabulary,
 * dispatched by `evaluateSettlementMembershipWrite` into lane rows, and an
 * impression touches no registry row at all. The two vocabularies meet on one
 * tool and nowhere else.
 *
 * THE ACTION IS SETTLEMENT-ONLY, and mechanically so: it exists on this facade
 * — which only a leased settlement dispatch registers — and its handler asserts
 * that run's lease before it records anything. The PUBLIC `remember` tool
 * (`mcp/remember.ts`) refuses the word by name, so a main agent that reaches
 * for it is told why rather than given a generic vocabulary error.
 */
export const SETTLEMENT_IMPRESSION_ACTION = "impression" as const;

export const SETTLEMENT_REMEMBER_ACTIONS = [
  ...SETTLEMENT_LANE_ACTIONS,
  SETTLEMENT_IMPRESSION_ACTION,
] as const;

export type SettlementRememberAction = (typeof SETTLEMENT_REMEMBER_ACTIONS)[number];

/**
 * The tool's input shape: the lane registry's, widened by the impression
 * action's own three fields. `id` is shared and means the same thing it always
 * did — an address — only one tier deeper for a lane impression
 * (`"E<n>/#<tag>"`), exactly as the main agent's own `create` already routes on
 * its address's tier.
 */
export const settlementRememberInputShape = {
  ...settlementMembershipWriteInputShape,
  action: z.enum(SETTLEMENT_REMEMBER_ACTIONS),
  decision: z
    .enum(["retain", "replace"])
    .optional()
    .describe(
      'impression (required): "retain" keeps the stored bytes exactly; "replace" carries the WHOLE new impression in `text`.',
    ),
  baseRevision: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "impression (required): the revision your advisory printed for this container — the CAS fence that stops a decision landing over a version you never read.",
    ),
  text: z
    .string()
    .optional()
    .describe(
      "impression + replace (required): the WHOLE new impression, never a patch. Validated in full by this call and refused by this call.",
    ),
};

export type SettlementRememberInput = z.infer<
  ReturnType<typeof z.object<typeof settlementRememberInputShape>>
>;

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
    /** `create`/`delete`: the lane named. `merge`: the lane that ceased to exist. */
    tag: string;
    /** The lane row's id on a `create`; `null` on a `delete`/`merge` (no lane row changes). */
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
    if (lane !== null) {
      // THE SEAM, in the SAME transaction (main-agent-edges ticket 13, P1-6):
      // see `mcp/remember.ts`'s own `create` for the full reasoning — this is
      // settlement's other caller of `insertLane`, and the finding named both.
      // `onAmbiguous` stays pinned to `"keep"`: user ruling S15069/T2465 made
      // an ambiguous side a warning only, with no repair authority, so this
      // never deletes an edge or invalidates a job over a side it merely made
      // ambiguous.
      normalizeIncidentAttribution(db, turnIdsCarryingTagInSegment(db, tag, segmentId), {
        writer: LANE_CREATE_WRITER,
        nowEpoch,
        onAmbiguous: () => "keep",
      });
    }
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
