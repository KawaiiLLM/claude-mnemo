# RB — Grant semantics: delivery-atomic grants, completeness sequencing, a relations gate

**What to build:** peer findings P1-6, P1-7, P1-8, P2-1, P2-2, P2-3, P2-6
from `.scratch/tag-mandate/repairs/peer-round.md` (the authoritative spec —
read it first), plus the readerId envelope fold-back (a
`resolveReaderId?: () => string | null` option on
`createDatabaseBackedHandlers`, deleting the duplicated worker envelope in
the settlement recall registration — both sites carry comments naming this
fold).

Core principles the fixes share:
- A grant/completeness record derives from the FINAL delivery envelope —
  only entities and complete fields the delivered bytes contain (P1-6);
  empty/error pages grant nothing, session detail grants the session only,
  observation pages grant only what they deliver (P2-2).
- Completeness is sequenced, not boolean-forever: overwriting a field
  another writer touched requires completeness recorded at-or-after that
  field's write sequence (P1-7); relations become a first-class gated
  surface with their own revision stamp — every attach/retract stamps, and
  relation mutations require the claim to have read the current relation
  set (P1-8). Non-empty type/tags whole writes require a complete metadata
  read (P2-1).
- Turn-targeted mutations re-check liveness inside the mutation
  transaction via one shared predicate (P2-3); the malformed-mode
  rejection derives its address label from the raw turn before mode
  parsing so loop escalation can fire (P2-6).

**Blocked by:** None — can start immediately (RA runs in parallel on
disjoint files).

**Status:** done (mutation-verified: envelope comparison disabled → 2 red; completeness-sequence check disabled → 2 red; note-side relations gate dropped → 5 red; two out-of-territory touches ratified as direct consequences of the relations gate; P2-3 dormancy side effect accepted — prose note stays the only exit)

- [ ] P1-6: a fixture whose serialized page exceeds the worker envelope
      truncation shows NO grant/completeness for undelivered entities;
      delivered ones keep theirs
- [ ] P1-7: read-complete → other-writer writes → unrelated-field re-read
      → whole-field write REFUSES; re-reading the field itself unlocks
- [ ] P1-8: relation attach without a relations read refuses; after a
      relations recall it lands; another writer's edge write staleness is
      caught by the revision stamp
- [ ] P2-1/P2-2/P2-3/P2-6 each pinned per the ledger's fix lines
- [ ] Territory: src/db/write-gate.ts, src/mcp/recall.ts,
      src/mcp/handlers.ts, src/mcp/note.ts, src/worker/note-settlement-
      turn-facade.ts, src/worker/note-settlement-membership-facade.ts,
      the settlement recall registration in
      src/worker/note-settlement-sdk-query.ts, their tests. NOT
      lane-checker* (RA owns), NOT definitions.ts/citations.ts/prompt.ts
      (RC owns next)
- [ ] Load-bearing properties declared for mutation acceptance
