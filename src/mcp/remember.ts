import type { Database } from "bun:sqlite";

import { runWriteTransaction } from "../db/database";
import {
  parseBareAddressReference,
  validateReferences,
  type ParsedReference,
} from "../db/references";
import {
  appendSegmentWorkingStateRows,
  attachSegmentToSession,
  clearSegmentMembers,
  countLiveSegments,
  createSegment,
  deleteSegmentRow,
  detachSegmentFromSession,
  findRetagLaneCollisions,
  getAttachedSegmentIds,
  getSegment,
  getSegmentMemberTurnIds,
  listLiveSegmentsByActivity,
  mergeSegments,
  reassignSegmentMembers,
  SEGMENT_CONTAINER_ERA_CUTOFF_EPOCH,
  replaceInSegmentWorkingStateField,
  segmentEditableFieldValue,
  segmentTagOf,
  setSegmentTag,
  toggleSegmentStatus,
  writeSegmentWorkingStateField,
  type ReplaceSegmentWorkingStateFieldResult,
  type SegmentMergeOutcome,
  type SegmentRecord,
} from "../db/segments";
import {
  checkCanonicalLaneTag,
  clearLane,
  countLaneMemberTurnsInSegment,
  countTurnsCarryingTag,
  deleteLane,
  getLane,
  insertLane,
  listLanesForSegment,
  mergeLaneTag,
  renameLane,
  type LaneClearOutcome,
  type LaneMergeReceipt,
  type LaneRecord,
  type RenameLaneOutcome,
} from "../db/lanes";
import {
  findTagNamespaceHolder,
  formatTagNamespaceRefusal,
  type TagNamespaceHolder,
} from "../db/tag-namespace";
import { countTurnsSince, touchSessionRememberActivity } from "../db/sessions";
import {
  checkFieldGate,
  sessionWriterId,
  stampField,
  type FieldGateOptions,
} from "../db/write-gate";
import { renderSegmentLaneVocabulary } from "./lane-vocabulary";
import { decodeHtmlEntities } from "./note";
import { renderSegmentCard } from "./segment-card";
import {
  SEGMENT_EDITABLE_FIELDS,
  type SegmentEditableField,
} from "../shared/segment-fields";
import {
  containsToolCallSyntax,
  toolCallSyntaxMessage,
} from "../shared/tool-call-syntax";
import { stripPrivateTags } from "../shared/tag-stripping";

type ToolTextResult = {
  content: Array<{
    type: "text";
    text: string;
  }>;
};

export type RememberVerb =
  | "create"
  | "attach"
  | "detach"
  | "write"
  | "edit"
  | "close"
  | "retag"
  | "delete"
  | "clear"
  | "merge";
export const REMEMBER_VERBS: readonly RememberVerb[] = [
  "create",
  "attach",
  "detach",
  "write",
  "edit",
  "close",
  "retag",
  "delete",
  "clear",
  "merge",
];

// Ticket 05 (write-mode-edit-semantics, spec D1/D14): `append`/`replace`
// retired — a caller still sending either gets this message naming the
// replacement, instead of the generic "verb must be one of ..." the plain
// `REMEMBER_VERBS` membership check below would otherwise give (same
// precedent `note.ts`'s own `RETIRED_FIELD_MODE_REPLACEMENT` follows for
// `mode.<field>`'s retired literals).
//
// settlement-ergonomics ticket 01 (spec D1) removed all three retired verbs
// from `definitions.ts`'s `rememberInputShape.verb` enum outright, so a call
// that goes through the real MCP validation path now fails there with zod's
// generic enum error — `definitions.ts`'s own schema-layer superRefine no
// longer duplicates this message (that branch was deleted as dead code, since
// it could never run once the enum stopped accepting the value). This map is
// now the ONLY place a retired verb gets named, reached only by a caller that
// bypasses the schema — the hand-rolled path most of this file's own tests
// call directly.
const RETIRED_REMEMBER_VERB_REPLACEMENT: Record<string, string> = {
  append:
    "use `write` (replace the field whole) or `edit` (anchor the last row and add to it) instead.",
  replace: "use `edit` instead — same oldString/newString shape.",
  // Ticket 14 (lane-model-v12 spec D3e): membership is DERIVED from a turn's
  // own tags, so there is no assignment to make. The CAPABILITY is not gone —
  // it moved into the `tags` field of `note`, which is where the segment's tag
  // now goes.
  assign:
    "membership is derived from a turn's tags — put the segment's own tag in that turn's `note` tags instead.",
  // Container-unification ticket 05 (spec D3): `create` now routes on the
  // TIER of its `id` — omitted mints a task, an "E<n>/#<tag>" lane address
  // mints a lane inside that task. The capability did not retire, only the
  // dedicated verb did: `declare`'s own id+tag pair collapses into one
  // address, the same shape `retag`/`undeclare`/`merge` already take.
  declare:
    'use `create` instead — `create(id="E<n>/#<tag>")` mints the lane; the precondition is unchanged: ' +
    "nothing on the roster fits, you ask, they agree, only then create.",
  // Container-unification ticket 06 (spec D4): `undeclare` retires into
  // `delete`'s own lane-tier address routing — same guard (refuses while any
  // member turn still carries the tag), only the address collapses from an
  // id+tag pair into the one lane address `create`'s lane tier already mints.
  undeclare:
    'use `delete` instead — `delete(id="E<n>/#<tag>")` removes the lane; it refuses while any member ' +
    "turn still carries the tag, the same guard undeclare had.",
};

// Ticket 09 (spec "write-mode-edit-semantics"): the verbs that write a
// segment FIELD — `create` (it seeds title and, when given, the goal row)
// and the field-writing verbs proper (`write`/`edit`, ticket 05's rename of
// `append`/`replace`). `attach`/`detach`/`close` move a segment between roster
// states or sessions without touching any of its fields, so they are deliberately
// excluded — see `touchSessionRememberActivity`'s call site below. Ticket 07
// (rubric-v10) adds `retag` — it writes the segment's own tag, the same
// "touches a field" reasoning as `write`/`edit`.
const FIELD_WRITING_VERBS: readonly RememberVerb[] = ["create", "write", "edit", "retag"];

function isFieldWritingVerb(verb: RememberVerb): boolean {
  return FIELD_WRITING_VERBS.includes(verb);
}

export interface RememberToolInput {
  verb?: unknown;
  // create
  title?: unknown;
  goal?: unknown;
  members?: unknown;
  // attach / write / edit / close / retag / delete / merge all share `id`
  // — a segment's `E<n>` address (ticket 15: the topic-name fallback
  // retired). OPTIONAL on `attach` (bare = return the pick list) and on
  // `detach` (bare = cancel every binding) — ticket 17. `create` (ticket 05,
  // container-unification spec D3) reads it too, but as a TIER switch: omitted
  // mints a task (ids are minted, never chosen); an "E<n>/#<tag>" lane address
  // mints a lane inside that task instead — the retired `declare` verb's own
  // id+tag pair, collapsed into one address. `retag` (ticket 04) and `delete`
  // (ticket 06, the retired `undeclare`'s own replacement) read `id` the SAME
  // way `create` does: a plain "E<n>" addresses the task, an "E<n>/#<tag>"
  // address addresses the lane — the address IS the target, on every verb
  // that operates on an existing container rather than a segment-scoped pair.
  // `merge` (container-unification ticket 08, spec D6) reads `id` two
  // different ways depending on whether `tag` is also present: WITH `tag`,
  // `id` is the ONE segment housing both lanes (the pre-existing lane tier,
  // unchanged); WITHOUT `tag`, `id` is the TASK that goes away (the new task
  // tier) — never an "E<n>/#<tag>" lane address on that tier, since a task's
  // own address has no tag component.
  id?: unknown;
  // write / edit
  field?: unknown;
  // write (ticket 05): the field's whole replacement text; null (or "")
  // clears it.
  value?: unknown;
  // edit (ticket 05's rename of replace)
  oldString?: unknown;
  newString?: unknown;
  // create (optional, TASK TIER ONLY) / retag (required): the NEW name.
  // Segment tier (ticket 14): the segment's ONE globally unique tag — `null`
  // clears it. Unused on create's LANE tier (ticket 05): that tier's name
  // comes from `id` ("E<n>/#<tag>") instead. Lane tier (ticket 04): the
  // lane's new tag — `id` names the EXISTING lane being renamed, `tag` names
  // what it becomes; a lane's tag is its identity, so there is no null-clear
  // form here. All answer to the SAME canonical predicate,
  // `checkCanonicalLaneTag` (db/lanes.ts), because a turn's own `tags` holds
  // both kinds side by side. `delete` does not read this field at all — its
  // whole target is `id`.
  // merge, LANE tier ([S15069/T1697]): the lane folded away — REQUIRED, and
  // this presence is also merge's own tier disambiguator (see `id` above):
  // an absent (or `null`) `tag` routes to the TASK tier instead
  // (container-unification ticket 08), where this field is not read at all.
  tag?: unknown;
  // merge, LANE tier ([S15069/T1697]): the SURVIVING lane. `tag` names the
  // one folded away, mirroring the retired declare/undeclare pair, so a
  // caller never has to remember which of two same-shaped words the verb
  // consumes. merge, TASK tier (container-unification ticket 08, spec D6,
  // reached when `tag` is absent): the SURVIVING task's "E<n>" address —
  // `id` names the one that goes away.
  into?: unknown;
  // clear (container-unification ticket 07, spec D5/D8): lane tier only.
  // `false` (the default) refuses the moment a candidate edge would strand a
  // CROSS-LANE or HALF-SETTLED side, printing the full list either way —
  // that list is the refusal's own product, not a precondition `force`
  // claims was read. `force` means only "proceed despite the warning".
  force?: unknown;
}

export interface RememberToolOptions {
  now?: () => number;
  runWriteTransaction?: typeof runWriteTransaction;
  /**
   * The caller's mnemo session (same resolution as `note`'s `callerSessionId`
   * — spec D2, server.ts's direct-execution entry point only). `attach`
   * requires it (there is nothing to bind without a session); `write`/
   * `edit` degrade gracefully — the write still lands, the maintenance
   * cadence line just says the caller session is unknown instead of a count.
   */
  callerSessionId?: number | null;
}

function textResult(text: string): ToolTextResult {
  return { content: [{ type: "text", text }] };
}

function parameterError(message: string): ToolTextResult {
  return textResult(`Parameter error: ${message}`);
}

class RememberValidationError extends Error {}

function fail(message: string): never {
  throw new RememberValidationError(message);
}

/**
 * The one prose-field resolver `create`'s title/goal both go through:
 * decode, markup-reject, strip `<private>` — the same hygiene `note`'s
 * `resolveStringField` applies, minus the append/overwrite mode machinery
 * `remember` has no equivalent of (a fresh segment has no prior value to
 * append onto).
 */
function resolveProseField(field: string, value: unknown, opts: { required: boolean }): string | null {
  if (value === undefined || value === null) {
    if (opts.required) {
      fail(`${field} is required.`);
    }
    return null;
  }
  if (typeof value !== "string") {
    fail(`${field} must be a string when present.`);
  }
  const decoded = decodeHtmlEntities(value);
  if (decoded.trim() === "") {
    if (opts.required) {
      fail(`${field} must not be empty.`);
    }
    return null;
  }
  if (containsToolCallSyntax(decoded)) {
    fail(toolCallSyntaxMessage(field, decoded));
  }
  return stripPrivateTags(decoded);
}

