import type { Database } from "bun:sqlite";

import {
  phasesForTypes,
  type TurnEdgeRelation,
  type TurnPhase,
} from "../shared/turn-phase";
import { liveTurnSql } from "./turn-liveness";

/**
 * Per-turn scoring signals (turn-edge-mechanism spec, "三条计分规则" /
 * "不钉数值权重"; ticket 07). Importance is no longer ASSIGNED — this module
 * is the read layer that DERIVES it from `memory_edges`, exposing exactly the
 * three signals the spec pins and nothing more:
 *
 *   - `override` zeroes a turn out entirely (all-or-nothing);
 *   - `refines` counts only ABOVE the baseline in-degree of 1 (a turn a
 *     single successor continues forward from carries no information; only
 *     later work coming BACK to it does), split by the refining source's
 *     phase so the two never collapse into one pre-weighted number;
 *   - `encodes` lifts (a raw in-degree count — the one channel that rescues
 *     a "decided once, nobody revisited" turn).
 *
 * No numeric weight and no combined scalar score live here (spec: "不钉数值
 * 权重" — only the signals and their relative ORDER are pinned; how a future
 * view spec combines them is that spec's decision, not this module's). No
 * rendering either — this is a pure read/derive layer, consumed by ticket
 * 07's own future view-spec sibling ([S15069/T924]).
 */

export interface RefinesExcessByPhase {
  decision: number;
  delivery: number;
}

export interface TurnEdgeSignals {
  /** True iff a LIVE turn (`turn-liveness.ts`) holds a current `override` edge targeting this (also live) turn. */
  overridden: boolean;
  /**
   * Above-baseline `refines` in-degree, bucketed by each excess edge's
   * SOURCE turn's phase. See `bucketRefinesExcess` below for exactly which
   * edge counts as "baseline" and how a dual-phase source is bucketed once.
   */
  refinesExcess: RefinesExcessByPhase;
  /** Raw in-degree of LIVE `encodes` edges (both endpoints live — `turn-liveness.ts`). */
  encodesCount: number;
}

function zeroSignals(): TurnEdgeSignals {
  return { overridden: false, refinesExcess: { decision: 0, delivery: 0 }, encodesCount: 0 };
}

/**
 * Ticket 07's exhaustive scoring decision, ORIGINALLY keyed on the retired
 * seven-word set. Flow-relations spec, ticket 02's interim ruling
 * (`.scratch/flow-relations/spec.md`, migration item 6, "Election interim"):
 * "keys re-map 1:1 by rename — the refines key reads extends, the encodes
 * key reads grounds", override unchanged. This is a MINIMAL, ticket-02-
 * authorized word swap only, forced by `shared/turn-phase.ts`'s
 * `TurnEdgeRelation` type changing under this exhaustive `Record` — it does
 * NOT redesign scoring for the new words `narrows`/`collects` (both left
 * `false`, "scores nothing until ruled", the same interim distortion spec.md
 * names) or reconsider whether `extends`'s excess-baseline signal still means
 * the same thing once `narrows` exists as a separate word. Ticket 05 owns
 * that redesign; this file's query literals below are updated only so far as
 * needed to not silently read zero rows post-migration (`encodes`/`refines`
 * no longer appear in storage at all after this ticket's rename).
 */
export const RELATION_IS_SCORED: Record<TurnEdgeRelation, boolean> = {
  override: true,
  narrows: false,
  extends: true,
  indexes: false,
  consume: false,
  grounds: true,
  verifies: false,
  refutes: false,
};

