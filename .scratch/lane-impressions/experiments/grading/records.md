# Graded records — every reader, every lane, raw

Graded against `grading/key.md`, which was written from the source windows before any arm ran.
Lane letters: **A = `#visual-style` (CONTAMINATED CANARY — never in the headline)**,
**B = `#map-data-extraction`**, **C = `#latency-budget`**.

Reader surfaces: arm 1 and arm 2 = LINE 1 ONLY. Arm 3 = the whole stored text.
Reader briefs: `readers/arm{1,2,3}/brief.md` (axes 1–2) and `.../depth-brief.md` (axis 3).
Writer model: `sonnet` (production's `DEFAULT_NOTE_SETTLEMENT_MODEL` is `claude-sonnet-5`).
Reader model: `sonnet`, all fifteen.

**Preservation note.** Reader outputs are recorded here as graded judgments plus verbatim quotes
for every scored item that could be argued about (all over-reads, all refusals, all under-reads,
every Q2/Q4 verdict). Full agent transcripts are not copied in; the quotes below are the evidence
the grades rest on.

---

## The texts under test

| arm | lane | stored | lines | SURFACE SHOWN TO READER |
|---|---|---|---|---|
| 1 | A | 314 tok | 5 | line 1 = 98 tok |
| 1 | B | 106 tok | 2 | line 1 = 73 tok |
| 1 | C | 95 tok | 3 | line 1 = 46 tok |
| 2 | A | 351 tok | 5 | line 1 = 142 tok |
| 2 | B | 110 tok | 1 | line 1 = 110 tok |
| 2 | C | 84 tok | 1 | line 1 = 84 tok |
| 3 | A | 145 tok | 1 | whole = 145 tok |
| 3 | B | 141 tok | 1 | whole = 141 tok |
| 3 | C | 135 tok | 1 | whole = 135 tok |

**Surface budget totals: arm 1 = 217 tok, arm 2 = 336 tok, arm 3 = 421 tok.**
Read every axis-1 and axis-2 number below against that row. The arms do not show equal amounts of
text, and arm 3 shows nearly twice arm 1.

---

## AXIS 1 — Frontier coverage (1 = answered correctly, 0.5 = partial, 0 = NOT ANSWERABLE or wrong)

Three readers per arm. `NA` marks an honest "NOT ANSWERABLE"; `X` marks a wrong answer. Both score 0.

### Arm 1

| lane | reader | Q1 identity | Q2 law | Q3 state | Q4 frontier |
|---|---|---|---|---|---|
| A (canary) | 1 | 1 | 1 | **0 — X** | **0 — NA** |
| A | 2 | 1 | 1 | 1 | **0 — NA** |
| A | 3 | 1 | 1 | 1 | **0 — NA** |
| B | 1 | 1 | 1 | 1 | **0 — NA** |
| B | 2 | 1 | 1 | 1 | **0 — NA** |
| B | 3 | 1 | 1 | 1 | **0 — NA** |
| C | 1 | 1 | 1 | 1 | **0 — NA** |
| C | 2 | 1 | 1 | 1 | **0 — NA** |
| C | 3 | 1 | 1 | 1 | **0 — NA** |

Headline (B+C): Q1 6/6, Q2 6/6, Q3 6/6, **Q4 0/6**. Canary A: 3/3, 3/3, 2/3, **0/3**.

Nine out of nine Q4 answers were the honest refusal, not a guess. Verbatim, arm-1 reader 2 on
lane A: *"FRONTIER: NOT ANSWERABLE FROM THIS TEXT."* Reader 1 on lane B: *"NOT ANSWERABLE FROM
THIS TEXT (no open item is named)."* Reader 3 on lane C: *"NOT ANSWERABLE FROM THIS TEXT (only
capture's status relative to its leg is given)."*

Arm-1 lane A Q3 wrong answer, reader 1 verbatim: *"Delivered/proven: … officer stats and portraits
sourced from the 萌战 package"* — that is N-A4, a sourcing ruling with nothing built.

### Arm 2

| lane | reader | Q1 | Q2 | Q3 | Q4 |
|---|---|---|---|---|---|
| A (canary) | 1 | 1 | 1 | 1 | 1 |
| A | 2 | 1 | 1 | 1 | 1 |
| A | 3 | 1 | 1 | 1 | 1 |
| B | 1 | 1 | 1 | 1 | 1 |
| B | 2 | 1 | 1 | 1 | 1 |
| B | 3 | 1 | 1 | 1 | 1 |
| C | 1 | 1 | **0.5** | 1 | 1 |
| C | 2 | 1 | **0.5** | 1 | 1 |
| C | 3 | 1 | **0.5** | 1 | 1 |

Headline (B+C): Q1 6/6, **Q2 4.5/6**, Q3 6/6, Q4 6/6. Canary A: 3/3 on all four.

The lane-C Q2 half-scores are the trim from refusal 1. All three readers gave the split and
stopped; none named the never-grow rule, because the text no longer contains it. Verbatim,
reader 2: *"CURRENT LAW — The 120ms budget splits as capture 25ms/transform 60ms/playback 35ms
(T41)."* Compare arm 1, whose line 1 kept it and whose readers all recovered it.

### Arm 3

| lane | reader | Q1 | Q2 | Q3 | Q4 |
|---|---|---|---|---|---|
| A (canary) | 1 | 1 | 1 | 1 | 1 |
| A | 2 | 1 | 1 | 1 | 1 |
| A | 3 | 1 | 1 | 1 | 1 |
| B | 1 | 1 | 1 | 1 | 1 |
| B | 2 | 1 | 1 | 1 | 1 |
| B | 3 | 1 | 1 | 1 | 1 |
| C | 1 | 1 | 1 | 1 | 1 |
| C | 2 | **0.5** | 1 | 1 | 1 |
| C | 3 | 1 | 1 | 1 | 1 |

Headline (B+C): **Q1 5.5/6**, Q2 6/6, Q3 6/6, Q4 6/6. Canary A: 3/3 on all four.

The lane-C Q1 half-score is reader variance, not an arm effect: arm-3 reader 2 wrote
*"IDENTITY — NOT ANSWERABLE FROM THIS TEXT — the text discusses a 120ms capture/transform/playback
pipeline's timing but never names what the pipeline is for"* while heading the same section
*"LANE C — the 120ms end-to-end latency lane"*. Arm 2's lane C text also names no domain and its
readers answered anyway. Half credit, and it should not be read as a signal.

Counter-note in the same direction: arm-3 reader 1 called lane C *"an end-to-end audio pipeline"*.
No arm's text says audio. That is a reader-supplied embellishment, and it appears in arm 3 only
because arm-3 readers saw more text to build on.

### Frontier COMPONENTS actually named by the surface text (arm-level, not reader-level)

Q4 above scores "named the frontier, or a component of it". This finer count says how much of it.

| lane | components in the key | arm 1 | arm 2 | arm 3 |
|---|---|---|---|---|
| A | preview-only / client integration / combat rule | **0/3** | 3/3 | 3/3 |
| B | mapB unconverted / elevation not integrated & no combat meaning | **0/2** | **2/2** | **1/2** |
| C | prototype unwired & unowned / memory cost unmeasured / playback deferred | **0/3** | **2/3** | **3/3** |

Arm 3's lane B drops the elevation frontier entirely; its readers still answered Q4 correctly
because they had lane A in front of them, which names it. See the cross-lane-rescue caveat below.

---

## AXIS 2 — State precision (over-reads: items believed finished that the key puts in NOT-DELIVERED)

Raw count per reader per lane, from the free-form "what do you now believe is finished?" answer.

| lane | arm 1 R1 / R2 / R3 | arm 2 R1 / R2 / R3 | arm 3 R1 / R2 / R3 |
|---|---|---|---|
| A (canary) | **2** / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| B | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| C | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| **headline (B+C)** | **0** | **0** | **0** |

**The headline lanes produce a flat zero in all three arms. Axis 2 does not separate them.**

The only over-reads in the whole experiment are arm-1 reader 1 on the canary lane, verbatim:

> *"Officer stats and portraits from the 萌战 package — believed integrated/done."* (N-A4)
> *"The 2:1 isometric diagonal-brick diamond tile scheme, laid out on odd-r hex adjacency, over the
> CC BY 4.0 scrabbling pack — believed done (established, in use)."* (N-A5, a licence clearance)

Both are the diagnosed mechanism: unlabelled list members beside `committed` and `is fixed`.

The other two arm-1 readers did NOT take the bait, and both said why — reader 2:
> *"I do NOT believe the CC BY 4.0 scrabling pack or the 萌战 officer stats/portraits are confirmed
> integrated — the text only says tiles sit 'over' the pack and stats/portraits are sourced 'from'
> the package, which reads as provenance, not confirmed shipped integration. I am flagging this
> distinction rather than assuming completion."

That is a reader being careful, not the text being clear. **1 of 3 readers absorbed the false
belief. The defect is real and reproducible but not deterministic** — a fact the original
acceptance gate (which read 3 of 3 lanes as failing) did not have.

### Under-reads (a genuinely delivered item explicitly disclaimed) — charged separately

| lane | arm 1 | arm 2 | arm 3 |
|---|---|---|---|
| C | 0 | **1** | 0 |

Arm-2 reader 3, verbatim: *"I believe the capture stage of the pipeline is committed and done
(T44) — implemented and merged, meeting its 25ms allocation is implied but not separately
confirmed by the text (the text only says 'committed', not 'verified within budget')."*
D-C2 was proven (p50 9ms / p99 18ms over 10k key-downs). The word `in-budget` was deleted in
refusal 1's trim. Traceable, single-token cause.

---

## AXIS 3 — Depth loss, over the FULL stored text (2 readers per arm)

Two sub-scores. **TEXT** = does the arm's full stored text contain the item at all (graded by me
against the key). **RECOVERED** = did the depth readers actually name it.

### Causal-model items (5)

| item | arm 1 | arm 2 | arm 3 |
|---|---|---|---|
| A · L-A2 top-down is axis-aligned gridlines, NOT 2:1 foreshortening | ✅ | ✅ | ❌ |
| B · L-B1 direct decoding superseded the Windows-only reader (a spent source) | ✅ | ❌ | ❌ |
| B · L-B2 mapA first because mapB is mirror-defective | ✅ | ✅ | ✅ |
| C · L-C4 transform's cost is the resampler, not the FFT | ✅ | ✅ | ✅ |
| C · L-C3 a total was ruled instead of per-leg budgets, and why | ❌ | ❌ | ❌ |
| **TEXT total** | **4/5** | **3/5** | **2/5** |

L-C3 is absent in every arm — a shared blind spot in the corpus treatment, not an arm effect.

### Binding items (8)

| item | arm 1 | arm 2 | arm 3 |
|---|---|---|---|
| A · L-A3 visible stagger mandatory or the asset is void | ✅ | ❌ | ❌ |
| A · L-A4 collage tile form locked, native regen unscheduled | ✅ | ❌ | ❌ |
| A · whole road tiles, never the procedural stripe | ✅ | ✅ | ✅ |
| B · L-B3 odd-r adjacency locked by the 42/42 proof | ✅ | ✅ | ✅ |
| B · L-B2 mapA is the map of record | ✅ | ✅ | ✅ |
| C · L-C1 the ruled 25/60/35 split | ✅ | ✅ | ✅ |
| C · L-C2 legs trade, the total never grows | ✅ | ❌ | ✅ |
| C · N-C4 playback deferred, NOT accepted | ✅ | ✅ | ✅ |
| **TEXT total** | **8/8** | **5/8** | **6/8** |

### What the depth readers actually RECOVERED

**Arm 1 (2 readers).** Recovered every causal item present, both readers, including the full
lane-A three-correction chain and lane-B's "decoding beat the Windows-only reader, a spent source".
Bindings: lane A 3/3 both readers; lane C 1/3-ish (both named the never-grow rule, neither framed
playback-deferred as a binding). **Lane B bindings: 0/2, BOTH readers**, verbatim:
> *"NOT ANSWERABLE FROM THIS TEXT — the text states facts and a causal law … but contains no
> locked/forbidding rule of the kind Lane A explicitly states."*

The odd-r proof IS in arm 1's lane-B line 1 — written as *"42/42 city flowers **confirming** odd-r
adjacency"*. Arms 2 and 3 wrote *"odd-r hex adjacency **locked** by a 42/42-city proof"* and both
of their readers recognised it as a binding immediately. **One verb — `confirming` vs `locked` —
decided whether a binding survived reading.** This is a bigger effect than the tier question and
it is orthogonal to it.

**Arm 2 (2 readers).** Lane A: the gridline law recovered by both. Lane A bindings recovered 1/3 —
stagger-mandatory and collage-locked are gone from the text. Both readers over-generated to fill
the gap, listing "ticket 004 acceptance-verified" and "viewport/blur fixes" as *bindings*, which
they are not. Lane C: one reader inferred the never-grow rule that the text no longer states
(*"forbids reallocating the budget across stages without new ruling"*) — a correct guess with no
textual support; the other explicitly flagged the hole: *"not clear if 25ms itself is locked or
just the committed code."*

**Arm 3 (2 readers).** Lane A is the bill. Neither reader recovered the gridline law, because it
is not there. Asked for the causal model they returned the aesthetic verdict instead — verbatim:
> *"Road-cell rendering switched to whole tiles because the alternative … was explicitly ruled ugly
> by the user; that aesthetic ruling, not a technical failure, drove the retile."*

That is true and it is the wrong altitude: the lane's durable law — *the top-down misread is
geometry, not style* — is the one claim that would stop a successor from re-litigating the
projection, and a 150-token lane-A impression cannot afford it. Both readers also flagged the
viewport/blur fixes as *"not framed as a ruling"* and returned only 1/3 bindings.

Lane B: both recovered mapA-because-mirror-defective and odd-r-locked-by-proof (2/2 bindings),
neither the Windows-reader supersession — the entire T95–T99 history is gone from arm 3.

Lane C is arm 3's win and it must be reported as such. **Both readers recovered every causal and
binding item, including the two no other arm's readers got cleanly:**
> *"The 120ms/25/60/35 budget split is locked as a ruling — legs may not be reallocated based on
> measurement alone; only a new ruling changes it."*
> *"Playback's 35ms is explicitly 'deferred not accepted' — this is a locked non-status: it must
> not be treated as validated or closed."*

Arm 3's lane C is the single best depth text in the experiment. Its cap went from 100 to 150.

---

## The canary — did writers copy the golden sample?

Yes, in every arm, and they copied whichever construction the sample used.

| arm | lane-A text at r3/r4 | golden sample it was imitating |
|---|---|---|
| 1 | `officer stats and portraits from the 萌战 package (T133)` — inside a list with `committed` | the shipped sample's exact words, exact position |
| 2 (r3) | `officer portraits are a ruled SOURCE, 萌战 package, not yet extracted (T133)` | arm 2's rewritten sample: `officer stats and portraits are a ruled SOURCE — the 萌战 package, extraction not built` |
| 3 (r3) | `officer portraits from 萌战 (S18993/T133)` — unlabelled, beside `locked` and `verified` | arm 3's sample = the shipped defective line 1, unchanged |

Arm 2's writer imitated the repaired construction almost word for word. Arm 3's writer, given the
unrepaired sample, reproduced the unlabelled-sibling construction. **This is direct evidence for
the ticket's premise that rewriting the sample is not optional — the sample is the effective
teaching.** By r4 both arms had dropped the clause entirely (T133 was overridden that window), so
the canary only reads at r3.

One unprompted arm-3 writer observation, verbatim from its final report:
> *"teaching.txt's golden `#visual-style` sample uses the same SAN11/T133/T149 identifiers as this
> task and says 'the look is locked and shipped through ticket 004' … both of which contradict this
> task's actual current state (T149 says 'commit staged not landed', and T133 is this-window-
> overridden). I treated the golden sample as a form/density template only, not as factual content."*

