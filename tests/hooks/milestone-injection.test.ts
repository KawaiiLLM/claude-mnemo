import { describe, expect, test } from "bun:test";

import { createDatabase } from "../../src/db/database";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurn } from "../../src/db/turns";
import {
  MILESTONE_INJECTION_RECENT_TURNS,
  MILESTONE_INJECTION_TOKEN_BUDGET,
  renderMilestoneInjection,
  renderSessionMilestoneInjection,
} from "../../src/hooks/milestone-injection";
import {
  buildTimelineView,
  compareMilestoneRank,
  renderTimeline,
  DEFAULT_TITLE_CAP,
  MILESTONE_OVER_BUDGET_NOTE,
  type TimelineView,
} from "../../src/mcp/timeline";
import { estimateTokens } from "../../src/utils/token-estimate";
import { wordEdgeClass } from "../support/edge-row-fixtures";

const ERA_BASE = 1_785_000_000;

interface SeedRow {
  promptNumber: number;
  status?: "extracted" | "skipped";
  prompt: string;
  title: string;
  content?: string | null;
  type: string;
  grade: number;
  toolCalls?: number;
  filesModified?: string[];
  epoch: number;
}

/** Seeds an era-internal session straight into SQLite. */
function seedSession(
  db: ReturnType<typeof createDatabase>,
  contentSessionId: string,
  rows: SeedRow[],
): number {
  initializeSchema(db);
  const session = upsertSession(db, {
    contentSessionId,
    project: "/tmp/claude-mnemo-test",
    title: contentSessionId,
    insight: null,
    createdAtEpoch: ERA_BASE,
    updatedAtEpoch: rows.at(-1)?.epoch ?? ERA_BASE,
    completedAtEpoch: null,
  });
  const insert = db.query(
    `INSERT INTO turns (
       session_id, prompt_number, status, user_prompt, title, content, type,
       significance_grade, tool_call_count, created_at_epoch,
       tags, files_read, files_modified
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', ?)`,
  );
  db.transaction(() => {
    for (const row of rows) {
      insert.run(
        session.id,
        row.promptNumber,
        row.status ?? "extracted",
        row.prompt,
        row.title,
        row.content ?? null,
        JSON.stringify([row.type]),
        row.grade,
        row.toolCalls ?? 0,
        row.epoch,
        JSON.stringify(row.filesModified ?? []),
      );
    }
  })();
  return session.id;
}

function turnDbId(
  db: ReturnType<typeof createDatabase>,
  sessionId: number,
  promptNumber: number,
): number {
  const record = getTurn(db, sessionId, promptNumber);
  if (record === null) throw new Error(`no turn S${sessionId}/T${promptNumber}`);
  return record.id;
}

// `replaceTurnCitations` (the old generic body-free structured-edge write)
// was retired under spec C6/ticket 06; writing straight through
// `writeMemoryEdges` sidesteps that churn (same fix as timeline.test.ts).
function cite(
  db: ReturnType<typeof createDatabase>,
  sessionId: number,
  citingPrompt: number,
  citedPrompts: number[],
): void {
  const citingId = turnDbId(db, sessionId, citingPrompt);
  writeMemoryEdges(
    db,
    citedPrompts.map((promptNumber) => ({
      citing: { kind: "turn" as const, id: citingId },
      cited: { kind: "turn" as const, id: turnDbId(db, sessionId, promptNumber) },
      ...wordEdgeClass("verifies"),
      provenance: "judged" as const,
    })),
    ERA_BASE,
  );
}

// A spine row is `        <marker?>[T<n>] <date> <time> <emoji> <title>` (spec
// 金样例); the `↳` address line, desc lines and the `… +N more` hint all sit
// further in and never match.
const SPINE_ROW_RE = /^ {8}(?:.{1,2} )?T\d+ /u;

function spinePromptNumbers(output: string): number[] {
  return output
    .split("\n")
    .filter((line) => SPINE_ROW_RE.test(line))
    .map((line) => Number(line.match(/T(\d+)/)![1]));
}

function milestoneView(
  db: ReturnType<typeof createDatabase>,
  sessionId: number,
): TimelineView {
  return buildTimelineView(db, {
    id: `S${sessionId}`,
    view: "milestones",
    pageSize: Number.MAX_SAFE_INTEGER,
  });
}

