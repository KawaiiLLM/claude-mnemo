# 06 — The `relations` field renders the node's direct edges, like the lane view

**What to build:** `recall`'s `relations` field shows THIS node's outgoing edges first, then its incoming edges, each with both raw lane sides, in the lane view's arrow grammar — no downstream hops, no invented notation, nothing elided — while `timeline(id="S/T")` keeps its 3-hop tree. Spec D8.

**Blocked by:** 00.

**Status:** ready-for-agent (after 00)

- [ ] Data source: the full live relation rows of the turn, outgoing and incoming, whatever their sides (`getTurnRelationEdges`-class read); rows with `relation IS NULL` (bare text-refs) do not render here.
- [ ] Grammar, one block per turn, outgoing then incoming, one legend line per response: `word -> T<n> (#tail → #head)` (same lane both sides prints once as `(#lane)`; cross-task side prints `E<m>/#lane`); half-settled `(#tail → ·)` / `(· → #head)`; `word -> T<n> [unplaced]` for the `''` sentinel (canonical word "unplaced"); incoming `<- T<n> word (…)`; several relations on one pair merge ONLY when their sides are identical — rows grouped by `(other endpoint, tailTag, headTag)` (production: 109 pairs with more than one placement render as separate rows). No `^`, no cross-page arrow, no hop expansion. Legend says qualifiers are the endpoints' CURRENT tasks, advisory.
- [ ] Outer assembly: one session header per session group, the legend once, every per-turn ledger end-offset preserved (comma-list and range routes).
- [ ] Consumers switched: `recall` (both call sites) and the segment card; `timeline(id="S/T")` keeps `buildTurnRelationView`'s tree. Tree tests rebound to the tree API; recall tests assert the direct set; the tool description rewritten.
- [ ] Acceptance counts atoms: a 20-out/20-in node at today's widths renders all 40; a two-placement pair renders two rows; a list read of three addresses prints one header. Report the widest atom measured on the clone — ticket 01 sizes the `relations` budget from it.

## Constraints

- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY. Measure on a `cp -c` clone of the scratchpad copy.
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean` in the shared tree. Restore from your own `cp` copies, md5-verified.
- Explicit pathspecs on every `git add`. No raw control bytes in source. `grep -c anthropic-ai plugin/scripts/worker.cjs` stays `0`.
- Every teaching sentence added or removed is pinned by a test a mutation drives red. At least three mutation probes of your own, RED, md5-restored.
- [ ] `npx tsc --noEmit` clean (excludes `tests/`; typecheck new tests separately); full `bun test` once (account for every delta against the baseline in your brief); `npm run build`; stale-bundle and release-artifacts guards green; `git diff --check` clean. Do NOT bump any version and do NOT push.
