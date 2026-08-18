# 07 — 计分信号层

**What to build:** 每 turn 可查询的边信号元组,供视图 spec 消费;不定权重、不碰渲染。

规范:`.scratch/turn-edge-mechanism/spec.md`「三条计分规则」+「不钉数值权重」。

- 信号:`overridden`(被 override 即真)、refines 超基线入度(入度−1,下限 0,按**来源阶段**分桶:决策/落地)、encodes 计数、depends-on 记录但不入信号。
- 查询层函数+测试,无任何渲染消费(消费是视图 spec 的验收,[S15069/T924])。

**Blocked by:** 01(词表与阶段派生)。

**Status:** done

- [x] 链表基线图上全员零信号;加一条跨越式 refines 后仅该节点上升
- [x] override 受害者 overridden=真
- [x] encodes 计数与来源阶段分桶各一条构造性测试
- [x] 无边图 = 全零(退化保证的信号层半边)

## Implementation record

New module `src/db/edge-signals.ts`: `getTurnEdgeSignals(db, turnIds)` — one
pass (three queries, independent of `turnIds.length`) returning
`Map<turnId, TurnEdgeSignals>` with every requested id present, defaulting
to the all-zero tuple; `getTurnEdgeSignalsForTurn(db, turnId)` is the
single-id convenience wrapper. No rendering, no numeric weight, no combined
scalar — `TurnEdgeSignals = { overridden: boolean; refinesExcess: {
decision: number; delivery: number }; encodesCount: number }`.

All three signals filter to LIVE (non-rolled-back) SOURCE turns
(`turns.was_rolled_back = 0` via a JOIN). The ticket states this explicitly
for `overridden` and `refines`; `encodes` carries the same filter too even
though the ticket text is silent on it for that bullet — a judgment call,
flagged below.

`refines` bucketing (the one genuinely underspecified requirement): each
target's live incoming `refines` edges are ordered by the edge's own
`created_at_epoch` (citing_id as deterministic tiebreak); the EARLIEST is
the baseline and contributes nothing; every edge arriving after it is
excess, bucketed by ITS OWN source's phase at query time (decision checked
before delivery, so a dual-phase source counts once, as decision — the
ticket's own documented choice). This makes "in-degree minus 1, floored at
0" a well-defined PER-EDGE operation instead of a single scalar that would
need an invented rule for which phase "absorbs" the baseline when sources
are mixed — the alternative reading (subtract 1 from the total, then split
across phase buckets) has no non-arbitrary apportionment rule and would
itself be an uncommitted numeric weight, which "不钉数值权重" rules out.

`RELATION_IS_SCORED: Record<TurnEdgeRelation, boolean>` is the compile-time-
exhaustive scoring decision over the seven-word closed set (only
`refines`/`override`/`encodes` are `true`) — an eighth word joining
`EDGE_RELATIONS` without an entry here is a TypeScript error, not a
silently-passing test. The runtime guard test in
`tests/db/edge-signals.test.ts` mirrors it and additionally proves,
behaviourally over a real graph, that `grounded-on`, `evidence-for`,
`evidence-against`, `depends-on`, and the frozen-legacy `supersedes`
(outside `EDGE_RELATIONS` entirely) all move zero signal.

Tests: `tests/db/edge-signals.test.ts` (new, 9 tests) — linked-list baseline
(all zero), one leapfrog refines (only that node rises), a dedicated
source-phase-bucketing test (decision-sourced + delivery-sourced +
dual-phase-counted-once-as-decision in one graph), override victim
(live vs. rolled-back attacker), encodes count (live vs. rolled-back
source), unscored-relations-contribute-nothing, the
`RELATION_IS_SCORED` guard, empty/dangling-id graph, and the single-turn
wrapper. Mutation demo: disabled the baseline-skip (`seenForTarget === 1`
→ `=== 0`, so the earliest edge stopped being excluded) — 3 tests went red
(`refinesExcess.decision` off by exactly 1 in each), confirming they
actually exercise the baseline exclusion; restored, 9/9 green again.

**Judgment calls (flagged, not silently decided):**
1. `encodes` filters rolled-back sources even though the ticket only says
   so explicitly for `overridden`/`refines` — applied for consistency (a
   rolled-back turn's assertions are void regardless of which relation they
   carry). If a future consumer wants a dead turn's `encodes` to still
   count, this is the line to revisit.
2. `refines` baseline exclusion is by EARLIEST EDGE (temporal order), not a
   scalar excess apportioned across phase buckets by some other rule — see
   above. This is the reading that avoids inventing a weight; the spec text
   is compatible with either grammar.
3. Bucket assignment reads a source's phase LIVE (current `type` column at
   query time), not as it stood when the edge was written — matches
   `phasesForTypes`'s own "derived, never pinned" philosophy elsewhere in
   this codebase. A source with neither decision nor delivery phase present
   (type edited away, or empty) contributes to neither bucket rather than
   erroring.
