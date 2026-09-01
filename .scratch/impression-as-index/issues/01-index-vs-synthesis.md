# 01 — The impression as an INDEX vs the repaired SYNTHESIS: a two-arm blind comparison

**What this answers:** the prior ablation compared three SYNTHESIS forms and found a partial null.
This one tests a different SHAPE — one line per stage of work, newest first, each line leading with
a range address, overflow resolved by MERGING the two oldest stages. Does it beat the repair arm?

**Status:** RUN AND REPORTED. **The forms do not separate on coverage or on state precision. They
separate on the spec's own open question, and the index LOSES it.** A fixed-size newest-first
surface keeps identity in degraded form and drops the lane's durable bindings; on the one
uncontaminated cell built to test it, non-reopenable constraints scored **index 1/3 vs control
3/3**. A second failure mode, unanticipated by both the spec and the design review, fired on
**5 of 5** index readers and **0 of 5** control readers.

**No `src/` or `tests/` file was modified.** The index teaching is a text file derived from the
control teaching by `cp` (md5-verified identical before editing) and diffed into
`grading/diff-control-vs-index.txt`. `validateImpression()` was imported from HEAD and run
unmodified. `~/.claude-mnemo/` was never touched. No working-tree rewrite command was used.

**The sample was written and validated FIRST** — `.scratch/impression-as-index/sample.md`, built
from `#visual-style`'s real windows, three variants, all three accepted by the validator, before
any writer existed. What is in it and why is in that file. It is the run's primary artefact and
the canary result below is why.

---

## Three defects in the spec, found by design review and confirmed here

1. **The address contract is FALSE. The form is NOT implementable at HEAD.** In `src/mcp/recall.ts`,
   `E<n>/S<a>/T<b>..S<c>/T<d>` resolves over the SEGMENT's event order with no lane filter;
   `E<n>/#<tag>` addresses a whole lane with no range sub-selection; a bare
   `S<a>/T<b>..S<c>/T<d>` is a session range. The validator sees two independent anchors and never
   parses `..`. **No lane-qualified range selector exists**, so the spec's load-bearing claim —
   that a stage line's range contains only that lane's members — is the opposite of what the
   grammar does. The teaching was corrected to call the address an explicit PLACEHOLDER and to
   require that the prose stand alone without it. Reading measurements are unaffected (blind
   readers see prose), but nothing here says the address works.
2. **The budget rule contradicts itself, and the contradiction fires immediately.** The spec says
   the bound is line count while keeping `≤60` per line and `clamp(10 × settledMembers, 100, 500)`
   overall. Two 60-token stages already blow a 100-cap lane. **Both index refusals were
   `total-cap`, with every line inside the per-line cap and the line count inside 8. The token cap
   bit first, every time; the 8-line bound never bound at all.** Below a 480-token cap the line
   bound is unreachable.
3. **The strong claim was already falsified by the spec's own sample**, so the weak one was tested:
   the stage form may reduce mixed-maturity siblings in one clause; it does not delete the defect
   class. (Its own sample says "is fixed", "committed", "ruled".)

---

## The arms

| arm | teaching | lanes | caps |
|---|---|---|---|
| CONTROL — repaired synthesis | `lane-impressions/.../run-arm2/teaching.txt`, unchanged | B, C reused from the prior run unmodified; D written fresh, 2 draws | identical |
| TREATMENT — index | `experiments/teaching-index.txt` | B (r2→r3→r4 chain), C, D; 2 draws at every graded round | identical |

**Budget held constant by construction.** The index ran at the CONTROL'S OWN per-lane token caps
(100 → 280/100 → 370/110, delivery 100, lane D 200 for both arms). The prior ablation's largest
confound was that its flat arm changed the cap as well as the structure; this one does not. The
cost is that the spec's "bounded by line count" is untested — deliberately, and reported as defect
2 rather than worked around.

**What was removed from the index teaching, on purpose:** the four-question law, the line-1 duty
clause, both golden samples, and **the STATE-SCOPE ISOLATION rule** — arm 2's specific repair for a
synthesis defect the index form claims to make structurally impossible. Keeping it would have
handed the treatment the control's repair for free. The STATE CEILING (write to what the anchor
proves) was kept in both: it is form-agnostic. So this compares two whole designs, not one isolated
variable.

