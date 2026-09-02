# 07 — The `relations` field shows resolved attribution

**What to build:** spec D2/D8 marks on top of read-once ticket 06's direct-edge renderer (landed): each side rendered as declared / derived / ambiguous / none / invalid (`invalid (stored #old)`), replacing raw-side grouping and `[unplaced]`; the class word is the only relation word rendered; `timeline(id="S/T")` keeps its tree but renders class words; the tool description and the legend say qualifiers are the endpoints' CURRENT tasks and advisory.

**Blocked by:** 02.

**Status:** LANDED

- [x] Fixtures for all five outcomes; a two-placement legacy pair is NOT a case any more after 01 — until 01 lands, such a pair renders one row per physical row with its raw declaration (no `legacy` mark machinery beyond that).

## Constraints

- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY; measure on a `cp -c` clone of the scratchpad copy.
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean`. Restore from your own `cp` copies, md5-verified.
- Explicit pathspecs on every `git add`. No raw control bytes. `grep -c anthropic-ai plugin/scripts/worker.cjs` stays `0`.
- Every teaching sentence added or removed is pinned by a test a mutation drives red. ≥3 mutation probes of your own, RED, md5-restored — and a probe whose mutation did not apply is not a probe.
- Dispose of every applicable line of `../acceptance-matrix.md` in your report.
- [x] `npx tsc --noEmit` clean (excludes `tests/`; typecheck new tests separately); full `bun test` once with every delta accounted; `npm run build`; stale-bundle and release-artifacts guards green; `git diff --check` clean. No version bump, no push.


---

## Report — LANDED

**Branch** `worktree-agent-a5ab5a0136713600d`, based on `8a7af023` (ticket 02's merge).

### What shipped

**A side is rendered as what it RESOLVES to, not as what it stores.**
`src/mcp/relations-view.ts`'s direct set (`buildTurnDirectRelationLines`) now
loads endpoint lane facts once per node (`loadEndpointLaneFacts`, spec D2's one
shared read) and projects every incident row through `resolveEdgeSide`. Each
side prints one of the resolver's own five words:

| outcome | rendered |
|---|---|
| derived | `#lane derived` |
| declared | `#lane declared` |
| ambiguous | `ambiguous` |
| none | `none` |
| invalid | `invalid (stored #tag)` |

A side owned by another task keeps the lane view's `E<n>/#lane` qualifier,
resolved from `EdgeSideResolution.lane.segmentId` (the memoized
`getOwningSegmentId` walk is gone — it could name the owning TASK but never the
lanes, so it could not have resolved an attribution at all). The suffix prints
ONCE when both sides render the same string (`(#lane-a derived)`, `(none)`) and
as a pair otherwise.

**`[unplaced]` and `·` are deleted.** `(none)` is what a two-blank-side row on
two lane-less endpoints says now, and a half-resolved row says which side is
which by name. This is the substantive correction: `[unplaced]` was printed over
the 69% of production edges whose attribution is in fact fully determined.

**Grouping key is `(other endpoint, RESOLVED tail, RESOLVED head)`** — the same
rule as before, read at the level the reader sees. A legacy multi-row pair whose
rows resolve differently therefore renders one line per physical row with its own
raw declaration, and two rows that would need the same suffix merge onto one
carrying both classes. No legacy-pair machinery exists beyond the key itself
(ticket 01 folds the stock).

**The class word is the only relation word on all three surfaces.**
`renderRelationClassWord` (local to `relations-view.ts`) routes every row through
`edgeRelationClass`, so `recall`'s field, the task card's member blocks and
`timeline(id="S/T")`'s node tree all print `correct(full)`/`correct(partial)`/
`verify`/`use` and never a stored seven-word value. On the tree this also puts a
legacy row back on `defaultRelationRank`'s class-keyed ladder instead of its
defensive last rank.

**Legend + tool description** rewritten to name all five outcomes and to say, in
D0/D3's own terms, that attributions and the `E<n>/` qualifier alike are resolved
from the endpoints' CURRENT tasks at read time and are ADVISORY — not part of
what an edge write is checked against, and never the authority for a
declaration.

### Scope calls

- **`shared/relation-class.ts` is NOT touched.** Making `displayEdgeRelation`
  itself class-only was measured first: 78 test failures, spread across the lane
  view, the milestone election and the console graph — surfaces owned by other
  tickets. The retirement is done at this module's own two call sites and the
  remaining `displayEdgeRelation` readers are listed in the code comment
  (`mcp/timeline.ts`'s lane view + frontier label, `worker/console-api.ts`'s
  graph payload). P3's union is ticket 01's release gate.
- **The tree's lane SUFFIX (`{alpha}`, `{alpha→beta}`) still reads raw stored
  tags.** The ticket assigns the tree only the class-word change; resolving the
  tree's own suffixes would need endpoint facts across up to 3 hops × every
  branch. Flagged, not done.

