# 06 — The shadow settlement comparison. Compare the bill, not the trace.

**What to build:** a real settlement A/B that answers whether the v13 write regime costs more or less than the seven-word one, measured as total spend on identical windows rather than as a footprint in the tool trace.

**Blocked by:** None. **BLOCKS 02, 03, 04, 05** — none of them may start until this returns (spec ruling 1, user S15069/T2332).

**Status:** PRICING PHASE RE-RUN, 2026-09-02 (round 2) — round 1's two defects fixed and the same window settled once more under each arm, with a LIVE edge pass this time: 49 / 40 / 59 edges written, all three done on one attempt, $5.65. Nominal, n=1 and not an effect estimate: A→B +7.1% dollars, B→C +17.9% — and B→C's money is cache READ (+62%), not output tokens (−2.7%). Within-window $ CV drops 0.252 → 0.122, but on 2 df its own upper bound is 0.77, so the smallest N spans 2–71/arm at +45% and 99–3,874/arm at +5%. **The sizing call is still the user's**; the cheapest thing that would make any N load-bearing is one arm replicated 3–4× on this same reset window (~$25), and it was NOT run. Battery and quality arm NOT RUN. Original scope line follows: ready-for-agent — SIZING QUESTION OPEN, see "Before you spend anything".

## Why this exists, and why ticket 01 was not enough

Ticket 01 measured what the tool trace can see and found measurable cost UP (+5%~+52%). It could not measure what v13 actually claims to save — a three-way relation choice replacing a seven-way one, and two redundant checks removed — because **those happen inside a single API call and leave no trace at that granularity.**

Worse, ticket 01 found that the seven-word vocabulary's only tool-layer footprint, the phase gate, has fired **zero times since 2026-08-25** and its wording is no longer in `src/` or `plugin/`. At that seam a smaller vocabulary has nothing left to save.

A total-cost comparison does not need a trace. It compares the bill.

## THREE arms, because the batch bundles two independent changes

v13 changes two things at once, and ticket 01's own finding — that edge VOLUME is what drives cost up — points at the second, not the first:

| arm | vocabulary | citation policy |
|---|---|---|
| **A** (control) | seven words | current sparsity rule |
| **B** | three classes (USE / CORRECT / VERIFY + full-partial bit) | current sparsity rule |
| **C** | three classes | complete direct-use citation (sparsity rule dead) |

**A→B isolates the vocabulary. B→C isolates the citation policy.** They are separately rulable, and collapsing them into one treatment arm makes the result uninterpretable: if the two-arm answer is "more expensive", nobody can tell whether to drop the vocabulary change or the citation change.

Arms B and C both write under rulings 2 and 3 (one row per pair at the honest placement; no new empty-sided edge — settlement places both endpoints or does not write the edge). Arm A writes exactly what production writes today, unmodified.

## Before you spend anything — REPORT BACK, do not proceed past this

A settlement run is expensive: measured over 14 days, per-run cost ran $0.77 to $12.43, and runs calling `commit` three or more times are 17% of runs and 48% of settlement cache-read spend. Three arms times N windows means 3N real runs.

- [ ] Price one run on a representative window under each arm, report the three numbers and the extrapolation to your proposed N, and **stop for the user's sizing call before running the full battery.** A "directional, n=2" result nobody will act on is worse than not running.
- [ ] State the smallest N at which the effect sizes in play (~+5% for A→B, ~+45% for B→C) would be distinguishable from run-to-run variance, given the variance you measure. If that N is unaffordable, say so plainly — that is a legitimate outcome and it is the user's call, not yours.

## Constraints on how it runs

- [ ] **Production `~/.claude-mnemo/` is STRICTLY READ-ONLY.** Every arm runs against its own copy. A window settles terminally exactly once, so the same window cannot be re-settled in place — arm isolation is by database copy, and each arm's copy must start from the SAME snapshot.
- [ ] Byte-identical material across arms except the rubric text. Same windows, same snapshot, same model, same budgets, same worker build.
- [ ] The arms must be blind to each other: no arm's output is visible while another runs, and no grader sees which arm produced what.

## What is measured

- [ ] **Total output tokens per window**, not per edge. Per-edge normalizes away the volume effect, which is precisely the thing under test.
- [ ] Edge count per window, and the row multiplier under ruling 2 (pairs stored once vs pairs spanning several lanes).
- [ ] **Refusals by family** — the read-grant family (8.74/100 edges today, expected unchanged) and the lane-side family (0.67 today, expected to GROW under ruling 3, since an unplaceable endpoint now blocks the write instead of falling through to `''`). A rise there is a predicted cost of ruling 3, not a defect.
- [ ] Wall clock, cache-read spend, and `commit` attempts per run — the abandoned-window failure mode (job 166: 81 minutes, 21 refused commits, terminal) is a cost this comparison must be able to see.
- [ ] **A quality arm, blind.** Cheap-and-wrong must be detectable: a zero-tool reader given each arm's rendered lane view, graded on routing accuracy against a key written from source before any arm answers. If v13 is cheaper but reads worse, the cost result is not a reason to ship it.

## Reporting

- [ ] A→B and B→C reported SEPARATELY with their own effect sizes and variance; never a single "v13 vs today" number.
- [ ] Every arm's per-window raw numbers in the ticket, not just the aggregates.
- [ ] If an arm could not be run honestly — the model channel, the budget, the sizing call — report it NOT RUN with the reason. A gate reported as passed on reasoning rather than execution is the worst outcome available here.