// ---------------------------------------------------------------------------
// Segment targeting — shared by attach/write/edit/close/retag (ticket
// 15: the topic registry retired, so `id` resolves ONLY as a segment address
// — every verb that used to fall back to a topic name now rejects a
// non-address string, echoing the address grammar).
// ---------------------------------------------------------------------------

type SegmentTargetResolution =
  | { ok: true; segment: SegmentRecord }
  | { ok: false; message: string };

function resolveSegmentTarget(db: Database, rawId: string): SegmentTargetResolution {
  const trimmed = rawId.trim();
  const bareRef = parseBareAddressReference(trimmed);

  if (!bareRef || bareRef.kind !== "segment") {
    return {
      ok: false,
      message: `id must be a segment address ("E<n>") — got "${trimmed}".`,
    };
  }
  const segment = getSegment(db, bareRef.segmentId);
  if (!segment) {
    return { ok: false, message: `no segment E${bareRef.segmentId}.` };
  }
  return { ok: true, segment };
}

// ---------------------------------------------------------------------------
// Maintenance cadence receipt (ADR-0002) — advisory, never a gate.
// ---------------------------------------------------------------------------

function formatMaintenanceCadence(
  db: Database,
  callerSessionId: number | null | undefined,
  priorUpdatedAtEpoch: number,
): string {
  if (typeof callerSessionId !== "number") {
    return "maintenance cadence: caller session unknown.";
  }
  const turnsSince = countTurnsSince(db, callerSessionId, priorUpdatedAtEpoch);
  const label = `${turnsSince} turn${turnsSince === 1 ? "" : "s"}`;
  return `${label} since this segment's last maintenance.`;
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

interface MemberAddressRejection {
  raw: string;
  reason: "malformed" | "not-a-turn" | "unresolved";
}

const MEMBER_REJECTION_TEXT: Record<MemberAddressRejection["reason"], string> = {
  malformed: 'is not a valid turn address ("S<session>/T<prompt>")',
  "not-a-turn": "names a segment, not a turn",
  unresolved: "does not resolve to a turn",
};

function formatMemberRejections(rejections: readonly MemberAddressRejection[]): string {
  return (
    "members rejected: " +
    rejections.map((entry) => `"${entry.raw}" ${MEMBER_REJECTION_TEXT[entry.reason]}`).join("; ") +
    " — membership is recorded for exactly the addresses given, so a call naming even one bad address seeds none."
  );
}

function resolveMemberAddresses(
  db: Database,
  addresses: readonly string[],
): { turnIds: number[]; rejections: MemberAddressRejection[] } {
  const rejections: MemberAddressRejection[] = [];
  const turnRefs: ParsedReference[] = [];

  for (const raw of addresses) {
    const parsed = parseBareAddressReference(raw);
    if (!parsed) {
      rejections.push({ raw, reason: "malformed" });
      continue;
    }
    if (parsed.kind !== "turn") {
      rejections.push({ raw, reason: "not-a-turn" });
      continue;
    }
    turnRefs.push(parsed);
  }

  if (turnRefs.length === 0) {
    return { turnIds: [], rejections };
  }

  const { accepted, rejected } = validateReferences(db, turnRefs);
  for (const entry of rejected) {
    rejections.push({ raw: entry.reference.raw, reason: "unresolved" });
  }
  return { turnIds: accepted.map((entry) => entry.node.id), rejections };
}

interface CreateTransactionResult {
  segment: SegmentRecord;
  memberTurnIds: number[];
  goalSeeded: boolean;
}

function handleCreate(
  db: Database,
  input: RememberToolInput,
  options: RememberToolOptions,
): ToolTextResult {
  // Ticket 05 (container-unification spec D3): `create` routes on the TIER
  // of `id`. Omitted — the ordinary case below — mints a TASK; task ids are
  // minted, never chosen, so there is nothing to address on that tier. A
  // present `id` can therefore only ever be a LANE address ("E<n>/#<tag>"):
  // it names an EXISTING task to mint a lane inside, the retired `declare`
  // verb's own capability, reached through the unified verb and the
  // canonical address instead of a second id+tag pair.
  if (input.id !== undefined && input.id !== null) {
    if (typeof input.id !== "string" || input.id.trim() === "") {
      return parameterError(
        'id must be a lane address ("E<n>/#<tag>") when present — omit it to mint a task instead.',
      );
    }
    return handleCreateLane(db, input.id, options);
  }

  let title: string;
  let goal: string | null;
  let memberAddresses: string[];
  let tags: string[];
  try {
    title = resolveProseField("title", input.title, { required: true })!;
    goal = resolveProseField("goal", input.goal, { required: false });

    if (input.members === undefined) {
      memberAddresses = [];
    } else if (
      Array.isArray(input.members) &&
      input.members.every((value) => typeof value === "string")
    ) {
      memberAddresses = input.members as string[];
    } else {
      fail("members must be an array of strings when present.");
    }

    // Ticket 14 (lane-model-v12 spec D3e): ONE tag, the segment's globally
    // unique name — optional here, because naming a container is a judgement a
    // caller may not be ready to make at the moment it mints one. Uniqueness
    // and canonical form are checked exactly where `retag` checks them, so a
    // segment cannot be born holding a word another segment already has.
    if (input.tag === undefined || input.tag === null) {
      tags = [];
    } else if (typeof input.tag === "string") {
      const trimmed = input.tag.trim();
      if (trimmed === "") {
        tags = [];
      } else {
        const canonical = checkCanonicalLaneTag(trimmed);
        if (!canonical.ok) {
          fail(canonical.message);
        }
        tags = [trimmed];
      }
    } else {
      fail("tag must be a single string when present — the segment's one globally unique tag.");
    }
  } catch (error) {
    if (error instanceof RememberValidationError) {
      return parameterError(error.message);
    }
    throw error;
  }

  const nowEpoch = options.now?.() ?? Math.floor(Date.now() / 1000);
  const writeTransaction = options.runWriteTransaction ?? runWriteTransaction;

  let result: CreateTransactionResult;
  try {
    result = writeTransaction(db, (): CreateTransactionResult => {
      const { turnIds, rejections } = resolveMemberAddresses(db, memberAddresses);
      if (rejections.length > 0) {
        fail(formatMemberRejections(rejections));
      }

      // Ticket 14: global uniqueness, checked here for its MESSAGE — the
      // unique index would refuse the insert anyway, but with SQLite's own
      // wording rather than the name of the segment already holding the word.
      const wanted = tags[0];
      if (wanted !== undefined) {
        const holder = db
          .query<{ id: number }, [string]>(
            `SELECT id FROM segments
              WHERE json_array_length(tags) >= 1 AND json_extract(tags, '$[0]') = ?`,
          )
          .get(wanted);
        if (holder) {
          fail(
            `"${wanted}" is already E${holder.id}'s segment tag — a segment tag is globally unique, ` +
              "because a turn's segment is derived from it. Pick another word.",
          );
        }
        // The OTHER namespace, for the same reason and with the same shape as
        // `retag`'s own pre-check: `createSegment` now throws on this, but a
        // raw throw reaches the caller as a failed tool call rather than a
        // refusal naming the lane that already holds the word.
        const laneHolder = findTagNamespaceHolder(db, "segment", wanted);
        if (laneHolder) {
          fail(formatTagNamespaceRefusal("segment", laneHolder));
        }
      }

      let segment = createSegment(db, {
        title,
        tags,
        nowEpoch,
      });

      // Ticket 02 (ownership-and-note-cadence spec): `members` seeding goes
      // through the SAME write path `assign` uses — `reassignSegmentMembers`,
      // not `addSegmentMembers` directly — so single ownership is enforced
      // uniformly. A fresh segment has no prior members of its own, but a
      // named turn may already belong to ANOTHER segment; seeding it here
      // evicts it from that segment the identical way an explicit `assign`
      // would, rather than opening a second, looser path around the rule.
      if (turnIds.length > 0) {
        // Lane-declaration ticket 02 (D2): seeding is a membership MOVE, so
        // it answers to the same stranding gate `assign` does. A fresh segment
        // has declared no lanes yet, so a turn carrying a tagged edge into one
        // is refused until the lane is declared there — which is the rule, not
        // an accident of ordering.
        const seeded = reassignSegmentMembers(db, turnIds, segment.id, nowEpoch);
        if (!seeded.ok) {
          fail(seeded.message);
        }
      }

      let goalSeeded = false;
      if (goal !== null) {
        const withGoal = appendSegmentWorkingStateRows(
          db,
          segment.id,
          "goal",
          [goal],
          nowEpoch,
        );
        if (withGoal) {
          segment = withGoal;
          goalSeeded = true;
        }
      }

      return { segment, memberTurnIds: turnIds, goalSeeded };
    });
  } catch (error) {
    if (error instanceof RememberValidationError) {
      return parameterError(error.message);
    }
    throw error;
  }

  const parts = [`Created E${result.segment.id} "${result.segment.title}".`];
  parts.push(
    result.memberTurnIds.length > 0
      ? `${result.memberTurnIds.length} member(s) seeded.`
      : "0 members seeded.",
  );
  if (result.goalSeeded) {
    parts.push("goal: 1 row seeded.");
  }
  const createdTag = segmentTagOf(result.segment);
  parts.push(
    createdTag === null
      ? 'unnamed — remember(retag, tag="…") names it, and nothing belongs here until it has a name.'
      : `tag: ${createdTag}. A turn carrying it belongs to this segment.`,
  );
  return textResult(parts.join(" "));
}

// ---------------------------------------------------------------------------
// create — lane tier (ticket 05, container-unification spec D3): the retired
// `declare` verb's own mint, reached through `create`'s `id` routing instead
// of a dedicated verb.
// ---------------------------------------------------------------------------

const LANE_CREATE_ADDRESS_PATTERN = /^E(\d+)\/#(.*)$/i;

/**
 * Parses `create`'s `id` as a lane address. Mirrors `recall.ts`'s own
 * `laneAddressRefusal`/`parseRoutedId` lane branch (container-unification
 * ticket 03, spec D2) — same shape, same canonical predicate — but kept
 * LOCAL rather than imported: that module exports neither helper, and this
 * is the only other write-side consumer of the grammar it defined, so a
 * three-line regex duplicated once is cheaper than opening a new export on a
 * file this ticket does not otherwise need to touch.
 */
function parseLaneCreateAddress(
  raw: string,
): { ok: true; segmentId: number; tag: string } | { ok: false; message: string } {
  const match = LANE_CREATE_ADDRESS_PATTERN.exec(raw.trim());
  if (!match) {
    return {
      ok: false,
      message:
        `id must be a lane address ("E<n>/#<tag>") when present — create mints a NEW task when id is ` +
        `omitted (task ids are assigned, never chosen), or a lane inside an EXISTING task when id names ` +
        `one; got "${raw}".`,
    };
  }
  const tag = match[2]!;
  const canonical = checkCanonicalLaneTag(tag);
  if (!canonical.ok) {
    return { ok: false, message: canonical.message };
  }
  return { ok: true, segmentId: Number(match[1]), tag };
}

/**
 * `create`'s lane tier (ticket 05, spec D3): mints a lane — `(segment, tag)`
 * — the object the edge-write gate requires BEFORE a tag may ride an edge.
 * Ported from the retired `declare` verb's own handler: same refusals, in
 * the same order, through the same `db/lanes.ts` primitives — only the
 * SOURCE of `segment`/`tag` changed, from two separate parameters to one
 * parsed address. Refuses (each naming the gap): a malformed or
 * non-canonical address, a segment that does not exist or is closed, a
 * duplicate declaration, a tag that is already one of the segment's own
 * CURATED tags (the two vocabularies stay separated by this enforced
 * invariant, not by intent), and a tag another segment already holds. Both
 * re-checked freshly INSIDE the write transaction, so a concurrent
 * create/retag cannot slip past a stale pre-check.
 *
 * Same precondition as the task tier (ticket 05, spec "两级共用同一条前置"):
 * nothing on the roster fits, the caller asks the user, they agree, only
 * then create — that call contract lives on the tool description, not here,
 * the same three-way split every other CALL-timing rule in this file follows.
 */
function handleCreateLane(
  db: Database,
  rawId: string,
  options: RememberToolOptions,
): ToolTextResult {
  const parsed = parseLaneCreateAddress(rawId);
  if (!parsed.ok) {
    return parameterError(parsed.message);
  }
  const { segmentId, tag } = parsed;

  const segment = getSegment(db, segmentId);
  if (!segment) {
    return parameterError(`no segment E${segmentId} — "${rawId}" names a lane inside it.`);
  }
  if (segment.status === "closed") {
    return parameterError(
      `E${segment.id} is closed — a lane may only be created on an open segment; ` +
        `remember(close, id="E${segment.id}") reopens it.`,
    );
  }

  const nowEpoch = options.now?.() ?? Math.floor(Date.now() / 1000);
  const writeTransaction = options.runWriteTransaction ?? runWriteTransaction;

  type CreateLaneOutcome =
    | { kind: "duplicate"; lane: LaneRecord }
    | { kind: "curated-collision" }
    | { kind: "namespace-collision"; message: string }
    | { kind: "created"; lane: LaneRecord; conscripted: { total: number; inSegment: number } };

  const outcome = writeTransaction(db, (): CreateLaneOutcome => {
    const existing = getLane(db, segmentId, tag);
    if (existing) {
      return { kind: "duplicate", lane: existing };
    }
    const fresh = getSegment(db, segmentId);
    if (fresh?.tags.includes(tag)) {
      return { kind: "curated-collision" };
    }
    // ANOTHER segment's tag (lane-model-v12, peer A2). `insertLane` refuses
    // this by throwing — it is the authority, and a migration reaches it
    // without passing here — so this pre-check exists to turn that into a
    // parameter error the caller can read and act on.
    const holder = findTagNamespaceHolder(db, "lane", tag);
    if (holder) {
      return { kind: "namespace-collision", message: formatTagNamespaceRefusal("lane", holder) };
    }
    // Ticket 14 (spec D3b): counted BEFORE the insert, in the same
    // transaction — a legacy free-form word becoming a lane conscripts every
    // turn that ever used it, and a big number is the best evidence a name
    // is too generic.
    const conscripted = countTurnsCarryingTag(db, tag, segmentId);
    const lane = insertLane(db, segmentId, tag, nowEpoch);
    return lane
      ? { kind: "created", lane, conscripted }
      : { kind: "duplicate", lane: getLane(db, segmentId, tag)! };
  });

  if (outcome.kind === "duplicate") {
    return parameterError(
      `E${segmentId} already declares lane "${tag}" (lane #${outcome.lane.id}).`,
    );
  }
  if (outcome.kind === "curated-collision") {
    return parameterError(
      `"${tag}" is already E${segmentId}'s own segment tag — a lane tag and a segment tag are ` +
        `two separate vocabularies; remember(retag) it off first if it should become a lane instead.`,
    );
  }
  if (outcome.kind === "namespace-collision") {
    return parameterError(outcome.message);
  }
  const { total, inSegment } = outcome.conscripted;
  const conscription =
    total === 0
      ? " No existing turn carries that word."
      : ` ${total} existing turn(s) already carry "${tag}"` +
        `${inSegment === total ? "" : `, ${inSegment} of them in E${segmentId}`} — ` +
        "they are its members from now on. A large number means the word is too generic to be a lane; " +
        `remember(delete, id="E${segmentId}/#${tag}") takes it back.`;
  return textResult(
    `Created lane "${tag}" on E${segmentId} (lane #${outcome.lane.id}).${conscription}`,
  );
}

// ---------------------------------------------------------------------------
// attach / detach — and the pick list bare `attach` answers with
// (lane-model-v12 ticket 17, spec D3g)
// ---------------------------------------------------------------------------

/**
 * How many live segments the pick list shows. Ten live standing containers
 * today, and the list is read by a HUMAN choosing one — a cap this far above
 * the real count exists only so a pathological corpus cannot produce an
 * unbounded tool result.
 */
export const SEGMENT_ATTACH_MENU_LIMIT = 50;

/**
 * The word a menu row uses when nobody has named the segment yet. Byte-identical
 * to `recall.ts`'s `UNNAMED_SEGMENT_LEAD`, and deliberately so: nine of the ten
 * live containers are unnamed, so this is the COMMON row, and a user comparing
 * the menu against the injected roster must not have to decide whether two
 * different words mean the same state.
 */
const UNNAMED_SEGMENT_MENU_WORD = "(unnamed)";

/**
 * One pick-list row: `- E<n> <title> — #<tag>`, per this ticket's own spec
 * (D3g's "`E<n>` 标题 — #tag").
 *
 * The ROSTER's row leads with the tag instead (`- #<tag> E<id> <title>`,
 * `renderRosterLine`) and that divergence is intentional, not drift: the roster
 * is a WRITE vocabulary — its leading column is the string a writer copies into
 * `tags`, so the tag earns first position. This list is a PICK list — the user
 * chooses by address, and for nine of ten live segments there is no tag to lead
 * with at all.
 */
function renderAttachMenuLine(
  segment: Pick<SegmentRecord, "id" | "title" | "tags">,
  attached: boolean,
): string {
  const tag = segmentTagOf(segment);
  const name = tag === null ? UNNAMED_SEGMENT_MENU_WORD : `#${tag}`;
  return `- E${segment.id} ${segment.title} — ${name}${attached ? " (attached)" : ""}`;
}

/**
 * The pick list bare `remember(attach)` — no `id` — returns: every live
 * segment, activity-recency ordered, with this session's current attachments
 * marked. It is a READ that licenses nothing (a row carries only the address,
 * the title and the tag, none of which is a writable field), so unlike the
 * roster it records no read grant.
 *
 * Reachable without a caller session: the LIST does not depend on one, only the
 * `(attached)` markers do. A menu that refused to render until the session was
 * known would be useless in exactly the case the slash command was built for.
 */
export function renderSegmentAttachMenu(
  db: Database,
  callerSessionId: number | null | undefined,
): string {
  const total = countLiveSegments(db, SEGMENT_CONTAINER_ERA_CUTOFF_EPOCH);
  const segments = listLiveSegmentsByActivity(
    db,
    SEGMENT_ATTACH_MENU_LIMIT,
    SEGMENT_CONTAINER_ERA_CUTOFF_EPOCH,
  );
  const attachedIds = new Set(
    typeof callerSessionId === "number"
      ? getAttachedSegmentIds(db, callerSessionId)
      : [],
  );

  const lines = [`## Attach this session to a segment (${total} live)`];
  if (segments.length === 0) {
    lines.push("(no live segments yet — remember(create) mints one)");
    return lines.join("\n");
  }
  for (const segment of segments) {
    lines.push(renderAttachMenuLine(segment, attachedIds.has(segment.id)));
  }
  if (total > segments.length) {
    lines.push(`(${total - segments.length} more not shown)`);
  }
  lines.push(
    'Pick one: remember(attach, id="E<n>") — it binds this session and returns that segment\'s card. ' +
      'remember(detach, id="E<n>") cancels one binding; remember(detach) cancels every binding this session has.',
  );
  return lines.join("\n");
}

function handleAttach(
  db: Database,
  input: RememberToolInput,
  options: RememberToolOptions,
): ToolTextResult {
  // Ticket 17: no `id` is not an error, it is the question — a caller that does
  // not know which segment to name gets the list of names instead of a scolding.
  if (input.id === undefined || input.id === null) {
    return textResult(renderSegmentAttachMenu(db, options.callerSessionId));
  }
  if (typeof input.id !== "string" || input.id.trim() === "") {
    return parameterError('id is required for attach — an "E<n>" address.');
  }
  if (typeof options.callerSessionId !== "number") {
    return parameterError("caller session unknown; attach cannot bind a segment to it.");
  }
  const callerSessionId = options.callerSessionId;

  const resolution = resolveSegmentTarget(db, input.id);
  if (!resolution.ok) {
    return parameterError(resolution.message);
  }

  const nowEpoch = options.now?.() ?? Math.floor(Date.now() / 1000);
  const writeTransaction = options.runWriteTransaction ?? runWriteTransaction;
  const { attached } = writeTransaction(db, () =>
    attachSegmentToSession(db, callerSessionId, resolution.segment.id, nowEpoch),
  );

  const header = `Attached S${callerSessionId} to E${resolution.segment.id}${
    attached ? "" : " (already attached)"
  }.`;
  // Ticket 03: attach returns the canonical segment card — the same render
  // `recall(id="E<n>")` collapsed produces — swapping ticket 02's provisional
  // plain render for it, per this module's own note above `handleAttach`.
  const card = renderSegmentCard(db, resolution.segment.id, {
    eraCutoffEpoch: null,
  });
  // …and the VOCABULARY the card no longer carries (peer review A4). Ticket 18
  // moved the lane list onto the SessionStart roster row, which a session that
  // attaches mid-conversation will not see until it resumes — this receipt is
  // the only channel between the two, so it carries the words the write gate
  // will judge the caller's next `tags` against.
  return textResult(
    `${header}\n${card}\n${renderSegmentLaneVocabulary(db, resolution.segment.id)}`,
  );
}

/**
 * `detach` (ticket 17): cancel this session's binding to one segment, or — with
 * no `id` — to all of them. It returns NO card: the point of the call is that
 * this session stops carrying that segment, so re-rendering it would be the
 * opposite of the receipt.
 *
 * A binding that was not there is reported, not rejected — the same latitude
 * `attach`'s "(already attached)" already takes, and the same reason: the
 * caller asked for an end state, and the end state is what it got.
 *
 * TICKET 23: the end state now STICKS. A detach is recorded per (session,
 * segment), and auto-attach honours the record, so a later tags write on the
 * same segment no longer mints the binding back — see
 * `detachSegmentFromSession` for which pairs each form records, and
 * `mcp/note.ts`'s auto-attach block for the one reader. Both receipts say so:
 * a caller told only "detached" would have no way to know whether it had to
 * keep detaching.
 */
function handleDetach(
  db: Database,
  input: RememberToolInput,
  options: RememberToolOptions,
): ToolTextResult {
  if (typeof options.callerSessionId !== "number") {
    return parameterError("caller session unknown; detach has no binding to cancel.");
  }
  const callerSessionId = options.callerSessionId;
  const writeTransaction = options.runWriteTransaction ?? runWriteTransaction;
  const nowEpoch = options.now?.() ?? Math.floor(Date.now() / 1000);

  if (input.id === undefined || input.id === null) {
    const { detached } = writeTransaction(db, () =>
      detachSegmentFromSession(db, callerSessionId, undefined, nowEpoch),
    );
    return textResult(
      detached === 0
        ? // Nothing was attached, so nothing was refused either: the bare form
          // names no segment, and a refusal has to be about one.
          `S${callerSessionId} was attached to no segment — nothing to cancel.`
        : `Detached S${callerSessionId} from ${detached} segment(s) — no segment card will be injected next session,` +
            " and writing one of their tags again will not re-attach it." +
            ' remember(attach, id="E<n>") is the way back.',
    );
  }
  if (typeof input.id !== "string" || input.id.trim() === "") {
    return parameterError('id must be an "E<n>" address when present on detach.');
  }
  const resolution = resolveSegmentTarget(db, input.id);
  if (!resolution.ok) {
    return parameterError(resolution.message);
  }
  const { detached } = writeTransaction(db, () =>
    detachSegmentFromSession(db, callerSessionId, resolution.segment.id, nowEpoch),
  );
  const stickiness =
    ` Writing E${resolution.segment.id}'s tag again will not re-attach it;` +
    ` remember(attach, id="E${resolution.segment.id}") is the way back.`;
  return textResult(
    (detached === 0
      ? `S${callerSessionId} was not attached to E${resolution.segment.id} — nothing to cancel.`
      : `Detached S${callerSessionId} from E${resolution.segment.id}.`) + stickiness,
  );
}

// ---------------------------------------------------------------------------
// write / edit (ticket 05, write-mode-edit-semantics: the vocabulary switch
// — `write` replaces a segment field whole, `edit` swaps an exactly-matched
// span within it, retiring `append`/`replace`)
// ---------------------------------------------------------------------------

function isEditableField(value: unknown): value is SegmentEditableField {
  return (
    typeof value === "string" &&
    (SEGMENT_EDITABLE_FIELDS as readonly string[]).includes(value)
  );
}

function fieldRequiredMessage(): string {
  return `field is required and must be one of ${SEGMENT_EDITABLE_FIELDS.join(", ")}.`;
}

/** Ticket 05: the write gate names `close` as the way back, in the same breath it refuses. */
function closedSegmentRejection(segmentId: number): string {
  return (
    `E${segmentId} is closed — Working State only accepts writes on an open segment; ` +
    `remember(close, id="E${segmentId}") reopens it.`
  );
}

// ---------------------------------------------------------------------------
// Write gate (ticket 02, read-write-contract spec "门(写面)") — the first
// consumer of `db/write-gate.ts`'s three-judgment check. `remember`'s own
// segment-field surface (append/replace, both Working State and content/
// insight): each call runs the gate for the ONE field it is about to touch,
// INSIDE the same write transaction as the field mutation and the stamp that
// follows it — no gap between the check passing and the write landing.
// ---------------------------------------------------------------------------

/**
 * `null` when the write may proceed (either the gate admits it, or `writer`
 * is unknown — the same "unknown always admits" latitude `note`'s own
 * cross-session guard gives an unidentified caller, since there is no writer
 * to attribute a stamp or a rejection to). Otherwise the rejection message,
 * already distinguishing "never-read" from "stale" — and, ticket 06, from
 * "read but not in full" — in its own text.
 */
function checkSegmentFieldGate(
  db: Database,
  writer: string | null,
  segmentId: number,
  field: SegmentEditableField,
  options: FieldGateOptions = {},
): string | null {
  if (!writer) {
    return null;
  }
  const verdict = checkFieldGate(
    db,
    writer,
    "segment",
    segmentId,
    field,
    `E${segmentId}`,
    options,
  );
  return verdict.ok ? null : verdict.message;
}

function stampSegmentField(
  db: Database,
  writer: string | null,
  segmentId: number,
  field: SegmentEditableField,
  nowEpoch: number,
): void {
  if (writer) {
    stampField(db, "segment", segmentId, field, writer, nowEpoch);
  }
}

function callerWriterId(callerSessionId: number | null | undefined): string | null {
  return typeof callerSessionId === "number" ? sessionWriterId(callerSessionId) : null;
}

/**
 * `remember`'s `write` verb (ticket 05, spec D2/D11): whole-field
 * replacement, the segment surface's first capability of this shape — wired
 * onto `writeSegmentWorkingStateField` (db/segments.ts, ticket 03's
 * prefactor), which already carries the citation-rebuild and FTS-reindex
 * duties this replaces. Supplied verbatim, no bullet-list normalization: the
 * row-list convention still stands (ADR-0001), but `write` is for the
 * caller who has read a field whole and is handing back the finished text —
 * see the tool description's row-add idiom for the alternative when only
 * one row needs to change.
 */
function handleWrite(
  db: Database,
  input: RememberToolInput,
  options: RememberToolOptions,
): ToolTextResult {
  if (typeof input.id !== "string" || input.id.trim() === "") {
    return parameterError('id is required for write — an "E<n>" address.');
  }
  if (!isEditableField(input.field)) {
    return parameterError(fieldRequiredMessage());
  }
  if (input.value === undefined) {
    return parameterError(
      "value is required for write — the field's full replacement text, or null to clear it.",
    );
  }
  if (input.value !== null && typeof input.value !== "string") {
    return parameterError("value must be a string or null when present.");
  }

  const resolution = resolveSegmentTarget(db, input.id);
  if (!resolution.ok) {
    return parameterError(resolution.message);
  }
  if (resolution.segment.status === "closed") {
    return parameterError(closedSegmentRejection(resolution.segment.id));
  }

  const field = input.field;
  let value: string | null;
  try {
    if (input.value === null) {
      value = null;
    } else {
      const decoded = decodeHtmlEntities(input.value);
      if (containsToolCallSyntax(decoded)) {
        fail(toolCallSyntaxMessage("value", decoded));
      }
      value = decoded.trim() === "" ? null : stripPrivateTags(decoded);
    }
  } catch (error) {
    if (error instanceof RememberValidationError) {
      return parameterError(error.message);
    }
    throw error;
  }

  const priorUpdatedAtEpoch = resolution.segment.updatedAtEpoch;
  const nowEpoch = options.now?.() ?? Math.floor(Date.now() / 1000);
  const writeTransaction = options.runWriteTransaction ?? runWriteTransaction;
  const writer = callerWriterId(options.callerSessionId);

  type WriteOutcome =
    | { kind: "gate-rejected"; message: string }
    | { kind: "missing" }
    | { kind: "ok"; segment: SegmentRecord };

  const outcome = writeTransaction(db, (): WriteOutcome => {
    // Ticket 06 (spec D2): "does this field already hold something" is read
    // INSIDE the transaction, not off the pre-transaction `resolution`
    // snapshot — the same "检查-写入原子" discipline the gate check itself
    // follows, so a field that gained content between the two cannot be
    // overwritten under an exemption that was true a moment earlier.
    const fresh = getSegment(db, resolution.segment.id);
    if (!fresh) {
      return { kind: "missing" };
    }
    const existing = segmentEditableFieldValue(fresh, field);
    const rejection = checkSegmentFieldGate(db, writer, resolution.segment.id, field, {
      // `write` replaces the field whole, so anything currently there that
      // this writer's read did not show is what it would silently delete.
      // An empty field (never written, or cleared) has nothing to lose.
      requireCompleteRead: existing !== null && existing.trim() !== "",
      // The card's field rows are elided against `pageBudget` (segment-card.ts's
      // ladder), not against recall's per-item `turn` cap — so the segment
      // surface names its OWN knob here rather than inheriting the gate's
      // generic wording.
      completeReadRemedy:
        `re-read it whole with recall(id="E${resolution.segment.id}", ` +
        `pageBudget=<a bigger token budget>),`,
    });
    if (rejection) {
      return { kind: "gate-rejected", message: rejection };
    }
    const updated = writeSegmentWorkingStateField(db, resolution.segment.id, field, value, nowEpoch);
    if (!updated) {
      return { kind: "missing" };
    }
    stampSegmentField(db, writer, resolution.segment.id, field, nowEpoch);
    return { kind: "ok", segment: updated };
  });

  if (outcome.kind === "gate-rejected") {
    return parameterError(outcome.message);
  }
  if (outcome.kind === "missing") {
    return parameterError(`E${resolution.segment.id} no longer exists.`);
  }
  const updated = outcome.segment;

  const cadence = formatMaintenanceCadence(
    db,
    options.callerSessionId,
    priorUpdatedAtEpoch,
  );

  const verb = value === null ? "Cleared" : "Wrote";
  return textResult(`${verb} ${field} on E${updated.id}. ${cadence}`);
}

// ---------------------------------------------------------------------------
// edit (ticket 05's rename of replace — identical oldString/newString shape)
// ---------------------------------------------------------------------------

function handleEdit(
  db: Database,
  input: RememberToolInput,
  options: RememberToolOptions,
): ToolTextResult {
  if (typeof input.id !== "string" || input.id.trim() === "") {
    return parameterError('id is required for edit — an "E<n>" address.');
  }
  if (!isEditableField(input.field)) {
    return parameterError(fieldRequiredMessage());
  }
  if (typeof input.oldString !== "string" || input.oldString === "") {
    return parameterError("oldString is required and must be a non-empty string.");
  }
  if (typeof input.newString !== "string") {
    return parameterError('newString is required (use "" to delete the matched text).');
  }

  const resolution = resolveSegmentTarget(db, input.id);
  if (!resolution.ok) {
    return parameterError(resolution.message);
  }
  if (resolution.segment.status === "closed") {
    return parameterError(closedSegmentRejection(resolution.segment.id));
  }

  const field = input.field;
  const oldString = decodeHtmlEntities(input.oldString);
  const newStringRaw = decodeHtmlEntities(input.newString);
  if (containsToolCallSyntax(oldString)) {
    return parameterError(toolCallSyntaxMessage("oldString", oldString));
  }
  if (newStringRaw !== "" && containsToolCallSyntax(newStringRaw)) {
    return parameterError(toolCallSyntaxMessage("newString", newStringRaw));
  }
  const newString = newStringRaw === "" ? "" : stripPrivateTags(newStringRaw);

  const priorUpdatedAtEpoch = resolution.segment.updatedAtEpoch;
  const nowEpoch = options.now?.() ?? Math.floor(Date.now() / 1000);
  const writeTransaction = options.runWriteTransaction ?? runWriteTransaction;
  const writer = callerWriterId(options.callerSessionId);

  type ReplaceOutcome =
    | { kind: "gate-rejected"; message: string }
    | { kind: "replaced"; result: ReplaceSegmentWorkingStateFieldResult };

  const outcome = writeTransaction(db, (): ReplaceOutcome => {
    // Ticket 06 (spec D3/D5/D6): `edit` runs the SAME three judgments —
    // authorization and staleness are not relaxed for it — and only the
    // complete-read requirement is left off, because an exact-match swap
    // never touches the rows a truncated render hid.
    const rejection = checkSegmentFieldGate(db, writer, resolution.segment.id, field);
    if (rejection) {
      return { kind: "gate-rejected", message: rejection };
    }
    const result = replaceInSegmentWorkingStateField(
      db,
      resolution.segment.id,
      field,
      oldString,
      newString,
      nowEpoch,
    );
    if (result.segment && !result.rejection) {
      stampSegmentField(db, writer, resolution.segment.id, field, nowEpoch);
    }
    return { kind: "replaced", result };
  });

  if (outcome.kind === "gate-rejected") {
    return parameterError(outcome.message);
  }
  const { result } = outcome;

  if (!result.segment) {
    return parameterError(`E${resolution.segment.id} no longer exists.`);
  }
  if (result.rejection === "missing") {
    return parameterError(
      `oldString ${JSON.stringify(oldString)} not found in ${field} on E${resolution.segment.id}.`,
    );
  }
  if (result.rejection === "ambiguous") {
    return parameterError(
      `oldString ${JSON.stringify(oldString)} matches ${result.occurrences} times in ${field} on ` +
        `E${resolution.segment.id} — narrow it so it matches exactly once.`,
    );
  }

  const cadence = formatMaintenanceCadence(
    db,
    options.callerSessionId,
    priorUpdatedAtEpoch,
  );
  const verb = newString === "" ? "Removed a row from" : "Replaced text in";
  return textResult(`${verb} ${field} on E${resolution.segment.id}. ${cadence}`);
}

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------

/**
 * Ticket 05: toggles the segment closed (leaves the roster, still
 * `recall`-able) or, on an already-closed segment, reopens it — see
 * `toggleSegmentStatus` (db/segments.ts) for why this is one verb, not two.
 */
function handleClose(
  db: Database,
  input: RememberToolInput,
  options: RememberToolOptions,
): ToolTextResult {
  if (typeof input.id !== "string" || input.id.trim() === "") {
    return parameterError('id is required for close — an "E<n>" address.');
  }

  const resolution = resolveSegmentTarget(db, input.id);
  if (!resolution.ok) {
    return parameterError(resolution.message);
  }

  const nowEpoch = options.now?.() ?? Math.floor(Date.now() / 1000);
  const writeTransaction = options.runWriteTransaction ?? runWriteTransaction;
  const updated = writeTransaction(db, () =>
    toggleSegmentStatus(db, resolution.segment.id, nowEpoch),
  );

  if (!updated) {
    return parameterError(`E${resolution.segment.id} no longer exists.`);
  }

  return textResult(
    updated.status === "closed"
      ? `Closed E${updated.id} — it leaves the roster, still recall-able. ` +
          `remember(close, id="E${updated.id}") reopens it.`
      : `Reopened E${updated.id} — it rejoins the roster.`,
  );
}

// ---------------------------------------------------------------------------
// retag
// ---------------------------------------------------------------------------

/**
 * `remember`'s `retag` verb: NAMES a container — TIER chosen by `id`, the
 * same routing `create` already applies (container-unification ticket 05,
 * spec D3). A plain "E<n>" retags the SEGMENT (ticket 14, lane-model-v12 spec
 * D3e); an "E<n>/#<tag>" address retags a LANE inside it (container-
 * unification ticket 04, spec D3) — see `handleRetagLane` below for that
 * half. This function keeps the segment-tier body; the routing check runs
 * first because the two tiers share nothing past validating `id`.
 *
 * SEGMENT TIER. ONE tag, globally unique — that word is the segment's
 * identity, and a turn joins the segment by carrying it
 * (`db/turn-tag-gate.ts`), so two segments sharing a word would make
 * membership unanswerable.
 *
 * `tag: null` (or omitted) clears the name, which is the state the standing
 * containers a human has not yet named sit in: nothing can derive into an
 * unnamed container, and nothing is lost, since the words a segment used to
 * carry are still on its member turns.
 *
 * Refuses, each naming the gap: a non-canonical or namespace-prefixed word
 * (`checkCanonicalLaneTag`, db/lanes.ts), a word already declared as one of
 * this segment's own LANES, a word another segment already holds, and any
 * change at all on a closed segment.
 *
 * Renaming does NOT re-derive existing members. The turns carrying the old
 * word keep their membership rows; the new word governs writes from here on.
 * Same grandfathering the one-tag migration applies, and for the same reason:
 * a rename is not a statement about which past turns belonged here.
 */
function handleRetag(
  db: Database,
  input: RememberToolInput,
  options: RememberToolOptions,
): ToolTextResult {
  if (typeof input.id !== "string" || input.id.trim() === "") {
    return parameterError(
      'id is required for retag — an "E<n>" task address or an "E<n>/#<tag>" lane address.',
    );
  }
  const trimmedId = input.id.trim();
  const laneMatch = LANE_CREATE_ADDRESS_PATTERN.exec(trimmedId);
  if (laneMatch) {
    return handleRetagLane(db, Number(laneMatch[1]), laneMatch[2]!, input, options);
  }

  if (input.tag !== undefined && input.tag !== null && typeof input.tag !== "string") {
    return parameterError(
      "tag must be a single string — the segment's one globally unique tag — or null to clear it.",
    );
  }
  const requested = typeof input.tag === "string" ? input.tag.trim() : null;
  const tag = requested === "" ? null : requested;

  const resolution = resolveSegmentTarget(db, input.id);
  if (!resolution.ok) {
    return parameterError(resolution.message);
  }
  if (resolution.segment.status === "closed") {
    return parameterError(
      `E${resolution.segment.id} is closed — a segment tag may only change on an open segment; ` +
        `remember(close, id="E${resolution.segment.id}") reopens it.`,
    );
  }

  if (tag !== null) {
    // Canonical form, and the namespace clause ticket 14 added: a segment tag
    // answers to the same predicate a lane tag does, because a turn's `tags`
    // holds both and the gate that reads them cannot tell two spellings of one
    // word apart.
    const canonical = checkCanonicalLaneTag(tag);
    if (!canonical.ok) {
      return parameterError(canonical.message);
    }
    // Lane-declaration ticket 01 (spec D1): a word already declared as one of
    // this segment's LANES may not also be its name — lane-tier `create`'s
    // mirror of this check is in `handleCreateLane` above.
    // GLOBAL since lane-model-v12 (peer A2): any segment's lane, not just this
    // one's. `setSegmentTag` re-asks the same question inside the write
    // transaction — this pre-check exists only for the message.
    const laneCollisions = findRetagLaneCollisions(db, [tag]);
    if (laneCollisions[0]) {
      return parameterError(formatTagNamespaceRefusal("segment", laneCollisions[0]));
    }
  }

  const nowEpoch = options.now?.() ?? Math.floor(Date.now() / 1000);
  const writeTransaction = options.runWriteTransaction ?? runWriteTransaction;
  // Uniqueness re-checked INSIDE the transaction (`setSegmentTag`), so a
  // concurrent retag cannot slip past a stale pre-check — the same discipline
  // lane-tier `create` applies to its own two checks.
  const outcome = writeTransaction(db, () =>
    setSegmentTag(db, resolution.segment.id, tag, nowEpoch),
  );

  if (!outcome.ok) {
    return parameterError(outcome.message);
  }

  const named = segmentTagOf(outcome.segment);
  return textResult(
    named === null
      ? `Cleared E${outcome.segment.id}'s segment tag — nothing derives into it until it is named again. ` +
          "Existing members are untouched."
      : `E${outcome.segment.id} is now "${named}". A turn carrying that tag belongs to this segment; ` +
          "existing members are untouched.",
  );
}

// ---------------------------------------------------------------------------
// retag — lane tier (container-unification ticket 04, spec D3)
// ---------------------------------------------------------------------------

/**
 * `retag`'s lane tier: a lane that was named wrong can be renamed directly,
 * without the "create a fresh one, `merge` the old one into it, `delete` the
 * husk" three-step workaround. `id` names the EXISTING lane
 * ("E<n>/#<oldtag>"); `tag` supplies the new name — required, since a lane's
 * tag IS its identity and cannot be cleared the way a segment's can.
 *
 * REUSES `renameLane` (db/lanes.ts), which is itself a thin composition over
 * `mergeLaneTag` — the same three populations (member tags, edge sides, the
 * registry row) a fold already moves, mint-then-fold rather than a second
 * traversal that could drift from it. This function's own job is the
 * SURROUNDING checks `renameLane` does not own: the segment must exist and be
 * open, the two tags must be canonical, and the destination must differ from
 * the source.
 *
 * A name already declared in this segment refuses, naming it — `renameLane`'s
 * own `insertLane` call is the guard, PAIRED with the write (its `ON
 * CONFLICT ... DO NOTHING RETURNING` returns nothing for an occupied name, so
 * there is no window between checking and minting for the message's own
 * pre-check to race against).
 */
function handleRetagLane(
  db: Database,
  segmentId: number,
  rawFromTag: string,
  input: RememberToolInput,
  options: RememberToolOptions,
): ToolTextResult {
  const fromCanonical = checkCanonicalLaneTag(rawFromTag);
  if (!fromCanonical.ok) {
    return parameterError(fromCanonical.message);
  }
  const fromTag = rawFromTag;

  if (typeof input.tag !== "string" || input.tag.trim() === "") {
    return parameterError(
      "tag is required for a lane retag — the lane's new name; a lane's tag is its identity, so there " +
        "is no null-clear form the way a segment tag has.",
    );
  }
  const toTag = input.tag.trim();
  const toCanonical = checkCanonicalLaneTag(toTag);
  if (!toCanonical.ok) {
    return parameterError(toCanonical.message);
  }
  if (toTag === fromTag) {
    return parameterError(
      `"${fromTag}" is already this lane's name — retag needs a different tag; use \`merge\` to fold ` +
        "two lanes into one instead.",
    );
  }

  const nowEpoch = options.now?.() ?? Math.floor(Date.now() / 1000);
  const writeTransaction = options.runWriteTransaction ?? runWriteTransaction;

  type RetagLaneOutcome =
    | { kind: "no-segment" }
    | { kind: "closed" }
    | { kind: "namespace-collision"; holder: TagNamespaceHolder }
    | RenameLaneOutcome;

  const outcome = writeTransaction(db, (): RetagLaneOutcome => {
    const segment = getSegment(db, segmentId);
    if (!segment) {
      return { kind: "no-segment" };
    }
    if (segment.status === "closed") {
      return { kind: "closed" };
    }
    // `renameLane` reaches `insertLane`, which THROWS on a cross-namespace
    // collision — and a throw here leaves the tool with no result to convert,
    // so the caller saw a failed MCP call instead of a refusal naming the
    // holder (peer round three finding 06). Asked here, inside the same write
    // transaction the rename runs in, so nothing can claim the word between
    // the check and the write; `create` got the identical pre-check for the
    // identical reason.
    const holder = findTagNamespaceHolder(db, "lane", toTag);
    if (holder) {
      return { kind: "namespace-collision", holder };
    }
    return renameLane(db, segmentId, fromTag, toTag, nowEpoch);
  });

  if (outcome.kind === "namespace-collision") {
    return parameterError(formatTagNamespaceRefusal("lane", outcome.holder));
  }

  if (outcome.kind === "no-segment") {
    return parameterError(`no segment E${segmentId} — "E${segmentId}/#${fromTag}" names a lane inside it.`);
  }
  if (outcome.kind === "closed") {
    return parameterError(
      `E${segmentId} is closed — a lane may only be retagged on an open segment; ` +
        `remember(close, id="E${segmentId}") reopens it.`,
    );
  }
  if (outcome.kind === "no-from") {
    return parameterError(`E${segmentId} has no declared lane "${fromTag}".`);
  }
  if (outcome.kind === "duplicate") {
    return parameterError(
      `E${segmentId} already declares lane "${toTag}" — retag needs a name nothing else in this ` +
        "segment already holds.",
    );
  }

  const { receipt } = outcome;
  const lines = [
    `Retagged E${segmentId}'s lane "${fromTag}" to "${toTag}".`,
    `  member turns retagged: ${receipt.turnsRetagged}`,
    `  edge sides rewritten: ${receipt.edgeSidesRewritten}`,
  ];
  if (receipt.collisions.length > 0) {
    lines.push(
      `  identity-key collisions folded: ${receipt.collisions.length} row(s) deleted — the rewrite ` +
        "landed them on a surviving row's key.",
    );
  }
  return textResult(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// merge (lane-declaration D1/D4, [S15069/T1697]). `declare`/`undeclare` used
// to share this preamble too — container-unification ticket 05 retired
// `declare` into `create`'s own id-tier routing (see `handleCreateLane`
// above), and ticket 06 retires `undeclare` into `delete`'s own id-tier
// routing (see below), which addresses a lane by "E<n>/#<tag>" rather than
// this id+tag pair. `merge` alone still speaks it — it is not in either
// ticket's charter, and its own id (the segment) plus tag (the lane folded
// away) plus into (the survivor) genuinely needs three operands, which no
// single address can carry.
// ---------------------------------------------------------------------------

/** The `id`/closed-segment/`tag` shape `merge` opens with. */
type LaneVerbPreamble =
  | { ok: false; result: ToolTextResult }
  | { ok: true; segment: SegmentRecord; tag: string };

function resolveLaneVerbPreamble(
  db: Database,
  input: RememberToolInput,
  verb: "merge",
): LaneVerbPreamble {
  if (typeof input.id !== "string" || input.id.trim() === "") {
    return { ok: false, result: parameterError(`id is required for ${verb} — an "E<n>" address.`) };
  }
  const resolution = resolveSegmentTarget(db, input.id);
  if (!resolution.ok) {
    return { ok: false, result: parameterError(resolution.message) };
  }
  if (resolution.segment.status === "closed") {
    return {
      ok: false,
      result: parameterError(
        `E${resolution.segment.id} is closed — lanes may only be ${verb}d on an open segment; ` +
          `remember(close, id="E${resolution.segment.id}") reopens it.`,
      ),
    };
  }
  if (typeof input.tag !== "string" || input.tag === "") {
    return { ok: false, result: parameterError(`tag is required for ${verb} — a single lane tag.`) };
  }
  const canonical = checkCanonicalLaneTag(input.tag);
  if (!canonical.ok) {
    return { ok: false, result: parameterError(canonical.message) };
  }
  return { ok: true, segment: resolution.segment, tag: input.tag };
}

// ---------------------------------------------------------------------------
// delete (container-unification ticket 06, spec D4). Routes on `id`'s tier,
// the same way `create`/`retag` do: a plain "E<n>" deletes a TASK, an
// "E<n>/#<tag>" address deletes a LANE. Neither tier takes `force` — a
// non-empty container refuses outright, naming the count and the ways out
// (`merge` re-homes members, `clear` un-homes them); strong-deleting a live
// container is using the wrong verb, not an operation that needs a warning
// (spec D4, "delete 没有 force").
// ---------------------------------------------------------------------------

function handleDelete(
  db: Database,
  input: RememberToolInput,
  options: RememberToolOptions,
): ToolTextResult {
  if (typeof input.id !== "string" || input.id.trim() === "") {
    return parameterError(
      'id is required for delete — an "E<n>" task address or an "E<n>/#<tag>" lane address.',
    );
  }
  const trimmedId = input.id.trim();
  const laneMatch = LANE_CREATE_ADDRESS_PATTERN.exec(trimmedId);
  if (laneMatch) {
    return handleDeleteLane(db, Number(laneMatch[1]), laneMatch[2]!, options);
  }
  return handleDeleteTask(db, trimmedId, options);
}

/**
 * `delete`'s lane tier — the retired `undeclare` verb's own guard, inherited
 * rather than rewritten (spec D4): refuses while any MEMBER TURN in the
 * segment still carries the tag, naming the count. The in-use count and the
 * delete run in the SAME transaction as the existence check, so a concurrent
 * tags write cannot land between "found zero" and the delete.
 *
 * `merge` re-homes those members today (it already works, folding them into
 * another declared lane); a `clear` that un-homes them the same way `delete`
 * un-homes a task's members does not exist yet.
 */
function handleDeleteLane(
  db: Database,
  segmentId: number,
  rawTag: string,
  options: RememberToolOptions,
): ToolTextResult {
  const canonical = checkCanonicalLaneTag(rawTag);
  if (!canonical.ok) {
    return parameterError(canonical.message);
  }
  const tag = rawTag;

  const writeTransaction = options.runWriteTransaction ?? runWriteTransaction;

  type DeleteLaneOutcome =
    | { kind: "no-segment" }
    | { kind: "closed" }
    | { kind: "not-declared" }
    | { kind: "in-use"; count: number }
    | { kind: "deleted" };

  const outcome = writeTransaction(db, (): DeleteLaneOutcome => {
    const segment = getSegment(db, segmentId);
    if (!segment) {
      return { kind: "no-segment" };
    }
    if (segment.status === "closed") {
      return { kind: "closed" };
    }
    const lane = getLane(db, segmentId, tag);
    if (!lane) {
      return { kind: "not-declared" };
    }
    const inUse = countLaneMemberTurnsInSegment(db, segmentId, tag);
    if (inUse > 0) {
      return { kind: "in-use", count: inUse };
    }
    deleteLane(db, segmentId, tag);
    return { kind: "deleted" };
  });

  if (outcome.kind === "no-segment") {
    return parameterError(`no segment E${segmentId} — "E${segmentId}/#${tag}" names a lane inside it.`);
  }
  if (outcome.kind === "closed") {
    return parameterError(
      `E${segmentId} is closed — a lane may only be deleted on an open segment; ` +
        `remember(close, id="E${segmentId}") reopens it.`,
    );
  }
  if (outcome.kind === "not-declared") {
    return parameterError(`E${segmentId} has no declared lane "${tag}".`);
  }
  if (outcome.kind === "in-use") {
    return parameterError(
      `E${segmentId}'s lane "${tag}" still has ${outcome.count} member turn(s) carrying it — delete ` +
        `refuses while any turn carries it. remember(merge, id="E${segmentId}", tag="${tag}", ` +
        'into="<another lane>") re-homes them; clearing the tag off each turn un-homes them.',
    );
  }
  return textResult(`Deleted lane "${tag}" on E${segmentId}.`);
}

/**
 * `delete`'s task tier: refuses unless the task has NO members (by
 * OWNERSHIP — `getSegmentMemberTurnIds` reads `segment_members` directly,
 * the same storage `getOwningSegmentId` derives from, never a tag count.
 * `create(members=[...])` writes that table WITHOUT adding the segment's tag
 * to the turn, so a tag-based count would read zero for a task that
 * genuinely has members and let this cascade their `segment_members` rows
 * away) AND no declared lane. Two conditions, each with its own refusal —
 * checked in that order, both re-read INSIDE the write transaction.
 *
 * A closed task may still be deleted: `close` only toggles roster
 * visibility, and an empty, no-longer-worked-on task is exactly the resting
 * state delete exists for — gating it behind reopening first would be pure
 * friction.
 */
function handleDeleteTask(
  db: Database,
  rawId: string,
  options: RememberToolOptions,
): ToolTextResult {
  const resolution = resolveSegmentTarget(db, rawId);
  if (!resolution.ok) {
    return parameterError(resolution.message);
  }
  const segmentId = resolution.segment.id;

  const writeTransaction = options.runWriteTransaction ?? runWriteTransaction;

  type DeleteTaskOutcome =
    | { kind: "missing" }
    | { kind: "has-members"; count: number }
    | { kind: "has-lanes"; tags: string[] }
    | { kind: "deleted" };

  const outcome = writeTransaction(db, (): DeleteTaskOutcome => {
    if (!getSegment(db, segmentId)) {
      return { kind: "missing" };
    }
    const memberTurnIds = getSegmentMemberTurnIds(db, segmentId);
    if (memberTurnIds.length > 0) {
      return { kind: "has-members", count: memberTurnIds.length };
    }
    const lanes = listLanesForSegment(db, segmentId);
    if (lanes.length > 0) {
      return { kind: "has-lanes", tags: lanes.map((lane) => lane.tag) };
    }
    deleteSegmentRow(db, segmentId);
    return { kind: "deleted" };
  });

  if (outcome.kind === "missing") {
    return parameterError(`E${segmentId} no longer exists.`);
  }
  if (outcome.kind === "has-members") {
    return parameterError(
      `E${segmentId} still has ${outcome.count} member turn(s) — delete only removes an EMPTY task. ` +
        "merge re-homes them into another task; clear releases them from this one.",
    );
  }
  if (outcome.kind === "has-lanes") {
    return parameterError(
      `E${segmentId} still declares ${outcome.tags.length} lane(s) (${outcome.tags.join(", ")}) — ` +
        "delete refuses while any lane remains declared; merge or delete each one first.",
    );
  }
  return textResult(`Deleted E${segmentId}.`);
}

// ---------------------------------------------------------------------------
// clear (container-unification ticket 07, spec D5/D5b/D8). Routes on `id`'s
// tier the same way `create`/`retag`/`delete` do — `clear` is the fourth
// verb on this address, not a new mechanism: it un-homes a container's
// members without deleting the container itself, so `delete`'s own
// empty-only guard can then remove it.
// ---------------------------------------------------------------------------

function handleClear(
  db: Database,
  input: RememberToolInput,
  options: RememberToolOptions,
): ToolTextResult {
  if (typeof input.id !== "string" || input.id.trim() === "") {
    return parameterError(
      'id is required for clear — an "E<n>" task address or an "E<n>/#<tag>" lane address.',
    );
  }
  const trimmedId = input.id.trim();
  const laneMatch = LANE_CREATE_ADDRESS_PATTERN.exec(trimmedId);
  if (laneMatch) {
    return handleClearLane(db, Number(laneMatch[1]), laneMatch[2]!, input, options);
  }
  return handleClearTask(db, trimmedId, options);
}

/**
 * `clear`'s lane tier (spec D5/D5b): un-home every member turn from this
 * lane and delete every edge row that resolves to it — the two acts that
 * make `delete`'s own empty-only guard (D4) reachable for a lane that was
 * ever used, the same relationship `merge` already has to it.
 *
 * `force` gates two classes of edge, printed either way (D8): a CROSS-LANE
 * row (the other side is a DIFFERENT declared lane, same segment or
 * another one) and a HALF-SETTLED row (the other side is the unsettled
 * sentinel `''`, never settled by anyone) — deleting either without warning
 * would silently destroy another lane's record, or leave a stranded side
 * naming a lane that no longer exists.
 *
 * The whole mechanism is `db/lanes.ts`'s `clearLane`; this function is the
 * surrounding shell every lane-tier verb here shares — segment exists,
 * segment is open, tag is canonical — re-checked INSIDE the write
 * transaction, the same discipline `create`/`retag`/`delete`'s lane tiers
 * follow.
 */
function handleClearLane(
  db: Database,
  segmentId: number,
  rawTag: string,
  input: RememberToolInput,
  options: RememberToolOptions,
): ToolTextResult {
  const canonical = checkCanonicalLaneTag(rawTag);
  if (!canonical.ok) {
    return parameterError(canonical.message);
  }
  const tag = rawTag;

  if (input.force !== undefined && typeof input.force !== "boolean") {
    return parameterError("force must be a boolean when present.");
  }
  const force = input.force === true;

  const nowEpoch = options.now?.() ?? Math.floor(Date.now() / 1000);
  const writeTransaction = options.runWriteTransaction ?? runWriteTransaction;

  type ClearLaneHandlerOutcome =
    | { kind: "no-segment" }
    | { kind: "closed" }
    | LaneClearOutcome;

  const outcome = writeTransaction(db, (): ClearLaneHandlerOutcome => {
    const segment = getSegment(db, segmentId);
    if (!segment) {
      return { kind: "no-segment" };
    }
    if (segment.status === "closed") {
      return { kind: "closed" };
    }
    return clearLane(db, segmentId, tag, nowEpoch, force);
  });

  if (outcome.kind === "no-segment") {
    return parameterError(`no segment E${segmentId} — "E${segmentId}/#${tag}" names a lane inside it.`);
  }
  if (outcome.kind === "closed") {
    return parameterError(
      `E${segmentId} is closed — a lane may only be cleared on an open segment; ` +
        `remember(close, id="E${segmentId}") reopens it.`,
    );
  }
  if (outcome.kind === "not-declared") {
    return parameterError(`E${segmentId} has no declared lane "${tag}".`);
  }
  if (outcome.kind === "blocked") {
    const lines = [
      `E${segmentId}'s lane "${tag}" cannot be cleared without force — ${outcome.blockers.length} ` +
        "edge(s) would be affected:",
    ];
    for (const blocker of outcome.blockers) {
      const detail =
        blocker.kind === "half-settled"
          ? "half-settled — the other side was never settled"
          : `cross-lane — the other side is ${blocker.otherLane}`;
      lines.push(
        `  ${blocker.citingAddress} —${blocker.relation ?? "(bare)"}→ ${blocker.citedAddress} (${detail})`,
      );
    }
    lines.push(
      `remember(clear, id="E${segmentId}/#${tag}", force=true) proceeds anyway — it does not claim ` +
        "you have read this list.",
    );
    return parameterError(lines.join("\n"));
  }

  const { receipt } = outcome;
  const lines = [
    `Cleared E${segmentId}'s lane "${tag}" — ${receipt.turnsCleared} member turn(s) released, ` +
      `${receipt.edgesDeleted} edge(s) deleted.`,
  ];
  if (receipt.bareRowsRestored > 0) {
    lines.push(
      `  ${receipt.bareRowsRestored} bare row(s) restored — the citing prose still names the target.`,
    );
  }
  lines.push(`remember(delete, id="E${segmentId}/#${tag}") removes the now-empty lane.`);
  return textResult(lines.join("\n"));
}

/**
 * `clear`'s task tier (spec D5b): refuses while the task still declares any
 * lane, listing them — it does NOT recurse. The write gate structurally
 * forbids a turn carrying a lane tag without its task tag, so stripping only
 * the task tag off a member that still carries one of this task's lanes
 * would be refused there; and an edge side holds no task tag at all, so
 * "delete the edges under this task" has no stored predicate to act on.
 * Clear every lane first (`clear` or `merge`, per lane), and only then does
 * clearing the task itself become the safe, tags-only act
 * `clearSegmentMembers` (db/segments.ts) is.
 *
 * A closed task may still be cleared — the same reasoning `delete`'s own
 * task tier already applies: `close` only toggles roster visibility, and an
 * emptied, no-longer-worked-on task is exactly the resting state this verb
 * exists to reach.
 */
function handleClearTask(
  db: Database,
  rawId: string,
  options: RememberToolOptions,
): ToolTextResult {
  const resolution = resolveSegmentTarget(db, rawId);
  if (!resolution.ok) {
    return parameterError(resolution.message);
  }
  const segmentId = resolution.segment.id;

  const nowEpoch = options.now?.() ?? Math.floor(Date.now() / 1000);
  const writeTransaction = options.runWriteTransaction ?? runWriteTransaction;

  type ClearTaskOutcome =
    | { kind: "missing" }
    | { kind: "has-lanes"; tags: string[] }
    | { kind: "cleared"; released: number };

  const outcome = writeTransaction(db, (): ClearTaskOutcome => {
    if (!getSegment(db, segmentId)) {
      return { kind: "missing" };
    }
    const lanes = listLanesForSegment(db, segmentId);
    if (lanes.length > 0) {
      return { kind: "has-lanes", tags: lanes.map((lane) => lane.tag) };
    }
    return { kind: "cleared", released: clearSegmentMembers(db, segmentId, nowEpoch) };
  });

  if (outcome.kind === "missing") {
    return parameterError(`E${segmentId} no longer exists.`);
  }
  if (outcome.kind === "has-lanes") {
    return parameterError(
      `E${segmentId} still declares ${outcome.tags.length} lane(s) (${outcome.tags.join(", ")}) — ` +
        "clear refuses while any lane remains declared; clear or merge each one first.",
    );
  }
  return textResult(
    `Cleared E${segmentId} — ${outcome.released} member turn(s) released. ` +
      `remember(delete, id="E${segmentId}") removes it once empty.`,
  );
}

/**
 * `remember`'s `merge` verb, LANE tier ([S15069/T1697]): folds one declared
 * lane into another — `tag` ceases to exist, `into` absorbs its members and
 * its edge sides. Reached whenever the call carries a `tag` — a call with no
 * `tag` routes to the TASK tier instead (`handleMergeTask`, container-
 * unification ticket 08, spec D6); the two tiers share the `merge` verb and
 * the `into` parameter but nothing else about their addressing, since this
 * tier's `id` is the ONE segment housing both lanes rather than the address
 * of the container that goes away.
 *
 * It exists because `delete` alone cannot retire a lane that was ever used.
 * Delete refuses while a member turn carries the tag, and clearing those
 * tags by hand is not a workaround: the lane's own edges still name the
 * word on their sides, so the moment the members stop carrying it the checker
 * reports a subset violation on every one of them, and the moment the lane
 * leaves the registry it reports an undeclared-lane violation too. `merge`
 * moves all three populations — the turns' tags, the edges' sides, the
 * registry row — inside ONE transaction, which is the only ordering that
 * never leaves the graph describing a lane that is half gone.
 *
 * The whole mechanism is `db/lanes.ts`'s `mergeLaneTag`, already built and
 * already used by settlement's own membership facade; this verb is the hand
 * operated door onto it, because curating a segment's lane vocabulary is a
 * judgment a person makes while looking at the roster, not something to wait
 * for a settlement window to decide on its own.
 *
 * BOTH lanes are re-checked INSIDE the write transaction, the same discipline
 * lane-tier `create`/`delete` follow: a concurrent delete must not be able
 * to land between "both exist" and the merge.
 */
function handleMergeLane(
  db: Database,
  input: RememberToolInput,
  options: RememberToolOptions,
): ToolTextResult {
  const preamble = resolveLaneVerbPreamble(db, input, "merge");
  if (!preamble.ok) {
    return preamble.result;
  }
  const { segment, tag: from } = preamble;

  if (typeof input.into !== "string" || input.into === "") {
    return parameterError(
      'into is required for merge — the SURVIVING lane\'s tag. `tag` names the lane that goes away.',
    );
  }
  const canonicalInto = checkCanonicalLaneTag(input.into);
  if (!canonicalInto.ok) {
    return parameterError(canonicalInto.message);
  }
  const into = input.into;
  if (into === from) {
    return parameterError(
      `merge needs two different lanes — "${from}" was named as both the one folded away and the survivor.`,
    );
  }

  const nowEpoch = options.now?.() ?? Math.floor(Date.now() / 1000);
  const writeTransaction = options.runWriteTransaction ?? runWriteTransaction;

  type MergeOutcome =
    | { kind: "no-from" }
    | { kind: "no-into" }
    | { kind: "merged"; receipt: LaneMergeReceipt };

  const outcome = writeTransaction(db, (): MergeOutcome => {
    if (!getLane(db, segment.id, from)) {
      return { kind: "no-from" };
    }
    if (!getLane(db, segment.id, into)) {
      return { kind: "no-into" };
    }
    return { kind: "merged", receipt: mergeLaneTag(db, segment.id, from, into, nowEpoch) };
  });

  if (outcome.kind === "no-from") {
    return parameterError(
      `E${segment.id} has no declared lane "${from}" — merge folds a DECLARED lane away.`,
    );
  }
  if (outcome.kind === "no-into") {
    return parameterError(
      `E${segment.id} has no declared lane "${into}" — merge folds INTO a declared lane; ` +
        "declare it first, or name one that already exists.",
    );
  }

  const { receipt } = outcome;
  // Every number the receipt carries, named. A merge is irreversible and
  // moves three populations at once, so an operator running a batch of them
  // by hand needs to see what each one actually touched — a bare "done" would
  // hide a lane that turned out to be empty, or a collision that deleted a row.
  const lines = [
    `Merged E${segment.id}'s lane "${from}" into "${into}".`,
    `  member turns retagged: ${receipt.turnsRetagged}` +
      (receipt.turnsDeduplicated > 0
        ? ` (${receipt.turnsDeduplicated} already carried "${into}", so the word was dropped there, not renamed)`
        : ""),
    `  edge sides rewritten: ${receipt.edgeSidesRewritten}`,
  ];
  if (receipt.collisions.length > 0) {
    lines.push(
      `  identity-key collisions folded: ${receipt.collisions.length} row(s) deleted — the rewrite landed them on a surviving row's key:`,
    );
    for (const collision of receipt.collisions) {
      lines.push(
        `    ${collision.citingAddress} —${collision.relation ?? "(bare)"}→ ${collision.citedAddress} ` +
          `{${collision.tailTag}→${collision.headTag}}`,
      );
    }
  }
  // lane-merge-skip-receipt ticket 01: a turn whose own `tags` disagree with
  // `segment_members` about who a member is falls outside the member query
  // and the fold never touches it — silent otherwise, since a bare "done"
  // would read identical to a merge that moved everything. Zero is the
  // ordinary case and stays unprinted.
  if (receipt.stillCarrying.length > 0) {
    const ADDRESS_CAP = 10;
    lines.push(
      `  ${receipt.stillCarrying.length} turn(s) still carry "${from}" — they are not members of E${segment.id}, so the merge did not touch them:`,
    );
    for (const address of receipt.stillCarrying.slice(0, ADDRESS_CAP)) {
      lines.push(`    ${address}`);
    }
    if (receipt.stillCarrying.length > ADDRESS_CAP) {
      lines.push(`    … +${receipt.stillCarrying.length - ADDRESS_CAP} more`);
    }
  }
  return textResult(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// merge — TASK tier (container-unification ticket 08, spec D6)
// ---------------------------------------------------------------------------

/**
 * `merge`'s TWO tiers share one verb and one `into` parameter but address
 * their target differently — the pre-existing LANE tier's `id` names the ONE
 * segment housing both lanes, with the lane that goes away in `tag` and the
 * survivor in `into` (`handleMergeLane`, unchanged by this ticket); the TASK
 * tier this ticket adds has no `tag` at all — `id` names the TASK that goes
 * away, `into` names the task address it hands everything to. A `tag` present
 * on the call is therefore the whole disambiguator: every existing lane-merge
 * caller already sends one (`tests/mcp/remember.test.ts`'s own fixtures), so
 * routing on its presence changes no existing behavior.
 */
function handleMerge(
  db: Database,
  input: RememberToolInput,
  options: RememberToolOptions,
): ToolTextResult {
  if (input.tag !== undefined && input.tag !== null) {
    return handleMergeLane(db, input, options);
  }
  return handleMergeTask(db, input, options);
}

/**
 * Parses a `merge`-task-tier address (`id` or `into`) into a resolved
 * segment, naming the OFFENDING FIELD rather than borrowing
 * `resolveSegmentTarget`'s own "id must be…" wording — that function's
 * message hardcodes "id", which would misname the problem when the bad value
 * actually came from `into`.
 */
function resolveMergeTaskAddress(
  db: Database,
  raw: string,
  fieldName: "id" | "into",
): SegmentTargetResolution {
  const trimmed = raw.trim();
  const bareRef = parseBareAddressReference(trimmed);
  if (!bareRef || bareRef.kind !== "segment") {
    return {
      ok: false,
      message: `${fieldName} must be a task address ("E<n>") — got "${trimmed}".`,
    };
  }
  const segment = getSegment(db, bareRef.segmentId);
  if (!segment) {
    return { ok: false, message: `no task E${bareRef.segmentId}.` };
  }
  return { ok: true, segment };
}

/**
 * `remember(merge)`'s TASK tier (container-unification ticket 08, spec D6):
 * `id` names the task that goes away, `into` the task it hands its members
 * and lanes to. The whole mechanism is `db/segments.ts`'s `mergeSegments` —
 * this handler is only the surrounding shell every task/lane verb in this
 * file shares: both addresses parsed and resolved, `into` re-checked OPEN
 * (merge writes new members and lanes into it, the same "closed refuses a
 * write" rule lane-tier `create`/`retag`/`clear`/`merge` already apply to
 * their own single segment), all of it re-verified INSIDE the write
 * transaction so a concurrent close/delete cannot land between the checks
 * and the merge.
 *
 * `from` itself is NOT required to be open — the same permissiveness
 * `delete`'s task tier already has (`handleDeleteTask`'s own doc comment):
 * `from` is being consumed and, on success, ceases to exist, so gating that
 * behind reopening it first would be pure friction.
 *
 * Fields, `type`, write-gate stamps and `into`'s FTS reindex (ticket 09) and
 * the same-name lane collision branch with `force` (ticket 10) are all
 * `mergeSegments`'s own job (spec D6/D7/D8, its own doc comment) — this
 * handler is only the surrounding shell: both addresses parsed and
 * resolved, `force` validated, the caller's writer identity resolved for
 * the field stamps, `into` re-checked OPEN, all of it re-verified INSIDE the
 * write transaction. Without `force` a collision is reported and the WHOLE
 * merge refuses, naming every colliding tag; `force` does not suppress that
 * list — it is never rendered at all on the branch `force` takes, since
 * that branch never refuses.
 */
function handleMergeTask(
  db: Database,
  input: RememberToolInput,
  options: RememberToolOptions,
): ToolTextResult {
  if (typeof input.id !== "string" || input.id.trim() === "") {
    return parameterError(
      'id is required for merge — an "E<n>" task address (the task that goes away); pass `tag` instead ' +
        "for a lane merge within one task.",
    );
  }
  const fromResolution = resolveMergeTaskAddress(db, input.id, "id");
  if (!fromResolution.ok) {
    return parameterError(fromResolution.message);
  }

  if (typeof input.into !== "string" || input.into.trim() === "") {
    return parameterError('into is required for merge — the SURVIVING task\'s "E<n>" address.');
  }
  const intoResolution = resolveMergeTaskAddress(db, input.into, "into");
  if (!intoResolution.ok) {
    return parameterError(intoResolution.message);
  }

  const fromId = fromResolution.segment.id;
  const intoId = intoResolution.segment.id;
  if (fromId === intoId) {
    return parameterError(
      `merge needs two different tasks — E${fromId} was named as both the one that goes away and the survivor.`,
    );
  }

  if (input.force !== undefined && typeof input.force !== "boolean") {
    return parameterError("force must be a boolean when present.");
  }
  const force = input.force === true;

  const nowEpoch = options.now?.() ?? Math.floor(Date.now() / 1000);
  const writeTransaction = options.runWriteTransaction ?? runWriteTransaction;
  const writer = callerWriterId(options.callerSessionId);

  type MergeTaskHandlerOutcome =
    | { kind: "no-from" }
    | { kind: "no-into" }
    | { kind: "into-closed" }
    | SegmentMergeOutcome;

  const outcome = writeTransaction(db, (): MergeTaskHandlerOutcome => {
    if (!getSegment(db, fromId)) {
      return { kind: "no-from" };
    }
    const into = getSegment(db, intoId);
    if (!into) {
      return { kind: "no-into" };
    }
    if (into.status === "closed") {
      return { kind: "into-closed" };
    }
    return mergeSegments(db, fromId, intoId, nowEpoch, { force, writer });
  });

  if (outcome.kind === "no-from") {
    return parameterError(`E${fromId} no longer exists.`);
  }
  if (outcome.kind === "no-into") {
    return parameterError(`E${intoId} no longer exists.`);
  }
  if (outcome.kind === "into-closed") {
    return parameterError(
      `E${intoId} is closed — merge writes new members and lanes into an open task only; ` +
        `remember(close, id="E${intoId}") reopens it.`,
    );
  }
  if (outcome.kind === "lane-collision") {
    return parameterError(
      `E${fromId} and E${intoId} both declare lane(s) ${outcome.tags.map((tag) => `"${tag}"`).join(", ")} — ` +
        'merge refuses on a same-name collision; rename one side first (remember(retag, id="E<n>/#<tag>", ' +
        'tag="…")) and merge again.',
    );
  }
  if (outcome.kind === "members-blocked") {
    return parameterError(outcome.message);
  }

  const { receipt } = outcome;
  const lines = [
    `Merged E${fromId} into E${intoId} — E${fromId} no longer exists. ` +
      `member turns handed over: ${receipt.membersMoved}. lane(s) handed over: ${receipt.lanesMoved}.`,
  ];
  // lane-merge-skip-receipt ticket 01, criterion 4: the same hole as the
  // lane tier above, reviewed and fixed the same way — a turn whose own tag
  // disagrees with `segment_members` falls outside population 2's member
  // query and is never moved. Zero is the ordinary case and stays unprinted.
  if (receipt.stillCarrying.length > 0) {
    const ADDRESS_CAP = 10;
    lines.push(
      `  ${receipt.stillCarrying.length} turn(s) still carry E${fromId}'s task tag — they were never members, so the merge did not move them to E${intoId}:`,
    );
    for (const address of receipt.stillCarrying.slice(0, ADDRESS_CAP)) {
      lines.push(`    ${address}`);
    }
    if (receipt.stillCarrying.length > ADDRESS_CAP) {
      lines.push(`    … +${receipt.stillCarrying.length - ADDRESS_CAP} more`);
    }
  }
  return textResult(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * `remember` — the segment (semantic) write surface, revived beside `note`
 * (episodic) per ADR-0002. TEN verbs, one tool: `create` (container-
 * unification ticket 05) mints a container, TIER chosen by `id` — omitted
 * mints a TASK from the roster the caller has in view, an "E<n>/#<tag>"
 * address mints a LANE inside an existing one; `attach` binds the current
 * session to a task and returns its fields — called bare, it returns the
 * pick list instead (ticket 17); `detach` cancels a binding; `write`/`edit`
 * (ticket 05 of write-mode-edit-semantics) maintain one named field (Working
 * State, or content/insight) — `write` replaces it whole, `edit` swaps an
 * exactly-matched span within it; `close` toggles the segment off (or back
 * onto) the roster; `retag` NAMES a container, tier chosen by `id` the same
 * way `create` is (ticket 14 at the segment tier, container-unification
 * ticket 04 at the lane tier); `delete` (container-unification ticket 06,
 * the retired `undeclare`'s own replacement) removes an EMPTY container,
 * tier chosen the same way — a task with no members and no declared lane, or
 * a lane with no member turn; `clear` (container-unification ticket 07, spec
 * D5/D5b) UN-HOMES a container without deleting it — a lane drops its tag
 * off every member and deletes the edges resolved to it, a task refuses
 * while it still declares a lane and otherwise drops its own tag off every
 * member — so `delete` becomes reachable for a container that was ever
 * used; `merge` ([S15069/T1697]) folds one declared lane into another.
 *
 * Ticket 14 (lane-model-v12 spec D3e): `assign` is gone, and with it the last
 * explicit membership verb. A turn belongs to whichever segment's tag its own
 * `tags` carry, so naming the container IS the whole of `retag`'s job, and
 * joining it is a `note` write. The two vocabularies still never overlap
 * (lane-tier `create` refuses the segment's own tag, `retag` refuses a
 * declared lane), and the segment tag is unique across ALL segments, because
 * that is what makes "which segment's tag is this" answerable.
 */
/** The one shape every handler's rejection takes — see `parameterError` above. */
function isParameterError(result: ToolTextResult): boolean {
  return result.content[0]?.text.startsWith("Parameter error:") ?? false;
}

export function rememberTool(
  db: Database,
  rawInput: RememberToolInput,
  options: RememberToolOptions = {},
): ToolTextResult {
  if (typeof rawInput.verb !== "string") {
    return parameterError(`verb must be one of ${REMEMBER_VERBS.join(", ")}.`);
  }
  // Ticket 05 (spec D14): checked before the closed-vocabulary membership
  // test below, so a retired verb gets its replacement named instead of the
  // generic "verb must be one of ..." list.
  const retiredReplacement = RETIRED_REMEMBER_VERB_REPLACEMENT[rawInput.verb];
  if (retiredReplacement) {
    return parameterError(`verb "${rawInput.verb}" has retired — ${retiredReplacement}`);
  }
  if (!REMEMBER_VERBS.includes(rawInput.verb as RememberVerb)) {
    return parameterError(`verb must be one of ${REMEMBER_VERBS.join(", ")}.`);
  }

  const result = ((): ToolTextResult => {
    switch (rawInput.verb as RememberVerb) {
      case "create":
        return handleCreate(db, rawInput, options);
      case "attach":
        return handleAttach(db, rawInput, options);
      case "detach":
        return handleDetach(db, rawInput, options);
      case "write":
        return handleWrite(db, rawInput, options);
      case "edit":
        return handleEdit(db, rawInput, options);
      case "close":
        return handleClose(db, rawInput, options);
      case "retag":
        return handleRetag(db, rawInput, options);
      case "delete":
        return handleDelete(db, rawInput, options);
      case "clear":
        return handleClear(db, rawInput, options);
      case "merge":
        return handleMerge(db, rawInput, options);
    }
  })();

  // Ticket 09 (spec "write-mode-edit-semantics"): only a successful
  // FIELD-WRITING call resets the universal 20-turn `remember` check
  // (hooks/note-reminder.ts renders it off `sessions.last_remember_turn_id` —
  // a turn ROW ID anchor, 0.12.1: epochs cannot order same-second turns).
  // `attach`/`detach`/`close` bind or toggle a segment without touching any of its
  // fields, so a session that only ever calls those still gets nudged after
  // 20 turns — narrower than ticket 13's original "any of the six verbs,"
  // which reset the clock even for a session that never wrote a field.
  // "Since last remember call" is a session-scoped fact no existing column
  // carries — create/close do not attribute a caller session on their own
  // write paths at all — so this is the one new column
  // ticket 13 added. A parameter-error call is not a "call" for this
  // purpose either: nothing was checked or written, so a rejected attempt
  // must not reset the clock.
  if (
    typeof options.callerSessionId === "number" &&
    !isParameterError(result) &&
    isFieldWritingVerb(rawInput.verb as RememberVerb)
  ) {
    touchSessionRememberActivity(db, options.callerSessionId);
  }

  return result;
}
