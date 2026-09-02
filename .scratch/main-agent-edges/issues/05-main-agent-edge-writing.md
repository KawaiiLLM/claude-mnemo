# 05 — The main agent writes edges

**What to build:** spec D3. The Memory Rubric's main-agent actions half gains the edge duty in two sentences (what this turn used, corrected or verified — the cited turn's principal result, not a detail; correct > verify > use; one edge per pair; the caps); the public `note` accepts bare three-class entries (03's union) and refuses two-sided ones; the tool description teaches the form; the rubric's byte-pinned source under `.scratch/lane-model-v12/` is updated with it (that file may be staged for this reason only).

**Blocked by:** 03.

**Status:** LANDED (tsc 0; 4800 pass / 0 fail / 267 files, +6 net accounted; `npm run build`, stale-bundle and release-artifacts guards green; 8 mutation probes RED and md5-restored). Peer implementation review requested. **VERIFIED S15069/T2439 at cd2d67cf (merged 2040b84f, no conflicts)**: tsc 0, 4729/0/267 (+6), guards clean; `边由结算书写` gone from the rubric (0 hits), the new sentence present. My probes (real mutations): the one-edge-per-pair clause dropped from the rubric → RED (2, incl. the byte pin); the note description's "NEVER read as an edge" weakened → RED (1). Accepted deviation: the concepts-half sentence was changed to 「边由引用方这一轮写下,结算补漏与复核」 because it ships into the same SessionStart block as the new duty; the two stale stored-side clauses beside it (`边的两端各带一个泳道 tag…`, `…诚实的那个泳道位置上…`) are named for ticket 07/06 adjudication. Settlement-prompt hunks (four, named) left for ticket 06 to absorb. One transient unreproduced 4799/1 run reported honestly by the worker.

- [x] Rubric sentences pinned; a mutation that drops the duty is red; the settlement teaching's "边由结算书写" sentence and its relatives revised to the new division (settlement declares, fills, reviews).

## Constraints

- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY; measure on a `cp -c` clone of the scratchpad copy.
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean`. Restore from your own `cp` copies, md5-verified.
- Explicit pathspecs on every `git add`. No raw control bytes. `grep -c anthropic-ai plugin/scripts/worker.cjs` stays `0`.
- Every teaching sentence added or removed is pinned by a test a mutation drives red. ≥3 mutation probes of your own, RED, md5-restored — and a probe whose mutation did not apply is not a probe.
- Dispose of every applicable line of `../acceptance-matrix.md` in your report.
- [x] `npx tsc --noEmit` clean (excludes `tests/`; typecheck new tests separately); full `bun test` once with every delta accounted; `npm run build`; stale-bundle and release-artifacts guards green; `git diff --check` clean. No version bump, no push.


---

## Report

### The rubric ACTIONS half — the edge duty, two sentences

Source `.scratch/lane-model-v12/rubric-v12-main-actions.md`, spliced into
`src/shared/memory-rubric.ts` by script (the byte-equality test pins the two as the
same bytes). ADDED, verbatim, in `## 记录 —— 管好每一轮`, immediately after
`**写什么由产出决定…**`:

> **写下这一轮用到、修正或验证了哪些更早的 turn。** 指向被引 turn 的主结果,细节不写;一对节点只写一条边,几类同时成立时取最具体的那一类(correct > verify > use)。
>
> **边上不写泳道 —— 归属由结算判定。** 一个 turn 至多 20 条出边、20 条入边。

The cap number is asserted against `MAX_TURN_RELATION_DEGREE` itself rather than typed as
a literal in the test, so the taught number cannot drift off the gate's own.

CHANGED, the half's preamble line:

- was: `你写的是每一轮的笔记:title、content、insight、type、tags。**边与泳道的声明归结算,任务的归属由 tags 自动决定。**`
- now: `你写的是每一轮的笔记:title、content、insight、type、tags,以及这一轮的边。**泳道的声明归结算,任务的归属由 tags 自动决定。**`

Nothing else in the half moved. The CONCEPTS half's definitions (三个关系类, 主结果,
the precedence, 充分引用) are untouched — v13 ticket 02 wrote them and the duty above
references them rather than restating them.

### The one CONCEPTS sentence this ticket did change

The checklist line names `边由结算书写` explicitly, and that string lives in the
CONCEPTS half — not in any settlement prompt (a sweep of `src/`, `plugin/` and
`.scratch/` found exactly two copies, the constant and its checked-in source). It is
injected into the MAIN AGENT at SessionStart, so leaving it would have had one block
teach the duty and forbid it eleven lines apart.

- was: `**边由结算书写。**`
- now: `**边由引用方这一轮写下,结算补漏与复核。**`

