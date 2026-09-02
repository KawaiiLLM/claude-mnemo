import type { Database } from "bun:sqlite";

import type { RelationClass, RelationCoverageValue } from "../../src/shared/relation-class";
import { fixtureRelationClass } from "./lane-edge-fixtures";

/**
 * Insert ONE `memory_edges` row in the POST-CUTOVER shape (main-agent-edges
 * spec D1/D9): class and coverage columns, no `relation` word column, one row
 * per `(citing, cited)` pair.
 *
 * WHY THIS EXISTS. Before the cutover every DB fixture spelled its edge as a
 * seven-word `relation` literal inside its own `INSERT INTO memory_edges`.
 * The column is gone, so each of those statements would now fail to prepare.
 * Rather than let ~50 fixtures each restate the new column list — and drift
 * from it — they call this. A fixture may still spell the old WORD (`relation`)
 * and have it translated by `fixtureRelationClass`, the tests-side mirror of
 * the migration literal, or state `relationClass`/`relationCoverage` directly.
 *
 * A word the vocabulary never knew (`supersedes`) yields NO class: the row
 * lands with `relation_class = ''`, which is the shape a pre-cutover wordless
 * row has and which every class-bearing reader must keep out of its graph.
 * That row can only be written while the CHECK still admits `''` — a fixture
 * that wants it on the rebuilt table must seed through
 * `tests/support/pre-cutover-edge-shape.ts` instead.
 */
export interface EdgeRowSeed {
  citingKind?: string;
  citingId: number;
  citedKind?: string;
  citedId: number;
  /** A legacy storage word, translated. Mutually exclusive with `relationClass`. */
  relation?: string;
  relationClass?: RelationClass | "";
  relationCoverage?: RelationCoverageValue;
  provenance?: string;
  tailTag?: string;
  headTag?: string;
  createdAtEpoch?: number;
}

export function insertEdgeRow(db: Database, seed: EdgeRowSeed): number {
  const { relationClass, relationCoverage } = fixtureRelationClass(seed);
  return db
    .query<
      { id: number },
      [string, number, string, number, string, string, string, string, string, number]
    >(
      `INSERT INTO memory_edges
         (citing_kind, citing_id, cited_kind, cited_id,
          relation_class, relation_coverage, provenance, tail_tag, head_tag, created_at_epoch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .get(
      seed.citingKind ?? "turn",
      seed.citingId,
      seed.citedKind ?? "turn",
      seed.citedId,
      relationClass,
      relationCoverage,
      seed.provenance ?? "asserted",
      seed.tailTag ?? "",
      seed.headTag ?? "",
      seed.createdAtEpoch ?? 0,
    )!.id;
}

/**
 * The class half of a `writeMemoryEdges` input, from a fixture's legacy word.
 * `WriteEdgeInput.relationClass` is REQUIRED after the cutover, so a fixture
 * that still names `extends`/`grounds`/… spreads this instead of restating the
 * translation.
 */
export function wordEdgeClass(relation: string): {
  relationClass: RelationClass;
  relationCoverage: RelationCoverageValue;
} {
  const { relationClass, relationCoverage } = fixtureRelationClass({ relation });
  if (relationClass === "") {
    throw new Error(`fixture relation word has no class: ${relation}`);
  }
  return { relationClass, relationCoverage };
}
