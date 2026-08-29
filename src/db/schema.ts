import type { Database } from "bun:sqlite";

import { BUILD_ID } from "../shared/build-id";
import { recordInitializerBuild } from "./build-state";
import { isCitationRelation, type CitationRelation } from "./citations";
import { runWriteTransaction } from "./database";
import { resolveEraCutoff } from "./era";
import {
  assertLaneRegistrySettled,
  hasMigrationReceipt,
  laneModelV12MergeRule,
  resolveEdgeNodeAddress,
  runLaneModelV12SelfEdgeRetraction,
  runLaneModelV12VocabularyMerge,
  runLaneRegistryMigration,
  sortLaneModelV12MergeGroup,
  writeMigrationReceipt,
  type LaneModelV12MergeRule,
} from "./lanes";
import { ensureHomelessRecordTables } from "./homeless-record";
import {
  canonicalizeTagSet,
  countMemoryEdges,
  deriveSideTags,
  rankEdgeProvenance,
  rebuildMemoryEdgeSideTagsIndexCore,
  writeMemoryEdges,
  type EdgeProvenance,
  type WriteEdgeInput,
} from "./memory-edges";
import { canonicalizeSettlementProposalAddresses } from "./note-settlement-proposals";
import { runSegmentOneTagMigration } from "./segment-one-tag-migration";
import { rebuildSearchIndex } from "./search";
import { recomputeSegmentFacets, repairStaleSegmentFacets } from "./segments";
import { ERA_GRANT_COLUMN } from "../segment-era";

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

// Hoisted out of SCHEMA_SQL because the reason vocabulary has to be widened on
// databases that already carry the table: a CHECK constraint cannot be ALTERed,
// so the only way to admit a new reason is to rebuild from this one definition.
// Keeping it in a constant is what stops the rebuilt table from drifting away
// from the created one.
const NOTE_DEBT_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS note_debt (
    turn_id INTEGER PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    prompt_number INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
      status IN ('pending', 'noted', 'skipped')
    ),
    -- Only a skipped debt carries a reason (D4's status vocabulary). 'closed'
    -- is residual settlement's claim-time write (D9): the session is gone, so
    -- the debt is written off rather than left blocking its window forever.
    -- 'declined' is the agent's own answer (裁决 24) — nothing worth noting, or
    -- the material has left its context — and is the only reason it writes.
    reason TEXT CHECK (
      reason IS NULL OR reason IN ('aged', 'rolled-back', 'closed', 'declined')
    ),
    opened_at_epoch INTEGER NOT NULL,
    closed_at_epoch INTEGER,
    updated_at_epoch INTEGER NOT NULL,
    reminded_at_epoch INTEGER
  );
`;

const NOTE_DEBT_INDEX_DDL = `
  CREATE INDEX IF NOT EXISTS idx_note_debt_open
    ON note_debt(session_id, status, prompt_number);
`;

// Hoisted for the same reason as NOTE_DEBT_TABLE_DDL: `trigger_type`'s CHECK
// constraint cannot be ALTERed, so widening it (spec note-prompt-clock D7,
// ticket 05: `sessionend` joins `compact`/`consecutive`/`residual`; the
// settlement-backfill ticket then adds `backfill`) requires rebuilding the table
// from this one definition rather than editing SCHEMA_SQL and a migration out of
// step with each other.
//
// Parametrised by table name because the rebuild follows SQLite's 12-step ALTER
// TABLE procedure: the NEW table is built under a temporary name and renamed
// INTO place last (see `ensureNoteSettlementTriggerVocabulary` for why renaming
// the old one away instead is unsafe here). One definition, several names —
// `ensureNoteSettlementJobsRetrySchema` (ticket 06) rebuilds from this SAME
// template a second time, once trigger_type's own widening has already landed.
const noteSettlementJobsTableDdl = (tableName: string): string => `
  CREATE TABLE IF NOT EXISTS ${tableName} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    -- Inclusive prompt_number bounds, FROZEN at enqueue. A turn that is decided
    -- after the window was cut joins the next window, never this one, so a retry
    -- settles the same set the first attempt saw.
    window_start INTEGER NOT NULL,
    window_end INTEGER NOT NULL,
    -- 'backfill' is the operator's explicit re-settlement of an already
    -- covered range (db/note-settlement.ts): the only value exempt from the
    -- monotonic window floor, and never produced by any automatic planner.
    trigger_type TEXT NOT NULL CHECK (
      trigger_type IN (
        'consecutive', 'compact', 'residual', 'sessionend', 'backfill'
      )
    ),
    -- 'abandoned' (ticket 06, read-write-contract spec "作业状态机相应扩展"):
    -- a DETERMINISTIC failure's own terminal state once it has spent its
    -- capped attempts — distinct from 'failed', which after this ticket is a
    -- retryable-pending-backoff intermediate state, never a resting place.
    -- A CHECK constraint cannot be ALTERed, so this widening travels through
    -- the same 12-step rebuild trigger_type's own history already uses
    -- (ensureNoteSettlementJobsRetrySchema).
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
      status IN ('pending', 'claimed', 'done', 'failed', 'abandoned')
    ),
    attempts INTEGER NOT NULL DEFAULT 0,
    -- Exponential backoff by TIMESTAMP COMPARISON, not by timer: the worker owns
    -- no clock for settlement, so a due retry is noticed in passing by the next
    -- trigger event rather than woken by anything. Ticket 06: backoff now
    -- applies to a DETERMINISTIC failure only — a transient one (see
    -- failure_class) returns straight to 'pending' with this left at "now",
    -- so the very next trigger event (not a timer) picks it up.
    retry_at_epoch INTEGER NOT NULL DEFAULT 0,
    claimed_at_epoch INTEGER,
    -- Ownership fence, bumped on every successful claim (settlement_jobs idiom).
    -- A dispatch whose lease expired CASes on the generation it was claimed
    -- under and so writes nothing over the attempt that displaced it.
    claim_generation INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    -- Ticket 06: which retry discipline the LAST recorded failure belongs to —
    -- null until a failure has landed at all. A transient failure
    -- (network/connection/SQLITE_BUSY, worker/note-settlement-dispatch.ts's
    -- classifySettlementFailure) never leaves a 'failed' row behind (it goes
    -- straight back to 'pending', uncounted); this column is populated only
    -- by the deterministic path, plus the one-time migration backfill below
    -- for rows that failed before the column existed.
    failure_class TEXT CHECK (
      failure_class IS NULL OR failure_class IN ('transient', 'deterministic')
    ),
    created_at_epoch INTEGER NOT NULL,
    updated_at_epoch INTEGER NOT NULL,
    UNIQUE(session_id, window_start, trigger_type)
  );
`;

const NOTE_SETTLEMENT_JOBS_TABLE_DDL = noteSettlementJobsTableDdl(
  "note_settlement_jobs",
);

const NOTE_SETTLEMENT_JOBS_INDEX_DDL = `
  CREATE INDEX IF NOT EXISTS idx_note_settlement_jobs_claim
    ON note_settlement_jobs(session_id, status, window_start);
`;

const SCHEMA_SQL = `
  -- ownership-and-note-cadence spec, "session 字段" ([S15069/T910]-[T913]):
  -- insight/next_steps/decision/done/current/reference are retired from
  -- EVERY read surface (injection, recall's session header, summary
  -- queries, tool-facing output) unconditionally — title and content are
  -- the session's only two remaining semantic fields. The physical columns
  -- stay: db/sessions.ts's write paths (upsertSession,
  -- updateSessionSummaryRewrite, updateSessionFields) still read/write them
  -- and are out of this ticket's scope (a settlement-side writer for
  -- content lands in a later ticket) — dropping the columns would break
  -- those INSERT/UPDATE statements. Existing rows keep whatever they have;
  -- nothing reads it back.
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_session_id TEXT UNIQUE NOT NULL,
    project TEXT NOT NULL,
    transcript_path TEXT,
    title TEXT,
    content TEXT,
    insight TEXT,
    next_steps TEXT,
    decision TEXT,
    done TEXT,
    current TEXT,
    reference TEXT,
    last_compact_turn INTEGER,
    summary_updated_at_epoch INTEGER,
    scan_cursor_byte_offset INTEGER NOT NULL DEFAULT 0,
    scan_cursor_line INTEGER NOT NULL DEFAULT 0,
    -- Ticket 13 (spec "节奏与建段指导"): the universal 20-turn remember
    -- reminder's own marker — "since the last remember call, any verb", a
    -- session-scoped fact no existing column carries (create/close/assign
    -- never even attribute a caller session on their own write paths, so
    -- there is nothing to derive this from). Stores the session's MAX turn
    -- ROW ID at the moment of the call (0 when no turn exists yet) — a turn
    -- id, not an epoch, because second-granularity timestamps cannot order
    -- turns against the call (peer round 2: same-second turns escaped the
    -- strict greater-than comparison; the id boundary also retires the old
    -- createdAtEpoch-minus-one fallback dance). NULL means "never called" — the
    -- reminder then counts every turn (anchor 0). Deliberately excluded
    -- from upsertSession's UPDATE SET list, the same "own dedicated setter,
    -- never the general upsert" treatment parent_session_id/lineage_status
    -- already get, so a routine SessionStart/UserPromptSubmit upsert cannot
    -- clobber it back to NULL.
    last_remember_turn_id INTEGER,
    created_at_epoch INTEGER NOT NULL,
    updated_at_epoch INTEGER,
    completed_at_epoch INTEGER
  );

  CREATE TABLE IF NOT EXISTS turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    prompt_number INTEGER NOT NULL,
    content_prompt_id TEXT,
    was_interrupted INTEGER NOT NULL DEFAULT 0,
    was_rolled_back INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    user_prompt TEXT,
    assistant_response TEXT,
    assistant_transcript TEXT,
    title TEXT,
    content TEXT,
    insight TEXT,
    -- Multi-valued (ticket 02, spec B5): a JSON array, matching segments.type
    -- exactly. Empty is never a claim (spec B7) — '[]' means "no activity word
    -- was stated", the same fact NULL used to carry. On a database that
    -- predates this shape, ensureTurnTypeMultiValueColumn rebuilds the table
    -- (a CHECK constraint cannot be ALTERed onto an existing column) and wraps
    -- every existing non-null scalar into a one-element array.
    --
    -- json_type(type) = 'array', not the looser json_valid(type) this
    -- shipped with (peer review P2 on ticket 02): json_valid alone admits
    -- any valid JSON value, so a JSON string ('"fix"') or object ('{"a":1}')
    -- passed the CHECK while parseJsonArray (db/turns.ts) casts the parsed
    -- result to a string array unconditionally — a row written by direct SQL
    -- under the loose CHECK crashes every array consumer downstream. A
    -- database that already rebuilt under the loose CHECK is rebuilt again by
    -- ensureTurnTypeMultiValueColumn (its staleness predicate detects the
    -- loose form too), so this only ever runs once per database going forward.
    type TEXT NOT NULL DEFAULT '[]' CHECK (json_type(type) = 'array'),
    significance_grade INTEGER CHECK (
      significance_grade IS NULL OR significance_grade BETWEEN 0 AND 4
    ),
    -- election_tier (ADR-0003) is RETIRED (ownership-and-note-cadence spec,
    -- ticket 06, "选举机器拆除"): the election-tier third grading semantics
    -- never carried real data in production (the era cutoff was never
    -- pinned), and settlement no longer assigns grade or tier at all (ticket
    -- 05). A database migrated under a pre-06 install may still carry the
    -- physical column — harmless and orphaned, never read or written by any
    -- code from here on; a fresh database never gets it. ADR-0003 is marked
    -- superseded; significance_grade above is UNRELATED and stays exactly as
    -- it was, old grade reads intact.
    --
    -- Ticket 02 (view-render-repair spec, "grading retires whole", ruled at
    -- [S15069/T1035]) closes the write surface ticket 05 left open above:
    -- the settlement turn-write facade
    -- (worker/note-settlement-turn-facade.ts) no longer ACCEPTS grade on
    -- any call either, so this column has no live writer left at all, not
    -- merely an unused prompt instruction. This CHECK, the column and the
    -- legacy read path (db/turns.ts, the pre-era milestone body in
    -- mcp/timeline.ts) are frozen-readable and physically UNTOUCHED — same
    -- "no physical drop" precedent supersedes already set.
    tags TEXT,
    files_read TEXT,
    files_modified TEXT,
    tool_call_count INTEGER,
    transcript_line_start INTEGER,
    -- Which stored records this turn's recall/replay calls actually hit (D4).
    -- JSON array of {ref, strength}, where ref is a type-prefixed global id
    -- (turn:8942, session:15069, obs:77, segment:4) so the namespace stays
    -- unambiguous when a later pass turns these into retrieval edges.
    consulted_memories TEXT,
    compact_boundary_uuid TEXT,
    created_at_epoch INTEGER NOT NULL,
    updated_at_epoch INTEGER,
    UNIQUE(session_id, prompt_number)
  );

  -- Process → mnemo-session identity map (spec D1, note guardrails ticket).
  -- The key is an environment-derived identity key, namespaced by the variable
  -- it came from (see deriveProcessIdentityKeys) — never the id mnemo keys
  -- sessions on (sessions.content_session_id, the hook payload's session_id),
  -- which no MCP process ever sees. UserPromptSubmit upserts one row per key it
  -- can derive, every turn, so the MCP entry point can turn "which process am
  -- I" into "which mnemo session is this". Several keys therefore name the same
  -- mnemo session — that redundancy is the point, since the reading process
  -- holds an environment snapshot taken at ITS spawn and shares only some of
  -- them. Superseded rows are left in place rather than cleaned up; a stale row
  -- is overwritten by the next session to claim that key, before any of that
  -- session's tool calls can read it.
  CREATE TABLE IF NOT EXISTS process_session_map (
    process_session_id TEXT PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    updated_at_epoch INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settlement_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    boundary INTEGER NOT NULL,
    frozen_member_ids TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
      status IN ('pending', 'claimed', 'done', 'failed')
    ),
    attempts INTEGER NOT NULL DEFAULT 0,
    claimed_at_epoch INTEGER,
    -- Ownership fence. Bumped on EVERY successful claim, including a lease
    -- reclaim, so a worker whose lease expired can be told apart from the one
    -- that holds the row now: completion and failure both CAS on the generation
    -- they were claimed under, and a stale owner's write matches nothing.
    claim_generation INTEGER NOT NULL DEFAULT 0,
    change_summary TEXT,
    last_error TEXT,
    created_at_epoch INTEGER NOT NULL,
    updated_at_epoch INTEGER NOT NULL,
    UNIQUE(session_id, boundary)
  );

  CREATE INDEX IF NOT EXISTS idx_settlement_jobs_session_status
    ON settlement_jobs(session_id, status, boundary);

  CREATE TABLE IF NOT EXISTS settlement_cursors (
    session_id INTEGER PRIMARY KEY
      REFERENCES sessions(id) ON DELETE CASCADE,
    last_settled_boundary INTEGER NOT NULL DEFAULT 0,
    updated_at_epoch INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS session_run_state (
    session_db_id INTEGER PRIMARY KEY
      REFERENCES sessions(id) ON DELETE CASCADE,
    start_turn_id INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    tool_name TEXT,
    tool_input TEXT,
    tool_result TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    title TEXT,
    content TEXT,
    -- Captured for the raw axis, withheld from the extraction pipeline: the
    -- row is never enqueued and never counted as work. See shared/note-tool.ts
    -- for why a note call must not become material for the old pipeline.
    excluded_from_extraction INTEGER NOT NULL DEFAULT 0,
    created_at_epoch INTEGER NOT NULL
  );

  -- P1 shadow store (spec D12). The main agent's own notes live entirely
  -- outside the turns table: nothing in the legacy extraction pipeline reads
  -- this table, and its text is deliberately NOT indexed into memory_fts. The
  -- trial compares agent-written notes against pipeline-written summaries
  -- offline, so a leak either way would invalidate the comparison it exists for.
  --
  -- turn_id is the PRIMARY KEY, which carries both invariants at once: one
  -- note per turn, and overwrite (not accumulate) on a repeat write — a note is
  -- rewritten whole, the way a session summary is.
  CREATE TABLE IF NOT EXISTS shadow_notes (
    turn_id INTEGER PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    insight TEXT,
    -- Mechanical provenance (D4), never caller-supplied. writer_model is NULL
    -- when the environment does not expose a model identity; ride_turn_id is
    -- the turn the session was on when the note was written, which is what makes
    -- "how long did this note wait" a fact rather than a reconstruction.
    writer_model TEXT,
    ride_turn_id INTEGER REFERENCES turns(id) ON DELETE SET NULL,
    -- Who authored this note. 'agent' is the main agent writing its own turn
    -- (the only P1 writer); 'settlement' is the P2 settlement pass reconstructing
    -- an INTERIOR HOLE — a turn whose debt was written off at residual-claim time
    -- but which later turns in the same window still depend on (spec D9, 裁决 20).
    -- The column exists so the P1 measurements never mistake a hindsight
    -- reconstruction for the agent's own compliance: every metric that counts
    -- notes filters on 'agent'.
    writer_origin TEXT NOT NULL DEFAULT 'agent' CHECK (
      writer_origin IN ('agent', 'settlement')
    ),
    created_at_epoch INTEGER NOT NULL,
    updated_at_epoch INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_shadow_notes_ride_turn
    ON shadow_notes(ride_turn_id);

  -- P1 note-debt ledger (spec D2/D3), shadow side like shadow_notes: it records
  -- which turns still owe a note and how each debt ended, and it never touches a
  -- turns row or its status — the legacy pipeline keeps sole ownership of those.
  --
  -- turn_id is the PRIMARY KEY: one debt per turn, and re-running the completion
  -- classification is an INSERT that loses the race rather than a second debt.
  -- A trivial turn (no substantive tool call) gets NO row at all — "not in the
  -- ledger" is the representation of "owes nothing", so the ledger's size tracks
  -- real debt rather than session length.
  ${NOTE_DEBT_TABLE_DDL}
  ${NOTE_DEBT_INDEX_DDL}

  -- How far the completion classification has already walked, per session. It is
  -- what keeps the sweep O(new turns) instead of O(session): without it, every
  -- trivial turn — which by design leaves no ledger row — would be re-examined
  -- on every tool call for the life of the session.
  --
  -- last_relief_prompt_number is the re-arm state of the backlog-relief
  -- injection (裁决 21): the turn the last relief rode, 0 when it has never
  -- fired. It lives here rather than in its own table because it is the same
  -- kind of fact as the classification cursor — one per-session watermark the
  -- ledger reads to decide what to do next — and because eligibility compares
  -- the two in one row read.
  CREATE TABLE IF NOT EXISTS note_debt_cursor (
    session_id INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    last_classified_prompt_number INTEGER NOT NULL DEFAULT 0,
    last_relief_prompt_number INTEGER NOT NULL DEFAULT 0,
    updated_at_epoch INTEGER NOT NULL
  );

  -- Exposure ledger (spec D7): every turn id this session has actually shown the
  -- main agent, and the turn it was shown during. P2's citation check reads it —
  -- a note may cite only ids its writer was shown — so a row must mean "rendered
  -- into the model's context", never "was in the ledger at the time".
  --
  -- Keyed by (ride_turn_id, exposed_turn_id): re-showing an id in a later turn
  -- adds a row, which is also the "a reminder already fired this turn" fact the
  -- at-most-once-per-turn rule reads.
  CREATE TABLE IF NOT EXISTS note_id_exposures (
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    ride_turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    exposed_turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK (source IN ('reminder', 'injection')),
    created_at_epoch INTEGER NOT NULL,
    PRIMARY KEY (session_id, ride_turn_id, exposed_turn_id, source)
  );

  CREATE INDEX IF NOT EXISTS idx_note_id_exposures_exposed
    ON note_id_exposures(session_id, exposed_turn_id);

  -- P2 note settlement jobs (spec D9, ticket 05). Deliberately a SEPARATE table
  -- from settlement_jobs: that one is the 0.8.4 two-phase GRADING settlement,
  -- keyed by an extracted-turn boundary ordinal and still live on the legacy
  -- path, while this one is keyed by a prompt-number window and is what D13
  -- retires the grading settlement in favour of. Sharing a table would couple a
  -- machine being retired to the machine retiring it.
  --
  -- Identity is (session, window_start, trigger_type): the enqueue is idempotent
  -- under replay, and the two triggers can each own a window that starts at the
  -- same place without one silently swallowing the other.
  ${NOTE_SETTLEMENT_JOBS_TABLE_DDL}
  ${NOTE_SETTLEMENT_JOBS_INDEX_DDL}

  -- The one-time settlement transition watermark (edge-mechanism-revision
  -- spec D8, tickets 05 + 09, [S15069/T1124]). Written ONCE by whichever
  -- build's migration first finds the marker row missing
  -- (ensureNoteSettlementWatermark, db/schema.ts) — never rewritten by any
  -- later migration or runtime code.
  --
  -- What it expresses is the set of turns ALREADY FINISHED at that instant,
  -- NOT "everything that existed" (ticket 09). A turn still active or
  -- provisional when the migration ran finishes normally afterwards and has
  -- to enter the automatic window like any other; the single global
  -- MAX(turns.id) high-water mark this shipped with could not state that —
  -- it cannot say "prompt 5 unfinished, prompt 9 finished" — so it walled a
  -- legitimately-unfinished turn out of automatic settlement forever.
  --
  -- Two facts, two tables:
  --
  --   note_settlement_watermark_state is the singleton MARKER. Its one row
  --   means "this build's transition has run" and nothing more; it is the
  --   one-shot gate for both halves of the migration (floors + job disposal).
  --   It cannot be folded into the per-session table below because it must
  --   exist even on a database that has no sessions at all — which is every
  --   fresh install, and every test fixture.
  --
  --   note_settlement_watermark_floors is the FINISHED SET, one row per
  --   session that had a non-empty one. finished_prompt_number is the last
  --   prompt number such that EVERY turn at or below it in that session was
  --   already out of active/provisional. A session with no row floors at
  --   0 and is fully in scope: either it did not exist at the transition, or
  --   its very first turn was still unfinished.
  --
  -- A contiguous prefix, not a MAX over the finished turns: a settlement
  -- window is a contiguous prompt-number range, so a per-turn exemption set
  -- is not expressible as a window floor, and a MAX would jump straight over
  -- the unfinished turn and strand it — the exact bug being fixed. The
  -- accepted consequence is the other side of that same coin: turns that were
  -- already finished but sit ABOVE an unfinished one are re-admitted to the
  -- automatic window. They were never settled by this build either, so
  -- admitting them settles them for the first time rather than twice.
  --
  -- Every AUTOMATIC settlement planner (consecutive/residual —
  -- db/note-settlement.ts) refuses to start a window at or below its session's
  -- floor; only an explicit manual backfill may still reach one.
  CREATE TABLE IF NOT EXISTS note_settlement_watermark_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    recorded_at_epoch INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS note_settlement_watermark_floors (
    session_id INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    finished_prompt_number INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS note_settlement_cursors (
    session_id INTEGER PRIMARY KEY
      REFERENCES sessions(id) ON DELETE CASCADE,
    -- Highest prompt_number such that every window at or below it is RESOLVED.
    -- A terminally failed window resolves too (terminal-state-must-abandon-and-
    -- continue): holding the cursor at it would wedge the session forever.
    last_settled_prompt_number INTEGER NOT NULL DEFAULT 0,
    updated_at_epoch INTEGER NOT NULL
  );

  -- Segments (spec D6): one coherent chapter of work on one theme (ticket 15:
  -- the theme lives on tags — a topic registry once named it separately, a
  -- mechanism-level synonym split, retired; CONTEXT.md's "Topic — retired").
  -- Same field shape as a turn — title / content / type / tag / status —
  -- because the reading surfaces (recall's type:/tag: filters, FTS, the
  -- glyph) are meant to work across granularities without a second
  -- vocabulary.
  --
  -- Deliberately NOT bound to a session: a segment outruns any one session,
  -- and one that had to name a single session would have to pick arbitrarily
  -- among its members' sessions. Membership (segment_members) carries that
  -- relation.
  --
  -- type and tags are JSON arrays (multi-value; a segment's type is the
  -- union of its members'). revision is the write fence: an open segment is a
  -- living document that concurrent settlements may both want to rewrite, so
  -- every write CASes on the revision it read (see db/segments.ts).
  CREATE TABLE IF NOT EXISTS segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT,
    -- Ticket 14 (spec K5): the segment's most reusable conclusion, including
    -- the routes ruled out and why. Same column as a turn's insight and the
    -- inverse default: a turn's is empty unless something durable was learned,
    -- a segment's is the point of the row.
    insight TEXT,
    type TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(type)),
    tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
    -- Ticket 05 (ADR-0005): the APPLICATION vocabulary is two values, no
    -- state machine — open = accepting writes and on the roster; closed =
    -- manually toggled off through remember's close verb, refuses
    -- append/replace, off the roster, still recall-able (spec D6: freeze
    -- history, not the present — an edge overturns a closed segment, never a
    -- rewrite). SEGMENT_STATUSES/SegmentStatus (db/segments.ts) enforce
    -- exactly those two values on every TYPED writer — createSegment,
    -- applySegmentWrites, toggleSegmentStatus — so no code path in this
    -- codebase can produce a delivered/abandoned row from here on.
    --
    -- The PHYSICAL CHECK below stays wide enough to also accept the retired
    -- arc-era words, deliberately NOT narrowed to match: those words are
    -- read-and-updated on 47 pre-existing production rows (recomputeSegment-
    -- Facets/the repair sweep issue plain UPDATEs against them that never
    -- touch status, and SQLite re-validates the WHOLE row's CHECK
    -- regardless of which columns changed), so a narrower CHECK would break
    -- facet maintenance on every one of them the moment this migration ran
    -- (see ensureSegmentStatusVocabulary, and its "why not narrow" note).
    status TEXT NOT NULL DEFAULT 'open' CHECK (
      status IN ('open', 'delivered', 'abandoned', 'closed')
    ),
    revision INTEGER NOT NULL DEFAULT 1,
    -- Ticket 15 (findings 1-3): "this segment owes a facet derivation".
    -- type/tags are derived from the members (spec K5a) and the derivation
    -- lives in TypeScript (db/segments.ts) because its ordering comes from the
    -- MEMORY_TYPES constant and its result has to be rewritten into the FTS
    -- row. A membership that LEAVES has no TypeScript writer at all — nothing
    -- in src/ deletes a turn or a session, the FK cascade below does it — so
    -- SQLite records the fact through the trigger under segment_members and
    -- repairStaleSegmentFacets performs the derivation at the next schema
    -- initialisation, which for this process family is every hook invocation.
    -- Bookkeeping, not a facet: no read surface renders it and no caller may
    -- state it.
    facets_stale INTEGER NOT NULL DEFAULT 0 CHECK (facets_stale IN (0, 1)),
    -- Working State (ADR-0001, ticket 02): the resuming worker's six fields,
    -- beside the summary trio above. Each stores a markdown row list ("- "
    -- rows, newline-joined), uncapped, maintained ONLY through remember
    -- (db/segments.ts's appendSegmentWorkingStateRows /
    -- replaceInSegmentWorkingStateField) — never applySegmentWrites, the
    -- settlement CAS path over the summary trio and structural fields
    -- (ADR-0002's one-writer-per-layer split). Plain nullable TEXT with no
    -- CHECK referencing another column, so a bare ALTER TABLE ... ADD COLUMN
    -- is legal SQLite on an existing database (ensureSegmentWorkingStateColumns
    -- below) — same shape of migration as significance_grade on turns, no
    -- 12-step rebuild needed.
    goal TEXT,
    constraints TEXT,
    decisions TEXT,
    done TEXT,
    next_steps TEXT,
    reference TEXT,
    created_at_epoch INTEGER NOT NULL,
    updated_at_epoch INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_segments_status_updated
    ON segments(status, updated_at_epoch);

  -- Segment membership (spec D6). Many-to-many on purpose: member turns need
  -- not be contiguous, and one turn can legitimately belong to two segments
  -- (a fix that also closes a review). The pair is the primary key, so
  -- re-asserting a membership is idempotent.
  CREATE TABLE IF NOT EXISTS segment_members (
    segment_id INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    created_at_epoch INTEGER NOT NULL,
    PRIMARY KEY (segment_id, turn_id)
  );

  CREATE INDEX IF NOT EXISTS idx_segment_members_turn
    ON segment_members(turn_id);

  -- Attachment (ADR-0005, ticket 02): a session's reference to a segment as
  -- loaded working memory — "binding rows accumulate, never expire, no
  -- detach". remember(attach) asserts a row idempotently
  -- (attachSegmentToSession, db/segments.ts); there is no writer that ever
  -- removes one. Consulted-only attachments (zero segment_members rows for
  -- the pair) are legal and expected — this table carries no relationship to
  -- membership at all, only to which sessions have loaded which segments.
  --
  -- PRIMARY KEY (session_id, segment_id): one row per pair, so attaching an
  -- already-attached segment is a no-op rather than a growing duplicate log.
  CREATE TABLE IF NOT EXISTS segment_attachments (
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    segment_id INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    created_at_epoch INTEGER NOT NULL,
    PRIMARY KEY (session_id, segment_id)
  );

  CREATE INDEX IF NOT EXISTS idx_segment_attachments_segment
    ON segment_attachments(segment_id);

  -- The RECORDED DETACH (lane-model-v12 ticket 23): this session said "not
  -- this segment", so auto-attach (mcp/note.ts) may not mint the binding back
  -- on the next tags write. Only auto-attach reads this table — every existing
  -- reader of segment_attachments is untouched, which is what keeps a detach
  -- from needing a filter in six places to mean anything.
  --
  -- A row here and a row in segment_attachments for the same pair are mutually
  -- exclusive by construction: attachSegmentToSession deletes this one,
  -- detachSegmentFromSession deletes that one and writes this (db/segments.ts).
  --
  -- Same key and same cascades as the table it vetoes, for the same reasons.
  CREATE TABLE IF NOT EXISTS segment_detachments (
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    segment_id INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    created_at_epoch INTEGER NOT NULL,
    PRIMARY KEY (session_id, segment_id)
  );

  -- Lane registry (lane-declaration spec D1, ticket 01). A lane is a
  -- DECLARED object identified by (segment, ONE tag) — no title, the tag is
  -- the name (the card pays per character). remember's declare/undeclare
  -- verbs (mcp/remember.ts, db/lanes.ts) are the only writers; which edges
  -- carry the tag is never mirrored here — that stays entirely in
  -- memory_edges.tags. ON DELETE CASCADE: a segment's own lanes have no
  -- meaning once the segment itself is gone.
  CREATE TABLE IF NOT EXISTS lanes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    segment_id INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    created_at_epoch INTEGER NOT NULL,
    UNIQUE(segment_id, tag)
  );

  CREATE INDEX IF NOT EXISTS idx_lanes_segment
    ON lanes(segment_id);

  -- Durable, per-phase migration ledger (lane-declaration spec D6: "durable,
  -- not log-only"). One row per phase NAME, written once — a phase is
  -- skipped only when ITS OWN row exists here, never inferred from another
  -- table's state (the lanes table existing is not proof M2 ran), because
  -- the first process to open an upgraded database is often a hook, and a
  -- crash between phases must not silently skip the rest forever. payload
  -- carries whatever that phase leaves for a LATER phase, or a LATER
  -- ticket, to consume — db/lanes.ts's runLaneRegistryMigration is the
  -- first writer, not the only intended one.
  CREATE TABLE IF NOT EXISTS migration_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    applied_at_epoch INTEGER NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload))
  );

  -- Segmentation exclusions (spec G7, ticket 09): the completion gate's
  -- anti-join needs a NEGATIVE fact — "this turn was reviewed under this
  -- job and deliberately assigned to no segment" — which segment_members
  -- cannot express (it is add-only and records membership, never its
  -- absence). Recording only the exceptions rather than an assigned/
  -- unassigned row per turn is deliberate: the window's non-excluded,
  -- non-member turns are simply gaps by default, which is what "absence is
  -- not a statement of absence" requires of the predicate that reads this
  -- table (db/note-settlement-completion.ts).
  --
  -- job_id, not a column on turns: a window is a frozen work unit (spec A2a),
  -- so the verdict has to say WHICH window issued it. A turn-level column
  -- would collapse that provenance and block a later repair job from
  -- re-adjudicating a turn a failed window never finished — a repair job's
  -- exclusion must be able to coexist with (and eventually supersede, by
  -- simply being the row a NEWER job's anti-join actually reads) an earlier
  -- job's verdict rather than overwrite a single shared cell.
  --
  -- PRIMARY KEY (job_id, turn_id): one verdict per turn per job, and
  -- re-declaring it (a retry replaying the same judgement) is idempotent by
  -- construction rather than by an application-level check.
  CREATE TABLE IF NOT EXISTS note_settlement_segment_exclusions (
    job_id INTEGER NOT NULL REFERENCES note_settlement_jobs(id) ON DELETE CASCADE,
    turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    created_at_epoch INTEGER NOT NULL,
    PRIMARY KEY (job_id, turn_id)
  );

  -- Same rationale as idx_segment_members_turn: a turn deletion's ON DELETE
  -- CASCADE still benefits from an index on the child's FK column, and
  -- job_id alone is already the leading column of the primary key above.
  CREATE INDEX IF NOT EXISTS idx_note_settlement_segment_exclusions_turn
    ON note_settlement_segment_exclusions(turn_id);

  -- note_settlement_membership_activity RETIRED (edge-ownership ticket 05,
  -- [S15069/T912]): the membership gate it served died with settlement's
  -- assign action; its DDL left with it and existing installations drop the
  -- orphan in dropRetiredMaintenanceState below.

  -- Homeless-cluster proposals (ticket 08, spec "Proposal"): settlement's
  -- text-only suggestion that several homeless turns form one new segment.
  -- NEVER a segment row and never auto-adopted — addresses/title are plain
  -- text, rendered to the next session (at most three, newest first) and
  -- handed to remember(create)'s own members field verbatim on approval
  -- (ticket 02's seed-address path). addresses is a JSON array of
  -- "S<session>/T<prompt>" strings, not a foreign key: a proposal survives
  -- even if this project later reshapes turn identity, and validating the
  -- addresses is the READER's job (they are re-validated by remember(create)
  -- itself at adoption time regardless).
  -- addresses_key (ticket 05, spec "propose 携幂等键"): the CANONICAL form of
  -- addresses (sorted, de-duplicated, JSON-encoded —
  -- db/note-settlement-proposals.ts's canonicalizeSettlementProposalAddresses)
  -- alongside the display-order original. A re-claimed job has a NEW job id
  -- (retry = new job, spec: "重试=新 job id,所以 job 作用域的 key 不能去重"),
  -- so the idempotency key is (session_id, addresses_key), not job-scoped —
  -- see the UNIQUE index below and ensureNoteSettlementProposalIdempotencyKey
  -- for how an existing installation gains this column and index.
  CREATE TABLE IF NOT EXISTS note_settlement_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL REFERENCES note_settlement_jobs(id) ON DELETE CASCADE,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    addresses TEXT NOT NULL CHECK (json_valid(addresses)),
    addresses_key TEXT,
    created_at_epoch INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_note_settlement_proposals_created
    ON note_settlement_proposals(created_at_epoch);

  CREATE UNIQUE INDEX IF NOT EXISTS idx_note_settlement_proposals_session_addresses
    ON note_settlement_proposals(session_id, addresses_key);

  -- Settlement retry debt (ticket 06, spec "重试"/"作业状态机相应扩展"): one
  -- row per window a DETERMINISTIC failure abandoned after spending its capped
  -- attempts — the window range plus why, so an operator's manual
  -- /settle backfill has something concrete to consume instead of having to
  -- rediscover the gap from note_settlement_jobs.status = 'abandoned' rows
  -- directly. Never written for a transient failure (it never reaches a
  -- terminal state at all — see failNoteSettlementJob).
  CREATE TABLE IF NOT EXISTS note_settlement_debts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL REFERENCES note_settlement_jobs(id) ON DELETE CASCADE,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    window_start INTEGER NOT NULL,
    window_end INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_at_epoch INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_note_settlement_debts_session
    ON note_settlement_debts(session_id, created_at_epoch);

  CREATE INDEX IF NOT EXISTS idx_turns_session_prompt
    ON turns(session_id, prompt_number);

  -- Ordered (status, created_at_epoch) rather than status alone: the stranded
  -- repair's derivation scan (worker/turn-liveness.ts listStrandedRepairDates)
  -- has no date bound at all — it reads the whole history looking for turns
  -- still in a live status — so without this it degrades to a table scan that
  -- grows with the corpus. Live turns are a small minority of the table, so
  -- seeking the two live statuses and reading created_at_epoch straight off the
  -- index turns that scan into a bounded one. A plain (status) index is a strict
  -- prefix of this one and would only add write cost.
  CREATE INDEX IF NOT EXISTS idx_turns_status_created
    ON turns(status, created_at_epoch);

  CREATE INDEX IF NOT EXISTS idx_turns_created_at
    ON turns(created_at_epoch);

  CREATE INDEX IF NOT EXISTS idx_observations_turn_id
    ON observations(turn_id);

  CREATE TABLE IF NOT EXISTS pending_queue (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    session_db_id INTEGER NOT NULL,
    claimed_at_epoch INTEGER,
    enqueued_at_epoch INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_pending_queue_unclaimed
    ON pending_queue(seq) WHERE claimed_at_epoch IS NULL;

  CREATE INDEX IF NOT EXISTS idx_pending_queue_session
    ON pending_queue(session_db_id, seq);

  CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_queue_diary_target
    ON pending_queue(kind, target_id) WHERE kind = 'diary';

  -- "does this turn already have a turn-stop queued" is asked once per candidate
  -- by the stranded scan and once per Stop by the hook, and without an index each
  -- ask scans the whole queue.
  CREATE INDEX IF NOT EXISTS idx_pending_queue_kind_target
    ON pending_queue(kind, target_id);

  CREATE TABLE IF NOT EXISTS diary_day_state (
    date TEXT PRIMARY KEY,
    watermark TEXT,
    settled_at_epoch INTEGER,
    needs_regen INTEGER NOT NULL DEFAULT 0,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_epoch INTEGER,
    terminal INTEGER NOT NULL DEFAULT 0,
    retry_disposition TEXT CHECK (
      retry_disposition IS NULL OR
      retry_disposition IN ('transient', 'permanent')
    ),
    last_error TEXT
  );

  -- Ledger for one-time, resumable data repairs. Keyed by a VERSIONED name so a
  -- future revision of the same repair is a new row rather than a re-run of the
  -- old one. The cursor is a session-id high-water mark: every examined row
  -- crosses it, including the ones the repair could not fix, so nothing is
  -- permanently re-selected and no row is counted twice.
  --
  -- The row doubles as the repair's lock. claim_generation / claimed_at_epoch
  -- are the same lease-and-fence idiom settlement_jobs uses: claiming bumps the
  -- generation, every later write CASes on it, so a displaced runner writes
  -- nothing instead of double-counting. deferred_until_epoch /
  -- deferral_attempts hold the backoff for a repair that cannot run yet (an
  -- unreadable transcript root) WITHOUT marking it done — the one-shot repair
  -- stays available for whenever the environment recovers.
  CREATE TABLE IF NOT EXISTS repair_ledger (
    name TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('running', 'done')),
    cursor_id INTEGER NOT NULL DEFAULT 0,
    filled_count INTEGER NOT NULL DEFAULT 0,
    unresolved_count INTEGER NOT NULL DEFAULT 0,
    ambiguous_count INTEGER NOT NULL DEFAULT 0,
    claim_generation INTEGER NOT NULL DEFAULT 0,
    claimed_at_epoch INTEGER,
    deferred_until_epoch INTEGER,
    deferral_attempts INTEGER NOT NULL DEFAULT 0,
    started_at_epoch INTEGER NOT NULL,
    completed_at_epoch INTEGER
  );

  CREATE TABLE IF NOT EXISTS diary_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- When the P2 era began (db/era.ts). One row, written once, by whichever
  -- production process looks first: the boundary has to survive restarts and
  -- clock changes because turns are already written against it.
  CREATE TABLE IF NOT EXISTS era_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    cutoff_epoch INTEGER NOT NULL,
    recorded_at_epoch INTEGER NOT NULL
  );

  -- Which build last migrated this database (db/build-state.ts). One row,
  -- rewritten whenever a different build runs the migrations. The resident
  -- worker cannot see a newer release from its own side — a plugin update
  -- installs into a new directory, so its plugin root, its bundle path and that
  -- file's mtime never move — and this row is the one thing both builds touch,
  -- so it is how the worker learns the schema changed underneath it.
  CREATE TABLE IF NOT EXISTS build_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    build_id TEXT NOT NULL,
    recorded_at_epoch INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    claim TEXT NOT NULL CHECK (length(claim) <= 300),
    rationale TEXT NOT NULL,
    scope TEXT NOT NULL,
    trigger_kind TEXT NOT NULL CHECK (
      trigger_kind IN ('prompt', 'tool', 'result', 'none')
    ),
    trigger_spec TEXT CHECK (
      (trigger_kind = 'none' AND trigger_spec IS NULL) OR
      (trigger_kind != 'none' AND trigger_spec IS NOT NULL AND json_valid(trigger_spec))
    ),
    status TEXT NOT NULL CHECK (
      status IN ('provisional', 'confirmed', 'refuted', 'retired', 'digest_only')
    ),
    evidence TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence)),
    created_at_epoch INTEGER NOT NULL,
    updated_at_epoch INTEGER NOT NULL,
    last_evidence_at_epoch INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rule_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_uid TEXT UNIQUE NOT NULL,
    rule_id INTEGER NOT NULL REFERENCES rules(id),
    event_kind TEXT NOT NULL,
    source_event_id INTEGER REFERENCES rule_events(id),
    turn_ref TEXT,
    label TEXT,
    rationale TEXT,
    adjustment_json TEXT CHECK (
      adjustment_json IS NULL OR json_valid(adjustment_json)
    ),
    status_before TEXT CHECK (
      status_before IS NULL OR
      status_before IN ('provisional', 'confirmed', 'refuted', 'retired', 'digest_only')
    ),
    status_after TEXT CHECK (
      status_after IS NULL OR
      status_after IN ('provisional', 'confirmed', 'refuted', 'retired', 'digest_only')
    ),
    created_at_epoch INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_rules_scope_status
    ON rules(scope, status);

  CREATE INDEX IF NOT EXISTS idx_rule_events_rule_created
    ON rule_events(rule_id, created_at_epoch, id);

  CREATE UNIQUE INDEX IF NOT EXISTS idx_rule_events_one_judgment_per_hit
    ON rule_events(source_event_id) WHERE event_kind = 'judgment';

  CREATE TRIGGER IF NOT EXISTS rules_no_hard_delete
    BEFORE DELETE ON rules
    BEGIN
      SELECT RAISE(ABORT, 'rules are append-only; retire or refute instead');
    END;

  CREATE TRIGGER IF NOT EXISTS rules_validate_trigger_spec_insert
    BEFORE INSERT ON rules
    WHEN NEW.trigger_kind != 'none' AND (
      length(CAST(NEW.trigger_spec AS BLOB)) > 1024 OR
      json_type(NEW.trigger_spec, '$.kind') IS NOT 'text' OR
      json_extract(NEW.trigger_spec, '$.kind') IS NOT NEW.trigger_kind OR
      (NEW.trigger_kind = 'prompt' AND (
        json_type(NEW.trigger_spec, '$.keywords') IS NOT 'array' OR
        json_array_length(NEW.trigger_spec, '$.keywords') NOT BETWEEN 1 AND 8 OR
        EXISTS (
          SELECT 1 FROM json_each(NEW.trigger_spec, '$.keywords')
          WHERE type != 'text' OR length(value) < 3
        ) OR
        (json_type(NEW.trigger_spec, '$.match') IS NOT NULL AND (
         json_type(NEW.trigger_spec, '$.match') IS NOT 'text' OR
         json_extract(NEW.trigger_spec, '$.match') NOT IN ('any', 'all')
        )) OR
        EXISTS (
          SELECT 1 FROM json_each(NEW.trigger_spec)
          WHERE key NOT IN ('kind', 'keywords', 'match')
        )
      )) OR
      (NEW.trigger_kind = 'tool' AND (
        json_type(NEW.trigger_spec, '$.tool') IS NOT 'text' OR
        length(json_extract(NEW.trigger_spec, '$.tool')) = 0 OR
        (json_type(NEW.trigger_spec, '$.require_param') IS NOT NULL AND
         (json_type(NEW.trigger_spec, '$.require_param') != 'text' OR
          length(json_extract(NEW.trigger_spec, '$.require_param')) = 0)) OR
        (json_type(NEW.trigger_spec, '$.param_absent') IS NOT NULL AND
         (json_type(NEW.trigger_spec, '$.param_absent') != 'text' OR
          length(json_extract(NEW.trigger_spec, '$.param_absent')) = 0)) OR
        (json_type(NEW.trigger_spec, '$.path_glob') IS NOT NULL AND
         (json_type(NEW.trigger_spec, '$.path_glob') != 'text' OR
          length(json_extract(NEW.trigger_spec, '$.path_glob')) = 0)) OR
        (json_type(NEW.trigger_spec, '$.command_prefix') IS NOT NULL AND (
          json_type(NEW.trigger_spec, '$.command_prefix') != 'array' OR
          json_array_length(NEW.trigger_spec, '$.command_prefix') NOT BETWEEN 1 AND 4 OR
          EXISTS (
            SELECT 1 FROM json_each(NEW.trigger_spec, '$.command_prefix')
            WHERE type != 'text' OR length(value) = 0
          )
        )) OR
        EXISTS (
          SELECT 1 FROM json_each(NEW.trigger_spec)
          WHERE key NOT IN (
            'kind', 'tool', 'require_param', 'param_absent',
            'command_prefix', 'path_glob'
          )
        )
      )) OR
      (NEW.trigger_kind = 'result' AND (
        (json_type(NEW.trigger_spec, '$.tool') IS NOT NULL AND
         (json_type(NEW.trigger_spec, '$.tool') != 'text' OR
          length(json_extract(NEW.trigger_spec, '$.tool')) = 0)) OR
        json_type(NEW.trigger_spec, '$.patterns') IS NOT 'array' OR
        json_array_length(NEW.trigger_spec, '$.patterns') NOT BETWEEN 1 AND 4 OR
        EXISTS (
          SELECT 1 FROM json_each(NEW.trigger_spec, '$.patterns')
          WHERE type != 'text' OR length(value) NOT BETWEEN 1 AND 64
        ) OR
        EXISTS (
          SELECT 1 FROM json_each(NEW.trigger_spec)
          WHERE key NOT IN ('kind', 'tool', 'patterns')
        )
      ))
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid trigger_spec');
    END;

  CREATE TRIGGER IF NOT EXISTS rules_validate_trigger_spec_update
    BEFORE UPDATE OF trigger_kind, trigger_spec ON rules
    WHEN NEW.trigger_kind != 'none' AND (
      length(CAST(NEW.trigger_spec AS BLOB)) > 1024 OR
      json_type(NEW.trigger_spec, '$.kind') IS NOT 'text' OR
      json_extract(NEW.trigger_spec, '$.kind') IS NOT NEW.trigger_kind OR
      (NEW.trigger_kind = 'prompt' AND (
        json_type(NEW.trigger_spec, '$.keywords') IS NOT 'array' OR
        json_array_length(NEW.trigger_spec, '$.keywords') NOT BETWEEN 1 AND 8 OR
        EXISTS (SELECT 1 FROM json_each(NEW.trigger_spec, '$.keywords') WHERE type != 'text' OR length(value) < 3) OR
        (json_type(NEW.trigger_spec, '$.match') IS NOT NULL AND (json_type(NEW.trigger_spec, '$.match') IS NOT 'text' OR json_extract(NEW.trigger_spec, '$.match') NOT IN ('any', 'all'))) OR
        EXISTS (SELECT 1 FROM json_each(NEW.trigger_spec) WHERE key NOT IN ('kind', 'keywords', 'match'))
      )) OR
      (NEW.trigger_kind = 'tool' AND (
        json_type(NEW.trigger_spec, '$.tool') IS NOT 'text' OR length(json_extract(NEW.trigger_spec, '$.tool')) = 0 OR
        (json_type(NEW.trigger_spec, '$.require_param') IS NOT NULL AND (json_type(NEW.trigger_spec, '$.require_param') != 'text' OR length(json_extract(NEW.trigger_spec, '$.require_param')) = 0)) OR
        (json_type(NEW.trigger_spec, '$.param_absent') IS NOT NULL AND (json_type(NEW.trigger_spec, '$.param_absent') != 'text' OR length(json_extract(NEW.trigger_spec, '$.param_absent')) = 0)) OR
        (json_type(NEW.trigger_spec, '$.path_glob') IS NOT NULL AND (json_type(NEW.trigger_spec, '$.path_glob') != 'text' OR length(json_extract(NEW.trigger_spec, '$.path_glob')) = 0)) OR
        (json_type(NEW.trigger_spec, '$.command_prefix') IS NOT NULL AND (json_type(NEW.trigger_spec, '$.command_prefix') != 'array' OR json_array_length(NEW.trigger_spec, '$.command_prefix') NOT BETWEEN 1 AND 4 OR EXISTS (SELECT 1 FROM json_each(NEW.trigger_spec, '$.command_prefix') WHERE type != 'text' OR length(value) = 0))) OR
        EXISTS (SELECT 1 FROM json_each(NEW.trigger_spec) WHERE key NOT IN ('kind', 'tool', 'require_param', 'param_absent', 'command_prefix', 'path_glob'))
      )) OR
      (NEW.trigger_kind = 'result' AND (
        (json_type(NEW.trigger_spec, '$.tool') IS NOT NULL AND (json_type(NEW.trigger_spec, '$.tool') != 'text' OR length(json_extract(NEW.trigger_spec, '$.tool')) = 0)) OR
        json_type(NEW.trigger_spec, '$.patterns') IS NOT 'array' OR
        json_array_length(NEW.trigger_spec, '$.patterns') NOT BETWEEN 1 AND 4 OR
        EXISTS (SELECT 1 FROM json_each(NEW.trigger_spec, '$.patterns') WHERE type != 'text' OR length(value) NOT BETWEEN 1 AND 64) OR
        EXISTS (SELECT 1 FROM json_each(NEW.trigger_spec) WHERE key NOT IN ('kind', 'tool', 'patterns'))
      ))
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid trigger_spec');
    END;

  CREATE TRIGGER IF NOT EXISTS rule_events_validate_source
    BEFORE INSERT ON rule_events
    WHEN
      (NEW.event_kind = 'judgment' AND (
        NEW.source_event_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM rule_events source
          WHERE source.id = NEW.source_event_id
            AND source.rule_id = NEW.rule_id
            AND source.event_kind = 'hit'
        )
      )) OR
      (NEW.event_kind != 'judgment' AND NEW.source_event_id IS NOT NULL)
    BEGIN
      SELECT RAISE(ABORT, 'source_event_id must link a judgment to a hit for the same rule');
    END;

  CREATE TRIGGER IF NOT EXISTS rule_events_no_update
    BEFORE UPDATE ON rule_events
    BEGIN
      SELECT RAISE(ABORT, 'rule_events is append-only');
    END;

  CREATE TRIGGER IF NOT EXISTS rule_events_no_delete
    BEFORE DELETE ON rule_events
    BEGIN
      SELECT RAISE(ABORT, 'rule_events is append-only');
    END;

  -- Read-write contract (db/write-gate.ts). A writer's license to write an
  -- entity, earned by that entity appearing in its injected context or a
  -- recall/timeline render (CONTEXT.md "Read grant"). Entity-level: one row
  -- per (writer, entity) — one appearance licenses every field. Non-
  -- destructive: a write does not delete another writer's grant row, it just
  -- leaves it behind the field's stamp sequence, which is what
  -- checkFieldGate compares to tell a genuinely never-read entity from one
  -- this writer read but that moved since ("Stale" vs "never-read",
  -- CONTEXT.md). entity_type widens to session up front — a CHECK
  -- constraint cannot be ALTERed, and ticket 05's settlement narrative write
  -- is the same table, not a second one.
  --
  -- light-review-repairs 04 (P1): epoch is the writer's own
  -- write_gate_epochs value at the moment this grant was recorded — the
  -- writer-context-epoch soundness boundary that replaced PreCompact's
  -- two-table DELETE. getReadGrant only returns a row whose epoch matches
  -- the writer's CURRENT epoch; a bump (PreCompact, and its
  -- SessionStart(compact) idempotent re-bump) makes every row recorded under
  -- an older epoch invisible without physically touching it — physical
  -- removal is deferred to the age/epoch janitor (sweepStaleReadGrants).
  -- DEFAULT 0 with no prior write_gate_epochs row also defaulting to 0
  -- (getWriterEpoch) keeps every pre-migration row's behavior byte-identical
  -- until its writer's first bump.
  CREATE TABLE IF NOT EXISTS write_gate_reads (
    writer TEXT NOT NULL,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('segment', 'turn', 'session')),
    entity_id INTEGER NOT NULL,
    read_at_epoch INTEGER NOT NULL,
    read_sequence INTEGER NOT NULL,
    epoch INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (writer, entity_type, entity_id)
  );

  CREATE INDEX IF NOT EXISTS idx_write_gate_reads_entity
    ON write_gate_reads (entity_type, entity_id);

  -- light-review-repairs 04 (P2): the age janitor filters on read_at_epoch
  -- alone (sweepStaleReadGrants) — without this, that scan has no index to
  -- seek from and degrades to a full table scan bounded only by its own
  -- LIMIT, i.e. the LIMIT bounds deletions, never the scan itself.
  CREATE INDEX IF NOT EXISTS idx_write_gate_reads_read_at
    ON write_gate_reads (read_at_epoch);

  -- One field's freshness stamp: who wrote it last, and at what point in the
  -- monotonic write sequence (CONTEXT.md "Stale") — never epoch seconds, so
  -- two writes landing in the same wall-clock second stay ordered (spec: the
  -- legacy yield gate's >= second comparison mis-ranks a same-second early
  -- write as late; this sequence has no such tie).
  CREATE TABLE IF NOT EXISTS write_gate_stamps (
    entity_type TEXT NOT NULL CHECK (entity_type IN ('segment', 'turn', 'session')),
    entity_id INTEGER NOT NULL,
    field TEXT NOT NULL,
    writer TEXT NOT NULL,
    write_sequence INTEGER NOT NULL,
    written_at_epoch INTEGER NOT NULL,
    PRIMARY KEY (entity_type, entity_id, field)
  );

  -- Per-field completeness (write-mode-edit-semantics spec D8, ticket 04 —
  -- the write gate's RECORD half only; what a write overwrite REQUIRES of
  -- this data is a later, blocked ticket). A render pass that shows one of a
  -- writer's own entities' fields records whether it delivered that field IN
  -- FULL or cut — keyed per writer, like a read grant, so two writers' own
  -- view of the same field's completeness never collide.
  --
  -- Deliberately entity_type + entity_id + field, NOT folded into
  -- write_gate_reads (which is entity-grain: one row licenses every field):
  -- completeness is a per-field fact of the write operation — a long
  -- field's truncation must not connect a short field on the same entity.
  --
  -- PRIMARY KEY (writer, entity_type, entity_id, field): one row per writer
  -- per field, upserted on every render — the LAST render to show a field
  -- decides its completeness (a field read truncated once and complete the
  -- next is complete, not permanently disqualified by the first read), the
  -- same "re-reading refreshes, never accumulates" rule write_gate_reads
  -- itself already follows.
  CREATE TABLE IF NOT EXISTS write_gate_field_completeness (
    writer TEXT NOT NULL,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('segment', 'turn', 'session')),
    entity_id INTEGER NOT NULL,
    field TEXT NOT NULL,
    complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
    -- The SAME monotonic counter write_gate_reads.read_sequence and
    -- write_gate_stamps.write_sequence key off (CONTEXT.md "Stale") — the
    -- render-start snapshot this fact belongs to (snapshotWriteGateSequence,
    -- captured before any row is read), never a record-time lookup.
    recorded_sequence INTEGER NOT NULL,
    recorded_at_epoch INTEGER NOT NULL,
    -- light-review-repairs 04 (P1): same writer-context-epoch fact as
    -- write_gate_reads.epoch, recorded at the same render pass — see that
    -- column's own comment. checkRelationsGate and checkFieldGate's
    -- requireCompleteRead both read through getFieldCompleteness, so a
    -- completeness row this writer earned before its last bump is exactly as
    -- dead as the grant row it rode in on.
    epoch INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (writer, entity_type, entity_id, field)
  );

  CREATE INDEX IF NOT EXISTS idx_write_gate_field_completeness_entity
    ON write_gate_field_completeness (entity_type, entity_id);

  -- light-review-repairs 04 (P2): same rationale as
  -- idx_write_gate_reads_read_at, for the janitor's other half of the sweep.
  CREATE INDEX IF NOT EXISTS idx_write_gate_field_completeness_recorded_at
    ON write_gate_field_completeness (recorded_at_epoch);

  -- The write gate's single monotonic counter (db/write-gate.ts). One row,
  -- incremented inside the SAME transaction as the field stamp it numbers —
  -- never read at epoch-second granularity, so two writers committing in the
  -- same second are still totally ordered against each other.
  CREATE TABLE IF NOT EXISTS write_gate_sequence (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    value INTEGER NOT NULL DEFAULT 0
  );

  -- light-review-repairs 04 (P1): one row per writer that has ever been
  -- bumped — PreCompact (the context an active writer's grants were earned
  -- on being destroyed) and SessionStart(source=compact)'s idempotent
  -- re-bump (the crash backstop for a PreCompact bump that failed). A writer
  -- with no row here is implicitly epoch 0 (getWriterEpoch), matching every
  -- pre-migration write_gate_reads/write_gate_field_completeness row's own
  -- DEFAULT 0 — so a writer nobody has ever bumped reads exactly as it did
  -- before this ticket. Deliberately its own tiny table rather than a column
  -- folded onto sessions/claims: a claim writer (claimWriterId) has no
  -- backing row in any entity table this schema owns, and the epoch counter
  -- must exist for it identically.
  CREATE TABLE IF NOT EXISTS write_gate_epochs (
    writer TEXT PRIMARY KEY,
    epoch INTEGER NOT NULL DEFAULT 0
  );

  ${MEMORY_FTS_DDL}
