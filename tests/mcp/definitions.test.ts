import { describe, expect, it } from "bun:test";

import {
  MNEMO_TOOL_DESCRIPTIONS,
  timelineInputSchema,
  recallInputSchema,
  recallInputShape,
  noteInputSchema,
  noteInputShape,
  rememberInputSchema,
  rememberInputShape,
  settlementNoteInputShape,
  workerRecallInputShape,
  MAX_PAGE_BUDGET,
  MAX_PAGE_SIZE,
  MAX_TURN_BUDGET,
} from "../../src/mcp/definitions";
import { WORKER_TOOL_RESULT_MAX_CHARS } from "../../src/mcp/handlers";
import { CITATION_RELATIONS, RETRACTION_ONLY_RELATIONS } from "../../src/db/citations";
import { RELATION_CLASSES } from "../../src/shared/relation-class";
import { RELATION_FIELD_ENTRIES, RETRACTION_FIELD_ENTRIES } from "../../src/db/citations";
import { EDGE_RELATIONS } from "../../src/shared/turn-phase";
import { REMEMBER_VERBS } from "../../src/mcp/remember";
import { estimateTokens } from "../../src/utils/token-estimate";
import { z } from "zod";

/** Spelled-out counts, so the description's own count word is checkable. */
const VERB_COUNT_WORDS: Record<number, string> = {
  8: "Eight",
  9: "Nine",
  10: "Ten",
  11: "Eleven",
  12: "Twelve",
};

describe("public size ceilings (peer round three finding 03)", () => {
  // Every one of these was `.positive()` and nothing else, so a caller could
  // ask for a million turns in one page. A worker audience then truncated at
  // WORKER_TOOL_RESULT_MAX_CHARS instead of paginating; an audience without
  // that envelope exceeded the host limit outright.
  it("refuses a pageSize, pageBudget or turn past the ceiling — refusal, never a silent clamp", () => {
    expect(recallInputSchema.safeParse({ pageSize: MAX_PAGE_SIZE }).success).toBe(true);
    expect(recallInputSchema.safeParse({ pageSize: MAX_PAGE_SIZE + 1 }).success).toBe(false);

    expect(recallInputSchema.safeParse({ pageBudget: MAX_PAGE_BUDGET }).success).toBe(true);
    expect(recallInputSchema.safeParse({ pageBudget: MAX_PAGE_BUDGET + 1 }).success).toBe(false);
    expect(recallInputSchema.safeParse({ pageBudget: 1_000_000 }).success).toBe(false);

    expect(recallInputSchema.safeParse({ turn: MAX_TURN_BUDGET }).success).toBe(true);
    expect(recallInputSchema.safeParse({ turn: MAX_TURN_BUDGET + 1 }).success).toBe(false);
  });

  it("keeps the ceilings tied to the transport cap, not to taste", () => {
    // ~4 characters per token on this all-ASCII render.
    expect(MAX_PAGE_BUDGET * 4).toBeLessThanOrEqual(WORKER_TOOL_RESULT_MAX_CHARS);
    expect(MAX_TURN_BUDGET).toBeLessThan(MAX_PAGE_BUDGET);
  });

  it("applies the same ceiling to the timeline selector", () => {
    expect(timelineInputSchema.safeParse({ id: "S1", pageSize: MAX_PAGE_SIZE + 1 }).success).toBe(
      false,
    );
  });

  // TICKET 19, finding 6. The two `pageBudget` knobs are documented as one
  // name with one meaning ("recall's own name and meaning"), and the console
  // route already enforced this exact number on the timeline path by hand —
  // but the PUBLIC timeline schema was `.positive()` with no ceiling, so the
  // parity claim was false at the one place a caller could exploit it. Made
  // true by sharing the constant, not retracted.
  //
  // MUTATION NOTE: drop `.max(MAX_PAGE_BUDGET)` from `timelineInputShape`'s
  // `pageBudget` and the two rejecting assertions go red.
  it("applies the SHARED pageBudget ceiling to the timeline selector too", () => {
    expect(
      timelineInputSchema.safeParse({ id: "S1", pageBudget: MAX_PAGE_BUDGET }).success,
    ).toBe(true);
    expect(
      timelineInputSchema.safeParse({ id: "S1", pageBudget: MAX_PAGE_BUDGET + 1 }).success,
    ).toBe(false);
    expect(
      timelineInputSchema.safeParse({ id: "S1", pageBudget: 1_000_000 }).success,
    ).toBe(false);
  });
});

describe("recallInputSchema", () => {
  it("accepts page + pageSize and rejects limit + both retired depth-switch spellings (`depth` and `view`, ticket 11)", () => {
    const ok = recallInputSchema.parse({
      id: "S1",
      filter: { fields: ["title", "content"] },
      page: 2,
      pageSize: 10,
    });

    expect(ok).toEqual({
      id: "S1",
      filter: { fields: ["title", "content"] },
      page: 2,
      pageSize: 10,
    });

    expect(() =>
      recallInputSchema.parse({ id: "S1", limit: 10 }),
    ).toThrow();
    expect(() =>
      recallInputSchema.parse({ id: "S1", view: "full" }),
    ).toThrow();
    // The implementer's old name is gone, not aliased — `.strict()` rejects it.
    expect(() =>
      recallInputSchema.parse({ id: "S1", depth: "expanded" }),
    ).toThrow();
    // Ticket 11: `view` (the collapsed/expanded depth switch) retires too —
    // rejected with a message naming its replacement (`filter.fields`).
    expect(() =>
      recallInputSchema.parse({ id: "S1", view: "expanded" }),
    ).toThrow();
  });

  // Ticket 04 (spec "Tools"): `truncate` retires from the public surface —
  // a parse error whose message names its replacements, not merely a
  // `.strict()` "unrecognized key". Checked at the same seam the MCP SDK
  // validates a real call against (`normalizeObjectSchema` +
  // `safeParseAsync`, confirmed to still apply this schema's `superRefine`).
  it("truncate is a parse error naming pageBudget and turn as replacements", () => {
    const result = recallInputSchema.safeParse({ id: "S1", truncate: 500 });
    expect(result.success).toBe(false);
    const message = result.success ? "" : result.error.issues.map((i) => i.message).join(" ");
    expect(message).toContain("pageBudget");
    expect(message).toContain("turn");

    // Any value — not just an out-of-range one — is rejected; the field
    // exists only to carry this message, not to still accept some inputs.
    expect(recallInputSchema.safeParse({ id: "S1", truncate: 1 }).success).toBe(false);
    expect(recallInputSchema.safeParse({ id: "S1" }).success).toBe(true);
  });

  // Ticket 04: the shared `filter` object — AND-composed members, `.strict()`
  // against the retired `project` member and any other unrecognised key.
  it("accepts the shared filter object and rejects an unrecognised filter key", () => {
    expect(
      recallInputSchema.parse({
        id: "S1",
        filter: { type: "decision", tag: "auth", session: "S12", time: "-7d", file: "src/" },
      }),
    ).toEqual({
      id: "S1",
      filter: { type: "decision", tag: "auth", session: "S12", time: "-7d", file: "src/" },
    });
    expect(recallInputSchema.parse({ id: "S1", filter: { session: 12 } }).filter).toEqual({
      session: 12,
    });
    expect(() =>
      recallInputSchema.parse({ id: "S1", filter: { project: "claude-mnemo" } }),
    ).toThrow();
  });
});

describe("workerRecallInputShape", () => {
  // Ticket 11: the worker-only `truncate` exemption retired along with the
  // char-cap mechanism it fed — `workerRecallInputShape` is now IDENTICAL to
  // the public shape (see its own comment in definitions.ts). This raw
  // `z.object(...)` (built directly, bypassing `recallInputSchema`'s own
  // rejecting `superRefine`) still parses a stray `truncate` as an ordinary,
  // now-INERT optional number — `recallMemory` no longer reads it — rather
  // than a still-meaningful above-cap exemption.
  it("still parses a stray `truncate` key, now inert (RecallInput no longer reads it)", () => {
    expect(z.object(workerRecallInputShape).strict().parse({ truncate: 5000 })).toEqual({ truncate: 5000 });
  });
});

