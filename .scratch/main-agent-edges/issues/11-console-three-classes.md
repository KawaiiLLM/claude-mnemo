# 11 — The memory console shows three classes, not seven words

**What to build:** the human console (`src/worker/console-shell.html` → generated `console-shell.ts`, served by `console-api.ts`) stops knowing the seven words. Today it has a closed `WORDS` set of seven driving the filter checkboxes, a CSS custom property per word for edge colour, a legend, edge/detail rendering keyed on `relation`, and special handling of `indexes` in the node detail; `console-api.ts` serves `relation: edge.relation` and sorts by it. After ticket 01 drops the column all of that breaks.

**Blocked by:** 02 (class-keyed readers exist). Must land before 01.

**Status:** ready-for-agent (after 02)

- [ ] API: edges carry `relationClass` (`correct|verify|use`), `relationCoverage` (`full|partial|''`) and per side the resolved attribution `{ lane: qualified tag | null, how: declared|derived|none|ambiguous|invalid }` (from ticket 02's resolver); `relation` gone; sort order class then coverage then ids.
- [ ] UI: `WORDS` → three classes; filter bar = three checkboxes; colour = class (three CSS variables replacing seven); line style = coverage (`full` solid, `partial` dashed; verify/use solid); legend rewritten in the rubric's words (correct / verify / use, with the full/partial rule); node detail lists edges as `class(coverage)` with each side's lane and its `declared`/`derived` mark, `·` for none, and highlights `ambiguous`/`invalid` sides; every `indexes`-specific branch removed (no convergence concept).
- [ ] No old word in the shipped HTML/TS (grep); the console renders a fixture DB with all three classes, both coverages and all five attribution outcomes without a blank canvas.

## Constraints

- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY; use a fixture or a `cp -c` clone of the scratchpad copy for screenshots/manual checks.
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean`. Restore from your own `cp` copies, md5-verified.
- Explicit pathspecs on every `git add`. No raw control bytes. `grep -c anthropic-ai plugin/scripts/worker.cjs` stays `0`.
- [ ] `npx tsc --noEmit` clean; full `bun test` once with every delta accounted; `npm run build` (the console TS is generated from the HTML — follow the existing generation step); stale-bundle and release-artifacts guards green; `git diff --check` clean. No version bump, no push.
