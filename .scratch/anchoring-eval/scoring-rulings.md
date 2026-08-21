# Scoring rulings — inputs to the pending scoring-trio ruling

These are **not new scoring mechanics**. They are the five rulings the
relation-matrix spec recorded in passing while it settled the *grammar*
(which word is legal where) — transcribed here verbatim so the scoring-trio
ruling (ADR-0009's open item: an out-degree key, the override victim's
treatment, `grounded-on` as a fourth election key) starts from the ruled
text on the backfilled graph, not from memory. Nothing here changes
`edge-signals.ts`.

Source: `.scratch/relation-matrix/spec.md`, ruled S15069/T1163–T1180,
2026-08-21.

## Verbatim (spec.md, "Constraints and dispositions")

> **计分五裁决**(转录入计分三改档案;幅度/排序与取证桶留给三改):
> override 归零(已是现行实现)、refines 加分、encodes 加分、depends-on
> 不涉分、自引边参与计分。

> **新格边的选举可见性**:入图但暂不入选举——refinesExcess 只有决策/落地两桶,
> 非此两相的 refines 源在计分处显式跳过(不崩不误计),等三改在回填后的真图上裁。
> override 归零与 encodes 加分全相位立即生效(现行实现已通用)。

## The five rulings, with source turns

1. **`override` zeroes the target's score.** Already the live implementation
   (`edge-signals.ts`, all-or-nothing). Confirmed all-phase and effective
   immediately — no waiting on the scoring trio — at [S15069/T1169]
   ("override 归零不用等:已是现行实现且全相位通用").
2. **`refines` credits the target's score.** Ruled in the guarantee-ladder
   table at [S15069/T1165] ("refines | ... | 被引 **+分**"), held in the
   final same-phase-diagonal form at [S15069/T1166].
3. **`encodes` credits the target's score.** Ruled at [S15069/T1171] (Q3
   closed: "被 encodes 的节点都会加分...于是最小集纪律的本质从「可读性」
   升格为**策展纪律**"), row-wide — L→D and L→E share one discipline, both
   effective immediately.
4. **`depends-on` is scoreless — transparent to election.** Ruled in the
   same guarantee-ladder table at [S15069/T1165] ("depends-on | ... | 不涉"),
   held at [S15069/T1166].
5. **Self edges participate in scoring.** A self-`encodes` increments the
   citing turn's own `encodesCount`. Ruled at [S15069/T1180] ("多 type 可以
   自引用,并参与计分"), **overruling** the standing isolation
   recommendation floated at [S15069/T1178] (which had proposed self edges
   follow the same graph-visible-but-election-invisible pattern as the
   evidence-source `refines` boundary below).

## The boundary note: evidence-source `refines` is skipped at scoring

An evidence-source `refines` edge (an E→E cell this spec newly legalizes) is
graph-visible but **skipped at scoring** — `refinesExcess` buckets only
decision- and delivery-phase sources; the evidence bucket's existence and
weight are left to the scoring-trio redesign on the backfilled graph. This
was confirmed as an explicit, tested skip (not an accidental omission) at
[S15069/T1169] (the question raised) and [S15069/T1171] (closed: "新格边入图
但对选举暂不可见"), and pinned by a test in ticket 03 (election guard,
landed f09dc3a). `override` zeroing and `encodes` crediting needed no such
boundary — both were already all-phase in the live implementation.

## Peer design-review inputs (S15069/T1190, ruled out-of-scope for the
## infrastructure phase at T1192 — tune WITH these on the built graph)

1. Self-encodes incentive: in-degree stops being pure third-party testimony
   once judge and beneficiary coincide; multiplies with the ruling-supplement
   rule (ruling-carrying reviews are forced dual-phase). Measured: 24/98
   dual-phase turns in the rebuilt window vs an encodes in-degree
   distribution topping out at 3. Self rows stay separable forever
   (citing_id = cited_id). User held T1180 as ruled: curation discipline
   governs, no separate counter.
2. Override zeroing is live in all nine cells while new-cell refines
   crediting waits — an asymmetry from implementation happenstance, not
   ruling. Candidate: scope zeroing to pre-matrix cells until the trio rules
   both sides together.
3. The anchoring eval's pre-registered differential assumed evidence turns
   score nothing under the current keys; L→E encodes now credits them, so
   the control arm must be re-defined (baseline excluding L→E encodes)
   when the eval runs — else the fourth-key question fails as
   looks-like-success.
4. Fork topology piles refines in-degree on origins (measured: T900←3 is
   the only >1; the converging T913 sits at 0). User ruling at T1192-era:
   origins and termini do not conflict — the TERMINUS scores through
   encodes in-degree; no terminus key needed.
5. Weak L→D ties (caused-by, not carrying) have only encodes, which
   credits — honest writers stay silent, and silence is indistinguishable
   from no-relation. Live examples: T902→T900 (the inventory a spec caused;
   legal only because the peer retyped T900 +ops to unlock depends-on) and
   T918→T916 (still edgeless today). Candidate: credit encodes from
   ops-typed sources only — touches the T1171 all-encodes-credit ruling,
   trio's call.

## Status

Ruling 5 (self edges participate) is the one exception to the
graph-visible/election-invisible default described above — it is scored
immediately rather than waiting on the trio. Everything else in this file
— which cells score, by how much, and in what order — is exactly what the
scoring-trio ruling still has to decide. This file records the five
`what` decisions already made; it makes no claim about magnitude, ranking,
or the evidence bucket's weight.