`;

// The universal edge table (spec D7; identity narrowed by ticket 05/spec C5,
// C13). Nodes are (kind, id) pairs — `turn`, `segment`, or (citing side only,
// C10) `session` — because the retired `turn_citations` table could not
// express a segment endpoint at all, and a citation graph split across two
// tables needed every reader to union them (spec C13's dual-graph bug: the
// timeline's correction graph and the segment ranking key disagreed about the
// same relation because they read different tables).
//
// Identity is (citing, cited, relation) — edge-mechanism-revision D2: ONE ROW
// PER RELATION, so the same pair can carry `depends-on` AND `encodes` at once
// (a landing turn states both its process cause and the ruling it carries),
// which the previous pair-only key could not express at all. Two constraints
// hold that shape:
//
//   - UNIQUE over all five columns: one row per (pair, relation), so a
//     restatement is idempotent rather than a duplicate;
//   - a PARTIAL unique index over the four pair columns WHERE relation IS
//     NULL: at most ONE bare row per pair. It cannot be a table constraint,
//     because SQLite's UNIQUE treats NULLs as distinct and would happily
//     store a hundred identical bare rows.
//
// A pair's bare row records nothing but "this pair exists"; the write path
// (db/memory-edges.ts) therefore skips a bare write onto a pair that already
// has any row, and drops the bare row when a relation row starts recording
// the same existence fact.
//
// The self-loop CHECK is the storage-layer half of a rule the write path also
// enforces (D2): a BARE node citing itself would inflate its own in-degree
// with no claim behind it, so no SQL path may mint one. Relation-matrix spec
// ticket 05 ("自引用") narrowed this from a blanket ban to bare rows only — a
// RELATION-carrying self row became storable, on the theory that a
// multi-phase turn may cite itself with a cross-phase word.
//
// lane-model-v12 D2 (ticket 04) RETRACTS that permission and takes the
// blanket ban back, in the CONTRACTED shape only: an edge's two ends must be
// different nodes, whatever the word. The validator layer already refuses
// every self edge with one reason (`shared/turn-phase.ts`'s
// `validateRelationTarget`, "self-edge"), and M-C deletes the legacy rows —
// so from ticket 09's shape onward the CHECK says it too, and "no self row
// may exist" stops depending on a migration having swept recently. The
// permissive arm survives in the EARLIER shapes because they are historical
// rebuild targets: a migration copying INTO one of them may still be
// carrying a row M-C has not reached yet.
//
// `provenance` stays outside the key — the audit layer telling you how the
// edge was learned, spanning five sources (spec C12: it must tell apart the
// main agent's own assertion `asserted`, a bare textual reference `text-ref`,
// and a settlement attribution `judged`, which the pre-ticket-05 column
// conflated). A relation is never overwritten in place any more (the old
// "non-null relation wins" upsert is retired): a wrong edge is RETRACTED
// (`retractMemoryEdges`, D3) and rewritten.
//
// No FOREIGN KEY on citing_id/cited_id: one INTEGER column spans the turn,
// segment and session id spaces, so a single REFERENCES clause can never be
// correct for all three. Endpoint deletion is instead covered by kind-aware
// `AFTER DELETE` triggers (spec C15, MEMORY_EDGE_ENDPOINT_TRIGGERS_DDL below)
// that remove an edge naming a deleted turn, segment or (outgoing-only)
// session — at the storage layer, so a cascade or a direct SQL delete cannot
// bypass it the way the deletion APIs alone could.
//
// Kept out of SCHEMA_SQL on purpose: `turn_citations` is retired by ticket 05
// (both alive on an insert-only migration was ruled out — spec C13), and its
// rows are folded in exactly once by `retireLegacyTurnCitationsTable` before
// the legacy table is dropped. "The table did not exist before this open" is
// still the gate a fresh install uses to skip that fold — the same idiom as
// ensureForkLineageColumns' one-time backfill.
//
// Flow-relations spec: the `relation` CHECK's word list is now a PARAMETER
// rather than a fixed literal, because the migration's two halves need
// DIFFERENT target lists alive at the SAME moment. Ticket 02 (the "expand
// half" — spec.md's migration item 3) widened the CHECK to old∪new — the
// retired seven-word set (evidence-for/evidence-against/depends-on/refines/
// encodes/grounded-on, plus supersedes and override which never moved) PLUS
// the eight-word vocabulary that replaces it (override/narrows/extends/
// collects/consume/grounds/verifies/refutes) — so renaming existing rows
// could run before any caller was rejected by a CHECK narrowed out from
// under it. Ticket 03 (the "contract half") narrows the SAME CHECK to the
// eight words + supersedes, once no old word remains. `MEMORY_EDGES_UNION_
// RELATION_WORDS` is this function's DEFAULT — every migration EARLIER than
// the contract narrow (`collapseAndRebuildMemoryEdges`'s pair-identity
// rebuild, `ensureMemoryEdgesRelationVocabulary`'s widen, both below) still
// targets it explicitly via `MEMORY_EDGES_UNION_DDL`: their copies are
// straight and non-remapping, so they need a CHECK wide enough to accept
// whatever word an as-yet-unrenamed row still carries, whichever stage of
// this file's migration chain first reaches them. `MEMORY_EDGES_CONTRACT_
// RELATION_WORDS` is the FINAL shape — `MEMORY_EDGES_DDL` (fresh-database
// creation, and `ensureMemoryEdgesRelationContract`'s own rebuild target)
// uses it: a fresh database is born already narrow, since it holds no
// legacy row an old word could describe. `supersedes` stays IN the CHECK
// permanently in BOTH lists — existing rows are frozen-readable and
// settlement's own facade may still write it — even though mcp/note.ts
// never offered it as a parameter (see db/citations.ts's CITATION_RELATIONS).
// NOTE: "CREATE TABLE IF NOT EXISTS" only applies whichever word list a
// caller passes to a FRESH database — an existing installation's physical
// CHECK constraint predates any given change; `ensureMemoryEdgesVocabularyFlip`
// and `ensureMemoryEdgesRelationContract` below rebuild it (renaming every
// existing row's `relation` value per the migration's mapping table in the
// same rebuild-and-swap pass, in EITHER direction — widen or narrow). (No
// backticks inside the DDL template literal below — it is a JS template
// string, and a stray backtick in a SQL comment would close it.)
const MEMORY_EDGES_UNION_RELATION_WORDS: readonly string[] = [
  "evidence-for",
  "evidence-against",
  "supersedes",
  "depends-on",
  "refines",
  "override",
  "encodes",
  "grounded-on",
  "narrows",
  "extends",
  "collects",
  "consume",
  "grounds",
  "verifies",
  "refutes",
];

// The eight-word-vocabulary contract list AS TICKET 03 (flow-relations spec)
// LEFT IT — `collects` still named, `supersedes` frozen-readable alongside it.
// Deliberately UNCHANGED by the indexes-rescope amendment (ticket 01,
// `.scratch/indexes-rescope/spec.md`): this is `ensureMemoryEdgesRelationContract`'s
// OWN historical rebuild target, paired with that function's OWN remap
// (`remapVocabularyFlipRelation`, which does not know the word `indexes` —
// that migration retired the SEVEN old words, not this one). A pre-0.14
// database doing a full-chain jump in one open still needs this function to
// land on a `collects`-bearing table exactly as it always has;
// `ensureMemoryEdgesIndexesRename` below is chained immediately after it in
// `ensureMemoryEdgesSchema` and finishes the job, renaming whatever
// `collects` row that rebuild left onto `indexes`.
const MEMORY_EDGES_CONTRACT_RELATION_WORDS: readonly string[] = [
  "override",
  "narrows",
  "extends",
  "collects",
  "consume",
  "grounds",
  "verifies",
  "refutes",
  "supersedes",
];

// The CURRENT final word list (indexes-rescope spec, ticket 01): `collects`
// renamed to `indexes`, same-phase aggregation, no graph-state gate. This is
// what a FRESH database is born with (`MEMORY_EDGES_DDL` below) and what
// `ensureMemoryEdgesIndexesRename`'s own rebuild narrows an existing
// installation onto.
const MEMORY_EDGES_INDEXES_RENAME_RELATION_WORDS: readonly string[] = [
  "override",
  "narrows",
  "extends",
  "indexes",
  "consume",
  "grounds",
  "verifies",
  "refutes",
  "supersedes",
];

// The CURRENT final word list (lane-model-v12 spec D4's M-D, ticket 03): the
// two words v12 does not have leave the CHECK, so the storage vocabulary is
// now EXACTLY the write vocabulary — `shared/turn-phase.ts`'s seven-word
// `EDGE_RELATIONS`, pinned equal by a guard test rather than imported (this
// file's every other word list is a literal, and a migration target that
// moved when a vocabulary constant moved would rewrite history).
//
// Both words go, not just `supersedes` (the only one spec D4 names): after
// M-B neither has a single stored row, neither is writable, and neither has
// an assertion field — they are in the SAME state, and the frozen-legacy
// carve-out that kept `supersedes` in the CHECK existed only to keep its
// existing rows readable. Once no such row can exist, a word left in the
// CHECK is a word the storage layer still promises to accept and nothing can
// ever produce: exactly the "one row, two readings" split this ticket removes
// from `segment-rank.ts`, relocated into the schema. Leaving `refutes` behind
// would also have re-armed the E2 deadlock the retraction mirrors existed for
// — a storable word with no retraction path — which is why the mirrors and
// this list are one decision (see `db/citations.ts`'s
// `RETRACTION_ONLY_RELATIONS`).
const MEMORY_EDGES_LANE_MODEL_V12_RELATION_WORDS: readonly string[] = [
  "override",
  "narrows",
  "extends",
  "indexes",
  "consume",
  "grounds",
  "verifies",
];

/**
 * Which lane shape a rebuild target is written in.
 *
 *   - `tags-only` — every HISTORICAL target in this file. Each one is the
 *     shape some earlier migration copied INTO, and a target that moved when a
 *     later ticket landed would rewrite history (same reasoning as the frozen
 *     relation-word lists above).
 *   - `two-sided` — lane-model-v12 ticket 05's EXPAND shape: `tail_tag` and
 *     `head_tag` alongside `tags`, all three in the identity key. M-A's
 *     rebuild target, and now a HISTORICAL one too — it is the shape M-A
 *     copies into and M-E copies straight back out of, in the same open.
 *   - `sides-only` — ticket 09's CONTRACT shape, and the CURRENT one: the
 *     merged `tags` column is gone and identity ends in the two sides alone.
 *     M-E's rebuild target. A fresh install is deliberately NOT born in it
 *     (see `MEMORY_EDGES_DDL`): creation runs before the lane-registry
 *     migration, whose ordering barrier reads the table's shape.
 */
type MemoryEdgesLaneShape = "tags-only" | "two-sided" | "sides-only";

function memoryEdgesTableDdl(
  tableName: string,
  relationWords: readonly string[] = MEMORY_EDGES_UNION_RELATION_WORDS,
  laneShape: MemoryEdgesLaneShape = "tags-only",
  // container-unification D10 (ticket 02): a relation-carrying row's two ends
  // must both be `turn`. FALSE on every HISTORICAL rebuild target above and on
  // `MEMORY_EDGES_DDL`'s own fresh-creation shape — same reasoning as every
  // other frozen target in this file: those copies are straight and must keep
  // accepting whatever a not-yet-cleaned database still holds (the 4 stray
  // `provenance='judged'` `turn→segment`/`segment→segment` rows this ticket
  // retires), so widening THEIR CHECK would turn an ordinary reopen into a
  // refused copy. TRUE only for `ensureMemoryEdgesRelationTurnScoped`'s own
  // rebuild target, which runs strictly after that cleanup and is the one
  // place the narrower CHECK is safe to enforce.
  relationScopedToTurns: boolean = false,
): string {
  const relationList = relationWords.map((word) => `'${word}'`).join(", ");
  const twoSided = laneShape !== "tags-only";
  const mergedTagSet = laneShape !== "sides-only";
  // lane-model-v12 ticket 05 (spec D1). ONE tag per side of the arc:
  // `tail_tag` is the CITING node's lane (the subject), `head_tag` the CITED
  // node's (the object). A cross-lane relation is a row whose two sides
  // differ — the fact v11's single tag set structurally could not hold.
  //
  // NOT NULL with the EMPTY STRING as the "not settled yet" sentinel, never
  // NULL, and this is the whole reason the columns look the way they do: both
  // join the UNIQUE key below, and SQLite's UNIQUE does not de-duplicate
  // NULLs — under a nullable pair the SAME unsettled edge could be inserted
  // twice over, which is exactly the idempotency `tags = '[]'` happens to
  // give today. The price is that EVERY reader has to know the convention,
  // which is why it is stated here, at the column, rather than in a spec: an
  // empty string is not a lane named "", it is the absence of an answer, and
  // settlement's own queue is "the rows where both sides are ''".
  //
  // Both sides carry a tag or neither does (spec D2): a half-settled edge is
  // refused by the write gate (v12 ticket 08), not by a CHECK here — the
  // storage layer has never been where lane legality is decided.
  const sideTagColumns = twoSided
    ? `
    tail_tag TEXT NOT NULL DEFAULT '',
    head_tag TEXT NOT NULL DEFAULT '',`
    : "";
  // rubric-v10 ticket 01 ("边的身份"), RETIRED by lane-model-v12 ticket 09 —
  // the whole column, its CHECK and this comment leave together in the
  // `sides-only` shape, so a reader of a contracted table's stored DDL is
  // never told about a column it does not have.
  //
  // What it was: the row's IMMUTABLE canonical lane-tag set — a JSON array,
  // sorted and deduped at write time (db/memory-edges.ts's
  // canonicalizeTagSet), '[]' = untagged. It joined the UNIQUE key below, so
  // the SAME (pair, relation) could legally hold several rows, one per
  // distinct tag set. The CHECK only ever refused malformed JSON; it cannot
  // enforce "sorted, deduped" in SQL, so canonicalization was a write-path
  // property guarded by a test, not by the schema.
  //
  // Why it went: one tag per SIDE says everything the set said, plus the one
  // thing it structurally could not — which END names which lane — so a
  // merged set kept beside the two sides could only ever be a second, weaker
  // copy for the write path to keep in step.
  const mergedTagSetColumn = mergedTagSet
    ? `
    tags TEXT NOT NULL DEFAULT '[]' CHECK (
      json_valid(tags) AND json_type(tags) = 'array'
    ),`
    : "";
  // The expand half kept `tags` IN the key while it was still the
  // authoritative read source (v12 tickets 06/07/08 moved the readers). The
  // CONTRACT shape drops that component with the column, and only THEN does
  // "two side combinations on one (pair, relation) are two rows" become an
  // independent property — while `tags` was in the key the two sides were a
  // FUNCTION of it, so removing them changed nothing but DDL text. A
  // behavioural test pins it from ticket 09 onward
  // (`tests/db/memory-edges.test.ts`, "two DIFFERENT side combinations").
  const identityKey = mergedTagSet
    ? `UNIQUE (citing_kind, citing_id, cited_kind, cited_id, relation, tags${
        twoSided ? ", tail_tag, head_tag" : ""
      })`
    : "UNIQUE (citing_kind, citing_id, cited_kind, cited_id, relation, tail_tag, head_tag)";
  // lane-model-v12 D2 (ticket 04), and the reason M-C does not have to rescan
  // on every open. M-C is a ONE-TIME sweep of the legacy rows; what makes "no
  // self row exists" a STANDING fact rather than a fact as of the last sweep
  // is this CHECK, in the CONTRACTED shape the database ends every open in.
  // A restore, or any internal writer reaching past `writeMemoryEdges`, is
  // refused by the table itself.
  //
  // SHAPE-GATED, not global: `tags-only` and `two-sided` are HISTORICAL
  // rebuild targets that earlier migrations copy into unfiltered, and M-C
  // runs after some of them — a blanket ban there would turn a legacy self
  // row from "swept by M-C" into "the open fails on a raw SQLITE_CONSTRAINT
  // three migrations before M-C can reach it".
  const selfEdgeCheck =
    laneShape === "sides-only"
      ? "CHECK (citing_kind <> cited_kind OR citing_id <> cited_id)"
      : "CHECK (citing_kind <> cited_kind OR citing_id <> cited_id OR relation IS NOT NULL)";
  // container-unification D10: the relation graph is turn→turn. A BARE row
  // (`relation IS NULL`) is untouched by this clause on purpose — it is the
  // text-ref prose-citation index (spec: "散文里出现 [S…]/[E…] 时自动记下的引用
  // 索引"), a different population the ticket explicitly leaves alone.
  const relationTurnScopedCheck = relationScopedToTurns
    ? `,
    CHECK (relation IS NULL OR (citing_kind = 'turn' AND cited_kind = 'turn'))`
    : "";
  return `
  CREATE TABLE IF NOT EXISTS ${tableName} (
    -- rubric-v10 ticket 01 (lane model, "边的身份"): the surrogate row id —
    -- every edge assertion is now (citing, cited, relation, lanes) with its
    -- own id, so a caller (retraction, the side index) can address ONE row
    -- precisely instead of a whole (pair, relation) group.
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    citing_kind TEXT NOT NULL CHECK (citing_kind IN ('turn', 'segment', 'session')),
    citing_id INTEGER NOT NULL,
    cited_kind TEXT NOT NULL CHECK (cited_kind IN ('turn', 'segment')),
    cited_id INTEGER NOT NULL,
    relation TEXT CHECK (
      relation IS NULL OR
      relation IN (${relationList})
    ),
    provenance TEXT NOT NULL CHECK (
      provenance IN ('retrieval', 'text-ref', 'rollback', 'judged', 'asserted')
    ),${mergedTagSetColumn}${sideTagColumns}
    created_at_epoch INTEGER NOT NULL,
    -- The self-edge ban. Two arms in the CONTRACTED shape (no self row of any
    -- kind, lane-model-v12 D2), three in the historical ones (relation-matrix
    -- ticket 05's widening) -- see selfEdgeCheck above for why the shapes
    -- differ. No backticks in this comment on purpose: it lives inside a
    -- template literal.
    ${selfEdgeCheck}${relationTurnScopedCheck},
    -- The lane columns join the identity key. relation's own
    -- NULL-is-distinct behaviour under SQLite UNIQUE means this alone cannot
    -- cap a pair's BARE rows at one -- idx_memory_edges_bare_pair below (a
    -- partial index over the four pair columns only, ignoring relation and
    -- lanes) still carries that "existence record of last resort" invariant
    -- unchanged; it predates all of this and none of it touches that index.
    ${identityKey}
  );
`;
}