---

# PRICING PHASE — RUN AND REPORTED, 2026-09-02

Scope executed: build the three arms, price ONE representative window under each, report the
bills and the sizing arithmetic, stop. The battery is NOT run. The quality arm is NOT run.

**Headline, before the numbers: the three bills are honest bills of the three runs that
happened, and they do not price what this ticket is about.** All three arms committed the
window having written ZERO new edges, because the window was already settled and its graph
was already complete. The edge pass — 97% of settlement spend, and the entire treatment
surface — was a no-op in every arm. Separately, arm B's own write path was broken by a hole
in the vocabulary mapping layer. Both defects are named exactly below, both are cheap to fix,
and neither is a reason to doubt the harness as a whole: the arms build, isolate, run, settle
and commit correctly.

## 1. The window, and why

`S18993 / T275…` was not chosen; **`S18993 / T101–T150`** was. Session `18993`
(`93881b79-82cd-48da-98bd-befe6d3ad0a5`), 50 turns, 58 stored edge rows over 55 pairs
(density 1.16), session total 388 turns, 45/50 turns lane-placed across the E61 lanes.
Its production settlement is job **162** (`backfill`, done, 2 attempts).

Selection ran over the ONLY population an A/B can be compared against: the 11 `done` jobs of
the last 14 days on the CURRENT two-stage regime (`stage='edges'`, which begins at job 149 on
2026-08-30). The 81 older `stage='topics'` jobs are a different machine and their per-run cost
is 0.57× the current one; mixing them understates everything. Ranking was by
`max |x − median| / MAD` over {turns, edges, density, session turns}, sum-Z as secondary — "closest
to all four medians at once, worst dimension first".

**The top-ranked window was rejected on the ceiling, and the ceiling is the finding.** Job 167
(`S21460/T275-324`, max-Z 0.40) is the most median-shaped window in the population — and its
own production settlement took **1612 s (26.9 min)** and cost **$7.53**. The task's kill ceiling
is 20 minutes. Choosing it would have guaranteed three killed runs and zero data.

**The 20-minute ceiling sits BELOW the median wall clock of a current-regime settlement**
(median 1215 s = 20.25 min over the 11 windows; 5 of 11 exceed 1200 s). It is therefore not a
safety margin — it is a selection filter, and it excludes the middle of the distribution. Any
future battery has to either raise it or accept that it can only ever measure the fast half.

`S18993/T101-150` is the rank-2 window (max-Z 0.78) and the only one in the top two whose
successful production attempt (799 s, $2.51) leaves headroom for a ~+45% arm inside 20 minutes.
Backups, ranked: job 171 `S23566/T101-150` (max-Z 1.00, 983 s, but a 157-turn session);
job 163 `S18993/T151-200` (max-Z 1.56, 778 s).

A `trigger_type='backfill'` row for `(18993, 101)` already existed (job 162) and was deleted
from each clone before the insert, exactly as the ticket warned. `allow_pre_era: true` was
passed. The enqueue returned job 172 on all three clones.

## 2. How arms B and C carry the three classes

**A mapping layer in each arm's own build. The shipped closed vocabulary, the `memory_edges`
CHECK, `attachTurnRelations`, the lane checker and the commit gate are byte-identical to arm A.**
The alternative — extending the validator — would have changed what the gate does, and the gate
is supposed to be the constant across arms.

Input half. `db/citations.ts` gains a settlement-only entry table and the settlement facade
imports it under the shipped names:

```
use            -> extends    (class 3; absorbs consume / grounds / indexes)
correctFull    -> override   (class 1, coverage bit = FULL)
correctPartial -> narrows    (class 1, coverage bit = PARTIAL)
verify         -> verifies   (class 2)
```

Verified at the tool boundary — `settlementTurnWriteInputShape` keys:

```
arm A: … tags override narrows extends indexes consume grounds verifies retractOverride … (7+7)
arm B: … tags use correctFull correctPartial verify retractUse retractCorrectFull …      (4+4)
```

Read half. `shared/v13-display.ts` (new, arm-local) remaps every relation word rendered BACK to
the agent — `formatRelationArrow`/`formatRelationArrowInbound` (recall's relation trees) and the
six `lane-checker-render.ts` sites — so an arm never reads back a vocabulary it was not taught.

Teaching. `shared/memory-rubric.ts`'s **七个关系词** block becomes **三个关系类** (precedence, not
partition; CORRECT/VERIFY as subsets of USE; the sharpened FULL/PARTIAL premise test; dominant-action-
wins), and both pointers to it by heading name follow. Arm C additionally strikes the sparsity
clause 「已经能经由既有边读到的路径,不重复画」 and demands complete direct-use citation with ancestors
excluded. Both arms state ruling 2 ("one row per pair, at the honest placement") explicitly, because
the shipped gate does not enforce it (see §5).

Nine further model-visible surfaces still named the seven words (the settlement `note` tool
description, the unified tool description, the stage-1 description, the commit `report` contract,
the fracture-stitch finding, one facade refusal) and were remapped too — reading "seven relations"
back at an arm taught three would be an artefact of the harness, not of v13.

