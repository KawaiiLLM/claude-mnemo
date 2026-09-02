# 11 — The memory console shows three classes, not seven words

**What to build:** the human console (`src/worker/console-shell.html` → generated `console-shell.ts`, served by `console-api.ts`) stops knowing the seven words. Today it has a closed `WORDS` set of seven driving the filter checkboxes, a CSS custom property per word for edge colour, a legend, edge/detail rendering keyed on `relation`, and special handling of `indexes` in the node detail; `console-api.ts` serves `relation: edge.relation` and sorts by it. After ticket 01 drops the column all of that breaks.

**Blocked by:** 02 (class-keyed readers exist). Must land before 01.

**Status:** LANDED

- [x] API: edges carry `relationClass` (`correct|verify|use`), `relationCoverage` (`full|partial|''`) and per side the resolved attribution `{ lane: qualified tag | null, how: declared|derived|none|ambiguous|invalid }` (from ticket 02's resolver); `relation` gone; sort order class then coverage then ids.
- [x] UI: `WORDS` → three classes; filter bar = three checkboxes; colour = class (three CSS variables replacing seven); line style = coverage (`full` solid, `partial` dashed; verify/use solid); legend rewritten in the rubric's words (correct / verify / use, with the full/partial rule); node detail lists edges as `class(coverage)` with each side's lane and its `declared`/`derived` mark, `·` for none, and highlights `ambiguous`/`invalid` sides; every `indexes`-specific branch removed (no convergence concept).
- [x] No old word in the shipped HTML/TS (grep); the console renders a fixture DB with all three classes, both coverages and all five attribution outcomes without a blank canvas.

## Constraints

- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY; use a fixture or a `cp -c` clone of the scratchpad copy for screenshots/manual checks.
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean`. Restore from your own `cp` copies, md5-verified.
- Explicit pathspecs on every `git add`. No raw control bytes. `grep -c anthropic-ai plugin/scripts/worker.cjs` stays `0`.
- [x] `npx tsc --noEmit` clean; full `bun test` once with every delta accounted; `npm run build` (the console TS is generated from the HTML — follow the existing generation step); stale-bundle and release-artifacts guards green; `git diff --check` clean. No version bump, no push.

## Report

**Files:** `src/worker/console-api.ts`, `src/worker/console-shell.html`,
`src/worker/console-shell.ts` (regenerated via `bun scripts/generate-console-shell.ts`,
never hand-edited), `tests/worker/console-api.test.ts`,
`tests/worker/console-shell.test.ts`.

### API

`ConsoleGraphEdge` now publishes `relationClass` + `relationCoverage` as TWO
fields and a `ConsoleGraphEdgeSide` per end. `relation` is gone; so are
`tailTag`/`headTag`/`tailLaneToken`/`headLaneToken` — the side object carries
exactly their information plus the outcome, and leaving them alongside would
have been two spellings of one fact.

A side is `{ lane, tag, how }`. `lane` is the qualified token (the machine
identity the shell's focus/component maps key on); `tag` is the same lane's
word, on the wire because a token whose lane an interval cut away is
unresolvable client-side and the panel would print raw JSON at the reader.
Both are null together, exactly when `how` is not `declared`/`derived` —
which is the point of the field: three different findings (`none`,
`ambiguous`, `invalid`) used to render identically as `""`.

Nothing new is loaded. Ticket 02's `loadLaneCheckScope` already resolves both
sides through `resolveEdgeSide`/`loadEndpointLaneFacts` and hands the console
`tailTag`/`headTag` (the RESOLVED lane) plus `tailOutcome`/`headOutcome`; this
route projects those. The class comes from `edgeRelationClass`, the one
accessor, so a pre-v13 row reads as the class it means. The handler stays
`Database`-free (its own source guard still passes).

`sortEdgesForDisplay` is class → coverage → citingId → citedId, both tables
consulted by INDEX (the class order is a precedence; alphabetical would only
agree by luck of spelling). Mapping now happens BEFORE the sort so the one
remaining call site and the payload agree on what "class" means. Noted in the
code: `GRAPH_EDGE_MAX` trims by suffix, so an over-cap scope would now drop
`use` before `correct` — a better casualty order for the same bound, and the
bound (10,000 edges against a 2,000-turn window) is not reachable in practice.

### UI

- `WORDS` (four tokens) → `CLASSES` (three); `--rel-correct-full`/
  `--rel-correct-partial` collapse into one `--rel-correct`; three variables,
  three checkboxes.
- Coverage is LINE STYLE: `path.edge.partial { stroke-dasharray:5 3 }`, set
  from `relationCoverage` alone. The dash's previous meaning (lane
  internality, [S15069/T1754]) is RETIRED, not stacked — one channel carries
  one meaning, and `isInternalEdge` is deleted with it. Lane crossing stays
  legible from the lane label both sinks print.
- `#relLegend`: the rubric's two deciding questions, the full/partial rule
  named as the line style it is, and the `correct > verify > use` precedence
  with the one-row-per-pair rule. `#bar` gives up its own border so the two
  rows read as one block.
- Panel/tooltip render `class(coverage)` through `edgeClassLabel` and both
  sides through `edgeSideLabel`: `alpha(declared)` / `alpha(derived)` / `·` /
  a marked `ambiguous` / a marked `invalid`; two identical sides collapse to
  `{alpha(derived)}`, anything else renders `{tail→head}`. `.bad` is styled in
  both sinks (`--rel-correct`) because debt is not a lane word.
- Three closed-set lookups now guard the DOM instead of two: `HOW_LABEL`,
  `COVERAGE_LABEL`+`CLASSES` (through `edgeClassLabel`), and `REL_VAR`
  (through `relationVar`). Only the lane TAG is escaped, at one site.
- The last `indexes` branch (a comment claiming an index declaration "shows as
  an `indexes`-coloured EDGE") is gone; no convergence concept remains.

### Two things that were FALSE at HEAD, fixed here

1. `relationVar = rel => WORDS.includes(rel) ? \`var(--${rel})\` : "inherit"`
   produced `var(--correct(full))` — a property that does not exist. Every
   panel edge row rendered colourless. Now `REL_VAR[cls]`.
2. The filter swatch had the same defect:
   `style="border-color:var(--${w})"`. All four swatches were invisible. Now
   `var(${REL_VAR[c]})`.

### Verification

- `npx tsc --noEmit` clean. `npm run build` green; stale-bundle and
  release-artifacts guards green (they were RED at HEAD — the merged bundles
  were stale). `git diff --check` clean, no control bytes.
- `grep -E "override|narrows|extends|consume|grounds|indexes|verifies|refutes"`
  over `console-shell.html` and `console-shell.ts` → 0 hits. Two innocent
  English "narrows" in comments were reworded so the grep proof is literal.
- Full `bun test`: 4730 pass / 1 fail / 4731 tests. Baseline at HEAD was
  4721 pass / 2 fail / 4723. Delta: +8 tests (5 new API acceptance tests, 3
  new shell tests), +1 (the stale-bundle guard flipped green after the
  rebuild). The one remaining failure is PRE-EXISTING at HEAD and unrelated:
  `tests/worker/note-settlement-sdk-query.test.ts` — "the shape numbers are
  the induced subgraph…", `alphaShape.edgeCount` expected 3, got 2.
- Acceptance fixture: a real `:memory:` DB (6 turns at cardinality 0/1/2, two
  declared lanes, 4 edges) exercising all three classes, both coverages and
  all five outcomes end-to-end through `createConsoleReader` +
  `handleGraphRoute`; the payload is asserted field for field. A real DB
  rather than a fake reader on purpose — the outcomes live in `turns.tags`,
  `segment_members` and `lanes`, three tables from the edge row, so a fake
  asserting `how: "invalid"` would only assert that the test can type the word.
- Manual render check (not committed): the shell's own helpers, lifted from
  the HTML and run over that real payload —
  `T2 —correct(full)→ T1 | var(--rel-correct) | solid | {alpha(declared)→alpha(derived)}`,
  `T5 —correct(partial)→ T3 | var(--draft) | partial | {ambiguous→·}`,
  `T6 —verify→ T4 | var(--draft) | solid | {alpha(derived)→invalid}`,
  `T4 —use→ T1 | var(--rel-use) | solid | {alpha(derived)}`. No blank canvas,
  no empty label. (The two `--draft` strokes are the pre-existing draft-grey
  rule for an edge unattributed on either side, untouched here.)
