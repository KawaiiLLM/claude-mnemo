### D001
title: Scene-compiler 6-step design and 15-verb global tool schema specified
content: Answered the scene-compilation gap from [REF]: defined 6-step seed→spec compilation (venue instantiation, dilemma routing with ≥2 divergent axis-mapped paths, tool binding, anchor-table closure, opponent spec, termination) plus code-lint + degeneracy-probe gates; and the 15-verb global tool registry (3-part params: target/style/slot, all enumerated except say.content) with 3-tier engine adjudication (predicate check → anchor lookup → improvisation, never seeing numeric magnitudes).
insight: - axis honesty check: an axis can only be declared "measured" if the scene has ≥2 divergent paths mapping to its poles - engine adjudication must never see numeric magnitudes to prevent it doing fake arithmetic instead of judgment

### D002
title: Designed multi-turn function-call runner variant for empirical cost comparison
content: Dispatched an Opus worker to build `rollout/runner_mt.py`, a new multi-turn function-call-format runner reusing existing mechanics/adjudication but replacing the per-turn full-panel prompt with turn-1-panel + tool_results + history, logging per-turn API usage (input/output/cache). Purpose: empirically settle the Markov-vs-multi-turn context-cost question raised in [REF] with measured token curves instead of estimates, without touching the in-flight card experiment [REF].
insight: - built new file rather than modifying in-flight runner.py to avoid corrupting concurrent experiment - staged smoke-test-first, then formal comparison batch, to avoid endpoint contention with concurrent worker

### D003
title: Committed pipeline v0; refined axis hypothesis to binary closure behavior; card scope narrowed
content: Committed accumulated action-roleplay changes (99836f8, registry/rollout/scenes, runs/ gitignored). Changed `project_card` to inject only personality-traits+behavior-axes (as "偏X" lines) + speech style, dropping experiences/relationships/works from the actor prompt — dry-run exposed that v3.2 cards lack 严谨↔灵活 entirely, so dispatched v3.3 recast for 祥子/唯. Refined 严谨↔灵活's action-layer test hypothesis (per user) from speed-differential [REF] to binary closure behavior: flexible pole may skip container closeout entirely rather than just closing slower — queued as Batch D once v3.3 cards + multi-turn comparison batch both return.
insight: - card projection scope (traits+axes only, no backstory) matters for what the actor prompt actually conveys - discovered v3.2 cards structurally lack axes introduced only in v3.3 — recast needed before axis-specific tests

### D004
title: Finalized 4-tier axis registry by coverage×balance×splitting-power
content: Re-ranked the axis registry [REF] by coverage×bipolar-balance×incremental-splitting-power (not just embodied signature, since axes may serve other downstream uses too) into 4 tiers, all grounded in the 30-card sample: Tier 1 core (firm↔gentle 17/30, expressiveness 16/30 the most balanced, considerate↔self-centered 14/30, extraversion-merge ~12/30 combining active+social-approach). Tier 2 splitting-power axes worth keeping despite mid coverage — demonstrated by concrete examples where a tier-1-tied pair gets split: forthright↔facade separates 蓝染/英梨梨 who tie on firm↔gentle; emotional-stability↔prone-to-breakdown separates 老仓育/蓝染 who tie on firm
insight: 

### D005
title: User ruled the rubric goes English, concise and pragmatic; §Relations translated as rev 4
content: The rubric is agent-facing instruction text, so English is the pragmatic voice. Rev 4 translates §Relations with content identical to rev 3 — both peer-review fixes preserved. Raised the scope question: v5 is a hybrid (English Fields prose, Chinese type vocabulary, Segments and Policy) — whole-document translation for one voice versus minimal-change section-only, recommending whole with careful per-line fidelity against the battle-tuned Chinese phrasings.
insight: 

