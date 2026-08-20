import { z } from "zod";

import { RECALL_TURN_FIELD_NAMES } from "./memory-filter";
import { NOTE_TOKEN_BUDGET } from "../shared/note-budget";
import {
  SEGMENT_EDITABLE_FIELDS,
  SEGMENT_WORKING_STATE_FIELDS,
} from "../shared/segment-fields";
import { MEMORY_TYPES } from "../shared/type-vocabulary";

// Ticket 05: hoisted above `MNEMO_TOOL_DESCRIPTIONS`, which quotes
// `WORKING_STATE_FIELD_LIST` — one source for the list, read by both the tool
// description prose and (ticket 01, field-semantics spec) `rememberInputShape`'s
// `field` parameter, which now carries each editable field's own one-line
// definition instead of this bare slash-joined name list.
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
  // Ticket 07 (read-write-contract spec, "视图(读面)"): field selection
  // replaces the collapsed/expanded depth switch — any combination of turn
  // fields, in any order. Not a scoping criterion: `filter: { fields: [...] }`
  // alone does not force bare `recall()` off the browse path.
  fields: z
    .array(z.enum(RECALL_TURN_FIELD_NAMES))
    .optional()
    .describe(
      `Which turn fields to render, any combination — replaces the collapsed/expanded field-set switch. One of: ${RECALL_TURN_FIELD_NAMES.join(", ")}.`,
    ),
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
    "Search past sessions for design rationale, rejected alternatives, decisions, and user corrections — the *why* behind the code, which source never records. For current behavior or mechanism, read the source first. The injected blocks are an index, not the memory — never conclude a fact is unrecorded because no injected block carries it. Materializing memory into a durable artifact (spec, ticket, doc, summary): any ruling you cannot quote verbatim — especially one from behind a compact — comes from recall/replay first, never from summary memory. Paginated index; hand off to the mnemo-replay skill for a turn's full untruncated text and tool I/O from the database (raw JSONL only for exact bytes). `id` also accepts a comma-separated list of same-kind addresses (e.g. `id=\"E31, E32\"` or `id=\"S12, S15\"`) — each item parses through the same grammar below, renders in order, and shares this call's page/turn budgets; mixed address kinds or any one invalid item rejects the whole call. `id=\"E<n>\"` (also `E*`, `E1..9`) recalls the segment card — the accumulated impression of one arc of work, not a session or a turn — so check whether one already covers a task before redoing it: `[open]` is that task's still-live working state, `[delivered]` is its settled impression. `id=\"E<n>/T<m>\"` (also `E<n>/T*`, `E<n>/T3..7`) addresses the segment's own members by their 1-based EVENT-ORDER position — a navigation handle only, never a citation (cite the rendered `[S<session>][T<prompt>]` address instead, since a late-settling member shifts the ordinal). `filter.fields` is the one field-selection knob: pick any combination of turn fields (default title, content); a segment card (`id=\"E<n>\"`) shows its metadata header and counts with the newest field rows on page 1, every row plus a member index from page 2 on (`page` selects that, not a field). Body size is controlled by exactly two token budgets — `pageBudget` (page overflow → another page, never a truncated block) and `turn` (per-item cap on every rendered session/turn/observation, word-boundary cut). Reading also LICENSES writing back what you read: a `write` over a field another writer filled needs this read to have delivered THAT field untruncated — raise `turn` (or `pageBudget` on a segment card) and re-read if it came back cut. Since the default fields are title/content and a turn's `type`/`tags` ride the metadata line instead, correcting either of those needs `filter={fields:[\"metadata\"]}` first. `edit` needs a current read, never a complete one. `query` is pure full-text search — it has no in-string dialect; a query containing `tag:foo` searches those literal characters. Use `filter` to scope by type/tag/session/time/file instead, AND-composed with `query` and with `id` alike. Bare `recall()` (no `id`, no `query`) lists segments before sessions. Segments also surface in `query=`/`filter` search alongside sessions and turns.",
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
  //
  // ticket 09 (edge-ownership-impl, "结算顺手维护 session 叙事"): `session`
  // retired from this call outright — session has no main-agent writer any
  // more (three layers, three writers: turn/segment stay the main agent's,
  // session moved to settlement's staged-commit channel, [S15069/T910]–
  // [T913]). The opening sentence and address clause below no longer
  // mention it.
  //
  // ticket 11 (edge-ownership-impl, "统一 Memory Rubric"): the six ordered
  // relation questions this string used to inline ARE judgment — [S15069/
  // T933]/[T937]–[T939] peer discussion settled a three-way split (format on
  // each parameter's own `.describe()`, timing/frequency here, judgment in
  // the Memory Rubric alone) and this was the one piece of judgment still
  // sitting on the call-level description rather than the rubric. What
  // remains here is the call-level POINTER plus the FORMAT facts a rubric
  // cannot state (turn-only, an uncited target rejects the call) — the
  // single-home grep guard (tests/shared/memory-rubric.test.ts) asserts the
  // judgment prose itself appears nowhere on this surface.
  note:
    "Write or correct a turn's note. `turn` (`S<session>/T<prompt>`, from the current-turn line or backlog relief — never recalled or invented). Timing: (1) note only FINISHED turns, never the one in progress; (2) a batch of note/skip calls alone opens when backlog relief appears, or to fix a note already written — never just to write one turn's note early.\n" +
    "skip: true with `turn` alone, when a future retriever would find nothing unique — check: deleting it costs no decision, progress, or coherence. Content gone and not recovered is skipped, never invented. Never skip a user decision, correction, veto, or any turn with a conclusion, rejected option, or lesson.\n" +
    "Cite turns only as [S15069/T332], ids seen in injected context; never include <private> content.\n" +
    "Relations — evidenceFor/evidenceAgainst/groundedOn/refines/override/encodes/dependsOn: turn-only address lists; an uncited target rejects the call. Which relation, if any — the judgment — lives in the Memory Rubric (SessionStart injection); this call only enforces the address/citation shape.\n" +
    "Tool-call markup (`<parameter`, `<invoke`, …) in a field is rejected, nothing stored. Every field is written in English. A first note for a turn needs both title and content. Every parameter below carries its own contract.",
  // ticket 02 (ADR-0001/0002/0005): `remember` is the segment's write surface
  // — 记住 (semantic, cross-session), sibling to `note`'s 记录 (episodic,
  // per-turn). Revives the retired 0.x tool name, now scoped to segments only.
  // Per-verb parameter contracts live in `rememberInputShape`'s `.describe()`s
  // below, same split as `note`'s ticket 01 revision — this text keeps only
  // what governs the call as a whole.
  remember:
    `Maintain a segment — claude-mnemo's long-lived, per-task semantic container (记住; \`note\` is the per-turn episodic surface, 记录). Six verbs: \`create\` mints a new segment from the roster you have in view (create-or-not and reuse-before-new: the Memory Rubric's 建段 section); \`attach\` binds the current session to a segment (\`id="E<n>"\`) and returns its collapsed card; \`write\` replaces one field's value whole; \`edit\` finds \`oldString\` in one field and swaps in \`newString\` — ambiguous or missing rejects loudly naming which, \`newString: ""\` deletes the matched text; \`close\` toggles the segment off the roster, or, called again, back on; \`assign\` places \`turns\` (addresses or one \`T<a>..T<b>\` interval) into \`id\`, single ownership — or clears ownership if \`id\` is omitted. Editable fields: ${WORKING_STATE_FIELD_LIST} (Working State) plus content, insight (summary) — each an uncapped markdown row list. Add a row by anchoring \`edit\` on the last row (oldString = it, newString = it + the new line); reordering or a full rewrite is \`write\`. A closed segment refuses write/edit, naming \`close\` as the way back. Rows may cite \`[S<session>/T<prompt>]\`/\`[E<n>]\`, ids seen in context only, never invented. Tool-call markup (\`<parameter\`, \`<invoke\`, …) is rejected, nothing stored. Every field is written in English.\n` +
    "Maintenance is advisory, never a gate: every write/edit reports turns since this segment was last touched.\n" +
    "20-turn reminder: check membership, Working State, whether to create or attach — judgment lives in the Memory Rubric, not here.",
  // ticket 07 (ADR-0007, semantic-container): `check` retired outright — the
  // Stop hook and the completion gate already call the coverage predicate
  // (db/coverage.ts's `computeCoverageGaps`) directly, and this self-service
  // pull duplicated the same answer for no reader who could not already get
  // it another way. No replacement entry: the main agent has no tool here
  // any more, by design, not by omission.
} as const;

