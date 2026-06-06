import type { Database } from "bun:sqlite";

import type { SessionRecord } from "../db/sessions";
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

const buildContextTimelineViewWithMode = buildContextTimelineView as (
  db: Database,
  sessionId: number,
  view?: ContextTimelineViewMode,
) => ContextTimelineView;

const defaultTimelineRenderer: CurrentSessionTimelineRenderer = {
  buildContextTimelineView: buildContextTimelineViewWithMode,
  renderTimeline,
};

export function renderCurrentSessionOutput(
  db: Database,
  session: FormattedSession,
  sessionRecord: SessionRecord,
  timelineRenderer: CurrentSessionTimelineRenderer = defaultTimelineRenderer,
): string {
  const lines = [`[S${session.id}] ${session.title ?? "(untitled session)"}`];
  const pushField = (label: string, value: string | null | undefined): void => {
    if (value) {
      lines.push(`  ${label}: ${value}`);
    }
  };
  // decision/done/reference are markdown bullet lists: label line + indented
  // bullets. Sub-bullets sit at 4 spaces to match the recall-expanded and
  // worker prior_* renders.
  const pushBulletLines = (items: string[]): void => {
    for (const item of items) {
      lines.push(`    - ${item}`);
    }
  };
  const pushBulletField = (label: string, value: string | null | undefined): void => {
    const items = splitBulletField(value);
    if (items.length === 0) {
      return;
    }
    lines.push(`  ${label}:`);
    pushBulletLines(items);
  };

  // D4: inject the full redesigned summary. `decision` falls back to legacy
  // `insight` bullets for old sessions; empty fields are skipped.
  // decision/done/reference are bullet lists; current/next are single lines.
  pushField("content", session.content);

  if (session.decision) {
    pushBulletField("decision", session.decision);
  } else {
    const insightLines = session.insight ?? [];
    if (insightLines.length > 0) {
      lines.push("  insight:");
      pushBulletLines(insightLines);
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
    // Keep the SessionStart hook resilient even if timeline rendering breaks.
  }

  return lines.join("\n");
}