### D006
title: Locked actor toolset: say/act/move/wait + recall, with 4 criteria
content: Deferred [REF]'s cognitive-gating fix to define the actor toolset first. Set 4 selection criteria (orthogonal, work-independent, renderable, has-an-answer-source); locked toolset: say/act/move/wait (action) + recall (query, card-provided, cursor+cognitive-filtered). Rejected use/ability (雪乃's abilities are useless static traits, and work-specific in power-based works — the reason 禁书 was dropped), give/take (indistinguishable from act), observe (no answer source — director has no environment tool). Open decision flagged: recall vs full-card-injection into system prompt — recommends splitting (identity+baseline in system, experience/relations v
insight: 

### D007
title: Peer's only cross-review round returns not-ready with 8 P1 + 9 P2; the repair campaign opens as three territory tickets
content: Verdict accepted in full — every finding real. Rulings landed here: E5 anchors move to the edge-owning citer (extra sink anchors itself, extra source anchors the earliest citing side), matching E1/E2/E4's anchor-equals-repair-power construction; my authored prompt text hand-fixed for P1-4/P1-5/P2-5 (coverage adds title+insight because explicit recall fields REPLACE the defaults; exit only after one successful commit, refusals never count; verifies/refutes routing before generic extends). Campaign structure: RA (projection seed, E5 anchors, render caps, token collision) parallel with RB (grant semantics: delivery-envelope-atomic grants, sequen
insight: 

### D008
title: Resolved card-scene compatibility: slot preconditions, stratified sampling
content: Resolved card-scene compatibility into 3 cases: (1) hard conflicts (scene presupposes e.g. family-member/employed-here) — scenes must declare a minimal slot-precondition field (≤3 conditions), machine-filtered; good news: projection-pruning already removes most such conflicts since age/era/backstory facts aren't in the pruned card, only scene-side assertions exist. Added a schema fix: stance targets generalize from named individuals to categories (stranger/authority/intimate-person), so cross-source scenes can still trigger stance-based behavior (e.g. 雪乃's stance toward 八幡 becomes "awkward toward someone close," triggerable anywhere). (2) Axi
insight: 

### D009
title: Receipt-trim ruled and dispatched; the seven relations explained from the live graph
content: User green-lit the four cuts — ticket 02 pins echo-on-divergence: writer_model only when recorded, ride_turn only when unknown or diverging, type/tags only when normalization changed the value, and the over-1.5x warning keeps its protected every-call firing with compressed wording; the shared formatBudgetWarning reaches note.ts and the settlement facade in one change. Relations guide delivered with live examples; the window's distribution reads as ecology: depends-on 53 the procedural spine, encodes 27 the ritual channel, refines 24 the design arc, grounded-on 8 rare but load-bearing, override and the evidence pair at 1 each — strict discrimi
insight: 

### D010
title: The ground/consume/extend overlap is in their scope clauses, not the words
content: With one mandatory tag per side, 弧头 == 弧尾 already encodes same-versus-cross lane, so a word distinguished from another ONLY by scope carries zero bits — ground-同 lane versus consume-非同 lane is exactly that pair, and the word is derivable from the tags. Deleting the scope clauses makes all three non-overlapping again on genuinely different reader instructions: extend grows the same claim, ground builds a different claim that falls with it, consume uses the output without vouching. Measured support: `grounds` has 119 untagged and ZERO tagged instances (v11 forbade it), so v12's ground-同 lane has no precedent at all, while `consume` — the only w
insight: A relation word whose meaning is recoverable from its own metadata is redundant by construction — check what the word adds beyond the fields the edge already carries.

### D011
title: User cut the checker to four reports over a turn range or named lanes
content: Final shape: (1) per-lane basic stats; (2) member component count within the segment-global graph, 1 healthy — principle 1; (3) whether one component holds several lanes — principle 2; (4) start-to-terminus path counts, same-phase and with cross-phase citations folded (two citing lanes viewed as one) — few is the NEW minimality definition. The peer round's fact/question typing, 2KB budgets and finding-identity machinery lapse as unnecessary at this shape; kept as one-liners: read-only, never candidate edges, findings enter settlement's existing judgment, partial coverage declared. Defaults set: multi-start sums, undeclared lanes skip report 4
insight: 

