import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { insertLane } from "../../src/db/lanes";
import { deriveSideTags, writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import { addSegmentMembers, createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { timelineInputSchema } from "../../src/mcp/definitions";
import { WORKER_TOOL_RESULT_MAX_CHARS } from "../../src/mcp/handlers";
import {
  buildSegmentLaneListView,
  DEFAULT_MILESTONE_PAGE_BUDGET,
  parseSegmentLaneId,
  parseSegmentLaneTagId,
  renderSegmentLaneView,
  timelineQuery,
  timelineQueryOutcome,
} from "../../src/mcp/timeline";
import { LARGE_LANE_COUNT, seedManyDeclaredLanes } from "../support/large-corpus";
import { wordEdgeClass } from "../support/edge-row-fixtures";

/**
 * The lane ROUTE: addressing (`E<n>/L*`, `E<n>/L<n>`, `E<n>/#<tag>`),
 * ordering, list pagination and error classification. The ruled adjacency
 * RENDER itself (frontier-injection ticket 04 — forward/mirror multisets,
 * chain decomposition, header counts, overflow) is pinned by
 * `tests/mcp/timeline.lane-adjacency.test.ts`; this file stays on the route.
 */

const NOW = 1_755_000_000; // 2025-08-12ish — real epoch so MM-DD renders sane

let db: Database;

function seedSession(label = "lane-view"): number {
  return upsertSession(db, {
    contentSessionId: `${label}-${Math.random()}`,
    project: `/tmp/${label}`,
    title: label,
    content: null,
    insight: null,
    createdAtEpoch: NOW,
    updatedAtEpoch: NOW,
    completedAtEpoch: null,
  }).id;
}

/** `createdAtEpoch` tracks `promptNumber` (later prompt = later epoch). */
function insertTurn(
  sessionId: number,
  promptNumber: number,
  options: { type?: string[] } = {},
): number {
  return db
    .query<{ id: number }, [number, number, number, string]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         tool_call_count, created_at_epoch, type, tags
       ) VALUES (?, ?, 'active', 'p', 'r', 1, ?, ?, '[]')
       RETURNING id`,
    )
    .get(sessionId, promptNumber, NOW + promptNumber, JSON.stringify(options.type ?? ["design"]))!.id;
}

/**
 * Put a lane tag on a turn's OWN `tags` column — since lane-model-v12 ticket
 * 10 that is what makes the turn a MEMBER of the lane (its edges no longer
 * do).
 */
function claimLaneTags(turnId: number, tags: readonly string[]): void {
  if (tags.length === 0) return;
  const row = db
    .query<{ tags: string | null }, [number]>("SELECT tags FROM turns WHERE id = ?")
    .get(turnId);
  if (row === null) return;
  let stored: string[] = [];
  try {
    const parsed = JSON.parse(row.tags ?? "[]") as unknown;
    if (Array.isArray(parsed)) stored = parsed.filter((tag): tag is string => typeof tag === "string");
  } catch {
    stored = [];
  }
  const next = [...new Set([...stored, ...tags])];
  db.query<unknown, [string, number]>("UPDATE turns SET tags = ? WHERE id = ?").run(
    JSON.stringify(next),
    turnId,
  );
}

function tagEdge(citingId: number, citedId: number, relation: string, tags: readonly string[]): void {
  writeMemoryEdges(
    db,
    [
      {
        citing: { kind: "turn", id: citingId },
        cited: { kind: "turn", id: citedId },
        ...wordEdgeClass(relation),
        provenance: "asserted",
        ...deriveSideTags(tags),
      },
    ],
    NOW,
  );
  claimLaneTags(citingId, tags);
  claimLaneTags(citedId, tags);
}

/** The settled truth (frontier-injection ticket 04's universe): one COMMITTED settlement window over the session's prompt range. */
function settleWindow(sessionId: number, windowStart: number, windowEnd: number): void {
  db.query(
    `INSERT INTO note_settlement_jobs (
       session_id, window_start, window_end, trigger_type,
       status, attempts, retry_at_epoch, created_at_epoch, updated_at_epoch
     ) VALUES (?, ?, ?, 'consecutive', 'done', 1, 0, ?, ?)`,
  ).run(sessionId, windowStart, windowEnd, NOW, NOW);
}

beforeEach(() => {
  process.env.TZ = "UTC";
  db = createDatabase(":memory:");
  initializeSchema(db);
});

afterEach(() => {
  db.close();
});

describe("parseSegmentLaneId", () => {
  test("matches E<n>/L* and E<n>/L<n>, case-insensitively", () => {
    expect(parseSegmentLaneId("E60/L*")).toEqual({ segmentId: 60, laneIndex: "all" });
    expect(parseSegmentLaneId("e60/l*")).toEqual({ segmentId: 60, laneIndex: "all" });
    expect(parseSegmentLaneId("E60/L3")).toEqual({ segmentId: 60, laneIndex: 3 });
    expect(parseSegmentLaneId("e60/l3")).toEqual({ segmentId: 60, laneIndex: 3 });
  });

  test("rejects everything that is not the E<n>/L form", () => {
    expect(parseSegmentLaneId("E60")).toBeNull();
    expect(parseSegmentLaneId("E60/T3")).toBeNull();
    expect(parseSegmentLaneId("S60")).toBeNull();
    expect(parseSegmentLaneId("S60/L3")).toBeNull();
    expect(parseSegmentLaneId("E60/L")).toBeNull();
  });
});

// Ticket 16 (user findings S15069/T2031): `timeline id="E60/#rule-ledger"`
// used to error because the lane route parsed ONLY the ordinal `L`-form,
// while `E<n>/#<tag>` is the CANONICAL lane address `recall` already
// resolves. `parseSegmentLaneTagId` is the grammar fix; the describe block
// below it proves the route renders the SAME lane the ordinal form does.
describe("parseSegmentLaneTagId", () => {
  test("matches E<n>/#<tag>, case-insensitively on the E, tag case preserved", () => {
    expect(parseSegmentLaneTagId("E60/#rule-ledger")).toEqual({ segmentId: 60, tag: "rule-ledger" });
    expect(parseSegmentLaneTagId("e60/#rule-ledger")).toEqual({ segmentId: 60, tag: "rule-ledger" });
  });

  test("rejects everything that is not the E<n>/# form", () => {
    expect(parseSegmentLaneTagId("E60")).toBeNull();
    expect(parseSegmentLaneTagId("E60/L3")).toBeNull();
    expect(parseSegmentLaneTagId("E60/L*")).toBeNull();
    expect(parseSegmentLaneTagId("S60/#tag")).toBeNull();
  });
});

describe("E<n>/#<tag> — the canonical lane address, resolved by timelineQuery (ticket 16)", () => {
  test("renders BYTE-IDENTICAL output to whichever E<n>/L<n> currently points at the same lane", () => {
    const sessionId = seedSession();
    const segment = createSegment(db, { title: "seg", nowEpoch: NOW });
    const t1 = insertTurn(sessionId, 1);
    const t2 = insertTurn(sessionId, 2);
    addSegmentMembers(db, segment.id, [t1, t2], NOW);
    insertLane(db, segment.id, "rule-ledger", NOW);
    tagEdge(t2, t1, "extends", ["rule-ledger"]);
    settleWindow(sessionId, 1, 2);

    const viaTag = timelineQuery(db, { id: `E${segment.id}/#rule-ledger` });
    const viaOrdinal = timelineQuery(db, { id: `E${segment.id}/L1` });
    expect(viaTag).not.toContain("timeline error");
    expect(viaTag).toBe(viaOrdinal);
    expect(viaTag).toContain(`E${segment.id}/#rule-ledger`);
  });

  test("an unknown tag errors naming the segment's declared lanes", () => {
    const segment = createSegment(db, { title: "seg", nowEpoch: NOW });
    insertLane(db, segment.id, "alpha", NOW);
    insertLane(db, segment.id, "beta", NOW);

    const output = timelineQuery(db, { id: `E${segment.id}/#no-such-lane` });
    expect(output).toContain("timeline error");
    expect(output).toContain("not a declared lane");
    expect(output).toContain("#alpha");
    expect(output).toContain("#beta");
  });

  test("a segment with zero declared lanes still names the empty declared-lane set, not a crash", () => {
    const segment = createSegment(db, { title: "seg", nowEpoch: NOW });
    const output = timelineQuery(db, { id: `E${segment.id}/#no-such-lane` });
    expect(output).toContain("timeline error");
    expect(output).toContain("declares no lanes");
  });

  test("a non-canonical tag (uppercase) refuses naming the exact problem, the same predicate declare/retag/recall share", () => {
    const segment = createSegment(db, { title: "seg", nowEpoch: NOW });
    const output = timelineQuery(db, { id: `E${segment.id}/#Rule-Ledger` });
    expect(output).toContain("timeline error");
    expect(output).toContain("not lowercase");
  });

  test("a missing segment errors, same shape as the L-ordinal route", () => {
    const output = timelineQuery(db, { id: "E999999/#some-tag" });
    expect(output).toContain("timeline error");
    expect(output).toContain("not found");
  });

  test("timelineQueryOutcome classifies: recognized shape + missing lane -> 404; malformed tag -> 400; success -> 200", () => {
    const segment = createSegment(db, { title: "seg", nowEpoch: NOW });
    insertLane(db, segment.id, "known", NOW);

    const missingLane = timelineQueryOutcome(db, { id: `E${segment.id}/#unknown` });
    expect(missingLane.status).toBe(404);

    const malformed = timelineQueryOutcome(db, { id: `E${segment.id}/#Bad-Case` });
    expect(malformed.status).toBe(400);

    const sessionId = seedSession();
    const t1 = insertTurn(sessionId, 1);
    const t2 = insertTurn(sessionId, 2);
    addSegmentMembers(db, segment.id, [t1, t2], NOW);
    tagEdge(t2, t1, "extends", ["known"]);
    const ok = timelineQueryOutcome(db, { id: `E${segment.id}/#known` });
    expect(ok.status).toBe(200);
  });

  // TICKET 19, finding 4. A malformed `filter` threw inside `timelineQuery`,
  // and that throw funnelled into the same `TIMELINE_ERROR_PREFIX` every
  // internal failure uses — so for a RECOGNIZED id the classifier read it as
  // "this session's render failed" and answered 404, reporting a missing
  // session that is right there. Filter validity is independent of resource
  // existence, so it is decided first.
  //
  // MUTATION NOTE: delete the `parseMemoryFilter` guard at the top of
  // `timelineQueryOutcome` and the first assertion below goes red at 404.
  test("a malformed filter on an EXISTING session is 400, not 404", () => {
    const sessionId = seedSession();
    insertTurn(sessionId, 1);

    const malformedFilter = timelineQueryOutcome(db, {
      id: `S${sessionId}`,
      filter: { time: "not-a-date" },
    });
    expect(malformedFilter.status).toBe(400);

    // The session itself is fine — the 404 the old classification gave was a
    // claim about the resource, and it was false.
    expect(timelineQueryOutcome(db, { id: `S${sessionId}` }).status).toBe(200);
    // A genuinely missing session is still 404: the guard narrowed nothing.
    expect(timelineQueryOutcome(db, { id: "S999999" }).status).toBe(404);
  });
});

describe("timelineInputSchema accepts the spec's own literal call", () => {
  test('view: "lane" parses', () => {
    const parsed = timelineInputSchema.parse({ id: "E60/L*", view: "lane" });
    expect(parsed.view).toBe("lane");
  });
});

describe("list ordering and single-lane addressing (E<n>/L<n>)", () => {
  test("lanes render oldest-first by newest SETTLED member (ticket 15 ascending ruling), and E<n>/L<n> keeps the SAME laneIndex as the full list", () => {
    const sessionId = seedSession();
    const segment = createSegment(db, { title: "seg", nowEpoch: NOW });
    const older1 = insertTurn(sessionId, 1);
    const older2 = insertTurn(sessionId, 2);
    const newer1 = insertTurn(sessionId, 20);
    const newer2 = insertTurn(sessionId, 21);
    addSegmentMembers(db, segment.id, [older1, older2, newer1, newer2], NOW);
    insertLane(db, segment.id, "old-lane", NOW);
    insertLane(db, segment.id, "new-lane", NOW);
    tagEdge(older2, older1, "extends", ["old-lane"]);
    tagEdge(newer2, newer1, "extends", ["new-lane"]);
    settleWindow(sessionId, 1, 21);

    const listed = buildSegmentLaneListView(db, segment.id, "all");
    expect(listed.lanes.map((lane) => lane.key.tag)).toEqual(["old-lane", "new-lane"]);
    expect(listed.lanes[0]!.laneIndex).toBe(1);
    expect(listed.lanes[1]!.laneIndex).toBe(2);

    const single = buildSegmentLaneListView(db, segment.id, 2);
    expect(single.lanes).toHaveLength(1);
    expect(single.lanes[0]!.key.tag).toBe("new-lane");
    expect(single.lanes[0]!.laneIndex).toBe(2); // NOT renumbered to 1

    // The single-lane render is the SAME block the list shows for that lane —
    // its header line is the first line of the list's second block.
    const renderedList = renderSegmentLaneView(listed);
    const renderedSingle = renderSegmentLaneView(single);
    const listBlocks = renderedList.split("\n\n");
    expect(renderedSingle.split("\n")[0]).toBe(
      listBlocks.find((block) => block.startsWith(`E${segment.id}/#new-lane`))!.split("\n")[0],
    );
  });

  test("a zero-settled lane sorts by its declaration epoch, renders digest-header-only, and still lists", () => {
    const sessionId = seedSession();
    const segment = createSegment(db, { title: "seg", nowEpoch: NOW });
    const t1 = insertTurn(sessionId, 1);
    const t2 = insertTurn(sessionId, 2);
    addSegmentMembers(db, segment.id, [t1, t2], NOW);
    insertLane(db, segment.id, "settled-lane", NOW);
    insertLane(db, segment.id, "empty-lane", NOW + 100);
    tagEdge(t2, t1, "extends", ["settled-lane"]);
    settleWindow(sessionId, 1, 2);

    const listed = buildSegmentLaneListView(db, segment.id, "all");
    // settled-lane's newest member epoch (NOW+2) < empty-lane's declaration
    // epoch (NOW+100): ascending keeps the settled lane first.
    expect(listed.lanes.map((lane) => lane.key.tag)).toEqual(["settled-lane", "empty-lane"]);
    const rendered = renderSegmentLaneView(listed);
    expect(rendered).toContain(`E${segment.id}/#empty-lane · 0 settled · 0 forward`);
  });

  test("an out-of-range ordinal is a clear error via timelineQuery", () => {
    const segment = createSegment(db, { title: "seg", nowEpoch: NOW });
    const output = timelineQuery(db, { id: `E${segment.id}/L1` });
    expect(output).toContain("timeline error");
    expect(output).toContain("out of range");
  });

  test("a segment with zero declared lanes renders a friendly empty message, not an error", () => {
    const segment = createSegment(db, { title: "seg", nowEpoch: NOW });
    const output = timelineQuery(db, { id: `E${segment.id}/L*` });
    expect(output).not.toContain("timeline error");
    expect(output).toContain("no lanes declared");
  });
});

describe("timelineQuery end-to-end wiring", () => {
  test("E<n>/L* and E<n>/L<n> route through timelineQuery and render the SAME adjacency block for the same lane", () => {
    const sessionId = seedSession();
    const segment = createSegment(db, { title: "seg", nowEpoch: NOW });
    const t1 = insertTurn(sessionId, 1);
    const t2 = insertTurn(sessionId, 2);
    addSegmentMembers(db, segment.id, [t1, t2], NOW);
    insertLane(db, segment.id, "wired", NOW);
    tagEdge(t2, t1, "extends", ["wired"]);
    settleWindow(sessionId, 1, 2);

    const listOutput = timelineQuery(db, { id: `E${segment.id}/L*`, view: "lane" });
    expect(listOutput).toContain(`E${segment.id}/#wired`);
    expect(listOutput).toContain(`S${sessionId}/T2 use -> T1`);

    const singleOutput = timelineQuery(db, { id: `E${segment.id}/L1` });
    // Same lane, same rendered lines, whether reached via the list or the
    // single-lane address (one declared lane: the outputs coincide entirely).
    expect(singleOutput).toBe(listOutput);
  });

  // `view: "lane"` on a bare `E<n>` is the same request spelled the other way,
  // not an inert parameter: silently handing back the turns view is the shape
  // the user ruled against, since the caller then reads a view they did not
  // ask for with nothing saying so.
  test("a bare E<n> id with view=\"lane\" renders the lane list, exactly as the /L* suffix would", () => {
    const sessionId = seedSession();
    const segment = createSegment(db, { title: "bare-e-with-lane-view", nowEpoch: NOW });
    const t1 = insertTurn(sessionId, 1, { type: ["design"] });
    const t2 = insertTurn(sessionId, 2, { type: ["design"] });
    addSegmentMembers(db, segment.id, [t1, t2], NOW);
    insertLane(db, segment.id, "bare-view-lane", NOW);
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: t2 },
          cited: { kind: "turn", id: t1 },
          ...wordEdgeClass("extends"),
          provenance: "asserted",
          ...deriveSideTags(["bare-view-lane"]),
        },
      ],
      NOW,
    );

    const viaView = timelineQuery(db, { id: `E${segment.id}`, view: "lane" as never });
    const viaSuffix = timelineQuery(db, { id: `E${segment.id}/L*` });
    expect(viaView).not.toContain("timeline error");
    expect(viaView).toContain("bare-view-lane");
    expect(viaView).toBe(viaSuffix);
  });
});

