# 05 — Convergence comes from shape, and the milestone set is checked, not assumed

**What to build:** the milestone machinery that `indexes` used to feed, rebuilt on the graph's own shape — and evidence that the result did not get worse.

**Blocked by:** 03, 04 — the graph must be migrated and unsparsified before its shape means anything.

**Status:** SPLIT by spec RULING 5 — 05a (read-side remap of election weights and tier 4 onto three classes, blocked by 03, REQUIRED for B) / 05b (shape-based convergence, blocked by 04, deferred). Previous status line: BLOCKED on ticket 06 (user ruling S15069/T2332: v13 does not advance until the shadow settlement comparison returns). The lane-placement question that used to block this is RULED — S15069/T2331, the empty side is legacy compatibility only, readable but never newly created; S15069/T2332, one row per pair at the honest placement. Earlier blocker follows: design-peer verdict 2026-09-01 (NOT READY). Do not dispatch until the semantic rulings listed at the end of the spec are made. See the spec's Status block for what changed and why.

Spec: `.scratch/relation-vocabulary-v13/spec.md`, "Out of scope / consequences to carry".

- [ ] Milestone election tier 4 (today: pull in every node INDEXED BY an elected node) is rebuilt on class-3 fan-out. Report the threshold chosen and why; a threshold is a tuning knob and must be named as one, not buried.
- [ ] The FROZEN election weight tables are keyed by the seven words. Remap them onto three classes plus the full/partial bit, and say for each old weight where it went. Note the shape of what is being remapped: `override` 2 out / absent in, `indexes` 2 out / 1 in, `grounds` 1/2, `verifies` 1/2, `narrows` 1/1, `extends` and `consume` 0/0.
- [ ] **Regression check with the blind instrument, not by inspection**: three arms over the same lane — today's milestone set, the shape-derived set, and a no-edge control — graded on the fixed battery by zero-tool readers, key written from source first. A shape-derived set that routes worse than today's is a blocking result.
- [ ] Report how many nodes gain and lose milestone status, with examples of each.
- [ ] `npx tsc --noEmit` clean; touched suites green; full `bun test` once; bundles rebuilt, stale-bundle guard green.

---

# 05a — the re-key, and the measurement the ruling needs

**Status:** the RE-KEY has landed at the frozen defaults; the two open keys are
MEASURED and NOT CHOSEN. Nothing is deleted — `INTERIM_LEGACY_RELATION` and its
call site still stand, and rollback is still a read-side switch. 05b is
untouched (still deferred with ticket 04).

## What landed

`src/shared/election-relation-weights.ts` is the new home of everything the two
frozen elections read off an edge, keyed on `(class, coverage)` through
`edgeRelationClass` — never `relation_class` directly, per ticket 03's note.

**The parameter table lives in that file:** `ElectionRelationParameters`
(`use: UseEdgeWeighting`, `convergence: ConvergenceDeclaration`) and its default
`FROZEN_ELECTION_RELATION_PARAMETERS`. It is threaded, as an optional last
argument defaulting to that constant, through `electMilestones`,
`selectMilestoneTurns` (`electionParameters` on its input object),
`selectSegmentMilestonesByEdgeSignals`, `assembleFrontierLanes` and
`buildSegmentFrontierSection`.

| old key | where it was | re-keyed to | forced? |
|---|---|---|---|
| `FRONTIER_OUT/IN_EDGE_WEIGHTS` `override` 2/absent | `mcp/timeline.ts` | `correct(full)` 2/0 | forced — one source word |
| … `narrows` 1/1 | " | `correct(partial)` 1/1 | forced |
| … `verifies` 1/2 | " | `verify` 1/2 | forced |
| … `extends` 0/0, `consume` 0/0, `grounds` 1/2, `indexes` 2/1 | " | `use` | **OPEN — parameter** |
| `IN_DEGREE_RELATIONS` (six words) | `shared/milestone-election.ts` | `countsTowardInDegree` = every class EXCEPT `correct(full)` | forced — all four `use` sources agreed here |
| tier ⑤ corrector `override` | " | `isCorrectionEdge` = `correct(full)` | forced |
| tiers ①/②/④ `indexes` | " | `convergenceDeclarationPredicate` | **OPEN — parameter** |
| `RELATION_IS_SCORED` + three SQL literals | `db/edge-signals.ts` | `RELATION_CLASS_IS_SCORED` + `RETIRED_USE_WORD_SIGNAL` + class-keyed SQL | see "false at HEAD" #4 |

