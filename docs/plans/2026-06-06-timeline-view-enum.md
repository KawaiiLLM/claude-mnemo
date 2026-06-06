# Timeline view enum + long-span legibility

**Status:** approved design, plan pending
**Date:** 2026-06-06
**Scope:** `timeline()` MCP tool render layer + the SessionStart embedded
timeline + one tag-style line in the extraction prompt

## Motivation

`timeline()` degrades on long, multi-day sessions. Exercised live on **S5233**
(KawaiiLLM, 316 turns, 2026-05-26 → 06-06, ~11 days), three problems surfaced
that the current shape cannot hide:

1. **The output is date-blind.** The header reads `15:51 → 17:01 (265h 10m)` —
   clock-only end time, so an 11-day session looks like a 1-hour one; only the
   `265h` total contradicts it. Turn rows show `HH:MM` with no date, and a
   `+48h 22m` gap that crosses two calendar days lands on a bare `HH:MM` row.
   Day boundaries are invisible.
2. **The phases block is a near-1:1 re-encoding, re-paid per page.** 316 turns →
   **164 phases** (≈1.9 turns/phase), mostly single-turn `<1m 1 turn` runs. It is
   the heaviest block (~164 lines), it is session-wide, and it re-renders in full
   on every one of the 11 turn-table pages. `milestones:true` does **not** trim
   it (it only thins turn rows).
3. **`milestones` is not selective.** Re-deriving the current selection over the
   whole session keeps **159 / 256 live turns (62%)** — burst threshold `>6`
   (median 3) plus dense non-discovery phase-leads. It only drops the page count
   11 → 6, not an order of magnitude, and reads as a thinned turn table rather
   than a session you can *understand* by skimming.

The fix is a small interface change (one `view` selector replacing two awkward
booleans) plus three render upgrades: dates, a paginated phases overview, and a
significance-ranked **day-grouped milestone digest** that lets a reader recover
the whole session arc from the milestone view alone.

### Empirical basis (S5233, full session)

| Signal | Measured | Source |
|---|---|---|
| Span | 2026-05-26 15:51 → 06-06 17:48, 11 days, gaps incl. `+48h 22m` after T72 | turn `created_at_epoch` |
| Phases | 164 (≈1.9 turns/phase); type histogram 🔵82 🟣63 ⚖️55 🔴28 change21 🔄3 ⏸1 | `segmentPhases` |
| Current milestone keep-rate | 159/256 live (62%) | replicated `selectMilestoneTurns` |
| `discovery` is a catch-all | 87 (top bucket); absorbs research / analysis / data-confirm / diagnosis / prior-art | turn `type` + titles |
| `decision` ledger is lossy | `sessions.decision[]` (≤6, append/tighten) holds only late dyad-stage decisions; early pivots (dual-MemE T26, Route A T83, two-objective T119, dyad T209, reversal T58) tightened out | `sessions.decision` |
| Title spec | `query-session.ts:275`: "5-15 words summarizing the turn's outcome" — no verb/keyword/format convention; the `Reversed…/Fixed…/P=100%` regularities are **emergent** | extraction prompt |
| Tags populated | 2536/3521 turns tagged (72%), 12,324 instances, 4,824 distinct | `turns.tags` |
| Reserved-tag precedent exists | `invalidated:*` (47+), `compact:*` (8+) are code-written namespaced tags; `source:*` is read by `extractSourceTags` but never written (vestigial) | `turns.tags`, `timeline.ts:387` |
| Reversal vocabulary is emergent + collides | `reversal` 3, `superseded` 1, `design-pivot` 2, `pivot` 1 (real reversals) vs `rollback*` 90+ (mostly topic: "building rollback") | `turns.tags` |

## Goals

- Replace the `milestones` / `phases` booleans with a single `view` enum:
  `turns` (default) · `milestones` · `phases`.
- Make every view date-legible across multi-day spans (header end-date,
  day-divider rows, per-page date anchor).
- `view="phases"` becomes a standalone, paginated overview with a lead title per
  phase — not a block appended to the turn table.
- `view="milestones"` becomes a significance-ranked, day-grouped digest a reader
  can skim to recover the session arc; it does **not** re-render the
  `decision[]`/`done[]` ledger (already injected at SessionStart).
- Mark decision **reversals** (↩️) and **invalidated** turns (🚫) from existing
  signals, without growing the `type` enum or constraining title prose.
- One pageSize constant (`30`) applied per-view to its own list.

## Non-goals

- `buildTimelineView` **does** change: it becomes view-aware and paginates the
  per-view list (turns / milestones / phases) so `page`/`pageCount` are correct
  for each (D2a). `resolveWindow` and the window-resolution math are untouched.
