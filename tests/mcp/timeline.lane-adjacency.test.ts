import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { insertLane } from "../../src/db/lanes";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import { wordEdgeClass } from "../support/edge-row-fixtures";
import { initializeSchema } from "../../src/db/schema";
import {
  addSegmentMembers,
  createSegment,
  type SegmentRecord,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { buildSegmentLaneListView, timelineQuery } from "../../src/mcp/timeline";
import { countTokens } from "../../src/shared/token-count";

/**
 * The lane view's ruled adjacency table (frontier-injection spec Rev 5,
 * ticket 04) — seam 2 of the spec's Testing Decisions: timeline MCP output
 * assertions over seeded corpora. Tests assert output strings and COUNT MAPS
 * (the forward and mirror multisets, parsed back OUT of the rendered page),
 * never walk internals.
 *
 * SETTLED always means settlement COVERAGE (a committed
 * `note_settlement_jobs` window), seeded by `settleWindow`, never inferred
 * from edges. Ticket 02's adjudicated readings are law here: (a) a valid
 * edge has BOTH lane tags settled and BOTH endpoints canonical; (b) an
 * address that cannot be qualified is skipped where a qualified form is
 * mandated.
 */

const BASE_EPOCH = 1_756_500_000;

function makeDb(): Database {
  const db = createDatabase(":memory:");
  initializeSchema(db);
  return db;
}

function makeSession(db: Database, contentSessionId: string): number {
  return upsertSession(db, {
    contentSessionId,
    project: "/projects/lane-adjacency",
    title: `Session ${contentSessionId}`,
    insight: null,
    createdAtEpoch: BASE_EPOCH,
    updatedAtEpoch: null,
    completedAtEpoch: null,
  }).id;
}

function makeTask(db: Database, title: string, tag: string): SegmentRecord {
  return createSegment(db, { title, tags: [tag], nowEpoch: BASE_EPOCH });
}

interface TurnSpec {
  prompt: number;
  epoch: number;
  title?: string;
  types?: string[];
  tags?: string[];
  status?: string;
  rolledBack?: boolean;
}

function makeTurn(db: Database, sessionId: number, spec: TurnSpec): number {
  return db
    .query<
      { id: number },
      [number, number, string, string, string, string, number, number]
    >(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         title, type, tags, created_at_epoch, was_rolled_back
       ) VALUES (?, ?, ?, 'asked', 'answered', ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .get(
      sessionId,
      spec.prompt,
      spec.status ?? "extracted",
      spec.title ?? "adjacency row",
      JSON.stringify(spec.types ?? ["design"]),
      JSON.stringify(spec.tags ?? []),
      spec.epoch,
      spec.rolledBack ? 1 : 0,
    )!.id;
}

/** The settled truth: one COMMITTED (`done`) settlement window. */
function settleWindow(
  db: Database,
  sessionId: number,
  windowStart: number,
  windowEnd: number,
): void {
  db.query(
    `INSERT INTO note_settlement_jobs (
       session_id, window_start, window_end, trigger_type,
       status, attempts, retry_at_epoch, created_at_epoch, updated_at_epoch
     ) VALUES (?, ?, ?, 'consecutive', 'done', 1, 0, ?, ?)`,
  ).run(sessionId, windowStart, windowEnd, BASE_EPOCH, BASE_EPOCH);
}

function makeEdge(
  db: Database,
  citingTurnId: number,
  citedTurnId: number,
  relation: string,
  tailTag: string,
  headTag: string,
): void {
  writeMemoryEdges(
    db,
    [
      {
        citing: { kind: "turn", id: citingTurnId },
        cited: { kind: "turn", id: citedTurnId },
        ...wordEdgeClass(relation),
        provenance: "judged",
        tailTag,
        headTag,
      },
    ],
    BASE_EPOCH,
  );
}

// `makeLegacyEdgeRow` IS DELETED (main-agent-edges ticket 01): it seeded a
// SECOND physical row on a pair that already had one. The cutover folded that
// stock and rebuilt `memory_edges` UNIQUE on `(citing, cited)`, so the shape
// cannot be read any more and the readers below have one row per pair to
// render. The two fixture rows it wrote (a6 -correct(partial)-> a1 beside a6
// -correct(full)-> a1, and b1 -use-> a6 beside b1 -correct(full)-> a6) are gone with
// it; each pair keeps its more specific class, which is what the fold itself
// would have left.

/** One lane's page text via the single-lane canonical address (page 1/1 in this ticket's single-page scope). */
function renderLane(db: Database, segmentId: number, tag: string, pageBudget?: number): string {
  const view = buildSegmentLaneListView(
    db,
    segmentId,
    { tag },
    1,
    pageBudget ?? 1000,
  );
  expect(view.lanes).toHaveLength(1);
  return view.lanes[0]!.lines.join("\n");
}

// ---------------------------------------------------------------------------
// The multiset parser — reads the count maps back OUT of the rendered page
// (the spec's mutation-probe properties), never out of any internal structure.
// ---------------------------------------------------------------------------

/** Multiset key: tail S/T · head S/T · relation · qualified tailTag · qualified headTag. */
function forwardKey(
  tail: string,
  head: string,
  relation: string,
  tailLane: string,
  headLane: string,
): string {
  return [tail, head, relation, tailLane, headLane].join("|");
}

interface ParsedLanePage {
  header: {
    lane: string;
    settled: number;
    forward: number;
    mirrors: number;
    /** `p/N` + turn range — present only on a paged lane (ticket 05). */
    page: number | null;
    pageCount: number | null;
    range: { newest: string; oldest: string } | null;
    islands: number;
    singletons: number;
    frontier: number;
    /** The `[overflow +<n> tok]` marker's stated count, when present. */
    overflow: number | null;
  };
  /** Forward multiset: every rendered forward element, keyed by `forwardKey`. */
  forwards: Map<string, number>;
  /** Cross-page pointer stubs only: `forwardKey` -> the rendered `p/N` (the TARGET's page). */
  forwardPointers: Map<string, string>;
  /** Mirror multiset: `source S/T|relation|qualifier|head S/T`, one entry per FOLDED-OUT source address — qualifier is the source lane (`<=`) or the source's `p/N` page pointer (`<-`). */
  mirrors: Map<string, number>;
  skeleton: string[];
  titleRows: string[];
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function parseLanePage(text: string): ParsedLanePage {
  const lines = text.split("\n");
  const headerMatch = lines[0]!.match(
    /^(E\d+\/#[\w-]+) · (\d+) settled · (\d+) forward · (\d+) mirrors(?: · (\d+)\/(\d+) (S\d+\/T\d+)\.\.(S\d+\/T\d+))? · islands (\d+)\+(\d+) · frontier (\d+)(?: \[overflow \+(\d+) tok\])?$/,
  );
  expect(headerMatch).not.toBeNull();
  const header = {
    lane: headerMatch![1]!,
    settled: Number(headerMatch![2]),
    forward: Number(headerMatch![3]),
    mirrors: Number(headerMatch![4]),
    page: headerMatch![5] !== undefined ? Number(headerMatch![5]) : null,
    pageCount: headerMatch![6] !== undefined ? Number(headerMatch![6]) : null,
    range:
      headerMatch![7] !== undefined
        ? { newest: headerMatch![7]!, oldest: headerMatch![8]! }
        : null,
    islands: Number(headerMatch![9]),
    singletons: Number(headerMatch![10]),
    frontier: Number(headerMatch![11]),
    overflow: headerMatch![12] !== undefined ? Number(headerMatch![12]) : null,
  };
  expect(lines[1]).toBe(
    "arrows: -> in-lane · => cross-lane out · <= cross-lane in · <- cross-page in",
  );

  const skeleton: string[] = [];
  let index = 2;
  for (; index < lines.length && lines[index] !== ""; index += 1) {
    skeleton.push(lines[index]!);
  }
  const titleRows = lines.slice(index + 1).filter((line) => line !== "");

  const forwards = new Map<string, number>();
  const forwardPointers = new Map<string, string>();
  const mirrors = new Map<string, number>();
  const laneQualified = header.lane;

  /** One chain-element run: `<relation> -> addr[^[ (p/N)]]` / `<relation> => S/T^(E/#tag)`, tail = the previous rendered address. */
  const parseChain = (
    rest: string,
    anchor: { address: string; sessionId: number },
    foldSession: number | null,
  ): void => {
    const tokens = rest.split(" ");
    let tail = anchor.address;
    let session = foldSession;
    for (let cursor = 0; cursor < tokens.length; ) {
      const relation = tokens[cursor]!;
      const arrow = tokens[cursor + 1]!;
      const rawAddress = tokens[cursor + 2]!;
      if (arrow === "=>") {
        const cross = rawAddress.match(/^S(\d+)\/T(\d+)\^\(E(\d+)\/#([\w-]+)\)$/);
        expect(cross).not.toBeNull();
        bump(
          forwards,
          forwardKey(
            tail,
            `S${cross![1]}/T${cross![2]}`,
            relation,
            laneQualified,
            `E${cross![3]}/#${cross![4]}`,
          ),
        );
        // A cross-lane stub is terminal — nothing may follow it on the line.
        expect(cursor + 3).toBe(tokens.length);
        break;
      }
      expect(arrow).toBe("->");
      const pointerToken = tokens[cursor + 3];
      if (pointerToken !== undefined && pointerToken.startsWith("(")) {
        // Cross-page pointer stub: full-form address, `^`, then ` (p/N)` —
        // the TARGET's page. Terminal on its line.
        const stub = rawAddress.match(/^S(\d+)\/T(\d+)\^$/);
        expect(stub).not.toBeNull();
        const pointer = pointerToken.match(/^\((\d+)\/(\d+)\)$/);
        expect(pointer).not.toBeNull();
        const key = forwardKey(
          tail,
          `S${stub![1]}/T${stub![2]}`,
          relation,
          laneQualified,
          laneQualified,
        );
        bump(forwards, key);
        forwardPointers.set(key, `${pointer![1]}/${pointer![2]}`);
        expect(cursor + 4).toBe(tokens.length);
        break;
      }
      const inLane = rawAddress.match(/^(?:S(\d+)\/)?T(\d+)(\^)?$/);
      expect(inLane).not.toBeNull();
      const headSession = inLane![1] !== undefined ? Number(inLane![1]) : session;
      expect(headSession).not.toBeNull();
      const head = `S${headSession}/T${inLane![2]}`;
      bump(forwards, forwardKey(tail, head, relation, laneQualified, laneQualified));
      if (inLane![3] === "^") {
        // A `^` stub is terminal on its line.
        expect(cursor + 3).toBe(tokens.length);
        break;
      }
      tail = head;
      session = headSession!;
      cursor += 3;
    }
  };

  let root: { address: string; sessionId: number } | null = null;
  for (const line of skeleton) {
    if (line.startsWith("└ ")) {
      expect(root).not.toBeNull();
      const rest = line.slice("└ ".length);
      // The relation token is a CLASS token since the cutover — `use`,
      // `verify`, `correct(full)`, `correct(partial)` — so the bare `[a-z]+`
      // this used to accept would not match a coverage-bearing correction.
      const mirror = rest.match(/^([a-z]+(?:\([a-z]+\))?) (<-|<=) (.+)$/);
      if (mirror) {
        for (const source of mirror[3]!.split(", ")) {
          if (mirror[2] === "<=") {
            const parsed = source.match(/^S(\d+)\/T(\d+)\^\(E(\d+)\/#([\w-]+)\)$/);
            expect(parsed).not.toBeNull();
            bump(
              mirrors,
              [
                `S${parsed![1]}/T${parsed![2]}`,
                mirror[1]!,
                `E${parsed![3]}/#${parsed![4]}`,
                root!.address,
              ].join("|"),
            );
            continue;
          }
          // Same-lane cross-page mirror: the source keeps its own page
          // pointer — the SOURCE's page, recoverable per folded source.
          const parsed = source.match(/^S(\d+)\/T(\d+)\^ \((\d+)\/(\d+)\)$/);
          expect(parsed).not.toBeNull();
          bump(
            mirrors,
            [
              `S${parsed![1]}/T${parsed![2]}`,
              mirror[1]!,
              `${parsed![3]}/${parsed![4]}`,
              root!.address,
            ].join("|"),
          );
        }
        continue;
      }
      parseChain(rest, root!, null);
      continue;
    }
    const rootMatch = line.match(/^S(\d+)\/T(\d+)(?: (.*))?$/);
    expect(rootMatch).not.toBeNull();
    root = {
      address: `S${rootMatch![1]}/T${rootMatch![2]}`,
      sessionId: Number(rootMatch![1]),
    };
    if (rootMatch![3] !== undefined) {
      parseChain(rootMatch![3]!, root, root.sessionId);
    }
  }

  return { header, forwards, forwardPointers, mirrors, skeleton, titleRows };
}

// ---------------------------------------------------------------------------
// The rich mixed corpus most contracts are checked against: fork, secondary
// continuation, multi-relation pair, cross-lane forward, cross-lane inbound
// mirrors (folding pair included), a settled singleton, frontier members,
// and a same-prompt-number second session.
// ---------------------------------------------------------------------------

function seedRichWorld(db: Database) {
  const s1 = makeSession(db, "rich-session-one");
  const s2 = makeSession(db, "rich-session-two");
  const taskA = makeTask(db, "Task A", "task-a");
  const taskB = makeTask(db, "Task B", "task-b");
  insertLane(db, taskA.id, "auth", BASE_EPOCH);
  insertLane(db, taskA.id, "infra", BASE_EPOCH);
  insertLane(db, taskB.id, "legal", BASE_EPOCH);

  // task A / #auth members (event order): a1..a6 in S1, b1 in S2 (same
  // prompt number as a2 — the two-sessions fixture), singleton a4.
  const a1 = makeTurn(db, s1, { prompt: 1, epoch: BASE_EPOCH + 100, title: "auth base", tags: ["auth"] });
  const a2 = makeTurn(db, s1, { prompt: 2, epoch: BASE_EPOCH + 200, title: "auth narrows", tags: ["auth"] });
  const a3 = makeTurn(db, s1, { prompt: 3, epoch: BASE_EPOCH + 300, title: "auth verify", tags: ["auth"] });
  const a4 = makeTurn(db, s1, { prompt: 4, epoch: BASE_EPOCH + 400, title: "auth singleton", tags: ["auth"] });
  const infra = makeTurn(db, s1, { prompt: 5, epoch: BASE_EPOCH + 500, title: "infra target", tags: ["infra"] });
  const a6 = makeTurn(db, s1, { prompt: 6, epoch: BASE_EPOCH + 600, title: "auth ruling", tags: ["auth"] });
  const b1 = makeTurn(db, s2, { prompt: 2, epoch: BASE_EPOCH + 700, title: "legal corrector", tags: ["legal"] });
  const frontier = makeTurn(db, s1, { prompt: 9, epoch: BASE_EPOCH + 900, title: "auth frontier", tags: ["auth"] });
  addSegmentMembers(db, taskA.id, [a1, a2, a3, a4, infra, a6], BASE_EPOCH);
  addSegmentMembers(db, taskA.id, [frontier], BASE_EPOCH);
  addSegmentMembers(db, taskB.id, [b1], BASE_EPOCH);
  settleWindow(db, s1, 1, 6); // frontier (prompt 9) stays UNsettled
  settleWindow(db, s2, 2, 2);

  // Forward edges in #auth:
  //   a6 -correct(full)-> a1   (heaviest: main line)
  //   a6 -use-> a3    (secondary branch, continues through a3)
  //   a3 -use-> a2    (a3 is single-out: the continuation the branch takes)
  //   a2 -use-> infra (cross-lane forward stub)
  makeEdge(db, a6, a1, "override", "auth", "auth");
  makeEdge(db, a6, a3, "extends", "auth", "auth");
  makeEdge(db, a3, a2, "grounds", "auth", "auth");
  makeEdge(db, a2, infra, "extends", "auth", "infra");
  // Cross-lane inbound mirrors onto a6: two same-class sources (fold).
  makeEdge(db, b1, a6, "override", "legal", "auth");
  makeEdge(db, infra, a6, "override", "infra", "auth");

  return { s1, s2, taskA, taskB, a1, a2, a3, a4, infra, a6, b1, frontier };
}

describe("lane view: forward multiset (spec testing seam 2)", () => {
  test("every valid tail-in-lane edge renders exactly once as a forward element — count map keyed (tail, head, relation, qualified tags)", () => {
    const db = makeDb();
    const world = seedRichWorld(db);
    const page = renderLane(db, world.taskA.id, "auth");
    const parsed = parseLanePage(page);

    const auth = `E${world.taskA.id}/#auth`;
    const infraLane = `E${world.taskA.id}/#infra`;
    const expected = new Map<string, number>([
      [forwardKey(`S${world.s1}/T6`, `S${world.s1}/T1`, "correct(full)", auth, auth), 1],
      [forwardKey(`S${world.s1}/T6`, `S${world.s1}/T3`, "use", auth, auth), 1],
      [forwardKey(`S${world.s1}/T3`, `S${world.s1}/T2`, "use", auth, auth), 1],
      [forwardKey(`S${world.s1}/T2`, `S${world.s1}/T5`, "use", auth, infraLane), 1],
    ]);
    expect(parsed.forwards).toEqual(expected);
    db.close();
  });

  test("a multiset (not a set): duplicating a rendered element in the page text is caught by the count map", () => {
    // The probe property itself: the parser counts, so a page that rendered
    // one edge twice would yield a 2 where the contract demands exactly 1.
    const db = makeDb();
    const world = seedRichWorld(db);
    const page = renderLane(db, world.taskA.id, "auth");
    const duplicated = `${page.split("\n\n")[0]}\n${page.split("\n")[2]}\n\n${page.split("\n\n")[1]}`;
    const parsed = parseLanePage(duplicated);
    expect([...parsed.forwards.values()].some((count) => count > 1)).toBe(true);
    db.close();
  });

  test("same prompt number in two sessions: cross-session addresses stay distinct in the multiset and on the page", () => {
    const db = makeDb();
    const s1 = makeSession(db, "same-prompt-one");
    const s2 = makeSession(db, "same-prompt-two");
    const task = makeTask(db, "Same prompt", "same-prompt-task");
    insertLane(db, task.id, "twin", BASE_EPOCH);
    const older = makeTurn(db, s1, { prompt: 2, epoch: BASE_EPOCH + 100, title: "older twin", tags: ["twin"] });
    const newer = makeTurn(db, s2, { prompt: 2, epoch: BASE_EPOCH + 200, title: "newer twin", tags: ["twin"] });
    addSegmentMembers(db, task.id, [older, newer], BASE_EPOCH);
    settleWindow(db, s1, 2, 2);
    settleWindow(db, s2, 2, 2);
    makeEdge(db, newer, older, "extends", "twin", "twin");

    const page = renderLane(db, task.id, "twin");
    const parsed = parseLanePage(page);
    const lane = `E${task.id}/#twin`;
    expect(parsed.forwards).toEqual(
      new Map([[forwardKey(`S${s2}/T2`, `S${s1}/T2`, "use", lane, lane), 1]]),
    );
    // The session CHANGES mid-chain, so the head re-renders full-form.
    expect(parsed.skeleton).toEqual([`S${s2}/T2 use -> S${s1}/T2`]);
    db.close();
  });

  test("same tag word under two tasks is two lanes: both render independently, neither leaks the other's edges", () => {
    const db = makeDb();
    const s1 = makeSession(db, "two-tasks-session");
    const taskA = makeTask(db, "Task A", "twin-task-a");
    const taskB = makeTask(db, "Task B", "twin-task-b");
    insertLane(db, taskA.id, "alpha", BASE_EPOCH);
    insertLane(db, taskB.id, "alpha", BASE_EPOCH);
    const a1 = makeTurn(db, s1, { prompt: 1, epoch: BASE_EPOCH + 100, title: "A alpha base", tags: ["alpha"] });
    const a2 = makeTurn(db, s1, { prompt: 2, epoch: BASE_EPOCH + 200, title: "A alpha next", tags: ["alpha"] });
    const b1 = makeTurn(db, s1, { prompt: 3, epoch: BASE_EPOCH + 300, title: "B alpha only", tags: ["alpha"] });
    addSegmentMembers(db, taskA.id, [a1, a2], BASE_EPOCH);
    addSegmentMembers(db, taskB.id, [b1], BASE_EPOCH);
    settleWindow(db, s1, 1, 3);
    makeEdge(db, a2, a1, "extends", "alpha", "alpha");
    // B's alpha cites INTO A's alpha: forward for B, mirror for A.
    makeEdge(db, b1, a1, "override", "alpha", "alpha");

    const pageA = parseLanePage(renderLane(db, taskA.id, "alpha"));
    const pageB = parseLanePage(renderLane(db, taskB.id, "alpha"));
    const laneA = `E${taskA.id}/#alpha`;
    const laneB = `E${taskB.id}/#alpha`;
    expect(pageA.header.settled).toBe(2);
    expect(pageA.forwards).toEqual(
      new Map([[forwardKey(`S${s1}/T2`, `S${s1}/T1`, "use", laneA, laneA), 1]]),
    );
    expect(pageA.mirrors).toEqual(
      new Map([[[`S${s1}/T3`, "correct(full)", laneB, `S${s1}/T1`].join("|"), 1]]),
    );
    expect(pageB.header.settled).toBe(1);
    // B's one forward edge is cross-lane INTO A's lane — same tag word,
    // different task, so the qualifier names A's task, and B's island graph
    // (both endpoints in B's lane) excludes it: the divergence fixture.
    expect(pageB.forwards).toEqual(
      new Map([[forwardKey(`S${s1}/T3`, `S${s1}/T1`, "correct(full)", laneB, laneA), 1]]),
    );
    expect(pageB.header.forward).toBe(1);
    expect(pageB.header.islands).toBe(0);
    expect(pageB.header.singletons).toBe(1);
    expect(pageB.mirrors.size).toBe(0);
    db.close();
  });
});

describe("lane view: mirror multiset and folds", () => {
  test("every cross-lane inbound renders exactly once; same-relation mirrors fold onto ONE line with every source recoverable; mirrors sort after branches by weight then newer source", () => {
    const db = makeDb();
    const world = seedRichWorld(db);
    const page = renderLane(db, world.taskA.id, "auth");
    const parsed = parseLanePage(page);

    expect(parsed.mirrors).toEqual(
      new Map([
        [[`S${world.s2}/T2`, "correct(full)", `E${world.taskB.id}/#legal`, `S${world.s1}/T6`].join("|"), 1],
        [[`S${world.s1}/T5`, "correct(full)", `E${world.taskA.id}/#infra`, `S${world.s1}/T6`].join("|"), 1],
      ]),
    );
    // The fold: both `correct(full)` sources on ONE line, newer source (b1,
    // epoch +700) first. (The lighter second mirror this case used to sort
    // AFTER this line was the pair's SECOND physical row; the cutover's
    // pair-UNIQUE rebuild leaves one row per pair, so the weight ordering
    // between two mirrors of the same pair no longer has stock to run on.)
    const overrideLine = parsed.skeleton.find((line) => line.includes("correct(full) <="))!;
    expect(overrideLine).toBe(
      `└ correct(full) <= S${world.s2}/T2^(E${world.taskB.id}/#legal), S${world.s1}/T5^(E${world.taskA.id}/#infra)`,
    );
    // Mirrors render AFTER every branch of their head's block: no branch line
    // of the a6 block sits below a mirror line.
    const lastBranchIndex = Math.max(
      ...parsed.skeleton
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => line.includes("->") || line.includes("=>"))
        .map(({ index }) => index),
    );
    expect(parsed.skeleton.indexOf(overrideLine)).toBeGreaterThan(lastBranchIndex);
    db.close();
  });
});

describe("lane view: chain decomposition", () => {
  test("the heaviest out-edge takes the root's main line (override beats extends), the rest become └ branches", () => {
    const db = makeDb();
    const world = seedRichWorld(db);
    const parsed = parseLanePage(renderLane(db, world.taskA.id, "auth"));
    // a6's block: the main line takes `correct(full) -> a1`; the `use` edge
    // falls to └. (The third branch this used to check was the pair's second
    // physical row into a1, folded away by the cutover.)
    expect(parsed.skeleton[0]).toBe(`S${world.s1}/T6 correct(full) -> T1`);
    expect(parsed.skeleton.some((line) => line.startsWith("└ use -> "))).toBe(true);
    db.close();
  });

  test("a └ SECONDARY branch continues through a first-visit single-out node (all branches share the one continuation rule)", () => {
    const db = makeDb();
    const world = seedRichWorld(db);
    const parsed = parseLanePage(renderLane(db, world.taskA.id, "auth"));
    // The secondary extends branch continues through a3 (single out-edge,
    // first visit) and then through a2 straight into the cross-lane stub.
    expect(parsed.skeleton).toContain(
      `└ use -> S${world.s1}/T3 use -> T2 use => S${world.s1}/T5^(E${world.taskA.id}/#infra)`,
    );
    db.close();
  });

  // DELETED (main-agent-edges ticket 01): "^ marks a revisit: the
  // multi-relation second edge into an already-rendered node is a terminal ^
  // stub". Its subject was a SECOND physical row on a pair whose head the
  // walk had already rendered — stock the pair-UNIQUE rebuilt table cannot
  // hold. The `^` revisit stub itself is still pinned, on stock that exists,
  // by the fork case below.

  test("a fork target is stubbed ^ where it is reached and re-roots with its FULL out-edge set", () => {
    const db = makeDb();
    const s1 = makeSession(db, "fork-session");
    const task = makeTask(db, "Fork", "fork-task");
    insertLane(db, task.id, "fork", BASE_EPOCH);
    const t1 = makeTurn(db, s1, { prompt: 1, epoch: BASE_EPOCH + 100, title: "left leaf", tags: ["fork"] });
    const t2 = makeTurn(db, s1, { prompt: 2, epoch: BASE_EPOCH + 200, title: "right leaf", tags: ["fork"] });
    const t3 = makeTurn(db, s1, { prompt: 3, epoch: BASE_EPOCH + 300, title: "the fork", tags: ["fork"] });
    const t4 = makeTurn(db, s1, { prompt: 4, epoch: BASE_EPOCH + 400, title: "the newest", tags: ["fork"] });
    addSegmentMembers(db, task.id, [t1, t2, t3, t4], BASE_EPOCH);
    settleWindow(db, s1, 1, 4);
    // t4 reaches t3; t3 is a FORK (two out-edges) so the chain must stub it
    // and t3 must re-root showing BOTH its edges.
    makeEdge(db, t4, t3, "extends", "fork", "fork");
    makeEdge(db, t3, t1, "grounds", "fork", "fork");
    makeEdge(db, t3, t2, "verifies", "fork", "fork");

    const parsed = parseLanePage(renderLane(db, task.id, "fork"));
    expect(parsed.skeleton).toEqual([
      `S${s1}/T4 use -> T3^`,
      // t3's own root block: verifies and grounds tie at weight 1 → newer
      // target (t2) takes the main line, grounds falls to └.
      `S${s1}/T3 verify -> T2`,
      `└ use -> S${s1}/T1`,
    ]);
    // Forward exactly-once still holds across the stub + re-root.
    expect([...parsed.forwards.values()]).toEqual([1, 1, 1]);
    expect(parsed.header.forward).toBe(3);
    db.close();
  });

  test("a mirror-carrying node is never continued through: it stubs ^ and re-roots so its mirrors render", () => {
    const db = makeDb();
    const s1 = makeSession(db, "mirror-root-session");
    const taskA = makeTask(db, "Mirror root", "mirror-root-task");
    const taskB = makeTask(db, "Mirror source", "mirror-source-task");
    insertLane(db, taskA.id, "carrier", BASE_EPOCH);
    insertLane(db, taskB.id, "sender", BASE_EPOCH);
    const t1 = makeTurn(db, s1, { prompt: 1, epoch: BASE_EPOCH + 100, title: "the leaf", tags: ["carrier"] });
    const t2 = makeTurn(db, s1, { prompt: 2, epoch: BASE_EPOCH + 200, title: "the carrier", tags: ["carrier"] });
    const t3 = makeTurn(db, s1, { prompt: 3, epoch: BASE_EPOCH + 300, title: "the newest", tags: ["carrier"] });
    const sender = makeTurn(db, s1, { prompt: 4, epoch: BASE_EPOCH + 400, title: "the sender", tags: ["sender"] });
    addSegmentMembers(db, taskA.id, [t1, t2, t3], BASE_EPOCH);
    addSegmentMembers(db, taskB.id, [sender], BASE_EPOCH);
    settleWindow(db, s1, 1, 4);
    // t2 is single-out (would continue) BUT carries a cross-lane mirror.
    makeEdge(db, t3, t2, "extends", "carrier", "carrier");
    makeEdge(db, t2, t1, "extends", "carrier", "carrier");
    makeEdge(db, sender, t2, "verifies", "sender", "carrier");

    const parsed = parseLanePage(renderLane(db, taskA.id, "carrier"));
    expect(parsed.skeleton).toEqual([
      `S${s1}/T3 use -> T2^`,
      `S${s1}/T2 use -> T1`,
      `└ verify <= S${s1}/T4^(E${taskB.id}/#sender)`,
    ]);
    db.close();
  });
});

describe("lane view: universe predicates and header", () => {
  test("skipped, rewound and compact-synthetic members are excluded from every count, the skeleton and the title table", () => {
    const db = makeDb();
    const s1 = makeSession(db, "exclusion-session");
    const task = makeTask(db, "Exclusions", "exclusion-task");
    insertLane(db, task.id, "gamma", BASE_EPOCH);
    const keeper = makeTurn(db, s1, { prompt: 1, epoch: BASE_EPOCH + 100, title: "kept member", tags: ["gamma"] });
    const keeperTwo = makeTurn(db, s1, { prompt: 2, epoch: BASE_EPOCH + 200, title: "second kept", tags: ["gamma"] });
    const skipped = makeTurn(db, s1, { prompt: 3, epoch: BASE_EPOCH + 300, title: "skipped member", tags: ["gamma"], status: "skipped" });
    const rewound = makeTurn(db, s1, { prompt: 4, epoch: BASE_EPOCH + 400, title: "rewound member", tags: ["gamma"], rolledBack: true });
    const compact = makeTurn(db, s1, { prompt: 5, epoch: BASE_EPOCH + 500, title: "compact synthetic", tags: ["gamma", "compact:boundary"] });
    addSegmentMembers(db, task.id, [keeper, keeperTwo, skipped, rewound, compact], BASE_EPOCH);
    settleWindow(db, s1, 1, 5);
    makeEdge(db, keeperTwo, keeper, "extends", "gamma", "gamma");

    const page = renderLane(db, task.id, "gamma");
    const parsed = parseLanePage(page);
    expect(parsed.header.settled).toBe(2);
    expect(parsed.header.forward).toBe(1);
    expect(page).not.toContain("skipped member");
    expect(page).not.toContain("rewound member");
    expect(page).not.toContain("compact synthetic");
    db.close();
  });

  test("a settled singleton with zero edges is a member: counted in the header, absent from skeleton and title table", () => {
    const db = makeDb();
    const world = seedRichWorld(db);
    const page = renderLane(db, world.taskA.id, "auth");
    const parsed = parseLanePage(page);
    // a4 (prompt 4) is settled and edgeless: settled counts it, singletons
    // counts it, but it owns no skeleton line and no title row.
    expect(parsed.header.settled).toBe(5);
    expect(parsed.header.singletons).toBe(1);
    expect(page).not.toContain("auth singleton");
    expect(parsed.skeleton.join("\n")).not.toMatch(/\bT4\b/);
    db.close();
  });

  test("header counts verify against the page's own rendered content, and frontier counts the unsettled canonical members", () => {
    const db = makeDb();
    const world = seedRichWorld(db);
    const parsed = parseLanePage(renderLane(db, world.taskA.id, "auth"));
    let forwardTotal = 0;
    for (const count of parsed.forwards.values()) {
      forwardTotal += count;
    }
    let mirrorTotal = 0;
    for (const count of parsed.mirrors.values()) {
      mirrorTotal += count;
    }
    expect(parsed.header.forward).toBe(forwardTotal);
    expect(parsed.header.mirrors).toBe(mirrorTotal);
    // Islands: {a1,a2,a3,a6} connect in-lane; a4 is the singleton. The
    // cross-lane forward edge is NOT in the island graph even though the
    // forward count includes it (island-vs-forward divergence).
    expect(parsed.header.islands).toBe(1);
    expect(parsed.header.singletons).toBe(1);
    // FOUR forward edges, not five: the pair's second physical row into a1
    // went at the cutover.
    expect(parsed.header.forward).toBe(4);
    // frontier = the unsettled prompt-9 member.
    expect(parsed.header.frontier).toBe(1);
    db.close();
  });

  test("title table: time-ascending, skeleton-shown members only, type words, session-prefix fold", () => {
    const db = makeDb();
    const world = seedRichWorld(db);
    const parsed = parseLanePage(renderLane(db, world.taskA.id, "auth"));
    expect(parsed.titleRows).toHaveLength(4);
    expect(parsed.titleRows[0]).toMatch(
      new RegExp(`^S${world.s1}/T1 \\d\\d-\\d\\d design auth base$`),
    );
    expect(parsed.titleRows[1]).toMatch(/^T2 \d\d-\d\d design auth narrows$/);
    expect(parsed.titleRows[2]).toMatch(/^T3 \d\d-\d\d design auth verify$/);
    expect(parsed.titleRows[3]).toMatch(/^T6 \d\d-\d\d design auth ruling$/);
    db.close();
  });

  test("a zero-settled declared lane renders header and legend only", () => {
    const db = makeDb();
    const task = makeTask(db, "Empty", "empty-task");
    insertLane(db, task.id, "empty-lane", BASE_EPOCH);
    const page = renderLane(db, task.id, "empty-lane");
    expect(page.split("\n")).toEqual([
      `E${task.id}/#empty-lane · 0 settled · 0 forward · 0 mirrors · islands 0+0 · frontier 0`,
      "arrows: -> in-lane · => cross-lane out · <= cross-lane in · <- cross-page in",
    ]);
    db.close();
  });
});

describe("lane view: determinism and overflow", () => {
  test("same corpus ⇒ byte-identical page, across repeated renders and an independent rebuild", () => {
    const db = makeDb();
    const world = seedRichWorld(db);
    const first = timelineQuery(db, { id: `E${world.taskA.id}/#auth` });
    const second = timelineQuery(db, { id: `E${world.taskA.id}/#auth` });
    expect(second).toBe(first);
    const rebuilt = makeDb();
    const worldTwo = seedRichWorld(rebuilt);
    expect(timelineQuery(rebuilt, { id: `E${worldTwo.taskA.id}/#auth` })).toBe(first);
    db.close();
    rebuilt.close();
  });

  test("a budget no member fits partitions into exceptional single-member pages — every marker self-including, every valid edge still rendered exactly once across the pages (ticket 05)", () => {
    // Ticket 04 shipped this corpus as ONE over-budget page; ticket 05's
    // partition replaces that: at budget 40 even a lone member overflows, so
    // every settled member gets its own exceptional single-member page (spec
    // "Single-member overflow" — membership and tail-page contracts beat the
    // budget), and the whole-lane forward multiset is the UNION of the pages.
    const db = makeDb();
    const world = seedRichWorld(db);
    const budget = 40;
    const first = buildSegmentLaneListView(db, world.taskA.id, { tag: "auth" }, 1, budget);
    expect(first.pageCount).toBe(5); // a6, a4, a3, a2, a1 — newest first
    const auth = `E${world.taskA.id}/#auth`;
    const infraLane = `E${world.taskA.id}/#infra`;
    const union = new Map<string, number>();
    for (let page = 1; page <= first.pageCount; page += 1) {
      const view = buildSegmentLaneListView(db, world.taskA.id, { tag: "auth" }, page, budget);
      expect(view.page).toBe(page);
      const lane = view.lanes[0]!;
      const text = lane.lines.join("\n");
      const parsed = parseLanePage(text);
      // Single-member page: its own range collapses to one address.
      expect(parsed.header.page).toBe(page);
      expect(parsed.header.pageCount).toBe(5);
      expect(parsed.header.range!.newest).toBe(parsed.header.range!.oldest);
      // Exceptional over-budget page: marker present and SELF-INCLUDING —
      // the final rendering exceeds the budget by exactly the stated count.
      expect(lane.overflowTokens).not.toBeNull();
      expect(parsed.header.overflow).toBe(lane.overflowTokens!);
      expect(countTokens(text) - budget).toBe(lane.overflowTokens!);
      for (const [key, count] of parsed.forwards) {
        union.set(key, (union.get(key) ?? 0) + count);
      }
    }
    // The singleton a4's page renders header + legend only — a member with
    // no edges never earns a skeleton line, even alone on its page.
    const singletonPage = buildSegmentLaneListView(db, world.taskA.id, { tag: "auth" }, 2, budget);
    expect(singletonPage.lanes[0]!.lines).toHaveLength(2);
    // Whole-lane forward multiset across ALL pages: every valid tail-in-lane
    // edge exactly once, unchanged from the one-page render.
    expect(union).toEqual(
      new Map<string, number>([
        [forwardKey(`S${world.s1}/T6`, `S${world.s1}/T1`, "correct(full)", auth, auth), 1],
        [forwardKey(`S${world.s1}/T6`, `S${world.s1}/T3`, "use", auth, auth), 1],
        [forwardKey(`S${world.s1}/T3`, `S${world.s1}/T2`, "use", auth, auth), 1],
        [forwardKey(`S${world.s1}/T2`, `S${world.s1}/T5`, "use", auth, infraLane), 1],
      ]),
    );
    db.close();
  });

  test("a page within budget carries no overflow marker and measures within the budget by the runtime tokenizer", () => {
    const db = makeDb();
    const world = seedRichWorld(db);
    const view = buildSegmentLaneListView(db, world.taskA.id, { tag: "auth" }, 1, 1000);
    const lane = view.lanes[0]!;
    expect(lane.overflowTokens).toBeNull();
    expect(lane.lines.join("\n")).not.toContain("[overflow");
    expect(countTokens(lane.lines.join("\n"))).toBeLessThanOrEqual(1000);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Ticket 05 — the page partition. Fixture shape at pageBudget 130 (pinned by
// probing the real renderer; every assertion below re-derives it from output):
//   page 1 = {a6}: a6's fan-out + its three cross-lane mirror sources exceed
//            130 alone -> the exceptional over-budget single-member page;
//   page 2 = {a4, a3, a2}: the singleton plus a chain that continues in-page
//            through T2 into the cross-lane stub;
//   page 3 = {a1}: a zero-out-edge member carried by two same-lane
//            cross-page mirrors.
// ---------------------------------------------------------------------------

/** One lane page via the canonical address + explicit page selection (ticket 05). */
function renderLaneAt(
  db: Database,
  segmentId: number,
  tag: string,
  page: number,
  pageBudget: number,
): { text: string; page: number; pageCount: number; overflowTokens: number | null } {
  const view = buildSegmentLaneListView(db, segmentId, { tag }, page, pageBudget);
  expect(view.lanes).toHaveLength(1);
  return {
    text: view.lanes[0]!.lines.join("\n"),
    page: view.page,
    pageCount: view.pageCount,
    overflowTokens: view.lanes[0]!.overflowTokens,
  };
}

describe("lane view: page partition (ticket 05)", () => {
  test("contiguous newest-first ranges, every settled member on exactly one page, forward edges on their TAIL's page, pointers carrying the target's page", () => {
    const db = makeDb();
    const world = seedRichWorld(db);
    const auth = `E${world.taskA.id}/#auth`;
    const infraLane = `E${world.taskA.id}/#infra`;
    const pages = [1, 2, 3].map((page) =>
      parseLanePage(renderLaneAt(db, world.taskA.id, "auth", page, 130).text),
    );
    expect(renderLaneAt(db, world.taskA.id, "auth", 1, 130).pageCount).toBe(3);

    // Contiguous time ranges under the pinned total order, no interleaving:
    // [T6] · [T4..T2] · [T1] tile the settled order newest -> oldest.
    expect(pages.map((page) => page.header.range)).toEqual([
      { newest: `S${world.s1}/T6`, oldest: `S${world.s1}/T6` },
      { newest: `S${world.s1}/T4`, oldest: `S${world.s1}/T2` },
      { newest: `S${world.s1}/T1`, oldest: `S${world.s1}/T1` },
    ]);
    expect(pages.map((page) => [page.header.page, page.header.pageCount])).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);

    // Forward multiset: the union over ALL pages is exactly the valid
    // tail-in-lane edge set, each edge exactly once — and each edge sits on
    // its TAIL's page.
    expect(pages[0]!.forwards).toEqual(
      new Map([
        [forwardKey(`S${world.s1}/T6`, `S${world.s1}/T1`, "correct(full)", auth, auth), 1],
        [forwardKey(`S${world.s1}/T6`, `S${world.s1}/T3`, "use", auth, auth), 1],
      ]),
    );
    expect(pages[1]!.forwards).toEqual(
      new Map([
        [forwardKey(`S${world.s1}/T3`, `S${world.s1}/T2`, "use", auth, auth), 1],
        [forwardKey(`S${world.s1}/T2`, `S${world.s1}/T5`, "use", auth, infraLane), 1],
      ]),
    );
    expect(pages[2]!.forwards.size).toBe(0);

    // Cross-page pointer stubs carry the TARGET's page after pass 2; an
    // in-page target (T3 -> T2 on page 2) and a cross-lane stub carry none.
    expect(pages[0]!.forwardPointers).toEqual(
      new Map([
        [forwardKey(`S${world.s1}/T6`, `S${world.s1}/T1`, "correct(full)", auth, auth), "3/3"],
        [forwardKey(`S${world.s1}/T6`, `S${world.s1}/T3`, "use", auth, auth), "2/3"],
      ]),
    );
    expect(pages[1]!.forwardPointers.size).toBe(0);

    // Page-local header counts verify against each page's own rendered lines.
    // [2, 2, 0], not [3, 2, 0]: page 1 lost the pair's second physical row
    // into a1 at the cutover.
    expect(pages.map((page) => page.header.forward)).toEqual([2, 2, 0]);
    for (const page of pages) {
      let forwardTotal = 0;
      for (const count of page.forwards.values()) {
        forwardTotal += count;
      }
      expect(page.header.forward).toBe(forwardTotal);
    }
    db.close();
  });

  test("same-lane cross-page inbound mirrors render on the HEAD's page with the SOURCE's page pointer; in-page inbound stays forward-only; page-local mirror counts hold", () => {
    const db = makeDb();
    const world = seedRichWorld(db);
    const pages = [1, 2, 3].map((page) =>
      parseLanePage(renderLaneAt(db, world.taskA.id, "auth", page, 130).text),
    );

    // Page 2: a6 (page 1, NEWER) -> a3 mirrors onto a3's page; the in-page
    // a3 -> a2 edge grows NO mirror line. Both edges are `use` after the
    // cutover, so the "no mirror for the in-page edge" half is stated as the
    // COUNT of same-lane mirror lines rather than by naming a second word.
    expect(pages[1]!.skeleton).toContain(`└ use <- S${world.s1}/T6^ (1/3)`);
    expect(pages[1]!.skeleton.filter((line) => line.includes("<- ")).length).toBe(1);

    // Page 3: a6's edge into a1 mirrors with its page pointer, and the
    // multiset records the folded-out source once. (This case used to show
    // TWO mirror lines for the two physical rows of that pair, ordered by
    // weight; the cutover left one row, so there is one line.)
    expect(pages[2]!.skeleton).toEqual([
      `S${world.s1}/T1`,
      `└ correct(full) <- S${world.s1}/T6^ (1/3)`,
    ]);
    expect(pages[2]!.mirrors).toEqual(
      new Map([
        [[`S${world.s1}/T6`, "correct(full)", "1/3", `S${world.s1}/T1`].join("|"), 1],
      ]),
    );

    // Page 1 keeps the cross-lane `<=` mirrors (fold intact) beside zero
    // same-lane ones — the two mirror kinds coexist without merging.
    expect(pages[0]!.skeleton).toContain(
      `└ correct(full) <= S${world.s2}/T2^(E${world.taskB.id}/#legal), S${world.s1}/T5^(E${world.taskA.id}/#infra)`,
    );
    expect(pages[0]!.skeleton.some((line) => line.includes("<- "))).toBe(false);

    // Every page's mirror count is PAGE-LOCAL: verifiable against that
    // page's own folded-out sources, nothing else.
    for (const page of pages) {
      let mirrorTotal = 0;
      for (const count of page.mirrors.values()) {
        mirrorTotal += count;
      }
      expect(page.header.mirrors).toBe(mirrorTotal);
    }
    // [2, 1, 1]: page 1 keeps its two cross-lane `<=` mirrors onto a6 (the
    // third was the second physical row of the b1->a6 pair) and page 3 keeps
    // one same-lane `<-` mirror onto a1 (it was two, for the two rows of the
    // a6->a1 pair). Both losses are the cutover's pair fold.
    expect(pages.map((page) => page.header.mirrors)).toEqual([2, 1, 1]);
    db.close();
  });

  test("a zero-out-edge member carried only by cross-page mirrors ROOTS on its page (the ticket-04 mirror-carrier law extends to <-), and its title row renders", () => {
    const db = makeDb();
    const world = seedRichWorld(db);
    const page3 = parseLanePage(renderLaneAt(db, world.taskA.id, "auth", 3, 130).text);
    expect(page3.skeleton[0]).toBe(`S${world.s1}/T1`);
    expect(page3.titleRows).toHaveLength(1);
    expect(page3.titleRows[0]).toMatch(
      new RegExp(`^S${world.s1}/T1 \\d\\d-\\d\\d design auth base$`),
    );
    db.close();
  });

  test("the CYCLE fixture (ticket-04 adjudication): A→B and B→A both render exactly once, the walk terminating on first-visit gating", () => {
    const db = makeDb();
    const s1 = makeSession(db, "cycle-session");
    const task = makeTask(db, "Cycle", "cycle-task");
    insertLane(db, task.id, "cycle", BASE_EPOCH);
    const older = makeTurn(db, s1, { prompt: 1, epoch: BASE_EPOCH + 100, title: "cycle older", tags: ["cycle"] });
    const newer = makeTurn(db, s1, { prompt: 2, epoch: BASE_EPOCH + 200, title: "cycle newer", tags: ["cycle"] });
    addSegmentMembers(db, task.id, [older, newer], BASE_EPOCH);
    settleWindow(db, s1, 1, 2);
    // A legal multi-relation pair in BOTH directions: newer overrides older,
    // older grounds newer.
    makeEdge(db, newer, older, "override", "cycle", "cycle");
    makeEdge(db, older, newer, "grounds", "cycle", "cycle");

    const parsed = parseLanePage(renderLane(db, task.id, "cycle"));
    // One chain line: the walk continues through the first-visit single-out
    // older node, then the cycle edge stubs `^` at the already-rendered root
    // instead of looping.
    expect(parsed.skeleton).toEqual([
      `S${s1}/T2 correct(full) -> T1 use -> T2^`,
    ]);
    const lane = `E${task.id}/#cycle`;
    expect(parsed.forwards).toEqual(
      new Map([
        [forwardKey(`S${s1}/T2`, `S${s1}/T1`, "correct(full)", lane, lane), 1],
        [forwardKey(`S${s1}/T1`, `S${s1}/T2`, "use", lane, lane), 1],
      ]),
    );
    db.close();
  });

  test("single-member overflow mid-partition: the lone unfittable member ships over budget with an exact self-including marker across the digit-width boundary, while membership and tail-page contracts hold", () => {
    const db = makeDb();
    const s1 = makeSession(db, "overflow-mid-session");
    const task = makeTask(db, "Overflow", "overflow-task");
    insertLane(db, task.id, "heavy", BASE_EPOCH);
    const m1 = makeTurn(db, s1, { prompt: 1, epoch: BASE_EPOCH + 100, title: "light one", tags: ["heavy"] });
    const m2 = makeTurn(db, s1, {
      prompt: 2,
      epoch: BASE_EPOCH + 200,
      // Fat enough (the 100-char title cap still applies) that m2 ALONE
      // overflows budget 110 by a two-digit count — the marker fixed point
      // must cross the 1→2 digit-width boundary and still land exact.
      title: "very heavy middle member ".repeat(8),
      tags: ["heavy"],
    });
    const m3 = makeTurn(db, s1, { prompt: 3, epoch: BASE_EPOCH + 300, title: "light three", tags: ["heavy"] });
    addSegmentMembers(db, task.id, [m1, m2, m3], BASE_EPOCH);
    settleWindow(db, s1, 1, 3);
    makeEdge(db, m3, m2, "extends", "heavy", "heavy");
    makeEdge(db, m2, m1, "extends", "heavy", "heavy");

    const budget = 110;
    const lane = `E${task.id}/#heavy`;
    const pageOne = renderLaneAt(db, task.id, "heavy", 1, budget);
    expect(pageOne.pageCount).toBe(3);
    const pages = [1, 2, 3].map((page) => renderLaneAt(db, task.id, "heavy", page, budget));

    // Pages 1 and 3 fit; page 2 is the exceptional over-budget single-member
    // page — the partition never drops m2 and never splits its rendering.
    expect(pages.map((page) => page.overflowTokens === null)).toEqual([true, false, true]);
    const overflowText = pages[1]!.text;
    const parsed = parseLanePage(overflowText);
    expect(parsed.header.range).toEqual({ newest: `S${s1}/T2`, oldest: `S${s1}/T2` });
    expect(parsed.header.overflow).toBe(pages[1]!.overflowTokens!);
    expect(parsed.header.overflow!).toBeGreaterThanOrEqual(10);
    // Self-including fixed point: the shipped rendering, marker included,
    // exceeds the budget by EXACTLY the number the marker states.
    expect(countTokens(overflowText) - budget).toBe(pages[1]!.overflowTokens!);

    // `all out-edges on the tail's page` holds through the pathology.
    expect(parseLanePage(pages[0]!.text).forwards).toEqual(
      new Map([[forwardKey(`S${s1}/T3`, `S${s1}/T2`, "use", lane, lane), 1]]),
    );
    expect(parsed.forwards).toEqual(
      new Map([[forwardKey(`S${s1}/T2`, `S${s1}/T1`, "use", lane, lane), 1]]),
    );
    expect(parseLanePage(pages[2]!.text).forwards.size).toBe(0);
    // `every member exactly one page`: the three single-member ranges tile
    // the settled order.
    expect(pages.map((page) => parseLanePage(page.text).header.range!.newest)).toEqual([
      `S${s1}/T3`,
      `S${s1}/T2`,
      `S${s1}/T1`,
    ]);
    db.close();
  });

  test("a one-page lane renders ZERO pointers: no page marker in the header, no (p/N), no <- mirrors", () => {
    const db = makeDb();
    const world = seedRichWorld(db);
    const { text, pageCount } = renderLaneAt(db, world.taskA.id, "auth", 1, 1000);
    expect(pageCount).toBe(1);
    const parsed = parseLanePage(text);
    expect(parsed.header.page).toBeNull();
    expect(parsed.header.pageCount).toBeNull();
    expect(text).not.toMatch(/\(\d+\/\d+\)/);
    // No `<-` mirror line (the arrow legend TEACHING the arrow stays).
    expect(parsed.skeleton.some((line) => line.includes("<- "))).toBe(false);
    db.close();
  });

  test("byte-identical pages for the same corpus and page, across repeated renders and an independent rebuild", () => {
    const db = makeDb();
    const world = seedRichWorld(db);
    const rebuilt = makeDb();
    const worldTwo = seedRichWorld(rebuilt);
    for (const page of [1, 2, 3]) {
      const first = timelineQuery(db, { id: `E${world.taskA.id}/#auth`, page, pageBudget: 130 });
      const second = timelineQuery(db, { id: `E${world.taskA.id}/#auth`, page, pageBudget: 130 });
      expect(second).toBe(first);
      expect(
        timelineQuery(rebuilt, { id: `E${worldTwo.taskA.id}/#auth`, page, pageBudget: 130 }),
      ).toBe(first);
    }
    db.close();
    rebuilt.close();
  });

  // BOUNDARY-CAP NOTE (rewritten by ticket 07 P1-2 — the old "shed fixtures
  // are UNCONSTRUCTIBLE" claim was FALSE and is deleted). o200k_base prices
  // 1-3 digit numbers as one token but 4+ digits as more ((1/999) = 5
  // tokens, (1/1000) = 6), so any partition crossing 1000 pages re-prices
  // its `p/N` fragments between the pass-1 probe and the pass-2 re-render.
  // The REAL fixtures live in the "ticket 07 P1-2" describe below: the
  // peer's 2,000-member corpus (309s → ~1s after batching, measured) and a
  // genuine shed cascade whose caps are load-bearing (mutating the cap
  // bookkeeping out livelocks the sweep — the timeout fails RED). The sweep
  // below still pins the fixed point at SMALL scale: at every budget the
  // boundary vector is simultaneously stable with all rendered outputs
  // (each page re-renders byte-identically on direct request), every page
  // fits or is a lone member, and the partition tiles the settled order.
  test("pass-2 fixed point across a budget sweep: stable boundaries, every page within budget or a lone member, membership tiled exactly once", () => {
    const db = makeDb();
    const world = seedRichWorld(db);
    const settledNewestFirst = [
      `S${world.s1}/T6`,
      `S${world.s1}/T4`,
      `S${world.s1}/T3`,
      `S${world.s1}/T2`,
      `S${world.s1}/T1`,
    ];
    for (let budget = 40; budget <= 200; budget += 10) {
      const first = renderLaneAt(db, world.taskA.id, "auth", 1, budget);
      const ranges: { newest: string; oldest: string }[] = [];
      for (let page = 1; page <= first.pageCount; page += 1) {
        const rendered = renderLaneAt(db, world.taskA.id, "auth", page, budget);
        expect(rendered.pageCount).toBe(first.pageCount);
        // Stability: the page re-renders byte-identically on direct request.
        expect(renderLaneAt(db, world.taskA.id, "auth", page, budget).text).toBe(rendered.text);
        const parsed = parseLanePage(rendered.text);
        if (first.pageCount > 1) {
          ranges.push(parsed.header.range!);
          // Within budget, or the exceptional LONE-member page.
          if (rendered.overflowTokens !== null) {
            expect(parsed.header.range!.newest).toBe(parsed.header.range!.oldest);
          } else {
            expect(countTokens(rendered.text)).toBeLessThanOrEqual(budget);
          }
        }
      }
      if (first.pageCount > 1) {
        // The ranges tile the settled order: contiguous, disjoint, complete.
        const tiled: string[] = [];
        for (const range of ranges) {
          const from = settledNewestFirst.indexOf(range.newest);
          const to = settledNewestFirst.indexOf(range.oldest);
          expect(from).toBeGreaterThanOrEqual(0);
          expect(to).toBeGreaterThanOrEqual(from);
          tiled.push(...settledNewestFirst.slice(from, to + 1));
        }
        expect(tiled).toEqual(settledNewestFirst);
      }
    }
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Ticket 07 P1-2 — the ≥1000-page corpora. Page counts past 999 add a token
// to every `p/N` fragment (o200k prices (1/999)=5 but (1/1000)=6), which is
// exactly the drift the retired one-shed-per-sweep pass 2 degenerated on
// (O(P²) full renders — the peer measured 274s, this repo reproduced 309s on
// the fixture below at commit 82a5583f). The batched sweep plus the pass-1.5
// digit-width floor must hold these corpora in normal-request time.
// ---------------------------------------------------------------------------

/**
 * The peer's corpus shape: `members` settled members, one cross-lane edge
 * each, alternating titles that saturate a 2-member page at EXACTLY the
 * budget while the probe's provisional N is ≤3 digits (the drift trap).
 * `longRangePointerCount` newest members instead carry ONE long-range
 * same-lane edge onto a member whose final page ordinal is 4-digit — the
 * pass-1 probe models that target as the small next-page ordinal, so the
 * pointer's final cost is a token higher than probed: drift the digit-width
 * floor cannot pre-price, forcing REAL pass-2 sheds that only the boundary
 * caps keep from re-expanding forever.
 */
function seedWideCorpus(
  db: Database,
  members: number,
  longRangePointerCount: number,
): { task: SegmentRecord; s1: number } {
  const s1 = makeSession(db, "wide-main");
  const s2 = makeSession(db, "wide-aux");
  const task = makeTask(db, "Wide", "wide-task");
  insertLane(db, task.id, "main", BASE_EPOCH);
  insertLane(db, task.id, "aux", BASE_EPOCH);
  const insert = db.query<{ id: number }, [number, number, string, string, number]>(
    `INSERT INTO turns (
       session_id, prompt_number, status, user_prompt, assistant_response,
       title, type, tags, created_at_epoch, was_rolled_back
     ) VALUES (?, ?, 'extracted', 'asked', 'answered', ?, '[]', ?, ?, 0)
     RETURNING id`,
  );
  const isPointerMember = (prompt: number): boolean => prompt > members - longRangePointerCount;
  const mainIds: number[] = [];
  const auxIds: number[] = [];
  db.transaction(() => {
    for (let prompt = 1; prompt <= members; prompt += 1) {
      const title = isPointerMember(prompt)
        ? "note"
        : prompt % 2 === 0
          ? "note"
          : "note alpha b";
      mainIds.push(
        insert.get(s1, prompt, title, JSON.stringify(["main"]), BASE_EPOCH + prompt * 10)!.id,
      );
      auxIds.push(
        insert.get(s2, prompt, `aux ${prompt}`, JSON.stringify(["aux"]), BASE_EPOCH + prompt * 10 + 5)!.id,
      );
    }
  })();
  addSegmentMembers(db, task.id, [...mainIds, ...auxIds], BASE_EPOCH);
  settleWindow(db, s1, 1, members);
  db.transaction(() => {
    for (let index = 0; index < members; index += 1) {
      if (isPointerMember(index + 1)) {
        makeEdge(db, mainIds[index]!, mainIds[index - 1800]!, "grounds", "main", "main");
      } else {
        makeEdge(db, mainIds[index]!, auxIds[index]!, "grounds", "main", "aux");
      }
    }
  })();
  return { task, s1 };
}

describe("lane view: pass-2 batch tightening on ≥1000-page corpora (ticket 07 P1-2)", () => {
  test(
    "the peer's corpus (2,000 settled members, one cross-lane edge each, pageBudget 127) completes in normal-request time with every multi-member page within budget",
    () => {
      const db = makeDb();
      const { task, s1 } = seedWideCorpus(db, 2_000, 0);

      const started = performance.now();
      const first = renderLaneAt(db, task.id, "main", 1, 127);
      const elapsedMs = performance.now() - started;
      // The retired one-shed-per-sweep pass 2 took 309 SECONDS here
      // (measured at 82a5583f); batching holds it in normal-request class.
      // The bound is generous for CI noise — the measured value is ~1s.
      expect(elapsedMs).toBeLessThan(30_000);
      expect(first.pageCount).toBeGreaterThanOrEqual(1_000);

      // Sampled pages (each sample re-derives the whole partition —
      // determinism included): within budget or a lone member, and adjacent
      // pages tile the settled order without gap or overlap.
      const parseRange = (text: string) => parseLanePage(text).header.range!;
      const promptOf = (address: string): number => Number(address.split("/T")[1]);
      for (const page of [1, 2, first.pageCount - 1, first.pageCount]) {
        const rendered = renderLaneAt(db, task.id, "main", page, 127);
        expect(rendered.pageCount).toBe(first.pageCount);
        const range = parseRange(rendered.text);
        if (rendered.overflowTokens !== null) {
          expect(range.newest).toBe(range.oldest); // only a lone member may overflow
        } else {
          expect(countTokens(rendered.text)).toBeLessThanOrEqual(127);
        }
        if (page > 1) {
          const previous = parseRange(renderLaneAt(db, task.id, "main", page - 1, 127).text);
          expect(promptOf(range.newest)).toBe(promptOf(previous.oldest) - 1);
        }
      }
      // Page 1 newest == the newest settled member; the last page's oldest
      // == T1 (complete coverage at both ends of the pinned total order).
      expect(parseRange(renderLaneAt(db, task.id, "main", 1, 127).text).newest).toBe(`S${s1}/T2000`);
      expect(parseRange(renderLaneAt(db, task.id, "main", first.pageCount, 127).text).oldest).toBe(
        `S${s1}/T1`,
      );
      db.close();
    },
    240_000,
  );

  test(
    "a REAL shed cascade: long-range pointers under-probed by a token force pass-2 sheds, and the boundary caps hold them (mutating the cap bookkeeping out livelocks this fixture — the RED path)",
    () => {
      const db = makeDb();
      const { task, s1 } = seedWideCorpus(db, 2_000, 6);

      const started = performance.now();
      const first = renderLaneAt(db, task.id, "main", 1, 127);
      const elapsedMs = performance.now() - started;
      expect(elapsedMs).toBeLessThan(60_000); // measured ~3.6s; livelocks without caps
      expect(first.pageCount).toBeGreaterThanOrEqual(1_000);

      // THE SHED SIGNATURE. Pass 1 packs the six pointer members two per
      // page (their pages probe at exactly the budget while each pointer's
      // final `(p/N)` costs one token more than probed). Pass 2 therefore
      // sheds each such page down to ONE member — so pages 1 and 2 hold
      // exactly one member each, within budget, no overflow marker. A
      // partition that never shed would show T2000..T1999 on page 1 (or an
      // over-budget multi-member page); either shape fails here.
      for (const [page, prompt] of [
        [1, 2000],
        [2, 1999],
      ] as const) {
        const rendered = renderLaneAt(db, task.id, "main", page, 127);
        expect(rendered.overflowTokens).toBeNull();
        expect(countTokens(rendered.text)).toBeLessThanOrEqual(127);
        expect(parseLanePage(rendered.text).header.range).toEqual({
          newest: `S${s1}/T${prompt}`,
          oldest: `S${s1}/T${prompt}`,
        });
      }
      db.close();
    },
    240_000,
  );
});

describe("lane view: read grants", () => {
  test("a readerId records the segment plus the SKELETON-SHOWN members only — never the singleton the page did not disclose", () => {
    const db = makeDb();
    const world = seedRichWorld(db);
    timelineQuery(db, { id: `E${world.taskA.id}/#auth` });
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM write_gate_reads").get()!.n,
    ).toBe(0);

    timelineQuery(db, {
      id: `E${world.taskA.id}/#auth`,
      readerId: "session:9",
      now: () => 777,
    });
    const grants = db
      .query<{ entityType: string; entityId: number }, []>(
        "SELECT entity_type AS entityType, entity_id AS entityId FROM write_gate_reads ORDER BY entity_type, entity_id",
      )
      .all();
    expect(grants).toEqual([
      { entityType: "segment", entityId: world.taskA.id },
      { entityType: "turn", entityId: world.a1 },
      { entityType: "turn", entityId: world.a2 },
      { entityType: "turn", entityId: world.a3 },
      { entityType: "turn", entityId: world.a6 },
    ]);
    db.close();
  });
});

/**
 * ticket 15 (S15069/T2461, missing pins): a BLANK/BLANK edge between two
 * turns that are each the SOLE current member of one lane — every fixture
 * elsewhere in this file declares a real tag on at least one side.
 * `loadFrontierEdges`'s resolver derives the lane on both ends from
 * membership alone, so the ruled table counts the edge as forward and folds
 * both members into one island. Reverting the loader to the stored column
 * would report neither side as attributed and drop the edge from the page.
 */
describe("ruled adjacency table: a BLANK/BLANK edge between two SOLE lane members still counts (main-agent-edges ticket 15)", () => {
  test("both sides derive the lane from membership alone — forward count and island both see it", () => {
    const db = makeDb();
    const s1 = makeSession(db, "adjacency-derived-blank");
    const task = makeTask(db, "Adjacency Derived Blank", "adjacency-derived-blank-task");
    insertLane(db, task.id, "derived-only", BASE_EPOCH);

    const t1 = makeTurn(db, s1, { prompt: 1, epoch: BASE_EPOCH + 100, title: "sole member one", tags: ["derived-only"] });
    const t2 = makeTurn(db, s1, { prompt: 2, epoch: BASE_EPOCH + 200, title: "sole member two", tags: ["derived-only"] });
    addSegmentMembers(db, task.id, [t1, t2], BASE_EPOCH);
    settleWindow(db, s1, 1, 2);

    makeEdge(db, t2, t1, "extends", "", "");

    const parsed = parseLanePage(renderLane(db, task.id, "derived-only"));
    expect(parsed.header.settled).toBe(2);
    expect(parsed.header.forward).toBe(1);
    expect(parsed.header.islands).toBe(1);
    expect(parsed.header.singletons).toBe(0);
    db.close();
  });
});
