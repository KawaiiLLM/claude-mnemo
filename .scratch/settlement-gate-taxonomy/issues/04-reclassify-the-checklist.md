# 04 — Reclassify the checklist: what blocks, what informs

**What to build:** the taxonomy itself. Every check carries one class decided by one rule, both surfaces print the same class for the same finding, and a warning stops reading like an obligation.

**Blocked by:** 03 — RESOLVED at `f397da3a`.

**Status:** REPORTED — all boxes done.

Spec: `.scratch/settlement-gate-taxonomy/spec.md` — "The classification rule" governs; the rule and the table are FROZEN from it.

- [x] The rule, in the code, as the single place a class is decided: BLOCKING ERROR = a hard post-state invariant of this stage is violated AND the finding anchors in this run's judgment set AND the run has a bounded, legal, honest repair. Three conditions, one predicate, no per-check special cases.
- [x] E6 and E4 stay blocking errors. **E3 becomes a stage-2 WARNING** — printed as one, gated as one; the commit gate's hand-written "beyond authority" carve-out disappears because the rule now covers it (fixture: the carve-out's removal changes no verdict).
- [x] **Fractures become warnings.** `commit` no longer refuses over a lane disposition; the existing `warnings` channel on the receipt carries them, and a successful commit reports the count and the stitch target. Fixture: a run touching a severed lane commits successfully and the warning rides the receipt.
- [x] The section header that calls warnings "aspirations, never enforced" becomes TRUE — nothing under it blocks anything.
- [x] **A phantom fracture must not be REPORTED either.** Asserted from the reader's side.
- [x] **DONE IN TICKET 03** (`f397da3a`, fixture `tests/worker/settlement-one-evaluator.test.ts`) — not rebuilt. **The `lane_check` call must not contradict itself.**
- [x] Warning wording cuts action-inducement, verbatim from the spec.
- [x] **Rule on the hole ticket 02 opened.**
- [x] **`LaneCoverage` must stop under-reporting truncation.**
- [x] The settlement prompt's own description of the gates is updated to match.
- [x] `npx tsc --noEmit` clean; touched suites green; full `bun test` 4748 pass / 0 fail; bundles rebuilt, stale-bundle guard green; `git diff --check` clean.

---

## What changed

**NEW `src/worker/note-settlement-finding-class.ts`** — THE RULE, and the only
place a class is decided. `SettlementFinding` is a two-arm union
(`grammar-error` | `lane-fracture`); three functions answer one condition each
for BOTH arms; `classifySettlementFinding` is the only place they are ANDed.

**`src/worker/note-settlement-sdk-query.ts`**

- `blocksUnderProvenance` DELETED. `classifyEvaluationErrors` asks the rule once
  per instance and buckets the answer; `laneCheckErrorClassifier` is the same
  call in the render's own shape.
- `evaluateWindowLanes(db, scope, authoredTurnIds?)` — the judgment predicate is
  now `anchorsInJudgment(roles, id) || authoredTurnIds.has(id)`, carried out on
  the evaluation as `judged` so the rule asks the same closure the seam filtered
  with.
- `evaluateLaneDispositionGate(db, evaluation, runTouches, scope)` routes every
  fracture through the rule. The `blocking` bucket and its callers' refusal
  branches are deliberately left reachable — that is what makes the demotion a
  property of the rule rather than of the gate.
- Both tool descriptions rewritten: the "preview lists more than the gate
  refuses over" divergence is gone, and `commit` states the severed-lane
  withdrawal.

**`src/shared/lane-checker-render.ts`**

- `LANE_CHECK_WARNING_NOTICE` (verbatim spec text), `WARNINGS_SECTION_HEADER`
  ("informational; nothing below this line blocks commit"),
  `ERRORS_SECTION_HEADER` ("…that THIS run can repair").
- `LaneCheckerPageOptions.classifyError` — the render ASKS, never decides.
  Demoted findings render under the warnings header, PAGED like everything else.
