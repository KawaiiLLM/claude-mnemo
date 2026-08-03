Verdict: `ready-for-agent` is premature.

## Findings

### 1. Blocker — settlement has no executable or durable protocol

- **Spec section:** §A lines 54–58; Testing line 118.
- **Code evidence:** The worker contract forbids revisiting prior records except the narrow witnessed-correction path (`src/worker/query-session.ts:358-365`, `src/worker/query-session.ts:394-412`); its allowed tools exclude `timeline` (`src/mcp/definitions.ts:72-75`); `remember` accepts only one nested regrade and restricts it to an earlier turn in the same session (`src/mcp/definitions.ts:28-37`, `src/mcp/remember.ts:291-310`). Grades are overwritten in place with no settlement run, watermark, provenance, or atomic batch (`src/db/schema.ts:19-74`, `src/mcp/remember.ts:325-348`). The spec therefore names an agent and an SDK-query test seam without defining a legal message, input assembly, output schema, transaction, retry, or audit path.
- **Suggested resolution:** Define a first-class settlement work unit, its authorization and model-output schema, atomic multi-turn write API, durable run/watermark, retry/idempotence rules, and grade-event audit policy.

### 2. Blocker — `cites` has no storage, migration, or write contract

- **Spec section:** §B lines 64–68; User Stories 10–12 and 18; Testing line 118.
- **Code evidence:** `turns` has no citation column/table (`src/db/schema.ts:39-74`), `TurnRecord` and `TURN_SELECT` have no mapping (`src/db/turns.ts:16-44`, `src/db/turns.ts:76-106`), and the strict `remember` schema rejects an unknown `cites` field (`src/mcp/definitions.ts:28-59`, `src/mcp/definitions.ts:68-70`). The spec also fails to distinguish a legacy row with no structured representation from a new row with an explicitly empty list, which is necessary to decide when inline fallback applies.
- **Suggested resolution:** Choose a JSON column or indexed edge table and specify fresh defaults, migration/null semantics, validation, DB mapping, remember input/write behavior, and the exact structured-first/legacy-fallback predicate.

### 3. Blocker — `effGrade` and retention precedence are undefined

- **Spec section:** §A line 59; §C lines 72–76; §D lines 90–93.
- **Code evidence:** Current code separately uses raw grade as the base score (`src/mcp/timeline.ts:661-674`), era-gates only content bonus (`src/mcp/timeline.ts:699-719`), and force-keeps correctors/markers/compact/endpoints before weighted selection (`src/mcp/timeline.ts:1307-1352`). The spec never defines `effGrade`, yet simultaneously says legacy rows never anchor, the pool requires `effGrade >= 2`, G3+/G4 form the spine, and endpoints/correctors/unmatched victims/G4 are always-kept. A legacy endpoint, G0 corrector, G1 unmatched victim, cited skipped row, or superseded G4 thus has no deterministic membership or budget protection.
- **Suggested resolution:** Add a truth table for `effGrade` by era/status and an explicit precedence order for victim demotion, corrector/endpoint keeps, spine admission, pull-through, pagination, and budget removal.

### 4. Blocker — compact markers lack a durable identity and collision policy

- **Spec section:** §F lines 108–110; Problem Statement line 16; Further Notes line 139.
- **Code evidence:** `turns` stores only wrapper `content_prompt_id` and has uniqueness on `(session_id,prompt_number)` (`src/db/schema.ts:39-74`); current PostCompact uses `INSERT OR IGNORE`, so a prompt-number collision silently loses the marker (`src/hooks/handlers/post-compact.ts:206-234`). `updateTurnBackfill` refuses an already-owned promptId but can still fill other fields (`src/db/turns.ts:541-580`). The proposed “claim all unclaimed boundaries” does not persist boundary UUID, define marker numbering when several boundaries are found, or say how to repair the diagnosed promptId theft atomically.
- **Suggested resolution:** Persist a unique compact-boundary identity, define marker-to-prompt numbering and occupied promptId reassignment/conflict behavior, and enforce the invariant transactionally.

### 5. Blocker — the companion project-drift ticket leaves its data model undecided

