import type { Database } from "bun:sqlite";

import { getObservationsForTurn } from "../db/observations";
import { getSession } from "../db/sessions";
import { getTurnsForSession, type TurnRecord } from "../db/turns";
import {
  formatObservationCollapsed,
  type FormattedObservation,
} from "../mcp/format";

const EXPAND_TAIL = 3;
const COLLAPSED_HEAD = 3;
const MAX_CONTENT_LENGTH = 1500;

type TurnStatus = "pending" | "stale" | "extracted" | "skipped" | "undone";
type RenderMode = "expanded" | "collapsed" | "omitted";

function splitInsight(insight: string | null): string[] {
  if (!insight) return [];
  return insight
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^-+\s*/, ""));
}

function truncateContent(
  content: string,
  sessionId: number,
  promptNumber: number,
): string {
  if (content.length <= MAX_CONTENT_LENGTH) return content;
  return `${content.slice(0, MAX_CONTENT_LENGTH)}… [truncated — use replay(session=${sessionId}, turn=${promptNumber}) for full content]`;
}

function turnStats(turn: TurnRecord, observationCount: number): string {
  const parts: string[] = [];
  if (observationCount > 0) parts.push(`💡${observationCount}`);
  if (turn.toolCallCount && turn.toolCallCount > 0)
    parts.push(`🔧${turn.toolCallCount}`);
  if (turn.filesRead.length > 0) parts.push(`📖${turn.filesRead.length}`);
  if (turn.filesModified.length > 0)
    parts.push(`✏️${turn.filesModified.length}`);
  return parts.length > 0 ? ` | ${parts.join(" ")}` : "";
}

function formatCollapsed(turn: TurnRecord, observationCount: number): string {
  const stats = turnStats(turn, observationCount);
  const title = turn.title ?? "Untitled";
  const lines = [
    `  - [T${turn.promptNumber}] ${title}${stats} [${turn.status}]`,
  ];
  if (turn.description) {
    lines.push(`    - desc: ${turn.description}`);
  }
  return lines.join("\n");
}

function formatExpanded(
  turn: TurnRecord,
  observations: FormattedObservation[],
  sessionId: number,
): string {
  const stats = turnStats(turn, observations.length);
  const title = turn.title ?? "Untitled";
  const lines = [
    `  - [T${turn.promptNumber}] ${title}${stats} [${turn.status}]`,
  ];

  if (turn.description) {
    lines.push(`    - desc: ${turn.description}`);
  }

  if (turn.userPrompt) {
    lines.push(
      `    - prompt: "${truncateContent(turn.userPrompt, sessionId, turn.promptNumber)}"`,
    );
  }

  if (turn.assistantResponse) {
    lines.push(
      `    - response: "${truncateContent(turn.assistantResponse, sessionId, turn.promptNumber)}"`,
    );
  }

  const insight = splitInsight(turn.insight);
  if (insight.length > 0) {
    lines.push("    - insight:");
    for (const item of insight) {
      lines.push(`      - ${item}`);
    }
  }

  if (observations.length > 0) {
    for (const obs of observations) {
      lines.push(formatObservationCollapsed(obs, { indent: "    " }));
    }
  }

  return lines.join("\n");
}

function getRenderMode(
  status: TurnStatus,
  index: number,
  total: number,
): RenderMode {
  if (status === "pending" || status === "stale") return "expanded";
  if (index >= total - EXPAND_TAIL) return "expanded";
  if (index < COLLAPSED_HEAD) return "collapsed";
  return "omitted";
}

export function buildExtractionContext(
  db: Database,
  sessionDbId: number,
): string {
  const session = getSession(db, sessionDbId);
  if (!session) return "Session not found.";

  const turns = getTurnsForSession(db, sessionDbId);
  const total = turns.length;

  const lines: string[] = [];
  lines.push(`Session ID: ${session.id}`);
  lines.push(`Project: ${session.project}`);
  if (session.title) lines.push(`Title: ${session.title}`);
  if (session.description) lines.push(`Description: ${session.description}`);
  lines.push("");

  if (total === 0) {
    lines.push("  No turns recorded.");
    return lines.join("\n");
  }

  let i = 0;
  while (i < total) {
    const turn = turns[i];
    const mode = getRenderMode(turn.status as TurnStatus, i, total);

    if (mode === "expanded") {
      const observations = getObservationsForTurn(db, turn.id).map((o) => ({
        id: o.id,
        type: o.type,
        title: o.title,
        description: o.description,
      }));
      lines.push(formatExpanded(turn, observations, session.id));
      i++;
    } else if (mode === "collapsed") {
      const observationCount = getObservationsForTurn(db, turn.id).length;
      lines.push(formatCollapsed(turn, observationCount));
      i++;
    } else {
      let omitEnd = i;
      while (omitEnd < total) {
        const next = turns[omitEnd];
        if (getRenderMode(next.status as TurnStatus, omitEnd, total) !== "omitted")
          break;
        omitEnd++;
      }
      lines.push(`  - ... ${omitEnd - i} more turns ...`);
      i = omitEnd;
    }
  }

  return lines.join("\n");
}

