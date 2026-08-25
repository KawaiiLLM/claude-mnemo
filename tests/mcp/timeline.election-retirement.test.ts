import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { writeMemoryEdges } from "../../src/db/memory-edges";
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
    // turn) has to decide, with no grade term anywhere in the comparison. A
    // budget-1 cut forces a genuine contest.
    const t1 = insertTurn(1, "first");
    const t2 = insertTurn(2, "second");
    const t3 = insertTurn(3, "third");

    const query = () =>
      renderTimeline(buildTimelineView(db, { id: `S${sessionId}`, view: "milestones", pageSize: 1 }));
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
    // The seat really is contested — the later turn (T3, recency) wins it,
    // not whichever grade scramble happened to favor T1 or T3.
    expect(ungraded).toContain("[T3]");
    expect(ungraded).not.toContain("[T1]");
    expect(ungraded).not.toContain("[T2]");
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

    const query = () =>
      renderSegmentTimeline(
        buildSegmentTimelineView(db, { segmentId: segment.id, view: "milestones", pageSize: 1 }),
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
    expect(ungraded).toContain("[T3]");
    expect(ungraded).not.toContain("[T1]");
    expect(ungraded).not.toContain("[T2]");
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

  test("R1 #7 — S-view: a citer of a rolled-back turn tiers ④ (corrector), winning a contested budget-1 seat its own zero degree could never win alone", () => {
    // T1 will be rolled back; T2 `verifies` it (any relation qualifies —
    // corrector detection is relation-agnostic). T3 is a later, edge-free
    // bystander. Without R1 #7, T2's citing edge to T1 is invisible (T1
    // fails the live-turn-scoped getRelationEdgesAmongTurns filter), so T2
    // has zero degree, ties T3 at tier ⑤, and LOSES to T3 on recency — the
    // exact bug this pins.
    const reversed = insertTurn(1, "the reversed conclusion");
    const citer = insertTurn(2, "verifies it");
    insertTurn(3, "unrelated later bystander");
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

    const output = renderTimeline(
      buildTimelineView(db, { id: `S${sessionId}`, view: "milestones", pageSize: 1 }),
    );
    expect(output).toContain("[T2]");
    expect(output).not.toContain("[T3]");
  });

  test("R1 #7 — E-view: the same corrector-tier fact through the segment route", () => {
    const reversed = insertTurn(1, "the reversed conclusion");
    const citer = insertTurn(2, "verifies it");
    const bystander = insertTurn(3, "unrelated later bystander");
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

    const output = renderSegmentTimeline(
      buildSegmentTimelineView(db, { segmentId: segment.id, view: "milestones", pageSize: 1 }),
    );
    expect(output).toContain("[T2]");
    expect(output).not.toContain("[T3]");
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

  test("R1 #1(b) — S-view: an external turn's REAL order (fetchExternalElectionTurns) correctly supersedes a window member's lane declaration", () => {
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
          tags: ["x"],
        },
        {
          citing: { kind: "turn", id: externalRedeclarer },
          cited: { kind: "turn", id: anchor },
          relation: "indexes",
          provenance: "asserted",
          tags: ["x"],
        },
      ],
      CUTOFF,
    );

    const view = buildTimelineView(db, { id: `S${sessionId}/T1..2`, view: "milestones" });
    const declarerRow = view.pagedMilestones.find((row) => row.turn.promptNumber === 2);
    // Without R1's adapter wiring, the external redeclarer's edge would only
    // ever see the `[0, id]` fallback order, which always loses to a real
    // window member's `[sessionId, promptNumber]` (session-id major 0 sorts
    // before any real session) — so `declarer` would wrongly keep its
    // tier-2 seat. With the fix, the external turn's REAL, later order wins,
    // and `declarer`'s declaration is superseded.
    expect(declarerRow?.tier).toBe(5);
    expect(declarerRow?.tier).not.toBe(2);
    // The external redeclarer itself never seats — outside the queried
    // window and never a candidate either way.
    expect(view.pagedMilestones.some((row) => row.turn.promptNumber === 5)).toBe(false);
  });

  test("R1 #5 — E-view: pageSize is clamped to 30 like the S-view, even when the caller asks for more", () => {
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
      pageSize: 40,
    });
    expect(view.keptMilestones.length).toBe(30);
  });
});
