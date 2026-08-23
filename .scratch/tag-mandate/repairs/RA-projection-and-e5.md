# RA — Projection completeness, E5 repair-powered anchors, render caps, token collision

**What to build:** peer findings P1-1 (loader half), P1-3, P2-8, P2-9 from
`.scratch/tag-mandate/repairs/peer-round.md` (the authoritative spec —
read it first).

1. `loadLaneCheckScope` gains an explicit turn-id-set scope (the frozen
   writable set as seeds): every seed loads (liveness/skip exemptions via
   loadLiveTurns as today), stance/supplementary passes seed from the FULL
   set, and the out-of-vocabulary loader surfaces an edge whose citing
   side is in-seed even when its external endpoint is not yet in
   allTurnIds (join the endpoint in). The settlement side switches in RC —
   here you only build and pin the loader capability.
2. E5 anchors move to the edge-owning citer per the T1466 ruling recorded
   in the ledger: extra sink anchors at itself; extra source anchors at
   the deterministic earliest citing side among its incoming in-lane
   edges. `nodeId` keeps naming the dangling node; `anchorId` changes.
   Update the render line and the spec's E5 row wording
   (`.scratch/tag-mandate/spec.md`) to match.
3. P2-8: the settlement text render's error list becomes UNCAPPED (the
   CLI digraph may keep MAX_ERROR_RENDER_ENTRIES with its true-total
   line); whatever render the settlement lane_check consumes must show
   every instance the commit gate judges.
4. P2-9: exact-set candidate matching uses the shared collision-free lane
   token (or canonical JSON array compare) — never a join("") that two
   different arrays can collide into.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Loader: turn-id-seed scope pinned (lookback E1, edge-less E3, and
      external-endpoint E2 fixtures load and fire; liveness/skip exempt)
- [ ] E5: extra-source fixture anchors at the earliest citing side owning
      an in-lane edge; extra-sink anchors at itself; golden zero E5 stays
- [ ] Settlement error render uncapped (51+ fixture); CLI cap unchanged
- [ ] Exact-set collision fixture (two arrays joining identically) stays
      two lanes
- [ ] Territory: src/shared/lane-checker*.ts, src/db/lane-checker-load.ts,
      their tests, .scratch/tag-mandate/spec.md (E5 wording only). NOT
      src/worker/* or src/mcp/* (sibling repairs own them)
- [ ] Load-bearing properties declared for mutation acceptance