function parseTypeArray(value: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

/**
 * Spec's bucketing rule, stated in the ticket as: "a source whose phases
 * include 决策 buckets as decision; otherwise if 落地, as delivery" — decision
 * checked first so a dual-phase source (e.g. `["review","design"]`, phase set
 * {decision, delivery}) is bucketed ONCE, as decision (ticket 07's own
 * documented choice: a source that can influence a decision counts as the
 * heavier signal, not both). A source with neither phase present (an
 * evidence-only source, or one whose `type` was edited to something outside
 * the vocabulary AFTER the edge was written — phases are derived live from
 * the CURRENT `type` column, never pinned at write time) contributes to
 * neither bucket: the same "unmapped input strengthens nothing" rule
 * `phasesForTypes` itself already documents.
 */
function primaryPhaseBucket(phases: ReadonlySet<TurnPhase>): "decision" | "delivery" | null {
  if (phases.has("decision")) {
    return "decision";
  }
  if (phases.has("delivery")) {
    return "delivery";
  }
  return null;
}

interface OverrideRow {
  targetId: number;
}

interface EncodesRow {
  targetId: number;
  count: number;
}

interface RefinesRow {
  targetId: number;
  citingType: string | null;
}

/**
 * The signal tuple for a SET of turns, in one pass over `memory_edges` per
 * signal (three queries total, independent of `turnIds.length` — no N+1).
 * Every id in `turnIds` is present in the result, defaulting to the all-zero
 * tuple, so an empty graph (or a turn with no incoming edges at all) reads as
 * zero rather than being absent from the map — the degradation guarantee's
 * signal half (spec: "边质量是本方案唯一的真风险，退化把最坏情况锁定在
 * 「与今天持平」").
 *
 * All three signals only ever count a LIVE SOURCE turn, and only ever
 * compute a signal FOR a live target — indexes-rescope spec law 8 / ticket
 * 03's shared predicate (`turn-liveness.ts`), applied to both the `citing`
 * and `cited` joins below. `override` and `refines` said "live source"
 * explicitly even before this ticket (non-rolled-back only, `status`
 * unchecked); `encodes` carried the same filter even though the original
 * ticket text did not repeat it for that bullet — a rolled-back turn's
 * assertions are void the same way whichever relation they carry (a
 * delivery turn the user undid cannot credibly still be "encoding" a
 * decision), so the exclusion is applied uniformly rather than leaving
 * `encodes` as the one signal a dead turn can still feed. This ticket widens
 * that "live source" rule two ways: `status = 'skipped'` (dormant) now
 * excludes a source the same as `was_rolled_back` always did, and the
 * TARGET's own liveness is checked too — a rolled-back or skipped turn is
 * not a node, so it is never a key any edge should be able to light up, even
 * if a caller's `turnIds` happens to name one (it still gets the all-zero
 * default below, same degradation guarantee as an id with no incoming edges
 * at all). A dormant target's live-turn edges are not deleted, only hidden
 * by this predicate, so they resume contributing untouched the moment a late
 * note promotes it back (`db/turns.ts`'s `promoteTurnFromNote`).
 */
export function getTurnEdgeSignals(
  db: Database,
  turnIds: readonly number[],
): Map<number, TurnEdgeSignals> {
  const result = new Map<number, TurnEdgeSignals>();
  const uniqueIds = [...new Set(turnIds)];
  for (const id of uniqueIds) {
    result.set(id, zeroSignals());
  }
  if (uniqueIds.length === 0) {
    return result;
  }

  const placeholders = uniqueIds.map(() => "?").join(",");

  const overrideRows = db
    .query<OverrideRow, number[]>(
      `SELECT DISTINCT e.cited_id AS targetId
       FROM memory_edges e
       JOIN turns citing ON citing.id = e.citing_id
       JOIN turns cited ON cited.id = e.cited_id
       WHERE e.citing_kind = 'turn' AND e.cited_kind = 'turn'
         AND e.relation = 'override'
         AND ${liveTurnSql("citing")}
         AND ${liveTurnSql("cited")}
         AND e.cited_id IN (${placeholders})`,
    )
    .all(...uniqueIds);
  for (const row of overrideRows) {
    result.get(row.targetId)!.overridden = true;
  }

  const encodesRows = db
    .query<EncodesRow, number[]>(
      `SELECT e.cited_id AS targetId, COUNT(*) AS count
       FROM memory_edges e
       JOIN turns citing ON citing.id = e.citing_id
       JOIN turns cited ON cited.id = e.cited_id
       WHERE e.citing_kind = 'turn' AND e.cited_kind = 'turn'
         AND e.relation = 'grounds'
         AND ${liveTurnSql("citing")}
         AND ${liveTurnSql("cited")}
         AND e.cited_id IN (${placeholders})
       GROUP BY e.cited_id`,
    )
    .all(...uniqueIds);
  for (const row of encodesRows) {
    result.get(row.targetId)!.encodesCount = row.count;
  }

  // Ordered per target by the edge's OWN created_at_epoch, citing_id as a
  // deterministic tiebreak: the earliest live `refines` edge to arrive at a
  // turn is its baseline (a turn one successor continues forward from is
  // unremarkable, spec's own framing) and contributes nothing; every edge
  // that arrives AFTER it is the "later work came back" signal, bucketed by
  // ITS OWN source's phase. This is what makes "count of incoming refines
  // edges minus 1, floored at 0" a well-defined per-EDGE operation rather
  // than a single scalar that would need an invented rule for which phase
  // "absorbs" the baseline when sources are mixed — exactly the kind of
  // number the spec's "不钉数值权重" refuses to invent.
  const refinesRows = db
    .query<RefinesRow, number[]>(
      `SELECT e.cited_id AS targetId, citing.type AS citingType
       FROM memory_edges e
       JOIN turns citing ON citing.id = e.citing_id
       JOIN turns cited ON cited.id = e.cited_id
       WHERE e.citing_kind = 'turn' AND e.cited_kind = 'turn'
         AND e.relation = 'extends'
         AND ${liveTurnSql("citing")}
         AND ${liveTurnSql("cited")}
         AND e.cited_id IN (${placeholders})
       ORDER BY e.cited_id ASC, e.created_at_epoch ASC, e.citing_id ASC`,
    )
    .all(...uniqueIds);

  let currentTarget: number | null = null;
  let seenForTarget = 0;
  for (const row of refinesRows) {
    if (row.targetId !== currentTarget) {
      currentTarget = row.targetId;
      seenForTarget = 0;
    }
    seenForTarget += 1;
    if (seenForTarget === 1) {
      // The baseline edge for this target — not excess.
      continue;
    }
    const phases = phasesForTypes(parseTypeArray(row.citingType));
    const bucket = primaryPhaseBucket(phases);
    if (bucket) {
      result.get(row.targetId)!.refinesExcess[bucket] += 1;
    }
  }

  return result;
}

/** Single-turn convenience wrapper over `getTurnEdgeSignals`. */
export function getTurnEdgeSignalsForTurn(db: Database, turnId: number): TurnEdgeSignals {
  return getTurnEdgeSignals(db, [turnId]).get(turnId) ?? zeroSignals();
}
