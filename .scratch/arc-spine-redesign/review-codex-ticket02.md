Verdict: fix first — not safe to commit.

## Blocker

None found.

## Major

1. **`overflowByDay` counts rows that are also rendered as pulled.**

   Evidence: the contract says that `+N more` counts only turns with no rendered row and that pulled rows do not count (`.scratch/arc-spine-redesign/spec.md:103`). Selection records pulled turn IDs while iterating citations (`src/mcp/timeline.ts:1427-1462`), but the overflow pass skips only `keptIds` (`src/mcp/timeline.ts:1465-1484`). An in-window, non-kept G1/G2 turn cited by a kept row is therefore both visible as a pulled row and included in `overflowByDay`, producing an incorrect `+N more`. The current regression at `tests/mcp/timeline.test.ts:1736-1758` contains only unpulled noise and does not catch the overlap. The ruled fix is the one-line filter to skip `pulledIds` in this pass.

2. **The pre-era legacy adapter ignores authoritative structured citation provenance.**

   Evidence: Rev 4 says structured citations are authoritative and the legacy marker adapter applies to inline citations (`.scratch/arc-spine-redesign/spec.md:70-74`). `EffectiveCitations` carries `source: "structured" | "inline"` (`src/db/citations.ts:347-353`), but `buildCorrectionGraph` applies the reversed-victim fallback to every pre-era citation entry without checking `entry.source` (`src/mcp/timeline.ts:961-967`). Thus a pre-era structured `builds-on`/`evidence-for` edge from a corrector to a reversed turn can be falsely converted into a supersedes edge, causing incorrect victim demotion, corrector promotion, and backlinks. Existing tests cover the inline adapter and era gating (`tests/mcp/timeline.test.ts:1221-1238`) but not this structured-source case. Gate the fallback on inline provenance and add the missing regression.

## Minor

3. **The replacement frozen-fixture guard is materially weaker than the deleted guard.**

   The current replacement fixture is six days of legacy-only synthetic type data with no structured citations, skipped cited rows, mixed-era grades, correction graph, or ranked/pulled interaction (`tests/mcp/timeline.test.ts:1817-1870`). The deleted `HEAD` guard covered heterogeneous release/research/citation-dense fixtures and asserted exact retained prompts plus a 15–25% retention band (`tests/mcp/timeline.test.ts` at `HEAD:2083-2123`; fixture construction at `HEAD:1848-2034`). Removing that percentage assertion is justified by the new no-day-budget contract, but the replacement does not pin comparable end-to-end behavior. Targeted tests cover many individual cases; add one mixed-session guard that checks main rows, pulled rows, and overflow conservation together.

## Summary

- The effGrade truth table, victim-before-corrector precedence, compact/endpoint handling, legacy cap 3, never-anchor rule, effGrade pool gate, distinct-citer tie break, and stable tie ordering are otherwise correct (`src/mcp/timeline.ts:738-789`, `:1321-1425`).
- Pull-through correctly handles skipped citations, title/prompt fallback, era/compact/session/future gates, and kept-citer ownership (`src/mcp/timeline.ts:1427-1462`).
- The interim inline-only `KeptMilestone.references` path remains intact and capped at two, while `pulled` stays separate for ticket 03 (`src/mcp/timeline.ts:249-258`, `:1737-1752`, `:2060-2067`).
- Turns, phases, shape signals, pagination, and milestone injection show no regression beyond intended day-budget removal; focused tests, full tests, `tsc --noEmit`, and `git diff --check` pass.
- Commit after the two major fixes above; no source file or git write was made during this review.
