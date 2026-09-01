# 02 — Three named scopes, bound at the loader

**What to build:** the projection stops being one undifferentiated id set and stops dragging whole lanes into memory. A settlement run's check surface loads only what its judgment, its evidence and its one boundary witness require.

**Blocked by:** 01 — RESOLVED at `53597ffc`, and it changed this ticket's job. Read its Status before starting.

**THE DEFECT TICKET 01 FOUND, which this ticket now owns:** `loadLaneCheckScope` does two asymmetric things in one pass — it resolves MEMBERSHIP for every turn in the projection, but WIDENS EDGES only for seed-discovered lanes. So any lane in a touched segment materialises with FULL membership and a PARTIAL edge set, and reads as over-fractured. On E60's `execution-repair` the window projection kept 33 edges and lost all 20 `indexes` edges — the very relation an index/convergence turn uses to declare its lane. That is what makes phantom fractures, and narrowing the scope WITHOUT closing the asymmetry reproduces it exactly. `memberIdList` freezes at `lane-checker-load.ts:984`, BEFORE the segment-graph pass at `:1028-1043`, so no supplementary pass can repair it after the fact.

**Status:** REPORTED — all seven boxes done.

Spec: `.scratch/settlement-gate-taxonomy/spec.md` — "One evaluator, one scope definition, two evaluations" and "Bound at the loader" govern.

- [x] Three roles, named in the type system, never collapsed: **judgment anchors** = the window's 50 prompt numbers plus the 50 immediately preceding prompt numbers of the same session; **evidence closure** = the remote endpoints needed to explain those anchors, readable but never a source of reported findings; **boundary witness** = for each component the window touches, exactly ONE nearest out-of-window component.
- [x] **The asymmetry closes: membership resolution and edge widening cover the SAME lane set.**
- [x] The narrowing reaches `loadLaneCheckScope`.
- [x] The boundary witness may scan the lane to find its one target and may emit only that one.
- [x] Findings anchored in the evidence closure appear in NO report and in NO gate.
- [x] "Preceding 50 prompt numbers of the same session", not the lane's own preceding 50 members.
- [x] `npx tsc --noEmit` clean; full `bun test` 4717 pass / 0 fail; bundles rebuilt, stale-bundle guard green; `git diff --check` clean.

---

## What changed

Two files carry the whole repair.

**`src/db/lane-checker-load.ts`** — the loader.

- New exported surface: `JUDGMENT_LOOKBACK_PROMPTS = 50`, `LaneJudgmentWindow`
  (`{sessionId, windowStart, windowEnd}`), `LaneCheckTurnRole`,
  `LaneCheckRoles`, and `anchorsInJudgment(roles, turnId)` — the ONE predicate
  for "may a finding anchored here be reported". `{kind:"turns"}` gains an
  optional `judgment` field; `LaneCheckProjection` gains `roles`.
- **The asymmetry closes at `laneTags`.** `membersByLaneToken` records, per
  widened lane, exactly which members the projection emitted, and the final
  membership resolution (`emittedLaneTagsFor`) intersects the registry answer
  with it. The pure core enumerates lanes from `laneTags` alone, so a lane
  whose edges were not widened has no member, is not enumerated, and appears in
  no report / no count / no gate. This runs for EVERY caller, window or not.
- **The narrowing, under a judgment window.** The WIDEN block still SCANS each
  involved lane whole (it must — components cannot be computed without the
  edges), then keeps only the components the judgment anchors touch plus
  `nearestUntouchedComponent` per touched one. Component partition reuses
  `laneMembershipClaims`, the same predicate `buildComponentReport` uses, so
  the loader and the core cannot disagree about what a claiming edge is.
- **The segment-global pass stops scanning whole segments.** With a window it
  runs over the projection's own turns plus one structural hop, which is the
  evidence closure's definition. Without one it is unchanged.

**`src/worker/note-settlement-sdk-query.ts`** — the seam.

- `SettlementProjectionScope` gains `judgment?`. One per-request
  `projectionScope()` closure replaces four hand-copied literals in each of the
  two builders (eight sites), so a field can no longer be added to three of
  them and forgotten in the fourth.
- `checkWindowLanes` — the single seam both the preview and the terminal gate
  read — filters `result.errors` through `anchorsInJudgment` once. One
  predicate, both surfaces.

