# 06 — The `relations` field renders the node's direct edges, like the lane view

**What to build:** `recall`'s `relations` field shows THIS node's outgoing edges first, then its incoming edges, each with both raw lane sides, in the lane view's arrow grammar — no downstream hops, no invented notation, nothing elided — while `timeline(id="S/T")` keeps its 3-hop tree. Spec D8.

**Blocked by:** 00.

**Status:** LANDED **VERIFIED S15069/T2411 at fe58d7dd (merged 413b5d43)**: tsc 0; merged tree 4732/0/261 after one conflict (format.ts comment vs ticket-00 code, resolved by keeping both) and one stale expectation in ticket 00's delivery-gate test (`-extends->` tree glyph → `extends ->`); my probes RED — segment card falling back to the tree (1), cross-task qualifier dropping `E<n>/` (1). Widest atom 76 chars / ~19 tokens; `relations` budget for ticket 01 ≈ 800 tokens. Arrow decision accepted: `->`/`<-` only, crossing carried by the two-sided suffix per the spec grammar (a one-function change if the lane view's four arrows are wanted).

- [x] Data source: the full live relation rows of the turn, outgoing and incoming, whatever their sides (`getTurnRelationEdges`-class read); rows with `relation IS NULL` (bare text-refs) do not render here.
- [x] Grammar, one block per turn, outgoing then incoming, one legend line per response: `word -> T<n> (#tail → #head)` (same lane both sides prints once as `(#lane)`; cross-task side prints `E<m>/#lane`); half-settled `(#tail → ·)` / `(· → #head)`; `word -> T<n> [unplaced]` for the `''` sentinel (canonical word "unplaced"); incoming `<- T<n> word (…)`; several relations on one pair merge ONLY when their sides are identical — rows grouped by `(other endpoint, tailTag, headTag)` (production: 109 pairs with more than one placement render as separate rows). No `^`, no cross-page arrow, no hop expansion. Legend says qualifiers are the endpoints' CURRENT tasks, advisory.
- [x] Outer assembly: one session header per session group, the legend once, every per-turn ledger end-offset preserved (comma-list and range routes).
- [x] Consumers switched: `recall` (both call sites) and the segment card; `timeline(id="S/T")` keeps `buildTurnRelationView`'s tree. Tree tests rebound to the tree API; recall tests assert the direct set; the tool description rewritten.
- [x] Acceptance counts atoms: a 20-out/20-in node at today's widths renders all 40; a two-placement pair renders two rows; a list read of three addresses prints one header. Report the widest atom measured on the clone — ticket 01 sizes the `relations` budget from it.

## Constraints

- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY. Measure on a `cp -c` clone of the scratchpad copy.
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean` in the shared tree. Restore from your own `cp` copies, md5-verified.
- Explicit pathspecs on every `git add`. No raw control bytes in source. `grep -c anthropic-ai plugin/scripts/worker.cjs` stays `0`.
- Every teaching sentence added or removed is pinned by a test a mutation drives red. At least three mutation probes of your own, RED, md5-restored.
- [x] `npx tsc --noEmit` clean (excludes `tests/`; typecheck new tests separately); full `bun test` once (account for every delta against the baseline in your brief); `npm run build`; stale-bundle and release-artifacts guards green; `git diff --check` clean. Do NOT bump any version and do NOT push.

---

## Report — LANDED

**Status:** LANDED. Branch `worktree-agent-a2ef9fe942b727e21`, based on `4dd91a52`.

### What shipped

`src/mcp/relations-view.ts` now owns two shapes instead of one:

- `buildTurnRelationTreeLines` — the 3-hop tree, renamed from `buildTurnRelationLines`. One caller left: `timeline(id="S<n>/T<m>")`'s node route (via `buildTurnRelationView`, unchanged).
- `buildTurnDirectRelationLines` — spec D8's direct set. Consumers switched: `recall.ts` (turn view + browse feed) and `segment-card.ts`.

Grammar, as ruled: `<words> -> <addr> <sides>` outgoing first, `<- <addr> <words> <sides>` incoming after; sides are `(#lane)` / `(#tail → #head)` / `(#tail → ·)` / `(· → #head)` / `[unplaced]`; a side owned by another task prints `E<n>/#lane`. Rows group by `(other endpoint, tailTag, headTag)` and are ordered by address then placement; several words merge only on identical sides. The display word is `displayEdgeRelation`'s class word.

**Arrow-glyph ambiguity, resolved toward the spec.** The brief noted the lane view's `=>` cross-lane out / `<=` cross-lane in. Spec D8's own grammar bullets spell a CROSSING as `word -> T<n> (#tail → #head)` — plain stroke, crossing carried by the two-sided suffix. Under T2388 ("no invented notation") the spec's written grammar wins; only `->` and `<-` render, and a test asserts no `=>` appears on a crossing row. Flag for the integrator if the intended reading was the other one.

Outer assembly (`recall.ts`): a comma list of TURN addresses now resolves to ONE turn list and one `renderTurnScope` call (`selectAddressedTurns` + `renderTurnAddressPage`, both split out of `renderRoutedId`), so one header per session group, duplicates read once, per-turn ledger marks unchanged. The `relations` legend (`RELATIONS_FIELD_LEGEND`) is appended once per response in `recallMemoryDelivery`, below the body so no ledger offset moves, gated on `fields.has("relations")` rather than on "did a line render" — the page packers trial-render, so a render-time flag would fire for bytes nobody receives.

Tool description (`definitions.ts` ~134) rewritten: direct-set grammar, the grouped list, and a pointer to `timeline(id="S<n>/T<m>")` for the tree.

### Measurement (clone of the scratchpad copy of production, schema brought forward)

| | |
|---|---|
| endpoint turns | 2995 |
| nodes rendering ≥1 atom | 2920 |
| atoms total | 7200 |
| **widest atom** | **76 chars / 19 est. tokens** — `<- T444 correct(partial) (#extraction-architecture → #prompt-cache-incident)` |
| atom width p50 / p95 / p99 | 31 / 47 / 55 chars |
| atoms per node p50 / p95 / max | 2 / 5 / 20 (`S15069/T998`) |
| widest whole field today | 508 chars |
| cross-session atoms | 26 |
| `[unplaced]` atoms | 1220 |
| half-settled atoms | 0 (the write gate refuses one today) |
| `E<n>/`-qualified atoms | 0 (every live edge's endpoints share a task, or one is homeless) |

**`relations` budget this implies for ticket 01:** 40 atoms at today's widest = **3079 chars / 750 estimated tokens**. Round to **800 tokens** for headroom; today's real p100 field is 508 chars, so the cap is ~6x the worst node in the corpus.

### Probes (all RED, all md5-restored)

| # | mutation | red |
|---|---|---|
| 1 | group by endpoint pair alone (drop the two tags from the key) | 1 — two-placement rows |
| 2 | render incoming before outgoing | 1 — ruled order |
| 3 | drop the `[unplaced]` marker | 5 across 3 files |
| 4 | remove the legend's field gate | 1 — no legend when unselected |
| 5 | disable the comma-list grouping | 2 — one header, duplicate read once |
| 6 | strip the "no downstream hops" clause from the tool description | 1 — teaching test |

### Verification

`npx tsc --noEmit` clean; new tests typechecked under a temp tsconfig, clean. `bun test` 4702 pass / 0 fail / 258 files against the 4676 / 0 / 256 baseline: +16 (`tests/mcp/relations-view.direct.test.ts`), +8 (`tests/mcp/recall.relations-outer-assembly.test.ts`), +2 (two new `definitions.test.ts` cases). `npm run build` + `tests/shared/release-artifacts.test.ts` green; `git diff --check` clean; no control bytes; `grep -c anthropic-ai plugin/scripts/worker.cjs` = 0.
