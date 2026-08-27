import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import { addSegmentMembers, createSegment, type SegmentRecord } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { MILESTONE_INJECTION_RECENT_TURNS } from "../../src/hooks/milestone-injection";
import { renderAttachedSegmentBlock, segmentBlockHeader } from "../../src/hooks/session-composition";
import { chronologicalSegmentMembers } from "../../src/mcp/segment-card";
import {
  buildSegmentTimelineView,
  buildSplitSegmentMilestoneCard,
  renderSegmentTimeline,
  selectSegmentMilestonesByEdgeSignals,
  timelineQuery,
} from "../../src/mcp/timeline";

/**
 * segment-card-recent-old-split spec, ticket 03: `buildSplitSegmentMilestoneCard`
 * (mcp/timeline.ts) — the SessionStart segment milestones CARD's own
 * two-election composer, deliberately separate from `timelineQuery`'s
 * segmentRoute branch (decision 7: `timeline(id="E<n>", view="milestones")`
 * keeps rendering the single-election `renderSegmentTimeline` unchanged,
 * asserted directly below).
 *
 * Fixtures put the OLD side and the RECENT side in DIFFERENT sessions with
 * their own independent prompt numbering (decision 1: "cross-session — a
 * segment spanning sessions counts members, not prompt numbers"), which a
 * prompt-number-based boundary could not do at all.
 */

const ERA = 1_950_000_000;

