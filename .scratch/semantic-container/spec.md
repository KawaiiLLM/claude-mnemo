# Semantic Container — segments carry all semantic memory

**Status:** ready-for-agent
**Source:** S15069 T801–T832 (design arc + /grill-with-docs, three rounds + four follow-ons)
**Authority:** ADR-0001…0007 at `docs/adr/`; vocabulary per root `CONTEXT.md`. Where this
spec and an ADR disagree, the ADR wins and the disagreement is a bug in this file.

## Problem Statement

Recalling one task's knowledge currently requires knowing which conversation it
happened in. The session is the unit of semantic memory, but a session is an
arbitrary slice of one or more tasks — S15069 spans 28 days and a dozen tasks, and
its summary mushes them together. Three re-derivation failures were measured in one
session (a settled type-vocabulary decision, a dead milestone channel, a complete
field-design ruling with examples — all on record, none loaded): storage and
restoration work; **loading** fails, because the passive channel is keyed by
session while knowledge clusters by task. Meanwhile turn notes overrun their
budgets 2–3× with process narration, titles spend a quarter of their budget
duplicating structured fields, absolute 0–4 grading measurably collapses into ties
(93–100% tie groups), and the per-session summary agent is the system's largest
cost sink.

## Solution

The segment becomes the per-topic, long-lived semantic container (ADR-0001).
Mentioning a task in any session and attaching its segment loads that task's whole
working memory — goal, standing rules, in-force decisions, recent completions,
frontier, pointers — plus a browsable summary layer. Sessions stay episodic (turns,
transcript, timeline) and keep one field: a title. The main agent maintains
segments through a revived `remember` tool; the settlement subagent judges windows
through the same tool surface with staged, commit-gated writes; grading becomes a
three-tier election under seat ceilings. The turn-note contract is revised in the
same release so every field carries an operable admission test. One big version.

## User Stories

1. As a user, I want to mention mnemo work in any session and have its semantic memory load, so that recall is keyed by task, not by which conversation it happened in.
2. As a main agent, I want an attached segment's decisions list in context, so that I do not re-derive or re-litigate a settled ruling.
3. As a main agent, I want the segment's next_steps and done rows on resume, so that I continue work instead of reconstructing state from transcripts.
4. As a main agent, I want to create a segment only while the roster is in view, so that I never mint a near-duplicate lane.
5. As a main agent, I want `remember(create)` to accept proposal seed addresses, so that adopting a homeless cluster is one call.
6. As a main agent, I want to append a decision row the moment the user rules, so that a ruling is never lost to a maintenance cadence.
7. As a main agent, I want maintenance receipts showing turns-since-last-edit, so that cadence is self-correcting without a gate.
8. As a main agent, I want field edits as `replace(old,new)` on markdown rows, so that I must read current state before changing it and silence can never overwrite a statement.
9. As a settlement subagent, I want the same injection and tools as the main agent with staged apply, so that my writes land atomically on commit and nothing drifts between two tool dialects.
10. As a settlement subagent, I want to elect at most floor(10%·N) A and floor(30%·N) B turns per window, so that ranking replaces an absolute rubric that collapses into ties.
11. As a settlement subagent, I want to assign members only within the session's attached segments and propose otherwise, so that granularity decisions stay with whoever sees the whole board.
12. As a settlement subagent, I want to flag summary-layer claims that contradict member turns, so that self-authored impressions stay grounded without adding a second writer.
13. As a user, I want segment creation, naming and adoption to require my confirmation, so that the semantic layer's shape stays under my control.
14. As a user, I want proposals as one line — addresses, suggested title, a reminder to ask me — so that triage costs seconds.
15. As a user, I want the roster recency-ordered with manual close and no state machine, so that a year of containers needs no lifecycle babysitting.
16. As a resuming session, I want one 2000-token block per attached segment composed from recall and timeline output, so that injection has no dedicated renderer to drift.
17. As a resuming session, I want Working State rendered before the summary layer, so that the operational half survives budget pressure first.
18. As a browsing session, I want bare recall() to list segments before sessions, so that the task axis is the first retrieval door.
19. As a browsing session, I want segment field rows as first-class search hits beside turns, so that one query returns the distilled claim and its provenance scene.
20. As a reader, I want milestone rows admitting only state-cited or A-tier turns with B as budget filler, so that the spine shows what the task's memory actually leans on.
21. As a reader, I want the turn view exhaustive in event order with segment ordinals, so that narrative selection never hides raw history behind judgment.
22. As a reader, I want recall to paginate on overflow and timeline to filter by tier, so that the index stays lossless and the narrative stays selective.
23. As a note writer, I want field contracts in parameter descriptions with call-level rules on the tool, so that each rule sits where its reader fills the slot.
24. As a note writer, I want titles to be one English claim sentence with no activity prefix, so that a title-only list reads as the work's semantic index.
25. As a note writer, I want content to expand the title — precision, rejected alternatives with reasons, citations — under a sentence deletion test, so that a revisit needs no process narration replay already stores.
26. As a note writer, I want hard rejection only at 2× budget, so that receipts stay advisory in the band where rewrite loops cost more than overage.
27. As a future session, I want turn insights admitted by an episode-deletion test, so that the insight column reads as teachable priors.
28. As the dream agent, I want turn insights unchanged as my harvest source, so that cross-project distillation survives the segment redesign untouched.
29. As an operator, I want legacy arc-segments frozen out of the roster and legacy grades era-gated, so that old semantics never contaminate new reads.
30. As an operator, I want the per-session summary agent retired, so that the largest cost sink funds nothing the segment layer now provides.

