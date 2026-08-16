# Settlement becomes an agent, and its vocabularies are re-derived from measurement

**Status:** ready-for-agent

## Problem Statement

Four things are broken at once, and they share one root.

**Nothing has written a turn's `type` since 2026-08-11.** The commit that retired the extraction agent removed the sole writer of `type`, `tags` and `significance_grade`. Zero rows in the whole database carry any word from the current vocabulary; every stored type is the retired one (`discovery` 3426, `decision` 1685, `change` 1577, `feature` 834, `bugfix` 735, `refactor` 111, `feedback` 2). The timeline's title cell, which required a type, showed ⏳ for everything.

**The settlement pass parses model output as a batch of instructions.** That shape forced it to re-implement authorization and validation the tool layer already performs, and every re-implementation was wrong in a way that destroyed data: a review verdict resolved addresses through the session-lifetime exposure ledger, so a hallucinated address landed a destructive write on a turn from a window settled days earlier; an omitted `type` or `tag` was read as an explicit clear, so a truncated reply wiped those columns across a window and its lookback; and a verdict formed before the model call was written over a note that arrived during it.

**The relation vocabulary carries four values, one of which is read.** Only `supersedes` is ever branched on, and no relation reaches any rendered output. 1097 of 1182 edges wear a four-value vocabulary that behaves as one bit. Judged-label precision is 65%.

**The session summary lags.** Only the settlement pass writes it, so it describes a state several windows old. The interface to write it already exists on the routed write tool; what was missing was any rule telling the main agent to use it.

The root they share: **work that requires judgement about the present was assigned to a pass that runs in the past, and work the tool layer already secures was re-done in a payload parser.**

## Solution

Settlement stops being a payload the write-back interprets and becomes an agent that writes through the same tools everyone else uses. The main agent takes back the two jobs that need to be current — stating a turn's `type` when it writes the note, and keeping the session summary alive. Both vocabularies are cut down to what measurement shows carries information, and both are defined by what the writer produces rather than by synonym lists.

The result a user sees: a timeline whose rows carry real activity words again; a session summary that describes now rather than several windows ago; and citation edges that answer "I later found out X was wrong — what did I build on X?"

## User Stories

1. As a returning user, I want each turn row in the timeline to show what the turn actually did, so that I can scan a session's shape without opening turns one at a time.
2. As a returning user, I want the session summary to describe the state as of my last few turns, so that resuming does not require re-reading the transcript.
3. As a returning user, I want to ask which past turns rest on a conclusion I have just discovered to be wrong, so that I can find the work that needs revisiting.
4. As a returning user, I want a turn that overturned an earlier one to be visibly linked to its victim, so that I do not act on a conclusion that was already withdrawn.
5. As a returning user, I want turns that carried no information to be absent from the record rather than present and empty, so that browsing is not padded with noise.
6. As a returning user, I want the session's decisions to accumulate somewhere I can read in one screen, so that a settled question is not re-litigated.
7. As a returning user, I want a session's `done` list to tell me what not to redo, so that a resumed session does not repeat delivered work.
8. As a returning user, I want session fields to point at the turns that justify them, so that a one-line claim can be expanded into its evidence.
9. As the main agent, I want to state a turn's `type` when I write its note, so that the value comes from the writer who knows rather than from a parser guessing at a title.
10. As the main agent, I want to overwrite one session field without restating the others, so that a small correction is a small write.
11. As the main agent, I want the write receipt to tell me how much a field now holds in total, so that an incremental append does not silently accumulate past its guidance value.
12. As the main agent, I want to declare that a turn overturned an earlier one at the moment I know it, so that the record does not depend on a later pass inferring it.
13. As the main agent, I want a note whose content accidentally carries tool-call syntax to be rejected, so that a malformed call fails loudly instead of silently swallowing a field.
14. As the main agent, I want to skip a turn that produced nothing retrievable, so that the record's density reflects the work rather than the turn count.
15. As the main agent, I want the injected session block to carry the fields I act on, so that deciding what to do next does not require a tool call.
16. As the settlement agent, I want to write through the same tools the main agent uses, so that address validity and field semantics are enforced once rather than re-implemented in a payload parser.
17. As the settlement agent, I want to review and label every turn in my window before assigning segments, so that a segment's type is the union of activities its members actually carry rather than a guess at the chapter.
18. As the settlement agent, I want the grading rubric stated in full in my prompt, so that grades are assigned against the same standard historical grades were.
19. As the settlement agent, I want to revise a turn from the preceding turns I can see, so that a grade assigned before an arc's scale was visible gets corrected when it is.
20. As the settlement agent, I want to be told which fields are still empty before I stop, so that I finish the window rather than believing I have.
21. As the settlement agent, I want to add a relation to an edge the main agent left bare, so that hindsight improves the record without inventing links.
22. As the settlement agent, I want to be prevented from creating an edge between two turns that never referenced each other, so that temporal adjacency in a multi-threaded session cannot masquerade as a relationship.
23. As an operator, I want a window that crashed midway to stay incomplete rather than be marked done, so that the next attempt finishes it.
24. As an operator, I want the job log to carry a per-grade histogram beside the calibration targets, so that grading drift is a comparison rather than an investigation.
25. As an operator, I want the count of review verdicts that stood down for a late note, so that a settlement routinely racing the live agent is visible.
26. As a future session, I want another session's title, content and insight to convey what it was about in a compressed form, so that browsing does not require opening it.
27. As a future session, I want a session's `reference` field to hold durable pointers, so that I can find the source checkout or spec that session worked against.
28. As a maintainer, I want the settlement agent's injected context to come from the same assembly the main agent's does, so that changing what the main agent sees does not require a second edit.
29. As a maintainer, I want type and tags to live at the levels that have one topic and one arc, so that a container's label does not saturate to the union of everything it held.
30. As a maintainer, I want the milestone grade to come from the grader rather than from an edge, so that a partial reversal does not silently cost a turn its whole grade.
31. As a maintainer, I want one closed axis of citation relations rather than a set of rhetorical labels, so that a relation is decidable by a question about consequence.
32. As a maintainer, I want budgets to be guidance reported to the writer rather than truncation applied to the reader, so that overflow is a signal rather than a silent loss.

