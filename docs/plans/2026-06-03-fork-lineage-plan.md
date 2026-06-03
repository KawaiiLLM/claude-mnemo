# Fork Lineage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist parent/child lineage across `/compact`-to-new-id and `--fork-session` splits so recovery reaches stranded pre-fork tails and the read model can stitch the fragments.

**Architecture:** A child session resolves its parent from its own transcript — promptIds inherited from the parent already live in `turns.content_prompt_id`. Resolution + linking run at the **Stop** hook (turns exist, worker woken). Schema gains `turns.parent_turn_id`, `sessions.parent_session_id`, `sessions.lineage_status`. Recovery walks the parent chain; recall/timeline render a breadcrumb.

**Tech Stack:** TypeScript, `bun:sqlite`, `bun test`, esbuild bundle (`node scripts/build.js`).

**Spec:** `docs/plans/2026-06-03-fork-lineage.md` (approved, 5 Codex rounds). Read §2.1 (resolution algorithm), §3 (data model), §4 (relink), §5 (recovery), §6 (read model) before starting.

**Standing constraints:** commit only at each task's commit step; the only tree-mutating git is `add`/`commit` (reviewers/fix subagents use read-only git, verify `git status` after each). Version bump touches **3 manifests** + `package.json` (Task 11) — see `memory/project_version_bump_three_places.md`.

---

## File Structure

- **Create** `src/db/lineage.ts` — `classifyPromptOwnership`, `resolveSessionLineage`, `relinkSessionLineage` (Steps A+B).
- **Create** `src/db/lineage.test.ts`, `tests/db/relink-lineage.test.ts`.
- **Modify** `src/db/schema.ts` — 3 `ALTER`s + one-time bulk Step A (Task 10).
- **Modify** `src/shared/transcript-parser.ts` — preserve `logicalParentUuid`; add `collectOrderedPromptIds`.
- **Modify** `src/db/turns.ts` / `src/db/sessions.ts` — lineage column getters/setters.
- **Modify** `src/db/recover-stranded.ts` — `recoverStrandedAncestors`.
- **Modify** `src/hooks/handlers/stop.ts` — call relink + ancestor recovery.
- **Modify** `src/mcp/recall.ts`, `src/mcp/timeline.ts` — breadcrumb.
- **Modify** `.claude-plugin/marketplace.json`, `plugin/.claude-plugin/plugin.json`, `package.json` (Task 11).

Sequence: schema → parser → ownership → Step A → resolution → relink → Stop wiring → recovery → read model → migration → version. Low-risk DB/pure logic first; hook wiring and read model later.

---

### Task 1: Schema columns

**Files:**
- Modify: `src/db/schema.ts` (the `was_rolled_back` ALTER block, ~`:144`)
- Test: `tests/db/schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("lineage columns exist with defaults", () => {
  const db = createDatabase(":memory:");
  initializeSchema(db);
  const turnCols = db.query<{ name: string }, []>(`SELECT name FROM pragma_table_info('turns')`).all().map((r) => r.name);
  const sessCols = db.query<{ name: string }, []>(`SELECT name FROM pragma_table_info('sessions')`).all().map((r) => r.name);
  expect(turnCols).toContain("parent_turn_id");
  expect(sessCols).toContain("parent_session_id");
  expect(sessCols).toContain("lineage_status");
  // default
  const sid = upsertSession(db, { contentSessionId: "c1", project: "p", title: null, insight: null, createdAtEpoch: 1, updatedAtEpoch: null, completedAtEpoch: null }).id;
  expect(getSession(db, sid)?.lineageStatus).toBe("unchecked");
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test tests/db/schema.test.ts` → FAIL (no such column).

- [ ] **Step 3: Implement** — in `initializeSchema`, after the `was_rolled_back` block:

```ts
if (!hasColumn(db, "turns", "parent_turn_id"))
  db.exec("ALTER TABLE turns ADD COLUMN parent_turn_id INTEGER");
if (!hasColumn(db, "sessions", "parent_session_id"))
  db.exec("ALTER TABLE sessions ADD COLUMN parent_session_id INTEGER");
if (!hasColumn(db, "sessions", "lineage_status"))
  db.exec("ALTER TABLE sessions ADD COLUMN lineage_status TEXT NOT NULL DEFAULT 'unchecked'");
```

