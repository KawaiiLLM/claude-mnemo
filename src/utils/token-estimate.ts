/**
 * A character-class token estimate for text an agent WRITES against a stated
 * budget — today the `note` receipt and the size guard on the injected
 * note-taking block.
 *
 * Four characters per token holds for English and is what the note budgets were
 * calibrated in, but it under-reports CJK by about four times: a tokenizer
 * spends roughly a token per Han/kana/Hangul character, so 80 Chinese
 * characters cost ~80 tokens and were reported as 20. Note fields are English
 * by rule, and the same instructions explicitly allow quoted user phrases in
 * their original language, so a note can be four times over budget and read as
 * inside it — the one thing the receipt exists to prevent.
 *
 * Deliberately not the diary's `estimateDiaryTokens`, and deliberately not a
 * third function beside it. That one weights every character (1.1 Han / 0.6
 * other, ×1.2) to size an injection block, which reads about three times high
 * on English prose — correct for a hard injection cap that must never be
 * exceeded, wrong for a budget an English note is supposed to fit inside.
 * There is one estimator per audience: this one for what an agent writes, that
 * one for what the injector spends — EXCEPT the timeline milestones fitter
 * (`src/mcp/timeline.ts`), which is an injector that deliberately prices with
 * THIS estimator instead: its content is English-by-rule (milestone rows, not
 * user prose), so the diary weights' three-times-high inflation only starved
 * real seats without buying real safety, and the hard cap it still needs
 * comes from the char-ladder (`MAX_INJECTED_BLOCK_CHARS` +
 * `SEGMENT_BLOCK_DEMOTE_BUDGETS` in `src/hooks/session-composition.ts`), not
 * from over-pricing the token count.
 */
export const CJK_CHARACTER =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * A maximal run of TWO OR MORE consecutive U+0020 spaces prices as ONE token
 * total, not one per character — whitespace-runs-price-as-one-token ticket
 * 14 (user challenge [S15069/T1915], "不是4个空格对应一个token吧", confirmed
 * by BPE behavior: an indent-width run of spaces is a single vocabulary
 * token, not `length / 4` of one). A single space stays on the general
 * 1/4-per-char "rest" rate below — the 4-chars-per-token English average
 * already accounts for word-separating spaces, which BPE folds into the
 * FOLLOWING word's own token. Only U+0020: tabs and other whitespace are
 * untouched (not used by the renderers that price through this function).
 *
 * `\n` deliberately keeps the plain 1/4 rate too, even though a newline plus
 * its following indent often collapses to one real BPE token just like a
 * space run does: this estimator does not special-case it, so the estimate
 * stays a touch conservative (under-fills before it ever overshoots) rather
 * than chasing every whitespace shape BPE happens to fold.
 */
const SPACE_RUN = / {2,}/g;

export function estimateTokens(text: string): number {
  let cjk = 0;
  let rest = 0;
  // Iterated by code point, not by UTF-16 unit, so a rare Han character outside
  // the BMP counts once rather than twice.
  for (const character of text) {
    if (CJK_CHARACTER.test(character)) {
      cjk += 1;
    } else {
      rest += 1;
    }
  }

  // Space runs price as whole tokens, backed out of the generic 1/4-per-char
  // `rest` pool above rather than added on top of it (a run's own characters
  // are already counted in `rest`).
  let spaceRunChars = 0;
  let spaceRunTokens = 0;
  for (const run of text.match(SPACE_RUN) ?? []) {
    spaceRunChars += run.length;
    spaceRunTokens += 1;
  }

  return Math.ceil(cjk + spaceRunTokens + (rest - spaceRunChars) / 4);
}
