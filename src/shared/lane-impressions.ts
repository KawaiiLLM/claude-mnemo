import { countTokens } from "./token-count";

/**
 * Lane impressions — the deterministic foundation (lane-impressions spec Rev 8,
 * ticket 01): the absolute member cap and the write-time validator's
 * DETERMINISTIC tier, both pure so the terminal settlement transaction can run
 * them in-line (tickets 02/03 wire the writers; nothing here touches a DB).
 *
 * The honest two-tier split (spec "Validator", peer finding 6) is a boundary,
 * not an aspiration: everything in this module is mechanical and rejects (or
 * warns) by rule; the STATE CEILING — whether a resolvable anchor actually
 * PROVES the delivery its sentence claims — and LINE 1's semantic
 * self-containment are teaching duties, deliberately NOT checked here. Lint
 * coverage must never be mistaken for state-ceiling coverage.
 */

// ---------------------------------------------------------------------------
// Caps (spec "Storage"; USER RULED T2259-T2261).
// ---------------------------------------------------------------------------

/** Prefix-readable line form: at most this many newline-delimited lines. */
export const IMPRESSION_MAX_LINES = 8;

/**
 * Line 1 is the GLOBAL IMPRESSION (USER RULED T2260-T2261): one self-contained
 * line carrying the lane's whole shape, ≤150 tokens — and ≤ the lane's total
 * cap where that binds tighter (a 100-cap lane's line 1 is capped at 100).
 */
export const IMPRESSION_LINE1_TOKEN_CAP = 150;

/** Lines 2+ deepen the model; each caps at 60 tokens. */
export const IMPRESSION_LINE_TOKEN_CAP = 60;

/** The task-tier impression keeps a flat 500 cap (spec "Storage"). */
export const TASK_IMPRESSION_TOKEN_CAP = 500;

const IMPRESSION_CAP_TOKENS_PER_MEMBER = 10;
const IMPRESSION_CAP_FLOOR = 100;
const IMPRESSION_CAP_CEILING = 500;

/**
 * The ABSOLUTE per-lane total cap (USER RULED T2259-T2261, replacing the
 * proportional form whose floor degenerated at high lane counts):
 *
 *   cap_lane = clamp(10 × settledMembers_lane, 100, 500)
 *
 * Integer arithmetic, no denominator, no division-by-zero shape, LOCAL — only
 * this lane's own membership moves its cap. A brand-new lane has 0 members →
 * cap = 100 (the clamp floor; no special case). `settledMemberCount` is the
 * SETTLED, CANONICAL, ERA-SCOPED lane universe shared with the frontier
 * section and lane-adjacency view — `settledMemberCountForLane`
 * (src/mcp/timeline.ts) is the counting side; this function is only the
 * formula, so the terminal transaction can recompute the cap on its
 * post-commit projection with the SAME integer arithmetic the advisory cap
 * used.
 */
export function impressionCapForLane(settledMemberCount: number): number {
  if (!Number.isSafeInteger(settledMemberCount) || settledMemberCount < 0) {
    throw new TypeError(
      `impressionCapForLane expects a non-negative integer member count, got ${String(settledMemberCount)}`,
    );
  }
  return Math.min(
    IMPRESSION_CAP_CEILING,
    Math.max(
      IMPRESSION_CAP_FLOOR,
      IMPRESSION_CAP_TOKENS_PER_MEMBER * settledMemberCount,
    ),
  );
}

// ---------------------------------------------------------------------------
// Deterministic validator.
// ---------------------------------------------------------------------------

/**
 * Anchor grammar (spec "Storage"): qualified fold — the FIRST anchor in a line
 * is full `S<n>/T<m>`; later same-session anchors in the same line MAY fold to
 * bare `T<m>` (the golden sample repeats the full form freely — folding is
 * permitted, never required). A bare `T<m>` binds to the session of the
 * NEAREST PRECEDING full anchor on its own line; with no preceding full anchor
 * it is a bare citation with no session context, and rejects.
 *
 * Uppercase by the address grammar (`S<n>/T<m>` is the stored form everywhere
 * a jump target renders); a lowercase lookalike is prose here, which is the
 * conservative reading — it never resolves, so it can never carry a delivery
 * word.
 */
const ANCHOR_TOKEN_RE = /\bS(\d+)\/T(\d+)\b|\bT(\d+)\b/g;