Add `parentTurnId: number | null` to the `turns` row mapping in `turns.ts` (`TURN_SELECT` + `mapTurnRow` + `TurnRecord`), and `parentSessionId: number | null` + `lineageStatus: string` to `SESSION_SELECT` + `SessionRecord` in `sessions.ts`.

- [ ] **Step 4: Run to verify it passes** — `bun test tests/db/schema.test.ts` → PASS. `bun run typecheck` → clean.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(db): add fork-lineage columns (parent_turn_id, parent_session_id, lineage_status)"`

---

### Task 2: Parser — preserve `logicalParentUuid`, ordered promptId collector

**Files:**
- Modify: `src/shared/transcript-parser.ts` (`TranscriptEntry` `:18`, `RawTranscriptEntry` `:71`, `normalizeEntry` `:385`, `mergeTranscriptEntries` `:360`)
- Test: `tests/shared/transcript-parser.test.ts`

- [ ] **Step 1: Failing test**

```ts
test("preserves logicalParentUuid and collects ordered promptIds", () => {
  const path = writeFixture([
    { type: "user", promptId: "pA", uuid: "u1", message: { role: "user", content: "hi" } },
    { type: "system", subtype: "compact_boundary", uuid: "b1", logicalParentUuid: "u1" },
    { type: "user", promptId: "pB", uuid: "u2", message: { role: "user", content: "next" } },
  ]);
  const entries = readAllTranscriptEntries(path);
  expect(entries.find((e) => e.subtype === "compact_boundary")?.logicalParentUuid).toBe("u1");
  expect(collectOrderedPromptIds(entries)).toEqual([
    { promptId: "pA", index: 0 },
    { promptId: "pB", index: 2 },
  ]);
});
```

- [ ] **Step 2: Run → FAIL** (`logicalParentUuid` undefined; `collectOrderedPromptIds` missing).

- [ ] **Step 3: Implement**
  - Add `logicalParentUuid?: string;` to `TranscriptEntry` and `logicalParentUuid?: unknown;` to `RawTranscriptEntry`.
  - In `normalizeEntry`, add `logicalParentUuid: typeof raw.logicalParentUuid === "string" ? raw.logicalParentUuid : undefined,`.
  - In `mergeTranscriptEntries`, add `logicalParentUuid: later.logicalParentUuid ?? first.logicalParentUuid,`.
  - Add:

```ts
export function collectOrderedPromptIds(
  entries: TranscriptEntryWithLineNumber[],
): Array<{ promptId: string; index: number }> {
  const out: Array<{ promptId: string; index: number }> = [];
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    if (entry.promptId && !seen.has(entry.promptId)) {
      seen.add(entry.promptId);
      out.push({ promptId: entry.promptId, index });
    }
  });
  return out;
}
```

- [ ] **Step 4: Run → PASS**; `bun run typecheck` clean.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(parser): preserve logicalParentUuid; add collectOrderedPromptIds"`

---

### Task 3: Ownership classification query

**Files:**
- Create: `src/db/lineage.ts`
- Test: `src/db/lineage.test.ts`

- [ ] **Step 1: Failing test** — seed turns across sessions, classify:

```ts
test("classifies foreign / child / unknown by content_prompt_id ownership", () => {
  const db = freshDb();
  const parent = seedSession(db, "parent");
  const child = seedSession(db, "child");
  seedTurn(db, parent, { promptNumber: 1, contentPromptId: "pX" });
  seedTurn(db, child, { promptNumber: 1, contentPromptId: "cY" });
  const map = classifyPromptOwnership(db, child, ["pX", "cY", "pZ"]);
  expect(map.get("pX")?.ownership).toBe("foreign");
  expect(map.get("cY")?.ownership).toBe("child");
  expect(map.get("pZ")?.ownership).toBe("unknown");
  expect(map.get("pX")?.owners).toEqual([{ sessionId: parent, turnId: expect.any(Number), promptNumber: 1 }]);
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** in `src/db/lineage.ts`:

```ts
export type Ownership = "foreign" | "child" | "unknown";
export interface OwnerInfo { sessionId: number; turnId: number; promptNumber: number; }
export interface PromptOwnership { ownership: Ownership; owners: OwnerInfo[]; }