## Implementation Decisions

### A. Settlement's execution form

**A1.** Settlement changes from *one structured envelope parsed into a batch of instructions and applied in one atomic write-back transaction* to *an agent that writes through tools as it works*. It already runs as an SDK query with an in-process MCP server exposing `recall` and `timeline`; it gains write tools and a Stop hook.

**A2. Superseded by A7** — window atomicity comes back, without the parser. Kept because the reasoning it records is what A7 had to answer.

**A2.** **Window-level** atomicity is given up deliberately. A crashed or abandoned window may leave a partially reviewed batch. Per-call atomicity is **not** given up: each individual tool call stays one transaction over its body, its derived edges and its status. The rule that replaces window atomicity: **a partially reviewed window must not be marked complete.** Job completion gates on a coverage check, not on the agent stopping.

**A2a. Mooted by A7** — under staged commit there are no partial windows to audit.

**A2a.** The current failure policy is not eventual convergence and the spec must not imply it is. After three attempts the cursor steps past a terminally failed window, which is "keep the partial result and abandon the remainder". If that remains policy under incremental writes it becomes more consequential, because the partial result is now durable rather than rolled back — so a partial window needs a named audit surface: which windows ended partial, and what a repair pass would have to redo.

**A3. Amended by A7** — the write tools are three (note, segment, `commit`), and settlement gets no `check`.

