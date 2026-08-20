# ADR-0009 — Edges declare standalone; a pair holds many relations; settlement is re-armed

**Status:** accepted · 2026-08-20 · source: S15069 T1109–T1124 (peer review round T1121, grilling
six rulings T1122–T1124) · spec: `.scratch/edge-mechanism-revision/spec.md` · evidence:
`.scratch/edge-rebuild-t900-1000/report.md`

## Context

The graph had not grown, and structurally could not. Over a 101-turn window the rebuild found **2
relation edges**; **54 of 96** notes were disqualified from ever carrying one, because a relation
could only ride on a citation the prose had to spend content budget printing; the release
collapse rate was **0/21**. Settlement ran its window healthily every day and attached no
relations at all — its window was narrower than the arcs it was asked to connect, its authority
admitted only upgrades of edges someone else had already created, and its instruction was to
leave the doubtful alone. One pair could hold one relation, so a landing turn could not say it
both depended on a plan and encoded a ruling. The user's stated goal — trace a release back to
every decision it solidified — was unreachable by construction, not by under-use.

Three earlier decisions produced that state, each defensible when made:

- **Co-occurrence** (settlement-agentic spec **C6/C7**): a pair exists iff the citing body's
  post-state names it, and a relation may only attach to a pair the same call is creating (main
  agent) or that already existed pre-transaction (settlement).
- **One relation per pair** (spec **C5**): edge identity is the pair; relation is a nullable
  attribute, and a second relation on the same pair overwrote the first.
- **Prose retirement for settlement** (`.scratch/ownership-and-note-cadence/spec.md`,
  "结算不再重建笔记"): the settlement facade refused `title`/`content`/`insight` outright,
  leaving four structured fields.

## Decision

### 1. Prose and edges decouple; C7's dual channel retires

An edge is a **standalone claim**. `content` owes it no citation format, a `note` call carrying
nothing but relation fields is valid, and the body-post-state citation scan is **deleted, not
bypassed** — `not-cited` and `duplicate-target` left the rejection union entirely (spec user
story 18: a retired contract must not be able to half-fire). What stays machine-checked is only
what a claim cannot be wrong about by construction: the **citing** turn's own write gate
(ADR-0008), address existence and exposure, phase legality, `crossSession` confirmation, and the
self-loop refusal. The gate field for an edge write is `type` — **checked, never stamped**: phase
legality already rests on the citing turn's type, and stamping it would tell settlement's
freshness rule that an agent had fresher knowledge of a field the edge write did not correct.

**What we gave up, stated plainly.** The prose anchor was the design's one structural guarantee
that a relation came with an argument a human could read at the same address. We are abandoning
it because it bought less than it cost: settlement-agentic's own **C8** already recorded that
co-occurrence eliminates bodyless and free-standing edges and **not** spurious ones — a body
reading `Related: [S1/T2]` beside an `override` field passes every structural check while
containing no overturning argument. So the check never proved semantic truth; it only made every
true edge pay content budget for a citation nobody read, and the measured price of that toll was
54 notes that could not carry a relation at all.

**We also declined the symmetric fence.** A draft required the writer to have READ the cited turn
before pointing at it. Ruled out at [S15069/T1124]: read authorisation governs the entity being
**written**, and an edge write modifies the citing turn only. Requiring a read of the target would
invent a second permission machinery for edges alone (user story 17) and would make the
from-zero rebuild — where the settling agent sees the whole window in one prompt — argue its way
past a gate designed for a different risk.

