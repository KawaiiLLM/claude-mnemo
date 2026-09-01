# Raw grading records — every reader, every lane, with the quotations each grade rests on

Key: `.scratch/lane-impressions/experiments/grading/key.md` (lanes A/B/C, written before any arm
ran, reused unchanged) plus `key-addendum.md` (lane D and the IN-FORCE axis).

Lane labels shown to readers were LANE 1/2/3 to strip meaning from letters:

| shown | key lane | tag | contaminated? |
|---|---|---|---|
| LANE 1 | B | `#map-data-extraction` | no |
| LANE 2 | C | `#latency-budget` | no |
| LANE 3 | D | `#wire-format` | no (authored for this run) |

`#visual-style` (key lane A) is the contaminated canary and was **never shown to a reader**; it is
graded only as a copying canary, at the end of this file.

Readers: `sonnet`, zero tools, one shot, no shared context. Writers: `sonnet`.

- **INDEX full-text readers R1–R5** — the whole stored index for each lane.
- **CONTROL full-text readers C1–C5** — the whole stored synthesis impression for each lane.
- **INDEX surface readers S1–S3** — the NEWEST 3 LINES only.
- **CONTROL surface readers CS1–CS3** — LINE 1 only (the synthesis form's own fixed-size surface).

**n, honestly.** 5 full readers × 3 lanes per arm = 15 reader-lane observations per arm, but only
**ONE writer draw per lane per arm** in the graded set. A second independent writer draw exists for
index lanes B, C, D and control lane D and is reported at the end as a form-stability check; it was
NOT reader-graded. Reader observations within an arm are not independent of the writer draw they
share.

---

## The graded texts

**INDEX, LANE 1 (B)** — `run-index/chain1/r4/map-data-extraction.txt`, 2 lines, 96/110 tok:
```
S18993/T198..T199: 4793.K3ST cracked as mapA's height field, alignment cross-correlated to the map grid (r=0.668), confirmed by an offline hillshade
S18993/T93..T103: bin-editor link decoded and export recipe written, decoded-only with nothing extracted; SHEX map format then cracked, mapA picked over mirrored mapB, odd-r hex adjacency locked 42/42 vs 0
```

**CONTROL, LANE 1 (B)** — `lane-impressions/.../run-arm2/r4/map-data-extraction.txt`, 1 line:
```
SAN11 map-data-extraction lane: pkres.bin's SHEX format is reverse-engineered, revealing mapB, a second embedded map (S18993/T101); mapA is picked over mirror-defective mapB, converted to mapA.json + tools/ (T102), odd-r hex adjacency locked by a 42/42-city proof (T103); 4793.K3ST decoded as mapA's elevation (T198) — mapB's conversion, engine integration, elevation-combat rule stay open (T199).
```

**INDEX, LANE 2 (C)** — `run-index/chain1/delivery/latency-budget.txt`, 4 lines, 97/100 tok:
```
#latency-budget
S22040/T60: playback's 35ms deferred, unruled, from T41
S22040/T51..T57: transform cost is the resampler not the FFT; prototype cuts 74ms to 21ms, /tmp only, unwired
S22040/T41..T44: 120ms ruled 25/60/35ms, legs borrow only by new ruling, never the total; capture leg shipped
```
**Line 1 is a defect and it is MY sample's fault.** The teaching's samples print the lane tag above
the sample lines (`#visual-style`), exactly as the control teaching does; this writer copied the
tag INTO the stored text. The control's writers never did. The validator accepted it. It costs the
index one surface slot on this lane and that contaminates the lane-C surface result — see the
caveat in axis 3.

**CONTROL, LANE 2 (C)** — `lane-impressions/.../run-arm2/delivery/latency-budget.txt`, 1 line, 84 tok.

**INDEX, LANE 3 (D)** — `run-index/chain1/laned/wire-format.txt`, 6 lines, 196/200 tok.
**CONTROL, LANE 3 (D)** — `run-index/control-laned/d1/wire-format.txt`, 2 lines, 178/200 tok.

---

## AXIS 1 — Coverage. Per reader, per lane, raw.

Score 1 / 0.5 / 0. `NA` = honest "NOT ANSWERABLE FROM THIS TEXT"; both NA and a wrong answer score
0, recorded separately.

### Q1 IDENTITY

| | R1 | R2 | R3 | R4 | R5 | INDEX | C1 | C2 | C3 | C4 | C5 | CONTROL |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B | 1 | 1 | 1 | 1 | 1 | **5/5** | 1 | 1 | 1 | 1 | 1 | **5/5** |
| C | 1 | 1 | 1 | 1 | 1 | **5/5** | 1 | 1 | 1 | 1 | 1 | **5/5** |
| D | 1 | 1 | 1 | 1 | 1 | **5/5** | 1 | 1 | 1 | 1 | 1 | **5/5** |

**A separation the score does not show, recorded because it is real.** No index reader could name
the PRODUCT on lane B; every control reader could. Index R2: *"Reverse-engineering effort on a
map/game file format."* Control C2: *"Reverse-engineering `pkres.bin`'s SHEX format to extract
embedded map data"* for **SAN11**, named by 5/5. Cause: refusal 2's merge deleted the lane's own
name. Scored 1 for both because the key's bar is the activity; flagged here because a successor
who cannot name the product cannot find the code.

### Q2 GOVERNING LAW

| | R1 | R2 | R3 | R4 | R5 | INDEX | C1 | C2 | C3 | C4 | C5 | CONTROL |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B | 1 | 1 | 1 | 1 | 1 | **5/5** | 1 | 1 | 1 | 1 | 1 | **5/5** |
| C | 1 | 1 | 1 | 1 | 1 | **5/5** | 0.5 | 0.5 | 0.5 | 0.5 | 0.5 | **2.5/5** |
| D | 1 | 1 | 1 | 1 | 1 | **5/5** | 1 | 1 | 1 | 1 | 1 | **5/5** |

Lane C is where the arms separate on this axis, and it separates completely and in the index's
favour. The key requires **L-C1 AND L-C2** — the split *and* the never-grow rule.

- INDEX R2: *"T41–44 ruled a 120ms total split 25/60/35ms, with the rule 'legs borrow only by new
  ruling, never the total'."* — 1. R1, R3, R4, R5 all name the same clause.
- CONTROL C1: *"The budget split is capture 25ms / transform 60ms / playback 35ms (S22040/T41)."*
  — the split alone, 0.5. C2–C5 identical in substance.

**This is not a form effect; it is the prior run's refusal wound, re-measured.** The control's lane
C text lost `— legs reallocate only via new ruling` to a 101-vs-100-token trim in the prior
ablation. The index writer fit the same law in 97 of 100 tokens without being refused. Same cap,
different luck of the draw as much as different form.

### Q3 CURRENT STATE

| | R1 | R2 | R3 | R4 | R5 | INDEX | C1 | C2 | C3 | C4 | C5 | CONTROL |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B | 1 | 1 | 1 | 1 | 1 | **5/5** | 1 | 1 | 1 | 1 | 1 | **5/5** |
| C | 1 | 1 | 1 | 1 | 1 | **5/5** | 1 | 1 | 1 | 1 | 1 | **5/5** |
| D | 1 | 1 | 1 | 1 | 1 | **5/5** | 1 | 1 | 1 | 1 | 1 | **5/5** |

Does not separate. Every reader in both arms separated ≥1 delivered from ≥1 undelivered item
without error.

### Q4 FRONTIER

| | R1 | R2 | R3 | R4 | R5 | INDEX | C1 | C2 | C3 | C4 | C5 | CONTROL |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B | **0** | **0** | **0** | **0** | **0** | **0/5** | 1 | 1 | 1 | 1 | 1 | **5/5** |
| C | 1 | 1 | 1 | 1 | 1 | **5/5** | 1 | 1 | 1 | 1 | 1 | **5/5** |
| D | 1 | 1 | 1 | 1 | 1 | **5/5** | 1 | 1 | 1 | 1 | 1 | **5/5** |

**Lane B, index: 0 of 5, and none of them was an honest refusal — all five gave the same WRONG
frontier.** The key's F-B is *"K3ST elevation is decoded and previewable but not integrated and has
no gameplay meaning; mapB is still unconverted."* The index text names neither. What five readers
said instead:

- R1: *"Actually extracting data via the bin-editor's decoded link/export recipe is still
  outstanding (explicitly 'nothing extracted'). No other open item is named."*
- R2: *"The one explicitly open item is extraction itself — the export recipe exists but has not
  been run/used to extract anything."*
- R3: *"The only explicitly open item is extraction itself ... Beyond that: NOT ANSWERABLE."*
- R4: *"the one open item the text states: actually running extraction via the written recipe
  hasn't happened."*
- R5: *"导出/提取环节是开放项——recipe 已写好但从未执行。"*

Per key item **N-B6**, the bin-editor export was **abandoned, not pending**; direct SHEX decoding
superseded it. All five readers took a dead path for the live frontier. Control readers, whose text
does not mention the bin editor at all, said instead: C3, *"mapB's conversion, engine integration,
and the elevation-combat rule (all T199, open)."*

**Axis-1 totals over the three headline lanes (15 reader-lane observations per arm per question):**

| | INDEX | CONTROL |
|---|---|---|
| Q1 identity | 15/15 | 15/15 |
| Q2 governing law | **15/15** | 12.5/15 |
| Q3 current state | 15/15 | 15/15 |
| Q4 frontier | 10/15 | **15/15** |
| **total** | **55/60** | **57.5/60** |

The arms trade one complete lane-level failure each, in opposite places, and finish 2.5 points
apart on 60. **Axis 1 does not separate the forms.**

---

## AXIS 2 — State precision. Over-reads, raw, per reader.

From PART 2's free-form *"what do you now believe is finished, shipped, integrated, committed, or
working in production?"*

| lane | INDEX R1/R2/R3/R4/R5 | CONTROL C1/C2/C3/C4/C5 |
|---|---|---|
| B | 0 / 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 / 0 |
| C | 0 / 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 / 0 |
| D | 0 / 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 / 0 |

**Zero over-reads anywhere, in either arm, across 30 reader-lane observations. Axis 2 does not
separate the arms, and it did not separate them in the prior ablation either.** Two runs, two flat
zeros on the uncontaminated lanes. Lane D's primary trap (N-D1, zstd not adopted) was refused by
10/10 full-text readers:

- INDEX R3: *"I do NOT believe zstd is shipped or integrated in any way ... 'nothing wired in,
  gzip remains the only accepted encoding'."*
- CONTROL C1: *"I do NOT believe zstd is adopted, shipped, or in production anywhere — it's
  explicitly 'evaluated only' with no ruling and an unchecked blocking constraint."*

**Under-reads** (a proven item explicitly disclaimed): index 0, control 0.

**Caveat that limits what this null is worth.** Lane D's source turns state the in-force fact in
their own words — T34 contains *"T12's gzip ruling is untouched and still governs"* and T44
contains *"gzip remains the only body encoding any deployed reader accepts"*. Both arms' writers
copied that disclaimer through. The trap was defused by the corpus before either form was tested.
A harder lane D would not hand the answer over.

---

## AXIS 2b — IN-FORCE rule (the new axis). Per reader, per lane.

Question asked separately from Q2: *"which rule is IN FORCE right now ... and what may NOT be
reopened or done differently without a new ruling?"* Scored against `key-addendum.md`, using the
reader's WHOLE answer (a reader who names the right rule under Q5 but treats a dead item as the
live frontier under Q4 has not got the in-force picture right).

