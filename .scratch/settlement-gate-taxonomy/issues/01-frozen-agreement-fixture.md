# 01 — The frozen-agreement fixture, and the version pin

**What to build:** proof, before any redesign, of whether the three fracture evaluators agree on a database that is not moving — and if they do not, WHICH of them is wrong.

**Blocked by:** None — can start immediately. Everything else in this batch is blocked by this.

**Status:** REPORTED — verdict (a), a genuine live disagreement at HEAD. Version skew is RULED OUT by a byte-identical bundle comparison.

Spec: `.scratch/settlement-gate-taxonomy/spec.md` — "What the peer corrected" governs. No root cause may be asserted before this ticket reports.

- [x] A frozen fixture: `tests/worker/lane-fracture-agreement.test.ts`. One static in-memory DB, one settlement job, three arms at their real seams (`lane_check`, `commit`, `remember(justify)`), red-capable.
- [x] Reproduce the production shape at HEAD — it reproduces exactly, on a read-only snapshot of the live database.
- [x] Version pin — 0.27.0's deployed `worker.cjs` and HEAD's `settlement-child.cjs` are BYTE-IDENTICAL across the whole fracture path.
- [x] Report the finding plainly, no fix designed.
- [x] `npx tsc --noEmit` clean; `bun test` 4735 pass / 0 fail; `git diff --check` clean.

---

## VERDICT: (a) — a genuine live disagreement between the evaluators at HEAD

Not version skew. Not the agent's own intervening writes.

### The evidence for (a)

A read-only snapshot of `~/.claude-mnemo/claude-mnemo.db` was taken with
`sqlite3 -readonly … ".backup /tmp/mnemo-snap.db"` (the live file was never
opened for writing). On that FROZEN copy, at HEAD, with no write of any kind
between the two calls, the two projections for E60's `execution-repair` lane
answer differently:

| | islands | representatives | fractures |
|---|---|---|---|
| `{kind:"turns"}` — job 166's writable set (the `lane_check` preview AND the commit gate) | **6** | 13979, 14043, 14044, 14053, 14055, 14157 | 13979↔14043, 14043↔14044, 14044↔14053, 14053↔14055, 14055↔14157 |
| `{kind:"lanes"}` — whole lane (`justify`) | **1** | 13979 | none |

Both loaded the SAME 39 members. The gate's chain is the production chain of
record, reproduced at HEAD on a static database.

### The evidence against (b) — version skew

Every function on the path was extracted from the deployed 0.27.0
`worker.cjs`, from 0.28.0's `settlement-child.cjs`, and from the repo's own
built `plugin/scripts/settlement-child.cjs`, by brace-matching on
`function <name>(`. All three are **byte-identical**, same length, same text:

```
loadLaneCheckScope            6358 bytes   27 == 28 == repo
checkWindowLanes               919 bytes   27 == 28 == repo
evaluateLaneDispositionGate   2364 bytes   27 == 28 == repo
evaluateJustify               7618 bytes   27 == 28 == repo
computeLaneFractures           513 bytes   27 == 28 == repo
buildComponentReport           988 bytes   27 == 28 == repo
loadEdgesForTag                568 bytes   27 == 28 == repo
loadSegmentTurnIdsCarryingTag  489 bytes   27 == 28 == repo
createLaneTagResolver          652 bytes   27 == 28 == repo
checkLanes                    2286 bytes   27 == 28 == repo
deriveLaneInterpretation      1814 bytes   27 == 28 == repo
```

(0.28.0 moved the settlement tools out of `worker.cjs` into a new
`settlement-child.cjs`; the code did not change.) **A suite that passes at
HEAD does say something about what is running in production, for this region
and only this region.**

### The evidence against (c) — the agent's own writes moved the topology

The frozen snapshot has no intervening write and the disagreement is total.
Writes DO explain why `justify`'s answer TODAY (whole lane, 1 island) differs
from `justify`'s answer on 2026-09-01 (6 islands, reps 13979/14118/14133/
14150/14154/14157) — turn 14157 has since written `indexes` edges to 14118,
14133, 14150 and 14154 plus a `verifies` to 14154, which stitched that tail.
But that is a change in the LANE, not the cause of the disagreement: the
window-scoped view never saw those edges at either instant.

---

## The mechanism

`loadLaneCheckScope` does two things asymmetrically in one pass:

1. **Lane MEMBERSHIP is resolved for every turn in the projection.** `laneTags`
   is computed at the end (`lane-checker-load.ts:1106`) from the turn's own
   `tags` column ∩ its owning segment's declared lanes — for every id in
   `allTurnIds`, no matter how it got there.
2. **Lane EDGE WIDENING runs only for DISCOVERED lanes.** `loadEdgesForTag`
   (`:933`) is called once per `involvedLaneKeys` entry, and `involvedLaneKeys`
   comes only from the seed (edges touching a seed turn, or a seed turn's own
   lane tags).

