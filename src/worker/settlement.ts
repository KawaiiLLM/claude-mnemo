import type { Database } from "bun:sqlite";

import {
  getSessionEffectiveCitations,
  type EffectiveCitations,
} from "../db/citations";
import { getRuleExemptTurnIds } from "../db/rules";
import {
  advanceSettlementCursor,
  getSettlementCursor,
  markSettlementJobDone,
  recordSettlementChangeSummary,
  type SettlementJob,
} from "../db/settlement";
import { runWriteTransaction } from "../db/database";
import { getTurnById, updateTurnById, type TurnRecord } from "../db/turns";
import { loadConfig } from "../shared/config";
import {
  buildCorrectionGraph,
  buildTimelineView,
  renderTimeline,
} from "../mcp/timeline";
import {
  renderSignificanceCalibration,
  summarizeGradeWindow,
  type GradeWindow,
} from "./processors";

/**
 * Two-phase grading, inference half (spec §A). The persistence half lives in
 * `db/settlement.ts`; this module owns what the settle agent SEES, what it is
 * allowed to SAY back, and what one accepted answer WRITES.
 */

/**
 * The configured era boundary (spec D11). The arc view this module shows the
 * settle agent is the SAME renderer every read surface uses, so it has to be
 * told where the era starts or it keeps drawing era turns as legacy arc rows
 * after the switch. Resolved here rather than plumbed from the worker because
 * the value only changes on a reload; the default (`null`) is the legacy path.
 */
function resolveConfiguredEraCutoff(): number | null {
  try {
    return loadConfig().eraCutoffEpoch;
  } catch {
    return null;
  }
}

/** Grade a provisional turn must currently hold to be a demotion candidate. */
const DEMOTION_CANDIDATE_GRADE = 3;

/** The literal role tag that marks a turn as overturned (spec §C/§E). */
export const ROLLED_BACK_TAG = "rolled-back";

export interface SettlementMemberSignal {
  turnId: number;
  promptNumber: number;
  status: string;
  grade: number | null;
  /** DISTINCT same-session citing turns (spec §B). */
  inDegree: number;
  title: string | null;
}

export interface SupersessionEvent {
  victimTurnId: number;
  victimPromptNumber: number;
  /** Corrector DB turn ids, ascending by prompt number. */
  supersededBy: number[];
}

export interface SettlementSignals {
  members: SettlementMemberSignal[];
  /**
   * In-degree ≥ 1 from a citer of ANY grade. The one mechanical rule settlement
   * has, and it points in the CONFIRM direction only: a citation audit measured
   * mechanical demotion at 7-36% precision, so no signal here may lower a grade.
   */
  confirmedTurnIds: number[];
  /** Provisional Grade 3, zero in-degree, not rule-exempt — the model decides. */
  demotionCandidateTurnIds: number[];
  /** Cited by the rule pipeline; never nominated on zero in-degree alone. */
  ruleExemptTurnIds: number[];
  supersessions: SupersessionEvent[];
  gradeWindow: GradeWindow;
}

function deriveInDegree(
  citations: ReadonlyMap<number, EffectiveCitations>,
): Map<number, number> {
  const inDegree = new Map<number, number>();
  for (const entry of citations.values()) {
    // citedTurnIds is de-duplicated per citer, so each citer contributes ≤1 —
    // this IS the DISTINCT-citer count the confirmation rule is defined on.
    for (const citedTurnId of entry.citedTurnIds) {
      inDegree.set(citedTurnId, (inDegree.get(citedTurnId) ?? 0) + 1);
    }
  }
  return inDegree;
}

/**
 * The mechanical signal package (spec §A): per-turn in-degree, supersession
 * events, and the zero-in-degree provisional-Grade-3 list. `citations` is read
 * ONCE for the whole session and everything is derived from it.
 */