| | R1 | R2 | R3 | R4 | R5 | INDEX | C1 | C2 | C3 | C4 | C5 | CONTROL |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B | **0** | **0** | **0** | **0** | **0** | **0/5** | 1 | 1 | 1 | 1 | 1 | **5/5** |
| C | 1 | 1 | 1 | 1 | 1 | **5/5** | 0.5 | 0.5 | 0.5 | 0.5 | 0.5 | **2.5/5** |
| D | 1 | 1 | 1 | 1 | 1 | **5/5** | 1 | 1 | 1 | 1 | 1 | **5/5** |
| **total** | | | | | | **10/15** | | | | | | **12.5/15** |

### The failure mode that actually fired — and it is not the one that was predicted

The design review predicted CURRENT-TRUTH NORMALISATION: a reader substituting "newest" for "in
force". **Zero normalisation errors were observed at full text, in either arm, on any lane.**

What fired instead is its mirror, on the index only. Call it a **LIVENESS error**: the index
preserves an old stage and never says that stage is dead, so a reader takes a superseded path for
live work.

**LIVENESS errors, raw: INDEX 5/5 readers on lane B. CONTROL 0/5.** Quotations above under Q4, plus:

- INDEX R2, Q5: *"NOT ANSWERABLE FROM THIS TEXT — the text never uses 'ruling'/'in force' language
  for this lane, nor does it flag anything as explicitly reopenable or explicitly not-in-force
  (unlike lanes 2 and 3)."*
