# 01 — 校验器开九格

**What to build:** An `E→E refines` write that today rejects becomes legal — and
so does every other cell of the matrix (spec.md in this directory), while every
formerly-legal edge class stays legal (pure relaxation, zero retightening).
The validator's phase-legality table rewrites to the two reading rules:
same-phase diagonal admits refines/override/depends-on; cross-phase admits the
source row's word (evidence pair from 取证, grounded-on from 决策, encodes from
落地). The note tool's seven relation parameter descriptions teach the same law
in the same change — the tool must never teach a stricter or looser grammar
than the validator enforces.

The five relaxations, exhaustively: refines/override open from D→D to all three
diagonal cells; depends-on opens from L→L to all three diagonal cells; the
evidence pair's target widens from D to D|L; encodes' target widens from D to
D|E. grounded-on (D→E|L) is unchanged. The stored relation WORDS are unchanged
— no schema migration, the memory_edges CHECK list already admits all seven.

Multi-type turns keep the existing set rule: a phase pair is legal if ANY
(source type, target type) pairing satisfies the cell.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] A legality matrix test covers all nine cells × all seven words — each
      cell asserts its legal words accepted AND its illegal words rejected
      with the rejection naming the missing half.
- [ ] Every pre-matrix legal class (E→D evidence, D→E|L grounded-on, D→D
      refines/override, L→D encodes, L→L depends-on) still passes — pinned as
      its own regression block.
- [ ] The seven relation parameter descriptions on the note tool state the new
      phase law; no description mentions a retired constraint.
- [ ] Full suite green except the sanctioned stale-bundle guard.
