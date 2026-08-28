# 05 — A read receipt that counts members, not pages

**What to build:** the recall-before-justify obligation stops being satisfiable
by a read that saw almost nothing. Confirmed by the reviewer against source
after the eighth peer round (Codex, 2026-08-29, Standards P1-3 / Spec P1-3):
`hasFullLaneReadCoverage` divides the member count by a hardcoded
`LANE_READ_PAGE_SIZE = 10`, while `recall` honours a caller-supplied
`pageSize`. Reading pages 1–3 at `pageSize: 1` therefore "covers" a 25-member
lane after seeing three members, and the justify is accepted.

**Blocked by:** 04 (same worker, same file `src/db/lane-disposition.ts` — land
04 first).

**Status:** resolved — landed as `56d32ea`; every criterion re-checked
per-item by the reviewer; suite 4070/0, tsc clean, no `Bin` lines. Coverage is
now over `renderedTurnIds` — the page's ACTUAL slice
(`paginateItems(membershipTurnIds, page, pageSize).items`, recall.ts) — and
the obligation is decision 2 as written, the OTHER island's `memberIds`, not
the weaker whole-lane reading. `LANE_READ_PAGE_SIZE` and every page-number
arithmetic it fed are gone (grep: only prose in a test's doc comment and the
migration's own `page_coverage` probe). The reason must name both
representatives in `S<n>/T<m>` form; the "why none of the seven words holds"
half stays unmachine-checked, which is the ticket's own honesty boundary.
Decision 4's two non-defects were left alone with the reasoning recorded in
`evaluateJustify`'s doc comment. Reviewer mutation (making `renderedTurnIds`
the whole membership — i.e. restoring the laundering path) turned 2 tests red;
restored byte-identical, green.

Worth keeping from the worker's report: its accumulation test was INITIALLY
FAKE and its own mutation caught it — the closing `recall` (page 2 @ pageSize
2) covered the whole obligation by itself, so "only the newest receipt counts"
stayed green. Rewritten so neither call covers the obligation alone. A
reviewer reading only the test name would not have seen it; this is the
mutation discipline earning its keep. Second local fact: a LANE render marks
its own truncated grant on the members it shows, so a full-content grant taken
BEFORE the last lane page is revoked by it — sequence the grant last.
`56d32ea` carries the bundle rebuild for three source commits (`29c29ee`,
`b4ff52a`, itself), so `29c29ee` alone fails `release-artifacts.test.ts` if
anyone bisects to it — unavoidable with two workers and one bundle.

## Decisions (settled — do not re-litigate)

1. **Coverage is over MEMBER IDS, not page numbers.** The receipt already
   stores the lane's membership snapshot; it must additionally store the member
   ids this call actually RENDERED (the page's own slice). Coverage then asks:
   does the union of ids this reader has rendered contain every id of the
   component the justify is filed against? This is strictly simpler than the
   page arithmetic it replaces and kills three defects at once — the page-size
   mismatch, the union of page numbers across snapshots, and the "mythical
   one-shot read" that motivated paging in the first place (accumulation across
   calls is now the natural behaviour, not a special case).
2. **The obligation is the OTHER component's membership**, not the whole lane's
   — the ticket-02 teaching is "read the side you are not standing on". If the
   simplest honest implementation covers the whole lane, say so and take it;
   do not silently pick the weaker of the two.
3. **The reason must name both current representatives.** Ticket 02's
   anti-grinding clause required it and the implementation checks only
   non-emptiness. Check that the reason text contains both representative
   addresses in the form the refusal itself prints (`S<n>/T<m>`); the
   "why none of the seven words holds" half stays unmachine-checked — that is
   the ticket's own honesty boundary.
4. **NOT defects, do not "fix":**
   - *Cross-run stale receipts* — receipts are keyed to
     `claimWriterId(jobId, claimGeneration)`, so staleness is already bounded
     inside one claim. The member-id rewrite narrows what remains; nothing
     further is owed.
   - *The component fingerprint's strength* — the representative pair IS the
     fracture's identity and islands are recomputed fresh every commit. A
     membership change that preserves both representatives leaves the same
     fracture. Leave it; record the reasoning where a future reader will hit
     the same doubt.
5. **Out of scope:** touch accounting (04); phase connectivity (06); the
   full-content grant's own freshness (claim-scoped, deliberately left).

## Acceptance criteria

- [x] A justify after paging the lane at `pageSize: 1` for fewer pages than the
      component has members is REFUSED, naming what is still unread. This is
      the exact laundering path the peer found — assert it as written.
- [x] A justify after genuinely paging every member (any pageSize, one call or
      several) is ACCEPTED.
- [x] Coverage accumulates across calls with DIFFERENT page sizes.
- [x] A justify whose reason omits either representative address is refused,
      naming which one is missing; one naming both (and nothing else machine-
      checkable) is accepted.
- [x] `LANE_READ_PAGE_SIZE` and any page-number arithmetic it fed are gone, not
      merely bypassed.
- [x] Every new/changed test mutation-verified (backup after implement,
      needle-assert + print, red, md5 restore, green).
- [x] `npx tsc --noEmit` clean, `node scripts/build.js` succeeds, `bun test`
      green; baseline is 04's post-landing count — account for every delta.

## Notes

Production DB strictly read-only. Do not tick your own boxes — report
per-item; the reviewer ticks. Do NOT edit
`src/worker/note-settlement-sdk-query.ts` (ticket 06's territory).
Treat any `Bin` line in `git diff --stat` on a `.ts` file as a hard stop.
