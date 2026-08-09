import type { Database } from "bun:sqlite";

/**
 * `turns.consulted_memories` (spec D4): which stored records a turn's own
 * retrieval calls actually reached.
 *
 * This is the mechanical half of the retrieval edge source (spec D7): the main
 * agent never writes an edge, but "this turn read that record" is a fact the
 * system can observe without asking anyone. Recording it at capture time is
 * what makes the settlement pass's `retrieval` provenance derivable later,
 * instead of reconstructed from prose.
 *
 * Strength has exactly two levels, and the line between them is how much of the
 * record reached the model:
 *
 *   - `weak`  — the record appeared in a result list (a collapsed recall hit).
 *     It was retrieved, but a one-line summary is thin evidence of use.
 *   - `strong` — the record was read at expanded or raw level: the caller named
 *     it in the selector, asked for `depth: expanded`, or pulled the turn's
 *     full text through the replay CLI.
 *
 * Ids are stored with a TYPE PREFIX (`turn:8942`, `session:15069`, `obs:77`)
 * because the column mixes granularities; a bare number would be ambiguous the
 * moment a second layer joins.
 */

export type ConsultedStrength = "weak" | "strong";

export interface ConsultedMemory {
  /** Type-prefixed global id: `turn:<id>`, `session:<id>`, `obs:<id>`. */
  ref: string;
  strength: ConsultedStrength;
}

export type ConsultedAddress =
  | { kind: "turn"; sessionId: number; promptNumber: number; strength: ConsultedStrength }
  | { kind: "session"; sessionId: number; strength: ConsultedStrength }
  | { kind: "observation"; observationId: number; strength: ConsultedStrength };

export interface ToolCallSnapshot {
  toolName: string;
  toolInput: string | null;
  toolResult: string | null;
}

// Recall/timeline render and accept the same qualified grammar, so one scanner
// serves both directions: `S15069`, `S15069/T332`, `S15069/T332/O77`.
const ADDRESS_PATTERN = /S(\d+)(?:\s*\/\s*T(\d+)(?:\s*\/\s*O(\d+))?)?/g;

// The replay skill is a bash call, not an MCP tool: `turn-detail.sh S12 3`.
// Matching it here is what keeps raw-level reads from being invisible to the
// retrieval signal just because they go through a different transport.
const REPLAY_COMMAND_PATTERN = /turn-detail\.sh[^\n]*?\bS(\d+)\s+(\d+)/g;

const RETRIEVAL_TOOL_PATTERN =
  /^mcp__(?:[A-Za-z0-9_-]*_)?mnemo__(?:recall|timeline)$/;

function isRetrievalToolName(toolName: string): boolean {
  return RETRIEVAL_TOOL_PATTERN.test(toolName);
}

function parseId(digits: string | undefined): number | null {
  if (digits === undefined) {
    return null;
  }
  const value = Number.parseInt(digits, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function scanAddresses(
  text: string | null,
  strength: ConsultedStrength,
): ConsultedAddress[] {
  if (!text) {
    return [];
  }

  const addresses: ConsultedAddress[] = [];
  ADDRESS_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ADDRESS_PATTERN.exec(text)) !== null) {
    const sessionId = parseId(match[1]);
    if (sessionId === null) {
      continue;
    }
    const promptNumber = parseId(match[2]);
    const observationId = parseId(match[3]);

    if (observationId !== null) {
      addresses.push({ kind: "observation", observationId, strength });
      continue;
    }
    if (promptNumber !== null) {
      addresses.push({ kind: "turn", sessionId, promptNumber, strength });
      continue;
    }
    addresses.push({ kind: "session", sessionId, strength });
  }

  return addresses;
}

function isExpandedRead(toolInput: string | null): boolean {
  return toolInput !== null && /"depth"\s*:\s*"expanded"/.test(toolInput);
}

/**
 * Derive what a single tool call consulted. Pure: no database, no resolution —
 * the caller decides whether to persist, so this stays testable against literal
 * payloads and cannot become a second write path.
 *
 * Addresses named in the tool INPUT are strong: asking for a record by name is
 * a deliberate read, not a list impression. Addresses that only appear in the
 * OUTPUT are weak unless the whole call was an expanded read.
 */
