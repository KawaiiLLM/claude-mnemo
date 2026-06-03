# Fork Lineage — Design Spec

**Goal:** Stitch a conversation that Claude Code split across multiple session ids (via `/compact`-to-new-id or `--fork-session`) back into one lineage, so recovery can reach stranded pre-fork tails and the read model can present the fragments as one continuous narrative.

**Status:** Design approved 2026-06-03 (S1730); revised after Codex review rounds 1 (§13), 2 (§14), 3 (§15), 4 (§16), 5 (§17). Sibling of 0.2.23 failed-turn re-extraction.

**Scope (chosen):** full β — lineage capture **+** lineage-aware recovery **+** read-model breadcrumb. Continuous merged read view deferred.

---

## 1. Problem

Claude Code keys each conversation to a `session_id`. Two routine workflows mint a **new** id mid-conversation:

- **`/compact` → new id** — a compact (manual *or* auto) can continue into a fresh session id (empirically S4589 → S6106, project `/game-demo`).
- **`claude --resume X --fork-session`** — the user's routine resume workflow; every resume forks a new id (empirically S5233 → S6420; the resume also `cd`-ed into a subdir, so the **project path changed** too).

mnemo records the new id as an unrelated session, `prompt_number` restarts at 1, and the link to the parent is lost. Two consequences:

1. **Stranded recovery (data loss).** 0.2.23's `recoverStrandedTurns` scans only the session being opened. A parent's pre-fork failure tail (S4589 `T209`/`T210` + 30 extracted-empty turns) is never re-scanned, because the lazy trigger only fires for the abandoned parent id, which is never reopened.
2. **Split read model.** One logical conversation appears as two unrelated rows (S5233's 215 turns + S6420's "1–9", numbering restarted). recall/timeline show fragments that each look short.

## 2. Core insight — identify the parent from the child alone

When CC forks or compacts-to-new-id, the child transcript **inherits the uncompacted tail of the parent**. CC rewrites every inherited line's `sessionId` to the child's id but **preserves the original `promptId`**. Those `promptId`s are already in the DB under the parent session (`turns.content_prompt_id`, CC UUIDs). So the parent is resolvable from the child alone — no registry, no parent-side bookkeeping.

### 2.1 Resolution algorithm (runs at Stop)

The resolver reads the **child transcript directly** — it does **not** rely on `parseReplayTurns`' fields, which carry no inherited-vs-own marker (fix for round-2 #2).