### Acceptance-matrix disposition

- **R10-3** (raw-word readers): the renderer's two consumers
  (`relations-view.ts` lines 113 and 442 at HEAD) are DISPOSED here — both now
  read the class. R10-3's **console UI vocabulary** line is **ticket 11's**, not
  touched. Its other named readers (impressions' anchor invalidation, shape
  numbers, membership strandings, writable/debt closure, the shared
  vocabulary/write/retract/load layer, migration literals) are tickets 02/03/01.
- **R9-4** (raw-word retirement exhaustive) names `relation-tree.ts` ~56–63's
  explicit order: already class-keyed by ticket 02, and this ticket makes the
  tree actually FEED it classes. The rest of R9-4 (frontier SQL, lane-checker
  sets, lane-checker-load) is not this ticket's territory.
- **D0/D3's advisory sentence** is implemented in the legend and the tool
  description and pinned by two tests.
- Every other matrix line is outside the renderer.

### Probes (6, all RED, all md5-restored, every mutation verified applied)

| # | mutation | md5 moved | RED |
|---|---|---|---|
| 1 | group by endpoint only (drop the two resolved sides from the key) | yes | 1 — the legacy pair collapses |
| 2 | `invalid` stops naming the tag it stores | yes | 2 |
| 3 | a lane side drops its outcome word (bare `#lane`, the retired spelling) | yes | 17 across 4 files |
| 4 | the renderer prints the stored seven-word value again | yes | 30 across 6 files |
| 5 | the legend stops calling the attribution advisory | yes | 1 |
| 6 | the tool description stops teaching the five outcomes | yes | 1 |

### Verification

`npx tsc --noEmit` clean. `npm run build` + `tests/shared/release-artifacts.test.ts`
green. `git diff --check` clean; zero control bytes in every touched file (one
`\x00` that a heredoc had put in the grouping key was found by that sweep and
replaced with `JSON.stringify`); `grep -c anthropic-ai plugin/scripts/worker.cjs`
= 0.

`bun test`: **4727 pass / 1 fail / 267 files** against the **4723 / 1 / 267**
baseline this branch inherited. The +5 tests are all
`tests/mcp/relations-view.direct.test.ts` (16 → 21: the five outcomes, the
retired-vocabulary pin, the legend pin, the undeclared-registry case; the
`[unplaced]`/half-settled cases they replace are gone). The 1 failure is
**pre-existing at HEAD `8a7af023`** and untouched by this ticket:
`note-settlement-sdk-query.test.ts` "the shape numbers are the induced subgraph…"
expects `alphaShape.edgeCount` 3 and gets 2 — ticket 02's territory.

### For ticket 01's budget — NOT measured on the clone

The production clone could not be made (the sandbox refused the `cp -c` of
`~/.claude-mnemo/claude-mnemo.db`), so the number below is arithmetic on ticket
06's own measured p100 atom, not a measurement: its widest atom
`<- T444 correct(partial) (#extraction-architecture → #prompt-cache-incident)`
(76 chars) becomes 92 chars if both sides derive (`+8` per side), so 40 atoms
≈ **3,680 chars / ~900 estimated tokens**, against ticket 06's 3,079 / 750.
Ticket 01 should re-measure rather than take this.

---

## Integrator adjudication (main, 2026-09-03)

Merged `6a4d95f5` no-ff, clean; bundles rebuilt. `npx tsc --noEmit` 0; guards green; control-byte sweep
over the touched renderer and its test: none. Full `bun test` **4751 / 0 / 268** against 4745/0/268.
Delta accounting: the nine changed test files run 276 → 281 at the pre-merge commit vs HEAD (a detached
scratch worktree at `9f7156c3`), exactly the worker's +5; the remaining **+1 is in a file outside the
diff and I did not locate it** — no loop-generated or `test.each` table I found keys on the changed
`recall` description. Recorded as unaccounted, not hidden. The "pre-existing red" the worker reports is
the 3 → 2 reconciliation already on main as `aac14341` (its base `8a7af023` predates it).

My probes, on sites the worker's six did not touch:

| # | mutation in `src/mcp/relations-view.ts` | result |
|---|---|---|
| I1 | the `E<n>/` task qualifier never printed (always bare `#tag`) | RED ×1: "a side owned by ANOTHER task is qualified" |
| I2 | `formatSides` always prints the pair, never the once form | RED ×6 across the direct set, outer assembly and segment card |

Restored by `cp`, md5 verified. Accepted. Carried forward, as the worker flagged: the tree's lane
suffix still reads raw stored tags (ticket 01's cutover makes stored = resolved for every surviving
row, so this is not a release blocker), and the ~900-token estimate for 40 atoms is arithmetic, not a
clone measurement — ticket 09 re-measures.
