# 04 — E5: a lane with more than one source or sink is an error anchored at the violating node

**What to build:** the checker's error block gains E5 — for each lane
(same segment, exact tag set), more than one source (node with no incoming
in-lane edge) or more than one sink (node with no outgoing in-lane edge)
produces one error instance per EXTRA source/sink, anchored at the
violating node. Diamonds (parallel paths that re-merge) are legal and
produce nothing. Spec: `.scratch/tag-mandate/spec.md`, error table row E5.

Consequence to preserve in tests: two disjoint same-set chains form ONE
lane with two sources and two sinks — four error instances, which is the
component-emergence principle hardened into a constraint (repair = retag
one chain or bridge them).

**Blocked by:** 03 (the errors block infrastructure).

**Status:** done (mutation-verified: domain narrowed to stance words → 8 red; canonical comparator degraded to bare tuple → 11 red; instance-count reading = one per EXTRA end (the ticket prose said four, the normative paragraph and the implementation say two — ticket prose was the error))

- [ ] Disjoint same-set chains fixture → the expected instances at the
      expected anchors; diamond fixture → zero
- [ ] Golden T900-1001 reports zero E5 (STOP-AND-REPORT on discrepancy)
- [ ] Both surfaces render E5 in the errors block
- [ ] Load-bearing properties declared for mutation acceptance
