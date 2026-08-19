import { renderFileTree } from "../shared/file-tree";
import { estimateTokens } from "../utils/token-estimate";
import { projectToolCall, type ProjectedCall } from "./tool-projection";
import type { RecallTurnField } from "./memory-filter";

/**
 * One mark for a cut field, on every read surface. This renderer ended a cut
 * with "..." while the timeline ended it with "…", so the same session read
 * differently depending on which view produced the line.
 *
 * The single character wins. It is already what every other renderer here
 * emits — the timeline's segment spine and its token-level trimmer, the
 * session-state pointer, the note reminder's prompt prefix, the replay CLI — so
 * the three-dot form could only have won by changing all of them, or by leaving
 * two marks inside one rendered response. It also costs two fewer characters of
 * a budget that exists precisely because the text did not fit: the timeline
 * measures hard per-unit token caps on the rendered line.
 */
const FIELD_TRUNCATION_SUFFIX = "…";
export const DEFAULT_PREVIEW_COUNT = 5;

/**
 * Ticket 11 (read-write-contract spec, "视图(读面)"): the ONE remaining
 * item-level size knob — every rendered session/turn/observation block is
 * capped to this many tokens unless a caller's explicit `turn` input
 * overrides it. Replaces the retired `truncate`/`truncateCap` character
 * parameters AND the retired `depth`-gated "expanded is uncapped" default —
 * there is no more uncapped state; a budget always applies (spec: "obs 恒截
 * 断，由 turn 预算驱动" generalizes to every node kind, not observations
 * alone). Sized to the pre-ticket-11 "collapsed" card-scale default so a
 * caller who never touches `turn` sees byte-similar output to before.
 */
export const DEFAULT_TURN_TOKEN_BUDGET = 150;

/** The marker a token-budget-capped block ends with. */
const TURN_BUDGET_TRUNCATION_MARKER = "  … truncated to fit the per-item token budget";

/**
 * Ticket 07 (read-write-contract spec): the rewind marker on a `was_rolled_back`
 * turn — its raw-transcript coordinate (the DB's `transcript_line_start` /
 * `jsonlPath`) is stale and the replay skill must not trust it (spec: "rewind
 * 撤销后 transcript 指针视为失效坐标"). Renderers no longer carry that
 * coordinate at all ([S15069/T1020]); this marker is the surviving read-side
 * warning. No period at the end — it rides mid-line, next to the bracketed
 * ids, same convention `formatStatus` already uses.
 */
export const REWIND_MARKER = " ⤺ rewound (transcript pointer stale — do not trust replay)";

/**
 * Render-scoped "did anything get cut" flag (spec D1). Discoverability — "you
 * can read the full text, and here is how" — is a property of the WHOLE
 * response, not of each truncated field, so it is recorded once per response
 * instead of re-derived per field. Created by the entry point (`recallMemory`,
 * `timelineQuery`) and threaded down through render options; a caller that
 * omits it simply gets no legend, which is what every direct `formatX` call
 * outside those two entry points wants.
 *
 * Deliberately NOT inferred by scanning the rendered string for the truncation
 * mark: user content (a prompt, a title) can itself contain an ellipsis, and a
 * scan would misread that as a truncation this renderer performed.
 */
export interface TruncationSignal {
  truncated: boolean;
}

export function createTruncationSignal(): TruncationSignal {
  return { truncated: false };
}

function markTruncated(signal?: TruncationSignal): void {
  if (signal) {
    signal.truncated = true;
  }
}

/**
 * The one navigation notice for a whole rendered response (spec D1), said once
 * instead of once per field. It covers all three things a reader needs to keep
 * digging: truncated fields are readable in full, the bracketed ids already on
 * each line are what addresses them, and hidden turn counts (timeline's folded
 * day groups) are reachable with `timeline(..., view="turns")`.
 *
 * It deliberately does NOT spell out an id format. An earlier wording promised
 * `[S<n>/T<n>]`, a form this renderer never emits — turn lines carry
 * `[S<n>][T<n>]`. A legend that names a shape has to be re-checked against the
 * renderer every time a label changes; pointing at "the ids on that line"
 * cannot go stale.
 * Appended only when `TruncationSignal.truncated` is set — a response with
 * nothing cut gets no legend.
 */
