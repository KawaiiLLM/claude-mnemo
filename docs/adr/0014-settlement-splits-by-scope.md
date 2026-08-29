# ADR-0014 — Settlement splits by scope: a topic pass draws the lines, an edge pass traces them

**Status:** accepted · 2026-08-29 · source: S15069 T1979–T1998 (purpose ruling
at T1984, blind simulation at T1988, teaching ruling at T1989, graph-first
rejection at T1993, permanence at T1995, orthogonality at T1996, threshold at
T1998) · spec: `.scratch/staged-settlement/spec.md` (Rev 5, five review rounds)
· amends ADR-0013 (nothing in the lane model moves; what moves is WHO draws a
lane and WHEN)

## Context

One settlement run judged three questions of different natural scopes inside one
long agent context:

- **turn scope** — what did each turn do (its note, its type),
- **window scope** — which topic lines run through this window (lane formation),
- **pair scope** — how does a landing relate to its basis (edges).

The order was fixed by the procedure: the turn-scope grind ran first, batch by
batch, and lane formation happened at its exhausted tail — with the task's
legacy lane words sitting in view the whole time as vocabulary decoys.

**The measured outcome.** The S18993 resettlement campaign produced four
phase/activity-sliced lanes on one task — `san11-ticket-implementation`,
`san11-live-demo-ops`, `san11-ui-interaction-research`, and a 174-member
`san11-mapc-terrain-research` blob. Those lanes cut HORIZONTALLY across the
vertical lines edges exist to trace. A ruling then settled what a lane is for:
edges exist so a landing can be traced back to the decisions and designs it
rests on, and a lane is one such traceable line [S15069/T1984]. Under that
purpose the campaign's output is not a naming problem; it is the wrong
partition.

**The counter-measurement.** The same window's notes were handed to a
same-tier model in a clean context whose ONLY job was the grouping — criteria
taught, answers withheld. It produced **zero** phase-sliced groupings, and put
the UI line's research→spec→tickets arc in ONE group [S15069/T1988]. Same data,
same model tier, same criterion: the difference was the context the judgment was
made in.

Three secondary diseases shared the root. A candidate ledger built during the
grind died with the context, so a crash retry restarted from zero. A window
holding genuine links but no legal container would deadlock an armed
connectivity gate [S15069/T1979]. And tagged edges collided with pre-existing
bare drafts pair by pair, because nothing ever reconciled them wholesale.

## Decision

**Split settlement by natural scope, with durable artifacts as the interface.**

- **Stage 1, the topic pass (window scope).** Audits each turn's own record,
  supplies missing `topic:` subject words, drafts every topic line the window
  holds, maps them onto existing lanes by SYNONYM only, creates what the rest
  need, disposes the homeless, writes the final lane projection. It cannot reach
  `commit` — enforced by its TOOLSET, not by its prompt.
- **Stage 2, the edge pass (lane and pair scope).** Reads the three snapshots
  the transition froze and re-derives nothing. Writes in-lane edges, one
  crossing pass, reconciles drafts, discharges debts, retracts with cause, and
  owns the terminal commit alone.
- **One claim, two stages.** The transition is a single fenced, NON-TERMINAL
  transaction: the job stays `claimed` under the same claim generation, so the
  ownership tuple grows a third member (`job`, `generation`, `stage`) rather
  than the generation bumping. The row is authoritative and a dispatch's verdict
  advisory — a landed transition whose verdict was lost still flows into stage 2
  with no attempt spent; a verdict the row never took is a deterministic
  failure.

**Why the split is by SCOPE and not by cost.** Two passes cost roughly two
contexts. What buys that back is not throughput — it is that the window-scope
judgment stops being made by an exhausted context holding the wrong vocabulary
in view. If the split had been drawn anywhere else (say, first half of the
window / second half), it would have bought nothing at all.

## Rejected

**Deriving the lane partition from the citation graph** [S15069/T1993]. The
tempting version: run the edges first, take connected components as lanes. It
was rejected as a SOURCE of the partition, and the shape numbers stage 2 now
reports are deliberately an AUDIT of it instead.

Three reasons, in the order they bind:

1. **Circularity.** Edges are written against a lane's members read as one
   thread. A partition derived from edges would be derived from a graph that
   was itself written against a partition — with nothing outside the loop to
   correct it.
2. **The graph is sparser than the truth.** Components answer "what is linked",
   and a line's early research turns are frequently linked to nothing yet. They
   would each become their own component, which is the finest possible
   phase-slicing rather than a repair of it.
3. **Splitting and merging on graph shape needs history nobody has.** A
   component count is a number about one moment; promoting it to a
   split/merge CANDIDATE needs a series. That promotion stays out of scope,
   and the shape numbers carry no thresholds and no candidate labels for
   exactly that reason.

**Teaching the old flow to name lanes better.** Tried and revoked (the 0.25.1
teaching-sentence patch). The blind simulation is the evidence that the
teaching was never the binding constraint: the SAME criterion produced a clean
partition in a clean context and a sliced one at the tail of a grind.

**Retroactively renaming existing phase-bearing lanes.** The phase-token
predicate governs new names only. Legacy names are the user's merge/retag call,
and a predicate that refused to DELETE a phase-bearing lane would lock in the
very names it exists to stop.

## Consequences

- A turn now carries a permanent subject word its author wrote at the time,
  searchable independently of whatever lane reorganizations follow.
- A crash between the two passes resumes at the boundary the row records —
  finished judgment work is never re-sent, and a reclaim spends its one attempt
  under the standing retry law, unchanged.
- Stage 2's authority, duties and graph vertices are READ from frozen snapshots,
  so a retry answers identically and a concurrent writer cannot widen a run past
  what stage 1 judged.
- A window with no legal container no longer deadlocks: the homeless record is
  per member and reduces by EVENT, so the future connectivity-arming ticket can
  exempt an orphan line by record instead of blocking on it.
- **The acceptance is a measured before/after, and it has not been run.** The
  S18993 campaign's diseased lanes stay frozen as the before-picture; the user
  reads the re-run's lane set against the title-derived vertical answer
  [S15069/T1986]. Until that runs, this ADR records a design whose feasibility
  evidence is one blind simulation on one window.
