# 11 — A lane-local correction stays local: death and exclusion become per-lane

**What to build:** a tagged `override`/`refutes` acts on the lane it names and nowhere else. Today both the milestone election and the console treat it as a fact about the TURN, so a repair aimed at one lane costs the corrected turn its standing in every other lane it belongs to.

**Blocked by:** 03 (shipped).

**Status:** ready-for-agent

Peer finding P1-5, confirmed against the source: `milestone-election.ts` excludes `edge.citedId` for ANY `override`/`refutes` without consulting tags at all, and `console-api.ts` folds "dead in some lane" into a turn-level `isDead` that renders beside `isTerminus: true`.

- [ ] Election candidacy exclusion is lane-scoped: an UNTAGGED override/refutes excludes the cited turn globally (that is what untagged MEANS — a global repudiation); a tagged one removes it only from the lanes it names. A turn that is still a valid terminus elsewhere keeps its seat there.
- [ ] The console payload carries per-lane member state rather than one boolean per turn: a turn dead in lane A and alive in lane B renders dead only while A is in view. `isTerminus` and death may never both be true for the SAME lane.
- [ ] Failure case to pin as a test, from the peer: release R declares `indexes{a}`, `indexes{b}`, `indexes{c}`; repair X writes `override{a} → R`. Lane `a` reopens; `b` and `c` stay closed-valid with R as their terminus; R keeps its election seat on account of `b`/`c`; the console shows R dead only under `a`.
- [ ] Any other reader that collapses lane state onto a turn is found and named in the report, even if it is left alone.

**File ownership:** `src/shared/milestone-election.ts`, `src/worker/console-api.ts`, `src/worker/console-shell.html` (regenerate `console-shell.ts`), and their tests. NOT `src/shared/lane-checker.ts` or `src/db/lane-checker-load.ts` (ticket 12 owns those, running in parallel), NOT `src/mcp/**`.
