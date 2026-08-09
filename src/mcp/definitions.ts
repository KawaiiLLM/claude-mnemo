import { z } from "zod";

import { CITATION_RELATIONS } from "../db/citations";

export const MNEMO_TOOL_DESCRIPTIONS = {
  recall:
    "Search past sessions for design rationale, rejected alternatives, decisions, and user corrections — the *why* behind the code, which source never records. For current behavior or mechanism, read the source first. Paginated index; hand off to the mnemo-replay skill for a turn's full untruncated text and tool I/O from the database (raw JSONL only for exact bytes).",
  remember: "Persist sessions, turns, or observations through one routed write tool.",
  timeline:
    "Render the temporal/decision shape of a past session — gaps, tool bursts, compact boundary, broken-prompt candidates, and view-specific timeline bodies. Single-session view with range selectors plus page/pageSize pagination. Optional `view` selects `turns` (default turn table), `milestones` (key chronological digest), or `phases` (phase overview).",
  note:
    "Write your own note about one of your past turns. `turn` is the fully qualified `S<session>/T<prompt>` address copied from a pending-notes reminder or from injected context. title: `<activity>+<topic>: <what this turn covered>`. content: conclusion first, then the key steps, including rejected alternatives and who decided. insight: optional study note — only knowledge worth keeping long-term that is hard to reacquire, and orthogonal to this turn's conclusion. Write in English; quoted user phrases keep their original language. Re-sending a turn replaces its note. Never include <private> content.",
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
  grade: z.number().int().min(0).max(4).optional(),
  regrade: z
    .object({
      id: z.string(),
      grade: z.number().int().min(0).max(4),
    })
    .strict()
    .optional(),
  // Structured causal edges for a turn (spec §B). Replace-set: the array given
  // here becomes the turn's ENTIRE citation set, so a re-sent turn converges
  // instead of accumulating. Omitted = leave the existing edges alone; an
  // explicit `[]` clears them and records "this turn genuinely cites nothing".
  // `id` is the bare DB turn id (8501), not the `T8501` selector form.
  //
  // The shape check stops at "integer" on purpose (spec §B): a wrong TYPE is a
  // caller bug worth rejecting the call over, but a merely INVALID id — zero,
  // negative, a typo that names no turn, the turn citing itself — is dropped
  // per edge with a log line so one bad id cannot discard a whole extraction's
  // good edges. See replaceTurnCitations.
  cites: z
    .array(
      z
        .object({
          id: z.number().int(),
          relation: z.enum(CITATION_RELATIONS),
        })
        .strict(),
    )
    .optional(),
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

// Spec D1: exactly four parameters. Everything else the shadow row records
// (writer_model, ride_turn, timestamps) is filled mechanically — asking the
// caller for provenance invites the caller to invent it.
export const noteInputShape = {
  turn: z.string().min(1),
  title: z.string().min(1),
  content: z.string().min(1),
  insight: z.string().optional(),
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
export const noteInputSchema = z.object(noteInputShape).strict();

// `timeline` joins the worker's surface for settlement (spec §A): re-grading a
// trailing window means reading the arc that window sits in, and the arc view is
// a timeline call. It stays read-only, so extraction may also reach for it.
export const MNEMO_ALLOWED_TOOLS = [
  "mcp__mnemo__remember",
  "mcp__mnemo__recall",
  "mcp__mnemo__timeline",
] as const;
