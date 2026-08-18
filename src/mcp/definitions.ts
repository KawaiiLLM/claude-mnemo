import { z } from "zod";

import { NOTE_TOKEN_BUDGET } from "../shared/note-budget";
import {
  SEGMENT_EDITABLE_FIELDS,
  SEGMENT_WORKING_STATE_FIELDS,
} from "../shared/segment-fields";
import { MEMORY_TYPES } from "../shared/type-vocabulary";

// Ticket 05: hoisted above `MNEMO_TOOL_DESCRIPTIONS` (which quotes
// `WORKING_STATE_FIELD_LIST`) as well as `rememberInputShape` (which quotes
// `EDITABLE_FIELD_LIST`) — one source for each list, read by both the tool
// description prose and the per-field zod `.describe()`.
const EDITABLE_FIELD_LIST = SEGMENT_EDITABLE_FIELDS.join("/");
const WORKING_STATE_FIELD_LIST = SEGMENT_WORKING_STATE_FIELDS.join(", ");

// Ticket 04 (spec "Tools"): the one structured filter grammar shared by
// `recall` and `timeline` — mirrors `MemoryFilterInput` (mcp/memory-filter.ts)
// field-for-field. `.strict()` so an unrecognised filter key (e.g. the
// retired `project`) is a parse error, not a silent no-op.
export const memoryFilterShape = {
  type: z
    .string()
    .optional()
    .describe(
      "Exact match against one stored `type` value (a turn's type array, or a segment's).",
    ),
  tag: z
    .string()
    .optional()
    .describe(
      "Exact match against one whole `tags` array element, either namespace (bare or `topic:`-prefixed) — a prefix does not match.",
    ),
  session: z
    .union([z.string(), z.number()])
    .optional()
    .describe('Scope to one session: "S12" or bare "12"/12.'),
  time: z
    .string()
    .optional()
    .describe(
      "`-7d`/`-2w` (relative), `YYYY-MM-DD` (one day), or `YYYY-MM-DD..YYYY-MM-DD` (inclusive range).",
    ),
  file: z
    .string()
    .optional()
    .describe("Substring match against files_read + files_modified."),
};
export const memoryFilterSchema = z.object(memoryFilterShape).strict();