**A3.** The write tools are two: the unified note tool (a turn's note and facts) and a segment tool (create or extend, members, type, tags, body). There is **no edge tool** — an edge is always asserted by some turn, segment or session, so it exists as a field on those calls rather than as a free-standing write. There is **no session-summary tool for settlement** — see D1. Alongside them the agent keeps its existing read tools and gains one more, `check`, specified in G8.

**A4.** The settlement agent reuses the main agent's mnemo injection **interface**, not a copy of its content. This requires extracting a single assembly entry point that both the SessionStart hook and the settlement agent call. The reason is maintenance: managing the main agent's injected context must not require a second, divergent edit for the subagent.

**A5.** The settlement context renders window turns through recall's collapsed view rather than a private renderer, so that a later redesign of recall does not need mirroring here.

**A6.** Duties remain in three ordered steps — review every turn's grade, type and tags; backfill notes for turns that have none; then assign segment membership. The order is load-bearing: a segment's type is the union of its members' activities, which is vacuous while the members have none.

**A7. Settlement's writes stage, and one `commit` call is the only writer. This supersedes A2 and moots A2a** (user decision, S15069/T723).

A2 gave up window atomicity because incremental tool writes seemed to require it. They do not. The envelope was safe not because its parser was good but because **one reply was one transaction** — a crash landed nothing. A1 replaced the parser to fix a real defect, three data-destructive bugs from re-implementing in a payload parser the authorization the tool layer already performs; it should not also have surrendered the transaction, and G5's unsolved replay contracts are the bill for that.

Under staged writes the two properties separate cleanly. **Authorization stays live and per-call**: every tool call runs the real validation immediately and returns a real receipt, so the agent still learns of an error while it can still act on it — A1's actual benefit, unchanged. **Durability moves to `commit`**: nothing reaches the live tables until the agent asks, and the whole window lands in one transaction or not at all.

What this retires, rather than solves:

- **G5's three unsafe rows disappear.** Segment create is a bare insert with no natural key, segment extend is a revision compare-and-set whose conflict path cannot tell a caller's own lost-receipt replay from a real interleaving write, and session `append` replays to `A+B+B`. All three are lost-receipt problems, and a lost receipt on a staged write costs nothing because nothing landed. No job-scoped operation key is needed for either segment write.
- **G7's motivating crash becomes impossible.** "A window whose per-turn fields are all written but which crashed before the segment tool" cannot occur when the fields and the membership commit together. The exclusion table and the anti-join **survive** — they are now `commit`'s precondition rather than a repair for partial state.
- **A2a's partial-window audit surface is unnecessary.** There are no partial windows to audit. The three-strike abandonment policy is unchanged and is now clean: a retry starts from nothing rather than reconciling against its own residue.

Three things this costs, stated rather than discovered later:

1. **Forward references need run-scoped handles.** A staged segment has no id, and members and anchor edges must name it, so the agent addresses it as `E#1` within the run and `commit` resolves handles to real ids as it creates them, in staging order. This is a small interpreter, and it is **not** the parser A1 removed: that one carried authorization, this one replays intents authorization has already passed and re-checks against real ids inside the commit transaction.
2. **An agent that never calls `commit` yields nothing** — no partial result survives, where incremental writes left one. Accepted: the retry cap is three and a window is at most fifty turns, and a clean re-run beats reconciling against a half-state. Ticket 11's Stop hook becomes "you have not committed, and here is what is still missing", which is a better shape than a standalone gap list.
3. **Validation runs twice, and the two are not the same check.** At stage time it is *feedback* — the agent's chance to correct. Inside the commit transaction it is *truth*, because the world moves between them: a note the main agent lands late, another window, a lease reclaimed. This is G2's own "layers with decreasing trust" applied one level down, not a new concept.

**Staging lives in the per-request server closure**, in memory — not an open SQLite transaction, which would hold the write lock for the model's entire run while every hook process sits on the critical path of a user prompt, and not a staging table, which buys durability nobody wants here and costs a crash-residue lifecycle. A crash losing staged writes is the correct semantics: the job stays claimed and retries.

**A3's tool list becomes three**: the turn note tool, the segment tool, and `commit`. **G8's `check` folds into `commit` for settlement** — a `commit` that refuses reports what is missing and leaves the staging intact, so the agent fills the gaps and commits again. That is strictly better than a separate tool, because the check cannot drift from the gate: it *is* the gate, and passing it is what performs the write. The main agent's own `check` tool is untouched.

### B. The `type` vocabulary

**B1.** The mechanical derivation of `type` from a note title is **retired**, not kept as a fallback. The main agent states `type` when it writes the note. Measurement: of 427 titles in the `<activity>+<topic>:` shape, 353 resolve and 74 do not — and roughly half of the failures are vocabulary gaps while half are titles that never followed the format. A separate content-level audit found the title's first word disagrees with what the turn produced often enough that a title-based count of `implement` over-counts implementation activity by about a quarter.

**B2.** The vocabulary is eleven words, all peers. There is no qualifier class: a word that empirically never stands alone is an observation, not a rule.

| word | what the turn produced |
|---|---|
| `discuss` | deliberation using only knowledge at hand, **with no act of checking** |
| `research` | going into code, logs, data or literature to find out how something actually is |
| `design` | a decision chosen among viable options, with reasons; rejecting an option counts |
| `implement` | an artefact that did not exist before (code, document, dataset) |
| `refactor` | an existing artefact improved with nothing new added and no defect fixed — restructuring, prose trimming, and deliberate descoping alike |
| `fix` | an existing but wrong behaviour made correct; requires an identifiable failure symptom |
| `measure` | a quantity: counts, timings, costs, hit rates, coverage |
| `review` | a judgement plus a defect list on an existing artefact; absorbs verify / inspect / audit |
| `ops` | a change to the system's running or released state rather than its content |
| `delegate` | a dispatch of work to another executor with a defined scope |
| `correction` | this turn reversed a position previously held; optional, and always accompanied by a `supersedes` edge when the reversed thing is a turn |

**B3.** Boundaries are stated only where measurement showed them failing:
- `measure` against `review`: a number versus a judgement. `verify` belongs to `review`; routing it to `measure` had been systematically inflating that slot and starving review.
- `write` is **removed**: spec and ticket authoring is `design`, often `design`+`implement`; explaining is `discuss`. Its 15 real rows were 5 explanations and 10 specs.
- `chat` is **renamed** `discuss`: it drew one use in the corpus not because deliberation is rare but because 闲聊 repels a serious design debate.
- `discuss` against `research` is decided by **method, not output**: the moment the turn goes and looks something up, it is `research`.
- `implement` against `refactor` against `fix` is arithmetic: `implement` adds, `fix` corrects, `refactor` subtracts or reorganises.
- `ops` against `implement`: shipping a feature is `implement`; releasing a version is `ops`.
- `delegate` against `implement`: the turn does not do the work itself. The later turn that collects and checks the result is `review`.

**B4.** `rolled-back` is **removed from the vocabulary**. The corrected end of a reversal carries no type: it is knowable only after the fact, so a type field there would need retroactive maintenance kept in sync with an edge that already states it. Its glyph and its settlement-only write guard go with it. The one ranking key that reads it must move to an inbound-edge test.

**B5.** `type` becomes **multi-valued** on a turn, as it already is on a segment. A rolled-back design is `design` plus a `supersedes` edge; a turn that both reviewed and shipped is `review`+`ops`. Observed multi-value rate is 43-49% one word, 45-47% two, 3-11% three or more — calibrated, neither degenerate nor saturating.

**B6.** Turn `tags` are bare subject words and the `topic:` namespace is **retired**, existing rows included — the prefix is stripped once in a migration rather than translated on every read. Leaving the old rows in place was the earlier plan and it was wrong: a read side obliged to match two spellings of every subject forever is a mechanism kept alive to serve a distinction that no longer exists. Measured before the decision: 7229 prefixed values against 18292 bare, of which `topic:` is 6427 and the remainder is three machinery namespaces (`compact:` 414, `invalidated:` 340, `delivery:` 46). Stripping therefore leaves a rule a reader can hold in one line — **a bare tag is what the turn was about, a prefixed one is bookkeeping.** Exactly one live row carries both spellings of a word, so the strip de-duplicates, order-preserving.

Session-arc role words (`correction`, `blocked`, `deferred`) are not turn tags: `correction` becomes a `type`, and status words stay out of the function vocabulary.

**B7.** An illegal or absent activity word leaves `type` empty. Empty is never a claim.

### C. The citation relation vocabulary

**C1.** Four relations on one axis — **how trust flows between two turns** — plus a meaningful null.

```
citing → cited      evidence-for       I strengthen it
                    evidence-against   I weaken it, without yet overturning it
                    supersedes         I overturn it

cited → citing      depends-on         its result underwrites my conclusion

no flow             (no relation)      I merely mention it
```

**C2.** `builds-on` and `implements` are **removed**. Measured migration under blind re-labelling: `implements` maps to `depends-on` at 96% — it was always a special case of dependency, and the two endpoints' own types already said it. `builds-on` splits 62% `depends-on`, 18% no relation, 16% `evidence-for` — one label had been hiding three things. `builds-on` was also tautological: 99.86% of edges are same-session and later-cites-earlier, so continuation is definitional.

**C3.** The decision procedure is four ordered questions, first yes wins. Question ordering arbitrates only 1.5% of edges, which is what justifies calling this one axis rather than three competing readings.

1. Did the citing turn overturn it? → `supersedes`
2. Did the citing turn test its claim — supporting or undermining it? → `evidence-for` / `evidence-against`
3. **If the cited turn were wrong, would the citing turn's conclusion also be wrong?** → `depends-on`
4. None of the above → no relation

**C4.** Question 3's counterfactual wording is normative and must be carried into the prompt verbatim. It must not be softened to "used" or "built on": the predecessor vocabulary collapsed to 61% precision at exactly that point, because "built on top of" feels like "depended on". A direct continuation whose predecessor could be entirely wrong without changing what the later turn did is **no relation**.

**C5. Edge identity is the pair; relation is a nullable attribute of it.** An edge is identified by `(citing node, cited node)` and carries at most one current relation. **This is a schema change, not a convention, and it blocks implementation until made.** Today `relation` is `NOT NULL`, sits inside both the primary key and the upsert conflict key, and is CHECK-constrained to the retired four values — so an unattributed edge cannot be stored at all, and correcting a relation inserts a second row instead of replacing an attribute. A write naming the same target under more than one relation field is rejected.

**C6. A pair exists if and only if the body's post-state cites it.** Citation-bearing fields are the source of truth for which pairs exist:

- Writing a node re-reads **all** its citation-bearing fields after the write, recomputes that node's cited-pair set, and **deletes pairs no longer supported by any field**, together with their relations. Edges are additive-only today with no delete path anywhere, so a segment whose content is overwritten leaves its old edges behind forever. A per-field ledger would also work; a whole-node rescan is simpler, and turn, segment and session field counts are all bounded.
- The generic body-free structured edge write is **removed**, not inherited by the merged tool. It currently accepts a relation list with no prose at all, and any merged tool that keeps it makes the rest of this section bypassable in one call.

**C7. Who may attach a relation, and when.**

- The **main agent** may attach a relation to a pair its own write is creating — it authored the prose in the same call, so the argument and the claim arrive together.
- **Settlement** may attach or correct a relation **only on a pair that already existed in its transaction's pre-state**. It may not attach one to a pair the same call is creating.
- Settlement **does** write bodies containing citations — it authors segment bodies, and before a segment is created there is no citing node at all — so those mechanically derived bare pairs are legitimate. The earlier draft said settlement may never mint an edge, which contradicted C6 for exactly this case.

The rule this replaces the earlier one with: settlement may not mint a **free-standing or relation-only** edge. Evidence for the restriction: the audited spurious edge is settlement-only, and settlement attaches `supersedes` at 11.6% of its edges against the main agent's 7.2% — over-reaching on the most consequential relation from the weakest vantage, having never watched the work happen.

**C8. What is structurally eliminated, stated honestly.** These rules eliminate **bodyless and free-standing edges**. They do **not** eliminate spurious edges, and the earlier draft claimed they did. A body reading `Related: [S1/T2]` alongside a `supersedes` field naming T2 passes every structural check while containing no overturning argument; a session write can lean on a pointer parked in `reference` to license a relation asserted from `decision`. Co-occurrence proves the target is named in the canonical body — nothing more. Semantic truth remains the model's responsibility and the auditor's, and the spurious-edge rate remains a thing to measure rather than a thing this design has closed.

**C9. The reference parser must match whole tokens.** Executed against the current implementation, `[[S1/T2]]` and `[foo [S1/T2]]` both yield a citation to T2, contradicting the parser's own comment that a malformed bracket is skipped whole. C6's guard is only as strong as this parser: text a reader would never see as a citation currently satisfies "the body cites this turn". Fixing it is an acceptance criterion of this work, not a follow-up.

**C10.** `citing_kind` gains `session`, so session fields can carry citations.

**C11.** Mechanically created segment-anchor edges carry **no relation**. Stamping `builds-on` on them was tautology: a segment is definitionally an aggregation of its members.

**C12.** Edge provenance must distinguish its three sources — the main agent's own assertion, a bare textual reference, and a settlement attribution. The current provenance column conflates the first and third.

**C14. No source hierarchy decides whether a relation may be corrected.** A first implementation ranked provenance and let the rank gate the relation column, so a relation written by the main agent became permanently immune to settlement's correction — which makes C7 unimplementable, since C7 exists precisely to let settlement correct with hindsight. It also inverted C6: the structured citation path labels every entry as the main agent's own assertion regardless of whether any body cites the target, so a bodyless relation-only call acquired the highest authority of all.

The rule instead:

- **Eligibility lives in each write path, not in a global ordering.** A main-agent relation requires its target to be cited in that call's body post-state; a settlement relation requires the pair to be present in the transaction's pre-state. Those are C7's two conditions and they are sufficient on their own.
- **An authorised relation write replaces the current relation and the provenance recording where that relation came from.** No rank test stands between them.
- **A bare textual pair never clears or relabels an existing relation.** A citation appearing in prose says the pair exists; it says nothing about the relation, so it must not overwrite one.

Provenance remains what C12 asks of it — a record of which source stated the current relation, with the bare-text value reserved for a pair that has none. It is evidence for a reader, not an authority for a writer.

**C15. Endpoint deletion must not leave edges behind.** The retired citation table carried a foreign key with `ON DELETE CASCADE`; the surviving edge table cannot, because one integer column spans three id spaces. Retiring the first therefore made this load-bearing rather than merely untidy, and it is observable, not hygiene: the segment ranking key counts distinct citers of a turn without joining endpoint existence, so a deleted citing turn leaves a ghost that inflates a surviving target's cited-by count, and a deleted cited turn leaves readers pointed at nothing.

The fix belongs at the storage layer, as kind-aware delete triggers covering both directions for turns and segments and the outgoing direction for sessions. It must not live only in the deletion APIs: cascades and direct SQL bypass those. This is ticket 05's to close, not a gap for ticket 06 to inherit — 06 reconciles a body against its pairs, which is a different question from how long an endpoint lives.

**C16. On an overlapping pair, the citation table's relation wins the fold-in.** The two graphs overlap almost entirely — every citation pair in production already exists in the edge table — so the fold-in's conflict clause decides the outcome for essentially every row, and the first implementation left it to `DO NOTHING`, which silently made the citation relation lose without anyone choosing that. It must lose or win by rule, and it wins: the citation table was the timeline correction graph's replace-set truth right up to its retirement, so it is the side that was being read. Pairs present only in the edge table are retained, and a pair present in both keeps the earlier of the two timestamps. A test must exercise an overlapping pair whose two sides carry *different* relations, because that is the case production actually contains and the one the existing tests avoid by emptying the edge table first.

**The win is conditional on the citation stating a relation.** A `builds-on` citation remaps to NULL under C2, and NULL is the absence of a statement about the relation, not a statement that there is none — so such a citation contributes only the pair and never clears a relation the edge already carries. This is C14's rule, reached for the same reason rather than by analogy, and the implementation is literally the same conditional the live upsert uses. Unconditional, the fold-in would carry a NULL over a relation settlement had corrected, in a single irreversible pass that then drops the source table. Measured before the change landed: 0 of the 1182 overlapping pairs are in that shape, all 1182 agree on relation and provenance, and none would have a timestamp pulled — so the whole clause is a no-op on today's data. An empty path in a one-shot migration is the cheapest kind to close, and the reason to close it is that nothing later can reopen it. The timestamp pooling stays unconditional and independent of the relation: a relationless citation that predates the edge still corrects its age.

**C13. The dual edge graph must be resolved before C6 can be implemented.** Two tables hold edges, two consumers read different ones, and they disagree about deletion.

- `turn_citations` is a genuine replace-set: the main agent's `cites` path deletes a turn's rows before rewriting them. The timeline's correction graph reads **this** one — victim demotion, corrector promotion and pull-through all consume the map built from it.
- `memory_edges` is an additive upsert with no delete path anywhere. The segment ranking key reads **this** one, for both its corrector flag and its cited-by count. The settlement pass writes only here.
- The migration between them is one-way and insert-only, and runs at schema init and at worker start.

Measured pair-level in both directions rather than by bare row totals. **Established:** 1182 citation pairs against 1506 turn-to-turn edge pairs, with 0 present only in the citation table — so the edge graph is a strict superset and the migration has missed no live source row — and 324 present only in the edge table.

**Not established: what those 324 are.** Provenance cannot answer it, because the migration stamps legacy citations `judged` too, so a settlement write and a citation that was migrated and later retracted are indistinguishable by that column. This is C12's conflation biting the analysis of C12.

The timestamps give evidence without giving proof. The migration carries each source row's original `created_at_epoch` across, so a migrated-then-retracted pair would still wear a per-citation timestamp drawn from the same spread as the surviving ones. Instead the 324 sit on **24 distinct timestamps**, against **785** for the 1182 shared pairs, with **zero values in common** — roughly 13 pairs per timestamp, the signature of a batch write, which is what a settlement transaction produces and what a per-turn `remember` call does not. That is consistent with settlement-only origin and hard to reconcile with a large retracted population, but it is a pattern argument over aggregates, not per-pair attribution. **No claim that the data contains no retraction leak is supportable**; the honest statement is that its timestamp structure shows no sign of one.

The shipped divergence, which does not depend on any of the above: a settlement-written `supersedes` moves segment ranking but is invisible to the timeline's victim demotion, so the same relation yields two different facts depending on which consumer asks. That deserves its own decision independent of this spec.

The constraint on C6 stands regardless of the direction: its recompute-and-delete cannot be built by reaching for the existing edge writer, which would inherit the additive semantics and create precisely the leak the current counts do not show. Either the two layers collapse to one truth table or the older one is explicitly retired; both alive on an insert-only migration is not carryable.

### D. The session summary

**D1.** The session summary is written by the **main agent**, not by settlement. Its purpose is to guide what to do next, and a description of *now* must be written by whoever is current. Settlement handles the past and gets no summary tool.

**D2.** `current` is **deleted**. It duplicated `content`'s job at a different compression. Seven fields remain, split by reader:

| reader | fields |
|---|---|
| another session browsing this one | `title`, `content`, `insight` — a compressed global view |
| this session's next step | `next_steps`, `decision`, `done`, `reference` — recent events |

**D3.** Session fields may carry unattributed `[S/T]` citations. This makes the summary an **index** rather than a restatement, which is what "the session's current working state, not a log" has always meant.

**D4.** **No session-level `type` or `tags`.** A session is a container, not a semantic unit: its type would saturate to the union of everything it touched. The unit with one topic and one arc is the segment, which is why type and tags live there and at turn level.

**D5.** Writes are per-field. Each write declares **`append` or `overwrite`**; the mode is required when the field is non-empty and its absence is an error, the same guard the note tool's `replace` already applies. A field that is empty needs no mode.

**D5a. One mode vocabulary governs every field of every write tool — turn fields included — and no field gets a mechanism of its own.** This started as a session-write rule and is now universal, because the per-field alternative was tried and measured: the turn write path grew five disagreeing answers to the single question "what does omission mean" — `title`/`content`/`insight` left a value alone, `type` cleared it, `tags` merged into it, `replaceTags` overwrote it, and note's `replace` gated the whole row. Each was locally defensible and together they were incoherent, and the incoherence lived in the **defaults**, where nobody had to state it. A mode the caller names moves the decision into the open, which is the only place it can be reviewed.

This retires `replace` and `replaceTags`. Until the merged write tool lands (ticket 03), turn fields take the strict subset that invents nothing: **absent leaves the stored value alone, present overwrites it whole.**

**One merge survives, and naming it is the point.** `mergeTags` is still live for exactly one internal caller: the settlement write-back, whose review directive carries a *single* `tag`, so an overwrite there would delete every tag the directive did not happen to mention. The blocker is the directive's shape, not the rule — a writer that can only ever state one value cannot be asked to state a whole set. Ticket 10 moves settlement onto the public tools, and the directive must grow to a full tag list in the same change; `mergeTags` and the `tags` parameter on the turn update input are deleted there. Recording this beat the alternative discovered during ticket 02, which was a spec sentence claiming a retirement the code had not performed — the same defect as a closing note claiming a rejection the code did not make. In particular an omitted `type` must not clear a stored one — B7 says empty is never a claim, so writing empty cannot be the act of claiming there is no type, and clearing takes an explicit empty list. This is C14/C16's rule reached a third time from a third direction: the absence of a statement is not a statement of absence.

**D6.** The session write path needs the omit-versus-clear distinction the turn path already has: absent means leave alone, explicit null means clear. Today's upsert coalesces, so "this field no longer applies" is inexpressible.

**D7.** Budgets are **guidance values reported in the receipt, never truncation**. Two concerns that are currently one constant must separate: a write-side signal to the author, and an injection-side cap that becomes a rarely-hit backstop once the signal exists.

**D8.** A session write's receipt is the only feedback its author ever gets, and today it is one sentence naming the session — no usage, no sizes, no history. It must carry two things.

First, **per-field usage against the guidance value**, and for an accumulating field the **total after the write** rather than the delta: a writer adding 50 tokens at a time otherwise reaches 1000 without noticing.

Second, **how long it has been since the summary was last updated**, counted in turns. Of the two, only this one names an action. A ratio says "you wrote too much", whose implied action is vague; "47 turns since the last update" says what to do, and its absence is checkable. That the ratio alone does not bind is measured rather than assumed: in the session that produced this spec, 23 of some 24 notes ran 1.6–2.3× over budget with no convergence between the first and the last, every one of them having been shown its number.

**D8a. Report the fact; withhold the target.** A field's guidance value travels with its usage, because meeting it is the goal. The cadence band does **not** travel with the elapsed count. The realised frequency is a measurement of something the writer is not supposed to be optimising — whether content sits at the right level of abstraction (D10) — and publishing its target pins the number: the writer updates to reset the counter, and the diagnostic then reads healthy by construction. This is G9's failure shape at a smaller scale, and the rule behind both is one rule: **give a writer a target when meeting it is the goal, and withhold it when the realised value measures something else.**

**D9.** Guidance values, derived from corpus measurement (mean/max chars: content 369/1473, decision 508/1371, done 392/864, reference 309/746, insight 198/282, next_steps 148/611):

| field | guidance |
|---|---|
| `decision` | 300 |
| `content` | 250 |
| `next_steps` | 250 |
| `done` | 150 |
| `reference` | 100 |
| `insight` | 80 |
| `title` | 30 |

**D10.** Update cadence is a **diagnostic, not a quota**: roughly once per ten turns is the healthy band. Updating far more often means content is being written at too low a level; far less often means too high. The existing summary timestamp makes this measurable without new instrumentation.

That band is **operator-side only**. Per D8a the writer is told how many turns have passed and is never told what number is good — the moment it knows, the count stops measuring the thing it exists to measure.

### E. One write tool

**E1.** `note` and `remember` merge into one tool. This is not only tidiness: it removes an unfenced third writer of a turn's `grade`, `type` and tags, so the note-timestamp fence that protects a late note covers every write path without a new provenance column.

**E2.** The tool rejects content containing tool-call syntax. Measured: 97 rows carry raw parameter markup inside `content`; 94 have no shadow row, so they arrived through the pre-retirement path where the extraction agent copied transcript material verbatim, and 3 came through the note tool from a malformed call. Nothing rejects either today, and the failure silently swallows the `insight` field.

### F. The skip rule

**F1.** A turn is skipped when it advanced the conversation but produced **no information gain** — deleting it would cost no decision, no progress, no coherence. Measured skip rate on a 204-turn sample: 10.3%.

**F2.** Named classes, each with its exception: a **pure progress query** unless the check uncovered a new problem; a **pure explanation** unless it produced a new conclusion or changed what someone would do next. Three further classes surfaced by measurement: mechanical compact-continuation rows, verification with no new finding, and trivial administrative actions.

**F3.** Never skippable, whatever the size: a user decision, correction, veto, or first statement of a preference; any turn carrying a conclusion, a rejected option with its reason, or a lesson; any turn whose result something later depends on. The exception clauses do real work — a turn whose entire prompt was 「测试」 must be kept because it found an empty field in a live payload.

**F4.** **A turn that cannot yield a type is a skip, not a kept empty row.** This collapses the skip criterion and the coverage check into one test.

### G. The coverage gate

**G1.** The Stop hook checks **empty fields only**. Per F4 that is also the skip check, so no separate "does every turn have a note" or "is every turn in a segment" check is needed.

**G1a. That reasoning covers the Stop hook and does not cover the completion gate.** It is true of the *fields a turn carries* and false of the *notes settlement was supposed to backfill*: a turn can carry a stated type — duty 1 done — while the hole duty 2 existed to fill is still open. Found by a cross-session review of ticket 09, against the source rather than against this text.

The only runtime check that every reconstructable hole now carries a shadow note lives in the retiring write-back, which throws and rolls the whole reply back when one is left open. Ticket 10 deletes it, and nothing in G7 replaces it. The sequence that then commits: a hole gets its type written and a segment membership; its note call fails or is simply omitted; the gate, checking type coverage and segmentation only, marks the job done with the turn permanently unnoted and the window's cursor advanced past it.

So the completion gate carries a **third clause** — no turn in the frozen window is still owed a note — computed inside the same transaction as the anti-join and the compare-and-set, and therefore under G6's generation fence. G1 stands for the Stop hook, which trusts the agent and hands it a list; it does not stand for the gate, which trusts nobody. That asymmetry is G2's own, restated where it had been left out.

**G2.** Two layers with different trust: the **Stop hook blocks and lists the gaps** — at most twice, to avoid a loop — because it trusts the agent to fill them; the **job-completion gate re-checks independently** and leaves the job claimed when it fails, because it trusts nobody.

**G3.** A skipped turn needs no review verdict; skip is itself a verdict and counts as covered.

**G4.** The eligible set is the window's turns minus compact markers and minus slash commands that need no model reply. **Sidechain rows are eligible** — they are legitimate turns.

**G5. Dissolved by A7.** All three unsafe rows below are lost-receipt problems, and a lost receipt on a staged write costs nothing. The table is kept because it is the analysis that showed staging was the answer, and because the *reasoning* about each write's semantics still holds — only the retry hazard is gone.

**G5.** Retry safety is a **per-tool replay contract**, not a blanket property. An earlier draft of this spec claimed the writes were idempotent by construction; a cross-session review disproved it against the source. Each tool states its own contract, and three of them do not have one yet:

| write | replay behaviour |
|---|---|
| note rewrite | **idempotent** — keyed by turn address, an overwrite |
| turn `type` / grade | **idempotent** — overwrite |
| turn `tags` | idempotent **only as a replace-set**; merging makes a retry's revised judgement accumulate on top of the judgement it was revising |
| segment membership | **idempotent** — the `(segment, turn)` pair is the natural key |
| segment **create** | **not idempotent** — a plain insert with no natural key, so a lost receipt yields two segments |
| segment **extend** | **not a union** — a revision compare-and-set that overwrites title, content, type, tags and status; replaying with a stale revision conflicts, and if the first write closed the segment it is frozen |
| session `append` fields | **not idempotent** — `A`, then a committed `append(B)` whose receipt is lost, replays to `A+B+B` |
| relation edges | need per-source replace/remove semantics, for the same reason as tags |

The three unsafe rows need decisions before implementation: a stable idempotency key for segment creation plus replay semantics of "the target state already exists, so succeed"; a replay rule for extend that distinguishes a stale-revision retry from a genuine conflict; and for the accumulating session fields either a stable request key or a collapse to read-then-overwrite with concurrent-overwrite semantics acknowledged. D5's `append`/`overwrite` mode expresses intent and drives the receipt — it does **not** confer idempotency, and the earlier draft leaned on it for a job it cannot do.

**G6.** Each settlement write tool must carry an **unforgeable job identity**. The atomic write-back validated the job's claim generation and claimed status at the opening of its transaction and discarded the entire result when the lease had been reclaimed under a new generation. The public write tools have no such capability, so a stale attempt that lost its lease would keep committing business writes and fail only at the final completion compare-and-set. The job id and claim generation must be injected by the in-process server closure — never passed by the model — and checked for claimed ownership **inside each tool's own write transaction**.

**G7.** The completion gate must **prove segmentation ran**. Checking empty fields cannot: a window whose per-turn fields are all written but which crashed before the segment tool has no empty fields, so a retry sees nothing owed and marks it done, permanently unsegmented. A non-empty `type` is evidence the first duty completed, never the third.

What has to be proven is a **state predicate over the window**, not a recorded event. A `segmentation_complete` flag is the agent's own attestation, and G2's rule is that the completion gate trusts nobody — the flag can be true while turns are missing. A flag the *server* sets only after verifying coverage would be correct, but then the per-turn facts are what prove it and the flag is a redundant cache that can desynchronise. It is not added.

The positive fact is already persisted and add-only: segment membership, keyed `(segment, turn)`, with no removal path anywhere in the codebase. The one thing the data model cannot express is the **negative verdict** — this turn was reviewed and deliberately belongs to no segment. So the minimal addition records only the exceptions, not an assigned/unassigned row per turn:

```
note_settlement_segment_exclusions(
  job_id, turn_id, created_at_epoch,
  PRIMARY KEY (job_id, turn_id)
)
```

Completion becomes an anti-join recomputed over the frozen window, run inside the same transaction as the completion compare-and-set and therefore under G6's generation fence. Every segmentation-eligible turn must satisfy one of: it is a segment member; it carries a no-segment exclusion for this job; or it is `status = skipped` — a skipped turn has no information gain and no type, so it is never a segment member and its status is already the negative fact.

Crash semantics then fall out rather than being designed: membership written but the exclusion not yet leaves the anti-join short, so the window stays incomplete until a retry fills it.

The exclusion is **job-scoped and must not become a column on the turn.** The window is a frozen work unit, and A2a requires a partial-window audit surface; a turn-level column would lose which window issued the negative verdict and would stop a later repair job from re-adjudicating it.

**G8. Amended by A7** — for settlement the predicate is `commit`'s own precondition, not a separate tool; a refused commit reports the gaps and keeps the staging. The main agent's `check` is unchanged.

**G8.** The coverage predicate is exposed to the agent as a **`check` tool**, so it can pull the answer instead of only meeting it at Stop.

This is not the self-attestation G7 rejects. A flag is a claim the actor writes; `check` is a read of stored facts whose answer the actor cannot fake, computing the same predicate the gate computes. What it buys is timing: an agent that can verify before it believes it has finished never has to re-open work it had already closed, and the Stop hook demotes to a backstop for an agent that did not check.

One predicate, three callers, decreasing trust — the `check` tool pulled by the agent at any time, the Stop hook pushed at stop and blocking, and the completion gate server-side inside the completion compare-and-set. Three implementations would drift, and drift resolves toward whichever is loosest. It reports what is missing — empty fields on eligible turns, and turns that are neither a segment member nor excluded — and never why; the agent knows why.

**G9.** The per-grade histogram **must not be visible to the grading agent** at any point in its run. Its reader is the operator and its time is after the fact.

Calibration targets are population-level expectations, not per-window quotas. In a twenty-turn window the variance is large, and a window that genuinely holds three Grade 4 turns must record three. An agent shown its own running distribution grades to the histogram rather than to the rubric, which is a worse failure than the drift it would be trying to correct — and this project has already measured judgement leaking toward whatever the judge can see, in an in-band scoring experiment abandoned for exactly that reason. Drift is a cross-window diagnostic; its remedy is the rubric or the model, never a live counter in the judge's context.

This clause exists because the opposite is the natural thing to reach for. An implementer wiring up G8 will have the histogram in hand and adding it to the same payload will look like a courtesy.

### H. Milestone selection decouples from edges

**H1.** An edge is an annotation and **must not move a grade automatically**. The victim demotion (flooring a superseded turn's effective grade to 1) and the corrector promotion (raising a citer's to 3) are removed, along with the two selection branches that made a victim ineligible to anchor.

**H2.** The derived effective-grade layer **survives**, minus its edge terms. Removing the edge coupling is the decision; collapsing the layer into the stored grade is a separate change that is **out of scope here**, because the layer has a second job nobody has replaced.

That second job is supplying a grade to rows that have none. Only 3809 of 11406 turns carry a stored grade — 67% are NULL — and the layer answers for them in two different ways: a post-cutoff turn with no grade reads as 0, while a pre-cutoff turn does not consult the stored grade at all and is scored through a type→grade map that is the last surviving use of the retired type vocabulary. Collapsing the layer would silently re-grade the majority of the corpus. Any later ticket that wants the collapse must first state the contract for both cases; this one does not.

**H2a.** The claim that the change is local needs qualifying. The *derivation and its wiring* live in the timeline module. The *observable surface* does not: the derived grade is rendered as `G<n>` through the timeline query's MCP text contract, and the same view and renderer are reused by the SessionStart milestone injection — which the settlement context in turn consumes, so the settlement agent reads grades this layer produced. Twenty-two test references import the derivation directly, and three tracked bundles rebuild. Removing the edge terms changes rendered output, so it is a behaviour change with a wide surface, not a refactor.

**H3.** The `supersededBy` back-link rendering survives: edges drive display, not score.

**H4.** This is safe now because the mechanical rule was compensating for a grader that could not see the arc. The settlement agent grades with the window, the fifty-turn lookback and the edges in view, and can express what the rule could not — that a reversal was partial. The cost is that the safety net is gone, and the grade histogram against calibration targets becomes the only check; it catches drift, not single misjudgements.

### I. The task-causality rubric

The recovered rubric's grade definitions and calibration targets are unchanged. Its correction clause is rewritten: where it ordered the grader to tag the casualty `rolled-back` and lower its grade through a `regrade` verb — neither of which now exists — it must instead say to write a `supersedes` edge to the overturned turn and grade it by its surviving task-causal consequence, only on witnessed disproof or rollback evidence, never from a guess.

### J. Disposition of the shipped tickets

Tickets 01-05 of the segment-grading effort are committed and unpushed. **Their history is kept and the dead code is deleted in new tickets.** Rubric recovery, the timeline render gate and the milestone nesting remain valid under this spec; only the write-back layer dies. The three defects those commits fixed are the record of what this architecture must not re-create.

## Testing Decisions

A good test here asserts a behaviour a caller can observe, and can go red on the defect it names. Two lessons from this effort are binding:

- **A test must watch the columns that can move.** The first fence test watched `title` and `content`, which the write path never names, so it was green against a completely unfenced implementation. Pinning `type` and `tags` — the pair two writers actually contend for — made the same interleave go red.
- **A concurrency criterion names the interleave, not the mechanism.** "A compare-and-set exists" is a test that cannot fail.

**Seam 1 — the write-tool boundary.** Every write, from the main agent and the settlement agent alike, passes through the note and segment tools, so this is the highest seam that sees all of them. Tested here: per-field writes and the omit-versus-clear distinction; the `append`/`overwrite` mode and its error when unspecified; budget receipts including the accumulated total for accumulating fields; a citation in a body creating an unattributed edge; a relation field naming a turn the body does not cite being rejected; content carrying tool-call syntax being rejected; and settlement being unable to mint an edge. Prior art: the existing note-settlement write-back and era-cutover fixtures, extended rather than replaced.

**Seam 2 — the coverage check as a pure function.** Database in, gap list out. Tested here: an empty field producing a gap; a turn that is neither a segment member nor excluded producing a gap; a skipped turn counting as covered; compact markers and reply-less slash commands excluded; sidechain rows included. Keeping this a pure function is what lets its three callers — the `check` tool, the Stop hook and the completion gate — share one implementation while trusting it differently, so a test at this seam covers all three at once.

**Not tested: the SDK agent loop.** Driving a fake query through the full settlement conversation would add a third, brittle seam to assert behaviour the two seams above already cover. Judgement quality — whether the agent's grades and relations are *good* — is offline-evaluation territory, not unit-test territory.

## Out of Scope

- **Memory reading and rendering.** The recall and timeline redesign is a separate effort. In particular: whether relations should be surfaced in any view, how a skipped turn should appear, and how a turn with no note but real raw material should render.
- **Migration of existing rows, with one carve-out.** Existing `topic:`-prefixed tags and retired-vocabulary type values are left exactly as they are — neither column enforces a closed vocabulary, so leaving them costs nothing and a re-labelling pass over history stays a later decision.

  **Stored relations are the exception, and this clause originally got them wrong.** The relation column *does* enforce a closed vocabulary, so retiring a value from the vocabulary retires it from the column: "leave them as they are" was not an option the schema could offer. Their migration is therefore in scope, and it is **a stated data loss, not a meaning-preserving conversion**. `implements` becomes `depends-on` on a 96% aggregate — an estimate about a population, never a fact about any one row. `builds-on` keeps its pair and loses its label to NULL, which is only tolerable once a relationless pair is actually readable, and which permanently conflates "this pair never had a relation" with "its old classification was discarded". The alternative — admitting the retired values into the column as inert storage-only values — was put to the user and declined: a closed vocabulary is worth more to every future reader than a distinction nothing currently consumes.
- **The spurious-edge problem.** Measured at 1.5-7.7% depending on the pool, its cause is a judge misled by temporal adjacency in a multi-threaded session. C5-C9 close the *bodyless* path into it and nothing more — C8 is explicit that this design does not eliminate spurious edges. Their rate stays a thing to measure; a scoping fix at context-construction time is not attempted here.
- **Collapsing the effective-grade layer into the stored grade.** Only the edge terms come out (H1). The layer still answers for the 67% of turns with no stored grade, and pre-cutoff turns are scored through a type→grade map rather than their stored value; a collapse must define both contracts first, and bundling that with the edge decoupling would mix a behaviour change into a structural one.
- **A `duplicates` relation.** Real but measured at 0.8%, below the bar.
- **A twelfth type word for capability removal.** Absorbed into `refactor` by B3's arithmetic framing.
- **Making the budget signal effective.** Advisory budgets demonstrably do not bind — 23 of ~24 notes in the originating session ran 1.6-2.3× over, with no convergence. Whether the receipt should report a *consequence* rather than a ratio is deferred.

## Further Notes

**Every decision above that cites a number was measured on the production corpus, read-only.** Where a subagent produced the figure, it was recomputed from a persisted per-row file before being accepted; two of those recomputations changed the conclusion.

**Two hypotheses this effort refuted, recorded so they are not re-proposed.** `builds-on` was suspected of being a default bucket like the retired `change` type slot; it has the *highest* precision of the four relations, and the confusion runs the other way — the specific relations are over-applied. And `refactor` was nearly cut for rarity until a code-biased sample showed the earlier audit had under-sampled the work where restructuring happens.

**One premise this effort corrected mid-flight.** The note tool does not refuse `undone` sidechain rows; the status filter only excludes them from the owed ledger. The "gap" this spec was originally going to close did not exist, and G4 settles the question the other way.
