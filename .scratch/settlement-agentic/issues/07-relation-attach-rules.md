# 07 — A relation must be argued in the body that carries it

**What to build:** Saying "this overturns that" requires having said why in the prose. Settlement can improve a relation with hindsight but cannot invent the link.

**Blocked by:** 06

**Status:** ready-for-agent

Named fields, not a generic `{turn, relation}` list: with four values a named field makes an illegal relation unrepresentable. The four ordered questions and the counterfactual wording for `depends-on` are in spec C3-C4 and must reach the prompt verbatim.

- [x] Relations are set through named fields, one per relation
- [x] A relation naming a turn the body does not cite is rejected
- [x] The same target under two relation fields is rejected
- [x] The main agent may attach a relation to a pair its own write is creating
- [x] Settlement may attach or correct a relation only on a pair present in its transaction's pre-state, and may not attach one to a pair the same call creates
- [x] Settlement writing a body whose citations create bare pairs stays legal — it authors segment bodies, and a new segment has no citing node before it exists
- [x] Full suite green

## Inherited: the exposure ledger is now write-only

A citation is legal iff its address resolves — one rule, both reference kinds, all three write paths (user ruling). The exposure gate `validateReferences` applied to turn references is removed, and `resolveExistingReferences` is gone with the asymmetry it existed to express.

Two reasons arrived together. The ledger records only the addresses the note machinery hands over (the owed turn, the backlog-relief block) and nothing a session actually read, so once ticket 06 made prose citations the only way to create an edge it silently dropped any citation of a turn found through recall or timeline — **320 of 709 turns exposed in this project's own session, 1202 of 11533 across the corpus**. And the user's, which is the durable one: **whether an agent saw something is not auditable.** Attention inside a large context is not observable, so a ledger of it approximates in both directions; existence is a fact storage answers exactly.

The anti-hallucination job now rests where it can be checked: the address grammar (ticket 01) refuses bare and annotated forms, so a guess has to be a fully qualified address that resolves.

**Settled (da75375), and the first answer here was wrong.** `getExposedTurnIds` had exactly one consumer, that gate, so this ticket originally recorded the table as "written in two places and read in none". It was read — P1 metric (a) queries `note_id_exposures` directly in SQL, to separate `defaulted` (shown, not written) from `unreached` (aged out unrendered, because the per-debt reminder only displayed the five oldest). Checking the accessor's callers could not see that reader, and the claim was made anyway.

What retired the ledger was the other fact: 裁决 25 replaced the reminder with a current-turn address injected every turn, so measured exposure since 2026-08-11 runs 99-100% and `unreached` is an empty category by design. The two writers and the accessor are gone; the accumulated rows stay as the only evidence separating the two outcomes over the corpus the ledger covered, and the metric now reads the ledger's own last row as a freeze — after it, a missing row means nothing rather than "never shown".

Dead settlement plumbing still rides along: `exposedSegmentIds` threads through context → dispatch → writeback with no destination, and ticket 10 deletes that layer regardless.

## Closed

`evidenceFor` / `evidenceAgainst` / `supersedes` / `dependsOn` on the note
tool; eligibility is a parameter of the shared edge-write layer
(`writeMemoryEdges`'s `eligibleForRelation`), so ticket 10's tool path
inherits the rule when it deletes the write-back's role. 07a0edd, 1754 pass.

`depends-on` does NOT reverse the stored columns. C1's "cited → citing"
diagram describes trust flow, not column layout; the pair's identity is fixed
by C6 (citing = whoever's body names the target) regardless of relation.
Confirmed against `segment-rank.test.ts`'s existing helper and the settlement
prompt's own worked example before it was implemented, and pinned by a test.

An existing test would have silently gone wrong under the new rule: the
write-back's "lands segments, members, edges…" case asserted a `depends-on`
edge on a pair with no pre-existing state, legal only because settlement had
no eligibility gate. Seeding that pair is what keeps the test meaningful.

### Open 1: the four fields ship functional but undocumented

The note tool's description is at **487 of its 500-token cap** (a user decree,
S15069/T586). C4 makes the four ordered questions and question 3's
counterfactual wording normative — not paraphrasable, because the predecessor
vocabulary measured 61% precision at exactly that softening. Neither the
procedure nor the bare field names fit 13 tokens. The procedure reaches the
settlement prompt, which has no cap; the main agent sees four fields in the
zod shape with no stated decision procedure. Which of the cap or C4 gives is
the user's call.

### Closed by review (cde7cf3): `eligibleForRelation` now denies by default

Shipped opt-in, on the argument that a default-deny would break the
schema-migration collapse and the edge suite's own upsert tests, and that C14
puts eligibility in each write path. A cross-session review named the
consequence: a later caller writing `relation: "supersedes"` and forgetting
the option mints the unqualified relation-only edge C7 forbids, and nothing
fails. Safety cannot rest on every future caller remembering a parameter.

Omitting it now denies every relation; an exempt path passes `"unrestricted"`
and says so. Forty test call sites state their stance. No production caller
changed — the two gated ones already passed real sets, the two bare-pair ones
write no relations.