export const MNEMO_TOOL_DESCRIPTIONS = {
  // ticket 14 (spec K1): the segment addressing and `query=` participation
  // below were already load-bearing in the implementation before this
  // sentence existed — the description just never told the one reader who
  // needs it. K1's whole point is that a segment lets an agent avoid
  // rediscovering its own prior work; that only happens if `recall`'s own
  // description says the capability exists.
  recall:
    "Search past sessions for design rationale, rejected alternatives, decisions, and user corrections — the *why* behind the code, which source never records. For current behavior or mechanism, read the source first. Paginated index; hand off to the mnemo-replay skill for a turn's full untruncated text and tool I/O from the database (raw JSONL only for exact bytes). `id=\"E<n>\"` (also `E*`, `E1..9`) recalls the segment card — the accumulated impression of one arc of work, not a session or a turn — so check whether one already covers a task before redoing it: `[open]` is that task's still-live working state, `[delivered]` is its settled impression. `id=\"E<n>/T<m>\"` (also `E<n>/T*`, `E<n>/T3..7`) addresses the segment's own members by their 1-based EVENT-ORDER position — a navigation handle only, never a citation (cite the rendered `[S<session>][T<prompt>]` address instead, since a late-settling member shifts the ordinal). `depth` is a field-set switch: turns collapsed show prompt/title/content, expanded adds insight/response/observations; a segment collapsed shows its metadata header and counts with the newest field rows, expanded shows every row plus a member index. `query` is pure full-text search — it has no in-string dialect; a query containing `tag:foo` searches those literal characters. Use `filter` to scope by type/tag/session/time/file instead, AND-composed with `query` and with `id` alike. Bare `recall()` (no `id`, no `query`) lists segments before sessions. Segments also surface in `query=`/`filter` search alongside sessions and turns.",
  timeline:
    "Render the temporal/decision shape of a past session — gaps, tool bursts, compact boundary, broken-prompt candidates, and view-specific timeline bodies. Single-session view with range selectors plus page/pageSize pagination. Optional `view` selects `turns` (default turn table) or `milestones` (key chronological digest) — `phases` has retired. `filter` — the same structured grammar `recall` uses — AND-composes with the id selector's range to narrow which turns the current view considers.",
  // ticket 01 (spec "Note contract revision"): the field-level contract used
  // to live entirely in this one string — title's shape, content's admission
  // test, type's vocabulary, tags' noun order, the session's seven fields —
  // one blob no reader could jump into at the level their own field governs.
  // Every per-field rule now lives in that parameter's own zod `.describe()`
  // in `noteInputShape` below; THIS text keeps only what governs the CALL as
  // a whole — which address to use, when to call at all, what a citation may
  // point at, the relation procedure, markup, and the one-line English rule.
  // Capped by tests/mcp/definitions.test.ts, same as before.
  //
  // ticket 07 (spec C7) added four relation fields, and C4 makes the
  // procedure's exact wording normative — the four ordered questions, and
  // above all question 3's counterfactual — because the predecessor
  // vocabulary measured 61% precision at exactly the point where it was
  // softened to "used" or "built on". A paraphrase is not a cheaper version
  // of this text, it is the failure mode.
  note:
    "Write or correct a turn's note, or a session's title. Exactly one of `turn` (`S<session>/T<prompt>`, from the current-turn line, its owed suffix, or backlog relief — never recalled or invented) or `session` (`S<session>`). Timing: (1) note only FINISHED turns, never the one in progress; (2) owed addresses settle in this turn's FIRST tool batch, last among its calls — you cannot know which batch will be last, and a turn with no tool calls settles nothing; (3) a batch for notes alone only at 5+ owed, or to fix a note already written.\n" +
    "skip: true with `turn` alone, when a future retriever would find nothing unique — check: deleting it costs no decision, progress, or coherence. Content gone and not recovered is skipped, never invented. Never skip a user decision, correction, veto, or any turn with a conclusion, rejected option, or lesson.\n" +
    "Cite turns only as [S15069/T332], ids seen in injected context; never include <private> content.\n" +
    "Relations — evidenceFor/evidenceAgainst/supersedes/dependsOn: address lists; a target this write does not cite rejects the call. Four ordered questions, first yes wins: (1) Did the citing turn overturn it? → supersedes. (2) Did it test the claim, for or against? → evidenceFor/Against. (3) If the cited turn were wrong, would the citing turn's conclusion also be wrong? → dependsOn. (4) None → no relation. Never soften (3) to \"used\"/\"built on\".\n" +
    "Tool-call markup (`<parameter`, `<invoke`, …) in a field is rejected, nothing stored. Every field is written in English. A first note for a turn needs both title and content. Every parameter below carries its own contract.",
  // ticket 02 (ADR-0001/0002/0005): `remember` is the segment's write surface
  // — 记住 (semantic, cross-session), sibling to `note`'s 记录 (episodic,
  // per-turn). Revives the retired 0.x tool name, now scoped to segments only.
  // Per-verb parameter contracts live in `rememberInputShape`'s `.describe()`s
  // below, same split as `note`'s ticket 01 revision — this text keeps only
  // what governs the call as a whole.
  remember:
    `Maintain a segment — claude-mnemo's per-topic, long-lived semantic container (记住; \`note\` is the per-turn episodic surface, 记录). Five verbs: \`create\` mints a new segment from the roster you have in view — deliberate, never automatic, never a near-duplicate of an existing topic; \`attach\` binds the current session to a segment (by \`id="E<n>"\` or an existing topic name) and returns its full fields; \`append\` adds rows to one named field; \`replace\` finds \`oldString\` in one field and swaps in \`newString\` — ambiguous (matches more than once) or missing rejects loudly naming which, and \`newString: ""\` deletes the matched row; \`close\` toggles the segment off the roster (still \`recall\`-able) or, called again on an already-closed one, back on. Editable fields: ${WORKING_STATE_FIELD_LIST} (Working State) plus content, insight (summary) — each an uncapped markdown row list. A closed segment refuses append/replace, naming \`close\` as the way back. Rows may cite \`[S<session>/T<prompt>]\` or \`[E<n>]\`, ids seen in injected context only, never invented. Tool-call markup (\`<parameter\`, \`<invoke\`, …) is rejected, nothing stored. Every field is written in English.\n` +
    "Maintenance is advisory, never a gate: every append/replace reports turns since this segment was last touched — under 10 turns draws a too-soon reminder (a `decisions` append is exempt — a lost ruling is the costliest loss), 20+ turns without a touch draws a nudge on the next write.",
  // ticket 07 (ADR-0007, semantic-container): `check` retired outright — the
  // Stop hook and the completion gate already call the coverage predicate
  // (db/coverage.ts's `computeCoverageGaps`) directly, and this self-service
  // pull duplicated the same answer for no reader who could not already get
  // it another way. No replacement entry: the main agent has no tool here
  // any more, by design, not by omission.
} as const;

