# 05 — 选举过渡映射(计分本体仍未裁)

**What to build:** The election keeps running through the rename with its
semantics mapped 1:1 and its two accepted interim distortions PINNED as
facts, not fixed: edge-signals' refines key reads `extends`; the encodes key
reads `grounds` — which means the 26 old grounded-on edges (previously
unscored) begin crediting, and `narrows` scores nothing until the scoring
pass rules. Override zeroing (all-phase) and the evidence-source skip carry
over unchanged. Nothing else about scoring changes — the scoring pass on the
built graph owns everything further (.scratch/anchoring-eval/
scoring-rulings.md is its dossier).

**Blocked by:** 02.

**Status:** ready-for-agent

- [ ] Key remap tests: an extends excess edge buckets exactly as refines
      did; a grounds edge increments the old encodes count key.
- [ ] Distortion pins: a pre-existing grounded-on-shaped grounds edge now
      credits (named as interim in the test's comment); a narrows edge
      moves no bucket.
- [ ] Carry-over pins: override zeroing all-phase; evidence-source
      stance-edge skip still explicit.
- [ ] Scoring dossier gains the interim section reference (one line).
- [ ] Full `bun test` green except the sanctioned stale-bundle guard.