- **Spec section:** Companion ticket lines 7–15; arc spec Out of Scope line 126.
- **Code evidence:** `upsertSession` deliberately overwrites `project` (`src/db/sessions.ts:74-104`), while `project` also scopes search/recent-session behavior (`src/db/search.ts:182-193`, `src/hooks/handlers/context.ts:366-382`) and derives transcript paths (`src/mcp/recall.ts:330`, `src/mcp/timeline.ts:1731-1733`). “First project wins” changes project semantics; immutable `transcript_path` preserves latest-cwd semantics but requires schema and reader migration. The ticket says either is acceptable while its acceptance test only describes the first.
- **Suggested resolution:** Select one design—prefer immutable transcript provenance plus latest-cwd `project`—and specify the schema migration, all reader changes, and acceptance tests for both transcript resolution and project scoping.

### 6. Major — K=50/H=100 scope and trigger crossing are unspecified

- **Spec section:** §A lines 54–60; User Story 11.
- **Code evidence:** The only current cadence is exact, session-local `promptNumber % 10 === 0`, and its SQL reads that same session’s prior 100 rows (`src/worker/processors.ts:230-254`); the server passes only the batch’s latest prompt number (`src/worker/server.ts:1814-1863`). The spec does not say whether K/H count prompts, extracted/live turns, all DB rows, one session, one project, or globally; nor what happens when a batch crosses 50, a session ends before 50, or a retry observes the same boundary.
- **Suggested resolution:** Define the counted population and scope, a `lastSettledCount < floor(count/K)*K` crossing rule, end-of-session catch-up behavior, and a durable retry-safe cursor.

### 7. Major — calibration denominator and “偏离过多” are untestable

- **Spec section:** §A line 57; Testing line 119.
- **Code evidence:** Current calibration counts every row in the window regardless of status and includes ungraded rows in the total (`src/worker/processors.ts:244-268`); existing tests explicitly assert raw counts and the absence of percentages (`tests/worker/processors.test.ts:519-575`). The redesign gives target percentages but no eligibility rules for skipped/undone/compact/legacy/provisional/ungraded rows, no rounding or minimum sample size, and no threshold for “too far.”
- **Suggested resolution:** Specify the eligible denominator, rounding, minimum sample size, and exact deviation predicate that gates the strengthened G3 evidence prompt.

### 8. Major — structured/legacy precedence and supersession graph semantics are incomplete

- **Spec section:** §B lines 64–68; §C line 75.
- **Code evidence:** Existing correction logic parses inline `[T<dbid>]`, requires the target already be marked reversed, and treats any citation to such a target as corrective (`src/mcp/timeline.ts:954-993`). It promotes a corrector before checking whether that corrector is itself a victim (`src/mcp/timeline.ts:1331-1342`), contrary to the new victim-first rule. The spec does not define missing-vs-empty structured data, structured/inline disagreement, whether `supersedes` itself marks the victim, duplicate/multiple relations, or invalid/cross-session/future edges.
- **Suggested resolution:** Define a per-era citation adapter and canonical graph algorithm, including validation, mismatch precedence, reversal/back-link derivation, and corrector-that-is-later-superseded behavior.

### 9. Major — the promised legacy citation parser does not exist as described

- **Spec section:** §B line 68.
- **Code evidence:** The only current parser accepts individual `/\\[T(\\d+)\\]/g` references (`src/mcp/timeline.ts:1517-1542`); it does not parse ranges, comma lists, or annotated forms. Because `T<n>` inside content denotes a DB id, expanding a range is also semantically different from expanding user-facing prompt numbers.
- **Suggested resolution:** Specify the exact accepted legacy grammar, id namespace, dedup/cap rules, and invalid/dangling behavior, then enumerate parser fixtures for each form.

### 10. Major — citation consumers outside timeline are not migrated

- **Spec section:** §B line 64; §C lines 72–75; Out of Scope line 128.
- **Code evidence:** Worker reprime still assigns arcs by parsing inline content (`src/mcp/task-skeleton.ts:117-140`), and diary rendering independently regex-rewrites inline citations (`src/worker/diary-material.ts:158-196`). If timeline/settlement use structured edges while these consumers use prose, the same turn can belong to different causal graphs.
- **Suggested resolution:** Inventory every citation consumer and state which reads structured edges, which intentionally remains text-only, and how mismatches are surfaced or repaired.

### 11. Major — a cited skipped turn often has nothing useful to “resurrect”

