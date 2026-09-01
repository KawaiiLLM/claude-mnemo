# Validator refusals — every writer rejection, what caught it, what the writer did

Validator: `validateImpression()` from `src/shared/lane-impressions.ts` at HEAD, run unmodified
through `experiments/validate.ts`. Source was never edited.

Arm 1's artifacts preserve no refusal log, so arm-1 refusals are UNKNOWN, not zero. Only its final
accepted texts survive. Both arm-1 finals re-validate clean at their stated caps.

## Refusal 1 — arm 2, delivery lane (`#latency-budget`), cap 100

    REJECT[total-cap]  impression is 101 tokens, over its 100-token cap
    REJECT[line-1-cap] line 1 is 101 tokens, over its 100-token cap (min of 150 and the lane cap 100)

One token over. Handed back to the same writer, as production does. Regenerated to 84 tokens,
accepted.

**What the trim cost — this is a finding, not bookkeeping.** To shed 17 tokens the writer deleted:

- `— legs reallocate only via new ruling` → **L-C2, the lane's actual governing law.** The ruled
  split without the never-grow rule is half a law: it reads as three numbers, not as a budget.
- `in-budget` from the capture clause → capture's *measured* proof (p50 9ms / p99 18ms inside its
  25ms leg) becomes an unqualified "committed".
- `integration` from the T57 clause → survived in substance; `unwired, open` still carries the
  not-integrated state, and all three blind readers read it correctly. This one was harmless.

Both first two deletions showed up downstream in the reader data (axis 1 Q2 dropped to 0.5/3 for
this lane; one reader under-read capture as "committed but not verified within budget"). **A writer
under cap pressure sheds state qualifiers and governing law first, because they are the clauses
that carry no proper noun.** Worth watching in any arm that tightens a cap.

## Refusal 2 — arm 2, r3, `#visual-style`, cap 280

    REJECT[total-cap] impression is 335 tokens, over its 280-token cap
    REJECT[line-cap]  line 2 is 72 tokens, over the 60-token per-line cap
    REJECT[line-cap]  line 5 is 71 tokens, over the 60-token per-line cap

The whole payload is fenced together, so this refused the map lane too. Handed back; the writer
kept the (clean) map lane byte-identical and recompressed visual-style to 260 tokens, accepted.
No governing law or state qualifier was lost in this trim — the writer cut restatement.

## Arm 3 — zero refusals

Six arm-3 lane-writes, no rejection. The 150-token cap was never hit: the three finals land at
145 / 141 / 135. Two arm-3 writers reported sizing against a `cl100k_base` proxy and aiming for
margin — they self-throttled well under the real o200k cap rather than risking a refusal.

## Tally

| arm | lane-writes | refusals | rules fired |
|---|---|---|---|
| 1 | 7 (3 rounds × 2 lanes + delivery) | unknown (not preserved) | — |
| 2 | 7 | 2 | total-cap ×2, line-1-cap ×1, line-cap ×2 |
| 3 | 7 | 0 | — |

The validator never fired on `delivery-anchor`, `anchor-format`, `anchor-unresolvable`,
`structure` or `line-count` in any arm, and emitted no `sequence-word` warning. Every rejection in
this experiment was a SIZE rejection. The semantic tier — whether an anchor proves the state its
sentence claims — is exactly what stayed uncaught, which is what the module's own header says it
is for.
