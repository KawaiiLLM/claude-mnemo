# 13 — The lane view renders islands as trees, and timeline learns a node selector

**What to build:** user ruling 2026-08-28 [S15069/T1915]: the lane view's
single representative chain is replaced by one tree PER connected component
(island), and `timeline` accepts a turn address to render one node's tree.

```
[L3] 🔧 milestone-design
  S15069/T1901 -extends,indexes-> T1900 -narrows-> T1899 -narrows-> T1898 -extends-> T1895 -> ..(23)
              └-indexes-> T1893 -extends-> T1881 -extends-> T1880 -> ..
              └-indexes-> T1878 -extends-> T1873 -> ..
```

**Blocked by:** 12 — shares its tree renderer.

**Status:** resolved — landed as `a5f76f3`; every criterion re-checked
per-item and independently spot-verified. Suite **3970/0** (3956 + 14), tsc
clean. Real milestone-design lane renders per-island trees (main island 38
members with the indexes fan and narrows chain visible; a real
override+verifies fork at S15069/T217); `timeline(id="S15069/T1898")` renders
header + byte-identical recall tree. Reviewer mutation removing the
`cameFromId` parent-exclusion from the island walk turned the island test red;
restored byte-identical, green.

Worker findings accepted, three structural: (1) the lane chain's MAX-based
coverage DP is WRONG for bidirectional walks (a leaf beside a hub can sweep an
unrelated branch and outscore a genuinely deep node) — islands use plain
reachable-set-size, which is component-invariant, so word-rank-then-recency is
the honest fork discriminator; (2) bidirectional expansion requires excluding
the edge you arrived by, or every hop spawns a spurious `^` lookback branch;
(3) coverage caching across sibling calls is order-dependent-unsafe once
bidirectional — fresh visited-set per call. Also: `selectLaneChainPath` is now
production-dead (kept, own unit test, cleanup candidate); the truncation
ellipsis is now two dots `-> ..` per the settled examples.

**OPEN RESIDUE — singleton flooding (needs a user ruling, ticket 15
candidate):** milestone-design currently decomposes into 37 islands of which
~30 are SINGLETONS — freshly noted turns whose edges settlement has not
written yet. The view leads with a wall of `S15069/T1921(1)` one-line islands
before the real trees. The ticket said islands newest-root-first and the
worker built exactly that; the flood is a data-shape reality the ticket did
not anticipate (lane_check's own island count has the same
singleton-vs-severance ambiguity, recorded 2026-08-27). Candidate fix: fold
zero-edge singletons into one trailing `unlinked:` line after the real trees.

## Decisions (settled — implement as given)

1. **Per-island trees.** A lane's members + declared edges decompose into
   connected components over UNDIRECTED adjacency (the same connectivity
   lane_check's island warning counts). Each island renders one tree; islands
   separate with a blank line; islands order newest-root-first.
2. **Root = the island's newest member** (the existing chain's start
   convention, kept).
3. **Expansion is BIDIRECTIONAL** — out-edges `-word->` extended, in-edges
   `<-word-` branches — each node expanded at most once (`^` on repeats),
   so an island renders COMPLETELY exactly once when budget allows. This is
   the fix for the structural gap settled at [S15069/T1915]: an out-only tree
   from the newest member misses siblings that cite a shared target
   (`A→C←B` loses B). Unlike recall's tree (ticket 12 decision 3), in-edges
   here DO extend — coverage of the island is the point; reuse the shared
   renderer with that switch.
4. **Tails**: the island tree's trailing `(k)` is the ISLAND's member count;
   the lane header keeps the lane's total count as today. The
   `DEFAULT_LANE_CHAIN_ITEM_BUDGET` idea survives as a per-island node
   budget — truncated islands end `-> ..` before `(k)`, matching today's
   convention.
5. **Node selector**: `timeline(id="S<n>/T<m>")` becomes legal and renders
   ONE header row (the turn's milestone-style row: `[S<n>/T<m>] MM-DD <emoji>
   <title>`) followed by the SAME tree recall's relations field shows for
   that turn (ticket 12's renderer, recall-detail lane suffixes included) —
   one shared implementation, two entry points. Read grants record the
   rendered turns the same way other timeline views do.
6. **`/L*` multi-lane listing** keeps its pageBudget pagination; a lane's
   taller render just consumes more of the page.
7. **Out of scope:** the console; lane_check's own reports; election;
   settlement prompt teaching (a severed lane now LOOKS severed in the lane
   view — worth a follow-up teaching note, record it, don't write it).

## Acceptance criteria

- [x] A two-island fixture renders two trees, blank-line separated, each
      rooted at its island's newest member, `(k)` = island size — asserted.
- [x] The `A→C←B` shape renders ALL THREE nodes in one tree (B via an
      in-edge branch) — asserted; this is the criterion that proves
      bidirectional coverage.
- [x] `^` dedupe works across the whole island tree — asserted.
- [x] A truncated island ends `-> ..(k)` with k the FULL island size —
      asserted.
- [x] Real-DB smoke (read-only): the milestone-design lane renders one tree
      shaped like the settled example (root S15069/T1901, indexes fan,
      narrows chain) — pasted in the report.
- [x] `timeline(id="S15069/T1898")` renders the header row + the same tree
      bytes recall's relations field produces for T1898 (modulo the header)
      — asserted by comparing the two outputs in one test.
- [x] An invalid turn address still errors with the existing id-grammar
      message shape — asserted.
- [x] Every new/changed test mutation-verified (backup after implement,
      needle-assert + print, red, md5 restore, green).
- [x] `npx tsc --noEmit` clean, build succeeds, `bun test` green; account for
      every delta.

## Notes

Production DB strictly read-only. Do not tick your own boxes — report
per-item; the reviewer ticks.
