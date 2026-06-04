# Search / Recall Retrieval Overhaul — Design Spec

> Companion plan (TDD tasks) lives in `docs/plans/2026-06-04-search-recall-overhaul-plan.md` (written after this spec is approved).

**Goal:** Make `recall`'s free-text search forgiving and Chinese-aware, so that natural multi-word and CJK queries return relevant results instead of silently zero.

**Scope of change:** three coordinated edits to the FTS layer, landed in a **single index rebuild** — (①) OR + relevance ranking, (②) a CJK-capable tokenizer, (③) indexing the user's own prompt text. All three are derived-index changes; no source-of-truth table data changes.

---

## 1. Background — why a Chinese query returns nothing today

`recall(query=...)` flows through `searchMemory` → `buildSafeFtsQuery` → per-layer SQL against the `memory_fts` FTS5 virtual table. Three independent properties combine into the observed failure (`cookie 登录 b站 哔哩哔哩 浏览器插件` → 0 results, while `CookieCloud` → many):

1. **The query terms are AND-joined.** `buildSafeFtsQuery` (search.ts:163-179) wraps each whitespace-split term as `"term"*` and `join(" AND ")`. Every term must co-occur in one record. `cookie` alone matches 100+ records; `cookie 登录` matches 0. More words → strictly narrower → empty.

2. **No relevance ranking at all.** All three scope queries `ORDER BY created_at_epoch DESC` (search.ts:514, 562, 613). FTS `MATCH` is a binary in/out filter; results are then sorted purely by recency. There is no notion of "best match first."

3. **The tokenizer is the FTS5 default `unicode61`,** which treats a contiguous run of Han characters as a **single token** matched only by prefix. `浏览器插件` is one indivisible token; `浏览器` cannot match it. And the corpus never contains `哔哩哔哩` / `浏览器插件` verbatim anyway (see §2).

### 1.1 The indexed corpus is 100% English-leaning summaries

`memory_fts(layer, source_id, title, content, extra)` — only `title / content / extra` are matchable. What each layer feeds in:

| Layer | title | content | extra |
|---|---|---|---|
| session | `title` | `content` (summary desc) | `insight`, or `decision`+`done`+`current`+`next_steps`+`reference` |
| turn | `title` | `content` (turn summary) | `insight` |
| observation | `title` | `content` | `""` (empty) |

Every one of these is **extraction-agent output**, written in English-leaning technical prose. The raw columns that hold the *user's own words* — `turns.user_prompt`, `turns.assistant_response` — are stored but never indexed. So even a perfect tokenizer cannot match a Chinese query: the Chinese string is not in the corpus.

---

## 2. Scope

**In scope (one rebuild):**

- **① Ranking semantics:** OR-joined terms + BM25 relevance ordering (standard keyword-search behavior — match more/rarer terms → rank higher; top-K surfaces the AND-like hits without dropping partial matches).
- **② Tokenizer:** `unicode61` → `trigram` for CJK + Latin substring matching.
- **③ Corpus expansion:** add `turns.user_prompt` and `turns.assistant_response` to the index, in dedicated FTS columns, with BM25 column weights that keep summaries ranked above raw text.

**Explicitly out of scope (deliberate, per design discussion):**

- Observation raw I/O (`observations.tool_input` / `tool_result`) — largest volume, noisiest, carries secret-leak risk (e.g. the CookieCloud password that surfaced in S3491/T141). Not indexed.
- The trigram **≤2-character blind spot — CJK *and* Latin** — trigram needs ≥3-char windows, so any 1-2 char query (`登录`, `插件`, **and** `UI`/`DB`/`TS`/`Go`/`id`) won't MATCH. This is broader than first scoped: short Latin tokens match **today** via the prefix `*`, so they regress. **Decision: accept the loss (option a), no short-token fallback** — keeps a single clean query path; workaround is a 3+ char term.
- Cross-language synonym expansion / embeddings — not this round. ③ closes most of the gap by indexing the user's literal words.

---

## 3. Design

### 3.1 New FTS schema (tokenizer + dedicated columns + UNINDEXED routing)

