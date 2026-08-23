#!/usr/bin/env bun
/**
 * Shell packaging (memory-console spec, "Shell packaging"; ticket 04). The
 * canonical shell is `src/worker/console-shell.html`, a repo `.html` file —
 * this script is the ONE place that turns it into the version-controlled TS
 * constant `src/worker/console-shell.ts` imports at runtime.
 *
 * `renderConsoleShellModule` is exported and PURE (no file I/O) so
 * `tests/worker/console-shell.test.ts` can call it directly against the
 * checked-out `.html` file and byte-compare the result to the committed
 * `.ts` file, in-process — the stale-shell guard, same posture as
 * `tests/shared/release-artifacts.test.ts`'s bundle guard but without that
 * guard's `spawnSync("node", ["scripts/build.js"])` step: there is no
 * bundler here, `console-shell.ts` needs no esbuild pass to compare, so
 * shelling out would only add a subprocess for no benefit.
 *
 * `JSON.stringify`, never a backtick template literal: `console-shell.html`
 * itself contains backticks and `${` sequences (its own inline `<script>`
 * uses template literals extensively) — wrapping that text in ANOTHER
 * template literal would let the shell's own backticks terminate the outer
 * one early and corrupt the generated module. `JSON.stringify` escapes every
 * byte that matters (quotes, backslashes, control characters) and produces a
 * plain double-quoted string literal that is valid in both JS and TS,
 * regardless of what the HTML payload contains.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CONSOLE_SHELL_HTML_SOURCE_RELATIVE_PATH = join("src", "worker", "console-shell.html");
export const CONSOLE_SHELL_MODULE_RELATIVE_PATH = join("src", "worker", "console-shell.ts");

const GENERATED_HEADER = `// GENERATED FILE — do not edit by hand.
// Regenerate with \`bun scripts/generate-console-shell.ts\` after editing the
// canonical ${CONSOLE_SHELL_HTML_SOURCE_RELATIVE_PATH.split("/").join("/")}.
// See that script's own module header (memory-console spec, "Shell
// packaging") for why this is JSON.stringify'd rather than a template
// literal: the shell's own inline <script> contains backticks and \${...}.
`;

/** Pure: `.html` source text -> the exact `.ts` module source text. */
export function renderConsoleShellModule(html: string): string {
  return `${GENERATED_HEADER}export const CONSOLE_SHELL_HTML: string = ${JSON.stringify(html)};\n`;
}

function main(): void {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = dirname(scriptDir);
  const htmlPath = join(projectRoot, CONSOLE_SHELL_HTML_SOURCE_RELATIVE_PATH);
  const outputPath = join(projectRoot, CONSOLE_SHELL_MODULE_RELATIVE_PATH);

  const html = readFileSync(htmlPath, "utf8");
  const moduleSource = renderConsoleShellModule(html);
  writeFileSync(outputPath, moduleSource, "utf8");
  // eslint-disable-next-line no-console
  console.log(`wrote ${CONSOLE_SHELL_MODULE_RELATIVE_PATH} (${moduleSource.length} chars)`);
}

if (import.meta.main) {
  main();
}
