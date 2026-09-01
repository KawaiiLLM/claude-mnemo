// Experiment harness — read-only over src/. Usage:
//   bun .scratch/impression-as-index/experiments/validate.ts <file> <cap> [<file> <cap> ...]
// Identical to .scratch/lane-impressions/experiments/validate.ts except that the resolved-anchor
// set also carries lane D's session (S24117), which did not exist in the prior corpus.
// `validateImpression()` is imported from HEAD and run UNMODIFIED; no src/ file is touched.
import { readFileSync } from "node:fs";
import {
  validateImpression,
  anchorResolverFromResolvedSet,
} from "../../../src/shared/lane-impressions";
import { countTokens } from "../../../src/shared/token-count";

const resolved = new Set<string>();
for (const t of [
  82, 85, 86, 87, 88, 89, 93, 95, 96, 97, 98, 99, 101, 102, 103, 104, 105, 106,
  107, 108, 109, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 132, 133,
  135, 149, 159, 160, 164, 168, 179, 196, 197, 198, 199,
]) {
  resolved.add(`S18993/T${t}`);
}
for (const t of [41, 44, 51, 57, 60]) resolved.add(`S22040/T${t}`);
for (const t of [12, 19, 23, 34, 38, 41, 44]) resolved.add(`S24117/T${t}`);

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  const path = args[i]!;
  const cap = Number.parseInt(args[i + 1]!, 10);
  const raw = readFileSync(path, "utf8");
  const firstNewline = raw.indexOf("\n");
  const head = (firstNewline === -1 ? raw : raw.slice(0, firstNewline)).trim();
  console.log(`\n### ${path}  (cap=${cap})`);
  if (head === "RETAIN") {
    console.log("  decision: RETAIN (no text to validate)");
    continue;
  }
  const text =
    head === "REPLACE" ? raw.slice(firstNewline + 1).replace(/\n$/, "") : raw.replace(/\n$/, "");
  const result = validateImpression({
    text,
    cap,
    resolveAnchor: anchorResolverFromResolvedSet(resolved),
  });
  const lines = text.split("\n");
  console.log(
    `  lines=${lines.length}  total=${countTokens(text)}tok  per-line=[${lines
      .map((l) => countTokens(l))
      .join(", ")}]`,
  );
  console.log(`  accepted=${result.accepted}`);
  for (const r of result.rejections) console.log(`  REJECT[${r.rule}] ${r.message}`);
  for (const w of result.warnings) console.log(`  warn[${w.rule}] ${w.message}`);
}
