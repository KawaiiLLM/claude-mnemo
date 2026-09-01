# 05 — The third channel: system / projection failure fails closed

**What to build:** the outcomes that are neither "you have work to do" nor "here is something to know" get their own channel, visible to the operator and never dressed up as a repairable finding.

**Blocked by:** 03 — RESOLVED at `f397da3a`.

**Status:** REPORTED — all boxes done.

Spec: `.scratch/settlement-gate-taxonomy/spec.md` — "The third channel" governs.

- [x] A typed SYSTEM / PROJECTION FAILURE result, distinct from both errors and warnings, on both surfaces. It FAILS CLOSED: the run is told it cannot proceed on this check, and is NOT handed a list that pretends to be repairable.
- [x] Its cases: missing production provenance; an unconstructible projection; a self-contradicting shared evaluator; and a result that cannot be expressed inside the protocol.
- [x] Operator-visible: it reaches the worker log, not only the agent's transcript.
- [x] Fixture per case, each red-capable on its own condition. In particular: an over-protocol render is a system failure, never a truncated report and never a warning.
- [x] `npx tsc --noEmit` clean; touched suites green; full `bun test` 4732 pass / 0 fail; bundles rebuilt, stale-bundle guard green.

---

## What changed

**NEW `src/worker/note-settlement-system-failure.ts`** (+~330) — the channel, whole,
and free of both the SDK and the database.

- `SettlementSystemFailure` — `{ channel: "system-failure"; case; operatorDetail }`.
  `channel` is the discriminant a caller tests instead of matching prose;
  `isSettlementSystemFailure` is the guard.
