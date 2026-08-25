import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * lane-model-v12 ticket 09, first checkbox: "the old column is deleted; not
 * one residual reader remains, pinned with grep sentinels so it cannot come
 * back."
 *
 * This is the SOURCE-side half of that pin. The other half is behavioural and
 * lives in `tests/db/memory-edges.test.ts` ("no merged lane column and no
 * merged index survive a full open"), which reads the stored table rather than
 * the code — the two catch different regressions. A reader re-added in
 * TypeScript reddens this file; a column re-added by a migration that nobody
 * re-read reddens that one, which is exactly how the contraction was found to
 * be undone on reopen by `memoryEdgesTagSetIdentityIsStale`'s DDL-text probe.
 *
 * WHY A GREP AND NOT A TYPE. `MemoryEdge.tags` is gone, so `edge.tags` is a
 * compile error today — but nothing stops a future reader from re-deriving
 * the same weaker fact under another name from raw SQL, and raw SQL is
 * type-free. Every pattern below is a way the merged set was actually spelled
 * somewhere in this repository before this ticket.
 *
 * ONE SPELLING IS DELIBERATELY ABSENT: a bare `edge.tags`. The CHECKER's own
 * report shapes (`LaneBypassEdge.tags`, `LaneTimeOrderViolation.tags`) still
 * carry a field by that name, and it is not this one — it holds `laneEdgeTags`,
 * the canonical set DERIVED from the two sides for display. Matching on it
 * would flag those renderers forever while catching nothing, and the storage
 * read it would catch is already a compile error, `MemoryEdge.tags` and
 * `LaneEdgeInput.tags` both being gone.
 */

/**
 * The TWO files that may still name the retired surface: they are the
 * migration era itself. `db/schema.ts` holds M-A (which reads the old column
 * to derive the two sides) and M-E (which drops both); `db/lanes.ts` holds the
 * lane-registry phases M0/M4 and the v12 M-B, all of which run, by the
 * ordering barrier's own guarantee, strictly before the column moves.
 */
const MIGRATION_ERA_FILES = new Set(["src/db/schema.ts", "src/db/lanes.ts"]);

/** Each is a spelling the merged set really had in this repository before ticket 09. */
const RESIDUAL_READS: Array<{ pattern: RegExp; what: string }> = [
  { pattern: /\bmemory_edge_tags\b/, what: "the retired merged index table" },
  { pattern: /\bmemory_edges\.tags\b/, what: "the retired column, qualified" },
  { pattern: /\bme\.tags\b/, what: "the retired column, under the `me` alias" },
  { pattern: /\be\.tags\b/, what: "the retired column, under the `e` alias" },
  {
    pattern: /provenance,\s*tags\b/,
    what: "the retired column in a memory_edges column list",
  },
  {
    pattern: /\bprojectSideTagsToTagSet\b/,
    what: "the retired dual-write projection",
  },
  {
    pattern: /\brebuildMemoryEdgeTagsIndex\b/,
    what: "the retired merged index's rebuild",
  },
  { pattern: /\bgetEdgesByTag\b/, what: "the retired merged index's read-back" },
];

function sourceFiles(directory: string, into: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      sourceFiles(path, into);
    } else if (entry.endsWith(".ts")) {
      into.push(path);
    }
  }
  return into;
}

/**
 * Comments are stripped before matching: several of these files discuss the
 * retired surface at length — deliberately, since "why it went" is the part a
 * future reader needs — and prose is not a read.
 */
function codeOf(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

describe("the merged edge tag set has no readers left (lane-model-v12 ticket 09)", () => {
  const files = sourceFiles(join(process.cwd(), "src")).map((absolute) =>
    absolute.slice(process.cwd().length + 1),
  );

  test("the sentinel is looking at a real tree", () => {
    expect(files.length).toBeGreaterThan(50);
    for (const migrationEra of MIGRATION_ERA_FILES) {
      expect(files).toContain(migrationEra);
    }
  });

  test("no file outside the migration era names the retired column, its index or its helpers", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (MIGRATION_ERA_FILES.has(file)) {
        continue;
      }
      const code = codeOf(file);
      for (const { pattern, what } of RESIDUAL_READS) {
        if (pattern.test(code)) {
          offenders.push(`${file}: ${what} (${pattern})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The storage layer itself, held to the stricter rule: not even in prose.
   * `db/memory-edges.ts` is where a reader looks first to learn what an edge
   * stores, so a mention of a table that no longer exists is a wrong answer
   * even when it is only a comment. (`memory_edge_side_tags` contains the
   * retired name as a substring, hence the word boundaries.)
   */
  test("db/memory-edges.ts does not mention the retired index at all, comments included", () => {
    const source = readFileSync(join(process.cwd(), "src/db/memory-edges.ts"), "utf8");
    expect(/(?<!_side)\bmemory_edge_tags\b/.test(source)).toBe(false);
    expect(source).toContain("memory_edge_side_tags");
  });

  /**
   * The migration era's own boundary. Those two files may name the retired
   * surface, but only where a PRE-contraction table is what they are looking
   * at — so the phase that removes it has to be present in the same file that
   * still reads it, or "migration era" is just a permanent exemption.
   */
  test("the file that still reads the retired column is also the file that drops it", () => {
    const schema = readFileSync(join(process.cwd(), "src/db/schema.ts"), "utf8");
    expect(schema).toContain("ensureMemoryEdgesLaneModelV12MergedTagSetRetired");
    expect(schema).toContain("DROP TABLE IF EXISTS memory_edge_tags");
  });
});
