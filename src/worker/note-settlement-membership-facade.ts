import { z } from "zod";
import type { Database } from "bun:sqlite";

import { recordNoteSettlementProposal } from "../db/note-settlement-proposals";
import { parseBareAddressReference, validateReferences } from "../db/references";
import {
  attachSegmentToSession,
  createSegment,
  getSegment,
  reassignSegmentMembers,
} from "../db/segments";
import type { SettlementTurnFacadeContext } from "./note-settlement-turn-facade";

/**
 * The settlement membership facade (ownership-and-note-cadence spec, "所有权"
 * section — ticket 05, "settlement demolition").
 *
 * Settlement's `assign` action is DEAD. Before this ticket, `assign` let
 * settlement join a turn to one of the session's attached segments; the
 * ownership redesign hands membership to the main agent as a first-hand
 * write (through `remember`'s own `assign` verb — a DIFFERENT tool, the
 * main-agent-facing one, unaffected by this file), and settlement's own
 * membership CORRECTION path (reassign to an already-attached segment, or to
 * no attachment) is future work, not built here — it goes through the
 * turn-write facade's staged-commit channel once it exists, not through a
 * revived `remember(assign)` on this facade.
 *
 * `propose` is one surviving verb (spec: "propose 在退役潮里唯一存活的形
 * 态") — several homeless turns that read as one task become a TEXT-ONLY
 * suggestion (`db/note-settlement-proposals.ts`) for the user to confirm next
 * session; never a segment row, never auto-adopted, and — as of this ticket —
 * never a completion condition (the retired membership gate used to require
 * one `assign`/`propose` call per session with attached segments; that gate
 * is gone, see `db/note-settlement-completion.ts`'s module doc comment).
 * `addresses`' floor drops from 2 to 1 (spec: "最小簇 1，修订现行 ≥2——孤立
 * turn 独自开启新任务是合法情形") — a single homeless turn opening its own
 * proposed task is now legal, not just a multi-turn cluster.
 *
 * TICKET 04 (edge-mechanism-revision D6, "归属动作开放"): the membership half
 * reaches parity with the main agent. `create` joins the verb list, and
 * `reassign`'s VALUE DOMAIN — "this session's already-attached segments ∪
 * homeless", ticket 08's restriction below — is DELETED: any segment that
 * exists and is open is a legal target, which is what "跨段改派" means. The
 * judgment that replaces it is not code but the shared Memory Rubric's own 段
 * section ("只纠显性失配,存疑不动"), read by both writers.
 *
 * `create` ATTACHES the new segment to this dispatch's session as part of the
 * same call, unlike the main agent's own `create` (which leaves attachment to
 * a separate `attach` verb). Settlement has no live session to attach from
 * later, and the rubric tells it to check the ROSTER before minting a segment
 * — a created segment that never joined that roster would be invisible to the
 * next window and to the main agent's SessionStart, which would make the rule
 * unfollowable.
 *
 * TICKET 08 (edge-ownership-impl, "settlement four-field check-and-correct"):
 * `reassign` joins `propose` as the second legal `action` — the
 * MEMBERSHIP-CORRECTION path the ownership-and-note-cadence spec's own
 * "所有权" section reserves for settlement ([S15069/T912]/[T913]): "纠错走既
 * 有 staged-commit 通道…值域=该会话已挂靠段 ∪ 无归属，越界拒绝并报出该段不在
 * 挂靠集合". `reassign` is deliberately NOT named `assign` — that verb is
 * retired (ticket 05) and stays retired; this is a narrower, RE-CHECK-only
 * primitive with a restricted domain, not its revival. It reuses `db/
 * segments.ts`'s `reassignSegmentMembers` (ticket 02's single-home write
 * primitive) directly: every turn named is first evicted from wherever it
 * currently lives, then (if `id` is given) added to the target — one
 * transaction, single ownership enforced by the write. The legal domain is
 * this session's own roster ∪ homeless (`id` omitted) — a restriction ticket
 * 04 has since deleted; see the paragraph above.
 *
 * Registered under the tool name `remember` (not `segment`) in
 * note-settlement-sdk-query.ts — the settlement subagent uses the same tool
 * quartet as the main agent (note, remember, timeline, recall), not a
 * dedicated facade set. The shape here is settlement's own restricted
 * schema, the same relationship this project's `note` facade already has to
 * the main agent's `note` tool (one tool NAME shared across both callers, a
 * caller-specific shape).
 */

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