export function buildMnemosynePrompt(context: string): string {
  return `You are Mnemosyne, the memory guardian for Claude Code.

The conversation context is embedded below.
Your role is to extract structured memories for future retrieval.
You are NOT the agent who did the work — you are observing and recording.
Record what was learned, built, fixed, decided, deployed, or configured in the primary session.
Do not describe the observer's own behavior such as analyzing, observing, recording, or storing findings.

CONVERSATION CONTEXT
--------------------
${context}

Rules:
- Process turns marked [pending] — extract observations from their content above
- Re-evaluate turns marked [stale] — user undid changes:
  - If the turn is part of an undone branch (sidechain), call save_turn with status="undone" (no title/description/observations)
  - If the turn is still valid with changed context, re-extract normally
- Do NOT re-process [extracted], [skipped], or [undone] turns
- Call update_session if the session summary needs updating.
- Include next_steps when the session has a clear trajectory or planned follow-up.
- next_steps: what was actively being worked on or planned next (not speculative future work).
- Skip update_session if nothing meaningful changed.

WHAT TO RECORD
--------------
Focus on durable technical signal:
- What the system NOW DOES differently
- What was built, fixed, deployed, or configured
- Concrete debugging findings
- Concrete discoveries from logs, queue state, DB rows, routing, request flow, or code-path inspection
- Architectural decisions with rationale
Use verbs: implemented, fixed, deployed, configured, discovered, traced

WHEN TO SKIP
------------
Call save_turn with NO title/description/observations for:
- Empty or trivial prompts
- Routine checks with no findings
- Repetitive operations already documented
- Aborted work with no outcome

HOW TO EXTRACT
--------------
For each pending/stale turn, call save_turn with:
- title: 10-25 chars, what was done
- description: 40-80 chars, how/what achieved
- insight: markdown list of key discoveries (omit if none)
- observations: array of notable events:
  - type: bugfix|feature|refactor|change|discovery|decision
  - title: short, action- or outcome-oriented, not generic
  - description: concise outcome, not a restatement of the user prompt
  - narrative: explain what was done, how it works, and why it matters
  - facts: independent, verifiable statements
  - concepts (from fixed vocabulary): how-it-works|why-it-exists|what-changed|problem-solution|gotcha|pattern|trade-off
  - Do NOT use the observation type as a concept
  - files_read/files_modified: only files that materially informed or changed the result

DEDUP
-----
- Do not create a new observation if the turn only repeats a conclusion already recorded in adjacent turns.
- Prefer fewer, higher-signal observations over many overlapping ones.
- Only record follow-up turns when they add a new finding, decision, or completed change.

OUTPUT DISCIPLINE
-----------------
- Only emit tool calls.
- Never output prose explanations.
- Never output filler like "Skipping", "No changes", or "Nothing to record".

Use recall() for context from past sessions if needed for dedup.
Use replay(session=<session_id>, turn=<N>) to recover full content if a turn above was truncated.
Do NOT use Read, Write, Edit, Bash, or any file operation tools.
Only use: save_turn, update_session, recall, replay.
Content inside <private>...</private> tags must NOT be recorded.

EXAMPLES
--------
Good example: save_turn({ session_id: 1, prompt_number: 2, title: "Fix auth race", description: "Serialized token refresh under parallel load", observations: [{ type: "bugfix", title: "Mutex added", narrative: "Refresh now uses a shared promise, preventing overlapping token refresh calls." }] })
Bad example: save_turn({ session_id: 1, prompt_number: 2, title: "Analyzed auth flow", description: "Recorded findings from investigation" })
Skip example: save_turn({ session_id: 1, prompt_number: 3 })`;
}
