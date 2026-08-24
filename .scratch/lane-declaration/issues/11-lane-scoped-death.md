# 11 — A lane-local correction stays local: death and exclusion become per-lane

**What to build:** a tagged `override`/`refutes` acts on the lane it names and nowhere else. Today both the milestone election and the console treat it as a fact about the TURN, so a repair aimed at one lane costs the corrected turn its standing in every other lane it belongs to.

**Blocked by:** 03 (shipped).

**Status:** done — mutation-verified on acceptance

Peer finding P1-5, confirmed against the source: `milestone-election.ts` excludes `edge.citedId` for ANY `override`/`refutes` without consulting tags at all, and `console-api.ts` folds "dead in some lane" into a turn-level `isDead` that renders beside `isTerminus: true`.

- [x] Election candidacy exclusion is lane-scoped: an UNTAGGED override/refutes excludes the cited turn globally (that is what untagged MEANS — a global repudiation); a tagged one removes it only from the lanes it names. A turn that is still a valid terminus elsewhere keeps its seat there. **A tagged one now excludes nothing at all** — the per-lane arithmetic tier ② already runs off the same `dead`/`terminus` facts, so a second, parallel exclusion rule would double-count it.
- [x] The console payload carries per-lane member state rather than one boolean per turn: `laneMemberships: {token, isTerminus, dead}[]` replaces `lanes[]` + the two booleans. The shared graph dot, which must settle on ONE glyph, rings on ANY-lane terminus and crosses only on ALL-lanes death; the turn panel shows the literal per-lane truth, chip by chip.
- [x] Failure case pinned as a test at both seams (election + payload), watched red first.
- [x] Any other reader that collapses lane state onto a turn is found and named. **Found: `src/db/edge-signals.ts`'s `TurnEdgeSignals.overridden`** — set by ANY live `override` with zero tag filtering. Left alone deliberately: `getTurnEdgeSignals` has NO production caller left (the milestone election retired that whole lexicographic chain), so the module is dead weight kept alive by its own tests and the retirement grep-guards. Deleting it is its own ticket.

**File ownership:** `src/shared/milestone-election.ts`, `src/worker/console-api.ts`, `src/worker/console-shell.html` (regenerate `console-shell.ts`), and their tests. NOT `src/shared/lane-checker.ts` or `src/db/lane-checker-load.ts` (ticket 12 owns those, running in parallel), NOT `src/mcp/**`.

## Left OPEN by this ticket — a ruling is needed

**Can a lane's `lastDeclarer` be a node that is dead in that same lane?** `deriveLaneStates` computes `lastDeclarer` without consulting `LaneMember.dead`, so after a tagged `override{a} → R` reopens lane `a`, R still seats at tier ② as lane `a`'s own "open lane's last declarer" — while being dead in `a`. The old blanket exclusion hid this; lane-scoping surfaces it. Pinned as a test describing the CURRENT behaviour, not silently patched: the fix would live in `lane-interpretation.ts` (ticket 12's file) and it is a model question, not a code defect — is the reopened lane's anchor still the node whose declaration was just withdrawn, or the correction that withdrew it?

Two lesser facts, neither a regression: tier ②'s `reason` label is first-lane-wins when several lanes qualify a node simultaneously (the tier is right, only the label can mislabel), and a tagged `refutes` produces no lane-state event at all — the reduction knows only `indexes`/`override` — so its tag buys membership and nothing else, which is what rubric v11 says and may well be intended.
