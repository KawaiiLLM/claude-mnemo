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

// [S15069/T1725] Night mode. The console was a single light palette with a
// dozen colours hardcoded in rules and the type colours RESOLVED to literals at
// render time. The tests below pin the three properties that make a theme
// switch actually work, rather than merely exist.
// [S15069/T1754] The dash used to mean CROSS-PHASE, hardcoded to a three-word
// list. v12 deleted the phase axis and one of those words with it, and NO test
// pinned any of it — the rewrite here was green before these assertions
// existed, which is why the drift survived two model revisions.
describe("console-shell.html edge dashing says internal vs not", () => {
  const html = readFileSync(HTML_PATH, "utf8");

  test("dashing is decided by the EDGE, not by its relation word", () => {
    expect(html).toContain("const isInternalEdge = (e) =>");
    expect(html).toContain('if (!isInternalEdge(e)) p.setAttribute("stroke-dasharray"');
    // The retired keying: a fixed set of relation words, one of which
    // (`refutes`) folded into `override` and no longer exists at all.
    expect(html).not.toContain('new Set(["grounds","verifies","refutes"])');
    expect(html).not.toMatch(/DASH\.has\(/);
  });

  test("behavioral proof: same word, opposite dashing, decided by the two sides", () => {
    const line = "const isInternalEdge = (e) =>\n  e.tailLaneToken !== null && e.tailLaneToken === e.headLaneToken;";
    expect(html).toContain(line);
    const isInternalEdge = new Function(
      "e",
      "return e.tailLaneToken !== null && e.tailLaneToken === e.headLaneToken;",
    ) as (e: { tailLaneToken: string | null; headLaneToken: string | null }) => boolean;

    // One relation word, four edges, three of them dashed — which is exactly
    // what a per-word swatch could never express.
    const cases = [
      { name: "internal", tailLaneToken: "LANE_A", headLaneToken: "LANE_A", internal: true },
      { name: "crossing", tailLaneToken: "LANE_A", headLaneToken: "LANE_B", internal: false },
      { name: "half-settled", tailLaneToken: "LANE_A", headLaneToken: null, internal: false },
      { name: "unattributed", tailLaneToken: null, headLaneToken: null, internal: false },
    ];
    for (const c of cases) {
      expect({ name: c.name, internal: isInternalEdge(c) }).toEqual({
        name: c.name,
        internal: c.internal,
      });
    }
  });

  test("the legend states the rule, and no longer teaches the retired phase axis", () => {
    expect(html).toContain("实线=泳道内部边");
    expect(html).toContain("虚线=非内部边");
    expect(html).toContain("灰=草稿");
    expect(html).toContain("细线=index");
    expect(html).not.toContain("同相位");
    expect(html).not.toContain("跨相位");
  });

  // [S15069/T1760] Three channels, three questions. The test that matters is
  // that nothing claims grey except a draft: it was contended by three things
  // at once — focus dimming restained to grey, `consume` WAS grey, and drafts
  // were about to become grey.
  test("grey belongs to drafts alone — focus dims by opacity, consume has a hue", () => {
    expect(html).toContain("--draft:");
    // Focus no longer restains; it only fades.
    expect(html).toContain("path.edge.gray:not(.hot) { opacity:.28; }");
    expect(html).not.toContain("path.edge.gray:not(.hot) { stroke:");
    // `consume` carries real chroma now, not the old #a2a9b1 grey.
    expect(html).not.toContain("--consume:#a2a9b1");
    expect(html).not.toContain("--consume:#8d959e");
  });

  test("a draft is any edge missing a tag on EITHER side, and it renders grey", () => {
    expect(html).toContain('const isDraft = e.tailTag === "" || e.headTag === "";');
    expect(html).toContain('isDraft?"var(--draft)"');
    // The stroke is a var() reference, not a literal baked at draw time — the
    // same defect the node dots were fixed for.
    expect(html).not.toContain('stroke:css("--"+e.relation)');
  });

  test("weight marks the convergence fan only, and the retired word is gone", () => {
    expect(html).toContain('e.relation==="indexes"?" converge":""');
    expect(html).toContain("path.edge.converge { stroke-width:1.1; }");
    // Retired with v12 into `override`; it had kept its own filter checkbox.
    expect(html).not.toMatch(/WORDS = \[[^\]]*refutes/);
    expect(html).not.toContain("--refutes:");
  });

  test("a per-word swatch cannot carry a per-edge property, so it carries only colour", () => {
    expect(html).toContain('<span class="sw" style="border-color:var(--${w})"></span>');
    expect(html).not.toContain('class="sw ${DASH.has(w)?"dash":""}"');
  });
});

describe("console-shell.html night mode", () => {
  const html = readFileSync(HTML_PATH, "utf8");

  function tokensIn(block: string): string[] {
    return [...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!);
  }
  function blockAfter(marker: string): string {
    const start = html.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    return html.slice(start, html.indexOf("\n  }", start));
  }

  // THE LOAD-BEARING ONE. A theme breaks by OMISSION, not by wrong colour: add
  // a token to the light block, forget the dark one, and that rule silently
  // keeps its light value on a dark panel. Nothing else in the suite would
  // notice, and a reader only finds it by looking at the exact screen it
  // ruins. This assertion makes the omission impossible.
  test("every token the light palette declares, the dark palette answers", () => {
    const light = tokensIn(blockAfter("  :root {"));
    const dark = tokensIn(blockAfter('  :root[data-theme="dark"] {'));
    expect(light.length).toBeGreaterThan(30);
    expect({ missingInDark: light.filter((t) => !dark.includes(t)) }).toEqual({
      missingInDark: [],
    });
    // And nothing invented on the dark side alone — that would be a rule no
    // light reader can ever reach.
    expect({ darkOnly: dark.filter((t) => !light.includes(t)) }).toEqual({ darkOnly: [] });
  });

  // A colour resolved with getComputedStyle is frozen at the theme in force
  // when the element was drawn. `relationVar` always returned a `var()`
  // reference; `typeColor` did not, so every node dot and type chip would have
  // kept its old colour across a toggle.
  test("typeColor returns a var() reference, never a resolved literal", () => {
    expect(html).toContain("const typeColor = t => TYPE_ORDER.includes(t) ? `var(--t-${t})` : \"var(--none)\";");
    expect(html).not.toContain('css("--t-"+t)');
    // A presentation attribute does not accept var(); a style property does.
    expect(html).not.toMatch(/mk\("circle",\{r,fill:/);
    expect(html).toContain('style:"fill:var(--none)"');
  });

  test("the theme is resolved in <head>, before the stylesheet, so there is no light flash", () => {
    const resolver = html.indexOf('localStorage.getItem("mnemo-theme")');
    const style = html.indexOf("<style>");
    const head = html.indexOf("</head>");
    expect(resolver).toBeGreaterThan(-1);
    expect({ beforeStylesheet: resolver < style, insideHead: resolver < head }).toEqual({
      beforeStylesheet: true,
      insideHead: true,
    });
    // Absent a stored choice the OS decides; a stored choice outranks it.
    expect(html).toContain('(prefers-color-scheme: dark)');
  });

  test("the toggle exists, and switching it re-renders nothing", () => {
    expect(html).toContain('<button id="themeToggle"');
    expect(html).toContain('document.documentElement.setAttribute("data-theme", next)');
    // The whole point of driving it through custom properties: no redraw, so a
    // focused component, the scroll position and the open panel all survive.
    const handler = html.slice(
      html.indexOf('themeToggle.addEventListener("click"'),
      html.indexOf("paintThemeToggle();\n});"),
    );
    for (const forbidden of ["renderGraphSvg", "applyGraph", "load(", "paintFilters"]) {
      expect({ forbidden, inHandler: handler.includes(forbidden) }).toEqual({
        forbidden,
        inHandler: false,
      });
    }
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
      name: "lane tag (lane chip)",
      escaped: "${esc(l.tag)}",
      bare: "${l.tag}",
    },
    {
      name: "edge relation (tooltip)",
      escaped: "${addrOf(e.citingId)} —${esc(e.relation)}→ ${addrOf(e.citedId)}",
      bare: "${addrOf(e.citingId)} —${e.relation}→ ${addrOf(e.citedId)}",
    },
    {
      // lane-model-v12 ticket 07: an edge's lane label is built ONCE, in
      // `edgeLaneLabel`, and rendered by both sinks (tooltip + panel erow) —
      // so this ONE pair is the whole DOM-rule boundary for an edge's lane
      // tags. Each side is escaped exactly once, which is what lets the
      // teeth check below target this site and no other.
      name: "edge side tags (edgeLaneLabel, the single escape site for both sinks)",
      escaped: "const tail = esc(e.tailTag), head = esc(e.headTag);",
      bare: "const tail = e.tailTag, head = e.headTag;",
    },
    {
      name: "edge relation (panel erow, out)",
      escaped: "`—${esc(e.relation)}→ ${addrOf(e.citedId)}`",
      bare: "`—${e.relation}→ ${addrOf(e.citedId)}`",
    },
    {
      name: "edge relation (panel erow, in)",
      escaped: "`${addrOf(e.citingId)} —${esc(e.relation)}→`",
      bare: "`${addrOf(e.citingId)} —${e.relation}→`",
    },

    {
      name: "lane tag/token (panel lane chips)",
      escaped: "${esc(l ? l.tag : tok)}",
      bare: "${l ? l.tag : tok}",
    },
    {
      name: "raw stored tag (panel tags row)",
      escaped: '"lane" : "tagoff"}">${esc(tag)}</span>',
      bare: '"lane" : "tagoff"}">${tag}</span>',
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

  test("the edge tooltip (tip()) escapes relation and routes lane tags through edgeLaneLabel — the twin sink to the panel's erow, patched to match it", () => {
    const tooltipBlock = html.slice(html.indexOf('addEventListener("mousemove"'), html.indexOf('addEventListener("mouseleave"'));
    expect(tooltipBlock).toContain("esc(e.relation)");
    expect(tooltipBlock).toContain("edgeLaneLabel(e)");
  });

  // Both sinks reach a lane tag ONLY through the escaping helper — a second
  // sink that interpolated a raw side tag would escape the field-sink table
  // above entirely, since that table now pins the helper rather than each
  // call site (lane-model-v12 ticket 07).
  test("no sink interpolates a raw side tag: `${e.tailTag}` / `${e.headTag}` appear nowhere in a template", () => {
    expect(html).toContain('<span class="lg">${edgeLaneLabel(e)}</span>');
    expect(html).toContain('<span class="etags">${edgeLaneLabel(e)}</span>');
    expect(html).not.toContain("${e.tailTag}");
    expect(html).not.toContain("${e.headTag}");
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

  // floor-and-render-fidelity ticket 03 (user ruling S15069/T1482): every
  // reader-facing turn reference is the S<n>/T<m> address — the node label,
  // the lane chip's terminus mark, the edge tooltip/panel erows (their own
  // FIELD_SINKS pins above). `turns.id` may still key the internal `idx`/
  // `nodeEls`/`rowEls`/edge `citingId`/`citedId` maps (DATA, never printed).
  test("the node label renders the server-decided address, never the bare internal turns.id", () => {
    expect(html).toContain("lb.textContent = addrOf(t.id);");
    expect(html).not.toContain('lb.textContent = "T"+t.id;');
  });

  // [S15069/T1557] ruling — ticket 10: with one address grammar there is no
  // second "citable" form left to show beside the panel's main address line
  // (the retired `.addrcite` span existed only to surface S/T beside a
  // segment ordinal when the two differed).
  test("the detail panel's address line carries no second citable form beside it", () => {
    expect(html).not.toContain("addrcite");
    expect(html).toContain('`<div class="addr">${esc(addrOf(t.id))}</div><h2>');
  });

  // [S15069/T1557] ruling — ticket 10: the address form is ALWAYS
  // `S<session>/T<prompt>`, under every scope, so the shell reads
  // `t.address` and only falls back for a fixture predating the field.
  test("addrOf reads the server-supplied address, falling back to S/T then the bare id", () => {
    expect(html).toContain(
      "const addrOf = id => { const t = turns[idx.get(id)]; return t ? (t.address || sessionAddr(t)) : \"T\"+id; };",
    );
    expect(html).toContain("const sessionAddr = t => `S${t.sessionId}/T${t.promptNumber}`;");
  });

  // The overlap defect (user screenshot, T1520): the title column was pinned at
  // `TEXT_X+52`, sized for the retired `T<dbid>` label, and the wider address
  // form painted straight through it. The column is measured now — this pins
  // BOTH halves, because keeping the measurement while leaving one hard-coded
  // offset behind would restore the bug for that row.
  test("the title column is measured from the widest label, never a fixed gutter", () => {
    expect(html).not.toContain("TEXT_X+52");
    expect(html).toContain("lb.getComputedTextLength()");
    expect(html).toContain("const titleX = TEXT_X + Math.ceil(labelW) + LABEL_GAP;");
    expect(html).toContain('for (const el of titleEls) el.setAttribute("x", titleX);');
  });

  // The jump box was the last surface still resolving an internal id (its own
  // placeholder taught `T1010`, a DB id). It matches rendered addresses now.
  test("the jump box resolves addresses, never the internal turn id", () => {
    expect(html).not.toContain("if (m && idx.has(+m[1])) return jump(+m[1]);");
    expect(html).toContain("const exact = turns.find(t=>lower(addrOf(t.id))===lower(q));");
    expect(html).toContain('const suffix = "/t"+m[1];');
    expect(html).not.toContain("跳转:T1010");
  });

  test("a lane's terminus mark addresses the turn instead of printing its bare id", () => {
    expect(html).toContain("const term = closed ? `◎${l.state.terminusAddress}`");
    expect(html).not.toContain("`◎T${l.state.terminus}`");
  });
});

// ticket 03 (peer P2-5/P2-6): lanes/laneCheckText are declared FULL SNAPSHOT
// (never projected to the currently-rendered interval), and every remaining
// `addrOf`-fallback call site is closed off — the focus badge reads through
// `addrOf` (always in-range, by construction) rather than printing the raw
// dbid, and a lane's terminus reads the server-supplied `terminusAddress`
// instead of calling `addrOf` at all (whose own fallback the ticket asserts
// unreachable).
describe("console-shell.html full-snapshot lanes/checker copy and T<dbid> removal (ticket 03)", () => {
  const html = readFileSync(HTML_PATH, "utf8");

  test("the partial banner states lanes/laneCheckText cover the whole scope, not the current interval", () => {
    expect(html).toContain("泳道与检验文本覆盖整个范围,图仅显示当前所选区间");
    // The old (wrong) claim — lane_check falls short of the full picture,
    // when the payload was already whole-scope — must be gone.
    expect(html).not.toContain("不等价于完整 lane_check");
  });

  test("the focus badge (syncBadge) never prints a bare `T${sel}`/`T${solo}` — every id routes through addrOf", () => {
    const block = html.slice(html.indexOf("function syncBadge(){"), html.indexOf("selBadge.onclick"));
    expect(block).not.toContain("T${sel}");
    expect(block).not.toContain("T${solo}");
    expect(block).toContain("addrOf(sel)");
    expect(block).toContain("addrOf(solo)");
  });

  // Ticket 03's original invariant, restored: `addrOf` is never called on a
  // lane terminus (its bare-id fallback would be reachable for a terminus
  // outside the loaded interval). T1531 briefly re-admitted it under an
  // `idx.has` guard to keep a loaded terminus in the same address space as
  // the rows; ticket 10's single grammar removes the second space that guard
  // existed to reconcile, so the ban is unconditional again.
  test("laneChip's terminus mark reads state.terminusAddress, never calls addrOf on the terminus id", () => {
    const block = html.slice(html.indexOf("function laneChip(l){"), html.indexOf("c.addEventListener"));
    expect(block).toContain("l.state.terminusAddress");
    expect(block).not.toContain("addrOf(l.state.terminus)");
  });

  test("addrOf's own doc states its bare-id fallback is now asserted unreachable, not a lane-terminus escape hatch", () => {
    expect(html).toContain("asserted UNREACHABLE");
  });
});

// floor-and-render-fidelity ticket 04 (T1498 ruling): the range bar — same
// source-text spot-check style as the section above, not a jsdom execution.
describe("console-shell.html range bar (ticket 04)", () => {
  const html = readFileSync(HTML_PATH, "utf8");

  test("the graph fetch carries the interval param, and the current graph target is retained for interval re-navigation", () => {
    expect(html).toContain(
      'if (target.interval !== undefined && target.interval !== null) params.set("interval", target.interval);',
    );
    expect(html).toContain("currentGraphTarget = target;");
  });

  test("applyGraph renders the range bar from meta.interval on every load", () => {
    expect(html).toContain("renderRangeBar(data.meta);");
    expect(html).toContain("function renderRangeBar(meta){");
  });

  test("a null meta.interval (zero-turn response) hides the range bar instead of rendering a stale one", () => {
    expect(html).toContain('if (!iv) { rangeBar.style.display = "none"; return; }');
  });

  test("\"较早\" (older) is offered only when not already at the oldest turn, and requests the immediately-older interval by ceiling", () => {
    expect(html).toContain("if (!iv.isOldest) {");
    expect(html).toContain(
      "older.addEventListener(\"click\", () => loadGraph({ ...currentGraphTarget, interval: iv.fromTurnId - 1 }));",
    );
  });

  test("\"最新\" (newest) is offered only when not already at the newest turn, and drops the interval param entirely (round-trips to the default/latest)", () => {
    expect(html).toContain("if (!iv.isNewest) {");
    expect(html).toContain("delete target.interval;");
  });

  test("the range bar label reads via textContent, never innerHTML — server-formatted addresses, not raw payload text", () => {
    const block = html.slice(html.indexOf("function renderRangeBar"), html.indexOf("function renderRangeBar") + 900);
    expect(block).toContain("label.textContent = `区间 ${iv.fromAddress}–${iv.toAddress}");
    expect(block).not.toMatch(/rangeBar\.innerHTML\s*=\s*`/);
  });

  test("the partial banner's new copy names the range bar's own affordance, never claims rows inside the shown interval were removed", () => {
    expect(html).toContain("更早的区间未显示");
    expect(html).toContain("较早");
    expect(html).not.toContain("已按预算截断，不等价于完整");
  });
});

// T1527/T1529: arc depth means REACH. The wide band's old slope spent 9px over
// spans 1..6 while 76% of real wide-band edges sit at span <= 5, so two
// citations leaving one node drew as a single stroke. Pinned as source text
// because the geometry itself has no seam below a rendering engine — the
// headless layout check in the demo harness is what measures the result.
describe("console-shell.html edge geometry", () => {
  const html = readFileSync(join(import.meta.dir, "../../src/worker/console-shell.html"), "utf8");

  test("the wide band separates short spans instead of bunching them at its floor", () => {
    expect(html).toContain("Math.min(330, 150 + span*12)");
    expect(html).not.toContain("Math.min(330, 150 + span*1.9)");
  });

  test("an edge that cannot be placed is counted and reported, never dropped in silence", () => {
    expect(html).toContain("if (!Number.isFinite(y1)||!Number.isFinite(y2)) { undrawnEdges++; continue; }");
    expect(html).toContain("if (undrawnEdges > 0) {");
    expect(html).toContain("条边的端点不在本次载入的节点集内,未能绘制");
    expect(html).not.toContain("if (!Number.isFinite(y1)||!Number.isFinite(y2)) continue;");
  });
});

// [S15069/T1557] ruling — ticket 10 "one address grammar": supersedes T1531
// ("建议给个切换滑块而不是混合显示"). That switch existed only because a
// segment scope rendered a per-segment ordinal for its own members and S/T
// for a foreign turn pulled in beside them — two address forms in one
// column. With one form, `S<session>/T<prompt>`, on every render under every
// scope, there is nothing left to switch between: the control, its
// `addrMode`/`addrMixed` state, and its `.addrSwitch`/`.addrOpt` CSS are all
// gone from the shell (see the `addrOf`/lane-terminus/range-bar-label pins
// elsewhere in this file for what replaced them).
describe("console-shell.html address-space switch retirement", () => {
  const html = readFileSync(join(import.meta.dir, "../../src/worker/console-shell.html"), "utf8");

  test("no address-space switch survives: no state, no toggle UI, no CSS", () => {
    expect(html).not.toContain("addrMode");
    expect(html).not.toContain("addrMixed");
    expect(html).not.toContain("addrSwitch");
    expect(html).not.toContain("addrOpt");
    expect(html).not.toContain("段序号");
    expect(html).not.toContain("会话地址");
  });
});

// Per-lane terminus rendering. `ConsoleGraphTurn.laneMemberships`
// (console-api.ts) carries one entry PER LANE rather than one turn-scoped
// boolean, so a turn that terminates lane B while being an ordinary member of
// lane A renders honestly on both.
//
// lane-model-v12 ticket 04 halved this suite: the payload's per-lane DEATH
// flag is deleted with node death itself, so the shared graph dot's
// "crossed out when dead in EVERY lane" mark and the panel chip's `✕` branch
// are gone. What survives is the terminus half, plus the sentinels below
// proving neither mark can come back.
describe("console-shell.html per-lane terminus rendering", () => {
  const html = readFileSync(HTML_PATH, "utf8");

  test("no turn-scoped isDead/isTerminus field survives — every read is scoped through laneMemberships", () => {
    expect(html).not.toMatch(/\bt\.isDead\b/);
    expect(html).not.toMatch(/\bt\.isTerminus\b/);
    expect(html).toContain("t.laneMemberships");
  });

  // THE SHELL-SIDE DELETION SENTINEL. The shell may not read a death flag off
  // a membership entry, and may not style a lane by a validity verdict —
  // neither field exists in the payload any more, and a shell that read one
  // would render `undefined` as a real state and go on teaching v11.
  test("the shell reads no death flag and no validity verdict from the payload", () => {
    expect(html).not.toMatch(/m\.dead/);
    expect(html).not.toMatch(/\bdead\b\s*\?/);
    expect(html).not.toContain("state.validity");
    expect(html).not.toContain("lastDeclarer");
    // And neither retired MARK is drawn: the two crossing lines the graph dot
    // used for a dead node, or the ✝ dagger the lane chip appended to an
    // invalid closed lane. (The bare `✕` character stays in the file — it is
    // the panel's own close button, unrelated to the lane model.)
    expect(html).not.toContain('mk("line",{x1:-7,y1:-7');
    expect(html).not.toContain("✝");
    expect(html).not.toContain("lchip.invalid");
    // The legend teaches only what the payload can still say.
    expect(html).not.toContain("死亡");
  });

  test("the shared graph dot's terminus ring is an ANY-lane fact", () => {
    expect(html).toContain("if (t.laneMemberships.some(m=>m.isTerminus)) g.appendChild(");
  });

  // Compiled STRAIGHT OUT of the shipped source rather than transcribed from
  // it: a re-typed copy can drift from what renders while both the copy and
  // its assertions stay green, so the proof below would be testing itself.
  // The regex anchors on the drawing call, not on the condition, so a
  // rewritten-but-equivalent predicate still compiles and still has to pass.
  function shellCondition(pattern: RegExp): (memberships: unknown[]) => boolean {
    const match = html.match(pattern);
    if (!match?.[1]) throw new Error(`console-shell.html no longer matches ${pattern}`);
    return new Function(
      "laneMemberships",
      `const t = { laneMemberships }; return Boolean(${match[1]});`,
    ) as unknown as (memberships: unknown[]) => boolean;
  }

  test("behavioral proof: R (terminus in lanes b/c, an ordinary member of lane a) rings on the shared dot", () => {
    const ringOf = shellCondition(/if \((.+?)\) g\.appendChild\(mk\("circle",\{r:8\.5/);

    const r = [
      { token: "a", isTerminus: false },
      { token: "b", isTerminus: true },
      { token: "c", isTerminus: true },
    ];
    expect(ringOf(r)).toBe(true);
    // An ordinary member of every lane it belongs to never rings, and a
    // laneless node never rings vacuously.
    expect(ringOf([{ token: "x", isTerminus: false }])).toBe(false);
    expect(ringOf([])).toBe(false);
  });

  test("the panel's own per-lane chip mark reads THAT lane's own isTerminus, never a turn-scoped aggregate", () => {
    expect(html).toContain('const mark = isTerminus ? " ◎" : "";');
    expect(html).toContain("t.laneMemberships.map(({token: tok, isTerminus}) => {");
  });

  test("behavioral proof: R's own three panel chips read ◎ under lanes b/c and nothing under lane a", () => {
    const markSource = html.match(/const mark = ([^;]+);/);
    if (!markSource?.[1]) throw new Error("console-shell.html no longer defines the panel chip's `mark`");
    const mark = new Function("isTerminus", `return ${markSource[1]};`) as unknown as (
      isTerminus: boolean,
    ) => string;
    expect(mark(false)).toBe(""); // lane a: R is an ordinary member here
    expect(mark(true)).toBe(" ◎"); // lanes b/c: R is the terminus
  });
});

// lane-declaration ticket 05 (spec Rev 2, D5 "What this CHANGES about
// existing verdicts"): an edge carrying several tags is a member of SEVERAL
// lanes now, so `ConsoleGraphEdge.laneToken: string` widened to
// `laneTokens: string[]` and `ConsoleGraphLane.tagSet: string[]` collapsed to
// `tag: string`. The shell's own focus/highlight machinery (`dataset.lane`
// single-token equality) has to become a set-membership test, or an edge in
// lanes {a,b} would only ever light up for whichever tag happened to win the
// old single-slot assignment. See tests/worker/console-shell.test.ts's own
// FIELD_SINKS entries above ("lane tag (lane chip)" / "lane tag/token (panel
// lane chips)") for the sibling `tagSet` -> `tag` rendering fix; this block
// is the highlight-logic half, plus the headless-browser DOM proof this
// suite cannot itself run (see the ticket's own harness at
// /tmp/build-console-demo.ts, driven against Chrome headless separately).
describe("console-shell.html multi-lane edge highlight (ticket 05)", () => {
  const html = readFileSync(HTML_PATH, "utf8");

  test("an edge element carries its FULL laneTokens array, never a single collapsed token", () => {
    expect(html).toContain("p.laneTokens = edgeLaneTokens(e);");
    // The retired single-token convention this replaces (P1-6's own naming:
    // "the shell's dataset.lane single-token convention"). Regex, not
    // `toContain` — `e.laneToken` is a PREFIX of the new `e.laneTokens`, so a
    // plain substring check would false-positive against the line above.
    expect(html).not.toContain('p.dataset.lane = e.laneToken ?? "";');
    expect(html).not.toMatch(/e\.laneToken(?!s)/);
  });

  // [S15069/T1696]: the panel showed type chips and a resolved-lane row and
  // nothing else, so for the majority of turns — the ones carrying only
  // legacy words, 1116 of 1798 members on the live segment — it displayed no
  // tag information at all. The raw row is what the turn actually stores.
  test("the panel renders a RAW tags row, separate from the resolved 所属 lane row", () => {
    expect(html).toContain('<div class="flowline">tags:${tagChipsHtml}</div>');
    expect(html).toContain('<div class="flowline">所属泳道:${laneChipsHtml}</div>');
    // The raw row comes from the turn's own column, never from the resolved
    // memberships — reading it off `laneMemberships` would make the row a
    // duplicate of the one below it and hide exactly the gap it exists to show.
    expect(html).toContain("const tagChipsHtml = (t.tags || [])");
  });

  test("a stored tag that is NOT one of this turn's lanes is shown MUTED, never dropped", () => {
    expect(html).toContain('ownLaneTags.has(tag) ? "lane" : "tagoff"');
    expect(html).toContain(".chip.tagoff {");
    // Behavioral proof of the classifier, run from the shell's own expression.
    const line = 'const cls = ownLaneTags.has(tag) ? "lane" : "tagoff";';
    const classify = new Function(
      "ownLaneTags",
      "tag",
      line + "\nreturn cls;",
    ) as (ownLaneTags: Set<string>, tag: string) => string;
    const own = new Set(["lane-declaration"]);
    expect(classify(own, "lane-declaration")).toBe("lane");
    expect(classify(own, "claude-mnemo")).toBe("tagoff"); // the segment's own tag
    expect(classify(own, "observation-pipeline")).toBe("tagoff"); // retired vocabulary
  });

  test("paintFilters lights an edge by ITS OWN COMPONENT, never by lane-token overlap", () => {
    expect(html).toContain("const inComp = p.componentId !== null && selComps.has(p.componentId);");
    // The two retired forms: a lane token stored as one dataset string
    // (pre-ticket-05), and ticket 05's own set-membership over BOTH sides
    // ([S15069/T1696] retired that one too — a cross-lane edge is internal to
    // no lane, so lighting it under either endpoint's lane was the old
    // "component spans many lanes" reading leaking into the paint).
    expect(html).not.toContain('p.dataset.lane!==""');
    expect(html).not.toContain("selLanes.has(p.dataset.lane)");
    expect(html).not.toContain("p.laneTokens.some(t=>selLanes.has(t))");
  });

  // lane-model-v12 ticket 07 — the crossing render, EXECUTED rather than
  // grepped. The three side-tag helpers are pure (their only free name is
  // `esc`), so they can be lifted out of the shell source and run against a
  // stand-in escaper: this pins what a reader actually SEES for a crossing,
  // not merely that some source line exists.
  test("edgeLaneLabel renders a same-lane edge as {tag} and a CROSSING as {tail→head} — the two sides' whole reason to exist", () => {
    const start = html.indexOf("const edgeSettled =");
    const end = html.indexOf("\n", html.indexOf("const edgeLaneTokens ="));
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const helpers = new Function(
      "esc",
      html.slice(start, end) + "\nreturn { edgeSettled, edgeLaneLabel, edgeLaneTokens };",
    )((v: string) => v) as {
      edgeSettled: (e: unknown) => boolean;
      edgeLaneLabel: (e: unknown) => string;
      edgeLaneTokens: (e: unknown) => string[];
    };

    const unsettled = { tailTag: "", headTag: "", tailLaneToken: null, headLaneToken: null };
    const sameLane = { tailTag: "a", headTag: "a", tailLaneToken: "TA", headLaneToken: "TA" };
    const crossing = { tailTag: "a", headTag: "b", tailLaneToken: "TA", headLaneToken: "TB" };

    expect(helpers.edgeSettled(unsettled)).toBe(false);
    expect(helpers.edgeLaneLabel(unsettled)).toBe("");
    expect(helpers.edgeLaneTokens(unsettled)).toEqual([]);

    // Byte-identical to what the retired merged set rendered for a one-tag
    // edge — the source swap is invisible here, which is the point.
    expect(helpers.edgeLaneLabel(sameLane)).toBe("{a}");
    expect(helpers.edgeLaneTokens(sameLane)).toEqual(["TA"]);

    // The one thing that changes: a crossing reads as a crossing, with a
    // DIRECTION. `{a,b}` (the old render) could not say which end was which.
    expect(helpers.edgeLaneLabel(crossing)).toBe("{a→b}");
    expect(helpers.edgeLaneLabel(crossing)).not.toBe(helpers.edgeLaneLabel(sameLane));
    expect(helpers.edgeLaneTokens(crossing)).toEqual(["TA", "TB"]);
  });

  test("no `.tagSet` field access (exact-set lane identity) survives anywhere in the shell — D5 collapsed it to one tag per lane; prose comments may still name the retired field for context", () => {
    expect(html).not.toContain(".tagSet");
  });

  test("a mutation on the component-membership line alone is caught (teeth check)", () => {
    const line = "const inComp = p.componentId !== null && selComps.has(p.componentId);";
    expect(html).toContain(line);
    const regressed = "const inComp = p.laneTokens.some(t=>selComps.has(t));";
    const mutated = html.replace(line, regressed);
    expect(mutated).not.toBe(html);
    expect(mutated).toContain(regressed);
    expect(mutated.includes(line)).toBe(false);
  });

  // Behavioral proof (same posture as the code-point-truncation test above):
  // run the shell's OWN lighting rule, extracted from source, over the three
  // edge shapes that exist — internal, cross-lane, half-settled — rather than
  // asserting a source line is present.
  test("behavioral proof: only an edge INSIDE a focused component lights; a crossing never does", () => {
    const line = "const inComp = p.componentId !== null && selComps.has(p.componentId);";
    expect(html).toContain(line);
    const inCompFor = new Function(
      "p",
      "selComps",
      line + "\nreturn inComp;",
    ) as (p: { componentId: string | null }, selComps: Set<string>) => boolean;

    const internal = { componentId: "LANE_A#7" };
    // A cross-lane edge and a half-settled one both answer `null` from
    // `edgeComponentId` — they are internal to nothing, which is the whole
    // content of the ruling: connectivity needs the SAME tag on both sides.
    const crossing = { componentId: null };

    expect(inCompFor(internal, new Set(["LANE_A#7"]))).toBe(true);
    // The SAME lane, a DIFFERENT island: a lane split in two does not light
    // whole. This is the case the retired lane-token rule could not express.
    expect(inCompFor(internal, new Set(["LANE_A#42"]))).toBe(false);
    expect(inCompFor(internal, new Set(["LANE_B#7"]))).toBe(false);
    expect(inCompFor(internal, new Set())).toBe(false);
    expect(inCompFor(crossing, new Set(["LANE_A#7", "LANE_B#7"]))).toBe(false);
  });
});

/**
 * The one guard this file did not have. Every other sweep here reads the
 * shell as TEXT — regexes over `.innerHTML =` sites, copy pins, geometry
 * constants — so all 900 lines of them stay green while the browser refuses
 * to parse a single character of the script. That is not hypothetical: a
 * comment whose second line lost its `//` shipped in 0.21.0 and 0.21.1, and
 * the console rendered its static markup (the legend, the type chips in the
 * body) over an empty sidebar and an empty canvas, with no banner and no
 * toast, because the block that draws all three never ran.
 *
 * `new Function(source)` COMPILES the body and does not call it: a
 * SyntaxError surfaces here, while `document`, `fetch` and the bootstrap's
 * own `init()` are never touched.
 */
describe("console-shell.html inline script is parseable JavaScript", () => {
  const html = readFileSync(HTML_PATH, "utf8");

  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (match) => match[1],
  );

  test("the shell ships exactly the two inline script blocks this guard covers", () => {
    // Pinned so a third block added later cannot slip past unparsed — the
    // whole point is that EVERY line the browser executes is compiled here.
    expect(blocks.length).toBe(2);
  });

  for (const [index, source] of blocks.entries()) {
    test(`inline script block ${index + 1} compiles`, () => {
      expect(() => new Function(source)).not.toThrow();
    });
  }

  test("a stray unprefixed comment line WOULD fail this guard", () => {
    // The mutation this test exists to catch, spelled out: strip one `//`
    // and the compile must go red. Without this, a guard that only ever sees
    // valid input proves nothing about what it rejects.
    const broken = blocks[1].replace(
      "// long enough to keep drawing",
      "long enough to keep drawing",
    );
    expect(broken).not.toBe(blocks[1]);
    expect(() => new Function(broken)).toThrow();
  });
});
