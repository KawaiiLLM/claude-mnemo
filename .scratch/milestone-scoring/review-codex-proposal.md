Verdict: do not implement as written -- the evidence is exploratory, the proposed score is not defined on the data domain, and the anchor/order changes leave current selection, pagination, and settlement invariants unresolved.

# Proposal review

This is a review of the proposal, not an implementation review. I read the proposal and governing arc-spine spec, inspected the relevant source, and queried the production database read-only with SQLite. The current database snapshot is not the exact study snapshot: it has 9,762 turns / 139 sessions / 9,443 turns with `transcript_line_start` / 319 without, versus the proposal's 9,760 / 166 / 9,440 / 320. The study aggregates therefore cannot be independently reproduced from the current DB, though the path and ordering defects can.

## Findings

### BLOCKER-1 — The proposed feature transform is not total or bounded on real inputs

Evidence: `.scratch/milestone-scoring/proposal.md:39-50`; `src/mcp/timeline.ts:843-854,1361-1377,1489-1518`.

For positive `s` and `k > 1`,

```text
f(x) = min(1, ln(1 + x/s) / ln(k))
```

is in `[0,1]` only for finite `x >= 0`. It is negative for `-s < x < 0`, `-Infinity` at `x = -s`, and `NaN` for `x < -s`, `NaN`, or an unhandled missing value. A direct local evaluation of the proposed expression for `s=60,k=31` produced:

```text
x=0       0
x=-1     -0.0048943450617490464
x=-60    -Infinity
x=-61     NaN
x=NaN     NaN
x=Infinity 1
```

That matters here. The proposal leaves the final `gapAfterSec` undefined, and the current data has out-of-order timestamps: a read-only scan found 828 negative adjacent `createdAtEpoch` gaps when turns are put in transcript order, plus 15 tied timestamp groups covering 34 turns. Missing response fields are also present (101 null responses in the current DB). If any of those values reaches the formula, `score` can be `NaN`; `compareMilestoneRank` then subtracts scores and can receive `NaN`, which is not a total comparator. Negative values also violate the claimed lower bound and can move a higher-grade row below a lower-grade row.

The `0.9` upper bound does hold structurally only after this precondition is enforced: every feature must be mapped to a finite value in `[0,1]`, the four nonnegative weights must sum to `1.0`, and the final result must be clamped to `[0,0.9]`. The proposal does not specify that sanitization. The implementation needs a named helper with explicit behavior for missing, non-finite, negative, and terminal values, followed by tests for the full input domain and comparator transitivity. `Math.log1p` plus a lower clamp is preferable to relying on the displayed expression, but the semantic policy is the important part.

### BLOCKER-2 — The primary signal is contaminated, and the proposed control does not justify the largest retained weight

Evidence: `.scratch/milestone-scoring/proposal.md:13,27-37,42-50`; `src/mcp/timeline.ts:1361-1377`; `src/worker/query-session.ts:375-398`.

The blind judge saw `filesModified` and `toolCallCount`. Removing those columns changed the reported within-band AUC from 0.63 to 0.53 for tool calls and from 0.62 to 0.58 for files. That is direct evidence that the gold labels are partly determined by the same observable signals being evaluated. Keeping `files` at weight `0.40`, the largest weight, is not defensible from this experiment. The result may reflect a legitimate correlation with useful work, but it may equally be a label leakage loop; the proposal has not separated those explanations.

The control is also incomplete. `toolCallCount` is not in the proposed weighted formula, but it remains the production secondary rank key at `src/mcp/timeline.ts:1368-1376` for equal scores. Thus tool count still affects which row wins ties. No tie frequency or clean-label result is reported, so it cannot be dismissed as negligible. Either remove that key and replace it with a deterministic non-semantic key, or independently justify it under the same blinded evaluation. The governing spec currently says “score → tool count → earlier prompt” at `.scratch/arc-spine-redesign/spec.md:88`; either choice needs a spec amendment.

To settle this, regenerate an independent gold set with the judge explicitly unable to see file/tool metadata (and preferably with human adjudication or an independently defined rubric), freeze the feature/weight choice before evaluation, and validate on new sessions. Report ablations and permutation controls for each feature, with session-level confidence intervals, actual budget-boundary retention, and agreement between judges. A feature may be retained only if it improves clean, independently judged selection rather than labels that it helped generate.

### MAJOR-1 — Six sessions and the reported LOOCV do not support a production formula replacement

Evidence: `.scratch/milestone-scoring/proposal.md:13-37`.

