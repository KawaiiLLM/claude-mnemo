# 04 — The grant wipe becomes an epoch bump; the age sweep gets its indexes (peer on e81aca6)

**What to build:** two repairs to grant-lifecycle 01.

1. **P1 — the wipe must not be probabilistic.** Today PreCompact's
   two-table DELETE is best-effort: one busy/IO failure and the destroyed
   context's writer keeps whole-field and relations licenses until the
   next compact or the 30d janitor. Replace the DELETE-as-boundary with a
   WRITER CONTEXT EPOCH:
   - a per-writer epoch counter (new tiny table or a stamp row); grants
     and completeness records carry the epoch they were earned under;
   - `checkFieldGate`/`checkRelationsGate` honor only current-epoch
     records — an old-epoch grant is "never read";
   - PreCompact BUMPS the epoch (single-row write — the failure surface
     shrinks from two unbounded DELETEs to one tiny UPSERT), and
   - `SessionStart(source=compact)`'s bare context handler bumps again
     idempotently BEFORE `buildContextOutput` records the roster's new
     grants (context.ts ~230-266) — double-bump is harmless (nothing was
     granted between), and this is the crash backstop the peer asked for.
   - The physical DELETEs demote to hygiene: the age janitor also sweeps
     old-epoch rows; `clearReadGrantsForWriter` stays for SessionEnd-free
     callers if any remain, or retires into the janitor.
   - Pin: with the PreCompact bump artificially failed, the SessionStart
     bump alone still invalidates every pre-compact grant (the e81aca6
     failure-mode test proved notify survives; this one proves soundness
     survives).
2. **P2 — the age sweep needs time indexes.** `sweepStaleReadGrants`
   filters on `read_at_epoch`/`recorded_at_epoch` with only entity
   indexes in the schema — the LIMIT bounds deletions, not the scan.
   Add a timestamp index per table (schema migration, `(timestamp)` or
   `(timestamp, rowid)` per the actual SQLite plan) and pin the plan
   with an EXPLAIN QUERY PLAN assertion (index named, no full scan).

Peer-cleared, unchanged: claim writers gained (not lost) cleanup under
the age sweep; the two tables' independent halves stay conservative;
30d stays as accepted hygiene.

**Blocked by:** None (light-review-repairs 01-03 run on disjoint files;
this one owns write-gate/schema/compact/context).

**Status:** ready-for-agent

- [ ] Epoch bump at PreCompact + idempotent re-bump at
      SessionStart(source=compact) before roster grant recording; both
      pinned through the real handlers
- [ ] Old-epoch grants and completeness are dead to both gates (field
      and relations); same-epoch behavior byte-identical to today
- [ ] The PreCompact-failure fixture: bump forced to fail → SessionStart
      bump alone still invalidates every pre-compact grant
- [ ] Janitor sweeps old-epoch rows and stale-by-age rows; EXPLAIN QUERY
      PLAN pin shows the new time indexes, no table scan
- [ ] Territory: src/db/write-gate.ts, src/db/schema.ts (indexes +
      epoch storage), src/hooks/handlers/compact.ts,
      src/hooks/handlers/context.ts (bump call only), their tests. NOT
      note-settlement-prompt/turn-liveness/console files (siblings)
- [ ] Load-bearing properties declared for mutation acceptance