export const recallInputShape = {
  id: z.string().optional(),
  query: z
    .string()
    .optional()
    .describe(
      "Pure full-text search — no in-string dialect (a literal `tag:foo` searches those characters). Use `filter` for type/tag/session/time/file scoping.",
    ),
  // Ticket 04 (spec "Tools"): the one structured filter grammar, shared with
  // `timeline`. AND-composed with each other, with `id`, and with `query`.
  // Replaces the retired in-query prefix dialect AND the top-level `time`
  // param this shape used to carry (folded in as `filter.time`, same
  // grammar) — no non-test caller in this repo passed top-level `time`, so
  // it is cut clean rather than kept as a deprecated alias.
  filter: memoryFilterSchema.optional().describe(
    "Structured scoping — {type, tag, session, time, file} — AND-composed with each other, with `id`, and with `query`.",
  ),
  depth: z.enum(["collapsed", "expanded"]).optional(),
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().optional(),
  // Ticket 04: `truncate` retires from the public surface. The field stays
  // DEFINED (rather than simply omitted) so `recallInputSchema`'s superRefine
  // below can reject it with a message naming its replacements — an omitted
  // key would only ever produce zod's generic "unrecognized key" text, which
  // names nothing to point the caller at.
  truncate: z
    .number()
    .optional()
    .describe(
      "Retired — use `pageBudget` (segment cards) or `turn` (per-turn token cap) instead.",
    ),
  // ticket 03 (spec "Budgets"): the segment card's own token budget, default
  // 1000. Distinct from `page` above (still the 1-indexed page NUMBER) —
  // `page` doubles as this render's own overflow escape: page 1 is the
  // elided collapsed card, page ≥ 2 is the same card with every Working
  // State row shown, uncapped — "stable page 2" (never dropping content
  // silently), reached by asking for the next page rather than a different
  // parameter.
  pageBudget: z.number().int().positive().optional().describe(
    'Token budget for a segment card (id="E<n>") — default 1000. Over budget, the collapsed card elides the largest Working State field\'s oldest rows first (newest rows always visible), marked "… +N earlier"; ask for page 2 of the same id to see every row, uncapped.',
  ),
  turn: z.number().int().positive().optional().describe(
    "Per-turn token cap on every rendered turn (default: card-scale when depth is collapsed, uncapped when expanded).",
  ),
};

// SDK workers share recall's public selector grammar, but may request long
// fields — worker callers (diary, settlement) never go through
// `recallInputSchema`'s superRefine below, so `truncate` keeps working here
// exactly as before ticket 04.
export const workerRecallInputShape = {
  ...recallInputShape,
  truncate: z.number().int().min(1).optional(),
};