// bounded-read-surfaces ticket 01. `E<n>/L*` used to render EVERY declared
// lane in one call with no page/budget wired at all — E60 carries 103 today,
// unbounded regardless of how far that grows. `lane_check`'s own trap
// (`6e668da`): the upper-bound assertion and the pagination assertion must be
// INDEPENDENT — a fixture small enough that page 1 already fits everything
// makes both green even with pagination entirely dead. `LARGE_LANE_COUNT`
// (200, `seedManyDeclaredLanes`) exceeds the live E60 example and is sized so
// the default page budget genuinely forces the list past one page.
describe("E<n>/L* pagination (bounded-read-surfaces ticket 01)", () => {
  test("PAGINATION is alive: page 1 shows only SOME lanes, names the next call, and page 2 covers the rest — no lane is truncated", () => {
    const segment = createSegment(db, { title: "seg", nowEpoch: NOW });
    const tags = seedManyDeclaredLanes(db, segment.id, NOW);

    const page1 = timelineQuery(db, { id: `E${segment.id}/L*` });
    const shownOnPage1 = tags.filter((tag) => page1.includes(tag));
    // Real pagination, not a coincidence of small content: something was
    // excluded from page 1.
    expect(shownOnPage1.length).toBeGreaterThan(0);
    expect(shownOnPage1.length).toBeLessThan(tags.length);
    // The continuation hint names the EXACT next call (lane_check's own
    // shape, copied rather than reinvented).
    expect(page1).toContain(`timeline(id="E${segment.id}/L*", page=2)`);

    // Every lane this fixture declared is reachable, whole, walking pages in
    // order — a page never truncates a lane's own block, it only pages one
    // out.
    const covered = new Set(shownOnPage1);
    let page = 2;
    let pageCount = 2;
    while (covered.size < tags.length && page <= pageCount) {
      const next = timelineQuery(db, { id: `E${segment.id}/L*`, page });
      const match = next.match(/-- page (\d+)\/(\d+):/);
      if (match) {
        pageCount = Number(match[2]);
      }
      for (const tag of tags) {
        if (next.includes(tag)) {
          covered.add(tag);
        }
      }
      page += 1;
    }
    for (const tag of tags) {
      expect(covered.has(tag)).toBe(true);
    }
  });

  test("the UPPER BOUND holds independently: the default call's byte count stays under the worker tool-result cap", () => {
    const segment = createSegment(db, { title: "seg", nowEpoch: NOW });
    seedManyDeclaredLanes(db, segment.id, NOW);

    const output = timelineQuery(db, { id: `E${segment.id}/L*` });
    expect(output.length).toBeLessThan(WORKER_TOOL_RESULT_MAX_CHARS);
  });

  test("a fixture that fits in ONE page carries no continuation footer at all", () => {
    const segment = createSegment(db, { title: "seg", nowEpoch: NOW });
    seedManyDeclaredLanes(db, segment.id, NOW, 3);

    const output = timelineQuery(db, { id: `E${segment.id}/L*` });
    expect(output).not.toContain("-- page");
  });

  test("buildSegmentLaneListView reports page/pageCount; a single-ordinal render of a ONE-PAGE lane is page 1 of 1", () => {
    const segment = createSegment(db, { title: "seg", nowEpoch: NOW });
    seedManyDeclaredLanes(db, segment.id, NOW);

    const listed = buildSegmentLaneListView(db, segment.id, "all", 1, DEFAULT_MILESTONE_PAGE_BUDGET);
    expect(listed.pageCount).toBeGreaterThan(1);
    expect(listed.lanes.length).toBeLessThan(LARGE_LANE_COUNT);

    // A memberless lane is a one-page lane; since frontier-injection ticket
    // 05 the single-lane routes page the lane's OWN adjacency pages, so 1/1
    // here means "this lane fits one page", not a hardcoded constant.
    const single = buildSegmentLaneListView(db, segment.id, 1);
    expect(single.page).toBe(1);
    expect(single.pageCount).toBe(1);
  });
});