- INDEX R5, Q5: *"未生效 / 尚待完成：实际的数据提取——recipe 存在不代表数据已到手，这一步仍需执行。"*
- INDEX R3, Q5: *"The text uses no 'ruling'/'governs' language here, so whether anything is
  formally reopenable is NOT ANSWERABLE FROM THIS TEXT."*

The mechanism is structural, not stylistic. The merged line reads
`bin-editor link decoded and export recipe written, decoded-only with nothing extracted; SHEX map
format then cracked, mapA picked over mirrored mapB` — the dead path and the path that killed it,
in one line, with **no supersession marker between them**. A stage line says what a range of turns
DID. Nothing in the form asks it to say which earlier conclusion is no longer in force. The
synthesis form was doing that for the reader, and it was doing it by DELETING the dead history —
which is exactly the depth loss the prior ablation charged against it (*"Lane B's history, gone"*).

**So the two forms fail the in-force question in exactly opposite ways: the index keeps the history
and cannot mark it dead; the synthesis marks what is live by throwing the history away.**

---

## AXIS 3 — The fixed-size surface (the spec's OPEN QUESTION 1)

INDEX surface = newest 3 lines. CONTROL surface = line 1.

**Read the caveats first.**
1. **Lane B is not a truncation test in either arm.** The index text is 2 lines and the control text
   is 1 line, so "newest 3" and "line 1" show the whole thing. Its numbers are carried for
   completeness only.
