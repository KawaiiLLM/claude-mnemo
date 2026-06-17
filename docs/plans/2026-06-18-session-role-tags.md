# Session-Role Tags & Rewind-Free Rejection Marking

**Target version:** 0.2.35

## Goal

Make the milestone view's rejection graveyard — the abandoned approaches that are the timeline's highest-value unique signal — capturable without a manual conversation rewind. Today a dead end is marked only when the user structurally rewinds (`was_rolled_back`) or ESC-interrupts; a linear rejection ("no, do X instead", typed as the next normal message) leaves no marker and is not guaranteed into the view. The fix reframes what a tag is *for*, then wires one role tag end-to-end:

1. A turn's `tags` name its **role in the session's arc** — rejected, superseded, … — not its internal content or action. Topic and mechanics move to `content` (already FTS-indexed).
2. Topic/action tags are **removed**; the tag field becomes sparse and high-signal.
3. `rolled-back` is opened as the one **agent-writable role tag the marker honors**, proving the path `role-tag → ↩️ → always-keep` end-to-end before any taxonomy expands.
4. The "never update other turns" contract softens: a turn that a later turn reveals as a dead end can be **back-tagged** — recall-first when out of context, and the back-tag lands on the cited casualty, not the surviving turn.

## Background

Grounded in the real **S8233** session (`/Users/zhaoqixuan/Projects/anthropic-web-design`, 285 turns) — the rewind-heavy design-replication run analyzed this cycle, whose milestone view the user named as the canonical rollback graveyard.

### Problem 1 — the rejection graveyard is 100% rewind-contingent

`milestoneMarker` (timeline.ts:583) marks a turn `↩️`/`🚫` only from three signals, and a marker forces always-keep (`isMilestoneAlwaysKeep`, timeline.ts:629 → significance `+∞`):

| signal | source | requires |
|---|---|---|
| `was_rolled_back` column | rewind tree-topology (`detectRollbackTopology`, invalidation.ts) | manual rewind / message edit |
| `was_interrupted` column | `[Request interrupted by user]` transcript marker | manual ESC |
| `status='undone'` | agent `remember(status)` | the agent to set it — never happens (0 of 285) |

In S8233 **all 13** graveyard turns the user prizes (T5/T30/T60/T63/T77/T78/T122/T138/T183/T188/T243/T249/T269) carry `was_rolled_back=1` — every one is in the view only because the user rewound the conversation. A linear rejection emits none of the three: no marker, no guaranteed slot, and its dead-end nature is invisible unless it happens to be a high-base-score `type` whose title the extractor wrote with rejection prose.

### Problem 2 — tags conflate content/action with role

S8233 holds **503 distinct tags / 1128 instances** across 285 turns (79% tagged, ~5 tags/turn). Almost all are topic or action stems (`hypergryph` 41, `masthead` 33, `hatch` 22, `op-card` 17); only `rolled-back`(13) / `superseded`(7) / `revert`(7) name a role. The action stems actively mislead: the 7 `revert` tags sit on turns that **successfully performed** a revert the user asked for —

- T230 "User asked to **restore** powerline value colors. Reverted …"
- T235 "User asked to **undo** section pink ribbon change from [T4849]. **Restored** …"
- T118 "Reverted all paint masthead changes from [T4700]. **Transplanted** PaintBanner …"

— not dead ends. A naive "rejection-flavored tag → marker" rule lights all 7 as `↩️`+always-keep: **0 true positives, 7 false positives**. Worse, each `revert` tag sits on the *survivor* (the turn doing the reverting) while the real casualty is the turn it cites (`[T4849]`, `[T4700]`).

→ Action belongs in `content`; only the relational role (*was-rejected*, not *did-a-revert*) belongs in a tag.

### Problem 3 — linear-rejection detection must be semantic, and the contract forbids it

