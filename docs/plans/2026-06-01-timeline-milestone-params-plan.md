# Timeline milestone / phases parameters — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `milestones` and `phases` flags to the `timeline()` tool and render the SessionStart embedded timeline in milestone mode, trimming the heaviest part of the SessionStart injection without losing the resume-critical turns.

**Architecture:** Pure selection helper `selectMilestoneTurns()` (page-local) drives a filter in `renderTurnTable`; `renderTimeline` gains a phases toggle; the two flags flow `definitions.ts` schema → `handlers.ts` → `timelineQuery` → render options. SessionStart (`context.ts`) opts into `{milestones:true, phases:false}`. Defaults preserve current output except the `⏭` skipped-summary line is removed.

**Tech Stack:** TypeScript, Bun (`bun test`, `bun:sqlite`), Zod, esbuild bundling (`node scripts/build.js`).

**Spec:** `docs/plans/2026-06-01-timeline-milestone-params.md`

**Pre-flight:** Repo is on `main`. Branch first:

```bash
git checkout -b timeline-milestone-params
```

---

### Task 1: `selectMilestoneTurns` pure helper

The page-local milestone selector (spec D2). No wiring yet — just the function and its unit tests.

**Files:**
- Modify: `src/mcp/timeline.ts` (add export after `detectShapeSignals`, before `sortTurnsForAnalysis` — around line 668)
- Test: `tests/mcp/timeline.test.ts` (new `describe("selectMilestoneTurns")` block, after the `describe("detectShapeSignals")` block ~line 954)

- [ ] **Step 1: Write the failing tests**

Add this block to `tests/mcp/timeline.test.ts`. It uses the existing `turn()` helper (line 30). Add `selectMilestoneTurns` to the import from `../../src/mcp/timeline` (line 9-28).

```ts
describe("selectMilestoneTurns", () => {
  it("keeps non-discovery phase leads and drops discovery non-leads", () => {
    const turns = [
      turn({ promptNumber: 1, type: "discovery", toolCallCount: 1 }),
      turn({ promptNumber: 2, type: "discovery", toolCallCount: 1 }),
      turn({ promptNumber: 3, type: "decision", toolCallCount: 1 }),
      turn({ promptNumber: 4, type: "feature", toolCallCount: 1 }),
      turn({ promptNumber: 5, type: "discovery", toolCallCount: 1 }),
    ];
    const keep = selectMilestoneTurns(turns, 1000, []);
    // T3 (decision lead) + T4 (feature lead) + last-3 (T3,T4,T5).
    expect([...keep].sort((a, b) => a - b)).toEqual([3, 4, 5]);
  });

  it("includes a change phase-lead (no keyword special-casing)", () => {
    const turns = [
      turn({ promptNumber: 1, type: "discovery", toolCallCount: 1 }),
      turn({ promptNumber: 2, type: "change", toolCallCount: 1 }),
    ];
    expect(selectMilestoneTurns(turns, 1000, []).has(2)).toBe(true);
  });

  it("keeps every tool-burst turn, not just the top 3", () => {
    const turns = [
      turn({ promptNumber: 1, type: "discovery", toolCallCount: 100 }),
      turn({ promptNumber: 2, type: "discovery", toolCallCount: 90 }),
      turn({ promptNumber: 3, type: "discovery", toolCallCount: 80 }),
      turn({ promptNumber: 4, type: "discovery", toolCallCount: 70 }),
      turn({ promptNumber: 5, type: "discovery", toolCallCount: 1 }),
    ];
    const keep = selectMilestoneTurns(turns, 10, []);
    expect(keep.has(1)).toBe(true);
    expect(keep.has(2)).toBe(true);
    expect(keep.has(3)).toBe(true);
    expect(keep.has(4)).toBe(true);
  });

  it("keeps compact boundaries within the page, not outside", () => {
    const turns = [
      turn({ promptNumber: 10, type: "discovery", toolCallCount: 1 }),
      turn({ promptNumber: 11, type: "discovery", toolCallCount: 1 }),
    ];
    const keep = selectMilestoneTurns(turns, 1000, [10, 99]);
    expect(keep.has(10)).toBe(true);
    expect(keep.has(99)).toBe(false);
  });

  it("excludes skipped turns from selection", () => {
    const turns = [
      turn({ promptNumber: 1, type: "discovery", toolCallCount: 1 }),
      turn({
        promptNumber: 2,
        type: "decision",
        status: "skipped",
        toolCallCount: 500,
      }),
      turn({ promptNumber: 3, type: "discovery", toolCallCount: 1 }),
    ];
    expect(selectMilestoneTurns(turns, 10, []).has(2)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/mcp/timeline.test.ts -t "selectMilestoneTurns"`