Rendered proof, arm A vs B vs C rubric block: 4,703 → 5,688 → 5,932 bytes.

Patches (diffs against HEAD `ebda877e`), in
`…/scratchpad/v13ab/patches/`:
`harness.diff` (22 lines, IDENTICAL in all three arms — `DATA_DIR` and `WORKER_PORT` from env),
`arm-B-teaching.diff` (206), `arm-B-vocab-layer.diff` (341), `arm-C-teaching.diff` (212),
`arm-C-vocab-layer.diff` (341). Generator: `…/scratchpad/v13ab/patch_v13.py`.

`diff -rq arm-A/src arm-B/src` returns exactly the ten treatment files plus the one new module.
Arm A's `src/` differs from HEAD only in the two harness files, and its `worker.cjs` differs from
the shipped bundle only on those two lines.

## 3. The three bills

Same snapshot (one `VACUUM INTO`, three `cp -c` clones), same window, same model
(`claude-sonnet-5`, verified from the transcripts), same budgets, same build except the arm's
own patch. Each arm ran against its own clone, its own data root and its own worker port
(37801/2/3); production's worker on 37778 was never touched. Token numbers are from each arm's
own SDK transcripts, deduped by `messageId:requestId`, attributed by message timestamp.

Price sheet, USD per 1M tokens, `claude-sonnet-5`: input 2.00 / output 10.00 /
cache-write-5m 2.50 / cache-write-1h 4.00 / cache-read 0.20. Sourced from today's LiteLLM
`model_prices_and_context_window.json` and cross-checked against a second local table.
**Both of this repo's own price tables are wrong for this model** — `scripts/token-economics.ts`
still says $3/$15 (50% high) and `scripts/analyze-memory-logs.py` has no `sonnet-5` entry at all,
so it prices these runs at $0.

| | A (control) | B (three classes) | C (three classes, complete citation) |
|---|---|---|---|
| status | done, 1 attempt | done, 1 attempt | done, 1 attempt |
| output tokens | 56,749 | 79,605 | 42,020 |
| cache read | 2,092,170 | 2,538,915 | 1,538,474 |
| cache creation (5m) | 148,336 | 167,443 | 122,051 |
| input tokens | 44 | 48 | 36 |
| API calls | 22 | 24 | 18 |
| wall clock | 625 s | 847 s | 444 s |
| **edges written** | **0** | **0** | **0** |
| edge rows after / baseline | 58 / 58 | 58 / 58 | 58 / 58 |
| pairs after | 55 | 55 | 55 |
| row multiplier | 1.055 (pre-existing) | 1.055 | 1.055 |
| new empty-sided rows | 0 | 0 | 0 |
| refusals, READ_GRANT | 0 | 0 | 0 |
| refusals, LANE_SIDE | 0 | 0 | 0 |
| refusals, other | 2 (membership; `E61` non-member) | 8 (2 membership + **6 harness-defect edge-field**) | 2 (membership + `finalize` summary cap) |
| `commit` attempts | 1 | 1 | 1 |
| **dollars** | **$1.3569** | **$1.7225** | **$1.0331** |

Nominal effects: A→B **+26.9%** dollars / +40.3% output / +35.5% wall. B→C **−40.0%** / −47.2% / −47.6%.
**Do not read those as the A→B and B→C effects.** With the treatment inert they measure prompt
length plus how hard each arm happened to hunt.

### 3a. Why the bills do not price the treatment — defect 1, the window

Every arm reached the edge pass, ran `lane_check`, found nothing, and committed. Their own commit
reports, independently:

- A: "the full T101-T150 chain plus lookback already carried a complete, consistent edge graph … lane_check showed zero errors, zero removed-side debts, **no new edges needed**."
- B: "checked ~40 candidate claim links … **every one already existed in the graph from a prior pass** except S18993/T131 correctPartial T54".
- C: "lane_check showed 0 errors and **full pre-existing edge coverage** across all 5 worklist lanes (no missing edges to add)."

**A re-settlement of a `done` window does not exercise the edge pass.** This is structural, not
bad luck: the ticket's own isolation rule (arm isolation by database copy, "a window settles
terminally exactly once") forces re-settlement, and re-settlement of a settled window finds its
own work already done. Every window in the last 14 days is in this state.

**Fix, for the battery.** Before each arm runs, strip the window's own edges from that arm's clone
— `DELETE FROM memory_edges WHERE citing_kind='turn' AND citing_id IN (the window's turns)` — so
each arm settles genuinely edge-less material from an identical start. It is the only way to make
three copies of one window each exercise a real edge pass, it costs nothing, and it keeps the arms
byte-identical to each other. State it as a deliberate departure: what gets measured is a COLD
edge pass, not a natural first one.

### 3b. Defect 2, arm B's write path — one line

Arm B found one genuine v13 edge (`S18993/T131 correctPartial S18993/T54`, the M5 cancellation
voiding the original duel design) and **could not write it**. Six `note()` edge-field calls —
`use`, `verify`, `correctPartial`, `retractUse` — were all refused with
`Parameter error: <field> is refused in the edge pass`. Arm B diagnosed it correctly in its own
commit report as "an apparent tool fault, not a grammar violation".

