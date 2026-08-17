import { describe, expect, it } from "bun:test";

import {
  MNEMO_TOOL_DESCRIPTIONS,
  timelineInputSchema,
  recallInputSchema,
  noteInputSchema,
  noteInputShape,
  checkInputSchema,
  rememberInputSchema,
  rememberInputShape,
  workerRecallInputShape,
} from "../../src/mcp/definitions";
import { estimateTokens } from "../../src/utils/token-estimate";
import { z } from "zod";

describe("recallInputSchema", () => {
  it("accepts page + pageSize and rejects limit + depth=full", () => {
    const ok = recallInputSchema.parse({
      id: "S1",
      depth: "expanded",
      page: 2,
      pageSize: 10,
    });

    expect(ok).toEqual({
      id: "S1",
      depth: "expanded",
      page: 2,
      pageSize: 10,
    });

    expect(() =>
      recallInputSchema.parse({ id: "S1", limit: 10 }),
    ).toThrow();
    expect(() =>
      recallInputSchema.parse({ id: "S1", depth: "full" }),
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
  it("accepts truncate above the main-session cap", () => {
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
    // worker allowlist. `check` (ticket 08, spec G8) is likewise absent from
    // the worker allowlist here: it is the main agent's own pull, not a
    // channel this worker's extraction pipeline uses.
    expect(Object.keys(MNEMO_TOOL_DESCRIPTIONS).sort()).toEqual([
      "check",
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
    // Timing (user ruling, S15069 T781): each of the three rules pinned
    // independently.
    expect(note).toContain("note only FINISHED turns");
    expect(note).toContain("FIRST tool batch");
    expect(note).toContain("you cannot know which batch will be last");
    expect(note).toContain("a turn with no tool calls settles nothing");
    expect(note).toContain("a batch for notes alone only at 5+ owed");
    expect(note).not.toContain("Goes last in its batch");
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
    // ticket 07 (spec C3/C4): the relation fields' decision procedure is
    // normative down to question 3's counterfactual wording, so it is here
    // verbatim rather than paraphrased — a paraphrase that fit the old cap
    // would be the exact softening the predecessor vocabulary measured at
    // 61% precision.
    expect(note).toContain(
      "If the cited turn were wrong, would the citing turn's conclusion also be wrong?",
    );
    expect(note).toContain("(4) None → no relation");
    expect(note).toContain('Never soften (3) to "used"/"built on"');
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
    // The retired session fields are gone from the tool description too —
    // the session address now offers only `title`, stated on `session`'s own
    // `.describe()`, not spelled out here.
    expect(note).not.toContain("decision/done/next_steps/reference");

    // The description sits in the cached prefix of every request, so the cap
    // is a real per-turn cost. Moving the field contracts into `.describe()`
    // shrank this text from 660 tok (its ticket-07-era cap) to well under
    // half that — measured, not a round figure.
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
    const keys = Object.keys(noteInputShape);
    expect(keys.length).toBeGreaterThan(0);
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

  // ticket 01 requirement 5 (moved from ticket 09): the session address
  // accepts title only. content/insight stay in the schema (still valid TURN
  // fields) but the other six retired session fields — the four removed
  // outright plus `current` (retired earlier, ticket 04) — are `.strict()`
  // parse errors on EITHER surface, because they no longer exist anywhere in
  // the schema.
  it("noteInputSchema accepts both addressing surfaces and rejects every retired field", () => {
    expect(
      noteInputSchema.parse({ turn: "S1/T1", title: "t", content: "c" }),
    ).toEqual({ turn: "S1/T1", title: "t", content: "c" });
    expect(noteInputSchema.parse({ session: "S1", title: "A session title" })).toEqual(
      { session: "S1", title: "A session title" },
    );
    expect(() =>
      noteInputSchema.parse({ turn: "S1/T1", replace: true }),
    ).toThrow();
    expect(() =>
      noteInputSchema.parse({
        turn: "S1/T1",
        regrade: { id: "T1", grade: 1 },
      }),
    ).toThrow();
    expect(() =>
      noteInputSchema.parse({ turn: "S1/T1", status: "extracted" }),
    ).toThrow();
    // ticket 04 (spec D2): the retired eighth session field is not offered to
    // the model at all — neither as a value nor as a mode.
    expect(() =>
      noteInputSchema.parse({ session: "S1", current: "x" }),
    ).toThrow();
    expect(() =>
      noteInputSchema.parse({
        session: "S1",
        title: "t",
        mode: { current: "overwrite" },
      }),
    ).toThrow();
    // ticket 01: the six further-retired session fields — decision/done/
    // next_steps/reference are gone from the schema outright.
    for (const field of ["decision", "done", "next_steps", "reference"] as const) {
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

  // ticket 08 (spec G8/G9): `check` gets its own description and its own
  // budget, independent of note's 500-token cap — the two are unrelated
  // tools whose descriptions happen to share this object.
  it("the check description states what it reports, and G9's histogram never appears in it", () => {
    const check = MNEMO_TOOL_DESCRIPTIONS.check;
    expect(check).toContain("never why");
    expect(check).toContain("skip is itself a verdict");
    expect(check).toContain("compact marker");
    expect(check).toContain("sidechain");
    // G9: the per-grade histogram must not be visible to the grading agent
    // at any point in its run — including in the tool's own description.
    expect(check.toLowerCase()).not.toContain("histogram");
    expect(check).not.toMatch(/\bG[0-4]\s*:/);
    expect(estimateTokens(check)).toBeLessThanOrEqual(200);
  });

  // Ticket 02 (ADR-0001/0002): `remember` revives the retired tool name as
  // the segment write surface, distinct from `note`.
  it("the remember description names all four verbs, the field list, markup/citation/English rules and stays capped", () => {
    const remember = MNEMO_TOOL_DESCRIPTIONS.remember;
    expect(remember).toContain("`create`");
    expect(remember).toContain("`attach`");
    expect(remember).toContain("`append`");
    expect(remember).toContain("`replace`");
    expect(remember).toContain("goal, constraints, decisions, done, next_steps, reference");
    expect(remember).toContain("Tool-call markup");
    expect(remember).toContain("Every field is written in English.");
    expect(remember).toContain("under 10 turns draws a too-soon reminder");
    expect(remember).toContain("20+ turns without a touch draws a nudge");
    expect(remember).toContain("`decisions` append is exempt");
    expect(estimateTokens(remember)).toBeLessThanOrEqual(380);
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

  it("field's enum matches the six Working State columns exactly", () => {
    expect(() =>
      rememberInputSchema.parse({ verb: "append", id: "E1", field: "goal", rows: ["x"] }),
    ).not.toThrow();
    expect(() =>
      rememberInputSchema.parse({ verb: "append", id: "E1", field: "not-a-field", rows: ["x"] }),
    ).toThrow();
  });

  it("rejects a verb outside the closed vocabulary", () => {
    expect(() => rememberInputSchema.parse({ verb: "delete", id: "E1" })).toThrow();
  });
});

describe("checkInputSchema", () => {
  it("accepts a session address and rejects extra fields", () => {
    expect(checkInputSchema.parse({ id: "S42" })).toEqual({ id: "S42" });
    expect(() => checkInputSchema.parse({})).toThrow();
    expect(() =>
      checkInputSchema.parse({ id: "S42", page: 2 }),
    ).toThrow();
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