function seedSession(db: Database, contentSessionId: string, epoch: number, title?: string): number {
  return upsertSession(db, {
    contentSessionId,
    project: "/tmp/split-fixture",
    title: title ?? contentSessionId,
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

/** citer's own `indexes` edge, unsettled tags default (`tailTag`/`headTag` omitted — plain tier ②, same as `tests/hooks/milestone-injection.test.ts`'s `indexTurn`). */
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

/**
 * Mirrors `buildSplitSegmentMilestoneCard`'s own boundary math (excluded-then-
 * sliced live members), so a test can compute the REAL expected kept set for
 * either side by calling `selectSegmentMilestonesByEdgeSignals` directly —
 * the same function under test — rather than guessing which row a token
 * budget and an election-rank tiebreak happen to seat.
 */
function splitLiveMembers(
  db: Database,
  segment: Pick<SegmentRecord, "id">,
  recentMemberCount: number,
) {
  const liveMembers = chronologicalSegmentMembers(db, segment, null).filter(
    (member) => member.status !== "skipped",
  );
  const boundaryIndex = Math.max(0, liveMembers.length - recentMemberCount);
  return {
    oldMembers: liveMembers.slice(0, boundaryIndex),
    recentMembers: liveMembers.slice(boundaryIndex),
  };
}

describe("buildSplitSegmentMilestoneCard (segment-card-recent-old-split spec, ticket 03)", () => {
  test("MILESTONE_INJECTION_RECENT_TURNS is the shared boundary VALUE (decision 1: imported, not re-declared) — pinned at 200", () => {
    expect(MILESTONE_INJECTION_RECENT_TURNS).toBe(200);
  });

  test("a segment at or under the recent-turn boundary renders BYTE-IDENTICAL to the pre-split card (decision 2 fallback) — same string `timelineQuery`'s own single-election view already produces", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const sessionId = seedSession(db, "small-segment", ERA);
    const segment = createSegment(db, { title: "small segment", nowEpoch: ERA });
    const t1 = makeTurn(db, sessionId, 1, ERA + 1, "only member");
    addSegmentMembers(db, segment.id, [t1], ERA);

    const split = buildSplitSegmentMilestoneCard(db, segment.id, null, 2000, MILESTONE_INJECTION_RECENT_TURNS);
    const unsplit = timelineQuery(db, { id: `E${segment.id}`, view: "milestones", pageBudget: 2000 });

    expect(split).toBe(unsplit);
    // The discriminator (mirrors `renderSessionMilestoneInjection`'s own
    // "empty old side" test): RECENT alone gets the FULL budget, not
    // `floor(budget/2)` — at this fixture's size both happen to look the
    // same, so the mutation-verify section below is what actually proves the
    // budget argument travels through as 2000, not 1000.
    db.close();
  });

  test("ticket 06 parity: a raw OLD-side row that is `skipped` never counts toward the split boundary — excluded BEFORE the boundary is computed, same discipline `buildSegmentTimelineView` already applies", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const noisyOldSessionId = seedSession(db, "skipped-old-session", ERA);
    const noisyRecentSessionId = seedSession(
      db,
      "recent-session-under-boundary",
      ERA + 500_000,
      "shared recent session title",
    );
    const noisySegment = createSegment(db, { title: "mostly-skipped-old segment", nowEpoch: ERA });

    // 60 OLD-session rows, ALL skipped — raw total (60 + 180 = 240) crosses
    // the 200 boundary, but LIVE total (180) does not.
    const skippedIds: number[] = [];
    for (let i = 0; i < 60; i += 1) {
      const id = makeTurn(db, noisyOldSessionId, i + 1, ERA + i, `skipped old ${i}`);
      db.query("UPDATE turns SET status = 'skipped' WHERE id = ?").run(id);
      skippedIds.push(id);
    }
    const liveIds: number[] = [];
    for (let i = 0; i < 180; i += 1) {
      liveIds.push(makeTurn(db, noisyRecentSessionId, i + 1, ERA + 500_000 + i, `live recent ${i}`));
    }
    addSegmentMembers(db, noisySegment.id, [...skippedIds, ...liveIds], ERA);
    const noisy = buildSplitSegmentMilestoneCard(
      db,
      noisySegment.id,
      null,
      2000,
      MILESTONE_INJECTION_RECENT_TURNS,
    );
    expect(noisy).not.toContain("skipped old");

    // A CLEAN fixture with the identical 180 live turns and NO skipped noise
    // at all — same content, same epochs, same segment title. If exclusion
    // happens before the boundary is computed (ticket 06 parity), the two
    // renders are byte-for-byte the same: the skipped rows contribute
    // neither content nor a phantom OLD half.
    const cleanSessionId = seedSession(
      db,
      "clean-recent-session",
      ERA + 500_000,
      "shared recent session title",
    );
    const cleanSegment = createSegment(db, { title: "mostly-skipped-old segment", nowEpoch: ERA });
    const cleanIds: number[] = [];
    for (let i = 0; i < 180; i += 1) {
      cleanIds.push(makeTurn(db, cleanSessionId, i + 1, ERA + 500_000 + i, `live recent ${i}`));
    }
    addSegmentMembers(db, cleanSegment.id, cleanIds, ERA);
    const clean = buildSplitSegmentMilestoneCard(
      db,
      cleanSegment.id,
      null,
      2000,
      MILESTONE_INJECTION_RECENT_TURNS,
    );

    // Both segments render from DIFFERENT segment/session ids (two segments,
    // two sessions, in the same fixture db), so compare with those id
    // substitutions normalized out rather than asserting raw equality
    // against an id-sensitive string.
    const normalize = (text: string, sessionId: number, segmentId: number) =>
      text.replaceAll(`S${sessionId}`, "S<recent>").replaceAll(`E${segmentId}`, "E<id>");
    expect(normalize(noisy, noisyRecentSessionId, noisySegment.id)).toBe(
      normalize(clean, cleanSessionId, cleanSegment.id),
    );
    // One block, one segment header inside it (no OLD half at all: this is
    // structurally the same one-sided branch the ≤200 fallback exercises).
    expect(noisy.match(/^\[E\d+\] /gm)?.length).toBe(1);
    db.close();
  });

  test("the recency guarantee: a big OLD side that would fill the WHOLE unified budget on its own (E70's real-world 'seats zero of the newest turns' shape) no longer starves RECENT once each side elects independently", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const oldSessionId = seedSession(db, "starvation-old-session", ERA);
    const recentSessionId = seedSession(db, "starvation-recent-session", ERA + 1_000_000);
    const segment = createSegment(db, { title: "starvation segment", nowEpoch: ERA });

    // 150 OLD members, chained into tier ②/③ so EVERY one of them outranks
    // an edge-free RECENT filler in a single unified election. Calibrated
    // (measured directly against `selectSegmentMilestonesByEdgeSignals`):
    // at pageBudget 2000 these 150 alone already consume the entire row
    // budget — the unified election seats 35 of them and ZERO of the 200
    // RECENT rows, reproducing the live regression this ticket fixes.
    const oldIds: number[] = [];
    for (let i = 0; i < 150; i += 1) {
      oldIds.push(makeTurn(db, oldSessionId, i + 1, ERA + i, `old anchor ${i}`));
    }
    for (let i = 1; i < oldIds.length; i += 1) {
      indexEdge(db, oldIds[i]!, oldIds[i - 1]!);
    }
    const recentIds: number[] = [];
    for (let i = 0; i < MILESTONE_INJECTION_RECENT_TURNS; i += 1) {
      recentIds.push(
        makeTurn(db, recentSessionId, i + 1, ERA + 1_000_000 + i, `recent filler ${i}`),
      );
    }
    addSegmentMembers(db, segment.id, [...oldIds, ...recentIds], ERA);

    // Baseline: the single-election shape this ticket replaces, at the
    // card's own full budget — confirms the starvation premise before
    // asserting the fix.
    const unified = buildSegmentTimelineView(db, {
      segmentId: segment.id,
      view: "milestones",
      pageBudget: 2000,
    });
    const unifiedKeptIds = new Set(unified.keptMilestones.map((row) => row.member.turnId));
    expect(unifiedKeptIds.size).toBeGreaterThan(0);
    for (const id of recentIds) {
      expect(unifiedKeptIds.has(id)).toBe(false);
    }

    // The fix: two independent elections, half budget each. Compute the REAL
    // expected kept set for each side by calling the same election function
    // directly — a token-budget fitter's within-tier tiebreak (recency desc)
    // does not seat prompt-number order, so a guessed title would be wrong
    // for the wrong reason; asking the function itself is what this ticket's
    // guarantee actually promises.
    const { oldMembers, recentMembers } = splitLiveMembers(db, segment, MILESTONE_INJECTION_RECENT_TURNS);
    const half = Math.floor(2000 / 2);
    const expectedOld = selectSegmentMilestonesByEdgeSignals(db, oldMembers, half);
    const expectedRecent = selectSegmentMilestonesByEdgeSignals(db, recentMembers, half);
    expect(expectedOld.kept.length).toBeGreaterThan(0);
    expect(expectedRecent.kept.length).toBeGreaterThan(0);
    // The discriminator: at the FULL (unhalved) budget either side admits
    // MORE rows than at half — find one that survives only with the full
    // budget, so a mutation that skips the halving (passes `pageBudget`
    // straight through to each side) is caught, not just "did SOME row
    // survive" (a superset would pass that trivially).
    const recentAtFullBudget = selectSegmentMilestonesByEdgeSignals(db, recentMembers, 2000);
    expect(recentAtFullBudget.kept.length).toBeGreaterThan(expectedRecent.kept.length);
    const halfBudgetKeptIds = new Set(expectedRecent.kept.map((row) => row.member.turnId));
    const fullBudgetOnlyRow = recentAtFullBudget.kept.find(
      (row) => !halfBudgetKeptIds.has(row.member.turnId),
    )!;
    expect(fullBudgetOnlyRow).toBeDefined();

    const split = buildSplitSegmentMilestoneCard(db, segment.id, null, 2000, MILESTONE_INJECTION_RECENT_TURNS);
    for (const row of expectedOld.kept) {
      expect(split).toContain(row.member.title!);
    }
    for (const row of expectedRecent.kept) {
      expect(split).toContain(row.member.title!);
    }
    // Genuinely half-budgeted, not full: a row that only fits with the WHOLE
    // 2000-token budget must NOT appear — if it did, the card handed the
    // recent side the full budget instead of its half. A bare `toContain`
    // would false-positive here: honest-token-pricing ticket 04 seats enough
    // rows at half budget that some kept title (e.g. "recent filler 190")
    // contains this row's own title ("recent filler 19") as a substring, so
    // the check needs a digit boundary to tell "this row's own line" from
    // "a longer sibling title that happens to start the same way".
    const escapedTitle = fullBudgetOnlyRow.member.title!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(split).not.toMatch(new RegExp(`${escapedTitle}(?!\\d)`));
    // The recency guarantee, restated on the actual output: SOME recent row
    // now survives — the single-election baseline above seated NONE.
    expect(expectedRecent.kept.some((row) => recentIds.includes(row.member.turnId))).toBe(true);
    db.close();
  });

  test("one block, one hook-slot payload: exactly ONE `[E<n>] · milestones` header wraps a two-part render", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const oldSessionId = seedSession(db, "header-old-session", ERA);
    const recentSessionId = seedSession(db, "header-recent-session", ERA + 1_000_000);
    const segment = createSegment(db, { title: "header segment", nowEpoch: ERA });

    const oldIds: number[] = [];
    for (let i = 0; i < 150; i += 1) {
      oldIds.push(makeTurn(db, oldSessionId, i + 1, ERA + i, `old anchor ${i}`));
    }
    for (let i = 1; i < oldIds.length; i += 1) {
      indexEdge(db, oldIds[i]!, oldIds[i - 1]!);
    }
    const recentIds: number[] = [];
    for (let i = 0; i < MILESTONE_INJECTION_RECENT_TURNS; i += 1) {
      recentIds.push(
        makeTurn(db, recentSessionId, i + 1, ERA + 1_000_000 + i, `recent filler ${i}`),
      );
    }
    addSegmentMembers(db, segment.id, [...oldIds, ...recentIds], ERA);

    const block = renderAttachedSegmentBlock(db, "milestones", segment, null);
    const header = segmentBlockHeader(segment.id, "milestones");
    const headerOccurrences = block.split(header).length - 1;
    expect(headerOccurrences).toBe(1);
    // The card's own outer header is the FIRST line — never nested under an
    // inner segment-title line from either side.
    expect(block.startsWith(`${header}\n`)).toBe(true);
    db.close();
  });

  test("`↳` sub-rows never cross the split boundary: a RECENT row citing the last OLD member (independently visible on the OLD side) shows no `↳` line for it", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const oldSessionId = seedSession(db, "boundary-old-session", ERA);
    const recentSessionId = seedSession(db, "boundary-recent-session", ERA + 1_000_000);
    const segment = createSegment(db, { title: "boundary segment", nowEpoch: ERA });

    // Exactly 2 OLD (boundary = 202 - 200 = 2) + 200 RECENT.
    const old1 = makeTurn(db, oldSessionId, 1, ERA + 1, "OLD first member");
    const old2 = makeTurn(db, oldSessionId, 2, ERA + 2, "OLD boundary member");
    indexEdge(db, old2, old1); // both OLD members seat: old2 tier ②, old1 tier ③ (indexed by an elected ②).
    const recentIds: number[] = [];
    for (let i = 0; i < MILESTONE_INJECTION_RECENT_TURNS; i += 1) {
      recentIds.push(
        makeTurn(db, recentSessionId, i + 1, ERA + 1_000_000 + i, `RECENT member ${i}`),
      );
    }
    addSegmentMembers(db, segment.id, [old1, old2, ...recentIds], ERA);
    // The very first RECENT member cites the boundary OLD member — any
    // relation survives on `↳` (`grounds` reads the in-degree AND the
    // antecedent address, `tests/mcp/timeline.segment-views.test.ts`'s own
    // "minimal row" fixture).
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: recentIds[0]! },
          cited: { kind: "turn", id: old2 },
          relation: "grounds",
          provenance: "judged",
        },
      ],
      ERA,
    );

    const oldSelection = buildSegmentTimelineView(db, {
      segmentId: segment.id,
      view: "milestones",
      pageBudget: 2000,
    });
    // Sanity: old2 (the cited turn) IS independently visible somewhere — the
    // unsplit view over the whole segment seats it.
    expect(oldSelection.keptMilestones.map((row) => row.member.turnId)).toContain(old2);

    const split = buildSplitSegmentMilestoneCard(db, segment.id, null, 2000, MILESTONE_INJECTION_RECENT_TURNS);
    const recentRow = split.split("\n").find((line) => line.includes("RECENT member 0"))!;
    expect(recentRow).toBeDefined();
    const lines = split.split("\n");
    const recentRowIndex = lines.indexOf(recentRow);
    // No `↳` line immediately beneath the RECENT row — its OLD-side
    // antecedent never crosses into this call's own citation universe
    // (`buildElectedCitations` requires BOTH ends admitted in the SAME call).
    expect(lines[recentRowIndex + 1]?.includes("↳")).toBe(false);
    // The OLD member DOES still render — just in its own, separate half.
    expect(split).toContain("OLD boundary member");
    db.close();
  });

  test("timeline(id=\"E<n>\", view=\"milestones\") — the MCP query surface — stays the single-election `renderSegmentTimeline` render, untouched by the split (decision 7)", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const oldSessionId = seedSession(db, "mcp-untouched-old", ERA);
    const recentSessionId = seedSession(db, "mcp-untouched-recent", ERA + 1_000_000);
    const segment = createSegment(db, { title: "mcp-untouched segment", nowEpoch: ERA });
    const oldIds: number[] = [];
    for (let i = 0; i < 150; i += 1) {
      oldIds.push(makeTurn(db, oldSessionId, i + 1, ERA + i, `old anchor ${i}`));
    }
    for (let i = 1; i < oldIds.length; i += 1) {
      indexEdge(db, oldIds[i]!, oldIds[i - 1]!);
    }
    const recentIds: number[] = [];
    for (let i = 0; i < MILESTONE_INJECTION_RECENT_TURNS; i += 1) {
      recentIds.push(
        makeTurn(db, recentSessionId, i + 1, ERA + 1_000_000 + i, `recent filler ${i}`),
      );
    }
    addSegmentMembers(db, segment.id, [...oldIds, ...recentIds], ERA);

    const mcpView = timelineQuery(db, { id: `E${segment.id}`, view: "milestones", pageBudget: 2000 });
    const directRenderer = renderSegmentTimeline(
      buildSegmentTimelineView(db, { segmentId: segment.id, view: "milestones", pageBudget: 2000 }),
    );
    expect(mcpView).toBe(directRenderer);
    // EXPECTED divergence (decision 7): the card's own split output is NOT
    // the same string as the MCP single-election view for this same
    // starvation fixture — each surface now pins its OWN shape.
    const card = buildSplitSegmentMilestoneCard(db, segment.id, null, 2000, MILESTONE_INJECTION_RECENT_TURNS);
    expect(card).not.toBe(mcpView);
    expect(mcpView).not.toContain("recent filler"); // the single election still starves it
    expect(card).toContain("recent filler"); // the split card does not
    db.close();
  });

  test("mutation check: passing the WRONG recentMemberCount collapses the boundary — proves the boundary argument is actually read, not a hard-coded 200", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const oldSessionId = seedSession(db, "mutation-old-session", ERA);
    const recentSessionId = seedSession(db, "mutation-recent-session", ERA + 1_000_000);
    const segment = createSegment(db, { title: "mutation segment", nowEpoch: ERA });
    const oldIds: number[] = [];
    for (let i = 0; i < 150; i += 1) {
      oldIds.push(makeTurn(db, oldSessionId, i + 1, ERA + i, `old anchor ${i}`));
    }
    for (let i = 1; i < oldIds.length; i += 1) {
      indexEdge(db, oldIds[i]!, oldIds[i - 1]!);
    }
    const recentIds: number[] = [];
    for (let i = 0; i < MILESTONE_INJECTION_RECENT_TURNS; i += 1) {
      recentIds.push(
        makeTurn(db, recentSessionId, i + 1, ERA + 1_000_000 + i, `recent filler ${i}`),
      );
    }
    addSegmentMembers(db, segment.id, [...oldIds, ...recentIds], ERA);

    const correctBoundary = buildSplitSegmentMilestoneCard(
      db,
      segment.id,
      null,
      2000,
      MILESTONE_INJECTION_RECENT_TURNS,
    );
    // A boundary of 0 folds every live member into the OLD side — RECENT is
    // structurally empty, so OLD alone renders under the full budget and the
    // fillers never seat (they lose the OLD tier ①/②/③ election outright).
    const zeroBoundary = buildSplitSegmentMilestoneCard(db, segment.id, null, 2000, 0);
    expect(correctBoundary).toContain("recent filler");
    expect(zeroBoundary).not.toContain("recent filler");
    expect(correctBoundary).not.toBe(zeroBoundary);
    db.close();
  });
});

