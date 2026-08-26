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
      `Which turn fields to render, any combination — replaces the collapsed/expanded field-set switch. One of: ${RECALL_TURN_FIELD_NAMES.join(", ")}. A note-less turn renders as a bare address unless \`prompt\` is selected.`,
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
    "Search past sessions for design rationale, rejected alternatives, decisions, and user corrections — the *why* behind the code, which source never records. For current behavior or mechanism, read the source first. The injected blocks are an index, not the memory — never conclude a fact is unrecorded because no injected block carries it. Materializing memory into a durable artifact (spec, ticket, doc, summary): any ruling you cannot quote verbatim — especially one from behind a compact — comes from recall/replay first, never from summary memory. Paginated index; hand off to the mnemo-replay skill for a turn's full untruncated text and tool I/O from the database (raw JSONL only for exact bytes). `id` also accepts a comma-separated list of same-kind addresses (e.g. `id=\"E31, E32\"` or `id=\"S12, S15\"`) — each item parses through the same grammar below, renders in order, and shares this call's page/turn budgets; mixed address kinds or any one invalid item rejects the whole call. `id=\"E<n>\"` (also `E*`, `E1..9`) recalls the segment card — the accumulated impression of one arc of work, not a session or a turn — so check whether one already covers a task before redoing it: `[open]` is that task's still-live working state, `[delivered]` is its settled impression. `id=\"E<n>/S<a>/T<b>\"` addresses one of the segment's own members by its ordinary `S<session>/T<prompt>` address, scoped to that segment — the same address you would cite it by anywhere else; `id=\"E<n>/S<a>/T<b>..S<c>/T<d>\"` is a range over the segment's own EVENT ORDER between those two endpoints inclusive (the two endpoints need not share a session), and `id=\"E<n>/T*\"` is every member. The retired ordinal form (`E<n>/T<m>`, the segment's own 1-based event-order position — a THIRD meaning the same `E<n>/T<m>` string once carried elsewhere) refuses outright, naming this grammar, rather than silently landing on the wrong turn. `filter.fields` is the one field-selection knob: pick any combination of turn fields (default title, metadata, content — metadata carries the local time plus a turn's `type`/`tags`); add `relations` to see a turn's own edges in both directions (`→ <word> T<n> {lane}` outbound, `← <word> from T<n> {lane}` inbound, `{tail→head}` when the edge crosses two lanes, no braces when neither side is placed; Law-8 filtered) — off by default, a read convenience that grants nothing new. A segment card (`id=\"E<n>\"`) shows its metadata header and counts with the newest field rows on page 1, every row plus a member index from page 2 on (`page` selects that, not a field). Body size is controlled by exactly two token budgets — `pageBudget` (page overflow → another page, never a truncated block) and `turn` (per-item cap on every rendered session/turn/observation, word-boundary cut). Reading also LICENSES writing back what you read: a `write` over a field another writer filled needs this read to have delivered THAT field untruncated — raise `turn` (or `pageBudget` on a segment card) and re-read if it came back cut; a plain recall already earns this for `type`/`tags` too, since metadata is on by default — only a caller who narrowed `filter.fields` away from it needs to ask for `metadata` back explicitly. `edit` needs a current read, never a complete one. `query` is pure full-text search — it has no in-string dialect; a query containing `tag:foo` searches those literal characters. Use `filter` to scope by type/tag/session/time/file instead, AND-composed with `query` and with `id` alike. Bare `recall()` (no `id`, no `query`) lists segments before sessions. Segments also surface in `query=`/`filter` search alongside sessions and turns.",
  timeline:
    "Render the temporal/decision shape of a past session — gaps, tool bursts, compact boundary, broken-prompt candidates, and view-specific timeline bodies. Single-session view with range selectors plus page/pageSize pagination. Optional `view` selects `turns` (default turn table) or `milestones` — a lane-first structural election, not a score: identity tiers first (releases, then closed-valid lane termini and open lanes' last declarer, then nodes those elect index, then correctors, then everything else), in-degree breaking ties within a tier, recency deciding the rest; an edgeless window degrades to a flat recent-N list, and admission is single-page by construction — `phases` has retired. `id=\"E<n>/L*\"` (or `E<n>/L<n>` for one lane, the same 1-based ordinal a list render's own `[L<n>]` shows) renders that segment's DECLARED lanes as one header plus one representative chain each, newest-first: `[L<n>] <MM-DD HH:mm> <emoji> <tag>` — the newest member's time, the type stated by the most member turns (ties broken by the rubric's own type order) — then `◎S<session>/T<prompt> => T<prompt> -> T<prompt>(N)`, `◎` marking the lane's current terminus, `=>` an edge into an indexed node, `->` ordinary continuation, trailing `(N)` always the lane's total member count. The path shown is the one covering the MOST member turns within the per-chain item budget — a relation preference (`extends`/`narrows` > `indexes` > `consume` > `override`) only breaks a tie between equal-coverage paths, never picks a shorter-but-newer branch over a longer one. Every node is its own ordinary `S<session>/T<prompt>` address, addressable directly via `recall(id=\"S<session>/T<prompt>\")` — printed in full for the chain's first node and again whenever the session changes from the node before it, bare `T<prompt>` otherwise; the segment scoping the chain plays no part in any node's own address. `filter` — the same structured grammar `recall` uses — AND-composes with the id selector's range to narrow which turns the current view considers.",
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
    "Write or correct a turn's note. `turn` is `S<session>/T<prompt>`: the injected \"mnemo current turn\" line and the backlog-relief block are the ONLY sources of a note address — never recall one from memory, never invent one. Timing: (1) note only FINISHED turns, never the one in progress; (2) a batch of note/skip calls alone opens when backlog relief appears, or to fix a note already written — never just to write one turn's note early; (3) a batch opens a turn, never ends one — only text after the last tool call renders, so a trailing note call eats the reply before it.\n" +
    "skip: true with `turn` alone, when a future retriever would find nothing unique — check: deleting it costs no decision, progress, or coherence. Content gone and not recovered is skipped, never invented. Never skip a user decision, correction, veto, or any turn with a conclusion, rejected option, or lesson.\n" +
    "Cite turns only as [S15069/T332], ids seen in injected context; never include <private> content.\n" +
    "This tool writes five fields — title, content, insight, type, tags — and nothing else. Edges (override/narrows/extends/indexes/consume/grounds/verifies and their retract… mirrors) are settlement's whole business: which turns this one relates to, and in which lane, is hindsight, so sending one of those parameters is refused. A prose `[S15069/T332]` still records that this turn REFERS to that one; it states no relation.\n" +
    "What a field should SAY is the Memory Rubric's (SessionStart); this call enforces address shape, the tag vocabulary and your read grant. Tool-call markup (`<parameter`, `<invoke`, …) in a field is rejected, nothing stored. Every field is written in English. A first note for a turn needs both title and content. Every parameter below carries its own contract.",
  // ticket 02 (ADR-0001/0002/0005): `remember` is the segment's write surface
  // — 记住 (semantic, cross-session), sibling to `note`'s 记录 (episodic,
  // per-turn). Revives the retired 0.x tool name, now scoped to segments only.
  // Per-verb parameter contracts live in `rememberInputShape`'s `.describe()`s
  // below, same split as `note`'s ticket 01 revision — this text keeps only
  // what governs the call as a whole.
  // lane-model-v12 ticket 12: this text used to point at "the Memory Rubric's
  // 建段 section". v12's rubric has no such section — the whole `## Segments`
  // block went with the wholesale replacement, and the user-authored v12
  // sources carry no segment-creation guidance at all. A pointer at a section
  // that does not exist is worse than none (a reader follows it, finds nothing
  // and falls back to instinct), so the pointer is dropped rather than
  // re-aimed. The three ruled lines it used to reach are archived at
  // `.scratch/lane-model-v12/` predecessors and in this repo's git history;
  // whether they come back — into the rubric source or onto this describe — is
  // a content decision this ticket deliberately does not make on its own.
  remember:
    `Maintain a segment — claude-mnemo's long-lived, per-task semantic container (记住; \`note\` is the per-turn episodic surface, 记录). Nine verbs: \`create\` mints a new segment from the roster you have in view (create-or-not and reuse-before-new); \`attach\`/\`detach\` bind or unbind this session (\`id="E<n>"\`) — rarely needed by hand, since a turn's segment tag attaches it; \`write\` replaces one field's value whole; \`edit\` finds \`oldString\` in one field and swaps in \`newString\` — ambiguous or missing rejects loudly naming which, \`newString: ""\` deletes the matched text; \`close\` toggles the segment off the roster, or, called again, back on; \`retag\` NAMES the segment — one globally unique \`tag\`, and a turn belongs here by carrying that tag in its own \`note\` tags, so there is no assignment verb; \`declare\`/\`undeclare\` (\`id\`, \`tag\`) mint or remove a lane inside this segment — declare reports how many existing turns already carry the word and therefore become its members, undeclare refuses while any edge still carries the tag. Editable fields: ${WORKING_STATE_FIELD_LIST} (Working State) plus content, insight (summary) — each an uncapped markdown row list. Add a row by anchoring \`edit\` on the last row (oldString = it, newString = it + the new line); reordering or a full rewrite is \`write\`. A closed segment refuses write/edit, naming \`close\` as the way back. Rows may cite \`[S<session>/T<prompt>]\`/\`[E<n>]\`, ids seen in context only, never invented. Tool-call markup (\`<parameter\`, \`<invoke\`, …) is rejected, nothing stored. Every field is written in English.\n` +
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
      'Selector: "S12" | "S12/T3" | "S12/T3..7" | "S12/T3/O*" | "E31" | "E31/T*" | "E31/S12/T3" | "E31/S12/T3..S45/T7" | "O87" | bare "T418" (global DB id). A range\'s second endpoint may repeat the kind letter ("T3..T7" ≡ "T3..7"); comma-separated lists of one kind allowed.',
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
// lane-model-v12 ticket 08 (spec D1/D7): one relation TARGET, either a bare
// address (both sides UNSETTLED — the draft form) or `{turn, tailTag, headTag}`,
// which places each END of the edge in its own lane. Declared once here so
// every relation AND retraction field on the SETTLEMENT shape below shares the
// identical zod shape rather than fourteen independently hand-kept copies.
//
// It is on the settlement shape ONLY. Ruling [S15069/T1651] took relation
// fields off the main agent's `note` entirely, so what used to be the shared
// `{turn, tags}` union now has exactly one surface — which is also why the two
// side values are plain strings here: the write gate REFUSES a non-canonical
// tag naming the exact problem (`db/lanes.ts`'s `checkCanonicalLaneTag`) rather
// than normalizing it, so no schema-level coercion may run in front of it.
const relationTargetEntryShape = z.union([
  z.string(),
  z
    .object({
      turn: z.string().min(1),
      tailTag: z.string(),
      headTag: z.string(),
    })
    .strict(),
]);