The rejection of turn N lives in turn N+1's prompt. A render-time keyword/sentiment scan over that prompt is the family the 0.2.33 spec scored 1–2/5 and rejected: fabrication-prone, full of false-positive traps ("no problem", "don't forget to also …"). The only context-aware detector is the extractor reading N+1 — but the contract bars it from touching an earlier record (query-session.ts:264, :290), so even when it recognizes the rejection it has no sanctioned way to record it on N.

## Design

**Through-line: separate the turn's role from its content, then let the agent write the role.** Mechanics and topic go to `content`, where FTS already finds them; the tag is reserved for the session-relational standing that search cannot infer. With action stems gone, a role tag like `rolled-back` is unambiguous enough to drive the marker — closing the linear-rejection gap that structural detection cannot reach.

Three components.

### Component 1 — tags name the session-role, not the content

Rewrite the tag guidance (query-session.ts:284-285): a tag names the turn's role in the session's arc; the topic, files, and action go to `content`. Role vocabulary is **emergent** — coin a general, reusable word for the role seen — illustrated by `rejected` / `superseded` / `final-decision` / `remember-requested` / `user-frustration`, **not a closed list**. Caveat: only one role drives a marker today (`rolled-back`, Component 2); the rest are role metadata with no marker consumer yet, and the dead-end-by-citation case must use the literal `rolled-back` (Component 3), not these synonyms. Explicit ban: a turn that *implements* a rollback is not `rollback`/`revert` — that is its action, recorded in `content`; rejection-flavored tags are for a turn that *was itself* rejected.

- **Topic tags removed entirely.** Topic search relies on FTS over `content` (`recall(query="masthead")`). This is **not** a recall regression: `tag:` filtering was already removed with the durable-memory layer and now returns a parameter error (recall.ts:1169), so there is no turn-level `tag:` query to lose. Tags are not a recall filter today at all — this reframe makes them a marker/role surface, not a search one.
- **Consequence:** tag coverage drops from 79% to role-bearing turns only — the field becomes sparse and high-signal by design; an ordinary work turn carries no tag, and that is correct.
- `status` is untouched — it remains worker/lifecycle-managed; the agent never sets it to express a role.

### Component 2 — bootstrap `rolled-back` as the one marker-honored role tag

Wire the `rolled-back` **tag** (not only the `was_rolled_back` column) into `milestoneMarker`'s reversed branch, ungated and type-agnostic — repurposing the dormant `enableReversalKeyword` / `REVERSAL_KEYWORD_TAGS` path (timeline.ts:133, :592-594), which is off-by-default and `decision`-only today and thus completely inert.

- Structural rewinds keep their `was_rolled_back` column → `↩️` (unchanged).
- A **linear** rejection gets `↩️` when the agent writes the `rolled-back` tag on the casualty — a second, agent-drivable source for the same marker, independent of the rewind topology.
- The `rolled-back` tag is already written on structural turns today (13× in S8233, fed by the reminder envelope) but is inert for the marker, which reads only the column. This component makes the tag load-bearing, which is what lets a *column-less* linear casualty light up.
- Scope is deliberately **one tag**. The broader role taxonomy (`final-decision → 🏁`, etc.) is out of scope until this path is proven (see Non-goals).

### Component 3 — soften the contract so the casualty can be tagged

Relax "never update other turns" (query-session.ts:290) to permit reopening an earlier turn to correct it, fenced by an anti-hallucination rule plus the cite-driven trigger. Two write-path facts make this **require code changes, not prompt alone** (see Implementation):

