# Search / Recall Retrieval Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `recall`'s free-text search forgiving and Chinese-aware — OR + BM25 ranking instead of AND + recency, a trigram tokenizer for CJK/substring matching, and the user's own prompt text added to the index.

**Architecture:** All changes live in the FTS layer (`src/db/search.ts`, `src/db/schema.ts`), landed behind a single one-time index rebuild. The FTS5 virtual table is dropped and recreated with a `trigram` tokenizer and two new columns (`prompt`, `response`); the query builder switches to OR semantics; scope queries order by `bm25()` with per-column weights. No source-of-truth table data changes.

**Tech Stack:** Bun, `bun:sqlite` (FTS5 with `trigram` tokenizer + `bm25()` ranking), TypeScript, `bun test`.

**Spec:** `docs/plans/2026-06-04-search-recall-overhaul.md` (read §3–§4 for the design; §2 records the accepted ≤2-char-query limitation).

---

## Setup (before Task 1)

We are on `main`. Create a feature branch first:

```bash
git checkout -b search-recall-overhaul
```

Reference commands used throughout:
- Run one test file: `bun test tests/db/search.test.ts`
- Run a single test by name: `bun test tests/db/schema.test.ts -t "trigram"`
- Full suite: `bun test`
- Typecheck: `bun run typecheck`

---

## File Structure

| File | Responsibility in this change |
|---|---|
| `src/db/schema.ts` | New `memory_fts` DDL (trigram, `UNINDEXED` routing cols, `prompt`/`response`) extracted to a shared `MEMORY_FTS_DDL` const; new `ensureSearchIndexSchema` migration wired into `initializeSchema` after all column migrations. |
| `src/db/search.ts` | `TurnFtsRecord` + `SearchRow` + `SearchMemoryResult` gain fields; `indexFtsRecord`/`indexTurnToFTS`/`indexSessionToFTS`/`indexObservationToFTS` + `rebuildSearchIndex` write the 7-column shape; `buildSafeFtsQuery` → OR; scope queries select `relevance` (bm25) and order by it; `searchMemory` merges by relevance when a query is present. |
| `tests/db/schema.test.ts` | New trigram/migration tests; **update** the existing legacy-memories test (it hardcodes the old 5-col FTS). |
| `tests/db/search.test.ts` | New OR-no-cliff, trigram-CJK, and BM25-ranking tests. |
| `tests/mcp/recall.test.ts` | New prompt-only collapsed-UX test (finding ③). |
| `package.json`, `.claude-plugin/marketplace.json`, `plugin/.claude-plugin/plugin.json` | Version bump 0.2.24 → 0.2.25 (4 fields). |

---

### Task 1: Trigram FTS schema + 2 new columns + migration

The FTS5 table definition, the row-writer column count, and the migration must change **together** — an `INSERT` with the wrong column count fails — so they are one task.

**Files:**
- Modify: `src/db/schema.ts` (SCHEMA_SQL memory_fts block, `initializeSchema`, new `ensureSearchIndexSchema`)
- Modify: `src/db/search.ts` (`TurnFtsRecord`, `indexFtsRecord`, `indexTurnToFTS`, `indexSessionToFTS`, `indexObservationToFTS`, `rebuildSearchIndex` turn SELECT)
- Test: `tests/db/schema.test.ts`, `tests/db/search.test.ts`

- [ ] **Step 1: Write failing test — trigram columns + tokenizer present**

Add to `tests/db/schema.test.ts` inside the `describe("initializeSchema", ...)` block:

```ts
test("memory_fts uses the trigram tokenizer with prompt/response columns", () => {
  initializeSchema(db);

  const ddl = db
    .query<{ sql: string }, []>(
      "SELECT sql FROM sqlite_master WHERE name = 'memory_fts'",
    )
    .get()!.sql;
  expect(ddl).toContain("trigram");

  const columns = db
    .query<{ name: string }, []>("PRAGMA table_info(memory_fts)")
    .all()
    .map((row) => row.name);
  expect(columns).toContain("prompt");
  expect(columns).toContain("response");
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test tests/db/schema.test.ts -t "trigram tokenizer"`
Expected: FAIL — current DDL has no `trigram` and no `prompt` column.