export function computeSettlementSignals(
  db: Database,
  sessionId: number,
  cohort: readonly TurnRecord[],
  options: {
    citations?: ReadonlyMap<number, EffectiveCitations>;
    ruleExemptTurnIds?: ReadonlySet<number>;
  } = {},
): SettlementSignals {
  const citations =
    options.citations ?? getSessionEffectiveCitations(db, sessionId);
  const inDegree = deriveInDegree(citations);
  const ruleExempt =
    options.ruleExemptTurnIds ?? getRuleExemptTurnIds(db, sessionId);

  const members: SettlementMemberSignal[] = cohort.map((turn) => ({
    turnId: turn.id,
    promptNumber: turn.promptNumber,
    status: turn.status,
    grade: turn.significanceGrade,
    inDegree: inDegree.get(turn.id) ?? 0,
    title: turn.title,
  }));

  const confirmedTurnIds = members
    .filter((member) => member.inDegree >= 1)
    .map((member) => member.turnId);
  const ruleExemptTurnIds = members
    .filter((member) => ruleExempt.has(member.turnId))
    .map((member) => member.turnId);
  const demotionCandidateTurnIds = members
    .filter(
      (member) =>
        member.grade === DEMOTION_CANDIDATE_GRADE &&
        member.inDegree === 0 &&
        !ruleExempt.has(member.turnId),
    )
    .map((member) => member.turnId);

  const graph = buildCorrectionGraph(cohort, {
    citations,
    resolveCited: (dbId) => getTurnById(db, dbId),
  });
  const byId = new Map(cohort.map((turn) => [turn.id, turn]));
  const supersessions: SupersessionEvent[] = [...graph.supersededBy.entries()]
    .map(([victimTurnId, supersededBy]) => ({
      victimTurnId,
      victimPromptNumber:
        byId.get(victimTurnId)?.promptNumber ??
        getTurnById(db, victimTurnId)?.promptNumber ??
        0,
      supersededBy,
    }))
    .sort((left, right) => left.victimPromptNumber - right.victimPromptNumber);

  const countsByGrade = new Map<number | null, number>();
  for (const member of members) {
    countsByGrade.set(member.grade, (countsByGrade.get(member.grade) ?? 0) + 1);
  }
  const gradeWindow = summarizeGradeWindow(
    [...countsByGrade.entries()].map(([grade, count]) => ({ grade, count })),
  );

  return {
    members,
    confirmedTurnIds,
    demotionCandidateTurnIds,
    ruleExemptTurnIds,
    supersessions,
    gradeWindow,
  };
}

/**
 * Signal lists name turns the way the ROSTER does — `turnId=<db id>`, never a
 * bare `T<n>`. The arc view above the roster numbers its rows by PROMPT number,
 * so a bare `T4821` sits in both namespaces at once and a model copying it into
 * its batch has a coin flip between the id the write path needs and the prompt
 * number it will reject. One label, one namespace.
 */
function formatIdList(ids: readonly number[]): string {
  return ids.length === 0 ? "(none)" : ids.map((id) => `turnId=${id}`).join(", ");
}

/**
 * The frozen window as the arc renderer draws it, plus a per-turn roster.
 *
 * BOTH are needed and neither replaces the other. The arc view carries the
 * narrative — desc, pull-through antecedents, back-links — but it numbers its
 * rows by PROMPT number, while grades are written against DB turn ids. The
 * roster is the id map and the mechanical signal table in one, so the agent
 * never has to guess which namespace an integer belongs to.
 */
export function renderSettlementWindow(
  db: Database,
  sessionId: number,
  cohort: readonly TurnRecord[],
  signals: SettlementSignals,
  citations?: ReadonlyMap<number, EffectiveCitations>,
  eraCutoffEpoch: number | null = resolveConfiguredEraCutoff(),
): string {
  let arcView = "(arc view unavailable)";
  try {
    arcView = renderTimeline(
      buildTimelineView(
        db,
        {
          id: `S${sessionId}`,
          view: "milestones",
          pageSize: Math.max(cohort.length, 1),
          eraCutoffEpoch,
        },
        [...cohort],
        // The SAME snapshot the mechanical signals were derived from. Two reads
        // would let a citation written between them put an edge in the arc that
        // the in-degree table says does not exist.
        citations,
      ),
      { showEarlierHint: false },
    );
  } catch {
    // A malformed window must not sink the job before the model ever sees the
    // roster, which is the part the grades are actually written against.
  }

  const roster = signals.members
    .map((member) => {
      const grade = member.grade === null ? "ungraded" : `G${member.grade}`;
      const title = (member.title ?? "").replace(/\s+/g, " ").slice(0, 90);
      return `  turnId=${member.turnId} P${member.promptNumber} ${grade} ${member.status} in_degree=${member.inDegree}${
        title ? ` — ${title}` : ""
      }`;
    })
    .join("\n");

  return `<arc-view>
${arcView}
</arc-view>

<window-roster note="turnId is the DB id you write grades against; P<n> is the prompt number the arc rows above are numbered by.">
${roster}
</window-roster>`;
}