Between the two sits the **segment-global pass** (`:1028-1043`), which loads
every live turn of every involved lane's SEGMENT and every structural edge
among them, then folds all those endpoints into `allTurnIds`.

Net effect: **any lane of a touched segment materialises with FULL membership
and a partial edge set, and reads as over-severed.** Which edges survive is
decided by the segment-global pass alone — it carries only
`SEGMENT_GRAPH_RELATIONS` = narrows / extends / consume / grounds. The
supplementary citedness/override passes do NOT compensate: they run over
`memberIdList`, which is frozen at `:984`, BEFORE the segment-global pass
widens the turn set at `:1039`. A turn that arrives that late is invisible to
them too.

Measured on the production snapshot, tag-touching relations reaching each
projection:

```
turns-scope (gate):  consume 1, extends 27, grounds 3, narrows 1, override 1, verifies 1
lanes-scope (truth): consume 1, extends 27, grounds 3, narrows 1, override 1, verifies 2, indexes 20
```

**All 20 `indexes` rows are lost.** `indexes` is exactly the word an index or
roll-up turn uses to claim its lane, so this is not a corner case — it is the
common shape.

## Why job 166 could never terminate

Three facts compose into a closed loop:

1. **None of job 166's 109 writable turns carries `execution-repair`.**
   Verified: `writable ∩ lane = ∅`; the writable range is turn ids
   14039..14255 and the lane's 39 members sit outside it. So the lane is never
   DISCOVERED — yet all 39 members enter the projection through the
   segment-global pass, and the gate reports 6 phantom islands.
2. **The lane was TOUCHED, and the touch came from `justify` itself.**
   `lane_run_touches` for job 166 holds exactly one row for this lane:
   `lane | 60 | execution-repair` — a lane-addressed touch, i.e. a landed
   `justify`. There is no edge-side and no tags-write touch. Once the first
   justify landed, the lane was permanently touched for the rest of the job.
3. **Every justify the agent landed was bound to the wrong fingerprints.**
   `lane_disposition_justifications` holds 31 rows for job 166 (plus 4
   inherited from job 165, the 08-30 window that died the same way), on five
   distinct fingerprints:

   ```
   60:execution-repair:13979:14118   ×8   (job 165 ×1, job 166 ×7)
   60:execution-repair:14118:14133   ×6
   60:execution-repair:14133:14150   ×6
   60:execution-repair:14150:14154   ×6
   60:execution-repair:14154:14157   ×5
   ```

   The gate demanded `…:13979:14043`, `…:14043:14044`, `…:14044:14053`,
   `…:14053:14055`, `…:14055:14157`. **The two sets are disjoint.** `justify`
   refuses any pair outside its own whole-lane view; the gate accepts only
   fingerprints from its own window view. No legal sequence of calls exists.
   21 refused commits, 81 minutes, terminal abandonment — and the same trap
   killed job 165 before it.

## A FOURTH disagreement, found on the way and not yet ticketed

`lane_check`'s two halves disagree with each other on the same call:

- the **report-2 connectivity section** is scope-projected to the writable set
  (`projectLaneCheckerResultByScope`, `lane-checker-render.ts:919` — a
  component survives only if some island intersects the window), so E60's
  severed `execution-repair` component is **invisible** in the default view;
- the **LANE DISPOSITION section** appended below it
  (`note-settlement-sdk-query.ts:2020`) calls `evaluateLaneDispositionGate`
  fresh and is NOT projected, so it prints the fractures.

The agent is therefore shown a fracture list for a lane whose component the
same tool result says nothing about. That is the "disposition-ticket /
live-check disagreement" job 166's own abandonment note names.

---

## The fixture

`tests/worker/lane-fracture-agreement.test.ts` — 2 tests, ~130 ms, no network,
no real HOME, deterministic.

Eight turns in one segment with three declared lanes. `ghost-lane`'s six
members are claimed by `indexes` edges only (g2→g1, g3→g2, g5→g4: truthfully
three islands, two fractures g1↔g4 and g4↔g6). `carrier-lane` chains the same
six by `extends` — that is what drags them into the window projection through
the segment-global pass, exactly as production does. `window-lane` is the
job's actual window (prompts 7-8).

**ONE fixture, TWO runs, ONE knob**: the two tests build the identical
database and differ only in `writableTurnIds`.

- lane IN the seed → all three arms agree (`justify` = `1↔4, 4↔6`; after the
  `1↔4` justify lands, preview = gate = `4↔6`, a subset of what justify
  accepts — the run has a legal move).
- lane OUT of the seed → `justify` unchanged at `1↔4, 4↔6`; preview = gate =
  `1↔2, 2↔3, 3↔4, 4↔5, 5↔6`. **Disjoint.** Job 166 in eight turns.

