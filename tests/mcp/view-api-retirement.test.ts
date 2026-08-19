import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

/**
 * Ticket 11 (read-write-contract spec, "视图(读面)"): the collapsed/expanded
 * depth switch and the truncate/truncateCap character-cap mechanism
 * retire repo-wide. filter.fields is the sole field-selection mechanism;
 * the turn token budget (word-boundary) is the sole size mechanism,
 * alongside pageBudget for page-level overflow.
 *
 * This is the acceptance criterion's own grep guard, made durable: a repo-
 * wide scan for the retired identifiers as FUNCTIONAL code (parameter names,
 * type names, exported constants) — never against src/db/references.ts /
 * src/db/recover-stranded.ts (an unrelated bracket-nesting / cycle-guard
 * "depth" counter, not this ticket's depth switch) or
 * src/db/consulted-memories.ts (a regex reading the LITERAL text of
 * historical, pre-ticket-11 stored tool-call JSON — data, not API surface;
 * flagged as a known follow-on in the ticket's own report, not fixed here).
 */

const SRC_ROOT = join(import.meta.dir, "..", "..", "src");

// Historical-comment-only files are allowed to keep saying the word "depth"
// (explaining what retired); everything else must carry zero FUNCTIONAL
// reference to the retired mechanism.
const UNRELATED_DEPTH_FILES = new Set([
  join(SRC_ROOT, "db", "references.ts"),
  join(SRC_ROOT, "db", "recover-stranded.ts"),
]);

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const BACKTICK = String.fromCharCode(96);
// Built via the RegExp constructor (not a /…/ literal) — a literal
// containing a raw backtick trips up template-literal boundary scanning in
// some transpilers when it sits inside a .ts source file.
const TEMPLATE_LITERAL_RE = new RegExp(`${BACKTICK}(?:[^${BACKTICK}\\\\]|\\\\.)*${BACKTICK}`, "g");

// Strips line comments, block comments, and string literals crudely enough
// to tell code from prose for this guard's purposes — good enough for
// identifier-shaped patterns, which never legitimately appear inside a
// normal English sentence otherwise.
function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(TEMPLATE_LITERAL_RE, "TPL")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

describe("view API retirement (ticket 11) — no functional depth/truncate/truncateCap references remain in src/", () => {
  const files = listTsFiles(SRC_ROOT);

  test("no RenderDepth type or a depth: collapsed/expanded field survives as CODE (comments/strings excluded)", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (UNRELATED_DEPTH_FILES.has(file)) continue;
      const code = stripCommentsAndStrings(readFileSync(file, "utf8"));
      if (/\bRenderDepth\b/.test(code) || /\bdepth\??\s*:\s*"(collapsed|expanded)"/.test(code)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no truncate/truncateCap char-cap identifiers survive as CODE (comments excluded)", () => {
    const offenders: string[] = [];
    const pattern =
      /\bDEFAULT_TRUNCATE\b|\bMAX_TRUNCATE\b|\bresolveExplicitTruncate\b|\btruncateCap\b|\bDEFAULT_TURN_TOKEN_BUDGET_COLLAPSED\b/;
    for (const file of files) {
      const code = stripCommentsAndStrings(readFileSync(file, "utf8"));
      if (pattern.test(code)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  // truncateText/truncateLines(gone)/truncateToTokens(timeline.ts, its
  // own unrelated internal knob) legitimately keep the substring "truncate"
  // — this guard targets the retiring PARAMETER/constant names specifically,
  // not the word.
  test("the word-boundary primitive truncateText is still present and still the only field-level truncator format.ts exports", () => {
    const format = readFileSync(join(SRC_ROOT, "mcp", "format.ts"), "utf8");
    expect(format).toContain("export function truncateText(");
    expect(format).not.toContain("export function truncateLines(");
    expect(format).not.toContain("export function truncateCallHeader(");
  });

  test("RecallInput (src/mcp/recall.ts) declares neither depth nor truncate/truncateCap", () => {
    const recall = readFileSync(join(SRC_ROOT, "mcp", "recall.ts"), "utf8");
    const interfaceMatch = /export interface RecallInput \{([\s\S]*?)\n\}/.exec(recall);
    expect(interfaceMatch).not.toBeNull();
    const body = stripCommentsAndStrings(interfaceMatch![1]!);
    expect(/\bdepth\??\s*:/.test(body)).toBe(false);
    expect(/\btruncate\??\s*:/.test(body)).toBe(false);
    expect(/\btruncateCap\??\s*:/.test(body)).toBe(false);
  });
});
