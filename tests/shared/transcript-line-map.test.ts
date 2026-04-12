import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildPromptIdLineMap } from "../../src/shared/transcript-parser";

describe("buildPromptIdLineMap", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "line-map-"));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeJsonl(
    name: string,
    lines: Array<Record<string, unknown>>,
  ): string {
    const path = join(tmpDir, name);
    writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n"), "utf8");
    return path;
  }

  it("returns the first physical line for each promptId", () => {
    const path = writeJsonl("basic.jsonl", [
      {
        type: "user",
        promptId: "pa",
        uuid: "u1",
        message: { role: "user", content: "first" },
      },
      {
        type: "assistant",
        uuid: "u2",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
      },
      {
        type: "user",
        promptId: "pb",
        uuid: "u3",
        message: { role: "user", content: "second" },
      },
      {
        type: "user",
        promptId: "pb",
        uuid: "u4",
        message: { role: "user", content: "duplicate" },
      },
    ]);

    const map = buildPromptIdLineMap(path);

    expect(map.get("pa")).toBe(1);
    expect(map.get("pb")).toBe(3);
    expect(map.size).toBe(2);
  });

  it("keeps the first promptId when a later duplicate snapshot conflicts", () => {
    const path = writeJsonl("conflict.jsonl", [
      {
        type: "user",
        promptId: "pa",
        uuid: "u1",
        message: { role: "user", content: "first" },
      },
      {
        type: "assistant",
        uuid: "u2",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
      },
      {
        type: "user",
        promptId: "pb",
        uuid: "u1",
        message: { role: "user", content: "resumed snapshot" },
      },
    ]);

    const map = buildPromptIdLineMap(path);

    expect(map.get("pa")).toBe(1);
    expect(map.has("pb")).toBe(false);
    expect(map.size).toBe(1);
  });

  it("skips entries without promptId", () => {
    const path = writeJsonl("no-prompt-id.jsonl", [
      { type: "system", subtype: "turn_duration", uuid: "u1" },
      { type: "user", uuid: "u2", message: { role: "user", content: "no pid" } },
      {
        type: "user",
        promptId: "px",
        uuid: "u3",
        message: { role: "user", content: "with pid" },
      },
    ]);

    const map = buildPromptIdLineMap(path);

    expect(map.get("px")).toBe(3);
    expect(map.size).toBe(1);
  });

  it("returns an empty map for missing or empty transcripts", () => {
    const empty = writeJsonl("empty.jsonl", []);

    expect(buildPromptIdLineMap(empty).size).toBe(0);
    expect(buildPromptIdLineMap(join(tmpDir, "missing.jsonl")).size).toBe(0);
  });
});
