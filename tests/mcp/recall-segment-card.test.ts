import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { insertLane } from "../../src/db/lanes";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import { reindexTurnFromDb } from "../../src/db/search";
import {
  addSegmentMembers,
  appendSegmentWorkingStateRows,
  attachSegmentToSession,
  createSegment,
  getSegment,
  setSegmentTag,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { getTurn } from "../../src/db/turns";
import { capRenderToTokenBudget, DEFAULT_TURN_TOKEN_BUDGET, NAVIGATION_LEGEND } from "../../src/mcp/format";
import { recallMemory } from "../../src/mcp/recall";
import {
  buildSegmentLaneCardRow,
  elideSegmentCardFields,
  MAX_ATTACHED_SESSION_ROWS,
  renderSegmentLaneCardEntry,
  type SegmentCardFieldRows,
  type SegmentLaneCardAddress,
} from "../../src/mcp/segment-card";
import { estimateTokens } from "../../src/utils/token-estimate";

/**
 * Ticket 03 — the segment card, the turn field-set switch, `E<n>/T<m>`
 * ordinal addressing, per-turn/page token budgets, bare `recall()` leading
 * with segments, and the absence of election/tier data anywhere in a recall
 * render.
 */

// ---------------------------------------------------------------------------
// Field elision — the pure mechanism, tested directly (mutation target 1/3).
// ---------------------------------------------------------------------------

describe("elideSegmentCardFields", () => {
  test("drops the LARGEST field's rows before a smaller field's, even when the smaller field alone would need trimming", () => {
    // constraints: 4 rows x 1 token each = 4 tokens (the larger field).
    // goal: 1 row x 1 token = 1 token (the smaller field).
    const fields: SegmentCardFieldRows[] = [
      { field: "goal", rows: ["EEEE"] },
      { field: "constraints", rows: ["AAAA", "BBBB", "CCCC", "DDDD"] },
    ];

    const result = elideSegmentCardFields(fields, 3);
    const goal = result.find((entry) => entry.field === "goal")!;
    const constraints = result.find((entry) => entry.field === "constraints")!;

    // The smaller field is never touched while a larger one still has rows.
    expect(goal.droppedCount).toBe(0);
    expect(goal.keptRows).toEqual(["EEEE"]);
    // The larger field sheds rows OLDEST first (array order = storage order).
    expect(constraints.droppedCount).toBe(2);
    expect(constraints.keptRows).toEqual(["CCCC", "DDDD"]);
  });

  test("ties on size break by the fields' own declared order — the first-listed field trims first", () => {
    const fields: SegmentCardFieldRows[] = [
      { field: "goal", rows: ["AAAA"] },
      { field: "constraints", rows: ["BBBB"] },
    ];

    // Budget 1: exactly one row's worth of the total 2 tokens must go — the
    // tie is broken, not the whole set drained to zero.
    const result = elideSegmentCardFields(fields, 1);
    expect(result.find((entry) => entry.field === "goal")!.droppedCount).toBe(1);
    expect(result.find((entry) => entry.field === "constraints")!.droppedCount).toBe(0);
  });

  test("never drops below the budget once every field is exhausted, and never loops forever on a zero budget", () => {
    const fields: SegmentCardFieldRows[] = [{ field: "done", rows: ["one row"] }];
    const result = elideSegmentCardFields(fields, 0);
    expect(result[0]!.droppedCount).toBe(1);
    expect(result[0]!.keptRows).toEqual([]);
  });

  test("under budget, nothing is dropped at all", () => {
    const fields: SegmentCardFieldRows[] = [
      { field: "goal", rows: ["a", "b"] },
      { field: "decisions", rows: ["c"] },
    ];
    const result = elideSegmentCardFields(fields, 1000);
    expect(result.every((entry) => entry.droppedCount === 0)).toBe(true);
  });

  // ---- ticket 08: the summary layer (title/content/insight) now competes
  // in the SAME ladder as Working State, not a privileged, never-elided
  // layer rendered ahead of it. ----
  test("a summary-layer field (e.g. content) is evicted before a smaller Working State field, purely on size", () => {
    const fields: SegmentCardFieldRows[] = [
      { field: "content", rows: ["x".repeat(400)] }, // ~100 tokens, one row
      { field: "goal", rows: ["small goal row"] }, // a handful of tokens
    ];

    const result = elideSegmentCardFields(fields, 10);
    const content = result.find((entry) => entry.field === "content")!;
    const goal = result.find((entry) => entry.field === "goal")!;

    expect(content.droppedCount).toBe(1);
    expect(content.keptRows).toEqual([]);
    expect(goal.droppedCount).toBe(0);
    expect(goal.keptRows).toEqual(["small goal row"]);
  });

  test("the reverse also holds: a Working State field larger than a summary-layer field is the one that gives way", () => {
    const fields: SegmentCardFieldRows[] = [
      { field: "content", rows: ["short desc"] },
      {
        field: "decisions",
        rows: Array.from({ length: 20 }, (_, i) => `decision row ${i} ${"y".repeat(40)}`),
      },
    ];

    const result = elideSegmentCardFields(fields, 15);
    const content = result.find((entry) => entry.field === "content")!;
    const decisions = result.find((entry) => entry.field === "decisions")!;

    expect(content.droppedCount).toBe(0);
    expect(content.keptRows).toEqual(["short desc"]);
    expect(decisions.droppedCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Per-turn token budget cap — the pure mechanism (mutation target: the
// "keep the label, trim the tail" direction).
// ---------------------------------------------------------------------------

describe("capRenderToTokenBudget", () => {
  test("keeps the label line even when the budget is too small for anything else", () => {
    const rendered = ["  - [S1][T1] a title", "    - desc: filler text here"].join("\n");
    const capped = capRenderToTokenBudget(rendered, 1);
    expect(capped.split("\n")[0]).toBe("  - [S1][T1] a title");
    expect(capped.split("\n").some((line) => line.trim() === "…")).toBe(true);
  });

  test("leaves a render under budget untouched", () => {
    const rendered = "  - [S1][T1] short";
    expect(capRenderToTokenBudget(rendered, 1000)).toBe(rendered);
  });

  test("undefined budget means uncapped", () => {
    const rendered = "x".repeat(5000);
    expect(capRenderToTokenBudget(rendered, undefined)).toBe(rendered);
  });

  // Ticket 01 (render-boilerplate-trim spec, item 1): the ONE corner the
  // marker still earns its keep on. Budget = label (1 token) + the second
  // line WHOLE (2 tokens) + the marker itself (1 token) exactly — the loop
  // then hits a THIRD line with zero tokens left, drops it whole, and never
  // touches the second line's own text (no inline cut, no "…" glued onto
  // it). Without the marker line, the second line surviving whole while the
  // third vanishes would leave nothing in the kept text to show a cut
  // happened at all.
  //
  // RED-GREEN: this fails if the `remaining <= 0` branch's
  // `kept.push(TURN_BUDGET_TRUNCATION_MARKER)` is deleted — the result would
  // then be `"H\n22222222"`, with no line satisfying `line.trim() === "…"`.
  test("the dropped-whole-lines corner: a fully-kept last line still gets the bare marker line", () => {
    const rendered = ["H", "22222222", "99999999"].join("\n");
    const capped = capRenderToTokenBudget(rendered, 4);
    const lines = capped.split("\n");

    expect(lines).toEqual(["H", "22222222", "  …"]);
    // The kept content line is whole — no ellipsis glued onto it by a
    // word-boundary cut. Only the marker's OWN line carries "…".
    expect(lines[1]).toBe("22222222");
    expect(lines[1]).not.toContain("…");
    // The dropped line leaves no trace at all — not even a partial digit.
    expect(capped).not.toContain("9");
  });
});

// ---------------------------------------------------------------------------
// The lane row's own rendering + truncation — the pure mechanisms (ticket
// 06, spec D7). Mutation targets: the three row shapes, and "truncate
// against the budget" dropping whole entries, never mid-entry.
// ---------------------------------------------------------------------------

describe("renderSegmentLaneCardEntry", () => {
  // Ticket 10 (one-address-grammar spec): addresses are `S<session>/T<prompt>`
  // now, never `E<segment>/T<globalTurnId>`.
  const addr = (turnId: number, sessionId: number, promptNumber: number): SegmentLaneCardAddress => ({
    turnId,
    sessionId,
    promptNumber,
  });

  test("declared terminus that IS the lane's newest node: bare ◎, no → clause", () => {
    const line = renderSegmentLaneCardEntry({
      tag: "write-gate",
      terminusAddress: addr(100, 60, 5),
      newestAddress: addr(100, 60, 5),
    });
    expect(line).toBe("write-gate ◎S60/T5");
  });

  test("declared terminus that is NOT the newest node, same session: → appended BARE (leading-prefix rule, no session change)", () => {
    const line = renderSegmentLaneCardEntry({
      tag: "write-gate",
      terminusAddress: addr(100, 60, 5),
      newestAddress: addr(290, 60, 12),
    });
    expect(line).toBe("write-gate ◎S60/T5 →T12");
  });

  // The leading-prefix rule's session-switch half: a two-node row that
  // crosses a session boundary prints the FULL address again for the
  // second node, never the bare `T<prompt>` form.
  test("declared terminus that is NOT the newest node, DIFFERENT session: → appended FULL (leading-prefix rule, session changed)", () => {
    const line = renderSegmentLaneCardEntry({
      tag: "write-gate",
      terminusAddress: addr(100, 60, 5),
      newestAddress: addr(290, 61, 3),
    });
    expect(line).toBe("write-gate ◎S60/T5 →S61/T3");
  });

  test("undeclared/reopened: bare tag + newest-node address, no ◎, no →", () => {
    const line = renderSegmentLaneCardEntry({
      tag: "codex-workflow",
      terminusAddress: null,
      newestAddress: addr(250, 60, 9),
    });
    expect(line).toBe("codex-workflow S60/T9");
    expect(line).not.toContain("◎");
    expect(line).not.toContain("→");
  });

  // Not one of D7's three named shapes, but reachable (a lane declared ahead
  // of any use, D2): no address at all rather than inventing a fourth marker.
  test("a registered lane with no live tagged edge yet: bare tag, no address", () => {
    const line = renderSegmentLaneCardEntry({ tag: "brand-new", terminusAddress: null, newestAddress: null });
    expect(line).toBe("brand-new");
  });
});

describe("buildSegmentLaneCardRow", () => {
  test("under budget: every entry kept, no tail", () => {
    const result = buildSegmentLaneCardRow(["a E1/T1", "b E1/T2", "c E1/T3"], 1000);
    expect(result).toEqual({ line: "a E1/T1 · b E1/T2 · c E1/T3", droppedCount: 0 });
  });

  test("over budget: kept entries are a PREFIX of the caller's own order (never a later one instead of an earlier one), overflow folds into a +N 条 tail", () => {
    const entries = Array.from({ length: 10 }, (_, i) => `tag${i} E1/T${100 + i}`);
    const budget = estimateTokens(entries.slice(0, 4).join(" · ")); // room for a handful, not all 10
    const result = buildSegmentLaneCardRow(entries, budget);

    expect(result.droppedCount).toBeGreaterThan(0);
    expect(result.droppedCount).toBeLessThan(entries.length);
    const keptCount = entries.length - result.droppedCount;
    expect(result.line.startsWith(entries.slice(0, keptCount).join(" · "))).toBe(true);
    expect(result.line).not.toContain(`tag${entries.length - 1}`); // the very last entry never survives here
    expect(result.line).toMatch(new RegExp(`\\+${result.droppedCount} 条$`));
  });

  // The acceptance criterion itself: "a test pins that the row respects the
  // budget" — not merely that the tail string appears.
  test("the whole line (kept entries + tail) never exceeds the budget, at E60's own measured scale", () => {
    const entries = Array.from({ length: 63 }, (_, i) => `lane-tag-${i} E60/T${8000 + i}`);
    const budget = DEFAULT_TURN_TOKEN_BUDGET; // the same item-knife budget the tags/type facet lines take
    const result = buildSegmentLaneCardRow(entries, budget);

    expect(result.droppedCount).toBeGreaterThan(0);
    expect(estimateTokens(result.line)).toBeLessThanOrEqual(budget);
    expect(result.line).toMatch(/\+\d+ 条$/);
  });

  test("a budget too small even for one entry plus its own tail folds everything into the bare count", () => {
    const result = buildSegmentLaneCardRow(["a-long-lane-tag E1/T1", "another-tag E1/T2"], 1);
    expect(result).toEqual({ line: "+2 条", droppedCount: 2 });
  });

  test("zero entries: empty line, nothing dropped", () => {
    expect(buildSegmentLaneCardRow([], 1000)).toEqual({ line: "", droppedCount: 0 });
  });
});

// ---------------------------------------------------------------------------
// The card at the MCP seam.
// ---------------------------------------------------------------------------

describe("recall(id=\"E<n>\") segment card", () => {
  let db: Database;
  let sessionId: number;
  let segmentId: number;
  const CUTOFF = 1_950_000_000;

  function makeTurn(
    promptNumber: number,
    options: { type?: string; title?: string; tags?: string[]; epoch?: number } = {},
  ): number {
    const id = db
      .query<{ id: number }, [number, number, string, string, string, number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, type, title, tags, created_at_epoch,
           user_prompt, assistant_response, content, files_read, files_modified
         ) VALUES (?, ?, 'extracted', ?, ?, ?, ?, 'user prompt text',
                   'assistant response text', 'turn body', '[]', '[]')
         RETURNING id`,
      )
      .get(
        sessionId,
        promptNumber,
        options.type ? JSON.stringify([options.type]) : "[]",
        options.title ?? `title ${promptNumber}`,
        JSON.stringify(options.tags ?? []),
        options.epoch ?? CUTOFF + promptNumber,
      )!.id;
    reindexTurnFromDb(db, id);
    return id;
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "session-card",
      project: "/tmp/project",
      title: "Card session",
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: CUTOFF,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;

    const segment = createSegment(db, {
      title: "the segment card ships",
      type: ["implement"],
      tags: ["card"],
      nowEpoch: CUTOFF,
    });
    segmentId = segment.id;

    const t1 = makeTurn(1, { type: "research", title: "research the card", tags: ["card"] });
    const t2 = makeTurn(2, { type: "implement", title: "implement the card", tags: ["card"] });
    addSegmentMembers(db, segmentId, [t1, t2], CUTOFF);
    attachSegmentToSession(db, sessionId, segmentId, CUTOFF);
  });

  // [S15069/T1022] — the E60 regression: a whole-project segment folds
  // hundreds of tags into one facet line that, unbudgeted, ate the entire
  // page and starved the field ladder to zero visible rows. The facet line
  // takes the same item knife as every other rendered unit; counts sort
  // descending, so the cut keeps the high-signal words. Page 2 stays whole.
  // Ticket 14 (lane-model-v12 spec D3f): the tag/type HISTOGRAM rows are gone
  // — they rendered the members' historical distribution, which under this
  // model reads as a vocabulary and is not one. The flood they were knifed for
  // therefore cannot reach the card at all: no amount of member tags produces
  // a header row now, and the freed budget goes to `- lanes:`.
  test("no member-tag flood can reach the card any more — the histogram rows are gone", () => {
    const turnIds: number[] = [];
    for (let promptNumber = 3; promptNumber < 120; promptNumber += 1) {
      turnIds.push(
        makeTurn(promptNumber, {
          tags: [`flood-${promptNumber}-${"x".repeat(12)}`, `also-${promptNumber}`],
        }),
      );
    }
    addSegmentMembers(db, segmentId, turnIds, CUTOFF);
    appendSegmentWorkingStateRows(db, segmentId, "goal", ["the goal survives the flood"], CUTOFF);

    const pageOne = recallMemory(db, { id: `E${segmentId}` });
    expect(pageOne).not.toContain("- tags:");
    expect(pageOne).not.toContain("- type:");
    expect(pageOne).not.toContain("flood-3-");
    expect(pageOne).toContain("the goal survives the flood");

    // Page 2 renders every row whole and still has no histogram to render.
    const pageTwo = recallMemory(db, { id: `E${segmentId}`, page: 2 });
    expect(pageTwo).not.toContain("- tags:");
    expect(pageTwo).not.toContain("- type:");
  });

  afterEach(() => {
    db.close();
  });

  test("collapsed header carries topic-free label, status, member count, created/last-edit/maintenance", () => {
    const output = recallMemory(db, { id: `E${segmentId}` });

    expect(output).toContain(`[E${segmentId}]`);
    expect(output).toContain("[open]");
    expect(output).toContain("2 turns");
    expect(output).toContain("created ");
    expect(output).toContain("last edit ");
    expect(output).toMatch(/maintenance \d+ turns? ago/);
  });

  // Ticket 14 (spec D3f): the segment's OWN tag moves into the card header —
  // it is one of the two legal sources a `tags` write may draw from, and the
  // one that decides membership, yet it appeared nowhere on the card before.
  test("the header carries the segment's own tag, and no histogram row survives", () => {
    setSegmentTag(db, segmentId, "card-container", CUTOFF);
    const output = recallMemory(db, { id: `E${segmentId}` });
    const header = output.split("\n")[0]!;
    expect(header).toContain(`[E${segmentId}]`);
    expect(header).toContain("#card-container");
    expect(output).not.toContain("- tags:");
    expect(output).not.toContain("- type:");
  });

  test("an unnamed segment says so in the header rather than saying nothing", () => {
    const unnamed = createSegment(db, { title: "no name yet", nowEpoch: CUTOFF });
    const output = recallMemory(db, { id: `E${unnamed.id}` });
    expect(output.split("\n")[0]!).toContain("#(unnamed)");
  });

  test("sessions section shows one line per attached session — member count and last-active, consulted-only marked", () => {
    const other = upsertSession(db, {
      contentSessionId: "session-consult-only",
      project: "/tmp/project",
      title: "Just consulting",
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: CUTOFF,
      updatedAtEpoch: CUTOFF + 5,
      completedAtEpoch: null,
    }).id;
    attachSegmentToSession(db, other, segmentId, CUTOFF);

    // Spec 金样例: the card's `- sessions:` row is a BARE id list — the
    // per-session turn count / last-active / consulted-only annotations were
    // the card's second rendering of facts each session states for itself.
    const output = recallMemory(db, { id: `E${segmentId}` });
    const sessionsLine = output
      .split("\n")
      .find((line) => line.trimStart().startsWith("- sessions:"))!;
    expect(sessionsLine).toContain(`S${sessionId}`);
    expect(sessionsLine).toContain(`S${other}`);
    expect(output).not.toContain("consulted only");
    expect(output).not.toContain("last active");
  });

  test("collapsed shows per-field row counts and elides an over-budget field with the ellipsis at the top, newest rows kept", () => {
    // Grow `decisions` well past a tiny page budget: five distinct rows.
    for (let index = 0; index < 5; index += 1) {
      appendSegmentWorkingStateRows(
        db,
        segmentId,
        "decisions",
        [`decision number ${index} with enough padding to cost real tokens ${"x".repeat(20)}`],
        CUTOFF + index,
      );
    }

    // Measure the card's own natural (unelided) size, then halve the budget —
    // robust to exactly how many tokens the header/labels cost (which this
    // test does not otherwise pin): the five ~20-token decision rows
    // dominate that size, so a halved budget reliably forces several of
    // them out while the much smaller header/label overhead survives whole.
    const fullOutput = recallMemory(db, { id: `E${segmentId}`, pageBudget: 100_000 });
    const pageBudget = Math.floor(estimateTokens(fullOutput) / 2);
    const output = recallMemory(db, { id: `E${segmentId}`, pageBudget });
    const decisionsBlock = output.split("- decisions:")[1]?.split(/- (goal|constraints|done|next_steps|reference):/)[0] ?? "";

    // Spec 金样例: a field that HOLDS rows names itself and lets the rows
    // speak; only a 0-row field states a count.
    expect(decisionsBlock).not.toContain("5 rows");
    // Ellipsis sits at the TOP of the field.
    const ellipsisIndex = decisionsBlock.indexOf("… +");
    const newestRowIndex = decisionsBlock.indexOf("decision number 4");
    expect(ellipsisIndex).toBeGreaterThan(-1);
    expect(newestRowIndex).toBeGreaterThan(-1);
    expect(ellipsisIndex).toBeLessThan(newestRowIndex);
    // The newest row survives; an old one does not.
    expect(decisionsBlock).not.toContain("decision number 0");
  });

  // ---- ticket 08: no character-level truncate, summary layer joins the
  // elision ladder, attached-session rows are capped ----

  test("no character-level truncation: a long title survives whole under an ample budget (spec: the `truncate` knob retires)", () => {
    const longTitle = Array.from({ length: 60 }, (_, index) => `word${index}`).join(" ");
    expect(longTitle.length).toBeGreaterThan(200); // would have hit the old 200-char DEFAULT_TRUNCATE
    const longSegment = createSegment(db, { title: longTitle, nowEpoch: CUTOFF });

    const output = recallMemory(db, { id: `E${longSegment.id}` });
    expect(output).toContain(longTitle);
    expect(output).not.toContain("…");
  });

  test("the summary layer competes on SIZE, not privilege — a big `content` yields to a small Working State row under tight budget", () => {
    const segment = createSegment(db, {
      title: "budget priority segment",
      content: "z".repeat(4000), // ~1000 tokens, dwarfs everything else on the card
      nowEpoch: CUTOFF,
    });
    appendSegmentWorkingStateRows(db, segment.id, "goal", ["ship the priority fix"], CUTOFF);

    // Big enough for the header + the tiny goal row, nowhere near big enough
    // to also carry the content blob.
    const output = recallMemory(db, { id: `E${segment.id}`, pageBudget: 100 });
    expect(output).toContain("ship the priority fix");
    expect(output).not.toContain("desc:");
    // Pre-ticket-08 behaviour: content rendered unconditionally, unelided,
    // ahead of Working State — this proves the reversal, not just that
    // *something* got cut.
  });

  test("attached-session rows are capped with overflow folded into a count — the header no longer grows unbounded with attachment count", () => {
    const extra = MAX_ATTACHED_SESSION_ROWS + 3;
    const overflowIds: number[] = [];
    for (let index = 0; index < extra; index += 1) {
      const other = upsertSession(db, {
        contentSessionId: `session-overflow-${index}`,
        project: "/tmp/project",
        title: `Overflow session ${index}`,
        content: null,
        insight: null,
        nextSteps: null,
        createdAtEpoch: CUTOFF + index,
        updatedAtEpoch: CUTOFF + index,
        completedAtEpoch: null,
      }).id;
      overflowIds.push(other);
      attachSegmentToSession(db, other, segmentId, CUTOFF + index);
    }

    const output = recallMemory(db, { id: `E${segmentId}` });
    const sessionsLine = output
      .split("\n")
      .find((line) => line.trimStart().startsWith("- sessions:"))!;
    const ids = sessionsLine
      .slice(sessionsLine.indexOf(":") + 1)
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.startsWith("S"));
    expect(ids.length).toBe(MAX_ATTACHED_SESSION_ROWS);
    expect(sessionsLine).toMatch(/\+\d+ more/);
    // The cap keeps the FRESHEST ids, not merely five: with 8 overflow
    // sessions at ascending lastActive, the survivors are the top five and
    // the colder tail folds into the count. An implementation that capped in
    // attachment order (or sorted the wrong way) passes the count above and
    // fails here.
    expect(ids).toContain(`S${overflowIds[overflowIds.length - 1]}`);
    expect(ids).not.toContain(`S${overflowIds[0]}`);
    expect(output).not.toContain("Overflow session 2");
  });

  test("ticket 12 nudge half retired (ticket 13): the header states the bare maintenance distance, no suffix, even 20+ turns since the last edit", () => {
    // The fixture already carries 2 member turns after the segment's last
    // edit; 20 more takes the attached session's distance to 22. The card
    // header used to draw a "consider a maintenance pass" suffix here — that
    // function moved to the universal 20-turn `remember` check on the
    // UserPromptSubmit channel (hooks/note-reminder.ts), which reaches every
    // session, not just one with this card already in view.
    for (let prompt = 3; prompt <= 22; prompt += 1) {
      makeTurn(prompt);
    }
    const output = recallMemory(db, { id: `E${segmentId}` });
    expect(output).toContain("maintenance 22 turns ago");
    expect(output).not.toContain("consider a maintenance pass");
  });

  test("maintenance distance is the busiest attached session's distance, not the sum (ticket 14 #10)", () => {
    const other = upsertSession(db, {
      contentSessionId: "maintenance-max-session",
      project: "/tmp/project",
      title: "Second attached session",
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: CUTOFF,
      updatedAtEpoch: CUTOFF,
      completedAtEpoch: null,
    }).id;
    attachSegmentToSession(db, other, segmentId, CUTOFF);
    const main = sessionId;
    sessionId = other;
    for (let prompt = 1; prompt <= 25; prompt += 1) {
      makeTurn(prompt);
    }
    sessionId = main;

    const output = recallMemory(db, { id: `E${segmentId}` });
    // main: 2 turns since the last edit; other: 25. The sum (27) made the
    // figure incomparable to the 10/20 thresholds the receipt counts in
    // single-session units; the max is that same unit.
    expect(output).toMatch(/maintenance 25 turns ago/);
    expect(output).not.toMatch(/maintenance 27 turns/);
  });

  test("mutation demo (ticket 08 checklist item 4): a large attachment count no longer starves the field budget to zero", () => {
    appendSegmentWorkingStateRows(db, segmentId, "goal", ["ship the fix"], CUTOFF);
    // 300 attachments comfortably exceeds the default 1000-token page budget
    // on their own if rendered uncapped (each row costs tens of tokens) —
    // large enough that the pre-fix behavior (one row per attachment, no
    // cap) reliably starves the field ladder to zero, not just "shrinks it".
    for (let index = 0; index < 300; index += 1) {
      const other = upsertSession(db, {
        contentSessionId: `session-mutate-${index}`,
        project: "/tmp/project",
        title: `Session ${index}`,
        content: null,
        insight: null,
        nextSteps: null,
        createdAtEpoch: CUTOFF + index,
        updatedAtEpoch: CUTOFF + index,
        completedAtEpoch: null,
      }).id;
      attachSegmentToSession(db, other, segmentId, CUTOFF + index);
    }

    const output = recallMemory(db, { id: `E${segmentId}` }); // default pageBudget: 1000
    expect(output).toContain("ship the fix");
  });

  test("page 2 never elides — all rows render regardless of the page budget", () => {
    for (let index = 0; index < 5; index += 1) {
      appendSegmentWorkingStateRows(
        db,
        segmentId,
        "decisions",
        [`decision number ${index}`],
        CUTOFF + index,
      );
    }

    const output = recallMemory(db, { id: `E${segmentId}`, page: 2, pageBudget: 5 });
    for (let index = 0; index < 5; index += 1) {
      expect(output).toContain(`decision number ${index}`);
    }
    expect(output).not.toContain("… +");
  });

  test("page 2 carries a member index in event order with each member's S/T home address", () => {
    const output = recallMemory(db, { id: `E${segmentId}`, page: 2 });
    expect(output).toContain("member index");
    expect(output).toContain(`1. S${sessionId}/T1 "research the card"`);
    expect(output).toContain(`2. S${sessionId}/T2 "implement the card"`);
  });

  test("a note-less member's index line is the bare address — its raw prompt never leaks (ticket 03)", () => {
    // The retired fallback (`turn?.title ?? turn?.userPrompt ?? "untitled"`)
    // was a third copy of the label fallback ticket 02 removed from
    // format.ts/recall.ts; this pins the sweep.
    const noteless = db
      .query<{ id: number }, [number, number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, title, tags, created_at_epoch,
           user_prompt, assistant_response, files_read, files_modified
         ) VALUES (?, 3, 'extracted', NULL, '[]', ?,
                   'SECRET-RAW-PROMPT-WORDS', 'a response', '[]', '[]')
         RETURNING id`,
      )
      .get(sessionId, CUTOFF + 3)!.id;
    addSegmentMembers(db, segmentId, [noteless], CUTOFF);

    const output = recallMemory(db, { id: `E${segmentId}`, page: 2 });
    expect(output).toContain(`3. S${sessionId}/T3`);
    expect(output).not.toContain("SECRET-RAW-PROMPT-WORDS");
    expect(output).not.toContain("untitled");
  });

  // ---- pagination stability (mutation target 2/3) ----

  test("page overflow paginates STABLY: page 2 deterministically re-fetches the un-elided card", () => {
    for (let index = 0; index < 5; index += 1) {
      appendSegmentWorkingStateRows(
        db,
        segmentId,
        "decisions",
        [`decision number ${index}`],
        CUTOFF + index,
      );
    }

    const page1First = recallMemory(db, { id: `E${segmentId}`, pageBudget: 20 });
    const page1Second = recallMemory(db, { id: `E${segmentId}`, pageBudget: 20 });
    const page2First = recallMemory(db, { id: `E${segmentId}`, pageBudget: 20, page: 2 });
    const page2Second = recallMemory(db, { id: `E${segmentId}`, pageBudget: 20, page: 2 });

    // Page 1 is stable across repeated calls, and shows the ellipsis.
    expect(page1First).toBe(page1Second);
    expect(page1First).toContain("… +");

    // Page 2 is ALSO stable across repeated calls, and never drops a row —
    // recall is the lossless index.
    expect(page2First).toBe(page2Second);
    expect(page2First).not.toContain("… +");
    for (let index = 0; index < 5; index += 1) {
      expect(page2First).toContain(`decision number ${index}`);
    }
  });

  // ---- S/T address -> event order resolution (mutation target 3/3) ----

  test("E<n>/S<a>/T<b> addresses one segment member by its ordinary S/T address", () => {
    const first = recallMemory(db, { id: `E${segmentId}/S${sessionId}/T1` });
    expect(first).toContain("research the card");

    const second = recallMemory(db, { id: `E${segmentId}/S${sessionId}/T2` });
    expect(second).toContain("implement the card");
  });

  test("an E<n>/S<a>/T<b>..S<c>/T<d> range follows EVENT order (creation time), not DB insertion order or prompt-number order", () => {
    // t3 is created chronologically BEFORE t1/t2 but inserted into the DB
    // (and thus assigned a turn id, and a HIGHER prompt number) after them —
    // event order must follow the timestamp, never the id, insertion
    // sequence, or prompt-number magnitude. Its event-order position is now
    // BEFORE t1/t2 despite T3 > T1/T2 as raw prompt numbers, so a range
    // named "T3..T2" (descending in prompt-number terms) must still resolve
    // to the ordinal-ascending span that covers all three.
    const t3 = makeTurn(3, { title: "earliest by clock, latest by id", epoch: CUTOFF - 500 });
    addSegmentMembers(db, segmentId, [t3], CUTOFF);

    const output = recallMemory(db, {
      id: `E${segmentId}/S${sessionId}/T3..S${sessionId}/T2`,
    });
    expect(output).toContain("earliest by clock, latest by id");
    expect(output).toContain("research the card");
    expect(output).toContain("implement the card");
  });

  test("the retired E<n>/T<m> ordinal form refuses, naming the new grammar — not a silent reinterpretation, not a miss", () => {
    const output = recallMemory(db, { id: `E${segmentId}/T99` });
    expect(output).toContain("retired");
    expect(output).not.toContain("not found");
  });

  test("an E<n>/S<a>/T<b> address naming a turn outside the segment refuses, naming it — not a crash", () => {
    const output = recallMemory(db, { id: `E${segmentId}/S${sessionId}/T99` });
    expect(output).toContain(`S${sessionId}/T99`);
    expect(output).toContain("not a member");
  });

  // ---- election/tier absence ----

  test("election/tier data appears nowhere in the card, at either page", () => {
    const collapsed = recallMemory(db, { id: `E${segmentId}` });
    const expanded = recallMemory(db, { id: `E${segmentId}`, page: 2 });
    for (const output of [collapsed, expanded]) {
      expect(output.toLowerCase()).not.toContain("election");
      expect(output.toLowerCase()).not.toContain("tier");
    }
  });

  // Edge-read-surface spec, ticket 01: the `E<n>/T<m>` member-listing route
  // builds its own `FormattedTurn` (`segment-card.ts`'s
  // `renderSegmentMembersByOrdinal`) rather than going through
  // `recall.ts`'s `buildTurnView` — this pins that it wires `relations` the
  // same way, off by default.
  test("a segment member's relations render only when filter.fields requests them", () => {
    const t3 = makeTurn(3, { title: "third turn" });
    addSegmentMembers(db, segmentId, [t3], CUTOFF);
    const t1Id = getTurn(db, sessionId, 1)!.id;
    const t3Id = getTurn(db, sessionId, 3)!.id;
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: t3Id },
          cited: { kind: "turn", id: t1Id },
          relation: "extends",
          provenance: "asserted",
          tags: ["seg-tag"],
        },
      ],
      CUTOFF,
    );

    const unrequested = recallMemory(db, { id: `E${segmentId}/S${sessionId}/T3` });
    expect(unrequested).not.toContain("→");

    const requested = recallMemory(db, {
      id: `E${segmentId}/S${sessionId}/T3`,
      filter: { fields: ["title", "relations"] },
    });
    expect(requested).toContain("→ extends T1 {seg-tag}");
  });

  // ---- ticket 06 (spec D7): the segment card's lane list ----

  test("no declared lanes: the card carries no `- lanes:` row at all", () => {
    const output = recallMemory(db, { id: `E${segmentId}` });
    expect(output.split("\n").some((line) => line.trimStart().startsWith("- lanes:"))).toBe(false);
  });

  test("the three lane row shapes render together, newest-lane-first", () => {
    // alpha: declared, terminus IS the newest node.
    const a1 = makeTurn(50);
    const a2 = makeTurn(51);
    addSegmentMembers(db, segmentId, [a1, a2], CUTOFF);
    insertLane(db, segmentId, "alpha", CUTOFF);
    writeMemoryEdges(
      db,
      [{ citing: { kind: "turn", id: a2 }, cited: { kind: "turn", id: a1 }, relation: "indexes", provenance: "asserted", tags: ["alpha"] }],
      CUTOFF,
    );

    // beta: declared, but a later narrows moved the newest node past the terminus.
    const b1 = makeTurn(52);
    const b2 = makeTurn(53);
    const b3 = makeTurn(54);
    addSegmentMembers(db, segmentId, [b1, b2, b3], CUTOFF);
    insertLane(db, segmentId, "beta", CUTOFF);
    writeMemoryEdges(
      db,
      [
        { citing: { kind: "turn", id: b2 }, cited: { kind: "turn", id: b1 }, relation: "indexes", provenance: "asserted", tags: ["beta"] },
        { citing: { kind: "turn", id: b3 }, cited: { kind: "turn", id: b2 }, relation: "narrows", provenance: "asserted", tags: ["beta"] },
      ],
      CUTOFF,
    );

    // gamma: undeclared — a narrows edge only, no indexes/override ever.
    const g1 = makeTurn(55);
    const g2 = makeTurn(56);
    addSegmentMembers(db, segmentId, [g1, g2], CUTOFF);
    insertLane(db, segmentId, "gamma", CUTOFF);
    writeMemoryEdges(
      db,
      [{ citing: { kind: "turn", id: g2 }, cited: { kind: "turn", id: g1 }, relation: "narrows", provenance: "asserted", tags: ["gamma"] }],
      CUTOFF,
    );

    const output = recallMemory(db, { id: `E${segmentId}` });
    const laneLine = output.split("\n").find((line) => line.trimStart().startsWith("- lanes:"))!;

    // Ticket 10 (one-address-grammar spec): addresses are `S<session>/T<prompt>`
    // now, never `E<segment>/T<globalTurnId>`. Every member here shares
    // `sessionId`, so the leading-prefix rule prints the FIRST address of
    // each entry whole and any SECOND one (the `→` clause) bare.
    expect(laneLine).toContain(`alpha ◎S${sessionId}/T51`);
    expect(laneLine).not.toContain(`alpha ◎S${sessionId}/T51 →`);
    expect(laneLine).toContain(`beta ◎S${sessionId}/T53 →T54`);
    expect(laneLine).toContain(`gamma S${sessionId}/T56`);
    expect(laneLine).not.toContain(`gamma ◎`);

    // Newest-lane-first (spec D7 / ticket 07's own rule: "the lane's NEWEST
    // node's time"): gamma's newest (T56) > beta's (T54) > alpha's (T51).
    const gammaIndex = laneLine.indexOf("gamma");
    const betaIndex = laneLine.indexOf("beta");
    const alphaIndex = laneLine.indexOf("alpha");
    expect(gammaIndex).toBeGreaterThan(-1);
    expect(gammaIndex).toBeLessThan(betaIndex);
    expect(betaIndex).toBeLessThan(alphaIndex);
  });

  test("lane addresses are S<session>/T<prompt>, resolved from the turn's own identity — never the raw row id or a segment-local ordinal", () => {
    // Chronologically the segment's FIRST member by event order but inserted
    // into the DB after t1/t2 already exist (so its raw row id is not small,
    // and its prompt number 91 is unrelated to either) — pins that the lane
    // row's address tracks the turn's own SESSION/PROMPT identity, not its
    // insertion position in any sense.
    const base = makeTurn(90, { epoch: CUTOFF - 5000 });
    const decl = makeTurn(91, { epoch: CUTOFF - 4999 });
    addSegmentMembers(db, segmentId, [base, decl], CUTOFF);
    insertLane(db, segmentId, "solo", CUTOFF);
    writeMemoryEdges(
      db,
      [{ citing: { kind: "turn", id: decl }, cited: { kind: "turn", id: base }, relation: "indexes", provenance: "asserted", tags: ["solo"] }],
      CUTOFF,
    );

    const output = recallMemory(db, { id: `E${segmentId}` });
    const laneLine = output.split("\n").find((line) => line.trimStart().startsWith("- lanes:"))!;
    expect(laneLine).toContain(`solo ◎S${sessionId}/T91`);
  });

  // The leading-prefix rule's session-switch half, at the integration level
  // (the unit-level pin lives in `renderSegmentLaneCardEntry`'s own describe
  // block above): a lane whose terminus and newest node sit in DIFFERENT
  // sessions prints both addresses whole, never a bare `T<prompt>` for the
  // second.
  test("a lane whose terminus and newest node sit in different sessions prints both addresses whole", () => {
    const otherSessionId = upsertSession(db, {
      contentSessionId: "session-card-other",
      project: "/tmp/project",
      title: "Other session",
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: CUTOFF,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
    const base = makeTurn(59);
    const terminusTurn = makeTurn(60); // declares itself terminus via `indexes` below
    const newestTurn = db
      .query<{ id: number }, [number, number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, title, tags, created_at_epoch,
           user_prompt, assistant_response, content, files_read, files_modified
         ) VALUES (?, 1, 'extracted', 'newest node in another session', '[]', ?,
                   'user prompt text', 'assistant response text', 'turn body', '[]', '[]')
         RETURNING id`,
      )
      .get(otherSessionId, CUTOFF + 1000)!.id; // clearly the newest by wall clock
    reindexTurnFromDb(db, newestTurn);
    addSegmentMembers(db, segmentId, [base, terminusTurn, newestTurn], CUTOFF);
    insertLane(db, segmentId, "cross-session", CUTOFF);
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: terminusTurn },
          cited: { kind: "turn", id: base },
          relation: "indexes",
          provenance: "asserted",
          tags: ["cross-session"],
        },
        // A later narrows, from ANOTHER session, moves the newest node past
        // the terminus without moving the terminus itself — mirrors "beta"
        // above, but the newest node now sits in a different session.
        {
          citing: { kind: "turn", id: newestTurn },
          cited: { kind: "turn", id: terminusTurn },
          relation: "narrows",
          provenance: "asserted",
          tags: ["cross-session"],
        },
      ],
      CUTOFF,
    );

    const output = recallMemory(db, { id: `E${segmentId}` });
    const laneLine = output.split("\n").find((line) => line.trimStart().startsWith("- lanes:"))!;
    expect(laneLine).toContain(`cross-session ◎S${sessionId}/T60 →S${otherSessionId}/T1`);
  });

  test("the budget cap actually bites: many lanes truncate on page 1 with a +N 条 tail, and page 2 shows every lane whole", () => {
    const laneCount = 63; // E60's own measured scale (spec D7: ~1449 tokens at full length)
    const tags: string[] = [];
    let promptNumber = 100;
    for (let index = 0; index < laneCount; index += 1) {
      const tag = `lane-tag-${index.toString().padStart(3, "0")}`;
      tags.push(tag);
      const t1 = makeTurn(promptNumber);
      promptNumber += 1;
      const t2 = makeTurn(promptNumber);
      promptNumber += 1;
      addSegmentMembers(db, segmentId, [t1, t2], CUTOFF);
      insertLane(db, segmentId, tag, CUTOFF);
      writeMemoryEdges(
        db,
        [{ citing: { kind: "turn", id: t2 }, cited: { kind: "turn", id: t1 }, relation: "indexes", provenance: "asserted", tags: [tag] }],
        CUTOFF,
      );
    }

    const page1 = recallMemory(db, { id: `E${segmentId}` });
    const laneLine1 = page1.split("\n").find((line) => line.trimStart().startsWith("- lanes:"))!;
    // Ticket 14 (spec D3f): the row's content budget is the item knife PLUS
    // the 186 tokens the two retired histogram rows used to occupy — the
    // freed budget is owed to THIS row, because it is the vocabulary a writer
    // has to read before choosing a tag. The rendered LINE also carries the
    // `- lanes: ` label, the same small fixed overhead this file's other
    // header-row tests allow for.
    expect(estimateTokens(laneLine1)).toBeLessThanOrEqual(
      DEFAULT_TURN_TOKEN_BUDGET + 186 + 20,
    );
    // It still BITES — the freed budget is a raise, not a removal.
    expect(estimateTokens(laneLine1)).toBeGreaterThan(DEFAULT_TURN_TOKEN_BUDGET);
    expect(laneLine1).toMatch(/\+\d+ 条/);
    const droppedOnPage1 = tags.filter((tag) => !laneLine1.includes(tag)).length;
    expect(droppedOnPage1).toBeGreaterThan(0);
    // The truncation signal actually fires — the reader sees the navigation
    // hint, not just a silently shortened row.
    expect(page1).toContain(NAVIGATION_LEGEND);

    const page2 = recallMemory(db, { id: `E${segmentId}`, page: 2 });
    const laneLine2 = page2.split("\n").find((line) => line.trimStart().startsWith("- lanes:"))!;
    expect(laneLine2).not.toMatch(/\+\d+ 条/);
    for (const tag of tags) {
      expect(laneLine2).toContain(tag);
    }

    // The CALLER's own budget governs this row, not a constant baked into it.
    // Every other assertion here runs at the default, so a version that
    // hardcoded DEFAULT_TURN_TOKEN_BUDGET would satisfy them all — this is the
    // one that tells the two apart.
    const tight = recallMemory(db, { id: `E${segmentId}`, turn: 40 });
    const tightLine = tight.split("\n").find((line) => line.trimStart().startsWith("- lanes:"))!;
    expect(estimateTokens(tightLine)).toBeLessThan(estimateTokens(laneLine1));
    const droppedUnderTightBudget = tags.filter((tag) => !tightLine.includes(tag)).length;
    expect(droppedUnderTightBudget).toBeGreaterThan(droppedOnPage1);
  });
});

// ---------------------------------------------------------------------------
// Turn field-set switch — applies across every recall turn render.
// ---------------------------------------------------------------------------

describe("turn field-set switch (collapsed = prompt/title/content; expanded adds insight/response/observations)", () => {
  let db: Database;
  let sessionId: number;
  const CUTOFF = 1_960_000_000;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "session-fieldset",
      project: "/tmp/project",
      title: "Field-set session",
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: CUTOFF,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;

    db.query<unknown, unknown[]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, title, content, insight, tags,
         created_at_epoch, user_prompt, assistant_response,
         files_read, files_modified
       ) VALUES (?, 1, 'extracted', 'the note title', 'the note content',
                 '- a lesson learned', '[]', ?, 'the raw user prompt',
                 'the raw assistant response', '[]', '[]')`,
    ).run(sessionId, CUTOFF + 1);
  });

  afterEach(() => {
    db.close();
  });

  test("the default field set is exactly title + content — no prompt, no insight, no response", () => {
    // Spec 金样例 补充: "其他字段槽位（默认只有content）". The prompt bullet
    // left the default with the row redesign — the row label already falls
    // back to the prompt when no title exists, so the bullet only ever
    // restated what the reader had.
    const output = recallMemory(db, { id: `S${sessionId}/T1` });
    expect(output).toContain("the note title");
    expect(output).toContain("the note content");
    expect(output).not.toContain("the raw user prompt");
    expect(output).not.toContain("the raw assistant response");
    expect(output).not.toContain("a lesson learned");
  });

  test("filter.fields adds insight and response on top of the default field set", () => {
    const output = recallMemory(db, {
      id: `S${sessionId}/T1`,
      filter: { fields: ["title", "content", "prompt", "response", "insight"] },
    });
    expect(output).toContain("the note title");
    expect(output).toContain("the note content");
    expect(output).toContain("the raw user prompt");
    expect(output).toContain("the raw assistant response");
    expect(output).toContain("a lesson learned");
    // The prompt line appears exactly once, never duplicated between the
    // embedded collapsed block and expanded's own detail block.
    expect(output.split('prompt: "the raw user prompt"').length - 1).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Per-turn budget caps a rendered turn.
// ---------------------------------------------------------------------------

describe("per-turn token budget (`turn` param)", () => {
  let db: Database;
  let sessionId: number;
  const CUTOFF = 1_970_000_000;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "session-turnbudget",
      project: "/tmp/project",
      title: "Turn budget session",
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: CUTOFF,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;

    const longContent = "a very long note body ".repeat(80);
    db.query<unknown, unknown[]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, title, content, tags,
         created_at_epoch, user_prompt, assistant_response,
         files_read, files_modified
       ) VALUES (?, 1, 'extracted', 'long turn', ?, '[]', ?, 'a prompt',
                 'a response', '[]', '[]')`,
    ).run(sessionId, longContent, CUTOFF + 1);
  });

  afterEach(() => {
    db.close();
  });

  test("an explicit `turn` budget caps the rendered turn and says so", () => {
    const uncapped = recallMemory(db, { id: `S${sessionId}/T1` });
    const capped = recallMemory(db, { id: `S${sessionId}/T1`, turn: 5 });

    expect(estimateTokens(uncapped)).toBeGreaterThan(5);
    expect(capped).toContain("long turn"); // the label always survives
    expect(capped.split("\n").some((line) => line.trim() === "…")).toBe(true);
    expect(capped.length).toBeLessThan(uncapped.length);
  });

  test("defaults to a card-scale cap without an explicit `turn` — no char knob left to lift it", () => {
    const output = recallMemory(db, { id: `S${sessionId}/T1` });
    expect(output.split("\n").some((line) => line.trim() === "…")).toBe(true);
    // Measure the capped BLOCK alone — `recallMemory` appends the one
    // response-wide navigation legend on top, which is not part of the
    // per-item budget this test is pinning.
    const withoutLegend = output.replace(`\n\n${NAVIGATION_LEGEND}`, "");
    expect(estimateTokens(withoutLegend)).toBeLessThan(DEFAULT_TURN_TOKEN_BUDGET + 20);
  });

  // Ticket 11: `expanded`'s "default uncapped" retired along with `depth` —
  // there is no more uncapped state (spec: every node kind always has a
  // finite per-item budget). Widening `filter.fields` alone does NOT widen
  // the budget; a caller after more content raises `turn` too.
  test("widening filter.fields alone does not lift the cap — turn must be raised explicitly", () => {
    const widerFields = recallMemory(db, {
      id: `S${sessionId}/T1`,
      filter: { fields: ["title", "content", "prompt", "response", "insight"] },
    });
    const widerFieldsWithoutLegend = widerFields.replace(`\n\n${NAVIGATION_LEGEND}`, "");
    expect(estimateTokens(widerFieldsWithoutLegend)).toBeLessThan(DEFAULT_TURN_TOKEN_BUDGET + 20);

    const longContent = "a very long note body ".repeat(80);
    const raisedBudget = recallMemory(db, {
      id: `S${sessionId}/T1`,
      filter: { fields: ["title", "content", "prompt", "response", "insight"] },
      turn: 2000,
    });
    // Well past DEFAULT_TURN_TOKEN_BUDGET (150) worth of content survives —
    // proof it was the raised `turn` budget, not `filter.fields`, that let
    // it through.
    expect(raisedBudget).toContain(longContent.trim().slice(0, 1000));
    expect(estimateTokens(raisedBudget)).toBeGreaterThan(DEFAULT_TURN_TOKEN_BUDGET * 2);
  });
});

// ---------------------------------------------------------------------------
// Bare recall() leads with segments.
// ---------------------------------------------------------------------------

describe("bare recall() leads with segments", () => {
  let db: Database;
  const CUTOFF = 1_980_000_000;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("a segment appears before any session in the bare listing", () => {
    upsertSession(db, {
      contentSessionId: "session-bare",
      project: "/tmp/project",
      title: "A plain session",
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: CUTOFF,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
    const segment = createSegment(db, {
      title: "the bare-listing segment",
      nowEpoch: CUTOFF,
    });

    const output = recallMemory(db, {});
    const segmentIndex = output.indexOf(`[E${segment.id}]`);
    const sessionIndex = output.indexOf("A plain session");

    expect(segmentIndex).toBeGreaterThan(-1);
    expect(sessionIndex).toBeGreaterThan(-1);
    expect(segmentIndex).toBeLessThan(sessionIndex);
  });

  test("no segments in the database: bare recall() falls back to sessions only, unchanged", () => {
    upsertSession(db, {
      contentSessionId: "session-only",
      project: "/tmp/project",
      title: "Only a session",
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: CUTOFF,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    const output = recallMemory(db, {});
    expect(output).toContain("Only a session");
    expect(output).not.toContain("── segments");
  });
});
