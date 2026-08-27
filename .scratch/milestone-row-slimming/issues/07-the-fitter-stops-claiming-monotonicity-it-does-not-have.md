# 07 — The fitter stops claiming a monotonicity it does not have

**What to build:** the milestones budget fitter's binary search over K keeps
its speed but stops resting on a false premise. Its own comment asserts that
admitting one more candidate "can only ADD lines"; that is not true, and the
comment is the defect most likely to hurt — it will talk the next maintainer
out of investigating a real symptom. Replace the claim with the truth, and add
a cheap bounded forward probe so the realistic non-monotone case cannot cost
seats.

**Blocked by:** 06 — same file, adjacent code; serialize.

**Status:** resolved — landed as `27f6375`; every criterion re-checked per-item
and independently spot-verified (suite 3938/0, `tsc` clean, real E70 card
unchanged at 60 rows / 6833 chars, render cost 15.1 ms). Criterion 1 was NOT
blocked: the worker built a real displacement fixture where cost(K=25) = 513 <
cost(K=24) = 542, and criterion 2 showed the unfixed search reporting K=23
against the fixed search's K=25 at budget 700 — two real seats recovered.

KEY FINDING, and it strengthens the reviewer's 420-render null result rather
than contradicting it: **a single displacement can never net-decrease total
cost.** Swapping a long cross-session antecedent address for a short
same-session one saves ~1–2 tokens, while every admitted candidate adds its own
full row at ~15–30. The fixture had to amplify — 20 citer rows sharing one
displaced target — to make the total go down at all. So the defect is real,
constructible, and structurally rare, which is exactly why the production
corpus showed zero divergence. `PROBE_WINDOW` = 3 is the worker's judgment
call (the worst-case fixture needed 2; 3 buys a margin at ≤3 extra
`buildRows` calls, no measurable cost on E70).

## Why

GPT peer review of the 01–04 series, 2026-08-28, finding 1. The counter-example
is real: a row's `↳` antecedents are sorted by `(sessionId, promptNumber)` and
then capped at `MILESTONE_ANTECEDENT_CAP`, so admitting a new candidate can
insert a SHORT antecedent address (`T5`, same session) into an already-full
bucket and displace a LONG one (`S15440/T1023`), while the `+N` fold counter
stays the same width. The row gets shorter. Cost is therefore not monotone in
K, and a binary search over a non-monotone predicate can settle on a K smaller
than the true maximum — fewer seats than the budget affords, and a
`demotedCount` overstated to match.

**But the reviewer measured it and it does not bite.** A differential run
replacing the binary search with an exhaustive scan produced byte-identical
output across **all 70 live segments × 6 budgets (2000/1500/1000/700/500/300)
= 420 renders**. Meanwhile exactness is expensive: the exhaustive scan costs
**638.8 ms per E70 card render against the binary search's 14.5 ms** (44×) —
multiplied by up to three attached segments and the demote ladder's re-renders,
that is seconds added to every SessionStart. Exactness is not worth buying at
that price.

So this ticket is deliberately modest: tell the truth in the comment, and buy
the cheap 90% of the protection.

## Decisions (settled — implement as given)

1. **Keep the binary search as the primary strategy.** Exhaustive search is
   rejected on measured cost (44×, numbers above). Do not "fix" this by
   scanning.
2. **Correct the comment.** It currently states monotonicity as a fact and
   gives a wrong reason for it. Replace with: the cost is *usually* monotone;
   it can decrease when a newly admitted candidate displaces a longer
   antecedent address out of an already-capped `↳` bucket; the binary search
   is retained anyway because a differential across the whole production
   corpus found no divergence and exactness measured 44× slower; the forward
   probe below covers the realistic case. Name the displacement mechanism
   concretely so the next reader can recognise the symptom.
3. **Add a bounded forward probe.** After the binary search settles on
   `bestK`, try the next few K values (a small fixed window — pick the number,
   justify it, keep it a named constant) and adopt the largest that fits. This
   catches the single-displacement case, which is the only one anyone can
   construct. Cost is a handful of extra `buildRows` calls; report the measured
   per-render time after (before: 14.5 ms on the real E70 card).
4. **The probe never overshoots.** A K is adopted only if its built rows
   actually fit the budget — same condition the binary search already uses.
   Under-filling is the safe direction; overshooting is not.
5. **Out of scope:** the antecedent cap and its sort key; `demotedCount`'s
   definition; election tiers (ADR-0013); ticket 06's budget allocation; any
   version bump or push.

## Acceptance criteria

- [x] A fixture that actually exhibits the displacement — admitting candidate
      K makes an already-admitted row SHORTER by pushing a long cross-session
      antecedent address out of a capped `↳` bucket — is constructed, and the
      report shows the two costs proving cost(K) < cost(K−1). If after a
      genuine attempt no such fixture can be built, say so plainly and explain
      what blocked it; do NOT fabricate one that merely looks like it.
- [x] On that fixture, the forward probe seats the extra row(s) the bare
      binary search would have dropped — asserted with both K values.
- [x] The probe never returns rows exceeding the budget — asserted on a
      fixture where the K values just past `bestK` do NOT fit.
- [x] Real E70 card output is unchanged by this ticket (60 rows, 6833 chars) —
      asserted or reported from a read-only render.
- [x] Per-render time reported for the real E70 card; the probe's added cost
      stated as a number, not as "negligible".
- [x] The corrected comment names the displacement mechanism, the measured
      differential (420 renders, no divergence) and the 44× cost that made
      exactness the wrong trade — so the next reader inherits the evidence,
      not just the conclusion.
- [x] Every new/changed test mutation-verified: name the observable, back up
      AFTER the implementation lands, assert the needle matched and PRINT that
      it applied, red, restore byte-identical (md5), green.
- [x] `npx tsc --noEmit` clean, `node scripts/build.js` succeeds, `bun test`
      green; report the number and account for every delta.

## Notes

Production database strictly read-only. Do not tick your own acceptance boxes —
report per-item; the reviewer ticks. If the fixture in criterion 1 proves
genuinely unconstructible, that is a legitimate finding and the ticket still
closes on the remaining criteria — an honest "I could not build it, here is
why" is worth more than a fixture that passes without exercising the defect.
