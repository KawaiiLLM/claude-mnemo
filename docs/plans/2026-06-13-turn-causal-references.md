# Turn Causal References & Milestone Fidelity

**Target version:** 0.2.33

## Goal

Let a turn record the turns that caused it, and use that causal link to repair the milestone view's two biggest blind spots. Concretely:

1. A turn's `content` may cite the turns it builds on / overturns / verifies as `[T<n>]`, forming a traversable causal graph.
2. Releases reliably appear in the milestone view as `🏁` (today they silently vanish).
3. Each kept milestone renders its cited "why" inline — so the causal driver rides on the marker instead of competing for a per-day slot.
4. The memory agent is re-primed after its context compacts, so it can write accurate `[T<n>]` references across compaction boundaries.

## Background

This spec is grounded in a simulation over the real S1730 turn data (`/tmp/msim.mjs`, `/tmp/pair.mjs`), whose baseline reproduces the live injected milestone view byte-for-byte. The numbers below are from that run.

### Problem 1 — releases vanish from the milestone view

`milestoneMarker` awards `🏁` (outcome → always-keep) only when a tag is in `OUTCOME_TAGS = {merged, shipped, released, ready-to-merge, approved, finalized}`. But every release turn in S1730 tags itself `release` / `push` / `pushed` — none of which are in that set:

| Release | tags (excerpt) | gets 🏁 today |
|---|---|---|
| T352 0.2.27+0.2.28 | `release`, `push` | no |
| T386 0.2.29 | `release`, `pushed` | no |
| T395 0.2.30 | `release` | no |
| T415 0.2.31 | `release` | no |
| T435 0.2.32 | `release` | no |

Result: **5/5 releases dropped** to overflow. The live injected 2026-06-07 view kept 3 spec-tweak decisions + 2 reversals and pushed all four same-day releases (0.2.29/30/31/32) into "+14 more". The delivery spine — the single most important arc element — is invisible, purely from a tag singular/tense mismatch. The session itself flagged this at T441/T442 ("outcome variant mismatch").

### Problem 2 — the "why" behind each release is lost, and scoring cannot fix it

The discoveries that drove each version (T370 "60% retention too high", T393 "30-turn window", T429 "reference prompt conflict") are type `discovery`, which scores 0 in `MILESTONE_BASE_SCORE`. A natural fix — give `discovery` a base score — was simulated and **failed**: why-discoveries stayed 0/5 kept, because the binding constraint is the per-day cap (≤7), not the score floor. On a release-dense day the `∞`-score markers already saturate the budget; a score-1 discovery never wins a slot.

### Problem 3 — the causal link is not derivable after the fact

If the link is not captured when the turn is written, it cannot be reliably recovered. Tested two render-time heuristics for "which discovery is the why of this release":

| Heuristic | correct pairings |
|---|---|
| nearest preceding discovery | 1/5 |
| nearest preceding discovery sharing a tag | 2/5 |

