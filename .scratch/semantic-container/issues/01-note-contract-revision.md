# 01 — Note contract revision

**What to build:** The note tool's contract, restated at the level each rule governs. Field contracts move into per-parameter descriptions (title: one English claim sentence, no activity/topic prefix, decider named on rulings, no ungl ossed codewords; content: expansion never restatement — precision, rejected alternatives with reasons, citations, sentence deletion test, no process narration; insight: task-scoped lesson under the episode-deletion test; type: closed vocabulary with the honesty rule; tags: coarse project noun first then fine nouns, never activities; skip/relations texts distributed likewise). The tool description keeps only call-level rules: timing, skip test, citation norm, the four-question relation procedure, and the English rule. The grade parameter is removed entirely (a supplied grade is a parse error). Budgets gain teeth at 2× only: a field over twice its token budget is rejected with a receipt-style error naming the budget; anything under stays a receipt. Spec: `.scratch/semantic-container/spec.md` §Note contract revision; ADR-0003 (grade leaves the writer).

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] The rendered tool schema carries a description on every note parameter, and the tool description contains no per-field contract text
- [ ] A write with any field over 2× its budget is rejected naming the budget; at ≤2× it stores and the receipt reports overage
- [ ] A write carrying `grade` fails as a parse error
- [ ] The English rule and title/content/insight admission tests appear verbatim on the surfaces a writer reads
- [ ] note(session) accepts title only; the seven retired session fields are parse errors (moved from ticket 09 — same definitions surface)
- [ ] Mutation checks: each new rejection path demonstrated red (guard removed → test fails)