## The lanes

`#map-data-extraction` (B) and the `#latency-budget` delivery case (C), both uncontaminated, both
reused from the prior corpus. `#visual-style` (A) is the contaminated canary — my sample is built
from it, as the shipped golden sample was — and it was **never shown to a reader**; it appears only
as the copying canary.

**`#wire-format` (D) is NEW and AUTHORED BY ME**, at the design review's instruction, because the
corpus contained no lane with the specific trap that needed testing: an old rule still in force
while a newer stage merely explored an alternative. Its shape is deliberate — founding law is the
OLDEST turn, the three newest stages are ordinary maintenance plus one exploratory draft, one
genuine override chain sits beside one non-override. It is not evidence about how real lanes are
shaped, only about how each form survives that shape. Its key was written before either arm ran on
it.

---

## Axis 1 — Coverage. 5 blind readers per arm, 3 lanes, raw per reader in `grading/records.md`.

| | INDEX | CONTROL |
|---|---|---|
| Q1 identity | 15/15 | 15/15 |
| Q2 governing law | **15/15** | 12.5/15 |
| Q3 current state | 15/15 | 15/15 |
| Q4 frontier | 10/15 | **15/15** |
| **total** | **55/60** | **57.5/60** |

**The arms trade one complete lane-level failure each, in opposite places.**

- **Index Q2 win is lane C, 5/5 vs 2.5/5** — and it is not the form. The key requires the ruled
  split AND the never-grow rule; the control's text lost `— legs reallocate only via new ruling` to
  a 101-vs-100-token trim in the PRIOR run. The index writer fit the same law in 97 of the same 100
  tokens. Different luck of the refusal as much as different form.
- **Index Q4 loss is lane B, 0/5, and not one of them was an honest refusal.** All five gave the
  same wrong frontier. Cause is traceable to one refusal: a `total-cap` handback merged two stages
  and deleted `Opus worker delivered mapA.json` — key item D-B3, the lane's one real delivery —
  along with the lane's own product name. 5/5 control readers named `mapA.json + tools/` as
  delivered and named SAN11; 0/5 index readers could do either.

Axis 1 is a wash: 2.5 points on 60.

## Axis 2 — State precision. Zero, everywhere.

| lane | INDEX R1/R2/R3/R4/R5 | CONTROL C1/C2/C3/C4/C5 |
|---|---|---|
| B | 0/0/0/0/0 | 0/0/0/0/0 |
| C | 0/0/0/0/0 | 0/0/0/0/0 |
| D | 0/0/0/0/0 | 0/0/0/0/0 |

**30 reader-lane observations, zero over-reads, zero under-reads, both arms.** Five readers per arm
were used specifically because the prior run measured this defect firing on ~1 reader in 3; at that
rate a five-reader arm sees it with ~87% probability per lane. It did not appear once.

**This axis has now failed to separate anything in two consecutive experiments.** The prior run
reproduced the defect only on the contaminated lane, on 1 of 3 readers. This run, on three
uncontaminated lanes with a deliberately planted trap, produced nothing in either form. The honest
reading is that **state inflation is a property of one badly-constructed sentence in one shipped
sample, not a property of either form** — and that this axis should stop being the gate.

One caveat that limits the null: lane D's source turns state the in-force fact in their own words
(`T12's gzip ruling is untouched and still governs`), and both arms' writers copied that through.
The trap was partly defused by the corpus before either form met it.

## Axis 2b — IN-FORCE rule (new axis, added by design review)

| | INDEX | CONTROL |
|---|---|---|
| B | **0/5** | 5/5 |
| C | 5/5 | 2.5/5 |
| D | 5/5 | 5/5 |
| total | 10/15 | 12.5/15 |

**The predicted failure did not fire; its mirror did.** Zero CURRENT-TRUTH NORMALISATION errors at
full text in either arm — no reader substituted "newest" for "in force" on lane D's zstd trap;
10/10 refused it.

What fired instead, on the index only, is a **LIVENESS error**: the index preserves an old stage and
never says it is dead, so readers took a superseded path for live work. **5 of 5 index readers,
0 of 5 control readers, on lane B.** The offending line is