A writer had to actively defend against the sample. That is a cost the sample should not impose.

---

## Threats to validity — read these before using any number above

1. **n is 3 texts per arm, not 9.** Three readers over three lanes is nine observations of THREE
   texts. Readers are independent draws; the texts are not. Every axis-1/axis-2 cell above is
   ultimately one writer draw per lane per arm.
2. **Arm 1's writer model is unrecorded.** Its artifacts preserve briefs and outputs, no model.
   Arms 2 and 3 both used `sonnet`. The arm-2-vs-arm-3 contrast is clean; anything involving arm 1
   carries an unmeasured model confound.
3. **Arm 3 changes the cap as well as the structure.** Flat 150 replaces `clamp(10×members,100,500)`,
   so lane A went 370→150 (−60%) while lanes B and C went 110→150 and 100→150 (+36%, +50%). Arm 3
   is *starved* on the fat lane and *enriched* on the thin ones, and its results split exactly that
   way. This is not a nuisance confound; it is most of arm 3's effect.
4. **Surface budget is unequal: 217 / 336 / 421 tokens.** Arms that show more text score better on
   coverage. That alone predicts the axis-1 ordering.
5. **Cross-lane rescue.** Each reader saw all three lanes at once. Arm 3's lane B omits the
   elevation frontier, but its lane A names it, so readers answered lane B's Q4 correctly from
   neighbouring text. A single-lane surface would score arm 3's lane B lower.
6. **Lane order was fixed A/B/C for every reader**, matching arm 1's preserved brief. Order effects
   are constant across arms, so contrasts are unaffected; absolute values may not be.
7. **Rounds are a chain.** r3 and r4 writers saw their own arm's previous output. A weak r2 in one
   arm propagates. This is faithful to production and it correlates rounds within an arm.
