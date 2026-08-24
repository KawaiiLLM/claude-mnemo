# Lane declaration — spec (Rev 2)

Status: draft. Author: main agent. Rev 1 → Rev 2 after a peer round (6 P1 + 4 P2,
all accepted) and three user rulings.
Rulings encoded: [S15069/T1524], [S15069/T1530], [S15069/T1532], [S15069/T1535],
[S15069/T1537], [S15069/T1541].

## Problem

A lane exists the moment somebody writes a tagged edge. Nobody creates one; you
fall into one. Two forces multiply them: `extends`/`narrows` are REQUIRED to
carry lane tags, so every pair of related turns mints a lane; and "the smallest
discriminating set" always lands on the leaf noun, while refinement-by-superset
makes a narrower topic a NEW lane instead of a continuation.

Measured live: **72 lanes over 380 tagged edges, 30 two-member, 14 literally one
edge**, while the six lanes with 12+ members are the only real workflows. A
second defect rides along: a lane tag can sit on an edge whose endpoint belongs
to no segment at all, so a "lane" can exist outside every container that gives
it meaning.

## Solution

A lane becomes a **declared** object, like a segment:

1. **Identity is `(segment, ONE tag)`.** An edge carrying `["a","b"]` is a member
   of lane `a` AND lane `b`.
2. **Declaration precedes use**, and **membership precedes declaration**: a tag
   may ride an edge only if EVERY endpoint's own segment has declared that tag.
3. **Cross-segment edges stay legal — under both segments' declarations.** No
   special mechanism: the same registry, consulted once per endpoint [T1541].
4. **Declaration goes through `remember`**, unique within a segment.
5. **The segment card lists its lanes**, each with its latest node's address.
6. **`timeline` gains a lane view**, so a lane reads as a chain.

## What this CHANGES about existing verdicts (Rev 2, peer P1-1)

Rev 1 claimed closure/validity/terminus logic was "unchanged". The logic is;
its INPUT PARTITION is not, and the user has ruled **merge** [T1541]. Stated
plainly, with the peer's own failure figure:

> `T2 --indexes{a}--> T1` closes lane `a`. Then `T3 --override{a,b}--> T2`.
> Today `{a,b}` is a third, independent lane, so lane `a` is untouched. After
> the merge that row acts on lane `a` AND lane `b`: T2 dies in `a` too, and
> lane `a` reopens.

This is accepted, not worked around. Consequences that must be re-derived rather
than assumed:

- **Checker**: declaration, override, dead members, closure/validity, and
  terminus are now computed over per-tag membership. `tests/shared/lane-
  interpretation.test.ts`'s pin that `{A}`, `{B}`, `{A,B}` are three independent
  lanes is REPLACED, not preserved.
- **Election / milestone tier** and **self-ground eligibility** read lane state,
  so their fixtures are re-baselined in the same batch; any tier change is
  reported in the ticket, never silently absorbed.
- **Console**: an edge belongs to several lanes now, so the payload's single
  `laneToken` becomes `laneTokens: string[]`, and the shell's focus/highlight/
  strip logic indexes edges by set membership (peer P1-6). D9's "console
  unchanged" is withdrawn.

## Implementation decisions

### D1 — the lane registry

```sql
CREATE TABLE lanes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  segment_id INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL,
  UNIQUE(segment_id, tag)
);
```

No title: the card pays per character and the tag is the name.

**Canonical tag predicate (peer P2-10).** A lane tag is stored only in canonical
form: NFC-normalized, trimmed, lowercase, non-empty, no interior whitespace runs.
`declare` REFUSES a non-canonical value rather than silently canonicalizing it,
so `write-gate`, `Write-Gate` and `" write-gate "` can never become three lanes.
The same predicate is applied to edge tags at write time.

**Two vocabularies, one enforceable invariant (peer P2-9).** `declare` refuses a
tag already in that segment's curated `tags`; `retag` refuses a tag already
declared as one of that segment's lanes, naming it. Without both directions the
separation is a storage detail, not a concept.

### D2 — the checks on a tagged edge write

Per tag, in this order, each refusal naming the gap:

1. **Canonical** — the tag is in canonical form.
2. **Declared at every endpoint** — for EACH endpoint turn, that turn's own
   segment has declared this tag. A homeless endpoint refuses (no segment, no
   declaration). Endpoints in different segments are legal exactly when both
   segments declared it [T1541].
3. **Subset invariant (unchanged)** — the tag is present on both endpoint turns'
   own `tags`.

**The invariant is enforced at every membership write, not only at birth (peer
P1-2).** `assign`, ownership-clearing, settlement's reassignment and any
member-seeding path re-check the incident tagged edges of every turn they move,
IN THE SAME TRANSACTION, and refuse a move that would leave an edge without a
declaration on both sides — naming the edges and the missing declaration. The
operator declares the lane in the destination segment first, then moves. Without
this the invariant is only true at birth, and a lane can drift from one segment
to another with no edge write at all.

### D3 — several lanes per edge

`memory_edges.tags` stays a canonical (sorted, deduped) JSON array; its meaning
becomes "the set of lanes this edge belongs to". Each tag is validated
independently by D2. `memory_edge_tags` remains the per-tag index and is rebuilt
in the same transaction as any tag mutation.

### D4 — the `remember` verbs

- `remember(verb="declare", id="E60", tag="write-gate")` — refuses a duplicate,
  a non-canonical tag, and a tag that is one of the segment's curated tags.
- `remember(verb="undeclare", id="E60", tag="write-gate")` — refuses while any
  edge in that segment still carries the tag, naming the count.

### D5 — identity in the checker

`LaneKey` becomes `{ segment, tag }`; `laneToken(segment, tag)`. A lane's DAG is
every live edge carrying that tag with an endpoint in that segment; members are
its endpoints. Three rubric clauses retire (v11): exact-set identity, superset
BRANCH, and set REOPEN. Branching becomes a different lane related by narration;
reopening stays a tagged `override`, which needs no set arithmetic.

### D6 — migration

Ordered, and **durable, not log-only (peer P2-8)**. A `migration_receipts` row
(id, name, applied_at_epoch, payload JSON) records each phase; a phase is skipped
only when ITS receipt exists — never inferred from the `lanes` table existing,
because the first process to open the upgraded database is often a hook, and a
crash after M1 would otherwise skip M2–M4 forever.

- **M0 — classify (read-only)**: build and persist the full disposition list for
  M2/M3/M4 before anything writes. M2 must not seed lanes for tags M4 is about to
  strip (Rev 1 had that ordering backwards).
- **M1** create `lanes`, and `migration_receipts` if absent.
- **M2** seed a lane per (owning segment, tag) from M0's list. Receipt: count per
  segment.
- **M3 — legal membership, by EXPLICIT ALLOWLIST (peer P1-4).** Rev 1's "≤2
  curated tags" heuristic is withdrawn: a count is not provenance. The migration
  carries a hard-coded, reviewed list of `(segment id, exact curated tag set)`
  pairs — today exactly `(E60, ["claude-mnemo"])` — and stamps that tag onto the
  segment's 1085 tagless members. Any other segment is REPORTED, never stamped.
  A member whose `tags` column is malformed or non-array is reported and skipped,
  never coerced to `[]` and overwritten.
- **M4 — illegal edges, BY RELATION CLASS (peer P1-3).** Stripping tags is not a
  universal repair: an untagged `extends`/`narrows` is itself rejected by the
  checker (E1), so Rev 1 would have converted one illegal shape into another.
  - `extends` / `narrows` with no legal placement: **delete the row**, recording
    both addresses, the relation and the tags in the receipt.
  - Other relations: downgrade to untagged, but only after checking for an
    existing untagged row for the same (pair, relation) — the `(pair, relation,
    tags)` UNIQUE key makes a blind UPDATE a collision — merging into it instead
    when one exists, and rebuilding `memory_edge_tags` in the same transaction.

### D7 — the segment card's lane list

```
    - lanes:
        arc-spine-redesign ◎E60/T8281 · codex-workflow E60/T8250 · write-gate ◎E60/T8100 →E60/T8290 …
```

