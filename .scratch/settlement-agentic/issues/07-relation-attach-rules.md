# 07 — A relation must be argued in the body that carries it

**What to build:** Saying "this overturns that" requires having said why in the prose. Settlement can improve a relation with hindsight but cannot invent the link.

**Blocked by:** 06

**Status:** ready-for-agent

Named fields, not a generic `{turn, relation}` list: with four values a named field makes an illegal relation unrepresentable. The four ordered questions and the counterfactual wording for `depends-on` are in spec C3-C4 and must reach the prompt verbatim.

- [ ] Relations are set through named fields, one per relation
- [ ] A relation naming a turn the body does not cite is rejected
- [ ] The same target under two relation fields is rejected
- [ ] The main agent may attach a relation to a pair its own write is creating
- [ ] Settlement may attach or correct a relation only on a pair present in its transaction's pre-state, and may not attach one to a pair the same call creates
- [ ] Settlement writing a body whose citations create bare pairs stays legal — it authors segment bodies, and a new segment has no citing node before it exists
- [ ] Full suite green

## Inherited: the exposure ledger is now write-only

A citation is legal iff its address resolves — one rule, both reference kinds, all three write paths (user ruling). The exposure gate `validateReferences` applied to turn references is removed, and `resolveExistingReferences` is gone with the asymmetry it existed to express.

Two reasons arrived together. The ledger records only the addresses the note machinery hands over (the owed turn, the backlog-relief block) and nothing a session actually read, so once ticket 06 made prose citations the only way to create an edge it silently dropped any citation of a turn found through recall or timeline — **320 of 709 turns exposed in this project's own session, 1202 of 11533 across the corpus**. And the user's, which is the durable one: **whether an agent saw something is not auditable.** Attention inside a large context is not observable, so a ledger of it approximates in both directions; existence is a fact storage answers exactly.

The anti-hallucination job now rests where it can be checked: the address grammar (ticket 01) refuses bare and annotated forms, so a guess has to be a fully qualified address that resolves.

**Consequence for this ticket to settle:** `getExposedTurnIds` had exactly one consumer, that gate. `note_id_exposures` is now written in two places and read in none — a table accumulating rows nobody asks about. Either retire it, or give it the reader it was documented to have (the note tool's `turn` parameter never consulted it). Dead settlement plumbing rides along: `exposedSegmentIds` still threads through context → dispatch → writeback with no destination, and ticket 10 deletes that layer regardless.