### D012
title: User re-split the note fields: title is the index, content carries every useful decision
content: Rests on [REF]: title stops being the conclusion and becomes one sentence saying what the turn is doing, while content must hold all the decisions the turn produced. Measured the edge system as the alternative recovery path and found it insufficient for this job — T919 has exactly one incoming edge and no outgoing ones, though that single neighbour's title happens to name the pageBudget ruling T919's own title dropped. 503 of this session's 1072 turns carry an incoming edge. Edges aid navigation between related turns, not the scanning problem, since an antecedent line renders a bare address. Surfaced the conflict this creates with content's 1
insight: 

### D013
title: Resolved usefulness criterion: positive-effect-only, deferred calibration
content: Resolved the 'confirmed' gap from [REF]: compliance alone doesn't count as usefulness, only demonstrated positive effect does; rather than pre-defining promotion/demotion thresholds, dream agent freely labels+counts each hit's judgment with an open vocabulary, and hard rules get calibrated post-launch from the count distribution. Schema implication: rule_events.kind becomes an open label with a mandatory reason string (audit trail for later calibration). Grilling continued to a second open question: whether rules need a project-scope field to prevent cross-project noise contaminating the very counts calibration depends on.
insight: 

### D014
title: Refined ChoiceScript probe: engine-generated choices, recognition≠construction
content: Refined [REF]'s ChoiceScript pick: use engine-LLM-generated choice points (domain-matched to Chinese anime cards, controllable separability) instead of the real English-IF corpus. Clarified 2 boundaries: this isn't a free lunch — it still needs dilemma-matrix/novel-skeleton seeding to avoid tension-free options (otherwise it's just the blog's pipeline with a multiple-choice skin), and choice is mere recognition (match card adjectives to option adjectives) while tool-calling is construction (choose tool, fill params, sequence) — a much shallower skill whose transfer validity to open tool-calling is uncertain. Reframed its role: a cheap necessa
insight: 