export const recallInputShape = {
  id: z
    .string()
    .optional()
    .describe(
      'Selector: "S12" | "S12/T3" | "S12/T3..7" | "S12/T3/O*" | "E31" | "E31/T2..5" | "O87" | bare "T418" (global DB id). A range\'s second endpoint may repeat the kind letter ("T3..T7" ≡ "T3..7"); comma-separated lists of one kind allowed.',
    ),
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
  // Ticket 11 (read-write-contract spec, "视图(读面)"): the collapsed/expanded
  // depth switch retires — the field stays DEFINED only so
  // `recallInputSchema`'s superRefine below can reject a supplied value with
  // a message naming its replacement, the same precedent `truncate` already
  // set. Detail is expressed entirely through `filter.fields` now.
  view: z
    .enum(["collapsed", "expanded"])
    .optional()
    .describe("Retired — select which turn fields to show via `filter.fields` instead."),
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().optional(),
  // Ticket 04/11: `truncate` retires from the public surface (ticket 11 also
  // drops the worker-only exemption that used to keep it working there — see
  // `workerRecallInputShape`'s own comment). The field stays DEFINED (rather
  // than simply omitted) so `recallInputSchema`'s superRefine below can
  // reject it with a message naming its replacements — an omitted key would
  // only ever produce zod's generic "unrecognized key" text, which names
  // nothing to point the caller at.
  truncate: z
    .number()
    .optional()
    .describe(
      "Retired — use `pageBudget` (page overflow) or `turn` (per-item token cap) instead.",
    ),
  // Spec "预算" ([S15069/T919] ruling, describe migrated per the peer's
  // budget-contract-drift finding): pageBudget is the PAGE-level token
  // budget on every listing surface, not a segment-card-only knob — the old
  // card-scoped wording taught callers the wrong contract for bare
  // recall()/search, and its "newest rows always visible" claim contradicted
  // the ticket-08 eviction ruling.
  pageBudget: z.number().int().positive().optional().describe(
    'Page-level token budget, default 1000: every listing surface packs items into a page against it, and overflow starts the NEXT page — never a truncated block mid-page. On a segment card (id="E<n>") page 1 additionally elides field rows oldest-first against it, marked "… +N earlier"; page 2 renders every row uncapped.',
  ),
  // Ticket 11: the ONE per-item size knob left, alongside `pageBudget` — no
  // more depth-dependent default. Applies to every rendered session, turn,
  // and observation block; a caller widening `filter.fields` beyond the
  // default (title, content) should usually raise this too, or the extra
  // fields mostly get cut by the unchanged default budget.
  turn: z.number().int().positive().optional().describe(
    "Per-item token cap on every rendered session/turn/observation block (default 150, word-boundary cut). Raise it when `filter.fields` selects more turn fields than the default.",
  ),
};

