import type { Database } from "bun:sqlite";

import type { SessionRecord } from "../db/sessions";
import { estimateDiaryTokens } from "../diary/domain";
import { SESSION_INJECTION_TOKEN_BUDGET } from "../diary/persona-render";
import { renderSessionStateInjection } from "../mcp/session-output";

/**
 * The ONE assembly of the main agent's session injection (ticket 11, spec A4).
 *
 * Two callers, and that is the whole point:
 *
 *   - `hooks/handlers/context.ts` — the SessionStart hook, what the MAIN agent
 *     is shown when a session starts or resumes;
 *   - `worker/note-settlement-context.ts` — the settlement subagent's context,
 *     which spec A4 requires to reuse the main agent's injection INTERFACE
 *     rather than a copy of its content.
 *
 * Before this module they were two assemblies of the same fields, and they had
 * already drifted: the settlement side still passed the `current` field ticket
 * 04 deleted, and never passed `insight` — which ticket 04 promoted to a
 * first-class injected field — so the subagent read a session summary missing
 * the one field a different session browsing this one is meant to read. That
 * is the failure mode A4 names: "managing the main agent's injected context
 * must not require a second, divergent edit for the subagent."
 *
 * ownership-and-note-cadence spec, "session 字段" ([S15069/T910]-[T913]):
 * insight/next_steps/decision/done/reference retire from this injection
 * unconditionally — `content` (plus `title` in the heading line) is all that
 * is left to render. That collapses the `fields` reader split below: both
 * `"all"` and `"global-view"` now produce identical output. The parameter
 * stays (the settlement caller passes `fields: "global-view"` explicitly)
 * so this remains a signature-compatible change, not a second edit at the
 * one remaining call site.
 *
 * Where the two genuinely differ, the difference is a PARAMETER here, never a
 * second implementation:
 *
 *   - `includeCorpusHeader` — SessionStart opens with the corpus header and
 *     the three-axis line, which names the `mnemo-replay` SKILL. The
 *     settlement subagent has `recall` and `timeline` and no skills at all
 *     (note-settlement-sdk-query.ts's allowed-tool list), so pointing it at
 *     replay would name a capability it does not have.
 *   - `session: null` — SessionStart renders the header alone for a session
 *     with no turns yet (a husk), where there is no state worth a heading.
 *   - `tokenBudget` — the ceiling the state block is cut to, one budget with
 *     one owner and one truncation marker (ticket 04).
 *   - `fields` — which of ticket 04's two reader groups to render. See the
 *     field's own comment below: settlement is a third reader and wants the
 *     arc, not the resuming session's event stream.
 */

/** The corpus header: how much memory exists, which session is current, and the three read axes. */
export function buildCorpusHeader(
  db: Database,
  primarySessionId?: number,
): string {
  const sessionCount =
    db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sessions")
      .get()?.count ?? 0;
  const observationCount =
    db.query<{ count: number }, []>(
      // Excluded rows (a `note` call's observation) are captured for the raw
      // axis only; counting them here would tell the reader a hidden call exists.
      "SELECT COUNT(*) AS count FROM observations WHERE excluded_from_extraction = 0",
    ).get()?.count ?? 0;

  return [
    `claude-mnemo: ${sessionCount} sessions, ${observationCount} observations${primarySessionId ? ` | current: S${primarySessionId}` : ""}`,
    "Axes: recall (content) · timeline (temporal) · mnemo-replay (raw)",
  ].join("\n");
}

export interface MainAgentSessionInjectionInput {
  /** The session whose state block is rendered; `null` renders no state block at all. */
  session: SessionRecord | null;
  /** Rendered into the corpus header as `current: S<n>`; omitted → no current marker. */
  currentSessionId?: number;
  /** SessionStart wants the corpus header; the settlement prompt supplies its own framing. */
  includeCorpusHeader?: boolean;
  /**
   * Ceiling for the heading + state block together (ticket 04's one budget,
   * one cut). Keep this comfortably above the state renderer's own
   * truncation-pointer floor (mcp/session-output.ts's
   * `renderBoundedSessionStateOutput` doc comment, ticket 15 finding 9) — a
   * budget that small is this field's caller's mistake to avoid, not
   * something the renderer corrects for.
   */
  tokenBudget?: number;
  /**
   * Formerly selected which of two field groups to render (ticket 04's
   * global-view vs. recent-events split, user ruling S15069/T759). The
   * ownership-and-note-cadence spec ([S15069/T910]-[T913]) retires the
   * recent-events group (next_steps/decision/done/reference) unconditionally,
   * so there is nothing left for `"all"` to add over `"global-view"` — both
   * now render the same title/content. Kept only so the settlement caller's
   * `fields: "global-view"` call site does not need a second, divergent edit.
   */
  fields?: "all" | "global-view";
}

const STATE_HEADING_LINES = ["## Current Session", ""];

/**
 * Assemble the injection. `""` is a legitimate return only when a caller asks
 * for neither the header nor a session.
 *
 * ticket 04: one budget, one cut, and the cut says so.
 *
 * This block used to be bounded TWICE. The state renderer bounds itself to
 * 2,000 tokens and marks its own truncation with a `… state truncated; full
 * summary: recall(id="S<n>")` pointer; the result was then handed to
 * `renderPersonaDocumentInjection` against the same 2,000, which re-cut the
 * very same lines — the heading it added pushed the block over — and replaced
 * the state renderer's pointer with `（其余 N 行省略…）`, whose N counts only
 * the lines the SECOND pass dropped. A reader with half a summary missing was
 * told two lines were. The heading's tokens were the only real work the second
 * pass did, so they are reserved here instead.
 */
export function renderMainAgentSessionInjection(
  db: Database,
  input: MainAgentSessionInjectionInput,
): string {
  const header = input.includeCorpusHeader
    ? buildCorpusHeader(db, input.currentSessionId)
    : null;

  if (!input.session) {
    return header ?? "";
  }

  const budget = input.tokenBudget ?? SESSION_INJECTION_TOKEN_BUDGET;
  // Floored at 0 rather than going negative — but 0 (or anything under the
  // state renderer's own pointer floor) is a caller mistake this function
  // does not otherwise guard against; see `tokenBudget`'s own doc comment
  // (ticket 15 finding 9).
  const stateTokenBudget = Math.max(
    0,
    budget - estimateDiaryTokens([...STATE_HEADING_LINES, ""].join("\n")),
  );
  const session = input.session;
  const sessionDocument = [
    ...STATE_HEADING_LINES,
    // ownership-and-note-cadence spec ([S15069/T910]-[T913]): title/content
    // only, regardless of `fields` — insight/next_steps/decision/done/
    // reference retired from every render surface unconditionally.
    renderSessionStateInjection(
      {
        id: session.id,
        title: session.title,
        content: session.content,
      },
      stateTokenBudget,
    ),
    "",
  ].join("\n");

  return header ? [header, "", sessionDocument].join("\n") : sessionDocument;
}
