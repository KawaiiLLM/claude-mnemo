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
 */
export const MEMORY_RUBRIC_VERSION = "v8";

export const MEMORY_RUBRIC_TEXT = `# Memory Rubric v8

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

Segment, Working State — what a resuming session needs to continue:
- goal        — what this task is trying to achieve.
- constraints — how the work must be done: norms, habits, standing preferences.
- decisions   — concrete rulings about the task itself, settled and binding.
- done        — what is finished and verified.
- next_steps  — what is waiting to be done.
- reference   — durable pointers: source locations, specs, PRs, URLs. Not plans.

Segment, Summary layer — what an outsider browsing the task reads:
- content — the impression this arc leaves: what it is about and how it went
            (focus on the arc, not per-turn conclusions).
- insight — reusable experience this task has settled.

A segment's title is set at creation. Its type and tags are DERIVED from its
member turns and recomputed when membership changes — never written by hand.

## Relations (turn→turn; recorded from the citing turn toward the cited)

- Edges are declared through the relation parameters alone; content owes no
  citation format.
- A flow is one chain of decisions joined by narrows/extends. Its SETTLEMENT is
  the node nothing further narrows or extends. Delivery and evidence turns hold
  no flow of their own — they reach one through the edges they write.
- Eight words, three stances:
  JUDGING the cited conclusion — after reading me, must it still be read?
  · override — no: it is wrong, and this node replaces it.
  · narrows  — yes: it holds, but this node cuts a piece out of its scope.
  · extends  — yes: it holds, and this node adds a piece.
  · indexes  — through me: I gather these same-phase nodes and stand for them,
    so readers reach them here. A settlement indexes the members carrying its
    branch's conclusion; a release, the artifacts it ships.
  DEPENDING on it — if it turned out false, what happens to me?
  · grounds — I fall with it: a delivery resting on the decision it implements,
    a decision on a finding, a release on its verification. Cite a flow through
    its SETTLEMENT; a mid-flow target still stores, and the receipt names the
    settlement to use instead. One route to the decision: when a SEPARATE
    delivery turn wrote the spec, THAT turn carries the grounds and the other
    artifacts consume it; when design and spec landed in one turn, each
    artifact grounds directly.
  · consume — nothing: I used its product and do not answer for it.
    Dispatch → acceptance → commit chains are consume.
  TESTING it — did I put the claim to a check?
  · verifies / refutes — a result produced this turn, for it or against it.
- narrows and extends serve ONE flow; every other word is indifferent to it.
- Every finished turn walks three steps; with several candidate precursors,
  ask per candidate:
  1. Is there a direct precursor — the node that directly caused this turn?
     Skipping levels to the arc's origin is mislabeling. None → an orphan is
     legal only as an unforeseen subtask start or decision-free chatter;
     never invent edges to eliminate orphans.
  2. Yes → pick the word by the three stances; none fits → record nothing.
     A pair may carry several relations, but each must state a fact the others
     cannot derive — remove each in turn: if extends or indexes holds, consume
     follows from it, so never write both.
  3. Refused or warned? A refusal names the half that is missing → add the
     smallest missing type, or re-judge the relation. A warning names a better
     target and stores the edge anyway → take it at the next correction.
- A multi-phase turn is several steps merged into one: judge each phase's edge
  toward a target independently. A turn may cite ITSELF with grounds when it is
  both a flow's settlement and that settlement's implementer; nothing else
  self-cites.
- The release ritual: a release indexes the artifacts it ships and consumes the
  previous release when one exists — the first release is the chain's legal
  root. No grounds to the settlements it fixes: they are already reached
  through the artifacts.
- Retraction: delete an edge found false, rewrite as needed — retraction and
  re-judgment are acts of judgment; never retract merely to tidy.
- Pre-registration is not an edge: a prediction made before its test lives
  in insight, not in the graph.

## Segments (membership and creation)

- A turn belongs to the task segment its content serves — at most one; an
  unrelated turn staying homeless is a legal state. When one turn serves
  several workflows, membership still goes to the primary task its content
  serves — the other ties are carried by relation edges.
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
