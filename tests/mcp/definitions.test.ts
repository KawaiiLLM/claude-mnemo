import { describe, expect, it } from "bun:test";

import {
  MNEMO_ALLOWED_TOOLS,
  MNEMO_TOOL_DESCRIPTIONS,
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
  it("exposes exactly two read/write tools: recall and remember", () => {
    expect(MNEMO_ALLOWED_TOOLS).toEqual([
      "mcp__mnemo__remember",
      "mcp__mnemo__recall",
    ]);
    expect(Object.keys(MNEMO_TOOL_DESCRIPTIONS).sort()).toEqual([
      "recall",
      "remember",
    ]);
    expect(rememberInputSchema.parse({ id: "S1", title: "ok" })).toEqual({
      id: "S1",
      title: "ok",
    });
  });
});