2. **Lane C's index surface is contaminated by my sample's defect.** The stray `#latency-budget`
   header ate one of three slots, so the surface lost the `T41..T44` line carrying the entire budget
   ruling AND the capture delivery. Lane C's index numbers below are a lower bound and should not
   be read as evidence about newest-first.
3. **Lane D is the only clean test of the open question**, and it was built for it: the founding
   law is the OLDEST turn and the three newest stages are ordinary maintenance plus one exploratory
   draft.

### S1 IDENTITY

| | S1 | S2 | S3 | INDEX | CS1 | CS2 | CS3 | CONTROL |
|---|---|---|---|---|---|---|---|---|
| B | 1 | 1 | 1 | 3/3 | 1 | 1 | 1 | 3/3 |
| C | 0.5 | 0.5 | 0.5 | 1.5/3 | 1 | 1 | 1 | 3/3 |
| **D** | **1** | **0.5** | **0.5** | **2/3** | 1 | 1 | 1 | **3/3** |
| total | | | | **6.5/9** | | | | **9/9** |

Lane D, the clean cell — two of three index surface readers demoted the lane from a format
DESIGN to format MAINTENANCE, because the newest three stages are maintenance:

- S2: *"Decoder/encoding-pipeline maintenance: a decoder crash fix, a histogram exporter, and
  exploratory work on migrating from gzip to zstd."*
