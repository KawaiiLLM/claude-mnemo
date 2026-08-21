# 02 — 词表与校验器翻转(expand 半 + 数据改名)

**What to build:** The eight-word vocabulary goes live end-to-end: the
memory_edges CHECK EXPANDS to old∪new words (the contract half is ticket 03);
a schema migration renames stored data (depends-on→consume,
evidence-for/-against→verifies/refutes, grounded-on→grounds,
refines→extends — blanket, T906/T952/T913 deliberately included per the
T1202 ruling; encodes merges into grounds); the validator replaces the
nine-cell table with the six-row law (spec.md); the note tool's relation and
retraction parameters rename to the eight words; receipts gain the grounds
mid-flow WARNING carrying the settlement's address; the collects
flow-membership HARD CHECK (the one graph-state rejection) rides ticket 01's
module behind a thin DB reader; self-citation becomes grounds-only at
settlement+implementer; the segment-crossing warning (dcd17fe) retires, its
composer pattern reused for the new warning.

Six-row law (machine): override same-phase flow/layer-free · narrows/extends
decision-phase both ends · collects same-phase + targets ∈ this flow
(REJECT) · consume same-phase · grounds unrestricted · verifies/refutes
evidence-phase source. Self: grounds only, settlement+implementer. Rejections
keep the missing-half shape and now carry the phase requirements that left
the rubric (the validator is the teaching surface for mechanism).

**Blocked by:** 01.

**Status:** ready-for-agent

- [ ] Migration: renames + CHECK expansion, temp-name precedent, idempotent,
      dry-runnable on a temp DB; the real production run happens at
      release+reload only.
- [ ] Six-row legality matrix test (all words × phase/flow conditions,
      legal accepted AND illegal rejected naming the missing half).
- [ ] collects: in-flow targets accepted; out-of-flow REJECTED naming the
      flow; delivery collects rejected naturally (no flow).
- [ ] grounds at a mid-flow target STORES and warns with the settlement
      address; at a settlement, silent.
- [ ] Self-citation: settlement+implementer accepted; everything else
      rejected naming the failed condition.
- [ ] Old params gone from the tool surface; new 8+8 present; no teaching
      text mentions a retired word.
- [ ] Segment-crossing warning removed with its tests.
- [ ] Full `bun test` green except the sanctioned stale-bundle guard.
