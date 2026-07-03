# Milestone Weighted Scoring & Context-Quality Fixes

**Target version:** 0.2.38
**Status:** Part 1 implemented (src/hooks/handlers/context.ts, src/mcp/remember.ts, src/worker/query-session.ts + 2 test files); Part 3 spec'd — calibrated on S1730, cross-validated on S5233/S9262, verdict: ship with the §3.5 amendments

## Goal

This cycle audited the two token-hot read surfaces against live DB data — what SessionStart injects, and what the timeline milestone view selects — then fixed the three cheap defects in code and converged a redesign of milestone selection. The selection redesign replaces the type-only base score with a weighted multi-signal score inside the existing selection frame, killing the two big distortions found on real data: release rituals eating whole day budgets, and 85% of `discovery` turns being structurally invisible. Weights were calibrated by a 4,608-config grid search against hand-judged gold/mud lists on S1730 (458 live turns).

## Part 1 — Landed changes (implemented this cycle, uncommitted)

### 1.1 Husk-session filter (context injection)

**Problem.** `buildRecentSessionsOutput` (src/hooks/handlers/context.ts:162) injected every recent session with no quality gate, so untitled 0-turn husks (S9778, S1351, S1314, S394 — DB-verified) occupied "Recent Sessions" slots indefinitely.

**Change.** `isHuskSession` (context.ts:168, `untitled && turnCount === 0`) applied as a filter (context.ts:179) *before* the `.slice(0, 10)` cap. No new DB queries. Two tests added (tests/hooks/context.test.ts): husk exclusion matrix, 11-husks+1-real pre-slice ordering.

### 1.2 HTML-entity decode at the remember boundary

**Problem.** Agent-authored fields persisted with literal entities (`T&lt;n&gt;` in `sessions.decision`, rendered verbatim into injected context). DB scope: 4 sessions + 40 turns. Root cause: the extractor model self-escapes angle brackets in XML-ish contexts — verified that no worker-side escaping code exists (all 8 src/worker/ files clean), so the escaping originates in generation.

**Change.** `decodeHtmlEntities` (src/mcp/remember.ts:63) — single-pass `/&(lt|gt|amp);/g` — applied by `decodeRememberInput` to every string field including `tags` elements, at the top of `rememberTool` (remember.ts:386) before any dispatch or bracket processing. Single-pass is double-decode-safe (`&amp;lt;` resolves leftmost to `&lt;`, never to `<`); DB contains zero `&amp;lt;` occurrences. Four tests added (tests/mcp/remember.test.ts).

**Not done — data side.** The 44 existing rows are NOT cleaned: the mass UPDATE was blocked by the standing read-only DB boundary and stays pending user authorization. Backup exists at `/tmp/claude-mnemo-pre-entity-fix.db`. Any future cleanup must reindex the affected `memory_fts` rows via `indexSessionToFTS`/`indexTurnToFTS` (the FTS table has no triggers; bare SQL UPDATE leaves search stale).

### 1.3 Topic-tag arc consistency (extraction prompt)

**Problem.** Two-class tags (0.2.37) work, but the topic vocabulary fragments: 357 distinct `topic:` tags over 1,301 instances (3.6 uses each), with near-synonym drift (`verifier-rubric` / `verifier-training` / `verifier` / `verifier-design`, 109 combined). Since recall's `tag:` facet is exact-match (`json_each`), every variant spelling is invisible to a single query. Worse, the old instruction "skip if the title already conveys it" punched holes in exactly the classification coverage the facet needs.

**Change.** Rewrote the TOPIC bullet (src/worker/query-session.ts:286): topics are exact-match classification keys — REUSE the exact spelling from recent turns when a theme continues (one multi-turn arc = one stable topic on every turn), mint new topics only on genuine theme shifts, up to 3 topics per multi-theme turn, and tag the theme even when the title conveys it. Test-guarded phrase `topic tags NEVER affect milestones` preserved. Source-only edit — takes effect at the next bundle rebuild; existing fragmented topics in the DB do not self-heal.

## Part 2 — Milestone-view assessment findings

All findings verified on live S1730 output (`timeline view=milestones`) and read-only DB probes.

