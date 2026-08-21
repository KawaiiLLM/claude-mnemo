import { describe, expect, test } from "bun:test";

import { createDatabase } from "../../src/db/database";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurn } from "../../src/db/turns";
import { estimateDiaryTokens } from "../../src/diary/domain";
import {
  MILESTONE_INJECTION_TOKEN_BUDGET,
  renderSessionMilestoneInjection,
} from "../../src/hooks/milestone-injection";
import {
  buildTimelineView,
  compareMilestoneRank,
  renderTimeline,
  DEFAULT_TITLE_CAP,
  MILESTONE_OVER_BUDGET_NOTE,
  type KeptMilestone,
  type TimelineView,
} from "../../src/mcp/timeline";

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
      relation: "verifies" as const,
      provenance: "judged" as const,
    })),
    ERA_BASE,
  );
}

// A spine row is `        <marker?>[T<n>] <date> <time> <emoji> <title>` (spec
// 金样例); the `↳` address line, desc lines and the `… +N more` hint all sit
// further in and never match.
const SPINE_ROW_RE = /^ {8}(?:.{1,2} )?\[T\d+\] /u;

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

function anchors(view: TimelineView): KeptMilestone[] {
  return view.pagedMilestones.filter((milestone) => milestone.alwaysKeep);
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

    // Spec 金样例 baseline `[T821] 08-17 18:19 ⚖️ title`, plus the
    // budget-permitting enrichments (the user's own words, the ✏️ tail).
    expect(injected).toContain(
      '[T1] 07-25 17:21 ⚖️ Framed the slicing problem · "卷号锚定要解决什么"',
    );
    // `↳` is an ADDRESS index; no grade, no title, no `前件` count.
    expect(injected).toContain("↳ T2");
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
    const sessionId = seedLongArc(db, {
      mainRows: 300,
      anchorEvery: 0,
      contentSessionId: "long-sparse-arc",
    });

    const injected = renderSessionMilestoneInjection(db, sessionId);

    expect(estimateDiaryTokens(injected)).toBeLessThanOrEqual(
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
    // Turns the budget could not fit are conserved into the day hints, not lost.
    expect(injected).toMatch(/… \+\d+ more @ within T\d+\.\.T\d+/u);
    db.close();
  });

  test("removes the lowest-ranked unit first, never an anchor", () => {
    const db = createDatabase(":memory:");
    const sessionId = seedLongArc(db, {
      mainRows: 12,
      anchorEvery: 2,
      contentSessionId: "anchor-heavy-arc",
    });
    const view = milestoneView(db, sessionId);
    const removable = [...view.pagedMilestones]
      .filter((milestone) => !milestone.alwaysKeep)
      .sort(compareMilestoneRank);
    expect(removable.length).toBeGreaterThan(1);
    const lowest = removable.at(-1)!;

    const full = renderSessionMilestoneInjection(db, sessionId, {
      tokenBudget: 100_000,
    });
    const allRows = spinePromptNumbers(full);
    let firstDrop: number[] | null = null;
    for (let budget = estimateDiaryTokens(full); budget >= 1; budget -= 1) {
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

  test("keeps every anchor in full under an impossible budget, with one note", () => {
    const db = createDatabase(":memory:");
    const sessionId = seedLongArc(db, {
      mainRows: 12,
      anchorEvery: 2,
      contentSessionId: "anchor-heavy-arc",
    });
    const view = milestoneView(db, sessionId);
    const anchorPrompts = anchors(view).map(
      (milestone) => milestone.turn.promptNumber,
    );
    expect(anchorPrompts.length).toBeGreaterThan(1);

    const starved = renderSessionMilestoneInjection(db, sessionId, {
      tokenBudget: 1,
    });

    expect(spinePromptNumbers(starved)).toEqual(anchorPrompts);
    expect(starved).toContain(MILESTONE_OVER_BUDGET_NOTE);
    // Anchors lose their desc, never their title.
    for (const promptNumber of anchorPrompts) {
      expect(starved).toContain(arcTitle(promptNumber));
    }
    db.close();
  });

  test("renders a 900-row session in well under a second", () => {
    const db = createDatabase(":memory:");
    const sessionId = seedLongArc(db, {
      mainRows: 900,
      anchorEvery: 6,
      contentSessionId: "long-dense-arc",
    });
    const view = milestoneView(db, sessionId);
    expect(view.pagedMilestones.length).toBe(900);
    const anchorPrompts = anchors(view).map(
      (milestone) => milestone.turn.promptNumber,
    );
    expect(anchorPrompts.length).toBeGreaterThan(140);

    const started = Bun.nanoseconds();
    const injected = renderSessionMilestoneInjection(db, sessionId);
    const elapsedMs = (Bun.nanoseconds() - started) / 1_000_000;

    // The deleted four-stage ladder re-rendered the whole view once per
    // candidate count: ~57s on this fixture. The bound is deliberately generous
    // — it exists to fail loudly if anything quadratic comes back.
    expect(elapsedMs).toBeLessThan(1_500);
    // 150 anchors cannot fit 2500 tokens, so this walks the ENTIRE ladder and
    // still ends over budget — and the anchors survive it.
    expect(injected).toContain(MILESTONE_OVER_BUDGET_NOTE);
    expect(spinePromptNumbers(injected)).toEqual(anchorPrompts);
    db.close();
  });
});