## Implementation Decisions

### Data model

- `segments` gains six Working State columns — `goal`, `constraints`, `decisions`,
  `done`, `next_steps`, `reference` — beside the existing summary trio. Every field
  stores markdown row lists; rows carry `[S<id>/T<n>]` citations; decisions rows
  also name the decider. Storage is uncapped.
- New session↔segment binding table (attachment): rows accumulate, never expire,
  no detach. Consulted-only attachments (zero members) are legal and rendered.
- Membership stays the existing two-column pair table; member ordering is event
  time. Three numbering spaces: global turn id (storage), session ordinal
  (S views), segment ordinal (E views — navigation handles only; citations always
  S/T because late-settling members shift event order).
- Election tier is a new era-gated turn facet (A/B/C); the legacy 0–4 grade column
  is read only behind the old era. Third grading semantics — never mixed.
- Session semantic fields retire; `title` survives. Schema rebuilds follow the
  repo's SQLite 12-step pattern (the settlement-migration precedent, including its
  cascade-delete lesson).
- Facet aggregation (already live, K5a) exposes its counts; system-namespaced tag
  values (e.g. rollback markers) are excluded from aggregation and rendering.

### Tools

- Quartet: `note` (episodic: turn notes, session title) · `remember` (semantic:
  `create` / `attach` / `append` / `replace`) · `timeline(id, view, filter)` ·
  `recall(id, view, filter, query)`. `check` is retired; `commit` closes the
  subagent's staged batch (ADR-0007). The subagent shares the main agent's
  injection and quartet; its writes stage until commit.
- `remember` cadence is advisory, dual-direction (under-10 reminder on write, one
  nudge at 20 without maintenance); `decisions` appends exempt. `create` accepts
  seed member addresses from an approved proposal.
- Read tools: id prefix auto-derives the perspective (`S`/`E`; `E` addressing
  partially exists from the arc-era MVP and is extended, not invented).
  `view` is a pure field-set switch — turn collapsed: prompt/title/content;
  turn expanded: + insight, response, observations with in/out, files. Segment
  collapsed: metadata header, goal, per-field counts plus newest rows; expanded:
  all rows plus member index.
  `filter` is one structured grammar (type, tag, session, time, file) shared by
  both tools; recall's `query` becomes pure FTS; the prefix dialect
  (`type:`/`tag:`/… inside query) is cut clean. `phases` view retires. The
  character `truncate` knob retires.
- Budgets: `page` budget (default 1000 tokens) and a per-turn budget with
  different defaults per tool (timeline row-scale, recall card-scale; expanded
  default uncapped). On overflow **recall paginates** (index — lossless) and
  **timeline filters low tiers** (narrative — selective). Segment field rendering
  over budget elides the largest field first, oldest rows first — ellipsis at the
  top, newest rows always visible.
- Milestone admission: turns cited by the segment's state ∪ A-tier; B-tier rows
  fill remaining budget in election order. Turn views stay exhaustive.
- Election never renders — tiers drive selection only.

### Injection

- SessionStart for a session with bindings: one block per attached segment,
  2000 tokens each — literally `recall(id="E<n>")` collapsed (1000) +
  `timeline(id="E<n>", view="milestones")` (1000). No dedicated injection
  renderer. Roster follows (title + derived facets with counts, coarse project
  tag as group header, recency-ordered, budget-truncated); proposals last, at
  most three. RecentSessions and the diary index leave SessionStart. Attach
  mid-session returns the same composition as the tool result — cache-safe; the
  hook-channel red line (no floating tool-adjacent injection) stands.