// Frontier-injection ticket 05: a lane too big for one page splits into
// contiguous time-range pages, newest first, and the SINGLE-LANE addresses
// (`E<n>/#<tag>`, `E<n>/L<n>`) reuse the route's existing `page` input to
// select one — default page 1 (newest), clamped into range. The `/L*` list
// keeps paging the LANE LIST as before (each lane contributing its page 1).
describe("single-lane adjacency pagination on the route (ticket 05)", () => {
  /** A lane whose adjacency table needs several pages at pageBudget 130. */
  function seedPagedLane(): { segmentId: number; sessionId: number } {
    const sessionId = seedSession("paged-lane");
    const segment = createSegment(db, { title: "seg", nowEpoch: NOW });
    const turns: number[] = [];
    for (let prompt = 1; prompt <= 6; prompt += 1) {
      turns.push(insertTurn(sessionId, prompt));
    }
    addSegmentMembers(db, segment.id, turns, NOW);
    insertLane(db, segment.id, "paged", NOW);
    tagEdge(turns[5]!, turns[4]!, "extends", ["paged"]);
    tagEdge(turns[5]!, turns[1]!, "override", ["paged"]);
    tagEdge(turns[4]!, turns[3]!, "grounds", ["paged"]);
    tagEdge(turns[2]!, turns[1]!, "verifies", ["paged"]);
    tagEdge(turns[1]!, turns[0]!, "extends", ["paged"]);
    settleWindow(sessionId, 1, 6);
    return { segmentId: segment.id, sessionId };
  }

  test("page selects one adjacency page; the footer names the CANONICAL lane address for the next call; the last page says so; out-of-range clamps", () => {
    const { segmentId } = seedPagedLane();
    const laneId = `E${segmentId}/#paged`;

    const pageOne = timelineQuery(db, { id: laneId, pageBudget: 130 });
    const footer = pageOne.match(/-- page (\d+)\/(\d+): (.*) --/);
    expect(footer).not.toBeNull();
    expect(footer![1]).toBe("1");
    const pageCount = Number(footer![2]);
    expect(pageCount).toBeGreaterThan(1);
    // The continuation names the pasteable lane address, never an ordinal.
    expect(pageOne).toContain(`call timeline(id="${laneId}", page=2)`);
    // The header carries the page position + this page's own turn range.
    expect(pageOne).toMatch(new RegExp(` · 1/${pageCount} S\\d+/T\\d+\\.\\.S\\d+/T\\d+ · `));

    const pageTwo = timelineQuery(db, { id: laneId, page: 2, pageBudget: 130 });
    expect(pageTwo).not.toBe(pageOne);
    expect(pageTwo).toMatch(new RegExp(` · 2/${pageCount} S\\d+/T\\d+\\.\\.S\\d+/T\\d+ · `));

    const lastPage = timelineQuery(db, { id: laneId, page: pageCount, pageBudget: 130 });
    expect(lastPage).toContain("this was the last page");
    // Out-of-range clamps to the last page rather than erroring or emptying.
    expect(timelineQuery(db, { id: laneId, page: 99, pageBudget: 130 })).toBe(lastPage);
  });

  test("the ordinal route pages the SAME lane pages as the canonical address", () => {
    const { segmentId } = seedPagedLane();
    const viaTag = timelineQuery(db, { id: `E${segmentId}/#paged`, page: 2, pageBudget: 130 });
    const viaOrdinal = timelineQuery(db, { id: `E${segmentId}/L1`, page: 2, pageBudget: 130 });
    // Same page 2 body; only the continuation footer names each route's own
    // id — and the ordinal route also points at the canonical address.
    expect(viaOrdinal).toBe(viaTag);
  });

  test("the /L* list keeps paging the LANE LIST: a multi-page lane contributes its page 1 and the list footer still names /L*", () => {
    const { segmentId } = seedPagedLane();
    const list = timelineQuery(db, { id: `E${segmentId}/L*`, pageBudget: 130 });
    // The lane's own page 1 header (its p/N marker) is visible in the list.
    expect(list).toMatch(/ · 1\/\d+ S\d+\/T\d+\.\.S\d+\/T\d+ · /);
    // A single declared lane still fits one LIST page: no continuation, so
    // pages 2+ of the lane are reached via the canonical address only.
    expect(list).not.toContain('id="E' + segmentId + '/L*", page=2');
  });
});