Replace the `memory_fts` definition in `SCHEMA_SQL` (schema.ts:86-92) with:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  layer UNINDEXED,
  source_id UNINDEXED,
  title,
  content,
  extra,
  prompt,
  response,
  tokenize = 'trigram'
);
```

Two routing columns become `UNINDEXED`: `layer` / `source_id` are used only as equality filters in the JOIN (`f.layer = 'session' AND f.source_id = s.id`), never as MATCH targets. UNINDEXED keeps them stored/filterable while removing them from the full-text match (today `query="session"` spuriously matches the `layer` column). `prompt` / `response` are the new ③ columns.

> FTS5 exposes a hidden column named after the table; the existing `f.memory_fts MATCH ?` form matches **all indexed columns**, so the two new columns are searched automatically with no query-shape change.

### 3.2 Query construction — OR, no prefix star (search.ts `buildSafeFtsQuery`)

```ts
function buildSafeFtsQuery(query?: string): string | undefined {
  const terms = query
    ?.trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => {
      // strip FTS5 syntax chars; trigram does substring matching, so no prefix '*'
      const sanitized = term.replace(/["*(){}:^]/g, "");
      return sanitized ? `"${sanitized.replace(/"/g, '""')}"` : null;
    })
    .filter(Boolean);

  if (!terms || terms.length === 0) {
    return undefined;
  }

  return terms.join(" OR ");
}
```

Changes from today: `AND` → `OR`; drop the trailing `*` (trigram already does substring matching; a prefix star on trigram is meaningless). Each term stays a quoted phrase so its trigrams match in sequence (substring), and embedded `"` is doubled. Terms <3 chars contribute no trigram and simply no-op (the accepted 2-char limitation).

### 3.3 Relevance ranking — BM25 with column weights

Each scope query, **when a `query` is present**, orders by BM25 instead of recency, and selects the score so the no-scope merge can sort across layers.

BM25 weight vector (positional, one per declared column; UNINDEXED columns take 0 and never contribute):

```
bm25(f, 0.0, 0.0, 10.0, 5.0, 5.0, 3.0, 1.0)
        layer src   title content extra prompt response
```

Rationale: title strongest; summary body (`content`/`extra`) next; the user's prompt mid (it must still surface when it is the *only* match — for a Chinese query the summary columns won't match at all, so prompt being the sole hit still returns the row); assistant response lowest (noisiest). FTS5 BM25 returns more-negative = more relevant, so order **ascending**.

Per-scope query shape (sessions shown; turns/observations identical pattern):

```sql
SELECT
  'session' AS layer,
  s.id AS sourceId,
  ... existing columns ...,
  s.created_at_epoch AS timestampEpoch,
  CASE WHEN :hasQuery THEN bm25(f, 0.0, 0.0, 10.0, 5.0, 5.0, 3.0, 1.0) ELSE NULL END AS relevance
FROM sessions s
{query ? "JOIN memory_fts f ON f.layer = 'session' AND f.source_id = s.id" : ""}
WHERE ...
ORDER BY {query ? "relevance ASC" : "s.created_at_epoch DESC"}
```

When there is **no** `query` (filter-only or recent browse), behavior is unchanged: `ORDER BY created_at_epoch DESC`, `relevance = NULL`.

### 3.4 Cross-layer merge ordering (`searchMemory`, no-scope path)

Today the no-scope branch (search.ts:642-654) concatenates the three layer result sets and sorts by `timestampEpoch DESC`. New rule:

- **Query present:** sort merged results by `relevance ASC` (more-negative first), falling back to `timestampEpoch DESC` when relevance ties or is null. BM25 scores from separate per-layer MATCHes on the same FTS table/tokenizer are close enough in scale to interleave acceptably.
- **No query:** unchanged — `timestampEpoch DESC`.

`relevance` is carried on an internal field of the row mapping for sorting; it does not need to be added to the public `SearchMemoryResult` shape unless a later need arises (out of scope).

### 3.5 Corpus expansion plumbing (③)

- `TurnFtsRecord` (search.ts:15-20) gains `userPrompt: string | null` and `assistantResponse: string | null`.
- `indexFtsRecord` (search.ts:181-197) gains `prompt` / `response` parameters; the INSERT/columns extend to the 7-column shape.
- `indexTurnToFTS` passes `turn.userPrompt ?? ""` / `turn.assistantResponse ?? ""`. `indexSessionToFTS` and `indexObservationToFTS` pass `"" , ""` for the two new slots.
- The call site `indexTurnToFTS(db, updated)` (turns.ts:278) needs **no change** — `updated` is a `TurnRecord` already exposing `userPrompt`/`assistantResponse`.
- `rebuildSearchIndex`'s turn SELECT (search.ts:300-315) must add `user_prompt AS userPrompt, assistant_response AS assistantResponse` so the rebuild path populates the new columns too.

---

## 4. Migration

`memory_fts` is a virtual table — it cannot be `ALTER`ed to add columns or change tokenizer. Both ② and ③ require **drop + recreate + reindex**. The reindex is safe because the table is a pure derived index of `sessions`/`turns`/`observations`.

