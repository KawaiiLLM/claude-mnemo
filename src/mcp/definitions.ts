import { z } from "zod";

import { FIELD_BUDGET_ELIGIBLE_FIELD_NAMES, RECALL_TURN_FIELD_NAMES } from "./memory-filter";
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

// ---------------------------------------------------------------------------
// Size ceilings (peer round three finding 03). Every public size control was
// `.positive()` and nothing else, so `pageSize: 1_000_000` rendered a million
// turns into one page and `pageBudget: 1_000_000` admitted arbitrarily many
// blocks. A worker audience then truncated the result at
// `WORKER_TOOL_RESULT_MAX_CHARS` instead of yielding the next page it had
// promised, and an audience without that envelope simply exceeded the host's
// own limit.
//
// These are REFUSALS, not clamps: a silently reduced number teaches the
// caller that its request was honoured. They are also independent of caller
// input by construction — a maximum a caller can raise is not a maximum.
//
// The numbers derive from the transport cap rather than taste.
// `WORKER_TOOL_RESULT_MAX_CHARS` is 100,000 characters, and this render is
// effectively all-ASCII (~4 chars/token), so ~25,000 tokens is the whole
// budget a single tool result can carry. `MAX_PAGE_BUDGET` is that ceiling;
// `MAX_TURN_BUDGET` is one item allowed at most a fifth of it, since a page
// holding exactly one item is a degenerate page; `MAX_PAGE_SIZE` bounds the
// item COUNT for the routes that page by count rather than by tokens.
//
// Hoisted above `memoryFilterShape` (ticket 11, per-field recall budgets):
// `MAX_TURN_BUDGET` is also the ceiling on each `filter.fieldBudgets` value
// below, and a `const` referenced inside an object literal that executes at
// module load has to be declared first in the same file.
// ---------------------------------------------------------------------------

/** ~`WORKER_TOOL_RESULT_MAX_CHARS` at ~4 characters per token. */
export const MAX_PAGE_BUDGET = 25_000;

/** One item may claim at most a fifth of a whole page. */
export const MAX_TURN_BUDGET = 5_000;

/** Item-count ceiling for the count-paged routes. */
export const MAX_PAGE_SIZE = 500;

