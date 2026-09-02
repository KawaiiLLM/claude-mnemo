import { EDGE_RELATIONS, type TurnEdgeRelation } from "./turn-phase";

/**
 * The THREE-CLASS relation vocabulary (relation-vocabulary-v13 spec, ticket 02;
 * user ruling S15069/T2391 — "先直接落地 B,别测了,不如实际看看").
 *
 * WHAT REPLACED WHAT. Seven words (`override narrows extends indexes consume
 * grounds verifies`) collapse into three CLASSES, one of which carries a
 * coverage bit:
 *
 *   correct  (+ full | partial)   absorbs `override` (full) and `narrows` (partial)
 *   verify                        absorbs `verifies`
 *   use                           absorbs `extends`, `consume`, `grounds`, `indexes`
 *
 * The measured reason is in the spec: in two blind three-arm batteries every
 * citation a reader actually invoked as evidence was an `override` edge, and
 * `extends`/`consume` score 0 on both sides of the election's own frozen
 * weights. Seven words were paid for at write time and not harvested at read
 * time.
 *
 * THE DECIDING PROCEDURE IS A PRECEDENCE, NOT A PARTITION (spec, RESTATED
 * after peer review; user rulings S15069/T2300, T2305):
 *
 *   1. Does this output change the cited output's acceptance, reliability or
 *      scope?  negated or limited -> CORRECT; confirmed or supported -> VERIFY.
 *   2. Otherwise, is the cited output a DIRECT input to this new output? -> USE.
 *
 * So CORRECT and VERIFY are SUBSETS of USE, and the slot stores the MOST
 * SPECIFIC class. One row per pair: an edge that both corrected and built on
 * its target is CORRECT, and no second row is written for it.
 *
 * ## Storage — additive, and reversible by a READ-SIDE switch
 *
 * This module is the WHOLE mapping layer, and the storage decision it encodes
 * is what makes ticket 03's migration additive:
 *
 *   - `memory_edges.relation` KEEPS its seven-word CHECK, untouched. A new
 *     three-class write fills it from `INTERIM_LEGACY_RELATION` below.
 *   - `memory_edges.relation_class` / `relation_coverage` are the two ADDED
 *     columns. A new write fills them; every row written before this release
 *     carries `''` in both.
 *   - `edgeRelationClass()` is the ONE accessor: a row's class comes from the
 *     stored class when it has one, and from `LEGACY_RELATION_CLASS` (old word
 *     -> class + bit) when it does not. No reader forks on old-versus-new, and
 *     no reader asking for a CLASS keys on an old word for a new row.
 *
 * The alternative — putting the class word into `relation` itself and widening
 * the table's CHECK — was rejected: SQLite cannot alter a CHECK without a full
 * table rebuild (a heavy migration on the production edge table, which is
 * ticket 03's remit, not this ticket's); it would make every new edge INVISIBLE
 * on day one to the readers still keyed on the seven words (milestone election,
 * `db/edge-signals.ts`, the lane checker's coupling groups) unless all of them
 * were re-keyed here, which is ticket 05a's job; and ticket 03 would then have
 * to REWRITE `relation` in place on existing rows, so rollback would stop being
 * a read-side switch and become a data restore.
 */

/** The three classes a NEW edge write may carry. Ordered most specific first — the precedence's own order. */
export const RELATION_CLASSES = ["correct", "verify", "use"] as const;
export type RelationClass = (typeof RELATION_CLASSES)[number];

/**
 * CORRECT's coverage bit, defined by the READER'S ACTION (user ruling
 * S15069/T2305) rather than by how much text survives:
 *
 *   - `full`    — the cited principal result has no substantial part left that
 *                 may serve as a PREMISE for further reasoning or action; it
 *                 survives only as history. Permanent historical facts (it
 *                 dispatched something, it wrote a file, it ran a test) never
 *                 rescue it to `partial`.
 *   - `partial` — after the correction, a definite non-empty substantial part
 *                 still stands as a premise.
 */
