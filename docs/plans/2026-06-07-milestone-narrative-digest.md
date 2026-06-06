# Milestone narrative digest (cluster-fold + title-only)

**Status:** approved design (rev 2: Codex review × 4 rounds + S1730 regression passes), plan pending — default config measures **~16%** retention (band 12–18%; exact value drifts as the live S1730 grows)
**Date:** 2026-06-07
**Scope:** `timeline()` `view="milestones"` selection (`selectMilestoneTurns`) and render (`renderMilestoneDigest`) + the SessionStart embed. **Supersedes the milestone parts of `2026-06-06-timeline-view-enum.md` — D5, D7, D8, D9.** The `turns` and `phases` views, the `view` enum (D1), pageSize (D2/D2a), date legibility (D3), and "SessionStart renders milestones" (old D10) are **unchanged**.

## Motivation

The shipped `view="milestones"` keeps **~60% of live turns** and renders them as the flat `turns` table with day dividers. For this project's dominant session shape — spec-hardening + Codex-review ping-pong — that is not a digest: it is half the session, reproduced as a wide table that still carries the raw user prompt. It fails the view's stated purpose (T322): *"只看里程碑里的关键信息就能快速准确了解整个 session."*

Two root causes, both empirical (see below):

1. **Tier-1 is uncapped and dominated by the bulk types.** `decision` (all) + file-touching `change`/`feature` are kept with no ceiling and no folding, so iterative refinement of one thread (10 consecutive `decision` turns; 6 consecutive `change` turns) lands as 10 / 6 separate milestones.
2. **The layout is the turn table.** It spends its width on the user prompt (100 chars) and `line/time/gap/stats` columns — turn-table metadata that is noise in a narrative digest — and truncates the title (the one column that carries the story) to 37 chars.

This spec replaces the selection model (uncapped Tier-1 → **cluster folding + significance + per-day budget**) and the render (turn table → **day-grouped, title-only narrative**), targeting **~12–18% retention** that reads as the project's arc end-to-end.

### Empirical basis