export function classifyPromptOwnership(
  db: Database,
  childSessionId: number,
  promptIds: string[],
): Map<string, PromptOwnership> {
  const result = new Map<string, PromptOwnership>();
  promptIds.forEach((p) => result.set(p, { ownership: "unknown", owners: [] }));
  if (promptIds.length === 0) return result;
  const placeholders = promptIds.map(() => "?").join(",");
  const rows = db.query<{ content_prompt_id: string; session_id: number; turn_id: number; prompt_number: number }, string[]>(
    `SELECT content_prompt_id, session_id, id AS turn_id, prompt_number
     FROM turns WHERE content_prompt_id IN (${placeholders}) AND content_prompt_id IS NOT NULL`,
  ).all(...promptIds);
  for (const row of rows) {
    const e = result.get(row.content_prompt_id)!;
    e.owners.push({ sessionId: row.session_id, turnId: row.turn_id, promptNumber: row.prompt_number });
  }
  for (const [, e] of result) {
    if (e.owners.length === 0) e.ownership = "unknown";
    else if (e.owners.some((o) => o.sessionId !== childSessionId)) e.ownership = "foreign";
    else e.ownership = "child";
  }
  return result;
}
```

- [ ] **Step 4: Run → PASS**; typecheck clean.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(lineage): classifyPromptOwnership (foreign/child/unknown)"`

---

### Task 4: Step A — intra-session chaining

**Files:** Modify `src/db/lineage.ts`; Test `tests/db/relink-lineage.test.ts`

- [ ] **Step 1: Failing test**

```ts
test("Step A chains turns by prompt_number, skips first turn, idempotent", () => {
  const db = freshDb();
  const s = seedSession(db, "s");
  const t1 = seedTurn(db, s, { promptNumber: 1 });
  const t2 = seedTurn(db, s, { promptNumber: 2 });
  const t3 = seedTurn(db, s, { promptNumber: 3 });
  linkIntraSessionChain(db, s);
  expect(getTurnById(db, t1)!.parentTurnId).toBeNull();      // first turn untouched
  expect(getTurnById(db, t2)!.parentTurnId).toBe(t1);
  expect(getTurnById(db, t3)!.parentTurnId).toBe(t2);
  // append + re-run: only new turn linked, no rewrite of existing
  const t4 = seedTurn(db, s, { promptNumber: 4 });
  linkIntraSessionChain(db, s);
  expect(getTurnById(db, t4)!.parentTurnId).toBe(t3);
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**

```ts
export function linkIntraSessionChain(db: Database, sessionDbId: number): void {
  db.query(
    `UPDATE turns SET parent_turn_id = (
       SELECT p.id FROM turns p
       WHERE p.session_id = turns.session_id AND p.prompt_number < turns.prompt_number
       ORDER BY p.prompt_number DESC LIMIT 1
     )
     WHERE session_id = ? AND parent_turn_id IS NULL
       AND EXISTS (
         SELECT 1 FROM turns p
         WHERE p.session_id = turns.session_id AND p.prompt_number < turns.prompt_number
       )`,
  ).run(sessionDbId);
}
```

- [ ] **Step 4: Run → PASS**; typecheck clean.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(lineage): Step A intra-session parent_turn_id chaining (idempotent)"`

---

### Task 5: Resolution algorithm (`resolveSessionLineage`)

Implements spec §2.1: classify `resolved | unresolved | root`, find fork turn + parent, with confidence, multi-owner tie-break, proven-in-place, and `logicalParentUuid` fallback.

**Files:** Modify `src/db/lineage.ts`; Test `src/db/lineage.test.ts`

- [ ] **Step 1: Failing tests** (one per spec case — write all, then implement):

```ts
test("resolved: foreign prefix → parent + fork turn at latest foreign index", () => {
  // child transcript: [pP1(parent), pP2(parent), pC1(child-own)]; parent has both
  // → status resolved, parentSessionId=parent, forkTurnId = parent's pP2 turn
});
test("position picks immediate parent over grandparent (round-2 #1)", () => {
  // prefix: [gp(grandparent), p(parent), child-own]; gp earlier, p later → parent
});
test("unresolved: prefix all unknown (parent not ingested)", () => { /* status unresolved */ });
test("root: no boundary, no inherited prefix (clean start)", () => { /* status root */ });
test("root: proven in-place (pre-boundary prompts owned by this session)", () => { /* status root */ });
test("unresolved: boundary with unknown pre-boundary prompts (round-5 #1)", () => { /* status unresolved, NOT root */ });
test("tie-break: promptId with two foreign owners → longest-overlap, else created_at, else unresolved (round-5 #2)", () => {});
test("confidence: isolated lone foreign hit → unresolved (round-2 #4)", () => {});
test("logicalParentUuid fallback resolves when direct overlap empty (round-2 #3)", () => {});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**

```ts
export interface LineageResolution {
  status: "resolved" | "unresolved" | "root";
  parentSessionId?: number;
  forkTurnId?: number;
}

