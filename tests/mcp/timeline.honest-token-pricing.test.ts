import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { addSegmentMembers, createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import {
  buildSegmentTimelineView,
  buildTimelineView,
  milestoneFitterTokenEstimate,
  renderSegmentTimeline,
  renderTimeline,
} from "../../src/mcp/timeline";
import { estimateTokens } from "../../src/utils/token-estimate";

/**
 * Honest-token-pricing ticket (04): the timeline milestones budget fitter
 * stops pricing with the diary's conservative estimator (Han 1.1/other 0.6,
 * ×1.2 — English reads about three times high) and adopts `estimateTokens`
 * semantics instead (CJK — Han/Hiragana/Katakana/Hangul — 1 tok/char,
 * everything else 1/4, `Math.ceil` at the end). This file is the acceptance
 * evidence for that repricing, not a general timeline-behavior suite — see
 * tests/mcp/timeline.test.ts and friends for those.
 */

const CUTOFF = 1_960_000_000;

function seedFixture(db: Database, sessionTitle: string): { sessionId: number } {
  initializeSchema(db);
  const sessionId = upsertSession(db, {
    contentSessionId: "honest-pricing-fixture",
    project: "/tmp/project",
    title: sessionTitle,
    content: null,
    insight: null,
    nextSteps: null,
    createdAtEpoch: CUTOFF,
    updatedAtEpoch: null,
    completedAtEpoch: null,
  }).id;
  return { sessionId };
}

function makeTurn(
  db: Database,
  sessionId: number,
  promptNumber: number,
  title: string,
): number {
  return db
    .query<{ id: number }, [number, number, string, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, type, title, created_at_epoch,
         user_prompt, assistant_response, content, files_read, files_modified, tags
       ) VALUES (?, ?, 'extracted', '["feature"]', ?, ?, 'p', 'a', null, '[]', '[]', '[]')
       RETURNING id`,
    )
    .get(sessionId, promptNumber, title, CUTOFF + promptNumber)!.id;
}

describe("honest-token-pricing ticket 04: the milestones fitter's own cheap measure", () => {
  test("agrees with estimateTokens exactly on an assembled mixed CJK/English block", () => {
    // A realistic milestone body: English structure (brackets, dates, glyphs)
    // around both English and Han-script title fragments — the "96% non-CJK,
    // fitter believes it is CJK-priced" misattribution this ticket fixes.
    const block = [
      "        [T1] 08-17 ⚙️ Framed the slicing problem for the batch importer",
      '            ↳ -indexes-> T2 · "卷号锚定要解决什么"',
      "        [T2] 08-17 ⚖️ Weighed the evidence and switched the anchor 因为旧锦已经失效",
    ].join("\n");

    expect(milestoneFitterTokenEstimate(block)).toBe(estimateTokens(block));
  });

  test("kana and Hangul characters price at 1 token/char — the old Han-only regex is gone", () => {
    // Pure hiragana/katakana, no Han at all: a Han-only regex would price
    // every one of these at 1/4 token, not 1.
    const kanaOnly = "ひらがなカタカナのタイトルです";
    expect(kanaOnly).not.toMatch(/\p{Script=Han}/u);
    expect(milestoneFitterTokenEstimate(kanaOnly)).toBe(kanaOnly.length);
    expect(milestoneFitterTokenEstimate(kanaOnly)).toBe(estimateTokens(kanaOnly));

    // Hangul, same story.
    const hangulOnly = "한국어로된제목입니다";
    expect(hangulOnly).not.toMatch(/\p{Script=Han}/u);
    expect(milestoneFitterTokenEstimate(hangulOnly)).toBe(estimateTokens(hangulOnly));
    // Every character in this sample is Hangul (no spaces), so the honest
    // price is exactly 1 token/char.
    expect(milestoneFitterTokenEstimate(hangulOnly)).toBe(hangulOnly.length);
  });
});

describe("honest-token-pricing ticket 04: the S-view render-time boundary", () => {
  test("the S-view fitter's admission boundary matches estimateTokens exactly (zero slack) on a real fixture", () => {
    const db = createDatabase(":memory:");
    const { sessionId } = seedFixture(db, "s");
    const titles = [
      "first plain english decision title",
      "第二个标题包含中文字符",
      "third title mixes 中文 and english words",
      "fourth 完全是中文标题的内容测试",
      "fifth plain title again for padding purposes",
      "sixth 混合 title with 汉字 sprinkled in",
      "seventh another plain english title here",
    ];
    titles.forEach((title, index) => makeTurn(db, sessionId, index + 1, title));

    const view = buildTimelineView(db, { id: `S${sessionId}`, view: "milestones" });
    // A generous budget so nothing is cut — the true "full" render.
    const full = renderTimeline(view, { pageBudget: 100_000 });
    const n = estimateTokens(full);

    // At exactly `n` honest tokens the full render still fits...
    expect(renderTimeline(view, { pageBudget: n })).toBe(full);
    // ...and one token less cuts something. If the fitter's internal cheap
    // gate (or its real `measure` confirm) priced even one character
    // differently than `estimateTokens` — the Han-only regression this
    // ticket fixes, or a leftover diary ×1.2 multiplier — this boundary
    // would sit more than one token away from `n`, and one of these two
    // assertions would fail.
    expect(renderTimeline(view, { pageBudget: n - 1 })).not.toBe(full);
  });
});

describe("honest-token-pricing ticket 04: S-view and E-view share the same currency", () => {
  test("selectSegmentMilestonesByEdgeSignals (E-view) and the S-view fitter both stop at the boundary estimateTokens predicts — neither is still paying the diary's conservative rate", () => {
    // Two DBs, same short filler content, one addressed as a session (S-view)
    // and one as a segment (E-view) — if either fitter still measured in the
    // old currency (roughly 3x higher on this all-English content), its own
    // boundary would land at a very different `n`, breaking its own
    // zero-slack check below.
    const titles = Array.from({ length: 12 }, (_unused, index) => `filler row number ${index + 1}`);

    const sDb = createDatabase(":memory:");
    const { sessionId } = seedFixture(sDb, "s currency probe");
    titles.forEach((title, index) => makeTurn(sDb, sessionId, index + 1, title));
    const sView = buildTimelineView(sDb, { id: `S${sessionId}`, view: "milestones" });
    const sFull = renderTimeline(sView, { pageBudget: 100_000 });
    const sN = estimateTokens(sFull);
    expect(renderTimeline(sView, { pageBudget: sN })).toBe(sFull);
    expect(renderTimeline(sView, { pageBudget: sN - 1 })).not.toBe(sFull);

    const eDb = createDatabase(":memory:");
    initializeSchema(eDb);
    const eSessionId = upsertSession(eDb, {
      contentSessionId: "e currency probe",
      project: "/tmp/project",
      title: "e",
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: CUTOFF,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
    const segmentId = createSegment(eDb, { title: "e currency segment", nowEpoch: CUTOFF }).id;
    const memberIds = titles.map((title, index) => makeTurn(eDb, eSessionId, index + 1, title));
    addSegmentMembers(eDb, segmentId, memberIds, CUTOFF);
    const eFull = renderSegmentTimeline(
      buildSegmentTimelineView(eDb, { segmentId, view: "milestones", pageBudget: 100_000 }),
    );
    const renderAt = (pageBudget: number) =>
      renderSegmentTimeline(
        buildSegmentTimelineView(eDb, { segmentId, view: "milestones", pageBudget }),
      );

    // Unlike the S-view (whose `fixedWeightQuarters` reserve is computed
    // from the ACTUAL just-rendered empty-body text), the E-view reserves a
    // fixed conservative allowance for its header/pointer/legend
    // (`selectSegmentMilestonesByEdgeSignals`'s own doc comment) regardless
    // of whether the legend ends up firing — so `estimateTokens(eFull)`
    // itself is not the right boundary to probe (the reserve still applies
    // even when nothing is cut). Binary search for the true minimal
    // fully-admitting budget instead; ITS boundary is exact, because the
    // reserve is the SAME fixed offset on both sides of the boundary and
    // cancels out.
    let lo = 0;
    let hi = 100_000;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (renderAt(mid) === eFull) {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }
    const eMin = lo;
    expect(renderAt(eMin)).toBe(eFull);
    // One token less cuts something — the same zero-slack guarantee the
    // S-view checks above, just anchored at the E-view's own (reserve-
    // shifted) boundary. If `tokensFor` (the E-view's row measure) still
    // used the diary's inflated currency, this boundary would land roughly
    // 3x higher than the honest-priced content actually costs — the
    // adjacent assertion below rules that out directly.
    expect(renderAt(eMin - 1)).not.toBe(eFull);

    // Bound the reserve itself: the fixed header/pointer/legend allowance is
    // ~120 (see `HEADER_AND_POINTER_RESERVE_TOKENS`) plus a small legend
    // reserve, honest-priced — nowhere near the ~3x diary-priced allowance
    // (150 + ~157) this same reserve carried before this ticket. `eMin`
    // minus the rows' own honest cost isolates just that reserve.
    const rowsOnlyText = titles.join("\n");
    const reserve = eMin - estimateTokens(rowsOnlyText);
    expect(reserve).toBeGreaterThan(0);
    expect(reserve).toBeLessThan(250);
  });
});

describe("honest-token-pricing ticket 04: CJK-heavy content and the char guard", () => {
  test("a CJK-heavy segment prices its rows ≈1 token/char, and the composed card still respects the 9500-char hard guard at the E-card's own 2000-token budget", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const sessionId = upsertSession(db, {
      contentSessionId: "cjk-heavy-fixture",
      project: "/tmp/project",
      title: "中文会话标题",
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: CUTOFF,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
    const segmentId = createSegment(db, { title: "全中文段落标题", nowEpoch: CUTOFF }).id;

    // 80 members, each with a near-titleCap (100-char) PURE-Han title (no
    // interpolated ASCII index — a digit run would dilute the CJK ratio this
    // test measures) — deliberately far denser than any real production
    // segment, to stress both the token math and the char guard at once.
    const hanPool =
      "这是一段用于压力测试的纯中文里程碑标题内容不含任何英文或数字字符仅用来验证诚实计价与硬字符上限守卫两者是否都仍然成立";
    const hanTitle = (index: number) => {
      const rotated = hanPool.slice(index % hanPool.length) + hanPool.slice(0, index % hanPool.length);
      return rotated.repeat(2).slice(0, 100);
    };
    const memberIds = Array.from({ length: 80 }, (_unused, index) =>
      makeTurn(db, sessionId, index + 1, hanTitle(index + 1)),
    );
    addSegmentMembers(db, segmentId, memberIds, CUTOFF);

    const view = buildSegmentTimelineView(db, { segmentId, view: "milestones", pageBudget: 2000 });
    // Regression floor: this exact fixture keeps 17 rows honestly priced,
    // 12 at the old diary rate (measured) — a floor of 15 catches a currency
    // regression here directly, not just via the ratio check below (which
    // measures `estimateTokens` independently of the fitter's own pricing).
    expect(view.keptMilestones.length).toBeGreaterThanOrEqual(15);
    // Not every candidate fits — this fixture is deliberately over-stuffed,
    // so the budget (not candidate exhaustion) is what is under test.
    expect(view.demotedCount).toBeGreaterThan(0);

    const card = renderSegmentTimeline(view);
    // The char-ladder guard (`MAX_INJECTED_BLOCK_CHARS`, session-composition.ts)
    // is the hard safety net now that pricing is honest — decision 4's own
    // sanity check.
    expect(card.length).toBeLessThan(9_500);

    // Pricing sanity: isolate just the kept rows' own text (strip the
    // segment header and legend, which carry a little non-CJK punctuation of
    // their own) and confirm it prices within a few percent of 1 token/char
    // — the old Han-only-at-full-weight/other-at-partial-weight scheme still
    // priced Han correctly, so this mainly guards against a regression to
    // the diary's ×1.2 inflation on this now-honest currency.
    const rowsOnly = view.keptMilestones.map((row) => row.member.title).join("");
    const rowsTokens = estimateTokens(rowsOnly);
    expect(rowsTokens).toBeGreaterThanOrEqual(rowsOnly.length * 0.95);
    expect(rowsTokens).toBeLessThanOrEqual(rowsOnly.length * 1.05);
  });
});
