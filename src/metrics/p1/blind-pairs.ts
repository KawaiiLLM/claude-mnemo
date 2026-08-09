import type { Database } from "bun:sqlite";

import { agentAuthoredNotePredicate } from "../../db/shadow-notes";
import { formatTurnAddress } from "../../hooks/note-reminder";

/**
 * Metric (b): pair a turn's agent-written note against the legacy pipeline's
 * summary of the same turn, strip everything that identifies the author, and
 * hand the pair to a judge.
 *
 * The blinding is the whole product here. Four tells were found and removed:
 *
 *   - citation syntax — the agent writes `[S15069/T332]` (spec D7), the legacy
 *     pipeline wrote bare `[T332]`, so the bracket form alone names the author;
 *     both are collapsed to `[ref]`;
 *   - title structure — the note-taking instructions ask for a fixed
 *     `<activity>+<topic>: …` title, which no legacy summary has, so a judge
 *     could sort the sides on shape before reading a word. The structural prefix
 *     is stripped from BOTH titles;
 *   - layout — notes are written as one paragraph, legacy summaries often carry
 *     bullets and hard wraps, so all whitespace runs collapse to a single space
 *     on both sides. This costs the judge any credit for good structure, which
 *     is the price of a comparison the judge cannot shortcut;
 *   - field set — `insight` fill rate differs by design (56% legacy vs the
 *     10-20% the spec targets), so a pair that showed insight would leak the
 *     author on the strength of an empty field. Insight travels in the key file
 *     for later analysis and never in the judged payload.
 *
 * The standard this is held to: no regular expression over a pair should sort
 * the two sides by author. What remains after that standard is met is
 * statistical, not formal — length distribution above all — and it is declared
 * in the pairs file's header line rather than left for a reader to discover.
 *
 * Shared context (the user prompt and the turn's tool names) is neutral: neither
 * side authored it, and without it a judge can only rate prose, not faithfulness.
 */

export type PairSource = "shadow" | "legacy";

export interface PairCandidate {
  turnId: number;
  sessionId: number;
  promptNumber: number;
  turnRef: string;
  userPrompt: string;
  toolNames: string[];
  shadowTitle: string;
  shadowContent: string;
  shadowInsight: string | null;
  legacyTitle: string;
  legacyContent: string;
  legacyInsight: string | null;
  writerModel: string | null;
}

export interface BlindPair {
  pairId: string;
  prompt: string;
  tools: string[];
  a: { title: string; content: string };
  b: { title: string; content: string };
}

export interface PairKeyRow {
  pairId: string;
  turnRef: string;
  turnId: number;
  sessionId: number;
  promptNumber: number;
  a: PairSource;
  b: PairSource;
  writerModel: string | null;
  shadowInsight: string | null;
  legacyInsight: string | null;
}

export interface PairExportStats {
  shadowNotes: number;
  legacyExtracted: number;
  candidates: number;
  droppedMissingLegacy: number;
  droppedEmptyField: number;
  /** Residual, un-blindable channels — measured so they can be stated. */
  shadowContentMedianCharacters: number | null;
  legacyContentMedianCharacters: number | null;
  titlePrefixesStripped: number;
}

/**
 * The first line of the pairs file. It is not a pair and never reaches a judge
 * prompt; it exists so the file states, in the file, what was normalised away
 * and what was left behind.
 */
export interface BlindPairsHeader {
  kind: "blind-pairs-header";
  version: 1;
  seed: number;
  pairCount: number;
  normalised: string[];
  residualFingerprints: string[];
}

export interface BlindPairExport {
  header: BlindPairsHeader;
  pairs: BlindPair[];
  key: PairKeyRow[];
  stats: PairExportStats;
}

const CITATION_PATTERN = /\[(?:S\d+\/)?T\d+\]|\[E\d+\]/gu;
const DEFAULT_PROMPT_CHARACTERS = 600;

/**
 * The `<activity>+<topic>:` opening the note-taking instructions prescribe.
 *
 * Matched by shape rather than by the instructions' activity vocabulary: an
 * agent that writes `refactor+cache:` instead of `fix+cache:` has produced the
 * same tell, and a vocabulary list would leave it standing. One leading
 * unspaced word, a `+`, a short topic, a colon — Latin or full-width, since the
 * corpus is bilingual.
 */
const TITLE_STRUCTURAL_PREFIX =
  /^[\p{L}\p{N}_-]{1,24}\s*\+\s*[^:：\n]{1,48}[:：]\s*/u;

