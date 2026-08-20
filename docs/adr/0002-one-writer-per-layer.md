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
