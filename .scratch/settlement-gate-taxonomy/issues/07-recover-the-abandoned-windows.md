# 07 — Recover the two abandoned windows

**What to build:** the ~100 turns that the livelock stranded get settled, and the recovery is verified rather than assumed.

**Blocked by:** 04 — re-enqueueing before the gate is demoted would just reproduce the livelock.

**Status:** ready-for-agent

Spec: `.scratch/settlement-gate-taxonomy/spec.md` — the Problem Statement names the two windows.

- [ ] Re-enqueue S15069 windows 2002-2051 and 2202-2251 using the `backfill` trigger — the ONLY trigger exempt from the monotonic window floor, and never produced by an automatic planner.
- [ ] The worker must be running the code this batch produced before either window is re-dispatched. The worker process observed on 2026-09-01 was still on 0.27.0 while 0.28.0 had shipped — confirm the running version explicitly, do not infer it from the release having happened.
- [ ] Verify per window: the job reaches `done`, the turns carry settled notes, and the run's own commit count is 1 or 2 — a re-run that needs three or more commits means this batch did not fix the mechanism.
- [ ] Report the recovered runs' cost against the 14-day baseline of record ($0.77/run early, $12.43/run at the livelock).
- [ ] Nothing in this ticket writes to the production database by hand. Recovery happens through the enqueue path.