Expected: FAIL — `selectMilestoneTurns is not a function` / import error.

- [ ] **Step 3: Implement `selectMilestoneTurns`**

Add to `src/mcp/timeline.ts` (after `detectShapeSignals`, before `sortTurnsForAnalysis`). `segmentPhases` and `isTimelineLiveTurn` are declared in this file; `TurnRecord` is already imported.

```ts
/**
 * Milestone selection (spec D2). Operates only on the rendered page:
 * non-discovery phase leads ∪ tool-burst turns ∪ in-page compact boundaries ∪
 * last 3 live turns. The burst threshold is the window-scoped scalar reused for
 * calibration; membership is decided per page. No cap.
 */
export function selectMilestoneTurns(
  pageTurns: TurnRecord[],
  toolBurstThreshold: number,
  compactBoundaries: number[],
): Set<number> {
  const keep = new Set<number>();
  const live = pageTurns.filter(isTimelineLiveTurn);

  for (const phase of segmentPhases(pageTurns)) {
    if (phase.type !== null && phase.type !== "discovery") {
      keep.add(phase.startPromptNumber);
    }
  }

  // Re-scan page live turns against the threshold. Do NOT reuse
  // windowSignals.toolBursts — it is .slice(0, TOOL_BURST_TOP_N)-truncated.
  for (const turn of live) {
    if ((turn.toolCallCount ?? 0) > toolBurstThreshold) {
      keep.add(turn.promptNumber);
    }
  }

  const pageNumbers = new Set(pageTurns.map((turn) => turn.promptNumber));
  for (const boundary of compactBoundaries) {
    if (pageNumbers.has(boundary)) {
      keep.add(boundary);
    }
  }

  for (const turn of live.slice(-3)) {
    keep.add(turn.promptNumber);
  }

  return keep;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/mcp/timeline.test.ts -t "selectMilestoneTurns"`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
bun run typecheck
git add src/mcp/timeline.ts tests/mcp/timeline.test.ts
git commit -m "feat(timeline): add page-local selectMilestoneTurns helper"
```

---

### Task 2: Remove the `⏭` skipped summary, preserve gap tracking

Spec D4. The `⏭ T…` summary line is removed in all modes; skipped turns still advance gap tracking. Two existing tests assert the old behavior and must be updated.

**Files:**
- Modify: `src/mcp/timeline.ts` — `renderTurnTable` (~884-929), delete `renderSkippedSummary` (~1013-1034) and `SKIPPED_EMOJI` const (line 120)
- Test: `tests/mcp/timeline.test.ts` — update the `:499` and `:1377` tests

- [ ] **Step 1: Update the two existing tests to the new behavior**

Replace the `:499` test ("renders skipped turns without the pending marker") with:

```ts
  it("filters skipped turns out without a marker or summary", () => {
    const db = createDatabase(":memory:");
    const session = seedSession(db);

    db.query(
      "UPDATE turns SET status = 'skipped' WHERE session_id = ? AND prompt_number = 19",
    ).run(session.id);

    const view = buildTimelineView(db, { id: "S1/T19..21" });
    const output = renderTimeline(view);

    expect(output).not.toContain("⏭");
    expect(output).not.toContain("T19 |");
  });
```

Replace the `:1377` test ("keeps skipped turns in gap tracking while collapsing them to a trailing summary") — keep its DB setup verbatim, replace the assertions block (the part after `const view = buildTimelineView(db, { id: "S1/T19..21" });`) with:

```ts
    const view = buildTimelineView(db, { id: "S1/T19..21" });
    const output = renderTimeline(view);
    const turn21Line = output
      .split("\n")
      .find((line) => line.startsWith("T21 |"));

    expect(turn21Line).toBeDefined();
    expect(turn21Line).toContain("| +50s |");
    expect(output).not.toContain("⏭");
    expect(output).not.toContain("T20 |");
