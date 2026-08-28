# 11 — One edge atom: the labeled arrow

**What to build:** every relation-word render outside the console converges on
one syntax, the labeled arrow. User rulings 2026-08-28 [S15069/T1912]
(`-consume->` form) and [S15069/T1913] (`=word=>` marks a cross-lane edge):

- `-word->` — an edge, arrow pointing FROM the citing turn TO the cited one
  (the rubric's 引用方运用被引用方 direction, now visible in the glyph).
- `-word1,word2->` — a pair carrying several words: comma-join in the label.
- `->` — a bare edge (no relation word yet; the legacy unclassified drafts).
- `=word=>` / `==>` — the same three forms double-stroked when the edge's two
  lane placements are both set and DIFFER (a lane crossing). Same-lane and
  unplaced edges are single-stroke. The old `=>`-means-indexes is retired.

**Blocked by:** 10 (landed, `0fa7741`). Same file, serialize.

**Status:** resolved — landed as `ae9529f`; every criterion re-checked per-item
and independently spot-verified (suite green, tsc clean; real card shows
`↳ -indexes,verifies-> T532` and a genuine cross-lane `=extends=> T595`; lane
chains render `-extends->`/`-indexes->` with `=>` extinct; reviewer mutation
flipping the cross-lane predicate at the buildElectedCitations site turned 2
tests red, restored byte-identical, green — NB the predicate exists at TWO
sites and a needle asserting uniqueness must target by index). E70 at the
arrow format: 73 rows / 0 overshoots / 99.7% worst utilization.

Worker findings accepted: (1) a BARE cross-lane edge renders `==>` with a
leading stroke — without it a bare crossing would collide byte-for-byte with
the retired `=>`-means-indexes glyph; inferred from the retirement clause,
now in the formatter's doc comment; (2) the lane chain structurally never
sees crossLane=true (chainEdges pre-filters to both-sides-this-lane), so it
passes false with a comment — do NOT "fix" this later.

## Why

The same edge fact renders today as `↳ T1265(indexes)` on the milestone card
and `T1266 => T1265` in the lane chain — two syntaxes, one of which hides six
of the seven words entirely and both of which feed the same reader. The
labeled arrow beats the word-suffix form because direction becomes
self-describing: `A -indexes-> B` needs no convention knowledge, while a
suffix on the cited node leaves which-end-the-word-describes implicit. Cost is
a wash (`(indexes)` 9 chars vs `-indexes->` 10). [S15069/T1912]

## Decisions (settled — implement as given)

1. **One shared formatter.** A single function renders (words, crossLane) →
   arrow string; every surface below calls it. `formatAntecedentAddress`'s
   suffix form retires.
2. **`↳` sub-rows** (milestone card, MCP milestones views, spine-nested rows —
   every `↳` surface): `↳ -indexes-> T1265, -consume-> T946, +1`. Per-item
   arrow before the address; the pair's FULL word list in the label; cap and
   `+N` fold unchanged; bare/qualified address convention unchanged.
3. **Lane chain**: `S15069/T1470 -consume-> T1465 -indexes-> T1336 -> ...(24)`.
   The arrow between nodes carries the hop's kept word (the existing
   one-route strongest-word convention — a path summary keeps ONE word per
   hop, deliberately unlike `↳`'s full list); the truncation marker stays a
   plain `-> ...`; `(N)` tail and address run-qualification unchanged.
4. **Cross-lane detection**: `tail_tag != '' AND head_tag != '' AND tail_tag
   != head_tag` on the edge row. A pair with several edge rows: if ANY placed
   row crosses, the arrow double-strokes (crossing is the notable fact).
   Lane NAMES do not render on these compact surfaces — `{tail→head}` detail
   is ticket 12's recall-only suffix.
5. **Settlement context and MCP views are IN scope** — this unification is
   deliberately global (unlike tickets 03/10's scope fences): the settlement
   agent and the query surfaces should read the same vocabulary the card
   teaches. The console is OUT (its own visual language). recall's relations
   field is OUT here — ticket 12 replaces it wholesale with the tree.
6. **Out of scope:** the tree renders (tickets 12/13); whitespace pricing
   (ticket 14); election and fitter logic; any version bump or push.

## Acceptance criteria

- [x] One formatter, called by every `↳` surface and the lane chain —
      asserted by grep evidence in the report (no other producer of `-…->`
      or `(word)` suffix remains on these paths).
- [x] `↳` renders labeled arrows with full word lists; multi-word pairs
      comma-join — asserted on a fixture with a 2-word pair.
- [x] A bare pair renders plain `->` — asserted.
- [x] A cross-lane edge double-strokes (`=word=>`), same-lane and unplaced
      single-stroke — asserted on fixtures of all three placements.
- [x] Lane chain: `=>`-means-indexes is gone; an indexes hop renders
      `-indexes->` — asserted; truncation marker unchanged.
- [x] The milestone card still fits its budgets: re-run the overshoot sweep
      (`/tmp/overshoot-probe.ts`) — zero overshoots, report worst
      utilization; report the real E70 card's row count (arrows cost ~+1
      char per cite; expect ~74±2 rows).
- [x] Every new/changed test mutation-verified: name the observable, back up
      AFTER the implementation lands, assert the needle matched and PRINT
      that it applied, red, restore byte-identical (md5), green.
- [x] `npx tsc --noEmit` clean, `node scripts/build.js` succeeds, `bun test`
      green; baseline 3947/0 — report the number and account for every delta.

## Notes

Production DB strictly read-only. Do not tick your own boxes — report
per-item; the reviewer ticks.