// Ticket 11: workers share recall's public selector grammar UNCHANGED — the
// prior worker-only exemption keeping `truncate` alive here (`min(1)`,
// unrejected) retired along with the character-cap mechanism it fed. A
// worker caller wanting a bigger render now raises `turn`/`pageBudget`, the
// same two knobs every other caller has.
export const workerRecallInputShape = {
  ...recallInputShape,
};

// Ticket 05 (write-mode-edit-semantics, spec D1/D3/D10/D14): one mode
// vocabulary, shared by every field of both addressing surfaces (`note` and
// `remember`) — `write` replaces a field whole, the edit form
// `{ mode: "edit", oldString, newString }` swaps an exactly-matched span
// within it. `append`/`overwrite` retired. `.strict()` further down means an
// unrecognised key (a field this call's surface does not carry) is a parse
// error, not a silent drop.
//
// ticket 01 (ADR-0003): `grade` is REMOVED from this vocabulary along with
// the parameter itself — the writer records facts, the settlement subagent
// assigns value. A call still sending `grade` or `mode.grade` fails as a
// `.strict()` parse error; no custom message is added for it (unlike the
// retired session fields below), because there is nothing left to point the
// caller at — grade simply left this tool.
const fieldEditModeShape = z
  .object({
    mode: z.literal("edit"),
    oldString: z.string(),
    newString: z.string(),
  })
  .strict();

// Ticket 05 (spec D14): the retired literals ("overwrite", "append") stay
// declared as accepted union members ON PURPOSE — a caller sending one
// parses successfully at the base-shape level, so `noteInputSchema`'s
// `superRefine` below (which walks `mode`'s per-field entries) can reject it
// with a message naming its replacement, the same precedent the retired
// `topic`/`truncate`/`view` parameters already set, rather than zod's
// generic union error naming nothing.
const fieldModeValueShape = z.union([
  z.literal("write"),
  z.literal("overwrite"),
  z.literal("append"),
  fieldEditModeShape,
]);
const noteModeShape = z
  .object({
    title: fieldModeValueShape.optional(),
    content: fieldModeValueShape.optional(),
    insight: fieldModeValueShape.optional(),
    type: fieldModeValueShape.optional(),
    tags: fieldModeValueShape.optional(),
  })
  .strict()
  .optional()
  .describe(
    'Required when the target field already holds something: "write" replaces it whole (type/tags: the full replacement set — the edit form has no meaning on a set field). The edit form `{ mode: "edit", oldString, newString }` swaps an exactly-matched span within a text field ("" deletes the match); missing or ambiguous rejects loudly naming which. Not required when the field is empty or omitted — omitting the field itself leaves it untouched. Clearing a nullable field (insight) needs the field set to null plus its mode set to "write". A "write" landing over content ANOTHER writer put there additionally requires that your authorizing read delivered THAT field untruncated: for title/content/insight, a recall with a big enough `turn` cap; for type/tags, `recall(id="S<n>/T<m>", filter={fields:["metadata"]})` specifically — a plain recall renders title/content and never those two, so it earns nothing for them. Your own content and an empty field are exempt, and the edit form never needs a complete read at all.',
  );

