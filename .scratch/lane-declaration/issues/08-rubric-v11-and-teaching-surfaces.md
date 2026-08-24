# 08 — Rubric v11: the exact-set clauses retire everywhere they are taught

**What to build:** every surface that teaches the lane model teaches the single-tag one. A stale teacher is worse than none: the cached copy keeps producing calls the gate now rejects.

**Blocked by:** 03.

**Status:** ready-for-agent

Spec: `.scratch/lane-declaration/spec.md` (Rev 2) — D5's three retirements, plus the declaration rule itself.

- [ ] The rubric retires: lane identity as an EXACT SET, BRANCH as a proper superset, REOPEN by inheriting a closed lane's exact set. Branching is a different lane related by narration; reopening stays a tagged `override`.
- [ ] The rubric states the new rules: a lane is one declared tag under a segment; a tagged edge needs that declaration in every endpoint's segment; a cross-segment edge needs it on both sides.
- [ ] The rubric stays inside `MAX_INJECTED_BLOCK_CHARS` (9500) — report the resulting size.
- [ ] Every enumerated teaching surface is updated in the same ticket: the `note` tool description, the settlement note/remember descriptions, the settlement prompt's own Block B edge contract, and the plugin skills docs. The existing teaching-surface sweep test must pass with the new wording pinned.
- [ ] The rubric hash changes and the injection test that pins it is updated.

**File ownership:** the rubric source, `src/mcp/definitions.ts` (tool descriptions), `src/worker/note-settlement-prompt.ts`, `plugin/skills/**`, and their tests. Do NOT touch checker code — that is ticket 03.