DELIBERATELY NOT TOUCHED, and flagged for adjudication: the two clauses around it are
still written in the STORED-SIDE model — `边的两端各带一个泳道 tag:引用方一端一个,被引用方一端一个。`
and `…存在它写下时判断诚实的那个泳道位置上,不按候选泳道逐个开行。` Under D2 a side is
RESOLVED (declared → unique → none) and stored only when ambiguous, so both are now
stale. Rewriting them is the resolution model's teaching, not this ticket's division of
labour, and it would collide with ticket 07's semantic rewrite of the side marks. A
first draft of this ticket folded the "only-when-ambiguous" clause into the sentence
above and was backed out for exactly that reason: it contradicted the two clauses it sat
between. The actions half carries the main agent's half of the fact instead
(`边上不写泳道`), which is consistent with the surrounding concepts text as it stands.

### `note`'s tool description (`src/mcp/definitions.ts`)

One line replaced, whole:

- was: `This tool ordinarily writes five fields — title, content, insight, type, tags. Edges (correct/verify/use and their retract… mirrors) are settlement's whole business normally — a hindsight judgment over the finished window — so you will rarely need them; the parameters stay here for when you do. A prose S15069/T332 still records that this turn REFERS to that one; it states no relation.`
- now: `This tool writes SIX things — title, content, insight, type, tags, and this turn's EDGES. correct/verify/use (with their retract… mirrors) are ROUTINE here: name the earlier turns this turn used, corrected or verified. Settlement no longer originates them — it declares an ambiguous lane side, fills what you missed and reviews. A prose S15069/T332 is a pointer for a human reader: it is NEVER read as an edge, so a turn you built on needs an entry above.`

THE PROSE FORM IS NO LONGER TAUGHT AS A GRAPH MECHANISM. Ticket 03's expected delta left
`getEffectiveCitations` parsing the inline `[T<dbid>]` grammar alone, so a qualified
`S<n>/T<m>` in prose reaches no reader that builds edges. The old hedge ("it states no
relation") still let a caller read prose as a weak edge; the replacement says plainly it
is never read as one, and names the consequence (write an entry). Decided with the
rubric's own split: prose references are for readers, edges are the graph.

BUDGET. `tests/mcp/definitions.test.ts` caps this string at 450 `estimateTokens` tokens —
it sits in every request's cached prefix. The first draft measured 472; the paragraph was
trimmed (dropping "while you still know why", "and stops there", "what you wrote",
"actually", "rare") to 450 exactly. THE CAP WAS NOT RAISED.

The stale comment block above the description was rewritten to record why the guidance
now says the opposite of what ticket 08 and main-agent-edge-capability ticket 01 left it
saying, and to name the prose-vs-edge ruling.

Field `.describe()`s were NOT touched: ticket 03 already landed
`PUBLIC_RELATION_FORM_LINE` / `PUBLIC_RETRACTION_FORM_LINE` and the public entry union.

### `plugin/skills/` — not applicable

A sweep of the three SKILL.md files found no teaching of who writes edges. The one edge
sentence anywhere in them is `mnemo-timeline/SKILL.md`'s milestone-election tier
description, which is TICKET 02's territory (D2 replaces the tiered election with the
heuristic score) and is left alone.

### Settlement-side hunks — minimal and named (ticket 06 owns the wholesale rewrite)

1. `src/worker/note-settlement-prompt.ts`, the stage-2 TASK FRAME. Was
   `"You are the HINDSIGHT pass over this window. Write the EDGES between the" / "turns in your writable set: …"`;
   now `"You are the HINDSIGHT pass over this window. Each turn's writer already" / "recorded the edges it knew about; your work is to DECLARE the lane side" / "of an edge whose endpoint sits in several lanes, FILL the edges that were" / "missed, and REVIEW what stands: …"`.
   The rest of the paragraph (what hindsight can see, the backfill-window sentences) is
   unchanged.
2. `src/worker/note-settlement-prompt.ts` ~284, a FILE COMMENT asserting "the main agent
   writes five fields and no edges at all". Rewritten to record that D3 gave the edges
   back without the lane sides.
3. `src/worker/note-settlement-unified-prompt.ts`, the unified run's EDGE PASS frame —
   the same sentence, revised the same way (`"pass cannot ask. Each turn's writer already recorded the edges it knew" / "about; you DECLARE the lane side of an edge whose endpoint sits in several" / "lanes, FILL the edges that were missed, and REVIEW what stands."`).
4. `src/worker/note-settlement-impression-teaching.ts`, TWO possessive readings that were
   only true while settlement was the sole edge writer:
   - `"frontier. Your own OVERRIDE edges are the mechanical source of truth for" / "what a later decision killed; …"` becomes `"frontier. The window's CORRECT/FULL edges are the mechanical source of" / "truth for what a later decision killed, whoever wrote them; …"`.
   - `"One thing is not a judgment call: an anchor your own edges CORRECTED in" / "FULL this window forces you to revise …"` becomes `"One thing is not a judgment call: an anchor CORRECTED in" / "FULL by any edge in this window forces you to revise …"`.

   VERIFIED AGAINST THE CODE, not inferred: `computeAnchorInvalidations`
   (`note-settlement-impressions.ts` ~388–431) scopes its hit test by
   `writableTurnIds.has(edge.citingId)` and reads no provenance column, so a main-agent
   `correct/full` on a writable turn already drives the hard `retain` refusal. The
   teaching was the only thing saying otherwise.

   `"The main agent writes none of it and never will."` (about IMPRESSIONS) is left
   standing — still true, D7 keeps impressions with settlement.