Cause: `worker/note-settlement-sdk-query.ts:231`'s `STAGE_TWO_TURN_NOTE_FIELDS` — the edge-pass
allowlist — derives from the SHIPPED `RELATION_FIELD_ENTRIES`, and the arm patch aliased that
import only in `note-settlement-turn-facade.ts`. The four class parameters therefore fell outside
the allowlist and were classified as note fields.

Fix: the same one-line alias in `note-settlement-sdk-query.ts`'s import from `db/citations`.
Arm C inherits the identical hole; it simply never got far enough to hit it.

Arm B's bill is inflated by this: it is the only arm that repeatedly hit a refusal wall and
re-tried. Its +26.9% over A is partly the harness, not the vocabulary.

## 4. Variance, the smallest N, and the extrapolation

Two variance sources, and they answer different questions.

**Between-window (production, 14 days, current `stage='edges'` regime only, n=11 windows /
13 runs).** Per WINDOW, counting retries because a retry is cost, not noise outside cost:
dollars median $3.452, mean $4.108, sd 2.205, **CV 0.537**; output tokens **CV 0.321**; wall
CV 0.360. Per RUN: dollars CV 0.677. Match rate to transcripts was 97/97 job rows (100%);
reverse, 10 runs on 2026-08-29/30 have no surviving job row (ids 131–157 partly deleted), so
`note_settlement_jobs` is not a complete ledger of runs and the transcripts are.

**Within-window (this phase, n=3).** The three arms ran the SAME window on the SAME material
with near-identical configurations, so their spread is the closest thing that exists to the
paired variance the sizing needs — and the production data cannot supply it, because no
historical window was ever settled twice under two configurations (job 162's and 169's retries
are early-death first attempts, not clean replicates). Dollars **CV 0.252** (1.67× min-to-max on
identical input), output tokens **CV 0.319**, wall CV 0.316. **n=3: an order-of-magnitude anchor,
not an estimate**, and it still contains whatever real prompt-length effect the arms carry.

Formula: normal approximation, α=0.05 two-sided, power 0.80, `(z₀.₉₇₅+z₀.₈₀)² = 7.849`.
Unpaired, N per arm: `N = 7.849·CV²·[1+(1+δ)²]/δ²`. Paired over the same windows, assuming the
two arms' residuals are independent given the window (`σ_d² = 2σ²`): `N = 7.849·2·CV²/δ²`. A
paired N smaller than this needs a positive between-arm correlation, which nothing here measures.

| variance source | +5% (A→B) | +45% (B→C) |
|---|---|---|
| production per-window $, CV 0.537, unpaired | **1,904** /arm | **35** /arm |
| production per-window $, paired-if-independent | 1,811 | 22 |
| production per-window output tokens, CV 0.321, unpaired | 680 | 12 |
| this phase's same-window replication, $ CV 0.252, unpaired | 418 | 8 |
| this phase's same-window replication, $, paired-if-independent | **397** | **5** (→ ~8 with a t-correction) |

3N extrapolation, at the current regime's per-window median $3.452 / mean $4.108:

| design | 3N runs | @median | @mean |
|---|---|---|---|
| +45%, paired, CV 0.25 | 24 | $83 | $99 |
| +45%, unpaired, CV 0.537 | 105 | $362 | $431 |
| +5%, paired, CV 0.25 | 1,179 | $4,070 | $4,843 |
| +5%, unpaired, CV 0.537 | 5,712 | **$19,718** | **$23,465** |

Multiply any of these by ≈1.36 for the abandoned-job tax: 4 `abandoned` jobs in the same 14 days
burned $29.74, ~40% of all current-regime settlement spend, and the done rate is 11/15 = 73%.

**Plainly: +45% is affordable, +5% is not.** B→C is measurable for a few hundred dollars, or
under $150 if the paired anchor holds. A→B at +5% needs somewhere between 1,200 and 5,700 runs —
$4K to $23K — and the cheap end rests on an n=3 CV. Switching the endpoint to output tokens does
not rescue it (680 windows/arm, 2,040 runs). If +5% is to be answered at all it needs the variance
driven down first (one fixed corpus, one window size, retries excluded), not more runs; otherwise
it should come off the experiment's goals and A→B should be ruled on meaning, as ruling 2 was.

## 5. What the ticket and spec say that is not true at HEAD `ebda877e`

1. **`src/shared/definitions.ts` does not exist.** The settlement tool shape is
   `src/mcp/definitions.ts`; the closed write vocabulary is `EDGE_RELATIONS` in
   `src/shared/turn-phase.ts`, mirrored by `CITATION_RELATIONS` in `src/db/citations.ts` and by
   `memory_edges`' own CHECK in `src/db/schema.ts`. The refusal the ticket predicted is real —
   the CHECK enumerates exactly the seven words — it just lives in three places, not one.
2. **"The worker hard-exits ~70 s after spawn with no work" is retired.** `worker/server.ts:1661`
   says so explicitly: the 70-second "all registered sessions closed" hard-exit and the separate
   30-minute idle-HTTP clock both folded into one idleness clock whose default is
   `DEFAULT_WORKER_IDLE_SHUTDOWN_MS` = 1 hour, and which never counts while work is live.
   Spawning the worker and feeding the job in one command is still right, for other reasons.
