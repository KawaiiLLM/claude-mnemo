# ADR-0010 — Phase picks the word: a nine-cell grammar replaces seven per-word tables

**Status:** accepted · 2026-08-21 · source: S15069 T1163–T1180 · spec:
`.scratch/relation-matrix/spec.md` · evidence: `.scratch/edge-rebuild-t900-1000/report.md`
(Analysis A, the A-series gaps)

## Context

ADR-0009 gave the graph standalone edges and multiple relations per pair, but
left the vocabulary itself untouched: seven relation words, each legal only
where its own hand-written phase table said so — evidence→decision for the
verdict pair, decision→{evidence,delivery} for `grounded-on`,
delivery→decision for `encodes`, delivery→delivery for `depends-on`,
decision→decision for `refines`/`override`. The rebuild report's A-series
audit of a live 101-turn window found the tables did not compose. **A2**: a
patch release's delivery half had no word for the decision it fixed in the
same turn, because delivery→decision only meant `encodes`, and `encodes`
asserts carriage, not correction. **A3**: `grounded-on` was locked to a
decision source, so a delivery turn (a release, a repair) could never say
what it rested on — three live cases needed exactly that word and had none.
T1111 had separately banned every self-loop outright, so a turn that
processed its own earlier half within one turn (dispatch and review
compressed into a single prompt) could not record that either. Each gap so
far had been closed by widening one word's table in isolation, and each patch
left the tables' shape — seven independent lookups, no shared logic —
exactly where it was: nothing bounded how many more gaps a 9-phase-pair space
could produce against a 7-word vocabulary applied ad hoc.

## Decision

### 1. One grammar, two reading rules, replaces seven tables

A relation word is now chosen by exactly two rules, keyed only by the citing
and cited turns' **phase** — evidence (research/measure), decision
(design/discuss/correction), delivery (everything else; a multi-type turn's
phase is the SET of its types' phases). **Same phase (the diagonal)** — a
guarantee ladder, strongest to weakest: `override` (the cited conclusion is
wrong, this node replaces it), `refines` (the cited conclusion is right,
improved without replacing it — chains fork, one direction per origin),
`depends-on` (only logical dependency on the cited node's completion, no
workflow or correctness claim). **Cross phase** — the word is fixed by the
SOURCE turn's phase alone: evidence speaks a verdict
(`evidence-for`/`evidence-against`), decision speaks footing (`grounded-on`),
delivery speaks carriage (`encodes`). Nine phase-pair cells, every one
filled, zero new vocabulary words.

The change is a **pure relaxation**: every class of edge legal under the old
tables is a subset of some new cell — checked exhaustively against the live
graph (`depends-on`'s old delivery→delivery scope, the verdict pair's old
evidence→decision scope, `grounded-on`'s old decision→{evidence,delivery}
scope, `encodes`' old delivery→decision scope, `refines`/`override`'s old
decision→decision scope) — so the migration touches zero stored edges. Five
relaxations, zero retightenings [S15069/T1166].

**Alternatives considered, and why they lost:**

- **Keep the per-word hand-carved phase tables and patch the next gap the
  same way** (the status quo). Rejected: each patch is local — it fixes the
  one word whose table the gap fell under — while the interaction surface is
  global: seven independent tables mean seven places a future gap can hide,
  and nothing bounds how many A-series gaps a 9-cell space can still produce
  against 7 ad hoc lookups. The rebuild report had already found two such
  gaps (A2, A3) in one 101-turn window; a grammar closes the general case
  once instead of the specific case each time.
- **A phase-free `depends-on` as the one off-matrix word** — guarantee only
  logical dependency, no phase restriction at all, with every other word
  staying same-phase. Proposed and self-endorsed as a "guarantee ladder" at
  [S15069/T1165], overruled by the user the same session at [S15069/T1166]:
  `depends-on` is same-phase like its diagonal siblings, and the cross-phase
  slot is filled by row-determined words instead — the ladder framing
  survives, scoped to the diagonal alone.
- **Widen `grounded-on`'s source lock alone** (the A3 fix in isolation, one
  more table patch). Rejected because it only patches the one gap it was
  aimed at: an evidence-phase turn still could not refine or override
  another evidence-phase turn, and a delivery turn citing evidence (a
  release resting on its own pre-release verification, T998→T997) still had
  no word — E→E stays wordless under this alternative.
- **New vocabulary words for the remaining gaps** (e.g. a `responds-to` word
  for delivery→decision "caused by, not carrying" — A2's original
  diagnosis). Rejected: it grows the vocabulary instead of the grammar — the
  word count keeps climbing with the gap count, and every existing edge has
  to be re-examined against whether it now qualifies for the new word. The
  grammar reframes A2 as a turn-granularity problem instead (decision 2), so
  the word was never needed.

### 2. Self-reference: T1111's blanket ban partially reverses

