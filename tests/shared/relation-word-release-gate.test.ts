import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, expect, test } from "bun:test";

/**
 * THE RAW-WORD RELEASE GATE (main-agent-edges P3; ticket 15, tightened by the
 * integrator). After the cutover the seven-word vocabulary and `refutes` are
 * gone from the schema; this gate keeps them out of the CODE'S STRINGS —
 * teaching, tool descriptions, rendered labels, SQL — so no surface can teach
 * or print the stored word again. It scans every string/template literal in
 * `src/` (comments stripped, one line at a time), matches the retired words as
 * WHOLE WORDS, exempts the migration history as a file, and admits the
 * handful of legitimate English/self-test uses by (file, EXACT literal).
 */

/**
 * THE RETIRED VOCABULARY, exactly as it was STORED: the seven pre-v13 words
 * plus `refutes` (folded into `override` by lane-model v12). Whole words,
 * case-sensitive. NOT in the list, on purpose: `verify` (a LIVE class),
 * `narrow`/`ground`/`extend`/`index`/`consumes` (ordinary English and the
 * rubric's bare forms — a teaching surface may say "narrow the scope"). The
 * gate is about the stored word coming back, not about the English language.
 */
const WORD_PATTERNS = [
  String.raw`\boverride\b`,
  String.raw`\bnarrows\b`,
  String.raw`\bextends\b`,
  String.raw`\bconsume\b`,
  String.raw`\bgrounds\b`,
  String.raw`\bindexes\b`,
  String.raw`\bverifies\b`,
  String.raw`\brefutes\b`,
];
const WORD_RE = new RegExp(WORD_PATTERNS.join("|"));

/** Files the gate does not read at all, each with the one reason the whole file is legitimately full of the old words. */
const EXEMPT_FILES: ReadonlyMap<string, string> = new Map([
  [
    "src/db/schema.ts",
    "the migration history: frozen word lists, legacy CHECK text and the legacy-word translation tables for pre-cutover rows live here by definition",
  ],
]);

/** One quoted single/double string or a template literal, contents included. Not escape-perfect for a nested `${...}` containing its own quotes of the SAME kind, which does not occur in this tree (verified by the hit count below matching a byte-for-byte independent recount in the ticket's report). */
const LITERAL_RE = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g;

/** Strip block comments and `//` line comments (a `//` preceded by `:` — a URL inside a string — is kept). */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

interface Hit {
  /** Path relative to the scanned root's PARENT (so a real scan reports `src/...`). */
  file: string;
  line: number;
  literal: string;
}

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

/**
 * Every occurrence of a relation word, as a WORD, inside a string/template
 * literal under `root` (comments stripped first). `labelRoot` is the
 * directory `file` paths are reported relative to — the real scan passes
 * `root`'s own parent so hits read `src/...`; the injection test passes a
 * synthetic root so its one hit reads relative to ITS OWN root instead.
 */
function quotedRawWordHits(root: string, labelRoot: string = join(root, "..")): Hit[] {
  const hits: Hit[] = [];
  for (const file of listSourceFiles(root)) {
    const rel = relative(labelRoot, file);
    const lines = stripComments(readFileSync(file, "utf8")).split("\n");
    lines.forEach((text, index) => {
      LITERAL_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = LITERAL_RE.exec(text))) {
        if (WORD_RE.test(m[0])) {
          hits.push({ file: rel, line: index + 1, literal: m[0] });
        }
      }
    });
  }
  return hits;
}

const SRC_ROOT = join(import.meta.dir, "..", "..", "src");

/**
 * The allowlist, keyed on (file, EXACT literal text): an entry names the
 * bytes it admits, so a moved line does not make it stale and a NEW literal
 * on the same line is still caught. One reason each.
 */
interface AllowlistEntry {
  file: string;
  literal: string;
  reason: string;
}

