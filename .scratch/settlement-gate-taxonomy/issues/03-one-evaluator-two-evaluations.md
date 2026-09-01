# 03 — One evaluator, evaluated twice; no escape hatches

**What to build:** `lane_check` becomes an honest preview of the verdict `commit` will reach, by construction rather than by convention — and the two ways the two could drift apart are removed.

**Blocked by:** 02 — RESOLVED at `658fbcf8`.

**Status:** REPORTED — all six boxes done.

Spec: `.scratch/settlement-gate-taxonomy/spec.md` — the same section. NOTE the rejected design: a literally shared, computed-once snapshot goes stale under the run's own writes. One DEFINITION, two evaluations.

- [x] One evaluator and one scope descriptor, consumed by the `lane_check` preview and by the terminal transaction's own fresh recomputation. `commit`'s refusal becomes a RENDERING of that result, not a second computation of it.
- [x] `remember(justify)` left untouched and unreferenced by the new evaluator. Ticket 06 has NOT landed; the old path runs beside the new one, and this ticket's own fixture uses it only as an independent WITNESS.
- [x] The agent-facing `scope: "all"` widening is REMOVED — the parameter is gone from the tool shape, from the description and from the render.
- [x] Missing production provenance FAILS CLOSED, on both surfaces. The whole-history fail-open is gone from `projectLaneCheckerResultByScope` too (`actionableTurnIds` is required).
- [x] Fixture: preview and terminal verdict agree on a MOVING database.
- [x] `npx tsc --noEmit` clean; full `bun test` 4744 pass / 0 fail; bundles rebuilt, stale-bundle guard green; `git diff --check` clean.

---

## What changed

Two source files.

**`src/shared/lane-checker-render.ts`** — the render stops projecting.

- `LaneCheckerScope` (`"actionable" | "all"`) DELETED; `LaneCheckerPageOptions`
  loses both `scope` and `actionableTurnIds`. `renderLaneCheckerReportsPaged`
  renders what it is given.
- `projectLaneCheckerResultByScope(result, actionableTurnIds)` — one parameter
  fewer and no optional set. Both escape hatches lived in that signature:
  `scope === "all"` and `actionableTurnIds === undefined`, the latter being the
  spec's "missing production provenance … falling open to whole history".
  The per-family predicate table is unchanged.

**`src/worker/note-settlement-sdk-query.ts`** — the evaluator, and the fail-closed edge.

- `checkWindowLanes` → `evaluateWindowLanes`, returning a named
  `SettlementLaneEvaluation`. It now applies BOTH filters — ticket 02's
  `anchorsInJudgment` and the actionable projection against
  `scope.writableTurnIds` — and nothing downstream filters again.
- `evaluateLaneDispositionGate(db, evaluation, runTouches)`: it no longer takes
  a scope and no longer recomputes. There is no projection step left in it to
  get wrong.
- `evaluateSettlementCommitGate` splits into itself (evaluate + render, kept as
  the direct-call test seam) and `renderSettlementCommitGateRefusal(db,
  evaluation, scope, provenance)`. Production calls the renderer with the
  evaluation it already holds.
- Both `lane_check` handlers and both `evaluateTerminalGates` callbacks build
  ONE evaluation per call and render twice from it. Before: two independent
  `loadLaneCheckScope` + `checkLanes` passes per tool call, under two different
  scope rules.
- `settlementScopeProvenanceFailure` + `SETTLEMENT_PROJECTION_FAILURE_NO_PROVENANCE`
  — the system-failure channel's first case, asked at the tool path only.

## Ticket 01's fourth finding, closed

Inside one `lane_check` call the report-2 section was projected
(`projectLaneCheckerResultByScope`, inside the render) and the LANE DISPOSITION
block below it was not (`evaluateLaneDispositionGate` re-ran the whole gate).
Reproduced verbatim by mutating the fix out — the failing text of
`tests/worker/settlement-one-evaluator.test.ts`, first test, is job 166's
disagreement in eight turns:

```
## Report 2 -- connectivity over each lane's OWN edges …
Lane E3:{window-lane} - components: 1 (healthy)
  island@S1/T7: S1/T7,S1/T8
…
LANE DISPOSITION (ticket 02 — MANDATORY at commit; 1 fracture(s) touched by this run still owe a disposition):
  [LANE-DISPOSITION] E3 lane "outside-lane" — severed fracture S1/T4 <-> S1/T6 has no stitching edge and no justify on record.
```

