import type { TurnRecord } from "../db/turns";

/**
 * Ticket 04 (spec "Tools"): the ONE structured filter grammar shared by
 * `recall` and `timeline` — `{type, tag, session, time, file}`, AND-composed
 * with each other, with the id selector, and (recall only) with `query`.
 * Replaces recall's retired in-query prefix dialect (`type:`/`tag:`/`file:`/
 * `session:`/`project:` tokens inside the `query` string) and gives timeline
 * a filter surface it never had. `project` is deliberately absent — it was
 * never part of this grammar (spec "Tools" names exactly five members) and
 * the ticket cuts it along with the rest of the old dialect.
 *
 * The public shape (`memoryFilterShape`, definitions.ts) mirrors this
 * interface field-for-field; kept as a hand-written type rather than a
 * `z.infer` (same precedent as `RecallInput` itself) so this module has no
 * runtime dependency on zod.
 *
 * Ticket 07 (read-write-contract spec, "视图(读面)") adds `fields` — the
 * field-selection vocabulary that replaces the collapsed/expanded two-state
 * field-set switch for a turn render. "Arbitrary combination": any subset,
 * any order, no implied pairing (unlike the old depth switch, which always
 * bundled prompt+title+content together and response+insight+files together).
 */
export const RECALL_TURN_FIELD_NAMES = [
  "title",
  "content",
  "prompt",
  "response",
  "insight",
  "observations",
  "files",
] as const;

export type RecallTurnField = (typeof RECALL_TURN_FIELD_NAMES)[number];

export interface MemoryFilterInput {
  /** Exact match against one stored `type` value (a turn's type array, or a segment's). */
  type?: string;
  /** Exact match against one whole `tags` array element, either namespace — a prefix does not match. */
  tag?: string;
  /** Scope to one session: `"S12"` or bare `"12"`/`12`. */
  session?: string | number;
  /** Same grammar recall has always used: `-7d`/`-2w`, `YYYY-MM-DD`, or `YYYY-MM-DD..YYYY-MM-DD`. */
  time?: string;
  /** Substring match against files_read + files_modified. */
  file?: string;
  /**
   * Ticket 07: which turn fields to render, any combination, replacing the
   * collapsed/expanded field-set switch. Unset falls back to the caller's own
   * depth-driven default. Not a scoping criterion (see `hasFilterCriteria`) —
   * `filter: { fields: [...] }` alone does not force the search/listing path.
   */
  fields?: RecallTurnField[];
}

/** `MemoryFilterInput`, parsed and normalized — every member independently optional. */
export interface ParsedMemoryFilter {
  type?: string;
  tag?: string;
  file?: string;
  sessionId?: number;
  after?: number;
  before?: number;
  fields?: RecallTurnField[];
}

function isRecallTurnField(value: string): value is RecallTurnField {
  return (RECALL_TURN_FIELD_NAMES as readonly string[]).includes(value);
}

/** The grammar an invalid `filter.fields` entry echoes back (spec: "报错回显语法"). */
export function describeRecallTurnFieldGrammar(): string {
  return `expected one of: ${RECALL_TURN_FIELD_NAMES.join(", ")}`;
}

interface ParsedTimeRange {
  after?: number;
  before?: number;
}

export function parseUtcDate(value: string): number | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }

  const epoch = Math.floor(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 1000,
  );

  return Number.isNaN(epoch) ? null : epoch;
}

/**
 * Recall's original time grammar (moved here verbatim, ticket 04: "time
 * reuses recall's existing time grammar"), now the one copy both tools read.
 */
export function parseTimeInput(time: string | undefined): {
  range?: ParsedTimeRange;
  error?: string;
} {
  if (!time) {
    return {};
  }

  const trimmed = time.trim();
  if (!trimmed) {
    return {};
  }

  const rangeMatch = trimmed.match(
    /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/,
  );
  if (rangeMatch) {
    const start = parseUtcDate(rangeMatch[1]!);
    const end = parseUtcDate(rangeMatch[2]!);

    if (start === null || end === null) {
      return { error: `invalid time selector "${time}"` };
    }

    return {
      range: {
        after: start,
        before: end + 86_399,
      },
    };
  }

  const relativeMatch = trimmed.match(/^-([0-9]+)([dw])$/);
  if (relativeMatch) {
    const amount = Number(relativeMatch[1]);
    const unit = relativeMatch[2];
    const secondsPerUnit = unit === "d" ? 86_400 : 7 * 86_400;

    return {
      range: {
        after: Math.floor(Date.now() / 1000) - amount * secondsPerUnit,
      },
    };
  }

  const dateEpoch = parseUtcDate(trimmed);
  if (dateEpoch !== null) {
    return {
      range: {
        after: dateEpoch,
        before: dateEpoch + 86_399,
      },
    };
  }

  return { error: `invalid time selector "${time}"` };
}

