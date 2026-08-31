import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { insertLane } from "../../src/db/lanes";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import {
  addSegmentMembers,
  createSegment,
  type SegmentRecord,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { buildSegmentLaneListView, timelineQuery } from "../../src/mcp/timeline";
import { countTokens } from "../../src/shared/token-count";
import type { CitationRelation } from "../../src/db/citations";

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
  relation: CitationRelation,
  tailTag: string,
  headTag: string,
): void {
  writeMemoryEdges(
    db,
    [
      {
        citing: { kind: "turn", id: citingTurnId },
        cited: { kind: "turn", id: citedTurnId },
        relation,
        provenance: "judged",
        tailTag,
        headTag,
      },
    ],
    BASE_EPOCH,
  );
}

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
    islands: number;
    singletons: number;
    frontier: number;
  };
  /** Forward multiset: every rendered forward element, keyed by `forwardKey`. */
  forwards: Map<string, number>;
  /** Mirror multiset: `source S/T|relation|source lane|head S/T`, one entry per FOLDED-OUT source address. */
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
    /^(E\d+\/#[\w-]+) · (\d+) settled · (\d+) forward · (\d+) mirrors · islands (\d+)\+(\d+) · frontier (\d+)/,
  );
  expect(headerMatch).not.toBeNull();
  const header = {
    lane: headerMatch![1]!,
    settled: Number(headerMatch![2]),
    forward: Number(headerMatch![3]),
    mirrors: Number(headerMatch![4]),
    islands: Number(headerMatch![5]),
    singletons: Number(headerMatch![6]),
    frontier: Number(headerMatch![7]),
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
  const mirrors = new Map<string, number>();
  const laneQualified = header.lane;

  /** One chain-element run: `<relation> -> addr[^]` / `<relation> => S/T^(E/#tag)`, tail = the previous rendered address. */
  const parseChain = (
    rest: string,
    anchor: { address: string; sessionId: number },
    foldSession: number | null,
  ): void => {
    const tokens = rest.split(" ");
    expect(tokens.length % 3).toBe(0);
    let tail = anchor.address;
    let session = foldSession;
    for (let cursor = 0; cursor < tokens.length; cursor += 3) {
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
    }
  };

  let root: { address: string; sessionId: number } | null = null;
  for (const line of skeleton) {
    if (line.startsWith("└ ")) {
      expect(root).not.toBeNull();
      const rest = line.slice("└ ".length);
      const mirror = rest.match(/^([a-z]+) <= (.+)$/);
      if (mirror && rest.includes("<=")) {
        for (const source of mirror[2]!.split(", ")) {
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

  return { header, forwards, mirrors, skeleton, titleRows };
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
  //   a6 -override-> a1   (heaviest: main line)
  //   a6 -extends-> a3    (secondary branch, continues through a3)
  //   a6 -narrows-> a1    (multi-relation revisit of a1)
  //   a3 -grounds-> a2    (a3 is single-out: the continuation the branch takes)
  //   a2 -extends-> infra (cross-lane forward stub)
  makeEdge(db, a6, a1, "override", "auth", "auth");
  makeEdge(db, a6, a3, "extends", "auth", "auth");
  makeEdge(db, a6, a1, "narrows", "auth", "auth");
  makeEdge(db, a3, a2, "grounds", "auth", "auth");
  makeEdge(db, a2, infra, "extends", "auth", "infra");
  // Cross-lane inbound mirrors onto a6: two same-relation sources (fold) plus
  // a lighter-weight relation that must sort after them.
  makeEdge(db, b1, a6, "override", "legal", "auth");
  makeEdge(db, infra, a6, "override", "infra", "auth");
  makeEdge(db, b1, a6, "extends", "legal", "auth");

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
      [forwardKey(`S${world.s1}/T6`, `S${world.s1}/T1`, "override", auth, auth), 1],
      [forwardKey(`S${world.s1}/T6`, `S${world.s1}/T3`, "extends", auth, auth), 1],
      [forwardKey(`S${world.s1}/T6`, `S${world.s1}/T1`, "narrows", auth, auth), 1],
      [forwardKey(`S${world.s1}/T3`, `S${world.s1}/T2`, "grounds", auth, auth), 1],
      [forwardKey(`S${world.s1}/T2`, `S${world.s1}/T5`, "extends", auth, infraLane), 1],
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
      new Map([[forwardKey(`S${s2}/T2`, `S${s1}/T2`, "extends", lane, lane), 1]]),
    );
    // The session CHANGES mid-chain, so the head re-renders full-form.
    expect(parsed.skeleton).toEqual([`S${s2}/T2 extends -> S${s1}/T2`]);
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
      new Map([[forwardKey(`S${s1}/T2`, `S${s1}/T1`, "extends", laneA, laneA), 1]]),
    );
    expect(pageA.mirrors).toEqual(
      new Map([[[`S${s1}/T3`, "override", laneB, `S${s1}/T1`].join("|"), 1]]),
    );
    expect(pageB.header.settled).toBe(1);
    // B's one forward edge is cross-lane INTO A's lane — same tag word,
    // different task, so the qualifier names A's task, and B's island graph
    // (both endpoints in B's lane) excludes it: the divergence fixture.
    expect(pageB.forwards).toEqual(
      new Map([[forwardKey(`S${s1}/T3`, `S${s1}/T1`, "override", laneB, laneA), 1]]),
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
        [[`S${world.s2}/T2`, "override", `E${world.taskB.id}/#legal`, `S${world.s1}/T6`].join("|"), 1],
        [[`S${world.s1}/T5`, "override", `E${world.taskA.id}/#infra`, `S${world.s1}/T6`].join("|"), 1],
        [[`S${world.s2}/T2`, "extends", `E${world.taskB.id}/#legal`, `S${world.s1}/T6`].join("|"), 1],
      ]),
    );
    // The fold: both override sources on ONE line, newer source (b1, epoch
    // +700) first; the weight-0 extends mirror on its own LATER line.
    const overrideLine = parsed.skeleton.find((line) => line.includes("override <="))!;
    expect(overrideLine).toBe(
      `└ override <= S${world.s2}/T2^(E${world.taskB.id}/#legal), S${world.s1}/T5^(E${world.taskA.id}/#infra)`,
    );
    const extendsLine = parsed.skeleton.find((line) => line.includes("extends <="))!;
    expect(parsed.skeleton.indexOf(extendsLine)).toBeGreaterThan(
      parsed.skeleton.indexOf(overrideLine),
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
    // a6's block: main line takes override -> a1; extends and narrows fall to └.
    expect(parsed.skeleton[0]).toBe(`S${world.s1}/T6 override -> T1`);
    expect(parsed.skeleton.some((line) => line.startsWith("└ extends -> "))).toBe(true);
    expect(parsed.skeleton.some((line) => line.startsWith("└ narrows -> "))).toBe(true);
    db.close();
  });

  test("a └ SECONDARY branch continues through a first-visit single-out node (all branches share the one continuation rule)", () => {
    const db = makeDb();
    const world = seedRichWorld(db);
    const parsed = parseLanePage(renderLane(db, world.taskA.id, "auth"));
    // The secondary extends branch continues through a3 (single out-edge,
    // first visit) and then through a2 straight into the cross-lane stub.
    expect(parsed.skeleton).toContain(
      `└ extends -> S${world.s1}/T3 grounds -> T2 extends => S${world.s1}/T5^(E${world.taskA.id}/#infra)`,
    );
    db.close();
  });

  test("^ marks a revisit: the multi-relation second edge into an already-rendered node is a terminal ^ stub", () => {
    const db = makeDb();
    const world = seedRichWorld(db);
    const parsed = parseLanePage(renderLane(db, world.taskA.id, "auth"));
    // a1 rendered plain at the end of the main line; the narrows revisit stubs it.
    expect(parsed.skeleton).toContain(`└ narrows -> S${world.s1}/T1^`);
    db.close();
  });

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
      `S${s1}/T4 extends -> T3^`,
      // t3's own root block: verifies and grounds tie at weight 1 → newer
      // target (t2) takes the main line, grounds falls to └.
      `S${s1}/T3 verifies -> T2`,
      `└ grounds -> S${s1}/T1`,
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
      `S${s1}/T3 extends -> T2^`,
      `S${s1}/T2 extends -> T1`,
      `└ verifies <= S${s1}/T4^(E${taskB.id}/#sender)`,
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
    expect(parsed.header.forward).toBe(5);
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

  test("a lane that cannot fit the page budget ships ONE over-budget page with a self-including [overflow +<n> tok] marker", () => {
    const db = makeDb();
    const world = seedRichWorld(db);
    const budget = 40;
    const view = buildSegmentLaneListView(db, world.taskA.id, { tag: "auth" }, 1, budget);
    const lane = view.lanes[0]!;
    expect(lane.overflowTokens).not.toBeNull();
    const text = lane.lines.join("\n");
    const marker = text.match(/\[overflow \+(\d+) tok\]/);
    expect(marker).not.toBeNull();
    expect(Number(marker![1])).toBe(lane.overflowTokens!);
    // Self-including fixed point: the final rendering, marker included,
    // exceeds the budget by exactly the number the marker states.
    expect(countTokens(text) - budget).toBe(lane.overflowTokens!);
    // The overflowing page is still the WHOLE lane — nothing was dropped.
    const parsed = parseLanePage(text);
    expect(parsed.header.forward).toBe(5);
    // Single page in this ticket: no pagination, page 1 of 1.
    expect(view.page).toBe(1);
    expect(view.pageCount).toBe(1);
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
