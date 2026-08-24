# Lane declaration — spec (Rev 3)

Rev 1 → Rev 2 after a peer round (6 P1 + 4 P2, all accepted). Rev 2 → Rev 3
after a field study over real windows and six further user rulings. Six of the
ten tickets are already committed; this revision is what the remaining four are
built against.

Rulings encoded: [S15069/T1524], [S15069/T1530], [S15069/T1532], [S15069/T1535],
[S15069/T1537], [S15069/T1541], [S15069/T1547], [S15069/T1548], [S15069/T1552],
[S15069/T1553], [S15069/T1557], [S15069/T1560], [S15069/T1562].
Rubric text: `.scratch/lane-declaration/rubric-v11-lane-sections.md` (the user's
own wording; ticket 08 reproduces it verbatim).

## Problem

A lane used to exist the moment somebody wrote a tagged edge. Nobody created
one; you fell into one. Measured live: **72 lanes over 380 tagged edges, 30 of
them two-member, 14 literally one edge**, while the six lanes with 12+ members
were the only real workflows. Two forces produced that: `extends`/`narrows`
were REQUIRED to carry a tag, so every related pair minted a lane; and
identity-by-exact-tag-set made every refinement a new lane rather than a
continuation.

## Solution — five moves

1. **A lane is declared.** Identity is `(segment, ONE tag)`. `remember(declare)`
   mints it; a tagged edge may name only a declared lane, and only in a segment
   both endpoints belong to.
2. **Ownership moves to settlement** [T1547]. The main agent writes
   title/content/insight and a first pass at type/tags/edges; it is NOT required
   to write lane tags, and its field descriptions say so. Settlement owns
   declaration and tagging outright, because lane membership is a hindsight
   judgment — forcing it at the moment of the first edge is what produced the
   single-edge lanes.
3. **The mandate is replaced by pressure** [T1547/T1548/T1553]. No word requires
   a tag. Instead the checker reports two facts: a cluster of 4+ untagged turns
   connected to each other, and a segment whose lane count exceeds 0.05 × its
   member count. Warnings, never refusals.
4. **A lane is not phase-local** [T1562]. All eight words may carry a tag, so a
   tagged `grounds` is how a design line continues into the delivery that ships
   it. One edge may carry SEVERAL tags — the confluence — so a batch that lands
   three lanes' work names all three, and each lane still reads complete alone.
5. **One address grammar** [T1557]. `S<session>/T<prompt>` on every render and
   in every selector; a segment appears only as a scope: `E31/S123/T1..S234/T10`.

## What changed since Rev 2

- **Rev 2 said lanes stay same-phase and span phases only through multi-phase
  hinge turns.** A field study over two real windows measured the cost and the
  user then removed the restriction entirely. The study is worth keeping for its
  numbers: multi-phase turns are 33%/49% of those windows and 46%/53% of legal
  edges already joined turns whose phase SETS differ, so the same-phase rule was
  never rigid; but of 29 cross-phase references only 13 broke a line, and 12 of
  those originated from dispatch/acceptance/release turns that have no single
  sub-task identity anyway (T1150 fans in 17 and grounds into FOUR lanes; T1140
  lands three unrelated repairs in one turn). With cross-phase tags the question
  is moot, and so is the type-annotation nudge Rev 2 was going to need.
- **Rev 2 had the delivery arc as its own campaign lane.** Withdrawn: a per-batch
  lane is a transaction, born and converged and never continued, which the lane
  definition explicitly excludes. Confluence tagging replaces it — the delivery
  arc joins the lanes it serves.
- **Rev 2's `E<segment>/T<globalTurnId>` address is withdrawn** along with the
  segment ordinal before it. Both made `E<n>/T<m>` mean something, and it
  already meant a third thing in `recall`'s selector.

## Implementation decisions

### D1 — the registry (SHIPPED, 2d14a3c)