// The two-sided reading, stated once and appended to EVERY relation word's own
// describe: a lane's identity is (segment, tag), each side answers to its own
// endpoint's segment, and the two sides go together or not at all.
//
// What the line teaches is the MECHANICAL admission test, the same register the
// other field contracts use — WHICH lane a turn belongs to stays the Memory
// Rubric's business.
const RELATION_TAG_FORM_LINE =
  "Each entry is a bare address (both sides unsettled — the draft an edge starts " +
  "as) or `{turn, tailTag, headTag}`: `tailTag` is the lane THIS turn writes " +
  "from, `headTag` the lane the cited turn sits in. Place BOTH or NEITHER — one " +
  "side alone rejects. Each side is checked against its OWN endpoint: the tag " +
  "must be canonical, DECLARED in that endpoint's segment, and already on that " +
  "endpoint turn's own tags. The same word on both sides means one lane spanning " +
  "the edge; two different lanes is a legal crossing, and so is the same word in " +
  "two different segments, which is two lanes.";

// The retraction mirrors' own one-sentence note — identical across every
// mirror, since the form is uniform regardless of which word it retracts.
const RETRACTION_TAG_FORM_LINE =
  "Same bare-address-or-`{turn, tailTag, headTag}` form as the relation field: a " +
  "bare entry retracts the unsettled row, a two-sided one retracts exactly that " +
  "lane placement.";


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
      // FORMAT only. Where a legitimate address may come from is a CALL rule,
      // so it lives on the tool description alone (lane-model-v12 ticket 12) —
      // it used to be stated here word-for-word as well, which is the two-homes
      // shape the three-way routing guard now forbids.
      "Address of a finished turn: `S<session>/T<prompt>`. The tool description states where a legitimate address comes from.",
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
  // Frozen legacy (lane-model-v12 ticket 14, spec D3e): membership is DERIVED
  // from `tags` — a turn belongs to whichever segment's tag it carries — so
  // the explicit note-time assignment has no work left to do. `noteInputSchema`
  // below `.omit()`s this key, so a caller still sending it gets `.strict()`'s
  // unrecognised-key parse error rather than a silently ignored parameter. It
  // is kept (rather than deleted like the relation fields ticket 08 retired)
  // because its describe is the POINTER a caller needs — the capability moved
  // into `tags`, one field up, and nothing else on this surface says so.
  segment: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Retired — a turn's segment is derived from its `tags`: carry that segment's tag. Present here only as frozen documentation.",
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
      "Two closed vocabularies, nothing else: the ONE tag of the segment this turn belongs to, and lane tags that segment has DECLARED. Both are on the segment roster — every segment's row leads with its own tag, and the attached segment's row expands a `- lanes:` line listing its declared lanes. Carrying a segment's tag IS how the turn joins it — there is no assignment verb. Anything else rejects, listing what is legal here; a second segment tag rejects naming both; a lane tag without its own segment's tag rejects naming the one that is missing. Omit entirely when nothing fits — tags is optional.",
    ),

  mode: noteModeShape,

  // RETIRED (lane-model-v12 ticket 08, ruling [S15069/T1651]: 边整块归结算).
  // The seven relation parameters, their seven `retract…` mirrors and the
  // frozen `supersedes` documentation field all left THIS shape. They are not
  // `.omit()`ed like `segment` above: an `.omit()` keeps a field object alive
  // for another shape to reuse or for a describe to point at, and neither
  // applies here — `settlementNoteInputShape` declares its OWN relation fields
  // (the two-sided `{turn, tailTag, headTag}` form this surface never had), so
  // a copy left behind would be an unreferenced description of a contract that
  // is no longer anyone's.
  //
  // A caller still sending one gets `.strict()`'s unrecognised-key parse error;
  // `mcp/note.ts`'s `noteTool()` additionally names settlement for a caller
  // that reaches the function without this schema in front of it.


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
      "detach",
      "write",
      "edit",
      "close",
      "retag",
      "declare",
      "undeclare",
      "append",
      "replace",
      "assign",
    ])
    .describe(
      'create: mint a new segment. attach: bind the current session to one (`id="E<n>"`) and get its card back; called with NO id it returns the pick list of live segments instead, so a caller that does not know which segment to name can ask. detach: cancel this session\'s binding to one segment (`id`), or to every segment when called with no id. write: replace one field\'s value whole (`value`; null or "" clears it). edit: find `oldString` in one field and swap in `newString`. close: toggle the segment off the roster (or, called again, back on). retag: NAME the segment — one globally unique `tag`, or null to clear it; a turn belongs to this segment by carrying that tag, so there is no assignment verb. declare: mint a lane (`id`, `tag`) — a workflow identity inside this segment, reported with how many existing turns already carry the word and therefore become its members. undeclare: remove a lane, refusing while any MEMBER TURN in the segment still carries the tag (lane-model-v12 ticket 10 moved membership onto the turn\'s own tags, so that is what the guard counts).',
    ),
  id: z
    .string()
    .min(1)
    .optional()
    .describe(
      'write/edit/close/retag/declare/undeclare (required): the target segment — an "E<n>" address only. OPTIONAL on attach (omit it for the pick list) and on detach (omit it to cancel every binding). Not used by create.',
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
      'create only, optional: seed member turn addresses ("S<session>/T<prompt>", as seen in context — never recalled or invented). Membership is recorded for exactly these turns; a call naming even one bad address seeds none.',
    ),
  // Frozen legacy (lane-model-v12 ticket 14): a segment is ONE tag now, and
  // `tag` below carries it. Declared here only so `rememberInputSchema`'s
  // superRefine can name the replacement, the same precedent `topic` set.
  tags: z
    .array(z.string())
    .optional()
    .describe(
      "Retired — a segment has ONE tag now, globally unique; pass it as `tag`.",
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
  // Frozen legacy (lane-model-v12 ticket 14): `assign` retired with the
  // explicit membership model, and `turns` was only ever its selector.
  turns: z
    .array(z.string())
    .optional()
    .describe(
      "Retired with the `assign` verb — a turn's segment is derived from its own `note` tags.",
    ),
  // Ticket 14 (lane-model-v12 spec D3e): ONE parameter for both vocabularies,
  // because both are single tags answering to the same canonical predicate —
  // the segment's own name (create/retag) and a lane's (declare/undeclare).
  // What separates them is WHICH VERB is speaking, not the shape of the value.
  tag: z
    .string()
    .nullable()
    .optional()
    .describe(
      'create (optional) / retag (required): the segment\'s ONE globally unique tag — the word a turn carries in its own `note` tags to belong here; null on retag clears it, and an unnamed segment takes no members. declare/undeclare (required): one LANE tag, unique within this segment. Either way CANONICAL form only — NFC-normalized, trimmed, lowercase, no interior whitespace, and no ":" namespace prefix (that namespace is the hooks\'). A non-canonical value rejects naming the exact problem rather than being silently normalized, so "write-gate" / "Write-Gate" / " write-gate " can never become three lanes.',
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
  // options ("expected one of \"turns\"|\"milestones\"|\"lane\""), so no
  // custom superRefine is needed to satisfy "parse error naming the
  // surviving views".
  // Ticket 07 (lane-declaration spec D8): `"lane"` joins the enum so
  // `timeline(id="E60/L*", view="lane")` — the spec's own literal call —
  // does not fail `.strict()` validation. It is otherwise inert; routing to
  // the lane view is driven by the id's own `E<n>/L*`/`E<n>/L<n>` suffix
  // (see `mcp/timeline.ts`'s `parseSegmentLaneId`/`narrowToBaseView`).
  view: z.enum(["turns", "milestones", "lane"]).optional(),
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
// exposes (`shared/turn-phase.ts`'s `EDGE_RELATIONS` — a different seven-word
// set at ticket 08's own time; lane-model v12's seven words now),
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
  // Ticket 14 (lane-model-v12 spec D3b: "主 agent 与结算两侧的 `.describe()`
  // 分别写"): the RULE is byte-identical on both surfaces — one gate, one
  // function — but what a writer needs told differs. The main agent is told
  // where to READ the vocabulary (its card); settlement is told that it is the
  // side that can EXTEND it, and that rewriting this field moves the turn.
  tags: z
    .array(z.string())
    .optional()
    .describe(
      "Two closed vocabularies, nothing else: the ONE tag of the segment this turn belongs to, and lane tags DECLARED in that segment. Writing this field is how a turn's segment changes — membership is derived from it, there is no assignment verb — so a whole-set replacement that drops the segment tag makes the turn unowned. Anything else rejects, listing what is legal there; a second segment tag rejects naming both; a lane tag without its own segment's tag rejects naming the one that is missing. When the right lane does not exist yet, remember(declare) mints it first — that is this side's job, not the main agent's.",
    ),
  // Lane-model-v12 ticket 08 (ruling [S15069/T1651]): the seven relation
  // parameters and their seven `retract…` mirrors are DECLARED HERE now, not
  // borrowed from `noteInputShape` — that shape has none, because edges belong
  // wholly to this side. Targets are turn addresses, `S<session>/T<prompt>`
  // (brackets optional); a segment target is refused (relations are turn-only).
  // No `mode`: there is no PRIOR value at this layer to write over or edit — a
  // relation write only ever ADDS a row, and removing one is a retraction.
  //
  // ADR-0009's three-way split (FORMAT on each `.describe()`, TIMING on the
  // tool description, JUDGMENT in the Memory Rubric alone) leaves each describe
  // with the one-line READING of its word plus `RELATION_TAG_FORM_LINE`'s
  // two-sided admission test; no describe states a phase requirement, since v12
  // retired phase pairing outright, and none says which word to choose.
  override: z
    .array(relationTargetEntryShape)
    .optional()
    .describe(
      "Addresses a predecessor whose main result this turn OVERTURNS, WITHDRAWS or REPLACES — one word for all four, disproof included (a measurement contradicting the cited claim is an override, not a separate verdict word). " +
        RELATION_TAG_FORM_LINE + " Judgment lives in the Memory Rubric.",
    ),
  narrows: z
    .array(relationTargetEntryShape)
    .optional()
    .describe(
      "Addresses a result this turn still holds but cuts a piece OUT of — a correction or limit on a detail. " +
        RELATION_TAG_FORM_LINE + " Judgment lives in the Memory Rubric.",
    ),
  extends: z
    .array(relationTargetEntryShape)
    .optional()
    .describe(
      "Addresses a result this turn still holds and adds a piece TO. " +
        RELATION_TAG_FORM_LINE + " Judgment lives in the Memory Rubric.",
    ),
  indexes: z
    .array(relationTargetEntryShape)
    .optional()
    .describe(
      "Addresses the nodes this turn converges on and stands for — they carry its content and readers reach them through it (a settlement's carrying members, a release's shipped artifacts). No membership or terminus condition. An indexed target is not also consumed by an UNSETTLED edge; a lane-placed consume may sit beside a lane-placed indexes — lane structure and convergence declaration are separate facts. " +
        RELATION_TAG_FORM_LINE +
        " A same-lane entry additionally DECLARES that lane's convergence (its terminus). Judgment lives in the Memory Rubric.",
    ),
  consume: z
    .array(relationTargetEntryShape)
    .optional()
    .describe(
      "Addresses work this turn used, with no liability if it turns out wrong — never written beside an extends on the same pair, and never unsettled beside an indexes (each already implies it); a LANE-PLACED consume beside a lane-placed indexes is legal — the declaration does not carry the lane-structure fact. " +
        RELATION_TAG_FORM_LINE + " Judgment lives in the Memory Rubric.",
    ),
  grounds: z
    .array(relationTargetEntryShape)
    .optional()
    .describe(
      "Addresses a finding or ruling this turn's own conclusion FALLS WITH if it were false; absorbs the retired grounded-on/encodes. One route to the decision: when a SEPARATE delivery turn wrote the spec, THAT turn carries the grounds and the other artifacts consume it; with design and spec in one turn, each artifact grounds directly. Turn-only; a self target is refused, for this word as for every other. " +
        RELATION_TAG_FORM_LINE +
        " Judgment lives in the Memory Rubric.",
    ),
  verifies: z
    .array(relationTargetEntryShape)
    .optional()
    .describe(
      "Addresses the claim this turn's own result VERIFIES or supports. No type requirement on either end — a check that came out AGAINST the cited claim is an override, not this word. " +
        RELATION_TAG_FORM_LINE + " Judgment lives in the Memory Rubric.",
    ),
  // The seven retraction mirrors. A relation is never overwritten (a relation
  // write is purely additive), so correcting a wrong one is two auditable acts
  // — retract, then write the right relation. The spelling is mechanical
  // (`retract` + the relation parameter's own name), pinned against
  // `db/citations.ts`'s derived `RETRACTION_FIELD_ENTRIES` by a guard test, so
  // the two halves of the vocabulary cannot drift apart.
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
  // The retraction-only mirrors (finding P1-2) used to be re-exported here
  // too: settlement is the surface that actually MEETS a frozen-legacy row —
  // the commit gate's E2 refusal names it — so a settlement window with no way
  // to delete one was the deadlock those parameters broke. Lane-model v12
  // ticket 03 emptied the rows and closed the CHECK behind them, so there is
  // no such row left for a settlement window to meet. See `noteInputShape`.
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
// `.omit({ segment: true })` is what actually retires that field from the note
// tool's WIRE schema — see `noteInputShape.segment`'s own doc comment for why
// the field object still exists (its describe is the pointer at where the
// capability went) even though no caller of THIS schema may send it. A supplied
// `segment` is then `.strict()`'s ordinary unrecognised-key parse error, not a
// bespoke message, the same reasoning `grade`'s retirement (ADR-0003) settled.
// `supersedes` left the `.omit()` list with the field itself (lane-model-v12
// ticket 08): with no relation parameter on this shape at all, a frozen
// documentation entry for one retired relation WORD taught nothing the caller
// could act on.
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
  .omit({ segment: true })
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
  // Lane-model-v12 ticket 14 (spec D3e): membership is derived from a turn's
  // own tags, so there is nothing left to assign.
  assign:
    "membership is derived from a turn's tags — put the segment's own tag in that turn's `note` tags instead.",
};
export const rememberInputSchema = z
  .object(rememberInputShape)
  .strict()
  .superRefine((data, ctx) => {
    if (data.tags !== undefined) {
      ctx.addIssue({
        code: "custom",
        message:
          "`tags` has retired on this tool — a segment has ONE globally unique tag now; pass it as `tag`.",
        path: ["tags"],
      });
    }
    if (data.turns !== undefined) {
      ctx.addIssue({
        code: "custom",
        message:
          "`turns` has retired with the `assign` verb — a turn's segment is derived from its own `note` tags.",
        path: ["turns"],
      });
    }
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

