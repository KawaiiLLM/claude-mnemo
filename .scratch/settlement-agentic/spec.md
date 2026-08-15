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

**A2.** **Window-level** atomicity is given up deliberately. A crashed or abandoned window may leave a partially reviewed batch. Per-call atomicity is **not** given up: each individual tool call stays one transaction over its body, its derived edges and its status. The rule that replaces window atomicity: **a partially reviewed window must not be marked complete.** Job completion gates on a coverage check, not on the agent stopping.

**A2a.** The current failure policy is not eventual convergence and the spec must not imply it is. After three attempts the cursor steps past a terminally failed window, which is "keep the partial result and abandon the remainder". If that remains policy under incremental writes it becomes more consequential, because the partial result is now durable rather than rolled back — so a partial window needs a named audit surface: which windows ended partial, and what a repair pass would have to redo.

**A3.** The write tools are two: the unified note tool (a turn's note and facts) and a segment tool (create or extend, members, type, tags, body). There is **no edge tool** — an edge is always asserted by some turn, segment or session, so it exists as a field on those calls rather than as a free-standing write. There is **no session-summary tool for settlement** — see D1.

**A4.** The settlement agent reuses the main agent's mnemo injection **interface**, not a copy of its content. This requires extracting a single assembly entry point that both the SessionStart hook and the settlement agent call. The reason is maintenance: managing the main agent's injected context must not require a second, divergent edit for the subagent.

**A5.** The settlement context renders window turns through recall's collapsed view rather than a private renderer, so that a later redesign of recall does not need mirroring here.

**A6.** Duties remain in three ordered steps — review every turn's grade, type and tags; backfill notes for turns that have none; then assign segment membership. The order is load-bearing: a segment's type is the union of its members' activities, which is vacuous while the members have none.

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

**B6.** Turn `tags` are bare topic words. The `topic:` namespace prefix is **not** applied; existing prefixed rows are left alone rather than migrated. Session-arc role words (`correction`, `blocked`, `deferred`) are not turn tags: `correction` becomes a `type`, and status words stay out of the function vocabulary.

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

**C5.** **Every edge originates from a citation in some body.** A bare `[S/T]` reference in a note, segment or session field creates an **unattributed** edge. Relations are attributes added to those edges, carried on named fields of the write call — not a generic `{turn, relation}` list, because with four values a named field makes an illegal relation unrepresentable.

**C6.** **A relation field may only name a turn the body also cites.** The field says which kind; the prose says why. A relation asserted without an argument in the body is rejected. This is what structurally kills the spurious-edge class: those edges are minted from outside any body, so there is no prose to check them against.

**C7.** Settlement **may attribute or correct an existing edge; it may never mint one.** Evidence: the audited spurious edge is settlement-only, and settlement mints `supersedes` at 11.6% of its edges against the main agent's 7.2% — over-reaching on the most consequential relation from the weakest vantage, having never seen the work happen.

**C8.** `citing_kind` gains `session`, so session fields can carry citations.

**C9.** Mechanically created segment-anchor edges carry **no relation**. Stamping `builds-on` on them was tautology: a segment is definitionally an aggregation of its members.

**C10.** Edge provenance must distinguish its three sources — the main agent's own assertion, a bare textual reference, and a settlement attribution. The current provenance column conflates the first and third.

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

**D6.** The session write path needs the omit-versus-clear distinction the turn path already has: absent means leave alone, explicit null means clear. Today's upsert coalesces, so "this field no longer applies" is inexpressible.

**D7.** Budgets are **guidance values reported in the receipt, never truncation**. Two concerns that are currently one constant must separate: a write-side signal to the author, and an injection-side cap that becomes a rarely-hit backstop once the signal exists.

**D8.** An accumulating field's receipt reports the field's **total after the write**, not the delta. A writer adding 50 tokens at a time otherwise reaches 1000 without noticing.

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

**G2.** Two layers with different trust: the **Stop hook blocks and lists the gaps** — at most twice, to avoid a loop — because it trusts the agent to fill them; the **job-completion gate re-checks independently** and leaves the job claimed when it fails, because it trusts nobody.

**G3.** A skipped turn needs no review verdict; skip is itself a verdict and counts as covered.

**G4.** The eligible set is the window's turns minus compact markers and minus slash commands that need no model reply. **Sidechain rows are eligible** — they are legitimate turns.

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

**G7.** The completion gate must **prove segmentation ran**. Checking empty fields cannot: a window whose per-turn fields are all written but which crashed before the segment tool has no empty fields, so a retry sees nothing owed and marks it done, permanently unsegmented. A non-empty `type` is evidence the first duty completed, never the third. This needs either a persisted per-phase disposition on the job, or a per-turn verdict recording that the turn was assigned to a segment or deliberately left out.

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

**Seam 2 — the coverage check as a pure function.** Database in, gap list out. Tested here: an empty field producing a gap; a skipped turn counting as covered; compact markers and reply-less slash commands excluded; sidechain rows included. Keeping this a pure function is what lets the Stop hook and the job-completion gate share one implementation while trusting it differently.

**Not tested: the SDK agent loop.** Driving a fake query through the full settlement conversation would add a third, brittle seam to assert behaviour the two seams above already cover. Judgement quality — whether the agent's grades and relations are *good* — is offline-evaluation territory, not unit-test territory.

## Out of Scope

- **Memory reading and rendering.** The recall and timeline redesign is a separate effort. In particular: whether relations should be surfaced in any view, how a skipped turn should appear, and how a turn with no note but real raw material should render.
- **Migration of existing rows.** Existing `topic:`-prefixed tags, retired-vocabulary type values, and the four-value relations already stored are left as they are. New writes follow this spec; a re-labelling pass over history is a later decision.
- **The spurious-edge problem beyond moving edge creation.** Measured at 1.5-7.7% depending on the pool, its cause is a judge misled by temporal adjacency in a multi-threaded session. C5-C7 remove the mechanism that lets it happen; a scoping fix at context-construction time is not attempted here.
- **Collapsing the effective-grade layer into the stored grade.** Only the edge terms come out (H1). The layer still answers for the 67% of turns with no stored grade, and pre-cutoff turns are scored through a type→grade map rather than their stored value; a collapse must define both contracts first, and bundling that with the edge decoupling would mix a behaviour change into a structural one.
- **A `duplicates` relation.** Real but measured at 0.8%, below the bar.
- **A twelfth type word for capability removal.** Absorbed into `refactor` by B3's arithmetic framing.
- **Making the budget signal effective.** Advisory budgets demonstrably do not bind — 23 of ~24 notes in the originating session ran 1.6-2.3× over, with no convergence. Whether the receipt should report a *consequence* rather than a ratio is deferred.

## Further Notes

**Every decision above that cites a number was measured on the production corpus, read-only.** Where a subagent produced the figure, it was recomputed from a persisted per-row file before being accepted; two of those recomputations changed the conclusion.

**Two hypotheses this effort refuted, recorded so they are not re-proposed.** `builds-on` was suspected of being a default bucket like the retired `change` type slot; it has the *highest* precision of the four relations, and the confusion runs the other way — the specific relations are over-applied. And `refactor` was nearly cut for rarity until a code-biased sample showed the earlier audit had under-sampled the work where restructuring happens.

**One premise this effort corrected mid-flight.** The note tool does not refuse `undone` sidechain rows; the status filter only excludes them from the owed ledger. The "gap" this spec was originally going to close did not exist, and G4 settles the question the other way.