`lanes(id, segment_id → segments(id) ON DELETE CASCADE, tag, created_at_epoch,
UNIQUE(segment_id, tag))` plus `migration_receipts`. No title: the card pays per
character and the tag is the name. A lane tag is stored only in canonical form
(NFC, trimmed, lowercase, non-empty, no interior whitespace) and `declare`
REFUSES a non-canonical value rather than normalizing it. `declare` refuses a
tag already among the segment's curated tags; `retag` refuses one already
declared as a lane — the two vocabularies are separated by an enforced
invariant, not by intent.

### D2 — the checks on a tagged edge write (ticket 02, NOT YET BUILT)

Per tag, in order, each refusal naming the gap: canonical form; declared in
EVERY endpoint's segment (a homeless endpoint refuses; endpoints in different
segments are legal exactly when both segments declared it); and the subset
invariant — the tag is on both endpoint turns' own `tags`.

Enforced at every membership write, not only at birth: `assign`,
ownership-clearing, settlement reassignment and any member-seeding path re-check
the incident tagged edges of every turn they move, in the same transaction, and
refuse a move that would leave an edge undeclared on some side.

**No word requires a tag** [T1548]: `TAG_MANDATORY_RELATIONS` empties.
**Every word may carry one** [T1562]: `TAGGABLE_RELATIONS` widens from the five
same-phase words to all eight, and the checker's own relation sets admit the
cross-phase words when they carry the lane's tag.

### D3 — several lanes per edge (SHIPPED, 35200d2)

`memory_edges.tags` stays a canonical JSON array; its meaning is "the set of
lanes this edge belongs to". Each tag validates independently.

### D4 — the `remember` verbs (SHIPPED, 2d14a3c)

`declare` / `undeclare`, the latter refusing while any edge still carries the
tag. Settlement's own facade must accept both, since settlement now owns
declaration.

### D5 — identity in the checker (SHIPPED, 35200d2)

`LaneKey` is `{segment, tag}`. The merge is explicit and accepted: an edge with
two tags acts on both lanes, so `T2 --indexes{a}--> T1` closing lane `a` and
then `T3 --override{a,c}--> T1` reopens `a`. Election and self-ground fixtures
were re-baselined, with the two constructed cases recorded (a seat falling tier
2 → 5; a self-grounds write now rejected).

### D6 — migration (SHIPPED, 2d14a3c + 16db8c2)

M0 classify (read-only, three buckets — placeable, notPlaceable, and REJECTED
for tags no normalization can read, so nothing vanishes from the receipt the
later phases consume), M1 create, M2 seed from the placeable set, M3 stamp
curated tags onto members by an explicit reviewed allowlist — today only
`(60, ["claude-mnemo"])`, stamping 1085 members — and M4 dispose of unplaceable
edges by DOWNGRADING every one of them to untagged, merging into any
pre-existing untagged row for the same (pair, relation) rather than colliding
with the unique key. Every phase gates on its OWN durable receipt row, never on
the `lanes` table existing.

The relation-class branch is gone [T1566]: M4 used to DELETE `extends`/`narrows`
because the mandate made an untagged continuation edge illegal in itself, so
stripping the tag repaired nothing. D2 withdraws that mandate, so all eight
words have a legal untagged form and stripping is a repair for every one.
The receipt has one bucket, `downgraded`, each entry `downgraded` (cleared in
place) or `merged` (absorbed into the pre-existing row). **This binds the
release order**: run M4 while the old checker is live and every downgraded
continuation edge becomes a fresh E1 violation the instant it lands, so ticket
04 ships WITH ticket 02 or not at all. Verified read-only that no production
database has run M4 yet (`lanes` and `migration_receipts` both absent), so
nothing needs recovery.

### D7 — the segment card's lane list (SHIPPED, 9fd989e)

`tag ◎<addr>` for a declared terminus, bare `tag <addr>` for the newest node
where the missing ◎ says "undeclared", `→<addr>` only when the terminus has been
overtaken. Newest-lane-first, whole entries dropped against the card's budget
with a `+N 条` tail — 63 lanes render ~1449 injector-tokens, so the cap is
load-bearing. Addresses follow D10.