- No new turn `type`. The 7 (`bugfix | feature | refactor | change | discovery
  | decision | compact`) stay fixed (a "reversal" is a *relation*, not a kind of
  work — see D7).
- No fixed/controlled reversal **word** and no title-format convention (both
  rejected as too rigid). Tag *values* stay free; only their *style* is guided
  (D8).
- No general tag sampling/normalization pipeline this round — milestone reversal
  detection uses a seeded synonym cluster. The corpus-wide canonical-concept map
  is a **follow-up** (see Follow-up).
- No change to `recall`, `remember`, or session-summary fields.

## Decisions

### D1 — `view` enum replaces the two booleans

```
timeline(id, view?, page?, pageSize?)
  view ∈ "turns" (default) | "milestones" | "phases"
```

| view | renders | paginates over |
|---|---|---|
| `turns` (default) | header + full turn table (all **non-skipped** rows; `undone` struck-through) + shape signals; **no phases** | non-skipped rows |
| `milestones` | header + significance-ranked, day-grouped digest + signals | selected milestone turns |
| `phases` | header + phases overview (lead title per phase) + signals; **no turn table** | phases |

The `milestones` and `phases` boolean params are **removed** from the schema.
This is a breaking change to the MCP surface, but both internal callers are
ours (SessionStart, the handler) and the SKILL is updated (Docs). The combined
"turns + phases" view is intentionally dropped (one form per call).

### D2 — One pageSize, applied per-view

`DEFAULT_TIMELINE_PAGE_SIZE` stays **30**, applied to whichever list the view
renders: non-skipped rows (`turns`, `undone` kept), the milestone set
(`milestones`), phases (`phases`). This fixes the current wart where `milestones` paginated over the
full 316-turn set and merely blanked rows within each page — `view="milestones"`
on S5233 goes from 11 pages to ~2.

