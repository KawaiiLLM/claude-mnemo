import { z } from "zod";

export const MNEMO_TOOL_DESCRIPTIONS = {
  recall:
    "Search past sessions for design rationale, rejected alternatives, decisions, and user corrections — the *why* behind the code, which source never records. For current behavior or mechanism, read the source first. Paginated index; hand off to the mnemo-replay skill for a turn's full untruncated text and tool I/O from the database (raw JSONL only for exact bytes).",
  remember: "Persist sessions, turns, or observations through one routed write tool.",
  timeline:
    "Render the temporal/decision shape of a past session — gaps, tool bursts, compact boundary, broken-prompt candidates, and view-specific timeline bodies. Single-session view with range selectors plus page/pageSize pagination. Optional `view` selects `turns` (default turn table), `milestones` (key chronological digest), or `phases` (phase overview).",
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

// SDK workers share recall's public selector grammar, but may request long
// fields. The main MCP schema above deliberately retains its 2000-char cap.
export const workerRecallInputShape = {
  ...recallInputShape,
  truncate: z.number().int().min(1).optional(),
};

export const rememberInputShape = {
  id: z.string().optional(),
  type: z.string().optional(),
  title: z.string().optional(),
  content: z.string().optional(),
  insight: z.string().optional(),
  tags: z.array(z.string()).optional(),
  status: z
    .enum([
      "pending",
      "extracted",
      "skipped",
      "undone",
      "active",
    ])
    .optional(),
  next_steps: z.string().optional(),
  // Session-summary fields (D1). `next_steps` above doubles as the displayed
  // "next" field; these four are session-only and rewritten whole each refresh.
  decision: z.string().optional(),
  done: z.string().optional(),
  current: z.string().optional(),
  reference: z.string().optional(),
};

export const timelineInputShape = {
  id: z.string().min(1),
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().optional(),
  view: z.enum(["turns", "milestones", "phases"]).optional(),
};

export const recallInputSchema = z.object(recallInputShape).strict();
export const rememberInputSchema = z.object(rememberInputShape).strict();
export const timelineInputSchema = z.object(timelineInputShape).strict();

export const MNEMO_ALLOWED_TOOLS = [
  "mcp__mnemo__remember",
  "mcp__mnemo__recall",
] as const;