export const RELATION_COVERAGES = ["full", "partial"] as const;
export type RelationCoverage = (typeof RELATION_COVERAGES)[number];

/** The stored "no coverage" value — `verify` and `use` rows, and every pre-v13 row. */
export const NO_RELATION_COVERAGE = "";
export type RelationCoverageValue = RelationCoverage | typeof NO_RELATION_COVERAGE;

/** The stored "not classified" value — every row written before this release. */
export const NO_RELATION_CLASS = "";
export type RelationClassValue = RelationClass | typeof NO_RELATION_CLASS;

export function isRelationClass(value: unknown): value is RelationClass {
  return typeof value === "string" && (RELATION_CLASSES as readonly string[]).includes(value);
}

export function isRelationCoverage(value: unknown): value is RelationCoverage {
  return typeof value === "string" && (RELATION_COVERAGES as readonly string[]).includes(value);
}

/**
 * The ONE class that carries a coverage bit. Stated as a predicate rather than
 * inlined as `=== "correct"` so the two refusals the write path owes — a
 * `correct` with no bit, a `verify`/`use` carrying one — read off the same
 * fact.
 */
export function relationClassRequiresCoverage(relationClass: RelationClass): boolean {
  return relationClass === "correct";
}

/**
 * OLD WORD -> class + bit. The single mapping every reader that wants a class
 * uses; nothing else in the tree may re-derive it.
 *
 * Complete over `EDGE_RELATIONS` by construction (the exhaustive `Record`), so
 * a word added to the storage vocabulary without a class here is a
 * compile-time error rather than a row that silently reads as unclassified.
 */
export const LEGACY_RELATION_CLASS: Record<
  TurnEdgeRelation,
  { relationClass: RelationClass; relationCoverage: RelationCoverageValue }
> = {
  override: { relationClass: "correct", relationCoverage: "full" },
  narrows: { relationClass: "correct", relationCoverage: "partial" },
  verifies: { relationClass: "verify", relationCoverage: NO_RELATION_COVERAGE },
  extends: { relationClass: "use", relationCoverage: NO_RELATION_COVERAGE },
  consume: { relationClass: "use", relationCoverage: NO_RELATION_COVERAGE },
  grounds: { relationClass: "use", relationCoverage: NO_RELATION_COVERAGE },
  indexes: { relationClass: "use", relationCoverage: NO_RELATION_COVERAGE },
};

/**
 * CLASS -> every stored word that means it, derived from the table above so the
 * two directions cannot disagree.
 *
 * This is what makes RETRACTION class-level and complete: `retractUse` deletes
 * a legacy `grounds`/`consume`/`indexes` row as readily as a new one. Leaving a
 * stored word with no retraction path is the E2 DEADLOCK this codebase already
 * paid for once (`db/citations.ts`'s `RETRACTION_ONLY_RELATIONS` carries the
 * full history) — a window owning a row it cannot delete can never commit.
 */
export const LEGACY_RELATIONS_BY_CLASS: Record<RelationClass, readonly TurnEdgeRelation[]> =
  Object.freeze({
    correct: EDGE_RELATIONS.filter(
      (word) => LEGACY_RELATION_CLASS[word].relationClass === "correct",
    ),
    verify: EDGE_RELATIONS.filter(
      (word) => LEGACY_RELATION_CLASS[word].relationClass === "verify",
    ),
    use: EDGE_RELATIONS.filter((word) => LEGACY_RELATION_CLASS[word].relationClass === "use"),
  });

