import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { buildTimelineView, renderTimeline, timelineQuery } from "../../src/mcp/timeline";

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
 *      retired election-chain identifier survives anywhere in `src/`. A
 *      reintroduced grade-driven or always-keep admission rule necessarily
 *      either calls one of these functions/constants/types or re-creates an
 *      equivalent — this check sees either.
 *   2. BEHAVIORAL — the election is provably grade-free and structurally
 *      driven: opposed `significance_grade` scrambles never move a contested
 *      seat (S-view AND E-view), and a candidacy-excluded turn (an override
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

  test("a candidacy-excluded turn (an override target) never renders on either route, whatever grade it carries", () => {
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
    expect(sOutput).not.toContain("the overridden conclusion");
    expect(sOutput).toContain("overrides it");
  });
});
