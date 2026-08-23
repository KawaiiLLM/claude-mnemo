---
name: mnemo-timeline
description: Render the temporal/decision shape of a past session - phases, gaps, tool bursts, compact boundary, broken-prompt candidates. Use when the user asks how a session unfolded, what the decision arc was, where a decision happened, or when reconstructing a session after compacting.
---

# Mnemo Timeline

Timeline is the temporal axis of the three-axis read model. It answers "how did this session unfold" (or "how did this task unfold across sessions") by rendering turn rows or a milestone digest, plus window-scoped shape signals.

Three axes of read access:

- `recall` - content axis: structured semantic index
- `timeline` - temporal axis: decision arc, turns, milestones, gaps, bursts
- `mnemo-replay` - raw axis: direct SQLite + JSONL access

`remember` is the single write path. Use `timeline` for shape, `recall` for content, and `mnemo-replay` for a turn's full text and tool I/O from the database (raw JSONL only for exact bytes).

## When to use

Use timeline when:

- Reconstructing a session after compacting
- Asking how a session unfolded or where the decision arc changed
- Finding where a decision was made
- Reviewing a past spec-review / RFC / design session by id (e.g. "locked decisions in S42") — timeline renders the decision arc directly
- Debugging an in-progress session with pending turns
- Inspecting gaps, tool bursts, broken-prompt candidates, or compact boundaries
- Tracing one task's arc across every session it touched — use a segment id (`E<n>`), not a session id

## Input

```text
timeline(id="S42")
timeline(id="S42", page=2, pageSize=50)
timeline(id="S42/T10..100", pageSize=20)
timeline(id="S42", view="milestones")      # key chronological digest
timeline(id="E47")                         # one segment's member turns, across every session
timeline(id="E47", view="milestones")      # the same segment, milestone-selected
```

| Field | Required | Purpose |
|---|---|---|
| `id` | yes | Session or segment selector, with optional range (see below) |
| `view` | no | `turns` (default) or `milestones` |
| `filter` | no | The same structured grammar `recall` uses — `{type, tag, session, time, file}` — AND-composed with the `id` selector's range to narrow which turns the current view considers |
| `page` | no | 1-indexed page number. Default `1`. |
| `pageSize` | no | Items per page for the selected view. Default `30`. For the `milestones` view this is also the admission cap — how many turns the selection keeps, not a page slice of something larger — but never more than 30: both the session and segment routes clamp the election's own budget to `min(pageSize, 30)`, so a caller-supplied `pageSize` above 30 raises pagination, never admission. |
| `pageBudget` | no | Token ceiling for the `turns` view's page. Plays no role in `milestones` admission — that is `pageSize`'s job. |

`id` selects the candidate turns; `view` selects the body; `filter`/`page`/`pageSize` control which of those candidates render. The layers are orthogonal — `id="S42/T1..100"` with `pageSize=30` keeps all 100 turns as candidates and renders page 1 of the default `turns` view.

Views:

- `turns` - every candidate turn, time-ordered, in the same row form `recall` renders, plus a `metadata` line per row.
- `milestones` - key-turn digest, elected through a lane-first structural rule, not a score. A rolled-back or skipped turn, or any node carrying an `override`/`refutes` in-edge in any tag state, never competes. Surviving candidates rank by five identity tiers, highest wins: releases (untagged-`indexes` writers) > closed-valid lane termini and open lanes' last declarer > nodes an elected tier-1/2 row indexes > correctors (override writers, citers of a reversed turn) > everything else. Within a tier, in-degree (`narrows`/`extends`/`consume`/`indexes`/`grounds`/`verifies`, self-edges included) breaks ties, then out-degree, then the later turn. `pageSize` bounds the election itself, so admission is single-page by construction. A session or segment with no edges at all degrades safely to a flat, recency-ordered list — every candidate lands in the same tier at zero degree, so only recency discriminates.

### Range syntax

