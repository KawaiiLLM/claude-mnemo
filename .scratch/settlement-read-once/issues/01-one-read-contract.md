# 01 — One read contract: the taught route paginates by cost, honours budgets, names its cuts, grants per member

**What to build:** the settlement writer reads the initial writable set in as few pages as the envelope allows and never re-reads anything the response did not name as `cut` or `dropped`. Spec D1 + D2.

**Blocked by:** 00, 06 (the `relations` budget is taken from 06's renderer).

**Status:** ready-for-agent (after blockers)

- [ ] The segment-member routes (`E<n>/S/T..S/T`, `E<n>/T*`, `E<n>/#tag`) adopt the plain range's behaviour: `paginateByRenderedPageCost`, `fieldBudgets` forwarded, PER-MEMBER ledger marks (a member is granted when its block was delivered whole, not when the page was). Test: `prompt:50` is honoured on the task-scoped range; a member on a delivered page is granted, one on a cut page is not.
- [ ] `boundedFields: [<field>…]` on `recall` ONLY (not on the shared `MemoryFilterInput`; `timeline` refuses it by name). Subset rule: `boundedFields ⊆ selected ∩ keys(fieldBudgets)`, violator refused by name. `relations` is refused by name inside it. Gate semantics unchanged by intent: a bounded gated field that was shortened records `complete=false` and grants nothing (test: bounded metadata → tag write refused).
- [ ] Four field states per rendered turn, produced by the renderer over ALL selected fields: `complete | bounded | cut | dropped`. Footer `truncated: <field> cut; <field>, <field> dropped` lists only cut/dropped; it is a fixed element with RESERVED budget inside the measured structural overhead (worst case = every budgetable field + `title cut`), counted in page cost, envelope and ledger end-offset. Test: `turn = label + worst-case footer`, body allowance 0 → footer whole and both costs counted; a prompt over 50 with `boundedFields:["prompt"]` → `bounded`, no footer; same call without → `cut`.
- [ ] Render-side title cap: a label longer than N chars is cut to N with a marker and reported `title cut`; no write-side refusal on either `note` schema.
- [ ] Budget contract executed and reported: per-field numeric budgets for content/prompt/insight/relations/metadata (title excluded, enters overhead at the render cap); `relations` = 40 atoms × current widest atom; others p95 over the last 30 days of production (clone); `turn` = Σ + overhead + 10%, `content` takes the remainder past `MAX_TURN_BUDGET` 5000; explicit `pageBudget`; go/no-go on turns/page against `MAX_PAGE_BUDGET` 25000 — report the real turns/page, squeeze nothing.
- [ ] The stage-1 teaching: read the writable set with the field union (title, metadata, content, prompt bounded 50, insight, relations) in the fewest pages; re-read only a named cut/dropped field, that turn, that field alone; a CUT `relations` needs no re-read for writing, a DROPPED one must be read once.

## Constraints

- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY. Measure on a `cp -c` clone of the scratchpad copy.
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean` in the shared tree. Restore from your own `cp` copies, md5-verified.
- Explicit pathspecs on every `git add`. No raw control bytes in source. `grep -c anthropic-ai plugin/scripts/worker.cjs` stays `0`.
- Every teaching sentence added or removed is pinned by a test a mutation drives red. At least three mutation probes of your own, RED, md5-restored.
- [ ] `npx tsc --noEmit` clean (excludes `tests/`; typecheck new tests separately); full `bun test` once (account for every delta against the baseline in your brief); `npm run build`; stale-bundle and release-artifacts guards green; `git diff --check` clean. Do NOT bump any version and do NOT push.
