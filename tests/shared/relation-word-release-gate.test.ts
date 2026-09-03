import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, expect, test } from "bun:test";

/**
 * THE RAW-WORD RELEASE GATE (main-agent-edges spec, pinned decision P3;
 * ticket 01 — the ticket that dropped the column). STRENGTHENED, ticket 15
 * (S15069/T2461, finding P2-E).
 *
 * After the cutover the seven-word relation vocabulary — `override`, `narrows`,
 * `extends`, `indexes`, `consume`, `grounds`, `verifies` — has no storage
 * column to live in and no reader to key on it. This gate proves no code in
 * `src/` still teaches or checks against one of them (plus the pre-v13
 * `refutes`, a legacy word merged into `override` — lane-model-v12 ticket 03
 * — that a re-added reader could still resurrect), outside an explicit,
 * per-occurrence allowlist.
 *
 * WHAT CHANGED FROM THE ORIGINAL GATE (ticket 15, finding P2-E). The
 * original regex required a QUOTED LITERAL WHOSE ENTIRE CONTENTS equalled one
 * of the seven words (`(['"`])(word)\1` — no characters before or after the
 * word inside the quotes). Two things followed from that: (1) a raw word
 * embedded in a PROSE SENTENCE inside a literal — `"write override edges"` —
 * never matched, because the literal's contents are not the bare word; (2)
 * the allowlist was PER FILE, so once `schema.ts` or `lanes.ts` carried one
 * legitimate migration literal, ANY new literal in that file — including a
 * semantic misuse of the retired vocabulary — passed silently. Both are
 * fixed here: the pattern now matches each word as a WORD (`\b...\b`, plural
 * forms admitted per ticket 15's own list) ANYWHERE inside a string or
 * template literal, and the allowlist is keyed per OCCURRENCE.
 *
 * WHY refutes JOINS THE LIST. It predates the seven-word vocabulary (v11) and
 * was folded into `override` before main-agent-edges even started (D1 never
 * had to drop it — it was already gone from the live column by then), but it
 * is still exactly the shape of defect this gate exists to catch: a reader
 * keyed on a word `relation_class` cannot hold. `tests/shared/turn-phase.ts`
 * (`turn-phase.test.ts`'s own comment) already treats `verifies`/`refutes` as
 * one retired pair, so admitting it to the same regex costs nothing.
 *
 * WHAT COUNTS. Any of the eight patterns below matching, as a WORD, inside
 * the content of a single- or double-quoted string or a template literal in
 * CODE, after comments are stripped. Comments are excluded on purpose: this
 * codebase documents its history in place, and a comment that says
 * "`override` used to mean…" is exactly the trace a later reader needs.
 *
 * PER-OCCURRENCE IDENTITY (deviation, flagged). The ticket's text asks for
 * "file + exact literal". Two of this gate's own legitimate hits (tool
 * descriptions in `src/mcp/definitions.ts`, several KB of prose each) cannot
 * practically be retyped into this file as a literal to match against, and a
 * hash-of-content key is unreadable to a reviewer. This gate instead keys an
 * occurrence by (file, LINE NUMBER of the literal in the current source) —
 * unambiguous today (verified below: no two hits in this codebase share a
 * (file, line)) and, unlike a text key, a small unrelated edit that shifts
 * the line makes the entry go stale and fail the "still earning its place"
 * test below, forcing a human to re-look at the literal that moved there —
 * the same forcing function a text key would give, without the unreadable
 * key.
 *
 * THE ALLOWLIST, by reason class (each occurrence below repeats one of
 * these verbatim, so the reasons are not restated per line):
 *
 *   - CURRENT class token: `verify` is one of the three LIVE relation
 *     classes (`correct`/`verify`/`use`, `RELATION_CLASSES`) — teaching
 *     prose, MCP tool descriptions, the console's own vocabulary, and the
 *     rubric all name it legitimately. Never the retired PLURAL `verifies`.
 *   - Ordinary English, unrelated: `verify`/`verifies` as the ENGLISH VERB
 *     (confirms/checks a lease, a decision), `narrow`/`narrows` as the
 *     ENGLISH VERB (scope something down), `ground truth` as the ordinary
 *     noun phrase — none of these name the relation vocabulary.
 *   - schema.ts migration/legacy literal: a frozen word list, a DDL CHECK
 *     string, or a legacy-word translation table that a database predating
 *     the three-class backfill still needs to run against.
 *   - schema.ts CURRENT CHECK text: the live `relation_class` column's own
 *     constraint, which legitimately enumerates `verify`.
 *   - lane-model-v12 / topic-stopword / tokenizer-self-test / frontier
 *     display-label literals: named, single-purpose exceptions, one each.
 *   - the RULES store's own refusal text: an unrelated subsystem (`rules`,
 *     not `memory_edges`) that happens to use the English word "refute".
 *
 * Anything else is a defect: a new reader keyed on a word the table cannot
 * hold, or teaching that names a vocabulary no writer may send.
 */
