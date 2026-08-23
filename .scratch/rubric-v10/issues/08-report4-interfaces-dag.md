# 08 — Report 4 splits into three blocks: inter-lane interfaces, paths as fact, time-order violations

**What to build:** The lane checker's fourth report re-aims minimality per the
user's T1343 ruling: the aspiration moves from "few in-lane paths" to "few
inter-lane edges, aimed at termini", plus an in-lane DAG guarantee. A settlement
agent calling `lane_check` (and a human at the CLI) sees three blocks instead of
the single path report:

- **(a) Inter-lane interfaces** — for each unordered pair of distinct reported
  lanes {L1, L2}: the count of connecting edges, defined as relation edges over
  the SAME domain as the component graph (stance + consume + grounds;
  aggregation and testimony stay excluded) with one endpoint a member of L1 and
  the other a member of L2, whose canonical tag set is neither L1's nor L2's
  exact set (untagged included). Additionally, per DECLARED lane L: **bypass**
  edges — edges in that same domain arriving from outside L (citing turn not a
  member of L) whose cited turn is a member of L but NOT L's current
  (event-reduced) terminus. Report bypass count per lane with the offending
  edges listed. Few interfaces / zero bypass is the aspiration; nothing is
  enforced.
- **(b) Start-to-terminus path counts** — mechanics unchanged (same-phase and
  folded variants, per-pair dedup, cycle-guarded, indexes/testimony excluded,
  undeclared lanes skipped); any aspiration phrasing in the rendering drops —
  these are facts with no target.
- **(c) Time-order violations** — every relation edge among the loaded turns
  (ALL eight words, aggregation and testimony included) must have its citing
  turn postdate its cited turn: same-session pairs compare prompt_number
  (strictly greater), cross-session pairs compare created_at_epoch (violation
  only when citing's epoch is STRICTLY LESS than cited's; ties pass).
  Self-citations are exempt. Violations are listed verbatim (citing → cited,
  relation, tags). This is the DAG guarantee: edges point to the past, so time
  is a topological order and no cycle can exist unless a violation already
  shows.

**Why (c) is per-edge, not cycle-search:** a forward edge only arises from
retro-editing old notes (the backfill risk surface) and is corrupt on its own,
before any cycle forms. The existing path counter's cycle guard (contributes 0,
never hangs) stays as-is underneath.

**Surfaces (your territory):** `src/shared/lane-checker.ts` (report
structures + computation), `src/db/lane-checker-load.ts` (plumb
`created_at_epoch` into the loaded turn shape — read-only, follow the existing
loader idiom), `src/shared/lane-checker-render.ts` + `src/cli/lane-check-cli.ts`
(CLI rendering), the compact numeric rendering consumed by settlement's
`lane_check` tool (find it from the render module's existing consumers; its
output budget disciplines apply — numbers only, no digraph), and their test
files (including the T900-1001 golden fixture tests — paths must stay unchanged;
record the fixture's new interface/bypass numbers as goldens; fixture has no
cross-session or forward edges, so (c) goldens are empty).

**Not your territory (stop and report rather than edit):**
`src/shared/memory-rubric.ts` (already amended by the main agent),
`src/mcp/note.ts`, `src/shared/turn-phase.ts`, `src/db/schema.ts`, any doc
outside this ticket file. No git commands. No writes anywhere under
`~/.claude-mnemo` (tests use `:memory:` databases). Never run
`node scripts/build.js`.

**Control-byte discipline:** before finishing, byte-scan every file you touched
for literal control bytes (`python3 -c` over the bytes, or `grep -P '[\x00-\x08\x0b\x0c\x0e-\x1f]'`) —
three prior workers wrote literal NUL/SOH into source via \u-escapes in
generated strings; escape sequences must survive as escapes.

**Blocked by:** None — tickets 01-07 are landed and released.

**Status:** ready-for-agent

- [ ] CLI report 4 renders the three blocks; settlement's compact output carries
      interface/bypass/violation numbers within its existing budget
- [ ] Unit: two lanes + an untagged consume bridge → pair interface count 1;
      the bridge landing on a declared lane's mid-lane member → bypass 1;
      re-pointed to the terminus → bypass 0; testimony/aggregation edges never
      counted as interfaces
- [ ] Unit: a same-session forward edge (citing prompt < cited prompt) is
      listed as a time-order violation; a cross-session pair whose
      (session, prompt) tuple order INVERTS wall-clock order passes/fails by
      epoch, not tuple (regression for the tuple-order trap); self-citation
      exempt
- [ ] T900-1001 golden fixture: path numbers unchanged; interface/bypass
      goldens recorded; time-order golden empty
- [ ] `bun test` over every lane-checker/lane-check test file green;
      `bun run typecheck` clean; report declares the load-bearing property per
      criterion with a verbatim re-check command