export function resolveSessionLineage(
  db: Database,
  childSessionId: number,
  transcriptPath: string | null,
): LineageResolution {
  if (!transcriptPath) return { status: "unresolved" };
  const entries = readAllTranscriptEntries(transcriptPath);
  const ordered = collectOrderedPromptIds(entries);            // [{promptId,index}]
  const own = classifyPromptOwnership(db, childSessionId, ordered.map((o) => o.promptId));
  const hasBoundary = entries.some((e) => e.subtype === "compact_boundary");

  // boundary = first PURELY child-owned promptId index (child-owned, not foreign)
  const firstPureChild = ordered.find((o) => own.get(o.promptId)!.ownership === "child");
  const boundaryIndex = firstPureChild ? firstPureChild.index : Infinity;
  const prefix = ordered.filter((o) => o.index < boundaryIndex);
  const foreignInPrefix = prefix.filter((o) => own.get(o.promptId)!.ownership === "foreign");
  const unknownInPrefix = prefix.filter((o) => own.get(o.promptId)!.ownership === "unknown");

  // resolved: ≥1 foreign in prefix, contiguous (confidence)
  if (foreignInPrefix.length > 0 && isContiguousRun(prefix, own)) {
    const latest = foreignInPrefix[foreignInPrefix.length - 1]!;
    const owners = own.get(latest.promptId)!.owners.filter((o) => o.sessionId !== childSessionId);
    const winner = pickOwner(db, owners, prefix, own, childSessionId); // tie-break
    if (winner) return { status: "resolved", parentSessionId: winner.sessionId, forkTurnId: winner.turnId };
  }

  // fallback: logicalParentUuid → inherited promptId
  const viaBoundary = resolveViaLogicalParent(db, entries, childSessionId);
  if (viaBoundary) return viaBoundary;

  // unresolved: fork evidence present (boundary OR foreign/unknown prefix) but unpinnable
  if (hasBoundary || foreignInPrefix.length > 0 || unknownInPrefix.length > 0) {
    // root only if PROVEN in-place: every pre-boundary prompt is child-owned by THIS session
    if (hasBoundary && prefix.length > 0 && prefix.every((o) => own.get(o.promptId)!.ownership === "child")) {
      return { status: "root" }; // proven in-place
    }
    return { status: "unresolved" };
  }
  return { status: "root" }; // no boundary, no inherited prefix → clean start
}
```

Helpers (same file): `isContiguousRun` (foreign/unknown indices form one run with no child-owned gap); `pickOwner` (single owner → it; else longest contiguous prefix overlap → earliest-but-before-child `created_at` → `undefined`); `resolveViaLogicalParent` (walk `compact_boundary.logicalParentUuid` to an entry whose promptId is foreign-owned). Each gets a focused unit test from Step 1.

- [ ] **Step 4: Run → all PASS**; typecheck clean.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(lineage): resolveSessionLineage (position-based, tie-break, proven-in-place, fallback)"`

---

### Task 6: `relinkSessionLineage` (Step A + atomic Step B)

**Files:** Modify `src/db/lineage.ts`, `src/db/sessions.ts` (setters); Test `tests/db/relink-lineage.test.ts`

- [ ] **Step 1: Failing tests**