- Segment block metadata: tag counts, type glyph counts, per-session member
  stats with last-active times, consulted-only attachments, maintenance
  distance. No election display.

### Note contract revision (same release)

- title ~20 tok: one English claim sentence, no activity/topic prefix, decider
  named when a ruling landed, no session-local codewords without a gloss.
- content ~100 tok: assumes the title was just read — expansion, never
  restatement: precision, rejected alternatives each with a one-line reason,
  secondary conclusions, citations. Sentence deletion test; process narration is
  replay's property.
- insight ~60 tok, default none: task-scoped lessons under the episode-deletion
  test (delete the episode — does the sentence still teach?).
- English everywhere (ruling 16 finally reaches the writer's surface). Hard
  rejection at 2× budget only; receipts otherwise. The grade parameter is
  removed. Type keeps the closed vocabulary with the honesty rule (report the
  stage that happened). Tags: coarse project noun first, then fine nouns; no
  activity suffixes; reuse exact spellings. Relations keep the four ordered
  questions with the never-soften rule. Field contracts live in parameter
  descriptions; the tool description keeps timing, skip, citation and the
  relation procedure.

### Judging

- Election per settlement window: rank by "how much does this task's future
  depend on this turn", elect at most floor(10%·N) A and floor(30%·N) B. Seats
  are ceilings, never targets; validators reject over-quota submissions and the
  subagent re-ranks. Era-gated.
- Summary grounding: citation floor on summary-layer claims (existing citation
  machinery); settlement flags summary-vs-members contradictions in its report,
  never rewrites.
- Citation-derived tiers (highest state field citing the turn) run as a
  zero-cost parallel experiment arm; comparison is leakage-aware (a judge never
  sees the other arm's output), disagreement sets eyeballed.

### Ownership

- Creation, naming, attachment, adoption, close: user / main agent, roster in
  view. Settlement: election, edge reconciliation, membership within attached
  segments, text proposals when nothing fits. One writer per layer (ADR-0002).

## Testing Decisions

- A good test observes external behavior at the highest seam and proves it can
  fail: every guard demonstrates red under mutation before green is believed
  (repo discipline).
- **Primary seam — the MCP tool surface**: quartet handlers called directly.
  Contracts, budgets, pagination-vs-filtering, addressing, field-set views, FTS
  segment hits, remember verbs and receipts, 2× rejection. Prior art: the
  existing MCP definition and renderer suites.
- **Secondary seam — the worker settlement channel**: election ceiling
  validation, era gating, membership assignment, proposal emission, staged
  apply with commit, summary flagging. Prior art: the note-settlement worker
  suite.
- **Auxiliary — db migration and derivation**: schema rebuild (six columns,
  binding table, tier facet), facet aggregation with system-tag exclusion,
  ordinal projections. Prior art: the schema-migration test family.
- Injection opens no new seam: one thin wiring test that SessionStart composes
  the two readers' outputs.
- Subagent judgment quality (election choices, proposal granularity) is not
  unit-testable; it is measured by the A/B protocol on real windows.
- The test-suite HOME sandbox (bunfig preload) applies as always.

## Out of Scope

- Automatic attachment — manual only in this version.
- The 761-turn grade backfill and any historical re-settlement (held until after
  this release; will use the new semantics).
- B-tier semantics beyond budget filler — revisit after the A/B experiment.
- Dream, diary and persona pipelines (unchanged; only the diary index's
  SessionStart slot is removed).
- Legacy segment/topic migration beyond freeze-plus-selective-adoption.
- The replay skill and raw axis.
- Segment splitting/merging tooling beyond adoption-time seeding.
- Cleanup of the 190 markup-contaminated legacy notes.

## Further Notes

- Measured baselines for acceptance (all from S15069, 2026-08-17): narrative
  openings 3/4 samples; note budget overage 95% of post-cliff notes; title-only
  cold read ~70%; milestone candidate collapse 77% under the flat 2500 budget;
  insight column standalone-teachability ~85%. Post-release, re-measure each on a
  fresh window — the known-answer protocol.
- Fields half of a mature segment measured ≈585 tokens (40% headroom under
  1000); the milestone half fits all eligible rows to ~60 members and begins
  selecting at the crossover.
- Known traps for implementers: characters are not tokens (CJK 1.4–1.7×
  measured); a `BUILD_ID`-carrying module can turn the shared build-id chunk
  lazy in esbuild output; the injection red line — nothing floats on
  tool-adjacent hook channels; system tag namespaces ride the tags column.
- The name `remember` returns from retirement; the old remember's merge into
  note (0.11.x) left the name free.