- **Reopen-to-correct.** A turn may be reopened to mark it a dead end or fix a mislabeled `type`/`title`/`content`. If its full context is not already in this batch, `recall({ id: "T<n>" })` first and read it — never edit blind from memory that may have been compacted away. Tags are **additive only** (`mergeTags`, turns.ts:118; `replaceTags` is internal and not exposed in the `remember` input) — a wrongly-written tag cannot be removed, an accepted limitation here, not a goal.
- **The casualty must be visible to milestone selection.** `selectMilestoneTurns` drops `status === "skipped"` *before* any marker/always-keep logic runs (timeline.ts:984-986), and live views exclude skipped too (timeline.ts:1783). So a back-tag only surfaces a casualty that is `extracted`:
  - **Already `extracted` → tags-only, status preserved.** Today `handleTurnRemember` forces `status: deriveTurnStatus(input)` (remember.ts:218), and a tags-only call derives `"skipped"` (remember.ts:173), which `updateTurnById` writes verbatim (turns.ts:190), demoting it. Fix: a tags-only reopen of an `extracted` turn preserves `extracted`, conditioned on existing status so the first-extraction contract (`active` + tags/type-only → `skipped`, remember.test.ts:372) stays green.
  - **`skipped`, or `active` with no substance → promote, don't tag-only.** The extractor marks no-tool/no-decision turns `skipped` (query-session.ts:286); a rejected discussion-only proposal is often exactly this. Tags-only leaves it `skipped` → filtered out → never reaches the marker. The back-tag must therefore also supply `title`/`content`/`type` (recall-first for context) to promote it to `extracted`. The extractor has the context — it is citing the casualty *because* it is overturning it.
- **Negate-on-cite, carrier = exactly `rolled-back`.** When this turn overturns an earlier turn it cites `[T<n>]` (the "overturns" case of the citation rule, never "builds on" / "verifies"), back-tag that **cited** turn with the literal tag `rolled-back` — the one marker-honored role (Component 2), following the visibility rule above (promote if it is not already `extracted`). A natural-language synonym (`rejected`, `superseded`) would satisfy the prose but render no marker (timeline.ts:591); such words may ride along as extra metadata but are **not** the carrier. The citation pins the exact casualty — fixing the survivor-tagging inversion of Problem 2 — and bounds the trigger to the ≤2 cited ids.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| tag meaning | session-relational role only; content/action → `content` | action stems (`revert`) gave 0 TP / 7 FP; role is what FTS can't infer |
| topic tags | removed, not coexisting | FTS covers topic search; role tags are the high-value marker/metadata surface (any role-tag filtering is future work) |
| dead-end carrier | the **literal** `rolled-back` tag (synonyms not honored) | one marker carrier; `rejected`/`superseded` render no marker (timeline.ts:591) |
| bootstrap scope | `rolled-back` only | prove role→marker end-to-end before opening the taxonomy |
| marker wiring | repurpose `enableReversalKeyword` path, ungated + type-agnostic | reuses existing structure; the dormant knob + `decision`-gate made it inert |
| detection site | the extractor, write-time, via negate-on-cite | render-time keyword heuristics fabricate (0.2.33, 1–2/5) |
| back-tag target | the **cited** casualty, not the survivor | citation pins the exact turn; fixes the Problem-2 inversion |
| tags-only reopen | preserve an `extracted` turn's status | else `deriveTurnStatus`→`skipped` demotes the casualty out of FTS / views (remember.ts:218) |
| skipped casualty | promote with `title`/`content`/`type`, not tags-only | `selectMilestoneTurns` drops skipped *before* marker logic (timeline.ts:984) |
| tag correction | additive only; removal out of scope | `mergeTags` is append-only; `replaceTags` not in the public `remember` input |
| contract relax | reopen-to-correct with recall-first | the real risk is blind-edit-from-compacted-memory, not editing per se |
| always-keep | role-tag marker stays `+∞` for the pilot | accept FP-crowding risk now; decouple later only if precision warrants |

## Non-goals