// Kept apart from the table DDL because every rebuild below has to re-run
// them: an index belongs to the table it was built on, so it dies with the
// table a rebuild drops (and a rename drags its NAME along, which is what
// makes a bare `IF NOT EXISTS` re-exec silently skip).
const MEMORY_EDGES_INDEXES_DDL = `
  CREATE INDEX IF NOT EXISTS idx_memory_edges_cited
    ON memory_edges(cited_kind, cited_id, relation);

  CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_edges_bare_pair
    ON memory_edges(citing_kind, citing_id, cited_kind, cited_id)
    WHERE relation IS NULL;
`;

// The WIDE shape (ticket 02's "expand half"). Every migration EARLIER than
// the contract narrow (`collapseAndRebuildMemoryEdges`'s pair-identity
// rebuild, `ensureMemoryEdgesRelationVocabulary`'s widen) targets this, not
// `MEMORY_EDGES_DDL` below: their copies are straight and non-remapping, so
// they need a CHECK wide enough to accept whatever word an as-yet-unrenamed
// row still carries, regardless of which stage of this file's migration
// chain first reaches them.
const MEMORY_EDGES_UNION_DDL = `${memoryEdgesTableDdl("memory_edges", MEMORY_EDGES_UNION_RELATION_WORDS)}${MEMORY_EDGES_INDEXES_DDL}`;

// The CURRENT final, narrow shape. Fresh-database creation
// (`ensureMemoryEdgesSchema`'s unconditional trailing `db.exec` below) uses
// this — a fresh install is born with `indexes`, never `collects`, so it
// skips both `ensureMemoryEdgesRelationContract` (targets the OLDER
// `collects`-bearing `MEMORY_EDGES_CONTRACT_RELATION_WORDS`, ticket 03's own
// shape) and `ensureMemoryEdgesIndexesRename` below — `hasTable` gates BOTH
// out for a first creation, same as every earlier migration in this chain.
// Since lane-model-v12 M-D it is also born WITHOUT the two retired words, so
// `ensureMemoryEdgesLaneModelV12RelationContract` (which probes for
// `'supersedes'` in the stored DDL) skips a fresh install too.
//
// STILL ONE-SIDED, deliberately, even though `initializeSchema` leaves every
// database two-sided by the time it returns (ticket 05's M-A, last phase of
// the v12 slot). Creation happens EARLY in that function and the lane
// registry migration runs LATE, and ticket 01's barrier refuses a pending
// registry phase against an already-v12-shaped table. A database that has
// turns but no `memory_edges` at all — the pre-edge-table era, and the shape
// several schema fixtures reproduce — would create this table fresh, and a
// two-sided creation would trip that barrier on a perfectly ordinary upgrade.
// So creation stays in the pre-v12 shape and M-A expands it in the same open,
// which lands the identical table by a route the barrier can still police.
const MEMORY_EDGES_DDL = `${memoryEdgesTableDdl("memory_edges", MEMORY_EDGES_LANE_MODEL_V12_RELATION_WORDS)}${MEMORY_EDGES_INDEXES_DDL}`;

// rubric-v10 ticket 01: the tag-keyed QUERY index — one row per (edge row,
// tag), never a second source of truth. Semantics always read the edge row's
// own `tags` set; this table exists so "which rows carry tag X" is an
// indexed lookup instead of a `json_each` scan over every edge.
//
// MIGRATION-ERA as of lane-model-v12 ticket 09, and created CONDITIONALLY
// because of it (`ensureMemoryEdgesSchema`): this index exists exactly as
// long as the column it indexes does. Its last reader left at ticket 06 (the
// checker's three lane passes moved to `memory_edge_side_tags`); what kept it
// alive afterwards was maintenance, not consumption. M-E drops it in the same
// transaction that drops `memory_edges.tags`, and an unconditional
// `CREATE TABLE IF NOT EXISTS` here would silently resurrect it, empty, on
// the very next open.
const MEMORY_EDGE_TAGS_DDL = `
  CREATE TABLE IF NOT EXISTS memory_edge_tags (
    edge_row_id INTEGER NOT NULL REFERENCES memory_edges(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY (edge_row_id, tag)
  );

  CREATE INDEX IF NOT EXISTS idx_memory_edge_tags_tag
    ON memory_edge_tags(tag, edge_row_id);
`;

/**
 * lane-model-v12 ticket 05 (spec D1): the SIDE-aware query index — the same
 * kind of object as `memory_edge_tags` above, one shape later.
 *
 * A SECOND table rather than a `side` column bolted onto that one, and the
 * reason was the expand step's own contract: ticket 05 added the columns and
 * dual-wrote them while `memory_edges.tags` stayed the authoritative read
 * source, so re-keying the old table on `(edge_row_id, side)` would have
 * capped it at two rows per edge and made a still-legal multi-tag write
 * (three tags, one row) vanish from its readers — a behaviour change in the
 * half of the batch whose whole promise was that nothing observable moves.
 * Ticket 09 dropped the old table outright once nothing read it, so this is
 * now the only edge tag index there is.
 *
 * `PRIMARY KEY (edge_row_id, side)` — ONE value per side, which is the model
 * itself (a side has a lane or it has none), not a storage convenience. The
 * old table's `(edge_row_id, tag)` key could not express "this tag is on BOTH
 * ends of this edge": that is two facts and it had room for one.
 *
 * An UNSETTLED side contributes NO ROW: `tail_tag = ''` is the absence of an
 * answer, and materialising it as a row tagged `''` would put a lane named
 * nothing into every `side, tag` lookup. So "which edges has settlement not
 * reached" is a question for `memory_edges` (both sides `''`), never a
 * missing-row inference here.
 *
 * Same two properties as its predecessor: ON DELETE CASCADE off
 * `memory_edges.id` keeps it consistent under retraction with no caller
 * remembering to sweep, and it is fully REBUILDABLE from the edge row's own
 * two columns (`rebuildMemoryEdgeSideTagsIndex`, db/memory-edges.ts), so it
 * carries no semantics of its own — only lookup speed.
 */
const MEMORY_EDGE_SIDE_TAGS_DDL = `
  CREATE TABLE IF NOT EXISTS memory_edge_side_tags (
    edge_row_id INTEGER NOT NULL REFERENCES memory_edges(id) ON DELETE CASCADE,
    side TEXT NOT NULL CHECK (side IN ('tail', 'head')),
    tag TEXT NOT NULL,
    PRIMARY KEY (edge_row_id, side)
  );

  CREATE INDEX IF NOT EXISTS idx_memory_edge_side_tags_tag
    ON memory_edge_side_tags(side, tag, edge_row_id);
`;

// Spec C15: the retired `turn_citations` table carried `ON DELETE CASCADE`;
// `memory_edges` cannot, because citing_id/cited_id are shared across three
// id spaces and a single REFERENCES clause would validate against the wrong
// table for two of them. These triggers are the storage-layer replacement —
// deliberately triggers rather than a check in the deletion APIs, because a
// cascade (turns.session_id → sessions) or a direct SQL DELETE bypasses any
// API-layer guard. Each is kind-aware in BOTH the citing and cited column: a
// turn id and a segment id can collide numerically, so a trigger keyed on id
// alone would delete the wrong node's edges.
//
// A session is never a citation TARGET (spec C10: `cited_kind` stays
// turn/segment), so its trigger only needs the outgoing direction. Turns and
// segments can be either endpoint, so both get both directions.
//
// SQLite fires AFTER DELETE triggers for rows removed by an ON DELETE CASCADE
// action, not only for a direct DELETE — verified against this project's own
// engine, not assumed — so deleting a session cascades to its turns (existing
// FK) and each cascaded turn still fires memory_edges_prune_deleted_turn.
const MEMORY_EDGE_ENDPOINT_TRIGGERS_DDL = `
  CREATE TRIGGER IF NOT EXISTS memory_edges_prune_deleted_turn
    AFTER DELETE ON turns
    BEGIN
      DELETE FROM memory_edges
      WHERE (citing_kind = 'turn' AND citing_id = OLD.id)
         OR (cited_kind = 'turn' AND cited_id = OLD.id);
    END;

  CREATE TRIGGER IF NOT EXISTS memory_edges_prune_deleted_segment
    AFTER DELETE ON segments
    BEGIN
      DELETE FROM memory_edges
      WHERE (citing_kind = 'segment' AND citing_id = OLD.id)
         OR (cited_kind = 'segment' AND cited_id = OLD.id);
    END;

  CREATE TRIGGER IF NOT EXISTS memory_edges_prune_deleted_session
    AFTER DELETE ON sessions
    BEGIN
      DELETE FROM memory_edges
      WHERE citing_kind = 'session' AND citing_id = OLD.id;
    END;

  -- Phase-connectivity retype audit (phase-connectivity ticket 01, spec
  -- "Compound-retype is not a free pass"): one row per settlement write that
  -- turns a landing-only turn (type intersects implement/fix/refactor, no
  -- basis word) into a compound one by ADDING a basis word (design/
  -- correction/measure/research/review) — the added word and the writer's
  -- own reason, not a line in the transient commit report. A NEW table
  -- rather than a turns column: this fact belongs to ONE write EVENT, not
  -- to the turn's current state, and a new table avoids the turns-table
  -- conditional-column toll entirely.
  CREATE TABLE IF NOT EXISTS phase_retype_audits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL REFERENCES note_settlement_jobs(id) ON DELETE CASCADE,
    turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    old_types TEXT NOT NULL CHECK (json_valid(old_types)),
    new_types TEXT NOT NULL CHECK (json_valid(new_types)),
    basis_word TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at_epoch INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_phase_retype_audits_turn
    ON phase_retype_audits(turn_id);

  -- Lane disposition justifications (severed-lane ticket 02, spec "The
  -- refined form"): one row per JUSTIFIED fracture, bound to a component
  -- fingerprint (segment, lane tag, the two current representative turn
  -- ids) so a later topology change (a stitch, a further split) invalidates
  -- an old justify by construction — the fingerprint simply stops matching
  -- any CURRENT fracture the re-run checker reports, with no separate
  -- invalidation pass needed.
  --
  -- The two *_content_sequence columns are phase-connectivity ticket 08
  -- decision 3: the write-gate sequence each representative's "content" field
  -- stood at when the justification was ACCEPTED. The fingerprint invalidates
  -- a justification whose TOPOLOGY moved; these invalidate one whose semantic
  -- INPUT moved. Without them a justify was fresh for one instant and durable
  -- forever — read B whole, justify A<->B, edit B's content, commit, and the
  -- gate passed on evidence that no longer described B; a later job inherited
  -- the same row permanently, since the lookup keys on
  -- (segment, lane_tag, fingerprint) alone. DEFAULT 0 rather than NULL so a
  -- row written before this ticket reads as "content had never been written",
  -- which fails closed against any representative that carries a stamp.
  CREATE TABLE IF NOT EXISTS lane_disposition_justifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL REFERENCES note_settlement_jobs(id) ON DELETE CASCADE,
    segment_id INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    lane_tag TEXT NOT NULL,
    component_fingerprint TEXT NOT NULL,
    representative_a INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    representative_b INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    representative_a_content_sequence INTEGER NOT NULL DEFAULT 0,
    representative_b_content_sequence INTEGER NOT NULL DEFAULT 0,
    reason TEXT NOT NULL,
    created_at_epoch INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_lane_disposition_justifications_fingerprint
    ON lane_disposition_justifications(segment_id, lane_tag, component_fingerprint);

  -- Lane read receipts (severed-lane ticket 02, spec "Recall-before-justify
  -- cannot be enforced from the prompt alone"): one row per lane-scoped
  -- recall ("E<n>/#<tag>") call, naming the membership it saw and the
  -- members it actually RENDERED — the SELECTOR fact today's plain read
  -- grant (write_gate_reads, entity ids only) cannot express, and what a
  -- justify's read obligation (db/lane-disposition.ts) is checked against.
  --
  -- phase-connectivity ticket 05: rendered_member_ids REPLACED a
  -- page_coverage column that stored page NUMBERS. A page number says
  -- nothing about how much was seen without the page size that produced it,
  -- and the page size was never recorded — so three pages at pageSize 1
  -- "covered" a 25-member lane. See ensureLaneReadMemberCoverageReceipts
  -- for why the migration drops the legacy rows rather than translating
  -- them.
  CREATE TABLE IF NOT EXISTS lane_read_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reader_id TEXT NOT NULL,
    segment_id INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    lane_tag TEXT NOT NULL,
    membership_snapshot TEXT NOT NULL CHECK (json_valid(membership_snapshot)),
    rendered_member_ids TEXT NOT NULL CHECK (json_valid(rendered_member_ids)),
    sequence INTEGER NOT NULL,
    created_at_epoch INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_lane_read_receipts_lane
    ON lane_read_receipts(reader_id, segment_id, lane_tag);

  -- Lane run touches (phase-connectivity ticket 04, "a touch ledger as
  -- durable as the writes it guards"): the mandatory-disposition gate's
  -- "touched" set, as ROWS rather than as a Set on a live engine instance.
  -- Every settlement write commits immediately in its own transaction while
  -- the engine's in-memory sets die with the attempt, so an attempt that
  -- landed a severing write and then died left the next attempt looking at
  -- an untouched fracture — and settlement caps attempts at 3, so that is an
  -- ordinary path, not an exotic one. A touch row is written INSIDE the same
  -- transaction as the write that produced it, so a rolled-back write leaves
  -- no touch behind either.
  --
  -- Keyed by JOB, never by claim generation: a reclaimed claimant inherits
  -- the obligation its predecessor created, which is the whole point of a
  -- durable ledger.
  --
  -- entity_id is polymorphic by touch_kind — a turn id for 'turn-tag' (an
  -- edge side, or a tag a tags write added or removed), a segment id for
  -- 'lane' (a lane the run addressed directly: a justify, or the lane a
  -- removed tag belonged to). It therefore carries no FK of its own; a row
  -- whose entity is later deleted simply stops matching anything the checker
  -- reports, which is the same "stops matching" invalidation the justify
  -- fingerprint relies on.
  CREATE TABLE IF NOT EXISTS lane_run_touches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL REFERENCES note_settlement_jobs(id) ON DELETE CASCADE,
    touch_kind TEXT NOT NULL CHECK (touch_kind IN ('turn-tag', 'lane')),
    entity_id INTEGER NOT NULL,
    lane_tag TEXT NOT NULL,
    created_at_epoch INTEGER NOT NULL
  );

  -- UNIQUE, so a restated edge side or a re-asserted tag is an idempotent
  -- no-op (INSERT OR IGNORE) rather than a row per repetition.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_lane_run_touches_key
    ON lane_run_touches(job_id, touch_kind, entity_id, lane_tag);
`;

/**
 * Ticket 15 (findings 1-2): the two facet inputs a TypeScript writer cannot be
 * made to notice, recorded as a debt on `segments.facets_stale` and paid by
 * `repairStaleSegmentFacets` (db/segments.ts).
 *
 * Same reasoning as `MEMORY_EDGE_ENDPOINT_TRIGGERS_DDL` above, one level up:
 * triggers rather than a check in the write APIs, because a cascade or a direct
 * SQL statement bypasses any API-layer guard. What is different here is that
 * the trigger cannot do the repair itself — the derivation's order comes from
 * the `MEMORY_TYPES` constant and its result has to be rewritten into the
 * segment's FTS row, neither of which is expressible in SQL — so it records the
 * fact and leaves the derivation where its one definition already lives.
 *
 *   - MEMBER REMOVED: a turn or session deletion never names `segment_members`;
 *     the FK cascade removes the row. Nothing in `src/` deletes either (grep),
 *     so there is no call site to hook and this trigger is the only writer that
 *     ever sees the event. Verified on this engine that a cascade fires an
 *     AFTER DELETE trigger — the same fact the memory-edge triggers rely on.
 *   - MEMBER'S FACETS REWRITTEN: `db/turns.ts` recomputes immediately (the FTS
 *     facet has to be right for the settlement window that just revised the
 *     turn, not at the next process start), so for that path this trigger only
 *     writes a flag the same statement's caller clears a moment later. It earns
 *     its place on the writers that do NOT go through `updateTurnById` —
 *     `hooks/capture-repair.ts` rewrites `type`/`tags` in raw SQL when it claims
 *     a compact boundary, and `retireTopicRegistry`'s fold below rewrites
 *     `tags` in bulk during migration. The `WHEN` clause holds it to a value
 *     that actually MOVED, and db/turns.ts gates its immediate recomputation on
 *     the same question, so the two never disagree about whether a derivation
 *     is owed — a debt raised by a write that changed nothing would be paid by
 *     the next process start instead, which is the expensive direction: a
 *     recomputation is ~16 ms on the live database, nearly all of it the FTS
 *     rewrite.
 */
const SEGMENT_FACET_STALE_TRIGGERS_DDL = `
  CREATE TRIGGER IF NOT EXISTS segments_facets_stale_on_member_removed
    AFTER DELETE ON segment_members
    BEGIN
      UPDATE segments SET facets_stale = 1 WHERE id = OLD.segment_id;
    END;

  CREATE TRIGGER IF NOT EXISTS segments_facets_stale_on_member_facets_written
    AFTER UPDATE OF type, tags ON turns
    WHEN OLD.type IS NOT NEW.type OR OLD.tags IS NOT NEW.tags
    BEGIN
      UPDATE segments SET facets_stale = 1
      WHERE id IN (SELECT segment_id FROM segment_members WHERE turn_id = NEW.id);
    END;
`;

function hasTable(db: Database, table: string): boolean {
  return (
    db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(table) !== null
  );
}

/**
 * Legacy relation remap (spec C2, applied here because ticket 05's schema
 * rebuild and the `turn_citations` fold are the only two places old
 * four-value rows are ever read again). `implements` was measured at 96%
 * `depends-on` — always a special case of dependency — so it remaps outright
 * (and, since flow-relations ticket 03 retired `depends-on` itself, straight
 * on to `consume`, its own replacement — the two renames compose rather than
 * stopping at the intermediate word). `builds-on` split three ways under
 * blind re-labelling (62% depends-on / 18% no relation / 16% evidence-for)
 * with no per-row way to tell which is which; remapping it to any single new
 * value would silently reinterpret roughly a third of it, which the ticket
 * forbids ("builds-on is not depends-on at the row level, even though 62% of
 * it measured that way"). It keeps its PAIR (a citation genuinely existed)
 * and loses its RELATION — becomes bare/unattributed — rather than either
 * being dropped or guessed at.
 *
 * `turn_citations`' own CHECK admits exactly two more legacy words, handled
 * explicitly below rather than through `isCitationRelation`: `supersedes` and
 * `evidence-for` — one of the six words flow-relations ticket 03 retired
 * (renamed to `verifies`). Falling through to `isCitationRelation` for either
 * would be WRONG: `CITATION_RELATIONS` (db/citations.ts) narrowed to the
 * final vocabulary, so an unresolved `evidence-for` would fail that check and
 * silently DROP the relation (become bare) instead of landing as `verifies`
 * — a correctness regression this migration must not introduce. The
 * `isCitationRelation` fallback stays only as a defensive net for a value
 * outside `turn_citations`' own four-word CHECK, which should be unreachable
 * on any real row.
 *
 * `supersedes` used to remap to ITSELF, the one word that survived every
 * earlier rename. Lane-model-v12 ticket 03 ends that: the word leaves the
 * vocabulary AND `memory_edges`' CHECK, so a legacy row folded under it would
 * now be refused by the very table it is being folded into. It remaps onto
 * `override` here for the same reason M-B rewrites the stored rows onto it —
 * that is what the word means in the seven-word vocabulary. This fold runs on
 * `isFirstCreation` only, i.e. BEFORE M-B could ever see the row, so the
 * remap has to happen here rather than being left to the migration.
 */
function remapLegacyRelation(relation: string): CitationRelation | null {
  if (relation === "implements") {
    return "consume";
  }
  if (relation === "builds-on") {
    return null;
  }
  if (relation === "evidence-for") {
    return "verifies";
  }
  if (relation === "supersedes") {
    return "override";
  }
  return isCitationRelation(relation) ? relation : null;
}

interface LegacyRelationCandidate {
  relation: string;
  provenance: EdgeProvenance;
  createdAtEpoch: number;
}

/**
 * Collapses every candidate row a legacy (pre-ticket-05) schema allowed for
 * ONE pair into the single row the new pair-identity schema can hold. A
 * candidate that remaps to a real relation always beats one that remaps to
 * null (losing a classification a stronger source assigned is worse than
 * discarding a weaker source's redundant bare mention); among relation-
 * bearing candidates the higher-authority provenance wins by
 * `PROVENANCE_RANK` — this one-time historical collapse is that ranking's
 * ONLY remaining use (spec C14 removed it from `writeMemoryEdges`'s live
 * conflict resolution, which now replaces relation and provenance together
 * unconditionally rather than ranking them); ties fall back to a stable,
 * arbitrary total order so the choice is deterministic. The returned
 * timestamp is the EARLIEST across every candidate, preserving "when did
 * this edge first appear" through the collapse.
 */
function pickWinningLegacyRelation(
  candidates: readonly LegacyRelationCandidate[],
): { relation: CitationRelation | null; provenance: EdgeProvenance; createdAtEpoch: number } {
  const remapped = candidates.map((candidate) => ({
    relation: remapLegacyRelation(candidate.relation),
    provenance: candidate.provenance,
    createdAtEpoch: candidate.createdAtEpoch,
  }));

  const winner = [...remapped].sort((left, right) => {
    const leftHasRelation = left.relation !== null ? 1 : 0;
    const rightHasRelation = right.relation !== null ? 1 : 0;
    if (leftHasRelation !== rightHasRelation) {
      return rightHasRelation - leftHasRelation;
    }
    const rankDiff =
      rankEdgeProvenance(right.provenance) - rankEdgeProvenance(left.provenance);
    if (rankDiff !== 0) {
      return rankDiff;
    }
    if (left.relation !== right.relation) {
      return (left.relation ?? "").localeCompare(right.relation ?? "");
    }
    return left.createdAtEpoch - right.createdAtEpoch;
  })[0]!;

  return {
    relation: winner.relation,
    // The winning candidate's OWN provenance travels with its relation — the
    // same discipline a live upsert keeps (relation and provenance never come
    // from two different rows). Only the timestamp is pooled across the whole
    // group, preserving "when did this edge first appear" through the collapse.
    provenance: winner.provenance,
    createdAtEpoch: Math.min(...remapped.map((candidate) => candidate.createdAtEpoch)),
  };
}

/**
 * Ticket 05 (spec C5): identity narrows from (citing, cited, relation) to
 * (citing, cited) — relation becomes a nullable ATTRIBUTE, so an unattributed
 * citation can be stored and correcting a relation updates the row instead of
 * inserting a second one. A CHECK constraint / PRIMARY KEY cannot be ALTERed,
 * so a database still carrying the old five-column key needs a rebuild — and
 * the rebuild must also COLLAPSE whatever that wider key allowed: a pair that
 * carried two rows under two different relations now fits in one.
 *
 * Detection reads the stored DDL rather than a version counter, so a fresh
 * database (created straight from the current MEMORY_EDGES_DDL) skips this —
 * same idiom as `noteDebtReasonVocabularyIsStale`.
 */
function memoryEdgesSchemaIsStale(db: Database): boolean {
  const storedDdl =
    db
      .query<{ sql: string | null }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_edges'",
      )
      .get()?.sql ?? null;
  if (storedDdl === null) {
    return false;
  }
  // Flow-relations spec, ticket 03: 'depends-on' is now a RETIRED word — the
  // relation contract migration removes it from the CHECK once no row still
  // carries it. Its permanent absence from an already-modern database would
  // otherwise misreport "stale" on every future open and re-trigger the
  // pair-only collapse below against a table this build's multi-relation
  // identity already spans correctly, silently merging any pair that
  // legitimately carries several relations down to one. Short-circuit on
  // the structural marker every later rebuild in this file already shares
  // (the self-loop CHECK, introduced by edge-mechanism-revision ticket 01
  // and never removed since): its presence alone proves this table is
  // already past whatever shape this function exists to fix, independent of
  // which relation words its CHECK currently allows.
  if (storedDdl.includes("citing_kind <> cited_kind")) {
    return false;
  }
  return !storedDdl.includes("'depends-on'");
}

function collapseAndRebuildMemoryEdges(db: Database): void {
  db.exec("ALTER TABLE memory_edges RENAME TO memory_edges_pre_pair_identity");
  db.exec(MEMORY_EDGES_UNION_DDL);

  const legacyRows = db
    .query<
      {
        citingKind: string;
        citingId: number;
        citedKind: string;
        citedId: number;
        relation: string;
        provenance: EdgeProvenance;
        createdAtEpoch: number;
      },
      []
    >(
      `SELECT
         citing_kind AS citingKind, citing_id AS citingId,
         cited_kind AS citedKind, cited_id AS citedId,
         relation, provenance, created_at_epoch AS createdAtEpoch
       FROM memory_edges_pre_pair_identity`,
    )
    .all();

  const groups = new Map<string, typeof legacyRows>();
  for (const row of legacyRows) {
    const key = `${row.citingKind} ${row.citingId} ${row.citedKind} ${row.citedId}`;
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      groups.set(key, [row]);
    }
  }

  const insert = db.query<
    unknown,
    [string, number, string, number, string | null, string, number]
  >(
    `INSERT INTO memory_edges (
       citing_kind, citing_id, cited_kind, cited_id,
       relation, provenance, created_at_epoch
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const bucket of groups.values()) {
    const sample = bucket[0]!;
    // A self-loop is not storable any more (the new table's own CHECK), and a
    // schema so old that it could hold one must not be able to abort the open
    // it is being migrated by. Dropping it is lossless in the only sense that
    // matters: the row asserted a node cites itself, which no reader has ever
    // counted.
    if (
      sample.citingKind === sample.citedKind &&
      sample.citingId === sample.citedId
    ) {
      continue;
    }
    const winner = pickWinningLegacyRelation(bucket);
    insert.run(
      sample.citingKind,
      sample.citingId,
      sample.citedKind,
      sample.citedId,
      winner.relation,
      winner.provenance,
      winner.createdAtEpoch,
    );
  }

  db.exec("DROP TABLE memory_edges_pre_pair_identity");
  db.exec(MEMORY_EDGES_INDEXES_DDL);
}

function ensureMemoryEdgesPairIdentity(db: Database): void {
  // A read, not a decision: it only says whether taking the write lock is
  // worth it — the same double-check idiom as ensureNoteDebtReasonVocabulary.
  if (!memoryEdgesSchemaIsStale(db)) {
    return;
  }

  runWriteTransaction(db, () => {
    if (!memoryEdgesSchemaIsStale(db)) {
      return;
    }
    collapseAndRebuildMemoryEdges(db);
  });
}

/**
 * Edge-ownership ticket 01: the relation CHECK widened with the four new
 * vocabulary words (`refines`/`override`/`encodes`/`grounded-on`). A CHECK
 * cannot be ALTERed, so an existing database still carrying the four-word
 * list needs the rebuild-and-copy idiom — a STRAIGHT copy, unlike
 * `collapseAndRebuildMemoryEdges` above: pair identity already holds, only
 * the CHECK text changes. Detection reads the stored DDL for the newest word
 * (`'grounded-on'`), so a fresh database and an already-widened one both
 * skip on one probe. Without this, production rejects every new-vocabulary
 * edge at the INSERT — the exact release blocker ticket 01 flagged.
 */
function memoryEdgesRelationVocabularyIsStale(db: Database): boolean {
  const storedDdl =
    db
      .query<{ sql: string | null }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_edges'",
      )
      .get()?.sql ?? null;
  if (storedDdl === null) {
    return false;
  }
  // Flow-relations spec, ticket 03: same fix as `memoryEdgesSchemaIsStale`
  // above, same reason — 'grounded-on' is now retired by the relation
  // contract migration, so its permanent absence from an already-modern
  // database would otherwise misreport "stale" forever and re-trigger this
  // function's own straight (non-remapping) copy, which unconditionally
  // drops every true self-loop row — including a LEGITIMATE modern
  // self-citing `grounds` row (settlement+implementer), a real, current
  // feature this function predates.
  if (storedDdl.includes("citing_kind <> cited_kind")) {
    return false;
  }
  return !storedDdl.includes("'grounded-on'");
}

function ensureMemoryEdgesRelationVocabulary(db: Database): void {
  if (!memoryEdgesRelationVocabularyIsStale(db)) {
    return;
  }
  runWriteTransaction(db, () => {
    if (!memoryEdgesRelationVocabularyIsStale(db)) {
      return;
    }
    db.exec(
      "ALTER TABLE memory_edges RENAME TO memory_edges_pre_relation_vocabulary",
    );
    db.exec(MEMORY_EDGES_UNION_DDL);
    db.exec(
      `INSERT INTO memory_edges (
         citing_kind, citing_id, cited_kind, cited_id,
         relation, provenance, created_at_epoch
       )
       SELECT
         citing_kind, citing_id, cited_kind, cited_id,
         relation, provenance, created_at_epoch
       FROM memory_edges_pre_relation_vocabulary
       WHERE citing_kind <> cited_kind OR citing_id <> cited_id`,
    );
    db.exec("DROP TABLE memory_edges_pre_relation_vocabulary");
    // The rename dragged the indexes along to the old table (a rename keeps
    // index names), so MEMORY_EDGES_DDL's IF NOT EXISTS above saw the names
    // and skipped; now that the old table's drop took them with it, this
    // re-exec builds them against the new table — the same trailing re-exec
    // `collapseAndRebuildMemoryEdges` needs for the same reason.
    db.exec(MEMORY_EDGES_INDEXES_DDL);
  });
}

/**
 * Edge-mechanism-revision ticket 01 (D2): identity widens from the pair to
 * (pair, relation), a self-loop CHECK enters the table, and a partial unique
 * index pins the bare row to at most one per pair. None of the three is
 * ALTERable, so an installation still carrying the four-column PRIMARY KEY
 * needs SQLite's rebuild-and-swap.
 *
 * Detection reads the stored DDL for the self-loop CHECK — the one clause
 * unique to this shape — so a fresh database and an already-migrated one both
 * skip on a single probe, the same idiom as the two rebuilds above.
 */
function memoryEdgesMultiRelationIsStale(db: Database): boolean {
  const storedDdl =
    db
      .query<{ sql: string | null }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_edges'",
      )
      .get()?.sql ?? null;
  return storedDdl !== null && !storedDdl.includes("citing_kind <> cited_kind");
}

/**
 * Build under a temporary name, copy, DROP the original, rename the
 * replacement INTO the original's name — never rename the original away. The
 * three `AFTER DELETE` prune triggers (on `turns`/`segments`/`sessions`) name
 * `memory_edges` in their bodies, and a rename-away is the one shape where an
 * engine that rewrites trigger bodies would silently repoint them at a table
 * this function is about to drop; the swap direction is correct either way.
 * The triggers themselves are untouched by the swap, which is what keeps
 * ticket 01's "cascade behaviour survives the migration" requirement true
 * without re-creating them here.
 *
 * `PRAGMA foreign_keys` is a no-op inside a transaction, so it is turned off
 * on the connection before `runWriteTransaction` opens one and restored after;
 * `foreign_key_check` runs INSIDE the transaction (0.11.0-era migration
 * precedent), because a check after the commit turns a violation into a
 * durable swap plus a skipped migration.
 */
function ensureMemoryEdgesMultiRelation(db: Database): void {
  if (!memoryEdgesMultiRelationIsStale(db)) {
    return;
  }

  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    runWriteTransaction(db, () => {
      if (!memoryEdgesMultiRelationIsStale(db)) {
        return;
      }

      db.exec(memoryEdgesTableDdl("memory_edges_multi_relation_rebuild"));
      // Explicit column list on both sides. The old key made every source row
      // unique under the new one (one row per pair is one row per (pair,
      // relation) too), so the copy is straight — no collapse, no relabel.
      // The one filtered case is a self-loop, which the new CHECK refuses:
      // today's database holds none, and an unmigratable row must not be able
      // to abort the open that would migrate it.
      db.exec(
        `INSERT INTO memory_edges_multi_relation_rebuild (
           citing_kind, citing_id, cited_kind, cited_id,
           relation, provenance, created_at_epoch
         )
         SELECT
           citing_kind, citing_id, cited_kind, cited_id,
           relation, provenance, created_at_epoch
         FROM memory_edges
         WHERE citing_kind <> cited_kind OR citing_id <> cited_id`,
      );
      db.exec("DROP TABLE memory_edges");
      db.exec(
        "ALTER TABLE memory_edges_multi_relation_rebuild RENAME TO memory_edges",
      );
      // The indexes belonged to the dropped table and died with it.
      db.exec(MEMORY_EDGES_INDEXES_DDL);

      const violations = db
        .query<Record<string, unknown>, []>("PRAGMA foreign_key_check")
        .all();
      if (violations.length > 0) {
        throw new Error(
          `memory_edges rebuild left ${violations.length} foreign key violation(s) while widening identity to (pair, relation): ${JSON.stringify(violations)}`,
        );
      }
    });
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
}

/**
 * Relation-matrix spec ticket 05 ("自引用"): the self-loop CHECK widens once
 * more — a BARE self row (`relation IS NULL`) stays banned, a RELATION-
 * carrying one becomes storable. A CHECK constraint cannot be ALTERed, so an
 * installation still carrying the pre-ticket-05 CHECK needs the same
 * rebuild-and-swap idiom `ensureMemoryEdgesMultiRelation` above uses.
 *
 * Detection reads the stored DDL for the new CHECK's own arm
 * (`relation IS NOT NULL`) — absent on every pre-ticket-05 database (the OLD
 * self-loop CHECK bans a self row outright, relation or not — its own text is
 * `relation IS NULL OR relation IN (...)`, never the phrase `IS NOT NULL`) and
 * present once this migration has run, so a fresh database (born from
 * `memoryEdgesTableDdl`, already in the new shape) and an already-migrated
 * one both skip on one probe.
 *
 * SECOND CLAUSE — the `id` column — and it is not belt-and-braces. That DDL
 * marker stopped being monotonic the moment lane-model-v12 D2 (ticket 04)
 * took ticket 05's widening BACK for the contracted shape: M-E's table bans
 * every self row again, so its text carries no `relation IS NOT NULL` either,
 * and the probe above alone would read a fully migrated database as pristine
 * pre-ticket-05 stock. The consequence is not a wasted rebuild but SILENT
 * DATA LOSS of exactly ticket 09's shape — the copy below names the
 * PRE-SURROGATE columns only, so every reopen would rewrite `memory_edges`
 * without `id`, `tail_tag` or `head_tag`, dropping every lane attribution in
 * the database and un-keying both tag indexes.
 *
 * `id` is the disambiguator because this migration runs STRICTLY BEFORE
 * `ensureMemoryEdgesTagSetIdentity` (which mints that column) in
 * `ensureMemoryEdgesSchema`, and that order is chronological: a table still
 * carrying the pre-ticket-05 CHECK predates the surrogate key by two tickets,
 * so it cannot have one. Every shape from ticket 01 onward — contracted
 * included — does. Two databases whose CHECK text is byte-identical are then
 * still told apart, under a column no later migration in this chain removes.
 */
function memoryEdgesSelfReferenceCheckIsStale(db: Database): boolean {
  const storedDdl =
    db
      .query<{ sql: string | null }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_edges'",
      )
      .get()?.sql ?? null;
  if (storedDdl === null || storedDdl.includes("relation IS NOT NULL")) {
    return false;
  }
  return !db
    .query<{ name: string }, []>("SELECT name FROM pragma_table_info('memory_edges')")
    .all()
    .some((row) => row.name === "id");
}

/**
 * Same rebuild-under-a-temporary-name-then-swap shape as
 * `ensureMemoryEdgesMultiRelation`: build the new table, copy, drop the old
 * one, rename the replacement into place — never rename the original away
 * (the three endpoint prune triggers name `memory_edges` in their bodies).
 *
 * Unlike every earlier `memory_edges` rebuild, this copy is UNFILTERED — a
 * straight `SELECT *`, no `WHERE` clause at all. The new CHECK is strictly
 * WIDER than the old one (bare self stays banned; everything the old CHECK
 * already accepted, it still accepts), so every row already stored — self or
 * not — already satisfies it; there is nothing left to drop. That is what
 * makes this migration byte-lossless, the one property the spec calls out by
 * name ("自引用的 CHECK 重建...数据无损").
 */
function ensureMemoryEdgesSelfReferenceCheck(db: Database): void {
  if (!memoryEdgesSelfReferenceCheckIsStale(db)) {
    return;
  }

  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    runWriteTransaction(db, () => {
      if (!memoryEdgesSelfReferenceCheckIsStale(db)) {
        return;
      }

      db.exec(memoryEdgesTableDdl("memory_edges_self_reference_rebuild"));
      db.exec(
        `INSERT INTO memory_edges_self_reference_rebuild (
           citing_kind, citing_id, cited_kind, cited_id,
           relation, provenance, created_at_epoch
         )
         SELECT
           citing_kind, citing_id, cited_kind, cited_id,
           relation, provenance, created_at_epoch
         FROM memory_edges`,
      );
      db.exec("DROP TABLE memory_edges");
      db.exec(
        "ALTER TABLE memory_edges_self_reference_rebuild RENAME TO memory_edges",
      );
      // The indexes belonged to the dropped table and died with it.
      db.exec(MEMORY_EDGES_INDEXES_DDL);

      const violations = db
        .query<Record<string, unknown>, []>("PRAGMA foreign_key_check")
        .all();
      if (violations.length > 0) {
        throw new Error(
          `memory_edges rebuild left ${violations.length} foreign key violation(s) while widening the self-loop CHECK: ${JSON.stringify(violations)}`,
        );
      }
    });
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
}

/**
 * Flow-relations spec, ticket 02 (spec.md's migration items 1-3): the
 * mechanical rename map — `depends-on`->`consume`, `evidence-for`->
 * `verifies`, `evidence-against`->`refutes`, `grounded-on`->`grounds`,
 * `refines`->`extends` (BLANKET, T1202's ruling: T906/T952/T913's known
 * subtraction cases are deliberately included, not special-cased here),
 * `encodes`->`grounds` (the encodes/grounded-on MERGE). `override` and
 * `supersedes` are absent — both keep their own value unchanged. `narrows`/
 * `collects` never appear on the left because no stored row carries them yet
 * (spec: "narrows/collects start empty").
 */
const VOCABULARY_FLIP_RENAME: Readonly<Record<string, string>> = {
  "depends-on": "consume",
  "evidence-for": "verifies",
  "evidence-against": "refutes",
  "grounded-on": "grounds",
  refines: "extends",
  encodes: "grounds",
};

function remapVocabularyFlipRelation(relation: string | null): string | null {
  if (relation === null) {
    return null;
  }
  return VOCABULARY_FLIP_RENAME[relation] ?? relation;
}

interface VocabularyFlipRow {
  citingKind: string;
  citingId: number;
  citedKind: string;
  citedId: number;
  relation: string | null;
  provenance: EdgeProvenance;
  createdAtEpoch: number;
}

/**
 * The encodes/grounded-on merge is the one rename that can COLLIDE: a pair
 * that already held both (a multi-phase turn writing `groundedOn` toward one
 * target and `encodes` toward the same one, two separate rows under the old
 * one-row-per-(pair,relation) identity) would produce two `grounds` rows for
 * the same pair post-rename, which the table's own UNIQUE constraint
 * refuses. Collapsed here with the SAME provenance-rank tie-break
 * `pickWinningLegacyRelation` (this file, ticket 05's pair-identity
 * collapse) already established for an analogous multi-candidate-per-pair
 * problem: higher-authority provenance wins, ties fall back to the earliest
 * `created_at_epoch`, which the winner's own row does NOT need to carry (the
 * timestamp is pooled across the whole group so "when did this edge first
 * appear" survives the collapse regardless of which candidate's provenance
 * won).
 */
function pickWinningVocabularyFlipRow(
  candidates: readonly VocabularyFlipRow[],
): { provenance: EdgeProvenance; createdAtEpoch: number } {
  const winner = [...candidates].sort((left, right) => {
    const rankDiff = rankEdgeProvenance(right.provenance) - rankEdgeProvenance(left.provenance);
    if (rankDiff !== 0) {
      return rankDiff;
    }
    return left.createdAtEpoch - right.createdAtEpoch;
  })[0]!;
  return {
    provenance: winner.provenance,
    createdAtEpoch: Math.min(...candidates.map((candidate) => candidate.createdAtEpoch)),
  };
}

/**
 * Detection reads the stored DDL for the newest word only (`'narrows'`),
 * the same single-probe idiom every earlier `memory_edges` rebuild in this
 * file uses — present once `memoryEdgesTableDdl`'s widened CHECK has landed
 * (this migration's own rebuild, or a fresh database created straight from
 * it), absent on every database this migration has not reached yet.
 */
function memoryEdgesVocabularyFlipIsStale(db: Database): boolean {
  const storedDdl =
    db
      .query<{ sql: string | null }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_edges'",
      )
      .get()?.sql ?? null;
  return storedDdl !== null && !storedDdl.includes("'narrows'");
}

/**
 * Same rebuild-under-a-temporary-name-then-swap shape as
 * `ensureMemoryEdgesMultiRelation`/`ensureMemoryEdgesSelfReferenceCheck`
 * (0.13.0 temp-name precedent): build the new table under `relationWords`'
 * CHECK, copy every row across with its `relation` remapped, drop the old
 * table, rename the replacement into place — never rename the original away
 * (the three endpoint prune triggers name `memory_edges` in their bodies).
 * Grouped in TypeScript rather than pure SQL for the same reason
 * `collapseAndRebuildMemoryEdges` reads its source table into JS: the
 * winner-selection judgment for a collision (`pickWinningVocabularyFlipRow`)
 * is not cheaply expressible as one SQL statement, and the whole table is
 * small (spec.md: 849 relation edges on the full production database).
 *
 * Shared by BOTH halves of the flow-relations migration — ticket 02's widen
 * (`ensureMemoryEdgesVocabularyFlip`, `relationWords` = the union list) and
 * ticket 03's narrow (`ensureMemoryEdgesRelationContract`, `relationWords` =
 * the eight-word + supersedes contract list) — because renaming and
 * collapsing a collision is the SAME problem in either direction: a row
 * this remap has not yet reached, and a stray collision the remap creates,
 * can appear regardless of which way the target CHECK is moving. Reusing
 * this one remap-and-collapse pass rather than a bare `SELECT *` in the
 * narrow direction is what makes "once no old word remains" an ENFORCED
 * property of the narrow rebuild rather than an assumption: a database that
 * reaches ticket 03's migration with a genuinely un-renamed row (e.g. every
 * earlier migration in this file firing in a single open, the shape this
 * ticket's own test fixtures and a restored-from-backup install can produce)
 * gets that row renamed on the way in instead of tripping the narrow CHECK.
 *
 * Neither filtered nor width-changing otherwise: unlike the multi-relation/
 * self-reference rebuilds, table IDENTITY (columns, PK, unique index) is
 * unchanged here — only the CHECK's allowed value list changes and existing
 * rows' `relation` VALUES rename. A pair with no colliding candidate copies
 * straight across, mid-flow-target edges included (P1: "valid as of write
 * time" — this migration neither deletes nor re-points them, only renames
 * the word they're stored under when that word is one of the six retired
 * ones).
 *
 * `remap` (indexes-rescope spec, ticket 01) is a THIRD reuse of this same
 * collapse-and-rebuild shape — `ensureMemoryEdgesIndexesRename`'s own
 * `collects`->`indexes` rename is a different word map over the same
 * pair-collision problem, so it is parameterised rather than duplicated.
 * Defaults to `remapVocabularyFlipRelation` so the two existing callers above
 * need no change at all.
 */
function collapseAndRebuildVocabularyFlip(
  db: Database,
  relationWords: readonly string[],
  remap: (relation: string | null) => string | null = remapVocabularyFlipRelation,
): void {
  db.exec("ALTER TABLE memory_edges RENAME TO memory_edges_pre_vocabulary_flip");
  db.exec(memoryEdgesTableDdl("memory_edges", relationWords));

  const legacyRows = db
    .query<VocabularyFlipRow, []>(
      `SELECT
         citing_kind AS citingKind, citing_id AS citingId,
         cited_kind AS citedKind, cited_id AS citedId,
         relation, provenance, created_at_epoch AS createdAtEpoch
       FROM memory_edges_pre_vocabulary_flip`,
    )
    .all();

  const groups = new Map<string, VocabularyFlipRow[]>();
  for (const row of legacyRows) {
    const newRelation = remap(row.relation);
    const key = `${row.citingKind} ${row.citingId} ${row.citedKind} ${row.citedId} ${newRelation ?? ""}`;
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      groups.set(key, [row]);
    }
  }

  const insert = db.query<
    unknown,
    [string, number, string, number, string | null, string, number]
  >(
    `INSERT INTO memory_edges (
       citing_kind, citing_id, cited_kind, cited_id,
       relation, provenance, created_at_epoch
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const bucket of groups.values()) {
    const sample = bucket[0]!;
    const newRelation = remap(sample.relation);
    const winner = pickWinningVocabularyFlipRow(bucket);
    insert.run(
      sample.citingKind,
      sample.citingId,
      sample.citedKind,
      sample.citedId,
      newRelation,
      winner.provenance,
      winner.createdAtEpoch,
    );
  }

  db.exec("DROP TABLE memory_edges_pre_vocabulary_flip");
  db.exec(MEMORY_EDGES_INDEXES_DDL);
}