> `S18993/T93..T103: bin-editor link decoded and export recipe written, decoded-only with nothing
> extracted; SHEX map format then cracked, mapA picked over mirrored mapB, odd-r hex adjacency
> locked 42/42 vs 0`

— the dead path and the path that killed it, in one line, with **no supersession marker between
them**. Per key item N-B6 the bin-editor export was abandoned, not pending. Five readers, five
identical misreads:

- R2: *"The one explicitly open item is extraction itself — the export recipe exists but has not
  been run."*
- R5: *"未生效 / 尚待完成：实际的数据提取——recipe 存在不代表数据已到手，这一步仍需执行。"*
- R3, on what is in force: *"The text uses no 'ruling'/'governs' language here, so whether anything
  is formally reopenable is NOT ANSWERABLE FROM THIS TEXT."*

Control readers never made it because their text does not mention the bin editor at all.

**The two forms fail the in-force question in exactly opposite ways. The index keeps the history and
cannot mark it dead. The synthesis marks what is live by throwing the history away** — which is
precisely the depth loss the prior ablation charged against it ("Lane B's history, gone"). Neither
form has a place to say *this earlier conclusion is no longer in force*, and that, not the tier
question and not state inflation, is the real gap in both designs.

## Axis 3 — THE SPEC'S OPEN QUESTION 1. Identity, and more, under newest-first.

INDEX surface = newest 3 lines. CONTROL surface = line 1 (the synthesis form's own designed
fixed-size surface). 3 readers per arm.

| | INDEX | CONTROL |
|---|---|---|
| S1 identity | 6.5/9 | 9/9 |
| S2 in-force | 4/9 | 7.5/9 |
| S3 non-reopenable | 4/9 | 4/9 |

**Read the totals only after the caveats.** Lane B is not a truncation test in either arm (2-line
and 1-line texts — "newest 3" and "line 1" show everything). Lane C's index surface is contaminated
by my own sample's defect: a stray `#latency-budget` header line ate one of three slots and took
the budget ruling with it. **Lane D is the only clean cell, and it was built for this question.**

**Lane D, clean:**

| | INDEX | CONTROL |
|---|---|---|
| identity | 2/3 | 3/3 |
| in-force | 3/3 | 3/3 |
| **non-reopenable** | **1/3** | **3/3** |

- **Identity degrades, it does not fail.** Every index surface reader named the right domain, but
  two of three demoted the lane from format DESIGN to format MAINTENANCE, because the newest three
  stages are maintenance. S2: *"Decoder/encoding-pipeline maintenance: a decoder crash fix, a
  histogram exporter, and exploratory work on migrating from gzip to zstd."*
- **In-force ties at 3/3 — and the index's 3/3 is fragile.** It does not come from the founding
  ruling, which the surface never showed. It comes from one clause the writer restated inside the
  newest line: `gzip remains the only accepted encoding`. Delete that restatement and the surface
  states nothing about what governs.
- **Durable bindings do not survive the cut: 1/3 vs 3/3.** `T12..T19` — atomic frames, no
  streaming, gzip by ruling, string tags removed with no compat window — is simply off the surface.
  S3 named two maintenance commits as the lane's non-reopenable constraints. S2 produced the run's
  **one and only normalisation error**: *"the zstd draft's existence suggests that question is
  still open, not closed."* Against CS3, seeing only line 1: *"The frame format ... may not be
  reopened or done differently without a new ruling, since it's stated as a locked RULING."*

**The answer to open question 1, plainly: identity is NOT the thing that breaks. Bindings are.**
A fixed-size newest-first surface shows recent maintenance and hides the founding decision, and a
reader who cannot see the founding decision treats the settled question as reopenable — which is
the exact failure a lane impression exists to prevent. Pinning an identity line would not fix this.
Whatever gets pinned has to be the LAW, not the identity.

## Validator refusals — every one. Full log in `grading/refusals.md`.

| arm | lane-writes | refusals | rules fired |
|---|---|---|---|
| INDEX | 11 | 2 | `total-cap` ×2 |
| CONTROL (lane D, new) | 2 | 1 | `line-cap` ×1 |

**Every refusal was again a SIZE refusal**, as in the prior run. `delivery-anchor`,
`anchor-format`, `anchor-unresolvable`, `structure` and `line-count` never fired. Two
`sequence-word` warnings. Nothing semantic was caught, which is what the module's header promises.

