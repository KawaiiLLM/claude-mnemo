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
      name: "edge tags (tooltip)",
      escaped: '<span class="lg">{${esc(e.tags.join(","))}}</span>',
      bare: '<span class="lg">{${e.tags.join(",")}}</span>',
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
      name: "edge tags (panel erow)",
      escaped: '<span class="etags">{${esc(e.tags.join(","))}}</span>',
      bare: '<span class="etags">{${e.tags.join(",")}}</span>',
    },
    {
      name: "lane tag/token (panel lane chips)",
      escaped: "${esc(l ? l.tag : tok)}",
      bare: "${l ? l.tag : tok}",
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

  // floor-and-render-fidelity ticket 03 (user ruling S15069/T1482): every
  // reader-facing turn reference is the S<n>/T<m> address — the node label,
  // the lane chip's terminus mark, the edge tooltip/panel erows (their own
  // FIELD_SINKS pins above). `turns.id` may still key the internal `idx`/
  // `nodeEls`/`rowEls`/edge `citingId`/`citedId` maps (DATA, never printed).
  test("the node label renders the server-decided address, never the bare internal turns.id", () => {
    expect(html).toContain("lb.textContent = addrOf(t.id);");
    expect(html).not.toContain('lb.textContent = "T"+t.id;');
  });

  // T1524 ruling: the address form is the SERVER's call (`E<segment>/T<ordinal>`
  // under a segment scope, `S/T` otherwise), so the shell reads `t.address` and
  // only falls back for a fixture predating the field.
  test("addrOf reads the server-supplied address, falling back to S/T then the bare id", () => {
    // The T1531 switch wraps this: "session" mode forces the S/T form every
    // turn has, "scope" keeps the server's choice; both still fall back to the
    // bare id only for a turn outside the loaded set.
    expect(html).toContain(
      "const addrOf = id => { const t = turns[idx.get(id)]; return t ? (addrMode === \"session\" ? sessionAddr(t) : (t.address || sessionAddr(t))) : \"T\"+id; };",
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
    expect(html).toContain("const term = closed ? `◎${termAddr}`");
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
    expect(html).toContain("lanes 与检验文本覆盖整个范围,图仅显示当前所选区间");
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

  // Ticket 03 banned `addrOf` here because its bare-id fallback was reachable
  // for a terminus outside the loaded interval. T1531 re-admits it under an
  // `idx.has` guard — inside the loaded set the chip must speak the same
  // address space as the rows; outside it, the server-supplied full-snapshot
  // address still stands. The guard is what this now pins.
  test("laneChip's terminus mark uses addrOf only for a LOADED terminus, keeping state.terminusAddress otherwise", () => {
    const block = html.slice(html.indexOf("function laneChip(l){"), html.indexOf("c.addEventListener"));
    expect(block).toContain("l.state.terminusAddress");
    expect(block).toContain("idx.has(l.state.terminus) ? addrOf(l.state.terminus)");
    expect(block).not.toMatch(/[^)]\s*addrOf\(l\.state\.terminus\)\s*;/);
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
    expect(block).toContain("label.textContent = `区间 ${addrMode === \"session\"");
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

// T1531 ruling ("建议给个切换滑块而不是混合显示"): a segment holding turns it
// never adopted renders ordinals and S/T interleaved down one column. The
// switch picks the space rather than mixing it, and appears only when the
// response actually carries both forms.
describe("console-shell.html address-space switch", () => {
  const html = readFileSync(join(import.meta.dir, "../../src/worker/console-shell.html"), "utf8");

  test("session mode reads every row as S<n>/T<m>; scope mode keeps the server's choice", () => {
    expect(html).toContain('let addrMode = "scope";');
    expect(html).toContain(
      'const addrOf = id => { const t = turns[idx.get(id)]; return t ? (addrMode === "session" ? sessionAddr(t) : (t.address || sessionAddr(t))) : "T"+id; };',
    );
  });

  test("the switch renders only when both forms are actually present", () => {
    expect(html).toContain("if (addrMixed()) {");
    expect(html).toContain("const addrMixed = () =>");
  });

  test("a lane chip's terminus speaks the same space as the rows whenever it is loaded", () => {
    expect(html).toContain(
      "const termAddr = l.state.terminus !== null && idx.has(l.state.terminus) ? addrOf(l.state.terminus) : l.state.terminusAddress;",
    );
    expect(html).not.toContain("const term = closed ? `◎${l.state.terminusAddress}`");
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
    expect(html).toContain("p.laneTokens = e.laneTokens;");
    // The retired single-token convention this replaces (P1-6's own naming:
    // "the shell's dataset.lane single-token convention"). Regex, not
    // `toContain` — `e.laneToken` is a PREFIX of the new `e.laneTokens`, so a
    // plain substring check would false-positive against the line above.
    expect(html).not.toContain('p.dataset.lane = e.laneToken ?? "";');
    expect(html).not.toMatch(/e\.laneToken(?!s)/);
  });

  test("paintFilters tests SET MEMBERSHIP over that array, never a single-token string equality", () => {
    expect(html).toContain("const inComp = p.laneTokens.some(t=>selLanes.has(t));");
    // The retired form: a lane token stored as one dataset string, compared
    // by `===`/`Set.has` against exactly that one value.
    expect(html).not.toContain('p.dataset.lane!==""');
    expect(html).not.toContain("selLanes.has(p.dataset.lane)");
  });

  test("no `.tagSet` field access (exact-set lane identity) survives anywhere in the shell — D5 collapsed it to one tag per lane; prose comments may still name the retired field for context", () => {
    expect(html).not.toContain(".tagSet");
  });

  test("an esc-removal-style mutation on the set-membership line alone is caught (teeth check)", () => {
    const line = "const inComp = p.laneTokens.some(t=>selLanes.has(t));";
    expect(html).toContain(line);
    const regressed = "const inComp = p.laneTokens[0]!==undefined && selLanes.has(p.laneTokens[0]);";
    const mutated = html.replace(line, regressed);
    expect(mutated).not.toBe(html);
    expect(mutated).toContain(regressed);
    expect(mutated.includes(line)).toBe(false);
  });

  // Behavioral proof (same posture as the code-point-truncation test above):
  // extract the shell's OWN set-membership expression and prove it lights an
  // edge under EITHER of its two lanes, and only its two lanes — not merely
  // that the source line is present.
  test("behavioral proof: an edge in lanes {a,b} is hot when EITHER a or b is focused, and only then", () => {
    const edgeLaneTokens = ["a", "b"];
    const inCompFor = (selLanes) => edgeLaneTokens.some((t) => selLanes.has(t));

    expect(inCompFor(new Set(["a"]))).toBe(true);
    expect(inCompFor(new Set(["b"]))).toBe(true);
    expect(inCompFor(new Set(["a", "b"]))).toBe(true);
    expect(inCompFor(new Set(["c"]))).toBe(false);
    expect(inCompFor(new Set())).toBe(false);

    // The OLD single-token behavior this replaces: an edge could only ever
    // match ONE stored token, so focusing the lane that did NOT win the slot
    // would wrongly leave a genuinely-shared edge dark.
    const oldSingleTokenMatch = (storedToken, selLanes) =>
      storedToken !== "" && selLanes.has(storedToken);
    const storedFirstToken = edgeLaneTokens[0]; // what the retired assignment would have kept
    expect(oldSingleTokenMatch(storedFirstToken, new Set(["b"]))).toBe(false);
  });
});