- **Full role taxonomy.** `final-decision` / `remember-requested` / `user-frustration` and their marker mappings are deferred; this ships `rolled-back` only.
- **Decoupling marker glyph from always-keep.** A role-tagged dead end is `+∞` like a structural one; if semantic false positives crowd the view, a follow-on gives tag-sourced markers a high *finite* score (cf. `isReadmittedDiscovery`'s 0.5) instead.
- **`tag:` recall filtering.** Not a regression — `tag:` filtering was already removed with durable memory (recall.ts:1169); topic findability is FTS over `content`. Reintroducing role-tag filtering is a separate future item.
- **Tag removal / correction.** Tags are append-only (`mergeTags`); a mistakenly-written tag cannot be unwritten without a new guarded `replaceTags` path on the public input. Out of scope.
- **Migrating existing tags.** The 503 legacy stems in stored sessions stay; the reframe is forward-only.

## Validation

The S8233 analysis is the honesty oracle, and it is deflating by design:

- On **existing** data, the Component 2 wiring adds **0 true positives** — every genuine dead end already carries the `was_rolled_back` column — and, if matching were extended past `rolled-back` to `revert`, **7 false positives**. Restricting to `rolled-back` reproduces the structural set exactly: zero regression, zero gain on this session.
- The gain is **forward-looking and prompt-contingent**: it materializes only once Components 1+3 cause the extractor to write `rolled-back` on linear-rejection casualties, which **cannot be simulated on stored tags** (they reflect the old guidance).
- On a **rewind-heavy** workflow the yield is structurally small (dead ends were already rewound). The pilot must therefore measure on a **linear-rejection-prone** session, scoring agent-written `rolled-back` tags against manual review, **before** the marker's `+∞` always-keep is trusted.

## Implementation outline

Full task breakdown belongs in a companion `-plan.md`.

- **`src/worker/query-session.ts`** — rewrite the tag guidance (:284-285) to role-only with the action-ban and emergent examples; soften the contract (:290) to reopen-to-correct + recall-first; add a "Correcting an earlier turn" section carrying negate-on-cite (and the rule to **promote** a `skipped` casualty with `title`/`content`/`type`, not tag-only); bump the call-count note (:264). The turn-extraction prompt lives only here — processors.ts mirrors the session-summary fields, not turn extraction.
- **`src/mcp/timeline.ts`** — make `milestoneMarker`'s reversed branch honor the **literal** `rolled-back` tag, ungated and type-agnostic (repurpose `REVERSAL_KEYWORD_TAGS` → `{rolled-back}` and drop the `enableReversalKeyword` + `decision`-only gates, or add a direct tag check); ensure both call sites (:631, :1063) pick it up.
- **`src/mcp/remember.ts`** — in `handleTurnRemember`, stop forcing a derived status onto an existing record: when the call carries no `title`/`content`/`status` and the target turn is already `extracted`, pass `status: undefined` so `updateTurnById` preserves it (turns.ts:190). Required for negate-on-cite — otherwise the back-tag demotes the casualty to `skipped` (Component 3, Finding 1).
- **Version bump 0.2.35** — `package.json` + marketplace.json ×2 + `plugin/.claude-plugin/plugin.json` + `release-artifacts.test.ts`, then rebuild the worker bundle ([[project_version_bump_three_places]]).

## Testing strategy

- Unit: `milestoneMarker` returns `reversed` for a turn carrying the `rolled-back` tag with `was_rolled_back=0` (the new agent-driven path), for any `type`; a turn with neither tag nor column gets no marker.
- Unit: always-keep — a `rolled-back`-tagged turn is selected regardless of base score or per-day cap.
- Negative (Problem 2 regression guard): a turn tagged with an action stem (`revert`) and `was_rolled_back=0` gets **no** marker.
- Unit: `remember({ id: "T<n>", tags: ["rolled-back"] })` on an `extracted` turn preserves `extracted` (no demotion to `skipped`); the first-extraction case (`active` + tags/type-only → `skipped`, remember.test.ts:372) stays green.
- Unit: a previously `skipped` cited casualty reopened with `title`/`content`/`type` + `rolled-back` becomes visible as `↩️` in the milestone view; the same casualty given the tag **only** stays `skipped` and filtered out (the promotion is load-bearing).
- Behavioral (manual, pilot): on a linear-rejection session, the extractor writes the literal `rolled-back` on the casualty (not the survivor), promotes it if it was skipped, back-tags the cited id under negate-on-cite, and emits no topic tags.