/** A four-row arc with one pulled antecedent, seeded straight into SQLite. */
function seedInjectionArc(db: ReturnType<typeof createDatabase>): number {
  const sessionId = seedSession(db, "injection-arc", [
    {
      promptNumber: 1,
      prompt: "卷号锚定要解决什么",
      title: "Framed the slicing problem",
      content: "Opened the arc and named the downstream consumer.",
      type: "decision",
      grade: 4,
      filesModified: ["src/slicing.md"],
      epoch: ERA_BASE + 60,
    },
    // Live and G2 on purpose, not `status: "skipped"` (view-render-repair
    // ticket 06, ruling [S15069/T1084]): a skipped turn is now excluded from
    // the citation universe entirely and can never be pulled through as a ↳
    // row, which would defeat this fixture's own "one pulled antecedent"
    // premise.
    {
      promptNumber: 2,
      prompt: "取证",
      title: "Measured a 12-14% error",
      type: "discovery",
      grade: 2,
      toolCalls: 3,
      epoch: ERA_BASE + 120,
    },
    {
      promptNumber: 3,
      prompt: "没有卷数怎么办",
      title: "Adopted cursor slicing",
      content: "Weighed the evidence and switched the anchor.",
      type: "decision",
      grade: 3,
      toolCalls: 5,
      filesModified: ["src/cursor.ts"],
      epoch: ERA_BASE + 180,
    },
    {
      promptNumber: 4,
      prompt: "发布",
      title: "0.9.0 released",
      content: "Cut the release.",
      type: "feature",
      grade: 2,
      toolCalls: 1,
      filesModified: ["package.json"],
      epoch: ERA_BASE + 240,
    },
  ]);
  cite(db, sessionId, 3, [2]);
  return sessionId;
}

/** 72 characters: long enough to be worth cutting, well under `DEFAULT_TITLE_CAP`. */
function arcTitle(promptNumber: number): string {
  const stem = `Decision ${promptNumber}: locked the slicing rule for this batch`;
  return stem.padEnd(72, "·").slice(0, 72);
}

/**
 * A long session shaped like the one SessionStart actually meets. `anchorEvery`
 * controls how many G4 always-keep rows it carries: a sparse arc fits the
 * budget, a dense one cannot and must exercise the anchor exemption.
 */
function seedLongArc(
  db: ReturnType<typeof createDatabase>,
  options: { mainRows: number; anchorEvery: number; contentSessionId: string },
): number {
  const rows: SeedRow[] = [];
  const antecedentOf = new Map<number, number>();
  let promptNumber = 0;
  let epoch = ERA_BASE;

  for (let index = 0; index < options.mainRows; index += 1) {
    if (index % 10 === 9) {
      promptNumber += 1;
      epoch += 300;
      rows.push({
        promptNumber,
        prompt: `证据 ${promptNumber}`,
        title: `evidence sample ${promptNumber} for the slicing survey`,
        type: "discovery",
        grade: 2,
        epoch,
      });
      antecedentOf.set(promptNumber + 1, promptNumber);
    }
    promptNumber += 1;
    epoch += 300;
    const anchor =
      options.anchorEvery > 0 && index % options.anchorEvery === 0;
    rows.push({
      promptNumber,
      prompt: `第 ${promptNumber} 轮的提问，问题描述有一点长`,
      title: arcTitle(promptNumber),
      content:
        `Weighed the alternatives for batch ${promptNumber} and recorded why the cursor form wins. `.repeat(
          3,
        ),
      type: anchor ? "decision" : "feature",
      grade: anchor ? 4 : 3,
      toolCalls: index % 7,
      filesModified: [
        `src/batch/${promptNumber}.ts`,
        `tests/batch/${promptNumber}.test.ts`,
      ],
      epoch,
    });
  }

  const sessionId = seedSession(db, options.contentSessionId, rows);
  for (const [citing, cited] of antecedentOf) {
    cite(db, sessionId, citing, [cited]);
  }
  return sessionId;
}

