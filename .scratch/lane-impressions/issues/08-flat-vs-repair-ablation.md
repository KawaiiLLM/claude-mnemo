# 08 — Flat-150 vs the state-scope repair: a three-arm blind ablation

**What this answers:** ticket 06's line-1 gate failed. Is the TWO-TIER impression worth its
complexity, or does a FLAT impression capped at 150 tokens do better?

**Blocked by:** 06 (the failing gate is its finding).

**Status:** RUN AND REPORTED. **The result is a partial null, and the winner is not the tier
question.** Arms 2 and 3 are indistinguishable on the two axes the gate cares about; arm 3 pays a
real depth bill on the fat lane and collects an equally real depth bonus on the thin ones, and both
come from its cap change, not its structure change. The repair (arm 2) is recommended; flat-150
(arm 3) is NOT, on a reason that has nothing to do with reading fidelity. Full raw data in
`.scratch/lane-impressions/experiments/grading/records.md`; refusal log in `.../refusals.md`;
grading key (written before any arm ran) in `.../key.md`.

**No `src/` or `tests/` file was modified.** The two arm teachings are text files under
`experiments/run-arm{2,3}/teaching.txt`, derived from arm 1's rendered `teaching.txt` by `cp` and
diffed into `grading/diff-arm1-arm{2,3}.txt`. `validateImpression()` was imported from HEAD and run
unmodified. `~/.claude-mnemo/` was never touched. No working-tree rewrite command was used.

---

## The arms

| arm | variable | teaching | caps |
|---|---|---|---|
| 1 BASELINE | — (preserved, re-graded, not re-run) | shipped | `clamp(10×members,100,500)`; line 1 ≤ min(150, cap); lines 2+ ≤ 60 |
| 2 REPAIR | + STATE-SCOPE ISOLATION rule, golden sample rewritten to obey it | `run-arm2/teaching.txt` | identical to arm 1 |
| 3 FLAT 150 | whole impression ≤ 150 tok, no line 1, no per-line cap, no depth tier | `run-arm3/teaching.txt` | flat 150 |

Arm 3 deliberately keeps the UNREPAIRED golden sample — arm 1's defective line 1, presented as a
whole impression. That is the only way its variable is structure alone.

Corpus, windows, lanes, rounds, validator: identical. Fresh writer per round per arm, never reused,
never shown another arm. Writers ran on `sonnet` (production's `DEFAULT_NOTE_SETTLEMENT_MODEL` is
`claude-sonnet-5`). Lanes: `#map-data-extraction` (B) and the `#latency-budget` delivery case (C)
are the headline; `#visual-style` (A) is the contaminated copying canary and is reported separately.

---

## Axis 1 — Frontier coverage (3 blind readers per arm, raw)

Score 1 / 0.5 / 0. `NA` = honest "NOT ANSWERABLE"; both NA and a wrong answer score 0.

**Headline lanes B and C, per reader:**