```

Rename it to: `it("keeps skipped turns in gap tracking without a trailing summary", () => {`.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test tests/mcp/timeline.test.ts -t "skipped"`
Expected: FAIL — output still contains `⏭` (summary not yet removed).

- [ ] **Step 3: Remove the summary, keep gap tracking**

In `src/mcp/timeline.ts`, replace `renderTurnTable` (current body lines ~884-929) with:

```ts
function renderTurnTable(
  view: TimelineView,
  promptCap: number = PROMPT_COLUMN_CAP,
): string[] {
  if (view.pageTurns.length === 0) {
    return [];
  }

  const brokenPromptCandidates = new Set<number>();
  for (const pair of view.windowSignals.brokenPromptPairs) {
    brokenPromptCandidates.add(pair.first);
    brokenPromptCandidates.add(pair.second);
  }

  const lines = [
    "",
    "T# | line | time | gap | stats | prompt → title",
  ];

  let prevEpoch: number | null = null;
  for (const turn of view.pageTurns) {
    const previousTurnEpoch = prevEpoch;
    // Advance gap tracking for every turn (incl. skipped) so the gap on the
    // next rendered row spans hidden turns and stays a true delta.
    prevEpoch = turn.createdAtEpoch;

    if (turn.status === "skipped") {
      continue;
    }

    lines.push(
      renderTurnRow(
        turn,
        previousTurnEpoch,
        brokenPromptCandidates.has(turn.promptNumber),
        promptCap,
      ),
    );
  }

  return lines;
}
```

Then delete the now-unused `renderSkippedSummary` function (entire `function renderSkippedSummary(...) { ... }` block) and the `const SKIPPED_EMOJI = "⏭";` line.

- [ ] **Step 4: Verify no dangling references**

Run: `grep -rnE "⏭|SKIPPED_EMOJI|renderSkippedSummary|skippedTurnNumbers" src/`
Expected: no matches.

- [ ] **Step 5: Run tests + typecheck**

Run: `bun test tests/mcp/timeline.test.ts && bun run typecheck`
Expected: PASS, clean typecheck.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/timeline.ts tests/mcp/timeline.test.ts
git commit -m "feat(timeline): drop skipped-turn summary line, keep gap tracking"
```

---

### Task 3: `milestones` / `phases` render options + wiring

Wire the helper into `renderTurnTable`, add the phases toggle to `renderTimeline`, and extend `RenderTimelineOptions` / `TimelineInput` / `timelineQuery`.

**Files:**
- Modify: `src/mcp/timeline.ts` — `RenderTimelineOptions` (~32-35), `TimelineInput` (~6-10), `renderTurnTable`, `renderTimeline` (~1175), `timelineQuery` (~1190)
- Test: `tests/mcp/timeline.test.ts` — add to `describe("renderTimeline")`

- [ ] **Step 1: Write the failing tests**

Add inside `describe("renderTimeline", () => { ... })`:

```ts
  it("milestones=true renders only milestone turns", () => {
    const db = createDatabase(":memory:");
    seedSession(db);
    const view = buildTimelineView(db, { id: "S1" });

    const rowCount = (s: string) =>
      s.split("\n").filter((l) => /^T\d+ \|/.test(l)).length;

    const full = renderTimeline(view);
    const milestone = renderTimeline(view, { milestones: true });

    expect(rowCount(milestone)).toBeLessThan(rowCount(full));
    expect(milestone).toContain("T6 |");      // decision phase-lead kept
    expect(milestone).not.toContain("T2 |");  // discovery non-lead dropped
  });

  it("phases=false omits the phases block", () => {
    const db = createDatabase(":memory:");
    seedSession(db);
    const view = buildTimelineView(db, { id: "S1" });

    expect(renderTimeline(view)).toContain("phases (");
    expect(renderTimeline(view, { phases: false })).not.toContain("phases (");
  });

  it("milestone mode keeps gaps spanning suppressed turns", () => {
    const db = createDatabase(":memory:");
    seedSession(db);
    const view = buildTimelineView(db, { id: "S1" });

    const gapField = (line: string | undefined) => line?.split("|")[3]?.trim();
    const find = (s: string, n: string) =>
      s.split("\n").find((l) => l.startsWith(n));

    const fullT11 = find(renderTimeline(view), "T11 |");
    const msT11 = find(renderTimeline(view, { milestones: true }), "T11 |");

    expect(gapField(msT11)).toBeDefined();
    // T11 is a tool-burst milestone; T7-T10 are suppressed. Its gap must equal
    // the full-mode gap (T10→T11), proving suppressed turns still advance it.
    expect(gapField(msT11)).toBe(gapField(fullT11));
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test tests/mcp/timeline.test.ts -t "renderTimeline"`
Expected: FAIL — `milestones`/`phases` options have no effect yet.

- [ ] **Step 3: Extend the option/input types**

In `src/mcp/timeline.ts`, replace `RenderTimelineOptions`:

```ts
export interface RenderTimelineOptions {
  promptCap?: number;
  showEarlierHint?: boolean;
  /** When true, the turn table renders only milestone turns (spec D2). */
  milestones?: boolean;
  /** When false, the phases block is omitted. Defaults to included. */
  phases?: boolean;
}
```

And replace `TimelineInput`:

```ts
export interface TimelineInput {
  id: string;
  page?: number;
  pageSize?: number;
  milestones?: boolean;
  phases?: boolean;
}
```

- [ ] **Step 4: Filter in `renderTurnTable`**

Change `renderTurnTable`'s signature and add the milestone filter. Replace the function from Task 2 with:

```ts
function renderTurnTable(
  view: TimelineView,
  promptCap: number = PROMPT_COLUMN_CAP,
  milestones = false,
): string[] {
  if (view.pageTurns.length === 0) {
    return [];
  }

  const brokenPromptCandidates = new Set<number>();
  for (const pair of view.windowSignals.brokenPromptPairs) {
    brokenPromptCandidates.add(pair.first);
    brokenPromptCandidates.add(pair.second);
  }

  const milestoneSet = milestones
    ? selectMilestoneTurns(
        view.pageTurns,
        view.windowSignals.toolBurstThreshold,
        view.compactBoundaries,
      )
    : null;

  const lines = [
    "",
    "T# | line | time | gap | stats | prompt → title",
  ];

  let prevEpoch: number | null = null;
  for (const turn of view.pageTurns) {
    const previousTurnEpoch = prevEpoch;
    prevEpoch = turn.createdAtEpoch;

    if (turn.status === "skipped") {
      continue;
    }

    // Milestone mode: suppress non-milestone live turns. Gap already advanced.
    if (milestoneSet && !milestoneSet.has(turn.promptNumber)) {
      continue;
    }

    lines.push(
      renderTurnRow(
        turn,
        previousTurnEpoch,
        brokenPromptCandidates.has(turn.promptNumber),
        promptCap,
      ),
    );
  }

  return lines;
}
```

- [ ] **Step 5: Toggle in `renderTimeline` + forward in `timelineQuery`**

Replace `renderTimeline`:

```ts
export function renderTimeline(
  view: TimelineView,
  options: RenderTimelineOptions = {},
): string {
  const promptCap = options.promptCap ?? PROMPT_COLUMN_CAP;
  const milestones = options.milestones ?? false;

  return [
    ...renderSessionHeader(view),
    ...renderTurnTable(view, promptCap, milestones),
    ...(options.phases === false ? [] : renderPhases(view, options)),
    ...renderShapeSignals(view),
    ...renderEarlierHint(view, options),
  ].join("\n");
}
```

Replace `timelineQuery`:

```ts
export function timelineQuery(db: Database, input: TimelineInput): string {
  try {
    return renderTimeline(buildTimelineView(db, input), {
      milestones: input.milestones,
      phases: input.phases,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `timeline error: ${message}`;
  }
}
```

- [ ] **Step 6: Run tests + typecheck**

Run: `bun test tests/mcp/timeline.test.ts && bun run typecheck`
Expected: PASS (new + existing), clean typecheck.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/timeline.ts tests/mcp/timeline.test.ts
git commit -m "feat(timeline): milestones + phases render options"
```

---

### Task 4: MCP schema + handler plumbing + tool description

Expose the flags on the `timeline()` tool input and forward them through the handler.

**Files:**
- Modify: `src/mcp/definitions.ts` — `timelineInputShape` (~12-16) and `MNEMO_TOOL_DESCRIPTIONS.timeline` (~7)
- Modify: `src/mcp/handlers.ts` — `timeline` handler (~64-71)
- Test: `tests/mcp/definitions.test.ts` (extend `describe("timelineInputSchema")`)

- [ ] **Step 1: Write the failing schema tests**

Add inside `describe("timelineInputSchema", () => { ... })` in `tests/mcp/definitions.test.ts`:

```ts
  it("accepts boolean milestones/phases and rejects non-boolean", () => {
    expect(
      timelineInputSchema.parse({ id: "S42", milestones: true, phases: false }),
    ).toEqual({ id: "S42", milestones: true, phases: false });

    expect(() =>
      timelineInputSchema.parse({ id: "S42", milestones: "yes" }),
    ).toThrow();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/mcp/definitions.test.ts -t "timelineInputSchema"`
Expected: FAIL — strict schema rejects unknown keys `milestones`/`phases`.

- [ ] **Step 3: Extend the schema + description**

In `src/mcp/definitions.ts`, replace `timelineInputShape`:

```ts
export const timelineInputShape = {
  id: z.string().min(1),
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().optional(),
  milestones: z.boolean().optional(),
  phases: z.boolean().optional(),
};
```

Replace the `timeline` entry in `MNEMO_TOOL_DESCRIPTIONS`:

```ts
  timeline:
    "Render the temporal/decision shape of a past session — phases, gaps, tool bursts, compact boundary, broken-prompt candidates. Single-session view with range selectors plus page/pageSize pagination. Optional `milestones` (render only key turns) and `phases` (set false to drop the phases block) flags.",
```

- [ ] **Step 4: Forward the flags in the handler**

In `src/mcp/handlers.ts`, replace the `timeline` handler:

```ts
    timeline: (args) =>
      textResult(
        timelineQuery(database, {
          id: args.id as string,
          page: args.page as number | undefined,
          pageSize: args.pageSize as number | undefined,
          milestones: args.milestones as boolean | undefined,
          phases: args.phases as boolean | undefined,
        }),
      ),
```

- [ ] **Step 5: Run tests + typecheck**

Run: `bun test tests/mcp/definitions.test.ts tests/mcp/handlers.test.ts && bun run typecheck`
Expected: PASS (the existing `tool surface` test still passes — description keeps `page/pageSize`, no `hard cap`), clean typecheck.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/definitions.ts src/mcp/handlers.ts tests/mcp/definitions.test.ts
git commit -m "feat(mcp): expose timeline milestones/phases flags"
```

---

### Task 5: SessionStart renders milestone mode

Spec D5. The embedded timeline becomes milestone table + signals, no phases block.

**Files:**
- Modify: `src/hooks/handlers/context.ts` — the `renderTimeline` call (~188-193)
- Test: `tests/hooks/context.test.ts` — update the two current-session timeline tests

- [ ] **Step 1: Update the two existing current-session timeline tests**

Both tests assert the phases block appears in the embedded timeline. Under D5 (SessionStart renders `phases:false`) it no longer does, so flip each assertion to `not.toContain` and add a `⏭` guard.

In the test `"compact injects current-session timeline and keeps recent sessions collapsed"` (~line 255), the assertion at ~line 473:

```ts
    expect(output).toContain("phases (session-wide):");
```

becomes:

```ts
    expect(output).not.toContain("phases (");
    expect(output).not.toContain("⏭");
```

In the test `"compact injects a last-page timeline instead of collapsed turns"` (~line 593), the assertion at ~line 620:

```ts
    expect(output).toContain("phases (window T11-T40):");
```

becomes:

```ts
    expect(output).not.toContain("phases (");
```

Both tests still assert `## Current Session` and `T#` (the milestone table keeps the `T#` header), so they verify D5: a current-session timeline with a turn table but no phases block.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test tests/hooks/context.test.ts`
Expected: FAIL — output still contains `phases (` (milestone wiring not applied yet).

- [ ] **Step 3: Apply milestone mode in `context.ts`**

In `src/hooks/handlers/context.ts`, replace the `renderTimeline` call inside `buildCurrentSessionOutput`:

```ts
    lines.push(
      renderTimeline(timelineView, {
        promptCap: 80,
        showEarlierHint: true,
        milestones: true,
        phases: false,
      }),
    );
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test tests/hooks/context.test.ts && bun run typecheck`
Expected: PASS, clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/handlers/context.ts tests/hooks/context.test.ts
git commit -m "feat(hooks): SessionStart timeline renders milestone mode"
```

---

### Task 6: Docs, version bump, bundle rebuild, full verification

**Files:**
- Modify: `plugin/skills/mnemo-timeline/SKILL.md` (Input section ~29-43)
- Modify: `package.json:3`, `plugin/.claude-plugin/plugin.json:3`, `.claude-plugin/marketplace.json` (two `"version"` fields)
- Delete: `scripts/proto-timeline-keynodes.ts` (throwaway prototype)
- Regenerate: `plugin/scripts/{worker,mcp-server,hook-command}.cjs`

- [ ] **Step 1: Document the flags in the skill**

In `plugin/skills/mnemo-timeline/SKILL.md`, add two rows to the parameter table (after the `pageSize` row at ~line 41):

```markdown
| `milestones` | no | When `true`, render only key turns: non-discovery phase leads, tool bursts, compact boundary, and the last few turns. No row cap. |
| `phases` | no | Set `false` to omit the phases block. Default `true`. |
```

And add an example to the `## Input` code block (~line 33):

```text
timeline(id="S42", milestones=true)        # key turns only, no phases block via phases=false
```

- [ ] **Step 2: Remove the throwaway prototype**

```bash
git rm -f scripts/proto-timeline-keynodes.ts 2>/dev/null || rm -f scripts/proto-timeline-keynodes.ts
```

- [ ] **Step 3: Bump version 0.2.19 → 0.2.20**

Edit `"version": "0.2.19"` → `"version": "0.2.20"` in:
- `package.json` (line 3)
- `plugin/.claude-plugin/plugin.json` (line 3)
- `.claude-plugin/marketplace.json` (both `"version"` occurrences — the metadata block and the plugins block)

Verify all four updated:

Run: `grep -rn '"version": "0.2.20"' package.json plugin/.claude-plugin/plugin.json .claude-plugin/marketplace.json`
Expected: 4 matches; `grep -rn '0.2.19' package.json plugin/ .claude-plugin/` returns nothing.

- [ ] **Step 4: Rebuild the bundles**

Run: `node scripts/build.js`
Expected: writes `plugin/scripts/worker.cjs`, `mcp-server.cjs`, `hook-command.cjs` with a `0.2.20-<base36>` BUILD_ID.

- [ ] **Step 5: Full test suite + typecheck**

Run: `bun test && bun run typecheck`
Expected: all green, clean typecheck.

- [ ] **Step 6: Sanity-check the built bundle carries the change**

Run: `grep -c "selectMilestoneTurns" plugin/scripts/mcp-server.cjs`
Expected: ≥1 (helper bundled).

- [ ] **Step 7: Commit**

```bash
git add plugin/skills/mnemo-timeline/SKILL.md package.json plugin/.claude-plugin/plugin.json .claude-plugin/marketplace.json plugin/scripts/worker.cjs plugin/scripts/mcp-server.cjs plugin/scripts/hook-command.cjs
git commit -m "chore: timeline milestone/phases docs + 0.2.20 bundle"
```

---

## Self-review notes

- **Spec coverage:** D1 → Task 3+4 (options + schema); D2 → Task 1; D3 → Task 1 (change phase-lead test, no special-casing); D4 → Task 2; D5 → Task 5; plumbing → Task 3+4; docs/rollout → Task 6.
- **Type consistency:** `selectMilestoneTurns(pageTurns, toolBurstThreshold, compactBoundaries)` defined in Task 1, called identically in Task 3. `RenderTimelineOptions.milestones/phases` and `TimelineInput.milestones/phases` introduced in Task 3, consumed in Task 3 (`timelineQuery`) and produced in Task 4 (schema/handler) and Task 5 (context). `renderTurnTable(view, promptCap, milestones)` signature set in Task 3.
- **Green at every commit:** Task 2 updates the two `⏭` tests in the same commit that removes the summary; Task 3 builds on Task 2's `renderTurnTable`.
