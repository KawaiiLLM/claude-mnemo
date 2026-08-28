# 12 — recall's relations field becomes a fork tree

**What to build:** `buildTurnRelationLines` (src/mcp/relations-view.ts) stops
emitting flat one-hop lines (`→ consume T1406` / `← consume from T1515`) and
renders the node's position in the graph as a tree. User ruling 2026-08-28
[S15069/T1913], example format settled at [S15069/T1916] on real data:

```
S15069/T1898 -extends-> T1895 -extends-> T1894 -narrows-> T1893 -> ..
            └<-narrows- T1899
            └<-indexes- T1901
```

**Blocked by:** 11 — consumes its shared arrow formatter.

**Status:** resolved — landed as `d11fcff`; every criterion re-checked per-item
and independently spot-verified (suite green, tsc clean; real T1898 tree
matches the settled shape byte-for-byte on a source probe — NB the reviewer's
first probe printed `Tundefined` because `buildTurnRelationLines` now REQUIRES
`promptNumber` in its turn argument, a signature change any external caller
must follow). Branch cap RELATION_TREE_BRANCH_CAP = 4 (matches the sibling
antecedent cap). Shared module src/mcp/relation-tree.ts now holds the arrow
formatter, pair-combine and D8 tie-break comparator for both consumers.

Worker finding accepted: the recall tree keeps every hop's address relative to
the fixed ROOT session (the file's existing formatRelationAddress convention),
not to the previous rendered token — the chain's old rule has no clean
generalization past one line. Judgment call, endorsed.

## Decisions (settled — implement as given)

1. **Root line**: the turn's own `S<n>/T<m>` address, then the MAIN chain —
   the first out-branch extended transitively. Branch/hop selection reuses
   the lane chain's one-route logic (coverage-greedy, word rank, recency) —
   extract it shared rather than reimplementing; that extraction is in scope.
2. **Every other out-edge is a `└-word->` branch line**, each extended the
   same way. Extension depth: 3 visible hops, then `-> ..`. Alignment: `└`
   lines indent under the root address as the settled example shows.
3. **In-edges render as `└<-word-` branches, one hop, never extended** — the
   arrow still points citer→cited, so an in-edge reads right-to-left into
   the root. The "was this later overridden" query lives here; in-edges are
   NOT optional.
4. **Duplicate targets: render the edge, mark `^`, never re-expand.** A node
   already rendered anywhere in this tree renders as `-word-> T1899 ^` when
   cited again (the indexes-fan-over-a-chain case is common — settled at
   [S15069/T1916]). Each node expands at most once per tree.
5. **Lane detail is THIS surface's job**: cross-lane edges double-stroke AND
   carry `{tail→head}`; same-lane placed edges carry `{lane}`; unplaced carry
   nothing. (Compact surfaces show bare arrows only — ticket 11 decision 4.)
6. **Budget**: the field participates in recall's existing truncate
   conventions. Branch count caps (pick a constant, justify it) with a
   trailing `… +N more` line when cut; the report states the constant.
7. **Out of scope:** the lane view and node selector (ticket 13); every other
   recall field; the flat format's callers outside relations (if any share
   `formatRelationLine`, survey and report).

## Acceptance criteria

- [x] Real-DB check on T1898 (read-only): the tree matches the settled
      example's shape — main chain through T1895→T1894→T1893, in-branches
      from T1899 (narrows) and T1901 (indexes) — pasted in the report.
- [x] Out-branches extend ≤3 hops then `-> ..`; in-branches never extend —
      both asserted.
- [x] `^` dedupe: a fixture where the root's indexes fan hits a node already
      on the main chain renders the edge with `^` and no re-expansion —
      asserted.
- [x] Lane suffixes: `{lane}` same-lane, `{tail→head}` cross-lane with
      double-stroke, nothing when unplaced — asserted on all three.
- [x] A turn with no edges renders exactly what it renders today (empty) —
      asserted.
- [x] Branch cap: fixture exceeding it shows `… +N more` — asserted.
- [x] Every new/changed test mutation-verified (backup after implement,
      needle-assert + print, red, md5 restore, green).
- [x] `npx tsc --noEmit` clean, build succeeds, `bun test` green; account for
      every delta from the baseline you start at.

## Notes

Production DB strictly read-only. Do not tick your own boxes — report
per-item; the reviewer ticks.
