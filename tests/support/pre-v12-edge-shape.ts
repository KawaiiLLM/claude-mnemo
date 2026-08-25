import type { Database } from "bun:sqlite";

/**
 * Put `memory_edges` back into its PRE-v12 shape: `tags` and no
 * `tail_tag`/`head_tag`, plus the `memory_edge_tags` index that era kept
 * beside it.
 *
 * Ticket 09 made this a real INVERSE rather than a column drop. The live
 * table no longer stores a merged set at all, so the copy below RECONSTRUCTS
 * one from the two sides — `[tag]` when both name the same lane, `[]`
 * otherwise — which is exactly `projectSideTagsToTagSet`, the dual-write
 * projection that ticket retired. It is stated here as SQL rather than
 * imported because a fixture that followed the production helper wherever it
 * went next would stop describing the old shape the moment the helper moved,
 * which is the one thing a "what the old shape was" fixture must not do. The
 * reconstruction is lossy in exactly the way the old column was: a CROSSING
 * comes back as untagged, because that is all v11 could ever have stored for
 * it.
 *
 * Why any test needs this. `initializeSchema` now finishes with M-A
 * (lane-model-v12 ticket 05), so every database it returns is two-sided —
 * while ticket 01's ordering barrier refuses to run a PENDING lane-registry
 * phase against a table that has already taken that shape. The two together
 * mean the batch's older "initialize the real schema, then reset the receipt
 * gate" idiom now describes a state no upgrade path can produce: a database
 * whose edge columns moved before its registry migration ran. The barrier is
 * right to refuse it, so the fixture moves the shape back too, and the test
 * exercises the phases against the table they were written against.
 *
 * Rebuild rather than `ALTER TABLE ... DROP COLUMN`: both columns are part of
 * the identity UNIQUE, which SQLite refuses to drop out from under. The DDL
 * below is deliberately a literal copy of the pre-ticket-05 shape (narrow
 * identity key, ticket 03's seven-word CHECK) — a fixture that imported the
 * production builder would follow it wherever it goes next, which is the one
 * thing a "what the old shape was" fixture must not do.
 *
 * Idempotent: a table that is already one-sided is left untouched.
 */
export function downgradeToPreV12EdgeShape(db: Database): void {
  const columns = db
    .query<{ name: string }, []>("SELECT name FROM pragma_table_info('memory_edges')")
    .all()
    .map((row) => row.name);
  if (columns.length === 0 || !columns.includes("tail_tag")) {
    return;
  }

  // Same suspension every rebuild in db/schema.ts uses: `memory_edge_tags`
  // references `memory_edges(id)` with ON DELETE CASCADE, and the DROP below
  // would otherwise take its rows with it.
  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    db.exec(`
      CREATE TABLE memory_edges_pre_v12_rebuild (
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
        tags TEXT NOT NULL DEFAULT '[]' CHECK (
          json_valid(tags) AND json_type(tags) = 'array'
        ),
        created_at_epoch INTEGER NOT NULL,
        CHECK (citing_kind <> cited_kind OR citing_id <> cited_id OR relation IS NOT NULL),
        UNIQUE (citing_kind, citing_id, cited_kind, cited_id, relation, tags)
      );

    `);

    // Prepared-and-run, never `exec`: bun:sqlite's multi-statement `exec`
    // SWALLOWS a constraint failure in the middle of the batch and carries on
    // with the statements after it — measured here, and it silently emptied
    // this very table on the first draft of this helper.
    //
    // CHECK enforcement suspended for the copy, the same way the fixtures
    // that WRITE these rows suspend it: a `tags` payload that is not a
    // readable JSON array is precisely what the ticket 13 disposal tests put
    // in the table, and a fixture that could not carry such a row across
    // would silently delete the case under test.
    db.exec("PRAGMA ignore_check_constraints = ON;");
    try {
      db.query(
        `INSERT INTO memory_edges_pre_v12_rebuild (
           id, citing_kind, citing_id, cited_kind, cited_id,
           relation, provenance, tags, created_at_epoch
         )
         SELECT id, citing_kind, citing_id, cited_kind, cited_id,
                relation, provenance,
                CASE WHEN tail_tag <> '' AND tail_tag = head_tag
                     THEN json_array(tail_tag) ELSE '[]' END,
                created_at_epoch
         FROM memory_edges`,
      ).run();
    } finally {
      db.exec("PRAGMA ignore_check_constraints = OFF;");
    }

    db.exec(`
      DROP TABLE memory_edges;
      ALTER TABLE memory_edges_pre_v12_rebuild RENAME TO memory_edges;

      CREATE INDEX IF NOT EXISTS idx_memory_edges_cited
        ON memory_edges(cited_kind, cited_id, relation);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_edges_bare_pair
        ON memory_edges(citing_kind, citing_id, cited_kind, cited_id)
        WHERE relation IS NULL;

      DELETE FROM memory_edge_side_tags;

      CREATE TABLE IF NOT EXISTS memory_edge_tags (
        edge_row_id INTEGER NOT NULL REFERENCES memory_edges(id) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        PRIMARY KEY (edge_row_id, tag)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_edge_tags_tag
        ON memory_edge_tags(tag, edge_row_id);
      DELETE FROM memory_edge_tags;
    `);

    // The era's index, repopulated from the era's column — the registry
    // migration's M4 deletes rows from it by edge id, so a fixture that left
    // it empty would make that phase's own maintenance untestable.
    db.query(
      `INSERT INTO memory_edge_tags (edge_row_id, tag)
       SELECT memory_edges.id, tag_value.value
       FROM memory_edges, json_each(memory_edges.tags) AS tag_value`,
    ).run();
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
}