export const settlementMembershipWriteInputShape = {
  /**
   * `assign` is dead (ticket 05) and stays dead — kept out of this enum
   * entirely (not merely refused downstream) so a stale caller gets zod's
   * own "invalid enum value" rejection naming the legal verbs. `propose` is
   * the text-only exception channel; `reassign` (ticket 08) moves turns
   * between segments; `create` (ticket 04) mints one, which is what makes
   * "attach to an existing segment, or open the right one" a decision
   * settlement can actually carry out.
   */
  action: z.enum(["propose", "reassign", "create"]),
  /** propose only, required — at least one "S<session>/T<prompt>" turn address; this call's staging key. */
  addresses: z.array(z.string()).optional(),
  /** propose/create, required — the cluster's suggested title (propose) or the new segment's own (create). */
  title: z.string().optional(),
  /** reassign (required) / create (optional seed members) — "S<session>/T<prompt>" turn addresses; this call's staging key. */
  turns: z.array(z.string()).optional(),
  /** reassign only, optional — the target segment ("E<n>"); omit to clear ownership (homeless). */
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
  /** `propose`: the stored proposal's id (the EARLIER one, on a duplicate — see `proposeAlreadyExisted`). `null` for a `reassign` or `create` outcome. */
  proposalId: number | null;
  /**
   * `propose` only (ticket 05, spec "propose 携幂等键") — true when this
   * call's canonical address set already matched an earlier stored proposal
   * for this session, so `proposalId` names that EARLIER row rather than a
   * new one. `undefined` for a `reassign` or `create` outcome, the same
   * "absent means not this verb's concern" convention `reassign` itself
   * already uses below.
   */
  proposeAlreadyExisted?: boolean;
  /** `propose`: addresses accepted. `reassign`: turns accepted — same "how many address tokens resolved" meaning either way. */
  addressesResolved: number;
  /**
   * Present ONLY for a `reassign` outcome (ticket 08) — `undefined` for
   * `propose`, so every existing `propose` fixture/receipt (pre-ticket-08)
   * stays exactly as it was rather than gaining a phantom field.
   */
  reassign?: {
    /** `null` = reassigned to no segment (homeless). */
    targetSegmentId: number | null;
    /** The segment(s) these turns were removed from, excluding the target itself. */
    vacatedSegmentIds: number[];
    /** Turn ids actually linked to the target — empty when `targetSegmentId` is null. */
    addedTurnIds: number[];
  };
  /** Present ONLY for a `create` outcome (ticket 04). */
  create?: {
    segmentId: number | null;
    title: string;
    /** Seed members actually linked — empty when none were named. */
    memberTurnIds: number[];
  };
}

export type SettlementMembershipWriteEvaluation =
  | { ok: true; outcome: SettlementMembershipWriteOutcome }
  | { ok: false; message: string };

/**
 * Turn addresses -> turn ids, de-duplicated, with one rejection line per bad
 * address. Shared by `reassign` and `create` (ticket 04) so both apply the
 * SAME window scope: an address this prompt never rendered is refused, because
 * rendering is what authorizes a write to a turn — a segment seeded from a
 * turn the model only imagined would be worse than no segment at all.
 */
