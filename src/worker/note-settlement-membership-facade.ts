import { z } from "zod";
import type { Database } from "bun:sqlite";

import { recordNoteSettlementProposal } from "../db/note-settlement-proposals";
import { parseBareAddressReference, validateReferences } from "../db/references";
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
 * `propose` is the one surviving verb (spec: "propose 在退役潮里唯一存活的形
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
   * `assign` is dead (ticket 05) — kept as a single-member enum rather than
   * dropped outright so a stale caller gets zod's own "invalid enum value"
   * rejection instead of an unknown-key `.strict()` failure with no useful
   * message. `propose` is the only legal value.
   */
  action: z.enum(["propose"]),
  /** required — at least one "S<session>/T<prompt>" turn address; this call's staging key. */
  addresses: z.array(z.string()).optional(),
  /** required — a short suggested title for the cluster, shown to the user next session. */
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
  if (options.apply) {
    const stored = recordNoteSettlementProposal(db, {
      jobId: context.jobId,
      sessionId: context.sessionId,
      title: rawInput.title,
      addresses: refs,
      nowEpoch,
    });
    proposalId = stored.id;
  }

  return {
    ok: true,
    outcome: {
      proposalId,
      addressesResolved: refs.length,
    },
  };
}

/**
 * The settlement membership facade's whole decision. `action` has exactly
 * one legal value (`propose`) since `assign` retired (ticket 05) — the zod
 * shape already refuses anything else before this runs, so there is no
 * dispatch left to do here beyond calling the one evaluator.
 */
export function evaluateSettlementMembershipWrite(
  db: Database,
  context: SettlementTurnFacadeContext,
  rawInput: SettlementMembershipWriteInput,
  nowEpoch: number,
  options: EvaluateSettlementMembershipWriteOptions,
): SettlementMembershipWriteEvaluation {
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
  return (
    `${verb} propose: ${outcome.addressesResolved} address(es)${options.staged ? " (pending commit)" : ""}` +
    `${outcome.proposalId !== null ? ` as proposal #${outcome.proposalId}` : ""} — creates no segment.${replacedSuffix}`
  );
}
