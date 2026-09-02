/**
 * 05a measurement, step 0 — bring the production CLONE up to HEAD's schema.
 *
 * The clone (`repro/copy.db`, APFS-cloned) predates ticket 02's ALTER, so it
 * carries no `relation_class`/`relation_coverage` columns at all and every
 * reader that selects them would throw. One `initializeDatabase` adds them and
 * runs ticket 03's receipt-guarded classification sweep. HEAD's own readers key
 * on the stored WORD, so the sweep cannot move the baseline — it only makes the
 * columns present for the class-keyed readers 05a introduces.
 *
 * Usage: bun run prepare-db.ts <db>
 */
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../../../../src/db/schema";

const path = process.argv[2];
if (!path) throw new Error("usage: prepare-db.ts <db>");
const db = new Database(path);
const t0 = performance.now();
initializeDatabase(db);
console.log(`initializeDatabase: ${((performance.now() - t0) / 1000).toFixed(2)}s`);
const cols = db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('memory_edges')").all();
console.log("memory_edges columns:", cols.map((c) => c.name).join(", "));
console.log(
  "class histogram:",
  JSON.stringify(
    db
      .query("SELECT relation_class AS c, relation_coverage AS v, COUNT(*) AS n FROM memory_edges GROUP BY 1,2 ORDER BY 1,2")
      .all(),
  ),
);
db.close();
