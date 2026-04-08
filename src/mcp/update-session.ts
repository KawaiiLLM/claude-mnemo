import type { Database } from "bun:sqlite";

import { getSession, upsertSession } from "../db/sessions";

type ToolTextResult = {
  content: Array<{
    type: "text";
    text: string;
  }>;
};

export interface UpdateSessionToolInput {
  session_id: number;
  title?: string;
  content?: string;
  description?: string;
  insight?: string;
  next_steps?: string;
  updated_at_epoch?: number;
  completed_at_epoch?: number;
}

function textResult(text: string): ToolTextResult {
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
  };
}

export function updateSessionTool(
  db: Database,
  input: UpdateSessionToolInput,
): ToolTextResult {
  const session = getSession(db, input.session_id);

  if (!session) {
    return textResult(`Session ${input.session_id} not found.`);
  }

  upsertSession(db, {
    contentSessionId: session.contentSessionId,
    project: session.project,
    title: input.title ?? session.title,
    content: input.content ?? input.description ?? session.content,
    description: input.content ?? input.description ?? session.content,
    insight: input.insight ?? session.insight,
    nextSteps: input.next_steps,
    startedAtEpoch: session.startedAtEpoch,
    updatedAtEpoch:
      input.updated_at_epoch ?? Math.floor(Date.now() / 1000),
    completedAtEpoch: input.completed_at_epoch ?? session.completedAtEpoch,
  });

  return textResult(`Updated session ${input.session_id}.`);
}