- **Spec section:** User Story 14; §C line 74; §D line 90.
- **Code evidence:** The extraction prompt tells the agent to persist a low-value turn as only `status: "skipped", grade: 0` (`src/worker/query-session.ts:388-390`), while reference rendering falls back to `"(untitled)"` when the cited row lacks extraction (`src/mcp/timeline.ts:1578-1603`). Current selection also removes skipped rows from the main sequence (`src/mcp/timeline.ts:1294-1299`). The spec permits pulling skipped rows but never defines how their title is recovered without the explicitly out-of-scope general turn rebuild.
- **Suggested resolution:** Require minimal title capture for skippable turns, or define a bounded on-demand extraction/prompt fallback specifically for cited skipped antecedents.

### 12. Major — score-ordered degradation has no atomic render unit or deterministic accounting

- **Spec section:** §D lines 89–93; arithmetic line 27.
- **Code evidence:** Current token accounting is a repository heuristic, not a tokenizer (`src/diary/domain.ts:80-85`); current score ties break by tool count then prompt number (`src/mcp/timeline.ts:1391-1399`); current injection uniformly samples milestones after four string-surgery stages (`src/hooks/milestone-injection.ts:90-137`, `src/hooks/milestone-injection.ts:165-222`). The spec leaves shared antecedents, repeated citations, a dropped citer’s ↳ rows, protected rows, equal-score ties, oversized single rows, and `+N more` counting undefined. It also says 100 tokens per turn while the worked 50-turn injection has only 2500 total tokens.
- **Suggested resolution:** Define an atomic spine-plus-antecedents unit, dedup ownership, exact shared estimator and overhead accounting, stable tie order, protected-row behavior, and conserved overflow semantics.

### 13. Major — pagination and public renderer contracts are unresolved

- **Spec section:** §D lines 80, 92–94; Testing line 116.
- **Code evidence:** The public strict timeline schema exposes `view: turns|milestones|phases`, `page`, and `pageSize`, but no `titleCap` or `tokenBudget` (`src/mcp/definitions.ts:61-70`). Today `pageSize` counts parent milestones and references are attached afterward, outside `viewItemTotal/pageCount` (`src/mcp/timeline.ts:1569-1608`, `src/mcp/timeline.ts:1755-1785`); tests lock that behavior (`tests/mcp/timeline.test.ts:2204-2236`). Turns output also promises line/time/gap/stats and all views append shape signals (`src/mcp/timeline.ts:2104-2132`, `src/mcp/timeline.ts:2419-2437`). The spec does not state which columns, `phases`, headers, hints, totals, or view name survive.
- **Suggested resolution:** Add a preservation/removal matrix and explicitly define whether pulled rows consume page slots/totals, whether `milestones` remains the API name, and which new parameters are public versus injection-only.

### 14. Major — “SessionStart injection = arc view” collides with the existing hook matrix

- **Spec section:** User Story 7; §D lines 80 and 93.
- **Code evidence:** SessionStart currently has independent `sessions`, `recent`, `digest`, `persona`, and `milestones` handlers (`src/hooks/hook-command.ts:96-110`); the state renderer is deliberately separate from the milestone hook (`src/mcp/session-output.ts:171-208`), and the matrix emits state plus milestones only for resume/compact while keeping recent/rules/persona separate (`tests/hooks/injection-matrix.test.ts:24-159`). The spec does not say whether only `SessionStart:milestones` changes or the whole injection contract is replaced.
- **Suggested resolution:** State explicitly that the unified renderer replaces only the milestone section, or specify the new source-by-section matrix and preservation rules for state, recent sessions, rules, persona, and side effects.

### 15. Major — the diary compatibility claim is false in this tree

- **Spec section:** §A line 58.
- **Code evidence:** Diary material does not select `significance_grade` (`src/worker/diary-material.ts:39-70`), the diary watermark excludes it (`src/diary/domain.ts:18-57`), and `updateTurnById` marks a settled diary stale for status/text changes but not grade changes (`src/db/turns.ts:423-431`). A settlement-only regrade is therefore invisible to diary debounce.
- **Suggested resolution:** Remove the claim, or define grade-aware diary selection/watermark/invalidation behavior and test late settlement against an already-settled diary day.

### 16. Major — the rule/policy exemption has no turn-to-rule algorithm

- **Spec section:** User Story 17; §B line 67; Testing line 118.
- **Code evidence:** `rule_events` stores an optional free-text `turn_ref`, not a foreign key or turn classification (`src/db/schema.ts:166-187`), while turns have no rule/policy flag (`src/db/schema.ts:39-74`). The settlement input is said to include only in-degree, supersession events, and zero-in-degree G3s, so an implementer cannot mechanically identify the exempt set.
- **Suggested resolution:** Define the qualifying `rule_events` kinds/statuses and canonical turn linkage, including missing/dangling/multiple events and whether exemption blocks only citation-based demotion or all settlement changes.

