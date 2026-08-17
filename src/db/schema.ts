import type { Database } from "bun:sqlite";

import { BUILD_ID } from "../shared/build-id";
import { recordInitializerBuild } from "./build-state";
import { isCitationRelation, type CitationRelation } from "./citations";
import { runWriteTransaction } from "./database";
import { rankEdgeProvenance, type EdgeProvenance } from "./memory-edges";
import { rebuildSearchIndex } from "./search";
import { repairStaleSegmentFacets } from "./segments";

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
// the old one away instead is unsafe here). One definition, two names.
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
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
      status IN ('pending', 'claimed', 'done', 'failed')
    ),
    attempts INTEGER NOT NULL DEFAULT 0,
    -- Exponential backoff by TIMESTAMP COMPARISON, not by timer: the worker owns
    -- no clock for settlement, so a due retry is noticed in passing by the next
    -- trigger event rather than woken by anything.
    retry_at_epoch INTEGER NOT NULL DEFAULT 0,
    claimed_at_epoch INTEGER,
    -- Ownership fence, bumped on every successful claim (settlement_jobs idiom).
    -- A dispatch whose lease expired CASes on the generation it was claimed
    -- under and so writes nothing over the attempt that displaced it.
    claim_generation INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
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
    -- Election tier (ADR-0003, ticket 06) — the third grading semantics, era-
    -- gated against significance_grade above (src/election-era.ts): a legacy
    -- turn carries a grade, a new-era one carries a tier, never both. Added by
    -- ensureTurnElectionTierColumn below on a pre-existing database; declared
    -- here too so a FRESH database gets it at creation without waiting on that
    -- migration to run.
    election_tier TEXT CHECK (
      election_tier IS NULL OR election_tier IN ('A', 'B', 'C')
    ),
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

  CREATE TABLE IF NOT EXISTS note_settlement_cursors (
    session_id INTEGER PRIMARY KEY
      REFERENCES sessions(id) ON DELETE CASCADE,
    -- Highest prompt_number such that every window at or below it is RESOLVED.
    -- A terminally failed window resolves too (terminal-state-must-abandon-and-
    -- continue): holding the cursor at it would wedge the session forever.
    last_settled_prompt_number INTEGER NOT NULL DEFAULT 0,
    updated_at_epoch INTEGER NOT NULL
  );

  -- Topic registry (spec D6): the one place a theme's name and its alternate
  -- spellings live, so "continuous work on the same theme reuses the same word"
  -- is enforceable rather than aspirational. The aliases column is a JSON array of
  -- the other names the same theme has been written as; the settlement pass folds
  -- new spellings in here instead of minting a near-duplicate topic.
  CREATE TABLE IF NOT EXISTS topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    aliases TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(aliases)),
    status TEXT NOT NULL DEFAULT 'active' CHECK (
      status IN ('active', 'dormant', 'retired')
    ),
    created_at_epoch INTEGER NOT NULL,
    updated_at_epoch INTEGER NOT NULL
  );

  -- Segments (spec D6): one coherent chapter of work on one topic. Same field
  -- shape as a turn — title / content / type / tag / status — because the
  -- reading surfaces (recall's type:/tag: filters, FTS, the glyph) are meant to
  -- work across granularities without a second vocabulary.
  --
  -- Deliberately NOT bound to a session: a topic outruns any one session, and a
  -- segment that had to name one would have to pick arbitrarily among its
  -- members' sessions. Membership (segment_members) carries that relation.
  --
  -- type and tags are JSON arrays (multi-value; a segment's type is the
  -- union of its members'). revision is the write fence: an open segment is a
  -- living document that concurrent settlements may both want to rewrite, so
  -- every write CASes on the revision it read (see db/segments.ts).
  CREATE TABLE IF NOT EXISTS segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id INTEGER REFERENCES topics(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    content TEXT,
    -- Ticket 14 (spec K5): the segment's most reusable conclusion, including
    -- the routes ruled out and why. Same column as a turn's insight and the
    -- inverse default: a turn's is empty unless something durable was learned,
    -- a segment's is the point of the row.
    insight TEXT,
    type TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(type)),
    tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
    -- open = still accepting members and rewrites; delivered = closed by a
    -- shipped/merged/settled outcome; abandoned = went silent. Only open
    -- segments are writable — a closed one is frozen and gets overturned by an
    -- edge, never by a rewrite (spec D6: freeze history, not the present).
    status TEXT NOT NULL DEFAULT 'open' CHECK (
      status IN ('open', 'delivered', 'abandoned')
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
    -- below) — same shape of migration as election_tier on turns, no
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

  CREATE INDEX IF NOT EXISTS idx_segments_topic_status
    ON segments(topic_id, status, updated_at_epoch);

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
// PRIMARY KEY (citing, cited) — the PAIR is the identity. `relation` sits
// OUTSIDE the key as a nullable ATTRIBUTE of the pair (spec C5): an
// unattributed citation (a bare textual reference) is a real storable state,
// and correcting a relation UPDATES the row instead of inserting a second one
// under the same pair. `provenance` is also outside the key — the audit layer
// telling you how the edge was learned, spanning five sources (spec C12: it
// must tell apart the main agent's own assertion `asserted`, a bare textual
// reference `text-ref`, and a settlement attribution `judged`, which the
// pre-ticket-05 column conflated). A conflicting write on an existing pair is
// resolved by writeMemoryEdges (db/memory-edges.ts, spec C14): a
// relation-bearing write replaces relation and provenance together,
// unconditionally — no source ranking gates the correction — while a bare
// write leaves both untouched.
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
const MEMORY_EDGES_DDL = `
  CREATE TABLE IF NOT EXISTS memory_edges (
    citing_kind TEXT NOT NULL CHECK (citing_kind IN ('turn', 'segment', 'session')),
    citing_id INTEGER NOT NULL,
    cited_kind TEXT NOT NULL CHECK (cited_kind IN ('turn', 'segment')),
    cited_id INTEGER NOT NULL,
    relation TEXT CHECK (
      relation IS NULL OR
      relation IN ('evidence-for', 'evidence-against', 'supersedes', 'depends-on')
    ),
    provenance TEXT NOT NULL CHECK (
      provenance IN ('retrieval', 'text-ref', 'rollback', 'judged', 'asserted')
    ),
    created_at_epoch INTEGER NOT NULL,
    PRIMARY KEY (citing_kind, citing_id, cited_kind, cited_id)
  );

  CREATE INDEX IF NOT EXISTS idx_memory_edges_cited
    ON memory_edges(cited_kind, cited_id, relation);
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
 *     a compact boundary, and `stripRetiredTopicTagNamespace` below rewrites
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
 * `depends-on` — always a special case of dependency — so it remaps outright.
 * `builds-on` split three ways under blind re-labelling (62% depends-on / 18%
 * no relation / 16% evidence-for) with no per-row way to tell which is which;
 * remapping it to any single new value would silently reinterpret roughly a
 * third of it, which the ticket forbids ("builds-on is not depends-on at the
 * row level, even though 62% of it measured that way"). It keeps its PAIR (a
 * citation genuinely existed) and loses its RELATION — becomes bare/
 * unattributed — rather than either being dropped or guessed at.
 */
function remapLegacyRelation(relation: string): CitationRelation | null {
  if (relation === "implements") {
    return "depends-on";
  }
  if (relation === "builds-on") {
    return null;
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
  return storedDdl !== null && !storedDdl.includes("'depends-on'");
}

function collapseAndRebuildMemoryEdges(db: Database): void {
  db.exec("ALTER TABLE memory_edges RENAME TO memory_edges_pre_pair_identity");
  db.exec(MEMORY_EDGES_DDL);

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
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_edges_cited
      ON memory_edges(cited_kind, cited_id, relation);
  `);
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

function ensureMemoryEdgesSchema(db: Database): void {
  const isFirstCreation = !hasTable(db, "memory_edges");
  if (!isFirstCreation) {
    ensureMemoryEdgesPairIdentity(db);
  }
  db.exec(MEMORY_EDGES_DDL);
  // Idempotent (CREATE TRIGGER IF NOT EXISTS) and safe to (re-)run on every
  // process start, including on a database whose triggers already exist from
  // an earlier version of this same function.
  db.exec(MEMORY_EDGE_ENDPOINT_TRIGGERS_DDL);

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
 * Spec C16: on an OVERLAPPING pair the citation side wins — its relation and
 * provenance overwrite whatever `memory_edges` already holds for that pair,
 * with no rank test between them, because `turn_citations` was the timeline
 * correction graph's replace-set truth right up to its retirement, i.e. the
 * side that was actually being read.
 *
 * That win is conditional on the citation SAYING something. A `builds-on`
 * citation remaps to NULL (`remapLegacyRelation`, spec C2), which is the
 * absence of a statement about the relation and not a statement that there is
 * none — so it contributes only the pair, exactly as the live upsert's C14
 * rule already has it (`writeMemoryEdges` uses this same CASE). Without that
 * condition the fold-in would carry a NULL over a relation settlement had
 * corrected, in one irreversible pass that then drops the source table.
 * Measured before landing: 0 of the 1182 overlapping pairs are in that shape
 * today, so this closes an empty path — but an empty path in a one-shot
 * migration is the cheapest kind to close.
 *
 * Only `created_at_epoch` is pooled rather than replaced: the EARLIER of the
 * two timestamps survives, so the fold-in can only move "when did this edge
 * first appear" earlier, never later — and it moves independently of the
 * relation, so a relationless citation that predates the edge still corrects
 * the age. A pair present only in `memory_edges` is left untouched — this
 * function only ever iterates `turn_citations` rows, so it has nothing to say
 * about a pair that isn't one of them.
 *
 * A pair the legacy table held under two relations (its wider key allowed
 * that) is collapsed to the single relation `pickWinningLegacyRelation`
 * selects, with the same builds-on/implements remap the schema rebuild uses
 * (spec C2). Legacy rows land on `judged` provenance: `turn_citations` was
 * only ever written from an explicit `cites` array, i.e. a writer assigned
 * that relation directly, and `judged` is the closest of the new vocabulary's
 * five values to "a model assigned this relation" without claiming it was
 * `asserted` by the SAME call that wrote the citing prose, which the
 * migration cannot know for certain rows this old.
 *
 * Idempotent: the upsert's `DO UPDATE` is WHERE-guarded to fire only when
 * applying it would actually change the stored relation, provenance or
 * created_at_epoch, so a re-run over unchanged source data writes nothing.
 *
 * Returns the number of pairs this call actually INSERTED OR CHANGED — a
 * genuine no-op re-run (nothing in `turn_citations` says anything new)
 * returns 0, not a count of pairs merely revisited. `RETURNING` used to fire
 * only on insert (`DO NOTHING`); now that a conflict can also mutate a row,
 * "newly inserted" is no longer the whole story, so this is "newly inserted
 * or corrected" — the number a caller (and the migration tests) uses to
 * assert zero loss on the first pass and true idempotency (0) on a repeat.
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

  const insert = db.query<
    { inserted: number },
    [number, number, string | null, string, number]
  >(
    `INSERT INTO memory_edges (
       citing_kind, citing_id, cited_kind, cited_id,
       relation, provenance, created_at_epoch
     ) VALUES ('turn', ?, 'turn', ?, ?, ?, ?)
     ON CONFLICT (citing_kind, citing_id, cited_kind, cited_id) DO UPDATE SET
       -- Spec C16: a citation that STATES a relation wins outright on an
       -- overlap — no rank test. A citation whose relation remapped to NULL
       -- ('builds-on') states nothing about the relation, so it contributes
       -- only the pair and never clears one the edge already carries: the
       -- same CASE the live upsert uses for C14 (memory-edges.ts), because
       -- the reason is the same one. Only the timestamp is pooled rather
       -- than replaced, and it can only move earlier.
       relation = CASE
         WHEN excluded.relation IS NOT NULL THEN excluded.relation
         ELSE memory_edges.relation
       END,
       provenance = CASE
         WHEN excluded.relation IS NOT NULL THEN excluded.provenance
         ELSE memory_edges.provenance
       END,
       created_at_epoch = MIN(memory_edges.created_at_epoch, excluded.created_at_epoch)
     WHERE (excluded.relation IS NOT NULL
            AND (memory_edges.relation IS NOT excluded.relation
                 OR memory_edges.provenance IS NOT excluded.provenance))
        OR memory_edges.created_at_epoch > excluded.created_at_epoch
     RETURNING 1 AS inserted`,
  );

  let migrated = 0;
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
    if (
      insert.get(
        sample.citingTurnId,
        sample.citedTurnId,
        winner.relation,
        winner.provenance,
        winner.createdAtEpoch,
      )
    ) {
      migrated += 1;
    }
  }

  return migrated;
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
  ensureTurnTranscriptLineStartColumn(db);
  ensureTurnAssistantTranscriptColumn(db);
  ensureTurnInvalidationColumns(db);
  ensureTurnSignificanceGradeColumn(db);
  ensureTurnElectionTierColumn(db);
  ensureSegmentInsightColumn(db);
  ensureSegmentWorkingStateColumns(db);
  ensureSegmentDerivedFacets(db);
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
  ensureShadowNoteWriterOriginColumn(db);
  ensureNoteDebtReasonVocabulary(db);
  ensureNoteDebtRemindedColumn(db);
  ensureNoteDebtCursorReliefColumn(db);
  retireLegacyPendingNoteDebts(db);
  ensureNoteSettlementTriggerVocabulary(db);
  dropLegacyMemoriesTable(db);
  // Last on purpose: every other turns-column migration above (parent_turn_id,
  // compact_boundary_uuid, consulted_memories, ...) must have
  // already landed on `turns` before this rebuild copies it, or the copy would
  // silently drop a column a database created between those migrations and
  // this one still needs.
  ensureTurnTypeMultiValueColumn(db);
  // After the rebuild, not before: this rewrites rows in whichever table
  // answers to `turns` at the end of the chain.
  stripRetiredTopicTagNamespace(db);
  // Also after `ensureTurnTypeMultiValueColumn`: this rebuild's own hardcoded
  // `type` column definition assumes the canonical strict-array shape that
  // function guarantees, so it must never be the one deciding what shape
  // `type` is in.
  retireTurnCitesRecordedColumn(db);
  // Strictly last (ticket 15): both rebuilds above and the tag-namespace strip
  // rewrite the member columns this derives from.
  repairDerivedSegmentFacets(db);
}

