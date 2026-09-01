# Liveness arm — grading key, written BEFORE any reader ran

**Provenance.** Both texts are AUTHORED BY ME, disclosed. They are a MINIMAL PAIR over the same
real lane-B material (`#map-data-extraction`, corpus windows w2/w3): identical facts, identical
anchors, identical open boundary. The ONLY difference is whether the superseded bin-editor export
route is MARKED DEAD or merely sequenced beside the work that killed it.

**Why authored and not generated.** This arm measures the READER-side effect of the supersession
marker in isolation. Two writer draws would differ in a dozen ways at once and could not isolate
it. The WRITER-side question — does the repaired teaching make a writer produce the marker — is
measured separately by the corrected-C chain's r3 lane-B output, which is generated, not authored.

**Source of truth (corpus w2, turns T93-T99; corpus w3, turns T101-T103).** The bin-editor export
route was decoded (T95) and its inputs byte-verified on the Win machine (T98, T99). It was NEVER
RUN. The SHEX format was then reverse-engineered directly (T101), which is the path that produced
mapA.json (T102). The bin-editor route is ABANDONED, not pending.

Both texts validate under HEAD's `validateImpression()` at cap 110 (lane B's real cap at w4):
unmarked 107 tokens accepted, marked 109 tokens accepted.

## Scored items, per reader

- **L1 LIVENESS ERROR (the primary measure).** Recorded when the reader presents the bin-editor
  export route as LIVE — the current path, a pending step, an open item, work still to be run, or
  the thing standing between the lane and its goal. Recorded as 1 (error) or 0 (no error).
  The prior measurement of this exact failure: 5 of 5 index readers, 0 of 5 control readers
  (`.scratch/impression-as-index/issues/01`, axis 2b).
- **L2 FRONTIER.** 1 if the reader names mapB's conversion and/or engine integration as what is
  open; 0.5 if it names one and adds a wrong one; 0 if it names the bin-editor export as open, or
  NOT ANSWERABLE.
- **L3 DELIVERY.** 1 if the reader names mapA.json + tools/ as the delivered artefact and does NOT
  claim the bin-editor export produced anything; 0 otherwise.

An **UNDER-READ** is charged separately if a reader denies something the text proves (e.g. says
odd-r adjacency is unproven, or that mapA.json does not exist).
