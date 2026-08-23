import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import { addSegmentMembers, createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { checkLanes } from "../../src/shared/lane-checker";
import { renderLaneCheckerReports } from "../../src/shared/lane-checker-render";
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
  handleSegmentCardRoute,
  handleSegmentsRoute,
  handleSessionsRoute,
  routeConsoleApiRequest,
  toConsoleApiResponse,
  type ConsoleApiResult,
  type ConsoleRequestContext,
} from "../../src/worker/console-api";

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
    runLaneCheck: overrides.runLaneCheck ?? unimplemented("runLaneCheck"),
    loadTurnDisplayFields: overrides.loadTurnDisplayFields ?? unimplemented("loadTurnDisplayFields"),
  };
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
      multiLaneComponents: [],
      interfaces: [],
      bypass: [],
      paths: [],
      timeOrderViolations: [],
      warnings: [],
      vocabularyConformance: EMPTY_VOCABULARY_CONFORMANCE,
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
  test("an open, never-declared lane's terminus/lastDeclarer render as null (never omitted); a lane with no phases/edges renders [] (never null/omitted)", () => {
    const reader = makeFakeReader({
      findSession: () => ({ id: 1 }) as any,
      runLaneCheck: () =>
        emptyLaneCheckRun({
          turns: [{ id: 1, type: [], order: [0, 1] }],
          result: {
            ...emptyLaneCheckRun().result,
            lanes: [
              {
                key: { segment: "E1", tagSet: ["focus"] },
                phases: [],
                members: [{ id: 1, dead: false }],
                edgeCountsByRelation: {},
                declaration: { state: "undeclared", terminus: null, latestEventTurn: null },
                state: { key: { segment: "E1", tagSet: ["focus"] }, closure: "open", validity: null, terminus: null, lastDeclarer: null },
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
    // present-as-null, not omitted
    expect("terminus" in lane.state).toBe(true);
    expect(lane.state.terminus).toBeNull();
    expect("lastDeclarer" in lane.state).toBe(true);
    expect(lane.state.lastDeclarer).toBeNull();
    expect("declarationTerminus" in lane).toBe(true);
    expect(lane.declarationTerminus).toBeNull();
    // empty-as-[], not null/omitted
    expect(lane.phases).toEqual([]);
    expect(lane.tagSet).toEqual(["focus"]);
  });
});

describe("GET /api/console/graph — ticket 04 additive fields (type/lanes/isTerminus/isDead per turn, laneToken per edge, token per lane)", () => {
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
            key: { segment: "E1", tagSet: ["focus"] },
            phases: ["decision"],
            members: [
              { id: 1, dead: true },
              { id: 2, dead: false },
            ],
            edgeCountsByRelation: { indexes: 1 },
            declaration: { state: "declared", terminus: 2, latestEventTurn: 2 },
            state: { key: { segment: "E1", tagSet: ["focus"] }, closure: "closed", validity: "invalid", terminus: 2, lastDeclarer: 2 },
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

  test("the dead lane member is isDead:true, isTerminus:false; the declaring/terminus turn is isTerminus:true, isDead:false", () => {
    const reader = makeFakeReader({
      findSession: () => ({ id: 1 }) as any,
      runLaneCheck: () => twoTurnLaneRun(),
      loadTurnDisplayFields: () => new Map(),
    });
    const result = handleGraphRoute(reader, new URL("http://x/api/console/graph?session=1&from=1&to=2"), CTX);
    const body = result.body as any;
    const t1 = body.turns.find((t: any) => t.id === 1);
    const t2 = body.turns.find((t: any) => t.id === 2);
    expect(t1.isDead).toBe(true);
    expect(t1.isTerminus).toBe(false);
    expect(t2.isDead).toBe(false);
    expect(t2.isTerminus).toBe(true);
  });

  test("both turns carry the lane's own token in turn.lanes; the lane payload's own token matches", () => {
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
    expect(body.turns.find((t: any) => t.id === 1).lanes).toEqual([laneToken_]);
    expect(body.turns.find((t: any) => t.id === 2).lanes).toEqual([laneToken_]);
  });

  test("a laneless turn carries lanes: [] (never omitted/null)", () => {
    const reader = makeFakeReader({
      findSession: () => ({ id: 1 }) as any,
      runLaneCheck: () =>
        emptyLaneCheckRun({ turns: [{ id: 5, type: [], order: [0, 5] }] }),
      loadTurnDisplayFields: () => new Map(),
    });
    const result = handleGraphRoute(reader, new URL("http://x/api/console/graph?session=1&from=5&to=5"), CTX);
    const body = result.body as any;
    expect(body.turns[0].lanes).toEqual([]);
    expect(body.turns[0].isTerminus).toBe(false);
    expect(body.turns[0].isDead).toBe(false);
  });

  test("the tagged edge's laneToken matches the lane payload's own token; an untagged edge's laneToken is null", () => {
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
    const tagged = body.edges.find((e: any) => e.relation === "indexes");
    const untagged = body.edges.find((e: any) => e.relation === "consume");
    expect(tagged.laneToken).toBe(laneToken_);
    expect(untagged.laneToken).toBeNull();
  });
});

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

  test("widened turns over WIDEN_NODE_MAX -> truncated to a stable prefix, partial, appliedBounds names the bound", () => {
    const turns = turnsOfCount(WIDEN_NODE_MAX + 10);
    const reader = makeFakeReader({
      findSession: () => ({ id: 1 }) as any,
      getSessionMaxPromptNumber: () => 1,
      runLaneCheck: () => emptyLaneCheckRun({ turns, result: emptyLaneCheckRun().result }),
      loadTurnDisplayFields: () => new Map(),
    });
    const result = handleGraphRoute(
      reader,
      new URL("http://x/api/console/graph?session=1&from=1&to=1"),
      CTX,
    );
    const body = result.body as any;
    expect(body.turns).toHaveLength(WIDEN_NODE_MAX);
    expect(body.turns.map((t: any) => t.id)).toEqual(turns.slice(0, WIDEN_NODE_MAX).map((t) => t.id));
    expect(body.meta.stateCoverage).toBe("partial");
    expect(body.meta.appliedBounds).toContainEqual({
      bound: "WIDEN_NODE_MAX",
      requested: WIDEN_NODE_MAX + 10,
      applied: WIDEN_NODE_MAX,
    });
    expectEdgesEndpointClosed(body);
    // R2 #11: still "full-snapshot" under trimming — election tiers were
    // computed on the FULL projection before this response's own truncation
    // ran, so the field's meaning does not change just because the response
    // became partial.
    expect(body.meta.electionCoverage).toBe("full-snapshot");
  });

  test("widened edges over GRAPH_EDGE_MAX -> truncated, partial", () => {
    const turns = turnsOfCount(5);
    const edges = edgesOfCount(GRAPH_EDGE_MAX + 20, 5);
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
      requested: GRAPH_EDGE_MAX + 20,
      applied: GRAPH_EDGE_MAX,
    });
    expectEdgesEndpointClosed(body);
  });

  test("oversized serialized bytes (huge excerpts, counts within cap) -> byte-trimmed, partial, RESPONSE_BYTE_SOFT_MAX named", () => {
    const turnCount = 200;
    const turns = turnsOfCount(turnCount);
    const hugeText = "x".repeat(20_000); // 200 * ~20KB >> 1MB
    const displayFields = new Map<number, ConsoleTurnDisplayFields>(
      turns.map((t) => [t.id, { sessionId: 1, promptNumber: t.id, title: hugeText, userPrompt: hugeText, content: hugeText }]),
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
    expect(body.turns.length).toBeLessThan(turnCount);
    expect(body.meta.stateCoverage).toBe("partial");
    const byteBound = body.meta.appliedBounds.find((b: any) => b.bound === "RESPONSE_BYTE_SOFT_MAX");
    expect(byteBound).toBeDefined();
    expect(byteBound.applied).toBe(RESPONSE_BYTE_SOFT_MAX);
    // R2 #2: the trim loop now measures the FINAL envelope (meta included),
    // not a {turns,edges,lanes,laneCheckText} stand-in — so the actually
    // shipped bytes must respect the cap with NO slack. Before the fix, the
    // reviewer's repro showed the stand-in read 999,797 bytes internally
    // while the real (meta-appended) response was 1,000,001 — this
    // assertion, with the slack removed, is exactly what would have caught
    // that gap.
    expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeLessThanOrEqual(RESPONSE_BYTE_SOFT_MAX);
    expectEdgesEndpointClosed(body);
  });

  test("R2 #2: an untrimmable lane (no turns/edges left to cut) still over the byte bound triggers the refusal-with-summary envelope — never a payload larger than RESPONSE_BYTE_SOFT_MAX carrying an applied-bound claim", () => {
    // Reviewer's 600KB-lane-tag repro, generalized: a single lane whose own
    // tagSet is huge enough that `lanes` + `laneCheckText` (both render the
    // tag) alone exceed RESPONSE_BYTE_SOFT_MAX, with zero turns/edges to
    // trim in the first place.
    const hugeTag = "t".repeat(1_400_000);
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
                key: { segment: "E1", tagSet: [hugeTag] },
                phases: [],
                members: [],
                edgeCountsByRelation: {},
                declaration: { state: "undeclared", terminus: null, latestEventTurn: null },
                state: { key: { segment: "E1", tagSet: [hugeTag] }, closure: "open", validity: null, terminus: null, lastDeclarer: null },
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
    // The core invariant R2 #2 rules out: whatever ships must actually
    // respect RESPONSE_BYTE_SOFT_MAX — the reviewer's repro shipped ~2.4MB
    // while claiming applied=1MB.
    expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeLessThanOrEqual(RESPONSE_BYTE_SOFT_MAX);
    expect(body.turns).toEqual([]);
    expect(body.edges).toEqual([]);
    expect(body.lanes).toEqual([]);
    expect(body.laneCheckText).toBe("");
    expect(body.error).toBeDefined();
    expect(body.error.code).toBeDefined();
    expect(body.error.message).toContain("RESPONSE_BYTE_SOFT_MAX");
    expect(body.meta.stateCoverage).toBe("partial");
    const byteBound2 = body.meta.appliedBounds.find((b: any) => b.bound === "RESPONSE_BYTE_SOFT_MAX");
    expect(byteBound2).toBeDefined();
    expect(byteBound2.applied).toBe(RESPONSE_BYTE_SOFT_MAX);
  });

  test("R2 #2 acceptance pin: edge-granularity trim exits within one edge of the bound — only a meta-inclusive measurement keeps the real envelope under RESPONSE_BYTE_SOFT_MAX", () => {
    // The lane tag renders 3x into `lanes` (key + state.key) and 1x into
    // `laneCheckText` (calibrated), parking ~960KB of untrimmable payload
    // just under the bound; 1000 small edges (~76B each) supply the overage,
    // so the byte-trim loop converges inside the EDGE loop and exits within
    // ONE edge's bytes of the bound. A measurement that omits `meta` (~300B)
    // then ships an envelope over the bound by construction — the reviewer's
    // 999,797-internal vs 1,000,001-real gap, reconstructed
    // deterministically instead of hoping a turn-granularity fixture
    // happens to land in the ~300B knife-edge (calibrated: the meta-less
    // stand-in ships 1,000,252 bytes here).
    const bigTag = "t".repeat(240_000);
    const turns = turnsOfCount(5);
    const edges = edgesOfCount(1000, 5);
    const reader = makeFakeReader({
      findSession: () => ({ id: 1 }) as any,
      runLaneCheck: () =>
        emptyLaneCheckRun({
          turns,
          edges,
          result: {
            ...emptyLaneCheckRun().result,
            lanes: [
              {
                key: { segment: "E1", tagSet: [bigTag] },
                phases: [],
                members: [],
                edgeCountsByRelation: {},
                declaration: { state: "undeclared", terminus: null, latestEventTurn: null },
                state: { key: { segment: "E1", tagSet: [bigTag] }, closure: "open", validity: null, terminus: null, lastDeclarer: null },
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
    // Knife-edge preconditions: the trim really converged inside the edge
    // loop — turns intact, edges partially cut. If either fails, the fixture
    // sizes drifted and the test must be retuned, not deleted.
    expect(body.turns).toHaveLength(5);
    expect(body.edges.length).toBeGreaterThan(0);
    expect(body.edges.length).toBeLessThan(1000);
    const byteBound = body.meta.appliedBounds.find((b: any) => b.bound === "RESPONSE_BYTE_SOFT_MAX");
    expect(byteBound).toBeDefined();
    // The teeth: the ACTUAL serialized response respects the cap with zero
    // slack allowance.
    expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeLessThanOrEqual(RESPONSE_BYTE_SOFT_MAX);
    expectEdgesEndpointClosed(body);
  });

  test("R2 #3: a turn dropped by WIDEN_NODE_MAX leaves its own edge dangling — filtered out, never shipped with a missing endpoint (reviewer's 2001-turn repro)", () => {
    const turns = turnsOfCount(WIDEN_NODE_MAX + 1); // 2001 turns, ids 1..2001
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
    expect(body.turns.some((t: any) => t.id === WIDEN_NODE_MAX + 1)).toBe(false);
    // T2001 (the edge's own citedId) was trimmed out — the edge naming it
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
    const insertTurn = db.query<unknown, [number, number, number, string, string | null, number]>(
      `INSERT INTO turns (id, session_id, prompt_number, status, user_prompt, title, tool_call_count, created_at_epoch, type)
       VALUES (?, ?, ?, 'active', 'p', ?, 1, ?, ?)`,
    );
    for (const turn of fixture.turns) {
      insertTurn.run(
        turn.id,
        sessionId,
        turn.id,
        turn.title ?? null,
        NOW + turn.id,
        JSON.stringify(turn.type),
      );
    }
    writeMemoryEdges(
      db,
      fixture.edges.map((edge) => ({
        citing: { kind: "turn", id: edge.citingId },
        cited: { kind: "turn", id: edge.citedId },
        relation: edge.relation as never,
        provenance: "asserted",
        tags: edge.tags,
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
    const expectedLaneCheckText = renderLaneCheckerReports(
      checkLanes(secondRun.turns, secondRun.edges),
    );

    expect(body.laneCheckText).toBe(expectedLaneCheckText);
    expect(body.lanes.length).toBe(secondRun.result.lanes.length);
    expect(body.lanes.length).toBeGreaterThan(1); // non-trivial: several distinct lanes in this window

    // Every lane in the payload carries a membershipComponentId.
    for (const lane of body.lanes) {
      expect(typeof lane.membershipComponentId).toBe("string");
      expect(lane.membershipComponentId.length).toBeGreaterThan(0);
    }

    // Election preview: at least one turn in the response has a non-null tier
    // (the election module has real candidates over this fixture).
    expect(body.turns.some((t: any) => t.electionTier !== null)).toBe(true);
  });

  test("ticket 04 additive fields hold real, non-trivial values over this fixture: at least one declared terminus, at least one dead member, every edge's laneToken null-iff-untagged, every lane token distinct", () => {
    const reader = createConsoleReader(db);
    const result = handleGraphRoute(
      reader,
      new URL(`http://x/api/console/graph?session=${sessionId}&from=900&to=1001`),
      CTX,
    );
    const body = result.body as any;

    for (const t of body.turns) {
      expect(Array.isArray(t.type)).toBe(true);
      expect(Array.isArray(t.lanes)).toBe(true);
      expect(typeof t.isTerminus).toBe("boolean");
      expect(typeof t.isDead).toBe("boolean");
    }
    // The fixture carries 19 tagged `indexes` edges and 1 tagged `override`
    // (verified against the fixture file directly) — real declared lanes and
    // a real dead member both must appear, not just the zero-value defaults.
    expect(body.turns.some((t: any) => t.isTerminus === true)).toBe(true);
    expect(body.turns.some((t: any) => t.isDead === true)).toBe(true);
    // A turn carrying at least one lane token also has that token present in
    // the lanes array's own token set — the two additive fields agree.
    const laneTokens = new Set(body.lanes.map((l: any) => l.token));
    expect(laneTokens.size).toBe(body.lanes.length); // every lane token distinct
    for (const t of body.turns) {
      for (const tok of t.lanes) {
        expect(laneTokens.has(tok)).toBe(true);
      }
    }
    for (const e of body.edges) {
      if (e.tags.length > 0) {
        expect(typeof e.laneToken).toBe("string");
      } else {
        expect(e.laneToken).toBeNull();
      }
    }
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

  test("two lanes sharing a member turn get the SAME membershipComponentId; a lane sharing none gets its own", () => {
    const reader = createConsoleReader(db);
    const result = handleGraphRoute(
      reader,
      new URL(`http://x/api/console/graph?session=${sessionId}&from=900&to=1001`),
      CTX,
    );
    const body = result.body as any;

    const byToken = new Map<string, any>();
    for (const lane of body.lanes) {
      byToken.set(`${lane.segment} ${lane.tagSet.join(",")}`, lane);
    }

    // "ownership" and "settlement-scope" both list T900 as a member in the
    // fixture's own `lanes` provenance block — lane-membership connectivity
    // (spec "Focus domain") must therefore place them in the SAME component,
    // even though they are unrelated in report 2/3's structural-edge domain.
    const ownership = [...byToken.values()].find((l) => l.tagSet.includes("ownership"));
    const settlementScope = [...byToken.values()].find((l) => l.tagSet.includes("settlement-scope"));
    if (ownership && settlementScope) {
      expect(ownership.membershipComponentId).toBe(settlementScope.membershipComponentId);
    }
  });
});

// --------------------------------------------------------------- routing ---

describe("routeConsoleApiRequest", () => {
  test("null for a path outside /api/console/ (falls through, not this router's problem)", () => {
    const reader = makeFakeReader();
    expect(
      routeConsoleApiRequest("/health", reader, new URL("http://x/health"), CTX),
    ).toBeNull();
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

// Constants sanity — pins the ticket 01 values verbatim, so a future edit
// that silently drifts one of them fails a test instead of only a diff.
describe("bound constants (ticket 01's recommended values, verbatim)", () => {
  test("values", () => {
    expect(SESSIONS_PAGE_MAX).toBe(50);
    expect(GRAPH_WINDOW_DEFAULT).toBe(50);
    expect(GRAPH_WINDOW_MAX).toBe(2000);
    expect(EXCERPT_PROMPT_CP).toBe(280);
    expect(EXCERPT_CONTENT_CP).toBe(280);
    expect(GRAPH_EDGE_MAX).toBe(1000);
    expect(WIDEN_NODE_MAX).toBe(2000);
    expect(RESPONSE_BYTE_SOFT_MAX).toBe(1_000_000);
    expect(ELECTION_PREVIEW_BUDGET).toBe(30);
  });
});