The connectivity half says nothing about `outside-lane`; the block below
demands a repair for it. One filter now, both halves.

## Fixtures, and the mutation each one catches

`tests/worker/settlement-one-evaluator.test.ts` (new, 3 tests) — one fixture,
two writable sets. One segment; `window-lane` = w1/w2 (prompts 7-8, the job's
window, whole); `outside-lane` = o1..o6 (prompts 1-6), claimed by `indexes`
edges only, truthfully three islands and two fractures. A DISCOVERY EDGE
`w1 --grounds--> o1` carries `window-lane` on its tail and `outside-lane` on its
head, so the loader discovers and fully widens the lane (it is a real reported
lane, not ticket 01's phantom) while `w1` never becomes a MEMBER of it. So every
member of a genuinely severed, genuinely touched lane sits outside the writable
set — the exact shape the two halves disagreed about.

Four mutations were applied and run:

1. **The disposition block re-computes UNPROJECTED** (the pre-ticket-03 shape,
   reconstructed inside the `lane_check` handler) → RED, on the
   `not.toContain("LANE DISPOSITION")` assertion, with the output quoted above.
   Only that test.
2. **A computed-once snapshot** (`evaluateWindowLanes` memoised) → RED, only the
   moving-database test, and at exactly instant B:
   `expect([]).toEqual(["S1/T8"])` — the frozen answer surviving the retraction
   that removed the error. That is the third answer the spec says a snapshot
   produces.
3. **The provenance guard returns `null` always** → RED, only the fail-closed
   test, and because `lane_check` handed back a complete report (`## ERRORS
   1 error(s) [E6] anchor S1/T1 …`) where the failure text belongs.
4. **`projectLaneCheckerResultByScope` returns `result` unchanged** → RED in 5
   tests across 2 files: the three per-family projection tests and both
   two-halves tests. Nothing else in the suite depends on it, which is the
   honest reading of "the projection is load-bearing exactly here".

**The self-check ticket 02 asks for.** The two-halves fixture cannot pass by
scope luck: it carries an explicit CONTROL inside the same run — a landed
`justify` (production's own touch source; job 166's `lane_run_touches` held one
row and it came from a justify), and a second `justify` whose refusal
enumerates the still-open fracture. So at the instant of the asserted
`lane_check` call, "this lane is severed AND this run touched it" is proved true
by an evaluator this ticket does not touch. The assertions are then made on the
`## Report 2` SECTION and on the disposition tail OF ONE RENDERED STRING, not on
two calls.

The moving-database fixture is three writes and two instants in one run: mint a
DRAFT edge (E6) → preview names `S1/T8`, `commit` refuses over `S1/T8`; retract
it → preview names none, `commit` succeeds. The two surfaces are parsed with the
SAME regex and compared per instant, and the two instants are asserted to
differ. A frozen database would satisfy the first four assertions; the last two
are what make it about a moving one.

`tests/worker/note-settlement-sdk-query.test.ts` — two pre-existing tests
INVERTED, because they asserted the two behaviours this ticket removes:

- "the registered shape declares scope as an optional enum accepting exactly
  actionable/all" → "the registered shape declares NO scope parameter at all"
  (`page`/`pageBudget` still asserted present, so the absence is about `scope`
  and not about a shape that failed to register), plus the tool DESCRIPTION no
  longer teaching `"all"`.
- "omitting scopeProvenance falls back to the old flat, undifferentiated list" →
  "a call with NO scopeProvenance yields the system-failure channel from both
  surfaces". Its fixture is unchanged and deliberately dirty (an E6 in the
  writable set), so both assertions fail on the guard's removal and neither can
  pass by having nothing to report. It also asserts the job stays `claimed`.

`tests/shared/lane-checker-render.test.ts` — the scope describe block moved from
`renderLaneCheckerReportsPaged(…, {scope, actionableTurnIds})` to
`projectLaneCheckerResultByScope` directly, with the render as the control arm.
Every per-family assertion is preserved; the `"all"` arm becomes "the
unprojected result", which is a stronger control (it proves the out-of-window
entries are really in the fixture). The fail-open test is replaced by "an EMPTY
actionable set projects everything decidable away", which is the nearest thing a
caller can still express and goes red on a re-added `size === 0` short-circuit.

## Test-suite churn, and why it is not incidental