describe("SessionStart milestone injection = the arc view", () => {
  test("is the milestones view rendered with titleCap 100 and the 2500 budget", () => {
    const db = createDatabase(":memory:");
    const sessionId = seedInjectionArc(db);

    const injected = renderSessionMilestoneInjection(db, sessionId);

    // The whole contract: one call into the unified renderer, no post-render
    // string surgery on top of it.
    expect(injected).toBe(
      renderTimeline(milestoneView(db, sessionId), {
        titleCap: DEFAULT_TITLE_CAP,
        tokenBudget: MILESTONE_INJECTION_TOKEN_BUDGET,
        showEarlierHint: false,
      }),
    );
    expect(MILESTONE_INJECTION_TOKEN_BUDGET).toBe(2_500);
    db.close();
  });

  test("emits unified rows: sample baseline, desc block, ↳ antecedent ADDRESSES, ✏️ tail", () => {
    const db = createDatabase(":memory:");
    const sessionId = seedInjectionArc(db);

    const injected = renderSessionMilestoneInjection(db, sessionId);

    // Spec 金样例 baseline (row-slimming ticket 01: `MM-DD`, one emoji)
    // `[T821] 08-17 ⚖️ title`, plus the budget-permitting enrichments (the
    // user's own words, the ✏️ tail).
    expect(injected).toContain(
      'T1 07-25 ⚖️ Framed the slicing problem · "卷号锚定要解决什么"',
    );
    // `↳` is an ADDRESS index; no grade, no title, no `前件` count.
    expect(injected).toContain("↳ -verify-> T2");
    expect(injected).not.toMatch(/\bG[0-4]\b/);
    expect(injected).not.toContain("前件");
    expect(injected).toContain("Weighed the evidence and switched the anchor.");
    expect(injected).toContain("✏️cursor.ts");
    // Shape signals survive: the old stage-2 strip is gone.
    expect(injected).toContain("shape signals");
    // …and so are the other post-render artifacts of the four-stage ladder.
    expect(injected).not.toContain("更多里程碑见");
    expect(injected).not.toContain("earlier: timeline(");
    db.close();
  });

  test("bounds a long arc at 2500 tokens without char-halving any title", () => {
    const db = createDatabase(":memory:");
    // Milestone-election spec, ticket 03: the election's own budget (clamped
    // to 30 — see `buildTimelineView`'s own doc comment on why) is now what
    // narrows a long session, not the 2500-token budget alone — so this
    // fixture is a plain, edge-free 30-turn arc (every turn IS the election,
    // no in-degree tie-break to skew which titles survive) rather than the
    // old 300+30-row shape, which the new election would fill entirely with
    // its 30 in-degree-bearing "evidence" rows before a single "Decision"
    // title ever got a seat.
    const rows: SeedRow[] = Array.from({ length: 30 }, (_unused, index) => ({
      promptNumber: index + 1,
      prompt: `第 ${index + 1} 轮的提问，问题描述有一点长`,
      title: arcTitle(index + 1),
      content: `Weighed the alternatives for batch ${index + 1} and recorded why the cursor form wins. `.repeat(
        3,
      ),
      type: "feature",
      grade: 3,
      toolCalls: index % 7,
      filesModified: [`src/batch/${index + 1}.ts`, `tests/batch/${index + 1}.test.ts`],
      epoch: ERA_BASE + index * 300,
    }));
    const sessionId = seedSession(db, "long-sparse-arc", rows);

    const injected = renderSessionMilestoneInjection(db, sessionId);

    // Honest-token-pricing ticket (04): the fitter's own currency is
    // `estimateTokens`, not the diary's conservative estimator — this is the
    // budget contract the fitter actually enforces now.
    expect(estimateTokens(injected)).toBeLessThanOrEqual(
      MILESTONE_INJECTION_TOKEN_BUDGET,
    );
    expect(injected).not.toContain(MILESTONE_OVER_BUDGET_NOTE);
    const survivors = spinePromptNumbers(injected);
    expect(survivors.length).toBeGreaterThan(0);
    // Every surviving row carries its title WHOLE. The deleted four-stage ladder
    // cut all of them to 50 characters at exactly this pressure.
    for (const promptNumber of survivors) {
      expect(injected).toContain(arcTitle(promptNumber));
    }
  });

  test("removes the lowest-ranked unit first (milestone-election spec, ticket 03: every row is removable now — always-keep retired)", () => {
    const db = createDatabase(":memory:");
    const sessionId = seedLongArc(db, {
      mainRows: 12,
      anchorEvery: 2,
      contentSessionId: "anchor-heavy-arc",
    });
    const view = milestoneView(db, sessionId);
    const removable = [...view.pagedMilestones].sort(compareMilestoneRank);
    expect(removable.length).toBeGreaterThan(1);
    const lowest = removable.at(-1)!;

    const full = renderSessionMilestoneInjection(db, sessionId, {
      tokenBudget: 100_000,
    });
    const allRows = spinePromptNumbers(full);
    let firstDrop: number[] | null = null;
    for (let budget = estimateTokens(full); budget >= 1; budget -= 1) {
      const rows = spinePromptNumbers(
        renderSessionMilestoneInjection(db, sessionId, { tokenBudget: budget }),
      );
      if (rows.length < allRows.length) {
        firstDrop = allRows.filter((promptNumber) => !rows.includes(promptNumber));
        break;
      }
    }

    // The response-level legend (spec D4) is fixed overhead that appears the
    // instant anything is hidden at all — so the very first size-decreasing
    // budget step can force more than one removal at once (freeing one row is
    // not enough to also cover the legend's first appearance). The ordering
    // guarantee under test — worst-ranked goes first, an anchor never does —
    // still holds: whatever the drop count, it must be exactly the worst-ranked
    // PREFIX of `removable`, always led by `lowest`.
    expect(firstDrop).not.toBeNull();
    expect(firstDrop).toContain(lowest.turn.promptNumber);
    const expectedPrefix = removable
      .slice(removable.length - firstDrop!.length)
      .map((milestone) => milestone.turn.promptNumber);
    expect(new Set(firstDrop)).toEqual(new Set(expectedPrefix));
    db.close();
  });

  test("nothing is exempt from an impossible budget any more (milestone-election spec, ticket 03: always-keep retires) — every row goes, with one over-budget note", () => {
    const db = createDatabase(":memory:");
    const sessionId = seedLongArc(db, {
      mainRows: 12,
      anchorEvery: 2,
      contentSessionId: "anchor-heavy-arc",
    });

    const starved = renderSessionMilestoneInjection(db, sessionId, {
      tokenBudget: 1,
    });

    expect(spinePromptNumbers(starved)).toEqual([]);
    expect(starved).toContain(MILESTONE_OVER_BUDGET_NOTE);
    db.close();
  });

  test("elects over a 900-row session in well under a second, bounded to the election budget", () => {
    const db = createDatabase(":memory:");
    const sessionId = seedLongArc(db, {
      mainRows: 900,
      anchorEvery: 6,
      contentSessionId: "long-dense-arc",
    });
    // Page-budget-is-the-seat-count spec, decision 1: `kept` is no longer
    // capped at a 30-item election budget — selection admits every non-
    // excluded window candidate now, whatever the session's raw turn count;
    // the token-budget fitter (exercised below via `renderSessionMilestoneInjection`)
    // is what bounds the RENDERED output. This ticket's own acceptance
    // criterion #1: on a fixture with >30 viable candidates, `pagedMilestones`
    // carries more than 30.
    const view = milestoneView(db, sessionId);
    expect(view.pagedMilestones.length).toBeGreaterThan(30);

    const started = Bun.nanoseconds();
    const injected = renderSessionMilestoneInjection(db, sessionId);
    const elapsedMs = (Bun.nanoseconds() - started) / 1_000_000;

    // The deleted four-stage ladder re-rendered the whole view once per
    // candidate count: ~57s on this fixture. The bound is deliberately generous
    // — it exists to fail loudly if anything quadratic comes back (both in the
    // election itself, over 900+ candidates, and in the render ladder, now
    // over at most 30 units).
    expect(elapsedMs).toBeLessThan(1_500);
    expect(injected.length).toBeGreaterThan(0);
    db.close();
  });
});

