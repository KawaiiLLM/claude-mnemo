# Milestone election v2 — lane-first structural election

Ruled S15069/T1350–T1360 (2026-08-23), one peer round (mnemo-review, 9 findings,
all resolved by ruling or absorbed). Supersedes the effGrade + edge-signal
election chain in `src/mcp/timeline.ts` wholesale.

## Problem Statement

The current election predates the v10 lane model and elects the wrong end of
every lane: extends in-degree piles on origins (T900←3 while converging T913
sits at 0 — the fork-topology finding), releases lose their seats (998/1001
both unelected on T900-1001), and within-grade scalar scoring produces 93-100%
ties (the null-result experiment). v10's graph now DECLARES its structure —
termini, lanes, convergence — so election can read structure instead of
inferring importance.

## Definitions (ruled T1356/T1358/T1360 — these amend the rubric's §Relations)

- **lane**: a clearly separable sub-workflow within ONE phase under a segment,
  uniquely identified by an exact tag SET, scoped to that segment, taking the
  form of a DAG of tagged edges. A lane has AT LEAST TWO nodes, and every
  node's own tags must contain the lane's tags. Lanes never cross phases; only
  cross-phase relations connect lanes of different phases.
- **fork**: a lane may start from another lane's node — add tags to the
  parent's set for a new branch, or inherit the parent's exact set to REOPEN a
  closed lane.
- **closed lane**: the lane's LATEST node is its terminus — the node that
  declared convergence via tagged indexes. A finished lane gets a terminus
  regardless of validity or adoption. **open lane**: the latest node is not a
  terminus — the lane is in progress.
- **valid / invalid** (closed lanes): valid = the terminus's declared core
  contains at least one LIVING node; invalid = the entire indexed core is dead.
  The abandonment ritual is repudiate-then-declare (override the wrong
  conclusions, then declare closure indexing the dead core — the terminus
  carries the story); a lane whose product is later wholly repudiated slides
  into invalid retroactively. A fizzled lane (no product, nothing to bury)
  stays OPEN forever — convergence never happened and undeclared is the honest
  state; no machinery.
- **Single-node lanes do not exist** (T1360, upholding v10's isolated-product
  rule). The self-indexes closure clause is WITHDRAWN; `indexes` keeps
  refusing self-targets and Gate C's self-grounds stays the only legal
  self-edge. An important isolated turn competes through in-degree and
  release indexing.

## The election (replaces the whole chain; no weights, no scalar mixing)

1. **Candidacy exclusion** (uniform, T1360 ⑦): rolled-back turns, skipped
   turns, and every node carrying an override OR refutes in-edge — any tag
   state — leave candidacy entirely. Recovery is edge retraction (a refutation
   found false is deleted, restoring the node). The corrector carries the
   correction story.
2. **Identity tiers** (lexicographic, highest wins):
   - ① writers of untagged indexes (cross-lane aggregation — releases);
   - ② closed-VALID lane termini, and open lanes' LAST declarer (the most
     recent tagged-indexes writer — a reopened lane shows its last stable
     milestone); an invalid lane's terminus holds no tier-2 seat;
   - ③ nodes indexed by ELECTED tier-①/② nodes (assigned after tiers ①②
     seat — a two-stage fill);
   - ④ correctors (override writers, citers of reversed turns);
   - ⑤ everything else.
3. **Within a tier**: positive in-degree — narrows/extends/consume/indexes/
   grounds/verifies, +1 per edge, self-edges included (T1180 upheld: Gate C
   prices a self-grounds at a real declared convergence) — then, on ties,
   out-degree (all edges), then the LATER turn wins the seat.
4. **Budget & degradation**: the renderer's existing milestone budget applies
   unchanged; an edgeless window degrades to recent-N (all tier ⑤, zero
   scores, recency) — no era gate, no compatibility shim.
5. **Display**: elected rows render in TIME order, never score order. The
   `↳` line under an elected row lists ONLY its cited turns that are
   themselves elected; unelected cited turns are omitted; the line's budget
   cost is attributed to the citing row.

## Retirements (explicit, all ruled)

- effGrade leaves the ELECTION entirely (grading/settlement pipelines are
  untouched — retiring grading itself is not this spec).
- The always-keep chain (endpoints ∪ correctors ∪ reversed ∪ era-G4) retires;
  correctors become tier ④ — visibility is now a budget outcome, not a
  guarantee (measured: on T900-1001 tiers ①② already overfill the budget and
  ④ never activates; conscious choice).
- Era gating retires (no fixed cutoff; degradation covers laneless windows).
- Scoring-rulings supersessions: consume now credits in-degree (supersedes
  "depends-on 不涉分"); narrows credits (the interim distortion resolves);
  override/refutes become a candidacy kill (supersedes both all-or-nothing
  zeroing and the interim −1/tier-demotion drafts); extends keeps crediting,
  now caged within tiers.

## Non-goals (ruled)

- No lane-coverage quota (T1356 ②): the goal is the more important nodes;
  terminus identity already leans one-representative-per-lane.
- No lane-wide adoption inheritance: node-level in-degree only. Measured
  consequence accepted: ownership's terminus 913 loses its seat on T900-1001
  because that lane's adoption lands mid-lane (bypass 5 in report 4a) —
  transitional, self-correcting under the cite-through-terminus discipline,
  monitored by the checker's 4a bypass count.

## Measured baseline (T900-1001, budget 9, sim /tmp/turn-graph/sim-election.ts)

Elected: **T922, T929, T939, T946, T981, T984, T990, T998, T1001** (2 releases
+ 7 termini; overlap 1/9 with the retiring selection {900,910,912,935,939,958,
972,973,978}). Excluded under the final rules: 925 (untagged override victim),
957 (tagged), 935 (refuted by 941). write-gate reads OPEN-no-declarer and holds
no seat. All 11 closed lanes are valid on this window.

## Implementation notes

- Reuse the shared lane reducer (lane-interpretation.ts) for terminus/closed/
  open state — no parallel derivation in timeline.ts.
- The rubric's §Relations lane paragraph gains: ≥2 nodes, DAG form, the
  fork/reopen sentence; budget headroom is 29 chars — the edit REQUIRES
  trimming elsewhere in the same pass, measured before commit.
- The valid/invalid state belongs in the checker's report 1 as a fact line
  (closed-valid / closed-invalid / open), alongside the T1351 follow-up:
  cited-from-outside should also print consume-class citations.
- Tests: the sim's elected nine becomes the golden; retirement grep-guards for
  the always-keep/effGrade election path; mutation targets = the exclusion
  rule, tier assignment, two-stage tier-③ fill, elected-only ↳.

## Out of scope

The backfill campaign, console integration, retiring grading itself, and any
write-gate change (explicitly: self-indexes stays illegal).
