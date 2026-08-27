# 09 — When only one side can afford a row, which one wins?

**What to build:** NOT YET DECIDED. This is a policy question about which half
of the milestone card survives a squeezed budget. It needs the user's ruling
before anything is implemented.

**Blocked by:** 08 (landed, `c4c8219`) restored pre-06 parity here but did not
resolve the underlying choice.

**Status:** needs-user-ruling — do not dispatch.

## The situation

At a small enough card budget, the fixed per-side reserve (header + pointer +
legend, ~174 honest tokens) eats most of a 250-token half, so only ONE side can
afford to render rows at all. The two sides are then in genuine competition and
somebody has to lose.

Measured live, E60 at budget 500 — a real rung of the demote ladder
(2000 → 1000 → 500):

```
[T998]  08-19  0.12.0 ships: seven version sites, refreshed guard probes…
[T1001] 08-19  Peer round-two fixes landed and 0.12.1 shipped…
[T1056] 08-20  User ruled write needs an untruncated read…
[T1265] 08-22  User unified the flow concept…
[T1266] 08-22  0.15.0 released and pushed…
[T1336] 08-23  0.16.0 released and pushed…
[T1406] 08-23  0.17.0 released…
[T1470] 08-24  0.18.0 released…
```

Eight rows, all from the OLD side, none newer than 08-24 — while E60's newest
200 members are from today. The RECENT side seated nothing at its half, and
under the current rule the OLD side (which did seat rows) takes the whole
budget, so RECENT is never given a second chance.

That is the exact disease the recent/old split was created to cure — old
anchors starving recent work — reappearing at the bottom of the ladder.

## Why this is a ruling and not a bug fix

The competition is real: at this budget, giving RECENT the full budget would
seat roughly five recent rows and leave OLD with nothing. There is no
allocation that shows both. So the question is not "how do we stop wasting
budget" (ticket 06 and 08 answered that) but **"when the card can only show one
era, which era does the user want?"**

Two defensible answers:

1. **RECENT wins.** The split exists to guarantee recency a share it cannot be
   outbid for; a squeezed budget is precisely when that guarantee matters most.
   This is also what ticket 08 decision 2 already chose for the case where
   BOTH sides seat nothing, so it would make the policy uniform.
2. **Whoever seats more wins** (today's accidental behaviour). A card showing
   eight old rows carries more index value than one showing five recent ones,
   and the older rows are the ones a reader is least likely to remember
   unaided.

There is also a third option that dissolves the question rather than answering
it: **cut the per-side reserve at low budgets.** ~174 tokens of a 250-token
half is the real culprit — most of it is the Legend paragraph, which ticket 05
already identifies as duplicated per side. If the Legend were rendered once per
card instead of once per side, both sides could afford rows at 500 and nobody
would have to lose. That makes ticket 05 and this ticket the same problem seen
from two ends.

## How urgent this is

**Currently dormant.** The demote ladder only drops below 2000 when a rendered
block exceeds `MAX_INJECTED_BLOCK_CHARS` (9500 chars). The largest card across
the whole production corpus — every segment × 7 budgets × 8 boundary positions,
3920 cases — is **7636 chars**. Nothing reaches the 1000 rung, let alone 500.

So this ships as a known, measured, unreachable-today limitation. It becomes
live the moment a segment's card grows past 9500 chars, which more members or
longer titles will eventually cause.

## What to decide

- Which of the three options above (RECENT-first, most-rows-wins, or fix the
  reserve via ticket 05's deduplication) is the answer.
- If ticket 05's deduplication is the answer, whether it is worth doing now
  rather than when the ladder actually starts firing.
