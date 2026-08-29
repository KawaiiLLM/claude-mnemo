import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { deriveSideTags, writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import { addSegmentMembers, createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import {
  buildSegmentTimelineView,
  buildTimelineView,
  renderSegmentTimeline,
  renderTimeline,
  timelineQuery,
} from "../../src/mcp/timeline";

/**
 * Milestone-election spec, ticket 03: `selectMilestoneTurns` (S-view) and
 * `selectSegmentMilestonesByEdgeSignals` (E-view / SessionStart-injected
 * milestones) both now delegate the whole election to
 * `shared/milestone-election.ts`'s `electMilestones`. The always-keep chain
 * (endpoints ∪ correctors ∪ reversed ∪ era-G4), effGrade spine admission, era
 * gating (`isTaskCausalityEra` as a CANDIDACY gate), and the pulled-
 * antecedent pull-through machinery all leave the election path outright —
 * this is the ticket's own acceptance criterion, made durable, in the same
 * two-part shape `tests/shared/flow-readside-retirement.test.ts` (rubric-v10
 * ticket 04) established:
 *
 *   1. STATIC — no functional (non-comment, non-string) reference to any
 *      retired election-chain identifier survives anywhere in `src/`. What
 *      this actually guarantees is narrower than "no equivalent logic
 *      exists anywhere" (R1 #12, pre-release repair, corrects an earlier
 *      overclaim here): it is a literal-identifier blacklist — a
 *      grade-driven or always-keep admission rule reintroduced under NEW
 *      names would call none of these and would sail through this check
 *      undetected. The static half only proves the OLD names are gone; the
 *      behavioral half below is what actually exercises election
 *      correctness independent of naming, and is the real guard against a
 *      renamed reimplementation.
 *   2. BEHAVIORAL — the election is provably grade-free and structurally
 *      driven: opposed `significance_grade` scrambles never move a contested
 *      seat (S-view AND E-view — R1 #12 adds the E-view half, previously
 *      untested here), and a candidacy-excluded turn (an override
 *      target) never renders on either route, whatever grade it carries.
 *
 * Grading itself is untouched (settlement/other consumers may still read
 * `significanceGrade` for their own purposes) — only its role in MILESTONE
 * SELECTION is gone, which is exactly what the behavioral half proves.
 */

const SRC_ROOT = join(import.meta.dir, "..", "..", "src");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const BACKTICK = String.fromCharCode(96);
const TEMPLATE_LITERAL_RE = new RegExp(`${BACKTICK}(?:[^${BACKTICK}\\\\]|\\\\.)*${BACKTICK}`, "g");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function stripCommentsAndStrings(source: string): string {
  return stripComments(source)
    .replace(TEMPLATE_LITERAL_RE, "TPL")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

describe("milestone-election read-side retirement (milestone-election spec, ticket 03)", () => {
  const files = listTsFiles(SRC_ROOT);

  test("no functional (non-comment, non-string) reference to a retired election-chain identifier survives in src/", () => {
    // The always-keep/effGrade/pull-through chain `selectMilestoneTurns`
    // used to run itself, plus the lexicographic edge-signal chain
    // `selectSegmentMilestonesByEdgeSignals` used to run — one pattern
    // covering both retired chains, since ticket 03 retires them together.
    const pattern =
      /\bmilestoneEffGrade\b|\blegacyEffGrade\b|\bmilestoneTieBreak\b|\bbuildCorrectionGraph\b|\bCorrectionGraph\b|\bPulledAntecedent\b|\bpulledAntecedentLabel\b|\bMILESTONE_SPINE_MIN_EFF_GRADE\b|\bMILESTONE_POOL_MIN_EFF_GRADE\b|\bMILESTONE_PULL_MAX_EFF_GRADE\b|\bMILESTONE_LEGACY_TYPE_GRADE\b|\bMILESTONE_LEGACY_GRADE_CAP\b|\bMILESTONE_PULLED_LABEL_CAP\b|\bisAlwaysKeep\b|\bcompareEdgeSignalRank\b/;
    const offenders: string[] = [];
    for (const file of files) {
      const code = stripCommentsAndStrings(readFileSync(file, "utf8"));
      if (pattern.test(code)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("src/mcp/timeline.ts no longer reads `getTurnEdgeSignals`/era gating as a CANDIDACY signal", () => {
    // `db/edge-signals.ts` itself, and its own unit tests, are untouched —
    // only timeline.ts's own use of it (the retired lexicographic rule)
    // matters here. `isTaskCausalityEra` left timeline.ts's own election
    // path entirely (it never governed `selectMilestoneTurns`'s legacy body
    // either, so this is a full-file check, not a scoped one).
    const code = stripCommentsAndStrings(
      readFileSync(join(SRC_ROOT, "mcp", "timeline.ts"), "utf8"),
    );
    expect(code).not.toMatch(/\bgetTurnEdgeSignals\b/);
    expect(code).not.toMatch(/\bTurnEdgeSignals\b/);
    expect(code).not.toMatch(/\bisTaskCausalityEra\b/);
  });
});

describe("election is provably grade-free and structural (behavioral, ticket 03)", () => {
  let db: Database;
  let sessionId: number;
  const CUTOFF = 1_950_000_000;

  // phase-connectivity ticket 03 (arm C): `type` defaults to `["design"]`
  // here, same as every other fixture in this file — harmless for every test
  // in this describe block except the two R1 #7 ones below, which need a
  // NON-decision type on the turns whose relative tier they mean to isolate
  // (see those tests' own `["ops"]` overrides).
  const insertTurn = (promptNumber: number, title: string, type: string[] = ["design"]): number =>
    db
      .query<{ id: number }, [number, number, string, string]>(
        `INSERT INTO turns (session_id, prompt_number, status, type, title, content, created_at_epoch)
         VALUES (?, ?, 'extracted', ?, ?, 'body', ?)
         RETURNING id`,
      )
      .get(sessionId, promptNumber, JSON.stringify(type), title, CUTOFF + promptNumber)!.id;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "election-retirement-fixture",
      project: "/tmp/election-retirement-fixture",
      title: "election retirement fixture",
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: CUTOFF,
      updatedAtEpoch: CUTOFF,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("S-view: opposed significance_grade assignments never move a contested seat", () => {
    // Three plain turns, no lane edges: every candidate is tier ⑤, so the
    // election's own within-tier order (in/out-degree tie, then the LATER
    // turn) has to decide, with no grade term anywhere in the comparison.
    //
    // Page-budget-is-the-seat-count spec, decision 1: `selectMilestoneTurns`
    // no longer truncates by any caller-supplied number — `kept` is every
    // window candidate now, unbounded. Reading `score` (election rank,
    // higher wins — `compareMilestoneRank`) directly off `pagedMilestones` is
    // therefore a MORE direct probe of "which seat wins the contest" than
    // forcing a render-time token-budget cut down to one row: it reads the
    // rank the election itself assigned, with no render-time day-frame
    // collapsing (`createMilestoneBodyModel`) in the way.
    const t1 = insertTurn(1, "first");
    const t2 = insertTurn(2, "second");
    const t3 = insertTurn(3, "third");

    const topRankedPromptNumber = (): number => {
      const view = buildTimelineView(db, { id: `S${sessionId}`, view: "milestones" });
      const [top] = [...view.pagedMilestones].sort((a, b) => b.score - a.score);
      return top!.turn.promptNumber;
    };
    const setGrades = (grade: (id: number) => number) => {
      for (const id of [t1, t2, t3]) {
        db.query<unknown, [number, number]>(
          "UPDATE turns SET significance_grade = ? WHERE id = ?",
        ).run(grade(id), id);
      }
    };

    const ungraded = topRankedPromptNumber();
    setGrades((id) => (id === t1 ? 4 : id === t2 ? 2 : 0));
    const ascending = topRankedPromptNumber();
    setGrades((id) => (id === t1 ? 0 : id === t2 ? 2 : 4));
    const descending = topRankedPromptNumber();

    expect(ascending).toBe(ungraded);
    expect(descending).toBe(ungraded);
    // The seat really is contested — the later turn (T3, recency) wins it,
    // not whichever grade scramble happened to favor T1 or T3.
    expect(ungraded).toBe(3);
  });

  test("E-view: opposed significance_grade assignments never move a contested seat (R1 #12 — previously S-view only)", () => {
    // Same structure as the S-view test above, read through the segment
    // route instead: three plain, edge-free members means every candidate is
    // tier ⑤, so only the election's own within-tier order can decide, with
    // no grade term anywhere in the comparison.
    const t1 = insertTurn(1, "first");
    const t2 = insertTurn(2, "second");
    const t3 = insertTurn(3, "third");
    const segment = createSegment(db, {
      title: "grade-permutation segment",
      type: ["design"],
      nowEpoch: CUTOFF,
    });
    addSegmentMembers(db, segment.id, [t1, t2, t3], CUTOFF);

    // Page-budget-is-the-seat-count spec, decision 1/8: a tight `pageBudget`
    // forces the genuine single-seat contest `pageSize: 1` used to (the
    // row-admission budget reserves a fixed allowance for the
    // header/pointer/legend this selector does not itself render — see
    // `selectSegmentMilestonesByEdgeSignals`'s own doc comment). Measured
    // against this fixture: budget 191 (honest-token-pricing ticket 04
    // re-measured; was 365 under the old diary weights; re-measured again
    // at 191, was 195, by ticket 11's USER RULING S15069/T2016 — every row is
    // a couple bytes cheaper once its own address drops its brackets, which
    // shifts a threshold measured to the byte) seats exactly one of
    // the three rows.
    const query = () =>
      renderSegmentTimeline(
        buildSegmentTimelineView(db, { segmentId: segment.id, view: "milestones", pageBudget: 191 }),
      );
    const setGrades = (grade: (id: number) => number) => {
      for (const id of [t1, t2, t3]) {
        db.query<unknown, [number, number]>(
          "UPDATE turns SET significance_grade = ? WHERE id = ?",
        ).run(grade(id), id);
      }
    };

    const ungraded = query();
    setGrades((id) => (id === t1 ? 4 : id === t2 ? 2 : 0));
    const ascending = query();
    setGrades((id) => (id === t1 ? 0 : id === t2 ? 2 : 4));
    const descending = query();

    expect(ascending).toBe(ungraded);
    expect(descending).toBe(ungraded);
    expect(ungraded).toContain("T3 ");
    expect(ungraded).not.toContain("T1 ");
    expect(ungraded).not.toContain("T2 ");
  });

  // lane-model-v12 ticket 04: an override target is no longer excluded from
  // candidacy (global repudiation is deleted), so it renders. What this test
  // still proves is the thing it was written for — the render is GRADE-FREE:
  // a grade-4 victim gets no special standing, it simply competes as an
  // ordinary tier-⑤ candidate alongside its overrider.
  test("an override target renders like any other candidate, and its grade buys it nothing", () => {
    const victim = insertTurn(1, "the overridden conclusion");
    const overrider = insertTurn(2, "overrides it");
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: overrider },
          cited: { kind: "turn", id: victim },
          relation: "override",
          provenance: "asserted",
        },
      ],
      CUTOFF,
    );
    db.query("UPDATE turns SET significance_grade = 4 WHERE id = ?").run(victim);

    const sOutput = renderTimeline(
      buildTimelineView(db, { id: `S${sessionId}`, view: "milestones" }),
    );
    expect(sOutput).toContain("the overridden conclusion");
    expect(sOutput).toContain("overrides it");

    // Grade-free: dropping the victim's grade to 0 changes nothing about the
    // render, which is the property this test exists for.
    db.query("UPDATE turns SET significance_grade = 0 WHERE id = ?").run(victim);
    const regraded = renderTimeline(
      buildTimelineView(db, { id: `S${sessionId}`, view: "milestones" }),
    );
    expect(regraded).toBe(sOutput);
  });

  test("R1 #7 — S-view: a citer of a rolled-back turn tiers ⑤ (corrector), winning a contested budget-1 seat its own zero degree could never win alone", () => {
    // T1 will be rolled back; T2 `verifies` it (any relation qualifies —
    // corrector detection is relation-agnostic). T3 is a later, edge-free
    // bystander. Without R1 #7, T2's citing edge to T1 is invisible (T1
    // fails the live-turn-scoped getRelationEdgesAmongTurns filter), so T2
    // has zero degree, ties T3 at tier ⑥, and LOSES to T3 on recency — the
    // exact bug this pins. T2/T3 are typed `["ops"]`, not the describe
    // block's default `["design"]` (phase-connectivity ticket 03): a design
    // type would seat BOTH at the new tier ③ regardless of the corrector
    // fact, masking exactly the mechanism this test exists to prove.
    const reversed = insertTurn(1, "the reversed conclusion");
    const citer = insertTurn(2, "verifies it", ["ops"]);
    insertTurn(3, "unrelated later bystander", ["ops"]);
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: citer },
          cited: { kind: "turn", id: reversed },
          relation: "verifies",
          provenance: "asserted",
        },
      ],
      CUTOFF,
    );
    db.query("UPDATE turns SET was_rolled_back = 1 WHERE id = ?").run(reversed);

    // Page-budget-is-the-seat-count spec, decision 1: `selectMilestoneTurns`
    // no longer truncates — read the election's own rank (`score`) off
    // `pagedMilestones` directly (see the "opposed significance_grade" test
    // above for why this is the more direct probe now that admission is
    // unbounded).
    const view = buildTimelineView(db, { id: `S${sessionId}`, view: "milestones" });
    const [top] = [...view.pagedMilestones].sort((a, b) => b.score - a.score);
    expect(top!.turn.promptNumber).toBe(2);
  });

  test("R1 #7 — E-view: the same corrector-tier fact through the segment route", () => {
    // Same `["ops"]` override as the S-view test above, and for the same
    // reason — a `["design"]` T2/T3 would both seat at the new tier ③
    // regardless of the corrector fact this test exists to prove.
    const reversed = insertTurn(1, "the reversed conclusion");
    const citer = insertTurn(2, "verifies it", ["ops"]);
    const bystander = insertTurn(3, "unrelated later bystander", ["ops"]);
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: citer },
          cited: { kind: "turn", id: reversed },
          relation: "verifies",
          provenance: "asserted",
        },
      ],
      CUTOFF,
    );
    db.query("UPDATE turns SET was_rolled_back = 1 WHERE id = ?").run(reversed);
    // `reversed` is deliberately NOT a segment member — the corrector fact
    // must reach the election without the rolled-back turn itself ever
    // needing a seat in the segment.
    const segment = createSegment(db, {
      title: "R1 #7 E-view segment",
      type: ["design"],
      nowEpoch: CUTOFF,
    });
    addSegmentMembers(db, segment.id, [citer, bystander], CUTOFF);

    // Page-budget-is-the-seat-count spec, decision 1/8: measured — 197
    // tokens (honest-token-pricing ticket 04 re-measured; was 370 under the
    // old diary weights; re-measured again at 197, was 198, by ticket 11's
    // USER RULING S15069/T2016 — every row is a couple bytes cheaper once its
    // own address drops its brackets, which shifts a threshold measured to
    // the byte) seats exactly the winner here (the row-admission budget
    // reserves a fixed allowance for the header/pointer/legend this selector
    // does not itself render — see `selectSegmentMilestonesByEdgeSignals`'s
    // own doc comment).
    const output = renderSegmentTimeline(
      buildSegmentTimelineView(db, { segmentId: segment.id, view: "milestones", pageBudget: 197 }),
    );
    expect(output).toContain("T2 ");
    expect(output).not.toContain("T3 ");
  });
});

