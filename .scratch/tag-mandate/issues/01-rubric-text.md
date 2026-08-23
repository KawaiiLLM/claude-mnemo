# 01 — The rubric text carries the mandate, the lane laws and the campaign rulings

**What to build:** the Memory Rubric text (the injected constitution) gains
every amendment the spec rules, inside its hard token budget, with each
amendment guard-pinned. Spec: `.scratch/tag-mandate/spec.md` — sections
"Rubric text (the constitution)" and "Production-campaign amendments"
(R1-R4). The amendments:

1. extends/narrows MUST carry lane tags (assertions only — retraction is a
   write-surface matter, not rubric text).
2. Lane shape: exactly one source and one sink; diamonds legal, dangling
   parallel heads/tails illegal; any node may start/end multiple lanes.
3. Branch v3: B branches A when B starts inside A and B's tags ⊋ A's tags;
   exact set = reopen.
4. Cross-lane correction idiom (branch rooted at the corrected node).
5. Identity uniqueness: one exact set names one lane — no disconnected
   components, no cross-phase; membership from the tagged-edge DAG, never
   noun-carrying.
6. Whole-lane phase p; no multi-type phase laundering.
7. R1 dead node = global override only, victim-as-core under the content
   condition; R2 consume same-phase / grounds cross-phase as general law;
   R3 completion-vs-correction boundary sentence; R4 the phase-split idiom.

**Blocked by:** None — can start immediately.

**Status:** done (mutation-verified: mandate weakened → 1 red, R3 body flipped → 1 red; suites re-run green after the sibling-mutation tree repair; v10 kept per precedent — hash is the drift guard; both deliberate deletions ratified)

- [ ] Every amendment present with meaning intact (compression is free,
      loss is not); the existing text's unrelated pins survive
- [ ] Total ≤ the 9500 budget pin; guard tests updated with one pin per
      amendment; hash change acknowledged in tests
- [ ] Load-bearing properties declared for mutation acceptance
