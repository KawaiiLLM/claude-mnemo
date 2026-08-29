import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { deriveSideTags, writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import { insertLane } from "../../src/db/lanes";
import { addSegmentMembers, createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { checkLanes } from "../../src/shared/lane-checker";
import { laneToken } from "../../src/shared/lane-interpretation";
import { buildLaneAnchorAddresses, renderLaneCheckerReports } from "../../src/shared/lane-checker-render";
import {
  createConsoleReader,
  type ConsoleLaneCheckRun,
  type ConsoleReader,
  type ConsoleSegmentCardDetail,
  type ConsoleSessionsPage,
  type ConsoleTurnDisplayFields,
} from "../../src/worker/console-reader";
import {
  ELECTION_PREVIEW_BUDGET,
  EXCERPT_CONTENT_CP,
  EXCERPT_PROMPT_CP,
  GRAPH_EDGE_MAX,
  GRAPH_WINDOW_DEFAULT,
  GRAPH_WINDOW_MAX,
  RESPONSE_BYTE_SOFT_MAX,
  SESSIONS_PAGE_MAX,
  WIDEN_NODE_MAX,
  handleGraphRoute,
  handleRecallRoute,
  handleSegmentCardRoute,
  handleSegmentsRoute,
  handleSessionsRoute,
  handleTimelineRoute,
  routeConsoleApiRequest,
  toConsoleApiResponse,
  type ConsoleApiResult,
  type ConsoleRequestContext,
} from "../../src/worker/console-api";
import { laneEdge } from "../support/lane-edge-fixtures";

/**
 * The `/api/console/*` route handlers (memory-console spec API Contract;
 * ticket 03).
 *
 * Seams: for schema/error/pagination behavior, a REAL `ConsoleReader` over
 * a `:memory:` schema (spec's own Testing Decisions: "ConsoleReader-backed
 * handler functions, :memory:/fixture DBs"). For the post-load bounds
 * (WIDEN_NODE_MAX/GRAPH_EDGE_MAX/RESPONSE_BYTE_SOFT_MAX) a hand-built FAKE
 * `ConsoleReader` — seeding 2000+ real rows through SQLite just to exercise
 * a count comparison would be slow and would not test anything the fake
 * doesn't: `handleGraphRoute` takes the `ConsoleReader` INTERFACE, and the
 * bound-checking logic reads only `run.turns.length`/`run.edges.length`/
 * serialized bytes, never how they got there.
 */

const CONSOLE_API_SOURCE_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "src",
  "worker",
  "console-api.ts",
);

const CTX: ConsoleRequestContext = {
  buildId: "test-build",
  nowMs: () => 1_800_000_000_000,
};

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("console-api source guard (static)", () => {
  test("no bun:sqlite import, and every ../db/ import is type-only (handlers touch storage ONLY through ConsoleReader)", () => {
    const code = stripComments(readFileSync(CONSOLE_API_SOURCE_PATH, "utf8"));
    expect(code).not.toMatch(/bun:sqlite/);
    expect(code).not.toMatch(/\bnew Database\(/);
    expect(code).not.toMatch(/\bdb\.transaction\(/);

    const dbImportLines = code
      .split("\n")
      .filter((line) => /from ["']\.\.\/db\//.test(line));
    expect(dbImportLines.length).toBeGreaterThan(0);
    for (const line of dbImportLines) {
      expect(line).toMatch(/^\s*import\s+type\s/);
    }
  });
});

describe("toConsoleApiResponse", () => {
  test("every response carries the three required headers", async () => {
    const response = toConsoleApiResponse({ status: 200, body: { ok: true } });
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});

// --------------------------------------------------------- fake reader ----

/** Every method throws by default — a test that hits an unstubbed method fails loudly rather than silently returning `undefined`. */
function makeFakeReader(overrides: Partial<ConsoleReader> = {}): ConsoleReader {
  const unimplemented = (name: string) => () => {
    throw new Error(`fake reader: ${name} not stubbed for this test`);
  };
  return {
    listSessionsPage: overrides.listSessionsPage ?? unimplemented("listSessionsPage"),
    listAllSegmentCards: overrides.listAllSegmentCards ?? unimplemented("listAllSegmentCards"),
    findSession: overrides.findSession ?? unimplemented("findSession"),
    getSessionMaxPromptNumber:
      overrides.getSessionMaxPromptNumber ?? unimplemented("getSessionMaxPromptNumber"),
    findSegment: overrides.findSegment ?? unimplemented("findSegment"),
    getSegmentCardDetail: overrides.getSegmentCardDetail ?? unimplemented("getSegmentCardDetail"),
    // Every hand-built edge fixture below is normalized through `laneEdge`
    // (lane-model-v12 ticket 07): `LaneEdgeInput` now carries `tailTag`/
    // `headTag` beside `tags`, and a literal that sets only `tags` would hand
    // the payload builder `undefined` on both sides — neither "unsettled"
    // (`''`) nor a lane. `tests/` is outside `tsconfig.json`'s `include` and
    // bun strips types rather than checking them, so nothing else would catch
    // it. A fixture that sets the sides EXPLICITLY (a cross-lane edge) keeps
    // exactly what it set.
    runLaneCheck: overrides.runLaneCheck
      ? (scope) => {
          const run = overrides.runLaneCheck!(scope);
          return { ...run, edges: run.edges.map((edge) => laneEdge(edge)) };
        }
      : unimplemented("runLaneCheck"),
    loadTurnDisplayFields: overrides.loadTurnDisplayFields ?? unimplemented("loadTurnDisplayFields"),
    runRecall: overrides.runRecall ?? unimplemented("runRecall"),
    runTimeline: overrides.runTimeline ?? unimplemented("runTimeline"),
    runRecallOutcome: overrides.runRecallOutcome ?? unimplemented("runRecallOutcome"),
    runTimelineOutcome: overrides.runTimelineOutcome ?? unimplemented("runTimelineOutcome"),
  };
}

/** Ticket 16 scope addition: the common case, a successful render — wraps `text` in the `QueryOutcome` shape `runRecallOutcome`/`runTimelineOutcome` return. */
function okOutcome(text: string): { status: 200; text: string } {
  return { status: 200, text };
}

// semantic-conformance ticket 02 — every hand-built `LaneCheckerResult`
// fixture in this file needs this field now that `renderLaneCheckerReports`
// reads it unconditionally; the clean (no-violation) shape is reused
// everywhere a fixture has nothing to say about vocabulary conformance.
const EMPTY_VOCABULARY_CONFORMANCE = {
  typeViolations: { count: 0, entries: [] },
  outOfVocabularyEdges: { count: 0, entries: [] },
} as const;

function emptyLaneCheckRun(overrides: Partial<ConsoleLaneCheckRun> = {}): ConsoleLaneCheckRun {
  return {
    result: {
      lanes: [],
      components: [],
      // lane-model-v12 ticket 11: report 3's slot carries the cross-lane
      // coupling count now, and report 4b is the per-segment bypass-candidate
      // list — reports 4a (interfaces + bypass) and 4b's path counts are gone.
      coupling: [],
      bypassCandidates: [],
      timeOrderViolations: [],
      warnings: [],
      vocabularyConformance: EMPTY_VOCABULARY_CONFORMANCE,
      // lane-declaration ticket 09 (D9) — same reason again: the renderer
      // reads both attribution warnings unconditionally. The console's own
      // route is unchanged by that ticket; it only carries the wider result.
      unattributedClusters: { count: 0, entries: [] },
      laneProliferation: [],
      // lane-state-retirement ticket 01 — the third attribution warning, read
      // unconditionally by the render this route calls.
      tooFineIndexes: { count: 0, entries: [] },
      // tag-mandate ticket 03 — same reason as the field above: the renderer
      // reads `errors` unconditionally, so every hand-built result needs it.
      errors: [],
    },
    turns: [],
    edges: [],
    asOf: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Ticket R2 #3's invariant, callable from any test: every returned edge's both endpoints exist among returned turns. */
function expectEdgesEndpointClosed(body: any): void {
  const turnIds = new Set(body.turns.map((t: any) => t.id));
  for (const edge of body.edges) {
    expect(turnIds.has(edge.citingId)).toBe(true);
    expect(turnIds.has(edge.citedId)).toBe(true);
  }
}

// ------------------------------------------------------------- sessions ----

describe("GET /api/console/sessions", () => {
  test("schema: nullable title is null (not omitted), sessions/meta present, no nextCursor when there is no next page", () => {
    const reader = makeFakeReader({
      listSessionsPage: (): ConsoleSessionsPage => ({
        sessions: [{ id: 1, title: null, project: "/tmp/x", turnCount: 3, date: "2026-01-01T00:00:00.000Z" }],
        nextCursor: null,
      }),
    });
    const result = handleSessionsRoute(reader, new URL("http://x/api/console/sessions"), CTX);
    expect(result.status).toBe(200);
    const body = result.body as any;
    expect(body.sessions).toEqual([
      { id: 1, title: null, project: "/tmp/x", turnCount: 3, date: "2026-01-01T00:00:00.000Z" },
    ]);
    expect("nextCursor" in body).toBe(false);
    expect(body.meta).toMatchObject({
      workerBuildId: "test-build",
      stateCoverage: "full",
      appliedBounds: [],
      counts: { turns: 0, edges: 0, lanes: 0 },
      // R2 #11: constant across every route, not just the graph route.
      electionCoverage: "full-snapshot",
    });
  });

  test("nextCursor IS present when the reader reports one", () => {
    const reader = makeFakeReader({
      listSessionsPage: (): ConsoleSessionsPage => ({ sessions: [], nextCursor: "1000:5" }),
    });
    const result = handleSessionsRoute(reader, new URL("http://x/api/console/sessions"), CTX);
    expect((result.body as any).nextCursor).toBe("1000:5");
  });

  test("limit > SESSIONS_PAGE_MAX clamps and reports appliedBounds", () => {
    let seenLimit = -1;
    const reader = makeFakeReader({
      listSessionsPage: ({ limit }): ConsoleSessionsPage => {
        seenLimit = limit;
        return { sessions: [], nextCursor: null };
      },
    });
    const result = handleSessionsRoute(
      reader,
      new URL(`http://x/api/console/sessions?limit=${SESSIONS_PAGE_MAX + 25}`),
      CTX,
    );
    expect(seenLimit).toBe(SESSIONS_PAGE_MAX);
    expect((result.body as any).meta.appliedBounds).toEqual([
      { bound: "SESSIONS_PAGE_MAX", requested: SESSIONS_PAGE_MAX + 25, applied: SESSIONS_PAGE_MAX },
    ]);
  });

  for (const bad of ["0", "-1", "abc", "1.5"]) {
    test(`limit=${bad} -> 400`, () => {
      const reader = makeFakeReader();
      const result = handleSessionsRoute(reader, new URL(`http://x/api/console/sessions?limit=${bad}`), CTX);
      expect(result.status).toBe(400);
      expect((result.body as any).error.code).toBeDefined();
    });
  }

  test("a malformed cursor -> 400", () => {
    const reader = makeFakeReader();
    const result = handleSessionsRoute(reader, new URL("http://x/api/console/sessions?cursor=garbage"), CTX);
    expect(result.status).toBe(400);
  });

  test("cursor pagination against a real reader: page 1 -> nextCursor -> page 2 exhausts", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    for (let i = 0; i < 3; i += 1) {
      upsertSession(db, {
        contentSessionId: `sessions-route-${i}`,
        project: "/tmp/sessions-route",
        title: `session ${i}`,
        content: null,
        insight: null,
        createdAtEpoch: 1_000 + i,
        updatedAtEpoch: 1_000 + i,
        completedAtEpoch: null,
      });
    }
    const reader = createConsoleReader(db);

    const page1 = handleSessionsRoute(reader, new URL("http://x/api/console/sessions?limit=2"), CTX);
    const body1 = page1.body as any;
    expect(body1.sessions).toHaveLength(2);
    expect(body1.nextCursor).toBeDefined();

    const page2 = handleSessionsRoute(
      reader,
      new URL(`http://x/api/console/sessions?limit=2&cursor=${body1.nextCursor}`),
      CTX,
    );
    const body2 = page2.body as any;
    expect(body2.sessions).toHaveLength(1);
    expect("nextCursor" in body2).toBe(false);

    db.close();
  });
});

// ------------------------------------------------------------- segments ----

describe("GET /api/console/segments", () => {
  test("schema: roster-sized, unpaginated, empty tags/type render as [] never null", () => {
    const reader = makeFakeReader({
      listAllSegmentCards: () => [
        { id: 1, title: "s1", status: "open", tags: [], type: [], memberCount: 0 },
        { id: 2, title: "s2", status: "closed", tags: ["a"], type: ["design"], memberCount: 4 },
      ],
    });
    const result = handleSegmentsRoute(reader, new URL("http://x/api/console/segments"), CTX);
    expect(result.status).toBe(200);
    const body = result.body as any;
    expect(body.segments).toHaveLength(2);
    expect(body.segments[0].tags).toEqual([]);
    expect(body.segments[0].type).toEqual([]);
    expect(body.meta.stateCoverage).toBe("full");
    expect(body.meta.appliedBounds).toEqual([]);
    expect(body.meta.electionCoverage).toBe("full-snapshot"); // R2 #11
  });
});

// ---------------------------------------------------------- segment card ---

describe("GET /api/console/segment", () => {
  test("missing id -> 400", () => {
    const reader = makeFakeReader();
    const result = handleSegmentCardRoute(reader, new URL("http://x/api/console/segment"), CTX);
    expect(result.status).toBe(400);
  });

  test("unknown id -> 404 envelope", () => {
    const reader = makeFakeReader({ getSegmentCardDetail: () => null });
    const result = handleSegmentCardRoute(reader, new URL("http://x/api/console/segment?id=999"), CTX);
    expect(result.status).toBe(404);
    expect((result.body as any).error).toEqual({ code: "not_found", message: "no segment 999" });
  });

  test("known id: card + members, counts.turns reflects member count", () => {
    const detail: ConsoleSegmentCardDetail = {
      segment: {
        id: 5,
        title: "card",
        content: null,
        insight: null,
        type: [],
        tags: [],
        status: "open",
        revision: 1,
        goal: null,
        constraints: null,
        decisions: null,
        done: null,
        nextSteps: null,
        reference: null,
        createdAtEpoch: 1_000,
        updatedAtEpoch: 1_000,
      },
      memberAddresses: ["S1/T1", "S1/T2"],
    };
    const reader = makeFakeReader({ getSegmentCardDetail: () => detail });
    const result = handleSegmentCardRoute(reader, new URL("http://x/api/console/segment?id=5"), CTX);
    expect(result.status).toBe(200);
    const body = result.body as any;
    expect(body.card).toEqual(detail.segment);
    expect(body.members).toEqual(["S1/T1", "S1/T2"]);
    expect(body.meta.counts).toEqual({ turns: 2, edges: 0, lanes: 0 });
    expect(body.meta.electionCoverage).toBe("full-snapshot"); // R2 #11
  });
});

// -------------------------------------------------------- recall/timeline --

describe("GET /api/console/recall", () => {
  test("maps query, id, page, pageBudget, turn, and the structured filter fields into ConsoleRecallInput; envelope carries {text, meta}", () => {
    let seen: unknown = null;
    const reader = makeFakeReader({
      runRecallOutcome: (input) => {
        seen = input;
        return okOutcome("rendered recall text");
      },
    });
    const url = new URL(
      "http://x/api/console/recall?query=hello&id=S1&page=2&pageBudget=500&turn=80&type=fix&tag=foo&session=1&time=-7d&file=a.ts",
    );
    const result = handleRecallRoute(reader, url, CTX);
    expect(result.status).toBe(200);
    const body = result.body as any;
    expect(body.text).toBe("rendered recall text");
    expect(body.meta.workerBuildId).toBe("test-build");
    expect(seen).toEqual({
      id: "S1",
      query: "hello",
      filter: { type: "fix", tag: "foo", session: "1", time: "-7d", file: "a.ts" },
      page: 2,
      pageBudget: 500,
      turn: 80,
    });
  });

  test("no filter query params -> filter is undefined, never an empty object", () => {
    let seen: any = null;
    const reader = makeFakeReader({
      runRecallOutcome: (input) => {
        seen = input;
        return okOutcome("x");
      },
    });
    handleRecallRoute(reader, new URL("http://x/api/console/recall?id=S1"), CTX);
    expect(seen.filter).toBeUndefined();
    expect(seen.id).toBe("S1");
    expect(seen.query).toBeUndefined();
    expect(seen.page).toBeUndefined();
  });

  test("malformed page/pageBudget/turn are refused with the console's own 400 shape, never reaching the reader", () => {
    const reader = makeFakeReader({});
    for (const bad of ["page=abc", "pageBudget=-1", "turn=1.5"]) {
      const result = handleRecallRoute(reader, new URL(`http://x/api/console/recall?${bad}`), CTX);
      expect(result.status).toBe(400);
      expect((result.body as any).error.code).toBe("bad_request");
    }
  });

  // Ticket 16 scope addition (peer review finding P2): these three used to
  // parse as valid non-negative integers with no ceiling — page=0 and
  // pageBudget=0 gave a well-formed-looking request nothing renders, and
  // pageBudget/turn had no upper bound at all, weaker than the shared public
  // contract (`mcp/definitions.ts`'s `MAX_PAGE_BUDGET`/`MAX_TURN_BUDGET`).
  test("page=0 / pageBudget=0 / turn=0 and pageBudget/turn past the shared ceiling are refused, never reaching the reader", () => {
    const reader = makeFakeReader({});
    for (const bad of ["page=0", "pageBudget=0", "turn=0", "pageBudget=25001", "turn=5001"]) {
      const result = handleRecallRoute(reader, new URL(`http://x/api/console/recall?${bad}`), CTX);
      expect({ bad, status: result.status, code: (result.body as any).error.code }).toEqual({
        bad,
        status: 400,
        code: "bad_request",
      });
    }
    // The ceiling itself is inclusive — the shared contract's own boundary
    // value still reaches the reader.
    const atCeiling = handleRecallRoute(
      makeFakeReader({ runRecallOutcome: () => okOutcome("x") }),
      new URL("http://x/api/console/recall?pageBudget=25000&turn=5000"),
      CTX,
    );
    expect(atCeiling.status).toBe(200);
  });

  // Ticket 16 scope addition (peer review finding P2): the console used to
  // answer every recall failure with 200 and prose ("Parameter error: ...").
  // `runRecallOutcome`'s typed status now drives the console's own 400/404.
  test("a bad_request-shaped outcome from the reader becomes an HTTP 400, and a not_found-shaped one becomes 404 — never 200", () => {
    const badRequest = handleRecallRoute(
      makeFakeReader({
        runRecallOutcome: () => ({ status: 400, message: 'invalid id selector "garbage"' }),
      }),
      new URL("http://x/api/console/recall?id=garbage"),
      CTX,
    );
    expect(badRequest.status).toBe(400);
    expect((badRequest.body as any).error).toEqual({
      code: "bad_request",
      message: 'invalid id selector "garbage"',
    });

    const notFound = handleRecallRoute(
      makeFakeReader({
        runRecallOutcome: () => ({ status: 404, message: "Segment not found." }),
      }),
      new URL("http://x/api/console/recall?id=E99999"),
      CTX,
    );
    expect(notFound.status).toBe(404);
    expect((notFound.body as any).error).toEqual({ code: "not_found", message: "Segment not found." });
  });

  test("routed through routeConsoleApiRequest", () => {
    const reader = makeFakeReader({ runRecallOutcome: () => okOutcome("ok") });
    const result = routeConsoleApiRequest(
      "/api/console/recall",
      reader,
      new URL("http://x/api/console/recall?query=x"),
      CTX,
    );
    expect(result?.status).toBe(200);
    expect((result?.body as any).text).toBe("ok");
  });
});

describe("GET /api/console/timeline", () => {
  test("id is required — 400 when absent", () => {
    const reader = makeFakeReader({});
    const result = handleTimelineRoute(reader, new URL("http://x/api/console/timeline"), CTX);
    expect(result.status).toBe(400);
    expect((result.body as any).error.code).toBe("bad_request");
  });

  test("maps id, page, pageBudget, view, and filter fields into ConsoleTimelineInput; envelope carries {text, meta}", () => {
    let seen: any = null;
    const reader = makeFakeReader({
      runTimelineOutcome: (input) => {
        seen = input;
        return okOutcome("rendered timeline text");
      },
    });
    const url = new URL("http://x/api/console/timeline?id=E7&page=1&pageBudget=1000&view=lane&tag=foo");
    const result = handleTimelineRoute(reader, url, CTX);
    expect(result.status).toBe(200);
    expect((result.body as any).text).toBe("rendered timeline text");
    expect(seen.id).toBe("E7");
    expect(seen.view).toBe("lane");
    expect(seen.page).toBe(1);
    expect(seen.pageBudget).toBe(1000);
    expect(seen.filter).toEqual({ tag: "foo" });
  });

  test("view must be one of turns/milestones/lane — anything else is a 400, never reaching the reader", () => {
    const reader = makeFakeReader({});
    const result = handleTimelineRoute(
      reader,
      new URL("http://x/api/console/timeline?id=S1&view=bogus"),
      CTX,
    );
    expect(result.status).toBe(400);
    expect((result.body as any).error.code).toBe("bad_request");
  });

  test("view omitted -> undefined, not null, on the input the reader receives", () => {
    let seen: any = null;
    const reader = makeFakeReader({
      runTimelineOutcome: (input) => {
        seen = input;
        return okOutcome("x");
      },
    });
    handleTimelineRoute(reader, new URL("http://x/api/console/timeline?id=S1"), CTX);
    expect(seen.view).toBeUndefined();
  });

  // Ticket 16 scope addition (peer review finding P2): pageBudget=0 and past
  // the shared ceiling are refused before the reader ever sees the call —
  // `page` has no upper bound (recall's own `page` param has none either),
  // only a positivity floor.
  test("page=0 / pageBudget=0 and pageBudget past the shared ceiling are refused, never reaching the reader", () => {
    const reader = makeFakeReader({});
    for (const bad of ["page=0", "pageBudget=0", "pageBudget=25001"]) {
      const result = handleTimelineRoute(
        reader,
        new URL(`http://x/api/console/timeline?id=S1&${bad}`),
        CTX,
      );
      expect({ bad, status: result.status, code: (result.body as any).error.code }).toEqual({
        bad,
        status: 400,
        code: "bad_request",
      });
    }
  });

  // Ticket 16 scope addition (peer review finding P2): the console used to
  // answer an unrecognized/missing timeline target with 200 and prose
  // ("timeline error: ..."). `runTimelineOutcome`'s typed status now drives
  // the console's own 400/404.
  test("a bad_request-shaped outcome from the reader becomes an HTTP 400, and a not_found-shaped one becomes 404 — never 200", () => {
    const badRequest = handleTimelineRoute(
      makeFakeReader({
        runTimelineOutcome: () => ({
          status: 400,
          message: "timeline id does not match 'S<n>' or 'S<n>/T...': garbage",
        }),
      }),
      new URL("http://x/api/console/timeline?id=garbage"),
      CTX,
    );
    expect(badRequest.status).toBe(400);
    expect((badRequest.body as any).error.code).toBe("bad_request");

    const notFound = handleTimelineRoute(
      makeFakeReader({
        runTimelineOutcome: () => ({ status: 404, message: "segment E99999 not found" }),
      }),
      new URL("http://x/api/console/timeline?id=E99999"),
      CTX,
    );
    expect(notFound.status).toBe(404);
    expect((notFound.body as any).error).toEqual({
      code: "not_found",
      message: "segment E99999 not found",
    });
  });

  test("routed through routeConsoleApiRequest", () => {
    const reader = makeFakeReader({ runTimelineOutcome: () => okOutcome("ok") });
    const result = routeConsoleApiRequest(
      "/api/console/timeline",
      reader,
      new URL("http://x/api/console/timeline?id=S1"),
      CTX,
    );
    expect(result?.status).toBe(200);
    expect((result?.body as any).text).toBe("ok");
  });
});

// ------------------------------------------------------------------ graph --

describe("GET /api/console/graph — 400/404 matrix", () => {
  test("neither session nor segment -> 400", () => {
    const reader = makeFakeReader();
    const result = handleGraphRoute(reader, new URL("http://x/api/console/graph"), CTX);
    expect(result.status).toBe(400);
  });

  test("both session and segment -> 400", () => {
    const reader = makeFakeReader();
    const result = handleGraphRoute(
      reader,
      new URL("http://x/api/console/graph?session=1&segment=2"),
      CTX,
    );
    expect(result.status).toBe(400);
  });

  test("unknown session -> 404", () => {
    const reader = makeFakeReader({ findSession: () => null });
    const result = handleGraphRoute(reader, new URL("http://x/api/console/graph?session=999"), CTX);
    expect(result.status).toBe(404);
    expect((result.body as any).error.code).toBe("not_found");
  });

  test("unknown segment -> 404", () => {
    const reader = makeFakeReader({ findSegment: () => null });
    const result = handleGraphRoute(reader, new URL("http://x/api/console/graph?segment=999"), CTX);
    expect(result.status).toBe(404);
  });

  test("from > to -> 400", () => {
    const reader = makeFakeReader({ findSession: () => ({ id: 1 }) as any });
    const result = handleGraphRoute(
      reader,
      new URL("http://x/api/console/graph?session=1&from=10&to=5"),
      CTX,
    );
    expect(result.status).toBe(400);
  });

  for (const param of ["session", "segment", "from", "to"]) {
    test(`${param}=not-a-number -> 400`, () => {
      const reader = makeFakeReader({ findSession: () => ({ id: 1 }) as any });
      // "from"/"to" need a valid `session` alongside them to even reach
      // their own parsing branch; "session"/"segment" must NOT get a
      // duplicate `session=1&` prefix, or `URLSearchParams.get` would return
      // the FIRST (valid) occurrence and the malformed value would never be
      // seen at all.
      const base = param === "session" || param === "segment" ? "" : "session=1&";
      const result = handleGraphRoute(
        reader,
        new URL(`http://x/api/console/graph?${base}${param}=abc`),
        CTX,
      );
      expect(result.status).toBe(400);
    });
  }
});

describe("GET /api/console/graph — scope resolution and defaults", () => {
  test("no from/to defaults to the latest GRAPH_WINDOW_DEFAULT turns", () => {
    let seenScope: unknown;
    const reader = makeFakeReader({
      findSession: () => ({ id: 1 }) as any,
      getSessionMaxPromptNumber: () => 500,
      runLaneCheck: (scope) => {
        seenScope = scope;
        return emptyLaneCheckRun();
      },
      loadTurnDisplayFields: () => new Map(),
    });
    handleGraphRoute(reader, new URL("http://x/api/console/graph?session=1"), CTX);
    expect(seenScope).toEqual({
      kind: "range",
      sessionId: 1,
      promptStart: 500 - GRAPH_WINDOW_DEFAULT + 1,
      promptEnd: 500,
    });
  });

  test("a turn-less session (max prompt number null) resolves to an empty, non-inverted range rather than 400ing", () => {
    let seenScope: unknown;
    const reader = makeFakeReader({
      findSession: () => ({ id: 1 }) as any,
      getSessionMaxPromptNumber: () => null,
      runLaneCheck: (scope) => {
        seenScope = scope;
        return emptyLaneCheckRun();
      },
      loadTurnDisplayFields: () => new Map(),
    });
    const result = handleGraphRoute(reader, new URL("http://x/api/console/graph?session=1"), CTX);
    expect(result.status).toBe(200);
    expect((seenScope as any).promptStart).toBeLessThanOrEqual((seenScope as any).promptEnd);
  });

  test("an oversized from/to width clamps to GRAPH_WINDOW_MAX and reports appliedBounds, but stays stateCoverage: full when nothing post-load overflows", () => {
    let seenScope: unknown;
    const reader = makeFakeReader({
      findSession: () => ({ id: 1 }) as any,
      runLaneCheck: (scope) => {
        seenScope = scope;
        return emptyLaneCheckRun();
      },
      loadTurnDisplayFields: () => new Map(),
    });
    const to = GRAPH_WINDOW_MAX + 500;
    const result = handleGraphRoute(
      reader,
      new URL(`http://x/api/console/graph?session=1&from=1&to=${to}`),
      CTX,
    );
    const body = result.body as any;
    expect(seenScope).toEqual({
      kind: "range",
      sessionId: 1,
      promptStart: to - GRAPH_WINDOW_MAX + 1,
      promptEnd: to,
    });
    expect(body.meta.appliedBounds).toContainEqual({
      bound: "GRAPH_WINDOW_MAX",
      requested: to,
      applied: GRAPH_WINDOW_MAX,
    });
    expect(body.meta.stateCoverage).toBe("full");
    expect(body.meta.electionCoverage).toBe("full-snapshot"); // R2 #11
  });

  test("segment scope skips from/to entirely", () => {
    let seenScope: unknown;
    const reader = makeFakeReader({
      findSegment: () => ({ id: 7 }) as any,
      runLaneCheck: (scope) => {
        seenScope = scope;
        return emptyLaneCheckRun();
      },
      loadTurnDisplayFields: () => new Map(),
    });
    handleGraphRoute(reader, new URL("http://x/api/console/graph?segment=7"), CTX);
    expect(seenScope).toEqual({ kind: "segment", segmentId: 7 });
  });
});

describe("GET /api/console/graph — lane nullable semantics", () => {
  test("an open, never-declared lane's terminus renders as null (never omitted); a lane with no phases/edges renders [] (never null/omitted)", () => {
    const reader = makeFakeReader({
      findSession: () => ({ id: 1 }) as any,
      runLaneCheck: () =>
        emptyLaneCheckRun({
          turns: [{ id: 1, type: [], order: [0, 1] }],
          result: {
            ...emptyLaneCheckRun().result,
            lanes: [
              {
                key: { segment: "E1", tag: "focus" },
                phases: [],
                members: [{ id: 1 }],
                edgeCountsByRelation: {},
                citedness: { groundsFromNonMembers: [], usedFromNonMembers: [], testimonyFromNonMembers: [] },
                coverage: { status: "whole", missingTurnIds: [] },
              },
            ],
          },
        }),
      loadTurnDisplayFields: () => new Map(),
    });
    const result = handleGraphRoute(
      reader,
      new URL("http://x/api/console/graph?session=1&from=1&to=1"),
      CTX,
    );
    const body = result.body as any;
    expect(body.lanes).toHaveLength(1);
    const lane = body.lanes[0];
    // THE PAYLOAD-BOUNDARY SENTINEL, inverted by lane-state-retirement ticket
    // 01. `state` (closure + terminus + terminusAddress) and the raw
    // `declarationState`/`declarationTerminus` pair beside it are DELETED, not
    // nulled — the same posture ticket 04 took with `validity`/`lastDeclarer`.
    // A lane carries identity, size, phases, components and its token.
    expect("state" in lane).toBe(false);
    expect("declarationState" in lane).toBe(false);
    expect("declarationTerminus" in lane).toBe(false);
    expect(Object.keys(lane).sort()).toEqual([
      "componentCount",
      "memberCount",
      "phases",
      "segment",
      "tag",
      "token",
    ]);
    // empty-as-[], not null/omitted
    expect(lane.phases).toEqual([]);
    expect(lane.tag).toBe("focus");
  });
});

describe("GET /api/console/graph — additive fields (type/laneMemberships per turn, laneToken per edge, token per lane)", () => {
  // Two turns, one declared-but-invalid lane (T2 --indexes{focus}--> T1,
  // T1 dead): deterministic enough to pin every additive field's exact
  // value, not just "at least one is truthy" (the big fixture test's own
  // weaker style, kept for the single-source pin's own different purpose).
  function twoTurnLaneRun(): ConsoleLaneCheckRun {
    return emptyLaneCheckRun({
      // `segment: "E1"` on both turns matches the fake lane's own
      // `key.segment` below — in a REAL `runLaneCheck` result this is always
      // true by construction (both derive from the same turn rows), so the
      // fixture keeps that invariant by hand.
      turns: [
        { id: 1, type: ["design"], order: [0, 1], segment: "E1" },
        { id: 2, type: ["implement"], order: [0, 2], segment: "E1" },
      ],
      edges: [{ citingId: 2, citedId: 1, relation: "indexes", tags: ["focus"] }],
      result: {
        ...emptyLaneCheckRun().result,
        lanes: [
          {
            key: { segment: "E1", tag: "focus" },
            phases: ["decision"],
            members: [
              { id: 1 },
              { id: 2 },
            ],
            edgeCountsByRelation: { indexes: 1 },
            citedness: { groundsFromNonMembers: [], usedFromNonMembers: [], testimonyFromNonMembers: [] },
            coverage: { status: "whole", missingTurnIds: [] },
          },
        ],
      },
    });
  }

  test("turn.type is LaneTurnInput.type verbatim, no extra reader call", () => {
    const reader = makeFakeReader({
      findSession: () => ({ id: 1 }) as any,
      runLaneCheck: () => twoTurnLaneRun(),
      loadTurnDisplayFields: () => new Map(),
    });
    const result = handleGraphRoute(reader, new URL("http://x/api/console/graph?session=1&from=1&to=2"), CTX);
    const body = result.body as any;
    expect(body.turns.find((t: any) => t.id === 1).type).toEqual(["design"]);
    expect(body.turns.find((t: any) => t.id === 2).type).toEqual(["implement"]);
  });

  // lane-model-v12 ticket 04: a membership entry publishes `token` and
  // `isTerminus` and NOTHING else. The per-turn, per-lane death flag it used
  // to carry is deleted with node death itself — the whole-key assertion is
  // the payload-boundary sentinel for that.
  // [S15069/T1696]: `tags` is the RAW column and `laneMemberships` is its
  // intersection with the segment's declared lanes, so a word outside that
  // vocabulary — the segment's own tag, a retired one — must survive into the
  // payload. It is the only tag information the panel has for a turn that
  // carries no declared lane at all, which on the live segment is most of
  // them.
  test("a turn's raw tags carry words that resolve to NO lane — the panel's whole reason for the row", () => {
    const reader = makeFakeReader({
      findSession: () => ({ id: 1 }) as any,
      runLaneCheck: () => twoTurnLaneRun(),
      loadTurnDisplayFields: () =>
        new Map([
          [1, { sessionId: 1, promptNumber: 1, title: null, userPrompt: null, content: null, tags: ["focus", "claude-mnemo", "observation-pipeline"] }],
          [2, { sessionId: 1, promptNumber: 2, title: null, userPrompt: null, content: null, tags: ["rolled-back"] }],
        ]) as any,
    });
    const result = handleGraphRoute(reader, new URL("http://x/api/console/graph?session=1&from=1&to=2"), CTX);
    const body = result.body as any;
    const t1 = body.turns.find((t: any) => t.id === 1);
    const t2 = body.turns.find((t: any) => t.id === 2);

    // T1 is a member of lane `focus` AND carries two words that are not lanes.
    expect(t1.tags).toEqual(["focus", "claude-mnemo", "observation-pipeline"]);
    expect(t1.laneMemberships.map((m: any) => m.token)).toHaveLength(1);

    // T2 is also a member of `focus`, yet its stored column does not say so —
    // the two fields are independent reads, and the payload reports each as it
    // is rather than reconciling them.
    expect(t2.tags).toEqual(["rolled-back"]);
    expect(t2.laneMemberships).toHaveLength(1);
  });

  test("a lane membership entry is exactly { token, componentId } — both booleans are gone and the component is per lane", () => {
    const reader = makeFakeReader({
      findSession: () => ({ id: 1 }) as any,
      runLaneCheck: () => twoTurnLaneRun(),
      loadTurnDisplayFields: () => new Map(),
    });
    const result = handleGraphRoute(reader, new URL("http://x/api/console/graph?session=1&from=1&to=2"), CTX);
    const body = result.body as any;
    const t1 = body.turns.find((t: any) => t.id === 1);
    const t2 = body.turns.find((t: any) => t.id === 2);
    expect(t1.laneMemberships).toHaveLength(1);
    expect(Object.keys(t1.laneMemberships[0]).sort()).toEqual(["componentId", "token"]);
    expect(t2.laneMemberships).toHaveLength(1);
    expect(Object.keys(t2.laneMemberships[0]).sort()).toEqual(["componentId", "token"]);
  });

  test("both turns' laneMemberships carry the lane's own token; the lane payload's own token matches", () => {
    const reader = makeFakeReader({
      findSession: () => ({ id: 1 }) as any,
      runLaneCheck: () => twoTurnLaneRun(),
      loadTurnDisplayFields: () => new Map(),
    });
    const result = handleGraphRoute(reader, new URL("http://x/api/console/graph?session=1&from=1&to=2"), CTX);
    const body = result.body as any;
    expect(body.lanes).toHaveLength(1);
    const laneToken_: string = body.lanes[0].token;
    expect(typeof laneToken_).toBe("string");
    expect(laneToken_.length).toBeGreaterThan(0);
    expect(body.turns.find((t: any) => t.id === 1).laneMemberships.map((m: any) => m.token)).toEqual([laneToken_]);
    expect(body.turns.find((t: any) => t.id === 2).laneMemberships.map((m: any) => m.token)).toEqual([laneToken_]);
  });

  // TICKET 03's two `terminusAddress` tests stood here. The field existed for
  // ONE reason — a lane's terminus could name a turn outside the currently
  // rendered interval, so the shell could not resolve its address locally —
  // and lane-state-retirement ticket 01 deleted the terminus, so the field and
  // both tests go with it. The full-snapshot property they also exercised is
  // still pinned by the lane COUNT over a narrowed interval, below.
  test("lanes stay FULL-SNAPSHOT even when the interval narrows past their members", () => {
    const turns = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, type: ["design"], order: [0, i + 1] as const }));
    const bigTitle = "x".repeat(3_500_000);
    const displayFields = new Map<number, ConsoleTurnDisplayFields>(
      turns.map((t) => [t.id, { sessionId: 1, promptNumber: t.id, title: bigTitle, userPrompt: null, content: null }]),
    );
    const reader = makeFakeReader({
      findSession: () => ({ id: 1 }) as any,
      runLaneCheck: () =>
        emptyLaneCheckRun({
          turns,
          result: {
            ...emptyLaneCheckRun().result,
            lanes: [
              {
                key: { segment: "E1", tag: "focus" },
                phases: [],
                members: turns.map((t) => ({ id: t.id })),
                edgeCountsByRelation: {},
                citedness: { groundsFromNonMembers: [], usedFromNonMembers: [], testimonyFromNonMembers: [] },
                coverage: { status: "whole", missingTurnIds: [] },
              },
            ],
          },
        }),
      loadTurnDisplayFields: () => displayFields,
    });
    const result = handleGraphRoute(reader, new URL("http://x/api/console/graph?session=1&from=1&to=1"), CTX);
    const body = result.body as any;
    // The interval genuinely excludes turn 1 — the precondition.
    expect(body.turns.some((t: any) => t.id === 1)).toBe(false);
    // …and the lane still reports its WHOLE membership count.
    expect(body.lanes).toHaveLength(1);
    expect(body.lanes[0].memberCount).toBe(5);
  });

  test("a laneless turn carries laneMemberships: [] (never omitted/null)", () => {
    const reader = makeFakeReader({
      findSession: () => ({ id: 1 }) as any,
      runLaneCheck: () =>
        emptyLaneCheckRun({ turns: [{ id: 5, type: [], order: [0, 5] }] }),
      loadTurnDisplayFields: () => new Map(),
    });
    const result = handleGraphRoute(reader, new URL("http://x/api/console/graph?session=1&from=5&to=5"), CTX);
    const body = result.body as any;
    expect(body.turns[0].laneMemberships).toEqual([]);
  });

  test("a settled edge carries the lane payload's own token on BOTH sides; an unsettled edge carries null on both and no tag on either", () => {
    const reader = makeFakeReader({
      findSession: () => ({ id: 1 }) as any,
      runLaneCheck: () => ({
        ...twoTurnLaneRun(),
        edges: [
          { citingId: 2, citedId: 1, relation: "indexes", tags: ["focus"] },
          { citingId: 2, citedId: 1, relation: "consume", tags: [] },
        ],
      }),
      loadTurnDisplayFields: () => new Map(),
    });
    const result = handleGraphRoute(reader, new URL("http://x/api/console/graph?session=1&from=1&to=2"), CTX);
    const body = result.body as any;
    const laneToken_: string = body.lanes[0].token;
    const settled = body.edges.find((e: any) => e.relation === "indexes");
    const unsettled = body.edges.find((e: any) => e.relation === "consume");
    expect(settled.tailTag).toBe("focus");
    expect(settled.headTag).toBe("focus");
    expect(settled.tailLaneToken).toBe(laneToken_);
    expect(settled.headLaneToken).toBe(laneToken_);
    // The retired merged field must not come back under its old name.
    expect("tags" in settled).toBe(false);
    expect("laneTokens" in settled).toBe(false);
    expect(unsettled.tailTag).toBe("");
    expect(unsettled.headTag).toBe("");
    expect(unsettled.tailLaneToken).toBeNull();
    expect(unsettled.headLaneToken).toBeNull();
  });

  // lane-model-v12 spec, problem 2: "一条从 lane A 指向 lane B 的边只能写成
  // 无 tag —— 它跨了哪两条 lane 这个事实丢失". This is the payload shape's own
  // reason to exist, and the one thing the retired merged set could not say:
  // `{focus,other}` read equally as "in BOTH lanes at once" (the v11 merge).
  // A crossing has a DIRECTION — it leaves `focus` and lands in `other`.
  test("a CROSS-LANE edge names two DIFFERENT lanes, one per side, tail and head distinguishable", () => {
    const reader = makeFakeReader({
      findSession: () => ({ id: 1 }) as any,
      runLaneCheck: () => ({
        ...twoTurnLaneRun(),
        edges: [
          {
            citingId: 2,
            citedId: 1,
            relation: "indexes",
            tailTag: "focus",
            headTag: "other",
          },
        ],
        // The CITED turn sits in a DIFFERENT segment from the citing one, so
        // each side's lane token can only come out right if it is resolved in
        // its OWN endpoint's segment — a lane's identity is `(segment, tag)`,
        // and the retired plural field resolved every tag in the CITING
        // turn's segment alone.
        turns: [
          { id: 1, type: ["design"], order: [0, 1], segment: "E2" },
          { id: 2, type: ["implement"], order: [0, 2], segment: "E1" },
        ],
        result: {
          ...twoTurnLaneRun().result,
          lanes: [
            ...twoTurnLaneRun().result.lanes,
            {
              key: { segment: "E2", tag: "other" },
              phases: ["decision"],
              members: [
                { id: 1 },
                { id: 2 },
              ],
              edgeCountsByRelation: { indexes: 1 },
              citedness: { groundsFromNonMembers: [], usedFromNonMembers: [], testimonyFromNonMembers: [] },
              coverage: { status: "whole", missingTurnIds: [] },
            },
          ],
        },
      }),
      loadTurnDisplayFields: () => new Map(),
    });
    const result = handleGraphRoute(reader, new URL("http://x/api/console/graph?session=1&from=1&to=2"), CTX);
    const body = result.body as any;
    expect(body.lanes).toHaveLength(2);
    const focusToken = body.lanes.find((l: any) => l.tag === "focus").token;
    const otherToken = body.lanes.find((l: any) => l.tag === "other").token;
    const edge = body.edges.find((e: any) => e.relation === "indexes");
    // Two NAMED lanes, and which end named which is recoverable: the tail is
    // the citing side's lane, the head the cited side's. Swapping the two
    // reads is exactly the mutation this assertion exists to catch — an
    // order-insensitive `.sort()` comparison (what the retired plural field
    // could only do) would survive it.
    expect(focusToken).not.toBe(otherToken);
    expect(edge.tailTag).toBe("focus");
    expect(edge.headTag).toBe("other");
    expect(edge.tailLaneToken).toBe(focusToken);
    expect(edge.headLaneToken).toBe(otherToken);
    // ... and each token really is built in its OWN endpoint's segment: the
    // head's lane lives in E2 (the CITED turn's), never in E1.
    expect(edge.tailLaneToken).toBe(laneToken("E1", "focus"));
    expect(edge.headLaneToken).toBe(laneToken("E2", "other"));
    expect(edge.headLaneToken).not.toBe(laneToken("E1", "other"));
  });
});

describe("GET /api/console/graph — ticket 11's own pinned failure case (peer): a lane-local repair on ONE lane must not collapse a shared terminus's standing onto the whole turn", () => {
  // Release R (id 10) declares indexes{a}/{b}/{c} against core turns 1/2/3,
  // terminus of all three lanes. Repair X (id 20) corrects lane a and then
  // re-converges it: `override{a} -> R` followed by `indexes{a} -> R`, so
  // lane a's terminus MOVES to X while b/c keep R. The hand-built
  // `LaneStatsReport`s below are exactly what
  // `deriveLaneInterpretation`/`deriveLaneStates` would reduce this edge set
  // to (lane-interpretation.ts, out of this ticket's file ownership) — pinned
  // directly here so this test does not depend on that module's own internals
  // to demonstrate the CONSOLE half of the bug.
  //
  // THE FIXTURE'S SECOND EDGE IS NEW (peer cross-review A1). It used to hold
  // the override alone, and lane a's report read `{ state: "reopened",
  // terminus: null }` — a state v11 produced by CLEARING the terminus an
  // override cited. Nothing clears a terminus in v12, so that report is not a
  // shape the core can emit any more; the override alone would leave R the
  // terminus of all three lanes and this test would have no per-lane contrast
  // left to make. X's own re-declaration is how a terminus legitimately leaves
  // R in exactly one lane, which is the fact the payload must keep per-lane.
  function threeLaneRun(): ConsoleLaneCheckRun {
    return emptyLaneCheckRun({
      turns: [
        { id: 1, type: ["design"], order: [0, 1], segment: "E1" },
        { id: 2, type: ["design"], order: [0, 2], segment: "E1" },
        { id: 3, type: ["design"], order: [0, 3], segment: "E1" },
        { id: 10, type: ["indexes"], order: [0, 10], segment: "E1" },
        { id: 20, type: ["correction"], order: [0, 20], segment: "E1" },
      ],
      edges: [
        { citingId: 10, citedId: 1, relation: "indexes", tags: ["a"] },
        { citingId: 10, citedId: 2, relation: "indexes", tags: ["b"] },
        { citingId: 10, citedId: 3, relation: "indexes", tags: ["c"] },
        { citingId: 20, citedId: 10, relation: "override", tags: ["a"] },
        { citingId: 20, citedId: 10, relation: "indexes", tags: ["a"] },
      ],
      result: {
        ...emptyLaneCheckRun().result,
        lanes: [
          {
            key: { segment: "E1", tag: "a" },
            phases: ["decision"],
            members: [
              { id: 1 },
              { id: 10 },
              { id: 20 },
            ],
            edgeCountsByRelation: { indexes: 2, override: 1 },
            citedness: { groundsFromNonMembers: [], usedFromNonMembers: [], testimonyFromNonMembers: [] },
            coverage: { status: "whole", missingTurnIds: [] },
          },
          {
            key: { segment: "E1", tag: "b" },
            phases: ["decision"],
            members: [
              { id: 2 },
              { id: 10 },
            ],
            edgeCountsByRelation: { indexes: 1 },
            citedness: { groundsFromNonMembers: [], usedFromNonMembers: [], testimonyFromNonMembers: [] },
            coverage: { status: "whole", missingTurnIds: [] },
          },
          {
            key: { segment: "E1", tag: "c" },
            phases: ["decision"],
            members: [
              { id: 3 },
              { id: 10 },
            ],
            edgeCountsByRelation: { indexes: 1 },
            citedness: { groundsFromNonMembers: [], usedFromNonMembers: [], testimonyFromNonMembers: [] },
            coverage: { status: "whole", missingTurnIds: [] },
          },
        ],
      },
    });
  }

  test("R's laneMemberships carries THREE independent entries: not the terminus of lane a (X re-declared it), the terminus of b and c — never one collapsed turn-scoped boolean", () => {
    const reader = makeFakeReader({
      findSession: () => ({ id: 1 }) as any,
      runLaneCheck: () => threeLaneRun(),
      loadTurnDisplayFields: () => new Map(),
    });
    const result = handleGraphRoute(reader, new URL("http://x/api/console/graph?session=1&from=1&to=20"), CTX);
    const body = result.body as any;
    const r = body.turns.find((t: any) => t.id === 10);
    const laneA = body.lanes.find((l: any) => l.tag === "a").token;
    const laneB = body.lanes.find((l: any) => l.tag === "b").token;
    const laneC = body.lanes.find((l: any) => l.tag === "c").token;

    expect(r.laneMemberships).toHaveLength(3);
    const byToken = new Map(r.laneMemberships.map((m: any) => [m.token, m]));
    // Three INDEPENDENT entries, one per lane — the turn-scoped collapse this
    // shape exists to prevent. Their per-lane terminus fact is deleted with
    // lane state (ticket 01), like the per-lane death flag before it
    // (ticket 04), so what each entry publishes is membership and component.
    expect([...byToken.keys()].sort()).toEqual([laneA, laneB, laneC].sort());
    for (const m of r.laneMemberships) {
      expect(Object.keys(m as any).sort()).toEqual(["componentId", "token"]);
    }
  });
});

/**
 * LOAD-BEARING PROPERTIES (ticket 03, peer P1-3/P2-4/P2-7 — mutation
 * acceptance, each pinned by its own test below):
 *
 *   1. INTERVAL SELECTION SEES THE FULL INDEX. `applyGraphAutoInterval` runs
 *      on the un-count-capped `turns`/`edges` — a scope whose TOTAL edge
 *      count exceeds `GRAPH_EDGE_MAX` (or turn count exceeds
 *      `WIDEN_NODE_MAX`) does not corrupt what the walk can see. Re-inserting
 *      a pre-cap ahead of the interval selector reddens the P1-3
 *      counterexample test (an edge between two turns the walk WOULD select
 *      goes missing because it never survived a stable-oldest-prefix cut
 *      that ran before the walk).
 *   2. THE TWO COUNT CAPS APPLY AFTER INTERVAL RESOLUTION, NEWEST-FIRST.
 *      `applyPostIntervalCountBounds` trims the RESOLVED turns/edges, tail
 *      (newest) kept, head (oldest) dropped — the reverse of the retired
 *      oldest-first prefix cut. Reverting the slice direction (or moving the
 *      call back before `applyGraphAutoInterval`) reddens the
 *      newest-turn-reachability test: the true newest turn becomes invisible
 *      to both the default view and interval navigation.
 *   3. A WIDEN_NODE_MAX TRIM STAYS ENDPOINT-CLOSED AND HONEST ABOUT ITS OWN
 *      BOUNDARY. Trimming turns without re-filtering `edges` against the
 *      smaller turn set reddens `expectEdgesEndpointClosed`; trimming turns
 *      without re-deriving `interval.fromTurnId`/`fromAddress`/`isOldest`
 *      leaves the response's own `meta.interval` claiming a turn range wider
 *      than what it actually ships.
 *   4. SELF-EDGES JOIN THE WALK EXACTLY ONCE. A self-edge
 *      (`citingId === citedId`) rides in with its own turn's inclusion step
 *      (its "other" endpoint IS the turn being added) and is bucketed once,
 *      not twice — dropping the self-edge special case reddens the
 *      self-edge test by omission; not deduping the `edgesByTurnId` bucket
 *      reddens it by duplication.
 */
describe("GET /api/console/graph — post-load bounds and partial labeling", () => {
  function turnsOfCount(n: number) {
    return Array.from({ length: n }, (_, i) => ({ id: i + 1, type: ["design"], order: [0, i + 1] as const }));
  }
  function edgesOfCount(n: number, turnCount: number) {
    return Array.from({ length: n }, (_, i) => ({
      citingId: (i % turnCount) + 1,
      citedId: ((i + 1) % turnCount) + 1,
      relation: "consume",
      tags: [] as string[],
    }));
  }

  test("widened turns over WIDEN_NODE_MAX -> truncated NEWEST-first, partial, appliedBounds names the bound; the true newest turn is reachable in the default view AND by paging older via interval", () => {
    const turns = turnsOfCount(WIDEN_NODE_MAX + 10); // ids 1..WIDEN_NODE_MAX+10
    const reader = makeFakeReader({
      findSession: () => ({ id: 1 }) as any,
      getSessionMaxPromptNumber: () => 1,
      runLaneCheck: () => emptyLaneCheckRun({ turns, result: emptyLaneCheckRun().result }),
      loadTurnDisplayFields: () => new Map(),
    });

    // Default view (no `interval` param): the response is the NEWEST
    // WIDEN_NODE_MAX turns (ids 11..WIDEN_NODE_MAX+10) — the reverse of the
    // retired oldest-first prefix (which pinned ids 1..WIDEN_NODE_MAX and
    // made the true newest 10 turns unreachable by ANY interval at all).
    const result = handleGraphRoute(
      reader,
      new URL("http://x/api/console/graph?session=1&from=1&to=1"),
      CTX,
    );
    const body = result.body as any;
    expect(body.turns).toHaveLength(WIDEN_NODE_MAX);
    expect(body.turns.map((t: any) => t.id)).toEqual(turns.slice(-WIDEN_NODE_MAX).map((t) => t.id));
    // The true newest turn is right there in the default view.
    expect(body.turns.at(-1).id).toBe(turns.at(-1)!.id);
    expect(body.meta.stateCoverage).toBe("partial");
    expect(body.meta.appliedBounds).toContainEqual({
      bound: "WIDEN_NODE_MAX",
      requested: WIDEN_NODE_MAX + 10,
      applied: WIDEN_NODE_MAX,
    });
    expectEdgesEndpointClosed(body);
    // A WIDEN_NODE_MAX trim re-derives the interval's own boundary: it is no
    // longer the absolute oldest turn (10 older ones were cut), but it IS
    // still the absolute newest.
    expect(body.meta.interval.fromTurnId).toBe(turns.at(-WIDEN_NODE_MAX)!.id);
    expect(body.meta.interval.isOldest).toBe(false);
    expect(body.meta.interval.isNewest).toBe(true);
    // R2 #11: still "full-snapshot" under trimming — election tiers were
    // computed on the FULL projection before this response's own truncation
    // ran, so the field's meaning does not change just because the response
    // became partial.
    expect(body.meta.electionCoverage).toBe("full-snapshot");

    // Paging OLDER via the interval mechanism reaches the remaining 10
    // turns the default view's own WIDEN_NODE_MAX trim excluded — the exact
    // reachability the retired mechanism broke ("past WIDEN_NODE_MAX turns,
    // the true newest turns become unreachable by ANY interval" also meant
    // no interval value could ever bring the EXCLUDED older turns back
    // either, since the old cut ran before the interval selector could ever
    // see them).
    const older = handleGraphRoute(
      reader,
      new URL(`http://x/api/console/graph?session=1&from=1&to=1&interval=${body.meta.interval.fromTurnId - 1}`),
      CTX,
    );
    const olderBody = older.body as any;
    expect(olderBody.turns.map((t: any) => t.id)).toEqual(turns.slice(0, 10).map((t) => t.id));
    expect(olderBody.meta.interval.isOldest).toBe(true);
    expect(olderBody.meta.interval.isNewest).toBe(false);
    expectEdgesEndpointClosed(olderBody);
  });

  test("widened edges over GRAPH_EDGE_MAX -> truncated NEWEST-first (the tail of the ascending sort survives, not the head)", () => {
    // A "complete DAG" over 201 turns (every later turn cites every earlier
    // one) — C(201,2) = 20100 distinct (citingId,citedId) pairs, comfortably
    // over GRAPH_EDGE_MAX, and every pair is UNIQUE (no ties on the
    // (citingId,citedId,relation) sort key), so which specific edges survive
    // is unambiguous — unlike a small cyclic ring, where every surviving
    // edge is indistinguishable from a cut one by content alone.
    const turnCount = 201;
    const turns = turnsOfCount(turnCount);
    const edges: { citingId: number; citedId: number; relation: string; tags: string[] }[] = [];
    for (let citing = 2; citing <= turnCount; citing += 1) {
      for (let cited = 1; cited < citing; cited += 1) {
        edges.push({ citingId: citing, citedId: cited, relation: "consume", tags: [] });
      }
    }
    expect(edges.length).toBeGreaterThan(GRAPH_EDGE_MAX);

    const reader = makeFakeReader({
      findSession: () => ({ id: 1 }) as any,
      runLaneCheck: () => emptyLaneCheckRun({ turns, edges }),
      loadTurnDisplayFields: () => new Map(),
    });
    const result = handleGraphRoute(
      reader,
      new URL("http://x/api/console/graph?session=1&from=1&to=1"),
      CTX,
    );
    const body = result.body as any;
    expect(body.edges).toHaveLength(GRAPH_EDGE_MAX);
    expect(body.meta.stateCoverage).toBe("partial");
    expect(body.meta.appliedBounds).toContainEqual({
      bound: "GRAPH_EDGE_MAX",
      requested: edges.length,
      applied: GRAPH_EDGE_MAX,
    });
    expectEdgesEndpointClosed(body);
    // NEWEST-first, the direction fix itself: the earliest possible pair
    // (turn 2 -> turn 1, first in ascending sort order) is exactly what the
    // retired oldest-first cut would have KEPT — it must be gone now. The
    // latest possible pair (turn 201 -> turn 200, last in ascending sort
    // order) is exactly what the old cut would have DROPPED — it must
    // survive now.
    expect(body.edges.some((e: any) => e.citingId === 2 && e.citedId === 1)).toBe(false);
    expect(body.edges.some((e: any) => e.citingId === turnCount && e.citedId === turnCount - 1)).toBe(true);
  });

  test("ticket 03 (peer P1-3): in-interval edge completeness holds even when the TOTAL edge count exceeds GRAPH_EDGE_MAX — the P1-3 counterexample (red pre-fix)", () => {
    // The bug this pins: pre-fix, GRAPH_EDGE_MAX cut a stable oldest-first
    // prefix of the FULL edge list BEFORE the interval walk ever ran. Here,
    // 10005 "filler" edges (citingId/citedId 1..10006, never matching any
    // real turn) sort ahead of every real structural edge (whose turns are
    // numbered 20000+) purely by numeric citingId — so the old oldest-first
    // cut would keep the fillers and discard EVERY real edge, even though
    // none of the filler edges could ever appear in a response (their
    // endpoints are not real turns) and every real edge connects turns that
    // DO end up in the selected interval. Post-fix, the filler edges never
    // reach the walk's own per-turn edge buckets at all (they key on real
    // turn ids only) and are excluded from `eligibleEdges` before any byte
    // accounting — so they cost nothing and hide nothing.
    const REAL_BASE = 20_000;
    const turns = Array.from({ length: 5 }, (_, i) => ({ id: REAL_BASE + i, type: ["design"], order: [0, REAL_BASE + i] as const }));
    const bigTitle = "x".repeat(3_500_000); // same calibration as the turn-atomic test below: only the newest 2 of 5 survive
    const displayFields = new Map<number, ConsoleTurnDisplayFields>(
      turns.map((t) => [t.id, { sessionId: 1, promptNumber: t.id, title: bigTitle, userPrompt: null, content: null }]),
    );
    const realEdges = Array.from({ length: 500 }, (_, i) => ({
      citingId: REAL_BASE + (i % 5),
      citedId: REAL_BASE + ((i + 1) % 5),
      relation: "consume",
      tags: [] as string[],
    }));
    const fillerEdges = Array.from({ length: 10_005 }, (_, i) => ({
      citingId: i + 1,
      citedId: i + 2,
      relation: "consume",
      tags: [] as string[],
    }));
    const edges = [...fillerEdges, ...realEdges];
    expect(edges.length).toBeGreaterThan(GRAPH_EDGE_MAX);

    const reader = makeFakeReader({
      findSession: () => ({ id: 1 }) as any,
      runLaneCheck: () => emptyLaneCheckRun({ turns, edges }),
      loadTurnDisplayFields: () => displayFields,
    });
    const result = handleGraphRoute(
      reader,
      new URL("http://x/api/console/graph?session=1&from=1&to=1"),
      CTX,
    );
    const body = result.body as any;
    // Same pin as the turn-atomic test: exactly the newest 2 turns survive
    // the byte walk, connected by exactly their 100 real ring edges — and
    // GRAPH_EDGE_MAX never even fires on this response (100 << 10000),
    // because the filler edges were never candidates for inclusion.
    expect(body.turns.map((t: any) => t.id).sort((a: number, b: number) => a - b)).toEqual([
      REAL_BASE + 3,
      REAL_BASE + 4,
    ]);
    expect(body.edges).toHaveLength(100);
    expect(body.edges.every((e: any) => e.citingId === REAL_BASE + 3 && e.citedId === REAL_BASE + 4)).toBe(true);
    expectEdgesEndpointClosed(body);
    expect(body.meta.appliedBounds.some((b: any) => b.bound === "GRAPH_EDGE_MAX")).toBe(false);
  });

  test("ticket 03 (peer P2-4): a self-edge (citingId === citedId) survives the over-budget walk with its own turn, exactly once — never dropped, never duplicated", () => {
    // Same 5-turn/big-title calibration as the turn-atomic test: only turns
    // 4 and 5 survive. A real self-edge shape (Gate C self-`grounds`) is
    // added on turn 5, alongside the same 500-edge ring.
    const turns = turnsOfCount(5);
    const ringEdges = Array.from({ length: 500 }, (_, i) => ({
      citingId: (i % 5) + 1,
      citedId: ((i + 1) % 5) + 1,
      relation: "consume",
      tags: [] as string[],
    }));
    const selfEdge = { citingId: 5, citedId: 5, relation: "grounds", tags: [] as string[] };
    const edges = [...ringEdges, selfEdge];
    const bigTitle = "x".repeat(3_500_000);
    const displayFields = new Map<number, ConsoleTurnDisplayFields>(
      turns.map((t) => [t.id, { sessionId: 1, promptNumber: t.id, title: bigTitle, userPrompt: null, content: null }]),
    );
    const reader = makeFakeReader({
      findSession: () => ({ id: 1 }) as any,
      runLaneCheck: () => emptyLaneCheckRun({ turns, edges }),
      loadTurnDisplayFields: () => displayFields,
    });
    const result = handleGraphRoute(
      reader,
      new URL("http://x/api/console/graph?session=1&from=1&to=1"),
      CTX,
    );
    const body = result.body as any;
    expect(body.turns.map((t: any) => t.id).sort((a: number, b: number) => a - b)).toEqual([4, 5]);
    const selfEdgesInBody = body.edges.filter((e: any) => e.citingId === 5 && e.citedId === 5 && e.relation === "grounds");
    expect(selfEdgesInBody).toHaveLength(1);
    // The 100 (4,5) ring edges survive alongside it, unaffected.
    expect(body.edges.filter((e: any) => e.citingId === 4 && e.citedId === 5)).toHaveLength(100);
    expectEdgesEndpointClosed(body);
  });

  test("oversized serialized bytes (huge titles, counts within cap) -> auto-interval narrows to the newest-filling subset, partial, RESPONSE_BYTE_SOFT_MAX named", () => {
    const turnCount = 20;
    const turns = turnsOfCount(turnCount);
    // `title` is the one turn field `codePointExcerpt` never caps (unlike
    // promptExcerpt/contentExcerpt) — the size driver here, at the ticket
    // 04 scale (8MB budget): 20 * ~500KB ~= 10MB, comfortably over budget
    // but small enough (n=20) that the walk's own O(n^2) re-serialization
    // stays fast.
    const hugeTitle = "x".repeat(500_000);
    const displayFields = new Map<number, ConsoleTurnDisplayFields>(
      turns.map((t) => [t.id, { sessionId: 1, promptNumber: t.id, title: hugeTitle, userPrompt: null, content: null }]),
    );
    const reader = makeFakeReader({
      findSession: () => ({ id: 1 }) as any,
      runLaneCheck: () => emptyLaneCheckRun({ turns }),
      loadTurnDisplayFields: () => displayFields,
    });
    const result = handleGraphRoute(
      reader,
      new URL("http://x/api/console/graph?session=1&from=1&to=1"),
      CTX,
    );
    const body = result.body as any;
    expect(body.turns.length).toBeGreaterThan(0);
    expect(body.turns.length).toBeLessThan(turnCount);
    expect(body.meta.stateCoverage).toBe("partial");
    const byteBound = body.meta.appliedBounds.find((b: any) => b.bound === "RESPONSE_BYTE_SOFT_MAX");
    expect(byteBound).toBeDefined();
    expect(byteBound.applied).toBe(RESPONSE_BYTE_SOFT_MAX);
    expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeLessThanOrEqual(RESPONSE_BYTE_SOFT_MAX);
    expectEdgesEndpointClosed(body);
    // Ticket 04: the auto-selected interval is the NEWEST-filling one — the
    // last (highest-id) turn is always kept, and the boundary names it.
    expect(body.turns.at(-1).id).toBe(turns.at(-1)!.id);
    expect(body.meta.interval).toBeDefined();
    expect(body.meta.interval.toTurnId).toBe(turns.at(-1)!.id);
    expect(body.meta.interval.isNewest).toBe(true);
    expect(body.meta.interval.isOldest).toBe(false);
  });

  test("R2 #2: an untrimmable lane (zero turns to begin with) still over the byte bound triggers the refusal-with-summary envelope — never a payload larger than RESPONSE_BYTE_SOFT_MAX carrying an applied-bound claim", () => {
    // Reviewer's original 600KB-lane-tag repro, rescaled for ticket 04's 8MB
    // budget: `laneToken` (used for both `membershipComponentId` and
    // `token`) plus `tag` itself each embed the tag text, so a single
    // huge tag renders at least 3x — comfortable margin over 8MB even if
    // laneCheckText contributes nothing at all.
    const hugeTag = "t".repeat(4_000_000);
    const reader = makeFakeReader({
      findSession: () => ({ id: 1 }) as any,
      runLaneCheck: () =>
        emptyLaneCheckRun({
          turns: [],
          edges: [],
          result: {
            ...emptyLaneCheckRun().result,
            lanes: [
              {
                key: { segment: "E1", tag: hugeTag },
                phases: [],
                members: [],
                edgeCountsByRelation: {},
                citedness: { groundsFromNonMembers: [], usedFromNonMembers: [], testimonyFromNonMembers: [] },
                coverage: { status: "whole", missingTurnIds: [] },
              },
            ],
          },
        }),
      loadTurnDisplayFields: () => new Map(),
    });
    const result = handleGraphRoute(
      reader,
      new URL("http://x/api/console/graph?session=1&from=1&to=1"),
      CTX,
    );
    expect(result.status).toBe(200);
    const body = result.body as any;
    // The core invariant this rules out: whatever ships must actually
    // respect RESPONSE_BYTE_SOFT_MAX.
    expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeLessThanOrEqual(RESPONSE_BYTE_SOFT_MAX);
    expect(body.turns).toEqual([]);
    expect(body.edges).toEqual([]);
    expect(body.lanes).toEqual([]);
    expect(body.laneCheckText).toBe("");
    expect(body.error).toBeDefined();
    expect(body.error.code).toBeDefined();
    expect(body.error.message).toContain("RESPONSE_BYTE_SOFT_MAX");
    expect(body.meta.stateCoverage).toBe("partial");
    expect(body.meta.interval).toBeNull();
    const byteBound2 = body.meta.appliedBounds.find((b: any) => b.bound === "RESPONSE_BYTE_SOFT_MAX");
    expect(byteBound2).toBeDefined();
    expect(byteBound2.applied).toBe(RESPONSE_BYTE_SOFT_MAX);
  });

  test("ticket 04: the auto-interval walk is TURN-ATOMIC — a turn is never included without its own full induced-edge set, and an excluded turn contributes zero edges", () => {
    // 5 turns (ids ascending 1..5, "newest" = 5), each carrying a title big
    // enough that only the newest few fit under RESPONSE_BYTE_SOFT_MAX:
    // 2 turns ~= 7.0MB (fits), 3 turns ~= 10.5MB (does not) — a safe (non
    // knife-edge) margin either side of the 8MB budget. 500 edges cycle
    // through the ring (1,2)(2,3)(3,4)(4,5)(5,1), 100 copies each.
    const turns = turnsOfCount(5);
    const edges = edgesOfCount(500, 5);
    const bigTitle = "x".repeat(3_500_000);
    const displayFields = new Map<number, ConsoleTurnDisplayFields>(
      turns.map((t) => [t.id, { sessionId: 1, promptNumber: t.id, title: bigTitle, userPrompt: null, content: null }]),
    );
    const reader = makeFakeReader({
      findSession: () => ({ id: 1 }) as any,
      runLaneCheck: () => emptyLaneCheckRun({ turns, edges }),
      loadTurnDisplayFields: () => displayFields,
    });
    const result = handleGraphRoute(
      reader,
      new URL("http://x/api/console/graph?session=1&from=1&to=1"),
      CTX,
    );
    const body = result.body as any;
    // Deterministic pin at these calibrated sizes: exactly turns 4 and 5
    // survive, and exactly the 100 (4,5) edges among them — never a partial
    // slice of that edge set, and never the (3,4)/(5,1) edges whose other
    // endpoint did not make it in.
    expect(body.turns.map((t: any) => t.id).sort((a: number, b: number) => a - b)).toEqual([4, 5]);
    expect(body.edges).toHaveLength(100);
    expect(body.edges.every((e: any) => e.citingId === 4 && e.citedId === 5)).toBe(true);
    expectEdgesEndpointClosed(body);
    expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeLessThanOrEqual(RESPONSE_BYTE_SOFT_MAX);
    expect(body.meta.interval).toEqual({
      fromTurnId: 4,
      toTurnId: 5,
      fromAddress: "S1/T4",
      toAddress: "S1/T5",
      isOldest: false,
      isNewest: true,
    });
  });

  test("ticket 04: the interval param round-trips — requesting an older interval (ceiling below the previous response's fromTurnId) returns that older interval, budget-guarded identically", () => {
    const turns = turnsOfCount(5);
    const edges = edgesOfCount(500, 5);
    const bigTitle = "x".repeat(3_500_000);
    const displayFields = new Map<number, ConsoleTurnDisplayFields>(
      turns.map((t) => [t.id, { sessionId: 1, promptNumber: t.id, title: bigTitle, userPrompt: null, content: null }]),
    );
    const reader = makeFakeReader({
      findSession: () => ({ id: 1 }) as any,
      runLaneCheck: () => emptyLaneCheckRun({ turns, edges }),
      loadTurnDisplayFields: () => displayFields,
    });
    // First load (no interval param): auto-narrows to [4,5] (pinned above).
    const first = handleGraphRoute(
      reader,
      new URL("http://x/api/console/graph?session=1&from=1&to=1"),
      CTX,
    ).body as any;
    expect(first.meta.interval.fromTurnId).toBe(4);

    // Client re-issues with interval = fromTurnId - 1 (the shell's own
    // "较早" affordance) — same session/segment scope, older ceiling.
    const second = handleGraphRoute(
      reader,
      new URL(`http://x/api/console/graph?session=1&from=1&to=1&interval=${first.meta.interval.fromTurnId - 1}`),
      CTX,
    ).body as any;
    expect(second.turns.map((t: any) => t.id).sort((a: number, b: number) => a - b)).toEqual([2, 3]);
    expect(second.meta.interval).toMatchObject({ fromTurnId: 2, toTurnId: 3, isNewest: false });
    // Budget-guarded identically: still respects the same bound, still
    // endpoint-closed, still turn-atomic.
    expectEdgesEndpointClosed(second);
    expect(new TextEncoder().encode(JSON.stringify(second)).length).toBeLessThanOrEqual(RESPONSE_BYTE_SOFT_MAX);
  });

  test("ticket 04: election tiers are unchanged by interval choice — the SAME turn's tier is identical whether it appears in the full response or a narrower explicit interval", () => {
    const turns = turnsOfCount(5);
    const edges = edgesOfCount(500, 5);
    const reader = makeFakeReader({
      findSession: () => ({ id: 1 }) as any,
      runLaneCheck: () => emptyLaneCheckRun({ turns, edges }),
      loadTurnDisplayFields: () => new Map(),
    });
    const full = (handleGraphRoute(
      reader,
      new URL("http://x/api/console/graph?session=1&from=1&to=1"),
      CTX,
    ).body as any).turns;
    const narrowed = (handleGraphRoute(
      reader,
      new URL("http://x/api/console/graph?session=1&from=1&to=1&interval=3"),
      CTX,
    ).body as any).turns;
    for (const t of narrowed) {
      const same = full.find((f: any) => f.id === t.id);
      expect(same).toBeDefined();
      expect(t.electionTier).toBe(same.electionTier);
    }
  });

  test("ticket 04: an interval ceiling with nothing eligible under it (below the oldest widened turn) returns an empty, non-unfittable response", () => {
    const turns = turnsOfCount(3); // ids 1,2,3
    const reader = makeFakeReader({
      findSession: () => ({ id: 1 }) as any,
      runLaneCheck: () => emptyLaneCheckRun({ turns }),
      loadTurnDisplayFields: () => new Map(),
    });
    const result = handleGraphRoute(
      reader,
      new URL("http://x/api/console/graph?session=1&from=1&to=1&interval=0"),
      CTX,
    );
    expect(result.status).toBe(200);
    const body = result.body as any;
    expect(body.turns).toEqual([]);
    expect(body.edges).toEqual([]);
    expect(body.error).toBeUndefined();
    expect(body.meta.interval).toBeNull();
  });

  for (const bad of ["abc", "-1", "1.5"]) {
    test(`interval=${bad} -> 400`, () => {
      // No reader method stubbed at all (beyond the default "throws
      // loudly") — `interval` validates BEFORE `resolveGraphScope` runs, so
      // this 400 must come back without ever touching the reader.
      const reader = makeFakeReader();
      const result = handleGraphRoute(
        reader,
        new URL(`http://x/api/console/graph?session=1&interval=${bad}`),
        CTX,
      );
      expect(result.status).toBe(400);
    });
  }

  test("whole scope fits under the raised caps with zero narrowing -> meta.interval spans the full set (isOldest and isNewest both true)", () => {
    const turns = turnsOfCount(5);
    const reader = makeFakeReader({
      findSession: () => ({ id: 1 }) as any,
      runLaneCheck: () => emptyLaneCheckRun({ turns }),
      loadTurnDisplayFields: () => new Map(),
    });
    const result = handleGraphRoute(
      reader,
      new URL("http://x/api/console/graph?session=1&from=1&to=1"),
      CTX,
    );
    const body = result.body as any;
    expect(body.turns).toHaveLength(5);
    expect(body.meta.stateCoverage).toBe("full");
    expect(body.meta.interval).toEqual({
      fromTurnId: 1,
      toTurnId: 5,
      // No `loadTurnDisplayFields` override here -> `sessionId` falls back
      // to `turn.order[0]`, which `turnsOfCount`'s own fixture sets to 0
      // (a placeholder, not a real session id).
      fromAddress: "S0/T1",
      toAddress: "S0/T5",
      isOldest: true,
      isNewest: true,
    });
  });

  test("R2 #3 (ticket 03 direction fix): a turn dropped by the NEWEST-first WIDEN_NODE_MAX trim leaves its own edge dangling — filtered out, never shipped with a missing endpoint", () => {
    const turns = turnsOfCount(WIDEN_NODE_MAX + 1); // ids 1..WIDEN_NODE_MAX+1
    // citingId=1 is the OLDEST turn — exactly the one the newest-first trim
    // now drops (the reverse of this test's pre-ticket-03 shape, where the
    // oldest-first trim dropped the NEWEST turn, WIDEN_NODE_MAX+1, instead).
    const danglingEdge = { citingId: 1, citedId: WIDEN_NODE_MAX + 1, relation: "consume", tags: [] as string[] };
    const reader = makeFakeReader({
      findSession: () => ({ id: 1 }) as any,
      getSessionMaxPromptNumber: () => 1,
      runLaneCheck: () => emptyLaneCheckRun({ turns, edges: [danglingEdge] }),
      loadTurnDisplayFields: () => new Map(),
    });
    const result = handleGraphRoute(
      reader,
      new URL("http://x/api/console/graph?session=1&from=1&to=1"),
      CTX,
    );
    const body = result.body as any;
    expect(body.turns).toHaveLength(WIDEN_NODE_MAX);
    // The newest turn (WIDEN_NODE_MAX+1) survives; the oldest (id 1) does not.
    expect(body.turns.some((t: any) => t.id === WIDEN_NODE_MAX + 1)).toBe(true);
    expect(body.turns.some((t: any) => t.id === 1)).toBe(false);
    // T1 (the edge's own citingId) was trimmed out — the edge naming it
    // must not survive.
    expect(body.edges).toEqual([]);
    expect(body.meta.counts.edges).toBe(0);
    expectEdgesEndpointClosed(body);
  });

  test("promptExcerpt/contentExcerpt are cut BY CODE POINT, never mid-surrogate-pair", () => {
    const cjk = "字".repeat(EXCERPT_PROMPT_CP + 50);
    const turns = turnsOfCount(1);
    const reader = makeFakeReader({
      findSession: () => ({ id: 1 }) as any,
      runLaneCheck: () => emptyLaneCheckRun({ turns }),
      loadTurnDisplayFields: () =>
        new Map([[1, { sessionId: 1, promptNumber: 1, title: "t", userPrompt: cjk, content: cjk }]]),
    });
    const result = handleGraphRoute(
      reader,
      new URL("http://x/api/console/graph?session=1&from=1&to=1"),
      CTX,
    );
    const body = result.body as any;
    expect([...body.turns[0].promptExcerpt].length).toBe(EXCERPT_PROMPT_CP);
    expect([...body.turns[0].contentExcerpt].length).toBe(EXCERPT_CONTENT_CP);
  });

  test("runLaneCheck is called EXACTLY ONCE per graph request (spec: one projection)", () => {
    let calls = 0;
    const reader = makeFakeReader({
      findSession: () => ({ id: 1 }) as any,
      runLaneCheck: () => {
        calls += 1;
        return emptyLaneCheckRun();
      },
      loadTurnDisplayFields: () => new Map(),
    });
    handleGraphRoute(reader, new URL("http://x/api/console/graph?session=1&from=1&to=1"), CTX);
    expect(calls).toBe(1);
  });
});

// ------------------------------------------------------ single-source pin -

describe("single-source pin — T900-1001 fixture", () => {
  interface FixtureTurn {
    id: number;
    type: string[];
    title?: string;
  }
  interface FixtureEdge {
    citingId: number;
    relation: string;
    citedId: number;
    tags: string[];
  }
  interface Fixture {
    turns: FixtureTurn[];
    edges: FixtureEdge[];
  }

  const fixture: Fixture = JSON.parse(
    readFileSync(
      join(process.cwd(), ".scratch/rubric-v10/fixtures/t900-1001-lane-sim.json"),
      "utf8",
    ),
  );

  let db: Database;
  let sessionId: number;
  const NOW = 1_800_000_000;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "t900-1001-fixture",
      project: "/tmp/t900-1001",
      title: "fixture session",
      content: null,
      insight: null,
      createdAtEpoch: NOW,
      updatedAtEpoch: NOW,
      completedAtEpoch: null,
    }).id;

    // Turn id AND prompt_number both set to the fixture's own `id` — the
    // fixture's ids already ARE prompt numbers (S15069/T900-1001), so a
    // range scope [900,1001] resolves the identical seed set the fixture
    // was hand-labeled against.
    // MEMBERSHIP IS A NODE FACT (lane-model-v12 ticket 10): each turn carries
    // the lane tags ITS OWN SIDE of the fixture's edges names, one segment
    // owns every turn, and that segment declares each of those lanes. Read off
    // the fixture's own edges rather than restated, so this stays the same
    // hand-judged membership the corpus was labelled with.
    const laneTagsByTurn = new Map<number, Set<string>>();
    const claim = (turnId: number, tag: string): void => {
      if (tag === "") return;
      const bucket = laneTagsByTurn.get(turnId) ?? new Set<string>();
      bucket.add(tag);
      laneTagsByTurn.set(turnId, bucket);
    };
    for (const edge of fixture.edges) {
      const sides = deriveSideTags(edge.tags);
      claim(edge.citingId, sides.tailTag);
      claim(edge.citedId, sides.headTag);
    }
    const insertTurn = db.query<unknown, [number, number, number, string, string | null, number, string]>(
      `INSERT INTO turns (id, session_id, prompt_number, status, user_prompt, title, tool_call_count, created_at_epoch, type, tags)
       VALUES (?, ?, ?, 'active', 'p', ?, 1, ?, ?, ?)`,
    );
    for (const turn of fixture.turns) {
      insertTurn.run(
        turn.id,
        sessionId,
        turn.id,
        turn.title ?? null,
        NOW + turn.id,
        JSON.stringify(turn.type),
        JSON.stringify([...(laneTagsByTurn.get(turn.id) ?? [])]),
      );
    }
    const fixtureSegmentId = createSegment(db, { title: "t900-1001", nowEpoch: NOW }).id;
    addSegmentMembers(db, fixtureSegmentId, fixture.turns.map((turn) => turn.id), NOW);
    for (const tag of new Set([...laneTagsByTurn.values()].flatMap((tags) => [...tags]))) {
      insertLane(db, fixtureSegmentId, tag, NOW);
    }
    writeMemoryEdges(
      db,
      fixture.edges.map((edge) => ({
        citing: { kind: "turn", id: edge.citingId },
        cited: { kind: "turn", id: edge.citedId },
        relation: edge.relation as never,
        provenance: "asserted",
        ...deriveSideTags(edge.tags),
      })),
      NOW,
    );
  });

  afterEach(() => {
    db.close();
  });

  test("the graph payload's laneCheckText and lane count are the SAME checkLanes result — an independent second load over the unchanged database agrees byte-for-byte", () => {
    const reader = createConsoleReader(db);
    const result = handleGraphRoute(
      reader,
      new URL(`http://x/api/console/graph?session=${sessionId}&from=900&to=1001`),
      CTX,
    );
    expect(result.status).toBe(200);
    const body = result.body as any;

    // Independently re-run the SAME chain the handler's ConsoleReader ran
    // internally, over the unchanged database — deterministic, so a
    // byte-identical laneCheckText proves the payload is a PROJECTION of a
    // real checkLanes result, not a fabricated or independently-derived one.
    const secondReader = createConsoleReader(db);
    const secondRun = secondReader.runLaneCheck({
      kind: "range",
      sessionId,
      promptStart: 900,
      promptEnd: 1001,
    });
    // floor-and-render-fidelity ticket 03: `handleGraphRoute` now builds the
    // address map from this SAME projection's own turns and passes it
    // through — the independent re-run has to do the identical thing for
    // the byte-for-byte comparison to mean anything.
    const expectedLaneCheckText = renderLaneCheckerReports(
      checkLanes(secondRun.turns, secondRun.edges),
      buildLaneAnchorAddresses(secondRun.turns),
    );

    expect(body.laneCheckText).toBe(expectedLaneCheckText);
    // Pin: no bare `T<dbid>`-shaped reference survives for an in-projection
    // turn — every turn in this window carries `session_id`/`prompt_number`
    // (seeded above), so the address map resolves every one of them.
    for (const turn of secondRun.turns) {
      expect(body.laneCheckText).not.toMatch(new RegExp(`(^|[^0-9A-Za-z/])T${turn.id}\\b`));
    }
    expect(body.lanes.length).toBe(secondRun.result.lanes.length);
    expect(body.lanes.length).toBeGreaterThan(1); // non-trivial: several distinct lanes in this window

    // Every lane in the payload reports how many components its members fall
    // into, and the RETIRED lane-to-lane component id is gone from the wire.
    for (const lane of body.lanes) {
      expect(typeof lane.componentCount).toBe("number");
      expect(lane.componentCount).toBeGreaterThanOrEqual(1);
      expect(lane).not.toHaveProperty("membershipComponentId");
    }

    // Election preview: at least one turn in the response has a non-null tier
    // (the election module has real candidates over this fixture).
    expect(body.turns.some((t: any) => t.electionTier !== null)).toBe(true);
  });

  test("additive fields hold real, non-trivial values over this fixture: at least one declared terminus, every edge's laneToken null-iff-untagged, every lane token distinct, and no membership entry carries anything beyond token/isTerminus", () => {
    const reader = createConsoleReader(db);
    const result = handleGraphRoute(
      reader,
      new URL(`http://x/api/console/graph?session=${sessionId}&from=900&to=1001`),
      CTX,
    );
    const body = result.body as any;

    for (const t of body.turns) {
      expect(Array.isArray(t.type)).toBe(true);
      expect(Array.isArray(t.laneMemberships)).toBe(true);
      for (const m of t.laneMemberships) {
        expect(typeof m.token).toBe("string");
        // Over REAL data rather than a hand-built fixture: no membership entry
        // anywhere in this 100-turn projection carries a third field, and
        // neither retired boolean (ticket 04's death flag, ticket 01's
        // terminus) is anywhere on it.
        expect(Object.keys(m).sort()).toEqual(["componentId", "token"]);
      }
    }
    // Real lanes with real members must appear over this fixture, not just the
    // zero-value defaults.
    expect(body.turns.some((t: any) => t.laneMemberships.length > 0)).toBe(true);
    // THE PAYLOAD-BOUNDARY SENTINEL, over the real fixture: no key named
    // `validity`, `lastDeclarer` or `dead` survives anywhere in the response,
    // at any depth. A reintroduction under any of those three names — on a
    // lane, a turn, a membership entry or an edge — fails here.
    const keysAtEveryDepth = (value: unknown, into: Set<string>): Set<string> => {
      if (Array.isArray(value)) {
        for (const item of value) keysAtEveryDepth(item, into);
      } else if (value !== null && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          into.add(key);
          keysAtEveryDepth(child, into);
        }
      }
      return into;
    };
    const allKeys = keysAtEveryDepth(body, new Set<string>());
    expect(allKeys.has("validity")).toBe(false);
    expect(allKeys.has("lastDeclarer")).toBe(false);
    expect(allKeys.has("dead")).toBe(false);
    // lane-state-retirement ticket 01 adds four names to the same sentinel:
    // the closure verdict, the terminus and its address, and the raw
    // declaration pair. None may reappear at ANY depth of the response.
    expect(allKeys.has("closure")).toBe(false);
    expect(allKeys.has("terminus")).toBe(false);
    expect(allKeys.has("terminusAddress")).toBe(false);
    expect(allKeys.has("declarationState")).toBe(false);
    expect(allKeys.has("declarationTerminus")).toBe(false);
    expect(allKeys.has("isTerminus")).toBe(false);
    // Not vacuous: the payload really does carry lanes and memberships.
    expect(allKeys.has("memberCount")).toBe(true);
    expect(allKeys.has("laneMemberships")).toBe(true);
    // A turn carrying at least one lane membership also has that lane's
    // token present in the lanes array's own token set — the two additive
    // fields agree.
    const laneTokens = new Set(body.lanes.map((l: any) => l.token));
    expect(laneTokens.size).toBe(body.lanes.length); // every lane token distinct
    for (const t of body.turns) {
      for (const m of t.laneMemberships) {
        expect(laneTokens.has(m.token)).toBe(true);
      }
    }
    // Ticket 07: each SIDE carries its own tag and its own lane token, and a
    // token is present exactly when that side is settled.
    let settledSides = 0;
    for (const e of body.edges) {
      for (const [tag, token] of [
        [e.tailTag, e.tailLaneToken],
        [e.headTag, e.headLaneToken],
      ] as const) {
        expect(typeof tag).toBe("string");
        if (tag === "") {
          expect(token).toBeNull();
        } else {
          settledSides += 1;
          expect(typeof token).toBe("string");
          expect(laneTokens.has(token)).toBe(true);
        }
      }
    }
    // Not vacuous over this fixture — it really does contain settled sides.
    expect(settledSides).toBeGreaterThan(0);
  });

  test("the graph handler runs the projection EXACTLY once — byte-equality alone cannot catch a second derivation (peer #4), so the call count is pinned structurally", () => {
    const reader = createConsoleReader(db);
    let runs = 0;
    const counting: typeof reader = {
      ...reader,
      runLaneCheck: (scope) => {
        runs += 1;
        return reader.runLaneCheck(scope);
      },
    };
    const result = handleGraphRoute(
      counting,
      new URL(`http://x/api/console/graph?session=${sessionId}&from=900&to=1001`),
      CTX,
    );
    expect(result.status).toBe(200);
    expect(runs).toBe(1);
  });

  // [S15069/T1696]: the panel's own reason for a raw tags row — the resolved
  // lane set is a strict subset of what turns carry, and over real data most
  // of the vocabulary lives outside it.
  test("a turn ships its RAW tags, a SUPERSET of its resolved lane memberships", () => {
    const reader = createConsoleReader(db);
    const result = handleGraphRoute(
      reader,
      new URL(`http://x/api/console/graph?session=${sessionId}&from=900&to=1001`),
      CTX,
    );
    const body = result.body as any;
    const laneTagByToken = new Map<string, string>(
      body.lanes.map((l: any) => [l.token, l.tag]),
    );

    for (const turn of body.turns) {
      expect(Array.isArray(turn.tags)).toBe(true);
      // Every resolved lane membership's tag must appear in the raw column —
      // the resolution IS an intersection with it, so a membership the tags
      // do not contain would mean the two fields disagree about the same turn.
      for (const m of turn.laneMemberships) {
        expect(turn.tags).toContain(laneTagByToken.get(m.token));
      }
    }
  });

  test("two lanes sharing a member turn get DIFFERENT components — one per lane, never a merged region ([S15069/T1696])", () => {
    const reader = createConsoleReader(db);
    const result = handleGraphRoute(
      reader,
      new URL(`http://x/api/console/graph?session=${sessionId}&from=900&to=1001`),
      CTX,
    );
    const body = result.body as any;

    // The RULED definition: two member turns are connected when an edge
    // between them carries THIS lane's tag on BOTH sides. The node set never
    // leaves the lane, so a component names exactly one lane — the inverse of
    // the retired `membershipComponentId`, which unioned lanes that merely
    // shared a member and so made one region span many lanes.
    const laneTagByToken = new Map<string, string>(
      body.lanes.map((l: any) => [l.token, l.tag]),
    );
    const shared = body.turns.filter((t: any) => t.laneMemberships.length > 1);
    expect(shared.length).toBeGreaterThan(0); // non-trivial over this fixture

    for (const turn of shared) {
      const componentIds = turn.laneMemberships.map((m: any) => m.componentId);
      // One component per membership, all distinct: the turn is a member of
      // several lanes and sits in one island of EACH, never in one shared one.
      expect(new Set(componentIds).size).toBe(componentIds.length);
      for (const m of turn.laneMemberships) {
        expect(m.componentId.startsWith(m.token)).toBe(true);
      }
    }

    // Every component id names one lane and only one, across the whole payload.
    const laneTokensByComponent = new Map<string, Set<string>>();
    for (const turn of body.turns) {
      for (const m of turn.laneMemberships) {
        if (!laneTokensByComponent.has(m.componentId)) {
          laneTokensByComponent.set(m.componentId, new Set());
        }
        laneTokensByComponent.get(m.componentId)!.add(m.token);
      }
    }
    expect(laneTokensByComponent.size).toBeGreaterThan(0);
    for (const [componentId, tokens] of laneTokensByComponent) {
      expect({ componentId, lanes: tokens.size }).toEqual({ componentId, lanes: 1 });
      expect(laneTagByToken.has([...tokens][0]!)).toBe(true);
    }

    // A lane's own `componentCount` agrees with the components its members
    // actually carry — the payload's two views of the same report 2 fact.
    const componentsByToken = new Map<string, Set<string>>();
    for (const turn of body.turns) {
      for (const m of turn.laneMemberships) {
        if (!componentsByToken.has(m.token)) componentsByToken.set(m.token, new Set());
        componentsByToken.get(m.token)!.add(m.componentId);
      }
    }
    for (const lane of body.lanes) {
      const seen = componentsByToken.get(lane.token);
      if (seen) {
        expect({ tag: lane.tag, count: lane.componentCount }).toEqual({
          tag: lane.tag,
          count: seen.size,
        });
      }
    }
  });

  test("an unrecognized path UNDER /api/console/ -> 404 envelope, not null", () => {
    const reader = makeFakeReader();
    const result = routeConsoleApiRequest(
      "/api/console/nonsense",
      reader,
      new URL("http://x/api/console/nonsense"),
      CTX,
    ) as ConsoleApiResult;
    expect(result.status).toBe(404);
    expect((result.body as any).error.code).toBe("not_found");
  });

  test("dispatches each of the four known routes", () => {
    const reader = makeFakeReader({
      listSessionsPage: () => ({ sessions: [], nextCursor: null }),
      listAllSegmentCards: () => [],
      getSegmentCardDetail: () => null,
      findSession: () => null,
    });
    expect(
      (routeConsoleApiRequest("/api/console/sessions", reader, new URL("http://x/api/console/sessions"), CTX) as ConsoleApiResult).status,
    ).toBe(200);
    expect(
      (routeConsoleApiRequest("/api/console/segments", reader, new URL("http://x/api/console/segments"), CTX) as ConsoleApiResult).status,
    ).toBe(200);
    expect(
      (routeConsoleApiRequest("/api/console/segment?id=1", reader, new URL("http://x/api/console/segment?id=1"), CTX) as ConsoleApiResult).status,
    ).toBe(404);
    expect(
      (routeConsoleApiRequest("/api/console/graph", reader, new URL("http://x/api/console/graph?session=1"), CTX) as ConsoleApiResult).status,
    ).toBe(404); // findSession -> null
  });
});

