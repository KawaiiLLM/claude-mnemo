/**
 * The o200k_base rank data ships in js-tiktoken behind an `exports`-map
 * subpath (`js-tiktoken/ranks/o200k_base` → `dist/ranks/o200k_base.js`) with
 * no physical file at the bare specifier's path. esbuild, bun and Node all
 * resolve it through the exports map; this repo's tsc runs `moduleResolution:
 * "node"` (node10), which does not read exports maps, so the type side is
 * declared here instead of flipping the whole project's resolution mode for
 * one import. The shape mirrors `dist/ranks/o200k_base.d.ts` verbatim — it is
 * exactly `TiktokenBPE` from `js-tiktoken/lite` (which node10 DOES resolve,
 * via the package's root-level `lite.d.ts` stub).
 */
declare module "js-tiktoken/ranks/o200k_base" {
  import type { TiktokenBPE } from "js-tiktoken/lite";

  const ranks: TiktokenBPE;
  export default ranks;
}