Add `ensureSearchIndexSchema(db)` to `initializeSchema`, mirroring the existing `ensure*` migration pattern. **Ordering is load-bearing:** it must run **after all source-table column migrations**, because it calls `rebuildSearchIndex`, whose session SELECT reads `decision`/`done`/`current`/`reference` (search.ts:286) — columns that `ensureSessionSummaryFieldColumns` (schema.ts:128) only adds to old DBs. Recreating the FTS table and rebuilding *before* those `ALTER`s throws `no such column` on any pre-summary-field DB. Concretely, insert the call **right after `ensureForkLineageColumns(db)` (schema.ts:102)** — i.e. after every `ensure*` column add, before the index/cleanup helpers (`ensureSessionProjectIndex`, `ensureTurnPromptIdIndex`, `dropLegacyMemoriesTable`).

```ts
function ensureSearchIndexSchema(db: Database): void {
  const row = db
    .query<{ sql: string }, []>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_fts'",
    )
    .get();

  // Fresh DBs already got the new DDL from SCHEMA_SQL → both markers present → no-op.
  if (row && row.sql.includes("trigram") && row.sql.includes("prompt")) {
    return;
  }

  db.exec("DROP TABLE IF EXISTS memory_fts");
  db.exec(MEMORY_FTS_DDL); // the §3.1 statement, extracted to a shared const
  rebuildSearchIndex(db);
}
```

- Fresh install: `SCHEMA_SQL` creates the new table; the check sees `trigram`+`prompt` → returns. No double work.
- Existing install: old DDL lacks both markers → drop, recreate with new DDL, full reindex. One-time cost; `rebuildSearchIndex` already exists and walks all three tables.
- `MEMORY_FTS_DDL` is extracted to a single constant so `SCHEMA_SQL`, the migration, and tests share one definition (no drift).

---

## 5. Affected files

| File | Change |
|---|---|
| `src/db/schema.ts` | New `memory_fts` DDL (trigram, UNINDEXED routing, `prompt`/`response`); extract `MEMORY_FTS_DDL` const; add `ensureSearchIndexSchema` + wire into `initializeSchema`. |
| `src/db/search.ts` | `TurnFtsRecord` +2 fields; `indexFtsRecord` +2 params + 7-col INSERT; `indexTurnToFTS` passes prompt/response; `rebuildSearchIndex` turn SELECT +2 cols; `buildSafeFtsQuery` OR + drop `*`; scope queries select `relevance` + conditional `ORDER BY bm25(...)`; `searchMemory` no-scope merge sorts by relevance when query present. |
| `src/db/turns.ts` | None (call site already supplies the fields). |
| `src/db/sessions.ts`, `src/db/observations.ts` | None functionally — index calls pass `""` for the two new slots via the updated `indexFtsRecord` signature; verify call sites compile. |

`recall` / `timeline` MCP layers need no functional change; they consume `searchMemory` output. Two reviewer notes:

- When a query is present, `recall` pagination now reflects **relevance** order, not recency — intended behavior change.
- **Prompt/response-only matches don't show *why* they matched.** Collapsed turn rendering (format.ts:477, 510) shows title/content (the English summary), using the prompt only as a fallback label when title is missing. A turn surfaced solely because its Chinese `user_prompt` matched will display its English summary — the matching text isn't visible. Findability (the goal) is met; the "why" is not. Accepted this round; a `snippet()`/`highlight()` matched-fragment preview is a deferred follow-up (see §9).

---

## 6. Edge cases

- **Empty / whitespace-only query:** `buildSafeFtsQuery` returns `undefined` → recent-browse path, unchanged.
- **All terms <3 chars** (`登录`, **and** `UI`/`DB`/`TS`): OR query has only no-op trigram terms → 0 matches. This is an **accepted regression** for short Latin tokens (they match today via the prefix `*`) and an **accepted limitation** for 2-char CJK (never matched). Both per the §2 decision (option a). Workaround: a 3+ char term.
- **Query is pure punctuation** (`"*()"`): every term sanitizes to empty → `undefined` → browse path. No FTS syntax error.
- **Mixed-length terms** (`哔哩哔哩 b`): `哔哩哔哩` matches via trigram; `b` no-ops; OR still returns the `哔哩哔哩` hits.
- **Latin substring now matches** (`ookie` → `cookie`): a deliberate trigram side effect; BM25 + the rarity of such queries keep noise low.
- **UNINDEXED + bm25 weight arity:** weights are listed positionally for every declared column (UNINDEXED ones = 0.0). **Confirmed working** under bundled Bun SQLite (Codex probe).
- **`bm25(f, ...)` alias resolution:** **confirmed** — the auxiliary function accepts the `f` alias and the UNINDEXED-column weights under bundled Bun SQLite (Codex probe).