- S3: *"Maintenance of a frame-based decoder/encoding pipeline (frame decoding, encoding scheme,
  frame-size instrumentation)."*
- against CS2: *"A wire-format spec covering frame structure and field-tag encoding for a
  serialization/schema system."*

Nobody was lost — every index surface reader named the right domain. **Identity DEGRADES under
newest-first; it does not fail.**

Lane C, index: all three readers relocated the lane to playback. S1: *"Diagnosing a playback
latency budget."* The 120ms end-to-end frame was on the line the surface cut. (Contaminated cell —
see caveat 2.)

### S2 IN-FORCE

| | S1 | S2 | S3 | INDEX | CS1 | CS2 | CS3 | CONTROL |
|---|---|---|---|---|---|---|---|---|
| B | 1 | 0 | 0 | 1/3 | 1 | 1 | 1 | 3/3 |
| C | 0 | 0 | 0 | 0/3 | 0.5 | 0.5 | 0.5 | 1.5/3 |
| **D** | **1** | **1** | **1** | **3/3** | 1 | 1 | 1 | **3/3** |
| total | | | | **4/9** | | | | **7.5/9** |

Lane D ties at 3/3 — **but the index's 3/3 does not come from the founding ruling, which the
surface never showed.** It comes from one clause the writer happened to restate inside the newest
line: `gzip remains the only accepted encoding`. Remove that restatement and the surface contains
no statement of what governs. That is a fragile 3/3 and it should be read as one.

Lane B's index losses are the liveness error again, now on the surface: S2, *"NOT in force: the
bin-editor export recipe — it's written but 'decoded-only with nothing extracted,' i.e. not yet
exercised/relied on."*

### S3 NON-REOPENABLE

| | S1 | S2 | S3 | INDEX | CS1 | CS2 | CS3 | CONTROL |
|---|---|---|---|---|---|---|---|---|
| B | 1 | 1 | 1 | 3/3 | 1 | NA→0 | NA→0 | 1/3 |
| C | NA→0 | NA→0 | NA→0 | 0/3 | NA→0 | NA→0 | NA→0 | 0/3 |
| **D** | **1** | **NA→0** | **0** | **1/3** | 1 | 1 | 1 | **3/3** |
| total | | | | **4/9** | | | | **4/9** |

Totals tie at 4/9, and the tie hides the only cell built to answer the question. **Lane D: index
1/3, control 3/3.** The index surface never shows `T12..T19`, so the founding ruling — atomic
frames, no streaming, gzip by ruling, string tags removed with no compat window — is simply not on
the surface. What the two failing readers said:

- S2: *"NOT ANSWERABLE FROM THIS TEXT. No item is stated as locked against redoing; the recurring
  'no format change' note describes what those two committed fixes did ... **and the zstd draft's
  existence suggests that question is still open, not closed.**"*
- S3: *"The two committed changes (empty-frame-as-keepalive decoder fix; histogram exporter) plus
  the explicit 'no format change' ... should not be redone differently without a new ruling"* —
  naming two maintenance commits as the lane's durable bindings.

S2's second clause is **the one normalisation error in the whole run**: the newest stage being a
zstd migration draft made a reader conclude the format question is open. It fired on the index
surface, on 1 of 3 readers, and nowhere else.

Against that, all three control surface readers, seeing only line 1:
CS3, *"The frame format (4-byte big-endian length prefix, atomic gzip body, no streaming) may not
be reopened or done differently without a new ruling, since it's stated as a locked RULING."*