export const NAVIGATION_LEGEND =
  'Legend: text ending in an ellipsis was truncated — read it in full with the mnemo-replay skill, addressing it by the bracketed ids on that line; a "+N more" count is reachable with timeline(id="S<n>", view="turns").';

export function appendNavigationLegend(
  output: string,
  signal: TruncationSignal,
): string {
  if (!signal.truncated) {
    return output;
  }

  return output ? `${output}\n\n${NAVIGATION_LEGEND}` : NAVIGATION_LEGEND;
}

export interface FormattedObservation {
  id: number;
  title: string;
  content?: string | null;
  /**
   * Mechanical fields (spec D11: the O layer renders tool name + input prefix +
   * result prefix). In the segment era nothing summarizes an observation any
   * more — the LLM obs pipeline is gone — so what a tool call DID has to come
   * off the call itself. All three are era-gated together (spec D5): a legacy
   * row's record is the extractor's summary, and giving it raw tool fields
   * would change what an old rendering says. `toolName` is present here only
   * for era rows, where the label has already fallen back to it — which is
   * exactly the case the `tool:` dedup below has to catch.
   */
  toolName?: string | null;
  toolInput?: string | null;
  toolResult?: string | null;
}

export interface FormattedToolCall {
  name: string;
  keyParam?: string | null;
  input?: unknown;
  result?: string | null;
}

export interface FormattedTurn {
  id: number;
  promptNumber: number;
  title: string | null;
  createdAtEpoch?: number | null;
  content?: string | null;
  observationCount?: number | null;
  toolCallCount?: number | null;
  filesReadCount?: number | null;
  filesModifiedCount?: number | null;
  status?: string | null;
  promptPreview?: string | null;
  responsePreview?: string | null;
  insight?: string[];
  filesRead?: string[];
  filesModified?: string[];
  observations?: FormattedObservation[];
  toolCalls?: FormattedToolCall[];
  /**
   * Ticket 07 (read-write-contract spec: "rewind turn 渲染带标记; transcript
   * 指针失效"). Undefined/false renders nothing — every pre-existing caller
   * that never populates this field is byte-identical to before this ticket.
   */
  wasRolledBack?: boolean;
}

export interface FormattedSession {
  id: number;
  title: string | null;
  project: string;
  createdAtEpoch: number;
  content?: string | null;
  turnCount?: number | null;
  observationCount?: number | null;
  jsonlPath?: string;
  turns?: FormattedTurn[];
}

/**
 * Ticket 11: the ONE options bag shared by every render function in this
 * module. Before this ticket, four near-identical `*FormatOptions`
 * interfaces existed (session/turn/observation/toolCall) whose only real
 * differences were which of `truncate`/`truncateCap`/`depth` a given node
 * kind happened to read — with both retired, nothing remains to
 * differentiate them, so they collapse into one shape rather than four
 * shapes that agree on every surviving field.
 */
