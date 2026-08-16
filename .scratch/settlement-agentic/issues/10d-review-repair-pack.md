# 10d — The third review pass, repaired

**What to build:** Eleven findings against 10a and 10b, three of them able to stop a window dead, plus the two design gaps they exposed.

**Blocked by:** 10b

**Status:** ready-for-agent

Read spec **A7 and A7a** first. A7a is new and it is the answer to findings 4 and 5.

## The three that stop a window dead

- [ ] **Frozen relation eligibility can resurrect a deleted pair.** `eligibleRelationPairKeys` is snapshotted before the model run and passed straight to `writeMemoryEdges` at commit. Sequence: T2's body cites T1 at snapshot time; settlement stages `dependsOn(T1)`; before commit the main agent rewrites T2's body and `reconcileCitedPairs` deletes T2→T1; commit accepts the frozen key and recreates a relation-only pair whose body no longer cites it, violating C6. **Commit-time eligibility is the frozen set INTERSECTED with the current state** — the freeze prevents a run self-licensing its own new pairs, the current state prevents resurrection. Both constraints, not either.

- [ ] **The segment tool's model-facing field names do not match its schema, and every create is unreachable.** The prompt and tool description say `no_candidate_reason` and `topic_aliases`; the strict shape declares `noCandidateReason` and `topicAliases`. The SDK strips unknown keys, so the model's field vanishes, the evaluator sees `undefined`, and refuses — **with an error message that also names `no_candidate_reason`**, so a model correcting itself from the error text cannot escape. Pick one spelling and make prompt, description, schema and error message agree.

- [ ] **A legal "belongs to no segment" verdict has no path.** The completion gate requires membership, an exclusion, or `skipped`; `recordNoteSettlementSegmentExclusion` has no production caller; the segment tool has only `create` and `extend`. A window holding one legitimately unsegmented turn cannot complete — the agent must fabricate a segment or abandon the window. **`segment` gains `action: "exclude"`** (spec A7a), writing the job-scoped exclusion.

## The design gap findings 4 and 5 share

- [ ] **Staged entries are keyed, and re-staging a key replaces it** (spec A7a). Turn notes key on the turn address; `segment` create on a **model-named handle**; `extend` on the segment id; `exclude` on the turn address. A retry becomes idempotent and a same-run correction becomes one call. Create handles change from server-issued to model-named — that is what makes a retry recognisable as one.

- [ ] The refusal receipt distinguishes a **gate gap** (stage more, commit again) from a **replay conflict** (this run is unrecoverable, a fresh dispatch is required). The current text tells the model to do the impossible.

## The rest

- [ ] Segment body citations are validated at **stage** time, not only at apply — A7 promises a real receipt while the agent can still act on it, and today an unresolvable `[S999/T1]` stages clean and is silently dropped at commit
- [ ] `E#n` handling is confined to the `[E#n]` citation token. Today `/E#(\d+)/g` rewrites prose — "the error code E#1 was observed" becomes "the error code E42 was observed" — and rejects an ordinary `E#2024`
- [ ] Settlement cannot write the retired `topic:` tag namespace. `mcp/note.ts` strips it and the retiring write-back stripped it; the facade passes tags raw, so a staged `["topic:lease"]` replaces `["lease"]` and revives the namespace
- [ ] The prompt and tool description stop claiming the extend exposure gate, which was removed (6b3692d). The model is currently told not to extend a segment the backend would accept
- [ ] The handle guidance stops advertising operations the facade rejects — handles are body-citation references only; they are not members and not `extend` targets
- [ ] `status` on `create` is either honoured or refused, not accepted and ignored
- [ ] Full suite green

## Test gaps named by the review, each a false pass

- [ ] The "no live writes before commit" and gate-rollback tests count `shadow_notes`, `segments`, `members` and `memory_edges` but not `topics`, and the fixture creates no topic — so a topic written at stage time would go unnoticed
- [ ] The relation revalidation test replaces the frozen `Set` but never deletes the database pair, which is why it cannot catch the first finding above. It must delete the pair and run a real commit
- [ ] The exclusion tests call `recordNoteSettlementSegmentExclusion` directly, which is what hid the third finding: no test ever asked whether a model could reach it
