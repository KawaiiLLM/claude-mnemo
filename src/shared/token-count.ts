import { Tiktoken } from "js-tiktoken/lite";
import o200k_base from "js-tiktoken/ranks/o200k_base";

/**
 * REAL token counting against pinned o200k_base ranks — the budget reference
 * for every frontier-injection surface (frontier-injection spec, "Budget
 * arithmetic"; USER RULED S15069/T2218: runtime tokenizer over calibrated
 * heuristic, dependency cost accepted). "Hard bound" in that spec means exact
 * against THIS function, not against a char-class guess.
 *
 * This is deliberately a THIRD counter beside the two estimators, not a
 * replacement for either (`src/utils/token-estimate.ts` documents their
 * audience split): `estimateTokens` keeps pricing what an agent WRITES
 * (note receipts — a calibrated-in-4-chars-per-token contract with existing
 * budgets), `estimateDiaryTokens` keeps sizing the diary injection. Frontier
 * surfaces alone (tickets 02/04: the SessionStart frontier block and the lane
 * view's page partition) price through this counter, because their budgets
 * are declared in real tokens and enforced as hard bounds.
 *
 * Lazy initialization: parsing the ~200K-entry rank table into the encoder's
 * maps costs ~100ms — paid on the FIRST count, never at module load, because
 * this module rides in the SessionStart hook bundle and hooks are
 * latency-sensitive (the rank DATA is still a module-load cost, but that is
 * string-literal parse, single-digit milliseconds). The encoder is retained
 * for the process lifetime; every later count is sub-millisecond.
 */
let encoder: Tiktoken | undefined;

/**
 * Exact o200k_base token count of `text`.
 *
 * Special-token strings (`<|endoftext|>` and friends) are counted as ORDINARY
 * text (`disallowedSpecial: []`), never thrown on and never collapsed to a
 * special id: the input here is rendered memory content being measured
 * against a budget, and a title that happens to quote a special token must
 * price as the bytes a model would actually read, not crash the render.
 */
export function countTokens(text: string): number {
  encoder ??= new Tiktoken(o200k_base);
  return encoder.encode(text, undefined, []).length;
}

/**
 * Env-gated self-test — and, until tickets 02/04 land their real call sites,
 * the statement that KEEPS the ranks in the shipped bundles. esbuild's
 * tree-shake proves a bare `void countTokens` reference pure and deletes the
 * entire rank chain with it (measured: the bundle grew 9KB — the Tiktoken
 * class — while the 2.3MB rank table silently vanished); an env read is not
 * provably pure, so this call anchors `countTokens` → encoder → ranks for
 * every bundle that imports this module. It doubles as the cold-init probe
 * the shipped artifact can run directly:
 *
 *   MNEMO_TOKENIZER_SELFTEST=1 node plugin/scripts/hook-command.cjs --help
 */
if (process.env.MNEMO_TOKENIZER_SELFTEST === "1") {
  const start = performance.now();
  const count = countTokens(" extends");
  const elapsed = (performance.now() - start).toFixed(1);
  console.error(
    `[claude-mnemo] o200k_base self-test: " extends" -> ${count} token(s), cold init ${elapsed}ms`,
  );
}