export interface RenderNodeOptions {
  indent?: string;
  sessionId?: number;
  turnPromptNumber?: number;
  /** Worker-only: append a `dbid:T<dbid>` token to a turn label. */
  includeDbTurnIds?: boolean;
  signal?: TruncationSignal;
  /**
   * Ticket 11: the per-item token cap, applied to every node kind (session,
   * turn, observation) — the SOLE size-limiting mechanism (`turnBudget` is
   * the field's pre-existing name; it is not renamed to avoid re-touching
   * every call site for a cosmetic reason). `undefined` at this layer still
   * means "use `DEFAULT_TURN_TOKEN_BUDGET`", not "uncapped" — see that
   * constant's own doc comment.
   */
  turnBudget?: number;
  /**
   * Ticket 11: which turn fields to render — the SOLE field-selection
   * mechanism, replacing the retired collapsed/expanded depth switch. Turn
   * nodes only; ignored by session/observation/toolCall nodes (an
   * observation already renders every field it has, unconditionally — see
   * `formatObservationBlock`'s own comment). `undefined` resolves to
   * `DEFAULT_TURN_RENDER_FIELDS`.
   */
  fields?: TurnRenderFields;
  /**
   * Session nodes only: append the `raw: <jsonlPath>` transcript-pointer
   * line. Replaces the retired depth switch's session-level behaviour
   * (`expanded` used to add this line) — callers rendering a session as a
   * bare listing HEADER (search hits, a turn-scope's owning session) leave
   * this unset; the one full session-DETAIL route (`recall(id="S<n>")`) sets
   * it, alongside always including its turn preview (see recall.ts).
   */
  includeRawPointer?: boolean;
}

type RenderNode =
  | { type: "session"; value: FormattedSession }
  | { type: "turn"; value: FormattedTurn }
  | { type: "observation"; value: FormattedObservation }
  | { type: "toolCall"; value: FormattedToolCall };

export function formatEpoch(epoch: number): string {
  const date = new Date(epoch * 1000);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function normalizeCount(value?: number | null): number {
  if (!value || value < 0) {
    return 0;
  }

  return value;
}

function formatStats(parts: string[]): string {
  return parts.join(" ");
}

function formatSessionStats(session: FormattedSession): string {
  const parts: string[] = [];
  const turnCount = normalizeCount(session.turnCount ?? session.turns?.length);
  const observationCount = normalizeCount(
    session.observationCount ??
      session.turns?.reduce(
        (sum, turn) => sum + normalizeCount(turn.observationCount),
        0,
      ),
  );

  if (turnCount > 0) {
    parts.push(`💬${turnCount}`);
  }

  if (observationCount > 0) {
    parts.push(`💡${observationCount}`);
  }

  return formatStats(parts);
}

function formatTurnStats(turn: FormattedTurn): string {
  const parts: string[] = [];
  const observationCount = normalizeCount(
    turn.observationCount ?? turn.observations?.length,
  );
  const filesReadCount = normalizeCount(
    turn.filesReadCount ?? turn.filesRead?.length,
  );
  const filesModifiedCount = normalizeCount(
    turn.filesModifiedCount ?? turn.filesModified?.length,
  );
  const toolCallCount = normalizeCount(turn.toolCallCount);

  if (observationCount > 0) {
    parts.push(`💡${observationCount}`);
  }

  if (filesReadCount > 0) {
    parts.push(`📖${filesReadCount}`);
  }

  if (filesModifiedCount > 0) {
    parts.push(`✏️${filesModifiedCount}`);
  }

  if (toolCallCount > 0) {
    parts.push(`🔧${toolCallCount}`);
  }

  return formatStats(parts);
}

function pushBullets(lines: string[], indent: string, values: string[]): void {
  for (const value of values) {
    lines.push(`${indent}- ${value}`);
  }
}

// Split a stored bullet-list field (newline-separated "- " items) into its
// items, stripping the leading dash. A single-line value yields one item.
export function splitBulletField(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^-+\s*/, ""));
}

function collapseToSingleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The one character-level truncator left in this module (spec: "词边界" —
 * word boundary). Ticket 11 removed every FIXED character budget that used
 * to feed it (`DEFAULT_TRUNCATE`/`MAX_TRUNCATE`/`truncate`/`truncateCap`);
 * its surviving callers are `capRenderToTokenBudget` below (budget derived
 * from the `turn` token cap, not a char constant) and a handful of
 * genuinely unrelated internal char ceilings elsewhere in this codebase
 * (timeline title caps, the roster's per-row cap) that were never part of
 * the retiring mechanism.
 */
export function truncateText(
  text: string,
  {
    limit,
    signal,
  }: {
    limit: number;
    signal?: TruncationSignal;
  },
): string {
  const boundedLimit = Math.max(limit, 1);

  if (text.length <= boundedLimit) {
    return text;
  }

  markTruncated(signal);
  const window = text.slice(0, boundedLimit);
  // End on a boundary the reader can see. A raw slice ends mid-word ("identity
  // sup...", "messaging-s..."), which reads as corruption rather than as
  // truncation.
  //
  // Word boundary only — an earlier revision also retreated to the last full
  // sentence, and that was worse: a note written conclusion-first ends its
  // first sentence around 45% in, so honouring it threw away the evidence the
  // rest of the window exists to show. One rule, and it never sacrifices text
  // it did not have to.
  if (/\s/.test(text.charAt(boundedLimit))) {
    // The window already stopped before whitespace, so its last word is whole.
    return `${window}${FIELD_TRUNCATION_SUFFIX}`;
  }
  const wordEnd = window.lastIndexOf(" ");
  // A late word boundary costs a partial word; an early one would cost most of
  // the window (a long URL, a base64 blob, an unbroken CJK run), and a hard cut
  // — the original behaviour — is the better trade there.
  if (wordEnd >= boundedLimit * 0.8) {
    return `${window.slice(0, wordEnd)}${FIELD_TRUNCATION_SUFFIX}`;
  }
  return `${window}${FIELD_TRUNCATION_SUFFIX}`;
}

/**
 * `truncateText`, but the limit is a TOKEN budget rather than a character
 * one (ticket 11: the turn budget is the only knife left, and it is stated
 * in tokens). Binary-searches the character limit `truncateText` needs to
 * land at-or-under `maxTokens` once `estimateTokens` measures the result —
 * cheap here (turn-scale text, not corpus-scale) and keeps the word-boundary
 * rule itself in exactly one place rather than a second token-aware copy of
 * it. Returns `""` when not even one character (plus the mark) fits.
 */
export function truncateTextToTokenBudget(text: string, maxTokens: number): string {
  if (maxTokens <= 0) {
    return "";
  }
  if (estimateTokens(text) <= maxTokens) {
    return text;
  }

  let low = 0;
  let high = text.length;
  let best = "";
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = truncateText(text, { limit: Math.max(mid, 1) });
    if (estimateTokens(candidate) <= maxTokens) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

/**
 * Cap an already-rendered block (session, turn, or observation) to a TOKEN
 * budget — the SOLE size mechanism now that per-field character caps have
 * retired (ticket 11, spec: "字段截断只由 turn token 预算驱动，词边界").
 *
 * The label line (line 0 — `[S<n>][T<n>] title | stats`) is never dropped:
 * it is the only thing that identifies WHICH row this is, so a budget too
 * small even for it still keeps it whole. Every subsequent line is kept
 * whole while it fits; the first line that does NOT fit whole is cut at a
 * WORD BOUNDARY to whatever budget remains (`truncateTextToTokenBudget`,
 * reusing `truncateText`'s own cut rule) instead of being dropped outright —
 * this is what makes "same content, bigger `turn` budget" show strictly
 * more of it rather than jumping between two fixed states. Lines after the
 * cut are dropped, and the drop is marked.
 */
export function capRenderToTokenBudget(
  rendered: string,
  budgetTokens: number | undefined,
  signal?: TruncationSignal,
): string {
  if (budgetTokens === undefined || !Number.isFinite(budgetTokens)) {
    return rendered;
  }

  if (estimateTokens(rendered) <= budgetTokens) {
    return rendered;
  }

  const lines = rendered.split("\n");
  const markerTokens = estimateTokens(TURN_BUDGET_TRUNCATION_MARKER);
  // Always keep the label line, however small the budget.
  const kept = [lines[0] ?? ""];
  let used = estimateTokens(kept[0]!);

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    const lineTokens = estimateTokens(line);
    const remaining = budgetTokens - used - markerTokens;

    if (remaining <= 0) {
      markTruncated(signal);
      kept.push(TURN_BUDGET_TRUNCATION_MARKER);
      return kept.join("\n");
    }

    if (lineTokens <= remaining) {
      kept.push(line);
      used += lineTokens;
      continue;
    }

    // This line does not fit whole — cut it at a word boundary to what is
    // left, then stop: nothing after it can fit either.
    const partial = truncateTextToTokenBudget(line, remaining);
    if (partial) {
      kept.push(partial);
    }
    markTruncated(signal);
    kept.push(TURN_BUDGET_TRUNCATION_MARKER);
    return kept.join("\n");
  }

  if (kept.length === lines.length) {
    // Every line fit once the marker's own cost was accounted for — nothing
    // was actually cut, so no marker is owed.
    return rendered;
  }

  markTruncated(signal);
  kept.push(TURN_BUDGET_TRUNCATION_MARKER);
  return kept.join("\n");
}

/**
 * Ticket 11: `filter.fields`' render-side counterpart — a resolved SET a
 * render function can `.has()` against, instead of re-deriving one from the
 * raw array on every call.
 */
export type TurnRenderFields = ReadonlySet<RecallTurnField>;

/**
 * Default when `filter.fields` is unset — mirrors the retired collapsed
 * default EXACTLY (ticket 03's own field-set switch: "collapsed carries
 * exactly prompt/title/content" — the prompt bullet rendered in collapsed
 * mode too, whenever a real title already occupied the label). A caller
 * after what `expanded` used to ADD beyond this (response/insight/
 * observations/files) asks for those fields explicitly. `filter.fields` is
 * the SOLE field-selection mechanism (spec: "07 的 filter.fields 从加法机制
 * 升为唯一机制") — there is no longer a second, depth-driven default field
 * set for a caller to fall back on. (The browse feed's own default,
 * `DEFAULT_BROWSE_FIELDS` in recall.ts, is a separate, narrower set
 * purpose-built for that one-line-per-turn listing — unaffected.)
 */
export const DEFAULT_TURN_RENDER_FIELDS: TurnRenderFields = new Set<RecallTurnField>([
  "title",
  "content",
  "prompt",
]);

export function resolveTurnFields(
  fields?: readonly RecallTurnField[],
): TurnRenderFields {
  return fields && fields.length > 0 ? new Set(fields) : DEFAULT_TURN_RENDER_FIELDS;
}

function formatStatus(status?: string | null): string {
  return status ? ` [${status}]` : "";
}

export function extractKeyParam(name: string, input: unknown): string | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const record = input as Record<string, unknown>;
  const valueForKey = (...keys: string[]) => {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim() !== "") {
        return value;
      }
    }

    return null;
  };

  switch (name) {
    case "Edit":
    case "Read":
    case "Write":
    case "Glob":
      return valueForKey("file_path", "path");
    case "Bash":
      return valueForKey("command");
    case "Grep": {
      const pattern = valueForKey("pattern");
      const path = valueForKey("path");
      if (pattern && path) {
        return `${pattern} ${path}`;
      }
      return pattern ?? path;
    }
    case "Agent":
      return valueForKey("description");
    default:
      for (const value of Object.values(record)) {
        if (typeof value === "string" && value.trim() !== "") {
          return value;
        }
      }
      return null;
  }
}