// D5/D5a: one mode vocabulary, shared by every field of both addressing
// surfaces. `.strict()` further down means an unrecognised key (a field this
// call's surface does not carry) is a parse error, not a silent drop.
//
// ticket 01 (ADR-0003): `grade` is REMOVED from this vocabulary along with
// the parameter itself — the writer records facts, the settlement subagent
// assigns value. A call still sending `grade` or `mode.grade` fails as a
// `.strict()` parse error; no custom message is added for it (unlike the
// retired session fields below), because there is nothing left to point the
// caller at — grade simply left this tool.
const fieldModeEnum = z.enum(["overwrite", "append"]);
const noteModeShape = z
  .object({
    title: fieldModeEnum.optional(),
    content: fieldModeEnum.optional(),
    insight: fieldModeEnum.optional(),
    type: fieldModeEnum.optional(),
    tags: fieldModeEnum.optional(),
  })
  .strict()
  .optional()
  .describe(
    'Required when the target field already holds something: "overwrite" replaces it whole, "append" adds to it (text: newline-joined; type/tags: unioned). Not required when the field is empty or omitted — omitting the field itself leaves it untouched. Clearing a nullable field (insight) needs the field set to null plus its mode set to "overwrite".',
  );

const TYPE_VOCABULARY_LIST = MEMORY_TYPES.join("/");

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
//
// ticket 01 (spec "Note contract revision"): every field's own admission test
// now lives in its `.describe()` here — the SINGLE home for that field's
// contract, so a reader who has the rendered schema in front of them (not
// just the tool description) can read a field's rule at the point they fill
// it in. `content`/`insight` stay in this one shared shape (turn AND session
// both used to accept them) but are now turn-only: `mcp/note.ts` refuses them
// by name on a session address, the same pattern `current` already used.
export const noteInputShape = {
  turn: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Address of a finished turn: `S<session>/T<prompt>`, from the current-turn line, its owed suffix, or backlog relief — never recalled or invented (see the tool description). Exactly one of `turn`/`session` is required.",
    ),
  session: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Address of a session: `S<session>`. The only field this call accepts is `title` — every other session field retired with the segment redesign. Exactly one of `turn`/`session` is required.",
    ),

  // Turn fields (title/session-shared with the session address).
  title: z
    .string()
    .nullable()
    .optional()
    .describe(
      `Turn (~${NOTE_TOKEN_BUDGET.title} tok): one English claim sentence — this turn's conclusion, standing alone in a title-only list. No activity/topic prefix (type/tags carry that). Name the decider when a ruling landed. No session-local codewords without a gloss. Session: a compressed label for this session, for another session browsing the roster.`,
    ),
  content: z
    .string()
    .nullable()
    .optional()
    .describe(
      `Turn only (~${NOTE_TOKEN_BUDGET.content} tok): assume the title was just read — expand, never restate. In order: the precision that makes the conclusion usable, each rejected alternative with a one-line reason, secondary conclusions, citations. Sentence deletion test: remove a sentence — if the conclusion's derivation still holds, cut it. No process narration (replay stores it). Rejected on a session address.`,
    ),
  insight: z
    .string()
    .nullable()
    .optional()
    .describe(
      `Turn only (~${NOTE_TOKEN_BUDGET.insight} tok, default omit): a task-scoped lesson under the episode-deletion test — delete the episode; does the sentence still teach someone useful prior knowledge? Rejected on a session address.`,
    ),
  type: z
    .array(z.string())
    .optional()
    .describe(
      `Closed vocabulary: ${TYPE_VOCABULARY_LIST} — omit or [] when none fit, never guess. Honesty rule: report the stage that actually happened — a design discussion with no ruling is discuss, not design.`,
    ),
  tags: z
    .array(z.string())
    .optional()
    .describe(
      "At least one coarse noun naming the project, then fine nouns for subsystems/artifacts. Never activities (type carries those), no -design/-fix hybrids. Reuse exact spellings already in use.",
    ),
  skip: z
    .boolean()
    .optional()
    .describe(
      "true to decline noting this turn instead of writing one — see the tool description's skip test. Valid only together with `turn`.",
    ),
  // spec D4: declares intent to write a turn outside the caller's own
  // session. No legitimate use exists today (every address a caller is ever
  // handed is its own session's) — this is a pure guardrail.
  crossSession: z
    .boolean()
    .optional()
    .describe(
      "true to confirm a write addressed at a turn outside the caller's own session; required whenever the address's session differs from the caller's, refused otherwise.",
    ),

  // ticket 07 (spec C1/C5/C7): one named field per relation, not a generic
  // `{turn, relation}` list — an illegal relation is structurally
  // unrepresentable. Targets are address tokens, `S<session>/T<prompt>` or
  // `E<segment>` (brackets optional), and each MUST already be named by
  // this same call's title/content/insight post-state — mcp/note.ts rejects
  // the whole call otherwise, it never silently drops one. No `mode`: unlike
  // title/tags/type there is no PRIOR value at this layer to append to or
  // overwrite, and `writeMemoryEdges`'s upsert (spec C14) already governs
  // replacing a relation the pair carries from an earlier write.
  evidenceFor: z
    .array(z.string())
    .optional()
    .describe(
      "Addresses this write's own body tests FOR its claim — see the tool description's four-question relation procedure.",
    ),
  evidenceAgainst: z
    .array(z.string())
    .optional()
    .describe(
      "Addresses this write's own body tests AGAINST its claim — see the tool description's four-question relation procedure.",
    ),
  supersedes: z
    .array(z.string())
    .optional()
    .describe(
      "Addresses this write's own body overturns — see the tool description's four-question relation procedure.",
    ),
  dependsOn: z
    .array(z.string())
    .optional()
    .describe(
      "Addresses this write's own conclusion depends on — see the tool description's four-question relation procedure.",
    ),

  mode: noteModeShape,
};