T1111 had ruled no turn may cite itself, full stop. This spec **partially
reverses** that ruling [S15069/T1178, S15069/T1180]: a turn may self-cite
with a **cross-phase word** when its own phase set spans both that word's
source phase and a legal target phase for it — necessarily two different
type-driven phases of the same turn (e.g. a delegate+review turn
self-`encodes` its own delegate half; a measure+design turn self-cites with
`evidence-for` or `grounded-on` against its own measure half). The half must
carry the other half's core ruling or key verification as an
**independently exhibitable artifact** — restating is not carrying (the
peer-review round-3 fix: artifact, not content, is the gate). Two narrowings
hold regardless: a **single-phase turn can never self-cite** (there is no
second phase to point at), and the **diagonal words never self-cite for
anyone** (`override`/`refines`/`depends-on` against yourself states nothing —
same phase against yourself is empty).

This is a **partial** reversal, not a repeal: T1111's ban still stands for
everything the widened rule does not cover. It required the one real schema
migration this spec makes, because the self-loop ban had just been encoded
as a table-level `CHECK (citing_kind <> cited_kind OR citing_id <>
cited_id)`; the widened rule needs `... OR relation IS NOT NULL`, rebuilt on
the temp-name precedent this project had already exercised once. Bare
self-rows stay banned; the phase gate lives in the validator, not the table.

**A2 dissolves as a side effect, not a target.** The rebuild report's A2 gap
— a patch release's delivery half had no word for the decision it fixed in
the same turn — turns out not to be a vocabulary gap at all: it is the same
"two steps merged into one turn" shape multi-phase edges already handle
(decision 3), just pointed at the turn's own other half instead of a
different turn. A `correction+fix+ops` patch release can now self-`encode`
the in-turn ruling it also carries. No new word, no special case — closing
A2 was surfaced as a consequence of decision 1's generalization, not
designed separately [S15069/T1178, S15069/T1180].

### 3. A multi-phase turn writes one edge per phase, not one edge total

A multi-phase turn (its type set spans more than one phase) judges each
phase's edge toward a target **independently**: when two phases each
legitimately earn an edge toward the same target, **both are written** — two
true statements from two different halves of one turn, never a
priority-ordered choice between them [S15069/T1178]. This dissolved a peer
review blocker: a research+review turn citing a research target could
plausibly be read as either an E→E edge (the research half's continuation)
or an L→E edge (the review half's carriage), and the draft rubric had no
rule for which voice wins. The dissolution was to stop asking which voice
wins — each half speaks for itself, and the deletion test (each relation
must state a fact the others cannot derive) still guards against redundant
pairs.

## Consequences

- **The same-workflow constraint narrows to the stance pair alone.**
  `override` and `refines` are the only words gated on workflow
  membership — a separable, nameable subtask chain, defined by example at
  [S15069/T1171] (this session's own three: edge-relation design, note
  receipt trimming, recall render trimming). `depends-on` and every
  cross-phase word are indifferent to workflow; a workflow-unclear
  `override`/`refines` call downgrades to `depends-on` rather than guessing.
- **Scoring is deliberately split from grammar.** Legality is nine-cell and
  live immediately; what a legal edge is worth is not. `override` zeroing
  and `encodes` crediting were already all-phase in the live implementation
  and needed no change. Every other new-cell edge (chiefly evidence-source
  `refines`, the E→E cells this spec newly legalizes) is graph-visible but
  **election-invisible** until the scoring-trio redesign rules on the
  backfilled graph — an explicit, tested skip, not an accidental omission
  [S15069/T1169, S15069/T1171] (ticket 03, f09dc3a). Self-citation edges are
  the one place this default was overridden: the user ruled they
  **participate in scoring immediately** [S15069/T1180], against the
  standing isolation recommendation that would otherwise have followed the
  same interim-skip pattern.
- **The rubric shrinks instead of growing.** Seven per-word teaching
  paragraphs collapse into two reading rules; the injected SessionStart
  block and the settlement prompt stay byte-identical under the existing
  hash guard (ADR-0009's standing constraint), version bumped to v6.
- **The existing graph needs no repair pass for this change.** All five
  relaxations are supersets of previously-legal classes; the one true
  migration (decision 2's CHECK rebuild) is schema-only and data-lossless.
  The 24 existing `refines` edges' fork-topology compliance is folded into
  the ordinary `/settle` backfill rather than getting a dedicated pass
  [S15069/T1171].

## Open items

- **The scoring-trio redesign is still pending** on the backfilled graph: an
  evidence-phase scoring bucket for `refines`, the override victim's
  downstream treatment (does zeroing a node cascade to its `refines`
  descendants — ruled NO, non-contagious, left to per-edge judgment
  [S15069/T1169], but the trio still sets weights and ordering), and
  `grounded-on` as a fourth election key (ADR-0009's original open item,
  unchanged by this spec).
- **`supersedes` stays machine-only**, coexisting with the writer's
  `override` as two words with different provenance — a note's
  machine-judged supersession is not the same claim as a writer judging a
  conclusion wrong [S15069/T1163, S15069/T1169].