3. **"Rulings 2 and 3 already hold in the shipped gate" is half true.** Ruling 3 HOLDS: a bare
   address is accepted as a draft, but every writable-set edge with an empty side is error E6 and
   `commit` refuses while one remains, so no run can leave a new empty-sided edge behind. Ruling 2
   is **NOT enforced by anything**: the row identity is
   `UNIQUE(citing_kind, citing_id, cited_kind, cited_id, relation, tail_tag, head_tag)`, so several
   rows per pair are storable and nothing forbids the cross-product. It is a writer norm that the
   shipped teaching happens to produce (multiplier 1.024 in production, 1.055 in this window). B and
   C inherit it only because their patched teaching says so — verified, not assumed.
4. **The live edge teaching is not where the ticket's lineage suggests.** The single-dispatch path
   renders `worker/note-settlement-unified-prompt.ts`; `worker/note-settlement-prompt.ts` (which
   carries the "path already readable … is not re-drawn" sentence and the `indexes` convergence
   step) is reached only on the stage-`edges` RESUME path. The unified prompt states no vocabulary
   of its own — it points at the Memory Rubric **by heading name**. A patch that changes only
   `note-settlement-prompt.ts` changes nothing a normal run ever reads. Both were patched.
5. The 20-minute ceiling is below the median current-regime settlement (§1).

## 6. NOT RUN, and why

- **The full battery.** Per the ticket's own stop rule, the sizing call is the user's. It should
  not be sized off these three bills anyway (§3a/3b).
- **The quality arm** (blind zero-tool reader over each arm's rendered lane view, graded against a
  key written from source). Explicitly part of the full battery, not the pricing phase.
- **A fourth settlement.** The two defects are diagnosed but not re-tested; re-testing them is one
  cheap run each and belongs to whoever the user assigns the battery to.
- **Per-arm quality/graph comparison.** With 0 edges written in every arm there is nothing to compare.

## 7. Where everything is

Scratch root `…/e8541c19-…/scratchpad/v13ab/`:
`snapshot.db` (2.28 GB, one read-only `VACUUM INTO` of production);
`arm-{A,B,C}/` (clonefile repo copies + per-arm `db.sqlite` + `dataroot/`);
`patches/*.diff`; `patch_v13.py`, `run_arm.sh`, `cost.py`, `measure.py`, `reclone.sh`;
`out/arm-{A,B,C}/{run.log,bill.json,span.txt,worker.err}`, `out/measure-{A,B,C}.json`;
`out/arm-B-aborted/` + `aborted-B/*.jsonl` + `out/armB-aborted-bill.json`;
window-selection and variance scripts `jobs_joined.{json,csv}`, `per_run.csv`, `runs.json`,
`stats.py`, `pick.py`, `sizing.py`, `litellm.json`.

Per-arm SDK transcripts (the billing source of record) are under
`~/.claude/projects/-private-tmp-…-v13ab-arm-{A,B,C}-dataroot/`.

**Total spend this phase: $5.03** — A $1.3569 + B $1.7225 + C $1.0331 + $0.9181 for one aborted
arm-B attempt (killed at 585 s by a wait-loop timeout in my own harness that took the worker's
process group with it — not the ceiling, not the arm; re-run clean from a fresh clone). Production
`~/.claude-mnemo/` was opened read-only exactly once and never written.

---

# PRICING PHASE, ROUND 2 — THE SAME WINDOW, WITH A LIVE EDGE PASS

Round 1's two defects are fixed and the same window was settled once more under each arm.
**This time the treatment fired.** All three arms wrote real edges (49 / 40 / 59), all three
committed on one attempt, none came near the ceiling, and arm B's write path took the class
vocabulary with zero edge-field refusals. Total spend: **$5.65** (A $1.6966 + B $1.8163 +
C $2.1406). Nothing else was run: no battery, no quality arm, no fourth settlement.

## 1. Fix 1 — the window is edge-less when each arm starts

Round 1 re-settled a `done` window and every arm's edge pass found the graph already complete.
The reset below runs on each arm's OWN fresh clone of `snapshot.db`, once per arm, from one
script (`round2_reset.sh`):

```sql
CREATE TEMP TABLE win AS
  SELECT id FROM turns WHERE session_id=18993 AND prompt_number BETWEEN 101 AND 150;
CREATE TEMP TABLE doomed AS
  SELECT id FROM memory_edges WHERE citing_kind='turn' AND citing_id IN (SELECT id FROM win);
DELETE FROM memory_edge_side_tags WHERE edge_row_id IN (SELECT id FROM doomed);
DELETE FROM memory_edges          WHERE id IN (SELECT id FROM doomed);
DELETE FROM note_settlement_jobs  WHERE session_id=18993 AND window_start=101;
```

Deleted per arm, IDENTICAL in all three (the script prints these and they matched exactly):

| | A | B | C |
|---|---|---|---|
| window turns | 50 | 50 | 50 |
| `memory_edges` rows deleted (citing turn in window) | **58** | **58** | **58** |
| `memory_edge_side_tags` rows deleted | 116 | 116 | 116 |
| production job rows deleted (job 162) | 1 | 1 | 1 |
| edges citing the window, after | 0 | 0 | 0 |
| edges citing the window FROM OUTSIDE, kept | 39 | 39 | 39 |
| `memory_edges` total, after | 5,548 | 5,548 | 5,548 |

Snapshot total is 5,606, so exactly the 58 went and nothing else. The 39 inbound edges whose
citing turn lies outside T101–150 were deliberately kept — the instruction was to strip the
window's own edge pass, not its neighbourhood.

