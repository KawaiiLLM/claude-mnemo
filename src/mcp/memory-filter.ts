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
  // The dissolved turn table's audit columns, as one selectable field (spec
  // 金样例 补充, "turns 表溶解"): local time, gap from the previous turn, tool
  // and file counts. Selectable like any other field, so it is a member of
  // this vocabulary rather than a view-only switch — `recall` leaves it out of
  // its default set, `timeline`'s turn view includes it.
  "metadata",
  // Edge-read-surface spec, ticket 01: a turn's own tagged edge set, BOTH
  // directions — `→ <word> T<n> {tag+tag}` outbound, `← <word> from T<n>
  // {tag+tag}` inbound — so a writer can self-verify an edge it just wrote
  // (the read surface used to render neither the relation word nor its
  // tags anywhere). OFF by default (absent from `DEFAULT_TURN_RENDER_FIELDS`
  // and `DEFAULT_BROWSE_FIELDS` alike), so selecting it is deliberate — and as
  // of the peer round's P1-8 it is also LICENSING: a relation write must be
  // authorized by a render that showed the current set, so this is the field
  // selection that earns it (`GATED_TURN_FIELDS` in format.ts now includes it;
  // `db/write-gate.ts`'s `checkRelationsGate` is what consumes the record).
  "relations",
] as const;

export type RecallTurnField = (typeof RECALL_TURN_FIELD_NAMES)[number];

/**
 * `fieldBudgets`-ELIGIBLE fields (ticket 13, implementation-review P2 sweep
 * item 3) — `RECALL_TURN_FIELD_NAMES` minus the two whose renderer never
 * reads a `fieldBudgets` entry at all: `files` (`renderFileTree`,
 * shared/file-tree.ts, renders the whole tree — no per-field cut point to
 * hand a budget to) and `observations` (`renderTurnChildren`'s nested
 * child-node recursion, mcp/format.ts — a set of child renders, not one text
 * field `cutFieldText`/`cutFieldLines` can trim). Naming either in
 * `fieldBudgets` used to parse and then silently do nothing, contradicting
 * this field's own promise ("one mechanism covering both of this codebase's
 * truncation paths").
 *
 * `title` is the one field left OUT of this exclusion and it stays admitted
 * — that is a real, reviewed, DOCUMENTED no-op rather than an unread key:
 * `format.ts`'s `recordTurnFieldCompleteness` doc explains why
 * (`capRenderToTokenBudget` never drops line 0, so a budget on `title` is a
 * structural guarantee already satisfied, not silently ignored).
 */
export const FIELD_BUDGET_ELIGIBLE_FIELD_NAMES = RECALL_TURN_FIELD_NAMES.filter(
  (field): field is Exclude<RecallTurnField, "files" | "observations"> =>
    field !== "files" && field !== "observations",
);

export type FieldBudgetEligibleField = (typeof FIELD_BUDGET_ELIGIBLE_FIELD_NAMES)[number];

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
   * Ticket 07/11: which turn fields to render, any combination — the SOLE
   * field-selection mechanism (the collapsed/expanded depth switch it
   * replaced has fully retired, ticket 11). Unset falls back to
   * `format.ts`'s `DEFAULT_TURN_RENDER_FIELDS` — title + metadata + content
   * since edge-mechanism-revision ticket 12 restored the golden sample's own
   * default card. Not a
   * scoping criterion (see `hasFilterCriteria`) — `filter: { fields: [...] }`
   * alone does not force the search/listing path.
   */
  fields?: RecallTurnField[];
  /**
   * Ticket 11 (per-field recall budgets, USER RULING S15069/T2106): an
   * optional per-field TOKEN cap, keyed by a `fields` name — one mechanism
   * covering both of this codebase's truncation paths (the browse feed's
   * per-field equal split and the addressed render's whole-block line
   * ladder), so a caller can say "content complete, prompt only its first 50
   * tokens" exactly instead of approximating with field order. A field NOT
   * named here keeps its unchanged default behavior; no `fieldBudgets` at
   * all is byte-identical to before this ticket. The public ceiling on each
   * value (`MAX_TURN_BUDGET`) lives on the zod schema (`definitions.ts`),
   * same as `turn`'s own ceiling — this interface stays zod-free.
   *
   * Keyed by `FieldBudgetEligibleField`, NOT the full `RecallTurnField`
   * (ticket 13, P2 sweep item 3): `files`/`observations` are excluded at the
   * type level too, so a caller building this object in TypeScript gets the
   * same refusal `parseMemoryFilter` enforces at runtime, one level earlier.
   */
  fieldBudgets?: Partial<Record<FieldBudgetEligibleField, number>>;
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
  /** Same `FieldBudgetEligibleField` narrowing as `MemoryFilterInput.fieldBudgets` above. */
  fieldBudgets?: Partial<Record<FieldBudgetEligibleField, number>>;
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

  // Ticket 11: same shape of defense-in-depth validation `fields` above
  // gets — the zod schema (definitions.ts) is the public gate, but this is
  // the one shared runtime parser both `recall` and `timeline` call, so a
  // bad key/value never silently reaches a renderer either way. The public
  // `≤ MAX_TURN_BUDGET` ceiling is left to the zod schema alone (this module
  // stays zod-free, same precedent `turn`/`pageBudget` already set — neither
  // is part of `MemoryFilterInput` at all).
  if (filter.fieldBudgets !== undefined) {
    for (const [field, budget] of Object.entries(filter.fieldBudgets)) {
      // Ticket 13 (P2 sweep item 3): `files`/`observations` are refused
      // HERE, naming the reason, rather than falling through to the generic
      // "not a valid field" message below — that message would be actively
      // misleading, since both ARE valid `filter.fields` names; what they
      // lack is a renderer that reads a `fieldBudgets` entry at all. Checked
      // before `isRecallTurnField` so the reason always wins over the
      // generic grammar echo for these two specific keys.
      if (field === "files" || field === "observations") {
        return {
          parsed,
          error:
            `invalid filter.fieldBudgets entry "${field}" — its renderer never reads a per-field ` +
            `budget (${field === "files" ? "renderFileTree renders the whole tree" : "observations render as nested child turns"}), ` +
            "so naming it here would silently do nothing. Drop it; the shared `turn` budget still applies.",
        };
      }
      if (!isRecallTurnField(field)) {
        return {
          parsed,
          error: `invalid filter.fieldBudgets entry "${field}" — ${describeRecallTurnFieldGrammar()}`,
        };
      }
      if (!Number.isInteger(budget) || (budget as number) <= 0) {
        return {
          parsed,
          error: `invalid filter.fieldBudgets["${field}"] — must be a positive integer token budget, got ${budget}`,
        };
      }
    }
    parsed.fieldBudgets = filter.fieldBudgets as Partial<Record<FieldBudgetEligibleField, number>>;
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