1. Scan the child transcript in order → an ordered list of `(promptId, transcriptIndex)` for every promptId-bearing entry.
2. One DB query classifies each promptId by ownership:
   ```sql
   SELECT content_prompt_id, session_id, id AS turn_id, prompt_number
   FROM turns
   WHERE content_prompt_id IN ( /* child transcript promptIds */ )
     AND content_prompt_id IS NOT NULL;
   ```
   A promptId is **foreign** (owned by a `session_id != child`), **child-owned** (owned by the child), or **unknown** (absent from the result — the parent isn't ingested yet, or the parent tail's `content_prompt_id` is still NULL). Dual residence is possible — a `/compact` tail prompt is re-ingested under the child *and* still owned by the parent; such a prompt counts as **inherited** (foreign), not child-owned (round-4 #2).
3. Let **boundary** = the transcript index of the first *purely* child-owned promptId (child-owned and not foreign) — the start of the child's own new content. The **inherited prefix** = promptId-bearing entries before `boundary`. **Fork evidence** = the inherited prefix contains a **foreign** *or* **unknown** promptId. A `compact_boundary` alone is **not** fork evidence: an in-place compact's boundary is followed by the session's own prompts, so its prefix is child-owned → no fork evidence (fix for round-4 #1).
4. **Classify the session** (drives `lineage_status`, §3):
   - **resolved** — the inherited prefix contains ≥1 **foreign** promptId. **fork turn** = the foreign promptId at the **latest index** in the prefix; **parent** = its session. Disambiguation is by **child-transcript position, never parent `prompt_number`** (which restarts per session — round-2 #1). **Tie-break** when the latest foreign promptId has multiple foreign owners (`content_prompt_id` is only `(session_id, content_prompt_id)`-unique, not global — round-5 #2): pick the owner sharing the **longest contiguous prefix overlap** with the child's inherited prefix; if still tied, the owner whose `created_at` is closest-but-earlier than the child; if still tied, **`unresolved`** — never pick by SQL row order. **Confidence:** the prefix's foreign/unknown run must be contiguous; an isolated lone hit → demote to *unresolved* (round-2 #4).
   - **unresolved** — fork evidence exists but no resolvable foreign match yet: the prefix is all **unknown** (parent not ingested / tail ids NULL), or there is a `compact_boundary` whose in-place-ness is **unproven**, or the `logicalParentUuid` fallback can't pin it. **Retryable** (§3) — a later parent ingest / `content_prompt_id` backfill can resolve it.
   - **root** (terminal) — declared **only from a *proven* start, never from transient state** (round-5 #1): either (a) **no `compact_boundary`** anywhere *and* no inherited foreign/unknown prefix (clean fresh start), or (b) **proven in-place compact** — every pre-boundary promptId is **child-owned by this same session** with `prompt_number`s preceding the post-boundary turns. A `compact_boundary` whose pre-boundary prompts are `unknown`/`foreign` (a possible compact-to-new-id with an un-ingested parent) is **`unresolved`, not `root`**.

   *Empirical note (§17):* a child's re-ingested tail copies carry NULL `content_prompt_id` (only the latest-pending turn binds it), so they classify as **unknown** (→ `unresolved`), not child-owned — the dual-residence freeze does not manifest in current data (0 promptIds are multi-owned). These rules are defense against transient-state misclassification, not fixes for an observed failure.

The fork edge points the child's first turn at a **real parent turn** already in the DB — never at a `compact_boundary` (a `system` message never ingested as a turn). That is what lets `parent_turn_id` be a plain turn-FK.

### 2.2 Fallback when overlap is empty

`content_prompt_id` is NULL for ~21% of turns (§13), so a thin inherited tail can fail to overlap. The `compact_boundary` exposes `logicalParentUuid` pointing at the pre-compact tail; walking it within the child transcript reaches an inherited entry whose `promptId` can be matched. **This field is not currently preserved by the parser** — §8 mandates extending it. With fork evidence but no match, the session is **unresolved (retried)**, never silently "root."

### 2.3 Empirically verified on both fork types (§13)

| Child | Parent | Fork type | Overlap hits |
|---|---|---|---|
| S6420 (9 turns) | S5233 (215) | `--fork-session` | 5 of 17 child promptIds resolve to S5233 |
| S6106 (36 turns) | S4589 (210) | `/compact` → new id | 2 of 42 child promptIds resolve to S4589 |

## 3. Data model

Three columns, all added with the project's idempotent `hasColumn`-guarded `ALTER TABLE` pattern (mirrors `was_rolled_back`):

| Table | Column | Meaning |
|---|---|---|
| `turns` | `parent_turn_id INTEGER` | Logical FK to `turns.id`. Within a session: the immediately-preceding turn by `prompt_number` (physical order — may be a rolled-back/undone turn). For a forked session's first turn: the fork turn in the parent. NULL for the root conversation's first turn. |
| `sessions` | `parent_session_id INTEGER` | Logical FK to `sessions.id`. The lineage parent. NULL for a root or not-yet-resolved session. |
| `sessions` | `lineage_status TEXT NOT NULL DEFAULT 'unchecked'` | `unchecked → resolved \| root \| unresolved`. **Only `resolved` and `root` are terminal**; `unresolved` is re-attempted on later Stops. |

**`lineage_status` is a 4-state field, not a boolean (fix for round-3 #1).** A boolean "checked" flag would conflate *proven root* with *retryable unresolved* and **permanently freeze** the latter — which is wrong, because `updateTurnBackfill` fills `content_prompt_id` later via `COALESCE(content_prompt_id, ?)`, so a thin/empty overlap can become resolvable on a future Stop once the parent's tail ids are backfilled (and as other sessions ingest). Only `unresolved` retries; `resolved`/`root` are final.

**No separate `fork_prompt_number` column** (round-2 #2): the fork point is captured by the child first turn's `parent_turn_id`; the breadcrumb's `forked at T<n>` is that fork turn's `prompt_number`. Resolve+link are atomic (§4), so `parent_session_id` is never set without the first-turn edge.

`parent_turn_id` is a **physical-previous** pointer within a session; read traversal for a *live* narrative filters `was_rolled_back` / `status IN ('undone','skipped')` (§6).

```ts
// src/db/schema.ts — initializeSchema, alongside the was_rolled_back block
if (!hasColumn(db, "turns", "parent_turn_id"))
  db.exec("ALTER TABLE turns ADD COLUMN parent_turn_id INTEGER");
if (!hasColumn(db, "sessions", "parent_session_id"))
  db.exec("ALTER TABLE sessions ADD COLUMN parent_session_id INTEGER");
if (!hasColumn(db, "sessions", "lineage_status"))
  db.exec("ALTER TABLE sessions ADD COLUMN lineage_status TEXT NOT NULL DEFAULT 'unchecked'");
```

SQLite `ADD COLUMN` cannot attach an enforced `REFERENCES`; the two id columns are logical FKs (consistent with `pending_queue`). Resolution/read code uses LEFT JOIN / null-tolerance (§9.3, §10). No `compact_boundaries` registry, no per-turn raw `parentUuid`, no PostCompact coupling (§12).

## 4. Component: lineage backfill (`relinkSessionLineage`) — runs at **Stop**

Called from the **Stop hook** (`src/hooks/handlers/stop.ts`), after `backfillFromTranscript` + `applyInvalidation`, inside the same transaction. **Why Stop, not SessionStart (round-1 #1/#5):** at SessionStart the session row exists but no child turns do; Stop is the first point where turns exist, `content_prompt_id` is bound, and the worker is woken (`notifyWorkerWake`).

```ts
function relinkSessionLineage(db, sessionDbId, transcriptPath, nowEpoch): void
```

### Step A — intra-session chain (pure DB, every Stop)

```sql
UPDATE turns SET parent_turn_id = (
  SELECT p.id FROM turns p
  WHERE p.session_id = turns.session_id AND p.prompt_number < turns.prompt_number
  ORDER BY p.prompt_number DESC LIMIT 1
)
WHERE session_id = :sessionDbId AND parent_turn_id IS NULL
  AND EXISTS (
    SELECT 1 FROM turns p
    WHERE p.session_id = turns.session_id AND p.prompt_number < turns.prompt_number
  );
```

Fills newly-appended turns; leaves linked turns untouched. The `EXISTS` predecessor guard skips the session's first turn entirely, so Step A never performs a NULL→NULL no-op write — strictly idempotent (round-4 #3). The first turn is filled by Step B for forks (and stays NULL for a root).

### Step B — resolve parent + link first turn (atomic, retry-aware)

Guarded by `lineage_status IN ('unchecked','unresolved')`. Run §2.1 resolution, then in one transaction:

- **resolved** → set the child first turn `parent_turn_id = forkTurn.id`, `parent_session_id = forkTurn.session_id`, and `lineage_status = 'resolved'` together.
- **root** → set `lineage_status = 'root'` (terminal).
- **unresolved** → set `lineage_status = 'unresolved'` (re-attempted next Stop). `unresolved` is the rare case (fork evidence but unpinnable parent); if repeated re-scans prove costly, add a backoff timestamp — not needed by default.

Atomicity removes any "session set but edge missing" gap (round-2 #2); the 4-state status removes the "frozen retryable" gap (round-3 #1).

## 5. Component: lineage-aware recovery

- **Self-scan (unchanged from 0.2.23):** `recoverStrandedTurns(self)` stays at SessionStart; drain-on-next-natural-wake.
- **Ancestor climb (new):** at **Stop**, after `relinkSessionLineage`, walk `parent_session_id` (depth-capped 16, `visited` cycle guard) and run `getStrandedTurns` + re-enqueue on each ancestor. Stop wakes the worker. Reuses 0.2.23's `queueItemExistsForTurn` dedup.

**Scope caveat (round-2 #5):** `getStrandedTurns` requires `assistant_response IS NOT NULL`, so the climb recovers only turns it can see. The real S4589 tail is fully visible (2 active + 30 extracted-empty, **32/32 with an assistant response**, §14). An ancestor `active` row with a NULL assistant response is out of scope (would require a parent-transcript backfill first — deferred).

## 6. Component: read-model stitching (breadcrumb) — project-aware

- **recall** / **timeline** — a forked session's header shows `continues from S<parent> (forked at T<n>)`, where `T<n>` is the fork turn's `prompt_number`; timeline adds an `earlier:` pointer to the parent.
- **Cross-project policy (round-1 #6):** the edge is stored regardless of project; recall/timeline stay **project-scoped and non-merged by default** — a `project:`-filtered query must not silently pull a cross-project ancestor. The breadcrumb may *name* a cross-project parent; merging is an explicit opt-in.
- **Live-narrative filtering:** following `parent_turn_id` skips `was_rolled_back` / `status IN ('undone','skipped')` by default.
- A **continuous merged view** is **deferred**.

## 7. Migration of existing data

- **Schema**: the three `ALTER`s run idempotently in `initializeSchema` on next startup.
- **Backfill**: lazy, on-revisit, via `relinkSessionLineage` at Stop — consistent with the "只在重访时清理" philosophy. No global big-bang.
- **One-time bulk Step A** (approved): during migration run Step A once across **all** sessions (drop the `session_id =` predicate). Pure SQL, deterministic, transcript-free. Fork edges (Step B) remain lazy.

## 8. Transcript fields & `content_prompt_id` coverage

- **`logicalParentUuid` (round-2 #3):** absent from `TranscriptEntry`/`RawTranscriptEntry`; `normalizeEntry` drops it. The zero-overlap fallback (§2.2) requires extending `normalizeEntry` to preserve it (reuses `readAllTranscriptEntries`).
- **`content_prompt_id` ~21% NULL (round-1 #2):** backfill binds it only for the latest pending turn (verified: `COALESCE` fills it later). Mitigations: (1) recovery is unaffected — the climb scans the whole parent; (2) the breadcrumb is approximate; (3) optional precision upgrade — backfill `content_prompt_id` for non-latest turns when unambiguous, respecting the `hasOtherTurnWithContentPromptId` guard. Deferred.

## 9. Edge cases

1. **Rollback turns** — physical chain links; `was_rolled_back` flags them; read traversal filters them (§6).
2. **Multi-hop lineage** — resolved transitively; immediate parent chosen by **latest child-transcript position** (§2.1), not parent `prompt_number`.
3. **Dangling FK** — resolution/read treats an absent parent as unlinked; deletion tested (§10).
4. **No transcript at Stop** — Step B no-ops, `lineage_status` stays `unchecked` (retries); Step A still runs.
5. **Inherited prefix all `unknown`** (parent not ingested / tail ids NULL) → fork evidence present but no foreign match → **`unresolved`, retried** as `content_prompt_id` backfills and other sessions ingest — never frozen (round-3 #1, round-4 #2). Only *no* inherited foreign/unknown prefix → `root`.
6. **Thin/NULL `content_prompt_id`** — §8; parent resolves on a single in-prefix hit; `logicalParentUuid` fallback for zero hits.
7. **Cross-project parent** — edge stored; read paths project-scoped/non-merged by default (§6).
8. **In-place compact (same session id)** — terminal `root` only via *proven in-place* (pre-boundary prompts are this session's own earlier turns); a `compact_boundary` whose pre-boundary prompts are `unknown`/`foreign` stays **`unresolved`** (retryable), never frozen as `root` (round-3 #3, round-4 #1, round-5 #1).
9. **Idempotency** — Step A touches only NULLs; Step B guarded by `lineage_status`; atomic resolve+link.

## 10. Testing strategy

- **Real-payload fixtures:** `--fork-session`, manual `/compact`-to-new-id, **auto `/compact`-to-new-id (round-3 #3)**, and **in-place compact (same id) → asserts no `parent_session_id` edge (round-3 #3)**.
- **Status classification (round-3 #1):** resolved (foreign in prefix) / root (no fork evidence) / unresolved (fork evidence, no foreign match); `root`/`resolved` are terminal (no re-scan).
- **Unknown ownership (round-4 #2):** a child whose inherited prefix is all `unknown` (parent not yet ingested) → `unresolved`; after the parent ingests and `content_prompt_id` backfills, the next Stop transitions `unresolved → resolved`.
- **Proven-in-place vs uncertain boundary (round-5 #1):** a `compact_boundary` whose pre-boundary prompts are this session's own turns → terminal `root`; a boundary with `unknown` pre-boundary prompts → `unresolved` (retries; a later parent ingest resolves it, never frozen as root).
- **Multi-owner tie-break (round-5 #2):** a promptId with two foreign owners → resolver picks by longest contiguous prefix overlap, then `created_at`, then `unresolved` — never by SQL row order.
- **Position-based disambiguation (round-2 #1):** grandparent `T215` + immediate parent `T9` both matching → picks the parent (latest child-transcript position).
- **Atomic resolve+link (round-2 #2):** resolved Stop writes session + first-turn edge together; never a half-set state.
- **Confidence (round-2 #4):** isolated lone hit → `unresolved`; in-prefix lone hit → `resolved`.
- **Boundary algorithm (round-2 #2):** first purely-child-owned promptId marks the inherited-prefix end; dual-resident tail prompts counted as inherited.
- **`logicalParentUuid` fallback (round-2 #3):** zero direct overlap but boundary present → fallback resolves.
- **Step A:** chains a multi-turn session; strictly idempotent (the first turn is never matched — no NULL→NULL write, round-4 #3); links only newly-appended turns on a second pass.
- **Recovery:** parent stranded tail + child; first Stop in child re-enqueues the tail and wakes the worker; depth cap + cycle guard hold on a cyclic chain; ancestor `active`-NULL-response row documented out of scope (round-2 #5).
- **Read model:** breadcrumb renders; cross-project parent named but not merged in a `project:` query; rolled-back/undone skipped in traversal.
- **Dangling FK (round-1 #7):** delete a parent turn/session → resolver/readers tolerate the dangling id.
- **Migration:** bulk Step A links every session's intra-chain; `ALTER`s idempotent.

## 11. Open questions

None blocking. Continuous merged read view (§6), `content_prompt_id` precision backfill (§8), and an `unresolved` retry backoff (§4-B) are deferred, decided at plan time if needed.

## 12. Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Store raw CC `parentUuid` per turn | Threads through non-turn nodes (`turn_duration`, `tool_result`, `attachment`, assistant, `compact_boundary`) — none in the DB; dangles in the common case. |
| `compact_boundaries(uuid → session)` registry + PostCompact registration | §2's promptId-overlap (verified on both fork types) resolves from the child alone; `logicalParentUuid` is the fallback. Registry + parent-side coupling unnecessary. |
| Per-turn resolved `parent_prompt_id` DAG | Within a session redundant with `prompt_number`; rollback siblings already flagged. Too complex. |
| Disambiguate ancestors by parent `prompt_number` | Session-scoped, restarts; a grandparent's higher number beats the immediate parent. Use child-transcript position (round-2 #1). |
| Boolean `lineage_checked` | Conflates proven-root with retryable-unresolved and permanently freezes the latter, despite `content_prompt_id` filling later via COALESCE (round-3 #1). Use 4-state `lineage_status`. |
| Run relink at SessionStart | No child turns exist yet; SessionStart cannot `asyncWork` to wake the worker (round-1 #1/#5). |

## 13. Review round 1 — Codex: verification log

- **#1 accept:** SessionStart only `upsertSession`s → relink moved to Stop (§4).
- **#2 accept:** backfill binds `content_prompt_id` only for the latest turn; **699/3301 (21%) NULL** → §2.2 fallback + §8.
- **#3 refuted:** S6106 overlaps S4589 by 2 promptIds; registry-free retained, hardened.
- **#4 explained:** numbering restarts because `/compact` summarizes the bulk; uncompacted tail (dual-resident) is the overlap.
- **#5 accept:** Stop wakes the worker → ancestor recovery at Stop (§5).
- **#6 accept:** lineage crosses projects → project-aware read policy (§6).
- **#7 accept:** logical FK → null-tolerance + dangling tests.
- **#8 accept:** `parent_turn_id` = physical-previous; read filters invalidated turns.

## 14. Review round 2 — Codex: verification log

- **#1 accept (High):** disambiguation → **child-transcript position** (§2.1).
- **#2 accept (High):** resolve+link **atomic**; no `fork_prompt_number` column; explicit resolution/boundary algorithm (§2.1, §4-B).
- **#3 accept (Med):** `logicalParentUuid` absent → mandate parser extension (§8).
- **#4 accept (Med):** **confidence rule** — matched foreign promptIds must form the inherited prefix (§2.1).
- **#5 accept (Low):** S4589 tail 32/32 with responses; ancestor `active`-NULL-response out of scope (§5).

## 15. Review round 3 — Codex: verification log

- **#1 accept (High):** verified `updateTurnBackfill` fills `content_prompt_id` via `COALESCE` (NULL→set later) → boolean `lineage_checked` would freeze retryable sessions → replaced with 4-state **`lineage_status`** (`unchecked|resolved|root|unresolved`; only resolved/root terminal) (§3, §4-B, §9.5).
- **#2 accept (Med):** the inherited-prefix boundary is computed by the resolver's own raw transcript scan + DB ownership query (first purely-child-owned promptId marks the boundary; dual-resident prompts count as inherited) — not from `parseReplayTurns` fields (§2.1, §10).
- **#3 accept (Low):** added **auto-compact-to-new-id** and **in-place-compact (same id, no edge)** fixtures; verified `resolveTrigger` handles both auto/manual (§9.8, §10).

## 16. Review round 4 — Codex: verification log

- **#1 accept (Med):** resolved the in-place-compact vs `compact_boundary`-as-fork-evidence conflict — a `compact_boundary` alone is no longer fork evidence; only an inherited foreign/unknown prefix is (§2.1.3, §9.8).
- **#2 accept (Med):** added the **`unknown`** ownership class (promptId absent from the DB); fork evidence = inherited foreign **or** unknown prefix; an all-unknown prefix → `unresolved` (retryable) (§2.1, §9.5, §10).
- **#3 accept (Low):** Step A's UPDATE gains an `EXISTS` predecessor guard so the first turn isn't rewritten NULL→NULL — strictly idempotent (§4-A).

## 17. Review round 5 — Codex: verification log

Both findings are empirically **non-occurring** in current data; accepted as **defensive hardening** (terminal/lineage-critical decisions must not rest on transient state or an unenforced invariant).

- **#1 accept (Med, defensive):** verified the dual-residence freeze does **not** manifest — S6106's 2 foreign hits are *not* dual-resident (re-ingested tail copies carry NULL `content_prompt_id`, so they read as `unknown` → `unresolved`, not child-owned → `root`). Still, terminal `root` is now declared **only from a proven start** (no boundary, or proven in-place); an unprovable `compact_boundary` stays `unresolved` so a later parent ingest can resolve it (§2.1.4, §9.8).
- **#2 accept (Low/Med, defensive):** verified **0 of 2611** `content_prompt_id`s have >1 owner (globally unique in practice). Still, since uniqueness is unenforced and the resolver is lineage-critical, added a deterministic tie-break (longest contiguous prefix overlap → `created_at` → `unresolved`), removing the nondeterministic SQL-row-order pick (§2.1.4, §10).