**Under cap pressure the index writers shed the OPPOSITE things from the synthesis writers.**
Refusal 1 (lane D, 272→196): the numbers went — `2.9x faster, 31% smaller` → `faster and smaller`,
`214 tests, 2M-case fuzzer clean` → `tests and fuzzer clean` — while `EVALUATION ONLY`, `T12's
ruling still governs`, `nothing wired in`, `no compat window` all survived verbatim. The prior run
found synthesis writers shed "laws and qualifiers first, named artefacts last"; here the index kept
every law and qualifier and shed the artefacts' numbers. Refusal 2 (lane B, 162→96) is the
exception that matters: it shed a DELIVERY (`Opus worker delivered mapA.json`) and the lane's
product name, and both losses are visible in the reader data.

**On the line-1 cap having "no subject" in this form:** it is worse than subjectless, it is an
active artifact. At HEAD line 1 is capped at `min(150, cap)` and lines 2+ at 60, so **in the index
form the newest stage is the only line permitted to exceed 60 tokens**. The refused lane-B draft
had a 63-token line 1 that was legal only by position; the control's lane-D line 1 is 140 tokens.
No refusal in this run was caused by that rule, so none of its refusals were meaningful — but the
rule is a live, position-dependent size privilege inside a form that declares no line is special.
My sample's first draft had a 63-token line 1 and passed; I cut it to 59 so the sample could not
teach the habit.

## Did index writers imitate the sample? Yes, at the level of byte-identical lines.

| writer output | lines | byte-identical to a sample line |
|---|---|---|
| chain1 r3 `#visual-style` | 5 | **4** |
| chain1 r4 `#visual-style` | 8 | **3** |
| draw2 r4 `#visual-style` | 7 | **4** |

Two independent writers, two independent draws, reproduced the same four sample lines verbatim.

**Two writers had to resist the sample, and both did it correctly.** The sample's `T132..T135` line
says `native regen unscheduled`, which window 4 overrides. chain1 r4: *"This window's own edge
overrides `S18993/T133` ... 'native regen unscheduled' — now false ... the `T132..T135` line
trimmed to drop only the overridden clause (kept the still-live officer-stats/portraits ruling)."*
draw2 r4 located the same override independently. Both deleted only the falsified clause. Unlike
the prior run's arm-3 writer, neither had to declare the sample untrustworthy wholesale.

**But the sample transmitted a defect anyway.** The lane tag is printed above the sample lines —
exactly as the control teaching prints its own — and one index writer copied `#latency-budget` INTO
its stored text as line 1. The validator accepted it; it cost that lane a surface slot and
contaminated an axis-3 cell. No control writer ever did this. **Sample LAYOUT is teaching too.**

## What did not reproduce, and one thing that did not hold still

**Stage boundaries are not stable.** Two writers given identical inputs on lane B produced different
stage boundaries — one opened a new `T198..T199` stage, the other extended the existing stage to
`T101..T199`. Spec open question 2 ("what a stage is") reproduces as measured variance.

---

## RECOMMENDATION

**Do NOT adopt the index form as specified. Do NOT ship a pinned identity line either. Keep the
repaired synthesis, and spend the next change on the thing both forms actually lack: a way to say
which earlier conclusion is no longer in force.**

Four reasons, in order of weight.

1. **The index is not implementable at HEAD and the spec's central claim about it is false.** No
   lane-qualified range selector exists. Everything the range address was supposed to buy — a
   pasteable pointer whose span means "this lane's members between here and here" — does not exist
   and would have to be built. That cost was invisible when the form was proposed and it is not
   small.
2. **On the axes the spec proposed to win, the arms do not separate.** Coverage 55 vs 57.5 on 60,
   with each arm owning one complete lane-level failure. State precision is a flat zero on 30
   observations per arm. **This is a clean null and it should be reported as one.** Nothing in the
   reading data prefers the index.
3. **On the spec's own open question, the index loses, and it loses the thing that matters most.**
   Identity degrades gracefully under newest-first — that part of the worry was misplaced. What the
   newest-N cut actually drops is the LAW: non-reopenable constraints 1/3 vs 3/3 on the clean cell,
   with one reader concluding the settled format question was reopenable because the newest stage
   drafted an alternative. **A pinned identity line would not have saved any of that**, so the
   redesign cannot even buy its way out by reintroducing the privileged line it exists to delete —
   it would have to pin the law, which is a bigger privileged line than the one it deletes.