export function renderMechanicalSignals(signals: SettlementSignals): string {
  const supersessionLines =
    signals.supersessions.length === 0
      ? "  (none)"
      : signals.supersessions
          .map(
            (event) =>
              `  turnId=${event.victimTurnId} was superseded by ${formatIdList(
                event.supersededBy,
              )}`,
          )
          .join("\n");

  return `<mechanical-signals>
confirmed (in-degree ≥ 1, a later turn of any grade consumed it — no action needed unless you actively disagree):
  ${formatIdList(signals.confirmedTurnIds)}
supersession events (a later turn overturned these; the back-link is written for you):
${supersessionLines}
demotion candidates (provisional Grade 3, cited by nothing in the window):
  ${formatIdList(signals.demotionCandidateTurnIds)}
  About two thirds of these were consumed WITHOUT being cited, so zero in-degree is a prompt to look, never a verdict. Use recall() on any of them before demoting; leave it out of your batch if it holds up.
rule-exempt (the rule pipeline cites these; zero in-degree alone is never grounds to demote them):
  ${formatIdList(signals.ruleExemptTurnIds)}
</mechanical-signals>`;
}

export interface SettlementPromptInput {
  db: Database;
  sessionId: number;
  job: SettlementJob;
  cohort: readonly TurnRecord[];
  signals: SettlementSignals;
  /** The session citation snapshot the signals were derived from (spec §B). */
  citations?: ReadonlyMap<number, EffectiveCitations>;
  /** Overrides the configured era boundary; tests are the only caller that does. */
  eraCutoffEpoch?: number | null;
}

/**
 * The settle message class — a WORKER MESSAGE, not turn work. Its contract
 * explicitly authorizes rewriting records inside the frozen window, which every
 * other message class forbids, and it answers in JSON rather than through
 * `remember()` because grades, back-links, the change summary and the cursor
 * have to land in ONE transaction.
 */
export function buildSettlementPrompt(input: SettlementPromptInput): string {
  const { job, cohort, signals } = input;
  const firstPrompt = cohort[0]?.promptNumber ?? 0;
  const lastPrompt = cohort[cohort.length - 1]?.promptNumber ?? 0;

  return `<settlement session="S${input.sessionId}" boundary="${job.boundary}" members="${cohort.length}" prompts="${firstPrompt}-${lastPrompt}">
This message is a SETTLEMENT, not turn extraction. Grades assigned at extraction time are PROVISIONAL: task causality is retrospective, and only now — with the arc played out — is it visible which turns actually changed it. You are explicitly authorized to rewrite the grade of any record inside this frozen window, and only inside it.

Do NOT call remember(). Your answer is the JSON batch described at the end of this message.

Tools: recall() to read any turn in full, timeline() to re-read the session's shape. Use them on the demotion candidates below before deciding — a turn cited by nothing is often still the turn everything after it was built on.
</settlement>

${renderSettlementWindow(
  input.db,
  input.sessionId,
  cohort,
  signals,
  input.citations,
  input.eraCutoffEpoch,
)}

${renderMechanicalSignals(signals)}

${renderSignificanceCalibration(
  signals.gradeWindow,
  `settlement window, boundary ${job.boundary}`,
)}

<output-contract>
Reply with a JSON array and NOTHING else — no prose, no explanation. A bare array is preferred; a \`\`\`json fence around it is tolerated and stripped.

[{"turnId": 4821, "grade": 2}, {"turnId": 4830, "grade": 4}]

Rules, all enforced mechanically:
- every element has EXACTLY the two keys turnId and grade — an extra key, a missing key, or a renamed key rejects the WHOLE batch and nothing is written;
- turnId is a DB turn id from the roster above (the \`turnId=\` column), each id at most once;
- grade is an integer 0-4;
- \`[]\` is a valid and common answer: it means every provisional grade in this window is confirmed;
- omitting a turn leaves its grade untouched, so send only the turns you are CHANGING.
</output-contract>`;
}