- The coverage line names the slice with both counts.

**`src/shared/lane-checker.ts`** — `LaneCoverage.status` is one verdict over two
halves (missing endpoints OR truncated membership); `LaneMemberTotal` +
`checkLanes`'s fifth parameter carry the denominator.

**`src/db/lane-checker-load.ts`** — `laneMemberTotals`, captured from the
`segment_members` scan the WIDEN block already performs, before narrowing.

**`src/db/lane-disposition.ts` / `note-settlement-turn-facade.ts` /
`note-settlement-direct-write.ts`** — `RunLaneTouches.turnIds`; an UNPLACED edge
side is recorded under the `''` lane sentinel instead of being skipped (it is
kept out of `turnTagPairs`, so the disposition gate is provably unaffected).

**`note-settlement-prompt.ts` / `note-settlement-unified-prompt.ts`** — the
mandatory-disposition teaching is withdrawn, the two-surface divergence
paragraph is replaced by "THE TWO SURFACES AGREE, by construction", and both
prompts gain "EVERYTHING UNDER `lane_check`'s WARNINGS HEADER BLOCKS NOTHING".

## Decisions the spec left open

1. **The hole: authorship re-admits, authority is NOT intersected with the
   judgment set.** Closure turns are writable precisely because this job's own
   stage-1 projection made their edges stale and the citing turn is the only
   turn that can repair them; narrowing authority reinstates the deadlock the
   closure exists to break, and ticket 02's own comment already records that the
   judgment window "never grants anything". Re-admission by authorship cannot
   deadlock — whatever the run wrote, it can retract, so condition 3 holds by
   construction. **Its limit, stated in the code:** re-admission is by WHERE THE
   RUN WROTE, not by what it caused. A run that empties a tag on an endpoint can
   orphan an E4 anchored at a citing turn it never wrote, and that stays out of
   judgment; answering "did this run cause this finding" is debt-id scoping,
   which this gate has never done.
2. **Authorship is read off the DURABLE touch ledger** (`RunLaneTouches.turnIds`),
   so attempt A dirtying a closure turn and dying still binds attempt B.
3. **The unplaced edge side is recorded with `''`** rather than adding a
   `touch_kind`, which would need a CHECK-constraint migration. `''` is this
   project's own UNSETTLED-lane sentinel and no lane lookup can ever match it.
4. **The fracture warning still consults `checkLaneDispositionJustification`:** a
   FRESH justify silences the warning. Kept because ticket 06 owns justify's
   retirement, not this ticket. The STALE branch's "MOVED since" prose is gone
   from the settlement surface with the refusal it existed to explain — a
   warning telling the run to re-justify is an obligation wearing a warning's
   label.
5. **The demoted findings are PAGED, not appended as a tail block.** A real
   window has carried 435 E3s; an unpaged tail is the "output that cannot be
   expressed inside the protocol" failure the spec's third channel is about.
   That is why the render takes a `classifyError` callback rather than the
   evaluator appending a pre-rendered block.
6. **Both renders share the two headers and the notice**, so the paged
   settlement render and the plain CLI render stay byte-identical on a result
   with nothing demoted (the pre-existing invariant, still tested). The CLI
   never supplies a classifier, so everything is `blocking` there — the honest
   reading for a surface with no run and no gate behind it.
7. **The notice appears twice on a `lane_check` page 1** that carries a fracture
   warning — once under the WARNINGS header, once inside the disposition block.
   Deliberate: the block-level copy is what rides the COMMIT receipt, where the
   header is not present, and a notice that can be separated from its findings
   by a consumer's own `join` is a notice that will be.
8. **`laneMemberTotals` is consumed only at the settlement seam.** The CLI, the
   console, `mcp/note.ts` and stage 1 declare no judgment window, so their
   projections cannot truncate a lane's membership and the denominator would
   only ever print `N of N`.