function ensureMemoryEdgesVocabularyFlip(db: Database): void {
  if (!memoryEdgesVocabularyFlipIsStale(db)) {
    return;
  }

  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    runWriteTransaction(db, () => {
      if (!memoryEdgesVocabularyFlipIsStale(db)) {
        return;
      }

      collapseAndRebuildVocabularyFlip(db, MEMORY_EDGES_UNION_RELATION_WORDS);

      const violations = db
        .query<Record<string, unknown>, []>("PRAGMA foreign_key_check")
        .all();
      if (violations.length > 0) {
        throw new Error(
          `memory_edges rebuild left ${violations.length} foreign key violation(s) while flipping the relation vocabulary: ${JSON.stringify(violations)}`,
        );
      }
    });
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
}

/**
 * Flow-relations spec, ticket 03 (spec.md's migration item 3, "the DB
 * CHECK's word list rebuilds to the eight words + supersedes AFTER the
 * renames, on the 0.13.0 temp-name precedent"): the matching NARROW half of
 * ticket 02's widen above. `ensureMemoryEdgesVocabularyFlip` already renamed
 * every row it reached earlier in this SAME `ensureMemoryEdgesSchema` pass,
 * and the tool surface has offered only the eight new words since ticket 02
 * shipped — so on the real, incremental (one release at a time) upgrade
 * path no row carries an old word by the time this runs.
 *
 * Narrowing is a REMOVAL, so unlike every earlier probe in this file (which
 * checks for the ABSENCE of new marker text), this one checks for the
 * PRESENCE of retired marker text — 'depends-on' names the DDL's own CHECK
 * text, not any row's data.
 */
function memoryEdgesRelationContractIsStale(db: Database): boolean {
  const storedDdl =
    db
      .query<{ sql: string | null }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_edges'",
      )
      .get()?.sql ?? null;
  return storedDdl !== null && storedDdl.includes("'depends-on'");
}

function ensureMemoryEdgesRelationContract(db: Database): void {
  if (!memoryEdgesRelationContractIsStale(db)) {
    return;
  }

  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    runWriteTransaction(db, () => {
      if (!memoryEdgesRelationContractIsStale(db)) {
        return;
      }

      // Reuses the SAME remap-and-collapse pass as the widen above (see
      // `collapseAndRebuildVocabularyFlip`'s docstring) — not a bare
      // `SELECT *` — so a stray old-word row this build's own earlier
      // migrations left unrenamed (a full-chain jump in one open, rather
      // than the incremental path) is renamed on the way into the narrow
      // table instead of tripping its CHECK.
      collapseAndRebuildVocabularyFlip(db, MEMORY_EDGES_CONTRACT_RELATION_WORDS);

      const violations = db
        .query<Record<string, unknown>, []>("PRAGMA foreign_key_check")
        .all();
      if (violations.length > 0) {
        throw new Error(
          `memory_edges rebuild left ${violations.length} foreign key violation(s) while narrowing the relation contract: ${JSON.stringify(violations)}`,
        );
      }
    });
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
}

/**
 * Indexes-rescope spec, ticket 01 (`.scratch/indexes-rescope/spec.md`'s
 * migration item 1): `collects` renames to `indexes` — same-phase
 * aggregation, no graph-state gate. `collects` never appeared in storage
 * until ticket 02 of the flow-relations spec (spec.md: "narrows/collects
 * start empty"), so unlike that migration's `encodes`/`grounded-on` merge
 * this rename cannot collide (`indexes` never existed as a stored word
 * before this migration, so no pair can already hold an `indexes` row for a
 * `collects` row of the same pair to collapse against) — reused anyway
 * through `remapIndexesRename`/`collapseAndRebuildVocabularyFlip`'s general
 * collision-safe pass rather than a bare `SELECT *`, both to match precedent
 * discipline and to satisfy the ticket's own "UNIQUE-collision-safe"
 * requirement without relying on that argument holding forever.
 */
const INDEXES_RENAME_MAP: Readonly<Record<string, string>> = {
  collects: "indexes",
};

function remapIndexesRename(relation: string | null): string | null {
  if (relation === null) {
    return null;
  }
  return INDEXES_RENAME_MAP[relation] ?? relation;
}

/**
 * Detection reads the stored DDL for the OLD word `collects` — never the new
 * word `indexes`' absence (the ticket's own explicit instruction, echoing the
 * 0.14 sequencing-bug lesson `ensureMemoryEdgesRelationContract` above notes
 * for `depends-on`: probing on the new word's absence cannot tell "already
 * migrated" apart from "never reached", since a pristine pre-migration table
 * also lacks the new word). Present once the CHECK still lists `'collects'`;
 * absent once this migration's own rebuild (or a fresh database created
 * straight from `MEMORY_EDGES_INDEXES_RENAME_RELATION_WORDS`) has landed.
 */
function memoryEdgesIndexesRenameIsStale(db: Database): boolean {
  const storedDdl =
    db
      .query<{ sql: string | null }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_edges'",
      )
      .get()?.sql ?? null;
  return storedDdl !== null && storedDdl.includes("'collects'");
}

/**
 * Same rebuild-under-a-temporary-name-then-swap shape as
 * `ensureMemoryEdgesVocabularyFlip`/`ensureMemoryEdgesRelationContract` above
 * — a SINGLE combined step rather than a widen-then-narrow pair, unlike the
 * seven-word retirement this rides on top of: this rename is not split
 * across two releases (spec: "Migration (small; stored rows all post-era)"),
 * so there is no in-flight-release window requiring an intermediate wide
 * CHECK. Chained immediately after `ensureMemoryEdgesRelationContract` in
 * `ensureMemoryEdgesSchema` so a pre-0.14 database doing a full-chain jump in
 * one open still gets its `collects` row (left behind by that function's own
 * `collects`-bearing rebuild target) renamed onto `indexes` in the same pass.
 */
function ensureMemoryEdgesIndexesRename(db: Database): void {
  if (!memoryEdgesIndexesRenameIsStale(db)) {
    return;
  }

  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    runWriteTransaction(db, () => {
      if (!memoryEdgesIndexesRenameIsStale(db)) {
        return;
      }

      collapseAndRebuildVocabularyFlip(
        db,
        MEMORY_EDGES_INDEXES_RENAME_RELATION_WORDS,
        remapIndexesRename,
      );

      const violations = db
        .query<Record<string, unknown>, []>("PRAGMA foreign_key_check")
        .all();
      if (violations.length > 0) {
        throw new Error(
          `memory_edges rebuild left ${violations.length} foreign key violation(s) while renaming collects to indexes: ${JSON.stringify(violations)}`,
        );
      }
    });
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
}

/**
 * rubric-v10 ticket 01 (spec "Edge tag storage and write gate", draft's
 * "迁移决策" item 1): the surrogate `id` and the tag-set column/uniqueness
 * key.
 *
 * DETECTION PROBES THE `id` COLUMN, not the DDL text, and lane-model-v12
 * ticket 09 is why — this is the one probe in the chain whose marker was not
 * monotonic. It used to read the stored DDL for `tags TEXT NOT NULL`, the
 * same idiom every sibling above uses. That worked only while no later
 * migration could take the marker back out; M-E does exactly that, and a
 * CONTRACTED table therefore read as pristine pre-ticket-01 stock. The
 * consequence was not a wasted rebuild but SILENT DATA LOSS: this migration's
 * copy names the pre-tag columns only, so every reopen would have rewritten
 * the table without `tail_tag`/`head_tag`, dropping every lane attribution in
 * the database, and M-A would then have "expanded" the survivors back to
 * unsettled. Neither the idempotency test here nor any full-open test could
 * see it, because both compare a database whose rows are unattributed anyway.
 *
 * `id` is the half of this migration's outcome that nothing later removes, so
 * it is the honest marker: a pristine pre-ticket table has no surrogate key
 * at all, and every shape from ticket 01 onward — including the contracted
 * one — has one. "Already migrated" and "never reached" still cannot be
 * confused, and now stay that way under a column this chain may yet retire.
 */
function memoryEdgesTagSetIdentityIsStale(db: Database): boolean {
  if (!hasTable(db, "memory_edges")) {
    return false;
  }
  return !db
    .query<{ name: string }, []>("SELECT name FROM pragma_table_info('memory_edges')")
    .all()
    .some((row) => row.name === "id");
}

/**
 * Same rebuild-under-a-temporary-name-then-swap shape as every earlier
 * `memory_edges` migration in this file, but a STRAIGHT copy rather than
 * `collapseAndRebuildVocabularyFlip`'s bucket-and-collapse pass: the OLD
 * table's own UNIQUE constraint already capped every (pair, relation) at one
 * row, so adding a fresh surrogate id and defaulting every existing row's tag
 * set to `'[]'` cannot create a collision this rebuild would have to resolve.
 * Row count is therefore preserved exactly — zero data change beyond the two
 * new columns and the widened uniqueness key, per the migration's own
 * standing requirement.
 *
 * Chained immediately after `ensureMemoryEdgesIndexesRename`: by the time
 * this runs, the table's CHECK is already whichever relation-word list this
 * file's chain has settled on (today, `MEMORY_EDGES_INDEXES_RENAME_RELATION_
 * WORDS`), and this migration does not touch vocabulary at all — it targets
 * that same, already-current word list, same as `MEMORY_EDGES_DDL` below.
 */
function ensureMemoryEdgesTagSetIdentity(db: Database): void {
  if (!memoryEdgesTagSetIdentityIsStale(db)) {
    return;
  }

  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    runWriteTransaction(db, () => {
      if (!memoryEdgesTagSetIdentityIsStale(db)) {
        return;
      }

      // The copy below names the PRE-TAG columns only, so it would silently
      // drop any lane column the table happens to carry. That is unreachable
      // while the probe above is honest (a table with lanes has an `id`), and
      // it is stated as a refusal rather than trusted, because the damage —
      // every stored attribution gone, with a clean-looking database left
      // behind — is the kind no assertion downstream would notice.
      if (!memoryEdgesTwoSidedTagsIsStale(db)) {
        throw new Error(
          "memory_edges carries tail_tag/head_tag but was judged to predate the tag-set " +
            "identity migration. That rebuild drops every column it does not name, so it " +
            "would erase both lane columns; the staleness probe is wrong, not the table.",
        );
      }

      db.exec("ALTER TABLE memory_edges RENAME TO memory_edges_pre_tag_identity");
      db.exec(
        memoryEdgesTableDdl("memory_edges", MEMORY_EDGES_INDEXES_RENAME_RELATION_WORDS),
      );

      db.exec(`
        INSERT INTO memory_edges (
          citing_kind, citing_id, cited_kind, cited_id,
          relation, provenance, created_at_epoch
        )
        SELECT citing_kind, citing_id, cited_kind, cited_id,
               relation, provenance, created_at_epoch
        FROM memory_edges_pre_tag_identity;
      `);

      db.exec("DROP TABLE memory_edges_pre_tag_identity");
      db.exec(MEMORY_EDGES_INDEXES_DDL);

      const violations = db
        .query<Record<string, unknown>, []>("PRAGMA foreign_key_check")
        .all();
      if (violations.length > 0) {
        throw new Error(
          `memory_edges rebuild left ${violations.length} foreign key violation(s) while adding the tag-set identity: ${JSON.stringify(violations)}`,
        );
      }
    });
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
}

/**
 * lane-model-v12 M-D (spec D4, ticket 03). Narrowing is a REMOVAL, so — like
 * `memoryEdgesRelationContractIsStale` and unlike the "absence of the new
 * marker" probes — this checks for the PRESENCE of a retired word in the
 * DDL's own CHECK text. `'supersedes'` is the probe rather than `'refutes'`
 * because it is the older of the two: every table this migration has not
 * reached names it, including the ones that predate `refutes` existing at all.
 */
function memoryEdgesLaneModelV12RelationContractIsStale(db: Database): boolean {
  const storedDdl =
    db
      .query<{ sql: string | null }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_edges'",
      )
      .get()?.sql ?? null;
  return storedDdl !== null && storedDdl.includes("'supersedes'");
}

/**
 * M-D: the two words lane-model-v12 does not have leave the table's CHECK.
 *
 * Same rebuild-under-a-temporary-name-then-swap shape as
 * `ensureMemoryEdgesSelfReferenceCheck` — build the replacement under a temp
 * name, copy, drop the original, rename the replacement into place. This order
 * is chosen rather than renaming the ORIGINAL away because it is correct under
 * EITHER `legacy_alter_table` setting: with the pragma OFF (SQLite ≥ 3.25's
 * default), renaming the original rewrites the three endpoint prune triggers'
 * bodies onto the temp name, leaving them pointed at a table this function
 * then drops. MEASURED: bun:sqlite currently runs with `legacy_alter_table=1`,
 * so that hazard is inert here today and this ordering is defence in depth, not
 * a live fix — a mutation swapping the two orders reddens nothing, which is why
 * it is stated as a dependency on a pragma rather than as a rule.
 *
 * The copy is STRAIGHT and carries `id` explicitly, unlike every earlier
 * rebuild in this chain: `memory_edge_tags.edge_row_id` references it, so a
 * fresh AUTOINCREMENT sequence would silently re-key the whole tag index.
 * `tags` rides across for the same reason — this migration changes vocabulary,
 * nothing else.
 *
 * WHERE IT RUNS, and why not in `ensureMemoryEdgesSchema` with its siblings:
 * that function runs BEFORE `runLaneRegistryMigration` (ticket 01, spec D4),
 * and a narrow CHECK arriving before M-B has rewritten the rows would refuse
 * the copy of every row still carrying a retired word. So the phase lives in
 * `runLaneModelV12EdgeMigration`, immediately after M-B, and states that
 * precondition as a check rather than a comment: rows carrying a retired word
 * at this point mean M-B did not run, and a raw SQLITE_CONSTRAINT from the
 * copy would be a far worse way to learn it.
 */
export function ensureMemoryEdgesLaneModelV12RelationContract(db: Database): void {
  if (!memoryEdgesLaneModelV12RelationContractIsStale(db)) {
    return;
  }

  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    runWriteTransaction(db, () => {
      if (!memoryEdgesLaneModelV12RelationContractIsStale(db)) {
        return;
      }

      const stranded = db
        .query<{ n: number; words: string | null }, []>(
          `SELECT COUNT(*) AS n, group_concat(DISTINCT relation) AS words
           FROM memory_edges WHERE relation IN ('supersedes', 'refutes')`,
        )
        .get()!;
      if (stranded.n > 0) {
        throw new Error(
          `memory_edges still holds ${stranded.n} row(s) carrying a retired relation ` +
            `word (${stranded.words}), so the lane-model-v12 CHECK narrow would refuse ` +
            "them. The M-B vocabulary merge (db/lanes.ts's " +
            "runLaneModelV12VocabularyMerge) must run first — see lane-model-v12 spec D4.",
        );
      }

      db.exec(
        memoryEdgesTableDdl(
          "memory_edges_lane_model_v12_rebuild",
          MEMORY_EDGES_LANE_MODEL_V12_RELATION_WORDS,
        ),
      );
      db.exec(
        `INSERT INTO memory_edges_lane_model_v12_rebuild (
           id, citing_kind, citing_id, cited_kind, cited_id,
           relation, provenance, tags, created_at_epoch
         )
         SELECT
           id, citing_kind, citing_id, cited_kind, cited_id,
           relation, provenance, tags, created_at_epoch
         FROM memory_edges`,
      );
      db.exec("DROP TABLE memory_edges");
      db.exec("ALTER TABLE memory_edges_lane_model_v12_rebuild RENAME TO memory_edges");
      // The indexes belonged to the dropped table and died with it.
      db.exec(MEMORY_EDGES_INDEXES_DDL);

      const violations = db
        .query<Record<string, unknown>, []>("PRAGMA foreign_key_check")
        .all();
      if (violations.length > 0) {
        throw new Error(
          `memory_edges rebuild left ${violations.length} foreign key violation(s) while narrowing the relation CHECK to the seven-word vocabulary: ${JSON.stringify(violations)}`,
        );
      }
    });
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
}

// ---------------------------------------------------------------------------
// lane-model-v12 M-A — the tag set becomes one tag per side (ticket 05, expand)
// ---------------------------------------------------------------------------

/** NOT `lane-declaration-`: an end-to-end test counts that prefix as the registry's phase set, and this is not one of those phases. */
export const LANE_MODEL_V12_TWO_SIDED_TAGS_RECEIPT = "lane-model-v12-ma-two-sided-tags";

/** One stored row that carried SEVERAL tags and became several edges — one per tag, each with both sides on that tag. */
export interface LaneModelV12SplitEdge {
  /** The original row's id, which the FIRST tag's edge keeps (so an audit trail pointing at it still lands on a real row). */
  edgeId: number;
  citingAddress: string;
  citedAddress: string;
  relation: string | null;
  /** The original canonical set, in the order the edges below were minted. */
  tags: string[];
  /**
   * The surviving edge ids, ascending — normally one per tag with the first
   * equal to `edgeId`. SHORTER than `tags` when one of the products lost an
   * identity-key collision; that product is in `merged` instead, named on
   * both sides.
   */
  edgeIds: number[];
}

/**
 * One identity-key collision the split created, recorded from BOTH sides —
 * same obligation as M-B's own receipt: months later, a reader asking where an
 * edge went cannot consult the row that is no longer there.
 */
export interface LaneModelV12SideTagMergedEdge {
  citingAddress: string;
  citedAddress: string;
  relation: string | null;
  /** The key the two collided on, its last two components. */
  tailTag: string;
  headTag: string;
  keptEdgeId: number;
  keptProvenance: string;
  keptCreatedAtEpoch: number;
  /** The kept row's PRE-migration tag set — the whole reason two rows could collide is that these two differ. */
  keptTags: string[];
  droppedEdgeId: number;
  droppedProvenance: string;
  droppedCreatedAtEpoch: number;
  droppedTags: string[];
  rule: LaneModelV12MergeRule;
}

export interface LaneModelV12TwoSidedTagsReceipt {
  /**
   * `expanded` — a one-sided table was rewritten. This is what a fresh
   * install gets too (`rowsBefore: 0`): creation is deliberately one-sided so
   * that ticket 01's ordering barrier still sees the pre-v12 shape when the
   * registry migration runs — see `MEMORY_EDGES_DDL`.
   * `born-two-sided` — the table was ALREADY in the v12 shape, so there was
   * no data transformation to record. Stated rather than left as a missing
   * receipt: "this migration never saw this database" and "it saw it and had
   * nothing to do" are different facts.
   */
  disposition: "expanded" | "born-two-sided";
  rowsBefore: number;
  rowsAfter: number;
  split: readonly LaneModelV12SplitEdge[];
  merged: readonly LaneModelV12SideTagMergedEdge[];
  /** `merged.length`, written out so the headline needs no counting. */
  mergedCount: number;
  /** Rows left with BOTH sides unsettled — settlement's own queue on the far side of the upgrade (spec's own control quantity). */
  unsettled: number;
}

interface TwoSidedSourceRow {
  id: number;
  citingKind: string;
  citingId: number;
  citedKind: string;
  citedId: number;
  relation: string | null;
  provenance: string;
  tags: string;
  createdAtEpoch: number;
}

/** One row of the REBUILT table, before it has an id: a source row contributes one of these per tag (or exactly one when it has none). */
interface TwoSidedTuple {
  source: TwoSidedSourceRow;
  /** 0 for the first tag — the tuple that inherits the source row's id. */
  ordinal: number;
  tailTag: string;
  headTag: string;
  /** The row's own `tags` payload after the split: a single-tag set, or the source's own text for a bare row. */
  tags: string;
  /** The merge rule reads these three; the id is the SOURCE row's, which is the audit handle a collision has to be reported under. */
  id: number;
  provenance: string;
  createdAtEpoch: number;
  finalId: number;
}

/**
 * Regenerate the RETIRED merged tag index from `memory_edges.tags`, without
 * opening a transaction of its own — M-A rebuilds it inside the same
 * transaction as the table it just rewrote, and nesting a second
 * `runWriteTransaction` inside an open one does not compose under
 * bun:sqlite's `.immediate()` (see `disposeIllegalEdges` in db/lanes.ts for
 * the same constraint stated at its other end).
 *
 * MIGRATION-PRIVATE since ticket 09, which is why it lives here rather than
 * in db/memory-edges.ts with its side-index counterpart: the only moment this
 * index is ever written now is between M-A (which rewrites the ids it is
 * keyed on) and M-E (which drops it, a few statements later in the same
 * open). The storage layer must hold no reference to it at all, or "no
 * residual reader" is a claim about grep rather than about the code.
 */
function rebuildLegacyMemoryEdgeTagsIndex(db: Database): void {
  db.exec("DELETE FROM memory_edge_tags");
  db.exec(`
    INSERT INTO memory_edge_tags (edge_row_id, tag)
    SELECT memory_edges.id, tag_value.value
    FROM memory_edges, json_each(memory_edges.tags) AS tag_value
  `);
}

function memoryEdgesTwoSidedTagsIsStale(db: Database): boolean {
  const columns = new Set(
    db
      .query<{ name: string }, []>("SELECT name FROM pragma_table_info('memory_edges')")
      .all()
      .map((row) => row.name),
  );
  return !columns.has("tail_tag") || !columns.has("head_tag");
}

/**
 * The EXPAND projection, applied to one stored row (spec D4's M-A):
 *
 *   - `tags = '[]'` -> ONE row, both sides unsettled. Not "same lane": the
 *     old untagged rows carry no attribution at all, so the post-migration
 *     baseline is a WAITING QUEUE, not a single global lane (spec's own
 *     correction to its Rev 1 verification plan).
 *   - one tag -> ONE row, both sides on it.
 *   - N tags -> N rows, one per tag. The spec measured 41 rows (8.8% of the
 *     tagged ones) of this shape; re-measured at implementation time, 43 of
 *     489 tagged rows, and still zero collisions among their products.
 *   - a BARE row (`relation IS NULL`) -> ONE row, both sides unsettled, tag
 *     payload carried across VERBATIM. It is not a lane fact (the write path
 *     ignores `tags` for it), and splitting one would mint a second bare row
 *     on the same pair — which `idx_memory_edges_bare_pair` forbids outright.
 *     The single exception is a payload that is not a readable JSON array:
 *     the rebuilt table's own CHECK cannot hold one, so it lands as `'[]'`
 *     rather than aborting the upgrade. Measured on the live database: zero
 *     rows of that shape, `tags` having carried that CHECK for releases now.
 */
function twoSidedTuplesFor(row: TwoSidedSourceRow): TwoSidedTuple[] {
  const base = {
    source: row,
    id: row.id,
    provenance: row.provenance,
    createdAtEpoch: row.createdAtEpoch,
    finalId: 0,
  };
  const stored = readStoredTagSet(row.tags);
  const tags = row.relation === null ? [] : canonicalizeTagSet(stored);
  if (tags.length === 0) {
    return [
      {
        ...base,
        ordinal: 0,
        tailTag: "",
        headTag: "",
        tags: row.relation === null && Array.isArray(stored) ? row.tags : "[]",
      },
    ];
  }
  return tags.map((tag, ordinal) => {
    const { tailTag, headTag } = deriveSideTags([tag]);
    return { ...base, ordinal, tailTag, headTag, tags: JSON.stringify([tag]) };
  });
}

