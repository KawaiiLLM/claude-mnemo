# The index-form SAMPLE — written first, before any writer ran

Finding 4 of the spec is that writers imitate the sample near-verbatim, defects included. So the
sample is the teaching, and it is written and validated before a writer sees anything.

Built from a real lane's real windows: `#visual-style` over
`.scratch/lane-impressions/experiments/corpus/w2.txt`, `w3.txt`, `w4.txt` — the SAME lane the
shipped synthesis golden sample was built from. That is deliberate: it keeps the contamination
exactly where the prior ablation already put it, so `#map-data-extraction` and `#latency-budget`
stay uncontaminated headline lanes in BOTH arms, and `#visual-style` stays the copying canary.

Validated with `validateImpression()` at HEAD via
`.scratch/lane-impressions/experiments/validate.ts`, unmodified.

---

## Sample 1 — a full lane index (`#visual-style` at its terminal state, cap 370)

```
S18993/T196..T199: render blur fixed by nearest+mipmap and an integer zoom ladder; 4793.K3ST decoded as mapA's elevation and rendered as an offline hillshade — zero art, zero client change, so integration and any elevation-combat rule stay open
S18993/T159..T179: road cells became whole regenerated road tiles, replacing the mid-tile stripe the user rejected, committed a32588c; the client viewport was raised to 1920x1080, committed 5c97488
S18993/T124..T149: diagonal-brick diamond geometry ruled and verified — the top-down reading comes from axis-aligned gridlines, not from 2:1 foreshortening; ticket 004's six acceptance criteria hand-verified, its commit set staged
S18993/T132..T135: tile form locked on the current collage tiles, native regen unscheduled; officer stats and portraits ruled to come from the 萌战 package, extraction not built
S18993/T117..T123: visible stagger ruled mandatory or the isometric asset is void; brick-rect placement built and faulted for still reading top-down
S18993/T103..T109: 2:1 isometric locked game-wide over 3/4 top-down; the scrabling.itch.io pack cleared as CC BY 4.0 and gap-filled to 89 tiles
S18993/T82..T93: SAN11 mechanic and visual fidelity became M3's goal; retro pixel art in 3/4 top-down was picked over the oblique vector plan, since overturned
```

Validator: `lines=7 total=337tok per-line=[59, 52, 56, 40, 34, 48, 42] accepted=true`, zero warnings.

## Sample 2 — the same index after ONE overflow MERGE

The two oldest adjacent stages fold into one line covering both ranges. One line is spent to buy
one slot. Nothing is dropped.

```
… (lines 1–5 unchanged) …
S18993/T82..T109: early projection churn — oblique vector, 3/4 top-down pixel and 2:1 isometric in turn, all superseded; the CC BY 4.0 pack cleared in this stage is the one still in use
```

Validator: `lines=6 total=302tok per-line=[59, 52, 56, 40, 34, 56] accepted=true`.

## Sample 3 — a thin lane, deliberately ONE stage

```
S18993/T82..T93: SAN11 mechanic and visual fidelity became M3's goal; retro pixel art in 3/4 top-down was picked over the oblique vector plan, asset sourcing tiered ~80% off-the-shelf packs and ~15% AI generators
```

Validator: `lines=1 total=58tok per-line=[58] accepted=true`.

---

## What I put in it, and why

Each choice below is a defence against a defect the prior ablation actually measured.

1. **Every line ≤ 60 tokens, including line 1.** The validator at HEAD caps line 1 at
   `min(150, cap)` and lines 2+ at 60. In the index form line 1 is not special, so a sample whose
   line 1 exceeded 60 would teach writers to stuff the first line — and that stuffing is legal only
   in position 1. My first draft's line 1 came in at 63 tokens and passed. I trimmed it to 59 so the
   sample cannot teach a position-dependent size habit.

2. **No summarising matrix clause anywhere.** Every line is `range: what that range of turns DID`.
   The measured state-inflation defect (spec finding 3) is apposition — a list member with no state
   predicate of its own inheriting the matrix clause's delivery predicate. There is no matrix clause
   to inherit from here. This is the spec's structural claim, and the sample has to embody it rather
   than restate it, so I deliberately did NOT add a state-scope rule to the teaching.