### 17. Major — moving creation from PostCompact discards hook-only metadata

- **Spec section:** §F lines 108–109.
- **Code evidence:** Current PostCompact resolves token count and trigger first from `input.raw.compact_metadata` and `input.trigger`, then falls back to transcript boundary metadata (`src/hooks/handlers/post-compact.ts:96-142`, `src/hooks/handlers/post-compact.ts:182-187`). UserPromptSubmit and SessionEnd do not necessarily receive those PostCompact-only values. The spec removes creation but gives no metadata ledger or declared loss behavior.
- **Suggested resolution:** Persist boundary UUID plus metadata at PostCompact for later claiming, or explicitly define transcript-only metadata and accepted fallback values.

### 18. Major — the tail-scan anchor and foreground latency contract are missing

- **Spec section:** §F line 108; Testing line 117.
- **Code evidence:** DB rows have only a start line, not an end offset or scan watermark (`src/db/schema.ts:39-74`); the parser synchronously reads and splits the entire JSONL (`src/shared/transcript-parser.ts:273-310`). UserPromptSubmit already does that full parse before its bounded DB transaction (`src/hooks/handlers/session-init.ts:63-76`), despite a test describing the current behavior as no transcript work for extracted prior turns (`tests/hooks/session-init.test.ts:178-207`). The hook has a 10-second foreground timeout (`plugin/hooks/hooks.json:72-84`).
- **Suggested resolution:** Define a durable scan cursor and fallback anchor, an incremental reader with partial-last-line handling, and explicit maximum bytes/lines/latency plus deferred recovery behavior.

### 19. Major — link reconcile cannot safely reuse current backfill semantics

- **Spec section:** User Story 16; §F line 108.
- **Code evidence:** `backfillFromTranscript` skips turns that already have an assistant response and assigns promptId only to the latest pending turn (`src/hooks/backfill.ts:27-40`, `src/hooks/backfill.ts:59-72`). `updateTurnBackfill` always rewrites assistant response/tool count, can overwrite a line start, and silently drops a conflicting promptId (`src/db/turns.ts:541-585`). The spec does not define identity matching across compacts, sidechains, rollbacks, edited drafts, duplicates, or conflict reporting.
- **Suggested resolution:** Specify a link-only update API that mutates only missing fields, plus deterministic matching/conflict rules and assertions that content/status/extraction fields remain byte-identical.

### 20. Major — SessionEnd backstop ordering and transcript source are undefined

- **Spec section:** §F line 108; Testing line 117; companion ticket lines 5–9.
- **Code evidence:** SessionEnd’s “new turn” gate counts any inserted turn id (`src/db/session-run.ts:16-34`) before deciding whether to skip orphan turns (`src/hooks/handlers/session-end.ts:56-69`); inserting a repair marker first could make an old-run orphan look current, violating the glance regression (`tests/hooks/session-end.test.ts:386-452`). `transcriptPath` is optional (`src/hooks/types.ts:11-27`), unknown sessions currently only notify finish (`src/hooks/handlers/session-end.ts:39-53`), derived paths are exactly what project drift breaks, and SessionEnd has only a 2-second timeout (`plugin/hooks/hooks.json:60-68`).
- **Suggested resolution:** Snapshot run activity before repair or exclude repair markers, define authoritative path fallback/missing-session behavior, and specify foreground-versus-async ordering and timeout limits.

### 21. Major — the named tests omit the adversarial cases that define the four seams

- **Spec section:** Testing lines 114–120.
- **Code evidence:** Existing injection tests lock the old degradation ladder (`tests/hooks/milestone-injection.test.ts:47-143`), calibration tests lock old raw-count/no-percent behavior (`tests/worker/processors.test.ts:519-575`), and PostCompact tests cover only latest-boundary insertion/basic idempotence/no-boundary/immediate-wrapper behavior (`tests/hooks/post-compact.test.ts:71-313`). Missing cases include K-crossing/retry/partial model output/atomic multi-regrade, era-boundary `effGrade`, corrector-as-victim, shared antecedents, dropped citers, protected rows over budget, migrated DBs, absent-vs-empty cites, occupied promptId, marker-number collision, partial JSONL, concurrent submit, SessionEnd timeout, and glance+old-orphan.
- **Suggested resolution:** Add an explicit adversarial acceptance matrix for settlement, renderer/pagination, schema migration, and both hook entry points before implementation begins.

