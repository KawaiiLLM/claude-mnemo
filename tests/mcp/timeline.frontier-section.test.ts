import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { insertLane } from "../../src/db/lanes";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import {
  addSegmentMembers,
  attachSegmentToSession,
  createSegment,
  type SegmentRecord,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { buildSegmentFrontierSection } from "../../src/mcp/timeline";
import { countTokens } from "../../src/shared/token-count";
import type { CitationRelation } from "../../src/db/citations";

/**
 * The SessionStart frontier section (frontier-injection spec Rev 5, ticket
 * 02) — seam 1 of the spec's Testing Decisions: hook-composition-shaped
 * output assertions over seeded corpora. `renderAttachedSegmentBlock`'s own
 * wiring test (tests/hooks/session-composition.test.ts) pins that the slot's
 * body is `buildSegmentFrontierSection`'s output byte-for-byte, so asserting
 * on the producer here IS asserting on the hook output minus the slot
 * header. Tests assert output strings and count maps, never walk internals.
 *
 * SETTLED here always means settlement COVERAGE — a `status='done'`
 * `note_settlement_jobs` window over the turn's prompt number — seeded by
 * `settleWindow` below, never by writing edges.
 */

const BASE_EPOCH = 1_756_500_000;

/** A row line: optional session prefix, address, MM-DD date. */
const ROW_RE = /^(?:S\d+\/)?T\d+ \d\d-\d\d /;

function rowLines(text: string): string[] {
  return text.split("\n").filter((line) => ROW_RE.test(line));
}

function makeDb(): Database {
  const db = createDatabase(":memory:");
  initializeSchema(db);
  return db;
}

function makeSession(db: Database, contentSessionId: string): number {
  return upsertSession(db, {
    contentSessionId,
    project: "/projects/frontier",
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
      spec.title ?? "probe row",
      JSON.stringify(spec.types ?? []),
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

/** Smallest integer budget at which `render` shows at least `target` rows (row counts are budget-monotone for the uniform-cost fixtures using this). */
function minBudgetForRows(
  render: (budget: number) => string,
  target: number,
  hi: number,
): number {
  let lo = 1;
  let best = hi;
  let bestFound = false;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rowLines(render(mid)).length >= target) {
      best = mid;
      bestFound = true;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  expect(bestFound).toBe(true);
  return best;
}

// ---------------------------------------------------------------------------
// Qualified identity, digest grammar, denominators.
// ---------------------------------------------------------------------------

describe("frontier section: qualified identity and digest grammar", () => {
  /**
   * Two tasks declaring the SAME tag word ("alpha") — two different lanes.
   * Task A's lane holds two settled members joined by a same-lane override;
   * task B's lane holds one settled member whose override edge CROSSES into
   * task A's lane (tail in B, head in A).
   */
  function seedTwoTasksSameWord(db: Database) {
    const s1 = makeSession(db, "task-a-session");
    const s2 = makeSession(db, "task-b-session");
    const taskA = makeTask(db, "Task A", "task-a");
    const taskB = makeTask(db, "Task B", "task-b");
    insertLane(db, taskA.id, "alpha", BASE_EPOCH);
    insertLane(db, taskA.id, "beta", BASE_EPOCH);
    insertLane(db, taskB.id, "alpha", BASE_EPOCH);

    const a1 = makeTurn(db, s1, { prompt: 1, epoch: BASE_EPOCH + 100, title: "first alpha ruling", tags: ["alpha"] });
    const a2 = makeTurn(db, s1, { prompt: 2, epoch: BASE_EPOCH + 200, title: "alpha reversal", tags: ["alpha"] });
    const a3 = makeTurn(db, s1, { prompt: 3, epoch: BASE_EPOCH + 300, title: "beta base", tags: ["beta"] });
    const a4 = makeTurn(db, s1, { prompt: 4, epoch: BASE_EPOCH + 400, title: "beta override", tags: ["beta"] });
    const b1 = makeTurn(db, s2, { prompt: 1, epoch: BASE_EPOCH + 500, title: "cross corrector", tags: ["alpha"] });
    addSegmentMembers(db, taskA.id, [a1, a2, a3, a4], BASE_EPOCH);
    addSegmentMembers(db, taskB.id, [b1], BASE_EPOCH);
    settleWindow(db, s1, 1, 4);
    settleWindow(db, s2, 1, 1);

    // Same-lane override inside task A's alpha; the cross-lane override from
    // task B's alpha lands on the SAME head but has the NEWEST tail.
    makeEdge(db, a2, a1, "override", "alpha", "alpha");
    makeEdge(db, b1, a1, "override", "alpha", "alpha");
    // Same-lane override inside task A's beta (an older tail than either).
    makeEdge(db, a4, a3, "override", "beta", "beta");

    return { s1, s2, taskA, taskB, a1, a2, a3, a4, b1 };
  }

  test("each task renders its OWN section: E<n> + task-tag header, and the same tag word under two tasks is two lanes with separate denominators", () => {
    const db = makeDb();
    const { taskA, taskB } = seedTwoTasksSameWord(db);

    const sectionA = buildSegmentFrontierSection(db, taskA.id, null, 2000);
    const sectionB = buildSegmentFrontierSection(db, taskB.id, null, 2000);

    expect(sectionA.split("\n")[0]).toBe(`E${taskA.id} #task-a`);
    expect(sectionB.split("\n")[0]).toBe(`E${taskB.id} #task-b`);
    // Task A's alpha: 2 settled, ONE forward edge (a2->a1; b1's edge has a
    // tail owned by task B and never counts here), one 2-member island.
    expect(sectionA).toContain(
      `#alpha · 2 settled · 1 edges · islands 1+0 · latest override S2/T1(E${taskB.id}/#alpha) -> S1/T1`,
    );
    // Task B's alpha: 1 settled; its forward count INCLUDES the cross-lane
    // tail (b1->a1), while its island graph (both endpoints in lane) does
    // not — a settled singleton beside a real forward edge.
    expect(sectionB).toContain("#alpha · 1 settled · 1 edges · islands 0+1");
    // No pointer in B (no override HEAD in B's lane), no frontier anywhere.
    expect(sectionB).not.toContain("latest override");
    expect(sectionA).not.toContain("frontier");
    expect(sectionB).not.toContain("frontier");
    db.close();
  });

  test("same-lane override pointer renders unqualified full addresses; cross-lane pointer wins only by newest tail event order", () => {
    const db = makeDb();
    const { taskA } = seedTwoTasksSameWord(db);

    const sectionA = buildSegmentFrontierSection(db, taskA.id, null, 2000);
    // beta's only override is same-lane: no (E<n>/#tag) qualifier.
    expect(sectionA).toContain(
      "#beta · 2 settled · 1 edges · islands 1+0 · latest override S1/T4 -> S1/T3",
    );
    // alpha's pointer picked the cross-lane edge because its TAIL is newest —
    // the same-lane a2->a1 override exists but lost the recency comparison.
    expect(sectionA).toContain("(E");
    db.close();
  });

  test("six denominators under exclusions: settled = coverage (zero-edge singleton counts), edges ≠ settled, islands over settled members only, skipped/rewound/compact excluded everywhere", () => {
    const db = makeDb();
    const s1 = makeSession(db, "denominator-session");
    const task = makeTask(db, "Denominators", "denoms");
    insertLane(db, task.id, "gamma", BASE_EPOCH);

    const settledSingleton = makeTurn(db, s1, { prompt: 1, epoch: BASE_EPOCH + 100, title: "covered singleton", tags: ["gamma"] });
    const skipped = makeTurn(db, s1, { prompt: 2, epoch: BASE_EPOCH + 200, title: "skipped member", tags: ["gamma"], status: "skipped" });
    const rewound = makeTurn(db, s1, { prompt: 3, epoch: BASE_EPOCH + 300, title: "rewound member", tags: ["gamma"], rolledBack: true });
    const compact = makeTurn(db, s1, { prompt: 4, epoch: BASE_EPOCH + 400, title: "compact synthetic", tags: ["gamma", "compact:boundary"] });
    const frontierOne = makeTurn(db, s1, { prompt: 5, epoch: BASE_EPOCH + 500, title: "frontier one", tags: ["gamma"] });
    const frontierTwo = makeTurn(db, s1, { prompt: 6, epoch: BASE_EPOCH + 600, title: "frontier two", tags: ["gamma"] });
    addSegmentMembers(
      db,
      task.id,
      [settledSingleton, skipped, rewound, compact, frontierOne, frontierTwo],
      BASE_EPOCH,
    );
    // The committed window covers prompts 1-4: the singleton is settled; the
    // skipped/rewound/compact turns are covered too but excluded everywhere.
    settleWindow(db, s1, 1, 4);
    // An edge between two FRONTIER members: forward count sees it, the
    // settled count and the island graph (settled members only) never do.
    makeEdge(db, frontierTwo, frontierOne, "grounds", "gamma", "gamma");

    const section = buildSegmentFrontierSection(db, task.id, null, 2000);
    expect(section).toContain("#gamma · 1 settled · 1 edges · islands 0+1 · frontier 2");
    // The excluded turns appear in no denominator and no row.
    expect(section).not.toContain("skipped member");
    expect(section).not.toContain("rewound member");
    expect(section).not.toContain("compact synthetic");
    db.close();
  });

  test("vocabulary completeness and display order: every declared lane renders; settled lanes newest-first, zero-settled lanes last in tag order, digest-only", () => {
    const db = makeDb();
    const s1 = makeSession(db, "vocab-session");
    const task = makeTask(db, "Vocabulary", "vocab");
    insertLane(db, task.id, "mm-early", BASE_EPOCH);
    insertLane(db, task.id, "mm-late", BASE_EPOCH);
    insertLane(db, task.id, "zz-empty", BASE_EPOCH);
    insertLane(db, task.id, "aa-empty", BASE_EPOCH);

    const early = makeTurn(db, s1, { prompt: 1, epoch: BASE_EPOCH + 100, title: "early lane member", tags: ["mm-early"] });
    const late = makeTurn(db, s1, { prompt: 2, epoch: BASE_EPOCH + 200, title: "late lane member", tags: ["mm-late"] });
    addSegmentMembers(db, task.id, [early, late], BASE_EPOCH);
    settleWindow(db, s1, 1, 2);

    const section = buildSegmentFrontierSection(db, task.id, null, 2000);
    const posLate = section.indexOf("#mm-late");
    const posEarly = section.indexOf("#mm-early");
    const posAa = section.indexOf("#aa-empty");
    const posZz = section.indexOf("#zz-empty");
    expect(posLate).toBeGreaterThan(-1);
    expect(posEarly).toBeGreaterThan(posLate);
    expect(posAa).toBeGreaterThan(posEarly);
    expect(posZz).toBeGreaterThan(posAa);
    expect(section).toContain("#aa-empty · 0 settled · 0 edges · islands 0+0");
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Rows: grammar, type words, address fold, title cap, time-ascending order.
// ---------------------------------------------------------------------------

describe("frontier section: elected rows", () => {
  test("rows render `T<n> <MM-DD> <type words> <title>`: comma-joined WORDS (no emoji), session-prefix run-length fold, time-ascending, existing title cap", () => {
    const db = makeDb();
    const s1 = makeSession(db, "rows-session-one");
    const s2 = makeSession(db, "rows-session-two");
    const task = makeTask(db, "Rows", "rows-task");
    insertLane(db, task.id, "fold", BASE_EPOCH);

    const longTitle = `long tail ${"x".repeat(150)}`;
    const one = makeTurn(db, s1, { prompt: 1, epoch: BASE_EPOCH + 100, title: "alpha decision", types: ["design", "measure"], tags: ["fold"] });
    const two = makeTurn(db, s1, { prompt: 3, epoch: BASE_EPOCH + 200, title: "beta follow-up", types: ["implement"], tags: ["fold"] });
    const three = makeTurn(db, s2, { prompt: 2, epoch: BASE_EPOCH + 300, title: longTitle, tags: ["fold"] });
    addSegmentMembers(db, task.id, [one, two, three], BASE_EPOCH);
    settleWindow(db, s1, 1, 3);
    settleWindow(db, s2, 1, 2);

    const section = buildSegmentFrontierSection(db, task.id, null, 2000);
    const rows = rowLines(section);
    expect(rows).toHaveLength(3);
    // Time-ascending; fold: first row carries the session prefix, the
    // second (same session) does not, the third (new session) does again.
    expect(rows[0]).toMatch(/^S1\/T1 \d\d-\d\d design,measure alpha decision$/);
    expect(rows[1]).toMatch(/^T3 \d\d-\d\d implement beta follow-up$/);
    expect(rows[2]).toMatch(/^S2\/T2 \d\d-\d\d long tail x/);
    // Existing per-field title cap: the 160-char title was truncated.
    expect(rows[2]!.length).toBeLessThan(130);
    expect(section).not.toContain("x".repeat(120));
    // Type WORDS, never emoji.
    expect(section).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2696}\u{2699}]/u);
    db.close();
  });

  test("read grants: a readerId records one grant per shown entity (segment + accepted rows), none without a readerId", () => {
    const db = makeDb();
    const s1 = makeSession(db, "grants-session");
    const task = makeTask(db, "Grants", "grants-task");
    insertLane(db, task.id, "grant-lane", BASE_EPOCH);
    const turn = makeTurn(db, s1, { prompt: 1, epoch: BASE_EPOCH + 100, title: "granted row", tags: ["grant-lane"] });
    addSegmentMembers(db, task.id, [turn], BASE_EPOCH);
    settleWindow(db, s1, 1, 1);

    buildSegmentFrontierSection(db, task.id, null, 2000);
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM write_gate_reads").get()!.n,
    ).toBe(0);

    buildSegmentFrontierSection(db, task.id, null, 2000, "session:9", () => 777);
    const grants = db
      .query<{ entityType: string; entityId: number }, []>(
        "SELECT entity_type AS entityType, entity_id AS entityId FROM write_gate_reads ORDER BY entity_type",
      )
      .all();
    expect(grants).toEqual([
      { entityType: "segment", entityId: task.id },
      { entityType: "turn", entityId: turn },
    ]);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Candidate sequence: virtual finish times, Alabama monotonicity, tie chain,
// generation-time dedupe shift-up; single acceptance pass.
// ---------------------------------------------------------------------------

describe("frontier section: candidate sequence and acceptance", () => {
  /** Uniform-cost rows: same title, no types, one session, 1-digit prompts. */
  function seedPools(db: Database, pools: Record<string, number[]>) {
    const s1 = makeSession(db, "pool-session");
    const task = makeTask(db, "Pools", "pool-task");
    const turnIds: number[] = [];
    let maxPrompt = 0;
    for (const [tag, prompts] of Object.entries(pools)) {
      insertLane(db, task.id, tag, BASE_EPOCH);
      for (const prompt of prompts) {
        turnIds.push(
          makeTurn(db, s1, {
            prompt,
            epoch: BASE_EPOCH + prompt * 100,
            title: "milestone seat",
            tags: [tag],
          }),
        );
        maxPrompt = Math.max(maxPrompt, prompt);
      }
    }
    addSegmentMembers(db, task.id, turnIds, BASE_EPOCH);
    settleWindow(db, s1, 1, maxPrompt);
    return task;
  }

  /**
   * Uniform-cost variant for the sequence-property fixtures: ONE member per
   * session (prompt 1 each), so every row always renders with a full
   * `S<k>/T1` prefix and every accepted set of size n costs the same —
   * acceptance then reveals the SEQUENCE prefix exactly. (With shared
   * sessions the run-length fold makes same-lane rows cheaper, and the
   * spec's own honesty note applies: hard-budget acceptance may skew seat
   * counts when row costs differ — that is not the property under test
   * here.)
   */
  function seedPoolsOneSessionEach(db: Database, pools: Record<string, number>) {
    const task = makeTask(db, "Pools", "pool-task");
    const turnIds: number[] = [];
    let sessionIndex = 0;
    const laneSessions = new Map<string, number[]>();
    for (const [tag, count] of Object.entries(pools)) {
      insertLane(db, task.id, tag, BASE_EPOCH);
      const sessions: number[] = [];
      for (let i = 0; i < count; i += 1) {
        sessionIndex += 1;
        const sessionId = makeSession(db, `pool-session-${sessionIndex}`);
        sessions.push(sessionId);
        turnIds.push(
          makeTurn(db, sessionId, {
            prompt: 1,
            epoch: BASE_EPOCH + sessionIndex * 100,
            title: "milestone seat",
            tags: [tag],
          }),
        );
        settleWindow(db, sessionId, 1, 1);
      }
      laneSessions.set(tag, sessions);
    }
    addSegmentMembers(db, task.id, turnIds, BASE_EPOCH);
    return { task, laneSessions };
  }

  test("Alabama fixture (5:3:1 pools): the accepted prefix grows monotonically and the 1-member lane's seat, once granted, is never dropped as acceptance extends", () => {
    const db = makeDb();
    const { task, laneSessions } = seedPoolsOneSessionEach(db, { aaa: 5, bbb: 3, ccc: 1 });
    const cccSession = laneSessions.get("ccc")![0]!;
    const render = (budget: number) => buildSegmentFrontierSection(db, task.id, null, budget);
    const full = render(100_000);
    expect(rowLines(full)).toHaveLength(9);
    const hi = countTokens(full) + 8;

    const seatedSessions = (budget: number): Set<string> =>
      new Set(rowLines(render(budget)).map((line) => line.match(/^S(\d+)\//)![1]!));
    let previous = new Set<string>();
    let cccSeen = false;
    let firstCccBudget = -1;
    for (let budget = 1; budget <= hi; budget += 1) {
      const current = seatedSessions(budget);
      for (const address of previous) {
        expect(current.has(address)).toBe(true);
      }
      if (cccSeen) {
        expect(current.has(String(cccSession))).toBe(true);
      }
      if (!cccSeen && current.has(String(cccSession))) {
        cccSeen = true;
        firstCccBudget = budget;
      }
      previous = current;
    }
    expect(cccSeen).toBe(true);

    // T2220's ordering seats the 1-pool lane at virtual finish 1.0 — the
    // LAST seat of the 9-seat prefix (ties resolve larger-pool first): the
    // first budget that seats ccc's member seats all nine.
    expect(rowLines(render(firstCccBudget))).toHaveLength(9);
    db.close();
  });

  test("virtual-finish tie chain: equal finish times go to the larger pool first, then tag-lexicographic among equal pools", () => {
    const db = makeDb();
    // aa(2) sessions s1,s2 · bb(2) s3,s4 · cc(1) s5 (uniform row costs).
    // First seat: aa vs bb tie at 1/2 → tag lex → aa's top (its newest, s2).
    // Third seat: aa j=2 (1.0) vs bb j=2 (1.0) vs cc j=1 (1.0) → larger pool
    // wins over cc → tag lex → aa's s1.
    const { task, laneSessions } = seedPoolsOneSessionEach(db, { aa: 2, bb: 2, cc: 1 });
    const [aaOld, aaNew] = laneSessions.get("aa")!;
    const [, bbNew] = laneSessions.get("bb")!;
    const [ccOnly] = laneSessions.get("cc")!;
    const render = (budget: number) => buildSegmentFrontierSection(db, task.id, null, budget);
    const hi = countTokens(render(100_000)) + 8;
    const seatedSessions = (budget: number): string[] =>
      rowLines(render(budget)).map((line) => line.match(/^S(\d+)\//)![1]!);

    const oneSeat = minBudgetForRows(render, 1, hi);
    expect(seatedSessions(oneSeat)).toEqual([String(aaNew)]);

    const threeSeats = minBudgetForRows(render, 3, hi);
    const seated = new Set(seatedSessions(threeSeats));
    expect(seated).toEqual(new Set([String(aaNew), String(bbNew), String(aaOld)]));
    expect(seated.has(String(ccOnly))).toBe(false);
    db.close();
  });

  test("generation-time dedupe: a turn in two lanes is sequenced ONCE, and the losing lane's later candidate shifts up into the freed j-slot", () => {
    const db = makeDb();
    // One member per session (uniform row costs — see seedPoolsOneSessionEach).
    const s1 = makeSession(db, "dedupe-session-d");
    const s2 = makeSession(db, "dedupe-session-g");
    const s3 = makeSession(db, "dedupe-session-e");
    const task = makeTask(db, "Dedupe", "dedupe-task");
    insertLane(db, task.id, "xx", BASE_EPOCH);
    insertLane(db, task.id, "yy", BASE_EPOCH);
    // D (newest) tops BOTH lanes; xx also holds G, yy also holds E.
    const dTurn = makeTurn(db, s1, { prompt: 1, epoch: BASE_EPOCH + 300, title: "milestone seat", tags: ["xx", "yy"] });
    const gTurn = makeTurn(db, s2, { prompt: 1, epoch: BASE_EPOCH + 100, title: "milestone seat", tags: ["xx"] });
    const eTurn = makeTurn(db, s3, { prompt: 1, epoch: BASE_EPOCH + 200, title: "milestone seat", tags: ["yy"] });
    addSegmentMembers(db, task.id, [dTurn, gTurn, eTurn], BASE_EPOCH);
    settleWindow(db, s1, 1, 1);
    settleWindow(db, s2, 1, 1);
    settleWindow(db, s3, 1, 1);

    const render = (budget: number) => buildSegmentFrontierSection(db, task.id, null, budget);
    const full = render(100_000);
    // Dedupe: D renders exactly once across the whole block.
    expect(full.match(new RegExp(`^S${s1}/T1 `, "gm")) ?? []).toHaveLength(1);
    expect(rowLines(full)).toHaveLength(3);

    // Sequence is D (xx j=1, tag-lex over yy at the tie), then yy's j=1 —
    // which is E after the dedupe SHIFT-UP (D was dropped where
    // encountered), NOT nothing-until-j=2. At two seats: {D, E}, no G.
    const hi = countTokens(full) + 8;
    const twoSeats = minBudgetForRows(render, 2, hi);
    const seated = new Set(rowLines(render(twoSeats)).map((line) => line.match(/^S(\d+)\//)![1]!));
    expect(seated).toEqual(new Set([String(s1), String(s3)]));
    db.close();
  });

  test("no oscillation: a top-ranked candidate too large for the budget is rejected once, the scan continues, and a cheaper later candidate is accepted; byte-deterministic", () => {
    const db = makeDb();
    const s1 = makeSession(db, "oscillation-session");
    const task = makeTask(db, "Oscillation", "osc-task");
    insertLane(db, task.id, "osc", BASE_EPOCH);
    const cheap = makeTurn(db, s1, { prompt: 1, epoch: BASE_EPOCH + 100, title: "cheap row", tags: ["osc"] });
    const expensive = makeTurn(db, s1, {
      prompt: 2,
      epoch: BASE_EPOCH + 200,
      // Newest → top-ranked (+3 recency); enormously more expensive to render.
      title: `expensive ruling ${"詳細な決定の記録 ".repeat(30)}`,
      tags: ["osc"],
    });
    addSegmentMembers(db, task.id, [cheap, expensive], BASE_EPOCH);
    settleWindow(db, s1, 1, 2);

    const render = (budget: number) => buildSegmentFrontierSection(db, task.id, null, budget);
    const hi = countTokens(render(100_000)) + 8;
    const oneSeat = minBudgetForRows(render, 1, hi);
    const block = render(oneSeat);
    // The seat went to the CHEAP, lower-ranked candidate: the expensive
    // top-ranked one was rejected and the scan continued past it.
    expect(rowLines(block)).toHaveLength(1);
    expect(block).toContain("cheap row");
    expect(block).not.toContain("expensive ruling");
    expect(block).not.toContain("[overflow");
    // Same corpus, same budget ⇒ identical bytes.
    expect(render(oneSeat)).toBe(block);
    expect(render(100_000)).toBe(render(100_000));
    db.close();
  });

  test("budget enforcement is by the runtime tokenizer: every non-overflow render measures within its budget by countTokens", () => {
    const db = makeDb();
    const task = seedPools(db, { aaa: [1, 2, 3, 4, 5], bbb: [6, 7, 8], ccc: [9] });
    for (const budget of [150, 300, 700, 2000]) {
      const section = buildSegmentFrontierSection(db, task.id, null, budget);
      expect(section).not.toContain("[overflow");
      expect(countTokens(section)).toBeLessThanOrEqual(budget);
    }
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Scorer arithmetic — one property per fixture, observed at the seam through
// the single-seat budget (all probe rows are token-cost-equal by
// construction, asserted below, so ONLY the election order decides the seat).
// ---------------------------------------------------------------------------

interface ProbeEdgeSpec {
  direction: "out" | "in";
  relation: CitationRelation;
  /** OUT only: overrides the stored tail tag (the qualified-coordinate probe). */
  tailTagOverride?: string;
}

interface ProbeMemberSpec {
  types?: string[];
  title?: string;
  edges?: ProbeEdgeSpec[];
}

/**
 * One lane ("probe"), two settled members — A older (prompt 1, recency +2),
 * B newer (prompt 2, recency +3) — plus a helper task ("zeta") providing
 * cross-lane edge endpoints that cannot contaminate the probe lane's
 * in-scores. Returns which member takes the lane's FIRST seat.
 */
function firstSeatProbe(
  a: ProbeMemberSpec,
  b: ProbeMemberSpec,
  options: { extraLaneOnA?: string } = {},
): "A" | "B" {
  const db = makeDb();
  const s1 = makeSession(db, "probe-session");
  const s2 = makeSession(db, "zeta-session");
  const taskP = makeTask(db, "Probe task", "probe-task");
  const taskZ = makeTask(db, "Zeta task", "zeta-task");
  insertLane(db, taskP.id, "probe", BASE_EPOCH);
  insertLane(db, taskZ.id, "zeta", BASE_EPOCH);
  if (options.extraLaneOnA) {
    insertLane(db, taskP.id, options.extraLaneOnA, BASE_EPOCH);
  }

  const aTags = ["probe", ...(options.extraLaneOnA ? [options.extraLaneOnA] : [])];
  const turnA = makeTurn(db, s1, {
    prompt: 1,
    epoch: BASE_EPOCH + 100,
    title: a.title ?? "probe row",
    types: a.types,
    tags: aTags,
  });
  const turnB = makeTurn(db, s1, {
    prompt: 2,
    epoch: BASE_EPOCH + 200,
    title: b.title ?? "probe row",
    types: b.types,
    tags: ["probe"],
  });
  addSegmentMembers(db, taskP.id, [turnA, turnB], BASE_EPOCH);
  settleWindow(db, s1, 1, 2);

  let zetaPrompt = 0;
  const zetaTurn = (): number => {
    zetaPrompt += 1;
    const id = makeTurn(db, s2, {
      prompt: zetaPrompt,
      epoch: BASE_EPOCH + zetaPrompt,
      title: "zeta endpoint",
      tags: ["zeta"],
    });
    addSegmentMembers(db, taskZ.id, [id], BASE_EPOCH);
    return id;
  };
  for (const [memberTurn, spec] of [
    [turnA, a],
    [turnB, b],
  ] as const) {
    for (const edge of spec.edges ?? []) {
      const endpoint = zetaTurn();
      if (edge.direction === "out") {
        makeEdge(db, memberTurn, endpoint, edge.relation, edge.tailTagOverride ?? "probe", "zeta");
      } else {
        makeEdge(db, endpoint, memberTurn, edge.relation, "zeta", "probe");
      }
    }
  }

  const render = (budget: number) => buildSegmentFrontierSection(db, taskP.id, null, budget);
  const full = render(100_000);
  const fullRows = rowLines(full);
  expect(fullRows.length).toBeGreaterThanOrEqual(2);

  // Cost parity guard: both candidates' single-row blocks must price
  // identically, so the seat below can only be decided by election order.
  const base = (() => {
    const hi = countTokens(full) + 8;
    const oneSeat = minBudgetForRows(render, 1, hi);
    const zeroRowBlock = render(oneSeat - 1);
    expect(rowLines(zeroRowBlock)).toHaveLength(0);
    return { oneSeat, zeroRowBlock };
  })();
  const prefixed = (line: string): string =>
    line.startsWith("S") ? line : `S${s1}/${line}`;
  const lineA = prefixed(fullRows.find((line) => /^(?:S\d+\/)?T1 /.test(line))!);
  const lineB = prefixed(fullRows.find((line) => /^(?:S\d+\/)?T2 /.test(line))!);
  expect(countTokens(`${base.zeroRowBlock}\n${lineA}`)).toBe(
    countTokens(`${base.zeroRowBlock}\n${lineB}`),
  );

  const seat = rowLines(render(base.oneSeat));
  expect(seat).toHaveLength(1);
  const winner = /^(?:S\d+\/)?T1 /.test(seat[0]!) ? "A" : "B";
  db.close();
  return winner;
}

describe("frontier section: frozen scorer arithmetic (one property per fixture)", () => {
  // Recency baseline: pool of 2 gives A(older) +2, B(newer) +3.
  test("tie goes NEWER first (total order created_at desc)", () => {
    expect(firstSeatProbe({}, {})).toBe("B");
  });

  // -- type weights ---------------------------------------------------------
  test("design outweighs correction by exactly 1: design+2 ties correction+3, newer wins", () => {
    expect(firstSeatProbe({ types: ["design"] }, { types: ["correction"] })).toBe("B");
  });
  test("design beats measure by 2: design+2 > measure+3", () => {
    expect(firstSeatProbe({ types: ["design"] }, { types: ["measure"] })).toBe("A");
  });
  test("correction outweighs measure by exactly 1: correction+2 ties measure+3", () => {
    expect(firstSeatProbe({ types: ["correction"] }, { types: ["measure"] })).toBe("B");
  });
  test("correction is worth 2: correction+2 beats bare +3", () => {
    expect(firstSeatProbe({ types: ["correction"] }, { title: "probe row x" })).toBe("A");
  });
  test("measure is worth exactly 1: measure+2 ties bare +3", () => {
    expect(firstSeatProbe({ types: ["measure"] }, { title: "probe row x" })).toBe("B");
  });
  test("multi-type SUMS (not max): correction+measure (3) + 2 beats measure (1) + 3", () => {
    expect(
      firstSeatProbe(
        { types: ["correction", "measure"] },
        { types: ["measure"], title: "probe row word here" },
      ),
    ).toBe("A");
  });

  // -- lane-local OUT-edge weights (targets cross-lane: no in-score bleed) --
  test("out override (2) ties out grounds (1) + newer", () => {
    expect(
      firstSeatProbe(
        { edges: [{ direction: "out", relation: "override" }] },
        { edges: [{ direction: "out", relation: "grounds" }] },
      ),
    ).toBe("B");
  });
  test("out override is worth 2: override+2 beats bare +3", () => {
    expect(firstSeatProbe({ edges: [{ direction: "out", relation: "override" }] }, {})).toBe("A");
  });
  test("out indexes (2) ties out verifies (1) + newer", () => {
    expect(
      firstSeatProbe(
        { edges: [{ direction: "out", relation: "indexes" }] },
        { edges: [{ direction: "out", relation: "verifies" }] },
      ),
    ).toBe("B");
  });
  test("out indexes is worth 2: indexes+2 beats bare +3", () => {
    expect(firstSeatProbe({ edges: [{ direction: "out", relation: "indexes" }] }, {})).toBe("A");
  });
  test("out grounds is worth exactly 1: grounds+2 ties bare +3; two grounds beat it", () => {
    expect(firstSeatProbe({ edges: [{ direction: "out", relation: "grounds" }] }, {})).toBe("B");
    expect(
      firstSeatProbe(
        {
          edges: [
            { direction: "out", relation: "grounds" },
            { direction: "out", relation: "grounds" },
          ],
        },
        {},
      ),
    ).toBe("A");
  });
  test("out verifies is worth exactly 1", () => {
    expect(firstSeatProbe({ edges: [{ direction: "out", relation: "verifies" }] }, {})).toBe("B");
    expect(
      firstSeatProbe(
        {
          edges: [
            { direction: "out", relation: "verifies" },
            { direction: "out", relation: "verifies" },
          ],
        },
        {},
      ),
    ).toBe("A");
  });
  test("out narrows is worth exactly 1", () => {
    expect(firstSeatProbe({ edges: [{ direction: "out", relation: "narrows" }] }, {})).toBe("B");
    expect(
      firstSeatProbe(
        {
          edges: [
            { direction: "out", relation: "narrows" },
            { direction: "out", relation: "narrows" },
          ],
        },
        {},
      ),
    ).toBe("A");
  });
  test("out extends and consume are worth 0: both together still lose the tie only on recency", () => {
    expect(
      firstSeatProbe(
        {
          types: ["measure"],
          edges: [
            { direction: "out", relation: "extends" },
            { direction: "out", relation: "consume" },
          ],
        },
        { title: "probe row x" },
      ),
    ).toBe("B");
  });

  // -- lane-local IN-edge weights (sources cross-lane) ----------------------
  test("in verifies (2) ties in narrows (1) + newer; beats bare", () => {
    expect(
      firstSeatProbe(
        { edges: [{ direction: "in", relation: "verifies" }] },
        { edges: [{ direction: "in", relation: "narrows" }] },
      ),
    ).toBe("B");
    expect(firstSeatProbe({ edges: [{ direction: "in", relation: "verifies" }] }, {})).toBe("A");
  });
  test("in grounds (2) ties in narrows (1) + newer; beats bare", () => {
    expect(
      firstSeatProbe(
        { edges: [{ direction: "in", relation: "grounds" }] },
        { edges: [{ direction: "in", relation: "narrows" }] },
      ),
    ).toBe("B");
    expect(firstSeatProbe({ edges: [{ direction: "in", relation: "grounds" }] }, {})).toBe("A");
  });
  test("in indexes is worth exactly 1", () => {
    expect(firstSeatProbe({ edges: [{ direction: "in", relation: "indexes" }] }, {})).toBe("B");
    expect(
      firstSeatProbe(
        {
          edges: [
            { direction: "in", relation: "indexes" },
            { direction: "in", relation: "indexes" },
          ],
        },
        {},
      ),
    ).toBe("A");
  });
  test("in narrows is worth exactly 1", () => {
    expect(firstSeatProbe({ edges: [{ direction: "in", relation: "narrows" }] }, {})).toBe("B");
    expect(
      firstSeatProbe(
        {
          edges: [
            { direction: "in", relation: "narrows" },
            { direction: "in", relation: "narrows" },
          ],
        },
        {},
      ),
    ).toBe("A");
  });
  test("in override is worth 0 (overrider signal lives in out-degree): measure+in-override+2 ties bare +3", () => {
    expect(
      firstSeatProbe(
        { types: ["measure"], edges: [{ direction: "in", relation: "override" }] },
        { title: "probe row x" },
      ),
    ).toBe("B");
  });

  // -- qualified lane-local coordinates -------------------------------------
  test("an out-edge tagged for A's OTHER lane scores nothing in the probe lane (qualified tail tag must equal THIS lane)", () => {
    // With the tail tag on "other", the override's 2 points belong to the
    // other lane: A stays at +2, B's +3 wins. A naive bare-string or
    // any-out-edge scorer would seat A.
    expect(
      firstSeatProbe(
        { edges: [{ direction: "out", relation: "override", tailTagOverride: "other" }] },
        {},
        { extraLaneOnA: "other" },
      ),
    ).toBe("B");
  });
});

// ---------------------------------------------------------------------------
// The vocabulary floor: digests always render; rows drop first; pointers
// omit whole-field in REVERSE display order; then the self-including
// overflow marker (digit-width fixed point included).
// ---------------------------------------------------------------------------

describe("frontier section: vocabulary floor", () => {
  function seedFloorWorld(db: Database) {
    const s1 = makeSession(db, "floor-session");
    const task = makeTask(db, "Floor", "floor-task");
    const lanes = ["lane-alpha", "lane-bravo", "lane-carol", "lane-delta"];
    let prompt = 0;
    for (const tag of lanes) {
      insertLane(db, task.id, tag, BASE_EPOCH);
      const older = makeTurn(db, s1, {
        prompt: (prompt += 1),
        epoch: BASE_EPOCH + prompt * 100,
        title: "floor member",
        tags: [tag],
      });
      const newer = makeTurn(db, s1, {
        prompt: (prompt += 1),
        epoch: BASE_EPOCH + prompt * 100,
        title: "floor member",
        tags: [tag],
      });
      addSegmentMembers(db, task.id, [older, newer], BASE_EPOCH);
      // A same-lane override gives every lane a pointer field to shed.
      makeEdge(db, newer, older, "override", tag, tag);
    }
    settleWindow(db, s1, 1, prompt);
    return task;
  }

  test("floor ladder: below the digest cost rows are gone but every lane's digest still renders; pointers omit whole-field as a suffix of display order; the overflow marker is a self-including fixed point across digit widths", () => {
    const db = makeDb();
    const task = seedFloorWorld(db);
    const render = (budget: number) => buildSegmentFrontierSection(db, task.id, null, budget);

    const hi = countTokens(render(100_000)) + 8;
    const oneSeat = minBudgetForRows(render, 1, hi);
    const digestOnly = render(oneSeat - 1);
    expect(rowLines(digestOnly)).toHaveLength(0);
    const digestTokens = countTokens(digestOnly);
    // The full digest block carries all four pointers.
    expect(digestOnly.match(/latest override/g)).toHaveLength(4);

    // Display order of the lanes in the digest-only block (newest settled
    // desc): the pointer-omission ladder must walk it in REVERSE.
    const displayOrder = digestOnly
      .split("\n")
      .filter((line) => line.startsWith("#lane-"))
      .map((line) => line.split(" ")[0]!);
    expect(displayOrder).toEqual(["#lane-delta", "#lane-carol", "#lane-bravo", "#lane-alpha"]);

    const markers: number[] = [];
    let sawPartialOmission = false;
    for (let budget = digestTokens - 1; budget >= digestTokens - 90 && budget >= 1; budget -= 1) {
      const block = render(budget);
      // The vocabulary never shrinks: all four digests, no rows, in every branch.
      expect(rowLines(block)).toHaveLength(0);
      for (const laneHeader of displayOrder) {
        expect(block).toContain(`${laneHeader} · 2 settled`);
      }
      // Pointer omission is a suffix of display order (REVERSE-order
      // omission): if a lane still has its pointer, every lane displayed
      // AFTER it may be pointer-less, but no lane BEFORE it may be.
      const pointerless = displayOrder.filter(
        (laneHeader) =>
          !new RegExp(`^${laneHeader.replace("#", "\\#")} .*latest override`, "m").test(block),
      );
      const suffix = displayOrder.slice(displayOrder.length - pointerless.length);
      expect(pointerless).toEqual(suffix);
      if (pointerless.length > 0 && pointerless.length < displayOrder.length) {
        sawPartialOmission = true;
      }

      const marker = block.match(/\[overflow \+(\d+) tok\]/);
      if (marker) {
        const stated = Number(marker[1]);
        markers.push(stated);
        // Self-including fixed point: the FINAL rendering, marker included,
        // exceeds the budget by exactly the number the marker states.
        expect(countTokens(block) - budget).toBe(stated);
        // Once over budget, every pointer has already been shed.
        expect(block).not.toContain("latest override");
        // The marker rides the section header line.
        expect(block.split("\n")[0]).toContain(`E${task.id} #floor-task [overflow +${stated} tok]`);
      }
    }
    expect(sawPartialOmission).toBe(true);
    // The sweep crossed the marker's digit-width boundary: both 1-digit and
    // 2-digit overflow counts appeared, each self-consistent (asserted above).
    expect(markers.length).toBeGreaterThan(0);
    expect(Math.min(...markers)).toBeLessThan(10);
    expect(Math.max(...markers)).toBeGreaterThan(9);
    db.close();
  });

  test("byte determinism holds in the floor branch too", () => {
    const db = makeDb();
    const task = seedFloorWorld(db);
    const atTinyBudget = () => buildSegmentFrontierSection(db, task.id, null, 20);
    expect(atTinyBudget()).toBe(atTinyBudget());
    db.close();
  });
});