describe("R1 adapter wiring (pre-release repair)", () => {
  let db: Database;
  let sessionId: number;
  const CUTOFF = 1_950_000_000;

  const insertTurn = (promptNumber: number, title: string): number =>
    db
      .query<{ id: number }, [number, number, string, string]>(
        `INSERT INTO turns (session_id, prompt_number, status, type, title, content, created_at_epoch)
         VALUES (?, ?, 'extracted', ?, ?, 'body', ?)
         RETURNING id`,
      )
      .get(sessionId, promptNumber, JSON.stringify(["design"]), title, CUTOFF + promptNumber)!.id;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "r1-adapter-wiring-fixture",
      project: "/tmp/r1-adapter-wiring-fixture",
      title: "R1 adapter wiring fixture",
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: CUTOFF,
      updatedAtEpoch: CUTOFF,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("R1 #1(b) — S-view: an external node never becomes a candidate, and it does not cost a window member its own tier-2 seat (lane-state-retirement ticket 02)", () => {
    const anchor = insertTurn(1, "the target of the lane");
    const declarer = insertTurn(2, "declares the lane");
    // Same session, a LATER prompt number, but OUTSIDE the queried range
    // below — only ever reachable as an OR-scoped edge endpoint (external).
    const externalRedeclarer = insertTurn(5, "external redeclaration outside the window");
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: declarer },
          cited: { kind: "turn", id: anchor },
          relation: "indexes",
          provenance: "asserted",
          ...deriveSideTags(["x"]),
        },
        {
          citing: { kind: "turn", id: externalRedeclarer },
          cited: { kind: "turn", id: anchor },
          relation: "indexes",
          provenance: "asserted",
          ...deriveSideTags(["x"]),
        },
      ],
      CUTOFF,
    );

    const view = buildTimelineView(db, { id: `S${sessionId}/T1..2`, view: "milestones" });
    const declarerRow = view.pagedMilestones.find((row) => row.turn.promptNumber === 2);
    // Tier 2 is re-based on the NODE (lane-state-retirement ticket 02): there
    // is no more "which declaration wins the lane" contest for an external
    // redeclarer to win. `declarer` seats at tier 2 on its OWN account,
    // regardless of what any other node — external or not, earlier or later —
    // also declares. What R1's adapter wiring still proves here is the
    // ELIGIBILITY half: the external redeclarer, fetched with its REAL order,
    // never becomes a candidate at all, so it can never be "elected" either —
    // it just cannot cost `declarer` its own seat, because nothing can.
    expect(declarerRow?.tier).toBe(2);
    // The external redeclarer itself never seats — outside the queried
    // window and never a candidate either way.
    expect(view.pagedMilestones.some((row) => row.turn.promptNumber === 5)).toBe(false);
  });

  test("page-budget-is-the-seat-count spec, decision 1 (was R1 #5's own clamp): the retired 30-item admission cap no longer bounds this view — a generous token budget seats all 40 edgeless members", () => {
    // This test used to PIN the R1 #5 clamp (`pageSize` capped at
    // `DEFAULT_TIMELINE_PAGE_SIZE`, 30, even for a caller that asked for
    // more). Page-budget-is-the-seat-count spec, decision 1, retires that
    // clamp outright: election ranks every candidate, and a token budget —
    // not an item count — decides survival. This is this ticket's own
    // acceptance criterion #1 ("on a fixture with >30 viable candidates and a
    // generous budget, the milestones view renders MORE than 30 rows").
    const memberIds: number[] = [];
    for (let p = 1; p <= 40; p += 1) {
      memberIds.push(insertTurn(p, `edgeless member ${p}`));
    }
    const segment = createSegment(db, {
      title: "forty edgeless members",
      type: ["design"],
      nowEpoch: CUTOFF,
    });
    addSegmentMembers(db, segment.id, memberIds, CUTOFF);

    const view = buildSegmentTimelineView(db, {
      segmentId: segment.id,
      view: "milestones",
      pageBudget: 100_000,
    });
    expect(view.keptMilestones.length).toBeGreaterThan(30);
    expect(view.keptMilestones.length).toBe(40);
    expect(view.demotedCount).toBe(0);

    // `pageSize` (however large) has no effect on this view any more.
    const withPageSize = buildSegmentTimelineView(db, {
      segmentId: segment.id,
      view: "milestones",
      pageBudget: 100_000,
      pageSize: 5,
    });
    expect(withPageSize.keptMilestones.length).toBe(40);
  });
});