/** The stored column is `json_valid` by CHECK, but a fixture table built by hand has no CHECK — a payload that will not parse is read as untagged rather than aborting the phase. */
function readStoredTagSet(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/**
 * The identity key of the REBUILT table, as a string. `relation IS NULL` rows
 * get a key of their own per row: SQLite's UNIQUE never treats two NULLs as
 * equal, so two bare rows are never a collision here either — and the pair's
 * bare row is already capped at one by `idx_memory_edges_bare_pair`.
 *
 * `\u0000` as the separator, spelled as the ESCAPE and never as the
 * byte: a raw control character in source is invisible in every diff and
 * review that will ever touch this line. It has to be a character no
 * component can contain — a space would not do, since the legacy corpus holds
 * tags like `two words`, and `{"a b", "c"}` would key identically to
 * `{"a", "b c"}`.
 */
function twoSidedIdentityKey(tuple: TwoSidedTuple): string {
  if (tuple.source.relation === null) {
    return `bare\u0000${tuple.source.id}`;
  }
  return [
    tuple.source.citingKind,
    String(tuple.source.citingId),
    tuple.source.citedKind,
    String(tuple.source.citedId),
    tuple.source.relation,
    tuple.tags,
    tuple.tailTag,
    tuple.headTag,
  ].join("\u0000");
}

/**
 * M-A (lane-model-v12 spec D4, ticket 05): `memory_edges.tags` is
 * INTERNALIZED into `tail_tag`/`head_tag`, one lane per side of the arc.
 * The EXPAND half — the column keeps its rows and stays the authoritative
 * read source until v12 tickets 06/07/08 move the readers onto the new pair,
 * and ticket 09 drops it.
 *
 * "LOSSLESS" IS A CLAIM ABOUT THE CURRENT SNAPSHOT, NOT ABOUT THE SHAPE. The
 * pre-v12 key admits `{a}` and `{a,b}` side by side on one (pair, relation);
 * split, both produce the same `(a, a)` identity. Production holds ZERO rows
 * of that shape (measured), which is exactly why the contract may not rest on
 * it: collisions route through the SAME merge rule ticket 03's M-B uses
 * (`sortLaneModelV12MergeGroup`, db/lanes.ts — asserted's audit metadata
 * survives, equal rank keeps the earlier row) and every one of them is named
 * on both sides in the receipt. The ticket's own "a split leaves both sides
 * equal" test cannot see this case; it has one of its own.
 *
 * WHERE IT RUNS: LAST inside `runLaneModelV12EdgeMigration`. Only one of the
 * two orderings that implies is load bearing — see that function's own note.
 * Against M-B it is: this rebuild targets the seven-word CHECK, so a retired
 * word still stored stops it with a named error instead of a raw
 * SQLITE_CONSTRAINT. Against M-D it is convention only, and measured to be:
 * swapping them reddens nothing, because this phase's target already carries
 * M-D's narrow CHECK.
 *
 * The copy carries `id` explicitly for every row that keeps one:
 * `memory_edge_tags.edge_row_id` references it, so a fresh AUTOINCREMENT
 * sequence would silently re-key the whole tag index. Rows minted BY the
 * split are the only ones taking a new id, and they take it after every
 * preserved id is already in the table.
 *
 * Data and receipt commit in ONE transaction, so "expanded but unrecorded"
 * and "recorded but not expanded" are not states this database can be found
 * in — a failpoint test pins it, because a receipt row plus an idempotent
 * second run does not prove that on its own.
 */
export function ensureMemoryEdgesLaneModelV12TwoSidedTags(
  db: Database,
  nowEpoch: number = Math.floor(Date.now() / 1000),
): void {
  if (!hasTable(db, "memory_edges")) {
    return;
  }

  if (!memoryEdgesTwoSidedTagsIsStale(db)) {
    // Born in the v12 shape. No rebuild, but the disposition is still worth a
    // row: the receipt is what a later reader asks "has this phase been
    // through this database" with, and a fresh install must answer yes.
    runWriteTransaction(db, () => {
      if (hasMigrationReceipt(db, LANE_MODEL_V12_TWO_SIDED_TAGS_RECEIPT)) {
        return;
      }
      const rows = countMemoryEdges(db);
      const receipt: LaneModelV12TwoSidedTagsReceipt = {
        disposition: "born-two-sided",
        rowsBefore: rows,
        rowsAfter: rows,
        split: [],
        merged: [],
        mergedCount: 0,
        unsettled: countUnsettledEdges(db),
      };
      writeMigrationReceipt(db, LANE_MODEL_V12_TWO_SIDED_TAGS_RECEIPT, nowEpoch, receipt);
    });
    return;
  }

  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    runWriteTransaction(db, () => {
      if (!memoryEdgesTwoSidedTagsIsStale(db)) {
        return;
      }

      // Same precondition M-D states as a check rather than a comment: a
      // retired word still stored means M-B has not run, and this rebuild's
      // target CHECK (the seven-word vocabulary, which it must preserve)
      // would refuse the copy with a bare SQLITE_CONSTRAINT.
      const stranded = db
        .query<{ n: number; words: string | null }, []>(
          `SELECT COUNT(*) AS n, group_concat(DISTINCT relation) AS words
           FROM memory_edges WHERE relation IN ('supersedes', 'refutes')`,
        )
        .get()!;
      if (stranded.n > 0) {
        throw new Error(
          `memory_edges still holds ${stranded.n} row(s) carrying a retired relation ` +
            `word (${stranded.words}), so the lane-model-v12 two-sided rebuild would ` +
            "refuse them. The M-B vocabulary merge (db/lanes.ts's " +
            "runLaneModelV12VocabularyMerge) must run first — see lane-model-v12 spec D4.",
        );
      }

      const sourceRows = db
        .query<TwoSidedSourceRow, []>(
          `SELECT id, citing_kind AS citingKind, citing_id AS citingId,
                  cited_kind AS citedKind, cited_id AS citedId,
                  relation, provenance, tags, created_at_epoch AS createdAtEpoch
           FROM memory_edges
           ORDER BY id`,
        )
        .all();

      const groups = new Map<string, TwoSidedTuple[]>();
      for (const row of sourceRows) {
        for (const tuple of twoSidedTuplesFor(row)) {
          const key = twoSidedIdentityKey(tuple);
          const bucket = groups.get(key);
          if (bucket) {
            bucket.push(tuple);
          } else {
            groups.set(key, [tuple]);
          }
        }
      }

      const survivors: TwoSidedTuple[] = [];
      const casualties: Array<{ kept: TwoSidedTuple; dropped: TwoSidedTuple }> = [];
      for (const bucket of groups.values()) {
        if (bucket.length === 1) {
          survivors.push(bucket[0]!);
          continue;
        }
        const ordered = sortLaneModelV12MergeGroup(bucket);
        const kept = ordered[0]!;
        survivors.push(kept);
        for (const dropped of ordered.slice(1)) {
          casualties.push({ kept, dropped });
        }
      }

      db.exec(
        memoryEdgesTableDdl(
          "memory_edges_two_sided_rebuild",
          MEMORY_EDGES_LANE_MODEL_V12_RELATION_WORDS,
          "two-sided",
        ),
      );

      const insertWithId = db.query<
        unknown,
        [number, string, number, string, number, string | null, string, string, string, string, number]
      >(
        `INSERT INTO memory_edges_two_sided_rebuild (
           id, citing_kind, citing_id, cited_kind, cited_id,
           relation, provenance, tags, tail_tag, head_tag, created_at_epoch
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertMinted = db.query<
        { id: number },
        [string, number, string, number, string | null, string, string, string, string, number]
      >(
        `INSERT INTO memory_edges_two_sided_rebuild (
           citing_kind, citing_id, cited_kind, cited_id,
           relation, provenance, tags, tail_tag, head_tag, created_at_epoch
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
      );

      // PRESERVED ids first, MINTED ids after: AUTOINCREMENT hands out
      // max(seen) + 1, so a minted row can only collide with a preserved one
      // if the preserved one is not in the table yet.
      for (const tuple of survivors) {
        if (tuple.ordinal !== 0) {
          continue;
        }
        insertWithId.run(
          tuple.source.id,
          tuple.source.citingKind,
          tuple.source.citingId,
          tuple.source.citedKind,
          tuple.source.citedId,
          tuple.source.relation,
          tuple.source.provenance,
          tuple.tags,
          tuple.tailTag,
          tuple.headTag,
          tuple.source.createdAtEpoch,
        );
        tuple.finalId = tuple.source.id;
      }
      for (const tuple of survivors) {
        if (tuple.ordinal === 0) {
          continue;
        }
        tuple.finalId = insertMinted.get(
          tuple.source.citingKind,
          tuple.source.citingId,
          tuple.source.citedKind,
          tuple.source.citedId,
          tuple.source.relation,
          tuple.source.provenance,
          tuple.tags,
          tuple.tailTag,
          tuple.headTag,
          tuple.source.createdAtEpoch,
        )!.id;
      }

      db.exec("DROP TABLE memory_edges");
      db.exec("ALTER TABLE memory_edges_two_sided_rebuild RENAME TO memory_edges");
      // The indexes belonged to the dropped table and died with it.
      db.exec(MEMORY_EDGES_INDEXES_DDL);
      // Both query indexes are derived, and both of their derivations just
      // changed under them (split rows carry new ids and a rewritten set), so
      // they are regenerated rather than patched — inside THIS transaction,
      // without opening a nested one.
      rebuildLegacyMemoryEdgeTagsIndex(db);
      rebuildMemoryEdgeSideTagsIndexCore(db);

      const split: LaneModelV12SplitEdge[] = [];
      for (const row of sourceRows) {
        const products = survivors.filter((tuple) => tuple.source.id === row.id);
        const tags = canonicalizeTagSet(readStoredTagSet(row.tags));
        if (row.relation === null || tags.length < 2) {
          continue;
        }
        split.push({
          edgeId: row.id,
          citingAddress: resolveEdgeNodeAddress(db, row.citingKind, row.citingId),
          citedAddress: resolveEdgeNodeAddress(db, row.citedKind, row.citedId),
          relation: row.relation,
          tags,
          edgeIds: products.map((tuple) => tuple.finalId).sort((a, b) => a - b),
        });
      }

      const merged: LaneModelV12SideTagMergedEdge[] = casualties
        .map(({ kept, dropped }) => ({
          citingAddress: resolveEdgeNodeAddress(db, kept.source.citingKind, kept.source.citingId),
          citedAddress: resolveEdgeNodeAddress(db, kept.source.citedKind, kept.source.citedId),
          relation: kept.source.relation,
          tailTag: kept.tailTag,
          headTag: kept.headTag,
          keptEdgeId: kept.finalId,
          keptProvenance: kept.source.provenance,
          keptCreatedAtEpoch: kept.source.createdAtEpoch,
          keptTags: canonicalizeTagSet(readStoredTagSet(kept.source.tags)),
          droppedEdgeId: dropped.source.id,
          droppedProvenance: dropped.source.provenance,
          droppedCreatedAtEpoch: dropped.source.createdAtEpoch,
          droppedTags: canonicalizeTagSet(readStoredTagSet(dropped.source.tags)),
          rule: laneModelV12MergeRule(kept, dropped),
        }))
        .sort((left, right) => left.droppedEdgeId - right.droppedEdgeId);

      const receipt: LaneModelV12TwoSidedTagsReceipt = {
        disposition: "expanded",
        rowsBefore: sourceRows.length,
        rowsAfter: survivors.length,
        split,
        merged,
        mergedCount: merged.length,
        unsettled: countUnsettledEdges(db),
      };
      writeMigrationReceipt(db, LANE_MODEL_V12_TWO_SIDED_TAGS_RECEIPT, nowEpoch, receipt);

      const violations = db
        .query<Record<string, unknown>, []>("PRAGMA foreign_key_check")
        .all();
      if (violations.length > 0) {
        throw new Error(
          `memory_edges rebuild left ${violations.length} foreign key violation(s) while internalizing tags into tail_tag/head_tag: ${JSON.stringify(violations)}`,
        );
      }
    });
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
}

// ---------------------------------------------------------------------------
// lane-model-v12 M-E — the merged tag set leaves (ticket 09, contract)
// ---------------------------------------------------------------------------

/** Same shape as M-A's receipt name, and NOT `lane-declaration-`: an end-to-end test counts that prefix as the registry's phase set. */
export const LANE_MODEL_V12_MERGED_TAG_SET_RETIRED_RECEIPT =
  "lane-model-v12-me-merged-tag-set-retired";

export interface LaneModelV12MergedTagSetRetiredReceipt {
  /**
   * `contracted` — the table carried `tags` and was rewritten without it.
   * `born-sides-only` — it was already in the contract shape, so there was no
   * transformation to record. Stated rather than left as a missing receipt,
   * for M-A's own reason: "this phase never saw this database" and "it saw it
   * and had nothing to do" are different facts.
   */
  disposition: "contracted" | "born-sides-only";
  rowsBefore: number;
  rowsAfter: number;
  /** Rows the retired merged index (`memory_edge_tags`) held when it was dropped — the only number that describes what left with it. */
  mergedIndexRows: number;
  /** Side-index rows AFTER the swap. Equal to the count before it by construction (the copy preserves every `id`, so no child row is orphaned) and asserted below, so a cascade that fired despite the pragma is a named error rather than a silently emptied index. */
  sideIndexRows: number;
}

function memoryEdgesHasMergedTagSet(db: Database): boolean {
  if (!hasTable(db, "memory_edges")) {
    return false;
  }
  return db
    .query<{ name: string }, []>("SELECT name FROM pragma_table_info('memory_edges')")
    .all()
    .some((row) => row.name === "tags");
}

/** Rows in the side index, for the before/after equality M-E asserts across its table swap. */
function countMemoryEdgeSideTagRows(db: Database): number {
  return (
    db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM memory_edge_side_tags",
      )
      .get()?.count ?? 0
  );
}

/**
 * M-E (lane-model-v12 spec D1, ticket 09): the merged `tags` column and its
 * index table leave, and `(pair, relation, tail_tag, head_tag)` becomes the
 * whole of an edge's identity.
 *
 * WHY A WHOLE-TABLE REBUILD. `ALTER TABLE memory_edges DROP COLUMN tags` is
 * refused outright by SQLite: the column is part of the UNIQUE constraint, and
 * a constrained or indexed column cannot be dropped. So this takes the same
 * create-temp/copy/drop-original/rename-in shape as M-A and M-D, which is also
 * the order that is correct under EITHER `legacy_alter_table` setting —
 * renaming the ORIGINAL away instead would, with the pragma off, rewrite the
 * three endpoint prune triggers AND `memory_edge_side_tags`' own
 * `REFERENCES memory_edges(id)` onto the temporary name, leaving both pointed
 * at a table this function then drops.
 *
 * THE SIDE INDEX IS PRESERVED, NOT REGENERATED, and that is deliberate. The
 * copy carries every `id` verbatim, so no `memory_edge_side_tags` row is ever
 * orphaned; `PRAGMA foreign_keys = OFF` around the swap is what stops the
 * `DROP TABLE` from cascading those rows away in the moment the parent is
 * absent. Rebuilding the index here would make that pragma unfalsifiable —
 * the index would come out right whether or not the cascade fired. Instead
 * the before/after counts are compared and a mismatch is a named error, so
 * removing the pragma reddens a test with a sentence in it rather than
 * quietly costing a lookup table.
 *
 * NO MERGE RULE, unlike M-A and M-B, and this is a claim rather than an
 * omission: after M-A, `tags` is a strict FUNCTION of the two sides for every
 * relation-carrying row (single tag on both sides, or `'[]'` with both
 * unsettled), so two rows that tie on the narrower key already tied on the
 * wider one and were merged there. Bare rows carry `relation IS NULL`, which
 * SQLite's UNIQUE never treats as equal, so they cannot collide either. The
 * check below states that as a precondition instead of trusting it: a
 * collision means M-A did not run, and a raw SQLITE_CONSTRAINT from the copy
 * would be a far worse way to learn it.
 *
 * Data and receipt commit in ONE transaction, so "contracted but unrecorded"
 * and "recorded but not contracted" are not states this database can be found
 * in — a failpoint test pins it, because a receipt row plus an idempotent
 * second run does not prove that on its own.
 */
export function ensureMemoryEdgesLaneModelV12MergedTagSetRetired(
  db: Database,
  nowEpoch: number = Math.floor(Date.now() / 1000),
): void {
  if (!hasTable(db, "memory_edges")) {
    return;
  }

  if (!memoryEdgesHasMergedTagSet(db)) {
    runWriteTransaction(db, () => {
      if (hasMigrationReceipt(db, LANE_MODEL_V12_MERGED_TAG_SET_RETIRED_RECEIPT)) {
        return;
      }
      const rows = countMemoryEdges(db);
      const receipt: LaneModelV12MergedTagSetRetiredReceipt = {
        disposition: "born-sides-only",
        rowsBefore: rows,
        rowsAfter: rows,
        mergedIndexRows: 0,
        sideIndexRows: countMemoryEdgeSideTagRows(db),
      };
      writeMigrationReceipt(
        db,
        LANE_MODEL_V12_MERGED_TAG_SET_RETIRED_RECEIPT,
        nowEpoch,
        receipt,
      );
    });
    return;
  }

  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    runWriteTransaction(db, () => {
      if (!memoryEdgesHasMergedTagSet(db)) {
        return;
      }

      const collisions = db
        .query<{ n: number }, []>(
          `SELECT COUNT(*) AS n FROM (
             SELECT 1 FROM memory_edges
             WHERE relation IS NOT NULL
             GROUP BY citing_kind, citing_id, cited_kind, cited_id,
                      relation, tail_tag, head_tag
             HAVING COUNT(*) > 1
           )`,
        )
        .get()!;
      if (collisions.n > 0) {
        throw new Error(
          `memory_edges holds ${collisions.n} identity key(s) that only the retired ` +
            "merged tag set kept apart, so dropping it would collide. After M-A every " +
            "row's tag set is a function of its two sides, so this means the two-sided " +
            "internalization (ensureMemoryEdgesLaneModelV12TwoSidedTags) has not run — " +
            "see lane-model-v12 spec D4.",
        );
      }

      const rowsBefore = countMemoryEdges(db);
      const sideIndexRowsBefore = countMemoryEdgeSideTagRows(db);
      const mergedIndexRows = hasTable(db, "memory_edge_tags")
        ? db
            .query<{ count: number }, []>(
              "SELECT COUNT(*) AS count FROM memory_edge_tags",
            )
            .get()?.count ?? 0
        : 0;

      db.exec(
        memoryEdgesTableDdl(
          "memory_edges_sides_only_rebuild",
          MEMORY_EDGES_LANE_MODEL_V12_RELATION_WORDS,
          "sides-only",
        ),
      );
      // Prepared-and-run, never a multi-statement `exec`: bun:sqlite's `exec`
      // SWALLOWS one statement's constraint failure and runs the rest, so a
      // refused row would vanish in silence and this migration would report a
      // clean contraction over a table it had just emptied.
      db.query(
        `INSERT INTO memory_edges_sides_only_rebuild (
           id, citing_kind, citing_id, cited_kind, cited_id,
           relation, provenance, tail_tag, head_tag, created_at_epoch
         )
         SELECT
           id, citing_kind, citing_id, cited_kind, cited_id,
           relation, provenance, tail_tag, head_tag, created_at_epoch
         FROM memory_edges
         ORDER BY id`,
      ).run();

      db.exec("DROP TABLE memory_edges");
      db.exec("ALTER TABLE memory_edges_sides_only_rebuild RENAME TO memory_edges");
      // The indexes belonged to the dropped table and died with it.
      db.exec(MEMORY_EDGES_INDEXES_DDL);
      // The merged index goes in the SAME transaction as the column it
      // indexed: leaving it behind would keep a table alive whose only
      // remaining property is that nothing may read it.
      db.exec("DROP TABLE IF EXISTS memory_edge_tags");

      const rowsAfter = countMemoryEdges(db);
      if (rowsAfter !== rowsBefore) {
        throw new Error(
          `memory_edges lost ${rowsBefore - rowsAfter} row(s) while retiring the merged ` +
            `tag set (${rowsBefore} before, ${rowsAfter} after). The copy is straight and ` +
            "carries every id, so this is a constraint refusal, not a merge.",
        );
      }
      const sideIndexRows = countMemoryEdgeSideTagRows(db);
      if (sideIndexRows !== sideIndexRowsBefore) {
        throw new Error(
          `memory_edge_side_tags lost ${sideIndexRowsBefore - sideIndexRows} row(s) across ` +
            "the memory_edges rebuild. Its edge_row_id REFERENCES memory_edges(id) ON " +
            "DELETE CASCADE, and this rebuild preserves every id — so the rows can only " +
            "have gone if foreign keys were enforced while the parent table was dropped.",
        );
      }

      const receipt: LaneModelV12MergedTagSetRetiredReceipt = {
        disposition: "contracted",
        rowsBefore,
        rowsAfter,
        mergedIndexRows,
        sideIndexRows,
      };
      writeMigrationReceipt(
        db,
        LANE_MODEL_V12_MERGED_TAG_SET_RETIRED_RECEIPT,
        nowEpoch,
        receipt,
      );

      const violations = db
        .query<Record<string, unknown>, []>("PRAGMA foreign_key_check")
        .all();
      if (violations.length > 0) {
        throw new Error(
          `memory_edges rebuild left ${violations.length} foreign key violation(s) while retiring the merged tag set: ${JSON.stringify(violations)}`,
        );
      }
    });
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
}

// ---------------------------------------------------------------------------
// container-unification D10 (ticket 02) — the relation graph is turn→turn
// ---------------------------------------------------------------------------

/**
 * Not `lane-declaration-` and not `lane-model-v12-`: this is a later, separate
 * ticket (container-unification, spec D10), and an end-to-end test that counts
 * either prefix as "that phase set" must not pick this receipt up by accident.
 */
export const MEMORY_EDGES_RELATION_TURN_SCOPED_RECEIPT =
  "memory-edges-relation-turn-scoped";

/**
 * One row this migration deleted — recorded so a reader asking "what left"
 * months later does not have to reconstruct it from a live database that
 * long since stopped holding the answer (same obligation the lane-model-v12
 * merge/split receipts state for themselves).
 */
export interface MemoryEdgesRelationTurnScopedStrayEdge {
  edgeId: number;
  citingAddress: string;
  citedAddress: string;
  relation: string | null;
  provenance: string;
  createdAtEpoch: number;
}

export interface MemoryEdgesRelationTurnScopedReceipt {
  strayRowsDeleted: number;
  strayRows: readonly MemoryEdgesRelationTurnScopedStrayEdge[];
  rowsBefore: number;
  rowsAfter: number;
  sideIndexRows: number;
}

interface MemoryEdgesRelationTurnScopedStrayRow {
  id: number;
  citingKind: string;
  citingId: number;
  citedKind: string;
  citedId: number;
  relation: string | null;
  provenance: string;
  createdAtEpoch: number;
}

/**
 * container-unification D10 (ticket 02): the four `provenance='judged'`
 * `turn→segment`/`segment→segment` rows are residue from before the relation
 * vocabulary was narrowed (spec: "3 条 bare 一条 verifies, 2026-08-13/14 写下")
 * — a one-time cleanup, not a standing rule (that part is the CHECK below).
 * `text-ref`'s 897-and-growing non-turn→turn rows (measured 2026-08-26) are a
 * DIFFERENT population — the prose-citation index — and untouched by this
 * predicate: it names `provenance = 'judged'` explicitly rather than "any
 * non-turn→turn row", so a `text-ref` row can never match it no matter how the
 * count moves.
 */
function memoryEdgesRelationTurnScopedStrayRows(
  db: Database,
): MemoryEdgesRelationTurnScopedStrayRow[] {
  return db
    .query<MemoryEdgesRelationTurnScopedStrayRow, []>(
      `SELECT id, citing_kind AS citingKind, citing_id AS citingId,
              cited_kind AS citedKind, cited_id AS citedId,
              relation, provenance, created_at_epoch AS createdAtEpoch
         FROM memory_edges
        WHERE provenance = 'judged'
          AND NOT (citing_kind = 'turn' AND cited_kind = 'turn')
        ORDER BY id`,
    )
    .all();
}

/**
 * THE MARKER, AND WHY IT IS MONOTONIC. This is a receipt-only gate — no DDL
 * text, no column probe — and that is deliberate, not a shortcut.
 *
 * The trap this file has already paid for twice (see
 * `memoryEdgesLaneModelV12RelationContractIsStale`'s and
 * `memoryEdgesTagSetIdentityIsStale`'s own comments) is a staleness probe
 * keyed on the ARRIVAL of new DDL text: the moment some LATER migration has
 * reason to rewrite that text — even for an unrelated reason, even leaving the
 * RESTRICTION itself intact — the probe reads a fully-migrated database as
 * virgin stock and reruns the rebuild from a hardcoded pre-migration column
 * list, silently dropping whatever that list omits. `memory_edges` is
 * rebuilt by name eleven times over in this file's history; a clause added to
 * its CHECK has no special protection from being one more rebuild's copy
 * target one day.
 *
 * `migration_receipts` (schema.ts's own `CREATE TABLE`, "durable, not
 * log-only") is the one piece of state in this database that no migration in
 * this file's history — and by the table's own stated purpose, none to come —
 * ever DELETEs from. A row here is the one signal that cannot be
 * un-monotonic: once written it answers "has this phase been through this
 * database" the same way on every future open, independent of what any later
 * ticket does to `memory_edges`'s own DDL text.
 *
 * The trade this makes: unlike `ensureMemoryEdgesLaneModelV12TwoSidedTags` /
 * `...MergedTagSetRetired`, there is no physical "already narrow, nothing to
 * do" fast path — every database, including one created fresh after this
 * ticket ships, does one real rebuild the first time this runs, because
 * `MEMORY_EDGES_DDL` (the fresh-creation shape) is deliberately born in the
 * OLDEST lane shape for an unrelated ordering reason (see its own comment) and
 * only reaches the current shape by walking this same migration chain. That
 * symmetry is what keeps the predicate simple: "has the receipt" and "has this
 * rebuild run" are the same fact for every database this code will ever open.
 */
function memoryEdgesRelationTurnScopedIsSettled(db: Database): boolean {
  return hasMigrationReceipt(db, MEMORY_EDGES_RELATION_TURN_SCOPED_RECEIPT);
}

/**
 * container-unification D10 (ticket 02): delete the stray rows, then narrow
 * `memory_edges`'s CHECK so a relation-carrying row can only be turn→turn.
 * `text-ref`'s bare rows (`relation IS NULL`) are unaffected on both counts —
 * `memoryEdgesRelationTurnScopedStrayRows`'s predicate excludes them by
 * provenance, and the CHECK's own `relation IS NULL OR …` arm excludes them
 * by construction.
 *
 * ONE transaction for the delete, the rebuild and the receipt — same
 * discipline M-A/M-E state for themselves: "deleted but the CHECK still
 * wide" and "narrowed but unrecorded" are not states this database can be
 * found in.
 *
 * WHY THE DELETE RUNS INSIDE THIS SAME FUNCTION rather than as its own
 * migration upstream: the rebuild's copy below is STRAIGHT and unfiltered —
 * `SELECT * FROM memory_edges`, no `WHERE` — exactly like M-E's own contract
 * rebuild, and for the same reason (a filtered copy would be a second,
 * silent copy of the deletion rule that could drift from the one above). A
 * straight copy into the narrower CHECK is only valid once nothing left in
 * the table can violate it, so the delete must have already run in this same
 * open — the precondition check below turns a missed ordering into a named
 * error instead of a raw `SQLITE_CONSTRAINT` mid-copy.
 *
 * Every mutating statement is a prepared `.query(...).run()`/`.all()`, never
 * a multi-statement `db.exec` — bun:sqlite's `exec` swallows one statement's
 * constraint failure and silently runs the rest, which is exactly how a
 * migration loses rows without anyone noticing.
 */
export function ensureMemoryEdgesRelationTurnScoped(
  db: Database,
  nowEpoch: number = Math.floor(Date.now() / 1000),
): void {
  if (!hasTable(db, "memory_edges")) {
    return;
  }
  // A read, not a decision: it only says whether taking the write lock is
  // worth it — the same double-check idiom as ensureNoteDebtReasonVocabulary
  // and every memory_edges migration above.
  if (memoryEdgesRelationTurnScopedIsSettled(db)) {
    return;
  }

  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    runWriteTransaction(db, () => {
      if (memoryEdgesRelationTurnScopedIsSettled(db)) {
        return;
      }

      const strayRows = memoryEdgesRelationTurnScopedStrayRows(db);
      // Explicit, not relied on via CASCADE: `PRAGMA foreign_keys` is OFF for
      // the rebuild below (same reason M-E states for itself — it must not
      // fire while `memory_edges` is briefly absent during the drop/rename),
      // so a stray row that happened to carry a settled side tag would leave
      // an orphaned `memory_edge_side_tags` row if this deletion depended on
      // the cascade instead of doing its own cleanup. (Measured: none of the
      // 4 stray rows carry one — bare rows never get a side-tag entry, and
      // the one `verifies` row's tail/head are both unsettled — but the
      // cleanup does not assume that stays true.)
      const deleteStraySideTags = db.query<unknown, [number]>(
        `DELETE FROM memory_edge_side_tags WHERE edge_row_id = ?`,
      );
      const deleteStrayEdge = db.query<unknown, [number]>(
        `DELETE FROM memory_edges WHERE id = ?`,
      );
      for (const row of strayRows) {
        deleteStraySideTags.run(row.id);
        deleteStrayEdge.run(row.id);
      }

      const remaining = db
        .query<{ n: number }, []>(
          `SELECT COUNT(*) AS n FROM memory_edges
           WHERE relation IS NOT NULL
             AND NOT (citing_kind = 'turn' AND cited_kind = 'turn')`,
        )
        .get()!;
      if (remaining.n > 0) {
        throw new Error(
          `memory_edges still holds ${remaining.n} relation-carrying row(s) that are ` +
            "not turn→turn after the provenance='judged' stray-row cleanup, so the " +
            "turn-scoped CHECK narrow would refuse them. This predicate only removes " +
            "`judged` rows (container-unification spec D10); a different provenance " +
            "producing this shape means some write path is minting a relation-carrying " +
            "non-turn→turn edge and must be fixed before this migration can run.",
        );
      }

      const rowsBefore = countMemoryEdges(db);
      const sideIndexRowsBefore = countMemoryEdgeSideTagRows(db);

      db.exec(
        memoryEdgesTableDdl(
          "memory_edges_relation_turn_scoped_rebuild",
          MEMORY_EDGES_LANE_MODEL_V12_RELATION_WORDS,
          "sides-only",
          true,
        ),
      );
      db.query(
        `INSERT INTO memory_edges_relation_turn_scoped_rebuild (
           id, citing_kind, citing_id, cited_kind, cited_id,
           relation, provenance, tail_tag, head_tag, created_at_epoch
         )
         SELECT
           id, citing_kind, citing_id, cited_kind, cited_id,
           relation, provenance, tail_tag, head_tag, created_at_epoch
         FROM memory_edges
         ORDER BY id`,
      ).run();

      db.exec("DROP TABLE memory_edges");
      db.exec(
        "ALTER TABLE memory_edges_relation_turn_scoped_rebuild RENAME TO memory_edges",
      );
      // The indexes belonged to the dropped table and died with it.
      db.exec(MEMORY_EDGES_INDEXES_DDL);

      const rowsAfter = countMemoryEdges(db);
      if (rowsAfter !== rowsBefore) {
        throw new Error(
          `memory_edges lost ${rowsBefore - rowsAfter} row(s) while narrowing the ` +
            `relation CHECK to turn→turn (${rowsBefore} before, ${rowsAfter} after). ` +
            "The copy is straight and carries every id, so this is a constraint " +
            "refusal, not the stray-row cleanup (which already ran and is reflected " +
            "in both counts).",
        );
      }
      const sideIndexRows = countMemoryEdgeSideTagRows(db);
      if (sideIndexRows !== sideIndexRowsBefore) {
        throw new Error(
          `memory_edge_side_tags lost ${sideIndexRowsBefore - sideIndexRows} row(s) ` +
            "across the memory_edges rebuild. Its edge_row_id REFERENCES " +
            "memory_edges(id) ON DELETE CASCADE, and this rebuild preserves every id " +
            "— so the rows can only have gone if foreign keys were enforced while the " +
            "parent table was dropped.",
        );
      }

      const receipt: MemoryEdgesRelationTurnScopedReceipt = {
        strayRowsDeleted: strayRows.length,
        strayRows: strayRows.map((row) => ({
          edgeId: row.id,
          citingAddress: resolveEdgeNodeAddress(db, row.citingKind, row.citingId),
          citedAddress: resolveEdgeNodeAddress(db, row.citedKind, row.citedId),
          relation: row.relation,
          provenance: row.provenance,
          createdAtEpoch: row.createdAtEpoch,
        })),
        rowsBefore,
        rowsAfter,
        sideIndexRows,
      };
      writeMigrationReceipt(
        db,
        MEMORY_EDGES_RELATION_TURN_SCOPED_RECEIPT,
        nowEpoch,
        receipt,
      );

      const violations = db
        .query<Record<string, unknown>, []>("PRAGMA foreign_key_check")
        .all();
      if (violations.length > 0) {
        throw new Error(
          `memory_edges rebuild left ${violations.length} foreign key violation(s) while narrowing the relation CHECK to turn→turn: ${JSON.stringify(violations)}`,
        );
      }
    });
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
}

/**
 * phase-connectivity ticket 05: `lane_read_receipts` gains `rendered_member_ids`
 * in place of `page_coverage`.
 *
 * DROPS the legacy table rather than translating it, for a reason that is the
 * defect itself: a stored page NUMBER cannot be turned into the member ids
 * that page showed, because the page SIZE that produced it was never
 * recorded — which is exactly why three pages at `pageSize: 1` used to
 * "cover" a 25-member lane. There is no honest translation, and inventing one
 * would carry the laundering forward.
 *
 * Losing the rows costs nothing a caller can notice: a receipt is scoped to
 * `claimWriterId(jobId, claimGeneration)` and is read only by the justify
 * check of the very claim that wrote it, so the worst case is that one
 * in-flight settlement run re-reads a lane it had already paged. The table is
 * also unreleased — it shipped in the same unreleased batch as this fix.
 *
 * PHASE-CONNECTIVITY TICKET 08, decision 4: the check and the drop happen in
 * ONE write transaction, and the shape is re-checked AFTER the lock is held.
 * `initializeSchema` runs from every entry point, and Claude Code starts two
 * hook processes in parallel for a single event (see `addColumnIfMissing`'s
 * own account of that model). Both could read the legacy shape; then one
 * dropped and the other threw `no such table`, or the late one dropped a table
 * the early one had already recreated and was writing into. The row loss
 * itself stays acceptable for the reason above; a throw out of schema
 * initialisation, or a drop of a live table, never was. `IF EXISTS` covers the
 * residual case where the table vanishes between the re-check and the drop —
 * a lost race must never throw.
 *
 * Exported for the concurrency test alone: the racing fixture has to enter
 * THIS function from a second process at a controlled moment, and going
 * through `initializeSchema` would park that process on the DDL above it long
 * before it reached the window under test.
 */
export function ensureLaneReadMemberCoverageReceipts(db: Database): void {
  if (!hasTable(db, "lane_read_receipts")) {
    return;
  }
  if (!hasColumn(db, "lane_read_receipts", "page_coverage")) {
    return;
  }
  runWriteTransaction(db, () => {
    // Re-read under the lock: everything above was decided without one, so a
    // process that lost the race is looking at a shape that no longer exists.
    if (!hasTable(db, "lane_read_receipts")) {
      return;
    }
    if (!hasColumn(db, "lane_read_receipts", "page_coverage")) {
      return;
    }
    db.exec("DROP TABLE IF EXISTS lane_read_receipts");
  });
}

/**
 * Phase-connectivity ticket 08, decision 3: the evidence a durable
 * justification was granted on, added to an existing
 * `lane_disposition_justifications` — the `phase_retype_audits` precedent
 * (additive columns, never a table rebuild). See that table's own DDL comment
 * for what the two sequences mean and why the default is 0.
 *
 * Runs unconditionally after the DDL blob that creates the table, so a fresh
 * database (whose CREATE TABLE already carries both columns) simply finds
 * nothing to add.
 */
function ensureLaneDispositionJustificationEvidence(db: Database): void {
  if (!hasTable(db, "lane_disposition_justifications")) {
    return;
  }
  addColumnIfMissing(
    db,
    "lane_disposition_justifications",
    "representative_a_content_sequence",
    "INTEGER NOT NULL DEFAULT 0",
  );
  addColumnIfMissing(
    db,
    "lane_disposition_justifications",
    "representative_b_content_sequence",
    "INTEGER NOT NULL DEFAULT 0",
  );
}

/** Rows with NEITHER side settled — the queue the spec's first control quantity counts (target: 0, once attribution is done). */
function countUnsettledEdges(db: Database): number {
  return (
    db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM memory_edges WHERE tail_tag = '' AND head_tag = ''",
      )
      .get()?.count ?? 0
  );
}

function ensureMemoryEdgesSchema(db: Database): void {
  const isFirstCreation = !hasTable(db, "memory_edges");
  if (!isFirstCreation) {
    ensureMemoryEdgesPairIdentity(db);
    ensureMemoryEdgesRelationVocabulary(db);
    ensureMemoryEdgesMultiRelation(db);
    ensureMemoryEdgesSelfReferenceCheck(db);
    ensureMemoryEdgesVocabularyFlip(db);
    ensureMemoryEdgesRelationContract(db);
    ensureMemoryEdgesIndexesRename(db);
    ensureMemoryEdgesTagSetIdentity(db);
  }
  db.exec(MEMORY_EDGES_DDL);
  // 2026-08-21 incident crutch removal ([S15069/T1136]): a review rehearsal ran
  // this migration against the production database ahead of release, and the
  // still-live 0.12.1 bundle's `ON CONFLICT (citing_kind, citing_id,
  // cited_kind, cited_id)` could no longer prepare against the rebuilt table.
  // The stopgap (user-approved plan B) was a hand-created 4-column UNIQUE
  // index restoring that clause — valid only while no writer can mint
  // multi-relation pairs. This build's writers CAN, so the crutch must go the
  // moment this code runs; the multi-relation staleness probe keys on the
  // table's CHECK text and would never notice a surplus index on its own.
  db.exec("DROP INDEX IF EXISTS idx_memory_edges_legacy_pair;");
  // Runs BEFORE the DDL below, whose `CREATE TABLE IF NOT EXISTS` would
  // otherwise leave a legacy-shaped `lane_read_receipts` standing untouched.
  ensureLaneReadMemberCoverageReceipts(db);
  // Idempotent (CREATE TRIGGER IF NOT EXISTS) and safe to (re-)run on every
  // process start, including on a database whose triggers already exist from
  // an earlier version of this same function.
  db.exec(MEMORY_EDGE_ENDPOINT_TRIGGERS_DDL);
  // Ticket 08 decision 3: additive, and after the DDL above has guaranteed the
  // table exists.
  ensureLaneDispositionJustificationEvidence(db);
  // rubric-v10 ticket 01: idempotent (CREATE TABLE/INDEX IF NOT EXISTS),
  // depends on memory_edges.id existing above it in this same function.
  //
  // GATED on the column since lane-model-v12 ticket 09 (M-E drops both
  // together): this index has no readers left, only the lane-registry
  // migration's own targeted DELETEs (db/lanes.ts), which run against the
  // pre-v12 shape — exactly the databases where the column is still here. An
  // unconditional create would re-mint the table, empty, on every open after
  // M-E, and the migration that dropped it would never run again to notice.
  if (memoryEdgesHasMergedTagSet(db)) {
    db.exec(MEMORY_EDGE_TAGS_DDL);
  }
  // lane-model-v12 ticket 05: same idempotence, same dependency. Created for
  // EVERY database, including one whose `memory_edges` is still one-sided at
  // this point — M-A (the last phase of `runLaneModelV12EdgeMigration`) fills
  // it, and an empty table is the honest state until then.
  db.exec(MEMORY_EDGE_SIDE_TAGS_DDL);

  if (isFirstCreation) {
    migrateTurnCitationsToEdges(db);
  }
}