function formatSessionBlock(
  session: FormattedSession,
  options: RenderNodeOptions,
): string {
  const stats = formatSessionStats(session);
  const statsSegment = stats ? ` | ${stats}` : "";
  const lines = [
    `- [S${session.id}] ${session.title ?? "Untitled"}${statsSegment} | ${formatEpoch(session.createdAtEpoch)} | ${session.project}`,
  ];

  if (session.content) {
    lines.push(`  - desc: ${session.content}`);
  }

  if (options.includeRawPointer && session.jsonlPath) {
    lines.push(`  raw: ${session.jsonlPath}`);
  }

  return lines.join("\n");
}

function formatTurnLabel(
  turn: FormattedTurn,
  fields: TurnRenderFields,
  { indent = "  ", sessionId, includeDbTurnIds = false }: RenderNodeOptions,
): string {
  // Bare `T<n>` on purpose: the `:L<line>` suffix this once carried was the
  // JSONL-first replay handoff coordinate, retired when replay went
  // SQLite-first — the replay skill itself forbids locating content by
  // transcript_line_start (stale/duplicated, dangerously so on rewound
  // turns), so rendering it taught the exact anti-pattern.
  const turnId = `T${turn.promptNumber}`;
  const prefix =
    sessionId === undefined
      ? `${indent}- [${turnId}]`
      : `${indent}- [S${sessionId}][${turnId}]`;
  const stats = formatTurnStats(turn);
  const statsSegment = stats ? ` | ${stats}` : "";

  // The label always needs SOME identifying text: the stored title when
  // `fields` selects it and one exists, else the raw prompt (collapsed to
  // one line — a task notification or pasted payload carries newlines that
  // would otherwise split one turn's label across several), else a bare
  // placeholder. This fallback is structural, not a `fields` selection in
  // its own right — it is what keeps a turn's label non-empty regardless of
  // what the caller asked to see.
  const titleSelected = fields.has("title") && turn.title !== null;
  const title = titleSelected
    ? turn.title!
    : turn.promptPreview
      ? `"${collapseToSingleLine(turn.promptPreview)}"`
      : "Untitled";

  const dbIdSegment = includeDbTurnIds ? ` dbid:T${turn.id}` : "";
  const rewindSegment = turn.wasRolledBack ? REWIND_MARKER : "";

  return `${prefix} ${title}${statsSegment}${formatStatus(turn.status)}${dbIdSegment}${rewindSegment}`;
}

