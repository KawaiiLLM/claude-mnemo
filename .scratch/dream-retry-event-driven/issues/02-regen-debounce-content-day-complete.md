# 02 — Dream regen debounce: dream a content-day only once it is complete

**What to build:** A content-day is dreamed once, after its material is done — not once per straggling extraction batch. Today, after a dream commits and settles, a turn for that content-day that finalizes later re-marks the day stale and re-dreams it (the watermark race; observed 2026-07-20, content-day 07-19 committed twice at 11:51 and 12:53 because its extraction ran to ~13:05). A stale/re-enqueued dream day becomes claimable only once its content-day has ended AND it has no non-finalized turns, collapsing the straggler re-dreams into a single dream against complete material.

**Blocked by:** 01 (builds on the unified day-state machine and shares the diary claim/ready query region).

**Status:** ready-for-agent

- [ ] The completeness gate lives entirely in the diary claim/ready predicates (`claimNextDiaryItem` / `hasReadyDiaryItem`) — NOT in the queue processor, which only ever sees an already-claimed item.
- [ ] A dream day is claimable only when its content-day has ended (now past its boundary end, using the persisted timezone + `dream_hour` boundary already used by `markSettledDiaryDayStaleForTurn`) AND no turn bucketed to that content-day is non-finalized.
- [ ] "Non-finalized" is EXACTLY `status IN ('active','provisional')`. Every other status (`extracted`, `skipped`, and any future terminal status) is finalized and must NOT block. It is NOT implemented as `status != 'extracted'` (which would let `skipped` block a day forever).
- [ ] The existing post-settle watermark race-close (`markDayStaleAndEnqueue`) stays: a turn finalizing mid-dream still re-enqueues the day, but the completeness gate holds the re-claim until the day is complete again.
- [ ] A day whose turns are all `extracted`/`skipped` and whose content-day has ended is claimable; a day with an `active` or `provisional` turn, or whose content-day has not yet ended, is withheld.
- [ ] Tests at `tests/db/diary-state.test.ts`: withheld while content-day open; withheld while an `active`/`provisional` turn exists; claimable once ended AND all turns finalized; a day with only `extracted`/`skipped` turns is not blocked (guards the `status != 'extracted'` misread).
- [ ] `bun test`, `tsc`, `bun run build` green. Read-only git. No version bump, no `.cjs` hand-edit, no touching live `~/.claude-mnemo` data.
