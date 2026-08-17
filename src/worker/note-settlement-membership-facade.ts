import { z } from "zod";
import type { Database } from "bun:sqlite";

import { recordNoteSettlementMembershipActivity } from "../db/note-settlement-completion";
import { recordNoteSettlementProposal } from "../db/note-settlement-proposals";
import { parseBareAddressReference, validateReferences } from "../db/references";
import { addSegmentMembers, getSegment } from "../db/segments";
import { getTurn } from "../db/turns";
import { parseTurnAddress } from "../mcp/note";
import type { SettlementTurnFacadeContext } from "./note-settlement-turn-facade";

/**
 * The settlement membership facade (ticket 08, ADR-0002/0007).
 *
 * Retires `note-settlement-segment-facade.ts` outright (ticket 07's licensed
 * deviation, closed here — see that ticket's own status note). Settlement's
 * segment authority shrinks from the old facade's create/extend/exclude —
 * arc partitioning, body authorship, lifecycle status, topic minting — down
 * to exactly two things ADR-0002's Ownership table grants it: "membership
 * within attached segments, text proposals when nothing fits". Everything
 * else (creation, naming, attachment, Working State, close) is the user/main
 * agent's alone, through `remember` (ADR-0002/0007).
 *
 * Registered under the tool name `remember` (not `segment`) in
 * note-settlement-sdk-query.ts, per ADR-0007's "the settlement subagent uses
 * the same injection and the same tool quartet as the main agent — note,
 * remember, timeline, recall — not a dedicated facade set". The shape here
 * is settlement's own restricted schema, the same relationship this
 * project's `note` facade already has to the main agent's `note` tool (one
 * tool NAME shared across both callers, a caller-specific shape).
 *
 * Two actions, mirroring the turn facade's dry-run/apply split (spec A7):
 *
 *   - `assign`: one turn joins one of the session's ATTACHED segments
 *     (`context.attachedSegmentIds` — never a segment merely recalled or
 *     recently active). A turn matching nothing is left alone: there is no
 *     "exclude"/"homeless" verb any more, because "turns fitting nothing
 *     stay homeless" is legal by DEFAULT, never a fact requiring its own
 *     write (spec: "legal, never forced").
 *   - `propose`: several homeless turns that read as one task become a
 *     TEXT-ONLY suggestion (`db/note-settlement-proposals.ts`) — never a
 *     segment row, never auto-adopted. Approval is one later
 *     `remember(create)` call with the proposal's own addresses as seed
 *     members (ticket 02's existing path; this facade does not touch it).
 *
 * Both actions, on landing, record the completion gate's own re-keyed fact
 * (`recordNoteSettlementMembershipActivity`,
 * db/note-settlement-completion.ts) — "this job's membership duty has been
 * engaged", the job-level replacement for the retired per-turn exclusion
 * anti-join. See that module's doc comment for the full re-key.
 */

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

export const settlementMembershipWriteInputShape = {
  action: z.enum(["assign", "propose"]),
  /** assign only, required — "S<session>/T<prompt>"; also this call's staging key together with segmentId. */
  turn: z.string().optional(),
  /** assign only, required — a real segment id already ATTACHED to this session (see the attached segments list). */
  segmentId: z.number().int().positive().optional(),
  /** propose only, required — at least two "S<session>/T<prompt>" turn addresses forming one coherent cluster. */
  addresses: z.array(z.string()).optional(),
  /** propose only, required — a short suggested title for the cluster, shown to the user next session. */
  title: z.string().optional(),
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
  action: "assign" | "propose";
  /** assign only. */
  ref: string | null;
  segmentId: number | null;
  /** assign only — false when the turn was already a member (idempotent re-assign). */
  added: boolean;
  /** propose only. */
  proposalId: number | null;
  addressesResolved: number;
}

export type SettlementMembershipWriteEvaluation =
  | { ok: true; outcome: SettlementMembershipWriteOutcome }
  | { ok: false; message: string };

export interface EvaluateSettlementMembershipWriteOptions {
  /** false = a dry run (reads only, a real receipt, nothing written); true = the commit-time write. */
  apply: boolean;
}

function isSegmentMember(db: Database, segmentId: number, turnId: number): boolean {
  return (
    db
      .query<{ segmentId: number }, [number, number]>(
        "SELECT segment_id AS segmentId FROM segment_members WHERE segment_id = ? AND turn_id = ?",
      )
      .get(segmentId, turnId) !== null
  );
}