/**
 * Delivery-class words (spec "Validator", deterministic tier): these exact
 * four forms, word-bounded, case-insensitive. A line asserting delivery with
 * no anchor on it is unfalsifiable and rejects; whether the anchor PROVES the
 * delivery stays semantic (teaching tier).
 */
const DELIVERY_WORD_RE = /\b(shipped|landed|committed|released)\b/i;

/** Sequence words invite chronology creep; soft lint — warns, never rejects. */
const SEQUENCE_WORD_RE = /\b(then|later|subsequently|finally|eventually)\b/gi;

export type ImpressionRejectionRule =
  | "structure"
  | "line-count"
  | "line-1-cap"
  | "line-cap"
  | "total-cap"
  | "anchor-format"
  | "anchor-unresolvable"
  | "delivery-anchor";

export type ImpressionWarningRule = "sequence-word";

export interface ImpressionRejection {
  rule: ImpressionRejectionRule;
  /** 1-based line number; null when the whole text is at fault. */
  line: number | null;
  message: string;
}

export interface ImpressionWarning {
  rule: ImpressionWarningRule;
  line: number;
  message: string;
}

/** One parsed, well-formed anchor occurrence (bare forms already unfolded). */
export interface ImpressionAnchor {
  sessionId: number;
  promptNumber: number;
  /** 1-based line number the anchor appears on. */
  line: number;
  /** The matched text as written (`S12/T3` or a folded `T4`). */
  raw: string;
}

export interface ImpressionValidationResult {
  accepted: boolean;
  rejections: ImpressionRejection[];
  warnings: ImpressionWarning[];
  /** Every well-formed anchor, unfolded — the resolvability inputs. */
  anchors: ImpressionAnchor[];
}

/**
 * Resolvability seam: TRUE iff `S<sessionId>/T<promptNumber>` names a turn
 * that exists. In a transaction, pass the DB-backed resolver
 * (`dbImpressionAnchorResolver`, src/db/impressions.ts — the existing
 * citation-validation lookup); outside one, a resolved-address set via
 * `anchorResolverFromResolvedSet`.
 */
export type ImpressionAnchorResolver = (
  sessionId: number,
  promptNumber: number,
) => boolean;

/** Set-backed resolver over canonical `S<n>/T<m>` address strings. */
export function anchorResolverFromResolvedSet(
  resolved: ReadonlySet<string>,
): ImpressionAnchorResolver {
  return (sessionId, promptNumber) =>
    resolved.has(`S${sessionId}/T${promptNumber}`);
}

export interface ValidateImpressionInput {
  /** The exact text that would be stored — validated byte-for-byte. */
  text: string;
  /**
   * The lane's total token cap (`impressionCapForLane(...)`,
   * or `TASK_IMPRESSION_TOKEN_CAP` for the task tier).
   */
  cap: number;
  resolveAnchor: ImpressionAnchorResolver;
}

/**
 * The deterministic tier, whole: every check runs and every violation reports
 * (the citation machinery's own posture — a writer gets ALL its rejections to
 * fix in one pass, never one at a time). Checks:
 *
 *   - structure: non-empty text, no blank lines (a trailing newline is a
 *     blank last line and rejects — the stored form is exact);
 *   - line-count: ≤ 8 lines;
 *   - line-1-cap: line 1 ≤ min(150, cap) tokens;
 *   - line-cap: each of lines 2+ ≤ 60 tokens;
 *   - total-cap: the whole text ≤ cap tokens;
 *   - anchor-format: bare `T<m>` only after a full `S<n>/T<m>` on its line;
 *   - anchor-unresolvable: every well-formed anchor resolves to a turn;
 *   - delivery-anchor: a delivery-class word on a line with no well-formed
 *     anchor rejects.
 *
 * Warnings (never rejections): sequence words (then/later/subsequently/
 * finally/eventually).
 *
 * NOT checked, on purpose (spec's two-tier split): line 1's semantic
 * self-containment, and whether an anchor's target actually proves the state
 * its sentence claims — both are settlement's teaching duties.
 *
 * Token counts price through the runtime tokenizer (`countTokens`, o200k
 * ranks) — "cap" means exact against that counter, not a char-class guess.
 */