**What else had to be reset, and what did not.** The job row (162, `done`/`edges`/2 attempts) is
the only stage/status mark, and deleting it takes with it, by `ON DELETE CASCADE`,
`note_settlement_proposals`, `note_settlement_debts` and `lane_run_touches` — every per-job
record that says this window's edge pass already happened. There is **no per-edge and no per-turn
settlement mark**: `memory_edges` carries only `provenance` and the two lane columns, and `turns`
has no settled/era column that an edge pass reads. `memory_edge_tags` was named in the plan and
**does not exist** — ticket 09 dropped it; `memory_edge_side_tags` is the only edge side index
left. `note_settlement_cursors.last_settled_prompt_number` (388) was left alone: it gates
scheduling, not the edge pass, the explicit `/settle` enqueue clears it via `allow_pre_era`, and
it is identical across arms either way.

Each arm's preflight, printed by the run script before its own enqueue, read
`edges citing window: 0` / `job rows: 0`. The clone is fresh (`cp -c` off `snapshot.db` with
`db.sqlite{,-wal,-shm}` removed together first) and the data root is a new empty `dataroot2/`, so
round 1's databases, transcripts and bills all survive untouched.

## 2. Fix 2 — the arm-B/C allowlist now reads the arm's own vocabulary

`worker/note-settlement-sdk-query.ts` derives `STAGE_TWO_TURN_NOTE_FIELDS` — the edge-pass
allowlist — and the stage-1 pre-`finalize` denylist from `db/citations.ts`'s two entry tables.
The round-1 patch aliased those imports in the facade but not here, so `use` / `correctFull` /
`correctPartial` / `verify` fell outside the allowlist and were classified as note fields.
One import, identical in both arms:

```diff
--- arm-A/src/worker/note-settlement-sdk-query.ts
+++ arm-B/src/worker/note-settlement-sdk-query.ts
@@ -53,7 +53,10 @@
   type RunLaneTouches,
 } from "../db/lane-disposition";
 import { getTurnById } from "../db/turns";
-import { RELATION_FIELD_ENTRIES, RETRACTION_FIELD_ENTRIES } from "../db/citations";
+import {
+  V13_RELATION_FIELD_ENTRIES as RELATION_FIELD_ENTRIES,
+  V13_RETRACTION_FIELD_ENTRIES as RETRACTION_FIELD_ENTRIES,
+} from "../db/citations";
 import { TASKLESS_TASK_SCOPE_ID } from "../db/homeless-record";
```

It covers both consumers in that file — the allowlist at line 234 and the pre-`finalize` refusal
at line 3104 — so the two cannot disagree. `note-settlement-stage1.ts` imports the same names but
never uses them (a dead import); nothing else in either arm reads the shipped entry tables from a
settlement path.

**Proof before spending, in process, in each arm's own build.** A throwaway test drives the arm's
real stage-2 `note` handler through the existing `runStageTwo` seam (`toolImpl` capture,
`queryImpl` stub — no API call), writes one `use` relation, and reads the storage row back:

```
arm B: accepted   "Landed 1 relation(s)."      stored rows (relation='extends'): 1
       refusedOld "Parameter error: extends is refused on the edge pass — …"
arm C: accepted   "Landed 1 relation(s)."      stored rows (relation='extends'): 1
       refusedOld "Parameter error: extends is refused on the edge pass — …"
```

Both directions matter: `use` is now accepted AND lands as the shipped `extends` word (the
mapping layer intact), while the retired seven-word key is the one now refused — which is what
shows the allowlist really moved rather than merely widened. Arms B and C were rebuilt
(`settlement-child.cjs` 4,482,971 → 4,482,987 bytes in both).

`diff -rq arm-A/src arm-B/src` and `… arm-C/src` still return exactly the ten treatment files
plus `shared/v13-display.ts` — `note-settlement-sdk-query.ts` was already in the set, so the fix
added no file. Arm A's `src/` differs from HEAD only in the two harness lines.

**Harness defect fixed too.** Round 1's arm-B abort at 585 s was not the harness's own wait loop
but the foreground shell it ran in timing out and taking the process group with it. Round 2's
runs are launched detached (`nohup … &`, immediate return) and polled from outside; a 600 s
foreground timeout landed on arm A mid-run and the arm was verified still alive on its port
immediately afterwards. **The only kill in the script is the ceiling**, raised to 35 minutes /
$15 per round 1's finding that 20 minutes sits below the median settlement. No arm came within
20 minutes of it.

## 3. The three bills, round 2, with round 1 beside them

Same snapshot, same window, same model (`claude-sonnet-5`), same budgets, same price sheet
(input $2.00 / output $10.00 / cache-write-5m $2.50 / cache-write-1h $4.00 / cache-read $0.20 per
1M), same `cost.py` and `measure.py`, deduped by `messageId:requestId` and attributed by message
timestamp. Ports 37811/2/3, data roots `dataroot2/`. Production's worker on 37778 was never
touched.

