# 07 — The stage-2 edge pass

**What to build:** the stage-2 agent: its prompt and driving facade. Duties per spec Rev 5: work ONLY the persisted snapshots (worklist + writable set + member snapshots); per worklist lane, read members coherently and write in-lane edges; one crossing pass; reconcile pre-existing bare drafts per pair (citing turn in-set); discharge removed-side debts; retract homeless-group drafts with cause through the audit helper (incl. bare-restored); session narrative writes at this commit; the terminal commit runs the full gate set and computes the shape numbers as the induced subgraph on frozen vertices (weak components, unordered pairs, per-relation cross counts — reviewer guardrail 2: an independent snapshot projection, never the live-widening checker membership).

**Blocked by:** 02, 04, 05. (Sequenced AFTER 06 in execution to avoid shared-facade races; build against synthetic snapshots where 06's outputs are not yet real.)

**Handoff from ticket 06:** settlement prose writes land in the `notes` SHADOW table, not turns.title — assert via getShadowNote, never getTurnById().title (cost 06 a red). The worklist is derived from the post-projection DB (owning segment x declared lane per writable turn); synonym-reused zero-mutation lanes appear via their writable members. Stage-1's real dispatch is injectable but UNMOUNTED in server.ts (08 mounts it) — your tests drive the dispatch/facade seams directly.

**Handoff from ticket 05:** lane_check's actionable preview is NOT provenance-aware — a removed-side-citer's E3 prints as actionable while the terminal gate correctly ignores it. Your stage-2 teaching must tell the agent that an E3 anchored on a relation-only citer is NOT its debt (the gate is the truth, the preview lags); the renderer model rework is deferred, do not attempt it.

**Status:** landed (not released). Deviation: draft reconciliation is a TAUGHT duty (retract-then-place), not a write-time absorb — a mechanical absorb contradicts lane-model-v12 ticket 08's pinned row identity `(pair, relation, tailTag, headTag)`; see the report.

- [x] A seam-driven stage-2 run over synthetic snapshots writes in-lane edges, a crossing edge, reconciles a pre-existing bare draft (absorb, not duplicate — the dupe-row friction dies here), discharges a removed-side debt, and lands the terminal commit (done + cursor + era grant + final metrics in today's shape).
- [x] A homeless-motivated retraction writes the audit row with full composite identity; deleting the last relation records "relation retracted, bare restored".
- [x] Shape numbers: vertices = frozen member snapshot; an edgeless member is its own weak component; a concurrently-added member is invisible; cross counts grouped by relation word; numbers identical when recomputed on a retry.
- [x] Session narrative (session title/content) written at this commit, not before.
- [x] The commit report carries the shape numbers and the homeless-based retractions with causes.
- [x] `npx tsc --noEmit` clean; full `bun test` at the end, deltas accounted.

Territory: NEW stage-2 prompt/facade files + seam tests; consumes 02/04/05 surfaces read-only; does not edit the stage-1 body (06's) or gate internals (05's). Standing footer: prod DB read-only; mutation discipline; report per-item; explicit-path staging; Bin-line stop; no bundle rebuilds; python byte scan.
