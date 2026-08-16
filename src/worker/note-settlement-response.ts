import { isCitationRelation, type CitationRelation } from "../db/citations";
import { SEGMENT_STATUSES, type SegmentStatus } from "../db/segments";
import { isMemoryType, MEMORY_TYPES } from "../shared/type-vocabulary";

/**
 * The settlement call's structured output (spec D9: "Sonnet 输出走结构化 schema").
 *
 * Parsing is ALL-OR-NOTHING on purpose. A window is one judgement — which turns
 * form which chapter, and what each chapter concluded — so half of it is not a
 * smaller version of it, it is a different and wrong answer. A malformed reply
 * therefore fails the whole batch and the job machinery retries the window
 * intact, rather than committing whichever fragments happened to parse.
 */

export interface SettlementSegmentDirective {
  action: "create" | "extend";
  /** extend only. */
  segmentId: number | null;
  /** extend only: the revision the body was composed against (CAS input). */
  expectedRevision: number | null;
  /** create only. */
  topic: string | null;
  topicAliases: string[];
  /** create only: why nothing existing fitted (anti-fragmentation, D9). */
  noCandidateReason: string | null;
  title: string;
  content: string;
  type: string[];
  tags: string[];
  status: SegmentStatus;
  /** `S<session>/T<prompt>` member addresses, unresolved. */
  members: string[];
}

export interface SettlementEdgeDirective {
  citing: string;
  cited: string;
  relation: CitationRelation;
}

export interface SettlementNoteDirective {
  turn: string;
  title: string;
  content: string;
  insight: string | null;
}

/**
 * One turn's review verdict (spec D3, ticket 05): grade, type and tag
 * together, keyed by address. Separate from `SettlementNoteDirective` on
 * purpose — notes cover only the turns needing backfill, review covers every
 * turn in the window, including ones that already have a note.
 *
 * `grade` is REQUIRED, matching the retired resident agent's own rubric
 * ("grade: REQUIRED integer 0-4") — the model states a verdict for every turn
 * it reviews, confirming or correcting, never leaving the field ambiguous
 * between "unchanged" and "omitted". `type` is multi-valued (spec B5); `[]`
 * is an explicit "none fit" (spec B7), never "leave alone" — this schema has
 * no way to say "leave alone" for a field it is reviewing, by design.
 *
 * `tags` (ticket 10a): grown from a single nullable `tag` to a full list, in
 * the same change that deletes `mergeTags` (db/turns.ts) and the turn update
 * input's additive `tags` parameter. A writer that can only state one value
 * cannot be asked to state a set (spec D5a) — this directive now can, so the
 * write-back's consumption of it overwrites whole, same rule as every other
 * public write's `tags`. `[]` clears, same convention as `type`.
 */
export interface SettlementTurnReviewDirective {
  turn: string;
  grade: number;
  type: string[];
  /** Bare topic words — no `topic:` prefix is applied (spec B6); `[]` clears. */
  tags: string[];
}

export interface SettlementSessionSummary {
  title: string;
  content: string;
  decision: string;
  done: string;
  current: string;
  nextSteps: string;
  reference: string;
}

export interface NoteSettlementResponse {
  segments: SettlementSegmentDirective[];
  edges: SettlementEdgeDirective[];
  reconstructedNotes: SettlementNoteDirective[];
  turnReview: SettlementTurnReviewDirective[];
  sessionSummary: SettlementSessionSummary | null;
}

export type ParseNoteSettlementResponseResult =
  | { ok: true; response: NoteSettlementResponse }
  | { ok: false; reason: string };

class MalformedResponse extends Error {}

function fail(message: string): never {
  throw new MalformedResponse(message);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, what: string): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    fail(`${what} is not an array`);
  }
  return value;
}

function asString(value: unknown, what: string): string {
  if (typeof value !== "string") {
    fail(`${what} is not a string`);
  }
  return value;
}