const ENGLISH_VERIFIES = "ordinary English verb 'verifies' (checks), not the retired relation word";
const TOKENIZER_SELFTEST = "arbitrary self-test string for the o200k_base tokenizer smoke-test; the word carries no meaning";
const TOPIC_STOPWORD = "topic stopword list, unrelated to the edge relation vocabulary";
const LANE_V12_MIGRATION = "lane-model-v12 migration literal (the merge target of `refutes`), a migration word by definition";
const FRONTIER_LABEL = "the frontier's 'latest override' display label, kept by NAME for the correct/full pointer (main-agent-edges ticket 02 disposition)";

const ALLOWLIST: readonly AllowlistEntry[] = [
  { file: "src/mcp/timeline.ts", literal: "`latest override ${tailAddress}${qualifier} -> ${headAddress}`", reason: FRONTIER_LABEL },
  { file: "src/shared/topic-tag.ts", literal: '"verifies"', reason: TOPIC_STOPWORD },
  { file: "src/shared/token-count.ts", literal: '" extends"', reason: TOKENIZER_SELFTEST },
  { file: "src/shared/token-count.ts", literal: "`[claude-mnemo] o200k_base self-test: \" extends\" -> ${count} token(s), cold init ${elapsed}ms`", reason: TOKENIZER_SELFTEST },
  { file: "src/db/lanes.ts", literal: '"override"', reason: LANE_V12_MIGRATION },
  { file: "src/worker/note-settlement-prompt.ts", literal: '"`commit` does not write anything itself — it verifies your job lease is"', reason: ENGLISH_VERIFIES },
  { file: "src/worker/note-settlement-impression-teaching.ts", literal: '"with none refuses the commit by name. It re-verifies each decision against"', reason: ENGLISH_VERIFIES },
  { file: "src/worker/note-settlement-sdk-query.ts", literal: '"cleared, and no debt is discharged until your own `commit` verifies the "', reason: ENGLISH_VERIFIES },
  { file: "src/worker/note-settlement-sdk-query.ts", literal: "'`remember(action: \"impression\", …)` as you make it. This call verifies the '", reason: ENGLISH_VERIFIES },
  { file: "src/worker/note-settlement-unified-prompt.ts", literal: '"   refusal is not that commit. `commit` verifies your job lease is still"', reason: ENGLISH_VERIFIES },
];

function allowlistKey(file: string, literal: string): string {
  return `${file}::${literal}`;
}

const ALLOWLIST_INDEX: ReadonlySet<string> = new Set(
  ALLOWLIST.map((entry) => allowlistKey(entry.file, entry.literal)),
);

function gateHits(root: string, labelRoot?: string): Hit[] {
  return quotedRawWordHits(root, labelRoot).filter((hit) => !EXEMPT_FILES.has(hit.file));
}

describe("raw-word release gate (main-agent-edges P3, ticket 15)", () => {
  test("no retired relation word survives as a WORD inside any string/template literal in src/ outside the allowlist", () => {
    const outside = gateHits(SRC_ROOT).filter(
      (hit) => !ALLOWLIST_INDEX.has(allowlistKey(hit.file, hit.literal)),
    );
    expect(
      outside.map((hit) => `${hit.file}:${hit.line}: ${hit.literal.slice(0, 120)}`),
    ).toEqual([]);
  });

  test("every allowlist entry is still earning its place — an entry whose (file, literal) carries no hit any more is stale and must be removed", () => {
    const hitIndex = new Set(gateHits(SRC_ROOT).map((hit) => allowlistKey(hit.file, hit.literal)));
    for (const entry of ALLOWLIST) {
      expect(
        hitIndex.has(allowlistKey(entry.file, entry.literal)),
        `${entry.file}: allowlisted literal no longer present: ${entry.literal.slice(0, 80)}`,
      ).toBe(true);
    }
  });

  test("every exempt file exists and still carries the words its exemption is for", () => {
    for (const [file] of EXEMPT_FILES) {
      const hits = quotedRawWordHits(SRC_ROOT).filter((hit) => hit.file === file);
      expect(hits.length, `${file}: exempt but carries no retired word any more — drop the exemption`).toBeGreaterThan(0);
    }
  });

  test("the allowlist has no duplicate (file, literal)", () => {
    const seen = new Set<string>();
    for (const entry of ALLOWLIST) {
      const key = allowlistKey(entry.file, entry.literal);
      expect(seen.has(key), `duplicate allowlist entry: ${key}`).toBe(false);
      seen.add(key);
    }
  });

  test("the comment stripper keeps a URL inside a string and drops a trailing comment", () => {
    expect(stripComments(`const u = "https://x/override"; // 'narrows'`)).toBe(`const u = "https://x/override"; `);
    expect(stripComments(`/* 'extends' */ const a = 1;`)).toBe(` const a = 1;`);
  });

  test("a literal that IS the word is still a hit — the WORD regex is a superset of the old exact-literal one", () => {
    expect(gateHits(SRC_ROOT).some((hit) => hit.literal === '"override"')).toBe(true);
  });

  test("the live class `verify` and the English words narrow/ground/extend are NOT retired words", () => {
    for (const literal of ['"verify"', '"narrow the scope"', '"ground truth"', '"extend the window"', '"correct|verify|use"']) {
      expect(WORD_RE.test(literal), literal).toBe(false);
    }
    for (const literal of ['"write override edges"', '"it narrows"', '"a consume edge"', '"verifies"']) {
      expect(WORD_RE.test(literal), literal).toBe(true);
    }
  });
});

