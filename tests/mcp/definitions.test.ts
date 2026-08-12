import { describe, expect, it } from "bun:test";

import {
  MNEMO_TOOL_DESCRIPTIONS,
  timelineInputSchema,
  recallInputSchema,
  rememberInputSchema,
  workerRecallInputShape,
} from "../../src/mcp/definitions";
import { estimateTokens } from "../../src/utils/token-estimate";
import { z } from "zod";

describe("recallInputSchema", () => {
  it("accepts page + pageSize + truncate and rejects limit + depth=full", () => {
    const ok = recallInputSchema.parse({
      id: "S1",
      depth: "expanded",
      page: 2,
      pageSize: 10,
      truncate: 500,
    });

    expect(ok).toEqual({
      id: "S1",
      depth: "expanded",
      page: 2,
      pageSize: 10,
      truncate: 500,
    });

    expect(() =>
      recallInputSchema.parse({ id: "S1", limit: 10 }),
    ).toThrow();
    expect(() =>
      recallInputSchema.parse({ id: "S1", depth: "full" }),
    ).toThrow();
    expect(() =>
      recallInputSchema.parse({ id: "S1", truncate: 5000 }),
    ).toThrow();
    expect(() =>
      recallInputSchema.parse({ id: "S1", truncate: 0 }),
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
    // `note` is deliberately absent: it is the MAIN agent's own note channel
    // (spec D1). Handing it to the extraction worker would let the pipeline
    // write the notes the P1 trial exists to compare it against.
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
    expect(rememberInputSchema.parse({ id: "S1", title: "ok" })).toEqual({
      id: "S1",
      title: "ok",
    });
  });

  // Single home of the note contract (user ruling, S15069 T586): the
  // SessionStart block carries only the batch-timing digest, so everything an
  // agent needs at note-composition time must be pinned HERE — if a clause
  // drops out of this text it exists nowhere. The block-side test
  // (tests/hooks/context-note-taking.test.ts) pins the timing digest and that
  // it points at this description; the two sets are disjoint on purpose.
  it("the note description is the single home of the note contract", () => {
    const note = MNEMO_TOOL_DESCRIPTIONS.note;
    // The address norm — the one thing the injected formats cannot teach on
    // sight (the formats themselves are undocumented by design: they explain
    // themselves when they appear).
    expect(note).toContain("the only sources of an address");
    expect(note).toContain("never recall or invent one");
    // Timing lives in the SessionStart block; the description defers, never
    // restates — a second copy is how the two surfaces diverged before.
    expect(note).toContain("Timing: the SessionStart block's three rules.");
    // The skip contract: single criterion, its deletion-test check, the
    // no-invention red line, the user-decision hard line (S15069 T577–T581).
    expect(note).toContain("a future retriever would find nothing unique");
    expect(note).toContain(
      "deleting it from history would cost the project no decision, progress, or coherence",
    );
    expect(note).toContain("never invented");
    expect(note).toContain("Never skip a user decision, correction, or veto");
    expect(note).toContain("whatever the tool count");
    // Field contract essentials and the revision/guard semantics.
    expect(note).toContain("the real stage, never a hoped-for one");
    expect(note).toContain("never restate the title, never narrate looking");
    expect(note).toContain("claim first, evidence after");
    expect(note).toContain("token counts against these budgets");
    expect(note).toContain("`replace: true`");
    expect(note).toContain("a real note after a skip needs no replace");
    expect(note).toContain("`crossSession: true` only for another session's turn");
    expect(note).toContain("goes last in its batch");
    expect(note).toContain("never include <private> content");
    // 500 tokens by user decree (S15069 T586), measured 500 as shipped: the
    // description is in the cached prefix of every request, and the whole
    // point of the single-home split was to stop paying for two copies.
    expect(estimateTokens(note)).toBeLessThanOrEqual(500);
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
    expect(timelineInputSchema.parse({ id: "S42", view: "phases" })).toEqual({
      id: "S42",
      view: "phases",
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
});