/**
 * Strip the retired `topic:` namespace off `turns.tags` (spec B6, ticket 02).
 *
 * The prefix existed to hold a topic facet apart from session-arc role words
 * inside one column. The roles have since become `type` values, so the prefix
 * marks nothing: of 7229 prefixed values in the live corpus, 6427 were
 * `topic:`, and the three namespaces left behind (`compact:` 414,
 * `invalidated:` 340, `delivery:` 46) are all machinery. Stripping leaves one
 * rule a reader can hold — a bare tag is what the turn was about, a prefixed
 * one is bookkeeping — in place of a read-side mechanism obliged to match two
 * spellings of every topic forever. That is the whole reason to migrate the
 * data rather than translate on read.
 *
 * Order-preserving and de-duplicating, because a turn can already carry both
 * spellings of one word; exactly one row in the live corpus does. Naturally
 * idempotent — a second run finds nothing prefixed left to strip.
 *
 * Peer review P1: `tags` carries no `json_valid` CHECK, so a malformed row is
 * storable, and `json_each(turns.tags)` in the candidate SELECT below used to
 * run unguarded — SQLite throws `malformed JSON` out of `.all()` itself, which
 * is BEFORE the `JSON.parse` try/catch in the loop, making that catch
 * unreachable for exactly the row it exists to handle and aborting
 * `initializeSchema` for every caller on one bad row. The `json_valid` /
 * `json_type … = 'array'` guards below stop the malformed or non-array row
 * from ever reaching `json_each`; such a row is therefore left exactly as
 * stored, forever un-strippable by this pass (it was already unreadable to
 * every array-shaped consumer of `tags`, so this changes nothing about what a
 * reader can already do with it) rather than aborting every other row's
 * migration.
 */
