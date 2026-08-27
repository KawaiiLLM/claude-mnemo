# 01 — A draft edge cannot pass `lane_check` or commit

**Status:** WITHDRAWN — the premise was false. Do not implement. Kept as the record
of a wrong diagnosis and the evidence that overturned it.

**Withdrawn:** 2026-08-27, [S15069/T1830], on a worker's refusal to implement.

---

## What the ticket claimed

That `S15440/T550 -> T548` (row 574) was an unjudged DRAFT edge carrying
`relation=''`; that 1967 such rows existed, 46% of the edge table; that they were
invisible because the loader reaches edges only by lane tag (via
`memory_edge_side_tags`) or by relation word (`STANCE_RELATIONS`), and a
both-empty row matches neither; and that E6 — "a DRAFT edge … commit refuses while
one remains" — was therefore structurally blind.

## Why that is wrong

**`relation = ''` does not exist.** The column's CHECK is
`relation IS NULL OR relation IN (<seven words>)`, and `SELECT COUNT(*) … WHERE
relation=''` returns **0**. The measurement that produced 1967 used
`coalesce(relation,'')=''`, which merges NULL with empty string. Every row counted
was `relation IS NULL`.

**A NULL-relation row is not a draft.** `db/memory-edges.ts` defines it: a pair may
hold ONE bare row that "records nothing except that the pair exists … the pair's
existence record OF LAST RESORT". It is derived from the citing turn's PROSE.
Production: 958 `text-ref` and 1011 from a legacy `cites` import. Row 574 is one of
those, `provenance='judged'`, from the import — not settlement debt.

**The gate is a different predicate.** Not the side-tag index and not the relation
word list, but `me.relation IS NOT NULL` — six sites in `db/lane-checker-load.ts`
(401, 436, 574, 609, 683, 1285) plus the writable-set closure in
`db/note-settlement.ts:400`. Even the two out-of-vocabulary passes carry it, which
is why a bare row never appeared on the warning side either. That predicate is the
single mechanism keeping the prose-reference layer out of lane semantics.

**The real draft edges are already caught.** A draft is a row with a relation word
and an unsettled SIDE. There are 772, and E6 sees them — so the ruling this ticket
was filed to satisfy ("a draft edge must not pass commit or `lane_check`") was
already true when it was made.

## Why implementing it anyway would deadlock

Verified by the worker before it stopped, and this is the part worth keeping:

- The closure query carries the SAME `me.relation IS NOT NULL`, so a bare row's far
  endpoint never enters a window's writable set. Of the 961 bare rows visible to
  the checker's own domain, **687 have a `cited_id` that is never the cited side of
  any live relation edge** — no window's closure can ever reach them. **838 anchor
  turns across 20 sessions** would be permanently unpassable.
- There is no repair surface even where the endpoint is writable. Retraction
  addresses `(pair, relation word)`; a bare row has no word, so it answers
  `no-such-edge`. Tagging goes through `attachTurnRelations`, which CREATES a row
  keyed `(pair, relation, tail, head)` and never settles the bare one. That is
  exactly why job 114 wrote two fresh `consume` edges on T550 and left 574 — the
  mechanism, not an oversight.
- The blocking would be self-inflicting. `recomputeTurnCitedPairs` mints a
  `text-ref` bare row for every `[S/T]` in a note's prose, anchored on the turn
  being written. If bare rows blocked, writing a citation would lock the turn that
  wrote it, with no exit.
- Bare rows regenerate from prose: `restoreBareRowsForEmptiedPairs` puts one back
  after a retraction empties a pair, as long as the prose still names the target.

## If the goal is revisited

Making the 961 rows VISIBLE is reasonable; making them BLOCKING is not, until three
things exist, in this order: a pair-addressed disposition for a bare row
(retract-by-pair, or bare→relation promotion); the closure relaxed off
`relation IS NOT NULL`; and an arbitration rule between prose regeneration and a
recorded disposition. Until then the correct landing place is the WARNING side —
`vocabularyConformance` or a new bare-stock report — which needs no change to
`shared/lane-checker.ts` and cannot deadlock.

## Notes

The refusal was the deliverable. The brief said a correct refusal beats a working
feature here, and the worker produced numbers, a runnable probe and a verdict
instead of code.
