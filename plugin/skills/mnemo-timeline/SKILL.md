---
name: mnemo-timeline
description: Render the temporal/decision shape of a past session - phases, gaps, tool bursts, compact boundary, broken-prompt candidates. Use when the user asks how a session unfolded, what the decision arc was, where a decision happened, or when reconstructing a session after compacting.
---

# Mnemo Timeline

Timeline is the temporal axis of the three-axis read model. It answers "how did this session unfold" (or "how did this task unfold across sessions") by rendering a turn table or a milestone digest, plus window-scoped shape signals.

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
| `pageSize` | no | Items per page for the selected view. Default `30`. For the `milestones` view this is also the admission cap — how many turns the selection keeps, not a page slice of something larger. |
| `pageBudget` | no | Token ceiling for the `turns` view's page. Plays no role in `milestones` admission — that is `pageSize`'s job. |

`id` selects the candidate turns; `view` selects the body; `filter`/`page`/`pageSize` control which of those candidates render. The layers are orthogonal — `id="S42/T1..100"` with `pageSize=30` keeps all 100 turns as candidates and renders page 1 of the default `turns` view.

Views:

- `turns` - full time-ordered turn table.
- `milestones` - key-turn digest. Selection is a fixed lexicographic order over edge signals, not a score: any turn with a live `override` edge against it is excluded outright, then turns rank by how many delivery-phase turns `encodes` them (descending), then by excess `refines` in-degree — decision-phase excess ranked before delivery-phase excess — then by recency; admission fills `pageSize` in that order. A session or segment with no edges at all degrades safely to a flat chronological list. Turns from before the segment-era cutoff never enter milestone rendering.

### Range syntax

| Form | Candidates |
|---|---|
| `S42` | All turns in the session |
| `S42/T*` | Same as `S42` |
| `S42/T10..30` | Closed range `T10-T30` |
| `S42/T..20` | Open-start range `T1-T20` |
| `S42/T30..` | Open-end range starting at `T30` |
| `E47` | All of the segment's member turns, in cross-session chronological order |
| `E47/T...` (any trailing selector) | Same as `E47` — a segment id ignores anything after it; there is no sub-range grammar on a segment yet |

Range produces the full candidate set with no truncation; `pageSize` then slices (`turns` view) or admits (`milestones` view) from it.

A segment view (`id="E<n>"`) draws its candidates from every session the segment's members occurred in, not one session — this is the one place `timeline` crosses session boundaries. Its turn table identifies each row by the member's own `S<n>/T<m>` address (there is no single local turn numbering across sessions), and pagination works the same way the session view's does.

`timeline(id="S42/T10")` is an error. Use `recall(id="S42/T10")` for single-turn detail.

## Output structure

### Session header

The header includes:

- Session id, local-time range, and duration
- Session stats and type counts
- `showing:` line in `page X / Y (total Z)` form — rendered only when the candidate set exceeds `pageSize`
- Explicit timezone line with abbreviation and UTC offset
- `raw:` line with the absolute JSONL path for `mnemo-replay`

### Turn table

The turn table has two content columns: `prompt` and `title`.

- `prompt` column: cleaned raw user prompt, capped at 100 chars
- `title` column: `<type_emoji> <Mnemosyne title>` when extracted, `⏳` when pending, strikethrough when undone

Markers:

- `⨯` prefix on `T#` for undone turns
- `※` in the gap column for broken-prompt candidates
- `[ext:<name>]` prefix in the prompt column for external-source turns
- `↩️` on a decision that reverses or supersedes an earlier decision
- `🚫` on an invalidated or rolled-back turn

A turn's own `⤺ rewound` state (shown by `recall`) means its transcript pointer is stale — do not hand a rewound turn's coordinate to `mnemo-replay`.

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