export function validateImpression(
  input: ValidateImpressionInput,
): ImpressionValidationResult {
  const { text, cap, resolveAnchor } = input;
  if (!Number.isSafeInteger(cap) || cap < 1) {
    throw new TypeError(
      `validateImpression expects a positive integer cap, got ${String(cap)}`,
    );
  }

  const rejections: ImpressionRejection[] = [];
  const warnings: ImpressionWarning[] = [];
  const anchors: ImpressionAnchor[] = [];

  if (text.trim().length === 0) {
    rejections.push({
      rule: "structure",
      line: null,
      message: "impression text is empty",
    });
    return { accepted: false, rejections, warnings, anchors };
  }

  const lines = text.split("\n");

  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) {
      rejections.push({
        rule: "structure",
        line: index + 1,
        message: `line ${index + 1} is blank — the line form is newline-delimited prose with no blank lines (a trailing newline is a blank last line)`,
      });
    }
  }

  if (lines.length > IMPRESSION_MAX_LINES) {
    rejections.push({
      rule: "line-count",
      line: null,
      message: `${lines.length} lines exceed the ${IMPRESSION_MAX_LINES}-line maximum`,
    });
  }

  const line1Cap = Math.min(IMPRESSION_LINE1_TOKEN_CAP, cap);
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const tokens = countTokens(line);
    if (lineNumber === 1 && tokens > line1Cap) {
      rejections.push({
        rule: "line-1-cap",
        line: 1,
        message: `line 1 (the global impression) is ${tokens} tokens, over its ${line1Cap}-token cap (min of ${IMPRESSION_LINE1_TOKEN_CAP} and the lane cap ${cap})`,
      });
    } else if (lineNumber > 1 && tokens > IMPRESSION_LINE_TOKEN_CAP) {
      rejections.push({
        rule: "line-cap",
        line: lineNumber,
        message: `line ${lineNumber} is ${tokens} tokens, over the ${IMPRESSION_LINE_TOKEN_CAP}-token per-line cap`,
      });
    }
  }

  const totalTokens = countTokens(text);
  if (totalTokens > cap) {
    rejections.push({
      rule: "total-cap",
      line: null,
      message: `impression is ${totalTokens} tokens, over its ${cap}-token cap`,
    });
  }

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    let foldSessionId: number | null = null;
    let wellFormedAnchorsOnLine = 0;

    ANCHOR_TOKEN_RE.lastIndex = 0;
    for (const match of line.matchAll(ANCHOR_TOKEN_RE)) {
      if (match[1] !== undefined && match[2] !== undefined) {
        const sessionId = Number.parseInt(match[1], 10);
        const promptNumber = Number.parseInt(match[2], 10);
        foldSessionId = sessionId;
        wellFormedAnchorsOnLine += 1;
        anchors.push({ sessionId, promptNumber, line: lineNumber, raw: match[0] });
      } else if (match[3] !== undefined) {
        if (foldSessionId === null) {
          rejections.push({
            rule: "anchor-format",
            line: lineNumber,
            message: `line ${lineNumber}: bare anchor "${match[0]}" has no preceding full S<n>/T<m> on its line to fold from — the first anchor in a line must be the full form`,
          });
          continue;
        }
        const promptNumber = Number.parseInt(match[3], 10);
        wellFormedAnchorsOnLine += 1;
        anchors.push({
          sessionId: foldSessionId,
          promptNumber,
          line: lineNumber,
          raw: match[0],
        });
      }
    }

    const deliveryMatch = DELIVERY_WORD_RE.exec(line);
    if (deliveryMatch && wellFormedAnchorsOnLine === 0) {
      rejections.push({
        rule: "delivery-anchor",
        line: lineNumber,
        message: `line ${lineNumber}: delivery-class word "${deliveryMatch[1]}" with no anchor on its line — a delivery claim must carry the address that proves it`,
      });
    }

    SEQUENCE_WORD_RE.lastIndex = 0;
    const sequenceWords = [...line.matchAll(SEQUENCE_WORD_RE)].map(
      (match) => match[1]!,
    );
    if (sequenceWords.length > 0) {
      warnings.push({
        rule: "sequence-word",
        line: lineNumber,
        message: `line ${lineNumber}: sequence word(s) ${sequenceWords.map((word) => `"${word}"`).join(", ")} — impressions are model claims, not chronology; consider restating without narrative order`,
      });
    }
  }

  for (const anchor of anchors) {
    if (!resolveAnchor(anchor.sessionId, anchor.promptNumber)) {
      rejections.push({
        rule: "anchor-unresolvable",
        line: anchor.line,
        message: `line ${anchor.line}: anchor S${anchor.sessionId}/T${anchor.promptNumber} (written "${anchor.raw}") does not resolve to a turn`,
      });
    }
  }

  return { accepted: rejections.length === 0, rejections, warnings, anchors };
}
