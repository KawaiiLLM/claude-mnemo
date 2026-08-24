# 08 — Rubric v11: the exact-set clauses retire everywhere they are taught

**What to build:** every surface that teaches the lane model teaches the single-tag one. A stale teacher is worse than none: the cached copy keeps producing calls the gate now rejects.

**Blocked by:** 03.

**Status:** done — the tool descriptions half was handed to ticket 02 (see ownership note)

Spec: `.scratch/lane-declaration/spec.md` (Rev 2) — D5's three retirements, plus the declaration rule itself.

- [ ] The rubric's lane sections are REPLACED by the text the user authored in [S15069/T1562] — reproduce its wording, do not paraphrase it. It carries: the lane definition (separable, long-running, CONTINUABLE work, `#release`/`#rubric-design` and not `#ticket-06-implement`/`#rubric-v5-design`); 复合节点 (a turn may hold several types and phases, and an edge is legal when ANY pairing is); closed/open lane by whether the NEWEST node is an `indexes` terminus; 汇聚 lane (a node may belong to several lanes, and several lanes may share ONE edge, which then carries every one of their tags); the eight words, ALL of which may now carry a tag; and the three non-binding principles — 有效性 (a turn with no useful output should be skipped, and skipped/rewound turns join no edge), 连通性, 最小连通.
- [ ] What that text retires, stated so a reader of the diff can see it: lane identity as an EXACT SET, BRANCH by proper superset, REOPEN by inheriting a closed lane's set, the phase-local lane (a lane spans phases now), and the mandate that continuation words must carry a tag.
- [ ] The rubric also states the declaration rules from this batch: a lane is one DECLARED tag under a segment, and a tagged edge needs that declaration in every endpoint's segment — a cross-segment edge on both sides.
- [ ] Membership discriminator [S15069/T1552], stated once: a delivery turn joins a design lane when it serves that lane; serving several, it carries all of their tags on the shared edge — the confluence — rather than being smeared into one of them arbitrarily.
- [x] The rubric stays inside `MAX_INJECTED_BLOCK_CHARS` (9500). **Rendered block 9461 → 6822 chars**, 2678 under the cap: v11 says more in less.
- [x] Every teaching surface IN THIS TICKET'S NARROWED SCOPE is updated: the rubric, the settlement prompt's Block B edge contract, and the plugin skills docs (which needed no edit — their only lane-adjacent copy describes shipped election tiering, not retired identity mechanics). The tool descriptions in `src/mcp/definitions.ts` were handed to **ticket 02**, which owns the write contract they describe, so one agent writes both the gate and its teaching.
- [x] The rubric hash changes and the pinning tests are updated. v10 `fc3aec8acf9c` → v11 `b7cb4c5ccd3b`.

**File ownership:** the rubric source, `src/worker/note-settlement-prompt.ts`, `plugin/skills/**`, and their tests. NOT `src/mcp/definitions.ts` (ticket 02), NOT checker code (ticket 03).

## Findings from acceptance

- **The hash "guard" was never a guard.** `MEMORY_RUBRIC_HASH` is computed at module load from `MEMORY_RUBRIC_TEXT`, and its self-consistency test recomputes the same function over the same input — it cannot fail. The hash's real job is runtime identification (an injected block declares which text a session was given). The doc comment claiming an "independent recomputation" is corrected; the actual drift guards are the content tests, which do fire: perturbing seven characters of the v11 text reddens the verbatim assertion, and reintroducing a retired v10 idea reddens the five-retirements assertion.
- **Left for ticket 02** (found by ticket 08, outside its boundary): settlement's own `remember` facade — `note-settlement-membership-facade.ts`, enum `["propose", "reassign", "create"]` — does not accept `declare`/`undeclare` at all, while Block B's FORM LANES step now tells settlement to declare a fresh tag. That call is a hard Zod rejection today. Spec D4 was marked SHIPPED on the main agent's half alone.
- **Two v10 sentences dropped with no v11 counterpart, needing the user's confirmation**: the untagged-override-kills / tagged-override's-victim-stays-live pair (arguably subsumed by v11's 核心节点 definition) and the ADOPTED-evidence sentence ("the strongest evidence is an EXTERNAL delivery citation of its terminus, never a self-citation"), which v11 does not restate anywhere.
- **Unpinned**: the claim that `plugin/skills/**` carries none of the five retired ideas rests on a one-time grep, not a standing assertion. Add it to the teaching-surface sweep after ticket 02 lands (that file is ticket 02's to edit right now).
