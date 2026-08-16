import { z } from "zod";

import { NOTE_TOKEN_BUDGET } from "../shared/note-budget";

export const MNEMO_TOOL_DESCRIPTIONS = {
  // ticket 14 (spec K1): the segment addressing and `query=` participation
  // below were already load-bearing in the implementation before this
  // sentence existed — the description just never told the one reader who
  // needs it. K1's whole point is that a segment lets an agent avoid
  // rediscovering its own prior work; that only happens if `recall`'s own
  // description says the capability exists.
  recall:
    "Search past sessions for design rationale, rejected alternatives, decisions, and user corrections — the *why* behind the code, which source never records. For current behavior or mechanism, read the source first. Paginated index; hand off to the mnemo-replay skill for a turn's full untruncated text and tool I/O from the database (raw JSONL only for exact bytes). `id=\"E<n>\"` (also `E*`, `E1..9`) recalls a segment — the accumulated impression of one arc of work, not a session or a turn — so check whether one already covers a task before redoing it: `[open]` is that task's still-live working state, `[delivered]` is its settled impression. Segments also surface in `query=` search (text, `tag:`, `type:`) alongside sessions and turns.",
  timeline:
    "Render the temporal/decision shape of a past session — gaps, tool bursts, compact boundary, broken-prompt candidates, and view-specific timeline bodies. Single-session view with range selectors plus page/pageSize pagination. Optional `view` selects `turns` (default turn table), `milestones` (key chronological digest), or `phases` (phase overview).",
  // The per-field budgets are spliced in from `NOTE_TOKEN_BUDGET`, the constant
  // the receipt measures a write against, rather than restated as prose here.
  //
  // Single home of the note contract (user ruling, S15069 T586): fields,
  // budgets, the skip test and the mode vocabulary live HERE and nowhere else;
  // the SessionStart block (src/hooks/handlers/context-note-taking.ts) carries
  // only the batch-timing digest and points at this text. Capped by
  // tests/mcp/definitions.test.ts.
  //
  // ticket 03 (spec E1/D5/D5a): `note` and the retired `remember` are one tool
  // now, addressed by `turn` (a turn) XOR `session` (a session's summary).
  // Every field takes one rule: absent leaves it alone; present on an EMPTY
  // field just writes; present on a NON-empty field requires `mode.<field>` —
  // `"overwrite"` (replace whole) or `"append"` (add to it) — named once for
  // the caller, not spelled out per field below.
  //
  // ticket 07 (spec C7) added four relation fields, and the cap moved 500 →
  // 600 to pay for them (user decision, S15069/T717; the estimate put to
  // the user was +80 and the measured cost is +112, all of it procedure).
  // C4 makes that procedure's exact wording normative — the four ordered
  // questions, and
  // above all question 3's counterfactual — because the predecessor
  // vocabulary measured 61% precision at exactly the point where it was
  // softened to "used" or "built on". A paraphrase that fits 13 tokens of
  // headroom is therefore not a cheaper version of this text, it is the
  // failure mode; shipping the fields undocumented instead would have left
  // the main agent guessing in that same direction. The alternative
  // considered and rejected was moving the procedure to the SessionStart
  // injection, which is cheaper per turn but re-splits the contract T586
  // had just given one home.
  note:
    "Write or correct a turn's note, or a session's summary. Exactly one of `turn` (`S<session>/T<prompt>`, from the current-turn line, its owed suffix, or backlog relief — never recalled or invented) or `session` (`S<session>`). Timing: the SessionStart block's three rules. A non-empty field needs `mode.<field>`: `\"overwrite\"` replaces it whole, `\"append\"` adds (text: newline-joined; type/tags: unioned). Empty needs no mode; omitted stays untouched. Clearing (insight/grade/session fields) needs `null` + overwrite mode. Tool-call markup (`<parameter`, `<invoke`, …) in a field is rejected, nothing stored.\n" +
    "Turn — title (~" +
    NOTE_TOKEN_BUDGET.title +
    " tok): `<activity>+<topic>: <what this turn covered>`, the real stage. content (~" +
    NOTE_TOKEN_BUDGET.content +
    " tok): the conclusion, then the evidence chain — rejected alternatives with reasons; never restate the title, never narrate looking. A first note needs both title and content. insight (~" +
    NOTE_TOKEN_BUDGET.insight +
    " tok, default none): long-term knowledge orthogonal to the conclusion, claim first. type: discuss/research/design/implement/refactor/fix/measure/review/ops/delegate/correction — omit or [] when none fit, never guess. tags: bare topic words, no prefix. grade: 0-4. Receipt reports token counts and each touched field's post-write total; over budget, cut the next one. skip: true with `turn` alone, when a future retriever would find nothing unique — check: deleting it costs no decision, progress, or coherence. Content gone and not recovered is skipped, never invented. Never skip a user decision, correction, veto, or any turn with a conclusion, rejected option, or lesson. `crossSession: true` only for another session's turn. Cite turns only as [S15069/T332], ids seen in injected context; never include <private> content. Goes last in its batch.\n" +
    "Relations — evidenceFor/evidenceAgainst/supersedes/dependsOn: address lists; a target this write does not cite rejects the call. Four ordered questions, first yes wins: (1) Did the citing turn overturn it? → supersedes. (2) Did it test the claim, for or against? → evidenceFor/Against. (3) If the cited turn were wrong, would the citing turn's conclusion also be wrong? → dependsOn. (4) None → no relation. Never soften (3) to \"used\"/\"built on\".\n" +
    "Session — title/content: a compressed view for another session browsing this one. decision/done/current/next_steps/reference: this session's recent state. Fields may carry unattributed [S/T] citations.",
  // ticket 08 (spec G8): the coverage predicate pulled by the agent, not the
  // Stop hook (ticket 11) or the completion gate (ticket 09) — those call the
  // same underlying predicate (db/coverage.ts's `computeCoverageGaps`)
  // directly rather than through this tool. Own budget, own test in
  // definitions.test.ts — independent of note's own cap.
  check:
    "Ask what a session still owes before you believe you are finished — the same predicate the Stop hook and the completion gate check, so a clean answer here does not reopen later. Input: `id` (`S<session>`). Reports missing turns as bare addresses, never why — you already know why. An eligible turn is owed when it carries no stated `type`, unless it was skipped: skip is itself a verdict and counts as covered. Eligible excludes a compact marker and a slash command the harness answered with no model reply; a sidechain turn is included.",
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

// D5/D5a: one mode vocabulary, shared by every field of both addressing
// surfaces. `.strict()` further down means an unrecognised key (a field this
// call's surface does not carry) is a parse error, not a silent drop.
const fieldModeEnum = z.enum(["overwrite", "append"]);
const noteModeShape = z
  .object({
    title: fieldModeEnum.optional(),
    content: fieldModeEnum.optional(),
    insight: fieldModeEnum.optional(),
    type: fieldModeEnum.optional(),
    tags: fieldModeEnum.optional(),
    grade: fieldModeEnum.optional(),
    decision: fieldModeEnum.optional(),
    done: fieldModeEnum.optional(),
    current: fieldModeEnum.optional(),
    next_steps: fieldModeEnum.optional(),
    reference: fieldModeEnum.optional(),
  })
  .strict()
  .optional();

// ticket 03 (spec E1): `note` and the retired `remember` are one tool. Exactly
// one of `turn` / `session` addresses the write — enforced in `noteTool`
// rather than a zod union, so a caller supplying neither or both gets one
// readable `Parameter error:` naming the mistake instead of zod's union
// dump. Every field below (spec D5/D5a) is: omitted → left alone; present on
// an empty field → written directly; present on a non-empty field → requires
// `mode.<field>`. `type`'s own empty/clear state is `[]` (spec B7), so it
// carries no separate nullable — every other field is `.nullable()` because
// an explicit `null` is its clear expression once `mode.<field>: "overwrite"`
// authorises it (turn `title`/`content` reject `null` at the tool layer: the
// note's shadow record requires them non-null, so "clearing" one is not an
// operation this tool can express).
//
// Structured causal edges are no longer a caller input (spec C6): a bare
// `[S<session>/T<n>]` in a citation-bearing field IS the citation — see
// recomputeTurnCitedPairs (db/citations.ts) and updateSessionFields
// (db/sessions.ts). The earlier `cites` field (a `{id, relation}` list with no
// prose backing it) is REMOVED, not carried into the merged tool.
export const noteInputShape = {
  turn: z.string().min(1).optional(),
  session: z.string().min(1).optional(),

  // Turn fields.
  title: z.string().nullable().optional(),
  content: z.string().nullable().optional(),
  insight: z.string().nullable().optional(),
  type: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  grade: z.number().int().min(0).max(4).nullable().optional(),
  skip: z.boolean().optional(),
  // spec D4: declares intent to write a turn outside the caller's own
  // session. No legitimate use exists today (every address a caller is ever
  // handed is its own session's) — this is a pure guardrail.
  crossSession: z.boolean().optional(),

  // ticket 07 (spec C1/C5/C7): one named field per relation, not a generic
  // `{turn, relation}` list — an illegal relation is structurally
  // unrepresentable. Targets are address tokens, `S<session>/T<prompt>` or
  // `E<segment>` (brackets optional), and each MUST already be named by
  // this same call's title/content/insight post-state — mcp/note.ts rejects
  // the whole call otherwise, it never silently drops one. No `mode`: unlike
  // title/tags/type there is no PRIOR value at this layer to append to or
  // overwrite, and `writeMemoryEdges`'s upsert (spec C14) already governs
  // replacing a relation the pair carries from an earlier write.
  evidenceFor: z.array(z.string()).optional(),
  evidenceAgainst: z.array(z.string()).optional(),
  supersedes: z.array(z.string()).optional(),
  dependsOn: z.array(z.string()).optional(),

  // Session fields (D2/D4 — seven fields; ticket 04 trims the set).
  decision: z.string().nullable().optional(),
  done: z.string().nullable().optional(),
  current: z.string().nullable().optional(),
  next_steps: z.string().nullable().optional(),
  reference: z.string().nullable().optional(),

  mode: noteModeShape,
};

export const timelineInputShape = {
  id: z.string().min(1),
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().optional(),
  view: z.enum(["turns", "milestones", "phases"]).optional(),
};

// ticket 08 (spec G8): `id` addresses a whole session (`S<session>`) — the
// predicate itself (db/coverage.ts) takes a bare turn-id list and does not
// care how a caller assembled it; this tool's own choice is "the caller's
// whole session", the shape a live agent asking about its own work has on
// hand without a range to compute.
export const checkInputShape = {
  id: z.string().min(1),
};

export const recallInputSchema = z.object(recallInputShape).strict();
export const timelineInputSchema = z.object(timelineInputShape).strict();
export const noteInputSchema = z.object(noteInputShape).strict();
export const checkInputSchema = z.object(checkInputShape).strict();