Within-band AUC is a sensible diagnostic for the locked invariant that the tie-break must rank only within an `effGrade` tier. It is not sufficient as the primary decision metric for “which anchors survive budget degradation”: pairwise AUC weights all same-band pairs equally, while production behavior is determined by the top boundary after structural-anchor filtering, pull-through, page size, body fitting, and a 2,500-token budget. It does not measure anchor survival, top-`K` precision/recall, NDCG/regret at the actual cutoff, or the rate and quality of over-budget output.

The six-session, single-user sample is exploratory. A mean change from 0.567 to 0.684, even with all six sessions winning, has no reported session-level interval, paired test, or effective pair count. The per-session spread could make the mean unstable, and turns within one session are not six independent observations. The held-out leave-one-session-out mean of 0.685 is not an adequate anti-overfitting control if V7, its features, caps, and weights were selected after looking at the same six sessions; that requires nested selection inside each training fold. Even a correctly nested LOOCV has only six held-out units and no independent user/session validation.

The evidence supports “V7 is a promising candidate in this small experiment,” not “replace the production formula.” A defensible gate would pre-register the candidate family and decision metric, use a clean gold set, use nested or strictly holdout selection, report session-level bootstrap/permutation intervals, and evaluate the actual retained set under representative budget pressure. Include anchor/non-anchor and grade-band slices; otherwise a good aggregate AUC can hide failure at the exact degradation boundary.

### MAJOR-2 — `respLen` is an unjustified and gameable 20 percent of the score

Evidence: `.scratch/milestone-scoring/proposal.md:42-50`; `src/db/turns.ts:16-56`; current read-only DB statistics.

The proposal itself calls response length a verbosity proxy, but still assigns it `0.20`. Raw `assistantResponse.length` is not a measure of decision value, and it is not even the same unit as the 2,500-token injection budget. It rewards padded output and may reward extraction/prompt-format changes rather than better milestones. In the current DB, response lengths range from 0 to 18,040 characters, average 924.45; 343 are empty and 101 are null. The proposed formula gives these cases materially different treatment without stating how nulls are handled.

The default should be to remove this feature. If it is retained, define a canonical response field, normalize units, cap or robustly transform it, explicitly handle null/empty output, and show an improvement against clean labels and the real budget-cutoff metrics. “It is an existing field” is not evidence that it is a valid ranking signal.

### MAJOR-3 — `gapAfterSec` has no specified terminal value and is unstable under late/out-of-order turns

Evidence: `.scratch/milestone-scoring/proposal.md:47-50,87-93`; `src/db/turns.ts:16-56`; `.scratch/arc-spine-redesign/spec.md:55-64`.

For a turn that is last in the scoring window, the feature is right-censored, not zero-length. The proposal must define it. The conservative production policy should be `0` (or an explicit missing value mapped to `0`) because no observed successor is evidence for no gap; do not substitute “now,” session end, or an arbitrary window boundary. If a terminal pause is intended as a signal, it needs a separately defined end-of-session observation and a separate validation claim.

The successor relation must also use one declared canonical ordering with a deterministic final key. If `createdAtEpoch` is used, tied epochs need `transcript_line_start`, then `prompt_number`, then `id`; if transcript order is used, turns with missing lines need an explicit unknown policy. Late-arriving turns can insert a successor and change both neighboring gaps. That makes scores mutable after a settlement cohort is frozen, unless the feature is recomputed at a defined boundary and the resulting ordering/version is persisted. The current data demonstrates both timestamp ties and negative gaps; the proposal's undefined terminal/missing policy is therefore a correctness issue, not an edge case.

### MAJOR-4 — Endpoint exemption does not protect the other structural anchors

Evidence: `.scratch/milestone-scoring/proposal.md:52-62,87-93`; `src/mcp/timeline.ts:1452-1518,1520-1570,3003-3067`; `.scratch/arc-spine-redesign/spec.md:80-104`.

The current `alwaysKeep` set is broader than endpoints: it includes non-victim correctors, reversed turns without a corrector, and task-era `effGrade=4` turns (`timeline.ts:1452-1482`). The proposal's endpoint ranking counts only show that endpoints are low-ranked in three samples. They do not establish that the other structural classes are safe to delete.

Removing a corrector can remove the only visible explanation for a demoted victim. Removing a reversed-without-corrector row removes the explicit unresolved/reversal signal. Removing a task-era G4 row removes an origin of the decision arc. The existing pull-through rule can mechanically re-home a shared antecedent to the earliest retained citer (`timeline.ts:2579-2582,2868-2895`), but if all relevant citers are removed it hides the antecedent and increments hidden state; that does not preserve the correction or origin invariant. The current fitter intentionally never removes `alwaysKeep` rows (`timeline.ts:3015-3067`), so a third pass changes an explicit assumption rather than extending an untested path.