function resolveTurnAddresses(
  db: Database,
  context: SettlementTurnFacadeContext,
  rawTurns: readonly string[],
): { turnIds: number[]; rejections: string[] } {
  const rejections: string[] = [];
  const turnIds: number[] = [];
  const seen = new Set<number>();
  for (const raw of rawTurns) {
    const parsed = parseBareAddressReference(raw);
    if (!parsed || parsed.kind !== "turn") {
      rejections.push(`"${raw}" is not a valid turn address`);
      continue;
    }
    const { accepted } = validateReferences(db, [parsed], {
      writerSessionId: context.sessionId,
      logger: context.logger,
    });
    const node = accepted[0]?.node;
    if (!node) {
      rejections.push(`"${raw}" does not resolve to a turn`);
      continue;
    }
    if (!context.reviewableTurnIds.has(node.id)) {
      rejections.push(`"${raw}" is outside this dispatch's reviewable window`);
      continue;
    }
    if (!seen.has(node.id)) {
      seen.add(node.id);
      turnIds.push(node.id);
    }
  }
  return { turnIds, rejections };
}

function evaluatePropose(
  db: Database,
  context: SettlementTurnFacadeContext,
  rawInput: SettlementMembershipWriteInput,
  nowEpoch: number,
): SettlementMembershipWriteEvaluation {
  if (!rawInput.title || rawInput.title.trim() === "") {
    return { ok: false, message: "propose requires title, a short suggested name for the cluster." };
  }
  const rawAddresses = rawInput.addresses ?? [];
  if (rawAddresses.length < 1) {
    return {
      ok: false,
      message:
        "propose requires addresses, at least one turn address — a lone homeless turn " +
        "may open its own proposed task; a cluster of several is just as legal.",
    };
  }

  const rejections: string[] = [];
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawAddresses) {
    const parsed = parseBareAddressReference(raw);
    if (!parsed || parsed.kind !== "turn") {
      rejections.push(`"${raw}" is not a valid turn address`);
      continue;
    }
    const { accepted } = validateReferences(db, [parsed], {
      writerSessionId: context.sessionId,
      logger: context.logger,
    });
    const node = accepted[0]?.node;
    if (!node) {
      rejections.push(`"${raw}" does not resolve to a turn`);
      continue;
    }
    if (!context.reviewableTurnIds.has(node.id)) {
      rejections.push(`"${raw}" is outside this dispatch's reviewable window`);
      continue;
    }
    const key = `S${parsed.sessionId}/T${parsed.promptNumber}`;
    if (!seen.has(key)) {
      seen.add(key);
      refs.push(key);
    }
  }

  if (rejections.length > 0) {
    return {
      ok: false,
      message:
        `addresses rejected: ${rejections.join("; ")} — a proposal is recorded for exactly ` +
        "the addresses given, so a call naming even one bad address stores none.",
    };
  }
  if (refs.length < 1) {
    return {
      ok: false,
      message: "propose requires at least one DISTINCT turn address after de-duplication.",
    };
  }

  // Ticket 05 (spec "propose 携幂等键"): keyed on session + the canonical
  // address set, NOT this job — a re-claimed job after a lost lease is a
  // NEW job id, so a job-scoped key could never dedupe the retry. A
  // duplicate call lands on the SAME row (`alreadyExisted: true`) instead
  // of a second one.
  const stored = recordNoteSettlementProposal(db, {
    jobId: context.jobId,
    sessionId: context.sessionId,
    title: rawInput.title,
    addresses: refs,
    nowEpoch,
  });

  return {
    ok: true,
    outcome: {
      proposalId: stored.record.id,
      proposeAlreadyExisted: stored.alreadyExisted,
      addressesResolved: refs.length,
    },
  };
}

