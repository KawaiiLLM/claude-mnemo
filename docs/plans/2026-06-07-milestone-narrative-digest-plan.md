# Milestone Narrative Digest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `timeline()` `view="milestones"` with a ~12–18%-retention, day-grouped, title-only narrative digest (cluster folding + significance + per-day budget + reliable markers), per `docs/plans/2026-06-07-milestone-narrative-digest.md`.

**Architecture:** All changes live in the single existing module `src/mcp/timeline.ts` (the codebase keeps the timeline renderer as one module — do **not** split it). Selection (`selectMilestoneTurns`) is rebuilt bottom-up from four new pure helpers (`milestoneMarker`, `milestoneBaseScore`/significance, `foldMilestoneRuns`, day-budget). Rendering moves off the shared turn-table renderer onto a new day-grouped layout fed by a `MilestoneDayGroup[]` built during pagination in `buildTimelineView`. The existing `isInvalidatedTurn` / `extractReversalFlag` are left untouched (they still drive `turns`/`phases` strike-through).

**Tech Stack:** TypeScript, Bun (`bun test`, `bun run typecheck`, `bun run build`), `bun:sqlite`. Tests in `tests/mcp/timeline.test.ts` using the existing `turn()` / `seedTimelineSession()` helpers.

**Spec decision map:** D1 → Task 2; D2 → Task 3; D3/D4 → Task 4; D5/D6 markers → Task 1; D7 render → Task 6; D8 pagination/day-groups → Task 5; frozen fixture + acceptance → Task 7.

---

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `src/mcp/timeline.ts` | All selection + render logic; new constants, `milestoneMarker`, significance/fold/budget helpers, `selectMilestoneTurns` rewrite, `MilestoneDayGroup` plumbing in `buildTimelineView`, `renderMilestoneDigest` rewrite | 1–6 |
| `tests/mcp/timeline.test.ts` | Unit tests for each helper + integration + frozen-fixture retention guard; migrate the old `selectMilestoneTurns` tests | 1–7 |

No new files. `MILESTONE_TIER2_PER_DAY` and the `KeptMilestone.tier` / `OverflowHint.kind` fields are removed (Task 4 / Task 7).

---

## Task 1: `milestoneMarker` + marker/outcome constants (D5, D6)

**Files:**
- Modify: `src/mcp/timeline.ts` (add near the existing `extractReversalFlag` at `src/mcp/timeline.ts:454`; add constants near `src/mcp/timeline.ts:63`)
- Test: `tests/mcp/timeline.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/mcp/timeline.test.ts`. First add `milestoneMarker` to the existing import from `../../src/mcp/timeline` (the import block at `tests/mcp/timeline.test.ts:9`).

```ts
describe("milestoneMarker", () => {
  it("returns invalidated for undone or interrupted turns (precedence over all)", () => {
    expect(milestoneMarker(turn({ status: "undone", wasRolledBack: true }))).toBe("invalidated");
    expect(milestoneMarker(turn({ wasInterrupted: true }))).toBe("invalidated");
  });

  it("returns reversed for rolled-back-but-live turns", () => {
    expect(milestoneMarker(turn({ wasRolledBack: true, status: "extracted" }))).toBe("reversed");
  });

  it("returns outcome only when not invalidated/reversed", () => {
    expect(milestoneMarker(turn({ type: "change", tags: ["merged"] }))).toBe("outcome");
    expect(milestoneMarker(turn({ wasRolledBack: true, tags: ["merged"] }))).toBe("reversed");
  });

  it("ignores topic tags and the invalidated: namespace", () => {
    expect(milestoneMarker(turn({ type: "decision", tags: ["rollback", "milestone"] }))).toBeNull();
    expect(milestoneMarker(turn({ tags: ["invalidated:notified:rollback"] }))).toBeNull();
  });

  it("reads reversal keyword tags only when enabled and only on decisions", () => {
    const decision = turn({ type: "decision", tags: ["design-pivot"] });
    const discovery = turn({ type: "discovery", tags: ["design-pivot"] });
    expect(milestoneMarker(decision)).toBeNull();
    expect(milestoneMarker(decision, { enableReversalKeyword: true })).toBe("reversed");
    expect(milestoneMarker(discovery, { enableReversalKeyword: true })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mcp/timeline.test.ts -t "milestoneMarker"`
Expected: FAIL — `milestoneMarker is not a function` / import error.

- [ ] **Step 3: Write minimal implementation**

In `src/mcp/timeline.ts`, add constants after `MILESTONE_TIER2_PER_DAY` (`src/mcp/timeline.ts:63`):

```ts
export const MILESTONE_TITLE_CAP = 90;
export const MILESTONE_DAY_BUDGET_BASE = 4;
export const MILESTONE_DAY_BUDGET_MAX = 7;
export const MILESTONE_DAY_BUDGET_DIVISOR = 8;
export const FOLD_FIRST_MIN_RUN = 4;

export const OUTCOME_TAGS = new Set([
  "merged",
  "shipped",
  "released",
  "ready-to-merge",
  "approved",
  "finalized",
]);

// Duplicated from extractReversalFlag intentionally: the spec non-goal keeps
// extractReversalFlag untouched (it still drives turns/phases strike-through).
export const REVERSAL_KEYWORD_TAGS = new Set([
  "reversal",
  "reversed",
  "superseded",
  "supersede",
  "reframed",
  "reframe",
  "design-pivot",
  "pivot",
]);

export type MilestoneMarker = "invalidated" | "reversed" | "outcome" | null;
```

