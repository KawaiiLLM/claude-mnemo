# Settlement edges checklist — TRIAL CUT r2 (peer-round repairs integrated)

This replaces the production prompt's edges bullet. The production bullet
taught only the bare-address call shape; this one teaches the tagged form
and the lane duties.

## Edge call shape

An edge entry is either a bare address ("S15069/T7") — an UNTAGGED edge,
acting on the cited turn itself — or a tagged entry
`{ "turn": "S15069/T7", "tags": ["lane-tag"] }` — a TAGGED edge, acting on
the named LANE. extends/narrows accept ONLY the tagged form. The tags you
put on an edge must already be on BOTH endpoint turns' own tags (write the
turns' tags first, then the edge — the subset invariant refuses otherwise).

## Lane construction checklist (work it in this order)

1. READ the window as threads: which runs of turns are one continuing line
   of work (a topic investigated across turns, a build iterated, a decision
   refined)? A thread of two or more same-phase turns connected by
   supplement/correction IS a lane — the mandate forbids leaving it
   unnamed. Discover threads from turn CONTENT and explicit predecessor
   language, independently of the existing edge stock — a missing edge is
   work to add, never evidence that the thread is absent.
2. NAME each thread with the smallest discriminating tag set — reuse a noun
   the member turns already carry only after the scope self-question: does
   this exact tag set name the SAME sub-result on both endpoints, and only
   ONE connected component in ONE phase? If not, narrow or mint a fresh
   lowercase-hyphenated noun instead of riding the topic word. Never use
   the segment's own tags. One exact set = one lane: it may not name
   disconnected components.
3. TAG the member turns: every member's tags must contain the lane's tags
   (full-set rewrite of that turn's tags, keeping its existing nouns).
4. JUDGE each edge by the CITED CLAIM before choosing the word: the cited
   result still fully valid and this turn adds to it = extends; part of it
   withdrawn, bounded or re-scoped by this turn = narrows; its main result
   replaced outright = override; merely used without answering for it =
   consume. Shared topic, temporal adjacency, or keeping the lane
   single-sink are NOT evidence for extends. Each edge points to the PAST.
   Keep the lane a single-source, single-sink DAG — diamonds fine, dangling
   parallel heads/tails illegal (fork a branch with a superset tag set
   instead). Complete each lane's continuation along the same-phase
   OPTIONAL words too — tagged override for in-lane replacement, consume
   and indexes where the rubric reads them as lane events — never truncate
   a lane at the boundary of the mandatory extends/narrows stock.
5. DECLARE convergence by judging the CONTENT, not the existing edges:
   explicit resolved/locked/converged language, a completed verification, a
   release, or downstream adoption of the thread's result are the evidence
   to check; a lane whose content shows convergence closes with the
   terminus writing a TAGGED indexes citing the lane's core valid nodes.
   Being the latest node, or work merely stopping, stays insufficient —
   those lanes honestly remain OPEN. The absence of an existing indexes
   edge is never evidence either way: producing the declaration is YOUR
   job.
6. REPAIR stock: an existing UNTAGGED extends/narrows edge is illegal under
   the mandate. Either retag it (add the lane's tags to both endpoints,
   rewrite the edge tagged) when it really is continuation, or retract it
   and rewrite with the right word (per step 4's claim-first judgment) when
   it is not. Never leave one standing. Stock repair is one duty among the
   steps above, never the scope of the whole pass.
7. LEAVE alone: cross-phase citations (consume/grounds/verifies/refutes)
   stay untagged; isolated single-turn products join no lane; do not force
   a lane where no continuation exists.

## What NOT to do

- Do not put a lane tag on an edge whose endpoints' tags lack it.
- Do not create single-node lanes (a lane needs at least two nodes joined
  by tagged edges).
- Do not tag consume/grounds/verifies/refutes across phases.
- Do not use the segment identity tag (claude-mnemo) as a lane tag.
- Do not let one lane's members span two phases — a lane selects one phase
  and every member carries at least one type in it.
- Do not rewrite titles/content/insight/type in this pass — this trial's
  scope is tags and edges only.
