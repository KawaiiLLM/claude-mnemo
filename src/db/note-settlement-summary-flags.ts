import type { Database } from "bun:sqlite";

import { getIncomingEdges } from "./memory-edges";
import { parseQualifiedReferences, validateReferences } from "./references";
import { getSegment } from "./segments";

/**
 * ADR-0004's settlement flagging half (ticket 08).
 *
 * The citation floor (ADR-0004's other guard, C6) already stops a summary
 * claim existing with no citation at write time in `remember`. What it
 * cannot catch is a claim that WAS grounded when written and has since gone
 * stale — the window that settlement judges is exactly the material that can
 * show that. Two cheap, mechanical heuristics, neither a rewrite (ADR-0004:
 * "flags contradictions or unsupported claims in its report; it never
 * rewrites" — the single writer stays `remember`, ADR-0002):
 *
 *   1. CITATION-LESS: a non-empty `content`/`insight` on an ATTACHED segment
 *      carrying no `[S<n>/T<m>]`/`[E<n>]` citation at all. The citation floor
 *      is meant to hold this line at write time (C6); a hit here means a
 *      pre-citation-floor row, or a row this project's own tooling let
 *      through some other path — flagged, not repaired.
 *   2. CITED-TURN-SUPERSEDED: a claim that DOES cite a turn, but that turn
 *      was superseded by a member of THIS window (a `supersedes` edge whose
 *      citing side is inside the window being settled) — the segment's
 *      summary is citing a conclusion this very window overturned. Only
 *      `supersedes` inside the CURRENT window counts: an older supersession
 *      an earlier settlement pass already had the chance to flag is not this
 *      run's finding to repeat.
 *
 * Scope is the SUMMARY layer only — `content`/`insight` — never the six
 * Working State fields (`goal`/`constraints`/`decisions`/`done`/
 * `next_steps`/`reference`): the glossary keeps Working State and Summary
 * layer as two different categories (root CONTEXT.md), and ADR-0004's own
 * title and context section are explicit that the layer at risk here is
 * "the layer outsiders read" (ADR-0001), not the resuming session's
 * operational state, which stays entirely the main agent's to maintain.
 */

export type NoteSettlementSummaryFlagReason =
  | "citation-less"
  | "cited-turn-superseded";

export interface NoteSettlementSummaryFlag {
  segmentId: number;
  field: "content" | "insight";
  reason: NoteSettlementSummaryFlagReason;
  /** The raw `[S<n>/T<m>]` citation text, present only for "cited-turn-superseded". */
  citedRef?: string;
}

/**
 * Attached-segment summary flags for one settled window. `attachedSegmentIds`
 * and `windowTurnIds` are both read by the CALLER (worker/note-settlement-
 * dispatch.ts) from the same context the membership facade used — this
 * function does no scoping of its own, matching every other read-only
 * settlement-report helper.
 */
export function computeSettlementSummaryFlags(
  db: Database,
  attachedSegmentIds: readonly number[],
  windowTurnIds: ReadonlySet<number>,
): NoteSettlementSummaryFlag[] {
  const flags: NoteSettlementSummaryFlag[] = [];

  for (const segmentId of attachedSegmentIds) {
    const segment = getSegment(db, segmentId);
    if (!segment) {
      continue;
    }

    for (const field of ["content", "insight"] as const) {
      const text = segment[field];
      if (!text || text.trim() === "") {
        // Empty is not a claim — nothing to ground and nothing to flag.
        continue;
      }

      const references = parseQualifiedReferences(text);
      if (references.length === 0) {
        flags.push({ segmentId, field, reason: "citation-less" });
        continue;
      }

      const { accepted } = validateReferences(db, references);
      for (const entry of accepted) {
        if (entry.reference.kind !== "turn") {
          continue;
        }
        const incoming = getIncomingEdges(db, entry.node);
        const supersededThisWindow = incoming.some(
          (edge) =>
            edge.relation === "supersedes" &&
            edge.citing.kind === "turn" &&
            windowTurnIds.has(edge.citing.id),
        );
        if (supersededThisWindow) {
          flags.push({
            segmentId,
            field,
            reason: "cited-turn-superseded",
            citedRef: entry.reference.raw,
          });
        }
      }
    }
  }

  return flags;
}