// ticket 02: one shape for all five `remember` verbs (D5/D5a's own
// discipline extended to the segment surface) — `.strict()` further down
// rejects a field a verb does not accept, e.g. `rows` on `attach`, the same
// way `noteInputSchema` rejects a session call sending `type`. Per-field
// verb scoping is enforced in `mcp/remember.ts`, not by a zod union: a
// union's error dump names no field, the same reasoning `note`'s
// `turn`/`session` dispatch already settled.
//
// ticket 05: `field`'s own enum widened from the six Working State fields to
// `SEGMENT_EDITABLE_FIELDS` — content/insight join the same append/replace
// mechanism (ADR-0001). `EDITABLE_FIELD_LIST`/`WORKING_STATE_FIELD_LIST` are
// declared above `MNEMO_TOOL_DESCRIPTIONS`, which quotes the latter too.
export const rememberInputShape = {
  verb: z
    .enum(["create", "attach", "append", "replace", "close"])
    .describe(
      "create: mint a new segment. attach: bind the current session to one. append: add rows to a field. replace: find/replace text within one field. close: toggle the segment off the roster (or, called again, back on).",
    ),
  id: z
    .string()
    .min(1)
    .optional()
    .describe(
      'attach/append/replace/close: the target segment — an "E<n>" address, or a topic name resolved through the topic registry (ambiguous — more than one segment on that topic — rejects, asking for the explicit "E<n>" address instead). Not used by create.',
    ),
  title: z
    .string()
    .min(1)
    .optional()
    .describe("create only (required): the segment's title, written in English."),
  topic: z
    .string()
    .min(1)
    .optional()
    .describe(
      "create only (required): the topic this segment belongs to. Reused verbatim when it already exists (search the roster before minting) — never assume a new name is needed.",
    ),
  goal: z
    .string()
    .min(1)
    .optional()
    .describe("create only, optional: a seed row for the new segment's `goal` field."),
  members: z
    .array(z.string())
    .optional()
    .describe(
      'create only, optional: seed member turn addresses ("S<session>/T<prompt>", as seen in context — from an approved proposal, never recalled or invented). Membership is recorded for exactly these turns; a call naming even one bad address seeds none.',
    ),
  field: z
    .enum(SEGMENT_EDITABLE_FIELDS)
    .optional()
    .describe(`append/replace only (required): which field — ${EDITABLE_FIELD_LIST}.`),
  rows: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'append only (required): one or more row texts to add, one line each — a leading "- " is added if you did not include it.',
    ),
  oldString: z
    .string()
    .min(1)
    .optional()
    .describe(
      "replace only (required): the exact existing text to find within `field` — missing or matching more than once rejects, naming which.",
    ),
  newString: z
    .string()
    .optional()
    .describe('replace only (required): the replacement text; "" deletes the matched text.'),
};

