# Settlement edges checklist — TRIAL CUT (the improved teaching under test)

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
   unnamed.
2. NAME each thread with the smallest discriminating tag set — reuse a noun
   the member turns already carry where one fits; mint a new
   lowercase-hyphenated noun only when nothing fits. Never use the
   segment's own tags.
3. TAG the member turns: every member's tags must contain the lane's tags
   (full-set rewrite of that turn's tags, keeping its existing nouns).
4. WIRE the edges: in-lane continuation = tagged extends; in-lane partial
   correction = tagged narrows; each edge points to the PAST. Keep the lane
   a single-source, single-sink DAG — diamonds fine, dangling parallel
   heads/tails illegal (fork a branch with a superset tag set instead).
5. DECLARE convergence where the window shows it: the thread's last node
   writes a TAGGED indexes citing the lane's core valid nodes — that node
   becomes the terminus and the lane CLOSES. A thread that just fizzles
   stays undeclared and OPEN — do not invent convergence.
6. REPAIR stock: an existing UNTAGGED extends/narrows edge is illegal under
   the mandate. Either retag it (add the lane's tags to both endpoints,
   rewrite the edge tagged) when it really is continuation, or retract it
   and rewrite with the right word (consume/grounds/override…) when it is
   not. Never leave one standing.
7. LEAVE alone: cross-phase citations (consume/grounds/verifies/refutes)
   stay untagged; isolated single-turn products join no lane; do not force
   a lane where no continuation exists.

## What NOT to do

- Do not put a lane tag on an edge whose endpoints' tags lack it.
- Do not create single-node lanes (a lane needs at least two nodes joined
  by tagged edges).
- Do not tag consume/grounds/verifies/refutes across phases.
- Do not use the segment identity tag (claude-mnemo) as a lane tag.
- Do not rewrite titles/content/insight/type in this pass — this trial's
  scope is tags and edges only.
