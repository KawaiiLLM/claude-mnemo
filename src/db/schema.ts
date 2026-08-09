import type { Database } from "bun:sqlite";

import { rebuildSearchIndex } from "./search";

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
    last_agent_session_id TEXT,
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
    extraction_stall_attempts INTEGER NOT NULL DEFAULT 0 CHECK (
      extraction_stall_attempts >= 0
    ),
    extraction_stall_retry_at_ms INTEGER,
    extraction_stall_retry_after_seq INTEGER,
    extraction_stall_retry_mode TEXT CHECK (
      extraction_stall_retry_mode IS NULL OR
      extraction_stall_retry_mode IN ('resume', 'forceFresh')
    ),
    status TEXT NOT NULL DEFAULT 'active',
    user_prompt TEXT,
    assistant_response TEXT,
    assistant_transcript TEXT,
    title TEXT,
    content TEXT,
    insight TEXT,
    type TEXT,
    significance_grade INTEGER CHECK (
      significance_grade IS NULL OR significance_grade BETWEEN 0 AND 4
    ),
    tags TEXT,
    files_read TEXT,
    files_modified TEXT,
    tool_call_count INTEGER,
    transcript_line_start INTEGER,
    cites_recorded INTEGER NOT NULL DEFAULT 0,
    compact_boundary_uuid TEXT,
    created_at_epoch INTEGER NOT NULL,
    updated_at_epoch INTEGER,
    UNIQUE(session_id, prompt_number)
  );

  CREATE TABLE IF NOT EXISTS turn_citations (
    citing_turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    cited_turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    relation TEXT NOT NULL CHECK (
      relation IN ('builds-on', 'implements', 'supersedes', 'evidence-for')
    ),
    created_at_epoch INTEGER NOT NULL,
    PRIMARY KEY (citing_turn_id, cited_turn_id, relation)
  );

  CREATE INDEX IF NOT EXISTS idx_turn_citations_cited
    ON turn_citations(cited_turn_id);

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
  CREATE TABLE IF NOT EXISTS note_debt (
    turn_id INTEGER PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    prompt_number INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
      status IN ('pending', 'noted', 'skipped')
    ),
    -- Only a skipped debt carries a reason (D4's status vocabulary).
    reason TEXT CHECK (
      reason IS NULL OR reason IN ('aged', 'rolled-back')
    ),
    opened_at_epoch INTEGER NOT NULL,
    closed_at_epoch INTEGER,
    updated_at_epoch INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_note_debt_open
    ON note_debt(session_id, status, prompt_number);

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

export function initializeSchema(db: Database): void {
  db.exec(SCHEMA_SQL);
  ensureDiaryDayStateTerminalColumn(db);
  ensureDiaryDayStateRetryDispositionColumn(db);
  ensureSessionLastAgentSessionIdColumn(db);
  ensureSessionTranscriptPathColumn(db);
  ensureSessionSummaryUpdatedAtEpochColumn(db);
  ensureSessionSummaryFieldColumns(db);
  ensureTurnTranscriptLineStartColumn(db);
  ensureTurnAssistantTranscriptColumn(db);
  ensureTurnInvalidationColumns(db);
  ensureTurnExtractionStallRetryColumns(db);
  ensureTurnSignificanceGradeColumn(db);
  ensureTurnCitationsSchema(db);
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
  ensureNoteDebtCursorReliefColumn(db);
  dropLegacyMemoriesTable(db);
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

function ensureSessionLastAgentSessionIdColumn(db: Database): void {
  addColumnIfMissing(db, "sessions", "last_agent_session_id", "TEXT");
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

function ensureTurnExtractionStallRetryColumns(db: Database): void {
  addColumnIfMissing(
    db,
    "turns",
    "extraction_stall_attempts",
    "INTEGER NOT NULL DEFAULT 0 CHECK (extraction_stall_attempts >= 0)",
  );
  addColumnIfMissing(db, "turns", "extraction_stall_retry_at_ms", "INTEGER");
  addColumnIfMissing(db, "turns", "extraction_stall_retry_after_seq", "INTEGER");
  addColumnIfMissing(
    db,
    "turns",
    "extraction_stall_retry_mode",
    `TEXT CHECK (
       extraction_stall_retry_mode IS NULL OR
       extraction_stall_retry_mode IN ('resume', 'forceFresh')
     )`,
  );
}

function ensureTurnSignificanceGradeColumn(db: Database): void {
  addColumnIfMissing(
    db,
    "turns",
    "significance_grade",
    "INTEGER CHECK (significance_grade IS NULL OR significance_grade BETWEEN 0 AND 4)",
  );
}

// Structured citation edges (spec §B). The table itself comes from SCHEMA_SQL
// (`CREATE TABLE IF NOT EXISTS`), so an old database gets it on open; only the
// `turns.cites_recorded` flag needs an ALTER. The flag — not a created-at epoch
// — is the "from-absent vs recorded-empty" predicate: a turn created before this
// deployment but extracted after it must still count as recorded, and a turn
// that genuinely cites nothing must be distinguishable from one that predates
// the edge table. Old rows land on 0 (never NULL) → legacy inline fallback.
function ensureTurnCitationsSchema(db: Database): void {
  addColumnIfMissing(db, "turns", "cites_recorded", "INTEGER NOT NULL DEFAULT 0");
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
  db.exec("DROP TABLE IF EXISTS note_debt_cursor");
  db.exec("DROP TABLE IF EXISTS note_debt");
  db.exec("DROP TABLE IF EXISTS observations");
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

  if (shouldRebuildSearchIndex(db)) {
    rebuildSearchIndex(db);
  }

  // NOTE: data repairs that touch the filesystem do NOT belong here. Every hook
  // process opens the database through this function, so anything hosted here
  // is on the hook critical path and runs in as many processes at once as there
  // are hooks. `repair_ledger`-driven repairs (transcript-path-backfill) run in
  // the worker's watchdog tick instead — see src/worker/server.ts.
}
