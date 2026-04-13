import { describe, expect, it } from "bun:test";

import {
  MNEMO_ALLOWED_TOOLS,
  MNEMO_TOOL_DESCRIPTIONS,
  timelineInputSchema,
  recallInputSchema,
  rememberInputSchema,
} from "../../src/mcp/definitions";

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

describe("tool surface", () => {
  it("keeps the worker allowlist at two tools and exposes timeline descriptions", () => {
    expect(MNEMO_ALLOWED_TOOLS).toEqual([
      "mcp__mnemo__remember",
      "mcp__mnemo__recall",
    ]);
    expect(Object.keys(MNEMO_TOOL_DESCRIPTIONS).sort()).toEqual([
      "recall",
      "remember",
      "timeline",
    ]);
    expect(MNEMO_TOOL_DESCRIPTIONS.timeline).toContain("page/pageSize");
    expect(MNEMO_TOOL_DESCRIPTIONS.timeline).not.toContain("hard cap");
    expect(rememberInputSchema.parse({ id: "S1", title: "ok" })).toEqual({
      id: "S1",
      title: "ok",
    });
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
});