function evaluateAssign(
  db: Database,
  context: SettlementTurnFacadeContext,
  rawInput: SettlementMembershipWriteInput,
  nowEpoch: number,
  options: EvaluateSettlementMembershipWriteOptions,
): SettlementMembershipWriteEvaluation {
  if (!rawInput.turn || rawInput.turn.trim() === "") {
    return { ok: false, message: 'assign requires turn, a "S<session>/T<prompt>" address.' };
  }
  const address = parseTurnAddress(rawInput.turn);
  if (!address) {
    return {
      ok: false,
      message: `turn must be a fully qualified "S<session>/T<prompt>" address; got "${rawInput.turn}".`,
    };
  }
  const ref = `S${address.sessionId}/T${address.promptNumber}`;
  if (rawInput.segmentId === undefined) {
    return {
      ok: false,
      message: "assign requires segmentId, a real segment id already attached to this session.",
    };
  }

  const turn = getTurn(db, address.sessionId, address.promptNumber);
  if (!turn) {
    return { ok: false, message: `no turn at ${ref}.` };
  }
  if (turn.type.includes("compact")) {
    return { ok: false, message: `${ref} is a compact marker, not a turn.` };
  }
  if (!context.reviewableTurnIds.has(turn.id)) {
    return {
      ok: false,
      message:
        `${ref} is outside this dispatch's reviewable window (the window ` +
        "plus its rendered lookback) — membership may only be assigned for a turn this prompt actually showed.",
    };
  }
  // The load-bearing scope gate (spec "Assignment only ever targets the
  // session's attached segments"): a segment id that resolves to a REAL row
  // is not enough — it must be one THIS session has attached.
  if (!context.attachedSegmentIds.has(rawInput.segmentId)) {
    return {
      ok: false,
      message:
        `E${rawInput.segmentId} is not attached to S${context.sessionId} — assignment may only target ` +
        "one of the session's attached segments (see the attached segments list).",
    };
  }
  const segment = getSegment(db, rawInput.segmentId);
  if (!segment) {
    return { ok: false, message: `no segment E${rawInput.segmentId}.` };
  }

  let added: boolean;
  if (options.apply) {
    const result = addSegmentMembers(db, segment.id, [turn.id], nowEpoch);
    added = result.length > 0;
    recordNoteSettlementMembershipActivity(db, context.jobId, nowEpoch);
  } else {
    added = !isSegmentMember(db, segment.id, turn.id);
  }

  return {
    ok: true,
    outcome: {
      action: "assign",
      ref,
      segmentId: segment.id,
      added,
      proposalId: null,
      addressesResolved: 0,
    },
  };
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
  if (rawAddresses.length < 2) {
    return {
      ok: false,
      message:
        "propose requires addresses, at least two turn addresses — a proposal is a CLUSTER, " +
        "not a single turn; a lone homeless turn simply stays homeless.",
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
  if (refs.length < 2) {
    return {
      ok: false,
      message: "propose requires at least two DISTINCT turn addresses after de-duplication.",
    };
  }

  let proposalId: number | null = null;
  if (options.apply) {
    const stored = recordNoteSettlementProposal(db, {
      jobId: context.jobId,
      sessionId: context.sessionId,
      title: rawInput.title,
      addresses: refs,
      nowEpoch,
    });
    proposalId = stored.id;
    recordNoteSettlementMembershipActivity(db, context.jobId, nowEpoch);
  }

  return {
    ok: true,
    outcome: {
      action: "propose",
      ref: null,
      segmentId: null,
      added: false,
      proposalId,
      addressesResolved: refs.length,
    },
  };
}

/**
 * The settlement membership facade's whole decision, mirroring
 * `evaluateSettlementTurnWrite`'s shape: every read runs unconditionally,
 * every write is gated on `options.apply`.
 */
export function evaluateSettlementMembershipWrite(
  db: Database,
  context: SettlementTurnFacadeContext,
  rawInput: SettlementMembershipWriteInput,
  nowEpoch: number,
  options: EvaluateSettlementMembershipWriteOptions,
): SettlementMembershipWriteEvaluation {
  if (rawInput.action === "assign") {
    return evaluateAssign(db, context, rawInput, nowEpoch, options);
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
  if (outcome.action === "assign") {
    const membership = outcome.added
      ? `${outcome.ref} joins E${outcome.segmentId}`
      : `${outcome.ref} is already a member of E${outcome.segmentId}`;
    return `${verb} assign: ${membership}${options.staged ? " (pending commit)" : ""}.${replacedSuffix}`;
  }
  return (
    `${verb} propose: ${outcome.addressesResolved} address(es)${options.staged ? " (pending commit)" : ""}` +
    `${outcome.proposalId !== null ? ` as proposal #${outcome.proposalId}` : ""} — creates no segment.${replacedSuffix}`
  );
}
