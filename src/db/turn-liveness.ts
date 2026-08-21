/**
 * The graph's ONE shared deleted/dormant node predicate (indexes-rescope
 * spec, `.scratch/indexes-rescope/spec.md`, law 8; ticket 03). Every read
 * side that derives a node, edge, citation, or signal from `turns` consumes
 * this instead of restating its own variant.
 *
 * Before this ticket the three read sides disagreed:
 *
 *   - `db/flows.ts` (`deriveFlowsForSessions`) applied NO filter at all — its
 *     turn query loaded every turn of a session regardless of
 *     `was_rolled_back`/`status`, so a rewound or skipped turn could still
 *     seed a flow or be reached by narrows/extends/grounds/consume.
 *   - `db/citations.ts` applied NO filter at all either, on ANY of its four
 *     read functions (`getTurnCitations`, `getEffectiveCitations`,
 *     `getSessionEffectiveCitations`, `getSessionCitationInDegree`) — a
 *     rolled-back or skipped turn's edges counted toward in-degree and
 *     appeared in citation listings the same as any live turn's.
 *   - `db/edge-signals.ts` filtered PART of one half: `was_rolled_back = 0`
 *     on the CITING (source) turn only, for all three signal queries
 *     (override/encodes/refines) — `status = 'skipped'` was never checked at
 *     all, and the CITED (target) turn's own liveness was never checked
 *     either, so a signal could still be computed FOR a rolled-back or
 *     skipped turn if a caller's `turnIds` happened to include one.
 *
 * Two-tier semantics (spec law 8):
 *
 *   - `was_rolled_back = 1` — DELETED. Permanent: no promotion path restores
 *     a rolled-back turn (contrast `skipped`, below). Never a node, never an
 *     edge endpoint, anywhere, ever.
 *   - `status = 'skipped'` — DORMANT. A reversible lifecycle floor: absent
 *     from every read side while skipped, restored WHOLE — its stored edges
 *     included, no re-judgment — the moment a late note promotes the turn
 *     back to `extracted` (or `provisional`, mid-turn) via `db/turns.ts`'s
 *     `promoteTurnFromNote`.
 *
 * The predicate reads `was_rolled_back`/`status` LIVE on every call, so
 * promotion needs no companion code anywhere: a skipped turn's edges were
 * never deleted, only hidden by this filter, and the moment `status` moves
 * off `'skipped'` the same query surfaces them again unchanged. This is also
 * why the SQL form below is a plain boolean expression rather than a
 * materialized set — every one of this ticket's three call sites composes it
 * inside a JOIN/WHERE against `turns` (or a joined alias of it), not against
 * rows already pulled into JS.
 *
 * A turn satisfying neither condition is "live" — the term every function
 * here and at the three call sites uses.
 */

export interface TurnLivenessFields {
  wasRolledBack: boolean;
  status: string;
}

/** True iff a turn (already read out as JS values) is neither deleted nor dormant. */
export function isLiveTurn(turn: TurnLivenessFields): boolean {
  return !turn.wasRolledBack && turn.status !== "skipped";
}

/**
 * The same predicate as a raw SQL boolean expression, for composing inside a
 * query that reads `turns` (or an aliased join of it) directly.
 *
 * `alias` is the table or join alias `was_rolled_back`/`status` are read
 * through; omit it (or pass `""`) for an unaliased `turns` reference in a
 * single-table query.
 */
export function liveTurnSql(alias = ""): string {
  const prefix = alias ? `${alias}.` : "";
  return `${prefix}was_rolled_back = 0 AND ${prefix}status != 'skipped'`;
}
