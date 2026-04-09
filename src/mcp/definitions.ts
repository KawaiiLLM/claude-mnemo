import { z } from "zod";

const selectorShape = z.union([
  z.number().int(),
  z.array(z.number().int()),
  z.string(),
]);

export const MNEMO_TOOL_DESCRIPTIONS = {
  recall: "Recall structured memories from the SQLite store.",
  replay: "Replay raw transcript content from the source JSONL.",
  remember: "Persist sessions, turns, observations, or memories through one routed write tool.",
} as const;

export const recallInputShape = {
  view: z.enum(["sessions", "turns", "observations", "memories"]).optional(),
  id: z.string().optional(),
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
  limit: z.number().int().positive().optional(),
  expand_turns: z.array(z.number().int()).optional(),
  project: z.string().optional(),
};

export const replayInputShape = {
  session: z.number().int(),
  turn: z.number().int().optional(),
  tool: z.number().int().positive().optional(),
  full: z.boolean().optional(),
  transcript_path: z.string().optional(),
};

export const rememberInputShape = {
  parent: z.string().optional(),
  id: z.string().optional(),
  type: z.string().optional(),
  scope: z.string().optional(),
  prompt_number: z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]).pipe(z.number().int().positive()).optional(),
  title: z.string().optional(),
  content: z.string().optional(),
  insight: z.string().optional(),
  reasoning: z.string().optional(),
  application: z.string().optional(),
  tags: z.array(z.string()).optional(),
  status: z
    .enum(["skipped", "undone", "active", "superseded", "archived"])
    .optional(),
  next_steps: z.string().optional(),
  files_read: z.array(z.string()).optional(),
  files_modified: z.array(z.string()).optional(),
  source_turn_id: z.number().int().positive().optional(),
};

export const recallInputSchema = z.object(recallInputShape);
export const replayInputSchema = z.object(replayInputShape);
export const rememberInputSchema = z.object(rememberInputShape);

export const MNEMO_ALLOWED_TOOLS = [
  "mcp__mnemo__remember",
  "mcp__mnemo__recall",
  "mcp__mnemo__replay",
] as const;