**Answer to open question 1, stated plainly.** Identity survives the newest-3 cut in degraded form
(2/3 clean-cell, 6.5/9 overall, zero total failures). **Durable bindings do not survive it: 1/3
against the control's 3/3 on the only uncontaminated cell.** The founding decision is exactly what
a fixed-size newest-first surface drops, and a reader who cannot see it treats the settled question
as reopenable.

---

## The canary — did index writers copy my sample?

`#visual-style` is the lane my sample was built from. Byte-identical line counts against
`experiments/sample-visual-style.txt`:

| writer output | lines | byte-identical to a sample line |
|---|---|---|
| chain1 r3 `#visual-style` | 5 | **4** (`T132..T135`, `T117..T123`, `T103..T109`, `T82..T93`) |
| chain1 r4 `#visual-style` | 8 | **3** (`T117..T123`, `T103..T109`, `T82..T93`) |
| draw2 r4 `#visual-style` | 7 | **4** (`T159..T179`, `T117..T123`, `T103..T109`, `T82..T93`) |

The fifth r3 line is a near-paraphrase of sample line 3 (`ruled+verified` for `ruled and
verified`). **Two independent writers, from two independent r4 draws, reproduced the same four
sample lines verbatim.** The prior ablation's finding — writers copy the sample's construction, not
just its shape — reproduces here at the level of whole byte-identical lines.

Two writers had to RESIST the sample, and both did it correctly:

- chain1 r4: *"This window's own edge overrides `S18993/T133`, which the stored line `T132..T135`
  rests on ('native regen unscheduled' — now false, since this window's road-tile rebuild is
  exactly that native regen) ... Wrote 8 lines: ... the `T132..T135` line trimmed to drop only the
  overridden clause (kept the still-live officer-stats/portraits ruling)."*
- draw2 r4: *"revised the stale `T132..T135` line because this window's edge `T160 --override-->
  T133` invalidated its 'native regen unscheduled' claim."*

Both located the override, both surgically deleted only the falsified clause, both kept the live
one. The sample's content had gone stale against a later window and neither writer absorbed the
stale claim. That is the behaviour the prior run said a good sample should produce.

**But the sample also transmitted a defect.** The lane-tag header line above the sample was copied
INTO one writer's stored text (index lane C, line 1 = `#latency-budget`), which cost that lane a
surface slot and contaminated an axis-3 cell. The control teaching prints its samples the same way
and no control writer ever did this. Sample defects propagate; this run reproduced that in both
directions in a single experiment.

---

## Second writer draws — form stability, NOT reader-graded

| lane | draw 1 (graded) | draw 2 | agree? |
|---|---|---|---|
| B index | 2 lines, `T198..T199` / `T93..T103` | 2 lines, `T101..T199` / `T93..T99` | same stage count, DIFFERENT boundaries; draw 2 folds elevation into the SHEX stage as an extension rather than opening a new one |
| C index | 4 lines (incl. stray tag) | 3 lines, no stray tag | draw 2 is the clean form; both keep `120ms locked, split 25/60/35ms` |
| D index | 6 lines, one-stage-per-turn then merged | 4 lines, stages merged up front | both keep `EVALUATION ONLY`, `no ruling`, `gzip stays the only encoding` |
| D control | 2 lines | 3 lines | both keep the ruling, the removal-with-no-compat-window, and zstd-as-evaluation-only |

**Where a "stage" begins is not stable across draws.** Two writers given identical inputs on lane B
produced different stage boundaries — spec open question 2 ("what a stage is") reproducing as
measured variance, not as an argument. Every draw in both arms kept the state qualifiers.

## Pilot run, discarded

`run-index/pilot-precorrection/` holds four writer outputs produced under an earlier teaching whose
address paragraph asserted that a stage line's range runs over the task's event order and contains
only lane members. That claim is false at HEAD (no lane-qualified range selector exists), so the
teaching was corrected to call the address an explicit placeholder and everything downstream was
re-run. The pilot is kept, unused, so the correction is auditable.