/**
 * ticket 15 (S15069/T2461, missing pins): a BLANK/BLANK edge between two
 * turns that are each the SOLE current member of one lane, addressed through
 * the CANONICAL route (`E<n>/#<tag>`) rather than through the render
 * function directly — proving the disagreement between resolved and stored
 * attribution survives the addressing layer too, not just the render it
 * eventually calls (the same page is pinned more deeply, by header field, in
 * `tests/mcp/timeline.lane-adjacency.test.ts`).
 */
describe("E<n>/#<tag> route: a BLANK/BLANK edge between two SOLE lane members still counts (main-agent-edges ticket 15)", () => {
  test("the canonical address's page counts the edge as forward even though neither side stores a tag", () => {
    const sessionId = seedSession("lane-view-derived-blank");
    const segment = createSegment(db, { title: "derived-blank", nowEpoch: NOW });
    const t1 = insertTurn(sessionId, 1);
    const t2 = insertTurn(sessionId, 2);
    addSegmentMembers(db, segment.id, [t1, t2], NOW);
    insertLane(db, segment.id, "derived-only", NOW);
    claimLaneTags(t1, ["derived-only"]);
    claimLaneTags(t2, ["derived-only"]);
    settleWindow(sessionId, 1, 2);

    // Undeclared on both sides — `deriveSideTags` is NOT used here on purpose,
    // so the row stores blank tags rather than the lane word.
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: t2 },
          cited: { kind: "turn", id: t1 },
          ...wordEdgeClass("extends"),
          provenance: "asserted",
          tailTag: "",
          headTag: "",
        },
      ],
      NOW,
    );

    const output = timelineQuery(db, { id: `E${segment.id}/#derived-only` });
    expect(output).toContain("2 settled · 1 forward");
  });
});
