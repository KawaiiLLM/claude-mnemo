/**
 * The THREE-CLASS relation vocabulary (relation-vocabulary-v13 spec, ticket 02;
 * user ruling S15069/T2391 — "先直接落地 B,别测了,不如实际看看").
 *
 * An edge is a fact about two nodes: citing, cited, CLASS, coverage. This
 * module is the whole of the class vocabulary — the three classes, the
 * coverage bit that only one of them carries, the ONE accessor a stored row is
 * read through, and its SQL form.
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
 * ## Storage, after the main-agent-edges cutover (spec D1, ticket 01)
 *
 * `memory_edges.relation_class` is NOT NULL and CHECKed to the three classes;
 * `relation_coverage` is `full`/`partial` on a `correct` row and `''` on every
 * other. The seven-word `relation` column, the legacy word -> class bridge
 * (`LEGACY_RELATION_CLASS`), the interim write-side fill
 * (`interimLegacyRelation`) and the retired-parameter refusal table all left
 * with that column. The seven words survive in exactly one place —
 * `db/schema.ts`, as a frozen migration literal for a database that predates
 * the three-class backfill — and nothing at runtime names one.
 *
 * ONE WINDOW in which a row can still carry NO class: D9's durable fence
 * defers the cutover while a settlement claim is live, and every initializer
 * proceeds on the OLD schema until the claim set drains. In that window the
 * pre-cutover wordless rows (`relation_class = ''`) still exist and every
 * class-bearing row already carries its class (the backfill ran before the
 * fence is ever consulted). `edgeRelationClass` answers `null` for such a row
 * and `relationClassBearingSql` excludes it — after the cutover both are
 * tautologies on a table whose CHECK admits nothing else.
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

/** The stored "no coverage" value — `verify` and `use` rows. */
export const NO_RELATION_COVERAGE = "";
export type RelationCoverageValue = RelationCoverage | typeof NO_RELATION_COVERAGE;

/**
 * The stored "not classified" value. After the cutover no `memory_edges` row
 * carries it (the column is NOT NULL and CHECKed to the three classes); it
 * survives as a TYPE because rows read in the deferral window (module header)
 * and receipt tables that copy an old row still can.
 */
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

/** The shape `edgeRelationClass` reads — a stored row's two class columns. */
export interface RelationClassBearingRow {
  relationClass: RelationClassValue;
  relationCoverage: RelationCoverageValue;
}

/**
 * THE ONE ACCESSOR. A row's class, or `null` for a row that carries none —
 * reachable only in the deferral window (module header), where a pre-cutover
 * wordless row still stands with `relation_class = ''`.
 */
export function edgeRelationClass(
  row: RelationClassBearingRow,
): { relationClass: RelationClass; relationCoverage: RelationCoverageValue } | null {
  if (!isRelationClass(row.relationClass)) {
    return null;
  }
  return {
    relationClass: row.relationClass,
    relationCoverage: isRelationCoverage(row.relationCoverage)
      ? row.relationCoverage
      : NO_RELATION_COVERAGE,
  };
}

/**
 * `edgeRelationClass`, EXPRESSED AS SQL — "this row resolves to a relation
 * class", for a loader that has to narrow in the database rather than in JS.
 *
 * After the cutover this is a tautology (the CHECK admits nothing else); in the
 * deferral window it is what keeps the pre-cutover wordless rows out of every
 * graph. Every loader keeps calling it rather than dropping the predicate so
 * that the two states read the same code.
 */
export function relationClassBearingSql(alias: string): string {
  const classes = RELATION_CLASSES.map((value) => `'${value}'`).join(", ");
  return `(${alias}.relation_class IN (${classes}))`;
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
 * What a renderer prints for one stored row: its class token, or `''` for a
 * row that carries no class (deferral window only).
 */
export function displayEdgeRelation(row: RelationClassBearingRow): string {
  const resolved = edgeRelationClass(row);
  return resolved === null
    ? ""
    : formatRelationClass(resolved.relationClass, resolved.relationCoverage);
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