/** Remove the author's fingerprints without touching the substance. */
export function anonymizeNoteText(text: string): string {
  return text
    .replace(CITATION_PATTERN, "[ref]")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Titles get everything `anonymizeNoteText` does, then lose the structural
 * prefix. Applied to both sides, so a legacy title that happens to open the same
 * way is treated identically — symmetry is what makes the strip a blinding step
 * rather than a second, subtler tell.
 *
 * A title that is nothing BUT the prefix (`"fix+cache:"`, nothing after the
 * colon) strips to empty, and stays empty. Falling back to the original text
 * here — the earlier behaviour — hands the judge the exact source-structure
 * tell this function exists to remove: it just needed one side to open with
 * `<word>+<word>:` and nothing else to be de-anonymised right back to knowing
 * which side it was.
 */
export function anonymizeNoteTitle(title: string): string {
  const normalised = anonymizeNoteText(title);
  return normalised.replace(TITLE_STRUCTURAL_PREFIX, "").trim();
}

export function hasStructuralTitlePrefix(title: string): boolean {
  return TITLE_STRUCTURAL_PREFIX.test(anonymizeNoteText(title));
}

function medianCharacters(texts: string[]): number | null {
  if (texts.length === 0) {
    return null;
  }
  const lengths = texts
    .map((text) => Array.from(text).length)
    .sort((left, right) => left - right);
  const middle = Math.floor(lengths.length / 2);
  return lengths.length % 2 === 1
    ? lengths[middle]!
    : Math.round((lengths[middle - 1]! + lengths[middle]!) / 2);
}

export function truncate(text: string, characters: number): string {
  const codePoints = Array.from(text);
  return codePoints.length <= characters
    ? text
    : `${codePoints.slice(0, characters).join("")}…`;
}

/** Deterministic PRNG so a seed reproduces an A/B assignment exactly. */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

interface CandidateRow {
  turnId: number;
  sessionId: number;
  promptNumber: number;
  userPrompt: string | null;
  shadowTitle: string | null;
  shadowContent: string | null;
  shadowInsight: string | null;
  legacyTitle: string | null;
  legacyContent: string | null;
  legacyInsight: string | null;
  writerModel: string | null;
}

function toolNamesForTurns(
  db: Database,
  turnIds: number[],
): Map<number, string[]> {
  const names = new Map<number, string[]>();
  if (turnIds.length === 0) {
    return names;
  }

  const placeholders = turnIds.map(() => "?").join(", ");
  const rows = db
    .query<{ turnId: number; toolName: string }, number[]>(
      `SELECT turn_id AS turnId, tool_name AS toolName
       FROM observations
       WHERE tool_name IS NOT NULL AND turn_id IN (${placeholders})
       ORDER BY id ASC`,
    )
    .all(...turnIds);

  for (const row of rows) {
    const existing = names.get(row.turnId);
    if (existing) {
      if (!existing.includes(row.toolName)) {
        existing.push(row.toolName);
      }
    } else {
      names.set(row.turnId, [row.toolName]);
    }
  }

  return names;
}

export interface CollectPairOptions {
  sessionId?: number;
  promptCharacters?: number;
}

export function collectPairCandidates(
  db: Database,
  options: CollectPairOptions = {},
): { candidates: PairCandidate[]; stats: PairExportStats } {
  const sql = `
    SELECT
      n.turn_id AS turnId,
      t.session_id AS sessionId,
      t.prompt_number AS promptNumber,
      t.user_prompt AS userPrompt,
      n.title AS shadowTitle,
      n.content AS shadowContent,
      n.insight AS shadowInsight,
      t.title AS legacyTitle,
      t.content AS legacyContent,
      t.insight AS legacyInsight,
      n.writer_model AS writerModel
    FROM shadow_notes n
    JOIN turns t ON t.id = n.turn_id
    WHERE ${agentAuthoredNotePredicate()}
    ${options.sessionId === undefined ? "" : "AND t.session_id = ?"}
    ORDER BY t.session_id ASC, t.prompt_number ASC
  `;

  const rows =
    options.sessionId === undefined
      ? db.query<CandidateRow, []>(sql).all()
      : db.query<CandidateRow, [number]>(sql).all(options.sessionId);

  const promptCharacters = options.promptCharacters ?? DEFAULT_PROMPT_CHARACTERS;

  let droppedMissingLegacy = 0;
  let droppedEmptyField = 0;
  const kept: CandidateRow[] = [];

  for (const row of rows) {
    const legacyTitle = (row.legacyTitle ?? "").trim();
    const legacyContent = (row.legacyContent ?? "").trim();
    const shadowTitle = (row.shadowTitle ?? "").trim();
    const shadowContent = (row.shadowContent ?? "").trim();

    if (legacyTitle === "" && legacyContent === "") {
      droppedMissingLegacy += 1;
      continue;
    }

    // Asymmetric field presence is itself a tell, so a pair is exported only
    // when both sides carry both fields.
    if (
      legacyTitle === "" ||
      legacyContent === "" ||
      shadowTitle === "" ||
      shadowContent === ""
    ) {
      droppedEmptyField += 1;
      continue;
    }

    kept.push(row);
  }

  const toolNames = toolNamesForTurns(
    db,
    kept.map((row) => row.turnId),
  );

  const candidates: PairCandidate[] = kept.map((row) => ({
    turnId: row.turnId,
    sessionId: row.sessionId,
    promptNumber: row.promptNumber,
    turnRef: formatTurnAddress({
      sessionId: row.sessionId,
      promptNumber: row.promptNumber,
    }),
    userPrompt: truncate(
      (row.userPrompt ?? "").replace(/\s+/gu, " ").trim(),
      promptCharacters,
    ),
    toolNames: toolNames.get(row.turnId) ?? [],
    shadowTitle: row.shadowTitle!.trim(),
    shadowContent: row.shadowContent!.trim(),
    shadowInsight: row.shadowInsight,
    legacyTitle: row.legacyTitle!.trim(),
    legacyContent: row.legacyContent!.trim(),
    legacyInsight: row.legacyInsight,
    writerModel: row.writerModel,
  }));

  const legacyExtractedSql = `
    SELECT COUNT(*) AS count FROM turns
    WHERE (title IS NOT NULL AND title <> '')
    ${options.sessionId === undefined ? "" : "AND session_id = ?"}
  `;

  const stats: PairExportStats = {
    shadowNotes: rows.length,
    legacyExtracted:
      (options.sessionId === undefined
        ? db.query<{ count: number }, []>(legacyExtractedSql).get()
        : db
            .query<{ count: number }, [number]>(legacyExtractedSql)
            .get(options.sessionId))?.count ?? 0,
    candidates: candidates.length,
    droppedMissingLegacy,
    droppedEmptyField,
    // Measured on the anonymised text, because that is what a judge sees. These
    // belong to the operator's report, never to the pairs file: they are keyed
    // by source, which is exactly the mapping the judge must not have.
    shadowContentMedianCharacters: medianCharacters(
      candidates.map((candidate) => anonymizeNoteText(candidate.shadowContent)),
    ),
    legacyContentMedianCharacters: medianCharacters(
      candidates.map((candidate) => anonymizeNoteText(candidate.legacyContent)),
    ),
    titlePrefixesStripped: candidates.filter(
      (candidate) =>
        hasStructuralTitlePrefix(candidate.shadowTitle) ||
        hasStructuralTitlePrefix(candidate.legacyTitle),
    ).length,
  };

  return { candidates, stats };
}

export function buildBlindPairs(
  candidates: PairCandidate[],
  stats: PairExportStats,
  options: { seed?: number } = {},
): BlindPairExport {
  const seed = options.seed ?? 1;
  const random = createSeededRandom(seed);
  const pairs: BlindPair[] = [];
  const key: PairKeyRow[] = [];

  candidates.forEach((candidate, index) => {
    const pairId = `p${String(index + 1).padStart(4, "0")}`;
    const shadowFirst = random() < 0.5;

    const shadow = {
      title: anonymizeNoteTitle(candidate.shadowTitle),
      content: anonymizeNoteText(candidate.shadowContent),
    };
    const legacy = {
      title: anonymizeNoteTitle(candidate.legacyTitle),
      content: anonymizeNoteText(candidate.legacyContent),
    };

    pairs.push({
      pairId,
      prompt: candidate.userPrompt,
      tools: candidate.toolNames,
      a: shadowFirst ? shadow : legacy,
      b: shadowFirst ? legacy : shadow,
    });

    key.push({
      pairId,
      turnRef: candidate.turnRef,
      turnId: candidate.turnId,
      sessionId: candidate.sessionId,
      promptNumber: candidate.promptNumber,
      a: shadowFirst ? "shadow" : "legacy",
      b: shadowFirst ? "legacy" : "shadow",
      writerModel: candidate.writerModel,
      shadowInsight: candidate.shadowInsight,
      legacyInsight: candidate.legacyInsight,
    });
  });

  return {
    header: {
      kind: "blind-pairs-header",
      version: 1,
      seed,
      pairCount: pairs.length,
      normalised: [
        "citations collapsed to [ref] on both sides",
        "all whitespace runs collapsed to a single space",
        "structural '<activity>+<topic>:' title prefix stripped from both titles",
        "insight withheld from the judged payload entirely",
      ],
      residualFingerprints: [
        "length distribution: the two writers target different budgets, so body length remains a weak source signal (medians reported by `p1-metrics blind-eval`, deliberately not repeated here)",
        "vocabulary and register: nothing normalises word choice; a judge that has read many pairs could cluster them",
        "pair ORDER within the file follows session and prompt order, so neighbouring pairs are correlated; A/B assignment within a pair is seeded and independent",
      ],
    },
    pairs,
    key,
    stats,
  };
}

export function exportBlindPairs(
  db: Database,
  options: CollectPairOptions & { seed?: number } = {},
): BlindPairExport {
  const { candidates, stats } = collectPairCandidates(db, options);
  return buildBlindPairs(candidates, stats, options);
}

export function toJsonl(rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : "");
}

