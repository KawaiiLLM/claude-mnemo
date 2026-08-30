# 12 — The dispatch wait becomes abort-aware (peer impl-review P0) + the scheduler's terminal invariant (P1)

**What to build:** BOTH findings land together (they share the dispatch/scheduler seam).

**Blocked by:** none — sole worker on these files. BLOCKS the release.

**Status:** ready-for-agent

## Part A — P0: the wedged query must not hold the drain

Failure chain (verified by the peer, file:line in their words): POST /settle wraps the WHOLE drain in trackGlobalWork (server.ts ~1666-1681), which only decrements activeGlobalWork / clears globalScanInFlight / releases the outer token when the drain promise settles (~1357-1376); the scheduler awaits the dispatch (note-settlement.ts ~403-408), the dispatch awaits runQuery directly (note-settlement-dispatch.ts ~844-861); the claim monitor's loss verdict only aborts + releases the INNER token (~825-836). An abort-ignoring query therefore wedges dispatch → scheduler → drain forever; idleSince never sets AND globalScanInFlight blocks the idle check (server.ts ~1835-1846) — the forced-exit path is correct but UNREACHABLE.

THE PINNED REPAIR (peer's shape — do not substitute releasing the outer token, which would leave activeGlobalWork/globalScanInFlight uncleaned and double-decrement when the promise finally settles): make the dispatch's WAIT abort-aware — race runQueryPromise against a claim-loss promise; when loss wins: abort, release the inner token, attach a rejection observer to the underlying promise (so a late rejection is swallowed, never unhandled) and DETACH, returning a failure immediately. The scheduler's row re-read then sees generation/status moved ⇒ preempted; the drain settles naturally and the existing trackGlobalWork clears the outer token, the counter and the global promise — once, in one place.

- [ ] The race in the dispatch; loss path returns a failure without awaiting the wedged promise; late settle/rejection of the detached promise is observed and swallowed (no unhandledRejection, no double token release).
- [ ] REAL-NESTING regression (the peer's exact prescription): POST /settle → trackGlobalWork → scheduler → dispatch → a signal-ignoring pending query; trigger claim loss; assert busyCount=0, idleSince set, globalScanInFlight=null; advance 1h with graceful cleanup ALSO pending; the 5s fallback still exits.
- [ ] Ticket-08's isolated never-settles test stays; this new test covers the real topology it missed.

## Part B — P1: any claimed + ok:true is a phantom; the scheduler never completes on trust

Today only edges+ok:true converts to a phantom failure (note-settlement.ts ~475-504); topics+ok:true has the SCHEDULER call completeNoteSettlementJob — a non-structural terminal bypass ("terminal commit is the sole publisher" held only by dispatch discipline). The empty-window branch also completes stage-agnostically from the dispatch (note-settlement-dispatch.ts ~797-801; the helper SQL has no stage fence).

THE PINNED REPAIR: the scheduler treats ANY still-`claimed` row with ok:true as the phantom deterministic failure ("reported a completion the row does not show") — the self-complete branch is DELETED with its tests rewritten (the "writes nothing yet completes" pin at note-settlement-staged-jobs.test.ts ~447-473 dies with the behavior; chain-deletion honesty). The empty-window no-op stays legal by the dispatch explicitly terminalizing BEFORE returning ok (model it as the named empty-window terminal exception — a comment naming it + the completion call inside the dispatch, ideally through a shared terminal helper); the scheduler then judges row `done` ⇒ settled as normal. This converts 04b block 5's positive example into an interface invariant.

- [ ] Scheduler self-complete branch gone; any claimed+ok:true (either stage) ⇒ phantom deterministic failure with the standing idiom text; rewritten tests pin it.
- [ ] Empty-window dispatch terminalizes explicitly before returning; row `done` drives the settled verdict; a test pins the empty-window path end-to-end.
- [ ] The ~90 legacy instant-settlement stubs: fix by having stubs terminalize (a tiny shared test helper) or by asserting the new phantom behavior where the stub's laziness was the point — NO test may keep passing by the scheduler trusting a verdict.
- [ ] `npx tsc --noEmit` clean; scheduler/dispatch/staged-jobs/integration/unified-run + server busy-idle suites green; full `bun test` ONCE at the end incl. stale-bundle guard (REBUILD bundles after — you touch shipped worker code; clean-tree check first).

Territory — sole worker: src/worker/note-settlement-dispatch.ts, src/worker/note-settlement.ts, src/db/note-settlement.ts (only if the terminal helper lands there), tests/worker/* for these, the bundle rebuild. NEVER git stash/checkout/restore; mutation cycles only on own files, md5 before AND after; explicit pathspecs on commit; Bin-line stop; python byte scan; prod DB read-only.
