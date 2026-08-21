# 01 — indexes vocabulary flip and data migration

**What to build:** the relation word `collects` becomes `indexes` end to end — a
writer can attach/retract `indexes` edges (same-phase aggregation, usable by
decision settlements AND delivery aggregation points like releases), every
teaching/validation surface speaks the new word, and the production DB's stored
rows and CHECK constraint carry it after one rehearsed migration. Spec:
`.scratch/indexes-rescope/spec.md` (the law; read it whole first).

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Shared vocabulary: `EDGE_RELATIONS`/`RELATION_FIELD_NAME`/phase table
      carry `indexes` with SAME-PHASE legality and NO graph-state check; the
      word `collects` survives nowhere in src/ outside migration legacy
      fixtures.
- [ ] The collects flow-membership hard gate (isFlowSettlement/isOwnFlowMember
      wiring) is REMOVED from both write paths (note surface + settlement
      facade). The self-grounds settlement+implementer gate is UNCHANGED and
      stays the vocabulary's ONE graph-state rejection — pin it with a test if
      none exists.
- [ ] The grounds mid-flow warning is untouched.
- [ ] `indexes` joins the flow-inheritance relation set (grounds/consume/
      indexes) in the pure flows module; derivation tests cover a release-like
      turn inheriting through an indexes edge.
- [ ] note tool + settlement facade expose `indexes`/`retractIndexes`;
      rejections name phase facts only.
- [ ] Migration: renames every stored `collects` row to `indexes` and rebuilds
      the CHECK to the new word list; staleness probe keys on the OLD word
      `collects` still present in stored DDL (never on the new word's absence);
      idempotent; fresh-DB skip; UNIQUE-collision-safe.
- [ ] Rehearsed on a /tmp copy of the production DB: copy
      `~/.claude-mnemo/claude-mnemo.db` to a /tmp dir; any WRITE-opening script
      hardcodes+realpath-canonicalizes its trust root, refuses symlinked
      targets, and never takes the path from argv alone. Report row counts
      before/after (indexes count == old collects count, zero loss), a second
      idempotent run, and a smoke read.
- [ ] Targeted tests green; full suite green except the standing stale-bundle
      guard red (NEVER run the bundle build).
- [ ] Report names the single load-bearing property you consider most
      test-critical, for independent mutation verification.

Ownership: yours — src/shared/turn-phase.ts, src/shared/flows.ts,
src/mcp/note.ts, src/mcp/definitions.ts (param names/wiring only; prose
describes belong to ticket 04), src/worker/note-settlement-turn-facade.ts,
src/db/schema.ts, their tests. NOT yours — src/db/flows.ts,
src/db/citations.ts, src/db/edge-signals.ts (ticket 03 edits them in
parallel), src/shared/memory-rubric.ts (ticket 04). If a change seems to
require crossing that line, stop and report instead of editing.
