# 08 — Rubric v11: the exact-set clauses retire everywhere they are taught

**What to build:** every surface that teaches the lane model teaches the single-tag one. A stale teacher is worse than none: the cached copy keeps producing calls the gate now rejects.

**Blocked by:** 03.

**Status:** ready-for-agent

Spec: `.scratch/lane-declaration/spec.md` (Rev 2) — D5's three retirements, plus the declaration rule itself.

- [ ] The rubric's lane sections are REPLACED by the text the user authored in [S15069/T1562] — reproduce its wording, do not paraphrase it. It carries: the lane definition (separable, long-running, CONTINUABLE work, `#release`/`#rubric-design` and not `#ticket-06-implement`/`#rubric-v5-design`); 复合节点 (a turn may hold several types and phases, and an edge is legal when ANY pairing is); closed/open lane by whether the NEWEST node is an `indexes` terminus; 汇聚 lane (a node may belong to several lanes, and several lanes may share ONE edge, which then carries every one of their tags); the eight words, ALL of which may now carry a tag; and the three non-binding principles — 有效性 (a turn with no useful output should be skipped, and skipped/rewound turns join no edge), 连通性, 最小连通.
- [ ] What that text retires, stated so a reader of the diff can see it: lane identity as an EXACT SET, BRANCH by proper superset, REOPEN by inheriting a closed lane's set, the phase-local lane (a lane spans phases now), and the mandate that continuation words must carry a tag.
- [ ] The rubric also states the declaration rules from this batch: a lane is one DECLARED tag under a segment, and a tagged edge needs that declaration in every endpoint's segment — a cross-segment edge on both sides.
- [ ] Membership discriminator [S15069/T1552], stated once: a delivery turn joins a design lane when it serves that lane; serving several, it carries all of their tags on the shared edge — the confluence — rather than being smeared into one of them arbitrarily.
- [ ] The rubric stays inside `MAX_INJECTED_BLOCK_CHARS` (9500) — report the resulting size.
- [ ] Every enumerated teaching surface is updated in the same ticket: the `note` tool description, the settlement note/remember descriptions, the settlement prompt's own Block B edge contract, and the plugin skills docs. The existing teaching-surface sweep test must pass with the new wording pinned.
- [ ] The rubric hash changes and the injection test that pins it is updated.

**File ownership:** the rubric source, `src/mcp/definitions.ts` (tool descriptions), `src/worker/note-settlement-prompt.ts`, `plugin/skills/**`, and their tests. Do NOT touch checker code — that is ticket 03.
