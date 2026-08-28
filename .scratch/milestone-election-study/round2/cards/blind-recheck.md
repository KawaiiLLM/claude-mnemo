### X001
title: User ruled version-iteration nodes must be elected, which retracted my override gate
content: The gate I proposed ("no incoming override") excluded T55 (v6 card design) and T454 (v3.5 registry) — both version landings. Retracted on two grounds: it contradicts standing rubric law ("被 override 的节点依然有效"), and version progression means every version node is overridden by its successor, so the gate systematically deletes all but the last version — the STRICT problem at a smaller scale. Candidate set returns to 40. Then measured the wider gap: 31 version-landing turns in E70, of which 6 are declarers, 13 are cited nodes (tier ③), and 12 appear nowhere. Flagged that a bulk fix is wrong — the user's own granularity rule kills T477 (a single r
insight: A filter that looks like quality control can be structural deletion in disguise: check what class of node it removes systematically, not just how many. "Superseded by the next version" describes every version but the last.

### X002
title: hands slot and take rename delegated after judgment
content: User ruled 双手→空闲手 (「双手：1」 reads as anatomy, not free-hand count) and asked judgment on grab→take; I endorsed take (neutral IF-canonical acquisition verb, grab's snatch connotation tints actor narration, marginal cost ~0 since goldens re-anchor together) and delegated both renames to a Sonnet worker with the mechanic-vs-prose discrimination rule (slot-name references change; natural prose like 双手都占着 stays). Worker delivered: 806 green, greps clean (1 historical note, 2 legitimate prose hits), goldens re-anchored with diffs confined to the two tokens, plus one alphabetical-order fix in a hardcoded verb list my brief missed; flagged registry/too
insight: 

### X003
title: Resumed the stalled worker rather than replacing it, because only it knew which half-finished edits were its own
content: Worker C died on an API stall after gutting `lane-interpretation.ts` (-152) and editing the rubric — leaving the shared tree non-compiling for two live siblings. Chose resume over a fresh worker on one argument: a replacement opening this tree cannot tell C's half-done deletion from a sibling's work or from its own intended change, and C's transcript holds that answer. Sent it the exact `git diff --stat` of its own territory, told it to re-derive from `git diff` rather than assume its last intention landed, and explicitly forbade `git restore` to reach a clean base — A had ~350 uncommitted lines in the same tree.
insight: When a worker dies mid-edit, the deciding question for resume-vs-replace is not transcript cost but whether anyone else could attribute the partial changes — a replacement inherits the mess without the map.

### X004
title: All 5 harness tickets complete; base verified end-to-end on live endpoint
content: Verified ticket 05 (final ticket) [REF][REF]: 35/35 tests pass, live_smoke_mini_payload.py ran 3 real-endpoint turns (broken JSON→hook-injected error→Update fix→clean pass), audit trail (turns.jsonl/session.json/per-turn request-response) replayable and confirmed no key leakage, README covers 4-step usage. Committed 3301179. All 5 tracer-bullet tickets [REF][REF] now done — action-roleplay harness base (client/executors/tool_contracts/tool_loop/audit, 35 tests, 6 commits) is complete and ready for business assembly (distillation loop migration or 100-card batch).
insight: 

### X005
title: user pinpointed reaction gap as ruling deviation; loop fix delegated
content: User corrected my 单拍契约 framing: the original ruling was 「一旦 cue 了其他人就结束本轮行动」+「只有 idle 才正常结束」— the taster's inspect targeted an object, cued no one, so his opportunity should have CONTINUED; the single-sample settle is an implementation deviation, not a model boundary. Spawned an Opus offload-worker (window exhausted) with pinned semantics: continuation loop within one dequeue slot (say/idle close; world verbs and express continue), four queue pins unchanged, _REACTION_CONTINUES=6 runaway cap with loud fault, ≥5 tests including the taster replay, golden zero-diff requirement.
insight: 

### X006
title: measure+source-loss: axis evidence is doubly projected, skew quantified
content: User asked whether the extracted source text already lost axis-relevant features. Answer: three nested layers. Extraction layer happened once and was fixed (whitelist dropped 轶事/黑幕 → v9 blacklist full text); residual template/table rendering loss is mechanically auditable. Source layer measured from scores54_v73.jsonl: q citation median length only 10-16 chars, and sampled q are editor trait conclusions (有着唯我独尊、旁若无人的性格) rather than behavior events — the axis pipeline often cites someone else's lossy projection, so behavior→axes is projected twice. Distribution skew: 迎合↔自我 81% rated 自我, 探索↔守旧 70% H; recording bias vs true population is undecid
insight: When scoring traits from a wiki, much of the cited evidence is already an editor's abstraction, not primary behavior — the measurement partly reflects the summarizer's adjective choices. Detect it cheaply: evidence quotes without verbs or scene context are con

### X007
title: implement+verify per-model effort split; luna-max engine aces machine path
content: User ruling landed: effort injected per model — EffortClient now takes {model: effort} map resolved per create() call (luna max / terra xhigh probed OK; unmapped models uninjected; same-model conflicting flags SystemExit). CLI: --effort (actor) + --engine-effort (engine/opponents). 679 green. Smoke (terra-xhigh actor + luna-max engine): 乐奈 walked the machine path — the previously untested heavy adjudication chain — luna max handled inspect transcription (with 连投=0 slot transparency), timed-play hit, coins 5→4, satiety 8, and cleared the tray (取物口已空) where terra had left a ghost corn. 0 failures/heals. Remaining warts: luna slow (90-123s vs te
insight: 

### X008
title: free-text target assessed; enum死后英文id无出现处
content: Assessed user's free-text-target-with-strict-English-id-match proposal: viable but ids' only visible source IS the enum (state/event faces are all zh display names), so strict English match would reject translation guesses. Offered (a) static id roster in system prompt (recommended) vs (b) strict zh display-name match (precedent: work custom tool free text, model wrote 今日鲜鱼 successfully; needs zh-uniqueness audit). Extra gain either way: per-verb enums leak metagame info (work's dropdown reveals exactly which entities are cookable). Fix scope honest: kills machine-contract lie + meta leak, not the panorama prose source. Also resolves pending 
insight: 

### X009
title: review+basis-landing: Opus delivery verified, both poles relaunched
content: Independently re-ran pytest (698 green, +9) and read the phantom regression test body before accepting the Opus worker's basis-anchoring delivery. Notable deviations accepted: basis travels as digit string because the frozen tool registry rejects union types; failed-anchor pushback has no unwrite, so a stuck engine now aborts the episode loudly (expect nonzero abort rate in production); phantom attempts land in engine_write_failures, making that meta field the detector for the failure mode it previously missed. Relaunched 爽世+若麦 in parallel with .card.json to test anchoring and persona injection together.
insight: 

### X010
title: design+dispatch: Opus worker on basis anchoring, v74 card schema fixed
content: Dispatched an Opus offload-worker to implement engine anchoring: required basis (settle-list index or "time") on update_entity/update_character, four rejection classes (missing/out-of-range/say-express-idle/time-on-slot-writes), batch-end rejection of writes anchored to ok=False actions, tests reproducing the say-only phantom write; spec docs and scenes explicitly out of scope. Card side settled with user: v74 schema = identity + personality + speech (actor-visible) + axes as v73 source-grounded metadata with quotes; the blind probe's axis scores are throwaway QC directions never stored in the card, so no loss of experience-citing evidence; i
insight: 

### X011
title: Analysing the weight and dash channels finds a collision and an impossible state
content: With weight meaning "has any attribution" and dash meaning "is internal", crossing edges and half-settled edges render IDENTICALLY — and the latter is E6, which blocks commit. "Thin plus solid" is also unreachable. Root cause: the two facts are not independent. Attribution completeness is an ORDERED axis, and internality is only meaningful once attribution is complete — a conditional fact forced into an independent channel produces both the collision and the impossible combination. Proposed a third dash value (dotted) for the half-settled case rather than a fifth visual variable, since colour, weight, dash and focus-dimming already occupy fou
insight: Before assigning two visual channels to two facts, check whether one fact is conditional on the other. A conditional encoded as independent yields unreachable combinations and, worse, collisions where two distinct states land on the same appearance.

### X012
title: ep01 transcript audit surfaces four issues
content: Read 祥子 ep01 messages.json end-to-end. Actor side flawless (in-register monologue, efficient path). Issues: (1) three wasted batches 10:00-10:30 — dish on handoff + verbal 知会 at 09:50 met the tasting rule's acceptance form yet taster idled on his cue; hero had to grab the dish back and hand-deliver before he tasted; I attributed it to goal wording (端到面前) vs rule (two acceptance forms) mismatch. (2) Engine narrates clock advancement every batch (「叙事时钟由X推进至Y」) duplicating the 【时刻】 header with a one-batch stamp lag — [time] rule's 「引擎按批报时」 v1 residue. (3) 你你 double-prefix confirmed live (fixed post-run). (4) Self-view drift: held item renders 「定
insight: 

### X013
title: Chapter-2 example judged too jargon-priced for outside readers; T1870 proposed as the universal swap
content: Verdict: T823/T824 (and alternates T70/T121/T284, fetched and checked) all need the reader to know the RP harness first; T824's content is a literal "xxx" placeholder. Recommended swapping in T1870 (the 30-seat provenance note): universal engineering material (pagination default silently promoted to a semantic cap), and the incident IS the chapter's thesis performed — docs answer "30", conversation answers "you never ruled it". Rendered replacement block drafted in-reply for the user to judge.
insight: 

### X014
title: Ticket 08 verified with a validator-bypass mutation and the batch closes with docs at 504adc9
content: Worker ε's four-field settlement correction landed as 2e518fd after 211/211 named re-checks and my independent mutation — skipping validateRelationTarget's illegal verdict turned exactly the settlement-path illegal-phase test red, proving the one-validator-two-paths pin is test-enforced (chosen because the sandbox blocked ε's own attempt to demo the domain-check mutation). Ticket 10 done inline (high context coupling): CONTEXT.md gains Settlement=re-check pass, Election retired, Addressing section (address-T vs ordinal-T), ops gloss; ADR-0004 amended — only the flagging half retires, citation floor stands; both specs marked implemented with t
insight: 

### X015
title: Clarified response vs transcript: self-refuted hypotheses live in transcript
content: Queried DB to distinguish assistant_response (final text block delivered to user) from assistant_transcript (all text blocks concatenated, including inter-tool narration). Found via S11231/T446 example that the most inductively valuable material — self-falsified hypotheses and reasoning ("实测证伪...") — often lives only in transcript, not response, refining the dig-in strategy from [REF] to prioritize transcript. Confirmed observations.tool_name covers all tool types including Skill/Agent/MCP calls, with the caveat that Agent dispatches only record prompt+summary, not the subagent's internal tool sequence.
insight: 

### X016
title: design+tickets: two specs cut into ten tickets in three territory groups
content: Cut both reconciled specs into ten tracer tickets: five blocker-free (edge vocabulary+validation, remember assign, note cadence backlog, session column retirement, settlement demolition), then election storage removal (after demolition stops the writes), scoring signals (after vocabulary), four-field correction (after vocabulary+assign primitive+emptied channel), session narrative (after demolition), docs closeout last. Key framing: definitions.ts is a four-way file-affinity hotspot handled by worker grouping, not fake blocking edges; release unblocks at 05+06 (the degraded-grading state loses its object); the view spec stays outside this bat
insight: 

### X017
title: E70's milestone election seats exactly one node — the turn that created the task
content: 604 turns of work elect T1025 ("User opens mnemo task E70"). Every identity tier is empty: no releases; all 4 lanes OPEN so none seats a terminus; nothing elected by index; no qualifying corrector — so it falls through to recency, and T1025 is three weeks newer than any other member. Cause is one number: `indexes` is 1 of 819 edges, and that single edge (T136→T121, rp-harness) is not its lane's latest member, so it closes nothing. Lane chains are thin too — behavior-axes renders 1 node for 167 members. Contrast: E60's milestone is dense only because releases carry its identity tier.
insight: An election with tiered identity signals degrades to its last tie-break when the signals are unpopulated — so a rich-looking algorithm can silently be sorting by recency alone. Check tier occupancy before trusting the ranking.

### X018
title: The overnight backfill is planned from the real settlement gaps, not from the stated start
content: The gaps are not where the instruction put them: S15069 has 1-200 and 485-1751 settled, so the hole is 201-484 — the requested start of 317 leaves 201-316 uncovered, and I ran the request as given rather than widening it. S15440 is settled only from 726, so 1-725 is its whole hole, 15 windows. Every target window is pre-era on both sessions, so all carry allow_pre_era. 18 windows, interleaved, one in flight at a time, driven by a detached script that reads the database read-only and writes only through POST /settle.
insight: An unattended overnight job must be able to restart what it depends on. The hard-exit timer watches the session registry, not the work queue, so a sleeping user means nothing respawns the worker unless the driver does it itself.

### X019
title: Closed final review round, published all 7 ready-for-agent tickets, archived to memory
content: Reviewed the third codex verification review of [REF]'s Rev 3 (9/15 prior findings closed, 6 partial, 0 unresolved, plus 1 new blocker + 5 new major from Rev 3's own text) and wrote spec Rev 4 closing all of them: job leasing with ascending-order claim and frozen cohort persistence, strict batch schema, rule exemption realigned to the rules subsystem's real S<session>/T<prompt> multi-evidence namespace, unit-cap termination rules with token-level title truncation, full-row disposition for promptId-collision retyping, and a high-water cursor for the project-drift repair. Published all 7 ready-for-agent tickets under .scratch/arc-spine-redesign
insight: - three codex review rounds converged a spec from 5→1→0 blockers before any code was written - archive empirical numbers to persistent memory before /tmp scratch artifacts are lost on restart

### X020
title: design+scene-compile: user pins the secondary-axis legality criterion
content: User ruling: secondary axes are allowed provided they do not conflict with the main axis — operationalized as not competing for the main axis's evidence surface and not changing the two poles' prices; under that constraint, more observable secondary axes are a diversity win. This unblocked the taster design: her 温暖↔冷淡 / 正经↔戏谑 evidence lives entirely in her own verdict-delivery style while the mechanical gate stays neutral to the cook's 探索↔守旧 routes.
insight: Secondary-axis legality in probe scenes reduces to two invariants: evidence-surface disjointness and pole-price invariance. Anything satisfying both can be added freely for diversity; anything violating either hijacks the construct (the M13-v1 collapse mode).

### X021
title: Tiered intervals, one reminder at a time, and a lane for this thread
content: All three approved: 20/60/120 tiers, a single reminder per call chosen high-tier first, and a `memory-guidance` lane (E60 #104). Spec written to `.scratch/memory-guidance/spec.md`. The spec's own centre is D3: the criterion travels WITH the reminder instead of being forwarded. The `constraints` reminder carries the three-way split — a lesson that holds again in this project goes to constraints, a ruling about this task to decisions, a lesson about one turn stays in that turn's insight and is not promoted. That split is the judgment the system currently gives nobody, and the timer is only the mechanism that makes it appear. D5 left open delibe
insight: 

### X022
title: fix+bullet-grammar: v9's trait-core formula adopted, adjective ban lifted
content: User still judged sol2 祥子 below the v9 benchmark. Deeper diagnosis: my anti-adjective rule produced a conditional-pattern monoculture — bullets gave only 在X会Y projections and never the generating dispositions (自尊心/组织力/中二夸张), and intensity words were flattened. v9's per-bullet formula is 特质核（带强度）＋表现谱＋成因＋双面从句 with thematic aggregation. Rewrote the round-1 spec to that grammar: trait words unbanned when source-backed and behavior-followed (only registry-style dimensional labels stay linted), five categories demoted to a coverage checklist, intensity-preservation clause, item budget 80→130 / total 700→800. Relaunched 祥子 as sol3.
insight: Banning trait adjectives in persona extraction overcorrects into behavior-pattern monoculture: conditional patterns are projections of dispositions, and without the named generator (pride, drive, grandiosity) an actor cannot improvise beyond the listed cases. 

### X023
title: Production trichotomy — engine never creates entities
content: Answered whether M13V3's produced food is engine-created: no — closed-world tree invariant (node set fixed at declaration; engine writes only desc/slot/position; node count = compile-time arithmetic bound underpinning balance audits). Production takes three forms by whether the product needs independent identity: (1) workpiece mode (M13V3): dish node = recipe+station, props=菜谱 (never consumed), slots=手上这一份 (reset on redo) — props/slots maps exactly onto recipe/workpiece; product never exists as a node (serve 自带端送 → handoff 交付品质); (2) pre-declared node + reparent (M10V2 prizes visible-in-machine, fiction-coherent, eating rewrites desc); (3) pr
insight: 

### X024
title: Severed-lane teaching lands as 6723743 and the ticket closes verified
content: Worker delivered inside block B with a registered .replace() amendment (needle chained after the previous amendment, not.toBe asserted); the no-new-gate pin is real — fixture renders components: 2 (SEVERED), commit with no stitch and no justification still reaches done; three mutations red-green including one that corrupts the SEVERED needle to prove the fixture genuinely severs. Suite 3909/0 (+1, the new test exactly). My spot-verification: commit on main, tree clean, wording present in the line-array region, both touched files 110/0. Boxes ticked per-item — no refusals to launder this time — and archived with the E70 edge ledger as 624b76e.
insight: 

### X025
title: 0.16.0 released and pushed: the lane model ships after round-5 repairs pass acceptance
content: Round-5 repair batch accepted: 8 probe keys healthy; two sampled mutations went red (fixpoint closure cut to a single pass → bridge-chain test red; retired-namespace detector made case-sensitive again → 2 named tests red) and reverted green; a third literal control byte (batch-A leftover `join("\x01")` in a test helper, rendered invisibly by the Read tool) escaped to ``; repairs committed 86be78a. Release: 7 version sites re-grepped and bumped, rebuilt, suite 2662/0 with the stale-bundle guard green, release commit 9ec5bff pushed (12 commits since 0.15.0). Not live until /plugin update + cold restart. Accepted worker judgment: the ownership 
insight: 

### X026
title: measure+sol-xhigh: in-session cache is tier-independent, high suffices
content: sol xhigh 祥子 v75: per-turn cache pattern identical to high (t1 cold, source block 12800 hit from t2, creation always 0) — the episode-side tier-dependent cache effect was about cross-session prefix routing, while extraction sessions are in-session continuations where reuse is mechanism-guaranteed regardless of effort. Quality: 19 items/933 chars vs high's 17/1041 with double the interval transitions (until_used 58 vs 21) — finer arc slicing, not better substance — for +25% cost ($1.45 vs $1.16) and a 656s main write. Recommended sol high for the 54-card batch, xhigh reserved for arc-heavy characters on demand.
insight: 

### X027
title: Opus blind readability audit of blog found 3 clarity issues; all fixed
content: Dispatched Opus blind readability review of blog draft §1-2 [REF]; found "reads to conclusion but not to evidence" — undefined teacher/student framing, self-contradictory "action space closed" claim, and tables missing denominator context. Applied all 16 fixes: added teacher/student bridge sentence, resolved the contradiction, annotated table denominators, converted the tennis-racket block to a 2-column table, standardized cross-references to section names.
insight: - Blind readability audit catches "understood conclusion but not evidence" gaps - Tables need explicit denominator context or readers distrust the %

### X028
title: reaction queue landed per four pins, 802 green
content: Implemented the user's pinned queue: seed = protagonist-step triggers (unchanged channels), each pop = one single-sampling reaction (zero-call still bounced by cue()'s existing gate — user mid-turn corrected point 4: bare end_turn stays illegal, idle is the legal decline), reaction transitions + say targets (settle now returns them; commit's return was previously discarded) cascade to not-yet-inserted characters; once-per-step insertion, pop cap _REACTION_POPS=3, reset per step; reaction cueing the protagonist (named/reparented-onto/slot-written) flushes the queue, protagonist's own step effects exempt. Clock untouched. Five tests: cascade, o
insight: 

### X029
title: 0.15.0 released and pushed: the indexes vocabulary and the law-8 node set ship
content: Seven version sites bumped after grep enumeration; suite 2508/2508 with the stale-bundle guard green; commit 96c0772, 12 commits since 0.14.0, pushed. Not live until /plugin update + cold restart — the reload runs the collects→indexes rename migration (rehearsed twice: 18 renamed, 3073 preserved, integrity ok) and installs rubric v9.
insight: 

### X030
title: 爱音 M13V3 live episode launched in background
content: User asked to try 爱音: exact card name resolved to 千早爱音 in scores_v75.jsonl, launched M13V3 live episode via run_live.py in background (first application of the new background-run directive; first attempt died because Bash cwd had drifted into a runs/ dir from an earlier cd — absolute paths matter with persistent cwd). Watch axes: 探索↔守旧 fork choice and whether she asks the taster (迎合 signal). Result lands next turn.
insight: 

### X031
title: Released 0.8.4, pushed to origin/main; arc-spine-redesign shipped
content: Bumped all 6 version sites (package.json, marketplace.json x2, plugin.json, diary-sdk-query.ts constant, release-artifacts test guard) from 0.8.3→0.8.4, rebuilt, verified zero remaining 0.8.3 references, 1411/0 tests pass, committed (669f2b9) and pushed to origin/main. Ships all 7 arc-spine-redesign tickets [REF] in one release: cites edge table, capture repairs, effGrade selection, extraction calibration, unified renderer, injection swap, two-phase settlement. CHANGELOG untouched (only records destructive migrations needing manual data wipe). Not yet live — worker is a resident process needing /plugin update + cold restart, which will run th
insight: - CHANGELOG.md only records breaking changes requiring manual data wipe, not every release - resident worker process requires /plugin update + cold restart before a release takes effect, even after push

### X032
title: User caught an implementation that deleted a capability its own cited ruling said to retain
content: Recalled T1651 rather than arguing from memory: its text says 「工具上保留这些能力」 and the turn's note recorded "the tools keep their capabilities while the descriptions teach only the common path". `note.ts` cites that ruling as authority for stripping the seven relation params. Filed .scratch/main-agent-edge-capability/ (restore params, description still teaches the common path, rubric NOT re-widened, every gate kept) and .scratch/lane-state-retirement/ (spec + 2 tickets; tier-② within-tier key marked OPEN and explicitly not to be implemented). Fixed a hole in my own ticket: "leave tier ② visibly broken" is impossible when tsc must be clean — change
insight: Narrowing guidance and removing capability produce identical-looking diffs and are opposite decisions — when a change cites a ruling, read the ruling's own words before trusting the citation.

### X033
title: ingredient model ruled — recipe zero engine copies, product movable
content: User ruled the dish nodes are raw materials, not recipes: recipe lives ONLY in the keeper's persona/goal, engine manages nothing (no 门道 prop) and 「看老师傅回答就行」; the finished dish = the material's state-change result, hence movable (serve repositions the node — the engine's earlier 「越权」 reposition was the right instinct against my workpiece model). I first added a cast-dossier section to engine system (omniscient reading of personas); user interrupted: 引擎不需要知道 persona — reverted. Coherent completion implemented: engine = physics + bookkeeping (renders 手法 consequences honestly, no correctness judgment, no knack knowledge), keeper = knowledge sourc
insight: 

### X034
title: User ruled settlement grants era eligibility rather than reworking the cutoff or exempting one segment
content: Three options put up: (1) key the gate on annotation time, (2) settlement advances a turn's era eligibility when it settles it, (3) exempt E70. User chose 2 — the grant is issued by the only writer that actually knows, and it needs no new definition of "annotation time". Rejected: 1 needs a field that does not exist, 3 moves the problem. Investigation for the design found the trap: `isSegmentEra` has 13 call sites answering THREE different questions (record shape / member visibility / extraction liveness), so widening it would flip note promotion and extraction for 1090 old turns as an unannounced side effect. Only member visibility may move,
insight: Before widening a shared predicate, count what it is being asked. A name like "is this in the current era" hides distinct questions, and the sites that must NOT change are the ones nobody lists.

### X035
title: Swapped §4 comparison to 乐奈×灯: sharper 5-axis contrast, turn-by-turn trace
content: Replaced 祥子 with 高松灯 [REF] as §4's comparison card [REF]: 5 opposing axes (vs祥子's 2) and starkest outcome contrast (乐奈 given_up 12轮 vs 灯 achieved完整 15轮). Built a turn-by-turn trace with 4 axis→behavior correspondences: same idle action means different motives (boredom vs restraint), same jar-sniffing yields different confidence thresholds, table-setting timing differs, and 灯's turn-6 plan ("味噌要晚一点放") pays off at turn 13 — a 9-turn-delayed intention fulfilled.
insight: 

### X036
title: User grants standing autonomy for the remaining waves
content: Dispatch and keep going without checking in between waves. Applied from wave four onward: pick the frontier, draw territory by files, dispatch, verify each worker's key mutation independently rather than reading its table, commit on explicit paths, next wave.
insight: 

### X037
title: Harness v2 fully landed: all 5 tickets verified end-to-end, real-endpoint smoke PASS
content: Ticket 05 [REF] completed and fully verified: action-roleplay 103/103 tests (133 minus 30 deleted v1-module tests), harness/ now only new-architecture modules (loop/model_step/tools/client/audit), rollout unaffected, zero "Update" tool-name residue in distillation scripts, KawaiiLLM fault-injection 4/4 pass (max_tokens truncation and mid-stream exceptions both correctly recorded as error and retried), real-endpoint smoke test PASS (9 axes/11 evidence, Write→6×Edit all hit — read-before-write gate had zero friction since write-registers-snapshot worked in production). Worker made 2 justified deviations from brief: resume-filter must NOT treat 
insight: 

### X038
title: Three rulings on draft edges and graph encoding; grey's reservation released because its tenant never arrived
content: Ruled: (1) draft edges must not pass commit or lane_check — confirms the loader fix; (2) edges outside the focused subgraph turn grey; (3) width encodes focus alongside colour, and `indexes` loses its special thin line. Filed .scratch/draft-edge-visibility/ (loader third path, plus a required answer to "can a draft edge whose other endpoint is unwritable deadlock a window") and .scratch/console-focus-encoding/ (blocked on the lane-state worker, same file). Surfaced a collision the ruling resolves rather than ignores: the shell records "[REF] GREY IS RESERVED — this edge has no lane attribution yet", and `consume` was moved off grey to protect
insight: A reserved slot with no occupant is free to reassign — but check WHY it is empty first: here the reason (drafts never render) is itself the defect being fixed elsewhere, so the release only holds while that stays true.

### X039
title: S15440 settlement covers T1–1023 contiguously, but a quarter of its edges still carry the empty-relation sentinel — including on turns settl
content: Coverage: T1–725 from the overnight backfill (jobs 101–118), T726–1023 from the August era jobs, tail T1024–1027 uncovered because T1025–1027 were created that morning when the session reopened for E70. Finding that matters more than coverage: 230 of 928 edges have relation='' AND no tags (the two sets coincide exactly). Ruled out "those turns were never reviewed" — 87 of the 126 turns holding a stale edge got a FRESH edge written the same night, and 93 stale edges sit on revisited turns. Settlement writes beside stale edges instead of reconciling them.
insight: Coverage is not cleanliness. To test whether a re-run actually repaired a range, check whether the stale rows share a parent with the newly-written rows — same-parent survival proves the pass saw them and let them stand.

### X040
title: Tier 2 gets its index-node rule; the golden nine returns to its pre-ticket list for a different reason
content: Verified `closed-terminus` survives only as retirement commentary and `rankCompare` is byte-untouched. Golden nine returns to [922,929,939,946,981,984,990,998,1001] — explainable, not lucky: on that fixture every former lane terminus had itself written an `indexes` edge, so the lane rule and the node rule elect the same people under different reasons; the six that leave drop to indexed-by-elected at ranks 13-22 without falling out of the pool. Committed 646eb91 / cf32918 after a clean rebuild, 3900 pass / 0 fail. Measurement on the reserved question: across 70 live tier-2 candidates in-degree is {0:30, 1:29, 2:10, 5:1} while out-degree spread
insight: A re-baselined golden set is only acceptable when every entering and leaving member has a named cause — "the list changed and the new one looks right" is how a regression becomes the baseline.

### X041
title: Replaced colloquial phrasing in blog §3 with formal register
content: Swapped colloquial phrases ("后果谁说了算？纯规则说不了", "世界会顶回来", "谁也不替谁演") for more formal wording in blog §3 [REF] per user tone request; kept two parallel-structure verdict lines as compressed conclusions rather than colloquialisms.
insight: 

### X042
title: Four rulings — invariants sink, prose discipline, contract coordinates
content: User issued four rulings. ① Invariants out of user messages: World.invariant_text() (backdrop+facts) now feeds actor/opponent/engine systems, snapshot slimmed to the locale tree; first user message = variable initial values, then increments; three tests pin it (746 green). ② Pseudo tool_call verified model-side: native tools declared, no markup examples in prompts, same config works natively elsewhere — terra's harmony grammar leaking through the proxy; our only fault is 「不发调用＝旁观」 legitimizing silence. ③ Removed 「店家乐意现教/肯手把手教」 from shop descs (both cooking scenes) — advertising teaching flattened 精明↔天然. ④ Root cause of ghost-work: contract sa
insight: 

### X043
title: The stale MCP server is Cursor's, and the E70 index edges turn out never written
content: User corrected me: no other CC session is open. Verified: the 0.19.0 process's parent is Cursor Helper mcp-process (spawned 08-26) — Cursor holds a stale mnemo MCP connection running four-version-old rules; closing it is an IDE-side act. Second answer: the 40 surveyed E70 index declarations were NEVER written — the capability gap that spawned main-agent-edge-capability blocked them, and restoring the channel (0.22.0) did not write them. The milestone improvement seen so far is purely era grant + tier-2 rule. Recovered the full 40-declaration / 178-pair candidate list from the session transcript into .scratch/lane-state-retirement/e70-index-ed
insight: 
