import { z } from "zod";

const selectorShape = z.union([
  z.number().int(),
  z.array(z.number().int()),
  z.string(),
]);

export const MNEMO_TOOL_DESCRIPTIONS = {
  recall: "Recall structured memories from the SQLite store.",
  replay: "Replay raw transcript content from the source JSONL.",
  save_turn: "Persist one extracted turn and its observations.",
  update_session: "Update the session summary fields.",
} as const;

export const recallInputShape = {
  scope: z.enum(["sessions", "turns", "observations"]),
  session: selectorShape.optional(),
  turn: selectorShape.optional(),
  obs: selectorShape.optional(),
  query: z.string().optional(),
  type: z.string().optional(),
  file: z.string().optional(),
  after: z.number().int().nonnegative().optional(),
  before: z.number().int().nonnegative().optional(),
  time: z.string().optional(),
  depth: z.enum(["collapsed", "expanded", "full"]).optional(),
  observation: z.number().int().optional(),
  expand_turns: z.array(z.number().int()).optional(),
  around: z.string().optional(),
  project: z.string().optional(),
  from_epoch: z.number().int().optional(),
  to_epoch: z.number().int().optional(),
};

export const replayInputShape = {
  session: z.number().int(),
  turn: z.number().int().optional(),
  tool: z.number().int().positive().optional(),
  full: z.boolean().optional(),
  transcript_path: z.string().optional(),
};

export const saveTurnInputShape = {
  session_id: z.number().int(),
  prompt_number: z.number().int().positive(),
  status: z.literal("undone").optional(),
  user_prompt: z.string().optional(),
  assistant_response: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  insight: z.string().optional(),
  files_read: z.array(z.string()).optional(),
  files_modified: z.array(z.string()).optional(),
  created_at_epoch: z.number().int().optional(),
  updated_at_epoch: z.number().int().optional(),
  observations: z
    .array(
      z.object({
        type: z.string(),
        title: z.string(),
        description: z.string().optional(),
        narrative: z.string().optional(),
        facts: z.array(z.string()).optional(),
        concepts: z.array(z.string()).optional(),
        files_read: z.array(z.string()).optional(),
        files_modified: z.array(z.string()).optional(),
      }),
    )
    .optional(),
};

export const updateSessionInputShape = {
  session_id: z.number().int(),
  title: z.string().optional(),
  description: z.string().optional(),
  insight: z.string().optional(),
  next_steps: z.string().optional(),
  updated_at_epoch: z.number().int().optional(),
  completed_at_epoch: z.number().int().optional(),
};

export const recallInputSchema = z.object(recallInputShape);
export const replayInputSchema = z.object(replayInputShape);
export const saveTurnInputSchema = z.object(saveTurnInputShape);
export const updateSessionInputSchema = z.object(updateSessionInputShape);

export const MNEMO_ALLOWED_TOOLS = [
  "mcp__mnemo__save_turn",
  "mcp__mnemo__update_session",
  "mcp__mnemo__recall",
  "mcp__mnemo__replay",
] as const;
