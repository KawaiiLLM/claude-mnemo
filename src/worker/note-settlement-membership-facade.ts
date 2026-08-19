import { z } from "zod";
import type { Database } from "bun:sqlite";

import { recordNoteSettlementProposal } from "../db/note-settlement-proposals";
import { parseBareAddressReference, validateReferences } from "../db/references";
import { getAttachedSegmentIds, getSegment, reassignSegmentMembers } from "../db/segments";
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
 * TICKET 08 (edge-ownership-impl, "settlement four-field check-and-correct"):
 * `reassign` joins `propose` as the second (and last) legal `action` — the
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
 * `context.attachedSegmentIds` (this session's own roster) ∪ homeless (`id`
 * omitted) — naming any OTHER segment is refused, naming the segment as not
 * attached; attaching a brand-new segment to the session stays the main
 * agent's call alone (`remember`'s own `assign` verb, a different tool
 * registration entirely).
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
   * own "invalid enum value" rejection naming the two legal verbs. `propose`
   * is the text-only exception channel; `reassign` (ticket 08) is the
   * restricted membership-CORRECTION primitive.
   */
  action: z.enum(["propose", "reassign"]),
  /** propose only, required — at least one "S<session>/T<prompt>" turn address; this call's staging key. */
  addresses: z.array(z.string()).optional(),
  /** propose only, required — a short suggested title for the cluster, shown to the user next session. */
  title: z.string().optional(),
  /** reassign only, required — one or more "S<session>/T<prompt>" turn addresses to correct; this call's staging key. */
  turns: z.array(z.string()).optional(),
  /** reassign only, optional — the target segment ("E<n>"), drawn from this session's roster; omit to clear ownership (homeless). */
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
  /** `propose`: the stored proposal's id (the EARLIER one, on a duplicate — see `proposeAlreadyExisted`). `null` for a dry run or a `reassign` outcome. */
  proposalId: number | null;
  /**
   * `propose` only (ticket 05, spec "propose 携幂等键") — true when this
   * call's canonical address set already matched an earlier stored proposal
   * for this session, so `proposalId` names that EARLIER row rather than a
   * new one. `undefined` for a dry run (nothing is looked up without
   * `apply`) and for a `reassign` outcome, same "absent means not this
   * verb's concern" convention `reassign` itself already uses below.
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
    /** The segment(s) these turns were removed from, excluding the target itself — empty on a dry run. */
    vacatedSegmentIds: number[];
    /** Turn ids actually linked to the target — empty when `targetSegmentId` is null, or on a dry run. */
    addedTurnIds: number[];
  };
}

export type SettlementMembershipWriteEvaluation =
  | { ok: true; outcome: SettlementMembershipWriteOutcome }
  | { ok: false; message: string };

export interface EvaluateSettlementMembershipWriteOptions {
  /** false = a dry run (reads only, a real receipt, nothing written); true = the commit-time write. */
  apply: boolean;
}