The endpoint exemption is therefore insufficient. The protected set must be defined by semantic class, not just position, and the proposal must specify the terminal case when even the protected set cannot fit. The current contract is to render all anchors and an over-budget note (`timeline.ts:144-148`; `.scratch/arc-spine-redesign/spec.md:90-104`); if the new pass changes that contract, it must say what is sacrificed and how the 2,500-token invariant is prioritized. If endpoints themselves exceed the budget, an endpoint exemption alone does not solve the problem.

`removeUnit` already updates hidden counts, day frames, and re-homing for removable units, but the 0.8.4 day-frame collapse means every third-pass removal must be tested after collapse and before re-homing. Removing the last row in a day can change headers and page accounting; it must not leave an orphan date frame or make the visible `+N more` count wrong. The required tests include each structural anchor class, shared antecedents whose only citer is removed, empty-day collapse, and the protected-set-over-budget terminal behavior.

### MAJOR-5 — Deleting `MILESTONE_PURE_SPEC_RE` is not justified by a zero-fire measurement

Evidence: `.scratch/milestone-scoring/proposal.md:64-68`; `src/mcp/timeline.ts:778-786,836-840`; `tests/mcp/timeline.test.ts:1182-1205`; current read-only DB.

The current production data supports the narrow claim that the predicate is dead for the current stored representation: all 5,408 distinct `files_modified` path values in the current DB are absolute, and a DB-wide query found zero matches for the relative `^docs/(plans|specs|superpowers)/.*\.md$` pattern. The path is stored raw by the worker (`src/worker/processors.ts:462-509`), so this is a real representation mismatch.

It does not support the stronger conclusion that a working pure-spec feature would be useless. The proposal correctly notes that its 0.500 score means “never fired,” not “no value”; the subsequent deletion decision nevertheless treats the current dead implementation as evidence against the semantic feature. The existing unit test deliberately supplies a relative `docs/plans/a.md` and expects the pure-spec contribution (`tests/mcp/timeline.test.ts:1182-1205`), so deletion is also a behavior/test decision, not merely dead-code cleanup. Raw path inputs may be mixed across tools or fixtures.

I would first choose one path contract: normalize to repo-relative paths at ingestion/read time with an explicit outside-repo policy, or deliberately remove the concept and amend the spec/tests. Then remeasure the feature with clean labels and an ablation. A deletion can be landed only after that product decision; it should not be inferred from zero production firings.

The requested sweep found no second direct runtime predicate that applies a repo-relative regex to `filesModified`/`filesRead`. The version-bump check uses a suffix and handles absolute/relative paths (`src/mcp/timeline.ts:168-193`); pre-tool path matching resolves paths against `cwd` (`src/rules/pretooluse-dispatcher.ts:244-253`); and the search filters use substring `LIKE` (`src/db/search.ts:594-603,660-669,717`), which is a different class of behavior. `processors.ts:462-509` still preserves raw path inputs, so future predicates need the same contract review. This sweep does not make the pure-spec deletion decision sound.

### BLOCKER-3 — The eight-site ordering change is not a coherent chronological-order migration

Evidence: `.scratch/milestone-scoring/proposal.md:70-85`; `.scratch/arc-spine-redesign/spec.md:55-64,80-104,118-135`; source sites below; current read-only DB.

The motivation is valid: prompt numbers are insertion identity, and retroactively claimed compact markers are assigned `maxPromptNumber + 1` (`src/hooks/capture-repair.ts:247-350`), so prompt order can put an earlier transcript marker at the tail. The current DB has 720 adjacent prompt-order inversions where both transcript lines are present. But replacing eight `ORDER BY prompt_number` clauses with a “transcript line, NULL fallback prompt” comparator is not enough:

1. A pairwise fallback over two key spaces is not a total order. Let `A=(line=300,prompt=10)`, `B=(line=NULL,prompt=20)`, and `C=(line=100,prompt=30)`. If two known lines use line order and any pair containing NULL falls back to prompt order, then `A < B`, `B < C`, but `C < A`: an intransitive cycle. SQL `COALESCE(transcript_line_start,prompt_number)` is total but is not the stated fallback semantics; `NULLS LAST, transcript_line_start, prompt_number, id` is total but treats all unknown-line rows as a separate tail. The proposal must select one global lexicographic key and test comparator transitivity, duplicate lines, negative/zero lines, and `id` ties.

