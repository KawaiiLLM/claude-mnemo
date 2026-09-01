# Validator refusals — every writer rejection, what caught it, what the trim cost

Validator: `validateImpression()` from `src/shared/lane-impressions.ts` at HEAD, run unmodified
through `experiments/validate.ts` (a copy of the prior run's harness with lane D's session added to
the resolved-anchor set; the import is from HEAD and no `src/` file was touched).

Writer model: `sonnet` for every writer in both arms, matching the prior ablation.

## Tally

| arm | lane-writes | refusals | rules fired |
|---|---|---|---|
| INDEX (treatment) | 8 (r2×2, r3×2, r4×2, delivery, lane D) + 3 second draws | **2** | `total-cap` ×2 |
| CONTROL on lane D (synthesis, new) | 2 | **1** | `line-cap` ×1 |
| CONTROL on lanes B/C | reused from the prior run — 2 refusals, both `total-cap`/`line-1-cap`/`line-cap`, logged in `.scratch/lane-impressions/experiments/grading/refusals.md` | — | — |

**Every refusal in this experiment was again a SIZE refusal.** `delivery-anchor`, `anchor-format`,
`anchor-unresolvable`, `structure` and `line-count` never fired in either arm. Two
`sequence-word` warnings fired (never rejections). The validator caught no state defect and no
in-force defect, which is what its own header says it will not do.

---

## Refusal 1 — INDEX, lane D (`#wire-format`), cap 200

    REJECT[total-cap] impression is 272 tokens, over its 200-token cap

7 lines, one stage per turn, per-line `[37, 34, 28, 52, 43, 41, 31]` — every line inside the
60-token per-line cap. The LINE bound was never the problem; the TOKEN cap was, which is spec
defect 2 (below) firing on its first contact with a real lane.

Handed back to the same writer, as production does. Regenerated to 196 tokens / 6 lines,
accepted — by MERGING the two oldest stages (`T12` + `T19` → `T12..T19`), which is the form's own
overflow rule doing its job.

**What the trim cost.** Comparing refused text to accepted text:

- `T34`: `zstd-19 vs gzip-6 benchmarked ... 2.9x faster, 31% smaller` → `zstd benchmarked against
  gzip as an evaluation only, faster and smaller`. **The numbers went.**
- `T23`: `214 tests, 2M-case fuzzer clean` → `tests and fuzzer clean`. **The numbers went.**
- `T44`: `no ticket owns it` deleted; `tested on 200MB in /tmp` → `tested on a sample in tmp`.
- **Nothing else went.** `EVALUATION ONLY`, `T12's ruling still governs`, `the zlib constraint was
  never rechecked`, `nothing wired in`, `gzip remains the only accepted encoding`, `string form
  removed, no compat window`, `atomic, no streaming` — every law and every state qualifier
  survived verbatim.

This is the **OPPOSITE** of the prior ablation's refusal finding. There, "under cap pressure a
writer sheds the clauses that carry no proper noun — laws and qualifiers first, named artefacts
last." Here the index writer shed the named quantities and kept the laws. One observation, not a
law of its own, but it is the single cleanest thing the index form did in this run.

## Refusal 2 — INDEX, r4, `#map-data-extraction`, cap 110

    REJECT[total-cap] impression is 162 tokens, over its 110-token cap

3 lines, per-line `[63, 46, 51]`. Note line 1 at **63 tokens is legal** — see the line-1 artifact
below. Handed back; regenerated to 96 tokens / 2 lines by merging `T101..T103` into `T93..T99` →
`T93..T103`, accepted.

**What the trim cost — and this one shows up directly in the reader data.**

- **`Opus worker delivered mapA.json` was DELETED.** That is key item **D-B3**, the lane's one real
  delivery. Consequence: 0 of 5 index readers named the mapA.json conversion as delivered;
  5 of 5 control readers did (`"mapA converted to mapA.json + tools/ (T102) — done"`).
- `two 1025x1024 vertex blocks, 62 quantized steps` and `4.0 lattice px/cell` deleted — numbers
  again.
- `SHEX binary map format cracked` survived; `odd-r hex adjacency locked 42/42 vs 0` survived.

So: laws survived, a DELIVERY did not. Different loss class from the control's, equally real.

## Refusal 3 — CONTROL (synthesis) on lane D, draw 2, cap 200

    REJECT[line-cap] line 2 is 64 tokens, over the 60-token per-line cap

Total was 182/200; only line 2 was over. Handed back; line 2 recompressed from 64 to 51 tokens,
accepted. The trim deleted `on production data` and `a migration script exists only as a /tmp
exercise, nothing wired in, no ticket owns a cutover` → `Migration script is /tmp-only, unwired,
unowned`. No law and no state qualifier lost; pure compression. Harmless.

---

## The line-1 cap is not merely subjectless in this form — it is an ACTIVE ARTIFACT

The spec says line 1's ≤150 cap "has no subject any more". That understates it. At HEAD the caps
are `line 1 ≤ min(150, cap)` and `lines 2+ ≤ 60`, so **in the index form line 1 is the only line
allowed to exceed 60 tokens**, and by a wide margin:

| text | line-1 tokens | would it be legal at position 2? |
|---|---|---|
| index r4 `#map-data-extraction` (refused draft) | 63 | **NO** |
| index r4 `#visual-style` (accepted) | 60 | just barely |
| control lane D draw 1 (accepted) | 140 | **NO** |

The index form makes line 1 the NEWEST stage. So the rule now says: *the newest stage may be up to
150 tokens; every older stage is capped at 60.* Nothing in the form justifies that, and it silently
rewards stuffing the newest line. **My sample's first draft had a 63-token line 1 and passed; I
trimmed it to 59 precisely so the sample could not teach that habit.**

No refusal in this run was *caused* by the line-1 rule, so its refusals were not "meaningful" —
but the rule is not inert either. It is a live, position-dependent size privilege in a form that
declares no line is special.

## Spec defect 2, observed

The spec says the bound is line count, not tokens, while keeping `clamp(10 × settledMembers, 100,
500)`. Both index refusals were `total-cap` with every line inside the 60-token per-line cap and
the line count inside 8. **The token cap bit first, every time, and the line bound never bound at
all.** On the 100-cap lanes the index could afford 2-4 stages; the "≤8 lines" bound is unreachable
below a 480-token cap. Reported, not worked around.
