# ADR-0001 — The segment is a per-topic, long-lived semantic container

**Status:** accepted · 2026-08-17 · source: S15069 T736–T823

## Context

The session was the unit of semantic memory (summary, decisions, next steps), but a
session is an arbitrary slice of one or more tasks: S15069 spans 28 days and a dozen
tasks, and its summary necessarily mushes them together. Meanwhile spec section K
defined the segment as one G4-bounded arc (~50 turns); production showed 37 of 47
segments under 20 turns beside one 179-turn giant — a windowed writer cannot cut
global lanes. Three re-derivation failures in one session (T628, T788, T337) all
traced to the passive channel being keyed by session instead of task.

## Decision

- A **segment** is the semantic-memory container for one task lane, keyed by topic,
  accumulating across sessions and arcs. The G4-bounded arc demotes to an episode
  *inside* a container; partition no longer keys on grades.
- The **session exits the semantic layer**: it remains the episodic container
  (turns, transcript, timeline) plus a record of which segments it worked with.
  Every session-level semantic field moves to the segment.
- Segment fields, two layers by reader:
  - **Summary layer** (outsiders browsing): `title`, `content` (whole-task summary),
    `insight` (task-global distilled experience — lessons that outlive the work but
    still belong to this task; cross-project generalities remain dream/Rule-Digest
    harvest, not segment fields).
  - **Working State** (the resuming worker): `goal`, `constraints` (task-scoped
    operating rules only — global preferences stay in persona/CLAUDE.md),
    `decisions` (in-force rulings, each with its [S/T] source), `done` (recent,
    verification-stated; older rows fold into content), `next_steps` (frontier;
    promotes into done on landing), `reference` (pointers that still resolve in a
    month).
- All fields are markdown row lists, edited by `append` and `replace(old,new)`;
  the overwrite/append mode vocabulary retires. Replace forces read-before-write
  and silence structurally cannot overwrite a statement.
- Admission test for Working State rows: knowledge this task's future work will
  reuse. Turns may remain **homeless** (no segment) — noise is legal.

## Consequences

- The per-session summary agent (the system's largest cost sink) demotes or retires;
  CC-compact-style regeneration is replaced by incremental maintenance over a
  surviving episodic layer: addresses, not copies.
- `segments` gains the six Working State columns; a session↔segment binding store
  is new build (none exists today); status vocabulary for containers to be ruled.
- T737's objection to copying Pi's Goal/Progress/Next-Steps list is superseded —
  it presumed the session summary carried continuation.
