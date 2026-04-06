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

  test("uses an approximately 80 character prompt preview", () => {
    const longPrompt =
      "This is a very long prompt preview that should stay readable for matching and remain close to eighty characters total";
    const summary = buildExtractionStatusSummary([
      {
        promptNumber: 1,
        status: "pending",
        promptPreview: longPrompt,
      },
    ]);

    expect(summary).toContain(
      '#1 [pending]: "This is a very long prompt preview that should stay readable for matching and...',
    );
  });
});