4. **The index's one real advantage is not a form advantage.** Its lane-C governing-law win came
   from fitting a clause the control's writer had trimmed away in a different experiment, under the
   same cap. Its refusal behaviour was genuinely better — laws and qualifiers survived, numbers
   went — which is worth one observation, not a redesign.

**Two things to do that this experiment says matter more than the form:**

- **Give impressions a supersession marker.** Both forms failed the in-force question, in mirror
  images: the index cannot mark dead history dead, the synthesis avoids the problem by deleting the
  history. A rule as small as *when a line names work that a later decision superseded, say so on
  that line* would have fixed 5 of 5 index liveness errors, and it costs the synthesis form
  nothing. This is orthogonal to the form and it is the largest single effect in the run.
- **Retire the state-inflation acceptance gate.** Two consecutive experiments, 30 uncontaminated
  reader-lane observations here plus the prior run's, and it has fired exactly twice — both on the
  contaminated lane, both traceable to one sentence in one shipped sample. Gating on it makes the
  gate the noise.

### What would change my mind

- **A lane-qualified range address landing.** Reason 1 dissolves if the address is built. It would
  not touch reasons 2 or 3, but it changes the cost side of the argument entirely.
- **A pinned LAW line measured, not argued.** My axis-3 result says the founding law is what falls
  off the surface. If an index with a pinned law line scores 3/3 on non-reopenable while still
  reading as an index, the redesign survives with one privileged line instead of a tier — a much
  better trade than the one it currently proposes. **This is the single cheapest experiment that
  could overturn reason 3, and I did not run it.**
- **A lane D whose source does not hand over the answer.** Its turns literally contain "T12's gzip
  ruling is untouched and still governs". Both arms copied it through, which is most of why axis 2
  and the lane-D in-force cell are flat 5/5 ties. Rerun with the disclaimer stripped from the
  source and the in-force axis may separate for the first time.
- **More writer draws on lane B.** Its 0/5 frontier failure rests on ONE writer draw whose text was
  shaped by one refusal handback. The second draw drops the frontier too, which is suggestive, but
  n is 2, not 5.
- **A real surface consuming these lines.** The prior run flagged this and it is still true: the
  frontier block was never wired to impressions. If nothing renders a fixed-size slice, axis 3 is
  measuring a consumer that does not exist, and reason 3 weakens to a hypothetical.

### What I am NOT claiming

Not that the index is unreadable — it tied or beat the control on three of four coverage questions.
Not that the synthesis is safe — it lost lane C's governing law to a one-token cap overrun and it
buys its in-force clarity by deleting history a successor would want. Not that state inflation is
imaginary — it is real, it is just rarer than the gate assumed and it did not appear here at all.
And not that this run measured the form cleanly: the graded set is one writer draw per lane per
arm, lane D is authored rather than captured, lane C's surface cell is contaminated by my own
sample's layout defect, and lane B's index text was shaped by a refusal handback.

---

## Artifacts

- `.scratch/impression-as-index/sample.md` — the index-form sample, written and validated FIRST,
  with what is in it and why, its post-review corrections, and the defect it shipped
- `experiments/sample-visual-style.txt` — the sample text the validator was run against
- `experiments/teaching-index.txt` — the index writing law (from the control teaching by `cp`)
- `experiments/grading/diff-control-vs-index.txt` — exactly what the arm changed in the teaching
- `experiments/corpus/wD.txt` — lane D's authored window
- `experiments/grading/key-addendum.md` — lane D's key + the IN-FORCE and surface rubrics
- `experiments/grading/records.md` — every reader, every lane, raw, with quotations
- `experiments/grading/refusals.md` — every validator refusal and what each trim cost
- `experiments/run-index/{chain1,draw2,control-laned}/` — briefs and outputs, both draws
- `experiments/run-index/pilot-precorrection/` — the discarded pre-correction pilot, kept for audit
- `experiments/readers/{index,control}/{full,surface}-brief.md`, `readers/slices/` — reader surfaces
- `experiments/validate.ts` — the harness; imports `validateImpression()` from HEAD, changes nothing
