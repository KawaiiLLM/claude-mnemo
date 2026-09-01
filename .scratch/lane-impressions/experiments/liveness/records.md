# Liveness arm — raw records, per reader

Model: `sonnet` for every reader, each in a FRESH context that read only its own brief file.
Reader-by-reader detail lives in `readers/*.md`; this is the count table.

## v1 — a FAILED REPLICATION of the baseline defect, reported rather than discarded

`slices/unmarked.txt` (107 tok, accepted at cap 110). My first unmarked stimulus kept the
bin-editor history and joined it to the killing work with a bare semicolon.

| reader | L1 liveness error | L2 frontier | L3 delivery |
|---|---|---|---|
| U1 | 0 | 1 | 1 |
| U2 | 0 | 1 | 1 |
| U3 | 0 | 1 | 1 |
| U4 | 0 | 1 | 1 |
| **total** | **0 / 4** | 4/4 | 4/4 |

**The baseline defect did not appear, so this pair could not test the rule and was abandoned.**
Diagnosis, by comparison with the index run's offending line: my v1 text dropped
`decoded-only with nothing extracted`. Without that clause the bin-editor work reads as a
finished sub-step, and a finished sub-step is not mistaken for open work. The marked half of v1
was never run — there was no defect left for it to fix.

**This is a finding about the defect, not only about my stimulus: the liveness error is NOT caused
by merely keeping history. It needs an explicitly INCOMPLETE dead item sitting unlabelled beside
the work that killed it.**

## v2 — the stimulus rebuilt to the index run's own construction

`slices/v2-unmarked.txt` (94 tok) vs `slices/v2-marked.txt` (106 tok), both accepted at cap 120.
Minimal pair: same facts, same anchors, same open boundary, same delivery. The ONLY differences
are `; the SHEX map format was then cracked` → `— and that route is DEAD, superseded and never
run ...; the SHEX map format was cracked instead`.

The unmarked half emits HEAD's `sequence-word` warning on `then` and is ACCEPTED anyway — the
soft lint fires on exactly the construction that misleads and, by design, does not stop it.

| reader | L1 liveness error | | reader | L1 liveness error |
|---|---|---|---|---|
| N1 UNMARKED | **1** | | M1 MARKED | 0 |
| N2 UNMARKED | 0 | | M2 MARKED | 0 |
| N3 UNMARKED | **1** | | M3 MARKED | 0 |
| N4 UNMARKED | **1** | | M4 MARKED | 0 |
| N5 UNMARKED | **1** | | M5 MARKED | 0 |
| **UNMARKED total** | **4 / 5** | | **MARKED total** | **0 / 5** |

n = 5 independent readers per arm, ONE lane each — so 5 independent observations per arm, not 15.

**The three unmarked readers who did NOT commit the error still said the marker was missing**, in
the answer to the question that asks for it: N2 "the text does not mention anything superseded or
abandoned"; N3 "the text does not mention anything as superseded or no longer live — only items
still pending"; N5 the same sentence. **Every marked reader named the route dead unprompted**, and
two went further: M1 "Do not touch or resume the bin-editor route — it's dead and superseded";
M3 "it should not be picked up or continued".

The most operational unmarked failure is N4, which proposed to ACT on the dead route tomorrow:
"use the already-written export recipe to perform the first actual extraction via the bin-editor
link". N5 put the dead route's export recipe explicitly IN FORCE.

**Prior measurement this replicates:** index 5/5 vs control 0/5 on the same lane's same dead path
(`.scratch/impression-as-index/issues/01`, axis 2b). Here, 4/5 vs 0/5, in the SYNTHESIS form and
with the delivery and the frontier held constant across the pair — so the effect is the marker,
not the form and not the missing delivery the index run's refusal handback had trimmed away.

## Honest limits

- **Both texts are AUTHORED BY ME.** This arm measures the READER-side effect of the marker in
  isolation; it says nothing about whether a writer produces the marker. That is measured
  separately, and worse — see the corrected-C chain's r3 lane-B result.
- **One lane.** The dead path is `#map-data-extraction`'s bin-editor route. The rule is not
  measured on any other shape of supersession.
- **The v1 pair was discarded after its baseline failed to reproduce the defect.** I rebuilt the
  stimulus and re-ran. Both runs are reported; nothing was dropped.
