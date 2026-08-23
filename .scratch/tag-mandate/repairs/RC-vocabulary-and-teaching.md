# RC — retractSupersedes, the settlement projection switch, prompt sync, teaching copy

**What to build:** peer findings P1-2, P1-4, P1-5, P2-4, P2-5, P2-7 plus
the settlement half of P1-1, from
`.scratch/tag-mandate/repairs/peer-round.md`, plus two hand-offs RA's
report flagged.

1. **P1-1 settlement half:** `checkWindowLanes` (note-settlement-sdk-query)
   builds its projection with the landed `{ kind: "turns", turnIds }` scope
   from the job's frozen `writableTurnIds` — lane_check and commit judge
   the SAME projection the writable set defines. Real-handler tests:
   lookback E1/E3 and external-endpoint E2 now refuse commit.
2. **P1-2:** a RETRACTION-ONLY `retractSupersedes` on both write paths
   (definitions schema, note retraction resolution, citations retraction
   acceptance, settlement facade). Never restore the assertion. Test:
   E2 refusal → retractSupersedes → same-run commit succeeds.
3. **P1-4/P1-5/P2-5 sync:** the authored text at
   `.scratch/tag-mandate/issues/06-prompt-text.md` was amended (T1466) —
   coverage fields now include title/insight, step 4 routes
   verifies/refutes, Block C ends with the one-successful-commit rule.
   Integrate the amended blocks into `note-settlement-prompt.ts` exactly as
   before (the durable verbatim guard reads the authored file, so the
   production copy must match word-for-word again).
4. **P2-4:** the settlement top-level note description splits assertion
   (mandatory tags for extends/narrows) from bare legacy retraction; add
   the surface to the teaching-surface guard.
5. **P2-7 + RA hand-off:** the E5 refusal copy — proper-superset is a
   BRANCH only when rooted at a parent-lane node (independent chains take
   independent exact sets), and the line must name `error.nodeId` (the
   dangling node) explicitly now that the anchor is the edge-owning citer
   ("this turn dangles" is false for role: source).
6. **RA hand-off, gate fixture:** an extra-source E5 blocks the window
   owning the CITER; a window containing only the dangling node commits
   clean — both asserted through the registered commit handler.

**Blocked by:** RA (landed) and RB (the grant-semantics repair — shared
files).

**Status:** ready-for-agent (dispatch gated by the delegator on RB's
acceptance commit)

- [ ] Each numbered item pinned per its own description; ledger scenarios
      red-then-green where feasible
- [ ] Territory: src/worker/note-settlement-sdk-query.ts,
      src/worker/note-settlement-prompt.ts, src/mcp/definitions.ts,
      src/mcp/note.ts (retraction resolution only), src/db/citations.ts,
      src/worker/note-settlement-turn-facade.ts (retraction path only),
      their tests. NOT lane-checker* (RA landed, leave it), NOT
      write-gate.ts/recall.ts/handlers.ts (RB's, landing first)
- [ ] Load-bearing properties declared for mutation acceptance