- [ ] **Step 3: Implement the DDL const + new columns in `src/db/schema.ts`**

Replace the `memory_fts` block inside `SCHEMA_SQL` (currently schema.ts:86-92) with an interpolated const. Add **above** `const SCHEMA_SQL` (after the `import` lines):

```ts
const MEMORY_FTS_DDL = `
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
`;
```

Then in `SCHEMA_SQL`, replace the old `CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(layer, source_id, title, content, extra);` block with:

```
  ${MEMORY_FTS_DDL}
```

- [ ] **Step 4: Implement the 7-column write path in `src/db/search.ts`**

Extend `TurnFtsRecord` (search.ts:15-20):

```ts
export interface TurnFtsRecord {
  id: number;
  title: string | null;
  content: string | null;
  insight: string | null;
  userPrompt: string | null;
  assistantResponse: string | null;
}
```

Rewrite `indexFtsRecord` (search.ts:181-197) to take and write the two new columns:

```ts
function indexFtsRecord(
  db: Database,
  layer: "session" | "turn" | "observation",
  sourceId: number,
  title: string | null,
  content: string | null,
  extra: string,
  prompt: string,
  response: string,
): void {
  db.query("DELETE FROM memory_fts WHERE layer = ? AND source_id = ?").run(
    layer,
    sourceId,
  );

  db.query(
    "INSERT INTO memory_fts (layer, source_id, title, content, extra, prompt, response) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(layer, sourceId, title, content, extra, prompt, response);
}
```

Update the three callers. In `indexSessionToFTS` (the final call, search.ts:227-234), append two empty args:

```ts
  indexFtsRecord(
    db,
    "session",
    session.id,
    session.title,
    session.content,
    extra,
    "",
    "",
  );
```

Rewrite `indexTurnToFTS` (search.ts:237-246):

```ts
export function indexTurnToFTS(db: Database, turn: TurnFtsRecord): void {
  indexFtsRecord(
    db,
    "turn",
    turn.id,
    turn.title,
    turn.content,
    turn.insight ?? "",
    turn.userPrompt ?? "",
    turn.assistantResponse ?? "",
  );
}
```

Update `indexObservationToFTS` (search.ts:252-259) — observations have no prompt/response:

```ts
  indexFtsRecord(
    db,
    "observation",
    observation.id,
    observation.title,
    observation.content,
    "",
    "",
    "",
  );
```

In `rebuildSearchIndex`, extend the turn query (search.ts:300-315) to read the two raw columns so the rebuild path populates them:

```ts
  const turnRows = db
    .query<
      {
        id: number;
        title: string | null;
        content: string | null;
        insight: string | null;
        userPrompt: string | null;
        assistantResponse: string | null;
      },
      []
    >(
      `
        SELECT
          id,
          title,
          content,
          insight,
          user_prompt AS userPrompt,
          assistant_response AS assistantResponse
        FROM turns
        WHERE status = 'extracted'
      `,
    )
    .all();
```

(The `for (const turn of turnRows) indexTurnToFTS(db, turn)` loop below it needs no change — `turn` now carries the two fields.)

- [ ] **Step 5: Implement the migration in `src/db/schema.ts`**

Add the function (place near the other `ensure*` helpers):

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
  db.exec(MEMORY_FTS_DDL);
  rebuildSearchIndex(db);
}
```

Wire it into `initializeSchema` **after all source-table column migrations** — insert the call right after `ensureForkLineageColumns(db);` (schema.ts:102):

```ts
  ensureForkLineageColumns(db);
  ensureSearchIndexSchema(db);
  ensureSessionProjectIndex(db);