### D8 — the timeline lane view (SHIPPED, 20f7d50)

`timeline(id="E60/L*", view="lane")`; `view: "lane"` on a bare `E<n>` routes the
same way rather than silently falling back. Header: `[L<n>]`, the lane's NEWEST
node's time, the modal type emoji (ties by the rubric's own type order), the
tag; the chain ends in `(N)`, the member count. Path selection is a dynamic
program over reachable coverage — greedy showed a two-hop branch while hiding a
five-node body — with the relation preference only breaking ties between paths
of EQUAL coverage. The chain starts at the newest node and every arrow points at
an older turn.

### D9 — attribution warnings (ticket 09, NOT YET BUILT)

- **Unattributed cluster**: 4+ turns carrying no lane tag and connected to each
  other by untagged edges. The domain is that cluster, NOT the graph component:
  `LANE_COMPONENT_RELATIONS` includes `grounds`, so on a mature segment almost
  everything hangs off something tagged (one measured component holds 77 turns).
  A cluster is EXCUSED when some node aggregates two or more of its members with
  an untagged `indexes` — the free aggregation a release writes over what it
  ships — because otherwise every legal batch warns forever.
- **Proliferation**: lanes > 0.05 × member turns. The constant stays 0.05 even
  though E60 sits under it at 63/1637 = 0.038: the ruling is explicit that E60
  is not yet fully settled, so the line is drawn for the steady state.

### D10 — one address grammar (ticket 10; 10b SHIPPED as fc5047c)

`S<session>/T<prompt>` everywhere. Selectors take `E<n>/S<a>/T<b>` and
`E<n>/S<a>/T<b>..S<c>/T<d>`, the range running over the segment's own event
order between the endpoints, sessions inside the span included; `E<n>/T*`
survives, the ordinal `E<n>/T<m>` refuses rather than silently reinterpreting.
Inside one row the full address prints for the first turn and again on any
session change; the rest render bare `T<prompt>`. The console follows and its
address-space switch is gone with the second grammar it existed to switch
between.

### D11 — membership discrimination [T1552 → T1560]

A delivery turn joins a design lane when it serves that lane. Serving SEVERAL,
the shared edge carries all of their tags — the confluence — rather than the
turn being assigned to one arbitrarily or a throwaway campaign lane being minted
for it. A release additionally sits on a standing `release` lane (permanently
open by construction, which is honest: shipping never converges) and declares
each landing lane's convergence with a tagged `indexes` naming THAT lane's core
nodes, not one blanket declaration.

### D12 — what does NOT change

Settlement's window/retry machinery, scoring inputs beyond the re-baselined lane
state, the note tool's own fields, and the CONTENT of the 63 existing E60 lanes.
Merging `memory-policy`/`note-field-semantics`/`rubric-v5-design` into one lane
is a separate campaign the user deferred; this batch only makes the duplicates
visible.

## Testing decisions

Assert externally visible refusals and renderings, never internal calls. Per
surface: the `remember` boundary (declare/undeclare, canonical forms, both
vocabulary collisions); the edge write path (one test per D2 refusal, including
a cross-segment pair declared on only one side, and a tagged CROSS-PHASE edge
now accepted); membership write paths (a move that would strand an incident edge
refuses, leaving nothing behind); the migration over a fixture mirroring the live
shapes, asserting receipt ROWS and a second run being a no-op; the checker's
merge figure; the card and lane view renders; the two warnings at their exact
boundaries; and the selector grammar including a cross-session range and the
retired form's refusal.

Mutation-verify every load-bearing property before commit — six tickets so far
have each had at least one declared property that turned out pinned by nothing,
including a whole set of tag-index assertions that were passing over an index no
fixture had ever populated.

## Out of scope

Merging the existing lanes; settlement or scoring changes beyond re-baselining;
retagging E53/E58/E59 by hand (reported by M3, not performed).
