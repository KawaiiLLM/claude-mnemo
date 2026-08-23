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
    "Search past sessions for design rationale, rejected alternatives, decisions, and user corrections — the *why* behind the code, which source never records. For current behavior or mechanism, read the source first. The injected blocks are an index, not the memory — never conclude a fact is unrecorded because no injected block carries it. Materializing memory into a durable artifact (spec, ticket, doc, summary): any ruling you cannot quote verbatim — especially one from behind a compact — comes from recall/replay first, never from summary memory. Paginated index; hand off to the mnemo-replay skill for a turn's full untruncated text and tool I/O from the database (raw JSONL only for exact bytes). `id` also accepts a comma-separated list of same-kind addresses (e.g. `id=\"E31, E32\"` or `id=\"S12, S15\"`) — each item parses through the same grammar below, renders in order, and shares this call's page/turn budgets; mixed address kinds or any one invalid item rejects the whole call. `id=\"E<n>\"` (also `E*`, `E1..9`) recalls the segment card — the accumulated impression of one arc of work, not a session or a turn — so check whether one already covers a task before redoing it: `[open]` is that task's still-live working state, `[delivered]` is its settled impression. `id=\"E<n>/T<m>\"` (also `E<n>/T*`, `E<n>/T3..7`) addresses the segment's own members by their 1-based EVENT-ORDER position — a navigation handle only, never a citation (cite the rendered `[S<session>][T<prompt>]` address instead, since a late-settling member shifts the ordinal). `filter.fields` is the one field-selection knob: pick any combination of turn fields (default title, metadata, content — metadata carries the local time plus a turn's `type`/`tags`); add `relations` to see a turn's own tagged edges in both directions (`→ <word> T<n> {tag+tag}` outbound, `← <word> from T<n> {tag+tag}` inbound, Law-8 filtered) — off by default, a read convenience that grants nothing new. A segment card (`id=\"E<n>\"`) shows its metadata header and counts with the newest field rows on page 1, every row plus a member index from page 2 on (`page` selects that, not a field). Body size is controlled by exactly two token budgets — `pageBudget` (page overflow → another page, never a truncated block) and `turn` (per-item cap on every rendered session/turn/observation, word-boundary cut). Reading also LICENSES writing back what you read: a `write` over a field another writer filled needs this read to have delivered THAT field untruncated — raise `turn` (or `pageBudget` on a segment card) and re-read if it came back cut; a plain recall already earns this for `type`/`tags` too, since metadata is on by default — only a caller who narrowed `filter.fields` away from it needs to ask for `metadata` back explicitly. `edit` needs a current read, never a complete one. `query` is pure full-text search — it has no in-string dialect; a query containing `tag:foo` searches those literal characters. Use `filter` to scope by type/tag/session/time/file instead, AND-composed with `query` and with `id` alike. Bare `recall()` (no `id`, no `query`) lists segments before sessions. Segments also surface in `query=`/`filter` search alongside sessions and turns.",
  timeline:
    "Render the temporal/decision shape of a past session — gaps, tool bursts, compact boundary, broken-prompt candidates, and view-specific timeline bodies. Single-session view with range selectors plus page/pageSize pagination. Optional `view` selects `turns` (default turn table) or `milestones` — a lane-first structural election, not a score: identity tiers first (releases, then closed-valid lane termini and open lanes' last declarer, then nodes those elect index, then correctors, then everything else), in-degree breaking ties within a tier, recency deciding the rest; an edgeless window degrades to a flat recent-N list, and admission is single-page by construction — `phases` has retired. `filter` — the same structured grammar `recall` uses — AND-composes with the id selector's range to narrow which turns the current view considers.",
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
  // ticket 02 (edge-mechanism-revision D1/D3): the C7 half of that — "an
  // uncited target rejects the call" — is RETIRED from this text along with
  // the check itself. What replaces it is the opposite fact, which a caller
  // now has to be told out loud or it will keep writing citations for a
  // machine that stopped reading them: prose and edges are independent, a
  // pair may carry several relations, and a wrong one is retracted rather
  // than overwritten.
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
  // cannot state (turn-only address lists; ticket 02 replaced the second of
  // those, "an uncited target rejects the call", with its retirement) — the
  // single-home grep guard (tests/shared/memory-rubric.test.ts) asserts the
  // judgment prose itself appears nowhere on this surface.
  note:
    "Write or correct a turn's note. `turn` (`S<session>/T<prompt>`, from the current-turn line or backlog relief — never recalled or invented). Timing: (1) note only FINISHED turns, never the one in progress; (2) a batch of note/skip calls alone opens when backlog relief appears, or to fix a note already written — never just to write one turn's note early; (3) a batch opens a turn, never ends one — only text after the last tool call renders, so a trailing note call eats the reply before it.\n" +
    "skip: true with `turn` alone, when a future retriever would find nothing unique — check: deleting it costs no decision, progress, or coherence. Content gone and not recovered is skipped, never invented. Never skip a user decision, correction, veto, or any turn with a conclusion, rejected option, or lesson.\n" +
    "Cite turns only as [S15069/T332], ids seen in injected context; never include <private> content.\n" +
    "Relations — override/narrows/extends/indexes/consume/grounds/verifies/refutes: turn-only address lists, declared independently of the prose (the body need not name the target, and a call carrying nothing but relations is valid). A pair may hold several relations at once; each `retract<Relation>` mirror deletes one. Which relation, if any — the judgment — lives in the Memory Rubric (SessionStart injection); this call only enforces address shape, phase legality (the self-citation gate included), and your own read grant on the turn being written.\n" +
    "Tool-call markup (`<parameter`, `<invoke`, …) in a field is rejected, nothing stored. Every field is written in English. A first note for a turn needs both title and content. Every parameter below carries its own contract.",
  // ticket 02 (ADR-0001/0002/0005): `remember` is the segment's write surface
  // — 记住 (semantic, cross-session), sibling to `note`'s 记录 (episodic,
  // per-turn). Revives the retired 0.x tool name, now scoped to segments only.
  // Per-verb parameter contracts live in `rememberInputShape`'s `.describe()`s
  // below, same split as `note`'s ticket 01 revision — this text keeps only
  // what governs the call as a whole.
  remember:
    `Maintain a segment — claude-mnemo's long-lived, per-task semantic container (记住; \`note\` is the per-turn episodic surface, 记录). Seven verbs: \`create\` mints a new segment from the roster you have in view (create-or-not and reuse-before-new: the Memory Rubric's 建段 section); \`attach\` binds the current session to a segment (\`id="E<n>"\`) and returns its collapsed card; \`write\` replaces one field's value whole; \`edit\` finds \`oldString\` in one field and swaps in \`newString\` — ambiguous or missing rejects loudly naming which, \`newString: ""\` deletes the matched text; \`close\` toggles the segment off the roster, or, called again, back on; \`assign\` places \`turns\` (addresses or one \`T<a>..T<b>\` interval) into \`id\`, single ownership, gated by the target's own tags — or clears ownership if \`id\` is omitted; \`retag\` replaces a segment's hand-curated tags whole. Editable fields: ${WORKING_STATE_FIELD_LIST} (Working State) plus content, insight (summary) — each an uncapped markdown row list. Add a row by anchoring \`edit\` on the last row (oldString = it, newString = it + the new line); reordering or a full rewrite is \`write\`. A closed segment refuses write/edit, naming \`close\` as the way back. Rows may cite \`[S<session>/T<prompt>]\`/\`[E<n>]\`, ids seen in context only, never invented. Tool-call markup (\`<parameter\`, \`<invoke\`, …) is rejected, nothing stored. Every field is written in English.\n` +
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
  // default (title, metadata, content — ticket 12) should usually raise
  // this too, or the extra fields mostly get cut by the unchanged default
  // budget.
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
    'Required when the target field already holds something: "write" replaces it whole (type/tags: the full replacement set — the edit form has no meaning on a set field). The edit form `{ mode: "edit", oldString, newString }` swaps an exactly-matched span within a text field ("" deletes the match); missing or ambiguous rejects loudly naming which. Not required when the field is empty or omitted — omitting the field itself leaves it untouched. Clearing a nullable field (insight) needs the field set to null plus its mode set to "write". A "write" landing over content ANOTHER writer put there additionally requires that your authorizing read delivered THAT field untruncated: for title/content/insight, a recall with a big enough `turn` cap; for type/tags, the SAME plain recall already earns it — both render on the metadata line, included by default (`recall(id="S<n>/T<m>")` with a big enough `turn` cap) — add `filter={fields:["metadata"]}` only if an earlier read of yours had narrowed `filter.fields` away from it. Your own content and an empty field are exempt, and the edit form never needs a complete read at all.',
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
// rubric-v10 ticket 02 ("边上的 lane tag", "统一解读原则"): one relation
// TARGET is either a bare address (untagged) or `{turn, tags}` (a tagged
// assertion) — the note surface's own mirror of `db/citations.ts`'s
// `RelationTargetEntry` union, declared once here so every relation AND
// retraction field below shares the identical zod shape rather than eight
// (or sixteen) independently hand-kept copies. `tags` is a plain string
// array at this layer — canonicalization (sort/dedup) happens at the write
// primitive (`db/memory-edges.ts`'s `canonicalizeTagSet`), the same split
// title/content's own field objects already have between "what the schema
// accepts" and "what the write path normalizes".
const relationTargetEntryShape = z.union([
  z.string(),
  z
    .object({
      turn: z.string().min(1),
      tags: z.array(z.string()),
    })
    .strict(),
]);