/**
 * INTERIM (relation-vocabulary-v13 ticket 05a REPLACES THIS TABLE AND NOTHING
 * ELSE).
 *
 * class + coverage -> the seven-word value a NEW row's `relation` column
 * carries. It is the equivalence that keeps a three-class edge VISIBLE to every
 * reader still keyed on the old words — milestone election's frozen weight
 * tables (`shared/milestone-election.ts`), `db/edge-signals.ts`'s
 * `RELATION_IS_SCORED`, the lane checker's coupling groups, the SQL `IN`-lists
 * that filter on `EDGE_RELATIONS`.
 *
 *   correct/full    ~= override
 *   correct/partial ~= narrows
 *   verify          ~= verifies
 *   use             ~= extends
 *
 * `~=` and not `=`: `use` also absorbs `consume`, `grounds` and `indexes`, so
 * the mapping is onto a REPRESENTATIVE, not a bijection. Reading a new `use`
 * row back as `extends` is a deliberate interim reading, correct only because
 * the three absorbed words scored identically or not at all.
 *
 * Ticket 05a re-keys the election weights onto (class, coverage) directly and
 * deletes this table together with its one call site (`db/citations.ts`'s
 * `attachTurnRelations`). Nothing else reads it.
 */
export const INTERIM_LEGACY_RELATION: ReadonlyArray<{
  relationClass: RelationClass;
  relationCoverage: RelationCoverageValue;
  legacy: TurnEdgeRelation;
}> = Object.freeze([
  { relationClass: "correct", relationCoverage: "full", legacy: "override" },
  { relationClass: "correct", relationCoverage: "partial", legacy: "narrows" },
  { relationClass: "verify", relationCoverage: NO_RELATION_COVERAGE, legacy: "verifies" },
  { relationClass: "use", relationCoverage: NO_RELATION_COVERAGE, legacy: "extends" },
]);

/**
 * INTERIM (ticket 05a): the storage word a new (class, coverage) write lands
 * under. Throws rather than guessing — every caller has already validated the
 * pairing through `checkRelationCoverage` below, so an unmapped combination is
 * a programming error, not user input.
 */
export function interimLegacyRelation(
  relationClass: RelationClass,
  relationCoverage: RelationCoverageValue,
): TurnEdgeRelation {
  const entry = INTERIM_LEGACY_RELATION.find(
    (row) => row.relationClass === relationClass && row.relationCoverage === relationCoverage,
  );
  if (!entry) {
    throw new Error(
      `no interim legacy relation for class "${relationClass}" coverage "${relationCoverage}"`,
    );
  }
  return entry.legacy;
}

/** The shape `edgeRelationClass` reads — a stored row, however it was written. */
export interface RelationClassBearingRow {
  relation: TurnEdgeRelation | string | null;
  relationClass: RelationClassValue;
  relationCoverage: RelationCoverageValue;
}

/**
 * THE ONE ACCESSOR. A row's class, whether it was written under the three-class
 * vocabulary or under the seven words.
 *
 * `null` for a BARE row (`relation IS NULL` — the prose-citation index, which
 * carries no relation at all) and for a stored word outside the vocabulary
 * (pre-migration stock, which the lane checker already reports as a warning and
 * admits to no graph).
 */
export function edgeRelationClass(
  row: RelationClassBearingRow,
): { relationClass: RelationClass; relationCoverage: RelationCoverageValue } | null {
  if (isRelationClass(row.relationClass)) {
    return {
      relationClass: row.relationClass,
      relationCoverage: isRelationCoverage(row.relationCoverage)
        ? row.relationCoverage
        : NO_RELATION_COVERAGE,
    };
  }
  if (row.relation === null) {
    return null;
  }
  return LEGACY_RELATION_CLASS[row.relation as TurnEdgeRelation] ?? null;
}

/**
 * How a class reads in one token: `correct(full)`, `correct(partial)`,
 * `verify`, `use`. One spelling for every surface that renders an edge, so the
 * word a writer is taught is the word it reads back.
 */
export function formatRelationClass(
  relationClass: RelationClass,
  relationCoverage: RelationCoverageValue,
): string {
  return relationCoverage === NO_RELATION_COVERAGE
    ? relationClass
    : `${relationClass}(${relationCoverage})`;
}

/**
 * What a renderer prints for one stored row.
 *
 * A CLASSIFIED row prints its class; an unclassified legacy row prints the word
 * it was written under, UNCHANGED. That asymmetry is deliberate and is what
 * keeps ticket 03's migration honest: a legacy row renders exactly as it did
 * before this release until that ticket classifies it, so nothing about the
 * existing corpus's rendering moves on this release.
 */