**C8's residual risk is therefore accepted and re-homed**: false edges are now prevented by
judgment (the Memory Rubric's 关系 checklist, one shared text) and corrected by retraction
(decision 2), not by a structural check that never caught them anyway.

**The bare layer narrows to match.** Prose text-refs still materialise a **bare** pair row
(`relation IS NULL`, provenance `text-ref`) and still feed the display hints (`↳`, cited-by
counts) — **C6 survives, scoped to that layer alone**. It no longer reaches relations: the
reconcile's stale-delete gained `relation IS NULL`, so a later note edit that stops naming a turn
can no longer silently destroy an edge nobody retracted. This coherence fix was deduced from the
decoupling ruling rather than written in the spec, and it is load-bearing: without it, a rubric
that tells the writer *not* to cite in prose would have turned every note correction into an
unannounced edge deletion. **text-ref is demoted for good** — no code path may treat a bare row as
a substrate to upgrade into a relation.

### 2. A pair holds many relations; a wrong one is hard-deleted

`memory_edges` rebuilds around **(pair, relation)** identity: at most one bare row per pair
(partial unique index), one row per relation claim (five-column unique), self-loops unstorable at
the table layer. C5's "non-null relation wins" upsert retires — a relation write is **additive**,
and correction is **retraction plus rewrite**, two auditable acts rather than one silent
overwrite. Two symmetric dedupe rules keep one fact in one row: a bare write is a no-op when the
pair exists in any form, and a relation write drops the pair's bare row, whose entire content
("this pair exists") the relation row already states.

Retraction is a **hard delete**, and **both writers hold it over either's edges**
([S15069/T1124]: a false assertion must not outlive its refutation on account of who filed it).
**No tombstone, and the consequence stated plainly**: a retracted row leaves no trace in the live
database, so "what did that run retract" is a question the live database **cannot answer** — not
by a status column, not by a deleted-at stamp, not by a join. The only audit surface is **external**:
the dump/backup snapshots, diffed across two points in time. A mixed call whose addresses include
one carrying no such edge deletes **nothing** and names the offender. Which relations may coexist
is judgment, ruled by the rubric's **deletion test**: keep a relation only if removing it would
lose a fact the others cannot derive; a weaker restatement of a fact already kept goes.

One live-database consequence is deliberately NOT a tombstone and should not be read as one:
retracting a pair's **last** relation re-mints the pair's **bare** row when the citing prose still
names the target (`restoreBareRowsForEmptiedPairs`), so the `↳` pull-through survives. That row
records that the citation exists, never that a relation was removed — a pair the prose never named
stays gone.

Rejected alternative: keeping one relation per pair and adding a compound vocabulary word for
each observed combination — it grows the word list combinatorially and forces a re-judgment of
every existing edge each time a pair turns out to carry a new pairing.

### 3. Settlement is re-armed as the hindsight main agent

Settlement holds the **main agent's full write authority inside its rendered range**, plus
exactly one extra tool (`commit`). Two rulings are explicitly revoked:

- **"结算不再重建笔记"** (`.scratch/ownership-and-note-cadence/spec.md`): `title`/`content`/
  `insight` write through the same mode vocabulary, the same gate, and — closing the exemption
  ADR-0007's amendment recorded — the **same complete-read requirement** (ADR-0008 rung 5), with
  settlement's context render now recording per-field completeness. The plumbing the retirement
  removed (`reconstructableTurnIds`, the reconstructed-shadow-note path, `rideTurnId`,
  `writerModel`) does **not** return: prose lands through the ordinary note path.
- **C7's pre-existence fence**: the pair-key snapshot, the frozen∩current intersection, the
  `duplicate-target` mirror and `db/memory-edges`' whole `eligibleForRelation` option are
  **deleted** (75 call sites swept). A rebuild-from-zero backfill starts with no edges at all, so
  "the pair must already exist" was the one premise it could never satisfy.

Window **25 → 50** consecutive turns (the only settlement trigger with a threshold at all;
compact/residual/sessionend/backfill stay event-driven): a hindsight pass over arcs must be at
least as wide as the thing it is asked to connect. Membership opens to **create + cross-segment
reassign**, and a settlement-minted segment **auto-attaches to the settling session** — otherwise
it would not reach the roster the next window reads, and settlement would keep re-minting it.
Relation provenance survives the convergence rather than being flattened by it: the shared
`attachTurnRelations` gained a provenance argument so settlement stamps `judged` while both
writers share one attach path (spec C12's audit distinction), and **nothing downstream ranks the
two** — a settlement relation is not weaker than an agent's.

**The transition watermark.** Re-arming a 50-turn pass over a database of already-finished turns
would make a plugin update a token storm. At migration the transition records, **per session**, the
**contiguous finished prefix** that already existed — the floor below which that session's turns are
excluded from automatic settlement. Every **automatic** planner computes its window from its own
session's floor forward, and queued automatic jobs are swept to abandoned (provably complete: any
such job was cut from turns that already existed). Manual `backfill` is exempt **structurally** —
the bound applies to non-backfill trigger types only — so pre-watermark turns have exactly one
settlement channel, and it is the operator's ([S15069/T1124], user story 13).

The shape is a **set of per-session floors, not a global high-water id** (repair 09, caef4be —
the first cut stamped `MAX(turns.id)` and is retired). Each floor is `MIN(unfinished prompt) - 1`
with a `MAX(prompt)` fallback, stored sparsely (`note_settlement_watermark_floors`; a missing row
**is** floor 0), alongside the surviving singleton row as the bare one-shot marker, which must
exist even for a database with zero sessions. A global id-based stamp fails on function, not on
taste: turns still **in flight** at migration time sit below `MAX(turns.id)`, so a provisional turn
that finished a minute later could never re-enter automatic settlement at all; symmetrically, a
single global "below the oldest unfinished id" bound lets one stranded active turn anywhere drag
the entire corpus back into automatic settlement. The accepted price of contiguity, pinned by
fixture: **finished turns sitting above an unfinished one re-enter the window** — no single range
can admit prompt 2 and exclude prompt 3 — and since this build never settled them, they settle
once. The unfinished predicate matches turn-liveness **verbatim**; narrowing it (e.g. by the
real-prompt predicate) re-creates the stranding bug for rolled-back rows stuck in `active`.

## Consequences

- The three-way split of judgment holds: FORMAT on each parameter's `.describe()`, TIMING on the
  tool description, JUDGMENT in the Memory Rubric alone. The rubric gains the decoupling clause,
  the deletion test, the release ritual and (ruled verbatim at [S15069/T1130]) the retraction
  clause; it stays **byte-identical** across the SessionStart injection and the settlement
  prompt, under the standing hash guard — the two writers cannot drift into two rubrics.
- Settlement is no longer a second write surface anyone must reason about separately. The
  registered difference set is `{commit}`, pinned by object identity at the registration seam
  (`tests/worker/note-settlement-parity.test.ts`), which is why re-arming needed no new tool.
- A load-bearing ordering now exists inside settlement's context build: recall's session render
  pre-marks listed turns' content complete under its 200K budget, and the context build's own
  completeness flush runs **after** it, last-wins. Reverse the order and a truncated note becomes
  whole-overwritable — the exact loss rung 5 exists to prevent.
- The release chain is **pure teaching, zero mechanism** (rubric only): a release turn gathers
  what it shipped (`depends-on`) and the rulings it fixes (`encodes`) and cites the previous
  release, with the first release as the chain's legal root. Nothing enforces it; nothing needs
  to, because an unenforced ritual that the shared rubric states is what both writers read.
- ADR-0002's per-layer writer table is amended, not overturned: turn prose has one *primary*
  writer and one *hindsight* writer under one gate, which is what makes a second writer safe.
- The actual graph repair — the T998 drain, the 54 over-budget notes, the pre-watermark backlog —
  is **operator work after release**, not code: manual `backfill` runs at the scope the user
  chooses.

## Open items

Recorded rather than papered over:

- **Settlement cannot see `type`/`tags`.** Its render carries no metadata line, so extending the
  complete-read requirement to those two fields would refuse every correction of them. They are
  writable and gated on rungs 1–4 only — the same shape ADR-0007 recorded for prose before this
  decision closed it, now narrowed to two fields. Needs its own ticket (the fix is a render
  change, not a gate change).
- ~~**`commit` metrics count neither prose nor retractions.**~~ **Closed** by this batch's repair
  11: the counts split one bucket per verb — prose writes, relations written/restated/retracted,
  proposals, segments created, reassignments, session narrative — and `create` no longer reports
  itself as a proposal. The receipt now answers "what did that settlement pass do" on its own.
- **Scoring is untouched and is NOT final** (spec **D10**). The three scoring changes — an
  out-degree key, the override victim's treatment, and `grounded-on` as a fourth key — plus every
  election weight, wait for a graph worth scoring: they are judged after the edges are actually
  filled in, on real data, not on the 2-edge window that motivated this batch. Nothing here
  touches `edge-signals`' scoring logic.
- Vocabulary gaps left open from the rebuild report's A-series: A2 (`responds-to` missing),
  A3 (`grounded-on` source lock), A7 (pre-registration). A5/A10/A11 are dissolved or accepted.
