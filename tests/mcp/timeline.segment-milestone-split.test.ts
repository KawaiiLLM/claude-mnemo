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

  test("a segment at or under the recent-turn boundary elects the SAME turn as the pre-split MCP view (decision 2 fallback), but the CARD render itself no longer matches that view's shape (ticket 10: no `[E<n>]` header, no title-carrying `[S<n>]` line, no Legend, on the card side only)", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const sessionId = seedSession(db, "small-segment", ERA);
    const segment = createSegment(db, { title: "small segment", nowEpoch: ERA });
    const t1 = makeTurn(db, sessionId, 1, ERA + 1, "only member");
    addSegmentMembers(db, segment.id, [t1], ERA);

    const split = buildSplitSegmentMilestoneCard(db, segment.id, null, 2000, MILESTONE_INJECTION_RECENT_TURNS);
    const unsplit = timelineQuery(db, { id: `E${segment.id}`, view: "milestones", pageBudget: 2000 });

    // Ticket 10 retires ticket 03 decision 2's byte-identical fallback for
    // the CARD specifically (decision 1: the card diverges from the MCP view
    // unconditionally now, not just above the recent-turn boundary) — the
    // fallback's remaining content, "the whole segment goes through ONE
    // election, at the FULL budget", still holds and is what the turn-set
    // equality below actually proves.
    expect(split).not.toBe(unsplit);
    expect(split).toContain("only member");
    expect(unsplit).toContain("only member");
    // The MCP view alone keeps the segment header and the title-carrying
    // transition line; the card carries neither.
    expect(unsplit).toContain(`[E${segment.id}] small segment`);
    expect(split).not.toContain(`[E${segment.id}]`);
    expect(unsplit).toContain(`[S${sessionId}] small-segment`);
    expect(split).not.toContain("small-segment");
    // The card's own bare marker — address only, no title.
    expect(split).toMatch(new RegExp(`^ {4}\\[S${sessionId}\\]$`, "m"));
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
    // Ticket 10: no `[E<n>]` header anywhere in the card body — not even the
    // ONE-sided branch's, which pre-ticket-10 carried exactly one. One bare
    // `[S<n>]` marker instead (no OLD half at all: this is structurally the
    // same one-sided branch the ≤200 fallback exercises, and it is all one
    // session).
    expect(noisy.match(/^\[E\d+\] /gm)).toBeNull();
    expect(noisy.match(/^ {4}\[S\d+\]$/gm)?.length).toBe(1);
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
    const expectedOld = selectSegmentMilestonesByEdgeSignals(db, oldMembers, half, undefined, { cardMode: true });
    const expectedRecent = selectSegmentMilestonesByEdgeSignals(db, recentMembers, half, undefined, { cardMode: true });
    expect(expectedOld.kept.length).toBeGreaterThan(0);
    expect(expectedRecent.kept.length).toBeGreaterThan(0);
    // The discriminator: at the FULL (unhalved) budget either side admits
    // MORE rows than at half — find one that survives only with the full
    // budget, so a mutation that skips the halving (passes `pageBudget`
    // straight through to each side) is caught, not just "did SOME row
    // survive" (a superset would pass that trivially).
    const recentAtFullBudget = selectSegmentMilestonesByEdgeSignals(db, recentMembers, 2000, undefined, { cardMode: true });
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
    // Ticket 10: zero OTHER headers — no per-side `[E<n>] title` line
    // anywhere in the card body this slot header wraps.
    expect(block.match(/^\[E\d+\] /gm)?.length).toBe(1); // the ONE occurrence IS the slot header itself.
    const cardBody = buildSplitSegmentMilestoneCard(
      db,
      segment.id,
      null,
      2000,
      MILESTONE_INJECTION_RECENT_TURNS,
    );
    expect(cardBody.match(/^\[E\d+\] /gm)).toBeNull();
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
    const bareHalfRecent = selectSegmentMilestonesByEdgeSignals(db, recentMembers, Math.floor(2000 / 2), undefined, { cardMode: true });
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
    const expectedOld = selectSegmentMilestonesByEdgeSignals(db, oldMembers, half, undefined, { cardMode: true });
    const expectedRecent = selectSegmentMilestonesByEdgeSignals(db, recentMembers, half, undefined, { cardMode: true });
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
    const oldSelection = selectSegmentMilestonesByEdgeSignals(db, oldMembers, half, undefined, { cardMode: true });
    // The condition this test exercises: OLD seated its only candidate with
    // room to spare (decision 2's primary signal).
    expect(oldSelection.kept.length).toBe(1);
    expect(oldSelection.demotedCount).toBe(0);
    const bareHalfRecent = selectSegmentMilestonesByEdgeSignals(db, recentMembers, half, undefined, { cardMode: true });
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

    // A pageBudget small enough that `half` clears the fixed pointer reserve
    // for a CHEAP row but not for this deliberately long OLD title — the
    // asymmetry decision 5 requires: the same numeric `half` fails ONE
    // side's content and not the other's. Ticket 10 shrank the reserve to
    // `CARD_POINTER_RESERVE_TOKENS` (~10 tokens): an ASCII title no longer
    // reaches it (honest-token pricing is ~0.25 tok/char for ASCII), so this
    // fixture needs a CJK title — 1 tok/char — to still cost more than a
    // small half can afford (measured: a titleCap-length (100-char) Han
    // title plus its own `[S<n>]` marker prices at 108 honest tokens).
    const oldId = makeTurn(db, oldSessionId, 1, ERA + 1, "长".repeat(100));
    const recentIds: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      recentIds.push(makeTurn(db, recentSessionId, i + 1, ERA + 1_000_000 + i, `r${i}`));
    }
    addSegmentMembers(db, segment.id, [oldId, ...recentIds], ERA);

    const pageBudget = 230;
    const half = Math.floor(pageBudget / 2);
    const { oldMembers, recentMembers } = splitLiveMembers(db, segment, recentIds.length);
    const oldSelection = selectSegmentMilestonesByEdgeSignals(db, oldMembers, half, undefined, { cardMode: true });
    // The condition named: OLD has a candidate (demotedCount reflects it,
    // NOT zero) yet seated none of it — `demotedCount === 0` alone would
    // have missed this side entirely.
    expect(oldSelection.kept.length).toBe(0);
    expect(oldSelection.demotedCount).toBeGreaterThan(0);
    const bareHalfRecent = selectSegmentMilestonesByEdgeSignals(db, recentMembers, half, undefined, { cardMode: true });
    expect(bareHalfRecent.kept.length).toBeGreaterThan(0);
    expect(bareHalfRecent.demotedCount).toBeGreaterThan(0); // RECENT stays hungry at bare half.

    const card = buildSplitSegmentMilestoneCard(db, segment.id, null, pageBudget, recentIds.length);
    // OLD contributed nothing at all — no OLD marker, no OLD row.
    expect(card).not.toContain("长".repeat(100));
    expect(card.match(/^\[E\d+\] /gm)).toBeNull();
    // RECENT was re-elected at (near) the FULL pageBudget, not just its bare
    // half — strictly more rows than the bare-half count.
    expect(countMilestoneRows(card)).toBeGreaterThan(bareHalfRecent.kept.length);
    db.close();
  });
});