### D015
title: Confirmed say stays; decided toolset is per-card, not universal
content: User confirmed say stays [REF]. New decision: each character card maps to its own toolset rather than one universal toolset shared by all pets — acknowledges different embodiments (species/avatar) may have genuinely different physical capabilities (e.g. a bird can fly, a dog can't). Asked how per-turn state information should be defined; not resolved in this exchange, remains open for the next design step.
insight: 

### D016
title: Resolved four design questions raised by novel stress-test
content: Answered the open questions from [REF]: director may freely adapt beat/scene segmentation instead of following the original verbatim, actor backfills non-POV psychology using Moegirl wiki character cards, inner monologue joins the assistant message alongside the tool call, and tools are generated per-scene by the director rather than fixed globally. All decisions were written into the pipeline note.
insight: - Director owns beat segmentation, not the source text - Actor backfills unseen psychology from character cards - Inner monologue and tool call share one assistant turn

### D017
title: Lane identity collapses to a single tag under a segment, declared through remember
content: Three rulings, the first structural: a lane is ONE tag, not a tag set — which deletes the rubric's superset-branch and exact-set-reopen clauses outright. A tag may ride an edge only if its lane is declared, and only if both endpoint turns belong to a segment; otherwise the write is refused with a message. Declaration goes through `remember`, shaped like a segment's, with tags unique within a segment. The segment injection block gains a lane section rendered like the console's strip, minus the "无宣告" words (token waste) and plus the trailing latest-node index. The console work is closed ("前端就这样"). Measured for the migration: 63 distinct lane ta
insight: 

### D018
title: User adopted the two-stage click: panel first, undo only when the panel already sits on the node
content: Ruling: clicking a focused node whose panel is not open opens its panel (view stage); only clicking the node the panel already shows undoes the focus (undo stage) — resolving the browse-vs-undo conflict the literal reversibility reading created. Folded into the T1386 consolidated interaction model.
insight: 

### D019
title: User ruled the main agent never writes side tags, so it became a tool shape
content: The three documents had drifted into three readings — shared rubric "usually", settlement half "only relation words", tool permission "may". Ruled: never. Implemented as SHAPE rather than prompt copy: the main agent's `note` takes bare addresses only and the tagged entry form is removed outright, while settlement's facade takes the two-sided form. The payoff beyond consistency is that the main agent then needs no rules for looking up declared lanes, so the shared rubric does not have to carry that section at all — one fewer permission, one fewer chapter.</content>
insight: Enforce a division of labour in the tool's schema, not in its description — a shape cannot be misread, and removing the capability removes the documentation it would have required.

### D020
title: Decided: keep replay as raw-axis skill, add dream-agent in-process accessor
content: Recalled the original skill-vs-tool rationale for replay (raw axis, avoids re-mediating what recall/timeline already provide) and confirmed it still holds — this session's own forensics (line-pointer audit, transcript/response comparison [REF]) required arbitrary SQL that no fixed-schema tool could express. Decided the dig-in interface the rule ledger actually needs belongs not in replay/MCP but as a new in-process query module inside the dream-agent runtime (same-process DB access, no MCP indirection), returning prompt+transcript+observations per turn with built-in truncation. Also flagged two skill-doc fixes: add a schema cheat-sheet (promp
insight: 

### D021
title: Two lane_check contracts ruled: paging re-runs, and actionable is the writable set
content: Both were implementation-versus-its-own-promise, not design forks. Paging: two surfaces promised "not a re-run" while every page re-ran; ruled the implementation right, since settlement is check→repair→check and a frozen snapshot would keep showing rows already fixed. The accepted residual — a write between pages moves the boundaries — is made visible with "(re-run; counts are as of this call)" rather than removed. Scope: actionable filtered on windowTurnIds while the commit gate filters on writableTurnIds, so a lookback-anchored error was invisible by default and fatal at commit. The file already contradicted itself — a comment three lines a
insight: When a description and an implementation disagree, decide which one is right before touching either — and read the surrounding comments first: a file that states a principle and then violates it three lines later has already told you which side is the bug.

### D022
title: Analysing the weight and dash channels finds a collision and an impossible state
content: With weight meaning "has any attribution" and dash meaning "is internal", crossing edges and half-settled edges render IDENTICALLY — and the latter is E6, which blocks commit. "Thin plus solid" is also unreachable. Root cause: the two facts are not independent. Attribution completeness is an ORDERED axis, and internality is only meaningful once attribution is complete — a conditional fact forced into an independent channel produces both the collision and the impossible combination. Proposed a third dash value (dotted) for the half-settled case rather than a fifth visual variable, since colour, weight, dash and focus-dimming already occupy fou
insight: Before assigning two visual channels to two facts, check whether one fact is conditional on the other. A conditional encoded as independent yields unreachable combinations and, worse, collisions where two distinct states land on the same appearance.

### D023
title: Confirmed action space separates cards as a projection; defined Query's role
content: Confirmed the action space can separate character cards via trajectory-level distribution accumulation, not single-turn magnitude (ethology precedent: small behavior repertoires reliably measure stable personality axes) — but only as a projection: temperament (bold/shy, clingy/aloof, curious/lazy), stance toward owner/strangers, and habits project into the action space; dialogue wit, backstory, and values don't. This sets a concrete pruning criterion for the pending pet-card schema: only projectable fields are worth keeping, the rest is dead weight. Clarified free-text Query's 4 roles: bridges symbolic state (thirst:0.78) to pretrained langua
insight: 

### D024
title: User dissolved the lane-internal relation taxonomy: tag presence alone marks lane structure
content: Any same-phase edge (any word) may carry lane tags; tagged = lane-structural, untagged = free connection; same-tag edges compute minimality. Dissolves: the lane-internal word list, the consume→stance rewording of delivery chains (they stay consume, just tagged — the "acceptance extends dispatch" stretch dies), and the rev-3 special-casing of indexes. Derived for free: cross-phase words can never carry lane tags since lanes are phase-local. Component principle degenerates to near-definition (one tag = one connected subgraph, an integrity check). Open consequence flagged: tagged indexes inside a chained lane duplicates chain paths under minimal
insight: 

### D025
title: Corrected misread: policy plays real games as environments, not seed source
content: Corrected a misread of [REF]: the user meant games as environments the policy plays in directly, with play-decisions revealing character — not extracting game data as dilemma seeds. This makes the engine free (the game engine is a perfect zero-drift judge/state-holder, no LLM or rule-table needed) and dilemmas free (game design IS designed choice-conflict). New selection criteria: text-interfaceable, programmatically drivable (headless rollout), and style-space breadth — single-optimal-solution games (puzzles, pure survival) collapse all cards to the same greedy route; need multi-goal/multi-route games where personality shows as goal-weightin
insight: 

### D026
title: Tickets approved and published; ticket 01 landed by hand with the budget knife; ticket 02 dispatched
content: Five tickets published (04 re-edged to blocked-by-02 for territory integrity). Ticket 01 done: lane definition v2 and the three lane states written into the rubric — 9435/9500 rendered (65 spare), paid by five semantic-preserving compressions (Fields length paragraph, ruling supplement, segment examples, roster/create bullets, redundant phase-local tail); 103 guard+consumer tests green; a first-pass loss of the machine-knows-exact-sets sentence was caught by its pin and reinstated compactly — the guards earning their keep. relations-v10-en.md marked HISTORICAL (living text = memory-rubric.ts, stopping the line-by-line sync tax). Committed b25
insight: 

### D027
title: User ordered a live edge rebuild of T900–T1000: unbroken workflow chains plus expressiveness and election analyses
content: Supersedes the passive arms of [REF]: one agent rebuilds the real edges instead of simulating input graphs. Mid-turn refinements: the runner is the mnemo-review peer and every write goes through the note tool — validator in the loop, rejections become expressiveness data. Groundwork: memory_edges recon (PK = one relation per pair, provenance CHECK closed, 38 bare text-ref pairs already in the window), full edge-table backup, brief pinning the C7 riding idiom and the phase-legality table.
insight: 

### D028
title: Memory-console live-wiring spec published on the worker HTTP seam
content: Spec at .scratch/memory-console/spec.md. One seam: the worker's existing loopback Bun.serve gains GET /console + GET /api/console/* (sessions, segments, graph by session-range or segment, segment card, lane-check text), handlers as (db,url)→payload modules tested against :memory: fixtures. Decisions: shell ships as a bundle-embedded module constant (no runtime disk reads — path-drift lesson), server-side lane derivation through the shared interpretation core with a single-source pin (graph payload states must equal lane_check report 1 for the same scope), election tier preview via the landed pure module, range/excerpt caps clamped not errored
insight: 

### D029
title: Set character-sourcing rules and kill-gate validity requirements
content: Established character-sourcing for seed-to-scene adaptation: actor slot draws from the 1423 distilled cards (projection-pruned, matching the deployment format — not blog-style scene-scoped mini-personas, which would mismatch train/deploy input distribution); opponent slot stays fixed to the scene's native character (not swapped, holding the kill-gate to one variable), played by engine with an explicit hold-the-line instruction [REF]. Hard rule: dilemma constraints must live in the scene, never parasitic on character knowledge (rewrite "character doesn't know X" into "world doesn't provide X" — matches drives being engine-owned not card-owned 
insight: 

### D030
title: Refused to use leaked Claude Code source as harness reference
content: User pointed to a local directory containing an apparent leaked/unminified Claude Code TypeScript source (exposed via npm sourcemap). Declined to read or use it as reference for [REF]'s harness design on provenance/trust grounds (leaked proprietary code, unverifiable mirror), advised deleting the directory, and reaffirmed the sanctioned reference set (behavioral observation of cc, OpenCode data model, pi module grain, Ball's tutorial).
insight: 