| | **A** r2 | *A r1* | **B** r2 | *B r1* | **C** r2 | *C r1* |
|---|---|---|---|---|---|---|
| status | done, 1 attempt | *done, 1* | done, 1 attempt | *done, 1* | done, 1 attempt | *done, 1* |
| output tokens | 78,400 | *56,749* | 84,694 | *79,605* | 82,425 | *42,020* |
| cache read | 2,391,386 | *2,092,170* | 2,595,142 | *2,538,915* | 4,203,352 | *1,538,474* |
| cache creation (5m) | 173,699 | *148,336* | 180,091 | *167,443* | 190,233 | *122,051* |
| input tokens | 46 | *44* | 42 | *48* | 66 | *36* |
| API calls | 23 | *22* | 21 | *24* | 33 | *18* |
| wall clock | 827 s | *625 s* | 908 s | *847 s* | 868 s | *444 s* |
| **edges WRITTEN** | **49** | *0* | **40** | *0* | **59** | *0* |
| edge rows after / start | 49 / 0 | *58 / 58* | 40 / 0 | *58 / 58* | 59 / 0 | *58 / 58* |
| pairs after | 49 | *55* | 40 | *55* | 59 | *55* |
| **rows per pair (ruling 2)** | **1.000** | *1.055* | **1.000** | *1.055* | **1.000** | *1.055* |
| new empty-sided rows | 0 | *0* | 0 | *0* | 0 | *0* |
| refusals, READ_GRANT | 0 | *0* | 1 | *0* | 3 | *0* |
| refusals, LANE_SIDE | 0 | *0* | 0 | *0* | 0 | *0* |
| refusals, edge-field (harness) | 0 | *0* | **0** | *6* | 0 | *0* |
| refusals, other | 1 (membership) | *2* | 2 (membership, note mode) | *2* | 1 (note mode) | *2* |
| `commit` attempts | 1 | *1* | 1 | *1* | 1 | *1* |
| **dollars** | **$1.6966** | *$1.3569* | **$1.8163** | *$1.7225* | **$2.1406** | *$1.0331* |

Relation fields actually reached for, from each arm's own transcripts — the vocabulary under test,
exercised:

```
arm A  grounds 19 · extends 10 · verifies 8 · override 5 · indexes 7 · narrows 1     (50 entries, 6 of 7 words)
arm B  use 20 · verify 12 · correctPartial 6 · correctFull 4                          (42 entries, all 4 classes)
arm C  use 46 · verify 8 · correctPartial 5 · correctFull 4                           (63 entries, all 4 classes)
```

**Ruling 2 held itself in every arm, unenforced: 1.000 rows per pair, all three.** Production's
own settlement of this same window ran 1.055. The lane-side refusal family stayed at ZERO under
ruling 3 as well — the predicted cost of "place both endpoints or do not write the edge" did not
appear on this window, which is one window's evidence and not a general result.

## 4. Nominal A→B and B→C, n=1, NOT an effect estimate

One run per arm on one window. These are the two differences that happened, not estimates of
anything, and the width of the interval around each of them is larger than the difference itself.

| | dollars | output tokens | wall | edges written |
|---|---|---|---|---|
| **A→B** (vocabulary) | **+7.1%** | +8.0% | +9.8% | −18.4% |
| **B→C** (citation policy) | **+17.9%** | −2.7% | −4.4% | +47.5% |

A→B landed within shouting distance of the ~+5% the ticket named — with n=1 that is a coincidence
worth noting and nothing more.

B→C is the interesting shape and it is not the one the ticket predicted. C wrote **47.5% more
edges for 2.7% FEWER output tokens**; its extra $0.32 is almost entirely cache read
(2.60M → 4.20M, **+62%**) carried by 57% more API calls (21 → 33, including 7 `timeline` calls no
other arm made). Under complete direct-use citation the arm did not write more per turn — it
LOOKED more, and looking is billed at $0.20/M against a context that grows with every turn of the
run. If that shape survives replication, the cost of ruling 3 is a search cost, not a write cost,
and the endpoint that sees it is cache read, not output tokens.

## 5. The variance anchor, updated — and what round 1 is and is not good for

**Round 1 is NOT a second replicate of these runs.** Its edge pass was inert; its three bills
price a no-op re-settlement of a complete graph. Round 1 and round 2 are two different processes,
so "n=3 per arm across two rounds" does not exist — what exists is **n=1 per arm of the priced
thing** and n=1 per arm of a degenerate one. Pooling all six runs gives $ CV 0.236, and that
number should not be used for anything: it is mostly the gap between the two processes
(arm C alone moved +107% between rounds, arm B +5%).

Round 1 remains usable for exactly two things: the between-window production variance it measured
from `note_settlement_jobs` and the transcripts (untouched by any of this), and as the control
that says the harness settles and commits correctly with nothing to do.

**The within-window anchor, re-measured on round 2's three live runs** (same window, same
material, treatment live — still containing whatever real arm effect exists, so an upper bound on
noise as much as a measure of it):

| endpoint | n | min → max | mean | sd | **CV** |
|---|---|---|---|---|---|
| dollars | 3 | 1.697 → 2.141 (1.26×) | 1.885 | 0.230 | **0.122** |
| output tokens | 3 | 78,400 → 84,694 (1.08×) | 81,840 | 3,188 | **0.039** |
| wall clock | 3 | 827 → 908 s | 868 s | 40.5 | 0.047 |

Round 1's same measurement was $ CV 0.252 / output CV 0.319 — **round 2's spread is half of it on
dollars and an eighth on output tokens.** That is the fix showing up in the variance: with the
edge pass live, all three arms do the same amount of real work, and round 1's spread was largely
three agents improvising differently over an empty worklist.