describe("buildSplitSegmentMilestoneCard (a-side-that-seats-nothing-yields-everything spec, ticket 08)", () => {
  // All four fixtures below reuse the SAME construction the ticket 06 "reserve"
  // test already established: a title long enough that its own row cannot
  // clear the fixed pointer reserve at a SMALL half budget but clears it
  // easily once given a larger one — measured directly (not guessed) against
  // `selectSegmentMilestonesByEdgeSignals`, so a change to the reserve
  // constant would fail these tests loudly rather than silently drifting
  // them off their intended budget/state pairing. Ticket 10 shrank that
  // reserve to `CARD_POINTER_RESERVE_TOKENS` (~10 tokens, no header, no
  // legend) — an ASCII `"A".repeat(100)` title no longer reaches it (honest
  // pricing is ~0.25 tok/char for ASCII), so every fixture below uses a
  // titleCap-length Han title (1 tok/char) instead, and every pageBudget was
  // re-measured against the new reserve rather than reused from ticket 08's
  // original numbers.

  test("empty + reserve-starved: OLD has no members at all, RECENT cannot clear the reserve at half budget — RECENT ends up rendering because OLD's zero is genuine (kept AND demotedCount both 0), so decision 2's both-zero path tries RECENT first at the FULL budget and it clears the reserve there", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const recentSessionId = seedSession(db, "e08-empty-recent-session", ERA);
    const segment = createSegment(db, { title: "empty-plus-starved segment", nowEpoch: ERA });
    // The segment's ONLY member — recentMemberCount=1 puts it entirely on
    // the RECENT side, so OLD's slice is empty by construction, not merely
    // by losing an election.
    const recentId = makeTurn(db, recentSessionId, 1, ERA + 1, "长".repeat(100));
    addSegmentMembers(db, segment.id, [recentId], ERA);

    const pageBudget = 230;
    const half = Math.floor(pageBudget / 2);
    const { oldMembers, recentMembers } = splitLiveMembers(db, segment, 1);
    expect(oldMembers.length).toBe(0);
    const recentAtHalf = selectSegmentMilestonesByEdgeSignals(db, recentMembers, half, undefined, { cardMode: true });
    // Reserve-starved, not genuinely empty: it HAS a candidate (demotedCount
    // reflects it), it just could not clear the reserve at this half budget.
    expect(recentAtHalf.kept.length).toBe(0);
    expect(recentAtHalf.demotedCount).toBeGreaterThan(0);

    const card = buildSplitSegmentMilestoneCard(db, segment.id, null, pageBudget, 1);
    expect(card).toContain("长".repeat(100));
    db.close();
  });

  test("satisfied + reserve-starved: OLD already seated its only candidate, RECENT cannot clear the reserve at half budget — OLD renders unaffected (a satisfied side's output is invariant to extra budget, so decision 1's unconditional boost changes nothing visible), RECENT stays empty because it is not the 'other side' decision 1 boosts and this pair never reaches decision 2's both-zero rescue (only one side is actually zero) — matches pre-ticket-06 behaviour exactly", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const oldSessionId = seedSession(db, "e08-sat-old-session", ERA);
    const recentSessionId = seedSession(db, "e08-sat-recent-session", ERA + 1_000_000);
    const segment = createSegment(db, { title: "satisfied-plus-starved segment", nowEpoch: ERA });
    const oldId = makeTurn(db, oldSessionId, 1, ERA + 1, "cheap old row");
    const recentId = makeTurn(db, recentSessionId, 1, ERA + 1_000_000, "长".repeat(100));
    addSegmentMembers(db, segment.id, [oldId, recentId], ERA);

    const pageBudget = 230;
    const half = Math.floor(pageBudget / 2);
    const { oldMembers, recentMembers } = splitLiveMembers(db, segment, 1);
    const oldSelection = selectSegmentMilestonesByEdgeSignals(db, oldMembers, half, undefined, { cardMode: true });
    const recentSelection = selectSegmentMilestonesByEdgeSignals(db, recentMembers, half, undefined, { cardMode: true });
    expect(oldSelection.kept.length).toBe(1);
    expect(oldSelection.demotedCount).toBe(0); // OLD: satisfied
    expect(recentSelection.kept.length).toBe(0);
    expect(recentSelection.demotedCount).toBeGreaterThan(0); // RECENT: reserve-starved

    const card = buildSplitSegmentMilestoneCard(db, segment.id, null, pageBudget, 1);
    expect(card).toContain("cheap old row");
    expect(card).not.toContain("长".repeat(100));
    db.close();
  });

  test("both reserve-starved, and both-zero prefers RECENT: neither side clears the reserve at half budget, and at a pageBudget the full budget fits only ONE row — RECENT wins the slot (decision 2's recency-first order), OLD stays starved because the remainder RECENT leaves behind is still under OLD's own reserve threshold", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const oldSessionId = seedSession(db, "e08-both-old-session", ERA);
    const recentSessionId = seedSession(db, "e08-both-recent-session", ERA + 1_000_000);
    const segment = createSegment(db, { title: "both-starved segment", nowEpoch: ERA });
    const oldTitle = "长".repeat(100);
    const recentTitle = "短".repeat(100);
    const oldId = makeTurn(db, oldSessionId, 1, ERA + 1, oldTitle);
    const recentId = makeTurn(db, recentSessionId, 1, ERA + 1_000_000, recentTitle);
    addSegmentMembers(db, segment.id, [oldId, recentId], ERA);

    const pageBudget = 220;
    const half = Math.floor(pageBudget / 2);
    const { oldMembers, recentMembers } = splitLiveMembers(db, segment, 1);
    const oldSelection = selectSegmentMilestonesByEdgeSignals(db, oldMembers, half, undefined, { cardMode: true });
    const recentSelection = selectSegmentMilestonesByEdgeSignals(db, recentMembers, half, undefined, { cardMode: true });
    expect(oldSelection.kept.length).toBe(0);
    expect(oldSelection.demotedCount).toBeGreaterThan(0);
    expect(recentSelection.kept.length).toBe(0);
    expect(recentSelection.demotedCount).toBeGreaterThan(0);

    const card = buildSplitSegmentMilestoneCard(db, segment.id, null, pageBudget, 1);
    // RECENT: tried first at the full budget, clears the reserve.
    expect(card).toContain(recentTitle);
    // OLD: gets only whatever remainder RECENT's actual cost leaves — still
    // not enough to clear its own reserve.
    expect(card).not.toContain(oldTitle);
    expect(countMilestoneRows(card)).toBe(1);
    db.close();
  });

  test("both-zero, budget fits BOTH after re-election: the same starved pair at a larger pageBudget — RECENT's actual rendered cost leaves enough remainder for OLD to also clear its own reserve, so both render", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const oldSessionId = seedSession(db, "e08-fits-old-session", ERA);
    const recentSessionId = seedSession(db, "e08-fits-recent-session", ERA + 1_000_000);
    const segment = createSegment(db, { title: "fits-both segment", nowEpoch: ERA });
    const oldTitle = "长".repeat(100);
    const recentTitle = "短".repeat(100);
    const oldId = makeTurn(db, oldSessionId, 1, ERA + 1, oldTitle);
    const recentId = makeTurn(db, recentSessionId, 1, ERA + 1_000_000, recentTitle);
    addSegmentMembers(db, segment.id, [oldId, recentId], ERA);

    const pageBudget = 230;
    const half = Math.floor(pageBudget / 2);
    const { oldMembers, recentMembers } = splitLiveMembers(db, segment, 1);
    // Confirm the premise: both sides are STILL reserve-starved at this
    // budget's bare half — the rescue below comes entirely from the
    // re-election, not from a half budget that was secretly already enough.
    expect(selectSegmentMilestonesByEdgeSignals(db, oldMembers, half, undefined, { cardMode: true }).kept.length).toBe(0);
    expect(selectSegmentMilestonesByEdgeSignals(db, recentMembers, half, undefined, { cardMode: true }).kept.length).toBe(0);

    const card = buildSplitSegmentMilestoneCard(db, segment.id, null, pageBudget, 1);
    expect(card).toContain(oldTitle);
    expect(card).toContain(recentTitle);
    expect(countMilestoneRows(card)).toBe(2);
    db.close();
  });
});

