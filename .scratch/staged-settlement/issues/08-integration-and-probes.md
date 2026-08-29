# 08 — Integration: the two-stage flow becomes THE flow

**What to build:** the contract step. The real stage 1 (06) and stage 2 (07) replace the stub wiring end to end for every trigger type (consecutive, residual, compact, sessionend, backfill); the monolithic settlement prompt retires; the full end-to-end probe set from spec Rev 5 §Testing runs green; docs and bundles land. Release itself (version bump + push) is prepared but HELD for the user's word.

**Blocked by:** 05, 06, 07, 09 (01–04 transitively).

**Status:** ready-for-agent

**Handoffs from tickets 05/06:** mount the real stage 1 in src/worker/server.ts — `stage1Dispatch: createNoteSettlementStageOneDispatch({ db, config, runQuery: createNoteSettlementStageOneSdkQuery({ db, dataRoot }) })`; wire the phase-token predicate into main-agent remember(retag)'s NEW-name path (both tiers) — renaming TO a phase-bearing name must refuse while existing names stay grandfathered; commit the .scratch/staged-settlement/ spec+tickets+fixtures with the docs.

**Handoff from ticket 01:** `src/shared/tag-stripping.ts` survives as a compatibility shim whose NAMES now lie (`findRetiredTopicTag` re-exported with inverted semantics) — switch the importers to `findIllegalTopicTag`/`topicTagRefusalMessage` from `src/shared/topic-tag.ts` and delete the shim.

- [ ] Every trigger type drives topics→edges→done; the monolith prompt is deleted (grep proves no caller).
- [ ] End-to-end probes green: lost verdict (transition lands, dispatch throws → stage 2 runs, no attempt spent); kill between transition and stage 2 (stop hook resumes at edges); kill mid-stage-1 (reclaim spends an attempt, re-runs topics); tuple fencing (stale topics write refused); pre-era snapshot visibility (in snapshot, hidden from lane recall until commit, visible after); homed supersession terminates homeless; per-provenance gate (manufactured E4 + unrelated E6 block, unrelated E3 does not); topic preservation + duplicate no-op + migration retirement (reopen survival).
- [ ] One `bun test` full suite green from clean; `npx tsc --noEmit` clean; `node scripts/build.js` succeeds; bundles rebuilt HERE only, with no sibling mid-edit (check git status for foreign modified source first).
- [ ] CONTEXT.md gains the staged-settlement terms (topic word, stage transition, homeless disposition, transition sequence); an ADR records the two-stage split's why (scope mismatch) and the graph-first rejection.
- [ ] Version sites audit prepared (seven+ sites per standing law) but NOT bumped; no push. Report readiness; the user rules the release.
- [ ] The S18993 manual acceptance gate is NOT run here — the diseased corpus stays frozen until the user orders the rerun.

Standing footer: prod DB read-only; never restart the live worker; mutation discipline; report per-item; explicit-path staging; Bin-line stop; python byte scan.