function asOptionalString(value: unknown, what: string): string {
  return value === undefined || value === null ? "" : asString(value, what);
}

function asNonEmptyString(value: unknown, what: string): string {
  const text = asString(value, what).trim();
  if (text.length === 0) {
    fail(`${what} is empty`);
  }
  return text;
}

function asStringArray(value: unknown, what: string): string[] {
  return asArray(value, what).map((item, index) =>
    asNonEmptyString(item, `${what}[${index}]`),
  );
}

/**
 * The type vocabulary is closed (spec D5). A word outside it is a schema
 * violation, not a value to drop quietly: dropping it would make a `type:`
 * filter silently lossy, and writing it would throw halfway through the
 * write-back transaction. Rejecting the batch keeps the failure in one place.
 */
function asTypeArray(value: unknown, what: string): string[] {
  const values = asStringArray(value, what);
  for (const entry of values) {
    if (!isMemoryType(entry)) {
      fail(
        `${what} contains "${entry}", which is not one of ${MEMORY_TYPES.join(", ")}`,
      );
    }
  }
  return values;
}

/**
 * A turn-review grade: integer 0-4 (spec's task-causality scale). Out of
 * range is a schema violation, not a value to clamp — clamping would let a
 * model's miscalibrated 5 or -1 silently become a 4 or 0, which is exactly
 * the kind of drift D13's histogram exists to catch, not paper over.
 */
function asGrade(value: unknown, what: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 4
  ) {
    fail(`${what} is not an integer 0-4`);
  }
  return value;
}

function asPositiveInteger(value: unknown, what: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    fail(`${what} is not a positive integer`);
  }
  return value;
}

function asNonNegativeInteger(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(`${what} is not a non-negative integer`);
  }
  return value;
}

/**
 * Pull the JSON object out of a reply.
 *
 * The prompt asks for a bare object, but a model that wraps it in a fence or
 * adds a sentence is answering the question — recovering the outermost braces is
 * a formatting allowance, not a content salvage. Anything that still fails to
 * parse is malformed and fails the batch.
 */
