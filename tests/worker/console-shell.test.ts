import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CONSOLE_SHELL_HTML_SOURCE_RELATIVE_PATH,
  CONSOLE_SHELL_MODULE_RELATIVE_PATH,
  renderConsoleShellModule,
} from "../../scripts/generate-console-shell";
import { CONSOLE_SHELL_HTML } from "../../src/worker/console-shell";

/**
 * Shell packaging + DOM-rule acceptance (memory-console spec, "Shell
 * packaging" / "DOM rule"; ticket 04).
 *
 * Two independent concerns in one file:
 *   - the STALE-SHELL GUARD: `console-shell.ts` is a generated, committed
 *     artifact — this proves it is byte-identical to what regenerating from
 *     the canonical `.html` right now would produce, entirely in-process
 *     (no `spawnSync`, no build.js — `generate-console-shell.ts`'s own
 *     module header explains why that precedent does not apply here).
 *   - the DOM RULE sweep: every `.innerHTML =` assignment site in the shell
 *     is inventoried and asserted to route its dynamic (payload-sourced)
 *     content through `esc()` (or a closed-set lookup before it ever
 *     reaches a class/style attribute) before it reaches the DOM. This is a
 *     regression guard over a manual review recorded in the ticket file, not
 *     a full JS parse — see each test's own comment for exactly what it
 *     pins.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..");
const HTML_PATH = join(REPO_ROOT, CONSOLE_SHELL_HTML_SOURCE_RELATIVE_PATH);
const MODULE_PATH = join(REPO_ROOT, CONSOLE_SHELL_MODULE_RELATIVE_PATH);

describe("console-shell.ts stale-shell guard", () => {
  test("committed console-shell.ts is byte-identical to regenerating from console-shell.html right now", () => {
    const html = readFileSync(HTML_PATH, "utf8");
    const expected = renderConsoleShellModule(html);
    const actual = readFileSync(MODULE_PATH, "utf8");
    expect(actual).toBe(expected);
  });

  test("the exported CONSOLE_SHELL_HTML constant is the raw html source verbatim (no truncation, no transform beyond JSON round-trip)", () => {
    const html = readFileSync(HTML_PATH, "utf8");
    expect(CONSOLE_SHELL_HTML).toBe(html);
  });

  test("JSON.stringify, never a backtick template — the source really does contain backticks and ${", () => {
    const html = readFileSync(HTML_PATH, "utf8");
    expect(html).toContain("`");
    expect(html).toContain("${");
    const moduleSource = readFileSync(MODULE_PATH, "utf8");
    // The generated module's OWN wrapper is a plain double-quoted JSON
    // string literal, not a template literal, regardless of what the payload
    // contains.
    expect(moduleSource).toMatch(/export const CONSOLE_SHELL_HTML: string = "/);
  });
});

describe("console-shell.html DOM rule", () => {
  const html = readFileSync(HTML_PATH, "utf8");

  test("no runtime data-fetching relic: the retired static DATA constant is gone", () => {
    expect(html).not.toContain("const DATA = __DATA__");
    expect(html).not.toContain("__DATA__");
  });

  test("fetches all three console API endpoints (sessions, segments, graph) — no embedded snapshot left to render instead", () => {
    expect(html).toContain('"/api/console/sessions"');
    expect(html).toContain('"/api/console/segments"');
    expect(html).toContain("/api/console/graph?");
  });

  test("the CSP meta tag matches the spec's exact directive string", () => {
    expect(html).toContain(
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; connect-src \'self\'">',
    );
  });

  test("every dynamic innerHTML sink that carries payload-sourced text wraps it in esc(), or the sink is a pure clear (`= \"\"`)", () => {
    // Inventory every `X.innerHTML = ...` / `X.innerHTML=...` assignment
    // site — a regression here (a NEW sink added without this test being
    // updated) fails LOUD by drifting this count, rather than silently
    // passing an unreviewed site.
    const sinkLines = html
      .split("\n")
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => /\.innerHTML\s*=/.test(line) && !/tipEl\.innerHTML/.test(line));
    // Nine sites: sesBox/segBox clears (2), a session row, a segment row, the
    // filter-bar checkbox label, the two lane-group headers, a lane chip, and
    // the turn panel (pbody, whose template spans multiple lines — matched
    // once at its `pbody.innerHTML =` line). `svg.innerHTML = ""` is the
    // tenth and is a pure clear.
    expect(sinkLines.length).toBeGreaterThanOrEqual(9);

    for (const { line, i } of sinkLines) {
      const isPureClear = /\.innerHTML\s*=\s*"";?\s*$/.test(line);
      if (isPureClear) continue;
      // Every non-clear sink observed in this file assigns from a template
      // literal on the SAME or a following line; collect a small window so a
      // multi-line template (the turn panel, the segment row) is captured
      // whole rather than judged one line at a time.
      const windowText = html.split("\n").slice(i, i + 8).join("\n");
      // Any interpolation of a KNOWN free-text/DB-sourced identifier must be
      // wrapped in esc(...) immediately, or must route through esc via a
      // named local (laneChipsHtml, dotClass) that this suite checks by
      // hand below. This loop specifically guards the common regression: a
      // bare `${s.title}` / `${g.title}` / `${e.relation}` / `${e.tags...}`
      // / `${t.title}` / `${t.promptExcerpt}` / `${t.contentExcerpt}` with NO
      // esc() wrapping anywhere in the same template.
      const bareDangerousField =
        /\$\{(?:s|g|t)\.(?:title|status|date)(?!\s*\)|\.\w)\}/.test(windowText) ||
        /\$\{e\.relation\}/.test(windowText) ||
        /\$\{e\.tags\.join/.test(windowText);
      expect(bareDangerousField).toBe(false);
    }
  });

  test("the edge tooltip (tip()) escapes relation and tags — the twin sink to the panel's erow, patched to match it", () => {
    const tooltipBlock = html.slice(html.indexOf('addEventListener("mousemove"'), html.indexOf('addEventListener("mouseleave"'));
    expect(tooltipBlock).toContain("esc(e.relation)");
    expect(tooltipBlock).toContain("esc(e.tags.join");
  });

  test("relation words reach a style attribute only through the relationVar() closed-set lookup, never bare interpolation", () => {
    expect(html).toContain("const relationVar = rel =>");
    expect(html).not.toMatch(/style="color:var\(--\$\{e\.relation\}\)"/);
    expect(html).toContain("style=\"color:${relationVar(e.relation)}\"");
  });

  test("segment status reaches a class attribute only through the SEGMENT_STATUS_DOT closed-set lookup, never bare interpolation", () => {
    expect(html).toContain("const SEGMENT_STATUS_DOT = { open:");
    expect(html).not.toMatch(/class="sdot \$\{g\.status\}"/);
  });

  test("stateCoverage: partial and the worker-stopped state render via textContent (banner text needs no esc(), and this pins that they never switch to innerHTML with raw payload text)", () => {
    expect(html).toContain("partialBanner.textContent =");
    expect(html).not.toMatch(/partialBanner\.innerHTML/);
    expect(html).not.toMatch(/stoppedBanner\.innerHTML/);
  });
});

describe("console-shell.html behavior-matrix wiring spot checks", () => {
  const html = readFileSync(HTML_PATH, "utf8");

  test("no heartbeat / auto-retry loop: no setInterval anywhere, and the only setTimeout is the toast auto-hide", () => {
    expect(html).not.toContain("setInterval(");
    const setTimeoutCalls = html.match(/setTimeout\(/g) ?? [];
    expect(setTimeoutCalls.length).toBe(1);
  });

  test("manual retry is wired to the stopped banner's own button, not fired automatically", () => {
    expect(html).toContain('getElementById("stoppedRetry")');
    expect(html).toContain("if (lastLoad) lastLoad();");
  });

  test("clicking a session or segment row calls loadGraph (the static-data placeholder toast retired)", () => {
    expect(html).toContain('loadGraph({ session: s.id })');
    expect(html).toContain('loadGraph({ segment: g.id })');
    expect(html).not.toContain("模板为静态内嵌数据");
  });

  test("lane focus, chip scroll-to-anchor, blank-click/Esc clear, and two-stage panel toggling are all still present", () => {
    expect(html).toContain("function select(id){");
    expect(html).toContain("function clearFocus(){");
    expect(html).toContain('e.key==="Escape"');
    expect(html).toContain("scrollTo({top:");
  });
});
