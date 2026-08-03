Verdict: `ready-for-agent` is premature.

## Round-2 finding resolution

| # | Round-2 finding | Status | Rev-3 verification |
|---|---|---|---|
| 1 | Blocker — settlement still has no crash-safe executable state machine | **Partially resolved** | `spec.md:55-59` adds a durable job row, unique boundary key, attempts cap, dedicated message class, batch output, and an atomic success transaction, but never defines stale-`claimed` recovery, `failed`→retry transitions, or ordered/monotonic commits across overlapping boundaries. |
| 2 | Major — settlement boundary and SessionEnd tail identity are ambiguous | **Partially resolved** | `spec.md:56-57` enumerates 49→151 as 50/100/150 and defines the SessionEnd gate/key, but the declared job row stores only `(session_id, boundary, ...)`, not the promised frozen turn-id window; late terminalization can therefore change a delayed job's cohort. |
| 3 | Major — the cites-era predicate cannot represent explicit empty citations reliably | **Resolved** | `spec.md:69-70` makes present-empty clear the edge set and atomically set per-turn `cites_recorded`; only an unset flag selects legacy parsing, with no created-at-era predicate. |
| 4 | Major — `remember.cites` lacks an exact mutation and transaction contract | **Resolved** | `spec.md:69-70` fixes strict `{id, relation}` elements, replace-set resend semantics, omitted/empty meanings, and one transaction for the turn update, edge replacement, and nested regrade. |
| 5 | Major — citation referential and cross-session semantics are incomplete | **Resolved** | `spec.md:71` requires cascading foreign keys at both ends and excludes cross-session provenance edges from confirmation in-degree, victim demotion, and arrow rendering. |
| 6 | Major — occupied-promptId re-typing can corrupt a real queued turn | **Partially resolved** | `spec.md:120-121` scopes MAX+1 to inserted markers, preserves `prompt_number`/`user_prompt`, retires observations and queue work, and excludes conversion from link-only semantics, but its clear list omits current extraction-derived `files_read`, `files_modified`, and `tool_call_count` (`src/db/schema.ts:57-70`). |
| 7 | Major — the 100-token unit and 2500-token global caps are not enforceable | **Partially resolved** | `spec.md:103-104` adds a four-arrow cap, `+N` overflow, the sole protected-anchor global overflow, and `estimateDiaryTokens`, but only `desc` is truncated; the retained main title plus four arrow titles can still exceed the stated 100-token unit cap. |
| 8 | Major — shared antecedent ownership becomes invalid after its owner is dropped | **Resolved** | `spec.md:103,130` re-homes shared antecedents to the earliest retained citer after every removal, iterates to a fixpoint, and names the adversarial test. |
| 9 | Major — incremental cursor semantics can lose a partial line or strand final work | **Resolved** | `spec.md:119,131` persists byte offset plus last-complete-line, never crosses a partial final line, resumes truncated SessionEnd work on the next resume, and logs the explicit no-future-event completeness limit. |
| 10 | Major — ordinary link reconciliation still lacks a complete candidate/conflict rule | **Resolved** | `spec.md:121,131` fixes candidate eligibility, transcript×prompt order, exact unique-text matching, and logged skip outcomes for duplicate text, occupied ids, and order conflicts. |
| 11 | Major — the rule-turn exemption is not a predicate over the actual schema | **Partially resolved** | `spec.md:76` pins event kinds and adds a `propose_rule` backfill obligation, but its `[T<n>]`/bare-id parser contradicts the implemented canonical `S<session_id>/T<prompt_number>` namespace (`src/rules/dream-read-tools.ts:28-30,176-182`), and a proposal requires at least two distinct evidence refs (`src/rules/dream-write-tools.ts:222-259`) while `turn_ref` is singular. |
| 12 | Major — the companion repair is not a crash-safe one-time migration | **Partially resolved** | Companion ticket `01-project-drift-breaks-transcript-resolution.md:9-12,17-19` decouples a versioned ledger from ALTER, batches transactions, and covers both first-non-NULL registration paths, but NULL-only batching has no per-row outcome/cursor, so zero-match rows left NULL can be selected forever after resume. |
| 13 | Major — the promised legacy citation grammar is still not literal enough to implement | **Resolved** | `spec.md:73,133` gives literal single/list/range/annotated forms, spacing, range expansion/cap behavior, DB-id namespace, malformed/dangling handling, cross-form dedupe, and expected-array fixtures. |
| 14 | Minor — token arithmetic names neither the correct estimator nor a consistent mean | **Resolved** | `spec.md:27,102-103` says ~50 tokens is the desc alone, gives a 70–85-token complete-row estimate, treats 100 as a cap, and names `estimateDiaryTokens`. |
| 15 | Minor — companion multi-match repair lacks a stable equal-mtime tie-break | **Resolved** | Companion ticket `01-project-drift-breaks-transcript-resolution.md:12,19` sorts by `(mtime DESC, normalized absolute path ASC)` and records all candidates plus the chosen path. |

Result: **9 resolved, 6 partially resolved, 0 not resolved.**

## New defects in Rev-3-added text

### 1. Blocker — settlement jobs can strand work, commit out of order, and lose their claimed frozen input

