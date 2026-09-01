# ADR-0002 — One writer per layer: note, remember, settlement

**Status:** accepted · 2026-08-17 · source: S15069 T814–T823 · verbs and cadence amended
2026-08-20

> **Amendment 1 — the verb column (write-mode-edit-semantics, ticket 05).** `remember`'s
> surface reads `create` / `attach` / **`write`** / **`edit`** / `close` / `assign`. `edit`
> is `replace` renamed; `write` replaces `append` and is strictly more (whole-field
> replacement — an added row is now an `edit` anchored on the last row). See
> [ADR-0001](0001-segment-as-semantic-container.md)'s own amendment and
> [ADR-0008](0008-read-write-contract.md) for what admits a `write`.
>
> **Amendment 2 — the cadence clause shrank to one receipt.** The "too frequent" half
> retired: a write under 10 turns draws no reminder, and the receipt is now a bare count of
> turns since this segment's last maintenance plus the standing 20-turn nudge. `decisions`'
> exemption goes with it — not overruled, but left without a premise: there is no
> write-again-too-soon reminder left for it to be exempt from. A lost ruling is still the
> costliest loss; nothing ever gated on cadence, so nothing about `decisions` changes in
> practice.
>
> **Amendment 3 — the writer table is per-layer PRIMARY writer, not sole writer
> (edge-mechanism-revision, [ADR-0009](0009-standalone-edges-and-rearmed-settlement.md)).**
> Settlement holds the main agent's whole write surface inside the window its prompt rendered:
> turn prose (title/content/insight) and type/tags as well as membership and edges. The row
> reading "Grades, edge reconciliation, membership" is doubly out of date — grading retired
> with ADR-0003, and the remaining duties are no longer a smaller field set than the main
> agent's. Read the table as *who writes a layer first, live*; who may CORRECT it in hindsight
> is one gate (ADR-0008), not one column. The membership bullet below narrows the same way:
> settlement may now `create` a segment (auto-attached to the settling session, so the next
> window sees it on the roster) and reassign a turn to any open segment, on this session's
> roster or not — the "only among the session's attached segments" limit is revoked, while the
> proposal verb and its ask-the-user discipline stand for the cases where nothing fits.
>
> **Amendment 4 — the impression is the one field class settlement writes ALONE
> (lane-impressions, spec Rev 8, 2026-09-01).** Amendment 3 read the table as *primary*
> writer, with correction rights settled by one gate. The **Impression** (CONTEXT.md) is the
> exception that stays a SOLE-writer row: settlement writes it at its terminal commit, under a
> CAS fence, and the main agent has no verb that reaches it at either tier. That is not a
> narrower ownership rule bolted on — it is what made the retirement affordable. `done`,
> `decisions` and `next_steps` left `remember` entirely, and `content` left the main agent's
> write vocabulary with them, because their maintenance burden was the reason to move the
> narrative to a writer that already reads the whole window. Consequences for this ADR's own
> text: the "Segment fields (semantic) | main agent" row now means `goal` / `constraints` /
> `reference` / `insight`; and Amendment 2's note about `decisions` sitting outside the cadence
> is moot a second time — the field is gone. The cadence receipt itself is unchanged.

## Context

Earlier drafts split segment fields between a main-agent append surface and
settlement-owned judgment fields, giving `content` two writers with two cadences.
Independently, the settlement subagent's segment creation produced the measured
granularity failure (ADR-0001): it sees one window, never the global lane structure.

## Decision

| Layer | Writer | Surface |
|---|---|---|
| Turn notes (episodic) | main agent | `note` tool |
| Segment fields (semantic) | main agent | **`remember`** tool — `create` / `attach` / `append` / `replace` |
| Grades, edge reconciliation, membership | settlement subagent | settlement pass |

- Maintenance cadence is **advisory, receipt-style** (the budget model, not a
  gate): every `remember` write reports turns-since-last-maintenance; writing
  again under 10 turns draws the reminder, and 20 turns without maintenance draws
  a single nudge. `decisions` appends sit outside the cadence entirely — a lost
  ruling is the costliest loss.
- Segment **creation and naming belong to the user/main agent with the segment
  roster in view** (read-before-write). Settlement only assigns membership among
  the session's attached segments; when nothing fits it emits a text **proposal**:
  turn addresses + a suggested title + a reminder to ask the user. No pseudo-
  segments, no adoption verbs: on approval `remember(create)` takes the proposal's
  addresses as seed members.
- Independence lives where value is ranked (election, settlement), not where state
  is maintained: working state belongs to whoever works.

## Consequences

- `remember` revives a retired tool name (old remember merged into note in 0.11.x);
  note = 记录 (episodic), remember = 记住 (semantic).
- Tags carry three loads with one vocabulary: facet aggregation (K5a, live in
  `segments.ts`), membership assignment, attachment discovery. Turn tags therefore
  carry at least one coarse tag (the project, e.g. `claude-mnemo`) then fine noun
  tags (`note-tool`, `segment-schema`); never activities — `type` owns those, so
  no `-design`/`-fix` hybrid tags.
