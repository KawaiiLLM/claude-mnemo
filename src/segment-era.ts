/**
 * The P2 era boundary (spec D11/D12, R2#7).
 *
 * A turn belongs to the segment era when it was created at or after the cutoff.
 * The comparison is per TURN, not per session: a session that was open across
 * the switch keeps rendering its old turns through the legacy path and its new
 * ones through the segment spine, because the two halves were written under
 * different semantics and no backfill reconciles them (spec D11: old data is
 * read-only and does not evolve). This is the task-causality-era precedent.
 *
 * Ticket 09 made it a WRITE gate as well as a read one, and deliberately reuses
 * this same function rather than restating the comparison: the turn whose note
 * `note` promotes onto the row must be exactly the turn the renderer draws as
 * era, or a turn could be written under one era's rules and read under the
 * other's. Read side — recall/timeline/settlement context; write side —
 * `mcp/note.ts` (promotion), gating title/content/insight only. Ticket 03
 * merged the retired `mcp/remember.ts` into `note`: `type`/`tags`/`grade`
 * write `turns` directly regardless of era (settlement and the main agent both
 * need to correct a legacy turn's grade/type/tags without a note ever
 * promoting its prose), same as `remember` always did before the merge.
 *
 * The cutoff is `null` in the product default, and `null` means EVERY turn is
 * legacy — every path guarded by this is therefore inert until an operator sets
 * an epoch, which is also the rollback.
 */
export function isSegmentEra(
  createdAtEpoch: number,
  cutoffEpoch: number | null | undefined,
): boolean {
  return (
    cutoffEpoch !== null &&
    cutoffEpoch !== undefined &&
    createdAtEpoch >= cutoffEpoch
  );
}

/** Normalize a configured/raw cutoff to the nullable epoch the readers take. */
export function normalizeEraCutoffEpoch(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

/**
 * The per-turn era GRANT column on `turns` (era-grant-by-settlement, ticket 01).
 *
 * Written once here so the SQL fragment below and the migration that adds the
 * column cannot disagree about its name.
 */
export const ERA_GRANT_COLUMN = "era_granted_at_epoch";

/**
 * MEMBER VISIBILITY under the era boundary — `isSegmentEra` widened by exactly
 * one fact, and used at exactly three query sites.
 *
 * This is deliberately NOT `isSegmentEra` and must never become it. That
 * predicate answers three separate questions across 13 call sites (record shape
 * — does a note promote onto `turns`; member visibility; extraction liveness),
 * and only the middle one moves. Widening the shared predicate would flip note
 * promotion and extraction liveness for every retroactively granted turn as an
 * unannounced side effect — 1090 of them at the time of writing.
 *
 * The widening fact: `created_at_epoch` is only a PROXY for "this turn was
 * annotated by the retired extraction subagent, under semantics that must not be
 * mixed with the current model's". A settlement backfill invalidates the proxy —
 * it re-annotates a pre-cutoff turn under the CURRENT model — and the grant is
 * the writer that actually knows saying so, durably, beside the turn. A turn
 * therefore reads as an era-side member when it was born in the era OR when it
 * carries a grant.
 *
 * The grant is an EPOCH, not a boolean, so "when did this turn become current"
 * stays answerable; `null` (or a non-positive value, which no real epoch is)
 * means never granted. `> 0` is the same admissibility test
 * `normalizeEraCutoffEpoch` above applies to the cutoff, and it is what lets the
 * SQL sibling below use a single `COALESCE(..., 0) > 0` and provably agree.
 *
 * `cutoffEpoch === null` answers FALSE here, matching `isSegmentEra`: with no
 * boundary recorded, nothing is era-side. The SQL sibling handles that case
 * differently ON PURPOSE — see its own note.
 */
export function isEraVisibleMember(
  createdAtEpoch: number,
  eraGrantedAtEpoch: number | null | undefined,
  cutoffEpoch: number | null | undefined,
): boolean {
  if (cutoffEpoch === null || cutoffEpoch === undefined) {
    return false;
  }
  return (
    isSegmentEra(createdAtEpoch, cutoffEpoch) ||
    (typeof eraGrantedAtEpoch === "number" && eraGrantedAtEpoch > 0)
  );
}

/**
 * The SQL sibling of `isEraVisibleMember`, for the member-read queries that
 * cannot call a TypeScript predicate row by row.
 *
 * Two forms of one rule, kept adjacent so neither can be edited without the
 * other in view; a test asserts they answer identically over the same rows.
 *
 * `cutoffEpoch === null` returns an EMPTY clause — no filter at all — rather
 * than the `false` the TypeScript form answers with. That is not a drift: it is
 * the member reads' own pre-existing rule ("with no cutoff there is no boundary
 * to respect and the whole membership renders", `rankSegmentMembers`' docstring),
 * and it is what keeps `E<n>` readable on a database that never recorded an era.
 * The predicate says what a turn IS; the clause says what the query FILTERS on,
 * and with no boundary there is nothing to filter.
 *
 * `alias` is the `turns` alias in the caller's FROM — passed in rather than
 * assumed, because the session-spine query joins `turns` twice.
 */
export function eraVisibleMemberSqlClause(
  alias: string,
  cutoffEpoch: number | null | undefined,
): { clause: string; params: number[] } {
  if (cutoffEpoch === null || cutoffEpoch === undefined) {
    return { clause: "", params: [] };
  }
  return {
    clause:
      `(${alias}.created_at_epoch >= ? ` +
      `OR COALESCE(${alias}.${ERA_GRANT_COLUMN}, 0) > 0)`,
    params: [cutoffEpoch],
  };
}