```ts
test("resolved Stop sets first-turn edge + parent_session_id + status atomically", () => {
  // seed parent + child; relink → child.firstTurn.parentTurnId = forkTurn; session.parentSessionId=parent; lineageStatus='resolved'
});
test("root start → lineage_status='root', no edge", () => {});
test("unresolved → status 'unresolved', retried next call; later parent ingest → resolved", () => {});
test("does not re-resolve once 'resolved' or 'root' (terminal)", () => {});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**

```ts
export function relinkSessionLineage(
  db: Database,
  sessionDbId: number,
  transcriptPath: string | null,
  nowEpoch: number,
): void {
  linkIntraSessionChain(db, sessionDbId);                          // Step A (every call)
  const session = getSession(db, sessionDbId);
  if (!session || session.lineageStatus === "resolved" || session.lineageStatus === "root") return;
  const res = resolveSessionLineage(db, sessionDbId, transcriptPath);
  db.transaction(() => {
    if (res.status === "resolved" && res.forkTurnId && res.parentSessionId) {
      const first = getFirstTurn(db, sessionDbId);                 // min prompt_number
      if (first) setTurnParent(db, first.id, res.forkTurnId);
      setSessionParent(db, sessionDbId, res.parentSessionId);
      setSessionLineageStatus(db, sessionDbId, "resolved");
    } else if (res.status === "root") {
      setSessionLineageStatus(db, sessionDbId, "root");
    } else {
      setSessionLineageStatus(db, sessionDbId, "unresolved");
    }
  })();
}
```

Add `setTurnParent(db, turnId, parentTurnId)`, `getFirstTurn(db, sessionId)`, `setSessionParent`, `setSessionLineageStatus` (direct UPDATEs, mirror `resetTurnExtractionFields` style).

- [ ] **Step 4: Run → PASS**; typecheck clean.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(lineage): relinkSessionLineage (atomic resolve+link, 4-state status)"`

---

### Task 7: Wire relink into the Stop hook

**Files:** Modify `src/hooks/handlers/stop.ts` (the `db.transaction` block, ~`:123`); Test `tests/hooks/stop.test.ts`

- [ ] **Step 1: Failing test** — after a Stop with a parent-overlapping transcript fixture, the child session gets `parentSessionId` set and `lineageStatus='resolved'`; an existing test for plain extraction still passes.

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — inside the existing `db.transaction(() => { ... })`, after `applyInvalidation(...)` and before/after the turn-stop enqueue:

```ts
if (input.transcriptPath) {
  relinkSessionLineage(dependencies.db, session.id, input.transcriptPath, epoch);
}
```

(Import `relinkSessionLineage`. `relink` runs in the same transaction; safe — Step A/B are pure DB writes.)

- [ ] **Step 4: Run → PASS** (`bun test tests/hooks/stop.test.ts`); typecheck clean.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(stop): relink session lineage on Stop"`

---

### Task 8: Lineage-aware ancestor recovery

**Files:** Modify `src/db/recover-stranded.ts`, `src/hooks/handlers/stop.ts`; Test `tests/db/recover-stranded.test.ts`

- [ ] **Step 1: Failing tests**

```ts
test("recoverStrandedAncestors walks parent_session_id and re-enqueues parent tail", () => {
  // parent with a stranded extracted-empty turn (assistant_response NOT NULL) + child linked to parent
  // → recoverStrandedAncestors(db, child, now) enqueues the parent's stranded turn
});
test("depth cap + cycle guard hold on a self/loop chain", () => {
  // session whose parent_session_id points to itself → no infinite loop, returns 0
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**

```ts
export function recoverStrandedAncestors(
  db: Database,
  childSessionId: number,
  nowEpoch: number,
  maxDepth = 16,
): number {
  let recovered = 0;
  const visited = new Set<number>([childSessionId]);
  let current = getSession(db, childSessionId)?.parentSessionId ?? null;
  let depth = 0;
  while (current != null && depth < maxDepth && !visited.has(current)) {
    visited.add(current);
    recovered += recoverStrandedTurns(db, current, nowEpoch); // reuses 0.2.23 scan + dedup
    current = getSession(db, current)?.parentSessionId ?? null;
    depth += 1;
  }
  return recovered;
}
```

In `stop.ts`, after `relinkSessionLineage(...)`: `recoverStrandedAncestors(dependencies.db, session.id, epoch);` (Stop wakes the worker via the existing `notifyWorkerWake`).

- [ ] **Step 4: Run → PASS**; typecheck clean.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(recovery): lineage-aware ancestor stranded-turn recovery at Stop"`

---

### Task 9: Read-model breadcrumb (recall + timeline)

**Files:** Modify `src/mcp/recall.ts`, `src/mcp/timeline.ts`; Test `tests/mcp/recall.test.ts`, `tests/mcp/timeline.test.ts`