3. **Undelivered items carry their own negation IN THEIR OWN LINE.**
   `zero art, zero client change, so integration and any elevation-combat rule stay open`;
   `extraction not built`; `native regen unscheduled`. These are the exact items the key marks as
   over-read traps (N-A1..N-A4). If the form works, a reader will not call them done.

4. **Laws are stated as laws, not as evidence.** `the top-down reading comes from axis-aligned
   gridlines, not from 2:1 foreshortening` and `visible stagger ruled mandatory or the isometric
   asset is void` are the two governing laws of this lane, and they sit inside stage lines rather
   than in a separate `Causal law:` line. This is the sample's biggest bet: the index form deletes
   the dedicated law tier, so if laws are to survive at all they have to ride the stage that
   produced them. The prior run's largest single effect was that a binding must be MARKED as a
   binding (`locked by` beat `confirming`, 4/4 readers vs 0/2), so I used `ruled`, `locked`,
   `mandatory or … is void` explicitly.

5. **The oldest line still names the lane's origin.** `SAN11 mechanic and visual fidelity became
   M3's goal` is the founding decision, kept as the last line. That is the whole reason the spec's
   open question 1 exists: a fixed-size surface takes the NEWEST N lines and would never show it.
   The sample keeps it so a writer learns to keep it; whether keeping it is enough is what the
   newest-3 reader battery measures.

6. **No sequence words.** `then` in a draft line triggered the validator's `sequence-word` warning.
   Rewritten to `built and faulted`.

7. **A merged line says it is a merge, and says what survived it.** The merged sample line names
   the era (`early projection churn`), names what was superseded, and names the ONE thing from that
   era that still binds (the asset pack still in use). A merge that only says `early work, since
   overturned` would silently erase live state — the spec's own draft merge line has that defect and
   I did not copy it.

## Corrections made after design review, before the graded writers ran

- **The address is a PLACEHOLDER, not a working selector.** The spec's claim that a stage line's
  range runs over the task's own event order and therefore contains only lane members is false at
  HEAD: `E<n>/S<a>/T<b>..S<c>/T<d>` resolves over the SEGMENT's event order with no lane filter,
  `E<n>/#<tag>` has no range sub-selection, a bare `S<a>/T<b>..S<c>/T<d>` is a session range, and
  the validator parses the two endpoints as independent anchors and never looks at `..` at all. The
  teaching was rewritten to say so and to require that a reader who reads only the prose, with the
  addresses stripped, loses nothing. The sample lines above are unchanged — they already satisfy
  that — but the addresses on them are labels, not resolvable range queries.
- **The strong claim is not the one under test.** The spec says a stage line "makes no completion
  claim"; this sample's own lines say `fixed`, `committed`, `ruled and verified`. The hypothesis
  actually tested is the weak one: that the stage form reduces the density of mixed-maturity
  siblings inside one clause. It does not delete the defect class.

## The defect this sample shipped anyway

The lane tag is printed above the sample lines (`#visual-style`), exactly as the control teaching
prints its own samples. One index writer copied that header INTO its stored impression, making
`#latency-budget` line 1 of a lane-C index. The validator accepted it, and it cost that lane one
slot of its fixed-size surface. No control writer ever did this. **A sample's layout is teaching
too, not just its sentences** — if this form ships, the tag must not be printed adjacent to the
sample lines.

## What I could not defend, and left visible

- Stage boundaries in `#visual-style` are not clean. `T132..T135` (tile-form and portrait rulings)
  sits chronologically inside the `T124..T149` geometry stage, so my two ranges OVERLAP in event
  order. I kept them separate because merging them would bury the portrait ruling, and I let the
  overlap stand rather than hide the spec's open question 2 ("what a stage is") behind a tidy
  sample. Writers will see overlapping ranges are permitted.
- `T86`, `T87`, `T88`, `T95`-`T99`, `T126`, `T197` do not appear in any range endpoint. The ranges
  run over the task's own event order between their endpoints, so those turns are INSIDE a range
  without being named. A reader who wants them uses the range address.
