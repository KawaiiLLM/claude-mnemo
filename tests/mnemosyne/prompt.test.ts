import { describe, expect, test } from "bun:test";

import {
  buildExtractionStatusSummary,
  buildMnemosynePrompt,
} from "../../src/mnemosyne/prompt";

describe("buildMnemosynePrompt", () => {
  test("documents stale re-evaluation and explicit undone handling", () => {
    const summary = buildExtractionStatusSummary([
      {
        promptNumber: 1,
        status: "stale",
        promptPreview: "Redo the branch",
      },
      {
        promptNumber: 2,
        status: "undone",
        promptPreview: "Old branch",
      },
    ]);

    const prompt = buildMnemosynePrompt(summary);

    expect(prompt).toContain('call save_turn with status="undone"');
    expect(prompt).toContain(
      "Do NOT re-process [extracted], [skipped], or [undone] turns",
    );
    expect(prompt).toContain('#2 [undone]: "Old branch"');
  });
});