// injection-milestone-split spec, ticket 01: the SessionStart arc now renders
// as two half-budget `milestones`-view calls split at
// `lastPromptNumber - MILESTONE_INJECTION_RECENT_TURNS`, so a session with
// more turns than that window no longer lets old high-score anchors starve
// every recent row out of the single shared budget.

/** A cheap, edge-free filler turn: always tier ⑤ ("everything else") in the election. */
function fillerRow(promptNumber: number, epoch: number, title?: string): SeedRow {
  return {
    promptNumber,
    prompt: `第 ${promptNumber} 轮`,
    title: title ?? `filler turn ${promptNumber}`,
    type: "feature",
    grade: 3,
    epoch,
  };
}

/**
 * An untagged self-`indexes` edge — the cheapest way to put a turn in
 * election tier ① ("untagged-`indexes` writers") without touching the lane
 * machinery tier ② depends on (`shared/milestone-election.ts` step 2/③:
 * self-edges are explicitly in-scope, "no `citingId !== citedId` filter
 * anywhere"). Tier ① always outranks tier ⑤, so a self-indexed turn survives
 * any budget cut a plain filler row would not.
 */
/**
 * Give turn `promptNumber` an incoming `indexes` edge — the in-degree that
 * promotes it into a milestone row, which is all these fixtures want from it.
 *
 * The CITER is its successor rather than the turn itself. This used to be a
 * SELF edge, which was the cheapest way to mint in-degree without seeding a
 * second turn; lane-model-v12 D2 (ticket 04) makes a self edge unstorable —
 * refused by `writeMemoryEdges` and by the table's own CHECK — so the
 * shortcut now writes nothing at all and every fixture built on it would
 * quietly describe a session with no milestones.
 */