`◎<addr>` = declared terminus; a bare `<addr>` = the lane's newest node, and the
absence of `◎` says "undeclared" without spending a word on it. `→<addr>` only
when the terminus is no longer the newest node (measured: +25 chars across all
63 lanes). Newest-first, truncated against the card's budget with a `+N 条` tail
— 63 lanes render 2012 chars ≈ 1449 injector-tokens, so the cap is load-bearing.
Addresses are the segment form `E<segment>/T<globalTurnId>` [T1532].

### D8 — the timeline lane view

`timeline(id="E60/L*", view="lane")`, or `E60/L3` for one lane.

```
[L1] 08-17 18:19 ⚖️ arc-spine-redesign
    ◎T53 => T48 -> ...(7)
[L2] 08-17 18:20 🔧 codex-workflow
    T25 -> T24 -> ...(8)
```

- Header: `[L<n>]`, the lane's NEWEST node's time, the modal TYPE emoji across
  its member turns (ties broken by the rubric's own type order), the tag.
  Trailing `(N)` on the chain = the lane's member count [T1541].
- Lanes ordered newest-first.
- **Path selection (peer P2-7, revised):** not greedy. Among the paths through
  the lane's newest node, take the one covering the MOST member turns within the
  item budget; relation preference — `extends`/`narrows` > `indexes` >
  `consume` > `override` — is only a tie-break between equal-coverage paths, and
  `consume` is in the order because the checker's path graph already contains it.
  A fork whose branch is not shown appends nothing; the trailing `(N)` already
  tells the reader how much of the lane the chain omits.
- `=>` marks an edge into an INDEXED node; `->` is ordinary continuation.
- Turns inside the viewed segment render bare (`T8281`); a turn from ANOTHER
  segment — legal now that both-declared cross-segment lanes exist — carries its
  own `E<seg>/` prefix, and a homeless one its `S<n>/`.

### D9 — what does NOT change

Settlement behaviour, scoring inputs other than the re-baselined lane state, the
note tool's fields, and the CONTENT of the 63 existing E60 lanes. Merging
`memory-policy`/`note-field-semantics`/`rubric-v5-design` into one lane is a
separate campaign the user deferred. (Rev 1 also claimed the console was
unchanged; withdrawn — see "What this CHANGES".)

## Testing decisions

Assert externally visible refusals and renderings, never internal calls.

- **`remember` boundary** — declare/undeclare happy paths; duplicate; a
  non-canonical tag (whitespace, case, NFC, empty); a tag colliding with the
  segment's curated tags; `retag` colliding with an existing lane; undeclare
  while in use.
- **Edge write path** — one test per D2 refusal, including the cross-segment
  pair where only ONE side declared the tag.
- **Membership write paths** — `assign` refusing a move that would strand an
  incident tagged edge, and the same for ownership-clearing and settlement
  reassignment; each asserting the transaction left NOTHING behind.
- **Migration** — over a fixture mirroring the live shapes (homeless endpoint,
  cross-segment edge, multi-tag edge, `extends` with no legal placement, a
  member lacking the segment tag, a 29-tag legacy segment, a malformed `tags`
  column): assert the receipt ROWS (not log lines), that a second run is a
  no-op, that the legacy segment is reported and its turns untouched, and that
  an `extends` row is deleted rather than downgraded.
- **Checker** — the peer's own figure as a fixture: `indexes{a}` then
  `override{a,b}`, asserting lane `a` reopens. This is the merge, pinned.
- **Election / self-ground** — re-baselined fixtures, with any tier change named
  in the ticket.
- **Console** — `laneTokens` plural in the payload; an edge highlighted under
  either of its lanes.
- **Card + lane view** — the three lane-row shapes and the budget tail; the lane
  view's header (emoji choice, count), path selection on a diamond where the
  short branch is newer, and the foreign-turn prefix.

Mutation-verify: the declaration check, the both-sides check, the membership
re-validation, M3's allowlist, M4's relation split, and the path-coverage rule.

## Out of scope

- Merging the existing 63 lanes into ~18 (deferred).
- Settlement or scoring changes beyond re-baselining.
- Retagging E53/E58/E59 by hand (reported by M3, not performed).
