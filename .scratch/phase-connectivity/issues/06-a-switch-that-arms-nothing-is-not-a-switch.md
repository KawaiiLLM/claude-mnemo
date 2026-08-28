# 06 — A switch that arms nothing is not a switch

**What to build:** phase connectivity stops advertising an arming path it does
not have, and its walk stops reporting a violation it cannot justify.
Confirmed by the reviewer against source after the eighth peer round (Codex,
2026-08-29, Spec P1-4 + P2-5):

1. `PHASE_CONNECTIVITY_GATE_ARMED` is declared at
   `src/worker/note-settlement-sdk-query.ts:552` and **read nowhere**. Ticket
   01's own Status told the reader arming was "a one-line flip" of this
   constant. It is not — the evaluation runs inside `appendReports`, which on
   the success path executes AFTER `writes.commit()`. The reviewer wrote that
   false claim into ticket 01; correcting it is part of this ticket.
2. Both walks stop at `MAX_WALK_DEPTH = 500` and treat exhaustion as
   NOT-REACHED, i.e. as a violation. A cap is defensible; **reporting a
   violation you did not establish is not**, and once armed that becomes a
   false refusal.

**Blocked by:** none. Disjoint from 04/05 — those two must not touch
`note-settlement-sdk-query.ts`, and this one must not touch
`src/db/lane-disposition.ts`, `note-settlement-direct-write.ts`,
`note-settlement-turn-facade.ts` or `note-settlement-membership-facade.ts`.

**Status:** resolved — landed as `b4ff52a1`; every criterion re-checked
per-item by the reviewer. The constant is gone from `src/` and `tests/`
(grep exits 1). Cap exhaustion is now `"unresolved-at-cap"`, distinguished by
`hops === MAX_WALK_DEPTH && frontier.length > 0` — the walk ran out of budget
rather than out of graph — rendered `[UNKNOWN] … (not a violation)` and
excluded from the violation count; `basis-reachability-load.ts` needed no
logic change and the worker documented WHY (seeding the fixpoint with every
landing id at frontier-0 means the closure never truncates a specific
landing's own ≤500-hop reach before that landing's own walk cap does — the
two ceilings being numerically equal is what makes the shared module's
detection correct end-to-end). Criterion 3 the worker reported as DEVIATED
rather than claiming a pass — correctly: it re-ran the DEFAULT sampler and got
1/28 = 3.6% off a different job sample. The reviewer then ran the check the
ticket actually meant, pinned to ticket 01's own windows
(`--jobs 21,87,98,101,130`): 4/41 = 9.8%, compound exit 70.7%, basis
distribution identical — no verdict moved, and the sampler's time-drift is now
recorded in ticket 01's Status. Two worker judgment calls accepted: (a) no
dedicated mutation-tested test for the `[UNKNOWN]` render branch (a
pass-through of the outcome enum; a real test needs a 500-turn fixture through
the full settlement harness) — reviewer verified that branch by reading it,
including the count exclusion; (b) the rebuilt bundles were deliberately NOT
committed, because a build reads the whole tree and the concurrent ticket-04
worker's uncommitted source was already inside the rebuilt `worker.cjs` —
committing it would have smuggled unreviewed source into this commit. That is
the shared-tree lesson applied for the second time and it was the right call;
whoever lands last rebuilds and commits the bundles. Also surfaced: in
`note-settlement-sdk-query.ts` the bare word `depth` is banned by
`tests/shared/public-teaching-surfaces.test.ts`'s retired-vocabulary sweep
(leftover from the retired collapsed/expanded `depth` switch), comments
included — the worker reworded to "hop budget"/"hop cap".

## Decisions (settled — do not re-litigate)

1. **Delete the dead constant.** Do not wire it up. Arming needs the refusal
   moved into the pre-commit gate sequence (after E3/E4/E6 and the disposition
   gate, before `writes.commit()`) against a single fenced read of the graph —
   that is its own ticket with its own dry-run, not a flip. Leave a comment at
   the report site naming what arming would require, so the next reader is not
   told a second time that it is one line.
2. **Cap exhaustion is UNKNOWN, never a violation.** A walk that runs out of
   depth reports the landing turn as unresolved-at-cap, rendered distinctly
   from an established violation and excluded from the violation count. Both
   implementations (`src/shared/phase-connectivity.ts`,
   `src/db/basis-reachability-load.ts`) get the same treatment — they already
   mirror each other's ceiling and must mirror its semantics.
3. **The cap stays at 500.** Real paths measured 1–2 hops; the cap exists to
   bound a pathological graph, and with (2) it can no longer produce a false
   verdict.
4. **Ticket 01's Status is amended by this ticket** to say arming is unwired,
   name this ticket, and drop the "one-line flip" sentence. The dry-run numbers
   it records stay — they were measured and replicated.
5. **Out of scope:** the concurrency fence across loader queries (real, but it
   can only mis-REPORT while report-only — it belongs to the arming ticket,
   record it there); any change to the predicate itself.

## Acceptance criteria

- [x] `PHASE_CONNECTIVITY_GATE_ARMED` no longer exists anywhere in `src/` or
      `tests/` (the test file at `tests/worker/note-settlement-sdk-query.test.ts`
      mentions it in a comment — that comment must stop asserting a switch
      exists).
- [x] A landing turn whose only basis lies beyond the cap is reported as
      unresolved-at-cap, NOT as a violation, and does not increment the
      violation count — asserted on a synthetic chain in both implementations.
- [x] The 5-window dry-run numbers are unchanged by this ticket (violations
      4/41, compound exit 70.7%) — re-run `scripts/phase-connectivity-dry-run.ts`
      read-only and report the numbers; any drift is a finding, not a pass.
- [x] Ticket 01's Status is amended per decision 4.
- [x] Every new/changed test mutation-verified (backup after implement,
      needle-assert + print, red, md5 restore, green).
- [x] `npx tsc --noEmit` clean, `node scripts/build.js` succeeds, `bun test`
      green; baseline 4052/0 — account for every delta.

## Notes

Production DB strictly read-only (the dry-run script already opens it that
way). Do not tick your own boxes — report per-item; the reviewer ticks.
Another worker is editing the settlement write/disposition files in the same
tree: commit ONLY the paths this ticket owns, never `git add -A`.
Treat any `Bin` line in `git diff --stat` on a `.ts` file as a hard stop.