export const timelineInputShape = {
  id: z.string().min(1),
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().optional(),
  // Ticket 05: the view's token budget — the milestone view's size governor
  // and the turn view's pagination budget. Mirrors recall's field; interactive
  // default 1000 lives in timeline.ts, injections pass their own explicitly.
  pageBudget: z.number().int().positive().optional(),
  // Ticket 04: `phases` retires. Removing it from the enum outright (rather
  // than keeping it defined only to reject, as `truncate` below does) is
  // enough — zod's own invalid-enum message already names the surviving
  // options ("expected one of \"turns\"|\"milestones\""), so no custom
  // superRefine is needed to satisfy "parse error naming the two surviving
  // views".
  view: z.enum(["turns", "milestones"]).optional(),
  // Ticket 04 (spec "Tools"): the same structured filter grammar recall
  // carries, shared verbatim — AND-composed with the id selector's range.
  filter: memoryFilterSchema.optional().describe(
    "Structured scoping, shared with recall's `filter`: {type, tag, session, time, file}, AND-composed with the id selector's range.",
  ),
};

// Ticket 07 (ADR-0007, semantic-container): the settlement subagent's
// note-write surface. Reuses THIS shape's own field objects for every rule
// that is genuinely identical on both surfaces — type, tags, insight, and
// the four relation fields — so a contract change to one of those (a budget,
// a vocabulary word, a description) reaches both surfaces from a single
// edit here rather than needing a second, independently hand-kept copy
// (worker/note-settlement-turn-facade.ts used to carry exactly that copy).
// `title`/`content` are declared separately, on purpose: settlement's
// reconstruction is a whole-rewrite with no append mode and no null-clear
// (see that module's own doc comment), so `noteInputShape`'s nullable,
// append-aware pair does not describe the same operation and must not be
// shared. `turn`/`grade`/`tier` have no main-agent analogue at all (ADR-0003:
// grade/tier are settlement's alone to assign) and are declared fresh.
export const settlementNoteInputShape = {
  turn: z.string().min(1),
  title: z.string().optional(),
  content: z.string().optional(),
  insight: noteInputShape.insight,
  /** A legacy-era turn only (`src/election-era.ts`); mutually exclusive with `tier`. */
  grade: z.number().int().min(0).max(4).optional(),
  /** Election tier (ADR-0003) — a new-era turn only; mutually exclusive with `grade`. */
  tier: z.enum(["A", "B", "C"]).optional(),
  type: noteInputShape.type,
  tags: noteInputShape.tags,
  evidenceFor: noteInputShape.evidenceFor,
  evidenceAgainst: noteInputShape.evidenceAgainst,
  supersedes: noteInputShape.supersedes,
  dependsOn: noteInputShape.dependsOn,
};

// Ticket 04: `truncate` is defined on `recallInputShape` (above) purely so
// this refine can name its replacements — a `.strict()`-rejected unknown key
// would only ever carry zod's generic message. `workerRecallInputShape`
// never routes through THIS schema (worker call sites build their own
// `z.object(workerRecallInputShape)`), so the worker's long-field `truncate`
// is untouched by this rejection.
export const recallInputSchema = z
  .object(recallInputShape)
  .strict()
  .superRefine((data, ctx) => {
    if (data.truncate !== undefined) {
      ctx.addIssue({
        code: "custom",
        message:
          "`truncate` has retired — use `pageBudget` (segment cards) or `turn` (per-turn token cap) instead.",
        path: ["truncate"],
      });
    }
  });
export const timelineInputSchema = z.object(timelineInputShape).strict();
export const noteInputSchema = z.object(noteInputShape).strict();
export const rememberInputSchema = z.object(rememberInputShape).strict();
