import type { Database } from "bun:sqlite";

import { saveTurn } from "../db/turns";

type ToolTextResult = {
  content: Array<{
    type: "text";
    text: string;
  }>;
};

export interface SaveTurnToolInput {
  session_id: number;
  prompt_number: number;
  status?: "undone";
  user_prompt?: string;
  assistant_response?: string;
  title?: string;
  content?: string;
  description?: string;
  insight?: string;
  files_read?: string[];
  files_modified?: string[];
  created_at_epoch?: number;
  updated_at_epoch?: number;
  observations?: Array<{
    type: string;
    title: string;
    content?: string;
    description?: string;
    insight?: string;
    narrative?: string;
    facts?: string[];
    tags?: string[];
    concepts?: string[];
    files_read?: string[];
    files_modified?: string[];
  }>;
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

export function saveTurnTool(
  db: Database,
  input: SaveTurnToolInput,
): ToolTextResult {
  const turn = saveTurn(db, {
    sessionId: input.session_id,
    promptNumber: input.prompt_number,
    status: input.status,
    userPrompt: input.user_prompt ?? null,
    assistantResponse: input.assistant_response ?? null,
    title: input.title ?? null,
    content: input.content ?? input.description ?? null,
    description: input.content ?? input.description ?? null,
    insight: input.insight ?? null,
    filesRead: input.files_read ?? [],
    filesModified: input.files_modified ?? [],
    createdAtEpoch: input.created_at_epoch ?? Math.floor(Date.now() / 1000),
    updatedAtEpoch: input.updated_at_epoch ?? null,
    observations: (input.observations ?? []).map((observation) => ({
      type: observation.type,
      title: observation.title,
      content: observation.content ?? observation.description ?? null,
      description: observation.content ?? observation.description ?? null,
      insight: observation.insight ?? observation.narrative ?? null,
      narrative: observation.narrative ?? null,
      facts: observation.facts ?? [],
      tags: observation.tags ?? observation.concepts ?? [],
      concepts: observation.concepts ?? [],
      filesRead: observation.files_read ?? [],
      filesModified: observation.files_modified ?? [],
    })),
  });

  return textResult(`Saved turn #${turn.promptNumber} with status ${turn.status}.`);
}