**The retired-word residue.** `use` absorbed four words that scored four ways,
so "default = today" cannot be one class-wide number. The default reads each
RETIRED WORD's own frozen pair (`RETIRED_USE_WORD_WEIGHTS`), and anything with
no retired word — a new `use` row, whatever the interim leaves in `relation`,
including nothing once it is deleted — takes `extends`'s 0/0, which is exactly
what the interim produces. The residue is corpus HISTORY, not live vocabulary:
`consume`/`grounds`/`indexes` are refused at both write surfaces
(`RETIRED_RELATION_FIELDS`) and `interimLegacyRelation` maps `use` to `extends`,
so only pre-v13 stock can carry one. Candidates B–D replace the residue with one
uniform number for every `use` row, retroactively.

**Byte-identity.** `dump-head.ts` was run at HEAD (`d06f4cc3`) on an APFS clone
of `repro/copy.db` (5,682 edges / 14,132 turns / 70 segments, brought to HEAD's
schema by one `initializeDatabase`, which also ran ticket 03's sweep), then
`dump.ts` at candidate A after the re-key. Both surfaces, all 70 segments:

```
cmp head.json A.json  ->  identical (0 bytes differ)
```

Re-verified after all five mutation probes were restored. The existing milestone
fixtures (the golden nine, `tests/shared/milestone-election.test.ts`, 57 tests)
pass unchanged at the default.

## The measurement

**Which election runs on what — both, and they do not overlap.** The frozen
election is TWO elections and the four keys split cleanly across them:

- the **per-LANE** election is the SessionStart frontier slot
  (`buildSegmentFrontierSection`): `FRONTIER_*_EDGE_WEIGHTS` score each lane's
  settled members, and the accepted rows render under their lane's digest. This
  is the only place `use`'s in/out weight acts.
- the **per-SEGMENT** election is `electMilestones` (via
  `selectSegmentMilestonesByEdgeSignals` and `selectMilestoneTurns`): tiers,
  in-degree membership, tier ④. This is the only place the convergence rule
  acts. It reads no numeric weight at all — pinned by a test.

Driven at their production budgets (frontier: 2,000 tokens, host char limit
9,480, `eraCutoffEpoch` null; milestones: `DEFAULT_MILESTONE_PAGE_BUDGET`
1,000). Denominators: **65 declared lanes across 7 segments, 36 of them
rendering ≥1 row, 236 frontier rows; 15 of 70 segments with a milestone set, 185
milestone rows.**

| cand | `use` weight | convergence | lanes changed / 36 | rows + | rows − | segments changed / 15 | milestones + | milestones − |
|---|---|---|---|---|---|---|---|---|
| **A** | retired words (0/0, 0/0, 1/2, 2/1) | stored `indexes` | — (baseline) | — | — | — | — | — |
| **B** | uniform 1 / 2 (`grounds`) | stored `indexes` | **24** | 73 | 73 | 0 | 0 | 0 |
| **C** | uniform 2 / 1 (`indexes`) | stored `indexes` | **23** | 53 | 52 | 0 | 0 | 0 |
| **D** | uniform 0.75 / 0.75 (mean) | stored `indexes` | **22** | 66 | 66 | 0 | 0 | 0 |
| **E3** | retired words | `use` out-degree ≥ 3 | 0 | 0 | 0 | **3** | 23 | 22 |
| **E5** | retired words | `use` out-degree ≥ 5 | 0 | 0 | 0 | **3** | 24 | 24 |
| **E8** | retired words | `use` out-degree ≥ 8 | 0 | 0 | 0 | **4** | 42 | 43 |

Sensitivity run at a 6,000-token slot with no char limit (590 rows, 48
row-bearing lanes) — the budget fitter is a strong nonlinearity, so a wider slot
shows more of the ranking change: B 36 lanes / +167 / −169, C 34 / +132 / −131,
D 32 / +116 / −116. The E rows are identical (the fitter is downstream of the
tiers only through membership, which did not move).

Reproduce: `bun run dump-head.ts <db> head.json` at HEAD, then
`bun run dump.ts <db> <out>.json <A|B|C|D|E3|E5|E8> [budget] [charLimit|none]`,
then `python3 compare.py [.wide]`. Five-lane samples with titles are that
script's own output; the first sample of each candidate is reproduced below.

### B — first changed lanes (5 of 24)

```
E60/#citation-edges     + T1854 User approves the severed-lane teaching ticket …
                        + T930  measure+citation-edges: signal ranking reproduces the human A set, Q5 closes
                        - T1624 User reversed the arc direction, deleted self-citation, allowed provisional lanes
                        - T1823 WRONG, corrected at T1830: those rows are bare prose-reference records …
E60/#execution-repair   + T2116 The batch closes green and ships to peer with one open architectural wedge
                        - T296  Claim-monitor child isolation clears final review
E60/#extraction-architecture
                        + T374  Decomposed spec into 9 dependency-ordered tickets, skipping 3rd review
                        + T471  裁決26 landed (221c9a7); split ticket 09 into 3 sequential rollback-safe tickets
                        - T1035 Grading retires whole, the turns table dissolves into the unified row form …
                        - T1076 Field definitions settled: constraints holds norms, decisions holds task rulings …
E60/#lane-tag-redesign  + T1614 Correcting my own terminus rule: the arc-head decides, the arc-tail is free
                        - T1661 Writing tags IS changing membership; session attachment turned out to be an orphan
E60/#milestone-design   + T147, T1812, T2139, T2150, T2155
                        - T1901, T1914, T1917, T1970, T288, T303
```

### C — first changed lanes (5 of 23)

```
E60/#citation-edges     + T1854   - T1624, T1823
E60/#execution-repair   + T2085 The execution-repair spec goes READY after five peer rounds
E60/#extraction-architecture  + T471   - T1035
E60/#lane-tag-redesign  + T1945 User proposed the no-sourceless-landing rule and ruled view-spec an activity-named lane
                        - T1661
E60/#milestone-design   - T288  Machine-state eligibility filters are separated from scoring
```

### D — first changed lanes (5 of 22)

```
E60/#citation-edges     + T1854   - T1624, T1823
E60/#extraction-architecture  + T318, T357   - T1035, T1076
E60/#lane-tag-redesign  + T1614   - T1661
E60/#milestone-design   + T145, T147, T1816, T2155, T2186
                        - T1901, T1914, T1917, T1970, T288, T303
E60/#relation-vocabulary + T1166, T1178   - T109, T111
```

### E3 / E5 / E8 — the changed segments (milestone election)

E3 changes E60 (+17/−17 shown), E61 (+2/−2), E70 (+4/−3). Sample, E61 at E3:

```
+ S18993/T163 probe+demo-endgame: 琴里 wiped and locked out; 考据 worker delivered
+ S18993/T199 implement+height-shaded-map: hillshade preview from K3ST delivered …
- S18993/T34  Wrote 4 stable AI-NPC preconditions to AI NPC.md as mechanism/evidence/criteria
- S18993/T57  Design negotiation fully closed: intel ownership, resolution scoping, tool form fixed
```

E8 additionally changes a fourth segment and doubles the churn (+42/−43), which
is the wrong direction for a threshold meant to be SELECTIVE: raising it removes
declarers rather than adding them, so more of tier ②'s population collapses into
tier ⑥ and the ranking re-forms underneath. On the golden fixture the same shape
appears — at threshold 3, tier ② goes from 11 nodes to 6 and one node (946)
RISES to tier ① — so the proxy is a REPLACEMENT for the declaration tiers, not
an extension of them.

**A correction to this ticket's own framing.** "Tier ④ pulls in nodes by `use`
out-degree" cannot be implemented as stated: tier ④ has no independent feeder —
it is defined as "cited by an ELECTED tier ①/② node", and tiers ①/② are
themselves fed by `indexes` alone. A proxy applied to tier ④ only would be
permanently INERT, because once `indexes` retires no new node can ever reach
tier ①/② to seed it. So the parameter governs ONE predicate ("what declares a
convergence") feeding all three tiers, which is what candidate E measures.

## The three windows settled under 0.29.0

`windows.ts`, `electMilestones` scoped to each window's 50 turns (neither view's
entry point takes a prompt RANGE; `budget` = `DEFAULT_TIMELINE_PAGE_SIZE` 30,
"elected set" = the top ten by election rank).

| window | turns / edges | A's tiers | B, C, D | E3 | E5 | E8 |
|---|---|---|---|---|---|---|
| S15069/T2302–2351 | 50 / **0** | ③×20, ⑥×27 | identical | identical | identical | identical |
| S23566/T101–150 | 50 / 66 | ②×5, ③×11, ④×20, ⑥×13 | identical | ②×4, ④×19, ⑥×15; seats +1/−1 | ②×3, ④×17; +1/−1 | ②×2, ④×12, ⑥×22; +1/−1 |
| S18993/T101–150 | 50 / 63 | ②×1, ③×17, ④×1, ⑥×27 | identical | identical | identical | ② empty; +1/−1 |

The one seat that moves in S23566 is the same under all three thresholds:
`+ S23566/T102 Break the agent-runtime spec into nine dependency-ordered tickets`
displaces `- S23566/T138 Fifth review narrows to three closing items; F8
dispatched`. In S18993 at threshold 8, `+ T102 Picked mapA over mirrored mapB`
displaces `- T126 write+spec: folded session rulings into SPEC v6`.

B/C/D are inert on all three because `electMilestones` never reads a numeric
weight. Their effect on these windows is on the FRONTIER surface instead, over
the lanes those windows' turns carry (`window-lanes.py`): the first window's
lanes `#relation-vocabulary`, `#settlement-scope`, `#workflow`,
`#watchdog-liveness` change under B (3 lanes), C (2) and D (4); the second's
`#rp-harness` changes under all three; the third's `#visual-style`,
`#kernel-architecture`, `#map-data-extraction` change under all three. Example,
window 1 under C:

```
E60/#relation-vocabulary  + T1166 User corrected the grammar to final form …
                          + T1178 User dissolved the phase-set blocker …
                          - T109  Layer and phase are two axes, and encodes was defined on the wrong one
                          - T111  Simplified to eight words and two layers: grounds absorbs encodes
E60/#settlement-scope     + T1999, T2000   - T1741, T1992, T280
```

**The caveat that bounds all of this.** Every measurement above is on a corpus
whose `use` rows are 100% PRE-v13: 1,272 `extends`, 645 `indexes`, 488
`consume`, 471 `grounds`. The three windows' own edges are legacy words too —
they are the first windows whose FUTURE edges will be written as `use`, not
windows that already carry one. So the table answers "what does re-weighting the
retired corpus do", which is the only question a corpus can answer today; it
does not answer "what will a corpus of real `use` edges look like". The spec's
own bar — "no fan-out threshold may be chosen until the corpus is re-annotated
under the final rules" — is not cleared by this run and this run does not claim
to clear it.

## Verification

| item | result |
|---|---|
| `npx tsc --noEmit` | 0 |
| new tests typechecked (temp tsconfig extending the project's) | 0 |
| full `bun test` | **4676 pass / 0 fail / 256 files** (baseline 4651/0/255: +25 tests in 1 new file `tests/shared/election-relation-weights.test.ts`; `tests/db/edge-signals.test.ts` swapped one guard test for one, net 0) |
| `npm run build` | ok |
| `tests/shared/release-artifacts.test.ts` | 11/0 |
| `git diff --check` | clean |
| raw control bytes | none |
| `grep -c anthropic-ai plugin/scripts/worker.cjs` | 0 |
| election byte-identity at default, production copy | `cmp head.json A.json` identical |

Five mutation probes, all RED, all md5-restored:

| probe | red |
|---|---|
| the default `use` weighting flipped to uniform 2/1 | 8 |
| a FORCED key remapped (`verify` given 1/1 instead of 1/2) | 3 |
| `INTERIM_LEGACY_RELATION` emptied while it must still stand | 2 |
| the default convergence rule flipped to the proxy at threshold 3 | 25 |
| the in-degree domain widened to re-admit a FULL correction | 2 |

## False at HEAD

1. **Spec, Problem Statement:** "`extends` and `consume` score 0 on both sides,
   are absent from `lane-checker`, `edge-signals` and every milestone tier."
   `extends` is NOT absent from `edge-signals` — it is the `refines` key
   (`RELATION_IS_SCORED.extends = true`, and the refines query matched
   `relation = 'extends'` exclusively). And both words ARE in the milestone
   election's in-degree ranking (`IN_DEGREE_RELATIONS`), though correctly absent
   from every TIER. The claim is load-bearing for the spec's "paid for at write
   time, not harvested at read time" argument, and it overstates it.
2. **This ticket, bullet 1:** "Milestone election tier 4 (today: pull in every
   node INDEXED BY an elected node) is rebuilt on class-3 fan-out." Tier ④
   cannot be rebuilt alone — see the correction above.
3. **Ticket 02's report, "Interim table for 05a":** it names only
   `IN_DEGREE_RELATIONS` and `FRONTIER_*_EDGE_WEIGHTS`. Four more word-keyed
   reads were in scope and are re-keyed here: tiers ①/②/④'s `indexes`, tier ⑤'s
   `override`, and edge-signals' THREE-way split inside `use`
   (`extends`→refines, `grounds`/`indexes`→encodes, `consume`→nothing) — a
   split no ticket in this batch names.
4. **`db/edge-signals.ts`'s own header** presents `RELATION_IS_SCORED` as a live
   scoring decision. `getTurnEdgeSignals` has NO caller in `src/` at all —
   `tests/mcp/timeline.election-retirement.test.ts` grep-GUARDS `timeline.ts`
   against reading it. It is dead for the election, so its re-key moves no live
   behaviour. Worth a retirement ruling of its own; not taken here.
5. **`shared/milestone-election.ts`'s own header** said out-degree ties break
   "over ALL eight relation words". There were seven after `refutes` retired,
   and the tally reads no word at all — every edge counts. Corrected in place
   (comment only).

## UNVERIFIED / owed to the commit that deletes the interim

The interim fill is still what keeps these THREE readers correct; each must move
or be ruled dead BEFORE `interimLegacyRelation` is deleted, or a new `correct`
or `use` row goes invisible to it:

- `mcp/timeline.ts:5339` — the frontier digest's `latest override` pointer, still
  `edge.relation === "override"`;
- `shared/lane-checker.ts:1421` — the `indexes` reader; `:1654-1658` — the
  coupling groups on `grounds`/`consume`/`verifies`/`refutes`;
- `mcp/relation-tree.ts:57-61` — the arrow glyph (already half class-aware: it
  handles `use` and `correct(full)` beside the old words).

Also unverified: `compareLaneBranchEdges`/`compareLaneMirrorEdges` (the lane
adjacency view's branch ORDER) call `electionOutEdgeWeight` at the frozen
defaults, not at a caller's parameters — deliberate, since the parameters govern
the election and no candidate ships, but it means a future ruling must thread
them there too or the two surfaces will disagree about what a `use` edge weighs.
