# 03 — Lane identity collapses to a single tag, and the graph's verdicts are re-derived

**What to build:** a lane is `(segment, ONE tag)`. An edge carrying `["a","b"]` is a member of lane `a` AND lane `b` — the user ruled MERGE, so verdicts that used to be isolated by the exact set now interact, and that is the intended behaviour rather than a regression to suppress.

**Blocked by:** None — can start immediately (it changes the checker's own identity, not the registry).

**Status:** done (shipped earlier in this batch — see the commit that closes each box)

Spec: `.scratch/lane-declaration/spec.md` (Rev 2) — D5 and the whole "What this CHANGES about existing verdicts" section.

- [ ] `LaneKey` is `{ segment, tag }`; `laneToken(segment, tag)`. A lane's DAG is every live edge carrying that tag with an endpoint in that segment; members are its endpoints.
- [ ] The peer's figure is a fixture and passes with the NEW verdict: `T2 --indexes{a}--> T1` closes lane `a`; then `T3 --override{a,b}--> T2` kills T2 in lane `a` too and REOPENS lane `a`.
- [ ] The old pin that `{A}`, `{B}`, `{A,B}` are three independent lanes is replaced, not deleted quietly: its replacement asserts the merged reading in the same place.
- [ ] Election / milestone tier and self-ground eligibility fixtures are re-baselined. Every tier that changes is listed in the ticket's completion report with the before/after value — silence about a changed tier is a failed acceptance.
- [ ] The console payload carries `laneTokens: string[]` per edge (an edge in two lanes appears in both) instead of a single `laneToken`; the API tests assert the plural shape. The SHELL's own focus/highlight work is ticket 05 — do not touch `console-shell.html`.
- [ ] Everything still typechecks and the full suite is green apart from tests ticket 05/06/07 own.

**File ownership:** you own `src/shared/lane-interpretation.ts`, `src/shared/lane-checker.ts`, `src/shared/lane-checker-render.ts`, `src/shared/milestone-election.ts`, `src/db/lane-checker-load.ts`, `src/worker/console-api.ts` and their tests. You do NOT own `src/db/schema.ts`, `src/mcp/remember.ts`, `src/db/lanes.ts` (ticket 01), `src/worker/console-shell.html` (ticket 05), `src/mcp/segment-card.ts` (ticket 06) or `src/mcp/timeline.ts` (ticket 07). Stop and report rather than editing across that line.
