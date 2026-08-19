import { describe, expect, it } from "bun:test";

import {
  MNEMO_TOOL_DESCRIPTIONS,
  timelineInputSchema,
  recallInputSchema,
  noteInputSchema,
  noteInputShape,
  rememberInputSchema,
  rememberInputShape,
  settlementNoteInputShape,
  workerRecallInputShape,
} from "../../src/mcp/definitions";
import { RELATION_FIELD_ENTRIES } from "../../src/mcp/note";
import { EDGE_RELATIONS } from "../../src/shared/turn-phase";
import { estimateTokens } from "../../src/utils/token-estimate";
import { z } from "zod";

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
    expect(recall).toContain("segment");
    expect(recall).toContain("[open]");
    expect(recall).toContain("[delivered]");
    expect(recall).toContain("query=");
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
    // themselves when they appear).
    expect(note).toContain("never recalled or invented");
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
    // The citation norm: injected ids only, never private content.
    expect(note).toContain("[S15069/T332]");
    expect(note).toContain("ids seen in injected context");
    expect(note).toContain("never include <private> content");
    // spec E2: tool-call syntax is rejected, not silently stored.
    expect(note).toContain("Tool-call markup");
    // ticket 11 (edge-ownership-impl, "统一 Memory Rubric"): the six ordered
    // relation questions this text used to inline are JUDGMENT — they moved
    // to the Memory Rubric wholesale ([S15069/T933]/[T937]–[T939]). What
    // stays here is the call-level pointer plus the format facts a rubric
    // cannot state.
    expect(note).toContain("turn-only address lists");
    expect(note).toContain("an uncited target rejects the call");
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
    expect(estimateTokens(note)).toBeLessThanOrEqual(420);
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
    expect(keys).not.toContain("supersedes");
    for (const key of keys) {
      const description = rendered.properties[key]?.description;
      expect(description, `${key} should carry a description`).toBeTruthy();
      expect(description!.length, `${key}'s description is too short`).toBeGreaterThan(10);
    }
  });

  // ticket 01 requirement: "compose faithfully from the spec — these tests
  // are load-bearing". Each admission test's distinctive wording, pinned
  // verbatim on the field it governs.
  it("title/content/insight carry their admission tests verbatim on their own parameter", () => {
    const shape = noteInputSchema.shape;
    expect(shape.title.description).toContain("one English claim sentence");
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

    expect(shape.content.description).toContain("assume the title was just read");
    expect(shape.content.description).toContain("expand, never restate");
    expect(shape.content.description).toContain(
      "each rejected alternative with a one-line reason",
    );
    expect(shape.content.description).toContain("Sentence deletion test");
    expect(shape.content.description).toContain(
      "No process narration (replay stores it)",
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
    expect(shape.tags.description).toContain(
      "coarse noun naming the project",
    );
    expect(shape.tags.description).toContain("no -design/-fix hybrids");
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

  // ticket 01: the seven-word closed set — refines/override/encodes/
  // groundedOn replace supersedes; evidenceFor/evidenceAgainst/dependsOn are
  // untouched by name.
  it("refines/override/encodes/groundedOn are present, and carry FORMAT only — the discriminators moved to the Memory Rubric (ticket 11)", () => {
    const shape = noteInputSchema.shape;
    expect(Object.keys(noteInputShape)).toContain("refines");
    expect(Object.keys(noteInputShape)).toContain("override");
    expect(Object.keys(noteInputShape)).toContain("encodes");
    expect(Object.keys(noteInputShape)).toContain("groundedOn");

    // Format survives: the phase-pair facts a rubric cannot state.
    expect(shape.override.description).toContain("decision-phase turns only");
    expect(shape.encodes.description).toContain("delivery-phase turn");
    expect(shape.encodes.description).toContain("not mechanically checked");

    // Ticket 11: the two discriminator questions (override vs. refines,
    // encodes' minimal-set rule) are judgment — single home is the Memory
    // Rubric now, never restated on the describe().
    expect(shape.override.description).not.toContain(
      "if the predecessor's any sub-conclusion still holds",
    );
    expect(shape.encodes.description).not.toContain(
      "name only the minimal set that can derive the final conclusion",
    );
    expect(shape.override.description.toLowerCase()).toContain("memory rubric");
    expect(shape.encodes.description.toLowerCase()).toContain("memory rubric");
  });

  // [S15069/T935] mid-flight amendment to ticket 01: `groundedOn` joined the
  // closed set (now seven words) after this ticket was already underway —
  // its own counterfactual discriminator and its "recorded, never scored"
  // exclusion (ticket 07 must not read it as a scoring signal).
  it("groundedOn carries its own counterfactual discriminator and states it is never scored (S15069/T935)", () => {
    const shape = noteInputSchema.shape;
    expect(shape.groundedOn.description).toContain(
      "if that finding were false, this decision would fall",
    );
    expect(shape.groundedOn.description.toLowerCase()).toContain("never scored");
  });

  // [S15069/T939] mid-flight amendment: schema enums and prompt vocabulary
  // lists must derive from (or be guard-tested against) the ONE shared
  // constant (`shared/turn-phase.ts`'s `EDGE_RELATIONS`) — this pins that
  // `mcp/note.ts`'s `RELATION_FIELD_ENTRIES` (the field-name -> relation
  // wiring) covers exactly `EDGE_RELATIONS`, in the same currency, and that
  // every one of its parameter names is a real key on `noteInputSchema`.
  it("RELATION_FIELD_ENTRIES covers EDGE_RELATIONS exactly, and every field name is a real schema parameter", () => {
    const relations = RELATION_FIELD_ENTRIES.map(([, relation]) => relation).sort();
    expect(relations).toEqual([...EDGE_RELATIONS].sort());

    const fieldNames = RELATION_FIELD_ENTRIES.map(([key]) => key);
    expect(fieldNames.length).toBe(EDGE_RELATIONS.length);
    for (const key of fieldNames) {
      expect(key in noteInputSchema.shape, `${key} should be a schema parameter`).toBe(true);
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
    expect(
      noteInputSchema.parse({
        turn: "S1/T1",
        content: "c",
        mode: { content: "overwrite" },
      }).mode,
    ).toEqual({ content: "overwrite" });
    expect(() =>
      noteInputSchema.parse({
        turn: "S1/T1",
        content: "c",
        mode: { content: "merge" },
      }),
    ).toThrow();
  });

  // Ticket 02 (ADR-0001/0002): `remember` revives the retired tool name as
  // the segment write surface, distinct from `note`. Ticket 05 adds `close`
  // as a fifth verb and widens the field list to content/insight. Ticket 02
  // (ownership-and-note-cadence spec) adds `assign` as a sixth.
  it("the remember description names all six verbs, the field list, markup/citation/English rules and stays capped", () => {
    const remember = MNEMO_TOOL_DESCRIPTIONS.remember;
    expect(remember).toContain("`create`");
    expect(remember).toContain("`attach`");
    expect(remember).toContain("`append`");
    expect(remember).toContain("`replace`");
    expect(remember).toContain("`close`");
    expect(remember).toContain("`assign`");
    expect(remember).toContain("goal, constraints, decisions, done, next_steps, reference");
    expect(remember).toContain("content, insight");
    expect(remember).toContain("Tool-call markup");
    expect(remember).toContain("Every field is written in English.");
    expect(remember).toContain("under 10 turns draws a too-soon reminder");
    expect(remember).toContain("`decisions` append is exempt");
    // Ticket 13 (spec "节奏与建段指导"): the 20-turn nudge retired off the
    // segment card's header outright — the description must not promise it
    // lives there any more, and must instead carry its own one-line timing
    // fact, pointed at the Memory Rubric for the judgment rather than
    // restating it (the single-home grep guard in memory-rubric.test.ts
    // covers the restatement half).
    expect(remember).not.toContain("rides the segment card's own header");
    expect(remember).toContain("20-turn reminder");
    expect(remember).toContain("Memory Rubric");
    // Ticket 02: `assign`'s own clause, trimmed to fit — single ownership
    // and the clear-ownership form are both load-bearing on sight.
    expect(remember).toContain("single ownership");
    expect(remember).toContain("clears ownership if `id` is omitted");
    // Cap raised 380 -> 400 for the sixth verb's own clause (measured: the
    // trimmed five-verb text alone already sat at 376, leaving no room for
    // a real new capability without either cutting an EXISTING pinned
    // assertion above or widening the cap slightly).
    expect(estimateTokens(remember)).toBeLessThanOrEqual(400);
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

  // Ticket 05: field's enum widened from the six Working State columns to
  // those six PLUS content/insight (ADR-0001's append/replace mechanism
  // covers the summary trio's two prose fields too; title stays create-only).
  it("field's enum accepts the six Working State columns plus content/insight, and nothing else", () => {
    for (const field of ["goal", "constraints", "decisions", "done", "next_steps", "reference", "content", "insight"]) {
      expect(() =>
        rememberInputSchema.parse({ verb: "append", id: "E1", field, rows: ["x"] }),
      ).not.toThrow();
    }
    expect(() =>
      rememberInputSchema.parse({ verb: "append", id: "E1", field: "title", rows: ["x"] }),
    ).toThrow();
    expect(() =>
      rememberInputSchema.parse({ verb: "append", id: "E1", field: "not-a-field", rows: ["x"] }),
    ).toThrow();
  });

  it("rejects a verb outside the closed vocabulary", () => {
    expect(() => rememberInputSchema.parse({ verb: "delete", id: "E1" })).toThrow();
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
  // Ticket 08 (edge-ownership-impl, "settlement four-field check-and-
  // correct"): the relation half widened from the pre-ticket-01 four-field
  // set to the full seven-word vocabulary `noteInputShape` itself exposes —
  // groundedOn/refines/override join evidenceFor/evidenceAgainst/dependsOn,
  // and `supersedes` (the field this test used to assert reference-equality
  // for) is DROPPED from this shape outright, not merely left unequal.
  it("type, tags and all seven relation fields are the SAME zod object as noteInputShape's", () => {
    expect(settlementNoteInputShape.type).toBe(noteInputShape.type);
    expect(settlementNoteInputShape.tags).toBe(noteInputShape.tags);
    expect(settlementNoteInputShape.insight).toBe(noteInputShape.insight);
    expect(settlementNoteInputShape.evidenceFor).toBe(noteInputShape.evidenceFor);
    expect(settlementNoteInputShape.evidenceAgainst).toBe(noteInputShape.evidenceAgainst);
    expect(settlementNoteInputShape.groundedOn).toBe(noteInputShape.groundedOn);
    expect(settlementNoteInputShape.refines).toBe(noteInputShape.refines);
    expect(settlementNoteInputShape.override).toBe(noteInputShape.override);
    expect(settlementNoteInputShape.encodes).toBe(noteInputShape.encodes);
    expect(settlementNoteInputShape.dependsOn).toBe(noteInputShape.dependsOn);
  });

  it("supersedes is not part of this shape any more (ticket 08) — frozen legacy, no writer on either surface", () => {
    expect(Object.keys(settlementNoteInputShape)).not.toContain("supersedes");
  });

  it("declares no skip, crossSession, mode, or job-identity field", () => {
    const keys = Object.keys(settlementNoteInputShape);
    for (const forbidden of [
      "skip",
      "crossSession",
      "mode",
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
