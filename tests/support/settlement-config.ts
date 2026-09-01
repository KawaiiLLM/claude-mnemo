import type { Database } from "bun:sqlite";

import { DEFAULT_CONFIG, type MnemoConfig } from "../../src/shared/config";
import type { SettlementScopeProvenance } from "../../src/worker/note-settlement-context";

/**
 * The era every settlement fixture runs under. Epoch 1 is the smallest value
 * `normalizeEraCutoffEpoch` accepts, so every seeded turn is in the era whatever
 * its timestamp; a fixture that wants a legacy prefix states its own cutoff
 * above the turns it seeds.
 */
export const SETTLEMENT_ERA_CUTOFF_EPOCH = 1;

/**
 * DEFAULT_CONFIG with the era live. The cutover switch is the cutoff, not the
 * kill switch: the product default leaves `eraCutoffEpoch` null — every turn
 * legacy, and legacy turns are settled by nothing — so every test that
 * exercises a trigger names an era explicitly.
 */
export const SETTLEMENT_ENABLED_CONFIG: MnemoConfig = {
  ...DEFAULT_CONFIG,
  settlementEnabled: true,
  eraCutoffEpoch: SETTLEMENT_ERA_CUTOFF_EPOCH,
};

/** The kill switch thrown while the era stays up — the operator's stop button. */
export const SETTLEMENT_KILLED_CONFIG: MnemoConfig = {
  ...SETTLEMENT_ENABLED_CONFIG,
  settlementEnabled: false,
};

/**
 * THE DISPATCH'S OWN SCOPE PROVENANCE, for a fixture that drives the settlement
 * query directly (settlement-gate-taxonomy ticket 03).
 *
 * `scopeProvenance` is no longer optional in practice: a `lane_check` or
 * `commit` call whose dispatch carries none fails CLOSED on the system-failure
 * channel and produces no report and no verdict at all
 * (`settlementScopeProvenanceFailure`). Production computes this from the
 * rendered context (`resolveSettlementScopeProvenance`); a fixture has no
 * context object, so it derives the same three buckets from the one fact the
 * request already states — the window's own prompt-number bounds.
 *
 * WINDOW is every writable id whose turn sits inside `[windowStart, windowEnd]`
 * of THIS session; everything else is filed as declared lookback. The third
 * bucket (`closureOnly`) is left empty: a fixture that wants a closure-only id
 * distinguished from a lookback one has to say so itself, and the two that do
 * write their provenance out by hand.
 */
export function settlementScopeProvenanceFor(
  db: Database,
  sessionDbId: number,
  writableTurnIds: Iterable<number>,
  windowStart: number,
  windowEnd: number,
): SettlementScopeProvenance {
  const window = new Set<number>();
  const baseLookback = new Set<number>();
  for (const id of writableTurnIds) {
    const row = db
      .query<{ session_id: number; prompt_number: number }, [number]>(
        "SELECT session_id, prompt_number FROM turns WHERE id = ?",
      )
      .get(id);
    const inWindow =
      row !== null &&
      row.session_id === sessionDbId &&
      row.prompt_number >= windowStart &&
      row.prompt_number <= windowEnd;
    (inWindow ? window : baseLookback).add(id);
  }
  return { window, baseLookback, closureOnly: new Set() };
}
