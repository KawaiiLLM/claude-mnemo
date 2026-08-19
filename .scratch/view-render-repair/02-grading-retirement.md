# 02 — Milestone grading retires whole: no display, no machinery, no debt

**What to build:** the G0–G4 task-causality grading leaves the system as ruled
at [S15069/T1035] ("里程碑分级都是旧时代的产物了,不要留历史债") — not merely
hidden from rendering (ticket 01 strips the display) but the machinery itself:
milestone election runs on edge-signal lexicographic keys alone, settlement
stops grading, and nothing downstream reads a grade.

**Blocked by:** 01 (display strip lands first so this ticket is pure
machinery), and a SCOPING pass before final cut — the blast radius below is
from memory, unverified against HEAD.

**Status:** scoped (2026-08-20, verified at HEAD) — start AFTER ticket 01
lands (timeline.ts is the worker's active territory).

## Verified blast radius

- **Settlement write path**: the 0.12 prompt no longer INSTRUCTS grading
  (note-settlement-prompt.ts:23 — post-reload jobs 60-62 show
  gradeHistogram all zeroes) but the turn facade still ACCEPTS grade and
  documents "grade always lands" (note-settlement-turn-facade.ts:51-63,
  contradicting the prompt comment), and the histogram plumbing is alive
  (note-settlement-staging.ts:164-192, direct-write mirror). Remove:
  facade grade acceptance, histogram fields/log lines, the stale comments.
- **Selection — the core check**: timeline.ts carries 42 live
  `effGrade`/`significance` references. The ruled lexicographic keys
  (overridden-exclusion → encodes desc → refines bucket → recency) may be
  implemented WITH effGrade still inside — if so, "election runs on edge
  signals alone" was never true and this ticket makes it true; the
  scrambled-grades fixture test is the proof.
- **Schema**: `significance_grade` CHECK in 4 sites (schema.ts:218, 2811,
  3204, 3415 — live table + rebuild templates). `supersedes` precedent:
  frozen-readable, no live writer; no physical drop.
- **Standalone modules**: task-causality-era.ts / task-causality-rubric.ts
  (rubric had zero consumers at the ticket-06 audit) — deletion candidates;
  plus record plumbing in db/turns.ts, db/segments.ts,
  hooks/capture-repair.ts (field pass-through, mechanical).
- **Docs**: ADR-0003 (already superseded-annotated for election) gains the
  grading half; anchoring-eval 判据 wording mentions "现三键" — confirm no
  grade dependency (channels test selection keys, not grades).

## Acceptance (draft — final after scoping)

- [ ] Settlement runs grade nothing; commit metrics carry no histogram.
- [ ] Election provably grade-free (test: grades scrambled in a fixture,
      selection unchanged).
- [ ] Stored grade columns frozen-readable, never written by any live path.
- [ ] Full suite green modulo the standing stale-bundle guard.