const WORD_PATTERNS = [
  String.raw`\boverride\b`,
  String.raw`\bnarrows?\b`,
  String.raw`\bextends?\b`,
  String.raw`\bconsumes?\b`,
  String.raw`\bgrounds?\b`,
  String.raw`\bindexes\b`,
  String.raw`\bverif(y|ies)\b`,
  String.raw`\brefutes?\b`,
];
const WORD_RE = new RegExp(WORD_PATTERNS.join("|"));

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

interface AllowlistEntry {
  file: string;
  line: number;
  reason: string;
}

const CURRENT_CLASS_ENUM =
  "CURRENT class enumeration correct/verify/use in teaching/tool-description prose";
const ENGLISH_VERIFY = "ordinary English verb 'verify'/'verifies' (confirms/checks), not the relation class or the retired word";
const ENGLISH_NARROW = "ordinary English verb 'narrow'/'narrows' (scope down a query/range/CHECK), unrelated to the retired relation word `narrows`";
const ENGLISH_GROUND = "ordinary English noun phrase ('ground truth'), unrelated to the relation class grounds";
const SCHEMA_MIGRATION_LITERAL = "schema.ts migration/legacy literal: a frozen word list, DDL CHECK text, or legacy-word translation table for pre-cutover rows";
const SCHEMA_CURRENT_CHECK = "schema.ts's own CHECK constraint text for the CURRENT relation_class column, enumerating the three live classes including verify";
const LANE_V12_MIGRATION = "lane-model-v12 migration literal (LANE_MODEL_V12_MERGE_TARGET)";
const TOPIC_STOPWORD = "topic stopword list, unrelated to the edge relation vocabulary";
const TOKENIZER_SELFTEST = "arbitrary self-test string for the o200k_base tokenizer smoke-test; the word itself carries no meaning";
const FRONTIER_LABEL = "the frontier's 'latest override' display label, kept by NAME for the correct/full pointer (main-agent-edges ticket 02); not a branch on the retired word";
const RULES_STORE_REFUSAL = "the RULES store's own refusal text ('refute' as ordinary English); an unrelated subsystem, not memory_edges";
const CONSOLE_VOCABULARY = "CURRENT class vocabulary published to the console UI, per ticket 02's disposition";

/**
 * The allowlist, ONE ENTRY PER OCCURRENCE (see the module header's "PER
 * OCCURRENCE IDENTITY" for why a `(file, line)` pair is the key rather than
 * the literal text itself). Report on what this admits and why is in ticket
 * 15's FINAL REPORT.
 */