export interface VerdictRow {
  pairId: string;
  winner: "A" | "B" | "tie";
  reason?: string;
}

export interface UnblindedTally {
  scored: number;
  /** Verdicts naming a pairId the key does not contain. */
  unmatched: string[];
  /** Key pairs no verdict covers. */
  missing: string[];
  /** pairIds a verdict file names more than once. */
  duplicates: string[];
  /** Rows rejected before scoring, labelled by their line in the file. */
  invalid: string[];
  /** Every key pair scored exactly once by a well-formed verdict. */
  complete: boolean;
  shadowWins: number;
  legacyWins: number;
  ties: number;
  /** shadow wins / decided comparisons — null unless the set is complete. */
  shadowWinRate: number | null;
}

/**
 * Accept a verdict row only if it is unambiguously one: a non-empty pairId and
 * one of the three winners. Anything else is a hole in the measurement, and a
 * hole has to be visible — a tolerant reader here would turn a judge that
 * silently answered half the pairs into a clean-looking win rate.
 */
export function parseVerdictRow(value: unknown): VerdictRow | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const pairId = (value as { pairId?: unknown }).pairId;
  const winner = (value as { winner?: unknown }).winner;
  if (typeof pairId !== "string" || pairId.trim() === "") {
    return null;
  }
  if (winner !== "A" && winner !== "B" && winner !== "tie") {
    return null;
  }

  const reason = (value as { reason?: unknown }).reason;
  return {
    pairId: pairId.trim(),
    winner,
    reason: typeof reason === "string" ? reason : undefined,
  };
}

