# 02 — The pager stops rendering the whole corpus to return page one

**What to build:** a `recall` that returns page 1 of a large result set in time proportional to page 1, not to the whole set. Today `paginateByRenderedPageCost` (src/mcp/recall.ts) renders and tokenizes EVERY item to compute every page boundary before it can print `page 1 / N`, and inside each page it re-renders the whole accumulating page once per item.

**Blocked by:** None. Do not run concurrently with 01 — both rebuild bundles.

**Status:** LANDED `0ad07a10`, VERIFIED S15069/T2369. Independent check: tsc 0, 4583/0/252; my own re-run on the copy: shape A 51.5 s → 0.6 s cold (agent's 0.12 s is the warm figure), B 0.1 s, C 0.0 s; my own `diff` of the agent's 11 before/after captures: every body identical, headers differ only on the two above-limit shapes. Two probes of mine: an unsound bound (`bound <= pageBudget + 8`) → reference-equivalence RED; **`Math.max(1, page - 1)` SURVIVED** — the `page → maxPages` wiring inside `paginateByRenderedPageCost` was pinned only at page 1, so a regression would have served an empty slice for every later page above the limit. Pinned in the adjudication commit (page 3 of 1,200 items through `paginate`, RED under the mutant). Header decision (`≥N`, exact `total`, 200-item threshold) accepted with its reasons. Standing UNVERIFIED as the worker stated: subadditivity of the grouping renderers is checked, not proven.

## Measured

Production, job 170, `recall(filter={session:"15069", fields:[…], fieldBudgets:{prompt:50}}, turn=280, pageSize=100, page=1)`: **6 min 10 s** to return `page 1 / 4612 (total 12874)`. The settlement child sat at ~95% CPU the whole time; the lease has 10 minutes.

Reproduced on a read-only copy of the production database (`VACUUM INTO`, 2.28 GB) with the exact same call through `recallMemory`:

| shape | items | pages | time |
|---|---|---|---|
| `filter.session=23566` | 154 | 49 | 0.6 s |
| `filter.session=15069` | 2,166 | 662 | **71.2 s** |
| `id="E60/S15069/T2302..S15069/T2311"` | 14 | 2 | 0.1 s |

Fourteen times the items, one hundred and eighteen times the time. The copy and the script are in this session's scratchpad (`repro/copy.db`, `repro/rt.ts`); rebuild them the same way if they are gone — never against `~/.claude-mnemo/` itself.

## Two independent inefficiencies, both in `packItemsByRenderedPageCost`

1. **Eager over all pages.** Page boundaries are computed for every item so `pageCount` can be exact. Page 1 needs only page 1's boundary.
2. **Quadratic within a page.** For each candidate item it calls `renderPage(candidate)` on the WHOLE accumulating page and re-tokenizes it, so a page of k items renders k(k+1)/2 item-renders. Each item render on the session route is itself a `renderSessionDetail` with its own reads.

Either alone is a large factor; together they are what turned 2,166 items into 71 seconds.

## What to change

- [ ] Page 1 is computed by packing items until page 1 is full, then stopping. Deeper pages pack forward only as far as the requested page.
- [ ] Within a page, an item's rendered cost is measured once (render the item, tokenize the item), and the page's cost is the running sum plus the join separators — never a re-render of the accumulating page. If the page wrapper adds bytes that depend on the whole page, measure that once per page, not once per item.
- [ ] **Decide, and say why, what `page 1 / N` means when N is no longer computed exactly.** The two honest options: an exact `total` (a count, cheap) with a page count that is a lower bound (`page 1 / ≥N`) computed only as far as packing went; or keep an exact page count only when the set is below some size and go to the lower-bound form above it. Do not silently print an exact-looking number that is an estimate. Every caller that parses the header (the settlement prompt teaches "page 1 / N" as a signal to keep paging) must still work — check the shipped prompts and the tests that pin the header.
- [ ] **Benchmark before and after on the copy**, all three shapes above plus `id="S15069/T*"` (the whole session by address). Report the numbers. The acceptance bar: the 15069 session-filter shape returns page 1 in under 2 seconds on the copy, and no shape gets slower.
- [ ] The result BYTES of page 1 are byte-identical before and after for every shape in the benchmark, except the header when its semantics changed under the bullet above. Prove it with a diff, not an assertion.
- [ ] Mutation probes: one that restores the eager all-pages loop (the benchmark test must go red on time or on a call-count fixture), one that restores per-item whole-page re-render.

## Out of scope

Whether `filter.session` without `id` should exist at all as a route — ticket 01 steers writers away from it in the prompt; this ticket makes it not pathological if reached. Redesigning the route is a separate call.

## Constraints

- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY. Benchmarks run on a copy you make.
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean`. Restore from your own `cp` copies, md5-verified. Explicit pathspecs on every `git add`. No raw control bytes.
- [ ] `npx tsc --noEmit` clean (excludes `tests/`); full `bun test` once; `npm run build`; stale-bundle and release-artifacts guards green; `git diff --check` clean. No version bump, no push.

---

## What landed

Both named inefficiencies are fixed, plus a third the measurement forced (below). Page 1's body is
byte-identical on every benchmarked shape, proved by diff, and deep pages were diffed too.

### 1. Eager over all pages → the fold stops at the requested page

`packItemsByRenderedPageCost` takes a `maxPages` bound and returns `{ pages, complete }`. Packing is
a strictly left-to-right greedy fold, so stopping early cannot move a boundary at or before the page
asked for.

### 2. Quadratic within a page → an item is priced once

Each item is rendered ALONE exactly once. A running integer UPPER BOUND on the page's cost is
carried, and the whole-page render survives only as the fallback for the case the bound cannot
settle. The bound is sound because these renderers GROUP — a page holding two items never contains
more than the two pages holding each alone — so

    R(renderPage(A ∪ {x})) ≤ R(renderPage(A)) + R(renderPage([x])) + ¼

where `R` is `estimateTokens`' unrounded character-class value and the ¼ is the single `\n` the join
adds. `estimateTokens` is `ceil(R)`, and `ceil(a) + ceil(b) + 1 ≥ ceil(a + b + ¼)`, which is what
`PAGE_JOIN_TOKEN_SLACK = 1` pays for. A probe that sets it to 0 breaks the equivalence test — the
slack is load-bearing, not decoration.

### 3. THE MEASUREMENT FORCED A THIRD FIX, and without it repair 2 was a REGRESSION

Instrumenting the packer showed the ticket's cost model is not what this code was actually paying.
On the search route the per-`renderPage`-CALL constant (≈1.17 ms) dominates the per-item marginal
(≈0.17 ms) about 7:1 — because `renderGroupedSearchResults` ran
`getTurnsForSession(db, session.id)`, a WHOLE-SESSION scan, once per probe, to pick out three rows.
So the old fold's "quadratic" was quadratic in items rendered but LINEAR in calls (exactly one per
item), and repair 2 as specified adds calls (one alone-render per item, plus a fallback near each
boundary). Measured on shape B: item renders fell 480 → 439 while calls rose 153 → 227, and the
shape got **22% SLOWER** (0.27 s → 0.33 s). That violates the ticket's own "no shape gets slower".

The fix is `getTurnsByIds(db, ids)` (new, `src/db/turns.ts`): the same rows in the same
prompt-number order, read by id. It is the ticket's own "if the page wrapper adds bytes that depend
on the whole page, measure that once per page, not once per item" applied where the wrapper actually
costs — in the renderer, not the packer. With it, every shape is faster, B included.

### The header semantics — DECIDED: exact `total`, and `≥N` for a page count that is a lower bound

`page 1 / ≥2 (total 2166)`. The reasoning, and why not the alternatives:

- **`total` is always exact.** It is `items.length` — a count, free, and it is the real "how much is
  there" signal. Nothing about it degrades.
- **The page count is exact whenever the fold consumed every item**, which it does for any candidate
  set at or under `EXACT_PAGE_COUNT_ITEM_LIMIT = 200`, and for any request that reaches the last
  page. Every result set an agent actually pages through sits far below that limit, so in practice
  the header a reader sees is the header it always saw: `page 1 / 6 (total 60)` still prints exactly
  that, and the shipped tests that pin those headers were not touched.
- **Above the limit it prints `≥N`.** This is the ticket's first option, chosen over its second
  because the second (an exact count below some size, silently switching above it) is the same thing
  without the marker — and an unmarked switch is exactly the "exact-looking number that is an
  estimate" the ticket forbids. `≥` costs one character and makes the degradation visible at the
  point of use.
- **Why the limit is on ITEM COUNT and not page count.** The cost of an exact count is one item
  render per item in the whole set; a page-count limit does not bound that (20 pages can be 20 items
  or 2,000). 200 items is ~0.5 s on the heaviest route measured on the 2.28 GB copy, and the
  pathological sets this ticket exists for — 2,166 and 12,874 items — never pay it.
- **`N` is a bound the data supports**, not a guess: the fold packed `pages.length` pages and at
  least one item remains, so at least one more page exists.

**Every consumer of the header was checked.** `grep -rn "page 1 /"` over `src/`, `tests/` and the
shipped prompts: no prompt anywhere teaches the literal string (the tool description teaches
`pageBudget` overflow → "another page"), and `pageCount` outside `recall.ts` belongs to two
independent pagers — `shared/lane-checker-render.ts`'s `continuationFooter` and
`mcp/segment-card.ts`'s `cardOverflowFooter` — neither of which routes through this packer. Inside
`recall.ts` the other three paged routes use `paginateItems`, whose count is arithmetic on a length
and stays exact; they now pass `pageCountExact: true` explicitly. The four tests that pin an exact
header all sit under the 200-item limit and pass unchanged.

### Benchmarks, on the read-only VACUUM copy (2.28 GB), same process, best of three

| shape | items | before | after | page-1 body |
|---|---|---|---|---|
| A `filter.session=15069` (job 170's shape) | 2,166 | **51.54 s** | **0.12 s** | identical |
| B `filter.session=23566` | 154 | 0.27 s | 0.12 s | identical |
| C `id="E60/S15069/T2302..S15069/T2311"` | 14 | 0.04 s | 0.04 s | identical |
| D `id="S15069/T*"` | 2,365 | **17.30 s** | **0.10 s** | identical |

Four further shapes, captured before and after by swapping the module in and out (md5-verified both
ways), to cover deep pages and MULTI-SESSION grouping, which A-D do not:

| shape | before | after | body |
|---|---|---|---|
| `query="settlement"`, page 1 (1,112 items) | 30.47 s | 0.70 s | identical |
| `query="settlement"`, page 4 | 30.60 s | 0.36 s | identical |
| `query="pagination budget"`, pageSize 10, page 2 | 35.13 s | 0.64 s | identical |
| `filter.session=15069`, pageSize 10, page 7 | 53.47 s | 0.76 s | identical |

Page 3 of A, B and D was captured under both implementations as well: all three bodies identical.
Headers differ only where the semantics changed (A and D, the two sets over the item limit).

The acceptance bar — the 15069 session-filter shape under 2 s, and no shape slower — is met with
margin: 0.12 s, and every measured shape is faster or unchanged.

### Mutation probes

1. Delete the `maxPages` break (restore the eager all-pages fold) → **4 tests RED**, on the packed
   page count and on the header, not on a wall clock.
2. Delete the cheap bound (restore the per-item whole-page re-render) → **3 tests RED**, on the
   render counts (a 40-item page: 40 item renders becomes 859).
3. Trust the bound with no exact fallback → **1 RED**: the boundaries stop matching the reference
   fold. This is the guard that byte-identity rests on.
4. `PAGE_JOIN_TOKEN_SLACK = 0` → **1 RED**, same equivalence test — the ceil/newline slack is real.
5. `getTurnsByIds` ordered DESC → **1 RED** on its equivalence test with
   `getTurnsForSession(...).filter(...)`. (Honest note: at the search call site the later
   relevance/prompt-number sort is total, so this ordering is not observable there — the test pins
   the helper's own contract, and the probe was added only after a first attempt showed nothing
   caught it.)

### Verification

`npx tsc --noEmit` clean (excludes `tests/`; `tests/mcp/recall.pager.test.ts` typechecked separately
under a temp config). Full `bun test`: **4583 pass / 0 fail across 252 files** — 4573 after ticket 01
plus exactly the 10 tests this ticket adds. `npm run build`; stale-bundle and release-artifacts
guards green; `git diff --check` clean; no control bytes; `grep -c anthropic-ai
plugin/scripts/worker.cjs` still `0`. No version bump, no push.

### Out of scope, confirmed still out

Whether `filter.session` without `id` should exist as a route. It is no longer pathological; ticket
01 steers writers off it in the prompt.