/**
 * Fold every turn↔turn citation edge the legacy `turn_citations` table still
 * holds into the universal table (spec D13's original "收编重造", narrowed by
 * ticket 05/spec C13 — the table this fed used to stay alive forever on a
 * one-way migration; now it is a step on the way to dropping that table
 * outright, see `retireLegacyTurnCitationsTable`).
 *
 * The fold-in goes through `writeMemoryEdges`, not its own SQL, so the legacy
 * rows land under exactly the storage rules every live write obeys (D2): a
 * legacy relation the pair does not yet carry becomes an ADDITIONAL row rather
 * than overwriting whatever `memory_edges` already holds, a legacy relation
 * already present is a no-op, and a citation that remaps to NULL contributes
 * the pair only if nothing records it yet. This retires spec C16's "the
 * citation side wins on an overlap" rule, which was an artefact of the
 * one-relation-per-pair key: with (pair, relation) identity there is no
 * contest to settle — the citation's claim and the edge's claim both fit.
 *
 * A pair the legacy table held under two relations (its wider key allowed
 * that) is still collapsed to the single relation `pickWinningLegacyRelation`
 * selects, with the same builds-on/implements remap the schema rebuild uses
 * (spec C2): that collapse is about which of several ANCIENT relabellings to
 * trust, not about storage width, and blindly importing all of them would mint
 * relations no writer ever asserted. Legacy rows land on `judged` provenance:
 * `turn_citations` was only ever written from an explicit `cites` array, i.e.
 * a writer assigned that relation directly, and `judged` is the closest of the
 * new vocabulary's five values to "a model assigned this relation" without
 * claiming it was `asserted` by the SAME call that wrote the citing prose,
 * which the migration cannot know for rows this old.
 *
 * Returns how many ROWS this call added — a genuine no-op re-run (every
 * legacy claim already stored) returns 0. Idempotency is `writeMemoryEdges`'s
 * own, not a WHERE-guard maintained here.
 */
export function migrateTurnCitationsToEdges(db: Database): number {
  if (!hasTable(db, "turn_citations") || !hasTable(db, "memory_edges")) {
    return 0;
  }

  const rows = db
    .query<
      {
        citingTurnId: number;
        citedTurnId: number;
        relation: string;
        createdAtEpoch: number;
      },
      []
    >(
      `SELECT citing_turn_id AS citingTurnId, cited_turn_id AS citedTurnId,
              relation, created_at_epoch AS createdAtEpoch
       FROM turn_citations`,
    )
    .all();
  if (rows.length === 0) {
    return 0;
  }

  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.citingTurnId}:${row.citedTurnId}`;
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      groups.set(key, [row]);
    }
  }

  const inputs: WriteEdgeInput[] = [];
  for (const bucket of groups.values()) {
    const sample = bucket[0]!;
    // Every candidate here carries `judged` provenance (turn_citations was
    // only ever written from an explicit `cites` array), so the picker's
    // provenance rank comparison is always a tie and the relation choice
    // falls to "has one" then lexicographic order — deterministic, and the
    // returned provenance is always `judged` in practice.
    const winner = pickWinningLegacyRelation(
      bucket.map((row) => ({
        relation: row.relation,
        provenance: "judged" as const,
        createdAtEpoch: row.createdAtEpoch,
      })),
    );
    inputs.push({
      citing: { kind: "turn", id: sample.citingTurnId },
      cited: { kind: "turn", id: sample.citedTurnId },
      relation: winner.relation,
      provenance: winner.provenance,
      // The row being carried across already happened at a real moment;
      // re-stamping it "now" would make "when did this edge first appear" lie.
      createdAtEpoch: winner.createdAtEpoch,
    });
  }

  const before = countMemoryEdges(db);
  // A historical import of relations a writer already asserted, not a new
  // classification anyone is making here. (It used to have to say so out loud
  // through `eligibleForRelation: "unrestricted"`; ticket 04 deleted that
  // parameter along with the C7 rule it enforced.)
  writeMemoryEdges(db, inputs, 0);
  return countMemoryEdges(db) - before;
}

// Ticket 05 (spec C13): the dual edge graph is resolved by collapsing to
// `memory_edges` and retiring `turn_citations` outright — "both alive on an
// insert-only migration is not an outcome" is the spec's own words. Every row
// the legacy table could still hold is folded in first (idempotent, safe to
// repeat), then the table is dropped so nothing can ever write it again or
// resurrect the two-table disagreement between the timeline's correction
// graph and the segment ranking key.
function retireLegacyTurnCitationsTable(db: Database): void {
  if (!hasTable(db, "turn_citations")) {
    return;
  }
  migrateTurnCitationsToEdges(db);
  db.exec("DROP TABLE turn_citations");
}

export function initializeSchema(db: Database): void {
  db.exec(SCHEMA_SQL);
  ensureDiaryDayStateTerminalColumn(db);
  ensureDiaryDayStateRetryDispositionColumn(db);
  ensureSessionTranscriptPathColumn(db);
  ensureSessionSummaryUpdatedAtEpochColumn(db);
  ensureSessionSummaryFieldColumns(db);
  ensureSessionLastRememberTurnIdColumn(db);
  ensureTurnTranscriptLineStartColumn(db);
  ensureTurnAssistantTranscriptColumn(db);
  ensureTurnInvalidationColumns(db);
  ensureTurnSignificanceGradeColumn(db);
  ensureSegmentInsightColumn(db);
  ensureSegmentWorkingStateColumns(db);
  ensureSegmentDerivedFacets(db);
  ensureSegmentStatusVocabulary(db);
  ensureTurnConsultedMemoriesColumn(db);
  ensureMemoryEdgesSchema(db);
  retireLegacyTurnCitationsTable(db);
  ensureSessionScanCursorColumns(db);
  ensureTurnCompactBoundarySchema(db);
  dropRetiredMaintenanceState(db);
  ensureForkLineageColumns(db);
  ensureSearchIndexSchema(db);
  ensureSessionProjectIndex(db);
  ensureTurnPromptIdIndex(db);
  ensureSettlementClaimGenerationColumn(db);
  ensureRepairLedgerClaimColumns(db);
  ensureObservationExtractionExclusionColumn(db);
  ensureWriteGateEpochColumns(db);
  ensureShadowNoteWriterOriginColumn(db);
  ensureNoteDebtReasonVocabulary(db);
  ensureNoteDebtRemindedColumn(db);
  ensureNoteDebtCursorReliefColumn(db);
  retireLegacyPendingNoteDebts(db);
  ensureNoteSettlementTriggerVocabulary(db);
  ensureNoteSettlementJobsRetrySchema(db);
  ensureNoteSettlementProposalIdempotencyKey(db);
  // Strictly before `ensureNoteSettlementWatermark`: it decides whether the
  // transition has already run by looking for the marker row, and on a
  // database still carrying the retired global-watermark shape that row
  // answers for a mechanism that no longer exists.
  retireGlobalNoteSettlementWatermarkShape(db);
  // After the trigger-vocabulary and retry-schema rebuilds above: this writes
  // 'abandoned'/'deterministic' into columns/CHECK values those two migrations
  // are what make legal in the first place.
  ensureNoteSettlementWatermark(db);
  dropLegacyMemoriesTable(db);
  // Last on purpose: every other turns-column migration above (parent_turn_id,
  // compact_boundary_uuid, consulted_memories, ...) must have
  // already landed on `turns` before this rebuild copies it, or the copy would
  // silently drop a column a database created between those migrations and
  // this one still needs.
  ensureTurnTypeMultiValueColumn(db);
  // `stripRetiredTopicTagNamespace` STOOD HERE and is deleted (staged-settlement
  // spec Rev 5, ticket 01): the `topic:` namespace carries one free subject
  // word per turn again, so a migration that ran on every open would have
  // eaten each new word at the next `initializeSchema` — a standing migration
  // and a live namespace cannot share a prefix. The words it already stripped
  // stay bare; there is no resurrection pass, and a bare legacy word is just a
  // tag that lost its namespace.
  // Also after `ensureTurnTypeMultiValueColumn`: this rebuild's own hardcoded
  // `type` column definition assumes the canonical strict-array shape that
  // function guarantees, so it must never be the one deciding what shape
  // `type` is in.
  retireTurnCitesRecordedColumn(db);
  // AFTER both `turns` rebuilds above (era-grant-by-settlement ticket 01), so a
  // database still needing one rebuilds a table this migration has not yet
  // widened and the seed then reads `turns` in its final shape. The rebuilds do
  // NOT depend on that order — they carry this column through when they find it
  // (`CONDITIONAL_TURNS_COLUMNS`), which is what a database that has already run
  // this migration needs, and what a test calling a rebuild directly gets.
  // Its own seed reads `note_settlement_jobs`, whose final shape
  // `ensureNoteSettlementJobsRetrySchema` above has already settled.
  ensureTurnEraGrantColumn(db);
  // Ticket 15 (topic registry retirement): folds each segment's topic name
  // into its members' own tags (or, for a zero-member segment, directly into
  // the segment's own stored tags) before `topics`/`segments.topic_id`
  // retire — see `retireTopicRegistry`'s own comment.
  retireTopicRegistry(db);
  // Strictly last (ticket 15): every rebuild above rewrites the member
  // columns this derives from.
  repairDerivedSegmentFacets(db);
  // Lane-declaration ticket 01 (spec D6/M0-M2): last of the pre-v12 chain, so
  // the turns/segments/memory_edges shapes it reads (segment ownership, tag
  // arrays) are the fully-migrated FINAL shape of that era, not an
  // intermediate one any earlier migration above is still rewriting.
  runLaneRegistryMigration(db);
  runLaneModelV12EdgeMigration(db);
  // container-unification D10 (ticket 02): NOT folded into
  // `runLaneModelV12EdgeMigration` above, even though it is one more
  // `memory_edges` rebuild in the same chain — that function's own docstring
  // scopes it to "any migration that changes what memory_edges stores about
  // LANES", and this migration is about node KIND, not lanes. Strictly after
  // it: the rebuild target names `tail_tag`/`head_tag` explicitly, which only
  // exist from M-A onward, and running before M-E specifically would silently
  // perform M-E's own `tags`-column drop as a side effect (the same
  // "phase doing another phase's job" hazard M-A's own comment states for
  // itself against M-D).
  ensureMemoryEdgesRelationTurnScoped(db);
  // Lane-model-v12 ticket 14 (spec D3e), strictly LAST and strictly after
  // `runLaneRegistryMigration`: that migration's M3 reads `segments.tags` as
  // the CURATED vocabulary and stamps members from it, against a hardcoded
  // `(segmentId, curatedTags)` allowlist. Clearing a segment's list before M3
  // runs would leave that allowlist matching nothing and the whole membership
  // phase a silent no-op — the same ordering hazard D4 states for the edge
  // columns, on the other column.
  runSegmentOneTagMigration(db);
}

/**
 * The lane-model-v12 edge-shape phase (v12 spec D4) — the ONE legal home for
 * any migration that changes what `memory_edges` stores about lanes.
 *
 * Its reason for existing is ordering, not its contents: v12 replaces `memory_edges.tags` with
 * `tail_tag`/`head_tag` (v12 tickets 05 expand, 09 contract), while
 * `runLaneRegistryMigration`'s M0 and M4 above still READ and WRITE `tags`.
 * Put that column work anywhere earlier in this function — including inside
 * `ensureMemoryEdgesSchema`, which is where it most naturally wants to go —
 * and the entire unreleased lane-declaration batch is voided at the first
 * open of a released build, silently.
 *
 * Two tests, not two comments, hold the order (see
 * `tests/db/schema.lane-migration-ordering.test.ts`):
 *
 *   - the barrier BELOW refuses to run this phase before the registry
 *     migration has settled, which catches this call moving up;
 *   - `assertPreLaneModelV12EdgeShape` inside `runLaneRegistryMigration`
 *     refuses to run a pending phase against an already-v12-shaped
 *     `memory_edges`, which catches the column change moving up — wherever
 *     its code is written, since it has to leave its mark on the table.
 */
export function runLaneModelV12EdgeMigration(db: Database): void {
  assertLaneRegistrySettled(db, "the lane-model-v12 edge-shape migration");
  // M-C (ticket 04): retract every row whose two ends are the same node. It
  // reads no lane column at all — only `citing_kind`/`citing_id` — so it is
  // order-independent with respect to the `tags` -> `tail_tag`/`head_tag`
  // work tickets 05/09 will add around it.
  //
  // BEFORE M-B on purpose: a self edge under a retired word would otherwise be
  // merged and recorded in M-B's receipt, then deleted here anyway, leaving a
  // receipt naming a row no longer in the table.
  runLaneModelV12SelfEdgeRetraction(db);
  // M-B (ticket 03): `refutes`/`supersedes` become `override`, and the
  // duplicates that rename creates are merged under the receipt's own audit
  // rule. Unlike M-C this phase DOES read a lane column (the identity key it
  // merges on ends in the tag payload), so it must run BEFORE tickets 05/09's
  // column change — it refuses loudly rather than silently if that order is
  // ever inverted.
  runLaneModelV12VocabularyMerge(db);
  // M-D (ticket 03): with no stored row left under either retired word, they
  // leave the table's CHECK. Strictly after M-B — the narrow CHECK would
  // refuse to copy a row M-B had not yet rewritten.
  ensureMemoryEdgesLaneModelV12RelationContract(db);
  // M-A (ticket 05, the EXPAND half): `tags` is internalized into
  // `tail_tag`/`head_tag`.
  //
  // AFTER M-B is a real constraint, and a tested one: M-B merges on an
  // identity key ending in the tag payload and rewrites it, and M-A's own
  // rebuild target is the seven-word CHECK — so an M-A that ran first would
  // stop with a named error rather than copy a retired-word row. Moving this
  // call above M-B reddens the older migration fixtures immediately.
  //
  // AFTER M-D is convention, NOT a live dependency, and the difference is
  // worth stating rather than implying. M-A's rebuild target ALREADY carries
  // M-D's narrow CHECK, so an M-A that ran first would simply perform M-D's
  // narrow as a side effect and leave M-D's own staleness probe (which looks
  // for `'supersedes'` in the stored DDL) with nothing to do — it can never
  // then copy the table back out of its two-sided shape. MEASURED: swapping
  // these two lines reddens no test. It stays last because M-D is the phase
  // that OWNS the vocabulary narrow, and a phase silently doing another
  // phase's job is how an ordering becomes load bearing without anyone
  // noticing. It is no longer LAST in this function, but it is still last of
  // the three that share a rebuild target — M-E below rebuilds one more time,
  // onto a shape none of these three can produce.
  ensureMemoryEdgesLaneModelV12TwoSidedTags(db);
  // M-E (ticket 09, the CONTRACT half): the merged `tags` column and its
  // index table leave, and identity ends in the two sides alone.
  //
  // STRICTLY AFTER M-A, and this ordering IS load bearing rather than
  // convention. M-E's precondition is that no two rows tie on the narrower
  // key; what makes that true is M-A having already merged every pair that
  // ties on the WIDER one, leaving `tags` a strict function of the two sides.
  // Run first, against a table with no `tail_tag` column at all, its own
  // rebuild target would have nothing to copy the sides from — so the
  // inversion fails loudly rather than dropping the lane facts on the floor.
  ensureMemoryEdgesLaneModelV12MergedTagSetRetired(db);
  // Staged-settlement ticket 02's homeless record (the wiring line only; the
  // tables, their keys and their active view are that ticket's own module).
  // LAST, and after both FK targets exist in their final shape: its rows
  // reference `note_settlement_jobs(id)` and `turns(id)`, and `turns` is
  // rebuilt several times above — a table created before those rebuilds would
  // be carrying a foreign key into a table that gets renamed out from under
  // it.
  ensureHomelessRecordTables(db);
}

// `note_debt` shipped in 0.9.0 with a two-value reason vocabulary; residual
// settlement (D9) added `closed` and the agent's explicit skip (裁决 24) adds
// `declined`. A CHECK constraint is part of the table definition, so it cannot
// be ALTERed and `CREATE TABLE IF NOT EXISTS` is a no-op on a database that
// already has the table: without this rebuild the first write of a new reason
// throws a constraint failure.
//
// Detection reads the stored DDL for the NEWEST value rather than a version
// counter, so each widening rebuilds exactly once and a database created fresh
// from the current DDL skips it. Widening again means moving this string.
function noteDebtReasonVocabularyIsStale(db: Database): boolean {
  const storedDdl =
    db
      .query<{ sql: string | null }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'note_debt'",
      )
      .get()?.sql ?? null;
  return storedDdl !== null && !storedDdl.includes("'declined'");
}

function ensureNoteDebtReasonVocabulary(db: Database): void {
  // A read, not a decision: it only says whether taking the write lock is worth
  // it. Two hook processes start on one event, so both can pass here.
  if (!noteDebtReasonVocabularyIsStale(db)) {
    return;
  }

  // One IMMEDIATE transaction with the same busy retry the rest of the write
  // path uses, and the eligibility re-read INSIDE it. Deciding outside the lock
  // is what let the loser of a two-hook start rename, copy and drop a ledger the
  // winner had already rebuilt — on a real `note_debt` that second copy is long
  // enough to outlive the hook connection's 800ms busy timeout and take schema
  // initialisation, and with it the caller's real work, down with it.
  //
  // The transaction is also what keeps the ledger whole: a crash between the
  // rename and the copy would leave it under a name nothing reads, which every
  // reader sees as "no debts".
  runWriteTransaction(db, () => {
    if (!noteDebtReasonVocabularyIsStale(db)) {
      return;
    }

    db.exec("ALTER TABLE note_debt RENAME TO note_debt_pre_closed_reason");
    db.exec(NOTE_DEBT_TABLE_DDL);
    // The column list is explicit rather than `SELECT *` so the copy survives a
    // reordering, and `reminded_at_epoch` is included only when the old table
    // has it: this rebuild runs on databases from either side of that column's
    // migration, and naming it unconditionally would fail on the older shape
    // while omitting it would silently re-ask every debt on the newer one.
    const carried = hasColumn(
      db,
      "note_debt_pre_closed_reason",
      "reminded_at_epoch",
    )
      ? ", reminded_at_epoch"
      : "";
    db.exec(
      `INSERT INTO note_debt (
         turn_id, session_id, prompt_number, status, reason,
         opened_at_epoch, closed_at_epoch, updated_at_epoch${carried}
       )
       SELECT turn_id, session_id, prompt_number, status, reason,
              opened_at_epoch, closed_at_epoch, updated_at_epoch${carried}
       FROM note_debt_pre_closed_reason`,
    );
    db.exec("DROP TABLE note_debt_pre_closed_reason");
    // The index followed the renamed table and died with it.
    db.exec(NOTE_DEBT_INDEX_DDL);
  });
}

// `reminded_at_epoch` records when the ordinary reminder listed a debt: NULL is
// "never", and only never-listed debts are eligible for it (裁决 22 — one debt,
// one ask). The backlog relief ignores the column by design; re-asking is the
// whole point of that valve.
//
// `note_debt` shipped in 0.9.0 without it — the PostToolUse reminder derived
// what it had shown from `note_id_exposures` — and CREATE TABLE IF NOT EXISTS is
// a no-op on a database that already has the table, so the column has to arrive
// by ALTER or the first prompt on any 0.9.x database throws "no such column".
// NULL is the correct legacy reading: nothing has been asked for under the new
// rule yet.
//
// The column carries no comment inside the DDL on purpose: SQLite's
// `ALTER TABLE … DROP COLUMN` rewrites the stored CREATE statement by deleting
// the column's text only, so a comment sitting between the previous column's
// comma and this one leaves a dangling comma behind and the drop fails with
// "incomplete input".
//
// Runs AFTER `ensureNoteDebtClosedReason`, which rebuilds the table from the
// current DDL: on a pre-`closed` database the rebuild already brings the column
// in and this call finds nothing to do.
function ensureNoteDebtRemindedColumn(db: Database): void {
  addColumnIfMissing(db, "note_debt", "reminded_at_epoch", "INTEGER");
}

// `note_debt_cursor` shipped in 0.9.0 with only the classification watermark,
// and CREATE TABLE IF NOT EXISTS is a no-op on a database that already has the
// table — so the relief watermark has to arrive by ALTER or every prompt on an
// existing database throws "no such column". 0 is the correct legacy reading:
// relief has never fired on those sessions.
function ensureNoteDebtCursorReliefColumn(db: Database): void {
  addColumnIfMissing(
    db,
    "note_debt_cursor",
    "last_relief_prompt_number",
    "INTEGER NOT NULL DEFAULT 0",
  );
}

/**
 * One-time write-off of every `note_debt` row still `pending` (spec D8, ticket
 * 06). The owed set has been a derived query since the prompt-clock ledger (03)
 * — nothing opens a debt pre-emptively any more, and the only surviving INSERT
 * (`recordDeclinedNoteDebt`) is born `skipped`. A `pending` row this finds is
 * therefore not an open obligation any reader still tracks; it is bookkeeping
 * stranded by the cutover, and this closes it the same way residual settlement
 * closes an abandoned session's tail (spec D9) — `status = 'skipped', reason =
 * 'closed'` — rather than deleting it, so the row stays available for audit.
 *
 * `closed` over some other write-off reason is a no-op choice for settlement:
 * `listOwedNoteTurnsInRange` (note-debt.ts) excludes a turn from its backfill
 * candidates only on `reason = 'declined'`, so a row this migration touches was
 * already not excluded while `pending` and stays not excluded as `closed` —
 * nothing about which turns settlement will still reconstruct changes.
 *
 * A plain `UPDATE … WHERE status = 'pending'` rather than a rename/rebuild:
 * this is a data write-off, not a shape change (D8 does not touch the CHECK
 * vocabulary — `closed` already exists there from
 * `ensureNoteDebtReasonVocabulary`, which must therefore run first), and the
 * predicate is naturally idempotent — after the first run nothing is left for
 * a second to match, so running this on every process start costs one indexed
 * no-op scan.
 *
 * Runs AFTER `ensureNoteDebtReasonVocabulary`: on a database that has not yet
 * widened the CHECK to admit `closed`, writing it here would fail the same
 * constraint that function exists to lift.
 */
export function retireLegacyPendingNoteDebts(db: Database): number {
  const nowEpoch = Math.floor(Date.now() / 1000);
  return db
    .query<unknown, [number, number]>(
      `UPDATE note_debt
       SET status = 'skipped', reason = 'closed',
           closed_at_epoch = ?, updated_at_epoch = ?
       WHERE status = 'pending'`,
    )
    .run(nowEpoch, nowEpoch).changes;
}

// `note_settlement_jobs` shipped (arc-spine-redesign, 0.8.4) with a three-value
// trigger vocabulary. Spec note-prompt-clock D7 (ticket 05) added a fourth
// (`sessionend`, frozen and enqueued by the SessionEnd hook), and the
// settlement-backfill ticket adds a fifth (`backfill`, the operator's explicit
// re-settlement of an already covered range). `trigger_type`'s CHECK constraint
// cannot be ALTERed, and `CREATE TABLE IF NOT EXISTS` is a no-op on a database
// that already has the table, so without this rebuild the first insert of the
// new value throws a constraint failure on every install that shipped before.
//
// Same detection idiom as `ensureNoteDebtReasonVocabulary`: read the stored DDL
// for the NEWEST value rather than a version counter. One predicate covers every
// older vocabulary at once — a three-value database and a four-value one are
// both simply missing `'backfill'`, and both are rebuilt to the single current
// DDL — while a fresh database skips entirely.
function noteSettlementTriggerVocabularyIsStale(db: Database): boolean {
  const storedDdl =
    db
      .query<{ sql: string | null }, []>(
        `SELECT sql FROM sqlite_master
         WHERE type = 'table' AND name = 'note_settlement_jobs'`,
      )
      .get()?.sql ?? null;
  return storedDdl !== null && !storedDdl.includes("'backfill'");
}

/**
 * Widen `trigger_type`'s CHECK by rebuilding the table, SQLite's 12-step ALTER
 * TABLE procedure — build the new table under a temporary name, copy, drop the
 * old, rename the new INTO place.
 *
 * The earlier form of this migration renamed the OLD table away instead
 * (`note_settlement_jobs` → `..._pre_sessionend`, recreate, copy, drop). That
 * shape is unsafe here for the reason spelled out at
 * `ensureTurnTypeMultiValueColumn`: `note_settlement_segment_exclusions` holds
 * `REFERENCES note_settlement_jobs(id) ON DELETE CASCADE`, and with
 * `PRAGMA foreign_keys = ON` (database.ts) SQLite's rename REPOINTS that clause
 * at the renamed table — so the subsequent `DROP TABLE` would cascade every
 * settlement exclusion row away and leave the exclusions table pointing at a
 * name nothing answers to. Renaming into place instead never moves the name the
 * REFERENCES clause names. It went unnoticed before only because that migration
 * predates any database holding exclusion rows.
 *
 * `PRAGMA foreign_keys` is a no-op inside a transaction, so it is turned off on
 * the connection before `runWriteTransaction` opens one and restored after.
 * `foreign_key_check` runs INSIDE the transaction (ticket 15 finding 4): a check
 * after the commit turns a violation into a durable swap plus a skipped
 * migration, i.e. no repair path.
 */
function ensureNoteSettlementTriggerVocabulary(db: Database): void {
  if (!noteSettlementTriggerVocabularyIsStale(db)) {
    return;
  }

  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    // One IMMEDIATE transaction, same shape as the note_debt rebuild: deciding
    // to rebuild outside the write lock is what lets two racing hook processes
    // both start it, and a crash mid-rebuild must not leave the jobs table
    // parked under a name nothing reads.
    runWriteTransaction(db, () => {
      if (!noteSettlementTriggerVocabularyIsStale(db)) {
        return;
      }

      db.exec(noteSettlementJobsTableDdl("note_settlement_jobs_trigger_rebuild"));
      // Explicit column list on both sides: a `SELECT *` copy would bind
      // positionally and silently mis-map the day this table grows a column.
      db.exec(
        `INSERT INTO note_settlement_jobs_trigger_rebuild (
           id, session_id, window_start, window_end, trigger_type, status,
           attempts, retry_at_epoch, claimed_at_epoch, claim_generation,
           last_error, created_at_epoch, updated_at_epoch
         )
         SELECT
           id, session_id, window_start, window_end, trigger_type, status,
           attempts, retry_at_epoch, claimed_at_epoch, claim_generation,
           last_error, created_at_epoch, updated_at_epoch
         FROM note_settlement_jobs`,
      );
      db.exec("DROP TABLE note_settlement_jobs");
      db.exec(
        "ALTER TABLE note_settlement_jobs_trigger_rebuild RENAME TO note_settlement_jobs",
      );
      // The index belonged to the dropped table and died with it.
      db.exec(NOTE_SETTLEMENT_JOBS_INDEX_DDL);

      const violations = db
        .query<Record<string, unknown>, []>("PRAGMA foreign_key_check")
        .all();
      if (violations.length > 0) {
        throw new Error(
          `note_settlement_jobs rebuild left ${violations.length} foreign key violation(s) while widening trigger_type: ${JSON.stringify(violations)}`,
        );
      }
    });
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
}

// Ticket 06 (read-write-contract spec, "作业状态机相应扩展"): `status` grows a
// fifth value (`abandoned`) and the table grows `failure_class` — both land
// through the SAME rebuild template `ensureNoteSettlementTriggerVocabulary`
// already established (`noteSettlementJobsTableDdl`), now updated to the
// current shape. Detected independently of that function's own staleness
// check: a database that already carries `'backfill'` (already migrated once)
// but not yet `'abandoned'` must still be rebuilt, and a fresh database never
// needs either rebuild at all.
function noteSettlementJobsRetrySchemaIsStale(db: Database): boolean {
  const storedDdl =
    db
      .query<{ sql: string | null }, []>(
        `SELECT sql FROM sqlite_master
         WHERE type = 'table' AND name = 'note_settlement_jobs'`,
      )
      .get()?.sql ?? null;
  return storedDdl !== null && !storedDdl.includes("'abandoned'");
}

/**
 * Same 12-step rebuild shape as `ensureNoteSettlementTriggerVocabulary`, one
 * schema generation later — see that function's own doc comment for why the
 * NEW table is built under a temporary name and renamed INTO place rather
 * than the old one renamed away (the FK from
 * `note_settlement_segment_exclusions` would otherwise repoint and cascade-
 * delete on the DROP).
 *
 * The copy's `failure_class` column is where the DATA migration lives (pinned
 * decision: "既有 failed 行按确定性语义迁移") — every row already sitting at
 * `status = 'failed'` is tagged `'deterministic'`; the column did not exist
 * before this migration, so there is no recorded distinction to preserve, and
 * treating every historical failure as the class that COUNTS toward the cap
 * is the conservative reading (a mis-tagged transient failure only costs a
 * future retry it would not otherwise have needed; the reverse would let a
 * genuinely broken window retry forever). `status` itself is copied verbatim
 * — an old `failed` row is NOT force-terminalised into `abandoned` by this
 * migration; the new cap only governs failures recorded from here on, so a
 * legacy row with attempts still under the new cap remains ordinarily
 * reclaimable, and one already at or over it simply stops being selected by
 * every claim/dispatch query (`attempts < maxAttempts`) exactly as it does
 * today — no debt row is synthesized retroactively for it.
 */
function ensureNoteSettlementJobsRetrySchema(db: Database): void {
  if (!noteSettlementJobsRetrySchemaIsStale(db)) {
    return;
  }

  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    runWriteTransaction(db, () => {
      if (!noteSettlementJobsRetrySchemaIsStale(db)) {
        return;
      }

      db.exec(noteSettlementJobsTableDdl("note_settlement_jobs_retry_rebuild"));
      db.exec(
        `INSERT INTO note_settlement_jobs_retry_rebuild (
           id, session_id, window_start, window_end, trigger_type, status,
           attempts, retry_at_epoch, claimed_at_epoch, claim_generation,
           last_error, failure_class, created_at_epoch, updated_at_epoch
         )
         SELECT
           id, session_id, window_start, window_end, trigger_type, status,
           attempts, retry_at_epoch, claimed_at_epoch, claim_generation,
           last_error,
           CASE WHEN status = 'failed' THEN 'deterministic' ELSE NULL END,
           created_at_epoch, updated_at_epoch
         FROM note_settlement_jobs`,
      );
      db.exec("DROP TABLE note_settlement_jobs");
      db.exec(
        "ALTER TABLE note_settlement_jobs_retry_rebuild RENAME TO note_settlement_jobs",
      );
      db.exec(NOTE_SETTLEMENT_JOBS_INDEX_DDL);

      const violations = db
        .query<Record<string, unknown>, []>("PRAGMA foreign_key_check")
        .all();
      if (violations.length > 0) {
        throw new Error(
          `note_settlement_jobs rebuild left ${violations.length} foreign key violation(s) while adding failure_class/abandoned: ${JSON.stringify(violations)}`,
        );
      }
    });
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
}

/**
 * `note_settlement_proposals` gains `addresses_key` (ticket 05, spec "propose
 * 携幂等键") — a plain `ALTER TABLE ADD COLUMN` (no CHECK referencing another
 * column, so no 12-step rebuild is needed, same shape as
 * `ensureSegmentWorkingStateColumns`). Existing rows are backfilled with the
 * SAME canonicalization `recordNoteSettlementProposal` uses for a fresh
 * insert (`canonicalizeSettlementProposalAddresses`), so a pre-existing row
 * and a future retry of the same address set collide correctly from the
 * first migration onward.
 *
 * The unique index is created AFTER the backfill, and the backfill
 * deliberately disambiguates any pre-existing (session, canonical-address-set)
 * COLLISION it finds among OLD rows (legal before this migration — nothing
 * enforced uniqueness yet) by suffixing the losing rows' key with their own
 * id: this migration's job is to make the constraint installable without
 * throwing on real production data and without silently discarding a row,
 * not to retroactively merge duplicate proposals a human never asked it to
 * merge.
 */
function ensureNoteSettlementProposalIdempotencyKey(db: Database): void {
  const columnAdded = addColumnIfMissing(
    db,
    "note_settlement_proposals",
    "addresses_key",
    "TEXT",
  );
  if (
    !columnAdded &&
    db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND name = 'idx_note_settlement_proposals_session_addresses'`,
      )
      .get()
  ) {
    // Both the column and the index already exist — nothing left to backfill.
    return;
  }

  const rows = db
    .query<{ id: number; sessionId: number; addresses: string }, []>(
      `SELECT id, session_id AS sessionId, addresses FROM note_settlement_proposals
       WHERE addresses_key IS NULL`,
    )
    .all();
  const seen = new Set<string>();
  for (const row of rows) {
    let addresses: unknown;
    try {
      addresses = JSON.parse(row.addresses);
    } catch {
      addresses = [];
    }
    const list = Array.isArray(addresses)
      ? addresses.filter((entry): entry is string => typeof entry === "string")
      : [];
    let key = canonicalizeSettlementProposalAddresses(list);
    const dedupeKey = `${row.sessionId}:${key}`;
    if (seen.has(dedupeKey)) {
      // A pre-existing duplicate the old, unconstrained table legally held —
      // disambiguate rather than collide (see this function's own doc
      // comment) so installing the unique index below never throws on real
      // data.
      key = `${key}#${row.id}`;
    }
    seen.add(dedupeKey);
    db.query<unknown, [string, number]>(
      `UPDATE note_settlement_proposals SET addresses_key = ? WHERE id = ?`,
    ).run(key, row.id);
  }

  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_note_settlement_proposals_session_addresses
       ON note_settlement_proposals(session_id, addresses_key)`,
  );
}

const NOTE_SETTLEMENT_WATERMARK_DISPOSAL_MESSAGE =
  "superseded by the settlement transition watermark (edge-mechanism-revision ticket 05, spec D8) — resettle via manual backfill";

function noteSettlementWatermarkIsUnset(db: Database): boolean {
  return !db
    .query<{ id: number }, []>(
      "SELECT id FROM note_settlement_watermark_state WHERE id = 1",
    )
    .get();
}

/**
 * Retire the pre-ticket-09 GLOBAL watermark shape.
 *
 * `note_settlement_watermark_state` shipped (unreleased, d304ec4) as
 * `(id, watermark_turn_id, recorded_at_epoch)` — one `MAX(turns.id)` for the
 * whole database. Ticket 09 replaces that with the per-session finished-set
 * floors above, and `CREATE TABLE IF NOT EXISTS` is a no-op on a database that
 * already has the old three-column table, so the column has to go by rebuild.
 *
 * The row is DROPPED with it rather than carried across, and that is the
 * point: an old-shape row is a stamp of a mechanism that no longer exists, so
 * re-arming the one-shot under the NEW definition is what "this transition has
 * not run here" actually means. Nothing is lost — the old row recorded a
 * global turn id the new planners never read. Production is not even that
 * case: its premature row was deleted during the incident remediation
 * (dd25367, [S15069/T1138]), so it arrives at the release with an empty table
 * of the old shape and stamps for the first time either way.
 *
 * Keyed on the stored DDL text rather than `PRAGMA table_info` for the same
 * reason `ensureTurnTypeMultiValueColumn` is: one probe, no row loop, and it
 * stops matching the instant the rebuild lands — so this runs exactly once per
 * database and never again, which is what keeps the one-shot gate below
 * one-shot.
 */
function retireGlobalNoteSettlementWatermarkShape(db: Database): void {
  const sql = db
    .query<{ sql: string }, []>(
      `SELECT sql FROM sqlite_master
       WHERE type = 'table' AND name = 'note_settlement_watermark_state'`,
    )
    .get()?.sql;
  if (!sql?.includes("watermark_turn_id")) {
    return;
  }
  db.exec(`
    DROP TABLE note_settlement_watermark_state;
    CREATE TABLE note_settlement_watermark_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      recorded_at_epoch INTEGER NOT NULL
    );
  `);
}

/**
 * D8 (edge-mechanism-revision tickets 05 + 09, [S15069/T1124]): the moment
 * this migration first finds `note_settlement_watermark_state` empty, it (1)
 * disposes every AUTOMATIC job this database still has open and (2) records
 * each session's ALREADY-FINISHED prefix — same transaction, because a crash
 * between the two steps must not leave a watermark in force with the jobs it
 * was supposed to retire still claimable, nor the reverse (jobs gone, no
 * watermark, so the next boot would try to dispose an already-clean table
 * against a floor of zero and re-derive nothing).
 *
 * The floor per session is `MIN(prompt_number of a turn still active or
 * provisional) - 1`, falling back to the session's highest prompt number when
 * no turn is unfinished — the contiguous finished prefix, for the reason given
 * on the table itself. A floor of 0 is not stored: it is exactly what a
 * missing row already means, so the table stays sparse and every row in it
 * states a real bound. Sessions with no turns at all therefore get no row,
 * and neither does any session born after this instant.
 *
 * `active`/`provisional` is the unfinished pair every other live-turn reader
 * in the codebase uses verbatim (worker/turn-liveness.ts, db/orphan-turns.ts,
 * db/turn-settlement.ts). It is deliberately NOT narrowed by
 * `realPromptPredicate`: a rolled-back or sidechain row left unfinished is
 * still a turn whose settlement has not been decided, and pulling the floor
 * back to it costs at most a few extra turns in one window, whereas skipping
 * it would strand whatever follows it in the same way the global watermark
 * did.
 *
 * Disposal, not the watermark write, is why this cannot be the naturally
 * idempotent shape `retireLegacyPendingNoteDebts` gets away with running on
 * every boot: THAT table never opens a fresh `pending` row after its own
 * cutover, so nothing legitimate is ever left for a rerun to sweep. This
 * table's whole job is to keep producing fresh `pending` rows forever — an
 * unconditional rerun would abandon every ordinary window still waiting on
 * its worker, on every process restart. The one-shot gate
 * (`noteSettlementWatermarkIsUnset`, checked once outside the transaction and
 * again inside it) is therefore load-bearing, not decoration.
 *
 * A `pending`, orphaned `claimed`, or still-retriable `failed` row this finds
 * is, by construction, already pre-watermark: nothing can enqueue an
 * automatic job for a turn that does not exist yet, so any automatic job
 * already sitting in the table right now was cut from turns that all exist at
 * this instant. Left alone, the
 * ordinary claim/reclaim path (`claimNextNoteSettlementJob`,
 * db/note-settlement.ts) would still pick one of these up on the session's
 * next event and settle straight across the boundary — the watermark folded
 * into `getNoteSettlementWindowStart`/`listResidualNoteSettlementCandidates`
 * only stops a NEW window from being PLANNED, it does nothing about a job
 * already RECORDED.
 *
 * Same terminal-disposal shape as `retireLegacyPendingNoteDebts` (read-write-
 * contract migration, spec D8 there — a different spec's D8, same letter): a
 * plain `UPDATE … WHERE` write-off into an existing terminal state, not a
 * table rebuild. `abandoned` asserts nothing new about the status vocabulary
 * — it is the same terminal state `claimNextNoteSettlementJob`'s own at-cap
 * reclaim already produces — and `failure_class = 'deterministic'` for the
 * same reason `ensureNoteSettlementJobsRetrySchema` tags every pre-ticket-06
 * `failed` row that way: a mis-tagged row only costs a retry it would not
 * otherwise need, never the reverse. No debt row is synthesized (unlike the
 * normal at-cap abandon path) — the precedent this follows does not write one
 * either, and surfacing "these turns need a backfill" is explicitly this
 * ticket's own out-of-scope (spec.md, Out of Scope): the operator runs
 * backfill by choice, not because a debt queue told them to.
 *
 * `backfill` rows are excluded from disposal outright: they are the
 * operator's own explicit request (`POST /settle`), never derived by any
 * planner, and D8 exempts them from the watermark by name — a pending
 * backfill is not "queued but unrun automatic work", it is a request still
 * waiting its turn.
 */
function ensureNoteSettlementWatermark(db: Database): void {
  if (!noteSettlementWatermarkIsUnset(db)) {
    return;
  }
  const nowEpoch = Math.floor(Date.now() / 1000);
  runWriteTransaction(db, () => {
    if (!noteSettlementWatermarkIsUnset(db)) {
      return;
    }
    db.query<unknown, [string, number]>(
      `UPDATE note_settlement_jobs
       SET status = 'abandoned',
           claimed_at_epoch = NULL,
           failure_class = 'deterministic',
           last_error = ?,
           updated_at_epoch = ?
       WHERE status IN ('pending', 'claimed', 'failed')
         AND trigger_type != 'backfill'`,
    ).run(NOTE_SETTLEMENT_WATERMARK_DISPOSAL_MESSAGE, nowEpoch);
    db.exec(`
      INSERT OR IGNORE INTO note_settlement_watermark_floors (
        session_id, finished_prompt_number
      )
      SELECT sessionId, finishedPromptNumber FROM (
        SELECT
          s.id AS sessionId,
          COALESCE(
            (SELECT MIN(t.prompt_number) - 1 FROM turns t
             WHERE t.session_id = s.id
               AND t.status IN ('active', 'provisional')),
            (SELECT MAX(t.prompt_number) FROM turns t
             WHERE t.session_id = s.id),
            0
          ) AS finishedPromptNumber
        FROM sessions s
      )
      WHERE finishedPromptNumber > 0
    `);
    db.query<unknown, [number]>(
      `INSERT OR IGNORE INTO note_settlement_watermark_state (
         id, recorded_at_epoch
       )
       VALUES (1, ?)`,
    ).run(nowEpoch);
  });
}

// `shadow_notes` arrives whole from SCHEMA_SQL (CREATE TABLE IF NOT EXISTS), but
// `observations` predates the exclusion marker, and CREATE TABLE IF NOT EXISTS
// is a no-op on a database that already has the table — so the column has to
// arrive by ALTER or every capture on an existing database throws "no such
// column". Old rows land on 0, which is the correct legacy reading: everything
// captured before the `note` tool existed was work content.
function ensureObservationExtractionExclusionColumn(db: Database): void {
  addColumnIfMissing(
    db,
    "observations",
    "excluded_from_extraction",
    "INTEGER NOT NULL DEFAULT 0",
  );
}

// light-review-repairs 04 (P1): `write_gate_reads` and
// `write_gate_field_completeness` predate the writer-context-epoch, so a
// database that already has either table needs the column added by ALTER —
// CREATE TABLE IF NOT EXISTS is a no-op once the table exists. Old rows land
// on 0, the exact value a writer with no write_gate_epochs row also reads as
// (getWriterEpoch's default) — so an existing row's gate behavior is
// unchanged until its writer's first PreCompact bump.
function ensureWriteGateEpochColumns(db: Database): void {
  addColumnIfMissing(db, "write_gate_reads", "epoch", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(
    db,
    "write_gate_field_completeness",
    "epoch",
    "INTEGER NOT NULL DEFAULT 0",
  );
}

// `shadow_notes` shipped through the whole P1 trial with one writer, so the
// origin column has to arrive by ALTER on every database that already has the
// table. Old rows land on 'agent', which is the correct reading: nothing but the
// main agent could have written them.
function ensureShadowNoteWriterOriginColumn(db: Database): void {
  if (!hasColumn(db, "shadow_notes", "writer_origin")) {
    db.exec(
      "ALTER TABLE shadow_notes ADD COLUMN writer_origin TEXT NOT NULL DEFAULT 'agent'",
    );
  }
}

// `repair_ledger` reached a dev build before it carried a claim fence or a
// deferral backoff, and CREATE TABLE IF NOT EXISTS is a no-op on a database that
// already has the table — so the columns have to arrive by migration or every
// claim on that database throws "no such column".
function ensureRepairLedgerClaimColumns(db: Database): void {
  const columns: Array<[string, string]> = [
    ["claim_generation", "INTEGER NOT NULL DEFAULT 0"],
    ["claimed_at_epoch", "INTEGER"],
    ["deferred_until_epoch", "INTEGER"],
    ["deferral_attempts", "INTEGER NOT NULL DEFAULT 0"],
  ];
  for (const [column, definition] of columns) {
    addColumnIfMissing(db, "repair_ledger", column, definition);
  }
}

// `settlement_jobs` shipped for exactly one build without an ownership fence.
// A worker that already created the table keeps it across restarts (CREATE TABLE
// IF NOT EXISTS is a no-op), so the column has to arrive by migration or every
// claim on that database throws.
function ensureSettlementClaimGenerationColumn(db: Database): void {
  addColumnIfMissing(
    db,
    "settlement_jobs",
    "claim_generation",
    "INTEGER NOT NULL DEFAULT 0",
  );
}

function ensureDiaryDayStateTerminalColumn(db: Database): void {
  addColumnIfMissing(
    db,
    "diary_day_state",
    "terminal",
    "INTEGER NOT NULL DEFAULT 0",
  );
}

function ensureDiaryDayStateRetryDispositionColumn(db: Database): void {
  addColumnIfMissing(
    db,
    "diary_day_state",
    "retry_disposition",
    `TEXT CHECK (
       retry_disposition IS NULL OR
       retry_disposition IN ('transient', 'permanent')
     )`,
  );

  // Before this column existed, every terminal day was manual-only regardless
  // of whether it came from retry exhaustion or backlog eviction. Preserve
  // that behavior instead of accidentally making old terminal rows recoverable.
  db.exec(
    `UPDATE diary_day_state
     SET retry_disposition = 'permanent'
     WHERE terminal = 1 AND retry_disposition IS NULL`,
  );
}

function dropRetiredMaintenanceState(db: Database): void {
  // Installed 0.3.2 databases may still contain the old maintenance table.
  // Dropping it makes the retired terminal-state deadlock unrepresentable.
  db.exec("DROP TABLE IF EXISTS persona_operation_state");

  // Edge-ownership ticket 05: the settlement membership gate retired with the
  // assign action; a pre-demolition installation still carries its activity
  // table. Dropping it makes the retired gate unrepresentable — same
  // reasoning as the table above.
  db.exec("DROP TABLE IF EXISTS note_settlement_membership_activity");

  // idx_turns_status is a strict prefix of idx_turns_status_created, so every
  // query it could serve the wider one serves too; keeping both would only pay
  // a second index write on every turn insert.
  db.exec("DROP INDEX IF EXISTS idx_turns_status");
}

// `project` is overwritten with the latest cwd on every hook upsert, but the
// transcript directory is fixed at the session's starting cwd — so deriving the
// transcript path from `project` silently misses the file for any session that
// `cd`ed. The authoritative path now comes from the hook input and lives here.
// Old rows land on NULL (readers fall back to the derivation); the one-time
// backfill that fills what it can is deliberately NOT bound to this ALTER — it
// runs from its own resumable ledger, so a crash mid-scan cannot leave the
// column "migrated" but the repair half-done and unrepeatable.
function ensureSessionTranscriptPathColumn(db: Database): void {
  addColumnIfMissing(db, "sessions", "transcript_path", "TEXT");
}

function ensureSessionSummaryUpdatedAtEpochColumn(db: Database): void {
  addColumnIfMissing(db, "sessions", "summary_updated_at_epoch", "INTEGER");
}

// Ticket 13: forward-only, same shape as the column's own comment on the base
// CREATE TABLE above — an existing session lands on NULL and the reminder
// falls back to `created_at_epoch`, exactly the same reading a session that
// truly never called remember gets.
function ensureSessionLastRememberTurnIdColumn(db: Database): void {
  addColumnIfMissing(db, "sessions", "last_remember_turn_id", "INTEGER");
}

// D7: the redesigned session summary splits into a time-axis (done/current/
// next_steps) plus decision + reference. next_steps already exists; the four
// new columns are added in place and never backfilled — old sessions keep NULL
// and fall back to the legacy `insight` column on read.
function ensureSessionSummaryFieldColumns(db: Database): void {
  for (const column of ["decision", "done", "current", "reference"]) {
    addColumnIfMissing(db, "sessions", column, "TEXT");
  }
}

function ensureTurnTranscriptLineStartColumn(db: Database): void {
  addColumnIfMissing(db, "turns", "transcript_line_start", "INTEGER");
}

// The full interleaved assistant narration (every text block of the turn),
// distinct from assistant_response which holds only the final block fed to the
// extractor. Lets mnemo-replay reconstruct a turn from SQLite without the JSONL.
// Forward-only: old rows keep NULL and fall back to the transcript on read.
function ensureTurnAssistantTranscriptColumn(db: Database): void {
  addColumnIfMissing(db, "turns", "assistant_transcript", "TEXT");
}

function ensureTurnInvalidationColumns(db: Database): void {
  addColumnIfMissing(db, "turns", "was_interrupted", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "turns", "was_rolled_back", "INTEGER NOT NULL DEFAULT 0");
}

// Ticket 14 (spec K5): `segments.insight`. Forward-only — an existing segment
// keeps NULL, which reads exactly as "this segment never stated one" rather
// than as a lost value, so no backfill is possible or wanted.
function ensureSegmentInsightColumn(db: Database): void {
  addColumnIfMissing(db, "segments", "insight", "TEXT");
}

/**
 * Working State (ADR-0001, ticket 02): the six columns that reach an EXISTING
 * database. Same shape of migration as `ensureTurnSignificanceGradeColumn` —
 * every one of these six is a
 * plain nullable `TEXT` whose (absent) CHECK references only itself, so
 * `ALTER TABLE … ADD COLUMN` is legal SQLite and no 12-step rebuild is
 * needed. A database created fresh from `SCHEMA_SQL` already carries all six
 * (declared directly on the `segments` table above), so `addColumnIfMissing`
 * is a no-op there — this function only ever does real work on a database
 * that predates this migration.
 */
function ensureSegmentWorkingStateColumns(db: Database): void {
  addColumnIfMissing(db, "segments", "goal", "TEXT");
  addColumnIfMissing(db, "segments", "constraints", "TEXT");
  addColumnIfMissing(db, "segments", "decisions", "TEXT");
  addColumnIfMissing(db, "segments", "done", "TEXT");
  addColumnIfMissing(db, "segments", "next_steps", "TEXT");
  addColumnIfMissing(db, "segments", "reference", "TEXT");
}

/**
 * Ticket 15 finding 3, the other half of the same K5a migration: the segments
 * that already exist keep MODEL-STATED `type`/`tags` unless something rederives
 * them.
 *
 * Ticket 14 made both fields derived and ran the derivation from
 * `addSegmentMembers` onward, so a segment written before it — 45 of them on
 * the live database — holds whatever the settlement agent typed, which is the
 * A6 violation ("a segment's type is the union of its members'", asserted since
 * A6 was written and never enforced) that K5a exists to end. It is not a
 * cosmetic difference: `rebuildSearchIndex` indexes the STORED fields, so a
 * `type:`/`tag:` search answers from them, and `deriveDominantType`
 * (db/segment-rank.ts) reads the first word of the stored `type` as a
 * judgement.
 *
 * Delivered as a flag rather than an inline loop so the cascade repair
 * (finding 2) and any later backfill are one mechanism with one meaning —
 * "this segment owes a derivation" — and one payer, the sweep at the end of
 * `initializeSchema`.
 *
 * THE ONE-TIME BACKFILL IS DELIBERATELY NOT HERE (user ruling, S15069/T766).
 * It was built, run against a copy of the live database, and withdrawn on what
 * that run showed: all 45 segments derive to `type=[]`, `tags=[]`, because 8 of
 * their 800 member turns carry any `type` and none carries a bare tag. Those
 * members were written by `promoteTurnFromNote`, which records
 * title/content/insight and never type/tags, so their activity word lives in
 * the TITLE prefix instead (`"fix+observation-search: …"`). The derivation is
 * therefore correct and the erasure is total: K5a's answer for a segment whose
 * members state nothing genuinely is `[]`, and the live `addSegmentMembers`
 * path already produces `[]` for such a segment today.
 *
 * What the backfill would cost is those 45 segments' only structured search
 * facet, irreversibly, to record an emptiness that is an artefact of the old
 * write path rather than a fact about the work. The activity words are
 * recoverable — they are sitting in the titles — so the ordering is: recover
 * the member turns' `type` first, THEN derive, and get real values instead of
 * `[]`. That recovery is turn-level work and belongs to its own change; not
 * every title prefix maps onto `MEMORY_TYPES` (`write+`, `feedback+` do not),
 * so it needs rulings this migration has no business making.
 *
 * Until then the stored facet on a pre-ticket-14 segment means "model-stated"
 * and on every later one means "derived". That is the two-meanings state K5a
 * exists to end, accepted knowingly and for a bounded time, because it is
 * already the state on disk and the alternative is irreversible.
 */
function ensureSegmentDerivedFacets(db: Database): void {
  addColumnIfMissing(
    db,
    "segments",
    "facets_stale",
    "INTEGER NOT NULL DEFAULT 0 CHECK (facets_stale IN (0, 1))",
  );
  // Idempotent (CREATE TRIGGER IF NOT EXISTS) and re-run on every process
  // start, so a database that predates this ticket gains them too.
  db.exec(SEGMENT_FACET_STALE_TRIGGERS_DDL);
}

/**
 * The rebuild target for `ensureSegmentStatusVocabulary` below — every
 * `segments` column exactly as the table above declares them, including the
 * SAME wide `status` CHECK (`open`/`delivered`/`abandoned`/`closed` — see
 * that CHECK's own comment on the table above for why it stays wide rather
 * than narrowing to the two-value APPLICATION vocabulary). Not hoisted into
 * one function shared with `SCHEMA_SQL`'s inline definition the way
 * `noteSettlementJobsTableDdl` is shared by its two call sites — the two
 * texts already have to agree by hand (same reasoning both places), and nothing
 * here reads or diffs them against each other at runtime, so duplicating the
 * DDL text costs nothing a shared function would have saved.
 */
const segmentsStatusVocabularyRebuildDdl = (tableName: string): string => `
  CREATE TABLE ${tableName} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id INTEGER REFERENCES topics(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    content TEXT,
    insight TEXT,
    type TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(type)),
    tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
    status TEXT NOT NULL DEFAULT 'open' CHECK (
      status IN ('open', 'delivered', 'abandoned', 'closed')
    ),
    revision INTEGER NOT NULL DEFAULT 1,
    facets_stale INTEGER NOT NULL DEFAULT 0 CHECK (facets_stale IN (0, 1)),
    goal TEXT,
    constraints TEXT,
    decisions TEXT,
    done TEXT,
    next_steps TEXT,
    reference TEXT,
    created_at_epoch INTEGER NOT NULL,
    updated_at_epoch INTEGER NOT NULL
  );