/**
 * Score verdicts against the key. Kept separate from the judge runner on
 * purpose: the runner never reads the key, so a judge process cannot see the
 * mapping even by accident.
 *
 * The scoring is all-or-nothing. A win rate computed over whatever verdicts
 * happened to arrive is not a measurement of the trial, it is a measurement of
 * the pairs the judge found easy enough to answer — failures are not uniformly
 * distributed, so a partial set is biased in an unknown direction. Every gap is
 * therefore named (unmatched / missing / duplicate / malformed) and the rate
 * stays null until there are none.
 */
export function unblindVerdicts(
  verdicts: readonly unknown[],
  key: PairKeyRow[],
): UnblindedTally {
  // Built by hand rather than `new Map(key.map(...))`: a Map constructed from
  // an array with a repeated key silently keeps only the last row, so a
  // corrupt key file — two rows naming the same pairId, possibly two
  // different turns — would score against whichever row happened to be last
  // and never say so. The pairId space has to be a set before it is treated
  // as one; a duplicate here is not a gap to report alongside the others, it
  // is a reason not to trust the key at all.
  const byPairId = new Map<string, PairKeyRow>();
  for (const row of key) {
    if (byPairId.has(row.pairId)) {
      throw new Error(
        `key file is corrupt: pairId ${row.pairId} appears more than once. ` +
          "A Map built from this array would silently keep only the last row.",
      );
    }
    byPairId.set(row.pairId, row);
  }
  const unmatched: string[] = [];
  const duplicates: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  let shadowWins = 0;
  let legacyWins = 0;
  let ties = 0;
  let scored = 0;

  verdicts.forEach((raw, index) => {
    const verdict = parseVerdictRow(raw);
    if (!verdict) {
      invalid.push(`line ${index + 1}`);
      return;
    }

    if (seen.has(verdict.pairId)) {
      duplicates.push(verdict.pairId);
      return;
    }
    seen.add(verdict.pairId);

    const mapping = byPairId.get(verdict.pairId);
    if (!mapping) {
      unmatched.push(verdict.pairId);
      return;
    }

    scored += 1;
    if (verdict.winner === "tie") {
      ties += 1;
      return;
    }

    const source = verdict.winner === "A" ? mapping.a : mapping.b;
    if (source === "shadow") {
      shadowWins += 1;
    } else {
      legacyWins += 1;
    }
  });

  const missing = key
    .map((row) => row.pairId)
    .filter((pairId) => !seen.has(pairId));
  const complete =
    key.length > 0 &&
    invalid.length === 0 &&
    duplicates.length === 0 &&
    unmatched.length === 0 &&
    missing.length === 0;
  const decided = shadowWins + legacyWins;

  return {
    scored,
    unmatched,
    missing,
    duplicates,
    invalid,
    complete,
    shadowWins,
    legacyWins,
    ties,
    shadowWinRate: complete && decided > 0 ? shadowWins / decided : null,
  };
}