```

Ordering is load-bearing: `rebuildSearchIndex`'s session SELECT reads `decision`/`done`/`current`/`reference`, which `ensureSessionSummaryFieldColumns` (schema.ts:99) adds to old DBs. Running the rebuild before those `ALTER`s throws `no such column`.

- [ ] **Step 6: Run the trigram-columns test to confirm it passes**

Run: `bun test tests/db/schema.test.ts -t "trigram tokenizer"`
Expected: PASS.

- [ ] **Step 7: Write failing test — migration ordering guard (finding ①) + CJK find via prompt**

Add to `tests/db/schema.test.ts`:

```ts
test("migrates an old 5-col FTS on a pre-summary-field DB without no-such-column", () => {
  // Sessions table missing decision/done/current/reference (+ summary_updated_at_epoch,
  // parent_session_id, lineage_status), plus the OLD 5-column memory_fts.
  db.exec(`
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_session_id TEXT UNIQUE NOT NULL,
      project TEXT NOT NULL,
      title TEXT,
      content TEXT,
      insight TEXT,
      next_steps TEXT,
      last_compact_turn INTEGER,
      last_agent_session_id TEXT,
      created_at_epoch INTEGER NOT NULL,
      updated_at_epoch INTEGER,
      completed_at_epoch INTEGER
    );
    CREATE VIRTUAL TABLE memory_fts USING fts5(layer, source_id, title, content, extra);
  `);
  db.query(
    "INSERT INTO sessions (content_session_id, project, title, created_at_epoch) VALUES (?, ?, ?, ?)",
  ).run("legacy-session", "claude-mnemo", "Legacy", 1);

  expect(() => initializeSchema(db)).not.toThrow();

  const ddl = db
    .query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name = 'memory_fts'")
    .get()!.sql;
  expect(ddl).toContain("trigram");

  const sessionColumns = db
    .query<{ name: string }, []>("PRAGMA table_info(sessions)")
    .all()
    .map((row) => row.name);
  expect(sessionColumns).toContain("decision");
});
```

Add to `tests/db/search.test.ts` (proves ② + ③: a Chinese prompt is findable though the summary is English):

```ts
test("finds a turn by a Chinese substring of its user prompt via trigram", () => {
  const session = upsertSession(db, {
    contentSessionId: "session-cjk",
    project: "claude-mnemo",
    title: "Cookie auth investigation",
    content: "English summary only",
    insight: null,
    createdAtEpoch: 600,
    updatedAtEpoch: null,
    completedAtEpoch: null,
  });

  saveTurn(db, {
    sessionId: session.id,
    promptNumber: 1,
    userPrompt: "哔哩哔哩 浏览器插件 登录测试",
    assistantResponse: "Investigated CookieCloud auth.",
    title: "Cookie auth",
    content: "English turn summary",
    insight: null,
    filesRead: [],
    filesModified: [],
    createdAtEpoch: 610,
    updatedAtEpoch: 620,
    observations: [],
  });

  // 4-char and 3-char (substring) queries match via the prompt column.
  expect(searchMemory(db, { query: "哔哩哔哩" }).some((r) => r.layer === "turn")).toBe(true);
  expect(searchMemory(db, { query: "浏览器" }).some((r) => r.layer === "turn")).toBe(true);
  // 2-char query is below the trigram floor — accepted limitation (spec §2/§9).
  expect(searchMemory(db, { query: "登录" })).toHaveLength(0);
});