// The interpretation principle (draft-lane-model.md's 统一解读原则), stated
// once and appended to every SAME-PHASE (taggable) word's own describe: a
// tagged entry acts on the named LANE, an untagged one acts on the cited
// TURN itself. The subset invariant is format, not judgment — WHICH tag to
// use is the Memory Rubric's business, but "every tag must already be on
// both turns" is a mechanical admission test, the same register `noteInputShape`'s
// other field contracts already state in their own `.describe()`.
const RELATION_TAG_FORM_LINE =
  "Each entry is a bare address (untagged — acts on the cited turn itself) or " +
  "`{turn, tags}` (acts on that lane instead); every tag must already be on " +
  "both this turn's and the target's own tags, or the call rejects naming the gap.";

// The three CROSS-PHASE words never carry a lane tag (lanes are phase-local)
// — stated so a caller does not have to discover the rejection by trying.
const RELATION_NO_TAG_FORM_LINE =
  "Entries are bare addresses only — cross-phase words never carry lane tags.";

// rubric-v10 ticket 02: the retraction mirrors' own one-sentence note —
// identical across all eight, since the form is uniform regardless of which
// word it retracts.
const RETRACTION_TAG_FORM_LINE =
  "Same bare-address-or-`{turn, tags}` form as the relation field: an untagged " +
  "entry retracts the bare row, a tagged one retracts that exact tag-set row.";

