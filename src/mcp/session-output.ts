import type { Database } from "bun:sqlite";

import type { SessionRecord } from "../db/sessions";
import { estimateDiaryTokens } from "../diary/domain";
import { splitBulletField } from "./format";
import type { FormattedSession } from "./format";
import { buildContextTimelineView, renderTimeline } from "./timeline";

type ContextTimelineViewMode = "turns" | "milestones" | "phases";
type ContextTimelineView = ReturnType<typeof buildContextTimelineView>;

export interface CurrentSessionTimelineRenderer {
  buildContextTimelineView: (
    db: Database,
    sessionId: number,
    view?: ContextTimelineViewMode,
  ) => ContextTimelineView;
  renderTimeline: (
    view: ContextTimelineView,
    options: { promptCap?: number; showEarlierHint?: boolean },
  ) => string;
}

const defaultTimelineRenderer: CurrentSessionTimelineRenderer = {
  buildContextTimelineView,
  renderTimeline,
};

export const CURRENT_SESSION_STATE_TOKEN_BUDGET = 2_000;

export interface SessionStateRenderInput {
  id: number;
  title: string | null;
  content: string | null;
  decision: string | null;
  done: string | null;
  current: string | null;
  nextSteps: string | null;
  reference: string | null;
  legacyInsight?: string[];
}

export interface SessionStateTokenReport {
  title: number;
  content: number;
  current: number;
  nextSteps: number;
  decision: number;
  done: number;
  reference: number;
  total: number;
}

function capCodePoints(value: string | null, max: number): string | null {
  if (!value) {
    return value;
  }
  const codePoints = Array.from(value);
  return codePoints.length <= max
    ? value
    : `${codePoints.slice(0, Math.max(0, max - 1)).join("")}…`;
}

function buildSessionStateLines(
  input: SessionStateRenderInput,
  capPriorityFields = false,
  includeHistoricalFields = true,
): string[] {
  const title =
    (capPriorityFields ? capCodePoints(input.title, 100) : input.title) ??
    "(untitled session)";
  const lines = [
    `[S${input.id}] ${title}`,
  ];
  const pushField = (
    label: string,
    value: string | null | undefined,
    cap?: number,
  ): void => {
    const rendered = capPriorityFields && cap ? capCodePoints(value ?? null, cap) : value;
    if (rendered) {
      lines.push(`  ${label}: ${rendered}`);
    }
  };
  const pushBulletField = (
    label: string,
    value: string | null | undefined,
  ): void => {
    const items = splitBulletField(value);
    if (items.length === 0) {
      return;
    }
    lines.push(`  ${label}:`);
    for (const item of items) {
      lines.push(`    - ${item}`);
    }
  };

  // State first: bounded legacy rendering drops trailing historical fields
  // before it can lose the current working position.
  pushField("content", input.content, 400);
  pushField("current", input.current, 400);
  pushField("next", input.nextSteps, 200);

  if (!includeHistoricalFields) {
    return lines;
  }

  if (input.decision) {
    pushBulletField("decision", input.decision);
  } else if ((input.legacyInsight?.length ?? 0) > 0) {
    lines.push("  insight:");
    for (const item of input.legacyInsight ?? []) {
      lines.push(`    - ${item}`);
    }
  }
  pushBulletField("done", input.done);
  pushBulletField("reference", input.reference);
  return lines;
}

export function renderSessionStateOutput(input: SessionStateRenderInput): string {
  return buildSessionStateLines(input).join("\n");
}

export function measureSessionStateTokens(
  input: SessionStateRenderInput,
): SessionStateTokenReport {
  const fieldTokens = (
    label: string,
    value: string | null,
    bullet = false,
  ): number => {
    if (!value) {
      return 0;
    }
    const rendered = bullet
      ? [`  ${label}:`, ...splitBulletField(value).map((item) => `    - ${item}`)].join("\n")
      : `  ${label}: ${value}`;
    return estimateDiaryTokens(rendered);
  };
  const full = renderSessionStateOutput(input);
  return {
    title: estimateDiaryTokens(
      `[S${input.id}] ${input.title ?? "(untitled session)"}`,
    ),
    content: fieldTokens("content", input.content),
    current: fieldTokens("current", input.current),
    nextSteps: fieldTokens("next", input.nextSteps),
    decision: fieldTokens("decision", input.decision, true),
    done: fieldTokens("done", input.done, true),
    reference: fieldTokens("reference", input.reference, true),
    total: estimateDiaryTokens(full),
  };
}