export function deriveConsultedAddresses(
  call: ToolCallSnapshot,
): ConsultedAddress[] {
  if (!call.toolName) {
    return [];
  }

  if (isRetrievalToolName(call.toolName)) {
    const resultStrength: ConsultedStrength = isExpandedRead(call.toolInput)
      ? "strong"
      : "weak";
    return [
      ...scanAddresses(call.toolInput, "strong"),
      ...scanAddresses(call.toolResult, resultStrength),
    ];
  }

  // Anything else only counts when it is a replay read, and only through the
  // bundled CLI — a hand-written sqlite3 query is not mechanically recognizable
  // and is deliberately left unrecorded rather than guessed at.
  const command = call.toolInput;
  if (!command) {
    return [];
  }

  const addresses: ConsultedAddress[] = [];
  REPLAY_COMMAND_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REPLAY_COMMAND_PATTERN.exec(command)) !== null) {
    const sessionId = parseId(match[1]);
    const promptNumber = parseId(match[2]);
    if (sessionId === null || promptNumber === null) {
      continue;
    }
    addresses.push({ kind: "turn", sessionId, promptNumber, strength: "strong" });
  }

  return addresses;
}

function parseConsultedColumn(value: string | null): ConsultedMemory[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (entry): entry is ConsultedMemory =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as ConsultedMemory).ref === "string" &&
        ((entry as ConsultedMemory).strength === "weak" ||
          (entry as ConsultedMemory).strength === "strong"),
    );
  } catch {
    return [];
  }
}

export function getConsultedMemories(
  db: Database,
  turnId: number,
): ConsultedMemory[] {
  const row = db
    .query<{ consultedMemories: string | null }, [number]>(
      "SELECT consulted_memories AS consultedMemories FROM turns WHERE id = ?",
    )
    .get(turnId);
  return parseConsultedColumn(row?.consultedMemories ?? null);
}

/**
 * Resolve addresses to type-prefixed ids and merge them into the turn's record.
 *
 * Merge, not replace: a turn makes many retrieval calls and each one only knows
 * its own hits. Strength only ever goes UP — a later collapsed list containing
 * a turn the agent already read in full does not downgrade that read.
 *
 * Unresolvable addresses are dropped silently. Unlike a citation (where a
 * dangling id is a claim about something that does not exist), this is an
 * observation of a text stream that may legitimately mention a foreign or
 * deleted id.
 */
export function recordConsultedMemories(
  db: Database,
  turnId: number,
  addresses: readonly ConsultedAddress[],
): ConsultedMemory[] {
  if (addresses.length === 0) {
    return getConsultedMemories(db, turnId);
  }

  const merged = new Map<string, ConsultedStrength>();
  for (const entry of getConsultedMemories(db, turnId)) {
    merged.set(entry.ref, entry.strength);
  }

  const turnLookup = db.query<{ id: number }, [number, number]>(
    "SELECT id FROM turns WHERE session_id = ? AND prompt_number = ?",
  );
  const sessionLookup = db.query<{ id: number }, [number]>(
    "SELECT id FROM sessions WHERE id = ?",
  );
  const observationLookup = db.query<{ id: number }, [number]>(
    "SELECT id FROM observations WHERE id = ?",
  );

  let changed = false;
  const remember = (ref: string, strength: ConsultedStrength): void => {
    const current = merged.get(ref);
    if (current === strength || current === "strong") {
      return;
    }
    merged.set(ref, strength);
    changed = true;
  };

  for (const address of addresses) {
    if (address.kind === "turn") {
      const row = turnLookup.get(address.sessionId, address.promptNumber);
      // A turn does not consult itself: reading one's own coordinates back out
      // of a recall result is not retrieval provenance.
      if (row && row.id !== turnId) {
        remember(`turn:${row.id}`, address.strength);
      }
      continue;
    }
    if (address.kind === "session") {
      const row = sessionLookup.get(address.sessionId);
      if (row) {
        remember(`session:${row.id}`, address.strength);
      }
      continue;
    }
    const row = observationLookup.get(address.observationId);
    if (row) {
      remember(`obs:${row.id}`, address.strength);
    }
  }

  const result: ConsultedMemory[] = [...merged.entries()]
    .map(([ref, strength]) => ({ ref, strength }))
    .sort((left, right) => left.ref.localeCompare(right.ref));

  if (changed) {
    // `updated_at_epoch` is deliberately left alone: it is the extraction
    // pipeline's "this turn's content moved" clock (the diary staleness check
    // keys on it), and reading memory is not editing the turn.
    db.query<unknown, [string, number]>(
      "UPDATE turns SET consulted_memories = ? WHERE id = ?",
    ).run(JSON.stringify(result), turnId);
  }

  return result;
}

/** Capture one tool call's consultations. Returns how many refs are recorded. */
export function captureConsultedMemories(
  db: Database,
  turnId: number,
  call: ToolCallSnapshot,
): number {
  const addresses = deriveConsultedAddresses(call);
  if (addresses.length === 0) {
    return 0;
  }
  return recordConsultedMemories(db, turnId, addresses).length;
}