| Form | Candidates |
|---|---|
| `S42` | All turns in the session |
| `S42/T*` | Same as `S42` |
| `S42/T10..30` (or `T10..T30`) | Closed range `T10-T30` |
| `S42/T..20` | Open-start range `T1-T20` |
| `S42/T30..` | Open-end range starting at `T30` |
| `E47` | All of the segment's member turns, in cross-session chronological order |
| `E47/T...` (any trailing selector) | Same as `E47` — a segment id ignores anything after it; there is no sub-range grammar on a segment yet |

Range produces the full candidate set with no truncation; `pageSize` then slices (`turns` view) or admits (`milestones` view) from it.

A segment view (`id="E<n>"`) draws its candidates from every session the segment's members occurred in, not one session — this is the one place `timeline` crosses session boundaries. It groups its rows under one `[S<n>]` transition line per session run (there is no single local turn numbering across sessions), and pagination works the same way the session view's does.

`timeline(id="S42/T10")` is an error. Use `recall(id="S42/T10")` for single-turn detail.

## Output structure

### Session header

The header includes:

- Session id, local-time range, and duration
- Session stats and type counts
- `showing:` line in `page X / Y (total Z)` form — rendered only when the candidate set exceeds `pageSize`
- Explicit timezone line with abbreviation and UTC offset
- `raw:` line with the absolute JSONL path for `mnemo-replay`

### Turn rows

There is no table. A turn renders as the same three rungs `recall` uses — the
bracketed address, an unprefixed `metadata` line, then its field rows:

```markdown
    [S15069] the session's title
        [T823] the turn's title
            08-17 18:19 · +6m · 🔧20 ✏️3
            - prompt: the cleaned raw user prompt, capped at 100 chars
```

The `metadata` line carries what the retired table spent columns on: local
date and time, the gap from the previous turn, and tool/file counts.

Markers:

- `⨯` before the address for undone turns; the title renders struck through
- `⏳` in place of a title when the turn is not extracted yet
- `※` after the gap on the `metadata` line for broken-prompt candidates
- `[ext:<name>]` prefix on the `- prompt:` line for external-source turns
- `[rewind]` tail marker on a rolled-back turn — its transcript pointer is
  stale; never hand that turn's coordinate to `mnemo-replay`

### Milestone rows

```markdown
[E31] the arc's title
    [S15069]
        [T821] 08-17 18:19 ⚖️ the turn's title
            ↳ T811, T812
```

A milestone row states its stamp inline (that is what tells it apart from a
turn row) and carries a type glyph. `↳` lists that row's antecedent
ADDRESSES and nothing else, restricted to citations that are THEMSELVES
elected — an unelected citation never appears on a `↳` line, and the
budget cost of the line is charged to the citing row. An elected
antecedent can render both under a citing row's `↳` and as its own
milestone row elsewhere on the page — the list is non-exclusive, there is
no re-homing. Addresses render as a bare `T<m>` inside the same session, a
session-qualified `S<n>/T<m>` when the antecedent lives elsewhere, and a
trailing `+N` when there are more than four. `⚑` marks a row that is itself a
corrector. No importance value renders on any row.

### Shape signals

Shape signals are computed over the returned window only and include:

- Fastest and longest gaps
- Tool bursts
- Broken-prompt candidates
- Undone turns
- External inputs
- Compact boundary

## Workflow examples

```text
recall()
timeline(id="S42")
recall(id="S42/T19")
# Raw: use mnemo-replay on the path from the timeline header
```

```text
recall(id="E47")                    # find the segment
timeline(id="E47", view="milestones")   # its cross-session decision arc
```

## Design notes

- Timeline reads only SQLite
- Timeline is main-agent only
- Cross-session temporal shape is available only through a segment selector (`id="E<n>"`); a bare session id (`S<n>`) stays single-session
- Local-timezone rendering uses `Intl.DateTimeFormat`
- Default `pageSize` is 30; override with the `pageSize` arg for longer views