| # | Problem | Receipt |
|---|---|---|
| P1 | **🏁 ritual multi-count**: one release spans 2–4 turns (impl-complete → verified → merge → push), each independently hits `OUTCOME_TAGS` or the version-bump backstop, each gets always-keep and bypasses the day cap | 0.2.20 consumed 4 of 4 slots on 06-01 (T178–T181); 05-29 kept 6×🏁 of 7 slots while "+29 more" foldable turns dropped; 06-04 had 7 outcome-tag hits in one day |
| P2 | **discovery blind spot**: not in `MILESTONE_BASE_SCORE` (timeline.ts:613) → base 0; only burst-readmitted (>2×median tool calls) enters the pool at 0.5, below `change`=1 | 155/183 (85%) of S1730 discoveries are below threshold → structurally invisible; discovery is the largest type (35% corpus-wide, 40% in S1730) |
| P3 | **↳ duplicate rendering**: a cited reference that is itself a kept milestone in the same day group renders twice | T512 as row + as ↳ under T513 (06-17); T521 rendered ×3 on 06-18; 6 dup sub-rows in the S1730 view |
| P4 | **victim ghost**: 0.2.36 demotion only removes the +∞ guarantee; on sparse days the rolled-back victim re-enters first-class via base score while also riding as ↳ casualty | T521 (rolled-back 0.2.35 spec) kept first-class + cited ×2 on 06-18 |
| P5 | **type-only scoring has no relevance axis** (T463 audit): display-level mitigation exists (`milestoneTail` at injection) but in-selection importance is blind to insight, citations, and artifacts | motivates Part 3 |
| P6 | **`feedback` type unmapped**: absent from `TYPE_EMOJI_MAP`, base-score table, and `TypesDistribution` — counted nowhere | 2 turns corpus-wide |

## Part 3 — Redesign: weighted multi-signal selection

### 3.1 Architecture

Three simulation arms established that the existing frame's three-layer *principle* — structural ∞ core, scored competition, per-day budget — must survive. Implementing the new scoring inside it is however a **pipeline replacement across several independent code paths** (change map below), not a drop-in swap of one function. Target selection semantics:

```text
significance(turn):
  structural core → ∞          endpoints · compact · outcome ANCHORS (post-coalescing) ·
                               correctors · invalidated · reversed-WITHOUT-corrector
                               (superseded victims stay hard-excluded → ↳ only)
  otherwise:
    score = TYPE_BASE[type]                          # decision 4 · feature/refactor 2 · bugfix 2 ·
                                                     # change 1 · discovery 1 (0-file gate kept)
          + max(insight·2, pureSpec·3,               # content group takes MAX — signals co-occur;
                tagFam·1, roleTag·1)                 # summing triple-counts spec churn
          + min(citedBy, 2)·1                        # graph group, additive
                                                     # NO burst term (calibrated to 0)
  pool entry: score ≥ 2                              # replaces fold gate + burst readmission
  budget:     per-day TOTAL cap = min(4 + pool_day/8, 7); structural picks consume slots,
              overflow always-keep force-kept (production semantics)
  run rule:   per same-type consecutive run per day ≤2 picks = run-LAST + highest-scored other
              (fold's keep-last carries finality; pure top-2-by-score dropped T517 final-design)
```

**Rule A — outcome coalescing** (fixes P1): same-day outcome-marked turns chain when prompt gap ≤5; the chain breaks when the title's version string changes (use the LAST `0.x.y` match = bump target). Only the chain tail keeps ∞ and renders 🏁; demoted members compete flagless at base score. Validated: 0.2.20's 4 turns → 1 anchor (T181, the merge); multi-release 05-29 keeps one anchor per version (6→4 flags); separated ship events (06-07, gaps >5) untouched.

**Rule C — render dedup** (fixes P3): suppress a ↳ sub-row whose target is already a kept milestone in the same day group.

**Victim hard-exclusion** (fixes P4): superseded victims never re-enter first-class (endpoint/compact excepted); their trace is the corrector's ↳, which is guaranteed because correctors are structural.

**P6 is excluded from this plan's scope**: the extractor prompt's type enum does not emit `feedback` (query-session.ts:283), so the 2 corpus rows are legacy anomalies; mapping the type properly means a full taxonomy migration (prompt enum, timeline emoji/distribution/typed-kind at timeline.ts:182/:258/:945, docs, tests) that this plan does not need. If desired, normalize the 2 rows in the blocked data cleanup (§3.5.7) instead.

**Implementation change map** — every touched path, its current behavior, and the test that pins the new one:

| # | Change point | Current code | New behavior | Pinning test |
|---|---|---|---|---|
| C1 | significance score | `MILESTONE_BASE_SCORE` + `milestoneBaseScore` (timeline.ts:613–630) | weighted multi-signal score (box above) | weight-table units + S1730-shape golden day |
| C2 | burst readmission | `isReadmittedDiscovery` (timeline.ts:640) + its uses in `selectMilestoneTurns` | **removed** (W_burst=0); discovery enters via score | no orphaned callers; low-tool insight discovery kept, bursty no-insight discovery not |
| C3 | pool entry & runs | `foldMilestoneRuns` gate (timeline.ts:658–696) | score ≥ 2 pool gate + per-run ≤2 = run-LAST + highest-scored other | run-finality case (last kept even when lower-scored) |
| C4 | victim handling | soft demotion — always-keep cancelled only (timeline.ts:1085–1095); victim can re-enter via fold/budget | hard exclusion unless endpoint/compact | T521-shape ghost regression |
| C5 | outcome coalescing | absent — every outcome marker force-kept (`milestoneMarker`, timeline.ts:585–611) | same-day gap≤5 chains, version-change break, tail-only 🏁 | multi-release day · versionless chain · gap/version breaks |
| C6 | day budget | cap over fold survivors (timeline.ts:1128–1148) | cap over score-gated pool + size-adaptive retention target (§3.5.1) | retention band across three session shapes |
| C7 | citations | render-only (`resolveMilestoneReferences`, timeline.ts:1220) | also a scoring signal with density-adaptive cap (§3.5.2) | dense-citation rescue case |
| C8 | ↳ render dedup | renderer emits all resolved refs | suppress refs already kept in the same day group | render snapshot |