function formatObservationLabel(
  observation: FormattedObservation,
  indent: string,
  header?: string,
): string {
  return `${indent}- [O${observation.id}] ${header ?? observation.title}`;
}

/**
 * The body sits under the label's text rather than at the bullet's own column,
 * so a multi-line value can no longer reach column zero. A line at column zero
 * does not merely look wrong: it produces a line neither a reader nor a
 * downstream parser can attribute to the observation it came from.
 */
const OBSERVATION_BODY_INDENT = "    ";

/**
 * The projection applies only to a row that carries raw tool fields, which are
 * era-gated upstream (spec D5): a legacy row's record is its extractor's
 * summary and must keep rendering as it always did. The check is the observable
 * fact — are the raw fields here — never a second era comparison, because two
 * places deciding the same era is how they come to disagree.
 */
function projectObservation(
  observation: FormattedObservation,
): ProjectedCall | null {
  if (!observation.toolInput && !observation.toolResult) {
    return null;
  }

  return projectToolCall(
    observation.toolName ?? "",
    observation.toolInput,
    observation.toolResult,
  );
}

/**
 * One observation, in full — ticket 11 drops the collapsed/expanded split
 * this used to carry: an observation already rendered IDENTICALLY at both
 * depths (its own fields are not individually selectable), so the split was
 * dead weight even before this ticket. `capRenderToTokenBudget` (applied by
 * `renderNode`) is what keeps a heavy tool-call observation from blowing out
 * its owner's page, same guarantee the old per-field character cap gave,
 * driven by the same `turn` budget every other node kind now shares.
 */