Add the function right after `extractReversalFlag` (`src/mcp/timeline.ts:471`):

```ts
export function milestoneMarker(
  turn: TurnRecord,
  options: { enableReversalKeyword?: boolean } = {},
): MilestoneMarker {
  if (turn.status === "undone" || turn.wasInterrupted) {
    return "invalidated";
  }

  const keywordReversal =
    options.enableReversalKeyword === true &&
    turn.type === "decision" &&
    turn.tags.some((tag) => REVERSAL_KEYWORD_TAGS.has(tag));

  if (turn.wasRolledBack || keywordReversal) {
    return "reversed";
  }

  if (turn.tags.some((tag) => OUTCOME_TAGS.has(tag))) {
    return "outcome";
  }

  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/mcp/timeline.test.ts -t "milestoneMarker"`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/timeline.ts tests/mcp/timeline.test.ts
git commit -m "feat(timeline): add milestoneMarker + outcome/reversal constants"
```

---

## Task 2: Significance score + candidacy helpers (D1)

**Files:**
- Modify: `src/mcp/timeline.ts` (add after `milestoneCandidateTurn` at `src/mcp/timeline.ts:492`)
- Test: `tests/mcp/timeline.test.ts`

- [ ] **Step 1: Write the failing test**

Add `milestoneBaseScore` and `milestoneSignificance` to the test import, then:

```ts
describe("milestoneBaseScore / milestoneSignificance", () => {
  const noEndpoints = new Set<number>();

  it("scores by type, requiring files for deliverables", () => {
    expect(milestoneBaseScore(turn({ type: "decision" }))).toBe(4);
    expect(milestoneBaseScore(turn({ type: "feature", filesModified: ["a.ts"] }))).toBe(3);
    expect(milestoneBaseScore(turn({ type: "feature", filesModified: [] }))).toBe(0);
    expect(milestoneBaseScore(turn({ type: "change", filesModified: [] }))).toBe(0);
    expect(milestoneBaseScore(turn({ type: "bugfix" }))).toBe(2);
    expect(milestoneBaseScore(turn({ type: "discovery" }))).toBe(0);
  });

  it("gives always-keep turns +infinity", () => {
    expect(milestoneSignificance(turn({ type: "compact" }), noEndpoints, 10)).toBe(Number.POSITIVE_INFINITY);
    expect(milestoneSignificance(turn({ type: "change", tags: ["merged"], filesModified: [] }), noEndpoints, 10)).toBe(Number.POSITIVE_INFINITY);
    expect(milestoneSignificance(turn({ promptNumber: 5 }), new Set([5]), 10)).toBe(Number.POSITIVE_INFINITY);
  });

  it("re-admits a bursting discovery as a 0.5 singleton, else 0", () => {
    expect(milestoneSignificance(turn({ type: "discovery", toolCallCount: 50 }), noEndpoints, 10)).toBe(0.5);
    expect(milestoneSignificance(turn({ type: "discovery", toolCallCount: 2 }), noEndpoints, 10)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mcp/timeline.test.ts -t "milestoneBaseScore"`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/mcp/timeline.ts`, after `milestoneCandidateTurn` (`src/mcp/timeline.ts:492`):

```ts
const MILESTONE_BASE_SCORE: Record<string, number> = {
  decision: 4,
  feature: 3,
  refactor: 3,
  bugfix: 2,
  change: 1,
};

export function milestoneBaseScore(turn: TurnRecord): number {
  const score = MILESTONE_BASE_SCORE[turn.type ?? ""] ?? 0;
  if (
    (turn.type === "feature" || turn.type === "refactor" || turn.type === "change") &&
    turn.filesModified.length === 0
  ) {
    return 0;
  }
  return score;
}

export function isMilestoneAlwaysKeep(turn: TurnRecord, endpoints: Set<number>): boolean {
  return (
    milestoneMarker(turn) !== null ||
    turn.type === "compact" ||
    endpoints.has(turn.promptNumber)
  );
}

export function isReadmittedDiscovery(turn: TurnRecord, toolBurstThreshold: number): boolean {
  return turn.type === "discovery" && (turn.toolCallCount ?? 0) > toolBurstThreshold;
}

export function milestoneSignificance(
  turn: TurnRecord,
  endpoints: Set<number>,
  toolBurstThreshold: number,
): number {
  if (isMilestoneAlwaysKeep(turn, endpoints)) {
    return Number.POSITIVE_INFINITY;
  }
  if (isReadmittedDiscovery(turn, toolBurstThreshold)) {
    return 0.5;
  }
  return milestoneBaseScore(turn);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/mcp/timeline.test.ts -t "milestoneBaseScore"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/timeline.ts tests/mcp/timeline.test.ts
git commit -m "feat(timeline): add milestone significance + candidacy helpers"
```

---

## Task 3: Cluster folding `foldMilestoneRuns` (D2)

**Files:**
- Modify: `src/mcp/timeline.ts` (add after the helpers from Task 2)
- Test: `tests/mcp/timeline.test.ts`

- [ ] **Step 1: Write the failing test**

Add `foldMilestoneRuns` to the test import:

```ts
describe("foldMilestoneRuns", () => {
  const noEndpoints = new Set<number>();
  const decisions = (count: number) =>
    Array.from({ length: count }, (_, i) =>
      turn({ promptNumber: i + 1, type: "decision", title: `d${i + 1}` }),
    );

  it("keeps only the last of a short decision run", () => {
    const kept = foldMilestoneRuns(decisions(3), noEndpoints);
    expect([...kept].sort((a, b) => a - b)).toEqual([3]);
  });

  it("keeps first + last of a >=4 decision run", () => {
    const kept = foldMilestoneRuns(decisions(5), noEndpoints);
    expect([...kept].sort((a, b) => a - b)).toEqual([1, 5]);
  });

  it("keeps bugfix runs at last-only regardless of length", () => {
    const bugs = Array.from({ length: 5 }, (_, i) =>
      turn({ promptNumber: i + 1, type: "bugfix", title: `b${i + 1}` }),
    );
    expect([...foldMilestoneRuns(bugs, noEndpoints)]).toEqual([5]);
  });

  it("a non-candidate type between two decision groups splits the runs", () => {
    const rows = [
      turn({ promptNumber: 1, type: "decision" }),
      turn({ promptNumber: 2, type: "decision" }),
      turn({ promptNumber: 3, type: "discovery" }),
      turn({ promptNumber: 4, type: "decision" }),
      turn({ promptNumber: 5, type: "decision" }),
    ];
    expect([...foldMilestoneRuns(rows, noEndpoints)].sort((a, b) => a - b)).toEqual([2, 5]);
  });

  it("excludes always-keep members from the fold so the converged member survives", () => {
    const rows = [
      turn({ promptNumber: 1, type: "decision", title: "open" }),
      turn({ promptNumber: 2, type: "decision", title: "converged" }),
      turn({ promptNumber: 3, type: "decision", title: "shipped", tags: ["merged"] }),
    ];
    // T3 is always-keep (outcome); fold keeps the last *foldable* = T2.
    expect([...foldMilestoneRuns(rows, noEndpoints)]).toEqual([2]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mcp/timeline.test.ts -t "foldMilestoneRuns"`
Expected: FAIL — not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/mcp/timeline.ts`, after the Task 2 helpers:

```ts
const FOLD_RUN_TYPES = new Set(["decision", "feature", "change", "refactor", "bugfix"]);
const FOLD_FIRST_TYPES = new Set(["decision", "feature", "change", "refactor"]); // bugfix: last only

export function foldMilestoneRuns(
  seq: TurnRecord[],
  endpoints: Set<number>,
): Set<number> {
  const kept = new Set<number>();
  let runType: string | null | undefined = undefined;
  let runMembers: TurnRecord[] = [];

  const flush = (): void => {
    if (typeof runType === "string" && FOLD_RUN_TYPES.has(runType)) {
      const foldable = runMembers.filter(
        (t) => milestoneBaseScore(t) > 0 && !isMilestoneAlwaysKeep(t, endpoints),
      );
      if (foldable.length > 0) {
        kept.add(foldable[foldable.length - 1]!.promptNumber);
        if (FOLD_FIRST_TYPES.has(runType) && foldable.length >= FOLD_FIRST_MIN_RUN) {
          kept.add(foldable[0]!.promptNumber);
        }
      }
    }
    runMembers = [];
  };

  for (const turn of seq) {
    if (turn.type !== runType) {
      flush();
      runType = turn.type;
    }
    runMembers.push(turn);
  }
  flush();

  return kept;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/mcp/timeline.test.ts -t "foldMilestoneRuns"`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/timeline.ts tests/mcp/timeline.test.ts
git commit -m "feat(timeline): add cluster-fold helper (bugfix last-only)"
```

---

## Task 4: Rewrite `selectMilestoneTurns` + new types + per-day budget + endpoints (D1–D4)

**Files:**
- Modify: `src/mcp/timeline.ts` — type defs `src/mcp/timeline.ts:123-142`; `selectMilestoneTurns` `src/mcp/timeline.ts:780-911`; `renderMilestoneDigest` marker access `src/mcp/timeline.ts:1232`
- Test: `tests/mcp/timeline.test.ts` — replace the existing `describe("selectMilestoneTurns")` block

- [ ] **Step 1: Change the types**

Replace `KeptMilestone` and `OverflowHint` (`src/mcp/timeline.ts:123-137`) with:

```ts
export interface KeptMilestone {
  turn: TurnRecord;
  score: number;
  marker: MilestoneMarker;
}

export interface OverflowHint {
  date: string;
  count: number;
  firstPrompt: number;
  lastPrompt: number;
  lastKeptPrompt: number;
}
```

(`MilestoneSelection` at `src/mcp/timeline.ts:139-142` is unchanged: `{ kept: KeptMilestone[]; overflowByDay: OverflowHint[] }`.)

- [ ] **Step 2: Fix the one downstream reader so it compiles**

In `renderMilestoneDigest` (`src/mcp/timeline.ts:1230-1233`), change the marker mapping from the removed `.invalidated`/`.reversal` to the new `.marker` (Task 6 rewrites this function fully; this keeps it compiling/green now):

```ts
  const renderedTurns = view.pagedMilestones.map((milestone) => ({
    turn: milestone.turn,
    marker:
      milestone.marker === "invalidated"
        ? "🚫"
        : milestone.marker === "reversed"
          ? "↩️"
          : milestone.marker === "outcome"
            ? "🏁"
            : null,
  }));
```

- [ ] **Step 3: Write the failing test (replace the old block)**

Delete the entire existing `describe("selectMilestoneTurns", ...)` block in `tests/mcp/timeline.test.ts` (it encodes the removed Tier-1/Tier-2 model, including the `.tier`/`.invalidated` assertions). Replace it with:

```ts
describe("selectMilestoneTurns (narrative digest)", () => {
  const select = (rows: TurnRecord[]): MilestoneSelection =>
    selectMilestoneTurns({
      windowTurns: rows,
      windowSignals: detectShapeSignals(rows),
      compactBoundaries: [],
    });
  const kept = (s: MilestoneSelection) => s.kept.map((k) => k.turn.promptNumber).sort((a, b) => a - b);

  it("folds a long decision run to its first+last (run interior dropped)", () => {
    const base = 1_779_782_400;
    // Bracket the 6-decision run (T2–T7) with a leading discovery + trailing feature
    // so the run's first/last are NOT the window endpoints.
    const rows = [
      turn({ promptNumber: 1, type: "discovery", title: "intro", toolCallCount: 1, createdAtEpoch: base }),
      ...Array.from({ length: 6 }, (_, i) =>
        turn({ promptNumber: i + 2, type: "decision", title: `d${i + 2}`, createdAtEpoch: base + (i + 1) * 60 }),
      ),
      turn({ promptNumber: 8, type: "feature", title: "done", filesModified: ["a.ts"], createdAtEpoch: base + 7 * 60 }),
    ];
    const k = kept(select(rows));
    expect(k).toContain(2); // run-first foldable
    expect(k).toContain(7); // run-last foldable
    expect(k).not.toContain(4); // interior folded away
    expect(k).not.toContain(5);
  });

  it("marks rolled-back as reversed and outcome-tagged as outcome, force-keeping both", () => {
    const base = 1_779_782_400;
    const rows = [
      turn({ promptNumber: 1, type: "decision", title: "start", createdAtEpoch: base }),
      turn({ promptNumber: 2, type: "decision", title: "pivot", wasRolledBack: true, createdAtEpoch: base + 60 }),
      turn({ promptNumber: 3, type: "discovery", title: "ship", tags: ["merged"], createdAtEpoch: base + 120 }),
      turn({ promptNumber: 4, type: "decision", title: "end", createdAtEpoch: base + 180 }),
    ];
    const result = select(rows);
    expect(kept(result)).toContain(2);
    expect(kept(result)).toContain(3); // outcome on a discovery is still force-kept
    expect(result.kept.find((k) => k.turn.promptNumber === 2)?.marker).toBe("reversed");
    expect(result.kept.find((k) => k.turn.promptNumber === 3)?.marker).toBe("outcome");
  });

  it("caps a heavy day and emits one overflow hint on the last kept prompt", () => {
    const base = 1_779_782_400;
    // 30 turns ALTERNATING decision/change on one day -> 30 singleton runs, so folding
    // keeps each one (no consecutive same-type collapse). 30 survivors > cap -> overflow.
    const rows = Array.from({ length: 30 }, (_, i) =>
      turn({
        promptNumber: i + 1,
        type: i % 2 === 0 ? "decision" : "change",
        title: `m${i + 1}`,
        filesModified: i % 2 === 0 ? [] : ["a.ts"],
        toolCallCount: 30 - i,
        createdAtEpoch: base + i * 60,
      }),
    );
    const result = select(rows);
    // cap = min(4 + floor(30/8), 7) = 7 kept -> 23 dropped, exactly one overflow entry.
    expect(result.overflowByDay).toHaveLength(1);
    expect(result.overflowByDay[0]!.count).toBe(rows.length - result.kept.length);
    expect(result.overflowByDay[0]!.lastKeptPrompt).toBe(
      Math.max(...result.kept.map((k) => k.turn.promptNumber)),
    );
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `bun test tests/mcp/timeline.test.ts -t "selectMilestoneTurns (narrative digest)"`
Expected: FAIL — old `selectMilestoneTurns` returns `.tier`-shaped results / wrong selection.

- [ ] **Step 5: Write the implementation**

Replace the entire `selectMilestoneTurns` function (`src/mcp/timeline.ts:780-911`) with:

```ts
export function selectMilestoneTurns(view: {
  session?: SessionRecord;
  windowTurns: TurnRecord[];
  windowSignals: ShapeSignals;
  compactBoundaries: number[];
}): MilestoneSelection {
  const seq = sortTurnsForAnalysis(view.windowTurns).filter(
    (turn) => turn.status !== "skipped",
  );
  if (seq.length === 0) {
    return { kept: [], overflowByDay: [] };
  }

  const threshold = view.windowSignals.toolBurstThreshold;

  // D4 endpoints: window first live + window last *titled* live.
  const endpoints = new Set<number>();
  endpoints.add(seq[0]!.promptNumber);
  const lastTitled = [...seq].reverse().find((t) => t.title !== null && t.title !== "");
  endpoints.add((lastTitled ?? seq[seq.length - 1]!).promptNumber);

  // D2 fold + D1 always-keep / re-admitted discovery, unioned.
  const keptPrompts = foldMilestoneRuns(seq, endpoints);
  for (const turn of seq) {
    if (
      isMilestoneAlwaysKeep(turn, endpoints) ||
      isReadmittedDiscovery(turn, threshold)
    ) {
      keptPrompts.add(turn.promptNumber);
    }
  }

  const survivors = seq.filter((turn) => keptPrompts.has(turn.promptNumber));

  // D3 per-day adaptive budget.
  const byDay = new Map<string, TurnRecord[]>();
  for (const turn of survivors) {
    const day = formatLocalDate(turn.createdAtEpoch);
    const bucket = byDay.get(day) ?? [];
    bucket.push(turn);
    byDay.set(day, bucket);
  }

  const finalPrompts = new Set<number>();
  const overflowByDay: OverflowHint[] = [];

  for (const [date, dayTurns] of byDay) {
    const cap = Math.min(
      MILESTONE_DAY_BUDGET_BASE + Math.floor(dayTurns.length / MILESTONE_DAY_BUDGET_DIVISOR),
      MILESTONE_DAY_BUDGET_MAX,
    );
    const ranked = [...dayTurns].sort((a, b) => {
      const sa = milestoneSignificance(a, endpoints, threshold);
      const sb = milestoneSignificance(b, endpoints, threshold);
      if (sa !== sb) return sb - sa;
      const ta = a.toolCallCount ?? 0;
      const tb = b.toolCallCount ?? 0;
      if (ta !== tb) return tb - ta;
      return a.promptNumber - b.promptNumber;
    });

    const top = ranked.slice(0, cap);
    for (const turn of top) finalPrompts.add(turn.promptNumber);
    // Always-keep beyond the cap are force-kept (the spine is never dropped).
    for (const turn of ranked.slice(cap)) {
      if (isMilestoneAlwaysKeep(turn, endpoints)) finalPrompts.add(turn.promptNumber);
    }

    const dropped = ranked.filter((turn) => !finalPrompts.has(turn.promptNumber));
    if (dropped.length > 0) {
      const byPrompt = [...dropped].sort((a, b) => a.promptNumber - b.promptNumber);
      const keptThatDay = dayTurns
        .filter((turn) => finalPrompts.has(turn.promptNumber))
        .map((turn) => turn.promptNumber);
      overflowByDay.push({
        date,
        count: dropped.length,
        firstPrompt: byPrompt[0]!.promptNumber,
        lastPrompt: byPrompt[byPrompt.length - 1]!.promptNumber,
        lastKeptPrompt: keptThatDay.length > 0 ? Math.max(...keptThatDay) : 0,
      });
    }
  }

  const kept: KeptMilestone[] = seq
    .filter((turn) => finalPrompts.has(turn.promptNumber))
    .map((turn) => ({
      turn,
      score: milestoneSignificance(turn, endpoints, threshold),
      marker: milestoneMarker(turn),
    }));

  return { kept, overflowByDay };
}
```

> Note: `milestoneCandidateTurn` (`src/mcp/timeline.ts:482`) is no longer used by selection. Leave it exported for now (other call sites / tests may reference it); Task 7 removes it if `grep` shows it is dead.

- [ ] **Step 6: Run the test + the marker test + typecheck**

Run: `bun test tests/mcp/timeline.test.ts -t "selectMilestoneTurns (narrative digest)"`
Expected: PASS (3 tests).
Run: `bun run typecheck`
Expected: no errors (the `KeptMilestone` shape change is now consistent with the Step-2 render fix).

- [ ] **Step 7: Commit**

```bash
git add src/mcp/timeline.ts tests/mcp/timeline.test.ts
git commit -m "feat(timeline): rewrite milestone selection (fold + significance + day budget)"
```

---

## Task 5: `MilestoneDayGroup` plumbing + pagination in `buildTimelineView` (D8)

**Files:**
- Modify: `src/mcp/timeline.ts` — `TimelineView` interface `src/mcp/timeline.ts:15-41`; `buildTimelineView` milestone pagination `src/mcp/timeline.ts:1046-1098`
- Test: `tests/mcp/timeline.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("milestoneDayGroups (pagination)", () => {
  it("splits a day across a page boundary, repeats the day header, overflow once on final slice", () => {
    const db = createDatabase(":memory:");
    const base = 1_779_782_400;
    // 40 turns ALTERNATING decision/change on one local day → 40 singleton runs (none
    // fold away), so survivors exceed both the day cap (7) and the pageSize (5).
    const rows = Array.from({ length: 40 }, (_, i) =>
      turn({
        promptNumber: i + 1,
        type: i % 2 === 0 ? "decision" : "change",
        title: `m ${i + 1}`,
        filesModified: i % 2 === 0 ? [] : ["a.ts"],
        toolCallCount: 40 - i,
        createdAtEpoch: base + i * 60,
      }),
    );
    seedTimelineSession(db, rows);

    const page1 = buildTimelineView(db, { id: "S1", view: "milestones", page: 1, pageSize: 5 });
    const page2 = buildTimelineView(db, { id: "S1", view: "milestones", page: 2, pageSize: 5 });

    expect(page1.milestoneDayGroups.length).toBeGreaterThanOrEqual(1);
    const g1 = page1.milestoneDayGroups[0]!;
    const g2 = page2.milestoneDayGroups[0]!;
    // same full-day metadata on both slices
    expect(g2.date).toBe(g1.date);
    expect(g2.keptCount).toBe(g1.keptCount);
    expect(g2.continued).toBe(true);
    // overflow exists on exactly one slice (the final one)
    const overflowSlices = [g1, g2].filter((g) => g.isFinalSliceForDay && g.overflow !== null);
    expect(overflowSlices.length).toBeLessThanOrEqual(1);
    expect(g1.overflow === null || g1.isFinalSliceForDay).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mcp/timeline.test.ts -t "milestoneDayGroups"`
Expected: FAIL — `milestoneDayGroups` undefined on the view.

- [ ] **Step 3: Add the interface + builder**

In `src/mcp/timeline.ts`, add to the `TimelineView` interface (after `pagedMilestones` at `src/mcp/timeline.ts:27`):

```ts
  milestoneDayGroups: MilestoneDayGroup[];
```

Add the interface near `MilestoneSelection` (`src/mcp/timeline.ts:142`):

```ts
export interface MilestoneDayGroup {
  date: string;
  label: number; // local-date epoch anchor for formatting (createdAtEpoch of first row)
  promptLo: number; // full-day range, not page-local
  promptHi: number;
  keptCount: number; // full-day kept count, not page-local
  rows: KeptMilestone[]; // this page's slice
  continued: boolean; // true when this is not the day's first slice
  isFinalSliceForDay: boolean;
  overflow: OverflowHint | null; // attached only on the final slice
}
```

Add the builder (after `buildContextTimelineView`, around `src/mcp/timeline.ts:1138`):

```ts
function buildMilestoneDayGroups(
  pagedMilestones: KeptMilestone[],
  allMilestones: KeptMilestone[],
  overflowByDay: OverflowHint[],
): MilestoneDayGroup[] {
  if (pagedMilestones.length === 0) return [];

  const dayKey = (m: KeptMilestone) => formatLocalDate(m.turn.createdAtEpoch);

  // Full-day stats from the complete kept set.
  const fullByDay = new Map<string, KeptMilestone[]>();
  for (const m of allMilestones) {
    const key = dayKey(m);
    const bucket = fullByDay.get(key) ?? [];
    bucket.push(m);
    fullByDay.set(key, bucket);
  }
  const overflowFor = new Map(overflowByDay.map((o) => [o.date, o]));

  const groups: MilestoneDayGroup[] = [];
  for (const m of pagedMilestones) {
    const key = dayKey(m);
    let group = groups.length > 0 && groups[groups.length - 1]!.date === key
      ? groups[groups.length - 1]!
      : null;
    if (group === null) {
      const full = fullByDay.get(key) ?? [];
      const fullPrompts = full.map((x) => x.turn.promptNumber);
      group = {
        date: key,
        label: m.turn.createdAtEpoch,
        promptLo: Math.min(...fullPrompts),
        promptHi: Math.max(...fullPrompts),
        keptCount: full.length,
        rows: [],
        continued: false,
        isFinalSliceForDay: false,
        overflow: null,
      };
      groups.push(group);
    }
    group.rows.push(m);
  }

  // continued = this page-slice does not start at the day's overall-first kept milestone;
  // isFinalSliceForDay = this slice ends at the day's overall-last kept milestone.
  for (const group of groups) {
    const full = fullByDay.get(group.date) ?? [];
    const dayFirstPrompt = full[0]?.turn.promptNumber ?? -1;
    const dayLastPrompt = full[full.length - 1]?.turn.promptNumber ?? -1;
    const firstRowPrompt = group.rows[0]?.turn.promptNumber ?? -1;
    const lastRowPrompt = group.rows[group.rows.length - 1]?.turn.promptNumber ?? -1;
    group.continued = firstRowPrompt !== dayFirstPrompt;
    group.isFinalSliceForDay = lastRowPrompt === dayLastPrompt;
    if (group.isFinalSliceForDay) {
      group.overflow = overflowFor.get(group.date) ?? null;
    }
  }

  return groups;
}
```

In `buildTimelineView`, after `pagedMilestones` is computed (`src/mcp/timeline.ts:1046-1049`), add:

```ts
  const milestoneDayGroups =
    viewKind === "milestones"
      ? buildMilestoneDayGroups(
          pagedMilestones.items,
          milestoneSelection.kept,
          milestoneSelection.overflowByDay,
        )
      : [];
```

Add `milestoneDayGroups,` to the returned object (after `pagedMilestones: pagedMilestones.items,` at `src/mcp/timeline.ts:1085`).

- [ ] **Step 4: Run test + typecheck**

Run: `bun test tests/mcp/timeline.test.ts -t "milestoneDayGroups"`
Expected: PASS.
Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/timeline.ts tests/mcp/timeline.test.ts
git commit -m "feat(timeline): build paginated milestone day-groups with overflow placement"
```

---

## Task 6: New day-grouped, title-only `renderMilestoneDigest` (D7)

**Files:**
- Modify: `src/mcp/timeline.ts` — `renderMilestoneDigest` `src/mcp/timeline.ts:1226-1236`
- Test: `tests/mcp/timeline.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("renderMilestoneDigest layout", () => {
  it("renders day-grouped title-only rows with front-gutter markers, no prompt/stats columns", () => {
    const db = createDatabase(":memory:");
    const base = 1_779_782_400;
    const rows = [
      turn({ promptNumber: 1, type: "decision", title: "kick off the design", userPrompt: "PROMPTTEXT", createdAtEpoch: base }),
      turn({ promptNumber: 2, type: "decision", title: "pivot the approach", wasRolledBack: true, createdAtEpoch: base + 60 }),
      turn({ promptNumber: 3, type: "feature", title: "shipped it", tags: ["merged"], filesModified: ["a.ts"], createdAtEpoch: base + 120 }),
    ];
    seedTimelineSession(db, rows);
    const out = renderTimeline(buildTimelineView(db, { id: "S1", view: "milestones" }));

    expect(out).not.toContain("PROMPTTEXT"); // no user prompt
    expect(out).not.toContain("T# | line | time | gap"); // not the turn table
    expect(out).toContain("↩️ T2"); // reversed marker in front gutter
    expect(out).toContain("🏁 T3"); // outcome marker in front gutter
    expect(out).toMatch(/── \d{4}-\d{2}-\d{2} \w{3} · T1–T3 · \d+ kept/); // day header (full date, matches day-divider style)
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mcp/timeline.test.ts -t "renderMilestoneDigest layout"`
Expected: FAIL — current output is the turn table (`T# | line | …`) and contains `PROMPTTEXT`.

Also run `grep -n 'view: "milestones"\|view="milestones"\|🚫\|↩️' tests/mcp/timeline.test.ts` to find any **existing** milestone-render tests that assert the old turn-table format (e.g. `T# | line |` rows, `prompt → title`, or `… +N more … this day`). Those must be migrated to the day-grouped format in Step 4 (or deleted if redundant with the new "renderMilestoneDigest layout" test). Do not leave assertions pinning the old turn-table milestone output.

- [ ] **Step 3: Replace `renderMilestoneDigest`**

Replace `renderMilestoneDigest` (`src/mcp/timeline.ts:1226-1236`) with the day-grouped renderer (note: the `promptCap` parameter is dropped — milestones do not render the prompt):

```ts
const MILESTONE_MARKER_GLYPH: Record<Exclude<MilestoneMarker, null>, string> = {
  invalidated: "🚫",
  reversed: "↩️",
  outcome: "🏁",
};

function renderMilestoneDigest(view: TimelineView): string[] {
  if (view.milestoneDayGroups.length === 0) {
    return [];
  }

  const lines: string[] = [""];
  for (const group of view.milestoneDayGroups) {
    const cont = group.continued ? " (cont.)" : "";
    lines.push(
      `── ${formatLocalDateWithWeekday(group.labelEpoch)} · T${group.promptLo}–T${group.promptHi} · ${group.keptCount} kept${cont} ──`,
    );
    for (const milestone of group.rows) {
      const glyph = milestone.marker === null ? "  " : MILESTONE_MARKER_GLYPH[milestone.marker];
      const emoji = TYPE_EMOJI_MAP[milestone.turn.type ?? ""] ?? (milestone.turn.type === null ? PENDING_EMOJI : "•");
      const title = sanitizeTimelineField(
        truncateText(milestone.turn.title ?? "(untitled)", MILESTONE_TITLE_CAP),
      );
      lines.push(`   ${glyph} T${milestone.turn.promptNumber} ${emoji} ${title}`);
    }
    if (group.overflow !== null) {
      lines.push(
        `        … +${group.overflow.count} more → timeline(id="S${view.session.id}", view="turns") @ T${group.overflow.firstPrompt}–T${group.overflow.lastPrompt}`,
      );
    }
  }

  return lines;
}
```

Update the dispatch in `renderTimeline` (`src/mcp/timeline.ts:1581-1583`) to drop the now-unused `promptCap` argument:

```ts
      : view.view === "milestones"
        ? renderMilestoneDigest(view)
        : renderTurnTable(view, promptCap);
```

- [ ] **Step 4: Run test + typecheck**

Run: `bun test tests/mcp/timeline.test.ts -t "renderMilestoneDigest layout"`
Expected: PASS.
Run: `bun run typecheck`
Expected: no errors (the temporary marker-mapping object from Task 4 Step 2 is now removed; verify no `view.pagedMilestones.map` remains in `renderMilestoneDigest`).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/timeline.ts tests/mcp/timeline.test.ts
git commit -m "feat(timeline): day-grouped title-only milestone render with gutter markers"
```

---

## Task 7: Frozen fixture + retention guard + cleanup + full verification

**Files:**
- Modify: `tests/mcp/timeline.test.ts` (add fixture + guard)
- Modify: `src/mcp/timeline.ts` (remove dead `MILESTONE_TIER2_PER_DAY`; remove `milestoneCandidateTurn` only if dead)
- Modify: `plugin/scripts/*.cjs` (rebuild)

- [ ] **Step 1: Write the frozen-fixture retention guard test**

Add a hand-built, committed fixture (does NOT read the live DB — the spec's Codex finding #4):

```ts
function milestoneFixtureTurns(): TurnRecord[] {
  const day = 24 * 60 * 60;
  const base = 1_779_782_400; // fixed; never Date.now()
  const rows: TurnRecord[] = [];
  let pn = 0;
  const add = (over: Partial<TurnRecord>, epoch: number) => {
    pn += 1;
    rows.push(turn({ promptNumber: pn, createdAtEpoch: epoch, title: `t${pn}`, ...over }));
  };
  // 6 days × 20 turns = 120. Each day: 14 discovery (noise, tool_call_count 0 → dropped,
  // and 0 keeps the burst threshold at 0 so none are re-admitted) + a 5-long decision run
  // (folds to first+last = 2) + 1 merged feature (outcome → always-keep). Lands ~15.8%.
  for (let d = 0; d < 6; d += 1) {
    const dayBase = base + d * day;
    for (let i = 0; i < 14; i += 1) add({ type: "discovery", toolCallCount: 0 }, dayBase + i * 60);
    for (let i = 0; i < 5; i += 1) add({ type: "decision" }, dayBase + (14 + i) * 60);
    add({ type: "feature", filesModified: ["a.ts"], tags: ["merged"] }, dayBase + 19 * 60);
  }
  return rows;
}

describe("milestone retention guard (frozen fixture)", () => {
  it("keeps 12-20% of non-skipped turns on the frozen fixture", () => {
    const rows = milestoneFixtureTurns();
    const result = selectMilestoneTurns({
      windowTurns: rows,
      windowSignals: detectShapeSignals(rows),
      compactBoundaries: [],
    });
    const ratio = result.kept.length / rows.length;
    expect(ratio).toBeGreaterThanOrEqual(0.12);
    expect(ratio).toBeLessThanOrEqual(0.20);
  });

  it("surfaces every outcome-only fixture turn with the outcome marker", () => {
    const rows = milestoneFixtureTurns();
    const result = selectMilestoneTurns({
      windowTurns: rows,
      windowSignals: detectShapeSignals(rows),
      compactBoundaries: [],
    });
    const outcomeOnly = rows.filter(
      (t) => t.tags.some((tag) => OUTCOME_TAGS.has(tag)) && !t.wasRolledBack && !t.wasInterrupted && t.status !== "undone",
    );
    for (const t of outcomeOnly) {
      const k = result.kept.find((k) => k.turn.promptNumber === t.promptNumber);
      expect(k?.marker).toBe("outcome");
    }
  });
});
```

Add `OUTCOME_TAGS` to the test import if not already present.

- [ ] **Step 2: Run the guard tests**

Run: `bun test tests/mcp/timeline.test.ts -t "milestone retention guard"`
Expected: PASS. If the ratio falls outside [0.12, 0.20], do NOT widen the bounds — re-check the fold/budget implementation against D1–D3.

- [ ] **Step 3: Remove dead constant + verify `milestoneCandidateTurn`**

Run: `grep -rn "MILESTONE_TIER2_PER_DAY\|milestoneCandidateTurn" src/ tests/`
- Remove the `export const MILESTONE_TIER2_PER_DAY = 4;` line if `grep` shows no remaining references.
- If `milestoneCandidateTurn` has no remaining references, delete it and its import in the test file; otherwise leave it.

- [ ] **Step 3b: Remove dead overflow plumbing left by the Task 6 refactor**

After Task 6, milestones render via their own `renderMilestoneDigest` (reading `group.overflow`), so the OLD turn-table-shared overflow path is orphaned. Remove it **one item at a time, re-running `bun test` + `bun run typecheck` after each removal** (do not batch — if a removal turns something red, you've found a live reader and must stop and report):

1. **`renderOverflowHint`** + the `overflowByDay` parameter of `renderTurnRows`. Verify first: `grep -n "renderOverflowHint\|overflowByDay" src/mcp/timeline.ts`. `renderTurnRows`' only caller is `renderTurnTable`, which never passes `overflowByDay` (it defaults to `[]`), so the `for (const overflow of overflowByDay)` loop never iterates. Delete `renderOverflowHint`, drop the `overflowByDay` param from `renderTurnRows`, and remove the dead loop. The turn-table output must be byte-identical (it already never emitted overflow lines) — confirm the turn-table render tests still pass.
2. **`milestoneOverflowByDay`** view field. Verify first: `grep -rn "milestoneOverflowByDay" src/ tests/`. It is written in `buildTimelineView` but no longer read (the digest path uses `buildMilestoneDayGroups(... milestoneSelection.overflowByDay)` directly). If grep shows only the interface declaration + the single write site (no readers, no test assertions), remove the field from the `TimelineView` interface and delete its assignment in the returned object. If any test reads it, leave it and report.

- [ ] **Step 3c: De-duplicate the type→emoji mapping**

The emoji fallback `TYPE_EMOJI_MAP[type ?? ""] ?? (type === null ? PENDING_EMOJI : "•")` now appears in both `renderTurnRows` and the new `renderMilestoneDigest` — two formulations of one rule. Extract a single helper near `TYPE_EMOJI_MAP`:

```ts
function typeEmoji(type: string | null): string {
  if (type === null) return PENDING_EMOJI;
  return TYPE_EMOJI_MAP[type] ?? "•";
}
```

Replace both call sites with `typeEmoji(turn.type)` / `typeEmoji(milestone.turn.type)`. Confirm the rendered output is unchanged (the existing render tests pin the emojis). Also rename the local `cont` in `renderMilestoneDigest` to `contSuffix` (it holds the `" (cont.)"` suffix string, not a boolean). These are pure refactors — no test should change.

- [ ] **Step 4: Full suite + typecheck**

Run: `bun test`
Expected: all pass (including the migrated milestone tests).
Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 5: Rebuild artifacts**

Run: `bun run build`
Then: `git diff --stat plugin/scripts/*.cjs` — expect changes beyond the `BUILD_ID` line (the real timeline changes). The `BUILD_ID` timestamp line always drifts; that is expected (see `memory/project_build_id_nondeterministic.md`).

- [ ] **Step 6: Commit**

```bash
git add src/mcp/timeline.ts tests/mcp/timeline.test.ts plugin/scripts/*.cjs
git commit -m "test(timeline): frozen-fixture retention guard; remove dead milestone plumbing; rebuild"
```

---

## Final verification (after all tasks)

- [ ] `bun test` — all green.
- [ ] `bun run typecheck` — clean.
- [ ] Manual smoke (optional): in a throwaway script or REPL, `renderTimeline(buildContextTimelineView(db, <a real session id>, "milestones"))` shows day-grouped title-only output, no `prompt →` column, markers in the gutter.
- [ ] `turns` and `phases` views unchanged: `bun test tests/mcp/timeline.test.ts -t "phases"` and the turn-table tests still pass.
- [ ] Spec acceptance (`docs/plans/2026-06-07-milestone-narrative-digest.md` → Acceptance) re-read against the implementation.

## Notes for the implementer

- **Markers come only from `milestoneMarker`** — never reintroduce `isInvalidatedTurn` / `extractReversalFlag` into milestone code; those stay for `turns`/`phases`.
- **`enableReversalKeyword` defaults off** (spec knob #4). Do not wire a config flag for it in this plan; the parameter exists so a later spec can flip it. `selectMilestoneTurns` calls `milestoneMarker(turn)` with no options → keyword OR off.
- **No `Date.now()`** in tests — all fixtures use fixed epochs (`1_779_782_400` + offsets).
- **Bugfix folds to last only** (Task 3) — if you find yourself adding `bugfix` to `FOLD_FIRST_TYPES`, stop; that contradicts D2 + test strategy #1.