### 3.2 New signal detectors

- **pureSpec**: `files_modified` non-empty ∧ every path matches `docs/(plans|specs|superpowers)/**/*.md`. Precision check: 11/11 tag-mined spec-authorship turns hit; 92 pure-spec turns exist in S1730. Structural analogue of `isVersionBumpTurn` — pollution-free, era-stable.
- **citedBy** (in-degree): later same-session turns citing this turn's `[T<dbid>]`. Strong when present (T515/T516 surfaced immediately at ←2) but sparse — 31 turns, only since 0.2.33 introduced citations; grows over time. Weight stays minimal.
- **tagFam**: importance keyword families (`design|architecture|spec|simulat|review|audit|verif|bug|root|regress|correction|pivot|hotfix|misfire|decision`) over bare tags and `topic:`-stripped tags.

### 3.3 Calibration (S1730, 4,608-config grid, Opus worker)

Objective `2·|kept∩GOLD| − 3·|kept∩MUD|` over 28 hand-judged must-keeps and 12 must-drops; hard constraints: spine intact, no dark days, kept ∈ [82, 105].

**Winner: GOLD 20/28, MUD 0/12, kept 102 (22.3%)** — vs the A+B+D reference's 19/28 with 2 MUD leaks (T179/T293 ritual outcomes slip its fold). The +8 edge is mostly mud-avoidance, not gold-hunting.

**Post-fix re-run** (structural core extended with `invalidated` + reversed-without-corrector, per §3.1): winner config unchanged; objective settles at +38 (GOLD 19/28, MUD 0/12, kept 102). The 6 restored dead-end turns (T201, T266, T409, T434, T454, T484) consume cap slots and displace one GOLD (T269 fork-lineage spec) — the accepted price of dead-end visibility.

Counter-intuitive calibration results (all grid-verified):

| Finding | Value | Mechanism |
|---|---|---|
| Burst weight must be 0 | spread −4 at W=1 | tool-heavy ≠ important; burst admits busy noise that displaces gold under a tight cap — this retires the existing burst-readmission mechanism |
| Insight weight caps at 2 | 3 → −3 | over-admits insight-bearing ordinary turns |
| Feature base 2 beats 3 | 3 → −2 | feature titles skew ritual ("implementation complete") |
| Spec weight rewards high (3) | 2 → −5 | spec authorship is the strongest gold-aligned signal |
| DAY_BASE=4 dominant | 3 → −12 | budget, not signal quality, is the binding constraint |
| Citation weight inert | flat | too sparse in a single session to move rankings |

### 3.4 Rejected alternatives

| Alternative | Killed by |
|---|---|
| Pure weighted top-k, no ∞ core (v1) | 6/23 release anchors dropped — merge/push turns are chronology anchors (version→date→SHA), they always lose an importance race to design turns |
| Global budget instead of per-day (v3) | 4 sparse days went dark while 05-29 took 16 slots; global type-base dominance re-created the discovery wipeout (T527 ←2, T585 evicted) |
| Loose pool entry, score>0 (v2) | retention flooded to 31% — pool-entry strictness, not scoring, governs retention |
| Summing content signals | insight/spec/tagFam co-occur; the sum triple-counts spec-iteration churn (Round-4/Round-5 fix turns flooded in) |
| Tag-keyword bonus as ranking modifier | zero-sum under a fixed budget: dug 12 real turns but evicted equal gold (T322, T527, T153); tags-replace-insight lost all new-era finds (post-0.2.35 bare tags are role-only, 9.7% coverage) |
| Tag fold-exemption pass (no score change) | same zero-sum via pool inflation + tie-breaks (evicted T374, T519) |
| Free-tag namespace rollback for scoring | under max() the marginal gain over insight+pureSpec is near zero; the case for richer topic tags rests on recall/clustering (§1.3), not milestone scoring |
| Run top-2 by score | drops the run's final state (T517 "Final design") — finality needs the LAST member, hence the hybrid |

### 3.5 Cross-session validation results & remaining amendments