Source DB `~/.claude-mnemo/claude-mnemo.db`, as-of 2026-06-06. Two scopes, kept separate (a Codex-review finding: rev 1 conflated them). **S1730 is a live, still-growing session** — these are as-of snapshots and drift turn-by-turn (non-skipped 301→303 across this design session alone), so they are descriptive only; acceptance binds to a **frozen fixture**, not live S1730 (Codex finding #4).

**S1730-local** — the worked example: **301** non-skipped turns, **0** `undone`, **0** `was_interrupted`, **297** `extracted`+titled.

| Signal | Measured | Source |
|---|---|---|
| Current milestone keep-rate | **177 / 301 ≈ 59%** | replicated `selectMilestoneTurns` |
| Tier-1 share of kept | **~152 / 177 ≈ 86%** uncapped (decision 69 + deliverable 82 + compact 1) | type counts |
| Iterative-refinement clusters | `decision` T17–T30 = **10 consecutive**; `change` T341–T347 = 6; many 4–5 runs | RLE over `type` |
| Title length | p50 **63**, p90 77, max 103; only **1.9%** ≤ 37 | `turns.title` |
| Reversal signal present | `was_rolled_back=1`: **2** (both `decision` → T201, T266); `undone`/`interrupted`: **0** | `turns` columns |

**Corpus-wide** — all 66 sessions.

| Signal | Measured | Source |
|---|---|---|
| Tags are mostly free-form topics | **4889 distinct**; only reserved namespaces `invalidated:*` (50 turns / 51 tag instances) and `compact:*` (9 turns / 18 tag instances); the rest are bare topic tags (beamer, sft, grpo…) → **search-only, not significance** | `turns.tags` |
| Reversal keyword cluster is near-dead | `reversal` 3, `design-pivot` 2, `superseded` 1, `pivot` 1 (~7 total) | `turns.tags` |
| Bare `rollback*` is ambiguous | `rolled-back` 64 + `rollback` 27 — **collides** with the rollback-detection *feature* topic (`decision` turns tagged `rolled-back` with `was_rolled_back=0`) | `turns.tags` |
| Reliable reversal signal | `was_rolled_back=1` by type: decision 34, discovery 23, (null) 19, change 8, feature 7, bugfix 4 (**95** total) | `turns` columns |
| `invalidated:*` tag is derived, never standalone | **50** turns tagged; **0** lack a boolean / `undone` → the tag carries nothing the booleans don't (basis for D5 dropping it) | `turns` |
| Outcome tags land on varied types | `ready-to-merge` 8, `approved` 6, `merged` 3, `finalized` 3, `shipped` 1 across decision/feature/change/bugfix; **3** sit on a **no-file** change/feature → they must be forced candidates (D1/D6) | `turns.tags` |

## Goals

- Milestone retention **~12–18%** (from ~60%); the digest reads as a coherent narrative top-to-bottom.
- **Drop the user prompt and all turn-table metadata columns** from the milestone render; spend the budget on the full title.
- **Day-grouped, indented narrative** layout with per-day range + kept-count and an overflow escape hatch.
- Marker semantics (🚫 / ↩️ / 🏁) driven by a **single canonical rule** over `status` + booleans (D5); the reversal-keyword cluster is gated off by default (knob #4); the `invalidated:` tag namespace is never read.
- Surface ship/merge milestones via a **high-precision outcome-tag** force-keep + 🏁 marker.

## Non-goals

- No change to `view="turns"` or `view="phases"`, or to the `view` enum / pageSize / date legibility (kept from 0.2.28).
- **No tag normalization / sampling** — still deferred to its own spec. This spec only *consumes* booleans + a fixed outcome allow-list; it writes no tags.
- No change to the extraction prompt, or to how titles/tags are written.
- No new DB columns (all signals already exist: `type`, `status`, `was_rolled_back`, `was_interrupted`, `files_modified`, `tags`).
- **No change to `isInvalidatedTurn` / `extractReversalFlag`** — they keep their current meaning for the `turns`/`phases` strike-through. Markers here come from a new milestone-local function (D5).

## Decisions

### D1 — Candidacy + significance score

Replaces the old Tier-1(uncapped)/Tier-2(capped) split. A window turn (`status != "skipped"`, **including** `undone`) is a **candidate** iff any of:

- it is a **marker turn** (🚫 / ↩️ per D5), or carries an **outcome tag** (D6), or is `compact`, or is a **window endpoint** (D4) — these are **always-keep** (score `∞`, never folded; D3 keeps them even when they overflow the day cap — they are *not* dropped by the budget, but they *do* sort into and count against the cap; see D3); or
- its **base score** > 0:

| Base score | Type |
|---|---|
| 4 | `decision` |
| 3 | `feature` / `refactor` **with** `files_modified` |
| 2 | `bugfix` |
| 1 | `change` **with** `files_modified` |
| 0 (not a candidate) | `discovery`; `feature`/`change`/`refactor` with **no** files modified |

`discovery` is excluded by default (the catch-all exploration bucket). One exception, **re-admission**: a `discovery` turn that is a phase-lead **and** bursts (`tool_call_count > 2 × session-median`, reusing `toolBurstThreshold`) is admitted as a **singleton survivor** at score 0.5 — it does **not** participate in run-folding (D2) and is subject to the day budget (D3).

**Outcome candidacy is independent of base score** (Codex finding #2): an outcome-tagged turn is always-keep *even if* its type is `discovery` or a no-file `change`/`feature`. Corpus has 3 such turns; without this they would be silently dropped before D6 could surface them.

Significance is used for two things: candidacy (above) and per-day **ranking** (D3). Always-keep turns sort to the top via score `∞`.

### D2 — Cluster folding (the core compression)

Compute folding over a **self-built run segmentation**, *not* `segmentPhases` (which skips `undone` turns and is not candidacy-aware — Codex finding #4):

1. Take `seq` = window turns with `status != "skipped"` (includes `undone`), ordered by `prompt_number`.
2. Segment `seq` into maximal runs of equal `type` (a non-candidate type like `discovery` still breaks a run, preserving distinct decision/change clusters).
3. For each run whose type ∈ {`decision`, `feature`, `change`, `refactor`, `bugfix`}, take its **foldable** members — defined as `base score > 0` **and not** always-keep (Codex finding #2) — and:
   - keep the **last** foldable member (the converged result), and
   - if the run type ∈ {`decision`, `feature`, `change`, `refactor`} **and** it has **≥ `FOLD_FIRST_MIN_RUN` (=4)** foldable members, also keep the **first** (the opening / question). **`bugfix` runs keep last only, regardless of length** — a consecutive bug-fixing streak's milestone is the final fix, not the first bug found (preserves the 0.2.28 collapse-to-last semantic; round-4 #1). This also matches test strategy #1.

**Always-keep turns** (D1: markers / outcome / compact / endpoints) are unioned in **separately** and are never folded away. **Re-admitted burst `discovery` is *not* always-keep** — it is a non-folded **budgeted** singleton (score 0.5, subject to the D3 cap); folding never touches it because `discovery` is not a folding run type. Excluding always-keep from `foldable` is what makes "they don't suppress a neighbour" algorithmic (Codex finding #2): if the last member of a `decision` run is itself an outcome/reversed turn, the fold still keeps the prior **converged** decision (last *foldable*), and the always-keep turn is added on top. This collapses T17–T30 (10 decisions) → 2 and T341–T347 (6 changes) → 1, the symmetric generalization of the bugfix "collapse-to-last" 0.2.28 already shipped.

**Knob #1 — `FOLD_FIRST_MIN_RUN`.** Lower = more openings retained; higher = leaner. Default 4.

### D3 — Per-day budget with adaptive cap

Group the surviving set (D2 folded ∪ D1 always-keep) by **local calendar day** (reuse 0.2.28 D3 date logic). Define **`daySurvivorCount`** = number of survivors that fall on that day, **after** folding, **before** the budget (Codex finding #8 — this is the cap denominator, named unambiguously). Within each day:

- `cap = min(MILESTONE_DAY_BUDGET_BASE + ⌊daySurvivorCount / MILESTONE_DAY_BUDGET_DIVISOR⌋, MILESTONE_DAY_BUDGET_MAX)` = `min(4 + ⌊n/8⌋, 7)`.
- Rank the day's survivors by `(significance desc, tool_call_count desc, prompt_number asc)`; always-keep (`∞`) sort first.
- Keep the top `cap`; then **force-keep any always-keep survivor beyond `cap`**.
- Collapse the remainder to **one** overflow line: `… +N more → view=turns @ T<lo>–T<hi>` (range = min/max `prompt_number` of the collapsed turns).

**Knob #2 — budget formula.** `4 + ⌊n/8⌋` capped at 7 keeps light days tight and lets the heaviest days breathe. Tune divisor / cap for the retention target.

### D4 — Endpoints

The **window's** first live turn and the window's last **titled** live turn are always kept (score `∞`) — *window*, not session (Codex finding #5: SessionStart uses a last-30 window, D9). When the window is the whole session (`timeline(id="S")`), these coincide with the session endpoints. Skip an untitled / provisional current turn when choosing the last endpoint; do **not** fall back to the prompt (that is a `turns`-view behavior).

### D5 — Marker: one canonical rule (supersedes 0.2.28 D8 + D9)

A single new function `milestoneMarker(turn) → "invalidated" | "reversed" | "outcome" | null`, evaluated in **precedence order** (Codex finding #1 — rev 1 stated the rule three inconsistent ways):

1. **🚫 invalidated** ⟺ `status == "undone"` **or** `was_interrupted == 1`. The turn's work is gone.
2. **↩️ reversed** ⟺ `was_rolled_back == 1` **and** not 🚫. A pivot worth showing — superseded but still recorded. (The seeded reversal-keyword OR is **off by default** — knob #4 — because the regression below showed it produces false positives.)
3. **🏁 outcome** ⟺ carries an `OUTCOME_TAGS` member (D6) **and** not 🚫/↩️.
4. otherwise `null`.

**🚫 / ↩️ inputs are `status` + booleans by default** (knob #4, off by default, may add **decision-gated** reversal-keyword tags to ↩️); **🏁 reads only `OUTCOME_TAGS`** (D6, rule 3). The `invalidated:` namespace is never read by any branch. Specifically:

- **Do not read the `invalidated:` tag prefix.** Audited corpus-wide: 50 turns carry an `invalidated:*` tag, **0** of them lack a boolean / `undone`, so the tag adds nothing — *and* it is harmful here, because the system writes `invalidated:notified:rollback` onto every `was_rolled_back` turn, so an `invalidated:`-prefix 🚫 clause would subsume ↩️ entirely. Booleans alone make ↩️ fire correctly (S1730: T201, T266) while 🚫 stays precise.
- The **reversal-keyword cluster** `{reversal, reversed, superseded, supersede, reframed, reframe, design-pivot, pivot}` is **defined but gated off** (knob #4). Rev-2 regression on S1730 showed it is collision-prone: of the 5 ↩️ it produced, **T201/T266** are real (`was_rolled_back`), **T64** is a real *semantic* pivot the boolean misses ("switched slicing to streaming", tagged `design-pivot`, `was_rolled_back=0`), but **T323/T324** are **false positives** — turns *discussing* reversal design ("reversal is a relation not a type"), tagged with the keyword as a topic. Until the deferred tag-normalization spec can separate "is a reversal" from "is about reversal", the OR stays off; ↩️ is boolean-only. When knob #4 *is* enabled, the keyword OR is **decision-gated** (`type == "decision"`, matching the existing `extractReversalFlag` at `timeline.ts:454` and the T324 "reversal is a relation" decision); this also drops the lone `discovery`-tagged-`reversal` turn in the corpus (Codex finding #5). Losing T64's badge is acceptable — it is still kept as a `decision` milestone and its title conveys the pivot. Bare `rollback*` is likewise **not** consumed (same collision).
- `milestoneMarker` is **separate from** `isInvalidatedTurn` / `extractReversalFlag`; those are untouched and keep driving the `turns`/`phases` strike-through.

### D6 — Outcome tag → force-keep + 🏁

Fixed, high-precision reserved allow-list (the ambiguous `milestone`, `done`, `locked` are **excluded** — `milestone` collides with the timeline-feature topic and even lands on a `discovery` turn; `done`/`locked` are generic / "scope locked"):

```
OUTCOME_TAGS = { merged, shipped, released, ready-to-merge, approved, finalized }
```

(~21 occurrences corpus-wide.) A turn carrying any of these is an **always-keep candidate** (D1, regardless of type/files), is **never folded** (D2), and renders the **🏁** marker in the front gutter (D7). The 4889 free-form topic tags are explicitly **not** used here — they remain `recall(tag:…)` search fuel only.

**Knob #3 — force-keep vs boost-only.** Force-keep can cluster (e.g. four "0.2.20 ready/merged" lines in one day). If that reads as redundant, demote to a ranking boost (still budget-capped). Default: force-keep.

### D7 — Render: day-grouped, title-only narrative (replaces turn-table reuse)

`renderMilestoneDigest` no longer calls the turn-row renderer. New layout:

```
── MM-DD Day · T<lo>–T<hi> · N kept ──────────────────
   <marker> T<n> <emoji> <title ≤ MILESTONE_TITLE_CAP>
   … +N more → view=turns @ T<lo>–T<hi>
```

- `<marker>` is a single front-gutter slot ∈ { `🚫`, `↩️`, `🏁`, two spaces }, precedence `🚫 > ↩️ > 🏁` (D5). The fixed-position gutter makes the left edge scannable (a column of `🏁` reads as "this day shipped"); a trailing badge would sit at a variable column and scan poorly. Collisions are rare (0 in S1730).
- Titles align because nothing trails them.
- **No** `line / time / gap / stats / prompt` columns — those are turn-table concerns.
- The `── … N kept ──` header carries date label, **full-day** prompt range, and **full-day** kept count; it **repeats** at a page break (D8).
- `MILESTONE_TITLE_CAP = 90` (the line is title-only; the 40→80 `TITLE_COLUMN_CAP` fix already landed for `turns`/`phases`). Truncation reuses `truncateText`.

### D8 — Pagination

Paginate over the **selected milestone count** (consistent with 0.2.28 D2a), `pageSize` default 30. A day group may span a page boundary; the **full-day** header (range + count) repeats on the continuation page, and the continued group is flagged so the renderer can mark it (e.g. `(cont.)`). **When a day's selected milestones span pages, the day's single overflow line (D3) attaches only to its final page slice** (`isFinalSliceForDay`) and is never duplicated on earlier slices — preserving the 0.2.28 `lastKeptPrompt` anti-duplication behavior (`timeline.ts:1283`; test `timeline.test.ts:1358`). (Day-as-page-unit is a possible future refinement; out of scope.)

## Parameter plumbing

- **`milestoneMarker(turn)`** — new pure function (D5); `isInvalidatedTurn` / `extractReversalFlag` are **left unchanged** (Codex finding #1).
- **`selectMilestoneTurns`** returns `{ kept, overflowByDay }` where each `KeptMilestone` gains `marker` (`"invalidated"|"reversed"|"outcome"|null`) and `score`, so the renderer needs no recomputation.
- **`buildTimelineView` builds `milestoneDayGroups` for the requested page** (Codex finding #3 — the current view keeps only `pagedMilestones` and discards the full kept set + per-day metadata). Each group carries: `date`, `label`, **full-day** `promptLo`/`promptHi`, **full-day** `keptCount`, the page's `rows`, a `continued` flag (set on continuation slices), an `isFinalSliceForDay` flag, and the day's **single** `overflow` hint attached **only** to the final slice (round-4 #2). Pagination slices over the flat ordered `kept` list but the day metadata is computed from the **full** kept set so a split day shows correct range/count on every slice and the overflow exactly once.
- **New constants** in `timeline.ts`: `MILESTONE_TITLE_CAP = 90`, `OUTCOME_TAGS` (set, D6), `REVERSAL_KEYWORD_TAGS` (existing cluster; **gated behind knob #4, default off** — `milestoneMarker` reads it only when enabled), `FOLD_FIRST_MIN_RUN = 4`, `MILESTONE_DAY_BUDGET_BASE = 4`, `MILESTONE_DAY_BUDGET_MAX = 7`, `MILESTONE_DAY_BUDGET_DIVISOR = 8`.

## Test strategy

1. **Cluster folding (D2):** a `decision` run ≥ 4 → keep first + last; a `decision` run < 4 → last only; a **`bugfix` run ≥ 4 → last only** (no first, unlike decision/feature/change/refactor); a `discovery` turn between two decision groups keeps them as separate runs; `undone` turn in a run still surfaces (always-keep) — pin counts.
2. **Candidacy (D1):** no-file `change`/`feature` and plain `discovery` excluded; file-touching ones admitted; burst `discovery` phase-lead re-admitted as a non-folded singleton; **outcome tag on a no-file `change` / on a `discovery` → still kept** (force candidate).
3. **Per-day budget (D3):** synthetic day with `daySurvivorCount ≥ 24` → `cap` grows to 7 then clamps; overflow line carries correct `+N` and `T<lo>–T<hi>`; always-keep turns survive beyond `cap`.
4. **Marker rule (D5):** `status=undone` → 🚫; `was_interrupted` → 🚫; `was_rolled_back=1, status=extracted` → ↩️; reversal-keyword tag **without** boolean → **no** marker (default, knob #4 off); with **knob #4 on**, a `decision` + reversal-keyword tag → ↩️ but a `discovery` + same tag → **no** marker (decision-gated, finding #5); both 🚫+↩️ eligible → 🚫; `invalidated:notified:rollback` tag with `was_rolled_back=1` → ↩️ (**not** 🚫); bare `rollback` topic tag alone → no marker.
5. **Outcome (D6):** `OUTCOME_TAGS` member → 🏁 + never folded + forced candidate; `milestone`/`done`/`locked` and arbitrary topic tags → no effect.
6. **Render (D7):** output has **no** `prompt →` / `| line |` columns; header format with full-day range + count; markers in front gutter with precedence; title rendered up to 90.
7. **Day-group plumbing (D8):** a day split across a page boundary shows the same full-day range + count on both pages, with `continued` set on the second; the day's overflow line appears **exactly once**, on the final slice (`isFinalSliceForDay`), never on the earlier slice.
8. **Retention guard:** on a frozen S1730-shaped fixture, kept/non-skipped ∈ [12%, 20%] (regression fence against re-inflation).

## Acceptance

- On a **frozen S1730-shaped fixture** (snapshot committed with the test — the live S1730 grows, Codex finding #4): `view="milestones"` keeps **12–18%** of non-skipped turns, renders day-grouped title-only, no prompt column. (Default config measured ~16% — 49/303 then 50/305 across re-measures as the live session grew.)
- Every **outcome-only** fixture turn (no 🚫/↩️) surfaces with 🏁; a turn that is *both* outcome and 🚫/↩️ shows the higher-precedence marker (D7) but is **still kept** — force-candidacy guarantees no eligible ship is dropped, even when its gutter shows ↩️/🚫.
- ↩️ fires on the fixture's `was_rolled_back` decisions; 🚫 fires on `undone` / `was_interrupted` fixture turns; precedence 🚫 > ↩️ > 🏁 holds; bare `rollback*` and topic `reversal` tags produce no false marker.
- `turns` / `phases` views, `isInvalidatedTurn`, `extractReversalFlag`, and all other 0.2.28 behavior unchanged; full suite + typecheck green.

## Open knobs (decide at plan time)

1. **`FOLD_FIRST_MIN_RUN`** (D2) — default 4.
2. **budget formula** (D3) — default `min(4 + ⌊n/8⌋, 7)`.
3. **outcome force-keep vs boost-only** (D6) — default force-keep.
4. **reversal-keyword OR in ↩️** (D5) — **default off** (collision-prone per rev-2 regression: T323/T324 false positives). Enable only after tag normalization.

Retention dial: leaner (knob #3 = boost-only, divisor = 10) ≈ 13%; richer (force-keep, divisor = 8) ≈ 18% on S1730. **Default config measures ~16% (16.2%→16.4% across re-measures = 49/303→50/305 as S1730 grew), 🚫 0 / ↩️ 2 / 🏁 13** (boolean-only ↩️; keyword OR off; bugfix last-only).

## Codex review log (rev 1 → rev 2)

| # | Severity | Resolution |
|---|---|---|
| 1 | High | D5 reduced to one canonical `milestoneMarker` rule (status+booleans, precedence 🚫>↩️>🏁); `isInvalidatedTurn`/`extractReversalFlag` left untouched; `invalidated:` prefix dropped. |
| 2 | High | Outcome tag is now an always-keep **candidate** independent of base score (D1/D6); 3 no-file ship turns confirmed in corpus. |
| 3 | High | Added `milestoneDayGroups` carrying full-day range/count + `continued`; built in `buildTimelineView` from the full kept set (D8 / plumbing). |
| 4 | Medium | D2 folds over a self-built RLE of `status!=skipped` (incl. `undone`), not `segmentPhases`. |
| 5 | Medium | D4 endpoints are **window** first/last, not session. |
| 6 | Medium | Empirical split into S1730-local vs corpus tables with SQL/DB/as-of; corrected `was_rolled_back` (S1730 = 2 decisions; corpus by type), distinct tags = 4889. |
| 7 | Low | Re-admitted burst `discovery` defined as a non-folded singleton (D1/D2). |
| 8 | Low | Budget denominator named `daySurvivorCount` (post-fold, pre-budget) across D3 + tests. |

### Codex review log (rev 2 precision pass)

| # | Severity | Resolution |
|---|---|---|
| 1 | Medium | D1 wording fixed: always-keep are not dropped by the budget but **do sort into and count against the cap** (matches the measured algorithm); removed the misleading "bypass budget". |
| 2 | Medium | D2 fold operand is now `foldable = base>0 ∧ ¬always-keep`, so an always-keep turn at a run end no longer suppresses the prior converged member. Re-measured: still 16.2% on S1730. |
| 3 | Medium | Marker inputs stated consistently: default `status`+booleans; knob #4 (off) may add **decision-gated** reversal-keyword tags; `invalidated:` prefix never read. Goals + D5 reconciled. |
| 4 | Low | Acceptance bound to a **frozen S1730-shaped fixture** (live S1730 grows — non-skipped drifted 301→303 mid-design); empirical numbers marked as-of/descriptive. |
| 5 | Low | Reversal-keyword OR (when knob #4 on) is **decision-gated**, matching `extractReversalFlag`; drops the lone `discovery`-tagged-`reversal` corpus turn. Test added. |

### Codex review log (rev 2 precision pass — round 2)

| # | Severity | Resolution |
|---|---|---|
| 1 | Medium | Re-admitted burst `discovery` removed from the D2 always-keep list; stated as a non-folded **budgeted** singleton (score 0.5, D3-capped), resolving the always-keep-vs-budgeted fork. |
| 2 | Medium | Acceptance reworded: 🏁 asserted for **outcome-only** turns; an outcome turn also 🚫/↩️ shows the higher-precedence marker but is still kept (matches D5/D7 precedence). |
| 3 | Low | Empirical namespace counts disambiguated: `invalidated:*` 50 turns / 51 instances, `compact:*` 9 turns / 18 instances. |

### Codex review log (rev 2 precision pass — round 3)

| # | Severity | Resolution |
|---|---|---|
| 1 | Medium | D2 first-retention restricted to {`decision`,`feature`,`change`,`refactor`}; **`bugfix` folds to last only** regardless of run length (0.2.28 semantic; reconciles with test #1). Re-measured: ~16% (50/305) — S1730 has a 5-bug run, so this is a real path. |
| 2 | Medium | Cross-page day overflow defined: `MilestoneDayGroup.isFinalSliceForDay`; the single overflow line attaches only to the day's final slice, never duplicated (D8 / plumbing / test #7). |
| 3 | Low | D5 marker-inputs reworded: 🚫/↩️ from status+booleans, **🏁 from `OUTCOME_TAGS` only**, `invalidated:` never read. |
