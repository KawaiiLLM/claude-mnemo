# 03 — Stranded-turn liveness repair

**What to build:** A repair routine that restores a reachable completion path for turns stranded by lost or misattributed completion tokens — scoped strictly to content days already due for diary processing, so an end event never scans unrelated recent work. A nonfinal (`active`/`provisional`) turn is structurally stranded only when its main response is present AND completion is evidenced by at least one of: an existing queued `turn-stop`, a later turn in the same root session, or an existing invalidation signal. Merely crossing the content-day boundary is never sufficient — genuinely running background work is left alone. Recovery prefers normal completion: if the turn's original session environment is registered, repair enqueues a deduplicated `turn-stop` and lets the ordinary worker finish extraction. Only when a completion-evidenced closed-day turn has no reachable execution path does repair apply the existing model-free completion floor: preserve a usable partial record as `extracted`, otherwise mark the turn `failed` — no fabricated summary content. Flooring atomically retires all remaining observation queue rows and obsolete `turn-stop` rows for that turn. Every operation is idempotent: repeating repair on an already-terminal turn is a no-op.

**Blocked by:** 02 — Terminal-owner queue hygiene (repair assumes terminal-owner pollution is retireable through the hygiene mechanism).

**Status:** ready-for-agent

- [x] Stranded detection tests: each completion-evidence source (queued stop / later same-session turn / invalidation signal) marks a turn stranded; a nonfinal turn with none of them — or with no main response — is left untouched even when its content day is past.
- [x] Repair scope tests: turns outside due content days are never inspected or modified.
- [x] Environment-available path: deduplicated `turn-stop` restoration completes extraction through the ordinary worker; no duplicate stop rows on repeated repair.
- [x] Environment-unavailable path: completion floor preserves usable partial extraction as `extracted`; a turn with no usable record becomes `failed`; floored turns leave zero queue residue (observations and stop rows both retired atomically).
- [x] Idempotency: running repair twice over the same fixtures produces no additional writes or status changes.
- [x] Full test suite passes.