function evaluatePropose(
  db: Database,
  context: SettlementTurnFacadeContext,
  rawInput: SettlementMembershipWriteInput,
  nowEpoch: number,
  options: EvaluateSettlementMembershipWriteOptions,
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

  let proposalId: number | null = null;
  let proposeAlreadyExisted: boolean | undefined;
  if (options.apply) {
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
    proposalId = stored.record.id;
    proposeAlreadyExisted = stored.alreadyExisted;
  }

  return {
    ok: true,
    outcome: {
      proposalId,
      proposeAlreadyExisted,
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
 * Domain: this session's CURRENTLY attached segments (a LIVE read, ticket 05
 * pinned decision: "写事务内重验该段仍挂靠本会话(roster 快照仅提示)") ∪
 * homeless (`id` omitted). `context.attachedSegmentIds` — the roster snapshot
 * taken once at context-build time — is advisory only now: it is what the
 * PROMPT shows the model, but the actual gate re-reads
 * `db/segments.ts`'s `getAttachedSegmentIds` fresh, every call, so a segment
 * the main agent detached (or a NEW one it attached) between context-build
 * and this write is judged as it stands right now, not as it stood when the
 * roster was rendered. Any segment id outside that live set is refused,
 * naming it as not attached — settlement cannot grow a session's attachment
 * set, only the main agent can.
 */
function evaluateReassign(
  db: Database,
  context: SettlementTurnFacadeContext,
  rawInput: SettlementMembershipWriteInput,
  nowEpoch: number,
  options: EvaluateSettlementMembershipWriteOptions,
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
    // Ticket 05: a LIVE read, not `context.attachedSegmentIds` (the frozen
    // roster snapshot render time took) — the target must still be attached
    // AT THE MOMENT this call is evaluated, dry run or commit alike.
    const currentlyAttached = new Set(getAttachedSegmentIds(db, context.sessionId));
    if (!currentlyAttached.has(parsedTarget.segmentId)) {
      return {
        ok: false,
        message:
          `E${parsedTarget.segmentId} is not attached to this session — settlement may only ` +
          "reassign a turn to a segment already on this session's roster, or to no segment " +
          "(omit id); attaching a NEW segment to this session is the main agent's call alone.",
      };
    }
    // Ticket 05 (spec: "渲染后被 detach/close 的段不可再收成员"): attachment
    // rows never expire (db/schema.ts's own comment on segment_attachments —
    // "accumulate, never expire, no detach"), so CLOSE is the live half of
    // this guard that actually fires in practice. A segment closed after the
    // roster was rendered must refuse a new member the same way `remember`'s
    // own append/replace already refuse one, for the same reason.
    const targetSegment = getSegment(db, parsedTarget.segmentId);
    if (!targetSegment || targetSegment.status === "closed") {
      return {
        ok: false,
        message:
          `E${parsedTarget.segmentId} is closed — settlement may not reassign a turn onto a ` +
          "closed segment; it was open when the roster was rendered but has since been closed.",
      };
    }
    targetSegmentId = parsedTarget.segmentId;
  }

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

  if (!options.apply) {
    return {
      ok: true,
      outcome: {
        proposalId: null,
        addressesResolved: turnIds.length,
        reassign: { targetSegmentId, vacatedSegmentIds: [], addedTurnIds: [] },
      },
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
 * The settlement membership facade's whole decision — dispatches on
 * `action` (ticket 08 widens this from `propose`-only to `propose` |
 * `reassign`; the zod shape already refuses any third value before this
 * runs).
 */
export function evaluateSettlementMembershipWrite(
  db: Database,
  context: SettlementTurnFacadeContext,
  rawInput: SettlementMembershipWriteInput,
  nowEpoch: number,
  options: EvaluateSettlementMembershipWriteOptions,
): SettlementMembershipWriteEvaluation {
  if (rawInput.action === "reassign") {
    return evaluateReassign(db, context, rawInput, nowEpoch, options);
  }
  return evaluatePropose(db, context, rawInput, nowEpoch, options);
}

/**
 * Render one membership-write outcome as tool-result text (stage or
 * commit-time replay bookkeeping — same `staged` convention as
 * `renderSettlementTurnWriteReceipt`).
 */
export function renderSettlementMembershipWriteReceipt(
  outcome: SettlementMembershipWriteOutcome,
  options: { staged: boolean; replaced?: boolean },
): string {
  const verb = options.staged ? "Staged" : "Landed";
  const replacedSuffix = options.replaced
    ? " — replaces the earlier staged call for this same key"
    : "";
  if (outcome.reassign) {
    const { targetSegmentId, vacatedSegmentIds, addedTurnIds } = outcome.reassign;
    const destination = targetSegmentId !== null ? `E${targetSegmentId}` : "homeless (no segment)";
    const vacatedNote =
      vacatedSegmentIds.length > 0
        ? `, vacated ${vacatedSegmentIds.map((id) => `E${id}`).join(",")}`
        : "";
    const landedNote = options.staged ? "" : `, ${addedTurnIds.length} linked`;
    return (
      `${verb} reassign: ${outcome.addressesResolved} turn(s) -> ${destination}` +
      `${options.staged ? " (pending commit)" : ""}${vacatedNote}${landedNote}.${replacedSuffix}`
    );
  }
  const duplicateNote = outcome.proposeAlreadyExisted
    ? " — already exists (matches an earlier proposal for the same turns; no second row created)"
    : "";
  return (
    `${verb} propose: ${outcome.addressesResolved} address(es)${options.staged ? " (pending commit)" : ""}` +
    `${outcome.proposalId !== null ? ` as proposal #${outcome.proposalId}` : ""} — creates no segment.${duplicateNote}${replacedSuffix}`
  );
}
