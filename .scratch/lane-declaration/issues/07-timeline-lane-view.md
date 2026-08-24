# 07 — `timeline` renders a lane as a chain

**What to build:** `timeline(id="E60/L*", view="lane")` lists a segment's lanes, each as one header line plus one representative chain; `E60/L3` renders a single lane.

**Blocked by:** 03.

**Status:** ready-for-agent

Spec: `.scratch/lane-declaration/spec.md` (Rev 2) — D8. Target shape (from the user's own sample):

```
[L1] 08-17 18:19 ⚖️ arc-spine-redesign
    ◎T53 => T48 -> ...(7)
[L2] 08-17 18:20 🔧 codex-workflow
    T25 -> T24 -> ...(8)
```

- [ ] Header: `[L<n>]`, the lane's NEWEST node's time, the NEWEST node's own type emoji ([S15069/T1567] — the modal one read as 'the latest activity' beside a header time taken from that same newest node, and misread hardest exactly when a long design lane ends in one delivery turn), the tag. Lanes ordered newest-first.
- [ ] The chain starts at the newest node and walks backward. Among candidate paths it takes the one covering the MOST member turns within the item budget; the relation preference `extends`/`narrows` > `indexes` > `consume` > `override` is ONLY a tie-break between equal-coverage paths. A greedy walk that shows a two-hop branch while hiding a five-node one is a failed acceptance (peer finding P2-7).
- [ ] `=>` marks an edge into an INDEXED node; `->` is ordinary continuation. The trailing `(N)` is the lane's member count.
- [ ] A turn inside the viewed segment renders bare (`T8281`); a turn from another segment carries its own `E<seg>/` prefix and a homeless one `S<n>/` — cross-segment lanes are legal now, so this case is real.
- [ ] Tests: header composition (the emoji follows the NEWEST node even when another type dominates the membership, the count), path selection on a diamond where the short branch is newer, the foreign-turn prefix, and budget truncation.

**File ownership:** `src/mcp/timeline.ts`, `src/mcp/definitions.ts` (the timeline description only) and their tests.
