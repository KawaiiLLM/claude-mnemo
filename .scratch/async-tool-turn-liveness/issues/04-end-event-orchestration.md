# 04 — End-event orchestration

**What to build:** The repaired end-event order wired into the coordinator, so a dream claim can only follow extraction-liveness repair. Under `Stop`, `SessionEnd`, or `PreCompact` the coordinator runs: (1) drain ordinary extraction work for the triggering event; (2) reconcile due diary days; (3) inspect unfinalized turns and queued observations inside those due content days; (4) retire terminal-owner queue pollution and restore missing completion work (ticket 03's repair); (5) run a second ordinary drain only when repair created executable work — the common path with nothing to repair stays as cheap as today; (6) apply the completion floor only to completion-evidenced turns that remain structurally unreachable after the drain; (7) claim at most one diary item after the unchanged `active`/`provisional` readiness guard passes. Worker restarts reset stale claims before repair so orphaned claimed rows become inspectable on the next end event. `SessionStart` keeps its existing local context recovery but never triggers this global repair or dream work; worker boot alone performs no agent request. Ignored-sidechain and floor events emit structured diagnostics with session/turn identifiers and reason codes, without tool payloads or notification bodies.

**Blocked by:** 03 — Stranded-turn liveness repair.

**Status:** ready-for-agent

- [x] Orchestration tests: `Stop`, `SessionEnd`, and `PreCompact` are equivalent entry points into the repair pipeline; a pure liveness scan or worker boot never runs it.
- [x] Second-drain gating: when repair enqueues nothing, no second drain occurs; when it enqueues work, exactly one additional drain runs before the diary readiness check.
- [x] Dream ordering: the diary readiness guard is evaluated after repair (and after the conditional second drain), and its `active`/`provisional` rule is byte-for-byte unchanged.
- [x] Worker restart resets stale claims before repair, making orphaned claimed items recoverable on the next end event.
- [x] Idempotency across events: repeated Stop/SessionEnd/PreCompact over an already-repaired state neither duplicates stops nor changes terminal records.
- [x] Full test suite passes.
