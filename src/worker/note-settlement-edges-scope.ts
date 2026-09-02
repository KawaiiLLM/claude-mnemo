import type { Database } from "bun:sqlite";

import {
  emptySettlementReadDeltas,
  type SettlementReadDeltas,
} from "../db/note-settlement-snapshots";
import type { SettlementProvenanceIndex } from "../db/write-gate";
import type { SettlementScopeProvenance } from "./note-settlement-context";
import {
  readSettlementFrozenScope,
  type SettlementFrozenScope,
} from "./note-settlement-shape-numbers";

/**
 * THE FROZEN EDGES SCOPE, on its own.
 *
 * This code has never had anything to do with a model client: it reads the
 * stage-1 transition's persisted snapshots and completes them with the
 * dispatch's own live-computed fallback. It lived in
 * `note-settlement-sdk-query.ts` only because that is where its first caller
 * was — and that accident of location was, until claim-monitor-repair ticket
 * 02's peer round 2, the ONE reason the worker's own bundle still contained
 * the settlement model client at all: `note-settlement-dispatch.ts` (which
 * the worker core does import) had to reach into the SDK module to call
 * `installSettlementEdgesScope`, and one value edge pulls the whole module.
 *
 * Splitting it out is what makes gate 6 real rather than nominal: after the
 * split, `note-settlement-sdk-query.ts` is unreachable by any value import
 * from `src/worker/server.ts`, which is exactly what the no-model guard in
 * `tests/worker/server.note-settlement-triggers.test.ts` now asserts without
 * an exemption. The SDK module re-exports these three names, so every
 * existing importer keeps working unchanged.
 */
export interface SettlementEdgesScope {
  writableTurnIds: ReadonlySet<number>;
  writableProvenance: SettlementProvenanceIndex;
  scopeProvenance: SettlementScopeProvenance | undefined;
  worklist: SettlementFrozenScope["worklist"];
  debts: SettlementFrozenScope["debts"];
  laneMembers: SettlementFrozenScope["laneMembers"];
  /** Ticket 06: the two stage-2 read lists; empty until a transition froze them. */
  readDeltas: SettlementReadDeltas;
}

/**
 * A mutable box, installed once and re-installed in place. Everything this
 * dispatch's write engine and gate closures read is `holder.current` at the
 * moment they run, never a value copied out at construction — so a LATER
 * `installSettlementEdgesScope` call (ticket 03: the finalize handler, once
 * the transition it guards has just persisted the snapshots this reads)
 * swaps this run's authority without rebuilding the write engine or any
 * closure that captured the holder.
 */
export interface SettlementEdgesScopeHolder {
  current: SettlementEdgesScope;
}

/**
 * THE install function — the one path that reads `readSettlementFrozenScope`
 * and turns it into this dispatch's edges scope, callable at two times with
 * IDENTICAL behaviour:
 *
 *   - AT REQUEST CONSTRUCTION: the transition snapshots do not exist yet for
 *     a job still on stage 1, so `readSettlementFrozenScope` returns `null`
 *     and `fallback` — the dispatch's own live-computed writable set —
 *     stands, exactly the pre-staging behaviour.
 *   - LATER, AGAINST A LIVE RUN (ticket 03): called again after a finalize
 *     handler's transition transaction commits, this time reading the
 *     snapshots that transaction just persisted. Passing the SAME `holder`
 *     mutates `holder.current` in place rather than allocating a new box, so
 *     every closure that closed over `holder` — not over its old contents —
 *     observes the swap on its very next call.
 *
 * `holder` omitted allocates a fresh one (the construction-time call);
 * supplied, it is mutated and returned so the caller keeps using its own
 * reference.
 */
export function installSettlementEdgesScope(
  db: Database,
  jobId: number,
  fallback: Pick<SettlementEdgesScope, "writableTurnIds" | "scopeProvenance">,
  holder?: SettlementEdgesScopeHolder,
): SettlementEdgesScopeHolder {
  const frozen = readSettlementFrozenScope(db, jobId);
  const scope: SettlementEdgesScope = {
    writableTurnIds: frozen?.writableTurnIds ?? fallback.writableTurnIds,
    writableProvenance: frozen?.writableProvenance ?? new Map(),
    scopeProvenance: frozen?.scopeProvenance ?? fallback.scopeProvenance,
    worklist: frozen?.worklist ?? [],
    debts: frozen?.debts ?? [],
    laneMembers: frozen?.laneMembers ?? new Map(),
    readDeltas: frozen?.readDeltas ?? emptySettlementReadDeltas(),
  };
  if (holder) {
    holder.current = scope;
    return holder;
  }
  return { current: scope };
}