2. The change is incomplete. Timeline internals still sort/filter by prompt (`src/mcp/timeline.ts:1645-1657,1743-1752,1871-1890,1932-1935`), and correction/antecedent guards use prompt chronology (`timeline.ts:1050-1055,1549-1551`). Changing only the eight DB sites creates different orders at different layers; changing all layers would alter selector ranges, predecessor semantics, day-group preconditions, and re-homing. `[S12/T3]` identity lookup itself remains intact because prompt numbers are not renumbered and `getTurn` is an exact `(session,prompt)` lookup (`src/db/turns.ts:170-190`), but page and settlement semantics do not remain intact automatically.

3. Settlement cohorts are a durable boundary contract. `listSettlementCohortIds` takes K=50 members in prompt order (`src/db/settlement.ts:129-174`), and already-enqueued jobs freeze member IDs (`src/db/settlement.ts:235-295`; `settlement_jobs.frozen_member_ids`). Reordering changes which turns belong to each cohort, including compact markers. Existing jobs would retain old cohorts while new jobs use new cohorts, with no order version, drain rule, or migration. The current DB happens to have no rows in `settlement_jobs`, but that is not a safe product assumption. In addition, settlement rendering receives the cohort in cohort order while the timeline renderer re-sorts preloaded turns by prompt (`src/worker/settlement.ts:175-232`; `src/mcp/timeline.ts:1743-1752`), so a partial change can make the roster and arc disagree.

4. Pagination is not just a SQL presentation detail. Page ranges and day groups assume prompt-sorted, contiguous milestones (`src/mcp/timeline.ts:1791-1804,1932-1935`), while prompt numbers are also used for “earlier” causal guards and capture-repair monotonicity. A chronology migration needs explicit order semantics at each consumer, not a global substitution.

#### Per-site assessment

| Site | Assessment | Reason |
|---|---|---|
| `src/db/turns.ts:498` (`getTurnsForSession`) | Needs care | This is a generic accessor. Existing callers/tests may rely on identity order, and the timeline explicitly re-sorts anyway. Add an explicit chronological accessor or make the order part of the caller contract; do not silently change the default. |
| `src/db/turns.ts:516` (`getStrandedTurns`) | Wrong as a blanket switch | Recovery currently queues stranded turns in prompt order and tests assert that behavior (`tests/db/turns.test.ts:463-492`, `tests/db/recover-stranded.test.ts:42-76`). A different recovery policy needs its own contract and tests. |
| `src/db/turns.ts:530` (`getFirstTurn`) | Needs care | Transcript origin may be the desired display answer, but “first identity/lineage turn” may intentionally mean lowest prompt. Define the consumer's meaning and NULL/tie policy before changing it. |
| `src/db/settlement.ts:169` (`listSettlementCohortIds`) | Wrong for the current settlement contract | K=50 and frozen cohorts are prompt-order semantics today. Reordering changes boundaries and requires versioned cohorts plus pending-job handling. |
| `src/db/citations.ts:435` | Wrong/unnecessary as a blanket switch | Effective citations are keyed by citing turn ID; iteration order is largely an output determinism detail, while the current code and comments use prompt order. Change only a consumer that explicitly needs transcript chronology. |
| `src/db/orphan-turns.ts:39` | Needs care | The queue is operationally prompt ordered (`orphan-turns.ts:45-49`). Transcript order may be useful for presentation, but changing repair priority is a behavior change. |
| `src/hooks/capture-repair.ts:435` | Wrong for this call | Repair candidates are already selected in transcript order, then constrained by `lastLinkedPromptNumber` (`capture-repair.ts:483-571`) and the governing spec's monotonic guard. Switching the NULL-turn query can make candidate pairing violate that guard. |
| `src/worker/processors.ts:345` | Wrong/incomplete | The query defines “previous” as `prompt_number < current` before ordering and limiting to 100. Changing only `ORDER BY` does not create the previous 100 transcript turns; it creates a mixed, semantically inconsistent calibration window. |

The 96.7 percent line coverage is useful for measuring the opportunity, not a reason to apply the same order to all eight consumers. The 309/319 missing-line turns need an explicit policy; they cannot be handled by an informal pairwise fallback.

### MAJOR-6 — The proposed changes conflict with the governing spec and 0.8.4 contracts

Evidence: `.scratch/arc-spine-redesign/spec.md:55-64,80-104,118-135`; `src/hooks/milestone-injection.ts:11-25`; `src/mcp/timeline.ts:3015-3067,3407-3445`; `src/worker/query-session.ts:375-398`.

The following are not optional implementation details:

- Spec C currently preserves the `score → toolCallCount → earlier prompt` tie order and defines structural always-keep behavior. A new score, tool-key removal, or removable-anchor policy needs a C amendment.
- Spec D says the renderer can keep anchors in full and report an over-budget condition. A third pass must define whether the 2,500-token budget is hard, whether structural anchors can be sacrificed, and the terminal behavior when the protected set itself exceeds it.
- The 0.8.4 two-phase settlement freezes K=50 member IDs and carries forward durable jobs. A new order needs a cohort/order version, treatment of already-enqueued jobs, and a migration/drain plan. Formula evaluation can be read-time only, but the score version must be stable for reproducibility if it affects durable output.
- The extraction prompt's rubric explicitly grades causality and says tool count is not a skip criterion (`query-session.ts:375-398`). File count and raw response length should not quietly become a second grading rubric or reward verbosity inside a fixed grade band.
- The injection budget is for the assembled timeline, not just milestone bodies (`milestone-injection.ts:11-25`; `timeline.ts:3407-3445`). Header, signals, hints, lineage, day frames, and the over-budget note must be included in tests. Generated bundles also need rebuilding; `scripts/build.js:21-58` and the release-artifact tests reject stale `plugin/scripts/*.cjs` bundles.

No database schema migration is needed merely to calculate sanitized features from existing columns. An ordering change is different: it changes persisted cohort membership semantics and needs an explicit migration/versioning strategy. A path-contract fix may require a read-time normalization policy or a backfill, including behavior for paths outside the repository. Existing NULL transcript-line rows cannot be assumed recoverable.

## Disposition of the four proposed changes

| Proposed change | Disposition | Decision |
|---|---|---|
| V7 weighted tie-break | Reject the exact formula; defer a replacement | First remove label leakage, decide whether files are an allowed product signal, remove or independently justify the tool tie-break, drop/validate `respLen`, define all missing/negative/terminal inputs, and run a pre-registered clean evaluation at the real budget boundary. |
| Third-pass anchor degradation with endpoint exemption | Reject endpoint-only policy; defer a structural-budget redesign | Protect semantic anchor classes or define their loss explicitly, rerun pull-through/re-homing safely, test day collapse, and specify the protected-set-overrun terminal behavior. |
| Delete `MILESTONE_PURE_SPEC_RE` | Defer | The regex is dead against current absolute production paths, but zero firings do not measure a normalized feature's value. Normalize or consciously remove the concept, update the spec and relative-path test, then remeasure. |
| Variant 4 ordering at eight sites | Reject the blanket swap; defer targeted chronology changes | Keep prompt order where it is identity, queue, cohort, monotonic-repair, or predecessor semantics. Introduce an explicit total chronological order only at consumers that need it, then version/migrate settlement cohorts and align timeline/pagination. |

Nothing in the four changes is ready to land exactly as proposed. A later implementation could still land a sanitized, independently validated tie-break and a narrowly scoped chronological display order, but those are amended designs rather than this proposal.

## Confirmed-clean

- The arithmetic claim is conditionally correct: with finite nonnegative feature values, weights summing to one, and a final `0.9` multiplier, the tie-break cannot exceed `0.9`. That preserves the never-cross-a-grade-tier invariant only after explicit domain sanitization.
- The current anchor-only overrun behavior is intentional and internally consistent: the renderer preserves `alwaysKeep` rows and emits an over-budget note. Existing timeline and injection tests cover current non-removal behavior (`tests/mcp/timeline.test.ts:4521-4573`; `tests/hooks/milestone-injection.test.ts:352-405`).
- The pure-spec regex is genuinely non-firing for the current DB representation: 5,408 distinct stored modified paths are absolute and the read-only DB query found zero matches. This confirms a dead current predicate, not the value of the underlying feature.
- The direct path-predicate sweep found no second runtime predicate with the same obvious repo-relative regex assumption over `filesModified`/`filesRead`; the other inspected path operations have different absolute/relative handling or substring semantics.
- Prompt numbers are stable identity selectors. Changing an `ORDER BY` does not renumber them, and exact `[S12/T3]` lookup remains addressable. The risk is the order-dependent consumers around that identity, not selector parsing itself.
- The proposal correctly identifies the real pressure points: over-budget sessions, retroactive compact markers, tie-break contamination, terminal gaps, and frozen settlement membership. Those observations justify further measurement and design work, but not the proposed production changes.

## Summary

Treat the study as a useful hypothesis-generation result. Do not ship V7, endpoint-only anchor deletion, pure-spec deletion, or the eight-site ordering swap until the score domain, independent gold labels, structural-anchor terminal policy, and versioned settlement/order semantics are specified and tested. The governing arc-spine spec must be amended before any implementation that changes tie order, anchor removability, cohort order, or budget behavior.