Each arm is read at its real seam: `justify`'s own refusal string
(`"do not name a CURRENT fracture … its remaining fracture(s), by
representative turn id: …"`), the `lane_check` LANE DISPOSITION block, and the
`commit` refusal — never an evaluator internal, and no export was added to
`src/`.

### The command that makes it go red

```
bun test tests/worker/lane-fracture-agreement.test.ts
```

green today (2 pass / 13 expect). To watch it catch this bug, flip the second
test's single knob to the first test's writable set:

```
-      const sets = await collectFractureSets(db, fixture, fixture.windowTurnIds);
+      const sets = await collectFractureSets(db, fixture, [...fixture.windowTurnIds, ...fixture.ghostTurnIds]);
```

```
expect(received).toEqual(expected)
  [ -"1<->2", -"2<->3", -"3<->4", -"4<->5", -"5<->6", +"4<->6" ]
1 pass, 1 fail
```

Verified by running it. The knob is the loader's seed, so the assertion is
red-capable on exactly the defect and on nothing else.

### The production-shape harness (throwaway, not committed)

`/tmp/lane-triad.ts`, `/tmp/lane-probe.ts`, `/tmp/lane-relcheck.ts` against
`/tmp/mnemo-snap.db`. They contain private production content and are
deliberately not in the repo; re-create with

```
sqlite3 -readonly ~/.claude-mnemo/claude-mnemo.db ".backup /tmp/mnemo-snap.db"
sqlite3 /tmp/mnemo-snap.db "PRAGMA journal_mode=delete;"   # so bun:sqlite can open it readonly
```

then call `loadLaneCheckScope` with the two scopes and diff the components.
The live database was only ever opened `-readonly`; nothing was written to it
and no worker was pointed at the copy.

---

## What the next tickets must know

1. **The bug is at the LOADER, not at the gate and not at `justify`.** The
   spec's "bound at the loader" section is the right place; the fix is not a
   reconciliation between evaluators. Ticket 06 retiring `justify` removes one
   of the three voices but does NOT remove the defect — `lane_check` and
   `commit` will still block on phantom fractures of lanes the run never
   touched, with no second opinion left to contradict them.
2. **The specific asymmetry to close**: membership is resolved for every turn
   in `allTurnIds`, edges are widened only for `involvedLaneKeys`. Any
   narrowing must keep those two sets consistent — narrowing membership to the
   three scope sets is only correct if edge widening keeps up with whatever
   membership survives. Reporting a lane whose edges were not widened is the
   defect; keep them coupled.
3. **`memberIdList` is frozen before the segment-global pass** (`:984` vs
   `:1039`). Any repair that relies on the supplementary citedness/override
   passes to recover a late-arriving turn's edges will not work.
4. **The `touch` ledger is durable and job-scoped, and `justify` is a touch
   source.** `lane_run_touches` row `lane|60|execution-repair` survives across
   attempts by design (severed-lane ticket 04). If ticket 06 deletes `justify`
   without deleting the touch class, an inherited lane touch from an earlier
   attempt can still arm the gate over a lane the current attempt never saw.
5. **`lane_check`'s two halves use different scope rules** (the fourth
   disagreement above). Fixing the loader does not by itself make them agree;
   the render-side projection and the disposition block need one rule.
6. **Warning-wording changes alone would not have saved job 166.** The gate was
   demanding a repair that no legal call could perform. The classification
   ruling (severed-lane → WARNING) does fix the symptom, but the phantom
   fracture will keep polluting the warning list and the report until the
   loader is bound.

## UNVERIFIED

- **Frequency.** I confirmed the mechanism on one lane (E60 `execution-repair`,
  job 166) and reproduced it synthetically. I did NOT sweep the database for
  how many other lane/window pairs are currently in the phantom state, nor
  correlate it with the 14-day "3+ commit calls" cohort in the spec. The
  spec's cost numbers are not re-derived here.
- **Job 165.** I read its four inherited justification rows and infer it died
  the same way. I did not replay its writable set.
- **The `override`/`verifies` survivors.** One `override` and one `verifies`
  row did reach the window projection; I attribute that to the supplementary
  passes catching an endpoint that was already in `memberIdList` for another
  reason, but I did not trace those two rows individually.
- **The live plugin.** The bundle comparison proves the CODE is identical. I
  did not confirm which version the currently-running worker process has
  loaded; the 0.27.0 pin comes from the ticket brief, and 0.28.0 is cached but
  may or may not be live.
- **The fourth disagreement** (`lane_check`'s projected report vs its
  unprojected disposition block) is asserted from reading `:919` and `:2020`
  and is consistent with job 166's abandonment note. It is NOT covered by the
  committed fixture — that fixture's first test happens to put the lane inside
  the writable set, so both halves render it.
