# 04 — Console range selector: the scope narrows honestly, nothing gets amputated mid-payload

**What to build:** the console graph gets a TURN-INTERVAL SELECTOR, and
the byte budget drives interval choice instead of field amputation (user
rulings S15069/T1496 + T1498).

Background: the 1MB `RESPONSE_BYTE_SOFT_MAX` was advisory guesswork (its
own doc says so) and the trim loop sacrificed the graph's semantic payload
— live segment-60 measurement: 1219 turn rows ≈ 920KB kept, 73KB
laneCheckText kept whole, edges double-cut by `GRAPH_EDGE_MAX` (3400 →
1000) then the byte loop (1000 → 280): the user saw a graph with no edges.
The page renders 1219 nodes without lag, so the caps were never the real
constraint.

Design:

1. **Caps rise to measured reality** (T1496 ruling): `RESPONSE_BYTE_SOFT_MAX`
   1MB → 8MB, `GRAPH_EDGE_MAX` 1000 → 10000, re-examine `WIDEN_NODE_MAX`
   alongside. Today's whole-segment scope (~1.5MB) renders complete with
   zero narrowing.
2. **Interval selector** (T1498 ruling): session and segment scope views
   gain a range bar over prompt/event order. The graph API accepts an
   interval parameter; the response renders that interval's turns plus the
   edges among them (election tiers stay computed on the full snapshot —
   existing property, keep it). The bar shows the currently-rendered
   interval and lets the user pick any other; every request is
   budget-guarded the same way.
3. **Budget = auto-interval, never amputation**: when a requested scope
   would exceed the budget, the server auto-selects the NEWEST interval
   that fills it — walk backward from the newest turn, adding each turn
   and its induced edges, until the next turn would overflow — and returns
   that complete sub-graph with the chosen interval named in the banner
   and reflected in the range bar. The old drop-edges-then-turns loop
   RETIRES. The `unfittable` refusal envelope survives only for the
   degenerate case an interval of one turn still overflows.
4. Banner semantics update: "partial" now means "an older interval is not
   shown — slide to see it", never "rows inside the shown interval were
   silently removed". The partial-lane_check caveat stays (the embedded
   text still reflects the rendered scope, not the whole stock).

**Blocked by:** None — can start immediately (console files free).

**Status:** ready-for-agent

- [ ] Whole segment-60 scope renders untrimmed under the raised caps
      (fixture at today's sizes)
- [ ] An over-budget fixture returns the newest budget-filling interval,
      complete (every in-interval edge present), interval named in meta;
      the old amputation path is gone (pin: no response ever drops an
      edge whose endpoints are both inside the returned interval)
- [ ] The interval parameter round-trips: requesting an older interval
      returns that interval, budget-guarded identically
- [ ] Range bar renders the current interval, supports picking another,
      and reflects auto-narrowing when it happens
- [ ] Election tiers unchanged by interval choice (computed pre-narrowing)
- [ ] Territory: src/worker/console-api.ts, src/worker/console-shell.html
      (+ regenerated console-shell.ts), src/worker/server.ts (route param
      only if needed), their tests. NOT src/shared/lane-checker*
- [ ] Load-bearing properties declared for mutation acceptance
