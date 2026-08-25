import { createHash } from "node:crypto";

/**
 * The Memory Rubric — the single canonical home for JUDGMENT (ticket 11,
 * edge-ownership-impl: "判断规则的唯一规范入口"; [S15069/T933], [T937]–[T939]
 * peer discussion).
 *
 * Three-way split settled by the peer discussion this ticket closes out:
 * FORMAT lives on each MCP parameter's own `.describe()` (mcp/definitions.ts),
 * TIMING/FREQUENCY lives on the note tool's own description (and the
 * SessionStart note-taking block, hooks/handlers/context-note-taking.ts —
 * unrelated to this file, a different split entirely), and JUDGMENT — which
 * word, which relation, which owner a fact actually deserves — lives HERE,
 * nowhere else. Before this ticket, judgment text was duplicated onto the
 * note tool's own description (the six-question relation ladder) and onto
 * two parameter `.describe()`s (`override`'s refines/override discriminator,
 * `encodes`' minimal-set rule) — two homes for the same decision, the exact
 * drift shape [S15069] measured settlement's own scoring/relation prompts
 * suffering from repeatedly. Every one of those sites now states only a
 * call-level POINTER at this file; the judgment prose itself lives only
 * here.
 *
 * TEXT BELOW IS VERBATIM (ticket 11's own "Rubric 定稿" section) — do not
 * paraphrase, reformat or "improve" it without a new ticket. It renders
 * BYTE-IDENTICAL in two places: the SessionStart injection (main agent,
 * `hooks/session-composition.ts`'s `renderRubricAndRosterBlock`) and the
 * settlement prompt (`worker/note-settlement-prompt.ts`) — a hash guard test
 * (tests/shared/memory-rubric.test.ts) asserts both renderings hash to
 * `MEMORY_RUBRIC_HASH`, computed from this same constant, so the two can
 * never quietly diverge into two different rubrics.
 *
 * v2→v3 (ticket 13, spec "节奏与建段指导"): appended the `## 建段` section,
 * verbatim from that ticket's own three ruled lines — when a turn need not
 * belong to any segment, the roster-first discipline before minting one, and
 * naming by the task's actual shape. TIMING for when to consult this section
 * stays off this file, on `remember`'s own tool description (ticket 13's own
 * split, same three-way division ticket 11 already established).
 *
 * v3→v4 (ticket 01, field-semantics spec "01 — 字段定义进注入,预算硬拒改为回执
 * 提醒"): prepended the `## Fields` section, verbatim from that ticket's own
 * definition table — the turn's three fields and the segment's eight
 * editable fields, each one sentence, so the writing agent can read what a
 * field IS from the same injection that already tells it how a fact gets
 * judged. Placed first, ahead of `## type`, because every later section
 * presupposes the fields it is describing. WRITING DETAIL (budgets, the
 * timing/skip/write-mode contract) stays off this block by the same stratification
 * the rest of this file already follows — that prose's single home is the
 * tool description (`mcp/definitions.ts`), never restated here.
 *
 * Still v4 (ticket 02, field-semantics spec "02 — 长度随产出,结论先行"):
 * appended one paragraph to the end of `## Fields`'s turn-note block — after
 * the three turn field definitions, before the segment fields — ruled
 * verbatim from that ticket. It is the counterweight to `content`'s
 * completeness duty (ticket 01) and the 1.5× receipt warning that replaced
 * the old hard rejection: together those two could read as "longer is
 * safer", so this paragraph states that length tracks the turn's OUTPUT, not
 * the effort spent, and that `content` leads with its conclusions because a
 * reader's budget cuts the tail.
 *
 * v4→v5 (ticket 03, edge-mechanism-revision spec "03 — Rubric v5 定稿入库,
 * Policy 并入"; ruling base [S15069/T1109]–[S15069/T1124]): replaced the
 * whole body verbatim with that ticket's own peer-reviewed draft. Four-
 * section regroup — `## type` and `## tags` fold into `## Fields` as
 * unheaded sub-blocks, `## 归属` and `## 建段` merge into one `## 段` section,
 * and `## Policy` absorbs the sibling `MEMORY_POLICY_TEXT` block outright:
 * that constant and its `renderMemoryPolicyBlock` render function retire,
 * and the injection composer's separate Policy slot (`hooks/session-
 * composition.ts`) goes with them — Policy is now this rubric's own last
 * section, not a cohabiting sibling block. The 关系 section opens with an
 * explicit decoupling clause (content never requires a citation format; an
 * edge is a fact declared independently of prose) and, for turns with
 * several relations to the same predecessor, trades "first match wins" for
 * a per-candidate deletion test — keep a relation only if removing it would
 * lose an independent fact, not merely a weaker restatement of one already
 * kept. The type wordlist gains an additive ruling: when the user's own
 * ruling/reversal lands in this turn, keep the phase word the turn actually
 * did and ADD `design`/`correction` alongside it (裁决并列补相) — never swap
 * one for the other, and never add either without an actual ruling. A new
 * release-ritual clause has a release turn gather the work it ships
 * (`depends-on`) and the rulings it fixes in place (`encodes`), and marks
 * the first release as the release chain's own legitimate root. Version
 * bumped v4 → v5.
 *
 * Still v5 (ticket 06, edge-mechanism-revision "ADR 与教学面收口"; user-ruled
 * verbatim at [S15069/T1130]): ONE line appended to `## 关系`, after the
 * release ritual — 撤边. Retraction was already the mechanism's contract from
 * ticket 02 (D3's seven `retract…` mirrors, either writer, hard delete), but
 * the shared judgment text never told either writer when to reach for it, so
 * the one act that keeps a false assertion from outliving its refutation had
 * no entry in the rubric that governs every other edge decision. The line
 * rules retraction a JUDGMENT act on the same footing as reclassification —
 * remove a false edge and rewrite as needed — and forbids the opposite
 * failure mode, retracting for tidiness. Version stays v5: one addition to an
 * existing section, nothing regrouped and nothing already there revised.
 *
 * v6 (relation-matrix spec, .scratch/relation-matrix/): the whole document
 * turns English (user style ruling: concise, pragmatic, clear); §Relations
 * rewrites to the nine-cell grammar — the diagonal trio, source-row
 * cross-phase words, per-phase edges for multi-phase turns, and
 * phase-spanning self-citation; the remaining Chinese sections translate
 * line-for-line. Splice source: .scratch/relation-matrix/rubric-v6-draft.md,
 * peer-reviewed over three rounds; splice mechanics: /tmp-scripted byte copy,
 * never hand retyping. The Summary-layer content note was compressed for the
 * 9500-char injection block cap (MAX_INJECTED_BLOCK_CHARS) — the one
 * deliberate wording deviation from the ruled ticket-02 text.
 *
 * v6→v7 (flow-relations spec, .scratch/flow-relations/, ticket 04; ruled
 * [S15069/T1198]–[T1206]): §Relations replaces WHOLESALE — the nine-cell
 * phase grid retires as the word-choice law and the eight-word, three-stance
 * vocabulary takes its place (JUDGING: override/narrows/extends/collects ·
 * DEPENDING: grounds/consume · TESTING: verifies/refutes), organised around
 * the FLOW — a branch of decisions joined by narrows/extends, whose
 * settlement is the node nothing further narrows or extends. Splice source:
 * .scratch/flow-relations/rubric-v7-relations-draft.txt (3090 bytes,
 * peer-aligned), spliced by /tmp-scripted byte copy on the v6 precedent —
 * never hand retyping. One pinned bullet rides along after the retraction
 * line (T1190 ⑦a): a pre-registered prediction is insight, not an edge.
 * No other section changes. Which conditions REJECT and which merely WARN
 * stays off this file entirely (ADR-0009's split: the rubric teaches
 * judgment, the receipts teach mechanism) — hence the section names the
 * terminus warning's effect without enumerating the validator's checks.
 * Every section outside §Relations is untouched, so their v5/v6 guard pins
 * (tests/shared/memory-rubric.test.ts) still hold verbatim.
 *
 * v7→v8 (indexes-rescope spec, .scratch/indexes-rescope/, ticket 04; ruled
 * [S15069/T1228]–[T1241]): §Relations only, five surgical changes — the word
 * `collects` becomes `indexes` and its semantic widens from "this flow ends
 * here" to SAME-PHASE AGGREGATION (this node gathers and stands for the
 * same-phase nodes carrying its content; readers reach them through it), so
 * one word now serves a decision settlement gathering its branch's carrying
 * members AND a release gathering its shipped artifacts, with no scenario
 * rules attached (user [T1231]: behaviour emerges from a clean semantic, it
 * is not legislated per node type). Consequences: the flow-scope line drops
 * the word (collects' own-branch/terminus conditions retire with law 2 —
 * they were write-gate checks, never rubric prose, so nothing else here had
 * to go); the release ritual stops writing `grounds` to the settlements it
 * fixes (law 4 — that linkage is transitive through the artifacts) and
 * indexes what it ships; `grounds` gains the canonical-route sentence (law
 * 7 — one route across the decision→delivery seam: the lane's own spec turn
 * carries the grounds, the other artifacts consume the spec; merged
 * design+spec turns keep direct grounds, where a re-route would be
 * phase-illegal); and the per-pair dedup sentence adds indexes beside
 * extends (law 3 — an indexed target is never also consumed). The three
 * GRAPH INVARIANTS and their lints stay OUT of this file by the v1 division
 * of labor ruled at T1238: they are review-time tooling for the backfill
 * pass and the graph page, not judgment every writer must carry. Version
 * bumped v7 → v8; every section outside §Relations is untouched.
 *
 * v8→v9 (ruled [S15069/T1253]–[T1256], peer-discussed): §Relations is
 * REORGANISED — same law, three layers instead of one flat list. CONCEPTS
 * first (a workflow may run a flow per phase: evidence, decision, delivery),
 * then the words, then REACH RULES gathered in one place, then the
 * PROCEDURE. The user asked for the concept layer; the measurement that
 * shaped it is that the main agent wrote ZERO `indexes` edges across a whole
 * window containing settlements that needed them.
 *
 * Two changes carry that behavioural intent, and neither is cosmetic.
 * (1) `indexes` leaves the JUDGING group and takes its own — v8 announced
 * three stances and then listed FOUR jobs: override/narrows/extends answer
 * "must the cited still be read?" with no/yes/yes, while indexes answered a
 * different question ("through me"). A word filed under a heading whose
 * question it does not answer is a word the reader skips.
 * (2) The checklist gains an AGGREGATION pass beside the precursor pass. The
 * precursor question ("what caused this turn") can never generate an
 * aggregation candidate, because aggregation is about what a turn stands FOR,
 * not what stands behind it — so naming the flows without this pass would
 * have renamed the table of contents and changed nothing. Writability rests
 * on law 2: with the terminus gate retired, a turn need not know it is a
 * FINAL settlement, only that it is gathering a conclusion now; a later
 * `extends` moves the flow past it without falsifying the edge.
 *
 * Only the decision flow is graph-derived, and the text says so — evidence
 * and delivery flows are reading aids here, not entities flows.ts computes
 * (fixed premise, user-ruled: the machine is unchanged by this version, and
 * `indexes` keeps its same-phase-only check).
 *
 * The first v9 draft claimed "no rule was dropped to fund it" and a peer diff
 * against v8 disproved it — five losses, all repaired before this landed, and
 * worth naming because compression is where rules die quietly:
 *   1. Retraction lost BOTH predicates the user approved verbatim at
 *      [S15069/T1130] — "rewrite as needed" (deleting a false edge without
 *      replacing it loses the correction) and re-judgment being an act of
 *      judgment in its own right. Worse, the guard test had been edited to
 *      match the weakened line: a guard that follows the implementation
 *      guards nothing.
 *   2. The concept sentence invented lifecycles — "runs a flow per phase"
 *      (a workflow may have no evidence, or not have shipped), an evidence
 *      flow "ending where a decision takes it up" (contradicting this same
 *      section's rule that verifies/refutes may target delivery), and a
 *      delivery flow "ending at a release" (a release indexes ACROSS flows;
 *      not every chain has one). Invented endpoints are gone; a flow names the relation that joins it where
 *      one exists,
 *      and only the decision flow keeps a terminus, because only its
 *      settlement is graph-defined.
 *   3. "acts once per phase" implied a storage cardinality the validator does
 *      not have — the exists-rule accepts an edge when ANY phase pairing is
 *      legal. v8's "judge each phase's edge independently" is restored.
 *   4. The orphan clause lost its ONLY, turning an exhaustive condition into
 *      two examples.
 *   5. "Dispatch → acceptance → commit chains are consume" vanished with the
 *      old consume bullet; it now lives in the delivery flow's own definition,
 *      which names consume as the word that joins those steps.
 * A new guard binds the reach rules to `isRelationLegalForPhases` by parsing
 * them out of this text, so teaching and validator can no longer drift apart
 * silently — the failure shape this batch met twice elsewhere.
 *
 * Budget: 9462 rendered chars, 38 under the cap. An interim state sat at
 * exactly 9500 (headroom zero) — unacceptable against a cap that truncates
 * silently rather than failing, so four passages were compressed for margin.
 *
 * Still v9 (user ruling [S15069/T1264]): the SEGMENT field definitions leave
 * this file — the six Working State fields, the two Summary fields, and the
 * type/tags derivation sentence — compressed into `remember`'s own describes
 * with no information lost. Ticket 01 put them here so a writer could read
 * what a field IS from the same injection that judges it; that reason has
 * expired for the segment half, because `remember`'s `field` describe is a
 * standing tool schema carrying the same eight definitions, and the one
 * reader WITHOUT those describes — the settlement agent — has no segment-field
 * parameter at all (its membership surface writes assignments, never fields).
 * Three facts the describes lacked moved with them: the two framings (Working
 * State is what a resuming session needs; Summary is what an outsider reads)
 * and content's arc-not-per-turn discriminator; the derivation rule landed on
 * the `title` describe, where it explains the conspicuous absence of type/tags
 * from that shape. A migration test now asserts each fact on a describe AND
 * asserts the rubric has not re-grown a copy.
 *
 * Still v9 (user rulings [S15069/T1262], [S15069/T1265]): §Relations gains the
 * two things that make `indexes` reachable at all. The flow concept unifies —
 * ONE definition (a separable line of work inside a phase, where a single
 * subtask and even a single node are equally flows), instantiated per phase,
 * replacing three separate descriptions that read as three kinds of thing.
 * And `indexes` states its PURPOSE rather than only its shape: it declares a
 * flow CONVERGED and makes that node the flow's proxy — cite the node and you
 * have cited the flow, so everything outside reaches it through one node and
 * never through its members. That sentence is what licenses the citation rule
 * (now generalised from "cite a decision flow through its SETTLEMENT" to "cite
 * a flow through the node it converges on"), and it gives the aggregation pass
 * a sharp trigger: CONVERGENCE, not the looser "does this turn stand for a set
 * of nodes" — a question every turn can answer, and for most the honest answer
 * is "no, I am one link".
 *
 * The TURN field definitions deliberately stay: `settlementNoteInputShape`
 * omits `title` and `content` describes entirely, so this block is the
 * settlement agent's only source for them. Deleting them as "duplicated with
 * the note describes" — which they visibly are, for the main agent — would
 * have silently stripped the other reader. Budget after: 8612 chars, 888
 * under the cap.
 *
 * v9→v10 (rubric-v10 spec, .scratch/rubric-v10/; user drafts and rulings
 * [S15069/T1277]–[T1319], three peer rounds — two Codex, one mnemo-review):
 * §Relations replaces WHOLESALE with the lane model. The FLOW concept, the
 * four-job grouping, the separate reach block, the two-pass procedure, the
 * cite-through-settlement paragraph and the refusal/warning mechanics all
 * retire; ONE interpretation principle anchors every word (a tagged edge
 * acts on a LANE, an untagged edge acts on the cited turn itself), a LANE is
 * identified by its exact tag set scoped to the segment, convergence is
 * DECLARED by a tagged indexes and never silent, the subset invariant guards
 * tag writes, and the three principles enter as ASPIRATIONS (reversing their
 * T1238 lint-only placement by user ruling T1277) while checker mechanics
 * stay out. The release rules are named an Axiom — peer rounds proved them
 * underivable from the principles. Splice source:
 * .scratch/rubric-v10/relations-v10-en.md, authored by the main agent per
 * the T1315 ruling. §Segments gains ONE line (ticket 07): segment tags are
 * hand-curated membership identity, disjoint from lane tags. Budget after:
 * 9395 rendered chars, 105 under the cap.
 *
 * Still v10 (user ruling [S15069/T1343]): principle 3 re-aims. Minimality
 * moves from "few start-terminus paths" to few INTER-lane edges aimed at
 * termini; in-lane structure owes a DAG (edges point to the past) and path
 * counts demote to reported facts with no target — measured on T900-1001,
 * every in-lane count was already 1 while seven lanes shared one component,
 * so the information lives between lanes. The checker's report 4 splits to
 * match (rubric-v10 ticket 08); mechanics stay out of this text as ever.
 *
 * Still v10 (user ruling [S15069/T1345]): the indexed-never-consumed ban
 * narrows to the UNTAGGED case. The v9 deletion-test subsumption held for
 * both readers; v10's own ruling that indexes never enters connectivity
 * broke the machine half — a tagged consume states the lane-structure fact
 * a tagged indexes cannot supply (T984's severed terminus was the proof),
 * so on a tagged pair the two are independent assertions. The extends half
 * of the ban is untouched: extends subsumes consume on both readers.
 * Budget after: 9471 rendered chars, 29 under the cap.
 *
 * Still v10 (user ruling [S15069/T1360], milestone-election ticket 01): the
 * lane definition formalizes — a DAG of tagged edges over AT LEAST TWO nodes
 * (single-node lanes do not exist; the floated self-indexes closure was
 * withdrawn), fork by adding a tag, REOPEN a closed lane by inheriting the
 * exact set; and the lane states enter: CLOSED (latest node is the declared
 * terminus) splitting into VALID/INVALID by core survival, unconverged lanes
 * staying OPEN. Paid for by compressions that keep every guarded semantic:
 * Fields' length paragraph, ruling-supplement, segment examples and the
 * roster/create bullets, plus the redundant "lanes are phase-local" tail.
 * Budget after: 9435 rendered chars, 65 under the cap.
 *
 * Still v10 (tag-mandate spec, .scratch/tag-mandate/, ticket 01; rulings
 * [S15069/T1412] and [T1415], the T1424 peer round, and the T1440-T1451
 * production campaign): §Relations takes the MANDATE and the lane laws.
 * extends/narrows lose their untagged form — the only two words whose
 * semantics IS continuation now name the line they continue, while
 * override/consume/indexes stay optional and cross-phase words stay bare.
 * Five laws join the lane definition: SHAPE (one source, one sink; diamonds
 * that re-merge are legal, dangling parallel heads/tails are not; a node may
 * start or end several lanes); IDENTITY UNIQUENESS (one exact set names one
 * lane — one component, one phase — and membership comes from the tagged-edge
 * DAG, never from a turn merely carrying the nouns); WHOLE-LANE PHASE (a
 * multi-type middle node launders no phase switch, so edge-local "any
 * pairing" legality never lets p drift along the chain); BRANCH v3 in the
 * ruled SUPERSET direction (B branches A when B starts inside A with a PROPER
 * SUPERSET of A's tags; inheriting the exact set is a REOPEN); and the
 * CROSS-LANE CORRECTION idiom (branch rooted at the corrected node, the
 * citing turn carrying the corrected lane's tags plus the branch word).
 * The campaign's four amendments land as law in the same pass: R1 dead node =
 * global override only, with the victim-as-core CONTENT condition (live is
 * not yet core); R2 consume same-phase / grounds cross-phase as the GENERAL
 * law, not an evidence→decision special case; R3 the completion-vs-correction
 * boundary sentence on `narrows` (a blocker satisfied by doing the work is
 * completion, not a correction of the blocking judgment); R4 the named PHASE
 * SPLIT idiom on `grounds`, with the consume caveat.
 *
 * The amendments cost ~1.2K, so this is also the document's deepest
 * compression pass — the type vocabulary, the Fields table's continuation
 * indent, the lane paragraph, the word bullets, the convergence paragraph,
 * the principles, the closing paragraph, §Segments and §Policy all tightened,
 * with every guarded semantic preserved and every touched pin re-stated in
 * tests/shared/memory-rubric.test.ts alongside what it kept. TWO deliberate
 * removals, named here so they are never rediscovered as accidents: the
 * burial idiom "(bury an abandoned line: repudiate, then declare over the
 * wreck)" — mechanically derivable from the untagged override and tagged
 * indexes taught in the same section — and §Segments' two worked examples of
 * an OBVIOUS mismatch, whose law ("correct only OBVIOUS mismatches, leave
 * doubt alone") stays. Version stays v10 on the b2523de precedent: §Relations
 * is amended, not replaced. The mandate does retire a previously legal form,
 * so a bump to v11 would also be defensible — the version string lives only
 * in this file and its guard, and the hash is the real drift guard.
 * Budget after: 9461 rendered chars, 38 under the cap.
 *
 * v10→v11 (lane-declaration spec, .scratch/lane-declaration/spec.md Rev 3,
 * ticket 08; rulings [S15069/T1524]-[T1562]): §Relations' lane sections are
 * REPLACED WHOLESALE by the text the user authored and a peer round
 * repaired, checked in verbatim at
 * .scratch/lane-declaration/rubric-v11-lane-sections.md (b30022b) —
 * reproduced here rather than paraphrased, in the user's own language,
 * because a lane used to exist the moment anyone wrote a tagged edge:
 * measured live, 72 lanes over 380 tagged edges, 30 of them two-member and
 * 14 a single edge, while the six 12+-member lanes were the only real
 * workflows. Two causes, two retirements: identity WAS the exact tag set,
 * so every refinement minted a new lane instead of continuing one — identity
 * is now `(segment, ONE tag)`, DECLARED before use (`remember`'s
 * declare/undeclare verbs); and extends/narrows WERE required to carry a
 * tag, so every related pair got one — no word is mandatory now, tagging
 * moves to settlement as a hindsight judgment. A third change rides the same
 * ticket (T1562): a lane is no longer phase-local — all eight words may
 * carry a tag, so a tagged cross-phase `grounds` is how a decision line
 * continues into the delivery that ships it, and an edge may carry several
 * lanes' tags at once (confluence) exactly when its own content serves all
 * of them. Retired bodily, verified absent by grep over the whole document:
 * lane identity as an exact tag SET, BRANCH by proper superset, REOPEN by
 * inheriting a closed lane's set, the phase-local lane, and the mandate that
 * extends/narrows must carry a tag.
 *
 * What v11 does not restate is dropped as redundant, not silently lost: the
 * release Axiom's old framing folds into the text's own #release example
 * (same three facts — untagged indexes over shipped artifacts, consume
 * chaining the previous release, no blanket declaration — plus the new
 * per-lane `indexes` the campaign ruling [T1552]-[T1562] added); the R1
 * dead-node/tagged-override-stays-live pair folds into the text's own
 * 核心节点 (core-node) definition, which states the same content-preservation
 * test for every member rather than only an override's victim; the
 * ADOPTED-evidence sentence has no v11 counterpart and is cut for budget,
 * the one deliberate content loss this pass makes knowingly. Retraction, the
 * pre-registration rule and the citation-format sentence are unrelated to
 * lane identity and carry over untouched, appended after the reproduced
 * block. `src/worker/note-settlement-prompt.ts`'s own Block B edge contract
 * and this ticket's teaching-surface sweep move with it, in the same
 * ticket. Version bumps v10 -> v11: retiring a previously legal form
 * (untagged extends/narrows) is the exact bar the v10 header itself set for
 * a bump it chose not to take. Budget after: 6822 rendered chars (the
 * version/hash-wrapped injection block; MEMORY_RUBRIC_TEXT alone is 6744),
 * 2678 under the cap — the lane sections alone measure ~2300 of that, so
 * this pass is a net compression even before counting the retired English
 * prose it also removed.
 *
 * Still v11 (lane-model v12, `.scratch/lane-model-v12/`, ticket 02): §Relations
 * takes the SEVEN-word vocabulary. Three deletions and one merge, all of them
 * removing text rather than adding any:
 *   - the 相位配对 paragraph is GONE. The write gate no longer pairs phases,
 *     so a rubric teaching the exists-rule would teach a check that cannot
 *     fire. Measured before deciding: with that exists-rule in force exactly
 *     ONE live hand-written edge in the whole database was illegal; without it
 *     309/609 (51%) were. The escape hatch was carrying the axis, so the axis
 *     went.
 *   - every word bullet drops its 同相位/异相位 prefix, for the same reason.
 *   - `refutes` merges into `override`, whose bullet now names all four cases
 *     it covers (否决/撤回/放弃/取代) in the user's own wording; `verifies`
 *     stands alone and says where a contrary result goes. Its 取证相位
 *     requirement is dropped too — 19/20 asserted rows already complied and
 *     the one real violation is legal under the merged semantics.
 * The 自引 paragraph is deliberately NOT touched here: it is ticket 04's
 * deletion, in the same batch. Version stays v11 on the b2523de precedent
 * (§Relations amended, not replaced); ticket 12 is the one that replaces this
 * section wholesale and owns the bump.
 */