test("≤2-char Latin tokens are an accepted regression; 3+ char still matches", () => {
  const session = upsertSession(db, {
    contentSessionId: "session-short-latin",
    project: "claude-mnemo",
    title: "UI API DB layer",
    content: "covers UI, the API surface, and the DB",
    insight: null,
    createdAtEpoch: 630,
    updatedAtEpoch: null,
    completedAtEpoch: null,
  });
  void session;

  // Present in the content, but below the trigram floor → 0 (accepted regression, option a).
  expect(searchMemory(db, { query: "UI" })).toHaveLength(0);
  expect(searchMemory(db, { query: "DB" })).toHaveLength(0);
  // A 3+ char Latin token over the same content still matches (the workaround).
  expect(searchMemory(db, { query: "API" }).some((r) => r.layer === "session")).toBe(true);
});
```

- [ ] **Step 8: Run both tests to confirm they fail or pass appropriately**

Run: `bun test tests/db/schema.test.ts -t "pre-summary-field" tests/db/search.test.ts -t "Chinese substring"`
Expected: the migration test PASSES (Steps 3-5 already added the migration); the CJK test PASSES (write path + trigram in place). If the CJK test fails on the 2-char assertion, confirm the bundled SQLite trigram floor — do not add a fallback (option a).

- [ ] **Step 9: Update the existing legacy-memories test (it hardcodes the old 5-col FTS)**

The test `"initializeSchema drops a legacy memories table and purges its FTS layer"` (tests/db/schema.test.ts ~line 770) builds a 5-col `memory_fts` and asserts a hand-inserted `turn` FTS row survives. The migration now recreates the FTS wholesale, so synthetic rows with no backing source row do not survive. Replace its body with:

```ts
test("initializeSchema drops a legacy memories table and recreates the FTS as trigram", () => {
  const db = createDatabase(":memory:");
  db.exec(
    `CREATE TABLE memories (id INTEGER PRIMARY KEY, type TEXT, scope TEXT,
       title TEXT, content TEXT, created_at_epoch INTEGER NOT NULL);`,
  );
  db.exec(
    `CREATE VIRTUAL TABLE memory_fts USING fts5(layer, source_id, title, content, extra);`,
  );
  db.exec(
    `INSERT INTO memory_fts (layer, source_id, title, content, extra)
       VALUES ('memory', 1, 't', 'c', '');`,
  );

  initializeSchema(db);

  const table = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'")
    .get();
  expect(table).toBeNull();

  const ddl = db
    .query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name = 'memory_fts'")
    .get()!.sql;
  expect(ddl).toContain("trigram");

  // The hand-inserted 'memory' row does not survive the recreate.
  const memRows = db
    .query<{ n: number }, []>("SELECT count(*) AS n FROM memory_fts WHERE layer='memory'")
    .get()!;
  expect(memRows.n).toBe(0);

  db.close();
});
```

- [ ] **Step 10: Grep for any other test hardcoding the old FTS shape**

Run: `grep -rn "fts5(layer" tests`
Expected: only the (now-updated) schema.test.ts occurrence. Update any others the same way.

- [ ] **Step 11: Run the full schema + search suites**

Run: `bun test tests/db/schema.test.ts tests/db/search.test.ts`
Expected: PASS (including the pre-existing tests at schema.test.ts:728 "skips rebuilding … when empty" and :738 "rebuilds when a populated layer is missing" — both still pass because `ensureSearchIndexSchema` no-ops on the already-new FTS).

- [ ] **Step 12: Commit**

```bash
git add src/db/schema.ts src/db/search.ts tests/db/schema.test.ts tests/db/search.test.ts
git commit -m "feat(search): trigram FTS + prompt/response columns + recreate migration"
```

---

### Task 2: OR query semantics

**Files:**
- Modify: `src/db/search.ts` (`buildSafeFtsQuery`, search.ts:163-179)
- Test: `tests/db/search.test.ts`

- [ ] **Step 1: Write the failing test (no-cliff)**

Add to `tests/db/search.test.ts`:

```ts
test("appending a non-co-occurring term does not drop results (OR semantics)", () => {
  const session = upsertSession(db, {
    contentSessionId: "session-or",
    project: "claude-mnemo",
    title: "Race archive",
    content: "Session about the auth race",
    insight: null,
    createdAtEpoch: 700,
    updatedAtEpoch: null,
    completedAtEpoch: null,
  });
  saveTurn(db, {
    sessionId: session.id,
    promptNumber: 1,
    userPrompt: "race details",
    assistantResponse: "reproduced",
    title: "Race diagnosis",
    content: "the race reproduction",
    insight: null,
    filesRead: [],
    filesModified: [],
    createdAtEpoch: 710,
    updatedAtEpoch: 720,
    observations: [],
  });

  const single = searchMemory(db, { query: "race" });
  const widened = searchMemory(db, { query: "race zzzznotpresent" });

  expect(single.length).toBeGreaterThan(0);
  // Under the old AND semantics this would be 0; under OR it keeps the "race" hits.
  expect(widened.length).toBeGreaterThanOrEqual(single.length);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test tests/db/search.test.ts -t "OR semantics"`
Expected: FAIL — `widened` is empty under the current AND join.

- [ ] **Step 3: Implement OR in `buildSafeFtsQuery`**

Replace `buildSafeFtsQuery` (search.ts:163-179) with (drop the trailing `*`; join with `OR`; keep the minimal `"`/`*` sanitize so quoted phrases like `foo:bar` stay literal):

```ts
function buildSafeFtsQuery(query?: string): string | undefined {
  const terms = query
    ?.trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => {
      const sanitized = term.replace(/["*]/g, "");
      return sanitized ? `"${sanitized.replace(/"/g, '""')}"` : null;
    })
    .filter(Boolean);

  if (!terms || terms.length === 0) {
    return undefined;
  }

  return terms.join(" OR ");
}
```

- [ ] **Step 4: Run the OR test + the existing escaping test**

Run: `bun test tests/db/search.test.ts -t "OR semantics" tests/db/search-query.test.ts`
Expected: PASS — `foo:bar` still resolves to a literal phrase match (the `:` is preserved; only `"`/`*` are stripped).