function indexTurn(
  db: ReturnType<typeof createDatabase>,
  sessionId: number,
  promptNumber: number,
): void {
  const id = turnDbId(db, sessionId, promptNumber);
  const citerId = turnDbId(db, sessionId, promptNumber + 1);
  writeMemoryEdges(
    db,
    [
      {
        citing: { kind: "turn" as const, id: citerId },
        cited: { kind: "turn" as const, id },
        ...wordEdgeClass("indexes"),
        provenance: "judged" as const,
      },
    ],
    ERA_BASE,
  );
}

describe("SessionStart milestone injection = the two-call recent/old split (ticket 01)", () => {
  test("MILESTONE_INJECTION_RECENT_TURNS is pinned at 200", () => {
    expect(MILESTONE_INJECTION_RECENT_TURNS).toBe(200);
  });

  test("partition pins exactly at max-200: that turn is OLD, the next one is RECENT — sub-rows never cross the boundary", () => {
    const db = createDatabase(":memory:");
    const total = MILESTONE_INJECTION_RECENT_TURNS + 2; // boundary lands at prompt 2
    const rows: SeedRow[] = [];
    for (let n = 1; n <= total; n += 1) {
      rows.push(fillerRow(n, ERA_BASE + n * 60));
    }
    rows[1] = fillerRow(2, ERA_BASE + 2 * 60, "OLD anchor at the boundary");
    rows[2] = fillerRow(3, ERA_BASE + 3 * 60, "RECENT anchor just past it");
    const sessionId = seedSession(db, "boundary-pin", rows);
    indexTurn(db, sessionId, 2);
    indexTurn(db, sessionId, 3);
    // T3 cites T2 (any relation survives on `↳` — ticket uses `verifies`,
    // same as `cite()` elsewhere in this file): only elected iff BOTH ends
    // are elected in the SAME window's own selection.
    cite(db, sessionId, 3, [2]);

    const boundary = total - MILESTONE_INJECTION_RECENT_TURNS; // 2
    const oldView = buildTimelineView(db, {
      id: `S${sessionId}/T..${boundary}`,
      view: "milestones",
      pageSize: Number.MAX_SAFE_INTEGER,
    });
    const recentView = buildTimelineView(db, {
      id: `S${sessionId}/T${boundary + 1}..`,
      view: "milestones",
      pageSize: Number.MAX_SAFE_INTEGER,
    });

    const oldPrompts = oldView.pagedMilestones.map((m) => m.turn.promptNumber);
    const recentPrompts = recentView.pagedMilestones.map((m) => m.turn.promptNumber);
    expect(oldPrompts).toContain(2);
    expect(oldPrompts).not.toContain(3);
    expect(recentPrompts).toContain(3);
    expect(recentPrompts).not.toContain(2);
    // T2 is in the OLD window's own selection, so T3's `↳` line (which only
    // ever lists a citee elected in the SAME call) never lists it — the
    // sub-row does not cross the boundary with its parent.
    const t3Row = recentView.pagedMilestones.find((m) => m.turn.promptNumber === 3)!;
    expect(t3Row.antecedents).toEqual([]);

    const injected = renderSessionMilestoneInjection(db, sessionId);
    expect(injected).toContain("OLD anchor at the boundary");
    expect(injected).toContain("RECENT anchor just past it");
    db.close();
  });

  test("an empty side reallocates the whole budget to the other (OLD side here is all `compact`-typed, so it has turns but zero candidates)", () => {
    const db = createDatabase(":memory:");
    const oldCount = 10;
    const recentCount = MILESTONE_INJECTION_RECENT_TURNS;
    const total = oldCount + recentCount;
    const rows: SeedRow[] = [];
    for (let n = 1; n <= oldCount; n += 1) {
      rows.push({ ...fillerRow(n, ERA_BASE + n * 60), type: "compact" });
    }
    for (let n = oldCount + 1; n <= total; n += 1) {
      rows.push(fillerRow(n, ERA_BASE + n * 60));
    }
    const sessionId = seedSession(db, "empty-old-side", rows);
    // ENOUGH guaranteed-kept RECENT anchors that the render is budget-bound:
    // at floor(budget/2) the fitter must drop rows it keeps at the full
    // budget, so the reallocation is observable in bytes — one small anchor
    // fits under either budget and pins nothing (a mutation to half-budget
    // survived exactly that fixture).
    for (let n = oldCount + 1; n <= oldCount + 16; n += 1) {
      indexTurn(db, sessionId, n);
    }

    const boundary = total - MILESTONE_INJECTION_RECENT_TURNS;
    expect(boundary).toBe(oldCount);
    const oldView = buildTimelineView(db, {
      id: `S${sessionId}/T..${boundary}`,
      view: "milestones",
      pageSize: Number.MAX_SAFE_INTEGER,
    });
    expect(oldView.pagedMilestones).toEqual([]); // turns exist, but all excluded (compact)

    const recentView = buildTimelineView(db, {
      id: `S${sessionId}/T${boundary + 1}..`,
      view: "milestones",
      pageSize: Number.MAX_SAFE_INTEGER,
    });

    // Production-scale, not a toy value: this fixture's header/shape-signal
    // overhead (ten compact boundaries) runs ~250 tokens and the fitter's
    // drop-everything floor sits above 600, so small budgets render
    // identically at full and half and the discriminator below loses its
    // teeth. At 2000 vs 1000 the kept-row sets genuinely differ.
    const budget = 2000;
    const injected = renderSessionMilestoneInjection(db, sessionId, { tokenBudget: budget });
    // The empty OLD side is skipped outright — RECENT alone gets the FULL
    // budget, not `floor(budget/2)`. The second assertion is the
    // discriminator: at this fixture's size the two budgets render
    // differently, so a half-budget regression cannot hide behind a render
    // that fits either way.
    expect(injected).toBe(renderMilestoneInjection(recentView, { tokenBudget: budget }));
    expect(injected).not.toBe(
      renderMilestoneInjection(recentView, { tokenBudget: Math.floor(budget / 2) }),
    );
    db.close();
  });

  test("both sides non-empty: each renders at floor(budget/2), concatenated as one attachment, and the recency guarantee holds (a recent-only row a single whole-session call would have starved now survives)", () => {
    const db = createDatabase(":memory:");
    // Honest-token-pricing ticket (04): a short filler row now prices at
    // ~8 honest tokens (was ~22 under the old diary weights), so 35 old
    // tier-① rows no longer come close to exhausting the 2500-token budget
    // — the whole-session legacy call would seat every one of the 200
    // RECENT turns too, and the discriminator below would have nothing to
    // discriminate. 150 is re-measured against the CURRENT (honest) currency
    // to reproduce the same shape the old 35 relied on: enough old tier-①
    // rows to spend nearly the whole budget, leaving room for at most the
    // single most-recent tier-⑤ winner — see this file's own ticket-04 tuning
    // note in the report, not a value with a large safe margin either side.
    const oldTierOneCount = 150;
    const recentCount = MILESTONE_INJECTION_RECENT_TURNS;
    const total = oldTierOneCount + recentCount;
    const rows: SeedRow[] = [];
    for (let n = 1; n <= total; n += 1) {
      rows.push(fillerRow(n, ERA_BASE + n * 60));
    }
    const sessionId = seedSession(db, "recency-guarantee", rows);
    // Every OLD turn is tier ①: on a single whole-session election these 150
    // alone already spend nearly the whole 2500-token budget, so none of the
    // 200 RECENT (tier ⑤) turns can ever seat — the live E60 regression this
    // ticket fixes.
    for (let n = 1; n <= oldTierOneCount; n += 1) {
      indexTurn(db, sessionId, n);
    }

    // Baseline: the OLD single-call shape this ticket replaces.
    const legacyWholeSessionView = buildTimelineView(db, {
      id: `S${sessionId}`,
      view: "milestones",
      pageSize: Number.MAX_SAFE_INTEGER,
    });
    const legacyRendered = renderMilestoneInjection(legacyWholeSessionView);
    // Page-budget-is-the-seat-count spec, decision 1: admission is unbounded
    // now, so the render-time fitter — not a pre-fitter admission cap — is
    // what decides survival, cutting lowest election rank first, and within
    // tier ⑤ that tiebreak is RECENCY. The single GLOBALLY latest turn
    // (`total`) can therefore still slip through even the legacy whole-
    // session call once there is budget left over after the 150 tier-①
    // releases — that is no longer starvation, it is the fitter working as
    // designed. A turn a few prompts short of the very latest (`total - 5`,
    // still well inside the RECENT window) wins no such tiebreak against the
    // single global winner, so the legacy single call still starves it.
    const midRecentPromptNumber = total - 5;
    expect(legacyRendered).not.toContain(`T${midRecentPromptNumber} `);

    const boundary = total - MILESTONE_INJECTION_RECENT_TURNS;
    expect(boundary).toBe(oldTierOneCount);
    const oldView = buildTimelineView(db, {
      id: `S${sessionId}/T..${boundary}`,
      view: "milestones",
      pageSize: Number.MAX_SAFE_INTEGER,
    });
    const recentView = buildTimelineView(db, {
      id: `S${sessionId}/T${boundary + 1}..`,
      view: "milestones",
      pageSize: Number.MAX_SAFE_INTEGER,
    });
    expect(oldView.pagedMilestones.length).toBeGreaterThan(0);
    expect(recentView.pagedMilestones.length).toBeGreaterThan(0);

    const budget = MILESTONE_INJECTION_TOKEN_BUDGET;
    const half = Math.floor(budget / 2);
    const injected = renderSessionMilestoneInjection(db, sessionId, { tokenBudget: budget });
    const expected =
      renderMilestoneInjection(oldView, { tokenBudget: half }) +
      "\n\n" +
      renderMilestoneInjection(recentView, { tokenBudget: half });
    expect(injected).toBe(expected);
    // The recency guarantee, restated on the actual split output: the
    // near-latest RECENT turn — starved above — now survives, because the
    // split gives the recent half its own independent election under half
    // the budget, never competing against the 35 old tier-① releases at all.
    expect(injected).toContain(`T${midRecentPromptNumber} `);
    db.close();
  });

  test("eraCutoffEpoch and showEarlierHint:false thread through both calls unchanged", () => {
    const db = createDatabase(":memory:");
    const oldTierOneCount = 35;
    const recentCount = MILESTONE_INJECTION_RECENT_TURNS;
    const total = oldTierOneCount + recentCount;
    const rows: SeedRow[] = [];
    for (let n = 1; n <= total; n += 1) {
      rows.push(fillerRow(n, ERA_BASE + n * 60));
    }
    const sessionId = seedSession(db, "era-cutoff-split", rows);
    for (let n = 1; n <= oldTierOneCount; n += 1) {
      indexTurn(db, sessionId, n);
    }

    // A cutoff after every seeded turn: `eraCutoffEpoch` reaches both calls,
    // exercised as a plain pass-through (spec D11 says the value is not
    // renegotiated here) rather than by asserting on segment-spine content,
    // which this ticket's territory does not otherwise touch.
    const eraCutoffEpoch = ERA_BASE + (total + 1) * 60;
    const boundary = total - MILESTONE_INJECTION_RECENT_TURNS;
    const oldView = buildTimelineView(db, {
      id: `S${sessionId}/T..${boundary}`,
      view: "milestones",
      pageSize: Number.MAX_SAFE_INTEGER,
      eraCutoffEpoch,
    });
    const recentView = buildTimelineView(db, {
      id: `S${sessionId}/T${boundary + 1}..`,
      view: "milestones",
      pageSize: Number.MAX_SAFE_INTEGER,
      eraCutoffEpoch,
    });
    expect(oldView.eraCutoffEpoch).toBe(eraCutoffEpoch);
    expect(recentView.eraCutoffEpoch).toBe(eraCutoffEpoch);

    const budget = MILESTONE_INJECTION_TOKEN_BUDGET;
    const half = Math.floor(budget / 2);
    const injected = renderSessionMilestoneInjection(db, sessionId, {
      tokenBudget: budget,
      eraCutoffEpoch,
    });
    const expected =
      renderMilestoneInjection(oldView, { tokenBudget: half }) +
      "\n\n" +
      renderMilestoneInjection(recentView, { tokenBudget: half });
    expect(injected).toBe(expected);
    expect(injected).not.toContain("earlier: timeline(");
    db.close();
  });

  test("a side whose content is ALL era-side (empty legacy body, spine/orphan rows only) still counts as non-empty — the split runs two-sided, no reallocation misfire", () => {
    // Pins `hasMilestoneRows`' spine/orphan clauses: a mutation reducing it
    // to `pagedMilestones.length > 0` reads an era-era window as "empty",
    // misfires the reallocation rule, and renders the OLD side alone at the
    // full budget.
    const db = createDatabase(":memory:");
    const oldTierOneCount = 35;
    const recentCount = MILESTONE_INJECTION_RECENT_TURNS;
    const total = oldTierOneCount + recentCount;
    const rows: SeedRow[] = [];
    for (let n = 1; n <= total; n += 1) {
      rows.push(fillerRow(n, ERA_BASE + n * 60));
    }
    const sessionId = seedSession(db, "era-recent-side", rows);
    for (let n = 1; n <= oldTierOneCount; n += 1) {
      indexTurn(db, sessionId, n);
    }
    for (let n = oldTierOneCount + 1; n <= oldTierOneCount + 6; n += 1) {
      indexTurn(db, sessionId, n);
    }

    // Cutoff BETWEEN the sides: OLD is legacy (paged body), RECENT is era
    // (segment spine / orphan anchors, empty legacy body by construction).
    const eraCutoffEpoch = ERA_BASE + oldTierOneCount * 60 + 30;
    const boundary = total - MILESTONE_INJECTION_RECENT_TURNS;
    const oldView = buildTimelineView(db, {
      id: `S${sessionId}/T..${boundary}`,
      view: "milestones",
      pageSize: Number.MAX_SAFE_INTEGER,
      eraCutoffEpoch,
    });
    const recentView = buildTimelineView(db, {
      id: `S${sessionId}/T${boundary + 1}..`,
      view: "milestones",
      pageSize: Number.MAX_SAFE_INTEGER,
      eraCutoffEpoch,
    });
    // Preconditions that make this fixture the discriminator: the RECENT
    // side's legacy body is empty while its era surfaces carry rows.
    expect(recentView.pagedMilestones).toEqual([]);
    expect(
      recentView.segmentSpine.length + recentView.orphanAnchors.length,
    ).toBeGreaterThan(0);

    const budget = MILESTONE_INJECTION_TOKEN_BUDGET;
    const half = Math.floor(budget / 2);
    const injected = renderSessionMilestoneInjection(db, sessionId, {
      tokenBudget: budget,
      eraCutoffEpoch,
    });
    const expected =
      renderMilestoneInjection(oldView, { tokenBudget: half }) +
      "\n\n" +
      renderMilestoneInjection(recentView, { tokenBudget: half });
    expect(injected).toBe(expected);
    db.close();
  });
});
