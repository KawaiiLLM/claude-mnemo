# Relation vocabulary v13 — three classes, one criterion, complete citation

**Status:** NOT READY — design-peer verdict, 2026-09-01, with three findings the reviewer independently verified. Tickets 02-05 are BLOCKED pending the semantic rulings listed at the end. Ticket 01 may proceed with a WIDENED scope.

**Provenance correction:** the second ruling is **S15069/T2300**, not T2299. `T2299` is a REWOUND turn (`was_rolled_back=1`) — verified against the production row. Every citation of it in this batch was void and has been repointed. The ruling's CONTENT is unaffected; only its address was.

## Problem Statement

The seven-word vocabulary is paid for at write time and not harvested at read time.

- Two blind three-arm experiments (E60 `#lane-tag-redesign` 84 turns; E61 first 200 turns) found the reading value concentrated entirely in `override`. In the E61 run every citation the full-vocabulary arm gave as evidence was an `override` edge; the 68 `extends`, 47 `grounds`, 25 `narrows`, 20 `verifies` and 5 `consume` edges in that window were never invoked once. An arm keeping only `index`+`override` matched the full arm at 20.5% fewer tokens (9,044 vs 11,370); the arm with no edges scored 7.5 against their 10.0.
- The system's own FROZEN election weights already say the same thing: `extends` and `consume` score 0 on both sides, are absent from `lane-checker`, `edge-signals` and every milestone tier, and are read only by the adjacency render. They are 47% of all worded edges in production.
- The deeper defect is a contradiction, not a cost: the rubric requires "one edge per claim this turn modified" and "do not redraw a path already readable through existing edges". That SPARSITY rule deletes transitively-implied edges, which destroys the fan-out that structure would otherwise be read from — and `indexes` exists as a declared patch over the hole it leaves. Sparsity and emergence cannot coexist.
- `indexes` is therefore necessarily subjective: settlement marks it only when it JUDGES a convergence. Measured, that judgment is 81% recoverable from fan-out alone (137 of 170 declaring nodes have fan-out ≥2; 33 have fan-out 1 and violate the rubric's own cardinality rule).

## Solution

### The vocabulary — three classes

| # | Class | Meaning | The old words it absorbs | Edges | Share |
|---|---|---|---|---|---|
| 1 | **overturn / correct** (carries a FULL-or-PARTIAL bit) | the cited node's conclusion is overturned, or corrected in part | `override` (full) + `narrows` (partial) | 572 | 16% |
| 2 | **verify / support** | the cited node's conclusion is verified or supported | `verifies` | 323 | 9% |
| 3 | **use** | the cited node's conclusion or output was used to form a NEW conclusion or output | `extends` + `consume` + `grounds` + `indexes` | 2,766 | 76% |

Every one of the 3,661 worded production edges has a destination. That proves the mapping COMPLETE, not lossless — see the migration section for the 79 rows it destroys and the two capabilities it discards.

### The PRINCIPAL-RESULT rule (user ruling S15069/T2306) — closes the claim-granularity P0

**Both ends of an edge are the PRINCIPAL conclusion or output.** Not a detail the cited turn happened to mention, and not a side-fact this turn happened to confirm. Details do not earn edges.

This is the explicit, ruled choice between the peer's two options: accept the lossy coarsening ("an edge describes the cited turn's principal result") rather than build a claim selector. It is what makes the vocabulary decidable at turn granularity, and it bounds the sufficiency law — "rests on" means THIS turn's principal conclusion rests on THAT turn's principal conclusion.

It settles three of the blind annotator's reported ambiguities outright: restating a fact is not depending on a turn; a long-lived thesis is cited only where a principal conclusion actually rested on it; and an aggregation turn cites the principal results it converged, not every detail its artifact touched.

Worked case (user, T2306): `T95` wrote a map-export recipe and its prose says it "Confirms" something in `T93`. What it confirmed was that a REQUIREMENT LISTED INSIDE T93 was feasible — a detail, not T93's principal conclusion (which was "SPEC v4 is locked with these five revisions"). So it is USE, and VERIFY does not arise. A prose word like "confirms" pointing at a detail never makes a VERIFY edge.

### The deciding procedure (user rulings S15069/T2300, T2305, RESTATED after peer review)

The original wording — "nodes working towards ONE conclusion use classes 1 and 2, nodes whose outputs are DIFFERENT conclusions use class 3" — asserts that the classes are MUTUALLY EXCLUSIVE, and this spec contradicted itself two paragraphs later by conceding that an overturner also USES what it overturns. The real cases break it: a turn that overturns "unbounded retry is safe" AND produces a new bounded-retry design is both at once.

It is a PRECEDENCE, not a partition:

1. Does this output change the cited output's acceptance, reliability or scope?
   - negated or limited → **CORRECT**
   - confirmed or supported → **VERIFY**
2. Otherwise, is the cited output a direct input to this new output? → **USE**

So **CORRECT and VERIFY are SUBSETS of USE** (user ruling S15069/T2305), and USE is the fallback where no truth-state assertion is being made. The slot stores the most specific class. A mixed "corrected it and built on it" edge is CORRECT, and its provenance is not lost. No second row is written for the same pair.

**FULL versus PARTIAL, defined by the reader's action (user ruling S15069/T2305):** FULL means the FOUNDATION the cited node's conclusion stood on is overturned, so NO conclusion of that node should be used afterwards. Everything else — repairs, limits, anything still inheriting part of the cited conclusions — is PARTIAL. This is turn-level and it is checkable — but the question is NOT "does any true sentence about that turn survive". Every turn leaves permanent historical facts (it dispatched something, it wrote a file, it ran a test), and letting those rescue a node would make FULL nearly unreachable and would demote a superseded delivery claim to PARTIAL because the old commit once existed. The test is:
- **FULL** — the cited principal result has no substantial part left that may serve as a PREMISE for further reasoning or action; it survives only as history.
- **PARTIAL** — after the correction, a definite non-empty substantial part of it still stands as a premise. Applied to the blind annotation it immediately reclassifies one of the four FULLs: `T57→T56` reversed the intel-ownership proposal, but T56's principal conclusion ("a three-point review request was dispatched") survives, so it is PARTIAL.

**VERIFY is narrow:** it asserts something about the cited node's PRINCIPAL conclusion, and only where this turn's work bears on whether that conclusion holds.

"One conclusion versus different conclusions" survives as EXPLANATION of why `extends` is USE and not CORRECT — extending produces a new claim rather than moving the cited one — but it is not the algorithm.

Classes 1 and 2 are INTRA-claim: the cited claim itself is what is being moved. Class 3 is INTER-claim: one output fed another.

This is why `extends` is USE and not CORRECT — extending produces a NEW claim rather than modifying the cited one. `grounds` and `indexes` fall the same way. A three-step precedence replaces seven definitions whose scope clauses overlapped; it is a procedure, not a single criterion.

### Why classes 1 and 2 cannot be derived, and class 3 need not be declared

Using a node and overturning it are different facts, and an overturner also USES what it overturns — so no amount of citation completeness distinguishes them. Graph shape carries no "this is now false" and no "this is now confirmed". Classes 1 and 2 are truth-state assertions and must be written.

Class 3 is pure dependency. Once citation is complete, convergence, hubs and chains are readable from its shape; nothing needs to declare them.

### Endpoint rule — and a WITHDRAWN claim

Both endpoints must be nodes that HAVE a conclusion or output. A turn with no output is not a legal endpoint.

**WITHDRAWN:** the claim that this dissolves the DRAFT/unsettled-side machinery. Verified against `src/db/schema.ts:1541-1558` — `tail_tag`/`head_tag = ''` is the "LANE PLACEMENT not settled yet" sentinel, and settlement's own queue is defined as "the rows where both sides are `''`". It says nothing about whether an endpoint has a conclusion. A turn with full content can lack a lane side; a turn outside every lane can still be a legal citation endpoint. The two are orthogonal and this batch touches only one of them.

Two rulings are therefore still OPEN:
- **Citation eligibility** — what mechanically counts as "has a conclusion/output"? Is `content !== ''` enough? Do a ruling made in the user's prompt, an experiment artifact, a recorded constraint count? Today `attachTurnRelations` (`src/db/citations.ts:716-817`) validates address, self-edge and kind, and nothing about output — so the endpoint law is currently prompt text with no enforcement point named.
- **Lane placement lifecycle — ANSWERED by the design peer, reviewer-verified, and it exposes a token collision.** Recommendation: a v13 worded relation must land with class, coverage and BOTH lane sides decided in one transaction; the `''` sentinel survives only as legacy read/rollback compatibility and no new write may produce one. The reason is not tidiness — allowing an empty side would turn the new edges this regime REQUIRES into E6 findings the same run must then clear, so ticket 01 would be measuring the old lane machinery rather than the three-word cost. Slot precedence must apply per QUALIFIED `(citing, cited, tailLane, headLane)`, not per bare pair, or a bundle's second lane placement is silently swallowed.

  Measured on production and reproduced exactly by the reviewer: **679 of 3,661 worded edges (18.5%) carry both sides empty.** By lane candidates at their endpoints — **199 (29%) have exactly one honest candidate at each end**, **391 (58%) have at least one end with ZERO candidates**, **89 (13%) have candidates at both ends but at least one end is ambiguous**.

  **RULED (user, S15069/T2315): there is no "not yet settled" draft state any more, because the main agent no longer writes edges.** Verified against production, and the split is decisive:

  | writer | empty-sided edges | last written | at least one endpoint in NO lane | both ends exactly one candidate |
  |---|---|---|---|---|
  | `asserted` (main agent) | 344 | **2026-08-25 — stopped** | 132 | 140 |
  | `judged` (settlement) | 335 | 2026-09-01, 136 in 14 days | **259 (77%)** | 59 |

  The main agent's 344 are the genuine PENDING population — 140 of them were placeable and simply had not been placed — and that writer is gone. What is still being produced is settlement's own, and settlement is the settler: it does not leave a placeable edge unplaced. **77% of its empty-sided output has an endpoint that is in no lane at all.**

  So `''` no longer carries two meanings; the pending one died with its writer. The remaining meaning is LANE-LESS. Which makes the rule for v13 exact: atomic both-sides is correct for new writes, **but only once a genuinely lane-less relation has a legal expression that is not the pending sentinel.** Without that, the regime refuses 77% of settlement's current draft output for a condition that no longer exists. The 76 settlement drafts whose ends were placeable or ambiguous are the only population that "atomic placement" would legitimately tighten.

### The sufficiency law (user ruling S15069/T2300 — CONDITIONAL)

> Where this node's conclusion RELATES to earlier nodes, everything earlier that the conclusion rests on must be cited. Evidence produced within this turn is the turn's own contribution and is not required to be derivable from anything.

A turn designing an experiment to test an idea raised earlier cannot claim the idea is derivable from itself; it must cite the idea. A turn whose conclusion comes from reading source or from a user ruling owes no citation for that part.

This is a WRITING law, not a mechanical check — only the writer knows what its conclusion rests on. The one implementable proxy is the "mentioned but not cited" lint: an address appearing in a turn's prose with no edge to it.

### The sparsity rule dies

"Do not redraw a path already readable through existing edges" is removed. It is what destroyed fan-out and forced `indexes` into existence.

## Out of scope / consequences to carry

- **RULED (user, S15069/T2306), stated in two parts because they are two different kinds of claim:**
  1. **`indexes` is DELETED.** A product choice. It stands.
  2. **Out-degree becomes a milestone RANKING PROXY.** The spec no longer claims representation is "derived", because a function of out-degree alone provably cannot recover it: a release whose principal result rests on twenty delivered tickets and a root-cause whose principal result rests on twenty experiments both have out-degree twenty, and only the first REPRESENTS its targets. That is unidentifiability, not corpus noise, and the principal-result rule shrinks the number of such pairs without making them separable. **The system will no longer store precise representation; out-degree is a proxy signal for ranking.**
  Ticket 01 must therefore FREEZE a precision/recall gate before measuring, and test it ONCE on a held-out corpus — never tuning and validating on the same window. **If no threshold clears the gate, the correct outcome is "out-degree cannot recover representation", returned to the user for a fresh ruling — not a lowered bar and not more heuristics stacked on top.** The peer's binary — keep a declared `REPRESENTS`, or drop precise convergence — was resolved toward derivation, against the peer's advice. The residual risk is recorded here rather than argued away, and so is the reason the peer's refutation does not straightforwardly apply: BOTH precision measurements were taken on graphs built under rules this batch supersedes. The 29% figure came from today's graph, where sparsity suppresses transitive edges and `extends` chains dominate; a first pass over the blind re-annotation gives 42% precision at 83% recall (threshold 5) — but that annotation predates the PRINCIPAL-RESULT rule, which will move every fan-out again, and it rests on only 6 declared-index nodes in the window. **No fan-out threshold may be chosen until the corpus is re-annotated under the final rules.** The peer's counterexample class (a turn that rejected twenty alternatives, a refactor touching twenty modules) also weakens under the principal-result rule but is not proven gone.
- The reviewer's refutation is kept in full above rather than struck through: my earlier reasoning correctly showed that the 29% and 42% figures cannot SET a threshold, and then wrote that absence of applicable counter-evidence as if it were positive evidence for emergence. It is not. The measurement can only tell us whether the proxy ranks well enough; it cannot make the two node classes distinguishable.

### RULED (user, S15069/T2311): principal result SET, not THE principal result

The reviewer's P0 on ruling 3: closing the claim-selector question did not produce a unique principal. Three shapes exist — a single compound result (a ruling plus the artifact implementing it), SEVERAL parallel principal results (one turn that overturns a root cause AND independently delivers a fix that still stands), and no principal result at all (pure progress reports, pure dispatch). The second is not an edge case: batch rulings, a review that accepts an old ticket while finding a new defect, a diagnosis plus an independent workaround, one turn delivering several tickets. The current note rubric even requires content to record EVERY useful decision, so a single principal cannot be assumed.

**Ruled.** The user's reason is that this is not a new kind of thing: a node already belongs to several LANES, and it may likewise hold several principal conclusions. The turn stays the endpoint and no claim address is added:

> **Principal result set** — one or more parallel results of a turn that independently bear on later action; deleting any one of them would change what a later reader does. Process detail, and evidence serving only to establish those results, are not in the set.

The annotation contract then reports `endpoint = none | single | bundle`, a summary of the set, and its count, BEFORE any edge — so that annotator disagreement about WHICH principal was chosen is measured separately from disagreement about the relation. **Collision inside a bundle — RULED (user, S15069/T2311): the DOMINANT action wins, not the safest label.** "Mostly supporting is supporting", so a turn that mainly confirms a cited principal result and incidentally amends part of it is VERIFY, not CORRECT. This overrides the design peer's proposal that CORRECT should win for safety.

The governing reason is the retrospective reader's, and it is the same principle the principal-result rule comes from: **you retrace a decision by following the arc of principal conclusions, not by chasing details.** Much of the apparent collision dissolves once that is applied — if what a turn corrected was a DETAIL of the cited turn, it never earned an edge in the first place, because edges run principal-to-principal.

What this gives up, stated rather than hidden: where a cited bundle genuinely holds two principal results and this turn verifies one while correcting the other, a single slot on a turn-level endpoint cannot say both, and the dominant action is what survives. A reader retracing the arc may miss a real correction folded inside a VERIFY edge. That is the accepted cost of turn-level endpoints. 29% precision is already the refutation: high fan-out is equally a release summary, a turn that rejected twenty alternatives, or a refactor touching twenty modules. Moving the threshold trades precision for recall along corpus density; it does not create the missing semantics. The choice is binary — either keep a fourth relation **REPRESENTS** (and re-rule whether fan-out 1 is legal, since the 33 single-target `indexes` may be honest single-artifact deliveries rather than stages cut too finely), or drop precise convergence, delete tier 4, and let the blind instrument judge whether heuristic ranking suffices.
- **The experiments never isolated `indexes`.** Full versus `indexes+override` tying shows the other five added nothing to THAT battery; the missing arm is **override-only versus indexes+override**. Until it runs, no conclusion about deleting `indexes` follows from the experiments.
- The FROZEN election weight tables are keyed by the seven words and must be remapped onto three classes plus the full/partial bit.
- **Class 2's full/partial bit cannot wait for the write path.** While a relation points at a whole TURN and a turn can hold a compound conclusion, VERIFY needs coverage exactly as CORRECT does — confirming four of five findings is partial support. Worse, the blind-annotation run now in flight hardcodes VERIFY's third column to `-`, so that experiment will not surface the question, it DESIGNS IT OUT. The bit must be defined as COVERAGE, not confidence strength.
- **The claim-granularity question underneath both bits:** one cited turn may hold two outputs, with this turn correcting one and using the other. A turn-level endpoint cannot say which. Either accept that lossy coarsening explicitly ("an edge describes the cited turn's PRINCIPAL result") or introduce a claim selector and allow several edges per pair. The spec cannot go on implying it is both lossless and decidable.

## Testing Decisions

Judged at the existing seams — the rendered lane view, the terminal commit verdict, and the blind-reader instrument — never on writer internals. The instrument of record is the three-arm blind battery: fixed questions, a key written from source before any arm answers, one zero-tool reader per arm, graded on routing accuracy and on whether a stale claim is repeated as current.

The load-bearing measurement is ticket 01's: this vocabulary changes both the NUMBER of edges (complete citation raises it) and the COST of each (a three-way choice with no redundancy check replaces a seven-way one). The edge pass is 97% of settlement spend; the net direction must be measured before any write rule changes.

---

## FOUR RULINGS, 2026-09-01 (user, S15069/T2330–T2332)

These close every open question above except citation eligibility.

### 1. The batch does not advance on the current evidence. A shadow A/B decides it. (T2332)

Ticket 01 returned a result that contradicts this spec's own premise: measurable cost is UP (+5%~+52%), and the savings this spec claims — a three-way choice replacing a seven-way one, and two redundant checks removed — happen inside one API call and leave **no tool-trace footprint**, so that instrument can neither confirm nor refute them.

The finding that actually undercuts the batch is separate and harder: **the phase gate, the seven-word vocabulary's only tool-layer footprint, last fired 2026-08-25 and is now 0 per 100 edges, with its wording no longer present in `src/` or `plugin/`.** Vocabulary size already costs nothing measurable. There is nothing left for a smaller vocabulary to save at that seam. Meanwhile the read-grant refusals v13 keeps (8.74/100 edges) are unchanged and the lane-side refusals it adds (0.67) would grow.

**Ruled: run the shadow settlement comparison (ticket 06). Tickets 02-05 stay BLOCKED until it returns.** The reason for choosing a real A/B over more static measurement is that a total-cost comparison is the only instrument that can see an in-call saving at all — it does not need a trace, it compares the bill.

### 2. One row per pair, at the honest placement. (T2332)

A semantic pair spanning several lanes is stored ONCE, at the placement its writer judges honest — not once per candidate lane.

This is the largest single cost term in the whole batch: on the 100-turn sample it is worth 44-49 rows, `+9.7%` against `+45.7%`. It was ruled on meaning rather than price. **An edge's two ends are two conclusions, and the placement says which arc reads them — not which lanes the edge happens to touch.** One row per candidate lane stores an index in the semantics column.

The current writer already behaves this way (1 of 126 pairs stored two rows; multiplier 1.024), so this ratifies practice rather than changing it. Note the reason the question exists at all: **each edge side is capped at ONE lane tag** (user ruling S15069/T1603; the tool schema's `tailTag`/`headTag` are single strings, not arrays), so multi-lane coverage can only be expressed as multiple rows.

### 3. `''` is legacy compatibility only: readable, never newly created. (T2331)

Existing empty-sided edges keep rendering. **No new write may produce one.** Settlement either places both endpoints in a lane or does not write the edge.

**This reverses the reviewer's recommendation above (line 90), and the reviewer was wrong.** The argument was that atomic placement "refuses 77% of settlement's current draft output for a condition that no longer exists" — treating those 259 zero-candidate edges as legitimate lane-less relations needing a new legal expression. They are not legitimate. Under the user's own standing axioms — **S15069/T1607 "having an edge means having a lane"** and **S15069/T1608 "the right to write an edge is earned", with the segment explicitly refused as a fallback lane** — an edge whose endpoint sits in no lane was never legal. `''` was settlement routing around the axiom.

So this ruling adds no restriction; it closes the gap between the axiom and the implementation. The 259 are a defect count, not a requirements count. Slot precedence still applies per QUALIFIED `(citing, cited, tailLane, headLane)` as the reviewer required.

### 4. Retired text leaves retrieval entirely. (T2331)

Scope note: this one belongs to the lane-impressions batch, not here; recorded because it was ruled in the same breath. Both halves, never one: the tenancy predicate applies at the FTS index seam (so untenanted legacy prose stops being re-indexed on every later write to its segment), AND one full `rebuildSearchIndex` sweeps the existing rows. Accepted and irreversible: ~218,000 characters stop being findable; the bytes stay in their inert columns.

## RULING 5, 2026-09-02 (user, S15069/T2391): arm B lands directly; the battery is not run

After two pricing rounds (ticket 06: round 1 inert, round 2 live — A $1.70 / B $1.82 / C $2.14 on one window, n=1) the user ruled: **"先直接落地 B,别测了,不如实际看看."** The shadow battery is cancelled; the vocabulary change (arm B = tickets 02 + 03) ships and is observed in production. Arm C — deleting the sparsity rule (ticket 04) — stays DEFERRED until B has been watched; round 2 showed C's extra cost is search (cache read, +57% round trips), not writing, so it is a separate decision on separate evidence.

Consequences for the tickets:
- **06 CLOSED** as "pricing run twice, battery not run per ruling". Its harness (`scratchpad/v13ab/`) stays for the read-once spec's measurement.
- **02 ready-for-agent.** Where ticket text predates the spec's restatements, the SPEC governs: the deciding rule is the three-step PRECEDENCE (CORRECT > VERIFY > USE), not "one sentence"; the endpoint rule does NOT dissolve the `''` machinery (WITHDRAWN above; ruling 3 makes `''` legacy-only, never newly created — already enforced by E6).
- **03 blocked by 02**, additive and reversible as written.
- **05 splits.** 05a — the READ-SIDE remap the migration needs before any reader switches: milestone election's frozen weight tables and tier 4 ("indexed by") re-keyed onto three classes + the bit, out-degree as the ranking proxy per T2306, no threshold TUNING; blocked by 03. 05b — convergence rebuilt on the unsparsified graph's shape; blocked by 04, deferred with it.
- Two experiment findings carried, not acted on: ruling 2 (one row per pair) is enforced by nothing — row identity includes the lane sides, every arm honoured it by teaching alone; ruling 3's predicted lane-side refusal growth did not appear (0 in all arms).
- Rollback stays a read-side switch: rows keep their old word until a later release retires the column.

## RULING 6, 2026-09-02 (user, S15069/T2421): the election becomes a heuristic score; 05a/05b close

Milestone election no longer has tiers fed by `indexes`: a node scores on out-degree, edge class, recency and type weights (one weight table, a named tuning knob). Ticket 05a's parameter table and measurement are superseded — the interim `relation` word fill is deleted and readers key on `relation_class`; ticket 05b (convergence from shape) dissolves. Specified in `.scratch/main-agent-edges/spec.md` D2.
