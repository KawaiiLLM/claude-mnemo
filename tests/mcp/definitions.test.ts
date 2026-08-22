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
import { RELATION_FIELD_ENTRIES, RETRACTION_FIELD_ENTRIES } from "../../src/mcp/note";
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
    // ticket 02 (edge-mechanism-revision D1/D3): the C7 co-occurrence fact
    // this line used to state ("an uncited target rejects the call") is
    // retired along with the check — the description now teaches the
    // opposite, plus multi-relation and the retraction mirrors.
    expect(note).not.toContain("an uncited target rejects the call");
    expect(note).toContain("declared independently of the prose");
    expect(note).toContain("a call carrying nothing but relations is valid");
    expect(note).toContain("A pair may hold several relations at once");
    expect(note).toContain("retract<Relation>");
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

  // Flow-relations spec (ticket 02): the eight-word closed set — override/
  // narrows/extends/indexes/consume/grounds/verifies/refutes — replaces the
  // retired seven-word set (and its own predecessor, supersedes) outright.
  // `collects` renamed to `indexes` (indexes-rescope spec, ticket 01).
  it("override/narrows/extends/indexes/consume/grounds/verifies/refutes are present, and carry a reading only — the discriminators live in the Memory Rubric", () => {
    const shape = noteInputSchema.shape;
    for (const key of [
      "override",
      "narrows",
      "extends",
      "indexes",
      "consume",
      "grounds",
      "verifies",
      "refutes",
    ] as const) {
      expect(Object.keys(noteInputShape)).toContain(key);
      expect(shape[key].description?.toLowerCase()).toContain("memory rubric");
    }

    // Format survives at the reading level: override's flow/layer-unlimited
    // reach, no restated phase-pair enumeration.
    expect(shape.override.description).toContain("same phase");
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
      "refutes",
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
  it("indexes states same-phase aggregation with no graph-state check; grounds states its reach, the canonical route and the self-citation gate", () => {
    const shape = noteInputSchema.shape;
    expect(shape.indexes.description).toContain("same-phase nodes this turn gathers");
    expect(shape.indexes.description).toContain("a release's shipped artifacts");
    expect(shape.indexes.description).toContain(
      "Same phase is the whole check: no flow, membership or terminus condition",
    );
    expect(shape.indexes.description).toContain("An indexed target is not also consumed");
    // The retired collects-era promises must be gone from the surface, not
    // merely reworded around.
    expect(shape.indexes.description).not.toContain("branch's settlement");
    expect(shape.indexes.description).not.toContain("already belongs to that same branch");
    // consume carries the other half of the same dedup, beside extends.
    expect(shape.consume.description).toContain(
      "never written beside an extends or indexes on the same pair",
    );

    expect(shape.grounds.description).toContain("cross-phase only");
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
    // rubric-v10 ticket 02 (Gate C); round-4 review #1 hardened it: self-
    // citation reads as two conditions — an implementer half (delivery-phase
    // type, checked pre-write) and a CURRENT-terminus half (post-transaction,
    // stale after a later override), not the old flow-derived settlement+
    // implementer condition and not a "carries a tagged indexes edge, ever"
    // reading either.
    expect(shape.grounds.description).toContain(
      "may cite the citing turn itself only when this turn's own type carries a delivery-phase word",
    );
    expect(shape.grounds.description).toContain(
      "is the CURRENT terminus of a lane it declared via a TAGGED indexes edge",
    );
    expect(shape.grounds.description).toContain(
      "a later override that reopens or repudiates that declaration means it no longer qualifies",
    );
  });

  // The note tool's own description names the eight-word vocabulary and the
  // mechanical checks the call actually makes. Ticket 04: `collects` is gone
  // from that list, and so is the flow-membership check it advertised — the
  // self-citation gate is now the only graph-state rejection left to name.
  it("the note description names indexes, not collects, and advertises no retired flow-membership check", () => {
    const note = MNEMO_TOOL_DESCRIPTIONS.note;
    expect(note).toContain(
      "override/narrows/extends/indexes/consume/grounds/verifies/refutes",
    );
    expect(note).not.toContain("collects");
    expect(note).not.toContain("flow-membership check");
    expect(note).toContain("phase legality (the self-citation gate included)");
  });

  it("verifies/refutes require an evidence-phase source only — no target restriction restated", () => {
    const shape = noteInputSchema.shape;
    for (const key of ["verifies", "refutes"] as const) {
      const description = shape[key].description ?? "";
      expect(description).toContain("evidence-phase source");
    }
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

  // ticket 02 (edge-mechanism-revision D3): the retraction half of the same
  // vocabulary. `mcp/note.ts` DERIVES its parameter names from the relation
  // ones (`retract` + the capitalised field name); this schema declares them
  // by hand, one describe each, so the guard pins that the two agree — a
  // relation added to `EDGE_RELATIONS` without its retraction parameter
  // declared here fails right here.
  it("RETRACTION_FIELD_ENTRIES mirrors the relation fields one for one, and every name is a real schema parameter", () => {
    const relations = RETRACTION_FIELD_ENTRIES.map(([, relation]) => relation).sort();
    expect(relations).toEqual([...EDGE_RELATIONS].sort());

    const pairs = RELATION_FIELD_ENTRIES.map(([key, relation]) => [relation, key] as const);
    for (const [key, relation] of RETRACTION_FIELD_ENTRIES) {
      const relationField = pairs.find(([r]) => r === relation)![1];
      expect(key).toBe(
        `retract${relationField.charAt(0).toUpperCase()}${relationField.slice(1)}`,
      );
      expect(key in noteInputSchema.shape, `${key} should be a schema parameter`).toBe(true);
    }
  });

  // ticket 04 (edge-mechanism-revision D3/D6) closed the gap ticket 02 pinned
  // here: settlement's surface declares the retraction mirrors AND its facade
  // wires them to `retractTurnRelations`, together, as that ticket required.
  // Object IDENTITY, not shape equality — the same rule the parity test
  // applies to the relation half: a settlement-flavoured copy of a describe
  // would let the two writers drift into two vocabularies for one word.
  it("the settlement note shape declares the retraction mirrors, as the SAME field objects", () => {
    for (const [key] of RETRACTION_FIELD_ENTRIES) {
      expect(key in settlementNoteInputShape).toBe(true);
      expect(
        (settlementNoteInputShape as Record<string, unknown>)[key],
      ).toBe((noteInputShape as Record<string, unknown>)[key]);
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
  it("the retired mode literals 'overwrite' and 'append' each name their replacement, and D4 refuses the edit form on a set field", () => {
    const overwrite = noteInputSchema.safeParse({
      turn: "S1/T1",
      content: "c",
      mode: { content: "overwrite" },
    });
    expect(overwrite.success).toBe(false);
    const overwriteMessage = overwrite.success ? "" : overwrite.error.issues.map((i) => i.message).join(" ");
    expect(overwriteMessage).toContain("retired");
    expect(overwriteMessage).toContain('"write"');

    const append = noteInputSchema.safeParse({
      turn: "S1/T1",
      content: "c",
      mode: { content: "append" },
    });
    expect(append.success).toBe(false);
    const appendMessage = append.success ? "" : append.error.issues.map((i) => i.message).join(" ");
    expect(appendMessage).toContain("retired");
    expect(appendMessage).toContain('"write"');
    expect(appendMessage).toContain("edit");

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
  // rubric-v10 ticket 07 adds `retag` as a seventh.
  it("the remember description names all seven verbs, the field list, markup/citation/English rules and stays capped", () => {
    const remember = MNEMO_TOOL_DESCRIPTIONS.remember;
    expect(remember).toContain("`create`");
    expect(remember).toContain("`attach`");
    expect(remember).toContain("`write`");
    expect(remember).toContain("`edit`");
    expect(remember).toContain("`close`");
    expect(remember).toContain("`assign`");
    expect(remember).toContain("`retag`");
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
    // Ticket 02: `assign`'s own clause, trimmed to fit — single ownership
    // and the clear-ownership form are both load-bearing on sight.
    expect(remember).toContain("single ownership");
    expect(remember).toContain("clears ownership if `id` is omitted");
    // rubric-v10 ticket 07: `retag`'s own clause plus `assign`'s new
    // "gated by the target's own tags" — the membership tag gate this
    // ticket adds is load-bearing on sight, not just on the field-level
    // describes.
    expect(remember).toContain("`retag` replaces a segment's hand-curated tags whole");
    expect(remember).toContain("gated by the target's own tags");
    // Cap raised 380 -> 400 (ticket 02's sixth verb) -> 440 (ticket 07's
    // seventh verb plus its gate clause; measured: the six-verb text alone
    // already sat at 419 with `retag` and the gate clause added, leaving no
    // room without either cutting an EXISTING pinned assertion above or
    // widening the cap slightly).
    expect(estimateTokens(remember)).toBeLessThanOrEqual(440);
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
  it("a supplied verb 'append' or 'replace' is rejected, naming its replacement", () => {
    const append = rememberInputSchema.safeParse({
      verb: "append",
      id: "E1",
      field: "goal",
      value: "- x",
    });
    expect(append.success).toBe(false);
    const appendMessage = append.success ? "" : append.error.issues[0]?.message ?? "";
    expect(appendMessage).toContain("retired");
    expect(appendMessage).toContain("`write`");
    expect(appendMessage).toContain("`edit`");

    const replace = rememberInputSchema.safeParse({
      verb: "replace",
      id: "E1",
      field: "goal",
      oldString: "a",
      newString: "b",
    });
    expect(replace.success).toBe(false);
    const replaceMessage = replace.success ? "" : replace.error.issues[0]?.message ?? "";
    expect(replaceMessage).toContain("retired");
    expect(replaceMessage).toContain("`edit`");
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
  it("mode, type, tags and all eight relation fields (plus their retract mirrors) are the SAME zod object as noteInputShape's", () => {
    expect(settlementNoteInputShape.mode).toBe(noteInputShape.mode);
    expect(settlementNoteInputShape.type).toBe(noteInputShape.type);
    expect(settlementNoteInputShape.tags).toBe(noteInputShape.tags);
    expect(settlementNoteInputShape.insight).toBe(noteInputShape.insight);
    for (const key of [
      "override",
      "narrows",
      "extends",
      "indexes",
      "consume",
      "grounds",
      "verifies",
      "refutes",
      "retractOverride",
      "retractNarrows",
      "retractExtends",
      "retractIndexes",
      "retractConsume",
      "retractGrounds",
      "retractVerifies",
      "retractRefutes",
    ] as const) {
      expect(settlementNoteInputShape[key]).toBe(noteInputShape[key]);
    }
  });

  it("supersedes is not part of this shape any more (ticket 08) — frozen legacy, no writer on either surface", () => {
    expect(Object.keys(settlementNoteInputShape)).not.toContain("supersedes");
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