`;

const SEGMENTS_INDEXES_DDL = `
  CREATE INDEX IF NOT EXISTS idx_segments_topic_status
    ON segments(topic_id, status, updated_at_epoch);

  CREATE INDEX IF NOT EXISTS idx_segments_status_updated
    ON segments(status, updated_at_epoch);
`;

/**
 * The one TRIGGER that lives ON `segments` itself (the two facet-staleness
 * triggers in `SEGMENT_FACET_STALE_TRIGGERS_DDL` are declared `ON
 * segment_members`/`ON turns` and survive a `segments` rebuild untouched;
 * this one does not).
 */
const SEGMENTS_OWN_TRIGGER_DDL = `
  CREATE TRIGGER IF NOT EXISTS memory_edges_prune_deleted_segment
    AFTER DELETE ON segments
    BEGIN
      DELETE FROM memory_edges
      WHERE (citing_kind = 'segment' AND citing_id = OLD.id)
         OR (cited_kind = 'segment' AND cited_id = OLD.id);
    END;
`;

function segmentsStatusVocabularyIsStale(db: Database): boolean {
  const storedDdl =
    db
      .query<{ sql: string | null }, []>(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'segments'`,
      )
      .get()?.sql ?? null;
  return storedDdl !== null && !storedDdl.includes("'closed'");
}

/**
 * Ticket 05: widen `segments.status`'s CHECK so `closed` is a legal value,
 * SQLite's 12-step ALTER TABLE procedure (a CHECK cannot be ALTERed).
 * Same shape as `ensureNoteSettlementTriggerVocabulary`: build the
 * replacement under a temporary name, copy explicit columns, drop the
 * original, rename the replacement INTO the original's name (never rename
 * the original away) — `segment_members`/`segment_attachments` both hold
 * `REFERENCES segments(id) ON DELETE CASCADE`, and with `PRAGMA foreign_keys
 * = ON` a rename-away would repoint those clauses at the renamed table and
 * then cascade-delete every member/attachment row the moment it was dropped.
 *
 * `PRAGMA foreign_keys` is a no-op inside a transaction, so it is turned off
 * on the connection before `runWriteTransaction` opens one and restored
 * after. `foreign_key_check` runs INSIDE the transaction: a check after the
 * commit turns a violation into a durable swap plus a skipped migration.
 */
function ensureSegmentStatusVocabulary(db: Database): void {
  if (!segmentsStatusVocabularyIsStale(db)) {
    return;
  }

  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    runWriteTransaction(db, () => {
      if (!segmentsStatusVocabularyIsStale(db)) {
        return;
      }

      db.exec(
        segmentsStatusVocabularyRebuildDdl("segments_status_vocabulary_rebuild"),
      );
      // Explicit column list on both sides — see `ensureNoteSettlementTriggerVocabulary`.
      db.exec(
        `INSERT INTO segments_status_vocabulary_rebuild (
           id, topic_id, title, content, insight, type, tags, status, revision,
           facets_stale, goal, constraints, decisions, done, next_steps, reference,
           created_at_epoch, updated_at_epoch
         )
         SELECT
           id, topic_id, title, content, insight, type, tags, status, revision,
           facets_stale, goal, constraints, decisions, done, next_steps, reference,
           created_at_epoch, updated_at_epoch
         FROM segments`,
      );
      db.exec("DROP TABLE segments");
      db.exec("ALTER TABLE segments_status_vocabulary_rebuild RENAME TO segments");
      // The indexes and the trigger belonged to the dropped table and died with it.
      db.exec(SEGMENTS_INDEXES_DDL);
      db.exec(SEGMENTS_OWN_TRIGGER_DDL);

      const violations = db
        .query<Record<string, unknown>, []>("PRAGMA foreign_key_check")
        .all();
      if (violations.length > 0) {
        throw new Error(
          `segments rebuild left ${violations.length} foreign key violation(s) while widening status: ${JSON.stringify(violations)}`,
        );
      }
    });
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
}

// ---------------------------------------------------------------------------
// Ticket 15 (topic registry retirement, CONTEXT.md "Topic — retired"): two
// mechanisms recorded the same "what is this segment about" fact — the topic
// registry's name and the segment's own tags — a mechanism-level synonym
// split. `foldTopicNamesIntoSegmentTags` moves the information into the
// surviving mechanism FIRST, then `retireTopicRegistry` drops `topics` and
// `segments.topic_id` for good. A fresh install never creates either.
// ---------------------------------------------------------------------------

/**
 * The rebuild target for `retireTopicRegistry` below: every `segments` column
 * exactly as the table above declares them, minus `topic_id`. Not hoisted
 * into a function shared with `SCHEMA_SQL`'s inline definition — same
 * reasoning as `segmentsStatusVocabularyRebuildDdl` above: the two texts
 * already have to agree by hand, and nothing here diffs them at runtime.
 */
const segmentsWithoutTopicRebuildDdl = (tableName: string): string => `
  CREATE TABLE ${tableName} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT,
    insight TEXT,
    type TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(type)),
    tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
    status TEXT NOT NULL DEFAULT 'open' CHECK (
      status IN ('open', 'delivered', 'abandoned', 'closed')
    ),
    revision INTEGER NOT NULL DEFAULT 1,
    facets_stale INTEGER NOT NULL DEFAULT 0 CHECK (facets_stale IN (0, 1)),
    goal TEXT,
    constraints TEXT,
    decisions TEXT,
    done TEXT,
    next_steps TEXT,
    reference TEXT,
    created_at_epoch INTEGER NOT NULL,
    updated_at_epoch INTEGER NOT NULL
  );
`;

/** Same shape as `SEGMENTS_INDEXES_DDL` above, minus the topic-keyed index — `topic_id` is gone. */
const SEGMENTS_TOPIC_RETIRED_INDEXES_DDL = `
  CREATE INDEX IF NOT EXISTS idx_segments_status_updated
    ON segments(status, updated_at_epoch);
`;

/**
 * Ticket 15's own bare-tag normalization for a topic's NAME — lowercase,
 * internal whitespace collapsed to a single hyphen (spec: "小写连字符归
 * 一") — using the SAME case-folding convention `db/segments.ts`'s own
 * (now-retired) `normalizeTopicKey` used, so two spellings the registry's
 * exact-name lookup already treated as the SAME topic fold onto the
 * identical tag rather than minting two.
 *
 * Round-4 review #8, and it OUTLIVED the retirement that prompted it: a legacy
 * topic NAME such as `"topic:Alpha"` (the registry never forbade the prefix
 * appearing in a name, only in a live tag) reaches this function as ordinary
 * text, and without the strip below the fold would mint a FRESH
 * `"topic:alpha"` tag on every member turn. That was once "re-introducing a
 * retired namespace"; under staged-settlement spec Rev 5 it is worse — the
 * namespace is live again and means "what this turn is about, in the author's
 * own word", so a fold-minted one would be a subject claim nobody wrote,
 * permanent by contract, on turns whose only connection to it is a container
 * name. The strip runs on the lowercased name (so `"Topic:Alpha"`/
 * `"TOPIC:Alpha"` are caught too) and BEFORE the hyphen/whitespace collapse,
 * so a name that is nothing but the prefix (`"topic:"`, `"Topic:   "`)
 * normalizes to the empty string — the existing `topic-<id>` fallback in
 * `foldTopicNamesIntoSegmentTags` catches that.
 *
 * Round-5 review #16b: the strip repeats until the prefix is gone, so a legacy
 * name doubly poisoned (`"topic:topic:Alpha"`, however that arose) does not
 * fold to `"topic:alpha"` — each pass removes exactly `"topic:".length`
 * characters, so the loop is bounded by the string's own length and always
 * terminates.
 */
function normalizeTopicNameToTag(name: string): string {
  const cased = name.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  let withoutRetiredNamespace = cased;
  while (withoutRetiredNamespace.startsWith("topic:")) {
    withoutRetiredNamespace = withoutRetiredNamespace.slice("topic:".length);
  }
  return withoutRetiredNamespace
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Tolerant JSON-array parse for migration code touching `turns.tags` (no `json_valid` CHECK on that column — see `db/segments.ts`'s `parseMemberFacetArray` for the same guard). */
function safeParseTagArray(value: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Fold each segment's topic NAME into its tags — the durable home for the
 * information once the registry that used to carry it is gone.
 *
 * REWRITTEN at rubric-v10 ticket 07: `segments.tags` is hand-curated identity
 * now — the derivation half of `recomputeSegmentFacets` retired, so a direct
 * write into the column is durable, and this migration IS a curation act
 * performed under migration authority (the topic name was the segment's
 * identity in the old registry; it becomes the segment's identity tag in the
 * new model). The fold therefore writes BOTH sides for every segment: the
 * bare tag lands directly on `segments.tags` (visible immediately, erased by
 * nothing), and it still folds into each MEMBER TURN's own `tags` — no longer
 * as a derivation source, but because ticket 07's membership gate requires a
 * member to carry all of its segment's tags, and a fold that skipped the
 * members would leave every one of them unable to be reassigned under the
 * gate. The old member/memberless asymmetry (and its recompute-erasure
 * caveat) is gone with the derivation that caused it.
 */
function foldTopicNamesIntoSegmentTags(db: Database): void {
  const topicSegments = db
    .query<{ id: number; topicId: number; tags: string }, []>(
      `SELECT id, topic_id AS topicId, tags FROM segments WHERE topic_id IS NOT NULL`,
    )
    .all();
  if (topicSegments.length === 0) {
    return;
  }

  const topicNames = new Map<number, string>(
    db
      .query<{ id: number; name: string }, []>("SELECT id, name FROM topics")
      .all()
      .map((row) => [row.id, row.name] as const),
  );

  for (const segment of topicSegments) {
    const topicName = topicNames.get(segment.topicId);
    if (!topicName) {
      continue;
    }
    // Peer round 2: a topic name that normalizes to NOTHING (whitespace or
    // punctuation only — legal under the old registry's bare NOT NULL UNIQUE)
    // must not vanish silently, because the registry it lives in is dropped
    // right after this fold. The fallback tag keeps the fact that a grouping
    // existed recoverable, and the log line names what it was.
    let bareTag = normalizeTopicNameToTag(topicName);
    if (bareTag === "") {
      bareTag = `topic-${segment.topicId}`;
      console.error(
        `[claude-mnemo] topic registry retirement: topic ${segment.topicId} ` +
          `(${JSON.stringify(topicName)}) normalizes to an empty tag — folded as "${bareTag}"`,
      );
    }

    const memberTurnIds = db
      .query<{ turnId: number }, [number]>(
        "SELECT turn_id AS turnId FROM segment_members WHERE segment_id = ?",
      )
      .all(segment.id)
      .map((row) => row.turnId);

    // The segment's own row first: hand-curated identity, written directly.
    const currentSegmentTags = safeParseTagArray(segment.tags);
    if (!currentSegmentTags.some((tag) => tag.toLocaleLowerCase("en-US") === bareTag)) {
      db.query<unknown, [string, number]>("UPDATE segments SET tags = ? WHERE id = ?").run(
        JSON.stringify([...currentSegmentTags, bareTag]),
        segment.id,
      );
    }
    if (memberTurnIds.length === 0) {
      continue;
    }

    let foldedAny = false;
    for (const turnId of memberTurnIds) {
      const row = db
        .query<{ tags: string | null }, [number]>("SELECT tags FROM turns WHERE id = ?")
        .get(turnId);
      const currentTags = safeParseTagArray(row?.tags ?? null);
      if (currentTags.some((tag) => tag.toLocaleLowerCase("en-US") === bareTag)) {
        continue;
      }
      db.query<unknown, [string, number]>("UPDATE turns SET tags = ? WHERE id = ?").run(
        JSON.stringify([...currentTags, bareTag]),
        turnId,
      );
      foldedAny = true;
    }
    if (foldedAny) {
      // Type may shift when member tags change facets downstream; tags no
      // longer derive (ticket 07), so this call is type-only housekeeping.
      recomputeSegmentFacets(db, segment.id);
    }
  }
}

function topicRegistryStillPresent(db: Database): boolean {
  return hasColumn(db, "segments", "topic_id");
}

/**
 * Ticket 15: retire the topic registry. `foldTopicNamesIntoSegmentTags` runs
 * FIRST, inside the SAME transaction, so a topic's name is never lost between
 * "still readable off `topic_id`" and "the column that named it is gone".
 * Then `segments` rebuilds without `topic_id` — SQLite's 12-step ALTER TABLE
 * procedure, the same reasoning `retireTurnCitesRecordedColumn` gives for its
 * own column drop — and `topics` is dropped outright; nothing references it
 * once `topic_id` is gone.
 *
 * `PRAGMA foreign_keys = OFF` for the same reason `ensureSegmentStatusVocabulary`
 * turns it off: `segment_members`/`segment_attachments` hold `REFERENCES
 * segments(id) ON DELETE CASCADE`, and with the pragma ON a rename-away of
 * `segments` mid-rebuild would cascade-delete both the moment the original
 * table was dropped.
 */
function retireTopicRegistry(db: Database): void {
  if (!topicRegistryStillPresent(db)) {
    return;
  }

  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    runWriteTransaction(db, () => {
      if (!topicRegistryStillPresent(db)) {
        return;
      }

      foldTopicNamesIntoSegmentTags(db);

      db.exec(segmentsWithoutTopicRebuildDdl("segments_topic_registry_retired"));
      db.exec(
        `INSERT INTO segments_topic_registry_retired (
           id, title, content, insight, type, tags, status, revision,
           facets_stale, goal, constraints, decisions, done, next_steps,
           reference, created_at_epoch, updated_at_epoch
         )
         SELECT
           id, title, content, insight, type, tags, status, revision,
           facets_stale, goal, constraints, decisions, done, next_steps,
           reference, created_at_epoch, updated_at_epoch
         FROM segments`,
      );
      db.exec("DROP TABLE segments");
      db.exec(
        "ALTER TABLE segments_topic_registry_retired RENAME TO segments",
      );
      // The indexes and the trigger belonged to the dropped table and died with it.
      db.exec(SEGMENTS_TOPIC_RETIRED_INDEXES_DDL);
      db.exec(SEGMENTS_OWN_TRIGGER_DDL);

      db.exec("DROP TABLE IF EXISTS topics");

      const violations = db
        .query<Record<string, unknown>, []>("PRAGMA foreign_key_check")
        .all();
      if (violations.length > 0) {
        throw new Error(
          `segments rebuild left ${violations.length} foreign key violation(s) while retiring the topic registry: ${JSON.stringify(violations)}`,
        );
      }
    });
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
}

/**
 * Ticket 15 (findings 2-3): pay every facet derivation the database records as
 * owed — the migration backfill above, and any membership the FK cascade of a
 * deleted turn or session removed since the last process start.
 *
 * Runs LAST in `initializeSchema`, after both `turns` rebuilds and after
 * `retireTopicRegistry`: those rewrite the very `type`/`tags` columns
 * the derivation reads, and the trigger flags the segments they touch, so a
 * sweep placed earlier would derive from values this same initialisation is
 * about to change.
 *
 * The read comes first so the ordinary case — nothing owed — costs one indexed
 * probe and never opens a write transaction. `initializeSchema` runs from every
 * hook entry, several per prompt, and an IMMEDIATE transaction per entry would
 * be a new source of writer contention for no work. What IS owed is paid a
 * batch at a time (`SEGMENT_FACET_REPAIR_BATCH`) for the same reason — see
 * `repairStaleSegmentFacets` — with the remainder left flagged for the next
 * start rather than held under one long write lock.
 */
function repairDerivedSegmentFacets(db: Database): void {
  if (!hasRow(db, "SELECT 1 FROM segments WHERE facets_stale = 1")) {
    return;
  }
  runWriteTransaction(db, () => {
    repairStaleSegmentFacets(db);
  });
}

function ensureTurnSignificanceGradeColumn(db: Database): void {
  addColumnIfMissing(
    db,
    "turns",
    "significance_grade",
    "INTEGER CHECK (significance_grade IS NULL OR significance_grade BETWEEN 0 AND 4)",
  );
}

// Mechanical retrieval provenance (spec D4). Old rows stay NULL, which reads as
// "never observed" rather than "consulted nothing" — the column only starts
// meaning something for turns captured after it existed.
function ensureTurnConsultedMemoriesColumn(db: Database): void {
  addColumnIfMissing(db, "turns", "consulted_memories", "TEXT");
}

// Spec §F capture repair. The incremental transcript scan resumes from a
// persisted cursor = byte offset + last FULLY COMMITTED line number. Both halves
// are needed: the byte offset makes the seek O(new bytes) instead of rescanning
// (and bounds the read), while the line number keeps emitted `lineNumber`s
// identical to the whole-file reader's 1-based split index so transcript_line_start
// stays comparable across the two paths. Old rows land on 0/0 → first scan reads
// from the top exactly once.
function ensureSessionScanCursorColumns(db: Database): void {
  addColumnIfMissing(
    db,
    "sessions",
    "scan_cursor_byte_offset",
    "INTEGER NOT NULL DEFAULT 0",
  );
  addColumnIfMissing(
    db,
    "sessions",
    "scan_cursor_line",
    "INTEGER NOT NULL DEFAULT 0",
  );
}

// The compact-boundary UUID is the identity key that makes claiming idempotent:
// re-scanning a transcript region cannot mint a second marker for a boundary that
// already owns one. Scoped per session, NOT globally: a forked/resumed session
// inherits the parent's transcript prefix verbatim, so the same boundary UUID
// legitimately appears in two sessions and each needs its own marker.
function ensureTurnCompactBoundarySchema(db: Database): void {
  addColumnIfMissing(db, "turns", "compact_boundary_uuid", "TEXT");

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_compact_boundary_uuid
      ON turns(session_id, compact_boundary_uuid)
      WHERE compact_boundary_uuid IS NOT NULL
  `);
}

function ensureForkLineageColumns(db: Database): void {
  // The backfill runs whenever the column was missing when this process looked,
  // including when another process added it a moment earlier: it is an
  // idempotent `WHERE parent_turn_id IS NULL` sweep, so running it twice costs
  // one query, while skipping it would leave the loser reading a column the
  // winner has not filled yet.
  if (addColumnIfMissing(db, "turns", "parent_turn_id", "INTEGER")) {
    backfillAllIntraChains(db); // one-time bulk Step A on migration
  }
  addColumnIfMissing(db, "sessions", "parent_session_id", "INTEGER");
  addColumnIfMissing(
    db,
    "sessions",
    "lineage_status",
    "TEXT NOT NULL DEFAULT 'unchecked'",
  );
}

/** The one-time era-grant seed's receipt name (era-grant-by-settlement, ticket 01). */
export const TURN_ERA_GRANT_SEED_RECEIPT = "era-grant-by-settlement-seed";

export interface TurnEraGrantSeedReceipt {
  /**
   * `seeded` — a cutoff was in force and the ledger sweep ran.
   * `no-era` — the column landed on a database with no recorded era, so there
   * is no boundary anything could be granted relief FROM. Stated rather than
   * left as a missing receipt: "this migration never saw this database" and
   * "it saw it and had nothing to do" are different answers.
   */
  disposition: "seeded" | "no-era";
  cutoffEpoch: number | null;
  /** Turns THIS sweep moved from ungranted to granted. */
  granted: number;
  /** Every granted turn in the table once the sweep committed. */
  grantedTotal: number;
}

/**
 * `turns.era_granted_at_epoch` — the durable per-turn fact that a settlement
 * under the CURRENT model has covered this turn's window (era-grant-by-settlement
 * spec, ticket 01), plus the one-time seed of the grants already earned.
 *
 * Why a grant exists at all: `created_at_epoch >= cutoff` is a PROXY for "this
 * turn was annotated by the retired extraction subagent". A settlement backfill
 * invalidates the proxy — it re-annotates a pre-cutoff turn under the current
 * model, v12 vocabulary, v12 edges and all — and before this column the only
 * record of that work was a job row nothing read. E70 was the live case: 605
 * members, 1 above the cutoff, a milestone view seating exactly the turn that
 * opened the task.
 *
 * NULLABLE EPOCH, not a boolean, so "when did this turn become current" stays
 * answerable. The seed stamps the EARLIEST covering job's completion — the
 * moment the current model first processed that window — rather than migration
 * time, which would record when someone happened to upgrade.
 *
 * THE SEED'S POPULATION IS WINDOW COVERAGE, NOT TURNS REVIEWED (ruled
 * [S15069/T1818]). An agent's decision not to write a note on a particular turn
 * is its own legitimate judgment and must not leave that turn permanently
 * invisible; coverage is also the only population reconstructible after the
 * fact, since `turnsReviewed` survives as a count and never per turn.
 *
 * Guarded by `addColumnIfMissing`'s own return value, the `ensureForkLineageColumns`
 * pattern: the sweep runs whenever the column was missing when THIS process
 * looked, including when another process added it a moment earlier. That is
 * safe because the sweep is an idempotent `WHERE era_granted_at_epoch IS NULL`
 * pass — running it twice costs one query, while skipping it would leave the
 * loser reading a column the winner has not filled yet.
 *
 * The UPDATE goes through a prepared `.run()`, never a multi-statement
 * `db.exec`: `bun:sqlite`'s `exec` swallows a statement's constraint failure and
 * runs the rest, which for a migration that MOVES data is a silent half-apply.
 *
 * CALL ORDERING (see `initializeSchema`): strictly AFTER the last `turns`
 * REBUILD. Both rebuilds copy from an explicit column list and run
 * `assertNoUnexpectedTurnsColumns`, so a database old enough to still need one
 * of them would abort schema initialisation outright if this column were
 * already sitting on the table.
 */
function ensureTurnEraGrantColumn(
  db: Database,
  nowEpoch: number = Math.floor(Date.now() / 1000),
): void {
  if (!addColumnIfMissing(db, "turns", ERA_GRANT_COLUMN, "INTEGER")) {
    return;
  }

  const cutoffEpoch = resolveEraCutoff(db);
  runWriteTransaction(db, () => {
    // The ledger is the surviving record of which windows the current model has
    // processed: a `done` job whose own completion is at or after the cutoff.
    // `status`/`updated_at_epoch` both matter — a job that failed, or one a
    // pre-era build completed, vouches for nothing.
    const granted =
      cutoffEpoch === null
        ? 0
        : db
            .query<unknown, [number, number, number]>(
              `UPDATE turns
                  SET ${ERA_GRANT_COLUMN} = (
                        SELECT MIN(j.updated_at_epoch)
                        FROM note_settlement_jobs j
                        WHERE j.session_id = turns.session_id
                          AND j.status = 'done'
                          AND j.updated_at_epoch >= ?
                          AND turns.prompt_number
                              BETWEEN j.window_start AND j.window_end
                      )
                WHERE ${ERA_GRANT_COLUMN} IS NULL
                  AND turns.created_at_epoch < ?
                  AND EXISTS (
                        SELECT 1
                        FROM note_settlement_jobs j
                        WHERE j.session_id = turns.session_id
                          AND j.status = 'done'
                          AND j.updated_at_epoch >= ?
                          AND turns.prompt_number
                              BETWEEN j.window_start AND j.window_end
                      )`,
            )
            .run(cutoffEpoch, cutoffEpoch, cutoffEpoch).changes;

    const grantedTotal =
      db
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count FROM turns WHERE ${ERA_GRANT_COLUMN} IS NOT NULL`,
        )
        .get()?.count ?? 0;

    const receipt: TurnEraGrantSeedReceipt = {
      disposition: cutoffEpoch === null ? "no-era" : "seeded",
      cutoffEpoch,
      granted,
      grantedTotal,
    };
    // Data and receipt commit in ONE transaction, so "granted but unrecorded"
    // is not a state this database can be found in. `grantedTotal` is what a
    // reader checks against the ledger: under the two-process race above the
    // two sweeps' `granted` figures split the work between them, but whichever
    // receipt wins the insert still names the whole granted set.
    writeMigrationReceipt(db, TURN_ERA_GRANT_SEED_RECEIPT, nowEpoch, receipt);
  });
}