/**
 * `reassign` (ticket 08): a RE-CHECK, not a first assignment — the main
 * agent already placed every turn, this only corrects a mis-homing. Reuses
 * `db/segments.ts`'s `reassignSegmentMembers` (ticket 02's single-home write
 * primitive) directly, so a corrected turn is evicted from wherever it
 * currently lives and (if `id` is given) added to the target in one
 * transaction — the identical single-ownership guarantee the main agent's
 * own `remember(assign)` verb gets, on a narrower domain.
 *
 * Ticket 04 (edge-mechanism-revision D6, "跨段改派"): the DOMAIN restriction —
 * this session's attached segments ∪ homeless — is DELETED. Any segment that
 * exists and is still open may receive these turns, whichever session it was
 * attached to, because a mis-homed turn's right home is frequently a segment
 * this session never attached (that is precisely what "cross-segment" means).
 * What survives is the CLOSED refusal below, which is not a domain rule: a
 * closed segment is off the board for every writer, settlement included, and
 * ticket 05's "渲染后被 detach/close 的段不可再收成员" is about the segment's
 * own lifecycle rather than about settlement's reach.
 */
function evaluateReassign(
  db: Database,
  context: SettlementTurnFacadeContext,
  rawInput: SettlementMembershipWriteInput,
  nowEpoch: number,
): SettlementMembershipWriteEvaluation {
  const rawTurns = rawInput.turns ?? [];
  if (rawTurns.length < 1) {
    return {
      ok: false,
      message: "reassign requires turns, at least one turn address to correct.",
    };
  }

  let targetSegmentId: number | null = null;
  if (rawInput.id !== undefined) {
    const parsedTarget = parseBareAddressReference(rawInput.id);
    if (!parsedTarget || parsedTarget.kind !== "segment") {
      return {
        ok: false,
        message: `id must be an "E<n>" segment address; got "${rawInput.id}".`,
      };
    }
    // Ticket 05 (spec: "渲染后被 detach/close 的段不可再收成员"), a LIVE read
    // on every call: a segment closed since the roster
    // was rendered must refuse a new member the same way `remember`'s own
    // append/replace already refuse one, for the same reason. A segment that
    // does not exist at all is refused by the same statement, naming that.
    const targetSegment = getSegment(db, parsedTarget.segmentId);
    if (!targetSegment) {
      return {
        ok: false,
        message: `E${parsedTarget.segmentId} does not exist — reassign names an existing segment, or omit id for homeless.`,
      };
    }
    if (targetSegment.status === "closed") {
      return {
        ok: false,
        message:
          `E${parsedTarget.segmentId} is closed — settlement may not reassign a turn onto a ` +
          "closed segment; reopen it or choose another home.",
      };
    }
    targetSegmentId = parsedTarget.segmentId;
  }

  const { turnIds, rejections } = resolveTurnAddresses(db, context, rawTurns);

  if (rejections.length > 0) {
    return {
      ok: false,
      message:
        `turns rejected: ${rejections.join("; ")} — a reassignment is recorded for exactly ` +
        "the turns given, so a call naming even one bad address reassigns none.",
    };
  }
  if (turnIds.length < 1) {
    return {
      ok: false,
      message: "reassign requires at least one DISTINCT turn address after de-duplication.",
    };
  }

  const result = reassignSegmentMembers(db, turnIds, targetSegmentId, nowEpoch);
  return {
    ok: true,
    outcome: {
      proposalId: null,
      addressesResolved: turnIds.length,
      reassign: {
        targetSegmentId,
        vacatedSegmentIds: result.vacatedSegmentIds,
        addedTurnIds: result.addedTurnIds,
      },
    },
  };
}

/**
 * `create` (ticket 04, edge-mechanism-revision D6): mint a segment for work
 * that has no home yet. Same primitives the main agent's own `create` uses —
 * `createSegment` for the row, `reassignSegmentMembers` (never
 * `addSegmentMembers` directly) for the seed members, so a seeded turn is
 * evicted from wherever it currently lives and single ownership holds through
 * one path rather than two.
 *
 * The one deliberate difference: this ALSO attaches the new segment to this
 * dispatch's session. See the module doc comment for why — settlement has no
 * later `attach` call available to it, and an unattached segment never reaches
 * the roster the rubric tells it to consult first.
 */
