# 02 — Terminal-owner queue hygiene

**What to build:** The extraction worker stops buffering pending observations whose owning turn can never complete. Before an observation queue item enters a session buffer, the worker checks its owning turn: a missing owner or an owner in any terminal status (`extracted`, `skipped`, `failed`, `undone`) causes the item to be retired instead of buffered. Retirement marks the observation skipped and deletes its queue row in one atomic transaction, so queue and observation state cannot disagree after a crash. Observations owned by `active` or `provisional` turns flow through the existing path with zero behavioral change. This removes the second-order failure where terminal-owner pollution ahead of a valid `turn-stop` delays an unrelated turn's completion indefinitely.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [x] Queue tests: one case per terminal owner status (`extracted`, `skipped`, `failed`, `undone`) plus a missing-owner case — each retires without entering a buffer; observation ends up skipped and its queue row is gone.
- [x] Retirement is atomic: observation state update and queue-row deletion happen in a single transaction.
- [x] `active` and `provisional` owners process exactly as before (existing streaming-extraction tests stay green unmodified).
- [x] A valid `turn-stop` queued behind terminal-owner observation rows becomes processable once those rows are retired (S15410 shape, unit level).
- [x] Full test suite passes.
