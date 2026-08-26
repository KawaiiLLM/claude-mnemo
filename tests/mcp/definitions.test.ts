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
import { CITATION_RELATIONS, RETRACTION_ONLY_RELATIONS } from "../../src/db/citations";
import { RELATION_FIELD_ENTRIES, RETRACTION_FIELD_ENTRIES } from "../../src/db/citations";
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
    // lane-model-v12 ticket 08: `note` no longer HAS relation fields, so the
    // format facts it used to state about them are replaced by the one fact a
    // caller now needs — where edges went, and that sending one is refused.
    expect(note).toContain("Edges (override/narrows/extends/indexes/consume/grounds/verifies");
    expect(note).toContain("are settlement's whole business");
    expect(note).toContain("sending one of those parameters is refused");
    // The prose citation is NOT an edge and stays, which is the distinction a
    // caller would otherwise have to guess at.
    expect(note).toContain("it states no relation");
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
    // The structural short parameters lead, in the ruled order. Ticket 08
    // emptied the slot between them and the prose tail: the relation and
    // retraction arrays that sat there are settlement's now, so this shape is
    // exactly the seven structural keys plus the two prose fields.
    expect(keys).toEqual([
      "turn",
      "title",
      "skip",
      "crossSession",
      "type",
      "tags",
      "mode",
      "insight",
      "content",
    ]);
    for (const [relation] of RELATION_FIELD_ENTRIES) {
      expect(keys).not.toContain(relation);
    }
    for (const [key] of RETRACTION_FIELD_ENTRIES) {
      expect(keys).not.toContain(key);
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
    expect(shape.tags.description).toContain("a second segment tag rejects naming both");
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

  // Lane-model v12 ticket 02: the SEVEN-word closed set — override/narrows/
  // extends/indexes/consume/grounds/verifies. `refutes` merged into
  // `override` and left this surface; `collects` was renamed to `indexes`
  // (indexes-rescope spec, ticket 01) before it.
  // lane-model-v12 ticket 08 (ruling [S15069/T1651]): the relation parameters
  // live on the SETTLEMENT shape now — the main agent's `note` has none.
  it("override/narrows/extends/indexes/consume/grounds/verifies are present on the settlement shape, refutes is not, and each carries a reading only", () => {
    const shape = settlementNoteInputShape;
    for (const key of [
      "override",
      "narrows",
      "extends",
      "indexes",
      "consume",
      "grounds",
      "verifies",
    ] as const) {
      expect(Object.keys(settlementNoteInputShape)).toContain(key);
      expect(Object.keys(noteInputShape)).not.toContain(key);
      expect(shape[key].description?.toLowerCase()).toContain("memory rubric");
    }
    // The merged word has no field of any kind: ticket 02 left it a retraction
    // mirror, ticket 03's migration emptied the rows that mirror addressed and
    // closed the table's CHECK behind them, so the mirror went too.
    expect(Object.keys(settlementNoteInputShape)).not.toContain("refutes");
    expect(Object.keys(settlementNoteInputShape)).not.toContain("retractRefutes");
    expect(Object.keys(settlementNoteInputShape)).not.toContain("retractSupersedes");

    // override absorbs refute's meaning, and no describe states a phase
    // domain any more (v12 retired phase pairing from the write gate).
    expect(shape.override.description).toContain("OVERTURNS, WITHDRAWS or REPLACES");
    expect(shape.override.description).not.toContain("same phase");
    expect(shape.override.description).not.toContain("decision-phase turns only");
    expect(shape.override.description).not.toContain("decision-phase (design/discuss/correction)");

    // ADR-0009's three-way split narrows further here (ticket 02 addenda):
    // the mechanical phase requirement itself moved OFF the describe() and
    // into the validator's own rejection message — no relation still spells
    // out the old verbose "(research/measure)"-style parenthetical
    // enumeration.
    for (const key of [
      "override",
      "narrows",
      "extends",
      "indexes",
      "consume",
      "grounds",
      "verifies",
    ] as const) {
      const description = shape[key].description ?? "";
      expect(description).not.toContain("(research/measure)");
      expect(description).not.toContain("(design/discuss/correction)");
      expect(description).not.toContain(
        "(implement/refactor/fix/delegate/review/ops)",
      );
    }
  });

  // Flow-relations spec: `collects`' hard graph-state check and `grounds`'
  // mid-flow-warning/self-citation behaviour are the two relations whose
  // reading is genuinely new (no seven-word predecessor covered either),
  // and their describe()s are the only place a caller learns the mechanism
  // exists at all before hitting a rejection or a receipt warning.
  //
  // Indexes-rescope spec ticket 04 rewrites both readings. `indexes` (ticket
  // 01's rename of `collects`) states SAME-PHASE AGGREGATION and, just as
  // importantly, states the retirement: its old own-branch/terminus check is
  // gone from the write path (law 2), so a describe still promising a
  // rejection that no longer fires would teach a caller to avoid legal calls.
  // `grounds` gains the canonical route (law 7) — the one place a caller
  // writing an implementation note learns the edge may not be theirs to write
  // at all.
  it("indexes states convergence with no graph-state check; grounds states its reach, the canonical route, and refuses a self target", () => {
    const shape = settlementNoteInputShape;
    expect(shape.indexes.description).toContain("the nodes this turn converges on");
    expect(shape.indexes.description).toContain("a release's shipped artifacts");
    expect(shape.indexes.description).toContain(
      "No membership or terminus condition",
    );
    expect(shape.indexes.description).toContain("An indexed target is not also consumed");
    // The retired collects-era promises must be gone from the surface, not
    // merely reworded around.
    expect(shape.indexes.description).not.toContain("branch's settlement");
    expect(shape.indexes.description).not.toContain("already belongs to that same branch");
    // consume carries the other half of the same dedup — the extends half
    // unconditional, the indexes half narrowed to untagged (T1345 ruling),
    // with the tagged coexistence stated positively.
    expect(shape.consume.description).toContain(
      "never written beside an extends on the same pair, and never unsettled beside an indexes",
    );
    expect(shape.consume.description).toContain(
      "a LANE-PLACED consume beside a lane-placed indexes is legal",
    );

    expect(shape.grounds.description).not.toContain("cross-phase only");
    // rubric-v10 ticket 02: the flow-relations era's mid-flow warning
    // retires entirely — no flow derivation runs on the write path any
    // more, so the describe must not promise a warning that no longer fires.
    expect(shape.grounds.description).not.toContain("mid-flow target still stores");
    expect(shape.grounds.description).not.toContain("flow's settlement");
    expect(shape.grounds.description).toContain("absorbs the retired grounded-on/encodes");
    expect(shape.grounds.description).toContain("if it were false");
    expect(shape.grounds.description).toContain(
      "One route to the decision: when a SEPARATE delivery turn wrote the spec, THAT turn carries the grounds",
    );
    expect(shape.grounds.description).toContain(
      "with design and spec in one turn, each artifact grounds directly",
    );
    // Lane-model v12 ticket 04: the self-citation permission is DELETED, so
    // `grounds` no longer carries a two-condition carve-out for it. Pinned as
    // an absence where the three verbatim pins used to sit, plus the flat
    // statement that replaced them, so a future edit cannot quietly restore
    // the old reading.
    expect(shape.grounds.description).toContain(
      "a self target is refused, for this word as for every other",
    );
    expect(shape.grounds.description).not.toContain("delivery-phase word");
    expect(shape.grounds.description).not.toContain("CURRENT terminus of a lane it declared");
    expect(shape.grounds.description).not.toContain("no longer qualifies");
  });

  // The note tool's own description names the eight-word vocabulary and the
  // mechanical checks the call actually makes. Ticket 04: `collects` is gone
  // from that list, and so is the flow-membership check it advertised — the
  // self-citation gate is now the only graph-state rejection left to name.
  it("the note description names indexes, not collects, and advertises no retired flow-membership check", () => {
    const note = MNEMO_TOOL_DESCRIPTIONS.note;
    expect(note).toContain(
      "override/narrows/extends/indexes/consume/grounds/verifies",
    );
    expect(note).not.toContain("refutes");
    expect(note).not.toContain("collects");
    expect(note).not.toContain("flow-membership check");
    // lane-model-v12 ticket 08: the seven words appear only to say they are
    // NOT this call's parameters, and the enforcement clause names what this
    // surface actually still checks.
    expect(note).toContain("are settlement's whole business");
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

  // Lane-model v12 ticket 02 replaces the retired
  // "verifies/refutes require an evidence-phase source" pin: the requirement
  // is gone from the describe, and `verifies` instead routes a contrary
  // result to `override`.
  it("verifies states no evidence-phase requirement, and routes a contrary result to override", () => {
    const description = settlementNoteInputShape.verifies.description ?? "";
    expect(description).not.toContain("evidence-phase source");
    expect(description).not.toContain("evidence-phase");
    expect(description).toContain("No type requirement on either end");
    expect(description).toContain("is an override, not this word");
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
      // Ticket 08: the schema these names must exist on is SETTLEMENT's.
      expect(
        key in settlementNoteInputShape,
        `${key} should be a settlement schema parameter`,
      ).toBe(true);
      expect(key in noteInputSchema.shape, `${key} must not be a note parameter`).toBe(false);
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
    expect(relations).toEqual([...EDGE_RELATIONS, ...RETRACTION_ONLY_RELATIONS].sort());

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
      expect(key in noteInputSchema.shape, `${key} must not be a note parameter`).toBe(false);
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
      expect(RELATION_FIELD_ENTRIES.some(([, r]) => r === relation)).toBe(false);
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
  // Object IDENTITY, not shape equality — the same rule the parity test
  // applies to the relation half: a settlement-flavoured copy of a describe
  // would let the two writers drift into two vocabularies for one word.
  // Ticket 08 inverts the second half of this pin: there is no `noteInputShape`
  // object left to share, because the main agent has no edge surface. What
  // still has to hold is that settlement declares EVERY mirror the derived
  // table names, so a relation added to the vocabulary cannot land without its
  // retraction parameter.
  it("the settlement note shape declares every retraction mirror, and the note shape declares none", () => {
    for (const [key] of RETRACTION_FIELD_ENTRIES) {
      expect(key in settlementNoteInputShape).toBe(true);
      expect(key in noteInputShape).toBe(false);
      expect(
        (settlementNoteInputShape as Record<string, { description?: string }>)[key]?.description,
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
  // ticket 17 adds `detach` — and, in the same breath, the reason a caller
  // rarely reaches for either half of the pair: a turn's segment tag attaches
  // the session on its own.
  it("the remember description names all nine verbs, the field list, markup/citation/English rules and stays capped", () => {
    const remember = MNEMO_TOOL_DESCRIPTIONS.remember;
    expect(remember).toContain("`create`");
    expect(remember).toContain("`attach`");
    expect(remember).toContain("`detach`");
    // Ticket 17: the auto-attach fact earns its tokens by PREVENTING calls —
    // without it the agent both calls `attach` it did not need and meets an
    // unexplained segment card in a `note` result.
    expect(remember).toContain("a turn's segment tag attaches it");
    expect(remember).toContain("`write`");
    expect(remember).toContain("`edit`");
    expect(remember).toContain("`close`");
    // Ticket 14: `assign` retired — membership is derived from a turn's tags.
    expect(remember).not.toContain("`assign`");
    expect(remember).toContain("`retag`");
    expect(remember).toContain("`declare`");
    expect(remember).toContain("`undeclare`");
    expect(remember).toContain("goal, constraints, decisions, done, next_steps, reference");
    expect(remember).toContain("content, insight");
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
    // Lane-declaration ticket 01: declare/undeclare's own clause. Ticket 14
    // replaces the edge-precondition half with the retroactive-conscription
    // count, which is the fact a declarer has to see AT the declaration.
    expect(remember).toContain("mint or remove a lane");
    expect(remember).toContain("how many existing turns already carry the word");
    // Lane-model-v12 ticket 21 (user ruling 2026-08-26, "不能静默新建"): both
    // name-minting verbs carry the SAME precondition, because a segment tag
    // and a lane tag are two tiers of one vocabulary under one policy. This is
    // a CALL contract (when the verb may be called at all), so it lives here
    // rather than in the rubric — the rubric's action half carries the
    // judgment (有合适的就写,没有就不写) and the ask itself.
    expect(remember).toContain("AskUserQuestion");
    expect(remember).toContain("only on a yes, never silently");
    expect(remember).toContain("`declare` takes `create`'s precondition too");
    // Cap raised 380 -> 400 (ticket 02's sixth verb) -> 440 (ticket 07's
    // seventh verb plus its gate clause) -> 470 (lane-declaration ticket 01's
    // eighth/ninth verbs plus their own clause; measured: the seven-verb
    // text sat at 419, the new clause alone added ~48 tokens, leaving no
    // room without either cutting an EXISTING pinned assertion above or
    // widening the cap) -> 530 (ticket 21's ask-before-create precondition on
    // create AND declare; measured 515 after one compression pass — the first
    // draft sat at 573 and was cut back to the bare contract).
    expect(estimateTokens(remember)).toBeLessThanOrEqual(530);
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

  // Ticket 05: field's enum widened from the six Working State columns to
  // those six PLUS content/insight (ADR-0001's write/edit mechanism covers
  // the summary trio's two prose fields too; title stays create-only).
  it("field's enum accepts the six Working State columns plus content/insight, and nothing else", () => {
    for (const field of ["goal", "constraints", "decisions", "done", "next_steps", "reference", "content", "insight"]) {
      expect(() =>
        rememberInputSchema.parse({ verb: "write", id: "E1", field, value: "x" }),
      ).not.toThrow();
    }
    expect(() =>
      rememberInputSchema.parse({ verb: "write", id: "E1", field: "title", value: "x" }),
    ).toThrow();
    expect(() =>
      rememberInputSchema.parse({ verb: "write", id: "E1", field: "not-a-field", value: "x" }),
    ).toThrow();
  });

  // Ticket 01 (field-semantics spec, acceptance criterion "段八个可编辑字段的
  // 描述与定义表一致"): `field`'s own describe() is the one place a `remember`
  // caller sees the eight editable fields with their own schema — each gets
  // its one-line definition, aligned with the Memory Rubric's `## Fields`
  // table (not required byte-identical there, only on the rubric injection).
  it("field's describe() carries each of the eight editable fields' own definition, aligned with the Fields table", () => {
    const description = rememberInputShape.field.description ?? "";
    expect(description).toContain("goal: what this task is trying to achieve");
    expect(description).toContain(
      "constraints: how the work must be done — norms, habits, standing preferences",
    );
    expect(description).toContain(
      "decisions: concrete rulings about the task itself, settled and binding",
    );
    expect(description).toContain("done: what is finished and verified");
    expect(description).toContain("next_steps: what is waiting to be done");
    expect(description).toContain(
      "reference: durable pointers — source locations, specs, PRs, URLs; not plans",
    );
    expect(description).toContain(
      "content: the impression this arc leaves, what it is about and how it went",
    );
    expect(description).toContain("insight: reusable experience this task has settled");
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
    // lane-model-v12 ticket 08 (ruling [S15069/T1651]): the fourteen edge
    // parameters LEAVE this enumeration for the opposite reason `tags` did.
    // `tags` diverged in WORDING while staying on both surfaces; the edge
    // fields are on ONE surface now, so there is no second object to share and
    // none to drift from. The property that replaces reference-equality is
    // exclusivity, asserted in both directions.
    for (const key of [
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
    ] as const) {
      expect(key in settlementNoteInputShape, key).toBe(true);
      expect(key in noteInputShape, key).toBe(false);
      expect(
        (settlementNoteInputShape as Record<string, unknown>)[key],
      ).not.toBe((noteInputShape as Record<string, unknown>)[key] ?? Symbol("absent"));
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
