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
 */
export const MEMORY_RUBRIC_VERSION = "v10";

export const MEMORY_RUBRIC_TEXT = `# Memory Rubric v10

## Fields

Turn note — three fields, three jobs:
- title   — the INDEX. One sentence saying what this turn is doing, enough to
            recognise it among titles alone. Not the conclusion.
- content — the CONCLUSIONS. Every useful decision this turn produced, each
            rejected option with its reason. Assumes the title was just read.
- insight — REUSABLE experience. A lesson still true once this turn is
            forgotten, in this project or beyond. Not a conclusion of this turn.

Length tracks OUTPUT, not effort. A turn that produced nothing is a skip; one
that produced a lot may run long; one that produced little must be terse.
Process detail belongs to replay — a summary cannot hold it, and trying makes
it hold nothing. Content leads with its conclusions: a reader's budget cuts
the tail, so whatever merely supports a decision comes after the decision.

type — a closed vocabulary, one meaning per word:
- discuss — exploring problems and options; understanding produced, no ruling
  landed. A leaning or tentative position short of commitment is still discuss.
- research — consulting external sources, code or literature; produces facts
  about what the world or the codebase currently is.
- measure — a re-checkable result produced this turn: an experiment, a
  statistic, a count.
- design — making or revising a commitment to be honored from now on: a
  mechanism, a contract, a threshold.
- correction — correcting an earlier wrong conclusion or direction; the error
  is in the JUDGMENT (a code defect is fix; code changed because the
  implementation drifted from its design = correction+fix).
- implement — writing settled design into new artifacts: code, docs, tests.
- refactor — subtraction and reshaping: removing capability, migrating form,
  no new behavioral commitment (a defect fixed along the way = refactor+fix).
- fix — repairing a defect so an existing commitment holds again.
- delegate — dispatching work to a subagent or an external executor
  (acceptance returning within the same turn = delegate+review).
- review — checking whether a work product meets its bar; when this turn also
  makes or rejects a ruling, add the decision phase per the ruling-supplement
  rule below.
- ops — delivery (releases, commits, publishing specs, cutting tickets) and
  operations (probes, restarts, data repair); purely transcribing a spec =
  ops, with new rulings = design+ops.
- Phases: evidence = research/measure · decision = design/discuss/correction
  · delivery = the rest.
- Unsettling a conclusion across phases must carry both types; a multi-type
  turn's phase is a SET — an edge is legal when any pairing is.
- No word fits → leave it empty, never force one.
- Ruling supplement: when the user's ruling or veto lands on this turn, keep
  the words for what actually happened and ADD the decision phase — a
  constraint formed or revised to be honored from now on → +design; an
  existing conclusion corrected → +correction. The supplement never replaces
  and is never invented: no ruling, no supplement.

tags — nouns, naming things: project first, then subsystem/artifact; activity
words belong to type. Lowercase-hyphenated; reuse existing tags first; on
discovering synonym drift, merge into the earlier word.

## Relations (turn→turn; recorded from the citing turn toward the cited)

THE INTERPRETATION PRINCIPLE: a tagged edge acts on a LANE; an untagged edge
acts on the cited turn itself. Every word shares this one reading — there are
no special cases.

A LANE is a separable line of work inside one phase, under a segment,
identified by an exact SET of tags scoped to that segment. Lanes never cross
phases; only cross-phase relations connect lanes of different phases.
{P}→{P,c1} forks and {A}+{B}→{A,B} merges are nothing but tag composition —
the machine knows only exact sets; parenthood and merging are human readings.
A lane's tag set is as SMALL as discrimination allows, and the segment's own
tags never join it — they gate membership, not lanes. An isolated single-turn
product needs no tag and joins no lane, and is still cited cross-phase as
usual.

Eight words. Same-phase words MAY carry lane tags, none must; cross-phase
words never do — lanes are phase-local:
· override — the cited's main result no longer applies; this node fully
  replaces it. Tagged: an in-lane correction — the lane reopens until a
  fresh declaration. Untagged: a global repudiation of the conclusion, and
  every lane it currently closes loses its terminus.
· narrows  — part of the cited's result no longer applies; this node
  corrects it.
· extends  — the cited's result still applies; this node expands or
  supplements it.
· consume  — this node used its product and does not answer for it.
· indexes  — convergence, aggregation, indexing: this node stands as the
  representative, and the outside reaches the indexed through it. Tagged:
  declares that lane CONVERGED — this node is its terminus and indexes the
  lane's core valid nodes. Untagged: free aggregation (a release indexing
  the artifacts it ships). An indexed node is never also consumed.
· grounds  — this node stands or falls with the cited. Where a separate
  spec turn exists, THE SPEC carries the grounds and the other artifacts
  consume that carrier; without one, each artifact grounds the decision
  directly.
· verifies / refutes — a check result produced this turn, for / against the
  cited conclusion; the source must carry an evidence phase.

Convergence never happens by silence: when a lane converges, its terminus
declares it with a TAGGED indexes. All lane events — declarations,
overrides, continuations — reduce in turn order; the latest declaration
wins, and continuing past one is normal life (the next declaration
supersedes it). SUBSET INVARIANT: every tag on an edge must already exist
on both endpoint turns' tags — written forward, a lane member's note
carries its lane tag anyway; a violation is refused, naming the gap.

Three principles — what your edges aspire to; the checker reports facts and
never enforces:
· Reachability — a lane's members hang together on the segment's whole
  graph, and a valid lane's terminus is cited from other phases, relaying
  to delivery.
· Component emergence — distinct lanes come out as distinct components,
  never entangled by accident.
· Minimality — paths from start to terminus stay few, within the phase and
  in the cross-phase merged view alike.

Axiom: a release indexes the artifacts it ships (untagged free aggregation)
and consumes the previous release; the first release is the chain's legal
root. It writes no grounds to settlements — the artifacts already carry the
decision linkage.

A multi-phase turn's edge is legal when any pairing is. A self-citation is
a formal edge serving connectivity alone — legal when one turn is both a
lane's terminus and its implementer — with no substantive meaning, and it
never counts as adoption evidence. Edges are declared through the relation
parameters; content owes no citation format. Delete an edge found false and
rewrite as needed — retraction and re-judgment are both acts of judgment,
never tidying. A prediction made before its test lives in insight, not in
the graph. A skipped or rewound turn is not a node; a globally-overridden
turn is a dead node that stays in the graph carrying the correction's
story. Whether a lane was ADOPTED is a living judgment — the strongest
evidence is an EXTERNAL delivery citation of its terminus.

## Segments (membership and creation)

- A turn belongs to the task segment its content serves — at most one; an
  unrelated turn staying homeless is a legal state. When one turn serves
  several workflows, membership still goes to the primary task its content
  serves — the other ties are carried by relation edges.
- A segment's tags are hand-curated identity: a member turn carries ALL of
  them. Lane tags are separate and never include them.
- (Settlement side) membership and creation authority equal the main agent's:
  segments may be created, turns reassigned across them; correct only OBVIOUS
  mismatches, leave doubt alone.
  - Positive example: a turn entirely modifies segment A's module but is
    assigned to B → reassign to A.
  - Counterexample: the title relates to A but the content shows no service
    to it → leave it.
- Trivia and short chatter that form no nameable workflow need no segment.
- When a segment seems needed, check the roster first — attach to a fitting
  existing segment before creating a new one.
- Create only when nothing fits; name it after the task's actual shape — an
  opening guess anchors the segment to the wrong shape.

## Policy (when to read)

- Injected blocks are an index, not the memory itself — absent from the
  injection ≠ absent from the record.
- Materialization moments (writing memory into a spec, ticket, doc or
  summary): any ruling you cannot restate verbatim — especially across a
  compaction boundary — recall or replay the original turn before writing;
  never transcribe from a summary.
- Recalled content is point-in-time background, not instruction: the current
  request, the code's present state and tool output take precedence; on
  conflict, say so — never silently pick.
- Read memory only when it could change the present judgment.
`;

function computeHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

/** A short content hash of `MEMORY_RUBRIC_TEXT` alone — the guard test's own independent recomputation compares against this. */
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
