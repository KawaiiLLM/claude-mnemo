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
 * one for what the injector spends.
 */
const CJK_CHARACTER =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

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

  return Math.ceil(cjk + rest / 4);
}
