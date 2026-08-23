# 04 — Checker report 1 speaks lane states and consume-class adoption

**What to build:** `lane_check`'s report 1 gains two facts per lane, on both
the CLI and the settlement compact surface:

- a state line — closed-valid / closed-invalid / open (with last declarer when
  open) — read from ticket 02's shared lane-state helper, never re-derived;
- `used[...]` beside the existing `grounds[...]`/testimony in cited-from-
  outside: consume-class external citations of the lane, so a reader no longer
  mistakes consume-adopted lanes for unadopted ones (the T1351 trap).

**Blocked by:** 02 — Election core module (owns the lane-state helper's home in
the interpretation core; this ticket only consumes it).

**Status:** ready-for-agent

- [ ] Report 1 renders the three states correctly on fixtures covering
      closed-valid, dead-core invalid, and reopened/open lanes
- [ ] used[...] lists external consume citations, excludes members' in-lane
      edges and testimony, and reaches both CLI and settlement outputs within
      the compact budget
- [ ] Existing report 2/3/4 outputs byte-stable; typecheck clean; load-bearing
      properties declared per criterion
