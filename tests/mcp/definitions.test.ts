import { describe, expect, it } from "bun:test";

import {
  MNEMO_TOOL_DESCRIPTIONS,
  timelineInputSchema,
  recallInputSchema,
  noteInputSchema,
  checkInputSchema,
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
    // `note` is deliberately absent: it is the MAIN agent's own write channel
    // (spec D1). Handing it to the extraction worker would let the pipeline
    // write the notes the P1 trial exists to compare it against. ticket 03
    // (spec E1) merged `remember` into `note` — there is no second name left.
    // `check` (ticket 08, spec G8) is likewise absent from the worker
    // allowlist here: it is the main agent's own pull, not a channel this
    // worker's extraction pipeline uses.
    expect(Object.keys(MNEMO_TOOL_DESCRIPTIONS).sort()).toEqual([
      "check",
      "note",
      "recall",
      "timeline",
    ]);
    expect(MNEMO_TOOL_DESCRIPTIONS.timeline).toContain("page/pageSize");
    expect(MNEMO_TOOL_DESCRIPTIONS.timeline).toContain("view");
    expect(MNEMO_TOOL_DESCRIPTIONS.timeline).not.toContain("hard cap");
    expect(MNEMO_TOOL_DESCRIPTIONS.timeline).not.toContain("Optional `milestones`");
    expect(MNEMO_TOOL_DESCRIPTIONS.timeline).not.toContain("set false");
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
    expect(note).toContain("never recalled or invented");
    // Timing lives in the SessionStart block; the description defers, never
    // restates — a second copy is how the two surfaces diverged before.
    expect(note).toContain("Timing: the SessionStart block's three rules.");
    // The skip contract: single criterion, its deletion-test check, the
    // no-invention red line, the user-decision hard line (S15069 T577–T581).
    expect(note).toContain("a future retriever would find nothing unique");
    expect(note).toContain(
      "deleting it costs no decision, progress, or coherence",
    );
    expect(note).toContain("never invented");
    expect(note).toContain("Never skip a user decision, correction, veto");
    // Field contract essentials.
    expect(note).toContain("the real stage");
    // ticket 02 (spec B1/B2/B7): the writer states type/tags directly, no
    // mechanical title-to-type derivation any more.
    expect(note).toContain("omit or [] when none fit, never guess");
    expect(note).toContain("bare topic words, no prefix");
    expect(note).toContain("never restate the title, never narrate looking");
    expect(note).toContain("claim first");
    expect(note).toContain("token counts");
    // ticket 03 (spec D5/D5a/E1): one mode vocabulary, one tool, two surfaces.
    expect(note).toContain('mode.<field>');
    expect(note).toContain('"overwrite"');
    expect(note).toContain('"append"');
    expect(note).toContain("session's summary");
    expect(note).toContain("`crossSession: true` only for another session's turn");
    expect(note).toContain("Goes last in its batch");
    expect(note).toContain("never include <private> content");
    // spec E2: tool-call syntax is rejected, not silently stored.
    expect(note).toContain("Tool-call markup");
    // 500 tokens by user decree (S15069 T586): the description is in the
    // cached prefix of every request, and the whole point of the single-home
    // split was to stop paying for two copies.
    expect(estimateTokens(note)).toBeLessThanOrEqual(500);
  });

  // ticket 03 (spec E1): the merged input shape covers both addressing
  // surfaces and the mode vocabulary, `.strict()` so an unrecognised key
  // (the retired `replace`/`regrade`/`cites`/`status`) is a parse error.
  it("noteInputSchema accepts both addressing surfaces and rejects removed fields", () => {
    expect(
      noteInputSchema.parse({ turn: "S1/T1", title: "t", content: "c" }),
    ).toEqual({ turn: "S1/T1", title: "t", content: "c" });
    expect(
      noteInputSchema.parse({ session: "S1", decision: "d" }),
    ).toEqual({ session: "S1", decision: "d" });
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