47 request literals across four test files gained a `scopeProvenance` (44 of
them in `note-settlement-sdk-query.test.ts`), through a new
`settlementScopeProvenanceFor(db, sessionId, writableTurnIds, windowStart,
windowEnd)` in `tests/support/settlement-config.ts` — window = the writable ids
whose prompt number falls inside the declared bounds, everything else filed as
declared lookback. That is the fail-closed rule doing its job: a fixture that
drives the real `lane_check`/`commit` tool path now has to model the same field
production always supplies. The 11 DIRECT calls to
`evaluateSettlementCommitGate` were NOT touched and still pass scopes with no
provenance and no judgment window — that is precisely the ticket's "a test seam
that needs a legacy fallback must not reach the production tool path".

## Design choices the spec left open

1. **Where the fail-closed check lives: the TOOL PATH, keyed on
   `scopeHolder.current.scopeProvenance`.** Not inside `evaluateWindowLanes`,
   because that function's callers include direct-call test seams the ticket
   explicitly permits to keep a legacy fallback. Not at request construction
   either: a dispatch that cannot project should refuse the CHECK, not fail to
   start, so the failure is observable at the surface that would otherwise have
   lied.
2. **`commit` fails closed too, not only `lane_check`.** The ticket's fixture
   wording names the report; guarding only the preview would have created a
   fresh preview/verdict divergence of exactly the class this ticket removes —
   the preview refusing to project while the verdict judged anyway.
3. **The system-failure TEXT is a plain string, not a type.** Ticket 05 owns the
   typed channel, the other three cases and the worker-log path, and it is
   blocked on this ticket for this seam. Building the type here would have
   pre-empted its design; leaving the behaviour out would have left the ticket's
   own acceptance criterion unmet. The text carries no repair sentence at all,
   which is the spec's own "never handed a list that pretends to be repairable".
4. **The commit refusal's "N further error(s) anchor OUTSIDE your writable set"
   line is DELETED.** With the projection at the seam, `result.errors` has no
   out-of-set member left and the line could only ever print "0". It was also
   the last place `commit` counted findings `lane_check` had never shown — the
   preview's default projection has dropped those rows since
   settlement-ergonomics ticket 06. Ticket 17's E3 remainder survives, because
   it names a class that IS in the writable set and IS shown by the preview.
5. **`projectLaneCheckerResultByScope` stays in `lane-checker-render.ts`**
   although the render no longer calls it. Moving a 100-line pure function plus
   its two private helpers to a new module is churn with no reader benefit; the
   doc says where its caller went.
6. **The disposition gate narrows with the projection, and that is a real
   behaviour change.** A severed lane whose members are ALL outside the writable
   set no longer owes a disposition, even when this run touched it through a
   lane-addressed `justify`. This is job 166's trap closed from the second side
   (ticket 02 closed it from the loader's): the gate can no longer demand a
   repair for a lane the same tool result declines to describe and the run
   cannot address. Ticket 04 removes the blocking entirely, so the direction is
   the batch's own.

## Gaps handed on

- **Ticket 04's criterion "The `lane_check` call must not contradict itself" is
  discharged here.** Its own checklist still carries the line; it should be
  ticked against `tests/worker/settlement-one-evaluator.test.ts` rather than
  re-implemented.
- **Ticket 05 inherits a live seam**: `settlementScopeProvenanceFailure` is the
  one predicate and `SETTLEMENT_PROJECTION_FAILURE_NO_PROVENANCE` the one text.
  Both want a type and a worker-log path, and the other three cases have no
  implementation at all yet.
- **Ticket 02's two handoffs are untouched here** (the dirty-writable-turn hole,
  `LaneCoverage` under-reporting truncation). Both are on ticket 04's list.

## UNVERIFIED

- **No production measurement.** Ticket 02 measured its narrowing on a
  read-only snapshot of the live database; I did NOT re-run that harness, so the
  cost effect of removing the second per-call evaluation (roughly: half the
  loader work per `lane_check` and per `commit`) is reasoned from the call
  count, not measured. No production database was opened at all during this
  ticket.
- **The `beyondAuthority` remainder's new arithmetic** is asserted only
  indirectly — existing tests pin its presence and absence, and none of them
  distinguishes the old three-term subtraction from the new two-term one,
  because the deleted term is provably zero.
- **`remember(justify)` still disagrees**, by design (ticket 06). The
  two-halves fixture depends on that disagreement as its control; when ticket 06
  retires the path, that control must be replaced by something else — reading
  `computeLaneFractures` over a `{kind:"lanes"}` projection directly, most
  likely — or the fixture will silently lose its "the lane really is severed"
  proof.
- **The live worker.** Nothing here is live until `/plugin` update + a cold
  restart.
