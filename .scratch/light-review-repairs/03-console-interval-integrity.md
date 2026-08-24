# 03 — The interval promise holds against every bound (peer P1-3, P2-4/5/6/7)

**What to build:** ticket 04's contract — "no response ever drops an edge
whose endpoints are both inside the returned interval" — must hold
against ALL bounds, and the two payload halves get ONE declared
semantics.

1. **P1-3 + P2-7, interval selection moves onto the full index.** Today
   `GRAPH_EDGE_MAX` (oldest-first, ~706-739) and `WIDEN_NODE_MAX`
   (oldest-prefix) cut the projection BEFORE `applyGraphAutoInterval`,
   so the walk closes over a damaged graph (in-interval edges silently
   missing) and, past 10000 turns, the true newest turns become
   unreachable by any interval. Fix: the auto-interval walk (and a
   user-picked interval's load) selects over the FULL turn/edge index;
   the count caps apply AFTER interval resolution, at which point they
   are (a) newest-first if they ever fire and (b) reported as bounds.
   The pre-existing test that enshrined oldest-first pre-trim updates to
   the new order.
2. **P2-4, self-edges join the walk.** The induced-edge check misses
   `citingId === citedId` (the other endpoint IS the candidate, not yet
   in includedIds). A self-edge rides in with its turn; over-budget
   self-edge fixture pins it.
3. **P2-5 + P2-6, one semantics for lanes/laneCheckText: FULL SNAPSHOT,
   said out loud.** Decision (consistent with the election-tier
   precedent): lanes and laneCheckText stay whole-scope; the shell's
   copy stops claiming they reflect the current interval and says
   "lanes and checker text cover the whole scope; the graph shows the
   selected interval". Every lane chip / terminus / focus badge renders
   addresses from server-supplied fields — the focus badge's raw
   `T${sel}` print and `addrOf`'s reachable dbid fallback both go; the
   lanes payload carries the addresses it needs so the fallback is
   asserted unreachable.

**Blocked by:** None.

**Status:** ready-for-agent

- [ ] In-interval edge completeness holds under a fixture exceeding the
      (temporarily lowered in-test) edge cap — the P1-3 counterexample
      is red pre-fix
- [ ] >WIDEN_NODE_MAX fixture: the newest turn is reachable in the
      default view and by interval navigation
- [ ] Self-edge survives the over-budget walk with its turn
- [ ] Shell copy states full-snapshot lanes/checker; no reader-facing
      `T<dbid>` remains (badge + lane fallback pinned)
- [ ] Territory: src/worker/console-api.ts, src/worker/console-shell.html
      (+ regenerated console-shell.ts), their tests
- [ ] Load-bearing properties declared for mutation acceptance
