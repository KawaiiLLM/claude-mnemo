import type { Database } from "bun:sqlite";

import {
  MAIN_AGENT_EDGES_CUTOVER_DDL_ARCHIVE,
  MAIN_AGENT_EDGES_CUTOVER_RECEIPT,
  MAIN_AGENT_EDGES_CUTOVER_STATE_TABLE,
  MAIN_AGENT_EDGES_TURN_TAGS_RECEIPT,
} from "../../src/db/main-agent-edges-cutover";

/**
 * Put a database `initializeSchema` has just finished back into the
 * PRE-CUTOVER shape (main-agent-edges spec D9, ticket 01), so a test can seed
 * the legacy stock the cutover exists to fold, clear and delete, then run the
 * cutover against it.
 *
 * `memory_edges` goes back to the seven-word `relation` column with the
 * `(pair, relation, tail, head)` UNIQUE key, the bare-pair index and the two
 * ALTER-added class columns; `turns.tags` goes back to nullable with no
 * trigger; the cutover's state marker and receipt are removed so the next
 * `runMainAgentEdgesCutover` / `initializeSchema` finds a database that owes
 * the migration.
 *
 * The DDL below is a LITERAL copy of the pre-cutover shape, deliberately not
 * imported from any production builder (`tests/support/pre-v12-edge-shape.ts`
 * states the rule: a fixture describing an OLD shape must not follow the
 * generator that produces the new one). The seven words appear here as the
 * old CHECK's own text; the raw-word gate is over `src/`, not `tests/`.
 *
 * Existing `memory_edges` rows are CARRIED ACROSS, not dropped: a fixture that
 * has already written through the live path and then wants one legacy row
 * beside it must not lose the first. The word column each row needs is
 * reconstructed from its class pair by inverting the v13 backfill — lossy in
 * the direction that backfill was many-to-one (every `use` comes back as
 * `grounds`), which is all the old column can say about a row whose
 * distinguishing word is gone.
 */