// Ticket 11 (per-field recall budgets, USER RULING S15069/T2106): the
// `filter.fieldBudgets` schema addition — field names validate against the
// SAME `RECALL_TURN_FIELD_NAMES` enum `filter.fields` uses, each value is a
// positive integer capped at `MAX_TURN_BUDGET` (the same public ceiling
// `turn` itself carries), and BOTH the public (`recallInputSchema`) and
// worker (`workerRecallInputShape`) surfaces advertise it since both spread
// the same `memoryFilterShape`.
describe("filter.fieldBudgets schema (ticket 11)", () => {
  it("accepts a per-field token budget keyed by a valid filter.fields name", () => {
    expect(
      recallInputSchema.safeParse({ filter: { fieldBudgets: { prompt: 50 } } }).success,
    ).toBe(true);
  });

  it("rejects an unrecognized field name, naming the problem", () => {
    const result = recallInputSchema.safeParse({
      filter: { fieldBudgets: { bogus: 50 } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-positive or non-integer budget", () => {
    expect(
      recallInputSchema.safeParse({ filter: { fieldBudgets: { prompt: 0 } } }).success,
    ).toBe(false);
    expect(
      recallInputSchema.safeParse({ filter: { fieldBudgets: { prompt: -5 } } }).success,
    ).toBe(false);
    expect(
      recallInputSchema.safeParse({ filter: { fieldBudgets: { prompt: 1.5 } } }).success,
    ).toBe(false);
  });

  // MUTATION NOTE: drop `.max(MAX_TURN_BUDGET)` from `fieldBudgets`'s value
  // schema in `memoryFilterShape` (definitions.ts) and this goes red.
  it("caps a field's own budget at the SAME ceiling `turn` itself carries", () => {
    expect(
      recallInputSchema.safeParse({ filter: { fieldBudgets: { prompt: MAX_TURN_BUDGET } } })
        .success,
    ).toBe(true);
    expect(
      recallInputSchema.safeParse({
        filter: { fieldBudgets: { prompt: MAX_TURN_BUDGET + 1 } },
      }).success,
    ).toBe(false);
  });

  it("empty fieldBudgets is legal (a caller narrowing nothing)", () => {
    expect(recallInputSchema.safeParse({ filter: { fieldBudgets: {} } }).success).toBe(true);
  });

  // Ticket 13 (implementation-review P2 sweep, item 3): `files`/`observations`
  // are valid `filter.fields` names but NEVER read a `fieldBudgets` entry —
  // `files` renders as a whole tree (`renderFileTree`), `observations` as
  // nested child turns — so admitting the key at the schema layer was a
  // silent no-op the peer review flagged. `title` is the one field that
  // stays admitted, because its own no-op is a reviewed, documented
  // guarantee (`capRenderToTokenBudget` never drops line 0) rather than an
  // unread key.
  describe("fieldBudgets rejects the no-op keys (ticket 13, P2 sweep item 3)", () => {
    it("rejects files — its renderer never reads a per-field budget", () => {
      expect(
        recallInputSchema.safeParse({ filter: { fieldBudgets: { files: 50 } } }).success,
      ).toBe(false);
    });

    it("rejects observations — its renderer never reads a per-field budget", () => {
      expect(
        recallInputSchema.safeParse({ filter: { fieldBudgets: { observations: 50 } } }).success,
      ).toBe(false);
    });

    it("still accepts title — the one documented structural no-op", () => {
      expect(
        recallInputSchema.safeParse({ filter: { fieldBudgets: { title: 50 } } }).success,
      ).toBe(true);
    });

    // `files`/`observations` stay legal `filter.fields` selections — only
    // `fieldBudgets` narrows past them.
    it("files/observations stay legal filter.fields entries even though fieldBudgets refuses them", () => {
      expect(
        recallInputSchema.safeParse({ filter: { fields: ["files", "observations"] } }).success,
      ).toBe(true);
    });
  });

  it("both the public and worker surfaces advertise fieldBudgets — one shared filter shape", () => {
    expect(
      z.object(workerRecallInputShape).strict().safeParse({
        filter: { fieldBudgets: { content: 100 } },
      }).success,
    ).toBe(true);
  });
});

describe("tool surface", () => {
  // `timeline` joined the worker allowlist for settlement (spec §A): a settle
  // re-grades a trailing window against the arc it belongs to, and that arc is
  // a timeline call. Still read-only — no new write surface.
  it("keeps the worker allowlist at the three read/write tools and exposes timeline descriptions", () => {
    // `note` is deliberately absent: it is the MAIN agent's own write channel
    // (spec D1). Handing it to the extraction worker would let the pipeline
    // write the notes the P1 trial exists to compare it against. `remember`
    // (ticket 02, ADR-0001/0002) is the segment write surface the name
    // returned FOR, once ticket 03 (spec E1, 0.11.x) had merged it into
    // `note` and freed it — same reasoning: main-agent-only, absent from the
    // worker allowlist. `check` retired outright (ticket 07, ADR-0007): the
    // Stop hook and the completion gate already call the coverage predicate
    // directly, and the main agent's own self-service pull added nothing a
    // reader could not already get another way.
    expect(Object.keys(MNEMO_TOOL_DESCRIPTIONS).sort()).toEqual([
      "note",
      "recall",
      "remember",
      "timeline",
    ]);
    expect(MNEMO_TOOL_DESCRIPTIONS.timeline).toContain("page/pageSize");
    expect(MNEMO_TOOL_DESCRIPTIONS.timeline).toContain("view");
    expect(MNEMO_TOOL_DESCRIPTIONS.timeline).not.toContain("hard cap");
    expect(MNEMO_TOOL_DESCRIPTIONS.timeline).not.toContain("Optional `milestones`");
    expect(MNEMO_TOOL_DESCRIPTIONS.timeline).not.toContain("set false");
  });

  // ticket 14 (spec K1/K4): the segment selector already worked mechanically
  // (recall.ts's `E<n>` route, search.ts's segment layer); this pins that the
  // model-facing description actually SAYS so, and states the open/delivered
  // distinction K4 requires a reader be able to tell apart on sight.
  it("the recall description tells the caller a segment is queryable and distinguishes open from delivered", () => {
    const recall = MNEMO_TOOL_DESCRIPTIONS.recall;
    expect(recall).toContain('id="E<n>"');
    expect(recall).toContain("task");
    expect(recall).toContain("[open]");
    expect(recall).toContain("[delivered]");
    expect(recall).toContain("query=");
  });

  // Container-unification ticket 03 (spec D2): `E<n>/#<tag>` is the
  // CANONICAL, pasteable lane address; `timeline`'s `E<n>/L<n>` is a
  // render-position ordinal for interactive picking only. Both teaching
  // surfaces have to say which is which, or a reader who only ever sees one
  // of the two tool descriptions never learns not to paste the ordinal.
  it("the recall description teaches E<n>/#<tag> as the canonical lane address", () => {
    const recall = MNEMO_TOOL_DESCRIPTIONS.recall;
    expect(recall).toContain('id="E<n>/#<tag>"');
    expect(recall).toContain("CANONICAL");
    expect(recall).toContain("E<n>/L<n>");
    expect(recallInputShape.id.description).toContain("E31/#tag");
  });

  it("the timeline description names E<n>/L<n> a render-position ordinal, never a pasteable address, and points at the canonical form", () => {
    const timeline = MNEMO_TOOL_DESCRIPTIONS.timeline;
    expect(timeline).toContain("E<n>/L<n>");
    expect(timeline).toContain("RENDER-POSITION ordinal");
    expect(timeline).toContain("never a pasteable address");
    expect(timeline).toContain('id="E<n>/#<tag>"');
  });

  // Ticket 16 (user findings S15069/T2031): `timeline` now accepts
  // `E<n>/#<tag>` directly (it used to error, sending the reader to `recall`
  // for the canonical form even though `timeline` renders lanes itself) — the
  // description has to say so, and lead with it, rather than teach the
  // ordinal `L`-form first and mention the canonical name only as a pointer
  // at a different tool.
  it("the timeline description teaches E<n>/#<tag> as ITS OWN canonical lane address, taught before the L-ordinal form", () => {
    const timeline = MNEMO_TOOL_DESCRIPTIONS.timeline;
    expect(timeline).toContain("CANONICAL");
    const tagIndex = timeline.indexOf('id="E<n>/#<tag>"');
    const listIndex = timeline.indexOf('id="E<n>/L*"');
    expect(tagIndex).toBeGreaterThan(-1);
    expect(listIndex).toBeGreaterThan(-1);
    expect(tagIndex).toBeLessThan(listIndex);
  });

  // Ticket 16 decision 4 (repairing a GPT peer review's P1 finding): both
  // descriptions used to teach RETIRED syntax — flat `→`/`←` one-hop
  // relation lines, the `=>`-means-indexes glyph, "newest-first" lane
  // lists, and a hop-qualification rule relative to the PREVIOUS token
  // rather than the ROOT — an agent following the published contract would
  // mis-resolve a real tree. Both now teach the shipped fork-tree shape and
  // the node selector.
  it("the timeline description teaches the fork tree's root-relative hop rule and neither teaches retired syntax", () => {
    const rootRelativeSentence =
      "a bare `T<m>` anywhere on the tree means the root's session, never the previous hop's";
    for (const description of [MNEMO_TOOL_DESCRIPTIONS.recall, MNEMO_TOOL_DESCRIPTIONS.timeline]) {
      expect(description).not.toContain("newest-first");
      expect(description).not.toContain("an edge into an indexed node");
      expect(description).not.toMatch(/`→ <word>|`← <word>/);
    }
    // Settlement-read-once spec D8: the tree kept exactly one surface, and
    // the root-relative hop rule is a fact about that surface alone.
    expect(MNEMO_TOOL_DESCRIPTIONS.timeline).toContain(rootRelativeSentence);
    expect(MNEMO_TOOL_DESCRIPTIONS.timeline).toContain('timeline(id=\"S<n>/T<m>\")');
    expect(MNEMO_TOOL_DESCRIPTIONS.recall).not.toContain(rootRelativeSentence);
  });

  // Settlement-read-once spec D8 (user rulings T2388/T2404): `recall`'s
  // `relations` field renders the node's DIRECT edge set, and the tool
  // description is the only place a caller learns what the field's lines
  // mean before it reads one. Every clause pinned here is a clause the
  // renderer actually produces — the pairing the ticket's teaching box asks
  // for, and the failure this replaces was exactly a description that still
  // taught a shape the code had stopped emitting.
  it("the recall description teaches the direct edge set and no longer teaches the tree", () => {
    const recall = MNEMO_TOOL_DESCRIPTIONS.recall;
    expect(recall).toContain("THIS turn's own direct edges");
    expect(recall).toContain("`<words> -> <addr>`");
    expect(recall).toContain("`<- <addr> <words>`");
    expect(recall).toContain("No downstream hops, no branch cap, no `+N more`");
    expect(recall).toContain("`[unplaced]` when neither did");
    expect(recall).toContain("one pair placed two ways is two lines");
    expect(recall).toContain("ONE legend line for the whole response");
    // The tree's own notation, retired from this surface entirely.
    expect(recall).not.toContain("`^`");
    expect(recall).not.toContain("-word->");
    expect(recall).not.toContain("`… +N more`");
    expect(recall).not.toContain("└");
    // ...and the reader is told where the tree DID go, so the capability is
    // not silently lost along with the notation.
    expect(recall).toContain('timeline(id=\"S<n>/T<m>\")');
  });

  // Settlement-read-once spec D8's outer assembly: the grouped comma list is
  // a contract a caller plans around (how many headers, how a repeat reads),
  // so it is taught rather than merely implemented.
  it("the recall description teaches that a turn-address list is one grouped page", () => {
    const recall = MNEMO_TOOL_DESCRIPTIONS.recall;
    expect(recall).toContain("is assembled as ONE page rather than several stapled together");
    expect(recall).toContain("under one header per session");
    expect(recall).toContain("an address named twice is read once");
  });

  // ticket 01 (spec "Note contract revision"): the field-level contract used
  // to live entirely inside this one string. It now lives in each
  // parameter's own zod `.describe()` (tested below); this text keeps only
  // what governs the CALL as a whole. Both halves are tested here because
  // acceptance criterion 1 is about the pair together: the tool description
  // carries no per-field contract text, AND every parameter carries its own.
  it("the note description carries only call-level rules — addressing, timing, skip, citation, relations, markup, the English line", () => {
    const note = MNEMO_TOOL_DESCRIPTIONS.note;
    // The address norm — the one thing the injected formats cannot teach on
    // sight (the formats themselves are undocumented by design: they explain
    // themselves when they appear). Lane-model-v12 ticket 12 moved the retired
    // `<mnemo-note-taking>` block's own sentence here, so this surface now
    // carries the norm in full rather than as a parenthetical; the `turn`
    // describe no longer restates it (see tests/shared/memory-rubric.test.ts's
    // three-way routing guard).
    expect(note).toContain('the injected "mnemo current turn" line');
    expect(note).toContain(
      "the ONLY sources of a note address — never recall one from memory, never invent one",
    );
    // Timing (ticket 03, note-cadence-backlog): rule 1 unchanged (S15069
    // T781); rule 2 rewritten from "owed addresses settle in this turn's
    // FIRST tool batch" (0.11.1's contradiction with the SessionStart block)
    // to the backlog-relief trigger — the owed suffix that rule used to name
    // no longer exists (see hooks/note-reminder.ts).
    expect(note).toContain("note only FINISHED turns");
    expect(note).toContain("never the one in progress");
    expect(note).toContain("backlog relief appears");
    expect(note).toContain("never just to write one turn's note early");
    expect(note).not.toContain("FIRST tool batch");
    expect(note).not.toContain("Goes last in its batch");
    expect(note).not.toContain("its owed suffix");
    // The skip test: single criterion, its deletion-test check, the
    // no-invention red line, the user-decision hard line (S15069 T577–T581).
    expect(note).toContain("a future retriever would find nothing unique");
    expect(note).toContain(
      "deleting it costs no decision, progress, or coherence",
    );
    expect(note).toContain("never invented");
    expect(note).toContain("Never skip a user decision, correction, veto");
    // The citation norm: injected ids only, never private content. Ticket 11
    // (staged-settlement spec, USER RULING S15069/T2016): taught bare, no
    // brackets, for token economy.
    expect(note).toContain("S15069/T332");
    expect(note).toContain("ids seen in injected context");
    expect(note).toContain("never include <private> content");
    // spec E2: tool-call syntax is rejected, not silently stored.
    expect(note).toContain("Tool-call markup");
    // ticket 11 (edge-ownership-impl, "统一 Memory Rubric"): the six ordered
    // relation questions this text used to inline are JUDGMENT — they moved
    // to the Memory Rubric wholesale ([S15069/T933]/[T937]–[T939]). What
    // stays here is the call-level pointer plus the format facts a rubric
    // cannot state.
    // main-agent-edges ticket 05 (spec D3): edge writing is the MAIN AGENT'S
    // routine business again. The three sentences that sent a caller away
    // from the parameters — "settlement's whole business", "rarely need
    // them", and the hindsight framing — are asserted GONE, because a
    // description that keeps any of them cancels the rubric's new duty on the
    // one surface a caller reads at call time.
    expect(note).toContain("this turn's EDGES");
    expect(note).toContain("are ROUTINE here");
    expect(note).toContain(
      "name the earlier turns this turn used, corrected or verified",
    );
    expect(note).not.toContain("are settlement's whole business");
    expect(note).not.toContain("rarely need them");
    expect(note).not.toContain("hindsight");
    // The new division, on the surface the caller reads: settlement fills and
    // reviews, and declares only the ambiguous side.
    expect(note).toContain("Settlement no longer originates them");
    expect(note).toContain("fills what you missed and reviews");
    expect(note).not.toContain("sending one of those parameters is refused");
    expect(note.toLowerCase()).not.toContain("refused");
    // PROSE IS NOT THE GRAPH (ticket 03's expected delta: only the inline
    // `[T<dbid>]` grammar feeds `getEffectiveCitations`). The old hedge said
    // a prose address "states no relation", which a caller could still read as
    // a weak edge; the replacement says it is never read as one at all.
    expect(note).toContain("a pointer for a human reader");
    expect(note).toContain("NEVER read as an edge");
    expect(note).not.toContain("it states no relation");
    expect(note).not.toContain("REFERS to that one");
    expect(note).not.toContain("turn-only address lists");
    // ticket 02 (edge-mechanism-revision D1/D3): the C7 co-occurrence fact
    // this line used to state ("an uncited target rejects the call") is
    // retired along with the check — the description now teaches the
    // opposite, plus multi-relation and the retraction mirrors.
    expect(note).not.toContain("an uncited target rejects the call");
    expect(note).not.toContain("declared independently of the prose");
    expect(note).not.toContain("a relations-only call is valid");
    expect(note).not.toContain("A pair may hold several relations;");
    expect(note).not.toContain("retract<Relation>");
    expect(note.toLowerCase()).toContain("memory rubric");
    expect(note).not.toContain(
      "If the cited turn were wrong, would the citing turn's conclusion also be wrong?",
    );
    expect(note).not.toContain("Six ordered questions");
    expect(note).not.toContain("(6) None → no relation");
    expect(note).not.toContain('Never soften (5) to "used"/"built on"');
    // `supersedes` retired from the relation vocabulary outright (ticket 01)
    // — no trace of it belongs on the surface a writer reads.
    expect(note).not.toContain("supersedes");
    // Ticket 01's one line, verbatim (acceptance criterion 4).
    expect(note).toContain("Every field is written in English.");

    // Per-field contract text now lives ONLY in each parameter's own
    // `.describe()` — none of it may still appear on the tool description,
    // or the two homes have drifted back into one blob.
    expect(note).not.toContain("one English claim sentence");
    expect(note).not.toContain("Sentence deletion test");
    expect(note).not.toContain("episode-deletion test");
    expect(note).not.toContain("Closed vocabulary");
    expect(note).not.toContain("coarse noun naming the project");
    expect(note).not.toContain("mode.<field>");
    // The grade parameter left the tool (ADR-0003) — no trace of it belongs
    // on the surface a writer reads.
    expect(note.toLowerCase()).not.toContain("grade");
    // The retired session fields are gone from the tool description too.
    expect(note).not.toContain("decision/done/next_steps/reference");
    // Ticket 09 (edge-ownership-impl, "结算顺手维护 session 叙事"): `session`
    // retired from `note` outright — no address clause names it any more.
    expect(note).not.toContain("or `session`");
    expect(note).not.toContain("or a session's title");

    // The description sits in the cached prefix of every request, so the cap
    // is a real per-turn cost. Moving the field contracts into `.describe()`,
    // then the relation judgment into the Memory Rubric (ticket 11), shrank
    // this text well under its ticket-07-era cap — measured, not a round
    // figure.
    //
    // 420 → 450 (lane-model-v12 ticket 12). The retired `<mnemo-note-taking>`
    // SessionStart block's address norm descended here, costing ~25 tokens on
    // this string. That is a NET SAVING and not a concession: the block it came
    // from was ~110 tokens in a hook slot of its own, and this description was
    // already in the same cached prefix. The cap moves by the measured cost of
    // the descent, not to a comfortable round number.
    expect(estimateTokens(note)).toBeLessThanOrEqual(450);
  });

  // ticket 01 requirement: "The rendered tool schema carries a description on
  // every note parameter" — checked at the seam the MCP SDK itself reads
  // (server.ts's `registerTool` hands `noteInputSchema` straight to the
  // client), not merely on the raw zod shape.
  it("every note parameter carries a non-empty description on the rendered schema", () => {
    const rendered = z.toJSONSchema(noteInputSchema) as {
      properties: Record<string, { description?: string }>;
    };
    // Ticket 01: driven by `noteInputSchema.shape`, NOT the raw
    // `noteInputShape` object — the shape carries one key the schema itself
    // omits (`supersedes`, kept declared only as frozen documentation of a
    // retired word — ticket 08 dropped its last reuser, see its own doc
    // comment), so a caller-reachable-parameter test must walk what the
    // SCHEMA actually renders.
    const keys = Object.keys(noteInputSchema.shape);
    expect(keys.length).toBeGreaterThan(0);
    // Ticket 08 deleted `supersedes` from the shape itself along with every
    // relation field, so it is absent from BOTH now.
    expect(keys).not.toContain("supersedes");
    expect(Object.keys(noteInputShape)).not.toContain("supersedes");
    for (const key of keys) {
      const description = rendered.properties[key]?.description;
      expect(description, `${key} should carry a description`).toBeTruthy();
      expect(description!.length, `${key}'s description is too short`).toBeGreaterThan(10);
    }
  });

  // write-gate-hardening ticket 01: property ORDER is a contract, not a
  // formatting accident. Zod carries insertion order into the serialized JSON
  // schema, and that order is what the model reads when it writes the call —
  // the observed failure is a long value's CLOSING boundary drifting into a
  // tag named after the field, which glues every following parameter into that
  // field as literal text. So the longest field goes last (nothing after it to
  // drift into) and the next longest sits beside it. Checked on the SERIALIZED
  // schema, the artifact an MCP client actually receives, not on the raw shape.
  it("the note tool's serialized schema puts content last and insight second-to-last", () => {
    const rendered = z.toJSONSchema(noteInputSchema, { io: "input" }) as {
      properties: Record<string, unknown>;
    };
    const keys = Object.keys(rendered.properties);

    expect(keys.at(-1)).toBe("content");
    expect(keys.at(-2)).toBe("insight");
    // The structural short parameters lead, in the ruled order, then the
    // relation and retraction arrays — RESTORED (main-agent-edge-capability
    // ticket 01) to the slot between `mode` and the prose tail, exactly where
    // they sat before lane-model-v12 ticket 08 emptied it.
    expect(keys).toEqual([
      "turn",
      "title",
      "skip",
      "crossSession",
      "type",
      "tags",
      // staged-settlement ticket 01: the topic correction form.
      "retireTopic",
      "mode",
      // relation-vocabulary-v13 ticket 02: three CLASSES and three mirrors, in
      // the PRECEDENCE's own order (most specific first).
      "correct",
      "verify",
      "use",
      "retractCorrect",
      "retractVerify",
      "retractUse",
      "insight",
      "content",
    ]);
    for (const [relation] of RELATION_FIELD_ENTRIES) {
      expect(keys.indexOf(relation)).toBeGreaterThan(keys.indexOf("mode"));
      expect(keys.indexOf(relation)).toBeLessThan(keys.indexOf("insight"));
    }
    for (const [key] of RETRACTION_FIELD_ENTRIES) {
      expect(keys.indexOf(key)).toBeGreaterThan(keys.indexOf("mode"));
      expect(keys.indexOf(key)).toBeLessThan(keys.indexOf("insight"));
    }
  });

  // The settlement facade registers `settlementNoteInputShape` with the SDK
  // directly (worker/note-settlement-sdk-query.ts), so its own serialized
  // schema is a second surface the same order has to reach — one edit site,
  // two consumers.
  it("the settlement note shape's serialized schema puts content last and insight second-to-last too", () => {
    const rendered = z.toJSONSchema(z.object(settlementNoteInputShape).strict(), {
      io: "input",
    }) as { properties: Record<string, unknown> };
    const keys = Object.keys(rendered.properties);

    expect(keys.at(-1)).toBe("content");
    expect(keys.at(-2)).toBe("insight");
    expect(keys.slice(0, 3)).toEqual(["turn", "session", "title"]);
  });

  // ticket 01 requirement: "compose faithfully from the spec — these tests
  // are load-bearing". Each admission test's distinctive wording, pinned
  // verbatim on the field it governs.
  it("title/content/insight carry their admission tests verbatim on their own parameter", () => {
    const shape = noteInputSchema.shape;
    // Ticket 01 (field-semantics spec): title's contract flipped from "this
    // turn's conclusion" to the INDEX — the probe that forced the change was
    // a real title reading "one tool two shapes ruled" while the turn's
    // actual content held four rulings, because the old contract asked the
    // agent to compress to A conclusion rather than name what the turn was
    // doing.
    expect(shape.title.description).toContain("the INDEX, not the conclusion");
    expect(shape.title.description).toContain(
      "one English sentence saying what this turn is doing",
    );
    expect(shape.title.description).toContain(
      "standing alone in a title-only list",
    );
    expect(shape.title.description).toContain("No activity/topic prefix");
    expect(shape.title.description).toContain(
      "Name the decider when a ruling landed",
    );
    expect(shape.title.description).toContain(
      "No session-local codewords without a gloss",
    );

    // content's contract keeps its wording, reframed as the CONCLUSIONS
    // (plural, every useful decision) rather than "the conclusion" (singular)
    // — title stopped compressing to one, so content has to carry all of them.
    expect(shape.content.description).toContain("the CONCLUSIONS");
    expect(shape.content.description).toContain("assume the title was just read");
    expect(shape.content.description).toContain("expand, never restate");
    expect(shape.content.description).toContain(
      "Every useful decision this turn produced",
    );
    expect(shape.content.description).toContain(
      "each rejected alternative with a one-line reason",
    );
    expect(shape.content.description).toContain("Sentence deletion test");
    expect(shape.content.description).toContain(
      "No process narration (replay stores it)",
    );

    // Ticket 02 (field-semantics spec "02 — 长度随产出,结论先行"): title gets
    // only the length-tracks-output half (it has no tail to lead with —
    // it's one sentence, not the conclusion); content gets both halves,
    // since it is the field whose length actually varies and whose tail a
    // reader's budget can cut.
    expect(shape.title.description).toContain(
      "Length tracks this turn's output, not the effort spent.",
    );
    expect(shape.content.description).toContain(
      "Length tracks this turn's output, not the effort spent",
    );
    expect(shape.content.description).toContain(
      "long when the turn produced a lot, terse when it produced little",
    );
    expect(shape.content.description).toContain(
      "Lead with the conclusions",
    );
    expect(shape.content.description).toContain(
      "a reader's budget cuts the tail",
    );

    // insight now states its own contrast with title/content explicitly:
    // reusable experience, not a conclusion of this turn.
    expect(shape.insight.description).toContain(
      "REUSABLE experience, not a conclusion of this turn",
    );
    expect(shape.insight.description).toContain(
      "a task-scoped lesson under the episode-deletion test",
    );
    expect(shape.insight.description).toContain(
      "does the sentence still teach someone useful prior knowledge?",
    );

    expect(shape.type.description).toContain("Closed vocabulary");
    expect(shape.type.description).toContain(
      "a design discussion with no ruling is discuss, not design",
    );
    // Ticket 14 (lane-model-v12 spec D3b/D3e): `tags` is two closed
    // vocabularies, not a noun-picking style guide — the describe now names
    // where the words come from and what each of the three refusals says.
    expect(shape.tags.description).toContain("Two closed vocabularies");
    expect(shape.tags.description).toContain("there is no assignment verb");
    expect(shape.tags.description).toContain("a second task tag rejects naming both");
  });

  // ticket 01 (turn-edge-mechanism spec): `supersedes` retires from the note
  // tool's WIRE schema outright — a caller still sending it is a `.strict()`
  // parse error, not a silently dropped field. Existing `supersedes` EDGES
  // stay frozen-readable (db/citations.ts's `CITATION_RELATIONS` keeps the
  // word for storage/reads); only the write PARAMETER is gone from the
  // surface a caller can actually reach. `noteInputShape.supersedes` itself
  // still exists as a raw field OBJECT, unexported from either schema now
  // (ticket 08 retired settlement's own reuse of it too) — but
  // `noteInputSchema` `.omit()`s the key, so nothing that goes through the
  // real schema can ever see or send it.
  it("supersedes is removed from the note tool's own schema, and a supplied supersedes is a parse error", () => {
    expect("supersedes" in noteInputSchema.shape).toBe(false);
    expect(() =>
      noteInputSchema.parse({
        turn: "S1/T1",
        title: "t",
        content: "c",
        supersedes: ["S1/T2"],
      }),
    ).toThrow();
  });

  // RELATION-VOCABULARY-V13 TICKET 02: the THREE-class closed set —
  // correct/verify/use. The seven words they absorb are gone from BOTH write
  // surfaces (`override`/`narrows` -> `correct` plus its coverage bit,
  // `verifies` -> `verify`, `extends`/`consume`/`grounds`/`indexes` -> `use`).
  // MAIN-AGENT-EDGES D3 / R10-5: the object-IDENTITY borrow this test used to
  // assert is GONE — `settlementNoteInputShape` declares its own six. The
  // reason the borrow existed (one edit reaches both writers) is served by the
  // vocabulary staying one derived list, not by one shared zod object: the
  // ENTRY SHAPES differ now, because the main agent states a node fact while
  // settlement additionally declares a lane side. So what is pinned here is
  // what still has to be true of BOTH — the parameter exists on each surface,
  // and each carries the class's own reading — plus the fact that the two are
  // deliberately NOT one object any more.
  it("correct/verify/use are present on both write surfaces, the seven retired words are not, and each carries a reading only", () => {
    const shape = settlementNoteInputShape;
    for (const key of ["correct", "verify", "use"] as const) {
      expect(Object.keys(settlementNoteInputShape)).toContain(key);
      expect(Object.keys(noteInputShape)).toContain(key);
      expect(settlementNoteInputShape[key]).not.toBe(noteInputShape[key]);
      expect(shape[key].description?.toLowerCase()).toContain("memory rubric");
      expect(noteInputShape[key].description?.toLowerCase()).toContain("memory rubric");
    }
    // THE OLD WORDS ARE NOT PARAMETERS ANY MORE, on either surface, assertion
    // or mirror. A word the tool still accepted after the rubric stopped
    // teaching it is exactly the writer-taught-one-vocabulary/judged-by-another
    // defect this batch exists to remove.
    for (const retired of [
      "override",
      "narrows",
      "extends",
      "indexes",
      "consume",
      "grounds",
      "verifies",
      "retractOverride",
      "retractNarrows",
      "retractExtends",
      "retractIndexes",
      "retractConsume",
      "retractGrounds",
      "retractVerifies",
      "refutes",
      "retractRefutes",
      "retractSupersedes",
    ]) {
      expect(Object.keys(settlementNoteInputShape), retired).not.toContain(retired);
      expect(Object.keys(noteInputSchema.shape), retired).not.toContain(retired);
    }

    // `correct` absorbs `override`'s and `narrows`' readings and REQUIRES the
    // coverage bit; no describe states a phase domain (v12 retired phase
    // pairing from the write gate).
    expect(shape.correct.description).toContain("negates, limits or re-scopes");
    expect(shape.correct.description).toContain('REQUIRES the coverage bit');
    expect(shape.correct.description).toContain('"coverage": "full"');
    expect(shape.correct.description).toContain('"coverage": "partial"');
    expect(shape.correct.description).toContain("no coverage is refused");
    expect(shape.correct.description).not.toContain("same phase");
    expect(shape.correct.description).not.toContain("decision-phase turns only");

    // ADR-0009's three-way split: the mechanical phase requirement lives in
    // the validator's own rejection message, not on any describe.
    for (const key of ["correct", "verify", "use"] as const) {
      const description = shape[key].description ?? "";
      expect(description).not.toContain("(research/measure)");
      expect(description).not.toContain("(design/discuss/correction)");
      expect(description).not.toContain(
        "(implement/refactor/fix/delegate/review/ops)",
      );
    }
  });

  // The precedence's own three facts, one per class, each pinned so a
  // mutation that drops one drives this red: USE is DIRECT input only
  // (ancestors excluded), VERIFY is narrow, and only `correct` has a bit.
  it("use excludes ancestors, verify is narrow, and neither takes a coverage bit", () => {
    const shape = settlementNoteInputShape;
    expect(shape.use.description).toContain("DIRECT input");
    expect(shape.use.description).toContain("Ancestors are excluded");
    expect(shape.use.description).toContain("No `coverage` — refused if sent");
    expect(shape.verify.description).toContain("narrow");
    expect(shape.verify.description).toContain("DETAIL of the cited turn is not this class");
    expect(shape.verify.description).toContain("is `correct`");
    expect(shape.verify.description).toContain("No `coverage` — refused if sent");
  });

  // A class-level retraction is what keeps a row written under the RETIRED
  // seven-word vocabulary deletable — the E2 deadlock (a stored word with no
  // deletion path) is what the mirrors exist for.
  it("retractCorrect states it deletes whichever coverage bit the row carries, and a retired-vocabulary row stays deletable", () => {
    const shape = settlementNoteInputShape;
    expect(shape.retractCorrect.description).toContain("whichever coverage bit it carries");
    expect(shape.retractCorrect.description).toContain("No `coverage` here");
  });

  // The `indexes`/`grounds`/`consume` describe pins STOOD HERE and are DELETED
  // with their parameters (relation-vocabulary-v13 ticket 02). Every reading
  // they pinned either moved into `use`'s own describe (a direct input, with
  // ancestors excluded) or died with the word: `indexes` is deleted outright
  // (user ruling S15069/T2306) and the untagged-consume/indexes dedup rule went
  // with the two fields it related.

  // The note tool's own description names the eight-word vocabulary and the
  // mechanical checks the call actually makes. Ticket 04: `collects` is gone
  // from that list, and so is the flow-membership check it advertised — the
  // self-citation gate is now the only graph-state rejection left to name.
  it("the note description names indexes, not collects, and advertises no retired flow-membership check", () => {
    const note = MNEMO_TOOL_DESCRIPTIONS.note;
    expect(note).toContain("correct/verify/use");
    for (const retired of [
      "override/narrows",
      "indexes",
      "consume",
      "grounds",
      "verifies",
    ]) {
      expect(note, retired).not.toContain(retired);
    }
    expect(note).not.toContain("refutes");
    expect(note).not.toContain("collects");
    expect(note).not.toContain("flow-membership check");
    // main-agent-edges ticket 05: the three classes appear as THIS call's own
    // parameters now (lane-model-v12 ticket 08 had them named only to be
    // disowned), and the enforcement clause still names what this surface
    // actually checks.
    expect(note).toContain("correct/verify/use (with their retract… mirrors) are ROUTINE here");
    expect(note).toContain(
      "this call enforces address shape, the tag vocabulary and your read grant",
    );
    expect(note).not.toContain("(self-citation included)");
    // Lane-model v12: the phase half of that clause is GONE, not reworded —
    // the word a turn may write is no longer a function of its `type`, so the
    // description must not send a caller looking for a phase rule. Removed
    // rather than replaced with a positive sentence because this text sits in
    // every request's cached prefix and the budget assertion above is real.
    expect(note).not.toContain("phase");
  });

  // Lane-model v12 ticket 02 retired the "evidence-phase source" requirement;
  // relation-vocabulary-v13 ticket 02 renamed the word. What survives is the
  // ROUTING fact — a check that came out AGAINST the cited result is a
  // correction, not a verification — which is the one thing a writer gets
  // wrong without it.
  it("verify states no evidence-phase requirement, and routes a contrary result to correct", () => {
    const description = settlementNoteInputShape.verify.description ?? "";
    expect(description).not.toContain("evidence-phase source");
    expect(description).not.toContain("evidence-phase");
    expect(description).toContain("A check that came out AGAINST the cited result");
    expect(description).toContain("is `correct`");
  });

  // [S15069/T939] mid-flight amendment: schema enums and prompt vocabulary
  // lists must derive from (or be guard-tested against) the ONE shared
  // constant (`shared/turn-phase.ts`'s `EDGE_RELATIONS`) — this pins that
  // `mcp/note.ts`'s `RELATION_FIELD_ENTRIES` (the field-name -> relation
  // wiring) covers exactly `EDGE_RELATIONS`, in the same currency, and that
  // every one of its parameter names is a real key on `noteInputSchema`.
  it("RELATION_FIELD_ENTRIES covers RELATION_CLASSES exactly, and every field name is a real schema parameter", () => {
    const relations = RELATION_FIELD_ENTRIES.map(([, relation]) => relation).sort();
    expect(relations).toEqual([...RELATION_CLASSES].sort());

    const fieldNames = RELATION_FIELD_ENTRIES.map(([key]) => key);
    expect(fieldNames.length).toBe(RELATION_CLASSES.length);
    for (const key of fieldNames) {
      // main-agent-edge-capability ticket 01: RESTORED to `note`'s own
      // schema — both surfaces carry it now.
      expect(
        key in settlementNoteInputShape,
        `${key} should be a settlement schema parameter`,
      ).toBe(true);
      expect(key in noteInputSchema.shape, `${key} should be a note parameter`).toBe(true);
    }
  });

  // ticket 02 (edge-mechanism-revision D3): the retraction half of the same
  // vocabulary. `mcp/note.ts` DERIVES its parameter names from the relation
  // ones (`retract` + the capitalised field name); this schema declares them
  // by hand, one describe each, so the guard pins that the two agree — a
  // relation added to `EDGE_RELATIONS` without its retraction parameter
  // declared here fails right here.
  //
  // Peer round T1466 (finding P1-2): the mirror set is WIDER than the relation
  // set by exactly `RETRACTION_ONLY_RELATIONS` — a set lane-model v12 ticket 03
  // emptied, so the two coincide today. Still asserted as an identity in both
  // directions rather than loosened, because the RULE is the deliverable: the
  // union is what a future frozen word would re-enter through.
  it("RETRACTION_FIELD_ENTRIES mirrors the relation fields one for one, plus the retraction-only words", () => {
    const relations = RETRACTION_FIELD_ENTRIES.map(([, relation]) => relation).sort();
    expect(relations).toEqual([...RELATION_CLASSES].sort());

    const pairs = RELATION_FIELD_ENTRIES.map(([key, relation]) => [relation, key] as const);
    for (const [key, relation] of RETRACTION_FIELD_ENTRIES) {
      // A retraction-only word mirrors no relation parameter (there is none
      // to capitalise), so its own name is the spelling rule's input.
      const relationField = pairs.find(([r]) => r === relation)?.[1] ?? relation;
      expect(key).toBe(
        `retract${relationField.charAt(0).toUpperCase()}${relationField.slice(1)}`,
      );
      expect(
        key in settlementNoteInputShape,
        `${key} should be a settlement schema parameter`,
      ).toBe(true);
      expect(key in noteInputSchema.shape, `${key} should be a note parameter`).toBe(true);
    }
  });

  // THE ASYMMETRY ITSELF (finding P1-2), now at its EMPTY value. A word is
  // retractable-and-never-assertable for exactly as long as stored rows carry
  // it; `supersedes` and `refutes` both left that state when ticket 03's
  // migration rewrote their rows and narrowed the CHECK. The identity below is
  // what keeps the two definitions honest in either direction: freeze a new
  // word out of `EDGE_RELATIONS` while leaving it in `CITATION_RELATIONS` and
  // this fails until its mirror is declared; declare a mirror for a word no
  // row can carry and it fails too.
  it("the retraction-only words are exactly the storage vocabulary minus the write vocabulary, and none is assertable", () => {
    expect([...RETRACTION_ONLY_RELATIONS].sort()).toEqual(
      CITATION_RELATIONS.filter(
        (relation) => !(EDGE_RELATIONS as readonly string[]).includes(relation),
      ).sort(),
    );

    for (const relation of RETRACTION_ONLY_RELATIONS) {
      // No relation field, on either write surface's wiring…
      // Widened: since relation-vocabulary-v13 ticket 02 the entry list is
      // keyed on CLASSES and this list on STORAGE words, so the two have no
      // overlapping type — the ASSERTION (no retraction-only word is
      // assertable) is still exactly the one this test is about.
      expect(
        RELATION_FIELD_ENTRIES.some(([, r]) => (r as string) === (relation as string)),
      ).toBe(false);
      // …and no assertable parameter on either schema. `noteInputShape` keeps
      // `supersedes` as frozen documentation, but `noteInputSchema` omits it,
      // so a caller sending it is a parse error on both surfaces.
      expect(relation in noteInputSchema.shape).toBe(false);
      expect(relation in settlementNoteInputShape).toBe(false);
      // The retraction mirror, on the one surface that has edges (ticket 08).
      const mirror = `retract${relation.charAt(0).toUpperCase()}${relation.slice(1)}`;
      expect(mirror in noteInputSchema.shape).toBe(false);
      expect(mirror in settlementNoteInputShape).toBe(true);
    }
  });

  // ticket 04 (edge-mechanism-revision D3/D6) closed the gap ticket 02 pinned
  // here: settlement's surface declares the retraction mirrors AND its facade
  // wires them to `retractTurnRelations`, together, as that ticket required.
  // main-agent-edge-capability ticket 01 RESTORED the mirrors to
  // `noteInputShape`; MAIN-AGENT-EDGES D3 then split the two surfaces' ENTRY
  // shapes, so the object-identity assertion this test carried is retired with
  // its relation-half twin above. A public mirror takes a bare address string
  // (a retraction addresses the PAIR, T2432 P1, so an entry has nothing else
  // to carry), while settlement's still takes the two-sided entry. What both
  // must still do is DECLARE every mirror the derived vocabulary names, under
  // the same reading.
  it("both write surfaces declare every retraction mirror, under the same reading", () => {
    for (const [key] of RETRACTION_FIELD_ENTRIES) {
      expect(key in settlementNoteInputShape).toBe(true);
      expect(key in noteInputShape).toBe(true);
      expect(
        (settlementNoteInputShape as Record<string, { description?: string }>)[key]?.description,
      ).toContain("is deleted");
      expect(
        (noteInputShape as Record<string, { description?: string }>)[key]?.description,
      ).toContain("is deleted");
    }
  });

  // ticket 01 requirement 3 (ADR-0003): the grade parameter is removed
  // entirely. A supplied grade is a `.strict()` parse error — checked at the
  // exact seam the MCP SDK relies on to validate a real call, not assumed.
  it("grade is removed entirely — the schema does not offer it, and a supplied grade is a parse error", () => {
    expect("grade" in noteInputShape).toBe(false);
    expect(() =>
      noteInputSchema.parse({ turn: "S1/T1", title: "t", content: "c", grade: 2 }),
    ).toThrow();
    expect(() =>
      noteInputSchema.parse({
        turn: "S1/T1",
        content: "c",
        mode: { grade: "overwrite" },
      }),
    ).toThrow();
  });

  // ticket 09 (edge-ownership-impl, "结算顺手维护 session 叙事"): the session
  // address retires from `note` OUTRIGHT — `turn` is the only address this
  // schema accepts, and `session` (with every field that used to travel
  // with it — title/decision/done/next_steps/reference/current) is a bare
  // `.strict()` unrecognised-key parse error now, same treatment `grade`
  // (ADR-0003) already gets: there is nothing left on this schema to point
  // the caller at.
  it("noteInputSchema is turn-only — session is a `.strict()` parse error, whatever else rides with it", () => {
    expect(
      noteInputSchema.parse({ turn: "S1/T1", title: "t", content: "c" }),
    ).toEqual({ turn: "S1/T1", title: "t", content: "c" });
    expect(() => noteInputSchema.parse({ turn: "S1/T1", replace: true })).toThrow();
    expect(() =>
      noteInputSchema.parse({ session: "S1", title: "A session title" }),
    ).toThrow();
    expect(() => noteInputSchema.parse({ session: "S1" })).toThrow();
    expect(() =>
      noteInputSchema.parse({
        turn: "S1/T1",
        regrade: { id: "T1", grade: 1 },
      }),
    ).toThrow();
    expect(() =>
      noteInputSchema.parse({ turn: "S1/T1", status: "extracted" }),
    ).toThrow();
    // Every field that used to ride on a session address — including the
    // eighth, `current` (ticket 04) — is equally gone: there is no session
    // address left for any of them to attach to.
    for (const field of ["current", "decision", "done", "next_steps", "reference"] as const) {
      expect(() =>
        noteInputSchema.parse({ session: "S1", [field]: "x" }),
      ).toThrow();
    }
    expect(
      noteInputSchema.parse({ turn: "S1/T1", content: "c", insight: "i" }),
    ).toEqual({ turn: "S1/T1", content: "c", insight: "i" });
    expect(() =>
      noteInputSchema.parse({
        turn: "S1/T1",
        cites: [{ id: 1, relation: "supersedes" }],
      }),
    ).toThrow();
    // Ticket 05 (write-mode-edit-semantics, spec D1): `mode.<field>` is now
    // `"write"` or the edit form — `"overwrite"` retired (see the dedicated
    // retired-literal test below).
    expect(
      noteInputSchema.parse({
        turn: "S1/T1",
        content: "c",
        mode: { content: "write" },
      }).mode,
    ).toEqual({ content: "write" });
    expect(
      noteInputSchema.parse({
        turn: "S1/T1",
        mode: {
          content: { mode: "edit", oldString: "a", newString: "b" },
        },
      }).mode,
    ).toEqual({ content: { mode: "edit", oldString: "a", newString: "b" } });
    expect(() =>
      noteInputSchema.parse({
        turn: "S1/T1",
        content: "c",
        mode: { content: "merge" },
      }),
    ).toThrow();
  });

  // Ticket 05 (spec D14): the retired mode literals stay in the schema with
  // a message naming their replacement, the same precedent the retired
  // `topic`/`truncate`/`view` parameters already set — not a generic union
  // error naming nothing.
  // [S15069/T1726] DIRECTION REVERSED (settlement-ergonomics D1). This used to
  // assert that a retired literal is rejected WITH a message naming its
  // replacement, which required keeping `"overwrite"`/`"append"` in the union
  // as accepted members so a superRefine could run and produce that message.
  // A schema is also a prompt: leaving them declared meant the model read them
  // as legal and called them — 13 times in one measured settlement run. They
  // are gone from the union now, so the rejection happens a layer earlier and
  // the message is zod's own. The named-replacement text survives at the
  // handler layer for callers that bypass schema validation; it is simply no
  // longer reachable through this one.
  it("the retired mode literals are not in the union at all, and D4 refuses the edit form on a set field", () => {
    for (const retired of ["overwrite", "append"]) {
      const parsed = noteInputSchema.safeParse({
        turn: "S1/T1",
        content: "c",
        mode: { content: retired },
      });
      expect({ retired, accepted: parsed.success }).toEqual({ retired, accepted: false });
    }

    // D4: the edit form has no meaning on a set field (type/tags).
    const editOnTags = noteInputSchema.safeParse({
      turn: "S1/T1",
      mode: { tags: { mode: "edit", oldString: "a", newString: "b" } },
    });
    expect(editOnTags.success).toBe(false);
    const editOnTagsMessage = editOnTags.success
      ? ""
      : editOnTags.error.issues.map((i) => i.message).join(" ");
    expect(editOnTagsMessage).toContain("set field");
  });

  // Ticket 02 (ADR-0001/0002): `remember` revives the retired tool name as
  // the segment write surface, distinct from `note`. Ticket 05 (vocabulary
  // switch) renames the field-writing pair `append`/`replace` to `write`/
  // `edit` and widens the field list to content/insight. Ticket 02
  // (ownership-and-note-cadence spec) adds `assign` as a sixth verb.
  // rubric-v10 ticket 07 adds `retag` as a seventh. Lane-declaration ticket
  // 01 adds `declare`/`undeclare` as the eighth and ninth. lane-model-v12
  // ticket 17 adds `detach`, and container-unification ticket 05 retires
  // `declare` again — its capability folds into `create`'s own id-tier
  // routing, leaving EIGHT verbs — and, in the same breath, the reason a
  // caller rarely reaches for `attach`/`detach` by hand: a turn's segment tag
  // attaches the session on its own. Container-unification ticket 06 retires
  // `undeclare` the same way, into `delete`'s own id-tier routing — the verb
  // count does not change, only the ninth word does.
  it("the remember description names every verb in the enum, the field list, markup/citation/English rules and stays capped", () => {
    const remember = MNEMO_TOOL_DESCRIPTIONS.remember;
    expect(remember).toContain("`create`");
    expect(remember).toContain("`attach`");
    expect(remember).toContain("`detach`");
    // Ticket 17: the auto-attach fact earns its tokens by PREVENTING calls —
    // without it the agent both calls `attach` it did not need and meets an
    // unexplained segment card in a `note` result.
    expect(remember).toContain("a turn's task tag attaches it");
    expect(remember).toContain("`write`");
    expect(remember).toContain("`edit`");
    expect(remember).toContain("`close`");
    // Ticket 14: `assign` retired — membership is derived from a turn's tags.
    expect(remember).not.toContain("`assign`");
    expect(remember).toContain("`retag`");
    // Container-unification ticket 05: `declare` retires — its capability
    // lives on as `create`'s lane tier, and the retired word does not appear
    // at all (a schema is also a prompt; explaining a word absent from the
    // enum would be noise, the same reasoning `assign` above already got).
    expect(remember).not.toContain("`declare`");
    // Container-unification ticket 06: `undeclare` retires the same way —
    // into `delete`'s own id-tier routing.
    expect(remember).not.toContain("`undeclare`");
    expect(remember).toContain("`delete`");
    expect(remember).toContain("goal, constraints, reference");
    expect(remember).toContain("plus insight (summary)");
    // Lane-impressions ticket 05: the retired narrative fields are not in the
    // list, and neither is `content` — settlement owns the task-tier
    // impression that lives in it.
    expect(remember).not.toContain("decisions, done, next_steps");
    expect(remember).not.toContain("plus content, insight");
    expect(remember).toContain("Tool-call markup");
    expect(remember).toContain("Every field is written in English.");
    // Ticket 05: the row-add idiom — `append` retired without a replacement
    // verb, so the description has to teach it (spec D7): anchor `edit` on
    // the last row to add one, or use `write` to reorder/rewrite whole.
    expect(remember).toContain("anchoring `edit` on the last row");
    expect(remember.toLowerCase()).toContain("reordering");
    // Ticket 05: the "under 10 turns" too-soon reminder and its `decisions`
    // exemption are gone — tickets 02+09 (856815b) already retired the
    // BEHAVIOUR (formatMaintenanceCadence reports a bare turn count with no
    // threshold branch); this description text was left stale until this
    // ticket's own vocabulary rewrite touched the same paragraph.
    expect(remember).not.toContain("too-soon reminder");
    expect(remember).not.toContain("append is exempt");
    // Ticket 13 (spec "节奏与建段指导"): the 20-turn nudge retired off the
    // segment card's header outright — the description must not promise it
    // lives there any more, and must instead carry its own one-line timing
    // fact, pointed at the Memory Rubric for the judgment rather than
    // restating it (the single-home grep guard in memory-rubric.test.ts
    // covers the restatement half).
    expect(remember).not.toContain("rides the segment card's own header");
    expect(remember).toContain("20-turn reminder");
    expect(remember).toContain("Memory Rubric");
    // Ticket 14 (lane-model-v12 spec D3e): the ownership clauses go with the
    // verb. What replaces them on sight is the DERIVATION — a turn belongs
    // here by carrying the segment's tag — plus the fact that there is one
    // tag and it is unique.
    expect(remember).not.toContain("single ownership");
    expect(remember).not.toContain("clears ownership if `id` is omitted");
    expect(remember).toContain("one globally unique `tag`");
    expect(remember).toContain("carrying that tag in its own `note` tags");
    expect(remember).toContain("there is no assignment verb");
    // Lane-declaration ticket 01's own clause survives container-unification
    // ticket 05 in spirit — `create`'s lane tier still mints, `delete`
    // (ticket 06's rename of `undeclare`) still removes — but the ONE VERB
    // no longer needs an "or" between two words to say so.
    expect(remember).toContain("mints a LANE inside an existing task");
    expect(remember).toContain("removes an EMPTY container");
    expect(remember).toContain("how many existing turns already carry the word");
    // Container-unification ticket 04: `retag` extends to the lane tier —
    // the same TIER routing as `create`/`delete`, not a second verb.
    expect(remember).toContain("renames a container");
    expect(remember).toContain("renames that LANE");
    // Container-unification ticket 06 (spec D4): `delete` gets no `force` —
    // strong-deleting a live container is the wrong verb, not a warning.
    expect(remember).toContain("no `force`");
    // Lane-model-v12 ticket 21 (user ruling 2026-08-26, "不能静默新建") named
    // the precondition on BOTH tiers when there were still two verbs;
    // container-unification ticket 05 folded them into one, so the same
    // precondition now needs stating only once, "at both tiers" rather than
    // "twice, once per verb". This is a CALL contract (when the verb may be
    // called at all), so it lives here rather than in the rubric — the
    // rubric's action half carries the judgment (有合适的就写,没有就不写) and
    // the ask itself.
    expect(remember).toContain("AskUserQuestion");
    expect(remember).toContain("only on a yes, never silently");
    expect(remember).toContain("Same precondition at both tiers");
    expect(remember).not.toContain("`declare`");
    // The count word and the enumeration both drifted silently once already:
    // the text said "Nine verbs" and named eight while `REMEMBER_VERBS` held
    // ten, because every assertion above pins a PHRASE and none of them pins
    // the SET. Reading the verb list off the implementation is the difference
    // between an archive and a contract — a verb added to the enum without a
    // word here now fails right at the addition.
    // The verb list has TWO literal sources — the handler array and this
    // file's own zod enum — so pinning the description against one of them
    // leaves the other free to drift (peer review [S15069/T1771]). Equating
    // them first makes the loop below a check against the ADVERTISED contract
    // whichever side the next edit touches.
    expect([...rememberInputShape.verb.options]).toEqual([...REMEMBER_VERBS]);
    for (const verb of REMEMBER_VERBS) {
      expect(remember).toContain(`\`${verb}\``);
    }
    expect(remember).toContain(`${VERB_COUNT_WORDS[REMEMBER_VERBS.length]} verbs`);
    // Cap raised 380 -> 400 (ticket 02's sixth verb) -> 440 (ticket 07's
    // seventh verb plus its gate clause) -> 470 (lane-declaration ticket 01's
    // eighth/ninth verbs plus their own clause; measured: the seven-verb
    // text sat at 419, the new clause alone added ~48 tokens, leaving no
    // room without either cutting an EXISTING pinned assertion above or
    // widening the cap) -> 530 (ticket 21's ask-before-create precondition on
    // create AND declare; measured 515 after one compression pass). Container-
    // unification ticket 05 folded the two verbs' text into one (measured
    // 528) -> 610 (tickets 04/06: `retag`/`delete` both grow a second, lane-
    // tier reading each, measured 600 — the two new capabilities cost more
    // than the few tokens of headroom left at 530). -> 640 (tickets 07/08's
    // `clear`/`merge` were the ninth and tenth verbs in the enum but had NO
    // word in this summary at all; one clause naming both and deferring the
    // detail to `verb`'s own describe measured 632).
    expect(estimateTokens(remember)).toBeLessThanOrEqual(640);
  });

  // Ticket 15 (topic registry retirement): `topic` stays declared on the
  // shape ONLY so a caller still sending it gets a message naming the
  // retirement and pointing at tags, not a generic unrecognised-key error.
  it("the retired remember topic parameter names its retirement and points at tags", () => {
    const topicDescription = rememberInputShape.topic.description ?? "";
    expect(topicDescription.toLowerCase()).toContain("retired");
    expect(topicDescription.toLowerCase()).toContain("tag");
    // Ticket 07's alias-merging wording must not have survived either.
    expect(topicDescription.toLowerCase()).not.toContain("alias");
  });

  it("a supplied `topic` is rejected, naming the retirement and pointing at tags", () => {
    const result = rememberInputSchema.safeParse({
      verb: "create",
      title: "x",
      topic: "y",
    });
    expect(result.success).toBe(false);
    const message = result.success ? "" : result.error.issues[0]?.message ?? "";
    expect(message.toLowerCase()).toContain("retired");
    expect(message.toLowerCase()).toContain("tag");
  });

  // Ticket 05 (spec D14): `append`/`replace` retire as `verb` values —
  // named with their replacement, same precedent as `topic` above, rather
  // than zod's generic enum error.
  // [S15069/T1726] DIRECTION REVERSED — same reasoning as the note-mode test
  // above. The verb enum no longer declares `append`/`replace`/`assign`, so
  // they are refused by the enum itself rather than by a superRefine that had
  // to be reached through a successful base parse.
  it("the retired verbs are not in the enum at all", () => {
    const calls: Record<string, unknown>[] = [
      { verb: "append", id: "E1", field: "goal", value: "- x" },
      { verb: "replace", id: "E1", field: "goal", oldString: "a", newString: "b" },
      { verb: "assign", id: "E1" },
      // Container-unification ticket 05: `declare` retires into `create`'s
      // own id-tier routing.
      { verb: "declare", id: "E1", tag: "write-gate" },
    ];
    for (const call of calls) {
      const parsed = rememberInputSchema.safeParse(call);
      expect({ verb: call.verb, accepted: parsed.success }).toEqual({
        verb: call.verb,
        accepted: false,
      });
    }
  });
});

describe("rememberInputShape", () => {
  it("every remember parameter carries a non-empty description on the rendered schema", () => {
    const rendered = z.toJSONSchema(rememberInputSchema) as {
      properties: Record<string, { description?: string }>;
    };
    const keys = Object.keys(rememberInputShape);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const description = rendered.properties[key]?.description;
      expect(description, `${key} should carry a description`).toBeTruthy();
      expect(description!.length, `${key}'s description is too short`).toBeGreaterThan(10);
    }
  });

  // Ticket 05 widened field's enum to the Working State columns PLUS
  // content/insight; lane-impressions ticket 05 narrowed it again to four —
  // decisions/done/next_steps left the product, and `content` is the
  // settlement-owned task-tier impression. `title` stays create-only.
  it("field's enum accepts the three Working State columns plus insight, and nothing else", () => {
    for (const field of ["goal", "constraints", "reference", "insight"]) {
      expect(() =>
        rememberInputSchema.parse({ verb: "write", id: "E1", field, value: "x" }),
      ).not.toThrow();
    }
    for (const field of ["decisions", "done", "next_steps", "content", "title", "not-a-field"]) {
      expect(() =>
        rememberInputSchema.parse({ verb: "write", id: "E1", field, value: "x" }),
      ).toThrow();
    }
  });

  // Ticket 01 (field-semantics spec, acceptance criterion "段可编辑字段的
  // 描述与定义表一致"): `field`'s own describe() is the one place a `remember`
  // caller sees the editable fields with their own schema — each gets its
  // one-line definition, aligned with the Memory Rubric's `## Fields`
  // table (not required byte-identical there, only on the rubric injection).
  it("field's describe() carries each of the four editable fields' own definition, aligned with the Fields table", () => {
    const description = rememberInputShape.field.description ?? "";
    expect(description).toContain("goal: what this task is trying to achieve");
    expect(description).toContain(
      "constraints: how the work must be done — norms, habits, standing preferences",
    );
    expect(description).toContain(
      "reference: durable pointers — source locations, specs, PRs, URLs; not plans",
    );
    expect(description).toContain("insight: reusable experience this task has settled");
    // The retired fields keep no DEFINITION here — only the sentence below
    // that says where their judgment went.
    expect(description).not.toContain("done: what is finished and verified");
    expect(description).not.toContain("next_steps: what is waiting to be done");
    expect(description).not.toContain(
      "decisions: concrete rulings about the task itself, settled and binding",
    );
    expect(description).not.toContain(
      "content: the impression this arc leaves, what it is about and how it went",
    );
  });

  // Lane-impressions ticket 05 (user ruling S15069/T2320): the retired fields
  // leave the enum AND the teaching names where their judgment lives now. The
  // teaching must not go on describing them as fields a caller may write —
  // a legal-looking word the tool always refuses is pure noise in a schema the
  // model reads as its own prompt.
  it("field's describe() names the impression surface, and the enum refuses the retired fields", () => {
    const description = rememberInputShape.field.description ?? "";
    expect(description).toContain(
      "There is no decisions, done, next_steps or content field",
    );
    expect(description).toContain('recall(id="E<n>/#<tag>")');
    expect(description).toContain("impression row");
    for (const field of ["done", "next_steps", "decisions", "content"]) {
      expect(() =>
        rememberInputSchema.parse({ verb: "write", id: "E1", field, value: "x" }),
      ).toThrow();
    }
  });

  it("rejects a verb outside the closed vocabulary", () => {
    // Container-unification ticket 06 made `delete` a real verb — this test
    // needs a word that is NOT one of the nine, so it no longer uses that
    // example.
    expect(() => rememberInputSchema.parse({ verb: "destroy", id: "E1" })).toThrow();
  });

  // Ticket 05: close only needs id — no field/rows/oldString/newString.
  it("accepts close with just an id", () => {
    expect(() => rememberInputSchema.parse({ verb: "close", id: "E1" })).not.toThrow();
  });
});

// Ticket 07 (ADR-0007, semantic-container): `settlementNoteInputShape` (the
// settlement subagent's note-write surface, sourced from here rather than
// hand-kept in worker/note-settlement-turn-facade.ts) must actually SHARE
// field objects with `noteInputShape` for every rule both surfaces agree
// on — not merely produce an equal-looking copy. Reference equality is the
// only assertion that would go red if a future edit reintroduced a second,
// independently hand-kept `type`/`tags`/relation field: a deep-equal check
// would still pass on two objects that happen to agree today and silently
// drift tomorrow.
describe("settlementNoteInputShape shares fields with noteInputShape (ticket 07)", () => {
  // Flow-relations spec (ticket 02): the relation half now carries the
  // eight-word vocabulary `noteInputShape` itself exposes — `supersedes`
  // (the field this test used to assert reference-equality for) stays
  // DROPPED from this shape outright, not merely left unequal.
  // Ticket 07/08 (write-mode-edit-semantics spec D12): `mode` joins that list
  // — one write vocabulary for both surfaces, the same object, folded into
  // this shape rather than spread onto it by the settlement facade.
  it("mode, type and insight are the SAME zod object as noteInputShape's; tags and the edge fields are not", () => {
    expect(settlementNoteInputShape.mode).toBe(noteInputShape.mode);
    expect(settlementNoteInputShape.type).toBe(noteInputShape.type);
    // Ticket 14 (spec D3b: "主 agent 与结算两侧的 `.describe()` 分别写"):
    // `tags` deliberately does NOT share its object any more — the RULE is one
    // function, the wording is per-writer. The two describes must therefore
    // differ, and both must state the same closed vocabulary.
    expect(settlementNoteInputShape.tags).not.toBe(noteInputShape.tags);
    expect(settlementNoteInputShape.tags.description).not.toBe(
      noteInputShape.tags.description,
    );
    expect(settlementNoteInputShape.tags.description).toContain("Two closed vocabularies");
    expect(noteInputShape.tags.description).toContain("Two closed vocabularies");
    expect(settlementNoteInputShape.insight).toBe(noteInputShape.insight);
    // MAIN-AGENT-EDGES D3 / R10-5: the six edge parameters LEAVE this
    // enumeration and join `tags` on the not-shared side. They were shared by
    // identity for one release (main-agent-edge-capability ticket 01); D3
    // splits them because the two writers do different jobs — the main agent
    // states the node fact (citing, cited, class, coverage) and settlement
    // additionally DECLARES a lane side, so a single shared entry shape could
    // only serve both by offering the main agent side parameters it must not
    // use. Both surfaces still declare all six under one derived vocabulary;
    // only the entry shape differs.
    for (const key of [
      "correct",
      "verify",
      "use",
      "retractCorrect",
      "retractVerify",
      "retractUse",
    ] as const) {
      expect(key in settlementNoteInputShape, key).toBe(true);
      expect(key in noteInputShape, key).toBe(true);
      expect((settlementNoteInputShape as Record<string, unknown>)[key], key).not.toBe(
        (noteInputShape as Record<string, unknown>)[key],
      );
    }
  });

  it("neither retired word survives on this shape, in either half (ticket 08, lane-model-v12/03)", () => {
    for (const key of [
      "supersedes",
      "refutes",
      "retractSupersedes",
      "retractRefutes",
    ]) {
      expect(Object.keys(settlementNoteInputShape)).not.toContain(key);
    }
  });

  // Ticket 08: `mode` LEFT this list — it is a shared field now (asserted by
  // identity above), not a main-agent-only one. `skip`/`crossSession` stay
  // forbidden: settlement never declines a turn and never writes outside the
  // session it was dispatched for.
  it("declares no skip, crossSession, or job-identity field", () => {
    const keys = Object.keys(settlementNoteInputShape);
    for (const forbidden of [
      "skip",
      "crossSession",
      "jobId",
      "claimGeneration",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  // Ticket 02 (view-render-repair spec, "grading retires whole", ruled at
  // [S15069/T1035]): `grade` leaves this shape outright — settlement no
  // longer assigns a grade any more than it still assigns a tier.
  it("grade is not part of this shape any more (ticket 02) — settlement no longer grades anything", () => {
    expect(Object.keys(settlementNoteInputShape)).not.toContain("grade");
    expect(() =>
      z.object(settlementNoteInputShape).strict().parse({ turn: "S1/T1", grade: 2 }),
    ).toThrow();
  });

  it("title/content stay non-nullable — settlement's reconstruction never clears a field", () => {
    expect(() => z.object(settlementNoteInputShape).strict().parse({
      turn: "S1/T1",
      title: null,
    })).toThrow();
  });

  // Ticket 09 (edge-ownership-impl, "结算顺手维护 session 叙事"): `turn`
  // becomes optional and `session` joins it — settlement's own session-
  // narrative write, exactly one of the two addressing a call (enforced by
  // `evaluateSettlementTurnWrite`, not by this shape's own zod union — same
  // reasoning `noteInputShape`'s turn/session dispatch used before ticket 09
  // retired that surface's own `session`).
  it("turn is optional and session joins it (ticket 09) — both are legal on the wire schema", () => {
    const schema = z.object(settlementNoteInputShape).strict();
    expect(() => schema.parse({ turn: "S1/T1", type: ["design"] })).not.toThrow();
    expect(() => schema.parse({ session: "S1", title: "t", content: "c" })).not.toThrow();
    expect(() => schema.parse({})).not.toThrow();
  });
});

describe("timelineInputSchema", () => {
  it("accepts routed timeline ids and rejects extra fields", () => {
    expect(timelineInputSchema.parse({ id: "S42" })).toEqual({
      id: "S42",
    });
    expect(timelineInputSchema.parse({ id: "S42", page: 2, pageSize: 10 })).toEqual({
      id: "S42",
      page: 2,
      pageSize: 10,
    });
    expect(timelineInputSchema.parse({ id: "S42/T10..30" })).toEqual({
      id: "S42/T10..30",
    });
    expect(timelineInputSchema.parse({ id: "S42/T30.." })).toEqual({
      id: "S42/T30..",
    });
    expect(timelineInputSchema.parse({ id: "S42/T..20" })).toEqual({
      id: "S42/T..20",
    });
    expect(timelineInputSchema.parse({ id: "S42/T*" })).toEqual({
      id: "S42/T*",
    });

    expect(() => timelineInputSchema.parse({})).toThrow();
    expect(() =>
      timelineInputSchema.parse({ id: "S42", depth: "expanded" }),
    ).toThrow();
  });

  it("accepts view enum and rejects removed boolean flags", () => {
    expect(timelineInputSchema.parse({ id: "S42", view: "turns" })).toEqual({
      id: "S42",
      view: "turns",
    });
    expect(timelineInputSchema.parse({ id: "S42", view: "milestones" })).toEqual({
      id: "S42",
      view: "milestones",
    });

    expect(() =>
      timelineInputSchema.parse({ id: "S42", view: "summary" }),
    ).toThrow();
    expect(() =>
      timelineInputSchema.parse({ id: "S42", milestones: true }),
    ).toThrow();
    expect(() =>
      timelineInputSchema.parse({ id: "S42", phases: false }),
    ).toThrow();
  });

  // Ticket 04 (spec "Tools"): `phases` retires — a parse error naming the
  // two surviving views. Removing it from the enum (rather than keeping it
  // defined only to reject, the way `recall`'s `truncate` does) is enough:
  // zod's own invalid-option message already lists "turns"/"milestones".
  it("view: \"phases\" is a parse error naming the two surviving views", () => {
    const result = timelineInputSchema.safeParse({ id: "S42", view: "phases" });
    expect(result.success).toBe(false);
    const message = result.success ? "" : result.error.issues.map((i) => i.message).join(" ");
    expect(message).toContain("turns");
    expect(message).toContain("milestones");
    expect(message).not.toContain("phases");
  });

  // Ticket 04: the same shared `filter` object recall carries.
  it("accepts the shared filter object", () => {
    expect(
      timelineInputSchema.parse({
        id: "S42",
        filter: { type: "decision", tag: "auth", session: "S12", time: "-7d", file: "src/" },
      }),
    ).toEqual({
      id: "S42",
      filter: { type: "decision", tag: "auth", session: "S12", time: "-7d", file: "src/" },
    });
    expect(() =>
      timelineInputSchema.parse({ id: "S42", filter: { project: "claude-mnemo" } }),
    ).toThrow();
  });
});