### 22. Major — the companion ticket’s one-time repair is not deterministic

- **Spec section:** Companion ticket lines 9 and 13–15.
- **Code evidence:** Sessions have no transcript provenance field (`src/db/schema.ts:19-37`), and recall/timeline/context/worker repair recompute paths from `project` (`src/mcp/recall.ts:330`, `src/mcp/timeline.ts:1731-1733`, `src/hooks/handlers/context.ts:196`, `src/worker/server.ts:1164`). Searching the transcript root by `content_session_id` has no specified zero-match, multi-match, stale-path, validation, idempotence, audit, or report behavior.
- **Suggested resolution:** Enumerate every reader and define deterministic unique/missing/duplicate/stale candidate handling, transactional backfill, rerun idempotence, and an auditable repair summary.

### 23. Major — G4 origin duty is internally session-scoped while the rubric is arc-scoped

- **Spec section:** §E item 2 (line 99) versus §A line 60 and §E item 3 (line 100).
- **Code evidence:** The current rubric says every G4 opens an arc and allows a second only for radical re-foundation (`src/worker/query-session.ts:379-385`); reprime supports multiple trusted G4 arcs (`src/mcp/task-skeleton.ts:126-140`). “If the session previously has no G4, this origin must be G4” does not say how a genuinely new second arc in the same session is recognized, and can also force a short-lived first task into G4 before the claimed 50-turn scale is knowable.
- **Suggested resolution:** Define arc-boundary detection independently of “session has no G4,” and state whether origin grading is provisional until settlement confirms arc scale.

### 24. Minor — two current-behavior claims contradict the checked-in source

- **Spec section:** Problem Statement line 14.
- **Code evidence:** Current milestone rendering already resolves and emits up to two cited antecedent rows (`src/mcp/timeline.ts:1544-1611`, `src/mcp/timeline.ts:2037-2055`). Tool milestones cap titles at 90 characters, while injection tries 80 before the 50-character fallback (`src/mcp/timeline.ts:67-84`, `src/hooks/milestone-injection.ts:172-197`), not an unconditional “~50 chars.”
- **Suggested resolution:** Attribute these claims to the measured deployed stage/data snapshot, or rewrite them to describe the current source behavior precisely.

### 25. Minor — “PostCompact’s other duties remain” names duties that do not exist

- **Spec section:** §F line 109.
- **Code evidence:** The handler’s only substantive path is finding the latest boundary/wrapper and inserting the marker (`src/hooks/handlers/post-compact.ts:145-237`); it has no independent remaining responsibility after marker creation moves out.
- **Suggested resolution:** Say the handler is removed/no-op, or name the new metadata-capture duty and its test contract.

### 26. Minor — release guard and replay claims need correction

- **Spec section:** Testing line 120; companion ticket lines 5 and 13.
- **Code evidence:** The release guard hard-codes legacy mechanism sentinels `parseContentReferences`, `bracketBareTurnReferences`, and `buildCorrectionGraph` (`tests/shared/release-artifacts.test.ts:150-161`), so a legitimate replacement can fail even after rebuild unless the guard changes. Separately, the repo’s replay CLI takes an explicit JSONL path rather than resolving via `sessions.project` (`src/replay/cli.ts:31-38`), so the ticket’s claim that replay is universally broken by project drift is overbroad.
- **Suggested resolution:** Update guard sentinels to the new structured-plus-legacy paths and narrow the replay claim to the actual DB-resolved surfaces (or identify the missing replay caller).

## Summary

- The spec is not agent-ready: 5 blockers, 18 major findings, and 3 minor findings remain.
- Settlement needs a separate durable work unit, atomic mutation API, and K/H scope before coding.
- Structured citations need a complete schema/migration/validation/consumer contract.
- Selection and budget behavior need a precedence truth table and deterministic parent/antecedent accounting.
- Capture repair needs boundary identity, link-only reconciliation, scan limits, and SessionEnd ordering.
- The project-drift ticket must choose immutable transcript provenance versus changed `project` semantics.
- The four test seams need adversarial migration, retry, collision, pagination, and latency cases.