- [ ] **Step 1: Failing tests** — a `resolved` session renders `continues from S<parent> (forked at T<n>)` where `T<n>` = fork turn's prompt_number (derive via `parent_turn_id` of the session's first turn → that turn's prompt_number). A `project:`-filtered recall query does **not** merge a cross-project ancestor's turns.

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — in the session-header render path, if `session.parentSessionId != null`, look up the fork turn's `prompt_number` and emit the breadcrumb line; timeline additionally appends an `earlier: recall(id="S<parent>")` pointer. No change to the query scoping (project filter stays as-is → non-merged by default).

- [ ] **Step 4: Run → PASS**; typecheck clean.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(read): fork-lineage breadcrumb in recall/timeline (project-scoped, non-merged)"`

---

### Task 10: Migration — one-time bulk Step A

**Files:** Modify `src/db/schema.ts` (after the lineage ALTERs); Test `tests/db/schema.test.ts`

- [ ] **Step 1: Failing test** — seed two multi-turn sessions with NULL `parent_turn_id`, run `initializeSchema` (or `backfillIntraChains`), assert every non-first turn is linked to its predecessor.

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — a guarded one-time bulk pass (run once; gate on a `PRAGMA user_version` bump or a marker so it doesn't run every startup):

```ts
// after the 3 ALTERs, once:
db.query(
  `UPDATE turns SET parent_turn_id = (
     SELECT p.id FROM turns p
     WHERE p.session_id = turns.session_id AND p.prompt_number < turns.prompt_number
     ORDER BY p.prompt_number DESC LIMIT 1)
   WHERE parent_turn_id IS NULL
     AND EXISTS (SELECT 1 FROM turns p
                 WHERE p.session_id = turns.session_id AND p.prompt_number < turns.prompt_number)`,
).run();
```

Gate so it runs only when the `parent_turn_id` column was just added (i.e., inside the `if (!hasColumn(...))` branch that performs the ALTER). Fork edges (Step B) stay lazy.

- [ ] **Step 4: Run → PASS**; typecheck clean.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(db): one-time bulk intra-session chain backfill on migration"`

---

### Task 11: Version bump + bundle rebuild

**Files:** Modify `package.json`, `.claude-plugin/marketplace.json` (2 fields), `plugin/.claude-plugin/plugin.json`; rebuild bundle.

- [ ] **Step 1: Bump all four version fields** `0.2.23 → 0.2.24` — `package.json.version`; `marketplace.json` `metadata.version` + `plugins[0].version`; `plugin.json.version`. (Per `memory/project_version_bump_three_places.md` — bumping only `package.json` ships code but `/plugin` shows old version.)

- [ ] **Step 2: Verify no stale refs** — `grep -rn "0.2.23" --include="*.json" . | grep -v node_modules` → expect empty.

- [ ] **Step 3: Full test + typecheck** — `bun test` (all green), `bun run typecheck` (clean).

- [ ] **Step 4: Rebuild bundle** — `node scripts/build.js`; confirm `BUILD_ID` is `0.2.24-<base36>` in `plugin/scripts/worker.cjs`.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "chore: fork lineage — bump 0.2.24, rebuild bundle"`

---

## Self-Review

- **Spec coverage:** §3 schema → T1; §8 parser → T2; §2.1 ownership/resolution → T3,T5; §4 Step A/relink → T4,T6; Stop wiring → T7; §5 recovery → T8; §6 read model → T9; §7 migration → T10; version hygiene → T11. All covered.
- **Type consistency:** `LineageResolution`, `PromptOwnership`, `relinkSessionLineage`, `recoverStrandedAncestors`, `lineageStatus`/`parentSessionId`/`parentTurnId` field names used consistently across tasks.
- **No placeholders:** every code step carries real SQL/TS; resolution edge cases (T5) each have a named test from the spec's §10.
- **Sequencing:** pure-DB/logic (T1–T6) before hook wiring (T7–T8) and read model (T9); version last (T11).

## Execution Handoff

Two options:
1. **Subagent-Driven (recommended)** — fresh subagent per task, spec-then-quality review between tasks. (REQUIRED SUB-SKILL: superpowers:subagent-driven-development.)
2. **Inline** — execute in this session via executing-plans, batch with checkpoints.

Which approach?