- [ ] **Step 5: Commit**

```bash
git add src/db/search.ts tests/db/search.test.ts
git commit -m "feat(search): OR query semantics, drop prefix-star"
```

---

### Task 3: BM25 relevance ranking

**Files:**
- Modify: `src/db/search.ts` (`SearchMemoryResult` + `SearchRow` interfaces; all six query builders; `searchMemory` merge sort)
- Test: `tests/db/search.test.ts`

- [ ] **Step 1: Write the failing test (ranking order)**

Add to `tests/db/search.test.ts`:

```ts
test("ranks a title match above a body-only match (bm25)", () => {
  upsertSession(db, {
    contentSessionId: "session-rank-title",
    project: "claude-mnemo",
    title: "widget overview",
    content: "unrelated body",
    insight: null,
    createdAtEpoch: 800,
    updatedAtEpoch: null,
    completedAtEpoch: null,
  });
  upsertSession(db, {
    contentSessionId: "session-rank-body",
    project: "claude-mnemo",
    title: "unrelated title",
    content: "a passing mention of widget here",
    insight: null,
    createdAtEpoch: 810,
    updatedAtEpoch: null,
    completedAtEpoch: null,
  });

  const results = searchMemory(db, { query: "widget", scope: "sessions" });
  const titles = results.map((r) => r.title);

  // Title weight (10) > content weight (5): the title match ranks first,
  // even though the body match was created later (recency would have flipped it).
  expect(titles.indexOf("widget overview")).toBeLessThan(
    titles.indexOf("unrelated title"),
  );
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test tests/db/search.test.ts -t "bm25"`
Expected: FAIL — current ordering is `created_at_epoch DESC`, so the later body-only session comes first.

- [ ] **Step 3: Add the `relevance` field to the result/row interfaces**

In `SearchMemoryResult` (search.ts:39-53) add:

```ts
  timestampEpoch: number;
  relevance: number | null;
}
```

In `SearchRow` (search.ts:55-69) add:

```ts
  timestampEpoch: number;
  relevance: number | null;
}
```

`mapSearchRow` (search.ts:79-85) needs no change — it spreads `...row`, so `relevance` carries through.

- [ ] **Step 4: Select `relevance` in every query and order scope queries by it**

The shared bm25 weight vector (positional, matching the 7-col DDL: `layer, source_id, title, content, extra, prompt, response`) is `0.0, 0.0, 10.0, 5.0, 5.0, 3.0, 1.0`.

In each of the **three recent** queries (`queryRecentSessions` 372-390, `queryRecentTurns` 399-417, `queryRecentObservations` 430-450), add `NULL AS relevance` as the last SELECT column (right after `... AS timestampEpoch,`). Example for `queryRecentSessions`:

```
        s.created_at_epoch AS timestampEpoch,
        NULL AS relevance
      FROM sessions s
```

In each of the **three scope** queries, add a conditional `relevance` column and switch the `ORDER BY`. For `querySessionsByScope` (search.ts:494-517) the SELECT tail and ORDER BY become:

```
        s.created_at_epoch AS timestampEpoch,
        ${query ? "bm25(f, 0.0, 0.0, 10.0, 5.0, 5.0, 3.0, 1.0)" : "NULL"} AS relevance
      FROM sessions s
      ${query ? "JOIN memory_fts f ON f.layer = 'session' AND f.source_id = s.id" : ""}
      ${combineClauses(whereClauses)}
      ORDER BY ${query ? "relevance ASC" : "s.created_at_epoch DESC"}
```

For `queryTurnsByScope` (search.ts:541-564), same pattern with `t.created_at_epoch`:

```
        t.created_at_epoch AS timestampEpoch,
        ${query ? "bm25(f, 0.0, 0.0, 10.0, 5.0, 5.0, 3.0, 1.0)" : "NULL"} AS relevance
      FROM turns t
      JOIN sessions s ON s.id = t.session_id
      ${query ? "JOIN memory_fts f ON f.layer = 'turn' AND f.source_id = t.id" : ""}
      ${combineClauses(whereClauses)}
      ORDER BY ${query ? "relevance ASC" : "t.created_at_epoch DESC"}
```

For `queryObservationsByScope` (search.ts:591-614), same with `o.created_at_epoch`:

```
        o.created_at_epoch AS timestampEpoch,
        ${query ? "bm25(f, 0.0, 0.0, 10.0, 5.0, 5.0, 3.0, 1.0)" : "NULL"} AS relevance
      FROM observations o
      JOIN turns t ON t.id = o.turn_id
      JOIN sessions s ON s.id = t.session_id
      ${query ? "JOIN memory_fts f ON f.layer = 'observation' AND f.source_id = o.id" : ""}
      ${combineClauses(whereClauses)}
      ORDER BY ${query ? "relevance ASC" : "o.created_at_epoch DESC"}
```

`bm25()` returns more-negative for better matches, so `ASC` puts the best first. The `f` alias and the `UNINDEXED`-column weights are accepted by the bundled Bun SQLite (confirmed in spec §6).

- [ ] **Step 5: Merge by relevance in the no-scope branch**

In `searchMemory`, the no-scope merge (search.ts:642-654) currently does `.sort((left, right) => right.timestampEpoch - left.timestampEpoch)`. Replace the final sort with:

```ts
    if (query) {
      return results.sort((left, right) => {
        const leftRank = left.relevance ?? Number.POSITIVE_INFINITY;
        const rightRank = right.relevance ?? Number.POSITIVE_INFINITY;
        if (leftRank !== rightRank) {
          return leftRank - rightRank;
        }
        return right.timestampEpoch - left.timestampEpoch;
      });
    }

    return results.sort((left, right) => right.timestampEpoch - left.timestampEpoch);
```

- [ ] **Step 6: Run the ranking test + the no-query recency test**

Run: `bun test tests/db/search.test.ts`
Expected: PASS — including the existing `"returns recent sessions when no query is provided"` (no-query path still orders by recency, `relevance` is NULL).

- [ ] **Step 7: Commit**

```bash
git add src/db/search.ts tests/db/search.test.ts
git commit -m "feat(search): bm25 relevance ranking with per-column weights"
```

---

### Task 4: Prompt-only collapsed-UX coverage (finding ③)

**Files:**
- Test: `tests/mcp/recall.test.ts`

This task adds no production code — it documents the accepted finding-③ behavior: a Chinese-prompt-only match surfaces in `recall`, but its collapsed snippet shows the English summary (no matched-fragment preview this round).

- [ ] **Step 1: Write the test**

Add to `tests/mcp/recall.test.ts` inside the `describe("recallMemory", ...)` block:

```ts
test("surfaces a Chinese prompt-only match though the collapsed snippet stays English", () => {
  const session = upsertSession(db, {
    contentSessionId: "session-prompt-only",
    project: "claude-mnemo",
    title: "Browser plugin login",
    content: "English summary",
    insight: null,
    createdAtEpoch: 900_000,
    updatedAtEpoch: null,
    completedAtEpoch: null,
  });
  saveTurn(db, {
    sessionId: session.id,
    promptNumber: 1,
    userPrompt: "怎么用 浏览器插件 同步 cookie",
    assistantResponse: "Use CookieCloud.",
    title: "Cookie sync setup",
    content: "English turn summary",
    insight: null,
    filesRead: [],
    filesModified: [],
    createdAtEpoch: 900_010,
    updatedAtEpoch: 900_020,
    observations: [],
  });

  const output = recallMemory(db, { query: "浏览器插件" });

  // Findability is met: the turn surfaces.
  expect(output).toContain(`[S${session.id}`);
  expect(output).toContain("Cookie sync setup");
  // Accepted limitation: the visible snippet is the English summary, not the
  // matched Chinese prompt fragment (snippet() preview deferred — spec §9).
  expect(output).not.toContain("浏览器插件");
});
```

- [ ] **Step 2: Run it**

Run: `bun test tests/mcp/recall.test.ts -t "prompt-only"`
Expected: PASS. If `output` unexpectedly contains the Chinese fragment, the collapsed renderer changed — reconcile with format.ts:477/510 and update the assertion (the goal is to capture the real behavior, not force it).

- [ ] **Step 3: Commit**

```bash
git add tests/mcp/recall.test.ts
git commit -m "test(recall): document prompt-only collapsed-match UX (finding 3)"
```

---

### Task 5: Release — version bump, bundle, full verification

**Files:**
- Modify: `package.json`, `.claude-plugin/marketplace.json`, `plugin/.claude-plugin/plugin.json`
- Build artifact: `plugin/scripts/*.cjs`

- [ ] **Step 1: Bump the version in all four fields (0.2.24 → 0.2.25)**

Edit `package.json` `"version"`; `.claude-plugin/marketplace.json` `metadata.version` **and** `plugins[0].version`; `plugin/.claude-plugin/plugin.json` `"version"`. (`/plugin` reads the `.claude-plugin` manifests, not `package.json`.)

- [ ] **Step 2: Verify no stale version string remains**

Run: `grep -rn "0.2.24" --include=*.json .`
Expected: no output.

- [ ] **Step 3: Rebuild the worker/hook/mcp bundle**

Run: `node scripts/build.js`
Expected: rebuilds `plugin/scripts/{worker,hook-command,mcp-server,replay-parse}.cjs` with a new BUILD_ID derived from 0.2.25.

- [ ] **Step 4: Full suite + typecheck**

Run: `bun test`
Expected: all tests pass.

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add package.json .claude-plugin/marketplace.json plugin/.claude-plugin/plugin.json plugin/scripts
git commit -m "chore: release 0.2.25 — recall search overhaul (trigram + OR + bm25 + prompt index)"
```

---

## Self-Review

**1. Spec coverage**
- ① OR semantics → Task 2. ① BM25 ranking → Task 3. ② trigram tokenizer + `UNINDEXED` routing → Task 1. ③ `prompt`/`response` columns + weights → Task 1 (write path) + Task 3 (weights). Migration (drop+recreate+rebuild, ordering pinned) → Task 1. Finding ① ordering guard → Task 1 Step 7. Finding ③ UX → Task 4. ≤2-char accepted limitation → asserted in Task 1 Step 7: `登录` → 0 (CJK) and `UI`/`DB` → 0 with `API` (3-char) still matching (short-Latin regression pinned, finding ②). Release/3-manifest bump → Task 5.
- Gap check: the existing legacy-FTS test is handled (Task 1 Step 9) and a sweep for others is included (Step 10). No uncovered spec section.

**2. Placeholder scan**
- Every code step shows full code or an exact, located edit; every run step has an expected result. No TBD/TODO.

**3. Type consistency**
- `relevance: number | null` is added to both `SearchRow` and `SearchMemoryResult` (Task 3 Step 3) and selected by all six queries (Step 4) — so `queryRows`/`mapSearchRow` see a consistent column set. `TurnFtsRecord` gains `userPrompt`/`assistantResponse` (Task 1 Step 4), matching the `TurnRecord` fields the call site already supplies (turns.ts:22-23) and the `rebuildSearchIndex` SELECT aliases (Task 1 Step 4). `indexFtsRecord`'s new `(prompt, response)` params are passed by all three callers. The bm25 weight vector arity (7) matches the 7-column DDL in Task 1.