export function backfillAllIntraChains(db: Database): void {
  db.query(
    `UPDATE turns SET parent_turn_id = (
       SELECT p.id FROM turns p
       WHERE p.session_id = turns.session_id AND p.prompt_number < turns.prompt_number
       ORDER BY p.prompt_number DESC LIMIT 1
     )
     WHERE parent_turn_id IS NULL
       AND EXISTS (
         SELECT 1 FROM turns p
         WHERE p.session_id = turns.session_id AND p.prompt_number < turns.prompt_number
       )`,
  ).run();
}

const EXPECTED_FTS_COLUMNS = [
  "layer",
  "source_id",
  "title",
  "content",
  "extra",
  "prompt",
  "response",
] as const;

function ensureSearchIndexSchema(db: Database): void {
  const row = db
    .query<{ sql: string }, []>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_fts'",
    )
    .get();

  // Fresh DBs already got the new DDL from SCHEMA_SQL → trigram + all expected columns present → no-op.
  const isCurrent =
    row !== null &&
    row.sql.includes("trigram") &&
    EXPECTED_FTS_COLUMNS.every((column) => hasColumn(db, "memory_fts", column));

  if (isCurrent) {
    return;
  }

  db.exec("DROP TABLE IF EXISTS memory_fts");
  db.exec(MEMORY_FTS_DDL);
  rebuildSearchIndex(db);
}

function ensureSessionProjectIndex(db: Database): void {
  if (hasColumn(db, "sessions", "created_at_epoch")) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_project_created_at
        ON sessions(project, created_at_epoch DESC)
    `);
    db.exec("DROP INDEX IF EXISTS idx_sessions_project_started_at");
    return;
  }

  if (hasColumn(db, "sessions", "started_at_epoch")) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_project_started_at
        ON sessions(project, started_at_epoch DESC)
    `);
  }
}

function ensureTurnPromptIdIndex(db: Database): void {
  if (!hasColumn(db, "turns", "content_prompt_id")) {
    return;
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_session_prompt_id
      ON turns(session_id, content_prompt_id) WHERE content_prompt_id IS NOT NULL
  `);
}

function dropLegacyMemoriesTable(db: Database): void {
  db.exec("DROP TABLE IF EXISTS memories");
  db.exec("DELETE FROM memory_fts WHERE layer = 'memory'");
}

// `turns.type` shipped nullable-scalar and ticket 02 (spec B5) widens it to a
// JSON array, matching `segments.type`. Same detection idiom as
// `ensureNoteDebtReasonVocabulary`: read the stored DDL rather than track a
// version counter, so a fresh database (whose CREATE TABLE already carries the
// CHECK) skips the rebuild entirely.
//
// Detects BOTH generations of "stale": the original nullable-scalar column
// (no CHECK mentioning `type` at all) ticket 02 rebuilt away, and ticket 02's
// own loose `CHECK (json_valid(type))` (peer review P2) — neither stored DDL
// contains the strict array-only string this checks for, so both fall
// through to the same rebuild. A database on the CURRENT strict form is the
// only one that matches and skips.
function turnsTypeColumnIsStale(db: Database): boolean {
  const storedDdl =
    db
      .query<{ sql: string | null }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'turns'",
      )
      .get()?.sql ?? null;
  return (
    storedDdl !== null &&
    !storedDdl.includes("CHECK (json_type(type) = 'array')")
  );
}

/**
 * A column family with zero references anywhere in `src/` — the stall-
 * watchdog feature they served is gone — but still standing on any real
 * database old enough to have gained them before that removal (added via an
 * `ALTER` this codebase no longer even contains the function for). Neither
 * `turns` rebuild below is licensed to retire this family: that is a
 * decision for its own ticket (`.scratch/extraction-redesign/spec.md` already
 * names it a "退役列" for a future one to drop on purpose), so both carry it
 * through VERBATIM — present or absent — using the exact DDL text the last
 * version of this codebase that knew about them would have written.
 *
 * Found by running `retireTurnCitesRecordedColumn` against a copy of the real
 * production database (ticket 10c's own testing discipline): that database's
 * `turns` table still carries all four columns, `type` on it is ALSO still
 * the pre-ticket-02 scalar shape, and `ensureTurnTypeMultiValueColumn`'s
 * column list — written before these four columns existed — would have
 * silently dropped them the moment it fired for real, on the very next
 * reload. `assertNoUnexpectedTurnsColumns` below is the guard that turns the
 * NEXT one of these into a loud failure instead of a repeat.
 */
const RETIRED_EXTRACTION_STALL_COLUMNS: ReadonlyArray<{
  name: string;
  ddl: string;
}> = [
  {
    name: "extraction_stall_attempts",
    ddl: "extraction_stall_attempts INTEGER NOT NULL DEFAULT 0 CHECK (extraction_stall_attempts >= 0)",
  },
  {
    name: "extraction_stall_retry_at_ms",
    ddl: "extraction_stall_retry_at_ms INTEGER",
  },
  {
    name: "extraction_stall_retry_after_seq",
    ddl: "extraction_stall_retry_after_seq INTEGER",
  },
  {
    name: "extraction_stall_retry_mode",
    ddl: "extraction_stall_retry_mode TEXT CHECK (extraction_stall_retry_mode IS NULL OR extraction_stall_retry_mode IN ('resume', 'forceFresh'))",
  },
];

/**
 * Every `turns` column a database may or may not carry — the list both rebuilds
 * copy through verbatim WHEN PRESENT and must never assume.
 *
 * Two kinds, deliberately one mechanism. The `extraction_stall_*` four are
 * RETIRED and awaiting a removal ticket of their own; `era_granted_at_epoch` is
 * LIVE, added by a migration that runs after both rebuilds
 * (`ensureTurnEraGrantColumn`). What they share is the only property a rebuild
 * cares about — presence is a fact to be read off the table, never a constant —
 * so giving the live one its own parallel list would be a second mechanism for
 * a question that already has one.
 *
 * Being on this list is what keeps `assertNoUnexpectedTurnsColumns` from
 * refusing a rebuild on an already-migrated database. That guard is not being
 * worked around here, it is being answered: the column is accounted for AND
 * carried, which is exactly what it asks for.
 */
const CONDITIONAL_TURNS_COLUMNS: ReadonlyArray<{ name: string; ddl: string }> = [
  ...RETIRED_EXTRACTION_STALL_COLUMNS,
  { name: ERA_GRANT_COLUMN, ddl: `${ERA_GRANT_COLUMN} INTEGER` },
];

/** Only the subset of `CONDITIONAL_TURNS_COLUMNS` this database actually has. */
function presentConditionalTurnsColumns(
  db: Database,
): ReadonlyArray<{ name: string; ddl: string }> {
  return CONDITIONAL_TURNS_COLUMNS.filter((column) =>
    hasColumn(db, "turns", column.name),
  );
}

/**
 * The safety net for the class of bug `RETIRED_EXTRACTION_STALL_COLUMNS` was
 * found as: a `turns` rebuild whose column list was written against what this
 * codebase knows about silently drops anything a database carries OUTSIDE
 * that list, because an explicit `INSERT ... SELECT` column list only ever
 * copies what it names. Retiring a column is a deliberate, per-column
 * decision (this ticket's whole point); accidentally retiring a different one
 * because nobody told the rebuild it existed is the opposite of that. Called
 * INSIDE the write transaction, before either rebuild touches the table, so a
 * throw here leaves the database exactly as it was.
 *
 * `table_xinfo`, not `table_info` (ticket 15 finding 7, confirmed on this
 * engine): `table_info` OMITS generated columns entirely — a table with
 * `c TEXT GENERATED ALWAYS AS (…) VIRTUAL` reports only its ordinary columns —
 * while `table_xinfo` reports them with `hidden` 2 (stored) or 3 (virtual).
 * Since the guard's whole job is to see what this codebase does not know about,
 * reading the pragma that hides a whole column class is the guard having the
 * exact blind spot it exists to close. `turns` carries no such column today, so
 * this changes no current behaviour: `table_xinfo` returns the same names for a
 * table without hidden columns.
 */
function assertNoUnexpectedTurnsColumns(
  db: Database,
  knownColumns: readonly string[],
  droppedColumns: readonly string[],
  rebuildName: string,
): void {
  const actual = db
    .query<{ name: string }, []>("PRAGMA table_xinfo(turns)")
    .all()
    .map((row) => row.name);
  const accounted = new Set([...knownColumns, ...droppedColumns]);
  const unexpected = actual.filter((name) => !accounted.has(name));
  if (unexpected.length > 0) {
    throw new Error(
      `${rebuildName}: turns carries column(s) this rebuild does not know ` +
        `about and would silently drop: ${unexpected.join(", ")}. Add them ` +
        "to the rebuild's column list (or its explicit drop list) before retrying.",
    );
  }
}

/**
 * Widen `turns.type` from a nullable scalar to a JSON array (ticket 02, spec
 * B5). Every existing non-null scalar is wrapped into a one-element array
 * (`discovery` → `["discovery"]`, spec's Out of Scope: a value-preserving
 * wrap, never a remap onto the new vocabulary); NULL and empty-string become
 * `'[]'`.
 *
 * Runs a SECOND time, on the same shape, for a database that already ran it
 * under the retired loose `CHECK (json_valid(type))` (peer review P2 on
 * ticket 02 — see `turnsTypeColumnIsStale`). On that pass every existing
 * value is already a valid JSON array, so the copy below leaves it alone
 * instead of wrapping it a second time (`["fix"]` must stay `["fix"]`, never
 * become `[["fix"]]`) — it only wraps a value that ISN'T already a valid JSON
 * array, which also makes the copy safe against a row a direct-SQL write put
 * a bare JSON scalar or object into under the loose CHECK: `json_array(...)`
 * always produces a syntactically valid array, so the INSERT below can never
 * itself violate the new table's stricter CHECK.
 *
 * A CHECK constraint cannot be ALTERed onto an existing column, so this is a
 * table rebuild, not an `ALTER TABLE ... ADD COLUMN` — same family of move as
 * `ensureNoteDebtReasonVocabulary` / `ensureNoteSettlementTriggerVocabulary`,
 * but `turns` cannot reuse the first one's rename-the-old-table-away shape (the
 * settlement rebuild has since moved onto the procedure below for the very same
 * reason, its own referencing table). Six other
 * tables (`note_debt`, `observations`, `shadow_notes`, `note_id_exposures`
 * ×2, `segment_members`) hold `REFERENCES turns(id)`, and with
 * `PRAGMA foreign_keys = ON` (database.ts) SQLite's rename repoints every one
 * of those clauses at the RENAMED table — so renaming `turns` itself would
 * leave the real table an orphaned FK target forever, with six tables quietly
 * pointing at a name nothing answers to. The standard 12-step procedure
 * sidesteps this: build the NEW table under a temporary name, drop the OLD
 * `turns`, then rename the new table INTO `turns`. The six REFERENCES clauses
 * never move, because the table named `turns` they point at is swapped out
 * from under a name that never changes.
 *
 * `PRAGMA foreign_keys` is a no-op inside a transaction (SQLite refuses to
 * toggle it once BEGIN has run), so it is set OFF on the connection before
 * `runWriteTransaction` opens one, and restored after — this connection is
 * the process's only handle to the database, and leaving FK enforcement off
 * would silently disable it for everything this process does afterward.
 *
 * The five indexes and the one AFTER DELETE trigger that reference `turns`
 * are dropped along with the old table (SQLite drops a table's indexes and
 * triggers with it) and are recreated explicitly here rather than left to the
 * functions that normally own them: this rebuild runs LAST in
 * `initializeSchema`, after every one of those functions has already run
 * against the old table this call, so nothing later in the chain would
 * recreate what this rebuild just destroyed.
 *
 * Carries `extraction_stall_*` through even though nothing in this codebase
 * reads or writes them any more (grep confirms zero references — the feature
 * they served is gone, and `.scratch/extraction-redesign/spec.md` already
 * names them a retired column family for a FUTURE ticket to drop on purpose).
 * Found by running this rebuild against a copy of the real production
 * database (ticket 10c's own testing discipline): its `turns` table still
 * carries all four, `type` on that database is ALSO still the pre-ticket-02
 * scalar shape, and this rebuild's column list — written before those four
 * columns existed — silently dropped them the moment it fired for real. A
 * column this codebase has already stopped declaring is not this rebuild's
 * to retire; `assertNoUnexpectedTurnsColumns` below is the guard that turns
 * the next one of these into a loud failure instead of a repeat.
 */
function ensureTurnTypeMultiValueColumn(db: Database): void {
  if (!turnsTypeColumnIsStale(db)) {
    return;
  }

  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    runWriteTransaction(db, () => {
      if (!turnsTypeColumnIsStale(db)) {
        return;
      }

      // Present-or-absent, never assumed: this rebuild runs against a database
      // old enough to predate the whole retired stall feature AND against one
      // already carrying `era_granted_at_epoch`, a column added later in
      // `initializeSchema` than this rebuild runs.
      const carriedColumns = presentConditionalTurnsColumns(db);
      const carriedColumnDdl = carriedColumns
        .map((column) => `          ${column.ddl},`)
        .join("\n");
      const carriedColumnNames = carriedColumns
        .map((column) => column.name)
        .join(", ");

      const canonicalColumns = [
        "id", "session_id", "prompt_number", "content_prompt_id",
        "was_interrupted", "was_rolled_back", "status", "user_prompt",
        "assistant_response", "assistant_transcript", "title", "content",
        "insight", "type", "significance_grade", "tags",
        "files_read", "files_modified", "tool_call_count",
        "transcript_line_start",
        "consulted_memories", "compact_boundary_uuid", "parent_turn_id",
        "created_at_epoch", "updated_at_epoch",
      ];
      assertNoUnexpectedTurnsColumns(
        db,
        [...canonicalColumns, ...carriedColumns.map((c) => c.name)],
        // `cites_recorded`: not this rebuild's to carry or drop. Ticket 10c's
        // `retireTurnCitesRecordedColumn` runs right after this one in
        // `initializeSchema` and owns it exclusively — present here or not,
        // it is accounted for, not unexpected.
        //
        // `election_tier`: retired outright (ownership-and-note-cadence spec,
        // ticket 06) — a database migrated under a pre-06 install may still
        // physically carry it (added by the now-removed
        // `ensureTurnElectionTierColumn`), and this rebuild deliberately does
        // NOT carry it forward. Listed here so the guard reads that omission
        // as an intentional drop rather than an unaccounted-for column.
        ["cites_recorded", "election_tier"],
        "ensureTurnTypeMultiValueColumn",
      );

      db.exec(`
        CREATE TABLE turns_pre_multivalued_type_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          prompt_number INTEGER NOT NULL,
          content_prompt_id TEXT,
          was_interrupted INTEGER NOT NULL DEFAULT 0,
          was_rolled_back INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'active',
          user_prompt TEXT,
          assistant_response TEXT,
          assistant_transcript TEXT,
          title TEXT,
          content TEXT,
          insight TEXT,
          type TEXT NOT NULL DEFAULT '[]' CHECK (json_type(type) = 'array'),
          significance_grade INTEGER CHECK (
            significance_grade IS NULL OR significance_grade BETWEEN 0 AND 4
          ),
          tags TEXT,
          files_read TEXT,
          files_modified TEXT,
          tool_call_count INTEGER,
          transcript_line_start INTEGER,
${carriedColumnDdl}
          consulted_memories TEXT,
          compact_boundary_uuid TEXT,
          parent_turn_id INTEGER,
          created_at_epoch INTEGER NOT NULL,
          updated_at_epoch INTEGER,
          UNIQUE(session_id, prompt_number)
        )
      `);

      db.exec(`
        INSERT INTO turns_pre_multivalued_type_new (
          id, session_id, prompt_number, content_prompt_id, was_interrupted,
          was_rolled_back, status, user_prompt, assistant_response,
          assistant_transcript, title, content, insight, type,
          significance_grade, tags, files_read, files_modified,
          tool_call_count, transcript_line_start,
          ${carriedColumnNames ? `${carriedColumnNames},` : ""}
          consulted_memories, compact_boundary_uuid, parent_turn_id,
          created_at_epoch, updated_at_epoch
        )
        SELECT
          id, session_id, prompt_number, content_prompt_id, was_interrupted,
          was_rolled_back, status, user_prompt, assistant_response,
          assistant_transcript, title, content, insight,
          CASE
            WHEN type IS NULL OR type = '' THEN '[]'
            WHEN json_valid(type) AND json_type(type) = 'array' THEN type
            ELSE json_array(type)
          END,
          significance_grade, tags, files_read, files_modified,
          tool_call_count, transcript_line_start,
          ${carriedColumnNames ? `${carriedColumnNames},` : ""}
          consulted_memories, compact_boundary_uuid, parent_turn_id,
          created_at_epoch, updated_at_epoch
        FROM turns
      `);

      db.exec("DROP TABLE turns");
      db.exec(
        "ALTER TABLE turns_pre_multivalued_type_new RENAME TO turns",
      );

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_turns_session_prompt
          ON turns(session_id, prompt_number)
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_turns_status_created
          ON turns(status, created_at_epoch)
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_turns_created_at
          ON turns(created_at_epoch)
      `);
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_compact_boundary_uuid
          ON turns(session_id, compact_boundary_uuid)
          WHERE compact_boundary_uuid IS NOT NULL
      `);
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_session_prompt_id
          ON turns(session_id, content_prompt_id) WHERE content_prompt_id IS NOT NULL
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS memory_edges_prune_deleted_turn
          AFTER DELETE ON turns
          BEGIN
            DELETE FROM memory_edges
            WHERE (citing_kind = 'turn' AND citing_id = OLD.id)
               OR (cited_kind = 'turn' AND cited_id = OLD.id);
          END;
      `);
      // Dropped with the old table like every other trigger on `turns`, and
      // recreated here for the same reason (ticket 15): `retireTopicRegistry`'s
      // fold runs after this rebuild and rewrites `tags` in bulk.
      db.exec(SEGMENT_FACET_STALE_TRIGGERS_DDL);

      // INSIDE the transaction (ticket 15 finding 4). SQLite's 12-step ALTER
      // TABLE procedure runs `foreign_key_check` at step 10 and COMMITs at step
      // 11; running it after the commit inverts those two, so a violation threw
      // over a swap that was already durable — and the next reload's staleness
      // predicate then reads false and skips the rebuild, leaving no repair
      // path for the state the throw announced. Here the throw rolls the swap
      // back, the predicate still reads true, and the next reload retries.
      //
      // `PRAGMA foreign_keys = OFF` is in force around this rebuild and does
      // not weaken the check: `foreign_key_check` is a verification pragma that
      // scans the stored rows, not the enforcement switch, and it reports the
      // same violations with enforcement off (verified on this engine) and
      // inside an open transaction.
      //
      // Matches the 12-step procedure's own verification step: every id was
      // carried over unchanged (explicit column list, no id remapping), so a
      // clean bill of health here is expected, not aspirational.
      const violations = db
        .query<Record<string, unknown>, []>("PRAGMA foreign_key_check")
        .all();
      if (violations.length > 0) {
        throw new Error(
          `turns table rebuild left ${violations.length} foreign key violation(s): ${JSON.stringify(violations)}`,
        );
      }
    });
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
}

/**
 * Ticket 10c: `cites_recorded` was the "from-absent vs recorded-empty"
 * predicate a legacy citation reader consulted before falling back to
 * parsing inline `[T<n>]` out of `content`. Ticket 06 made
 * `getEffectiveCitations` an unconditional union of the edge table and that
 * parse, and the flag has driven no read since (`db/citations.ts`'s own doc
 * comment says so — confirmed by grep across `src/` and `tests/` before this
 * migration was written). It is now write-only dead storage.
 *
 * `NOT NULL`, so this is the same rebuild-and-swap idiom
 * `ensureTurnTypeMultiValueColumn` (just above) uses, rather than
 * `ALTER TABLE ... DROP COLUMN` — which the SQLite version floor this project
 * has to support does not reliably ship.
 *
 * Runs strictly AFTER `ensureTurnTypeMultiValueColumn` (see that call site's
 * own comment in `initializeSchema`): by the time this fires, `turns.type` is
 * guaranteed to already be in its canonical strict-array shape, so this
 * rebuild can carry every other column through unexamined — copying `type`
 * verbatim like everything else — without ever being the one that has to
 * decide what shape it is in.
 *
 * Detection is a direct `hasColumn` check, not a stored-DDL substring match
 * the way `note_debt`/`memory_edges`'s CHECK-widening rebuilds detect
 * staleness: unlike those, this removes a column rather than widening a
 * CHECK, so "the column is gone" is directly observable and is the whole
 * predicate. A fresh database built from the current DDL (which never had the
 * column) and a database this has already run against both skip cleanly. A
 * database whose `type` was ALSO stale skips too, by the time this runs —
 * `ensureTurnTypeMultiValueColumn`'s own rebuild, above, no longer carries
 * `cites_recorded` into its target schema, so it already dropped the column
 * as a side effect.
 *
 * Also carries `RETIRED_EXTRACTION_STALL_COLUMNS` through, present or absent
 * — same reasoning as `ensureTurnTypeMultiValueColumn`'s own copy of this
 * comment, and the same `assertNoUnexpectedTurnsColumns` guard against the
 * next column neither rebuild has been told about.
 */
function retireTurnCitesRecordedColumn(db: Database): void {
  if (!hasColumn(db, "turns", "cites_recorded")) {
    return;
  }

  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    runWriteTransaction(db, () => {
      if (!hasColumn(db, "turns", "cites_recorded")) {
        return;
      }

      const carriedColumns = presentConditionalTurnsColumns(db);
      const carriedColumnDdl = carriedColumns
        .map((column) => `          ${column.ddl},`)
        .join("\n");
      const carriedColumnNames = carriedColumns
        .map((column) => column.name)
        .join(", ");

      const canonicalColumns = [
        "id", "session_id", "prompt_number", "content_prompt_id",
        "was_interrupted", "was_rolled_back", "status", "user_prompt",
        "assistant_response", "assistant_transcript", "title", "content",
        "insight", "type", "significance_grade", "tags",
        "files_read", "files_modified", "tool_call_count",
        "transcript_line_start",
        "consulted_memories", "compact_boundary_uuid", "parent_turn_id",
        "created_at_epoch", "updated_at_epoch",
      ];
      assertNoUnexpectedTurnsColumns(
        db,
        [...canonicalColumns, ...carriedColumns.map((c) => c.name)],
        // `election_tier`: retired outright (ownership-and-note-cadence spec,
        // ticket 06) — see `ensureTurnTypeMultiValueColumn`'s own copy of
        // this comment; this rebuild deliberately does not carry it forward
        // either.
        ["cites_recorded", "election_tier"],
        "retireTurnCitesRecordedColumn",
      );

      db.exec(`
        CREATE TABLE turns_pre_cites_recorded_retired (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          prompt_number INTEGER NOT NULL,
          content_prompt_id TEXT,
          was_interrupted INTEGER NOT NULL DEFAULT 0,
          was_rolled_back INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'active',
          user_prompt TEXT,
          assistant_response TEXT,
          assistant_transcript TEXT,
          title TEXT,
          content TEXT,
          insight TEXT,
          type TEXT NOT NULL DEFAULT '[]' CHECK (json_type(type) = 'array'),
          significance_grade INTEGER CHECK (
            significance_grade IS NULL OR significance_grade BETWEEN 0 AND 4
          ),
          tags TEXT,
          files_read TEXT,
          files_modified TEXT,
          tool_call_count INTEGER,
          transcript_line_start INTEGER,
${carriedColumnDdl}
          consulted_memories TEXT,
          compact_boundary_uuid TEXT,
          parent_turn_id INTEGER,
          created_at_epoch INTEGER NOT NULL,
          updated_at_epoch INTEGER,
          UNIQUE(session_id, prompt_number)
        )
      `);

      db.exec(`
        INSERT INTO turns_pre_cites_recorded_retired (
          id, session_id, prompt_number, content_prompt_id, was_interrupted,
          was_rolled_back, status, user_prompt, assistant_response,
          assistant_transcript, title, content, insight, type,
          significance_grade, tags, files_read, files_modified,
          tool_call_count, transcript_line_start,
          ${carriedColumnNames ? `${carriedColumnNames},` : ""}
          consulted_memories, compact_boundary_uuid, parent_turn_id,
          created_at_epoch, updated_at_epoch
        )
        SELECT
          id, session_id, prompt_number, content_prompt_id, was_interrupted,
          was_rolled_back, status, user_prompt, assistant_response,
          assistant_transcript, title, content, insight, type,
          significance_grade, tags, files_read, files_modified,
          tool_call_count, transcript_line_start,
          ${carriedColumnNames ? `${carriedColumnNames},` : ""}
          consulted_memories, compact_boundary_uuid, parent_turn_id,
          created_at_epoch, updated_at_epoch
        FROM turns
      `);

      db.exec("DROP TABLE turns");
      db.exec(
        "ALTER TABLE turns_pre_cites_recorded_retired RENAME TO turns",
      );

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_turns_session_prompt
          ON turns(session_id, prompt_number)
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_turns_status_created
          ON turns(status, created_at_epoch)
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_turns_created_at
          ON turns(created_at_epoch)
      `);
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_compact_boundary_uuid
          ON turns(session_id, compact_boundary_uuid)
          WHERE compact_boundary_uuid IS NOT NULL
      `);
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_session_prompt_id
          ON turns(session_id, content_prompt_id) WHERE content_prompt_id IS NOT NULL
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS memory_edges_prune_deleted_turn
          AFTER DELETE ON turns
          BEGIN
            DELETE FROM memory_edges
            WHERE (citing_kind = 'turn' AND citing_id = OLD.id)
               OR (cited_kind = 'turn' AND cited_id = OLD.id);
          END;
      `);
      db.exec(SEGMENT_FACET_STALE_TRIGGERS_DDL);

      // Inside the transaction, for the reason spelled out in full at
      // `ensureTurnTypeMultiValueColumn`'s own copy of this check (ticket 15
      // finding 4): a check that runs after the commit turns a violation into a
      // durable swap plus a skipped migration, i.e. no repair path.
      const violations = db
        .query<Record<string, unknown>, []>("PRAGMA foreign_key_check")
        .all();
      if (violations.length > 0) {
        throw new Error(
          `turns table rebuild left ${violations.length} foreign key violation(s) while retiring cites_recorded: ${JSON.stringify(violations)}`,
        );
      }
    });
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
}

/**
 * SQLite reports the lost half of a concurrent migration as
 * `duplicate column name: <column>` under the generic SQLITE_ERROR code, so the
 * message is the only thing there is to recognise it by. Matched loosely on
 * purpose: the driver decorates it differently across versions.
 */
function isDuplicateColumnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /duplicate column name/i.test(message);
}

/**
 * `ALTER TABLE … ADD COLUMN`, made safe against a second process running the
 * same migration at the same moment.
 *
 * The check and the ALTER cannot be one statement, and `initializeSchema` runs
 * from every entry point — including the hook entries, which Claude Code starts
 * in parallel for a single event (`session-init` and `prompt-dispatch` both open
 * the database on UserPromptSubmit). On a database that has not been migrated
 * yet, both processes read "column missing" and both issue the ALTER; SQLite
 * serialises them, one adds the column and the other fails with a duplicate. The
 * loser has nothing to fix — the post-condition this function promises is that
 * the column exists, and it does — but the throw propagates out of schema
 * initialisation and takes the caller's real work with it, which for
 * `session-init` is the turn row of the prompt being submitted.
 *
 * Returns whether the column was missing when this call looked, so a caller with
 * a one-time backfill still runs it after losing the race.
 */
function addColumnIfMissing(
  db: Database,
  table: string,
  column: string,
  definition: string,
): boolean {
  if (hasColumn(db, table, column)) {
    return false;
  }

  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN "${column}" ${definition}`);
  } catch (error) {
    if (!isDuplicateColumnError(error)) {
      throw error;
    }
  }

  return true;
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const rows = db
    .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${table}')`)
    .all();

  return rows.some((row) => row.name === column);
}

function hasRow(
  db: Database,
  sql: string,
  params: Array<string | number> = [],
): boolean {
  return (
    db.query<{ hasRows: number }, Array<string | number>>(
      `SELECT EXISTS(${sql}) AS hasRows`,
    ).get(...params)?.hasRows === 1
  );
}

function shouldRebuildSearchIndex(db: Database): boolean {
  const sourceLayers = [
    { table: "sessions", layer: "session" },
    { table: "turns", layer: "turn" },
    { table: "observations", layer: "observation" },
    { table: "segments", layer: "segment" },
    { table: "rules", layer: "rule" },
  ] as const;

  const hasAnySourceRows = sourceLayers.some(({ table }) =>
    hasRow(db, `SELECT 1 FROM ${table} LIMIT 1`),
  );
  const hasAnyFtsRows = hasRow(db, "SELECT 1 FROM memory_fts LIMIT 1");

  if (!hasAnySourceRows && !hasAnyFtsRows) {
    return false;
  }

  if (hasAnySourceRows !== hasAnyFtsRows) {
    return true;
  }

  const indexedLayers = new Set(
    db
      .query<{ layer: string }, []>("SELECT DISTINCT layer FROM memory_fts")
      .all()
      .map((row) => row.layer),
  );

  return sourceLayers.some(
    ({ table, layer }) =>
      hasRow(db, `SELECT 1 FROM ${table} LIMIT 1`) &&
      !indexedLayers.has(layer),
  );
}

function hasLegacySchema(db: Database): boolean {
  const sessionsLegacyColumns = ["description", "started_at_epoch"];
  const turnsLegacyColumns = ["description"];
  const observationsLegacyColumns = [
    "type",
    "description",
    "insight",
    "narrative",
    "facts",
    "tags",
    "concepts",
    "files_read",
    "files_modified",
  ];
  const observationsCurrentColumns = [
    "tool_name",
    "tool_input",
    "tool_result",
    "status",
    "content",
  ];
  const hasLegacyObservationColumns = observationsLegacyColumns.some((column) =>
    hasColumn(db, "observations", column),
  );
  const isMissingCurrentObservationColumns = observationsCurrentColumns.some(
    (column) => !hasColumn(db, "observations", column),
  );

  return (
    sessionsLegacyColumns.some((column) => hasColumn(db, "sessions", column)) ||
    turnsLegacyColumns.some((column) => hasColumn(db, "turns", column)) ||
    (hasLegacyObservationColumns && isMissingCurrentObservationColumns)
  );
}

function resetSchema(db: Database): void {
  db.exec("DROP TRIGGER IF EXISTS rule_events_validate_source");
  db.exec("DROP TRIGGER IF EXISTS rules_validate_trigger_spec_update");
  db.exec("DROP TRIGGER IF EXISTS rules_validate_trigger_spec_insert");
  db.exec("DROP TRIGGER IF EXISTS rule_events_no_delete");
  db.exec("DROP TRIGGER IF EXISTS rule_events_no_update");
  db.exec("DROP TRIGGER IF EXISTS rules_no_hard_delete");
  db.exec("DROP TABLE IF EXISTS rule_events");
  db.exec("DROP TABLE IF EXISTS rules");
  db.exec("DROP TABLE IF EXISTS persona_operation_state");
  db.exec("DROP TABLE IF EXISTS diary_state");
  db.exec("DROP TABLE IF EXISTS diary_day_state");
  db.exec("DROP TABLE IF EXISTS pending_queue");
  // Sessions are about to be dropped, so a completed repair over the old rows
  // must not stop the repair from running against whatever replaces them.
  db.exec("DROP TABLE IF EXISTS repair_ledger");
  db.exec("DROP TABLE IF EXISTS diary_day_state");
  db.exec("DROP TABLE IF EXISTS memories");
  db.exec("DROP TABLE IF EXISTS shadow_notes");
  db.exec("DROP TABLE IF EXISTS note_id_exposures");
  db.exec("DROP TABLE IF EXISTS note_settlement_segment_exclusions");
  db.exec("DROP TABLE IF EXISTS note_settlement_debts");
  db.exec("DROP TABLE IF EXISTS note_settlement_proposals");
  db.exec("DROP TABLE IF EXISTS note_settlement_jobs");
  db.exec("DROP TABLE IF EXISTS note_settlement_watermark_floors");
  db.exec("DROP TABLE IF EXISTS note_settlement_watermark_state");
  db.exec("DROP TABLE IF EXISTS note_settlement_cursors");
  db.exec("DROP TABLE IF EXISTS note_debt_cursor");
  db.exec("DROP TABLE IF EXISTS note_debt");
  db.exec("DROP TABLE IF EXISTS note_debt_pre_closed_reason");
  db.exec("DROP TABLE IF EXISTS observations");
  db.exec("DROP TABLE IF EXISTS segment_detachments");
  db.exec("DROP TABLE IF EXISTS segment_attachments");
  db.exec("DROP TABLE IF EXISTS segment_members");
  db.exec("DROP TABLE IF EXISTS segments");
  db.exec("DROP TABLE IF EXISTS topics");
  db.exec("DROP TABLE IF EXISTS memory_edges");
  db.exec("DROP TABLE IF EXISTS turn_citations");
  db.exec("DROP TABLE IF EXISTS settlement_jobs");
  db.exec("DROP TABLE IF EXISTS settlement_cursors");
  db.exec("DROP TABLE IF EXISTS turns");
  db.exec("DROP TABLE IF EXISTS session_run_state");
  db.exec("DROP TABLE IF EXISTS sessions");
  db.exec("DROP TABLE IF EXISTS memory_fts");
}

export function initializeDatabase(db: Database): void {
  if (hasLegacySchema(db)) {
    console.warn("[claude-mnemo] legacy schema detected, resetting database");
    resetSchema(db);
  }

  initializeSchema(db);
  // Only once the migrations above have RETURNED. A build whose migrations threw
  // did not finish taking this database over, and must not leave a row claiming
  // it did — the worker reads this row to decide whether the schema it is about
  // to write against is still the one it knows.
  recordInitializerBuild(db, BUILD_ID, Math.floor(Date.now() / 1000));

  if (shouldRebuildSearchIndex(db)) {
    rebuildSearchIndex(db);
  }

  // NOTE: data repairs that touch the filesystem do NOT belong here. Every hook
  // process opens the database through this function, so anything hosted here
  // is on the hook critical path and runs in as many processes at once as there
  // are hooks. `repair_ledger`-driven repairs (transcript-path-backfill) run in
  // the worker's watchdog tick instead — see src/worker/server.ts.
}
