# 06 — A side that cannot use its half gives the rest back

**What to build:** the split segment milestones card stops wasting budget at the
recent/old boundary. Each side keeps a GUARANTEED half of the card's token
budget — that part of the user's ruling is untouched — but a side that has
seated every candidate it has and still has room hands the remainder to the
other side, which re-elects at the larger budget. The existing "one side
elected nothing → the other gets the whole budget" fallback becomes the
extreme case of this rule rather than a separate branch.

**Blocked by:** 03 and 04 (both landed: `1317d61`, `8b09f15`).

**Status:** resolved — landed as `fbcff6e`; every criterion re-checked per-item
from the worker's report and independently spot-verified. The cliff is gone on
the real production card (read-only sweep, budget 2000):

```
recentMemberCount=831   OLD=  0   rows=63   honest=1889
recentMemberCount=830   OLD=  1   rows=62   honest=1883   (was 31 / 968)
recentMemberCount=829   OLD=  2   rows=63   honest=1902
recentMemberCount=820   OLD= 11   rows=66   honest=1873
```

Reviewer mutation reverting the re-election budget to a bare `half` brought the
cliff straight back (830 → 31 rows) AND collapsed the empty-OLD case to 30 rows,
with 3 tests red — which independently proves decision 5 was honoured: the old
one-side-empty special branch really is GONE, absorbed into the general rule,
rather than left standing beside it. Restored byte-identical (md5), green.
Suite 3938/0, `tsc` clean. Render cost 15.1 ms vs a 14.5 ms baseline.

Worker finding accepted: `demotedCount === 0` alone is NOT the yield signal —
a side whose half cannot cover the fixed reserve seats nothing yet reports
`demotedCount === windowCandidates.length > 0`. The shipped condition is
`kept.length === 0 || demotedCount === 0`, which is decision 5's second case
keyed explicitly.

## Why

GPT peer review of the 01–04 series, 2026-08-28, finding 2 — reproduced and
measured by the reviewer on the production database (read-only), E70, budget
2000:

```
recentMemberCount=831   OLD members=  0   rows=63   honest tokens=1889
recentMemberCount=830   OLD members=  1   rows=31   honest tokens= 968
recentMemberCount=829   OLD members=  2   rows=32   honest tokens= 987
recentMemberCount=700   OLD members=131   rows=57   honest tokens=1788
```

One member crossing the boundary halves the card and leaves **1032 of 2000
tokens unspent**. A segment that grows from 200 to 201 members loses half its
milestone rows for nothing: the OLD side takes 1000 tokens to render a single
row it could have rendered in 130, and the RECENT side — which has 200 hungry
candidates — is cut to 1000.

This is a policy defect, not an implementation slip. Ticket 03 decision 2
already contains the right principle for the extreme case ("one side empty →
the other gets the full budget"); it simply was not generalized to a side that
is nearly empty. Fixing it is generalizing an existing rule, not adding a
mechanism.

## Decisions (settled — implement as given)

1. **Each side's half stays a guaranteed floor.** A side never loses capacity
   to competition from the other; the anti-starvation guarantee ticket 03
   shipped is the whole point of the split and must survive intact.
2. **A side yields only what it CANNOT use.** The signal is the election's own
   `demotedCount === 0` — it seated every candidate it had, so more budget
   would buy it nothing. A side with `demotedCount > 0` is hungry and yields
   nothing, ever.
3. **The other side re-elects at the larger budget**, rather than being
   patched after the fact — the surviving set must still be its election
   ranking's top-K prefix at the budget it actually got (ticket 02 decision 3),
   and only a re-election gives that.
4. **Both sides satisfied → nothing happens.** No re-election, no change; the
   card simply comes in under budget, which is correct.
5. **The existing empty-side branch is absorbed, not kept alongside.** After
   this ticket there is ONE rule. A side that elected zero rows has
   `demotedCount === 0` only if it also had zero candidates; a side with
   candidates that seated none of them (its half could not even cover the
   reserve) must ALSO yield — handle that case explicitly and say in the
   report which condition you keyed it on.
6. **Out of scope:** the 200 boundary VALUE, the budget constant's value, the
   election tiers and sort keys (ADR-0013), the duplicated chrome (ticket 05),
   the fitter's search strategy (ticket 07), any version bump or push.

## Acceptance criteria

- [x] The measured cliff is gone: on a fixture reproducing the shape above
      (N and N+1 members either side of the boundary, the one-member OLD side
      seating a single cheap row), the card's total row count changes by a
      small number, not by half — asserted with both numbers named.
- [x] A hungry side never yields: on a fixture where BOTH sides have more
      candidates than their half can seat, each side renders exactly what it
      renders today — asserted (this is the guarantee, and it is the one thing
      this ticket could break).
- [x] A side that seats everything yields the remainder, and the other side
      demonstrably renders MORE rows than it would have at a bare half —
      asserted with both row counts.
- [x] A segment at or under 200 members still renders byte-identical to
      today's card — asserted (the old empty-side path's behaviour is
      preserved by the general rule).
- [x] A side with candidates whose half cannot cover even the reserve yields
      too — asserted, with the report naming the condition used.
- [x] Render cost stays bounded: report the measured per-render time for the
      real E70 card before and after (the reviewer measured 14.5 ms before).
      At most one re-election per side.
- [x] Every new/changed test mutation-verified: name the observable, back up
      AFTER the implementation lands, assert the needle matched and PRINT that
      it applied, red, restore byte-identical (md5), green.
- [x] `npx tsc --noEmit` clean, `node scripts/build.js` succeeds, `bun test`
      green; baseline is 3931/0 — report the number and account for every
      delta.

## Notes

Production database strictly read-only (`sqlite3 -readonly`, or
`new Database(path, {readonly: true})`; WAL mode needs the `-wal`/`-shm`
sidecars if you copy). Never write, never migrate, never restart the worker.
Do not tick your own acceptance boxes — report per-item; the reviewer ticks.
