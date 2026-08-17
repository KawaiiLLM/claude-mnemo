# 11 — Findings: verify on real data, re-measure baselines

**No code changes.** Every write in this ticket landed in `.scratch/semantic-container/11-findings.md` (this file) and the Status line of `issues/11-verify-and-baselines.md`. All measurement and demonstration ran against `/tmp/mnemo-t11-copy.db`, a `VACUUM INTO` snapshot of the production database taken 2026-08-18; the production file was never opened for write. Harness scripts live in `/tmp/mnemo-t11/` (outside the repo, per the ticket's rails) and are referenced by path below so results are re-runnable.

Production itself is still running the pre-ticket-01..10 build: `PRAGMA table_info(segments)` on the untouched copy has no Working State columns, no `segment_attachments` table, no `election_tier` column, and no session in the database has ever run the new note contract. This is the load-bearing fact behind several judgment calls below — most importantly, **there is no such thing as a "fresh window written under the current note contract" anywhere in the real database**, because the current note contract has never been deployed. Every harness that needed new-era behavior (election tiers, segment schema) supplied its own explicit `eraCutoffEpoch` (below every real turn's timestamp) exactly as `tests/support/settlement-config.ts` does, never touching `src/election-era.ts`'s inert production placeholder.

## 1. Baseline re-measurement

**Window choice.** S15069 is the same session the five original baselines were measured in (2026-08-17); it is also, itself, the session that implemented and landed tickets 01–10, and it kept running past the original baseline turns (T801–812) through T853. I used **S15069 T803–853** (48 substantive, non-`/compact` notes) as the fresh window for the note-audit baselines (narrative-opening, budget overage, title-only cold read) — later turns in the *same* continuing session, written after the problems were diagnosed, still under the old contract (production isn't rebuilt), but the freshest real data that exists. For insight-teachability I had to widen to **T700–853** (29 insight-bearing turns) because almost nothing after T798 carries an insight at all (see caveat below). For milestone-candidate-collapse I re-ran the *literal unchanged* legacy renderer (`hooks/milestone-injection.ts`, untouched by ticket 05 by design) against **S15069 in its current, larger state** (now 853 turns, was ~417 candidate-turns at the original T792 measurement).

| # | Baseline | Original (S15069, 2026-08-17) | Re-measured | Method | Verdict |
|---|---|---|---|---|---|
| 1 | Narrative-opening rate | 3/4 samples open with narration (T802) | **14/48 = 29%** open with narration (71% conclusion-first) | Same as original: self-audit of note `content`'s first clause (verb-first process narration vs. claim-first), on T803–853 | **Improved**, but see caveat |
| 2 | Note budget overage | 95% of post-cliff notes (251/263, T802) | **100%** (48/48) content over its 100-tok budget; median 1.89×, max 2.24× | Mechanical: `estimateTokens(content)` (the real `src/utils/token-estimate.ts`) vs. `NOTE_TOKEN_BUDGET.content` (unchanged at 100 tok) | **Slightly worse** |
| 3 | Title-only cold read | ~70% (T806, self-graded) | **~35–39%** of 9 valid probe questions answerable from titles alone (blind grader) | Upgraded to a blind Haiku subagent seeing *only* the 48 titles, answering 10 fixed comprehension questions | **Not directly comparable** — see caveat |
| 4 | Milestone candidate collapse | 77% (321/417, T792, flat 2500-tok budget) | **78.1%** (571/731) | Mechanical: re-ran `renderSessionMilestoneInjection` (unchanged, still `MILESTONE_INJECTION_TOKEN_BUDGET=2500`) on the same session, now larger | **Unchanged** (as expected — this code path is untouched by ticket 05) |
| 5 | Insight standalone-teachability | ~85% (66/81, T812, self-graded) | **96.6%** (28/29) blind; **100%** (2/2) on the strictly-fresh subset | Upgraded to a blind Sonnet subagent grading each insight text alone against the verbatim episode-deletion test | **Improved**, but see caveat (duplication, tiny fresh-n) |

### Caveats (read before trusting the table)

- **#1 and #5 look better, #2 and #3 look worse or unclear — none of this is attributable to the shipped contract**, because the shipped contract (ticket 01) has never been deployed to the process that wrote any of these notes. The plausible explanation for #1's improvement: T802/T806/T808 *diagnosed* the narrative-opening and title-duplication problems mid-session, and the same agent's own subsequent writing (T803 onward, still old-contract) seems to have self-corrected once alerted — an awareness effect, not a contract effect.
- **#2 got worse on a widened, not-cherry-picked sample.** 100% over budget is a ceiling result (n=48, all over); it says the overage problem is not self-healing without the mechanism ticket 01 shipped (2× hard rejection, budget language in parameter descriptions) actually running.
- **#3 is not a clean re-measurement of the same thing.** The original was self-graded by an agent that had *just read* the full content before grading titles-alone — real contamination risk the ticket flagged as exactly why this round mandates blind grading. My blind grader (Haiku, zero access to content) scored substantially lower. I believe the gap is mostly methodology (self-grading leaks), not a regression in title quality — but I cannot prove that without also blind-re-grading the *original* window, which is out of scope. Full Q&A transcript: `/tmp/mnemo-t11/` Agent output captured in this ticket's tool-call log (10 questions, ground truth and scoring reasoning below in §1a).
- **#5's sample is contaminated by near-duplication the per-row test doesn't penalize.** The grader itself flagged two pairs as near-identical restatements of the same lesson (a documented failure mode in the *original* T812 audit: "one lesson re-minted serially"). Treating those as a single distinct lesson each, the *distinct*-teaching rate is closer to ~90%, still an improvement but less dramatic than 96.6%.
- **#5's strictly-fresh sample (turns written after the original T811/T812 audit) is n=2** (T851, T853) — both pass, but n=2 proves nothing on its own. Insight production essentially stopped in this session between T798 and T851 (0 insights in ~50 turns of pure implementation work) — see proposed-tickets §4 below; this is itself a finding.
- **#4 is the one clean, apples-to-apples re-measurement** in the set: same code, same flat 2500-token budget, same session, no model involved, no methodology change — just later in time with more turns competing for the same budget. 77% → 78.1% is what "unchanged, as designed" looks like; ticket 05's new admission rule doesn't touch this code path at all (only the segment-nested `E<n>` milestone view uses the union rule), so this number is expected to stay flat until segments actually get adopted for old work.

### §1a — title-only cold read, question-level detail

Grader: Haiku, given only the 48 ordered titles (T803–853), instructed to answer "UNKNOWN" rather than guess. Ground truth built by me from the notes' `content` field (never shown to the grader).

| Q | Fact probed | In titles? | Grader answer | Scored |
|---|---|---|---|---|
| Q1 | Ticket count (11) | Yes (T834 states "eleven") | 11 | ✅ correct |
| Q2 | Ticket 09→01 parse-rule move | **No** — that detail is in T835's `content`, not its title | UNKNOWN | leak (matches original's "codewords need a ledger") |
| Q3 | Worker count/model | Partial — "three workers" in T835 title, "Sonnet" nowhere in titles | 3 workers, model unstated | partial |
| Q4 | 37/47 granularity number | No | UNKNOWN | leak (matches "count-pointers... opaque") |
| Q5 | Who ruled the title-prefix drop | Not in T804's own title | "The user" (inferred from T808's title, a *different* turn) | ✅ correct answer, reached only by cross-title pattern-matching — itself evidence of decider-erasure on the directly relevant title |
| Q6 | Which field is cadence-exempt | No | UNKNOWN | leak |
| Q7 | Ticket 07's licensed deviation content | No | UNKNOWN | leak |
| Q8 | Fields-half token budget / member crossover | My question conflated two different numbers (1000-tok in T828, 2000-tok in T849); excluded from scoring as my own error | (excluded) | excluded |
| Q9 | Ticket 08 mutation-description correction | No | UNKNOWN | leak |
| Q10 | The ~70% self-referential number | Yes (T806 states "about seventy percent") | 70% | ✅ correct |

Recovered: 2 clean hits + 1 inference hit + 0.5 partial = 3.5 of 9 valid questions ≈ **39%**. The five clean leaks reproduce, almost exactly, the three failure classes T806 originally named: session-local ticket cross-references (Q2), specific counts (Q4, Q8-adjacent), and micro-decision detail invisible above the title layer (Q6, Q7, Q9).

## 2. Full segment lifecycle, end to end

Harness: `/tmp/mnemo-t11/lifecycle-full.ts` (creation + settlement) and `/tmp/mnemo-t11/04-ab.ts` (the A/B in §3), run against `/tmp/mnemo-t11-copy.db` after `initializeSchema` migrated the copy to the new schema (six Working State columns, `segment_attachments`, `election_tier` — proving the migration runs clean over real, 1.9GB, 11824-turn production data, not just the test suite's synthetic fixtures). Full transcripts: `/tmp/mnemo-t11/lifecycle-output.txt` (first pass, ceiling refusal) and `/tmp/mnemo-t11/lifecycle-output2.txt` (corrected pass, lands).

**Seam used for settlement: the in-process fake-model seam** (`createSettlementStagingEngine` called directly with my own tier/membership decisions), not a live spawned SDK query — matching the test suite's own harness pattern (`tests/worker/note-settlement-staging.test.ts`). I made every election and membership judgment myself, reading the real turns, applying the real ranking criterion ("how much does this task's future depend on this turn?"). No live model call was made anywhere in this ticket; this is recorded per the ticket's own allowance ("the tests' in-process fake model/tool seams are acceptable if live SDK auth is unavailable").

### Step-by-step, on real data

1. **`remember(create)`** — seeded a real segment from 20 real turns (S15069/T814–T835, the segment redesign's own design arc) with a real goal row.
   ```
   Created E49 "Semantic-container redesign: segment as the per-topic semantic memory container" (topic: observation-pipeline). 20 member(s) seeded. goal: 1 row seeded.
   ```
   **Live-data finding, not fabricated**: I asked for topic `"semantic-container"`; `upsertTopic`'s alias-matching silently resolved it into a pre-existing, unrelated-sounding topic `"observation-pipeline"` (an alias registered by earlier real work). No confirmation was surfaced. See proposed tickets §5.

2. **`remember(attach)`** — bound the segment to S15069, got back the canonical card as the tool result (cache-safe by construction, per ADR-0006).

3. **`remember(append)`** — wrote 8 genuine Working State rows across `constraints`/`decisions`/`done`/`next_steps`/`reference`, each citing a real turn, e.g.:
   ```
   - decisions: 3 rows
     - The segment is the semantic container, the session exits the semantic layer keeping only title (ADR-0001/0006), decided by the user [S15069/T814].
     - Settlement's segment authority shrinks to membership + proposals; creation/naming/Working State stay main-agent-only, decided by the user [S15069/T819].
     - Milestone admission is state-cited union A-tier, with B-tier filling remaining budget, decided by the user [S15069/T830].
   ```

4. **Settlement window claimed**: S15069, T780–853 (N=74 reviewable turns). A plain `consecutive` window refused immediately — this session already has real, pre-redesign settlement jobs covering up to T847 (the monotonic floor, working exactly as designed on real history). Used `triggerType: "backfill"` (the documented exemption; this session's own real T793–798 arc is literally the backfill feature's own first production use).

5. **Election, first attempt — ceiling validator caught me for real**:
   ```
   Commit refused — tier A: 9 elected exceeds the ceiling floor(10%·74)=7; tier B: 23 elected exceeds
   the ceiling floor(30%·74)=22 — re-rank and re-stage rather than expecting a mechanical demotion.
   Staging kept: fill the gap and call commit again.
   ```
   This is ticket 06's own acceptance criterion, hit live, by accident, on my own over-generous first tiering — not a scripted test. I re-ranked to 7 A / 22 B (trimming the two least load-bearing calls from each tier) and re-staged the SAME keys.

6. **Also staged, same window**: a real membership `assign` for 3 turns the create-seed missed (T788/T790/T799 — genuine measurement work belonging to this segment settlement discovered), a `propose` for a genuinely homeless 3-turn cluster (T783–785, a different, prior release's verification thread), and a `note` type-fix for **T780**, which real production data carries as `type='[]', status='extracted'` — a genuine coverage gap the completion gate caught on real historical data (see proposed tickets §4).

7. **Commit lands**:
   ```
   Committed. S15069 window settled — job complete.
   commit metrics: { "turnsReviewed": 30, "tierCounts": {"A":7,"B":22,"C":0},
                      "membersAdded": 3, "proposalsCreated": 1 }
   ```

### The two rendered injection blocks (real composer, `renderAttachedSegmentBlock`)

**Fields block** (`recall(id="E49")` collapsed, 2000-token pageBudget, 2458 chars — comfortably under Claude Code's ~9.5K persist line):
```
[E49] #observation-pipeline · fields
- [E49] Semantic-container redesign: segment as the per-topic semantic memory container
  #observation-pipeline · [open] · 23 turns · created 2026-08-17 · last edit 2026-08-17 · maintenance 0 turns ago
  - tags: #semantic-container×20 #segment-fields×7 #tools×4 #rendering×3 #grading×2 #injection×2 #observation-pipeline×2 #ownership×2 #segment-grading×2 #tags-vocabulary×2 #tickets×2 #adr×1 #attachment×1 #decomposition×1 #maintenance-cadence×1 #milestone-budget×1 #milestone-injection×1 #note-fields×1 #recall×1 #release-sequencing×1 #remember-tool×1 #segment-creation×1 #session-fields×1 #spec-design×1 #spec-seams×1 #staged-commit×1 #token-budget×1 #worker-dispatch×1 #working-state×1
  - type: ⚖️design×19 📊measure×4 🔍research×2 ✅review×1 🤝delegate×1
  - sessions:
    - S15069 "0.11.0 and 0.11.1 shipped: all thirteen settlement-agentic tickets closed; segment redefined as semantic memory; next-version session/segment unification proposed but deferred": 23 turns, last active 2026-08-17
  - goal: 1 row
    - Ship the segment redesign (ADR-0001..0007): segments carry Working State, remember/note/timeline/recall become the quartet, settlement elects instead of grading.
  - constraints: 2 rows
    - One writer per layer: main agent owns remember/note, settlement owns election+membership+proposals only [S15069/T821].
    - Election seats are ceilings, never targets — a flat window elects fewer [S15069/T818].
  - decisions: 3 rows
    - The segment is the semantic container, the session exits the semantic layer keeping only title (ADR-0001/0006), decided by the user [S15069/T814].
    - Settlement's segment authority shrinks to membership + proposals; creation/naming/Working State stay main-agent-only, decided by the user [S15069/T819].
    - Milestone admission is state-cited union A-tier, with B-tier filling remaining budget, decided by the user [S15069/T830].
  - done: 1 row
    - Tickets 01-10 landed and committed: note contract, remember+schema, segment card, filter unification, timeline segment views, election, staged commit, membership facade, session retirement, SessionStart composition [S15069/T853].
  - next_steps: 1 row
    - Ticket 11: verify the pieces meet on production-shaped data and re-measure the five baselines [S15069/T835].
  - reference: 1 row
    - spec.md and ADR-0001..0007 at docs/adr/ are the authority; the spec yields to an ADR on any disagreement [S15069/T832].
```

**Milestones block** (`timeline(id="E49", view="milestones")`, 2000-token pageBudget, 2807 chars). This is the union rule (state-cited ∪ A-tier admitted unconditionally, B-tier fills the rest) working, live, on real data: 20 of 23 real members are admitted; the 3 excluded ordinals (T823, T831, T834 — none cited, none tiered A/B, i.e. genuine C-tier noise) are correctly the only ones missing:
```
[E49] #observation-pipeline · milestones
- [E49] Semantic-container redesign: segment as the per-topic semantic memory container
  [open] · 23 members

   T1 2026-08-17 04:15 📊 measure+injection-channels: milestones die at the cliff, the spine degenerates, recall is intact
   T2 2026-08-17 04:22 📊 measure+milestone-budget: a G3 turn with the right title was collapsed, so grades alone will not…
   T3 2026-08-17 14:08 🔍⚖️ research+segment-design: the partition is a projection of grades, whose input has been missing
   T4 2026-08-17 17:34 ⚖️ design+segment-fields: session exits the semantic layer and its fields migrate to segments
   T5 2026-08-17 18:19 ⚖️ design+segment-fields: the segment upgrades to a per-topic long-lived container, fields split into…
   ⚑ T6 2026-08-17 18:28 🔍 research+working-state: CC compact and Pi converge on the segment fields; long horizon is…
   T7 2026-08-17 18:38 ⚖️ design+segment-fields: constraints and done absorbed, fields go markdown-with-replace, and grade…
   T8 2026-08-17 19:00 ⚖️ design+grading: insight unifies to task scope, and election grading lands on library evidence
   T9 2026-08-17 19:31 ⚖️ design+segment-creation: creation follows attachment to whoever sees the roster; settlement demotes…
   T10 2026-08-17 19:42 ⚖️ design+segment: tags go coarse-to-fine nouns only, and homeless clusters ride the roster as…
   T11 2026-08-17 19:51 ⚖️ design+segment: one writer per layer — remember takes all segment fields, settlement keeps election,…
   T13 2026-08-17 20:04 ⚖️ design+grill: three rounds close the design tree, six ADRs and the glossary land
   T14 2026-08-17 21:32 ⚖️ design+injection: per-segment 2000-token blocks replace RecentSessions and the diary index
   T15 2026-08-17 21:56 ⚖️ design+injection: the segment block's metadata goes fully derived, and a system tag namespace…
   T16 2026-08-17 22:07 ⚖️ design+injection: the member list reuses the milestone renderer, emoji types shown, election labels…
   T17 2026-08-17 22:27 ⚖️📊 design+tools: the read pair unifies on one signature, and the twin 1000-token budgets prove…
   T18 2026-08-17 22:37 ⚖️ design+tools: the readers re-rendered — task axis first, top elision, segment rows as search hits
   T19 2026-08-17 22:58 ⚖️ design+tools: one shared surface with staged commit, milestones take cited union A, injection is…
   T21 2026-08-17 23:14 ⚖️✅ design+spec-seams: two seams and one auxiliary confirmed for the semantic-container spec
   T23 2026-08-17 23:21 🤝 delegate+frontier: eleven tickets published and three workers launched on disjoint territories

Legend: text ending in an ellipsis was truncated — read it in full with the mnemo-replay skill, addressing it by the bracketed ids on that line; a "+N more" count is reachable with timeline(id="S<n>", view="turns").
```

### Simulated session boundary

Created a real second session row (`S22370`), attached it to E49 via `remember(attach)` — the card correctly shows both sessions now (`S15069`: 23 turns; `S22370`: consulted only). `listAttachedSegmentsByActivity(db, 22370, 3)` returns `[E49]`, and `renderAttachedSegmentBlock` for that fresh session's slot 1 reproduces the identical fields block above byte-for-byte — confirming the SessionStart composer is genuinely stateless/pure over (segment, era-cutoff), not session-specific. **Roster** as the fresh session would see it (`renderSegmentRoster`) correctly lists E49 first-recency under its topic group, alongside 12 other real live segments from this and other projects:
```
## Segment roster (13 live)
### observation-pipeline (4)
- E49 Semantic-container redesign: segment as the per-topic semantic memory container — #semantic-container×20 #segment-fields×7 #tools×4
- E48 design+semantic-container: session semantics abandoned, segment upgraded to… — #semantic-container×32 #segment-fields×7 #injection×5
- E40 review+observation-pipeline: settlement-agentic cross-review continues through… — #observation-pipeline×1
- E32 measure+observation-pipeline: diary trigger stalled since 08-07, milestone layer…
### quota-cache-economics (2)
- E41 measure+quota-cache-economics: fifth window sample (17%/$1274) reconstructed,… — #quota-cache-economics×2 #subscription-usage×2 #weekly-spend-split×2
...
### san11-mapc-terrain-research (2)
- E46 research+san11-mapc-terrain-research: SIRE packed-byte permutation, water… — #calibration×2 #height-scale×2 #san11-mapc-terrain-research×2
...
```
(This last group is from a completely different codebase — see proposed tickets §6, the roster's grouping key.)

**Re-check**: `bun run /tmp/mnemo-t11/01-migrate.ts` then `bun run /tmp/mnemo-t11/lifecycle-full.ts` against a fresh `VACUUM INTO` copy reproduces this end to end (segment id will differ if the copy's `segments` table already has other rows from a prior run of the same script).

## 3. Election-vs-citation A/B (first leakage-aware pass)

Using segment E49's real 23 members, real `citedTurnIds` (7 turns genuinely cited by the Working State rows I wrote in §2 — `S15069/T814,818,819,821,830,832,835`), and the real election tiers landed in §2 (7 A, 14 of the 22 B-tier turns are actual members of E49).

**Arm (a) — the shipped union rule**: the real `selectSegmentMilestoneRows` (`src/mcp/timeline.ts`), unmodified.

**Arm (b) — pure citation-based selection**: my own operationalization, since neither the spec nor ADR-0003 pins exact mechanics for the "citation-derived" arm beyond "grade = highest state field citing the turn." I defined it as: **only members the segment's Working State/summary fields cite are ever admitted; there is no B-tier-equivalent fill** (pure citation has no second tier in this project's data model), demoted oldest-first under the same budget squeeze as arm (a)'s "always" set. **This is a judgment call, flagged** — a different operationalization (e.g., ranking uncited-but-tiered turns by citation *count* as a soft signal) would narrow the gap reported below.

Leakage: the two arms were computed from the same underlying facts (`electionTier`, `citedTurnIds`) but neither arm's selector is shown the other arm's *output* — each is a pure function of its own defining field.

| Budget (tok) | Union admits | Citation admits | Agreement (per-member admit/exclude match) |
|---|---|---|---|
| 150 | 4/23 | 4/23 | 100.0% (23/23) |
| 300 | 9/23 | 7/23 | 91.3% (21/23) |
| 1000 | 20/23 | 7/23 | 43.5% (10/23) |

**At tight budgets the two arms agree almost completely** (both squeeze down to the same small, cited core). **As budget loosens, they diverge sharply**: the union rule keeps admitting real B-tier work; pure citation is capped forever at the cited set (7), because citations accrue lazily as Working State gets maintained and nothing in the "pure citation" definition lets it grow past what's already been written into the summary layer.

**Eyeballed disagreement set** (budget=1000, 13 disagreements, all in the same direction — union admits, citation excludes):

| Turn | Tier | One-line judgment |
|---|---|---|
| S15069/T788, T790, T799 | B | Real, substantive measurement/design turns for this exact segment — union correct to keep them; citation drops them purely because nobody has cited them in Working State *yet* |
| S15069/T815–T817, T820, T824–T829 | B | The segment's own design arc (field-splitting, tags, injection mechanics) — same story: relevant, judged B by election, invisible to citation because the 5 WS fields I wrote only had room to cite the 7 most load-bearing rows |

**Verdict**: on this one real window, **union chose better on every observed disagreement** — pure citation's structural weakness (ADR-0003's own predicted consequence: "state budgets make citations scarce by construction") is not hypothetical, it costs real, judged-relevant rows the moment the budget has room for them. I did not find a single case where pure citation correctly excluded something union wrongly kept. **Caveat on my own objectivity**: I assigned the election tiers used by arm (a) myself in §2, so I am not a neutral judge of "union chose better" — a genuinely leakage-aware verdict would need a rater who did not also do the tiering. Flagged, not fixed.

## 4. Proposed follow-up tickets (findings only — no fixes made)

1. **Insight production appears to have stopped under real load.** Zero insights written S15069 T799–850 (~51 substantive turns of pure ticket implementation), versus 81/270 filled in the T?–798 audit population. Worth a ticket to check whether this is expected (implementation-heavy work genuinely produces fewer generalizable lessons) or a regression (the writer stopped reaching for the field once under sustained execution pressure).
2. **Note budget overage did not self-heal** (95%→100% on a fresh, non-cherry-picked window) even after the problem was explicitly diagnosed mid-session (T802/T808). Confirms ticket 01's 2× hard-rejection mechanism is load-bearing, not decorative — worth re-measuring *after* the contract actually deploys.
3. **The completion gate caught a real production coverage gap** (S15069/T780: `type='[]', status='extracted'`, crossed the extraction cliff without a backfilled type). Worth a ticket auditing how many other real turns share this shape (a targeted `SELECT COUNT(*) FROM turns WHERE type='[]' AND status='extracted'` across the whole database) before settlement runs against them for real and blocks on every one individually.
4. **`upsertTopic`'s alias-matching silently redirects a fresh `remember(create)` topic name into an unrelated existing topic**, with no signal in the receipt (§2, step 1: asked for topic `"semantic-container"`, got `"observation-pipeline"`). Worth a ticket to at least surface "topic X matched via alias, merged into existing topic Y" in the create receipt so this isn't silent.
5. **The roster's group header may not match the spec.** spec.md ("Injection" section) states the roster groups by "coarse project tag as group header"; the shipped `renderSegmentRoster` (`src/hooks/session-composition.ts`) groups by the segment's **topic**, and its own code comment describes topic as "a coarse project header" — treating the two as synonyms. On real data these are visibly different concepts: this project's own real segments carry topics like `semantic-container`/`quota-cache-economics` (fine-grained feature buckets), while ADR-0002's own worked example of a "coarse tag" is the literal repo name (`claude-mnemo`) — which the real member turns of E49 never carry at all, even though 52 turns elsewhere in the database do. Worth a ticket to confirm intended semantics (topic-as-header was possibly the right call given how inconsistently the coarse-tag convention is followed in real data) and, if project-tag grouping is really wanted, audit how much real data would even support it.
6. **Election-vs-citation arm (b)'s exact definition is unpinned** (§3) — my operationalization (cited-only, no B-equivalent) is one reasonable reading of ADR-0003, not the only one. A ticket to pin this before running the A/B at larger scale, plus a truly independent (non-self-tiering) rater for the "which arm chose better" judgment.
7. **Title-only cold read's ~70% original figure looks optimistic relative to a genuinely blind re-grade** (§1a). Worth deciding whether the *acceptance* number for this baseline should be redefined as blind-graded going forward, given the self-grading contamination risk is structural to the original method, not a one-off measurement error.

## Judgment calls made in this ticket (flagged, not authorized as decisions)

- Used the in-process fake-model settlement seam (my own tier/membership judgments), not a live SDK query — no live model call anywhere in this ticket.
- Chose S15069 T803–853 as the "fresh window," T700–853 for insight audit specifically, and re-ran the legacy milestone injection against S15069's current full state for baseline #4 — three different window definitions for five baselines, each justified per-baseline above rather than one uniform window, because the original methods themselves operated over different scopes.
- Trimmed my own first-pass election tiering (9 A / 23 B) down to the real ceiling (7 A / 22 B) after the validator refused it live — kept the refusal transcript as evidence rather than silently avoiding it by tiering conservatively from the start.
- Defined "pure citation-based selection" for the A/B (§3) myself; flagged as the single most consequential unpinned judgment call in this ticket, since it drives the whole verdict.
- Used Haiku for the cold-read grader and Sonnet for the teachability grader (both "blind subagent graders" per the ticket) — an asymmetric choice (cheaper/faster model for the more mechanical fact-probe task, stronger model for the more qualitative teachability judgment), not dictated by the ticket.
