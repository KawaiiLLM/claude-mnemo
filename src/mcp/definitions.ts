import { z } from "zod";

export const MNEMO_TOOL_DESCRIPTIONS = {
  recall:
    "Recall structured memories from the SQLite store. Paginated index; use the mnemo-replay skill for raw JSONL.",
  remember: "Persist sessions, turns, observations, or memories through one routed write tool.",
  timeline:
    "Render the temporal/decision shape of a past session — phases, gaps, tool bursts, compact boundary, broken-prompt candidates. Single-session view with range selectors plus configurable page/pageSize pagination.",
} as const;

export const recallInputShape = {
  id: z.string().optional(),
  query: z.string().optional(),
  time: z.string().optional(),
  depth: z.enum(["collapsed", "expanded"]).optional(),
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().optional(),
  truncate: z.number().int().min(1).max(2000).optional(),
};

export const rememberInputShape = {
  id: z.string().optional(),
  type: z.string().optional(),
  scope: z.string().optional(),
  title: z.string().optional(),
  content: z.string().optional(),
  insight: z.string().optional(),
  reasoning: z.string().optional(),
  application: z.string().optional(),
  tags: z.array(z.string()).optional(),
  status: z
    .enum([
      "pending",
      "extracted",
      "skipped",
      "undone",
      "active",
      "superseded",
      "archived",
    ])
    .optional(),
  next_steps: z.string().optional(),
  source: z.string().optional(),
};

export const timelineInputShape = {
  id: z.string().min(1),
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().optional(),
};

export const recallInputSchema = z.object(recallInputShape).strict();
export const rememberInputSchema = z.object(rememberInputShape).strict();
export const timelineInputSchema = z.object(timelineInputShape).strict();

export const MNEMO_ALLOWED_TOOLS = [
  "mcp__mnemo__remember",
  "mcp__mnemo__recall",
] as const;