function extractJsonObject(raw: string): unknown {
  const text = raw.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    fail("reply contains no JSON object");
  }
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch (error) {
    fail(
      `reply is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function parseSegment(
  value: unknown,
  index: number,
): SettlementSegmentDirective {
  const what = `segments[${index}]`;
  const record = asRecord(value, what);
  const action = asString(record.action, `${what}.action`);
  if (action !== "create" && action !== "extend") {
    fail(`${what}.action is neither "create" nor "extend"`);
  }

  const statusRaw = record.status === undefined ? "open" : record.status;
  const status = asString(statusRaw, `${what}.status`);
  if (!(SEGMENT_STATUSES as readonly string[]).includes(status)) {
    fail(`${what}.status "${status}" is not a segment status`);
  }

  const directive: SettlementSegmentDirective = {
    action,
    segmentId: null,
    expectedRevision: null,
    topic: null,
    topicAliases: asStringArray(record.topic_aliases, `${what}.topic_aliases`),
    noCandidateReason: null,
    title: asNonEmptyString(record.title, `${what}.title`),
    content: asOptionalString(record.content, `${what}.content`),
    type: asTypeArray(record.type, `${what}.type`),
    tags: asStringArray(record.tags, `${what}.tags`),
    status: status as SegmentStatus,
    members: asStringArray(record.members, `${what}.members`),
  };

  if (action === "extend") {
    directive.segmentId = asPositiveInteger(
      record.segment_id,
      `${what}.segment_id`,
    );
    directive.expectedRevision = asNonNegativeInteger(
      record.expected_revision,
      `${what}.expected_revision`,
    );
    return directive;
  }

  // A create without a stated reason is exactly the fragmentation the
  // search-before-mint rule exists to stop, so it is malformed rather than
  // silently accepted (spec D9's 防碎裂三纪律).
  directive.noCandidateReason = asNonEmptyString(
    record.no_candidate_reason,
    `${what}.no_candidate_reason`,
  );
  directive.topic =
    record.topic === undefined || record.topic === null
      ? null
      : asNonEmptyString(record.topic, `${what}.topic`);
  return directive;
}

function parseEdge(value: unknown, index: number): SettlementEdgeDirective {
  const what = `edges[${index}]`;
  const record = asRecord(value, what);
  const relation = asString(record.relation, `${what}.relation`);
  if (!isCitationRelation(relation)) {
    fail(`${what}.relation "${relation}" is not a citation relation`);
  }
  return {
    citing: asNonEmptyString(record.citing, `${what}.citing`),
    cited: asNonEmptyString(record.cited, `${what}.cited`),
    relation,
  };
}

function parseNote(value: unknown, index: number): SettlementNoteDirective {
  const what = `reconstructed_notes[${index}]`;
  const record = asRecord(value, what);
  const insight = asOptionalString(record.insight, `${what}.insight`);
  return {
    turn: asNonEmptyString(record.turn, `${what}.turn`),
    title: asNonEmptyString(record.title, `${what}.title`),
    content: asNonEmptyString(record.content, `${what}.content`),
    insight: insight.trim().length === 0 ? null : insight,
  };
}

function parseTurnReview(
  value: unknown,
  index: number,
): SettlementTurnReviewDirective {
  const what = `turn_review[${index}]`;
  const record = asRecord(value, what);
  // An OMITTED field is a schema violation; only an explicit `[]` clears. The
  // two used to be the same, which meant a model that answered
  // `{"turn": …, "grade": 2}` — lazily, or because its output was truncated
  // mid-array — silently wiped the type and topic tags off every turn it
  // touched, up to a whole window plus its lookback. Failing loudly costs a
  // retry; the alternative cost real facts, invisibly. `[]` still means
  // clear, so the expressiveness this schema was built for survives.
  for (const field of ["type", "tags"] as const) {
    if (!(field in record)) {
      fail(`${what}.${field} is missing (use [] to clear it)`);
    }
  }
  return {
    turn: asNonEmptyString(record.turn, `${what}.turn`),
    grade: asGrade(record.grade, `${what}.grade`),
    // `[]` clears both — spec B7's "none fit"/"no tags", never a guess.
    type: asTypeArray(record.type, `${what}.type`),
    tags: asStringArray(record.tags, `${what}.tags`),
  };
}

function parseSessionSummary(value: unknown): SettlementSessionSummary | null {
  if (value === undefined || value === null) {
    return null;
  }
  const record = asRecord(value, "session_summary");
  return {
    title: asOptionalString(record.title, "session_summary.title"),
    content: asOptionalString(record.content, "session_summary.content"),
    decision: asOptionalString(record.decision, "session_summary.decision"),
    done: asOptionalString(record.done, "session_summary.done"),
    current: asOptionalString(record.current, "session_summary.current"),
    nextSteps: asOptionalString(
      record.next_steps,
      "session_summary.next_steps",
    ),
    reference: asOptionalString(record.reference, "session_summary.reference"),
  };
}

export function parseNoteSettlementResponse(
  raw: string,
): ParseNoteSettlementResponseResult {
  try {
    const root = asRecord(extractJsonObject(raw), "reply");
    return {
      ok: true,
      response: {
        segments: asArray(root.segments, "segments").map(parseSegment),
        edges: asArray(root.edges, "edges").map(parseEdge),
        reconstructedNotes: asArray(
          root.reconstructed_notes,
          "reconstructed_notes",
        ).map(parseNote),
        turnReview: asArray(root.turn_review, "turn_review").map(
          parseTurnReview,
        ),
        sessionSummary: parseSessionSummary(root.session_summary),
      },
    };
  } catch (error) {
    if (error instanceof MalformedResponse) {
      return { ok: false, reason: `settlement output rejected: ${error.message}` };
    }
    throw error;
  }
}