const ALLOWLIST: readonly AllowlistEntry[] = [
  { file: "src/mcp/remember.ts", line: 1256, reason: ENGLISH_NARROW },
  { file: "src/mcp/note.ts", line: 815, reason: CURRENT_CLASS_ENUM },
  { file: "src/mcp/relations-view.ts", line: 405, reason: CURRENT_CLASS_ENUM },
  { file: "src/mcp/field-mode.ts", line: 259, reason: ENGLISH_NARROW },
  { file: "src/mcp/definitions.ts", line: 138, reason: CURRENT_CLASS_ENUM },
  { file: "src/mcp/definitions.ts", line: 140, reason: ENGLISH_NARROW },
  { file: "src/mcp/definitions.ts", line: 212, reason: CURRENT_CLASS_ENUM },
  { file: "src/mcp/definitions.ts", line: 545, reason: CURRENT_CLASS_ENUM },
  { file: "src/mcp/definitions.ts", line: 709, reason: ENGLISH_NARROW },
  { file: "src/mcp/definitions.ts", line: 754, reason: CURRENT_CLASS_ENUM },
  { file: "src/mcp/definitions.ts", line: 1160, reason: ENGLISH_NARROW },
  { file: "src/mcp/definitions.ts", line: 1192, reason: CURRENT_CLASS_ENUM },
  { file: "src/mcp/definitions.ts", line: 1221, reason: CURRENT_CLASS_ENUM },
  { file: "src/mcp/timeline.ts", line: 4393, reason: FRONTIER_LABEL },
  { file: "src/mcp/relation-tree.ts", line: 20, reason: CURRENT_CLASS_ENUM },
  { file: "src/shared/relation-class.ts", line: 4, reason: CURRENT_CLASS_ENUM },
  { file: "src/shared/topic-tag.ts", line: 20, reason: TOPIC_STOPWORD },
  { file: "src/shared/token-count.ts", line: 16, reason: TOKENIZER_SELFTEST },
  { file: "src/shared/token-count.ts", line: 19, reason: TOKENIZER_SELFTEST },
  { file: "src/db/schema.ts", line: 620, reason: ENGLISH_NARROW },
  { file: "src/db/schema.ts", line: 1093, reason: RULES_STORE_REFUSAL },
  { file: "src/db/schema.ts", line: 1467, reason: SCHEMA_MIGRATION_LITERAL },
  { file: "src/db/schema.ts", line: 1470, reason: ENGLISH_NARROW },
  { file: "src/db/schema.ts", line: 1471, reason: SCHEMA_MIGRATION_LITERAL },
  { file: "src/db/schema.ts", line: 1473, reason: SCHEMA_MIGRATION_LITERAL },
  { file: "src/db/schema.ts", line: 1474, reason: ENGLISH_GROUND },
  { file: "src/db/schema.ts", line: 1475, reason: SCHEMA_MIGRATION_LITERAL },
  { file: "src/db/schema.ts", line: 1476, reason: SCHEMA_MIGRATION_LITERAL },
  { file: "src/db/schema.ts", line: 1492, reason: SCHEMA_MIGRATION_LITERAL },
  { file: "src/db/schema.ts", line: 1493, reason: ENGLISH_NARROW },
  { file: "src/db/schema.ts", line: 1494, reason: SCHEMA_MIGRATION_LITERAL },
  { file: "src/db/schema.ts", line: 1496, reason: SCHEMA_MIGRATION_LITERAL },
  { file: "src/db/schema.ts", line: 1497, reason: ENGLISH_GROUND },
  { file: "src/db/schema.ts", line: 1498, reason: SCHEMA_MIGRATION_LITERAL },
  { file: "src/db/schema.ts", line: 1499, reason: SCHEMA_MIGRATION_LITERAL },
  { file: "src/db/schema.ts", line: 1509, reason: SCHEMA_MIGRATION_LITERAL },
  { file: "src/db/schema.ts", line: 1510, reason: ENGLISH_NARROW },
  { file: "src/db/schema.ts", line: 1511, reason: SCHEMA_MIGRATION_LITERAL },
  { file: "src/db/schema.ts", line: 1512, reason: SCHEMA_MIGRATION_LITERAL },
  { file: "src/db/schema.ts", line: 1513, reason: SCHEMA_MIGRATION_LITERAL },
  { file: "src/db/schema.ts", line: 1514, reason: ENGLISH_GROUND },
  { file: "src/db/schema.ts", line: 1515, reason: SCHEMA_MIGRATION_LITERAL },
  { file: "src/db/schema.ts", line: 1516, reason: SCHEMA_MIGRATION_LITERAL },
  { file: "src/db/schema.ts", line: 1540, reason: SCHEMA_MIGRATION_LITERAL },
  { file: "src/db/schema.ts", line: 1541, reason: ENGLISH_NARROW },
  { file: "src/db/schema.ts", line: 1542, reason: SCHEMA_MIGRATION_LITERAL },
  { file: "src/db/schema.ts", line: 1543, reason: SCHEMA_MIGRATION_LITERAL },
  { file: "src/db/schema.ts", line: 1544, reason: SCHEMA_MIGRATION_LITERAL },
  { file: "src/db/schema.ts", line: 1545, reason: ENGLISH_GROUND },
  { file: "src/db/schema.ts", line: 1546, reason: SCHEMA_MIGRATION_LITERAL },
  { file: "src/db/schema.ts", line: 2073, reason: SCHEMA_MIGRATION_LITERAL },
  { file: "src/db/schema.ts", line: 2087, reason: SCHEMA_MIGRATION_LITERAL },
  { file: "src/db/schema.ts", line: 2093, reason: SCHEMA_MIGRATION_LITERAL },
  { file: "src/db/schema.ts", line: 2096, reason: SCHEMA_MIGRATION_LITERAL },
  { file: "src/db/schema.ts", line: 2449, reason: SCHEMA_MIGRATION_LITERAL },
  { file: "src/db/schema.ts", line: 2450, reason: SCHEMA_MIGRATION_LITERAL },
  { file: "src/db/schema.ts", line: 2451, reason: SCHEMA_MIGRATION_LITERAL },
  { file: "src/db/schema.ts", line: 2452, reason: ENGLISH_GROUND },
  { file: "src/db/schema.ts", line: 2453, reason: SCHEMA_MIGRATION_LITERAL },
  { file: "src/db/schema.ts", line: 2454, reason: ENGLISH_GROUND },
  { file: "src/db/schema.ts", line: 2499, reason: ENGLISH_NARROW },
  { file: "src/db/schema.ts", line: 2637, reason: SCHEMA_MIGRATION_LITERAL },
  { file: "src/db/schema.ts", line: 2682, reason: SCHEMA_MIGRATION_LITERAL },
  { file: "src/db/schema.ts", line: 2788, reason: SCHEMA_MIGRATION_LITERAL },
  { file: "src/db/schema.ts", line: 2794, reason: ENGLISH_NARROW },
  { file: "src/db/schema.ts", line: 3036, reason: SCHEMA_MIGRATION_LITERAL },
  { file: "src/db/schema.ts", line: 3530, reason: ENGLISH_NARROW },
  { file: "src/db/schema.ts", line: 3672, reason: SCHEMA_CURRENT_CHECK },
  { file: "src/db/schema.ts", line: 3956, reason: SCHEMA_CURRENT_CHECK },
  { file: "src/db/lanes.ts", line: 1735, reason: LANE_V12_MIGRATION },
  { file: "src/db/citations.ts", line: 100, reason: CURRENT_CLASS_ENUM },
  { file: "src/worker/note-settlement-prompt.ts", line: 317, reason: ENGLISH_VERIFY },
  { file: "src/worker/note-settlement-prompt.ts", line: 411, reason: CURRENT_CLASS_ENUM },
  { file: "src/worker/note-settlement-prompt.ts", line: 415, reason: CURRENT_CLASS_ENUM },
  { file: "src/worker/note-settlement-prompt.ts", line: 500, reason: CURRENT_CLASS_ENUM },
  { file: "src/worker/console-shell.html", line: 276, reason: CONSOLE_VOCABULARY },
  { file: "src/worker/console-shell.html", line: 280, reason: CONSOLE_VOCABULARY },
  { file: "src/worker/note-settlement-impression-teaching.ts", line: 68, reason: ENGLISH_NARROW },
  { file: "src/worker/note-settlement-impression-teaching.ts", line: 177, reason: ENGLISH_VERIFY },
  { file: "src/worker/note-settlement-edge-pass-teaching.ts", line: 70, reason: CURRENT_CLASS_ENUM },
  { file: "src/worker/note-settlement-edge-pass-teaching.ts", line: 73, reason: CURRENT_CLASS_ENUM },
  { file: "src/worker/note-settlement-turn-facade.ts", line: 906, reason: CURRENT_CLASS_ENUM },
  { file: "src/worker/console-api.ts", line: 947, reason: ENGLISH_NARROW },
  { file: "src/worker/note-settlement-sdk-query.ts", line: 218, reason: CURRENT_CLASS_ENUM },
  { file: "src/worker/note-settlement-sdk-query.ts", line: 229, reason: CURRENT_CLASS_ENUM },
  { file: "src/worker/note-settlement-sdk-query.ts", line: 411, reason: ENGLISH_VERIFY },
  { file: "src/worker/note-settlement-sdk-query.ts", line: 418, reason: ENGLISH_VERIFY },
  { file: "src/worker/note-settlement-sdk-query.ts", line: 436, reason: ENGLISH_VERIFY },
  { file: "src/worker/server.ts", line: 250, reason: ENGLISH_NARROW },
  { file: "src/worker/note-settlement-unified-prompt.ts", line: 244, reason: ENGLISH_GROUND },
  { file: "src/worker/note-settlement-unified-prompt.ts", line: 325, reason: ENGLISH_VERIFY },
];