// Ticket 05 (spec D14): shared by `noteInputSchema`'s superRefine below.
const RETIRED_NOTE_MODE_LITERAL_MESSAGE: Record<string, string> = {
  overwrite: 'use "write" instead.',
  append:
    'use "write" to replace the field whole, or the edit form ({ mode: "edit", oldString, newString }) to change part of it.',
};
// Ticket 05 (spec D4): type/tags are set fields — mirrors note.ts's own
// `NOTE_SET_MODE_FIELDS`, kept as a small local literal rather than a
// cross-file import since both sides are two-element and the coupling risk
// is lower than the import.
const NOTE_SET_MODE_FIELDS = new Set(["type", "tags"]);

const TYPE_VOCABULARY_LIST = MEMORY_TYPES.join("/");

// ticket 03 (spec E1): `note` and the retired `remember` are one tool. Exactly
// one of `turn` / `session` addresses the write — enforced in `noteTool`
// rather than a zod union, so a caller supplying neither or both gets one
// readable `Parameter error:` naming the mistake instead of zod's union
// dump. Every field below (spec D5/D5a) is: omitted → left alone; present on
// an empty field → written directly; present on a non-empty field → requires
// `mode.<field>`. `type`'s own empty/clear state is `[]` (spec B7), so it
// carries no separate nullable — every other field is `.nullable()` because
// an explicit `null` is its clear expression once `mode.<field>: "write"`
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
// it in.
//
// ticket 09 (edge-ownership-impl, "结算顺手维护 session 叙事"): the `session`
// address RETIRES from this shape outright — session has no main-agent
// writer any more (three layers, three writers: turn/segment = main agent,
// session = settlement, [S15069/T910]–[T913]). A caller still sending
// `session` is `.strict()`'s ordinary unrecognised-key parse error at the
// schema layer (there is nothing left on THIS schema to point it at — same
// treatment ADR-0003's retired `grade` already gets); `mcp/note.ts`'s
// `noteTool()` entry point additionally names settlement as the field's new
// writer for a caller that bypasses the schema (the same belt-and-braces
// pattern `current`/`RETIRED_SESSION_FIELD` used before this ticket retired
// that check along with the rest of the session address).
export const noteInputShape = {
  turn: z
    .string()
    .min(1)
    .describe(
      "Address of a finished turn: `S<session>/T<prompt>`, from the current-turn line or backlog relief — never recalled or invented (see the tool description).",
    ),

  // Turn fields. (ticket 09: `title` is turn-only now — the session address
  // this describe used to also govern retired outright; settlement writes
  // the session's own title/content through its own staged-commit channel.)
  title: z
    .string()
    .nullable()
    .optional()
    .describe(
      `Turn (~${NOTE_TOKEN_BUDGET.title} tok): the INDEX, not the conclusion — one English sentence saying what this turn is doing, standing alone in a title-only list, enough to recognise it among titles alone. No activity/topic prefix (type/tags carry that). Name the decider when a ruling landed. No session-local codewords without a gloss. Length tracks this turn's output, not the effort spent.`,
    ),
  content: z
    .string()
    .nullable()
    .optional()
    .describe(
      `Turn only (~${NOTE_TOKEN_BUDGET.content} tok): the CONCLUSIONS — assume the title was just read, expand, never restate. Every useful decision this turn produced, each rejected alternative with a one-line reason, secondary conclusions, citations. Sentence deletion test: remove a sentence — if a decision's derivation still holds without it, cut it. No process narration (replay stores it). Length tracks this turn's output, not the effort spent — long when the turn produced a lot, terse when it produced little. Lead with the conclusions: a reader's budget cuts the tail, so whatever only supports a decision comes after it.`,
    ),
  insight: z
    .string()
    .nullable()
    .optional()
    .describe(
      `Turn only (~${NOTE_TOKEN_BUDGET.insight} tok, default omit): REUSABLE experience, not a conclusion of this turn — a task-scoped lesson under the episode-deletion test: delete the episode; does the sentence still teach someone useful prior knowledge?`,
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
  // title/tags/type there is no PRIOR value at this layer to write over or
  // edit — a relation write only ever ADDS a row (edge-mechanism-revision
  // D2), and removing one is a retraction, not a mode.
  evidenceFor: z
    .array(z.string())
    .optional()
    .describe(
      "Addresses this write's own body tests FOR its claim — see the tool description's relation procedure. Turn-only; requires an evidence-phase (research/measure) source and a decision-phase (design/discuss/correction) target.",
    ),
  evidenceAgainst: z
    .array(z.string())
    .optional()
    .describe(
      "Addresses this write's own body tests AGAINST its claim — see the tool description's relation procedure. Turn-only; requires an evidence-phase (research/measure) source and a decision-phase (design/discuss/correction) target.",
    ),
  // ticket 01 (turn-edge-mechanism spec, [S15069/T935] mid-flight amendment):
  // `groundedOn` — a decision rests on an earlier finding, evidence-phase OR
  // delivery-phase (a review/audit finding grounds a decision the same as a
  // research finding). Recorded but excluded from every scoring surface —
  // see `shared/turn-phase.ts`'s `UNSCORED_RELATIONS`.
  groundedOn: z
    .array(z.string())
    .optional()
    .describe(
      "Addresses the earlier finding this write's own decision rests on — counterfactual: if that finding were false, this decision would fall. Decision-phase (design/discuss/correction) source; evidence-phase (research/measure) OR delivery-phase (implement/refactor/fix/delegate/review/ops) target. Recorded, never scored.",
    ),
  // ticket 01 (turn-edge-mechanism spec): `refines`/`override` replace the
  // retired `supersedes` — a decision-phase turn's relation to a
  // decision-phase predecessor, split by whether the predecessor's
  // conclusion survives IN PART (`refines`) or not AT ALL (`override`).
  // `supersedes` itself is REMOVED from this shape outright: a caller still
  // sending it gets `.strict()`'s parse error, naming the unrecognised key —
  // existing `supersedes` EDGES stay frozen-readable (db/citations.ts), only
  // the write parameter is gone.
  // ticket 11 (edge-ownership-impl): `refines`/`override`'s own discriminator
  // — "if the predecessor's any sub-conclusion still holds, use refines" —
  // moved to the Memory Rubric's 关系 section (single home for judgment;
  // [S15069/T933]/[T939]). What stays here is FORMAT only: the phase pair
  // both ends require, and a pointer to where the choice between the two is
  // actually made.
  refines: z
    .array(z.string())
    .optional()
    .describe(
      "Addresses a predecessor decision this write's own body continues or partially revises — decision-phase turns only (design/discuss/correction) on both ends; the predecessor is not wholly wrong. Judgment (refines vs. override) lives in the Memory Rubric.",
    ),
  override: z
    .array(z.string())
    .optional()
    .describe(
      "Addresses a predecessor decision this write's own body overturns WHOLE — decision-phase turns only (design/discuss/correction) on both ends. Judgment (refines vs. override) lives in the Memory Rubric.",
    ),
  // ticket 01: `encodes` — a delivery-phase turn (spec/ADR/ticket/commit/
  // release) naming the decision(s) it carries. Ticket 11: the minimal-set
  // discriminator moved to the Memory Rubric (关系, question ④) — this
  // describe keeps the format fact (self-asserted, not mechanically checked)
  // and a pointer, not the rule itself.
  encodes: z
    .array(z.string())
    .optional()
    .describe(
      "Addresses the decision(s) this write's own artifact (spec/ADR/ticket/commit/release) carries — a delivery-phase turn (implement/refactor/fix/delegate/review/ops) citing a decision-phase (design/discuss/correction) target. Self-asserted, not mechanically checked; which decisions to name (the minimal set) is judgment — see the Memory Rubric.",
    ),
  dependsOn: z
    .array(z.string())
    .optional()
    .describe(
      "Addresses this write's own conclusion depends on — see the tool description's relation procedure. Turn-only; requires a delivery-phase (implement/refactor/fix/delegate/review/ops) source and target.",
    ),
  // ticket 01 (turn-edge-mechanism spec): `supersedes` retired from the NOTE
  // TOOL's own surface — `noteInputSchema` below `.omit()`s this key, so a
  // caller sending it gets `.strict()`'s parse error naming the unrecognised
  // key, same as any other retired field. Ticket 08 (edge-ownership-impl)
  // retired settlement's own write of it too — `settlementNoteInputShape` no
  // longer reuses this field object, so it now has NO reuser at all. It stays
  // declared, unexported from the schema, purely as frozen documentation of
  // the word this project once wrote and no longer does; `db/citations.ts`'s
  // `CITATION_RELATIONS` is where the READ-side legacy value actually lives.
  supersedes: z
    .array(z.string())
    .optional()
    .describe(
      "Retired on the note tool (ticket 01) — use refines/override instead. Present here only for settlement's own surface.",
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
// `SEGMENT_EDITABLE_FIELDS` — content/insight join the same write/edit
// mechanism (ADR-0001). `WORKING_STATE_FIELD_LIST` is declared above
// `MNEMO_TOOL_DESCRIPTIONS`, which quotes it.
//
// ticket 05 (write-mode-edit-semantics, spec D1/D14): `append`/`replace`
// retire as verbs, replaced by `write` (whole-field replacement, D11's new
// capability on this surface) and `edit` (ticket 05's rename of `replace` —
// identical oldString/newString shape). The retired two literals stay
// declared as accepted enum members ON PURPOSE — a caller sending one
// parses successfully, so `rememberInputSchema`'s `superRefine` below can
// reject it with a message naming its replacement instead of zod's generic
// enum error, the same precedent this schema's own retired `topic` already
// set.
export const rememberInputShape = {
  verb: z
    .enum(["create", "attach", "write", "edit", "close", "assign", "append", "replace"])
    .describe(
      'create: mint a new segment. attach: bind the current session to one. write: replace one field\'s value whole (`value`; null or "" clears it). edit: find `oldString` in one field and swap in `newString`. close: toggle the segment off the roster (or, called again, back on). assign: place turns into a segment (id set) or clear their ownership (id omitted).',
    ),
  id: z
    .string()
    .min(1)
    .optional()
    .describe(
      'attach/write/edit/close: the target segment — an "E<n>" address only. assign: the same, but OPTIONAL — omit entirely to clear ownership on `turns` instead of placing them. Not used by create.',
    ),
  title: z
    .string()
    .min(1)
    .optional()
    .describe("create only (required): the segment's title, written in English."),
  // Ticket 15 (topic registry retirement, CONTEXT.md "Topic — retired"): the
  // registry this once named a segment into folded into tags — a
  // mechanism-level synonym split. Declared here ONLY so `rememberInputSchema`'s
  // superRefine below can reject a caller still sending it with a message
  // naming the retirement and pointing at tags, the same precedent
  // `recallInputSchema`'s retired `truncate`/`view` set.
  topic: z
    .string()
    .optional()
    .describe(
      "Retired — the topic registry folded into tags; name the segment's theme as a `note` tag on its member turns instead.",
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
  // Ticket 01 (field-semantics spec, "Fields" table): each of the eight
  // editable fields gets its own one-line definition here, aligned with the
  // definition table the Memory Rubric injects — this parameter is the one
  // place a `remember` caller sees the field list rendered with its own
  // schema, the same reasoning `noteInputShape`'s per-field `.describe()`s
  // already follow.
  field: z
    .enum(SEGMENT_EDITABLE_FIELDS)
    .optional()
    .describe(
      "write/edit only (required): which field. Working State — " +
        "goal: what this task is trying to achieve. " +
        "constraints: how the work must be done — norms, habits, standing preferences. " +
        "decisions: concrete rulings about the task itself, settled and binding. " +
        "done: what is finished and verified. " +
        "next_steps: what is waiting to be done. " +
        "reference: durable pointers — source locations, specs, PRs, URLs; not plans. " +
        "Summary — content: the impression this arc leaves, what it is about and how it went. " +
        "insight: reusable experience this task has settled.",
    ),
  // Ticket 05: `write`'s own payload — the field's WHOLE replacement text,
  // supplied verbatim (no automatic "- " row prefixing, unlike the retired
  // `append`'s `rows`). `null` (or an all-whitespace string) clears the
  // field.
  value: z
    .string()
    .nullable()
    .optional()
    .describe(
      "write only (required): the field's full replacement text; null (or an all-whitespace string) clears it. Supplied verbatim — compose the finished markdown yourself (read the field, edit the text, write it back).",
    ),
  oldString: z
    .string()
    .min(1)
    .optional()
    .describe(
      "edit only (required): the exact existing text to find within `field` — missing or matching more than once rejects, naming which.",
    ),
  newString: z
    .string()
    .optional()
    .describe('edit only (required): the replacement text; "" deletes the matched text.'),
  // ticket 02 (ownership-and-note-cadence spec): `assign`'s own turn
  // selector — an interval OR a list, one array parameter for both shapes.
  turns: z
    .array(z.string())
    .optional()
    .describe(
      'assign only (required): turn addresses ("S<session>/T<prompt>") or one interval ("S<session>/T<a>..T<b>", inclusive; the second T is optional) — as seen in context, never recalled or invented. An interval spanning even one missing turn rejects the whole call, naming which; nothing is assigned.',
    ),
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
// the relation fields — so a contract change to one of those (a budget,
// a vocabulary word, a description) reaches both surfaces from a single
// edit here rather than needing a second, independently hand-kept copy
// (worker/note-settlement-turn-facade.ts used to carry exactly that copy).
// `title`/`content` are declared separately for ONE remaining reason: they
// are non-nullable here (settlement corrects a field, it never clears one),
// so `noteInputShape`'s `.nullable()` pair does not describe the same
// operation. The write MODE is no longer a difference — both surfaces share
// the `mode` object below. `turn` has no main-agent analogue at all and is
// declared fresh.
//
// Ticket 06 (ownership-and-note-cadence spec, "选举机器拆除"): `tier`
// (ADR-0003's election A/B/C) is RETIRED — settlement no longer assigns a
// tier to any turn.
//
// Ticket 02 (view-render-repair spec, "grading retires whole", ruled at
// [S15069/T1035]): `grade` is RETIRED from this shape too — settlement no
// longer assigns a G0-4 grade either, the same "writer records facts,
// nobody left assigns value" retirement the main `note` tool's own `grade`
// already got (ADR-0003, `noteInputShape` above). A call still sending
// `grade` is `.strict()`'s ordinary unrecognised-key parse error, same
// treatment as that earlier retirement — see `settlementTurnWriteInputSchema`
// (worker/note-settlement-turn-facade.ts). ADR-0003 is now superseded on
// its grading half too, not only its tier half.
//
// Ticket 09 (edge-ownership-impl, "结算顺手维护 session 叙事"): `turn`
// becomes OPTIONAL and `session` joins it — exactly one of the two
// addresses a call, the same shape `noteInputShape` used to give the main
// tool before ticket 09 retired `session` from THAT surface. `title`/
// `content` are what a `session`-addressed call writes (settlement's own
// whole-rewrite semantics, unchanged) — type/tags/relations stay
// turn-only, refused by `evaluateSettlementTurnWrite`'s session branch.
//
// Ticket 08 (edge-ownership-impl, "settlement four-field check-and-
// correct"): the relation half moves onto the SAME seven-word vocabulary
// `noteInputShape` exposes (evidenceFor/evidenceAgainst/groundedOn/refines/
// override/encodes/dependsOn — `shared/turn-phase.ts`'s `EDGE_RELATIONS`),
// replacing the narrower pre-ticket-01 four-field set this shape used to
// carry. `supersedes` is dropped from THIS shape too — it is frozen legacy
// (readable on old rows, `db/citations.ts`'s `CITATION_RELATIONS`) but not
// writable on either surface any more; `noteInputShape.supersedes` stays
// declared only for its own `.omit()` comment's sake, with no remaining
// reuser.
//
// Ticket 07 (write-mode-edit-semantics spec D12): `mode` is part of THIS
// shape — the same object `noteInputShape` declares, so the two surfaces
// cannot drift into two write vocabularies. It lived as a spread in
// `worker/note-settlement-turn-facade.ts` for one ticket only (ticket 06
// held this file open at the time); ticket 08 folded it back, and that
// facade is a plain re-export again. `tests/worker/note-settlement-parity.
// test.ts` asserts the identity at the tool-REGISTRATION boundary, where a
// prose claim of sameness cannot reach.
export const settlementNoteInputShape = {
  turn: z.string().min(1).optional(),
  session: z.string().min(1).optional(),
  title: z.string().optional(),
  content: z.string().optional(),
  insight: noteInputShape.insight,
  mode: noteInputShape.mode,
  type: noteInputShape.type,
  tags: noteInputShape.tags,
  evidenceFor: noteInputShape.evidenceFor,
  evidenceAgainst: noteInputShape.evidenceAgainst,
  groundedOn: noteInputShape.groundedOn,
  refines: noteInputShape.refines,
  override: noteInputShape.override,
  encodes: noteInputShape.encodes,
  dependsOn: noteInputShape.dependsOn,
};

// Ticket 04/11: `truncate` and `view` are defined on `recallInputShape`
// (above) purely so this refine can name their replacements — a
// `.strict()`-rejected unknown key would only ever carry zod's generic
// message. `workerRecallInputShape` reuses this same pair unchanged (ticket
// 11 dropped the worker-only `truncate` exemption), but never routes
// through THIS schema (worker call sites build their own
// `z.object(workerRecallInputShape)`), so this rejection is public-surface
// only, same as before.
export const recallInputSchema = z
  .object(recallInputShape)
  .strict()
  .superRefine((data, ctx) => {
    if (data.truncate !== undefined) {
      ctx.addIssue({
        code: "custom",
        message:
          "`truncate` has retired — use `pageBudget` (page overflow) or `turn` (per-item token cap) instead.",
        path: ["truncate"],
      });
    }
    if (data.view !== undefined) {
      ctx.addIssue({
        code: "custom",
        message:
          "`view` (the collapsed/expanded depth switch) has retired — select fields via `filter.fields` instead.",
        path: ["view"],
      });
    }
  });
export const timelineInputSchema = z.object(timelineInputShape).strict();
// Ticket 01 (turn-edge-mechanism spec): `.omit({ supersedes: true })` is
// what actually retires the field from the note tool's WIRE schema — see
// `noteInputShape.supersedes`'s own doc comment for why the field object
// still exists (settlement's own surface reuses it) even though no caller
// of THIS schema may send it. A supplied `supersedes` is then `.strict()`'s
// ordinary unrecognised-key parse error, not a bespoke message: there is
// nothing left on this schema to point the caller at, the same reasoning
// `grade`'s retirement (ADR-0003) already settled for this file.
// Ticket 05 (spec D4/D14): walks `mode`'s per-field entries — `mode` carries
// one independent value per field rather than one scalar, so unlike
// `truncate`/`view` above this can't be a single top-level presence check.
// Two things are flagged: a retired literal ("overwrite"/"append"), named
// with its replacement; and the edit form landing on a set field (type/
// tags), which `parseModeMap` (mcp/note.ts) also refuses at the runtime
// layer — this is the belt-and-braces copy for a call that goes through the
// real MCP validation path (`server.ts` hands this schema straight to the
// SDK, which parses every call against it before `noteTool()` ever runs).
export const noteInputSchema = z
  .object(noteInputShape)
  .omit({ supersedes: true })
  .strict()
  .superRefine((data, ctx) => {
    const mode = data.mode;
    if (!mode) {
      return;
    }
    for (const [field, value] of Object.entries(mode)) {
      if (typeof value === "string" && value in RETIRED_NOTE_MODE_LITERAL_MESSAGE) {
        ctx.addIssue({
          code: "custom",
          message: `mode.${field}: "${value}" has retired — ${RETIRED_NOTE_MODE_LITERAL_MESSAGE[value]}`,
          path: ["mode", field],
        });
        continue;
      }
      if (NOTE_SET_MODE_FIELDS.has(field) && typeof value === "object" && value !== null) {
        ctx.addIssue({
          code: "custom",
          message:
            `mode.${field}: the edit form has no meaning on a set field — oldString/newString cannot ` +
            `target part of a list; use mode.${field}: "write" with the full replacement set instead.`,
          path: ["mode", field],
        });
      }
    }
  });
// Ticket 15 (topic registry retirement): `topic` is defined on
// `rememberInputShape` (above) purely so this refine can name its
// replacement — the same `truncate`/`view` precedent `recallInputSchema`
// already set (see that schema's own superRefine).
// Ticket 05 (spec D14): `append`/`replace` retired verbs, named separately
// from `RETIRED_NOTE_MODE_LITERAL_MESSAGE` above — the two vocabularies
// (note's `mode.<field>`, remember's `verb`) retired different words and a
// caller only ever sees the message for the surface it actually called.
const RETIRED_REMEMBER_VERB_MESSAGE: Record<string, string> = {
  append: "use `write` (replace the field whole) or `edit` (anchor the last row and add to it) instead.",
  replace: "use `edit` instead — same oldString/newString shape.",
};
export const rememberInputSchema = z
  .object(rememberInputShape)
  .strict()
  .superRefine((data, ctx) => {
    if (data.topic !== undefined) {
      ctx.addIssue({
        code: "custom",
        message:
          "`topic` has retired — the topic registry folded into tags; tag the segment's member turns instead.",
        path: ["topic"],
      });
    }
    const retiredVerb = RETIRED_REMEMBER_VERB_MESSAGE[data.verb];
    if (retiredVerb) {
      ctx.addIssue({
        code: "custom",
        message: `\`${data.verb}\` has retired — ${retiredVerb}`,
        path: ["verb"],
      });
    }
  });