// Constants sanity — pins the current values verbatim, so a future edit
// that silently drifts one of them fails a test instead of only a diff.
// GRAPH_EDGE_MAX/WIDEN_NODE_MAX/RESPONSE_BYTE_SOFT_MAX were raised by ticket
// 04 (graph-byte-priority, T1496 ruling) from ticket 01's original values
// (1000/2000/1_000_000) — everything else here is still ticket 01's own.
describe("bound constants (verbatim)", () => {
  test("values", () => {
    expect(SESSIONS_PAGE_MAX).toBe(50);
    expect(GRAPH_WINDOW_DEFAULT).toBe(50);
    expect(GRAPH_WINDOW_MAX).toBe(2000);
    expect(EXCERPT_PROMPT_CP).toBe(280);
    expect(EXCERPT_CONTENT_CP).toBe(280);
    expect(GRAPH_EDGE_MAX).toBe(10_000);
    expect(WIDEN_NODE_MAX).toBe(10_000);
    expect(RESPONSE_BYTE_SOFT_MAX).toBe(8_000_000);
    expect(ELECTION_PREVIEW_BUDGET).toBe(30);
  });
});

// [S15069/T1557] ruling — ticket 10 "one address grammar": ONE turn address,
// `S<session>/T<prompt>`, on EVERY render and under EVERY scope. A segment is
// a SCOPE in front of it (`meta.scope`'s own `E<segmentId>`), never a second
// address namespace of its own. Supersedes T1524 (segment-scoped roster
// ordinal) and T1532 (segment-scoped global id) alike — both made
// `E<n>/T<m>` mean a turn's own address, which is exactly what let the same
// string resolve to different turns depending on where it was pasted.
// `segment` on a lane-check turn is the stringified segment id (db/lane-
// checker-load.ts `segmentKeyFor`), which is what these fixtures use — not
// the "E1" shorthand the older hand-built fixtures above happen to carry.
describe("GET /api/console/graph — turn address form", () => {
  function threeTurnRun(): ConsoleLaneCheckRun {
    return emptyLaneCheckRun({
      turns: [
        { id: 10, type: ["design"], order: [1, 4], segment: "7" },
        { id: 20, type: ["ops"], order: [2, 9], segment: "9" },
        { id: 30, type: ["review"], order: [1, 6], segment: "7" },
      ],
      edges: [],
    });
  }
  const displayFields = new Map<number, ConsoleTurnDisplayFields>([
    [10, { sessionId: 1, promptNumber: 4, title: "a", userPrompt: null, content: null }],
    [20, { sessionId: 2, promptNumber: 9, title: "b", userPrompt: null, content: null }],
    [30, { sessionId: 1, promptNumber: 6, title: "c", userPrompt: null, content: null }],
  ]);
  const segmentReader = () =>
    makeFakeReader({
      findSegment: () => ({ id: 7 }) as any,
      runLaneCheck: () => threeTurnRun(),
      loadTurnDisplayFields: () => displayFields,
    });

  test("a segment scope still addresses every member — and every foreign turn — as S<session>/T<prompt>, never E<segment>/T<k>", () => {
    const body = handleGraphRoute(segmentReader(), new URL("http://x/api/console/graph?segment=7"), CTX).body as any;
    const addressById = new Map(body.turns.map((t: any) => [t.id, t.address]));
    expect(addressById.get(10)).toBe("S1/T4");
    expect(addressById.get(30)).toBe("S1/T6");
    // turn 20 belongs to a DIFFERENT segment (9) — under the old segment-
    // ordinal grammar this was the ONE turn that kept S/T while its segment-7
    // neighbours read E7/T*; now every turn reads the same grammar regardless
    // of segment membership, so this assertion no longer distinguishes it.
    expect(addressById.get(20)).toBe("S2/T9");
  });

  test("the interval endpoints are the very addresses their rows carry", () => {
    const body = handleGraphRoute(segmentReader(), new URL("http://x/api/console/graph?segment=7"), CTX).body as any;
    expect(body.meta.interval.fromAddress).toBe("S1/T4");
    expect(body.meta.interval.toAddress).toBe(body.turns[body.turns.length - 1].address);
  });

  test("a session scope keeps S<session>/T<prompt> — the prompt number IS the reader's ordering key there", () => {
    const reader = makeFakeReader({
      findSession: () => ({ id: 1 }) as any,
      runLaneCheck: () => threeTurnRun(),
      loadTurnDisplayFields: () => displayFields,
    });
    const body = handleGraphRoute(reader, new URL("http://x/api/console/graph?session=1&from=1&to=99"), CTX).body as any;
    expect(body.turns.map((t: any) => t.address)).toEqual(["S1/T4", "S2/T9", "S1/T6"]);
  });
});