function formatObservationBlock(
  observation: FormattedObservation,
  { indent = "" }: RenderNodeOptions,
): string {
  const projection = projectObservation(observation);
  // An era row has no extractor title — 0 of the 517 measured — so its label is
  // already just the tool name, and the projected header replaces it in place.
  // Where a title does exist it is the row's own record and keeps the label;
  // the header then rides the `tool:` line, which is where the tool name was
  // going anyway.
  const headerIsLabel =
    projection !== null && observation.title === observation.toolName;
  const lines = [
    formatObservationLabel(
      observation,
      indent,
      headerIsLabel ? projection.header : undefined,
    ),
  ];

  if (observation.content) {
    lines.push(`${indent}  - desc: ${observation.content}`);
  }

  // D3: the label above already fell back to the tool name when there was no
  // extractor title (`title ?? toolName ?? ...`, spec D11). Printing `tool:`
  // again in that case repeats the same word twice. What decides it is the
  // observable fact — does the label already say this — never the era. A
  // legacy row is not carved out here either: it never reaches this line,
  // because a legacy view carries no mechanical fields at all (spec D5).
  const toolLine = projection
    ? (headerIsLabel ? null : projection.header)
    : observation.toolName && observation.toolName !== observation.title
      ? observation.toolName
      : null;
  if (toolLine) {
    lines.push(`${indent}  - tool: 🔧 ${toolLine}`);
  }

  if (projection) {
    for (const line of projection.body) {
      if (line.trim() === "") {
        continue;
      }
      lines.push(`${indent}${OBSERVATION_BODY_INDENT}${line}`);
    }
  }

  return lines.join("\n");
}

function formatToolCallBlock(
  toolCall: FormattedToolCall,
  { indent = "    " }: RenderNodeOptions,
): string {
  const keyParam = toolCall.keyParam ?? extractKeyParam(toolCall.name, toolCall.input);
  const suffix = keyParam ? ` ${keyParam}` : "";
  const detailIndent = `${indent}  `;
  const lines = [`${indent}- 🔧 ${toolCall.name}${suffix}`];

  if (toolCall.input !== undefined) {
    lines.push(`${detailIndent}- in: ${JSON.stringify(toolCall.input)}`);
  }

  if (toolCall.result) {
    lines.push(`${detailIndent}- out: ${toolCall.result}`);
  }

  return lines.join("\n");
}

function renderTurnChildren(
  turn: FormattedTurn,
  options: RenderNodeOptions,
): string {
  const { indent = "  ", sessionId } = options;
  const childIndent = `${indent}  `;
  const childLines: string[] = [];

  if (turn.observations && turn.observations.length > 0) {
    for (const observation of turn.observations.slice(0, DEFAULT_PREVIEW_COUNT)) {
      childLines.push(
        formatObservationBlock(observation, {
          indent: childIndent,
          sessionId,
          turnPromptNumber: turn.promptNumber,
        }),
      );
    }

    if (turn.observations.length > DEFAULT_PREVIEW_COUNT) {
      childLines.push(`${childIndent}+${turn.observations.length - DEFAULT_PREVIEW_COUNT} more`);
    }

    return childLines.join("\n");
  }

  if (turn.toolCalls && turn.toolCalls.length > 0) {
    for (const toolCall of turn.toolCalls.slice(0, DEFAULT_PREVIEW_COUNT)) {
      childLines.push(
        formatToolCallBlock(toolCall, {
          indent: childIndent,
          sessionId,
          turnPromptNumber: turn.promptNumber,
        }),
      );
    }

    if (turn.toolCalls.length > DEFAULT_PREVIEW_COUNT) {
      childLines.push(`${childIndent}+${turn.toolCalls.length - DEFAULT_PREVIEW_COUNT} more`);
    }
  }

  return childLines.join("\n");
}

/**
 * One turn, at exactly the fields `fields` selects (ticket 11: `filter.fields`
 * is the sole field-selection mechanism — see that type's own doc comment).
 * Every field renders in FULL; `capRenderToTokenBudget` (applied by
 * `renderNode`) is the only thing that ever cuts it, driven by the `turn`
 * token budget.
 */
