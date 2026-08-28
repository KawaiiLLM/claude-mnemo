# 17 — Queued `^` branches survive a spent budget

**What to build:** repair the fifth peer round's findings on `031e320`
(verdict NOT READY, one new P1 + two P2).

**Blocked by:** 16 (landed, `031e320`).

**Status:** resolved — implemented INLINE by the reviewer, landed as the commit
following `031e320`. Suite 3977/0 (3976 + 1), tsc clean, rebuilt.

## The defects (peer's, all confirmed by reading)

1. **P1 — queued `^` branches vanish when the spine exhausts the node
   budget.** The dequeue loop gated on `budget.remaining > 0`, but a branch
   whose head is already visited renders as a single `^` edge and consumes NO
   node budget (`walkIslandSpine` returns before decrementing for a repeat).
   An island whose spine fills the default 8-node budget exactly dropped
   every queued repeat edge — including its closing `^` — with
   `truncated=false`. This narrowed ticket 16 decision 3 to "becomes a `^`
   branch only if a node seat is left".
2. **P2 — the rewritten timeline contract still described coverage wrong**:
   "picks the deepest-reaching continuation" — but island reachable-set
   coverage is a component invariant (always ties); the real discriminator
   is relation preference then recency, as ticket 13's own Status recorded.
3. **P2 — the `MIN_REPORTED_LANE_MEMBERS` tripwire was logically
   unreachable at ANY threshold**: it compared `memberIds.length >=
   MIN_REPORTED_LANE_MEMBERS`, but `buildComponentReport` returns null
   exactly when the count is BELOW that same threshold — the two conditions
   can never both hold. Raising the threshold to 3 would have silently
   dropped 2-member lanes, the exact failure the tripwire claimed to guard.

## Fixes

1. Dequeue loop runs the queue to empty; a repeat-headed branch always
   renders (zero node cost); an unvisited-headed branch is skipped only when
   the budget is spent — its node stays unvisited, which the existing
   completeness check already reports as truncation.
2. Contract sentence replaced: "At each fork every candidate reaches the
   same island (reachable-set coverage is a component invariant, so it
   always ties), and the continuation is chosen by relation preference …,
   then recency."
3. Tripwire condition becomes `componentReport === null &&
   memberIds.length > 1` — testing against the FALLBACK's own limit (it can
   only synthesize 1-member lanes), not the report's threshold.

## Acceptance

- [x] Codex's counter-example (8-member triangle+5-hop tail, spine exactly
      fills the 8-node budget): all 8 members render, ≥2 `^` branch lines
      survive, no `-> ..`, tail `(8)` — new test; reviewer mutation
      restoring the old gate turned it red, restored byte-identical, green.
- [x] Contract sentence corrected (component-invariant wording) — grep.
- [x] Tripwire fires for any declined multi-member lane regardless of
      threshold value — condition rewritten; still unreachable at
      threshold=2 by construction, by design.
- [x] `tsc` clean, rebuild, suite 3977/0 (3976 + 1).