export function displayEdgeRelation(row: RelationClassBearingRow): string {
  if (isRelationClass(row.relationClass)) {
    return formatRelationClass(
      row.relationClass,
      isRelationCoverage(row.relationCoverage) ? row.relationCoverage : NO_RELATION_COVERAGE,
    );
  }
  return row.relation ?? "";
}

/** Why a (class, coverage) pair was refused. */
export type RelationCoverageRejection = "coverage-required" | "coverage-not-allowed";

/**
 * The coverage contract, in ONE place because both write surfaces owe it:
 * `correct` needs its bit, `verify`/`use` may not carry one.
 *
 * The bit is a STORED FIELD, not prose (ticket 02): a reader deciding "can I
 * still rely on the cited claim" must get that answer from the row, so a
 * `correct` that never said which kind of correction it was is refused at the
 * write surface rather than stored half-answered.
 */
export function checkRelationCoverage(
  relationClass: RelationClass,
  relationCoverage: RelationCoverageValue,
): RelationCoverageRejection | null {
  if (relationClassRequiresCoverage(relationClass)) {
    return relationCoverage === NO_RELATION_COVERAGE ? "coverage-required" : null;
  }
  return relationCoverage === NO_RELATION_COVERAGE ? null : "coverage-not-allowed";
}

/**
 * THE RETIRED PARAMETER NAMES, and what to write instead
 * (relation-vocabulary-v13 ticket 02).
 *
 * A caller that sends `override` must be told the WORD, not just that the key
 * is unknown: this codebase's own standing lesson is that a stale teacher
 * anywhere — a cached tool schema, a prompt an old worker still holds, a habit
 * — produces a call the model cannot repair from "unrecognized key". The
 * suggestion is what makes the refusal actionable in one round trip.
 *
 * Both halves are listed, assertion and `retract…` mirror, because a settlement
 * run mid-flight may hold either.
 */
export const RETIRED_RELATION_FIELDS: ReadonlyArray<
  readonly [retired: string, replacement: string]
> = Object.freeze([
  ["override", 'correct with `"coverage": "full"`'],
  ["narrows", 'correct with `"coverage": "partial"`'],
  ["extends", "use"],
  ["consume", "use"],
  ["grounds", "use"],
  ["indexes", "use — convergence is no longer declared; cite what you used"],
  ["verifies", "verify"],
  ["retractOverride", "retractCorrect"],
  ["retractNarrows", "retractCorrect"],
  ["retractExtends", "retractUse"],
  ["retractConsume", "retractUse"],
  ["retractGrounds", "retractUse"],
  ["retractIndexes", "retractUse"],
  ["retractVerifies", "retractVerify"],
]);

/**
 * The refusal one write surface returns for a call carrying retired relation
 * parameters — ONE message for both writers, so `note` and the settlement
 * facade cannot answer the same mistake two different ways.
 *
 * Returns null when the call carries none, which is the ordinary case and the
 * only cost this check adds to it.
 */
export function retiredRelationFieldRefusal(
  input: Readonly<Record<string, unknown>>,
): string | null {
  const reached = RETIRED_RELATION_FIELDS.filter(
    ([retired]) => input[retired] !== undefined,
  );
  if (reached.length === 0) {
    return null;
  }
  const named = reached
    .map(([retired, replacement]) => `${retired} -> ${replacement}`)
    .join("; ");
  return (
    `${reached.length === 1 ? "is a" : "are"} retired relation parameter` +
    `${reached.length === 1 ? "" : "s"}: ${named}. The seven relation words are ` +
    "replaced by THREE CLASSES — `correct` (carrying a `coverage` of `full` or " +
    "`partial`), `verify`, `use` — decided by precedence: does this output change " +
    "the cited result's acceptance, reliability or scope (negated/limited = " +
    "correct, confirmed/supported = verify)? otherwise, is the cited result a " +
    "direct input to it (= use)? Nothing was written."
  );
}