export const MEMORY_RUBRIC_VERSION = "v11";

export const MEMORY_RUBRIC_TEXT = `# Memory Rubric v11

## Fields

Turn note — three fields, three jobs:
- title   — the INDEX. One sentence on what this turn is doing, enough to
  recognise it among titles alone. Not the conclusion.
- content — the CONCLUSIONS. Every useful decision this turn produced, each
  rejected option with its reason. Assumes the title was just read.
- insight — REUSABLE experience. A lesson still true once this turn is
  forgotten, in this project or beyond. Not a conclusion of this turn.

Length tracks OUTPUT, not effort: nothing produced is a skip, little produced
is terse. Process detail belongs to replay. Content leads with its
conclusions: a reader's budget cuts the tail, so support comes after the
decision.

type — a closed vocabulary, one meaning per word:
- discuss — options explored, understanding produced, no ruling landed; a
  leaning short of commitment is still discuss.
- research — external sources, code or literature consulted: facts about what
  the world or codebase now is.
- measure — a re-checkable result produced this turn: experiment, statistic,
  count.
- design — a commitment to honor from now on, made or revised: mechanism,
  contract, threshold.
- correction — an earlier wrong conclusion or direction corrected; the error
  is in the JUDGMENT (a code defect is fix; code drifting from design =
  correction+fix).
- implement — settled design written into new artifacts: code, docs, tests.
- refactor — subtraction and reshaping: capability removed, form migrated, no
  new behavioral commitment (a defect fixed on the way = refactor+fix).
- fix — a defect repaired so an existing commitment holds again.
- delegate — work dispatched to a subagent or external executor (acceptance
  in the same turn = delegate+review).
- review — a work product checked against its bar; a ruling made or rejected
  here adds the decision phase (supplement below).
- ops — delivery (releases, commits, specs, tickets) and operations (probes,
  restarts, repair); transcribing a spec = ops, new rulings = design+ops.
- Phases: evidence = research/measure · decision = design/discuss/correction
  · delivery = the rest.
- Unsettling a conclusion across phases carries both types; a multi-type
  turn's phase is a SET.
- No word fits → leave it empty, never force one.
- Ruling supplement: a user ruling or veto landing here keeps the words for
  what happened and ADDS the decision phase — new or revised commitment →
  +design, corrected conclusion → +correction; never invented.

tags — nouns, naming things: project first, then subsystem/artifact; activity
words belong to type. Lowercase-hyphenated; reuse existing tags first, merging
synonym drift into the earlier.

## Relations (turn→turn; recorded from the citing turn toward the cited)

**lane**: 段任务下明显可分离、会跨越当前交付继续的子任务，例如 #release / #rubric-design；随本轮或本批做完即结束的事务不是 lane，例如 #ticket-06-implement / #rubric-v5-design。身份是 \`(段, 一个 tag)\`：**先声明，再使用**；tag 须为 canonical 形式（NFC、去空白、小写、非空），且不得与该段的 curated tag 同名。一条带 tag 的边要求**两个端点各自所属的段都已声明该 tag**——无段的 turn 不得带 tag，跨段的边两侧都要声明。

**成员资格**：只来自**带该 tag 的边**——节点自身的 tags 含该 tag 只是准入的必要条件，不构成成员；无 tag 的边既不建立也不延续 lane。lane 图中每个节点自身的 tags 都必须包含该 lane tag。lane 至少两个节点；一条边可带多个 tag，表示这几条 lane 共用它。

**状态**：lane 的所有事件按 **turn 顺序**归约。当 lane 的最新事件节点自身发出 \`indexes{该 lane tag}\`、且其后没有延续或重开事件时，该节点是**当前终点**，lane **closed**；否则 **open**。无 tag 的 \`indexes\` 不改变 lane 状态；而**来自 lane 之外**、指向现任终点的较新无 tag \`override\` 会取消该终点并重开 lane。closed 的 lane 在其被索引的**核心节点**尚有存活者时 **valid**，全部死亡则 **invalid**。**核心节点** = 终点的结果仍然保留并代表其内容的成员；存活只是必要条件。

**七词**（非自引边均可带 tag；词义与两端的相位无关）:

- **override** → 其主要结果被本节点否决、撤回、替换——反证、撤回、放弃、取代同用此词。带 tag = lane 内纠正，lane 重开待新宣告；无 tag = 对该结论的全局否决，所有以它为现任终点的 lane 一并失去终点。
- **narrows** → 其部分结果不再适用，本节点作出纠正。
- **extends** → 其结果仍然适用，本节点拓展、补充。
- **consume** → 使用其产出，不为其正确性担责。
- **indexes** → 表示收敛、汇聚、索引，达成阶段性成果。带 tag = 宣告该 lane 收敛，本节点即终点，索引该 lane 的核心节点；无 tag = 自由聚合（如发布索引所运工件）。同一目标不再另写**无 tag** 的 consume；带 tag 的 indexes 与带 tag 的 consume 可以并存，前者宣告收敛，后者表达 lane 内的使用与结构。
- **grounds** → 本节点的成立依赖其成立，它若倒下，本节点随之倒下。有独立 spec 轮时由 spec 承担 grounds、其余工件 consume 该承担者；无 spec 时工件直接 grounds。
- **verifies** → 以本轮产出的检验结果支持其结论；检验结果与其相悖时写 override，不另设反驳词。

**自引**：只允许裸 \`grounds\`，且本 turn 须含落地相位、并在本次写入后仍是自己以带 tag 的 \`indexes\` 宣告的某条 lane 的当前终点；其余七词不得自引。自引边一律不带 tag——带 tag 意味着点名一条 lane，而单节点自环不构成 lane。

**skip/rewind**：被 skip 或 rewind 的 turn 不是节点，不得作为边的端点。

**示例**（边由引用方指向被引方）:

- **#release**：每次发布做三件事——\`consume{release}\` 串起上一次发布（这条 lane 永不收敛）；无 tag 的 \`indexes\` 聚合本次所运工件；对本批落地的每条 lane 各写一条 \`indexes{该 lane}\`，索引它自己的核心节点。没有「一次宣告涵盖多条 lane」这种写法。
- **跨相位的一条线**：\`实现 —consume{rubric-design}→ spec —grounds{rubric-design}→ 设计终点\`。同一个 tag 贯穿决策与落地，不拆成两条 lane。
- **共用边**：只有当**这一条边**的语义确实同时服务 A/B/C 时，它才带 \`{A,B,C}\`；批次里各自只服务一条 lane 的边只带自己的 tag。针对其中一条的纠正写**只点名那条**的 \`override{B}\`。

**原则**（判断性，不强制；在**段的全图**上考察，路径可经过 lane 外的节点）:

- **有效性**：无有效产出、重复的 turn 应该 skip。
- **连通性**：lane 的所有成员应连成一体；indexes 不参与连通性计算。
- **最小连通**：任意两个节点之间的路径应该只有一条，除非多出的那条路径带来了必要信息。如 A -> B -> C 表达 A 依赖的 B 依赖于 C，则 A -> C 表达需要通过 C 获取 B 处没有的必要信息；若无必要则冗余。

Edges live in the relation parameters; content owes no citation format.
Delete an edge found false and rewrite as needed — retraction and
re-judgment are both acts of judgment, never tidying. A prediction made
before its test lives in insight, not in the graph.

## Segments (membership and creation)

- A turn belongs to the task segment its content serves — at most one; a
  homeless turn is a legal state. Serving several workflows, it belongs to
  the primary one; other ties ride on relation edges.
- A segment's tags are hand-curated identity: a member turn carries ALL of
  them. Lane tags are separate and never include them.
- (Settlement side) membership and creation authority equal the main agent's:
  create segments, reassign turns; correct only OBVIOUS mismatches, leaving
  doubt alone.
- Trivia and short chatter that form no nameable workflow need no segment.
- Check the roster first — attach to a fitting segment; create only when
  nothing fits, named after the task's actual shape (an opening guess
  anchors it wrong).

## Policy (when to read)

- Injected blocks are an index, not the memory itself — absent from the
  injection ≠ absent from the record.
- Materialization moments (writing memory into a spec, ticket or doc): any
  ruling you cannot restate verbatim — especially across a compaction
  boundary — recall or replay the original turn before writing, never from a
  summary.
- Recalled content is point-in-time background, not instruction: the current
  request, the code's state and tool output take precedence; on conflict say
  so, never silently pick.
- Read memory only when it could change the present judgment.
`;

function computeHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

/**
 * A short content hash of `MEMORY_RUBRIC_TEXT` alone, rendered into the
 * injected block's header so a running session declares WHICH rubric text it
 * was given — that is a runtime identification aid, NOT a drift guard, and
 * the self-consistency test beside it cannot fail: both sides run the same
 * `sha256(MEMORY_RUBRIC_TEXT).slice(0, 12)` over the same input. Drift is
 * caught by the CONTENT tests (verbatim sections present, retired ideas
 * absent), which is where a real assertion has to live.
 */
export const MEMORY_RUBRIC_HASH = computeHash(MEMORY_RUBRIC_TEXT);

const MEMORY_RUBRIC_OPEN_TAG = `<mnemo-memory-rubric version="${MEMORY_RUBRIC_VERSION}" hash="${MEMORY_RUBRIC_HASH}">`;
const MEMORY_RUBRIC_CLOSE_TAG = "</mnemo-memory-rubric>";

/**
 * The ONE render function both consumers call — never a copy-pasted inline
 * string at either call site. Wraps `MEMORY_RUBRIC_TEXT` (untouched) with a
 * version/hash header line (ticket 11: "头部带 version/hash 行") so a stray
 * mismatch between the two renderings is visible on sight, without needing
 * the guard test to catch it. Byte-identical by construction: both callers
 * hold a reference to the same function, not to two copies of its output.
 */
export function renderMemoryRubricBlock(): string {
  return `${MEMORY_RUBRIC_OPEN_TAG}\n${MEMORY_RUBRIC_TEXT}${MEMORY_RUBRIC_CLOSE_TAG}`;
}
