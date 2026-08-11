import { z } from "zod";

import { CITATION_RELATIONS } from "../db/citations";
import { NOTE_TOKEN_BUDGET } from "../shared/note-budget";

export const MNEMO_TOOL_DESCRIPTIONS = {
  recall:
    "Search past sessions for design rationale, rejected alternatives, decisions, and user corrections — the *why* behind the code, which source never records. For current behavior or mechanism, read the source first. Paginated index; hand off to the mnemo-replay skill for a turn's full untruncated text and tool I/O from the database (raw JSONL only for exact bytes).",
  remember: "Persist sessions, turns, or observations through one routed write tool.",
  timeline:
    "Render the temporal/decision shape of a past session — gaps, tool bursts, compact boundary, broken-prompt candidates, and view-specific timeline bodies. Single-session view with range selectors plus page/pageSize pagination. Optional `view` selects `turns` (default turn table), `milestones` (key chronological digest), or `phases` (phase overview).",
  // The per-field budgets are spliced in from `NOTE_TOKEN_BUDGET`, the constant
  // the receipt measures a write against, rather than restated as prose here.
  // Three surfaces say these numbers; two of them used to say them from memory.
  note:
    "Write your own note about the turn you are in. `turn` is the fully qualified `S<session>/T<prompt>` address — normally the current turn's, from the `mnemo current turn` line, sent in a batch whose result cannot change what the note says (a commit, a check you expect to pass). Which batch is last is not knowable before its results return, so do not wait for it: a turn that ends still owing its note is written from any batch of a later turn, results in hand, and that is the ordinary path. Never open a batch of only note calls except for a backlog-relief list or to correct a note already written. The note describes its addressed turn only. title (~" +
    NOTE_TOKEN_BUDGET.title +
    " tokens): `<activity>+<topic>: <what this turn covered>` — the addressing line, one glance says what the turn did. content (~" +
    NOTE_TOKEN_BUDGET.content +
    " tokens): the conclusion, then the distilled evidence chain that produced it, including rejected alternatives and who decided; never restate the title, and never narrate the act of looking (\"I checked the transcript and found it has no X\" is \"the transcript has no X\"). insight (~" +
    NOTE_TOKEN_BUDGET.insight +
    " tokens): optional study note — only knowledge worth keeping long-term that is hard to reacquire, and orthogonal to this turn's conclusion. It is read far from its turn, so it must stand alone: claim first, evidence after, and no session-local literal (id, ticket number) in the opening sentence. Each successful write answers with its own token count against those budgets. skip: set true, with `turn` alone, to decline a turn you owe that holds nothing worth keeping, or whose details have left your context (e.g. it predates a compact) and are not worth a lookup of their own — details a batch recovers in passing make it writable again, but never invent a note from the listed line. Write in English; quoted user phrases keep their original language. Re-sending a turn's note requires `replace: true` (its receipt starts `Updated`, not `Noted`) — send it whenever a later result, in that turn or a following one, changes what it should say; this works after a skip too, and a real note after a skip needs no `replace` (a decline leaves no note to overwrite). `crossSession: true` is required only if `turn` addresses a session other than this one — every address you are ever given is your own session's, so you should never need it. Never include <private> content.",
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

// Spec D1 plus 裁决 24's explicit skip. Everything else the shadow row records
// (writer_model, ride_turn, timestamps) is filled mechanically — asking the
// caller for provenance invites the caller to invent it.
//
// `title` and `content` are required for a real note but OPTIONAL here, because
// `skip: true` needs `turn` alone. The pairing is enforced in `noteTool`, which
// answers a missing field with a `Parameter error:` the model can read and act
// on; leaving them required in the schema would have the SDK reject every skip
// before the tool ever ran.
export const noteInputShape = {
  turn: z.string().min(1),
  title: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
  insight: z.string().optional(),
  skip: z.boolean().optional(),
  // spec D3: declares intent to overwrite an address that already has a note.
  replace: z.boolean().optional(),
  // spec D4: declares intent to write a turn outside the caller's own
  // session. No legitimate use exists today (every address a caller is ever
  // handed is its own session's) — this is a pure guardrail.
  crossSession: z.boolean().optional(),
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