function stripRetiredTopicTagNamespace(db: Database): void {
  const rows = db
    .query<{ id: number; tags: string }, []>(
      `SELECT id, tags FROM turns
       WHERE tags IS NOT NULL
         AND json_valid(tags)
         AND json_type(tags) = 'array'
         AND EXISTS (
           SELECT 1 FROM json_each(turns.tags) j WHERE j.value LIKE 'topic:%'
         )`,
    )
    .all();
  if (rows.length === 0) {
    return;
  }

  const update = db.query<unknown, [string, number]>(
    "UPDATE turns SET tags = ? WHERE id = ?",
  );
  runWriteTransaction(db, () => {
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.tags);
      } catch {
        continue;
      }
      if (!Array.isArray(parsed)) {
        continue;
      }
      const stripped: string[] = [];
      for (const value of parsed) {
        if (typeof value !== "string") {
          continue;
        }
        const bare = value.startsWith("topic:")
          ? value.slice("topic:".length)
          : value;
        if (bare.length > 0 && !stripped.includes(bare)) {
          stripped.push(bare);
        }
      }
      update.run(JSON.stringify(stripped), row.id);
    }
  });
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
 * database. Same shape of migration as `ensureTurnElectionTierColumn` right
 * above it in `initializeSchema`'s call list — every one of these six is a
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
 * Ticket 15 (findings 2-3): pay every facet derivation the database records as
 * owed — the migration backfill above, and any membership the FK cascade of a
 * deleted turn or session removed since the last process start.
 *
 * Runs LAST in `initializeSchema`, after both `turns` rebuilds and after
 * `stripRetiredTopicTagNamespace`: those rewrite the very `type`/`tags` columns
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

