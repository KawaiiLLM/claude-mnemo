import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  detectRolledBackPromptIds,
  detectRollbackTopology,
  detectRollbackTopologyFromEntries,
} from "../../src/worker/invalidation";
import { readAllTranscriptEntries } from "../../src/shared/transcript-parser";

function writeTranscript(lines: unknown[]): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "claude-mnemo-rollback-"));
  const path = join(directory, "session.jsonl");
  writeFileSync(
    path,
    lines.map((line) => JSON.stringify(line)).join("\n"),
    "utf8",
  );

  return { directory, path };
}

describe("detectRollbackTopology", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("normal linear conversation returns empty set", () => {
    const transcript = writeTranscript([
      {
        uuid: "root",
        type: "system",
        timestamp: "2026-04-18T10:00:00.000Z",
      },
      {
        uuid: "u1",
        type: "user",
        role: "user",
        promptId: "p1",
        permissionMode: "default",
        parentUuid: "root",
        timestamp: "2026-04-18T10:00:01.000Z",
        message: { role: "user", content: "First prompt" },
      },
      {
        uuid: "a1",
        type: "assistant",
        role: "assistant",
        parentUuid: "u1",
        timestamp: "2026-04-18T10:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "First answer" }],
        },
      },
      {
        uuid: "u2",
        type: "user",
        role: "user",
        promptId: "p2",
        permissionMode: "default",
        parentUuid: "a1",
        timestamp: "2026-04-18T10:00:03.000Z",
        message: { role: "user", content: "Second prompt" },
      },
      {
        uuid: "a2",
        type: "assistant",
        role: "assistant",
        parentUuid: "u2",
        timestamp: "2026-04-18T10:00:04.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Second answer" }],
        },
      },
    ]);
    directories.push(transcript.directory);

    expect(detectRolledBackPromptIds(transcript.path).size).toBe(0);
  });

  test("single parent with two user children: non-main-chain promptId enters set", () => {
    const transcript = writeTranscript([
      {
        uuid: "root",
        type: "system",
        timestamp: "2026-04-18T10:00:00.000Z",
      },
      {
        uuid: "u1",
        type: "user",
        role: "user",
        promptId: "p1",
        permissionMode: "default",
        parentUuid: "root",
        timestamp: "2026-04-18T10:00:01.000Z",
        message: { role: "user", content: "Original prompt" },
      },
      {
        uuid: "a1",
        type: "assistant",
        role: "assistant",
        parentUuid: "u1",
        timestamp: "2026-04-18T10:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Original answer" }],
        },
      },
      {
        uuid: "u2-dead",
        type: "user",
        role: "user",
        promptId: "p2",
        permissionMode: "default",
        parentUuid: "a1",
        timestamp: "2026-04-18T10:00:03.000Z",
        message: { role: "user", content: "Rolled-back prompt" },
      },
      {
        uuid: "u2-live",
        type: "user",
        role: "user",
        promptId: "p3",
        permissionMode: "default",
        parentUuid: "a1",
        timestamp: "2026-04-18T10:00:04.000Z",
        message: { role: "user", content: "Replacement prompt" },
      },
      {
        uuid: "a2",
        type: "assistant",
        role: "assistant",
        parentUuid: "u2-live",
        timestamp: "2026-04-18T10:00:05.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Replacement answer" }],
        },
      },
    ]);
    directories.push(transcript.directory);

    const result = detectRollbackTopology(transcript.path);
    expect(
      detectRollbackTopologyFromEntries(
        readAllTranscriptEntries(transcript.path),
      ),
    ).toEqual(result);
    expect(result.rolledBackPromptIds).toEqual(new Set(["p2"]));
    expect(result.replacementByPromptId.get("p2")).toBe("p3");
  });

  test("same parent with 3 user children (two consecutive rollbacks): both dead promptIds in set", () => {
    const transcript = writeTranscript([
      {
        uuid: "root",
        type: "system",
        timestamp: "2026-04-18T10:00:00.000Z",
      },
      {
        uuid: "u1",
        type: "user",
        role: "user",
        promptId: "p1",
        permissionMode: "default",
        parentUuid: "root",
        timestamp: "2026-04-18T10:00:01.000Z",
        message: { role: "user", content: "First attempt" },
      },
      {
        uuid: "u2",
        type: "user",
        role: "user",
        promptId: "p2",
        permissionMode: "default",
        parentUuid: "root",
        timestamp: "2026-04-18T10:00:02.000Z",
        message: { role: "user", content: "Second attempt" },
      },
      {
        uuid: "u3",
        type: "user",
        role: "user",
        promptId: "p3",
        permissionMode: "default",
        parentUuid: "root",
        timestamp: "2026-04-18T10:00:03.000Z",
        message: { role: "user", content: "Final attempt" },
      },
      {
        uuid: "a3",
        type: "assistant",
        role: "assistant",
        parentUuid: "u3",
        timestamp: "2026-04-18T10:00:04.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Final answer" }],
        },
      },
    ]);
    directories.push(transcript.directory);

    const result = detectRollbackTopology(transcript.path);
    expect(result.rolledBackPromptIds).toEqual(new Set(["p1", "p2"]));
    expect(result.replacementByPromptId.get("p1")).toBe("p3");
    expect(result.replacementByPromptId.get("p2")).toBe("p3");
  });

  test("tool_use/tool_result sharing parent do not cause false rollback", () => {
    const transcript = writeTranscript([
      {
        uuid: "root",
        type: "system",
        timestamp: "2026-04-18T10:00:00.000Z",
      },
      {
        uuid: "u1",
        type: "user",
        role: "user",
        promptId: "p1",
        permissionMode: "default",
        parentUuid: "root",
        timestamp: "2026-04-18T10:00:01.000Z",
        message: { role: "user", content: "Prompt" },
      },
      {
        uuid: "a1",
        type: "assistant",
        role: "assistant",
        parentUuid: "u1",
        timestamp: "2026-04-18T10:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "Read", input: {} }],
        },
      },
      {
        uuid: "tr1",
        type: "user",
        role: "user",
        promptId: "p1",
        parentUuid: "a1",
        timestamp: "2026-04-18T10:00:03.000Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", content: "file contents" }],
        },
      },
      {
        uuid: "a2",
        type: "assistant",
        role: "assistant",
        parentUuid: "tr1",
        timestamp: "2026-04-18T10:00:04.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Done" }],
        },
      },
    ]);
    directories.push(transcript.directory);

    expect(detectRolledBackPromptIds(transcript.path).size).toBe(0);
  });

  test("resume snapshot duplicate uuids are deduped and do not cause false rollback", () => {
    const transcript = writeTranscript([
      {
        uuid: "root",
        type: "system",
        timestamp: "2026-04-18T10:00:00.000Z",
      },
      {
        uuid: "u1",
        type: "user",
        role: "user",
        promptId: "p1",
        permissionMode: "default",
        parentUuid: "root",
        timestamp: "2026-04-18T10:00:01.000Z",
        message: { role: "user", content: "Prompt" },
      },
      {
        uuid: "a1",
        type: "assistant",
        role: "assistant",
        parentUuid: "u1",
        timestamp: "2026-04-18T10:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Answer" }],
        },
      },
      // Resume snapshot repeats the same entries
      {
        uuid: "root",
        type: "system",
        timestamp: "2026-04-18T10:00:00.000Z",
      },
      {
        uuid: "u1",
        type: "user",
        role: "user",
        promptId: "p1",
        permissionMode: "default",
        parentUuid: "root",
        timestamp: "2026-04-18T10:00:01.000Z",
        message: { role: "user", content: "Prompt" },
      },
      {
        uuid: "a1",
        type: "assistant",
        role: "assistant",
        parentUuid: "u1",
        timestamp: "2026-04-18T10:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Answer" }],
        },
      },
      {
        uuid: "u2",
        type: "user",
        role: "user",
        promptId: "p2",
        permissionMode: "default",
        parentUuid: "a1",
        timestamp: "2026-04-18T10:00:03.000Z",
        message: { role: "user", content: "Second prompt" },
      },
    ]);
    directories.push(transcript.directory);

    expect(detectRolledBackPromptIds(transcript.path).size).toBe(0);
  });

  test("trailing attachment/system leaf: main chain walk covers them correctly", () => {
    const transcript = writeTranscript([
      {
        uuid: "root",
        type: "system",
        timestamp: "2026-04-18T10:00:00.000Z",
      },
      {
        uuid: "u1-dead",
        type: "user",
        role: "user",
        promptId: "p1",
        permissionMode: "default",
        parentUuid: "root",
        timestamp: "2026-04-18T10:00:01.000Z",
        message: { role: "user", content: "Dead branch" },
      },
      {
        uuid: "u1-live",
        type: "user",
        role: "user",
        promptId: "p2",
        permissionMode: "default",
        parentUuid: "root",
        timestamp: "2026-04-18T10:00:02.000Z",
        message: { role: "user", content: "Live branch" },
      },
      {
        uuid: "a1",
        type: "assistant",
        role: "assistant",
        parentUuid: "u1-live",
        timestamp: "2026-04-18T10:00:03.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Answer" }],
        },
      },
      // Trailing system leaf (stop_hook_summary)
      {
        uuid: "sys1",
        type: "system",
        parentUuid: "a1",
        timestamp: "2026-04-18T10:00:04.000Z",
      },
    ]);
    directories.push(transcript.directory);

    const result = detectRollbackTopology(transcript.path);
    expect(result.rolledBackPromptIds).toEqual(new Set(["p1"]));
  });

  test("trailing progress-only leaf is excluded: tip falls back to non-progress leaf", () => {
    // progress leaf on the dead branch has the latest timestamp, but is excluded
    // from tip selection. The live branch's leaf (a1-live) becomes the tip instead.
    const transcript = writeTranscript([
      {
        uuid: "root",
        type: "system",
        timestamp: "2026-04-18T10:00:00.000Z",
      },
      {
        uuid: "u1-dead",
        type: "user",
        role: "user",
        promptId: "p1",
        permissionMode: "default",
        parentUuid: "root",
        timestamp: "2026-04-18T10:00:01.000Z",
        message: { role: "user", content: "Dead branch" },
      },
      {
        uuid: "a1-dead",
        type: "assistant",
        role: "assistant",
        parentUuid: "u1-dead",
        timestamp: "2026-04-18T10:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Dead answer" }],
        },
      },
      {
        uuid: "prog1",
        type: "progress",
        parentUuid: "a1-dead",
        timestamp: "2026-04-18T10:00:06.000Z",
      },
      {
        uuid: "u1-live",
        type: "user",
        role: "user",
        promptId: "p2",
        permissionMode: "default",
        parentUuid: "root",
        timestamp: "2026-04-18T10:00:03.000Z",
        message: { role: "user", content: "Live branch" },
      },
      {
        uuid: "a1-live",
        type: "assistant",
        role: "assistant",
        parentUuid: "u1-live",
        timestamp: "2026-04-18T10:00:05.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Live answer" }],
        },
      },
    ]);
    directories.push(transcript.directory);

    const result = detectRollbackTopology(transcript.path);
    expect(result.rolledBackPromptIds).toEqual(new Set(["p1"]));
  });

  test("trailing isSidechain=true leaf is skipped: main chain found correctly", () => {
    // sidechain leaf on the dead branch has the latest timestamp, but is excluded.
    // The live branch's leaf (a1-live) becomes the tip instead.
    const transcript = writeTranscript([
      {
        uuid: "root",
        type: "system",
        timestamp: "2026-04-18T10:00:00.000Z",
      },
      {
        uuid: "u1-dead",
        type: "user",
        role: "user",
        promptId: "p1",
        permissionMode: "default",
        parentUuid: "root",
        timestamp: "2026-04-18T10:00:01.000Z",
        message: { role: "user", content: "Dead branch" },
      },
      {
        uuid: "a1-dead",
        type: "assistant",
        role: "assistant",
        parentUuid: "u1-dead",
        timestamp: "2026-04-18T10:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Dead answer" }],
        },
      },
      {
        uuid: "side1",
        type: "user",
        role: "user",
        isSidechain: true,
        parentUuid: "a1-dead",
        timestamp: "2026-04-18T10:00:06.000Z",
        message: { role: "user", content: "Subagent prompt" },
      },
      {
        uuid: "u1-live",
        type: "user",
        role: "user",
        promptId: "p2",
        permissionMode: "default",
        parentUuid: "root",
        timestamp: "2026-04-18T10:00:03.000Z",
        message: { role: "user", content: "Live branch" },
      },
      {
        uuid: "a1-live",
        type: "assistant",
        role: "assistant",
        parentUuid: "u1-live",
        timestamp: "2026-04-18T10:00:05.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Live answer" }],
        },
      },
    ]);
    directories.push(transcript.directory);

    const result = detectRollbackTopology(transcript.path);
    expect(result.rolledBackPromptIds).toEqual(new Set(["p1"]));
  });

  test("multiple non-sidechain leaves: tip is the one with latest timestamp", () => {
    const transcript = writeTranscript([
      {
        uuid: "root",
        type: "system",
        timestamp: "2026-04-18T10:00:00.000Z",
      },
      {
        uuid: "u1",
        type: "user",
        role: "user",
        promptId: "p1",
        permissionMode: "default",
        parentUuid: "root",
        timestamp: "2026-04-18T10:00:01.000Z",
        message: { role: "user", content: "Branch A" },
      },
      {
        uuid: "a1",
        type: "assistant",
        role: "assistant",
        parentUuid: "u1",
        timestamp: "2026-04-18T10:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Answer A" }],
        },
      },
      {
        uuid: "u2",
        type: "user",
        role: "user",
        promptId: "p2",
        permissionMode: "default",
        parentUuid: "root",
        timestamp: "2026-04-18T10:00:03.000Z",
        message: { role: "user", content: "Branch B" },
      },
      {
        uuid: "a2",
        type: "assistant",
        role: "assistant",
        parentUuid: "u2",
        timestamp: "2026-04-18T10:00:04.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Answer B" }],
        },
      },
    ]);
    directories.push(transcript.directory);

    // a2 has the later timestamp → p2 is main chain → p1 is rolled back
    const result = detectRollbackTopology(transcript.path);
    expect(result.rolledBackPromptIds).toEqual(new Set(["p1"]));
    expect(result.replacementByPromptId.get("p1")).toBe("p2");
  });
});
