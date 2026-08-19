# 03 — pageBudget governs every listing surface at runtime

**What to build:** `recall(query=…)` and the routed listings (`S<n>/T*`,
turn/observation listings) pack their pages by TOKENS against `pageBudget`,
exactly as the browse feed already does — overflow starts the next page,
never a truncated block, never a count-only page. Closes the runtime half of
the peer's budget-contract-drift finding (eval P12); the describe half is
already fixed.

**Ruling base:** [S15069/T919] pageBudget+turn as the two budgets;
spec "预算" bullet: 溢出→分页,绝不截断整块 — the contract names every
listing surface, not the browse feed alone.

**Blocked by:** none (ticket 01 landed as d6d1b7e).

**Status:** ready-for-agent

## Pinned decisions

- Reuse the browse feed's packing (`recall.ts` ~1979-2112: "items or
  pageBudget tokens, whichever comes first") as the one mechanism — no second
  packing algorithm. Extract/share rather than duplicate.
- `pageSize` stays the ITEM cap per page; `pageBudget` the token cap — a page
  closes on whichever limit hits first (already the browse semantics).
- Search's grouped rendering (`renderGroupedSearchResults`, no pageBudget
  param today) gains the budget; a session group that straddles the boundary
  re-emits its transition line on the next page with the page-open
  `[Sxx][Txx]` escape (golden-sample contract, already implemented for
  browse — reuse it).
- Page-count arithmetic in headers ("page 1 / N") must reflect budget-driven
  boundaries; where N is no longer cheap to precompute exactly, follow
  whatever the browse feed already reports (do not invent a new estimator).

## Acceptance criteria

- [ ] `recall(query=…, pageBudget=<small>)` splits results across pages at the
      token boundary; page 2 carries the remainder with a self-contained
      opening row.
- [ ] Routed turn and observation listings honor pageBudget the same way.
- [ ] Browse feed behavior byte-unchanged (its existing tests stay green
      unedited).
- [ ] Golden-sample fixtures stay green unedited.
- [ ] typecheck clean; full suite green except the standing stale-bundle
      guard.

## Ground rules

- NO git write commands (commit/stash/checkout/restore). Report the changed
  file list; the main session commits.
- Never touch `~/.claude-mnemo/`, `plugin/scripts/`, versions, or
  `src/worker/`.
- Transient reds outside your files: re-run that one file narrowly; never
  revert the tree.