// Ticket 04 (spec "Tools"): the one structured filter grammar shared by
// `recall` and `timeline` — mirrors `MemoryFilterInput` (mcp/memory-filter.ts)
// field-for-field. `.strict()` so an unrecognised filter key (e.g. the
// retired `project`) is a parse error, not a silent no-op.
export const memoryFilterShape = {
  type: z
    .string()
    .optional()
    .describe(
      "Exact match against one stored `type` value (a turn's type array, or a task's).",
    ),
  tag: z
    .string()
    .optional()
    .describe(
      'Exact match against one whole `tags` array element — a prefix does not match. Both kinds are addressable: a bare word (a task or lane tag) and a subject word with its namespace ("topic:<word>").',
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
  // Ticket 11 (per-field recall budgets, USER RULING S15069/T2106): a field
  // named here spends exactly that many tokens on its OWN word-boundary cut
  // instead of sharing the shared `turn`/equal-split budget with the rest —
  // one mechanism covering both of this codebase's truncation paths (the
  // browse feed's per-field equal split, the addressed render's whole-block
  // line ladder). An unnamed field keeps its normal behavior; omitting
  // `fieldBudgets` entirely is byte-identical to before this existed.
  //
  // Ticket 13 (implementation-review P2 sweep, item 3): the key set is
  // `FIELD_BUDGET_ELIGIBLE_FIELD_NAMES` — `RECALL_TURN_FIELD_NAMES` minus
  // `files`/`observations` — NOT the full field vocabulary `fields` itself
  // accepts. Neither field's renderer ever reads a `fieldBudgets` entry
  // (`files` renders a whole tree via `renderFileTree`; `observations`
  // renders as nested child turns), so admitting the key here used to parse
  // and then silently no-op, contradicting "one mechanism covering both
  // paths" above. `title` stays admitted — see `memory-filter.ts`'s own
  // comment on `FIELD_BUDGET_ELIGIBLE_FIELD_NAMES` for why that ONE
  // remaining no-op is a reviewed, documented guarantee rather than an
  // unread key.
  fieldBudgets: z
    .partialRecord(
      z.enum(FIELD_BUDGET_ELIGIBLE_FIELD_NAMES),
      z.number().int().positive().max(MAX_TURN_BUDGET),
    )
    .optional()
    .describe(
      `Optional per-field token cap, keyed by a \`fields\` name — e.g. { prompt: 50 } reads a note's prompt as only its first ~50 tokens while other selected fields (content, metadata, ...) render complete under the shared \`turn\` budget. Word-boundary cut, same rule \`turn\` uses. \`files\`/\`observations\` are refused here — neither renders through a per-field cut, so a budget on either would silently do nothing; \`title\` is accepted (a documented no-op: its line is never cut regardless of budget).`,
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
    "Search past sessions for design rationale, rejected alternatives, decisions, and user corrections — the *why* behind the code, which source never records. For current behavior or mechanism, read the source first. The injected blocks are an index, not the memory — never conclude a fact is unrecorded because no injected block carries it. Materializing memory into a durable artifact (spec, ticket, doc, summary): any ruling you cannot quote verbatim — especially one from behind a compact — comes from recall/replay first, never from summary memory. Paginated index; hand off to the mnemo-replay skill for a turn's full untruncated text and tool I/O from the database (raw JSONL only for exact bytes). `id` also accepts a comma-separated list of same-kind addresses (e.g. `id=\"E31, E32\"` or `id=\"S12, S15\"`) — each item parses through the same grammar below, renders in order, and shares this call's page/turn budgets; mixed address kinds or any one invalid item rejects the whole call. A list of TURN addresses (`id=\"S1/T4, S1/T9, S2/T2\"`) is assembled as ONE page rather than several stapled together: the turns render in the order you named them under one header per session, an address named twice is read once, and the whole page carries one legend. `id=\"E<n>\"` (also `E*`, `E1..9`) recalls the task card — the accumulated impression of one arc of work, not a session or a turn — so check whether one already covers a task before redoing it: `[open]` is that task's still-live working state, `[delivered]` is its settled impression. `id=\"E<n>/S<a>/T<b>\"` addresses one of the task's own members by its ordinary `S<session>/T<prompt>` address, scoped to that task — the same address you would cite it by anywhere else; `id=\"E<n>/S<a>/T<b>..S<c>/T<d>\"` is a range over the task's own EVENT ORDER between those two endpoints inclusive (the two endpoints need not share a session), and `id=\"E<n>/T*\"` is every member. The retired ordinal form (`E<n>/T<m>`, the task's own 1-based event-order position — a THIRD meaning the same `E<n>/T<m>` string once carried elsewhere) refuses outright, naming this grammar, rather than silently landing on the wrong turn. `id=\"E<n>/#<tag>\"` addresses one DECLARED lane by NAME — the CANONICAL, pasteable lane address, reading the same subset of members `timeline`'s own lane picker shows. `timeline`'s `E<n>/L<n>` is a render-position ordinal for interactive picking only, never a pasteable address (the same ordinal can point at a different lane on a later render) — once you have picked one, address it here by its `tag` instead. An empty or non-canonical tag refuses, naming the exact problem. `filter.fields` is the one field-selection knob: pick any combination of turn fields (default title, metadata, content — metadata carries the local time plus a turn's `type`/`tags`); add `relations` to see THIS turn's own direct edges, and nothing further — every edge it cites OUT first (`<words> -> <addr>`), then every edge cited INTO it (`<- <addr> <words>`). No downstream hops, no branch cap, no `+N more`: the whole set renders, both directions, so what you see is what the write gate will check you against. The trailing `(#tail → #head)` is the edge's two stored lane sides — `(#lane)` when both settle in one, `·` for a side nobody settled, `[unplaced]` when neither did — and an `E<n>/` in front of a lane names that endpoint's CURRENT task when it differs from this turn's (resolved at read time, advisory: not part of what an edge write is checked against). Several relation words fold onto one line only when their two sides are identical; one pair placed two ways is two lines. Addresses are relative to the turn's own session — a bare `T<m>` is that session, `S<n>/T<m>` another (Law-8 filtered; a prose-only citation carries no relation word and never appears here). A response that selected `relations` carries ONE legend line for the whole response. Off by default, a read convenience that grants nothing new. The 3-hop TREE view of the same node — where the thread goes, rather than what this node touches — is `timeline(id=\"S<n>/T<m>\")`. A task card (`id=\"E<n>\"`) shows its metadata header and counts with the newest field rows on page 1, every row plus a member index from page 2 on (`page` selects that, not a field). Body size is controlled by exactly two token budgets — `pageBudget` (page overflow → another page, never a truncated block) and `turn` (per-item cap on every rendered session/turn/observation, word-boundary cut). Reading also LICENSES writing back what you read: a `write` over a field another writer filled needs this read to have delivered THAT field untruncated — raise `turn` (or `pageBudget` on a task card) and re-read if it came back cut; a plain recall already earns this for `type`/`tags` too, since metadata is on by default — only a caller who narrowed `filter.fields` away from it needs to ask for `metadata` back explicitly. `edit` needs a current read, never a complete one. `query` is pure full-text search — it has no in-string dialect; a query containing `tag:foo` searches those literal characters. Use `filter` to scope by type/tag/session/time/file instead, AND-composed with `query` and with `id` alike. Bare `recall()` (no `id`, no `query`) lists tasks before sessions. Tasks also surface in `query=`/`filter` search alongside sessions and turns.",
  timeline:
    "Render the temporal/decision shape of a past session — gaps, tool bursts, compact boundary, broken-prompt candidates, and view-specific timeline bodies. Single-session view with range selectors plus page/pageSize pagination on the `turns` view. Optional `view` selects `turns` (default turn table) or `milestones` — a lane-first structural election, not a score: identity tiers first (releases, then a tier held for index-declaring nodes which currently seats NOBODY until that rule lands, then nodes those elect index, then correctors, then everything else), in-degree breaking ties within a tier, recency deciding the rest; an edgeless window degrades to a flat recent-N list. The milestones view has no pagination of its own — `page`/`pageSize` have no effect on it — election ranks every window candidate and `pageBudget` (a token budget, default 1000) is the seat count: it decides how many of the ranked candidates actually render, cutting lowest election rank first. `phases` has retired. `id=\"E<n>/#<tag>\"` is the CANONICAL, pasteable lane address — by NAME, the same address `recall(id=\"E<n>/#<tag>\")` resolves to the same member subset — and renders exactly that ONE lane, identically to whichever `E<n>/L<n>` currently points at it; an unknown tag refuses, naming the task's declared lanes. `id=\"E<n>/L*\"` lists every declared lane (or `E<n>/L<n>` for one, by RENDER-POSITION ordinal — interactive picking only, never a pasteable address, since the same ordinal can point at a different lane once the list's own oldest-first order shifts), ascending, oldest lane first, paginated by `page`/`pageBudget` when the lane blocks overflow one page (overflow rolls to another page, a lane's own block is never split mid-page, and the page states the exact next call; a lane too big for one page shows its newest page in the list — drill via its `E<n>/#<tag>` address). Each lane renders as a ruled adjacency table over its SETTLED members (settlement-covered canonical turns; skipped/rewound/compact-synthetic turns are out everywhere): a header (`E<n>/#<tag> \u00b7 <n> settled \u00b7 <n> forward \u00b7 <n> mirrors \u00b7 islands <a>+<b> \u00b7 frontier <k>` \u2014 forward and mirror counts each verifiable against the page's own lines; islands count both-endpoints-in-lane connectivity only, so a cross-lane edge raises forward but never islands) and a one-line arrow legend, then the chain skeleton: roots processed newest to oldest, EVERY valid out-edge of a lane member rendered exactly once \u2014 `<relation> -> <addr>` in-lane (the heaviest relation takes the root's main line, every other out-edge its own `\u2514` line; a line continues through a first-visit single-out node and otherwise stops, `^` marking a node expanded elsewhere on the page), `<relation> => S<n>/T<m>^(E<n>/#tag)` when the edge leaves the lane, and `\u2514 <relation> <= S<n>/T<m>^(E<n>/#tag)` for another lane's edges INTO this one (after all branches; same-relation sources fold onto one line). On a chain line addresses run-length fold: the line's first address is always full `S<session>/T<prompt>`, and a bare `T<m>` after it continues the PREVIOUS address's session \u2014 cross-lane stubs and mirror sources never fold. Then a time-ascending title table (`T<n> <MM-DD> <type words> <title>`) for exactly the nodes the skeleton showed; a settled member with no edges is counted in the header, never drawn. A lane too big for one page splits into contiguous time-range pages, newest first — on the single-lane addresses (`E<n>/#<tag>`, `E<n>/L<n>`) `page` selects one (default 1 = newest); a paged lane's header inserts `<p>/<N> S<a>/T<b>..S<c>/T<d>` (its position plus its own newest..oldest range) after the mirror count, a branch whose target sits on another page stops as `<relation> -> S<n>/T<m>^ (p/N)` (the target's page), and `└ <relation> <- S<n>/T<m>^ (p/N)` mirrors a SAME-lane edge in from a NEWER page onto the head's own page (in-page inbound stays forward-only). Only a LONE member whose full rendering exceeds the page budget ships over budget, with an explicit self-including `[overflow +<n> tok]` marker. Every node is its own ordinary `S<session>/T<prompt>` address, addressable directly via `recall(id=\"S<session>/T<prompt>\")`; every hop address on a tree is relative to the ROOT line's session — a bare `T<m>` anywhere on the tree means the root's session, never the previous hop's. `timeline(id=\"S<n>/T<m>\")` is also its own legal call: one header row (`S<n>/T<m> MM-DD <emoji> <title>`) then that turn's own relation tree — the same shape and rule `recall`'s `relations` field renders for it. `filter` — the same structured grammar `recall` uses — AND-composes with the id selector's range to narrow which turns the current view considers.",
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
  //
  // RESTORED (main-agent-edge-capability ticket 01, ruling [S15069/T1651]):
  // lane-model-v12 ticket 08 read that ruling's "边整块归结算" as licence to
  // DELETE the seven relation parameters and their `retract…` mirrors from
  // this schema. The ruling's own words say the opposite — "工具上保留这些
  // 能力" ("the tools KEEP these capabilities") — so this ticket restores the
  // parameters at the capability they had before. What the ruling actually
  // narrows is GUIDANCE, not capability: the description below still teaches
  // only the common path (five fields), states that an edge is normally
  // settlement's hindsight call, and never claims the parameters are
  // unavailable — they simply are not the routine tool.
  note:
    "Write or correct a turn's note. `turn` is `S<session>/T<prompt>`: the injected \"mnemo current turn\" line and the backlog-relief block are the ONLY sources of a note address — never recall one from memory, never invent one. Timing: (1) note only FINISHED turns, never the one in progress; (2) a batch of note/skip calls alone opens when backlog relief appears, or to fix a note already written — never just to write one turn's note early; (3) a batch opens a turn, never ends one — only text after the last tool call renders, so a trailing note call eats the reply before it.\n" +
    "skip: true with `turn` alone, when a future retriever would find nothing unique — check: deleting it costs no decision, progress, or coherence. Content gone and not recovered is skipped, never invented. Never skip a user decision, correction, veto, or any turn with a conclusion, rejected option, or lesson.\n" +
    "Cite turns only as S15069/T332, ids seen in injected context; never include <private> content.\n" +
    "This tool ordinarily writes five fields — title, content, insight, type, tags. Edges (correct/verify/use and their retract… mirrors) are settlement's whole business normally — a hindsight judgment over the finished window — so you will rarely need them; the parameters stay here for when you do. A prose `S15069/T332` still records that this turn REFERS to that one; it states no relation.\n" +
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
  //
  // lane-model-v12 ticket 21 (peer review B4; user ruling 2026-08-26: "不能静默
  // 新建") makes that content decision, and lands it HERE rather than in the
  // rubric: roster-first / reuse-before-new is a CALL contract (when this verb
  // may be called at all), which the three-way split routes to the tool
  // description. What the rubric's action half carries instead is the judgment
  // — 有合适的就写,没有就不写 — plus the one principle a describe cannot state
  // because it is not about this tool: ASK THE USER FIRST. `create` states that
  // precondition at BOTH its tiers (ticket 05 retired `declare` into the lane
  // tier), because a task tag and a lane tag are two tiers of one vocabulary
  // and one policy. The settlement side gets
  // the OPPOSITE half of the same rule (it is headless and cannot ask) on
  // `settlementNoteInputShape.tags` and in its own prompt's duty 1.
  remember:
    `Maintain a task — claude-mnemo's long-lived semantic container for one undertaking (记住; \`note\` is the per-turn episodic surface, 记录). Ten verbs: \`create\` mints a container — TIER chosen by \`id\`: omitted mints a new task, reuse a fitting one from the roster in view; an "E<n>/#<tag>" address mints a LANE inside an existing task instead, lanes otherwise being settlement's to declare. Same precondition at both tiers: when NONE fits, ASK THE USER (AskUserQuestion) whether to open one and call this only on a yes, never silently — lane-tier create additionally reports how many existing turns already carry the word and therefore become its members; \`attach\`/\`detach\` bind or unbind this session (\`id="E<n>"\`) — rarely needed by hand, since a turn's task tag attaches it; \`write\` replaces one field's value whole; \`edit\` finds \`oldString\` in one field and swaps in \`newString\` — ambiguous or missing rejects loudly naming which, \`newString: ""\` deletes the matched text; \`close\` toggles the task off the roster, or, called again, back on; \`retag\` renames a container, same TIER routing as \`create\` — a plain \`id\` NAMES the task (one globally unique \`tag\`; a turn belongs here by carrying that tag in its own \`note\` tags, so there is no assignment verb), an "E<n>/#<tag>" \`id\` instead renames that LANE to \`tag\`; \`delete\` removes an EMPTY container the same way — a task with no member and no declared lane, or a lane with no member turn carrying it — refusing otherwise and naming the count; no \`force\`, since strong-deleting a live container is the wrong verb, not a warning; \`clear\` empties a container and \`merge\` folds it into another, both leaving \`delete\` a shell it will take — same TIER routing, detailed on \`verb\`. Editable fields: ${WORKING_STATE_FIELD_LIST} (Working State) plus insight (summary) — each an uncapped markdown row list; settled understanding is settlement's impression, not a field. Add a row by anchoring \`edit\` on the last row (oldString = it, newString = it + the new line); reordering or a full rewrite is \`write\`. A closed task refuses write/edit, naming \`close\` as the way back. Rows may cite \`S<session>/T<prompt>\`/\`E<n>\`, ids seen in context only, never invented. Tool-call markup (\`<parameter\`, \`<invoke\`, …) is rejected, nothing stored. Every field is written in English.
` +
    "Maintenance is advisory, never a gate: every write/edit reports turns since this task was last touched.\n" +
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
      'Selector: "S12" | "S12/T3" | "S12/T3..7" | "S12/T3/O*" | "E31" | "E31/#tag" (a lane, by name — the canonical, pasteable lane address) | "E31/T*" | "E31/S12/T3" | "E31/S12/T3..S45/T7" | "O87" | bare "T418" (global DB id). A range\'s second endpoint may repeat the kind letter ("T3..T7" ≡ "T3..7"); comma-separated lists of one kind allowed.',
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
  pageSize: z.number().int().positive().max(MAX_PAGE_SIZE).optional(),
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
  pageBudget: z.number().int().positive().max(MAX_PAGE_BUDGET).optional().describe(
    'Page-level token budget, default 1000: every listing surface packs items into a page against it, and overflow starts the NEXT page — never a truncated block mid-page. On a task card (id="E<n>") page 1 additionally elides field rows oldest-first against it, marked "… +N earlier"; page 2 renders every row uncapped.',
  ),
  // Ticket 11: the ONE per-item size knob left, alongside `pageBudget` — no
  // more depth-dependent default. Applies to every rendered session, turn,
  // and observation block; a caller widening `filter.fields` beyond the
  // default (title, metadata, content — ticket 12) should usually raise
  // this too, or the extra fields mostly get cut by the unchanged default
  // budget.
  turn: z.number().int().positive().max(MAX_TURN_BUDGET).optional().describe(
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

// settlement-ergonomics ticket 01 (spec D1): the retired literals
// ("overwrite", "append") LEAVE this union outright — the opposite of the
// write-mode-edit-semantics ticket 05 choice this replaces. That ticket kept
// them declared on purpose so `noteInputSchema`'s `superRefine` below could
// name a replacement; measured cost of keeping a rejected word in the
// contract was 13 calls in one real settlement run sending `mode.tags:
// "append"` because the schema — read by the model as part of its own
// prompt — said it was legal. A caller still sending one now gets zod's
// generic union error, not a named-replacement message; that message
// survives only on the handler-runtime belt-and-braces path
// (`mcp/field-mode.ts`'s `RETIRED_FIELD_MODE_REPLACEMENT`), reached by a
// caller that bypasses this schema entirely (a restored transcript replaying
// an old tool-use payload, or a direct hand-rolled call — never a real
// schema-validated one, since `note`/`remember` both parse against this
// union first).
const fieldModeValueShape = z.union([z.literal("write"), fieldEditModeShape]);
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

// settlement-ergonomics ticket 01: the retired-literal named-replacement
// message (`RETIRED_NOTE_MODE_LITERAL_MESSAGE`, write-mode-edit-semantics
// ticket 05) is gone along with the branch of `noteInputSchema`'s
// `superRefine` that read it — with "overwrite"/"append" out of
// `fieldModeValueShape`'s union above, a `mode.<field>` carrying either value
// fails the object's own base-shape parse, so that superRefine branch could
// never run (zod does not invoke `superRefine` on data that failed the
// wrapped schema first). Kept dead would have been kept wrong.
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
// every relation AND retraction field on BOTH write surfaces below shares the
// identical zod shape rather than fourteen independently hand-kept copies.
//
// RESTORED to `noteInputShape` too (main-agent-edge-capability ticket 01,
// ruling [S15069/T1651] — see that shape's own field block for the full
// restoration note). The two side values stay plain strings on both surfaces:
// the write gate REFUSES a non-canonical tag naming the exact problem
// (`db/lanes.ts`'s `checkCanonicalLaneTag`) rather than normalizing it, so no
// schema-level coercion may run in front of it, on either writer.
const relationTargetEntryShape = z.union([
  z.string(),
  z
    .object({
      turn: z.string().min(1),
      tailTag: z.string(),
      headTag: z.string(),
      // relation-vocabulary-v13 ticket 02: CORRECT's FULL-or-PARTIAL bit, on
      // the ENTRY because it is a fact about this one edge — one `correct` call
      // may fully overturn one predecessor and partially limit another.
      // OPTIONAL here and required by the WRITE PATH (`db/citations.ts` ->
      // `shared/relation-class.ts`'s `checkRelationCoverage`): the schema cannot
      // express "required on `correct`, refused on `verify`/`use`" while all
      // three fields share one entry shape, and a per-field entry shape would
      // have put the pairing rule in three places instead of one.
      coverage: z.enum(["full", "partial"]).optional(),
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
  "must be canonical, DECLARED in that endpoint's task, and already on that " +
  "endpoint turn's own tags. The same word on both sides means one lane spanning " +
  "the edge; two different lanes is a legal crossing, and so is the same word in " +
  "two different tasks, which is two lanes.";

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
      `Turn (~${NOTE_TOKEN_BUDGET.title} tok): the INDEX, not the conclusion — one English sentence saying what this turn is doing, standing alone in a title-only list, enough to recognise it among titles alone. No activity/topic prefix — that title format is retired; type/tags carry that. Name the decider when a ruling landed. No session-local codewords without a gloss. Length tracks this turn's output, not the effort spent.`,
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
  // is kept (rather than deleted, the way the relation fields WERE for one
  // ticket before this one restored them) because its describe is the POINTER
  // a caller needs — the capability moved into `tags`, one field up, and
  // nothing else on this surface says so.
  segment: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Retired — a turn's task is derived from its `tags`: carry that task's tag. Present here only as frozen documentation.",
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
      "Two closed vocabularies plus one free namespace. The closed two: the ONE tag of the task this turn belongs to, and lane tags that task has DECLARED. The task tags lead the roster's rows; the declared lanes are the frontier digest lines — one `#tag` line per declared lane, zero-settled lanes included — in the attached task's SessionStart milestones block and on the attach receipt. Carrying a task's tag IS how the turn joins it — there is no assignment verb. A bare word outside those two rejects, listing what is legal here; a second task tag rejects naming both; a lane tag without its own task's tag rejects naming the one that is missing. The free namespace is `topic:<word>` — one subject word for this turn, needing no container and no permission; it never joins a task or a lane. Omit the closed part entirely when nothing fits — an empty membership is the ordinary outcome; opening a task or a lane that does not exist yet is `remember`'s own call, with the user's yes in front of it, never a side effect of this one. A whole-set write must restate every `topic:` word the turn already carries — they are permanent, and dropping one rejects naming it.",
    ),
  // The topic correction form (staged-settlement spec Rev 5). NOT a mode: a
  // mode says how a field is written, while this names WHICH stored word was
  // wrong — the same register as the `retract…` mirrors, an instruction about
  // this one call rather than a field of the turn.
  retireTopic: z
    .string()
    .min(1)
    .optional()
    .describe(
      'The one `topic:` word this call retires, spelled exactly as stored, prefix and all. Requires `tags` in the same call, holding the replacement word plus every other topic word the turn keeps — a topic word is only ever corrected (old and new named together), never simply deleted.',
    ),

  mode: noteModeShape,

  // RESTORED (main-agent-edge-capability ticket 01, ruling [S15069/T1651]).
  // lane-model-v12 ticket 08 deleted these fourteen fields from THIS shape,
  // citing the same ruling — but the ruling's own verbatim words say the
  // capability stays ("工具上保留这些能力"): only the GUIDANCE narrows (the
  // tool description above teaches the common five-field path and says an
  // edge is normally settlement's hindsight call), not the schema. Declared
  // HERE, the owning shape, exactly as they were before ticket 08's removal —
  // `settlementNoteInputShape` below borrows these same field objects by
  // IDENTITY rather than declaring its own, so a contract change to one word
  // reaches both writers from a single edit and the two can never drift into
  // two vocabularies for it.
  //
  // Targets are turn addresses, `S<session>/T<prompt>` (brackets optional); a
  // segment target is refused (relations are turn-only). No `mode`: there is
  // no PRIOR value at this layer to write over or edit — a relation write only
  // ever ADDS a row, and removing one is a retraction.
  //
  // ADR-0009's three-way split (FORMAT on each `.describe()`, TIMING on the
  // tool description, JUDGMENT in the Memory Rubric alone) leaves each describe
  // with the one-line READING of its word plus `RELATION_TAG_FORM_LINE`'s
  // two-sided admission test; no describe states a phase requirement, since v12
  // retired phase pairing outright, and none says which word to choose.
  // relation-vocabulary-v13 ticket 02: THREE CLASSES REPLACE SEVEN WORDS.
  // Each describe carries the one-line READING of its class plus
  // `RELATION_TAG_FORM_LINE`'s two-sided admission test; the PRECEDENCE that
  // decides between them (CORRECT > VERIFY > USE, and both are subsets of USE)
  // is judgment and lives in the Memory Rubric alone, per ADR-0009's three-way
  // split. Property order is the precedence's own order, most specific first.
  correct: z
    .array(relationTargetEntryShape)
    .optional()
    .describe(
      "Addresses whose PRINCIPAL result this turn negates, limits or re-scopes. " +
        'REQUIRES the coverage bit on every entry: `"coverage": "full"` when no substantial part ' +
        "of the cited result may still serve as a PREMISE (it survives only as history — permanent " +
        "historical facts like having dispatched something or written a file never rescue it), " +
        '`"coverage": "partial"` when a definite non-empty part still stands as one. An entry with ' +
        "no coverage is refused, naming the missing bit. " +
        RELATION_TAG_FORM_LINE +
        " Judgment lives in the Memory Rubric.",
    ),
  verify: z
    .array(relationTargetEntryShape)
    .optional()
    .describe(
      "Addresses whose PRINCIPAL result this turn's own work confirms or supports — narrow: this " +
        "turn's work must bear on whether that result holds, and prose saying \"confirms\" about a " +
        "DETAIL of the cited turn is not this class. A check that came out AGAINST the cited result " +
        "is `correct`. No `coverage` — refused if sent. " +
        RELATION_TAG_FORM_LINE +
        " Judgment lives in the Memory Rubric.",
    ),
  use: z
    .array(relationTargetEntryShape)
    .optional()
    .describe(
      "Addresses whose PRINCIPAL result or output was a DIRECT input to this turn's own new " +
        "conclusion or output — actually consulted, adopted, tested or incorporated. Ancestors are " +
        "excluded: cite the layer you used, not what it rested on. The fallback class, used where " +
        "this turn makes no claim about whether the cited result still holds. No `coverage` — " +
        "refused if sent. " +
        RELATION_TAG_FORM_LINE +
        " Judgment lives in the Memory Rubric.",
    ),
  // The three retraction mirrors. A relation is never overwritten (a relation
  // write is purely additive), so correcting a wrong one is two auditable acts
  // — retract, then write the right relation. The spelling is mechanical
  // (`retract` + the class parameter's own name), pinned against
  // `db/citations.ts`'s derived `RETRACTION_FIELD_ENTRIES` by a guard test, so
  // the two halves of the vocabulary cannot drift apart.
  //
  // A mirror addresses a CLASS, so it deletes whichever stored row means that
  // class at the addressed placement — including a row written under the
  // retired seven-word vocabulary. That is what keeps every stored edge
  // deletable through three parameters (`db/citations.ts`'s
  // `retractTurnRelations` states why an undeletable row is a deadlock).
  retractCorrect: z
    .array(relationTargetEntryShape)
    .optional()
    .describe(
      "Addresses whose correct edge FROM this turn is deleted, whichever coverage bit it carries; " +
        "an address carrying no such edge rejects the call, naming it. No `coverage` here — " +
        "withdrawing an assertion does not restate it. " +
        RETRACTION_TAG_FORM_LINE,
    ),
  retractVerify: z
    .array(relationTargetEntryShape)
    .optional()
    .describe(
      "Addresses whose verify edge FROM this turn is deleted; an address carrying no such edge rejects the call, naming it. " +
        RETRACTION_TAG_FORM_LINE,
    ),
  retractUse: z
    .array(relationTargetEntryShape)
    .optional()
    .describe(
      "Addresses whose use edge FROM this turn is deleted; an address carrying no such edge rejects the call, naming it. " +
        RETRACTION_TAG_FORM_LINE,
    ),
  // The retraction-only mirrors (peer round T1466, finding P1-2) used to sit
  // here: `retractSupersedes`, and `retractRefutes` beside it from lane-model
  // v12 ticket 02. Both are DELETED by ticket 03. They existed to break the E2
  // deadlock — a stored row under a word the write vocabulary no longer has,
  // anchoring an error the settlement commit gate refuses to commit past, with
  // no deletion path — and that migration is what emptied the rows and took
  // both words out of `memory_edges`' own CHECK. A `retract…` parameter for a
  // word no row can carry only teaches the model a word it must not use.
  // `db/citations.ts`'s `RETRACTION_ONLY_RELATIONS` (now empty) carries the
  // full reasoning and the rule for re-opening the set.

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
// ticket 05: `field`'s own enum is `SEGMENT_EDITABLE_FIELDS` — the Working
// State fields plus `insight`, which joins the same write/edit mechanism
// (ADR-0001). Lane-impressions ticket 05 narrowed that list to four:
// decisions/done/next_steps left the product and `content` became the
// settlement-owned task-tier impression. `WORKING_STATE_FIELD_LIST` is
// declared above `MNEMO_TOOL_DESCRIPTIONS`, which quotes it.
//
// ticket 05 (write-mode-edit-semantics, spec D1/D14): `append`/`replace`
// retire as verbs, replaced by `write` (whole-field replacement, D11's new
// capability on this surface) and `edit` (ticket 05's rename of `replace` —
// identical oldString/newString shape). Lane-model-v12 ticket 14 retired
// `assign` the same way (membership derives from a turn's own tags now).
//
// settlement-ergonomics ticket 01 (spec D1) reverses ticket 05's choice: the
// three retired verbs LEAVE this enum outright rather than staying declared
// so `rememberInputSchema`'s `superRefine` below could name a replacement —
// the enum is part of the schema the model reads as its own prompt, and a
// legal-looking word the tool always refuses is pure noise there (measured:
// 13 calls in one settlement run alone). A caller still sending one now gets
// zod's generic enum error; `mcp/remember.ts`'s own
// `RETIRED_REMEMBER_VERB_REPLACEMENT` still names a replacement for a caller
// that reaches `rememberTool()` without this schema in front of it (a
// bypassing direct call, never a real schema-validated one). `topic` below
// keeps the OLD pattern (declared, refused by name) because it retired a
// PARAMETER, not an enum member — out of this ticket's scope.
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
      "delete",
      "clear",
      "merge",
    ])
    .describe(
      'create: mint a container — the TIER is chosen by `id`. Omitted mints a new TASK; an "E<n>/#<tag>" address mints a LANE inside that task, reported with how many existing turns already carry the word and therefore become its members — a lane name carrying a PHASE word (research/design/implement/fix/review/verification and their families) is refused naming the word, because a lane is one line traced across its phases and such a name goes false the moment the line moves on. Only after the user agreed to open one (ask with AskUserQuestion when nothing on the roster fits); never silently — the same precondition, one tier down. attach: bind the current session to one (`id="E<n>"`) and get its card back; called with NO id it returns the pick list of live tasks instead, so a caller that does not know which task to name can ask. detach: cancel this session\'s binding to one task (`id`), or to every task when called with no id. write: replace one field\'s value whole (`value`; null or "" clears it). edit: find `oldString` in one field and swap in `newString`. close: toggle the task off the roster (or, called again, back on). retag: rename a container, same TIER routing as create — a plain `id` NAMES the task (`tag`, one globally unique word, or null to clear it; a turn belongs by carrying that tag, so there is no assignment verb), an "E<n>/#<tag>" `id` instead renames that LANE to `tag` (required — a lane\'s tag is its identity, no null form). delete: remove an EMPTY container, same TIER routing — a task (`id="E<n>"`) with no member and no declared lane, or a lane (`id="E<n>/#<tag>"`) with no member turn still carrying it; refuses otherwise, naming the count, no `force`. clear: UN-HOME a container without deleting it, same TIER routing — a lane (`id="E<n>/#<tag>"`) drops its tag off every member turn and deletes every edge row resolved to it (never reverted to unsettled, which would only queue an already-voided decision back to settlement); a task (`id="E<n>"`) refuses while it still declares any lane, naming them, and otherwise drops its own tag off every member. Deleting a CROSS-LANE or HALF-SETTLED edge needs `force`; without it the call refuses and prints the full list either way — `force` only means "proceed despite the warning", never "I have read this list". `delete` becomes possible once `clear` has emptied the container. merge: fold one container into another that survives — TWO tiers, disambiguated by whether `tag` is present. WITH `tag`: fold a LANE (`id` = the task housing both, `tag` = the lane that goes away, `into` = the surviving lane) — the members\' tags, the edges\' sides and the registry row all move in ONE transaction, which is what `delete` cannot do for a lane that was ever used. WITHOUT `tag`: fold a TASK (`id` = the task that goes away, `into` = the surviving task\'s "E<n>" address) — its members (by ownership), its declared lanes and its four editable fields (row-lists appended and deduplicated, insight appended with a blank line, `title` staying `into`\'s) all move to the survivor, and the two task-tier impressions fold into one, then it leaves the roster; a same-name lane collision between the two refuses, naming every one, unless `force` is sent — the two same-named lanes then fold into one, exactly as if they had always been the same lane. Either tier reports what it touched.',
    ),
  id: z
    .string()
    .min(1)
    .optional()
    .describe(
      'write/edit/close/retag/delete/clear/merge (required): the target — an "E<n>" task address, or (create/retag/delete/clear) an "E<n>/#<tag>" lane address. On create it is the TIER SWITCH and is optional: omitted mints a new TASK, an "E<n>/#<tag>" address mints a LANE inside that task. merge reads it two ways depending on `tag`: WITH `tag`, the task housing both lanes; WITHOUT `tag`, the task that goes away (never a lane address on that tier). OPTIONAL on attach (omit it for the pick list) and on detach (omit it to cancel every binding).',
    ),
  title: z
    .string()
    .min(1)
    .optional()
    .describe(
      // ticket 07 (rubric-v10) split this describe's old claim in two: type
      // stays derived (never a caller input, absent from this shape), tags
      // no longer is — see the `tags` field just below for its own contract.
      "create only (required): the task's title, written in English — set once, here. " +
        "A task's type is never written by hand: it is DERIVED from its member turns " +
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
      "Retired — the topic registry folded into the task's ONE tag (`retag` names it, and a turn joins the task by carrying that word in its own `note` tags). There is no free-form theme tag to replace it with: a turn's `tags` draw from two closed vocabularies only — its task's tag and lanes DECLARED in that task — and the write gate refuses anything else.",
    ),
  goal: z
    .string()
    .min(1)
    .optional()
    .describe("create only, optional: a seed row for the new task's `goal` field."),
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
      "Retired — a task has ONE tag now, globally unique; pass it as `tag`.",
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
        "reference: durable pointers — source locations, specs, PRs, URLs; not plans. " +
        "Summary, what an outsider browsing the task reads — " +
        "insight: reusable experience this task has settled. " +
        // Lane-impressions ticket 05 (user ruling S15069/T2320): the enum is
        // FOUR fields. `decisions`/`done`/`next_steps` left the product and
        // `content` became settlement's, so the fields a caller might still
        // reach for are named here once — pointing at where that judgment
        // actually lives now, rather than at a word the enum refuses.
        "There is no decisions, done, next_steps or content field: what this task has settled, " +
        "finished and still owes is a settlement-maintained IMPRESSION — read a lane's at " +
        'recall(id="E<n>/#<tag>") and the task\'s in the card\'s own impression row. Those are ' +
        "never yours to write; goal/constraints/reference/insight are.",
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
      "Retired with the `assign` verb — a turn's task is derived from its own `note` tags.",
    ),
  // Ticket 14 (lane-model-v12 spec D3e): ONE parameter for both vocabularies,
  // because both are single tags answering to the same canonical predicate —
  // the segment's own name (create/retag) and a lane's (create/retag/merge).
  // What separates them is WHICH VERB (and, for retag, which TIER of `id`) is
  // speaking, not the shape of the value.
  tag: z
    .string()
    .nullable()
    .optional()
    .describe(
      "create (optional) / retag (required) when `id` is a plain task address: the task's ONE globally unique tag — the word a turn carries in its own `note` tags to belong here; null on retag clears it, and an unnamed task takes no members. retag (required) when `id` is an \"E<n>/#<tag>\" lane address: the lane's NEW name — `id` names the lane being renamed, `tag` is what it becomes; no null form, a lane's tag is its identity. merge, LANE tier (required): one LANE tag, unique within this task — the lane FOLDED AWAY, never the survivor; PRESENCE of this field is also what selects the lane tier over the task tier (omit it, or send null, for a task merge). Not used by delete, whose whole target is `id`. Either way CANONICAL form only — NFC-normalized, lowercase, non-empty, and drawn entirely from a-z, 0-9, and \"-\" (never leading or trailing) — no whitespace, no \":\" namespace prefix (that namespace is the hooks'), and none of \",\" \"/\" \"#\" \"*\" \".\" either. A non-canonical value rejects naming the exact problem rather than being silently normalized, so \"write-gate\" / \"Write-Gate\" / \" write-gate \" can never become three lanes.",
    ),
  /**
   * merge only ([S15069/T1697]; container-unification ticket 08 added the
   * task tier): the SURVIVOR. Separate from `tag` rather than a two-element
   * array, so neither side can be read off position — a merge is irreversible
   * and the two words/addresses are interchangeable in shape.
   */
  into: z
    .string()
    .optional()
    .describe(
      'merge, LANE tier (required, when `tag` is present): the lane that SURVIVES — `tag` names the one folded into it. Same canonical form as `tag`, and it must already be declared in this task; merge never mints the survivor. merge, TASK tier (required, when `tag` is absent): the surviving task\'s "E<n>" address — `id` names the one that goes away; its members (by ownership) and its declared lanes move here, then it leaves the roster.',
    ),
  /**
   * The one force switch on this tool, shared by two refusals that both
   * warn rather than block outright (`clear`'s lane tier, container-
   * unification ticket 07 spec D8; `merge`'s task tier, ticket 10 spec D8).
   * Deliberately weak — "proceed despite the warning", never "I have
   * already read the list" (a boolean cannot carry that claim, so the
   * refusal prints the full list whether or not `force` was sent — the
   * first call can pass `force: true` and the list will still never have
   * rendered).
   */
  force: z
    .boolean()
    .optional()
    .describe(
      'clear (lane tier only), optional, default false: proceed even though clearing this lane would delete a CROSS-LANE or HALF-SETTLED edge row. merge (task tier only), optional, default false: proceed even though `id` and `into` both declare a lane with the same name — the two rows fold into one, exactly as if they had always been the same lane. Either way, the refusal without `force` still prints the full list of what would be affected — that list is its own product, not something `force` claims you have read.',
    ),
};

export const timelineInputShape = {
  id: z.string().min(1),
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().max(MAX_PAGE_SIZE).optional(),
  // Ticket 05: the view's token budget — the milestone view's size governor
  // and the turn view's pagination budget. Mirrors recall's field; interactive
  // default 1000 lives in timeline.ts, injections pass their own explicitly.
  // TICKET 19, finding 6: `.max(MAX_PAGE_BUDGET)` — the SAME ceiling
  // `recall`'s own `pageBudget` carries above, shared through the one
  // constant. Its absence here was an oversight, not a design: the two knobs
  // are documented as one name with one meaning, the console route already
  // enforces this exact number on the timeline path by hand, and an
  // unbounded public timeline budget is the same "one tool result swallows
  // the window" failure the cap was introduced for. Refused, never clamped,
  // matching every other bound on this surface.
  pageBudget: z
    .number()
    .int()
    .positive()
    .max(MAX_PAGE_BUDGET)
    .optional()
    .describe(
      "Token ceiling per page, recall's own name and meaning (default 1000). Governs the standalone `E<n>` route's turns-view pagination, the `E<n>/L*` lane list's own pagination (previously unbounded — it rendered every declared lane in one call), the `S<n>` milestones view's era TASK SPINE (the chapter list itself), AND — page-budget-is-the-seat-count spec — every milestones view's own row admission, on both the `E<n>` route and the `S<n>` era spine's nested per-chapter rows: election ranks every candidate, this budget is the seat count deciding how many actually render. `pageSize` has no effect on any milestones view any more.",
    ),
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
      "Two closed vocabularies, nothing else: the ONE tag of the task this turn belongs to, and lane tags DECLARED in that task. Writing this field is how a turn's task changes — membership is derived from it, there is no assignment verb — so a whole-set replacement that drops the task tag makes the turn unowned. Anything else rejects, listing what is legal there; a second task tag rejects naming both; a lane tag without its own task's tag rejects naming the one that is missing. When neither tier fits — no task tag, no declared lane — leave the field empty; that is the ordinary outcome, not a failure. You are headless and cannot ask anyone, so never open a task or mint a lane merely to give a turn a home: remember(create) at its lane tier is for a lane your own finalization pass judged into existence on the content's evidence, and opening a container because nothing fit is the main agent's act, in front of the user.",
    ),
  // RESTORED (main-agent-edge-capability ticket 01, ruling [S15069/T1651]):
  // BORROWED from `noteInputShape` by object IDENTITY again — the same
  // pattern `mode`/`type`/`insight` above already use — rather than declared
  // fresh here. lane-model-v12 ticket 08 had inverted this for one release
  // (declared here, main agent had none); this ticket restores the original
  // direction: `note` owns the seven relation fields and their seven
  // `retract…` mirrors, settlement reuses them, so a contract change to one
  // word reaches both writers from a single edit and the two vocabularies
  // cannot drift apart. See `noteInputShape`'s own field block for the full
  // restoration note.
  correct: noteInputShape.correct,
  verify: noteInputShape.verify,
  use: noteInputShape.use,
  retractCorrect: noteInputShape.retractCorrect,
  retractVerify: noteInputShape.retractVerify,
  retractUse: noteInputShape.retractUse,
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
// Ticket 05 (spec D4), settlement-ergonomics ticket 01 (spec D1): walks
// `mode`'s per-field entries — `mode` carries one independent value per field
// rather than one scalar, so unlike `truncate`/`view` above this can't be a
// single top-level presence check. Only one thing is flagged now: the edit
// form landing on a set field (type/tags), which `parseModeMap` (mcp/note.ts)
// also refuses at the runtime layer — this is the belt-and-braces copy for a
// call that goes through the real MCP validation path (`server.ts` hands
// this schema straight to the SDK, which parses every call against it before
// `noteTool()` ever runs). The retired-literal branch this loop used to carry
// is gone — see the comment left in its place, right above `noteModeShape`'s
// `NOTE_SET_MODE_FIELDS` — `fieldModeValueShape`'s union rejects
// "overwrite"/"append" before this superRefine ever sees them.
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
// already set (see that schema's own superRefine). `topic` retired a
// PARAMETER, so it keeps this treatment.
//
// settlement-ergonomics ticket 01 (spec D1): `append`/`replace`/`assign` no
// longer get this treatment — they left `rememberInputShape.verb`'s enum
// outright (see that field's own comment), so the branch that used to name
// their replacement here (`RETIRED_REMEMBER_VERB_MESSAGE`) is gone too: a
// verb of "append" now fails the enum's own base-shape parse before this
// superRefine ever runs, the same reasoning `noteInputSchema`'s superRefine
// above lost its retired-literal branch to.
export const rememberInputSchema = z
  .object(rememberInputShape)
  .strict()
  .superRefine((data, ctx) => {
    if (data.tags !== undefined) {
      ctx.addIssue({
        code: "custom",
        message:
          "`tags` has retired on this tool — a task has ONE globally unique tag now; pass it as `tag`.",
        path: ["tags"],
      });
    }
    if (data.turns !== undefined) {
      ctx.addIssue({
        code: "custom",
        message:
          "`turns` has retired with the `assign` verb — a turn's task is derived from its own `note` tags.",
        path: ["turns"],
      });
    }
    if (data.topic !== undefined) {
      ctx.addIssue({
        code: "custom",
        message:
          "`topic` has retired — the topic registry folded into the task's ONE tag (`remember(retag)` names it). A turn joins the task by carrying that word in its own `note` tags; no other word is legal there except a lane this task has declared.",
        // The retired `topic` parameter's own refusal path.
        path: ["topic"],
      });
    }
  });