**Two df. Say it out loud.** A CV from n=3 carries a 95% interval of roughly ×0.52 to ×6.28 on
the standard deviation, so the honest anchor is **CV 0.06 – 0.77 with a point estimate of 0.12**,
and the sizing has to be read across that whole range:

| anchor, dollars | +5% (A→B) | +45% (B→C) |
|---|---|---|
| CI low, CV 0.063 | 27 /arm | 1 /arm |
| **point, CV 0.122** | **99 /arm** | **2 /arm** |
| CI high, CV 0.766 | 3,874 /arm | 71 /arm |
| production per-window, CV 0.537 (unpaired) | 1,904 /arm | 35 /arm |
| output tokens, round-2 CV 0.039 (point) | 11 /arm | 1 /arm |

(α=0.05 two-sided, power 0.80, `(z₀.₉₇₅+z₀.₈₀)² = 7.849`; unpaired
`N = 7.849·CV²·[1+(1+δ)²]/δ²`, paired-if-independent `N = 7.849·2·CV²/δ²`, which is within a few
percent of the unpaired number at these CVs and is not tabulated separately.)

3N budget at the current regime's per-window median $3.452 / mean $4.108:

| | 3N runs | @median | @mean |
|---|---|---|---|
| +45%, CV 0.122 (point) | 6 | $21 | $25 |
| +45%, CV 0.766 (CI high) | 213 | $735 | $875 |
| +5%, CV 0.122 (point) | 297 | $1,025 | $1,220 |
| +5%, CV 0.766 (CI high) | 11,622 | $40,119 | $47,743 |

Multiply by ≈1.36 for the abandoned-job tax (unchanged: 4 abandoned jobs in 14 days, $29.74,
done rate 11/15).

**What changed against round 1's conclusion.** Round 1 said +45% is affordable and +5% is not,
sized off a contaminated CV of 0.252. Round 2's cleaner within-window CV moves BOTH down by about
4× at the point estimate — +45% becomes nearly free and +5% becomes a few hundred runs rather
than a few thousand — **but the point estimate rests on two degrees of freedom, and its own upper
confidence bound puts +5% back at $40K.** The right next step, if the sizing question is to be
answered rather than guessed, is the cheap one: **replicate one arm on this same reset window
three or four times to get a real within-arm CV** (~$7 per run, ~$25 for four). That number, not
this one, is what a battery should be sized on. It is a run of the same shape as these three and
was NOT taken, because this phase's scope was three runs.

## 6. What turned out false, and what is still NOT RUN

1. **`memory_edge_tags` does not exist** — the plan named it as a table to sweep alongside
   `memory_edges`; ticket 09 dropped it and `memory_edge_side_tags` (`ON DELETE CASCADE`, but
   swept explicitly here) is the only edge side index left.
2. **Round 1's "my wait loop killed arm B at 585 s" is not quite right.** The wait loop's own
   ceiling was 1200 s and never fired; what killed the run was the foreground shell it was
   launched in hitting a 600 s tool timeout and taking the process group. The fix is detachment,
   not a longer loop — and it was verified under a real 600 s timeout during arm A.
3. **Round 1's within-window CV (0.252) overstates the noise by ~2×** on dollars and ~8× on
   output tokens, because it was measured with the edge pass inert.
4. **"Ruling 3 will grow the lane-side refusal family" did not show up.** Zero LANE_SIDE refusals
   in all three arms, including arm C, which wrote the most edges. One window.
5. **B→C's cost is not where the ticket assumed.** It predicted the cost of complete citation in
   edge VOLUME and therefore output tokens; on this window output tokens went DOWN and the money
   went to cache read (§4).

NOT RUN, and why:

- **The full battery** — the sizing call is the user's, per the ticket's own stop rule, and §5
  argues it should be preceded by one cheap within-arm replication rather than sized off n=3.
- **The quality arm** (blind zero-tool reader over each arm's rendered lane view) — part of the
  battery, not the pricing phase. Note that it is now actually RUNNABLE: three arms' worth of
  genuinely different graphs exist (49 / 40 / 59 edges over the same 50 turns), which round 1
  could not supply.
- **A fourth settlement** — the task's stop rule.
- **A within-arm replication** — see §5; it is one arm, three or four runs, ~$25, and it is the
  single cheapest thing that would make any of the N figures above load-bearing.

## 7. Where round 2's artefacts are

Scratch root unchanged. New this round, all alongside round 1's, which survives intact:
`round2_reset.sh`, `run_arm2.sh`, `measure2.py`, `fields2.py`, `round2_stats.py`;
`out2/arm-{A,B,C}/{run.log,bill.json,span.txt,tdir.txt,worker.err,DONE}`,
`out2/measure-{A,B,C}.json`, `out2/arm{A,B,C}.nohup`;
`patches/fix2-arm-{B,C}.diff`; `ticket06.round1.bak`.
Each arm's `db.sqlite` now holds that arm's own settled graph, and `dataroot2/` its data root.
Round 2's SDK transcripts (the billing source of record) are under
`~/.claude/projects/-private-tmp-…-v13ab-arm-{A,B,C}-dataroot2/`; round 1's, under the
`-dataroot` names, are untouched.