/**
 * Accepts `"S12"` (the form a reader sees in output) and a bare `"12"`/`12`
 * (the form a caller composing a filter object is just as likely to reach
 * for) — same liberal parse the old in-query `session:` token used.
 */
function parseSessionFilter(
  value: string | number | undefined,
): { sessionId?: number; error?: string } {
  if (value === undefined) {
    return {};
  }

  const raw = typeof value === "number" ? String(value) : value.trim().replace(/^[Ss]/, "");
  const sessionId = Number(raw);
  if (Number.isInteger(sessionId) && sessionId > 0) {
    return { sessionId };
  }

  return { error: `invalid filter.session "${value}"` };
}

/**
 * Parses the shared filter object into the normalized form every consumer
 * (recall's id/query routes, timeline's window) reads. An empty/absent
 * `filter` parses to `{}` — no criteria, nothing to AND-compose.
 */
export function parseMemoryFilter(
  filter: MemoryFilterInput | undefined,
): { parsed: ParsedMemoryFilter; error?: string } {
  const parsed: ParsedMemoryFilter = {};
  if (!filter) {
    return { parsed };
  }

  if (filter.type) {
    parsed.type = filter.type;
  }
  if (filter.tag) {
    parsed.tag = filter.tag;
  }
  if (filter.file) {
    parsed.file = filter.file;
  }

  if (filter.session !== undefined) {
    const { sessionId, error } = parseSessionFilter(filter.session);
    if (error) {
      return { parsed, error };
    }
    parsed.sessionId = sessionId;
  }

  if (filter.time !== undefined) {
    const { range, error } = parseTimeInput(filter.time);
    if (error) {
      return { parsed, error };
    }
    parsed.after = range?.after;
    parsed.before = range?.before;
  }

  if (filter.fields !== undefined) {
    if (filter.fields.length === 0) {
      return { parsed, error: `filter.fields must not be empty — ${describeRecallTurnFieldGrammar()}` };
    }
    const invalid = filter.fields.filter((field) => !isRecallTurnField(field));
    if (invalid.length > 0) {
      return {
        parsed,
        error: `invalid filter.fields entry "${invalid[0]}" — ${describeRecallTurnFieldGrammar()}`,
      };
    }
    parsed.fields = filter.fields as RecallTurnField[];
  }

  return { parsed };
}

/**
 * True when at least one SCOPING filter member is set — an all-empty filter
 * AND-composes to a no-op. `fields` is deliberately excluded (spec: it is a
 * rendering directive, not a scope-narrowing one) — `filter: { fields: [...] }`
 * alone must not force bare `recall()` into the search/listing path.
 */
export function hasFilterCriteria(filter: ParsedMemoryFilter): boolean {
  return (
    filter.type !== undefined ||
    filter.tag !== undefined ||
    filter.file !== undefined ||
    filter.sessionId !== undefined ||
    filter.after !== undefined ||
    filter.before !== undefined
  );
}

/**
 * The same subset semantics recall and timeline both apply to a turn (spec
 * "Tools": "Semantics identical across both tools"). `type`/`tag` are exact
 * array-element matches (mirrors db/search.ts's `json_each` EXISTS clauses);
 * `file` is a substring match over files_read+files_modified; `session` and
 * `time` compare directly against the turn's own columns.
 */
export function turnMatchesFilter(
  turn: TurnRecord,
  filter: ParsedMemoryFilter,
): boolean {
  if (filter.type !== undefined && !turn.type.includes(filter.type)) {
    return false;
  }
  if (filter.tag !== undefined && !turn.tags.includes(filter.tag)) {
    return false;
  }
  if (filter.sessionId !== undefined && turn.sessionId !== filter.sessionId) {
    return false;
  }
  if (filter.file !== undefined) {
    const hit =
      turn.filesRead.some((path) => path.includes(filter.file!)) ||
      turn.filesModified.some((path) => path.includes(filter.file!));
    if (!hit) {
      return false;
    }
  }
  if (filter.after !== undefined && turn.createdAtEpoch < filter.after) {
    return false;
  }
  if (filter.before !== undefined && turn.createdAtEpoch > filter.before) {
    return false;
  }
  return true;
}
