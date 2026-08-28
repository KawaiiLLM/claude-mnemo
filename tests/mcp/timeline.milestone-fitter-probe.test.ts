import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import { addSegmentMembers, createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { NAVIGATION_LEGEND } from "../../src/mcp/format";
import { buildSegmentTimelineView, renderSegmentTimeline } from "../../src/mcp/timeline";
import { estimateTokens } from "../../src/utils/token-estimate";

/**
 * Ticket 07 (milestone-row-slimming spec, "the fitter stops claiming a
 * monotonicity it does not have"): `selectSegmentMilestonesByEdgeSignals`'s
 * binary-search budget fitter (mcp/timeline.ts, ~line 3820) plus its bounded
 * forward probe.
 *
 * The displacement mechanism under test: a row's `↳` antecedents are sorted
 * by `(sessionId, promptNumber)` ascending and capped at
 * `MILESTONE_ANTECEDENT_CAP` (4). Admitting a new candidate can insert a
 * SHORT same-session address (`T<n>`) into an already-capped bucket and
 * displace a LONGER cross-session address (`S<n>/T<n>`) into the `+N` fold —
 * shrinking an already-admitted row as K grows. A single displacement event
 * only saves a few tokens (far less than one new row costs), so this suite's
 * fixture uses MANY citer rows sharing the SAME displaced target and the SAME
 * displacer, so the aggregate shrink outweighs the displacer's own new row —
 * this is a deliberate amplification for testability, not a claim that
 * production segments look like this (the reviewer's own differential found
 * ZERO divergence across 420 real renders).
 */

const ERA = 1_950_000_000;

function seedSession(db: Database, contentSessionId: string, epoch: number): number {
  return upsertSession(db, {
    contentSessionId,
    project: "/tmp/fitter-probe-fixture",
    title: contentSessionId,
    insight: null,
    createdAtEpoch: epoch,
    updatedAtEpoch: null,
    completedAtEpoch: null,
  }).id;
}

function makeTurn(
  db: Database,
  sessionId: number,
  promptNumber: number,
  epoch: number,
  title: string,
): number {
  return db
    .query<{ id: number }, [number, number, string, string, number, string]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, type, title, created_at_epoch,
         user_prompt, assistant_response, content, files_read, files_modified, tags
       ) VALUES (?, ?, 'extracted', ?, ?, ?, ?, 'assistant response', 'body', '[]', '[]', '[]')
       RETURNING id`,
    )
    .get(sessionId, promptNumber, JSON.stringify(["feature"]), title, epoch, `prompt ${promptNumber}`)!.id;
}

function indexEdge(db: Database, citerId: number, citedId: number): void {
  writeMemoryEdges(
    db,
    [
      {
        citing: { kind: "turn", id: citerId },
        cited: { kind: "turn", id: citedId },
        relation: "indexes",
        provenance: "judged",
      },
    ],
    ERA,
  );
}

/** Strips the header line and the trailing `\n\n{legend}` suffix — reconstructs EXACTLY the row-body text `tokensFor` (the fitter's own internal cost function) measures, from the PUBLIC `renderSegmentTimeline` output. */
function rowBodyOnly(fullText: string): string {
  const withoutHeader = fullText.slice(fullText.indexOf("\n") + 1);
  const legendSuffix = `\n\n${NAVIGATION_LEGEND}`;
  return withoutHeader.endsWith(legendSuffix) ? withoutHeader.slice(0, -legendSuffix.length) : withoutHeader;
}

/**
 * The shared displacement fixture: `N` citer rows (`m0..m{N-1}`), each citing
 * 3 cheap same-session fillers (`f1,f2,f3`), a cross-session LONG target
 * (`long_`, in a LATER-created session so its address always sorts last), and
 * a cheap same-session displacer (`d`). Every citer's `↳` bucket sits exactly
 * at the cap (4: f1,f2,f3,long_) until BOTH f1 and f2 are elected alongside
 * f3/long_/d, at which point it overflows to 5 and folds the longest
 * (`long_`) out — the displacement event, replicated across all N citers at
 * once when the LAST-ranked candidate (`f1` or `f2`, whichever the election
 * seats last) is finally admitted.
 */
function buildDisplacementFixture(db: Database, n: number, title: string) {
  const sessionA = seedSession(db, `${title}-A`, ERA);
  const sessionB = seedSession(db, `${title}-B`, ERA + 2_000_000);
  const f1 = makeTurn(db, sessionA, 1, ERA + 1, "f1");
  const f2 = makeTurn(db, sessionA, 2, ERA + 2, "f2");
  const f3 = makeTurn(db, sessionA, 3, ERA + 3, "f3");
  const d = makeTurn(db, sessionA, 4, ERA + 4, "d");
  const long_ = makeTurn(db, sessionB, 123456789, ERA + 2_000_500, "L");
  const ris: number[] = [];
  for (let i = 0; i < n; i += 1) {
    ris.push(makeTurn(db, sessionA, 20 + i, ERA + 20 + i, `m${i}`));
  }
  for (const ri of ris) {
    indexEdge(db, ri, f1);
    indexEdge(db, ri, f2);
    indexEdge(db, ri, f3);
    indexEdge(db, ri, long_);
    indexEdge(db, ri, d);
  }
  return { f1, f2, f3, d, long_, ris };
}

describe("selectSegmentMilestonesByEdgeSignals fitter (milestone-row-slimming ticket 07)", () => {
  test("criterion 1: a real displacement fixture exhibits cost(K) < cost(K-1) — both costs named", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const TITLE = "displacement fixture";
    const { f1, f2, f3, d, long_, ris } = buildDisplacementFixture(db, 20, "disp1");

    // K-1 = 24 candidates (all except f2 — one of the two tied-for-last
    // fillers). K = 25 (all candidates, including f2).
    const segKMinus1 = createSegment(db, { title: TITLE, nowEpoch: ERA });
    addSegmentMembers(db, segKMinus1.id, [f1, f3, long_, d, ...ris], ERA);
    const segK = createSegment(db, { title: TITLE, nowEpoch: ERA });
    addSegmentMembers(db, segK.id, [f1, f2, f3, long_, d, ...ris], ERA);

    const HUGE = 1_000_000; // admits every candidate on both sides — isolates the row-cost delta.
    const viewKMinus1 = buildSegmentTimelineView(db, { segmentId: segKMinus1.id, view: "milestones", pageBudget: HUGE });
    const viewK = buildSegmentTimelineView(db, { segmentId: segK.id, view: "milestones", pageBudget: HUGE });
    expect(viewKMinus1.demotedCount).toBe(0);
    expect(viewK.demotedCount).toBe(0);
    expect(viewKMinus1.keptMilestones.length).toBe(24);
    expect(viewK.keptMilestones.length).toBe(25);

    const costKMinus1 = estimateTokens(rowBodyOnly(renderSegmentTimeline(viewKMinus1)));
    const costK = estimateTokens(rowBodyOnly(renderSegmentTimeline(viewK)));
    // Both costs named: K=25 (with the displacer's own new row AND 20
    // simultaneous antecedent shrinks) costs FEWER tokens than K=24 (just the
    // shrink-free row addition) despite having MORE admitted rows.
    expect(costK).toBeLessThan(costKMinus1);
    db.close();
  });

  test("criterion 2: the forward probe seats the rows the bare binary search would have dropped — both K values named", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const TITLE = "single election";
    const { f1, f2, f3, d, long_, ris } = buildDisplacementFixture(db, 20, "disp2");

    // Independently confirm (via an isolated 24-member segment, same title —
    // no header-cost confound) that K=24 genuinely does NOT fit the budget
    // below: this is exactly the K a plain binary search converges to when
    // it tests K=24, sees it fail, and (per the now-corrected comment) can
    // never re-try a LARGER K after `hi` collapses below it.
    //
    // Edge-atom spec (ticket 11) re-priced every `↳` address (arrow prefix
    // instead of word suffix), which shifts row cost — re-measured
    // empirically against this real fixture, not hand-derived: at this
    // budget K=24 plateaus at 23 seated rows (demotedCount > 0) while K=25
    // clears straight to all 25 (demotedCount 0), which is the exact
    // jump-past-the-failing-K this criterion needs.
    const budget = 740;
    const seg24 = createSegment(db, { title: TITLE, nowEpoch: ERA });
    addSegmentMembers(db, seg24.id, [f1, f3, long_, d, ...ris], ERA);
    const view24 = buildSegmentTimelineView(db, { segmentId: seg24.id, view: "milestones", pageBudget: budget });
    expect(view24.demotedCount).toBeGreaterThan(0); // K=24 (all of seg24's own members) does not fit at this budget.

    // The full 25-candidate election, same budget: the FIXED fitter (binary
    // search + bounded forward probe) must recover all the way to K=25 —
    // skipping straight past the failing K=24 to the fitting K=25, which
    // requires the probe to NOT stop at the first K that fails to fit.
    const seg25 = createSegment(db, { title: TITLE, nowEpoch: ERA });
    addSegmentMembers(db, seg25.id, [f1, f2, f3, long_, d, ...ris], ERA);
    const view25 = buildSegmentTimelineView(db, { segmentId: seg25.id, view: "milestones", pageBudget: budget });
    // Both K values named: 24 (what a bare binary search would settle for
    // fewer than, since it fails and can't recover) vs 25 (what the probe
    // actually seats — every candidate, demotedCount 0).
    expect(view25.keptMilestones.length).toBe(25);
    expect(view25.demotedCount).toBe(0);
    db.close();
  });

  test("criterion 3: the probe never overshoots — a fixture where the K values just past bestK do NOT fit", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const TITLE = "single election";
    const { f1, f2, f3, d, long_, ris } = buildDisplacementFixture(db, 20, "disp3");
    const seg25 = createSegment(db, { title: TITLE, nowEpoch: ERA });
    addSegmentMembers(db, seg25.id, [f1, f2, f3, long_, d, ...ris], ERA);

    // A budget below EVERY K in the probe's reach (K=24's true cost is 582,
    // K=25's is 553 under the edge-atom spec's arrow pricing — ticket 11 —
    // both measured in criterion 1/2's own fixture family) — low enough that
    // neither the bare search's bestK+1 nor its bestK+2/+3 probes can fit.
    const budget = 680;
    const view = buildSegmentTimelineView(db, { segmentId: seg25.id, view: "milestones", pageBudget: budget });
    expect(view.keptMilestones.length).toBeLessThan(24); // neither 24 nor 25 got adopted.
    expect(view.demotedCount).toBeGreaterThan(0);

    // The output itself never exceeds the budget — the probe's own "adopt
    // only if it fits" discipline, verified on the ACTUAL rendered text, not
    // just the reported row count.
    const rendered = renderSegmentTimeline(view);
    const HEADER_AND_POINTER_RESERVE_TOKENS = 120;
    const legendReserveTokens = estimateTokens(`\n\n${NAVIGATION_LEGEND}`);
    const rowBudget = budget - HEADER_AND_POINTER_RESERVE_TOKENS - legendReserveTokens;
    expect(estimateTokens(rowBodyOnly(rendered))).toBeLessThanOrEqual(rowBudget);
    db.close();
  });
});