- **Spec section:** §A:56-59; Testing:132.
- **Evidence:** Rev 3 permits 50/100/150 jobs with overlapping H=100 windows, but specifies neither ascending per-session claiming nor a predecessor/CAS rule. Boundary 150 can therefore advance the cursor past a failed 100, while a later 50/100 commit can overwrite grades produced by the newer window. `claimed` has no lease/startup recovery and `failed` has no retry transition despite `attempts <= 3`. Finally, the listed job columns persist no window membership or immutable cutoff, so “frozen” input can drift if an earlier turn becomes terminal before execution.
- **Suggested resolution:** Persist the frozen turn-id set or an immutable reconstructable cutoff; claim at most one job per session in boundary order; make cursor updates monotonic and contingent on contiguous predecessor completion; define stale-claim recovery and `failed` retry/requeue transitions through attempt 3; test crash-after-claim and out-of-order completion.

### 2. Major — the new rule exemption cannot resolve the rule subsystem's actual references

- **Spec section:** §B:76; Testing:132.
- **Code evidence:** Rev 3 accepts only `[T<n>]` or a bare id, but rule tools validate and resolve `turn_ref` as `S<session_id>/T<prompt_number>` (`src/rules/dream-read-tools.ts:28-30`, `src/rules/dream-read-tools.ts:176-182`). A proposal requires at least two distinct evidence refs (`src/rules/dream-write-tools.ts:222-259`), yet the spec says to write “the evidence turn reference” into singular `turn_ref`; judgment creation records `source_event_id` but no `turn_ref` (`src/rules/dream-write-tools.ts:458-478`). Thus neither proposals nor judgments have a deterministic qualifying link.
- **Suggested resolution:** Resolve canonical `S#/T#` refs to DB turn ids; define proposal exemption over its multi-evidence relation rather than a singular arbitrary choice; define judgments by following `source_event_id` to the hit ref or transactionally copying that canonical ref; test multi-evidence proposals and judgment-via-hit.

### 3. Major — the resumable repair can livelock on zero-match rows

- **Spec section:** Companion ticket:12,18.
- **Evidence:** Each batch selects NULL `transcript_path` rows, while zero-match outcomes intentionally remain NULL. The ledger stores status and aggregate counts but no committed row cursor or per-session outcome. A resumed LIMIT batch may therefore select the same zero-match rows forever, never reach later rows, and double-count outcomes after a crash.
- **Suggested resolution:** Persist an id-ordered high-water cursor with each committed batch/count delta, or a versioned per-session outcome keyed by `(repair_version, session_id)`; resume only after durable progress and test a crash immediately after a zero-match batch.

### 4. Major — the stated 100-token unit cap still has no terminal enforcement rule

- **Spec section:** §D:103-104; Testing:130.
- **Evidence:** Rev 3 truncates only `desc`, while a unit must retain one spine title and up to four antecedent titles. `titleCap` is character-based, and the named Han-aware estimator charges 1.32 tokens per Han code point (`src/diary/domain.ts:80-85`); four 100-character arrow titles alone can therefore estimate to 528 tokens. A cardinality cap makes the unit finite, not <=100 tokens.
- **Suggested resolution:** Cap every rendered title deterministically and, if the title-only unit remains over 100 tokens, fold arrows into `+N` until it fits; test four maximum-length Han titles.

### 5. Major — compact conversion can retain ordinary-turn extraction metadata

- **Spec section:** §F:120; Testing:131.
- **Code evidence:** The new set/clear list omits `files_read`, `files_modified`, `tool_call_count`, interruption/rollback flags, and extraction-stall retry fields present on `turns` (`src/db/schema.ts:44-70`). The converted compact row can consequently retain file/tool/rollback or retry state from the ordinary turn it replaced.
- **Suggested resolution:** Give every `turns` column an explicit preserve/set/clear disposition; at minimum clear the ordinary extraction, invalidation, and retry fields or explicitly justify each retained field, then assert the full row in the conversion test.

### 6. Major — “strict” settlement JSON validation is underspecified

- **Spec section:** §A:59; Testing:132.
- **Evidence:** The output is written only as `[{turnId, grade}]`. The rejection list covers unknown/out-of-window ids and missing fields, but does not define grade as an integer 0–4, reject duplicate ids or extra keys, or state whether empty/partial coverage is legal. Duplicate ids make writes and old→new summaries order-dependent; an out-of-range grade otherwise reaches storage rather than the promised whole-batch validator.
- **Suggested resolution:** Specify a strict object schema with unique integer `turnId`, integer `grade` in 0–4, no extra keys, and explicit empty/partial-coverage semantics; add duplicate, out-of-range, extra-key, and empty-batch tests.

## Summary

- Rev 3 closes 9 of the 15 round-2 findings; 6 remain partial.
- The settlement design is still not crash/concurrency safe, so `ready-for-agent` remains premature.
- Rule exemptions contradict the implemented reference namespace and multi-evidence model.
- Compact conversion and the 100-token unit cap still lack complete terminal semantics.
- The companion repair needs durable per-row or high-water progress for zero-match rows.
- Once these contracts and the strict batch schema are pinned, the remaining Rev-3 additions are ready to implement.