export type SettlementBatchItem = { turnId: number; grade: number };

export type SettlementBatchParse =
  | { ok: true; items: SettlementBatchItem[] }
  | { ok: false; reason: string };

/**
 * Deliberately permissive, and the output contract SAYS so. Rejecting a fenced
 * array would spend one of three attempts on formatting noise while the judgment
 * inside it was fine — the batch validation below is where strictness buys
 * something, because there a violation means the model's answer is actually
 * wrong.
 */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return fenced ? fenced[1]!.trim() : trimmed;
}

/**
 * Strict whole-batch validation (spec §A). Any violation rejects the ENTIRE
 * batch — there is no partial apply, because a half-written settlement leaves a
 * window whose grades came from two different judgments with no record of where
 * the seam is.
 *
 * An empty array is valid (all confirmed) and partial coverage is valid
 * (uncovered members keep their grade); those are answers, not omissions.
 */
export function parseSettlementBatch(
  rawText: string,
  frozenMemberIds: ReadonlySet<number>,
): SettlementBatchParse {
  const body = stripCodeFence(rawText ?? "");
  if (body === "") {
    return { ok: false, reason: "empty response" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    return {
      ok: false,
      reason: `response is not JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (!Array.isArray(parsed)) {
    return { ok: false, reason: "response is not a JSON array" };
  }

  const items: SettlementBatchItem[] = [];
  const seen = new Set<number>();
  for (const [index, element] of parsed.entries()) {
    if (
      element === null ||
      typeof element !== "object" ||
      Array.isArray(element)
    ) {
      return { ok: false, reason: `element ${index} is not an object` };
    }
    const keys = Object.keys(element as Record<string, unknown>);
    if (keys.length !== 2 || !keys.includes("turnId") || !keys.includes("grade")) {
      return {
        ok: false,
        reason: `element ${index} must have exactly the keys turnId and grade, got [${keys.join(", ")}]`,
      };
    }
    const { turnId, grade } = element as { turnId: unknown; grade: unknown };
    if (typeof turnId !== "number" || !Number.isSafeInteger(turnId)) {
      return { ok: false, reason: `element ${index} turnId is not an integer` };
    }
    if (!frozenMemberIds.has(turnId)) {
      return {
        ok: false,
        reason: `element ${index} turnId T${turnId} is outside the frozen window`,
      };
    }
    if (seen.has(turnId)) {
      return { ok: false, reason: `element ${index} repeats turnId T${turnId}` };
    }
    if (
      typeof grade !== "number" ||
      !Number.isInteger(grade) ||
      grade < 0 ||
      grade > 4
    ) {
      return {
        ok: false,
        reason: `element ${index} grade must be an integer 0-4, got ${JSON.stringify(grade)}`,
      };
    }
    seen.add(turnId);
    items.push({ turnId, grade });
  }

  return { ok: true, items };
}

export interface SettlementChangeSummary {
  boundary: number;
  members: number;
  /** One entry per CHANGED grade — the auditable old→new trail. */
  grades: Array<{ turnId: number; from: number | null; to: number }>;
  /** Supersession back-links written this pass. */
  backlinks: Array<{
    victimTurnId: number;
    supersededBy: number[];
    taggedRolledBack: boolean;
  }>;
  confirmed: number[];
  cursor: { from: number; to: number };
}

/**
 * Thrown inside the success transaction when the ownership CAS misses, purely to
 * make SQLite roll the whole thing back; `applySettlementBatch` catches it and
 * reports a stale discard instead.
 */
class StaleSettlementClaimError extends Error {
  constructor() {
    super("settlement claim generation no longer owns this job");
    this.name = "StaleSettlementClaimError";
  }
}

/**
 * The success transaction (spec §A): grades, supersedes-derived back-links, the
 * old→new change summary and the cursor land together or not at all.
 *
 * Returns null for a STALE DISCARD: this worker's lease expired, the row was
 * reclaimed, and the job belongs to another attempt now. That is not a failure —
 * the new owner is mid-flight and will report its own outcome — so nothing is
 * written and nothing is marked failed. The fence is checked at the
 * done-marking, inside the transaction, so a displaced worker's grade and tag
 * writes roll back with it.
 *
 * Grades move ONLY where the model's batch says so. The supersedes edges write
 * the victim's `rolled-back` marker — the back-link half of the same pass — but
 * never a grade: mechanical demotion is the one thing the audit ruled out, and
 * the selection layer already demotes a victim's effGrade at render time
 * without touching what is stored.
 *
 * The diary is deliberately NOT invalidated. `updateTurnById` re-stales a
 * settled diary day only when status/prompt/response/title/content/insight
 * change; a grade or a role tag is invisible to the narrative, so re-running the
 * dream over it would burn an agent run for an identical document.
 */
export function applySettlementBatch(
  db: Database,
  job: SettlementJob,
  items: readonly SettlementBatchItem[],
  signals: SettlementSignals,
  nowEpoch: number,
): SettlementChangeSummary | null {
  try {
    return applySettlementBatchLocked(db, job, items, signals, nowEpoch);
  } catch (error) {
    if (error instanceof StaleSettlementClaimError) {
      return null;
    }
    throw error;
  }
}

function applySettlementBatchLocked(
  db: Database,
  job: SettlementJob,
  items: readonly SettlementBatchItem[],
  signals: SettlementSignals,
  nowEpoch: number,
): SettlementChangeSummary {
  return runWriteTransaction(db, () => {
    const grades: SettlementChangeSummary["grades"] = [];
    for (const item of items) {
      const turn = getTurnById(db, item.turnId);
      if (!turn) {
        continue;
      }
      if (turn.significanceGrade === item.grade) {
        continue;
      }
      updateTurnById(db, item.turnId, {
        // Pinned explicitly: updateTurnById auto-promotes active→extracted when
        // a record has substance, and a settle must never change a status.
        status: turn.status,
        significanceGrade: item.grade,
        updatedAtEpoch: nowEpoch,
      });
      grades.push({
        turnId: item.turnId,
        from: turn.significanceGrade,
        to: item.grade,
      });
    }

    const backlinks: SettlementChangeSummary["backlinks"] = [];
    for (const event of signals.supersessions) {
      const victim = getTurnById(db, event.victimTurnId);
      if (!victim) {
        continue;
      }
      const alreadyTagged = victim.tags.includes(ROLLED_BACK_TAG);
      if (!alreadyTagged) {
        updateTurnById(db, victim.id, {
          status: victim.status,
          tags: [ROLLED_BACK_TAG],
          updatedAtEpoch: nowEpoch,
        });
      }
      backlinks.push({
        victimTurnId: event.victimTurnId,
        supersededBy: event.supersededBy,
        taggedRolledBack: !alreadyTagged,
      });
    }

    const cursorFrom = getSettlementCursor(db, job.sessionId);
    // Done first, then advance: the cursor reads job statuses, so this job's own
    // boundary only counts as consecutive once its row says `done`. The CAS on
    // the claim generation lives here too — everything above unwinds if this
    // worker no longer owns the row.
    if (!markSettlementJobDone(db, job.id, nowEpoch, job.claimGeneration)) {
      throw new StaleSettlementClaimError();
    }
    const cursorTo = advanceSettlementCursor(db, job.sessionId, nowEpoch);

    const summary: SettlementChangeSummary = {
      boundary: job.boundary,
      members: job.frozenMemberIds.length,
      grades,
      backlinks,
      confirmed: signals.confirmedTurnIds,
      cursor: { from: cursorFrom, to: cursorTo },
    };
    recordSettlementChangeSummary(
      db,
      job.id,
      JSON.stringify(summary),
      nowEpoch,
    );
    return summary;
  });
}