/**
 * Election tier (ADR-0003, ticket 06) — same shape of migration as
 * `ensureTurnSignificanceGradeColumn` immediately above: a plain nullable
 * column whose CHECK references only itself, so `ALTER TABLE … ADD COLUMN`
 * is legal SQLite (no rebuild needed — a CHECK constraint only blocks a bare
 * ADD COLUMN when it references OTHER columns or forbids NULL without a
 * default, neither of which applies here). Every existing row reads NULL,
 * which is correct: a turn already on disk when this migration runs predates
 * the election-era cutoff by construction, so it was never going to carry a
 * tier anyway (src/election-era.ts).
 */
function ensureTurnElectionTierColumn(db: Database): void {
  addColumnIfMissing(
    db,
    "turns",
    "election_tier",
    "TEXT CHECK (election_tier IS NULL OR election_tier IN ('A', 'B', 'C'))",
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

/** Only the subset of `RETIRED_EXTRACTION_STALL_COLUMNS` this database actually has. */
function presentRetiredExtractionStallColumns(
  db: Database,
): ReadonlyArray<{ name: string; ddl: string }> {
  return RETIRED_EXTRACTION_STALL_COLUMNS.filter((column) =>
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

      // Present-or-absent, never assumed: this rebuild also runs against a
      // database old enough to predate the whole retired feature.
      const stallColumns = presentRetiredExtractionStallColumns(db);
      const stallColumnDdl = stallColumns
        .map((column) => `          ${column.ddl},`)
        .join("\n");
      const stallColumnNames = stallColumns
        .map((column) => column.name)
        .join(", ");

      const canonicalColumns = [
        "id", "session_id", "prompt_number", "content_prompt_id",
        "was_interrupted", "was_rolled_back", "status", "user_prompt",
        "assistant_response", "assistant_transcript", "title", "content",
        "insight", "type", "significance_grade", "election_tier", "tags",
        "files_read", "files_modified", "tool_call_count",
        "transcript_line_start",
        "consulted_memories", "compact_boundary_uuid", "parent_turn_id",
        "created_at_epoch", "updated_at_epoch",
      ];
      assertNoUnexpectedTurnsColumns(
        db,
        [...canonicalColumns, ...stallColumns.map((c) => c.name)],
        // `cites_recorded`: not this rebuild's to carry or drop. Ticket 10c's
        // `retireTurnCitesRecordedColumn` runs right after this one in
        // `initializeSchema` and owns it exclusively — present here or not,
        // it is accounted for, not unexpected.
        ["cites_recorded"],
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
          election_tier TEXT CHECK (
            election_tier IS NULL OR election_tier IN ('A', 'B', 'C')
          ),
          tags TEXT,
          files_read TEXT,
          files_modified TEXT,
          tool_call_count INTEGER,
          transcript_line_start INTEGER,
${stallColumnDdl}
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
          significance_grade, election_tier, tags, files_read, files_modified,
          tool_call_count, transcript_line_start,
          ${stallColumnNames ? `${stallColumnNames},` : ""}
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
          significance_grade, election_tier, tags, files_read, files_modified,
          tool_call_count, transcript_line_start,
          ${stallColumnNames ? `${stallColumnNames},` : ""}
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
      // recreated here for the same reason (ticket 15): `stripRetiredTopicTagNamespace`
      // runs between this rebuild and the next one and rewrites `tags` in bulk.
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

      const stallColumns = presentRetiredExtractionStallColumns(db);
      const stallColumnDdl = stallColumns
        .map((column) => `          ${column.ddl},`)
        .join("\n");
      const stallColumnNames = stallColumns
        .map((column) => column.name)
        .join(", ");

      const canonicalColumns = [
        "id", "session_id", "prompt_number", "content_prompt_id",
        "was_interrupted", "was_rolled_back", "status", "user_prompt",
        "assistant_response", "assistant_transcript", "title", "content",
        "insight", "type", "significance_grade", "election_tier", "tags",
        "files_read", "files_modified", "tool_call_count",
        "transcript_line_start",
        "consulted_memories", "compact_boundary_uuid", "parent_turn_id",
        "created_at_epoch", "updated_at_epoch",
      ];
      assertNoUnexpectedTurnsColumns(
        db,
        [...canonicalColumns, ...stallColumns.map((c) => c.name)],
        ["cites_recorded"],
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
          election_tier TEXT CHECK (
            election_tier IS NULL OR election_tier IN ('A', 'B', 'C')
          ),
          tags TEXT,
          files_read TEXT,
          files_modified TEXT,
          tool_call_count INTEGER,
          transcript_line_start INTEGER,
${stallColumnDdl}
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
          significance_grade, election_tier, tags, files_read, files_modified,
          tool_call_count, transcript_line_start,
          ${stallColumnNames ? `${stallColumnNames},` : ""}
          consulted_memories, compact_boundary_uuid, parent_turn_id,
          created_at_epoch, updated_at_epoch
        )
        SELECT
          id, session_id, prompt_number, content_prompt_id, was_interrupted,
          was_rolled_back, status, user_prompt, assistant_response,
          assistant_transcript, title, content, insight, type,
          significance_grade, election_tier, tags, files_read, files_modified,
          tool_call_count, transcript_line_start,
          ${stallColumnNames ? `${stallColumnNames},` : ""}
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
  db.exec("DROP TABLE IF EXISTS note_settlement_jobs");
  db.exec("DROP TABLE IF EXISTS note_settlement_cursors");
  db.exec("DROP TABLE IF EXISTS note_debt_cursor");
  db.exec("DROP TABLE IF EXISTS note_debt");
  db.exec("DROP TABLE IF EXISTS note_debt_pre_closed_reason");
  db.exec("DROP TABLE IF EXISTS observations");
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
