/**
 * The worker tool channel's RESPONSE ENVELOPE, as three numbers.
 *
 * Extracted from `mcp/handlers.ts` (phase-connectivity ticket 07, decision 3)
 * for one reason: the lane read receipt has to answer "would this delivery be
 * cut" from inside `mcp/recall.ts`, and `handlers.ts` already imports
 * `recall.ts` — reaching back the other way would close an import cycle. The
 * envelope's own code stays in `handlers.ts`; only the constants live here,
 * and `handlers.ts` re-exports them so every pre-existing import site
 * (`worker/diary-sdk-query.ts`) is untouched.
 */

/** The worker tool channel truncates a result longer than this many characters. */
export const WORKER_TOOL_RESULT_MAX_CHARS = 100_000;

export const WORKER_TOOL_RESULT_TRUNCATION_HINT =
  "\n\n[工具返回已达上限；请用分页或收窄选择器继续。]";

/**
 * The number of CONTENT characters a CUT delivery actually carries — the hint
 * is appended inside the cap, so a truncated result's real payload is this
 * much and no more.
 *
 * This, not `WORKER_TOOL_RESULT_MAX_CHARS`, is the threshold a caller should
 * judge "did my bytes reach the reader" against, and the judgment is then
 * one-directional in the safe direction: a render whose end offset is at or
 * under this number is delivered whole whether or not the envelope cut
 * anything (an uncut response delivers everything; a cut one delivers exactly
 * this prefix), while a render that ends past it may or may not have arrived.
 * Private-tag stripping only ever REMOVES characters, so an offset measured in
 * unstripped coordinates is an over-estimate of the same offset in the
 * stripped text the envelope actually slices — which again errs towards
 * "assume it did not arrive".
 */
export const WORKER_TOOL_RESULT_CONTENT_LIMIT = Math.max(
  0,
  WORKER_TOOL_RESULT_MAX_CHARS - WORKER_TOOL_RESULT_TRUNCATION_HINT.length,
);