NOT TOUCHED, and named for ticket 06: the unified prompt's `EDGES ARE NOT YOURS YET`
authority limit (a STAGE-ORDER fact, still true — the relation fields refuse before
`finalize`); the whole duty-1 edges bullet and its two-sided `{turn, tailTag, headTag}`
entry teaching, the DISPOSE / FORM LANES / JUDGE AND WRITE procedure, and the E6/E4 gate
prose. Every one of those is stage-2 procedure, which ticket 06 rewrites wholesale.

### Tests

`tests/shared/memory-rubric.test.ts` — two new `MODEL_SECTIONS` rows (the checklist
caught the two unclaimed anchors on the first run, exactly as designed) plus a new
5-test describe pinning: the CONCEPTS division sentence present and `边由结算书写`
absent; the ACTIONS preamble; sentence one's four load-bearing phrases; sentence two and
the cap bound to `MAX_TURN_RELATION_DEGREE`; and that the duty lives in the actions half
alone. `tests/mcp/definitions.test.ts` and
`tests/shared/relation-vocabulary-teaching-surfaces.test.ts` — the three pins on the
retired paragraph re-aimed at the new one, with the retired phrases (`are settlement's
whole business`, `rarely need them`, `hindsight`, `it states no relation`, `REFERS to
that one`) asserted ABSENT. `tests/worker/note-settlement-prompt.test.ts` and
`note-settlement-impressions.test.ts` — same shape.
`note-settlement-unified-prompt.test.ts` gains a describe that renders the real prompt
and pins the new frame present and `write the EDGES between the turns in your writable
set` absent.

Full suite: 4800 pass / 0 fail / 267 files, against a 4794/0/267 baseline. +6 = +5 in
the rubric describe, +1 in the unified-prompt describe. (The batch brief predicted a
4793 baseline; HEAD at 9c7a3f52 measures 4794.)

### Mutation probes — 8, all RED, all md5-restored

| # | mutation | red test |
| - | - | - |
| 1 | drop edge-duty sentence one from the actions source, re-splice | rubric: section checklist + "sentence one" (2 fail) |
| 2 | taught cap 20 becomes 40 | rubric: "sentence two … the gate's own number" |
| 3 | put `**边由结算书写。**` back in CONCEPTS | rubric: "CONCEPTS says the citing turn writes the edge" |
| 4 | note description back to "settlement's whole business … rarely need them" | definitions (2) + teaching-surfaces (1) |
| 5 | prose hedge back to "it states no relation" | definitions: "carries only call-level rules" |
| 6 | impression teaching back to "Your own OVERRIDE edges" | impressions: "REPAIR 3 — the supersession rule ships" |
| 7 | unified frame back to "write the EDGES between the turns in your writable set" | unified-prompt: "the edge pass declares, fills and reviews" |
| 8 | staged stage-2 frame back to "Write the EDGES between the" | prompt: "task framing, authority, procedure and commit" |

Each mutation was verified APPLIED by md5 before its test ran, and each file restored
from a `cp` snapshot and re-verified by md5 afterwards.

### Acceptance matrix

No line of `../acceptance-matrix.md` is directly this ticket's: R9-1…R9-9 and
R10-1…R10-10 are all storage, resolution, election, cutover, closure or invalidation
findings. The nearest is **R10-5** ("public logical-edge entry union defined; strings for
verify/use, `{turn, coverage}` for correct") — IMPLEMENTED BY TICKET 03; this ticket only
teaches that union on the tool description and adds no shape of its own. Everything else:
not applicable.

### Anything false at HEAD, and UNVERIFIED

- PRE-EXISTING, NOT MINE: `tests/worker/note-settlement-prompt.test.ts` imports
  `SETTLEMENT_NOTE_TOOL_DESCRIPTION` TWICE (lines 27 and 41), a duplicate-identifier
  error under `tsc` that `bun test` does not see. Confirmed present in HEAD's own copy of
  the file. Same file, lines 1094/1163: two calls passing 4 arguments to a 5-parameter
  helper. Left alone — the project's `tsc --noEmit` excludes `tests/`.
- STILL FALSE AT HEAD, carried from ticket 03's report and NOT repaired here:
  `note-settlement-prompt.ts` ~1050 teaches that a prose address named but never cited
  "is reported as a WARNING only". No such lint exists in `src/`. Ticket 06's surface.
- UNVERIFIED: no production measurement was taken. D8's numbers (edges per window by
  provenance, previous-turn share) are ticket 09's, and nothing here can be measured
  before the batch ships.
- UNVERIFIED: the two stale stored-side clauses in the CONCEPTS `**边**` entry, above.
  Somebody has to rule on whether they are ticket 07's or a new ticket's.
