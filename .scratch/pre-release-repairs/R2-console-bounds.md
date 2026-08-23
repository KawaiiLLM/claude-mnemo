# R2 — Console bounds integrity (peer findings #2 #3 #11) — HOLD until
# semantic-conformance 02 lands (shared test-file surface)

**#2 (P1) The byte bound is not the wire bound, and some fields are
untrimmable.** applyGraphByteBound measures {turns, edges, lanes,
laneCheckText} but meta is added after (999,797 internal vs 1,000,001 real
on the reviewer's repro); and the trim loop only cuts turns/edges — a
600KB lane tag leaves a ~2.4MB response LABELED as bounded at 1MB. Fix:
assert the bound on the FINAL serialized envelope; when the envelope cannot
fit even with turns/edges empty, return a bounded error/summary response —
never a false applied-bound claim.

**#3 (P1) Independent truncation produces dangling edges.** 2001 turns +
edge T1→T2001: turns trim to 2000, the edge survives with no endpoint in
the payload. Fix: after count/byte trimming, filter edges to the retained
node set (endpoint-closed projection) and pin the invariant: every returned
edge's both endpoints exist among returned turns.

**#11 (P2) Partial-graph election tiers are unexplainable.** Tiers are
computed on the full projection then turns/edges truncate — a visible turn
can carry electionTier granted by hidden nodes. Ruled resolution: keep the
tiers, add `electionCoverage: "full-snapshot"` to meta (schema + shell's
partial banner mentions it) — the tier describes the snapshot, not the
visible subgraph.

Also: repair the semantic-conformance-02 fallout in console-api.test.ts's
fake LaneCheckerResult stubs (the new vocabularyConformance field) if the
02 worker has not already.

**Territory**: src/worker/console-api.ts, tests/worker/console-api.test.ts,
the shell's partial banner line if #11's mention requires it (regenerate +
byte guard). NOT server.ts/console-shell interactions beyond that line
(R3 owns them).

**Status:** blocked (dispatch after semantic-conformance 02 lands)

- [ ] Reviewer's #2 repro pinned: the final envelope byte length is what the
      bound governs; unfittable envelope → bounded error, no false claim
- [ ] #3 invariant pinned: endpoint-closed edges after every trim path
- [ ] electionCoverage in meta + schema tests; shell banner regenerated
- [ ] Targeted suites + typecheck green; control-byte scan clean