Winner config re-run (via `/tmp/milestone-sim5.py`, verified bit-identical to sim4 on S1730) on S5233 (615-turn KawaiiLLM research session) and S9262 (251-turn thesis session). **Verdict: the architecture generalizes — coverage 100% on all three sessions, spine fully intact, the correction/citation graph carries the digest where outcome markers are absent — but the weights are partially S1730-fit. Ship with the amendments below.**

| session | non-skip | kept | retention | pure_spec | insight | citedBy>0 | outcome marks |
|---|---|---|---|---|---|---|---|
| S1730 (dev) | 458 | 102 | 22.3% | 92 | 332 (72%) | 31 | 37 |
| S5233 (research) | 615 | 155 | **25.2%** | **0** | 521 (85%) | 48 | 3 |
| S9262 (thesis) | 251 | 73 | **29.1%** | **0** | 207 (82%) | **115 (46%)** | 0 |

1. **Budget must be size-adaptive (blocking)**: the flat `DAY_BASE=4` per-day floor over-retains short/discovery sessions (S9262 hits 29.1%); `DAY_BASE=3` fixes retention everywhere but tanks S1730 (GOLD 19→13) — no flat value works. Implement a total-retention target (~20–23% of non-skipped) distributed across days, or a floor scaled by turns/day.
2. **Citation weight must adapt to citation density (blocking for non-dev sessions)**: `W_cite=1/CAP=2` is right for sparse sessions (S1730: 31 cited turns) but starves dense ones — S9262 has 46% cited coverage, and the throttle blocked citations from rescuing its highest-value dropped findings (T58 cited ×5, T181 "reward inversion PROVED" cited ×4). Scale the cap (or weight) with the session's cited-turn share.
3. **Off-code-project signal degradation (accepted, documented)**: `pureSpec` is dead (0 hits — no plan docs) and `insight` saturates (82–85% coverage → the max() content term goes near-constant), so ranking collapses to type base + citations + tagFam. Acceptable with amendment 2; future signal work should target insight quality tiers rather than presence.
4. **Confirmed safe defaults**: `W_burst=0` and `feature=2` generalize (burst=1 degrades S1730, is lateral on S5233, mildly helps S9262 — not an artifact, keep 0; feature base is near-inert off dev sessions).
5. **Title-only reversal blind spot (new, minor)**: S5233 T58 "Reversed decision: scene_summary" is a reversal narrated in the title with no `rolled-back` tag/column → marker None → not force-kept. Partly era-bound: S5233 mostly predates 0.2.35's negate-on-cite back-tagging, which today would tag the casualty when the reversing turn cites it. Residual gap: reversals the extractor narrates but neither cites nor tags.
6. **Role-tag weights stay deferred** (T546): `correction` (38) / `deferred` (13) are accumulating; revisit once the pool clusters — the citedBy and roleTag channels give them a slot to plug into.
7. **Data cleanups blocked by the read-only DB boundary**: entity residue (44 rows, §1.2) and legacy topic fragmentation (§1.3) both need authorized writes + FTS reindex.

## Testing & acceptance

- **Part 1 (landed)**: full suite 765 pass / 0 fail; guard phrases (`topic tags NEVER affect milestones`, release-artifacts asserts) intact; bundles not rebuilt — rebuild at release per the version-bump ritual.
- **Part 3 (to build)**: one pinning test per change-map row (C1–C8, §3.1) plus global invariants (spine: anchors/correctors always kept; day coverage: no dark ≥3-turn days; victim exclusion), plus acceptance tests for the two blocking amendments:
  - **Retention band**: kept/non-skipped ∈ [15%, 25%] asserted on three fixture shapes — release-heavy dev session (S1730-like), no-outcome research session (S5233-like), short citation-dense session (S9262-like). §3.5.1 is done when the third shape passes without regressing the first.
  - **Dense-citation rescue**: in the citation-dense fixture a turn cited ≥4× must be kept. §3.5.2 is done when this passes with sparse-session behavior unchanged.
  - **Fixtures**: synthetic shape fixtures in tests/fixtures (privacy-safe — real dumps contain cross-project conversation summaries and stay out of the repo); scripts/milestone-sim/README.md documents regenerating real dumps locally and re-running the golden calibration against them.

## Artifacts

- Simulation scripts: `scripts/milestone-sim/` (committed) — sim = production replica + rules A/B/D, sim2 = tag experiments, sim3 = weighted arms v1–v3, sim4 = 4,608-config grid calibration, sim5 = cross-session validation. Inter-script imports are `__file__`-relative; the repo copy of sim4 reproduces the +38 winner bit-identically.
- Session dumps: **not committed** (cross-project conversation summaries). `scripts/milestone-sim/README.md` carries the SQL export command and the sha256 checksums of the dumps used for the 2026-07-03 calibration.
- Memory: `milestone-abd-simulation` (auto-memory, cumulative findings)