| | arm 1 | arm 2 | arm 3 |
|---|---|---|---|
| Q1 identity | 6/6 | 6/6 | 5.5/6 (one reader NA'd the domain) |
| Q2 governing law | 6/6 | **4.5/6** | 6/6 |
| Q3 current state | 6/6 | 6/6 | 6/6 |
| **Q4 frontier** | **0/6 — six honest NAs** | **6/6** | **6/6** |

**Canary lane A:** arm 1 → 3/3, 3/3, 2/3, **0/3**. Arm 2 → 3/3 on all four. Arm 3 → 3/3 on all four.

Per-lane Q4, per reader, raw: arm 1 lane B = NA, NA, NA; lane C = NA, NA, NA. Arm 2 lane B = 1,1,1;
lane C = 1,1,1. Arm 3 lane B = 1,1,1; lane C = 1,1,1.

**What separates:** arm 1 from {arm 2, arm 3}, on Q4 only, and completely. **What does not
separate:** arm 2 from arm 3, anywhere on this axis.

Arm 2's Q2 loss is not the tier. It is one cap-driven trim: the delivery lane came in 101 tokens
over a 100-token cap, and to shed 17 tokens the writer deleted `— legs reallocate only via new
ruling`. That clause IS the lane's law. All three readers then gave the split and stopped.

---

## Axis 2 — State precision (over-reads, raw counts)

| lane | arm 1 R1/R2/R3 | arm 2 R1/R2/R3 | arm 3 R1/R2/R3 |
|---|---|---|---|
| A (canary) | **2** / 0 / 0 | 0/0/0 | 0/0/0 |
| B | 0/0/0 | 0/0/0 | 0/0/0 |
| C | 0/0/0 | 0/0/0 | 0/0/0 |

**The headline lanes are a flat zero in all three arms. Axis 2 does not separate the arms at all.**

This corrects ticket 06's framing. The gate reported false-finished beliefs on 3 of 3 lanes; this
run reproduces them on **1 of 3 readers, on 1 of 3 lanes, and that lane is the contaminated one**.
The two over-reads are arm-1 reader 1 on lane A, and they are exactly the diagnosed mechanism —
`officer stats and portraits from the 萌战 package` and the `CC BY 4.0 scrabling pack` read as
delivered because they sit as unlabelled siblings beside `committed` and `is fixed`. The other two
readers refused the bait and said why, which means **the defect is real, reproducible, and
probabilistic — not deterministic.**

Arm 1's uncontaminated lanes produce no over-reads because their line 1s name only true, proven
things. Arm 1's failure mode there is not inflation. It is total frontier omission: 0/6.

**Under-reads** (a proven item explicitly disclaimed), charged separately: arm 1 = 0, arm 2 = **1**,
arm 3 = 0. Arm 2's is lane C — the same trim deleted `in-budget`, so one reader disclaimed capture's
measured p50 9ms / p99 18ms proof.

---

## Axis 3 — Depth loss. ARM 3'S BILL, CHARGED.

Graded over each arm's FULL stored text, then checked against 2 depth readers per arm.

**Causal-model items present in the text (5 total):** arm 1 **4/5**, arm 2 **3/5**, arm 3 **2/5**.
**Binding items present in the text (8 total):** arm 1 **8/8**, arm 2 **5/8**, arm 3 **6/8**.

### Exactly what arm 3 drops, with the text that would have carried it

1. **Lane A's governing causal law, gone.** Arm 1 and arm 2 both carry
   *"top-down misreading is geometry, not style — axis-aligned gridlines cause it, not 2:1
   foreshortening (S18993/T124, T125)."* Arm 3's 145-token lane A has no room and does not carry it.
   Asked for the causal model, both arm-3 depth readers returned the aesthetic verdict instead:
   *"Road-cell rendering switched to whole tiles because the alternative … was explicitly ruled ugly
   by the user; that aesthetic ruling, not a technical failure, drove the retile."* True, and the
   wrong altitude — the geometry law is the one claim that stops a successor re-litigating the
   projection for a fourth time. This lane already burned four projection reversals.
2. **Lane A's bindings, 1 of 3 survive.** `visible stagger is mandatory or the asset is void
   (T119)` and `collage tile form locked, native regen unscheduled` are both absent from arm 3.
   Both arm-3 depth readers noticed the hole from the inside: *"Viewport and render-blur fixes are
   stated as fixed but not framed as a ruling — nothing says they can't be revisited."*
3. **Lane B's history, gone.** Arm 1 carries *"decoding beat the Windows-only reader, a spent
   source."* Arm 3 (and arm 2) do not. A successor reading arm 3 has no idea a Windows-only
   bin-editor path was tried, byte-verified onto a remote box, and abandoned — the exact shape of
   work someone would redo.
4. **Lane B's frontier, gone.** Arm 3's lane B names only `mapB conversion remains open` and drops
   the elevation frontier (preview-only, no client integration, no combat rule) that arm 2 carries.
   Its readers still answered Q4 correctly **only because they had lane A in front of them**, which
   names it. A surface showing one lane would score this lower.

### And arm 3's depth WIN, which must be reported too

Lane C is the best depth text in the experiment, in any arm. Both arm-3 depth readers recovered
every causal and binding item, including two that no other arm's readers got cleanly:

> *"The 120ms/25/60/35 budget split is locked as a ruling — legs may not be reallocated based on
> measurement alone; only a new ruling changes it."*
> *"Playback's 35ms is explicitly 'deferred not accepted' — this is a locked non-status: it must not
> be treated as validated or closed."*

Arm 3's lane C also keeps the profiling numbers (48 of 74ms) that arms 1 and 2 both compress away.

**Why: lane C's cap went 100 → 150 under arm 3, and lane A's went 370 → 150.** Arm 3 is not
uniformly shallower. It is *flatter* — it starves the fat lane and feeds the thin ones. That is the
arithmetic of replacing `clamp(10×members,100,500)` with a constant, and it is most of what arm 3
measures.

---

## The confound that explains the axis-1 result

Surface budget — the tokens each arm actually shows a reader:

| | lane A | lane B | lane C | **total** |
|---|---|---|---|---|
| arm 1 (line 1) | 98 | 73 | 46 | **217** |
| arm 2 (line 1) | 142 | 110 | 84 | **336** |
| arm 3 (whole) | 145 | 141 | 135 | **421** |

Arm 3 shows 1.9× arm 1's text; arm 2 shows 1.5×. The axis-1 ordering is the surface-budget
ordering. Arm 1's 0/6 on frontier is substantially a 217-token surface being asked to carry four
duties, and arm 2 fixed it partly by rule and partly by having 55% more room.

---

## A finding bigger than the tier question

Arm 1's lane B line 1 says *"42/42 city flowers **confirming** odd-r adjacency."*
Arms 2 and 3 say *"odd-r hex adjacency **locked** by a 42/42-city proof."*

Same fact, same anchor, same lane. **Both** arm-1 depth readers answered *"NOT ANSWERABLE FROM THIS
TEXT — the text states facts and a causal law but contains no locked/forbidding rule"* when asked
for lane B's bindings. **Both** arm-2 and **both** arm-3 readers named it as a binding at once.

One verb decided whether a binding survived reading — 0/2 vs 4/4 readers. That is a larger, cleaner
effect than anything the tier variable produced, and it is orthogonal to the tier. A binding has to
be *marked* as a binding; stating the evidence is not stating the lock.

---

## The canary — the golden sample is the effective teaching

| arm | what its lane-A writer produced at r3 | the sample it was imitating |
|---|---|---|
| 1 | `officer stats and portraits from the 萌战 package (T133)`, in a list with `committed` | the shipped sample's exact words, exact position |
| 2 | `officer portraits are a ruled SOURCE, 萌战 package, not yet extracted (T133)` | arm 2's REWRITTEN sample, near-verbatim |
| 3 | `officer portraits from 萌战 (S18993/T133)`, unlabelled beside `locked` and `verified` | arm 3's sample = the shipped defective line 1 |

Writers copy the sample's *construction*, not just its shape. Arm 2's writer reproduced the repaired
form almost word for word; arm 3's, given the unrepaired form, reproduced the defect. **This is
direct evidence for the ticket's premise that rewriting the golden sample is required and not
cosmetic.** An arm-3 writer went further and defended against the sample unprompted:

> *"the golden sample … says 'the look is locked and shipped through ticket 004' … both of which
> contradict this task's actual current state (T149 says 'commit staged not landed', and T133 is
> this-window-overridden). I treated the golden sample as a form/density template only, not as
> factual content."*

A sample that a writer must actively resist is a defect regardless of which arm wins.

---

## Validator refusals — every one

| arm | lane-writes | refusals | rules fired |
|---|---|---|---|
| 1 | 7 | **unknown — not preserved** | — |
| 2 | 7 | 2 | `total-cap` ×2, `line-1-cap` ×1, `line-cap` ×2 |
| 3 | 7 | 0 | — |

Both arm-2 refusals were SIZE refusals; so would any have been. `delivery-anchor`,
`anchor-format`, `anchor-unresolvable`, `structure` and `line-count` never fired in any arm, and no
`sequence-word` warning was emitted. **The validator caught no state defect in this experiment,
which is what its own header says it will not do.**

Refusal 1 is the one that mattered: 101 tokens against a 100-token cap, and the 17 tokens the writer
chose to shed were the lane's governing law (`legs reallocate only via new ruling`) and a state
qualifier (`in-budget`). Both losses show up in the reader data. **Under cap pressure a writer sheds
the clauses that carry no proper noun — laws and qualifiers first, named artefacts last.** Arm 3
never hit its cap (finals at 145/141/135 of 150) because two of its writers self-throttled for
margin; that pressure is latent there, not absent.

---

## RECOMMENDATION

**Ship arm 2's STATE-SCOPE ISOLATION rule and the rewritten golden sample. Do NOT adopt flat-150.
Keep the two-tier structure.** Three reasons, in order of how much weight they carry.

1. **The arms do not separate on the question that motivated the experiment, so complexity is
   decided elsewhere.** Arm 2 and arm 3 tie 6/6 on frontier coverage and 0/0 on over-reads across
   both headline lanes. Nothing in the reading data prefers flat. When the outcome is a tie, the
   cost side decides — and flat-150's cost is a 60% budget cut on the lane that had the most to say,
   with the causal law and 2 of 3 bindings measurably gone.
2. **Flat-150 is not the simplification it looks like.** Deleting the tier also deletes
   `clamp(10×members,100,500)`, which is what makes budget track how much a lane actually contains.
   Arm 3's own results split along that seam: its worst lane and its best lane are its most-cut and
   most-fed lanes. Replacing a sized budget with a constant is not less complexity, it is less
   *fit* — and the depth tier is the part of the design that was doing real work.
3. **The repair is cheap and its mechanism is confirmed independently of the tier.** The canary
   shows writers copy the sample's construction verbatim in both directions. That makes the rewrite
   a high-leverage, low-cost change whose effect does not depend on which structure wins.

**Two things this experiment says to do that the ticket did not ask about, and which I rate above
the tier question:**

- **Make line 1's frontier duty explicit in the teaching.** Arm 1 scored 0/6 on frontier with
  *nine honest refusals* — its readers did not guess, they were given nothing. The shipped teaching
  tells line 1 to carry "what it is, its governing law, its current state" — three duties, where
  the four questions name four. Arm 2's rule ends with *"LINE 1 CARRIES THE OPEN BOUNDARY"* and the
  gap closed completely. That single clause is doing more of arm 2's work than the sibling rule is.
- **Teach `locked by` over `confirming` for bindings.** 0/2 readers vs 4/4 readers on one verb.
  Cheaper than either arm and orthogonal to both.

### What would change my mind

- **A single-lane surface.** Every reader here saw three lanes at once, and arm 3's lane B was
  rescued by its neighbour. If a real surface shows one lane's impression alone, re-run lane B in
  isolation; if arm 3's frontier score survives that, its depth bill is the only remaining charge
  and reason 1 weakens.
- **Flat-150 tested at `min(150, laneCap)` instead of a constant 150.** That would hold the thin
  lanes at their current budget and isolate the structure variable properly. If flat still ties on
  axes 1–2 *without* the +36%/+50% bonus it got on lanes B and C here, the tie is genuine and reason
  2 becomes the whole argument — a narrower position than the one I am taking.
- **Evidence that any surface actually consumes lines 2+.** The depth tier is only worth its
  complexity if something reads it. If the depth tier is stored and never rendered anywhere, then
  arm 3 loses nothing a reader would have seen, and flat-150 becomes the right call on Occam
  grounds alone. **I did not check this, and it is the single cheapest thing that could overturn
  this recommendation.**
- **More writer draws.** n is 3 texts per arm, not 9. Q4 going 0/6 → 6/6 is a large, clean effect,
  but it rests on three writer draws per arm. A second full replication with different seeds would
  settle whether arm 1's frontier omission is the teaching or the draw.
- **Arm 1's writer model.** Unrecorded. If arm 1 ran on a weaker model than `sonnet`, part of its
  0/6 is model, not teaching, and the case for the explicit frontier clause weakens accordingly.

### What I am NOT claiming

Not that arm 2 beats arm 3 on reading fidelity — it does not, they tie. Not that flat-150 is
unreadable — it was the most faithful text in the experiment on lane C. Not that the shipped defect
is deterministic — 1 of 3 readers absorbed it. And not that this experiment measured the tier
cleanly: arm 3 changed the cap as well as the structure, and that confound is large enough that a
reader should treat arm 3's axis-1 win as mostly a budget result.

---

## Artifacts

- `experiments/grading/key.md` — grading key, written from the source windows before any arm ran
- `experiments/grading/records.md` — every reader, every lane, raw, with the quotes each grade rests on
- `experiments/grading/refusals.md` — validator refusal log
- `experiments/grading/diff-arm1-arm{2,3}.txt` — exactly what each arm changed in the teaching
- `experiments/run-arm{2,3}/teaching.txt`, `brief-*.md`, `r{2,3,4}/`, `delivery/` — teachings, briefs, outputs
- `experiments/readers/arm{1,2,3}/brief.md`, `depth-brief.md` — the reader surfaces
- `experiments/validate.ts` — the harness; imports `validateImpression()` from HEAD, changes nothing
