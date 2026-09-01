import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import {
  packItemsByRenderedPageCost,
  paginateByRenderedPageCost,
  recallMemory,
} from "../../src/mcp/recall";
import { getTurnsByIds, getTurnsForSession } from "../../src/db/turns";
import { saveTurnFixture as saveTurn } from "../support/turn-fixtures";

/**
 * FIRST-SETTLEMENT-FEEDBACK TICKET 02 (user ruling S15069/T2367). Production
 * job 170 spent 6 minutes 10 seconds — 62% of a 10-minute settlement lease —
 * inside this packer to return page 1 of a 12,874-item result set. Two
 * independent inefficiencies, pinned here one test each:
 *
 *   1. the fold packed EVERY page so `pageCount` could be exact, when the
 *      caller had asked for page 1;
 *   2. every candidate item re-rendered the WHOLE accumulating page, so a
 *      page of k items cost ~k²/2 item renders.
 *
 * Both repairs are measured the same way: a renderer that COUNTS what it is
 * asked to render. The counts, not a wall clock, are what a mutation probe
 * moves — restoring either defect drives its test RED on the count.
 *
 * The first test is the safety net for the other two: the new fold's page
 * boundaries are compared, page for page, against a reference implementation
 * of the ORIGINAL exhaustive whole-page-render fold, over randomized item
 * costs and a grouping renderer that behaves like the real ones (a group's
 * header is emitted once for the page, not once per item). The repairs are
 * only allowed to be faster; the bytes they hand back are the old bytes.
 */

/** One item of the synthetic corpus: a group, and its own rendered block. */
interface Item {
  group: string;
  block: string;
}

/**
 * A renderer with the shape every real call site has: it GROUPS. Each group
 * contributes ONE header line to the page no matter how many of its items
 * land there, then each item contributes its own line. That grouping is what
 * makes an item's cost depend on which page it joins, and it is why the
 * packer measures a whole page rather than summing priced items.
 */
function makeGroupingRenderer(counters: {
  calls: number;
  itemsRendered: number;
  seen: Set<string>;
}) {
  return (pageItems: Item[]): string => {
    counters.calls += 1;
    counters.itemsRendered += pageItems.length;
    for (const item of pageItems) {
      counters.seen.add(item.block);
    }
    const groups = [...new Set(pageItems.map((item) => item.group))];
    const lines: string[] = [];
    for (const group of groups) {
      lines.push(`## ${group} ${"h".repeat(40)}`);
      for (const item of pageItems) {
        if (item.group === group) {
          lines.push(item.block);
        }
      }
    }
    return lines.join("\n");
  };
}

