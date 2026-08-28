# 03 — The decision tier seats what the graph cannot see

**What to build:** the milestone election gains the four-arm study's winning
arm: a new identity tier between index-declarers and indexed-by-elected
admitting turns whose `type` array intersects `{design, correction}`. USER
approval [S15069/T1951] after the round-2 ablation
(.scratch/milestone-election-study/round2/) validated it as the only arm
with measurable effect: E60 dev MUST capture 0.45→0.63, NO contamination
0.17→0.06, McNemar p=0.039; passively evicts all six backfill-dispatch
false positives with zero lexical rules; seats user-ruling rows 4→10.

**Blocked by:** none (parallel to phase-connectivity 01/02 — different
territory: `src/shared/milestone-election.ts` + its tests).

**Status:** resolved — landed as `211524d`; every criterion re-checked
per-item; reviewer independently re-rendered both real cards and diffed
seated sets against frozen arm C: E60 68/68, E70 78/78, zero divergence.
All six backfill rows out, all 10 ruling rows in. Worker's 4 mutation
cycles verified from report; the worker's REFUSAL to commit bundles from a
shared tree carrying the sibling worker's unfinished code was correct and
is the E60 shared-tree lesson applied. POST-LANDING EXPLORATION (arms F/F′/
H, .scratch/milestone-election-study/round2/): F graph-first four-tier lost
−10 MUST p=0.006 (rulings are graph sources; fan tier outranked type tier
and starved it); F′ byte-identical to F; H global type-first within-tier
sort lost −3/−2 (type is a good ADMISSION signal and a bad WITHIN-TIER key —
it overwrites what the identity tier already asserted, evicting a labeled
MUST ops closer for unlabeled design declarers). C stands as shipped; arm G
(fan corridor beneath C) deferred until phase connectivity thickens the
edge substrate.

## Decisions (settled)

1. **The tier predicate and position are EXACTLY arm C's validated diff** —
   `.scratch/milestone-election-study/round2/frozen/arm-diffs.txt` (ARM C
   section) is normative: tier type widens, `"type-decision"` reason between
   `declares-index` and `indexed-by-elected`, admission = `type ∩ {design,
   correction} ≠ ∅` on the raw type array. Do not reinterpret; port the diff
   onto HEAD (the study ran at ab60f11; HEAD has moved — reconcile
   mechanically, semantics identical).
2. **The share sentinel** (C's acceptance guard against type dilution): the
   election exposes, per run, the decision-tier candidate share
   (decision-tier candidates ÷ eligible candidates, per segment side).
   A worker-log WARN fires above **45%** (named constant, doc comment citing
   the round-2 measurement: current share 32-39%; past ~half the tier stops
   discriminating). Definitions pinned here per the peer's demand: the
   DENOMINATOR is the same eligible-candidate set the election ranks
   (post era/liveness filters); COMPOUND nodes (landing+basis) COUNT — a
   genuine compound entering the tier is a correct outcome, not pollution
   (phase-connectivity ticket 01's own language).
3. **Tier names/reasons render wherever tier reasons already render**
   (study tooling, any debug surface) — no new user-facing surface.
4. **Out of scope:** arm B (corrector promotion — undecidable on this
   corpus, revisit when a segment's budget boundary lands in its range);
   arm D weights; E′ transit (deferred until phase connectivity thickens
   the grounds channel); tier③'s deadness under C (observed, accepted —
   do not remove the tier, it self-revives if the decision tier thins).

## Acceptance criteria

- [x] The tier seats design/correction-typed turns between declarers and
      indexed-by-elected — asserted on a fixture where the same turn would
      previously land tier⑤.
- [x] Real-DB smoke (read-only): E60 and E70 cards re-rendered; the seated
      sets match round-2 arm C's cards (modulo turns settled since the study
      snapshot — name any divergence and account for it by data drift, not
      logic).
- [x] The six backfill-dispatch rows do not seat; user-ruling rows seat as
      the study measured — spot-asserted on the real card.
- [x] Share sentinel: computed per segment side, WARN above 45%, compound
      nodes counted — asserted on fixtures either side of the threshold.
- [x] Every new/changed test mutation-verified (backup after implement,
      needle-assert + print, red, md5 restore, green).
- [x] `npx tsc --noEmit` clean, `node scripts/build.js` succeeds, `bun test`
      green; baseline 3978/0 — account for every delta.

## Notes

Production DB strictly read-only. Do not tick your own boxes — report
per-item; the reviewer ticks. NB the study's harness snapshot predates
HEAD's tickets 15-17; the arm diff applies to `milestone-election.ts` which
those tickets did not touch — expect a clean port, but verify.