function formatTurnBody(
  turn: FormattedTurn,
  fields: TurnRenderFields,
  options: RenderNodeOptions,
): string {
  const { indent = "  " } = options;
  const lines = [formatTurnLabel(turn, fields, options)];

  if (fields.has("content") && turn.content) {
    lines.push(`${indent}  - desc: ${turn.content}`);
  }

  // The prompt bullet only ADDS information when the label is showing the
  // polished TITLE, not the raw prompt (see `formatTurnLabel`'s own
  // fallback) — if the label already fell back to the prompt text itself
  // (no title selected/stored), a second copy here would just repeat it.
  const titleSelected = fields.has("title") && turn.title !== null;
  if (fields.has("prompt") && titleSelected && turn.promptPreview) {
    lines.push(
      `${indent}  - prompt: "${collapseToSingleLine(turn.promptPreview)}"`,
    );
  }

  if (fields.has("response") && turn.responsePreview) {
    lines.push(
      `${indent}  - response: "${collapseToSingleLine(turn.responsePreview)}"`,
    );
  }

  if (fields.has("insight") && turn.insight && turn.insight.length > 0) {
    lines.push(`${indent}  - insight:`);
    pushBullets(lines, `${indent}    `, turn.insight);
  }

  if (fields.has("files") && turn.filesRead && turn.filesRead.length > 0) {
    lines.push(`${indent}  - files_read:`);
    pushBullets(lines, `${indent}    `, renderFileTree(turn.filesRead).split("\n"));
  }

  if (fields.has("files") && turn.filesModified && turn.filesModified.length > 0) {
    lines.push(`${indent}  - files_modified:`);
    pushBullets(
      lines,
      `${indent}    `,
      renderFileTree(turn.filesModified).split("\n"),
    );
  }

  if (fields.has("observations")) {
    const childBlock = renderTurnChildren(turn, options);
    if (childBlock) {
      lines.push(childBlock);
    }
  }

  return lines.join("\n");
}

/**
 * The one entry point every render path in this codebase calls (ticket 11:
 * "统一渲染器" — the unified renderer). A session/turn/observation node is
 * always capped to a per-item token budget (`RenderNodeOptions.turnBudget`,
 * default `DEFAULT_TURN_TOKEN_BUDGET`); a turn node additionally selects
 * which fields to show via `RenderNodeOptions.fields`
 * (default `DEFAULT_TURN_RENDER_FIELDS`). `toolCall` nodes render only as a
 * turn's own child (`renderTurnChildren`) and carry no budget of their own —
 * they are already inside their owning turn's capped block.
 */
export function renderNode(node: RenderNode, options: RenderNodeOptions = {}): string {
  const budget = options.turnBudget ?? DEFAULT_TURN_TOKEN_BUDGET;

  switch (node.type) {
    case "session":
      return capRenderToTokenBudget(
        formatSessionBlock(node.value, options),
        budget,
        options.signal,
      );
    case "turn": {
      const fields = options.fields ?? DEFAULT_TURN_RENDER_FIELDS;
      return capRenderToTokenBudget(
        formatTurnBody(node.value, fields, options),
        budget,
        options.signal,
      );
    }
    case "observation":
      return capRenderToTokenBudget(
        formatObservationBlock(node.value, options),
        budget,
        options.signal,
      );
    case "toolCall":
      return formatToolCallBlock(node.value, options);
  }
}

/**
 * A turn rendered at the default field set (title + content) — settlement's
 * own per-turn compact rendering (`worker/note-settlement-context.ts`)
 * reuses this so its prior/window turns render through the SAME builder
 * recall's own default view uses, rather than a second, hand-rolled compact
 * shape. Replaces the retired `formatTurnCollapsed` convenience wrapper.
 */
export function formatTurnCompact(
  turn: FormattedTurn,
  options: RenderNodeOptions = {},
): string {
  return renderNode(
    { type: "turn", value: turn },
    { ...options, fields: DEFAULT_TURN_RENDER_FIELDS },
  );
}
