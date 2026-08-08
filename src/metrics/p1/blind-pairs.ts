import type { Database } from "bun:sqlite";

import { formatTurnAddress } from "../../hooks/note-reminder";

/**
 * Metric (b): pair a turn's agent-written note against the legacy pipeline's
 * summary of the same turn, strip everything that identifies the author, and
 * hand the pair to a judge.
 *
 * The blinding is the whole product here. Three tells were found and removed:
 *
 *   - citation syntax — the agent writes `[S15069/T332]` (spec D7), the legacy
 *     pipeline wrote bare `[T332]`, so the bracket form alone names the author;
 *     both are collapsed to `[ref]`;
 *   - layout — notes are written as one paragraph, legacy summaries often carry
 *     bullets and hard wraps, so all whitespace runs collapse to a single space
 *     on both sides. This costs the judge any credit for good structure, which
 *     is the price of a comparison the judge cannot shortcut;
 *   - field set — `insight` fill rate differs by design (56% legacy vs the
 *     10-20% the spec targets), so a pair that showed insight would leak the
 *     author on the strength of an empty field. Insight travels in the key file
 *     for later analysis and never in the judged payload.
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
}

export interface BlindPairExport {
  pairs: BlindPair[];
  key: PairKeyRow[];
  stats: PairExportStats;
}

const CITATION_PATTERN = /\[(?:S\d+\/)?T\d+\]|\[E\d+\]/gu;
const DEFAULT_PROMPT_CHARACTERS = 600;

/** Remove the author's fingerprints without touching the substance. */
export function anonymizeNoteText(text: string): string {
  return text
    .replace(CITATION_PATTERN, "[ref]")
    .replace(/\s+/gu, " ")
    .trim();
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
    ${options.sessionId === undefined ? "" : "WHERE t.session_id = ?"}
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
  };

  return { candidates, stats };
}

export function buildBlindPairs(
  candidates: PairCandidate[],
  stats: PairExportStats,
  options: { seed?: number } = {},
): BlindPairExport {
  const random = createSeededRandom(options.seed ?? 1);
  const pairs: BlindPair[] = [];
  const key: PairKeyRow[] = [];

  candidates.forEach((candidate, index) => {
    const pairId = `p${String(index + 1).padStart(4, "0")}`;
    const shadowFirst = random() < 0.5;

    const shadow = {
      title: anonymizeNoteText(candidate.shadowTitle),
      content: anonymizeNoteText(candidate.shadowContent),
    };
    const legacy = {
      title: anonymizeNoteText(candidate.legacyTitle),
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

  return { pairs, key, stats };
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
  unmatched: string[];
  shadowWins: number;
  legacyWins: number;
  ties: number;
  /** shadow wins / decided comparisons — the no-go gate's input. */
  shadowWinRate: number | null;
}

/**
 * Score verdicts against the key. Kept separate from the judge runner on
 * purpose: the runner never reads the key, so a judge process cannot see the
 * mapping even by accident.
 */
export function unblindVerdicts(
  verdicts: VerdictRow[],
  key: PairKeyRow[],
): UnblindedTally {
  const byPairId = new Map(key.map((row) => [row.pairId, row]));
  const unmatched: string[] = [];
  let shadowWins = 0;
  let legacyWins = 0;
  let ties = 0;
  let scored = 0;

  for (const verdict of verdicts) {
    const mapping = byPairId.get(verdict.pairId);
    if (!mapping) {
      unmatched.push(verdict.pairId);
      continue;
    }

    scored += 1;
    if (verdict.winner === "tie") {
      ties += 1;
      continue;
    }

    const source = verdict.winner === "A" ? mapping.a : mapping.b;
    if (source === "shadow") {
      shadowWins += 1;
    } else {
      legacyWins += 1;
    }
  }

  const decided = shadowWins + legacyWins;

  return {
    scored,
    unmatched,
    shadowWins,
    legacyWins,
    ties,
    shadowWinRate: decided > 0 ? shadowWins / decided : null,
  };
}
