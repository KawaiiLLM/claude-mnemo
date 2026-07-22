# 05 — Production blockade regression

**What to build:** The end-to-end regression that makes the 2026-07-22 dream blockade impossible to reintroduce unnoticed. One fixture encodes all three production shapes inside a single due content day: (a) a completed root turn receiving a late child-agent `PostToolUse` (S15233 shape); (b) a `provisional` turn with pending observations and no stop, followed by a later turn in the same session (S15440 shape); (c) an `active` turn whose valid `turn-stop` sits behind terminal-owner observation pollution (S15410 shape). The test enters through the existing hook-to-worker seam — raw Claude Code hook payloads through the hook command, production normalization and handlers, the worker request boundary — and finishes at the database and diary-claim interfaces. The decisive assertion is causal: the diary item is unclaimable before the end-event repair and claimable after it, because extraction regained terminal state — not because readiness was weakened. A separate test demonstrates that a task-completion notification and a child `PostToolUse` are independent events: the notification follows the normal prompt path while the child hook still cannot write into the parent turn or the notification turn.

**Blocked by:** 01 — Sidechain ownership filter; 04 — End-event orchestration.

**Status:** ready-for-agent

- [x] The three-shape fixture runs through the real hook command + worker seam with seeded in-memory databases and fake processors; no live Claude call; explicit temporary data root under the existing HOME sandbox (main-assembly tests pass a dataRoot).
- [x] Assertions: child hooks create no root observation; root hooks still create one; terminal-owner queue rows are retired; each stranded turn reaches terminal state via normal completion or the floor; no unrelated current-day turn is modified.
- [x] Diary causality: the item is unclaimable before repair and claimable after; the readiness guard itself is asserted unchanged.
- [x] Notification-independence test: the completion notification and the child `PostToolUse` are distinct channels; neither pollutes the other's turn.
- [x] Full test suite passes.