/** Counts `[T<n>]` row lines in a rendered card — the same discriminator `/tmp/cliff-probe.ts` uses. */
function countMilestoneRows(text: string): number {
  return (text.match(/^\s+\[T\d+\]/gm) ?? []).length;
}

describe("buildSplitSegmentMilestoneCard (segment-card-work-conserving spec, ticket 06)", () => {
  test("the measured cliff is gone: one member crossing the OLD boundary no longer halves the card — the delta stays small", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const oldSessionId = seedSession(db, "cliff-old-session", ERA);
    const recentSessionId = seedSession(db, "cliff-recent-session", ERA + 1_000_000);
    const segment = createSegment(db, { title: "cliff segment", nowEpoch: ERA });

    // A single cheap OLD candidate (no edges — the reviewer's reproduction
    // shape) plus enough RECENT filler candidates that RECENT stays hungry
    // at a bare half budget (mirrors the E70 shape: OLD members=1, rows
    // collapse 63->31 pre-fix).
    const oldId = makeTurn(db, oldSessionId, 1, ERA + 1, "old cheap anchor");
    const recentIds: number[] = [];
    for (let i = 0; i < 400; i += 1) {
      recentIds.push(makeTurn(db, recentSessionId, i + 1, ERA + 1_000_000 + i, `recent filler ${i}`));
    }
    addSegmentMembers(db, segment.id, [oldId, ...recentIds], ERA);

    // N: OLD side empty (recentMemberCount covers every live member).
    const cardOldEmpty = buildSplitSegmentMilestoneCard(db, segment.id, null, 2000, recentIds.length + 1);
    // N+1: exactly one member (the cheap anchor) crosses into the OLD side.
    const cardOldOne = buildSplitSegmentMilestoneCard(db, segment.id, null, 2000, recentIds.length);

    const rowsOldEmpty = countMilestoneRows(cardOldEmpty);
    const rowsOldOne = countMilestoneRows(cardOldOne);
    // Both numbers named, per the acceptance criterion.
    expect(rowsOldOne).toBeGreaterThan(0);
    expect(rowsOldEmpty).toBeGreaterThan(0);
    const delta = Math.abs(rowsOldEmpty - rowsOldOne);
    // Pre-fix this delta was ~half of rowsOldEmpty (63 -> 31 on the real E70
    // card). Post-fix it must be small — well under a tenth, not a half.
    expect(delta).toBeLessThan(rowsOldEmpty * 0.1);
    // Guards against a mutation that caps BOTH configs at a bare half (which
    // would also keep the delta small, vacuously): RECENT with the cheap OLD
    // anchor must render MORE rows than RECENT would at a bare, un-boosted
    // half — i.e. the boost is actually happening, not just "both sides
    // agree on the same reduced number". Subtract exactly 1 for OLD's own
    // single row (it always contributes exactly one) rather than comparing
    // the raw total, which would pass vacuously by that constant +1 alone.
    const { recentMembers } = splitLiveMembers(db, segment, recentIds.length);
    const bareHalfRecent = selectSegmentMilestonesByEdgeSignals(db, recentMembers, Math.floor(2000 / 2));
    const recentRowsInCardOldOne = rowsOldOne - 1;
    expect(recentRowsInCardOldOne).toBeGreaterThan(bareHalfRecent.kept.length);
    db.close();
  });

  test("a hungry side never yields: both sides have more candidates than their half can seat, so each renders EXACTLY what today's guaranteed-half election produces", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const oldSessionId = seedSession(db, "hungry-old-session", ERA);
    const recentSessionId = seedSession(db, "hungry-recent-session", ERA + 1_000_000);
    const segment = createSegment(db, { title: "hungry segment", nowEpoch: ERA });

    // 150 OLD members chained tier ②/③ (same shape as the "recency
    // guarantee" fixture above) — expensive enough that even at HALF budget
    // it cannot seat all 150. 200 RECENT fillers, likewise more than a half
    // budget can seat.
    const oldIds: number[] = [];
    for (let i = 0; i < 150; i += 1) {
      oldIds.push(makeTurn(db, oldSessionId, i + 1, ERA + i, `hungry old anchor ${i}`));
    }
    for (let i = 1; i < oldIds.length; i += 1) {
      indexEdge(db, oldIds[i]!, oldIds[i - 1]!);
    }
    const recentIds: number[] = [];
    for (let i = 0; i < MILESTONE_INJECTION_RECENT_TURNS; i += 1) {
      recentIds.push(
        makeTurn(db, recentSessionId, i + 1, ERA + 1_000_000 + i, `hungry recent filler ${i}`),
      );
    }
    addSegmentMembers(db, segment.id, [...oldIds, ...recentIds], ERA);

    const half = Math.floor(2000 / 2);
    const { oldMembers, recentMembers } = splitLiveMembers(db, segment, MILESTONE_INJECTION_RECENT_TURNS);
    const expectedOld = selectSegmentMilestonesByEdgeSignals(db, oldMembers, half);
    const expectedRecent = selectSegmentMilestonesByEdgeSignals(db, recentMembers, half);
    // Both genuinely hungry — this is the guarantee under test.
    expect(expectedOld.demotedCount).toBeGreaterThan(0);
    expect(expectedRecent.demotedCount).toBeGreaterThan(0);

    const card = buildSplitSegmentMilestoneCard(db, segment.id, null, 2000, MILESTONE_INJECTION_RECENT_TURNS);
    // Exact row-count equality (not mere containment): if either side had
    // been re-elected at a larger budget, its row count would be strictly
    // MORE than its bare-half count, so this equality is what actually
    // proves neither side was boosted.
    expect(countMilestoneRows(card)).toBe(expectedOld.kept.length + expectedRecent.kept.length);
    db.close();
  });

  test("a side that seats everything yields the remainder, and the other side renders MORE rows than it would have at a bare half", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const oldSessionId = seedSession(db, "yield-old-session", ERA);
    const recentSessionId = seedSession(db, "yield-recent-session", ERA + 1_000_000);
    const segment = createSegment(db, { title: "yield segment", nowEpoch: ERA });

    const oldId = makeTurn(db, oldSessionId, 1, ERA + 1, "single cheap OLD row");
    const recentIds: number[] = [];
    for (let i = 0; i < 400; i += 1) {
      recentIds.push(makeTurn(db, recentSessionId, i + 1, ERA + 1_000_000 + i, `yield recent filler ${i}`));
    }
    addSegmentMembers(db, segment.id, [oldId, ...recentIds], ERA);

    const half = Math.floor(2000 / 2);
    const { oldMembers, recentMembers } = splitLiveMembers(db, segment, recentIds.length);
    const oldSelection = selectSegmentMilestonesByEdgeSignals(db, oldMembers, half);
    // The condition this test exercises: OLD seated its only candidate with
    // room to spare (decision 2's primary signal).
    expect(oldSelection.kept.length).toBe(1);
    expect(oldSelection.demotedCount).toBe(0);
    const bareHalfRecent = selectSegmentMilestonesByEdgeSignals(db, recentMembers, half);
    expect(bareHalfRecent.demotedCount).toBeGreaterThan(0); // RECENT is hungry at a bare half.

    const card = buildSplitSegmentMilestoneCard(db, segment.id, null, 2000, recentIds.length);
    const cardRecentRows = countMilestoneRows(card) - oldSelection.kept.length;
    // Both row counts named.
    expect(cardRecentRows).toBeGreaterThan(bareHalfRecent.kept.length);
    db.close();
  });

  test("a side with candidates whose half cannot cover even the reserve seats zero rows and yields too — keyed on `kept.length === 0`, not `demotedCount === 0`", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const oldSessionId = seedSession(db, "reserve-old-session", ERA);
    const recentSessionId = seedSession(db, "reserve-recent-session", ERA + 1_000_000);
    const segment = createSegment(db, { title: "reserve segment", nowEpoch: ERA });

    // A pageBudget small enough that `half` clears the fixed
    // header+pointer+legend reserve for a CHEAP row but not for this
    // deliberately long OLD title — the asymmetry decision 5 requires: the
    // same numeric `half` fails ONE side's content and not the other's.
    const oldId = makeTurn(db, oldSessionId, 1, ERA + 1, "A".repeat(100));
    const recentIds: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      recentIds.push(makeTurn(db, recentSessionId, i + 1, ERA + 1_000_000 + i, `r${i}`));
    }
    addSegmentMembers(db, segment.id, [oldId, ...recentIds], ERA);

    const pageBudget = 420;
    const half = Math.floor(pageBudget / 2);
    const { oldMembers, recentMembers } = splitLiveMembers(db, segment, recentIds.length);
    const oldSelection = selectSegmentMilestonesByEdgeSignals(db, oldMembers, half);
    // The condition named: OLD has a candidate (demotedCount reflects it,
    // NOT zero) yet seated none of it — `demotedCount === 0` alone would
    // have missed this side entirely.
    expect(oldSelection.kept.length).toBe(0);
    expect(oldSelection.demotedCount).toBeGreaterThan(0);
    const bareHalfRecent = selectSegmentMilestonesByEdgeSignals(db, recentMembers, half);
    expect(bareHalfRecent.kept.length).toBeGreaterThan(0);
    expect(bareHalfRecent.demotedCount).toBeGreaterThan(0); // RECENT stays hungry at bare half.

    const card = buildSplitSegmentMilestoneCard(db, segment.id, null, pageBudget, recentIds.length);
    // OLD contributed nothing at all — no OLD header, no OLD row.
    expect(card).not.toContain("A".repeat(100));
    expect(card.match(/^\[E\d+\] /gm)?.length).toBe(1);
    // RECENT was re-elected at (near) the FULL pageBudget, not just its bare
    // half — strictly more rows than the bare-half count.
    expect(countMilestoneRows(card)).toBeGreaterThan(bareHalfRecent.kept.length);
    db.close();
  });
});