function evaluateCreate(
  db: Database,
  context: SettlementTurnFacadeContext,
  rawInput: SettlementMembershipWriteInput,
  nowEpoch: number,
): SettlementMembershipWriteEvaluation {
  const title = rawInput.title?.trim() ?? "";
  if (title === "") {
    return {
      ok: false,
      message: "create requires title, the new segment's own name — write it for the task's actual shape.",
    };
  }

  const { turnIds, rejections } = resolveTurnAddresses(db, context, rawInput.turns ?? []);
  if (rejections.length > 0) {
    return {
      ok: false,
      message:
        `turns rejected: ${rejections.join("; ")} — a segment is seeded with exactly ` +
        "the turns given, so a call naming even one bad address seeds none.",
    };
  }

  const segment = createSegment(db, { title, nowEpoch });
  attachSegmentToSession(db, context.sessionId, segment.id, nowEpoch);
  const memberTurnIds =
    turnIds.length > 0
      ? reassignSegmentMembers(db, turnIds, segment.id, nowEpoch).addedTurnIds
      : [];

  return {
    ok: true,
    outcome: {
      proposalId: null,
      addressesResolved: turnIds.length,
      create: { segmentId: segment.id, title, memberTurnIds },
    },
  };
}

/**
 * The settlement membership facade's whole decision — dispatches on `action`
 * (ticket 04 widens ticket 08's pair to `propose` | `reassign` | `create`; the
 * zod shape already refuses any fourth value before this runs).
 */
export function evaluateSettlementMembershipWrite(
  db: Database,
  context: SettlementTurnFacadeContext,
  rawInput: SettlementMembershipWriteInput,
  nowEpoch: number,
): SettlementMembershipWriteEvaluation {
  if (rawInput.action === "reassign") {
    return evaluateReassign(db, context, rawInput, nowEpoch);
  }
  if (rawInput.action === "create") {
    return evaluateCreate(db, context, rawInput, nowEpoch);
  }
  return evaluatePropose(db, context, rawInput, nowEpoch);
}

/**
 * Render one membership-write outcome as tool-result text.
 *
 * Ticket 11: the `staged`/`replaced` options retired with the staging engine
 * that was their only source (`renderSettlementTurnWriteReceipt` lost the same
 * pair). Every membership write has already landed by the time this renders,
 * so "Landed" is the only honest verb and "(pending commit)" no longer has a
 * caller that could truthfully ask for it.
 */
export function renderSettlementMembershipWriteReceipt(
  outcome: SettlementMembershipWriteOutcome,
): string {
  const verb = "Landed";
  if (outcome.create) {
    const { segmentId, title, memberTurnIds } = outcome.create;
    return (
      `${verb} create: ${segmentId !== null ? `E${segmentId}` : "a new segment"} "${title}"` +
      `, attached to this session, ` +
      `${memberTurnIds.length || outcome.addressesResolved} member(s) seeded.`
    );
  }
  if (outcome.reassign) {
    const { targetSegmentId, vacatedSegmentIds, addedTurnIds } = outcome.reassign;
    const destination = targetSegmentId !== null ? `E${targetSegmentId}` : "homeless (no segment)";
    const vacatedNote =
      vacatedSegmentIds.length > 0
        ? `, vacated ${vacatedSegmentIds.map((id) => `E${id}`).join(",")}`
        : "";
    return (
      `${verb} reassign: ${outcome.addressesResolved} turn(s) -> ${destination}` +
      `${vacatedNote}, ${addedTurnIds.length} linked.`
    );
  }
  const duplicateNote = outcome.proposeAlreadyExisted
    ? " — already exists (matches an earlier proposal for the same turns; no second row created)"
    : "";
  return (
    `${verb} propose: ${outcome.addressesResolved} address(es)` +
    `${outcome.proposalId !== null ? ` as proposal #${outcome.proposalId}` : ""} — creates no segment.${duplicateNote}`
  );
}