export function downgradeToPreCutoverShape(db: Database): void {
  const alreadyDowngraded = db
    .query<{ name: string }, []>("SELECT name FROM pragma_table_info('memory_edges')")
    .all()
    .some((column) => column.name === "relation");
  if (alreadyDowngraded) {
    // Idempotent: a second call must not drop the legacy rows the first one
    // let a fixture seed.
    return;
  }
  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    const carriedRows = db
      .query<{ name: string }, []>("SELECT name FROM pragma_table_info('memory_edges')")
      .all()
      .some((column) => column.name === "relation_class")
      ? db
          .query<
            {
              citingKind: string;
              citingId: number;
              citedKind: string;
              citedId: number;
              relation: string | null;
              provenance: string;
              tailTag: string;
              headTag: string;
              relationClass: string;
              relationCoverage: string;
              createdAtEpoch: number;
            },
            []
          >(
            `SELECT citing_kind AS citingKind, citing_id AS citingId,
                    cited_kind AS citedKind, cited_id AS citedId,
                    CASE relation_class
                      WHEN 'correct' THEN CASE relation_coverage WHEN 'full' THEN 'override' ELSE 'narrows' END
                      WHEN 'verify' THEN 'verifies'
                      WHEN 'use' THEN 'grounds'
                      ELSE NULL
                    END AS relation,
                    provenance, tail_tag AS tailTag, head_tag AS headTag,
                    relation_class AS relationClass, relation_coverage AS relationCoverage,
                    created_at_epoch AS createdAtEpoch
               FROM memory_edges ORDER BY id`,
          )
          .all()
      : [];
    db.exec("DROP TABLE IF EXISTS memory_edges");
    db.exec(`
      CREATE TABLE memory_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        citing_kind TEXT NOT NULL CHECK (citing_kind IN ('turn', 'segment', 'session')),
        citing_id INTEGER NOT NULL,
        cited_kind TEXT NOT NULL CHECK (cited_kind IN ('turn', 'segment')),
        cited_id INTEGER NOT NULL,
        relation TEXT CHECK (
          relation IS NULL OR
          relation IN ('override', 'narrows', 'extends', 'indexes', 'consume', 'grounds', 'verifies')
        ),
        provenance TEXT NOT NULL CHECK (
          provenance IN ('retrieval', 'text-ref', 'rollback', 'judged', 'asserted')
        ),
        tail_tag TEXT NOT NULL DEFAULT '',
        head_tag TEXT NOT NULL DEFAULT '',
        created_at_epoch INTEGER NOT NULL,
        relation_class TEXT NOT NULL DEFAULT '' CHECK (relation_class IN ('', 'correct', 'verify', 'use')),
        relation_coverage TEXT NOT NULL DEFAULT '' CHECK (relation_coverage IN ('', 'full', 'partial') AND (relation_coverage = '') = (relation_class <> 'correct')),
        CHECK (citing_kind <> cited_kind OR citing_id <> cited_id),
        CHECK (relation IS NULL OR (citing_kind = 'turn' AND cited_kind = 'turn')),
        UNIQUE (citing_kind, citing_id, cited_kind, cited_id, relation, tail_tag, head_tag)
      )
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memory_edges_cited
        ON memory_edges(cited_kind, cited_id, relation)
    `);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_edges_bare_pair
        ON memory_edges(citing_kind, citing_id, cited_kind, cited_id)
        WHERE relation IS NULL
    `);
    for (const row of carriedRows) {
      seedPreCutoverEdge(db, {
        citingKind: row.citingKind,
        citingId: row.citingId,
        citedKind: row.citedKind,
        citedId: row.citedId,
        relation: row.relation,
        relationClass: row.relationClass as "correct" | "verify" | "use" | "",
        relationCoverage: row.relationCoverage as "full" | "partial" | "",
        provenance: row.provenance,
        tailTag: row.tailTag,
        headTag: row.headTag,
        createdAtEpoch: row.createdAtEpoch,
      });
    }

    downgradeTurnsTagsToPreCutover(db);

    db.query<unknown, [string]>("DELETE FROM migration_receipts WHERE name = ?").run(
      MAIN_AGENT_EDGES_CUTOVER_RECEIPT,
    );
    db.exec(`DELETE FROM ${MAIN_AGENT_EDGES_CUTOVER_STATE_TABLE}`);
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
}

/**
 * `turns.tags` back to the PRE-CUTOVER shape: nullable, no invariant trigger.
 *
 * Split out of `downgradeToPreCutoverShape` because a test of a migration that
 * ran BEFORE the cutover needs only this half — it seeds the malformed and
 * NULL tag values that migration was written to meet, and the cutover's
 * trigger (transform 1) refuses both. Every other trigger and index on the
 * table is re-created from its own stored text, so nothing but the invariant
 * is removed.
 *
 * The tags-normalisation receipt goes with the shape (ticket 12): a database
 * put back where malformed values are legal OWES that migration again, and
 * leaving the receipt would make the next `initializeSchema` skip the one step
 * this downgrade exists to exercise.
 *
 * Idempotent: a table already carrying a nullable `tags` is left untouched.
 */
export function downgradeTurnsTagsToPreCutover(db: Database): void {
  db.query<unknown, [string]>("DELETE FROM migration_receipts WHERE name = ?").run(
    MAIN_AGENT_EDGES_TURN_TAGS_RECEIPT,
  );
  const tagsColumn = db
    .query<{ name: string; notnull: number }, []>("PRAGMA table_info(turns)")
    .all()
    .find((column) => column.name === "tags");
  if (tagsColumn === undefined || tagsColumn.notnull === 0) {
    return;
  }
  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    const triggers = db
      .query<{ name: string; sql: string | null }, []>(
        `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'turns'`,
      )
      .all()
      .filter((row) => !row.name.startsWith("turns_tags_string_array_"));
    const indexes = db
      .query<{ sql: string | null }, []>(
        `SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'turns' AND sql IS NOT NULL`,
      )
      .all();
    const columns = db
      .query<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }, []>(
        "PRAGMA table_info(turns)",
      )
      .all();
    const columnDdl = columns
      .map((column) => {
        if (column.name === "tags") {
          return "tags TEXT";
        }
        if (column.pk === 1) {
          return `${column.name} ${column.type} PRIMARY KEY AUTOINCREMENT`;
        }
        return (
          `${column.name} ${column.type}` +
          (column.notnull ? " NOT NULL" : "") +
          (column.dflt_value !== null ? ` DEFAULT ${column.dflt_value}` : "")
        );
      })
      .join(",\n        ");
    const names = columns.map((column) => column.name).join(", ");
    db.exec(`CREATE TABLE turns_pre_cutover (
        ${columnDdl},
        UNIQUE(session_id, prompt_number)
      )`);
    db.query(`INSERT INTO turns_pre_cutover (${names}) SELECT ${names} FROM turns`).run();
    db.exec("DROP TABLE turns");
    db.exec("ALTER TABLE turns_pre_cutover RENAME TO turns");
    for (const index of indexes) {
      db.exec(index.sql!);
    }
    for (const trigger of triggers) {
      db.exec(trigger.sql!);
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
}

/** A legacy-shaped row: the seven-word column plus the class columns, exactly as the v13 backfill left production. */
export interface PreCutoverEdgeSeed {
  citingId: number;
  citedId: number;
  relation: string | null;
  relationClass?: "correct" | "verify" | "use" | "";
  relationCoverage?: "full" | "partial" | "";
  tailTag?: string;
  headTag?: string;
  provenance?: string;
  createdAtEpoch?: number;
  citingKind?: string;
  citedKind?: string;
}

export function seedPreCutoverEdge(db: Database, seed: PreCutoverEdgeSeed): number {
  return db
    .query<
      { id: number },
      [string, number, string, number, string | null, string, string, string, string, string, number]
    >(
      `INSERT INTO memory_edges
         (citing_kind, citing_id, cited_kind, cited_id, relation, provenance,
          tail_tag, head_tag, relation_class, relation_coverage, created_at_epoch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .get(
      seed.citingKind ?? "turn",
      seed.citingId,
      seed.citedKind ?? "turn",
      seed.citedId,
      seed.relation,
      seed.provenance ?? "asserted",
      seed.tailTag ?? "",
      seed.headTag ?? "",
      seed.relationClass ?? "",
      seed.relationCoverage ?? "",
      seed.createdAtEpoch ?? 400,
    )!.id;
}

/**
 * The `memory_edges` table as it stood at the INSTANT BEFORE the cutover
 * rebuilt it — its DDL and every row, read back out of the cutover's own
 * receipt archive (`main_agent_edges_cutover_ddl_archive` /
 * `..._edge_archive`).
 *
 * WHY EVERY OLDER MIGRATION TEST READS THROUGH THIS. `initializeSchema` now
 * ENDS with the cutover, so a test that seeds a pre-v12 (or older) table and
 * calls it can no longer observe the intermediate table an earlier migration
 * produced: by the time control returns, `memory_edges` has no `relation`
 * column and one row per pair. The archive is that intermediate state,
 * preserved verbatim and on purpose — it is what a rollback restores — so the
 * migration under test is asserted against the same bytes it actually wrote,
 * and the assertion doubles as evidence that the receipt is complete.
 *
 * A database whose cutover DEFERRED (D9's claim fence) or that predates the
 * cutover has no archive; the accessors below return `null` / `[]` so a caller
 * can tell that apart from "the migration wrote nothing".
 */
export function preCutoverTableSql(db: Database, tableName = "memory_edges"): string | null {
  const row = db
    .query<{ sql: string | null }, [string, string]>(
      `SELECT sql FROM ${MAIN_AGENT_EDGES_CUTOVER_DDL_ARCHIVE}
        WHERE kind = 'table' AND name = ? AND tbl_name = ?`,
    )
    .get(tableName, tableName);
  return row?.sql ?? null;
}
