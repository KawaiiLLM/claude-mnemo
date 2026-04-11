# Spec: Compact Anchor Wiring + Session Debug Docs

Date: 2026-04-11

Prerequisite: `docs/plans/2026-04-11-worker-prompt-hardening.md` (already implemented at `82b027c`)

## Context

Two findings from the first real-world run of `82b027c` (hardened worker prompts) on 2026-04-10:

### Finding 1 — `updateCompactAnchor` is orphan code 🔴

`src/db/sessions.ts:161-171` defines `updateCompactAnchor()` with the correct semantics:

```sql
UPDATE sessions
SET last_compact_turn = (
  SELECT MAX(prompt_number) FROM turns
  WHERE session_id = ?
    AND status != 'active'
)
WHERE id = ?
```

It has a unit test at `tests/db/sessions.test.ts:181-205` asserting the semantics (extracted=1 / undone=2 / active=3 → anchor=2). **But no production caller.** `rg updateCompactAnchor src/` returns only the definition itself.

`src/worker/server.ts:466-507 handleCompact` does five things in sequence:

1. `markSidechainTurnsUndone` — marks the undone branch of the transcript
2. `cleanupUndoneTurnTasks` — drops queue entries for undone turns
3. `drainSessionCompletely` — processes remaining obs/turn-stop queue items
4. `pushSessionSummaryPromptImpl` — pushes a `<session>` prompt to Mnemosyne
5. `closeSessionQuery` — closes the Claude Agent query session

All five are present. **Step that was never added: advance `sessions.last_compact_turn`**. This is a migration leftover from the worker-realtime-obs refactor — in the old forked-agent architecture the hook wrote the anchor directly; when compact moved into worker, the anchor write never followed.

**Impact**:
- ❌ Cannot distinguish "compacted" from "uncompacted" turns in the DB
- ❌ Any future feature that needs a compact watermark (e.g. SessionStart context injection's "display from turn N onward") has no source of truth
- ✅ **Does NOT break compact behavior** — drain and summary push work via `pending_queue` FIFO and `handleCompact` sequencing, not via `last_compact_turn`

This is a **pure bookkeeping bug**.

### Finding 2 — Mnemosyne agent transcripts are a hidden first-class debug resource

During Finding 1's investigation we discovered that the dedicated pseudo-project directory under `~/.claude/projects/<encodeProjectPath(~/.claude-mnemo)>/` contains the **complete Claude Agent SDK transcript** of every Mnemosyne query session. In practice this resolves to a path like `~/.claude/projects/-Users-<user>-.claude-mnemo/<session-id>.jsonl`. These files are SDK-native JSONL (same format as Claude Code's own project transcripts) and contain:

- Every user message pushed via `sendPrompt()` (the `<obs>` / `<turn>` / `<session>` data blocks Mnemosyne actually saw)
- Every Mnemosyne `tool_use` entry with full `remember() / recall() / replay()` input payloads
- Every assistant text block (rare — only shows up when Mnemosyne responds without calling a tool, which is itself diagnostic)
- SDK-generated `queue-operation` entries tracking `enqueue` / `dequeue` of the input stream
- Timestamps, `sessionId`, `promptId`, `uuid`, `parentUuid` on every entry

**Empirical validation**: reading the 2026-04-10 17:12:25 session jsonl **confirmed that `handleCompact` ran end-to-end** — the `<session>` compact prompt with `prior_title/prior_content/prior_insight/prior_next_steps` arrived at 17:12:25.384, Mnemosyne responded with an assistant text block "No material change since prior session summary" at 17:12:28.708 (correct "leave alone" behavior per spec §5). Without this file we had no way to know compact actually fired — the DB showed `last_compact_turn = 0` because of Finding 1.

**This resource is not documented anywhere in the repo**, so users (and future Claude Code sessions debugging the worker) don't know it exists. A short README section + a few canonical `jq` queries raises this to first-class.