---

## 7. Tests

- **buildSafeFtsQuery:** multi-term → `"a" OR "b"`; quotes doubled; `*`/syntax stripped; empty/punctuation → `undefined`; single term → `"a"` (no trailing `*`).
- **Tokenizer (trigram) end-to-end:** index a turn whose `user_prompt` contains `哔哩哔哩 浏览器插件`; assert `query="哔哩哔哩"` and `query="浏览器插件"` and substring `query="浏览器"` all return that turn; assert 2-char `query="登录"` returns nothing (accepted CJK limitation).
- **≤2-char Latin regression pinned (finding ②):** seed content containing `UI` and `DB`; assert `query="UI"` and `query="DB"` return **0** rows under trigram (documents the accepted short-Latin regression), while a 3+ char term covering the same content (e.g. `query="组件"` against `UI 组件`, or a `query="API"` 3-char Latin token) still matches.
- **OR semantics / no cliff:** seed records; assert a query that matched N records does **not** drop to 0 when an extra non-co-occurring term is appended (the regression the whole change targets).
- **BM25 ordering:** a record matching a term in `title` ranks above one matching only in `response`; a record matching two terms ranks above one matching one term.
- **③ corpus:** a Chinese-only `user_prompt` is findable even though all summary columns are English; assistant_response is findable but ranked below summary on a tie.
- **UNINDEXED routing:** `query="session"` / `query="turn"` does not match every row via the `layer` column.
- **Migration:** open a DB built with the OLD `memory_fts` DDL (no trigram, 5 cols), run `initializeSchema`, assert the table is recreated (sqlite_master sql contains `trigram` + `prompt`) and a prior Chinese prompt becomes searchable. Fresh-DB path: `initializeSchema` twice is idempotent (no second rebuild).
- **Migration ordering guard (§4 / finding ①):** seed a DB that lacks the summary-field columns (pre-`ensureSessionSummaryFieldColumns`) **and** has the old 5-col FTS, then run `initializeSchema` — assert it completes without `no such column` and the FTS ends up recreated. This is the regression test for the rebuild-before-ALTER ordering bug.
- **Prompt-only collapsed UX (finding ③):** a turn matched solely via a Chinese `user_prompt` is returned by `recall` at default (collapsed) depth — assert it appears in results (findability), and capture that its rendered snippet is the English title/content (documents that the match reason isn't shown; `snippet()` preview deferred).
- **No-query paths unchanged:** recent-browse and filter-only (`type:` / `file:` / `time`) still order by recency.

---

## 8. Rejected alternatives

- **AND-then-OR fallback (my earlier proposal):** rejected in favor of the standard OR + BM25 — ranking, not a fallback branch, is how mainstream keyword search surfaces best matches. Simpler, one code path.
- **Keep `unicode61`, add a synonym map:** doesn't fix substring matching and needs perpetual manual upkeep; deferred to a possible later round.
- **Concatenate prompt/response into existing `extra`:** rejected — dedicated columns are required to apply per-column BM25 weights (so raw text can't out-rank summaries).
- **Index observation tool I/O:** rejected this round — volume, noise, and secret-leak risk (§2).
- **Short-token LIKE fallback (<3 chars, CJK + Latin):** explicitly rejected (option a) — a second, unranked query path would undo ①'s single-path simplicity. Accepted the ≤2-char loss instead (§2, §9); the 3+ char workaround is cheap. Revisit only if short-token search proves a recurring pain.
- **Embeddings / sqlite-vec semantic search:** the proper cross-language fix, but a heavy new dependency; only justified if ③ proves insufficient.

---

## 9. Accepted limitations (record in summary / memory after ship)

- **All ≤2-char queries do not match — CJK *and* Latin** (trigram floor; see §2 finding ②). This includes short technical tokens that work today via prefix (`UI`, `DB`, `TS`, `Go`, `id`). **Decided: accepted, no fallback (option a).** Workaround: use a 3+ char term.
- Cross-language synonymy (哔哩哔哩 ↔ Bilibili) is only closed where the user *typed* the term in a past prompt (③); summaries remain English-leaning.
- Prompt/response-only matches surface but don't show the matched fragment in collapsed view (finding ③); `snippet()` preview is a deferred follow-up.