## Measurements — production snapshot, job 166 (S15069, window 2202-2251)

Read-only snapshot: `sqlite3 -readonly ~/.claude-mnemo/claude-mnemo.db ".backup /tmp/t02-snap.db"`. The live file was never opened for writing; the snapshot is deleted.

Seed = job 166's own 109-turn writable set. E60's largest lane is
`milestone-design` (297 declared members, spread across prompts 139..2264 of
one session).

| | before (HEAD~) | asymmetry fix only | + judgment window (production path) |
|---|---|---|---|
| turns loaded | 1524 | 1524 | **282** |
| edges loaded | 1619 | 1619 | **355** |
| rows loaded (turns+edges) | 3143 | 3143 | **637** (−80%) |
| loader wall clock | 1828 ms | 1861 ms | **123 ms** (14.9×) |
| rendered characters (`renderLaneCheckerReports`) | 113,780 | 63,997 | **10,327** (−91%) |
| `lane_check` page 1 (paged+actionable) | 13,470 | 13,470 | **8,137** |
| errors classed | 435 | 435 | **0** |
| lanes REPORTED | 34 | 5 | 5 |
| lanes WIDENED | 5 | 5 | 5 |
| `milestone-design` | 295 members / 35 islands | 295 / 35 | **195 / 4** |
| `execution-repair` (job 166's killer) | 39 members / 6 islands | **NOT REPORTED** | **NOT REPORTED** |

Ticket 01's 79K/97K renders are the same quantity as the 113,780 column
(different windows). It is now 10,327 — under the tool-result cap with room to
spare, and 0 of those characters are phantom-fracture repair demands.

Errors anchored inside the writable set: **0 before, 0 after.** Nothing this
run could repair was lost; all 435 were E3s on E60 turns the segment-global
pass had dragged in from outside the window entirely.

Boundary witness on the real corpus, per lane (touched / witness islands):
`milestone-design` 35 islands → 2 touched + 2 witnesses; `release-verification`
12 → 1+1; `watchdog-liveness` 9 → 1+1; `lane-impressions` 7 → 1+1;
`acceptance-audit` 1 → 1+0. Never N−1.

Roles partition: 95 judgment / 171 evidence / 16 boundary = 282 turns.
No dangling edges, every lane's `coverage` still `whole`, in both modes.

## Fixtures, and the mutation each one catches

`tests/db/lane-check-judgment-scope.test.ts` (new, 5 tests) —
`tests/worker/settlement-evidence-closure.test.ts` (new, 3 tests) —
`tests/worker/lane-fracture-agreement.test.ts` (ticket 01's, second case rewritten).

Three mutations were applied to the loader and run:

1. **Restore unrestricted `laneTags`** (`laneTagsFor` in place of
   `emittedLaneTagsFor`) → RED: the "reported implies widened" test, AND
   `lane-fracture-agreement`'s second case, which comes back with exactly the
   production shape `1<->2, 2<->3, 3<->4, 4<->5, 5<->6` against justify's
   `1<->4, 4<->6`.
2. **Keep every untouched component** instead of the nearest one → RED: ONLY
   the boundary-witness test (5 components instead of 2).
3. **`promptStart = 0`** (a lookback that reaches the whole session, which is
   what a member-counted lookback gives on the sparse fixture) → RED: both
   lookback tests.

`lane-fracture-agreement`'s second case needed a fixture change to be honest:
the window turns now also claim `carrier-lane`, so the six ghost turns are in
the projection under the judgment window too. Without that the judgment
narrowing alone kept them out and the test would have passed by scope luck —
the exact failure mode the ticket warns about. Verified: with the change,
mutation 1 alone turns it red.

The evidence-closure fixture is one database with one knob: an E6 draft edge on
a lookback turn at prompt 900 and an identical one on the window turn at prompt
1001, both writable. With the judgment window the gate refuses over the window's
alone and says nothing about the other — not even as a "further error(s)"
remainder; drop the window from the scope and the same call refuses over both.
A third test drives the real `lane_check` handler and asserts the same split in
the rendered report.

## Two pre-existing tests changed, and why

Both changed because ticket 02 is doing its job, not because an assertion was
in the way.

- `note-settlement-sdk-query.test.ts` — "the default scope reads the request's
  writable set…". Its `outside` turn is at prompt 4, PAST the window's
  `windowEnd` of 3, so it is not a judgment anchor and its E6 is now reported by
  neither scope. This is the spec's own "the agent-facing `scope: "all"`
  widening is removed". The test now asserts the stronger and more useful
  thing: the row is still LOADED (report 1's citedness names the very edge
  whose error is suppressed), so it pins finding-suppression rather than a
  projection that quietly stopped reading.
- `note-settlement-sdk-query.test.ts` — "staged settlement ticket 07 …". Its
  removed-side citer sits at prompt 7, past that dispatch's `windowEnd` of 5.
  The E3 accounting line ("N further error(s) … turn-TYPE debts (E3)") is gone
  because there is no remainder left to account for. As a by-product, the
  comment that `lane_check`'s preview LAGS the gate on that E3 is no longer
  true — the two now say the same thing, which is ticket 03's goal reached
  early for this one case.

## Design choices the spec left open

1. **"Nearest" is measured on member-id spans, tie-broken to the smaller
   representative.** `computeLaneFractures` walks a lane's islands in
   representative (smallest member id) order and pairs each with the NEXT, so a
   witness chosen by any other measure would be a stitch target the fracture
   list then refuses to name. Overlapping spans score 0 and win.
2. **A lane whose components the judgment anchors touch NOWHERE contributes
   nothing** — no member, no edge, not reported. It was discovered through a
   writable turn outside the judgment set, so nothing it could say may anchor
   anyway.
3. **The evidence closure is one structural hop out of the loaded set.** That
   is what replaced the whole-segment scan for report 4b. It covers every
   three-node detour around a judged turn; a four-node-or-longer detour that
   leaves the closure entirely is given up. Bypass candidates on job 166: 76 →
   15.
4. **A `DEFAULT_SEGMENT` (homeless) lane emits nothing under a judgment
   window.** It has no `segment_members` rows, so no component can be touched.
   The core never enumerates a homeless lane anyway.
5. **Judgment anchors are a filter, not a seed.** The projection still seeds on
   the caller's writable set; the judgment set only decides what may be judged
   and which components count as touched. So the projection is a strict subset
   of what it used to be — no finding this change introduces is new.
6. **The per-lane SQL read is still whole-lane.** `loadEdgesForTag` /
   `loadSegmentTurnIdsCarryingTag` cannot be narrowed in SQL, because the
   components that decide the narrowing are computed from exactly those rows.
   The spec sanctions the scan ("Scanning the lane to find it is allowed"); what
   stopped being unconditional is what ENTERS the projection and what the core
   computes over. The 15× wall-clock win came from the segment-global pass, not
   from the per-lane reads.

## Gaps handed on

- **`LaneCoverage` now under-reports truncation.** It answers "is every
  claiming edge's endpoint loaded" (still `whole`, verified), NOT "is the whole
  lane loaded". A reader of a narrowed lane's report 1 sees 195 members where
  the lane has 295 and nothing says so. Naming that in the render is ticket
  03/04's surface, not this ticket's loader — flagged, not invented.
- **A writable turn outside the judgment set can now be written dirty.** A
  closure turn 90 prompts back is still writable, and an E4/E6 the run creates
  there will not block its own commit. This follows directly from the ruling
  ("errors and warnings may anchor only here") and from this ticket's own
  acceptance criterion 5, but it is a real hole that did not exist before and
  ticket 04 should decide whether authority and judgment must be intersected at
  the write face instead.
- **The fourth disagreement ticket 01 found** (`lane_check`'s projected report
  vs its unprojected disposition block) is untouched. It is ticket 03's.

## UNVERIFIED

- **Only job 166's window was measured.** I did not sweep other windows or
  other segments for the before/after, and did not re-derive the spec's 14-day
  cost numbers.
- **The disposition-gate line count.** I proved `execution-repair` is no longer
  reported at all, so its five phantom fractures cannot be demanded. I did NOT
  replay job 166's own touch ledger to render the LANE DISPOSITION block
  before/after — `runTouches` is per-run state that a read-only snapshot does
  not reproduce.
- **Report 4b's loss is measured (76 → 15) but not audited.** I did not check
  whether any of the 61 dropped bypass candidates would have survived the
  render's own `actionable` window filter.
- **The live worker.** Nothing here is live until `/plugin` update + a cold
  restart. Ticket 07's instruction to confirm the running version explicitly
  still stands.
