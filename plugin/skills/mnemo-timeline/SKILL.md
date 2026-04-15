---
name: mnemo-timeline
description: Render the temporal/decision shape of a past session - phases, gaps, tool bursts, compact boundary, broken-prompt candidates. Use when the user asks how a session unfolded, what the decision arc was, where a decision happened, or when reconstructing a session after compacting.
---

# Mnemo Timeline

Timeline is the temporal axis of the three-axis read model. It answers "how did this session unfold" by rendering a time-ordered turn table, session-wide phase segmentation, and window-scoped shape signals.

Three axes of read access:

- `recall` - content axis: structured semantic index
- `timeline` - temporal axis: decision arc, phases, gaps, bursts
- `mnemo-replay` - raw axis: direct JSONL + SQLite access

`remember` is the single write path. Use `timeline` for shape, `recall` for content, and `mnemo-replay` only for exact bytes.

## When to use

Use timeline when:

- Reconstructing a session after compacting
- Asking how a session unfolded or where the decision arc changed
- Finding where a decision was made
- Reviewing a past spec-review / RFC / design session by id (e.g. "locked decisions in S42") — timeline renders the decision arc directly
- Debugging an in-progress session with pending turns
- Inspecting gaps, tool bursts, broken-prompt candidates, or compact boundaries

## Input

```text
timeline(id="S42")
timeline(id="S42", page=2, pageSize=50)
timeline(id="S42/T10..100", pageSize=20)
```

| Field | Required | Purpose |
|---|---|---|
| `id` | yes | Session selector with optional range (see below) |
| `page` | no | 1-indexed page number. Default `1`. |
| `pageSize` | no | Turns per page. Default `30`. |

`id` selects the candidate turns; `page`/`pageSize` controls rendering. The two layers are orthogonal — `id="S42/T1..100"` with `pageSize=30` keeps all 100 turns as candidates and renders page 1 (T1-T30) by default. Phases and session metadata remain session-wide regardless of page.

### Range syntax

| Form | Candidates |
|---|---|
| `S42` | All turns in the session |
| `S42/T*` | Same as `S42` |
| `S42/T10..30` | Closed range `T10-T30` |
| `S42/T..20` | Open-start range `T1-T20` |
| `S42/T30..` | Open-end range starting at `T30` |

Range produces the full candidate set with no truncation; `pageSize` then slices it for display.

`timeline(id="S42/T10")` is an error. Use `recall(id="S42/T10", depth="expanded")` for single-turn detail.

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

- `prompt` column: cleaned raw user prompt, capped at 200 chars
- `title` column: `<type_emoji> <Mnemosyne title>` when extracted, `⏳` when pending, strikethrough when undone

Markers:

- `⨯` prefix on `T#` for undone turns
- `※` in the gap column for broken-prompt candidates
- `[ext:<name>]` prefix in the prompt column for external-source turns

### Phases

Phases are run-length encoded by turn type across the whole session. Labels use the `turn.type` enum values. Pending turns form their own `pending` phase.

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
recall(id="S42/T19", depth="expanded")
# Raw: use mnemo-replay on the path from the timeline header
```

## Design notes

- Timeline reads only SQLite
- Timeline is main-agent only
- Cross-session timelines are out of scope for v1
- Local-timezone rendering uses `Intl.DateTimeFormat`
- Default `pageSize` is 30; override with the `pageSize` arg for longer views