`30` is kept (not lowered to recall's `10`): a timeline row is one compact
pipe-delimited line (~70 chars, ~550 tok/page), unlike recall's multi-line
items. Lowering it would make a ~300-row session ~30 pages (the exact count is
over **non-skipped** rows, not the raw turn total — S5233's 316 turns minus its
skipped rows).

**D2a — view-aware pagination (where the page math lives).** Today
`buildTimelineView` paginates `windowTurns` and returns turn-level
`pageTurns`/`pageCount` (`timeline.ts:817-824,855-858`). That is wrong for
`milestones` (page count must be over the milestone set) and `phases` (over
phases). `buildTimelineView` therefore takes the `view` and computes the
view's paginated list + `pageCount` from it:

| view | paginates | `pageCount` denominator (`viewItemTotal`) |
|---|---|---|
| `turns` | non-skipped rows of `windowTurns` (`undone` kept, struck-through) | non-skipped row count |
| `milestones` | the selected milestone set (D7) over `windowTurns` | milestone count |
| `phases` | `segmentPhases(windowTurns)` | phase count |

(`turns` deliberately excludes `skipped` only — matching the existing render,
which skips `skipped` rows but renders `undone` (`timeline.ts:1005,1034`). The
`milestoneCandidateTurn` live/invalidation rules (D7) apply to `milestones`
**only**, not to the `turns` page list.)

**Gap is computed over the full chronological sequence, not the paginated list.**
Today the renderer keeps `skipped` turns *in the loop* and advances `prevEpoch`
*before* skipping them (`timeline.ts:997,1000,1005`), so a visible row's gap is
the delta to its true chronological predecessor — e.g. `T21`'s gap is `+50s` to
the skipped `T20`, **not** `+60s` to the last *visible* row `T19`
(`timeline.test.ts:1467` pins this). Pre-filtering to non-skipped for pagination
must **not** change that: each rendered row carries a `previousChronologicalEpoch`
derived from the full `windowTurns` (skipped included), computed at build time, so
gaps stay identical. `viewItemTotal`/`pageSize` count non-skipped rows; gaps read
the full sequence. The same holds across a page boundary (the first row of page N
gaps to the chronological turn before it, even if that turn is on page N−1 or is
skipped).

Selection/segmentation thus happens at view-build time (not only at render), so
`selectMilestoneTurns` and `segmentPhases` move (or are also called) inside
`buildTimelineView`. `TimelineView` gains, alongside `pageTurns`:

- **`view`** — the single source of truth for which view this is. It lives on
  `TimelineInput` → `TimelineView` **only**; `RenderTimelineOptions` does **not**
  carry it and `renderTimeline` does **not** take it as an option (it reads
  `view.view`). This avoids the build-time/render-time mismatch where a caller
  could build a `turns` view yet ask `renderTimeline` for `milestones`.
- **the per-view paged list** — `pagedMilestones` / `pagedPhases` beside
  `pageTurns`; render consumes the one matching `view.view`.
- **`viewItemTotal: number`** and **`pageAnchorEpoch: number | null`** — the
  view's total item count and the `created_at_epoch` of the page's first row, so
  `formatShowingLine` reads per-view totals/anchors instead of
  `windowTurns.length` (`timeline.ts:961-966`, which has neither today). The D3
  `showing:` line (`… page p/N (viewItemTotal) · <date(pageAnchorEpoch)>`) is
  built only from these fields. **The existing single-page omission is kept**:
  `formatShowingLine` renders **only when `viewItemTotal > pageSize`** (multi-page)
  — exactly when the reader has paged away from the header and needs the anchor.
  A single-page or empty view emits **no** `showing:` line at all (preserving
  `timeline.ts:961` and the "omits the showing line when it fits on one page" test
  at `timeline.test.ts:1190`). So `pageAnchorEpoch === null` (empty list) never
  reaches rendering; it is defensive only. A phase's anchor epoch is its lead
  turn's `created_at_epoch` (D6).

`resolveWindow` is unchanged.

**Selection scope = `view.windowTurns`, not literally the whole DB.** Milestone
selection and phase segmentation operate on `windowTurns` (the range-resolved
slice). For interactive `timeline(id="S<n>")` with no range that equals the full
session; for a range query (`S12/T100..200`) it is that slice; for SessionStart
it is the last-30 window (D10). The prose word "session-wide" in D5/D7 means
"over `windowTurns`", which is the whole session only in the no-range case.

### D3 — Date legibility (applies to **all** views)

1. **Header end-date** (all views). `2026-05-26 15:51 → 2026-06-06 17:48 (265h
   57m, …)` — the end gains its date when it differs from the start's.
2. **Day-divider rows** (`turns` + `milestones`, which render per-turn rows). When
   consecutive rendered rows cross a local calendar day, insert a divider before
   the first row of the new day: `── 2026-05-29 Fri · +48h 22m idle ──`. The next
   active day is shown (empty days are not printed — S5233 jumps 05-27 → 05-29,
   skipping 05-28).
3. **Per-phase date** (`phases`). Phase rows are not turns, so each phase row
   carries a **date** column: its start date when the phase stays within one day
   (`05-31 Sun`), or **`start→end`** when the phase itself spans days
   (`05-31→06-01`) — a long phase (e.g. `~20h 55m`) must show *both* ends, not
   just the start. A day-divider is also inserted when consecutive phases cross a
   day. This needs `Phase` to gain `startEpoch`/`endEpoch` (D6) — `segmentPhases`
   currently keeps only prompt range + duration (`timeline.ts:79,458,489`).
4. **Per-page date anchor** (all views, **multi-page only**). When the view
   spans more than one page, the `showing:` line carries the date of the page's
   first item: `showing: turns · page 3/N (viewItemTotal) · 2026-05-27 Wed`
   (`N`/`viewItemTotal` per D2a). A reader who lands mid-list on page 5 is never
   date-blind. A single-page view emits no `showing:` line (D2a); its header
   end-date + day-dividers already carry the dates.

Local timezone is the existing `tz` (`+08:00` here). Pure render; the only
data-model touch is `Phase.startEpoch`/`endEpoch` (derived, not persisted).

### D4 — `view="turns"` (default)

Current default minus the phases block: header + the full turn table (paginated)
+ shape signals, with D3 dates. This is the on-demand temporal axis. The page
list is **all non-skipped rows** of `windowTurns` — `skipped` turns are omitted
(as today), `undone` turns are still rendered (struck-through, as today). It does
**not** use `milestoneCandidateTurn` (that is milestones-only). So `viewItemTotal`
for `turns` is the non-skipped row count, not the 256 "live" count nor the 316
all-turns count.

### D5 — `view="milestones"` is a significance digest, not a thinned table

The milestone set is selected over `view.windowTurns` (D7; "session-wide" in the
no-range case per D2a), **rendered strictly in prompt order** as a flat list with
D3 day-divider rows inserted on day changes (so it reads day-grouped chronologically),
paginated over the selected set (D2). The `decision[]`/`done[]` ledger is **not**
re-rendered here — it is already in the SessionStart injection and in
`recall(id="S<n>")`; this view supplies the chronological arc the ≤6-bullet ledger
compresses away.

Day-divider rows are mechanical (date · range · gap). There is **no
LLM-generated per-day prose synthesis** — the renderer is deterministic string
assembly; the selected turn titles are the synthesis.

**Per-day density (handling a heavy day).** Within a day, render **all Tier-1**
milestones (D7) — a day with many real decisions/ships shows all of them; that
volume is genuine signal and is bounded only by pagination (D2), never
truncated. **Tier-2** turns (fix resolutions, qualifying discovery) are
soft-capped at `MILESTONE_TIER2_PER_DAY` (default **4**) per day.

**Selection order vs render order are separate.** To *choose* which Tier-2 turns
survive the cap, rank a day's Tier-2 candidates by a deterministic significance
score — `(typeRank: bugfix-resolution > discovery, then toolCallCount desc, then
promptNumber asc)` — and keep the top `MILESTONE_TIER2_PER_DAY`. The kept turns
are then *rendered* back in plain prompt order, interleaved with Tier-1, so the
digest stays chronological (matching today's prompt-order render at
`timeline.ts:812,997`). When a day's Tier-2 overflows, the elided count is shown
explicitly — never silently — as a trailing hint that points at the drill-down:

```
   … +6 more fixes/notes this day → timeline(id="S5233", view="turns") @ T140–T176
```

This is the no-silent-cap rule: the spine is complete, the secondary tail is
summarized with a count and a one-call path to the full set. The cap is a
constant, not a parameter (YAGNI); raise it only if real sessions show it
clipping signal.

**The overflow data must be modeled, not recomputed at render.** The capped-out
Tier-2 candidates are dropped from the kept set, so the renderer cannot
reconstruct the `+N`/range. `selectMilestoneTurns` therefore returns a structured
result — `{ kept: KeptMilestone[], overflowByDay: { date, count, firstPrompt,
lastPrompt, kind }[] }` — where each `overflowByDay` entry carries exactly what
the hint line needs (count, the `T<first>–T<last>` drill range, and the kind,
e.g. "fixes/notes"). The renderer emits one day-footer line per `overflowByDay`
entry. **Overflow-hint lines are footers, not items**: they are **not** counted
in `viewItemTotal` and do **not** consume `pageSize` — only `kept` milestones
paginate. (An overflow entry whose day is split across a page boundary renders
its hint on the page that holds that day's last kept row.)

### D6 — `view="phases"` is a standalone paginated overview

Header + phases list, paginated over phases (D2), `view.windowSignals` appended.
`Phase` gains `startEpoch`/`endEpoch` (captured in `segmentPhases` from the first
/ last turn's `created_at_epoch`). Each phase row gains a **date** column (start
date, or `start→end` when the phase spans days, D3) and a **lead title** (the
title of its `startPromptNumber` turn), so the overview reads as a dated
narrative skeleton, not bare colored runs:

```
#  date          type         turns      span     work          lead title
1  05-26 Tue     🔵 discovery  T3-T7      ~1h 17m  📖1 🔧71      NPC/Fuxi industry research
66 05-30→05-31   🟣 feature    T134-T136  ~20h 55m 📖5 ✏️3 🔧23  char_library rebuild
```

(Phase 66 spans the night of 05-30→05-31 — the `start→end` form makes the
cross-day visible, which a bare `05-30 Sat · ~20h 55m` would hide.
`pageAnchorEpoch` for this view is the page's first phase's `startEpoch`.) No
turn table in this view.

### D7 — Milestone selection: session-wide, two-tier significance

Replace the per-page `selectMilestoneTurns(pageTurns, …)` with a selector over
`view.windowTurns` (D2a), deterministic and rule-based (the renderer cannot call
an LLM).

**Candidacy ≠ liveness.** Do **not** reuse `isTimelineLiveTurn`
(`timeline.ts:1110`, which drops `undone` *and* `skipped`). Define a separate
`milestoneCandidateTurn(turn)`:

- `skipped` turns are never candidates (no signal).
- an **invalidated** turn (`status==="undone"`, `was_rolled_back`,
  `was_interrupted`, or an `invalidated:*` tag) is a candidate **only if
  `type==="decision"`** — a killed decision is worth showing (marked 🚫, D9); a
  killed non-decision is dropped.
- otherwise, a live turn is a candidate.

A candidate qualifies in one of two tiers:

**Tier 1 — the spine (always kept, never capped):**

- **`type === "decision"`** — design / selection / scoping / finalization /
  reversal. Adjacent decision runs are *not* collapsed.
- **`type` ∈ {`change`, `feature`, `refactor`}** with non-empty `files_modified`
  — a deliverable.
- **`type === "compact"`** — context boundary.
- the window's **first** and **last** candidate turn — the goal and current
  state when the window is the full session (no-range); for a range/last-30
  window these are the window's endpoints (the session goal still lives in the
  header + ledger, so nothing is lost).

**Tier 2 — supporting detail (kept, but density-capped per D5):**

- **`type === "bugfix"`** — collapse an adjacent same-type bugfix run to its
  **last** turn (the resolution); that resolution is Tier 2.
- **`type === "discovery"`** — only when it is a phase-lead **and**
  (`toolCallCount > windowSignals.toolBurstThreshold` **or** the next candidate
  turn is a **non-invalidated** `decision`). Keeps consequential analysis
  (deep-research / cost probes that drove a *surviving* decision), drops routine
  Q&A — the catch-all problem from the empirical basis. Burst threshold is
  re-scanned per the existing F2 rule, never reusing the top-3-truncated
  `windowSignals.toolBursts`.

  **Adjacency excludes invalidated decisions.** A `discovery → undone decision`
  pair does *not* pull the discovery in via adjacency: an `undone`/`was_rolled_back`
  decision is a dead branch, so the analysis that fed it is not milestone-worthy
  on that basis (it can still enter via its own burst). The undone decision
  itself is independently a candidate and renders 🚫 (D9), so the dead branch is
  not hidden — only the upstream discovery is not resurrected by it.

The two-tier split is what makes a heavy day legible: a day full of *decisions
and ships* shows all of them (Tier 1 is uncapped — that volume is the signal,
bounded only by pagination), while a day full of *small fixes* is capped to its
top few with an overflow hint (D5). Tier 1 is never silently dropped.

Implement as pure helpers `milestoneCandidateTurn(turn): boolean` and
`selectMilestoneTurns(view)` (signature changes from per-page to whole-window),
unit-testable in isolation. `selectMilestoneTurns` returns the **structured**
result `{ kept: KeptMilestone[], overflowByDay: OverflowHint[] }` — each
`KeptMilestone` carrying its turn, tier, and invalidation flag; each
`OverflowHint` carrying `{ date, count, firstPrompt, lastPrompt, kind }` for the
day-footer line (D5). The capped-out candidates are not in `kept`, so this is the
only place their count/range survives.

### D8 — Reversal ↩️: free tag value, guided style, seeded cluster match

A decision reversal is **not** a new `type`, **not** a fixed word, **not** a
title convention. It is a free-text **tag**, matched at render time:

- **Extraction prompt (`query-session.ts:279`)** gains one tag-style line.
  Values stay free; the style is: **short, stable, the most common/conventional
  term — reuse an existing concept stem rather than coining a variant** (the
  `sft-data / sft-design / sft-target-design / sft-pipeline` and
  `dyad-detection / dyad / dyad-assembly` sprawls are the anti-pattern). And:
  *when a turn overturns an earlier decision, include a tag conveying that.*
- **Reader** marks ↩️ when `type === "decision"` **and** any tag is in a seeded
  reversal cluster: `reversal`, `reversed`, `superseded`, `supersede`,
  `reframed`, `reframe`, `design-pivot`, `pivot`. The `type === "decision"` gate
  neutralizes topic-word collisions (`reverse-kl`, a turn *about* rollback) ≈
  fully.
- **The cluster deliberately excludes `rollback` / `rolled-back`.** Those words
  belong to the *invalidation* axis (the `was_rolled_back` column / `invalidated:*`
  tag, D9), not the *reversal* axis. Keeping them out of the reversal cluster is
  what stops one rolled-back turn from firing both ↩️ and 🚫 (see D9 precedence).

Best-effort on pre-change turns (emergent vocabulary); reliable on post-change
turns once the agent tags consistently; canonical resolution deferred to the
Follow-up. Implement reader as `extractReversalFlag(turn): boolean`, sibling to
`extractSourceTags`.

### D9 — Invalidated 🚫: from existing real signals

A turn is invalidated when `was_rolled_back` / `was_interrupted` is set,
`status === "undone"`, or it carries an `invalidated:*` tag. Such a turn enters
the digest only if it is also a `decision` (the `milestoneCandidateTurn` rule,
D7) and is marked 🚫. This is the honest use of those columns — a distinct axis
from D8's reversal (`was_rolled_back=0` on the real reversal T58 proves the two
are independent).