### Why this matters for the logger question

Before reading the agent session jsonl, we were planning to wire `src/shared/logger.ts` (currently orphan code) into the worker to make compact runs observable. **That work is now deferred**. The agent session jsonl already answers ~90% of "what did Mnemosyne do" questions, and it's SDK-native format that downstream tools (`parseReplayTranscript`, `jq`, the existing transcript analyzer) can consume without any logger glue.

The remaining 10% (worker-external events: watchdog firing, `notifyWorkerWake` arrival, multi-session concurrency) is **not exercised by the current bug** and can wait until a concrete need appears. See the "Out of scope" section below.

---

## Non-goals / Out of scope

To keep this spec tight, the following are **explicitly deferred**:

- **Wiring `src/shared/logger.ts` into worker code.** Current state: defined at `src/shared/logger.ts:43`, zero imports in `src/`, `LoggerComponent` enum lacks `"WORKER"`. Deferred until a diagnostic need surfaces that agent session jsonl cannot cover.
- **Adding info-level log points** (`handleCompact start/done`, `drainSessionCompletely claimed N items`, `notifyWorkerWake received`, etc.) to `src/worker/server.ts`. Same reason.
- **Fixing `completedAtEpoch` semantics debt.** `src/hooks/handlers/stop.ts:180` writes `completedAtEpoch: epoch` on every Stop, meaning the field records "last Stop time" rather than "session end time". No current reader uses this distinction, so the bug is latent. Leave for a later cleanup pass.
- **Auto-cleaning Mnemosyne agent transcripts past a retention window.** The dedicated `.claude/projects/*-.claude-mnemo/` directory will grow unbounded. Not this spec's problem.
- **Replay tooling that reads agent session jsonl back into Mnemosyne** (so Mnemosyne can recall its own past reasoning). Nice idea, separate feature.

---

## Core constraints

- `updateCompactAnchor` must advance **after** `drainSessionCompletely` so the anchor reflects turns finalized by drain, not just sidechain-marked turns.
- `updateCompactAnchor` must advance **even if `pushSessionSummaryPromptImpl` fails** — the anchor records "which turns were final at compact time", independent of whether Mnemosyne produced a summary.
- `updateCompactAnchor` must advance **even if it is the first compact for a brand-new session** — the semantics (anchor = MAX(prompt_number) WHERE status != 'active') already handle the empty case (returns NULL).
- Existing `handleCompact drains the session, pushes summary, and closes query` test (`tests/worker/server.test.ts:287-366`) must keep passing.
- Smoke test must prove the wiring **is** in place (prevent future re-orphan) by setting up real `turns` rows and asserting `last_compact_turn` advances after `handleCompact` returns.
- README and `docs/design.md` updates must be **verifiable copy-paste** — every `jq` query in the docs must have been tested against a real session file before the spec is accepted.

---

## Changes

### 1. `src/worker/server.ts` — Wire `updateCompactAnchor` into `handleCompact`

**Location**: lines 13-16 (import block) and lines 466-507 (`handleCompact` body).

**1a. Add import**

**Current** (lines 13-16):

```typescript
import { createDatabase } from "../db/database";
import { getSession } from "../db/sessions";
import { parseReplayTranscript } from "../shared/transcript-parser";
```

**New**:

```typescript
import { createDatabase } from "../db/database";
import { getSession, updateCompactAnchor } from "../db/sessions";
import { parseReplayTranscript } from "../shared/transcript-parser";
```

**1b. Call `updateCompactAnchor` after drain, before summary push**

**Current** (lines 466-507):