function renderBoundedSessionStateOutput(
  input: SessionStateRenderInput,
): string {
  const full = renderSessionStateOutput(input);
  if (estimateDiaryTokens(full) <= CURRENT_SESSION_STATE_TOKEN_BUDGET) {
    return full;
  }

  const pointer = `  … state truncated; full summary: recall(id="S${input.id}")`;
  const uncappedStateLines = buildSessionStateLines(input, false, false);
  const stateFitsUncapped =
    estimateDiaryTokens([...uncappedStateLines, pointer].join("\n")) <=
    CURRENT_SESSION_STATE_TOKEN_BUDGET;
  const lines = buildSessionStateLines(input, !stateFitsUncapped);
  const included: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const candidate = [
      ...included,
      lines[index]!,
      pointer,
    ].join("\n");
    if (estimateDiaryTokens(candidate) > CURRENT_SESSION_STATE_TOKEN_BUDGET) {
      break;
    }
    included.push(lines[index]!);
  }

  const withPointer = [...included, pointer].join("\n");
  if (estimateDiaryTokens(withPointer) <= CURRENT_SESSION_STATE_TOKEN_BUDGET) {
    return withPointer;
  }
  return included.join("\n");
}

export function renderCurrentSessionStateOutput(
  session: FormattedSession,
  sessionRecord: SessionRecord,
): string {
  return renderBoundedSessionStateOutput({
    id: sessionRecord.id,
    title: session.title ?? null,
    content: session.content ?? null,
    // context.ts currently resolves pointers on FormattedSession. Read raw
    // storage here so state injection keeps compact [T<n>] coordinates.
    decision: sessionRecord.decision ?? session.decision ?? null,
    done: sessionRecord.done ?? session.done ?? null,
    current: session.current ?? null,
    nextSteps: session.nextSteps ?? null,
    reference: session.reference ?? null,
    legacyInsight: session.insight,
  });
}

// Worker re-prime keeps the pre-state-layer shared rendering contract. The
// SessionStart injection path deliberately calls renderCurrentSessionStateOutput
// instead, so the independent milestone hook is its only timeline source.
export function renderCurrentSessionOutput(
  db: Database,
  session: FormattedSession,
  sessionRecord: SessionRecord,
  timelineRenderer: CurrentSessionTimelineRenderer = defaultTimelineRenderer,
): string {
  const lines = [
    `[S${session.id}] ${session.title ?? "(untitled session)"}`,
  ];
  const pushField = (
    label: string,
    value: string | null | undefined,
  ): void => {
    if (value) {
      lines.push(`  ${label}: ${value}`);
    }
  };
  const pushBulletField = (
    label: string,
    value: string | null | undefined,
  ): void => {
    const items = splitBulletField(value);
    if (items.length === 0) {
      return;
    }
    lines.push(`  ${label}:`);
    for (const item of items) {
      lines.push(`    - ${item}`);
    }
  };

  pushField("content", session.content);
  if (session.decision) {
    pushBulletField("decision", session.decision);
  } else if ((session.insight?.length ?? 0) > 0) {
    lines.push("  insight:");
    for (const item of session.insight ?? []) {
      lines.push(`    - ${item}`);
    }
  }
  pushBulletField("done", session.done);
  pushField("current", session.current);
  pushField("next", session.nextSteps);
  pushBulletField("reference", session.reference);

  try {
    const timelineView = timelineRenderer.buildContextTimelineView(
      db,
      sessionRecord.id,
      "milestones",
    );
    lines.push("");
    lines.push(
      timelineRenderer.renderTimeline(timelineView, {
        promptCap: 80,
        showEarlierHint: true,
      }),
    );
  } catch {
    // Re-prime still provides the summary if timeline rendering fails.
  }

  return lines.join("\n");
}