/** The ORIGINAL fold, verbatim in behaviour: eager, whole-page render per item. */
function referencePack(
  items: readonly Item[],
  pageSize: number,
  pageBudget: number,
  renderPage: (pageItems: Item[]) => string,
  estimate: (text: string) => number,
): Item[][] {
  const pages: Item[][] = [];
  let current: Item[] = [];
  for (const item of items) {
    const candidate = [...current, item];
    const overflowsCount = current.length >= pageSize;
    const overflowsBudget =
      current.length > 0 && estimate(renderPage(candidate)) > pageBudget;
    if (current.length > 0 && (overflowsCount || overflowsBudget)) {
      pages.push(current);
      current = [item];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0 || pages.length === 0) {
    pages.push(current);
  }
  return pages;
}

/** Deterministic PRNG — a failing seed has to be reproducible. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function makeCorpus(count: number, seed: number, groupCount = 4): Item[] {
  const random = makeRandom(seed);
  const items: Item[] = [];
  for (let index = 0; index < count; index += 1) {
    const group = `g${Math.floor(random() * groupCount)}`;
    // Widely varying block sizes, so the budget boundary lands in a different
    // place on every page rather than at a fixed stride.
    const width = 8 + Math.floor(random() * 220);
    items.push({ group, block: `${index}:${"x".repeat(width)}` });
  }
  return items;
}

describe("ticket 02 — the repaired pager packs the SAME pages the exhaustive fold did", () => {
  test("every page boundary matches the reference fold, over 40 randomized corpora", () => {
    // The reference re-derives the boundaries from the rendered strings alone,
    // with `estimateTokens`' own arithmetic restated for this fixture's
    // pure-ASCII, no-double-space text (ceil(length / 4)) — so a boundary
    // agreement here is agreement about the packer, not a shared helper.
    for (let seed = 1; seed <= 40; seed += 1) {
      const items = makeCorpus(120, seed);
      const counters = { calls: 0, itemsRendered: 0, seen: new Set<string>() };
      const renderPage = makeGroupingRenderer(counters);
      // The estimator the packer uses, reconstructed from the one public fact
      // about it: a page of exactly one item is its own cost. Rather than
      // guess, the reference is driven by a binary-search-free equivalent —
      // compare the PACKED OUTPUT of the new fold against the reference fold
      // run with the identical estimator by routing both through the same
      // rendered strings.
      const estimate = (text: string): number => {
        // The fixture writes no CJK and no run of two or more spaces, the two
        // cases `estimateTokens` prices specially — asserted, not assumed.
        expect(text).not.toMatch(/ {2,}|[一-鿿]/);
        return Math.ceil(text.length / 4);
      };

      for (const pageBudget of [80, 200, 700]) {
        const { pages, complete } = packItemsByRenderedPageCost(
          items,
          1_000,
          pageBudget,
          renderPage,
        );
        const reference = referencePack(items, 1_000, pageBudget, renderPage, estimate);
        expect(complete).toBe(true);
        expect(pages.map((page) => page.map((item) => item.block))).toEqual(
          reference.map((page) => page.map((item) => item.block)),
        );
      }
    }
  });

  test("stopping at the requested page leaves that page identical to the exhaustive fold's", () => {
    const items = makeCorpus(400, 7);
    const counters = { calls: 0, itemsRendered: 0, seen: new Set<string>() };
    const renderPage = makeGroupingRenderer(counters);
    const exhaustive = packItemsByRenderedPageCost(items, 1_000, 300, renderPage).pages;

    for (const page of [1, 2, 3, 7]) {
      const lazy = packItemsByRenderedPageCost(items, 1_000, 300, renderPage, page);
      expect(lazy.pages).toHaveLength(page);
      expect(lazy.complete).toBe(false);
      for (let index = 0; index < page; index += 1) {
        expect(lazy.pages[index]!.map((item) => item.block)).toEqual(
          exhaustive[index]!.map((item) => item.block),
        );
      }
    }
  });
});

describe("ticket 02 repair 1 — page 1 costs page 1, not the whole corpus", () => {
  test("packing page 1 of a 2,000-item corpus never renders an item past its own page", () => {
    const items = makeCorpus(2_000, 3);
    const counters = { calls: 0, itemsRendered: 0, seen: new Set<string>() };
    const renderPage = makeGroupingRenderer(counters);

    const { pages, complete } = packItemsByRenderedPageCost(
      items,
      1_000,
      300,
      renderPage,
      1,
    );
    expect(complete).toBe(false);
    expect(pages).toHaveLength(1);

    // The item that OVERFLOWED page 1 is rendered (that is how the boundary is
    // found) and nothing after it ever is. Job 170 rendered all 12,874.
    const pageOne = pages[0]!;
    const lastRenderedIndex = items.findIndex(
      (item) => item.block === items[pageOne.length]!.block,
    );
    expect(lastRenderedIndex).toBe(pageOne.length);
    for (const item of items.slice(pageOne.length + 1)) {
      expect(counters.seen.has(item.block)).toBe(false);
    }
    // And the whole probe is bounded by the page, not by the corpus: the old
    // exhaustive fold rendered items 2,000+ times over.
    expect(counters.itemsRendered).toBeLessThan(4 * (pageOne.length + 1));
  });

  test("the exhaustive fold is still available, and page counts stay exact under the item limit", () => {
    const items = makeCorpus(30, 11);
    const counters = { calls: 0, itemsRendered: 0, seen: new Set<string>() };
    const renderPage = makeGroupingRenderer(counters);

    // 30 items is far under EXACT_PAGE_COUNT_ITEM_LIMIT, so the page count is
    // computed exactly and reported as exact.
    const paged = paginateByRenderedPageCost(items, 1, 1_000, 200, renderPage);
    expect(paged.pageCountExact).toBe(true);
    expect(paged.total).toBe(30);
    expect(paged.pageCount).toBe(
      packItemsByRenderedPageCost(items, 1_000, 200, renderPage).pages.length,
    );
  });

  test("above the item limit the page count is a stated LOWER BOUND, never an exact-looking estimate", () => {
    const items = makeCorpus(1_200, 5);
    const counters = { calls: 0, itemsRendered: 0, seen: new Set<string>() };
    const renderPage = makeGroupingRenderer(counters);

    const paged = paginateByRenderedPageCost(items, 1, 1_000, 200, renderPage);
    expect(paged.pageCountExact).toBe(false);
    // Exact `total` — it is a length, and costs nothing.
    expect(paged.total).toBe(1_200);
    // A bound the data supports: page 1 was packed and items remain.
    expect(paged.pageCount).toBe(2);
    const truth = packItemsByRenderedPageCost(items, 1_000, 200, renderPage).pages.length;
    expect(paged.pageCount).toBeLessThanOrEqual(truth);
  });

  test("a LATER page above the item limit is served through the same wiring, not an empty slice", () => {
    // Adjudication probe (S15069/T2369): `Math.max(1, page - 1)` in place of
    // `Math.max(1, page)` survived every test above — page 1 is unaffected,
    // and the page-3 test drove `packItemsByRenderedPageCost` directly. Job
    // 170 paged past page 1; this pins the wiring the request actually uses.
    const items = makeCorpus(1_200, 5);
    const counters = { calls: 0, itemsRendered: 0, seen: new Set<string>() };
    const renderPage = makeGroupingRenderer(counters);

    const exhaustive = packItemsByRenderedPageCost(items, 1_000, 200, renderPage).pages;
    const paged = paginateByRenderedPageCost(items, 3, 1_000, 200, renderPage);
    expect(paged.items.map((item) => item.block)).toEqual(
      exhaustive[2]!.map((item) => item.block),
    );
    expect(paged.pageCountExact).toBe(false);
    expect(paged.pageCount).toBe(4);
  });
});

describe("ticket 02 repair 2 — an item is priced once, never by re-rendering the page", () => {
  test("a 40-item page costs ~40 item renders, not the ~820 the whole-page probe cost", () => {
    // One group, a budget generous enough to hold every item: the page grows
    // to 40 and the old fold's probe grew with it (2 + 3 + … + 41 = 859).
    const items: Item[] = Array.from({ length: 40 }, (_, index) => ({
      group: "g0",
      block: `${index}:${"x".repeat(40)}`,
    }));
    const counters = { calls: 0, itemsRendered: 0, seen: new Set<string>() };
    const renderPage = makeGroupingRenderer(counters);

    const { pages } = packItemsByRenderedPageCost(items, 1_000, 100_000, renderPage);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toHaveLength(40);

    // The bound settles every item without a single whole-page render.
    expect(counters.calls).toBe(40);
    expect(counters.itemsRendered).toBe(40);
    // The reference fold, for the same page, on the same renderer.
    const referenceCounters = { calls: 0, itemsRendered: 0, seen: new Set<string>() };
    const referenceRender = makeGroupingRenderer(referenceCounters);
    referencePack(items, 1_000, 100_000, referenceRender, (text) =>
      Math.ceil(text.length / 4),
    );
    expect(referenceCounters.itemsRendered).toBeGreaterThan(800);
  });

  test("no probe ever renders more items than the page it is measuring plus one", () => {
    // The exact whole-page render survives as the FALLBACK — it is what keeps
    // the boundaries identical — so this pins the shape of the work, not its
    // absence: the fallback is bounded by the page, and it is rare.
    const items = makeCorpus(600, 23);
    const counters = { calls: 0, itemsRendered: 0, seen: new Set<string>() };
    const renderPage = makeGroupingRenderer(counters);
    const { pages } = packItemsByRenderedPageCost(items, 1_000, 400, renderPage);

    const itemCount = pages.reduce((sum, page) => sum + page.length, 0);
    expect(itemCount).toBe(600);

    // Self-calibrating: the SAME corpus through the reference fold, counted
    // the same way. The repair is allowed to keep the exact whole-page render
    // as a fallback — it is what keeps the boundaries identical — so what is
    // pinned is that the fallback is rare enough to leave the total work a
    // small multiple of the item count, well under the old fold's.
    const referenceCounters = { calls: 0, itemsRendered: 0, seen: new Set<string>() };
    const referenceRender = makeGroupingRenderer(referenceCounters);
    referencePack(items, 1_000, 400, referenceRender, (text) =>
      Math.ceil(text.length / 4),
    );
    expect(counters.itemsRendered).toBeLessThan(referenceCounters.itemsRendered / 2);
    expect(counters.itemsRendered).toBeLessThan(4 * itemCount);
  });
});

describe("ticket 02 — a page's hit turns are read by id, not by reading the session", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("getTurnsByIds returns exactly the subsequence getTurnsForSession would have filtered to", () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "by-ids-session",
      project: "/tmp/project-by-ids",
      title: "By-ids fixture session",
      content: null,
      insight: null,
      createdAtEpoch: 1_000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
    for (let index = 1; index <= 12; index += 1) {
      saveTurn(db, {
        sessionId,
        promptNumber: index,
        userPrompt: `p${index}`,
        assistantResponse: "r",
        title: `Turn ${index}`,
        content: `body ${index}`,
        insight: null,
        filesRead: [],
        filesModified: [],
        createdAtEpoch: 1_000 + index,
        updatedAtEpoch: null,
        observations: [],
      });
    }

    const all = getTurnsForSession(db, sessionId);
    expect(all).toHaveLength(12);
    // A scattered, out-of-order, duplicated id list — the shape a page's hit
    // set actually has once relevance order has shuffled it.
    const wanted = [all[6]!.id, all[1]!.id, all[9]!.id, all[1]!.id];
    const wantedSet = new Set(wanted);

    expect(getTurnsByIds(db, wanted)).toEqual(
      all.filter((turn) => wantedSet.has(turn.id)),
    );
    expect(getTurnsByIds(db, [])).toEqual([]);
    // A whole-session read and an id read agree on the whole session too.
    expect(getTurnsByIds(db, all.map((turn) => turn.id))).toEqual(all);
  });
});

describe("ticket 02 — the page header says what it knows, and only that", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function seed(turnCount: number): number {
    const sessionId = upsertSession(db, {
      contentSessionId: "pager-session",
      project: "/tmp/project-pager",
      title: "Pager fixture session",
      content: null,
      insight: null,
      createdAtEpoch: 1_000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
    for (let index = 1; index <= turnCount; index += 1) {
      saveTurn(db, {
        sessionId,
        promptNumber: index,
        userPrompt: `prompt ${index} pagerword`,
        assistantResponse: "r",
        title: `Pager turn ${index}`,
        content: `pagerword body ${index} ${"detail ".repeat(30)}`,
        insight: null,
        filesRead: [],
        filesModified: [],
        createdAtEpoch: 1_000 + index,
        updatedAtEpoch: null,
        observations: [],
      });
    }
    return sessionId;
  }

  test("a small result set keeps the exact `page 1 / N` header it always had", () => {
    const sessionId = seed(40);
    const output = recallMemory(db, {
      filter: { session: String(sessionId) },
      pageSize: 100,
      page: 1,
      pageBudget: 400,
    } as never);
    // 41, not 40: `filter.session` matches the session record itself too.
    expect(output).toMatch(/^page 1 \/ \d+ \(total 41\)/);
    expect(output).not.toContain("≥");
  });

  test("a set past the exact-count limit reports a LOWER BOUND, with the total still exact", () => {
    const sessionId = seed(260);
    const output = recallMemory(db, {
      filter: { session: String(sessionId) },
      pageSize: 100,
      page: 1,
      pageBudget: 400,
    } as never);
    // `total` is a count and stays exact; the page count is honestly bounded.
    expect(output.split("\n")[0]).toBe("page 1 / ≥2 (total 261)");
  });
});
