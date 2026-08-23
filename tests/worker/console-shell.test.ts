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

  test("no bare innerHTML clear sink is left unaccounted for (sanity floor, not the security pin below)", () => {
    // A loose sanity check that the sink inventory itself hasn't shrunk —
    // NOT the security guard (that's the per-field suite below, which pins
    // each payload-sourced sink individually rather than just counting
    // sites). Kept so a wholesale removal of rendering code is still noticed
    // here too.
    const sinkLines = html
      .split("\n")
      .filter((line) => /\.innerHTML\s*=/.test(line) && !/tipEl\.innerHTML/.test(line));
    expect(sinkLines.length).toBeGreaterThanOrEqual(9);
  });

  /**
   * Per-field escaping invariants (peer finding #9). The sink-COUNT test
   * this replaces stayed green even after `esc()` was silently dropped from
   * a currently-safe field (e.g. `${esc(t.contentExcerpt)}` ->
   * `${t.contentExcerpt}`): the number of `.innerHTML =` assignment SITES
   * never changes when only the argument inside one changes, so a counter
   * has no teeth against that regression. Every payload-sourced field the
   * shell renders is enumerated below by its EXACT escaped interpolation
   * site (titles, an excerpt pair, tags, lane tokens, relation words, and
   * status) and each gets two independent tests:
   *   - presence of the escaped form AND absence of the bare (unescaped)
   *     interpolation — the absence half is what actually has teeth;
   *   - a literal esc-removal mutation (the exact edit a regression would
   *     make) is performed on an in-memory copy of the source and its result
   *     is proven to be the vulnerable bare form the presence/absence pair
   *     above would have to catch — demonstrating the pin has teeth rather
   *     than merely asserting it does.
   */
  const FIELD_SINKS: ReadonlyArray<{
    name: string;
    escaped: string;
    bare: string;
  }> = [
    {
      name: "session title (sidebar row)",
      escaped: '${esc(s.title || "(无标题)")}',
      bare: '${s.title || "(无标题)"}',
    },
    {
      name: "session date (sidebar row)",
      escaped: "${esc(s.date)}",
      bare: "${s.date}",
    },
    {
      name: "segment title (sidebar row)",
      escaped: "${esc(g.title)}",
      bare: "${g.title}",
    },
    {
      name: "segment status (sidebar row)",
      escaped: "${esc(g.status)}",
      bare: "${g.status}",
    },
    {
      name: "segment tags (sidebar row)",
      escaped: 'g.tags.map(t=>"#"+esc(t))',
      bare: 'g.tags.map(t=>"#"+t)',
    },
    {
      name: "lane tagSet (lane chip)",
      escaped: '${esc(l.tagSet.join("+"))}',
      bare: '${l.tagSet.join("+")}',
    },
    {
      name: "edge relation (tooltip)",
      escaped: "T${e.citingId} —${esc(e.relation)}→ T${e.citedId}",
      bare: "T${e.citingId} —${e.relation}→ T${e.citedId}",
    },
    {
      name: "edge tags (tooltip)",
      escaped: '<span class="lg">{${esc(e.tags.join(","))}}</span>',
      bare: '<span class="lg">{${e.tags.join(",")}}</span>',
    },
    {
      name: "edge relation (panel erow, out)",
      escaped: "`—${esc(e.relation)}→ T${e.citedId}`",
      bare: "`—${e.relation}→ T${e.citedId}`",
    },
    {
      name: "edge relation (panel erow, in)",
      escaped: "`T${e.citingId} —${esc(e.relation)}→`",
      bare: "`T${e.citingId} —${e.relation}→`",
    },
    {
      name: "edge tags (panel erow)",
      escaped: '<span class="etags">{${esc(e.tags.join(","))}}</span>',
      bare: '<span class="etags">{${e.tags.join(",")}}</span>',
    },
    {
      name: "lane tagSet/token (panel lane chips)",
      escaped: '${esc(l ? l.tagSet.join("+") : tok)}',
      bare: '${l ? l.tagSet.join("+") : tok}',
    },
    {
      name: "turn title (panel h2)",
      escaped: '<h2>${esc(t.title||"(无笔记)")}</h2>',
      bare: '<h2>${t.title||"(无笔记)"}</h2>',
    },
    {
      name: "turn type words (panel chips)",
      escaped:
        '<span class="chip ph" style="background:${typeColor(x)}">${esc(x)}</span>',
      bare: '<span class="chip ph" style="background:${typeColor(x)}">${x}</span>',
    },
    {
      name: "prompt excerpt (panel)",
      escaped: '<div class="prompt">${esc(t.promptExcerpt)}</div>',
      bare: '<div class="prompt">${t.promptExcerpt}</div>',
    },
    {
      name: "content excerpt (panel)",
      escaped: '<div class="content">${esc(t.contentExcerpt||"—")}</div>',
      bare: '<div class="content">${t.contentExcerpt||"—"}</div>',
    },
  ];

  for (const field of FIELD_SINKS) {
    describe(`field: ${field.name}`, () => {
      test("escaped interpolation present, unescaped interpolation absent", () => {
        expect(html).toContain(field.escaped);
        expect(html).not.toContain(field.bare);
      });

      test("an esc-removal mutation on this field alone is caught (teeth check)", () => {
        // Perform the exact edit a regression would make: drop esc() from
        // JUST this field, leaving every other field untouched. If the
        // absence assertion above has real teeth, the mutated source must
        // now contain the bare form it is supposed to reject.
        expect(html).toContain(field.escaped);
        const mutated = html.replace(field.escaped, field.bare);
        expect(mutated).not.toBe(html);
        expect(mutated).toContain(field.bare);
        // And the field's OWN escaped form is gone from the mutated copy —
        // proving the replace targeted this field's site, not some other
        // occurrence.
        expect(mutated.includes(field.escaped)).toBe(false);
      });
    });
  }

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

  test("the panel node's own incident edges paint hot regardless of tag (T1416 ruling) — sel joins the hot union beside component lanes and solo", () => {
    expect(html).toContain("const selDirect = sel!==null && (p.dataset.s==sel || p.dataset.t==sel);");
    expect(html).toContain('if (inComp || soloDirect || selDirect) p.classList.add("hot");');
    // The teeth: the pre-T1416 two-term union must be gone — its presence
    // would mean sel's untagged/cross-phase incident edges gray out again.
    expect(html).not.toContain('if (inComp || soloDirect) p.classList.add("hot");');
  });

  test("sessions sidebar wires load-more through nextCursor (peer finding #10) — page one alone is not the whole story", () => {
    expect(html).toContain("let sessionsNextCursor = null;");
    expect(html).toContain("sessionsNextCursor = sessionsRes.nextCursor ?? null;");
    expect(html).toContain("async function loadMoreSessions(){");
    expect(html).toContain('"/api/console/sessions?cursor=" + encodeURIComponent(sessionsNextCursor)');
    // The row only renders when there IS a next page, and re-fetching
    // concatenates onto the existing list rather than replacing it.
    expect(html).toContain("if (sessionsNextCursor) {");
    expect(html).toContain("sessionsList = sessionsList.concat(res.sessions);");
  });

  test("title truncation slices by code point, never a raw UTF-16 .slice() (peer finding #14b — no split surrogate pairs)", () => {
    expect(html).toContain("const ttCp = Array.from(tt);");
    expect(html).toContain("ttCp.length>62 ? ttCp.slice(0,62).join(\"\")");
    expect(html).not.toMatch(/tt\.slice\(0,\s*62\)/);
  });

  test("behavioral proof: the code-point truncation algorithm never splits a surrogate pair at the 62-boundary", () => {
    // The shell's exact expression, reimplemented here to prove the
    // ALGORITHM behaves correctly — the source-text test above only pins
    // that this expression is present, not that it does the right thing.
    const nonBmp = "\u{1D306}"; // one code point, encoded as a UTF-16 surrogate pair
    const title = "a".repeat(61) + nonBmp + "b".repeat(10);

    const ttCp = Array.from(title);
    const truncated = ttCp.length > 62 ? ttCp.slice(0, 62).join("") + "…" : title;
    expect(truncated).toBe("a".repeat(61) + nonBmp + "…");

    // The OLD UTF-16 code-unit slice this replaces DOES split the pair at
    // this exact boundary — proving the fix is not a no-op for the case it
    // targets.
    const oldUnsafeTruncation =
      title.length > 62 ? title.slice(0, 62) + "…" : title;
    expect(oldUnsafeTruncation).not.toBe("a".repeat(61) + nonBmp + "…");
    const lastUnit = oldUnsafeTruncation.charCodeAt(61);
    expect(lastUnit).toBeGreaterThanOrEqual(0xd800);
    expect(lastUnit).toBeLessThanOrEqual(0xdbff);
  });
});
