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

/** Insight is stored as one bullet-per-line string and injected as a list. */
export function splitInsight(insight: string | null): string[] {
  if (!insight) {
    return [];
  }

  return insight
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^-+\s*/, ""));
}

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
   * Which of ticket 04's two field groups to render (user ruling, S15069/T759).
   *
   * Ticket 04 split the seven fields BY READER: `title`/`content`/`insight`
   * are the compressed global view, written for a DIFFERENT session browsing
   * this one; `next_steps`/`decision`/`done`/`reference` are recent events,
   * written for the present session resuming itself.
   *
   * The settlement subagent is a third reader and wants neither role whole.
   * It grades turns by task causality — Grade 4 is the turn that framed the
   * problem — and ticket 14 hangs the segment partition on those same Grade-4
   * boundaries, so what it needs is the ARC, which is exactly the global-view
   * group. The recent-events group is an accumulating event stream it never
   * reads, and it is the expensive half: measured on real sessions, all seven
   * fields cost 1.2K-1.9K tokens per dispatch against 400-600 for these three.
   *
   * `"global-view"` therefore is not a budget trim that happens to drop the
   * tail — it is the reader split applied to a reader ticket 04 did not have.
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
  const globalViewOnly = input.fields === "global-view";
  const sessionDocument = [
    ...STATE_HEADING_LINES,
    renderSessionStateInjection(
      {
        id: session.id,
        title: session.title,
        content: session.content,
        insight: splitInsight(session.insight),
        // The recent-events group, written for the session resuming itself.
        // A `global-view` reader is a different session looking in, so these
        // are omitted rather than truncated — see `fields` above.
        //
        // Raw storage, not resolved pointers: state injection keeps the
        // compact `[T<n>]` coordinates a reader can cite straight back.
        decision: globalViewOnly ? null : session.decision,
        done: globalViewOnly ? null : session.done,
        nextSteps: globalViewOnly ? null : session.nextSteps,
        reference: globalViewOnly ? null : session.reference,
      },
      stateTokenBudget,
    ),
    "",
  ].join("\n");

  return header ? [header, "", sessionDocument].join("\n") : sessionDocument;
}