- FOUR PREDICATES, one question each:
  `missingProductionProvenanceFailure` (ticket 03's, typed),
  `unconstructibleProjectionFailure`,
  `selfContradictingEvaluatorFailure`,
  `overProtocolResultFailure`.
- `renderSettlementSystemFailure` — the agent-facing paragraph. No findings, no
  counts of findings, no verb, no retry sentence, and it never carries
  `operatorDetail`.
- `logSettlementSystemFailure` — the operator path, `createLogger("MNEMOSYNE")`
  at `error` level, context `{case, surface, jobId, claimGeneration, detail}`.
- `SETTLEMENT_RESULT_TOKEN_CEILING = 25_000`, `SettlementSystemFailureOptions`
  (the two test seams).

**`src/worker/note-settlement-sdk-query.ts`**

- `SETTLEMENT_PROJECTION_FAILURE_NO_PROVENANCE` and
  `settlementScopeProvenanceFailure` DELETED, replaced by
  `judgeSettlementWindow(db, scope, scopeProvenance, authoredTurnIds)` — the ONE
  place cases 1-3 are asked, returning either an evaluation to render from or a
  failure to render instead. Its three questions are ordered because they must
  be: no descriptor, then an incoherent descriptor, then an evaluation that
  contradicts the descriptor it was built from.
- Per request, two closures: `raiseSystemFailure` (sink first, then render —
  one call, so a surface cannot render a failure it forgot to report) and
  `protocolBoundedResult` (case 4, on the bytes the protocol is about to carry).
- All FOUR handler sites rewired: `lane_check` and the terminal gate, in both
  the legacy single-stage builder and the unified one.

**`src/worker/note-settlement-direct-write.ts`** — `SettlementTerminalGateVerdict`
gains a THIRD arm, `{ ok: false; systemFailure }`, and a `SettlementSystemFailureRaised`
sentinel beside `TerminalGateRefused`. Same rollback, opposite meaning: a refusal
costs no attempt because the run may repair and retry, a system failure costs no
attempt because there is nothing to retry.

**`src/shared/lane-checker-render.ts`** — one doc pointer, now naming the module.

## The four cases, and what is actually known about each

Only ONE of them has a measured production frequency. That is stated in the
source too, so a later reader does not mistake the other three for observed
hazards.

| case | reachable from a database state? | evidence |
|---|---|---|
| `missing-production-provenance` | yes | ticket 03's own finding |
| `unconstructible-projection` | yes (from the dispatch's descriptor) | none observed |
| `self-contradicting-evaluator` | **NO — see "Coverage genuinely limited"** | none observed |
| `over-protocol-result` | yes, **55 times in 7 days** | re-measured, below |

### The over-protocol case, re-measured

Not taken from the spec. Read off the settlement worker's own transcripts
(`~/.claude/projects/-Users-zhaoqixuan--claude-mnemo/*.jsonl`, deduped by record
uuid, tool resolved through each `tool_use_id`). No production database was
opened.

```
$ (python3, over "exceeds maximum allowed tokens", deduped by uuid)
records: 64        # whole retained history
2026-08-24  5   2026-08-27  6   2026-08-30 39
2026-08-25  2   2026-08-29  2   2026-08-31  3
2026-08-26  3
by tool:  lane_check 29 | commit 18 | recall 10 | diary read_turn_detail 2 | diary list_rule_hits 2
seven days to 08-31: 55  (lane_check 24, commit 18, recall 10)
sizes:    lane_check 59,077-138,759 chars | commit 90,287-99,571 | recall 70,873-100,000
```

The spec's "35 in 7 days" is a lower figure measured earlier; the shape agrees.
The harness text is `result (N characters across M lines) exceeds maximum allowed
tokens. Output has been saved to …`, from
`~/Projects/claude-code-main/src/utils/mcpOutputStorage.ts:46`, reached from
`src/services/mcp/client.ts` once `mcpValidation.ts`'s cap is exceeded.

**`recall` spills 10 times and is NOT fixed here** — it is neither of this
ticket's two judgment surfaces. Handed on.

## Decisions the spec left open

1. **The ceiling is 25,000 REAL tokens, and it is a constant, provably.**
   Claude Code's cap is `DEFAULT_MAX_MCP_OUTPUT_TOKENS = 25000`
   (`src/utils/mcpValidation.ts`), overridable by `MAX_MCP_OUTPUT_TOKENS`. That
   key is NOT in `buildIsolatedEnv`'s allowlist (`src/mnemosyne/env.ts`), so the
   CLI this worker spawns always runs on the default. Reading `process.env` here
   would let the guard drift from the cap the child actually enforces.
2. **Priced with `countTokens` (o200k_base), not `estimateTokens`.** This is the
   predicate, not a preference. Settlement results are address lists at ~2.2
   chars/token; the 4-chars-per-token estimator every other settlement budget
   uses reads a genuinely over-protocol result as comfortably inside the cap.
   Measured on text shaped like the smallest real spill (59,077 chars / 851
   lines, a `lane_check` the harness itself refused): `estimateTokens` 15,176,
   `countTokens` 26,557. The estimator would have passed it by 40%. Pinned as a
   test.
   - Cost: 11 ms warm for 140,014 characters — the largest size ever observed.
   - The length pre-gate (`text.length <= ceiling`) is exact, not heuristic:
     o200k emits at most one token per character.
3. **Case 4 is asked at the END of each handler, on the composed result.**
   `lane_check` page 1 joins the phase-connectivity block and the lane-disposition
   warnings onto `paged.text` AFTER the pager has spent its budget; a guard on
   `paged.text` would pass a result that then left over the ceiling. Pinned by a
   self-calibrating fixture (mutation M7).
4. **`commit`: on the REFUSAL, never on a landed receipt.** The refusal branch is
   post-rollback, so a fail-closed answer there states a true fact. Replacing a
   receipt — which describes a durable write — with "the run cannot proceed"
   would be the channel telling a lie. **This is a real limit and it may bite:**
   since ticket 04 demoted fractures and E3 to warnings, a big commit output can
   now ride a SUCCESSFUL receipt's warning tail rather than a refusal, and that
   path is unguarded. Handed on.
5. **The typed failure rides its own verdict ARM, not a flag on the refusal.**
   A reader of `SettlementTerminalGateVerdict` cannot demote one to the other by
   forgetting to test a boolean. It buys no observable behaviour — see the
   honesty note below.
6. **Case 2 is the scope descriptor's own stated postcondition, asked back.**
   `resolveSettlementScopeProvenance`'s doc comment already declares it ("every
   id in `writableTurnIds` lands in EXACTLY one of the three sets"). It is worth
   its bytes because `installSettlementEdgesScope` picks `writableTurnIds` and
   `scopeProvenance` through two INDEPENDENT `??` fallbacks; they agree only
   because `readSettlementFrozenScope` happens to return both halves or neither.
   That is a property of one function, not of the type.
7. **Case 3 is the evaluator's advertised postcondition, asked back** — every
   error it hands both surfaces must anchor inside the writable set AND pass
   `judged`. The two counts are reported separately in the operator line because
   the two filters are repaired in different places.
8. **`operatorDetail` never reaches the agent.** It names sizes and set
   arithmetic, which is exactly what a run would try to act on. Asserted.
9. **Sink and render are ONE call.** `raiseSystemFailure` reports before it
   renders, so a later surface cannot add a fail-closed path that forgets the
   operator — which is the failure mode this criterion exists against.
10. **`evaluateSettlementCommitGate` (the exported direct-call seam) is NOT
    guarded**, unchanged from ticket 03 decision 1: the fallback must not reach
    the production tool path, and this is not the production tool path.

## Fixtures, and the mutation each one catches

`tests/worker/settlement-system-failure.test.ts` (new, 13 tests). One fixture, a
deliberately DIRTY two-turn window (a DRAFT edge = E6 inside the writable set),
so every "no report / no verdict" assertion has something real to suppress.
`expectFailClosed` is one helper asserting the same eleven absences everywhere:
not an error list (`## ERRORS`, `[E6]`, `Commit refused`, `error(s)`), not a
warning (`WARNINGS`, `does not block commit`), not a repairable list
(`` call `commit` again ``), and not a truncated report (`truncat`,
`showing first`, `saved to`).

Every mutation below was applied to the source and run.

| # | mutation | result |
|---|---|---|
| M1 | case 1's predicate → `null` | RED, exactly 3 — both of this file's case-1 tests **and ticket 03's own** fail-closed test |
| M2 | case 2's predicate → `null` | RED, exactly 2 (case 2 only). The e2e arm's red is `lane_check` returning the full `## ERRORS … [E6] …` report over the incoherent descriptor |
| M3 | case 3's predicate → `null` | RED, exactly 1 (case 3's predicate test) |
| M4 | case 4's predicate → `null` | RED, exactly 3 — the calibration test, the `lane_check` arm, and the `commit` arm. The commit arm's red is `Commit refused — 1 error(s) … [E6] …`, i.e. a repairable list where the failure belongs |
| M5 | `logSettlementSystemFailure` body removed | RED, exactly 1 — the worker-log test |
| M6 | the commit refusal branch returns `appendReports(...)` unguarded | RED, exactly 1 — the commit case-4 arm |
| M7 | case 4 measured on `paged.text` instead of the composed result | RED, exactly 1 — the tail-placement test |
| M9 | the UNIFIED `lane_check` returns `textResult(text)` | RED, exactly 1 — the both-sites test |
| M8 | the typed verdict arm collapsed into `{ok:false, refusal: render(...)}` | **GREEN — no test moved.** See below |

Two CONTROL tests carry their own weight: the same fixture with a coherent
descriptor still prints `## ERRORS`/`[E6]` and still refuses at `commit` with no
sink call at all, so "no report" is never satisfied by a fixture that had nothing
to say.

### The operator path is tested on the real file, not on the seam

The worker-log test injects NO sink, so `logSettlementSystemFailure` runs and the
test reads `$HOME/.claude-mnemo/claude-mnemo.log` (the bunfig preload's sandbox
home). It asserts one line per surface, `level: "error"`, `component:
"MNEMOSYNE"`, and the typed case, jobId and claimGeneration in the context — an
operator can find the job without the transcript. M5 is its red.

### Both registration sites

`lane_check` and `commit` are registered TWICE in this file (the legacy builder
every other test drives, and the unified builder the scheduler dispatches). A
channel wired into one and missed in the other would be invisible. The last test
drives the UNIFIED site's own registered handler, through a real assistant
message so `resolveResponseOrigin` resolves as the host loop makes it, and M9 is
its red.

## Coverage genuinely limited, stated rather than claimed elsewhere

- **CASE 3 IS UNREACHABLE FROM ANY DATABASE STATE, and its e2e arm does not
  exist.** `evaluateWindowLanes` filters errors by `judged` and then projects
  them against `scope.writableTurnIds`, so the value it hands both surfaces
  satisfies case 3's postcondition BY CONSTRUCTION. No fixture can drive a tool
  call into it. Its fixture is on the predicate, with the four shapes a broken
  evaluator would produce; the render arm is asserted from there. Writing an
  end-to-end arm would have required an injected fake evaluator, which would
  test the fake.
- **THE TYPED VERDICT ARM ON `commit` IS NOT FALSIFIABLE (M8, GREEN).** Both
  `{ok:false, refusal}` and `{ok:false, systemFailure}` render the same bytes at
  the tool seam, so no behavioural fixture can tell them apart. The arm buys
  compile-time and reader safety — a reader of the type cannot silently treat a
  system failure as a repairable refusal — and nothing else. Recorded rather than
  presented as tested, the same way ticket 04 recorded its fracture-demotion
  over-determination and ticket 06 its ghost-lane one.
- **CASE 2's e2e arm exercises ONE of the predicate's three clauses.** The
  descriptor it supplies (`window = {w1, w2, 9999}` against a writable set of
  `{w1, w2}`) violates `outsideAuthority` only; `duplicated` and `unclaimed` are
  covered by the predicate test alone and have no end-to-end arm.
- **A SUCCESSFUL `commit` receipt is unguarded** (decision 4), and post-ticket-04
  it is the likelier place for a large settlement output to appear.
- **`recall`'s 10 spills are untouched.**
- **`finalize`'s data result is untouched** and enumerates the whole frozen
  writable set plus every worklist lane's members. It has never been observed
  over the protocol; it is not one of the two judgment surfaces, so it is out of
  scope rather than proven safe.

## UNVERIFIED

- **THE PAGE BUDGET IS MIS-SIZED AGAINST THE PROTOCOL, and this ticket does not
  fix it.** `LANE_CHECK_DEFAULT_PAGE_BUDGET = 20_000` is priced in
  `estimateTokens`, i.e. ~80,000 characters of settlement-shaped output, which is
  ~36,000 REAL tokens — well over the 25,000 the protocol carries. A full-budget
  page 1 therefore fails closed BY CONSTRUCTION, which is exactly what the 24
  observed `lane_check` spills are. This ticket converts that outcome from a
  silent file spill into an operator-visible fail-closed result, as the spec
  rules; it does not resize the page. **The follow-up is one decision** (price
  `packLaneCheckerBlocks` through `countTokens` and set the default below the
  ceiling, leaving room for the unpaged tail) and it belongs to whoever owns the
  paging contract, because it changes what every run sees. Not measured on a real
  window — the arithmetic is from the constants and the measured chars/token.
- **`countTokens` is o200k_base, not the model provider's tokenizer.** It is the
  closest counter this repo ships; the harness's own decision is a real token
  count from the provider. On the smallest observed spill the two agree to within
  ~6% (26,557 vs "over 25,000"), but a result near the line may fall either side.
  The guard is therefore calibrated, not exact.
- **js-tiktoken is quadratic on long runs of one repeated character**: measured
  29.3 s for `"x".repeat(25000)`, against 11 ms for 140,014 characters of real
  settlement shape. Settlement results are line-structured address lists and
  cannot produce that shape, but a future surface that embedded a long fill run
  would stall a tool call. Not guarded.
- **No production database was opened.** The measurement above is from
  transcripts only. `~/.claude-mnemo/claude-mnemo.db` was never read.
- **The spilled result FILES are gone** (`tool-results/` is pruned), so what a
  `commit` spill actually contained — a refusal list or a receipt's warning tail
  — could not be read back. Decision 4's limit is reasoned from the code, not
  from a recovered artefact.
- **`tsc` does not typecheck `tests/`** (`tsconfig.json` excludes it), unchanged.
- **The live worker.** Nothing here is live until `/plugin` update + a cold
  restart.

## Gates

| gate | command | result |
|---|---|---|
| typecheck | `npx tsc --noEmit` | exit 0, no output |
| touched suites | `bun test tests/worker/settlement-system-failure.test.ts` | 13 pass / 0 fail |
| | `bun test tests/worker/note-settlement-sdk-query.test.ts tests/worker/settlement-one-evaluator.test.ts tests/worker/lane-fracture-agreement.test.ts tests/worker/settlement-finding-class.test.ts tests/worker/settlement-evidence-closure.test.ts tests/shared/lane-checker-render.test.ts tests/worker/staged-settlement-unified-run.test.ts` | 156 pass / 0 fail (with the new file) |
| full suite | `bun test` | **4732 pass / 0 fail**, 262 files |
| bundles | `npm run build` | ok |
| stale-bundle guard | `bun test tests/shared/release-artifacts.test.ts` | 10 pass / 0 fail |
| no-model guard | `grep -c 'anthropic-ai/claude-agent-sdk' plugin/scripts/*.cjs` | worker 1, settlement-child 1, mcp-server 0, hook-command 0 — identical to HEAD |
| channel reaches only the child | `grep -c 'SYSTEM / PROJECTION FAILURE' plugin/scripts/*.cjs` | settlement-child 1, worker 0, mcp-server 0, hook-command 0 |
| whitespace | `git diff --check` | exit 0 |
| control bytes | `grep -nP '[\x00-\x08\x0b\x0c\x0e-\x1f]' <new files>` | no match |