// PROPERTY ORDER IS LOAD-BEARING (write-gate-hardening ticket 01). Zod keeps
// insertion order all the way into the serialized JSON schema, and that order
// is what the model sees when it writes the call. The observed failure it
// defends against: at the CLOSING boundary of a very long value, the next
// field's name is the most salient token around, and the serialization drifts
// into closing the parameter with the FIELD's own name; the parser then glues
// everything after it into that field as literal text, and the parameters that
// rode in never land. So the two longest fields go last — `content` gets the
// successor-free boundary (nothing after it to drift into) and `insight`, the
// next longest, sits beside it. Everything short and structural
// (turn/title/skip/crossSession/segment/type/tags/mode) comes first, the
// relation and retraction arrays after that. Reordering is the WHOLE change:
// no field's type, nullability or description differs from before.
// `tests/mcp/definitions.test.ts` pins the serialized order on both surfaces.
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
  // rubric-v10 ticket 07 ("Segment tags and note-time membership"): the
  // note-time membership path — assigns THIS turn to one segment the calling
  // session has ATTACHED, gated by the segment's own hand-curated tags.
  // `remember`'s `assign` verb stays the batch/reassignment/clearing surface;
  // this parameter only ever targets the turn this same call is writing.
  segment: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Assign this turn\'s own membership to one segment this session has ATTACHED ("E<n>"). An unattached or nonexistent segment rejects, naming the attachment requirement ("remember(attach, id=...)" first). The segment\'s hand-curated tags gate the assignment — this turn\'s tags (after this same call\'s own `tags`, if given) must carry every one of them, or the call rejects naming the gap; an untagged segment gates nothing. `remember`\'s `assign` verb is the batch/reassignment/clearing surface instead.',
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

  mode: noteModeShape,

  // Flow-relations spec (ticket 02, "六行律" — the six-row law): the eight-
  // word vocabulary that replaces ADR-0010's nine-cell grammar outright.
  // Targets are address tokens, `S<session>/T<prompt>` (brackets optional) —
  // segment targets are refused (relations are turn-only). No `mode`: unlike
  // title/tags/type there is no PRIOR value at this layer to write over or
  // edit — a relation write only ever ADDS a row, and removing one is a
  // retraction, not a mode.
  //
  // ADR-0009's three-way split (FORMAT on each `.describe()`, TIMING on the
  // tool description, JUDGMENT in the Memory Rubric alone) narrows further
  // here: the mechanical phase requirement itself moved OFF this surface and
  // into the validator's own rejection message (`shared/turn-phase.ts`) — a
  // call that gets the phase wrong is told so, by name, at the point it
  // fails, rather than reading it here first. What each describe below keeps
  // is the one-line READING (which stance this word states) and a pointer to
  // the Memory Rubric for the judgment of WHICH word to use.
  override: z
    .array(relationTargetEntryShape)
    .optional()
    .describe(
      "Addresses a predecessor whose conclusion this turn holds is WRONG and replaces — same phase, no flow or layer limit. " +
        RELATION_TAG_FORM_LINE + " Judgment lives in the Memory Rubric.",
    ),
  narrows: z
    .array(relationTargetEntryShape)
    .optional()
    .describe(
      "Addresses a decision this turn still holds but cuts a piece OUT of — same phase. " +
        RELATION_TAG_FORM_LINE + " Judgment lives in the Memory Rubric.",
    ),
  extends: z
    .array(relationTargetEntryShape)
    .optional()
    .describe(
      "Addresses a decision this turn still holds and adds a piece TO — same phase. " +
        RELATION_TAG_FORM_LINE + " Judgment lives in the Memory Rubric.",
    ),
  indexes: z
    .array(relationTargetEntryShape)
    .optional()
    .describe(
      "Addresses the same-phase nodes this turn gathers and stands for — they carry its content and readers reach them through it (a settlement's carrying members, a release's shipped artifacts). Same phase is the whole check: no flow, membership or terminus condition. An indexed target is not also consumed by an UNTAGGED edge; a tagged consume may sit beside a tagged indexes — lane structure and convergence declaration are separate facts." +
        RELATION_TAG_FORM_LINE +
        " A tagged entry additionally DECLARES that lane's convergence (its terminus) — see grounds' own self-citation reading below. Judgment lives in the Memory Rubric.",
    ),
  consume: z
    .array(relationTargetEntryShape)
    .optional()
    .describe(
      "Addresses work this turn used, with no liability if it turns out wrong; indifferent to flow — never written beside an extends on the same pair, and never untagged beside an indexes (each already implies it); a TAGGED consume beside a tagged indexes is legal — the declaration does not carry the lane-structure fact." +
        RELATION_TAG_FORM_LINE + " Judgment lives in the Memory Rubric.",
    ),
  grounds: z
    .array(relationTargetEntryShape)
    .optional()
    .describe(
      "Addresses a finding or ruling this turn's own conclusion FALLS WITH if it were false — cross-phase only (a decision on a finding, a delivery on its ruling or verification; never within one phase), absorbs the retired grounded-on/encodes. One route to the decision: when a SEPARATE delivery turn wrote the spec, THAT turn carries the grounds and the other artifacts consume it; with design and spec in one turn, each artifact grounds directly. Turn-only; may cite the citing turn itself only when this turn's own type carries a delivery-phase word (the implementer half — a decision-only turn cannot self-ground) AND, after this call's edges land, this turn is the CURRENT terminus of a lane it declared via a TAGGED indexes edge of its own (declared in this same call, either order, or already stored — a later override that reopens or repudiates that declaration means it no longer qualifies) — every other relation refuses a self target outright. " +
        RELATION_NO_TAG_FORM_LINE +
        " Judgment lives in the Memory Rubric.",
    ),
  verifies: z
    .array(relationTargetEntryShape)
    .optional()
    .describe(
      "Addresses the claim this turn tested FOR. Requires an evidence-phase source. " +
        RELATION_NO_TAG_FORM_LINE + " Judgment lives in the Memory Rubric.",
    ),
  refutes: z
    .array(relationTargetEntryShape)
    .optional()
    .describe(
      "Addresses the claim this turn tested AGAINST. Requires an evidence-phase source. " +
        RELATION_NO_TAG_FORM_LINE + " Judgment lives in the Memory Rubric.",
    ),

  // Flow-relations spec (ticket 02): the eight retraction mirrors. A relation
  // is never overwritten (a relation write is purely additive), so correcting
  // a wrong one is two auditable acts — retract, then write the right
  // relation — and BOTH writers hold the same power over either's edges
  // ([S15069/T1124]: a false assertion must not outlive its refutation on
  // account of who filed it). The spelling is mechanical (`retract` + the
  // relation parameter's own name), pinned against `mcp/note.ts`'s derived
  // `RETRACTION_FIELD_ENTRIES` by a guard test, so the two halves of the
  // vocabulary cannot drift apart.
  //
  // rubric-v10 ticket 02: each retraction entry takes the SAME
  // bare-address-or-`{turn, tags}` form as its relation field — an untagged
  // entry retracts the bare `[]` row, a tagged one retracts that exact
  // tag-set row (`RETRACTION_TAG_FORM_LINE`).
  retractOverride: z
    .array(relationTargetEntryShape)
    .optional()
    .describe(
      "Addresses whose override edge FROM this turn is deleted; an address carrying no such edge rejects the call, naming it. " +
        RETRACTION_TAG_FORM_LINE,
    ),
  retractNarrows: z
    .array(relationTargetEntryShape)
    .optional()
    .describe(
      "Addresses whose narrows edge FROM this turn is deleted; an address carrying no such edge rejects the call, naming it. " +
        RETRACTION_TAG_FORM_LINE,
    ),
  retractExtends: z
    .array(relationTargetEntryShape)
    .optional()
    .describe(
      "Addresses whose extends edge FROM this turn is deleted; an address carrying no such edge rejects the call, naming it. " +
        RETRACTION_TAG_FORM_LINE,
    ),
  retractIndexes: z
    .array(relationTargetEntryShape)
    .optional()
    .describe(
      "Addresses whose indexes edge FROM this turn is deleted; an address carrying no such edge rejects the call, naming it. " +
        RETRACTION_TAG_FORM_LINE,
    ),
  retractConsume: z
    .array(relationTargetEntryShape)
    .optional()
    .describe(
      "Addresses whose consume edge FROM this turn is deleted; an address carrying no such edge rejects the call, naming it. " +
        RETRACTION_TAG_FORM_LINE,
    ),
  retractGrounds: z
    .array(relationTargetEntryShape)
    .optional()
    .describe(
      "Addresses whose grounds edge FROM this turn is deleted; an address carrying no such edge rejects the call, naming it. " +
        RETRACTION_TAG_FORM_LINE,
    ),
  retractVerifies: z
    .array(relationTargetEntryShape)
    .optional()
    .describe(
      "Addresses whose verifies edge FROM this turn is deleted; an address carrying no such edge rejects the call, naming it. " +
        RETRACTION_TAG_FORM_LINE,
    ),
  retractRefutes: z
    .array(relationTargetEntryShape)
    .optional()
    .describe(
      "Addresses whose refutes edge FROM this turn is deleted; an address carrying no such edge rejects the call, naming it. " +
        RETRACTION_TAG_FORM_LINE,
    ),
  // Frozen legacy: `supersedes` retired from the NOTE TOOL's own surface —
  // `noteInputSchema` below `.omit()`s this key, so a caller sending it gets
  // `.strict()`'s parse error naming the unrecognised key, same as any other
  // retired field. No reuser (settlement's own shape does not reuse this
  // field object either); it stays declared, unexported from the schema,
  // purely as frozen documentation of the word this project once wrote and
  // no longer does; `db/citations.ts`'s `CITATION_RELATIONS` is where the
  // READ-side legacy value actually lives.
  supersedes: z
    .array(z.string())
    .optional()
    .describe(
      "Retired on the note tool — use extends/override instead. Present here only as frozen documentation.",
    ),

  // The two long prose fields, last on purpose — see this shape's own header
  // comment. `content` is the longest and takes the final slot (no successor
  // field name for its closing boundary to drift into); `insight`, the next
  // longest, sits beside it.
  insight: z
    .string()
    .nullable()
    .optional()
    .describe(
      `Turn only (~${NOTE_TOKEN_BUDGET.insight} tok, default omit): REUSABLE experience, not a conclusion of this turn — a task-scoped lesson under the episode-deletion test: delete the episode; does the sentence still teach someone useful prior knowledge?`,
    ),
  content: z
    .string()
    .nullable()
    .optional()
    .describe(
      `Turn only (~${NOTE_TOKEN_BUDGET.content} tok): the CONCLUSIONS — assume the title was just read, expand, never restate. Every useful decision this turn produced, each rejected alternative with a one-line reason, secondary conclusions, citations. Sentence deletion test: remove a sentence — if a decision's derivation still holds without it, cut it. No process narration (replay stores it). Length tracks this turn's output, not the effort spent — long when the turn produced a lot, terse when it produced little. Lead with the conclusions: a reader's budget cuts the tail, so whatever only supports a decision comes after it.`,
    ),
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
    .enum([
      "create",
      "attach",
      "write",
      "edit",
      "close",
      "assign",
      "retag",
      "append",
      "replace",
    ])
    .describe(
      'create: mint a new segment. attach: bind the current session to one. write: replace one field\'s value whole (`value`; null or "" clears it). edit: find `oldString` in one field and swap in `newString`. close: toggle the segment off the roster (or, called again, back on). assign: place turns into a segment (id set) or clear their ownership (id omitted) — the target segment\'s own tags gate the write, rejecting a turn whose tags don\'t carry all of them. retag: replace a segment\'s hand-curated tags whole (`tags`; the full replacement set — never derived, never merged).',
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
    .describe(
      // ticket 07 (rubric-v10) split this describe's old claim in two: type
      // stays derived (never a caller input, absent from this shape), tags
      // no longer is — see the `tags` field just below for its own contract.
      "create only (required): the segment's title, written in English — set once, here. " +
        "A segment's type is never written by hand: it is DERIVED from its member turns " +
        "and recomputed whenever membership changes.",
    ),
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
  // ticket 07 (rubric-v10, "Segment tags and note-time membership"): the
  // segment's own hand-curated identity — never derived, unlike `type`.
  tags: z
    .array(z.string())
    .optional()
    .describe(
      "create (optional) / retag (required): the segment's hand-curated tags — set once here, or replaced whole later with retag; never derived, never merged. Gates every NEW membership write (this tool's own `assign`, settlement's `reassign`, and `note`'s `segment` parameter): a turn may join only when its own tags carry every one of the segment's, or the write rejects naming the gap. Existing members are grandfathered, never re-checked. Empty (or omitted at create) gates nothing. Distinct from a relation's own lane tags — the two vocabularies never overlap, and a lane's own tag set stays as small as discrimination allows.",
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
      // The two framings and the arc discriminator moved here from the Memory
      // Rubric's §Fields segment block, which retires: this describe is the
      // main agent's standing source for what a segment field IS, and the
      // settlement surface has no `field` parameter at all (it writes
      // membership, never segment fields), so nothing else needed a copy.
      "write/edit only (required): which field. " +
        "Working State, what a resuming session needs to continue — " +
        "goal: what this task is trying to achieve. " +
        "constraints: how the work must be done — norms, habits, standing preferences. " +
        "decisions: concrete rulings about the task itself, settled and binding. " +
        "done: what is finished and verified. " +
        "next_steps: what is waiting to be done. " +
        "reference: durable pointers — source locations, specs, PRs, URLs; not plans. " +
        "Summary, what an outsider browsing the task reads — " +
        "content: the impression this arc leaves, what it is about and how it went " +
        "(the arc, not per-turn conclusions). " +
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
      'assign only (required): turn addresses ("S<session>/T<prompt>") or one interval ("S<session>/T<a>..T<b>", inclusive; the second T is optional) — as seen in context, never recalled or invented. An interval spanning even one missing turn rejects the whole call, naming which; nothing is assigned. When `id` is given, the target segment\'s own tags additionally gate the write: every named turn\'s tags must carry all of them, or the call rejects naming the gap (omit `id` to clear ownership instead, which has no gate).',
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
// correct"): the relation half moves onto the SAME vocabulary `noteInputShape`
// exposes (`shared/turn-phase.ts`'s `EDGE_RELATIONS` — the seven-word set at
// ticket 08's own time, flow-relations ticket 02's eight words now),
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
//
// Ticket 04 (edge-mechanism-revision D3/D6): the seven `retract…` mirrors
// join, the SAME objects again — ticket 02 deliberately left them off this
// shape ("a schema accepting parameters the facade ignores is worse than
// rejection") and this ticket adds the parameters and the facade wiring
// together, so a settlement retraction reaches `retractTurnRelations` the
// same call the main agent's own does. `title`/`content` keep their separate
// declaration for the one surviving reason: settlement's `session` address
// writes them non-nullably. They are a TURN's prose too now (D6 revoked
// "结算不再重建笔记"), through the same mode vocabulary and the same gate.
// Write-gate-hardening ticket 01: property order mirrors `noteInputShape`'s —
// structural short fields, then the relation/retraction arrays, then `insight`,
// then `content` dead last. The reason is the same on both surfaces (a long
// value's closing boundary is where the serialization drifts into a
// field-named closing tag), and the failure was first caught on THIS one, so
// the two orders are kept identical rather than reasoned about separately.
export const settlementNoteInputShape = {
  turn: z.string().min(1).optional(),
  session: z.string().min(1).optional(),
  title: z.string().optional(),
  mode: noteInputShape.mode,
  type: noteInputShape.type,
  tags: noteInputShape.tags,
  override: noteInputShape.override,
  narrows: noteInputShape.narrows,
  extends: noteInputShape.extends,
  indexes: noteInputShape.indexes,
  consume: noteInputShape.consume,
  grounds: noteInputShape.grounds,
  verifies: noteInputShape.verifies,
  refutes: noteInputShape.refutes,
  retractOverride: noteInputShape.retractOverride,
  retractNarrows: noteInputShape.retractNarrows,
  retractExtends: noteInputShape.retractExtends,
  retractIndexes: noteInputShape.retractIndexes,
  retractConsume: noteInputShape.retractConsume,
  retractGrounds: noteInputShape.retractGrounds,
  retractVerifies: noteInputShape.retractVerifies,
  retractRefutes: noteInputShape.retractRefutes,
  insight: noteInputShape.insight,
  content: z.string().optional(),
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