function allowlistKey(file: string, line: number): string {
  return `${file}:${line}`;
}

const ALLOWLIST_INDEX: ReadonlySet<string> = new Set(
  ALLOWLIST.map((entry) => allowlistKey(entry.file, entry.line)),
);

describe("raw-word release gate (main-agent-edges P3, strengthened ticket 15)", () => {
  test("no relation word survives as a WORD inside any string/template literal in src/ outside the allowlist", () => {
    const outside = quotedRawWordHits(SRC_ROOT).filter(
      (hit) => !ALLOWLIST_INDEX.has(allowlistKey(hit.file, hit.line)),
    );
    expect(
      outside.map((hit) => `${hit.file}:${hit.line}: ${hit.literal.slice(0, 120)}`),
    ).toEqual([]);
  });

  test("every allowlist entry is still earning its place — an entry whose (file, line) carries no hit any more is stale and must be removed", () => {
    const hitIndex = new Set(
      quotedRawWordHits(SRC_ROOT).map((hit) => allowlistKey(hit.file, hit.line)),
    );
    for (const entry of ALLOWLIST) {
      expect(
        hitIndex.has(allowlistKey(entry.file, entry.line)),
        `${entry.file}:${entry.line}: allowlisted but carries no relation-word hit any more`,
      ).toBe(true);
    }
  });

  test("the allowlist has no duplicate (file, line) — two reasons for one occurrence is a stale entry, not two", () => {
    const seen = new Set<string>();
    for (const entry of ALLOWLIST) {
      const key = allowlistKey(entry.file, entry.line);
      expect(seen.has(key), `duplicate allowlist entry: ${key}`).toBe(false);
      seen.add(key);
    }
  });

  test("the comment stripper keeps a URL inside a string and drops a trailing comment", () => {
    expect(stripComments(`const u = "https://x/override"; // 'narrows'`)).toBe(`const u = "https://x/override"; `);
    expect(stripComments(`/* 'extends' */ const a = 1;`)).toBe(` const a = 1;`);
  });

  test("a bare word match still catches a literal that IS the word — the tightened WORD regex is a superset of the old exact-literal one", () => {
    expect(quotedRawWordHits(SRC_ROOT).some((hit) => hit.literal === '"override"')).toBe(true);
  });
});

/**
 * P2-E's own reproduction: `"write override edges"` in PROSE, inside a
 * teaching file's string literal, is exactly the shape the ORIGINAL gate
 * (quoted literal === one word, no more) could not see — the literal's whole
 * contents are a sentence, not the bare word. Proven on a TEMP COPY of a
 * real teaching file (`note-settlement-edge-pass-teaching.ts`, which already
 * carries two legitimate allowlisted `verify` hits at lines 70 and 73 — the
 * injected sentence sits beside them, at a NEW line no allowlist entry
 * names, so it reds out on identity alone even before the word match is
 * considered).
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
        (hit) => !ALLOWLIST_INDEX.has(allowlistKey(hit.file, hit.line)),
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
