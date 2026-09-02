import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "bun:test";

/**
 * THE RAW-WORD RELEASE GATE (main-agent-edges spec, pinned decision P3;
 * ticket 01 — the ticket that dropped the column).
 *
 * After the cutover the seven-word relation vocabulary — `override`, `narrows`,
 * `extends`, `indexes`, `consume`, `grounds`, `verifies` — has no storage
 * column to live in and no reader to key on it. Tickets 02 (readers), 03
 * (writes/retraction) and 07 (renderer) each disposed of their own consumers;
 * this test proves the UNION: no code in `src/` names one of the seven as a
 * quoted literal, outside an explicit allowlist.
 *
 * WHAT COUNTS. A QUOTED occurrence in CODE — `'override'`, `"narrows"`,
 * `` `extends` `` — after comments are stripped. Comments are excluded on
 * purpose: this codebase documents its history in place, and a comment that
 * says "`override` used to mean…" is exactly the trace a later reader needs.
 * Unquoted occurrences are excluded because five of the seven are ordinary
 * English (and `extends` is a TypeScript keyword); the storage vocabulary was
 * only ever spelled as a string.
 *
 * THE ALLOWLIST, and why each entry is there:
 *
 *   - `src/db/schema.ts` — historical migration literals: the frozen word
 *     lists every `memory_edges` rebuild target in that file carries, the
 *     v13 backfill's word -> class table, the legacy `turn_citations` remap.
 *     They run on databases that predate the cutover and must not move when
 *     a vocabulary constant moves.
 *   - `src/db/lanes.ts` — `LANE_MODEL_V12_MERGE_TARGET` and the v12 merge
 *     phases' own word tables: the same kind of migration literal.
 *   - `src/shared/topic-tag.ts` — `"verifies"` in a topic STOPWORD list. A
 *     word a topic tag may not be, unrelated to edges; listed rather than
 *     removed because the stopword is doing its own job.
 *
 * Anything else is a defect: a new reader keyed on a word the table cannot
 * hold, or teaching that names a vocabulary no writer may send.
 */
const SEVEN_WORDS = ["override", "narrows", "extends", "indexes", "consume", "grounds", "verifies"];

const ALLOWLIST: ReadonlyMap<string, string> = new Map([
  ["src/db/schema.ts", "historical migration literals (rebuild targets, the v13 backfill, the turn_citations remap)"],
  ["src/db/lanes.ts", "lane-model-v12 migration literals"],
  ["src/shared/topic-tag.ts", "a topic stopword, unrelated to the edge vocabulary"],
]);

const SRC_ROOT = join(import.meta.dir, "..", "..", "src");
const QUOTED = new RegExp(`(['"\`])(${SEVEN_WORDS.join("|")})\\1`, "g");

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|html)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Strip block comments and `//` line comments (a `//` preceded by `:` — a URL inside a string — is kept). */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

interface Hit {
  file: string;
  line: number;
  text: string;
}

function quotedRawWordHits(): Hit[] {
  const hits: Hit[] = [];
  for (const file of listSourceFiles(SRC_ROOT)) {
    const rel = relative(join(SRC_ROOT, ".."), file);
    const lines = stripComments(readFileSync(file, "utf8")).split("\n");
    lines.forEach((text, index) => {
      QUOTED.lastIndex = 0;
      if (QUOTED.test(text)) {
        hits.push({ file: rel, line: index + 1, text: text.trim() });
      }
    });
  }
  return hits;
}

describe("raw-word release gate (main-agent-edges P3)", () => {
  test("no quoted relation word survives in src/ outside the allowlist", () => {
    const outside = quotedRawWordHits().filter((hit) => !ALLOWLIST.has(hit.file));
    expect(
      outside.map((hit) => `${hit.file}:${hit.line}: ${hit.text}`),
    ).toEqual([]);
  });

  test("every allowlist entry is still earning its place — an entry with no hit is stale and must be removed", () => {
    const filesWithHits = new Set(quotedRawWordHits().map((hit) => hit.file));
    for (const file of ALLOWLIST.keys()) {
      expect(filesWithHits.has(file), `${file}: allowlisted but carries no quoted word any more`).toBe(true);
    }
  });

  test("the comment stripper keeps a URL inside a string and drops a trailing comment", () => {
    expect(stripComments(`const u = "https://x/override"; // 'narrows'`)).toBe(`const u = "https://x/override"; `);
    expect(stripComments(`/* 'extends' */ const a = 1;`)).toBe(` const a = 1;`);
  });
});