9. **`evaluateLaneDispositionGate` keeps its `blocking` bucket** even though the
   rule empties it. Deleting it would move the demotion from the rule into the
   gate's shape, and the fixtures would then pin a missing code path instead of
   a verdict.

## Fixtures, and the mutation each one catches

New: `tests/worker/settlement-finding-class.test.ts` (2 tests) — one turn
carrying BOTH an E3 and an E6, so every input the rule reads except the class is
held constant; plus the coverage denominator.
New arm: `tests/worker/settlement-evidence-closure.test.ts` (+1 test) — the hole,
with a pre-existing defect on prompt 900 as the control and the run's own defect
on prompt 899 as the subject.
Inverted: 8 fracture-refusal tests across `note-settlement-sdk-query.test.ts` and
`lane-fracture-agreement.test.ts`; 2 prompt tests; 1 tool-description test.

Five mutations were applied to the source and the FULL suite run against each:

| mutation | result |
|---|---|
| drop `\|\| authoredTurnIds?.has(turnId)` from the judgment predicate | RED, exactly 1 test — the hole test |
| skip the unplaced edge side again (turn facade) | RED, exactly the same 1 test |
| `violatesStagePostStateInvariant`'s `lane-fracture` arm → `true` | **GREEN — no test moved** |
| …AND `hasBoundedLegalHonestRepair`'s `lane-fracture` arm → `true` | RED, 8 tests, all of them fracture fixtures |
| remove the `E3 → false` arm of condition 3 | RED, 11 tests |
| drop `projection.laneMemberTotals` from the `checkLanes` call | RED, exactly 1 test — the coverage test |

The third row is a real finding and is recorded in the source and in the fixture:
the spec disqualifies a fracture TWICE, on two independent grounds ("Connectivity
is a quality goal, not a legal post-state; a writable pair does not imply a
truthful relation"), so neither arm is individually load-bearing. What the
fixtures pin is the fracture's CLASS. Condition 1's fracture arm is defence in
depth — it holds the line if a later reader decides a writable pair does after
all constitute a repair — and is honestly labelled as such rather than presented
as tested.

The E3 mutation's 11 reds are the point of the criterion "the carve-out's
removal changes no verdict": every one of them is a test that already asserted
"E3 does not block", written long before this ticket, and they keep passing
because the rule reaches the same answer the carve-out asserted. The carve-out
itself is gone from the gate.

## Gates

| gate | command | result |
|---|---|---|
| typecheck | `npx tsc --noEmit` | exit 0, no output |
| full suite | `bun test` | 4748 pass / 0 fail |
| bundles | `npm run build` | ok |
| stale-bundle guard | inside `bun test` (`release artifacts`) | green |
| whitespace | `git diff --check` | exit 0 |

## UNVERIFIED

- **No production measurement.** No production database was opened during this
  ticket. The cost claim behind the batch (17% of runs / 48% of cache-read
  spend) is the spec's, not re-derived here, and the effect of the demotion on
  real refusal counts is reasoned, not measured.
- **The `blocking` bucket of the disposition gate is unexercised.** Under the
  frozen rule nothing can put a line in it, so its refusal prose (including the
  "MOVED since" stale-justify branch) has no test that renders it. That is the
  deliberate consequence of decision 9.
- **`laneKeyTouches` (the removed-tag half of the touch ledger) is still
  untested**, unchanged from ticket 04 of phase-connectivity's own note: stage 2
  refuses the write that produces it.
- **The CLI/console coverage line.** Those callers pass no `laneMemberTotals`, so
  their `coverage:` output is byte-unchanged; I reasoned that their projections
  cannot truncate a lane's membership (no judgment window) rather than measuring
  it on a real corpus.
- **The live worker.** Nothing here is live until `/plugin` update + a cold
  restart.
- **`plugin/scripts/worker.cjs` still contains `@anthropic-ai/claude-agent-sdk`
  bytes.** Verified byte-for-byte present at HEAD before this ticket's rebuild —
  pre-existing, not introduced here, and the repo's own release-artifacts guard
  is green either way.