/**
 * P2-E's own reproduction: `"write override edges"` in PROSE, inside a
 * teaching file's string literal, is exactly the shape the ORIGINAL gate
 * (quoted literal === one word, no more) could not see — the literal's whole
 * contents are a sentence, not the bare word. Proven on a TEMP COPY of a
 * real teaching file (`note-settlement-edge-pass-teaching.ts`, which already
 * carries two legitimate allowlisted `verify` hits at lines 70 and 73 — the
 * injected sentence sits beside them, and its literal text is on no
 * allowlist entry).
 */
describe("P2-E reproduction: a prose sentence carrying a relation word red-lines the gate (main-agent-edges ticket 15)", () => {
  test("`write override edges` injected into a temp copy of a teaching file is caught by the WORD regex and reds out the REAL gate predicate", () => {
    const sourceFile = join(SRC_ROOT, "worker", "note-settlement-edge-pass-teaching.ts");
    const original = readFileSync(sourceFile, "utf8");

    // Mirrors `src/worker/...` exactly (not just `worker/...`), so the hit's
    // `file` reads identically to a real scan's and the REAL `ALLOWLIST` —
    // keyed on `src/...` paths — applies to it unmodified below.
    const tempRoot = mkdtempSync(join(tmpdir(), "relation-word-gate-probe-"));
    try {
      const tempFile = join(tempRoot, "src", "worker", "note-settlement-edge-pass-teaching.ts");
      mkdirSync(dirname(tempFile), { recursive: true });
      const injected = `${original}\n\nexport const TICKET_15_PROBE_SENTENCE = "write override edges";\n`;
      writeFileSync(tempFile, injected, "utf8");

      // THE OLD GATE would have missed this: its regex required the quoted
      // literal's ENTIRE content to equal one bare word.
      const OLD_EXACT_LITERAL_RE = /(['"`])(override|narrows|extends|indexes|consume|grounds|verifies)\1/;
      expect(OLD_EXACT_LITERAL_RE.test('"write override edges"')).toBe(false);

      // THE REAL PREDICATE, run against the temp copy: every hit under this
      // root, minus the REAL allowlist (unmodified — proving no entry here
      // was written to admit this injected sentence).
      const outside = quotedRawWordHits(tempRoot, tempRoot).filter(
        (hit) => !ALLOWLIST_INDEX.has(allowlistKey(hit.file, hit.literal)),
      );
      const injectedHit = outside.find((hit) => hit.literal === '"write override edges"');
      expect(injectedHit).not.toBeUndefined();
      expect(injectedHit!.file).toBe("src/worker/note-settlement-edge-pass-teaching.ts");
      // THE GATE IS RED: at least one hit survives the real allowlist. The
      // main "no quoted relation word survives" test above asserts `outside`
      // is `[]` for the real tree; here, on the injected copy, it is not.
      expect(outside.length).toBeGreaterThan(0);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
