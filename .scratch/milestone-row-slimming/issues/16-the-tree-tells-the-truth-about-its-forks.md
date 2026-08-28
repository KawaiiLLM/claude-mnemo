# 16 — The tree tells the truth about its forks

**What to build:** repair the four defects the GPT peer's fourth review round
found in the tickets 10–15 batch (verdict NOT READY, 2026-08-28), all
reviewer-confirmed against code or the real card.

**Blocked by:** 15 (landed, `d892205`).

**Status:** resolved — landed as `031e320`; every criterion re-checked per-item
and independently spot-verified. Suite **3976/0** (3970 + 6), tsc clean. Real
receipts: E70 card marker count 2 → **1**; T1898's settled tree byte-identical;
**14 anchored branch lines now live in E60/L\*** (e.g. `└ T289 -consume-> T277
<-override- T279 ...`) — the false-topology defect was misrepresenting real
graphs, not a synthetic corner. Reviewer mutation dropping the anchor prefix
(reintroducing the flat-indent lie) turned 2 tests red; restored
byte-identical, green. Both tool descriptions carry the root-relative
qualification sentence; retired-syntax greps are clean (NB a raw `=>` grep
still hits the legitimate `==>`/`=word=>` cross-lane tokens — not the retired
standalone glyph).

Worker findings accepted: (1) the full suite caught a second-order regression
targeted runs missed — an existing session-composition test's sole
discriminator was marker-COUNT, itself an artifact of the seam bug being
fixed; rebuilt with a real demotion-difference discriminator, stronger than
what it replaced; (2) recall trees are structurally immune to the anchor rule
(they only fork at root), which is why zero recall fixtures changed; (3) the
MIN_REPORTED_LANE_MEMBERS loud-failure tripwire is deliberately dead code at
threshold=2 — it exists for a future threshold raise, per the ticket's own
"or" alternative.

## The defects (all confirmed)

1. **P1 — island branches render under the root regardless of their true fork
   point.** `TreeSpine` carries no parent (`relation-tree.ts` ~213); the
   renderer's own comment says "regardless of which node in the tree a branch
   actually forked from". `R-extends->A`, `A-extends->B`, `A-indexes->C`
   renders `└-indexes-> C` under R — the only reading is R→C, an edge that
   does not exist. Coverage is complete; the topology lies. The worker chose
   flat indent in a comment instead of stopping — the settled examples only
   ever forked at root, so nothing pinned the deeper case.
2. **P1 — the registered MCP tool descriptions teach retired syntax**
   (`definitions.ts` ~69/71): flat `→/←` relation lines, `=>`-means-indexes,
   newest-first lane lists, RELATIVE-TO-PREVIOUS hop qualification (the
   implementation is relative-to-ROOT — an agent following the published
   contract mis-resolves `S1/T9 -extends-> S2/T8 -narrows-> T7` as S2/T7 when
   it is S1/T7), and no `S<n>/T<m>` node selector.
3. **P1 — recall's main-spine selection narrowed the ticket's authority**:
   ticket 12 said "reuses the lane chain's one-route logic (coverage-greedy)";
   the implementation selects by `boundedOutCoverage` (3-hop). Display caps at
   3 hops; SELECTION must not — that is the seat-cap disease again (a display
   limit leaked into an admission decision). A deep thread must win the main
   spine and show `-> ..`.
4. **P2 — the split card emits two adjacent identical `[S<n>]` markers** at
   the OLD/RECENT seam of a single-session segment (confirmed live: E70's
   card, lines 4 and 46). Ticket 10 criterion: marker count == switch
   count + 1.

## Decisions (settled — implement as given)

1. **A branch names its fork point unless it forks from the root.** Branch
   line form: `└ T54 -consume-> T49 -> ..` — the anchor address first, then
   the hops (anchor qualification follows the surface's hop rule). A branch
   whose parent IS the root keeps today's `└-word-> X` form byte-identical
   (both settled examples stay valid). `TreeSpine` gains the parent; the walk
   already knows it (`cameFromId`).
2. **Selection coverage is unbounded** (full transitive reach with the
   existing cycle guard); the 3-hop bound stays a DISPLAY rule only. Applies
   to recall's out-branch ranking; the island walk's reachable-set coverage
   is already component-invariant and stays.
3. **Spine preference: an unvisited continuation beats a stronger visited
   one.** At each step, if the best-ranked candidate is already rendered but
   an unvisited candidate exists, take the unvisited; the visited edge
   becomes a `^` branch (peer's triangle-plus-tail case: the tail joins the
   spine instead of being orphaned). A repeat still terminates the spine only
   when NO unvisited candidate remains.
4. **Both MCP tool descriptions rewrite to the shipped truth**: labeled
   arrows (`-word->`, multi-word, bare `->`, `=word=>`/`==>` cross-lane);
   the relations field's fork tree with its branch-cap and `^`; the
   EXPLICIT hop-qualification rule ("every hop address is relative to the
   ROOT line's session — a bare `T<m>` anywhere on the tree means the root's
   session, never the previous hop's"); ascending lane lists and island
   order; the branch anchor rule from decision 1; the `S<n>/T<m>` node
   selector. Keep the descriptions' existing voice and length discipline.
5. **The seam marker dedupes**: when the RECENT part's first session equals
   the OLD part's last, the RECENT part's leading `[S<n>]` marker is
   suppressed at the join. Marker count == switch count + 1 across the WHOLE
   card, asserted on a single-session >boundary fixture.
6. **Hygiene (peer, non-blocking, do both):** derive lane islands
   independently of `buildComponentReport`'s `MIN_REPORTED_LANE_MEMBERS`
   threshold (or assert the coupling so raising the threshold fails loudly
   instead of silently dropping small islands); leave `selectLaneChainPath`
   deletion OUT of scope (cleanup candidate, not this ticket).
7. **Out of scope:** the console; settlement prompt; election; budgets;
   version bump; push.

## Acceptance criteria

- [x] The peer's counter-example (`R→A`, `A→B`, `A→C`) renders C's branch
      anchored at A (`└ T<A> -indexes-> T<C>`), never bare under R —
      asserted; and a root-forked branch renders byte-identical to today.
- [x] The recall settled example (T1898) and island settled example still
      render byte-identical for their root-forked branches — asserted.
- [x] A fixture where a deep 6-hop thread competes with five 3-hop threads:
      the deep one wins the main spine and shows `-> ..` — asserted (the
      bounded-coverage counter-case).
- [x] Triangle-plus-tail: the tail joins the spine, the closing edge is a
      `^` branch — asserted.
- [x] Single-session segment crossing the OLD/RECENT boundary: exactly ONE
      `[S<n>]` marker; a genuinely two-session card keeps its two — both
      asserted; re-render the real E70 card and report the marker count.
- [x] Both tool descriptions contain the root-relative qualification
      sentence and no longer contain `=>`-means-indexes, flat `→/←`
      relation lines, or "newest-first" for lanes — asserted by grep in the
      report.
- [x] `MIN_REPORTED_LANE_MEMBERS` decoupling or loud-failure assertion —
      shown in the report.
- [x] Every new/changed test mutation-verified (backup after implement,
      needle-assert + print — mind multi-site needles, red, md5 restore,
      green).
- [x] `npx tsc --noEmit` clean, `node scripts/build.js` succeeds, `bun test`
      green; baseline 3970/0 — account for every delta.

## Notes

Production DB strictly read-only. Do not tick your own boxes — report
per-item; the reviewer ticks.
