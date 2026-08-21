# 03 — 选举护栏:新格边入图不入选举

**What to build:** After ticket 01, evidence-source refines edges exist in the
graph, but the milestone scoring key (refinesExcess) buckets only decision and
delivery sources. This ticket makes the boundary EXPLICIT and pinned: a
refines edge whose chosen source phase is neither decision nor delivery is
skipped at scoring time — no crash, no miscount, no accidental bucket — and
stays fully visible in every graph read. The other two scoring behaviours are
confirmed all-phase by test, not by assumption: an E→E override still zeroes
its target out of the election (existing all-or-nothing semantics), and an
L→E encodes still credits its target (encodesCount aggregates regardless of
target phase).

Ruling context (spec.md): the evidence bucket's existence and weight belong to
the scoring-trio redesign on the backfilled graph — this ticket only guarantees
the interim is deterministic and harmless.

**Blocked by:** 01.

**Status:** ready-for-agent

- [ ] A test inserts an E→E refines edge and asserts the target's
      refinesExcess is unchanged in both buckets (graph-visible,
      election-invisible).
- [ ] A test pins E→E override zeroing the target out of milestone selection.
- [ ] A test pins L→E encodes incrementing the target's encodesCount.
- [ ] Full suite green except the sanctioned stale-bundle guard.