describe("buildSplitSegmentMilestoneCard (the-card-is-turn-rows-and-nothing-else spec, ticket 10)", () => {
  test("no segment-title line, no title-carrying session line, no Legend on a fixture spanning two sessions — the bare `[S<n>]` marker is the only session artifact present", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const oldSessionId = seedSession(db, "t10-old-session", ERA, "a stale old title nobody should see");
    const recentSessionId = seedSession(db, "t10-recent-session", ERA + 1_000_000, "a stale recent title nobody should see");
    const segment = createSegment(db, { title: "a segment title nobody should see", nowEpoch: ERA });
    const oldId = makeTurn(db, oldSessionId, 1, ERA + 1, "old member");
    const recentId = makeTurn(db, recentSessionId, 1, ERA + 1_000_000, "recent member");
    addSegmentMembers(db, segment.id, [oldId, recentId], ERA);

    const card = buildSplitSegmentMilestoneCard(db, segment.id, null, 2000, 1);

    expect(card).not.toContain("a segment title nobody should see");
    expect(card).not.toContain("a stale old title nobody should see");
    expect(card).not.toContain("a stale recent title nobody should see");
    expect(card).not.toContain("Legend:");
    expect(card).not.toContain(`[E${segment.id}]`);
    // Every line that names a session is a BARE marker — address only, no
    // trailing text of any kind.
    const sessionLines = card.split("\n").filter((line) => /\[S\d+\]/.test(line));
    for (const line of sessionLines) {
      expect(line).toMatch(/^ {4}\[S\d+\]$/);
    }
    expect(sessionLines.length).toBe(2); // one marker per session (OLD, then RECENT).
    db.close();
  });

  test("a bare `[S<n>]` marker opens every run of same-session rows and re-appears at each switch (marker count == switch count + 1) on an interleaved fixture, and a single-session segment gets exactly one marker, at the top", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const sessionA = seedSession(db, "t10-interleave-a", ERA);
    const sessionB = seedSession(db, "t10-interleave-b", ERA + 1_000);
    const segment = createSegment(db, { title: "interleave segment", nowEpoch: ERA });
    // Chronological member order: A1, A2, B1, B2, A3 — recentMemberCount
    // covers ALL 5, so OLD is structurally empty and every row (including
    // the A2->B1 and B2->A3 switches) renders through ONE
    // `renderSegmentMilestoneCardLines` call (the OLD/RECENT seam itself is
    // a SEPARATE render call per side, joined only as strings afterward —
    // see `buildSplitSegmentMilestoneCard` — so it cannot exercise this
    // function's own within-one-call revisit handling; the interleave has to
    // live entirely inside one side to test it). Two switches (A->B, B->A),
    // so three markers — switch count (2) + 1. The mutation this fixture is
    // built to catch: tracking a `seenSessionIds` SET instead of only the
    // immediately preceding row's session would suppress the third marker
    // (session A "already seen").
    const a1 = makeTurn(db, sessionA, 1, ERA + 1, "A1");
    const a2 = makeTurn(db, sessionA, 2, ERA + 2, "A2");
    const b1 = makeTurn(db, sessionB, 1, ERA + 1_000 + 1, "B1");
    const b2 = makeTurn(db, sessionB, 2, ERA + 1_000 + 2, "B2");
    const a3 = makeTurn(db, sessionA, 3, ERA + 1_000 + 3, "A3");
    addSegmentMembers(db, segment.id, [a1, a2, b1, b2, a3], ERA);

    const card = buildSplitSegmentMilestoneCard(db, segment.id, null, 2000, 5);
    // All five rows seat (trivially cheap, 2000-token budget) — the
    // discriminator this fixture needs.
    expect(countMilestoneRows(card)).toBe(5);
    const markers = card.match(/^ {4}\[S\d+\]$/gm) ?? [];
    expect(markers.length).toBe(3);
    expect(markers).toEqual([`    [S${sessionA}]`, `    [S${sessionB}]`, `    [S${sessionA}]`]);

    // Single-session segment: exactly one marker, at the top.
    const soloSessionId = seedSession(db, "t10-solo-session", ERA + 2_000_000);
    const soloSegment = createSegment(db, { title: "solo segment", nowEpoch: ERA });
    const s1 = makeTurn(db, soloSessionId, 1, ERA + 2_000_001, "solo 1");
    const s2 = makeTurn(db, soloSessionId, 2, ERA + 2_000_002, "solo 2");
    addSegmentMembers(db, soloSegment.id, [s1, s2], ERA);
    const soloCard = buildSplitSegmentMilestoneCard(db, soloSegment.id, null, 2000, MILESTONE_INJECTION_RECENT_TURNS);
    const soloMarkers = soloCard.match(/^ {4}\[S\d+\]$/gm) ?? [];
    expect(soloMarkers.length).toBe(1);
    expect(soloCard.startsWith(`    [S${soloSessionId}]\n`)).toBe(true);
    db.close();
  });

  test("the two sides concatenate with no separator and no boundary marker: the OLD half's last line is immediately followed by the RECENT half's first line, no blank line between", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const oldSessionId = seedSession(db, "t10-noseparator-old-session", ERA);
    const recentSessionId = seedSession(db, "t10-noseparator-recent-session", ERA + 1_000_000);
    const segment = createSegment(db, { title: "no-separator segment", nowEpoch: ERA });
    const oldId = makeTurn(db, oldSessionId, 1, ERA + 1, "old only member");
    const recentId = makeTurn(db, recentSessionId, 1, ERA + 1_000_000, "recent only member");
    addSegmentMembers(db, segment.id, [oldId, recentId], ERA);

    const card = buildSplitSegmentMilestoneCard(db, segment.id, null, 2000, 1);
    // No blank line anywhere in the card — a blank line is what a "\n\n"
    // join (or any explicit boundary marker) would introduce at the seam.
    expect(card).not.toContain("\n\n");
    const lines = card.split("\n");
    const recentMarkerIndex = lines.indexOf(`    [S${recentSessionId}]`);
    // The RECENT marker sits directly under the OLD row above it, not after
    // a gap.
    expect(lines[recentMarkerIndex - 1]).toContain("old only member");
    db.close();
  });

  test("the `… +N more` overflow pointer still renders on the card when a side demotes rows", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const oldSessionId = seedSession(db, "t10-pointer-old-session", ERA);
    const recentSessionId = seedSession(db, "t10-pointer-recent-session", ERA + 1_000_000);
    const segment = createSegment(db, { title: "pointer segment", nowEpoch: ERA });
    // 150 OLD members chained tier ②/③ (same construction the "hungry side
    // never yields" fixture above uses) — expensive enough that even a half
    // budget cannot seat all 150, so OLD demotes some and its own pointer
    // fires. 200 RECENT fillers likewise demote some at a half budget.
    const oldIds: number[] = [];
    for (let i = 0; i < 150; i += 1) {
      oldIds.push(makeTurn(db, oldSessionId, i + 1, ERA + i, `pointer old anchor ${i}`));
    }
    for (let i = 1; i < oldIds.length; i += 1) {
      indexEdge(db, oldIds[i]!, oldIds[i - 1]!);
    }
    const recentIds: number[] = [];
    for (let i = 0; i < MILESTONE_INJECTION_RECENT_TURNS; i += 1) {
      recentIds.push(makeTurn(db, recentSessionId, i + 1, ERA + 1_000_000 + i, `pointer recent filler ${i}`));
    }
    addSegmentMembers(db, segment.id, [...oldIds, ...recentIds], ERA);

    const card = buildSplitSegmentMilestoneCard(db, segment.id, null, 2000, MILESTONE_INJECTION_RECENT_TURNS);
    const pointerLines = card.match(/^ {8}… \+\d+ more$/gm) ?? [];
    // Both sides demote here (each has far more candidates than a half
    // budget seats), so the pointer fires TWICE — once per side.
    expect(pointerLines.length).toBe(2);
    db.close();
  });

  test("`↳` sub-rows resolve on the card: bare `T<m>` for a same-session antecedent, `S<n>/T<m>` for a cross-session one — both admitted in the same side's election", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const sessionOne = seedSession(db, "t10-antecedent-session-one", ERA);
    const sessionTwo = seedSession(db, "t10-antecedent-session-two", ERA + 10);
    const segment = createSegment(db, { title: "antecedent segment", nowEpoch: ERA });
    const t1 = makeTurn(db, sessionOne, 1, ERA + 1, "root");
    const t2 = makeTurn(db, sessionOne, 2, ERA + 2, "cites root, same session");
    const t3 = makeTurn(db, sessionTwo, 1, ERA + 11, "cites t2, cross session");
    addSegmentMembers(db, segment.id, [t1, t2, t3], ERA);
    // Everything on the RECENT side (recentMemberCount covers all 3), one
    // election, so both citations admit together.
    indexEdge(db, t2, t1);
    indexEdge(db, t3, t2);

    const card = buildSplitSegmentMilestoneCard(db, segment.id, null, 2000, 3);
    expect(card).toContain(`↳ T1`); // t2's antecedent: same session as t2 -> bare.
    expect(card).toContain(`↳ S${sessionOne}/T2`); // t3's antecedent: cross-session -> qualified.
    db.close();
  });
});