```typescript
async function handleCompact(
  sessionDbId: number,
  transcriptPath?: string | null,
): Promise<void> {
  compactingSessions.add(sessionDbId);

  try {
    if (transcriptPath) {
      const undoneTurnIds = markSidechainTurnsUndone(
        deps.db,
        sessionDbId,
        transcriptPath,
        now(),
      );
      cleanupUndoneTurnTasks(deps.db, sessionDbId, undoneTurnIds);
    }

    try {
      await drainSessionCompletely(sessionDbId);
    } catch (error) {
      logger.error?.("drainSessionCompletely failed during compact", {
        sessionDbId,
        error,
      });
    }

    try {
      const state = getOrCreateSessionState(sessionDbId);
      await pushSessionSummaryPromptImpl(state, sessionDbId);
    } catch (error) {
      logger.error?.("session summary push failed", {
        sessionDbId,
        error,
      });
    }
  } finally {
    compactingSessions.delete(sessionDbId);
    await closeSessionQuery(sessionDbId).catch((error) => {
      logger.error?.("closeSessionQuery failed", { sessionDbId, error });
    });
  }
}
```

**New** (adds a third inner try block between drain and summary push):

```typescript
async function handleCompact(
  sessionDbId: number,
  transcriptPath?: string | null,
): Promise<void> {
  compactingSessions.add(sessionDbId);

  try {
    if (transcriptPath) {
      const undoneTurnIds = markSidechainTurnsUndone(
        deps.db,
        sessionDbId,
        transcriptPath,
        now(),
      );
      cleanupUndoneTurnTasks(deps.db, sessionDbId, undoneTurnIds);
    }

    try {
      await drainSessionCompletely(sessionDbId);
    } catch (error) {
      logger.error?.("drainSessionCompletely failed during compact", {
        sessionDbId,
        error,
      });
    }

    try {
      updateCompactAnchor(deps.db, sessionDbId);
    } catch (error) {
      logger.error?.("updateCompactAnchor failed during compact", {
        sessionDbId,
        error,
      });
    }

    try {
      const state = getOrCreateSessionState(sessionDbId);
      await pushSessionSummaryPromptImpl(state, sessionDbId);
    } catch (error) {
      logger.error?.("session summary push failed", {
        sessionDbId,
        error,
      });
    }
  } finally {
    compactingSessions.delete(sessionDbId);
    await closeSessionQuery(sessionDbId).catch((error) => {
      logger.error?.("closeSessionQuery failed", { sessionDbId, error });
    });
  }
}
```

**Rationale for placement**:

- **After drain** — drain pulls `active` turns out of the queue and marks them `extracted`, so the anchor should include them. Placing before drain would under-count.
- **Before summary push** — summary push can fail (Mnemosyne crash, query-session idle, etc.); those failures should not block the anchor from advancing. An anchor is a bookkeeping fact about which turns were finalized at compact time, not about whether Mnemosyne produced a summary.
- **Own inner try block** — mirrors the pattern of the existing drain and summary blocks. An anchor UPDATE failure (nearly impossible for a pure SQL statement, but possible on DB lock contention) should be logged and swallowed, not propagated.

### 2. `tests/worker/server.test.ts` — Add smoke test for anchor wiring

**Location**: inside `describe("worker server", ...)`, directly after the existing `handleCompact drains the session, pushes summary, and closes query` test (ends at line 366).

**Add**:

```typescript
  test("handleCompact advances last_compact_turn to the latest finalized turn", async () => {
    const compactSessionId = upsertSession(db, {
      contentSessionId: "worker-session-compact-anchor",
      project: "/tmp/project-anchor",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;

    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES
        (?, 1, 'extracted', 'first',  110),
        (?, 2, 'extracted', 'second', 120),
        (?, 3, 'active',    'third',  130)`,
    ).run(compactSessionId, compactSessionId, compactSessionId);

    const core = createWorkerCore({
      db,
      processObsImpl: async () => {},
      processTurnStopImpl: async () => {},
      pushSessionSummaryPromptImpl: async (_state, _sessionId) => {},
      closeSessionQueryImpl: async (_sessionId) => {},
      createWorkerQuerySessionImpl: ((_input) =>
        ({
          sessionId: "worker-query",
          queryPid: 1234,
          async sendPrompt(_prompt: string) {
            return { session_id: "worker-query" };
          },
          async close() {},
        }) satisfies WorkerQuerySession) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
      isProcessAliveImpl: () => false,
    });

    const before = db
      .query<{ last_compact_turn: number | null }, [number]>(
        "SELECT last_compact_turn FROM sessions WHERE id = ?",
      )
      .get(compactSessionId);
    expect(before?.last_compact_turn ?? 0).toBe(0);

    await core.handleCompact(compactSessionId, null);

    const after = db
      .query<{ last_compact_turn: number | null }, [number]>(
        "SELECT last_compact_turn FROM sessions WHERE id = ?",
      )
      .get(compactSessionId);
    expect(after?.last_compact_turn).toBe(2);
  });

  test("handleCompact leaves last_compact_turn NULL when no turns have been finalized", async () => {
    const freshSessionId = upsertSession(db, {
      contentSessionId: "worker-session-fresh",
      project: "/tmp/project-fresh",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;

    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, 1, 'active', 'only', 110)`,
    ).run(freshSessionId);

    const core = createWorkerCore({
      db,
      processObsImpl: async () => {},
      processTurnStopImpl: async () => {},
      pushSessionSummaryPromptImpl: async (_state, _sessionId) => {},
      closeSessionQueryImpl: async (_sessionId) => {},
      createWorkerQuerySessionImpl: ((_input) =>
        ({
          sessionId: "worker-query",
          queryPid: 1234,
          async sendPrompt(_prompt: string) {
            return { session_id: "worker-query" };
          },
          async close() {},
        }) satisfies WorkerQuerySession) as typeof import("../../src/worker/query-session").createWorkerQuerySession,
      isProcessAliveImpl: () => false,
    });

    await core.handleCompact(freshSessionId, null);

    const after = db
      .query<{ last_compact_turn: number | null }, [number]>(
        "SELECT last_compact_turn FROM sessions WHERE id = ?",
      )
      .get(freshSessionId);
    expect(after?.last_compact_turn).toBeNull();
  });
```

**Test design notes**:

- Uses `transcriptPath: null` so the test doesn't need to mock a JSONL file — `markSidechainTurnsUndone` is gated on `if (transcriptPath)`, so passing null skips it. The anchor still advances because `updateCompactAnchor` is called unconditionally.
- First test: turns with status `extracted(1)`, `extracted(2)`, `active(3)` → anchor should be **2** (the max non-active prompt_number), matching the single-unit semantics in `tests/db/sessions.test.ts:181-205`.
- Second test: a fresh session with only an `active` turn → anchor should stay **NULL**. This guards against a future regression where someone adds `COALESCE(..., 0)` and hides the "no finalized turns yet" case.
- Both tests mock `pushSessionSummaryPromptImpl` as a no-op and `createWorkerQuerySessionImpl` as a dummy, because they are the cheapest shims that keep `handleCompact`'s happy path alive. The existing `handleCompact drains...` test already covers the full realistic flow; these two focus specifically on the anchor write.
- The assertion reads `last_compact_turn` directly via SQL instead of `getSession()` to keep the test independent of the `SessionRecord` DTO shape (if someone renames `lastCompactTurn` the test still works).

### 3. `README.md` — Add "Debugging Mnemosyne" section

**Location**: Insert a new `## Debugging Mnemosyne` section after the existing architecture overview section. (Concrete anchor: place it immediately before the "Development" / "Contributing" section if present, or at the end if not.)

**Add**:

````markdown
## Debugging Mnemosyne

Every Mnemosyne query session is stored as a full SDK transcript at `~/.claude/projects/<encodeProjectPath(~/.claude-mnemo)>/<agent-session-id>.jsonl`. This is the **authoritative record** of what Mnemosyne actually saw and did — use it first when debugging memory quality, compact behavior, or prompt drift.

**File layout**:

| Path | Contents |
|---|---|
| `~/.claude-mnemo/claude-mnemo.db` | Structured memory (sessions, turns, observations, memories, pending_queue) |
| `~/.claude/projects/<encodeProjectPath(~/.claude-mnemo)>/<id>.jsonl` | Per-worker-session Mnemosyne Claude Agent transcript (JSONL, SDK-native format) |
| `~/.claude-mnemo/worker.pid` | Active worker PID (present only while worker is running) |
| `~/.claude-mnemo/worker.starting` | Singleton acquisition marker (transient, cleaned up on boot) |

The agent transcripts use the same JSONL schema as Claude Code's own `~/.claude/projects/*/*.jsonl` files, so anything that parses Claude Code sessions (including `src/shared/transcript-parser.ts`) can consume them directly.

### Common `jq` queries

All queries below assume you've set `F=~/.claude/projects/<encodeProjectPath(~/.claude-mnemo)>/<session-id>.jsonl`.

**What kinds of records did Mnemosyne process?**

```bash
jq -r 'select(.type=="user") | (.message.content[0]?.text // empty) |
       if test("<obs id=\"O") then "obs"
       elif test("<turn id=\"T") then "turn"
       elif test("^<session id=\"S") then "session"
       else "other" end' "$F" | sort | uniq -c
```

The classifier is **priority-ordered**, not head-tag-based, because several prompt shapes contain more than one block:

- `buildInitialObsPrompt` wraps the first obs with a `<session>` header + optional `<prior_session>` + `<obs>` body — classified as **obs** because `<obs id="O">` is present
- `buildTurnStopPrompt` contains a `<turn>` block followed by a `<session>` data block — classified as **turn**
- `buildSessionSummaryPrompt` (the compact push) is a standalone `<session>` block with `prior_title/prior_content/prior_insight/prior_next_steps` fields — classified as **session**
- Naive head-tag matching (`startswith("<session")`) would mis-count initial obs messages as session, undercounting obs by 1 per session.

Expected output for a healthy session with 247 tool calls, 50 turns, and one compact:

```
 247 obs
   1 session
  50 turn
```

**What did Mnemosyne `remember()`?**

```bash
jq -r 'select(.type=="assistant") | .message.content[]?
       | select(.type=="tool_use" and .name=="mcp__mnemo__remember")
       | "\(.input.id // .input.ids)\t\(.input.title // "[status-only]")"' "$F"
```

`[status-only]` means Mnemosyne decided the record wasn't worth extracting and only updated the status field — this is desired restraint on low-value tool calls.

**Did compact actually run for this session?**

```bash
jq -r 'select(.type=="user") | (.message.content[0]?.text // empty) |
       select(test("^<session id=\"S") and (test("<obs id=\"O") | not) and (test("<turn id=\"T") | not))' "$F"
```

Same priority-ordered logic as the classifier above: a compact push is a **standalone** `<session>` block — no embedded `<obs>` or `<turn>` siblings. If this prints a `<session id="S...">` block with `prior_title/prior_content/prior_insight/prior_next_steps` fields, compact fired and Mnemosyne was asked for a summary refresh. If the output is empty, compact did not reach Mnemosyne (check `~/.claude-mnemo/claude-mnemo.db` `pending_queue` for stalled compact entries).

**Did Mnemosyne write any free-text responses?**

```bash
jq -r 'select(.type=="assistant") | .message.content[]?
       | select(.type=="text") | .text' "$F"
```

Mnemosyne's system prompt tells it "non-tool output is discarded", so text blocks are rare and almost always diagnostic signals — e.g. `"No material change since prior session summary"` is the "leave alone" signal from `buildSessionSummaryPrompt` when Mnemosyne decides the prior summary is still accurate.

**Show the input-stream push/pull latency**

```bash
jq -r 'select(.type=="queue-operation") | "\(.timestamp)  \(.operation)"' "$F"
```

Claude Agent SDK writes these entries automatically for every `pushMessage()` call; adjacent `enqueue`/`dequeue` timestamps should be within a few milliseconds. Large gaps indicate backpressure inside the SDK's query loop.

### Cross-referencing with the database

**Important**: the jsonl filename is the **SDK's agent session id**, which is *different* from both the main Claude Code `contentSessionId` and the DB `sessions.id`. The agent session id is only held in memory on `SessionState.agentSessionId` and never persisted to the DB. So there is no direct lookup — you have to cross-reference by content.

**DB → jsonl**: the worker embeds the DB session id into every prompt as `<session id="S${id}">`. To find the jsonl archives that belong to DB session 42:

```bash
grep -Fl '<session id=\"S42\"' ~/.claude/projects/*-.claude-mnemo/*.jsonl
```

Note the **escaped double quotes** (`\"`): every `<session id="S42">` inside a user message gets JSON-encoded on disk as `<session id=\"S42\">`, so plain `id="S42"` won't match. `-F` (fixed string) avoids escaping the brackets for regex, and bash single quotes keep the backslash literal.

Multiple matches are possible: a long-lived DB session may span several Mnemosyne query sessions (each time `closeSessionQuery` fires on idle/watchdog and a new one spawns on the next wake, you get a new agent session id and a new jsonl file).

**jsonl → DB**: extract the first `S<n>` id from the content of any user message:

```bash
jq -r 'select(.type=="user") | (.message.content[0]?.text // empty)
       | capture("<session id=\"S(?<n>[0-9]+)\"") .n' "$F" | head -1
```

Then query the DB:

```bash
sqlite3 ~/.claude-mnemo/claude-mnemo.db \
  "SELECT id, content_session_id, project, title, last_compact_turn
   FROM sessions WHERE id = <n>;"
```

````

### 4. `docs/design.md` — Document the Mnemosyne transcript directory as a first-class concept

**Location**: add a new subsection under whatever section already covers worker/Mnemosyne architecture. (If `docs/design.md` already has a "Worker architecture" or "Memory agent" section, place it there; otherwise add a new top-level section "Mnemosyne transcript directory".)

**Add** (adapt heading level to match surrounding file):

```markdown
### Mnemosyne transcript directory

Every `createWorkerQuerySession` spawns a fresh Claude Agent SDK `query()` session. Because the worker runs those sessions with `cwd = ~/.claude-mnemo`, the SDK writes a full JSONL transcript to `~/.claude/projects/<encodeProjectPath(~/.claude-mnemo)>/<session-id>.jsonl` (the same path family Claude Code itself uses, but in a dedicated pseudo-project directory).

**Why this directory exists**: it isolates Mnemosyne's transcripts from real user project directories without changing authentication or SDK transcript semantics. Any tool that walks the `.claude/projects` tree can still see the directory, but it no longer collides with real project roots.

**What's in the transcript**: complete Claude Agent SDK output — every `sendPrompt()` payload (tagged `<obs>` / `<turn>` / `<session>`), every `remember()` / `recall()` / `replay()` tool call, every assistant text block, and SDK-instrumented `queue-operation` events for the input stream. See `README.md#debugging-mnemosyne` for `jq` query templates.

**Retention**: currently unbounded. Files accumulate at roughly one per worker query session (created on first `pushMessage`, closed by idle watchdog after 30 minutes of inactivity). No automatic cleanup.
```

---

## Tests

The spec introduces **two** new unit tests and does not touch any existing tests.

| File | Test | What it guards |
|---|---|---|
| `tests/worker/server.test.ts` | `handleCompact advances last_compact_turn to the latest finalized turn` | `updateCompactAnchor` is wired into the happy path; prevents re-orphanization |
| `tests/worker/server.test.ts` | `handleCompact leaves last_compact_turn NULL when no turns have been finalized` | Empty-case semantics; prevents someone from adding a spurious `COALESCE(..., 0)` |

Existing tests that must remain green unchanged:

- `tests/db/sessions.test.ts:181-205` — unit-level semantics of `updateCompactAnchor` itself (active-turn exclusion)
- `tests/worker/server.test.ts:287-366` — full-path `handleCompact drains the session, pushes summary, and closes query`
- Every other test currently on main stays green. The current baseline at HEAD `82b027c` is **183 pass, 610 expect()**, but the invariant this spec enforces is "**+2 new tests, 0 regressions**", not a specific total — adjust the expected total if the baseline has drifted.

---

## Implementation order

1. **Wire the call**: edit `src/worker/server.ts` per §1 (import + three-line inner try block).
2. **Add smoke tests**: append the two new tests from §2 to `tests/worker/server.test.ts`.
3. **Verify**: `bun test tests/worker/server.test.ts tests/db/sessions.test.ts` — expect all server + sessions tests to pass, with **2 new pass** lines for the anchor tests.
4. **Full suite**: `bun test` — expect `0 fail` and **exactly 2 more pass** than the pre-change baseline (whatever HEAD's baseline is when you start). At the time this spec was written the HEAD baseline was 183, so the post-change total should be 185; verify delta, not absolute.
5. **Typecheck**: `npm run typecheck` — expect clean.
6. **Rebuild plugin artifacts**: `npm run build` — expect `plugin/scripts/worker.cjs` to be refreshed.
7. **Verify bundle contains the wire**: `grep -c "updateCompactAnchor" plugin/scripts/worker.cjs` — expect `>= 2` (the import and the call site).
8. **Docs**: apply §3 to `README.md` and §4 to `docs/design.md`.
9. **Verify docs by running each `jq` query** against a real `.claude/projects/*-.claude-mnemo/*.jsonl` transcript on your machine. If any query errors or returns obviously-wrong output, fix the query before commit.
10. **Commit** as a single commit titled `fix(worker): wire updateCompactAnchor and document Mnemosyne debugging`.

---

## Acceptance criteria

- `bun test` → `0 fail`, total `= baseline + 2` (baseline = 183 at HEAD `82b027c`; verify delta)
- `npm run typecheck` → clean (no output)
- `npm run build` → success, `plugin/scripts/worker.cjs` refreshed
- `grep -c "updateCompactAnchor" plugin/scripts/worker.cjs` → `>= 2`
- Manual smoke test on the installed plugin:
  1. Trigger a compact in a real Claude Code session (via `/compact`)
  2. `sqlite3 ~/.claude-mnemo/claude-mnemo.db "SELECT last_compact_turn FROM sessions WHERE id=(SELECT MAX(id) FROM sessions);"`
  3. Expected: a non-NULL integer equal to the MAX prompt_number of finalized turns in that session. Previously this always returned `0`.
- Every `jq` query in the new README section runs cleanly against a real agent session jsonl on the author's machine and produces output matching the description.

---

## Risk notes

- **Single-commit scope**: this spec deliberately bundles the code fix and the docs together because they were discovered through the same incident (Finding 2 is what proved Finding 1's `compact DID run` conclusion). If you want separate commits, split along §1-2 (code) and §3-4 (docs) lines; the test changes stay with the code commit.
- **No schema migration**: `last_compact_turn` column already exists in `src/db/schema.ts` (line 24), it just never got written. No migration needed.
- **No behavior change on existing sessions**: the first compact after this fix lands will write the correct anchor for that session going forward; sessions that compacted under the old (orphan) code keep `last_compact_turn = 0` until their next compact. There's no backfill and none is needed — no reader currently depends on the field, so a one-compact delay has zero observable effect.
- **Logger work explicitly deferred**: if during implementation you feel tempted to "just add a tiny info log while I'm in here", resist — that expands scope, and the agent session jsonl already covers the diagnostic need. Document any new "I wish I had a log for X" observations in a follow-up ticket instead.
