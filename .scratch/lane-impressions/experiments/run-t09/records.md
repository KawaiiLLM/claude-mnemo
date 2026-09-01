# Corrected-C re-run under ticket 09's REPAIRED teaching — raw records

**Provenance.** `run-t09/teaching.txt` is `renderImpressionTeaching()` rendered from HEAD AFTER the
repair, byte-for-byte, and handed to each writer as its whole law. The validator is
`validateImpression()` imported unmodified from HEAD (`../validate.ts`). Caps are
`clamp(10 × settledMembers, 100, 500)` on the cumulative settled membership at each window — the
same numbers ticket 06 and ticket 08 used, so the arms are comparable. Corpus, windows, lanes,
briefs and the chained-prior protocol are ticket 08 arm 2's, reused unchanged except for the
teaching path and the priors (which are this run's own r2/r3 outputs, as the chain requires).
Writers ran on `sonnet` (production's `DEFAULT_NOTE_SETTLEMENT_MODEL` is `claude-sonnet-5`), a
FRESH agent per round, never shown another round's brief or another arm.

## Every validator verdict, every refusal

| round | lane | cap | verdict | tokens |
|---|---|---|---|---|
| r2 | A `#visual-style` | 100 | accepted 1st pass | 86 |
| r2 | B `#map-data-extraction` | 100 | accepted 1st pass | 72 |
| r3 | A | 280 | accepted 1st pass | 268 (4 lines) |
| r3 | B | 100 | accepted 1st pass | 73 |
| r4 | A | 370 | **REFUSED** `line-1-cap` 162>150, `line-cap` L5 65>60, `total-cap` 382>370 → compress-only regeneration accepted | 323 (5 lines) |
| r4 | B | 110 | **REFUSED** `line-1-cap` 113>110, `total-cap` 113>110 → compress-only regeneration accepted | 92 |
| delivery | C `#latency-budget` | 100 | **REFUSED** `line-1-cap` 101>100, `total-cap` 101>100 → compress-only regeneration accepted | 93 |

7 lane-writes, 3 refused. **Every refusal was a SIZE refusal, again.** `delivery-anchor`,
`anchor-format`, `anchor-unresolvable`, `structure` and `line-count` never fired, and no
`sequence-word` warning was emitted on any accepted text. That is the third consecutive experiment
in which the deterministic tier caught no state defect — which is what its own header promises.

**A cost the repair does charge, measured:** r4 lane A's first draft put 162 tokens in line 1
against the 150 cap. Four duties plus two supersession markers is more than the shipped
three-duty line 1 was carrying, and the refusal is the visible price. The regeneration paid it by
dropping the render-fix clause and one supersession marker from line 1, not by dropping a duty.

**The cap-pressure trim reproduced ticket 08's finding exactly.** Lane C's refusal (101 vs 100)
shed `in-budget` — the same state qualifier arm 2's identical 101-vs-100 refusal shed. Under cap
pressure the writer sheds the clause carrying no proper noun. Neither this run's lane C nor arm
2's carries T41's `legs trade, the total never grows` clause.

## THE GATE — the line-1-only reader arm. 3 blind readers, RAW, per reader per lane.

Each reader was a fresh `sonnet` agent shown ONLY the three line 1s (`readers/t09/brief.md`, the
arm-2 reader brief with the three texts swapped), with an explicit "NOT ANSWERABLE FROM THIS TEXT"
escape so it would not guess.

| | R1 A | R1 B | R1 C | R2 A | R2 B | R2 C | R3 A | R3 B | R3 C |
|---|---|---|---|---|---|---|---|---|---|
| Q1 identity | 1 | 1 | 1 | 1 | 1 | **0 — "NOT ANSWERABLE"** | 1 | 1 | 1 |
| Q2 current law | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 |
| Q3 state | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 |
| **Q4 frontier** | **1** | **1** | **1** | **1** | **1** | **1** | **1** | **1** | **1** |

**Q4 FRONTIER: 9 / 9. Zero abstentions. Ticket 06's same arm on the same three lanes scored
0 / 3, six honest abstentions. The gate's line-1-only arm PASSES.**

n, stated honestly: **3 independent readers**, each answering about 3 lanes — 9 observations, but
only 3 of them independent. This is not n=9.

Verbatim frontier answers, one per reader per lane, since the gate is about this question:
- R1 A "Client integration, combat rules, and portrait extraction are named as open."
  B "Converting mapB, and elevation-combat integration, remain open."
  C "The transform-cost fix (T57) is unwired; playback's 35ms budget is unresolved."
- R2 A "Client integration, combat rules, and portrait extraction (T133) all remain open."
  B "Converting mapB, and elevation-combat integration, remain open."
  C "Wiring in the transform fix (currently /tmp-only), and resolving playback's budget."
- R3 A "Client integration of elevation, combat rules, and portrait extraction remain open."
  B "Converting mapB, and elevation-combat integration, remain open."
  C "The transform-cost fix (T57) is unwired; playback's 35ms budget is unresolved."

R2's lane-C identity miss is the SAME one ticket 06 and ticket 08 both recorded on this lane
("partial — domain unknown"): the delivery-lane text names no product. It is a property of the
corpus lane, not of the repair.

## State precision — over-reads and under-reads, raw

| lane | R1 | R2 | R3 |
|---|---|---|---|
| A over-reads | 0 | 0 | 0 |
| B over-reads | 0 | 0 | 0 |
| C over-reads | 0 | 0 | 0 |

**0 over-reads on 9 reader-lane observations.** Every reader held the three traps unprompted:
ticket 004's commit is "staged, not landed"; the hillshade is "an offline preview, not integrated";
the 21ms resampler is "/tmp-only and unwired". R1, verbatim: *"Ticket-004: I believe it is
verified, but I do NOT believe it is landed."*

**One UNDER-READ, charged: R2 on lane C** — *"I don't believe the original three-way split is
currently operative in practice, only that it was the original locked target."* The 25/60/35 split
IS in force (T41 is a ruling, and T51 overturned only its FFT-cost assumption). The text's own
`T41's FFT-cost assumption is dead, superseded by T51` supplied the doubt. This is the
supersession rule's own cost, and it is the honest one to name: marking a dead assumption inside a
still-live ruling can make the ruling read as shaken. 1 under-read in 9 observations. Arm 2's
lane C also produced exactly 1 under-read, from a different cause.

## The full-impression state audit, against the source windows

I checked every claim in the three final impressions against its anchors' own window text
(`corpus/w3.txt`, `corpus/w4.txt`, `run-arm1/delivery/window.txt`).

**Zero inflations.** Notably: `commit staged not landed` matches T149 exactly ("commit set
staged"); `committed (T168)` matches T168 ("Committed a32588c"); `only an offline hillshade
preview (T199)` matches T199 ("rendered offline and shown"); `/tmp-only, unwired (T57)` matches
T57 ("NOTHING IS WIRED IN"); `deferred, not accepted (T60)` matches T60 verbatim.
`(T133, killed by T160)` matches w4's own edge `T160 --override--> T133`.
`overturning T197's invented-data verdict` matches `T198 --override--> T197`.

One ANCHOR-PRECISION note, not a state error: lane B anchors `mapA.json plus converter tools` to
T102, where the pre-written key (`grading/key.md` D-B3) puts the delivery at T103. Both anchors are
on the line and both resolve; the claim's STATE is right.

This audit is mine, over a synthetic corpus. **It is not the state-inflation gate**, which needs a
live settlement run over a real segment and did not run — see the ticket report.

## Contamination, disclosed

**Lane A `#visual-style` is CONTAMINATED and is not the headline.** The rewritten golden sample is
built from this lane, so lane A's writer was shown a correct answer for the lane it was asked to
write — and it copied the construction: `superseding the 3/4 top-down pick (S18993/T105 overrides
T89)` is the sample's clause almost word for word. That is the canary firing again, in the repaired
direction this time, and it is evidence about IMITATION, not about the rule's transfer.

**Lanes B and C are uncontaminated and carry the headline.** No golden sample touches
`#map-data-extraction` or `#latency-budget`. Both scored 3/3 on Q4 frontier across three readers,
and both hold their open boundary in line 1 without any sample to copy from.

## The supersession rule on the WRITER side — a NEGATIVE result, reported as one

The rule's reader-side effect is large and replicated (`liveness/records.md`, 4/5 → 0/5). Its
writer-side effect on the uncontaminated lane is **NOT demonstrated.**

At r3, lane B's stored prior was entirely about the bin-editor export route, and w3 kills that
route by cracking SHEX directly. Under the repaired teaching the writer **deleted the history**
rather than marking it dead — its own report calls the old boundary "resolved and surpassed this
window", not superseded. That is the deletion branch, which the rule explicitly permits as "omit it
as a deliberate judgment", and it is exactly what arm 2's writer did WITHOUT the rule. The r4 lane
B text likewise carries no dead path.

The only writer-produced supersession markers in this run are on lane A — the contaminated lane,
where the sample supplied them.

**Stated plainly: on this corpus the SUPERSESSION rule changed what a reader does with a marked
text, and did not change whether an uncontaminated writer produces one.** One lane, one draw. The
cheapest experiment that would settle it is a corpus whose dead path is load-bearing enough that
deletion is visibly wrong — this corpus's dead path is cheap to drop.