**Precedence when both could apply.** A turn can be both invalidated (🚫) and
carry a reversal-cluster tag (↩️) — e.g. T289 (`was_rolled_back=1`, title "Rolled
back: …"). **🚫 wins; render only 🚫, never both glyphs.** An invalidated turn is
a dead branch; that it also described a pivot is secondary. (D8 already keeps
`rollback`/`rolled-back` *out* of the reversal cluster, so this collision only
arises if the agent additionally tags such a turn with a genuine reversal word.)

### D10 — SessionStart renders `view="milestones"`

The `milestones`/`phases` options are gone. Instead **SessionStart** passes
`"milestones"` **explicitly** to `buildContextTimelineView` (whose default stays
`"turns"`, so no other caller is affected — D2/plumbing §4); the builder forwards
it into `buildTimelineView`. The existing `renderTimeline(timelineView, {
promptCap, showEarlierHint })` call (`session-output.ts:60`) keeps its options
unchanged — the view rides on `timelineView`, not on the render options. Behavior
is the milestone digest + signals, now date-legible.

**SessionStart keeps its last-30 window** (`buildContextTimelineView`,
`timeline.ts:890,893`). The injected digest is therefore the **recent** milestone
arc, not the full session — selection runs over that 30-turn `windowTurns` (D2a).
This is deliberate: the full-arc summary is already injected as the
`decision[]`/`done[]` ledger, so the embedded timeline need only show recent
shape, and injection cost stays bounded. The **full milestone arc** is available
on demand via `timeline(id="S<n>", view="milestones")` (no range → whole-session
window). `showEarlierHint` still points further back.

## Parameter plumbing

1. **`src/mcp/definitions.ts`** — `timelineInputShape` drops `milestones` /
   `phases`, gains `view: z.enum(["turns","milestones","phases"]).optional()`.
   Schema stays `.strict()`. Update `MNEMO_TOOL_DESCRIPTIONS.timeline`.
2. **`src/mcp/handlers.ts`** — `timeline` handler reads `args.view` and forwards
   it (replacing the two boolean reads at `:70-71`).
3. **`src/mcp/timeline.ts`**
   - `RenderTimelineOptions`: drop `milestones?`/`phases?`. Do **not** add
     `view` here — `view` is single-sourced on `TimelineInput`/`TimelineView`
     (D2a). `renderTimeline` reads `view.view`, never an option, so a built view
     and its render can never disagree.
   - `buildTimelineView(db, input)` — becomes view-aware (D2a): read `input.view`
     (default `"turns"`), paginate the view's list (non-skipped rows / milestone
     set / phases), and set `pageCount`, `viewItemTotal`, `pageAnchorEpoch` from
     it. `TimelineView` gains `view`, the per-view paged list (`pagedMilestones` /
     `pagedPhases`) beside `pageTurns`, `viewItemTotal`, and `pageAnchorEpoch`.
     `resolveWindow`/`windowTurns` unchanged.
   - `milestoneCandidateTurn(turn)` — new, per D7 (live OR invalidated-decision).
   - `selectMilestoneTurns(view)` — rewrite per D7 (over `windowTurns`, two-tier,
     per-day Tier-2 score-then-cap). Returns the structured `{ kept,
     overflowByDay }` (D5/D7); only `kept` feeds pagination + `viewItemTotal`,
     `overflowByDay` rides along for footers.
   - `extractReversalFlag(turn)` — new, per D8 (cluster ∧ `type==="decision"`).
   - `renderTurnTable` — emit D3 dividers/anchor; in `milestones` view consume
     the paged `kept` set, render prompt-ordered, mark ↩️ (D8) / 🚫 (D9, 🚫 wins),
     and emit one Tier-2 overflow **footer** per `overflowByDay` entry (D5; not
     counted in `viewItemTotal`/`pageSize`).
   - `segmentPhases` — capture `startEpoch`/`endEpoch` on each `Phase` (from the
     first/last turn's `created_at_epoch`); `Phase` type (`timeline.ts:79`) gains
     both (D3/D6).
   - `renderPhases` — add lead title + per-phase start date / day marker (D6);
     consume `pagedPhases` when `view==="phases"`; in `phases` view it is the body
     (no turn table).
   - `renderTimeline(view, options)` — dispatch on **`view.view`** (not an
     option): `turns`→table+signals; `milestones`→digest+signals;
     `phases`→phases+signals. `formatShowingLine` reads `view.viewItemTotal` /
     `view.pageAnchorEpoch`.
4. **`src/mcp/timeline.ts` (`buildContextTimelineView`) / `src/mcp/session-output.ts`**
   — `buildContextTimelineView(db, sessionId, view = "turns")` gains a `view`
   param **defaulting to `"turns"`** (today's call at `timeline.ts:893` passes no
   view; this helper is exported and other callers/tests expect a normal turn
   table — `timeline.test.ts:1403,1411` assert `T40 |` rows — so the default must
   **not** change). **SessionStart** is the one caller that passes
   `"milestones"` explicitly (`session-output.ts`). The builder forwards `view`
   into `buildTimelineView`. `session-output.ts:57,60` then calls
   `renderTimeline(timelineView, { promptCap, showEarlierHint })` with **no**
   `view` option — the view rides on the built `timelineView`, not the render
   options.
5. **`src/worker/query-session.ts:279`** — append the tag-style line (D8).

### Docs

- `plugin/skills/mnemo-timeline/SKILL.md` — replace `milestones`/`phases` with
  `view`; document the three views, the milestone definition, ↩️/🚫 markers.
- `README.md` — timeline param line.

## Test strategy

- **`selectMilestoneTurns`** (unit, whole-window): decisions → Tier 1; bugfix
  run collapses to its last (Tier 2); deliverable `change`/`feature`
  (files_modified) → Tier 1; routine `discovery` excluded but a phase-lead
  discovery feeding a **live** decision → Tier 2; first + last always Tier 1;
  burst-qualified discoveries are **eligible before the per-day Tier-2 cap**.
  The F2 guard is only "do not reuse the top-3-truncated
  `windowSignals.toolBursts`"; it is **not** "keep every burst regardless of
  D5's cap."
- **discovery → undone decision** (unit): the decision renders (🚫); the
  preceding low-tool phase-lead `discovery` is **excluded** (adjacency does not
  count an invalidated decision); the same discovery *is* kept if it independently
  exceeds the burst threshold.
- **`milestoneCandidateTurn`** (unit): an `undone` **decision** is a candidate;
  a `was_rolled_back` **decision** is a candidate; an `undone`/`invalidated:*`
  **non-decision** is excluded; a `skipped` turn is never a candidate; a plain
  live turn is a candidate.
- **per-day density** (selector + render): `selectMilestoneTurns` returns a day
  with 8 Tier-1 decisions fully in `kept` (no cap) and a day with 10 Tier-2 fixes
  as 4 in `kept` + one `overflowByDay` entry `{ count: 6, firstPrompt, lastPrompt,
  kind }`; the rendered footer `+6 more … @ T..–T..` matches; the 6 overflow turns
  are **not** in `viewItemTotal` and do not shift `pageCount`; no day silently
  drops a Tier-1 turn. Add the same cap fixture for discovery bursts: 5 same-day
  burst-qualified discoveries produce 4 kept + 1 overflow entry, while bursts
  spread across two days are capped independently per day.
- **Tier-2 select-vs-render order**: given Tier-2 candidates where the
  highest-score one has a *later* prompt number, the cap keeps it (score) yet the
  rendered output lists kept Tier-2 turns in ascending prompt order (chronology),
  interleaved with Tier-1.
- **`extractReversalFlag`** (unit): cluster word on a `decision` → true; same
  word on a `feature` → false (gate); topic tag `reverse-kl` on a non-decision →
  false; `rolled-back`/`rollback` is **not** in the cluster (→ false even on a
  decision).
- **↩️/🚫 precedence**: a `decision` that is both `was_rolled_back` **and**
  tagged `reversal` renders 🚫 only (not ↩️, not both).
- **date render**: header gains end-date only when day differs; day-divider
  appears on a crossing and names the next active day (05-27 → 05-29 shows
  `2026-05-29`, not 05-28); on a multi-page view the `showing:` anchor = page's
  first-item date.
- **gap preserved under non-skipped pagination**: a `skipped` `T20` between `T19`
  and `T21` is excluded from the page list / `viewItemTotal`, yet `T21`'s rendered
  gap is `+50s` (to `T20`), not `+60s` (to `T19`) — i.e. gaps read the full
  chronological sequence, not the paginated rows (`timeline.test.ts:1467` must
  still pass).
- **phases date legibility**: `segmentPhases` populates `startEpoch`/`endEpoch`;
  a same-day phase shows its start date; a **phase spanning a day shows
  `start→end`** (single-phase cross-day fixture); consecutive phases crossing a
  day get a divider; the `phases` `showing:` anchor = first phase's `startEpoch`.
- **`showing:` single-page omission**: a view with `viewItemTotal ≤ pageSize`
  (incl. an empty list) emits **no** `showing:` line at all
  (`timeline.test.ts:1190` stays green); the line + date anchor appear only when
  multi-page.
- **`buildContextTimelineView` default**: called with no `view`, it still renders
  a plain turn table (`T40 |` rows, `timeline.test.ts:1403,1411` stay green);
  only SessionStart's explicit `"milestones"` yields the digest.
- **`view` dispatch**: `turns` = table+signals, no phases; `milestones` =
  filtered digest, no full table, ↩️/🚫 present on seeded fixtures; `phases` =
  phases+lead-title+signals, no turn table; each paginates over its own list
  (milestone fixture: keep-set/30 pages, not turns/30).
- **schema/handler**: `view` enum accepted, unknown/old `milestones` key
  rejected (strict); `view` passes through.
- **SessionStart**: `session-output.ts` render emits the milestone digest, no
  phases block.

## Acceptance

- `timeline(id=…)` renders the turn table + signals with dates, no phases block.
- `timeline(id=…, view="milestones")` on the frozen S5233 fixture renders the
  **fixture-pinned page count** from the new D7 selector verifier (not the old
  159/256 keep-rate): significance-ranked, day-grouped turns; ↩️ on T58-class
  non-invalidated reversal decisions; 🚫 (not ↩️) on T289 /
  `was_rolled_back` decisions.
- `timeline(id=…, view="phases")` renders the paginated phases overview with lead
  titles and no turn table.
- A new reversal-tagged decision turn (post prompt-change) renders ↩️ in the
  milestone view.
- `bun test` green; `bun run typecheck` clean.

## Rollout

- Patch bump 0.2.26 → **0.2.28** across `package.json`,
  `plugin/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  (4 fields, per `project_version_bump_three_places`). **0.2.27 is taken by the
  hook-write-contention hotfix** (`2026-06-06-hook-write-contention-fix.md`),
  which ships first; this feature follows as 0.2.28.
- `node scripts/build.js`; worker/MCP pick up on next `/plugin` reload.

## Follow-up (separate spec)

**Tag sampling / normalization.** Sample the tag corpus (4.8K distinct), cluster
by stem / edit-distance / co-occurrence into canonical concepts
(`{dyad-detection, dyad, dyad-assembly} → dyad`; `{reversal, reversed,
superseded, design-pivot, reframed} → reversal` — keeping `rollback`/`rolled-back`
on the *invalidation* axis, not reversal, per D8/D9), and maintain a concept map. It replaces
D8's seeded reversal cluster, can revive a `tag:` facet in `recall`/search
(removed with durable memory, `recall.ts:1146`), and benefits retrieval beyond
timeline. Out of scope here to avoid blocking the view work on a corpus pipeline.

## Appendix — Reproduction of the empirical basis

Figures in *Empirical basis* are from the **live** DB
(`~/.claude-mnemo/claude-mnemo.db`, read-only) **as of 2026-06-06** — it is
mutable, so re-runs drift as new turns extract. To distinguish an algorithm
regression from data drift, re-run these and compare, or freeze S5233 into a
fixture. (`sqlite3 -readonly ~/.claude-mnemo/claude-mnemo.db "<query>"`.)

```sql
-- Span (first/last turn, local +08:00)
SELECT datetime(MIN(created_at_epoch),'unixepoch','+8 hours'),
       datetime(MAX(created_at_epoch),'unixepoch','+8 hours')
FROM turns WHERE session_id=5233;

-- Type distribution (discovery-is-catch-all; per-session)
SELECT type, COUNT(*) FROM turns WHERE session_id=5233 AND type IS NOT NULL
GROUP BY type ORDER BY COUNT(*) DESC;

-- Current milestone keep-rate replication (non-discovery phase-lead ∪ burst>6 ∪ compact)
WITH live AS (
  SELECT prompt_number, type, COALESCE(tool_call_count,0) tc,
         LAG(type) OVER (ORDER BY prompt_number) prev
  FROM turns WHERE session_id=5233 AND type IS NOT NULL
    AND status NOT IN ('skipped','undone'))
SELECT COUNT(*) live,
       SUM((type!='discovery' AND (prev IS NULL OR type!=prev)) OR tc>6 OR type='compact') milestones
FROM live;

-- New-selector page-count guard (must be fixture-pinned before implementation
-- is accepted). The old keep-rate query above is only a baseline for the
-- existing algorithm; it does not prove the D7 page count. At minimum, record:
--
--   kept_total, tier1_total, tier2_kept_total, overflow_total, page_count
--
-- using the D7 selector over the frozen S5233 fixture. Do not keep the earlier
-- "≤ ~2 pages" target unless this verifier actually proves it: Tier 1 is
-- uncapped by design, so real sessions with many decisions/ships can legitimately
-- exceed two pages while still being a digest.

-- Tag population + reserved-prefix + reversal vocabulary
SELECT COUNT(*) total, SUM(tags NOT IN ('','[]') AND tags IS NOT NULL) tagged FROM turns;
SELECT je.value, COUNT(*) n FROM turns t, json_each(t.tags) je
  WHERE je.value LIKE '%:%' GROUP BY je.value ORDER BY n DESC;   -- invalidated:* / compact:* / (no source:*)
SELECT je.value, COUNT(*) n FROM turns t, json_each(t.tags) je
  WHERE je.value LIKE '%revers%' OR je.value LIKE '%roll%' OR je.value LIKE '%pivot%' OR je.value LIKE '%supersed%'
  GROUP BY je.value ORDER BY n DESC;
```

Phase count (164) and the type-emoji histogram are read from the live
`timeline(id="S5233")` output (the `segmentPhases` result), not a SQL query.