Both also **fabricate** a link where none exists (T352 has no driving discovery — it is a planned hotfix) and structurally miss drivers that are a `decision`, not a `discovery` (T415's driver is T407). Render-time has only correlational signal (tags, proximity); causality is not in it. The driver must be captured at **write time**, when the extractor has the causal context.

### Problem 4 — the agent loses the ids it needs to cite

The memory agent can cite a prior turn only if that turn's id is in front of it. Prior turns live in its conversation history, but that history is compacted away — both worker-driven (`shouldCompactAgent`, at 50% of the context window) and SDK-auto (`compact_boundary`). The prompt already warns against relying on it (query-session.ts:295). In a compact-heavy workflow, "cite a turn from before the last compaction" is the common case, so the agent needs a durable id source.

## Design

**The through-line: references replace the failed scoring fix.** The why-discovery does not need to win a milestone slot — it rides on the marker as a cited cause. `🏁` gives the *what*; the `[T<n>]` in its content gives the *why*; the renderer resolves the reference and shows the driver inline, cap-independent. Re-priming after compact + a recent-turn index is what lets the agent write those references accurately across context boundaries.

Five components, in dependency order.

### Component 1 — release outcome markers

Two signals, OR'd, mark a turn as an outcome (`🏁`, always-keep):

1. **Tag stem** — add `release` to `OUTCOME_TAGS` (→ `{merged, shipped, released, release, ready-to-merge, approved, finalized}`). This alone rescues 5/5 releases: every release in the data tags itself `release`, and `shipped`/`released` are already present. **Do not** add the bare verbs `push` / `pushed` / `merge` / `ship` — `milestoneMarker` treats any matching tag as an always-keep outcome (timeline.ts:535/973), and those verbs occur mid-work ("pushed a branch", "merge conflict") → false `🏁`.
2. **Version-file backstop** — if `files_modified` includes the version-bump set (`package.json` + the marketplace/plugin manifests, per [[project_version_bump_three_places]]), treat as outcome even without a tag. Covers a release that labelled itself only `push`.

Rejected: deriving from a "pushed to origin" structural signal. There is no clean structural push indicator — it would itself parse tags/content (`push`/commit-hash), so it is no more robust than the `release` stem while being more code.

### Component 2 — turn causal references

A turn's `content` may cite causally-related turns as bare `[T<n>]`, optionally inside natural language ("driven by [T429]", "supersedes [T201]"). The extractor writes them at extraction time using ids it has seen in `<turn id="T...">` blocks this session.

- **Storage:** none added — the `[T<n>]` lives in the existing `content` text. Persisted in `turns.content`, so the stored link is durable regardless of agent compaction. It reuses the existing DB-id `[T<n>]` marker convention (the same form summary `decision`/`done` use). Caveat: the existing resolver `resolveTurnPointers` (turn-pointers.ts) is scoped to summary fields only — Component 3 must add a **new** parser/resolver for turn `content`.
- **Semantics:** bare ids, no edge-type enum. The causal kind is clear from the two turns' text; typed edges would push toward a structured column, deliberately out of scope.
- **Scope:** cite only causally-significant predecessors (the decision/finding/turn this one builds on or overturns), not every prior step. Omit when none.

Rejected: a structured `references` column / edge table. Heavier (migration + render + integrity) and not needed for the maintain-the-causal-graph goal at this stage; the content `[T<n>]` is traversable enough.

### Component 3 — reference rendering in the milestone view

For each **kept** milestone, parse `[T<n>]` from its content (a new content-ref parser — `resolveTurnPointers` is summary-only), resolve each cited turn via `getTurnById(db, id)` (db/turns.ts:149) with a session-id guard, and render it as an indented sub-line under the milestone:

```
🏁 T435 🟣 0.2.32 released: reference field durable-pointers-only
      ↳ T429 reference prompt has conflicting guidance
```

- Applies to **any** kept milestone that has references, not only markers.
- **≤2** references shown per milestone; further ones elided.
- A cited turn that is invalidated/rolled back renders with its marker glyph (the edge is kept, see Decisions).
- Resolution goes through `getTurnById`, **not** the in-memory window: a ranged `timeline(id="S/Ta..b", view="milestones")` filters `windowTurns` to the range before selection (timeline.ts:1095/1122), so a kept milestone can cite a driver outside the window. The DB lookup is bounded (kept milestones × ≤2 refs). A cited id from another session (guard fails) renders as a plain `[T<n>]` with no sub-line.

This is the replacement for the failed scoring fix: the why surfaces without a cap slot.

### Component 4 — re-prime the memory agent after compact

`renderCurrentSessionOutput` (the shared SessionStart render, milestone-mode) is today sent to the memory agent only on derailment reopen (`reopenQuerySessionFresh`, server.ts:953). It must fire after **both** compaction paths named in Problem 4:

- Factor the cold-start render + `sendPrompt` into a helper.
- **Worker-driven compact:** call the helper in `handleCompact`, **after** `querySession.compact()` (server.ts:1791), so the freshly-compacted agent regains the session's structured state.
- **SDK-auto compact:** an unsolicited `compact_boundary` (query-session.ts:393) currently only calls `resolvePendingCompact()` and is invisible to the worker. Add a `WorkerQuerySessionDeps.onCompactBoundary` callback fired **only for unsolicited boundaries** (`pendingCompact === null`); the server sets `state.needsReprime = true`. Re-prime cannot be injected mid-stream, so the next work unit checks the flag, prepends the re-prime before its turn batch, then clears it.
- **No double re-prime.** An explicit `compact()` works by sending `/compact` and awaiting its *own* `compact_boundary` (query-session.ts:452). That boundary must NOT trigger the auto path — otherwise the explicit path re-primes synchronously in `handleCompact`, sets `needsReprime` via the callback, and re-primes a second time on the next work unit. Gating the callback on `pendingCompact === null` excludes the explicit boundary; equivalently, pass `source: "explicit" | "auto"` and ignore `explicit`. The explicit path never sets `needsReprime`.
- **Augment** the re-prime payload with a recent-turn index (Component 5's id source).

### Component 5 — recent-turn index + recall fallback

The re-prime payload includes a **recall-style, collapsed** index of the most recent **30** turns: `id + type + title` per line. Chosen over a timeline turns-view because the index exists to answer "which turn is which, to cite it" — content identity, not temporal forensics. The timeline turns-view's gap/tool-burst/line-anchor columns are noise for citation and heavier per line; it is also redundant with the milestone digest already in the re-prime (itself timeline-milestones).

For a driver outside the recent window or the current context, the extractor falls back to `recall()` to resolve its id — widening the existing recall license (today scoped to truncation-critical reads) to also cover "resolve a significant citation id you cannot see". Scoped tightly: only for a causally-significant link, accepting it costs one extra extraction round-trip ([[project_batch_amortization]]).

**Gotcha:** recall's *output* labels turns with the **prompt number** (`T${turn.promptNumber}`, format.ts:468), not the DB id a citation needs — the bare-`T<n>` DB-id route (recall.ts:208) is *input*-only and assumes you already know the id. So an agent that finds a driver via `recall(query=...)` gets an **un-citable** label. The fix is a worker-facing **DB-id surface**, wired through the existing handler-construction option — **not** a recall input param, since the public `recallInputShape` is strict (definitions.ts:11):

- Add `audience?: "main" | "worker"` (default `"main"`) to `CreateDatabaseBackedHandlersOptions` (handlers.ts already accepts this options object — the worker passes `{ defaultProject }` today, agent-session.ts:76).
- The worker constructs its handler with `audience: "worker"`; that branch passes an internal `includeDbTurnIds: true` into `recallMemory` — never added to `recallInputShape`, so the public schema and the main agent's output stay untouched.
- `recallMemory` threads the flag to the turn formatter, which appends `dbid:T<dbid>` (the DB id is already on `FormattedTurn`, format.ts:41). Main/public recall remains `[S<id>/T<promptNumber>]` with no `dbid:`.

Without this, Component 5 cannot produce a citable id.

### ID-space requirement (implementation gotcha)

Citations and the injected index must use the **agent's id space** — the DB turn id shown in `<turn id="T...">` blocks (server.ts:332), the same id passed to `remember()` — **not** the user-facing prompt number that recall/timeline render. The recent-turn index must therefore emit DB ids; the milestone renderer (Component 3) resolves the stored DB id via `getTurnById` (never the in-window list) and maps it → prompt number for display. Mixing the two id spaces is the most likely correctness bug here.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| 🏁 derivation | add `release` tag + version-file backstop; **exclude** bare `push`/`merge`/`ship` verbs | validated 5/5; bare verbs → false `🏁` (always-keep) |
| reference storage | `[T<n>]` in `content` (no schema) | lightweight; durable in DB; sufficient to traverse |
| reference semantics | bare ids, no edge-type | kind is clear from text; typed → structured column (out of scope) |
| reference resolution | `getTurnById`, session-guarded | a cited driver can sit outside a ranged view's window |
| recent-turn index source | recall-style collapsed, last 30 | citation needs content identity, not temporal decoration; complements the milestone digest |
| recall citation lookup | `audience:"worker"` handler option → `dbid:T<dbid>` in output (internal flag, not a recall input param) | public `recallInputShape` is strict; main recall output stays unchanged |
| cited-turn invalidation | keep the edge + mark it | causality is a historical fact: a later supersede does not unmake the cause |
| reference render scope | any kept milestone with refs, ≤2 shown | surfaces the why without a cap slot; bounded to avoid view bloat |
| re-prime trigger | reopen + worker-driven compact + SDK-auto `compact_boundary` (unsolicited only) | both compaction paths wipe history; explicit-compact boundary excluded to avoid double re-prime |

## Non-goals

- **Structured reference column / edge table.** Deferred; content `[T<n>]` chosen.
- **Recency-weighted significance** for milestone selection. Separate concern.
- **Per-day cap crowding** — on a marker-dense day the ≤7 budget can still push non-marker decisions to overflow. Noted, not addressed here.
- **Far-back drivers beyond recall's reach** — accepted limit; the graph is best-effort, not exhaustive.
- **Per-turn fixed injection** of recent turns — rejected on prompt-cache grounds; re-prime is one-shot at reopen/compact.

## Validation

The milestone simulation is the regression oracle:

- Baseline (current logic) reproduces the live injected 2026-06-07 group exactly → the sim is faithful.
- Component 1 applied → 5/5 releases KEPT with `🏁`; the 2026-06-07 view becomes 4 releases + 2 reversals.
- Scoring-only fix (rejected) → why-discoveries 0/5, confirming the cap, not the score, is binding.

**Caveat:** these numbers come from throwaway scripts (`/tmp/msim.mjs`, `/tmp/pair.mjs`) and are **not yet reproducible from the repo**. The companion plan must, before implementation, commit the simulation and a checked-in S1730 turn fixture (or a fixture DB) as a test, so the oracle lives in-tree.

## Implementation outline

Files touched (full task breakdown belongs in the companion `-plan.md`):

- **`src/mcp/timeline.ts`** — add `release` to `OUTCOME_TAGS`; add the version-file backstop in the outcome check; parse `[T<n>]` from kept-milestone content and render the resolved `↳` sub-line(s) (≤2) via `getTurnById`.
- **`src/worker/server.ts`** — extract the cold-start render into a helper; call it after `querySession.compact()` in `handleCompact` (worker-driven path); add the `onCompactBoundary` (unsolicited-only) → `needsReprime` flag → re-prime-before-next-work-unit path (SDK-auto); build the recall-style recent-30 index in DB-id space and include it in the re-prime payload.
- **`src/worker/query-session.ts`** — add `onCompactBoundary` deps callback, fired only when `pendingCompact === null` (server.ts wiring).
- **`src/mcp/handlers.ts` + `src/worker/agent-session.ts` + recall formatter** — add `audience` to `CreateDatabaseBackedHandlersOptions`; worker passes `audience: "worker"`; `recallMemory`/formatter emits `dbid:T<dbid>` under an internal `includeDbTurnIds` flag. `src/mcp/definitions.ts` (`recallInputShape`) stays unchanged.
- **`src/worker/query-session.ts` + `src/worker/processors.ts`** — prompt: license `[T<n>]` causal references in turn `content` (lift the "never revisit" wording for citation only); widen the `recall()` license to resolve a significant citation id. Keep both prompt copies in sync.
- **Version bump 0.2.33** — `package.json` + marketplace.json ×2 + `plugin/.claude-plugin/plugin.json` + `release-artifacts.test.ts` guard, then rebuild `plugin/scripts/worker.cjs` ([[project_version_bump_three_places]]).

## Testing strategy

- Unit: outcome derivation — `release` tag and version-file backstop produce `🏁`; a non-release `pushed`/`merge` turn does **not** (negative test, Finding 2).
- Unit: `[T<n>]` content parse + sub-line render (≤2 cap, invalidated-cited-turn marker, DB-id → prompt-number display); **range view** — a milestone in-range citing a driver out-of-range still resolves via `getTurnById`; a cross-session cited id renders inert.
- Unit: re-prime payload assembly (milestone digest + recent-30 recall-style index, DB-id space); worker-driven path calls the helper after `compact()`; **SDK-auto path** — a `compact_boundary` with no pending `compact()` fires `onCompactBoundary`, sets `needsReprime`, and re-primes before the next work unit; **explicit `compact()` does NOT leave `needsReprime` set** (no double re-prime).
- Unit: **worker-audience** recall (`recall(query=...)`) output includes `dbid:T<dbid>` for matched turns; **main-audience** recall output stays `[S<id>/T<promptNumber>]` and contains no `dbid:` (audience isolation).
- Regression: the committed milestone simulation fixture — all five S1730 releases kept with `🏁` under Component 1.
